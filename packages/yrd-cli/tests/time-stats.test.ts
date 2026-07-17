// @failure Windowed queue throughput/latency aggregates drift from the rolling-window contract (edges, coverage "-", nearest-rank, failure shares).
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

describe("queueTimeStats windows", () => {
  it("exposes exactly the four rolling windows HR / DAY / WK / MON in order", () => {
    expect(QUEUE_TIME_WINDOWS.map((window) => window.key)).toEqual(["HR", "DAY", "WK", "MON"])
    expect(QUEUE_TIME_WINDOWS.map((window) => window.ms)).toEqual([HOUR, DAY, WEEK, 30 * DAY])
    const stats = queueTimeStats([], NOW, null)
    expect(stats.map((entry) => entry.key)).toEqual(["HR", "DAY", "WK", "MON"])
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
    const earliest = NOW - 30 * DAY
    const stats = queueTimeStats(facts, NOW, earliest)
    const hr = windowByKey(stats, "HR")
    expect(hr.runs).toBe(2)
    expect(hr.integrated).toBe(1)
    expect(hr.fails).toBe(1)
    const day = windowByKey(stats, "DAY")
    expect(day.runs).toBe(3)
    expect(day.integrated).toBe(2)
    expect(day.fails).toBe(1)
  })

  it("includes both window edges (inclusive bounds)", () => {
    const facts: QueueTerminalFact[] = [
      fact({ run: "edge-old", terminalAtMs: NOW - HOUR, outcome: "integrated" }), // exactly at window start
      fact({ run: "edge-now", terminalAtMs: NOW, outcome: "integrated" }), // exactly at now
    ]
    const hr = windowByKey(queueTimeStats(facts, NOW, NOW - 30 * DAY), "HR")
    expect(hr.runs).toBe(2)
  })

  it("partitions failures into decision / env / canceled shares that sum to the fail count", () => {
    const facts: QueueTerminalFact[] = [
      fact({ run: "r1", terminalAtMs: NOW - MINUTE, outcome: "rejected" }),
      fact({ run: "r2", terminalAtMs: NOW - MINUTE, outcome: "rejected" }),
      fact({ run: "e1", terminalAtMs: NOW - MINUTE, outcome: "environment-refused" }),
      fact({ run: "c1", terminalAtMs: NOW - MINUTE, outcome: "canceled" }),
      fact({ run: "i1", terminalAtMs: NOW - MINUTE, outcome: "integrated" }),
    ]
    const hr = windowByKey(queueTimeStats(facts, NOW, NOW - 30 * DAY), "HR")
    expect(hr.runs).toBe(5)
    expect(hr.integrated).toBe(1)
    expect(hr.fails).toBe(4)
    expect(hr.decision).toBe(2)
    expect(hr.env).toBe(1)
    expect(hr.canceled).toBe(1)
    expect(hr.decision + hr.env + hr.canceled).toBe(hr.fails)
  })

  it("computes active-duration distributions per outcome with nearest-rank percentiles", () => {
    // integrated active durations: 1,2,3,4,5,6,7,8,9,10 minutes
    const facts: QueueTerminalFact[] = []
    for (let i = 1; i <= 10; i++) {
      facts.push(fact({ run: `i${i}`, terminalAtMs: NOW - MINUTE, outcome: "integrated", activeMs: i * MINUTE }))
    }
    // failed active durations: 20, 40 minutes
    facts.push(fact({ run: "f1", terminalAtMs: NOW - MINUTE, outcome: "rejected", activeMs: 20 * MINUTE }))
    facts.push(fact({ run: "f2", terminalAtMs: NOW - MINUTE, outcome: "canceled", activeMs: 40 * MINUTE }))
    const hr = windowByKey(queueTimeStats(facts, NOW, NOW - 30 * DAY), "HR")
    // AVG of 1..10 = 5.5
    expect(hr.timeIntegrated.avgMs).toBe(5.5 * MINUTE)
    // nearest-rank p50 of 1..10 = sorted[ceil(0.5*10)-1] = sorted[4] = 5
    expect(hr.timeIntegrated.p50Ms).toBe(5 * MINUTE)
    // nearest-rank p90 of 1..10 = sorted[ceil(0.9*10)-1] = sorted[8] = 9
    expect(hr.timeIntegrated.p90Ms).toBe(9 * MINUTE)
    expect(hr.timeIntegrated.n).toBe(10)
    // failed distribution
    expect(hr.timeFailed.n).toBe(2)
    expect(hr.timeFailed.avgMs).toBe(30 * MINUTE)
  })

  it("aggregates queue-wait latency across every member wait in the window", () => {
    const facts: QueueTerminalFact[] = [
      fact({ run: "a", terminalAtMs: NOW - MINUTE, outcome: "integrated", queueWaitMs: [MINUTE, 3 * MINUTE] }),
      fact({ run: "b", terminalAtMs: NOW - MINUTE, outcome: "rejected", queueWaitMs: [5 * MINUTE] }),
    ]
    const hr = windowByKey(queueTimeStats(facts, NOW, NOW - 30 * DAY), "HR")
    expect(hr.timeWait.n).toBe(3)
    expect(hr.timeWait.avgMs).toBe(((1 + 3 + 5) / 3) * MINUTE)
  })

  it("returns null distributions and zero counts for an empty covered window", () => {
    const hr = windowByKey(queueTimeStats([], NOW, NOW - 30 * DAY), "HR")
    expect(hr.covered).toBe(true)
    expect(hr.runs).toBe(0)
    expect(hr.fails).toBe(0)
    expect(hr.timeIntegrated.n).toBe(0)
    expect(hr.timeIntegrated.avgMs).toBeNull()
    expect(hr.timeWait.p90Ms).toBeNull()
  })

  it("throws loudly on a non-finite terminal timestamp (no silent skip)", () => {
    const bad = [fact({ run: "x", terminalAtMs: Number.NaN, outcome: "integrated" })]
    expect(() => queueTimeStats(bad, NOW, NOW - 30 * DAY)).toThrow()
  })
})
