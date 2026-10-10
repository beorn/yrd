/** Event queue table rows, journal overlays, clocks and commit subjects. */
import { journalKey, type JournalRun, type Journals, type LogRecord } from "./log.ts"
import { incidentLine, type Incident } from "./incident.ts"
import { CHANGE_STATUSES, isOpen, type ChangeStatus, type EventChange } from "./events.ts"
import type { Git } from "./git.ts"

export type NextOwner = Readonly<{ owner: string; because: string }>

export type Row<Status extends string = ChangeStatus | "direct" | "invalid"> = Readonly<{
  /** Event rows keep their fold's status word; legacy rows use the historical display vocabulary. */
  format?: "event"
  /** The change's branch; for a `direct` row, the target that commit moved. */
  branch: string
  /** The change's head; for a `direct` row, that commit itself. */
  head: string
  /**
   * A change's state; `direct` for a commit on the target the queue did not put there (E5); `draft` for a
   * head at the remote nobody submitted (drafts.ts), which has no record and is no change.
   */
  state: Status
  /** 1-based place in line for queued, checked and stuck rows; absent otherwise. */
  position?: number
  /** The result of the run named by `run`: pass, fail or stuck, with its deciding check. */
  result?: string
  /** The log path of the deciding check, when there is one. */
  log?: string
  /** The complete queue-owned incident stored on a stuck record. */
  incident?: Incident
  /** Original ref-write warnings from this row's journal run; never change state. */
  diagnostics?: readonly LogRecord[]
  /**
   * Rows of this change's run journal that could not be read, each the
   * sentence saying what was wrong with one of them. The rows were skipped and
   * the rest of the run was kept, so this row's state is what its OTHER
   * records give — never a decision invented for the gap (24408). {@link
   * Row.next} says the same thing in the one line a reader acts on.
   */
  malformed?: readonly string[]
  /**
   * Record kinds in this change's run journal that THIS reader's build does not
   * know. Reader version skew, never malformed bytes (24735, @cto 056e31bf):
   * the run was still folded, and {@link Row.next} carries the reader's cure.
   */
  unknownKinds?: readonly string[]
  /** A selected chain that cannot fold, or retained merged endings whose equality cannot be proved. */
  diagnostic?: string
  /** Immutable ending identity distinguishing retained ambiguous merged rows. */
  ending?: string
  /** Exact selected event chain and fold error when state is invalid. */
  ref?: string
  tip?: string
  error?: string
  issue?: string
  submitter?: string
  /** Why: `replaced`, `deleted`, `superseded`, a check's code, or for a `direct` row the one line about that commit. */
  reason?: string
  /** An open event change's attributed ignore overlay; absent otherwise. */
  ignored?: Readonly<{ reason: string; by: string }>
  /** The branch's current head, named only when `reason` is `superseded` (state.ts). */
  supersededBy?: string
  /** When the change was opened, from its first record's `Opened:`. */
  since?: Date
  /** When the change's last record was written; a notification has its own instant. A direct merge uses its commit time. */
  at?: Date
  /** The merge commit on the target, full sha, from the merged record's `Merge:` (carried by the sent record too); absent until merged. */
  merge?: string
  /**
   * Later endings of this same head and proven merge root, folded into this row
   * (25718). `ending` remains the later event; originalEnding and merge carry
   * the equality proof independently of a journal run's own merge field.
   */
  duplicates?: readonly Readonly<{ ending: string; originalEnding?: string; merge?: string; endedAt?: Date }>[]
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
  /** When this run's checks began — its first check-start, or the tip's own instant when no journal exists and the tip IS the checked record. */
  startedAt?: Date
  /** An adopted ending whose old records retained no verifying/checking/merging instant. */
  adoptedPhaseMissing?: true
  /** When the actual ending record was written; absent when only its sent notice was read, while queued or checked, or for an ending git read (`replaced`, `deleted`, a direct ancestor). */
  endedAt?: Date
  /**
   * When the change ended, as the table times and orders it: the ending record's instant, read through
   * the notice's `For:` when the tip is the notice sent after it ({@link endingInstants}). A display fact,
   * present only when the reading asked for ending instants ({@link ListOptions.endings}), which only a
   * surface a person reads does: a `--json` document spreads the row and never carries it.
   */
  endingAt?: Date
  /** A draft's head commit author; absent for a change, and for a draft whose head is not read here. */
  author?: string
  /** A draft whose branch was submitted before at another head: its head moved since its last submit. */
  movedSinceSubmit?: boolean
  /**
   * The check running on this change RIGHT NOW, from the run journal. An
   * overlay on {@link Row.state}, never a state of its own: a change under a
   * check still reads `queued` until its checked record merges, and that is the
   * records' answer, not a display bug.
   */
  live?: Readonly<{ run: string; check: string; phase: string; since: Date; log?: string }>
  /**
   * Whether the ending's telling reached every name its tip says it tried
   * (`tellingOf`, state.ts); absent until a sent record tried somebody.
   */
  told?: boolean
  /** Why a transport refused this ending's telling, one reason per name, `; `-joined. */
  refused?: string
  /** Why a name got no receipt from this ending's telling, one reason per name, `; `-joined. */
  undelivered?: string
  /** Who acts next and why, derived once beside `readChange` (state.ts). Absent for a merged change: nobody. */
  next?: NextOwner
  /** Projected duration in ms for a deferred change. */
  projectedMs?: number
  /** Check bound in ms for a deferred change. */
  boundMs?: number
}>

/** One line of the watch's list: a change, or a change as ONE run saw it. */
export type WatchRow = Readonly<{
  row: Row
  /** The run this line is about; absent when no journal split the change by run. */
  run?: JournalRun
}>

export type WatchRowOptions = Readonly<{
  /** Select one current row even when a caller requests the per-run lens. */
  latest?: boolean
  /**
   * One row per RUN of each change instead of one per change. STATS counts
   * decisions, and a change checked twice made two of them, so the box and
   * `yrd queue stats` ask for this lens by name; the TABLE never does.
   */
  perRun?: boolean
  /** What the run journals on this machine say; absent leaves one row per change. */
  journals?: Journals
}>

/** The same identity for selection and detail: branch, head, retained ending and journal run. */
export function watchRowKey(row: WatchRow): string {
  const change = journalKey(row.row.branch, row.row.head)
  const ending = row.row.ending === undefined ? change : `${change}:ending:${row.row.ending}`
  return row.run === undefined ? ending : `${ending}@${row.run.id}`
}

/**
 * The rows a watch shows, in the order `list()` already put them: in line
 * first by position, then the ended, newest first.
 *
 * ONE ROW PER CHANGE. The page is about changes, and a change checked twice is
 * one change: the operator read their own queue on 2026-09-17 and saw two rows
 * for one branch, which is what this used to do BY DESIGN wherever a run
 * journal could be read. That made the duplicate host-only by construction —
 * invisible from any other clone, where `journals` is undefined and the early
 * return already fired — and it answered "what has the queue DONE" on a page
 * whose question is "where does each change stand". The two lenses both still
 * exist; S1 swapped which one is the default.
 *
 * {@link WatchRowOptions.perRun} is the other lens, and it is not a flag
 * anybody types: no `--runs` spelling exists (D2). Its one consumer is STATS,
 * which counts a DECISION per run and would silently understate retries and
 * lose every superseded run's verdict if it were folded away.
 */
export function watchRows(rows: readonly Row[], options: WatchRowOptions = {}): readonly WatchRow[] {
  const journals = options.journals
  if (options.latest === true || options.perRun !== true || journals === undefined) {
    // The default lens is a status surface too (@cto a04a006b, 24735 finding
    // 2): a change whose journal this reader could not fully read wears the
    // same skew here as it does per run, never only in the split lens.
    return rows.map((row) => ({ row: skewedRow(row, journals?.runs.get(journalKey(row.branch, row.head)) ?? []) }))
  }
  return rows.flatMap((row) => {
    const runs = journals.runs.get(journalKey(row.branch, row.head)) ?? []
    if (runs.length === 0) return [{ row }]
    return runs.map((run, index) => ({ row: runRow(row, run, index === 0), run }))
  })
}

/**
 * The one row a change shows when the page is not split by run, wearing the
 * skew of the newest run whose journal carried a kind this reader does not
 * know. No journal on this machine leaves the row exactly as the fold gave it.
 */
function skewedRow(current: Row, runs: readonly JournalRun[]): Row {
  const skewed = runs.find((run) => (run.unknownKinds?.length ?? 0) > 0)
  if (skewed === undefined) return current
  const skew = skewNext(skewed)
  return {
    ...current,
    unknownKinds: skewed.unknownKinds,
    // This change's own next owner when it has one; the reader's cure otherwise.
    ...(current.next !== undefined || skew === undefined ? {} : { next: skew }),
  }
}

/**
 * Who acts on a change whose run journal holds a row that could not be read,
 * and why — said in the one line a reader already consults to decide what to
 * do about the change. Undefined when that run read clean.
 *
 * This is 24408's surface. A skipped row must reach the reader who is looking
 * at the change: dropping it in silence would trade one dead read verb for a
 * table that quietly understates what the queue recorded, and taking the read
 * down instead cost every seat every read verb for a seven-day window.
 */
function malformedNext(run: JournalRun | undefined): NextOwner | undefined {
  if (run?.malformed === undefined || run.malformed.length === 0) return undefined
  return {
    because: `run journal ${run.id} has a malformed row for this change (${run.malformed.join("; ")}); the row was skipped — fix the writer (26230)`,
    owner: "the queue's operator",
  }
}

/**
 * What a row says when this reader did not know every kind its run journal
 * carried (24735, @cto 056e31bf). READER version skew, and the cure is the
 * reader's own build — never the writer's bytes, which is why this is a
 * separate sentence from {@link malformedNext} and must never carry its
 * fix-the-writer wording. The run is still folded; only this reader's reading
 * of it is partial.
 */
function skewNext(run: JournalRun | undefined): NextOwner | undefined {
  const kinds = run?.unknownKinds
  if (run === undefined || kinds === undefined || kinds.length === 0) return undefined
  return {
    because: `journal ${run.id} carries record kind ${kinds.join(", ")} this watch does not know; restart the watch from the landing root`,
    owner: "the watch's own build",
  }
}

/** Join already-recorded run facts; never rederive the change's state. */
function runRow(current: Row, run: JournalRun, newest: boolean): Row {
  const check = run.decision === "failed" ? run.checks.findLast((check) => check.result === "fail") : run.checks.at(-1)
  const result =
    run.incident === undefined
      ? run.decision === "checked" ||
        run.decision === "deferred" ||
        run.decision === "merged" ||
        run.decision === "failed" ||
        run.decision === "stuck" ||
        run.decision === "withdrawn"
        ? resultOf(run.decision, check?.name)
        : check?.result === undefined
          ? undefined
          : `${check.result} ${check.name}`
      : incidentLine(run.incident)
  // Runs are serialized per change: a newer run proves an abandoned older
  // check is no longer running, even when no decision was recorded for it.
  // And the newest run's marker is the same overlay `list` gates (24972): a
  // change no longer in line is under no check, whatever its journal still
  // says (25521 — a cancelled change's detail read `checking` for 6 days).
  const live = newest && stillInLine(current.state) ? run.running : undefined
  const defect = malformedNext(run)
  const skew = skewNext(run)
  const next = defect ?? skew
  return {
    ...current,
    // Assign absent run-only values too: no later run's facts may survive this join.
    at: run.at,
    base: run.base,
    // An observed-on-target run writes its merge in the event but not the
    // journal. Other runs must not borrow a later event's merge SHA.
    merge:
      run.merge ??
      (run.decision === "merged" && run.reason?.startsWith("already on target at ") ? current.merge : undefined),
    reason: run.incident?.code ?? run.reason,
    incident: run.incident,
    diagnostics: run.diagnostics,
    malformed: run.malformed,
    unknownKinds: run.unknownKinds,
    // This run's own defect when it has one; otherwise the change's next
    // owner, which the newest run's defect may already have replaced — the
    // journal is defective for the change, not for one of its runs.
    ...(next === undefined ? {} : { next }),
    result,
    log: check?.log,
    run: run.id,
    startedAt: run.checks[0]?.startedAt,
    endedAt: run.decision === undefined ? undefined : run.at,
    live:
      live === undefined
        ? undefined
        : {
            run: run.id,
            check: live.name,
            phase: live.phase,
            since: live.startedAt,
            ...(live.log === undefined ? {} : { log: live.log }),
          },
  }
}

/** An event change holds a place while its folded status is open. */
function stillInLine(state: Row["state"]): boolean {
  return isChangeStatus(state) && isOpen(state)
}

function isChangeStatus(state: string): state is ChangeStatus {
  return (CHANGE_STATUSES as readonly string[]).includes(state)
}

export type Clocks = Readonly<{
  /**
   * How long this attempt's checks ran: from its first check's start to its decision, or to now while a check
   * holds the row. A row no check holds never counts to now, and one whose decision has no instant has none.
   */
  runtimeMs?: number
  /**
   * The ONE clock a row shows, the instant its place in the table is ordered by: when it was submitted, for
   * a change in line (the held and the stuck included); when it ended, for an ended change; when it was
   * committed, for a draft and for a commit that went around the queue.
   */
  clockAt?: Date
  /** How long the check running on it now has run. */
  checkingMs?: number
  /** How long a change in line has waited since it was submitted; absent while its check runs and once it ended. */
  waitingMs?: number
  /**
   * How long a stuck change has been stuck, from its OWN stuck record: never the stop record, which a round
   * writes after it and which a second stuck change under an older stop does not have.
   */
  stuckMs?: number
  /** How long an ended change took, from when it was submitted to when it ended. */
  tookMs?: number
  /** How long since opened: now minus opened for queued/running, ended minus opened for done. */
  ageMs?: number
}>

export function clocks(row: Row, now: Date = new Date()): Clocks {
  // A change waiting in line holds no check, so nothing about it is running:
  // only a check holding the row runs its clock to now (@i/10-yrd/24196).
  const ended = row.state === "merged" || row.state === "failed" || row.state === "cancelled" || row.state === "direct"
  const endedWhen = row.endingAt ?? row.endedAt ?? (ended ? row.at : undefined)
  const until = endedWhen ?? row.endedAt ?? (row.live === undefined ? undefined : now)
  const runtimeMs =
    row.startedAt === undefined || until === undefined
      ? undefined
      : Math.max(0, until.getTime() - row.startedAt.getTime())
  const since = (at: Date | undefined): number | undefined =>
    at === undefined ? undefined : Math.max(0, now.getTime() - at.getTime())
  const waitingState = row.state === "queued" || row.state === "stuck"
  const inLineState = waitingState || row.state === "verifying" || row.state === "checking" || row.state === "merging"
  const clockAt = inLineState ? (row.since ?? row.at) : ended ? (endedWhen ?? row.at) : row.at
  const checkingMs = since(row.live?.since)
  const waitingMs = waitingState && row.live === undefined ? since(row.since) : undefined
  const stuckMs = row.state === "stuck" && row.live === undefined ? since(endedWhen) : undefined
  const tookMs =
    ended && row.state !== "direct" && row.since !== undefined && endedWhen !== undefined
      ? Math.max(0, endedWhen.getTime() - row.since.getTime())
      : undefined
  const ageStart = row.since ?? row.at
  const ageMs = ended
    ? row.since !== undefined && endedWhen !== undefined
      ? Math.max(0, endedWhen.getTime() - row.since.getTime())
      : undefined
    : ageStart === undefined
      ? undefined
      : Math.max(0, now.getTime() - ageStart.getTime())
  return {
    ...(runtimeMs === undefined ? {} : { runtimeMs }),
    ...(clockAt === undefined ? {} : { clockAt }),
    ...(checkingMs === undefined ? {} : { checkingMs }),
    ...(waitingMs === undefined ? {} : { waitingMs }),
    ...(stuckMs === undefined ? {} : { stuckMs }),
    ...(tookMs === undefined ? {} : { tookMs }),
    ...(ageMs === undefined ? {} : { ageMs }),
  }
}

/** The exact ending instants already carried by folded event chains. */
export function endingInstants(changes: ReadonlyMap<string, EventChange>): ReadonlyMap<string, Date> {
  const found = new Map<string, Date>()
  for (const [branch, change] of changes) {
    if (change.ending === undefined) continue
    if (change.endedAt === undefined || Number.isNaN(change.endedAt.getTime())) {
      throw new Error(`event change ${branch} ending ${change.ending.id} has no valid ending instant`)
    }
    found.set(change.ending.id, change.endedAt)
  }
  return found
}

/** How many first parents a merge head's title walk steps back before it keeps the merge's own subject. */
const TITLE_WALK_DEPTH = 8

/**
 * The title of every change in one reading: its head commit's subject, or,
 * when the head is a merge, the subject of the newest non-merge commit on its
 * first-parent line. A merge-only re-cut is still the change it re-cut, so it
 * keeps that change's title rather than "Merge … into …" (25425).
 *
 * ONE git call for the whole table, never one per row: a list of forty changes
 * used to be forty `git show`s, and at a fifth of a second each that is the
 * difference between a watch that refreshes and one that stutters. A merge
 * head adds one batched call per first-parent step, for every merge head at
 * once, at most {@link TITLE_WALK_DEPTH} of them.
 * `--ignore-missing` is what makes it one call — an object this repository has
 * not fetched is simply not in the answer, and the caller sees no entry for
 * that head rather than an empty subject.
 */
export async function subjects(git: Git, heads: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const wanted = [...new Set(heads)].filter((head) => head !== "")
  // Git with no revision walks HEAD, so an empty table must not ask at all.
  if (wanted.length === 0) return new Map()
  const read = async (shas: readonly string[]) => {
    const out = await git(["log", "--ignore-missing", "--no-walk=unsorted", "--format=%H%x00%P%x00%s", ...shas])
    const commits = new Map<string, Readonly<{ parents: readonly string[]; subject: string }>>()
    for (const line of out.split("\n")) {
      const [sha, parents, subject] = line.split("\0")
      if (sha === undefined || parents === undefined || subject === undefined) continue
      if (!/^[0-9a-f]{40}$/u.test(sha)) continue
      commits.set(sha, { parents: parents.split(" ").filter((parent) => parent !== ""), subject })
    }
    return commits
  }
  const found = new Map<string, string>()
  // Each merge head, and the first parent its walk has reached.
  let walking = new Map<string, string>()
  for (const [sha, commit] of await read(wanted)) {
    found.set(sha, commit.subject)
    const first = commit.parents[0]
    if (commit.parents.length > 1 && first !== undefined) walking.set(sha, first)
  }
  for (let depth = 0; walking.size > 0 && depth < TITLE_WALK_DEPTH; depth++) {
    const commits = await read([...new Set(walking.values())])
    const next = new Map<string, string>()
    for (const [head, at] of walking) {
      const commit = commits.get(at)
      // A first parent this repository has not fetched: the merge's own subject stands.
      if (commit === undefined) continue
      const first = commit.parents[0]
      if (commit.parents.length > 1 && first !== undefined) next.set(head, first)
      else found.set(head, commit.subject)
    }
    walking = next
  }
  return found
}

function resultOf(kind: string, check: string | undefined): string {
  switch (kind) {
    case "checked":
    case "merged":
      return check === undefined ? "pass" : `pass ${check}`
    case "failed":
      return check === undefined ? "fail" : `fail ${check}`
    case "stuck":
      return check === undefined ? "stuck" : `stuck ${check}`
    case "deferred":
      return check === undefined ? "deferred" : `deferred ${check}`
    default:
      return kind
  }
}
