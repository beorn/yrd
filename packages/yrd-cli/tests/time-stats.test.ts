// @failure Queue statistics drift from local calendar boundaries, journal coverage, landed-PR/run semantics, or distribution/failure truth.
// @level l1
// @consumer yrd queue watch QueueStatsPanel

import { describe, expect, it } from "vitest"
import type { QueueTerminalFact, QueueTerminalMemberFact } from "../src/queue-status-view.tsx"
import { failureBreakdownClass } from "../src/status-presentation.ts"
import { queueStats } from "../src/time-stats.ts"

const MINUTE = 60_000

function fact(
  overrides: Partial<QueueTerminalFact> & Pick<QueueTerminalFact, "run" | "terminalAtMs" | "outcome">,
): QueueTerminalFact {
  return {
    activeMs: 60_000,
    failureClass: overrides.outcome === "integrated" ? null : "other",
    members: [],
    queueWaitMs: [],
    ...overrides,
  }
}

function member(overrides: Partial<QueueTerminalMemberFact> = {}): QueueTerminalMemberFact {
  return {
    pr: "PR1",
    revision: 1,
    totalMs: null,
    totalApproximate: false,
    codingMs: null,
    jobRunMs: null,
    retries: 0,
    ...overrides,
  }
}

describe("queueStats calendar buckets", () => {
  it("projects newest-first local hours followed by fixed calendar periods", () => {
    const now = new Date(2026, 6, 16, 13, 30).getTime()
    const stats = queueStats([], now, new Date(2026, 5, 1).getTime(), 3)

    expect(stats.map(({ label }) => label)).toEqual(["13", "12", "11", "TODAY", "YESTERDAY", "THIS WEEK", "THIS MONTH"])
  })

  it("keeps every hour bucket one real hour across local DST transitions", () => {
    const spring = queueStats([], new Date(2026, 2, 8, 3, 30).getTime(), 0, 4).slice(0, 4)
    const fall = queueStats([], new Date("2026-11-01T01:30:00-08:00").getTime(), 0, 4).slice(0, 4)

    for (const buckets of [spring, fall]) {
      expect(new Set(buckets.map(({ key }) => key))).toHaveLength(buckets.length)
      expect(buckets.map(({ startMs, endMs }) => endMs - startMs)).toEqual([
        30 * MINUTE + 1,
        60 * MINUTE,
        60 * MINUTE,
        60 * MINUTE,
      ])
    }
    expect(spring.map(({ label }) => label)).toEqual(["03", "01", "00", "23"])
    expect(fall.map(({ label }) => label)).toEqual(["01b", "01a", "00", "23"])
  })

  it("counts settled Runs but counts integrated PR members", () => {
    const now = new Date(2026, 6, 16, 13, 30).getTime()
    const facts: QueueTerminalFact[] = [
      fact({
        run: "batched-pass",
        terminalAtMs: new Date(2026, 6, 16, 13, 10).getTime(),
        outcome: "integrated",
        members: [member({ pr: "PR1" }), member({ pr: "PR2" })],
      }),
      fact({
        run: "failed",
        terminalAtMs: new Date(2026, 6, 16, 13, 20).getTime(),
        outcome: "environment-refused",
        failureClass: "env",
        members: [member({ pr: "PR3" })],
      }),
      fact({
        run: "prior-hour",
        terminalAtMs: new Date(2026, 6, 16, 12, 59, 59).getTime(),
        outcome: "integrated",
        members: [member({ pr: "PR4" })],
      }),
    ]

    const [hour, previousHour, today] = queueStats(facts, now, new Date(2026, 5, 1).getTime(), 2)
    expect(hour?.runs).toMatchObject({
      all: 2,
      integrated: 2,
      fails: 1,
      failureBreakdown: { env: 1 },
    })
    expect(previousHour?.runs).toMatchObject({ all: 1, integrated: 1, fails: 0 })
    expect(today?.label).toBe("TODAY")
    expect(today?.runs).toMatchObject({ all: 3, integrated: 3, fails: 1 })
  })

  it("uses local calendar boundaries for yesterday, Monday-based week, and month", () => {
    const now = new Date(2026, 6, 16, 13, 30).getTime()
    const atTodayStart = new Date(2026, 6, 16, 0, 0).getTime()
    const atYesterdayStart = new Date(2026, 6, 15, 0, 0).getTime()
    const atWeekStart = new Date(2026, 6, 13, 0, 0).getTime()
    const beforeWeek = atWeekStart - 1
    const atMonthStart = new Date(2026, 6, 1, 0, 0).getTime()
    const facts = [
      fact({ run: "today-edge", terminalAtMs: atTodayStart, outcome: "integrated", members: [member()] }),
      fact({ run: "yesterday-edge", terminalAtMs: atYesterdayStart, outcome: "rejected" }),
      fact({ run: "week-edge", terminalAtMs: atWeekStart, outcome: "rejected" }),
      fact({ run: "before-week", terminalAtMs: beforeWeek, outcome: "rejected" }),
      fact({ run: "month-edge", terminalAtMs: atMonthStart, outcome: "rejected" }),
    ]
    const buckets = queueStats(facts, now, atMonthStart, 0)
    const byLabel = (label: string) => buckets.find((bucket) => bucket.label === label)

    expect(byLabel("TODAY")?.runs.all).toBe(1)
    expect(byLabel("YESTERDAY")?.runs.all).toBe(1)
    expect(byLabel("THIS WEEK")?.runs.all).toBe(3)
    expect(byLabel("THIS MONTH")?.runs.all).toBe(5)
  })

  it("projects avg/p50/p95, approximation truth, unavailable coding, and retries from member facts", () => {
    const now = new Date(2026, 6, 16, 13, 30).getTime()
    const terminalAtMs = new Date(2026, 6, 16, 13, 10).getTime()
    const facts = [
      fact({
        run: "pass",
        terminalAtMs,
        outcome: "integrated",
        queueWaitMs: [2 * MINUTE, 4 * MINUTE],
        members: [
          member({
            pr: "PR1",
            totalMs: MINUTE,
            jobRunMs: 4 * MINUTE,
            retries: 1,
          }),
          member({
            pr: "PR2",
            totalMs: 3 * MINUTE,
            totalApproximate: true,
            jobRunMs: 8 * MINUTE,
            retries: 3,
          }),
        ],
      }),
      fact({
        run: "fail",
        terminalAtMs,
        outcome: "rejected",
        queueWaitMs: [6 * MINUTE],
        members: [
          member({
            pr: "PR3",
            jobRunMs: 12 * MINUTE,
            retries: 5,
          }),
        ],
      }),
    ]
    const hour = queueStats(facts, now, new Date(2026, 5, 1).getTime(), 1)[0]!

    expect(hour.total).toMatchObject({
      n: 2,
      avgMs: 2 * MINUTE,
      p50Ms: 2 * MINUTE,
      p95Ms: 3 * MINUTE,
      approximate: true,
    })
    expect(hour.coding).toMatchObject({ n: 0, avgMs: null, p50Ms: null, p95Ms: null })
    expect(hour.queueWait).toMatchObject({
      n: 3,
      avgMs: 4 * MINUTE,
      p50Ms: 4 * MINUTE,
      p95Ms: 6 * MINUTE,
    })
    expect(hour.jobRun).toMatchObject({
      n: 3,
      avgMs: 8 * MINUTE,
      p50Ms: 8 * MINUTE,
      p95Ms: 12 * MINUTE,
    })
    expect(hour.retries).toMatchObject({ n: 2, avg: 2, p50: 2, p95: 3 })
  })

  it("marks each calendar bucket covered only when retained history reaches its start", () => {
    const now = new Date(2026, 6, 16, 13, 30).getTime()
    const earliest = new Date(2026, 6, 16, 12, 30).getTime()
    const [hour, previousHour, today] = queueStats([], now, earliest, 2)

    expect(hour?.covered).toBe(true)
    expect(previousHour?.covered).toBe(false)
    expect(today?.covered).toBe(false)
    expect(queueStats([], now, null, 0).every((bucket) => !bucket.covered)).toBe(true)
  })

  it("partitions the requested failure classes through the shared status/error vocabulary", () => {
    expect(
      [
        "check-failed",
        "queue-environment-refused",
        "environment-refused",
        "stale-pr",
        "stale",
        "job-lost",
        "lost",
        "config-drift",
        "queue-canceled",
        "canceled",
        "review-rejected",
      ].map(failureBreakdownClass),
    ).toEqual([
      "check-failed",
      "env",
      "env",
      "stale",
      "stale",
      "timeout",
      "timeout",
      "config-drift",
      "canceled",
      "canceled",
      "other",
    ])
  })

  it("fails loud on duplicate Runs and invalid terminal/member metrics", () => {
    const now = new Date(2026, 6, 16, 13, 30).getTime()
    const terminalAtMs = now - MINUTE
    const valid = fact({
      run: "R1",
      terminalAtMs,
      outcome: "integrated",
      members: [member({ totalMs: MINUTE })],
    })

    expect(() => queueStats([valid, valid], now, 0, 1)).toThrow("duplicate terminal STATS fact")
    expect(() => queueStats([{ ...valid, terminalAtMs: Number.NaN }], now, 0, 1)).toThrow("Run 'R1' terminal time")
    expect(() => queueStats([{ ...valid, members: [member({ totalMs: -1 })] }], now, 0, 1)).toThrow(
      "PR 'PR1' total duration",
    )
    expect(() => queueStats([{ ...valid, members: [member({ retries: 0.5 })] }], now, 0, 1)).toThrow("PR 'PR1' retries")
  })
})
