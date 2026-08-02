import { YRD_LIFECYCLE_LEVELS, observeYrdLifecycle, raiseFailure, type YrdDeliveryIdentity } from "@yrd/core"
import {
  createLogger,
  LOG_LEVEL_PRIORITY,
  resolveVerbosityLevel,
  type ConditionalLogger,
  type ConfigElement,
  type Event,
  type LogLevel,
} from "loggily"
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
  if (normalized in LOG_LEVEL_PRIORITY) return normalized as LogLevel
  raiseFailure(
    source === "--log-level" ? "usage" : "configuration",
    "invalid-log-level",
    `${source} must be one of ${Object.keys(LOG_LEVEL_PRIORITY).join(", ")}; received '${value}'`,
  )
}

function setting(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized === undefined || normalized === "" ? undefined : normalized
}

/** Resolve the sole Yrd logging policy. CLI controls override LOG_LEVEL, and
 * LOG_LEVEL overrides the DEBUG implication below.
 *
 * DEBUG is a namespace FILTER, but setting one also IMPLIES `debug` severity
 * when the operator chose no level. It used to leave severity alone, which made
 * the knob inert exactly as documented: at the default `warn`, `DEBUG=yrd:core`
 * narrowed which namespaces could pass while the level still dropped every
 * debug record, so the documented invocation emitted ZERO BYTES. `DEBUG='*'`
 * emitted zero bytes too — proof the silence was never a namespace typo. That
 * cost real time: a multi-second stage of `queue ls` stayed invisible for weeks
 * because the one tool pointed at it was dead. Every other ecosystem reads
 * `DEBUG=ns` as "enable", so diverging silently had no upside.
 *
 * An explicit level still wins, from any of the three sources that count as an
 * operator choice (`--log-level`, `-v`/`-q`, `LOG_LEVEL`), and `explicitLevel`
 * deliberately stays false here — DEBUG selects a default, it is not the
 * operator pinning a level, and `residentObservability` keys off that. */
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
  const namespaces = setting(env.DEBUG)
  const trace = setting(env.TRACE)
  const shifted = verbose > 0 || quiet > 0 ? resolveVerbosityLevel("warn", verbose, quiet) : undefined
  const selected =
    explicit ??
    shifted ??
    // Last resort only: every branch above is an explicit operator choice and
    // keeps its level. DEBUG= just moves the DEFAULT.
    configured ??
    (namespaces === undefined ? "warn" : "debug")

  return Object.freeze({
    level: selected,
    ...(namespaces === undefined ? {} : { debug: namespaces }),
    ...(setting(env.LOGGILY_FILE) === undefined ? {} : { file: setting(env.LOGGILY_FILE) }),
    spans: trace !== undefined || selected === "trace" || selected === "debug",
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
 * to suppress that row from the human stream. Without it, the default console
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
            const row = human(event)
            if (row !== undefined) stderr(`${row}\n`)
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
