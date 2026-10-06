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

import {
  existsSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { tryAcquireFlock, type FlockHandle } from "@bearly/flock"
import type { ConditionalLogger } from "loggily"
import { adaptProcessGit, createProcess, gitFailure, processStartIdentity } from "@yrd/process"
import { issueResolver } from "./issue-resolver.ts"
import { runAdmission } from "./admission.ts"
import {
  CHANGE_REF_DIAGNOSTICS,
  assertPlainEventQueueConfig,
  changeName,
  checksOf,
  claimWorktrees,
  directMergeLine,
  drop,
  pauseLine,
  eventDirectMergeCommits,
  eventListRows,
  eventRows,
  enumerateChangeSegments,
  isOpen,
  createEventStore,
  createLocalEventStore,
  selectionFor,
  listRefs,
  queueFormat,
  queueRef,
  queueRefPrefix,
  parseChangeRef,
  changesRef,
  readChangeEvents,
  readEventQueue,
  readEventOps,
  readEventQueueWithChanges,
  setBranchIgnored,
  writeQueueEvent,
  writeQueueOverride,
  prepareWorktree,
  checkedTree,
  programRootCheck,
  openLog,
  gitIn,
  incidentLine,
  journalKey,
  queueName,
  resolveGitSelection,
  queueRun,
  LegacyOverridePresent,
  QueueAuthorityUnreadable,
  QueueRunEventRetryExhausted,
  readConfig,
  readJournals,
  readRunLog,
  remoteUrl,
  subjects,
  targetName,
  runCheck,
  DEFAULT_CHECK_BOUND_MS,
  effectiveCheckTimeoutMs,
  STEP_BOUNDS_MS,
  STEP_STATES,
  roundBoundMs,
  inspectSubmit,
  prepareSubmit,
  inspectSubmitAtHead,
  preparePinCarrier,
  freshnessLine,
  readRemoteCommit,
  refreshMirror,
  invalidateMirrorStamp,
  refAt,
  readDrafts,
  submit,
  withdraw,
  NothingToWithdraw,
  sweepCandidateRefs,
  sweepCheckRefs,
  liftLine,
  OverrideRefused,
  overrideFacts,
  overrideLine,
  parseUntil,
  type OverrideFact,
  type OverrideEntry,
  type QueueReadStore,
  type OverrideTable,
  type PinCarrierPin,
  notifyOutsideRound,
  dispatchNotifications,
  overrideNotice,
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  QUEUE_HEALTH_DOCUMENT,
  ROUND_BUDGET_MS,
  ROUND_LOCK,
  relaunchStalledHealthDocument,
  roundHealthDocument,
  withLineFlow,
  type FlowReading,
  type LineFlow,
  gracefulStopHealthDocument,
  exitedHealthDocument,
  writtenHealthDocument,
  runtimeGitlinkPath,
  stopFact,
  QueuePaused,
  QueueNotPaused,
  type CheckResult,
  type CheckSpec,
  type CheckView,
  type Journals,
  type JournalRun,
  type Git,
  type IssueResolution,
  type AdmissionOutcome,
  type Submitted,
  type GitRunner,
  type GitObservation,
  type GitSelection,
  type HealthWriter,
  type Incident,
  type LogRecord,
  type QueueConfig,
  type QueueHealthDocument,
  type ServiceExitFact,
  type ServiceIntentFact,
  type QueueRunOutcome,
  type RunnerClaim,
  type RoundLine,
  type PauseRecord,
  type RuntimeGitlinkOff,
  type Change,
  type EventChange,
  type Event,
  type EventQueue,
  type DraftReading,
  type JournalCommand,
  type Row,
  type StopFact,
  remoteCallsLine,
  roundRemoteCallsRow,
  traceRemoteCalls,
  withRemoteSeam,
  lookupRunIndex,
  runIndexRef,
  runIndexPath,
  RUN_INDEX_CODES,
  type SubmitGitlink,
} from "@yrd/queue-core"
import { formatQueueAddress, formatStoredQueueAddress, parseQueueAddress, parseRunAddress } from "./address.ts"
import { readUnitIntent } from "./unit-intent.ts"
import { noticeLine } from "./watch-notice.ts"
import { FILTER_FIELDS, eventNoticeLines, filterRows, rowLine, watchRows, type WatchRow } from "./watch-rows.ts"
import type { ChangeDetail, CheckPanel, DiffText } from "./watch-detail.tsx"

import type { DraftWindow, WatchQueue } from "./watch-list.tsx"
import type { WatchSnapshot, WatchSource } from "./watch-pane.tsx"
import { runOf } from "./watch-run.ts"
import { stripAnsi } from "@silvery/ansi"
import { STATE_WORDS, clock, diagnosticLines, firstLine, mediaDuration, timingLine } from "./watch-format.ts"
import { readRunnerFacts, readRunnerService, type RunnerFacts } from "./watch-runner.ts"
import { runnerOf } from "./watch-runner-reading.ts"
import { readPublishedRunner, RunnerPublisher } from "./runner-publication.ts"
import { decisionsOfRows, type RunDecision } from "./watch-stats.ts"
import {
  DEFAULT_WINDOW_MS,
  formatQueueStats,
  parseSince,
  queueStats,
  type SinceOrigin,
  type StatsBy,
} from "./queue-stats.ts"
import { formatQueueLs, queueLs, filterLsRows, LS_FILTER_FIELDS } from "./queue-ls.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"
import { SERVICE } from "./queue-health.ts"

const START_SERVICE_COMMAND = `hab up ${SERVICE}`
const CHECK_SERVICE_COMMAND = `hab ps ${SERVICE}`

import { queueTempRoot, workdirOf } from "./workdir.ts"
import { originHead } from "./queue-location.ts"

function issueOutput(io: YrdCliIO, branch: string, resolution: IssueResolution | undefined) {
  if (resolution === undefined) {
    io.stderr(`yrd: WARNING: ${branch} has no issue link; no explicit issue binding was found\n`)
    return {}
  }
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

/** The termination signal a running service answers with its last document (25430). */
export type TerminatePort = Readonly<{
  /** Call `handler` with the termination signal; answers the unsubscribe. */
  on: (handler: (signal?: NodeJS.Signals) => void) => () => void
  /** End the process as the signal would have, after the handler ran. */
  reraise: (signal?: NodeJS.Signals) => void
}>

const processTerminate: TerminatePort = {
  on: (handler) => {
    const signals = ["SIGTERM", "SIGHUP", "SIGINT"] as const
    const listeners = signals.map((signal) => ({ signal, listener: () => handler(signal) }))
    for (const { signal, listener } of listeners) process.on(signal, listener)
    return () => {
      for (const { signal, listener } of listeners) process.off(signal, listener)
    }
  },
  // Re-raised with no listener left, so the process dies OF the signal exactly
  // as before: the service's `restart: "on-codes"` keeps a signal terminal.
  reraise: (signal = "SIGTERM") => {
    process.kill(process.pid, signal)
  },
}

export type CoreQueueCommand =
  | Readonly<{
      command: "submit"
      branch?: string
      submitter: string
      issue?: string
      dryRun?: boolean
      prepare?: boolean
      pins?: readonly PinCarrierPin[]
    }>
  | Readonly<{ command: "pause"; by: string; reason: string; cause?: "operator" | "maintenance" }>
  | Readonly<{ command: "resume"; by: string; reason?: string }>
  | Readonly<{
      command: "override"
      action: "off" | "clear" | "list"
      check?: string
      until?: string
      reason?: string
      by: string
      verified: boolean
    }>
  | Readonly<{ command: "withdraw"; branch: string; by: string; reason?: string; recipient?: string }>
  | Readonly<{ command: "drop"; branch: string; by: string; reason?: string; recipient?: string }>
  | Readonly<{ command: "ignore"; branch: string; by: string; reason: string }>
  | Readonly<{ command: "unignore"; branch: string; by: string }>
  | Readonly<{ command: "run"; tier?: "normal" | "long"; stopAtMs?: number }>
  | Readonly<{
      command: "sweep-candidates"
      remote?: string
      dryRun?: boolean
      batchSize?: number
    }>
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
      noCheck?: boolean
    }>
  | Readonly<{
      command: "up"
      intervalSeconds?: number
      stop?: AbortSignal
      /** Process start time override for test witnesses (25502). Defaults to performance.timeOrigin. */
      startedAt?: string | Date
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
      /**
       * The process's termination signal, as a port (25430). Defaults to this
       * process's SIGTERM and a re-raise of it; a test supplies its own, since
       * a real SIGTERM would end the test runner.
       */
      terminate?: TerminatePort
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
      /** Show ended event segments beyond the default seven-day window. */
      all?: boolean
      /** Include unsubmitted branch heads on event queues. */
      drafts?: boolean
    }>
  | Readonly<{ command: "show"; branch?: string; all?: boolean }>
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
  | Readonly<{
      command: "ls"
      terms?: readonly string[]
      now?: Date
      requireMatch?: boolean
    }>

/** What each command is called when it has to say it needs a queue. */
const NAMED: Readonly<Record<CoreQueueCommand["command"], string>> = {
  check: "check",
  drop: "drop",
  ignore: "ignore",
  ls: "queue ls",
  pause: "queue pause",
  list: "queue list",
  merge: "merge",
  override: "queue override",
  run: "queue run",
  show: "queue show",
  stats: "queue stats",
  submit: "submit",
  unignore: "unignore",
  resume: "queue resume",
  "sweep-candidates": "queue sweep-candidates",
  up: "queue up",
  withdraw: "queue withdraw",
}

/**
 * The environment a command's Git reads, and, for a submit that pushes, its remote-call count said on stderr
 * when disposed (25570 row 3); the trace directory goes with it. Any other command gets `env` back untouched.
 */
function submitCalls(
  request: CoreQueueCommand,
  env: NodeJS.ProcessEnv | undefined,
  io: YrdCliIO,
): Readonly<{ env: NodeJS.ProcessEnv | undefined }> & Disposable {
  if (request.command !== "submit" || request.dryRun === true) return { env, [Symbol.dispose]: () => undefined }
  const directory = mkdtempSync(join(tmpdir(), "yrd-submit-trace2-"))
  const traced = traceRemoteCalls(directory, { seams: true, refresh: true })
  return {
    env: env === undefined ? undefined : { ...env, ...traced.env },
    [Symbol.dispose]() {
      try {
        const calls = traced.end()
        io.stderr(`yrd: submit remote calls: ${remoteCallsLine(calls)}\n`)
        io.stderr(`yrd: submit remote call detail: ${JSON.stringify(roundRemoteCallsRow(calls))}\n`)
      } catch (error) {
        io.stderr(`yrd: submit remote calls unknown: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    },
  }
}

/** Classify only the established index reader's result; remote errors remain failed reads. */
async function readRunIndexPrecondition(
  store: Parameters<typeof lookupRunIndex>[0],
  queue: string,
): Promise<Readonly<{ kind: "ready" }> | Readonly<{ kind: "missing" | "corrupt" | "failed-read"; message: string }>> {
  try {
    await lookupRunIndex(store, queue, 1)
    return { kind: "ready" }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith(`${RUN_INDEX_CODES.missing}:`)) return { kind: "missing", message }
    if (message.startsWith(`${RUN_INDEX_CODES.corrupt}:`)) return { kind: "corrupt", message }
    return { kind: "failed-read", message }
  }
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
    /** Hand the existing interactive reader to a pane composing several queues. */
    watchSource?: (source: WatchSource) => void
    /** One-shot list/show opt-in: an existing queue-owned clone, never a writer's authority. */
    localStatusStore?: Readonly<{ path: string; transport: string }>
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
  // A SUBMIT SAYS WHAT IT COST (25570 row 3): every git process from here on, this command's own, Gitomic's and
  // each moved submodule's, writes git's trace2 log, and one stderr line counts the remote calls and ssh logins
  // when the command ends, however it ends. Traced before the first Git below is built, which is when it reads
  // its environment. A dry run pushes nothing and is not counted.
  using traced = submitCalls(request, options.env, io)
  const env = traced.env
  if (options.localStatusStore !== undefined) {
    if (request.command !== "list" && request.command !== "show" && request.command !== "ls") {
      throw new Error("the local queue status store is only for list/show/ls")
    }
    if (!existsSync(options.localStatusStore.path)) {
      throw new Error(`queue status store ${options.localStatusStore.path} is absent`)
    }
    repo = options.localStatusStore.path
  }
  const selection = options.selection ?? (await resolveGitSelection(repo, { env }))
  const git = gitIn(repo, undefined, selection, { env })
  const log = options.log?.child("queue")
  const remote = options.remote ?? "origin"
  const queue = options.queue ?? (await withRemoteSeam("originHead", () => originHead(git)))
  const target = { branch: queue, remote }
  const targetLabel = `${remote}/${queue}`
  const localStatus = options.localStatusStore
  let statusAsOf: string | undefined
  if (localStatus !== undefined) {
    const actual = await remoteUrl(git, remote)
    if (actual !== localStatus.transport) {
      throw new Error(`queue status store ${repo} has ${remote} ${actual}, expected ${localStatus.transport}`)
    }
    // The event prefix and all heads include the target, every chain and every draft.
    // A 60 s window is below ADR-0022's 120 s age disclosure, matches watch's
    // process cache, and is shorter than the measured queue round cadence.
    const refspecs = [
      `+refs/heads/${queue}:refs/heads/${queue}`,
      `+${queueRefPrefix(queue)}/*:${queueRefPrefix(queue)}/*`,
      "+refs/heads/*:refs/heads/*",
    ]
    const refreshed = await refreshMirror({
      path: repo,
      url: actual,
      gitIn: (cwd) => gitIn(cwd, undefined, selection, { env }),
      refspecs,
      maxAgeMs: 60_000,
    })
    statusAsOf = refreshed.refreshedAt.toISOString()
  }
  const statusSource = localStatus === undefined ? "remote" : "local"
  const statusFact = () => ({ source: statusSource, asOf: statusAsOf ?? new Date().toISOString() })
  const statusLine = (): string => {
    const { asOf } = statusFact()
    const ageMs = Date.now() - Date.parse(asOf)
    return `Source: ${statusSource}; as of ${asOf}${ageMs < 120_000 ? "" : ` (${Math.floor(ageMs / 1000)}s old)`}.`
  }
  const statusEventStore = (eventRemote: string): QueueReadStore =>
    localStatus === undefined ? createEventStore(repo, eventRemote, selection) : createLocalEventStore(repo, selection)
  const refuseMissingEventMarker = async (eventRemote: string, name: string): Promise<never> => {
    const prefix = queueRefPrefix(name)
    const refs = await listRefs(`${prefix}/`, statusEventStore(eventRemote))
    if (refs.size === 0) {
      throw new Error(`no queue exists at ${prefix}/ in queue status store ${repo}: observed no refs under that prefix`)
    }
    const legacy = [...refs.keys()].find((ref) => parseChangeRef(name, ref) !== undefined)
    const observed =
      legacy === undefined
        ? `no event marker ${queueRef(name)} and no legacy change ref under ${prefix}/`
        : `no event marker ${queueRef(name)}; observed legacy change ref ${legacy}`
    throw new Error(`queue status store ${repo} has ${observed}; use --fresh for this reading`)
  }
  type CapturedDeclaration = Readonly<{ config: QueueConfig; oid: string }>
  // The commands that EXECUTE the target's declaration read it strictly: a key they
  // cannot read is a step they would skip. Every other command only addresses the
  // queue — submit, list, show, ls, stats, withdraw, drop, pause, resume, ignore,
  // unignore, override, sweep-candidates — and tolerates a key newer than its own
  // parser, out loud (27187; the `derive:` landing of 2026-10-02 refused every
  // older environment's submit).
  const RUNS_THE_DECLARATION: ReadonlySet<CoreQueueCommand["command"]> = new Set<CoreQueueCommand["command"]>([
    "up",
    "run",
    "merge",
    "check",
  ])
  // The target's declaration as the target holds it now: fetched, read in full
  // and held to its keys, then the remote it names resolved. Undefined when the
  // target carries no `.yrd.yml` at all — there is no queue there; a
  // declaration that exists and cannot be read throws. One reading serves a
  // one-shot command; the service reads again before every round, so an edit at
  // the target takes effect on the next round.
  const declaration = async (): Promise<CapturedDeclaration | undefined> => {
    const oid =
      localStatus === undefined
        ? await readRemoteCommit(git, remote, `refs/heads/${queue}`)
        : await refAt(git, `refs/heads/${queue}`)
    if (oid === undefined) throw new Error(`the target ${targetLabel} is not at ${remote}`)
    let declared: QueueConfig | undefined
    try {
      declared = await readConfig(
        git,
        oid,
        target,
        RUNS_THE_DECLARATION.has(request.command)
          ? {}
          : {
              newerKeys: (keys) => {
                const one = keys.length === 1
                io.stderr(
                  `yrd: the declaration at ${targetLabel} has ${one ? "a key" : "keys"} this environment's Yrd does not know: ` +
                    `${keys.map((key) => `${key}:`).join(", ")}. The queue runs ${one ? "it" : "them"}; ${NAMED[request.command]} does not, ` +
                    `so it proceeds without ${one ? "it" : "them"}. Update this environment's Yrd to the one the target pins to silence this.\n`,
                )
              },
            },
      )
    } catch (error) {
      throw new Error(
        `the declaration at ${targetLabel} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    if (declared === undefined) return undefined
    return { config: declared, oid }
  }
  const captured = await withRemoteSeam("declaration", declaration)
  if (captured === undefined) return noQueueOnTarget(targetLabel)
  const config = captured.config
  const eventStore = createEventStore(repo, config.target.remote, selection, git.backend)
  const advertisedFormat = await withRemoteSeam("queueFormat", () => queueFormat(eventStore, config.target.branch))
  switch (advertisedFormat) {
    case "legacy":
      throw new Error(
        `${config.target.remote}#${config.target.branch} uses a legacy Record ref; expected ${queueRef(config.target.branch)}`,
      )
    case "event":
    case "empty":
      break
    default: {
      const unreachable: never = advertisedFormat
      throw new Error(`${config.target.remote}#${config.target.branch} classified ${String(unreachable)}`)
    }
  }
  const resolveIssue = issueResolver(config, repo, env)
  const workdir = options.workdir ?? (await workdirOf(git))
  mkdirSync(workdir, { recursive: true })
  // One generic temp root, resolved here and carried down (27721). The queue core never re-derives it: a
  // supplied TMPDIR is adopted verbatim, and an absent one keeps today's `<workdir>/tmp`.
  const tempRoot = queueTempRoot(workdir, env ?? process.env)
  const admission = config.admission
  const admit =
    admission === undefined
      ? undefined
      : (issue: string, branch: string, head: string, targetHead: string) =>
          runAdmission(
            git,
            repo,
            workdir,
            targetHead,
            admission,
            { issue, branch, head },
            env ?? process.env,
            options.populateReference,
          )
  const invalidateStatusSnapshot = async (): Promise<void> => {
    // The queue-owned clone is the list/show reader. A remote write can leave
    // its refs and 60-second stamp behind, so its next read must fetch once.
    await invalidateMirrorStamp(join(workdir, "repo"), await remoteUrl(git, config.target.remote))
  }
  const directWriter =
    request.command === "pause" ||
    request.command === "resume" ||
    request.command === "withdraw" ||
    request.command === "drop" ||
    request.command === "ignore" ||
    request.command === "unignore" ||
    request.command === "merge" ||
    (request.command === "submit" && request.dryRun !== true) ||
    (request.command === "override" && request.action !== "list")
  await using _invalidateAfterWriter = {
    async [Symbol.asyncDispose](): Promise<void> {
      if (directWriter) await invalidateStatusSnapshot()
    },
  }

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
  type ReadFailedRound = Readonly<{ kind: "read-failed"; ref: string; error: QueueAuthorityUnreadable }>
  type RetryExhaustedRound = Readonly<{ kind: "retry-exhausted"; error: QueueRunEventRetryExhausted }>
  type LegacyOverrideRound = Readonly<{ kind: "legacy-override-present"; error: LegacyOverridePresent }>
  const oneRound = async (
    declared: CapturedDeclaration,
    only?: Change,
    tier?: "normal" | "long",
    stopAtMs?: number,
    noCheck?: boolean,
    onRecord?: (record: LogRecord) => void,
  ): Promise<QueueRunOutcome | ReadFailedRound | RetryExhaustedRound | LegacyOverrideRound | undefined> => {
    let outcome: QueueRunOutcome
    try {
      assertPlainEventQueueConfig(config, "run")
      const baseOptions = runOptions(
        repo,
        declared,
        workdir,
        tempRoot,
        selection,
        options.env,
        options.log,
        options.populateReference,
      )
      outcome = await queueRun({
        ...baseOptions,
        ...(onRecord === undefined
          ? {}
          : {
              render: (record: LogRecord) => {
                baseOptions.render(record)
                onRecord(record)
              },
            }),
        branchDeletionGraceMs:
          Math.max(1, request.command === "up" ? (request.intervalSeconds ?? 15) : 15) * 1000 + 60_000,
        foreground: request.command === "run" || request.command === "merge",
        ...(only === undefined ? {} : { only }),
        ...(tier === undefined ? {} : { tier }),
        ...(stopAtMs === undefined ? {} : { stopAtMs }),
        ...(noCheck === undefined ? {} : { noCheck }),
      })
    } catch (error) {
      if (error instanceof LegacyOverridePresent && request.command === "up") {
        return { kind: "legacy-override-present", error }
      }
      if (error instanceof QueueRunEventRetryExhausted && request.command === "up") {
        io.stderr(`yrd: ${error.message}; the service retries at its next interval\n`)
        return { kind: "retry-exhausted", error }
      }
      if (error instanceof QueueAuthorityUnreadable && error.publicationError !== undefined) {
        io.stderr(
          `yrd: round failed reading ${error.authority}: ${error.readError instanceof Error ? error.readError.message : String(error.readError)}; publication failed: ${error.publicationError instanceof Error ? error.publicationError.message : String(error.publicationError)}; the service retries at its next interval\n`,
        )
        return { kind: "read-failed", ref: error.authority, error }
      }
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
    const held = outcome.stopped?.ring === "pause" ? (outcome.stopped.what as PauseRecord) : undefined
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
  const echoAdmission = (outcome: AdmissionOutcome, dryRun = false): void => {
    if (outcome.kind === "warn") {
      io.stderr(
        `yrd: ADMISSION POLICY WARNING: ${outcome.reason}; ${dryRun ? "dry run would proceed without publishing" : "submit proceeds with a recorded change warning"}\n`,
      )
    }
    if (outcome.kind === "cannot-judge") {
      io.stderr(
        `yrd: ADMISSION CANNOT JUDGE: ${outcome.reason}; ${dryRun ? "dry run would proceed without publishing" : "submit proceeds with a recorded change warning"}\n`,
      )
    }
  }
  const echoRevertWarning = (submitted: Submitted): void => {
    const revert = submitted.revertWarning
    if (revert === undefined) return
    io.stderr(
      `yrd: REVERTED PATHS: ${revert.reason}; the compose put a target advance back (coverage ${revert.coverage}, ` +
        `${String(revert.count)} path(s)); recorded as admission-warning ${revert.event}\n`,
    )
  }
  const notifyAdmissionWarning = async (submitted: Submitted, submitter: string): Promise<void> => {
    const warning = submitted.admissionWarning
    if (warning === undefined) return
    try {
      const deliveries = await dispatchNotifications(
        {
          git,
          repo,
          targetSha: captured.oid,
          workdir,
          tempRoot,
          notify: config.notify,
          setup: config.setup,
          env: env ?? process.env,
          populateReference: options.populateReference,
        },
        "admission-warning",
        {
          record: "admission-warning",
          change: `${submitted.branch}@${submitted.head}`,
          endingId: warning.event,
          endedAt: warning.at,
          submitter,
          ...(submitted.issue === undefined ? {} : { issue: submitted.issue.issue }),
          reason: warning.reason,
        },
      )
      for (const delivery of deliveries) {
        if (delivery.delivery !== "sent") {
          io.stderr(
            `yrd: admission-warning ${warning.event} notification ${delivery.name} ${delivery.delivery}: ${delivery.failure ?? "no target notify entry declared"}\n`,
          )
        }
      }
    } catch (cause) {
      io.stderr(`yrd: admission-warning ${warning.event} notification could not run: ${String(cause)}\n`)
    }
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
      noCheck?: boolean
      onRecord?: (record: LogRecord) => void
      onTerminalDeclaration?: (detail: string) => void
      waiting?: Readonly<{
        onWait: (wait: RoundLockWait) => void
        onStall: (wait: RoundLockWait & Readonly<{ waitedMs: number }>) => void
      }>
    }> = {},
  ): Promise<
    | Readonly<{ declared: CapturedDeclaration; outcome: QueueRunOutcome }>
    | ReadFailedRound
    | RetryExhaustedRound
    | LegacyOverrideRound
    | YrdCliExitCode
  > => {
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
        const detail = `the target's declaration cannot be read: ${error instanceof Error ? error.message : String(error)}`
        round.onTerminalDeclaration?.(detail)
        return stuck(detail)
      }
      if (declared === undefined) {
        const detail = `${targetLabel} no longer carries a .yrd.yml`
        round.onTerminalDeclaration?.(detail)
        return stuck(detail)
      }
      const before = await round.before?.(declared)
      if (before !== undefined) return before
      let outcome: Awaited<ReturnType<typeof oneRound>>
      try {
        outcome = await oneRound(declared, round.only, round.tier, round.stopAtMs, round.noCheck, round.onRecord)
      } finally {
        // An otherwise empty round can still publish queue observations or
        // cleanup. Long foreground runs repeat rounds before command exit.
        if (request.command === "up" || request.command === "run" || request.command === "merge") {
          await invalidateStatusSnapshot()
        }
      }
      return outcome === undefined ? 2 : "kind" in outcome ? outcome : { declared, outcome }
    } finally {
      lock.release()
    }
  }

  /** Where one change stands now, and the stop that same reading derives. */
  const readChangeNow = async (change: Change) => {
    const target = await readRemoteCommit(git, config.target.remote, `refs/heads/${config.target.branch}`)
    if (target === undefined) throw new Error(`the target ${targetLabel} is not at ${config.target.remote}`)
    const reading = await readEventListing(git, config, repo, workdir, target, eventStore, {
      all: true,
      forceFresh: true,
    })
    const selected = reading.changes.get(change.branch)
    const row = reading.all.find((candidate) => candidate.branch === change.branch)
    const state = selected?.status ?? row?.state
    if (state === undefined) {
      throw new Error(`${changeName(change)} is not at ${targetLabel} after its round: its change ref is gone`)
    }
    const landing = state === "merged" ? (selected?.merge ?? row?.merge) : undefined
    const head = selected?.commit ?? row?.head ?? change.head
    return {
      entry: {
        change: { branch: change.branch, head },
        reading: {
          state,
          trailers: landing === undefined ? [] : [["Merge", landing] as const],
          kind: state,
          merge: landing,
        },
      },
      state,
      stop: reading.pause,
      landing,
    }
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
      case "override-moved":
        return `the queue's merge-check override moved${saw} after this round read it, so the merge was not pushed; the next round judges it under the new table`
      case undefined:
        return outcome.stopped === undefined
          ? "this round did not reach it"
          : `this round stopped before it: ${outcome.stopped.says}`
      default:
        return `this round left it there (${String(decided?.reason)})`
    }
  }

  switch (request.command) {
    case "ignore":
    case "unignore": {
      if (request.command === "unignore" && "reason" in request) {
        throw new TypeError(`yrd-ignore-reason-conflict: ${request.branch}: unignore does not accept --reason`)
      }
      const eventStore = createEventStore(repo, config.target.remote, selection)
      if ((await queueFormat(eventStore, config.target.branch)) !== "event") {
        io.stderr(`yrd: ${request.command} needs an event queue at ${config.target.remote}#${config.target.branch}\n`)
        return 1
      }
      await setBranchIgnored(eventStore, {
        queue: config.target.branch,
        branch: request.branch,
        by: request.by,
        ...(request.command === "ignore"
          ? { ignored: true as const, reason: request.reason }
          : { ignored: false as const }),
      })
      const result = {
        branch: request.branch,
        ignored: request.command === "ignore" ? { reason: request.reason, by: request.by } : null,
      }
      emit(
        io,
        options.json,
        result,
        request.command === "ignore"
          ? `ignored ${request.branch} by ${request.by}: ${request.reason}`
          : `unignored ${request.branch} by ${request.by}`,
      )
      return 0
    }
    case "drop": {
      const eventStore = createEventStore(repo, config.target.remote, selection)
      const dropped = await drop(eventStore, {
        queue: config.target.branch,
        branch: request.branch,
        by: request.by,
        ...(request.reason === undefined ? {} : { note: request.reason }),
        ...(request.recipient === undefined ? {} : { recipient: request.recipient }),
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
      const emitPauseResult = async (pause: PauseRecord): Promise<void> => {
        if (request.command === "pause") {
          emit(io, options.json, pause, pauseLine(pause))
          return
        }
        const status = await readRunnerService(workdir)
        const running =
          status.kind === "beating" ? true : status.kind === "stopped" || status.kind === "absent" ? false : null
        const health =
          status.kind === "beating"
            ? status.state
            : status.kind === "absent" || (status.kind === "stopped" && status.graceful)
              ? "absent"
              : status.kind === "unreadable"
                ? "unknown"
                : "unhealthy"
        const healthDetail =
          status.kind === "beating"
            ? status.state === "healthy"
              ? ""
              : " (unhealthy)"
            : status.kind === "absent"
              ? " (no health document)"
              : status.kind === "unreadable"
                ? " (unreadable health document)"
                : ` (${status.why})`
        const service = {
          running,
          health,
          ...(running === false ? { start: START_SERVICE_COMMAND } : {}),
          ...(running === null || (status.kind === "stopped" && !status.graceful)
            ? { check: CHECK_SERVICE_COMMAND }
            : {}),
        }
        const line =
          running === true
            ? `${SERVICE} service is running${healthDetail}`
            : running === false
              ? `${SERVICE} service is stopped${healthDetail}; run ${START_SERVICE_COMMAND}`
              : `${SERVICE} service status is unknown${healthDetail}; inspect with ${CHECK_SERVICE_COMMAND}; if stopped run ${START_SERVICE_COMMAND}`
        emit(io, options.json, { ...pause, service }, `${pauseLine(pause)}; ${line}`)
      }
      try {
        const eventStore = createEventStore(repo, config.target.remote, selection)
        const current = await readEventOps(eventStore, git, config.target.branch, captured.oid)
        const standing = current.stop
        if (request.command === "pause" && standing !== undefined) {
          throw new QueuePaused(standing, config.target.remote, config.target.branch)
        }
        if (request.command === "resume" && standing === undefined) throw new QueueNotPaused()
        const at = new Date()
        const reason = request.command === "pause" ? request.reason : (request.reason ?? "pause lifted")
        const id = await writeQueueEvent(
          eventStore,
          config.target.branch,
          request.command === "pause"
            ? { type: "paused", reason, by: request.by, at, cause: request.cause ?? "operator" }
            : { type: "resumed", reason, by: request.by, at },
        )
        const written: PauseRecord = {
          kind: request.command === "pause" ? "paused" : "resumed",
          sha: id,
          at,
          reason,
          by: request.by,
          cause: request.command === "pause" ? (request.cause ?? "operator") : "operator",
        }
        await emitPauseResult(written)
        return 0
      } catch (error) {
        if (error instanceof QueuePaused || error instanceof QueueNotPaused) {
          io.stderr(`yrd: ${error.message}\n`)
          return 1
        }
        throw error
      }
    }
    case "override": {
      const eventOps = await readEventOps(eventStore, git, config.target.branch, captured.oid)
      const now = Date.now()
      if (request.action === "list") {
        const table = eventOps.overrides
        emit(
          io,
          options.json,
          { overrides: overrideFacts(table, now), record: table.sha ?? null },
          table.entries.length === 0
            ? `no merge-check overrides on ${targetLabel}`
            : table.entries.map((entry) => overrideLine(entry, now)).join("\n"),
        )
        return 0
      }
      try {
        // The declared merge checks, read from the FETCHED target's `.yrd.yml`
        // (captured above), never a local clone's copy.
        const declaredMerge = config.checks
          .filter((spec) => (spec.on ?? ["merge"]).includes("merge"))
          .map((spec) => spec.name)
        const actor = { by: request.by, verified: request.verified }
        const write =
          request.action === "off"
            ? ({
                actor,
                check: request.check ?? "",
                kind: "off",
                reason: request.reason ?? "",
                until: parseUntil(request.until ?? "", now),
              } as const)
            : ({ actor, check: request.check ?? "", kind: "clear", reason: request.reason ?? "" } as const)
        const written = await writeQueueOverride(eventStore, config.target.branch, write, declaredMerge, new Date(now))
        const standing = written.record.entries.find((entry) => entry.check === request.check)
        // The page is the override's side effect, never its condition (@cto
        // ccd8dfa8): a notifier that fails is said on stderr and journaled, and
        // the override it was telling about stands.
        // A clear's notice names the entry it ended, told by whoever ended it,
        // why, and the clear record itself.
        const noticed =
          standing ??
          (written.replaced === undefined
            ? undefined
            : {
                ...written.replaced,
                by: request.by,
                reason: request.reason ?? "",
                record: written.record.sha ?? written.replaced.record,
                verified: request.verified,
              })
        if (noticed === undefined) {
          throw new Error(
            `override write for '${request.check ?? ""}' returned neither a standing nor a cleared entry (record ${String(written.record.sha)})`,
          )
        }
        const told = await tellOverride(
          {
            config,
            git,
            repo,
            targetSha: captured.oid,
            workdir,
            tempRoot,
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.populateReference === undefined ? {} : { populateReference: options.populateReference }),
          },
          written.kind === "clear" ? "clear" : written.kind === "replaced" ? "replace" : "set",
          noticed,
          io,
        )
        const replaced = written.replaced === undefined ? "" : `; replaces ${overrideLine(written.replaced, now)}`
        emit(
          io,
          options.json,
          {
            kind: written.kind,
            told,
            overrides: overrideFacts(written.record, now),
            record: written.record.sha ?? null,
            ...(written.replaced === undefined ? {} : { replaces: written.replaced.record }),
          },
          standing === undefined
            ? `merge check ${request.check ?? ""} back on for ${targetLabel} (record ${String(written.record.sha).slice(0, 12)})`
            : `${overrideLine(standing, now)} on ${targetLabel} (record ${String(written.record.sha).slice(0, 12)})${replaced}`,
        )
        return 0
      } catch (error) {
        if (error instanceof OverrideRefused) {
          io.stderr(`yrd: ${error.message}\n`)
          return 1
        }
        throw error
      }
    }
    case "withdraw": {
      try {
        const taken = await withdraw(git, config.target.remote, {
          branch: request.branch,
          by: request.by,
          target: config.target,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.recipient === undefined ? {} : { recipient: request.recipient }),
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
    case "sweep-candidates": {
      const remote = request.remote ?? config.target.remote
      let activeShas: Set<string>
      try {
        activeShas = new Set<string>()
        const events = await readEventQueueWithChanges(createEventStore(repo, remote, selection), config.target.branch)
        for (const [_, history] of events.histories) {
          if (
            history.state.status !== "merged" &&
            history.state.status !== "failed" &&
            history.state.status !== "cancelled"
          ) {
            if (history.state.commit !== undefined) activeShas.add(history.state.commit)
            if (history.state.candidate !== undefined) activeShas.add(history.state.candidate)
          }
        }
      } catch (error) {
        io.stderr(
          `yrd: sweep refused: could not inspect active queue changes: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        return 1
      }
      const result = await sweepCandidateRefs(git, {
        repo,
        remote,
        dryRun: request.dryRun,
        batchSize: request.batchSize,
        activeShas,
      })
      emit(
        io,
        options.json,
        result,
        request.dryRun
          ? `scanned ${result.scanned} candidate refs (${result.live} active, ${result.reclaimable} reclaimable; dry run)`
          : `scanned ${result.scanned} candidate refs: deleted ${result.deleted.length} (${result.live} active, ${result.failed.length} failed)`,
      )
      return result.failed.length > 0 ? 1 : 0
    }
    case "submit": {
      if (request.prepare === true && request.dryRun === true) {
        throw new Error("--prepare writes permanent child refs and cannot be combined with --dry-run")
      }
      if (request.prepare === true && request.pins !== undefined) {
        throw new Error("--prepare cannot be combined with --gitlink; prepare an existing authored branch")
      }
      assertPlainEventQueueConfig(config, "submit")
      if (request.pins !== undefined) {
        if (request.branch !== undefined) throw new Error("--gitlink does not take a branch operand")
        if (request.issue === undefined) throw new Error("--gitlink needs --issue <id>")
        if (options.populateReference !== true) throw new Error("--gitlink needs the queue-owned clone")
        const canonicalIssue = resolveIssue === undefined ? request.issue : await resolveIssue(request.issue)
        const prepared = await preparePinCarrier({
          git,
          repo,
          target: config.target,
          issue: canonicalIssue,
          pins: request.pins,
          env: env ?? process.env,
        })
        const submission = {
          branch: prepared.branch,
          submitter: request.submitter,
          target: config.target,
          expectedTargetHead: captured.oid,
          issue: canonicalIssue,
          resolveIssue,
          admit,
        }
        if (request.dryRun === true) {
          const inspected = await withRemoteSeam("inspectSubmitAtHead", () =>
            inspectSubmitAtHead(git, config.target.remote, submission, prepared.head),
          )
          emit(
            io,
            options.json,
            {
              branch: prepared.branch,
              head: prepared.head,
              targetHead: prepared.targetHead,
              dryRun: true,
              verifying: inspected.verifying,
              admission: inspected.admission,
              freshness: freshnessLine(inspected.targetHead),
              stopped: stopFact(inspected.stop),
            },
            `would open ${changeName({ branch: prepared.branch, head: prepared.head })} on ${targetName(config.target)}; nothing was pushed; ${freshnessLine(inspected.targetHead)}` +
              formatDryRunGitlinks(inspected.verifying.state === "verified" ? inspected.verifying.gitlinks : undefined),
          )
          echoStop(inspected.stop)
          echoAdmission(inspected.admission, true)
          return 0
        }
        await git(["update-ref", `refs/heads/${prepared.branch}`, prepared.head, "0".repeat(prepared.head.length)])
        const removeCarrierRef = async (): Promise<void> => {
          try {
            // Delete only the exact head we created; another cleanup may have removed it already.
            await git(["update-ref", "-d", `refs/heads/${prepared.branch}`, prepared.head])
          } catch (cleanup) {
            if ((await refAt(git, `refs/heads/${prepared.branch}`)) !== undefined) throw cleanup
          }
        }
        let submitted
        try {
          submitted = await submit(git, config.target.remote, submission)
        } catch (cause) {
          try {
            await removeCarrierRef()
          } catch (cleanup) {
            throw new Error(
              `${prepared.branch}: submit refused: ${String(cause)}; generated carrier could not be removed: ${String(cleanup)}`,
              { cause },
            )
          }
          throw cause
        }
        try {
          // The carrier was pushed to the remote; remove the temporary local ref from
          // the queue clone so subsequent submissions or re-cuts do not collide on it.
          await removeCarrierRef()
        } catch (cleanup) {
          io.stderr(
            `${prepared.branch}: submitted successfully; local carrier ref cleanup failed (remaining ref preserved): ${String(cleanup)}\n`,
          )
        }
        await notifyAdmissionWarning(submitted, request.submitter)
        const { stop: acceptedUnder, ...accepted } = submitted
        emit(
          io,
          options.json,
          { ...accepted, stopped: stopFact(acceptedUnder), ...issueOutput(io, prepared.branch, submitted.issue) },
          `${submitted.retry ? "retried" : "submitted"} ${prepared.branch} at ${submitted.head.slice(0, 12)} to ${targetName(config.target)}; ${freshnessLine(submitted.targetHead)}` +
            submitted.published
              .map((row) => `\n${row.state} ${row.path}@${row.sha.slice(0, 12)} at ${row.remote} ${row.ref}`)
              .join(""),
        )
        echoStop(acceptedUnder)
        echoAdmission(submitted.admission)
        echoRevertWarning(submitted)
        return 0
      }
      const branch = request.branch ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()
      const submission = {
        branch,
        submitter: request.submitter,
        target: config.target,
        expectedTargetHead: captured.oid,
        ...(request.issue === undefined ? {} : { issue: request.issue }),
        resolveIssue,
        admit,
      }
      // Operator and stuck stops accept submits (the andon, operator 2026-09-16).
      // A maintenance stop refuses in the shared inspection before this echo.
      if (request.prepare === true) {
        const prepared = await prepareSubmit(git, config.target.remote, submission)
        const { head, targetHead, base, published, admission, stop, issue } = prepared
        emit(
          io,
          options.json,
          {
            branch,
            head,
            targetHead,
            base,
            published,
            admission,
            stopped: stopFact(stop),
            ...issueOutput(io, branch, issue),
          },
          `prepared ${branch} at ${head}; inspected base ${base} against ${targetHead}; ${published.length} child retention receipts` +
            published.map((row) => `\n${row.state} ${row.path}@${row.sha} at ${row.remote} ${row.ref}`).join(""),
        )
        echoStop(stop)
        if (admission.kind === "warn" || admission.kind === "cannot-judge") {
          io.stderr(`preparation admission ${admission.kind}: ${admission.reason}\n`)
        }
        return 0
      }
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
            admission: inspected.admission,
            submitter: request.submitter,
            target: targetName(config.target),
            targetHead,
            freshness: freshnessLine(targetHead),
            stopped: stopFact(inspected.stop),
            ...issueOutput(io, branch, issue),
          },
          `would open ${changeName({ branch, head })} on ${targetName(config.target)} for ${request.submitter}` +
            `${issue === undefined ? "" : ` (issue ${issue.issue})`}; nothing was pushed; ${freshnessLine(targetHead)}` +
            formatDryRunGitlinks(verifying.state === "verified" ? verifying.gitlinks : undefined),
        )
        echoStop(inspected.stop)
        echoAdmission(inspected.admission, true)
        return 0
      }
      const submitted = await submit(git, config.target.remote, submission)
      await notifyAdmissionWarning(submitted, request.submitter)
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
      echoAdmission(submitted.admission)
      echoRevertWarning(submitted)
      return 0
    }
    case "run": {
      if (request.tier === "long") {
        let worstExitCode: YrdCliExitCode = 0
        while (request.stopAtMs === undefined || Date.now() < request.stopAtMs) {
          const ran = await lockedRound({ tier: request.tier, stopAtMs: request.stopAtMs })
          if (typeof ran === "number") return ran
          if ("kind" in ran) return 2
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
      if (typeof ran === "number") return ran
      return "kind" in ran ? 2 : ran.outcome.exitCode
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
      let standing: { change: Change; reading: { state: Row["state"] }; landing?: string } | undefined
      const reading = await readEventListing(git, config, repo, workdir, captured.oid, eventStore, { all: true })
      const selected = reading.changes.get(branch)
      const row = reading.all.find((candidate) => candidate.branch === branch)
      const head = selected?.commit ?? row?.head
      const standingState = selected?.status ?? row?.state
      if (head !== undefined && standingState !== undefined) {
        const landing = standingState === "merged" ? (selected?.merge ?? row?.merge) : undefined
        if (local === undefined ? inLineState(standingState) || standingState === "merged" : head === local) {
          standing = { change: { branch, head }, reading: { state: standingState }, landing }
        }
      }
      if (standing?.reading.state === "merged") {
        emit(
          io,
          options.json,
          {
            branch,
            change: changeName(standing.change),
            exitCode: 0,
            state: "merged",
            ...(standing.landing === undefined ? {} : { landing: standing.landing }),
          },
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
          resolveIssue,
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

      const merging = await lockedRound({ only: change, noCheck: request.noCheck })
      if (typeof merging === "number" || "kind" in merging) return 2
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
      const landing = after.landing
      emit(
        io,
        options.json,
        {
          branch,
          change: changeName(change),
          exitCode: ending ?? 2,
          state,
          stopped: stopFact(after.stop),
          ...(landing === undefined ? {} : { landing }),
          ...(request.noCheck === true ? { noCheck: true } : {}),
        },
        `${changeName(change)} ${state}${state === "merged" && landing !== undefined ? ` at ${landing.slice(0, 12)}` : ""}${request.noCheck === true ? " (checks skipped: --no-check)" : ""}`,
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
      // The supervisor declares the tree its NEXT launch will load. An absent
      // declaration preserves the mutable-checkout contract of 24515; a
      // present but unreadable declaration never falls back to that checkout.
      const relaunchSource = (options.env ?? process.env).YRD_RELAUNCH_SOURCE
      const readRelaunchSource = (): Readonly<{ resolved?: string; error?: string }> => {
        if (relaunchSource === undefined) return {}
        if (!isAbsolute(relaunchSource)) {
          return { error: "YRD_RELAUNCH_SOURCE must be a nonempty absolute path" }
        }
        try {
          const resolved = realpathSync(relaunchSource)
          if (!statSync(resolved).isDirectory()) return { error: `${resolved} is not a directory` }
          return { resolved }
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      }
      if (relaunchSource !== undefined) {
        const source = readRelaunchSource()
        if (source.error !== undefined) {
          const message = `yrd: relaunch source ${JSON.stringify(relaunchSource)} cannot be read at start: ${source.error}; rounds continue, but a pin move will wait and page until the source is readable`
          log?.warn?.(message)
          io.stderr(`${message}\n`)
        }
      }
      /** This process, as the supervisor identifies the writer of the document (24523 D2). */
      const writer: HealthWriter = {
        command: process.argv.join(" "),
        pid: process.pid,
        // The runtime's own start, so nothing here reads /proc: the supervisor
        // owns that reader and checks this against it.
        startedAt:
          request.startedAt !== undefined
            ? typeof request.startedAt === "string"
              ? request.startedAt
              : request.startedAt.toISOString()
            : new Date(performance.timeOrigin).toISOString(),
      }
      const heartbeat = {
        graceMs: request.heartbeatGraceMs ?? HEARTBEAT_GRACE_MS,
        intervalMs: request.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      }
      /** The last document written, which every heartbeat restates with its clocks and the line's flow re-judged. */
      let stated: QueueHealthDocument | undefined
      let publicationStatus = "unpublished: the runner has not attempted its remote claim"
      /**
       * THE LINE'S FLOW (25669), as the loop last knew it: read off each round's
       * outcome, marked open while a round runs, and judged against the declared
       * threshold on every write, the heartbeat's included. One home for the fact:
       * `queue list`, the watch and its runner line read it from the document.
       *
       * The port of the old core's flow instrument (08-10
       * queueProgressAuditFindings, 08-30 queue-liveness-wedged), deleted with that
       * core on 09-03 in b5b468037c; on 09-24 a line stood still for over an hour
       * while this document read healthy.
       */
      // Undefined until a round has READ the line: a count nobody took is not
      // zero waiting, and a legacy-format round reads none, so it states none.
      let flow: LineFlow | undefined
      let readFailure: Readonly<{ ref: string; error: string; count: number }> | undefined
      let chainPressure: Awaited<ReturnType<typeof readEventQueue>>["writePressure"]
      const setChainPressure = (pressure: typeof chainPressure): void => {
        if (chainPressure === undefined && pressure !== undefined) {
          log?.warn?.(
            `queue event chain has ${pressure.count}/${pressure.limit} events; remaining limit reaches its cap around ${pressure.projectedCrossing ?? "an unknown date (no growth in the last 48 hours)"}`,
          )
        }
        chainPressure = pressure
      }
      let threshold = { declared: config.health.declared, ms: config.health.stallAfterMs }
      // The service runs normal-tier rounds. Keep the runner's published bounds on that same tier.
      const upRoundTier = "normal" as const
      let activeChecks = config.checks
      let activeSetup = config.setup
      const flowReading = (): FlowReading | undefined =>
        flow === undefined
          ? undefined
          : {
              flow: {
                ...flow,
                ...(flow.roundOpen === undefined || runnerPhase === undefined
                  ? {}
                  : { roundOpen: { ...flow.roundOpen, phase: runnerPhase } }),
              },
              threshold,
              claim: runnerClaim(),
            }
      /**
       * The open round's phase, from its own journal (25669 row 2), for the next
       * write to state: the heartbeat writes first and never waits on this read.
       * A journal that cannot say is stated with its reason, never left out.
       */
      //
      // THE FIRST ROUND AFTER A START has no flow yet, and it is the round the
      // 09-24 cut-over stood still in for fifty minutes. It journals its own line
      // before any check, and that reading is the flow until the round ends.
      let openedAt: string | undefined
      const notePhase = async (): Promise<void> => {
        const opened = openedAt
        if (opened === undefined) return
        const read = await roundPhase(workdir, new Date(opened))
        // The round ended while the journal was read: what it says is no longer news.
        if (openedAt !== opened) return
        const known =
          flow ??
          (read.line === undefined
            ? undefined
            : {
                waiting: read.line.waiting,
                ...(read.line.oldest === undefined ? {} : { oldestWaiting: read.line.oldest }),
                ...(read.line.lastJudgedAt === undefined ? {} : { lastJudgedAt: read.line.lastJudgedAt }),
              })
        if (known === undefined) return
        flow = { ...known, roundOpen: { startedAt: opened, ...read.open } }
      }
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
        const written = writtenHealthDocument(
          {
            ...document,
            facts: {
              ...document.facts,
              publication: publicationStatus,
              runnerClaim: runnerClaim(),
              ...(runnerPhase === undefined ? {} : { runnerPhase }),
              ...(relaunchSource === undefined
                ? {}
                : { relaunchSource: { declared: relaunchSource, ...readRelaunchSource() } }),
            },
          },
          writer,
          heartbeat,
          new Date(),
        )
        stated = written
        persistHealth(written)
        return written
      }
      /** The one atomic write, shared by the heartbeat's documents and the graceful stop's last one. */
      const persistHealth = (written: QueueHealthDocument): void => {
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
      }
      const terminalExit = (kind: ServiceExitFact["kind"], detail: string): YrdCliExitCode => {
        const exited = exitedHealthDocument(SERVICE, {
          kind,
          detail,
          exitCode: 2,
          at: new Date().toISOString(),
        })
        stated = exited
        persistHealth(exited)
        return stuck(detail)
      }
      const runnerBeatMs = Math.max(30_000, heartbeat.intervalMs)
      let runnerState: RunnerClaim["state"] = "idle"
      let holding: string | undefined
      let runnerSince = writer.startedAt
      let runnerDeadline: string | undefined
      let runnerPhase: string | undefined
      let roundPlan: Readonly<{ due: string; round: string; candidates: number }> | undefined
      const writerIdentity = processStartIdentity(writer.pid)
      const claimIdentity =
        writerIdentity.boot !== undefined &&
        writerIdentity.pidNamespace !== undefined &&
        writerIdentity.tick !== undefined
          ? { boot: writerIdentity.boot, pidNamespace: writerIdentity.pidNamespace, startTick: writerIdentity.tick }
          : {}
      const runnerClaim = (at: Date = new Date()): RunnerClaim => ({
        host: hostname(),
        pid: writer.pid,
        started: writer.startedAt,
        at: at.toISOString(),
        beatMs: runnerBeatMs,
        state: runnerState,
        ...(holding === undefined ? {} : { holding }),
        since: runnerSince,
        ...(runnerDeadline === undefined ? {} : { deadline: runnerDeadline }),
        ...(roundPlan === undefined ? {} : roundPlan),
        ...claimIdentity,
      })
      const stoppedRunnerClaim = (): RunnerClaim => {
        runnerState = "stopped"
        holding = undefined
        runnerSince = new Date().toISOString()
        runnerDeadline = undefined
        runnerPhase = undefined
        roundPlan = undefined
        return runnerClaim()
      }
      const publisher = new RunnerPublisher(
        git,
        config.target.remote,
        config.target.branch,
        (status) => {
          const recovering = publicationStatus.startsWith("failed ") || publicationStatus.startsWith("waiting ")
          publicationStatus =
            status.kind === "ok" ? `fresh at ${status.at}` : `${status.kind} ${status.cause} at ${status.at}`
          if (stated !== undefined && (status.kind !== "ok" || recovering)) writeHealth(stated)
        },
        (line) => {
          log?.warn?.(line)
          io.stderr(`yrd: ${line}\n`)
        },
      )
      const setRunnerState = (
        state: RunnerClaim["state"],
        selected?: string,
        phase?: string,
        since = new Date().toISOString(),
        boundMs?: number,
      ): void => {
        const bounded =
          state === "provisioning" || state === "checking" || state === "merging" || state === "deprovisioning"
        if (
          bounded &&
          (phase === undefined || boundMs === undefined || !Number.isSafeInteger(boundMs) || boundMs <= 0)
        ) {
          throw new Error(`bounded runner ${state} needs a named phase and positive declared bound`)
        }
        if (!bounded && (phase !== undefined || boundMs !== undefined)) {
          throw new Error(`unbounded runner ${state} cannot carry a phase deadline`)
        }
        if (runnerState === state && holding === selected && runnerPhase === phase && runnerSince === since) return
        if (!bounded) roundPlan = undefined
        runnerSince = since
        runnerState = state
        holding = selected
        runnerPhase = phase
        if (bounded) {
          if (boundMs === undefined) throw new Error(`bounded runner ${state} has no declared bound`)
          runnerDeadline = new Date(Date.parse(since) + boundMs).toISOString()
        } else {
          runnerDeadline = undefined
        }
        void publisher.publish(runnerClaim())
        if (bounded && stated !== undefined) writeHealth(lineDocument(lastStop, 0))
      }
      const recordRunnerState = (record: LogRecord): void => {
        if (record.kind === "observation" && record.subject === "line") {
          if (openedAt === undefined) throw new Error("line observation has no open round for its Due plan")
          if (roundPlan !== undefined) throw new Error("round Due plan was already published")
          if (typeof record.waiting !== "number" || !Number.isSafeInteger(record.waiting) || record.waiting < 0) {
            throw new Error(`line observation has invalid Candidates: ${String(record.waiting)}`)
          }
          if (record.waiting > 0) {
            roundPlan = {
              round: openedAt,
              due: new Date(
                Date.parse(openedAt) + roundBoundMs(activeChecks, activeSetup, record.waiting, upRoundTier),
              ).toISOString(),
              candidates: record.waiting,
            }
            void publisher.publish(runnerClaim())
            if (stated !== undefined) writeHealth(lineDocument(lastStop, 0))
          }
          return
        }
        const selected =
          typeof record.branch === "string" && typeof record.head === "string"
            ? `${record.branch}@${record.head}`
            : undefined
        if (record.kind === "check" && record.end === undefined) {
          if (typeof record.name !== "string" || typeof record.start !== "string") {
            throw new Error("check start lacks a name or start instant for its runner deadline")
          }
          const boundMs = (() => {
            const programSetup =
              record.purpose === "program-root-setup"
                ? /^(?:setup-program-target-|setup-program-subject-)(.+)$/u.exec(record.name)?.[1]
                : undefined
            if (record.name === "setup" || record.purpose === "program-root-setup") {
              if (activeSetup === undefined) throw new Error("runner setup has no declaration for its bound")
              if (record.purpose === "program-root-setup" && programSetup === undefined) {
                throw new Error(`runner program-root setup ${record.name} has no declared check name`)
              }
              if (
                programSetup !== undefined &&
                !activeChecks.some((check) => check.name === programSetup && check.programRoot === true)
              ) {
                throw new Error(`runner program-root setup ${record.name} has no declared check`)
              }
              return DEFAULT_CHECK_BOUND_MS
            }
            const spec = activeChecks.find((check) => check.name === record.name)
            if (spec === undefined) throw new Error(`runner check ${record.name} has no declaration for its bound`)
            return effectiveCheckTimeoutMs(spec, upRoundTier)
          })()
          setRunnerState(
            record.name === "setup" || record.purpose === "program-root-setup" ? "provisioning" : "checking",
            selected,
            record.name,
            record.start,
            boundMs,
          )
        } else if (record.kind === "step" && record.end === undefined) {
          if (typeof record.name !== "string" || typeof record.start !== "string") {
            throw new Error("step start lacks a name or start instant for its runner deadline")
          }
          if (!Object.hasOwn(STEP_BOUNDS_MS, record.name)) {
            throw new Error(`runner step ${record.name} has no declared detection bound`)
          }
          const name = record.name as keyof typeof STEP_BOUNDS_MS
          setRunnerState(STEP_STATES[name], selected, name, record.start, STEP_BOUNDS_MS[name])
        }
      }
      const runnerConflictExit = (): YrdCliExitCode | undefined => {
        const conflict = publisher.conflict
        if (conflict === undefined) return undefined
        const cause = conflict.message
        const base = lineDocument(lastStop, 0)
        writeHealth({
          ...base,
          state: "unhealthy",
          error: {
            code: "runner-conflict",
            cause,
            resolution: [`Stop the other live runner named at ${publisher.ref} before restarting this service.`],
          },
          facts: {
            ...base.facts,
            "runner-conflict": `${conflict.other.host}/${String(conflict.other.pid)} ${conflict.other.started}`,
          },
        })
        return 2
      }
      // WHO STARTED IT AND WHY (25430): the supervisor's start intent when it
      // gave one, else the plain default, as resume's is "pause lifted". Keyed
      // on the verb, so a previous stop's record is never read as this start's.
      const startIntent = readUnitIntent("start", options.env ?? process.env, writer.startedAt)
      const serviceStarted: ServiceIntentFact =
        startIntent.kind === "intent" ? startIntent.fact : { reason: "started", since: writer.startedAt }
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
        const base = roundHealthDocument(SERVICE, stop, sleepMs, new Date(), flowReading(), readFailure, lastStuck)
        return {
          ...base,
          facts: {
            ...base.facts,
            ...relaunchOff,
            serviceStarted,
            ...(chainPressure === undefined ? {} : { eventChainPressure: chainPressure }),
          },
        }
      }
      /**
       * The last stop the loop knows: read at start, then derived by every round.
       * Every document states it, the relaunch wait's included, because the fact
       * is always present and its absence can never be read as a running line.
       */
      let lastStop: PauseRecord | undefined
      let lastStuck: readonly string[] = []
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
            return terminalExit(
              "gitlink-absent",
              `runtime gitlink ${gitlink.path} is absent at captured target ${targetOid}; restore it before restarting this service`,
            )
          }
          // An explicitly supplied gitlink has no physical checkout to await.
          if (gitlink.checkout === undefined || gitlink.superproject === undefined) break
          // An undeclared source is the mutable checkout of 24515. A declared
          // source is the tree the supervisor will load on its next launch;
          // resolve it on every check so an atomic pointer promotion is seen.
          const source = readRelaunchSource()
          const projectedRoot = relaunchSource === undefined ? gitlink.superproject : source.resolved
          const physicalCheckout =
            relaunchSource === undefined
              ? gitlink.checkout
              : source.resolved === undefined
                ? relaunchSource
                : join(source.resolved, gitlink.path)
          let projected: string | undefined
          let checkout = "unreadable"
          let sourceError = relaunchSource === undefined ? undefined : source.error
          if (projectedRoot !== undefined && sourceError === undefined) {
            try {
              projected = await gitlinkAt(
                gitIn(projectedRoot, undefined, selection, { env: options.env }),
                "HEAD",
                gitlink.path,
              )
              checkout = (
                await gitIn(physicalCheckout, undefined, selection, { env: options.env })([
                  "rev-parse",
                  "--verify",
                  "HEAD^{commit}",
                ])
              ).trim()
            } catch (error) {
              if (relaunchSource === undefined) throw error
              sourceError = error instanceof Error ? error.message : String(error)
            }
          }
          if (sourceError === undefined && projected === now && checkout === now) break
          const state = `${now}:${projectedRoot}:${projected}:${checkout}:${sourceError}`
          if (state !== announced) {
            const waiting =
              relaunchSource === undefined
                ? `waiting for checkout ${gitlink.path}: loaded ${gitlink.sha.slice(0, 12)}, target ${now.slice(0, 12)}, local gitlink ${projected?.slice(0, 12) ?? "absent"}, checkout ${checkout.slice(0, 12)}; no queue round will run until the checkout updater materializes the target`
                : `waiting for relaunch source ${JSON.stringify(relaunchSource)}: running from ${gitlink.superproject}, resolved source ${projectedRoot ?? "unavailable"}, target ${gitlink.path}@${now.slice(0, 12)}, source gitlink ${projected?.slice(0, 12) ?? "absent"}, checkout ${checkout.slice(0, 12)}${sourceError === undefined ? "" : `, read failed: ${sourceError}`}; no queue round will run until the declared source holds the target`
            // WARN, not info: while this is announced the delivery service is
            // doing nothing, and an INFO line is where the last capability that
            // switched itself off hid for a month.
            log?.warn?.(waiting, { checkout: physicalCheckout, gitlink: gitlink.path, projected, target: now })
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
              waitingCheckout: physicalCheckout,
              waitingCheckoutHead: checkout,
              ...(relaunchSource === undefined
                ? {}
                : {
                    waitingSourceDeclared: relaunchSource,
                    waitingSourceResolved: projectedRoot ?? "unavailable",
                    ...(sourceError === undefined ? {} : { waitingSourceError: sourceError }),
                  }),
            }
            const alive = roundHealthDocument(SERVICE, lastStop, waitCapMs, new Date(), undefined, undefined, lastStuck)
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
              relaunchSource === undefined
                ? `waited ${String(Math.round((Date.now() - waitStartedAt) / 1000))}s for ${gitlink.checkout} to check ` +
                  `out ${gitlink.path}@${now.slice(0, 12)} and it has not: its own gitlink reads ` +
                  `${projected?.slice(0, 12) ?? "absent"} and its working tree reads ${checkout.slice(0, 12)}. ` +
                  `No queue round is running and none will until it lands. Once ${gitlink.path}@${now.slice(0, 12)} ` +
                  `is checked out there, the service relaunches on its own — no restart, and nothing to delete.`
                : `waited ${String(Math.round((Date.now() - waitStartedAt) / 1000))}s for declared relaunch source ${JSON.stringify(relaunchSource)} to load ${gitlink.path}@${now.slice(0, 12)}. ` +
                  `This process runs from ${gitlink.superproject}; the source now resolves to ${projectedRoot ?? "unavailable"}, whose gitlink reads ${projected?.slice(0, 12) ?? "absent"} and checkout reads ${checkout.slice(0, 12)}. ` +
                  `${sourceError === undefined ? "" : `Source read failed: ${sourceError}. `}` +
                  `No queue round runs until the declared source holds the pin. The service then exits 0 for relaunch; no manual restart or edit to the running tree.`
            log?.warn?.(why, { checkout: physicalCheckout, gitlink: gitlink.path, projected, target: now })
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
                { checkout: relaunchSource ?? gitlink.checkout, path: gitlink.path, sha: now },
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
          if (latest === undefined) {
            return terminalExit("declaration-unreadable", `${targetLabel} no longer carries a .yrd.yml`)
          }
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
        await publisher.publish(stoppedRunnerClaim())
        return 0
      }
      // THE LINE AS IT STANDS AT START, read from the queue event chain and written before round 1 opens
      // (24523 F1). A supervisor waiting for this process's own document reads
      // it now instead of waiting out a long first round against its
      // predecessor's, and a stuck stop that stands writes the stuck page, so a
      // relaunch continues the page rather than clearing it and opening it again.
      // A stop that cannot be read is what a round that cannot read its queue
      // already is: stuck, exit 2, and no document claiming a state nobody read.
      try {
        const operational = await readEventOps(eventStore, git, config.target.branch, captured.oid)
        lastStop = operational.stop
        setChainPressure(operational.queue.writePressure)
      } catch (error) {
        return stuck(
          `the line's stop cannot be read at start: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (lastStop !== undefined) {
        runnerState = "paused"
        runnerSince = new Date().toISOString()
      }
      let beat: ReturnType<typeof setInterval> | undefined
      const startupAbort = new AbortController()
      // THE SIGNAL EXIT (25430, 24570). A signal carries no reason. When the
      // supervisor wrote a current stop intent first, the last document says
      // who stopped the service. Without one, it names the terminal signal and
      // the missing or invalid intent. Synchronous from start to re-raise, and the
      // heartbeat is cleared first, so nothing writes over the last document.
      // Under @cto 16ab7d00, readUnitIntent verifies the intent's `at` is at or
      // after writer.startedAt so a previous stop's intent is never read.
      // A SIGKILL runs none of this: its last document ages into the overdue
      // reading, which says the service stopped outside a graceful stop.
      const terminate = request.terminate ?? processTerminate
      const offTerminate = terminate.on((received) => {
        // A stopped claim can wait on a hung remote write. Unsubscribe now so
        // a second signal uses the process default instead of re-entering this
        // handler while the first publish is pending.
        offTerminate()
        startupAbort.abort()
        if (beat !== undefined) clearInterval(beat)
        const intent = readUnitIntent("stop", options.env ?? process.env, writer.startedAt)
        const signal = received ?? "SIGTERM"
        if (intent.kind === "none") {
          log?.warn?.(`stopping without a recorded reason: ${intent.why}`)
          const exited = exitedHealthDocument(SERVICE, {
            kind: "signal",
            detail: `${signal} arrived without a stop intent: ${intent.why}`,
            signal,
            at: new Date().toISOString(),
          })
          stated = exited
          persistHealth(exited)
        } else {
          const graceful = gracefulStopHealthDocument(SERVICE, intent.fact, lastStop)
          stated = graceful
          persistHealth(graceful)
        }
        if (publisher.owns) void publisher.publish(stoppedRunnerClaim()).finally(() => terminate.reraise(signal))
        else terminate.reraise(signal)
      })
      try {
        writeHealth(lineDocument(lastStop, 0))
        await publisher.publish(runnerClaim())
        const startupSignal =
          request.stop === undefined ? startupAbort.signal : AbortSignal.any([startupAbort.signal, request.stop])
        // A candidate owns no claim and may run no round. Re-read the remote
        // ref through Publisher until this writer has won the exact-tip CAS.
        while (!publisher.owns) {
          const startupConflict = runnerConflictExit()
          if (startupConflict !== undefined) return startupConflict
          if (stopped() || startupAbort.signal.aborted) return 0
          await delay(Math.min(15_000, runnerBeatMs), undefined, { signal: startupSignal }).catch((error) => {
            if (!startupSignal.aborted) throw error
          })
          if (stopped() || startupAbort.signal.aborted) return 0
          await publisher.publish(runnerClaim())
        }
        // THE HEARTBEAT (24523 D6): one timer for the whole loop, restating
        // the last document through rounds, idle sleeps and a stopped line.
        let nextRunnerBeat = Date.now() + runnerBeatMs
        beat = setInterval(() => {
          const reading = flowReading()
          if (stated !== undefined) {
            writeHealth(
              reading === undefined ? stated : withLineFlow(stated, lastStop, reading, new Date(), readFailure),
            )
          }
          if (Date.now() >= nextRunnerBeat) {
            nextRunnerBeat = Date.now() + runnerBeatMs
            void publisher.publish(runnerClaim(), true)
          }
          void notePhase()
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
        const requiredRunIndex = runIndexRef(config.target.branch)
        let runIndexReady = false
        let runIndexWaitAnnounced = false
        let legacyOverrideHeld: string | undefined
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
        for (;;) {
          const conflict = runnerConflictExit()
          if (conflict !== undefined) return conflict
          // A carrier that needs a remote ref owns its own startup condition.
          // Keep the process and heartbeat alive while @chief activates an old
          // queue's run index; no round may allocate a number before it exists.
          if (!runIndexReady) {
            const precondition = await readRunIndexPrecondition(eventStore, config.target.branch)
            if (precondition.kind === "ready") {
              runIndexReady = true
              readFailure = undefined
              if (runIndexWaitAnnounced) writeHealth(lineDocument(lastStop, 0))
            } else {
              if (precondition.kind === "corrupt") return stuck(precondition.message)
              if (precondition.kind === "missing") {
                readFailure = undefined
                const cure = `yrd runs activate <repo>@${config.target.branch}`
                const why = `${requiredRunIndex} at ${config.target.remote} is absent for the existing queue; no round will run until @chief runs ${cure}`
                if (!runIndexWaitAnnounced) {
                  log?.warn?.(why, { ref: requiredRunIndex, remote: config.target.remote })
                  emit(
                    io,
                    options.json,
                    { reason: "remote-precondition-missing", ref: requiredRunIndex, message: why },
                    why,
                  )
                  runIndexWaitAnnounced = true
                }
                const alive = lineDocument(lastStop, 0)
                const document = writeHealth({
                  ...alive,
                  state: "unhealthy",
                  error: {
                    code: "queue-remote-precondition-missing",
                    cause: why,
                    resolution: [
                      `@chief: run ${cure} for this queue after its carrier lands.`,
                      "No restart is needed. This service re-reads the remote ref and starts rounds when it appears.",
                    ],
                  },
                  facts: {
                    ...alive.facts,
                    reasonKey: `remote-precondition:${requiredRunIndex}`,
                    waitingForRef: requiredRunIndex,
                  },
                })
                await request.afterHealth?.(document)
              } else {
                // The reader could not tell whether the ref exists. Carry this
                // through the ordinary failed-read rail, never as "missing".
                readFailure = {
                  ref: requiredRunIndex,
                  error: precondition.message,
                  count: readFailure?.ref === requiredRunIndex ? readFailure.count + 1 : 1,
                }
                const document = writeHealth(lineDocument(lastStop, interval))
                await request.afterHealth?.(document)
              }
              if (stopped()) return 0
              await delay(Math.min(15_000, Math.max(1000, interval)), undefined, { signal: request.stop }).catch(
                (delayError) => {
                  if (!stopped()) throw delayError
                },
              )
              if (stopped()) return 0
              continue
            }
          }
          // The declaration again under the lock, as the target holds it now: a
          // correct edit at the target is the next round's, never a restart's.
          if (lastStop === undefined) {
            setRunnerState("provisioning", undefined, "prepare", new Date().toISOString(), STEP_BOUNDS_MS.prepare)
          }
          const ran = await lockedRound({
            tier: upRoundTier,
            before: async (declared) => {
              // The round opens now, judged against the threshold THIS round's
              // declaration carries, so an edit to health.stallAfter is the next
              // round's, like every other key.
              threshold = { declared: declared.config.health.declared, ms: declared.config.health.stallAfterMs }
              activeChecks = declared.config.checks
              activeSetup = declared.config.setup
              openedAt = new Date().toISOString()
              roundPlan = undefined
              setRunnerState("provisioning", undefined, "line-read", openedAt, STEP_BOUNDS_MS["line-read"])
              if (flow !== undefined) flow = { ...flow, roundOpen: { startedAt: openedAt } }
              if (lockWaitStated) {
                lockWaitStated = false
                writeHealth(lineDocument(lastStop, 0))
              }
              return reload(declared.oid)
            },
            stallMs: request.roundLockStallMs,
            stop: request.stop,
            waiting,
            onRecord: recordRunnerState,
            onTerminalDeclaration: (detail) => {
              const exited = exitedHealthDocument(SERVICE, {
                kind: "declaration-unreadable",
                detail,
                exitCode: 2,
                at: new Date().toISOString(),
              })
              stated = exited
              persistHealth(exited)
            },
          })
          const afterRoundConflict = runnerConflictExit()
          if (afterRoundConflict !== undefined) return afterRoundConflict
          if (typeof ran === "number") return ran
          if ("kind" in ran) {
            if (ran.kind === "legacy-override-present") {
              readFailure = undefined
              setRunnerState("idle")
              openedAt = undefined
              const { ref, oid } = ran.error
              const why = `${ref} at ${oid} remains on ${config.target.remote}; no queue round will run while it exists`
              if (legacyOverrideHeld !== `${ref}@${oid}`) {
                log?.warn?.(why, { ref, oid, remote: config.target.remote })
                io.stderr(`yrd: ${why}; @chief must verify, fold or delete the ref\n`)
                legacyOverrideHeld = `${ref}@${oid}`
              }
              const alive = lineDocument(lastStop, 0)
              const document = writeHealth({
                ...alive,
                state: "unhealthy",
                error: {
                  code: "legacy-override-present",
                  cause: why,
                  resolution: [
                    `@chief: verify, fold or delete ${ref} at ${oid} before this queue judges another round.`,
                    "No restart is needed. This service re-reads the remote ref and resumes when it is absent.",
                  ],
                },
                facts: {
                  ...alive.facts,
                  reasonKey: `legacy-override:${ref}@${oid}`,
                  legacyOverrideRef: ref,
                  legacyOverrideOid: oid,
                },
              })
              await request.afterHealth?.(document)
              if (stopped()) return 0
              await delay(Math.min(15_000, Math.max(1000, interval)), undefined, { signal: request.stop }).catch(
                (error) => {
                  if (!stopped()) throw error
                },
              )
              if (stopped()) return 0
              continue
            }
            legacyOverrideHeld = undefined
            if (ran.kind === "retry-exhausted") {
              readFailure = undefined
              setRunnerState("idle")
              openedAt = undefined
              flow = flowAfterRetryExhaustion(flow, ran.error, new Date())
              const document = writeHealth(lineDocument(lastStop, interval))
              await request.afterHealth?.(document)
              if (stopped()) return 0
              await delay(interval, undefined, { signal: request.stop }).catch((error) => {
                if (!stopped()) throw error
              })
              if (stopped()) return 0
              continue
            }
            const message =
              ran.error.readError instanceof Error ? ran.error.readError.message : String(ran.error.readError)
            readFailure = {
              ref: ran.ref,
              error: message,
              count: readFailure?.ref === ran.ref ? readFailure.count + 1 : 1,
            }
            setRunnerState("idle")
            openedAt = undefined
            const document = writeHealth(lineDocument(lastStop, interval))
            await request.afterHealth?.(document)
            if (stopped()) return 0
            await delay(interval, undefined, { signal: request.stop }).catch((error) => {
              if (!stopped()) throw error
            })
            if (stopped()) return 0
            continue
          }
          legacyOverrideHeld = undefined
          readFailure = undefined
          const { outcome } = ran

          // The round derived whether the line is stopped and said so on its
          // outcome; the document states that and nothing more. A stuck stop is
          // unhealthy for every round that holds it and clears on the first round
          // after an act lifts it. The hook sees the document as written, with
          // nothing awaited between the write and the call.
          const sleepMs = sleepAfter(outcome, interval)
          lastStop =
            outcome.stuck.length > 0
              ? (await readEventOps(eventStore, git, config.target.branch, outcome.target)).stop
              : outcome.stopped?.ring === "pause"
                ? (outcome.stopped.what as PauseRecord)
                : undefined
          const latestQueue = await readEventQueue(eventStore, config.target.branch)
          setChainPressure(latestQueue.writePressure)
          lastStuck = outcome.pendingStuck ?? outcome.stuck
          setRunnerState(lastStuck.length > 0 ? "stuck" : lastStop === undefined ? "idle" : "paused")
          openedAt = undefined
          flow = flowAfterRound(flow, outcome, new Date())
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
        if (beat !== undefined) clearInterval(beat)
        offTerminate()
        if (stopped() && publisher.owns && publisher.conflict === undefined) {
          await publisher.publish(stoppedRunnerClaim())
        }
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
          eventChanges: ReadonlyMap<string, EventChange>
          eventInvalid: EventListingResult["invalid"]
          journals: Journals
          /** The stop that stands, as the reading derived it. */
          stopped: StopFact | null
          /** The merge-check override table, active and expired entries alike (25296); empty on an event queue. */
          overrides: readonly OverrideFact[]
          /** Which drafts the rows list, the heads of the drafts this repository has not read, and how many older ones fold into a count. */
          drafts?: Readonly<{ window: DraftWindow; unread: readonly string[]; older: number }>
        }>
      > => {
        // JSON keeps one row per opened segment and per local run. The human
        // table keeps each branch's current segment only.
        const selectedStore = statusEventStore(declared.config.target.remote)
        if (
          localStatus !== undefined &&
          (await queueFormat(selectedStore, declared.config.target.branch)) === "legacy"
        ) {
          await refuseMissingEventMarker(declared.config.target.remote, declared.config.target.branch)
        }
        const reading = await readEventListing(git, declared.config, repo, workdir, declared.oid, selectedStore, {
          all: request.all,
          drafts: request.drafts,
          draftWindow,
        })
        const { journals, all, drafts, observation } = reading
        if (options.json !== true) narrateMalformed(io, journals, said)
        // The run-history lens is for stats and watch detail. List is the
        // current head of each branch in both output formats; JSON expands
        // that head by run unless --latest selects its single row.
        const unfiltered = watchRows(all, { journals, perRun: options.json === true })
        const listed = watchRows(all, { journals, perRun: options.json === true, latest: request.latest })
        const changes = filterRows(listed, request.terms ?? []).filter((item) => item.row.state !== "draft")
        const rows = filterRows(watchRows(all, { journals }), request.terms ?? [])
        const documentRows = request.drafts === true ? filterRows(listed, request.terms ?? []) : changes
        // The stop the reading DERIVED, never the tip's kind: a stuck stop whose
        // change has left the line is over, and a reader must not see it.
        const pause = reading.pause
        const stopped = stopFact(pause)
        const published = await readPublishedRunner(git, config.target.branch, config.target.remote, reading.runnerTip)
        const localRunner = await readRunnerFacts(workdir)
        const runner: RunnerFacts = { ...localRunner, published }
        const service = localRunner.service
        const runnerStatus =
          options.json === true
            ? {
                state: runnerOf({ unfiltered, runner: localRunner, stopped }, new Date()).state,
                service: service.kind === "beating" ? { kind: service.kind } : { kind: service.kind, why: service.why },
                published,
              }
            : undefined
        // The table and stop come from the same authority read as this listing.
        const overrides = overrideFacts(reading.overrides, Date.now())
        // What was queried, where it looked, and what it left out — said on the
        // screen, not left for the reader to infer from an empty table. Zero
        // rows also names the fields the term was checked against, so a state
        // name that found nothing is told it WAS considered, not skipped —
        // the same message on `--json` as on the page (AC1,
        // a-state-name-filters-to-zero-rows-and-exit-zero).
        const filteredScope =
          request.terms === undefined || request.terms.length === 0
            ? undefined
            : `${String(documentRows.length)} of ${String(listed.filter((item) => item.row.state !== "draft").length)} change(s) match ${request.terms.join(" or ")}` +
              (documentRows.length === 0 ? `. Checked ${FILTER_FIELDS}.` : "")
        const baseScope = `Read event change chains in ${queueRefPrefix(config.target.branch)}/changes/, branch heads at ${config.target.remote}, and direct target commits after the queue declaration.`
        const ignoreScope =
          config.ignore.length === 0
            ? undefined
            : `Excluded draft heads matching .yrd.yml ignore: ${config.ignore.map((pattern) => JSON.stringify(pattern)).join(", ")}.`
        // The filter result must be visible on the one-line page even when
        // the local source and event-store scope are long.
        const scopeParts = [filteredScope, statusLine(), baseScope, ignoreScope].filter((part) => part !== undefined)
        const scope = scopeParts.length === 0 ? undefined : scopeParts.join(" ")
        return {
          observation,
          data: {
            ...statusFact(),
            observation,
            changes: documentRows.map((row) => row.row),
            journal: journalFact(journals),
            // The runner belongs to the whole queue, even when a selector hides every row.
            ...(runnerStatus === undefined ? {} : { runner: runnerStatus }),
            pause: pause ?? null,
            // The everyday reader of a stopped line: always present, null while
            // the line runs, so a stop can never be read as absent.
            stopped,
            // Always present: an empty array is "no overrides", never an absent field.
            overrides,
            ...(scope === undefined ? {} : { scope }),
          },
          eventChanges: reading.changes,
          eventInvalid: reading.invalid,
          journals,
          queue: queueName(config.target, await remoteUrl(git, config.target.remote)),
          // Pre-M8 a repository has exactly one queue: the target's branch, on
          // this repository. M8 turns this list of one into N.
          queues: [{ branch: config.target.branch, label: config.target.branch, path: repo }],
          runner,
          // Every row, per run, whatever the filter: the box counts the queue,
          // not the view, and a change checked twice made two decisions.
          decisions: decisionsOfRows(unfiltered),
          ...(pause === undefined ? {} : { pause: pauseLine(pause) }),
          ...(journals.absent === undefined ? {} : { journalAbsent: journals.absent }),
          ...(scope === undefined ? {} : { scope }),
          rows,
          unfiltered,
          changes,
          stopped,
          overrides,
          ...(drafts === undefined
            ? {}
            : {
                drafts: {
                  unread: drafts.undated.map((draft) => draft.head),
                  window: draftWindow,
                  older: drafts.older ?? 0,
                },
              }),
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
      if ((options.interactive === true || options.watchSource !== undefined) && options.json !== true) {
        const first = await round(captured)
        if (first.observation.contract === "root-v1" && first.observation.outcome === "invalid") {
          io.stderr(`${first.observation.message}\n`)
          return 2
        }
        if (selectedNothing(request.terms, first.changes)) {
          io.stderr(missedSelector(request.terms ?? [], first.queue, first.changes.length))
          return 2
        }
        let ending: YrdCliExitCode | undefined
        // The queue read the LAST round made: a detail opened between rounds
        // reads the same tips the table shows, never a fresher or staler one.
        let eventChanges = first.eventChanges
        let eventInvalid = first.eventInvalid
        let journals = first.journals
        let seen: Readonly<{ drafts?: Readonly<{ unread: readonly string[] }> }> = first
        const source: WatchSource = {
          id: first.queue,
          label: formatStoredQueueAddress(first.queue),
          resolveRunAddress: async (operand) => {
            const selected = parseQueueAddress(first.queue)
            if (selected.kind !== "remote") {
              throw new Error(`${first.queue}: a local queue has no portable run address`)
            }
            const full = operand.startsWith("#") ? `${formatQueueAddress(selected)}${operand}` : operand
            const address = parseRunAddress(full)
            if (address.queue.canonical !== selected.canonical) {
              throw new Error(`${address.canonical}: selected queue is ${formatQueueAddress(selected)}`)
            }
            const lookup = await lookupRunIndex(
              createEventStore(repo, config.target.remote, selectionFor(git)),
              address.queue.queue,
              address.number,
            )
            if (lookup.kind === "unknown") {
              throw new Error(
                `${RUN_INDEX_CODES.unknown}: ${address.canonical} has no entry at ${runIndexRef(address.queue.queue)}:${runIndexPath(address.number)} on ${address.queue.transport}; index high-water is ${lookup.knownThrough} (gaps may exist)`,
              )
            }
            return {
              canonical: address.canonical,
              id: lookup.record.id,
              number: lookup.number,
              startedAt: lookup.record.startedAt,
            }
          },
          load: async (asked) => {
            const refreshed = await declaration()
            if (refreshed === undefined) throw new Error(`${targetLabel} no longer carries a .yrd.yml`)
            await sightDrafts(seen)
            const next = await round(refreshed, asked?.draftWindow)
            seen = next
            if (next.observation.contract === "root-v1" && next.observation.outcome === "invalid") {
              ending = 2
              if (options.watchSource !== undefined) throw new Error(next.observation.message)
              app.unmount()
              io.stderr(`${next.observation.message}\n`)
            }
            eventChanges = next.eventChanges
            eventInvalid = next.eventInvalid
            journals = next.journals
            return snapshotOf(next)
          },
          loadDiff: (item) => readDiff(git, config, item),
          loadCommandOutput: (command) => Promise.resolve(readCommandOutput(command)),
          open: (item) => {
            if (item.row.state === "direct") {
              return Promise.resolve({
                row: item.row,
                run: runOf(item.row, config.target.branch, [], item.run?.id ?? item.row.run, item.run?.number),
                checks: [],
                ...(journalFor(item, journals) === undefined ? {} : { journal: journalFor(item, journals) }),
              })
            }
            const selected = eventChanges.get(item.row.branch)
            const defect = eventInvalid.get(item.row.branch)
            if (defect !== undefined) {
              return Promise.resolve({
                row: item.row,
                run: runOf(item.row, config.target.branch, [], item.run?.id ?? item.row.run, item.run?.number),
                checks: [],
                note: `Raw events: yrd queue show ${item.row.branch} --json`,
              })
            }
            if (selected === undefined) throw new Error(`event change ${item.row.branch} left the selected listing`)
            return openEventDetail(
              git,
              config,
              item,
              config.target.branch,
              repo,
              selected,
              journalFor(item, journals),
              workdir,
            )
          },
          snapshot: snapshotOf(first),
        }
        if (options.watchSource !== undefined) {
          options.watchSource(source)
          return 0
        }
        const { WatchPane } = await import("./watch-pane.tsx")
        const { run } = await import("silvery/runtime")
        const { createElement } = await import("react")
        const { WATCH_RUN_OPTIONS } = await import("./watch-run-options.ts")
        const app = await run(
          createElement(WatchPane, {
            ...source,
            snapshot: snapshotOf(first),
            intervalMs: Math.max(1, request.intervalSeconds ?? 5) * 1000,
            onEnding:
              request.terms === undefined || request.terms.length === 0
                ? undefined
                : (code) => {
                    if (ending !== undefined) return
                    ending = code
                    app.unmount()
                  },
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
      try {
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
                tmpdir: tempRoot,
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
                  : { setup: { logDir, run: config.setup, tmpdir: tempRoot } }),
              })
              result = await runCheck({
                cwd: prepared.path,
                env: options.env,
                logDir,
                spec,
                tmpdir: tempRoot,
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
          {
            checks: results,
            command: "check",
            head,
            ...(dirty === "" ? {} : { uncommitted: dirty.split("\n").length }),
          },
          `${results.map((result) => `${result.name} ${result.result} exit=${String(result.exit)} ${String(result.durationMs)} ms (log ${result.log})${result.why === undefined ? "" : `: ${result.why}`}`).join("\n")}${unjudged}`,
        )
        return results.some((result) => result.result === "stuck")
          ? 2
          : results.some((result) => result.result === "fail")
            ? 1
            : 0
      } finally {
        await sweepCheckRefs(checkGit).catch(() => [])
      }
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
      // Stats applies its own --since window to the drafts below, so it reads every draft (26014).
      const reading = await readEventListing(git, config, repo, workdir, captured.oid, eventStore, {
        all: true,
        draftWindow: "all",
      })
      if (reading.observation.contract === "root-v1" && reading.observation.outcome === "invalid") {
        io.stderr(`${reading.observation.message}\n`)
        return 2
      }
      const { journals } = reading
      // The counts below are read from the same rows; a row the journal could
      // not be read for must not make an understated stat look measured.
      if (options.json !== true) narrateMalformed(io, journals, new Set())
      // Per RUN: `queue stats` counts decisions, and one change can carry several.
      const rows = watchRows(reading.document, {
        journals,
        perRun: true,
      })
      // Pushed, never submitted: the drafts (the KPI ruling on 24163), from the
      // one derivation over this same reading and the same window. Nothing is
      // fetched, so a head never read here counts as undated.
      const draftSince = window?.since ?? new Date(now.getTime() - DEFAULT_WINDOW_MS)
      const drafts = {
        dated: reading.drafts.dated.filter((draft) => {
          if (draft.committedAt === undefined) {
            throw new Error(`event draft ${draft.branch}@${draft.head} has no committer date`)
          }
          return draft.committedAt >= draftSince
        }),
        undated: reading.drafts.undated,
      }
      const stats = queueStats(rows, [...drafts.dated, ...drafts.undated], {
        now,
        ...window,
        ...(request.by === undefined ? {} : { by: request.by }),
      })
      const name = queueName(config.target, await remoteUrl(git, config.target.remote))
      emit(io, options.json, { queue: name, ...stats }, formatQueueStats(stats, name))
      return 0
    }
    case "ls": {
      const selectedStore = statusEventStore(config.target.remote)
      if (localStatus !== undefined && (await queueFormat(selectedStore, config.target.branch)) === "legacy") {
        await refuseMissingEventMarker(config.target.remote, config.target.branch)
      }
      const reading = await readEventListing(git, config, repo, workdir, captured.oid, selectedStore, {
        all: true,
        drafts: true,
        draftWindow: "all",
      })
      if (options.json !== true) narrateMalformed(io, reading.journals, new Set())
      if (reading.observation.contract === "root-v1" && reading.observation.outcome === "invalid") return 2

      const unfiltered = watchRows(reading.all, { journals: reading.journals })
      const filtered = filterLsRows(unfiltered, request.terms ?? [])

      const queue = queueName(config.target, await remoteUrl(git, config.target.remote))
      const baseScope = `Read event change chains in ${queueRefPrefix(config.target.branch)}/changes/, branch heads at ${config.target.remote}, and direct target commits after the queue declaration.`
      const ignoreScope =
        config.ignore.length === 0
          ? undefined
          : `Excluded draft heads matching .yrd.yml ignore: ${config.ignore.map((pattern) => JSON.stringify(pattern)).join(", ")}.`
      const filteredScope =
        request.terms === undefined || request.terms.length === 0
          ? undefined
          : `${String(filtered.length)} of ${String(unfiltered.length)} change(s) match ${request.terms.join(" or ")}` +
            (filtered.length === 0 ? `. Checked ${LS_FILTER_FIELDS}.` : "")
      const scopeParts = [filteredScope, statusLine(), baseScope, ignoreScope].filter((part) => part !== undefined)
      const scope = scopeParts.length === 0 ? undefined : scopeParts.join(" ")

      const lsResult = queueLs(filtered, {
        queueName: queue,
        scope,
        now: request.now,
      })

      if (options.json === true) {
        emit(io, true, lsResult, "")
      } else {
        io.stdout(`${formatQueueLs(lsResult)}\n`)
      }

      if (request.requireMatch === true && selectedNothing(request.terms, filtered)) return 1
      return 0
    }
    case "show": {
      if (request.all === true && request.branch !== undefined) {
        io.stderr("yrd: queue show --all cannot take a branch\n")
        return 2
      }
      if (request.all === true && options.json !== true) {
        io.stderr("yrd: queue show --all requires --json\n")
        return 2
      }
      if (request.all !== true && request.branch === undefined) {
        io.stderr("yrd: queue show needs a branch or --all --json\n")
        return 2
      }
      if (options.json !== true) io.stdout(`${statusLine()}\n`)
      {
        const selectedStore = statusEventStore(config.target.remote)
        if (localStatus !== undefined && (await queueFormat(selectedStore, config.target.branch)) === "legacy") {
          await refuseMissingEventMarker(config.target.remote, config.target.branch)
        }
        const reading = await readEventListing(git, config, repo, workdir, captured.oid, selectedStore, {
          all: true,
          directHistory: request.all === true,
        })
        if (reading.observation.contract === "root-v1" && reading.observation.outcome === "invalid") {
          io.stderr(`${reading.observation.message}\n`)
          return 2
        }
        const name = queueName(config.target, await remoteUrl(git, config.target.remote))
        const branches =
          request.all === true
            ? [
                ...new Set([
                  ...reading.history.keys(),
                  ...reading.all.filter((row) => row.state !== "direct").map((row) => row.branch),
                ]),
              ].sort()
            : [request.branch as string]
        const changeHistories = branches.flatMap((branch) => {
          const selected = reading.changes.get(branch)
          const history = reading.history.get(branch)
          if (selected !== undefined && (selected.tip === undefined || history === undefined || history.length === 0)) {
            throw new Error(`event listing for ${branch} lost its selected change history`)
          }
          if (history !== undefined) {
            return history.map(({ row, events }, index) => ({
              ...row,
              queue: config.target.branch,
              events,
              ...(index === 0 ? { notices: selected?.notices ?? {} } : {}),
            }))
          }
          const row = reading.all.find((candidate) => candidate.branch === branch)
          if (row === undefined) {
            if (reading.invalid.has(branch)) throw new Error(`event listing for ${branch} lost its invalid row`)
            return []
          }
          return [
            {
              ...row,
              queue: config.target.branch,
              events: reading.invalid.get(branch)?.events ?? [],
            },
          ]
        })
        const directHistories =
          request.all === true
            ? reading.all
                .filter((row) => row.state === "direct")
                .map((row) => ({ ...row, queue: config.target.branch, events: [] }))
            : []
        const histories = [...changeHistories, ...directHistories]
        const scope =
          request.all === true
            ? `Read all event change chains in ${queueRefPrefix(config.target.branch)}/changes/ and direct target commits at ${config.target.remote}; draft branches are outside this reading.`
            : `Read ${changesRef(config.target.branch, request.branch as string)} at ${config.target.remote}; draft branches are outside this reading.`
        const views = new Map<string, Readonly<{ checks: readonly CheckView[]; note?: string }>>()
        for (const history of histories) {
          const run = reading.journals.runs.get(journalKey(history.branch, history.head))?.[0]
          const declared = await declarationFor(git, config, history.base)
          const live =
            run?.running === undefined
              ? undefined
              : {
                  name: run.running.name,
                  ...(run.running.log === undefined ? {} : { log: run.running.log }),
                }
          views.set(`${history.branch}@${history.head}`, {
            checks: checksOf([], endingOf(history), declared.checks, live, run?.checks),
            ...(declared.note === undefined ? {} : { note: declared.note }),
          })
        }
        emit(
          io,
          options.json,
          {
            ...statusFact(),
            queue: name,
            changes: histories.map((history) => {
              const view = views.get(`${history.branch}@${history.head}`)
              return {
                ...history,
                ...(view?.checks === undefined || view.checks.length === 0 ? {} : { checks: view.checks }),
                ...(view?.note === undefined ? {} : { checksNote: view.note }),
              }
            }),
            journal: journalFact(reading.journals),
            observation: reading.observation,
            scope,
          },
          histories.length === 0
            ? `no change for ${request.branch} on ${name}. ${scope}`
            : histories
                .map(({ events, ...row }, index) => {
                  const view = views.get(`${row.branch}@${row.head}`)
                  return [
                    rowLine({ row }),
                    ...(view?.note === undefined ? [] : [`  (${view.note})`]),
                    ...(view?.checks ?? []).flatMap(checkLines),
                    ...(row.diagnostic === undefined ? [] : [`  diagnostic: ${row.diagnostic}`]),
                    `  queue: ${config.target.branch}`,
                    ...events.map((event) => {
                      const at = event.props.find(([key]) => key === "Time")?.[1]
                      const reason = event.props.find(([key]) => key === "Reason")?.[1]
                      return `  ${at ?? "Time absent"} ${event.type}${event.writer == null ? "" : ` by ${event.writer}`}${reason === undefined ? "" : ` — ${reason}`}`
                    }),
                    ...(index !== 0 || request.branch === undefined || reading.changes.get(request.branch) === undefined
                      ? []
                      : eventNoticeLines(reading.changes.get(request.branch) as EventChange)),
                  ].join("\n")
                })
                .join("\n"),
        )
        return 0
      }
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

/** Where the verb journals each override notice it handed out: beside the run journals, never among them (`logs/*.jsonl` are runs). */
const OVERRIDE_NOTIFY_JOURNAL = "override-notify.jsonl"

/**
 * Hand one override notice to the declared `notify:` entries that want
 * `override`, say each outcome on stderr, and journal it. Never throws: the
 * override is written already, and the page is its side effect (@cto ccd8dfa8).
 * No entry wanting the event is said once, naming the override chain as the
 * record that stands in its place.
 */
async function tellOverride(
  context: Readonly<{
    config: QueueConfig
    git: Git
    repo: string
    targetSha: string
    workdir: string
    tempRoot: string
    env?: NodeJS.ProcessEnv
    populateReference?: boolean
  }>,
  action: "set" | "clear" | "replace",
  entry: OverrideEntry,
  io: YrdCliIO,
): Promise<readonly Readonly<{ name: string; delivery: string; failure?: string }>[]> {
  const { config } = context
  const notice = overrideNotice(entry, action, `${config.target.branch}@${context.targetSha}`)
  let handed: readonly Readonly<{ name: string; delivery: string; failure?: string }>[]
  try {
    handed = await notifyOutsideRound(
      {
        git: context.git,
        notify: config.notify,
        repo: context.repo,
        targetSha: context.targetSha,
        workdir: context.workdir,
        tempRoot: context.tempRoot,
        ...(config.setup === undefined ? {} : { setup: config.setup }),
        ...(context.env === undefined ? {} : { env: context.env }),
        ...(context.populateReference === undefined ? {} : { populateReference: context.populateReference }),
      },
      notice,
    )
  } catch (error) {
    handed = [{ delivery: "failed", failure: error instanceof Error ? error.message : String(error), name: "notify" }]
  }
  for (const told of handed) {
    if (told.delivery === "none") {
      io.stderr(
        `yrd: no notify entry in .yrd.yml wants override events, so nobody was told; the override's own record ${entry.record.slice(0, 12)} is the notice\n`,
      )
    } else if (told.delivery === "failed") {
      io.stderr(
        `yrd: could not tell ${told.name} about the override (it stands): ${told.failure ?? "no reason given"}\n`,
      )
    }
  }
  try {
    appendFileSync(
      join(context.workdir, OVERRIDE_NOTIFY_JOURNAL),
      `${JSON.stringify({ at: new Date().toISOString(), notice, told: handed })}\n`,
    )
  } catch (error) {
    io.stderr(
      `yrd: could not journal the override notice in ${join(context.workdir, OVERRIDE_NOTIFY_JOURNAL)}: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
  return handed
}

function runOptions(
  repo: string,
  declared: Readonly<{ config: QueueConfig; oid: string }>,
  workdir: string,
  tempRoot: string,
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
    // `derive:` regenerates what the merged gitlinks decide, inside the queue's compose (27176).
    ...(config.derive === undefined ? {} : { derive: config.derive }),
    teardown: config.teardown,
    target: config.target,
    targetSha: oid,
    tempRoot,
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
    case "run": {
      // Every merge check an override held off this round, in the header's own
      // line: a round judged with a check off says so before any change does (25296 C5).
      const overrides = Array.isArray(rest.overrides) ? rest.overrides.map(String) : []
      return (
        `queue run at ${String(rest.target)} ${String(rest.gitlink).slice(0, 12)}` +
        (overrides.length === 0 ? "" : `; merge check ${overrides.join("; ")}`)
      )
    }
    case "skipped":
      return `${where}: merge check ${String(rest.check)} skipped: override ${String(rest.record).slice(0, 12)} by ${String(rest.by)}${rest.verified === true ? "" : " (claimed)"} until ${String(rest.until)}`
    case "override":
      return `merge check ${String(rest.check)} override ${String(rest.record)}: ${String(rest.reason)}`
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
    case "branch-deleted":
      return `${where}: deleted the merged task branch on origin`
    case "branch-kept":
      return `${where}: kept the merged task branch on origin; the lease saw ${String(rest.saw)}`
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
    branches?: readonly string[]
    failed: readonly string[]
    stuck: readonly string[]
    directMerges: readonly string[]
    log: string
    stopped?: Readonly<{ says: string }>
    observation: GitObservation
    noCheck?: boolean
  }>,
): string {
  const words = ["pass", "fail", "stuck"][outcome.exitCode] ?? String(outcome.exitCode)
  const parts = [
    outcome.merged.length > 0
      ? `${STATE_WORDS.merged.word} ${outcome.merged.join(", ")}${outcome.noCheck === true ? " (checks skipped: --no-check)" : ""}`
      : undefined,
    ...(outcome.branches ?? []),
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
 * in the same call (event-run.ts), so this is that run's own record of why, never a
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
      // Every stuck ending writes a complete incident (event-run.ts `writeStuck`);
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
/**
 * The line's flow once a round has ended (25669). The round's own reading of the
 * line wins: how many wait, the oldest of them, and the last judgement it read
 * off the chains. A change this round merged, failed or recorded stuck is a
 * judgement at the round's end, which the chains the round read before acting
 * cannot yet show. A round that ended before reading its line (a paused line)
 * keeps the last reading. No round is open any more.
 */
export function flowAfterRound(
  previous: LineFlow | undefined,
  outcome: QueueRunOutcome,
  now: Date,
): LineFlow | undefined {
  // The line as this round read it, or as the last round that read it did; a
  // round that read nothing (a paused line, a legacy-format round) moves no count.
  const read =
    outcome.line === undefined
      ? previous === undefined
        ? undefined
        : { oldest: previous.oldestWaiting, waiting: previous.waiting }
      : { oldest: outcome.line.oldest, waiting: outcome.line.waiting }
  if (read === undefined) return undefined
  const ended = now.toISOString()
  const judgedNow = outcome.merged.length + outcome.failed.length + outcome.stuck.length > 0
  const lastJudgedAt = [outcome.line?.lastJudgedAt, judgedNow ? ended : undefined, previous?.lastJudgedAt]
    .filter((at): at is string => at !== undefined)
    .reduce<string | undefined>((latest, at) => (latest === undefined || at > latest ? at : latest), undefined)
  const oldestWaiting = read.oldest
  return {
    waiting: read.waiting,
    lastRoundEndedAt: ended,
    ...(oldestWaiting === undefined ? {} : { oldestWaiting }),
    ...(lastJudgedAt === undefined ? {} : { lastJudgedAt }),
    ...(outcome.line?.casRefused !== undefined
      ? { casRefused: outcome.line.casRefused }
      : previous?.casRefused !== undefined &&
          previous.casRefused.site === undefined &&
          previous.casRefused.branch !== undefined &&
          !outcome.merged.includes(previous.casRefused.branch)
        ? { casRefused: previous.casRefused }
        : {}),
  }
}

/** A pre-line event transaction failed; preserve only facts the service actually read. */
export function flowAfterRetryExhaustion(
  previous: LineFlow | undefined,
  error: QueueRunEventRetryExhausted,
  now: Date,
): LineFlow {
  const same = previous?.casRefused?.ref === error.ref && previous.casRefused.marker === error.marker
  return {
    ...(previous?.waiting === undefined ? {} : { waiting: previous.waiting }),
    ...(previous?.oldestWaiting === undefined ? {} : { oldestWaiting: previous.oldestWaiting }),
    ...(previous?.lastJudgedAt === undefined ? {} : { lastJudgedAt: previous.lastJudgedAt }),
    lastRoundEndedAt: now.toISOString(),
    casRefused: {
      ref: error.ref,
      marker: error.marker,
      count: error.count,
      site: error.site,
      budgetMs: error.budgetMs,
      firstAt: same ? (previous.casRefused.firstAt ?? error.firstAt) : error.firstAt,
      ...(error.windowExhausted === undefined ? {} : { windowExhausted: error.windowExhausted }),
    },
  }
}

/** What the newest run journal says the open round is doing: its step and change, or why it cannot say. */
export async function roundPhase(
  workdir: string,
  since: Date,
): Promise<
  Readonly<{ open: Readonly<{ phase: string; branch?: string } | { phaseUnread: string }>; line?: RoundLine }>
> {
  try {
    const facts = await readRunnerFacts(workdir)
    const latest = facts.latest
    // A journal older than the round is a previous run's: it says nothing about this one.
    const current = latest !== undefined && latest.startedAt.getTime() >= since.getTime() - 1_000 ? latest : undefined
    const line = current?.line === undefined ? {} : { line: current.line }
    const step = current?.activeStep
    if (step === undefined) {
      const why =
        facts.absent ??
        (current === undefined
          ? `the newest run journal (${latest?.id ?? "none"}) predates this round, which started ${since.toISOString()}`
          : "the round's journal names no open step")
      return { open: { phaseUnread: why }, ...line }
    }
    return {
      open: { phase: `${step.phase} ${step.name}`, ...(step.branch === undefined ? {} : { branch: step.branch }) },
      ...line,
    }
  } catch (error) {
    return {
      open: {
        phaseUnread: `the run journal could not be read: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
}

export function sleepAfter(outcome: QueueRunOutcome, intervalMs: number): number {
  const ready = outcome.merged.length > 0 || outcome.checkedWaiting > 0
  return ready ? Math.min(intervalMs, READY_SLEEP_MS) : intervalMs
}

/** One printed round of the text watch, with `updated HH:MM:SS` under the queue's name (item 30). */
function stampRound(text: string, queue: string, at: Date): string {
  const stamp = `updated ${clock(at)}`
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

/** Open exactly the event tip shown in the table, including every event in its history. */
export async function openEventDetail(
  git: Git,
  config: QueueConfig,
  item: WatchRow,
  label: string,
  repo: string,
  selected: EventChange,
  journal?: JournalRun,
  workdir?: string,
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
  const events = await readChangeEvents(
    createEventStore(repo, config.target.remote, selectionFor(git)),
    label,
    row.branch,
    selected.tip,
  )
  const opened = events.findLastIndex((event) => event.type === "opened")
  const segment = (opened === -1 ? events : events.slice(opened)).filter((event) => event.type !== "adopted")
  const values = (key: string): readonly string[] =>
    segment.flatMap((event) => event.props.filter(([name]) => name === key).map(([, value]) => value))
  const packed = values("Check")
  const source = values("Migrated-From").at(-1)
  const noMigratedChecks = source !== undefined && packed.length === 0
  const declared = noMigratedChecks
    ? undefined
    : await declarationFor(git, config, values("Base").at(-1) ?? selected.adoptedBase ?? row.base)
  const decided = row.state === "merged" || row.state === "failed" || row.state === "stuck" || row.state === "cancelled"
  const views =
    declared === undefined
      ? []
      : checksOf(
          packed,
          endingOf(row),
          declared.checks,
          row.live === undefined
            ? undefined
            : { name: row.live.check, ...(row.live.log === undefined ? {} : { log: row.live.log }) },
          decided ? undefined : item.run?.checks,
        )
  const note =
    noMigratedChecks && source !== undefined
      ? `Migrated change has no check-step detail in its event history. Retained legacy record: ${source}. Old check logs: ${join(workdir ?? (await workdirOf(git)), "checks", changeName({ branch: row.branch, head: row.head }))} (if present on this machine).`
      : declared?.note
  return {
    row,
    run: runOf(row, label, views, item.run?.id ?? row.run, item.run?.number),
    checks: views.map(readOutput),
    events,
    ...(journal === undefined ? {} : { journal }),
    ...(await headFacts(git, config, row)),
    ...(note === undefined ? {} : { note }),
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
    unfiltered: readonly WatchRow[]
    queue: string
    queues: readonly WatchQueue[]
    pause?: string
    journalAbsent?: string
    observation: GitObservation
    runner: RunnerFacts
    decisions: readonly RunDecision[]
    stopped: StopFact | null
    overrides?: readonly OverrideFact[]
    drafts?: Readonly<{ window: DraftWindow; unread: readonly string[]; older: number }>
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
    ...(round.overrides === undefined ? {} : { overrides: round.overrides }),
    ...(round.drafts === undefined
      ? {}
      : { drafts: { unread: round.drafts.unread.length, window: round.drafts.window, older: round.drafts.older } }),
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
/**
 * One git command's output from the round's raw files (25441): stdout, then
 * stderr, each tail-limited like a check's log and cut at a line boundary, so
 * the first line shown is a whole one. The row is written when the command has
 * finished, so these files are complete. Missing here means this is not the
 * machine the queue runs on, and the sentence says where it looked.
 */
export function readCommandOutput(command: JournalCommand): DiffText {
  if (command.stdout === undefined) {
    return { why: command.failure ?? "the journal names no output file for this command" }
  }
  const parts: string[] = []
  for (const path of [command.stdout, command.stderr]) {
    if (path === undefined) continue
    let bytes: Buffer
    try {
      bytes = readFileSync(path)
    } catch (error) {
      return {
        why:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `no output at ${path} on this machine; the queue writes its journal where it runs`
            : `the output at ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    let text = bytes.toString("utf8")
    if (bytes.length > LOG_TAIL_BYTES) {
      const tail = bytes.subarray(bytes.length - LOG_TAIL_BYTES).toString("utf8")
      const firstBreak = tail.indexOf("\n")
      text = firstBreak === -1 ? tail : tail.slice(firstBreak + 1)
    }
    const clean = stripAnsi(text).trimEnd()
    if (clean !== "") parts.push(clean)
  }
  return { text: parts.join("\n") }
}

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

const CHECK_GLYPH: Readonly<Record<CheckView["state"], string>> = {
  deferred: "\u263e",
  failed: "\u00d7",
  passed: "\u2713",
  running: "\u25c9",
  "not-run": "\u2212",
  stuck: "\u25cc",
  off: "\u2212",
  skipped: "\u2212",
  unmeasured: "\u2212",
}

function checkLines(check: CheckView): readonly string[] {
  const exit = check.result?.exit === undefined ? "" : ` exit=${check.result.exit}`
  const ms = check.result?.ms === undefined ? "" : ` ${mediaDuration(check.result.ms)}`
  const log =
    (check.state === "running" ? readOutput(check).why : undefined) ??
    (check.log === undefined ? undefined : `log ${check.log}`)
  const state =
    check.state === "not-run"
      ? " NOT RUN"
      : check.state === "off"
        ? " off"
        : check.state === "running"
          ? " running"
          : check.state === "unmeasured"
            ? " unmeasured — no result recorded"
            : ""
  return [
    `  ${CHECK_GLYPH[check.state]} ${check.name}${state}${exit}${ms}`,
    check.spec === undefined ? "      (the declaration does not name this check)" : `      $ ${check.spec.run}`,
    ...(log === undefined ? [] : [`      ${log}`]),
  ]
}

/** Whether an event change in this state holds a place in line. */
function inLineState(state: Row["state"]): boolean {
  return state === "queued" || state === "stuck" || state === "verifying" || state === "checking" || state === "merging"
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
    states.some((state) => state === "queued" || state === "verifying" || state === "checking" || state === "merging")
  ) {
    return undefined
  }
  if (states.some((state) => state === "stuck")) return 2
  if (states.some((state) => state === "failed" || state === "cancelled")) return 1
  return 0
}

/** The URL a remote NAME stands for, which is what the queue calls itself to a stranger (config.ts). */

/** Preserve the run selected by this row's join, including the collapsed latest lens. */
function journalFor(item: WatchRow, journals: Journals): JournalRun | undefined {
  if (item.run !== undefined) return item.run
  const runId = item.row.run ?? item.row.live?.run
  if (runId === undefined) return undefined
  const runs = journals.runs.get(journalKey(item.row.branch, item.row.head))
  if (runs === undefined || runs.length === 0) return undefined
  return runs.find((run) => run.id === runId)
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
    const line = `yrd: run journal ${defect.run} has a row that could not be read for ${defect.key}: ${defect.message}; the row was skipped — fix the writer (26230)\n`
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
function endingOf(row: Row): "merged" | "failed" | "stuck" | "open" {
  return row.state === "merged" || row.state === "failed" || row.state === "stuck" ? row.state : "open"
}

function areRefMapsEqual(
  a: ReadonlyMap<string, string> | undefined,
  b: ReadonlyMap<string, string> | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a.size !== b.size) return false
  for (const [key, val] of a) {
    if (b.get(key) !== val) return false
  }
  return true
}

export type EventListingResult = Readonly<{
  format: "event"
  /** One status claim read with the queue refs, outside change authority and observation fences. */
  runnerTip?: string
  all: readonly Row[]
  document: readonly Row[]
  history: ReadonlyMap<string, readonly EventHistoryRow[]>
  journals: Journals
  drafts: DraftReading
  pause: PauseRecord | undefined
  overrides: OverrideTable
  changes: ReadonlyMap<string, EventChange>
  invalid: Awaited<ReturnType<typeof readEventQueueWithChanges>>["invalid"]
  observation: GitObservation
}>

type EventHistoryRow = Readonly<{
  row: Row
  events: readonly (Pick<Event, "id" | "type" | "props" | "links"> & Partial<Pick<Event, "writer">>)[]
}>

interface EventListingCache {
  queuePrefix: string
  queueRefs: ReadonlyMap<string, string>
  targetOid: string
  branchRefs: ReadonlyMap<string, string>
  lastHeadListingAt: number
  reading: EventListingResult
  draftWindow?: DraftWindow
}

const eventListingCaches = new Map<string, EventListingCache>()

/** Reset the process-wide event listing cache (for tests). */
export function clearEventListingCache(): void {
  eventListingCaches.clear()
}

/** Read an event queue through Gitomic and project its change chains and draft branch heads. */
export async function readEventListing(
  git: GitRunner,
  config: QueueConfig,
  repo: string,
  workdir: string,
  targetOid: string,
  store: QueueReadStore,
  options: Readonly<{
    all?: boolean
    directHistory?: boolean
    drafts?: boolean
    now?: number | Date
    forceFresh?: boolean
    draftWindow?: DraftWindow
  }> = {},
): Promise<EventListingResult> {
  const queuePrefix = `${queueRefPrefix(config.target.branch)}/`
  const runnerRefName = `${queueRefPrefix(config.target.branch)}/runner`
  const changePrefix = `${queuePrefix}changes/`
  const cacheKey = `${repo}#${config.target.remote}#${config.target.branch}#all:${options.all === true}#directHistory:${options.directHistory === true}#drafts:${options.drafts === true}`
  const cache = eventListingCaches.get(cacheKey)
  const nowMs =
    typeof options.now === "number" ? options.now : options.now instanceof Date ? options.now.getTime() : Date.now()
  const draftWindow = options.draftWindow ?? "7d"
  const draftWindowChanged = cache !== undefined && cache.draftWindow !== draftWindow

  const observe = async (qRefs: ReadonlyMap<string, string>, bRefs: ReadonlyMap<string, string>) =>
    git.observe({
      version: 1,
      root: {
        remote: await remoteUrl(git, config.target.remote),
        targetRef: `refs/heads/${config.target.branch}`,
        targetOid,
      },
      checked: [],
      fence: {
        // The runner beats independently. The observer compares every selected
        // prefix against the remote, so the broad queue prefix would still
        // fence the runner even after removing it from refs below.
        prefixes: [
          ...new Set([
            "refs/heads/",
            changePrefix,
            ...[...qRefs.keys()].filter((ref) => !ref.startsWith(changePrefix)),
          ]),
        ],
        refs: [...qRefs, ...bRefs].map(([ref, oid]) => ({ ref, oid })),
      },
    })

  // 1. Fetch event refs first
  const listedRefs = await listRefs(queuePrefix, store)
  const runnerTip = listedRefs.get(runnerRefName)
  // A heartbeat moves on its own cadence. It must not invalidate change-state
  // caching or make an otherwise stable Git observation fence fail.
  const queueRefs = new Map([...listedRefs].filter(([ref]) => ref !== runnerRefName))

  const eventRefsUnchanged =
    cache !== undefined && cache.targetOid === targetOid && areRefMapsEqual(cache.queueRefs, queueRefs)

  const headListingRecent = cache !== undefined && nowMs - cache.lastHeadListingAt < 60_000

  const firstUndatedHead = cache?.reading.drafts.undated[0]?.head
  const undatedDraftsFetched =
    firstUndatedHead !== undefined &&
    (await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${firstUndatedHead}\n`).then(
      (output) => output.trim().endsWith(" commit"),
      () => false,
    ))

  let openBranchDeleted = false
  if (cache !== undefined && eventRefsUnchanged && headListingRecent) {
    for (const [branch, change] of cache.reading.changes) {
      if (isOpen(change.status)) {
        const openedAt = change.since?.getTime() ?? 0
        if (nowMs - openedAt >= 60_000) {
          const branchRef = `refs/heads/${branch}`
          if (cache.branchRefs.has(branchRef)) {
            const current = await listRefs(branchRef, store)
            if (current.size === 0) {
              openBranchDeleted = true
              break
            }
          }
        }
      }
    }
  }

  // 2. An unchanged event-ref fetch reuses the last round if head listing is recent
  if (
    options?.forceFresh !== true &&
    eventRefsUnchanged &&
    headListingRecent &&
    !openBranchDeleted &&
    !undatedDraftsFetched &&
    !draftWindowChanged
  ) {
    return {
      ...cache.reading,
      ...(runnerTip === undefined ? { runnerTip: undefined } : { runnerTip }),
      observation: await observe(cache.queueRefs, cache.branchRefs),
      journals: readJournals(join(workdir, "logs")),
    }
  }

  // 3. Head listing: runs at most once a minute, or when event-ref fetch reports a change
  let branchRefs: ReadonlyMap<string, string>
  let headListingAt: number
  if (
    options?.forceFresh === true ||
    !eventRefsUnchanged ||
    !headListingRecent ||
    openBranchDeleted ||
    draftWindowChanged
  ) {
    branchRefs = await listRefs("refs/heads/", store)
    headListingAt = nowMs
  } else {
    branchRefs = cache.branchRefs
    headListingAt = cache.lastHeadListingAt
  }

  // If event refs were unchanged and branch heads also didn't change:
  if (
    options?.forceFresh !== true &&
    eventRefsUnchanged &&
    !openBranchDeleted &&
    areRefMapsEqual(cache?.branchRefs, branchRefs) &&
    !undatedDraftsFetched &&
    !draftWindowChanged
  ) {
    cache.lastHeadListingAt = headListingAt
    return {
      ...cache.reading,
      ...(runnerTip === undefined ? { runnerTip: undefined } : { runnerTip }),
      observation: await observe(cache.queueRefs, branchRefs),
      journals: readJournals(join(workdir, "logs")),
    }
  }

  // 4. Full read
  const { queue, histories, invalid } = await readEventQueueWithChanges(store, config.target.branch)
  const changes = new Map([...histories].map(([branch, history]) => [branch, history.state]))
  const directMerges = await eventDirectMergeCommits(
    git,
    config.target.branch,
    targetOid,
    queue.declaration,
    histories,
    new Set(),
    { allHistory: options.directHistory },
  )
  assertEventListingFence(config.target.branch, queue, changes, queueRefs, invalid)
  const listNow =
    options.now instanceof Date ? options.now : options.now !== undefined ? new Date(options.now) : new Date()
  const heads = new Map([...branchRefs].map(([ref, oid]) => [ref.slice("refs/heads/".length), oid]))
  const since = draftWindow === "all" ? undefined : new Date(listNow.getTime() - 7 * 24 * 60 * 60 * 1000)
  const drafts = await readDrafts(
    git,
    withoutIgnoredDraftHeads(
      {
        heads: new Map([...heads].filter(([branch]) => !invalid.has(branch))),
        changes: [...changes].flatMap(([branch, change]) =>
          change.commit === undefined ? [] : [{ change: { branch, head: change.commit } }],
        ),
      },
      config.ignore,
    ),
    { targetSha: targetOid, since },
  )
  // Status comes only from the event fold (25041): a change whose branch is gone stays open
  // until a queue round records its ending, so a reader never shows a state no event holds.
  const segmentsByBranch = new Map(
    [...histories].map(
      ([branch, history]) =>
        [branch, enumerateChangeSegments(history.events, changesRef(config.target.branch, branch), repo)] as const,
    ),
  )
  const segmentStates = new Map(
    [...segmentsByBranch].map(([branch, segments]) => [branch, segments.map((segment) => segment.state)] as const),
  )
  const historyRows = new Map(
    [...segmentsByBranch].map(
      ([branch, segments]) =>
        [
          branch,
          segments
            .map((segment, index): EventHistoryRow => {
              const projected = eventRows(new Map([[branch, segment.state]]))[0]
              if (projected === undefined) {
                throw new Error(`event change ${branch} lost opened segment ${segment.opened}`)
              }
              const { position: _position, ...historical } = projected
              return { row: index === segments.length - 1 ? projected : historical, events: segment.events }
            })
            .reverse(),
        ] as const,
    ),
  )
  const draftsToInclude = draftWindow === "all" ? [...drafts.dated, ...drafts.undated] : drafts.dated
  const selected = eventListRows(segmentStates, draftsToInclude, {
    all: options.all,
    drafts: options.drafts,
    now: listNow,
  })
  const invalidRows: Row[] = [...invalid].map(([branch, defect]) => ({
    branch,
    head: defect.tip,
    state: "invalid",
    format: "event",
    ref: defect.ref,
    tip: defect.tip,
    error: defect.error,
    diagnostic: `${defect.ref}@${defect.tip}: ${defect.error}`,
    subject: defect.error,
  }))
  const directRows: Row[] = directMerges
    .filter((commit) => options.all === true || listNow.getTime() - commit.at.getTime() <= 7 * 24 * 60 * 60 * 1000)
    .map(
      (commit): Row => ({
        at: commit.at,
        head: commit.commit,
        branch: commit.target,
        reason: directMergeLine(commit),
        state: "direct",
        subject: commit.subject,
      }),
    )
    .sort((left, right) => (right.at?.getTime() ?? 0) - (left.at?.getTime() ?? 0))
  const projected = [...selected.table, ...selected.document, ...directRows]
  const titles = await subjects(
    git,
    projected.map((row) => row.head),
  )
  const titled = (rows: readonly Row[]) =>
    rows.map((row) => ({
      ...row,
      ...(row.state === "invalid" || titles.get(row.head) === undefined ? {} : { subject: titles.get(row.head) }),
    }))
  const titledHistory = new Map(
    [...historyRows].map(
      ([branch, entries]) =>
        [branch, entries.map(({ row, events }) => ({ row: titled([row])[0] as Row, events }))] as const,
    ),
  )
  const all = titled([...selected.table, ...invalidRows, ...directRows])
  const document = titled([...selected.document, ...invalidRows, ...directRows])
  const observation = await observe(queueRefs, branchRefs)
  const operational = await readEventOps(store, git, config.target.branch, targetOid)
  if (operational.queue.tip !== queue.tip) {
    throw new Error(
      `${queueRef(config.target.branch)} moved from ${queue.tip} to ${operational.queue.tip} during listing; retry the read`,
    )
  }
  const reading: EventListingResult = {
    format: "event",
    ...(runnerTip === undefined ? {} : { runnerTip }),
    all,
    document,
    history: titledHistory,
    journals: readJournals(join(workdir, "logs")),
    drafts,
    pause: operational.stop,
    overrides: operational.overrides,
    changes,
    invalid,
    observation,
  }

  eventListingCaches.set(cacheKey, {
    queuePrefix,
    queueRefs,
    targetOid,
    branchRefs,
    lastHeadListingAt: headListingAt,
    reading,
    draftWindow,
  })

  return reading
}

/** A history read and its final observation must name the same event tips. */
export function assertEventListingFence(
  name: string,
  queue: Pick<EventQueue, "tip">,
  changes: ReadonlyMap<string, EventChange>,
  advertised: ReadonlyMap<string, string>,
  invalid: ReadonlyMap<string, Readonly<{ ref: string; tip: string }>> = new Map(),
): void {
  const expected = new Map<string, string>([[queueRef(name), queue.tip]])
  for (const [branch, change] of changes) {
    if (change.tip === undefined) throw new Error(`event change ${branch} has no selected chain tip`)
    expected.set(changesRef(name, branch), change.tip)
  }
  for (const defect of invalid.values()) expected.set(defect.ref, defect.tip)
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

/** Prefilter only advertised draft heads; a submitted change remains in the listing. */
function withoutIgnoredDraftHeads(
  source: Parameters<typeof readDrafts>[1],
  patterns: readonly string[],
): Parameters<typeof readDrafts>[1] {
  if (patterns.length === 0) return source
  const globs = patterns.map((pattern) => new Bun.Glob(pattern))
  return {
    heads: new Map([...source.heads].filter(([branch]) => !globs.some((glob) => glob.match(branch)))),
    changes: source.changes,
  }
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

function formatDryRunGitlinks(gitlinks: readonly SubmitGitlink[] | undefined): string {
  if (gitlinks === undefined || gitlinks.length === 0) return ""
  const moved = gitlinks.filter(
    (row): row is Extract<SubmitGitlink, { state: Exclude<SubmitGitlink["state"], "not-run"> }> =>
      row.state !== "not-run",
  )
  if (moved.length === 0) return ""
  return moved
    .map((row) => {
      const authorHead = row.authorHead.slice(0, 12)
      const landingPin = row.landingPin.slice(0, 12)
      let note = ""
      if (row.state === "merged") {
        note = " (component merge happens at land)"
      } else if (row.state === "kept-ahead") {
        note = " (lands directly)"
      } else if (row.state === "raised") {
        note = " (raised to target)"
      } else if (row.state === "kept-behind") {
        note = " (kept behind)"
      } else if (row.state === "as-written") {
        note = " (as written)"
      } else if (row.state === "left-off-main") {
        note = " (left off main)"
      }
      return `\ncomponent ${row.path}: author head ${authorHead}, landing pin ${landingPin}${note}`
    })
    .join("")
}
