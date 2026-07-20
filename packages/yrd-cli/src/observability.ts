import { YRD_LIFECYCLE_LEVELS, observeYrdLifecycle, raiseFailure, type YrdDeliveryIdentity } from "@yrd/core"
import { createLogger, type ConditionalLogger, type ConfigElement, type Event, type LogLevel } from "loggily"
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
  /** True when the operator chose the level (--log-level / LOG_LEVEL / -v / -q).
   * The resident follow-runner only bumps its default level when this is false. */
  explicitLevel: boolean
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
    explicitLevel: explicit !== undefined || configured !== undefined || verbose > 0 || quiet > 0,
  })
}

/** The resident follow-runner's stderr IS a narration stream, so at the default
 * `warn` it would lose run/step starts and successful completions. Bump the
 * resolved policy to `debug` at the resident entry, but ONLY when the operator
 * left the level at its default (never overriding an explicit
 * `--log-level`/`LOG_LEVEL`/`-v`/`-q`). The resident human formatter admits only
 * concise lifecycle highlights; JSONL retains the full structured stream. */
export function residentObservability(config: YrdObservability): YrdObservability {
  if (config.explicitLevel || config.level !== "warn") return config
  return Object.freeze({ ...config, level: "debug" })
}

const RESIDENT_LIFECYCLE_NAMESPACES = ["yrd:jobs", "yrd:queue:run", "yrd:runner"] as const

function residentLifecycleNamespace(namespace: string): boolean {
  return RESIDENT_LIFECYCLE_NAMESPACES.some(
    (candidate) => namespace === candidate || namespace.startsWith(`${candidate}:`),
  )
}

/** Preserve loggily's zero-cost conditional calls for the implicit resident
 * policy. Its pipeline needs DEBUG/INFO only for lifecycle narration, so an
 * unrelated child must still expose neither method — otherwise every process,
 * Git, and projection debug payload is eagerly built and discarded downstream. */
function gateImplicitResidentLogger(logger: ConditionalLogger): ConditionalLogger {
  return new Proxy(logger, {
    get(target, property, receiver): unknown {
      if (
        (property === "debug" || property === "info" || property === "trace") &&
        !residentLifecycleNamespace(target.name)
      ) {
        return undefined
      }
      if (property === "child" || property === "logger") {
        const createChild = Reflect.get(target, property, target) as (...args: unknown[]) => ConditionalLogger
        return (...args: unknown[]) => gateImplicitResidentLogger(createChild.apply(target, args))
      }
      return Reflect.get(target, property, receiver) as unknown
    },
  })
}

/** Create the one host-owned logger fan-out. The file sink is structured JSONL.
 * When a `human` formatter is supplied (the resident follow-runner), the stderr
 * sink renders each Event through it — a scannable timeline row, or `undefined`
 * to suppress that line from the human stream. Without it, the default console
 * format is used.
 *
 * The implicit resident default is deliberately a branched policy: every
 * WARN/ERROR reaches the human sink, while DEBUG/INFO is admitted only from the
 * three lifecycle namespaces that form the narration. An explicitly selected
 * level/DEBUG filter keeps the ordinary single policy. A configured JSONL file
 * is an explicit request for the full structured DEBUG stream. */
export function createYrdLogger(
  config: YrdObservability,
  stderr: (text: string) => unknown,
  human?: (event: Event) => string | undefined,
): ConditionalLogger {
  enableContextPropagation()
  const scope = {
    level: config.level,
    ...(config.debug === undefined ? {} : { ns: config.debug }),
    spans: config.spans,
  }
  const stderrSink: ConfigElement =
    human === undefined
      ? { write: stderr, objectMode: false }
      : {
          write: (event: Event) => {
            const line = human(event)
            if (line !== undefined) stderr(`${line}\n`)
          },
          objectMode: true,
        }
  const implicitResident =
    human !== undefined && config.level === "debug" && !config.explicitLevel && config.debug === undefined
  const lifecycleLevel = (event: Event): Event | null =>
    event.kind === "log" && (event.level === "debug" || event.level === "info") ? event : null
  const pipeline: ConfigElement[] = implicitResident
    ? [
        { level: "debug", spans: false },
        [{ level: "warn", spans: false }, stderrSink],
        [{ level: "debug", ns: [...RESIDENT_LIFECYCLE_NAMESPACES], spans: false }, lifecycleLevel, stderrSink],
      ]
    : [scope, stderrSink]
  if (config.file !== undefined) {
    pipeline.push(
      implicitResident
        ? [
            { level: "debug", spans: config.spans },
            { file: config.file, format: "json" },
          ]
        : { file: config.file, format: "json" },
    )
  }
  const created = createLogger("yrd", pipeline)
  const logger = implicitResident && config.file === undefined ? gateImplicitResidentLogger(created) : created
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
