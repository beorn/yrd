import { createScope, type Scope } from "@silvery/scope"
import { createLogger, type ConditionalLogger } from "loggily"

export type ProcessRequest = Readonly<{
  argv: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string | Uint8Array
  timeoutMs?: number
  signal?: AbortSignal
}>

export type ProcessResult = Readonly<{
  exitCode: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}>

export type Process = Readonly<{
  run(request: ProcessRequest): Promise<ProcessResult>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}>

type SpawnOptions = Readonly<{
  cwd: string
  env: Record<string, string>
  stdin: "ignore" | Blob
  stdout: "pipe"
  stderr: "pipe"
  signal: AbortSignal
}>

type Spawned = Readonly<{
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
  const cwd = options.cwd ?? process.cwd()
  const env = definedEnv(options.env ?? process.env)
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 16 * 1024 * 1024, "maxOutputBytes")
  const killGraceMs = positiveInteger(options.killGraceMs ?? 5_000, "killGraceMs")

  const close = () => scope.disposeAsync()
  return {
    async run(request) {
      if (scope.disposed) throw new Error("yrd: Process is closed")
      if (request.argv.length === 0 || request.argv.some((value) => value.length === 0)) {
        throw new TypeError("yrd: Process argv must contain non-empty strings")
      }
      if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)) {
        throw new RangeError("yrd: Process timeoutMs must be a positive integer")
      }

      const runScope = scope.child(request.argv[0])
      const signal = request.signal === undefined ? runScope.signal : AbortSignal.any([runScope.signal, request.signal])
      const started = now()
      let timedOut = false
      let cancelTimeout: (() => void) | undefined
      let cancelKill: (() => void) | undefined
      using _span = log.span?.("run", { argv: request.argv, cwd: request.cwd ?? cwd })
      try {
        const child = spawn(request.argv, {
          cwd: request.cwd ?? cwd,
          env: request.env === undefined ? env : definedEnv(request.env),
          stdin: request.stdin === undefined ? "ignore" : inputBlob(request.stdin),
          stdout: "pipe",
          stderr: "pipe",
          signal,
        })
        let terminating = false
        const terminate = (): void => {
          if (terminating) return
          terminating = true
          child.kill("SIGTERM")
          cancelKill = runScope.timeout(() => child.kill("SIGKILL"), killGraceMs)
        }
        const onAbort = () => terminate()
        signal.addEventListener("abort", onAbort, { once: true })
        let outputError: unknown
        const capture = async (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr"): Promise<string> => {
          try {
            return await readBounded(stream, maxOutputBytes, name)
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
        cancelKill?.()
        if (outputError !== undefined) throw outputError
        const result: ProcessResult = {
          exitCode,
          signal: child.signalCode,
          stdout,
          stderr,
          durationMs: Math.max(0, now() - started),
          timedOut,
        }
        log.debug?.("process exited", {
          argv: request.argv,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          timedOut,
        })
        return result
      } finally {
        cancelTimeout?.()
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
    }
  } finally {
    reader.releaseLock()
  }
}

function spawnProcess(argv: readonly string[], options: SpawnOptions): Spawned {
  return Bun.spawn([...argv], options)
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

function inputBlob(input: string | Uint8Array): Blob {
  if (typeof input === "string") return new Blob([input])
  const copy = new Uint8Array(input.byteLength)
  copy.set(input)
  return new Blob([copy.buffer])
}
