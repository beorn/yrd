/**
 * `yrd queue stats` — the queue's own numbers, from the rows `queue list`
 * already reads (@i/10-yrd/24164): merged, failed, same-head retries, branches
 * re-pushed with a new head, refs pushed and never submitted, and the
 * submit-to-merge latency, for the whole queue and per submitter or branch.
 *
 * Pure. One row is what one queue run said about one change (the default,
 * per-run lens of `queue list`); a decision is classified by the STATS pane's
 * own reader, {@link decisionsOfRows} in watch-stats.ts — one source and one
 * classification — so the two surfaces can never disagree about what a merge
 * or a failure is. Nothing here opens a file or talks to git: the caller reads
 * the rows and the remote's branch list and hands both in, with the moment `now`.
 *
 * Definitions, because a number nobody can derive is a number nobody trusts:
 * - a row is what ONE run said about one change; its verdict is read by the
 *   pane's own `rowDecision` (or the journal run's decision when the row was
 *   split by one). `decisions` counts those verdicts per run — the STATS
 *   pane's numbers, replaced heads counted as the failed verdicts the queue
 *   recorded for them.
 * - merged / byAncestry / failed / stuck / inLine count CHANGES (distinct
 *   `branch@head`) by the queue's own current state, the one `queue list`
 *   shows: merged includes a head the target carries by ancestry (a replaced
 *   head whose successor landed, or one already on the target), and
 *   byAncestry says how many of the merged had no merging run of their own.
 * - same-head retries: rows beyond the first for one `branch@head` — a resubmit
 *   of the same head, or the queue judging it again on a moved target; the
 *   records name both as runs and so does this.
 * - re-pushed branches: branches with more than one distinct head in the rows;
 *   `rePushes` is the number of heads beyond the first, summed.
 * - pushed, never submitted: branches at the remote that no change ref names —
 *   a push without a `yrd submit` (plan E2) — restricted to the window by the
 *   tip's committer date when the commit is here, and counted apart as
 *   `ageUnknown` when it is not (a tip nobody fetched has no date to read).
 *   Every age is a COMMIT age (`ageBasis`): git records no push time, so a
 *   commit age is a lower bound on how long the push has waited, never the
 *   waiting time itself.
 * - latency: per merged change (its last merged row), from the change's
 *   `since` (opened) to that row's `at` (merged); median and p90 over them.
 * - the window: a row is inside when its decision (`at`) is at or after
 *   `since`, or when it has none yet (still in line); a pushed ref when its
 *   tip's committer date is. Absent `since`, the read's own seven-day horizon.
 */

import type { Row, WatchRow } from "@yrd/queue-core"
import { decisionsOfRows, unclassifiedRows } from "./watch-stats.ts"

export { decisionsOfRows } from "./watch-stats.ts"

/** One branch at the remote, as `ls-remote` lists it, with the tip's committer date when the commit is here. */
export type PushedRef = Readonly<{
  branch: string
  head: string
  /** The tip's committer date; absent when the object is not in this repository. */
  committedAt?: Date
  /** True when a change ref `refs/yrd/changes/<branch>@*` names the branch: it was submitted at least once. */
  submitted: boolean
}>

export type StatsBy = "submitter" | "branch"

/** How the window's start was arrived at, so a reader can rederive it: what was asked, and what kind of thing it was. */
export type SinceOrigin = Readonly<{
  /** The `--since` text as given; absent for the default window. */
  asked?: string
  /** `duration` back from `now`, an `instant` as written, a `commit`'s committer date, or the `default` seven days. */
  kind: "duration" | "instant" | "commit" | "default"
}>

export type QueueStatsOptions = Readonly<{
  now: Date
  /** Rows whose decision is before this instant, and refs whose tip is older, are outside the window; absent, {@link DEFAULT_WINDOW_MS} back from `now`. */
  since?: Date
  /** Where `since` came from; the default when `since` is absent. */
  sinceFrom?: SinceOrigin
  by?: StatsBy
}>

/** The default window: the queue read's own horizon for ended changes (seven days), so the stats and the list agree on what is in view. */
export const DEFAULT_WINDOW_MS = 7 * 86_400_000

export type LatencyStats = Readonly<{
  /** How many merged changes had both an opening and a merging instant. */
  count: number
  medianMs?: number
  p90Ms?: number
}>

/** Verdicts counted per run — what the STATS pane counts, over the same rows; `unclassified` is what neither could name. */
export type DecisionCounts = Readonly<{
  merged: number
  duplicates: number
  failed: number
  stuck: number
  checked: number
  /** Rows that recorded a verdict this reader cannot name: a result vocabulary it does not know. Never folded into stuck. */
  unclassified: number
}>

export type StatsGroup = Readonly<{
  /** `queue` for the whole queue; otherwise the submitter or the branch. */
  key: string
  rows: number
  /** Distinct `branch@head` among the rows. */
  changes: number
  /** Changes in state merged: on the target, by a merge of their own or by ancestry. */
  merged: number
  /** Of the merged, those no run merged: the target carries them by ancestry (replaced, or already there). */
  byAncestry: number
  /** Changes in state failed. */
  failed: number
  /** Changes in state stuck. */
  stuck: number
  /** Changes still in line: queued or checked. */
  inLine: number
  /** The same rows' verdicts counted per run: the STATS pane's numbers. */
  decisions: DecisionCounts
  sameHeadRetries: number
  branches: number
  rePushedBranches: number
  rePushes: number
  latency: LatencyStats
}>

/** What every age here is measured from: git records no push time, so the tip's committer date stands in. */
export const PUSH_AGE_BASIS = "tip committer date"

export type PushedNeverSubmitted = Readonly<{
  /** The basis of every age in this object — {@link PUSH_AGE_BASIS} — said in the document, not assumed by the reader. */
  ageBasis: typeof PUSH_AGE_BASIS
  count: number
  /** The oldest tip in the window: `now` minus its committer date, in ms. Not a waiting time since the push. */
  oldestCommitAgeMs?: number
  /** Branches at the remote with no change ref whose tip could not be dated here. */
  ageUnknown: number
  /** Oldest first; complete, so `--json` to a file is the whole answer. */
  refs: readonly Readonly<{ branch: string; head: string; commitAgeMs?: number }>[]
}>

export type QueueStats = Readonly<{
  at: Date
  /** The window's start, resolved to one instant. */
  since: Date
  /** How `since` was arrived at: the text asked and its kind, so the window can be rederived. */
  sinceFrom: SinceOrigin
  /** True when nobody asked for a window and the seven-day default stands. */
  defaultWindow: boolean
  by: StatsBy
  /** The whole queue in the window; its `key` is `queue`. */
  total: StatsGroup
  groups: readonly StatsGroup[]
  pushedNeverSubmitted: PushedNeverSubmitted
}>

function inWindow(at: Date | undefined, since: Date | undefined): boolean {
  if (since === undefined) return true
  return at !== undefined && at.getTime() >= since.getTime()
}

/** The p-th percentile by nearest rank over a sorted list; undefined for an empty one. */
function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

function latencyOf(rows: readonly WatchRow[]): LatencyStats {
  // One latency per merged CHANGE: from its opening to the row whose run merged it (a head merges once).
  const merging = new Map<string, Row>()
  for (const item of rows) {
    const [decision] = decisionsOfRows([item])
    if (decision === undefined || decision.decision !== "merged" || decision.duplicate) continue
    merging.set(`${item.row.branch}@${item.row.head}`, item.row)
  }
  const ms = [...merging.values()]
    .map((row) => (row.since === undefined || row.at === undefined ? -1 : row.at.getTime() - row.since.getTime()))
    .filter((value) => value >= 0)
    .sort((a, b) => a - b)
  const median = percentile(ms, 50)
  const p90 = percentile(ms, 90)
  return {
    count: ms.length,
    ...(median === undefined ? {} : { medianMs: median }),
    ...(p90 === undefined ? {} : { p90Ms: p90 }),
  }
}

function groupOf(key: string, rows: readonly WatchRow[]): StatsGroup {
  const decisions = decisionsOfRows(rows)
  const heads = new Map<string, number>()
  const branches = new Map<string, Set<string>>()
  for (const { row } of rows) {
    const change = `${row.branch}@${row.head}`
    heads.set(change, (heads.get(change) ?? 0) + 1)
    const seen = branches.get(row.branch) ?? new Set<string>()
    seen.add(row.head)
    branches.set(row.branch, seen)
  }
  let sameHeadRetries = 0
  for (const count of heads.values()) sameHeadRetries += count - 1
  let rePushedBranches = 0
  let rePushes = 0
  for (const seen of branches.values()) {
    if (seen.size > 1) {
      rePushedBranches += 1
      rePushes += seen.size - 1
    }
  }
  // The change's own state is the same on every one of its rows; one row speaks for it.
  const states = new Map<string, Row["state"]>()
  const mergedByRun = new Set<string>()
  for (const { row } of rows) {
    const change = `${row.branch}@${row.head}`
    states.set(change, row.state)
    if (row.merge !== undefined) mergedByRun.add(change)
  }
  const inState = (...wanted: readonly Row["state"][]): number =>
    [...states.values()].filter((state) => wanted.includes(state)).length
  const merged = inState("merged")
  return {
    branches: branches.size,
    byAncestry: [...states.entries()].filter(([change, state]) => state === "merged" && !mergedByRun.has(change))
      .length,
    changes: heads.size,
    decisions: {
      checked: decisions.filter((decision) => decision.decision === "checked").length,
      duplicates: decisions.filter((decision) => decision.duplicate).length,
      failed: decisions.filter((decision) => decision.decision === "failed").length,
      merged: decisions.filter((decision) => decision.decision === "merged" && !decision.duplicate).length,
      stuck: decisions.filter((decision) => decision.decision === "stuck").length,
      unclassified: unclassifiedRows(rows).length,
    },
    failed: inState("failed"),
    inLine: inState("queued", "checked"),
    key,
    latency: latencyOf(rows),
    merged,
    rePushedBranches,
    rePushes,
    rows: rows.length,
    sameHeadRetries,
    stuck: inState("stuck"),
  }
}

function pushedNeverSubmitted(refs: readonly PushedRef[], options: QueueStatsOptions): PushedNeverSubmitted {
  const never = refs.filter((ref) => !ref.submitted)
  const dated = never.filter((ref) => ref.committedAt !== undefined && inWindow(ref.committedAt, options.since))
  const listed = dated
    .map((ref) => ({
      branch: ref.branch,
      commitAgeMs: options.now.getTime() - (ref.committedAt?.getTime() ?? options.now.getTime()),
      head: ref.head,
    }))
    .sort((a, b) => b.commitAgeMs - a.commitAgeMs)
  const undated = never.filter((ref) => ref.committedAt === undefined)
  return {
    ageBasis: PUSH_AGE_BASIS,
    ageUnknown: undated.length,
    count: listed.length,
    ...(listed[0] === undefined ? {} : { oldestCommitAgeMs: listed[0].commitAgeMs }),
    refs: [...listed, ...undated.map((ref) => ({ branch: ref.branch, head: ref.head }))],
  }
}

/** The stats for the whole queue and per group, over the rows inside the window. */
export function queueStats(
  rows: readonly WatchRow[],
  refs: readonly PushedRef[],
  options: QueueStatsOptions,
): QueueStats {
  const by = options.by ?? "submitter"
  const since = options.since ?? new Date(options.now.getTime() - DEFAULT_WINDOW_MS)
  const windowed = { ...options, since }
  // A row still in line has no decision instant and is always in view; an ended row is inside by its decision's instant.
  const inside = rows.filter(({ row }) => row.at === undefined || inWindow(row.at, since))
  const grouped = new Map<string, WatchRow[]>()
  for (const item of inside) {
    const key = by === "submitter" ? (item.row.submitter ?? "unknown") : item.row.branch
    const bucket = grouped.get(key) ?? []
    bucket.push(item)
    grouped.set(key, bucket)
  }
  const groups = [...grouped.entries()]
    .map(([key, items]) => groupOf(key, items))
    .sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key))
  return {
    at: options.now,
    by,
    defaultWindow: options.since === undefined,
    groups,
    pushedNeverSubmitted: pushedNeverSubmitted(refs, windowed),
    since,
    sinceFrom: options.since === undefined ? { kind: "default" } : (options.sinceFrom ?? { kind: "instant" }),
    total: groupOf("queue", inside),
  }
}

/**
 * `3h`, `45m`, `2d`, `1w` (a duration back from `now`), or an ISO instant, with
 * its kind; undefined for anything else — a commit is the caller's to resolve,
 * to its committer date, because that needs git.
 */
export function parseSince(text: string, now: Date): Readonly<{ at: Date; kind: "duration" | "instant" }> | undefined {
  const relative = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/u.exec(text.trim())
  if (relative !== null) {
    const amount = Number(relative[1])
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, w: 604_800_000 }[relative[2] ?? "h"] ?? 3_600_000
    return { at: new Date(now.getTime() - amount * unit), kind: "duration" }
  }
  const instant = new Date(text)
  return Number.isNaN(instant.getTime()) ? undefined : { at: instant, kind: "instant" }
}

/** The window's start as the definitions line says it: the instant, and how it was arrived at. */
export function sinceLine(stats: QueueStats): string {
  const at = stats.since.toISOString()
  switch (stats.sinceFrom.kind) {
    case "default":
      return `SINCE = ${at}, the default seven days back from ${stats.at.toISOString()} (the read's own horizon)`
    case "duration":
      return `SINCE = ${at}, from --since ${stats.sinceFrom.asked ?? ""} (a duration back from ${stats.at.toISOString()})`
    case "commit":
      return `SINCE = ${at}, from --since ${stats.sinceFrom.asked ?? ""} (that commit's committer date)`
    default:
      return `SINCE = ${at}, from --since ${stats.sinceFrom.asked ?? ""} (an instant, as written)`
  }
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return "—"
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours >= 24) return `${String(Math.floor(hours / 24))}d${String(hours % 24).padStart(2, "0")}h`
  if (hours > 0) return `${String(hours)}h${String(minutes).padStart(2, "0")}m`
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`
}

/** The stats as text: one header, the whole queue, then one line per group; every column a definition above. */
export function formatQueueStats(stats: QueueStats, queue: string): string {
  const columns = [
    "",
    "ROWS",
    "CHANGES",
    "MERGED",
    "ANCESTRY",
    "FAILED",
    "STUCK",
    "IN LINE",
    "RETRIES",
    "BRANCHES",
    "RE-PUSHED",
    "RE-PUSHES",
    "MEDIAN",
    "P90",
  ]
  const line = (group: StatsGroup): string[] => [
    group.key,
    String(group.rows),
    String(group.changes),
    String(group.merged),
    String(group.byAncestry),
    String(group.failed),
    String(group.stuck),
    String(group.inLine),
    String(group.sameHeadRetries),
    String(group.branches),
    String(group.rePushedBranches),
    String(group.rePushes),
    duration(group.latency.medianMs),
    duration(group.latency.p90Ms),
  ]
  const table = [columns, line(stats.total), ...stats.groups.map(line)]
  const widths = columns.map((_, index) => Math.max(...table.map((cells) => (cells[index] ?? "").length)))
  const rendered = table.map((cells) =>
    cells
      .map((cell, index) => (index === 0 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0)))
      .join("  ")
      .trimEnd(),
  )
  const window = `since ${stats.since.toISOString()}${stats.defaultWindow ? " (the default seven days, the read's own horizon)" : ""}`
  const d = stats.total.decisions
  const definitions =
    "ROWS = one per run per change · CHANGES = distinct branch@head · MERGED/FAILED/STUCK/IN LINE = changes by the queue's current state; ANCESTRY = of the merged, those no run merged (replaced, or already on the target) · " +
    `verdicts per run: ${String(d.merged)} merged, ${String(d.duplicates)} dup, ${String(d.failed)} failed, ${String(d.stuck)} stuck, ${String(d.checked)} checked (the STATS pane's numbers)` +
    `${d.unclassified === 0 ? "" : `, ${String(d.unclassified)} UNCLASSIFIED (a result vocabulary this reader does not know; never counted as stuck)`} · ` +
    "RETRIES = rows beyond the first for one branch@head · RE-PUSHED = branches with more than one head · " +
    "MEDIAN/P90 = opened → merged, per merged change · " +
    sinceLine(stats)
  const pushed = stats.pushedNeverSubmitted
  const pushedLine =
    `pushed, never submitted: ${String(pushed.count)}` +
    (pushed.oldestCommitAgeMs === undefined
      ? ""
      : ` (oldest tip committed ${duration(pushed.oldestCommitAgeMs)} ago; ages are ${pushed.ageBasis}s, not push times)`) +
    (pushed.ageUnknown === 0 ? "" : `; ${String(pushed.ageUnknown)} more whose tip is not fetched here, age unknown`)
  return [
    `${queue} · stats at ${stats.at.toISOString()} · ${window} · by ${stats.by}`,
    ...rendered,
    pushedLine,
    definitions,
  ].join("\n")
}
