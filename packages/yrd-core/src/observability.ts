import type { ConditionalLogger, LogLevel } from "loggily"
import { systemClock } from "./clock.ts"
import { failureFact } from "./failure.ts"
import { LIFECYCLE_DURATION_UNMEASURABLE } from "./log-actions.ts"

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
  // One-shot commands report their final error at the CLI boundary. Keeping
  // lifecycle failures at INFO avoids printing the same failure twice; the
  // habitant runner enables INFO and still records every background outcome.
  recovered: "warn",
  failed: "info",
} as const satisfies Record<string, Exclude<LogLevel, "silent">>)

// Lock acquisition and composition are routine per-cycle plumbing. Their
// failures remain loud, while successful completion is useful only when an
// operator explicitly enables DEBUG. Run/check/merge successes remain INFO
// because they are delivery milestones.
const DEBUG_SUCCESS_LIFECYCLES = new Set(["lock", "compose"])

export type YrdLifecycleOutcome = keyof typeof YRD_LIFECYCLE_LEVELS

export type YrdDeliveryIdentity = Readonly<{
  props?: Readonly<Record<string, string>>
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
  result?: string
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
  const now = options.now ?? systemClock.now
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
    if (invalidDuration) {
      log.error?.(`Could not measure how long ${options.lifecycle} took; its result is unchanged.`, {
        ...spanProps,
        action: LIFECYCLE_DURATION_UNMEASURABLE.key,
      })
    }
    emitLifecycle(log, options.lifecycle, outcome, summary ?? outcome, { ...spanProps })
  }

  try {
    let result: Result
    try {
      result = await operation()
    } catch (error) {
      // The "refused" outcome retired 2026-08-18: the ratified result states
      // are queued -> checking -> merged | failed, and the distinction this
      // used to carry (a typed domain failure whose kind isn't
      // "infrastructure", versus everything else) lives in `failure?.kind` on
      // the attached result content instead -- see the `failure` field
      // `finish` already assigns onto spanProps below.
      finish("failed", error)
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

/** A condition worth logging every cycle it holds — but not every literal
 * repeat, and not silence either. `report`'s first call for a KEY logs
 * immediately at the caller's level. A repeat of the SAME key tallies without
 * logging, until the tally crosses a doubling threshold — the identical
 * `min(2 ** attempts, cap)` shape {@link ConditionReporter}'s own doc points
 * at below — at which point the condition is still active and gets
 * re-announced rather than staying quiet, carrying how many repeats were
 * folded into the wait. That is the escalation: fewer lines than one per
 * pass, but never a single loud line followed by permanent silence for a
 * condition that never clears. */
export type ConditionReporter = Readonly<{
  /** Log (or tally) one occurrence of `key`. First call for a key always logs
   * `message`/`props` at `level`. A call while the key is already active
   * either tallies silently or re-announces, per the doubling schedule. */
  report(key: string, level: "warn" | "error", message: string, props?: Readonly<Record<string, unknown>>): void
  /** The caller observed `key`'s condition clear. Flushes a closing summary
   * naming how many repeats were folded in since the last announcement —
   * silent when there were none, so a condition that fired exactly once never
   * grows a synthetic second line. */
  resolve(key: string): void
  /** Flush every still-active key's closing summary (if any repeats were
   * folded in). Call at loop/process exit so a condition that never resolves
   * explicitly — the process just stops — does not lose its trailing tally. */
  flush(): void
}>

/** Repeats-per-announcement doubles (1, 2, 4, 8, …) and caps here — the same
 * cap shape `refreshTrackedQueueRevisions`'s `MAX_OBSERVATION_SKIP` already
 * uses for its own re-observation backoff, copied rather than re-derived. */
const CONDITION_REPEAT_CAP = 32

type ConditionEntry = Readonly<{
  level: "warn" | "error"
  message: string
  props: Readonly<Record<string, unknown>>
  /** How many times this key has been announced (>= 1: `report` always
   * announces the first occurrence). Doubles the wait before the next one. */
  announcements: number
  /** Repeats folded silently into the wait since the last announcement. */
  suppressed: number
}>

/** Build one {@link ConditionReporter} bound to `log`. Callers that track
 * several independent conditions from one process share ONE reporter and
 * namespace their own keys (e.g. `` `liveness:${base}` `` vs
 * `` `track-deferred:${pr}` ``) — the reporter itself never assumes what a key
 * means, only that the SAME string is the SAME condition. */
export function createConditionReporter(log: ConditionalLogger): ConditionReporter {
  const active = new Map<string, ConditionEntry>()
  const emit = (level: "warn" | "error", message: string, props: Readonly<Record<string, unknown>>): void => {
    if (level === "error") log.error?.(message, props)
    else log.warn?.(message, props)
  }
  const repeatAction = (props: Readonly<Record<string, unknown>>): string =>
    typeof props.action === "string" ? `${props.action}-repeat-summary` : "condition-repeat-summary"
  const summarize = (key: string): void => {
    const entry = active.get(key)
    active.delete(key)
    if (entry === undefined || entry.suppressed === 0) return
    emit(entry.level, `${entry.message} (cleared after ${String(entry.suppressed)} more repeated occurrence(s))`, {
      ...entry.props,
      action: repeatAction(entry.props),
      suppressed: entry.suppressed,
    })
  }
  return Object.freeze({
    report(key, level, message, props = {}) {
      const entry = active.get(key)
      if (entry === undefined) {
        active.set(key, { level, message, props, announcements: 1, suppressed: 0 })
        emit(level, message, props)
        return
      }
      const suppressed = entry.suppressed + 1
      if (suppressed < Math.min(2 ** entry.announcements, CONDITION_REPEAT_CAP)) {
        active.set(key, { ...entry, suppressed })
        return
      }
      const announcements = entry.announcements + 1
      active.set(key, { level, message, props, announcements, suppressed: 0 })
      emit(
        level,
        `${message} (still ongoing — ${String(suppressed)} repeated occurrence(s) suppressed since the last notice)`,
        { ...props, action: repeatAction(props), suppressedSinceLastNotice: suppressed },
      )
    },
    resolve(key) {
      summarize(key)
    },
    flush() {
      // Deleting the current key mid-iteration is well-defined for Map: the
      // iterator never revisits a deleted entry and never skips a pending
      // one, so this needs no snapshot copy of the key list.
      for (const key of active.keys()) summarize(key)
    },
  })
}
