/**
 * Windowed queue statistics — pure projection over the terminal facts the
 * queue timeline already folds per Run. The watch surface renders four
 * side-by-side boxes (throughput + three duration boxes), each broken down
 * across four ROLLING windows: last hour, day, week, and month. This module
 * owns only the numeric aggregation; string formatting and rendering live in
 * `time-stats-box.tsx` so the windows stay unit-testable without a renderer.
 *
 * Rolling, not calendar: each window is `[now - span, now]`, both bounds
 * inclusive (matching the single-window `queueFlowMetrics` cutoff). A window is
 * only `covered` when the journal history reaches back far enough to fill it —
 * an operator watching a two-day-old queue sees `-` for the week and month
 * boxes rather than a misleading partial-window number.
 */

import type { QueueTerminalFact } from "./queue-status-view.tsx"

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

/** The widest window we ever look back through — the builder can fold facts for
 * this span and trust every narrower window to be a subset. */
export const QUEUE_TIME_STATS_MAX_WINDOW_MS = Math.max(...QUEUE_TIME_WINDOWS.map((window) => window.ms))

/** AVG / p50 / p90 over a sample set; every field is null for an empty set. */
export type QueueTimeDistribution = Readonly<{
  n: number
  avgMs: number | null
  p50Ms: number | null
  p90Ms: number | null
}>

export type QueueTimeWindowStats = Readonly<{
  key: QueueTimeWindowKey
  /** False when journal history does not reach back a full span — render `-`. */
  covered: boolean
  runs: number
  integrated: number
  /** Total failed Runs = decision + env + canceled. */
  fails: number
  /** Decision rejections (a queue check said no). */
  decision: number
  /** Environment-refused Runs (the host could not be prepared). */
  env: number
  canceled: number
  /** Active duration of the integrated Runs that terminated in this window. */
  timeIntegrated: QueueTimeDistribution
  /** Active duration of the failed Runs that terminated in this window. */
  timeFailed: QueueTimeDistribution
  /** Queue-wait latency (submit → start) across every member in this window. */
  timeWait: QueueTimeDistribution
}>

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`yrd: ${label} is not a finite non-negative number`)
  return value
}

/** Nearest-rank percentile over an ascending set: `sorted[ceil(p*n) - 1]`,
 * clamped at index 0. Matches the queue timeline's existing `nearestRank`. */
function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null
}

function distribution(values: readonly number[]): QueueTimeDistribution {
  const sorted = values.toSorted((left, right) => left - right)
  const n = sorted.length
  if (n === 0) return { n, avgMs: null, p50Ms: null, p90Ms: null }
  return {
    n,
    avgMs: sorted.reduce((sum, value) => sum + value, 0) / n,
    p50Ms: nearestRank(sorted, 0.5),
    p90Ms: nearestRank(sorted, 0.9),
  }
}

function windowStats(
  key: QueueTimeWindowKey,
  spanMs: number,
  facts: readonly QueueTerminalFact[],
  nowMs: number,
  earliestEventMs: number | null,
): QueueTimeWindowStats {
  const earliest = nowMs - spanMs
  const covered = earliestEventMs !== null && earliestEventMs <= earliest
  const inWindow = facts.filter((f) => {
    const terminalAtMs = finitePositive(f.terminalAtMs, `Run '${f.run}' terminal time`)
    return terminalAtMs >= earliest && terminalAtMs <= nowMs
  })
  let integrated = 0
  let decision = 0
  let env = 0
  let canceled = 0
  const integratedActive: number[] = []
  const failedActive: number[] = []
  const waits: number[] = []
  for (const f of inWindow) {
    const failed = f.outcome !== "integrated"
    if (f.outcome === "integrated") integrated += 1
    else if (f.outcome === "rejected") decision += 1
    else if (f.outcome === "environment-refused") env += 1
    else canceled += 1
    if (f.activeMs !== null) {
      const activeMs = finitePositive(f.activeMs, `Run '${f.run}' active duration`)
      if (failed) failedActive.push(activeMs)
      else integratedActive.push(activeMs)
    }
    for (const wait of f.queueWaitMs) waits.push(finitePositive(wait, `Run '${f.run}' queue wait`))
  }
  return {
    key,
    covered,
    runs: inWindow.length,
    integrated,
    fails: decision + env + canceled,
    decision,
    env,
    canceled,
    timeIntegrated: distribution(integratedActive),
    timeFailed: distribution(failedActive),
    timeWait: distribution(waits),
  }
}

/**
 * Project the per-Run terminal facts into the four rolling windows.
 *
 * @param facts   every retained terminal Run fact (the builder folds these once)
 * @param nowMs   the snapshot clock
 * @param earliestEventMs  the oldest journal record's time, or null when the
 *                journal holds no timestamped record — drives the `covered` gate
 */
export function queueTimeStats(
  facts: readonly QueueTerminalFact[],
  nowMs: number,
  earliestEventMs: number | null,
): readonly QueueTimeWindowStats[] {
  const now = finitePositive(nowMs, "time-stats snapshot time")
  return QUEUE_TIME_WINDOWS.map((window) => windowStats(window.key, window.ms, facts, now, earliestEventMs))
}
