/** Run a change from the event projection, leasing its merge with the queue. */
import { mkdirSync, readFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { readCommitSubmodules } from "git-super/commit-graph"
import { Conflict, PublicationRejected, RetriesExhausted, openEvents, trailer } from "./git.ts"
import {
  isTransientPushHold,
  matchTransientPush5xx,
  publishWithTransientRetry,
  transientPush5xxOf,
  TRANSIENT_PUSH_HOLD,
  type TransientPush5xx,
  type TransientPushAttempt,
} from "./transient-push.ts"
import { readEventChain, readRetainedEvent } from "./event-read.ts"

import {
  appendChangeEvent,
  appendNumberedChangeEvent,
  appendNumberedPublishedMerge,
  appendPublishedMerge,
  changesRef,
  enumerateChangeSegments,
  expireQueueOverrides,
  EVENT_TRAILERS,
  isOpen,
  listChangeHistories,
  readChangeEvents,
  queueResumedAfter,
  queueRef,
  readEventOps,
  readEventQueueWithChain,
  readStatus,
  QUEUE_RUN_WRITER,
  writeQueueEvent,
  type EventCheck,
  type EventChange,
  type EventQueue,
  type NotifyFloor,
} from "./events.ts"
import { eventRows } from "./event-table.ts"
import { assertPlainEventQueueRun } from "./event-config.ts"
import { eventDirectMergeCommits } from "./direct.ts"
import { createEventStore, selectionFor, listRefs, seamProcess, type Event } from "./git.ts"
import {
  checkLogPath,
  effectiveCheckTimeoutMs,
  readCheckTrailer,
  runCheck,
  TRANSPORT_RETRY_LIMIT,
  type CheckResult,
} from "./check.ts"
import { InvalidQueueConfig, UnknownConfigKey, queueName, readConfig } from "./config.ts"
import {
  isAncestor,
  offTheTarget,
  readRemoteCommit,
  type Git,
  type GitInvocationOptions,
  type GitRunner,
} from "./git.ts"
import {
  recentCasRefusalStreak,
  recentCasRefusals,
  recentPublicationNotLanded,
  recentPublicationRejected,
  type QueueRunLog,
} from "./log.ts"
import {
  ProgramSubjectSetupFailed,
  programRootCheck,
  recordProgramEnd,
  recordProgramResult,
  recordProgramStart,
  recordProgramVerdict,
  recordSynthesizedPassResults,
} from "./program-root.ts"
import { queueRefPrefix, runIndexRef } from "./refs.ts"
import { verifyCandidate } from "./verifying.ts"
import { revertedPathsFinding, revertedPathsReason, revertGuardAction } from "./revert-guard.ts"
import { publishCheckedChildren } from "./publication.ts"
import { withRemoteSeam, withRemoteSeamGap } from "./remote-calls.ts"
import { SETUP, SetupFailed, discardWorktree } from "./worktree.ts"
import { installInputsChanged } from "./install-inputs.ts"
import { WorktreePool } from "./pool.ts"
import { DERIVE, DeriveFailed } from "./derive.ts"
import {
  allDeclaredChecksOff,
  QueueAuthorityUnreadable,
  restoreScripts,
  short,
  timedStep,
  type QueueRunOptions,
  type QueueRunOutcome,
  type RoundLine,
} from "./run.ts"
import {
  dispatchNotifications,
  isChargedFailure,
  messageFor,
  notifyOutsideRound,
  overrideNotice,
  sameFailureDetail,
  sameFailureReason,
} from "./with-notify.ts"
import { changeName } from "./refs.ts"
import { setupStuckCode, setupStuckNext, transportFaultIn } from "./setup-transport.ts"
import { incidentTrailers, type Incident } from "./incident.ts"
import { readRootChanges } from "./root-changes.ts"
import { mergedBy } from "./git.ts"
import { settledBaseCommit } from "./settled-base.ts"
import { narrowingOf } from "./narrowing.ts"

function endingTime(event: Event, context: string): string {
  const time = event.props.find(([key]) => key === EVENT_TRAILERS.time)?.[1]
  if (time === undefined || !Number.isFinite(Date.parse(time))) {
    throw new Error(`${context}: ending event ${event.id} has no valid Time`)
  }
  return time
}

/**
 * The failing checks' identity for a notice: every failing `Check:` row's name,
 * exit and verdict, with the volatile fields (attempt, phase, ms, log) dropped,
 * sorted by name and joined with `; ` (24735 row 5). All of them, so row order
 * never changes the identity. Absent when the ending carries no failing row,
 * where the comparison stays on the `reason`.
 */
function failureIdentity(event: Event): string | undefined {
  // A validated event's rows always carry exit and result (`checkedRows` in
  // events.ts refuses one that does not), so the fallback below is unreachable.
  const identities = event.props
    .filter(([key]) => key === EVENT_TRAILERS.check)
    .map(([, value]) => readCheckTrailer(value))
    .filter((row) => row.result === "fail")
    .map((row) => `${row.name} exit=${row.exit ?? ""} result=${row.result ?? ""}`)
  if (identities.length === 0) return undefined
  return [...identities].sort((left, right) => left.localeCompare(right)).join("; ")
}

/** Exact set equality between a declared name set and a recorded name list. */
function sameNameSet(declared: ReadonlySet<string>, recorded: readonly string[]): boolean {
  return declared.size === recorded.length && recorded.every((name) => declared.has(name))
}

/**
 * Every ending id already stamped exactly at `instant` (27198): branch endings
 * from the change histories AND the queue's own `observed` direct-merge events.
 * This is the tie set a freshly added notify entry mints with, so an ending at
 * the boundary is judged by whether it existed at the mint or arrived after it.
 */
function stampedEndingIds(
  instant: Date,
  histories: ReadonlyMap<string, Readonly<{ events: readonly Event[] }>>,
  queueEvents: readonly Event[],
): ReadonlySet<string> {
  const iso = instant.toISOString()
  const stamped = (event: Event): boolean => event.props.find(([key]) => key === EVENT_TRAILERS.time)?.[1] === iso
  const ids = new Set<string>()
  for (const event of queueEvents) {
    if (event.type === "observed" && stamped(event)) ids.add(event.id)
  }
  for (const history of histories.values()) {
    for (const event of history.events) if (stamped(event)) ids.add(event.id)
  }
  return ids
}
import { repairMissingBranchHeads } from "./remote.ts"
import { isActive } from "./override.ts"
import { QueuePaused, stuckCures } from "./pause.ts"

const DEFAULT_QUEUE_RUN_RETRY_BUDGET_MS = 5_000
// If all journals are live service rounds at its 120s interval, 128 cover
// 4h16m, over 42 times the three-refusal page threshold. Manual runs and check
// journals can shorten the span, so exhaustion is named, never a clean reset.
const CAS_HISTORY_BUDGET_NAME = "cas-history-journals"
const CAS_HISTORY_JOURNAL_BUDGET = 128
type ExhaustedCasHistory = NonNullable<ReturnType<typeof recentCasRefusalStreak>["windowExhausted"]>

/** A definite no-progress event-chain refusal at one of the run's own transaction sites. */
export class QueueRunEventRetryExhausted extends Error {
  override readonly name = "QueueRunEventRetryExhausted"

  constructor(
    readonly site: "notified" | "expire-overrides" | "observed" | "stuck-release" | "notify-floors",
    readonly ref: string,
    readonly marker: string,
    readonly count: number,
    readonly budgetMs: number,
    readonly firstAt: string,
    cause: RetriesExhausted,
    readonly windowExhausted?: ExhaustedCasHistory,
  ) {
    const history =
      windowExhausted === undefined
        ? `${count} consecutive rounds`
        : `at least ${count} consecutive rounds; first observed at ${firstAt}; earlier refusals may lie beyond ` +
          `the ${windowExhausted.name} budget (${windowExhausted.journals} journals), oldest read ${windowExhausted.oldestFile}`
    super(`${ref} at ${marker}: ${site} did not land within ${budgetMs}ms (${history})`, { cause })
  }
}

/** An obsolete authority ref must be removed before this queue can judge a round. */
export class LegacyOverridePresent extends Error {
  override readonly name = "LegacyOverridePresent"

  constructor(
    readonly ref: string,
    readonly oid: string,
  ) {
    super(`legacy override ref ${ref} at ${oid} remains; @chief must verify, fold or delete it`)
  }
}

/**
 * The change-ref event publication exhausted its in-round 5xx retry budget (28793).
 *
 * Reported, not thrown past the round: the change loop's catch maps it to a HOLD
 * (exit 0 + unhealthy health doc) in ONE place, never exit 2, so a persistent
 * remote error cannot stop a supervised line. The event that would record a stuck
 * status rides the SAME atomic push that just failed, so this hold is recorded
 * locally only and the queue retries the publication on its own cadence.
 */
class ChangeRefPublicationHeld extends Error {
  override readonly name = "ChangeRefPublicationHeld"

  constructor(
    readonly branch: string,
    readonly marker: string,
    readonly ref: string,
    readonly hit: TransientPush5xx,
    options: { cause: unknown },
  ) {
    super(
      `${branch}: ${TRANSIENT_PUSH_HOLD} on the change-ref publication for ${ref} at ${marker}: ${hit.line}`,
      options,
    )
  }
}

function discardedJudgementReason(current: EventChange, error: unknown): string {
  const failed = error instanceof Error ? error.message : String(error)
  return current.ending === undefined
    ? `change advanced to ${current.status} at ${current.tip ?? "no tip"} while this round judged it: ${failed}`
    : `change ended ${current.ending.kind} at ${current.ending.id} while this round judged it: ${failed}`
}

/** Keep every diagnostic character while meeting Gitomic's single-line trailer contract. */
function noticeReason(reason: string): string {
  const written = reason.trim().replace(/[\x00-\x1f\x7f]/gu, (char) => JSON.stringify(char).slice(1, -1))
  if (written === "") throw new Error("notification failure has no reason to retain")
  return written
}

/**
 * The half of `eventNoticeOwed` a caller can decide WITHOUT the ending event: a recorded notice settles the
 * entry, and so does a floor that calls this ending old. Everything else — the migration marker, the ending's own
 * `Time:` — lives on the ending, so a `false` here is the caller's signal to go and read for it (29729).
 */
export function noticeSettledLocally(
  eventId: string,
  notices: EventChange["notices"],
  recipient: string,
  floor: Readonly<{ notBefore: Date; present: ReadonlySet<string> }>,
): boolean {
  if (notices?.[`${eventId}:${recipient}`] !== undefined) return true
  return floor.present.has(eventId)
}

/**
 * Whether one entry is still owed a notice for an ending (27198).
 *
 * A migrated ending was already told by the old queue. A fresh ending needs its
 * own receipt, AND must clear the entry's high-water mark: an ending stamped at
 * or after `notBefore`, and not named by `present` (the ids already stamped
 * exactly at `notBefore`), is owed. `present` resolves the same-millisecond tie:
 * an ending that already existed at the mint instant is OLD, one recorded after
 * it — even in the same millisecond — is NEW.
 *
 * `noticeSettledLocally` is the part of this answer that needs no ending; the rest needs it.
 */
export function eventNoticeOwed(
  ending: Pick<Event, "id" | "props">,
  notices: EventChange["notices"],
  recipient: string,
  floor: Readonly<{ notBefore: Date; present: ReadonlySet<string> }>,
): boolean {
  if (ending.props.some(([key]) => key === "Migrated-From")) return false
  if (noticeSettledLocally(ending.id, notices, recipient, floor)) return false
  const time = ending.props.find(([key]) => key === EVENT_TRAILERS.time)?.[1]
  if (time === undefined || !Number.isFinite(Date.parse(time))) {
    throw new Error(`ending event ${ending.id} has no valid Time: to weigh against its notify floor`)
  }
  return Date.parse(time) >= floor.notBefore.getTime()
}

/**
 * What the round knows of its own queue ref without reading it again (29729, @cto a787e279): the
 * projection the round already holds, advanced by each of its own writes. `tip` is the tip the round
 * believes it is writing on — a marker keying the CAS-refused streak, never the CAS base, which Gitomic
 * takes from the live ref and re-projects on every attempt, so a rival's move is absorbed by the retry.
 *
 * These facts go STALE, and another round is what makes them stale: the round lock is a per-workdir flock, so a
 * second round on another clone or host holds a different one and can record a notice between this round's read
 * and its tell (@cto 2005254e, B1). So only the half that decides nothing on its own — `noticeSettledLocally` —
 * is decided from here; a notice this state does not already settle is re-decided on a fresh read before it is told.
 *
 * Residual, named not hidden (@cto 2005254e): `noticeSettledLocally` decides from a recorded notice and the
 * notify floor's present set only. An entry settled by anything else — a `Migrated-From` move, or a
 * `Time:` before the recipient's floor — therefore costs one fresh read every round and never tells.
 * TRIGGER: a second merged-direct recipient, because every historical entry becomes that kind the day it is
 * added. Not live today: the six observed entries each carry a `supervisor` notice, and `supervisor` is the
 * only merged-direct recipient. CURE: carry each entry's ending props from the seed — they never change
 * once written — and decide with `eventNoticeOwed` itself. The after side's `seam.noticeOwed` count is
 * the measurement that would show it.
 */
type KnownQueue = {
  tip: string
  observed: Record<string, Readonly<{ id: string; branch?: string }>>
  notices: Record<
    string,
    Readonly<{ id: string; for: string; to: string; result: "delivered" | "refused" | "failed"; reason?: string }>
  >
}

/**
 * The state a direct notice is decided on must still map this commit to the observed event it wrote (29729). A
 * round takes this on the FRESH read it makes before an owed notice's tell, never on the state it seeded from
 * (@cto 2005254e): the seed is exactly what a rival round on another workdir can leave behind, so this is how a
 * ref rewritten out from under the round stays a loud refusal instead of a skipped or doubled notice.
 */
export function observedEntryHeld(
  known: Readonly<{ observed: Readonly<Record<string, Readonly<{ id: string }>>> }>,
  commit: string,
  eventId: string,
): boolean {
  return known.observed[commit]?.id === eventId
}

type SettledNotice = Readonly<{ result: "delivered" | "refused" | "failed"; reason?: string }>

/** One retry budget and one journal shape for branch and direct event notices. */
async function settleEventNotice(
  context: Readonly<{
    options: QueueRunOptions
    git: Git
    target: string
    log: QueueRunLog
    url: string
    queue: string
  }>,
  entry: NonNullable<QueueRunOptions["notify"]>[number],
  kind: Parameters<typeof dispatchNotifications>[1],
  record: Parameters<typeof dispatchNotifications>[2][number],
  message: Readonly<{ about: string; branch: string; head: string; id: string; text: string }>,
): Promise<SettledNotice> {
  const { options, git, target, log, url, queue } = context
  for (let attempt = 1; attempt <= 2; attempt++) {
    const delivered = (
      await dispatchNotifications(
        {
          git,
          repo: options.repo,
          targetSha: target,
          workdir: options.workdir,
          tempRoot: options.tempRoot,
          notify: [entry],
          setup: options.setup,
          env: options.env,
          populateReference: options.populateReference,
          process: options.process,
        },
        kind,
        [record],
      )
    )[0]
    if (delivered === undefined || delivered.delivery === "none") {
      throw new Error(
        `event queue ${url}#${queue}: ${message.branch} expected notify recipient ${entry.name}, got none`,
      )
    }
    log.write({
      kind: "message",
      ...message,
      says: kind,
      to: entry.name,
      delivered: delivered.delivery === "sent",
      ...(delivered.failure === undefined ? {} : { error: delivered.failure }),
      ...(delivered.refused === undefined ? {} : { refused: delivered.refused }),
    })
    if (delivered.delivery === "sent") return { result: "delivered" }
    if (delivered.refused !== undefined) return { result: "refused", reason: noticeReason(delivered.refused) }
    if (attempt === 2) {
      return {
        result: "failed",
        reason: noticeReason(delivered.failure ?? `notify ${entry.name} gave no delivery receipt`),
      }
    }
  }
  throw new Error(`event queue ${url}#${queue}: ${message.branch} notice ${entry.name} has no final result`)
}

export async function eventQueueRun(
  options: QueueRunOptions,
  prepared: Readonly<{
    git: Git
    gitOptions: GitInvocationOptions
    hooksPath: string
    log: QueueRunLog
    selected: GitRunner
    url: string
  }>,
): Promise<QueueRunOutcome> {
  assertPlainEventQueueRun(options, options)
  const store = {
    ...createEventStore(
      options.repo,
      options.target.remote,
      options.selection ?? selectionFor(prepared.selected),
      prepared.selected.backend,
    ),
    retryBudgetMs: options.retryBudgetMs ?? DEFAULT_QUEUE_RUN_RETRY_BUDGET_MS,
  }
  const queue = options.target.branch
  const { git, gitOptions, hooksPath, log, selected, url } = prepared
  const plumbing = {
    ...options.plumbing,
    journal: (record: Parameters<QueueRunLog["write"]>[0]) => {
      log.write(record)
      options.plumbing?.journal?.(record)
    },
  }
  // #28503 slice 2: one warm check tree per (repository, ref, role) for the whole
  // queue, instead of one made and torn down per phase and per change.
  const pool = new WorktreePool({
    workdir: options.workdir,
    ref: queue,
    repo: options.repo,
    git,
    hooksPath,
    process: options.process,
    env: options.env,
    selection: options.selection,
    gitOptions,
    populateReference: options.populateReference,
    plumbing,
  })
  const runIdentity = { id: log.id, startedAt: new Date().toISOString(), host: hostname(), actor: "yrd" }
  const writeStuck = (
    branch: string,
    head: string,
    cause: Readonly<{ code: string; subject: string; via: string; next: string; saw?: string }>,
  ): void => {
    const incident: Incident = {
      code: cause.code,
      subject: cause.subject.replace(/\s+/gu, " ").trim(),
      via: `${cause.via} in yrd queue ${queue} [${log.id}]`,
      evidence: log.path,
      next: `${cause.next}; ${stuckCures(branch)}`,
    }
    incidentTrailers(incident)
    log.write({
      kind: "change",
      branch,
      head,
      decision: "stuck",
      reason: incident.subject,
      ...incident,
      ...(cause.saw === undefined ? {} : { saw: cause.saw }),
    })
  }
  const runTransaction = async <T>(
    site: QueueRunEventRetryExhausted["site"],
    marker: string,
    operation: () => Promise<T>,
    runnerMarkerAt?: Date,
  ): Promise<T> => {
    try {
      // The transaction's own site names this store write where no step is current (29697, @cto R2): a gap
      // filler, so a step's label still wins wherever one is set and what stays unnamed stays measured.
      return await withRemoteSeamGap(site, operation)
    } catch (error) {
      if (!(error instanceof RetriesExhausted)) throw error
      const ref = queueRef(queue)
      // Only an event this runner wrote shares the journal clock. A queue tip
      // from another writer has no safe Time: bound, so scan a named file budget.
      const prior = recentCasRefusalStreak(
        dirname(log.path),
        ref,
        marker,
        runnerMarkerAt ?? new Date(0),
        runnerMarkerAt === undefined
          ? { name: CAS_HISTORY_BUDGET_NAME, journals: CAS_HISTORY_JOURNAL_BUDGET }
          : undefined,
      )
      const count = prior.count + 1
      const written = log.write({
        kind: "warning",
        subject: "cas-refused",
        site,
        ref,
        marker,
        count,
        budgetMs: error.budgetMs,
        ...(prior.windowExhausted === undefined
          ? {}
          : {
              windowExhausted: prior.windowExhausted.oldestFile,
              windowBudget: prior.windowExhausted.name,
              windowBudgetJournals: prior.windowExhausted.journals,
            }),
        reason:
          `${ref} at ${marker}: ${site} made no progress within its ${error.budgetMs}ms CAS retry budget; the next service interval retries` +
          (prior.windowExhausted === undefined
            ? ""
            : `; ${prior.windowExhausted.name} budget (${prior.windowExhausted.journals} journals) exhausted at ` +
              `${prior.windowExhausted.oldestFile}; count is at least ${String(count)}`),
      })
      const firstAt = prior.firstAt ?? written.at
      throw new QueueRunEventRetryExhausted(
        site,
        ref,
        marker,
        count,
        error.budgetMs,
        firstAt,
        error,
        prior.windowExhausted,
      )
    }
  }
  const owned = new Set<string>()
  let runNumber: number | undefined
  // The exact event (and the run number it consumed) staged by an append through
  // the funnel. The landed probe reads it to tell "the push landed anyway" from
  // "a rival moved the ref" without re-staging (28793, @cto).
  type StagedEvent = Readonly<{ oid: string; number?: number }>
  const recordRunNumber = (number: number): void => {
    if (runNumber !== undefined) throw new Error(`${runIndexRef(queue)}: run ${log.id} was numbered twice`)
    runNumber = number
    log.write({ kind: "run-number", number, queue, ref: runIndexRef(queue) })
  }
  const appendOwnedChangeOnce = async (
    prepared: (staged: StagedEvent) => void,
    site: string,
    ...args: Parameters<typeof appendChangeEvent>
  ): Promise<StagedEvent> => {
    const onPrepared = (oid: string, number?: number): void => {
      prepared({ oid, ...(number === undefined ? {} : { number }) })
    }
    // The site is the name of the line that decided this append (29697, @cto R2), handed in by the caller like
    // runTransaction's site. A name written here would label all twenty-one of those lines at once, and a line
    // added later would be labelled without anyone choosing it.
    if (runNumber !== undefined) {
      return {
        oid: await withRemoteSeamGap(site, () =>
          appendChangeEvent(args[0], args[1], args[2], args[3], args[4], onPrepared),
        ),
      }
    }
    const written = await withRemoteSeamGap(site, () =>
      appendNumberedChangeEvent(args[0], args[1], args[2], args[3], args[4], runIdentity, onPrepared),
    )
    recordRunNumber(written.number)
    return { oid: written.event, number: written.number }
  }
  // A GitHub 5xx on the change-ref push (refs/yrd/<queue>/changes/<branch>) is a
  // transient remote error, not a judgement (28793). The merge publication has been
  // retried in-round since 27995, but this append — the event that moves the change
  // ref on submit, verifying, checking and every ending, and the queue and run-index
  // refs riding in the same atomic push — was bare: one 5xx threw out of the round,
  // the round could not judge, and the service exited 2, which is off Hab's relaunch
  // allowlist, so the line stopped with nothing relaunching it. Retry it the same
  // way, bounded, counting each attempt into the round log; an unrecognized refusal
  // and a 4xx still propagate on the first attempt. A 500 that ARRIVED AFTER the push
  // landed is not a failure at all: the landed probe reads the remote and returns the
  // staged event, so the retry neither fails the lease nor appends a second event.
  // Exhaustion is a HOLD, mapped once in the change loop's catch, never exit 2.
  const appendOwnedChange = async (site: string, ...args: Parameters<typeof appendChangeEvent>): Promise<string> => {
    const [, evQueue, evBranch, evMarker] = args
    const ref = changesRef(evQueue, evBranch)
    let staged: StagedEvent
    try {
      staged = await publishWithTransientRetry<StagedEvent>(
        (prepared) => appendOwnedChangeOnce(prepared, site, ...args),
        {
          repository: options.target.remote,
          ref,
          note: (attempt: TransientPushAttempt, probeError?: string): void => {
            log.write({
              kind: "warning",
              subject: "transient-push-5xx",
              branch: evBranch,
              ref,
              marker: evMarker,
              attempt: attempt.attempt,
              requestId: attempt.requestId,
              line: attempt.line,
              repository: attempt.repository,
              ...(probeError === undefined ? {} : { probeError }),
            })
          },
          landed: async (candidate): Promise<StagedEvent | undefined> => {
            // The probe names itself, on its caller's line (29697, @cto R2). A step that already names this
            // publication still wins: a gap name never overwrites one.
            const remote = await withRemoteSeamGap("changeLandedProbe", () =>
              readRemoteCommit(git, options.target.remote, ref),
            )
            if (remote === undefined || remote !== candidate.oid) return undefined
            if (runNumber === undefined && candidate.number !== undefined) {
              recordRunNumber(candidate.number)
            }
            return candidate
          },
        },
      )
    } catch (error) {
      const hit = transientPush5xxOf(error)
      if (hit !== undefined) throw new ChangeRefPublicationHeld(evBranch, evMarker, ref, hit, { cause: error })
      throw error
    }
    // The landed probe can return a staged event without re-running the append,
    // so name it here too: a later reconcile in this round reads `owned`.
    owned.add(staged.oid)
    return staged.oid
  }
  const appendOwnedMergeOnce = async (
    prepared: (staged: StagedEvent) => void,
    ...args: Parameters<typeof appendPublishedMerge>
  ): Promise<StagedEvent> => {
    const [store, targetQueue, branch, selectedTip, request] = args
    const onPrepared = (oid: string, number?: number): void => {
      prepared({ oid, ...(number === undefined ? {} : { number }) })
    }
    const staged =
      runNumber === undefined
        ? await (async () => {
            const written = await appendNumberedPublishedMerge(
              store,
              targetQueue,
              branch,
              selectedTip,
              request,
              runIdentity,
              onPrepared,
            )
            recordRunNumber(written.number)
            return { oid: written.event, number: written.number }
          })()
        : { oid: await appendPublishedMerge(store, targetQueue, branch, selectedTip, request, onPrepared) }
    return staged
  }
  const rivalOrThrow = async (
    branch: string,
    selectedTip: string,
    current: EventChange,
    error: unknown,
  ): Promise<EventChange> => {
    if (error instanceof PublicationRejected) throw error
    if (current.tip === selectedTip) throw error
    if (current.tip === undefined) {
      throw new Error(`event queue ${url}#${queue}: publication-unknown for ${branch}: current chain has no tip`, {
        cause: error,
      })
    }
    let latest = current
    let history: readonly Event[]
    try {
      history = await readHistory(branch, current.tip, "rivalHistory")
    } catch (readError) {
      const ref = changesRef(queue, branch)
      if (!(readError instanceof Conflict) || readError.refs.length !== 1 || readError.refs[0] !== ref) {
        throw readError
      }
      // A rival may advance again between our status and its selected history.
      // Re-read once inside this round; a second move is still a loud error.
      latest = await readChange(branch, "rivalStatus")
      if (latest.tip === undefined || latest.tip === current.tip) throw readError
      log.write({
        kind: "warning",
        subject: "change-ref-moved-during-history-read",
        branch,
        ref,
        expected: current.tip,
        actual: latest.tip,
        reason: readError.message,
      })
      history = await readHistory(branch, latest.tip, "rivalHistory")
    }
    const at = history.findIndex((event) => event.id === selectedTip)
    const successor = at < 0 ? undefined : history[at + 1]?.id
    if (successor !== undefined && owned.has(successor)) throw error
    if (successor !== undefined && error instanceof Conflict) return latest
    throw new Error(
      `event queue ${url}#${queue}: publication-unknown for ${branch} after ${selectedTip}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  log.write({ kind: "queue", queue: queueName(options.target, url) })
  const prefix = queueRefPrefix(queue)
  // Defined before its first use, below. It carries no name (29697, @cto R2): the name belongs on the caller's
  // line, because a name written here would attribute every caller of it at once.
  const refsList = (ref: string) => listRefs(ref, store)
  // Each read below is named on its own line, never inside the helper (29697, @cto R2).
  const advertised = await withRemoteSeamGap("lineAdvertise", () => refsList(prefix))
  const legacyRef = `${prefix}/override`
  const legacyOid = advertised.get(legacyRef)
  if (legacyOid !== undefined) throw new LegacyOverridePresent(legacyRef, legacyOid)
  const targetRef = `refs/heads/${queue}`
  const target = (await withRemoteSeamGap("targetRead", () => refsList(targetRef))).get(targetRef)
  if (target === undefined) throw new Error(`event queue ${url}#${queue}: missing target ${targetRef}`)
  if (target !== options.targetSha) {
    throw new Error(
      `event queue ${url}#${queue}: target moved from ${options.targetSha} to ${target}; start a new round`,
    )
  }
  const observation = await selected.observe({
    version: 1,
    root: { remote: url, targetRef, targetOid: target },
    checked: [],
    fence: { prefixes: [`${prefix}/`], refs: [...advertised].map(([ref, oid]) => ({ ref, oid })) },
  })
  log.write({
    kind: "observation",
    contract: observation.contract,
    message: observation.message,
    ...(observation.contract === "native" ? {} : { outcome: observation.outcome }),
  })
  let directMerges: readonly string[] = []
  const deferredChanges: string[] = []
  /** The line as this round read it (25669), stated on every outcome once the line is read. */
  const read: { line?: RoundLine } = {}
  const branches: string[] = []
  /**
   * `timedStep` under the round's remote seam: the step's own name labels every remote call it starts, so the
   * round's `remote-calls` row answers "who" and not only "how much" (29697 row 1). The seam rides the async
   * scope, so a git-super child started inside the step inherits it (git.ts `seamEnvironment`).
   */
  const seamStep = <T>(
    about: Readonly<
      { name: string; phase: string } & ({ branch: string; head: string } | { target: string; base: string })
    >,
    work: () => Promise<T>,
  ): Promise<T> => timedStep(log, about, () => withRemoteSeam(about.name, work))
  /**
   * The round's own store reads (29697, @cto R2), each taking the site name of the line that asks for it, like
   * runTransaction's site. The name is never written here: a name on this line would cover every caller at once,
   * so a read added later would be labelled without anyone choosing it. `site` may be left off where a step that
   * already names the read wraps the call, and a read nothing names stays in the unattributed row.
   */
  const readChange = (branch: string, site?: string) =>
    site === undefined
      ? readStatus(store, queue, branch)
      : withRemoteSeamGap(site, () => readStatus(store, queue, branch))
  const readHistory = (branch: string, tip: string, site: string) =>
    withRemoteSeamGap(site, () => readChangeEvents(store, queue, branch, tip))
  const readOps = (site?: string) =>
    site === undefined
      ? readEventOps(store, git, queue, target)
      : withRemoteSeamGap(site, () => readEventOps(store, git, queue, target))
  const deleteMergedBranch = async (branch: string, head?: string): Promise<void> => {
    if (head === undefined) {
      log.write({ branch, kind: "branch-kept", saw: "unread", reason: "no submitted commit recorded" })
      branches.push(`kept ${branch}: no submitted commit recorded`)
      return
    }
    const ref = `refs/heads/${branch}`
    try {
      const publishMergedBranch = store.backend.publish
      if (publishMergedBranch === undefined) {
        throw new Error("Gitomic backend lacks publish for merged branch deletion")
      }
      await withRemoteSeam("retire", () =>
        publishMergedBranch.call(store.backend, store.repo, [{ ref, expect: head, oid: null }], options.target.remote),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      let saw: string
      try {
        saw = (await withRemoteSeam("retire", () => readRemoteCommit(git, options.target.remote, ref))) ?? "absent"
      } catch (readError) {
        saw = `unread (${readError instanceof Error ? readError.message : String(readError)})`
      }
      const why =
        saw === "absent"
          ? "already gone"
          : saw === head
            ? `the delete failed: ${message}`
            : saw.startsWith("unread")
              ? `the delete failed and its branch is ${saw}: ${message}`
              : `moved to ${saw.slice(0, 12)}`
      log.write({ branch, head, kind: "branch-kept", saw, ...(saw === "absent" ? {} : { error: message }) })
      branches.push(`kept ${branch} (merged at ${head.slice(0, 12)}): ${why}`)
      return
    }
    log.write({ branch, head, kind: "branch-deleted" })
    branches.push(`deleted ${branch} at ${head.slice(0, 12)}, merged`)
  }
  const result = (
    exitCode: 0 | 1 | 2,
    merged: string[] = [],
    failed: string[] = [],
    stuck: string[] = [],
    deferred: string[] = [],
    stopped?: QueueRunOutcome["stopped"],
    targetAfter = target,
  ): QueueRunOutcome => ({
    observation,
    base: options.targetSha,
    config: options.configBlob,
    exitCode,
    log: log.path,
    run: log.id,
    target: targetAfter,
    merged,
    failed,
    stuck,
    deferred: [...new Set([...deferredChanges, ...deferred])],
    directMerges,
    ...(read.line === undefined ? {} : { line: read.line }),
    ...(branches.length === 0 ? {} : { branches: [...branches] }),
    ...(stopped === undefined ? {} : { stopped }),
  })
  // The run records one `notify-floors` snapshot before any delivery; every name it
  // declares then has a floor. A missing floor is a loud error, never a silent skip.
  let notifyFloors: EventQueue["notifyFloors"]
  const floorFor = (name: string): NotifyFloor => {
    const floor = notifyFloors?.[name]
    if (floor === undefined) {
      throw new Error(
        `event queue ${url}#${queue}: notify entry ${name} has no recorded notify-floors high-water mark; a run records one before it delivers any ending`,
      )
    }
    return floor
  }
  const tell = async (
    branch: string,
    kind: "merged" | "failed" | "stuck" | "deferred" | "cancelled",
    eventId: string,
    existingEnding?: Event,
    freshMergedEnding = false,
  ): Promise<void> => {
    if ((options.notify?.length ?? 0) === 0) return
    const change = await readChange(branch, "noticeStatus")
    if (change.commit === undefined) {
      throw new Error(`event queue ${url}#${queue}: ${branch} notice has no submitted commit`)
    }
    if (change.lastNotifiable?.id !== eventId || change.lastNotifiable.kind !== kind) {
      throw new Error(`event queue ${url}#${queue}: ${branch} notice lost its ${kind} event ${eventId}`)
    }
    let tip = change.tip
    if (tip === undefined) throw new Error(`event queue ${url}#${queue}: ${branch} notice has no chain tip`)
    // A fresh merged notice uses the immutable event acquired by noticeStatus.
    // Later resubmissions are still protected by the exact noticeWrite CAS.
    const ending =
      existingEnding ??
      (freshMergedEnding && kind === "merged"
        ? await readRetainedEvent(await openEvents({ ...store, ref: changesRef(queue, branch) }), eventId)
        : (await readHistory(branch, tip, "noticeHistory")).find((event) => event.id === eventId))
    if (ending === undefined) {
      throw new Error(`event queue ${url}#${queue}: ${branch} notice has no ${kind} event ${eventId}`)
    }
    const merge = kind === "merged" ? ending.props.find(([key]) => key === "Commit")?.[1] : undefined
    if (kind === "merged" && merge === undefined) {
      throw new Error(`event queue ${url}#${queue}: ${branch} merged event ${eventId} has no kept Commit`)
    }
    // Count branch failures, not failed checks: a verifier refusal before any check still counts.
    const failedEvents =
      kind === "failed"
        ? (await readHistory(branch, tip, "noticeHistory")).filter(
            (event) =>
              event.type === "failed" &&
              isChargedFailure(event.props.find(([key]) => key === EVENT_TRAILERS.reason)?.[1]),
          )
        : undefined
    const failures = failedEvents?.length
    const priorReason =
      failedEvents !== undefined
        ? sameFailureReason(
            failedEvents
              .filter((event) => event.id !== eventId)
              .map((event) => event.props.find(([key]) => key === EVENT_TRAILERS.reason)?.[1]),
          )
        : undefined
    // The cause beside the reason: the failing checks' identity, and the one
    // every prior charged failure of this branch carried. Both are sent with
    // the record and folded apart, so the notifier's hold turns on reason AND
    // detail and can only fire less often (24735 row 5).
    const detail = failedEvents === undefined ? undefined : failureIdentity(ending)
    const priorDetail =
      failedEvents === undefined
        ? undefined
        : sameFailureDetail(failedEvents.filter((event) => event.id !== eventId).map((event) => failureIdentity(event)))
    const head = change.commit
    const text = messageFor(kind, {
      branch,
      head,
      subject: change.reason ?? kind,
      ...(kind === "merged" ? { merge } : {}),
      ...(kind === "deferred" ? { projectedMs: change.deferred?.projectedMs, boundMs: change.deferred?.boundMs } : {}),
    })
    // A resubmission that lands while a notice is being delivered opens a new change above this ending (26989).
    // Its `opened` clears the ending's notices, so no `notified` can be recorded above it any more: the notice is
    // delivered and logged as unrecorded, and the new submission stays queued for its own round.
    let resubmitted: string | undefined
    // Non-merged endings written by this round cannot carry migration provenance.
    // Existing endings and merged notices use the actual event.
    for (const entry of options.notify ?? []) {
      if (!entry.on.includes(kind)) continue
      if (!eventNoticeOwed(ending, change.notices, entry.name, floorFor(entry.name))) continue
      const key = `${eventId}:${entry.name}`
      const final = await settleEventNotice(
        { options, git, target, log, url, queue },
        entry,
        kind,
        {
          record: kind,
          change: changeName({ branch, head }),
          endingId: eventId,
          endedAt: endingTime(ending, `event queue ${url}#${queue}: ${branch}`),
          ...(change.issue === undefined ? {} : { issue: change.issue }),
          ...(change.submitter === undefined ? {} : { submitter: change.submitter }),
          ...(kind === "merged"
            ? { merge }
            : { reason: kind === "cancelled" ? "branch absent from remote" : (change.reason ?? kind), log: log.path }),
          ...(kind === "failed"
            ? {
                failures,
                ...(priorReason === undefined ? {} : { priorReason }),
                ...(detail === undefined ? {} : { detail }),
                ...(priorDetail === undefined ? {} : { priorDetail }),
              }
            : {}),
          ...(kind === "deferred"
            ? { projectedMs: change.deferred?.projectedMs, boundMs: change.deferred?.boundMs }
            : {}),
        },
        { about: branch, branch, head, id: eventId, text },
      )
      if (resubmitted === undefined) {
        try {
          tip = await appendOwnedChange("noticeWrite", store, queue, branch, tip, {
            type: "notified",
            at: new Date(),
            ...(final.reason === undefined ? {} : { reason: final.reason }),
            notice: {
              for: eventId,
              to: entry.name,
              key,
              result: final.result,
              ...(final.reason === undefined ? {} : { reason: final.reason }),
            },
          })
          continue
        } catch (error) {
          // Any other move, and a chain that cannot even be read back, stops the run with the conflict itself.
          resubmitted = error instanceof Conflict ? await openedAfter(branch, tip).catch(() => undefined) : undefined
          if (resubmitted === undefined) throw error
        }
      }
      log.write({
        kind: "notice-unrecorded",
        branch,
        head,
        for: eventId,
        to: entry.name,
        result: final.result,
        opened: resubmitted,
      })
    }
  }
  /**
   * The `opened` event directly above `expected` on this change's chain, when a new submission is what moved it;
   * otherwise undefined, and the caller's conflict stands. A tip moved any other way is still the loud stop.
   */
  const openedAfter = async (branch: string, expected: string): Promise<string | undefined> => {
    const latest = await readChange(branch, "openedStatus")
    if (latest.tip === undefined || latest.tip === expected) return undefined
    const history = await readHistory(branch, latest.tip, "openedHistory")
    const at = history.findIndex((event) => event.id === expected)
    const next = at < 0 ? undefined : history[at + 1]
    return next !== undefined && next.type === "opened" && !owned.has(next.id) ? next.id : undefined
  }
  /**
   * Tell the recipients of one direct merge (29729, @cto 2005254e). Every entry the round's own known state can
   * settle — a recorded notice, or a floor that calls this ending old — is settled there for free, so a round
   * whose direct merges are all notified reads the queue ref ZERO times. An entry that state does NOT settle earns
   * exactly one fresh read, and the guard and the owed decision are both taken again on what that read says: a
   * rival round that recorded the notice between this round's read and this tell is seen and stays quiet, so the
   * window is the one notify command base had, never the seed-to-write span.
   */
  const tellDirect = async (knownQueue: KnownQueue, commit: string, eventId: string): Promise<void> => {
    const ref = queueRef(queue)
    for (const entry of options.notify ?? []) {
      if (!entry.on.includes("merged-direct")) continue
      const key = `${eventId}:${entry.name}`
      if (noticeSettledLocally(eventId, knownQueue.notices, entry.name, floorFor(entry.name))) continue
      const fresh = await withRemoteSeamGap("noticeOwed", () => readEventQueueWithChain(store, queue))
      // The read IS the known state from here on: it is newer than the round's seed, and it is the state this
      // decision, the guard and the next CAS marker are all taken on.
      knownQueue.tip = fresh.queue.tip
      knownQueue.observed = { ...fresh.queue.observed }
      knownQueue.notices = { ...fresh.queue.notices }
      if (!observedEntryHeld(knownQueue, commit, eventId)) {
        throw new Error(`event queue ${url}#${queue}: direct notice lost observed ${commit} at ${eventId}`)
      }
      const observed = fresh.events.find((event) => event.id === eventId)
      if (observed?.type !== "observed") {
        throw new Error(
          `${ref} in ${store.repo}: direct notice event ${eventId} is ${observed?.type ?? "absent"}, expected observed`,
        )
      }
      if (!eventNoticeOwed(observed, knownQueue.notices, entry.name, floorFor(entry.name))) continue
      const final = await settleEventNotice(
        { options, git, target, log, url, queue },
        entry,
        "merged-direct",
        {
          record: "merged-direct",
          change: commit,
          endingId: eventId,
          endedAt: endingTime(observed, `event queue ${url}#${queue}`),
        },
        { about: queue, branch: queue, head: commit, id: eventId, text: `direct merge ${commit} observed on ${queue}` },
      )
      // The write's own result is the tip the round believes it is writing on next: on an append it is the
      // new tip; on a no-op a rival wrote that exact key first, and the round keeps what the write returned.
      const written = await runTransaction("notified", knownQueue.tip, () =>
        writeQueueEvent(store, queue, {
          type: "notified",
          by: "yrd-run",
          at: new Date(),
          notice: {
            for: eventId,
            to: entry.name,
            key,
            result: final.result,
            ...(final.reason === undefined ? {} : { reason: final.reason }),
          },
        }),
      )
      knownQueue.tip = written
      knownQueue.notices[key] = {
        id: written,
        for: eventId,
        to: entry.name,
        result: final.result,
        ...(final.reason === undefined ? {} : { reason: final.reason }),
      }
    }
  }
  if (observation.contract === "root-v1" && observation.outcome !== "observed") {
    return result(observation.outcome === "invalid" ? 2 : 0)
  }

  let operational = await withRemoteSeam("roundOpen", () => readOps())
  // No override can expire or need a reminder when the table is empty. Keep
  // the round's injected clock for its stop window until a clock act is due.
  const clock =
    operational.overrides.entries.length === 0
      ? { expired: [], reminded: [] }
      : await runTransaction("expire-overrides", operational.queue.tip, () =>
          expireQueueOverrides(store, queue, options.now?.() ?? Date.now(), "yrd"),
        )
  for (const [action, entries] of [
    ["expired", clock.expired],
    ["reminder", clock.reminded],
  ] as const) {
    for (const entry of entries) {
      const notice = overrideNotice(entry, action, `${queue}@${target}`, log.id)
      let deliveries: Awaited<ReturnType<typeof notifyOutsideRound>>
      try {
        deliveries = await notifyOutsideRound(
          {
            git,
            repo: options.repo,
            targetSha: target,
            workdir: options.workdir,
            tempRoot: options.tempRoot,
            notify: options.notify ?? [],
            ...(options.setup === undefined ? {} : { setup: options.setup }),
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.populateReference === undefined ? {} : { populateReference: options.populateReference }),
            ...(options.process === undefined ? {} : { process: options.process }),
          },
          notice,
        )
      } catch (error) {
        deliveries = [
          {
            notice,
            name: "notify",
            delivery: "failed",
            failure: error instanceof Error ? error.message : String(error),
          },
        ]
      }
      for (const told of deliveries) {
        log.write({
          kind: "message",
          says: "override",
          action,
          check: entry.check,
          id: entry.record,
          to: told.name,
          delivered: told.delivery === "sent",
          ...(told.failure === undefined ? {} : { error: told.failure }),
          ...(told.refused === undefined ? {} : { refused: told.refused }),
        })
      }
    }
  }
  operational = await withRemoteSeam("prePick", () => readOps())
  let queueState = operational.queue
  const { histories, invalid } = await withRemoteSeam("prePick", () =>
    listChangeHistories(store, queue, { branches: "all" }),
  )
  // 27198: ONE queue-level `notify-floors` snapshot per run, before any ending
  // delivery. The first snapshot is a migration: it mints every declared name at
  // the queue's created instant, and refuses loudly unless the declared name set
  // EQUALS the creation declaration's, so a name added later is never mistaken
  // for one that has legitimate pending debt. A later snapshot keeps a retained
  // name's floor, mints an added name at NOW (with the ending ids already stamped
  // there), and drops an absent name.
  // A run entered with NO notify option at all (not the queue's declaration,
  // which is always a list) neither mints nor wipes a floor; a run whose
  // declaration removed the LAST entry still enters, so its empty set is
  // recorded rather than silently skipping the write. The FIRST migration
  // (known === undefined) therefore enters even for an explicit EMPTY
  // declaration: the creation declaration must be read either way - to REFUSE a
  // mismatch loudly, or to record the valid empty baseline - never skipped
  // because both name sets happen to be empty. With floors already recorded a
  // steady-state run enters only when the declared set CHANGED, so an identical
  // snapshot is not re-written every run.
  const declaredNames = new Set((options.notify ?? []).map((entry) => entry.name))
  const known = queueState.notifyFloors
  const recordedNames = known === undefined ? [] : Object.keys(known)
  if (options.notify !== undefined) {
    if (known === undefined || !sameNameSet(declaredNames, recordedNames)) {
      const ref = queueRef(queue)
      const chainEvents = await withRemoteSeamGap("notifyFloorsChainRead", async () =>
        readEventChain(await openEvents({ ...store, ref })),
      )
      const now = new Date(options.now?.() ?? Date.now())
      const floors = Object.create(null) as Record<string, Readonly<{ notBefore: Date; present: readonly string[] }>>
      if (known === undefined) {
        const creation = await readConfig(git, queueState.declaration, options.target)
        const creationNames = (creation?.notify ?? []).map((entry) => entry.name)
        if (!sameNameSet(declaredNames, creationNames)) {
          throw new Error(
            `event queue ${url}#${queue}: cannot record the first notify-floors snapshot — declared notify entries ` +
              `(${[...declaredNames].sort().join(", ") || "none"}) differ from the queue's creation declaration ` +
              `(${[...creationNames].sort().join(", ") || "none"}); an explicit, reviewed migration baseline is required`,
          )
        }
        const created = chainEvents.find((event) => event.id === queueState.created)
        if (created === undefined) {
          throw new Error(`event queue ${url}#${queue}: created event ${queueState.created} is missing from ${ref}`)
        }
        const createdAt = new Date(endingTime(created, `${ref} created`))
        for (const name of declaredNames) floors[name] = { notBefore: createdAt, present: [] }
      } else {
        const present = stampedEndingIds(now, histories, chainEvents)
        for (const name of declaredNames) {
          const prior = known[name]
          floors[name] =
            prior === undefined
              ? { notBefore: now, present: [...present] }
              : { notBefore: prior.notBefore, present: [...prior.present] }
        }
      }
      await runTransaction("notify-floors", queueState.tip, () =>
        writeQueueEvent(store, queue, {
          type: "notify-floors",
          by: QUEUE_RUN_WRITER,
          at: now,
          floors,
        }),
      )
      operational = await withRemoteSeam("floorsRefresh", () => readOps())
      queueState = operational.queue
    }
    notifyFloors = queueState.notifyFloors
  }
  // 29729: the direct-notice loop settles from the projection the round has just read (readOps, above), advanced
  // by the round's own writes, and reads the queue ref only for the entry that state says is still owed a notice
  // (@cto 2005254e). A round whose direct merges are all notified reads it zero times.
  const knownQueue: KnownQueue = {
    tip: queueState.tip,
    observed: { ...queueState.observed },
    notices: { ...queueState.notices },
  }
  for (const [commit, observed] of Object.entries(queueState.observed)) {
    await tellDirect(knownQueue, commit, observed.id)
  }
  for (const [branch, defect] of invalid) {
    log.write({
      kind: "observation",
      subject: "invalid-change-chain",
      branch,
      ref: defect.ref,
      tip: defect.tip,
      error: defect.error,
    })
  }
  const changes = new Map([...histories].map(([branch, history]) => [branch, history.state]))
  // WHEN THE QUEUE LAST JUDGED A CHANGE (25669): the latest merged or failed
  // ending on any chain, read from the chains themselves so a relaunched service
  // knows it without having watched it happen. A cancel is a person's act, not the
  // line flowing, and does not count.
  let lastJudgedMs: number | undefined
  for (const change of changes.values()) {
    const kind = change.ending?.kind
    if ((kind === "merged" || kind === "failed") && change.endedAt !== undefined) {
      lastJudgedMs = Math.max(lastJudgedMs ?? 0, change.endedAt.getTime())
    }
  }
  for (const [branch, change] of changes) {
    const latest = change.lastNotifiable
    if (latest !== undefined && (latest.kind !== "cancelled" || change.reason === "deleted")) {
      const history = histories.get(branch)
      const ending = history?.events.find((event) => event.id === latest.id)
      if (ending === undefined) {
        throw new Error(`event queue ${url}#${queue}: ${branch} has no event ${latest.id} for its latest notice`)
      }
      if (
        (options.notify ?? []).some(
          (entry) =>
            entry.on.includes(latest.kind) && eventNoticeOwed(ending, change.notices, entry.name, floorFor(entry.name)),
        )
      ) {
        await tell(branch, latest.kind, latest.id, ending)
        changes.set(branch, await readChange(branch, "observedStatus"))
      }
    }
  }
  const direct = await eventDirectMergeCommits(
    git,
    queue,
    target,
    queueState.declaration,
    histories,
    new Set(Object.keys(knownQueue.observed)),
  )
  directMerges = direct.map((commit) => commit.commit)
  let directMarkerAt: Date | undefined
  for (const commit of direct) {
    const observedAt = new Date()
    const observed = await runTransaction(
      "observed",
      knownQueue.tip,
      () =>
        writeQueueEvent(store, queue, {
          type: "observed",
          commit: commit.commit,
          ...(commit.branch === undefined ? {} : { branch: commit.branch }),
          by: "yrd-run",
          at: observedAt,
        }),
      directMarkerAt,
    )
    knownQueue.tip = observed
    knownQueue.observed[commit.commit] = {
      id: observed,
      ...(commit.branch === undefined ? {} : { branch: commit.branch }),
    }
    directMarkerAt = observedAt
    log.write({
      kind: "merged-direct",
      branch: queue,
      commit: commit.commit,
      gitlinks: commit.gitlinks,
      parents: commit.parents,
      subject: commit.subject,
      why: commit.why,
    })
    await tellDirect(knownQueue, commit.commit, observed)
  }
  if (direct.length > 0) {
    operational = await withRemoteSeam("afterDirect", () => readOps())
    queueState = operational.queue
  }
  if (operational.stop !== undefined && options.foreground !== true) {
    log.write({ kind: "pause", reason: operational.stop.reason, by: operational.stop.by, sha: operational.stop.sha })
    const pendingStuck: string[] = []
    for (const [branch, history] of histories) {
      if (
        history.state.status === "stuck" &&
        !(await withRemoteSeamGap("resumeRead", () => queueResumedAfter(store, queue, branch, history)))
      ) {
        pendingStuck.push(branch)
      }
    }
    return {
      ...result(0, [], [], [], [], { ring: "pause", says: operational.stop.reason, what: operational.stop }),
      pendingStuck,
    }
  }
  const observedMerged: string[] = []
  const observable = [...changes].filter(
    (entry): entry is [string, EventChange & { commit: string; tip: string }] =>
      isOpen(entry[1].status) && entry[1].commit !== undefined && entry[1].tip !== undefined,
  )
  const offTarget = await offTheTarget(git, [...new Set(observable.map(([, change]) => change.commit))], target)
  const onTarget = observable.filter(([, change]) => !offTarget.has(change.commit))
  // An ancestor excludes fewer target commits than its descendant. Record lower
  // stacked changes first, independent of branch names or commit timestamps.
  const ordered = await Promise.all(
    onTarget.map(async (entry) => {
      const count =
        onTarget.length < 2 ? "0" : (await git(["rev-list", "--count", `${entry[1].commit}..${target}`])).trim()
      const distance = Number(count)
      if (count === "" || !Number.isSafeInteger(distance) || distance < 0) {
        throw new Error(
          `${entry[0]}@${entry[1].commit}: invalid target distance to ${target}: ${JSON.stringify(count)}`,
        )
      }
      return { entry, distance }
    }),
  )
  ordered.sort((left, right) => right.distance - left.distance)
  const deliveredCommits = new Set<string>()
  for (const [branch, history] of ordered.length === 0 ? [] : histories) {
    for (const segment of enumerateChangeSegments(history.events, changesRef(queue, branch), store.repo)) {
      for (const event of segment.events) {
        if (event.type !== "merged") continue
        const point = trailer(event, "Commit")
        if (point === undefined) throw new Error(`validated merged event ${event.id} has no Commit`)
        deliveredCommits.add(point)
        deliveredCommits.add(segment.head)
      }
    }
  }
  for (const {
    entry: [branch, change],
  } of ordered) {
    const range = `${change.commit}..${target}`
    const [ancestryRows, firstParentRows] = await Promise.all([
      git(["rev-list", "--reverse", "--topo-order", "--ancestry-path", "--parents", range]),
      git(["rev-list", "--first-parent", range]),
    ])
    const ancestry = ancestryRows
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.trim().split(/\s+/u))
    const firstParents = new Set(
      firstParentRows
        .trim()
        .split("\n")
        .filter((line) => line !== ""),
    )
    const row = ancestry.find(([commit]) => commit !== undefined && firstParents.has(commit))
    if (change.commit !== target && row === undefined) {
      throw new Error(
        `${branch}: observed source ${change.commit} is on target ${target} but has no delivery intersection (${ancestry.length} ancestry rows, ${firstParents.size} first-parent rows)`,
      )
    }
    const merge = row?.[1] === change.commit ? change.commit : (row?.[0] ?? change.commit)
    const opened = histories
      .get(branch)
      ?.events.findLast((event) => event.type === "opened" && trailer(event, "Commit") === change.commit)
    let sourceBase = opened === undefined ? undefined : trailer(opened, "Base")
    if (sourceBase !== undefined) {
      const introduced = (await git(["rev-list", "--topo-order", `${sourceBase}..${change.commit}`])).trim().split("\n")
      const deliveredBase = introduced.find((point) => deliveredCommits.has(point))
      if (deliveredBase !== undefined) {
        if (!(await isAncestor(git, deliveredBase, change.commit))) {
          throw new Error(
            `${branch}: recorded delivered source ${deliveredBase} is not an ancestor of submitted head ${change.commit}`,
          )
        }
        sourceBase = deliveredBase
      }
    }
    const selectedTip = change.tip
    try {
      const landedGitlinks = (await readCommitSubmodules(seamProcess(git, options.repo), options.repo, merge)).map(
        ({ path, target }) => ({ path, target }),
      )
      const written = await appendOwnedChange("mergedWrite", store, queue, branch, selectedTip, {
        type: "merged",
        at: new Date(),
        commit: merge,
        ...(sourceBase === undefined ? {} : { base: sourceBase }),
        landedGitlinks,
        reason: `observed on target at ${merge}`,
        title: `merged ${branch}`,
        run: log.id,
      })
      const ended = await readChange(branch, "offTargetStatus")
      if (ended.status !== "merged" || ended.tip !== written || ended.ending?.id !== written) {
        throw new Error(
          `event queue ${url}#${queue}: observed merge for ${branch} wrote ${written} but read back ${ended.status} at ${ended.tip ?? "no tip"}`,
        )
      }
      changes.set(branch, ended)
      deliveredCommits.add(merge)
      deliveredCommits.add(change.commit)
      observedMerged.push(branch)
      await tell(branch, "merged", written)
      log.write({
        kind: "change",
        branch,
        head: change.commit,
        decision: "merged",
        reason: `already on target at ${merge}`,
      })
      await deleteMergedBranch(branch, change.commit)
    } catch (error) {
      let current
      try {
        current = await readChange(branch, "offTargetStatus")
      } catch (readError) {
        throw new AggregateError(
          [error, readError],
          `event queue ${url}#${queue}: ${branch} observed-merge decision failed and its current chain could not be read`,
        )
      }
      current = await rivalOrThrow(branch, selectedTip, current, error)
      changes.set(branch, current)
      log.write({
        kind: "discarded",
        branch,
        head: change.commit,
        reason: `change advanced to ${current.status} at ${current.tip ?? "no tip"} while this round recorded its target merge: ${error instanceof Error ? error.message : String(error)}`,
      })
      if (current.status === "merged") {
        if (current.merge === undefined) throw new Error(`validated merged change ${branch} has no merge commit`)
        if (current.commit === undefined) throw new Error(`validated merged change ${branch} has no submitted head`)
        deliveredCommits.add(current.merge)
        deliveredCommits.add(current.commit)
        observedMerged.push(branch)
      }
    }
  }
  const open: {
    branch: string
    status: string
    since: Date
    commit: string
    tip: string
    reason?: string
    issue?: string
    submitter?: string
  }[] = []
  for (const row of eventRows(changes)) {
    if (row.position === undefined) continue
    const branch = row.branch
    if (options.only !== undefined && (options.only.branch !== branch || options.only.head !== row.head)) continue
    const change = changes.get(branch)
    if (change === undefined) throw new Error(`event queue ${url}#${queue}: missing projected change ${branch}`)
    if (options.tier === "long" ? change.deferred === undefined : change.deferred !== undefined) continue
    if (change.since === undefined || change.commit === undefined || change.tip === undefined) {
      throw new Error(`event queue ${url}#${queue}: open change ${branch} lacks its opening time, commit or tip`)
    }
    open.push({
      branch,
      status: row.state,
      since: change.since,
      commit: change.commit,
      tip: change.tip,
      reason: change.reason,
      issue: change.issue,
      submitter: change.submitter,
    })
  }
  const endDeletedChange = async (selected: (typeof open)[number]): Promise<void> => {
    const { branch, commit: head } = selected
    let tip = selected.tip
    try {
      tip = await appendOwnedChange("cancelledWrite", store, queue, branch, tip, {
        type: "cancelled",
        at: new Date(),
        commit: head,
        reason: "deleted",
        title: `${branch} absent from remote`,
      })
      const ended = await readChange(branch, "deletedStatus")
      if (ended.status !== "cancelled" || ended.reason !== "deleted" || ended.commit !== head || ended.tip !== tip) {
        throw new Error(
          `event queue ${url}#${queue}: deleted branch ${branch} wrote ${tip} but read back ${ended.status} at ${ended.tip ?? "no tip"}`,
        )
      }
      log.write({ kind: "change", branch, head, decision: "cancelled", reason: "branch absent from remote" })
      await tell(branch, "cancelled", tip)
    } catch (error) {
      let current
      try {
        current = await readChange(branch, "deletedStatus")
      } catch (readError) {
        throw new AggregateError(
          [error, readError],
          `event queue ${url}#${queue}: ${branch} deletion decision failed and its current chain could not be read`,
        )
      }
      current = await rivalOrThrow(branch, tip, current, error)
      log.write({
        kind: "discarded",
        branch,
        head,
        reason: `change advanced to ${current.status} at ${current.tip ?? "no tip"} while this round ended its deleted branch: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  const repaired = await repairMissingBranchHeads(
    await withRemoteSeamGap("branchHeadsRepair", () => refsList("refs/heads/")),
    open.map(({ branch, since }) => ({ branch, openedAt: since.getTime() })),
    store.remote,
    (exact) => withRemoteSeamGap("headRepairProbe", () => refsList(exact)),
    options.now ?? Date.now,
    options.branchDeletionGraceMs,
  )
  log.write({
    kind: "observation",
    subject: "branch-list-omissions",
    count: repaired.omissions.length,
    branches: repaired.omissions.map((row) => row.branch),
  })
  for (const row of repaired.omissions) log.write({ kind: "observation", subject: "branch-list-omission", ...row })
  const branchHeads = repaired.heads
  const unconfirmed = new Set(repaired.omissions.filter((row) => row.protected).map((row) => row.branch))
  const remaining: typeof open = []
  for (const selectedChange of open) {
    // A merging marker owns this chain until its frozen landing settles, even
    // when the submitter deleted the branch name during a killed run.
    if (
      selectedChange.status === "merging" ||
      unconfirmed.has(selectedChange.branch) ||
      branchHeads.has(`refs/heads/${selectedChange.branch}`)
    ) {
      remaining.push(selectedChange)
    } else {
      await endDeletedChange(selectedChange)
    }
  }
  // THE LINE, journaled on every round (25669, @cto d3af5793): the waiting count
  // is the number the stall threshold is tuned from, and the service reads the
  // same reading off the outcome.
  const oldest = remaining.reduce<(typeof remaining)[number] | undefined>(
    (earliest, change) => (earliest === undefined || change.since < earliest.since ? change : earliest),
    undefined,
  )
  const roundLine: RoundLine = {
    waiting: remaining.length,
    ...(oldest === undefined ? {} : { oldest: { branch: oldest.branch, openedAt: oldest.since.toISOString() } }),
    ...(lastJudgedMs === undefined ? {} : { lastJudgedAt: new Date(lastJudgedMs).toISOString() }),
  }
  log.write({
    kind: "observation",
    subject: "line",
    waiting: roundLine.waiting,
    ...(roundLine.oldest === undefined
      ? {}
      : { oldestBranch: roundLine.oldest.branch, oldestOpenedAt: roundLine.oldest.openedAt }),
    ...(roundLine.lastJudgedAt === undefined ? {} : { lastJudgedAt: roundLine.lastJudgedAt }),
  })
  read.line = roundLine
  const writeStuckStop = async (
    branch: string,
    head: string,
    event: string,
    reason: string,
    next?: string,
  ): Promise<void> => {
    const current = await readOps("stuckOpsRead")
    if (
      current.stop?.cause === "stuck" &&
      current.stop.change?.branch === branch &&
      current.stop.change.head === head
    ) {
      if (current.stop.change.event === undefined || current.stop.change.event === event) return
    }
    if (current.stop !== undefined) {
      log.write({
        kind: "observation",
        subject: "stuck-stop-held-by-another-pause",
        branch,
        head,
        standing: current.stop.sha,
      })
      return
    }
    await withRemoteSeamGap("stuckPausedWrite", () =>
      writeQueueEvent(store, queue, {
        type: "paused",
        at: new Date(),
        by: "yrd",
        cause: "stuck",
        change: { branch, head, event },
        reason,
        next: next === undefined ? stuckCures(branch) : `${next}; ${stuckCures(branch)}`,
      }),
    )
  }
  let transientProbe: string | undefined
  const standing = remaining.find((change) => change.status === "stuck")
  if (standing !== undefined) {
    const retryNamedStuck =
      options.foreground === true && options.only?.branch === standing.branch && options.only.head === standing.commit
    const retryTransient = isTransientPushHold(standing.reason)
    if (
      !retryNamedStuck &&
      !retryTransient &&
      !(await withRemoteSeamGap("resumeRead", () =>
        queueResumedAfter(store, queue, standing.branch, histories.get(standing.branch)),
      ))
    ) {
      const stuckEvent = histories.get(standing.branch)?.events.findLast((event) => event.type === "stuck")
      if (stuckEvent === undefined) {
        throw new Error(`${changesRef(queue, standing.branch)}: standing stuck has no event`)
      }
      await writeStuckStop(
        standing.branch,
        standing.commit,
        stuckEvent.id,
        standing.reason ?? "queue could not judge this change",
      )
      writeStuck(standing.branch, standing.commit, {
        code: "yrd-stuck-held",
        subject: standing.reason ?? "queue could not judge this change",
        via: "held change",
        next: "inspect the standing stuck event and repair its cause before resuming the queue",
      })
      return result(2, observedMerged, [], [standing.branch])
    }
    if (retryTransient) {
      transientProbe = standing.branch
      log.write({
        kind: "observation",
        subject: "transient-push-probe",
        branch: standing.branch,
        head: standing.commit,
        reason: standing.reason,
      })
    } else {
      log.write({
        kind: "observation",
        subject: "queue-resumed",
        branch: standing.branch,
        head: standing.commit,
        reason: "queue resumed",
      })
    }
  }
  const line =
    standing === undefined ? remaining : [standing, ...remaining.filter((change) => change.branch !== standing.branch)]
  const failed: string[] = []
  const holdTransientPublication = async (
    branch: string,
    head: string,
    marker: string,
    hit: TransientPush5xx,
    via: string,
    already: Readonly<{ status: string; reason?: string }>,
  ): Promise<QueueRunOutcome> => {
    const request = hit.requestId === undefined ? "" : `; Request ID: ${hit.requestId}`
    const oneLine =
      `${branch}: ${TRANSIENT_PUSH_HOLD} on ${via} at ${marker}: ${hit.line}${request}; ` +
      "the queue retries this publication on its own cadence"
    if (already.status === "stuck" && isTransientPushHold(already.reason)) {
      log.write({
        kind: "warning",
        subject: "transient-push-5xx",
        branch,
        head,
        marker,
        requestId: hit.requestId,
        line: hit.line,
        reason: "hold remains; probe still 5xx",
      })
      return result(0, observedMerged, failed, [branch])
    }
    if (via === "change-ref publication") {
      // The atomic push that would carry a stuck event IS the one that just
      // failed (28793): record the hold locally, do not push again, and let the
      // next round retry the publication. The change keeps its standing status.
      writeStuck(branch, head, {
        code: "yrd-publication-5xx",
        subject: oneLine,
        via,
        next: "nothing: the queue retries this publication on its own cadence; no resume is needed",
        saw: hit.line,
      })
      return result(0, observedMerged, failed, [branch])
    }
    const ended = await appendOwnedChange("heldPublicationWrite", store, queue, branch, marker, {
      type: "stuck",
      at: new Date(),
      reason: oneLine,
    })
    await tell(branch, "stuck", ended)
    writeStuck(branch, head, {
      code: "yrd-publication-5xx",
      subject: oneLine,
      via,
      next: "nothing: the queue retries this publication on its own cadence; no resume is needed",
      saw: hit.line,
    })
    return result(0, observedMerged, failed, [branch])
  }
  const publish = async (
    branch: string,
    head: string,
    candidate: string,
    marker: string,
    reason?: string,
    freshInRound = false,
  ): Promise<QueueRunOutcome | undefined> => {
    const current = await readChange(branch, "publishStatus")
    if (current.tip !== marker) {
      log.write({
        kind: "discarded",
        branch,
        head,
        reason: discardedJudgementReason(current, "marker moved before child publication"),
      })
      return result(failed.length > 0 ? 1 : 0, observedMerged, failed)
    }
    const parent = (await git(["show", "-s", "--format=%P", candidate])).trim().split(/\s+/u)[0]
    if (parent === undefined || parent === "") throw new Error(`candidate ${candidate} has no target parent`)
    const ref = changesRef(queue, branch)
    const stopRejectedMerge = async (
      rejection: Readonly<{ reason: string; remoteReasons: readonly string[] }>,
    ): Promise<QueueRunOutcome> => {
      const description =
        `${branch}: remote rejected merge publication for ${ref} at ${marker}, target parent ${parent}: ` +
        `${rejection.reason}; reasons: ${rejection.remoteReasons.join("; ")}`
      const oneLine = description.replace(/\s+/gu, " ").trim()
      let ended: string
      try {
        ended = await appendOwnedChange("rejectedMergeWrite", store, queue, branch, marker, {
          type: "stuck",
          at: new Date(),
          reason: oneLine,
        })
      } catch (stuckError) {
        if (stuckError instanceof Conflict) {
          log.write({
            kind: "discarded",
            branch,
            head,
            ref,
            marker,
            reason: `remote rejected the merge, then a rival moved ${ref} before its stuck event: ${stuckError.message}`,
          })
          return result(failed.length > 0 ? 1 : 0, observedMerged, failed)
        }
        if (!(stuckError instanceof PublicationRejected)) throw stuckError
        log.write({
          kind: "warning",
          subject: "publication-rejected-stuck-refused",
          branch,
          head,
          ref,
          marker,
          targetParent: parent,
          reason: `merge refusal: ${rejection.reason}; stuck event refusal: ${stuckError.message}`,
        })
        return result(2, observedMerged, failed, [branch])
      }
      try {
        await writeStuckStop(branch, head, ended, oneLine)
      } catch (stuckError) {
        if (!(stuckError instanceof PublicationRejected)) throw stuckError
        log.write({
          kind: "warning",
          subject: "publication-rejected-stuck-refused",
          branch,
          head,
          ref,
          marker,
          targetParent: parent,
          reason: `merge refusal: ${rejection.reason}; pause event refusal: ${stuckError.message}`,
        })
        return result(2, observedMerged, failed, [branch])
      }
      await tell(branch, "stuck", ended)
      writeStuck(branch, head, {
        code: "yrd-publication-rejected",
        subject: oneLine,
        via: "merge publication",
        next: "repair the remote rejection, then resume the queue",
        saw: rejection.remoteReasons.join("; "),
      })
      return result(2, observedMerged, failed, [branch])
    }
    if (current.since === undefined) throw new Error(`${ref} at ${marker} has no opened time for rejection history`)
    const priorRejection = recentPublicationRejected(dirname(log.path), ref, marker, parent, current.since)
    if (
      priorRejection !== undefined &&
      matchTransientPush5xx([priorRejection.reason, ...priorRejection.remoteReasons].join("\n")) === undefined
    ) {
      return stopRejectedMerge(priorRejection)
    }
    const noteTransient = (attempt: TransientPushAttempt, probeError?: string): void => {
      log.write({
        kind: "warning",
        subject: "transient-push-5xx",
        branch,
        head,
        ref,
        marker,
        attempt: attempt.attempt,
        requestId: attempt.requestId,
        line: attempt.line,
        repository: attempt.repository,
        ...(probeError === undefined ? {} : { probeError }),
      })
    }
    let child
    try {
      child = await publishWithTransientRetry(
        () =>
          seamStep({ branch, head, name: "publish", phase: "merge" }, () =>
            publishCheckedChildren({
              git,
              cwd: options.repo,
              candidate,
              remote: options.target.remote,
              branch: queue,
              marker: { ref: changesRef(queue, branch), tip: marker },
              process: options.process,
              env: options.env,
              hooksPath,
              gitOptions,
            }),
          ),
        {
          repository: options.repo,
          ref,
          text: (published) => (published.state === "refused" ? published.evidence : ""),
          note: noteTransient,
        },
      )
    } catch (error) {
      const after = await readChange(branch, "publishedStatus")
      const rival = await rivalOrThrow(branch, marker, after, error)
      log.write({ kind: "discarded", branch, head, reason: discardedJudgementReason(rival, error) })
      return result(failed.length > 0 ? 1 : 0, observedMerged, failed)
    }
    if (child.state === "refused") {
      const hit = matchTransientPush5xx(child.evidence)
      if (hit !== undefined) {
        return holdTransientPublication(branch, head, marker, hit, "component publication", current)
      }
      const description =
        `${branch}: frozen component publication for ${candidate} refused: ${child.evidence}; ` +
        "repair the named component remote/ref, then resume the queue"
      const oneLine = description.replace(/\s+/gu, " ").trim()
      const ended = await appendOwnedChange("refusedPublicationWrite", store, queue, branch, marker, {
        type: "stuck",
        at: new Date(),
        reason: oneLine,
      })
      await writeStuckStop(branch, head, ended, oneLine)
      await tell(branch, "stuck", ended)
      writeStuck(branch, head, {
        code: "yrd-publication-refused",
        subject: oneLine,
        via: "component publication",
        next: "repair the named component remote/ref, then resume the queue",
        saw: child.evidence,
      })
      return result(2, observedMerged, failed, [branch])
    }
    let preparedMerge: string | undefined
    let ended: string | undefined
    try {
      const stagedMerge = await publishWithTransientRetry<StagedEvent>(
        (prepared) =>
          seamStep({ branch, head, name: "merge", phase: "merge" }, () =>
            appendOwnedMergeOnce(
              (staged) => {
                preparedMerge = staged.oid
                prepared(staged)
              },
              store,
              queue,
              branch,
              marker,
              {
                at: new Date(),
                commit: candidate,
                targetExpect: parent,
                queueTip: queueState.tip,
                run: log.id,
                ...(reason === undefined ? {} : { reason }),
              },
            ),
          ),
        {
          repository: options.target.remote,
          ref,
          note: noteTransient,
          // The same ambiguous-5xx probe the change path carries (28793, @cto): a
          // 500 after the atomic push landed returns the staged merge instead of
          // re-running it, so the merge is never duplicated nor the lease lost.
          landed: async (candidate) => {
            const remote = await withRemoteSeamGap("mergeLandedProbe", () =>
              readRemoteCommit(git, options.target.remote, ref),
            )
            if (remote === undefined || remote !== candidate.oid) return undefined
            if (runNumber === undefined && candidate.number !== undefined) {
              recordRunNumber(candidate.number)
            }
            return candidate
          },
        },
      )
      // The landed probe can return a staged merge without re-running the append,
      // so name it here too: rivalOrThrow reads `owned` to tell this round's own
      // merge from a rival's in a later same-round conflict on the change ref.
      owned.add(stagedMerge.oid)
      ended = stagedMerge.oid
    } catch (error) {
      if (error instanceof QueuePaused) {
        // The operator stopped the line after this round read its authority. Hold it as state, not a stuck run.
        log.write({ kind: "pause", reason: error.pause.reason, by: error.pause.by, sha: error.pause.sha })
        return result(failed.length > 0 ? 1 : 0, observedMerged, failed, [], [branch], {
          ring: "pause",
          says: error.pause.reason,
          what: error.pause,
        })
      }
      if (error instanceof PublicationRejected) {
        const hit = matchTransientPush5xx([error.message, error.detail, ...error.reasons].join("\n"))
        if (hit !== undefined) {
          return holdTransientPublication(branch, head, marker, hit, "merge publication", current)
        }
        log.write({
          kind: "warning",
          subject: "publication-rejected",
          branch,
          head,
          ref,
          marker,
          targetParent: parent,
          reason: error.message,
          remoteReasons: error.reasons,
        })
        return stopRejectedMerge({ reason: error.message, remoteReasons: error.reasons })
      }
      // Stage/write failures have no candidate event to reconcile and must
      // keep their original error. Only a publication attempt can be unknown.
      if (preparedMerge === undefined && !(error instanceof Conflict)) throw error
      if (error instanceof Conflict && error.refs.includes(queueRef(queue)) && !error.refs.includes(ref)) {
        const fresh = await readOps("publishOpsRead")
        if (fresh.queue.tip === queueState.tip) throw error
        log.write({
          kind: "warning",
          subject: "queue-lease-lost",
          branch,
          head,
          ref: queueRef(queue),
          expected: queueState.tip,
          actual: fresh.queue.tip,
          reason: `${queueRef(queue)} advanced from ${queueState.tip} to ${fresh.queue.tip} while judging ${branch}: ${error.message}`,
        })
        if (fresh.stop !== undefined && options.foreground !== true) {
          log.write({ kind: "pause", reason: fresh.stop.reason, by: fresh.stop.by, sha: fresh.stop.sha })
          return result(0, observedMerged, failed, [], [branch], {
            ring: "pause",
            says: fresh.stop.reason,
            what: fresh.stop,
          })
        }
        // A resume or override changes the authority used to judge this candidate.
        // The next service round rechecks it against the fresh operational state.
        return result(0, observedMerged, failed, [], [branch])
      }
      // A lease refusal on the queue tip is an authority change, not a transport
      // failure on this change chain. A lost target lease is the root race the
      // moved-target branch below records as `verifying` and retries. A Conflict
      // with no named refs has an unknown outcome, so it needs the readback below.
      if (
        error instanceof Conflict &&
        error.refs.length > 0 &&
        !error.refs.includes(ref) &&
        !error.refs.includes(targetRef)
      ) {
        throw error
      }
      let after: EventChange
      try {
        const present = (await withRemoteSeamGap("conflictChainReadback", () => refsList(ref))).get(ref)
        if (present === undefined) {
          log.write({
            kind: "warning",
            subject: "inconsistent-missing-chain",
            branch,
            head,
            ref,
            marker,
            reason: `${ref} disappeared after publication of ${branch} at ${marker}: ${error instanceof Error ? error.message : String(error)}`,
          })
          return undefined
        }
        after = await readChange(branch, "postMergeStatus")
      } catch (readError) {
        log.write({
          kind: "warning",
          subject: "round-read-failed",
          branch,
          head,
          ref,
          reason: `publication failed: ${error instanceof Error ? error.message : String(error)}; remote reread failed: ${readError instanceof Error ? readError.message : String(readError)}`,
        })
        throw new QueueAuthorityUnreadable(ref, readError, error)
      }
      if (after.tip !== marker) {
        if (after.tip === undefined) {
          log.write({
            kind: "warning",
            subject: "inconsistent-missing-chain",
            branch,
            head,
            ref,
            marker,
            reason: `${ref} has no tip after publication of ${branch} at ${marker}`,
          })
          return undefined
        }
        let successor: string | undefined
        try {
          const history = await readHistory(branch, after.tip, "afterHistory")
          const at = history.findIndex((event) => event.id === marker)
          successor = at < 0 ? undefined : history[at + 1]?.id
        } catch (readError) {
          log.write({
            kind: "warning",
            subject: "round-read-failed",
            branch,
            head,
            ref,
            reason: `publication failed: ${error instanceof Error ? error.message : String(error)}; remote reread failed: ${readError instanceof Error ? readError.message : String(readError)}`,
          })
          throw new QueueAuthorityUnreadable(ref, readError, error)
        }
        if (preparedMerge !== undefined && successor === preparedMerge) {
          const mergedSha = preparedMerge
          await timedStep(log, { branch, head, name: "notify", phase: "merge" }, () =>
            tell(branch, "merged", mergedSha),
          )
          log.write({
            kind: "merge",
            branch,
            head,
            commit: candidate,
            ref,
            marker,
            reason: "landed after unknown publication response",
          })
          log.write({
            kind: "change",
            branch,
            head,
            decision: "merged",
            reason: "landed after unknown publication response",
          })
          await deleteMergedBranch(branch, head)
          return result(failed.length > 0 ? 1 : 0, [...observedMerged, branch], failed, [], [], undefined, candidate)
        }
        if (successor === undefined) {
          log.write({
            kind: "warning",
            subject: "inconsistent-change-chain",
            branch,
            head,
            ref,
            marker,
            actual: after.tip,
            reason: `${ref} advanced to ${after.tip} but its history has no successor after ${marker}; publication error: ${error instanceof Error ? error.message : String(error)}`,
          })
          return undefined
        }
        log.write({
          kind: "discarded",
          branch,
          head,
          ref: changesRef(queue, branch),
          expected: marker,
          actual: after.tip,
          reason: discardedJudgementReason(after, error),
        })
        return undefined
      }
      const movedTarget = (await withRemoteSeamGap("movedTargetReadback", () => refsList(targetRef))).get(targetRef)
      if (movedTarget === undefined) {
        throw new Error(`event queue ${url}#${queue}: target disappeared after component publication`, { cause: error })
      }
      if (movedTarget === parent) {
        const typedRefusal = error instanceof Conflict && error.refs.includes(ref)
        if (after.since === undefined) throw new Error(`${ref} at ${marker} has no opened time for bounded CAS history`)
        const count =
          (typedRefusal
            ? recentCasRefusals(dirname(log.path), ref, marker, after.since)
            : recentPublicationNotLanded(dirname(log.path), ref, marker, after.since)) + 1
        const cause = error instanceof Error ? error.message : String(error)
        const warning =
          `${branch}: publication ${typedRefusal ? "CAS refused" : "did not land"} for ${ref} at ${marker} (${String(count)} consecutive); ` +
          `target ${targetRef} remains ${parent}; retry after this round: ${cause}`
        log.write({
          kind: "warning",
          subject: typedRefusal ? "cas-refused" : "publication-not-landed",
          branch,
          head,
          ref,
          marker,
          expected: marker,
          actual: after.tip,
          count,
          reason: warning,
        })
        if (count >= 3) {
          if (typedRefusal) {
            if (read.line === undefined) throw new Error(`${ref} refused publication before the line was read`)
            read.line = { ...read.line, casRefused: { branch, ref, marker, count } }
          } else {
            const stuckReason = `${branch}: publication did not land for ${ref} at ${marker} in ${String(count)} consecutive rounds: ${cause}`
            const ended = await appendOwnedChange("frozenComponentWrite", store, queue, branch, marker, {
              type: "stuck",
              at: new Date(),
              reason: stuckReason,
            })
            await writeStuckStop(branch, head, ended, stuckReason)
            await tell(branch, "stuck", ended)
            writeStuck(branch, head, {
              code: "yrd-publication-refused",
              subject: stuckReason,
              via: "merge publication",
              next: "inspect the publication refusal and remote refs, then resume the queue",
            })
            return result(2, observedMerged, failed, [branch])
          }
        }
        return undefined
      }
      // Name every lease the publication lost, so a record whose queue tip also
      // moved says so beside the target (@cto on 0bdd02ff62).
      const lost = error instanceof Conflict && error.refs.length > 0 ? `; lease lost on ${error.refs.join(", ")}` : ""
      await appendOwnedChange("movedTargetWrite", store, queue, branch, marker, {
        type: "verifying",
        at: new Date(),
        commit: candidate,
        reason: `root target moved after component publication from ${parent} to ${movedTarget}; components at frozen sources${lost}`,
      })
      log.write({
        kind: "change",
        branch,
        head,
        decision: "deferred",
        reason: "root target moved after component publication",
      })
      return result(failed.length > 0 ? 1 : 0, observedMerged, failed, [], [branch], undefined, movedTarget)
    }
    if (ended === undefined) throw new Error(`${changesRef(queue, branch)}: merged publication returned no event`)
    await timedStep(log, { branch, head, name: "notify", phase: "merge" }, () =>
      tell(branch, "merged", ended, undefined, freshInRound),
    )
    if (transientProbe === branch) {
      log.write({
        kind: "observation",
        subject: "transient-push-hold-cleared",
        branch,
        head,
        ref,
        marker,
        reason: "held 5xx publication landed",
      })
    }
    log.write({ kind: "merge", branch, head, commit: candidate, ref: changesRef(queue, branch), marker })
    log.write({ kind: "change", branch, head, decision: "merged" })
    await deleteMergedBranch(branch, head)
    return result(failed.length > 0 ? 1 : 0, [...observedMerged, branch], failed, [], [], undefined, candidate)
  }
  for (const selectedChange of line) {
    const { branch, commit: head } = selectedChange
    if (unconfirmed.has(branch) && selectedChange.status !== "merging") {
      log.write({ kind: "observation", subject: "branch-confirmation-pending", branch, head })
      return result(failed.length > 0 ? 1 : 0, observedMerged, failed, [], [branch])
    }
    let tip = selectedChange.tip
    if (options.stopAtMs !== undefined && (options.now?.() ?? Date.now()) >= options.stopAtMs) {
      return result(0, observedMerged, [], [], [branch])
    }
    const branchRef = `refs/heads/${branch}`
    if (
      selectedChange.status !== "merging" &&
      !(await withRemoteSeamGap("branchPresence", () => refsList(branchRef))).has(branchRef)
    ) {
      await endDeletedChange({ ...selectedChange, tip })
      continue
    }
    if (selectedChange.status === "merging") {
      const candidate = changes.get(branch)?.candidate
      if (candidate === undefined) {
        throw new Error(`event queue ${url}#${queue}: merging ${branch} lost its checked candidate`)
      }
      const published = await publish(branch, head, candidate, tip, selectedChange.reason)
      if (published !== undefined) return published
      continue
    }
    log.write({ kind: "change", branch, head })
    const path = join(options.workdir, "worktrees", log.id, branch.replaceAll("/", "_"))
    mkdirSync(join(options.workdir, "worktrees", log.id), { recursive: true })
    let verified: Awaited<ReturnType<typeof verifyCandidate>>
    try {
      verified = await seamStep({ branch, head, name: "compose", phase: "submit" }, () =>
        verifyCandidate({
          git,
          repo: options.repo,
          noFetch: true,
          targetHead: target,
          head,
          path,
          // The target's `derive:` regenerates what the merged gitlinks decide, inside this compose (27176); a
          // derive that fails ends the change stuck below, the queue's, never the submitter's.
          ...(options.derive === undefined
            ? {}
            : {
                derive: {
                  run: options.derive,
                  logDir: join(options.workdir, "checks", `${branch}@${head}`, log.id, "compose"),
                  tmpdir: options.tempRoot,
                },
              }),
          message: [
            `merge ${short(branch, head)} into ${queue}`,
            "",
            `Change: ${changeName({ branch, head })}`,
            `Merged-By: ${mergedBy(queue, log.id)}`,
            ...(selectedChange.issue === undefined ? [] : [`Issue: ${selectedChange.issue}`]),
            ...(selectedChange.submitter === undefined ? [] : [`Submitter: ${selectedChange.submitter}`]),
          ].join("\n"),
          process: options.process,
          env: options.env,
          hooksPath,
          timed: (name, work) => timedStep(log, { branch, head, phase: "submit", name }, work),
          worktree: {
            plumbing,
            env: options.env,
            gitOptions,
            populateReference: options.populateReference,
            process: options.process,
            selection: options.selection,
          },
        }),
      )
    } catch (error) {
      if (!(error instanceof DeriveFailed)) throw error
      const reason = `${DERIVE} stopped the compose: ${error.why}`
      const ended = await appendOwnedChange("deriveFailedWrite", store, queue, branch, tip, {
        type: "stuck",
        at: new Date(),
        reason,
      })
      await writeStuckStop(branch, head, ended, reason)
      await tell(branch, "stuck", ended)
      writeStuck(branch, head, {
        code: "yrd-derive-failed",
        subject: reason,
        via: `${DERIVE} in the compose of ${short(branch, head)}`,
        next: "read the derive log, repair the derive command or what it reads, then resume the queue",
      })
      return result(2, observedMerged, failed, [branch])
    }
    if (verified.state === "verified" && verified.verifying.derived !== undefined) {
      const { derived } = verified.verifying
      log.write({
        kind: "observation",
        subject: DERIVE,
        reason: `${derived.subject}: ${derived.submodules.map((row) => `${row.path} ${row.from.slice(0, 12)}..${row.to.slice(0, 12)}`).join(", ")}; composed ${derived.composed.slice(0, 12)} -> ${verified.verifying.candidate.slice(0, 12)} via carrier ${derived.carrier.slice(0, 12)}`,
      })
    }
    try {
      if (verified.state === "failed") {
        await seamStep({ branch, head, name: "remove", phase: "deprovision" }, () =>
          discardWorktree(verified.failedWorktree),
        )
        const ended = await appendOwnedChange("verificationFailedWrite", store, queue, branch, tip, {
          type: "failed",
          at: new Date(),
          reason: verified.verifying.detail.message,
        })
        await tell(branch, "failed", ended)
        log.write({ kind: "change", branch, head, decision: "failed" })
        failed.push(branch)
        continue
      }
      const candidate = verified.verifying.candidate
      let candidateConfig: Awaited<ReturnType<typeof readConfig>>
      try {
        candidateConfig = await readConfig(git, candidate, options.target)
      } catch (error) {
        if (!(error instanceof InvalidQueueConfig)) throw error
        const reason =
          error.cause instanceof UnknownConfigKey
            ? `${error.message}; the candidate is read by the running Yrd parser: if this key is intentional, land parser support first and run a Yrd version that recognizes it before submitting the config change`
            : error.message
        const ended = await appendOwnedChange("checksFailedWrite", store, queue, branch, tip, {
          type: "failed",
          at: new Date(),
          reason,
        })
        await tell(branch, "failed", ended)
        log.write({ kind: "change", branch, head, decision: "failed", reason })
        failed.push(branch)
        continue
      }
      // #27363: the compose revert detector's durable finding, and — under an explicit
      // `revert-guard: refuse` — the named stick BEFORE the merge CAS. The two decisions are
      // independent (#28000): a `bounded`-only proof is silent by design, so an admission warning
      // is written only when the report has something to say, while the refusal `refuse` promises
      // must still stick on any gap — bounded included, because a bounded search can hide a revert.
      const revertReport = verified.verifying.reverted
      const revertFinding = revertedPathsFinding(revertReport)
      const revertAction = revertGuardAction(revertReport, candidateConfig?.revertGuard ?? "observe")
      if (revertFinding !== undefined) {
        tip = await appendOwnedChange("revertedPathsWrite", store, queue, branch, tip, {
          type: "admission-warning",
          at: new Date(),
          commit: head,
          reason: revertFinding.reason,
          warningKind: "reverted-paths",
          title: `admission reverted paths ${short(branch, head)}`,
        })
        log.write({ kind: "observation", subject: "revert-guard", reason: revertFinding.reason })
      }
      if (revertAction === "stick") {
        // `stick` implies a report: the policy table only refuses on a named hit or gap. The named
        // fragment comes from the report itself, so a bounded refusal names the bound it reached.
        const named =
          revertReport === undefined ? "the guard could not name its proof" : revertedPathsReason(revertReport)
        const reason = `revert-guard stopped the compose: ${named}`
        const ended = await appendOwnedChange("revertGuardWrite", store, queue, branch, tip, {
          type: "stuck",
          at: new Date(),
          reason,
        })
        await writeStuckStop(branch, head, ended, reason)
        await tell(branch, "stuck", ended)
        writeStuck(branch, head, {
          code: "yrd-revert-guard-refused",
          subject: reason,
          via: `revert-guard in the compose of ${short(branch, head)}`,
          next: "read the revert-guard stop reason, repair the compose or lift the change, then resume the queue",
        })
        return result(2, observedMerged, failed, [branch])
      }
      const raises = (await readRootChanges(git, candidate))?.changes ?? []
      tip = await appendOwnedChange("verifyingWrite", store, queue, branch, tip, {
        type: "verifying",
        at: new Date(),
        commit: candidate,
      })
      // The run that checks it, named on the event: a branch-scoped show reads only event-linked journals (28615),
      // so a check still running is found through this trailer before any ending event names the run.
      tip = await appendOwnedChange("checkingWrite", store, queue, branch, tip, {
        type: "checking",
        at: new Date(),
        run: log.id,
      })
      const results: EventCheck[] = []
      let attemptedRetry = false
      let decisionResults: EventCheck[] = []
      let skippedByOverride = new Set<string>()
      let setupDecision:
        | { kind: "failed" | "stuck"; reason: string; fault?: ReturnType<typeof transportFaultIn> }
        | undefined
      const attributeCandidateSetup = async (
        error: SetupFailed,
        phase: "submit" | "merge",
        attempt: number,
        tmpdir: string,
        programCheck?: string,
      ): Promise<NonNullable<typeof setupDecision>> => {
        if (options.setup === undefined) {
          throw new Error(`event queue ${url}#${queue}: ${branch} setup failed without a setup declaration`, {
            cause: error,
          })
        }
        let ground: "passed" | "failed" = "failed"
        let baseFailure: SetupFailed | undefined
        try {
          const baseCommit = await settledBaseCommit({
            git,
            repo: options.repo,
            targetSha: target,
            raises,
            path: join(
              options.workdir,
              "worktrees",
              log.id,
              "compose",
              "base",
              `${branch.replaceAll("/", "_")}-${String(attempt)}`,
            ),
            branch,
            plumbing,
            env: options.env,
            gitOptions,
            populateReference: options.populateReference,
            process: options.process,
            selection: options.selection,
          })
          const baseTree = await pool.borrow({
            role: "base",
            commit: baseCommit,
            targetSha: target,
            note: (cause) => log.write({ kind: "warning", branch, head, reason: cause }),
            setup: {
              run: options.setup,
              logDir: join(
                options.workdir,
                "checks",
                `${branch}@${head}`,
                log.id,
                `attempt-${String(attempt)}`,
                "base",
              ),
              tmpdir,
            },
          })
          try {
            await pool.give(baseTree)
          } catch (error) {
            log.write({
              branch,
              head,
              kind: "warning",
              reason: `settled-base cleanup failed after attribution: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
          ground = "passed"
        } catch (baseError) {
          if (!(baseError instanceof SetupFailed)) {
            throw new AggregateError(
              [error, baseError],
              `event queue ${url}#${queue}: ${branch} setup failed and its base could not be judged`,
            )
          }
          baseFailure = baseError
        }
        results.push({
          run: error.ran.result,
          attempt,
          phase,
          ...(options.tier === "long" ? { tier: "long" as const } : {}),
        })
        if (programCheck !== undefined) {
          recordProgramVerdict(
            { log },
            { branch, head, name: `${SETUP}-program-subject-${programCheck}`, phase },
            error.ran.result,
            ground === "passed" ? "submitter" : "queue",
          )
        }
        let fault: ReturnType<typeof transportFaultIn>
        let logProblem: string | undefined
        if (ground === "failed") {
          try {
            fault = transportFaultIn(
              [
                readFileSync(error.ran.result.log, "utf8"),
                baseFailure === undefined ? "" : readFileSync(baseFailure.ran.result.log, "utf8"),
              ].join("\n"),
            )
          } catch (readError) {
            logProblem = `setup log unavailable for transport attribution: ${readError instanceof Error ? readError.message : String(readError)}`
          }
        }
        return {
          kind: ground === "passed" ? "failed" : "stuck",
          reason: `setup ${error.ran.result.result} on candidate; settled base setup ${ground}; ${error.message.replace(/\s+/gu, " ")}${logProblem === undefined ? "" : `; ${logProblem}`}`,
          ...(fault === undefined ? {} : { fault }),
        }
      }
      // #28503 slice 1: whether this candidate moves anything `setup:` reads. Read
      // once for the change; a phase with no check of its own runs setup only when
      // the candidate's OWN install inputs moved, since the target's install has
      // already proved the rest. A name-only diff: no blob hashing, no checkout.
      const installInputsMoved =
        options.noCheck === true || options.setup === undefined
          ? false
          : await installInputsChanged(git, target, candidate)
      // A declaration that names NO check at all is the exception: its setup is
      // then the round's whole work, and skipping it would quietly make the
      // declaration inert rather than merely cheap.
      const setupIsTheOnlyWork = options.setup !== undefined && options.checks.length === 0
      for (let attempt = 1; attempt <= 1 + TRANSPORT_RETRY_LIMIT; attempt++) {
        const startOfAttempt = results.length
        skippedByOverride = new Set()
        for (const phase of ["submit", "merge"] as const) {
          if (options.noCheck === true) {
            continue
          }
          if (allDeclaredChecksOff(options)) {
            if (phase === "merge") {
              const logDir = join(
                options.workdir,
                "checks",
                `${branch}@${head}`,
                log.id,
                `attempt-${String(attempt)}`,
                phase,
              )
              const synthesized = recordSynthesizedPassResults({
                log,
                branch,
                head,
                phase,
                logDir,
                checks: options.checks,
              })
              for (const checked of synthesized) {
                results.push({
                  run: checked,
                  attempt,
                  phase,
                })
              }
            }
            continue
          }
          const checks = options.checks.filter((check) => {
            if (check.run === "true" || !(check.on ?? ["merge"]).includes(phase)) return false
            const overridden =
              phase === "merge" &&
              operational.overrides.entries.some(
                (entry) => entry.check === check.name && isActive(entry, options.now?.() ?? Date.now()),
              )
            if (overridden) skippedByOverride.add(check.name)
            return !overridden
          })
          // A phase with no check of its own materializes a tree for one reason
          // only: early discovery that the candidate's own install inputs broke
          // provisioning (#28503). When the candidate moves none of what `setup:`
          // reads, the target's own install is the proof and the phase runs
          // nothing — unless the declaration names no check at all, where the
          // setup IS the work and skipping it would make the declaration inert.
          if (checks.length === 0 && !setupIsTheOnlyWork && !installInputsMoved) continue
          const logDir = join(
            options.workdir,
            "checks",
            `${branch}@${head}`,
            log.id,
            `attempt-${String(attempt)}`,
            phase,
          )
          const tmpdir = options.tempRoot
          const setupAbout = { branch, head, name: SETUP, phase }
          let worktree
          try {
            worktree = await seamStep({ branch, head, name: "prepare", phase }, () =>
              pool.borrow({
                role: "candidate",
                commit: candidate,
                targetSha: target,
                note: (cause) => log.write({ kind: "warning", branch, head, reason: cause }),
                ...(options.setup === undefined ? {} : { setup: { run: options.setup, logDir, tmpdir } }),
                starting: ({ log: path, start }) => recordProgramStart({ log }, { ...setupAbout, start, log: path }),
                record: ({ result: setupResult, start, end }) =>
                  recordProgramResult({ log }, { ...setupAbout, start, end }, setupResult),
              }),
            )
          } catch (error) {
            if (!(error instanceof SetupFailed)) throw error
            setupDecision = await attributeCandidateSetup(error, phase, attempt, tmpdir)
            break
          }
          try {
            for (const check of checks) {
              const evidencePhase = phase
              if (options.stopAtMs !== undefined && (options.now?.() ?? Date.now()) >= options.stopAtMs) {
                results.push({
                  run: {
                    name: check.name,
                    result: "deferred",
                    exit: 0,
                    durationMs: 0,
                    log: "",
                    why: "stop-time",
                    projectedMs: effectiveCheckTimeoutMs(check, options.tier),
                    boundMs: 0,
                  },
                  attempt,
                  phase: evidencePhase,
                  ...(options.tier === "long" ? { tier: "long" as const } : {}),
                })
                break
              }
              let checked: CheckResult
              if (check.programRoot === true) {
                try {
                  checked = await programRootCheck({
                    plumbing,
                    queueRun: true,
                    git,
                    repo: options.repo,
                    targetSha: target,
                    tree: worktree.tree,
                    spec: check,
                    branch,
                    head,
                    phase: evidencePhase,
                    root: join(options.workdir, "worktrees", log.id, "program", phase, String(attempt), check.name),
                    logDir,
                    tmpdir,
                    log,
                    setup: options.setup,
                    env: options.env,
                    process: options.process,
                    selection: options.selection,
                    gitOptions,
                    populateReference: options.populateReference,
                    tier: options.tier,
                  })
                } catch (error) {
                  if (!(error instanceof ProgramSubjectSetupFailed)) throw error
                  setupDecision = await attributeCandidateSetup(error.setup, phase, attempt, tmpdir, check.name)
                  break
                }
              } else {
                await restoreScripts(
                  { git, targetSha: target, process: options.process, selection: options.selection, gitOptions },
                  check,
                  worktree.path,
                )
                const start = new Date().toISOString()
                const about = { branch, head, name: check.name, phase: evidencePhase, start }
                recordProgramStart({ log }, { ...about, log: checkLogPath(logDir, check.name) })
                checked = await runCheck({
                  queueRun: true,
                  cwd: worktree.path,
                  tree: worktree.tree,
                  logDir,
                  tmpdir,
                  spec: check,
                  process: options.process,
                  env: options.env,
                  tier: options.tier,
                })
                recordProgramResult({ log }, { ...about, end: new Date().toISOString() }, checked)
              }
              results.push({
                run: checked,
                attempt,
                phase: evidencePhase,
                ...(options.tier === "long" ? { tier: "long" as const } : {}),
              })
              if (checked.result !== "pass") break
            }
          } finally {
            if (worktree !== undefined) {
              try {
                await seamStep({ branch, head, name: "remove", phase: "deprovision" }, () => pool.give(worktree))
              } catch (error) {
                log.write({
                  kind: "warning",
                  branch,
                  head,
                  reason: `returning the check tree to the pool failed: ${error instanceof Error ? error.message : String(error)}`,
                })
              }
            }
          }
          if (setupDecision !== undefined || results.slice(startOfAttempt).some(({ run }) => run.result !== "pass")) {
            break
          }
        }
        decisionResults = results.slice(startOfAttempt)
        if (setupDecision !== undefined) {
          if (attempt === 1 && setupDecision.kind === "stuck" && setupDecision.fault !== undefined) {
            attemptedRetry = true
            log.write({
              kind: "warning",
              branch,
              head,
              reason: "retried",
              remote: setupDecision.fault.signature,
              subject: setupDecision.fault.line,
            })
            setupDecision = undefined
            continue
          }
          break
        }
        const stoppedThisAttempt = decisionResults.find(({ run }) => run.result !== "pass")
        if (attempt === 1 && stoppedThisAttempt?.run.result === "stuck") {
          const check = stoppedThisAttempt.run
          let checkLog = ""
          try {
            checkLog = readFileSync(check.log, "utf8")
          } catch (error) {
            log.write({
              kind: "warning",
              branch,
              head,
              reason: `retry attribution could not read check log ${check.log}: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
          const fault = transportFaultIn(`${checkLog}\n${check.why ?? ""}`)
          if (fault !== undefined) {
            attemptedRetry = true
            log.write({
              kind: "warning",
              branch,
              head,
              reason: "retried",
              remote: fault.signature,
              subject: fault.line,
            })
            continue
          }
        }
        break
      }
      const stopped = decisionResults.find(({ run }) => run.result !== "pass")
      const stoppedCheck = stopped?.run
      if (setupDecision !== undefined) {
        const ended = await appendOwnedChange("setupDecisionWrite", store, queue, branch, tip, {
          type: setupDecision.kind,
          at: new Date(),
          commit: candidate,
          base: target,
          config: options.configBlob,
          checks: attemptedRetry && setupDecision.kind === "stuck" ? results : decisionResults,
          reason: setupDecision.reason,
          ...(attemptedRetry && setupDecision.kind === "stuck" ? { retry: { retried: 1 as const } } : {}),
        })
        if (setupDecision.kind === "stuck") {
          await writeStuckStop(branch, head, ended, setupDecision.reason, setupStuckNext(setupDecision.fault))
        }
        await tell(branch, setupDecision.kind, ended)
        if (setupDecision.kind === "stuck") {
          writeStuck(branch, head, {
            code: setupStuckCode(setupDecision.fault),
            subject: `${setupDecision.reason}${setupDecision.fault === undefined ? "" : `; ${setupDecision.fault.signature}: ${setupDecision.fault.line}`}`,
            via: "setup",
            next: setupStuckNext(setupDecision.fault),
          })
        } else {
          log.write({ kind: "change", branch, head, decision: setupDecision.kind, reason: setupDecision.reason })
        }
        if (setupDecision.kind === "stuck") return result(2, observedMerged, failed, [branch])
        failed.push(branch)
        continue
      }
      const evidence: { checks: EventCheck[]; base: string; config: string; commit: string; run: string } = {
        checks: attemptedRetry && stoppedCheck?.result === "stuck" ? results : decisionResults,
        base: target,
        config: options.configBlob,
        commit: candidate,
        run: log.id,
      }
      if (stoppedCheck?.result === "fail") {
        // A raised gitlink belongs to the queue's settled ground. Re-run the
        // declared phase through this check on target + raises, without the
        // submitter's authored content, before charging the submitter.
        if (raises.length > 0 && stopped !== undefined) {
          const offer = await narrowingOf(stoppedCheck.log)
          if (offer.kind === "refused") {
            log.write({
              kind: "narrowing",
              branch,
              head,
              name: stoppedCheck.name,
              reason: offer.why,
              scope: "full",
            })
          }
          const baseScope = offer.kind === "narrowed" ? ("narrowed" as const) : ("full" as const)
          const extraEnv = {
            ...(offer.kind === "narrowed" ? offer.env : {}),
            YRD_CHECK_SCOPE: "settled-base-attribution",
          }
          const baseLogDir = join(
            options.workdir,
            "checks",
            `${branch}@${head}`,
            log.id,
            `attempt-${String(stopped.attempt)}`,
            "base",
          )
          const baseTmpdir = options.tempRoot
          let baseFailure: CheckResult | undefined
          let baseProblem: string | undefined
          let baseWorktree
          try {
            const baseCommit = await settledBaseCommit({
              git,
              repo: options.repo,
              targetSha: target,
              raises,
              path: join(
                options.workdir,
                "worktrees",
                log.id,
                "compose",
                "base",
                `${branch.replaceAll("/", "_")}-${String(stopped.attempt)}`,
              ),
              branch,
              plumbing,
              env: options.env,
              gitOptions,
              populateReference: options.populateReference,
              process: options.process,
              selection: options.selection,
            })
            baseWorktree = await pool.borrow({
              role: "base",
              commit: baseCommit,
              targetSha: target,
              note: (cause) => log.write({ kind: "warning", branch, head, reason: cause }),
              ...(options.setup === undefined
                ? {}
                : { setup: { run: options.setup, logDir: baseLogDir, tmpdir: baseTmpdir } }),
            })
            const phaseChecks = decisionResults.filter(({ phase }) => phase === stopped.phase)
            for (const row of phaseChecks) {
              const check = options.checks.find(({ name }) => name === row.run.name)
              if (check === undefined) {
                throw new Error(
                  `the declared ${stopped.phase} check ${row.run.name} disappeared before base attribution`,
                )
              }
              // Earlier checks can prepare the ground for the failed check.
              // Only the failed check receives the scope it offered.
              const scope = row.run.name === stoppedCheck.name ? baseScope : "full"
              const checkEnv =
                row.run.name === stoppedCheck.name ? extraEnv : { YRD_CHECK_SCOPE: "settled-base-attribution" }
              let checked: CheckResult
              if (check.programRoot === true) {
                checked = await programRootCheck({
                  plumbing,
                  queueRun: true,
                  git,
                  repo: options.repo,
                  targetSha: target,
                  tree: baseWorktree.tree,
                  spec: check,
                  branch,
                  head,
                  phase: "base",
                  root: join(
                    options.workdir,
                    "worktrees",
                    log.id,
                    "program",
                    "base",
                    String(stopped.attempt),
                    check.name,
                  ),
                  logDir: baseLogDir,
                  tmpdir: baseTmpdir,
                  log,
                  setup: options.setup,
                  env: options.env,
                  extraEnv: checkEnv,
                  scope,
                  process: options.process,
                  selection: options.selection,
                  gitOptions,
                  populateReference: options.populateReference,
                  tier: options.tier,
                })
              } else {
                await restoreScripts(
                  { git, targetSha: target, process: options.process, selection: options.selection, gitOptions },
                  check,
                  baseWorktree.path,
                )
                const start = new Date().toISOString()
                const about = { branch, head, name: check.name, phase: "base", scope, start }
                recordProgramStart({ log }, { ...about, log: checkLogPath(baseLogDir, check.name) })
                checked = await runCheck({
                  queueRun: true,
                  cwd: baseWorktree.path,
                  tree: baseWorktree.tree,
                  logDir: baseLogDir,
                  tmpdir: baseTmpdir,
                  spec: check,
                  process: options.process,
                  env: options.env,
                  extraEnv: checkEnv,
                  tier: options.tier,
                })
                const endedAbout = { ...about, end: new Date().toISOString() }
                recordProgramEnd({ log }, endedAbout, checked)
                recordProgramVerdict({ log }, endedAbout, checked, "queue")
              }
              if (checked.result !== "pass") {
                baseFailure = checked
                break
              }
            }
          } catch (error) {
            baseProblem = error instanceof Error ? error.message : String(error)
          } finally {
            if (baseWorktree !== undefined) {
              try {
                await pool.give(baseWorktree)
              } catch (error) {
                log.write({
                  kind: "warning",
                  branch,
                  head,
                  reason: `settled-base cleanup failed after attribution: ${error instanceof Error ? error.message : String(error)}`,
                })
              }
            }
          }
          if (baseProblem !== undefined || baseFailure !== undefined) {
            const baseUnresolved = baseProblem !== undefined || baseFailure?.result !== "fail"
            const code = baseUnresolved ? "yrd-check-unresolved" : "yrd-settled-base-check-failed"
            const reason =
              baseProblem !== undefined
                ? `${stoppedCheck.name} failed on candidate; settled base could not be judged: ${baseProblem}`
                : `${stoppedCheck.name} failed on candidate; settled base ${baseFailure?.name} ${baseFailure?.result} (log ${baseFailure?.log})`
            const ended = await appendOwnedChange("stuckWrite", store, queue, branch, tip, {
              type: "stuck",
              at: new Date(),
              ...evidence,
              reason,
            })
            await writeStuckStop(branch, head, ended, reason)
            await tell(branch, "stuck", ended)
            writeStuck(branch, head, {
              code,
              subject: reason,
              via: `check ${stoppedCheck.name} on the settled base`,
              next: "inspect the named settled-base check log and raised component, repair the cause, then resume the queue",
            })
            return result(2, observedMerged, failed, [branch])
          }
        }
        const ended = await appendOwnedChange("stoppedFailedWrite", store, queue, branch, tip, {
          type: "failed",
          at: new Date(),
          ...evidence,
          reason: `${stoppedCheck.name} failed (exit ${String(stoppedCheck.exit)}; log ${stoppedCheck.log})`,
        })
        await tell(branch, "failed", ended)
        log.write({
          kind: "change",
          branch,
          head,
          decision: "failed",
          reason: `${stoppedCheck.name} exited ${String(stoppedCheck.exit)}`,
        })
        failed.push(branch)
        continue
      }
      if (stoppedCheck?.result === "stuck") {
        const reason = `${stoppedCheck.name} could not judge (${stoppedCheck.why ?? `exit ${String(stoppedCheck.exit)}`}; log ${stoppedCheck.log})`
        const ended = await appendOwnedChange("retriedStuckWrite", store, queue, branch, tip, {
          type: "stuck",
          at: new Date(),
          ...evidence,
          ...(attemptedRetry ? { retry: { retried: 1 as const } } : {}),
          // The change's reason is the composed diagnosis, so status says why it is stuck (26089);
          // the code travels on the stuck record below.
          reason,
        })
        await writeStuckStop(branch, head, ended, reason)
        await tell(branch, "stuck", ended)
        writeStuck(branch, head, {
          code: "yrd-check-unresolved",
          subject: reason,
          via: `check ${stoppedCheck.name}`,
          next: "inspect the named check log and repair the check or its environment, then resume the queue",
        })
        return result(2, observedMerged, failed, [branch])
      }
      if (stoppedCheck?.result === "deferred") {
        const reason = `${stoppedCheck.name} deferred (${stoppedCheck.why ?? "outside normal window"}; log ${stoppedCheck.log})`
        const ended = await appendOwnedChange("deferredWrite", store, queue, branch, tip, {
          type: "deferred",
          at: new Date(),
          ...evidence,
          reason,
          deferred: {
            check: stoppedCheck.name,
            phase: stopped?.phase ?? "merge",
            reason,
            projectedMs: stoppedCheck.projectedMs ?? 0,
            boundMs: stoppedCheck.boundMs ?? 0,
          },
        })
        await tell(branch, "deferred", ended)
        log.write({ kind: "change", branch, head, decision: "deferred", reason })
        deferredChanges.push(branch)
        continue
      }
      const passedLogs = decisionResults
        .filter(
          ({ run }) =>
            run.result === "pass" && options.checks.some((check) => check.name === run.name && check.run !== "true"),
        )
        .map(({ run }) => run.log)
      const skippedChecks = options.checks.flatMap((check) => {
        if (options.noCheck === true) return [`${check.name} (no-check mode)`]
        if (check.run === "true") return [`${check.name} (configured off)`]
        if (skippedByOverride.has(check.name)) return [`${check.name} (merge override)`]
        return []
      })
      const checkReason =
        [
          ...(passedLogs.length === 0 ? [] : [`merge checks passed; logs: ${passedLogs.join(", ")}`]),
          ...(skippedChecks.length === 0 ? [] : [`skipped checks: ${skippedChecks.join(", ")}`]),
        ].join("; ") || undefined
      tip = await appendOwnedChange("mergingWrite", store, queue, branch, tip, {
        type: "merging",
        at: new Date(),
        ...evidence,
        ...(checkReason === undefined ? {} : { reason: checkReason }),
      })
      const published = await publish(branch, head, candidate, tip, checkReason, true)
      if (published !== undefined) return published
    } catch (error) {
      if (error instanceof QueueAuthorityUnreadable) throw error
      // ONE place a persistent change-ref 5xx becomes a HOLD, not exit 2 (28793,
      // @cto). It is recognized BEFORE any further remote read, and holds on the
      // state this round already read: the same outage that failed the push would
      // fail a fresh readStatus too, and letting that throw would exit the runner —
      // the exact outcome this bead removes (@dev/6 P1). Every other error still
      // reconciles against the remote below; nothing is swallowed.
      if (error instanceof ChangeRefPublicationHeld) {
        return holdTransientPublication(
          error.branch,
          head,
          error.marker,
          error.hit,
          "change-ref publication",
          selectedChange,
        )
      }
      let current
      try {
        current = await readChange(branch, "finalStatus")
      } catch (readError) {
        throw new AggregateError(
          [error, readError],
          `event queue ${url}#${queue}: ${branch} decision failed and its current chain could not be read`,
        )
      }
      current = await rivalOrThrow(branch, tip, current, error)
      changes.set(branch, current)
      log.write({
        kind: "discarded",
        branch,
        head,
        reason: discardedJudgementReason(current, error),
      })
    }
  }
  return result(failed.length > 0 ? 1 : 0, observedMerged, failed)
}
