import type { ConditionalLogger, LogLevel } from "loggily"
import { failureFact } from "./failure.ts"

/** Default severity by lifecycle outcome. Delivery-step starts are the one
 * explicit identity-aware promotion; see observeYrdLifecycle. */
export const YRD_LIFECYCLE_LEVELS = Object.freeze({
  started: "debug",
  progress: "trace",
  succeeded: "info",
  // An aggregate lifecycle (a run/compose) that completed carrying an
  // already-reported failure. The deepest failing job/step owns the single
  // ERROR; the enclosing levels settle at INFO so one failure is reported once,
  // never re-raised as a duplicate ERROR up the tree.
  settled: "info",
  refused: "warn",
  recovered: "warn",
  failed: "error",
} as const satisfies Record<string, Exclude<LogLevel, "silent">>)

// Lock acquisition and composition are routine per-cycle plumbing. Their
// failures remain loud, while successful completion is useful only when an
// operator explicitly enables DEBUG. Run/check/merge successes remain INFO
// because they are delivery milestones.
const DEBUG_SUCCESS_LIFECYCLES = new Set(["lock", "compose"])

export type YrdLifecycleOutcome = keyof typeof YRD_LIFECYCLE_LEVELS

export type YrdDeliveryIdentity = Readonly<{
  correlation?: Readonly<{ namespace: string; id: string }>
  pr?: string
  revision?: number
  headSha?: string
  branch?: string
  issue?: string
  run?: string
  step?: string
  job?: string
  attempt?: number
  runner?: string
  receipt?: string
  ref?: string
  command?: string
  cause?: string
  op?: string
}>

export type YrdLifecycleOptions<Result> = Readonly<{
  lifecycle: string
  identity?: YrdDeliveryIdentity
  attributes?: Readonly<Record<string, unknown>>
  outcome?: YrdLifecycleOutcome | ((result: Result) => YrdLifecycleOutcome)
  resultAttributes?: (result: Result) => Readonly<Record<string, unknown>>
  /** Replace the flat outcome word in the completion message with a computed
   * summary label (e.g. a mixed-outcome tally: `settled: 1 failed, 1 passed`).
   * A returned string becomes both the message tail and a `summary` field; the
   * severity still derives from `outcome`. Only consulted on a non-throwing
   * result. */
  label?: (result: Result) => string | undefined
  now?: () => number
}>

/** Observe one existing Yrd lifecycle without writing journal facts or
 * inventing identities. Callers may classify non-throwing domain results,
 * while thrown refusal/usage/configuration failures remain WARNs. */
export async function observeYrdLifecycle<Result>(
  root: ConditionalLogger,
  options: YrdLifecycleOptions<Result>,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const log = root.child(options.lifecycle)
  const spanProps: Record<string, unknown> = {
    ...options.attributes,
    ...options.identity,
    lifecycle: options.lifecycle,
  }
  const span = log.span?.(undefined, () => spanProps)
  // Delivery-step starts are operator milestones: surface them at INFO even
  // though routine lifecycle starts remain DEBUG. This keeps configured step
  // names generic while making batch execution visible without enabling DEBUG.
  const startLevel = options.identity?.run !== undefined && options.identity.step !== undefined ? "info" : undefined
  emitLifecycle(log, options.lifecycle, "started", "started", { ...spanProps, outcome: "started" }, startLevel)

  const finish = (outcome: YrdLifecycleOutcome, error?: unknown, result?: Result): void => {
    const finishedAt = now()
    const measuredDurationMs = finishedAt - startedAt
    const invalidDuration = !Number.isFinite(measuredDurationMs) || measuredDurationMs < 0
    const durationMs = invalidDuration ? 0 : measuredDurationMs
    const failure = error === undefined ? undefined : failureFact(error)
    const summary = result === undefined ? undefined : options.label?.(result)
    Object.assign(spanProps, result === undefined ? {} : options.resultAttributes?.(result), {
      outcome,
      durationMs,
      ...(summary === undefined ? {} : { summary }),
      ...(invalidDuration ? { diagnostic: "invalid-duration", startedAt, finishedAt } : {}),
      ...(failure === undefined ? {} : { failure }),
    })
    if (span !== undefined) Object.assign(span.spanData as Record<string, unknown>, spanProps)
    if (invalidDuration) log.error?.(`${options.lifecycle} duration invalid`, { ...spanProps })
    emitLifecycle(log, options.lifecycle, outcome, summary ?? outcome, { ...spanProps })
  }

  try {
    let result: Result
    try {
      result = await operation()
    } catch (error) {
      const failure = failureFact(error)
      finish(failure !== undefined && failure.kind !== "infrastructure" ? "refused" : "failed", error)
      throw error
    }
    finish(
      typeof options.outcome === "function" ? options.outcome(result) : (options.outcome ?? "succeeded"),
      undefined,
      result,
    )
    return result
  } finally {
    span?.end()
  }
}

function emitLifecycle(
  log: ConditionalLogger,
  lifecycle: string,
  outcome: YrdLifecycleOutcome,
  descriptor: string,
  props: Record<string, unknown>,
  levelOverride?: Exclude<LogLevel, "silent">,
): void {
  const message = `${lifecycle} ${descriptor}`
  const level =
    levelOverride ??
    (outcome === "succeeded" && DEBUG_SUCCESS_LIFECYCLES.has(lifecycle) ? "debug" : YRD_LIFECYCLE_LEVELS[outcome])
  switch (level) {
    case "trace":
      log.trace?.(message, props)
      break
    case "debug":
      log.debug?.(message, props)
      break
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
