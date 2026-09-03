/**
 * The one table ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design,
 * Commands): `yrd queue list` and `yrd queue show <branch>`, derived at read
 * time from the queue read. Nothing here is stored and nothing here is a
 * second reader: both views are the queue read rendered, so they can never
 * disagree with a queue run or with each other. Every row is read off one
 * fact, the change's tip, whose trailers are the whole derived state — except
 * the row for a commit the queue did not put on the target, which is read off
 * the target itself (E5).
 */

import { endedKind, trailer, trailers, type Fact } from "./facts.ts"
import { handMovedLine, type OutsideCommit } from "./outside.ts"
import type { QueueEntry, QueueRead } from "./remote.ts"
import { inLine, type ChangeState } from "./state.ts"

export type Row = Readonly<{
  /** The change's branch; for an `outside` row, the target the hand commit moved. */
  branch: string
  /** The change's head; for an `outside` row, the hand commit itself. */
  head: string
  /** A change's state, or `outside` for a commit on the target the queue did not put there (E5). */
  state: ChangeState | "outside"
  /** 1-based place in line for queued, checked and stuck rows; absent otherwise. */
  position?: number
  /** The last result: pass, fail or stuck, with the check that decided it. */
  result?: string
  /** The log path of the deciding check, when there is one. */
  log?: string
  workItem?: string
  submitter?: string
  /** Why: `replaced`, `deleted`, a check's code, or for an `outside` row the one line about the hand commit. */
  reason?: string
  /** When the change was opened, from its first fact's `Opened:`. */
  since?: Date
  /** When the change's last fact was written: an ended change is as recent as its ending. A hand commit is as recent as its commit. */
  at?: Date
}>

export type ListOptions = Readonly<{
  now?: Date
  /** How far back the ended rows reach; the plan's default is seven days. */
  sinceMs?: number
  /** The commits on the target the queue did not put there, each its own row (E5; `outsideCommits` reads them). */
  outside?: readonly OutsideCommit[]
}>

/**
 * Every change in line with its position, then every ended change within
 * `sinceMs` (the plan's default is seven days), failed and merged included,
 * and among them every commit the target gained by hand, as recent as it was
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
    ...(options.outside ?? []).map(outsideRow),
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
    .filter((entry) => entry.branch === branch)
    .map((entry) => {
      const tip = entry.change.facts.at(-1)
      return { checks: tip === undefined ? [] : trailers(tip, "Check"), facts: entry.change.facts, row: row(entry) }
    })
    .sort((left, right) => (right.row.since?.getTime() ?? 0) - (left.row.since?.getTime() ?? 0))
}

function row(entry: QueueEntry, position?: number): Row {
  const tip = entry.change.facts.at(-1)
  const lastCheck = tip === undefined ? undefined : trailers(tip, "Check").at(-1)
  const opened = tip === undefined ? undefined : trailer(tip, "Opened")
  return {
    at: tip?.at,
    branch: entry.branch,
    head: entry.change.head,
    log: lastCheck?.match(/log=(\S+)/u)?.[1],
    position,
    reason: entry.reading.reason,
    result: tip === undefined || tip.kind === "opened" ? undefined : resultOf(endedKind(tip), lastCheck),
    since: opened === undefined ? undefined : new Date(opened),
    state: entry.reading.state,
    submitter: tip === undefined ? undefined : trailer(tip, "Submitter"),
    workItem: tip === undefined ? undefined : trailer(tip, "Work-Item"),
  }
}

/** A commit the target gained by hand: `<target> moved by hand at <sha12> (<subject>)`, and the pins it moved. */
function outsideRow(commit: OutsideCommit): Row {
  return { at: commit.at, branch: commit.target, head: commit.commit, reason: handMovedLine(commit), state: "outside" }
}

function resultOf(kind: Fact["kind"], lastCheck: string | undefined): string {
  const check = lastCheck?.split(" ")[0]
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
