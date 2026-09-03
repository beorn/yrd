/**
 * The one table ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design,
 * Commands): `yrd queue list` and `yrd queue show <branch>`, derived at read
 * time from the lane. Nothing here is stored and nothing here is a second
 * reader: both views are the lane rendered, so they can never disagree with a
 * queue run or with each other. Every row is read off one fact, the change's
 * tip, whose trailers are the whole derived state.
 */

import { trailer, trailers, type Fact } from "./facts.ts"
import type { LaneEntry } from "./remote.ts"
import { inLine, type ChangeState } from "./state.ts"

export type Row = Readonly<{
  branch: string
  head: string
  state: ChangeState
  /** 1-based place in line for queued, checked and stuck rows; absent otherwise. */
  position?: number
  /** The last result: pass, fail or stuck, with the check that decided it. */
  result?: string
  /** The log path of the deciding check, when there is one. */
  log?: string
  workItem?: string
  submitter?: string
  reason?: string
  /** When the change was opened; absent for a branch pushed but never submitted. */
  since?: Date
}>

/**
 * Every change in line with its position, then every ended change within
 * `sinceMs` (the plan's default is seven days), failed and merged included.
 */
export function list(entries: readonly LaneEntry[], now: Date = new Date(), sinceMs = 7 * 24 * 60 * 60 * 1000): readonly Row[] {
  const live = inLine(entries.map((entry) => entry.change)).map((change) => change.head)
  const position = new Map(live.map((head, index) => [head, index + 1]))
  const rows = entries.map((entry) => row(entry, position.get(entry.change.head)))
  const inLineRows = rows.filter((candidate) => candidate.position !== undefined).sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
  const endedRows = rows
    .filter((candidate) => candidate.position === undefined)
    .filter((candidate) => candidate.since === undefined || now.getTime() - candidate.since.getTime() <= sinceMs)
    .sort((left, right) => (right.since?.getTime() ?? 0) - (left.since?.getTime() ?? 0))
  return [...inLineRows, ...endedRows]
}

/** One branch's changes, newest first, each with every check's result and log. */
export function show(entries: readonly LaneEntry[], branch: string): readonly Readonly<{ row: Row; checks: readonly string[]; facts: readonly Fact[] }>[] {
  return entries
    .filter((entry) => entry.branch === branch)
    .map((entry) => {
      const tip = entry.change.facts.at(-1)
      return { checks: tip === undefined ? [] : trailers(tip, "Check"), facts: entry.change.facts, row: row(entry) }
    })
    .sort((left, right) => (right.row.since?.getTime() ?? 0) - (left.row.since?.getTime() ?? 0))
}

function row(entry: LaneEntry, position?: number): Row {
  const tip = entry.change.facts.at(-1)
  const lastCheck = tip === undefined ? undefined : trailers(tip, "Check").at(-1)
  const opened = tip === undefined ? undefined : trailer(tip, "Opened")
  return {
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

/** The kind a tip stands for: a sent fact stands for the ended state it repeats. */
function endedKind(tip: Fact): Fact["kind"] {
  if (tip.kind !== "sent") return tip.kind
  const state = trailer(tip, "State")
  return state === "merged" || state === "failed" || state === "stuck" ? state : "sent"
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
