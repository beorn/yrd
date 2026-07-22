// @failure Windowed queue statistics drift from the rolling-window contract (edges, coverage "-", per-window flow aggregate, failure partition).
// @level l1
// @consumer yrd queue watch TimeStatsBox windowed statistics

import { describe, expect, it } from "vitest"
import type { QueueTerminalFact } from "../src/queue-status-view.tsx"
import { QUEUE_TIME_WINDOWS, queueTimeStats } from "../src/time-stats.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

const NOW = Date.parse("2026-07-16T12:00:00.000Z")

function fact(
  overrides: Partial<QueueTerminalFact> & Pick<QueueTerminalFact, "run" | "terminalAtMs" | "outcome">,
): QueueTerminalFact {
  return {
    activeMs: 60_000,
    queueWaitMs: [],
    ...overrides,
  }
}

function windowByKey(stats: ReturnType<typeof queueTimeStats>, key: string) {
  const found = stats.find((entry) => entry.key === key)
  if (found === undefined) throw new Error(`no window ${key}`)
  return found
}

/** Failed Runs = the non-integrated terminal outcomes, per the FLOW box. */
function failsOf(
  outcomes: Readonly<{
    rejected: number
    environmentRefused: number
    stale: number
    lost: number
    legacy: number
    refused: number
    canceled: number
  }>,
): number {
  return (
    outcomes.rejected +
    outcomes.environmentRefused +
    outcomes.stale +
    outcomes.lost +
    outcomes.legacy +
    outcomes.refused +
    outcomes.canceled
  )
}

describe("queueTimeStats windows", () => {
  it("exposes exactly the four rolling windows HR / DAY / WK / MON in order", () => {
    expect(QUEUE_TIME_WINDOWS.map((window) => window.key)).toEqual(["HR", "DAY", "WK", "MON"])
    expect(QUEUE_TIME_WINDOWS.map((window) => window.ms)).toEqual([HOUR, DAY, WEEK, 30 * DAY])
    const stats = queueTimeStats([], NOW, null)
    expect(stats.map((entry) => entry.key)).toEqual(["HR", "DAY", "WK", "MON"])
  })

  it("windows the consolidated queueFlowMetrics aggregate per box", () => {
    // Each window carries a full queueFlowMetrics keyed to its own span.
    const hr = windowByKey(queueTimeStats([], NOW, NOW - 30 * DAY), "HR")
    expect(hr.metrics.windowMs).toBe(HOUR)
    expect(windowByKey(queueTimeStats([], NOW, NOW - 30 * DAY), "MON").metrics.windowMs).toBe(30 * DAY)
  })

  it("marks a window uncovered when journal history does not span it", () => {
    // Earliest record is 3 days old: HR and DAY are spanned; WK and MON are not.
    const earliest = NOW - 3 * DAY
    const stats = queueTimeStats([], NOW, earliest)
    expect(windowByKey(stats, "HR").covered).toBe(true)
    expect(windowByKey(stats, "DAY").covered).toBe(true)
    expect(windowByKey(stats, "WK").covered).toBe(false)
    expect(windowByKey(stats, "MON").covered).toBe(false)
  })

  it("treats a null horizon (no records) as uncovered everywhere", () => {
    for (const entry of queueTimeStats([], NOW, null)) expect(entry.covered).toBe(false)
  })

  it("counts runs, integrated, and failures within the rolling window only", () => {
    const facts: QueueTerminalFact[] = [
      fact({ run: "a", terminalAtMs: NOW - 10 * MINUTE, outcome: "integrated" }),
      fact({ run: "b", terminalAtMs: NOW - 20 * MINUTE, outcome: "rejected" }),
      fact({ run: "c", terminalAtMs: NOW - 90 * MINUTE, outcome: "integrated" }), // outside HR, inside DAY
    ]
    const stats = queueTimeStats(facts, NOW, NOW - 30 * DAY)
    const hr = windowByKey(stats, "HR").metrics
    expect(hr.terminalAttempts).toBe(2)
    expect(hr.outcomes.integrated).toBe(1)
    expect(failsOf(hr.outcomes)).toBe(1)
    const day = windowByKey(stats, "DAY").metrics
    expect(day.terminalAttempts).toBe(3)
    expect(day.outcomes.integrated).toBe(2)
    expect(failsOf(day.outcomes)).toBe(1)
  })

  it("includes both window edges (inclusive bounds)", () => {
    const facts: QueueTerminalFact[] = [
      fact({ run: "edge-old", terminalAtMs: NOW - HOUR, outcome: "integrated" }), // exactly at window start
      fact({ run: "edge-now", terminalAtMs: NOW, outcome: "integrated" }), // exactly at now
    ]
    expect(windowByKey(queueTimeStats(facts, NOW, NOW - 30 * DAY), "HR").metrics.terminalAttempts).toBe(2)
  })

  it("partitions every named failure class so the classes sum to the fail count", () => {
    const facts: QueueTerminalFact[] = [
      fact({ run: "r1", terminalAtMs: NOW - MINUTE, outcome: "rejected" }),
      fact({ run: "r2", terminalAtMs: NOW - MINUTE, outcome: "rejected" }),
      fact({ run: "e1", terminalAtMs: NOW - MINUTE, outcome: "environment-refused" }),
      fact({ run: "s1", terminalAtMs: NOW - MINUTE, outcome: "stale" }),
      fact({ run: "l1", terminalAtMs: NOW - MINUTE, outcome: "lost" }),
      fact({ run: "q1", terminalAtMs: NOW - MINUTE, outcome: "legacy" }),
      fact({ run: "f1", terminalAtMs: NOW - MINUTE, outcome: "refused" }),
      fact({ run: "c1", terminalAtMs: NOW - MINUTE, outcome: "canceled" }),
      fact({ run: "i1", terminalAtMs: NOW - MINUTE, outcome: "integrated" }),
    ]
    const hr = windowByKey(queueTimeStats(facts, NOW, NOW - 30 * DAY), "HR").metrics
    expect(hr.terminalAttempts).toBe(9)
    expect(hr.outcomes.integrated).toBe(1)
    expect(failsOf(hr.outcomes)).toBe(8)
    expect(hr.outcomes.rejected).toBe(2)
    expect(hr.outcomes.environmentRefused).toBe(1)
    expect(hr.outcomes.stale).toBe(1)
    expect(hr.outcomes.lost).toBe(1)
    expect(hr.outcomes.legacy).toBe(1)
    expect(hr.outcomes.refused).toBe(1)
    expect(hr.outcomes.canceled).toBe(1)
    expect(
      hr.outcomes.rejected +
        hr.outcomes.environmentRefused +
        hr.outcomes.stale +
        hr.outcomes.lost +
        hr.outcomes.legacy +
        hr.outcomes.refused +
        hr.outcomes.canceled,
    ).toBe(failsOf(hr.outcomes))
  })

  it("splits active-duration distributions into integrated vs failed", () => {
    // integrated active durations: 1..10 minutes; failed: 20, 40 minutes.
    const facts: QueueTerminalFact[] = []
    for (let i = 1; i <= 10; i++) {
      facts.push(fact({ run: `i${i}`, terminalAtMs: NOW - MINUTE, outcome: "integrated", activeMs: i * MINUTE }))
    }
    facts.push(fact({ run: "f1", terminalAtMs: NOW - MINUTE, outcome: "rejected", activeMs: 20 * MINUTE }))
    facts.push(fact({ run: "f2", terminalAtMs: NOW - MINUTE, outcome: "canceled", activeMs: 40 * MINUTE }))
    const active = windowByKey(queueTimeStats(facts, NOW, NOW - 30 * DAY), "HR").metrics.activeRun
    // TIME / INTEGRATED: AVG of 1..10 = 5.5; p50 = interpolated median 5.5; p90 = nearest-rank 9.
    expect(active.integratedOnly.n).toBe(10)
    expect(active.integratedOnly.avgMs).toBe(5.5 * MINUTE)
    expect(active.integratedOnly.p50Ms).toBe(5.5 * MINUTE)
    expect(active.integratedOnly.p90Ms).toBe(9 * MINUTE)
    // TIME / FAILED: the failed-only distribution the consolidated aggregate now carries.
    expect(active.failedOnly.n).toBe(2)
    expect(active.failedOnly.avgMs).toBe(30 * MINUTE)
  })

  it("aggregates queue-wait latency across every member wait in the window", () => {
    const facts: QueueTerminalFact[] = [
      fact({ run: "a", terminalAtMs: NOW - MINUTE, outcome: "integrated", queueWaitMs: [MINUTE, 3 * MINUTE] }),
      fact({ run: "b", terminalAtMs: NOW - MINUTE, outcome: "rejected", queueWaitMs: [5 * MINUTE] }),
    ]
    const wait = windowByKey(queueTimeStats(facts, NOW, NOW - 30 * DAY), "HR").metrics.queueWait
    expect(wait.n).toBe(3)
    expect(wait.avgMs).toBe(((1 + 3 + 5) / 3) * MINUTE)
  })

  it("returns null distributions and zero counts for an empty covered window", () => {
    const hr = windowByKey(queueTimeStats([], NOW, NOW - 30 * DAY), "HR")
    expect(hr.covered).toBe(true)
    expect(hr.metrics.terminalAttempts).toBe(0)
    expect(failsOf(hr.metrics.outcomes)).toBe(0)
    expect(hr.metrics.activeRun.integratedOnly.n).toBe(0)
    expect(hr.metrics.activeRun.integratedOnly.avgMs).toBeNull()
    expect(hr.metrics.activeRun.failedOnly.avgMs).toBeNull()
    expect(hr.metrics.queueWait.p90Ms).toBeNull()
  })

  it("throws loudly on a non-finite terminal timestamp (no silent skip)", () => {
    const bad = [fact({ run: "x", terminalAtMs: Number.NaN, outcome: "integrated" })]
    expect(() => queueTimeStats(bad, NOW, NOW - 30 * DAY)).toThrow()
  })
})
