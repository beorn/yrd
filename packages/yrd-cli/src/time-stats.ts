/**
 * Windowed queue statistics — a thin projection over the SAME consolidated
 * `queueFlowMetrics` aggregate the watch/dashboard already report (landed
 * 36effce43e). This module owns no aggregation of its own: it calls
 * `queueFlowMetrics` once per rolling window (last hour, day, week, month) so
 * there is one home for the flow truth, and pairs each window with a `covered`
 * flag for the "-" rule. String formatting and rendering live in
 * `time-stats-box.tsx`.
 *
 * Rolling, not calendar: each window is `[now - span, now]`, both bounds
 * inclusive (the `queueFlowMetrics` cutoff). A window is only `covered` when the
 * journal history reaches back far enough to fill it — an operator watching a
 * two-day-old queue sees `-` for the week and month boxes rather than a
 * misleading partial-window number.
 */

import { type QueueFlowMetrics, type QueueTerminalFact, queueFlowMetrics } from "./queue-status-view.tsx"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** The four rolling windows, ordered narrowest → widest. `key` is the dim
 * header shown above each box column; `ms` is the rolling span behind it. */
export const QUEUE_TIME_WINDOWS = [
  { key: "HR", ms: HOUR_MS },
  { key: "DAY", ms: DAY_MS },
  { key: "WK", ms: 7 * DAY_MS },
  { key: "MON", ms: 30 * DAY_MS },
] as const

export type QueueTimeWindowKey = (typeof QUEUE_TIME_WINDOWS)[number]["key"]

/** One rolling window paired with the consolidated flow aggregate over it. */
export type QueueTimeWindowStats = Readonly<{
  key: QueueTimeWindowKey
  /** False when journal history does not reach back a full span — render `-`. */
  covered: boolean
  /** The single-home `queueFlowMetrics` aggregate over this window. */
  metrics: QueueFlowMetrics
}>

/**
 * Window the consolidated flow aggregate into the four rolling windows.
 *
 * @param facts   every retained terminal Run fact (the projection folds these once)
 * @param nowMs   the snapshot clock
 * @param earliestEventMs  the oldest journal record's time, or null when the
 *                journal holds no timestamped record — drives the `covered` gate
 */
export function queueTimeStats(
  facts: readonly QueueTerminalFact[],
  nowMs: number,
  earliestEventMs: number | null,
): readonly QueueTimeWindowStats[] {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error("yrd: time-stats snapshot time is not a finite non-negative number")
  }
  return QUEUE_TIME_WINDOWS.map((window) => ({
    key: window.key,
    covered: earliestEventMs !== null && earliestEventMs <= nowMs - window.ms,
    metrics: queueFlowMetrics(facts, { now: nowMs, windowMs: window.ms }),
  }))
}
