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
import { dirname, join, relative, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import type { ConditionalLogger } from "loggily"
import { adaptProcessGit, createProcess, gitFailure } from "@yrd/process"
import {
  CHANGE_REF_DIAGNOSTICS,
  directMergeCommits,
  changeName,
  checksOf,
  claimWorktrees,
  directMergeLine,
  pauseLine,
  prepareWorktree,
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
  remoteUrl,
  runId,
  subjects,
  targetName,
  runCheck,
  show,
  inspectSubmit,
  freshnessLine,
  readRemoteCommit,
  refAt,
  queueRefPrefix,
  submit,
  nextStuckStreak,
  QUEUE_HEALTH_DOCUMENT,
  ROUND_BUDGET_MS,
  relaunchStalledHealthDocument,
  roundHealthDocument,
  runtimeGitlinkPath,
  stuckBackoffMs,
  QueuePaused,
  QueueNotPaused,
  writePause,
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
  type Incident,
  type LogRecord,
  type QueueConfig,
  type QueueHealthDocument,
  type QueueRunOutcome,
  type RoundFacts,
  type RuntimeGitlinkOff,
  type StuckStreak,
  type Row,
} from "@yrd/queue-core"
import { clocksLine, noticeLine } from "./watch-notice.ts"
import { FILTER_FIELDS, filterRows, rowLine, watchRows, type WatchRow } from "./watch-rows.ts"
import type { ChangeDetail, CheckPanel, DiffText } from "./watch-detail.tsx"

import type { WatchQueue } from "./watch-list.tsx"
import type { WatchSnapshot } from "./watch-pane.tsx"
import { runOf } from "./watch-run.ts"
import { stripAnsi } from "@silvery/ansi"
import { CHECK_GLYPH, clock, diagnosticLines, firstLine, mediaDuration } from "./watch-format.ts"
import { readRunnerFacts, type RunnerFacts } from "./watch-runner.ts"
import { decisionsOfRows, type RunDecision } from "./watch-stats.ts"
import {
  formatQueueStats,
  parseSince,
  queueStats,
  type PushedRef,
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
 * should not be silent for longer than a round is allowed to take. Past it the
 * wait is no longer "the updater is a moment behind" — it is a checkout that is
 * not coming, and the difference has to reach a person rather than accumulate.
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
      rebase?: boolean
    }>
  | Readonly<{ command: "pause"; by: string; reason: string }>
  | Readonly<{ command: "resume"; by: string; reason?: string }>
  | Readonly<{ command: "run" }>
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
      /** Awaited after each round, before the gitlink is read; a test mutates the world or stops the service here. */
      afterRound?: (outcome: QueueRunOutcome) => void | Promise<void>
      /**
       * Awaited after EVERY round, stuck ones included, with the document that
       * round wrote.
       *
       * `afterRound` cannot serve here: it takes an outcome, and a round that
       * could not judge has none. It is also the only seam that can stop a
       * service which — deliberately, as of @i/10-yrd/24395 — no longer ends
       * itself on a stuck round. A test without it would run forever, which is
       * the correct new behaviour and an untestable one.
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
  pause: "queue pause",
  list: "queue list",
  run: "queue run",
  show: "queue show",
  stats: "queue stats",
  submit: "submit",
  resume: "queue resume",
  up: "queue up",
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
   * One queue run, emitted. A run that could not even judge — a bad
   * invocation, a remote that cannot be read — comes back as {@link RoundStuck}
   * carrying WHY, and has already said so.
   *
   * It carries the reason rather than `undefined` because the service now
   * survives this: a stuck round is a round outcome, and the loop's health
   * document has to name the fault it is unhealthy for. `undefined` could only
   * ever become "stuck for reasons unknown", which is the silent half of the
   * alarm this bead exists to remove.
   */
  const oneRound = async (declared: CapturedDeclaration): Promise<QueueRunOutcome | RoundStuck> => {
    let outcome: QueueRunOutcome
    try {
      outcome = await queueRun({
        ...runOptions(repo, declared, workdir, selection, options.env, options.log, options.populateReference),
        foreground: request.command === "run",
      })
    } catch (error) {
      const why = `the queue run could not judge: ${error instanceof Error ? error.message : String(error)}`
      stuck(why)
      return { why }
    }
    emit(io, options.json, outcome, describeRun(outcome))
    // Naming the branch is `describeRun`'s; naming what fixes it is this
    // round's own log, which the ending that stuck it already wrote in full
    // (run.ts `end()`). `queue list` and `queue show` render the same stored
    // incident with `incidentLine`; a stuck round names it the same way on
    // stderr, so "stuck task/one" is never the whole story a person gets
    // (@i/10-yrd/24141 AC2).
    for (const line of stuckCureLines(outcome)) io.stderr(`yrd: ${line}\n`)
    return outcome
  }

  switch (request.command) {
    case "pause":
    case "resume": {
      try {
        const pause = await writePause(git, config.target.remote, config.target.branch, {
          by: request.by,
          kind: request.command === "pause" ? "paused" : "resumed",
          reason: request.command === "pause" ? request.reason : (request.reason ?? "pause lifted"),
        })
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
    case "submit": {
      const branch = request.branch ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()
      const submission = {
        branch,
        submitter: request.submitter,
        target: config.target,
        ...(request.issue === undefined ? {} : { issue: request.issue }),
        ...(request.rebase === true ? { rebase: true } : {}),
      }
      try {
        if (request.dryRun === true) {
          const inspected = await inspectSubmit(git, config.target.remote, submission)
          const { head, targetHead, rebaseRequired } = inspected
          const issue = inspected.issue
          emit(
            io,
            options.json,
            {
              ...(rebaseRequired
                ? { branch, headBeforeRebase: head, rebaseRequired }
                : { change: changeName({ branch, head }) }),
              dryRun: true,
              submitter: request.submitter,
              target: targetName(config.target),
              targetHead,
              freshness: freshnessLine(targetHead),
              ...issueOutput(io, branch, issue),
            },
            (rebaseRequired
              ? `would rebase ${branch} at ${head} onto ${targetHead}, then open its new head (unknown until rebase)`
              : `would open ${changeName({ branch, head })} on ${targetName(config.target)} for ${request.submitter}`) +
              `${issue === undefined ? "" : ` (issue ${issue.issue})`}; nothing was pushed; ${freshnessLine(targetHead)}`,
          )
          return 0
        }
        const submitted = await submit(git, config.target.remote, submission)
        emit(
          io,
          options.json,
          { ...submitted, ...issueOutput(io, branch, submitted.issue) },
          `${submitted.retry ? "retried" : "submitted"} ${branch} at ${submitted.head.slice(0, 12)} to ${targetName(config.target)}; ${freshnessLine(submitted.targetHead)}` +
            // 24454: a moved gitlink's commit went to its submodule remote first; say where.
            submitted.published
              .map((row) => `\n${row.state} ${row.path}@${row.sha.slice(0, 12)} at ${row.remote} ${row.ref}`)
              .join(""),
        )
        return 0
      } catch (error) {
        if (error instanceof QueuePaused) {
          io.stderr(`yrd: ${error.message}\n`)
          return 1
        }
        throw error
      }
    }
    case "run": {
      // One round, exactly `up`'s own (0 pass, 1 fail, 2 stuck): `outcome.exitCode`
      // already carries that ladder, so forwarding it verbatim is the whole of
      // the contract — a round a stuck change stopped, doing no other work,
      // ends 2 here exactly as it ends `up`'s loop (run.ts's on-submit and
      // on-merge steps set `exitCode: 2` the moment anything comes back stuck,
      // never 0). A run that could not even judge is `undefined` here, and
      // `?? 2` is that same stuck, already said by `stuck()` above
      // (@i/10-yrd/24141 AC1).
      const outcome = await oneRound(captured)
      return isRoundStuck(outcome) ? 2 : outcome.exitCode
    }
    case "up": {
      // The service: the same round on a loop, what hab runs. It has ONE
      // permanent exit, 2, and as of @i/10-yrd/24395 it is reserved for what NO
      // round can fix: the target's declaration can no longer be read or is no
      // longer there at all, or the runtime gitlink is absent. A STUCK ROUND is
      // not one of those — the round ends, the loop sleeps and runs the next
      // one, and the alarm is carried by the health document instead of by the
      // process ending. Everything else it does on purpose — an explicit
      // AbortSignal stop request or a gitlink moving under it — exits 0, which is
      // on Hab's relaunch allowlist. A process signal bypasses this return path and
      // stays terminal under the service's `restart: "on-codes"` declaration.
      const interval = (request.intervalSeconds ?? 15) * 1000
      // Read through a call each time: the signal flips while the loop runs.
      const stopped = (): boolean => request.stop?.aborted === true
      /**
       * Consecutive same-reason stuck rounds, carried across the loop.
       *
       * `undefined` is healthy. It lives out here rather than inside the round
       * because the whole value of the ladder is that it remembers: a stuck
       * reason that survives a retry is a different fact from one that does not.
       */
      let streak: StuckStreak | undefined
      /**
       * Leave the document where the declared health probe reads it.
       *
       * Best-effort ON PURPOSE, and this is the one place in this change where
       * that is the right call: a filesystem that cannot take the document must
       * not end the delivery service, which is the exact failure mode being
       * removed. It is not silent — the failure is logged and named — and the
       * probe reports `unknown` rather than inventing a state, so a document
       * that stopped being written is visible as itself.
       */
      const writeHealth = (document: QueueHealthDocument): void => {
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
          writeFileSync(staging, `${JSON.stringify(document, undefined, 2)}\n`)
          renameSync(staging, path)
        } catch (error) {
          log?.warn?.(
            `could not write the service health document to ${join(workdir, QUEUE_HEALTH_DOCUMENT)}: ${
              error instanceof Error ? error.message : String(error)
            }; the declared health probe will report unknown until the next round writes one`,
          )
        }
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
            const alive = roundHealthDocument(SERVICE, {}, undefined, waitCapMs, new Date())
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
            // than a tombstone. The stuck KEY is stable — the path, never the sha
            // — or the ladder would restart its backoff every time the target
            // moves, which is exactly when it should be climbing.
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
      let current = captured
      for (let round = 1; ; round += 1) {
        // The declaration again, as the target holds it now: a correct edit at
        // the target is the next round's, never a restart's.
        if (round > 1) {
          let why: string | undefined
          try {
            const next = await declaration()
            if (next === undefined) why = `${targetLabel} no longer carries a .yrd.yml`
            else current = next
          } catch (error) {
            why = `the target's declaration cannot be read: ${error instanceof Error ? error.message : String(error)}`
          }
          if (why !== undefined) return stuck(why)
        }
        const before = await reload(current.oid)
        if (before !== undefined) return before
        const outcome = await oneRound(current)

        // STUCK IS A ROUND OUTCOME, NOT A PROCESS OUTCOME (@cto 2026-09-11,
        // @i/10-yrd/24395). This used to `return 2`, which made the alarm and
        // the stop one event: a routine, recoverable, submitter-independent
        // fault took the only fleet delivery mechanism offline with automatic
        // restart disabled. Measured: a code-host 504 during setup cost about
        // 24 minutes of delivery for a fault the next round cleared.
        //
        // The round ends; the loop does not. The alarm moves to the health
        // document written below, which the supervisor already turns into a
        // page it drops again on its own when a round comes back clear.
        const facts = roundFacts(outcome)
        streak = nextStuckStreak(streak, facts)
        // A streak exists exactly when the round was stuck, because `roundFacts`
        // names a reason for every stuck round and `nextStuckStreak` keeps one
        // for every reason. The third branch is that invariant stated rather
        // than a fallback: a silent `interval` there would turn a broken
        // invariant into a service that merely sleeps oddly.
        let sleepMs: number
        if (streak !== undefined) sleepMs = stuckBackoffMs(streak.consecutive, interval)
        else if (!isRoundStuck(outcome)) sleepMs = sleepAfter(outcome, interval)
        else throw new Error(`a stuck round left no streak to space it out: ${outcome.why}`)
        const base = roundHealthDocument(SERVICE, facts, streak, sleepMs, new Date())
        // The disarmed exit, carried where a reader already looks. A warning is
        // read once, at the moment nobody is watching; a fact in the health
        // document is read every time anyone asks how this service is.
        const document = identified.kind === "off" ? { ...base, facts: { ...base.facts, ...relaunchOff } } : base
        writeHealth(document)
        await request.afterHealth?.(document)
        if (stopped()) return 0

        if (!isRoundStuck(outcome)) {
          await request.afterRound?.(outcome)
          // The gitlink, at the target as this round left it: the round that merged
          // the change moving this yrd's own gitlink is the last one this code runs.
          const after = await reload(outcome.target)
          if (after !== undefined) return after
        }
        if (stopped()) return 0
        await new Promise((resolve) => {
          setTimeout(resolve, sleepMs)
        })
        if (stopped()) return 0
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
      ): Promise<
        Readonly<{
          rows: readonly WatchRow[]
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
          entries: QueueEntries
          journals: Journals
        }>
      > => {
        const { queue, journals, all, observation } = await readListing(git, declared.config, workdir, declared.oid)
        if (options.json !== true) narrateMalformed(io, journals, said)
        const rows = filterRows(
          watchRows(all, { journals, ...(request.latest === true ? { latest: true } : {}) }),
          request.terms ?? [],
        )
        const pause = queue.pause?.kind === "paused" ? queue.pause : undefined
        // What was queried, where it looked, and what it left out — said on the
        // screen, not left for the reader to infer from an empty table. Zero
        // rows also names the fields the term was checked against, so a state
        // name that found nothing is told it WAS considered, not skipped —
        // the same message on `--json` as on the page (AC1,
        // a-state-name-filters-to-zero-rows-and-exit-zero).
        const scope =
          request.terms === undefined || request.terms.length === 0
            ? undefined
            : `${String(rows.length)} of ${String(all.length)} change(s) match ${request.terms.join(" or ")}` +
              (rows.length === 0 ? `. Checked ${FILTER_FIELDS}.` : "")
        return {
          observation,
          data: {
            observation,
            changes: rows.map((row) => row.row),
            journal: journalFact(journals),
            pause: pause ?? null,
            ...(scope === undefined ? {} : { scope }),
          },
          entries: queue.changes,
          journals,
          queue: queueName(config.target, await remoteUrl(git, config.target.remote)),
          // Pre-M8 a repository has exactly one queue: the target's branch, on
          // this repository. M8 turns this list of one into N.
          queues: [{ branch: config.target.branch, label: config.target.branch, path: repo }],
          runner: readRunnerFacts(workdir),
          // Every row, per run, whatever the filter and the lens: the box counts the queue, not the view.
          decisions: decisionsOfRows(watchRows(all, { journals })),
          ...(pause === undefined ? {} : { pause: pauseLine(pause) }),
          ...(journals.absent === undefined ? {} : { journalAbsent: journals.absent }),
          ...(scope === undefined ? {} : { scope }),
          rows,
        }
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
        const listing = await printListing(snapshotOf(one), {
          color: io.color === true,
          columns: io.columns ?? 120,
          ...(one.scope === undefined ? {} : { scope: one.scope }),
          ...(single === undefined
            ? {}
            : {
                trailer: [noticeLine(single.row, single.run !== undefined), clocksLine(single.row)].filter(
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
        if (request.requireMatch === true && selectedNothing(request.terms, one.rows)) return 1
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
        if (selectedNothing(request.terms, first.rows)) {
          io.stderr(missedSelector(request.terms ?? [], first.queue, first.rows.length))
          return 2
        }
        const { WatchPane } = await import("./watch-pane.tsx")
        const { run } = await import("silvery/runtime")
        const { createElement } = await import("react")
        const { WATCH_RUN_OPTIONS } = await import("./watch-run-options.ts")
        let ending: YrdCliExitCode | undefined
        // The queue read the LAST round made: a detail opened between rounds
        // reads the same tips the table shows, never a fresher or staler one.
        let entries: QueueEntries = first.entries
        let journals = first.journals
        const app = await run(
          createElement(WatchPane, {
            intervalMs: Math.max(1, request.intervalSeconds ?? 5) * 1000,
            load: async () => {
              const refreshed = await declaration()
              if (refreshed === undefined) throw new Error(`${targetLabel} no longer carries a .yrd.yml`)
              const next = await round(refreshed)
              if (next.observation.contract === "root-v1" && next.observation.outcome === "invalid") {
                ending = 2
                app.unmount()
                io.stderr(`${next.observation.message}\n`)
              }
              entries = next.entries
              journals = next.journals
              return snapshotOf(next)
            },
            loadDiff: (item) => readDiff(git, config, item),
            open: (item) => openDetail(git, config, entries, item, config.target.branch, journalFor(item, journals)),
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
        if (first && selectedNothing(request.terms, one.rows)) {
          io.stderr(missedSelector(request.terms ?? [], one.queue, one.rows.length))
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
          const ending = endingCode(one.rows)
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
      const run = runId()
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
      const prepared = await prepareWorktree(git, repo, head, join(worktrees, "check", head.slice(0, 12)), {
        env: options.env,
        populateReference: options.populateReference,
        selection,
        gitOptions: { env: options.env },
        plumbing: options.log?.child("worktree"),
        ...(config.setup === undefined ? {} : { setup: { logDir, run: config.setup, tmpdir: join(workdir, "tmp") } }),
        targetSha: captured.oid,
      })
      const results: CheckResult[] = []
      try {
        for (const spec of specs) {
          const result = await runCheck({
            cwd: prepared.path,
            env: options.env,
            logDir,
            spec,
            tmpdir: join(workdir, "tmp"),
            tree: prepared.tree,
          })
          results.push(result)
          if (result.result !== "pass") break
        }
      } finally {
        await prepared.remove()
        rmSync(worktrees, { force: true, recursive: true })
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
      const { journals, all } = await readListing(git, config, workdir, captured.oid)
      // The counts below are read from the same rows; a row the journal could
      // not be read for must not make an understated stat look measured.
      if (options.json !== true) narrateMalformed(io, journals, new Set())
      const rows = watchRows(all, { journals })
      const refs = await pushedRefs(git, config.target.remote, config.target.branch)
      const stats = queueStats(rows, refs, {
        now,
        ...window,
        ...(request.by === undefined ? {} : { by: request.by }),
      })
      const name = queueName(config.target, await remoteUrl(git, config.target.remote))
      emit(io, options.json, { queue: name, ...stats }, formatQueueStats(stats, name))
      return 0
    }
    case "show": {
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
      emit(
        io,
        options.json,
        {
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
            })),
          })),
          journal: journalFact(journals),
        },
        changes.length === 0
          ? `no change for ${request.branch}`
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
      // Two rows per check: `ms` is the end row's, and its absence is the
      // start row, the one that says a long check is running rather than hung.
      return rest.ms === undefined
        ? `${String(rest.name)} started for ${where}`
        : `${String(rest.name)} ran for ${where} in ${String(rest.ms)} ms`
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
    outcome.merged.length > 0 ? `merged ${outcome.merged.join(", ")}` : undefined,
    outcome.failed.length > 0 ? `failed ${outcome.failed.join(", ")}` : undefined,
    outcome.stuck.length > 0 ? `stuck ${outcome.stuck.join(", ")}` : undefined,
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
 * short interval stays a short interval.
 */
/** A round that could not judge at all, carrying why. */
export type RoundStuck = Readonly<{ why: string }>

export function isRoundStuck(outcome: QueueRunOutcome | RoundStuck): outcome is RoundStuck {
  return "why" in outcome
}

/**
 * What a finished round tells the loop's health: whether it was stuck, and
 * what it saw in the line.
 *
 * The fingerprint is every change the round touched plus how many it left
 * checked and waiting. It answers exactly one question — did new work arrive
 * since the last stuck round — so it is deliberately absent, never empty, when
 * the round never got far enough to read the line. An empty fingerprint would
 * compare equal to another empty one and claim the line had not moved, on
 * exactly the rounds that know nothing about the line at all.
 */
export function roundFacts(outcome: QueueRunOutcome | RoundStuck): RoundFacts {
  // EVERY `key` BELOW IS STABLE ACROSS ROUNDS and every `reason` is free to
  // name this round's specifics. The first version used one string for both,
  // and two of these embed something that changes every round — the run id and
  // a raw error message — so the ladder started over each time and never
  // climbed for the two faults most likely to repeat (@cto 2026-09-11).
  if (isRoundStuck(outcome)) return { stuck: { key: "could-not-judge", reason: outcome.why } }
  const fingerprint = `${[...outcome.merged, ...outcome.failed, ...outcome.stuck]
    .slice()
    .sort()
    .join(" ")}+${String(outcome.checkedWaiting)}`
  if (outcome.exitCode !== 2) return { fingerprint }
  // The branch names ARE stable while the same change stays stuck, which is
  // exactly the case the ladder is for; the run id is not, and stays in prose.
  const stuck =
    outcome.stuck.length > 0
      ? {
          key: `stuck-changes:${[...outcome.stuck].sort().join(",")}`,
          reason: `the round stopped on ${outcome.stuck.join(", ")}`,
        }
      : {
          key: "stuck-unnamed",
          reason: `the round ended stuck without naming a change (run ${outcome.run})`,
        }
  return { stuck, fingerprint }
}

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
  const packed = shown.flatMap((change) => change.checks)
  const records = shown.flatMap((change) => change.records)
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
    queue: string
    queues: readonly WatchQueue[]
    pause?: string
    journalAbsent?: string
    observation: GitObservation
    runner: RunnerFacts
    decisions: readonly RunDecision[]
  }>,
): WatchSnapshot {
  return {
    at: new Date(),
    observation: round.observation,
    decisions: round.decisions,
    queue: round.queue,
    queues: round.queues,
    rows: round.rows,
    runner: round.runner,
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

/**
 * The code a watched set of changes ended with, or undefined while any of them
 * is still in line. It is `yrd check`'s own ladder — stuck beats failed beats
 * merged — because a watch is the same question asked over time, and the two
 * answering differently for one change is the whole failure this mirrors.
 */
function endingCode(rows: readonly WatchRow[]): YrdCliExitCode | undefined {
  const states = rows.map((row) => row.row.state)
  if (states.some((state) => state === "queued" || state === "checked")) return undefined
  if (states.some((state) => state === "stuck")) return 2
  if (states.some((state) => state === "failed")) return 1
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

/**
 * One reading of the queue as the list, the watch and the stats consume it:
 * the change refs at the remote, the run journal on THIS machine, the direct
 * commits on the target (E5) and the head subjects, in one batched read. A
 * machine that runs no queue has no journal, and `journals.absent` is the
 * sentence that says so rather than a row that reads as if nothing were
 * running. Nothing here derives a state: `list()` does, once, for everyone.
 */
export async function readListing(
  git: GitRunner,
  config: QueueConfig,
  workdir: string,
  targetOid: string,
): Promise<
  Readonly<{
    queue: Awaited<ReturnType<typeof readQueue>>
    journals: Journals
    all: readonly Row[]
    observation: GitObservation
  }>
> {
  const queue = await readQueue(git, config.target.remote, config.target.branch, targetOid)
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
  const all = list(queue.changes, {
    directMerges: await directMergeCommits(git, config.target.branch, targetOid, queue.changes),
    journals,
    subjects: await subjects(
      git,
      queue.changes.map((entry) => entry.change.head),
    ),
  })
  return { all, journals, queue, observation }
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

/**
 * Every branch at the remote but the target, with whether a change ref names it
 * (plan E2: a push without a submit is not a change) and the tip's committer
 * instant when the commit is here — the queue read fetches the submitted heads
 * and the target, never the rest, so an unsubmitted tip is dated only when
 * some earlier fetch brought it, and the stats say how many it could not date.
 * One `ls-remote`, the same list the queue read itself starts from.
 */
async function pushedRefs(git: Git, remote: string, target: string): Promise<readonly PushedRef[]> {
  const listed = (await git(["ls-remote", "--refs", remote])).split("\n")
  const heads = new Map<string, string>()
  const submitted = new Set<string>()
  for (const line of listed) {
    const [sha, ref] = line.trim().split(/\s+/u)
    if (sha === undefined || ref === undefined) continue
    if (ref.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), sha)
    else if (ref.startsWith(`${queueRefPrefix(target)}/`)) {
      const name = ref.slice(`${queueRefPrefix(target)}/`.length)
      const at = name.lastIndexOf("@")
      submitted.add(at === -1 ? name : name.slice(0, at))
    }
  }
  heads.delete(target)
  // The committer instants of the tips this repository has, in one batched
  // read; a sha git does not have answers `missing` and stays undated.
  const dated = new Map<string, Date>()
  const shas = [...new Set(heads.values())]
  if (shas.length > 0) {
    const answer = await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${shas.join("\n")}\n`)
    const present = answer
      .split("\n")
      .map((line) => line.trim().split(" "))
      .filter((parts) => parts[1] === "commit")
      .map((parts) => parts[0] ?? "")
    if (present.length > 0) {
      const stamps = await git(["log", "--no-walk=unsorted", "--format=%H %ct", ...present, "--"])
      for (const line of stamps.split("\n")) {
        const [sha, seconds] = line.trim().split(" ")
        if (sha !== undefined && seconds !== undefined && seconds !== "") {
          dated.set(sha, new Date(Number(seconds) * 1000))
        }
      }
    }
  }
  return [...heads.entries()].map(([branch, head]) => {
    const committedAt = dated.get(head)
    return { branch, head, submitted: submitted.has(branch), ...(committedAt === undefined ? {} : { committedAt }) }
  })
}

function emit(io: YrdCliIO, json: boolean | undefined, data: unknown, human: string): void {
  if (json === true) io.stdout(`${JSON.stringify(data)}\n`)
  else io.stdout(`${human}\n`)
}
