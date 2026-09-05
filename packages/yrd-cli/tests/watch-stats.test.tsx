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
import type { Journals } from "@yrd/queue-core"
import { StatsBox, statsHoursFor } from "../src/watch-boxes.tsx"
import { NowContext } from "../src/watch-clock.ts"
import { countCell, decisionsOf, isDuplicateMerge, statsBuckets, type RunDecision } from "../src/watch-stats.ts"

// A local instant: 14:30 on a Thursday, so yesterday and a midnight both fall inside 24 hours.
const NOW = new Date(2026, 8, 3, 14, 30, 0)

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
    const [today, yesterday, ...hours] = statsBuckets(decisions, NOW, 24)
    expect(today).toMatchObject({ duplicates: 1, fails: 1, merges: 1, runs: 2, stuck: 0 })
    // 20 hours before 14:30 is 18:30 yesterday; 30 hours before is 08:30 yesterday.
    expect(yesterday).toMatchObject({ duplicates: 0, fails: 0, merges: 1, runs: 2, stuck: 1 })
    expect(hours[0]).toMatchObject({ fails: 1, merges: 1, runs: 1 })
    expect(hours[2]).toMatchObject({ duplicates: 1, merges: 0 })
    expect(countCell(hours[1]!, "merges")).toBe("·")
    expect(countCell(today!, "merges")).toBe("1")
  })
})

describe("the duplicate predicate and the flattening", () => {
  it("names a merged decision with no merge commit and the already-on-target reason a duplicate, and nothing else", () => {
    expect(isDuplicateMerge({ decision: "merged", reason: "already on the target" })).toBe(true)
    expect(isDuplicateMerge({ decision: "merged", merge: "b".repeat(40), reason: "already on the target" })).toBe(false)
    expect(isDuplicateMerge({ decision: "failed", reason: "already on the target" })).toBe(false)
    expect(isDuplicateMerge({ decision: "merged" })).toBe(false)
  })

  it("flattens every run's decision out of the journals and skips runs that decided nothing", () => {
    const run = (id: string, decision?: string, reason?: string) => ({
      at: NOW,
      branch: "task/one",
      checks: [],
      head: "a".repeat(40),
      id,
      startedAt: NOW,
      ...(decision === undefined ? {} : { decision }),
      ...(reason === undefined ? {} : { reason }),
    })
    const journals: Journals = {
      dir: "/w/logs",
      runs: new Map([
        ["task/one@a", [run("r1", "merged"), run("r2")]],
        ["task/two@b", [run("r3", "merged", "already on the target"), run("r4", "failed")]],
      ]),
    }
    expect(decisionsOf(journals).map((decision) => [decision.run, decision.decision, decision.duplicate])).toEqual([
      ["r1", "merged", false],
      ["r3", "merged", true],
      ["r4", "failed", false],
    ])
  })
})

describe("the STATS box", () => {
  async function paint(decisions: readonly RunDecision[], cols: number, absent?: string): Promise<string> {
    const app = render(
      <NowContext.Provider value={NOW}>
        <StatsBox decisions={decisions} columns={cols - 2} {...(absent === undefined ? {} : { absent })} />
      </NowContext.Provider>,
      { cols, rows: 12 },
    )
    await app.waitForLayoutStable()
    const text = app.text
    app.unmount()
    return text
  }

  it("prints YSTRDAY, right-aligns every number, keeps DUP muted just above FAILS, and runs the midnight rule as its own column", async () => {
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
    const rows = ["MERGES", "DUP", "FAILS", "STUCK", "RUNS"].map((label) =>
      lines.findIndex((line) => line.includes(label)),
    )
    // In order, DUP directly above FAILS.
    expect(rows).toEqual([...rows].sort((left, right) => left - right))
    expect(rows[2]).toBe(rows[1]! + 1)
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

  it("says where the journals were looked for when there is nothing to count", async () => {
    const text = await paint([], 100, "no run journal was read: /w/logs — there is no such directory")
    expect(text).toContain("/w/logs")
    expect(text).toContain("MERGES")
  })
})
