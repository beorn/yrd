import { createScope, type Scope } from "@silvery/scope"
import { createLogger, type ConditionalLogger } from "loggily"

export type ProcessRequest = Readonly<{
  argv: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string | Uint8Array
  onOutput?: (output: Readonly<{ stream: "stdout" | "stderr"; chunk: Uint8Array }>) => void
  timeoutMs?: number
  /** Explicit inter-output silence lease. It starts with the first observed
   * byte, so queue or scheduler startup latency is not child-stall evidence. */
  noProgressTimeoutMs?: number
  /** Bounded wait for the stdout/stderr pipe to reach EOF AFTER the direct
   * child has EXITED. A descendant that escaped the process-group sweep (a
   * setsid session leader the `-pid` signal cannot reach) can hold the pipe
   * open past the child's death; awaiting that EOF is the queue wedge (run()
   * never returns). Past this grace run() abandons the drain LOUDLY instead of
   * hanging on a pipe only SIGKILL can free. Default:
   * {@link DEFAULT_POST_EXIT_DRAIN_GRACE_MS}. */
  postExitDrainGraceMs?: number
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
   * Also set when the direct child never reaped after SIGKILL (a D-state or
   * fully escaped tree) so run() had to stop awaiting its exit.
   */
  sweepFailure?: string
  /**
   * Set when the direct child EXITED yet a surviving descendant held the
   * stdout/stderr pipe open past {@link ProcessRequest.postExitDrainGraceMs},
   * so run() abandoned the drain rather than wedge on an EOF only SIGKILL can
   * free. Loud, never swallowed — the queue surfaces it distinctly (the
   * `<step>-stalled-escaped-descendant` blocker) from a plain output stall.
   */
  escapedDescendant?: boolean
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
  /** Aborts and awaits every active run, including process-group settlement. */
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

/**
 * Default bounded wait for the output pipe to reach EOF after the DIRECT child
 * exits. A child's own buffered bytes are already in the pipe and read in a
 * tight loop the moment it exits, so the ONLY thing that keeps a stream open
 * past child exit is a SURVIVING DESCENDANT — the documented setsid-escapee
 * residual class the `-pid` group sweep cannot reach. Awaiting that pipe
 * unboundedly is the live queue wedge (50–56min hangs, 2026-07-15/16): run()
 * binds its completion to the PID exit and abandons a still-open pipe after
 * this grace. Generous enough that OS scheduling jitter never clips a real
 * child's trailing bytes; tiny beside the wall-clock bound it backstops.
 */
export const DEFAULT_POST_EXIT_DRAIN_GRACE_MS = 2_000

/**
 * Default bound on how long run() awaits the DIRECT child's reap AFTER it has
 * been SIGKILLed. The other way run() can wedge is `child.exited` never
 * resolving — a child stuck in uninterruptible sleep (D-state) or a tree that
 * fully escaped the signal. Generous by design: a real child reaps in
 * microseconds after SIGKILL, so this only fires on a genuinely stuck one, at
 * which point run() returns with a LOUD sweepFailure instead of hanging on a
 * PID exit that is never coming. Deliberately decoupled from `killGraceMs` (the
 * SIGTERM→SIGKILL escalation grace) so a tiny escalation grace cannot make the
 * reap backstop fire on ordinary reap latency.
 */
export const DEFAULT_POST_KILL_REAP_GRACE_MS = 10_000

export function createProcess(
  options: Readonly<{
    cwd?: string
    env?: NodeJS.ProcessEnv
    maxOutputBytes?: number
    killGraceMs?: number
    postExitDrainGraceMs?: number
    postKillReapGraceMs?: number
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
  const defaultPostExitDrainGraceMs = positiveInteger(
    options.postExitDrainGraceMs ?? DEFAULT_POST_EXIT_DRAIN_GRACE_MS,
    "postExitDrainGraceMs",
  )
  const postKillReapGraceMs = positiveInteger(
    options.postKillReapGraceMs ?? DEFAULT_POST_KILL_REAP_GRACE_MS,
    "postKillReapGraceMs",
  )
  const closingSignal = new AbortController()
  const active = new Set<Promise<void>>()
  let closing = false
  let closePromise: Promise<void> | undefined

  scope.use({
    async [Symbol.asyncDispose]() {
      closing = true
      closingSignal.abort()
      await Promise.allSettled(active)
    },
  })
  const close = () => {
    closing = true
    return (closePromise ??= scope[Symbol.asyncDispose]())
  }
  return {
    async run(request) {
      if (closing || scope.disposed) throw new Error("yrd: Process is closed")
      const settled = Promise.withResolvers<void>()
      active.add(settled.promise)
      using _activeRun = {
        [Symbol.dispose]() {
          active.delete(settled.promise)
          settled.resolve()
        },
      }
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
      if (
        request.postExitDrainGraceMs !== undefined &&
        (!Number.isSafeInteger(request.postExitDrainGraceMs) || request.postExitDrainGraceMs < 1)
      ) {
        throw new RangeError("yrd: Process postExitDrainGraceMs must be a positive integer")
      }
      const postExitDrainGraceMs = request.postExitDrainGraceMs ?? defaultPostExitDrainGraceMs

      // Keep the run scope independent: parent Scope disposal is child-first,
      // which would cancel this run's SIGKILL grace before close can drain it.
      const runScope = createScope(argv[0])
      const signal = AbortSignal.any([
        runScope.signal,
        closingSignal.signal,
        ...(request.signal === undefined ? [] : [request.signal]),
      ])
      const started = now()
      let timedOut = false
      let stalled = false
      let lastProgressAtMs = started
      let lastProgressBytes = 0
      let cancelTimeout: (() => void) | undefined
      let cancelProgressLease: (() => void) | undefined
      let cancelKill: (() => void) | undefined
      let cancelReap: (() => void) | undefined
      let cancelDrainGrace: (() => void) | undefined
      using span = log.span?.("run", { argv, cwd: request.cwd ?? cwd })
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
        // Belt-and-suspenders backstop: `child.exited` never resolving is the
        // OTHER way run() can wedge — a direct child stuck in uninterruptible
        // sleep (D-state) or a tree that fully escaped SIGKILL. Once we have
        // decided to kill it, bound how long we await its reap: after SIGKILL,
        // one more grace, then stop awaiting the PID exit so run() returns with
        // a LOUD sweepFailure instead of hanging on a child that never settles.
        const forcedExit = Promise.withResolvers<number>()
        let childSettled = false
        const terminate = (): void => {
          if (terminating) return
          terminating = true
          signalTree("SIGTERM")
          cancelKill = runScope.timeout(() => {
            signalTree("SIGKILL")
            cancelReap = runScope.timeout(() => {
              if (childSettled) return
              sweepFailure ??= `direct child did not exit within ${postKillReapGraceMs}ms after SIGKILL — may survive pid ${child.pid}; inspect and kill manually`
              forcedExit.resolve(-1)
            }, postKillReapGraceMs)
          }, killGraceMs)
        }
        const onAbort = () => terminate()
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) terminate()
        const renewProgressLease = (bytes: number): void => {
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
        let outputError: unknown
        // A stream drain we can abandon: aborted when a descendant holds the
        // pipe open past the child's exit so the bounded reads stop waiting for
        // an EOF that is never coming, returning the bytes captured so far.
        const drainAbort = new AbortController()
        const capture = async (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr"): Promise<string> => {
          try {
            return await readBounded(
              stream,
              maxOutputBytes,
              name,
              renewProgressLease,
              request.onOutput,
              drainAbort.signal,
            )
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
        const capturesDone = Promise.all([capture(child.stdout, "stdout"), capture(child.stderr, "stderr")])

        // Bind run()'s completion to the DIRECT child's PID exit — NOT to stream
        // close. A descendant that escaped the group sweep can hold the pipe
        // open indefinitely past the child's death; awaiting that EOF inside
        // Promise.all is the wedge. The reap backstop guarantees this settles.
        const exitCode = await Promise.race([
          child.exited.then((code) => {
            childSettled = true
            return code
          }),
          forcedExit.promise,
        ])

        // The command has settled (real exit, or forced after an unkillable
        // child). Bound any residual pipe drain: a still-open stream now means a
        // surviving descendant, so wait a bounded grace for a clean EOF, then
        // abandon the read LOUDLY rather than hang.
        let escapedDescendant = false
        if (childSettled) {
          const drainedCleanly = await new Promise<boolean>((resolve) => {
            cancelDrainGrace = runScope.timeout(() => resolve(false), postExitDrainGraceMs)
            void capturesDone.then(
              () => resolve(true),
              () => resolve(true),
            )
          })
          cancelDrainGrace?.()
          if (!drainedCleanly) {
            escapedDescendant = true
            stalled = true
            log.warn?.("descendant held the output pipe open past child exit — abandoning drain", {
              argv,
              pid: child.pid,
              postExitDrainGraceMs,
            })
            // The child is already dead; SIGKILL the leaked in-group descendants
            // now (best-effort — a setsid escapee survives, which is why we also
            // release our own read end below so run() returns regardless).
            signalTree("SIGKILL")
            drainAbort.abort()
          }
        } else {
          // Forced settle: the child never reaped (sweepFailure already loud);
          // the pipe is held by the live tree, so release our read end.
          log.warn?.("abandoning output drain — direct child never settled after SIGKILL", { argv, pid: child.pid })
          drainAbort.abort()
        }
        const [stdout, stderr] = await capturesDone
        signal.removeEventListener("abort", onAbort)
        cancelProgressLease?.()
        cancelDrainGrace?.()
        cancelKill?.()
        cancelReap?.()
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
          ...(escapedDescendant ? { escapedDescendant: true } : {}),
        } as ProcessResult
        log.debug?.("process exited", {
          argv,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          timedOut,
        })
        if (span !== undefined) {
          Object.assign(span.spanData, {
            // A non-zero exit is command evidence for the caller to classify
            // (many Git probes intentionally use it); only abnormal process
            // settlement is a process-lifecycle failure.
            outcome: result.signal === null && !result.timedOut && !result.stalled ? "succeeded" : "failed",
            durationMs: result.durationMs,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            stalled: result.stalled,
          })
        }
        return result
      } catch (error) {
        if (span !== undefined) {
          Object.assign(span.spanData, {
            outcome: "failed",
            error: error instanceof Error ? error.message : String(error),
            durationMs: Math.max(0, now() - started),
          })
        }
        throw error
      } finally {
        cancelTimeout?.()
        cancelProgressLease?.()
        cancelDrainGrace?.()
        cancelKill?.()
        cancelReap?.()
        await runScope[Symbol.asyncDispose]()
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}

const ABANDONED = Symbol("drain-abandoned")

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  name: "stdout" | "stderr",
  onProgress: (bytes: number) => void = () => {},
  onOutput: (output: Readonly<{ stream: "stdout" | "stderr"; chunk: Uint8Array }>) => void = () => {},
  abandon?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  // When the caller abandons the drain (a descendant is holding this pipe open
  // past the child's exit), race each read against the abort so the loop stops
  // waiting on an EOF that is never coming; cancel() releases our read end and
  // resolves the pending read, keeping releaseLock() safe.
  const abandoned: Promise<typeof ABANDONED> | undefined =
    abandon === undefined
      ? undefined
      : new Promise((resolve) => {
          if (abandon.aborted) return resolve(ABANDONED)
          abandon.addEventListener("abort", () => resolve(ABANDONED), { once: true })
        })
  try {
    while (true) {
      const next = reader.read()
      const outcome = abandoned === undefined ? await next : await Promise.race([next, abandoned])
      if (outcome === ABANDONED) {
        await reader.cancel().catch(() => {})
        return new TextDecoder().decode(Buffer.concat(chunks, size))
      }
      const { done, value } = outcome
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
