/**
 * `yrd queue stats` — the queue's own numbers, from the rows `queue list`
 * already reads (@i/10-yrd/24164): merged, failed, same-head retries, branches
 * re-pushed with a new head, refs pushed and never submitted, and the
 * submit-to-merge latency, for the whole queue and per submitter or branch.
 *
 * Pure. One row is what one queue run said about one change (the default,
 * per-run lens of `queue list`); a decision is classified here exactly as the
 * STATS pane classifies the run journals' — {@link decisionsOfRows} yields the
 * same {@link RunDecision} the pane counts, through the same duplicate
 * predicate — so the two surfaces can never disagree about what a merge or a
 * failure is. Nothing here opens a file or talks to git: the caller reads the
 * rows and the remote's branch list and hands both in, with the moment `now`.
 *
 * Definitions, because a number nobody can derive is a number nobody trusts:
 * - merged / failed / duplicate / stuck: rows by decision, a duplicate being a
 *   merged row that merged nothing (`isDuplicateMerge`), counted apart.
 * - same-head retries: rows beyond the first for one `branch@head` — a resubmit
 *   of the same head, or the queue judging it again on a moved target; the
 *   records name both as runs and so does this.
 * - re-pushed branches: branches with more than one distinct head in the rows;
 *   `rePushes` is the number of heads beyond the first, summed.
 * - pushed, never submitted: branches at the remote that no change ref names —
 *   a push without a `yrd submit` (plan E2) — restricted to the window by the
 *   tip's committer date when the commit is here, and counted apart as
 *   `ageUnknown` when it is not (a tip nobody fetched has no date to read).
 * - latency: per merged change (its last merged row), from the change's
 *   `since` (opened) to that row's `at` (merged); median and p90 over them.
 * - the window: a row is inside when its decision (`at`) is at or after
 *   `since`, or when it has none yet (still in line); a pushed ref when its
 *   tip's committer date is. Absent `since`, the read's own seven-day horizon.
 */

import type { Row, WatchRow } from "@yrd/queue-core"
import { isDuplicateMerge, type RunDecision } from "./watch-stats.ts"

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

export type StatsGroup = Readonly<{
  /** `queue` for the whole queue; otherwise the submitter or the branch. */
  key: string
  rows: number
  merged: number
  duplicates: number
  failed: number
  stuck: number
  /** Distinct `branch@head` among the rows. */
  changes: number
  sameHeadRetries: number
  branches: number
  rePushedBranches: number
  rePushes: number
  latency: LatencyStats
}>

export type PushedNeverSubmitted = Readonly<{
  count: number
  /** The oldest tip in the window, as an age at `now`, in ms. */
  oldestAgeMs?: number
  /** Branches at the remote with no change ref whose tip could not be dated here. */
  ageUnknown: number
  /** Oldest first; complete, so `--json` to a file is the whole answer. */
  refs: readonly Readonly<{ branch: string; head: string; ageMs?: number }>[]
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

/**
 * The pane's smallest fact, read from a row instead of a journal: what the run
 * that wrote the row decided about the change. A queued or checked-but-undecided
 * row, and a direct commit (which no run decided), yield nothing.
 */
export function decisionsOfRows(rows: readonly WatchRow[]): readonly RunDecision[] {
  const decisions: RunDecision[] = []
  for (const { row, run } of rows) {
    const decision = decisionOf(row)
    if (decision === undefined || row.at === undefined) continue
    decisions.push({
      at: row.at,
      decision,
      duplicate: isDuplicateMerge({ decision, merge: row.merge, reason: row.reason }),
      run: run?.id ?? row.run ?? `${row.branch}@${row.head}`,
    })
  }
  return decisions
}

function decisionOf(row: Row): RunDecision["decision"] | undefined {
  switch (row.state) {
    case "merged":
    case "failed":
    case "stuck":
    case "checked":
      return row.state
    default:
      return undefined
  }
}

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
  // One latency per merged CHANGE: the last merged row of each branch@head.
  const lastMerged = new Map<string, Row>()
  for (const { row } of rows) {
    if (row.state !== "merged" || row.since === undefined || row.at === undefined) continue
    const key = `${row.branch}@${row.head}`
    const seen = lastMerged.get(key)
    if (seen?.at === undefined || seen.at.getTime() <= row.at.getTime()) lastMerged.set(key, row)
  }
  const ms = [...lastMerged.values()]
    .map((row) => (row.at?.getTime() ?? 0) - (row.since?.getTime() ?? 0))
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
  return {
    branches: branches.size,
    changes: heads.size,
    duplicates: decisions.filter((decision) => decision.duplicate).length,
    failed: decisions.filter((decision) => decision.decision === "failed").length,
    key,
    latency: latencyOf(rows),
    merged: decisions.filter((decision) => decision.decision === "merged" && !decision.duplicate).length,
    rePushedBranches,
    rePushes,
    rows: rows.length,
    sameHeadRetries,
    stuck: decisions.filter((decision) => decision.decision === "stuck").length,
  }
}

function pushedNeverSubmitted(refs: readonly PushedRef[], options: QueueStatsOptions): PushedNeverSubmitted {
  const never = refs.filter((ref) => !ref.submitted)
  const dated = never.filter((ref) => ref.committedAt !== undefined && inWindow(ref.committedAt, options.since))
  const listed = dated
    .map((ref) => ({
      ageMs: options.now.getTime() - (ref.committedAt?.getTime() ?? options.now.getTime()),
      branch: ref.branch,
      head: ref.head,
    }))
    .sort((a, b) => b.ageMs - a.ageMs)
  const undated = never.filter((ref) => ref.committedAt === undefined)
  return {
    ageUnknown: undated.length,
    count: listed.length,
    ...(listed[0] === undefined ? {} : { oldestAgeMs: listed[0].ageMs }),
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
    "MERGED",
    "DUP",
    "FAILED",
    "STUCK",
    "CHANGES",
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
    String(group.merged),
    String(group.duplicates),
    String(group.failed),
    String(group.stuck),
    String(group.changes),
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
  const definitions =
    "RETRIES = rows beyond the first for one branch@head · RE-PUSHED = branches with more than one head · " +
    "MEDIAN/P90 = opened → merged, per merged change · " +
    sinceLine(stats)
  const pushed = stats.pushedNeverSubmitted
  const pushedLine =
    `pushed, never submitted: ${String(pushed.count)}` +
    (pushed.oldestAgeMs === undefined ? "" : ` (oldest ${duration(pushed.oldestAgeMs)} ago)`) +
    (pushed.ageUnknown === 0 ? "" : `; ${String(pushed.ageUnknown)} more whose tip is not fetched here, age unknown`)
  return [
    `${queue} · stats at ${stats.at.toISOString()} · ${window} · by ${stats.by}`,
    ...rendered,
    pushedLine,
    definitions,
  ].join("\n")
}
