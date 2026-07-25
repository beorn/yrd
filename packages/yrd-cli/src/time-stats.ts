/** Pure journal-fact projection for the queue watch's calendar STATS panel. */

import { finiteNonnegative, numericDistribution } from "./numeric-distribution.ts"
import { type QueueTerminalFact } from "./queue-terminal-facts.ts"
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
    alreadyLanded: number
    /** Admission-only / non-landing successes (21801) — not FAILS, not INTEGRATED. */
    passed: number
    fails: number
    failureBreakdown: Readonly<Record<FailureBreakdownClass, number>>
  }>
  total: QueueStatsDurationDistribution & Readonly<{ approximate: boolean }>
  coding: QueueStatsDurationDistribution
  queueWait: QueueStatsDurationDistribution
  jobRun: QueueStatsDurationDistribution
  retries: QueueStatsCountDistribution
}>

export type QueueStatsDurationDistribution = Readonly<{
  n: number
  avgMs: number | null
  p50Ms: number | null
  p95Ms: number | null
}>

export type QueueStatsCountDistribution = Readonly<{
  n: number
  avg: number | null
  p50: number | null
  p95: number | null
}>

type QueueStatsWindow = Readonly<Pick<QueueStatsBucket, "key" | "label" | "kind" | "startMs" | "endMs">>

function statsDurationDistribution(values: readonly number[], subject: string): QueueStatsDurationDistribution {
  const { n, avg, p50, p95 } = numericDistribution(values, subject)
  return {
    n,
    avgMs: avg,
    p50Ms: p50,
    p95Ms: p95,
  }
}

function statsCountDistribution(values: readonly number[], subject: string): QueueStatsCountDistribution {
  const { n, avg, p50, p95 } = numericDistribution(values, subject)
  return { n, avg, p50, p95 }
}

function currentLocalHourStart(nowMs: number): number {
  const now = new Date(nowMs)
  const elapsedMs = (now.getMinutes() * 60 + now.getSeconds()) * 1_000 + now.getMilliseconds()
  return nowMs - elapsedMs
}

function localDayStart(nowMs: number): Date {
  const start = new Date(nowMs)
  start.setHours(0, 0, 0, 0)
  return start
}

function statsWindows(nowMs: number, hourCount: number): readonly QueueStatsWindow[] {
  const hourMs = 60 * 60_000
  const currentHourStartMs = currentLocalHourStart(nowMs)
  const starts = Array.from({ length: hourCount }, (_, index) => currentHourStartMs - index * hourMs)
  const labels = starts.map((startMs) => String(new Date(startMs).getHours()).padStart(2, "0"))
  const duplicateLabels = Map.groupBy(labels.keys(), (index) => labels[index] ?? "")
  for (const indices of duplicateLabels.values()) {
    if (indices.length < 2) continue
    const chronological = indices.toSorted((left, right) => (starts[left] ?? 0) - (starts[right] ?? 0))
    chronological.forEach((index, order) => {
      labels[index] = `${labels[index]}${String.fromCharCode("a".charCodeAt(0) + order)}`
    })
  }
  const hours = starts.map((startMs, index): QueueStatsWindow => {
    const endMs = index === 0 ? nowMs + 1 : (starts[index - 1] ?? nowMs + 1)
    return {
      key: `hour:${String(startMs)}`,
      label: labels[index] ?? "",
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
    if (fact.outcome === "integrated" || fact.outcome === "already-landed" || fact.outcome === "passed") continue
    const failureClass = fact.failureClass ?? "other"
    counts[failureClass] += 1
  }
  return counts
}

function queueStatsBucket(
  window: QueueStatsWindow,
  facts: readonly QueueTerminalFact[],
  earliestFactMs: number | null,
): QueueStatsBucket {
  const selected = facts.filter((fact) => fact.terminalAtMs >= window.startMs && fact.terminalAtMs < window.endMs)
  const members = selected.flatMap((fact) => fact.members)
  const integratedMembers = selected.filter((fact) => fact.outcome === "integrated").flatMap((fact) => fact.members)
  const alreadyLandedMembers = selected
    .filter((fact) => fact.outcome === "already-landed")
    .flatMap((fact) => fact.members)
  const totalMembers = integratedMembers.filter((member) => member.totalMs !== null)
  const isLanding = (outcome: string) => outcome === "integrated" || outcome === "already-landed"
  const isNonLandingSuccess = (outcome: string) => outcome === "passed"
  return {
    ...window,
    covered: earliestFactMs !== null && earliestFactMs <= window.startMs,
    runs: {
      all: selected.length,
      integrated: integratedMembers.length,
      alreadyLanded: alreadyLandedMembers.length,
      passed: selected.filter((fact) => isNonLandingSuccess(fact.outcome)).length,
      fails: selected.filter((fact) => !isLanding(fact.outcome) && !isNonLandingSuccess(fact.outcome)).length,
      failureBreakdown: failureBreakdown(selected),
    },
    total: {
      ...statsDurationDistribution(
        totalMembers.flatMap((member) => (member.totalMs === null ? [] : [member.totalMs])),
        "STATS total duration sample",
      ),
      approximate: totalMembers.some((member) => member.totalApproximate),
    },
    coding: statsDurationDistribution(
      members.flatMap((member) => (member.codingMs === null ? [] : [member.codingMs])),
      "STATS coding duration sample",
    ),
    queueWait: statsDurationDistribution(
      selected.flatMap((fact) => fact.queueWaitMs),
      "STATS queue wait sample",
    ),
    jobRun: statsDurationDistribution(
      members.flatMap((member) => (member.jobRunMs === null ? [] : [member.jobRunMs])),
      "STATS job duration sample",
    ),
    retries: statsCountDistribution(
      integratedMembers.map((member) => member.retries),
      "STATS retry sample",
    ),
  }
}

function validateFacts(facts: readonly QueueTerminalFact[]): void {
  const seenRuns = new Set<string>()
  for (const fact of facts) {
    finiteNonnegative(fact.terminalAtMs, `Run '${fact.run}' terminal time`)
    if (seenRuns.has(fact.run)) throw new Error(`yrd: duplicate terminal STATS fact for Run '${fact.run}'`)
    seenRuns.add(fact.run)
    if (fact.activeMs !== null) finiteNonnegative(fact.activeMs, `Run '${fact.run}' active duration`)
    for (const wait of fact.queueWaitMs) finiteNonnegative(wait, `Run '${fact.run}' queue wait`)
    for (const member of fact.members) {
      if (member.totalMs !== null) finiteNonnegative(member.totalMs, `PR '${member.pr}' total duration`)
      if (member.codingMs !== null) finiteNonnegative(member.codingMs, `PR '${member.pr}' coding duration`)
      if (member.jobRunMs !== null) finiteNonnegative(member.jobRunMs, `PR '${member.pr}' job duration`)
      if (!Number.isInteger(member.retries) || member.retries < 0) {
        throw new TypeError(`yrd: PR '${member.pr}' retries must be a non-negative integer`)
      }
    }
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
  earliestFactMs: number | null,
  hourCount: number,
): readonly QueueStatsBucket[] {
  const now = finiteNonnegative(nowMs, "queue-stats snapshot time")
  if (!Number.isInteger(hourCount) || hourCount < 0) {
    throw new TypeError("yrd: queue-stats hour count must be a non-negative integer")
  }
  if (earliestFactMs !== null) finiteNonnegative(earliestFactMs, "queue-stats history horizon")
  validateFacts(facts)
  return statsWindows(now, hourCount).map((window) => queueStatsBucket(window, facts, earliestFactMs))
}
