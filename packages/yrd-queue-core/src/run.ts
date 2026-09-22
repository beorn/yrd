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
 * could not do its own job, and the next thing to happen is a person. That is
 * the andon (operator 2026-09-16): nothing behind a stuck change is judged or
 * merged, and the pause ring stops the whole line on it until the change leaves
 * the line or the queue is resumed. A stuck the remote caused — a setup that
 * could not fetch, a submodule remote that did not answer — is taken once more
 * inside the round before it is written, and its record says so.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { type Process } from "@yrd/process"
import {
  programRootCheck,
  ProgramSubjectSetupFailed,
  validateScripts,
  recordProgramStart,
  recordProgramResult,
  recordProgramEnd,
  recordProgramVerdict,
} from "./program-root.ts"
export { recordProgramStart, recordProgramResult } from "./program-root.ts"

import { checkLogPath, checkTrailer, runCheck, type CheckedTree, type CheckResult, type CheckSpec } from "./check.ts"
import {
  DIRECT_MERGE,
  DecisionAfterEnding,
  commitTrailers,
  endedKind,
  recordCommit,
  standsEnded,
  mergedBy,
  mergedByRun,
  trailer,
  readRootChanges,
  cleanupRootChanges,
  type RootChanges,
  type WriteRecord,
} from "./legacy-records.ts"
import { queueName, readConfig, type Target } from "./config.ts"
import {
  GitExit,
  gitIn,
  isAncestor,
  type Git,
  type GitObservation,
  type ObservationNotice,
  mergeBase,
  type GitInvocationOptions,
  type GitSelection,
} from "./git.ts"
import { incidentTrailers, type Incident } from "./incident.ts"
import { stuckCures, type PauseRecord } from "./pause.ts"
import {
  gitSuperExecution,
  readSuperMergeDetail,
  verifyCandidate,
  type SuperMergeDetail,
  type SettledGitlink,
} from "./verifying.ts"
export { readSuperMergeResult } from "./verifying.ts"
import { CHANGE_REF_DIAGNOSTICS, openLog, type LogRecord, type QueueRunLog } from "./log.ts"
import { narrowingOf } from "./narrowing.ts"
import { directMergeCommits, type DirectMerge } from "./direct.ts"
import { changeName, changeRef, type Change } from "./refs.ts"
import { queueFormat } from "./events.ts"
import { eventQueueRun } from "./event-run.ts"
import { composed, type RingOptions } from "./rings.ts"
import {
  CapturedQueueObjectsUnavailable,
  readObscuredEndings,
  readQueue,
  remoteUrl,
  type QueueEntry,
  type QueueRead,
} from "./remote.ts"
import { GitlinkNotOnRemote, ReferenceUnpopulated } from "./reference.ts"
import { setupStuckCode, setupStuckNext, transportFaultIn } from "./setup-transport.ts"
import { inLine, openedAt, tipOf } from "./state.ts"
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
  judgedTreeDigest,
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
  /**
   * The one change this round works, and no other: `yrd merge`. It is judged
   * and merged wherever it stands in line, so a stuck change ahead of it does
   * not cut its line; the line this round works holds only the change named.
   */
  only?: Change
  /** The checks the target declares, read from the target commit by the caller. A check with no `on` runs at merge. */
  checks: readonly CheckSpec[]
  /** The target's `setup:`: one shell command run in every worktree this run makes, before any check runs in it. */
  setup?: string
  /** The target's retained-environment teardown; event queues refuse it until #25065 defines its event evidence. */
  teardown?: string
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
  /** Which check tier to run: normal (default) or long. */
  tier?: "normal" | "long"
  /** Stop starting new checks after this epoch timestamp in ms (Condition 5). */
  stopAtMs?: number
  /** Injected clock for testing stop windows; defaults to Date.now. */
  now?: () => number
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
  deferred: readonly string[]
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
  /**
   * The stop that stands, derived by `lineStop` from that same reading: the
   * pause record, unless it is a stuck stop whose change has left the line.
   */
  lineStop: PauseRecord | undefined
  /**
   * The changes this round has already taken a second time after a stuck the
   * remote caused. One retry per change per round, and the stuck record written
   * after it carries `Retried: 1`.
   */
  retried: Set<string>
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

/**
 * How one step left one change. `discarded` is the only one that is not an
 * account of the CHANGE at all: the change ended under the step (a withdraw
 * while its check ran, @i/10-yrd/24979) and the step's verdict was thrown away.
 * It exists so the round can tell that apart from a crash without either
 * writing a record over somebody else's ending or stopping the line. Both round
 * loops branch on `stuck`, `failed` and `merged` and let anything else fall
 * through to the next change, so a discard continues the round by construction.
 */
type Ended = "checked" | "failed" | "stuck" | "merged" | "discarded" | "deferred"

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
  /**
   * Why a stuck is the remote's rather than the change's or the queue's own
   * ground: set only where the queue could not reach a remote (a setup that
   * could not fetch, a submodule remote that did not answer). Such a stuck is
   * taken once more before it is written.
   */
  remote?: string
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
    kind: "merged" | "failed" | "stuck" | "deferred",
    endedRecord: string,
    appendTip: string,
  ) => Promise<void>
  /** The same, for a commit that went around the queue: there is no change to end. */
  direct: (run: Run, commit: DirectMerge) => Promise<void>
  observed: (run: Run, notice: ObservationNotice) => Promise<void>
  /**
   * A change ended this round stuck, and the round ends here, whatever answers.
   * The bare loop stops only this round. A ring that keeps the WHOLE LINE
   * stopped past it records that here and says what it stopped for, which the
   * outcome carries.
   */
  stopLine: (run: Run, entry: QueueEntry) => Promise<Stopped | undefined>
}>

/** One ring of the onion: the same bundle, with the members it owns wrapped. */
export type Ring = (steps: Steps) => Steps

/** Bound on the setup log read for classification: the tail is where a failure is. */
const SETUP_LOG_TAIL_BYTES = 64 * 1024

/**
 * The setup log's text, for classifying WHY it failed — with the read's own
 * failure reported rather than swallowed.
 *
 * `unreachable`/`unusable` is decided from this text, so a read that silently
 * returned "" would make every fault look like a repository break, which is
 * exactly the conflation being fixed. The caller puts `unreadable` in the
 * record so the classification can be argued with.
 */
function setupLogText(log: string): Readonly<{ text: string; unreadable?: string }> {
  try {
    const whole = readFileSync(log, "utf8")
    return { text: whole.length > SETUP_LOG_TAIL_BYTES ? whole.slice(-SETUP_LOG_TAIL_BYTES) : whole }
  } catch (error) {
    return { text: "", unreadable: error instanceof Error ? error.message : String(error) }
  }
}

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

/**
 * A stuck the remote caused, before its record is written: the loop takes the
 * change once more in this same round. Thrown by `end`, caught only by the
 * loop, and passed through `guarded` like an unreadable authority, so the
 * judgement it interrupts leaves no record and no message behind.
 */
class RetryOnce extends Error {
  constructor(readonly change: string) {
    super(`${change}: the remote could not be reached; taking the change once more in this round`)
    this.name = "RetryOnce"
  }
}

function gitInvocationOptions(options: QueueRunOptions, log: QueueRunLog): GitInvocationOptions {
  return {
    ...(options.env === undefined ? {} : { env: options.env }),
    openOutput: log.openGitOutput,
    onInvocation: log.writeGitInvocation,
  }
}

function nowMs(options: QueueRunOptions): number {
  return options.now !== undefined ? options.now() : Date.now()
}

function isStopWindowClosed(options: QueueRunOptions): options is QueueRunOptions & { stopAtMs: number } {
  return options.stopAtMs !== undefined && nowMs(options) >= options.stopAtMs
}

export async function queueRun(options: QueueRunOptions): Promise<QueueRunOutcome> {
  await using resources = new AsyncDisposableStack()
  const log = openLog(join(options.workdir, "logs"), undefined, options.render)
  // THE JOURNAL OPENS WITH ITS HEADER, before the first journaled Git call and
  // before anything here can throw. Every field below is known from the run's
  // options, so there is nothing to wait for: the run row carries the gitlink
  // (the target's commit) and the config blob the checks were read from. Each
  // change CONSIDERED writes its own row with its decision when the run has
  // made one; a change that ended in an earlier run is history, and this run
  // claims nothing about it.
  //
  // The header used to be written after the Git preamble because it carried
  // `queue`, which is computable only once the remote URL is read — so every
  // run that threw in that preamble left a journal with no header at all, and
  // both readers called that a malformed journal rather than a run that died
  // early (@i/10-yrd/24470). The queue name is now its own record below, which
  // also marks the preamble complete, and a headerless journal is structurally
  // impossible.
  // `pid` is here because the run's OTHER pid, the one `claimWorktrees` writes,
  // does not exist yet and will not until line ~476 — after the whole Git
  // preamble. A reader asking "did this run die in its preamble, or is it
  // executing one right now?" has nothing else to ask during exactly the window
  // the question matters in, and answering it from the absence of a worktree
  // would call a healthy run three seconds old a dead one.
  log.write({
    base: options.targetSha,
    checks: options.checks.map((check) => check.name),
    config: options.configBlob,
    kind: "run",
    gitlink: options.targetSha,
    pid: process.pid,
    target: options.target.branch,
  })
  const gitOptions = gitInvocationOptions(options, log)
  const selected = gitIn(options.repo, options.process, options.selection, gitOptions)
  const git = options.git ?? selected
  const hooksPath = join(options.workdir, "hooks-disabled")
  mkdirSync(hooksPath, { recursive: true })
  const hooks = readdirSync(hooksPath).sort()
  if (hooks.length > 0) {
    throw new Error(
      `queue-owned hooks path ${hooksPath} is not empty (${hooks.join(", ")}); remove the named entries, then run yrd queue run`,
    )
  }
  const url = await remoteUrl(git, options.target.remote)
  if ((await queueFormat({ repo: options.repo, remote: options.target.remote }, options.target.branch)) === "event") {
    return await eventQueueRun(options, { git, gitOptions, hooksPath, log, selected, url })
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
  // A captured tip alone cannot say whether its chain has ended, and a chain
  // that has ended leaves the candidate set: admission, bookkeeping and the
  // direct-merge reader below all judge the chain's ending, never its literal
  // tip (@i/10-yrd/24635, @cto 2026-09-16).
  const changes = await readObscuredEndings(git, queue.changes, options.target.remote, options.target.branch)
  const name = queueName(options.target, url)
  // The queue's name, and with it the mark that the Git preamble completed. It
  // is the one value the header cannot carry, because it is readable only once
  // the target's remote URL has been. A journal whose header has no `queue`
  // record after it is a run that died in that preamble, and its Git rows above
  // name the call that failed (@i/10-yrd/24470).
  log.write({ kind: "queue", queue: name })

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
    lineStop: queue.stop,
    retried: new Set<string>(),
    // The caller's trace half, kept exactly as it was passed, plus this run's
    // journal, which is always wired: the two halves answer different questions
    // and only one of them is a git transcript nobody turned on.
    plumbing: { ...options.plumbing, journal: log.write },
    queue: changes,
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
  const deferred: string[] = []

  const entries = changes

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
      deferred,
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
  if (stopped !== undefined) {
    return finish(run, 0, { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred }, stopped)
  }

  // Bookkeeping at the edges of the records first, so every reader below reads
  // records and never reconciles. A bookkeeping pass can itself end an entry
  // stuck (an orphaned merge recovery could not trust, @i/10-yrd/24344), and
  // that stops the round exactly like a stuck judge or merge does.
  for (const entry of entries) {
    if ((await run.steps.bookkeep(run, entry)) === "stuck") {
      stuck.push(entry.change.branch)
      return finish(
        run,
        2,
        { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred },
        await run.steps.stopLine(run, entry),
      )
    }
  }

  if (options.tier === "long") {
    // In the long tier: process deferred changes, oldest first (Condition 5).
    const deferredEntries = entries
      .filter(
        (entry) =>
          entry.reading.state === "deferred" &&
          (options.only === undefined ||
            (entry.change.branch === options.only.branch && entry.change.head === options.only.head)),
      )
      .sort((left, right) => openedAt(left.change) - openedAt(right.change))

    if (deferredEntries.length === 0) {
      return finish(run, 0, { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred })
    }

    if (isStopWindowClosed(options)) {
      log.write({
        kind: "observation",
        why: `stop time reached (${new Date(options.stopAtMs).toISOString()}); stopping starting new checks and leaving remaining changes deferred`,
      })
      return finish(run, 0, { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred })
    }

    const entry = deferredEntries[0]
    if (entry === undefined) {
      return finish(run, 0, { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred })
    }
    const outcome = await judged(run, entry, () => run.steps.judge(run, entry))
    if (outcome === "stuck") {
      stuck.push(entry.change.branch)
      return finish(
        run,
        2,
        { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred },
        await run.steps.stopLine(run, entry),
      )
    }
    if (outcome === "failed") {
      failed.push(entry.change.branch)
      return finish(run, 1, { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred })
    }
    if (outcome === "deferred") {
      deferred.push(entry.change.branch)
      return finish(run, 0, { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred })
    }
    if (outcome === "checked") {
      const queueAfterJudge = (await read()).changes
      const checkedEntry = queueAfterJudge.find(
        (e) => e.change.branch === entry.change.branch && e.change.head === entry.change.head,
      )
      if (checkedEntry !== undefined) {
        if (isStopWindowClosed(options)) {
          log.write({
            kind: "observation",
            why: `stop time reached (${new Date(options.stopAtMs).toISOString()}); stopping starting merge checks and leaving change deferred`,
          })
          await writeDeferredRecord(
            run,
            checkedEntry,
            "merge",
            { name: "stop-time", result: "deferred", why: "stop-time", exit: 0, durationMs: 0, log: "" },
            [],
          )
          deferred.push(checkedEntry.change.branch)
          return finish(run, 0, { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred })
        }
        const mergeOutcome = await judged(run, checkedEntry, () => run.steps.merge(run, checkedEntry))
        if (mergeOutcome === "stuck") {
          stuck.push(entry.change.branch)
          return finish(
            run,
            2,
            { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred },
            await run.steps.stopLine(run, checkedEntry),
          )
        }
        if (mergeOutcome === "failed") {
          failed.push(entry.change.branch)
          return finish(run, 1, { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred })
        }
        if (mergeOutcome === "merged") {
          merged.push(entry.change.branch)
          return finish(run, 0, { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred })
        }
      }
    }
    return finish(run, 0, { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred })
  }

  // On-submit: every queued change, oldest first, in a fresh worktree of its
  // head. A stuck change kept its place, and this run takes it again from
  // here, first among the changes still to judge; so does a checked change
  // whose checks ran under a check config the target no longer declares
  // (§ The queue run: a checked record is reused only while the config blob is
  // the one it names). A judge that ends stuck ENDS THE ROUND: nothing behind
  // it is judged, nothing is merged, and the line stops on it (the andon,
  // operator 2026-09-16, which overruled @i/10-yrd/24492's step-over).
  for (const entry of ordered(entries, options.only, "queued", "stuck", "checked").filter(
    (entry) => entry.reading.state !== "checked" || staleChecked(run, entry),
  )) {
    if (isStopWindowClosed(options)) {
      log.write({
        kind: "observation",
        why: `stop time reached (${new Date(options.stopAtMs).toISOString()}); stopping starting new checks`,
      })
      break
    }
    const outcome = await judged(run, entry, () => run.steps.judge(run, entry))
    if (outcome === "stuck") {
      stuck.push(entry.change.branch)
      return finish(
        run,
        2,
        { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred },
        await run.steps.stopLine(run, entry),
      )
    }
    if (outcome === "failed") failed.push(entry.change.branch)
    else if (outcome === "deferred") deferred.push(entry.change.branch)
  }

  // On-merge: the first checked change in line, re-read so this run's own
  // checked records count. The line is cut at its first stuck row: a checked
  // change behind a stuck one never merges past it. A round scoped to one
  // change selects it before the cut, so a stuck change ahead of it is not in
  // the line this round cuts.
  const reread = ordered((await read()).changes, options.only, "checked", "stuck")
  const blocked = reread.findIndex((entry) => entry.reading.state === "stuck")
  const line = (blocked === -1 ? reread : reread.slice(0, blocked)).filter((entry) => !staleChecked(run, entry))
  let stoppedIndex = -1
  for (const [i, checked] of line.entries()) {
    if (isStopWindowClosed(options)) {
      log.write({
        kind: "observation",
        why: `stop time reached (${new Date(options.stopAtMs).toISOString()}); stopping starting new checks`,
      })
      break
    }
    const outcome = await judged(run, checked, () => run.steps.merge(run, checked))
    if (outcome === "stuck") {
      stuck.push(checked.change.branch)
      return finish(
        run,
        2,
        { checkedWaiting: 0, directMerges, failed, merged, stuck, deferred },
        await run.steps.stopLine(run, checked),
      )
    }
    if (outcome === "deferred") {
      deferred.push(checked.change.branch)
      continue
    }
    if (outcome === "failed") {
      failed.push(checked.change.branch)
      stoppedIndex = i
      break
    }
    if (outcome === "merged") {
      merged.push(checked.change.branch)
      stoppedIndex = i
      break
    }
    stoppedIndex = i
    break
  }

  const checkedWaiting = stoppedIndex !== -1 ? Math.max(0, line.length - 1 - stoppedIndex) : 0

  return finish(
    run,
    stuck.length > 0 ? 2 : failed.length > 0 ? 1 : 0,
    // Everything this run left checked behind the one it acted on. Read from
    // the line it already re-read, so saying it costs no second look.
    { checkedWaiting, directMerges, failed, merged, stuck, deferred },
    stopped,
  )
}

/**
 * The queue with no rings on it: the bare loop's own steps, which rings.ts
 * wraps in order. Every one of them is reached through `Run.steps` and never by
 * name, so a ring that wraps one sees every call to it.
 */
const BASE: Steps = { bookkeep, direct, observed, end, ended, judge, merge, open, prepare, push, stopLine }

/** A checked change whose checked record names a config blob the target no longer declares. */
function staleChecked(run: Run, entry: QueueEntry): boolean {
  const tip = tipOf(entry.change)
  return tip.kind === "checked" && trailer(tip, "Config") !== run.options.configBlob
}

/** The entries in the named states, in line order: only the change `only` names, when it names one. */
function ordered(
  entries: QueueRead,
  only: Change | undefined,
  ...states: readonly ("queued" | "checked" | "stuck")[]
): readonly QueueEntry[] {
  const byHead = new Map(entries.map((entry) => [entry.change.head, entry]))
  return inLine(entries.map((entry) => entry.change))
    .map((change) => byHead.get(change.head))
    .filter(
      (entry): entry is QueueEntry =>
        entry !== undefined &&
        (states as readonly string[]).includes(entry.reading.state) &&
        (only === undefined || (entry.change.branch === only.branch && entry.change.head === only.head)),
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

/** The bare loop stops only the round a stuck ended; keeping the line stopped is a ring's. */
function stopLine(): Promise<Stopped | undefined> {
  return Promise.resolve(undefined)
}

/**
 * One judgement or merge of one change, guarded, taken ONCE more when it ended
 * on a stuck the remote caused. The second attempt's ending is final whatever
 * it is: a stuck is written then, carrying `Retried: 1` (`end`).
 */
async function judged(run: Run, entry: QueueEntry, step: () => Promise<Ended>): Promise<Ended> {
  try {
    return await guarded(run, entry, step)
  } catch (error) {
    if (!(error instanceof RetryOnce)) throw error
    return guarded(run, entry, step)
  }
}

/**
 * One pass over one entry before anything is judged: a branch that is gone or
 * moved off a head ends that head's change withdrawn with the reason and no
 * message (ruling B3; the one word the reader already derived, @i/10-yrd/24492); a head the target already carries gets its merged
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
    if (error instanceof QueueAuthorityUnreadable || error instanceof RetryOnce) throw error
    // THE ENDING WINS (@i/10-yrd/24979). A withdraw may land at any moment,
    // including while this step was judging the change it took out of the line.
    // The record layer then refuses this run's verdict, correctly — the chain
    // has ended and a decision cannot follow an ending (24635). That refusal is
    // the expected outcome of a race the queue can name, not a crash: the
    // ending has ALREADY taken the change out of the line, so there is nothing
    // to stop the line FOR, and the stuck this used to write outlived the stop
    // it claimed (`yrd queue resume`: "the stop lifted when that change left
    // the line"). Discard the verdict, say so, and let the round go on.
    if (error instanceof DecisionAfterEnding) {
      run.log.write({
        branch: entry.change.branch,
        endedAt: error.endedAt,
        head: entry.change.head,
        kind: "discarded",
        // Why the verdict went away, in the reader's terms: not "the write
        // failed" but "somebody ended this while we were judging it".
        why: `the chain ended ${error.endedKind} at ${error.endedAt.slice(0, 12)} while this run was judging it; the verdict was discarded`,
      })
      return "discarded"
    }
    // A candidate's setup that did not pass is the one crash whose owner the
    // queue can read rather than assume: `attributedSetupFailure` runs the same
    // setup on the settled base and bills whoever the ground names.
    if (error instanceof CandidateSetupFailed) return attributedSetupFailure(run, entry, error)
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim()
    // A setup that did not pass anywhere a candidate could be attributed from —
    // the settled base's own worktree — is the queue's: it could not build the
    // ground a judgement stands on, so the reason says setup and not crash.
    if (error instanceof SetupFailed) {
      // AN UNREACHABLE REMOTE IS NOT A BROKEN REPOSITORY (@i/10-yrd/24486 rows
      // 2 and 3). Both used to read `yrd-setup-unusable`, so a person reading
      // the record could not tell a code host having a bad minute from a change
      // that must never merge — and the fleet's delivery stopped on either.
      // Measured 2026-09-11: one GitHub 504 cost 19m47s.
      //
      // The classification is over the setup's own log, which holds the
      // transport line; the exception message alone carries only the exit and
      // the log's PATH. An unreadable log is not treated as evidence of
      // anything: it falls through to the repository verdict, which is the
      // stricter one and the behaviour that was already there, and the subject
      // says the log could not be read so nobody mistakes silence for a clean
      // classification.
      const read = setupLogText(error.ran.result.log)
      const fault = transportFaultIn(`${read.text}\n${message}`)
      return run.steps.end(
        run,
        entry,
        "stuck",
        stuckWrite(run, entry.change.branch, {
          code: setupStuckCode(fault),
          next: setupStuckNext(fault),
          ...(fault === undefined ? {} : { remote: `setup could not reach a remote (${fault.signature})` }),
          subject:
            `the queue could not prepare a worktree for ${entry.change.branch}: ${message}` +
            (fault === undefined ? "" : `; unreachable remote (${fault.signature}): ${fault.line}`) +
            (read.unreadable === undefined ? "" : `; the setup log could not be read (${read.unreadable})`),
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
          "resubmit from the checkout that holds the commit: yrd submit publishes a moved gitlink's commit to its " +
          "submodule remote (refs/git-super/pins), and a pin ahead of the submodule's main lands by the queue moving that main",
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
        stuckWrite(run, entry.change.branch, {
          code: "yrd-reference-unpopulated",
          // The `ls-remote` that separates a missing pin from a remote that
          // cannot be asked found the second: the remote's, retried once.
          ...(error.unreachable === undefined ? {} : { remote: error.unreachable }),
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
      stuckWrite(run, entry.change.branch, {
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
  const about = {
    branch: entry.change.branch,
    head: entry.change.head,
    name: SETUP,
    phase,
  }
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

async function writeDeferredRecord(
  run: Run,
  entry: QueueEntry,
  phase: CandidatePhase,
  deferredOne: CheckResult,
  results: readonly CheckResult[],
): Promise<"deferred"> {
  const { change } = entry
  const { branch } = change
  const trailers: (readonly [string, string])[] = [
    ["Reason", deferredOne.why ?? "projection-exceeded"],
    ["Phase", phase],
    ["Config", run.options.configBlob],
    ["Base", run.targetSha],
  ]
  if (deferredOne.projectedMs !== undefined) {
    trailers.push(["ProjectedMs", String(deferredOne.projectedMs)])
  }
  if (deferredOne.boundMs !== undefined) {
    trailers.push(["BoundMs", String(deferredOne.boundMs)])
  }
  trailers.push(...checkTrailers(results))
  const subject =
    deferredOne.why === "stop-time"
      ? `${branch} deferred: stop time reached before ${phase === "merge" ? "on-merge checks" : "on-submit checks"} completed`
      : `${branch} deferred: ${deferredOne.name} projection exceeded normal bound`
  const deferredSha = await writeRecord(
    run,
    {
      change,
      kind: "deferred",
      subject,
      trailers,
    },
    tipOf(entry.change).sha,
  )
  if (deferredSha !== undefined) {
    await run.steps.ended(run, entry, "deferred", deferredSha, deferredSha)
  }
  return "deferred"
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
        stuckWrite(run, entry.change.branch, {
          code: "yrd-check-unresolved",
          next: `repair ${stuckOne.name} or its queue environment, then run yrd queue run`,
          subject: `the queue could not judge ${branch}: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
          trailers: checkTrailers(results),
          via: `${stuckOne.name} during submit`,
        }),
      )
    }
    const deferredOne = results.find((result) => result.result === "deferred")
    if (deferredOne !== undefined) {
      if (run.options.tier === "long" && deferredOne.why !== "stop-time") {
        return await run.steps.end(
          run,
          entry,
          "stuck",
          stuckWrite(run, entry.change.branch, {
            code: "yrd-check-unresolved",
            next: `inspect ${deferredOne.name} duration or reduce change scope`,
            subject:
              `the long tier check could not complete for ${branch}: ${deferredOne.name} projection exceeded bound`.trim(),
            trailers: checkTrailers(results),
            via: `${deferredOne.name} during submit`,
          }),
        )
      }
      return await writeDeferredRecord(run, entry, "submit", deferredOne, results)
    }
    const failing = results.filter((result) => result.result === "fail")
    if (failing.length > 0) {
      return await attributedFailure(run, entry, results, failing, "submit", composed.rootChanges?.changes ?? [])
    }
    const declaredForSubmit = run.options.checks.filter((candidate) => (candidate.on ?? ["merge"]).includes("submit"))
    if (results.length < declaredForSubmit.length) {
      return await writeDeferredRecord(
        run,
        entry,
        "submit",
        { name: "stop-time", result: "deferred", why: "stop-time", exit: 0, durationMs: 0, log: "" },
        results,
      )
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

type ComposedCandidate =
  | Readonly<{
      kind: "ready"
      mergeCommit: string
      rootChanges?: RootChanges
      worktree: PreparedWorktree
      /** Pins the settling merge kept AHEAD of their submodule main: the land publishes these, children first (24454). */
      publishing: readonly SettledGitlink[]
    }>
  | Readonly<{ kind: "failed"; detail: SuperMergeDetail; worktree: Worktree }>

/** Compose and settle the exact tree a phase will judge, then materialize that final commit before setup or checks run. */
async function composeCandidate(run: Run, entry: QueueEntry, phase: CandidatePhase): Promise<ComposedCandidate> {
  const { head } = entry.change
  const composed = await verifyCandidate({
    git: run.git,
    repo: run.options.repo,
    targetHead: run.targetSha,
    head,
    path: join(run.worktrees, "compose", phase, head.slice(0, 12)),
    message: mergeMessage(run, entry),
    env: run.options.env,
    process: run.options.process,
    hooksPath: run.hooksPath,
    worktree: {
      env: run.options.env,
      gitOptions: gitInvocationOptions(run.options, run.log),
      plumbing: run.plumbing,
      populateReference: run.options.populateReference,
      process: run.options.process,
      selection: run.options.selection,
    },
  })
  if (composed.state === "failed") {
    return { detail: composed.verifying.detail, kind: "failed", worktree: composed.failedWorktree }
  }
  const { verifying } = composed
  const mergeCommit = verifying.candidate
  const rootChanges = await readRootChanges(run.git, mergeCommit)
  for (const settled of verifying.gitlinks.filter((row) => row.state !== "not-run")) {
    const composition = settled.composition
    run.log.write({
      branch: entry.change.branch,
      // A COMPOSED ROW READS FROM ITS PARENTS, not from the recorded pin. Every
      // other settle row answers "where did this pin stand against its main",
      // so `from` is the pin; a composition has no single pin to report, and
      // the two facts a reader needs are which heads it joined and what came
      // out. `merged` names the commit this merge authored, and `files` is the
      // disjointness that admitted it, flattened because a record field is a
      // scalar or a string list.
      ...(composition === undefined
        ? { from: settled.from, to: settled.to }
        : {
            base: composition.base,
            files: [`main ${String(composition.files.parent)}`, `change ${String(composition.files.pin)}`],
            from: composition.parent,
            merged: settled.from,
            to: composition.pin,
          }),
      head,
      kind: "settle",
      path: settled.path,
      phase,
      state: settled.state,
    })
  }
  // AFTER the settle rows, so the journal reads parent-then-descent in the order
  // the walk actually ran. `children` is a string list rather than objects
  // because LogRecord fields are scalars or string arrays -- a nested shape
  // cannot be written here, and flattening keeps every row greppable.
  for (const descent of verifying.descents ?? []) {
    run.log.write({
      branch: entry.change.branch,
      children: descent.children.map((child) => `${child.path} ${child.state} ${child.target}`),
      head,
      kind: "descent",
      parent: descent.parent,
      parentTarget: descent.parentTarget,
      phase,
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
  return {
    kind: "ready",
    mergeCommit,
    ...(rootChanges === undefined ? {} : { rootChanges }),
    worktree,
    // A COMPOSED PIN PUBLISHES EXACTLY AS AN AHEAD ONE DOES, and by the same
    // proof: the component main tip is the composition's FIRST parent, so
    // advancing main to it is a plain fast-forward, leased on the value
    // git-super compared against and frozen into the merge. What is new is only
    // that the queue authored the commit (D1, @cto 2026-09-18) -- nothing here
    // pushes it, and no second push path exists: `publishChildren` moves the
    // component main after the root merge has passed every check, as it always
    // has.
    publishing: verifying.gitlinks.filter((row) => row.state === "kept-ahead" || row.state === "merged"),
  }
}

/** The queue's merge commit retains its change and actor in Git history. */
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
  if (detail.code === "gitlink-compose-refused") {
    // The change's pin and the component main the root records DIVERGED, and
    // the merge could not settle them: the two sides changed the same file, or
    // Git itself could not merge them. Either way the remedy is the author's
    // rebase, exactly as an ordinary conflict is, so this is a failed change
    // and the files that overlapped travel with it.
    await worktree.remove()
    const isUnfetchable = detail.message.includes("could not be fetched")
    if (isUnfetchable) {
      return run.steps.end(run, entry, "failed", {
        remedy:
          "resubmit from the checkout that holds the commit: yrd submit publishes a moved gitlink's commit to its " +
          "submodule remote (refs/git-super/pins), and a pin ahead of the submodule's main lands by the queue moving that main",
        subject: (detail.subject ?? detail.message).replace(/\s+/gu, " ").trim(),
        trailers: [
          ["Reason", "gitlink-not-on-remote"],
          ["Detail", detail.message.replace(/\s+/gu, " ").trim()],
        ],
      })
    }
    return run.steps.end(run, entry, "failed", {
      // THE CURE IS A MERGE, NOT A REBASE, and saying "rebase" sends the author
      // to a different operation than the one this queue performs. The queue
      // composes a diverged component BY MERGE; when it cannot, the author does
      // the same thing by hand.
      remedy:
        `merge the component's main into the component task branch, re-stage the gitlink on a merge of ` +
        `${run.options.target.branch}, push both, then submit ${entry.change.branch} again`,
      subject: (detail.subject ?? detail.message).replace(/\s+/gu, " ").trim(),
      trailers: [
        ["Reason", "conflict"],
        ["Detail", detail.message.replace(/\s+/gu, " ").trim()],
      ],
    })
  }
  if (detail.code === "gitlink-compose-unavailable") {
    // The merge could not JUDGE the diverged component -- a shallow store, an
    // object no remote supplied, two histories with no base. Nothing about the
    // submitted change is known to be wrong, so it keeps its place and the run
    // stops naming the command, rather than billing a queue-environment fault
    // to the author (@cto 7645ec3a).
    return run.steps.end(run, entry, "stuck", {
      ...stuckWrite(run, entry.change.branch, {
        code: "yrd-gitlink-compose-unavailable",
        detail: detail.message,
        next: detail.next ?? "repair the named condition in the queue's checkout, then run yrd queue run",
        subject: detail.subject ?? detail.message,
        via: `git super merge (${detail.code}, ${detail.phase}) at ${worktree.path}`,
        worktree: worktree.path,
      }),
      diagnosis: detail,
    })
  }
  if (detail.code === "gitlink-off-main") {
    // A pin that DIVERGED from its submodule's main. Until 2026-09-10 this was a
    // wait (H5): a person was expected to move main under it by hand. The queue
    // now moves a submodule main itself, forward only, to a pin that contains it
    // (24454), so the person the wait waited for no longer exists, and a wait
    // that nothing can clear is a hang wearing a status word. Back to the
    // submitter, the only one who can rebase.
    await worktree.remove()
    return run.steps.end(run, entry, "failed", {
      remedy:
        `${detail.next ?? "rebase the submodule commit onto its main."} The queue advances a submodule main only to ` +
        "a commit that contains it; a pin that diverged from main is the submitter's to rebase, then submit again.",
      subject: (detail.subject ?? detail.message).replace(/\s+/gu, " ").trim(),
      trailers: [
        ["Reason", "gitlink-off-main"],
        ["Detail", detail.message.replace(/\s+/gu, " ").trim()],
      ],
    })
  }
  if (detail.code === "nested-pin-lowered") {
    // A NESTED pin recorded below what its parent's own main already records
    // for it (24454 row 4). Its own remedy names "the submodule writer", and
    // the author is the only one who can re-record the gitlink -- so this is a
    // failed change, beside gitlink-off-main, never a queue fault.
    //
    // THE GENERAL RULE, because this is the second time it bit: a new refusal
    // code from git-super has to be classified HERE as well as accepted by the
    // reader. Everything this function does not name ends the round stuck, so a
    // submitter's mistake that arrives under an unknown code stops the line for
    // the fleet instead of going back to the one person who can fix it. Reading
    // the new word is half the contract; deciding whose fault it is, is the
    // other half.
    //
    // `gitlink-store-absent` is deliberately NOT here: it says the queue's own
    // checkout is wrong, and failing it would blame an author who did nothing.
    await worktree.remove()
    return run.steps.end(run, entry, "failed", {
      remedy:
        detail.next ??
        "re-record the nested gitlink at or after the pin its parent's main already carries, then submit again",
      subject: (detail.subject ?? detail.message).replace(/\s+/gu, " ").trim(),
      trailers: [
        ["Reason", "nested-pin-lowered"],
        ["Detail", detail.message.replace(/\s+/gu, " ").trim()],
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
    ...stuckWrite(run, entry.change.branch, {
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
        stuckWrite(run, entry.change.branch, {
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
      stuckWrite(run, entry.change.branch, {
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
    return run.steps.end(run, entry, "failed", {
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
  // THE PATH THE MEASURED OUTAGE ACTUALLY TOOK (@i/10-yrd/24486 rows 2 and 3).
  // A code host that is down fails the candidate AND the settled base, so
  // attribution lands here rather than on the bare `SetupFailed` branch — which
  // is why classifying only there would have fixed the reason for a case the
  // 504 never reached. Same two reasons, same one classifier.
  const read = setupLogText(result.log)
  const fault = transportFaultIn(`${read.text}\n${message}`)
  return run.steps.end(
    run,
    entry,
    "stuck",
    stuckWrite(run, entry.change.branch, {
      code: setupStuckCode(fault),
      next: setupStuckNext(fault),
      ...(fault === undefined ? {} : { remote: `setup could not reach a remote (${fault.signature})` }),
      subject:
        `the queue could not prepare a worktree for ${entry.change.branch}: ${message}` +
        (fault === undefined ? "" : `; unreachable remote (${fault.signature}): ${fault.line}`) +
        (read.unreadable === undefined ? "" : `; the setup log could not be read (${read.unreadable})`),
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

/** `<path> <submodule main before> -> <pin>`: what a publication moved, as a record and a log both say it. */
function publishedRow(row: SettledGitlink): string {
  // git-super reports a kept-ahead row as from=the pin, to=the main it was ahead of.
  return `${row.path} ${row.to} -> ${row.from}`
}

type Publication = Readonly<{ kind: "published"; record: string }> | Readonly<{ kind: "kept"; ended: Ended }>

/**
 * Move the submodule mains a merge kept its pins ahead of, before root main
 * moves (24454). Two writes, in this order, and each one durable before the next:
 *
 * 1. A landing record on the change ref, leased on the tip this run read. It
 *    retains the merge as its second parent, so the exact merge and the
 *    `Git-Super-Push:` intent frozen into it are on the remote before any
 *    submodule main moves: a reader of the record alone, or a fresh clone,
 *    knows what was about to be published and can finish it.
 * 2. `git super push --recurse-submodules=only` of that merge: git-super
 *    executes the publication it froze at compose, each submodule main leased
 *    on the value it was compared against, leaf first, and touches no root
 *    ref. Root main and the merged record then go through the ordinary atomic
 *    push, so a ring's fence still rides it.
 *
 * THE TWO REFUSALS ARE NOT THE SAME REFUSAL, and until 24951 they shared one
 * outcome. A refused LANDING RECORD (1) means the change ref moved under this
 * run: nothing was written anywhere, the change keeps its place, and the next
 * run composes again against whatever the submodule main is by then. A refused
 * PUBLICATION (2) happens after that record is already on the remote naming a
 * merge, and it can leave some component mains moved and others not — so it
 * stops the line naming the push, rather than leaving a half-published state
 * for the next run to compose against silently (@cto 2026-09-18).
 */
async function publishChildren(
  run: Run,
  entry: QueueEntry,
  cwd: string,
  mergeCommit: string,
  publishing: readonly SettledGitlink[],
  rootChanges: RootChanges | undefined,
  results: readonly CheckResult[],
): Promise<Publication> {
  const { change } = entry
  const { branch, head } = change
  const target = run.options.target
  const ref = changeRef(target.branch, change)
  const expectedTip = tipOf(change).sha
  const rows = publishing.map(publishedRow)
  const landingRecord = await recordCommit(
    run.git,
    {
      change,
      kind: "checked",
      subject: `${branch}: publishing ${rows.join(", ")} before the merge into ${target.branch}`,
      trailers: [
        ["Merge", mergeCommit],
        ...(rootChanges === undefined ? [] : [["Root-Changes", rootChanges.encoded] as const]),
        ["Base", run.targetSha],
        ["Merged-By", mergedBy(target.branch, run.log.id)],
        ...rows.map((row) => ["Publishing", row] as const),
        ...checkTrailers(results),
      ],
    },
    expectedTip,
  )
  try {
    await run.git([
      "push",
      "--quiet",
      "--atomic",
      `--force-with-lease=${ref}:${expectedTip}`,
      target.remote,
      `${landingRecord}:${ref}`,
    ])
  } catch (error) {
    const moved = await remoteHeads(run, branch, ref)
    if (moved.change === expectedTip) throw error
    run.log.write({
      branch,
      decision: "checked",
      expected: expectedTip,
      head,
      kind: "change",
      reason: "change-ref-moved",
      ...(moved.change === undefined ? {} : { saw: moved.change }),
    })
    return { kind: "kept", ended: "checked" }
  }
  const execution = await gitSuperExecution(
    { process: run.options.process, env: run.options.env, hooksPath: run.hooksPath },
    cwd,
    ["push", "--recurse-submodules=only", target.remote, `${mergeCommit}:refs/heads/${target.branch}`],
  )
  let published: GitSuperPushResult
  try {
    published = readGitSuperPushResult(JSON.parse(execution.stdout))
  } catch (error) {
    throw new Error(
      `git-super push exited ${String(execution.exitCode)} without readable JSON: ${execution.stderr.trim() || execution.stdout.trim()}`,
      { cause: error },
    )
  }
  const moved = published.repositories.flatMap((repository) =>
    repository.refs
      .filter((row) => row.state === "updated")
      .map((row) => `${repository.repository} ${row.destination} -> ${row.source.slice(0, 12)}`),
  )
  if (execution.exitCode === 0 && published.state === "updated" && !published.partial) {
    for (const row of publishing) {
      run.log.write({ branch, from: row.to, head, kind: "publish", path: row.path, phase: "merge", to: row.from })
    }
    return { kind: "published", record: landingRecord }
  }
  // The remotes answered and a component main this merge was about to move did
  // NOT move. What that leaves behind is the reason this is a stop and not a
  // wait: the landing record is already on the change ref naming a merge whose
  // children were not published, and some children may have moved while others
  // did not. Leaving the change "checked" here was the old behaviour; it is
  // loud in the journal but silent in the QUEUE, and the next run composes
  // against a half-published state nobody was told about. A composed pin makes
  // that worse, because the commit exists only as a retained ref until this
  // push lands it (24951, @cto 2026-09-18).
  const detail = published.detail
  const saw =
    `git-super push exit ${String(execution.exitCode)} state=${published.state} partial=${String(published.partial)}` +
    (detail === undefined ? "" : ` ${detail.code} (${detail.phase}): ${detail.message}`) +
    (moved.length === 0 ? "; nothing moved" : `; moved: ${moved.join(", ")}`)
  run.log.write({ branch, decision: "stuck", head, kind: "change", reason: "publication-refused", saw })
  return {
    ended: await run.steps.end(run, entry, "stuck", {
      ...stuckWrite(run, branch, {
        code: "yrd-publication-refused",
        detail: saw,
        next: `publish the named component mains, or repair what refused the push, then run yrd queue run`,
        subject: `${branch}: git super push --recurse-submodules=only did not advance every component main for merge ${mergeCommit.slice(0, 12)}`,
        via: `git super push --recurse-submodules=only ${target.remote} ${mergeCommit}:refs/heads/${target.branch} at ${cwd}`,
        worktree: cwd,
      }),
      ...(detail === undefined ? {} : { diagnosis: detail }),
    }),
    kind: "kept",
  }
}

type GitSuperPushResult = Readonly<{
  state: "updated" | "unchanged" | "failed" | "unknown"
  partial: boolean
  detail?: SuperMergeDetail
  repositories: readonly Readonly<{
    repository: string
    state: string
    refs: readonly Readonly<{ source: string; destination: string; state: string }>[]
  }>[]
}>

/** git-super push as the ruled command boundary; malformed JSON is never read as a publication. */
function readGitSuperPushResult(value: unknown): GitSuperPushResult {
  if (typeof value !== "object" || value === null) throw new Error("git-super push JSON is not an object")
  const found = value as Record<string, unknown>
  if (!new Set(["updated", "unchanged", "failed", "unknown"]).has(String(found.state))) {
    throw new Error(`git-super push JSON has invalid state ${String(found.state)}`)
  }
  if (typeof found.partial !== "boolean") throw new Error("git-super push JSON has no boolean partial field")
  if (!Array.isArray(found.repositories)) throw new Error("git-super push JSON has no repositories array")
  const repositories = found.repositories.map((row, index) => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`git-super push repository ${String(index)} is not an object`)
    }
    const repository = row as Record<string, unknown>
    if (typeof repository.repository !== "string" || !Array.isArray(repository.refs)) {
      throw new Error(`git-super push repository ${String(index)} is incomplete`)
    }
    const refs = repository.refs.map((entry, at) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`git-super push ref ${String(index)}.${String(at)} is not an object`)
      }
      const ref = entry as Record<string, unknown>
      if (typeof ref.source !== "string" || typeof ref.destination !== "string" || typeof ref.state !== "string") {
        throw new Error(`git-super push ref ${String(index)}.${String(at)} is incomplete`)
      }
      return { source: ref.source, destination: ref.destination, state: ref.state }
    })
    return { repository: repository.repository, state: String(repository.state), refs }
  })
  const detail = found.detail === undefined ? undefined : readSuperMergeDetail(found.detail)
  return {
    state: found.state as GitSuperPushResult["state"],
    partial: found.partial,
    ...(detail === undefined ? {} : { detail }),
    repositories,
  }
}

/** The on-merge phase for the first checked change. */
async function merge(run: Run, entry: QueueEntry): Promise<Ended> {
  const { change } = entry
  const { branch, head } = change
  const name = changeName(change)
  const composed = await composeCandidate(run, entry, "merge")
  if (composed.kind === "failed") return candidateFailure(run, entry, composed.detail, composed.worktree)
  const { mergeCommit, rootChanges, worktree, publishing } = composed
  // 24573: the path to KEEP instead of removing, set when a check fails or the
  // digest above disagrees. @dev/4 went for this root three times on one branch
  // and found it already gone each time, so every diagnosis had to be an
  // inference from behaviour — and behaviour cannot separate a stale module
  // from a wrong test. Success still tears down: nothing is pooled or reused.
  let retained: string | undefined
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
    // 24573: BEFORE anything is judged, say what is about to be read. One row
    // per path the candidate changed, carrying the blob the merge commit
    // records and the hash of the bytes actually on disk. The comparison is
    // self-referential on purpose — it asks whether this root contains the
    // commit it claims to be and takes no candidate sha as input, so it cannot
    // be fooled by being handed the wrong one. A disagreement names root
    // construction; agreement leaves resolution, and until this row existed
    // nobody could tell those apart once the root was torn down.
    const judged = await judgedTreeDigest(
      worktree.path,
      merged,
      run.options.process,
      run.options.selection,
      gitInvocationOptions(run.options, run.log),
    )
    for (const file of judged) {
      run.log.write({
        branch,
        committed: file.committed,
        head,
        kind: "judged",
        ondisk: file.ondisk,
        path: file.path,
        phase: "merge",
        same: file.same,
      })
    }
    const divergent = judged.filter((file) => !file.same)
    if (divergent.length > 0) {
      // NOT a check failure and deliberately not fatal: the queue's own ground
      // is wrong, which is nobody's submission, and a change must not be
      // attributed to a submitter for it. It is loud, named, and retained.
      retained = worktree.path
      run.log.write({
        branch,
        head,
        kind: "observation",
        paths: divergent.map((file) => `${file.path} committed=${file.committed} ondisk=${file.ondisk}`),
        phase: "merge",
        why: `the merge root does not contain ${mergeCommit.slice(0, 12)} at ${divergent.length} path(s) the candidate changed`,
      })
    }
    const results = await runPhase(run, entry, "merge", worktree.path, merged)
    const stuckOne = results.find((result) => result.result === "stuck")
    if (stuckOne !== undefined) {
      return await run.steps.end(
        run,
        entry,
        "stuck",
        stuckWrite(run, entry.change.branch, {
          code: "yrd-check-unresolved",
          next: `repair ${stuckOne.name} or its queue environment, then run yrd queue run`,
          subject: `the queue could not judge ${branch} at merge: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
          trailers: checkTrailers(results),
          via: `${stuckOne.name} during merge`,
        }),
      )
    }
    const deferredOne = results.find((result) => result.result === "deferred")
    if (deferredOne !== undefined) {
      if (run.options.tier === "long" && deferredOne.why !== "stop-time") {
        return await run.steps.end(
          run,
          entry,
          "stuck",
          stuckWrite(run, entry.change.branch, {
            code: "yrd-check-unresolved",
            next: `inspect ${deferredOne.name} duration or reduce change scope`,
            subject:
              `the long tier check could not complete for ${branch} at merge: ${deferredOne.name} projection exceeded bound`.trim(),
            trailers: checkTrailers(results),
            via: `${deferredOne.name} during merge`,
          }),
        )
      }
      return await writeDeferredRecord(run, entry, "merge", deferredOne, results)
    }
    const failing = results.filter((result) => result.result === "fail")
    if (failing.length > 0) {
      retained = worktree.path
      return await attributedFailure(run, entry, results, failing, "merge", rootChanges?.changes ?? [])
    }
    const declaredForMerge = run.options.checks.filter((candidate) => (candidate.on ?? ["merge"]).includes("merge"))
    if (results.length < declaredForMerge.length) {
      return await writeDeferredRecord(
        run,
        entry,
        "merge",
        { name: "stop-time", result: "deferred", why: "stop-time", exit: 0, durationMs: 0, log: "" },
        results,
      )
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
    let expectedTip = tipOf(entry.change).sha
    // 24454: a pin the merge kept AHEAD of its submodule main lands by moving
    // that main, and the queue moves it, only now, after every check passed on
    // the merged tree, and children first: a root main whose gitlink names a
    // commit no submodule main carries strands every fresh clone, while a
    // submodule main ahead of root is the one partial state this landing
    // accepts, and the next run composes on it as an Equal pin.
    if (publishing.length > 0) {
      const landing = await publishChildren(run, entry, worktree.path, mergeCommit, publishing, rootChanges, results)
      if (landing.kind === "kept") return landing.ended
      expectedTip = landing.record
    }
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
          ...publishing.map((row) => ["Published", publishedRow(row)] as const),
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
      published: publishing.map(publishedRow),
      tip: mergeCommit,
    })
    run.log.write({ branch, decision: "merged", head, kind: "change" })
    if (rootChanges !== undefined) await cleanupRootChanges(run.git, rootChanges, mergedRecord)
    await run.steps.ended(run, entry, "merged", mergedRecord, mergedRecord)
    return "merged"
  } finally {
    if (retained === undefined) {
      await worktree.remove()
    } else {
      // Say where it is, in the journal that is always written, or a retained
      // root is just disk nobody knows to read.
      run.log.write({ branch, head, kind: "retained", path: retained, phase: "merge" })
    }
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
 * withdrawn with the reason `deleted` or `replaced` and no message: the
 * submitter did it (§ The change), and it is the one word the reader already
 * derived for it (@i/10-yrd/24492). Written once; a change that already ended
 * is left as it ended.
 */
async function retire(run: Run, entry: QueueEntry): Promise<void> {
  const reason = entry.reading.reason
  if (entry.reading.state !== "withdrawn" || (reason !== "deleted" && reason !== "replaced")) return
  if (standsEnded(tipOf(entry.change))) return
  const { change } = entry
  const { branch, head } = change
  const retiredRecord = await writeRecord(
    run,
    {
      change,
      kind: "withdrawn",
      subject:
        reason === "deleted"
          ? `${branch} was deleted by its submitter`
          : `${branch} moved off ${head.slice(0, 12)}; its submitter replaced it`,
      trailers: [["Reason", reason]],
    },
    tipOf(entry.change).sha,
  )
  if (retiredRecord === undefined) return
  run.log.write({ branch, decision: "withdrawn", head, kind: "change", reason })
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
    stuckWrite(run, entry.change.branch, {
      code: "yrd-merge-orphaned",
      next: absorbed
        ? `${found.commit.slice(0, 12)} is already an ancestor of ${target} some other way; confirm ${branch} is truly done, close it by hand, then run yrd queue run`
        : `read ${found.foundAt} and note any submodule gitlink ${found.commit.slice(0, 12)} raised that ${target} does not carry yet — the recomposition raises it again; then discard the orphan and run yrd queue run, which recomposes ${branch} from scratch and merges it through the queue. Never push the orphan onto ${target} by hand: only the queue writes ${target}, and a hand push resets the unattended-window clock (@i/10-yrd/24344)`,
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
    // silent-fallback-allow: `undefined` here is "not this change's evidence",
    // and it is a DECIDED outcome rather than a swallowed failure. The `orphan`
    // record written first is the log's eleventh kind, specified for exactly
    // this case — "one row for what recovery decided, or for a candidate it
    // found but would not trust" (log.ts:16-19) — and the journal is the source
    // of truth, not a second copy of it.
    //
    // Not trusting is the point. A worktree whose parents this run cannot read
    // cannot be shown to be THIS head's orphan, and guessing it into the
    // change's evidence is the failure 24344 exists to prevent: never redo the
    // merge, never guess. The alternative — ending stuck — would let one
    // unreadable leftover from an unrelated dead run stop a healthy change.
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
  await validateScripts(run, spec)
  const scripts = spec.scripts ?? []
  if (scripts.length === 0) return
  const wt = gitIn(cwd, run.options.process, run.options.selection, gitInvocationOptions(run.options, run.log))
  for (const path of scripts) {
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
  const change = changeName(entry.change)
  // A change taken once more after a stuck the remote caused writes its logs
  // beside the first attempt's, never over them: the first attempt's logs are
  // the only evidence of the fault the retry cleared (a check log is opened
  // create-only, so a shared path would crash the retry instead).
  const attempt = run.retried.has(change) ? ["retry-1"] : []
  return join(run.options.workdir, "checks", change, run.log.id, ...attempt, phase)
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
    if (isStopWindowClosed(run.options)) {
      run.log.write({
        kind: "observation",
        why: `stop time reached (${new Date(run.options.stopAtMs).toISOString()}); stopping starting new checks for ${entry.change.branch}`,
      })
      break
    }
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
  if (spec.programRoot === true) {
    try {
      return await programRootCheck({
        git: run.git,
        repo: run.options.repo,
        targetSha: run.targetSha,
        tree,
        spec,
        branch: entry.change.branch,
        head: entry.change.head,
        phase,
        root: join(run.worktrees, "program", phase, entry.change.head.slice(0, 12), spec.name),
        logDir: checkLogDir(run, entry, phase),
        tmpdir: run.tmpdir,
        log: run.log,
        env: run.options.env,
        process: run.options.process,
        selection: run.options.selection,
        gitOptions: gitInvocationOptions(run.options, run.log),
        populateReference: run.options.populateReference,
        plumbing: run.plumbing,
        setup: run.options.setup,
        extraEnv,
        tier: run.options.tier,
      })
    } catch (error) {
      if (!(error instanceof ProgramSubjectSetupFailed) || phase === "base") throw error
      const rootChanges = await readRootChanges(run.git, tree.candidate)
      throw new CandidateSetupFailed(error.setup, phase, rootChanges?.changes ?? [])
    }
  }
  await restoreScripts(run, spec, cwd)
  return runDeclaredCheck(run, entry, spec, cwd, tree, phase, extraEnv)
}

/** Run the existing legacy check grammar in its prepared phase tree. */
async function runDeclaredCheck(
  run: Run,
  entry: QueueEntry,
  spec: CheckSpec,
  cwd: string,
  tree: CheckedTree,
  phase: Phase,
  extraEnv?: Readonly<Record<string, string>>,
): Promise<CheckResult> {
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
    tier: run.options.tier,
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

async function end(run: Run, entry: QueueEntry, kind: "failed" | "stuck", ended: EndedWrite): Promise<Ended> {
  // ONE TRANSIENT RETRY, INSIDE THE ROUND (the andon, operator 2026-09-16). A
  // stuck the remote caused is not written the first time: the loop takes the
  // change once more, and only a second stuck stops the line. The number is
  // one; a remote down for longer is a stopped line and a page, never a loop.
  // Its trace is a `warning` row, the kind a compose that went to the network
  // already writes, told apart by `reason`: a new row kind or decision would be
  // a word every older running reader has never seen (@i/10-yrd/b-wrong/24735).
  const name = changeName(entry.change)
  if (kind === "stuck" && ended.remote !== undefined && !run.retried.has(name)) {
    run.retried.add(name)
    run.log.write({
      branch: entry.change.branch,
      head: entry.change.head,
      kind: "warning",
      reason: "retried",
      remote: ended.remote,
      subject: ended.subject,
      ...(ended.incident === undefined ? {} : { code: ended.incident.code }),
    })
    throw new RetryOnce(name)
  }
  // Who is billed follows from the kind, once: a fail is the submitter's, and
  // says so; a stuck is always the queue's, so its record says nothing about
  // fault (a constant trailer says nothing). A `replaced` or `deleted` change
  // bills nobody and never comes through here.
  const trailers = [
    ...ended.trailers,
    ...(kind === "failed" ? [["Fault", "submitter"] as const] : []),
    ...(ended.remedy === undefined ? [] : [["Remedy", ended.remedy] as const]),
    ...(kind === "stuck" && run.retried.has(name) ? [["Retried", "1"] as const] : []),
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
  branch: string,
  cause: Readonly<{
    code: Incident["code"]
    subject: string
    via: string
    next: string
    detail?: string
    worktree?: string
    trailers?: readonly (readonly [string, string])[]
    /** Set only where the queue could not reach a remote: the stuck is taken once more before it is written. */
    remote?: string
  }>,
): EndedWrite {
  const subject = cause.subject.replace(/\s+/gu, " ").trim()
  // Every stuck record names ALL FOUR ways out of the line, in words that
  // cannot be read as "re-push the same content" (@i/10-yrd/24492 box 2; resume
  // since the andon made a stuck stop the line; yrd merge for a queued fix).
  const next = `${cause.next}; ${stuckCures(branch)}`
  const incident = {
    code: cause.code,
    subject,
    via: `${cause.via} in yrd queue ${run.name} [${run.log.id}]`,
    evidence: run.log.path,
    next,
    owner: "the queue operator",
  }
  return {
    subject,
    incident,
    ...(cause.detail === undefined ? {} : { detail: cause.detail }),
    ...(cause.worktree === undefined ? {} : { worktree: cause.worktree }),
    ...(cause.remote === undefined ? {} : { remote: cause.remote }),
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
    deferred: string[]
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
