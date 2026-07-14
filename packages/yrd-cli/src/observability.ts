import { failureFact, raiseFailure } from "@yrd/core"
import { createLogger, type ConditionalLogger, type ConfigElement, type LogLevel } from "loggily"

export const YRD_LIFECYCLE_LEVELS = Object.freeze({
  started: "debug",
  progress: "trace",
  succeeded: "info",
  refused: "warn",
  recovered: "warn",
  failed: "error",
} as const satisfies Record<string, Exclude<LogLevel, "silent">>)

export type YrdObservabilityFlags = Readonly<{
  verbose?: number
  quiet?: number
  logLevel?: string
}>

export type YrdObservability = Readonly<{
  level: LogLevel
  debug?: string
  file?: string
  spans: boolean
}>

export type YrdDeliveryIdentity = Readonly<{
  correlation?: Readonly<{ namespace: string; id: string }>
  pr?: string
  revision?: number
  headSha?: string
  run?: string
  step?: string
  job?: string
  attempt?: number
  runner?: string
  receipt?: string
  ref?: string
}>

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "silent"] as const

function count(value: number | undefined, flag: string): number {
  const resolved = value ?? 0
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    raiseFailure("usage", "invalid-observability-count", `${flag} count must be a non-negative integer`)
  }
  return resolved
}

function level(value: string | undefined, source: "--log-level" | "LOG_LEVEL"): LogLevel | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === undefined || normalized === "") return undefined
  if ((LOG_LEVELS as readonly string[]).includes(normalized)) return normalized as LogLevel
  raiseFailure(
    source === "--log-level" ? "usage" : "configuration",
    "invalid-log-level",
    `${source} must be one of ${LOG_LEVELS.join(", ")}; received '${value}'`,
  )
}

function setting(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized === undefined || normalized === "" ? undefined : normalized
}

/** Resolve the sole Yrd logging policy. CLI controls override LOG_LEVEL;
 * DEBUG remains a namespace filter and never changes severity. */
export function resolveYrdObservability(
  flags: YrdObservabilityFlags,
  env: Readonly<Record<string, string | undefined>>,
): YrdObservability {
  const verbose = count(flags.verbose, "--verbose")
  const quiet = count(flags.quiet, "--quiet")
  if (verbose > 0 && quiet > 0) {
    raiseFailure("usage", "contradictory-observability", "cannot combine --verbose and --quiet")
  }
  if (flags.logLevel !== undefined && (verbose > 0 || quiet > 0)) {
    raiseFailure("usage", "contradictory-observability", "cannot combine --log-level with --verbose or --quiet")
  }

  const explicit = level(flags.logLevel, "--log-level")
  const configured = level(env.LOG_LEVEL, "LOG_LEVEL")
  const selected =
    explicit ??
    (verbose >= 3
      ? "trace"
      : verbose === 2
        ? "debug"
        : verbose === 1
          ? "info"
          : quiet >= 2
            ? "silent"
            : quiet === 1
              ? "error"
              : (configured ?? "warn"))

  return Object.freeze({
    level: selected,
    ...(setting(env.DEBUG) === undefined ? {} : { debug: setting(env.DEBUG) }),
    ...(setting(env.LOGGILY_FILE) === undefined ? {} : { file: setting(env.LOGGILY_FILE) }),
    spans: selected === "trace" || selected === "debug",
  })
}

/** Create the one host-owned logger fan-out. Both sinks share the exact same
 * level and DEBUG namespace policy; the file sink is structured JSONL. */
export function createYrdLogger(config: YrdObservability, stderr: (text: string) => unknown): ConditionalLogger {
  const scope = {
    level: config.level,
    ...(config.debug === undefined ? {} : { ns: config.debug }),
    spans: config.spans,
  }
  const pipeline: ConfigElement[] = [scope, { write: stderr, objectMode: false }]
  if (config.file !== undefined) pipeline.push({ file: config.file, format: "json" })
  const logger = createLogger("yrd", pipeline)
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    logger[Symbol.dispose]()
  }
  return new Proxy(logger, {
    get(target, property, receiver): unknown {
      if (property === "end" || property === Symbol.dispose) return dispose
      return Reflect.get(target, property, receiver) as unknown
    },
  })
}

type LifecycleOutcome = "succeeded" | "refused" | "failed"

function emitLifecycle(
  log: ConditionalLogger,
  lifecycle: string,
  outcome: LifecycleOutcome,
  props: Record<string, unknown>,
): void {
  const message = `${lifecycle} ${outcome}`
  switch (YRD_LIFECYCLE_LEVELS[outcome]) {
    case "info":
      log.info?.(message, props)
      break
    case "warn":
      log.warn?.(message, props)
      break
    case "error":
      log.error?.(message, props)
      break
  }
}

/** Observe one existing Yrd lifecycle without writing journal facts or
 * inventing identities. Refusal/usage/configuration failures are expected
 * WARNs; infrastructure and unexpected failures are ERRORs. */
export async function observeYrdLifecycle<Result>(
  root: ConditionalLogger,
  options: Readonly<{
    lifecycle: string
    identity?: YrdDeliveryIdentity
    attributes?: Readonly<Record<string, unknown>>
    now?: () => number
  }>,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const log = root.child(options.lifecycle)
  const spanProps: Record<string, unknown> = {
    lifecycle: options.lifecycle,
    ...options.identity,
    ...options.attributes,
  }
  const span = log.span?.(undefined, () => spanProps)

  const finish = (outcome: LifecycleOutcome, error?: unknown): void => {
    const finishedAt = now()
    const durationMs = finishedAt - startedAt
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(`yrd: ${options.lifecycle} duration finish '${finishedAt}' precedes start '${startedAt}'`)
    }
    const failure = error === undefined ? undefined : failureFact(error)
    Object.assign(spanProps, {
      outcome,
      durationMs,
      ...(failure === undefined ? {} : { failure }),
    })
    if (span !== undefined) Object.assign(span.spanData as Record<string, unknown>, spanProps)
    emitLifecycle(log, options.lifecycle, outcome, { ...spanProps })
  }

  try {
    const result = await operation()
    finish("succeeded")
    return result
  } catch (error) {
    const failure = failureFact(error)
    finish(failure !== undefined && failure.kind !== "infrastructure" ? "refused" : "failed", error)
    throw error
  } finally {
    span?.end()
  }
}
