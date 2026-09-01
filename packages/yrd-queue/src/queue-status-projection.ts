/**
 * The queue's DISPLAY-STATE projection: what every status surface needs to
 * know about one record, derived once from `changeDeliveryState` (the
 * model-side primitive) plus run/eligibility context. Moved here from
 * `@yrd/cli`'s queue-status-view so the projection has one home a non-view
 * consumer can import without reaching into a view file (5a: one derivation
 * per fact).
 */
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  type BaysState,
  type Change,
  changeDeliveryState,
  type ChangeDeliveryState,
  changeHead,
  changeProps,
  type ChangeProps,
  type ChangeRevClock,
  changeRevisionLineage,
  changeRevisionNumber,
  type ChangeRevTerminal,
  currentAdmissionFinish,
  changeSourceReadyAt,
  currentChangeRev,
  formatChangeRevisionSelector,
  isNonCheckableChangeState,
  parseChangeSelector,
  resolveChange,
} from "@yrd/bay"
import { type Event, type JsonValue, stageAsync } from "@yrd/core"
import { type Job, type JobError, JobRequestSchema, JobTransitionSchema } from "@yrd/job"
import { GateCertificateSchema } from "./command.ts"
import { isDerivedMemberId } from "./derived-admission.ts"
import {
  type Candidate,
  type ChangeCheckRecord,
  type ChangeEligibility,
  type InstalledStep,
  type IntegrationProof,
  type QueueAuditFinding,
  queueMemberKind,
  type QueueMemberKind,
  type QueueStep,
  type QueueSummary,
  type Run,
} from "./model.ts"

/**
 * Everything the queue surfaces need to know about ONE record's display, from
 * ONE walk of it: which kind it is, whether it is settled, its delivery state,
 * and its pre-run band.
 *
 * There used to be three derivations of this. `changeDeliveryState` (the model-side
 * primitive, which stays and which this consumes), `projectedPrStatus`, and
 * `preRunTimelineStatus` each walked the same record toward the same question
 * and disagreed at the edges, because the closed-record guard existed in
 * exactly ONE of them: a withdrawn PR whose stale `needsAuthor` outlived its
 * close rendered `rev` on the timeline forever while the sibling surface
 * correctly said `withdrawn`. That is the shape docs/lessons/no-parallel-
 * derivation.md names — two systems computing the same derived quantity diverge
 * on the inputs nobody thought to test, and every new surface is one more edge
 * to keep in sync by hand.
 *
 * So the guard lives here, once. The former derivers select a field off this
 * one computation, and the word/colour/filter re-mappers downstream consume the
 * result rather than deriving it again.
 */
export type QueueDisplayState = Readonly<{
  /** Which kind of record this is. Carried so no renderer re-parses the id
   * string — the mechanism of @i/10-merge-queue/22924-pr-prefix-on-non-pr.
   * `undefined` means neither schema claimed the id; nobody may assume `pr`. */
  kind: QueueMemberKind | undefined
  /** Settled by intent: closed, so integrated / already-landed / canceled /
   * withdrawn and nothing open-only can still be true of it. */
  terminal: boolean
  /** The record's own delivery state, before any eligibility overlay. */
  native: ChangeDeliveryState
  /** The delivery state a surface shows, `needs-author` included. */
  delivery: ChangeDeliveryState | "needs-author"
  /** The pre-run timeline band, or undefined when the record is settled or
   * belongs to no pre-run band at all. */
  preRun: "draft" | "rev" | "ready" | undefined
}>

export function queueDisplayState(
  pr: Change,
  options: Readonly<{ eligibility?: ChangeEligibility; runs?: readonly Run[] }> = {},
): QueueDisplayState {
  const kind = queueMemberKind(pr.id)
  const native = changeDeliveryState(pr)
  // `needs-author` is an OPEN-only value, and `PR.needsAuthor` is cleared by
  // re-merge, submitted, admission-recorded and already-landed but never by
  // withdrawn, integrated or canceled — so a stored refusal outlives every
  // closing path. Terminality is therefore read first, everywhere, by everyone.
  //
  // A closed record keeps its FULL truth in `delivery` (withdrawn / canceled /
  // integrated / already-landed) and takes `preRun: undefined`. That is the one
  // place closed maps to absent-from-the-timeline, and it is a property of the
  // timeline's vocabulary rather than of the record: `QueueTimelineStatus` has
  // no `withdrawn` member, and the sibling PR projection independently drops
  // the same three states from its list (see `projectedPRRows` consumers
  // filtering `nativeStatus` integrated/already-landed/withdrawn, ~:3862).
  // Callers that DO have a word for a closed record read `delivery`.
  if (pr.state === "closed") return { kind, terminal: true, native, delivery: native, preRun: undefined }
  const delivery = options.eligibility?.reason?.code === "needs-author" ? "needs-author" : native
  return {
    kind,
    terminal: false,
    native,
    delivery,
    preRun: preRunBand(pr, native, options.runs ?? [], options.eligibility),
  }
}

/**
 * The pre-run band of an OPEN record: `draft`/`rev` for a registered-but-
 * unsubmitted PR (delivery `pushed`) and `ready` for one awaiting its run.
 * `rev` is a draft carrying failed-submission history — the user's "a failed
 * submission returns the change to an editable state" — and stores no new status record.
 * A `rejected` PR resurfaces as `rev` IMMEDIATELY (21707: rejection is a
 * submission fact, not a change resting state), scope-limited to PRs whose failed
 * run the result still retains, so the pre-cutover backlog of ancient rejected
 * PRs cannot flood the band; once the run ages out, the corpse stays hidden.
 *
 * Terminal records never reach here — {@link queueDisplayState} returns before
 * calling it — which is the whole point of the guard living in one place.
 */
function preRunBand(
  pr: Change,
  native: ChangeDeliveryState,
  runs: readonly Run[],
  eligibility: ChangeEligibility | undefined,
): "draft" | "rev" | "ready" | undefined {
  if (native === "needs-author") return "rev"
  if (eligibility?.reason?.code === "required-check-failed") return "rev"
  if (native === "submitted" || native === "ready") return "ready"
  if (native === "pushed") return lastFailedSubmission(pr) === undefined ? "draft" : "rev"
  if (native === "rejected") {
    const runId = lastFailedSubmission(pr)?.terminal?.run
    if (runId !== undefined && runs.some((run) => run.id === runId)) return "rev"
  }
  return undefined
}

/** Thin consumer of {@link queueDisplayState} — kept as the named surface every
 * status caller already reads, but no longer a second derivation of it. */
export function projectedChangeStatus(
  pr: Change,
  eligibility?: ChangeEligibility,
): ChangeDeliveryState | "needs-author" {
  return queueDisplayState(pr, eligibility === undefined ? {} : { eligibility }).delivery
}

/** The most recent failed submission (a `rejected` terminal) a change's revision
 * history records, or undefined when it has never failed a submission. This is
 * the derived signal — never a stored status — that turns a `draft` into a
 * `rev` row. `canceled`/`withdrawn` terminals are supersessions, not
 * failures, so they do not count. */
export function lastFailedSubmission(pr: Change): Change["revs"][number] | undefined {
  return pr.revs.filter((revision) => revision.terminal?.kind === "rejected").at(-1)
}

const sourceRowKey = ["li", "ne"].join("") as `${"li"}${"ne"}`

export function changeIdValue(pr: string): string {
  return (parseChangeSelector(pr)?.pr ?? pr).replace(/^PR/iu, "")
}

/**
 * Retry — the SAME submission re-run N times by the queue (base moved, transient
 * fail) — rides the change identity as `×N`, distinct from the `.N` submission mark.
 * A single run (first try) is bare. Mirrors the timeline's storm `×N`
 * vocabulary; each retry is its own run id (see runOutputQueueageIndex).
 *
 * Note (submission/draft model, @yrd/core/21679): `.N` is the submission number
 * and is shown from `.1` — a bare `pr#324` is reserved to mean DRAFT (zero
 * submissions) once the draft state merges. Do NOT omit `.1`.
 */
export function retrySuffix(times: number | undefined): string {
  return times !== undefined && times > 1 ? `×${times}` : ""
}

export function formatQueueChangeId(pr: string, revision: number | string, times?: number): string {
  const parsedRevision = typeof revision === "number" ? revision : Number(revision)
  return `${formatChangeRevisionSelector(pr, parsedRevision)}${retrySuffix(times)}`
}

export function runIdValue(run: string): string {
  return run.replace(/^R(?=\d+$)/u, "")
}

export type QueueStatusResult = QueueSummary &
  Readonly<{
    headSha?: string
    prs: Change[]
    admissionOrder: readonly string[]
    candidates?: readonly Candidate[]
    eligibilities?: readonly ChangeEligibility[]
  }>

type QueuePauseAllowListMember = Readonly<{
  id: string
  status: ChangeDeliveryState | "unknown"
}>

type QueuePauseHealth = Readonly<{
  members: readonly QueuePauseAllowListMember[]
  blocksAll: boolean
}>

export function queuePauseHealth(state: BaysState, pause: NonNullable<QueueSummary["pause"]>): QueuePauseHealth {
  const members = pause.allowedPRs.map((id) => {
    const pr = resolveChange(state, id)
    return { id, status: pr === undefined ? ("unknown" as const) : changeDeliveryState(pr) }
  })
  return {
    members,
    blocksAll:
      members.length > 0 && members.every(({ status }) => status !== "unknown" && isNonCheckableChangeState(status)),
  }
}

export function queuePauseAllowedText(
  pause: NonNullable<QueueSummary["pause"]>,
  health: QueuePauseHealth | undefined,
): string {
  if (pause.allowedPRs.length === 0) return "none"
  return health?.members.map(({ id, status }) => `${id} ${status}`).join(", ") ?? pause.allowedPRs.join(", ")
}

export function queuePauseWarnings(state: BaysState, results: readonly QueueStatusResult[]): string[] {
  return results.flatMap((result) => {
    if (result.pause === undefined) return []
    const health = queuePauseHealth(state, result.pause)
    if (!health.blocksAll) return []
    return [
      `[pause-blocks-all] queue '${result.base}' pause blocks every change: all allowed PRs are terminal (${queuePauseAllowedText(result.pause, health)})`,
    ]
  })
}

export type QueueTimelineRow = Readonly<{
  key: string
  pr: string
  revision: number
  candidateId?: string
  run?: string
  position?: number
  base: string
  status: string
  subject: string
  detail: string
  clock: string
  timestampMs: number
}>

export type QueueTimelineStatusFilter = "pending" | "running" | "rejected" | "integrated" | "other"

export type QueueTimelineGroup = "draft" | "pending" | "running" | "completed"

export type QueueTimelineRevisionLineage = Readonly<{
  pr: string
  revisions: readonly number[]
  /** Draft/registration clock when retained; absent for legacy submissions. */
  registeredAt?: string
  sourceReadyAt?: string
}>

export type QueueTimelineRepeat = Readonly<{
  key: string
  count: number
  firstTimestamp: string
  lastTimestamp: string
  collapsed: boolean
}>

/** One canonical queue audit observation. Its time is independent from the
 * habitant heartbeat: ticking and measuring outcome progress are different facts. */
export type QueueRunnerProgress = Readonly<{ observedAt: string }> &
  (Readonly<{ state: "healthy" }> | Readonly<{ state: "stalled"; findings: readonly QueueAuditFinding[] }>)

export const QueueRunnerProgress = Object.freeze({
  ageMs(progress: QueueRunnerProgress, nowMs: number): number | undefined {
    const observedAt = Date.parse(progress.observedAt)
    const ageMs = Math.max(0, nowMs - observedAt)
    return Number.isFinite(ageMs) ? ageMs : undefined
  },
})

export type QueueDriverEpoch = Readonly<{
  /** Repository-scoped queue identity; a service name is never a driver identity. */
  queueId: string
  /** One habitant lifetime. A same-PID exec reload mints a successor epoch. */
  epoch: string
  /** Latest proven queue merge, or null before this queue has merged anything.
   * Optional for status written by older habitants (pre-2026-08-18 they wrote
   * this field as `lastLanded`); absence is unknown, never "nothing merged". */
  lastMerged?: Readonly<{ commit: string; at: string }> | null
}>

/** The pin-relative states a runner's source line can render. `unpinned` never
 * reaches this type — an unpinned queue attaches no `sourcePin` at all — so
 * every present value is a positive claim about the RECORDED pin. */
export type RunnerSourcePin =
  | Readonly<{ state: "at" }>
  | Readonly<{ state: "behind"; commits: number }>
  | Readonly<{ state: "unknown"; reason: string }>

/** What a resident publishes about the plan it can execute. */
export type HabitantInstalledPlan = Readonly<{
  batchSize: number
  steps: readonly InstalledStep[]
}>

export type QueueRunnerRefusal = Readonly<{
  code: string
  message: string
  run?: string
  step?: string
}>

/**
 * Why no runner is draining this queue, for the surfaces that must say so.
 *
 * Display collapses a departed runner to `runner: null` (run.ts
 * `activeHabitantRunner`), and that collapse threw away the one fact the
 * operator needs: whether the runner that was here is GONE, or whether none was
 * ever here. Both printed "NO RUNNER - no drained run in window" — cli.test.ts
 * asserted the identical string for a dead-pid runner and a missing status file
 * — so the banner could not tell a crash from a queue nobody ever staffed.
 *
 * `departed` carries the pid and the last moment the runner was known alive:
 * `clean` when it wrote its own exit marker (an operator or drain stop), false
 * when the marker is missing and only a dead pid proves it went (SIGKILL, OOM,
 * crash).
 */
export type QueueRunnerAbsence =
  | Readonly<{ kind: "departed"; pid: number; clean: boolean; lastAliveMs: number }>
  | Readonly<{ kind: "never" }>

/**
 * One queue the projection covers, under the three-tier naming model
 * (operator rulings 2026-08-18, items 32a/34/36):
 *
 * - `label` — the DIGIT filter accelerator: this queue's position in `queues`,
 *   stable for a given snapshot, primary base first. It toggles the queue's
 *   pill and never appears in a name (item 34 kills the `1:` run prefix).
 * - `base` + `path` — the identity pair; `path@base` is the canonical FQN.
 *   `path` is absent when the surface does not know its repository root.
 * - `name` — the short config handle (`code`, `pm`) when one is declared;
 *   run names lead with it (`code#23423`), falling back to `base`.
 */
export type QueueTimelineQueue = Readonly<{
  label: number
  base: string
  path?: string
  name?: string
  /** The typeable script-stable address: `path@branch` when the repository
   * path is known, the bare branch otherwise (items 34/36 — scripts never
   * re-derive it). */
  address: string
}>

export type DurationDistribution = Readonly<{
  n: number
  minMs: number | null
  avgMs: number | null
  p50Ms: number | null
  p90Ms: number | null
  maxMs: number | null
}>

export type QueueWaitDistribution = Readonly<{
  n: number
  avgMs: number | null
  p50Ms: number | null
  p90Ms: number | null
  maxMs: number | null
}>

export type QueueFlowMetrics = Readonly<{
  windowMs: number
  terminalAttempts: number
  outcomes: Readonly<{
    integrated: number
    alreadyMerged: number
    /** Completed without merge proof — not a merge (21801/22323). */
    passed: number
    rejected: number
    environmentRefused: number
    stale: number
    lost: number
    legacy: number
    refused: number
    canceled: number
  }>
  decisionRejection: Readonly<{
    rejected: number
    decisions: number
    rate: number | null
  }>
  // Merged count over the window projected to a per-24h rate. per24h is null
  // only for a zero-width window.
  throughput: Readonly<{ merged: number; per24h: number | null }>
  // Oldest OPEN queue age at snapshot time — a live-queue fact the caller
  // supplies (it is not derivable from terminal facts). null when nothing is
  // queued. Folded in so the aggregate is one self-contained JSON key.
  oldestOpenMs: number | null
  activeRun: Readonly<{
    allTerminal: DurationDistribution
    integratedOnly: DurationDistribution
    alreadyLandedOnly: DurationDistribution
    // Active duration of every unsuccessful terminal Run.
    // Retained JSON aggregate excluding both successful terminal outcomes.
    failedOnly: DurationDistribution
  }>
  queueWait: QueueWaitDistribution
}>

export type QueueLogResult = QueueSummary & { prs?: readonly Change[] }

export type QueueLogAttempt = Readonly<{
  job: string
  run: string
  step: string
  index: number
  attempt: number
  runner: string
  outcome: "passed" | "failed" | "lost"
  startedAt: string
  finishedAt: string
  durationMs: number
}>

type QueueAttemptResult =
  | Readonly<{ status: "passed"; output: JsonValue }>
  | Readonly<{ status: "failed"; error: JobError; output?: JsonValue }>
  // A "lose" transition (Jobs.recover(), the habitant-runner-restart/dead-
  // lease reclaim path) closes an attempt the runner never got to interpret.
  // `code` is always "job-lost" — the SAME registered YRD_REFUSAL_CODES
  // member `terminalJobError` (queue.ts) already derives from a Job's own
  // `conclusion: "timed_out"` — so this completed-but-uninterpreted attempt
  // is never a bare, unclassifiable `lost` outcome
  // (@i/10-yrd/every-attempt-records-a-verdict).
  | Readonly<{ status: "lost"; reason: string; code: "job-lost" }>

export type QueueAttempt = QueueLogAttempt &
  Readonly<{
    requestedAt: string
    revision: string
    result: QueueAttemptResult
  }>

type RequestedJob = Readonly<{ run: string; step: string; index: number; requestedAt: string; revision: string }>

type StartedAttempt = Readonly<{ attempt: number; runner: string; startedAt: string }>

type PinnedChangeRevision = Readonly<{ id: string; revision: number; headSha: string; intent?: unknown }>

export function queueRevisionKey(revision: PinnedChangeRevision): string {
  return JSON.stringify([revision.id, revision.revision, revision.headSha])
}

export function queueRunRevisionKey(run: Pick<Run, "id">, revision: PinnedChangeRevision): string {
  return JSON.stringify([run.id, revision.id, revision.revision, revision.headSha])
}

/** What one whole-population clock read produced: the clocks it could build,
 * and one {@link QueueMemberReadFault} per member it could not. The faults are
 * keyed the same way the clocks are, so a renderer holding both can mark
 * exactly the rows that are unreadable. */
export type QueueRunRevisionReads = Readonly<{
  clocks: Map<string, ChangeRunRevisionClock>
  faults: Map<string, QueueMemberReadFault>
}>

/**
 * Build every run member's causal admission clock, collecting — never
 * throwing — the members whose clock the record store cannot answer for.
 *
 * This is a whole-population read: one member whose revision was never
 * journaled used to abort `yrd log` for every caller, including the caller who
 * asked for five rows that did not include it (@i/10-yrd/23228). The unreadable
 * member is REPORTED through `faults` and rendered marked; it is never
 * silently dropped, which would trade a loud failure for a quiet one.
 */
export function queueRunRevisionReads(prs: Iterable<Change>, runs: Iterable<Run>): QueueRunRevisionReads {
  const byId = new Map([...prs].map((pr) => [pr.id, pr]))
  const recordIds = new Set(byId.keys())
  const clocks = new Map<string, ChangeRunRevisionClock>()
  const faults = new Map<string, QueueMemberReadFault>()
  for (const run of runs) {
    for (const revision of run.prs) {
      const pr = byId.get(revision.id)
      if (pr === undefined) {
        // A carrier-free pin intent's member id is an intent id: the snapshot
        // is the whole record and no revision clock exists. A derived member
        // (S6: minted above the frozen store's frontier) is recordless BY
        // DESIGN and has no record clock either. A recordless member at or
        // below the frontier is journal corruption and stays loud.
        if (revision.intent !== undefined) continue
        if (isDerivedMemberId(revision.id, recordIds)) continue
        throw new Error(`yrd: run '${run.id}' has no retained change '${revision.id}'`)
      }
      const read = runRevisionClockRead(pr, run)
      const key = queueRunRevisionKey(run, revision)
      if (read.fault !== undefined) faults.set(key, read.fault)
      else clocks.set(key, read.clock)
    }
  }
  return { clocks, faults }
}

/** The clock half of {@link queueRunRevisionReads}, for callers that hold no
 * surface to report a fault on. */
export function queueRunRevisionClocks(
  prs: Iterable<Change>,
  runs: Iterable<Run>,
): Map<string, ChangeRunRevisionClock> {
  return queueRunRevisionReads(prs, runs).clocks
}

/** Compatibility projector for injected/custom runtimes without the installed
 * Queue read-model service. Production CLI hosts query the transactionally
 * maintained SQLite view; this pure fold remains the parity oracle and the
 * explicit fallback for Journals that cannot contribute views. */
export async function queueLogAttempts(events: AsyncIterable<Event> | Iterable<Event>): Promise<QueueAttempt[]> {
  return stageAsync("history-scan", () => scanQueueLogAttempts(events))
}

async function scanQueueLogAttempts(events: AsyncIterable<Event> | Iterable<Event>): Promise<QueueAttempt[]> {
  const requested = new Map<string, RequestedJob>()
  const started = new Map<string, StartedAttempt>()
  const attempts: QueueAttempt[] = []

  for await (const event of events) {
    if (event.name === "job/requested") {
      const request = JobRequestSchema.parse(event.data)
      const input = request.input
      if (
        typeof input === "object" &&
        input !== null &&
        "run" in input &&
        typeof input.run === "string" &&
        "step" in input &&
        typeof input.step === "string" &&
        "index" in input &&
        typeof input.index === "number"
      ) {
        requested.set(event.id, {
          run: input.run,
          step: input.step,
          index: input.index,
          requestedAt: event.ts,
          revision: request.revision,
        })
      }
      continue
    }

    if (event.name !== "job/transitioned") continue
    const transition = JobTransitionSchema.parse(event.data)
    if (transition.type === "start") {
      started.set(`${transition.id}:${transition.attempt}`, {
        attempt: transition.attempt,
        runner: transition.runner,
        startedAt: event.ts,
      })
      continue
    }
    if (transition.type !== "finish" && transition.type !== "lose") continue

    const request = requested.get(transition.id)
    const start = started.get(`${transition.id}:${transition.attempt}`)
    if (request === undefined || start === undefined) continue
    const durationMs = elapsedMs(start.startedAt, event.ts, `queue attempt '${transition.id}:${transition.attempt}'`)
    if (durationMs === undefined) {
      throw new Error(`yrd: queue attempt '${transition.id}:${transition.attempt}' has invalid time`)
    }
    attempts.push({
      job: transition.id,
      ...request,
      attempt: transition.attempt,
      runner: start.runner,
      outcome: transition.type === "lose" ? "lost" : transition.result.conclusion === "success" ? "passed" : "failed",
      startedAt: start.startedAt,
      finishedAt: event.ts,
      durationMs,
      result:
        transition.type === "lose"
          ? { status: "lost", reason: transition.reason, code: "job-lost" }
          : transition.result.conclusion === "success"
            ? { status: "passed", output: transition.result.output }
            : {
                status: "failed",
                error: transition.result.error,
                ...(transition.result.output === undefined ? {} : { output: transition.result.output }),
              },
    })
  }

  return attempts
}

export type GateEvidence = Readonly<{
  mode: "delta" | "strict"
  residualCount: number
}>

/** Perfect-detector merge class for scripts (21801 / 22323). */
export type MergeVerdict = "landed" | "already-landed" | "non-landing" | "failed" | "running" | "canceled"

export type ChangeRevisionHistoryClock = Readonly<{
  pr: string
  revision: number
  headSha: string
  /**
   * A terminal fact this revision still carries that belongs to a PREVIOUS
   * admission of the same sha — moved off `terminal` by
   * {@link currentAdmissionFinish} so no age is measured to it, and kept here
   * so nothing is silently discarded and a row can say why it reads pending.
   */
  supersededTerminal?: ChangeRevTerminal
}> &
  ChangeRevClock

/**
 * Re-exported, never redefined. The rule lives in the shared model
 * (`@yrd/bay`) because {@link changeDeliveryState} — what the QUEUE ADMITS —
 * and these read projections must never disagree about which admission a clock
 * belongs to. Live 2026-09-01 on 0.0.1+caacf98e21: change 'PR2749' resubmitted
 * at 18:40:25Z over an 08-30T22:56Z settle emptied `yrd pr list --json` for all
 * 2275 rows and killed `yrd watch` outright.
 */
export { currentAdmissionFinish }

export type ChangeRunRevisionClock =
  | (ChangeRevisionHistoryClock & Readonly<{ admittedBy: "submission"; submittedAt: string }>)
  | (ChangeRevisionHistoryClock & Readonly<{ admittedBy: "check-request"; checkRequestedAt: string }>)

type LegacyQueueCoverage = Readonly<{
  path: string
  frames: number
}>

export type QueueLogCoverage = Readonly<{
  since: string
  completeness: "queue-only"
  legacy: readonly LegacyQueueCoverage[]
}>

export type QueueLogLocation = Readonly<{ path: string }> | Readonly<{ url: string }>

export type QueueLogLocationEntry = Readonly<{ label: string; display?: string; location: QueueLogLocation }>

export function evidenceDisplay(label: string, location: QueueLogLocation): string {
  if (!("path" in location)) return label
  const normalized = location.path.replaceAll("\\", "/")
  const git = normalized.indexOf("/.git/")
  if (git >= 0) return normalized.slice(git + 1)
  return label
}

export function latest(...timestamps: (string | undefined)[]): string | undefined {
  return timestamps
    .filter((value): value is string => value !== undefined)
    .toSorted()
    .at(-1)
}

export function latestRunForCurrentRevision(pr: Change, summary: QueueSummary): Run | undefined {
  const revision = currentChangeRev(pr)
  const current = queueRevisionKey({ id: pr.id, revision: revision.n, headSha: revision.head })
  const delivery = changeDeliveryState(pr)
  const currentSubmission =
    delivery === "submitted" || delivery === "ready" ? (revision.submittedAt ?? pr.submittedAt) : undefined
  return [...summary.running, ...summary.waiting, ...summary.finished]
    .filter((run) => run.prs.some((member) => queueRevisionKey(member) === current))
    .filter(
      (run) =>
        currentSubmission === undefined ||
        timestamp(run.startedAt, `run '${run.id}' start`) >=
          timestamp(currentSubmission, `change '${pr.id}' current revision submit time`),
    )
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt))
    .at(-1)
}

export function latestCandidateForCurrentRevision(result: QueueStatusResult, pr: Change): Candidate | undefined {
  const revision = currentChangeRev(pr)
  return result.candidates
    ?.filter((candidate) =>
      candidate.revs.some((member) => member.pr === pr.id && member.n === revision.n && member.head === revision.head),
    )
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1)
}

export function eligibilityForCurrentRevision(result: QueueStatusResult, pr: Change): ChangeEligibility | undefined {
  const revision = changeRevisionNumber(pr)
  return result.eligibilities?.find((eligibility) => eligibility.pr === pr.id && eligibility.revision === revision)
}

/** The submitter handle recorded on one exact immutable PR revision, or
 * undefined for revisions journaled before submitter identity was recorded. */
export function revisionSubmitter(
  pr: Change,
  revision = changeRevisionNumber(pr),
  headSha = changeHead(pr),
): string | undefined {
  return pr.revs.find((candidate) => candidate.n === revision && candidate.head === headSha)?.submitter
}

function currentTerminalFact(pr: Change): ChangeRevTerminal | undefined {
  const delivery = changeDeliveryState(pr)
  let at: string | undefined
  switch (delivery) {
    case "rejected":
      at = pr.rejectedAt
      break
    case "integrated":
      at = pr.integratedAt
      break
    case "already-landed":
      at = pr.alreadyLandedAt
      break
    case "withdrawn":
      at = pr.withdrawnAt
      break
    case "canceled":
      at = pr.canceledAt
      break
    default:
      return undefined
  }
  if (at === undefined) {
    throw new Error(
      `yrd: change '${pr.id}' current revision ${changeRevisionNumber(pr)}@${changeHead(pr)} has no ${delivery} timestamp`,
    )
  }
  return { kind: delivery, at }
}

export const FLOW_DAY_MS = 24 * 60 * 60_000

function validateRevisionClock(pr: Change, clock: ChangeRevisionHistoryClock): ChangeRevisionHistoryClock {
  const pushed = Date.parse(clock.pushedAt)
  if (!Number.isFinite(pushed)) {
    throw new Error(
      `yrd: change '${pr.id}' revision ${clock.revision}@${clock.headSha} has an invalid pushed clock '${clock.pushedAt}'`,
    )
  }
  if (clock.submittedAt !== undefined) {
    const submitted = elapsedMs(
      clock.pushedAt,
      clock.submittedAt,
      `change '${pr.id}' revision ${clock.revision}@${clock.headSha} pushed-to-submitted age`,
    )
    if (submitted === undefined) {
      throw new Error(
        `yrd: change '${pr.id}' revision ${clock.revision}@${clock.headSha} has an invalid submitted clock '${clock.submittedAt}'`,
      )
    }
  }
  // SCOPE BEFORE MEASURING. A terminal fact recorded before this revision's own
  // submit fact belongs to a previous admission of the same sha — a legal state
  // a re-submission produces, not a corrupt clock. `currentAdmissionFinish`
  // names it; the fact is re-homed onto `supersededTerminal` so the revision
  // reads PENDING everywhere an age is measured, and nothing is discarded.
  // Before this, the pair below was measured anyway and threw, and one such row
  // emptied `yrd pr list --json` for all 2275 rows.
  const superseded =
    clock.terminal !== undefined &&
    currentAdmissionFinish(clock.submittedAt ?? clock.pushedAt, clock.terminal.at) === undefined
      ? clock.terminal
      : undefined
  const scoped: ChangeRevisionHistoryClock = superseded === undefined ? clock : withSupersededTerminal(clock)
  if (scoped.terminal !== undefined) {
    const terminal = elapsedMs(
      scoped.submittedAt ?? scoped.pushedAt,
      scoped.terminal.at,
      `change '${pr.id}' revision ${scoped.revision}@${scoped.headSha} submitted-to-terminal age`,
    )
    if (terminal === undefined) {
      throw new Error(
        `yrd: change '${pr.id}' revision ${scoped.revision}@${scoped.headSha} has an invalid terminal clock '${scoped.terminal.at}'`,
      )
    }
  }

  if (scoped.revision !== changeRevisionNumber(pr) || scoped.headSha !== changeHead(pr)) return scoped
  const expected = currentTerminalFact(pr)
  if (expected === undefined) {
    // A superseded terminal on the CURRENT revision is precisely the
    // resubmitted-with-stale-results shape: the change is back in `submitted`,
    // so no terminal fact is expected, and the one still on the revision is the
    // previous admission's. That is the state this refusal was misreading —
    // its own wording already called the clock "stale". A terminal that is NOT
    // superseded still contradicts the record and stays loud.
    if (scoped.terminal !== undefined) {
      throw new Error(
        `yrd: change '${pr.id}' current revision ${scoped.revision}@${scoped.headSha} retains stale ${scoped.terminal.kind} terminal clock`,
      )
    }
    return scoped
  }
  if (scoped.terminal === undefined) {
    throw new Error(
      `yrd: change '${pr.id}' current revision ${scoped.revision}@${scoped.headSha} has no ${expected.kind} terminal clock`,
    )
  }
  if (scoped.terminal.kind !== expected.kind || scoped.terminal.at !== expected.at) {
    throw new Error(
      `yrd: change '${pr.id}' current revision ${scoped.revision}@${scoped.headSha} ${expected.kind} terminal clock contradicts current PR state`,
    )
  }
  return scoped
}

/** Move a superseded terminal fact off `terminal`, where ages are measured, and
 * onto `supersededTerminal`, where a reader can still see it and say why the
 * revision reads pending. Nothing is dropped. */
function withSupersededTerminal(clock: ChangeRevisionHistoryClock): ChangeRevisionHistoryClock {
  const { terminal, ...rest } = clock
  return terminal === undefined ? clock : { ...rest, supersededTerminal: terminal }
}

function revisionHistoryClock(pr: Change, revision: Change["revs"][number]): ChangeRevisionHistoryClock {
  return {
    pr: pr.id,
    revision: revision.n,
    headSha: revision.head,
    pushedAt: revision.pushedAt,
    ...(revision.submittedAt === undefined ? {} : { submittedAt: revision.submittedAt }),
    ...(revision.terminal === undefined ? {} : { terminal: revision.terminal }),
  }
}

export function changeRevisionClocks(pr: Change): readonly ChangeRevisionHistoryClock[] {
  const clocks = pr.revs.map((revision) => validateRevisionClock(pr, revisionHistoryClock(pr, revision)))
  if (!clocks.some((clock) => clock.revision === changeRevisionNumber(pr) && clock.headSha === changeHead(pr))) {
    throw new Error(
      `yrd: change '${pr.id}' has no clock for current revision ${changeRevisionNumber(pr)}@${changeHead(pr)}`,
    )
  }
  return clocks
}

export function revisionCheckRequests(
  pr: Change,
  clock: ChangeRevisionHistoryClock,
): readonly Change["checkRequests"][number][] {
  return pr.checkRequests
    .filter((request) => request.revision === clock.revision && request.headSha === clock.headSha)
    .map((request) => {
      const elapsed = elapsedMs(
        clock.pushedAt,
        request.at,
        `change '${pr.id}' revision ${clock.revision}@${clock.headSha} pushed-to-check-request age`,
      )
      if (elapsed === undefined) {
        throw new Error(
          `yrd: change '${pr.id}' revision ${clock.revision}@${clock.headSha} has an invalid check-request clock '${request.at}'`,
        )
      }
      return request
    })
}

export function timestamp(value: string, subject: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`yrd: ${subject} has invalid timestamp '${value}'`)
  return parsed
}

/**
 * One run member a read surface could not resolve against the retained record
 * store: the run pins a change revision the record does not carry the clock
 * for, because the write that would have carried it never reached the journal.
 *
 * It is a defect in ONE row. A READ answers a question about a population, so
 * it renders every member it can and marks the ones it cannot — aborting the
 * whole surface teaches the caller nothing about the 40 rows that were fine
 * (@i/10-yrd/23228). Writers and gates keep the throwing
 * {@link runRevisionClock}; only readers take the fault.
 *
 * `reason` separates the two shapes an unjournaled write leaves behind, and
 * both are distinguishable from a change that WAS journaled and later evicted:
 * retention reports that as the `history-evicted` refusal and the log's
 * coverage floor, never as a fault here.
 */
export type QueueMemberReadFault = Readonly<{
  run: string
  change: string
  revision: number
  headSha: string
  /** `revision-not-retained`: the record holds no clock for the pinned
   * revision@sha at all. `no-causal-clock`: the revision is retained, but
   * neither a submission nor a check request was journaled at or before the
   * run started, so nothing dates the member's admission. */
  reason: "revision-not-retained" | "no-causal-clock"
  message: string
}>

/**
 * One line naming what a read could not answer for — the count, then each
 * member by run, change, revision@sha and reason.
 *
 * A read surface that hides this is worse than the abort it replaced: the
 * caller would believe the population was whole. So the summary renders even
 * where display niceties are suppressed.
 */
export function queueMemberReadFaultSummary(faults: readonly QueueMemberReadFault[], limit = 3): string | undefined {
  if (faults.length === 0) return undefined
  const named = faults
    .slice(0, limit)
    .map(
      (fault) => `${fault.change} rev${fault.revision}@${fault.headSha.slice(0, 12)} in ${fault.run} (${fault.reason})`,
    )
  const rest = faults.length - named.length
  const row = faults.length === 1 ? "row" : "rows"
  return `${faults.length} unreadable ${row}: ${named.join("; ")}${rest === 0 ? "" : `; +${rest} more`}`
}

export type QueueMemberRead =
  | Readonly<{ clock: ChangeRunRevisionClock; fault?: undefined }>
  | Readonly<{ clock?: undefined; fault: QueueMemberReadFault }>

/** The shared core of {@link runRevisionClock}: resolve a run member's causal
 * admission clock, handing back the fault instead of throwing it so a read
 * surface can mark the row and continue. */
export function runRevisionClockRead(pr: Change, run: Run): QueueMemberRead {
  const pinned = run.prs.find((member) => member.id === pr.id)
  // Not a data fault but a caller-contract violation — asking a run for the
  // clock of a change it does not carry. Nothing in the read path can reach
  // it, so it stays loud on both paths.
  if (pinned === undefined) throw new Error(`yrd: run '${run.id}' does not contain change '${pr.id}'`)
  const fault = (
    reason: QueueMemberReadFault["reason"],
    message: string,
  ): Readonly<{ fault: QueueMemberReadFault }> => ({
    fault: { run: run.id, change: pr.id, revision: pinned.revision, headSha: pinned.headSha, reason, message },
  })
  const revision = pr.revs.find((revision) => revision.n === pinned.revision && revision.head === pinned.headSha)
  if (revision === undefined) {
    return fault(
      "revision-not-retained",
      `yrd: run '${run.id}' has no retained revision clock for change '${pr.id}' revision ${pinned.revision}@${pinned.headSha} — the change record retains no such revision, so the write was never journaled`,
    )
  }
  const historyClock = revisionHistoryClock(pr, revision)
  const startedAt = timestamp(run.startedAt, `run '${run.id}' start`)
  if (
    revision.submittedAt !== undefined &&
    timestamp(revision.submittedAt, `change '${pr.id}' revision ${pinned.revision}@${pinned.headSha} submit time`) <=
      startedAt
  ) {
    const clock = validateRevisionClock(pr, historyClock)
    return { clock: { ...clock, admittedBy: "submission", submittedAt: revision.submittedAt } }
  }
  const checkRequest = revisionCheckRequests(pr, historyClock)
    .filter((request) => timestamp(request.at, `change '${pr.id}' check request`) <= startedAt)
    .toSorted((left, right) => left.at.localeCompare(right.at))
    .at(-1)
  if (checkRequest === undefined) {
    return fault(
      "no-causal-clock",
      `yrd: run '${run.id}' has no causal submit/check-request clock for change '${pr.id}' revision ${pinned.revision}@${pinned.headSha} — no submission or check request was journaled at or before the run started`,
    )
  }
  const clock = validateRevisionClock(pr, historyClock)
  return { clock: { ...clock, admittedBy: "check-request", checkRequestedAt: checkRequest.at } }
}

/** The throwing projection of {@link runRevisionClockRead}, for every caller
 * that is NOT a read surface — a missing clock there is a real refusal. */
export function runRevisionClock(pr: Change, run: Run): ChangeRunRevisionClock {
  const read = runRevisionClockRead(pr, run)
  if (read.fault !== undefined) throw new Error(read.fault.message)
  return read.clock
}

type JobDisplayStatus =
  | "queued"
  | "requested"
  | "running"
  | "waiting"
  | "passed"
  | "failed"
  | "lost"
  | "canceled"
  | "skipped"

function jobDisplayStatus(job: Job | undefined): JobDisplayStatus {
  if (job === undefined) return "queued"
  if (job.status === "queued") return "requested"
  if (job.status === "in_progress") return "running"
  if (job.status === "waiting") return "waiting"
  if (job.conclusion === "success") return "passed"
  if (job.conclusion === "failure") return "failed"
  if (job.conclusion === "timed_out") return "lost"
  if (job.conclusion === "cancelled") return "canceled"
  return "skipped"
}

export function jobStatus(step: QueueStep): JobDisplayStatus {
  return jobDisplayStatus(step.job)
}

export function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function safeText(value: unknown): string {
  if (value === undefined) return "-"
  if (value === "") return "-"
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

export function singleQueue(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim()
  return normalized === "" ? "-" : normalized
}

export function boundedQueue(value: string, limit = 120): string {
  const normalized = singleQueue(value)
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

export function toIso(timestamp: string | undefined): string {
  if (timestamp === undefined) return "-"
  const when = new Date(timestamp)
  return Number.isNaN(when.getTime()) ? "-" : when.toISOString()
}

export function elapsedMs(
  started: string | undefined,
  finished: string | undefined,
  subject = "duration",
): number | undefined {
  if (started === undefined || finished === undefined) return undefined
  const start = Date.parse(started)
  const end = Date.parse(finished)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  if (end < start) throw new Error(`yrd: ${subject} finish '${finished}' precedes start '${started}'`)
  return end - start
}

export function preciseDuration(milliseconds: number, compact = false): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  if (hours > 0) {
    if (compact) return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`
    return `${hours}h${String(minutes).padStart(2, "0")}m${String(remainder).padStart(2, "0")}s`
  }
  if (minutes > 0) return `${minutes}m${compact ? remainder : String(remainder).padStart(2, "0")}s`
  return `${remainder}s`
}

export function mediaDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = String(seconds % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`
}

export function relativeAge(milliseconds: number): string {
  if (milliseconds >= 3_600_000) return `${Math.round(milliseconds / 3_600_000)}h`
  return preciseDuration(milliseconds, true)
}

export function queueLogLevel(outcome: string): "DEBUG" | "ERROR" | "INFO" | "WARN" {
  if (["integrated", "submitted"].includes(outcome)) return "INFO"
  if (["rejected", "paused", "resumed", "environment-refused", "stale", "legacy", "refused"].includes(outcome)) {
    return "WARN"
  }
  if (["failed", "lost"].includes(outcome)) return "ERROR"
  if (["passed", "canceled", "retired"].includes(outcome)) return "DEBUG"
  // An unclassified failure code is deliberately loud instead of silently
  // inheriting a neutral level. Its raw code remains the rendered outcome.
  return "ERROR"
}

export function parseRunIdSuffix(run: string): number {
  const match = /^R(\d+)$/u.exec(run)
  if (match === null) return Number.MAX_SAFE_INTEGER
  const suffix = match[1]
  return suffix === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(suffix, 10)
}

export function byRunStarted(left: Run, right: Run): number {
  const leftAt = Date.parse(left.startedAt)
  const rightAt = Date.parse(right.startedAt)
  if (leftAt !== rightAt) return leftAt - rightAt
  return parseRunIdSuffix(left.id) - parseRunIdSuffix(right.id)
}

export function attemptArtifacts(attempt: QueueAttempt): readonly unknown[] {
  if (attempt.result.status === "lost" || !isObjectValue(attempt.result.output)) return []
  return Array.isArray(attempt.result.output.artifacts) ? attempt.result.output.artifacts : []
}

export function jobCheckpoint(job: Job | undefined): unknown {
  if (job === undefined) return undefined
  if (
    job.status === "waiting" ||
    (job.status === "completed" && (job.conclusion === "success" || job.conclusion === "failure"))
  ) {
    return job.checkpoint
  }
  return undefined
}

export function relevantStep(run: Run | undefined): QueueStep | undefined {
  if (run === undefined) return undefined
  const latestFirst = run.steps.toReversed()
  return (
    latestFirst.find((step) => jobStatus(step) === "failed") ??
    latestFirst.find((step) => ["requested", "running", "waiting", "lost"].includes(jobStatus(step))) ??
    latestFirst.find((step) => jobStatus(step) !== "queued")
  )
}

export function runOutputQueueageIndex(finished: readonly Run[], run: Run, revision: number, prId: string): number {
  const related = finished
    .filter((candidate) => candidate.prs.some((pr) => pr.id === prId && pr.revision === revision))
    .toSorted(byRunStarted)
  return related.findIndex((candidate) => candidate.id === run.id) + 1
}

export function stepOutput(step: QueueStep): string {
  const job = step.job
  if (job === undefined) return "-"
  if (job.status === "completed" && job.conclusion === "failure") return safeText(job.output ?? job.error)
  if (job.status === "completed" && job.conclusion === "success") return safeText(job.output)
  if (job.status === "waiting" || job.status === "in_progress") {
    const detail = job.status === "waiting" && typeof job.detail === "string" ? job.detail : undefined
    return detail === undefined ? "waiting" : detail
  }
  return "-"
}

/** Diagnostic classification of a journal outcome for display/JSON (21801).
 * DESCRIBES the recorded outcome; does NOT adjudicate success. Exit code of the
 * merge step remains the sole success channel (CTO 2026-07-25: one test for
 * success). Maps: integrated/already-landed → landed*; passed without
 * integration proof → non-landing; duration is secondary and never drives this. */
export function mergeVerdictOfOutcome(outcome: string): MergeVerdict {
  if (outcome === "integrated") return "landed"
  if (outcome === "already-landed") return "already-landed"
  if (outcome === "passed") return "non-landing"
  if (outcome === "running" || outcome === "waiting") return "running"
  if (outcome === "canceled" || outcome === "retired") return "canceled"
  return "failed"
}

export function stepNamesOfRun(run: Run): readonly string[] {
  return run.steps.map((step) => step.name)
}

export function queueIntegration(run: Run): IntegrationProof | undefined {
  return run.integration ?? ("integration" in run.shape ? run.shape.integration : undefined)
}

export function queueMerge(run: Run): string {
  const proof = queueIntegration(run)
  if (proof === undefined) return "-"
  return `${proof.commit.slice(0, 12)}@${proof.baseSha.slice(0, 12)}`
}

export function queueOutcomeIntegration(run: Run): IntegrationProof {
  const proof = queueIntegration(run)
  if (proof === undefined) throw new Error(`yrd: passed run '${run.id}' is missing integration proof`)
  return proof
}

export function isolationPartLabel(run: Run): "0" | "1" | "-" {
  return run.isolationPart === undefined ? "-" : run.isolationPart === 0 ? "0" : "1"
}

export function queueShowRetries(finished: readonly Run[], run: Run): number {
  if (run.prs.length === 0) return 0
  const first = run.prs[0]
  if (first === undefined) return 0
  return runOutputQueueageIndex(finished, run, first.revision, first.id)
}

export function stepError(step: QueueStep): string {
  const job = step.job
  if (job === undefined) return "-"
  if (job.status === "completed" && job.conclusion === "failure") return job.error.message
  return "-"
}

export function stepErrorCode(step: QueueStep): string {
  const job = step.job
  return job?.status === "completed" && job.conclusion === "failure" ? job.error.code : "-"
}

export function stepLost(step: QueueStep): string {
  const job = step.job
  if (job?.status !== "completed" || job.conclusion !== "timed_out") return "-"
  return job.lostReason
}

export function stepDetail(step: QueueStep): string {
  const job = step.job
  if (job === undefined) return "-"
  const outputDetail =
    job.status === "completed" &&
    (job.conclusion === "success" || job.conclusion === "failure") &&
    isObjectValue(job.output)
      ? job.output.detail
      : undefined
  if (typeof outputDetail === "string" && outputDetail !== "") return outputDetail
  const detail =
    job.status === "waiting" ||
    (job.status === "completed" && (job.conclusion === "success" || job.conclusion === "failure"))
      ? "detail" in job
        ? job.detail
        : undefined
      : undefined
  if (typeof detail === "string" && detail !== "") return detail
  if (job.status === "completed" && job.conclusion === "failure") return job.error.message
  return "-"
}

function commandText(command: unknown): string | undefined {
  if (typeof command === "string") return presentFact(command)
  if (Array.isArray(command) && command.every((part): part is string => typeof part === "string")) {
    if (command.length === 3 && command[0] === "sh" && command[1] === "-c") return presentFact(command[2])
    return presentFact(command.join(" "))
  }
  return undefined
}

export function stepCommand(step: QueueStep): string | undefined {
  const output = step.job !== undefined && "output" in step.job ? step.job.output : undefined
  const recorded = isObjectValue(output) ? commandText(output.command) : undefined
  if (recorded !== undefined) return recorded
  const input = step.job?.input
  return isObjectValue(input) ? commandText(input.command) : undefined
}

export function stepCheckpointText(step: QueueStep): string {
  const checkpoint = jobCheckpoint(step.job)
  if (!isObjectValue(checkpoint)) return "-"
  const value = [] as string[]
  if (typeof checkpoint.baseSha === "string") value.push(`base:${checkpoint.baseSha.slice(0, 12)}`)
  if (typeof checkpoint.candidateSha === "string") value.push(`candidate:${checkpoint.candidateSha.slice(0, 12)}`)
  return value.length === 0 ? safeText(checkpoint) : value.join(" ")
}

export function gateEvidenceFromOutput(output: unknown): GateEvidence | undefined {
  if (!isObjectValue(output)) return undefined
  const parsed = GateCertificateSchema.safeParse(output.certificate)
  if (!parsed.success) return undefined
  const certificate = parsed.data
  return {
    mode: certificate.mode,
    residualCount: certificate.reports.reduce((total, report) => total + report.residual.count, 0),
  }
}

export function gateEvidenceLabel(gate: GateEvidence): string {
  return `${gate.mode} residual:${gate.residualCount}`
}

export function stepEvidence(step: QueueStep, gate: GateEvidence | undefined): string | Record<string, unknown> {
  const job = step.job
  if (job === undefined) return "-"
  const evidence: Record<string, unknown> = {}

  if ("token" in job && typeof job.token === "string" && job.token !== "") evidence.token = job.token
  if ("url" in job && typeof job.url === "string" && job.url !== "") evidence.url = job.url
  if ("detail" in job && typeof job.detail === "string" && job.detail !== "") evidence.detail = job.detail
  if ("artifacts" in job && Array.isArray(job.artifacts) && job.artifacts.length > 0) evidence.artifacts = job.artifacts
  if ("checkpoint" in job && job.checkpoint !== undefined) evidence.checkpoint = job.checkpoint
  if (gate !== undefined) evidence.gate = gateEvidenceLabel(gate)
  return Object.keys(evidence).length === 0 ? "-" : evidence
}

/** An OSC 8 target for an issue reference. Path-form ids use km's canonical
 * internal URI shape; URLs and filesystem paths retain their native targets. */
export function issueHref(issue: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(issue)) return issue
  if (/^(?:\/|\.\.?\/)/u.test(issue)) return pathToFileURL(resolve(issue)).href
  if (/^@[^/\s]+(?:\/[^/\s]+)+$/u.test(issue)) return `km:${issue}`
  return undefined
}

export const QUEUE_ROW_LIMIT = 5

export const RECENT_ROW_LIMIT = 3

export function failureFact(
  run: Run | undefined,
  step: QueueStep | undefined,
): { code: string; message: string } | undefined {
  const job = step?.job
  if (job?.status === "completed" && job.conclusion === "failure") {
    return { code: job.error.code, message: job.error.message }
  }
  if (job?.status === "completed" && job.conclusion === "timed_out") {
    return { code: "job-lost", message: job.lostReason }
  }
  return run?.error
}

export const STALE_CODES = new Set(["stale-pr", "stale-check", "stale-base"])

// `check-failed` is the queue's generic decision wrapper, not a specific
// failure taxonomy. Preserve its established `rejected` display; every
// unrecognized/specific code remains lossless at the display boundary below.
export const GENERIC_REJECTION_CODES = new Set(["check-failed"])

export const CANCELED_CODES = new Set([
  "canceled",
  "cancelled",
  "queue-canceled",
  "queue-cancelled",
  "run-canceled",
  "run-cancelled",
])

export const TIMELINE_STATUS_ORDER: readonly QueueTimelineStatusFilter[] = [
  "pending",
  "running",
  "rejected",
  "integrated",
  "other",
]

/**
 * The default timeline window is unbounded — show everything, no `since=`
 * filter, unless the operator passes `--since` (user directive 2026-07-16).
 * 100 years dwarfs any real queue history while keeping `now - window` inside
 * the valid `Date` range (unlike `MAX_SAFE_INTEGER`, which overflows it). The
 * FILTER row hides `since=` and coverage reads complete at this window.
 */
export const QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS = 100 * 365 * 24 * 60 * 60 * 1_000

export function parsedTimelineTimestamp(timestamp: string | undefined, subject: string): number | null {
  if (timestamp === undefined) return null
  const value = Date.parse(timestamp)
  if (!Number.isFinite(value)) throw new TypeError(`yrd: ${subject} has invalid timestamp '${timestamp}'`)
  return value
}

export function timelineAge(timestamp: string | undefined, nowIso: string, subject: string): number | null {
  return elapsedMs(timestamp, nowIso, subject) ?? null
}

export function timelineMemberSubject(
  result: QueueStatusResult,
  member: Run["prs"][number],
  state: BaysState | undefined,
): string {
  const current = result.prs.find((candidate) => candidate.id === member.id)
  const isCurrent =
    current !== undefined && changeRevisionNumber(current) === member.revision && changeHead(current) === member.headSha
  const bayPath = isCurrent && current?.bay !== undefined ? state?.byId[current.bay]?.path : undefined
  return boundedQueue(
    bayPath ??
      (isCurrent ? (current?.title ?? current?.name) : undefined) ??
      member.name ??
      current?.title ??
      current?.branch ??
      member.branch,
    80,
  )
}

export function timelineRevisionLineage(pr: Change, revision = changeRevisionNumber(pr)): QueueTimelineRevisionLineage {
  const retained = pr.revs.some((candidate) => candidate.n === revision)
  if (retained !== true) {
    return {
      pr: pr.id,
      revisions: [revision],
      ...(revision === changeRevisionNumber(pr) && pr.submittedAt !== undefined
        ? { sourceReadyAt: pr.submittedAt }
        : {}),
    }
  }
  const revisions = changeRevisionLineage(pr, revision)
  const registeredAt = revisions[0]?.pushedAt
  const sourceReadyAt = changeSourceReadyAt(pr, revision)
  return {
    pr: pr.id,
    revisions: revisions.map((candidate) => candidate.n),
    ...(registeredAt === undefined ? {} : { registeredAt }),
    ...(sourceReadyAt === undefined ? {} : { sourceReadyAt }),
  }
}

function timelineLineageLabel(lineages: readonly QueueTimelineRevisionLineage[]): string | undefined {
  const remerges = lineages.filter(({ revisions }) => revisions.length > 1)
  if (remerges.length === 0) return undefined
  return remerges
    .map(({ pr, revisions }) => {
      const path = revisions.map((revision) => `rev${revision}`).join("→")
      const currentRevision = revisions.at(-1) ?? 1
      return remerges.length === 1 ? path : `${formatQueueChangeId(pr, currentRevision)} ${path}`
    })
    .join(" · ")
}

export function withTimelineLineage(detail: string, lineages: readonly QueueTimelineRevisionLineage[]): string {
  const lineage = timelineLineageLabel(lineages)
  return lineage === undefined ? detail : `${detail} · ${lineage}`
}

// `timelineQueueWaits` lived here: one whole-run pass computing every member's
// queue wait, which threw on the FIRST member whose submission clock postdated
// the run's start and so could only ever fail all of them together. Its single
// caller (`timelineRunMemberRows`) already derives that member's `submittedAt`
// for the age anchor, so the wait is now derived beside the age, inside the
// same per-row guard — one clock read, and one member's bad arithmetic
// contained to one member's row.

/** What one whole-population admission read produced: the times it could date,
 * and one {@link QueueMemberReadFault} per member it could not. Faults are
 * keyed by {@link queueRunRevisionKey}, exactly like the times. */
export type QueueTimelineAdmissionReads = Readonly<{
  submissionTimes: Map<string, string | null>
  faults: Map<string, QueueMemberReadFault>
}>

/**
 * Date every run member's admission, collecting — never throwing — the members
 * the record store cannot date.
 *
 * Same whole-population rule as {@link queueRunRevisionReads}: one member whose
 * revision was never journaled used to abort `yrd queue status` and the whole
 * timeline for every caller (@i/10-yrd/23228). The member is reported through
 * `faults` and its row renders marked, never dropped.
 */
export function queueTimelineAdmissionReads(results: readonly QueueStatusResult[]): QueueTimelineAdmissionReads {
  const submissionTimes = new Map<string, string | null>()
  const faults = new Map<string, QueueMemberReadFault>()
  for (const result of results) {
    const byId = new Map(result.prs.map((pr) => [pr.id, pr]))
    const recordIds = new Set(byId.keys())
    for (const pr of result.prs) {
      for (const revision of pr.revs) {
        if (revision.submittedAt !== undefined) {
          submissionTimes.set(
            queueRevisionKey({ id: pr.id, revision: revision.n, headSha: revision.head }),
            revision.submittedAt,
          )
        }
      }
      // A record with no retained revision has no CURRENT revision to key a
      // time on — the same legal state the run-member branch below already
      // handles by reading `pr.submittedAt`. Nothing is swallowed here: if a
      // run pins one of this record's revisions, that member takes a
      // `revision-not-retained` fault and its row says so.
      const current = pr.revs.length === 0 ? undefined : currentChangeRev(pr)
      const submittedAt = current?.submittedAt ?? pr.submittedAt
      if (current !== undefined && submittedAt !== undefined) {
        submissionTimes.set(queueRevisionKey({ id: pr.id, revision: current.n, headSha: current.head }), submittedAt)
      }
    }
    for (const run of [...result.running, ...result.waiting, ...result.finished]) {
      for (const member of run.prs) {
        const pr = byId.get(member.id)
        if (pr === undefined) {
          // Intent members have no submission: the run itself is the admission.
          // A derived member (S6) has no record to date a submission from either;
          // its admission clock is the run's, exactly like an intent's.
          if (member.intent !== undefined || isDerivedMemberId(member.id, recordIds)) {
            submissionTimes.set(queueRunRevisionKey(run, member), null)
            continue
          }
          throw new Error(`yrd: run '${run.id}' has no retained change '${member.id}'`)
        }
        const runKey = queueRunRevisionKey(run, member)
        if (pr.revs.length > 0) {
          const read = runRevisionClockRead(pr, run)
          if (read.fault !== undefined) {
            faults.set(runKey, read.fault)
            submissionTimes.set(runKey, null)
            continue
          }
          submissionTimes.set(runKey, read.clock.admittedBy === "submission" ? read.clock.submittedAt : null)
          continue
        }
        const submittedAt = pr.submittedAt
        submissionTimes.set(
          runKey,
          submittedAt !== undefined &&
            timestamp(submittedAt, `change '${pr.id}' submit time`) <= timestamp(run.startedAt, `run '${run.id}' start`)
            ? submittedAt
            : null,
        )
      }
    }
  }
  return { submissionTimes, faults }
}

/** The times half of {@link queueTimelineAdmissionReads}, for callers that hold
 * no surface to report a fault on. */
export function queueTimelineAdmissionTimes(results: readonly QueueStatusResult[]): Map<string, string | null> {
  return queueTimelineAdmissionReads(results).submissionTimes
}

/**
 * Fold projected rows into one terminal fact per completed Run. Member rows of
 * one batched Run collapse to a single fact that carries every visible member's
 * queue wait. Pass the window-filtered rows for the single-window `metrics`, or
 * the raw rows for the windowed time-stats fact set.
 */
export function failedAttemptsByRun(attempts: readonly QueueAttempt[]): ReadonlyMap<string, number> {
  const byRun = new Map<string, number>()
  for (const attempt of attempts) {
    if (attempt.outcome === "passed") continue
    byRun.set(attempt.run, (byRun.get(attempt.run) ?? 0) + 1)
  }
  return byRun
}

/** Group attempts by their Run once, so the projection can hand each Run only
 * its own attempts.
 *
 * Both hot loops of {@link queueTimelineProjection} — the row build and the
 * per-Run detail build — used to run `attempts.filter(a => a.run === run.id)`
 * for every Run, making the projection O(runs x attempts). On a real queue that
 * is 655 runs against 4356 attempts, ~2.9M comparisons per snapshot, and the
 * watch loop pays it once per 1s tick AND once per cursor movement. One pass
 * over the attempts makes the same work linear. */
export function queueAttemptsByRun(attempts: readonly QueueAttempt[]): ReadonlyMap<string, readonly QueueAttempt[]> {
  const byRun = new Map<string, QueueAttempt[]>()
  for (const attempt of attempts) {
    const existing = byRun.get(attempt.run)
    if (existing === undefined) byRun.set(attempt.run, [attempt])
    else existing.push(attempt)
  }
  return byRun
}

export const NO_ATTEMPTS: readonly QueueAttempt[] = Object.freeze([])

const NO_RUNS: readonly Run[] = Object.freeze([])

/** Index the Runs a detail row can name, keyed `base:id`.
 *
 * The detail build used to `allRuns.find(...)` per row — 677 rows against 655
 * Runs is ~443k comparisons per snapshot, on the same tick-and-keypress path as
 * the attempt scan. First-wins insertion preserves `find`'s exact semantics if a
 * base ever carries a duplicate Run id. */
export function queueRunsByKey(runs: readonly Run[]): ReadonlyMap<string, Run> {
  const byKey = new Map<string, Run>()
  for (const run of runs) {
    const key = `${run.base}:${run.id}`
    if (!byKey.has(key)) byKey.set(key, run)
  }
  return byKey
}

/** Group completed Runs by the change revision they carried, keyed `prId\0revision`.
 *
 * `queueShowData` uses the Run list it is handed for exactly one thing: the
 * retry ordinal, via `queueShowRetries` -> `runOutputQueueageIndex`, which keeps
 * only the completed Runs carrying this Run's first PR at the same revision.
 * Handing it that group directly is semantically identical — both of its filters
 * become no-ops over the already-matching set — and turns a per-detail-row scan
 * and sort of every finished Run into one pass. */
export function queueRetryPeers(finished: readonly Run[]): ReadonlyMap<string, readonly Run[]> {
  const byRevision = new Map<string, Run[]>()
  for (const run of finished) {
    if (run.status !== "completed") continue
    for (const member of run.prs) {
      const key = `${member.id}\0${String(member.revision)}`
      const peers = byRevision.get(key)
      if (peers === undefined) byRevision.set(key, [run])
      else peers.push(run)
    }
  }
  return byRevision
}

export function queueRetryPeersOf(peers: ReadonlyMap<string, readonly Run[]>, run: Run): readonly Run[] {
  const first = run.prs[0]
  if (first === undefined) return NO_RUNS
  return peers.get(`${first.id}\0${String(first.revision)}`) ?? NO_RUNS
}

export function requiredQueuePosition(positions: ReadonlyMap<string, number>, pr: string): number {
  const position = positions.get(pr)
  if (position === undefined) throw new Error(`yrd: submitted change '${pr}' is missing its queue position`)
  return position
}

export function queueRunSteps(run: Run): string {
  const selection = run.stepSelection
  const omitted = selection !== undefined && "omittedSteps" in selection ? selection.omittedSteps : undefined
  if (omitted === undefined) {
    const steps = run.steps.map((step) => `${step.name}=${jobStatus(step)}`).join(" ")
    const legacyChecks = selection !== undefined && "omittedChecks" in selection ? selection.omittedChecks : undefined
    return legacyChecks === undefined ? steps : `${steps} (configured checks omitted: ${legacyChecks.join(",")})`
  }

  const omittedByIndex = new Map(omitted.map((step) => [step.index, step] as const))
  let selectedIndex = 0
  return Array.from({ length: run.steps.length + omitted.length }, (_, index) => {
    const skipped = omittedByIndex.get(index)
    if (skipped !== undefined) return `${skipped.name}=${skipped.status}`
    const selected = run.steps[selectedIndex]
    if (selected === undefined) throw new Error(`yrd: Run '${run.id}' has invalid omitted-step positions`)
    selectedIndex += 1
    return `${selected.name}=${jobStatus(selected)}`
  }).join(" ")
}

/** The one place that decides how much of the change list an operator is shown.
 * `hidden` is not decoration: a listing that withheld rows must say so and say
 * how many, because an inventory that reads complete and is not is worse than
 * an error (22376). */
export type ChangeListWindow = Readonly<{ hidden: number; total: number }>

export type ChangeCheckViewRecord = ChangeCheckRecord

export function explicitArtifactHref(artifact: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(artifact) ? artifact : pathToFileURL(resolve(artifact)).href
}

export function checkDiagnosticText(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return singleQueue(safeText(value))
  const first = isObjectValue(value[0]) ? value[0] : undefined
  const location =
    typeof first?.file === "string" && typeof first[sourceRowKey] === "number"
      ? `${first.file}:${first[sourceRowKey]}${typeof first.column === "number" ? `:${first.column}` : ""}`
      : undefined
  const detail = typeof first?.message === "string" ? first.message : safeText(value[0])
  return singleQueue(
    `${location === undefined ? "" : `${location} `}${detail}${value.length > 1 ? ` (+${value.length - 1})` : ""}`,
  )
}

export function latestChangeRun(pr: Change, runs: readonly Run[]): Run | undefined {
  return runs
    .filter((run) => run.prs.some((member) => member.id === pr.id))
    .toSorted(byRunStarted)
    .at(-1)
}

/**
 * Collapse a run of rebuilds that changed nothing into the fact the run already
 * encodes (@i/10-merge-queue/a-counter-that-means-two-things).
 *
 * A re-merge whose source fingerprint is unchanged did no work. PR537 printed
 * `0d7566e4e3ae→0d7566e4e3ae` about forty times before changing once, and two
 * readers watched that carrier climb during an 89-minute stall and both called
 * it futile churn — while the revision named in the counter was merging. The
 * information needed to tell those apart was on screen the whole time. Forty
 * identical hashes are not a record a person can read.
 *
 * So this adds no field and drops no data. It states the run instead of
 * repeating its members, and it is self-limiting: a healthy carrier whose
 * content changes every re-merge has no run to collapse and renders as before
 * (PR645 and PR673, measured).
 */
export function collapseRecomposedSources(
  sources: readonly { repo: string; fromHeadSha: string; toHeadSha: string }[],
): string[] {
  const short = (sha: string): string => sha.slice(0, 12)
  const out: string[] = []
  let index = 0
  while (index < sources.length) {
    const entry = sources[index]
    if (entry === undefined) throw new Error(`yrd: recomposed source ${index} is missing`)
    if (entry.fromHeadSha !== entry.toHeadSha) {
      out.push(`${entry.repo} ${short(entry.fromHeadSha)}→${short(entry.toHeadSha)}`)
      index += 1
      continue
    }
    let run = 0
    while (index + run < sources.length) {
      const next = sources[index + run]
      if (next === undefined) throw new Error(`yrd: recomposed source ${index + run} is missing`)
      if (next.repo !== entry.repo || next.fromHeadSha !== entry.fromHeadSha || next.toHeadSha !== entry.fromHeadSha) {
        break
      }
      run += 1
    }
    const times = run === 1 ? "" : ` ×${run}`
    out.push(`${entry.repo} ${short(entry.fromHeadSha)}${times} unchanged`)
    index += run
  }
  return out
}

export function queueLogSubmissionTime(
  revisionClocks: ReadonlyMap<string, ChangeRunRevisionClock> | undefined,
  run: Run,
  pr: PinnedChangeRevision,
  recordIds: ReadonlySet<string>,
  readFaults?: ReadonlyMap<string, QueueMemberReadFault>,
): string | undefined {
  if (revisionClocks === undefined) return undefined
  const key = queueRunRevisionKey(run, pr)
  const clock = revisionClocks.get(key)
  if (clock === undefined) {
    // Intent members never mint a revision clock (no submission precedes the
    // run). Derived members (recordless post-S6) never mint one either: their
    // admission is the run-journaled git submit fact, not a record-lane
    // submission event, so queueRunRevisionClocks deliberately skips them and
    // this lookup misses. Records are never deleted post-S6, so a recordless
    // member IS derived — the same membership rule as isDerivedMemberId, never
    // a number frontier (PR2135 vs PR2131, 2026-08-27). Every RECORD change
    // member must still have a clock; that absence stays a loud failure.
    if (pr.intent !== undefined) return undefined
    if (isDerivedMemberId(pr.id, recordIds)) return undefined
    // The clock read already ACCOUNTED for this member and reported why it
    // could not date it. The row renders carrying that fault, so the absence
    // is loud on the surface rather than here — a caller that passes no fault
    // map has no such accounting and still refuses.
    if (readFaults?.has(key) === true) return undefined
    throw new Error(
      `yrd: run '${run.id}' has no causal submit/check-request clock for change '${pr.id}' revision ${pr.revision}@${pr.headSha}`,
    )
  }
  return clock.admittedBy === "submission" ? clock.submittedAt : undefined
}

// The queue content surface is left-flush (15e killed the dead left gutter)
// and capped at 160 cells on wide viewports.
export const TIMELINE_CONTENT_CAP = 160

// Fixed cells never clip arbitrarily; labels longer than this shorten at a
// semantic boundary via fitTimelineLabel.
export const TIMELINE_STATE_CAP = 20

/**
 * The branch glyph renders dim/subtle everywhere (user directive 2026-07-16,
 * W2) — a quiet decoration on the branch name, never competing with it. On a
 * cursor-selected row the glyph follows the selection foreground instead, so
 * the whole row reads as one selected unit.
 */
export const BRANCH_ICON_COLOR = "$fg-muted"

/**
 * Stable no-op passed as ListView `onItemHover` so hovering a queue row does
 * NOT move the cursor/selection (item P, 2026-07-16) — it overrides ListView's
 * default hover→cursor. Click still selects via the default onSelect path.
 */
export const NO_HOVER_SELECT = (): void => {}

export type TimelineCellLayout = Readonly<{
  timeWidth: number
  statusWidth: number
  runWidth: number
  /** 0 drops the BY column entirely — the first casualty on narrow tiers. */
  byWidth: number
  ageWidth: number
  runDurationWidth: number
  compact: boolean
  includeDate: boolean
}>

/**
 * The RUN cell under the label-primary naming model (items 34/36/38, killing
 * the digit-prefix `1:main#2173` form — digits are unstable filter
 * accelerators and never appear in names):
 *
 * - a run renders `label#N` plus its state glyph (`code#23423 ✓`); the label
 *   is the queue's config handle, base branch when none is declared, and it
 *   ELIDES when exactly one queue is visible (context supplies it) — never
 *   in the ALL view;
 * - batch members share one run: the id renders bright on the FIRST member
 *   row and the rest carry a muted `·` continuation (membership visible, no
 *   repetition noise);
 * - a pre-run row shows a muted em-dash, never blank.
 */
export type TimelineRunCellModel =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "continuation" }>
  | Readonly<{ kind: "run"; label: string; number: string }>

export function timelineRunCellText(model: TimelineRunCellModel): string {
  if (model.kind === "none") return "—"
  if (model.kind === "continuation") return "·"
  return `${model.label}${model.number}`
}

/** The label half elides only when exactly ONE queue is visible — context
 * supplies it; the ALL view always spells it (item 34). */
export function timelineShowQueueLabel(visibleQueueCount: number): boolean {
  return visibleQueueCount !== 1
}

/**
 * Generalized run presentation (operator ruling 2026-08-18, item 37m): the
 * data layer shapes runs around a KIND so a deployment run (rollout phases as
 * steps) or a future workflow run reuses the same status-box skeleton without
 * display-code changes. Today's journal only mints integration-queue runs;
 * the discriminant exists so the next kind is a data change, not a redesign.
 */
export type QueueRunPresentationKind = "integration" | "deployment" | "workflow"

// Preserve the leading semantic unit instead of clipping an arbitrary suffix.
export function fitTimelineLabel(label: string, max: number): string {
  if (label.length <= max) return label
  const boundary = Math.max(label.lastIndexOf("-", max), label.lastIndexOf(":", max))
  return boundary > 0 ? label.slice(0, boundary) : label.slice(0, max)
}

export type TimelineStatusCell = Readonly<{ word: string; color: string }>

export type TimelineStepCell = Readonly<{ text: string; color?: string }>

/** More room than the state cap: a reason message is a sentence fragment, and
 * the cell it renders in already truncates at the track edge. */
export const TIMELINE_WHY_CAP = 48

// The active-work glyph pulses only in the live pane; the one-shot projection has
// no app scope (and a static print cannot pulse), so it renders the same
// glyph statically — byte-identical plain output either way.
/**
 * Live-activity pulse cadence, matched to ag-code's activity indicator (item O,
 * user directive 2026-07-16). ag pulses a status color against `$fg-muted` on a
 * 1800 ms period; silvery's `Pulse` toggles once per `intervalMs`, so half the
 * period (900 ms) reproduces ag's blink. Every activity indicator uses silvery's
 * `synchronized` Pulse (items 12-13) so they share ONE app-scope phase clock —
 * the exact-match shared phase the earlier per-node timer only approximated.
 */
export const AG_PULSE_INTERVAL_MS = 900

/** The default "executing right now" pulse: blue against muted, shared phase. */
export const ACTIVITY_PULSE_COLORS: readonly [string, string] = ["$fg-info", "$fg-muted"]

/**
 * Freshness bound for a DIRECTLY-read runner status file (health probes,
 * retention observers). Those readers see the file at probe time with no
 * cache in between, so three missed 5s heartbeats is honest staleness.
 * The RUNNER box must NOT use this — see {@link RUNNER_VIEW_STALE_MS}.
 */
export const RUNNER_STALE_MS = 15_000

/**
 * How old the runner's observed facts may look on the WATCH VIEW before the
 * box calls them stale. The bound is set by how often those facts can REACH
 * the viewer, not by how often the runner produces them: the box judges
 * staleness on a LIVE clock (items 16/17) while the watch loader deliberately
 * coalesces heartbeat-only advances out of snapshot identity ("a heartbeat
 * alone must not rebuild durable queue facts"), so between progress-token
 * changes the cached `lastTickAt`/`observedAt` refresh only on the loader's
 * 60s clock pulse (`QUEUE_WATCH_CLOCK_INTERVAL_MS`). Judging the view with
 * the direct-read 15s bound put the threshold far below that ceiling, so a
 * perfectly healthy runner's on-screen age crossed it between refreshes and
 * the RUNNER box flapped healthy→stale→healthy on the observation cadence,
 * roughly every 10s (operator, 2026-08-25). 75s = the 60s pulse + the 5s
 * heartbeat + read-lag margin; runner-box-live-tick pins the inequality so
 * no constant can drift back under the ceiling.
 */
export const RUNNER_VIEW_STALE_MS = 75_000

/**
 * Adaptive runner clock (user directive 2026-07-21): `ss`, `m:ss`, or
 * `h:mm:ss` depending on magnitude — the RUNNER box always shows a timer.
 */
export function runnerClock(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`
  return `${seconds}s`
}

export type QueueHeadBlockDetails = Readonly<{
  pr: string
  subject: string
  position?: number
  queuedBehind?: number
  blockedMs: number
  retryCount?: number
  refusal: string
  resolution: readonly string[]
}>

/** The RUNNER liveness reflected by the leading marker. */
export type QueueHealthKind = "down" | "stalled" | "processing" | "idle"

export type QueueHealthMarker = Readonly<{
  kind: QueueHealthKind
  color: string
  pulse: readonly [string, string] | null
}>

// The runner health marker is the shell prompt itself (user directive
// 2026-07-21): a pulsing `$` leads the runner command instead of a disc.
export const QUEUE_HEALTH_GLYPH = "$"

export function runnerBoxTimer(marker: QueueHealthMarker, downMs: number | null, uptimeMs: number): string | undefined {
  if (marker.kind !== "down") return `uptime ${runnerClock(uptimeMs)}`
  return downMs === null ? undefined : `downtime ${runnerClock(downMs)}`
}

export function runnerMergeTimer(lastMerge: number | null, now: number, uptimeMs: number, hasRunner: boolean): string {
  if (lastMerge !== null) return `no merge for ${runnerClock(Math.max(0, now - lastMerge))}`
  return hasRunner ? `no merge for ${runnerClock(uptimeMs)}` : "no merge recorded"
}

// The STATS panel projects the retained journal facts into width-adaptive local
// hour buckets plus fixed calendar periods. It owns no parallel bookkeeping.

/** The four operator-facing status buckets (user respec 2026-07-15). */
export type QueueTimelineStatusBucket = "open" | "running" | "done" | "failed"

export const QUEUE_TIMELINE_STATUS_BUCKETS: readonly QueueTimelineStatusBucket[] = ["open", "running", "done", "failed"]

/** Project CLI-level status filters onto the four display buckets. CLI
 * `pending` keeps its pre-court meaning (pre-run + queued work) and maps to
 * BOTH `open` and `running` so neither court silently vanishes. */
export function queueTimelineFilterBuckets(
  statuses: readonly QueueTimelineStatusFilter[],
): ReadonlySet<QueueTimelineStatusBucket> {
  const buckets = new Set<QueueTimelineStatusBucket>()
  for (const status of statuses) {
    if (status === "pending") {
      buckets.add("open")
      buckets.add("running")
    } else if (status === "running") buckets.add("running")
    else if (status === "integrated") buckets.add("done")
    else buckets.add("failed")
  }
  return buckets
}

/** The operator's own wall-clock YYYY-MM-DD, matching the local `getFullYear`
 * / `getMonth` / `getDate` treatment `queueLogClock` already uses for its
 * inline date fallback (UTC is never shown to the operator). */
export function timelineLocalCalendarDay(timestamp: string): string {
  const when = new Date(timestamp)
  if (Number.isNaN(when.getTime())) throw new Error(`yrd: invalid queue timeline timestamp '${timestamp}'`)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
}

// Preserve fixed queue chrome plus at least two data rows. Below this pane
// height, omit the secondary STATS panel instead of collapsing ListView to a
// zero-height viewport. The below-split's default ratio (watch-pane.tsx) is
// what actually delivers this budget at 40- and 45-row production geometries.
export const QUEUE_STATS_MIN_PANE_ROWS = 24

export function propsField(pr: Run["prs"][number] | Change | undefined): Readonly<{ props?: ChangeProps }> {
  const props = pr === undefined ? undefined : "revs" in pr ? changeProps(pr) : pr.props
  if (props === undefined) return {}
  return { props }
}

/**
 * Detail facts render only PRESENT facts (user respec 2026-07-15) — the same
 * non-default-only rule as the FILTER row. `-` placeholders never render.
 */
export function presentFact(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" || trimmed === "-" ? undefined : trimmed
}

/** Dedupe `X@X` merges (commit == merge sha) to one SHA. */
export function queueMergeLabel(merge: string): string {
  const [commit, base, ...rest] = merge.split("@")
  if (rest.length === 0 && commit !== undefined && base !== undefined && commit === base) return commit
  return merge
}

// Integration proof beyond the merged SHA (item J, 2026-07-16): the count of
// source rewrites + submodule resolutions the queue carried into the merge.
export function integrationProofDetail(integration: IntegrationProof): string | undefined {
  const parts: string[] = []
  if (integration.sourceRewrites !== undefined && integration.sourceRewrites.length > 0) {
    parts.push(`REWRITES ${integration.sourceRewrites.length}`)
  }
  if (integration.submoduleResolutions !== undefined && integration.submoduleResolutions.length > 0) {
    parts.push(`SUBMODULES ${integration.submoduleResolutions.length}`)
  }
  return parts.length === 0 ? undefined : parts.join(" ")
}

export type ChangeActivityEntry = Readonly<{
  at: string
  rank: number
  text: string
  detail?: string
}>

/** A check-request echo within this tolerance of its revision row is the same
 * journal act seen twice; only a LATER (re-)request earns its own line. */
export const CHECK_REQUEST_ECHO_TOLERANCE_MS = 1_000

export function descriptionWithoutDuplicatedIssue(
  description: string | undefined,
  issue: string | undefined,
): string | undefined {
  if (description === undefined || issue === undefined) return description
  const duplicate = `issue: ${issue}`.toLocaleLowerCase()
  return presentFact(
    description
      .split("\n")
      .filter((line) => line.trim().toLocaleLowerCase() !== duplicate)
      .join("\n"),
  )
}
