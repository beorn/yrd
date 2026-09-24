/**
 * The queue commands ([plan](../../../../pm/@i/10-yrd/plan.md) § The final
 * design, Commands).
 *
 * A queue is a branch whose commit carries a `.yrd.yml` the parser can read.
 * That is the whole of the question "is there a queue here": the file at HEAD
 * says where to look (`target: <remote>#<branch>`, optional), and the file at
 * the TARGET is the declaration that judges.
 *
 * `remote:` used to be the switch — its presence chose this core over the
 * incumbent at flag day (§ Cutover) — and that made an optional key mandatory
 * in practice, with a refusal that told a repository declaring nothing else to
 * add a line it does not need. The incumbent went at M6; the switch goes here.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { tryAcquireFlock, type FlockHandle } from "@bearly/flock"
import { listRefs } from "gitomic/events"
import type { ConditionalLogger } from "loggily"
import { adaptProcessGit, createProcess, gitFailure, processStartIdentity } from "@yrd/process"
import {
  CHANGE_REF_DIAGNOSTICS,
  assertPlainEventQueueConfig,
  directMergeCommits,
  changeName,
  checksOf,
  claimWorktrees,
  directMergeLine,
  drop,
  pauseLine,
  eventDirectMergeCommits,
  eventPause,
  eventRows,
  listChangeHistories,
  queueFormat,
  queueRef,
  queueRefPrefix,
  changesRef,
  readChangeEvents,
  readEventQueue,
  writeQueueEvent,
  prepareWorktree,
  checkedTree,
  programRootCheck,
  openLog,
  gitIn,
  incidentLine,
  incidentLines,
  journalKey,
  list,
  queueName,
  resolveGitSelection,
  queueRun,
  readConfig,
  readJournals,
  readHistories,
  readQueue,
  readRunLog,
  remoteUrl,
  subjects,
  targetName,
  runCheck,
  show,
  inspectSubmit,
  freshnessLine,
  readRemoteCommit,
  refAt,
  readDrafts,
  DRAFT_WINDOW_MS,
  endingInstants,
  submit,
  withdraw,
  NothingToWithdraw,
  liftLine,
  pauseStop,
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  QUEUE_HEALTH_DOCUMENT,
  ROUND_BUDGET_MS,
  ROUND_LOCK,
  relaunchStalledHealthDocument,
  roundHealthDocument,
  writtenHealthDocument,
  runtimeGitlinkPath,
  readStop,
  stopFact,
  QueuePaused,
  QueueNotPaused,
  writePause,
  readCheckTrailer,
  trailers,
  type CheckResult,
  type CheckSpec,
  type CheckView,
  type Journals,
  type JournalRun,
  type Git,
  type IssueResolution,
  type GitRunner,
  type GitObservation,
  type GitSelection,
  type HealthWriter,
  type Incident,
  type LogRecord,
  type QueueConfig,
  type QueueHealthDocument,
  type QueueRunOutcome,
  type PauseRecord,
  type RuntimeGitlinkOff,
  type ChangeRecord,
  type Change,
  type EventChange,
  type EventQueue,
  type DraftReading,
  type Row,
  type StopFact,
} from "@yrd/queue-core"
import { noticeLine } from "./watch-notice.ts"
import { FILTER_FIELDS, filterRows, rowLine, watchRows, type WatchRow } from "./watch-rows.ts"
import type { ChangeDetail, CheckPanel, DiffText } from "./watch-detail.tsx"

import type { DraftWindow, WatchQueue } from "./watch-list.tsx"
import type { WatchSnapshot } from "./watch-pane.tsx"
import { runOf } from "./watch-run.ts"
import { stripAnsi } from "@silvery/ansi"
import {
  CHECK_GLYPH,
  STATE_WORDS,
  clock,
  diagnosticLines,
  firstLine,
  mediaDuration,
  timingLine,
} from "./watch-format.ts"
import { readRunnerFacts, type RunnerFacts } from "./watch-runner.ts"
import { decisionsOfRows, type RunDecision } from "./watch-stats.ts"
import {
  DEFAULT_WINDOW_MS,
  formatQueueStats,
  parseSince,
  queueStats,
  type SinceOrigin,
  type StatsBy,
} from "./queue-stats.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"
import { SERVICE } from "./queue-health.ts"

import { workdirOf } from "./workdir.ts"
import { originHead } from "./queue-location.ts"

function issueOutput(io: YrdCliIO, branch: string, resolution: IssueResolution | undefined) {
  if (resolution === undefined) return {}
  if (resolution.source === "legacy-branch") {
    io.stderr(
      `yrd: legacy branch-name fallback: ${branch} -> ${resolution.issue}; no explicit issue binding was found\n`,
    )
  }
  return {
    issue: resolution.issue,
    issueSource: resolution.source,
    ...(resolution.commit === undefined ? {} : { issueCommit: resolution.commit }),
  }
}

/**
 * How long the relaunch may wait for the shared checkout before it says so.
 *
 * The round budget, deliberately: this wait REPLACES a round, so the service
 * should not wait unannounced for longer than a round was allowed to take. Past
 * it the wait is no longer "the updater is a moment behind" — it is a checkout
 * that is not coming, and the difference has to reach a person rather than
 * accumulate. The heartbeat keeps the waiting document fresh meanwhile; this cap
 * is the alarm, not the freshness.
 */
const RELAUNCH_WAIT_CAP_MS = ROUND_BUDGET_MS

// Observe this module's checkout when it loads, before declaration fetching or
// any later queue call. A later disk HEAD is projection state, not loaded code.
const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const sourceAtLoad = await (async () => {
  await using process = createProcess()
  const source = adaptProcessGit(process, { timeoutMs: 5000 })
  try {
    // The SUPERPROJECT is read here, beside the checkout, because it is the
    // same kind of fact: what this runtime IS, observed once at module load.
    // It is what decides the relaunch exit (@i/10-yrd/24515) — the question is
    // "what path does this runtime occupy in its own superproject", never
    // "where is the queue working today".
    //
    // An empty answer is normal and not a failure: a standalone clone of yrd
    // has no superproject, so `--show-superproject-working-tree` prints
    // nothing and exits 0.
    const [checkout, head, superproject] = await Promise.all([
      source.run({ repo: sourceDirectory, args: ["rev-parse", "--show-toplevel"] }),
      source.run({ repo: sourceDirectory, args: ["rev-parse", "--verify", "HEAD^{commit}"] }),
      source.run({ repo: sourceDirectory, args: ["rev-parse", "--show-superproject-working-tree"] }),
    ])
    for (const result of [checkout, head, superproject]) {
      if (result.code !== 0 || result.timedOut || result.signal || result.failure) {
        throw new Error(`source Git in ${sourceDirectory}: ${gitFailure(result, 5000)}`)
      }
    }
    return {
      checkout: checkout.stdout.trim(),
      sha: head.stdout.trim(),
      superproject: superproject.stdout.trim(),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})()

export type CoreQueueCommand =
  | Readonly<{
      command: "submit"
      branch?: string
      submitter: string
      issue?: string
      dryRun?: boolean
    }>
  | Readonly<{ command: "pause"; by: string; reason: string }>
  | Readonly<{ command: "resume"; by: string; reason?: string }>
  | Readonly<{ command: "withdraw"; branch: string; by: string; reason?: string }>
  | Readonly<{ command: "drop"; branch: string; by: string; reason?: string }>
  | Readonly<{ command: "run"; tier?: "normal" | "long"; stopAtMs?: number }>
  | Readonly<{
      command: "merge"
      branch: string
      submitter: string
      issue?: string
      /**
       * The author's checkout, which a change that is not open is submitted
       * from; absent when the command runs outside a clone, which can merge
       * only a change already in line.
       */
      author?: Readonly<{ repo: string; selection: GitSelection; remote?: string }>
    }>
  | Readonly<{
      command: "up"
      intervalSeconds?: number
      stop?: AbortSignal
      /**
       * The gitlink carrying this yrd. Absent, its physical path and the
       * checkout observed at module load are used, even if the target moved
       * ahead. A test can name them without running from a submodule checkout.
       */
      gitlink?: Readonly<{ path: string; sha: string }>
      /**
       * How long the relaunch waits for the shared checkout before it ends
       * stuck. Defaults to {@link RELAUNCH_WAIT_CAP_MS}.
       *
       * A test names it for one reason only: the production cap is ten minutes,
       * and a test that actually waited that long would be deleted rather than
       * fixed the first time it was slow. The BEHAVIOUR under test is the same
       * at 50ms and at ten minutes.
       */
      relaunchWaitCapMs?: number
      /**
       * How long the loop waits on another round's lock before it logs the wait
       * as long. Defaults to `ROUND_BUDGET_MS`. A test names it for the reason
       * it names `relaunchWaitCapMs`: the behaviour past the budget is the same
       * at 50ms and at ten minutes.
       */
      roundLockStallMs?: number
      /**
       * How often the loop restates its health document. Defaults to
       * {@link HEARTBEAT_INTERVAL_MS}.
       *
       * A test names it, and the grace below, for the reason it names
       * `relaunchWaitCapMs`: the production heartbeat is a minute and its grace
       * five, and the behaviour under test — a document that stays fresh while
       * its writer lives, and goes overdue once it stops — is the same at a
       * tenth of a second.
       */
      heartbeatIntervalMs?: number
      /** How long past its next heartbeat the document is still believed. Defaults to {@link HEARTBEAT_GRACE_MS}. */
      heartbeatGraceMs?: number
      /** Awaited after each round, before the gitlink is read; a test mutates the world or stops the service here. */
      afterRound?: (outcome: QueueRunOutcome) => void | Promise<void>
      /**
       * Awaited after EVERY round, including every round that holds a stopped
       * line, with the document that round wrote.
       *
       * It is the seam that sees the PAGE: a stuck change stops the line and the
       * service stays up holding it (the andon, operator 2026-09-16), so a test
       * reads the page here and stops the service through `stop`. A test
       * without it would hold a stopped line forever, which is the correct
       * behaviour and an untestable one.
       */
      afterHealth?: (document: QueueHealthDocument) => void | Promise<void>
    }>
  | Readonly<{
      command: "list"
      /** Case-insensitive OR terms over the branch, the subject, the run and the failure (S2.12). */
      terms?: readonly string[]
      /** One row per change instead of one per run (S2.13). */
      latest?: boolean
      /** Refresh until an ending, or until stopped: `yrd queue list --watch`, and `yrd watch` (README 1069). */
      watch?: boolean
      /** Seconds between refreshes while watching; the default is 5. */
      intervalSeconds?: number
      /** Stops the watch; a test ends the loop with it, a terminal ends it with a signal. */
      stop?: AbortSignal
      /**
       * Exit 1 instead of 0 when a filter term matches no rows, for a caller who
       * wants a zero treated as failure. Default stays exit 0: a filter term
       * matching zero rows is user input producing an empty result, not an
       * invariant violation, and this keeps every existing script working
       * (@chief ruling, 2026-09-07, a-state-name-filters-to-zero-rows-and-exit-zero AC1).
       * Only the one-shot reading honours it; `watch` already refuses louder
       * (exit 2) when a selector matches nothing, which this does not change.
       */
      requireMatch?: boolean
    }>
  | Readonly<{ command: "show"; branch: string }>
  | Readonly<{
      command: "stats"
      /** `3h`, an instant, or a commit: rows decided before it and refs whose tip is older are outside the window. */
      since?: string
      /** The grouping under the whole-queue line: `submitter` (default) or `branch`. */
      by?: StatsBy
      /** The instant the stats are at; a test pins it, the CLI takes the clock. */
      now?: Date
    }>
  | Readonly<{ command: "check"; names: readonly string[] }>

/** What each command is called when it has to say it needs a queue. */
const NAMED: Readonly<Record<CoreQueueCommand["command"], string>> = {
  check: "check",
  drop: "drop",
  pause: "queue pause",
  list: "queue list",
  merge: "merge",
  run: "queue run",
  show: "queue show",
  stats: "queue stats",
  submit: "submit",
  resume: "queue resume",
  up: "queue up",
  withdraw: "queue withdraw",
}

/**
 * Run one queue command on the new core.
 *
 * A repository whose declaration does not select this core is refused HERE,
 * with the one line that cures it. Until M6 this answered `undefined` and every
 * one of the six call sites in cli.ts carried its own `?? notSelected(...)` —
 * six chances to forget, for a fallthrough to an incumbent that no longer
 * exists.
 */
export async function coreQueueCommand(
  repo: string,
  io: YrdCliIO,
  request: CoreQueueCommand,
  options: Readonly<{
    json?: boolean
    env?: NodeJS.ProcessEnv
    workdir?: string
    /** The queue branch selected by the CLI; absent means origin/HEAD. */
    queue?: string
    /** Explicit submission destination; the author checkout remains the source. */
    remote?: string
    log?: ConditionalLogger
    /** Fixed from the command's first queue read through every service round. */
    selection?: GitSelection
    /** A terminal with a keyboard on the other end: the watch draws its pane instead of printing rounds. */
    interactive?: boolean
    /**
     * Whether `repo` is the queue's own clone (`QueueLocation.owned`). Only
     * then may a compose populate the submodule stores it borrows from;
     * composing from a seat's checkout leaves that tree exactly as it found it.
     */
    populateReference?: boolean
  }> = {},
): Promise<YrdCliExitCode> {
  /**
   * The selected queue branch carries no declaration, so it runs no queue.
   *
   * `ref` is whatever was resolved — an explicit `--queue <repo>#<branch>` or
   * the default `origin/HEAD` of `repo` — and this function cannot tell which:
   * by the time a caller reaches here, `resolveQueueLocation` has already
   * turned an omitted `--queue` into a concrete branch name (queue-location.ts),
   * so an addressed miss and a repository that never declared one at all
   * produce the identical call. The cure below is worded to hold for both.
   */
  const noQueueOnTarget = (ref: string): YrdCliExitCode => {
    io.stderr(
      `yrd: ${NAMED[request.command]} needs a queue, and ${ref} carries no .yrd.yml. ` +
        "The queue's config lives on the queue branch itself. Point at a different one with " +
        "--queue <repo>#<branch>, or, if this repository is a submodule with none of its own, " +
        "the superproject that vendors it gates the change instead, by checking the gitlink, " +
        "not a declaration here.\n",
    )
    return 2
  }
  const selection = options.selection ?? (await resolveGitSelection(repo, { env: options.env }))
  const git = gitIn(repo, undefined, selection, { env: options.env })
  const log = options.log?.child("queue")
  const remote = options.remote ?? "origin"
  const queue = options.queue ?? (await originHead(git))
  const target = { branch: queue, remote }
  const targetLabel = `${remote}/${queue}`
  type CapturedDeclaration = Readonly<{ config: QueueConfig; oid: string }>
  // The target's declaration as the target holds it now: fetched, read in full
  // and held to its keys, then the remote it names resolved. Undefined when the
  // target carries no `.yrd.yml` at all — there is no queue there; a
  // declaration that exists and cannot be read throws. One reading serves a
  // one-shot command; the service reads again before every round, so an edit at
  // the target takes effect on the next round.
  const declaration = async (): Promise<CapturedDeclaration | undefined> => {
    const oid = await readRemoteCommit(git, remote, `refs/heads/${queue}`)
    if (oid === undefined) throw new Error(`the target ${targetLabel} is not at ${remote}`)
    let declared: QueueConfig | undefined
    try {
      declared = await readConfig(git, oid, target)
    } catch (error) {
      throw new Error(
        `the declaration at ${targetLabel} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    if (declared === undefined) return undefined
    return { config: declared, oid }
  }
  const captured = await declaration()
  if (captured === undefined) return noQueueOnTarget(targetLabel)
  const config = captured.config
  const workdir = options.workdir ?? (await workdirOf(git))
  mkdirSync(workdir, { recursive: true })

  /** The one shape a command that could not judge answers with (plan § The queue run). */
  const stuck = (why: string): YrdCliExitCode => {
    emit(io, options.json, { exitCode: 2, failed: [], merged: [], stuck: [], why }, `stuck: ${why}`)
    return 2
  }
  /**
   * One queue run, emitted. Undefined is the one exit site from the caller's
   * side: a run that could not even judge — a bad invocation, a remote that
   * cannot be read — is stuck, has no change to stop the line on, and has
   * already said so.
   */
  const oneRound = async (
    declared: CapturedDeclaration,
    only?: Change,
    tier?: "normal" | "long",
    stopAtMs?: number,
  ): Promise<QueueRunOutcome | undefined> => {
    let outcome: QueueRunOutcome
    try {
      if ((await queueFormat({ repo, remote: config.target.remote }, config.target.branch)) === "event") {
        assertPlainEventQueueConfig(config, "run")
      }
      outcome = await queueRun({
        ...runOptions(repo, declared, workdir, selection, options.env, options.log, options.populateReference),
        foreground: request.command === "run" || request.command === "merge",
        ...(only === undefined ? {} : { only }),
        ...(tier === undefined ? {} : { tier }),
        ...(stopAtMs === undefined ? {} : { stopAtMs }),
      })
    } catch (error) {
      stuck(`the queue run could not judge: ${error instanceof Error ? error.message : String(error)}`)
      // silent-fallback-allow: stuck() emitted the full run failure; undefined only makes the command exit 2.
      return undefined
    }
    emit(io, options.json, outcome, describeRun(outcome))
    // Naming the branch is `describeRun`'s; naming what fixes it is this
    // round's own log, which the ending that stuck it already wrote in full
    // (run.ts `end()`). `queue list` and `queue show` render the same stored
    // incident with `incidentLine`; a stuck round names it the same way on
    // stderr, so "stuck task/one" is never the whole story a person gets
    // (@i/10-yrd/24141 AC2).
    for (const line of stuckCureLines(outcome)) io.stderr(`yrd: ${line}\n`)
    // A round that HOLDS a stuck stop judged nothing, so it has no stuck line
    // of its own; it names the stop it held and the cures, so a service log
    // read at any round says what the line waits on and what lifts it.
    const held = pauseStop(outcome.stopped)
    if (outcome.stuck.length === 0 && held?.change !== undefined) {
      io.stderr(`yrd: ${liftLine(held, config.target.remote, config.target.branch)}\n`)
    }
    return outcome
  }

  /** The stop a submit is accepted under, said where the submitter reads it: who, why, and what lifts it. */
  const echoStop = (stop: PauseRecord | undefined): void => {
    if (stop === undefined) return
    io.stderr(
      `yrd: accepted while the line is stopped — ${pauseLine(stop)}; ` +
        `the change waits in line and is judged once the stop lifts; ${liftLine(stop, config.target.remote, config.target.branch)}\n`,
    )
  }

  /**
   * This process as the round lock's body names it, beside when it took the
   * lock: diagnostic bytes for a waiter, judged nowhere. The start is the
   * runtime's own, as the health document's writer states it; the boot and
   * start tick are the pair a supervisor compares by equality (24340).
   */
  const lockHolder: Omit<RoundLockHolder, "since"> = {
    command: process.argv.join(" "),
    host: hostname(),
    pid: process.pid,
    startedAt: new Date(performance.timeOrigin).toISOString(),
    ...processStartIdentity(process.pid),
  }

  /**
   * ONE ROUND AT A TIME in this workdir (andon phase 2, the round lock). Every
   * round-runner — `queue up`, `queue run` and `merge` — runs its round
   * through here, and this is the whole order, with no branch for whether it
   * waited: take the lock, read the declaration, `before` (the service's
   * reload), run the round, release. `only` scopes the round to one change.
   *
   * The lock is a kernel flock on the workdir's {@link ROUND_LOCK} file, held
   * on one descriptor for the round. The kernel releases it when that
   * descriptor closes, which a holder that exits or dies does whatever it
   * leaves running, so nothing here judges whether a holder is alive. The
   * file's body names the holder (command, pid, host, start, and when it took
   * the lock) only so a waiter can say whose round it waits for; it is judged
   * nowhere. Between a take and its body's write, a waiter can read the body
   * of the holder before, and says the new holder once it reads it.
   *
   * The declaration is read under the lock, so a round never judges a target
   * captured before it waited. The lock is released before the caller does
   * anything with the outcome, so a document, a hook or a sleep after a round
   * never holds the next runner up.
   *
   * A runner in the foreground names the holder on stderr when it starts
   * waiting, and once more past the round budget; the service passes
   * `waiting` to put the wait on its health document as a fact instead, and
   * stays healthy. Neither ever takes the lock over.
   */
  const lockedRound = async (
    round: Readonly<{
      before?: (declared: CapturedDeclaration) => Promise<YrdCliExitCode | undefined>
      only?: Change
      tier?: "normal" | "long"
      stopAtMs?: number
      stallMs?: number
      stop?: AbortSignal
      waiting?: Readonly<{
        onWait: (wait: RoundLockWait) => void
        onStall: (wait: RoundLockWait & Readonly<{ waitedMs: number }>) => void
      }>
    }> = {},
  ): Promise<Readonly<{ declared: CapturedDeclaration; outcome: QueueRunOutcome }> | YrdCliExitCode> => {
    // Read through a call each time: the signal flips while the lock is waited for.
    const stopped = (): boolean => round.stop?.aborted === true
    if (stopped()) return 0
    const lockPath = join(workdir, ROUND_LOCK)
    const take = (): FlockHandle | null =>
      tryAcquireFlock(lockPath, { body: `${JSON.stringify({ ...lockHolder, since: new Date().toISOString() })}\n` })
    let lock = take()
    if (lock === null) {
      const onWait =
        round.waiting?.onWait ??
        ((wait: RoundLockWait) => {
          io.stderr(
            `yrd: waiting for the round lock in ${workdir}: ${lockHolderLine(wait)}; this round runs when that one ends\n`,
          )
        })
      const onStall =
        round.waiting?.onStall ??
        ((wait: RoundLockWait & Readonly<{ waitedMs: number }>) => {
          io.stderr(
            `yrd: still waiting after ${mediaDuration(wait.waitedMs)} for the round lock in ${workdir}: ` +
              `${lockHolderLine(wait)}. A round that runs this long is still judging or is wedged, and its own ` +
              "output says which; nothing takes the lock over, so this waits until that process releases it or exits\n",
          )
        })
      const stallMs = round.stallMs ?? ROUND_BUDGET_MS
      const waitingSince = new Date()
      let named: string | undefined
      let stalled = false
      try {
        while (lock === null) {
          const holder = lockHolderOf(lockBody(lockPath))
          const wait: RoundLockWait = { holder, waitingSince }
          // Said once for each holder a waiter reads, not once per look.
          const reading = holder === undefined ? "unnamed" : `${String(holder.pid)} ${holder.since}`
          if (reading !== named) {
            named = reading
            onWait(wait)
          }
          const waitedMs = Date.now() - waitingSince.getTime()
          if (!stalled && waitedMs >= stallMs) {
            stalled = true
            onStall({ ...wait, waitedMs })
          }
          await delay(ROUND_LOCK_POLL_MS, undefined, { signal: round.stop })
          lock = take()
        }
      } catch (error) {
        if (stopped()) return 0
        throw error
      }
    }
    try {
      let declared: CapturedDeclaration | undefined
      try {
        declared = await declaration()
      } catch (error) {
        return stuck(
          `the target's declaration cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (declared === undefined) return stuck(`${targetLabel} no longer carries a .yrd.yml`)
      const before = await round.before?.(declared)
      if (before !== undefined) return before
      const outcome = await oneRound(declared, round.only, round.tier, round.stopAtMs)
      return outcome === undefined ? 2 : { declared, outcome }
    } finally {
      lock.release()
    }
  }

  /** Where one change stands now, and the stop that same reading derives. */
  const readChangeNow = async (change: Change) => {
    const target = await readRemoteCommit(git, config.target.remote, `refs/heads/${config.target.branch}`)
    if (target === undefined) throw new Error(`the target ${targetLabel} is not at ${config.target.remote}`)
    const now = await readQueue(git, config.target.remote, config.target.branch, target)
    const entry = now.changes.find(
      (candidate) => candidate.change.branch === change.branch && candidate.change.head === change.head,
    )
    if (entry === undefined) {
      throw new Error(`${changeName(change)} is not at ${targetLabel} after its round: its change ref is gone`)
    }
    return { entry, stop: now.stop }
  }

  /**
   * Why a round that worked one change left it in line, from that round's own
   * journal: the lease that moved when the merge was pushed, naming which one,
   * or that the round never reached it.
   */
  const notMerged = (outcome: QueueRunOutcome, change: Change): string => {
    const decided = readRunLog(join(workdir, "logs"), outcome.run).findLast(
      (record) =>
        record.kind === "change" &&
        record.branch === change.branch &&
        record.head === change.head &&
        typeof record.reason === "string",
    )
    const saw = typeof decided?.saw === "string" && decided.saw !== "gone" ? ` to ${decided.saw.slice(0, 12)}` : ""
    switch (decided?.reason) {
      case "target-moved":
        return `the target ${targetLabel} moved${saw} after this round read it at ${outcome.base.slice(0, 12)}, so the merge was not pushed`
      case "branch-moved":
        return `the branch ${change.branch} moved off ${change.head.slice(0, 12)} after this round read it, so the merge was not pushed`
      case "change-ref-moved":
        return "the change's own record ref moved after this round read it, so the merge was not pushed"
      case "pause-moved":
        return "the queue's pause record moved after this round read it, so the merge was not pushed"
      case undefined:
        return outcome.stopped === undefined
          ? "this round did not reach it"
          : `this round stopped before it: ${outcome.stopped.says}`
      default:
        return `this round left it there (${String(decided?.reason)})`
    }
  }

  switch (request.command) {
    case "drop": {
      const eventStore = { repo, remote: config.target.remote }
      const dropped = await drop(eventStore, {
        queue: config.target.branch,
        branch: request.branch,
        by: request.by,
        ...(request.reason === undefined ? {} : { note: request.reason }),
      })
      emit(
        io,
        options.json,
        dropped,
        `dropped ${request.branch} at ${dropped.head.slice(0, 12)}; ending ${dropped.event.slice(0, 12)} kept its commit`,
      )
      return 0
    }
    case "pause":
    case "resume": {
      try {
        const eventStore = { repo, remote: config.target.remote }
        if ((await queueFormat(eventStore, config.target.branch)) === "event") {
          const now = await readEventQueue(eventStore, config.target.branch)
          const standing = eventPause(now)
          if (request.command === "pause" && standing !== undefined) {
            throw new QueuePaused(standing, config.target.remote, config.target.branch)
          }
          if (request.command === "resume" && standing === undefined) throw new QueueNotPaused()
          const at = new Date()
          const reason = request.command === "pause" ? request.reason : (request.reason ?? "pause lifted")
          const id = await writeQueueEvent(eventStore, config.target.branch, {
            type: request.command === "pause" ? "paused" : "resumed",
            reason,
            by: request.by,
            at,
          })
          const written: PauseRecord = {
            kind: request.command === "pause" ? "paused" : "resumed",
            sha: id,
            at,
            reason,
            by: request.by,
            cause: "operator",
          }
          emit(io, options.json, written, pauseLine(written))
          return 0
        }
        // Whether a stop STANDS is the one derivation's answer, never the tip's
        // kind alone: a stuck stop whose change has left the line is over, so a
        // pause may follow it and there is nothing for a resume to end.
        const { pause: tip, stop } = await readStop(git, config.target.remote, config.target.branch, captured.oid)
        const lifted = tip?.kind === "paused" && stop === undefined ? tip : undefined
        const pause = await writePause(
          git,
          config.target.remote,
          config.target.branch,
          {
            by: request.by,
            kind: request.command === "pause" ? "paused" : "resumed",
            reason: request.command === "pause" ? request.reason : (request.reason ?? "pause lifted"),
          },
          lifted,
        )
        emit(io, options.json, pause, pauseLine(pause))
        return 0
      } catch (error) {
        if (error instanceof QueuePaused || error instanceof QueueNotPaused) {
          io.stderr(`yrd: ${error.message}\n`)
          return 1
        }
        throw error
      }
    }
    case "withdraw": {
      if ((await queueFormat({ repo, remote: config.target.remote }, config.target.branch)) === "event") {
        io.stderr(
          `yrd: ${config.target.remote}#${config.target.branch} is an event queue; use yrd drop ${request.branch}\n`,
        )
        return 1
      }
      try {
        const taken = await withdraw(git, config.target.remote, {
          branch: request.branch,
          by: request.by,
          target: config.target,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        })
        emit(
          io,
          options.json,
          taken,
          taken.withdrawn
            .map(
              (one) =>
                `withdrew ${changeName({ branch: one.branch, head: one.head })} from ${taken.queue}` +
                ` (record ${one.record.slice(0, 12)}); yrd submit re-opens it`,
            )
            .join("\n"),
        )
        return 0
      } catch (error) {
        if (error instanceof NothingToWithdraw) {
          io.stderr(`yrd: ${error.message}\n`)
          return 1
        }
        throw error
      }
    }
    case "submit": {
      if ((await queueFormat({ repo, remote: config.target.remote }, config.target.branch)) === "event") {
        assertPlainEventQueueConfig(config, "submit")
      }
      const branch = request.branch ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()
      const submission = {
        branch,
        submitter: request.submitter,
        target: config.target,
        ...(request.issue === undefined ? {} : { issue: request.issue }),
      }
      // A stopped line ACCEPTS the submit (the andon, operator 2026-09-16): the
      // stop is echoed — who, why, and what lifts it — and never refused on.
      if (request.dryRun === true) {
        const inspected = await inspectSubmit(git, config.target.remote, submission)
        const { head, targetHead, verifying } = inspected
        const issue = inspected.issue
        emit(
          io,
          options.json,
          {
            change: changeName({ branch, head }),
            dryRun: true,
            verifying,
            submitter: request.submitter,
            target: targetName(config.target),
            targetHead,
            freshness: freshnessLine(targetHead),
            stopped: stopFact(inspected.stop),
            ...issueOutput(io, branch, issue),
          },
          `would open ${changeName({ branch, head })} on ${targetName(config.target)} for ${request.submitter}` +
            `${issue === undefined ? "" : ` (issue ${issue.issue})`}; nothing was pushed; ${freshnessLine(targetHead)}`,
        )
        echoStop(inspected.stop)
        return 0
      }
      const submitted = await submit(git, config.target.remote, submission)
      const { stop: acceptedUnder, ...accepted } = submitted
      emit(
        io,
        options.json,
        { ...accepted, stopped: stopFact(acceptedUnder), ...issueOutput(io, branch, submitted.issue) },
        `${submitted.retry ? "retried" : "submitted"} ${branch} at ${submitted.head.slice(0, 12)} to ${targetName(config.target)}; ${freshnessLine(submitted.targetHead)}` +
          // 24454: a moved gitlink's commit went to its submodule remote first; say where.
          submitted.published
            .map((row) => `\n${row.state} ${row.path}@${row.sha.slice(0, 12)} at ${row.remote} ${row.ref}`)
            .join(""),
      )
      echoStop(acceptedUnder)
      return 0
    }
    case "run": {
      if (request.tier === "long") {
        let worstExitCode: YrdCliExitCode = 0
        while (request.stopAtMs === undefined || Date.now() < request.stopAtMs) {
          const ran = await lockedRound({ tier: request.tier, stopAtMs: request.stopAtMs })
          if (typeof ran === "number") return ran
          const exitCode = ran.outcome.exitCode
          if (exitCode > worstExitCode) worstExitCode = exitCode
          if (exitCode === 2) return 2
          if (ran.outcome.merged.length === 0 && ran.outcome.failed.length === 0) break
        }
        if (request.stopAtMs !== undefined && Date.now() >= request.stopAtMs) {
          io.stderr("yrd: stop time reached; leaving remaining changes deferred\n")
        }
        return worstExitCode
      }
      // One round, exactly `up`'s own (0 pass, 1 fail, 2 stuck): `outcome.exitCode`
      // already carries that ladder, so forwarding it verbatim is the whole of
      // the contract — a round a stuck change stopped, doing no other work,
      // ends 2 here (run.ts's on-submit and on-merge steps set `exitCode: 2`
      // the moment anything comes back stuck, never 0). A run that could not
      // even judge answers 2 from the locked round, that same stuck, already
      // said by `stuck()` above (@i/10-yrd/24141 AC1).
      const ran = await lockedRound()
      return typeof ran === "number" ? ran : ran.outcome.exitCode
    }
    case "merge": {
      // `yrd merge <branch>`: the branch's change merged NOW, ahead of the line
      // and on a stopped line too, in a foreground round that judges and merges
      // that change and no other (ADR-0015 decision 5).
      //
      // Merge is submit, idempotent. A change already open is merged on its
      // standing, so a checked verdict is kept rather than dropped by a
      // same-head retry. A merged change is an answer: exit 0, nothing written
      // and no round run. Anything else is submitted first, from the author's
      // checkout, exactly as `yrd submit` would.
      const { branch } = request
      const author =
        request.author === undefined
          ? undefined
          : gitIn(request.author.repo, undefined, request.author.selection, { env: options.env })
      const local = author === undefined ? undefined : await refAt(author, `refs/heads/${branch}`)
      const read = await readQueue(git, config.target.remote, config.target.branch, captured.oid)
      const own = read.changes.filter((entry) => entry.change.branch === branch)
      // A local branch names its head's change; with none, the change of this
      // branch that holds a place in line is the one.
      const standing =
        local === undefined
          ? own.find((entry) => inLineState(entry.reading.state))
          : own.find((entry) => entry.change.head === local)
      if (standing?.reading.state === "merged") {
        emit(
          io,
          options.json,
          { branch, change: changeName(standing.change), exitCode: 0, state: "merged" },
          `${changeName(standing.change)} is already merged into ${targetName(config.target)}; nothing to merge`,
        )
        return 0
      }
      let change: Change
      if (standing !== undefined && inLineState(standing.reading.state)) {
        change = { branch, head: standing.change.head }
      } else {
        if (author === undefined || request.author === undefined) {
          io.stderr(
            `yrd: merge needs ${branch} submitted, and no change of it is in line on ${targetName(config.target)}; ` +
              `submitting needs a clone that has ${branch}: run yrd merge ${branch} inside one\n`,
          )
          return 2
        }
        const remote = request.author.remote ?? "origin"
        const submitted = await submit(author, remote, {
          branch,
          submitter: request.submitter,
          target: { branch: config.target.branch, remote },
          ...(request.issue === undefined ? {} : { issue: request.issue }),
        })
        // The stop the submit was accepted under is not echoed here: this
        // command does not wait for it to lift, and the stop that still stands
        // once its rounds are done is said below.
        const { stop: _acceptedUnder, ...accepted } = submitted
        emit(
          io,
          options.json,
          { ...accepted, ...issueOutput(io, branch, submitted.issue) },
          `${submitted.retry ? "retried" : "submitted"} ${branch} at ${submitted.head.slice(0, 12)} to ${targetName(config.target)}; ${freshnessLine(submitted.targetHead)}`,
        )
        change = { branch, head: submitted.head }
      }

      const merging = await lockedRound({ only: change })
      if (typeof merging === "number") return merging
      let after = await readChangeNow(change)
      // A stopped line waits on a stuck change, and a change merged past it may
      // be the repair it waited for: its head is judged once more, in a round
      // of its own under a fresh declaration. Its verdict is its own; this
      // command's exit stays the named change's.
      const waitsOn = after.stop?.cause === "stuck" ? after.stop.change : undefined
      if (after.entry.reading.state === "merged" && waitsOn !== undefined && waitsOn.branch !== branch) {
        await lockedRound({ only: waitsOn })
        after = await readChangeNow(change)
      }

      // A stop that still stands is said, with the command that merges what it
      // waits on: the named change's exit never hides a stopped line.
      if (after.stop !== undefined) {
        const stuckOn = after.stop.cause === "stuck" ? after.stop.change : undefined
        io.stderr(
          `yrd: the line is still stopped — ${pauseLine(after.stop)}; ` +
            (stuckOn === undefined ? "" : `once it is repaired, merge it with yrd merge ${stuckOn.branch}; `) +
            `${liftLine(after.stop, config.target.remote, config.target.branch)}\n`,
        )
      }
      const state = after.entry.reading.state
      const ending = endingCode([state])
      emit(
        io,
        options.json,
        { branch, change: changeName(change), exitCode: ending ?? 2, state, stopped: stopFact(after.stop) },
        `${changeName(change)} ${state}`,
      )
      if (ending !== undefined) return ending
      // Still in line: checked and not merged, or never reached. Exit 2 and no
      // retry, naming why and the command that tries again.
      io.stderr(
        `yrd: ${changeName(change)} is still in line, ${state}: ${notMerged(merging.outcome, change)}; ` +
          `it keeps its place and the queue merges it in turn, or run yrd merge ${branch} again\n`,
      )
      return 2
    }
    case "up": {
      // The service: the same round on a loop, what hab runs. A STUCK CHANGE
      // STOPS THE LINE and the service stays up holding it (the andon, operator
      // 2026-09-16): the round that stuck pauses the queue naming the change,
      // every later round stops at that pause and judges nothing, and the
      // health document pages until an act lifts it — the change withdrawn or
      // merged, or `yrd queue resume`. No timer resumes it. Its ONE permanent
      // exit, 2, is for what no round can hold the line on: the target's
      // declaration can no longer be read or is no longer there at all, the
      // runtime gitlink is absent, or a round could not even read its queue and
      // so has no change to stop on. Everything else it does on purpose — an
      // explicit AbortSignal stop request or a gitlink moving under it — exits 0,
      // which is on Hab's relaunch allowlist. A process signal bypasses this
      // return path and stays terminal under the service's `restart: "on-codes"`
      // declaration.
      const interval = (request.intervalSeconds ?? 15) * 1000
      // Read through a call each time: the signal flips while the loop runs.
      const stopped = (): boolean => request.stop?.aborted === true
      /** This process, as the supervisor identifies the writer of the document (24523 D2). */
      const writer: HealthWriter = {
        command: process.argv.join(" "),
        pid: process.pid,
        // The runtime's own start, so nothing here reads /proc: the supervisor
        // owns that reader and checks this against it.
        startedAt: new Date(performance.timeOrigin).toISOString(),
      }
      const heartbeat = {
        graceMs: request.heartbeatGraceMs ?? HEARTBEAT_GRACE_MS,
        intervalMs: request.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      }
      /** The last document written, which every heartbeat restates unchanged but for its clocks. */
      let stated: QueueHealthDocument | undefined
      /**
       * Leave the document where the declared health probe reads it, stamped
       * with this write's instant, its deadline and its writer, and answer with
       * the document as written.
       *
       * Best-effort ON PURPOSE, and this is the one place in this change where
       * that is the right call: a filesystem that cannot take the document must
       * not end the delivery service, which is the exact failure mode being
       * removed. It is not silent — the failure is logged and named — and the
       * probe keeps reading the last document written until that document's own
       * deadline, then reads it overdue, so a document that stopped being
       * written is visible as itself.
       */
      const writeHealth = (document: QueueHealthDocument): QueueHealthDocument => {
        const written = writtenHealthDocument(document, writer, heartbeat, new Date())
        stated = written
        try {
          // ATOMIC, and the reason is a page nobody should ever have got:
          // `writeFileSync` truncates before it writes, so a probe landing in
          // that window reads an EMPTY file, which parses as unreadable, which
          // becomes `unknown`, which habd pages as health-not-measured. The
          // probe runs on the supervisor's own tick, so the window is hit by
          // chance and the page names a defect that does not exist. Same
          // directory, so the rename is a rename and not a copy (@cto
          // 2026-09-11).
          const path = join(workdir, QUEUE_HEALTH_DOCUMENT)
          const staging = `${path}.${String(process.pid)}.tmp`
          writeFileSync(staging, `${JSON.stringify(written, undefined, 2)}\n`)
          renameSync(staging, path)
        } catch (error) {
          log?.warn?.(
            `could not write the service health document to ${join(workdir, QUEUE_HEALTH_DOCUMENT)}: ${
              error instanceof Error ? error.message : String(error)
            }; the declared health probe reads the last document written until its deadline, then reads it overdue`,
          )
        }
        return written
      }
      // THE RELAUNCH EXIT, and whether it is armed (@i/10-yrd/24515). An
      // injected gitlink is a test's, and arms it by construction; otherwise
      // the runtime asks what path IT occupies in ITS OWN superproject.
      const identified: RuntimeGitlink | RuntimeGitlinkOff =
        request.gitlink === undefined
          ? await gitlinkOf(git, captured.oid, log)
          : { kind: "gitlink", ...request.gitlink }
      // LOUD, because this is the defect: the old code returned undefined and
      // said so at INFO, and a capability that switches itself off where nobody
      // reads is indistinguishable from one that works. It went a month.
      if (identified.kind === "off") {
        log?.warn?.(identified.why, { relaunchExit: "off", reason: identified.reason })
        io.stderr(`yrd: ${identified.why}\n`)
      }
      const gitlink = identified.kind === "gitlink" ? identified : undefined
      /** A fact in every health document while the exit is disarmed, so a reader meets it without looking. */
      const relaunchOff = identified.kind === "off" ? { relaunchExit: identified.reason } : {}
      /**
       * THE PAGE READS THE STOP. What the loop writes for the line as `stop`
       * leaves it: at start, from the stop read then, and at every round's end,
       * from the stop that round derived (pause.ts `lineStop`) — one builder, so
       * the first document is exactly what a round end would have written.
       *
       * The disarmed exit is carried where a reader already looks. A warning is
       * read once, at the moment nobody is watching; a fact in the health
       * document is read every time anyone asks how this service is.
       */
      const lineDocument = (stop: PauseRecord | undefined, sleepMs: number): QueueHealthDocument => {
        const base = roundHealthDocument(SERVICE, stop, sleepMs, new Date())
        return identified.kind === "off" ? { ...base, facts: { ...base.facts, ...relaunchOff } } : base
      }
      /**
       * The last stop the loop knows: read at start, then derived by every round.
       * Every document states it, the relaunch wait's included, because the fact
       * is always present and its absence can never be read as a running line.
       */
      let lastStop: PauseRecord | undefined
      // A relaunch can beat the checkout updater. Do not run an old round or
      // spend the supervisor's restart budget repeatedly loading the old gitlink.
      const reload = async (targetOid: string): Promise<YrdCliExitCode | undefined> => {
        if (gitlink === undefined) return undefined
        let now = await gitlinkAt(git, targetOid, gitlink.path)
        if (now === gitlink.sha) return undefined
        let announced: string | undefined
        // THE WAIT IS BOUNDED NOW (@cto 2026-09-11, on @i/10-yrd/24515). Before
        // the relaunch exit was repaired this loop never ran in production; it
        // now runs on every vendor/yrd move, and it ended only when the shared
        // checkout caught up. If the updater stalls, or that checkout is
        // detached, drifted or ahead, an unbounded wait runs NO ROUNDS and
        // writes NO DOCUMENT — and the first sign is an overdue answer twelve
        // minutes later that says "overdue" without saying why. Trading stale
        // code for no rounds is the right trade; doing it quietly is not.
        const waitStartedAt = Date.now()
        const waitCapMs = request.relaunchWaitCapMs ?? RELAUNCH_WAIT_CAP_MS
        let alarmDueAt = waitStartedAt + waitCapMs
        let stalls = 0
        let waitingFacts: Readonly<Record<string, unknown>> = {}
        for (;;) {
          if (now === undefined) {
            return stuck(
              `runtime gitlink ${gitlink.path} is absent at captured target ${targetOid}; restore it before restarting this service`,
            )
          }
          // An explicitly supplied gitlink has no physical checkout to await.
          if (gitlink.checkout === undefined || gitlink.superproject === undefined) break
          // THE PROJECTION THIS RUNTIME ACTUALLY RELOADS FROM is its own
          // superproject's, not the queue clone's (@i/10-yrd/24515). The queue
          // clone advancing says nothing about whether the tree this process
          // will re-exec out of has the new code yet — they are different
          // working trees of the same repository, updated by different things.
          const projected = await gitlinkAt(
            gitIn(gitlink.superproject, undefined, selection, { env: options.env }),
            "HEAD",
            gitlink.path,
          )
          const checkout = (
            await gitIn(gitlink.checkout, undefined, selection, { env: options.env })([
              "rev-parse",
              "--verify",
              "HEAD^{commit}",
            ])
          ).trim()
          if (projected === now && checkout === now) break
          const state = `${now}:${projected}:${checkout}`
          if (state !== announced) {
            const waiting = `waiting for checkout ${gitlink.path}: loaded ${gitlink.sha.slice(0, 12)}, target ${now.slice(0, 12)}, local gitlink ${projected?.slice(0, 12) ?? "absent"}, checkout ${checkout.slice(0, 12)}; no queue round will run until the checkout updater materializes the target`
            // WARN, not info: while this is announced the delivery service is
            // doing nothing, and an INFO line is where the last capability that
            // switched itself off hid for a month.
            log?.warn?.(waiting, { checkout: gitlink.checkout, gitlink: gitlink.path, projected, target: now })
            // THE FACT THE OVERDUE PAGE WILL CARRY. `believableHealthDocument`
            // preserves `facts` when it turns a stale document unhealthy, so
            // writing this at the start of the wait is what makes the eventual
            // overdue answer explain itself instead of saying only "overdue".
            // Held, not just written: the STALL page below re-uses this
            // observation, refreshed to the latest ANNOUNCED one. Refreshing is
            // the point rather than a compromise — production proved it on the
            // first live relaunch (2026-09-11 16:24Z), where the superproject's
            // recorded gitlink advanced a full second before its working tree,
            // so the two announcements differ and only the later one describes
            // the state a reader would find. The overdue answer merges whatever
            // `facts` it finds, so a stale pair here would explain the wrong
            // instant.
            waitingFacts = {
              ...relaunchOff,
              waitingForCheckout: gitlink.path,
              waitingTarget: now,
              waitingLocalGitlink: projected ?? "absent",
              waitingCheckout: gitlink.checkout,
              waitingCheckoutHead: checkout,
            }
            const alive = roundHealthDocument(SERVICE, lastStop, waitCapMs, new Date())
            writeHealth({ ...alive, facts: { ...alive.facts, ...waitingFacts } })
            emit(
              io,
              options.json,
              {
                reason: "waiting-for-checkout",
                gitlink: gitlink.path,
                from: gitlink.sha,
                to: now,
                projected,
                checkout,
                message: waiting,
              },
              waiting,
            )
            announced = state
          }
          if (stopped()) return 0
          // THE CAP IS AN ALARM, NOT AN ENDING (@cto, reviewing the first cut of
          // this). Ending here was wrong twice over, and the second way is the
          // one worth remembering:
          //
          // - `stuck()` returns 2, and `relaunchExitCodes` is [0, 1], so exit 2
          //   is TERMINAL. The service would stay down — while the text it wrote
          //   promised "the service relaunches on its own".
          // - Worse, `roundHealthDocument` always writes verdict `running`. So it
          //   would leave behind unhealthy+running and exit; after a terminal
          //   exit the only cure is `hab up`, and hab's pre-spawn gate refuses
          //   exactly unhealthy+running. That is the deadlock measured at 15:31Z
          //   on 2026-09-11, which was broken only by deleting the document by
          //   hand. A cap whose ending refuses its own named cure is worse than
          //   no cap.
          //
          // Staying alive makes the promise true instead: hab pages on
          // unhealthy-while-running WITHOUT restarting, the process keeps
          // waiting and runs no stale round, and when the checkout lands the
          // exit-0 path below relaunches it. habd respawns that directly and
          // never runs the admission probe, so the gate above is never met.
          if (Date.now() >= alarmDueAt) {
            const why =
              `waited ${String(Math.round((Date.now() - waitStartedAt) / 1000))}s for ${gitlink.checkout} to check ` +
              `out ${gitlink.path}@${now.slice(0, 12)} and it has not: its own gitlink reads ` +
              `${projected?.slice(0, 12) ?? "absent"} and its working tree reads ${checkout.slice(0, 12)}. ` +
              `No queue round is running and none will until it lands. Once ${gitlink.path}@${now.slice(0, 12)} ` +
              `is checked out there, the service relaunches on its own — no restart, and nothing to delete.`
            log?.warn?.(why, { checkout: gitlink.checkout, gitlink: gitlink.path, projected, target: now })
            // `running` is TRUE here and that is the whole point: this process is
            // alive and still waiting, which is what makes the page a page rather
            // than a tombstone.
            stalls += 1
            // ITS OWN DOCUMENT, not `roundHealthDocument`'s stuck branch. That
            // branch's prose is about ROUNDS — read the round's record, the next
            // round runs in N ms, the loop will run it by itself — and all three
            // are false while waiting on a checkout. A page whose resolution
            // lines contradict its own cause is what operators followed on the
            // evening of 2026-09-11 (@cto).
            writeHealth(
              relaunchStalledHealthDocument(
                SERVICE,
                { checkout: gitlink.checkout, path: gitlink.path, sha: now },
                why,
                { ...waitingFacts, waitingLocalGitlink: projected ?? "absent", waitingCheckoutHead: checkout },
                stalls,
                waitCapMs,
                new Date(),
                lastStop,
              ),
            )
            emit(
              io,
              options.json,
              {
                checkout,
                from: gitlink.sha,
                gitlink: gitlink.path,
                message: why,
                projected,
                reason: "relaunch-wait-stalled",
                to: now,
              },
              why,
            )
            // Re-armed rather than one-shot, so a long stall stays a FRESH
            // measurement instead of ageing into a generic overdue answer.
            alarmDueAt = Date.now() + waitCapMs
          }
          try {
            await delay(1000, undefined, { signal: request.stop })
          } catch (error) {
            if (stopped()) return 0
            throw error
          }
          const latest = await declaration()
          if (latest === undefined) return stuck(`${targetLabel} no longer carries a .yrd.yml`)
          targetOid = latest.oid
          now = await gitlinkAt(git, targetOid, gitlink.path)
        }
        const moved = `gitlink moved from ${gitlink.sha.slice(0, 12)} to ${now.slice(0, 12)}: exiting for relaunch`
        log?.info?.(moved, { from: gitlink.sha, gitlink: gitlink.path, to: now })
        emit(
          io,
          options.json,
          { exitCode: 0, from: gitlink.sha, gitlink: gitlink.path, reason: "gitlink-moved", to: now },
          moved,
        )
        return 0
      }
      // THE LINE AS IT STANDS AT START, read the way a round reads it (remote.ts
      // `readStop`, the round's own derivation) and written before round 1 opens
      // (24523 F1). A supervisor waiting for this process's own document reads
      // it now instead of waiting out a long first round against its
      // predecessor's, and a stuck stop that stands writes the stuck page, so a
      // relaunch continues the page rather than clearing it and opening it again.
      // A stop that cannot be read is what a round that cannot read its queue
      // already is: stuck, exit 2, and no document claiming a state nobody read.
      try {
        lastStop = (await readStop(git, config.target.remote, config.target.branch, captured.oid)).stop
      } catch (error) {
        return stuck(
          `the line's stop cannot be read at start: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      writeHealth(lineDocument(lastStop, 0))
      // THE HEARTBEAT (24523 D6): one timer for the whole loop, restating the last
      // document on a fixed interval through open rounds, idle sleeps, a stopped
      // line and the relaunch wait alike. Rounds are awaited child processes, so
      // the event loop is free to write, and the document is fresh exactly while
      // its writer lives. The `finally` clears it on every way out of the loop.
      const beat = setInterval(() => {
        if (stated !== undefined) writeHealth(stated)
      }, heartbeat.intervalMs)
      /**
       * A round the service waits for — a `yrd merge` or `yrd queue run` in the
       * same workdir — is stated where the service is read: the holder as a
       * fact on the document when the wait begins, cleared by the round this
       * service then runs. The document stays HEALTHY however long the wait
       * lasts. A long round is not a fault, whoever runs it (24523 F4: round
       * length is not a deadline), so past the budget the wait is logged and
       * pages nobody.
       */
      let lockWaitStated = false
      const waiting = {
        onWait: (wait: RoundLockWait): void => {
          lockWaitStated = true
          log?.info?.(`waiting for the round lock in ${workdir}: ${lockHolderLine(wait)}`)
          const alive = lineDocument(lastStop, 0)
          writeHealth({ ...alive, facts: { ...alive.facts, waitingForRoundLock: lockWaitFact(wait) } })
        },
        onStall: (wait: RoundLockWait & Readonly<{ waitedMs: number }>): void => {
          log?.warn?.(
            `waited ${mediaDuration(wait.waitedMs)} for the round lock in ${workdir}: ${lockHolderLine(wait)}`,
          )
        },
      }
      try {
        for (;;) {
          // The declaration again under the lock, as the target holds it now: a
          // correct edit at the target is the next round's, never a restart's.
          const ran = await lockedRound({
            before: async (declared) => {
              if (lockWaitStated) {
                lockWaitStated = false
                writeHealth(lineDocument(lastStop, 0))
              }
              return reload(declared.oid)
            },
            stallMs: request.roundLockStallMs,
            stop: request.stop,
            waiting,
          })
          if (typeof ran === "number") return ran
          const { outcome } = ran

          // The round derived whether the line is stopped and said so on its
          // outcome; the document states that and nothing more. A stuck stop is
          // unhealthy for every round that holds it and clears on the first round
          // after an act lifts it. The hook sees the document as written, with
          // nothing awaited between the write and the call.
          const sleepMs = sleepAfter(outcome, interval)
          lastStop = pauseStop(outcome.stopped)
          const document = writeHealth(lineDocument(lastStop, sleepMs))
          await request.afterHealth?.(document)
          if (stopped()) return 0

          await request.afterRound?.(outcome)
          // The gitlink, at the target as this round left it: the round that merged
          // the change moving this yrd's own gitlink is the last one this code runs.
          const after = await reload(outcome.target)
          if (after !== undefined) return after
          if (stopped()) return 0
          await new Promise((resolve) => {
            setTimeout(resolve, sleepMs)
          })
          if (stopped()) return 0
        }
      } finally {
        clearInterval(beat)
      }
    }
    case "list": {
      /**
       * Journal defects already narrated by this invocation. One-shot, plain
       * watch and interactive pane all refresh through `round` below, so this
       * is the one place a defect is stated, and stated once.
       */
      const said = new Set<string>()
      /**
       * One reading of the queue, rendered. Everything the list and the watch
       * show comes from here, so a refresh cannot show a different table from
       * the one a plain `queue list` would print at the same instant.
       *
       * The commits that went around the queue are rows too (E5), judged at
       * the same captured declaration as the queue reading, so the rows and
       * the reading share one tip and no second reading can disagree with it.
       */
      const round = async (
        declared: CapturedDeclaration,
        draftWindow: DraftWindow = "7d",
      ): Promise<
        Readonly<{
          rows: readonly WatchRow[]
          /** Every row of the reading in the same lens, whatever the selector narrowed `rows` to. */
          unfiltered: readonly WatchRow[]
          /** The rows that are changes: every row but the drafts, which the document, the selector and the ending never count. */
          changes: readonly WatchRow[]
          observation: GitObservation
          data: unknown
          queue: string
          queues: readonly WatchQueue[]
          pause?: string
          journalAbsent?: string
          /** What was queried and what was left out, when a filter narrowed the rows. */
          scope?: string
          /** The newest run journal and its process, for the RUNNER box. */
          runner: RunnerFacts
          /** Every decision the rows carry, one per run per change and unfiltered, for the STATS box. */
          decisions: readonly RunDecision[]
          /** The queue read the rows came from, so a detail opened later reads the same tip. */
          entries: QueueEntries | undefined
          eventChanges: ReadonlyMap<string, EventChange> | undefined
          journals: Journals
          /** The stop that stands, as the reading derived it. */
          stopped: StopFact | null
          /** Which drafts the rows list, and the heads of the drafts this repository has not read. */
          drafts?: Readonly<{ window: DraftWindow; unread: readonly string[] }>
        }>
      > => {
        // Legacy JSON retains its historical change-only document. An event
        // queue has one status vocabulary beginning at `draft`, so its JSON
        // and table both project the same one row per branch.
        const format = await queueFormat({ repo, remote: config.target.remote }, config.target.branch)
        const reading =
          format === "event"
            ? await readEventListing(git, declared.config, repo, workdir, declared.oid)
            : {
                format: "legacy" as const,
                ...(await readListing(
                  git,
                  declared.config,
                  workdir,
                  declared.oid,
                  options.json === true ? {} : { shown: { draftWindow } },
                )),
              }
        const { journals, all, drafts, observation } = reading
        if (options.json !== true) narrateMalformed(io, journals, said)
        // TWO LENSES OVER ONE READING, and which is which is the whole of S1.
        //
        // `unfiltered` is one row per RUN: what the queue DID. The document
        // keeps it, because the spec keeps runs in `--json` and a machine
        // reader that has always had a row per judgement must not silently get
        // one per change; the queue line and STATS count from it too, and both
        // already fold a change's runs into one themselves.
        //
        // `rows` is the TABLE's, one row per change: where each change STANDS.
        // The operator read their own queue on 2026-09-17 and saw one branch
        // on two rows, which is what the old default did wherever a run
        // journal could be read.
        const unfiltered = watchRows(all, { journals, perRun: true })
        const changes = filterRows(unfiltered, request.terms ?? []).filter((item) => item.row.state !== "draft")
        const rows = filterRows(watchRows(all, { journals }), request.terms ?? [])
        const documentRows = reading.format === "event" ? rows : changes
        // The stop the reading DERIVED, never the tip's kind: a stuck stop whose
        // change has left the line is over, and a reader must not see it.
        const pause = reading.format === "event" ? reading.pause : reading.queue.stop
        // What was queried, where it looked, and what it left out — said on the
        // screen, not left for the reader to infer from an empty table. Zero
        // rows also names the fields the term was checked against, so a state
        // name that found nothing is told it WAS considered, not skipped —
        // the same message on `--json` as on the page (AC1,
        // a-state-name-filters-to-zero-rows-and-exit-zero).
        const filteredScope =
          request.terms === undefined || request.terms.length === 0
            ? undefined
            : `${String(documentRows.length)} of ${String(reading.format === "event" ? all.length : all.filter((row) => row.state !== "draft").length)} ${reading.format === "event" ? "branch(es)" : "change(s)"} match ${request.terms.join(" or ")}` +
              (documentRows.length === 0 ? `. Checked ${FILTER_FIELDS}.` : "")
        const scope =
          reading.format === "event"
            ? `Read event change chains in ${queueRefPrefix(config.target.branch)}/changes/, branch heads at ${config.target.remote}, and direct target commits after the queue declaration.${filteredScope === undefined ? "" : ` ${filteredScope}`}`
            : filteredScope
        return {
          observation,
          data: {
            observation,
            changes: documentRows.map((row) => row.row),
            journal: journalFact(journals),
            pause: pause ?? null,
            // The everyday reader of a stopped line: always present, null while
            // the line runs, so a stop can never be read as absent.
            stopped: stopFact(pause),
            ...(scope === undefined ? {} : { scope }),
          },
          entries: reading.format === "event" ? undefined : reading.queue.changes,
          eventChanges: reading.format === "event" ? reading.changes : undefined,
          journals,
          queue: queueName(config.target, await remoteUrl(git, config.target.remote)),
          // Pre-M8 a repository has exactly one queue: the target's branch, on
          // this repository. M8 turns this list of one into N.
          queues: [{ branch: config.target.branch, label: config.target.branch, path: repo }],
          runner: await readRunnerFacts(workdir),
          // Every row, per run, whatever the filter: the box counts the queue,
          // not the view, and a change checked twice made two decisions.
          decisions: decisionsOfRows(unfiltered),
          ...(pause === undefined ? {} : { pause: pauseLine(pause) }),
          ...(journals.absent === undefined ? {} : { journalAbsent: journals.absent }),
          ...(scope === undefined ? {} : { scope }),
          rows,
          unfiltered,
          changes,
          stopped: stopFact(pause),
          ...(drafts === undefined
            ? {}
            : { drafts: { unread: drafts.undated.map((draft) => draft.head), window: draftWindow } }),
        }
      }
      /**
       * The first sight of the draft heads this repository has not read:
       * fetched ONCE, here in the watch's loader and never in a redraw, so the
       * next round can say who pushed them and when. A head is tried once
       * whether the fetch works or not, so one that cannot be fetched stays
       * "not yet read" rather than failing every round.
       *
       * The heads go in one fetch. One head the remote will not serve (a
       * branch deleted since the round read it) fails that whole fetch, so a
       * failed batch is split in two and each half fetched apart, down to one
       * head: that head alone stays unread, at about two fetches per halving.
       * Two halves that both fail may be the remote's failure rather than a
       * head's, so the remote is asked whether it answers at all before either
       * is split again: a remote that went away costs three fetches and one
       * question, however many heads there are. What stays unread is thrown as
       * ONE error, for the caller to say once. `yrd list` and `yrd queue stats`
       * fetch nothing.
       */
      const sighted = new Set<string>()
      const sightDrafts = async (one: Readonly<{ drafts?: Readonly<{ unread: readonly string[] }> }>) => {
        const fresh = (one.drafts?.unread ?? []).filter((head) => !sighted.has(head))
        if (fresh.length === 0) return
        for (const head of fresh) sighted.add(head)
        let why: unknown
        const worked = async (argv: readonly string[]): Promise<boolean> => {
          try {
            await git(argv)
            return true
          } catch (error) {
            why = error
            return false
          }
        }
        const fetched = (heads: readonly string[]): Promise<boolean> =>
          worked([
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
            "--refmap=",
            config.target.remote,
            ...heads,
          ])
        const answers = (): Promise<boolean> =>
          worked(["ls-remote", "--refs", config.target.remote, `refs/heads/${config.target.branch}`])
        /** The heads of a batch that failed which the remote will not serve, each half tried on its own. */
        const refused = async (heads: readonly string[]): Promise<readonly string[]> => {
          if (heads.length === 1) return heads
          const middle = Math.ceil(heads.length / 2)
          const failed: (readonly string[])[] = []
          for (const half of [heads.slice(0, middle), heads.slice(middle)]) {
            if (!(await fetched(half))) failed.push(half)
          }
          if (failed.length === 2 && !(await answers())) return heads
          const unread: string[] = []
          for (const half of failed) unread.push(...(await refused(half)))
          return unread
        }
        if (await fetched(fresh)) return
        const unread = await refused(fresh)
        if (unread.length === 0) return
        const named = unread.slice(0, 3).map((head) => head.slice(0, 12))
        throw new Error(
          `${String(unread.length)} draft head(s) could not be fetched and stay not yet read ` +
            `(${named.join(", ")}${unread.length > named.length ? ", …" : ""}): ${firstLine(why)}`,
          { cause: why },
        )
      }
      /**
       * The page a human reads, drawn by the watch's own components once
       * (watch-print.tsx): the pause first, the queue's name, the pills, the
       * table in the state colours, the RUNNER box. Reached through a dynamic
       * import so that `--json` and every command that prints no table never
       * load React or silvery's renderer (the cold-graph test pins it).
       */
      const page = async (one: Awaited<ReturnType<typeof round>>): Promise<string> => {
        const { printListing } = await import("./watch-print.tsx")
        const single = one.rows.length === 1 ? one.rows[0] : undefined
        const snapshot = snapshotOf(one)
        const listing = await printListing(snapshot, {
          color: io.color === true,
          columns: io.columns ?? 120,
          ...(one.scope === undefined ? {} : { scope: one.scope }),
          ...(single === undefined
            ? {}
            : {
                // Timed at the reading's own instant, as the row's cell is, so the two say one number.
                trailer: [noticeLine(single.row, single.run !== undefined), timingLine(single.row, snapshot.at)].filter(
                  (part) => part !== "",
                ),
              }),
        })
        // Append after the bounded terminal render: recorded warnings must never be clipped by its height.
        return [listing, ...one.rows.flatMap((item) => diagnosticLines(item.row, journalFor(item, one.journals)))].join(
          "\n",
        )
      }

      if (request.watch !== true) {
        const one = await round(captured)
        if (options.json === true) emit(io, true, one.data, "")
        else io.stdout(`${await page(one)}\n`)
        if (one.observation.contract === "root-v1" && one.observation.outcome === "invalid") return 2
        // Exit 0 by default even when the filter matched nothing (AC1 ruling):
        // backward compatible, and reversible with one flag rather than a
        // silent break for every existing caller. `--require-match` is that
        // flag, opting a caller into treating the same zero as failure.
        if (request.requireMatch === true && selectedNothing(request.terms, one.changes)) return 1
        return 0
      }

      // A terminal with a keyboard on the other end gets the pane. It is
      // reached through a dynamic import so that `yrd --version`, `yrd submit`
      // and every one-shot queue command never load React or the reconciler at
      // all — the same separation the retired build script named, restored
      // with it.
      if (options.interactive === true && options.json !== true) {
        const first = await round(captured)
        if (first.observation.contract === "root-v1" && first.observation.outcome === "invalid") {
          io.stderr(`${first.observation.message}\n`)
          return 2
        }
        if (selectedNothing(request.terms, first.changes)) {
          io.stderr(missedSelector(request.terms ?? [], first.queue, first.changes.length))
          return 2
        }
        const { WatchPane } = await import("./watch-pane.tsx")
        const { run } = await import("silvery/runtime")
        const { createElement } = await import("react")
        const { WATCH_RUN_OPTIONS } = await import("./watch-run-options.ts")
        let ending: YrdCliExitCode | undefined
        // The queue read the LAST round made: a detail opened between rounds
        // reads the same tips the table shows, never a fresher or staler one.
        let entries: QueueEntries | undefined = first.entries
        let eventChanges = first.eventChanges
        let journals = first.journals
        let seen: Readonly<{ drafts?: Readonly<{ unread: readonly string[] }> }> = first
        const app = await run(
          createElement(WatchPane, {
            intervalMs: Math.max(1, request.intervalSeconds ?? 5) * 1000,
            load: async (asked) => {
              const refreshed = await declaration()
              if (refreshed === undefined) throw new Error(`${targetLabel} no longer carries a .yrd.yml`)
              await sightDrafts(seen)
              const next = await round(refreshed, asked?.draftWindow)
              seen = next
              if (next.observation.contract === "root-v1" && next.observation.outcome === "invalid") {
                ending = 2
                app.unmount()
                io.stderr(`${next.observation.message}\n`)
              }
              entries = next.entries
              eventChanges = next.eventChanges
              journals = next.journals
              return snapshotOf(next)
            },
            loadDiff: (item) => readDiff(git, config, item),
            open: (item) => {
              if (entries === undefined) {
                if (item.row.state === "direct") {
                  return openDetail(git, config, [], item, config.target.branch, journalFor(item, journals))
                }
                const selected = eventChanges?.get(item.row.branch)
                if (selected === undefined) throw new Error(`event change ${item.row.branch} left the selected listing`)
                return openEventDetail(
                  git,
                  config,
                  item,
                  config.target.branch,
                  repo,
                  selected,
                  journalFor(item, journals),
                )
              }
              return openDetail(git, config, entries, item, config.target.branch, journalFor(item, journals))
            },
            onEnding:
              request.terms === undefined || request.terms.length === 0
                ? undefined
                : (code) => {
                    if (ending !== undefined) return
                    ending = code
                    app.unmount()
                  },
            snapshot: snapshotOf(first),
          }),
          WATCH_RUN_OPTIONS,
        )
        await app.waitUntilExit()
        return ending ?? 0
      }

      // The watch. A selector runs to an ending and exits with the ending's
      // code, exactly as `yrd check` does (0 pass, 1 fail, 2 stuck); with no
      // selector there is nothing to run TO, so it refreshes until it is
      // stopped and exits 0.
      const selected = request.terms !== undefined && request.terms.length > 0
      const interval = Math.max(1, request.intervalSeconds ?? 5) * 1000
      const stopped = (): boolean => request.stop?.aborted === true
      let first = true
      let declared = captured
      for (;;) {
        const one = await round(declared)
        // A selector that matches nothing would otherwise wait forever for a
        // change that is not there. It is refused loudly, with what was asked
        // for and where it was looked for.
        if (first && selectedNothing(request.terms, one.changes)) {
          io.stderr(missedSelector(request.terms ?? [], one.queue, one.changes.length))
          return 2
        }
        first = false
        // A real terminal is redrawn in place; a pipe or a test keeps every
        // round, because a watch whose output is being read later is a log —
        // and a log's rounds carry the instant they were printed: the
        // `updated HH:MM:SS` stamp of the retired watch (item 30), under the
        // queue's name, where the live pane shows the RUNNER timer instead.
        if (io.color === true) io.stdout("\u001b[H\u001b[2J")
        if (options.json === true) emit(io, true, one.data, "")
        else io.stdout(`${stampRound(await page(one), one.queue, new Date())}\n`)
        if (one.observation.contract === "root-v1" && one.observation.outcome === "invalid") return 2
        if (selected) {
          const ending = endingCode(one.changes.map((row) => row.row.state))
          if (ending !== undefined) return ending
        }
        if (stopped()) return 0
        await new Promise((resolve) => {
          setTimeout(resolve, interval)
        })
        if (stopped()) return 0
        const refreshed = await declaration()
        if (refreshed === undefined) return noQueueOnTarget(targetLabel)
        declared = refreshed
        // The drafts are not what a selector waits on: a head that cannot be
        // fetched is said, once, and never ends the watch or changes its code.
        await sightDrafts(one).catch((error: unknown) => {
          io.stderr(`yrd: ${firstLine(error)}\n`)
        })
      }
    }
    case "check": {
      // `yrd check <name>`: the named checks as the target declares them, run
      // in a FRESH WORKTREE OF HEAD exactly as a queue run does, in the
      // queue's order and stopping where the queue would stop. The exit is the
      // result: 0 pass, 1 fail, 2 stuck.
      //
      // It ran in the invoking tree until this was measured. A checkout whose
      // dependencies are symlinked from elsewhere judges that checkout rather
      // than the commit: an uncommitted `error TS2322` there failed
      // `yrd check typecheck` while HEAD was clean, and a worktree of HEAD
      // would have passed. That is the whole point of the command — a seat
      // must be able to see what the queue will see — so the invoking tree is
      // exactly the one place it must not look.
      const specs = request.names.map((name) => {
        const spec = config.checks.find((check) => check.name === name)
        if (spec === undefined) {
          throw new Error(
            `${name} is not a check the target declares (declared: ${config.checks.map((check) => check.name).join(", ") || "none"})`,
          )
        }
        return spec
      })
      // Every name is resolved before a worktree is built: an unknown check
      // should refuse instantly, not after materializing submodules.
      const head = (await git(["rev-parse", "HEAD"])).trim()
      // Uncommitted work is NOT judged, and saying so is the point. Silently
      // measuring HEAD while a seat believes its working tree was checked is
      // the same class of mismatch this command exists to remove.
      const dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).trim()
      const unjudged =
        dirty === ""
          ? ""
          : `\n${String(dirty.split("\n").length)} uncommitted path(s) were NOT judged; this measured HEAD ${head.slice(0, 12)}`
      // One run of checks, under the one layout a queue run writes (run.ts):
      // its worktree at `<workdir>/worktrees/<run>/check/<sha12>`, its logs at
      // `<workdir>/checks/<change>/<run>/check/<name>.log`, its temporary files
      // under `<workdir>/tmp`. The run id is what keeps two of them apart, so a
      // check log is written once and never replaced — two seats checking at
      // once, or one seat checking twice, keep both readings instead of the
      // second silently overwriting the first (24101).
      //
      // The change is the one this checkout would submit: the branch it stands
      // on at the head it stands at, so a seat's own check and the queue's own
      // read of the same change sit at the same path. A detached HEAD says
      // `HEAD` and is still a name nothing else takes.
      // Local check witnesses are retained without creating a queue admission history.
      const journal = openLog(join(workdir, "logs", "check"))
      const run = journal.id
      // THE HEADER FIRST, as a queue run writes its own (@i/10-yrd/24470). All
      // five fields are known before the log is even open, so a check that
      // throws while materializing its tree leaves a journal that still says
      // which change at which base it was for, rather than one a reader has to
      // call malformed.
      journal.write({
        kind: "run",
        command: "check",
        target: targetLabel,
        base: captured.oid,
        config: config.blob,
        head,
      })
      const gitOptions = {
        env: options.env,
        openOutput: journal.openGitOutput,
        onInvocation: journal.writeGitInvocation,
      }
      const checkGit = gitIn(repo, undefined, selection, gitOptions)
      const tree = await checkedTree(repo, captured.oid, undefined, selection, gitOptions)
      if (tree.candidate !== head) throw new Error(`check subject moved: expected ${head}, read ${tree.candidate}`)
      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()
      const logDir = join(workdir, "checks", changeName({ branch, head }), run, "check")
      // The worktrees root of this run, claimed before anything is made in it:
      // a queue run reaps the worktrees of runs that are no longer alive, and
      // reads a directory with no pid file as one of them (worktree.ts).
      const worktrees = join(workdir, "worktrees", run)
      mkdirSync(worktrees, { recursive: true })
      claimWorktrees(worktrees)
      // Prepared exactly as a queue run prepares one: materialized, the
      // declaration's setup run once, and told the same three values.
      let prepared: Awaited<ReturnType<typeof prepareWorktree>> | undefined
      const results: CheckResult[] = []
      try {
        for (const spec of specs) {
          let result: CheckResult
          if (spec.programRoot === true) {
            result = await programRootCheck({
              git: checkGit,
              repo,
              targetSha: captured.oid,
              tree,
              spec,
              branch,
              head,
              phase: "check",
              root: join(worktrees, "program", "check", head.slice(0, 12), spec.name),
              logDir,
              tmpdir: join(workdir, "tmp"),
              log: journal,
              env: options.env,
              selection,
              gitOptions,
              populateReference: options.populateReference,
              plumbing: options.log?.child("worktree"),
              setup: config.setup,
            })
          } else {
            // Legacy checks keep their existing shared HEAD tree and shell semantics.
            // An opted-in-only invocation must not prepare an unused third root.
            prepared ??= await prepareWorktree(checkGit, repo, head, join(worktrees, "check", head.slice(0, 12)), {
              env: options.env,
              populateReference: options.populateReference,
              selection,
              gitOptions,
              plumbing: options.log?.child("worktree"),
              targetSha: captured.oid,
              ...(config.setup === undefined
                ? {}
                : { setup: { logDir, run: config.setup, tmpdir: join(workdir, "tmp") } }),
            })
            result = await runCheck({
              cwd: prepared.path,
              env: options.env,
              logDir,
              spec,
              tmpdir: join(workdir, "tmp"),
              tree: prepared.tree,
            })
          }
          results.push(result)
          if (result.result !== "pass") break
        }
      } finally {
        try {
          if (prepared !== undefined) await prepared.remove()
        } finally {
          rmSync(worktrees, { force: true, recursive: true })
        }
      }
      emit(
        io,
        options.json,
        { checks: results, command: "check", head, ...(dirty === "" ? {} : { uncommitted: dirty.split("\n").length }) },
        `${results.map((result) => `${result.name} ${result.result} exit=${String(result.exit)} ${String(result.durationMs)} ms (log ${result.log})${result.why === undefined ? "" : `: ${result.why}`}`).join("\n")}${unjudged}`,
      )
      return results.some((result) => result.result === "stuck")
        ? 2
        : results.some((result) => result.result === "fail")
          ? 1
          : 0
    }
    case "stats": {
      // The same reading `queue list` prints, then the numbers (@i/10-yrd/24164):
      // one row per run per change, exactly the rows the watch and the list
      // show, so a stat can never disagree with the table it summarizes.
      const now = request.now ?? new Date()
      // `--since` is exactly one instant: a duration back from now, an instant
      // as written, or a commit's COMMITTER date; the stats carry which.
      let window: Readonly<{ since: Date; sinceFrom: SinceOrigin }> | undefined
      if (request.since !== undefined) {
        const parsed = parseSince(request.since, now)
        if (parsed !== undefined) {
          window = { since: parsed.at, sinceFrom: { asked: request.since, kind: parsed.kind } }
        } else {
          const committed = await instantOfCommit(git, request.since)
          if (committed === undefined) {
            io.stderr(
              `yrd: --since ${request.since} is not a duration (3h, 45m, 2d, 1w), an instant, or a commit this repository has\n`,
            )
            return 2
          }
          window = { since: committed, sinceFrom: { asked: request.since, kind: "commit" } }
        }
      }
      const { journals, all, queue } = await readListing(git, config, workdir, captured.oid)
      // The counts below are read from the same rows; a row the journal could
      // not be read for must not make an understated stat look measured.
      if (options.json !== true) narrateMalformed(io, journals, new Set())
      // Per RUN: `queue stats` counts decisions, and one change can carry several.
      const rows = watchRows(all, { journals, perRun: true })
      // Pushed, never submitted: the drafts (the KPI ruling on 24163), from the
      // one derivation over this same reading and the same window. Nothing is
      // fetched, so a head never read here counts as undated.
      const drafts = await readDrafts(git, queue, {
        since: window?.since ?? new Date(now.getTime() - DEFAULT_WINDOW_MS),
        targetSha: captured.oid,
      })
      const stats = queueStats(rows, [...drafts.dated, ...drafts.undated], {
        now,
        ...window,
        ...(request.by === undefined ? {} : { by: request.by }),
      })
      const name = queueName(config.target, await remoteUrl(git, config.target.remote))
      emit(io, options.json, { queue: name, ...stats }, formatQueueStats(stats, name))
      return 0
    }
    case "show": {
      if ((await queueFormat({ repo, remote: config.target.remote }, config.target.branch)) === "event") {
        const reading = await readEventListing(git, config, repo, workdir, captured.oid)
        if (reading.observation.contract === "root-v1" && reading.observation.outcome === "invalid") {
          io.stderr(`${reading.observation.message}\n`)
          return 2
        }
        const name = queueName(config.target, await remoteUrl(git, config.target.remote))
        const row = reading.all.find((candidate) => candidate.branch === request.branch)
        const selected = reading.changes.get(request.branch)
        if ((row === undefined) !== (selected === undefined)) {
          throw new Error(`event listing for ${request.branch} disagrees with its change fold`)
        }
        if (selected !== undefined && selected.tip === undefined) {
          throw new Error(`event change ${request.branch} has no selected tip`)
        }
        const events =
          selected === undefined
            ? []
            : await readChangeEvents(
                { repo, remote: config.target.remote },
                config.target.branch,
                request.branch,
                selected.tip as string,
              )
        const scope =
          `Read ${changesRef(config.target.branch, request.branch)} at ${config.target.remote}; ` +
          "draft branches and direct target commits are outside this reading; check results are not projected from events yet."
        emit(
          io,
          options.json,
          {
            queue: name,
            changes: row === undefined ? [] : [{ ...row, queue: config.target.branch, events }],
            journal: journalFact(reading.journals),
            observation: reading.observation,
            scope,
          },
          row === undefined
            ? `no change for ${request.branch} on ${name}. ${scope}`
            : [
                rowLine({ row }),
                `  queue: ${config.target.branch}`,
                ...events.map((event) => {
                  const at = event.props.find(([key]) => key === "Time")?.[1]
                  if (at === undefined) throw new Error(`event ${event.id} has no Time:`)
                  const reason = event.props.find(([key]) => key === "Reason")?.[1]
                  return `  ${at} ${event.type}${event.writer === null ? "" : ` by ${event.writer}`}${reason === undefined ? "" : ` — ${reason}`}`
                }),
              ].join("\n"),
        )
        return 0
      }
      const queue = await readQueue(git, config.target.remote, config.target.branch, captured.oid)
      const journals = readJournals(join(workdir, "logs"))
      if (options.json !== true) narrateMalformed(io, journals, new Set())
      const matching = queue.changes.filter((entry) => entry.change.branch === request.branch)
      const hydrated = await readHistories(git, matching, config.target.remote, config.target.branch)
      const changes = show(hydrated, request.branch, {
        journals,
        subjects: await subjects(
          git,
          matching.map((entry) => entry.change.head),
        ),
      })
      // The checks a change was JUDGED BY: the declaration at the commit its
      // record names in `Base:`, joined to what actually ran. `show` used to
      // print the packed `Check:` trailer as it stood, so a check that never
      // ran — every check after a failing one — was simply not on the screen,
      // and the command that produced a log was nowhere.
      const views = new Map<string, Readonly<{ checks: readonly CheckView[]; note?: string }>>()
      for (const change of changes) {
        const declared = await declarationFor(git, config, change.row.base)
        const ending = endingOf(change.row)
        // A DECIDED change's records are its full account: `change.checks`
        // already folds every record's `Check:` trailers, submit through
        // merge. The run this machine's journal happens to hold for it may be
        // only the phase that last touched the change — an earlier phase ran
        // under an earlier run this one does not carry — so trusting it
        // alone here is how a merged change loses evidence it still has (its
        // own 2026-09 recurrence). The journal stays the better source only
        // while the change is still being decided: that is what lets a check
        // running right now show as running instead of a stale prior result.
        const decided = ending === "merged" || ending === "failed" || ending === "stuck"
        views.set(change.row.head, {
          checks: checksOf(
            change.checks,
            ending,
            declared.checks,
            change.row.live === undefined
              ? undefined
              : {
                  name: change.row.live.check,
                  ...(change.row.live.log === undefined ? {} : { log: change.row.live.log }),
                },
            decided ? undefined : journalFor({ row: change.row }, journals)?.checks,
          ),
          ...(declared.note === undefined ? {} : { note: declared.note }),
        })
      }
      // What was queried, and where: an empty answer that names only the branch
      // it did not find leaves the reader to guess which queue at which remote
      // was read (@i/10-yrd/24050). The same identity `stats` prints.
      const name = queueName(config.target, await remoteUrl(git, config.target.remote))
      emit(
        io,
        options.json,
        {
          queue: name,
          changes: changes.map((change) => ({
            ...change.row,
            queue: config.target.branch,
            checks: views.get(change.row.head)?.checks ?? [],
            ...(views.get(change.row.head)?.note === undefined ? {} : { checksNote: views.get(change.row.head)?.note }),
            records: change.records.map((record) => ({
              at: record.at,
              kind: record.kind,
              sha: record.sha,
              subject: record.subject,
              trailers: trailerFields(record),
            })),
          })),
          journal: journalFact(journals),
        },
        changes.length === 0
          ? `no change for ${request.branch} on ${name}`
          : changes
              .map((change) => {
                const view = views.get(change.row.head)
                const headline =
                  change.row.incident === undefined
                    ? rowLine({ row: change.row })
                    : rowLine({ row: { ...change.row, reason: undefined, result: undefined } })
                return [
                  headline,
                  ...diagnosticLines(change.row, journalFor({ row: change.row }, journals)),
                  `  queue: ${config.target.branch}`,
                  ...(change.row.incident === undefined
                    ? []
                    : incidentLines(change.row.incident).map((line) => `  ${line}`)),
                  ...(view?.note === undefined ? [] : [`  (${view.note})`]),
                  ...(view?.checks ?? []).flatMap(checkLines),
                ].join("\n")
              })
              .join("\n"),
      )
      return 0
    }
  }
}

/**
 * Identify the embedded runtime by checkout PATH, never by target SHA equality:
 * the target may already record the new gitlink while this module still runs the
 * old one. An external/standalone installation is explicitly outside this fence.
 * The exact captured target OID is passed in so this check cannot re-read a
 * mutable tracking ref and disagree with the declaration used by the round.
 */
async function gitlinkOf(
  git: Git,
  targetOid: string,
  log: ConditionalLogger | undefined,
): Promise<RuntimeGitlink | RuntimeGitlinkOff> {
  const source = sourceAtLoad
  if ("error" in source) {
    // A BROKEN EMBEDDED INSTALL STILL REFUSES TO START, unchanged. The
    // queue-relative test survives HERE and only here: it is a sufficient
    // condition for "this runtime was deployed as part of the tree being
    // checked, and its git is unreadable", which is a broken install whatever
    // the arming question says. What it must never again be is the ARMING
    // decision itself — that is @i/10-yrd/24515, and it now lives in
    // `runtimeGitlinkPath`, which is not given the queue's location at all.
    const root = (await git(["rev-parse", "--show-toplevel"])).trim()
    const location = relative(root, sourceDirectory).split(sep).join("/")
    if (location !== ".." && !location.startsWith("../")) {
      throw new Error(
        `cannot identify embedded runtime at ${sourceDirectory} inside queue checkout ${root}: ${source.error}; repair the source checkout before restarting`,
      )
    }
    // Otherwise: a runtime with no readable git is a standalone or packaged
    // install, which legitimately has no gitlink to watch.
    return {
      kind: "off",
      reason: "no-source-checkout",
      why: `the relaunch exit is off: this yrd at ${sourceDirectory} runs from no readable git checkout: ${source.error}`,
    }
  }
  const decided = runtimeGitlinkPath(source.checkout, source.superproject)
  if (decided.kind === "off") return decided
  const { path } = decided
  // The target's gitlink, read through the QUEUE's clone — same repository as
  // the runtime's superproject, so the same path addresses the same submodule.
  // What the queue clone must NOT decide is whether the exit exists at all.
  const recorded = await gitlinkAt(git, targetOid, path)
  if (recorded === undefined) {
    return {
      kind: "off",
      reason: "target-records-no-gitlink",
      why:
        `the relaunch exit is off: this yrd runs at ${path} of ${source.superproject}, but the captured target ` +
        `${targetOid} records no gitlink there, so a move cannot be observed`,
    }
  }
  log?.info?.(
    `runtime ${path} observed at module load: ${source.sha}; captured target ${targetOid} records ${recorded}`,
  )
  return { kind: "gitlink", path, sha: source.sha, checkout: source.checkout, superproject: source.superproject }
}

/** This runtime's own gitlink, once identified. */
type RuntimeGitlink = Readonly<{
  kind: "gitlink"
  path: string
  sha: string
  /** Absent for an injected gitlink: a test names the shas and has no tree to await. */
  checkout?: string
  /** The working tree that RECORDS this runtime, and whose projection the wait follows. */
  superproject?: string
}>

/** The gitlink at `path` in `commit`, or undefined when there is none there. */
async function gitlinkAt(git: Git, commit: string, path: string): Promise<string | undefined> {
  return gitlinks(await git(["ls-tree", "-z", commit, "--", path])).find((row) => row.path === path)?.sha
}

/** The gitlink rows of one `ls-tree -z` listing: mode 160000, a commit at a path. */
function gitlinks(listing: string): readonly Readonly<{ path: string; sha: string }>[] {
  const rows: Readonly<{ path: string; sha: string }>[] = []
  for (const row of listing.split("\0")) {
    const [meta, path] = row.split("\t")
    const [mode, , sha] = (meta ?? "").split(" ")
    if (mode === "160000" && path !== undefined && sha !== undefined) rows.push({ path, sha })
  }
  return rows
}

function runOptions(
  repo: string,
  declared: Readonly<{ config: QueueConfig; oid: string }>,
  workdir: string,
  selection: GitSelection,
  env?: NodeJS.ProcessEnv,
  log?: ConditionalLogger,
  populateReference?: boolean,
) {
  const { config, oid } = declared
  return {
    checks: config.checks,
    configBlob: config.blob,
    env,
    populateReference,
    selection,
    notify: config.notify,
    // git-super narrates which submodule it borrowed and how long each phase
    // took; that is trace-level plumbing, so it gets a logger only at trace.
    plumbing: log?.trace === undefined ? undefined : log.child("submodules"),
    render: renderer(log),
    repo,
    // A fresh worktree has submodules and no dependencies; `setup:` is what
    // finishes it, once per worktree, before any check runs in it.
    setup: config.setup,
    teardown: config.teardown,
    target: config.target,
    targetSha: oid,
    workdir,
  }
}

/**
 * The human line is a rendering of the log record, and the CLI's own logger is the
 * one place it is rendered: one debug row per queue decision (trace for Git evidence, warn for refused
 * change-record writes), named by the log record's kind,
 * at the level the invocation resolved (`--log-level`, `LOG_LEVEL`, `-v`),
 * never a second format and never a second reading of the environment. No
 * host logger, no rendering: the JSONL file is what happened either way, and
 * a logger root of this file's own would create spans the stage accounting
 * never counts.
 */
/**
 * A record's trailers as JSON, for `show --json`: every name, every value.
 *
 * `show --json` used to emit at, kind, sha and subject and nothing else, so a
 * reader consuming the queue AS DATA learned who withdrew a change, and why, by
 * parsing the subject line back into fields the record already carried
 * (@i/10-yrd/g-ergonomics/24666).
 *
 * VALUES ARE ARRAYS BECAUSE NAMES REPEAT. A run writes one `Check` trailer per
 * check result (queue-core run.ts `checkTrailers`), and three readers already
 * use the plural accessor for exactly that. A name-to-value map would keep one
 * `Check` and silently drop the rest, which is the failure this repo bans; a
 * `string | string[]` union would push a type test onto every reader for a
 * difference the record model does not make. So every name gets a list, and the
 * two JSON reads are the twins of the two accessors in records.ts:
 * `trailers.By[0]` is `trailer(record, "By")` and `trailers.Check` is
 * `trailers(record, "Check")`. Names come in the order the record first carries
 * them, values in record order. Always present, empty when there are none: a
 * reader must not have to tell "no trailers" from "a build that omits them".
 */
function trailerFields(record: ChangeRecord): Readonly<Record<string, readonly string[]>> {
  const fields: Record<string, string[]> = {}
  for (const [name, value] of record.trailers) (fields[name] ??= []).push(value)
  return fields
}

function renderer(root: ConditionalLogger | undefined): (record: LogRecord) => void {
  if (root === undefined) return () => {}
  const base = root.child("queue")
  const byKind = new Map<string, ConditionalLogger>()
  return (record) => {
    let log = byKind.get(record.kind)
    if (log === undefined) {
      log = base.child(record.kind)
      byKind.set(record.kind, log)
    }
    const { kind, run: _run, at: _at, ...rest } = record
    if (kind === "change" && Object.values(CHANGE_REF_DIAGNOSTICS).some((reason) => reason === rest.reason)) {
      log.warn?.(summarize(kind, rest), rest)
      return
    }
    if (kind === "git") {
      log.trace?.(summarize(kind, rest), rest)
      return
    }
    // A conditional logger has no debug method below its level: nothing to render.
    log.debug?.(summarize(kind, rest), rest)
  }
}

export function summarize(kind: string, rest: Readonly<Record<string, unknown>>): string {
  const where = [rest.branch, typeof rest.head === "string" ? rest.head.slice(0, 12) : undefined]
    .filter(Boolean)
    .join(" at ")
  switch (kind) {
    case "run":
      return `queue run at ${String(rest.target)} ${String(rest.gitlink).slice(0, 12)}`
    case "change":
      if (typeof rest.text === "string") return rest.text
      return `${where}: ${String(rest.decision ?? rest.state)}`
    case "check":
    case "step": {
      // Two rows per check or step: `ms` is the end row's, and its absence is the
      // start row, the one that says a long check is running rather than hung.
      // A run's own step (the queue read) names its target, not a change.
      const about =
        where !== "" || typeof rest.target !== "string"
          ? where
          : [rest.target, typeof rest.base === "string" ? rest.base.slice(0, 12) : undefined]
              .filter(Boolean)
              .join(" at ")
      // A step git-super timed inside a compose names its owner, so its `merge`
      // is never read as the queue's merge phase.
      const name = typeof rest.within === "string" ? `${rest.within}/${String(rest.name)}` : String(rest.name)
      return rest.ms === undefined
        ? `${name} started for ${about}`
        : `${name} ran for ${about} in ${String(rest.ms)} ms`
    }
    case "result":
      return `${String(rest.name)} ${String(rest.result)} for ${where}${rest.whose === undefined ? "" : `, ${String(rest.whose)}'s`}`
    case "settle":
      // The arrow form says a pin MOVED. A nested pin left behind its own main
      // did not move, and rendering it as a raise would put a landing in the log
      // that never happened.
      switch (rest.state) {
        case "left-off-main":
          return `${where}: ${String(rest.path)} ${String(rest.from).slice(0, 12)} left off submodule main ${String(rest.to).slice(0, 12)}`
        case "kept-behind":
          return `${where}: ${String(rest.path)} ${String(rest.from).slice(0, 12)} kept behind submodule main ${String(rest.to).slice(0, 12)}`
        // A COMPOSED pin has two sources and no single "from": the merge joined
        // the component main with the change's pin. Rendering it through the
        // arrow form below would read as an ordinary raise and lose the one
        // fact that matters, which is that this commit is the merge's own.
        case "merged":
          return `${where}: ${String(rest.path)} merged submodule main ${String(rest.from).slice(0, 12)} with ${String(rest.to).slice(0, 12)} as ${String(rest.merged).slice(0, 12)}`
        default:
          return `${where}: ${String(rest.path)} ${String(rest.from).slice(0, 12)} -> ${String(rest.to).slice(0, 12)} (submodule main)`
      }
    case "merge":
      return `${where} merged as ${String(rest.commit).slice(0, 12)}`
    case "message":
      return `told ${String(rest.to)} about ${where}`
    case "reap":
      return `reaped the worktree ${String(rest.path)} of the run ${String(rest.of)}: ${String(rest.why)}`
    case "pause":
      return `${String(rest.state)} by ${String(rest.by)} since ${String(rest.since)}: ${String(rest.reason)}`
    case "observation":
      return String(rest.text ?? rest.message)
    case "merged-direct":
      return directMergeLine({
        commit: String(rest.commit),
        gitlinks: Array.isArray(rest.gitlinks) ? rest.gitlinks.map(String) : [],
        subject: String(rest.subject),
        target: String(rest.branch),
      })
    default:
      return kind
  }
}

function describeRun(
  outcome: Readonly<{
    exitCode: number
    merged: readonly string[]
    failed: readonly string[]
    stuck: readonly string[]
    directMerges: readonly string[]
    log: string
    stopped?: Readonly<{ says: string }>
    observation: GitObservation
  }>,
): string {
  const words = ["pass", "fail", "stuck"][outcome.exitCode] ?? String(outcome.exitCode)
  const parts = [
    outcome.merged.length > 0 ? `${STATE_WORDS.merged.word} ${outcome.merged.join(", ")}` : undefined,
    outcome.failed.length > 0 ? `${STATE_WORDS.failed.word} ${outcome.failed.join(", ")}` : undefined,
    outcome.stuck.length > 0 ? `${STATE_WORDS.stuck.word} ${outcome.stuck.join(", ")}` : undefined,
    outcome.directMerges.length > 0
      ? `${String(outcome.directMerges.length)} ${outcome.directMerges.length === 1 ? "commit" : "commits"} around the queue at ${outcome.directMerges.map((sha) => sha.slice(0, 12)).join(", ")}`
      : undefined,
    outcome.stopped === undefined ? undefined : `${outcome.stopped.says}; no merge was made`,
    outcome.observation.message,
    ...outcome.observation.notices.map((notice) => notice.text),
  ].filter((part): part is string => part !== undefined)
  return `${words}: ${parts.length === 0 ? "nothing to do" : parts.join("; ")} (log ${outcome.log})`
}

/**
 * One line per change this round ended stuck, naming the cure the way
 * `queue list`/`queue show` already render a stuck row's incident
 * (`incidentLine`, ADR-0007's compact form) — `queue run`'s own summary line
 * names only the branch (@i/10-yrd/24141 AC2).
 *
 * Read from this round's own log rather than the remote: the `end()` step
 * that pushed a change to `stuck` wrote the complete incident to `outcome.log`
 * in the same call (run.ts), so this is that run's own record of why, never a
 * second, possibly-later reading of the change ref.
 */
function stuckCureLines(outcome: QueueRunOutcome): readonly string[] {
  if (outcome.stuck.length === 0) return []
  const rows = readFileSync(outcome.log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""
  return outcome.stuck.map((branch) => {
    const row = rows.find(
      (record) => record.kind === "change" && record.decision === "stuck" && record.branch === branch,
    )
    const complete =
      row !== undefined &&
      filled(row.code) &&
      filled(row.subject) &&
      filled(row.via) &&
      filled(row.evidence) &&
      filled(row.next) &&
      filled(row.owner)
    if (!complete) {
      // Every stuck ending writes a complete incident (run.ts `stuckWrite`);
      // this is the guard against a future ending that stops doing so, not an
      // expected path — it still names the branch rather than saying nothing.
      return `stuck ${branch}: no complete incident in this run's log (${outcome.log}); see \`yrd queue show ${branch}\``
    }
    const incident: Incident = {
      code: row.code as string,
      subject: row.subject as string,
      via: row.via as string,
      evidence: row.evidence as string,
      next: row.next as string,
      owner: row.owner as string,
    }
    return `stuck ${branch}: ${incidentLine(incident)}`
  })
}

/**
 * The shortest sleep a round that still has work to do may be given: enough
 * that a round making no progress — a transient wait re-reading the same line
 * — cannot become a hot loop, and small enough to be nothing beside a merge.
 */
export const READY_SLEEP_MS = 1000

/**
 * How long the service waits after one round.
 *
 * The interval is an IDLE cadence: how often an empty line is looked at. It was
 * being spent between two ready merges as well, so a change that arrived behind
 * another waited the full interval for no reason — at `--interval 120`, two
 * wasted minutes per merge, on top of the check that judged it.
 *
 * A round that merged, or that left checked changes it did not act on (the
 * queue merges the first checked change and no more), has more to do NOW, and
 * goes again at {@link READY_SLEEP_MS}. Never longer than the interval, so a
 * short interval stays a short interval. A round that held a stopped line did
 * neither, and waits the interval.
 */
export function sleepAfter(outcome: QueueRunOutcome, intervalMs: number): number {
  const ready = outcome.merged.length > 0 || outcome.checkedWaiting > 0
  return ready ? Math.min(intervalMs, READY_SLEEP_MS) : intervalMs
}

/** One printed round of the text watch, with `updated HH:MM:SS` under the queue's name (item 30). */
function stampRound(text: string, queue: string, at: Date): string {
  const stamp = `updated ${clock(at, { seconds: true })}`
  const lines = text.split("\n")
  const name = lines.indexOf(queue)
  if (name === -1) return `${stamp}\n${text}`
  return [...lines.slice(0, name + 1), stamp, ...lines.slice(name + 1)].join("\n")
}

/** A selector was given and nothing answered to it: the one case a watch must refuse rather than wait out. */
function selectedNothing(terms: readonly string[] | undefined, rows: readonly WatchRow[]): boolean {
  return terms !== undefined && terms.length > 0 && rows.length === 0
}

/** What was asked for, where it was looked for, and what the read leaves out. */
function missedSelector(terms: readonly string[], queue: string, matched: number): string {
  return (
    `yrd: nothing in ${queue} matches ${terms.join(" or ")}. The queue read holds ${String(matched)} ` +
    "matching change(s); ended changes older than seven days are not read.\n"
  )
}

/** One reading of the queue as the pane consumes it. */
/** The entries one queue read yields: the type `readQueue` returns, named here rather than widened in the core. */
type QueueEntries = Awaited<ReturnType<typeof readQueue>>["changes"]

/** Open exactly the event tip shown in the table, including every event in its history. */
export async function openEventDetail(
  git: Git,
  config: QueueConfig,
  item: WatchRow,
  label: string,
  repo: string,
  selected: EventChange,
  journal?: JournalRun,
): Promise<ChangeDetail> {
  const { row } = item
  if (
    row.format !== "event" ||
    selected.commit !== row.head ||
    selected.status !== row.state ||
    selected.tip === undefined
  ) {
    throw new Error(`event detail for ${row.branch} disagrees with the selected table row`)
  }
  const events = await readChangeEvents({ repo, remote: config.target.remote }, label, row.branch, selected.tip)
  return {
    row,
    run: runOf(row, label, [], item.run?.id ?? row.run),
    checks: [],
    events,
    ...(journal === undefined ? {} : { journal }),
    ...(await headFacts(git, config, row)),
    note: "Check results are not projected from event history in this detail.",
  }
}

/**
 * One change's detail, read for the row under the cursor and for nothing else
 * (plan D2): its checks joined to the declaration it was judged by and to what
 * their logs hold, its records for HISTORY, and what git says about the head:
 * body, the commits past the base, the diff's size. Every git-derived part is
 * ABSENT with a sentence when the head is not in this repository, never a
 * blank. Nothing here writes.
 */
export async function openDetail(
  git: Git,
  config: QueueConfig,
  entries: QueueEntries,
  item: WatchRow,
  label: string,
  journal?: JournalRun,
): Promise<ChangeDetail> {
  const { row } = item
  const own = entries.filter((entry) => entry.change.branch === row.branch && entry.change.head === row.head)
  const histories = own.length === 0 ? [] : await readHistories(git, own, config.target.remote, config.target.branch)
  const shown = histories.flatMap((entry) => show([entry], entry.change.branch))
  const records = shown.flatMap((change) => change.records)
  // ONE JUDGEMENT PER ROW, scoped by THE RUN THIS ROW IS ABOUT and never by the
  // newest run the change carries. A row a journal split (`item.run`) opens on
  // the judgement that run ended, found by its id in each trailer's create-only
  // log path: folding them all opened the OLD row on the newest run's checks
  // (the andon — a stuck change the line re-took after a resume and that stuck
  // again). Within a judgement the records stay the full account, because a
  // merged change's submit-phase checks can come from an earlier run
  // (1fca452c).
  //
  // A row that stands for its WHOLE change splits by nothing and so keeps the
  // whole fold — every run's `Check:` trailers, which is the only place the
  // older run's output is still reachable now that the table is one row per
  // change (S1). Reading `row.run` here instead would scope that row to the
  // newest run and drop the rest in silence, which is the same defect as the
  // incident above with the rows the other way round.
  const packed = judgementOf(records, item.run?.id).flatMap((record) => trailers(record, "Check"))
  const declared = await declarationFor(git, config, row.base)
  const ending = endingOf(row)
  // A DECIDED change's records are its full account: `packed` (folded from
  // `show` above) already carries every record's `Check:` trailers, submit
  // through merge. `item.run` — this machine's own journal, selected upstream
  // by `journalFor` — may hold only the phase that last touched the change,
  // so trusting it here for a decided change is how a merged change loses
  // evidence it still has (the `show` case's own 2026-09 recurrence,
  // 1fca452c). The journal stays the better source only while the change is
  // still being decided: that is what lets a check running right now show as
  // running instead of a stale prior result.
  const decided = ending === "merged" || ending === "failed" || ending === "stuck"
  const views = checksOf(
    packed,
    ending,
    declared.checks,
    row.live === undefined
      ? undefined
      : { name: row.live.check, ...(row.live.log === undefined ? {} : { log: row.live.log }) },
    decided ? undefined : item.run?.checks,
  )
  const checks = views.map(readOutput)
  const about = row.state === "direct" ? {} : await headFacts(git, config, row)
  return {
    checks,
    row,
    ...(journal === undefined ? {} : { journal }),
    run: runOf(row, label, views, item.run?.id ?? row.run),
    ...(histories.length === 0 ? {} : { records }),
    ...about,
    ...(declared.note === undefined ? {} : { note: declared.note }),
  }
}

/**
 * The records of the one judgement a history row's run ended: the change's
 * records cut after each record that ends a judgement (anything but opened,
 * checked or the `sent` that reports an ending), and the piece whose `Check:`
 * trailers log under that run. Every record when the run is unknown or no piece
 * names it, which is exactly the fold the detail read before.
 */
function judgementOf(records: readonly ChangeRecord[], run: string | undefined): readonly ChangeRecord[] {
  if (run === undefined) return records
  const endsJudgement = (record: ChangeRecord) =>
    record.kind !== "opened" && record.kind !== "checked" && record.kind !== "sent"
  const pieces: ChangeRecord[][] = []
  for (const record of records) {
    const current = pieces.at(-1)
    if (current === undefined || (current.some(endsJudgement) && record.kind !== "sent")) pieces.push([record])
    else current.push(record)
  }
  const marker = `/${run}/`
  const named = pieces.find((piece) =>
    piece.some((record) =>
      trailers(record, "Check").some((packed) => readCheckTrailer(packed).log?.includes(marker) === true),
    ),
  )
  return named ?? records
}

/** The base a change's own commits are counted and diffed from: the record's, else the target as it stands. */
async function baseOf(git: Git, config: QueueConfig, row: Row): Promise<string> {
  if (row.base !== undefined) return row.base
  return (await git(["merge-base", `refs/remotes/${config.target.remote}/${config.target.branch}`, row.head])).trim()
}

/** What git says about the head: body, the commits past the base, the diff's size, or why it says nothing. */
async function headFacts(
  git: Git,
  config: QueueConfig,
  row: Row,
): Promise<Pick<ChangeDetail, "body" | "commits" | "diffStat" | "gitAbsent">> {
  try {
    const base = await baseOf(git, config, row)
    const body = (await git(["log", "-1", "--format=%b", row.head])).trimEnd()
    const dates = (await git(["log", "--format=%cI", `${base}..${row.head}`]))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => new Date(line))
      .filter((at) => !Number.isNaN(at.getTime()))
    const numstat = (await git(["diff", "--numstat", base, row.head])).split("\n").filter((line) => line.trim() !== "")
    let additions = 0
    let deletions = 0
    for (const line of numstat) {
      const [added, removed] = line.split("\t")
      additions += Number.parseInt(added ?? "0", 10) || 0
      deletions += Number.parseInt(removed ?? "0", 10) || 0
    }
    const last = dates[0]
    const first = dates.at(-1)
    return {
      ...(body === "" ? {} : { body }),
      commits: {
        count: dates.length,
        ...(first === undefined ? {} : { first }),
        ...(last === undefined ? {} : { last }),
      },
      diffStat: { additions, deletions, files: numstat.length },
    }
  } catch (error) {
    return {
      gitAbsent: `git could not read ${row.head.slice(0, 12)} here (${firstLine(error)}): the body, the commits and the diff are not shown`,
    }
  }
}

/** How much of a diff the fold holds: the head of it, so a generated-file change never becomes the pane's memory. */
const DIFF_HEAD_BYTES = 256 * 1024

/** The unified diff of a change against its base, read only when its fold opens. */
async function readDiff(git: Git, config: QueueConfig, item: WatchRow): Promise<DiffText> {
  try {
    const base = await baseOf(git, config, item.row)
    const text = await git(["diff", "--no-color", base, item.row.head])
    if (text.trim() === "") return { why: `git diff ${base.slice(0, 12)} ${item.row.head.slice(0, 12)} is empty` }
    if (text.length <= DIFF_HEAD_BYTES) return { text }
    return {
      text: `${text.slice(0, DIFF_HEAD_BYTES)}\n… ${String(text.length - DIFF_HEAD_BYTES)} more bytes not shown`,
    }
  } catch (error) {
    return { why: `git could not diff ${item.row.head.slice(0, 12)} here: ${firstLine(error)}` }
  }
}

function snapshotOf(
  round: Readonly<{
    rows: readonly WatchRow[]
    unfiltered: readonly WatchRow[]
    queue: string
    queues: readonly WatchQueue[]
    pause?: string
    journalAbsent?: string
    observation: GitObservation
    runner: RunnerFacts
    decisions: readonly RunDecision[]
    stopped: StopFact | null
    drafts?: Readonly<{ window: DraftWindow; unread: readonly string[] }>
  }>,
): WatchSnapshot {
  return {
    at: new Date(),
    observation: round.observation,
    decisions: round.decisions,
    queue: round.queue,
    queues: round.queues,
    rows: round.rows,
    unfiltered: round.unfiltered,
    runner: round.runner,
    stopped: round.stopped,
    ...(round.drafts === undefined
      ? {}
      : { drafts: { unread: round.drafts.unread.length, window: round.drafts.window } }),
    ...(round.pause === undefined ? {} : { pause: round.pause }),
    ...(round.journalAbsent === undefined ? {} : { journalAbsent: round.journalAbsent }),
  }
}

/** How much of one check's log the pane holds: the tail, so a huge log never becomes the pane's memory. */
const LOG_TAIL_BYTES = 64 * 1024

/**
 * A check with what its log actually holds. Every way there is no output has
 * its own sentence — no path recorded, the file is not on this machine, it
 * could not be read — because an empty pane that does not say what it looked
 * for is the failure this whole port is against.
 */
function readOutput(check: CheckView): CheckPanel {
  if (check.log === undefined) {
    return { ...check, why: "no log path is recorded for this check" }
  }
  try {
    const size = statSync(check.log).size
    const text = readFileSync(check.log, "utf8")
    // A log is evidence, and its colors are not: vitest and friends write
    // chalk backgrounds, and a background inside a Text is a strict-render
    // refusal that took the whole pane down on 2026-09-05 (soak, minute one).
    const output = stripAnsi(size > LOG_TAIL_BYTES ? text.slice(-LOG_TAIL_BYTES) : text)
    // An empty log means two different things either side of a check's ending:
    // one that is still running has yet to write its first line, and one that
    // has ended never wrote one. Since a check's log is created before its
    // child starts (check.ts), the running case is now the ORDINARY reading of
    // a check in its first seconds, and a pane that drops the word `running`
    // there tells a watcher nothing about whether the queue is alive.
    if (output.trim() === "") {
      const why =
        check.state === "running"
          ? `running; its log at ${check.log} is empty so far`
          : `the log at ${check.log} is empty`
      return { ...check, why }
    }
    return { ...check, output }
  } catch (error) {
    const why =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? check.state === "running"
          ? // A check's log is created before its child starts, so a running
            // check's log is never merely unwritten: it exists on the machine
            // the queue runs on. Missing HERE means this is not that machine,
            // which is the same fact the ended arm below reports.
            `running, but no log at ${check.log} on this machine; the queue writes its logs where it runs`
          : `no log at ${check.log} on this machine; the queue writes its logs where it runs`
        : `the log at ${check.log} could not be read: ${error instanceof Error ? error.message : String(error)}`
    return { ...check, why }
  }
}

/** Whether a change in this state holds a place in line: queued, checked or stuck. */
function inLineState(state: Row["state"]): boolean {
  return state === "queued" || state === "checked" || state === "stuck"
}

/** How often a waiter tries the round lock again: well inside the service's shortest sleep, so a waiter wins the gap between two rounds. */
const ROUND_LOCK_POLL_MS = 200

/** The process holding the round lock, as the lock's body names it. */
type RoundLockHolder = Readonly<{
  command: string
  pid: number
  /** When it took the lock. */
  since: string
  host?: string
  /** The runtime's own start. */
  startedAt?: string
  /** `/proc/sys/kernel/random/boot_id`, when it could be read. */
  boot?: string
  /** The clock tick it started at, when it could be read. */
  tick?: number
}>

/** A wait for the round lock: the holder its body names, when it names one, and when the wait began. */
type RoundLockWait = Readonly<{ holder?: RoundLockHolder; waitingSince: Date }>

/** The round lock's body as a waiter reads it; undefined when the file is not there. */
function lockBody(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/**
 * The holder a round lock body names, or undefined when it names none: the
 * body is empty or half-written between a take and its write, and the waiter
 * says so and reads it again on its next look.
 */
function lockHolderOf(body: string | undefined): RoundLockHolder | undefined {
  if (body === undefined || body.trim() === "") return undefined
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    // silent-fallback-allow: a body caught mid-write names no holder yet; the
    // wait is stated as unnamed and the next look reads the body again.
    return undefined
  }
  const holder = value as Partial<Record<keyof RoundLockHolder, unknown>> | null
  if (
    typeof holder !== "object" ||
    holder === null ||
    typeof holder.command !== "string" ||
    typeof holder.pid !== "number" ||
    typeof holder.since !== "string"
  ) {
    return undefined
  }
  return holder as RoundLockHolder
}

/** The holder of the round lock, as a waiter names it. */
function lockHolderLine(wait: RoundLockWait): string {
  const { holder } = wait
  if (holder === undefined) return "a process holds it whose name the lock file does not carry yet"
  return `pid ${String(holder.pid)} (${holder.command}) has held it since ${holder.since}`
}

/**
 * The wait for the round lock, as the service's health document carries it,
 * and the one place it is shaped: the holder's command and pid, when it took
 * the lock, and when this service began waiting on it. A holder the body does
 * not name yet leaves only the wait's start.
 */
function lockWaitFact(wait: RoundLockWait): Readonly<Record<string, unknown>> {
  const waitingSince = wait.waitingSince.toISOString()
  if (wait.holder === undefined) return { waitingSince }
  const { command, pid, since } = wait.holder
  return { holder: { command, pid }, since, waitingSince }
}

/**
 * The code a watched set of changes ended with, or undefined while any of them
 * is still in line. It is `yrd check`'s own ladder — stuck beats failed beats
 * merged — because a watch is the same question asked over time, and the two
 * answering differently for one change is the whole failure this mirrors. A
 * withdrawn change stands on the failed rung: it did not land, and the next
 * move is its submitter's (@i/10-yrd/24492).
 */
export function endingCode(states: readonly Row["state"][]): YrdCliExitCode | undefined {
  if (
    states.some(
      (state) =>
        state === "queued" ||
        state === "verifying" ||
        state === "checking" ||
        state === "merging" ||
        state === "checked",
    )
  ) {
    return undefined
  }
  if (states.some((state) => state === "stuck")) return 2
  if (states.some((state) => state === "failed" || state === "withdrawn" || state === "cancelled")) return 1
  return 0
}

/** The URL a remote NAME stands for, which is what the queue calls itself to a stranger (config.ts). */

/** Preserve the run selected by this row's join, including the collapsed latest lens. */
function journalFor(item: WatchRow, journals: Journals): JournalRun | undefined {
  return (
    item.run ?? journals.runs.get(journalKey(item.row.branch, item.row.head))?.find((run) => run.id === item.row.run)
  )
}

/**
 * Where the run journal was looked for, and what was found there — carried in
 * every JSON answer that has journal-derived fields in it, so a reader that
 * sees no `live` and no `run` can tell a queue with nothing running from a
 * machine that holds no journal at all.
 */
function journalFact(
  journals: Journals,
): Readonly<{ dir: string; absent?: string; malformed?: Journals["malformed"] }> {
  return {
    dir: journals.dir,
    ...(journals.absent === undefined ? {} : { absent: journals.absent }),
    ...(journals.malformed.length === 0 ? {} : { malformed: journals.malformed }),
  }
}

/**
 * Every journal row the reader could not read, said out loud on stderr the
 * first time this command sees it. Narration, so the product on stdout is
 * unchanged and a `--json` consumer reads the same defects from
 * {@link journalFact} instead.
 *
 * The read survives one malformed row (24408) — and a skipped row that nobody
 * prints is exactly the silent error that degrading must not become. `said` is
 * scoped to one invocation, so a watch refreshing every few seconds states a
 * defect once while a NEW one still reaches the reader the round it appears.
 */
function narrateMalformed(io: YrdCliIO, journals: Journals, said: Set<string>): void {
  for (const defect of journals.malformed) {
    const line = `yrd: run journal ${defect.run} has a row that could not be read for ${defect.key}: ${defect.message}; the row was skipped — fix the writer (24408)\n`
    if (said.has(line)) continue
    said.add(line)
    io.stderr(line)
  }
}

/**
 * The declaration a change was JUDGED BY: the one at the commit its record
 * names in `Base:`, not whatever the target carries now. A change judged under
 * checks that have since been renamed must still show the checks it was
 * measured against.
 *
 * When that reading cannot be had — no `Base:` on the record, or the commit is
 * not in this repository — the target's own declaration stands in AND the note
 * says so, in the same breath, because a "not run" measured against the wrong
 * list is a claim nobody made.
 */
async function declarationFor(
  git: Git,
  config: QueueConfig,
  base: string | undefined,
): Promise<Readonly<{ checks: readonly CheckSpec[]; note?: string }>> {
  if (base === undefined) {
    return { checks: config.checks, note: "the record names no base, so these are the checks the target declares now" }
  }
  try {
    const at = await readConfig(git, base, config.target)
    if (at !== undefined) return { checks: at.checks }
    return {
      checks: config.checks,
      note: `${base.slice(0, 12)} carries no .yrd.yml, so these are the checks the target declares now`,
    }
  } catch (error) {
    return {
      checks: config.checks,
      note: `the declaration at ${base.slice(0, 12)} could not be read (${error instanceof Error ? error.message : String(error)}), so these are the checks the target declares now`,
    }
  }
}

/** How the change ended, in the word `checksOf` needs to judge its last check. */
function endingOf(row: Row): "checked" | "merged" | "failed" | "stuck" | "open" {
  return row.state === "merged" || row.state === "failed" || row.state === "stuck" || row.state === "checked"
    ? row.state
    : "open"
}

/**
 * The glyphs the retired watch used for exactly these five conditions, kept
 * because the operator already reads them: passed, failed, stuck, running, and
 * a check the change never reached.
 */

/** One check, and under it the command that produced it and the log it wrote. */
function checkLines(check: CheckView): readonly string[] {
  const exit = check.result?.exit === undefined ? "" : ` exit=${check.result.exit}`
  const ms = check.result?.ms === undefined ? "" : ` ${mediaDuration(check.result.ms)}`
  // A running journal names the eventual artifact before runCheck writes it.
  // Reuse the watch's availability reading so show does not advertise it early.
  const log =
    (check.state === "running" ? readOutput(check).why : undefined) ??
    (check.log === undefined ? undefined : `log ${check.log}`)
  const state =
    check.state === "not-run"
      ? " NOT RUN"
      : check.state === "running"
        ? " running"
        : check.state === "unmeasured"
          ? " unmeasured — no result recorded"
          : ""
  return [
    `  ${CHECK_GLYPH[check.state]} ${check.name}${state}${exit}${ms}`,
    // The command above its output, which here is the path the output went to
    // (S2.21). A check the declaration no longer names has no command to show,
    // and says that rather than showing an empty one.
    check.spec === undefined ? "      (the declaration does not name this check)" : `      $ ${check.spec.run}`,
    ...(log === undefined ? [] : [`      ${log}`]),
  ]
}

/** Read an event queue through Gitomic and project its change chains and draft branch heads. */
async function readEventListing(
  git: GitRunner,
  config: QueueConfig,
  repo: string,
  workdir: string,
  targetOid: string,
): Promise<
  Readonly<{
    format: "event"
    all: readonly Row[]
    journals: Journals
    drafts: DraftReading
    pause: PauseRecord | undefined
    changes: ReadonlyMap<string, EventChange>
    observation: GitObservation
  }>
> {
  const store = { repo, remote: config.target.remote }
  const queue = await readEventQueue(store, config.target.branch)
  const histories = await listChangeHistories(store, config.target.branch)
  const changes = new Map([...histories].map(([branch, history]) => [branch, history.state]))
  const directMerges = await eventDirectMergeCommits(git, config.target.branch, targetOid, queue.declaration, histories)
  const queuePrefix = `${queueRefPrefix(config.target.branch)}/`
  const [queueRefs, branchRefs] = await Promise.all([listRefs(queuePrefix, store), listRefs("refs/heads/", store)])
  assertEventListingFence(config.target.branch, queue, changes, queueRefs)
  const heads = new Map([...branchRefs].map(([ref, oid]) => [ref.slice("refs/heads/".length), oid]))
  const drafts = await readDrafts(
    git,
    {
      heads,
      changes: [...changes].flatMap(([branch, change]) =>
        change.commit === undefined ? [] : [{ change: { branch, head: change.commit } }],
      ),
    },
    { targetSha: targetOid },
  )
  const projected = [
    ...eventRows(changes),
    ...list([], { directMerges }),
    ...eventRows(new Map(), [...drafts.dated, ...drafts.undated]),
  ]
  const titles = await subjects(
    git,
    projected.map((row) => row.head),
  )
  const all = projected.map((row) => ({
    ...row,
    ...(titles.get(row.head) === undefined ? {} : { subject: titles.get(row.head) }),
  }))
  const observation = await git.observe({
    version: 1,
    root: {
      remote: await remoteUrl(git, config.target.remote),
      targetRef: `refs/heads/${config.target.branch}`,
      targetOid,
    },
    checked: [],
    fence: {
      prefixes: ["refs/heads/", queuePrefix],
      refs: [...queueRefs, ...branchRefs].map(([ref, oid]) => ({ ref, oid })),
    },
  })
  return {
    format: "event",
    all,
    journals: readJournals(join(workdir, "logs")),
    drafts,
    pause: eventPause(queue),
    changes,
    observation,
  }
}

/** A history read and its final observation must name the same event tips. */
export function assertEventListingFence(
  name: string,
  queue: EventQueue,
  changes: ReadonlyMap<string, EventChange>,
  advertised: ReadonlyMap<string, string>,
): void {
  const expected = new Map<string, string>([[queueRef(name), queue.tip]])
  for (const [branch, change] of changes) {
    if (change.tip === undefined) throw new Error(`event change ${branch} has no selected chain tip`)
    expected.set(changesRef(name, branch), change.tip)
  }
  const changePrefix = `${queueRefPrefix(name)}/changes/`
  for (const [ref, tip] of expected) {
    if (advertised.get(ref) !== tip) {
      throw new Error(`${ref} moved during event list: read ${tip}, observed ${advertised.get(ref) ?? "absent"}`)
    }
  }
  for (const [ref, tip] of advertised) {
    if (ref.startsWith(changePrefix) && !expected.has(ref)) {
      throw new Error(`${ref} appeared during event list at ${tip}; read the queue again`)
    }
  }
}

/**
 * One legacy queue reading for list, watch and stats: change refs, the local
 * run journal, direct target commits and head subjects. `shown` adds ending
 * instants and draft branches for the human table.
 */
export async function readListing(
  git: GitRunner,
  config: QueueConfig,
  workdir: string,
  targetOid: string,
  options: Readonly<{ shown?: Readonly<{ draftWindow: DraftWindow }> }> = {},
): Promise<
  Readonly<{
    queue: Awaited<ReturnType<typeof readQueue>>
    journals: Journals
    all: readonly Row[]
    /** The drafts of the window asked for; absent when none was. */
    drafts?: DraftReading
    observation: GitObservation
  }>
> {
  const queue = await readQueue(git, config.target.remote, config.target.branch, targetOid)
  if (queue.observation.fence.refs.some(({ ref }) => ref === queueRef(config.target.branch))) {
    throw new Error(
      `${config.target.remote}#${config.target.branch} changed to event format during legacy read; read the queue again`,
    )
  }
  const observation = await git.observe({
    version: 1,
    root: {
      remote: await remoteUrl(git, config.target.remote),
      targetRef: `refs/heads/${config.target.branch}`,
      targetOid,
    },
    ...queue.observation,
  })
  const journals = readJournals(join(workdir, "logs"))
  const window = options.shown?.draftWindow
  const drafts =
    window === undefined
      ? undefined
      : await readDrafts(git, queue, {
          targetSha: targetOid,
          ...(window === "7d" ? { since: new Date(Date.now() - DRAFT_WINDOW_MS) } : {}),
        })
  const all = list(queue.changes, {
    directMerges: await directMergeCommits(git, config.target.branch, targetOid, queue.changes),
    journals,
    subjects: await subjects(
      git,
      queue.changes.map((entry) => entry.change.head),
    ),
    ...(options.shown === undefined ? {} : { endings: await endingInstants(git, queue.changes) }),
    // Seven days lists the drafts it can date and counts the rest; every draft lists them all, marked.
    ...(drafts === undefined ? {} : { drafts: window === "all" ? [...drafts.dated, ...drafts.undated] : drafts.dated }),
  })
  return { all, journals, queue, observation, ...(drafts === undefined ? {} : { drafts }) }
}

/** A commit's committer instant; undefined only when the name is absent, while unreadable or malformed commits throw. */
async function instantOfCommit(git: Git, text: string): Promise<Date | undefined> {
  const commit = await refAt(git, text)
  if (commit === undefined) return undefined
  const seconds = (await git(["log", "-1", "--format=%ct", commit, "--"])).trim()
  if (!/^\d+$/u.test(seconds)) {
    throw new Error(`commit ${commit}: git returned invalid committer timestamp ${JSON.stringify(seconds)}`)
  }
  const milliseconds = Number(seconds) * 1000
  const instant = new Date(milliseconds)
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(instant.getTime())) {
    throw new Error(`commit ${commit}: git returned invalid committer timestamp ${JSON.stringify(seconds)}`)
  }
  return instant
}

function emit(io: YrdCliIO, json: boolean | undefined, data: unknown, human: string): void {
  if (json === true) io.stdout(`${JSON.stringify(data)}\n`)
  else io.stdout(`${human}\n`)
}
