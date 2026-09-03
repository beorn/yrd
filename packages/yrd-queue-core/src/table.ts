/**
 * The one table ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design,
 * Commands): `yrd queue list` and `yrd queue show <branch>`, derived at read
 * time from the queue read. Nothing here is stored and nothing here is a
 * second reader: both views are the queue read rendered, so they can never
 * disagree with a queue run or with each other. Every row is read off one
 * fact, the change's tip, whose trailers are the whole derived state — except
 * the row for a commit the queue did not put on the target, a BYPASS, which is
 * read off the target itself (E5).
 */

import { endedKind, trailer, trailers, type Fact } from "./facts.ts"
import { readCheckTrailer } from "./check.ts"
import { bypassLine, type Bypass } from "./bypass.ts"
import type { QueueEntry, QueueRead } from "./remote.ts"
import { inLine, tipOf, type ChangeState } from "./state.ts"

export type Row = Readonly<{
  /** The change's branch; for a `bypass` row, the target that commit moved. */
  branch: string
  /** The change's head; for a `bypass` row, that commit itself. */
  head: string
  /** A change's state, or `bypass` for a commit on the target the queue did not put there (E5). */
  state: ChangeState | "bypass"
  /** 1-based place in line for queued, checked and stuck rows; absent otherwise. */
  position?: number
  /** The last result: pass, fail or stuck, with the check that decided it. */
  result?: string
  /** The log path of the deciding check, when there is one. */
  log?: string
  issue?: string
  submitter?: string
  /** Why: `replaced`, `deleted`, a check's code, or for a `bypass` row the one line about that commit. */
  reason?: string
  /** When the change was opened, from its first fact's `Opened:`. */
  since?: Date
  /** When the change's last fact was written: an ended change is as recent as its ending. A hand commit is as recent as its commit. */
  at?: Date
  /** The merge commit on the target, full sha, from the merged fact's `Merge:` (carried by the sent fact too); absent until merged. */
  merge?: string
  /** The target commit the change was merged or judged at, full sha, from the fact's `Base:`. */
  base?: string
}>

export type ListOptions = Readonly<{
  now?: Date
  /** How far back the ended rows reach; the plan's default is seven days. */
  sinceMs?: number
  /** The commits on the target the queue did not put there, each its own row (E5; `bypassCommits` reads them). */
  bypasses?: readonly Bypass[]
}>

/**
 * Every change in line with its position, then every ended change within
 * `sinceMs` (the plan's default is seven days), failed and merged included,
 * and among them every commit that went around the queue, as recent as it was
 * committed.
 */
export function list(entries: QueueRead, options: ListOptions = {}): readonly Row[] {
  const now = options.now ?? new Date()
  const sinceMs = options.sinceMs ?? 7 * 24 * 60 * 60 * 1000
  const live = inLine(entries.map((entry) => entry.change)).map((change) => change.head)
  const position = new Map(live.map((head, index) => [head, index + 1]))
  const rows = entries.map((entry) => row(entry, position.get(entry.change.head)))
  const inLineRows = rows
    .filter((candidate) => candidate.position !== undefined)
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
  // The window is about when a change ENDED, not when it was opened: a change
  // opened long ago and merged today is today's news.
  const endedRows = [
    ...rows.filter((candidate) => candidate.position === undefined),
    ...(options.bypasses ?? []).map(bypassesRow),
  ]
    .filter((candidate) => candidate.at === undefined || now.getTime() - candidate.at.getTime() <= sinceMs)
    .sort((left, right) => (right.at?.getTime() ?? 0) - (left.at?.getTime() ?? 0))
  return [...inLineRows, ...endedRows]
}

/** One branch's changes, newest first, each with every check's result and log. */
export function show(
  entries: QueueRead,
  branch: string,
): readonly Readonly<{ row: Row; checks: readonly string[]; facts: readonly Fact[] }>[] {
  return entries
    .filter((entry) => entry.change.branch === branch)
    .map((entry) => ({ checks: trailers(tipOf(entry.change), "Check"), facts: entry.change.facts, row: row(entry) }))
    .sort((left, right) => (right.row.since?.getTime() ?? 0) - (left.row.since?.getTime() ?? 0))
}

function row(entry: QueueEntry, position?: number): Row {
  const tip = tipOf(entry.change)
  const packed = trailers(tip, "Check").at(-1)
  const lastCheck = packed === undefined ? undefined : readCheckTrailer(packed)
  const opened = trailer(tip, "Opened")
  return {
    at: tip.at,
    branch: entry.change.branch,
    head: entry.change.head,
    log: lastCheck?.log,
    position,
    reason: entry.reading.reason,
    result: tip.kind === "opened" ? undefined : resultOf(endedKind(tip), lastCheck?.name),
    since: opened === undefined ? undefined : new Date(opened),
    state: entry.reading.state,
    submitter: trailer(tip, "Submitter"),
    issue: trailer(tip, "Issue"),
    merge: trailer(tip, "Merge"),
    base: trailer(tip, "Base"),
  }
}

/** A bypass: `<target> moved around the queue at <sha12> (<subject>)`, and the pins it moved. */
function bypassesRow(commit: Bypass): Row {
  return { at: commit.at, branch: commit.target, head: commit.commit, reason: bypassLine(commit), state: "bypass" }
}

function resultOf(kind: Fact["kind"], check: string | undefined): string {
  switch (kind) {
    case "checked":
    case "merged":
      return check === undefined ? "pass" : `pass ${check}`
    case "failed":
      return check === undefined ? "fail" : `fail ${check}`
    case "stuck":
      return check === undefined ? "stuck" : `stuck ${check}`
    default:
      return kind
  }
}
