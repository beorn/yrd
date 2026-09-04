/**
 * The one table ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design,
 * Commands): `yrd queue list` and `yrd queue show <branch>`, derived at read
 * time from the queue read. Nothing here is stored and nothing here is a
 * second reader: both views are the queue read rendered, so they can never
 * disagree with a queue run or with each other. Every row is read off the
 * change's tip, whose trailers carry its derived state. One-change detail
 * folds `Check:` evidence from the full history supplied by `readHistories`.
 * The row for a commit the queue did not put on the target, a direct merge, is
 * read off the target itself (E5).
 *
 * Two readings JOIN the records here, and neither is a second derivation of
 * anything the records already say:
 *
 * - the run journal (`readJournals`), which is what makes a check running
 *   RIGHT NOW visible. `readChange` still owns the five states and always
 *   will; `live` is an overlay ON a state, never a sixth one. It is local to
 *   the machine the queue runs on, so off that machine it is absent — and
 *   {@link Journals.absent} says where it looked, so no caller prints a blank
 *   where a fact belongs.
 * - the head commit's subject (`subjects`), read in ONE batched git call for
 *   the whole table, because a filter and a title both mean the change's own
 *   subject and the records carry only the RECORD's.
 */

import { endedKind, mergedByRun, trailer, trailers, type ChangeRecord } from "./records.ts"
import { readCheckTrailer } from "./check.ts"
import { directMergeLine, type DirectMerge } from "./direct.ts"
import { journalKey, type Journals, type JournalRun } from "./log.ts"
import { incidentFrom, incidentLine, type Incident } from "./incident.ts"
import type { Git } from "./records.ts"
import type { QueueEntry, QueueRead } from "./remote.ts"
import { inLine, nextOwner, tipOf, type ChangeState, type NextOwner } from "./state.ts"

export type Row = Readonly<{
  /** The change's branch; for a `direct` row, the target that commit moved. */
  branch: string
  /** The change's head; for a `direct` row, that commit itself. */
  head: string
  /** A change's state, or `direct` for a commit on the target the queue did not put there (E5). */
  state: ChangeState | "direct"
  /** 1-based place in line for queued, checked and stuck rows; absent otherwise. */
  position?: number
  /** The last result: pass, fail or stuck, with the check that decided it. */
  result?: string
  /** The log path of the deciding check, when there is one. */
  log?: string
  /** The complete queue-owned incident stored on a stuck record. */
  incident?: Incident
  issue?: string
  submitter?: string
  /** Why: `replaced`, `deleted`, a check's code, or for a `direct` row the one line about that commit. */
  reason?: string
  /** When the change was opened, from its first record's `Opened:`. */
  since?: Date
  /** When the change's last record was written: an ended change is as recent as its ending. A direct merge is as recent as its commit. */
  at?: Date
  /** The merge commit on the target, full sha, from the merged record's `Merge:` (carried by the sent record too); absent until merged. */
  merge?: string
  /** The target commit the change was merged or judged at, full sha, from the record's `Base:`. */
  base?: string
  /**
   * The change's own head commit subject — what a filter and a title both mean
   * by "subject". Absent when the object is not in this repository: the row
   * says the subject was not fetched rather than showing an empty title.
   */
  subject?: string
  /**
   * The queue run that last touched this change: the journal's, when one was
   * read here, else the run named by a merged record's `Merged-By:`. Absent
   * off the queue's own machine for anything not yet merged.
   */
  run?: string
  /** When checking began — the journal's first check-start for this change, or the tip's own instant when the tip IS the checked record. */
  startedAt?: Date
  /** When the change ended; absent while it is queued or checked, and absent for an ending git read rather than a record (`replaced`, `deleted`, a direct ancestor). */
  endedAt?: Date
  /**
   * The check running on this change RIGHT NOW, from the run journal. An
   * overlay on {@link Row.state}, never a state of its own: a change under a
   * check still reads `queued` until its checked record lands, and that is the
   * records' answer, not a display bug.
   */
  live?: Readonly<{ run: string; check: string; phase: string; since: Date; log?: string }>
  /** Who acts next and why, derived once beside `readChange` (state.ts). Absent for a merged change: nobody. */
  next?: NextOwner
}>

export type ListOptions = Readonly<{
  now?: Date
  /** How far back the ended rows reach; the plan's default is seven days. */
  sinceMs?: number
  /** The commits on the target the queue did not put there, each its own row (E5; `directMergeCommits` reads them). */
  directMerges?: readonly DirectMerge[]
  /** What the run journals on this machine say (`readJournals`); absent leaves every journal-derived field absent. */
  journals?: Journals
  /** Each head's commit subject, by full sha (`subjects`); a head not in the map has none. */
  subjects?: ReadonlyMap<string, string>
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
  const rows = entries.map((entry) => row(entry, position.get(entry.change.head), options))
  const inLineRows = rows
    .filter((candidate) => candidate.position !== undefined)
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
  // The window is about when a change ENDED, not when it was opened: a change
  // opened long ago and merged today is today's news.
  const endedRows = [
    ...rows.filter((candidate) => candidate.position === undefined),
    ...(options.directMerges ?? []).map(directMergeRow),
  ]
    .filter((candidate) => candidate.at === undefined || now.getTime() - candidate.at.getTime() <= sinceMs)
    .sort((left, right) => (right.at?.getTime() ?? 0) - (left.at?.getTime() ?? 0))
  return [...inLineRows, ...endedRows]
}

/** One branch's changes, newest first, each with every check's result and log. */
export function show(
  entries: QueueRead,
  branch: string,
  options: ListOptions = {},
): readonly Readonly<{ row: Row; checks: readonly string[]; records: readonly ChangeRecord[] }>[] {
  return entries
    .filter((entry) => entry.change.branch === branch)
    .map((entry) => ({
      checks: entry.change.records.flatMap((record) => trailers(record, "Check")),
      records: entry.change.records,
      row: row(entry, undefined, options),
    }))
    .sort((left, right) => (right.row.since?.getTime() ?? 0) - (left.row.since?.getTime() ?? 0))
}

/**
 * The clocks a change keeps, read once so `queue list`, `queue show` and the
 * watch cannot disagree about how old anything is.
 *
 * Each is absent rather than zero when what it is measured from is absent: a
 * change with no journal on this machine and no checked record has no instant
 * checking began, so it has no wait and no runtime, and a reader that printed
 * `0s` for it would be stating a measurement nobody made.
 */
export type Clocks = Readonly<{
  /** How long the change has existed: now, less when it was opened. */
  ageMs?: number
  /** How long it waited before checking began. */
  waitMs?: number
  /** How long checking has run, or ran: still counting while it is open. */
  runtimeMs?: number
}>

export function clocks(row: Row, now: Date = new Date()): Clocks {
  const ageMs = row.since === undefined ? undefined : Math.max(0, now.getTime() - row.since.getTime())
  const waitMs =
    row.since === undefined || row.startedAt === undefined
      ? undefined
      : Math.max(0, row.startedAt.getTime() - row.since.getTime())
  const runtimeMs =
    row.startedAt === undefined ? undefined : Math.max(0, (row.endedAt ?? now).getTime() - row.startedAt.getTime())
  return {
    ...(ageMs === undefined ? {} : { ageMs }),
    ...(waitMs === undefined ? {} : { waitMs }),
    ...(runtimeMs === undefined ? {} : { runtimeMs }),
  }
}

/**
 * The head commit subject of every change in one reading.
 *
 * ONE git call for the whole table, never one per row: a list of forty changes
 * used to be forty `git show`s, and at a fifth of a second each that is the
 * difference between a watch that refreshes and one that stutters.
 * `--ignore-missing` is what makes it one call — an object this repository has
 * not fetched is simply not in the answer, and the caller sees no entry for
 * that head rather than an empty subject.
 */
export async function subjects(git: Git, heads: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const wanted = [...new Set(heads)].filter((head) => head !== "")
  // Git with no revision walks HEAD, so an empty table must not ask at all.
  if (wanted.length === 0) return new Map()
  const out = await git(["log", "--ignore-missing", "--no-walk=unsorted", "--format=%H %s", ...wanted])
  const found = new Map<string, string>()
  for (const line of out.split("\n")) {
    const space = line.indexOf(" ")
    if (space === -1) continue
    const sha = line.slice(0, space)
    if (!/^[0-9a-f]{40}$/u.test(sha)) continue
    found.set(sha, line.slice(space + 1))
  }
  return found
}

function row(entry: QueueEntry, position: number | undefined, options: ListOptions = {}): Row {
  const tip = tipOf(entry.change)
  const packed = trailers(tip, "Check").at(-1)
  const lastCheck = packed === undefined ? undefined : readCheckTrailer(packed)
  const opened = trailer(tip, "Opened")
  const ended = endedKind(tip)
  const submitter = trailer(tip, "Submitter")
  const runs = options.journals?.runs.get(journalKey(entry.change.branch, entry.change.head)) ?? []
  const latest = runs[0]
  const running = runs.find((run) => run.running !== undefined)
  const startedAt = checkingBegan(runs, tip, ended)
  const state = entry.reading.state
  const incident = state === "stuck" ? incidentFrom(tip) : undefined
  const subject = options.subjects?.get(entry.change.head)
  const run = latest?.id ?? mergedByRun(trailer(tip, "Merged-By"))
  const live = running?.running
  const next =
    incident === undefined
      ? nextOwner(entry.reading, {
          ...(submitter === undefined ? {} : { submitter }),
          ...(options.journals?.dir === undefined ? {} : { journal: options.journals.dir }),
        })
      : { because: incident.next, owner: incident.owner }
  return {
    at: tip.at,
    branch: entry.change.branch,
    head: entry.change.head,
    log: lastCheck?.log,
    position,
    reason: incident?.code ?? entry.reading.reason,
    result:
      incident === undefined
        ? tip.kind === "opened"
          ? undefined
          : resultOf(ended, lastCheck?.name)
        : incidentLine(incident),
    since: opened === undefined ? undefined : new Date(opened),
    state,
    submitter: trailer(tip, "Submitter"),
    issue: trailer(tip, "Issue"),
    merge: trailer(tip, "Merge"),
    base: trailer(tip, "Base"),
    ...(incident === undefined ? {} : { incident }),
    ...(subject === undefined ? {} : { subject }),
    ...(run === undefined ? {} : { run }),
    ...(startedAt === undefined ? {} : { startedAt }),
    // Ended is what the RECORD says ended it. A change read merged from
    // ancestry alone, or failed because its branch moved under it, ended
    // outside the records and has no instant to name: absent, not the tip's.
    ...(ended === "merged" || ended === "failed" || ended === "stuck" ? { endedAt: tip.at } : {}),
    ...(live === undefined || running === undefined
      ? {}
      : {
          live: {
            check: live.name,
            phase: live.phase,
            run: running.id,
            since: live.startedAt,
            ...(live.log === undefined ? {} : { log: live.log }),
          },
        }),
    ...(next === undefined ? {} : { next }),
  }
}

/**
 * When checking began: the earliest check-start any run journal recorded for
 * this change, else the checked record's own instant when the tip IS that
 * record. Absent otherwise — and absent is the honest answer off the queue's
 * machine, where there is no journal and the tip has moved past `checked`.
 */
function checkingBegan(runs: readonly JournalRun[], tip: ChangeRecord, ended: ChangeRecord["kind"]): Date | undefined {
  const starts = runs.flatMap((run) => run.checks.map((check) => check.startedAt.getTime()))
  if (starts.length > 0) return new Date(Math.min(...starts))
  return ended === "checked" ? tip.at : undefined
}

/** A direct merge: `<target> moved around the queue at <sha12> (<subject>)`, and the gitlinks it moved. */
function directMergeRow(commit: DirectMerge): Row {
  return {
    at: commit.at,
    head: commit.commit,
    branch: commit.target,
    reason: directMergeLine(commit),
    state: "direct",
    subject: commit.subject,
  }
}

function resultOf(kind: ChangeRecord["kind"], check: string | undefined): string {
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
