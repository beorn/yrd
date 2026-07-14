import type { ConditionalLogger, LogLevel } from "loggily"
import { failureFact } from "./failure.ts"

export const YRD_LIFECYCLE_LEVELS = Object.freeze({
  started: "debug",
  progress: "trace",
  succeeded: "info",
  refused: "warn",
  recovered: "warn",
  failed: "error",
} as const satisfies Record<string, Exclude<LogLevel, "silent">>)

export type YrdLifecycleOutcome = keyof typeof YRD_LIFECYCLE_LEVELS

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
  emitLifecycle(log, options.lifecycle, "started", { ...spanProps, outcome: "started" })

  const finish = (outcome: YrdLifecycleOutcome, error?: unknown, result?: Result): void => {
    const finishedAt = now()
    const measuredDurationMs = finishedAt - startedAt
    const invalidDuration = !Number.isFinite(measuredDurationMs) || measuredDurationMs < 0
    const durationMs = invalidDuration ? 0 : measuredDurationMs
    const failure = error === undefined ? undefined : failureFact(error)
    Object.assign(spanProps, result === undefined ? {} : options.resultAttributes?.(result), {
      outcome,
      durationMs,
      ...(invalidDuration ? { diagnostic: "invalid-duration", startedAt, finishedAt } : {}),
      ...(failure === undefined ? {} : { failure }),
    })
    if (span !== undefined) Object.assign(span.spanData as Record<string, unknown>, spanProps)
    if (invalidDuration) log.error?.(`${options.lifecycle} duration invalid`, { ...spanProps })
    emitLifecycle(log, options.lifecycle, outcome, { ...spanProps })
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
  props: Record<string, unknown>,
): void {
  const message = `${lifecycle} ${outcome}`
  switch (YRD_LIFECYCLE_LEVELS[outcome]) {
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
