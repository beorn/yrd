/** Pure journal-fact projection for the queue watch's calendar STATS panel. */

import { type QueueTerminalFact } from "./queue-status-view.tsx"
import { FAILURE_BREAKDOWN_CLASSES, type FailureBreakdownClass } from "./status-presentation.ts"

export type QueueStatsBucket = Readonly<{
  key: string
  label: string
  kind: "hour" | "period"
  startMs: number
  endMs: number
  covered: boolean
  runs: Readonly<{
    all: number
    integrated: number
    fails: number
    failureBreakdown: Readonly<Record<FailureBreakdownClass, number>>
  }>
  total: QueueStatsDistribution & Readonly<{ approximate: boolean }>
  coding: QueueStatsDistribution
  queueWait: QueueStatsDistribution
  jobRun: QueueStatsDistribution
  retries: QueueStatsDistribution
}>

export type QueueStatsDistribution = Readonly<{
  n: number
  avgMs: number | null
  p50Ms: number | null
  p95Ms: number | null
}>

type QueueStatsWindow = Readonly<Pick<QueueStatsBucket, "key" | "label" | "kind" | "startMs" | "endMs">>

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? null)
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? null
}

function statsDistribution(values: readonly number[]): QueueStatsDistribution {
  const sorted = values.toSorted((left, right) => left - right)
  const n = sorted.length
  return {
    n,
    avgMs: n === 0 ? null : sorted.reduce((sum, value) => sum + value, 0) / n,
    p50Ms: median(sorted),
    p95Ms: percentile(sorted, 0.95),
  }
}

function validStatsClock(value: number, subject: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`yrd: ${subject} must be a finite non-negative timestamp`)
  }
  return value
}

function localHourStart(nowMs: number, hoursAgo: number): number {
  const start = new Date(nowMs)
  start.setMinutes(0, 0, 0)
  start.setHours(start.getHours() - hoursAgo)
  return start.getTime()
}

function localDayStart(nowMs: number): Date {
  const start = new Date(nowMs)
  start.setHours(0, 0, 0, 0)
  return start
}

function statsWindows(nowMs: number, hourCount: number): readonly QueueStatsWindow[] {
  const hours = Array.from({ length: hourCount }, (_, index): QueueStatsWindow => {
    const startMs = localHourStart(nowMs, index)
    const endMs = index === 0 ? nowMs + 1 : localHourStart(nowMs, index - 1)
    return {
      key: `hour:${String(startMs)}`,
      label: String(new Date(startMs).getHours()).padStart(2, "0"),
      kind: "hour",
      startMs,
      endMs,
    }
  })
  const today = localDayStart(nowMs)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const week = new Date(today)
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7))
  const month = new Date(today.getFullYear(), today.getMonth(), 1)
  const nowEnd = nowMs + 1
  return [
    ...hours,
    { key: "today", label: "TODAY", kind: "period", startMs: today.getTime(), endMs: nowEnd },
    {
      key: "yesterday",
      label: "YESTERDAY",
      kind: "period",
      startMs: yesterday.getTime(),
      endMs: today.getTime(),
    },
    { key: "week", label: "THIS WEEK", kind: "period", startMs: week.getTime(), endMs: nowEnd },
    { key: "month", label: "THIS MONTH", kind: "period", startMs: month.getTime(), endMs: nowEnd },
  ]
}

function failureBreakdown(facts: readonly QueueTerminalFact[]): Readonly<Record<FailureBreakdownClass, number>> {
  const counts = Object.fromEntries(FAILURE_BREAKDOWN_CLASSES.map((failureClass) => [failureClass, 0])) as Record<
    FailureBreakdownClass,
    number
  >
  for (const fact of facts) {
    if (fact.outcome === "integrated") continue
    const failureClass = fact.failureClass ?? "other"
    counts[failureClass] += 1
  }
  return counts
}

function queueStatsBucket(
  window: QueueStatsWindow,
  facts: readonly QueueTerminalFact[],
  earliestEventMs: number | null,
): QueueStatsBucket {
  const selected = facts.filter((fact) => fact.terminalAtMs >= window.startMs && fact.terminalAtMs < window.endMs)
  const members = selected.flatMap((fact) => fact.members)
  const integratedMembers = selected.filter((fact) => fact.outcome === "integrated").flatMap((fact) => fact.members)
  const totalMembers = integratedMembers.filter((member) => member.totalMs !== null)
  return {
    ...window,
    covered: earliestEventMs !== null && earliestEventMs <= window.startMs,
    runs: {
      all: selected.length,
      integrated: integratedMembers.length,
      fails: selected.filter((fact) => fact.outcome !== "integrated").length,
      failureBreakdown: failureBreakdown(selected),
    },
    total: {
      ...statsDistribution(totalMembers.flatMap((member) => (member.totalMs === null ? [] : [member.totalMs]))),
      approximate: totalMembers.some((member) => member.totalApproximate),
    },
    coding: statsDistribution(members.flatMap((member) => (member.codingMs === null ? [] : [member.codingMs]))),
    queueWait: statsDistribution(
      members.flatMap((member) => (member.queueWaitMs === null ? [] : [member.queueWaitMs])),
    ),
    jobRun: statsDistribution(members.flatMap((member) => (member.jobRunMs === null ? [] : [member.jobRunMs]))),
    retries: statsDistribution(integratedMembers.map((member) => member.retries)),
  }
}

/**
 * Project one retained terminal-fact stream into width-selected local hour
 * buckets plus the four fixed calendar periods. The journal remains the only
 * source; this function owns no counters between renders.
 */
export function queueStats(
  facts: readonly QueueTerminalFact[],
  nowMs: number,
  earliestEventMs: number | null,
  hourCount: number,
): readonly QueueStatsBucket[] {
  const now = validStatsClock(nowMs, "queue-stats snapshot time")
  if (!Number.isInteger(hourCount) || hourCount < 0) {
    throw new TypeError("yrd: queue-stats hour count must be a non-negative integer")
  }
  if (earliestEventMs !== null) validStatsClock(earliestEventMs, "queue-stats history horizon")
  return statsWindows(now, hourCount).map((window) => queueStatsBucket(window, facts, earliestEventMs))
}
