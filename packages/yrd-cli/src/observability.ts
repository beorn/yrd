import { createFailure, type FailureKind } from "@yrd/process"
import { createLogger, type ConditionalLogger, type ConfigElement, type LogLevel } from "loggily"
import { LOG_LEVEL_PRIORITY, resolveVerbosityLevel } from "loggily"
import { enableContextPropagation } from "loggily/context"

function raiseFailure(kind: FailureKind, code: string, message: string): never {
  throw createFailure({ kind, code, message })
}

export type YrdObservabilityFlags = Readonly<{
  verbose?: number
  quiet?: number
  logLevel?: string
}>

export type YrdObservability = Readonly<{
  level: LogLevel
  debug?: string
  file?: string
  /** Spans are CONSTRUCTED. loggily deletes `logger.span` when a pipeline says
   * `spans: false`, so this decides whether spans EXIST at all — the JSONL
   * sink can only record what was constructed. */
  spans: boolean
  /** SPAN rows are PRINTED to the human stream. The narrower question, and the
   * one `DEBUG=` should answer no to. */
  spanRows: boolean
  /** True when the operator chose the level (--log-level / LOG_LEVEL / -v / -q).
   * `-vv` and `--log-level debug` print span rows; a bare `DEBUG=` does not. */
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
 * operator pinning a level. */
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
  // The same three sources named above, kept as one value so `spans` and the
  // returned field can never drift apart.
  const explicitLevel = explicit !== undefined || configured !== undefined || verbose > 0 || quiet > 0

  return Object.freeze({
    level: selected,
    ...(namespaces === undefined ? {} : { debug: namespaces }),
    ...(setting(env.LOGGILY_FILE) === undefined ? {} : { file: setting(env.LOGGILY_FILE) }),
    // Construction follows the LEVEL, printing follows the operator's intent.
    // Those had to split: gating construction on intent (the previous shape
    // here) left `DEBUG=yrd:perf` — the exact invocation for reading the stage
    // breakdown — creating no spans, and the breakdown is derived from them, so
    // it printed an empty table with a confident `unaccountedMs`. Two
    // independently-correct changes landed an hour apart and were incompatible;
    // this is the seam they actually needed.
    spans: trace !== undefined || selected === "trace" || selected === "debug",
    // Unchanged in intent from the gate this replaces: DEBUG alone only ever
    // selects a default SEVERITY (explicitLevel stays false), and must not
    // bring a wall of span rows with it — a captured -vvv pass ran 28 SPAN
    // rows against 25 DEBUG rows, each a near-duplicate of the row above it
    // (@i/10-yrd/24015). `-vv`, `--log-level debug` and `LOG_LEVEL=debug` are
    // explicit requests, so they still print — `-vv`'s own "-vv enables spans"
    // help text stays true.
    spanRows: trace !== undefined || selected === "trace" || (selected === "debug" && explicitLevel),
    explicitLevel,
  })
}

/** Create the one host-owned logger fan-out: the operator's stderr stream, plus
 * the structured JSONL file when one is configured. */
export function createYrdLogger(config: YrdObservability, stderr: (text: string) => unknown): ConditionalLogger {
  enableContextPropagation()
  const scope = {
    level: config.level,
    ...(config.debug === undefined ? {} : { ns: config.debug }),
    spans: config.spans,
  }
  const stderrSink: ConfigElement = { write: stderr, objectMode: false }
  const pipeline: ConfigElement[] = config.spanRows
    ? [scope, stderrSink]
    : // A branch inherits `scope` and overrides only `spans`: rows stop at the
      // human stream while the JSONL sink below still records them.
      [scope, [{ spans: false }, stderrSink]]
  if (config.file !== undefined) {
    pipeline.push({ file: config.file, format: "json" })
  }
  const created = createLogger("yrd", pipeline)
  const logger = created
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
