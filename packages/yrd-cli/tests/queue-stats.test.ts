/**
 * @failure  A retro or a status page that asks seats for numbers the queue
 *           already holds gets twelve hand counts that disagree. The stats
 *           command's definitions must be the STATS pane's, and its counts
 *           must survive the one fact that fooled the first cut: a per-run row
 *           carries the CHANGE's current state, so counting `state` per row
 *           counts a change once per run that touched it.
 * @consumer the operator's retro (2026-09-04 23:2x PDT: "seeing pushed and how
 *           many re-pushed etc would be useful stats") · pm-metrics
 *           (@hh/tooling/pm-metrics), which composes this with the STATE log
 *
 * Two witnesses. The compact one is synthetic: one head with three runs, a
 * branch re-pushed with two heads, a head merged by ancestry, a queued row;
 * its expected counts are written by hand and a pre-fix reader is shown to
 * get them wrong. The real one is eighteen rows cut from the live /hh queue at
 * 2026-09-05 06:36Z (provenance: the whole 146-row read, sha256 bf41690b…,
 * kept in scratch, its numbers in commit a80f035a's message), retained for the
 * cases a synthetic set did not think of: a replaced head the target carries
 * by its successor (state merged, last verdict failed), a stuck run whose
 * result is an incident sentence, and runs that recorded no decision.
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
  type StatsGroup,
} from "../src/queue-stats.ts"
import { statsBuckets } from "../src/watch-stats.ts"

/** Eighteen rows of the live /hh queue as `yrd queue list --json` printed them at 2026-09-05 06:36Z: five branches, eight heads. */
const WITNESS = join(import.meta.dirname, "fixtures/queue-list-witness-2026-09-05T0636Z.json")

type JsonRow = Readonly<Record<string, unknown>>

/** A `--json` row back into the Row the reader takes: the instants become Dates, everything else is as printed. */
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
  if (typeof json["position"] === "number") row["position"] = json["position"]
  return row as Row
}

function witnessRows(): readonly WatchRow[] {
  const parsed = JSON.parse(readFileSync(WITNESS, "utf8")) as { changes: readonly JsonRow[] }
  return parsed.changes.map((json) => ({ row: rowOf(json) }))
}

const NOW = new Date("2026-09-05T06:36:00.000Z")
const at = (iso: string): Date => new Date(iso)

function row(over: Partial<Row> & Pick<Row, "branch" | "head" | "state">): WatchRow {
  return { row: { submitter: "@dev/1", ...over } }
}

/**
 * The compact witness: what one queue day looks like in miniature.
 * - task/a@1: three runs — failed typecheck, passed but did not merge (the
 *   target moved), merged; the change is merged, its rows are three.
 * - task/b: re-pushed — head 2 replaced by head 3, which merged.
 * - task/c@4: merged by ancestry (already on the target), no merge commit.
 * - task/d@5: queued, no verdict yet.
 */
const COMPACT: readonly WatchRow[] = [
  row({
    at: at("2026-09-05T02:00:00Z"),
    branch: "task/a",
    head: "1".repeat(40),
    state: "merged",
    result: "fail typecheck",
    endedAt: at("2026-09-05T02:00:00Z"),
    since: at("2026-09-05T01:00:00Z"),
  }),
  row({
    at: at("2026-09-05T03:00:00Z"),
    branch: "task/a",
    head: "1".repeat(40),
    state: "merged",
    result: "pass affected-tests",
    endedAt: at("2026-09-05T03:00:00Z"),
    since: at("2026-09-05T01:00:00Z"),
  }),
  row({
    at: at("2026-09-05T05:00:00Z"),
    branch: "task/a",
    head: "1".repeat(40),
    state: "merged",
    result: "pass affected-tests",
    merge: "9".repeat(40),
    endedAt: at("2026-09-05T05:00:00Z"),
    since: at("2026-09-05T01:00:00Z"),
  }),
  row({
    at: at("2026-09-04T20:00:00Z"),
    branch: "task/b",
    head: "2".repeat(40),
    state: "failed",
    result: "fail",
    reason: "replaced",
    endedAt: at("2026-09-04T20:00:00Z"),
    submitter: "@dev/2",
  }),
  row({
    at: at("2026-09-04T22:00:00Z"),
    branch: "task/b",
    head: "3".repeat(40),
    state: "merged",
    result: "pass affected-tests",
    merge: "8".repeat(40),
    endedAt: at("2026-09-04T22:00:00Z"),
    since: at("2026-09-04T20:30:00Z"),
    submitter: "@dev/2",
  }),
  row({
    at: at("2026-09-05T04:00:00Z"),
    branch: "task/c",
    head: "4".repeat(40),
    state: "merged",
    result: "pass",
    reason: "already on the target",
    endedAt: at("2026-09-05T04:00:00Z"),
    since: at("2026-09-05T03:30:00Z"),
  }),
  row({ branch: "task/d", head: "5".repeat(40), position: 1, state: "queued", since: at("2026-09-05T06:00:00Z") }),
]

/** The first cut's rule, kept here as the mutation the witness must catch: a change's state, counted once per row. */
function stateOnlyMerged(rows: readonly WatchRow[]): number {
  return rows.filter(({ row: r }) => r.state === "merged" && r.reason !== "already on the target").length
}

describe("the compact witness: one queue day in seven rows", () => {
  it("counts changes by the queue's state and verdicts per run, and the state-per-row rule gets it wrong", () => {
    const stats = queueStats(COMPACT, [], { now: NOW })
    expect(stats.total.rows).toBe(7)
    expect(stats.total.changes).toBe(5)
    // By state: task/a, task/b@3, task/c merged (task/c by ancestry), task/b@2 failed (replaced), task/d in line.
    expect(stats.total).toMatchObject({ byAncestry: 1, failed: 1, inLine: 1, merged: 3, stuck: 0 })
    // Per run: task/a failed once, passed once without merging (checked), merged once; task/b failed once and
    // merged once; task/c's merge merged nothing; task/d decided nothing yet.
    expect(stats.total.decisions).toEqual({
      checked: 1,
      duplicates: 1,
      failed: 2,
      merged: 2,
      stuck: 0,
      unclassified: 0,
    })
    expect(decisionsOfRows(COMPACT)).toHaveLength(6)
    // Retries: task/a's two extra runs. Re-pushed: task/b, once.
    expect(stats.total).toMatchObject({ branches: 4, rePushedBranches: 1, rePushes: 1, sameHeadRetries: 2 })
    // Latency over the two changes a run merged: task/a 4h, task/b@3 1h30m.
    expect(stats.total.latency).toEqual({ count: 2, medianMs: 5_400_000, p90Ms: 14_400_000 })
    // The mutation: the first cut counted `state` per row and called this queue four merges for three.
    expect(stateOnlyMerged(COMPACT)).toBe(4)
    expect(stats.total.merged).toBe(3)
  })

  it("groups by submitter and by branch, and the groups sum to the queue", () => {
    const bySubmitter = queueStats(COMPACT, [], { now: NOW })
    expect(bySubmitter.groups.map((group) => [group.key, group.rows])).toEqual([
      ["@dev/1", 5],
      ["@dev/2", 2],
    ])
    expect(bySubmitter.groups[1]).toMatchObject({ changes: 2, failed: 1, merged: 1, rePushedBranches: 1 })
    const byBranch = queueStats(COMPACT, [], { by: "branch", now: NOW })
    expect(byBranch.groups.map((group) => group.key)).toEqual(["task/a", "task/b", "task/c", "task/d"])
    for (const group of byBranch.groups) expect(group.branches).toBe(1)
    const sum = (key: keyof Pick<StatsGroup, "rows" | "changes" | "merged" | "failed">) =>
      byBranch.groups.reduce((total, group) => total + group[key], 0)
    expect([sum("rows"), sum("changes"), sum("merged"), sum("failed")]).toEqual([7, 5, 3, 1])
  })
})

describe("the real witness: eighteen rows of the live queue", () => {
  it("reproduces the counts computed apart from the same file, in Python", () => {
    const rows = witnessRows()
    const stats = queueStats(rows, [], { now: NOW })
    expect(rows).toHaveLength(18)
    // Eight heads on five branches: seven merged — four of them by ancestry: one already on the target,
    // three replaced heads whose successors landed — and one failed. Nothing stuck or in line.
    expect(stats.total).toMatchObject({
      byAncestry: 4,
      changes: 8,
      failed: 1,
      inLine: 0,
      merged: 7,
      rows: 18,
      stuck: 0,
    })
    // Verdicts per run: 3 merges, 1 duplicate, 5 failed (three of them `replaced`), 2 stuck runs whose
    // result is an incident sentence; 7 rows are runs that recorded no decision.
    expect(stats.total.decisions).toEqual({
      checked: 0,
      duplicates: 1,
      failed: 5,
      merged: 3,
      stuck: 2,
      unclassified: 0,
    })
    expect(decisionsOfRows(rows)).toHaveLength(11)
    expect(stats.total).toMatchObject({ branches: 5, rePushedBranches: 2, rePushes: 3, sameHeadRetries: 10 })
    expect(stats.total.latency.count).toBe(3)
    expect(Math.round(stats.total.latency.medianMs ?? 0)).toBe(1_463_826)
    expect(Math.round(stats.total.latency.p90Ms ?? 0)).toBe(3_281_115)
  })

  it("orders equal groups by name and renders one table that carries every definition it uses", () => {
    const stats = queueStats(witnessRows(), [], { now: NOW })
    expect(stats.groups.map((group) => [group.key, group.rows])).toEqual([
      ["@chief", 6],
      ["@dev/10", 6],
      ["@dev/6", 6],
    ])
    const text = formatQueueStats(stats, "github.com/beorn/hh-dev#main")
    const lines = text.split("\n")
    expect(lines[0]).toContain("github.com/beorn/hh-dev#main")
    expect(lines[0]).toContain("since 2026-08-29T06:36:00.000Z (the default seven days, the read's own horizon)")
    expect(lines[1]).toMatch(
      /^\s+ROWS\s+CHANGES\s+MERGED\s+ANCESTRY\s+FAILED\s+STUCK\s+IN LINE\s+RETRIES\s+BRANCHES\s+RE-PUSHED\s+RE-PUSHES\s+MEDIAN\s+P90$/u,
    )
    expect(lines[2]).toMatch(/^queue\s+18\s+8\s+7\s+4\s+1\s+0\s+0\s+10\s+5\s+2\s+3\s+24:24\s+54:41$/u)
    expect(lines[3]).toMatch(/^@chief\s+6\b/u)
    expect(text).toContain("pushed, never submitted: 0")
    expect(text).toContain("verdicts per run: 3 merged, 1 dup, 5 failed, 2 stuck, 0 checked (the STATS pane's numbers)")
    expect(text).toContain("RETRIES = rows beyond the first for one branch@head")
  })

  it("feeds the STATS pane the same decisions the command counts: one reader, one classification", () => {
    const rows = witnessRows()
    const decisions = decisionsOfRows(rows)
    const buckets = statsBuckets(decisions, NOW, 24 * 7)
    const hours = buckets.filter((bucket) => bucket.kind === "hour")
    const merges = hours.reduce((total, bucket) => total + bucket.merges, 0)
    const fails = hours.reduce((total, bucket) => total + bucket.fails, 0)
    const stats = queueStats(rows, [], { now: NOW })
    expect(merges).toBe(stats.total.decisions.merged)
    expect(fails).toBe(stats.total.decisions.failed)
  })
})

describe("a verdict the reader cannot name (@cto 0686be28)", () => {
  it("counts an unknown result sentence apart as unclassified, never as stuck, and says so on the definitions line", () => {
    const rows: readonly WatchRow[] = [
      // A stuck run's incident: the sentence runRow writes as `<code>: …` with the code in `reason`.
      row({
        at: at("2026-09-05T02:00:00Z"),
        branch: "task/x",
        head: "1".repeat(40),
        state: "merged",
        result: "yrd-setup-unusable: the queue could not prepare a worktree for task/x; next: repair the queue setup",
        reason: "yrd-setup-unusable",
        endedAt: at("2026-09-05T02:00:00Z"),
      }),
      // A sentence this reader does not know: a future vocabulary, or a record it never learned.
      row({
        at: at("2026-09-05T03:00:00Z"),
        branch: "task/y",
        head: "2".repeat(40),
        state: "failed",
        result: "quarantined by the operator",
        endedAt: at("2026-09-05T03:00:00Z"),
      }),
      // A journal run whose decision is a word this reader does not know.
      {
        row: { at: at("2026-09-05T04:00:00Z"), branch: "task/z", head: "3".repeat(40), state: "failed" },
        run: {
          at: at("2026-09-05T04:00:00Z"),
          branch: "task/z",
          checks: [],
          decision: "deferred",
          head: "3".repeat(40),
          id: "q-9",
          startedAt: at("2026-09-05T03:50:00Z"),
        },
      },
    ]
    const stats = queueStats(rows, [], { now: NOW })
    expect(stats.total.decisions).toEqual({
      checked: 0,
      duplicates: 0,
      failed: 0,
      merged: 0,
      stuck: 1,
      unclassified: 2,
    })
    expect(decisionsOfRows(rows).map((decision) => decision.decision)).toEqual(["stuck"])
    // The changes still count by the queue's own state; only the run verdicts are unnamed.
    expect(stats.total).toMatchObject({ changes: 3, failed: 2, merged: 1 })
    const text = formatQueueStats(stats, "q")
    expect(text).toContain(
      "0 checked (the STATS pane's numbers), 2 UNCLASSIFIED (a result vocabulary this reader does not know; never counted as stuck)",
    )
    // And a queue with nothing unnamed does not mention it.
    expect(formatQueueStats(queueStats(COMPACT, [], { now: NOW }), "q")).not.toContain("UNCLASSIFIED")
  })
})

describe("the window and the pushed refs", () => {
  it("keeps only the decisions at or after --since, keeps rows still in line, and names the window's origin", () => {
    const all = queueStats(COMPACT, [], { now: NOW })
    expect(all.defaultWindow).toBe(true)
    expect(all.since.toISOString()).toBe("2026-08-29T06:36:00.000Z")
    expect(sinceLine(all)).toBe(
      "SINCE = 2026-08-29T06:36:00.000Z, the default seven days back from 2026-09-05T06:36:00.000Z (the read's own horizon)",
    )

    const asked = parseSince("3h", NOW)
    const recent = queueStats(COMPACT, [], {
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
    // task/a's merging run and task/c's ancestry merge are inside; task/d is in line, so always in view.
    expect(recent.total.rows).toBe(3)
    expect(recent.total).toMatchObject({ byAncestry: 1, changes: 3, inLine: 1, merged: 2 })
    expect(recent.total.decisions).toEqual({
      checked: 0,
      duplicates: 1,
      failed: 0,
      merged: 1,
      stuck: 0,
      unclassified: 0,
    })
    expect(recent.total.latency).toEqual({ count: 1, medianMs: 14_400_000, p90Ms: 14_400_000 })
  })

  it("parses 3h, 45m, 2d, 1w and an instant; refuses the rest; says a commit's window as its committer date", () => {
    expect(parseSince("45m", NOW)).toEqual({ at: new Date("2026-09-05T05:51:00.000Z"), kind: "duration" })
    expect(parseSince("2d", NOW)).toEqual({ at: new Date("2026-09-03T06:36:00.000Z"), kind: "duration" })
    expect(parseSince("1w", NOW)).toEqual({ at: new Date("2026-08-29T06:36:00.000Z"), kind: "duration" })
    expect(parseSince("2026-09-01T00:00:00Z", NOW)).toEqual({
      at: new Date("2026-09-01T00:00:00.000Z"),
      kind: "instant",
    })
    expect(parseSince("yesterday-ish", NOW)).toBeUndefined()
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
      { branch: "task/a", committedAt: at("2026-09-05T04:00:00Z"), head: "1".repeat(40), submitted: true },
      { branch: "task/pushed-only", committedAt: at("2026-09-05T01:36:00Z"), head: "4".repeat(40), submitted: false },
      { branch: "task/pushed-later", committedAt: at("2026-09-05T06:00:00Z"), head: "5".repeat(40), submitted: false },
      {
        branch: "task/pushed-long-ago",
        committedAt: at("2026-08-01T00:00:00Z"),
        head: "6".repeat(40),
        submitted: false,
      },
      { branch: "task/never-fetched", head: "7".repeat(40), submitted: false },
    ]
    const stats = queueStats(COMPACT, refs, { now: NOW, since: parseSince("1d", NOW)?.at })
    expect(stats.pushedNeverSubmitted.count).toBe(2)
    expect(stats.pushedNeverSubmitted.ageBasis).toBe("tip committer date")
    expect(stats.pushedNeverSubmitted.oldestCommitAgeMs).toBe(5 * 3_600_000)
    expect(stats.pushedNeverSubmitted.refs[0]?.commitAgeMs).toBe(5 * 3_600_000)
    expect(stats.pushedNeverSubmitted.ageUnknown).toBe(1)
    expect(stats.pushedNeverSubmitted.refs.map((ref) => ref.branch)).toEqual([
      "task/pushed-only",
      "task/pushed-later",
      "task/never-fetched",
    ])
    const text = formatQueueStats(stats, "q")
    expect(text).toContain(
      "pushed, never submitted: 2 (oldest tip committed 5h00m ago; ages are tip committer dates, not push times); 1 more whose tip is not fetched here, age unknown",
    )
  })
})
