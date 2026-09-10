/**
 * One queue run ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design,
 * The queue run and Attribution).
 *
 * Read the checks from the target. For every queued change, oldest first: a
 * settled composition of the target plus the head and the on-submit checks;
 * pass writes checked, fail writes failed and tells the submitter, stuck writes
 * stuck and stops the run. Then the first checked change in line is composed
 * and settled again for the on-merge checks; pass
 * with the target still at the checked base and the branch still at the head
 * fast-forwards the target to the merge commit. Every ended change sends one
 * message, after its ended record is written, with that record's sha as the id.
 *
 * A failing check sends the change back at once, with the check, its exit, its
 * duration and its log path. Stuck is what the queue could not judge at all —
 * a crash, a missing script, a check past its bound, a check that exits 2, a
 * check the driver could not measure, a submodule whose remote cannot be asked
 * — and nothing else.
 *
 * Every worktree this run makes is prepared before anything is judged in it:
 * the target's `setup:`, once, after materialization and before the first
 * check (worktree.ts). A candidate's setup that does not pass is attributed
 * the way a failing check is: the same setup runs once on the settled base
 * alone, and a base that passes makes the candidate's own content the thing
 * that broke it, so the change ends failed and its submitter is billed. A base
 * that fails is the queue's own ground failing, so the change ends stuck with a
 * complete incident and nobody is billed.
 *
 * A branch at the remote with no change is not a change (E2): the queue read
 * never lists it, so nothing here judges, opens or messages it. `submit` is
 * the one writer of an opened record; a run only ever appends to a change that
 * exists.
 *
 * Only the queue pushes the target, by rule, and every run proves it before
 * it judges anything: each commit on the target's first-parent line since the
 * queue's own history starts that the queue did not put there is reported
 * once, and the run goes on from the new base (E5; the reading is direct.ts).
 *
 * Exit 0 when nothing ended failed or stuck, 1 when a change ended failed,
 * 2 on stuck. A stuck change stays open and the run stops there: the queue
 * could not do its own job, and the next thing to happen is a person.
 */

import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { createProcess, type Process } from "@yrd/process"
import { checkLogPath, checkTrailer, runCheck, type CheckedTree, type CheckResult, type CheckSpec } from "./check.ts"
import {
  DIRECT_MERGE,
  commitTrailers,
  endedKind,
  recordCommit,
  mergedBy,
  mergedByRun,
  trailer,
  readRootChanges,
  cleanupRootChanges,
  type RootChanges,
  type Git,
  type WriteRecord,
} from "./records.ts"
import { queueName, readConfig, type Target } from "./config.ts"
import {
  GitExit,
  gitEnvironment,
  gitIn,
  isAncestor,
  type GitObservation,
  type ObservationNotice,
  mergeBase,
  refAt,
  type GitInvocationOptions,
  type GitSelection,
} from "./git.ts"
import { incidentTrailers, type Incident } from "./incident.ts"
import type { PauseRecord } from "./pause.ts"
import { CHANGE_REF_DIAGNOSTICS, openLog, type LogRecord, type QueueRunLog } from "./log.ts"
import { narrowingOf } from "./narrowing.ts"
import { directMergeCommits, type DirectMerge } from "./direct.ts"
import { changeName, changeRef } from "./refs.ts"
import { composed, type RingOptions } from "./rings.ts"
import { CapturedQueueObjectsUnavailable, readQueue, remoteUrl, type QueueEntry, type QueueRead } from "./remote.ts"
import { GitlinkNotOnRemote, ReferenceUnpopulated } from "./reference.ts"
import { inLine, tipOf } from "./state.ts"
import {
  checkedTree,
  claimWorktrees,
  freshWorktree,
  prepareWorktree,
  reapWorktrees,
  SETUP,
  SetupFailed,
  type PlumbingLog,
  type PreparedWorktree,
  type Reaped,
  type Worktree,
} from "./worktree.ts"

export type QueueRunOptions = Readonly<{
  /** The declaration resolved once by the command/service entry. */
  selection?: GitSelection
  /** The working repository the run reads and writes through. */
  repo: string
  /**
   * Whether `repo` is the queue's OWN clone, and may be given the submodule
   * stores every compose borrows from. Only `resolveQueueLocation` knows, so
   * only it may say; a run against a seat's checkout leaves that tree alone.
   */
  populateReference?: boolean
  /** The branch the queue merges on, at the remote holding it: `<remote>#<branch>`. */
  target: Target
  /** The target commit whose declaration supplied this round's config and checks. */
  targetSha: string
  /** The checks the target declares, read from the target commit by the caller. A check with no `on` runs at merge. */
  checks: readonly CheckSpec[]
  /** The target's `setup:`: one shell command run in every worktree this run makes, before any check runs in it. */
  setup?: string
  /** The blob the checks were read from, recorded on every checked record. */
  configBlob: string
  /** The queue workdir: its logs, its worktrees and its temp root; on the root filesystem. */
  workdir: string
  /** Receives every log record as it is written, for the human rendering. */
  render?: (record: LogRecord) => void
  /** The logger the worktree plumbing narrates to; pass one only at trace. */
  plumbing?: PlumbingLog
  git?: Git
  process?: Process
  env?: NodeJS.ProcessEnv
}> &
  RingOptions

export type QueueRunOutcome = Readonly<{
  observation: GitObservation
  exitCode: 0 | 1 | 2
  log: string
  run: string
  /** The target's commit every judgement was made against, and the config blob the checks came from. */
  base: string
  config: string
  /** The target after the run. */
  target: string
  /** What a ring stopped this round for, before any merge could be made, when one did. */
  stopped?: Stopped
  merged: readonly string[]
  failed: readonly string[]
  stuck: readonly string[]
  /** The commits on the target's first-parent line that the queue did not put there, reported this run (E5). */
  directMerges: readonly string[]
  /**
   * Checked changes still in line that this run did not act on: it merges the
   * FIRST checked change and no more (ruling D4), so a line of five leaves
   * four here. A service reads it to know it has work ready NOW rather than
   * spending its idle cadence between two ready merges. Zero when the run
   * ended before it could read the line.
   */
  checkedWaiting: number
}>

/** Everything one run's steps share. */
export type Run = Readonly<{
  observation: GitObservation
  options: QueueRunOptions
  /** Resources borrowed by rings, released on every return or throw. */
  resources: AsyncDisposableStack
  git: Git
  log: QueueRunLog
  /** The temp root every program this run starts gets as `TMPDIR`: `<workdir>/tmp`. */
  tmpdir: string
  /** An asserted-empty directory that isolates queue-owned Git commits from repository hooks. */
  hooksPath: string
  worktrees: string
  /** The caller's declaration-captured target; every judgement is against it. */
  targetSha: string
  /** The pause record captured in the same remote advertisement as the queue. */
  pause: PauseRecord | undefined
  /** The target OID this run successfully pushed, or its captured starting OID. */
  targetAfter: { sha: string }
  /**
   * Worktrees this run's own reap took down at its start, with what each stood
   * at when git's registration still said so: empty until reaping runs, fixed
   * for the rest of this run after. The one trace an interrupted merge leaves
   * once its change ref cannot yet say so (@i/10-yrd/24344).
   */
  reaped: { list: readonly Reaped[] }
  /** What this queue calls itself wherever a stranger reads it: `<host>/<path>#<branch>`. */
  name: string
  /** The queue as this run read it: every change at the remote, and where each stood. */
  queue: QueueRead
  /**
   * What the worktree plumbing narrates to, for THIS run: the caller's trace
   * logger when there is one, and always this run's journal. The journal half
   * is not optional and not trace-gated — a store the reference had to be given
   * and a compose that did not borrow are facts about the queue's own ground,
   * and they were unreadable for four hours on 2026-09-09 for want of a row.
   */
  plumbing: PlumbingLog
  /** The steps this run is made of, rings and all: every step call goes through these. */
  steps: Steps
  /** Say a ring stopped this round before it could merge; the outcome carries what it said. */
  stop: (stopped: Stopped) => void
}>

type Ended = "checked" | "waiting" | "failed" | "stuck" | "merged"

/** Which side of a change a step is on: the head it was submitted at, or its merge with the target. */
type CandidatePhase = "submit" | "merge"
type Phase = CandidatePhase | "base"

/** What an ending record will say, before it is written. */
type EndedWrite = Readonly<{
  subject: string
  trailers: readonly (readonly [string, string])[]
  remedy?: string
  /** The foreign diagnosis, preserved verbatim in this ending's existing journal row. */
  diagnosis?: SuperMergeDetail
  incident?: Incident
  detail?: string
  worktree?: string
}>

/**
 * A ring stopped this round before it could merge, and says so.
 *
 * `ring` names the ring, `says` is its one line for a person, and `what` is the
 * ring's own record of the stop, whose shape only that ring and its readers
 * know. The loop carries it out on the outcome and reads none of it.
 */
export type Stopped = Readonly<{ ring: string; says: string; what: unknown }>

/**
 * One atomic push as a plan, so a ring can add to it before it is made: the refs
 * it moves, `[object, ref]`, and the leases proving nobody else moved them,
 * `[ref, expected]`.
 */
export type PushPlan = Readonly<{
  updates: readonly (readonly [string, string])[]
  leases: readonly (readonly [string, string])[]
}>

/**
 * What one atomic push did. A push that did not merge names what moved under it
 * when the pusher could read one; no `reason` is a push that found nothing
 * moved, and its caller raises `error` rather than inventing a race.
 */
export type Pushed =
  | Readonly<{ merged: true }>
  | Readonly<{ merged: false; reason?: string; saw?: string; error: unknown }>

/**
 * The steps one run is made of, every member a function, so a ring is a function
 * from this bundle to this bundle: a feature is one file and one line of
 * rings.ts, and deleting those two takes the whole of it.
 *
 * Every step call inside a run goes through `Run.steps`, the composed bundle,
 * so a ring sees every call rather than only the ones the loop happens to make.
 */
export type Steps = Readonly<{
  /** Once, at the top of the round. A value stops the round and becomes its outcome. */
  open: (run: Run) => Promise<Stopped | undefined>
  /**
   * One pass per entry before anything is judged: retires a moved-off or
   * deleted branch, catches ancestry up on a record, and ends an orphaned
   * merge honestly rather than let it be redone. `"stuck"` when the last of
   * those ended the entry stuck, so the loop stops the round the same way a
   * stuck judge or merge does.
   */
  bookkeep: (run: Run, entry: QueueEntry) => Promise<"stuck" | undefined>
  prepare: (run: Run, entry: QueueEntry, commit: string, path: string, phase: Phase) => Promise<PreparedWorktree>
  judge: (run: Run, entry: QueueEntry) => Promise<Ended>
  merge: (run: Run, entry: QueueEntry) => Promise<Ended>
  /** The one atomic push a merge makes; a ring adds to the plan before it is made. */
  push: (run: Run, entry: QueueEntry, plan: PushPlan) => Promise<Pushed>
  end: (run: Run, entry: QueueEntry, kind: "failed" | "stuck", ended: EndedWrite) => Promise<Ended>
  /** A change ended and its record is written; whoever wants to hear it hears it here. */
  ended: (
    run: Run,
    entry: QueueEntry,
    kind: "merged" | "failed" | "stuck",
    endedRecord: string,
    appendTip: string,
  ) => Promise<void>
  /** The same, for a commit that went around the queue: there is no change to end. */
  direct: (run: Run, commit: DirectMerge) => Promise<void>
  observed: (run: Run, notice: ObservationNotice) => Promise<void>
}>

/** One ring of the onion: the same bundle, with the members it owns wrapped. */
export type Ring = (steps: Steps) => Steps

/**
 * A candidate's setup did not pass, carrying what deciding whose failure it is
 * needs and nothing else: the phase whose worktree it was, and the gitlinks
 * composition settled into that worktree, so the settled base can be built the
 * same way. A base worktree's own setup failure stays a bare `SetupFailed`,
 * because there is no further ground left to judge it against.
 */
class CandidateSetupFailed extends Error {
  constructor(
    readonly setup: SetupFailed,
    readonly phase: CandidatePhase,
    readonly raises: RootChanges["changes"],
  ) {
    super(setup.message, { cause: setup })
    this.name = "CandidateSetupFailed"
  }
}

/** An authority read failed outside any one change's responsibility. */
export class QueueAuthorityUnreadable extends Error {
  constructor(authority: string, error: unknown) {
    super(`${authority} could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    this.name = "QueueAuthorityUnreadable"
  }
}

function gitInvocationOptions(options: QueueRunOptions, log: QueueRunLog): GitInvocationOptions {
  return {
    ...(options.env === undefined ? {} : { env: options.env }),
    openOutput: log.openGitOutput,
    onInvocation: log.writeGitInvocation,
  }
}

export async function queueRun(options: QueueRunOptions): Promise<QueueRunOutcome> {
  await using resources = new AsyncDisposableStack()
  const log = openLog(join(options.workdir, "logs"), undefined, options.render)
  const selected = gitIn(options.repo, options.process, options.selection, gitInvocationOptions(options, log))
  const git = options.git ?? selected
  const hooksPath = join(options.workdir, "hooks-disabled")
  mkdirSync(hooksPath, { recursive: true })
  const hooks = readdirSync(hooksPath).sort()
  if (hooks.length > 0) {
    throw new Error(
      `queue-owned hooks path ${hooksPath} is not empty (${hooks.join(", ")}); remove the named entries, then run yrd queue run`,
    )
  }
  const targetSha = options.targetSha
  // One captured-object refusal earns one retry across the whole round. Keep
  // that first failure even after a successful retry: if the post-judge read
  // then fails, the one error names both facts rather than erasing the first.
  let retried: CapturedQueueObjectsUnavailable | undefined
  const failedAgain = (first: CapturedQueueObjectsUnavailable, error: unknown): AggregateError => {
    const later = error instanceof Error ? error.message : String(error)
    return new AggregateError(
      [first, error],
      `${first.message}; after one queue-read retry, another read failed: ${later}`,
      { cause: first },
    )
  }
  const read = async () => {
    try {
      return await readQueue(git, options.target.remote, options.target.branch, targetSha)
    } catch (error) {
      if (retried !== undefined) throw failedAgain(retried, error)
      if (!(error instanceof CapturedQueueObjectsUnavailable)) throw error
      retried = error
      try {
        return await readQueue(git, options.target.remote, options.target.branch, targetSha)
      } catch (again) {
        throw failedAgain(error, again)
      }
    }
  }
  const queue = await read()
  const url = await remoteUrl(git, options.target.remote)
  const name = queueName(options.target, url)
  // The run row: the gitlink (the target's commit) and the config blob the checks
  // were read from. Each change CONSIDERED writes its own row with its decision
  // when the run has made one; a change that ended in an earlier run is history,
  // and this run claims nothing about it.
  log.write({
    base: targetSha,
    checks: options.checks.map((check) => check.name),
    config: options.configBlob,
    kind: "run",
    gitlink: targetSha,
    queue: name,
    target: options.target.branch,
  })

  const observation = await selected.observe({
    version: 1,
    root: { remote: url, targetRef: `refs/heads/${options.target.branch}`, targetOid: targetSha },
    ...queue.observation,
  })
  let stopped: Stopped | undefined
  const run: Run = {
    observation,
    resources,
    git,
    hooksPath,
    log,
    name,
    options,
    pause: queue.pause,
    // The caller's trace half, kept exactly as it was passed, plus this run's
    // journal, which is always wired: the two halves answer different questions
    // and only one of them is a git transcript nobody turned on.
    plumbing: { ...options.plumbing, journal: log.write },
    queue: queue.changes,
    reaped: { list: [] },
    steps: composed(BASE),
    stop: (said) => {
      stopped = said
    },
    tmpdir: join(options.workdir, "tmp"),
    targetSha,
    targetAfter: { sha: targetSha },
    worktrees: join(options.workdir, "worktrees", log.id),
  }
  mkdirSync(run.worktrees, { recursive: true })
  // This run's own claim first, so a run starting alongside this one never
  // reads the absence of a pid file as this run's death.
  claimWorktrees(run.worktrees)
  const merged: string[] = []
  const failed: string[] = []
  const stuck: string[] = []

  const entries = queue.changes

  log.write({
    kind: "observation",
    contract: observation.contract,
    ...(observation.contract === "native" ? {} : { outcome: observation.outcome }),
    message: observation.message,
  })
  if (observation.contract === "root-v1" && observation.outcome !== "observed") {
    return finish(run, observation.outcome === "invalid" ? 2 : 0, {
      checkedWaiting: 0,
      directMerges: [],
      failed,
      merged,
      stuck,
    })
  }
  for (const notice of observation.notices) {
    log.write({ kind: "observation", id: notice.id, text: notice.text })
    await run.steps.observed(run, notice)
  }

  // The worktrees of runs that are no longer alive, taken down before this run
  // makes any of its own: a killed run removes nothing, so its worktrees stay
  // registered in the repository and on disk until some later run clears them
  // (plan § Owed after M5; R8's stayed). One row per worktree, because a
  // directory that vanishes with nothing said about it is the silent kind of
  // cleanup nobody can audit.
  const reaped = await reapWorktrees(git, join(options.workdir, "worktrees"), log.id)
  run.reaped.list = reaped
  for (const taken of reaped) {
    log.write({
      kind: "reap",
      of: taken.of,
      path: taken.path,
      why: taken.why,
      ...(taken.head === undefined ? {} : { head: taken.head }),
    })
  }

  // Did something go around the queue? Read before any record is written, so a
  // direct that merged a submitted head is reported before the catch-up below
  // accounts for it (E5). Nothing stops for it: the run judges every change on
  // the base it read.
  const directMerges = await reportDirectMerges(run, entries)

  // A ring stops the round here. Reaping only cleans local scratch, and direct
  // reporting only observes work already done outside the queue. Everything
  // below writes a change record or tells somebody about one, so a stopped round
  // leaves every change exactly as it found it while still surfacing direct merges.
  stopped = await run.steps.open(run)
  if (stopped !== undefined) return finish(run, 0, { checkedWaiting: 0, directMerges, failed, merged, stuck }, stopped)

  // Bookkeeping at the edges of the records first, so every reader below reads
  // records and never reconciles. A bookkeeping pass can itself end an entry
  // stuck (an orphaned merge recovery could not trust, @i/10-yrd/24344), and
  // that stops the round exactly like a stuck judge or merge does.
  for (const entry of entries) {
    if ((await run.steps.bookkeep(run, entry)) === "stuck") {
      stuck.push(entry.change.branch)
      return finish(run, 2, { checkedWaiting: 0, directMerges, failed, merged, stuck })
    }
  }

  // On-submit: every queued change, oldest first, in a fresh worktree of its
  // head. A stuck change kept its place, and this run takes it again from
  // here; so does a checked change whose checks ran under a check config the
  // target no longer declares (§ The queue run: a checked record is reused only
  // while the config blob is the one it names).
  for (const entry of ordered(entries, "queued", "stuck", "checked").filter(
    (entry) => entry.reading.state !== "checked" || staleChecked(run, entry),
  )) {
    const outcome = await guarded(run, entry, () => run.steps.judge(run, entry))
    if (outcome === "stuck") {
      stuck.push(entry.change.branch)
      return finish(run, 2, { checkedWaiting: 0, directMerges, failed, merged, stuck })
    }
    if (outcome === "failed") failed.push(entry.change.branch)
  }

  // On-merge: the first checked change in line, re-read so this run's own
  // checked records count.
  const line = ordered((await read()).changes, "checked").filter((entry) => !staleChecked(run, entry))
  const checked = line[0]
  if (checked !== undefined) {
    const outcome = await guarded(run, checked, () => run.steps.merge(run, checked))
    if (outcome === "stuck") stuck.push(checked.change.branch)
    else if (outcome === "failed") failed.push(checked.change.branch)
    else if (outcome === "merged") merged.push(checked.change.branch)
  }

  return finish(
    run,
    stuck.length > 0 ? 2 : failed.length > 0 ? 1 : 0,
    // Everything this run left checked behind the one it acted on. Read from
    // the line it already re-read, so saying it costs no second look.
    { checkedWaiting: Math.max(0, line.length - 1), directMerges, failed, merged, stuck },
    stopped,
  )
}

/**
 * The queue with no rings on it: the bare loop's own steps, which rings.ts
 * wraps in order. Every one of them is reached through `Run.steps` and never by
 * name, so a ring that wraps one sees every call to it.
 */
const BASE: Steps = { bookkeep, direct, observed, end, ended, judge, merge, open, prepare, push }

/** A checked change whose checked record names a config blob the target no longer declares. */
function staleChecked(run: Run, entry: QueueEntry): boolean {
  const tip = tipOf(entry.change)
  return tip.kind === "checked" && trailer(tip, "Config") !== run.options.configBlob
}

/** The entries in the named states, in line order. */
function ordered(entries: QueueRead, ...states: readonly ("queued" | "checked" | "stuck")[]): readonly QueueEntry[] {
  const byHead = new Map(entries.map((entry) => [entry.change.head, entry]))
  return inLine(entries.map((entry) => entry.change))
    .map((change) => byHead.get(change.head))
    .filter(
      (entry): entry is QueueEntry =>
        entry !== undefined && (states as readonly string[]).includes(entry.reading.state),
    )
}

/**
 * Every commit on the target's first-parent line since the cutover that the
 * queue did not put there, each reported once: a log record with the commit,
 * its parents, its subject and the gitlinks it moved, and then whatever a ring
 * makes of it (E5). No record is written, because there is no change to write
 * one on; what the queue has already accounted for is read from git
 * (direct.ts), so a second run says nothing new once the queue has landed
 * on top. The run never stops for it: the queue adapts already, judging every
 * change on the base it read.
 */
async function reportDirectMerges(run: Run, entries: QueueRead): Promise<readonly string[]> {
  const found = await directMergeCommits(run.git, run.options.target.branch, run.targetSha, entries)
  const target = run.options.target.branch
  for (const commit of found) {
    run.log.write({
      branch: target,
      commit: commit.commit,
      gitlinks: commit.gitlinks,
      kind: "merged-direct",
      parents: commit.parents,
      subject: commit.subject,
      why: commit.why,
    })
    await run.steps.direct(run, commit)
  }
  return found.map((commit) => commit.commit)
}

/** Nothing stops the round: a queue with no ring on it runs every round it is given. */
function open(): Promise<Stopped | undefined> {
  return Promise.resolve(undefined)
}

/**
 * One pass over one entry before anything is judged: a branch that is gone or
 * moved off a head ends that head's change failed with the reason and no
 * message (ruling B3); a head the target already carries gets its merged
 * record, so the tip catches up with ancestry; and a "checked" change whose
 * merge candidate was composed by a run that died before recording it is
 * settled or ended honestly, never left for a blind retry to redo
 * (@i/10-yrd/24344).
 */
async function bookkeep(run: Run, entry: QueueEntry): Promise<"stuck" | undefined> {
  await retire(run, entry)
  await catchUp(run, entry)
  return recoverOrphanedMerge(run, entry)
}

/**
 * A change ended and its record is written. The base does nothing more with
 * that: the record IS the ending, and a reader who asks the remote sees it
 * whether or not anybody was told. Telling somebody is a ring's.
 */
async function ended(): Promise<void> {}

/** The same, for a commit that went around the queue. */
async function direct(): Promise<void> {}
async function observed(): Promise<void> {}

/**
 * There is exactly one exit site (§ The queue run): a crash while judging a
 * change ends that change stuck, the queue's, with the crash as its cause, and
 * the run exits 2 like any other stuck. A crash inside that ending itself has
 * nowhere left to go and reaches the caller, which exits 2 too.
 */
async function guarded(run: Run, entry: QueueEntry, step: () => Promise<Ended>): Promise<Ended> {
  try {
    return await step()
  } catch (error) {
    if (error instanceof QueueAuthorityUnreadable) throw error
    // A candidate's setup that did not pass is the one crash whose owner the
    // queue can read rather than assume: `attributedSetupFailure` runs the same
    // setup on the settled base and bills whoever the ground names.
    if (error instanceof CandidateSetupFailed) return await attributedSetupFailure(run, entry, error)
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim()
    // A setup that did not pass anywhere a candidate could be attributed from —
    // the settled base's own worktree — is the queue's: it could not build the
    // ground a judgement stands on, so the reason says setup and not crash.
    if (error instanceof SetupFailed) {
      return run.steps.end(
        run,
        entry,
        "stuck",
        stuckWrite(run, {
          code: "yrd-setup-unusable",
          next: "repair the queue setup, then run yrd queue run",
          subject: `the queue could not prepare a worktree for ${entry.change.branch}: ${message}`,
          via: SETUP,
        }),
      )
    }
    // THE SUBMITTER'S, and the only failure on this path that is. A pin the
    // reference could not fetch has two causes with opposite owners, separated
    // by one `ls-remote` before we get here: a remote that answered and simply
    // does not hold the commit is a component commit that never left somebody's
    // bay. Nothing is wrong with the queue, so nothing about the queue is
    // repaired by stopping it — the change fails, its submitter is billed, and
    // the line moves. Specimen 2026-09-03: a root carrier stood at km gitlink
    // 11d9312c, which existed only in the author's bay, and the queue billed
    // itself and stopped.
    if (error instanceof GitlinkNotOnRemote) {
      return run.steps.end(run, entry, "failed", {
        remedy:
          `push the component commit to its remote (it must be on the component's main ` +
          `before a root carrier may carry it), then resubmit`,
        subject: `${entry.change.branch}: gitlink ${error.path} at ${error.sha} is not on ${error.url}`,
        trailers: [
          ["Reason", "gitlink-not-on-remote"],
          // What the attribution READ, so the record answers "why is a missing
          // pin the submitter's here" without its reader going to the journal:
          // the remote answered, and did not have this commit.
          ["Remote-Answered", "yes"],
          ["Gitlink", `${error.path}@${error.sha}`],
        ],
      })
    }
    // The other crash with a name, and the same shape as setup: the reference
    // repository is the queue's own ground, so a gitlink it cannot be given a
    // store for is never the submitter's fault. The remedy names the populate
    // step rather than "repair the queue fault", because the store is the thing
    // to repair and an operator reading a crash ending would go looking at the
    // change instead.
    if (error instanceof ReferenceUnpopulated) {
      return run.steps.end(
        run,
        entry,
        "stuck",
        stuckWrite(run, {
          code: "yrd-reference-unpopulated",
          next:
            error.path === undefined
              ? `populate the queue's reference repository ${error.repo} with the command the refusal in this incident names, then run yrd queue run`
              : `give the queue's reference repository a store for '${error.path}' — ` +
                `git -C ${error.repo} submodule update --init -- ${error.path} — then run yrd queue run`,
          subject: `the queue's reference repository cannot be borrowed from for ${entry.change.branch}: ${message}`,
          via: "reference population",
        }),
      )
    }
    return run.steps.end(
      run,
      entry,
      "stuck",
      stuckWrite(run, {
        code: "yrd-queue-crash",
        next: "repair the queue fault, then run yrd queue run",
        subject: `the queue crashed judging ${entry.change.branch}: ${message}`,
        via: "queue run",
        ...(error instanceof GitExit ? { detail: error.detail } : {}),
      }),
    )
  }
}

/**
 * A fresh worktree of `commit`, with the target's `setup:` run in it before
 * anything judges it (§ The queue run). The setup's log and temp root are the
 * phase's own, so one worktree's records sit together, and its result is
 * recorded in the check's shape: what ran, then how it ended.
 *
 * A CANDIDATE setup that did not pass writes its end row here and leaves its
 * verdict row to `attributedSetupFailure`, because that row's `whose` IS the
 * attribution and nothing here has read the ground it stood on yet. A base
 * worktree's setup, and any setup that passed, is decided the moment it ends.
 */
async function prepare(
  run: Run,
  entry: QueueEntry,
  commit: string,
  path: string,
  phase: Phase,
): Promise<PreparedWorktree> {
  const logDir = checkLogDir(run, entry, phase)
  const about = { branch: entry.change.branch, head: entry.change.head, name: SETUP, phase }
  return prepareWorktree(run.git, run.options.repo, commit, path, {
    env: run.options.env,
    populateReference: run.options.populateReference,
    selection: run.options.selection,
    gitOptions: gitInvocationOptions(run.options, run.log),
    plumbing: run.plumbing,
    process: run.options.process,
    record: ({ result, start, end: ended }) => {
      const row = { ...about, end: ended, start }
      if (phase === "base" || result.result === "pass") recordProgramResult(run, row, result)
      else recordProgramEnd(run, row, result)
    },
    ...(run.options.setup === undefined ? {} : { setup: { logDir, run: run.options.setup, tmpdir: run.tmpdir } }),
    starting: ({ log, start }) => recordProgramStart(run, { ...about, log, start }),
    targetSha: run.targetSha,
  })
}

/** The on-submit phase for one queued change. */
async function judge(run: Run, entry: QueueEntry): Promise<Ended> {
  const { change } = entry
  const { branch, head } = change
  // The built-in check: the head shares ancestry with the target. The target
  // moves under every queued change by design, so "descends from the tip" would
  // fail every change behind a merge; an unrelated history is what a merge
  // must never splice in.
  if ((await mergeBase(run.git, head, run.targetSha)) === undefined) {
    return run.steps.end(run, entry, "failed", {
      remedy: `rebase ${branch} onto ${run.options.target.branch} and submit again`,
      subject: `${branch} shares no history with ${run.options.target.branch}`,
      trailers: [["Reason", "unrelated-history"]],
    })
  }
  const composed = await composeCandidate(run, entry, "submit")
  if (composed.kind === "waiting") return waiting(run, entry, composed.detail)
  if (composed.kind === "failed") return candidateFailure(run, entry, composed.detail, composed.worktree)
  const { worktree } = composed
  try {
    const results = await runPhase(run, entry, "submit", worktree.path, worktree.tree)
    const stuckOne = results.find((result) => result.result === "stuck")
    if (stuckOne !== undefined) {
      return await run.steps.end(
        run,
        entry,
        "stuck",
        stuckWrite(run, {
          code: "yrd-check-unresolved",
          next: `repair ${stuckOne.name} or its queue environment, then run yrd queue run`,
          subject: `the queue could not judge ${branch}: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
          trailers: checkTrailers(results),
          via: `${stuckOne.name} during submit`,
        }),
      )
    }
    const failing = results.filter((result) => result.result === "fail")
    if (failing.length > 0) {
      return await attributedFailure(run, entry, results, failing, "submit", composed.rootChanges?.changes ?? [])
    }
    await writeRecord(
      run,
      {
        change,
        kind: "checked",
        subject: `${branch} passed the on-submit checks at ${run.options.target.branch} ${run.targetSha.slice(0, 12)}`,
        trailers: [["Config", run.options.configBlob], ["Base", run.targetSha], ...checkTrailers(results)],
      },
      tipOf(entry.change).sha,
    )
    return "checked"
  } finally {
    await worktree.remove()
  }
}

type SuperMergeDetail = Readonly<{
  code: string
  phase: string
  message: string
  subject?: string
  next?: string
}>

type SettledGitlink = Readonly<{
  path: string
  from: string
  to: string
  state: "raised" | "kept-ahead" | "as-written" | "left-off-main" | "not-run"
}>

type SuperMergeResult = Readonly<{
  state: "updated" | "unchanged" | "failed" | "unknown"
  partial: boolean
  commit?: string
  detail?: SuperMergeDetail
  gitlinks: readonly SettledGitlink[]
}>

type ComposedCandidate =
  | Readonly<{ kind: "ready"; mergeCommit: string; rootChanges?: RootChanges; worktree: PreparedWorktree }>
  | Readonly<{ kind: "waiting"; detail: SuperMergeDetail }>
  | Readonly<{ kind: "failed"; detail: SuperMergeDetail; worktree: Worktree }>

/** Compose and settle the exact tree a phase will judge, then materialize that final commit before setup or checks run. */
async function composeCandidate(run: Run, entry: QueueEntry, phase: CandidatePhase): Promise<ComposedCandidate> {
  const { head } = entry.change
  const composing = await freshWorktree(
    run.git,
    run.options.repo,
    run.targetSha,
    join(run.worktrees, "compose", phase, head.slice(0, 12)),
    {
      env: run.options.env,
      gitOptions: gitInvocationOptions(run.options, run.log),
      plumbing: run.plumbing,
      populateReference: run.options.populateReference,
      process: run.options.process,
      selection: run.options.selection,
    },
  )
  const result = await superMerge(run, composing.path, head, mergeMessage(run, entry))
  if (result.state !== "updated" || result.partial) {
    const detail = result.detail
    if (detail === undefined) {
      throw new Error(`git-super merge of ${head} returned ${result.state} without a failure detail`)
    }
    if (detail.code !== "gitlink-off-main") return { detail, kind: "failed", worktree: composing }
    await composing.remove()
    return { detail, kind: "waiting" }
  }
  if (result.commit === undefined) throw new Error(`git-super merge of ${head} reported updated without a commit`)
  await composing.remove()

  const mergeCommit = result.commit
  if (mergeCommit === undefined) throw new Error(`git-super merge of ${head} lost its commit after composition`)
  const rootChanges = await readRootChanges(run.git, mergeCommit)
  for (const settled of result.gitlinks.filter((row) => row.state !== "not-run")) {
    run.log.write({
      branch: entry.change.branch,
      from: settled.from,
      head,
      kind: "settle",
      path: settled.path,
      phase,
      state: settled.state,
      to: settled.to,
    })
  }
  let worktree: PreparedWorktree
  try {
    worktree = await run.steps.prepare(run, entry, mergeCommit, join(run.worktrees, phase, head.slice(0, 12)), phase)
  } catch (error) {
    // The one place that knows both facts the attribution needs: which phase's
    // candidate this was, and what composition settled into it.
    if (!(error instanceof SetupFailed)) throw error
    throw new CandidateSetupFailed(error, phase, rootChanges?.changes ?? [])
  }
  return { kind: "ready", mergeCommit, ...(rootChanges === undefined ? {} : { rootChanges }), worktree }
}

/** Run git-super as the ruled command boundary; malformed or truncated JSON is never treated as a verdict. */
async function superMerge(run: Run, cwd: string, commit: string, message: string): Promise<SuperMergeResult> {
  const execution = await gitSuperExecution(run, cwd, ["merge", commit, "-m", message])
  let parsed: unknown
  try {
    parsed = JSON.parse(execution.stdout)
  } catch (error) {
    throw new Error(
      `git-super merge exited ${String(execution.exitCode)} without readable JSON: ${execution.stderr.trim() || execution.stdout.trim()}`,
      { cause: error },
    )
  }
  const result = readSuperMergeResult(parsed)
  if (execution.exitCode === 0 && result.state === "updated" && !result.partial) return result
  if ((execution.exitCode === 1 || execution.exitCode === 2) && result.detail !== undefined) return result
  throw new Error(
    `git-super merge exit/result disagreement: exit=${String(execution.exitCode)} state=${result.state} partial=${String(result.partial)}`,
  )
}

async function gitSuperExecution(
  run: Run,
  cwd: string,
  argv: readonly string[],
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  const owned = run.options.process === undefined
  const process =
    run.options.process ?? createProcess({ cwd, env: gitEnvironment(run.options.env ?? globalThis.process.env) })
  try {
    const execution = await process.run({
      argv: ["git", "-c", `core.hooksPath=${run.hooksPath}`, "super", "--json", ...argv],
      cwd,
      env: gitEnvironment(run.options.env ?? globalThis.process.env),
    })
    if (
      execution.timedOut ||
      execution.stalled === true ||
      execution.signal !== null ||
      execution.sweepFailure !== undefined ||
      execution.escapedDescendant === true
    ) {
      throw new Error(
        `git-super ${argv[0] ?? "command"} did not settle normally: exit=${String(execution.exitCode)} signal=${execution.signal ?? "none"} timedOut=${String(execution.timedOut)} stalled=${String(execution.stalled === true)}${execution.sweepFailure === undefined ? "" : `; ${execution.sweepFailure}`}`,
      )
    }
    if (execution.outputTruncation !== undefined) {
      throw new Error(
        `git-super ${argv[0] ?? "command"} output was truncated: ${JSON.stringify(execution.outputTruncation)}`,
      )
    }
    return execution
  } finally {
    if (owned) await process.close()
  }
}

function readSuperMergeResult(value: unknown): SuperMergeResult {
  if (typeof value !== "object" || value === null) throw new Error("git-super merge JSON is not an object")
  const found = value as Record<string, unknown>
  if (!new Set(["updated", "unchanged", "failed", "unknown"]).has(String(found.state))) {
    throw new Error(`git-super merge JSON has invalid state ${String(found.state)}`)
  }
  if (typeof found.partial !== "boolean") throw new Error("git-super merge JSON has no boolean partial field")
  if (!Array.isArray(found.gitlinks)) throw new Error("git-super merge JSON has no gitlinks array")
  const gitlinks = found.gitlinks.map((row, index): SettledGitlink => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`git-super merge gitlink ${String(index)} is not an object`)
    }
    const entry = row as Record<string, unknown>
    if (
      typeof entry.path !== "string" ||
      typeof entry.from !== "string" ||
      typeof entry.to !== "string" ||
      !new Set(["raised", "kept-ahead", "as-written", "left-off-main", "not-run"]).has(String(entry.state))
    ) {
      throw new Error(`git-super merge gitlink ${String(index)} is incomplete`)
    }
    return entry as SettledGitlink
  })
  const detail = found.detail === undefined ? undefined : readSuperMergeDetail(found.detail)
  return {
    state: found.state as SuperMergeResult["state"],
    partial: found.partial,
    ...(typeof found.commit === "string" ? { commit: found.commit } : {}),
    ...(detail === undefined ? {} : { detail }),
    gitlinks,
  }
}

function readSuperMergeDetail(value: unknown): SuperMergeDetail {
  if (typeof value !== "object" || value === null) throw new Error("git-super merge detail is not an object")
  const detail = value as Record<string, unknown>
  if (typeof detail.code !== "string" || typeof detail.phase !== "string" || typeof detail.message !== "string") {
    throw new Error("git-super merge detail has no code, phase, or message")
  }
  return {
    code: detail.code,
    phase: detail.phase,
    message: detail.message,
    ...(typeof detail.subject === "string" ? { subject: detail.subject } : {}),
    ...(typeof detail.next === "string" ? { next: detail.next } : {}),
  }
}

function mergeMessage(run: Run, entry: QueueEntry): string {
  const { branch, head } = entry.change
  const tip = tipOf(entry.change)
  const issue = trailer(tip, "Issue")
  const submitter = trailer(tip, "Submitter")
  return [
    `merge ${short(branch, head)} into ${run.options.target.branch}`,
    "",
    `Change: ${changeName(entry.change)}`,
    `Merged-By: ${mergedBy(run.options.target.branch, run.log.id)}`,
    ...(issue === undefined ? [] : [`Issue: ${issue}`]),
    ...(submitter === undefined ? [] : [`Submitter: ${submitter}`]),
  ].join("\n")
}

async function waiting(run: Run, entry: QueueEntry, detail: SuperMergeDetail): Promise<Ended> {
  const subject = (detail.subject ?? detail.message).replace(/\s+/gu, " ").trim()
  const incident = {
    code: "gitlink-off-main" as const,
    subject,
    via: `git-super merge (${detail.code}, ${detail.phase}) in yrd queue ${run.name} [${run.log.id}]`,
    evidence: run.log.path,
    owner: "the queue operator",
    next: detail.next ?? "push the named submodule commit to its main, then run yrd queue run",
  }
  const tip = tipOf(entry.change)
  const sameWait =
    trailer(tip, "Code") === incident.code &&
    trailer(tip, "Subject") === incident.subject &&
    trailer(tip, "Next") === incident.next
  if (!sameWait) {
    await writeRecord(
      run,
      {
        change: entry.change,
        kind: "opened",
        subject,
        trailers: incidentTrailers(incident),
      },
      tip.sha,
    )
  }
  // The journal row carries the same complete incident as the record: a reader
  // that finds one incident field and not all six refuses the whole journal,
  // and every read verb with it, for as long as the journal is in its window.
  run.log.write({
    branch: entry.change.branch,
    decision: entry.reading.state === "checked" ? "checked" : "queued",
    head: entry.change.head,
    kind: "change",
    reason: detail.message,
    ...incident,
    diagnosisCode: detail.code,
    phase: detail.phase,
  })
  return "waiting"
}

async function candidateFailure(
  run: Run,
  entry: QueueEntry,
  detail: SuperMergeDetail,
  worktree: Worktree,
): Promise<Ended> {
  if (detail.code === "merge-conflict") {
    await worktree.remove()
    return run.steps.end(run, entry, "failed", {
      remedy: detail.next ?? `rebase ${entry.change.branch} onto ${run.options.target.branch} and submit again`,
      subject: detail.subject ?? `${entry.change.branch} conflicts with ${run.options.target.branch}`,
      trailers: [
        ["Reason", "conflict"],
        ["Detail", detail.message],
      ],
    })
  }
  if (detail.phase === "prove-gitlink-on-main") {
    await worktree.remove()
    const reason = detail.message.replace(/\s+/gu, " ").trim()
    return run.steps.end(run, entry, "failed", {
      remedy: detail.next ?? "publish a materializable submodule commit, then submit again",
      subject: (detail.subject ?? detail.message).replace(/\s+/gu, " ").trim(),
      trailers: [["Reason", reason]],
    })
  }
  return run.steps.end(run, entry, "stuck", {
    ...stuckWrite(run, {
      code: "yrd-merge-unresolved",
      detail: detail.message,
      next: detail.next ?? "repair the queue fault, then run yrd queue run",
      subject: detail.message,
      via: `git-super merge (${detail.code}, ${detail.phase}) at ${worktree.path}`,
      worktree: worktree.path,
    }),
    diagnosis: detail,
  })
}

async function attributedFailure(
  run: Run,
  entry: QueueEntry,
  results: readonly CheckResult[],
  failing: readonly CheckResult[],
  phase: CandidatePhase,
  raises: RootChanges["changes"],
): Promise<Ended> {
  if (raises.length === 0) return endFailing(run, entry, results, failing, phase)
  // What the base run must measure, asked of the checks that failed, BEFORE
  // the base tree is composed: the answer is read off logs the candidate phase
  // already wrote, and it decides how long the composition it precedes will be
  // used for.
  const narrowed = await narrowedBase(run, entry, failing)
  const base = await prepareSettledBase(run, entry, raises)
  try {
    const baseResults = await runPhase(run, entry, phase, base.path, base.tree, "base", narrowed)
    const unresolved = baseResults.find((result) => result.result === "stuck")
    if (unresolved !== undefined) {
      return await run.steps.end(
        run,
        entry,
        "stuck",
        stuckWrite(run, {
          code: "yrd-check-unresolved",
          next: `repair ${unresolved.name} or its queue environment, then run yrd queue run`,
          subject:
            `the queue could not judge the settled base for ${entry.change.branch}: ${unresolved.name} ${unresolved.why ?? ""}`.trim(),
          trailers: checkTrailers(baseResults),
          via: `${unresolved.name} on the settled base alone`,
        }),
      )
    }
    const baseFailure = baseResults.find((result) => result.result === "fail")
    if (baseFailure === undefined) return await endFailing(run, entry, results, failing, phase)
    const gitlinks = raises.map((row) => `${row.path}@${row.to}`).join(", ")
    return await run.steps.end(
      run,
      entry,
      "stuck",
      stuckWrite(run, {
        code: "yrd-submodule-main-regression",
        next: `fix or revert ${gitlinks} on submodule main, then run yrd queue run`,
        subject: `${gitlinks} breaks the root at the settled base`,
        trailers: checkTrailers(baseResults),
        via: `the settled base alone failed ${baseFailure.name}; the candidate's own content was absent`,
      }),
    )
  } finally {
    await base.remove()
  }
}

/**
 * A candidate's setup did not pass, and whose failure that is follows from the
 * ground it stood on rather than from a standing assumption.
 *
 * The same setup runs once on the settled base alone — the tree the base phase
 * already judges: the target, with this candidate's raises on existing gitlinks
 * and none of its authored content. A base that PASSES leaves the candidate's
 * own content as the only thing that broke setup, so the change ends failed,
 * the submitter's, carrying the setup's own diagnosis and log path, and the run
 * goes on to the next change. A base that FAILS is the queue's own ground gone
 * bad: stuck, `yrd-setup-unusable`, nobody billed, and the run stops there. A
 * base that cannot be composed at all is stuck too, and the incident says the
 * queue could not attribute rather than pretending it did.
 *
 * A submitter's lockfile miss took the whole service down for exit 2 this way
 * once (run q-20260910T051200413Z-adf158d1): the setup failed only with that
 * candidate's content, and every other change in line waited for a person.
 */
async function attributedSetupFailure(run: Run, entry: QueueEntry, failure: CandidateSetupFailed): Promise<Ended> {
  const { phase, raises, setup } = failure
  const { result } = setup.ran
  const about = { branch: entry.change.branch, head: entry.change.head, name: SETUP, phase }
  const message = setup.message.replace(/\s+/gu, " ").trim()
  const ground = await judgeSettledBase(run, entry, raises)
  if (ground.passed) {
    recordProgramVerdict(run, about, result, "submitter")
    return await run.steps.end(run, entry, "failed", {
      remedy: `fix ${SETUP} (log: ${result.log}), push, and submit again`,
      subject: `${entry.change.branch} failed ${SETUP}${phase === "merge" ? " at merge" : ""}: ${message}`,
      trailers: [
        ["Reason", SETUP],
        // What the attribution READ, so the record answers "why is a setup the
        // submitter's here" without its reader going to the journal for it.
        ["Base-Setup", "passed"],
        ["Check", checkTrailer(result)],
      ],
    })
  }
  recordProgramVerdict(run, about, result)
  return await run.steps.end(
    run,
    entry,
    "stuck",
    stuckWrite(run, {
      code: "yrd-setup-unusable",
      next: "repair the queue setup, then run yrd queue run",
      subject: `the queue could not prepare a worktree for ${entry.change.branch}: ${message}`,
      via:
        ground.why === undefined
          ? `${SETUP}, which failed on the settled base alone too`
          : `${SETUP}; the settled base it would have been attributed against could not be composed: ${ground.why}`,
    }),
  )
}

/**
 * The target's setup, run once on the settled base alone, as a reading: passed,
 * or not passed with why nobody could be attributed when the base could not
 * even be built. The base's own setup failing is not a `why` — it IS the
 * reading, and the one the ground was asked for.
 */
async function judgeSettledBase(
  run: Run,
  entry: QueueEntry,
  raises: RootChanges["changes"],
): Promise<Readonly<{ passed: boolean; why?: string }>> {
  let base: PreparedWorktree
  try {
    base = await prepareSettledBase(run, entry, raises)
  } catch (error) {
    if (error instanceof SetupFailed) return { passed: false }
    return {
      passed: false,
      why: (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim(),
    }
  }
  await base.remove()
  return { passed: true }
}

/**
 * Materialize the target with the candidate's exact raises on existing
 * gitlinks, but none of its authored content.
 *
 * A gitlink of the TARGET is never the submitter's, and needs no flag to say
 * so: this queue is the only writer of main, so every gitlink it composes from
 * main is one it put there and already proved fetchable. A pin missing here
 * can therefore only be the queue's own ground, which is the ending
 * {@link GitlinkNotOnRemote}'s probe reaches for it anyway when nothing answers.
 */
async function prepareSettledBase(
  run: Run,
  entry: QueueEntry,
  raises: RootChanges["changes"],
): Promise<PreparedWorktree> {
  const composing = await freshWorktree(
    run.git,
    run.options.repo,
    run.targetSha,
    join(run.worktrees, "compose", "base", entry.change.head.slice(0, 12)),
    {
      env: run.options.env,
      gitOptions: gitInvocationOptions(run.options, run.log),
      plumbing: run.plumbing,
      populateReference: run.options.populateReference,
      process: run.options.process,
      selection: run.options.selection,
    },
  )
  let commit = run.targetSha
  try {
    const wt = gitIn(
      composing.path,
      run.options.process,
      run.options.selection,
      gitInvocationOptions(run.options, run.log),
    )
    for (const raise of raises) {
      const row = await wt([
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        run.targetSha,
        "--",
        raise.path,
      ])
      const target = /^160000 commit ([0-9a-f]{40,64})\t/u.exec(row)?.[1]
      if (target === undefined || row !== `160000 commit ${target}\t${raise.path}\0` || target === raise.to) continue
      await wt(["update-index", "-z", "--index-info"], `${raise.mode} ${raise.to}\t${raise.path}\0`)
    }
    const tree = (await wt(["write-tree"])).trim()
    const targetTree = (await wt(["rev-parse", `${run.targetSha}^{tree}`])).trim()
    if (tree !== targetTree) {
      commit = (
        await wt(["commit-tree", tree, "-p", run.targetSha, "-m", `settle the base for ${entry.change.branch}`])
      ).trim()
      await run.git(["fetch", "--quiet", composing.path, commit])
    }
  } finally {
    await composing.remove()
  }
  return run.steps.prepare(run, entry, commit, join(run.worktrees, "base", entry.change.head.slice(0, 12)), "base")
}

/** The on-merge phase for the first checked change. */
async function merge(run: Run, entry: QueueEntry): Promise<Ended> {
  const { change } = entry
  const { branch, head } = change
  const name = changeName(change)
  const composed = await composeCandidate(run, entry, "merge")
  if (composed.kind === "waiting") return waiting(run, entry, composed.detail)
  if (composed.kind === "failed") return candidateFailure(run, entry, composed.detail, composed.worktree)
  const { mergeCommit, rootChanges, worktree } = composed
  try {
    const wt = gitIn(
      worktree.path,
      run.options.process,
      run.options.selection,
      gitInvocationOptions(run.options, run.log),
    )
    // The built-in check at merge (ruling D2): the merged tree's own declaration
    // reads, so no change can land a `.yrd.yml` that breaks the next queue run.
    let unreadable: string | undefined
    try {
      if ((await readConfig(wt, "HEAD", run.options.target)) === undefined) {
        unreadable = "the merged tree has no .yrd.yml"
      }
    } catch (error) {
      unreadable = String(error instanceof Error ? error.message : error)
    }
    if (unreadable !== undefined) {
      return await run.steps.end(run, entry, "failed", {
        remedy: `fix .yrd.yml on ${branch} (${unreadable}), push, and submit again`,
        subject: `${branch} would land a declaration the queue cannot read`,
        trailers: [["Reason", "config-invalid"]],
      })
    }
    // The merge moved this worktree's HEAD, so what a check judges here is
    // read now and not at prepare time: the candidate is the merge commit,
    // and its merge base with the target is the target itself.
    const merged = await checkedTree(
      worktree.path,
      run.targetSha,
      run.options.process,
      run.options.selection,
      gitInvocationOptions(run.options, run.log),
    )
    const results = await runPhase(run, entry, "merge", worktree.path, merged)
    const stuckOne = results.find((result) => result.result === "stuck")
    if (stuckOne !== undefined) {
      return await run.steps.end(
        run,
        entry,
        "stuck",
        stuckWrite(run, {
          code: "yrd-check-unresolved",
          next: `repair ${stuckOne.name} or its queue environment, then run yrd queue run`,
          subject: `the queue could not judge ${branch} at merge: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
          trailers: checkTrailers(results),
          via: `${stuckOne.name} during merge`,
        }),
      )
    }
    const failing = results.filter((result) => result.result === "fail")
    if (failing.length > 0) {
      return await attributedFailure(run, entry, results, failing, "merge", rootChanges?.changes ?? [])
    }
    // Pass. The merge is ours to make only while the target is still where this
    // change was checked against and the branch still at the head; otherwise the
    // change keeps its place and is checked again at the new target next run.
    const remoteNow = await remoteHeads(run, branch)
    if (remoteNow.target !== run.targetSha || remoteNow.branch !== head) {
      run.log.write({
        branch,
        decision: "checked",
        head,
        kind: "change",
        reason: remoteNow.target !== run.targetSha ? "target-moved" : "branch-moved",
      })
      return "checked"
    }
    // The merged record says how it was merged and what it checked: by the queue,
    // with the on-merge checks' results, in the shape the checked record uses.
    const ref = changeRef(run.options.target.branch, change)
    const expectedTip = tipOf(entry.change).sha
    const mergedRecord = await recordCommit(
      run.git,
      {
        change,
        kind: "merged",
        subject: `${branch} merged into ${run.options.target.branch} as ${mergeCommit.slice(0, 12)}`,
        trailers: [
          ["Merge", mergeCommit],
          ...(rootChanges === undefined ? [] : [["Root-Changes", rootChanges.encoded] as const]),
          ["Base", run.targetSha],
          ["Merged-By", mergedBy(run.options.target.branch, run.log.id)],
          ...checkTrailers(results),
        ],
      },
      expectedTip,
    )
    const pushed = await run.steps.push(run, entry, {
      leases: [
        [`refs/heads/${run.options.target.branch}`, run.targetSha],
        [ref, expectedTip],
      ],
      updates: [
        [mergeCommit, `refs/heads/${run.options.target.branch}`],
        [mergedRecord, ref],
      ],
    })
    if (!pushed.merged) {
      // Something can win after our reads, and then the atomic leases reject
      // every update. A push that read what moved says so and the change simply
      // keeps its place; one that could read nothing raises, because a queue
      // that cannot explain a refused merge has not judged anything.
      if (pushed.reason === undefined) throw pushed.error
      run.log.write({
        branch,
        decision: "checked",
        head,
        kind: "change",
        reason: pushed.reason,
        ...(pushed.reason === "change-ref-moved" ? { expected: expectedTip } : {}),
        ...(pushed.saw === undefined ? {} : { saw: pushed.saw }),
      })
      return "checked"
    }
    run.targetAfter.sha = mergeCommit
    run.log.write({
      branch,
      change: name,
      commit: mergeCommit,
      gitlinks: (rootChanges?.changes ?? []).map((row) => `${row.path} ${row.from} -> ${row.to}`),
      head,
      kind: "merge",
      tip: mergeCommit,
    })
    run.log.write({ branch, decision: "merged", head, kind: "change" })
    if (rootChanges !== undefined) await cleanupRootChanges(run.git, rootChanges, mergedRecord)
    await run.steps.ended(run, entry, "merged", mergedRecord, mergedRecord)
    return "merged"
  } finally {
    await worktree.remove()
  }
}

/**
 * The one atomic push a merge makes: every ref in the plan moves or none does,
 * and every lease proves nobody moved that ref between this run's reads and
 * this moment.
 *
 * A rejection is not an error until somebody has looked. The target or the
 * branch may have moved under us, and then the change simply keeps its place and
 * is judged again next run. What the pusher cannot read as a race it hands back
 * with the rejection, for a caller that knows more to explain or raise.
 */
async function push(run: Run, entry: QueueEntry, plan: PushPlan): Promise<Pushed> {
  try {
    await run.git([
      "push",
      "--quiet",
      "--atomic",
      ...plan.leases.map(([ref, expected]) => `--force-with-lease=${ref}:${expected}`),
      run.options.target.remote,
      ...plan.updates.map(([object, ref]) => `${object}:${ref}`),
    ])
    return { merged: true }
  } catch (error) {
    const ref = changeRef(run.options.target.branch, entry.change)
    const moved = await remoteHeads(run, entry.change.branch, ref)
    if (moved.target !== run.targetSha) {
      return { error, merged: false, reason: "target-moved", saw: moved.target ?? "gone" }
    }
    if (moved.branch !== entry.change.head) return { error, merged: false, reason: "branch-moved" }
    const expectedTip = plan.leases.find(([leased]) => leased === ref)?.[1]
    if (expectedTip !== undefined && moved.change !== expectedTip) {
      return { error, merged: false, reason: "change-ref-moved", saw: moved.change ?? "gone" }
    }
    return { error, merged: false }
  }
}

/**
 * A failing check with no settlement to attribute ends the change failed, the
 * submitter's, at once, with the check, its exit, its duration and its log
 * path. When candidate preparation raised a gitlink, attributedFailure first
 * runs the same declared plan once on the settled base alone: red there is the
 * submodule writer's stuck; green leaves this submitter ending unchanged.
 *
 * It used to run the same check again in the change's worktree and once more
 * at the target before billing anybody, so that a coin flip or a red target
 * ended the change stuck instead. Measured over 257 check runs since flag day,
 * that reading changed no verdict at all: all 7 second runs failed again and
 * all 14 target runs passed. What it cost was two extra check runs and a whole
 * worktree of the target for every failure, on the queue's critical path
 * (operator ruling 2026-09-03). A flake is the author's to retry; the target is
 * proven green by its own last merge.
 */
async function endFailing(
  run: Run,
  entry: QueueEntry,
  results: readonly CheckResult[],
  failing: readonly CheckResult[],
  phase: Phase,
): Promise<Ended> {
  const first = failing[0]
  return run.steps.end(run, entry, "failed", {
    remedy: `fix ${first?.name ?? "the check"} (log: ${first?.log ?? ""}), push, and submit again`,
    subject: `${entry.change.branch} failed ${failing.map((result) => result.name).join(", ")}${phase === "merge" ? " at merge" : ""}`,
    trailers: [["Reason", first?.name ?? "check"], ...checkTrailers(results)],
  })
}

/**
 * A change whose branch is gone, or whose branch moved off its head, ends
 * failed with the reason `deleted` or `replaced` and no message: the
 * submitter did it (§ The change). Written once; a change that already ended
 * is left as it ended.
 */
async function retire(run: Run, entry: QueueEntry): Promise<void> {
  const reason = entry.reading.reason
  if (entry.reading.state !== "failed" || (reason !== "deleted" && reason !== "replaced")) return
  const endedAs = endedKind(tipOf(entry.change))
  if (endedAs === "failed" || endedAs === "merged") return
  const { change } = entry
  const { branch, head } = change
  const retiredRecord = await writeRecord(
    run,
    {
      change,
      kind: "failed",
      subject:
        reason === "deleted"
          ? `${branch} was deleted by its submitter`
          : `${branch} moved off ${head.slice(0, 12)}; its submitter replaced it`,
      trailers: [["Reason", reason]],
    },
    tipOf(entry.change).sha,
  )
  if (retiredRecord === undefined) return
  run.log.write({ branch, decision: "failed", head, kind: "change", reason })
}

/**
 * A head the target already carries with no merged record yet — merged around the
 * queue in the garage, or by a run that crashed after its push — gets its
 * merged record now, naming the commit that merged it and saying so, and
 * its submitter is told (§ The change: ancestry wins, and the next queue run
 * appends the merged record so the tip catches up). A retired change is left as
 * it ended.
 *
 * The gate is the READING, `entry.reading.state === "merged"`, never the raw
 * `headOnTarget` fact alone: a head whose own last ending was failed and
 * whose branch has since moved to a later head reads `failed`+`superseded`
 * (state.ts), even when that later head's merge makes this one's commit
 * reachable too. Re-deriving ancestry here instead of trusting that reading
 * is exactly how a failed, superseded head used to get a fabricated merged
 * record — and the notifier's "close your bead" — for a merge it never made
 * (@i/10-yrd/24098).
 */
async function catchUp(run: Run, entry: QueueEntry): Promise<void> {
  if (entry.reading.state !== "merged") return
  const tip = tipOf(entry.change)
  if (endedKind(tip) === "merged") return
  const reason = trailer(tip, "Reason")
  if (reason === "replaced" || reason === "deleted") return
  const { change } = entry
  const { branch, head } = change
  // The first commit on the target's first-parent line that descends from the
  // head is the one that merged it; none means the head was fast-forwarded.
  // `--parents` names its first parent in the same reading, so `Base:` is a
  // sha like every other Base and not a revision expression a reader would
  // have to give back to git to resolve.
  const row = (
    await run.git([
      "rev-list",
      "--reverse",
      "--first-parent",
      "--ancestry-path",
      "--parents",
      `${head}..${run.targetSha}`,
    ])
  )
    .trim()
    .split("\n")[0]
    ?.trim()
    .split(/\s+/u)
    .filter((sha) => sha !== "")
  const merge = row?.[0] ?? head
  const base = row?.[1] ?? head
  // The landed merge's own trailer names who made it when it names a yrd
  // queue run: this run only reused it, and the record must say who actually
  // did (@i/10-yrd/24344) — `direct` is for a merge the queue never composed,
  // never for one of its own that only failed to settle.
  const attribution = merge === head ? DIRECT_MERGE : await attributedMergedBy(run, merge)
  const mergedRecord = await writeRecord(
    run,
    {
      change,
      kind: "merged",
      subject:
        attribution === DIRECT_MERGE
          ? `merged around the queue at ${merge.slice(0, 12)}`
          : `merged as ${merge.slice(0, 12)}, recovered after the run that made it died before recording it`,
      trailers: [
        ["Merge", merge],
        ["Base", base],
        ["Merged-By", attribution],
      ],
    },
    tip.sha,
  )
  if (mergedRecord === undefined) return
  run.log.write({ branch, decision: "merged", head, kind: "change", reason: "already on the target" })
  await run.steps.ended(run, entry, "merged", mergedRecord, mergedRecord)
}

/**
 * `Merged-By:` for a catch-up record: the landed merge commit's own trailer
 * when it names a yrd queue run, never the constant `direct` for a merge this
 * queue itself composed (`mergeMessage`) and then failed to settle. A merge
 * with no such trailer, or one naming something `mergedByRun` cannot parse
 * back into a run id, is read exactly as before: it went around the queue.
 */
async function attributedMergedBy(run: Run, merge: string): Promise<string> {
  const block = await run.git(["log", "-1", "--format=%(trailers:only,unfold)", merge])
  const found = commitTrailers(block).find(([name]) => name === "Merged-By")?.[1]
  return found !== undefined && mergedByRun(found) !== undefined ? found : DIRECT_MERGE
}

/**
 * The GUARD half of @i/10-yrd/24344: a run that composed and checked a merge
 * at the "merge" phase and died before its settlement record leaves the
 * change "checked" with nothing on its ref to say a merge was ever
 * attempted. Unrecovered, the very next run would call `merge` again on the
 * same head — redoing a git-super merge whose gitlinks it may already have
 * raised once. Detected from this run's own reap (`run.reaped.list`), the
 * change never gets a second composition: it ends stuck with the orphan's
 * own sha and a verdict this run actually checked (the REDESIGN half,
 * `orphanedMergeCandidate`'s caller below), never the generic crash incident
 * a blind retry would earn instead.
 *
 * Gated on `entry.reading.state === "checked"`, which `readChange` already
 * refuses whenever ancestry says the head is on the target, or the branch
 * moved on or vanished — `catchUp` and `retire`, just above, own those, and
 * neither ever leaves a "checked" reading behind. So whatever this finds is
 * never the entry either of them just settled.
 */
async function recoverOrphanedMerge(run: Run, entry: QueueEntry): Promise<"stuck" | undefined> {
  if (entry.reading.state !== "checked") return undefined
  const found = await orphanedMergeCandidate(run, entry)
  if (found === undefined) return undefined
  const { branch } = entry.change
  const target = run.options.target.branch
  const absorbed = await isAncestor(run.git, found.commit, run.targetSha)
  await run.steps.end(
    run,
    entry,
    "stuck",
    stuckWrite(run, {
      code: "yrd-merge-orphaned",
      next: absorbed
        ? `${found.commit.slice(0, 12)} is already an ancestor of ${target} some other way; confirm ${branch} is truly done, close it by hand, then run yrd queue run`
        : `read ${found.foundAt} and confirm ${found.commit.slice(0, 12)} raised no submodule gitlink that ${target} does not also carry yet; then either push it onto ${target} by hand or discard it, and run yrd queue run — the next run recomposes ${branch} from scratch otherwise`,
      subject: `${branch}: the run that composed merge ${found.commit.slice(0, 12)} died before recording it; ${absorbed ? "absorbed into" : "not absorbed into"} ${target}`,
      trailers: [
        ["Orphan", found.commit],
        ["Absorbed", absorbed ? "yes" : "no"],
      ],
      via: `merge-phase worktree ${found.foundAt}, left standing by a run that died before its settlement record`,
    }),
  )
  return "stuck"
}

/**
 * One dead run's leftover on-merge worktree that names `entry`'s exact head
 * as a parent — `composeCandidate`'s own `prepare` checks the merge commit
 * out at exactly `<run>/merge/<head-12>`, and nothing else ever creates a
 * worktree there. Parentage is verified rather than trusted: a stale worktree
 * from an earlier submission at a different head, or one this run cannot
 * even read any more, is left alone with why, never guessed into this
 * change's evidence (never redo the merge; never guess).
 */
async function orphanedMergeCandidate(
  run: Run,
  entry: QueueEntry,
): Promise<Readonly<{ commit: string; foundAt: string }> | undefined> {
  const { branch, head } = entry.change
  const prefix = head.slice(0, 12)
  const taken = run.reaped.list.find(
    (candidate) =>
      candidate.head !== undefined &&
      basename(candidate.path) === prefix &&
      basename(dirname(candidate.path)) === "merge",
  )
  const commit = taken?.head
  if (taken === undefined || commit === undefined) return undefined
  let parents: readonly string[]
  try {
    parents = (await run.git(["show", "-s", "--format=%P", commit]))
      .trim()
      .split(/\s+/u)
      .filter((sha) => sha !== "")
  } catch (error) {
    run.log.write({
      branch,
      candidate: commit,
      foundAt: taken.path,
      head,
      kind: "orphan",
      why: `could not read ${commit.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`,
    })
    return undefined
  }
  if (!parents.includes(head)) {
    run.log.write({
      branch,
      candidate: commit,
      foundAt: taken.path,
      head,
      kind: "orphan",
      why: `${commit.slice(0, 12)} carries ${parents.length === 0 ? "no parents" : `parents ${parents.map((sha) => sha.slice(0, 12)).join(", ")}`}, not ${prefix}`,
    })
    return undefined
  }
  return { commit, foundAt: taken.path }
}

/** A change as a person reads it: the branch and twelve characters of the head, the trailer's spelling shortened. */
export function short(branch: string, head: string): string {
  return `${branch}@${head.slice(0, 12)}`
}

/**
 * A check's scripts come from the target, never from the branch (§ The queue
 * run: check authority lives on the protected side). The check declares them as
 * `scripts:`, files or directories of the repository; each is restored from
 * the base commit into the worktree before the check runs, so a change that
 * rewrites the check it is judged by is judged by the target's version all the
 * same. The merge commit, already made, keeps the branch's edit: it merges, and
 * judges the next change. A declared path the base does not carry is loud,
 * because a check that silently ran the branch's copy would be the hole itself.
 */
async function restoreScripts(run: Run, spec: CheckSpec, cwd: string): Promise<void> {
  const scripts = spec.scripts ?? []
  if (scripts.length === 0) return
  const wt = gitIn(cwd, run.options.process, run.options.selection, gitInvocationOptions(run.options, run.log))
  for (const path of scripts) {
    if (
      (await refAt(run.git, `${run.targetSha}:${path}`, "blob")) === undefined &&
      (await refAt(run.git, `${run.targetSha}:${path}`, "tree")) === undefined
    ) {
      throw new Error(
        `check ${spec.name} declares scripts: ${path}, which the target ${run.targetSha.slice(0, 12)} does not carry`,
      )
    }
    await wt(["checkout", "--quiet", run.targetSha, "--", path])
  }
}

/**
 * Where every log of one change's phase goes: keyed by the change, this run and
 * the phase, so no two writes can name one file and every log is written once
 * (check.ts opens them create-only). The setup and the checks that follow it
 * share the directory, and both used to spell it out for themselves.
 */
function checkLogDir(run: Run, entry: QueueEntry, phase: Phase): string {
  return join(run.options.workdir, "checks", changeName(entry.change), run.log.id, phase)
}

async function runPhase(
  run: Run,
  entry: QueueEntry,
  declaredPhase: CandidatePhase,
  cwd: string,
  tree: CheckedTree,
  phase: Phase = declaredPhase,
  narrowed: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map(),
): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = []
  for (const spec of run.options.checks.filter((candidate) => (candidate.on ?? ["merge"]).includes(declaredPhase))) {
    results.push(await check(run, entry, spec, cwd, tree, phase, narrowed.get(spec.name)))
    if (results.at(-1)?.result !== "pass") break
  }
  return results
}

async function check(
  run: Run,
  entry: QueueEntry,
  spec: CheckSpec,
  cwd: string,
  tree: CheckedTree,
  phase: Phase,
  extraEnv?: Readonly<Record<string, string>>,
): Promise<CheckResult> {
  await restoreScripts(run, spec, cwd)
  const logDir = checkLogDir(run, entry, phase)
  const about = {
    branch: entry.change.branch,
    head: entry.change.head,
    name: spec.name,
    phase,
    // Which of the two base runs this is, on the row a reader already looks at
    // for this check: the whole check, or the scope the check itself asked for
    // (narrowing.ts). A narrowed run that reads like a full one is a verdict
    // nobody can size.
    ...(phase === "base" ? { scope: extraEnv === undefined ? ("full" as const) : ("narrowed" as const) } : {}),
    ...(spec.scripts === undefined || spec.scripts.length === 0 ? {} : { scripts: spec.scripts }),
  }
  const start = new Date().toISOString()
  recordProgramStart(run, { ...about, log: checkLogPath(logDir, spec.name), start })
  const result = await runCheck({
    cwd,
    env: run.options.env,
    logDir,
    process: run.options.process,
    tmpdir: run.tmpdir,
    spec,
    tree,
    ...(extraEnv === undefined ? {} : { extraEnv }),
  })
  recordProgramResult(run, { ...about, end: new Date().toISOString(), start }, result)
  return result
}

/**
 * The scope each failing check asked its own base run for, by check name.
 *
 * Read from the log the check just wrote ({@link narrowingOf}), so the queue
 * learns what a base comparison needs from the only thing that knows — never
 * by understanding the check. A check that offers nothing gets the full base
 * run it always had; an offer that cannot be honoured gets the full run too
 * and a journal row saying so, because a defect folded into an absence is a
 * base phase nobody can tell apart from the ordinary one.
 */
async function narrowedBase(
  run: Run,
  entry: QueueEntry,
  failing: readonly CheckResult[],
): Promise<ReadonlyMap<string, Readonly<Record<string, string>>>> {
  const narrowed = new Map<string, Readonly<Record<string, string>>>()
  for (const result of failing) {
    const offer = await narrowingOf(result.log)
    if (offer.kind === "narrowed") narrowed.set(result.name, offer.env)
    if (offer.kind !== "refused") continue
    run.log.write({
      branch: entry.change.branch,
      head: entry.change.head,
      kind: "narrowing",
      name: result.name,
      reason: offer.why,
      scope: "full",
    })
  }
  return narrowed
}

/**
 * The row that says a program the queue runs has STARTED, written before it
 * runs: the same `check` kind, the same names, and the log file it is about to
 * write, read from the same place the driver will read it. A reader tells the
 * two rows apart by `end`, which only ending can say and which a start row
 * therefore does not carry (neither does it carry `ms`); the end row is
 * exactly what it always was, so nothing that reads one changes.
 *
 * Without this row a queue run's log is silent for the whole length of a
 * check, and a check that is merely long reads as a hung queue: R8 was stopped
 * as a hang while a 28.7-minute check ran (plan § Owed after M5).
 */
export function recordProgramStart(
  run: Run,
  about: Readonly<{
    branch: string
    head: string
    name: string
    phase: string
    start: string
    log: string
    /** Which base run this is, on a base-phase row: the whole check, or the scope it asked for. */
    scope?: "narrowed" | "full"
    scripts?: readonly string[]
  }>,
): void {
  run.log.write({ ...about, kind: "check" })
}

/**
 * The two records every program the queue runs writes, one shape for all of
 * them: what ran, then how it ended. Both at once for every caller that knows
 * how it ended AND whose it is by then, which is every caller but one — a
 * candidate's failing setup, whose verdict waits for the settled base.
 */
export function recordProgramResult(
  run: Run,
  about: Readonly<{
    branch: string
    head: string
    name: string
    phase: string
    start: string
    end: string
    /** Which base run this is, on a base-phase row: the whole check, or the scope it asked for. */
    scope?: "narrowed" | "full"
    scripts?: readonly string[]
  }>,
  result: CheckResult,
): void {
  recordProgramEnd(run, about, result)
  recordProgramVerdict(run, about, result)
}

/** The row that says a program the queue ran ENDED: how long it took, and the log it wrote. */
function recordProgramEnd(
  run: Run,
  about: Readonly<{
    branch: string
    head: string
    name: string
    phase: string
    start: string
    end: string
    /** Which base run this is, on a base-phase row: the whole check, or the scope it asked for. */
    scope?: "narrowed" | "full"
    scripts?: readonly string[]
  }>,
  result: CheckResult,
): void {
  run.log.write({
    branch: about.branch,
    end: about.end,
    head: about.head,
    kind: "check",
    log: result.log,
    ms: result.durationMs,
    name: about.name,
    phase: about.phase,
    ...(about.scope === undefined ? {} : { scope: about.scope }),
    ...(about.scripts === undefined ? {} : { scripts: about.scripts }),
    start: about.start,
  })
}

/**
 * The row that says what a program the queue ran DECIDED, and whose that is.
 *
 * A stuck result is always the queue's, and so is a setup the queue could not
 * attribute; a failing check is the submitter's, which is the whole of the
 * rule. `whose` names an owner the caller has READ instead: a candidate setup
 * that failed where the settled base passed is the submitter's, and only the
 * base's own run can say so, which is why this row is separable from the end
 * row at all.
 */
function recordProgramVerdict(
  run: Run,
  about: Readonly<{ branch: string; head: string; name: string; phase: string }>,
  result: CheckResult,
  whose?: "queue" | "submitter",
): void {
  run.log.write({
    branch: about.branch,
    exit: String(result.exit),
    head: about.head,
    kind: "result",
    name: about.name,
    phase: about.phase,
    result: result.result,
    whose:
      result.result === "pass"
        ? undefined
        : (whose ?? (result.result === "stuck" || about.name === SETUP ? "queue" : "submitter")),
  })
}

async function end(run: Run, entry: QueueEntry, kind: "failed" | "stuck", ended: EndedWrite): Promise<Ended> {
  // Who is billed follows from the kind, once: a fail is the submitter's, and
  // says so; a stuck is always the queue's, so its record says nothing about
  // fault (a constant trailer says nothing). A `replaced` or `deleted` change
  // bills nobody and never comes through here.
  const trailers = [
    ...ended.trailers,
    ...(kind === "failed" ? [["Fault", "submitter"] as const] : []),
    ...(ended.remedy === undefined ? [] : [["Remedy", ended.remedy] as const]),
  ]
  const record = await writeRecord(
    run,
    {
      change: entry.change,
      kind,
      subject: ended.subject,
      trailers,
    },
    tipOf(entry.change).sha,
  )
  run.log.write({
    branch: entry.change.branch,
    decision: kind,
    head: entry.change.head,
    kind: "change",
    reason: ended.diagnosis?.message ?? ended.subject,
    ...ended.incident,
    ...(ended.diagnosis === undefined ? {} : { diagnosisCode: ended.diagnosis.code, phase: ended.diagnosis.phase }),
    ...(ended.detail === undefined ? {} : { detail: ended.detail }),
    ...(ended.worktree === undefined ? {} : { worktree: ended.worktree }),
  })
  // No record, no message: the message's id IS that record's sha, and the next
  // run's reading of the remote is what repairs the ending (24096).
  if (record !== undefined) await run.steps.ended(run, entry, kind, record, record)
  return kind
}

/** One constructor for queue-owned failures, with this run's real evidence and remedy. */
function stuckWrite(
  run: Run,
  cause: Readonly<{
    code: Incident["code"]
    subject: string
    via: string
    next: string
    detail?: string
    worktree?: string
    trailers?: readonly (readonly [string, string])[]
  }>,
): EndedWrite {
  const subject = cause.subject.replace(/\s+/gu, " ").trim()
  const incident = {
    code: cause.code,
    subject,
    via: `${cause.via} in yrd queue ${run.name} [${run.log.id}]`,
    evidence: run.log.path,
    next: cause.next,
    owner: "the queue operator",
  }
  return {
    subject,
    incident,
    ...(cause.detail === undefined ? {} : { detail: cause.detail }),
    ...(cause.worktree === undefined ? {} : { worktree: cause.worktree }),
    trailers: [...incidentTrailers(incident), ...(cause.trailers ?? [])],
  }
}

function checkTrailers(results: readonly CheckResult[]): readonly (readonly [string, string])[] {
  return results.map((result) => ["Check", checkTrailer(result)] as const)
}

/**
 * The one writer of a record: the commit object appended onto the tip the run
 * read the change at, pushed under a lease for that same tip.
 *
 * There is nothing to align and no local ref to lose. The remote is the store,
 * `--force-with-lease` is what proves nobody else moved the ref between the
 * reading and the push, and the object being immutable is what makes a retry
 * cheap: on a refusal the run takes the winner's tip, writes the same record onto
 * it, and pushes once more. A second refusal is logged and leaves this record
 * unwritten: a queue that spins on a contended ref is a queue that is not
 * judging anything (24096).
 */
export async function writeRecord(run: Run, write: WriteRecord, expectedTip: string): Promise<string | undefined> {
  const ref = changeRef(run.options.target.branch, write.change)
  let onto = expectedTip
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record = await recordCommit(run.git, write, onto)
    try {
      await run.git([
        "push",
        "--quiet",
        `--force-with-lease=${ref}:${onto}`,
        run.options.target.remote,
        `${record}:${ref}`,
      ])
      return record
    } catch (error) {
      // Git's rejection text varies (`stale info`, `fetch first`,
      // `non-fast-forward`), so the remote's own tip decides whether this was a
      // race. A transport or auth failure leaves the lease base standing and
      // stays loud.
      const now = await fetchRemoteChange(run, ref)
      if (now === onto) throw error
      onto = now
      // Compare the exact fetched object, not a second reading of a moving
      // remote ref. Relation describes the intended record relative to remote.
      let relation = "unknown"
      let relationError: string | undefined
      try {
        const base = await mergeBase(run.git, record, now)
        relation = record === now ? "equal" : base === record ? "behind" : base === now ? "ahead" : "diverged"
      } catch (error) {
        // Explaining a refused bookkeeping write must not kill a landed run.
        relationError = error instanceof Error ? error.message : String(error)
      }
      // Both objects exist here now. After Git's prune window the intended
      // object can disappear; the stored OIDs remain the durable evidence.
      const inspect = `git -C '${run.options.repo.replaceAll("'", "'\\''")}' log --oneline --left-right ${record}...${now}`
      const diagnostic = {
        branch: write.change.branch,
        decision: write.kind,
        ...(relationError === undefined ? {} : { error: relationError }),
        head: write.change.head,
        intended: record,
        kind: "change" as const,
        inspect,
        reason: CHANGE_REF_DIAGNOSTICS.taken,
        ref,
        relation,
        remote: now,
        text: `${ref}: remote ${now}, intended ${record} (${relation})${relationError === undefined ? "" : `; ancestry read failed: ${relationError}`}; inspect: ${inspect}`,
      }
      run.log.write(diagnostic)
      if (attempt === 1) run.log.write({ ...diagnostic, reason: CHANGE_REF_DIAGNOSTICS.contended })
    }
  }
  return undefined
}

/** Read one authoritative remote change tip and make that exact object local. */
async function fetchRemoteChange(run: Run, ref: string): Promise<string> {
  const rows = (await run.git(["ls-remote", "--refs", run.options.target.remote, ref])).split("\n")
  const remote = rows.map((row) => row.trim().split(/\s+/u)).find(([, name]) => name === ref)?.[0]
  if (remote === undefined || remote === "") throw new Error(`${ref}: the remote change tip is absent`)
  await run.git([
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--refmap=",
    run.options.target.remote,
    remote,
  ])
  return remote
}

/**
 * The URL a remote name stands for, or the name itself when git has no such
 * remote — the declaration may name a URL outright, and `resolveRemote` has
 * already made it a name by the time a run sees it.
 */

/** Where the target and one branch stand at the remote right now. */
async function remoteHeads(
  run: Run,
  branch: string,
  change?: string,
): Promise<Readonly<{ target?: string; branch?: string; change?: string }>> {
  const rows = (
    await run.git([
      "ls-remote",
      "--refs",
      run.options.target.remote,
      `refs/heads/${run.options.target.branch}`,
      `refs/heads/${branch}`,
      ...(change === undefined ? [] : [change]),
    ])
  ).split("\n")
  const at = new Map(rows.map((row) => row.trim().split(/\s+/u)).map(([sha, ref]) => [ref ?? "", sha ?? ""]))
  return {
    branch: at.get(`refs/heads/${branch}`),
    ...(change === undefined ? {} : { change: at.get(change) }),
    target: at.get(`refs/heads/${run.options.target.branch}`),
  }
}

function finish(
  run: Run,
  exitCode: 0 | 1 | 2,
  lists: Readonly<{
    merged: string[]
    failed: string[]
    stuck: string[]
    directMerges: readonly string[]
    checkedWaiting: number
  }>,
  stopped?: Stopped,
): QueueRunOutcome {
  // The accepted merge object is the target this run left; readers and pushes
  // never need a tracking ref to recover an OID the run already owns.
  const targetNow = run.targetAfter.sha
  // A settled run removed every worktree it made, so its directory and pid
  // file have nothing left to say. A stuck run is evidence: in particular,
  // git-super may have left an uncommitted composition whose index and
  // submodule checkouts explain the refusal. Keep that whole run directory
  // for the mechanic; a later process reaps it after the repair.
  if (exitCode !== 2) rmSync(run.worktrees, { force: true, recursive: true })
  return {
    observation: run.observation,
    base: run.targetSha,
    config: run.options.configBlob,
    exitCode,
    ...(stopped === undefined ? {} : { stopped }),
    log: run.log.path,
    run: run.log.id,
    target: targetNow,
    ...lists,
  }
}
