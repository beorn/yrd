import { createScope, type Scope } from "@silvery/scope"
import { createLogger, type ConditionalLogger } from "loggily"

export type ProcessRequest = Readonly<{
  argv: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string | Uint8Array
  onOutput?: (output: Readonly<{ stream: "stdout" | "stderr"; chunk: Uint8Array }>) => void
  timeoutMs?: number
  /** Explicit output-silence lease. Only set this when the command contract
   * guarantees observable output more frequently than the bound. */
  noProgressTimeoutMs?: number
  signal?: AbortSignal
}>

type ProcessResultBase = Readonly<{
  exitCode: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  lastProgressAtMs?: number
  lastProgressBytes?: number
  /**
   * Set when a settlement signal could not reach the process GROUP (non-ESRCH
   * kill failure) — descendants may survive; loud, never swallowed (21012 S1).
   */
  sweepFailure?: string
}>

export type ProcessResult = ProcessResultBase &
  (
    | Readonly<{ verdict?: "EXITED"; stalled?: false; timedOut: false }>
    | Readonly<{ verdict?: "TIMED_OUT"; stalled?: false; timedOut: true }>
    | Readonly<{
        verdict: "STALLED"
        stalled: true
        timedOut: false
        lastProgressAtMs: number
        lastProgressBytes: number
      }>
  )

export type Process = Readonly<{
  run(request: ProcessRequest): Promise<ProcessResult>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}>

/** Explicitly opts one process invocation into shell parsing. */
export function shellCommand(script: string): readonly ["sh", "-c", string] {
  if (typeof script !== "string" || script.trim() === "") {
    throw new TypeError("yrd: shell command must be a non-empty string")
  }
  return Object.freeze(["sh", "-c", script])
}

type SpawnOptions = Readonly<{
  cwd: string
  env: Record<string, string>
  stdin: "ignore" | Blob
  stdout: "pipe"
  stderr: "pipe"
  signal: AbortSignal
}>

type Spawned = Readonly<{
  /** Child pid — the process-GROUP id when the spawn established leadership. */
  pid: number
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  signalCode: NodeJS.Signals | null
  kill(signal?: number | NodeJS.Signals): void
}>

export type Spawn = (argv: readonly string[], options: SpawnOptions) => Spawned

export function createProcess(
  options: Readonly<{
    cwd?: string
    env?: NodeJS.ProcessEnv
    maxOutputBytes?: number
    killGraceMs?: number
    inject?: Readonly<{
      scope?: Scope
      log?: ConditionalLogger
      now?: () => number
      spawn?: Spawn
    }>
  }> = {},
): Process {
  const scope = options.inject?.scope?.child("process") ?? createScope("process")
  const log = options.inject?.log?.child("process") ?? createLogger("yrd:process")
  const now = options.inject?.now ?? performance.now.bind(performance)
  const spawn = options.inject?.spawn ?? spawnProcess
  // Group settlement is the DEFAULT spawn's contract (it establishes group
  // leadership via detached:true). An INJECTED spawn (test seam) gets the
  // direct-child kill contract only — signalling a real OS group at a fake
  // pid would strafe unrelated processes.
  const groupSettlement = options.inject?.spawn === undefined
  const cwd = options.cwd ?? process.cwd()
  const env = definedEnv(options.env ?? process.env)
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 16 * 1024 * 1024, "maxOutputBytes")
  const killGraceMs = positiveInteger(options.killGraceMs ?? 5_000, "killGraceMs")

  const close = () => scope.disposeAsync()
  return {
    async run(request) {
      if (scope.disposed) throw new Error("yrd: Process is closed")
      const argv = validateArgv(request.argv)
      if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)) {
        throw new RangeError("yrd: Process timeoutMs must be a positive integer")
      }
      if (
        request.noProgressTimeoutMs !== undefined &&
        (!Number.isSafeInteger(request.noProgressTimeoutMs) || request.noProgressTimeoutMs < 1)
      ) {
        throw new RangeError("yrd: Process noProgressTimeoutMs must be a positive integer")
      }

      const runScope = scope.child(argv[0])
      const signal = request.signal === undefined ? runScope.signal : AbortSignal.any([runScope.signal, request.signal])
      const started = now()
      let timedOut = false
      let stalled = false
      let lastProgressAtMs = started
      let lastProgressBytes = 0
      let cancelTimeout: (() => void) | undefined
      let cancelProgressLease: (() => void) | undefined
      let cancelKill: (() => void) | undefined
      using _span = log.span?.("run", { argv, cwd: request.cwd ?? cwd })
      try {
        const child = spawn(argv, {
          cwd: request.cwd ?? cwd,
          env: request.env === undefined ? env : definedEnv(request.env),
          stdin: request.stdin === undefined ? "ignore" : inputBlob(request.stdin),
          stdout: "pipe",
          stderr: "pipe",
          signal,
        })
        let terminating = false
        let sweepFailure: string | undefined
        // 21012 S1 — settlement owns the FULL process tree. The default spawn
        // makes the child a process-group LEADER (Bun.spawn detached:true —
        // bun's NATIVE spawn honors it; the node:child_process shim does NOT,
        // probed 2026-07-10/11), so signalling -pid reaches every descendant,
        // including a fork worker holding our stdout pipe open (without this,
        // run() hangs PAST its own timeout awaiting a pipe only SIGKILL can
        // free). If leadership is absent (custom injected spawn), -pid names a
        // nonexistent group — the child pid is fresh, never OUR pgid — so the
        // signal degrades to ESRCH and we fall back to the direct child.
        // Self-daemonized (setsid) descendants escape any group signal: the
        // documented residual lifecycle class, owned by supervision, not here.
        const signalTree = (sig: "SIGTERM" | "SIGKILL"): void => {
          let groupReached = false
          if (groupSettlement) {
            try {
              process.kill(-child.pid, sig)
              groupReached = true
            } catch (error) {
              const code = (error as { code?: string }).code
              // ESRCH: group already fully exited or no leadership — fall back.
              if (code !== "ESRCH") {
                sweepFailure ??= `process-group ${sig} failed (${code ?? String(error)}) — descendants may survive pgid ${child.pid}; inspect and kill manually`
              }
            }
          }
          if (!groupReached) {
            try {
              child.kill(sig)
            } catch (error) {
              const code = (error as { code?: string }).code
              if (code !== "ESRCH") sweepFailure ??= `direct-child ${sig} failed (${code ?? String(error)})`
            }
          }
        }
        const terminate = (): void => {
          if (terminating) return
          terminating = true
          signalTree("SIGTERM")
          cancelKill = runScope.timeout(() => signalTree("SIGKILL"), killGraceMs)
        }
        const onAbort = () => terminate()
        signal.addEventListener("abort", onAbort, { once: true })
        const renewProgressLease = (bytes = 0): void => {
          lastProgressAtMs = now()
          lastProgressBytes += bytes
          cancelProgressLease?.()
          if (request.noProgressTimeoutMs !== undefined) {
            cancelProgressLease = runScope.timeout(() => {
              stalled = true
              terminate()
            }, request.noProgressTimeoutMs)
          }
        }
        renewProgressLease()
        let outputError: unknown
        const capture = async (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr"): Promise<string> => {
          try {
            return await readBounded(stream, maxOutputBytes, name, renewProgressLease, request.onOutput)
          } catch (error) {
            outputError ??= error
            terminate()
            return ""
          }
        }
        if (request.timeoutMs !== undefined) {
          cancelTimeout = runScope.timeout(() => {
            timedOut = true
            terminate()
          }, request.timeoutMs)
        }
        const [stdout, stderr, exitCode] = await Promise.all([
          capture(child.stdout, "stdout"),
          capture(child.stderr, "stderr"),
          child.exited,
        ])
        signal.removeEventListener("abort", onAbort)
        cancelProgressLease?.()
        cancelKill?.()
        if (outputError !== undefined) throw outputError
        const result: ProcessResult = {
          exitCode,
          signal: child.signalCode,
          stdout,
          stderr,
          durationMs: Math.max(0, now() - started),
          timedOut,
          stalled,
          verdict: stalled ? "STALLED" : timedOut ? "TIMED_OUT" : "EXITED",
          lastProgressAtMs,
          lastProgressBytes,
          ...(sweepFailure === undefined ? {} : { sweepFailure }),
        } as ProcessResult
        log.debug?.("process exited", {
          argv,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          timedOut,
        })
        return result
      } finally {
        cancelTimeout?.()
        cancelProgressLease?.()
        cancelKill?.()
        await runScope.disposeAsync()
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  name: "stdout" | "stderr",
  onProgress: (bytes: number) => void = () => {},
  onOutput: (output: Readonly<{ stream: "stdout" | "stderr"; chunk: Uint8Array }>) => void = () => {},
): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return new TextDecoder().decode(Buffer.concat(chunks, size))
      if (size + value.byteLength > limit) {
        await reader.cancel()
        throw new RangeError(`yrd: Process ${name} exceeded ${limit} bytes`)
      }
      chunks.push(value)
      size += value.byteLength
      onProgress(value.byteLength)
      onOutput({ stream: name, chunk: value })
    }
  } finally {
    reader.releaseLock()
  }
}

function spawnProcess(argv: readonly string[], options: SpawnOptions): Spawned {
  // detached:true = the child becomes its own process-GROUP leader, which is
  // what lets settlement signal the whole tree via -pid. Bun's NATIVE spawn
  // honors this (probed + pinned by the bun-canary test); the node:child_process
  // compat shim ignores it — do not port this file to node:child_process.
  return Bun.spawn([...argv], { ...options, detached: true })
}

function definedEnv(input: NodeJS.ProcessEnv | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`yrd: Process ${name} must be a positive integer`)
  return value
}

function validateArgv(value: unknown): readonly [string, ...string[]] {
  if (!Array.isArray(value)) throw new TypeError("yrd: Process argv must contain non-empty strings")
  const input = value as readonly unknown[]
  const argv: string[] = []
  for (const arg of input) {
    if (typeof arg !== "string" || arg.length === 0) {
      throw new TypeError("yrd: Process argv must contain non-empty strings")
    }
    argv.push(arg)
  }
  if (argv.length === 0) throw new TypeError("yrd: Process argv must contain non-empty strings")
  return Object.freeze(argv) as readonly [string, ...string[]]
}

function inputBlob(input: string | Uint8Array): globalThis.Blob {
  if (typeof input === "string") return new globalThis.Blob([input])
  const copy = new Uint8Array(input.byteLength)
  copy.set(input)
  return new globalThis.Blob([copy.buffer])
}
