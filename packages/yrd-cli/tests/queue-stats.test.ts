/**
 * @failure  A retro or a status page that asks seats for numbers the queue
 *           already holds gets twelve hand counts that disagree. The queue's
 *           stats command must reproduce a captured queue exactly, and its
 *           definitions must be the STATS pane's, or the two surfaces argue.
 * @consumer the operator's retro (2026-09-04 23:2x PDT: "seeing pushed and how
 *           many re-pushed etc would be useful stats") · pm-metrics
 *           (@hh/tooling/pm-metrics), which composes this with the STATE log
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Row, WatchRow } from "@yrd/queue-core"
import {
  decisionsOfRows,
  formatQueueStats,
  parseSince,
  queueStats,
  sinceLine,
  type PushedRef,
} from "../src/queue-stats.ts"
import { statsBuckets } from "../src/watch-stats.ts"

/** The live /hh queue as `yrd queue list --json` printed it at 2026-09-05 06:36Z: 146 rows. */
const FIXTURE = join(import.meta.dirname, "fixtures/queue-list-2026-09-05T0636Z.json")

type JsonRow = Readonly<Record<string, unknown>>

/** A `--json` row back into the Row the reader takes: the four instants become Dates, everything else is as printed. */
function rowOf(json: JsonRow): Row {
  const date = (key: string): Date | undefined => {
    const value = json[key]
    return typeof value === "string" ? new Date(value) : undefined
  }
  const text = (key: string): string | undefined => (typeof json[key] === "string" ? (json[key] as string) : undefined)
  const state = json["state"] as Row["state"]
  const row: Record<string, unknown> = { branch: text("branch"), head: text("head"), state }
  for (const key of ["result", "log", "issue", "submitter", "reason", "merge", "base", "subject", "run"] as const) {
    const value = text(key)
    if (value !== undefined) row[key] = value
  }
  for (const key of ["since", "at", "startedAt", "endedAt"] as const) {
    const value = date(key)
    if (value !== undefined) row[key] = value
  }
  return row as Row
}

function fixtureRows(): readonly WatchRow[] {
  const parsed = JSON.parse(readFileSync(FIXTURE, "utf8")) as { changes: readonly JsonRow[] }
  return parsed.changes.map((json) => ({ row: rowOf(json) }))
}

const NOW = new Date("2026-09-05T06:36:00.000Z")

function row(over: Partial<Row> & Pick<Row, "branch" | "head" | "state">): WatchRow {
  return { row: { submitter: "@dev/1", ...over } }
}

describe("queue stats on the captured queue (146 rows)", () => {
  it("reproduces the queue's numbers exactly, with the pane's own definitions", () => {
    const rows = fixtureRows()
    const stats = queueStats(rows, [], { now: NOW })

    expect(rows).toHaveLength(146)
    expect(stats.total.rows).toBe(146)
    // 82 rows merged: 77 merges and 5 duplicates (merged records that merged nothing), as the STATS pane splits them.
    expect(stats.total.merged).toBe(77)
    expect(stats.total.duplicates).toBe(5)
    expect(stats.total.failed).toBe(64)
    expect(stats.total.stuck).toBe(0)
    expect(stats.total.changes).toBe(96)
    expect(stats.total.sameHeadRetries).toBe(50)
    expect(stats.total.branches).toBe(70)
    expect(stats.total.rePushedBranches).toBe(14)
    // Opened → merged, over the 51 merged changes that carry both instants (computed apart, in Python, from the same file).
    expect(stats.total.latency.count).toBe(51)
    expect(Math.round(stats.total.latency.medianMs ?? 0)).toBe(1_093_106)
    expect(Math.round(stats.total.latency.p90Ms ?? 0)).toBe(3_293_275)
  })

  it("groups by submitter, most rows first, and the groups sum to the queue", () => {
    const stats = queueStats(fixtureRows(), [], { now: NOW })
    expect(stats.by).toBe("submitter")
    expect(stats.groups).toHaveLength(12)
    expect(stats.groups[0]?.key).toBe("@dev/6")
    expect(stats.groups[0]?.rows).toBe(39)
    const summed = stats.groups.reduce((total, group) => total + group.rows, 0)
    expect(summed).toBe(146)
    const merged = stats.groups.reduce((total, group) => total + group.merged + group.duplicates, 0)
    expect(merged).toBe(82)
  })

  it("groups by branch on request", () => {
    const stats = queueStats(fixtureRows(), [], { by: "branch", now: NOW })
    expect(stats.by).toBe("branch")
    expect(stats.groups).toHaveLength(70)
    for (const group of stats.groups) expect(group.branches).toBe(1)
  })

  it("counts the same decisions the STATS pane would count from these rows", () => {
    const decisions = decisionsOfRows(fixtureRows())
    const [today] = statsBuckets(decisions, NOW)
    const stats = queueStats(fixtureRows(), [], { now: NOW })
    // Today's bucket (local day of NOW) and the whole-queue count agree wherever both count: no second computation.
    expect(decisions).toHaveLength(146)
    expect(today?.merges).toBeLessThanOrEqual(stats.total.merged)
    expect(decisions.filter((decision) => decision.decision === "merged" && !decision.duplicate)).toHaveLength(77)
    expect(decisions.filter((decision) => decision.duplicate)).toHaveLength(5)
  })

  it("renders one table that carries every definition it uses", () => {
    const text = formatQueueStats(queueStats(fixtureRows(), [], { now: NOW }), "github.com/beorn/hh-dev#main")
    const lines = text.split("\n")
    expect(lines[0]).toContain("github.com/beorn/hh-dev#main")
    expect(lines[0]).toContain("since 2026-08-29T06:36:00.000Z (the default seven days, the read's own horizon)")
    expect(lines[1]).toMatch(
      /^\s+ROWS\s+MERGED\s+DUP\s+FAILED\s+STUCK\s+CHANGES\s+RETRIES\s+BRANCHES\s+RE-PUSHED\s+RE-PUSHES\s+MEDIAN\s+P90$/u,
    )
    expect(lines[2]).toMatch(/^queue\s+146\s+77\s+5\s+64\s+0\s+96\s+50\s+70\s+14\s+\d+\s+18:13\s+54:53$/u)
    expect(lines[3]).toMatch(/^@dev\/6\s+39\b/u)
    expect(text).toContain("pushed, never submitted: 0")
    expect(text).toContain("RETRIES = rows beyond the first for one branch@head")
  })
})

describe("the window and the pushed refs", () => {
  const rows: WatchRow[] = [
    row({
      at: new Date("2026-09-05T05:00:00Z"),
      branch: "task/a",
      head: "1".repeat(40),
      since: new Date("2026-09-05T04:00:00Z"),
      state: "merged",
      merge: "9".repeat(40),
    }),
    row({
      at: new Date("2026-09-05T02:00:00Z"),
      branch: "task/a",
      head: "1".repeat(40),
      state: "failed",
      result: "fail typecheck",
    }),
    row({
      at: new Date("2026-09-04T20:00:00Z"),
      branch: "task/b",
      head: "2".repeat(40),
      state: "failed",
      submitter: "@dev/2",
    }),
    row({ branch: "task/c", head: "3".repeat(40), position: 1, state: "queued" }),
  ]

  it("keeps only the decisions at or after --since, and a queued row decides nothing", () => {
    const all = queueStats(rows, [], { now: NOW })
    expect(all.total.rows).toBe(4)
    expect(all.total.merged).toBe(1)
    expect(all.total.failed).toBe(2)
    expect(all.total.sameHeadRetries).toBe(1)
    expect(decisionsOfRows(rows)).toHaveLength(3)

    expect(all.defaultWindow).toBe(true)
    expect(all.since.toISOString()).toBe("2026-08-29T06:36:00.000Z")

    const asked = parseSince("3h", NOW)
    const recent = queueStats(rows, [], {
      now: NOW,
      since: asked?.at,
      sinceFrom: { asked: "3h", kind: asked?.kind ?? "instant" },
    })
    expect(recent.defaultWindow).toBe(false)
    expect(recent.since.toISOString()).toBe("2026-09-05T03:36:00.000Z")
    expect(recent.sinceFrom).toEqual({ asked: "3h", kind: "duration" })
    expect(sinceLine(recent)).toBe(
      "SINCE = 2026-09-05T03:36:00.000Z, from --since 3h (a duration back from 2026-09-05T06:36:00.000Z)",
    )
    expect(sinceLine(all)).toBe(
      "SINCE = 2026-08-29T06:36:00.000Z, the default seven days back from 2026-09-05T06:36:00.000Z (the read's own horizon)",
    )
    // The merged row inside the window, plus the queued row: still in line, so always in view.
    expect(recent.total.rows).toBe(2)
    expect(recent.total.merged).toBe(1)
    expect(recent.total.failed).toBe(0)
    expect(recent.total.latency.count).toBe(1)
    expect(recent.total.latency.medianMs).toBe(3_600_000)
  })

  it("parses 3h, 45m, 2d, 1w and an instant; refuses the rest", () => {
    expect(parseSince("45m", NOW)).toEqual({ at: new Date("2026-09-05T05:51:00.000Z"), kind: "duration" })
    expect(parseSince("2d", NOW)).toEqual({ at: new Date("2026-09-03T06:36:00.000Z"), kind: "duration" })
    expect(parseSince("1w", NOW)).toEqual({ at: new Date("2026-08-29T06:36:00.000Z"), kind: "duration" })
    expect(parseSince("2026-09-01T00:00:00Z", NOW)).toEqual({
      at: new Date("2026-09-01T00:00:00.000Z"),
      kind: "instant",
    })
    expect(parseSince("yesterday-ish", NOW)).toBeUndefined()
    // A commit's window is said as the commit's committer date, so a reader can rederive it with `git log -1 --format=%ct`.
    const byCommit = queueStats([], [], {
      now: NOW,
      since: new Date("2026-09-04T12:00:00Z"),
      sinceFrom: { asked: "main", kind: "commit" },
    })
    expect(sinceLine(byCommit)).toBe(
      "SINCE = 2026-09-04T12:00:00.000Z, from --since main (that commit's committer date)",
    )
    expect(formatQueueStats(byCommit, "q").split("\n").at(-1)).toContain(
      "from --since main (that commit's committer date)",
    )
  })

  it("counts refs pushed and never submitted inside the window, oldest first, and says how many it could not date", () => {
    const refs: PushedRef[] = [
      { branch: "task/a", committedAt: new Date("2026-09-05T04:00:00Z"), head: "1".repeat(40), submitted: true },
      {
        branch: "task/pushed-only",
        committedAt: new Date("2026-09-05T01:36:00Z"),
        head: "4".repeat(40),
        submitted: false,
      },
      {
        branch: "task/pushed-later",
        committedAt: new Date("2026-09-05T06:00:00Z"),
        head: "5".repeat(40),
        submitted: false,
      },
      {
        branch: "task/pushed-long-ago",
        committedAt: new Date("2026-08-01T00:00:00Z"),
        head: "6".repeat(40),
        submitted: false,
      },
      { branch: "task/never-fetched", head: "7".repeat(40), submitted: false },
    ]
    const stats = queueStats(rows, refs, { now: NOW, since: parseSince("1d", NOW)?.at })
    expect(stats.pushedNeverSubmitted.count).toBe(2)
    expect(stats.pushedNeverSubmitted.oldestAgeMs).toBe(5 * 3_600_000)
    expect(stats.pushedNeverSubmitted.ageUnknown).toBe(1)
    expect(stats.pushedNeverSubmitted.refs.map((ref) => ref.branch)).toEqual([
      "task/pushed-only",
      "task/pushed-later",
      "task/never-fetched",
    ])
    const text = formatQueueStats(stats, "q")
    expect(text).toContain(
      "pushed, never submitted: 2 (oldest 5h00m ago); 1 more whose tip is not fetched here, age unknown",
    )
  })
})
