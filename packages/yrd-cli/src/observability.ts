import { YRD_LIFECYCLE_LEVELS, observeYrdLifecycle, raiseFailure, type YrdDeliveryIdentity } from "@yrd/core"
import { createLogger, type ConditionalLogger, type ConfigElement, type LogLevel } from "loggily"
import { enableContextPropagation } from "loggily/context"

export { YRD_LIFECYCLE_LEVELS, observeYrdLifecycle, type YrdDeliveryIdentity }

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
  enableContextPropagation()
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
