/**
 * @failure  The port had no STATS box: nothing on the screen said how many
 *           changes merged or failed today, per hour, and a midnight fused
 *           onto an hour label broke every column's width (watch-redesign
 *           items 18–22). The counts come from decisions the run journals
 *           recorded; nothing here derives a state.
 * @level    l1 (the buckets and the duplicate predicate) and l2 (the box)
 * @consumer the operator reading the bottom of `yrd watch`
 */

import { describe, expect, it } from "vitest"
import { render } from "silvery/test"
import type { JournalRun, WatchRow } from "@yrd/queue-core"
import { StatsBox, statsHoursFor } from "../src/watch-boxes.tsx"
import { MinuteContext, NowContext } from "../src/watch-clock.ts"
import {
  UNCLASSIFIED,
  countCell,
  shortDuration,
  timeCell,
  decisionsOfRows,
  isDuplicateMerge,
  rowDecision,
  statsBuckets,
  unclassifiedRows,
  type RunDecision,
} from "../src/watch-stats.ts"

// A local instant: 14:30 on a Thursday, so yesterday and a midnight both fall inside 24 hours.
const NOW = new Date(2026, 8, 3, 14, 30, 0)

/** The journal's run a row was split by: its id and what it decided are what the reader takes. */
function journalRun(id: string, decided?: Pick<JournalRun, "decision" | "reason" | "merge">): JournalRun {
  return { at: NOW, branch: "task/x", checks: [], head: "x".repeat(40), id, startedAt: NOW, ...decided }
}

function decision(
  hoursAgo: number,
  kind: RunDecision["decision"],
  run = `run-${String(hoursAgo)}`,
  duplicate = false,
): RunDecision {
  return { at: new Date(NOW.getTime() - hoursAgo * 3_600_000), decision: kind, duplicate, run }
}

describe("statsBuckets", () => {
  it("lays out TODAY, YSTRDAY and the hours newest first, and marks the local midnight as a boundary, not a label", () => {
    const buckets = statsBuckets([], NOW, 24)
    expect(buckets.slice(0, 2).map((bucket) => bucket.label)).toEqual(["TODAY", "YSTRDAY"])
    const hours = buckets.filter((bucket) => bucket.kind === "hour")
    expect(hours).toHaveLength(24)
    expect(hours[0]?.label).toBe("14")
    expect(hours[1]?.label).toBe("13")
    // Every label stays two digits; the midnight is a fact on the first bucket of the older day.
    expect(hours.every((bucket) => bucket.label.length === 2)).toBe(true)
    const boundary = hours.findIndex((bucket) => bucket.dayBoundary)
    expect(hours[boundary]?.label).toBe("23")
    expect(hours[boundary - 1]?.label).toBe("00")
    expect(hours.filter((bucket) => bucket.dayBoundary)).toHaveLength(1)
  })

  it("counts merges, duplicates, fails, stuck and distinct runs into the buckets they fall in", () => {
    const decisions = [
      decision(0.5, "merged", "r1"),
      decision(0.5, "failed", "r1"),
      decision(2, "merged", "r2", true),
      decision(20, "stuck", "r3"),
      decision(30, "merged", "r4"),
    ]
    const [today, yesterday, week, month, ...hours] = statsBuckets(decisions, NOW, 24)
    expect(today).toMatchObject({ duplicates: 1, fails: 1, merges: 1, runs: 2, stuck: 0 })
    // 20 hours before 14:30 is 18:30 yesterday; 30 hours before is 08:30 yesterday.
    expect(yesterday).toMatchObject({ duplicates: 0, fails: 0, merges: 1, runs: 2, stuck: 1 })
    // Thursday the 3rd: the week began Monday the 31st and the month on Tuesday the 1st; both hold every decision.
    expect(week).toMatchObject({ duplicates: 1, fails: 1, label: "WEEK", merges: 2, runs: 4, stuck: 1 })
    expect(month).toMatchObject({ duplicates: 1, fails: 1, label: "MONTH", merges: 2, runs: 4, stuck: 1 })
    expect(hours[0]).toMatchObject({ fails: 1, merges: 1, runs: 1 })
    expect(hours[2]).toMatchObject({ duplicates: 1, merges: 0 })
    expect(countCell(hours[1]!, "merges")).toBe("·")
    expect(countCell(today!, "merges")).toBe("1")
  })

  it("counts a checked verdict as a PASS, and reads the TIME rows as medians of the spans the decisions carry", () => {
    const merged = (hoursAgo: number, spans: Partial<RunDecision>): RunDecision => ({
      ...decision(hoursAgo, "merged", `m${String(hoursAgo)}`),
      ...spans,
    })
    const decisions = [
      decision(1, "checked", "c1"),
      merged(2, { queuedMs: 60_000, retries: 0, runMs: 120_000, totalMs: 600_000 }),
      merged(3, { queuedMs: 180_000, retries: 2, runMs: 240_000, totalMs: 1_800_000 }),
      merged(4, { queuedMs: 120_000, retries: 1, runMs: 3_600_000 * 2, totalMs: 3_600_000 * 30 }),
      // A failed run carries a queue wait and a run time, never a total: it merged nothing.
      { ...decision(5, "failed", "f1"), queuedMs: 30_000, runMs: 45_000 },
    ]
    const [today] = statsBuckets(decisions, NOW, 24)
    expect(today).toMatchObject({ merges: 3, passes: 1 })
    // Medians: total over the three merges, queuing and running over the four decisions that carry them.
    expect(today).toMatchObject({ queuedMs: 90_000, retries: 1, runMs: 180_000, totalMs: 1_800_000 })
    expect(timeCell(today!, "totalMs")).toBe("30m")
    expect(timeCell(today!, "queuedMs")).toBe("2m")
    expect(timeCell(today!, "runMs")).toBe("3m")
    expect(timeCell(today!, "retries")).toBe("1.0")
    const [, yesterday, , , hour] = statsBuckets([], NOW, 24)
    expect(timeCell(yesterday!, "totalMs"), "no data in a period is an em-dash, not a zero").toBe("—")
    expect(timeCell(hour!, "totalMs"), "no data in an hour is the strip's dot").toBe("·")
    expect([45_000, 90_000, 3_600_000 * 2, 3_600_000 * 30].map(shortDuration)).toEqual(["45s", "2m", "2h", "1d"])
  })

  it("measures the spans off the rows: opened → started, started → ended, opened → merged, and the retries a merge took", () => {
    const since = new Date(NOW.getTime() - 3_600_000)
    const startedAt = new Date(NOW.getTime() - 1_800_000)
    const endedAt = new Date(NOW.getTime() - 600_000)
    const base = { branch: "task/t", head: "t".repeat(40), since, startedAt, endedAt } as const
    const rows: readonly WatchRow[] = [
      // Two runs on one head: the first failed, the second merged — one retry.
      { row: { ...base, at: startedAt, result: "fail test", state: "merged", run: "r1", endedAt: startedAt } },
      { row: { ...base, at: endedAt, merge: "9".repeat(40), result: "pass test", state: "merged", run: "r2" } },
    ]
    const [failed, merged] = decisionsOfRows(rows)
    expect(failed).toMatchObject({ decision: "failed", queuedMs: 1_800_000, runMs: 0 })
    expect(failed).not.toHaveProperty("totalMs")
    expect(failed).not.toHaveProperty("retries")
    expect(merged).toMatchObject({
      decision: "merged",
      queuedMs: 1_800_000,
      retries: 1,
      runMs: 1_200_000,
      totalMs: 3_000_000,
    })
  })
})

describe("the duplicate predicate and the flattening", () => {
  it("names a merged decision with no merge commit and the already-on-target reason a duplicate, and nothing else", () => {
    expect(isDuplicateMerge({ decision: "merged", reason: "already on the target" })).toBe(true)
    expect(isDuplicateMerge({ decision: "merged", merge: "b".repeat(40), reason: "already on the target" })).toBe(false)
    expect(isDuplicateMerge({ decision: "failed", reason: "already on the target" })).toBe(false)
    expect(isDuplicateMerge({ decision: "merged" })).toBe(false)
  })

  it("reads a split row as its journal run's decision, an unsplit row by its own fields, and skips what decided nothing", () => {
    const one = { branch: "task/one", head: "a".repeat(40) }
    const two = { branch: "task/two", head: "b".repeat(40) }
    const rows: WatchRow[] = [
      // Split by journal runs: the run's decision is the record, whatever the row's state says.
      {
        row: { ...one, at: NOW, merge: "m".repeat(40), state: "merged" },
        run: journalRun("r1", { decision: "merged", merge: "m".repeat(40) }),
      },
      { row: { ...one, at: NOW, state: "merged" }, run: journalRun("r2") },
      {
        row: { ...two, at: NOW, reason: "already on the target", state: "merged" },
        run: journalRun("r3", { decision: "merged", reason: "already on the target" }),
      },
      {
        row: { ...two, at: NOW, result: "fail typecheck", state: "merged" },
        run: journalRun("r4", { decision: "failed" }),
      },
      // Unsplit: the row's own fields say the verdict; the row's run names the decider.
      {
        row: {
          at: NOW,
          branch: "task/three",
          head: "c".repeat(40),
          endedAt: NOW,
          result: "fail typecheck",
          run: "q-5",
          state: "failed",
        },
      },
      // A run whose record about the change is the notice it sent after an ending: not a verdict, not unknown.
      {
        row: { ...two, at: NOW, state: "merged" },
        run: journalRun("r5", { decision: "sent", reason: "change-ref-taken" }),
      },
      // A run that ran a check and recorded no decision: a result with no endedAt.
      {
        row: {
          at: NOW,
          branch: "task/four",
          head: "e".repeat(40),
          result: "pass substrate-pair",
          run: "q-6",
          state: "merged",
        },
      },
      // A queued change has no verdict; a direct commit was decided by nobody.
      { row: { branch: "task/five", head: "f".repeat(40), position: 1, state: "queued" } },
      { row: { at: NOW, branch: "main", head: "d".repeat(40), state: "direct" } },
    ]
    expect(decisionsOfRows(rows).map((decision) => [decision.run, decision.decision, decision.duplicate])).toEqual([
      ["r1", "merged", false],
      ["r3", "merged", true],
      ["r4", "failed", false],
      ["q-5", "failed", false],
    ])
    expect(unclassifiedRows(rows)).toEqual([])
  })

  it("names a stuck run by its own incident sentence and leaves an unknown sentence unclassified, never stuck", () => {
    const incident = {
      at: NOW,
      branch: "task/i",
      endedAt: NOW,
      head: "1".repeat(40),
      reason: "yrd-check-unresolved",
      result: "yrd-check-unresolved: the queue could not judge task/i at merge: affected-tests exit 3 is not a verdict",
      state: "failed" as const,
    }
    expect(rowDecision(incident)).toEqual({ decision: "stuck", duplicate: false })
    expect(rowDecision({ ...incident, reason: undefined })).toBe(UNCLASSIFIED)
    expect(rowDecision({ ...incident, result: "held by hand" })).toBe(UNCLASSIFIED)
    expect(decisionsOfRows([{ row: { ...incident, result: "held by hand" } }])).toEqual([])
    expect(unclassifiedRows([{ row: incident }, { row: { ...incident, result: "held by hand" } }])).toHaveLength(1)
  })
})

describe("the STATS box", () => {
  async function paint(decisions: readonly RunDecision[], cols: number): Promise<string> {
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <StatsBox decisions={decisions} columns={cols - 2} />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      { cols, rows: 12 },
    )
    await app.waitForLayoutStable()
    const text = app.text
    app.unmount()
    return text
  }

  it("prints TODAY YSTRDAY WEEK MONTH, right-aligns every number, keeps DUP just above FAILS, runs the midnight rule as its own column, and draws the TIME rows under the counts", async () => {
    const text = await paint(
      [
        decision(0.5, "merged"),
        decision(0.5, "merged", "r9"),
        decision(2, "merged", "r2", true),
        decision(3, "failed", "r3"),
      ],
      120,
    )
    const lines = text.split("\n")
    const header = lines.find((line) => line.includes("YSTRDAY"))
    expect(header).toBeDefined()
    expect(header).toContain("TODAY")
    expect(header).not.toContain("YESTERDAY")
    expect(header).toMatch(/TODAY\s+YSTRDAY\s+WEEK\s+MONTH/u)
    const rows = [
      "MERGES",
      "PASS",
      "DUP",
      "FAILS",
      "STUCK",
      "RUNS",
      "TIME",
      "TOTAL",
      "QUEUING",
      "RUNNING",
      "RETRIES",
    ].map((label) => lines.findIndex((line) => line.includes(label)))
    // In order, every row present, DUP directly above FAILS, the TIME rows under the counts.
    expect(
      rows.every((index) => index >= 0),
      text,
    ).toBe(true)
    expect(rows).toEqual([...rows].sort((left, right) => left - right))
    expect(rows[3]).toBe(rows[2]! + 1)
    // Right-aligned: the TODAY count ends in the same column the TODAY label ends in.
    const todayEnd = header!.indexOf("TODAY") + "TODAY".length
    const merges = lines[rows[0]!]!
    expect(merges.slice(0, todayEnd).trimEnd().endsWith("2")).toBe(true)
    // The midnight column: a `│` in the same column on the header and on every row.
    const bars = (line: string): number[] => [...line].flatMap((glyph, index) => (glyph === "│" ? [index] : []))
    const headerBars = bars(header!)
    expect(headerBars.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) expect(bars(lines[row]!)).toEqual(headerBars)
  })

  it("fits fewer hours in a narrow pane and never fewer than six", () => {
    expect(statsHoursFor(200)).toBe(24)
    expect(statsHoursFor(45)).toBe(6)
    expect(statsHoursFor(90)).toBeGreaterThan(6)
    expect(statsHoursFor(90)).toBeLessThan(24)
  })

  it("draws every row with nothing to count when the queue decided nothing: the box needs no journal", async () => {
    const text = await paint([], 100)
    expect(text).toContain("MERGES")
    expect(text).not.toContain("no run journal")
  })
})
