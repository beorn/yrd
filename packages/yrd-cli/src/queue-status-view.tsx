import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type React from "react"
import {
  prRevisionLineage,
  prSourceReadyAt,
  type BaysState,
  type Correlation,
  type PR,
  type PRRevisionClock,
  type PRRevisionTerminal,
} from "@yrd/bay"
import type { Event, JsonValue } from "@yrd/core"
import { JobRequestSchema, JobTransitionSchema, type Job, type JobError } from "@yrd/job"
import {
  GateCertificateSchema,
  type IntegrationProof,
  type PRCheckRecord,
  type PREligibility,
  type QueueRun,
  type QueueStep,
  type QueueSummary,
} from "@yrd/queue"
import {
  Box,
  formatNounId,
  Link,
  ListView,
  MarkdownView,
  NounId,
  Pulse,
  Tab,
  TabList,
  Table,
  Tabs,
  Text,
  TogglePill,
  TogglePillGroup,
  type ListViewHandle,
  type TableColumn,
  type TextProps,
  useWindowSize,
} from "silvery"
import { submittedPrPositions } from "./queue-position.ts"
import {
  artifactHref as locationHref,
  artifactLabel,
  artifactLocation as artifactPath,
  directArtifacts,
  nestedArtifacts,
} from "./artifact-reference.ts"
import { formatLocalClock, TIMELINE_BRANCH_ICON, timelineStatusGlyph } from "./runner-timeline.ts"
import {
  formatDuration,
  PRStatusView,
  statusVariant,
  StatusValue,
  taskStatusColor,
  TaskStatusGlyph,
  TaskStatusValue,
} from "./status-view.tsx"
import {
  actionableFailure,
  actionableFailureSummary,
  errorCodeLabel,
  type ActionableFailure,
  type FailureLike,
} from "./actionable-error.ts"
import { failureSlug } from "./failure-slug.ts"
import {
  checkTaskStatusOf,
  jobAttemptTaskStatusOf,
  prTaskStatusOf,
  runTaskStatusOf,
  stepTaskStatusOf,
  taskStatusFields,
  type StatusGlyph,
  type TaskStatus,
  type TaskStatusFields,
} from "./task-status.ts"
import { TimeStatsBox, TIME_STATS_TWO_ACROSS_MIN_WIDTH } from "./time-stats-box.tsx"

const sourceRowKey = ["li", "ne"].join("") as `${"li"}${"ne"}`

function prIdValue(pr: string): string {
  return pr.replace(/^pr(?:[-#])?/iu, "")
}

/**
 * Retry — the SAME submission re-run N times by the queue (base moved, transient
 * fail) — rides the PR identity as `×N`, distinct from the `.N` submission mark.
 * A single run (first try) is bare. Mirrors the timeline's storm `×N`
 * vocabulary; each retry is its own run id (see runOutputQueueageIndex).
 *
 * Note (submission/draft model, @yrd/core/21679): `.N` is the submission number
 * and is shown from `.1` — a bare `pr#324` is reserved to mean DRAFT (zero
 * submissions) once the draft state lands. Do NOT omit `.1`.
 */
function retrySuffix(times: number | undefined): string {
  return times !== undefined && times > 1 ? `×${times}` : ""
}

export function formatQueuePrId(pr: string, revision: number | string, times?: number): string {
  return `${formatNounId("pr", prIdValue(pr), revision)}${retrySuffix(times)}`
}

type QueueNounIdProps = Omit<React.ComponentProps<typeof NounId>, "noun" | "value" | "revision">

function QueuePrId({
  pr,
  revision,
  times,
  ...props
}: { pr: string; revision: number | string; times?: number } & QueueNounIdProps) {
  const suffix = retrySuffix(times)
  return (
    <>
      <NounId noun="pr" value={prIdValue(pr)} revision={revision} {...props} />
      {suffix === "" ? null : <Text {...props}>{suffix}</Text>}
    </>
  )
}

function runIdValue(run: string): string {
  return run.replace(/^R(?=\d+$)/u, "")
}

function QueueRunId({ base, run, ...props }: { base: string; run: string } & QueueNounIdProps) {
  return <NounId noun={base} value={runIdValue(run)} {...props} />
}

export type QueueStatusResult = QueueSummary & { headSha?: string; prs: PR[] }

export type QueueTimelineRow = Readonly<{
  key: string
  pr: string
  revision: number
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
// `draft`, `rev`, and `ready` are display-only statuses for the
// non-integrated PRs that are not (yet) run members — a registered-but-unsubmitted
// PR (bay status `pushed`; `rev` when it carries failed-submission history)
// and a submitted PR awaiting its run. They never enter queue mechanics
// (composition, admission, terminal facts, FLOW stats) — see
// `timelineNonIntegratedRows`. (`pending` is retained as the shared pre-run
// group/filter/bucket name; `ready` is the status it now renders.)
export type QueueTimelineStatus = "draft" | "rev" | "ready" | "pending" | "running" | QueueTerminalOutcome
export type QueueTimelineGroup = "draft" | "pending" | "running" | "completed"

export type QueueTimelineRevisionLineage = Readonly<{
  pr: string
  revisions: readonly number[]
  sourceReadyAt?: string
}>

/**
 * One physical, selectable queue row. The list deliberately denormalizes one
 * exact PR revision (RunMember) per row: a batched Run repeats its Run facts
 * (`run`, `status`, `step`, `totalMs`) on one row per member while `pr`,
 * `revision`, `branch`, `subject`, `ageMs`, and `queueWaitMs` are member
 * facts. `id` is the composite cursor identity (`runId + prId + revision` for
 * Run rows, `prId + revision` for pending rows) that live reshuffles preserve.
 */
export type QueueTimelineProjectedRow = Readonly<{
  id: string
  base: string
  group: QueueTimelineGroup
  status: QueueTimelineStatus
  glyph: string
  timestamp: string | null
  timestampMs: number | null
  run?: string
  pr: string
  revision: number
  headSha: string
  branch: string
  /** Canonical issue path for this PR revision; presentation may replace the branch with this stronger identity. */
  issue?: string
  subject: string
  /** The actor who submitted this exact PR revision; absent only for journals written before submitter identity. */
  submitter?: string
  step?: string
  detail: string
  position?: number
  sourceReadyAt?: string
  revisionLineage: readonly QueueTimelineRevisionLineage[]
  failure?: Readonly<{ code: string; message: string }>
  ageMs: number | null
  totalMs: number | null
  activeMs: number | null
  waitMs: number | null
  queueWaitMs: number | null
}>

export type QueueTimelineRepeat = Readonly<{
  key: string
  count: number
  firstTimestamp: string
  lastTimestamp: string
  collapsed: boolean
}>

export type QueueTimelineDisplayRow = QueueTimelineProjectedRow & Readonly<{ repeat?: QueueTimelineRepeat }>

export type QueueTimelineRunner = Readonly<{
  pid: number
  startedAt: string
  lastTickAt: string
  /** The resident runner's launch command; absent for status records written before it was captured. */
  command?: string
  /** ISO time the resident wrote its exit marker on shutdown. The status file is
   * NEVER deleted on close — it is left with this marker so a successor can still
   * reclaim this pid's leases (idempotently). Absent while the runner is live. */
  exitedAt?: string
  /** With `exitedAt`: true = clean operator/drain stop, false = signal-forced or
   * crash exit. Absent while the runner is live. */
  clean?: boolean
}>

export type QueueTimelineProjection = Readonly<{
  now: string
  base: string
  siblingBases: readonly string[]
  /** Resident-runner heartbeat status; null renders loudly — nothing drains this queue. */
  runner: QueueTimelineRunner | null
  pause?: QueueSummary["pause"]
  oldestOpenMs: number | null
  filters: Readonly<{
    windowMs: number
    since: string
    statuses: readonly QueueTimelineStatusFilter[]
    terms: readonly string[]
    latest: boolean
  }>
  coverage: Readonly<{
    requestedSince: string
    retainedSince?: string
    complete: boolean
  }>
  display: Readonly<{ limit: number; shown: number; hidden: number }>
  rows: readonly QueueTimelineProjectedRow[]
  details: readonly QueueShowData[]
  metrics: QueueFlowMetrics
  /** Every retained completed-Run terminal fact, for the windowed FLOW/TIME boxes. */
  timeStatsFacts: readonly QueueTerminalFact[]
  /** Oldest timestamped journal record (ms), or null when none — drives the "-" coverage gate. */
  earliestEventMs: number | null
}>

export type QueueTimelineProjectionOptions = Readonly<{
  now: number
  windowMs: number
  /**
   * Window for the flow-metrics aggregate. Defaults to `windowMs` when omitted,
   * so a caller can widen the metrics horizon (e.g. 24h) while the listing rows
   * stay on the tighter `windowMs`. Never narrows the display set.
   */
  metricsWindowMs?: number
  statuses: readonly QueueTimelineStatusFilter[]
  terms: readonly string[]
  latest: boolean
  rowLimit: number
  submissionTimes: ReadonlyMap<string, string | null>
  attempts?: readonly QueueAttempt[]
  retainedSinceMs?: number
  siblingBases?: readonly string[]
  base?: string
  state?: BaysState
  runner?: QueueTimelineRunner | null
}>

export type QueueTerminalOutcome =
  | "integrated"
  | "rejected"
  | "environment-refused"
  | "stale"
  | "lost"
  | "legacy"
  | "refused"
  | "canceled"

export type QueueTerminalFact = Readonly<{
  run: string
  terminalAtMs: number
  outcome: QueueTerminalOutcome
  activeMs: number | null
  queueWaitMs: readonly number[]
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
  // Landed count over the window projected to a per-24h rate. per24h is null
  // only for a zero-width window.
  throughput: Readonly<{ landed: number; per24h: number | null }>
  // Oldest OPEN queue age at snapshot time — a live-queue fact the caller
  // supplies (it is not derivable from terminal facts). null when nothing is
  // queued. Folded in so the aggregate is one self-contained JSON key.
  oldestOpenMs: number | null
  activeRun: Readonly<{
    allTerminal: DurationDistribution
    integratedOnly: DurationDistribution
    // Active duration of every non-integrated terminal Run.
    // Drives the FLOW / TIME / FAILED section; the complement of integratedOnly.
    failedOnly: DurationDistribution
  }>
  queueWait: QueueWaitDistribution
}>

type QueueLogResult = QueueSummary & { prs?: readonly PR[] }

export type QueueLogRow = Readonly<{
  run: string
  base: string
  pr: string
  branch: string
  subject: string
  taskStatus: TaskStatus
  glyph: StatusGlyph
  revision: string
  headSha: string
  baseSha: string
  outcome: string
  startedAt: string
  finishedAt?: string
  submittedAt?: string
  started: string
  finished: string
  age: string
  ageMs?: number
  duration: string
  durationMs?: number
  totalDuration: string
  totalDurationMs?: number
  activeDuration: string
  activeDurationMs?: number
  waitDuration: string
  waitDurationMs?: number
  attempts: readonly (QueueLogAttempt & TaskStatusFields)[]
  activeSteps: readonly Readonly<{ step: string; duration: string; durationMs: number }>[]
  retries: string
  parent: string
  isolationPart: "0" | "1" | "-"
  result: string
  error: string
  location?: QueueLogLocation
  locations: readonly QueueLogLocationEntry[]
  integration?: IntegrationProof
  correlation?: Correlation
  landing: string
}>

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
  | Readonly<{ status: "lost"; reason: string }>

export type QueueAttempt = QueueLogAttempt &
  Readonly<{
    requestedAt: string
    revision: string
    result: QueueAttemptResult
  }>

type RequestedJob = Readonly<{ run: string; step: string; index: number; requestedAt: string; revision: string }>
type StartedAttempt = Readonly<{ attempt: number; runner: string; startedAt: string }>

type PinnedPRRevision = Readonly<{ id: string; revision: number; headSha: string }>

export function queueRevisionKey(revision: PinnedPRRevision): string {
  return JSON.stringify([revision.id, revision.revision, revision.headSha])
}

export function queueRunRevisionKey(run: Pick<QueueRun, "id">, revision: PinnedPRRevision): string {
  return JSON.stringify([run.id, revision.id, revision.revision, revision.headSha])
}

export function queueRunRevisionClocks(prs: Iterable<PR>, runs: Iterable<QueueRun>): Map<string, PRRunRevisionClock> {
  const byId = new Map([...prs].map((pr) => [pr.id, pr]))
  const clocks = new Map<string, PRRunRevisionClock>()
  for (const run of runs) {
    for (const revision of run.prs) {
      const pr = byId.get(revision.id)
      if (pr === undefined) throw new Error(`yrd: run '${run.id}' has no retained PR '${revision.id}'`)
      clocks.set(queueRunRevisionKey(run, revision), runRevisionClock(pr, run))
    }
  }
  return clocks
}

export async function queueLogAttempts(events: AsyncIterable<Event> | Iterable<Event>): Promise<QueueAttempt[]> {
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
      outcome: transition.type === "lose" ? "lost" : transition.result.status === "passed" ? "passed" : "failed",
      startedAt: start.startedAt,
      finishedAt: event.ts,
      durationMs,
      result: transition.type === "lose" ? { status: "lost", reason: transition.reason } : transition.result,
    })
  }

  return attempts
}

type Row = Readonly<{
  pr: string
  prHref?: string
  state: string
  target: string
  age: string
  touched: string
  run: string
  step: string
  result: string
  log?: string
  artifactCount: number
  artifact?: string
  path?: string
}>

export type HumanFailureProjection = ActionableFailure &
  Readonly<{
    summary: string
    evidence?: Readonly<{ text: string; href?: string }>
  }>

export type HumanPRProjection = Row &
  Readonly<{
    revision: number
    branch: string
    subject: string
    nativeStatus: PR["status"]
    taskStatus: TaskStatus
    glyph: StatusGlyph
    runId?: string
    submittedAt?: string
    sourceReadyAt?: string
    revisionLineage: readonly number[]
    touchedAt?: string
    failure?: HumanFailureProjection
  }>

export type HumanQueueProjection = Readonly<{
  target: string
  open: number
  activeCount: number
  integrated: number
  rejected: number
  pause?: QueueSummary["pause"]
  active?: WatchActiveRow
  oldestOpen: string
  queue: readonly (HumanPRProjection & Readonly<{ position: number }>)[]
  queueOverflow: number
  recent: readonly HumanPRProjection[]
}>

type QueueShowRow = Readonly<{
  step: string
  revision: string
  status: string
  taskStatus: TaskStatus
  glyph: StatusGlyph
  attempt: string
  uuid: string
  runner: string
  lease: string
  requested: string
  started: string
  changed: string
  finished: string
  duration: string
  durationMs?: number
  command?: string
  errorCode: string
  error: string
  failure?: HumanFailureProjection
  lost: string
  detail: string
  output: string
  artifacts: string
  evidence: string | Record<string, unknown>
  gate?: GateEvidence
  checkpoint: string
  landing: string
  location?: QueueLogLocation
  locations: readonly QueueLogLocationEntry[]
}>

type GateEvidence = Readonly<{
  mode: "delta" | "strict"
  residualCount: number
}>

export type QueueShowData = Readonly<{
  run: string
  base: string
  status: string
  taskStatus: TaskStatus
  glyph: StatusGlyph
  outcome: string
  started: string
  finished: string
  duration: string
  durationMs?: number
  totalDuration: string
  totalDurationMs?: number
  activeDuration: string
  activeDurationMs?: number
  waitDuration: string
  waitDurationMs?: number
  retries: number
  landing: string
  integration?: IntegrationProof
  parent: string
  isolationPart: "0" | "1" | "-"
  failure?: HumanFailureProjection
  prs: QueueRun["prs"]
  revisionClock?: PRRunRevisionClock
  attempts: readonly (QueueAttempt & TaskStatusFields)[]
  steps: readonly QueueShowRow[]
}>

export type PRRevisionHistoryClock = Readonly<{
  pr: string
  revision: number
  headSha: string
}> &
  PRRevisionClock

export type PRRunRevisionClock =
  | (PRRevisionHistoryClock & Readonly<{ admittedBy: "submission"; submittedAt: string }>)
  | (PRRevisionHistoryClock & Readonly<{ admittedBy: "check-request"; checkRequestedAt: string }>)

export type PRRunsData = Readonly<{
  pr: PR
  runs: readonly QueueShowData[]
}>

type LegacyQueueCoverage = Readonly<{
  path: string
  frames: number
}>

export type QueueLogCoverage = Readonly<{
  since: string
  completeness: "queue-only"
  legacy: readonly LegacyQueueCoverage[]
}>

type QueueLogLocation = Readonly<{ path: string }> | Readonly<{ url: string }>
type QueueLogLocationEntry = Readonly<{ label: string; display?: string; location: QueueLogLocation }>

function evidenceDisplay(label: string, location: QueueLogLocation): string {
  if (!("path" in location)) return label
  const normalized = location.path.replaceAll("\\", "/")
  const git = normalized.indexOf("/.git/")
  if (git >= 0) return normalized.slice(git + 1)
  return label
}

function age(timestamp: string | undefined, now: number, subject: string): string {
  if (timestamp === undefined) return "-"
  const value = elapsedMs(timestamp, new Date(now).toISOString(), subject)
  return value === undefined ? "-" : formatDuration(value)
}

function latest(...timestamps: (string | undefined)[]): string | undefined {
  return timestamps
    .filter((value): value is string => value !== undefined)
    .toSorted()
    .at(-1)
}

function latestRun(pr: PR, summary: QueueSummary): QueueRun | undefined {
  const current = queueRevisionKey({ id: pr.id, revision: pr.revision, headSha: pr.headSha })
  const currentSubmission =
    pr.status === "submitted"
      ? (pr.revisions.find((revision) => revision.revision === pr.revision && revision.headSha === pr.headSha)
          ?.submittedAt ?? pr.submittedAt)
      : undefined
  return [...summary.running, ...summary.waiting, ...summary.finished]
    .filter((run) => run.prs.some((member) => queueRevisionKey(member) === current))
    .filter(
      (run) =>
        currentSubmission === undefined ||
        timestamp(run.startedAt, `run '${run.id}' start`) >=
          timestamp(currentSubmission, `PR '${pr.id}' current revision submission`),
    )
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt))
    .at(-1)
}

/** The submitter handle recorded on one exact immutable PR revision, or
 * undefined for revisions journaled before submitter identity was recorded. */
function revisionSubmitter(pr: PR, revision = pr.revision, headSha = pr.headSha): string | undefined {
  return pr.revisions?.find((candidate) => candidate.revision === revision && candidate.headSha === headSha)?.actor
}

function currentTerminalFact(pr: PR): PRRevisionTerminal | undefined {
  let at: string | undefined
  switch (pr.status) {
    case "rejected":
      at = pr.rejectedAt
      break
    case "integrated":
      at = pr.integratedAt
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
    throw new Error(`yrd: PR '${pr.id}' current revision ${pr.revision}@${pr.headSha} has no ${pr.status} timestamp`)
  }
  return { status: pr.status, at }
}

function finiteNonnegative(value: number, subject: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`yrd: ${subject} must be finite`)
  if (value < 0) throw new RangeError(`yrd: ${subject} must not be negative`)
  return value
}

function arithmeticMedian(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null
  const upperIndex = Math.floor(sorted.length / 2)
  const upper = sorted[upperIndex]
  if (upper === undefined) return null
  if (sorted.length % 2 === 1) return upper
  const lower = sorted[upperIndex - 1]
  return lower === undefined ? null : (lower + upper) / 2
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null
}

function durationDistribution(values: readonly number[]): DurationDistribution {
  const sorted = values.toSorted((left, right) => left - right)
  const n = sorted.length
  if (n === 0) return { n, minMs: null, avgMs: null, p50Ms: null, p90Ms: null, maxMs: null }
  return {
    n,
    minMs: sorted[0] ?? null,
    avgMs: sorted.reduce((sum, value) => sum + value, 0) / n,
    p50Ms: arithmeticMedian(sorted),
    p90Ms: nearestRank(sorted, 0.9),
    maxMs: sorted[n - 1] ?? null,
  }
}

function waitDistribution(values: readonly number[]): QueueWaitDistribution {
  const { n, avgMs, p50Ms, p90Ms, maxMs } = durationDistribution(values)
  return { n, avgMs, p50Ms, p90Ms, maxMs }
}

const FLOW_DAY_MS = 24 * 60 * 60_000

export function queueFlowMetrics(
  facts: Iterable<QueueTerminalFact>,
  options: Readonly<{ now: number; windowMs: number; oldestOpenMs?: number | null }>,
): QueueFlowMetrics {
  const now = finiteNonnegative(options.now, "FLOW snapshot time")
  const windowMs = finiteNonnegative(options.windowMs, "FLOW window")
  const earliest = now - windowMs
  const seenRuns = new Set<string>()
  const activeAll: number[] = []
  const activeIntegrated: number[] = []
  const activeFailed: number[] = []
  const waits: number[] = []
  let integrated = 0
  let rejected = 0
  let environmentRefused = 0
  let stale = 0
  let lost = 0
  let legacy = 0
  let refused = 0
  let canceled = 0

  for (const fact of facts) {
    const terminalAtMs = finiteNonnegative(fact.terminalAtMs, `Run '${fact.run}' terminal time`)
    if (terminalAtMs < earliest || terminalAtMs > now) continue
    if (seenRuns.has(fact.run)) throw new Error(`yrd: duplicate terminal FLOW fact for Run '${fact.run}'`)
    seenRuns.add(fact.run)

    if (fact.outcome === "integrated") integrated += 1
    else if (fact.outcome === "rejected") rejected += 1
    else if (fact.outcome === "environment-refused") environmentRefused += 1
    else if (fact.outcome === "stale") stale += 1
    else if (fact.outcome === "lost") lost += 1
    else if (fact.outcome === "legacy") legacy += 1
    else if (fact.outcome === "refused") refused += 1
    else if (fact.outcome === "canceled") canceled += 1
    else {
      const outcome: never = fact.outcome
      throw new TypeError(`yrd: unknown terminal FLOW outcome '${String(outcome)}'`)
    }

    if (fact.activeMs !== null) {
      const activeMs = finiteNonnegative(fact.activeMs, `Run '${fact.run}' active duration`)
      activeAll.push(activeMs)
      if (fact.outcome === "integrated") activeIntegrated.push(activeMs)
      else activeFailed.push(activeMs)
    }
    for (const wait of fact.queueWaitMs) {
      waits.push(finiteNonnegative(wait, `Run '${fact.run}' queue wait`))
    }
  }

  const decisions = integrated + rejected
  return {
    windowMs,
    terminalAttempts: seenRuns.size,
    outcomes: { integrated, rejected, environmentRefused, stale, lost, legacy, refused, canceled },
    decisionRejection: {
      rejected,
      decisions,
      rate: decisions === 0 ? null : rejected / decisions,
    },
    throughput: { landed: integrated, per24h: windowMs === 0 ? null : (integrated * FLOW_DAY_MS) / windowMs },
    oldestOpenMs: options.oldestOpenMs ?? null,
    activeRun: {
      allTerminal: durationDistribution(activeAll),
      integratedOnly: durationDistribution(activeIntegrated),
      failedOnly: durationDistribution(activeFailed),
    },
    queueWait: waitDistribution(waits),
  }
}

export function queueTimelineRows(
  results: readonly QueueStatusResult[],
  now: number,
  latest: boolean,
  state?: BaysState,
): QueueTimelineRow[] {
  const projection = queueTimelineProjection(results, {
    now,
    windowMs: now,
    statuses: [],
    terms: [],
    latest,
    rowLimit: Number.MAX_SAFE_INTEGER,
    submissionTimes: queueTimelineAdmissionTimes(results),
    state,
  })
  return projection.rows.map((row) => {
    return {
      key: row.id,
      pr: row.pr,
      revision: row.revision,
      ...(row.run === undefined ? {} : { run: row.run }),
      ...(row.position === undefined ? {} : { position: row.position }),
      base: row.base,
      status: row.status === "pending" ? "ready" : row.status,
      subject: row.subject,
      detail: row.detail,
      clock: age(row.timestamp ?? undefined, now, "queue timeline row"),
      timestampMs: row.timestampMs ?? -1,
    }
  })
}

function validateRevisionClock(pr: PR, clock: PRRevisionHistoryClock): PRRevisionHistoryClock {
  const pushed = Date.parse(clock.pushedAt)
  if (!Number.isFinite(pushed)) {
    throw new Error(
      `yrd: PR '${pr.id}' revision ${clock.revision}@${clock.headSha} has an invalid pushed clock '${clock.pushedAt}'`,
    )
  }
  if (clock.submittedAt !== undefined) {
    const submitted = elapsedMs(
      clock.pushedAt,
      clock.submittedAt,
      `PR '${pr.id}' revision ${clock.revision}@${clock.headSha} pushed-to-submitted age`,
    )
    if (submitted === undefined) {
      throw new Error(
        `yrd: PR '${pr.id}' revision ${clock.revision}@${clock.headSha} has an invalid submitted clock '${clock.submittedAt}'`,
      )
    }
  }
  if (clock.terminal !== undefined) {
    const terminal = elapsedMs(
      clock.submittedAt ?? clock.pushedAt,
      clock.terminal.at,
      `PR '${pr.id}' revision ${clock.revision}@${clock.headSha} submitted-to-terminal age`,
    )
    if (terminal === undefined) {
      throw new Error(
        `yrd: PR '${pr.id}' revision ${clock.revision}@${clock.headSha} has an invalid terminal clock '${clock.terminal.at}'`,
      )
    }
  }

  if (clock.revision !== pr.revision || clock.headSha !== pr.headSha) return clock
  const expected = currentTerminalFact(pr)
  if (expected === undefined) {
    if (clock.terminal !== undefined) {
      throw new Error(
        `yrd: PR '${pr.id}' current revision ${clock.revision}@${clock.headSha} retains stale ${clock.terminal.status} terminal clock`,
      )
    }
    return clock
  }
  if (clock.terminal === undefined) {
    throw new Error(
      `yrd: PR '${pr.id}' current revision ${clock.revision}@${clock.headSha} has no ${expected.status} terminal clock`,
    )
  }
  if (clock.terminal.status !== expected.status || clock.terminal.at !== expected.at) {
    throw new Error(
      `yrd: PR '${pr.id}' current revision ${clock.revision}@${clock.headSha} ${expected.status} terminal clock contradicts current PR state`,
    )
  }
  return clock
}

function revisionHistoryClock(pr: PR, revision: PR["revisions"][number]): PRRevisionHistoryClock {
  return {
    pr: pr.id,
    revision: revision.revision,
    headSha: revision.headSha,
    pushedAt: revision.pushedAt,
    ...(revision.submittedAt === undefined ? {} : { submittedAt: revision.submittedAt }),
    ...(revision.terminal === undefined ? {} : { terminal: revision.terminal }),
  }
}

export function prRevisionClocks(pr: PR): readonly PRRevisionHistoryClock[] {
  const clocks = pr.revisions.map((revision) => validateRevisionClock(pr, revisionHistoryClock(pr, revision)))
  if (!clocks.some((clock) => clock.revision === pr.revision && clock.headSha === pr.headSha)) {
    throw new Error(`yrd: PR '${pr.id}' has no clock for current revision ${pr.revision}@${pr.headSha}`)
  }
  return clocks
}

function revisionCheckRequests(pr: PR, clock: PRRevisionHistoryClock): readonly PR["checkRequests"][number][] {
  return pr.checkRequests
    .filter((request) => request.revision === clock.revision && request.headSha === clock.headSha)
    .map((request) => {
      const elapsed = elapsedMs(
        clock.pushedAt,
        request.at,
        `PR '${pr.id}' revision ${clock.revision}@${clock.headSha} pushed-to-check-request age`,
      )
      if (elapsed === undefined) {
        throw new Error(
          `yrd: PR '${pr.id}' revision ${clock.revision}@${clock.headSha} has an invalid check-request clock '${request.at}'`,
        )
      }
      return request
    })
}

function timestamp(value: string, subject: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`yrd: ${subject} has invalid timestamp '${value}'`)
  return parsed
}

export function runRevisionClock(pr: PR, run: QueueRun): PRRunRevisionClock {
  const pinned = run.prs.find((member) => member.id === pr.id)
  if (pinned === undefined) throw new Error(`yrd: run '${run.id}' does not contain PR '${pr.id}'`)
  const revision = pr.revisions.find(
    (revision) => revision.revision === pinned.revision && revision.headSha === pinned.headSha,
  )
  if (revision === undefined) {
    throw new Error(
      `yrd: run '${run.id}' has no retained revision clock for PR '${pr.id}' revision ${pinned.revision}@${pinned.headSha}`,
    )
  }
  const historyClock = revisionHistoryClock(pr, revision)
  const startedAt = timestamp(run.startedAt, `run '${run.id}' start`)
  if (
    revision.submittedAt !== undefined &&
    timestamp(revision.submittedAt, `PR '${pr.id}' revision ${pinned.revision}@${pinned.headSha} submission`) <=
      startedAt
  ) {
    const clock = validateRevisionClock(pr, historyClock)
    return { ...clock, admittedBy: "submission", submittedAt: revision.submittedAt }
  }
  const checkRequest = revisionCheckRequests(pr, historyClock)
    .filter((request) => timestamp(request.at, `PR '${pr.id}' check request`) <= startedAt)
    .toSorted((left, right) => left.at.localeCompare(right.at))
    .at(-1)
  if (checkRequest === undefined) {
    throw new Error(
      `yrd: run '${run.id}' has no causal submit/check-request clock for PR '${pr.id}' revision ${pinned.revision}@${pinned.headSha}`,
    )
  }
  const clock = validateRevisionClock(pr, historyClock)
  return { ...clock, admittedBy: "check-request", checkRequestedAt: checkRequest.at }
}

type JobByStatus<Status extends Job["status"]> = Extract<Job, { status: Status }>

function jobStatus(step: QueueStep): Job["status"] | "queued" {
  return step.job?.status ?? "queued"
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function safeText(value: unknown): string {
  if (value === undefined) return "-"
  if (value === "") return "-"
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function singleQueue(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim()
  return normalized === "" ? "-" : normalized
}

function boundedQueue(value: string, limit = 120): string {
  const normalized = singleQueue(value)
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

function toIso(timestamp: string | undefined): string {
  if (timestamp === undefined) return "-"
  const when = new Date(timestamp)
  return Number.isNaN(when.getTime()) ? "-" : when.toISOString()
}

function duration(started: string | undefined, finished: string | undefined): string {
  const value = elapsedMs(started, finished)
  return value === undefined ? "-" : formatDuration(value)
}

function elapsedMs(
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

function preciseDuration(milliseconds: number, compact = false): string {
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

function mediaDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = String(seconds % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`
}

function relativeAge(milliseconds: number): string {
  if (milliseconds >= 3_600_000) return `${Math.round(milliseconds / 3_600_000)}h`
  return preciseDuration(milliseconds, true)
}

function queueLogClock(timestamp: string, compact: boolean, includeDate: boolean): string {
  if (timestamp === "-") return timestamp
  const when = new Date(timestamp)
  if (Number.isNaN(when.getTime())) throw new Error(`yrd: invalid queue-log timestamp '${timestamp}'`)
  // Operators read the queue in their own wall-clock time, so render the
  // system-local timezone rather than UTC. The include-date decision upstream
  // stays calendar-day-in-UTC; only the displayed value is localized.
  const clock = formatLocalClock(when, includeDate)
  if (includeDate) return clock
  return compact ? clock.slice(0, 5) : clock
}

function queueLogLevel(outcome: string): "DEBUG" | "ERROR" | "INFO" | "WARN" {
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

function runDurations(
  run: QueueRun,
  attempts: readonly QueueLogAttempt[],
): {
  totalDurationMs?: number
  activeDurationMs?: number
  waitDurationMs?: number
  activeSteps: { step: string; duration: string; durationMs: number }[]
} {
  const totalDurationMs = elapsedMs(run.startedAt, run.finishedAt)
  const activeSteps = run.steps.flatMap((step) => {
    const job = step.job
    if (job === undefined || !("startedAt" in job) || !("finishedAt" in job)) return []
    const durationMs = elapsedMs(job.startedAt, job.finishedAt)
    return durationMs === undefined ? [] : [{ step: step.name, duration: preciseDuration(durationMs), durationMs }]
  })
  if (totalDurationMs === undefined) return { activeSteps }
  const activeDurationMs = Math.min(
    totalDurationMs,
    attempts.length > 0
      ? attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0)
      : activeSteps.reduce((sum, step) => sum + step.durationMs, 0),
  )
  return {
    totalDurationMs,
    activeDurationMs,
    waitDurationMs: totalDurationMs - activeDurationMs,
    activeSteps,
  }
}

function parseRunIdSuffix(run: string): number {
  const match = /^R(\d+)$/u.exec(run)
  if (match === null) return Number.MAX_SAFE_INTEGER
  const suffix = match[1]
  return suffix === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(suffix, 10)
}

function byRunStarted(left: QueueRun, right: QueueRun): number {
  const leftAt = Date.parse(left.startedAt)
  const rightAt = Date.parse(right.startedAt)
  if (leftAt !== rightAt) return leftAt - rightAt
  return parseRunIdSuffix(left.id) - parseRunIdSuffix(right.id)
}

function artifactLocation(step: QueueStep | undefined): QueueLogLocation | undefined {
  return stepLocations(step)[0]?.location
}

function stepLocations(step: QueueStep | undefined): QueueLogLocationEntry[] {
  if (step?.job === undefined) return []
  const locations: QueueLogLocationEntry[] = []
  const seen = new Set<string>()
  const add = (label: string, location: QueueLogLocation): void => {
    const key = "path" in location ? `path:${location.path}` : `url:${location.url}`
    if (seen.has(key)) return
    seen.add(key)
    locations.push({ label, display: evidenceDisplay(label, location), location })
  }
  for (const artifact of stepArtifacts(step)) {
    const location = artifactPath(artifact)
    if (location !== undefined) add(artifactLabel(artifact), location)
  }
  if (typeof (step.job as { url?: unknown }).url === "string") {
    const url = (step.job as { url: string }).url
    if (url !== "") add("job", { url })
  }
  return locations
}

function attemptArtifacts(attempt: QueueAttempt): readonly unknown[] {
  if (attempt.result.status === "lost" || !isObjectValue(attempt.result.output)) return []
  return Array.isArray(attempt.result.output.artifacts) ? attempt.result.output.artifacts : []
}

function attemptLocations(attempt: QueueAttempt): QueueLogLocationEntry[] {
  return attemptArtifacts(attempt).flatMap((artifact) => {
    const location = artifactPath(artifact)
    if (location === undefined) return []
    const label = artifactLabel(artifact)
    return [{ label, display: evidenceDisplay(label, location), location }]
  })
}

function runLocations(run: QueueRun): QueueLogLocationEntry[] {
  const locations = run.steps.flatMap((step) => stepLocations(step))
  return [...new Map(locations.map((entry) => [JSON.stringify(entry.location), entry])).values()]
}

function runLocation(run: QueueRun): QueueLogLocation | undefined {
  return run.steps.toReversed().flatMap(stepLocations).at(0)?.location
}

function jobCheckpoint(job: Job | undefined): unknown {
  if (job === undefined) return undefined
  if (job.status === "waiting" || job.status === "passed" || job.status === "failed") return job.checkpoint
  return undefined
}

function relevantStep(run: QueueRun | undefined): QueueStep | undefined {
  if (run === undefined) return undefined
  const latestFirst = run.steps.toReversed()
  return (
    latestFirst.find((step) => jobStatus(step) === "failed") ??
    latestFirst.find((step) => ["requested", "running", "waiting", "lost"].includes(jobStatus(step))) ??
    latestFirst.find((step) => jobStatus(step) !== "queued")
  )
}

function runOutputQueueageIndex(finished: readonly QueueRun[], run: QueueRun, revision: number, prId: string): number {
  const related = finished
    .filter((candidate) => candidate.prs.some((pr) => pr.id === prId && pr.revision === revision))
    .toSorted(byRunStarted)
  return related.findIndex((candidate) => candidate.id === run.id) + 1
}

function stepArtifacts(step: QueueStep | undefined): readonly unknown[] {
  if (step?.job === undefined) return []
  const artifacts: unknown[] = []
  if ("artifacts" in step.job && Array.isArray(step.job.artifacts)) {
    artifacts.push(...(step.job.artifacts as readonly unknown[]))
  }
  if ((step.job.status === "passed" || step.job.status === "failed") && isObjectValue(step.job.output)) {
    artifacts.push(...directArtifacts(step.job.output))
  }
  if (step.job.status === "failed") {
    artifacts.push(...nestedArtifacts(step.job.error.evidence))
  }
  const checkpoint = jobCheckpoint(step.job)
  artifacts.push(...directArtifacts(checkpoint))
  return [...new Map(artifacts.map((artifact) => [JSON.stringify(artifact), artifact])).values()]
}

function artifactHref(artifact: unknown): string | undefined {
  const location = artifactPath(artifact)
  if (location === undefined) return undefined
  return locationHref(location)
}

function stepOutput(step: QueueStep): string {
  const job = step.job
  if (job === undefined) return "-"
  if (job.status === "failed") return safeText((job as JobByStatus<"failed">).output ?? job.error)
  if (job.status === "passed") return safeText((job as JobByStatus<"passed">).output)
  if (job.status === "waiting" || job.status === "running") {
    const detail = job.status === "waiting" && typeof job.detail === "string" ? job.detail : undefined
    return detail === undefined ? "waiting" : detail
  }
  return "-"
}

function queueOutcome(run: QueueRun): string {
  if (run.status === "passed") return queueIntegration(run) === undefined ? "passed" : "integrated"
  if (run.status === "failed") return terminalProjection(run).display
  // "canceled" is a distinct terminal outcome — a canceled run is NOT rejected;
  // its PRs re-queue. "running"/"waiting" fall through unchanged.
  return run.status
}

function queueIntegration(run: QueueRun): IntegrationProof | undefined {
  return run.integration ?? ("integration" in run.shape ? run.shape.integration : undefined)
}

function queueLanding(run: QueueRun): string {
  const proof = queueIntegration(run)
  if (proof === undefined) return "-"
  return `${proof.commit.slice(0, 12)}@${proof.baseSha.slice(0, 12)}`
}

function queueOutcomeIntegration(run: QueueRun): IntegrationProof {
  const proof = queueIntegration(run)
  if (proof === undefined) throw new Error(`yrd: passed run '${run.id}' is missing integration proof`)
  return proof
}

function isolationPartLabel(run: QueueRun): "0" | "1" | "-" {
  return run.isolationPart === undefined ? "-" : run.isolationPart === 0 ? "0" : "1"
}

function queueShowRetries(finished: readonly QueueRun[], run: QueueRun): number {
  if (run.prs.length === 0) return 0
  const first = run.prs[0]
  if (first === undefined) return 0
  return runOutputQueueageIndex(finished, run, first.revision, first.id)
}

function queueState(pr: PR, run: QueueRun | undefined): string {
  if (run?.status === "running") return "checking"
  if (run?.status === "waiting") return "waiting"
  return pr.status
}

function stepError(step: QueueStep): string {
  const job = step.job
  if (job === undefined) return "-"
  if (job.status === "failed") return (job as JobByStatus<"failed">).error.message
  return "-"
}

function stepErrorCode(step: QueueStep): string {
  const job = step.job
  return job?.status === "failed" ? (job as JobByStatus<"failed">).error.code : "-"
}

function stepLost(step: QueueStep): string {
  const job = step.job
  if (job?.status !== "lost") return "-"
  return job.lostReason
}

function stepDetail(step: QueueStep): string {
  const job = step.job
  if (job === undefined) return "-"
  const outputDetail =
    (job.status === "passed" || job.status === "failed") && isObjectValue(job.output) ? job.output.detail : undefined
  if (typeof outputDetail === "string" && outputDetail !== "") return outputDetail
  const detail =
    job.status === "waiting" || job.status === "passed" || job.status === "failed"
      ? "detail" in job
        ? job.detail
        : undefined
      : undefined
  if (typeof detail === "string" && detail !== "") return detail
  if (job.status === "failed") return (job as JobByStatus<"failed">).error.message
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

function stepCommand(step: QueueStep): string | undefined {
  const output = step.job !== undefined && "output" in step.job ? step.job.output : undefined
  const recorded = isObjectValue(output) ? commandText(output.command) : undefined
  if (recorded !== undefined) return recorded
  const input = step.job?.input
  return isObjectValue(input) ? commandText(input.command) : undefined
}

function stepDuration(step: QueueStep): string {
  const job = step.job
  if (job === undefined) return "-"
  if (job.status === "requested" || job.status === "running" || job.status === "waiting") return "-"
  if (job.status === "passed" || job.status === "failed" || job.status === "lost") {
    return duration(job.startedAt, (job as { finishedAt?: string }).finishedAt)
  }
  return "-"
}

function stepArtifactsText(step: QueueStep): string {
  const artifacts = stepArtifacts(step)
  if (artifacts.length === 0) return "-"
  const first = artifacts[0]
  if (isObjectValue(first) && typeof first.name === "string") return first.name
  return String(artifacts.length)
}

function stepCheckpointText(step: QueueStep): string {
  const checkpoint = jobCheckpoint(step.job)
  if (!isObjectValue(checkpoint)) return "-"
  const value = [] as string[]
  if (typeof checkpoint.baseSha === "string") value.push(`base:${checkpoint.baseSha.slice(0, 12)}`)
  if (typeof checkpoint.candidateSha === "string") value.push(`candidate:${checkpoint.candidateSha.slice(0, 12)}`)
  return value.length === 0 ? safeText(checkpoint) : value.join(" ")
}

function gateEvidenceFromOutput(output: unknown): GateEvidence | undefined {
  if (!isObjectValue(output)) return undefined
  const parsed = GateCertificateSchema.safeParse(output.certificate)
  if (!parsed.success) return undefined
  const certificate = parsed.data
  return {
    mode: certificate.mode,
    residualCount: certificate.reports.reduce((total, report) => total + report.residual.count, 0),
  }
}

function gateEvidenceLabel(gate: GateEvidence): string {
  return `${gate.mode} residual:${gate.residualCount}`
}

function stepEvidence(step: QueueStep, gate: GateEvidence | undefined): string | Record<string, unknown> {
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

function CellLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} minWidth={0} maxWidth="100%" flexShrink={1} wrap="truncate">
      {children}
    </Link>
  )
}

/** An OSC 8 target for an issue reference. Path-form ids use km's canonical
 * internal URI shape; URLs and filesystem paths retain their native targets. */
function issueHref(issue: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(issue)) return issue
  if (/^(?:\/|\.\.?\/)/u.test(issue)) return pathToFileURL(resolve(issue)).href
  if (/^@[^/\s]+(?:\/[^/\s]+)+$/u.test(issue)) return `km:${issue}`
  return undefined
}

/** An issue reference rendered as an OSC 8 hyperlink whenever it has a
 * meaningful native or km-internal target. */
function IssueValue({ issue, flex = false }: { issue: string; flex?: boolean }) {
  const href = issueHref(issue)
  return href === undefined ? (
    <Text color="$fg-link" minWidth={flex ? 0 : undefined} flexShrink={flex ? 1 : undefined} wrap="truncate">
      {issue}
    </Text>
  ) : flex ? (
    <Link href={href} wrap="truncate" minWidth={0} flexShrink={1}>
      {issue}
    </Link>
  ) : (
    <CellLink href={href}>{issue}</CellLink>
  )
}

/**
 * A PR description rendered as Markdown. Authored hard-wraps reflow to the pane
 * width (a commit body wrapped at 72 columns no longer shows mangled mid-word
 * breaks in a narrow detail pane), and bold / lists / inline code / headings
 * render styled instead of raw. Shared by the watch detail pane and `pr view`
 * via PRDetailView / QueueDetailPrFacts. See silvery's MarkdownView.
 */
function DescriptionBlock({ description }: { description: string }) {
  return <MarkdownView source={description} minWidth={0} />
}

function LocationLinks({ entries }: { entries: readonly QueueLogLocationEntry[] }) {
  if (entries.length === 0) return "-"
  return (
    <Box flexDirection="row" gap={1}>
      {entries.map((entry) => {
        const target = "path" in entry.location ? entry.location.path : entry.location.url
        const href = "path" in entry.location ? pathToFileURL(entry.location.path).href : entry.location.url
        return (
          <CellLink key={`${entry.label}:${target}`} href={href}>
            {`${entry.label}=${entry.display ?? target}`}
          </CellLink>
        )
      })}
    </Box>
  )
}

function QueueLogLocationLinks({ entries, compact }: { entries: readonly QueueLogLocationEntry[]; compact: boolean }) {
  if (entries.length === 0) return <Text>-</Text>
  return (
    <Text>
      art:
      {entries.map((entry, index) => {
        const href = "path" in entry.location ? pathToFileURL(entry.location.path).href : entry.location.url
        return (
          <Text key={`${entry.label}:${href}`}>
            {compact || index === 0 ? null : "+"}
            <Link href={href}>{compact ? String(index + 1) : (entry.display ?? entry.label)}</Link>
          </Text>
        )
      })}
    </Text>
  )
}

const QUEUE_ROW_LIMIT = 5
const RECENT_ROW_LIMIT = 3

// Canonical queue marker vocabulary: working disc, neutral pending ring, red
// failure cross, muted minus, and completion check. Each lifecycle class stays
// distinguishable before color; color is foreground-only.
// The status → glyph map lives in runner-timeline.ts (pure, no silvery) so the
// headless resident runner shares this exact vocabulary.
const statusGlyph = timelineStatusGlyph

function failureFact(
  run: QueueRun | undefined,
  step: QueueStep | undefined,
): { code: string; message: string } | undefined {
  const job = step?.job
  if (job?.status === "failed") return { code: job.error.code, message: job.error.message }
  if (job?.status === "lost") return { code: "job-lost", message: job.lostReason }
  return run?.error
}

function projectFailure(fact: FailureLike, evidence?: HumanFailureProjection["evidence"]): HumanFailureProjection {
  const failure = actionableFailure(fact)
  return {
    ...failure,
    summary: actionableFailureSummary(failure),
    ...(evidence === undefined ? {} : { evidence }),
  }
}

const STALE_CODES = new Set(["stale-pr", "stale-check", "stale-base"])
// `check-failed` is the queue's generic decision wrapper, not a specific
// failure taxonomy. Preserve its established `rejected` display; every
// unrecognized/specific code remains lossless at the display boundary below.
const GENERIC_REJECTION_CODES = new Set(["check-failed"])
const CANCELED_CODES = new Set([
  "canceled",
  "cancelled",
  "queue-canceled",
  "queue-cancelled",
  "run-canceled",
  "run-cancelled",
])
const TIMELINE_STATUS_ORDER: readonly QueueTimelineStatusFilter[] = [
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

type QueueTerminalProjection = Readonly<{ outcome: QueueTerminalOutcome; display: string }>

/**
 * Project one terminal Run once. `outcome` is the compact lifecycle/metrics
 * class; `display` is the log/show value and deliberately preserves an
 * unrecognized raw failure code. Timeline rows keep the raw code in their
 * failure fact / STEP cell without bloating the fixed STATUS column.
 */
function terminalProjection(run: QueueRun): QueueTerminalProjection {
  if (run.status === "passed") return { outcome: "integrated", display: "integrated" }
  const status = run.status as string
  if (status === "running" || status === "waiting") {
    throw new TypeError(`yrd: nonterminal Run '${run.id}' cannot be projected as a terminal outcome`)
  }
  if (status === "canceled" || status === "cancelled") return { outcome: "canceled", display: "canceled" }
  const failure = failureFact(run, relevantStep(run))
  if (failure === undefined) return { outcome: "rejected", display: "rejected" }
  if (GENERIC_REJECTION_CODES.has(failure.code)) return { outcome: "rejected", display: "rejected" }
  if (CANCELED_CODES.has(failure.code)) return { outcome: "canceled", display: "canceled" }
  if (failure.code === "job-lost") return { outcome: "lost", display: "lost" }
  if (STALE_CODES.has(failure.code)) return { outcome: "stale", display: "stale" }
  if (failure.code === "queue-environment-refused") {
    return { outcome: "environment-refused", display: "environment-refused" }
  }
  if (failure.code === "legacy-quiesced") return { outcome: "legacy", display: "legacy" }
  if (failure.code === "legacy-root-leased") return { outcome: "refused", display: "refused" }
  return { outcome: "rejected", display: failure.code }
}

/** Reject a nonterminal status at the terminal-fact boundary. */
function terminalOutcome(status: QueueTimelineStatus): QueueTerminalOutcome {
  if (status === "draft" || status === "rev" || status === "ready" || status === "pending" || status === "running") {
    throw new TypeError(`yrd: nonterminal status '${status}' cannot become a terminal FLOW fact`)
  }
  return status
}

function timelineStatusFilter(status: QueueTimelineStatus): QueueTimelineStatusFilter {
  // Every pre-run status (draft/rev/ready) filters with `pending`/`todo`:
  // they surface under the default view and the todo bucket, without minting new
  // CLI status filters.
  if (status === "draft" || status === "rev" || status === "ready") return "pending"
  if (status === "pending" || status === "running" || status === "rejected" || status === "integrated") {
    return status
  }
  return "other"
}

function parsedTimelineTimestamp(timestamp: string | undefined, subject: string): number | null {
  if (timestamp === undefined) return null
  const value = Date.parse(timestamp)
  if (!Number.isFinite(value)) throw new TypeError(`yrd: ${subject} has invalid timestamp '${timestamp}'`)
  return value
}

function timelineAge(timestamp: string | undefined, nowIso: string, subject: string): number | null {
  return elapsedMs(timestamp, nowIso, subject) ?? null
}

function timelineMemberSubject(
  result: QueueStatusResult,
  member: QueueRun["prs"][number],
  state: BaysState | undefined,
): string {
  const current = result.prs.find((candidate) => candidate.id === member.id)
  const isCurrent = current?.revision === member.revision && current.headSha === member.headSha
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

function timelineRevisionLineage(pr: PR, revision = pr.revision): QueueTimelineRevisionLineage {
  const retained = pr.revisions?.some((candidate) => candidate.revision === revision)
  if (retained !== true) {
    return {
      pr: pr.id,
      revisions: [revision],
      ...(revision === pr.revision && pr.submittedAt !== undefined ? { sourceReadyAt: pr.submittedAt } : {}),
    }
  }
  const revisions = prRevisionLineage(pr, revision)
  const sourceReadyAt = prSourceReadyAt(pr, revision)
  return {
    pr: pr.id,
    revisions: revisions.map((candidate) => candidate.revision),
    ...(sourceReadyAt === undefined ? {} : { sourceReadyAt }),
  }
}

function timelineLineageLabel(lineages: readonly QueueTimelineRevisionLineage[]): string | undefined {
  const recuts = lineages.filter(({ revisions }) => revisions.length > 1)
  if (recuts.length === 0) return undefined
  return recuts
    .map(({ pr, revisions }) => {
      const path = revisions.map((revision) => `rev${revision}`).join("→")
      const currentRevision = revisions.at(-1) ?? 1
      return recuts.length === 1 ? path : `${formatQueuePrId(pr, currentRevision)} ${path}`
    })
    .join(" · ")
}

function withTimelineLineage(detail: string, lineages: readonly QueueTimelineRevisionLineage[]): string {
  const lineage = timelineLineageLabel(lineages)
  return lineage === undefined ? detail : `${detail} · ${lineage}`
}

function timelineQueueWaits(run: QueueRun, submissionTimes: ReadonlyMap<string, string | null>): (number | null)[] {
  return run.prs.map((member) => {
    const runKey = queueRunRevisionKey(run, member)
    const submittedAt = submissionTimes.has(runKey)
      ? (submissionTimes.get(runKey) ?? undefined)
      : (submissionTimes.get(queueRevisionKey(member)) ?? undefined)
    return elapsedMs(submittedAt, run.startedAt, `PR '${member.id}' queue wait`) ?? null
  })
}

function timelineRunMemberRows(
  result: QueueStatusResult,
  run: QueueRun,
  nowIso: string,
  submissionTimes: ReadonlyMap<string, string | null>,
  state: BaysState | undefined,
  attempts: readonly QueueAttempt[],
): QueueTimelineProjectedRow[] {
  const running = run.status === "running" || run.status === "waiting"
  const terminal = running ? null : terminalProjection(run)
  const status: QueueTimelineStatus = terminal === null ? "running" : terminal.outcome
  const timestamp = running ? toIso(run.startedAt) : run.finishedAt === undefined ? null : toIso(run.finishedAt)
  const timestampMs = parsedTimelineTimestamp(timestamp ?? undefined, `Run '${run.id}' timeline`)
  const elapsedRunMs = running
    ? timelineAge(run.startedAt, nowIso, `Run '${run.id}' active duration`)
    : (elapsedMs(run.startedAt, run.finishedAt, `Run '${run.id}' active duration`) ?? null)
  const durations = runDurations(
    run,
    attempts.filter((attempt) => attempt.run === run.id),
  )
  const totalMs = running ? elapsedRunMs : (durations.totalDurationMs ?? null)
  const activeMs = running ? null : (durations.activeDurationMs ?? null)
  const waitMs = running ? null : (durations.waitDurationMs ?? null)
  const failure = status === "integrated" ? undefined : failureFact(run, relevantStep(run))
  const step = relevantStep(run)
  // The row's STEP cell names the currently executing step; a later queued
  // step (requested) only shows when nothing is actively running.
  const currentStep =
    run.steps.toReversed().find((candidate) => ["running", "waiting"].includes(jobStatus(candidate))) ?? step
  const stepLabel =
    running && currentStep !== undefined ? `${run.steps.indexOf(currentStep) + 1}:${currentStep.name}` : undefined
  const baseDetail =
    failure === undefined
      ? status === "integrated"
        ? queueLanding(run)
        : step === undefined
          ? run.status
          : `${step.name}: ${jobStatus(step)}`
      : actionableFailureSummary(actionableFailure(failure))
  const queueWaits = timelineQueueWaits(run, submissionTimes)
  const ageEndIso = running ? nowIso : (run.finishedAt ?? nowIso)
  return run.prs.map((member, index) => {
    const current = result.prs.find((candidate) => candidate.id === member.id)
    if (current === undefined) throw new Error(`yrd: run '${run.id}' has no retained PR '${member.id}'`)
    const lineage = timelineRevisionLineage(current, member.revision)
    const runKey = queueRunRevisionKey(run, member)
    const submittedAt = submissionTimes.has(runKey)
      ? (submissionTimes.get(runKey) ?? undefined)
      : (submissionTimes.get(queueRevisionKey(member)) ?? undefined)
    // Member AGE anchors on the causal admission clock of THIS run, so a
    // later resubmission of the same revision can never postdate an earlier
    // run's finish (the 21106 timestamp-crash class).
    const admission = (current.revisions?.length ?? 0) > 0 ? runRevisionClock(current, run) : undefined
    const sourceReadyAt =
      admission === undefined
        ? (lineage.sourceReadyAt ?? submittedAt)
        : admission.admittedBy === "submission"
          ? (lineage.sourceReadyAt ?? admission.submittedAt)
          : (admission.checkRequestedAt ?? admission.pushedAt)
    const submitter = revisionSubmitter(current, member.revision, member.headSha)
    const issue = presentFact(current.issue)
    return {
      id: `${run.base}:run:${run.id}:${member.id}:${member.revision}`,
      base: run.base,
      group: running ? ("running" as const) : ("completed" as const),
      status,
      glyph: statusGlyph(status),
      timestamp,
      timestampMs,
      run: run.id,
      pr: member.id,
      revision: member.revision,
      headSha: member.headSha,
      branch: member.branch,
      ...(issue === undefined ? {} : { issue }),
      subject: timelineMemberSubject(result, member, state),
      ...(submitter === undefined ? {} : { submitter }),
      ...(stepLabel === undefined ? {} : { step: stepLabel }),
      detail: withTimelineLineage(baseDetail, [lineage]),
      ...(sourceReadyAt === undefined ? {} : { sourceReadyAt }),
      revisionLineage: [lineage],
      ...(failure === undefined ? {} : { failure }),
      ageMs: elapsedMs(sourceReadyAt, ageEndIso, `PR '${member.id}' source-ready age`) ?? null,
      totalMs,
      activeMs,
      waitMs,
      queueWaitMs: queueWaits[index] ?? null,
    }
  })
}

/** The most recent failed submission (a `rejected` terminal) a PR's revision
 * history records, or undefined when it has never failed a submission. This is
 * the derived signal — never a stored status — that turns a `draft` into a
 * `rev` row. `canceled`/`withdrawn` terminals are supersessions, not
 * failures, so they do not count. */
function lastFailedSubmission(pr: PR): PR["revisions"][number] | undefined {
  return pr.revisions.filter((revision) => revision.terminal?.status === "rejected").at(-1)
}

/**
 * Map a non-integrated PR to its display-only pre-run timeline status, or
 * undefined when the PR is terminal by intent (integrated/withdrawn/canceled) or
 * is surfaced through a run row instead (a `rejected` PR keeps its terminal run
 * row until the author re-pushes it). `rev` is a `draft` (bay status
 * `pushed`) that carries failed-submission history — the user's "a failed
 * submission returns the PR to an editable state" — and stores no new PRStatus.
 */
function preRunTimelineStatus(pr: PR): "draft" | "rev" | "ready" | undefined {
  if (pr.status === "submitted") return "ready"
  if (pr.status === "pushed") return lastFailedSubmission(pr) === undefined ? "draft" : "rev"
  return undefined
}

/** `rev · <slug>` annotated with the code of the most recent failed
 * submission when that run is still retained; bare `rev` otherwise. */
function revisionDetail(pr: PR, runs: readonly QueueRun[]): string {
  const runId = lastFailedSubmission(pr)?.terminal?.run
  const run = runId === undefined ? undefined : runs.find((candidate) => candidate.id === runId)
  const code = run === undefined ? undefined : failureFact(run, relevantStep(run))?.code
  return code === undefined ? "rev" : `rev · ${failureSlug(code)}`
}

/**
 * One row per non-integrated PR that is not currently a run member, each carrying
 * a derived, display-only status (`preRunTimelineStatus`): `draft`/`rev` for
 * a registered-but-unsubmitted PR (bay status `pushed`) and `ready` for one
 * awaiting its run. These never distort queue mechanics — the `draft` group
 * (draft + rev) is excluded from every terminal FLOW fact and the
 * `oldestOpenMs` DRAIN gauge, while `ready` keeps the pending group's
 * queue-wait accounting it always had. `draft`/`rev` anchor AGE and the TIME
 * cell on the current revision's registration (`pushedAt`); `ready` keeps its
 * submission clock. BY is the current revision's author throughout.
 */
function timelineNonIntegratedRows(
  result: QueueStatusResult,
  nowIso: string,
  submissionTimes: ReadonlyMap<string, string | null>,
  state: BaysState | undefined,
): QueueTimelineProjectedRow[] {
  const activeRevisions = new Set(
    [...result.running, ...result.waiting].flatMap((run) => run.prs.map((member) => queueRevisionKey(member))),
  )
  const positions = submittedPrPositions(result.prs)
  const runs = [...result.running, ...result.waiting, ...result.finished]
  return result.prs.flatMap((pr): QueueTimelineProjectedRow[] => {
    const status = preRunTimelineStatus(pr)
    if (status === undefined) return []
    // A submitted revision that is actively running/waiting is shown by its run row.
    if (status === "ready" && activeRevisions.has(queueRevisionKey(pr))) return []

    const bayPath = pr.bay === undefined ? undefined : state?.byId[pr.bay]?.path
    const revisionLineage = [timelineRevisionLineage(pr)]
    const submitter = revisionSubmitter(pr)
    const issue = presentFact(pr.issue)
    const subject = boundedQueue(bayPath ?? pr.title ?? pr.name ?? pr.branch, 80)

    if (status === "ready") {
      const timestamp = submissionTimes.get(queueRevisionKey(pr)) ?? pr.submittedAt ?? null
      const position = positions.get(pr.id)
      const sourceReadyAt = revisionLineage[0]?.sourceReadyAt ?? timestamp ?? undefined
      const detail = withTimelineLineage(position === undefined ? "ready" : `position ${position}`, revisionLineage)
      return [
        {
          id: `${pr.base}:pr:${pr.id}:${pr.revision}:${pr.headSha}`,
          base: pr.base,
          group: "pending" as const,
          status,
          glyph: statusGlyph(status),
          timestamp,
          timestampMs: parsedTimelineTimestamp(timestamp ?? undefined, `PR '${pr.id}' submission`),
          pr: pr.id,
          revision: pr.revision,
          headSha: pr.headSha,
          branch: pr.branch,
          ...(issue === undefined ? {} : { issue }),
          subject,
          ...(submitter === undefined ? {} : { submitter }),
          detail,
          ...(position === undefined ? {} : { position }),
          ...(sourceReadyAt === undefined ? {} : { sourceReadyAt }),
          revisionLineage,
          ageMs: timelineAge(sourceReadyAt, nowIso, `PR '${pr.id}' source-ready age`),
          totalMs: null,
          activeMs: null,
          waitMs: timelineAge(timestamp ?? undefined, nowIso, `PR '${pr.id}' queue wait`),
          queueWaitMs: timelineAge(timestamp ?? undefined, nowIso, `PR '${pr.id}' queue wait`),
        },
      ]
    }

    // draft | rev — pushed, pre-queue WIP anchored on registration (pushedAt).
    const registeredAt = pr.revisions.find(
      (candidate) => candidate.revision === pr.revision && candidate.headSha === pr.headSha,
    )?.pushedAt
    const detail = status === "rev" ? revisionDetail(pr, runs) : "draft"
    return [
      {
        id: `${pr.base}:draft:${pr.id}:${pr.revision}:${pr.headSha}`,
        base: pr.base,
        group: "draft" as const,
        status,
        glyph: statusGlyph(status),
        timestamp: registeredAt ?? null,
        timestampMs: parsedTimelineTimestamp(registeredAt, `PR '${pr.id}' ${status} registration`),
        pr: pr.id,
        revision: pr.revision,
        headSha: pr.headSha,
        branch: pr.branch,
        ...(issue === undefined ? {} : { issue }),
        subject,
        ...(submitter === undefined ? {} : { submitter }),
        detail: withTimelineLineage(detail, revisionLineage),
        ...(registeredAt === undefined ? {} : { sourceReadyAt: registeredAt }),
        revisionLineage,
        ageMs: timelineAge(registeredAt, nowIso, `PR '${pr.id}' ${status} age`),
        totalMs: null,
        activeMs: null,
        waitMs: null,
        queueWaitMs: null,
      },
    ]
  })
}

function timelineSort(left: QueueTimelineProjectedRow, right: QueueTimelineProjectedRow): number {
  // Round 6: date headers describe contiguous calendar-day groups. Grouping by
  // status before time could interleave days across midnight (07-18 / 07-19 /
  // 07-18), so calendar day is the outer ordering key. Within one day the
  // queue's status/position ordering remains unchanged.
  if (left.timestamp !== null && right.timestamp !== null) {
    const leftDay = timelineLocalCalendarDay(left.timestamp)
    const rightDay = timelineLocalCalendarDay(right.timestamp)
    if (leftDay !== rightDay) return rightDay.localeCompare(leftDay)
  }
  const groupOrder: Record<QueueTimelineGroup, number> = { draft: 0, pending: 1, running: 2, completed: 3 }
  const group = groupOrder[left.group] - groupOrder[right.group]
  if (group !== 0) return group
  if (left.group === "pending" && right.group === "pending") {
    const position = (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER)
    if (position !== 0) return position
  }
  const leftAt = left.timestampMs ?? Number.NEGATIVE_INFINITY
  const rightAt = right.timestampMs ?? Number.NEGATIVE_INFINITY
  if (leftAt !== rightAt) return left.group === "completed" ? rightAt - leftAt : leftAt - rightAt
  return left.id.localeCompare(right.id, undefined, { numeric: true })
}

function timelineMatches(row: QueueTimelineProjectedRow, terms: readonly string[]): boolean {
  if (terms.length === 0) return true
  const searchable = [row.run ?? "", row.pr, row.branch, row.subject, row.failure?.code ?? ""]
    .join("\n")
    .toLocaleLowerCase()
  return terms.some((term) => searchable.includes(term))
}

function latestTimelineRows(rows: readonly QueueTimelineProjectedRow[]): QueueTimelineProjectedRow[] {
  const latestByPr = new Map<string, QueueTimelineProjectedRow>()
  for (const row of rows) {
    const current = latestByPr.get(row.pr)
    const currentAt = current?.timestampMs ?? Number.NEGATIVE_INFINITY
    const nextAt = row.timestampMs ?? Number.NEGATIVE_INFINITY
    if (current === undefined || nextAt > currentAt || (nextAt === currentAt && row.id > current.id)) {
      latestByPr.set(row.pr, row)
    }
  }
  return rows.filter((row) => latestByPr.get(row.pr)?.id === row.id)
}

export function queueTimelineAdmissionTimes(results: readonly QueueStatusResult[]): Map<string, string | null> {
  const submissionTimes = new Map<string, string | null>()
  for (const result of results) {
    const byId = new Map(result.prs.map((pr) => [pr.id, pr]))
    for (const pr of result.prs) {
      for (const revision of pr.revisions ?? []) {
        if (revision.submittedAt !== undefined) {
          submissionTimes.set(queueRevisionKey({ ...revision, id: pr.id }), revision.submittedAt)
        }
      }
      const current = pr.revisions?.find(
        (revision) => revision.revision === pr.revision && revision.headSha === pr.headSha,
      )
      const submittedAt = current?.submittedAt ?? pr.submittedAt
      if (submittedAt !== undefined) submissionTimes.set(queueRevisionKey(pr), submittedAt)
    }
    for (const run of [...result.running, ...result.waiting, ...result.finished]) {
      for (const member of run.prs) {
        const pr = byId.get(member.id)
        if (pr === undefined) throw new Error(`yrd: run '${run.id}' has no retained PR '${member.id}'`)
        const runKey = queueRunRevisionKey(run, member)
        if ((pr.revisions?.length ?? 0) > 0) {
          const clock = runRevisionClock(pr, run)
          submissionTimes.set(runKey, clock.admittedBy === "submission" ? clock.submittedAt : null)
          continue
        }
        const submittedAt = pr.submittedAt
        submissionTimes.set(
          runKey,
          submittedAt !== undefined &&
            timestamp(submittedAt, `PR '${pr.id}' submission`) <= timestamp(run.startedAt, `run '${run.id}' start`)
            ? submittedAt
            : null,
        )
      }
    }
  }
  return submissionTimes
}

/**
 * Fold projected rows into one terminal fact per completed Run. Member rows of
 * one batched Run collapse to a single fact that carries every visible member's
 * queue wait. Pass the window-filtered rows for the single-window `metrics`, or
 * the raw rows for the windowed time-stats fact set.
 */
function foldTerminalFacts(rows: readonly QueueTimelineProjectedRow[]): QueueTerminalFact[] {
  const byRun = new Map<string, QueueTerminalFact>()
  for (const row of rows) {
    if (row.group !== "completed" || row.timestampMs === null || row.run === undefined) continue
    const key = `${row.base}:${row.run}`
    const fact = byRun.get(key)
    const waits = row.queueWaitMs === null ? [] : [row.queueWaitMs]
    if (fact === undefined) {
      byRun.set(key, {
        run: row.run,
        terminalAtMs: row.timestampMs,
        outcome: terminalOutcome(row.status),
        activeMs: row.totalMs,
        queueWaitMs: waits,
      })
      continue
    }
    byRun.set(key, { ...fact, queueWaitMs: [...fact.queueWaitMs, ...waits] })
  }
  return [...byRun.values()]
}

export function queueTimelineProjection(
  results: readonly QueueStatusResult[],
  options: QueueTimelineProjectionOptions,
): QueueTimelineProjection {
  if (!Number.isFinite(options.now) || options.now < 0) throw new TypeError("yrd: timeline snapshot time is invalid")
  if (!Number.isFinite(options.windowMs) || options.windowMs < 0) {
    throw new TypeError("yrd: timeline window is invalid")
  }
  if (
    options.metricsWindowMs !== undefined &&
    (!Number.isFinite(options.metricsWindowMs) || options.metricsWindowMs < 0)
  ) {
    throw new TypeError("yrd: timeline metrics window is invalid")
  }
  if (!Number.isFinite(options.rowLimit) || options.rowLimit < 0) {
    throw new TypeError("yrd: timeline row limit is invalid")
  }
  const metricsWindowMs = options.metricsWindowMs ?? options.windowMs
  const nowIso = new Date(options.now).toISOString()
  const sinceMs = options.now - options.windowMs
  const since = new Date(sinceMs).toISOString()
  const requestedStatuses = options.statuses.length === 0 ? TIMELINE_STATUS_ORDER : options.statuses
  const statuses = TIMELINE_STATUS_ORDER.filter((status) => requestedStatuses.includes(status))
  const selectedStatuses = new Set(statuses)
  const terms = [...new Set(options.terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean))]
  const rawRows = results.flatMap((result) => [
    ...timelineNonIntegratedRows(result, nowIso, options.submissionTimes, options.state),
    ...[...result.running, ...result.waiting, ...result.finished].flatMap((run) =>
      timelineRunMemberRows(result, run, nowIso, options.submissionTimes, options.state, options.attempts ?? []),
    ),
  ])
  // Status + window + term filtering, then the optional latest-per-PR fold.
  // Shared by the display window and the (possibly wider) metrics window so
  // both apply identical criteria and only the window bound differs.
  const selectRows = (windowStartMs: number): QueueTimelineProjectedRow[] => {
    const filtered = rawRows
      .filter((row) => selectedStatuses.has(timelineStatusFilter(row.status)))
      .filter((row) => row.timestampMs === null || (row.timestampMs >= windowStartMs && row.timestampMs <= options.now))
      .filter((row) => timelineMatches(row, terms))
    return options.latest ? latestTimelineRows(filtered) : filtered
  }
  const displayed = selectRows(sinceMs)
  const rows = displayed.toSorted(timelineSort)
  // Terminal facts drive the flow aggregate over the metrics window, which may
  // reach further back than the listing window; reuse the display set when the
  // windows coincide.
  const metricsRows = metricsWindowMs === options.windowMs ? displayed : selectRows(options.now - metricsWindowMs)
  // Metrics stay per-Run: member rows of one batched Run fold into one terminal
  // fact carrying every visible member's queue wait.
  const terminalFacts = foldTerminalFacts(metricsRows)
  // The windowed FLOW/TIME boxes read their own rolling windows (hour/day/week/
  // month) off the SAME consolidated queueFlowMetrics aggregate. It folds the
  // FULL retained fact horizon (rawRows, before any window bound), NOT the
  // display `windowMs` listing nor the 24h `metricsWindowMs` default — so WK/MON
  // read seven/thirty days of Runs and never inherit the 24h metrics window. The
  // per-box span lives in time-stats.ts; `earliestEventMs` gates each with "-"
  // until history reaches back a full window. Unfiltered by the operator's view
  // so a health readout never hides failures behind a status/term filter.
  const timeStatsFacts = foldTerminalFacts(rawRows)
  // The journal's data horizon: the oldest timestamped record we hold. A rolling
  // window renders `-` until the horizon reaches back a full span.
  const earliestEventMs = rawRows.reduce<number | null>(
    (earliest, row) =>
      row.timestampMs === null ? earliest : earliest === null ? row.timestampMs : Math.min(earliest, row.timestampMs),
    null,
  )
  const allRuns = results.flatMap((result) => [...result.running, ...result.waiting, ...result.finished])
  const finished = results.flatMap((result) => result.finished)
  const detailRuns = new Set<string>()
  const details = rows.flatMap((row) => {
    if (row.run === undefined || detailRuns.has(`${row.base}:${row.run}`)) return []
    detailRuns.add(`${row.base}:${row.run}`)
    const run = allRuns.find((candidate) => candidate.id === row.run && candidate.base === row.base)
    return run === undefined ? [] : [queueShowData(run, finished, options.attempts ?? [])]
  })
  const limit = Math.max(1, Math.floor(options.rowLimit))
  const retainedSince =
    options.retainedSinceMs === undefined ? undefined : new Date(options.retainedSinceMs).toISOString()
  const base = options.base ?? results[0]?.base ?? "main"
  const pause = results.find((result) => result.base === base)?.pause
  const oldestOpenMs = rows
    .filter((row) => row.group === "pending")
    .reduce<number | null>((oldest, row) => {
      if (row.ageMs === null) return oldest
      return oldest === null ? row.ageMs : Math.max(oldest, row.ageMs)
    }, null)
  return {
    now: nowIso,
    base,
    siblingBases: [...new Set(options.siblingBases ?? [])].filter((candidate) => candidate !== base).toSorted(),
    runner: options.runner ?? null,
    ...(pause === undefined ? {} : { pause }),
    oldestOpenMs,
    filters: { windowMs: options.windowMs, since, statuses, terms, latest: options.latest },
    coverage: {
      requestedSince: since,
      ...(retainedSince === undefined ? {} : { retainedSince }),
      // An unbounded window shows every retained row, so coverage is complete
      // by definition (the `now - window` cutoff would otherwise read as older
      // than any retained record and falsely trip the incompleteness warning).
      complete:
        options.windowMs >= QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS ||
        options.retainedSinceMs === undefined ||
        options.retainedSinceMs <= sinceMs,
    },
    display: { limit, shown: Math.min(rows.length, limit), hidden: Math.max(0, rows.length - limit) },
    rows,
    details,
    metrics: queueFlowMetrics(terminalFacts, { now: options.now, windowMs: metricsWindowMs, oldestOpenMs }),
    timeStatsFacts,
    earliestEventMs,
  }
}

function failureEvidence(step: QueueStep | undefined): HumanFailureProjection["evidence"] {
  const location = stepLocations(step)[0]?.location
  if (location === undefined) return undefined
  return "path" in location
    ? { text: location.path, href: pathToFileURL(location.path).href }
    : { text: location.url, href: location.url }
}

function projectPR(
  state: BaysState | undefined,
  result: QueueSummary,
  pr: PR,
  now: number,
  runOverride?: QueueRun,
): HumanPRProjection {
  const run = runOverride ?? latestRun(pr, result)
  const step = relevantStep(run)
  const job = step?.job
  const path = pr.bay === undefined ? undefined : state?.byId[pr.bay]?.path
  const revisionClocks = prRevisionClocks(pr)
  const revision =
    run === undefined
      ? revisionClocks.find((candidate) => candidate.revision === pr.revision && candidate.headSha === pr.headSha)
      : runRevisionClock(pr, run)
  const isCurrentRevision =
    revision === undefined || (revision.revision === pr.revision && revision.headSha === pr.headSha)
  const submittedAt = revision?.submittedAt ?? (run === undefined && isCurrentRevision ? pr.submittedAt : undefined)
  const projectedRevision = revision?.revision ?? pr.revision
  const lineage = timelineRevisionLineage(pr, projectedRevision)
  const sourceReadyAt = lineage.sourceReadyAt
  const revisionLineage = lineage.revisions
  const touchedAt = latest(
    ...(runOverride === undefined
      ? [revision?.pushedAt, submittedAt, revision?.terminal?.at, pr.rejectedAt, pr.integratedAt, pr.withdrawnAt]
      : []),
    run?.startedAt,
    run?.finishedAt,
    ...(run?.steps ?? []).flatMap((item) => {
      const itemJob = item.job
      return itemJob === undefined
        ? []
        : [
            itemJob.requestedAt,
            itemJob.changedAt,
            "startedAt" in itemJob ? itemJob.startedAt : undefined,
            "finishedAt" in itemJob ? itemJob.finishedAt : undefined,
          ]
    }),
  )
  const runDurationMs =
    run === undefined
      ? undefined
      : elapsedMs(run.startedAt, run.finishedAt ?? new Date(now).toISOString(), `run '${run.id}' duration`)
  const runDuration = runDurationMs === undefined ? "-" : formatDuration(runDurationMs)
  const artifacts = stepArtifacts(step)
  const artifact = artifactHref(artifacts[0])
  const stateLabel = queueState(pr, run)
  const taskStatus = prTaskStatusOf(pr)
  const fact = failureFact(run, step)
  const evidence = failureEvidence(step)
  const terminalAt =
    revision?.terminal?.at ??
    runOverride?.finishedAt ??
    (isCurrentRevision
      ? pr.status === "rejected"
        ? pr.rejectedAt
        : pr.status === "integrated"
          ? pr.integratedAt
          : pr.status === "withdrawn"
            ? pr.withdrawnAt
            : undefined
      : undefined)
  const parsedTerminalAt = terminalAt === undefined ? Number.NaN : Date.parse(terminalAt)
  const ageAt = Number.isFinite(parsedTerminalAt) ? parsedTerminalAt : now
  const failure = fact === undefined || run === undefined ? undefined : projectFailure(fact, evidence)
  return {
    pr: pr.id,
    revision: projectedRevision,
    ...(path === undefined ? {} : { prHref: pathToFileURL(path).href, path }),
    branch: pr.branch,
    subject: boundedQueue(pr.title ?? pr.name ?? pr.branch, 80),
    nativeStatus: pr.status,
    state: stateLabel,
    ...taskStatusFields(taskStatus),
    ...(run === undefined ? {} : { runId: run.id }),
    ...(submittedAt === undefined ? {} : { submittedAt }),
    ...(sourceReadyAt === undefined ? {} : { sourceReadyAt }),
    revisionLineage,
    target: pr.base,
    age: age(sourceReadyAt ?? submittedAt ?? revision?.pushedAt, ageAt, `PR '${pr.id}' source-ready age`),
    touched: age(touchedAt, now, `PR '${pr.id}' touched age`),
    ...(touchedAt === undefined ? {} : { touchedAt }),
    run: runDuration,
    step: step?.name ?? "-",
    result:
      failure?.summary ??
      (job !== undefined && "detail" in job && typeof job.detail === "string" ? boundedQueue(job.detail) : undefined) ??
      (step === undefined ? "-" : jobStatus(step)),
    ...(job !== undefined && "url" in job && job.url !== undefined ? { log: job.url } : {}),
    artifactCount: artifacts.length,
    ...(artifact === undefined ? {} : { artifact }),
    ...(failure === undefined ? {} : { failure }),
  }
}

function projectedPRRows(state: BaysState | undefined, result: QueueStatusResult, now: number): HumanPRProjection[] {
  return result.prs.map((pr) => projectPR(state, result, pr, now))
}

function byTouchedNewest(left: HumanPRProjection, right: HumanPRProjection): number {
  const order = (right.touchedAt ?? "").localeCompare(left.touchedAt ?? "")
  return order === 0 ? left.pr.localeCompare(right.pr, undefined, { numeric: true }) : order
}

function requiredQueuePosition(positions: ReadonlyMap<string, number>, pr: string): number {
  const position = positions.get(pr)
  if (position === undefined) throw new Error(`yrd: submitted PR '${pr}' is missing its queue position`)
  return position
}

export function humanQueueProjection(
  result: QueueStatusResult,
  now: number,
  options: Readonly<{
    selected?: ReadonlySet<string>
    state?: BaysState
    positions?: ReadonlyMap<string, number>
  }> = {},
): HumanQueueProjection {
  const selected = options.selected ?? new Set<string>()
  const rows = projectedPRRows(options.state, result, now)
  const positions = options.positions ?? submittedPrPositions(result.prs)
  const queueRows = rows
    .filter((row) => row.nativeStatus === "submitted")
    .toSorted((left, right) => requiredQueuePosition(positions, left.pr) - requiredQueuePosition(positions, right.pr))
  const historical = result.finished.flatMap((run) =>
    run.prs.flatMap((member) => {
      const pr = result.prs.find((candidate) => candidate.id === member.id)
      if (pr === undefined) return []
      if (selected.size === 0 && (pr.status !== "rejected" || run.status !== "failed")) return []
      if (selected.size > 0 && (!selected.has(pr.id) || pr.status === "submitted")) return []
      return [projectPR(options.state, result, pr, now, run)]
    }),
  )
  const represented = new Set(historical.map((row) => row.pr))
  const recentCandidates = [
    ...historical,
    ...rows.filter((row) => {
      if (represented.has(row.pr)) return false
      return selected.size === 0
        ? row.nativeStatus === "rejected"
        : selected.has(row.pr) && row.nativeStatus !== "submitted"
    }),
  ]
  const queue = queueRows
    .slice(0, QUEUE_ROW_LIMIT)
    .map((row) => ({ ...row, position: requiredQueuePosition(positions, row.pr) }))
  const active = activeWatchRow(result, now, selected)
  return {
    target: `${result.base}${result.headSha === undefined ? "" : `@${result.headSha.slice(0, 12)}`}`,
    open: queueRows.length,
    activeCount: queueRows.filter((row) => ["checking", "waiting"].includes(row.state)).length,
    integrated: rows.filter((row) => row.nativeStatus === "integrated").length,
    rejected: rows.filter((row) => row.nativeStatus === "rejected").length,
    ...(result.pause === undefined ? {} : { pause: result.pause }),
    ...(active === undefined ? {} : { active }),
    oldestOpen: queueRows[0]?.age ?? "-",
    queue,
    queueOverflow: Math.max(0, queueRows.length - queue.length),
    recent: recentCandidates.toSorted(byTouchedNewest).slice(0, RECENT_ROW_LIMIT),
  }
}

export function QueueRunsView({ runs }: { runs: readonly QueueRun[] }) {
  if (runs.length === 0) return <Text color="$fg-muted">Queue idle.</Text>
  const data = runs.map((run) => {
    const taskStatus = runTaskStatusOf(run)
    return {
      run: run.id,
      prs: run.prs.map((pr) => pr.id).join(","),
      state: run.status,
      ...taskStatusFields(taskStatus),
      steps: boundedQueue(queueRunSteps(run)),
    }
  })
  return (
    <Table
      data={data}
      columns={[
        { header: "RUN", key: "run" },
        { header: "PRS", key: "prs" },
        {
          header: "STATE",
          key: "state",
          minWidth: 12,
          render: (row) => <TaskStatusValue taskStatus={row.taskStatus} glyph={row.glyph} value={row.state} />,
        },
        { header: "STEPS", key: "steps", grow: true },
      ]}
    />
  )
}

function queueRunSteps(run: QueueRun): string {
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

export type PRListRow = Readonly<{
  pr: string
  state: string
  stateLabel: string
  glyph: string
  revision: number
  lineage: string
  subject: string
  submitter: string
  target: string
  review: "n/a" | "need" | "ok" | "reject"
  checks: "n/a" | "wait" | "run" | "pass" | "fail"
  why: string
  age: string
  touched: string
}>

const checkLabels = {
  "not-requested": "n/a",
  queued: "wait",
  checking: "run",
  passed: "pass",
  failed: "fail",
} as const satisfies Record<PREligibility["checks"]["status"], PRListRow["checks"]>

function reviewLabel(eligibility: PREligibility): PRListRow["review"] {
  if (!eligibility.review.required) return "n/a"
  if (eligibility.review.decision === "reject") return "reject"
  return eligibility.review.approved && !eligibility.review.stale ? "ok" : "need"
}

export function prListRows(
  entries: readonly Readonly<{ pr: PR; eligibility: PREligibility }>[],
  runs: readonly QueueRun[],
  now: number,
): PRListRow[] {
  const summary: QueueSummary = {
    base: "*",
    running: runs.filter((run) => run.status === "running"),
    waiting: runs.filter((run) => run.status === "waiting"),
    finished: runs.filter((run) => run.status === "passed" || run.status === "failed"),
  }
  return entries.map(({ pr, eligibility }) => {
    if (eligibility.pr !== pr.id || eligibility.revision !== pr.revision) {
      throw new Error(
        `yrd: PR '${pr.id}' revision ${pr.revision} has mismatched eligibility for '${eligibility.pr}' revision ${eligibility.revision}`,
      )
    }
    if (!eligibility.runnable && eligibility.reason === undefined) {
      throw new Error(`yrd: PR '${pr.id}' revision ${pr.revision} is ineligible without a typed blocking reason`)
    }
    const projected = projectPR(undefined, summary, pr, now)
    return {
      pr: projected.pr,
      state: projected.state,
      stateLabel: `${projected.glyph} ${projected.state}`,
      glyph: projected.glyph,
      revision: pr.revision,
      lineage: projected.revisionLineage.join("→"),
      subject: projected.subject,
      submitter: revisionSubmitter(pr) ?? "-",
      target: projected.target,
      review: reviewLabel(eligibility),
      checks: checkLabels[eligibility.checks.status],
      why: eligibility.reason?.code ?? "-",
      age: projected.age,
      touched: projected.touched,
    }
  })
}

function PRStateValue({ row }: { row: PRListRow }) {
  const variant = statusVariant(row.state)
  return (
    <Text bold color={variant === "default" ? "$fg" : `$fg-${variant}`}>
      {row.stateLabel}
    </Text>
  )
}

export function PRListView({ rows, columns: terminalColumns }: { rows: readonly PRListRow[]; columns: number }) {
  const base: TableColumn<PRListRow> = { header: "BASE", key: "target", minWidth: 6, maxWidth: 14 }
  const submitter: TableColumn<PRListRow> = { header: "BY", key: "submitter", minWidth: 4, maxWidth: 10 }
  const ageColumn: TableColumn<PRListRow> = { header: "AGE", key: "age", minWidth: 5, maxWidth: 7 }
  const changed: TableColumn<PRListRow> = { header: "CHANGED", key: "touched", minWidth: 9, maxWidth: 9 }
  const prWidth = Math.min(
    16,
    rows.reduce((width, row) => Math.max(width, formatQueuePrId(row.pr, row.revision).length + 2), 8),
  )
  const columns: TableColumn<PRListRow>[] = [
    {
      header: "PR",
      key: "pr",
      minWidth: prWidth,
      maxWidth: 16,
      render: (row: PRListRow) => <QueuePrId pr={row.pr} revision={row.revision} wrap="truncate" />,
    },
    {
      header: "STATE",
      key: "stateLabel",
      minWidth: 15,
      maxWidth: 16,
      render: (row: PRListRow) => <PRStateValue row={row} />,
    },
    { header: "LINEAGE", key: "lineage", minWidth: 8, maxWidth: 10 },
    ...(terminalColumns >= 110 ? [submitter] : []),
    { header: "SUBJECT", key: "subject", minWidth: 9, maxWidth: 26, grow: true },
    ...(terminalColumns >= 100 ? [base] : []),
    { header: "REVIEW", key: "review", minWidth: 8, maxWidth: 8 },
    { header: "CHECKS", key: "checks", minWidth: 8, maxWidth: 8 },
    { header: "WHY", key: "why", minWidth: 5, maxWidth: 18, grow: true },
    ...(terminalColumns >= 110 ? [ageColumn] : []),
    ...(terminalColumns >= 120 ? [changed] : []),
  ]
  return <Table data={rows} columns={columns} />
}

export type PRCheckViewRecord = PRCheckRecord

function explicitArtifactHref(artifact: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(artifact) ? artifact : pathToFileURL(resolve(artifact)).href
}

function checkDiagnosticText(value: unknown): string {
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

export function PRChecksView({ records, now = Date.now() }: { records: readonly PRCheckViewRecord[]; now?: number }) {
  const data = records.map((record) => {
    const taskStatus = checkTaskStatusOf(record)
    return {
      pr: record.pr,
      revision: record.revision,
      check: record.step ?? (record.position === undefined ? "-" : `queue #${record.position}`),
      state: record.status,
      ...taskStatusFields(taskStatus),
      classification: record.classification ?? "-",
      age:
        record.queuedAt === undefined || !Number.isFinite(Date.parse(record.queuedAt))
          ? "-"
          : formatDuration(Math.max(0, now - Date.parse(record.queuedAt))),
      command: singleQueue(record.command?.join(" ") ?? "-"),
      diagnostic: checkDiagnosticText(record.diagnostics ?? record.error?.message),
      artifact: record.artifact,
    }
  })
  return (
    <Box flexDirection="column">
      <Table
        data={data}
        columns={[
          { header: "PR", key: "pr", render: (row) => <QueuePrId pr={row.pr} revision={row.revision} /> },
          { header: "CHECK", key: "check" },
          {
            header: "STATE",
            key: "state",
            render: (row) => <TaskStatusValue taskStatus={row.taskStatus} glyph={row.glyph} value={row.state} />,
          },
          { header: "CLASS", key: "classification" },
          { header: "AGE", key: "age" },
          { header: "COMMAND", key: "command", maxWidth: 40 },
          { header: "DIAGNOSTIC", key: "diagnostic", minWidth: 24, grow: true },
          {
            header: "ARTIFACT",
            key: "artifact",
            maxWidth: 40,
            render: (row) =>
              row.artifact === undefined ? (
                <Text>-</Text>
              ) : (
                <CellLink href={explicitArtifactHref(row.artifact)}>{row.artifact}</CellLink>
              ),
          },
        ]}
      />
      {data
        .filter((row) => row.state === "failed")
        .map((row) => (
          <Text key={`${row.pr}:${row.revision}:${row.check}`}>
            {`FAIL ${formatQueuePrId(row.pr, row.revision)} ${row.check} COMMAND ${row.command} DIAGNOSTIC ${row.diagnostic}${row.artifact === undefined ? "" : ` ARTIFACT ${row.artifact}`}`}
          </Text>
        ))}
    </Box>
  )
}

export function PRResultView({
  prs,
  runs,
  checks,
  now,
}: {
  prs: readonly PR[]
  runs: readonly QueueRun[]
  checks?: readonly PRCheckViewRecord[]
  now?: number
}) {
  return (
    <Box flexDirection="column">
      <PRStatusView prs={prs} />
      {checks === undefined && runs.length > 0 && (
        <Box marginTop={1}>
          <QueueRunsView runs={runs} />
        </Box>
      )}
      {checks !== undefined && (
        <Box marginTop={1}>
          <PRChecksView records={checks} now={now} />
        </Box>
      )}
    </Box>
  )
}

function latestPRRun(pr: PR, runs: readonly QueueRun[]): QueueRun | undefined {
  return runs
    .filter((run) => run.prs.some((member) => member.id === pr.id))
    .toSorted(byRunStarted)
    .at(-1)
}

export type PRDetailData = Readonly<{
  pr: PR
  runs: readonly QueueShowData[]
  run?: QueueShowData
}>

export function prDetailData(pr: PR, runs: readonly QueueRun[], attempts: readonly QueueAttempt[] = []): PRDetailData {
  const matchingRuns = runs.filter((run) => run.prs.some((member) => member.id === pr.id))
  const details = matchingRuns.map((run) => queueShowData(run, matchingRuns, attempts))
  const latest = latestPRRun(pr, matchingRuns)
  const run = latest === undefined ? undefined : details.find((detail) => detail.run === latest.id)
  return { pr, runs: details, ...(run === undefined ? {} : { run }) }
}

function diagnosticBlocker(
  pr: PR,
  run: QueueRun | undefined,
  step: QueueStep | undefined,
  now: number,
): string | undefined {
  const job = step?.job
  if (job?.status === "failed") return actionableFailureSummary(actionableFailure(job.error))
  if (job?.status === "lost") {
    return actionableFailureSummary(actionableFailure({ code: "job-lost", message: job.lostReason }))
  }
  if (job?.status === "canceled") {
    return actionableFailureSummary(actionableFailure({ code: "job-canceled", message: job.cancelReason }))
  }
  if (job?.status === "running") {
    const leaseExpiresAt = Date.parse(job.leaseExpiresAt)
    if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= now) {
      return actionableFailureSummary(
        actionableFailure({
          code: "job-lease-expired",
          message: `${job.leaseExpiresAt} (${formatDuration(now - leaseExpiresAt)} ago)`,
        }),
      )
    }
  }
  if (job?.status === "waiting") return `waiting: ${singleQueue(job.detail ?? job.url ?? job.token)}`
  if (run?.error !== undefined) return actionableFailureSummary(actionableFailure(run.error))
  if (pr.detail !== undefined) return singleQueue(pr.detail)
  return undefined
}

export function PRDetailView({
  pr,
  runs,
  attempts = [],
  now,
  position,
}: {
  pr: PR
  runs: readonly QueueRun[]
  attempts?: readonly QueueAttempt[]
  now: number
  position?: number
}) {
  const run = latestPRRun(pr, runs)
  const runMember = run?.prs.find((member) => member.id === pr.id)
  // The newest run for this PR may have executed against a now-superseded
  // revision (e.g. rev 1 was rejected while rev 2 sits pending with no run of
  // its own). Presenting that historical run as the PR's current state reads as
  // "this pending item already failed", so it is scoped to a history block and
  // the current revision's real state is stated above it (user-reported
  // 2026-07-16). A superseded run implies the current revision has no run yet:
  // any run against it would sort newer and be selected here instead.
  const supersededRunRevision =
    run !== undefined && runMember !== undefined && runMember.revision !== pr.revision ? runMember.revision : undefined
  const currentStateWord = pr.status === "submitted" ? "pending" : pr.status
  const activeStep = relevantStep(run)
  const blocker = diagnosticBlocker(pr, run, activeStep, now)
  const landing = pr.integration ?? (run === undefined ? undefined : queueIntegration(run))
  const detail = prDetailData(pr, runs, attempts)
  const lineage = timelineRevisionLineage(pr)
  const revisionLineage = lineage.revisions.map((revision) => `rev${revision}`).join("→")
  const taskStatus = prTaskStatusOf(pr)
  const projectionFields = taskStatusFields(taskStatus)

  return (
    <Box flexDirection="column">
      <Text>
        <QueuePrId pr={pr.id} revision={pr.revision} /> <Text bold>STATUS</Text> <StatusValue value={pr.status} />{" "}
        <TaskStatusGlyph taskStatus={projectionFields.taskStatus} glyph={projectionFields.glyph} />
        {position === undefined ? null : ` POSITION ${position}`}
      </Text>
      {pr.title === undefined ? null : (
        <Text wrap="truncate" bgConflict="ignore">
          <Text bold>TITLE</Text> {pr.title}
        </Text>
      )}
      <Text>
        <Text bold>SOURCE</Text> <Text color={BRANCH_ICON_COLOR}>{BRANCH_ICON}</Text> {pr.branch} <Text bold>HEAD</Text>{" "}
        {pr.headSha}
      </Text>
      <Text>
        <Text bold>BASE</Text> {pr.base}
        {pr.baseSha === undefined ? null : `@${pr.baseSha}`}
      </Text>
      {pr.issue === undefined ? null : (
        <Text wrap="truncate">
          <Text bold>ISSUE</Text> <IssueValue issue={pr.issue} />
        </Text>
      )}
      <Text>
        <Text bold>SOURCE READY</Text> {lineage.sourceReadyAt ?? "-"} <Text bold>LINEAGE</Text> {revisionLineage}
      </Text>
      {pr.description === undefined ? null : (
        <Box flexDirection="column" minWidth={0}>
          <Text bold>DESCRIPTION</Text>
          <DescriptionBlock description={pr.description} />
        </Box>
      )}
      {supersededRunRevision === undefined ? null : (
        <Text>
          <Text bold>CURRENT rev {pr.revision}</Text> — {currentStateWord}, no run yet
        </Text>
      )}
      {detail.run === undefined ? null : (
        <QueueShowView
          data={detail.run}
          compact
          highlightPr={pr.id}
          {...(supersededRunRevision === undefined ? {} : { historyRevision: supersededRunRevision })}
        />
      )}
      {blocker === undefined ? null : (
        <Text color={supersededRunRevision === undefined ? "$fg-warning" : "$fg-muted"}>
          <Text bold>BLOCKER</Text>
          {supersededRunRevision === undefined ? "" : ` (rev ${supersededRunRevision})`} {blocker}
        </Text>
      )}
      {detail.run === undefined && landing !== undefined ? (
        <Text>
          <Text bold>LANDING</Text>{" "}
          {landing.commit === landing.baseSha ? landing.commit : `${landing.commit}@${landing.baseSha}`}
        </Text>
      ) : null}
    </Box>
  )
}

export function queueStatusRows(
  state: BaysState,
  result: QueueStatusResult,
  selected: ReadonlySet<string>,
  now: number,
): Row[] {
  return projectedPRRows(state, result, now).filter(
    (row) => selected.has(row.pr) || (row.nativeStatus !== "integrated" && row.nativeStatus !== "withdrawn"),
  )
}

function SummaryQueue({ projection }: { projection: HumanQueueProjection }) {
  return (
    <Box height={1}>
      <Text wrap="truncate">
        <Text bold>QUEUE</Text> {projection.target} <Text bold>OPEN</Text> {projection.open} <Text bold>ACTIVE</Text>{" "}
        {projection.activeCount} <Text bold>INTEGRATED</Text> {projection.integrated} <Text bold>REJECTED</Text>{" "}
        {projection.rejected} <Text bold>DRAIN</Text> {projection.oldestOpen}
      </Text>
    </Box>
  )
}

export function QueueListView({ results, now }: { results: readonly QueueStatusResult[]; now: number }) {
  return (
    <Box flexDirection="column">
      {results.map((result) => (
        <SummaryQueue key={result.base} projection={humanQueueProjection(result, now)} />
      ))}
    </Box>
  )
}

function ActiveQueue({ active }: { active: WatchActiveRow }) {
  return (
    <Box height={1}>
      <Text wrap="truncate">
        <Text bold>ACTIVE RUN </Text>
        <QueueRunId base={active.base} run={active.run} /> <QueuePrId pr={active.pr} revision={active.revision} />{" "}
        {active.subject} <TaskStatusGlyph taskStatus={active.taskStatus} glyph={active.glyph} /> {active.steps}{" "}
        {active.elapsed}
      </Text>
    </Box>
  )
}

function ProjectedPRQueue({ row, position }: { row: HumanPRProjection; position?: number }) {
  return (
    <Box height={1}>
      <Text wrap="truncate">
        {position === undefined ? "" : `${position}. `}
        <TaskStatusGlyph taskStatus={row.taskStatus} glyph={row.glyph} />{" "}
        {row.prHref === undefined ? (
          <QueuePrId pr={row.pr} revision={row.revision} />
        ) : (
          <Link href={row.prHref}>
            <QueuePrId pr={row.pr} revision={row.revision} />
          </Link>
        )}{" "}
        {row.subject} <StatusValue value={row.state} href={row.log} /> age={row.age}
      </Text>
    </Box>
  )
}

function FailureQueues({ failure }: { failure: HumanFailureProjection }) {
  return (
    <Box flexDirection="column">
      <Box height={1}>
        <Text wrap="truncate"> {failure.summary}</Text>
      </Box>
      {failure.evidence === undefined ? null : (
        <Box height={1}>
          <Text wrap="truncate">
            {"    evidence: "}
            {failure.evidence.href === undefined ? (
              failure.evidence.text
            ) : (
              <CellLink href={failure.evidence.href}>{failure.evidence.text}</CellLink>
            )}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function ActionableFailureView({ failure }: { failure: ActionableFailure }) {
  return (
    <Box flexDirection="column" minWidth={0}>
      <Text color="$fg-error" wrap="wrap">
        ERROR {errorCodeLabel(failure.code)}
      </Text>
      <Text wrap="wrap">CAUSE {failure.cause}</Text>
      {failure.resolution.map((step, index) => (
        <Text key={`${failure.code}:resolution:${index}`} wrap="wrap">
          RESOLVE {step}
        </Text>
      ))}
      {failure.reference === undefined ? null : <Text wrap="wrap">REFERENCE {failure.reference}</Text>}
    </Box>
  )
}

function ProjectionRows({
  projection,
  queueHeading = "QUEUE",
}: {
  projection: HumanQueueProjection
  queueHeading?: string
}) {
  return (
    <Box flexDirection="column">
      {projection.queue.length === 0 ? null : (
        <>
          <Box height={1}>
            <Text bold>{queueHeading}</Text>
          </Box>
          {projection.queue.map((row) => (
            <ProjectedPRQueue key={row.pr} row={row} position={row.position} />
          ))}
          {projection.queueOverflow === 0 ? null : (
            <Box height={1}>
              <Text color="$fg-muted">... {projection.queueOverflow} more runnable</Text>
            </Box>
          )}
        </>
      )}
      {projection.recent.length === 0 ? null : (
        <>
          <Box height={1}>
            <Text bold>
              {projection.recent.some((row) => row.nativeStatus === "rejected") ? "Recent failures" : "Recent results"}
            </Text>
          </Box>
          {projection.recent.map((row, index) => (
            <Box key={`${row.pr}:${row.runId ?? index}`} flexDirection="column">
              <ProjectedPRQueue row={row} />
              {row.failure === undefined ? null : <FailureQueues failure={row.failure} />}
            </Box>
          ))}
        </>
      )}
      {projection.queue.length === 0 && projection.recent.length === 0 ? (
        <Box height={1}>
          <Text color="$fg-muted">No runnable or recent rejected PRs.</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export function QueueStatusView({
  state,
  results,
  selected,
  positions,
  now,
}: {
  state: BaysState
  results: readonly QueueStatusResult[]
  selected: ReadonlySet<string>
  positions?: ReadonlyMap<string, number>
  now: number
}) {
  return (
    <Box flexDirection="column">
      {results.map((result, index) => {
        const projection = humanQueueProjection(result, now, { selected, state, positions })
        const allowed = projection.pause?.allowedPRs.length === 0 ? "none" : projection.pause?.allowedPRs.join(", ")
        return (
          <Box key={result.base} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
            <SummaryQueue projection={projection} />
            {projection.pause !== undefined && (
              <Box height={1}>
                <Text wrap="truncate">
                  <Text color="$fg-warning" bold>
                    PAUSE
                  </Text>
                  {`: ${projection.pause.reason} (allowed: ${allowed})`}
                </Text>
              </Box>
            )}
            {projection.active === undefined ? null : <ActiveQueue active={projection.active} />}
            <ProjectionRows projection={projection} />
          </Box>
        )
      })}
    </Box>
  )
}

export type WatchQueueRow = Readonly<{
  pos: number
  pr: string
  subject: string
  glyph: StatusGlyph
  taskStatus: TaskStatus
  state: string
  step: string
  age: string
  touched: string
  run: string
  result: string
}>

export function watchQueueRows(result: QueueStatusResult, now: number): WatchQueueRow[] {
  return humanQueueProjection(result, now).queue.map((row) => ({
    pos: row.position,
    pr: row.pr,
    subject: row.subject,
    glyph: row.glyph,
    taskStatus: row.taskStatus,
    state: row.state,
    step: row.step,
    age: row.age,
    touched: row.touched,
    run: row.run,
    result: row.result,
  }))
}

export type WatchActiveRow = Readonly<{
  base: string
  run: string
  pr: string
  revision: number
  subject: string
  step: string
  steps: string
  status: QueueRun["status"]
  taskStatus: TaskStatus
  glyph: StatusGlyph
  elapsed: string
}>

export function activeWatchRow(
  result: QueueStatusResult,
  now: number,
  selected: ReadonlySet<string> = new Set<string>(),
): WatchActiveRow | undefined {
  const run = [...result.running, ...result.waiting]
    .filter((candidate) => selected.size === 0 || candidate.prs.some((member) => selected.has(member.id)))
    .toSorted(byRunStarted)
    .at(0)
  if (run === undefined) return undefined
  const member = run.prs.find((candidate) => selected.size === 0 || selected.has(candidate.id))
  if (member === undefined) return undefined
  const pr = result.prs.find((candidate) => candidate.id === member.id)
  const step = relevantStep(run) ?? run.steps.at(0)
  const taskStatus = runTaskStatusOf(run)
  return {
    base: run.base,
    run: run.id,
    pr: member.id,
    revision: member.revision,
    subject: boundedQueue(pr?.title ?? pr?.name ?? member.id, 80),
    step: step?.name ?? "-",
    steps: queueRunSteps(run),
    status: run.status,
    ...taskStatusFields(taskStatus),
    elapsed: age(run.startedAt, now, `run '${run.id}' elapsed`),
  }
}

export function QueueWatchView({
  results,
  now,
  pr,
}: {
  results: readonly QueueStatusResult[]
  now: number
  pr?: string
}) {
  if (pr !== undefined) {
    const selectedPr = results.flatMap((result) => result.prs).find((candidate) => candidate.id === pr)
    if (selectedPr === undefined) return <Text color="$fg-muted">No PR '{pr}' recorded.</Text>
    const runs = [
      ...new Map(
        results
          .flatMap((result) => [...result.running, ...result.waiting, ...result.finished])
          .map((run) => [run.id, run] as const),
      ).values(),
    ]
    return <PRDetailView pr={selectedPr} runs={runs} now={now} />
  }

  return (
    <Box flexDirection="column">
      {results.map((result, index) => {
        const projection = humanQueueProjection(result, now)
        const pauseState = projection.pause === undefined ? "active" : `paused: ${projection.pause.reason}`
        return (
          <Box key={result.base} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
            <SummaryQueue projection={projection} />
            <Box height={1}>
              <Text wrap="truncate">
                <Text bold>PAUSE</Text> {pauseState} <Text bold>DRAIN</Text> {projection.oldestOpen}
              </Text>
            </Box>
            {projection.active === undefined ? null : <ActiveQueue active={projection.active} />}
            <ProjectionRows projection={projection} queueHeading="QUEUE POS" />
          </Box>
        )
      })}
    </Box>
  )
}

function queueLogSubmissionTime(
  revisionClocks: ReadonlyMap<string, PRRunRevisionClock> | undefined,
  run: QueueRun,
  pr: PinnedPRRevision,
): string | undefined {
  if (revisionClocks === undefined) return undefined
  const clock = revisionClocks.get(queueRunRevisionKey(run, pr))
  if (clock === undefined) {
    throw new Error(
      `yrd: run '${run.id}' has no causal submit/check-request clock for PR '${pr.id}' revision ${pr.revision}@${pr.headSha}`,
    )
  }
  return clock.admittedBy === "submission" ? clock.submittedAt : undefined
}

export function timelineMetric(value: number | null): string {
  if (value === null) return "-"
  const duration = mediaDuration(value)
  if (duration.length <= 6) return duration

  const totalMinutes = Math.floor(value / 60_000)
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 100) return `${totalHours}h${String(totalMinutes % 60).padStart(2, "0")}m`

  const totalDays = Math.floor(totalHours / 24)
  if (totalDays < 100) return `${totalDays}d${String(totalHours % 24).padStart(2, "0")}h`
  if (totalDays < 100_000) return `${totalDays}d`
  return ">99kd"
}

// The queue content surface is left-flush (15e killed the dead left gutter)
// and capped at 160 cells on wide viewports.
const TIMELINE_CONTENT_CAP = 160
// Fixed cells never clip arbitrarily; labels longer than this shorten at a
// semantic boundary via fitTimelineLabel.
const TIMELINE_STATE_CAP = 20
/**
 * Powerline branch glyph (U+E0A0), prefixed on every rendered branch name in
 * the watch UI (user directive 2026-07-16), matching ag-code's `BRANCH_ICON`.
 */
const BRANCH_ICON = TIMELINE_BRANCH_ICON

/**
 * The branch glyph renders dim/subtle everywhere (user directive 2026-07-16,
 * W2) — a quiet decoration on the branch name, never competing with it. On a
 * cursor-selected row the glyph follows the selection foreground instead, so
 * the whole row reads as one selected unit.
 */
const BRANCH_ICON_COLOR = "$fg-muted"

/**
 * Stable no-op passed as ListView `onItemHover` so hovering a queue row does
 * NOT move the cursor/selection (item P, 2026-07-16) — it overrides ListView's
 * default hover→cursor. Click still selects via the default onSelect path.
 */
const NO_HOVER_SELECT = (): void => {}

type TimelineCellLayout = Readonly<{
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

type TimelineRunCell = Readonly<{ text: string; color?: string }>

// The RUN(id) part of the RUN·PR identity cell: main#N (or #N on the compact
// tier); a run that has not started yet renders a plain muted dash (item 9),
// never blank.
function timelineRunCell(row: QueueTimelineProjectedRow, compact: boolean): TimelineRunCell {
  void compact
  if (row.run === undefined) return { text: "-", color: "$fg-muted" }
  return { text: formatNounId(row.base, runIdValue(row.run)) }
}

function timelineBranchLabel(branch: string): string {
  return branch.replace(/^task\//u, "")
}

/**
 * The DETAIL pane's flush-top identity. The detail view is FOR a PR (user
 * directive 2026-07-21, supersedes Round-6 Revision A's run-as-unit title):
 * the left side is `pr#id.rev` plus its linked ISSUE, for run rows and
 * pending rows alike; the run identity lives in the QueueDetailRunHeader
 * region below. STATUS + OUTCOME stays right-aligned; timing belongs
 * exclusively in the body.
 */
export function QueueDetailTitle({
  row,
  data,
  issue,
  live = false,
}: {
  row?: QueueTimelineProjectedRow
  data?: QueueShowData
  issue?: string
  /** True in the live watch: a running status pulses (user directive 2026-07-21). */
  live?: boolean
}) {
  if (row === undefined) {
    return (
      <Text bold color="$fg-warning" wrap="truncate">
        No queue row selected.
      </Text>
    )
  }
  const outcome = detailStatusOutcome(row, data)
  const presentIssue = presentFact(issue)
  const running = data === undefined ? row.status === "running" : data.status === "running"
  return (
    <Box flexDirection="row" width="100%" justifyContent="space-between" minWidth={0} flexShrink={0}>
      <Box flexDirection="row" minWidth={0} overflow="hidden">
        <QueuePrId pr={row.pr} revision={row.revision} color="$fg-warning" flexShrink={0} />
        {presentIssue === undefined ? null : (
          <>
            <Text flexShrink={0}> </Text>
            <IssueValue issue={presentIssue} flex />
          </>
        )}
      </Box>
      {outcome === undefined ? null : live && running ? (
        <Pulse synchronized colors={["$fg-info", "$fg-muted"]} intervalMs={AG_PULSE_INTERVAL_MS} bold flexShrink={0}>
          {outcome.text}
        </Pulse>
      ) : (
        <Text bold color={outcome.color} flexShrink={0}>
          {outcome.text}
        </Text>
      )}
    </Box>
  )
}

/**
 * The RUN region header (user directive 2026-07-21): a filled full-width row
 * that opens the run section of the PR detail — run identity left, colorized
 * STATUS/OUTCOME right — so the run reads as its own region below the
 * PR-scoped header.
 */
export function QueueDetailRunHeader({ data }: { data: QueueShowData }) {
  const outcome = runStatusOutcome(data)
  return (
    <Box
      flexDirection="row"
      width="100%"
      justifyContent="space-between"
      minWidth={0}
      flexShrink={0}
      backgroundColor="$bg-surface-subtle"
      paddingX={1}
    >
      <Text bold wrap="truncate" minWidth={0}>
        RUN <QueueRunId base={data.base} run={data.run} />
      </Text>
      {outcome === undefined ? null : (
        <Text bold color={outcome.color} flexShrink={0}>
          {outcome.text}
        </Text>
      )}
    </Box>
  )
}

/**
 * The run's STATUS + OUTCOME as one colorized label (`passed, integrated`),
 * deduped when the two words match, or undefined when neither is present.
 */
function runStatusOutcome(data: QueueShowData): Readonly<{ text: string; color: string }> | undefined {
  const status = presentFact(data.status)
  const outcome = presentFact(data.outcome)
  if (status === undefined && outcome === undefined) return undefined
  const text =
    status !== undefined && outcome !== undefined && status !== outcome
      ? `${status}, ${outcome}`
      : (outcome ?? status ?? "")
  const marker = presentFact(data.glyph)
  return { text: marker === undefined ? text : `${marker} ${text}`, color: taskStatusColor(data.taskStatus) }
}

/** The title-row variant: falls back to the row's own glyph + status. */
function detailStatusOutcome(
  row: QueueTimelineProjectedRow,
  data?: QueueShowData,
): Readonly<{ text: string; color: string }> {
  const run = data === undefined ? undefined : runStatusOutcome(data)
  const word = row.status === "pending" ? "queued" : row.status
  return run ?? { text: `${row.glyph} ${word}`, color: timelineStatusColor(row) }
}

// Preserve the leading semantic unit instead of clipping an arbitrary suffix.
function fitTimelineLabel(label: string, max: number): string {
  if (label.length <= max) return label
  const boundary = Math.max(label.lastIndexOf("-", max), label.lastIndexOf(":", max))
  return boundary > 0 ? label.slice(0, boundary) : label.slice(0, max)
}

// Marker + state colors (15d screenshot re-rule): running pulses blue,
// success is GREEN semantic, pending is blue, failures keep semantic reds.
function timelineStatusColor(row: QueueTimelineProjectedRow): string {
  // A draft is pre-queue WIP, not a live or failing item: dim it like `canceled`
  // so it reads as tentative next to the blue `ready`/`run` pulse.
  if (row.status === "draft") return "$fg-muted"
  // A rev row failed a prior submission and awaits author edits: warn-toned,
  // matching the "editable after failure" model without reading as a hard failure.
  if (row.status === "rev") return "$fg-warning"
  if (row.status === "running" || row.status === "pending" || row.status === "ready") return "$fg-info"
  if (row.status === "integrated") return "$fg-success"
  if (row.status === "canceled") return "$fg-muted"
  if (["environment-refused", "stale", "legacy", "refused"].includes(row.status)) return "$fg-warning"
  return "$fg-error"
}

type TimelineStatusCell = Readonly<{ word: string; color: string }>

const TIMELINE_STATUS_WORDS = {
  draft: "draft",
  rev: "rev",
  ready: "ready",
  pending: "todo",
  running: "run",
  integrated: "done",
  rejected: "fail",
  "environment-refused": "env",
  stale: "stale",
  lost: "lost",
  legacy: "legacy",
  refused: "refused",
  canceled: "can",
} as const satisfies Readonly<Record<QueueTimelineStatus, string>>

// 15e is later than 15c/15d: STATUS remains a fixed column between TIME
// and the RUN cell, while 15d supplies its semantic foreground colors.
// Vocabulary (user respec 2026-07-15; rejected renders `fail`, integrated
// renders `done`). The pre-run PRs now carry their own fine STATUS words —
// `draft`/`rev`/`ready` — so a non-integrated PR is always visible with
// an explicit label (user directive 2026-07-22, generalizing the 2026-07-21
// pending→`todo` rule); the coarse filter pills stay todo/running/failed/done.
function timelineStatusCell(row: QueueTimelineProjectedRow): TimelineStatusCell {
  const word = TIMELINE_STATUS_WORDS[row.status]
  return { word, color: timelineStatusColor(row) }
}

type TimelineStepCell = Readonly<{ text: string; color?: string }>

// The STEP cell carries the current `ordinal:name` while running, semantic
// GREEN `integrated` on success (15d), or the failure CODE (the cause) on
// failed terminals.
function timelineStepCell(row: QueueTimelineProjectedRow): TimelineStepCell {
  if (row.status === "running") return { text: row.step ?? "" }
  if (row.failure !== undefined) {
    const slug = fitTimelineLabel(failureSlug(row.failure.code), TIMELINE_STATE_CAP)
    return {
      text: `err=${slug}`,
      color: ["environment-refused", "stale", "legacy", "refused"].includes(row.status)
        ? "$fg-warning"
        : row.status === "canceled"
          ? "$fg-muted"
          : "$fg-error",
    }
  }
  return { text: "" }
}

function timelineAgeCell(row: QueueTimelineProjectedRow): string {
  return row.ageMs === null ? "" : mediaDuration(row.ageMs)
}

function timelineTotalCell(row: QueueTimelineProjectedRow): string {
  return row.totalMs === null ? "" : mediaDuration(row.totalMs)
}

function timelineClockCell(row: QueueTimelineProjectedRow, layout: TimelineCellLayout): string {
  return row.timestamp === null ? "-" : queueLogClock(row.timestamp, false, layout.includeDate)
}

function timelineRepeatLabel(repeat: QueueTimelineRepeat): string {
  const first = queueLogClock(repeat.firstTimestamp, false, false).slice(0, 5)
  const last = queueLogClock(repeat.lastTimestamp, false, false).slice(0, 5)
  return `×${repeat.count} · ${first}–${last}`
}

function timelineByCell(row: QueueTimelineProjectedRow): string {
  return row.submitter ?? "-"
}

function timelineCellLayout(
  rows: readonly QueueTimelineProjectedRow[],
  includeDate: boolean,
  columns: number,
): TimelineCellLayout {
  const compact = columns <= 80
  return {
    timeWidth: includeDate ? 19 : 8,
    statusWidth: Math.max(6, ...rows.map((row) => timelineStatusCell(row).word.length + 2)),
    runWidth: Math.max(3, ...rows.map((row) => timelineRunCell(row, compact).text.length)),
    byWidth: columns < 100 ? 0 : Math.max(2, ...rows.map((row) => timelineByCell(row).length)),
    ageWidth: Math.max(3, ...rows.map((row) => timelineAgeCell(row).length)),
    runDurationWidth: Math.max(3, ...rows.map((row) => (row.totalMs === null ? 0 : timelineTotalCell(row).length))),
    compact,
    includeDate,
  }
}

/** Default list cursor: the first RUNNING row, else the most recently finished row. */
export function queueTimelineDefaultCursorId(
  rows: readonly Pick<QueueTimelineProjectedRow, "id" | "status" | "group" | "timestampMs">[],
): string | undefined {
  const running = rows.find((row) => row.status === "running")
  if (running !== undefined) return running.id
  let finished: (typeof rows)[number] | undefined
  for (const row of rows) {
    if (row.group !== "completed") continue
    if (
      finished === undefined ||
      (row.timestampMs ?? Number.NEGATIVE_INFINITY) > (finished.timestampMs ?? Number.NEGATIVE_INFINITY)
    ) {
      finished = row
    }
  }
  return (finished ?? rows[0])?.id
}

// The working task glyph pulses only in the live pane; the one-shot projection has
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
const AG_PULSE_INTERVAL_MS = 900

/** The default "executing right now" pulse: blue against muted, shared phase. */
const ACTIVITY_PULSE_COLORS: readonly [string, string] = ["$fg-info", "$fg-muted"]

/**
 * A synchronized semantic activity pulse for "in progress right now" content
 * (items 12/13). It pulses the caller's color pair when `live` and keeps that
 * pair under row selection; `forceFg` applies only to non-activity content.
 */
function ActivityPulse({
  live,
  colors = ACTIVITY_PULSE_COLORS,
  children,
  ...rest
}: {
  live: boolean
  colors?: readonly [string, string]
  children: React.ReactNode
} & Omit<TextProps, "color" | "children">) {
  if (live) {
    return (
      <Pulse synchronized colors={colors} intervalMs={AG_PULSE_INTERVAL_MS} {...rest}>
        {children}
      </Pulse>
    )
  }
  return (
    <Text color={colors[0]} {...rest}>
      {children}
    </Text>
  )
}

function TimelineMarker({ row, live }: { row: QueueTimelineProjectedRow; live: boolean }) {
  if (row.status === "running") return <ActivityPulse live={live}>{row.glyph}</ActivityPulse>
  return <Text color={timelineStatusColor(row)}>{row.glyph}</Text>
}

/**
 * ONE shared column-geometry component consumed by the header AND every row
 * (silverize verdict 2026-07-15): fixed TIME/STATUS/RUN cells, ONE flexGrow
 * PR cell (absorbs all reclaimed width), and right-anchored STEP/BY/AGE/RUN
 * duration cells at fixed offsets. Header labels and row values render into
 * the same cells, so the header cannot drift from the rows. `rowId` derives
 * per-cell ids (`th-*` for the header, `td-*-<rowId>` for rows) so tests
 * assert x-offset equality via boundingBox, not text scans.
 */
function TimelineCells({
  layout,
  rowId,
  backgroundColor,
  time,
  status,
  run,
  pr,
  by,
  age,
  runDuration,
}: Readonly<{
  layout: TimelineCellLayout
  rowId?: string
  backgroundColor?: string
  time: React.ReactNode
  status: React.ReactNode
  run: React.ReactNode
  pr: React.ReactNode
  by: React.ReactNode
  age: React.ReactNode
  runDuration: React.ReactNode
}>) {
  const id = (name: string): string => (rowId === undefined ? `th-${name}` : `td-${name}-${rowId}`)
  return (
    <Box
      height={1}
      width="100%"
      flexDirection="row"
      gap={1}
      minWidth={0}
      overflow="hidden"
      backgroundColor={backgroundColor}
    >
      <Box id={id("time")} width={layout.timeWidth} flexShrink={0} minWidth={0}>
        {time}
      </Box>
      <Box
        id={id("status")}
        width={layout.statusWidth}
        flexDirection="row"
        flexShrink={0}
        minWidth={0}
        overflow="hidden"
      >
        {status}
      </Box>
      <Box id={id("run")} width={layout.runWidth} flexShrink={0} minWidth={0}>
        {run}
      </Box>
      <Box id={id("pr")} flexDirection="row" flexGrow={1} flexBasis={0} minWidth={12} overflow="hidden">
        {pr}
      </Box>
      {layout.byWidth === 0 ? null : (
        // BY is left-aligned — header and cells (user directive 2026-07-16,
        // supersedes the 15c right-aligned BY clause).
        <Box id={id("by")} width={layout.byWidth} flexShrink={0} minWidth={0}>
          {by}
        </Box>
      )}
      <Box id={id("age")} width={layout.ageWidth} flexShrink={0} minWidth={0} justifyContent="flex-end">
        {age}
      </Box>
      {/* id is `dur`, not `run-duration` — a `run-` prefix would collide with the RUN(id) cell's prefix queries. */}
      <Box id={id("dur")} width={layout.runDurationWidth} flexShrink={0} minWidth={0} justifyContent="flex-end">
        {runDuration}
      </Box>
    </Box>
  )
}

// Header: TIME | STATUS | RUN | PR | BY | AGE | RUN — RUN(id) and PR are
// separate labels, each exactly over its own column; the trailing bare RUN
// header belongs to the run-duration column. STEP was folded into the PR cell
// (user directive 2026-07-16, item Q).
function TimelineHeader({ layout }: { layout: TimelineCellLayout }) {
  // The column header reads white + bold (user directive 2026-07-16) so it
  // stands out above the muted row cells.
  const label = (text: string): React.ReactElement => (
    <Text color="$fg" bold wrap="truncate">
      {text}
    </Text>
  )
  return (
    <TimelineCells
      layout={layout}
      time={label("TIME")}
      status={label("STATUS")}
      run={label("RUN")}
      pr={label("PR")}
      by={label("BY")}
      age={label("AGE")}
      runDuration={label("RUN")}
    />
  )
}

function TimelineProjectedRow({
  row,
  continuation,
  cursor,
  hovered,
  layout,
  live,
}: {
  row: QueueTimelineDisplayRow
  continuation: boolean
  cursor: boolean
  hovered: boolean
  layout: TimelineCellLayout
  live: boolean
}) {
  const active = !continuation && row.status === "running"
  const status = timelineStatusCell(row)
  const runCell = timelineRunCell(row, layout.compact)
  const step = timelineStepCell(row)
  const runDuration = timelineTotalCell(row)
  // Selection forces the semantic pair on EVERY cell (user respec
  // 2026-07-15): $bg-selected under $fg-on-selected, no per-cell colors.
  const forcedFg = cursor ? "$fg-on-selected" : undefined
  // Hover is affordance-only (item P): a background tint under the pointer that
  // never moves the cursor or detail selection. Cursor selection wins, so a
  // hovered cursor row keeps $bg-selected; foreground is untouched by hover.
  const rowBackground = cursor ? "$bg-selected" : hovered ? "$bg-surface-hover" : undefined
  return (
    <TimelineCells
      layout={layout}
      rowId={row.id}
      backgroundColor={rowBackground}
      time={
        <Text color={forcedFg ?? "$fg-muted"} wrap="truncate">
          {continuation ? "-" : timelineClockCell(row, layout)}
        </Text>
      }
      status={
        continuation ? (
          <Text color={forcedFg ?? "$fg-muted"}>-</Text>
        ) : (
          <>
            <Box width={1} flexShrink={0}>
              {/* A running row's glyph keeps its km warning pulse even under
                selection; other statuses take the selection fg. */}
              {active || !cursor ? <TimelineMarker row={row} live={live} /> : <Text color={forcedFg}>{row.glyph}</Text>}
            </Box>
            <Box paddingLeft={1} minWidth={0} overflow="hidden">
              {/* The running status word pulses blue in the shared phase (item 12)
                and stays blue when the row is selected (item 13). */}
              {active ? (
                <ActivityPulse live={live} wrap="truncate">
                  {status.word}
                </ActivityPulse>
              ) : (
                <Text color={forcedFg ?? status.color} wrap="truncate">
                  {status.word}
                </Text>
              )}
            </Box>
          </>
        )
      }
      run={
        // Real run ids share TIME's muted treatment (user respec 2026-07-15);
        // run-less pending rows keep their info-colored `pending`.
        continuation ? (
          <Text color={forcedFg ?? "$fg-muted"}>-</Text>
        ) : row.run === undefined ? (
          <Text color={forcedFg ?? runCell.color ?? "$fg-muted"} wrap="truncate">
            {runCell.text}
          </Text>
        ) : (
          <QueueRunId base={row.base} run={row.run} color={forcedFg ?? runCell.color ?? "$fg-muted"} wrap="truncate" />
        )
      }
      pr={
        // The flexible cell folds the removed STEP column in (user directive
        // 2026-07-16, item Q): `PR.rev  <branch-glyph> <branch> (<status>)`.
        // The PR+revision id stays bold (item F); the parenthesized suffix is
        // the live step (running) or terminal failure code, colorized by state.
        <>
          <QueuePrId pr={row.pr} revision={row.revision} color={forcedFg} flexShrink={0} />
          {row.repeat?.collapsed === true ? (
            <Text color={forcedFg ?? "$fg-warning"} flexShrink={0}>
              {` ${timelineRepeatLabel(row.repeat)}`}
            </Text>
          ) : null}
          {row.issue === undefined ? (
            <Box paddingLeft={1} minWidth={0} overflow="hidden" flexDirection="row">
              <Text color={forcedFg ?? BRANCH_ICON_COLOR} flexShrink={0}>
                {BRANCH_ICON}
              </Text>
              <Text color={forcedFg} wrap="truncate" minWidth={0}>
                {" "}
                {timelineBranchLabel(row.branch)}
              </Text>
              {continuation || step.text === "" ? null : (
                <Text color={forcedFg ?? (active ? "$fg-info" : step.color)} flexShrink={0} wrap="truncate">
                  {" "}
                  ({step.text})
                </Text>
              )}
            </Box>
          ) : (
            <Box paddingLeft={1} minWidth={0} overflow="hidden" flexDirection="row">
              <Text color={forcedFg} flexShrink={0}>
                for{" "}
              </Text>
              <IssueValue issue={row.issue} flex />
            </Box>
          )}
        </>
      }
      by={
        <Text color={forcedFg ?? "$fg-muted"} wrap="truncate">
          {timelineByCell(row)}
        </Text>
      }
      age={<Text color={forcedFg ?? "$fg-muted"}>{timelineAgeCell(row)}</Text>}
      runDuration={
        // Run duration: no clock glyph, just the dimmed time (user directive
        // 2026-07-16, supersedes the 15c `◷`-carries-onto-RUN clause).
        continuation ? (
          <Text color={forcedFg ?? "$fg-muted"}>-</Text>
        ) : runDuration === "" ? (
          <Text> </Text>
        ) : (
          <Text color={forcedFg ?? "$fg-muted"}>{runDuration}</Text>
        )
      }
    />
  )
}

// The QUEUE pane is headed by one TAB, not a titled box (user directive
// 2026-07-16, item L). Sibling branch names are queue data, not navigation;
// putting arbitrary-length names into this one-row header made Tab text wrap
// through the TIME/STATUS table header in the live pane.
function QueueTabsLine({ base, showLabel = true }: { base: string; showLabel?: boolean }) {
  return (
    <Tabs value={base} isActive={false}>
      <TabList>
        <Tab value={base}>{showLabel ? `QUEUE ${base}` : base}</Tab>
      </TabList>
    </Tabs>
  )
}

export const RUNNER_STALE_MS = 15_000

function runnerTiming(projection: QueueTimelineProjection): Readonly<{ ageMs: number; uptimeMs: number }> | null {
  const runner = projection.runner
  if (runner === null) return null
  const now = Date.parse(projection.now)
  const startedAt = Date.parse(runner.startedAt)
  const lastTickAt = Date.parse(runner.lastTickAt)
  if (![now, startedAt, lastTickAt].every(Number.isFinite)) {
    throw new Error("yrd: queue runner projection contains an invalid timestamp")
  }
  return { ageMs: Math.max(0, now - lastTickAt), uptimeMs: Math.max(0, now - startedAt) }
}

/**
 * The one title-in-border chrome idiom every watch box uses (user directive
 * 2026-07-16): a FULL round border (all four corners) with a LEFT-aligned name
 * label punched into the top edge — `╭─ TITLE ──────╮`. The label inherits the
 * effective border color, so a stale/error box turns border and title red
 * together. `fill` stretches the frame to its parent (pane usage); `padding`
 * widens the inner content padding from the single-row default (`paddingX=1`);
 * `flushTop` drops the top padding so the first content row (e.g. the QUEUE
 * pane's `updated` clock) reads flush beneath the title instead of below a gap.
 */
export function TitledBox({
  title,
  titleRight,
  borderColor,
  padding,
  fill = false,
  marginTop,
  flushTop = false,
  children,
}: Readonly<{
  title: string
  /** Right-aligned label punched into the top edge — `╭─ TITLE ──── LABEL ─╮`
   *  (user directive 2026-07-21: the RUNNER box carries its uptime/downtime
   *  timer here). Inherits the effective border color like the left title. */
  titleRight?: string
  borderColor?: string
  padding?: number
  fill?: boolean
  marginTop?: number
  flushTop?: boolean
  children: React.ReactNode
}>) {
  // One resolved border value drives both the border glyphs and the label so
  // they are provably the same color (the default, or the error-red override).
  const border = borderColor ?? "$border-default"
  const bodyPadding =
    padding === undefined
      ? { paddingX: 1, paddingTop: flushTop ? 0 : undefined }
      : flushTop
        ? { paddingLeft: padding, paddingRight: padding, paddingBottom: padding, paddingTop: 0 }
        : { padding }
  return (
    <Box
      width="100%"
      height={fill ? "100%" : undefined}
      flexDirection="column"
      minWidth={0}
      minHeight={0}
      flexShrink={fill ? 1 : 0}
      flexGrow={fill ? 1 : undefined}
      marginTop={marginTop}
      // Each titled box (STATUS / FLOW / TIME) is its own selection scope
      // (item 4a): a drag started inside it resolves to this box as the nearest
      // `contain` boundary, so it never grows into a sibling box or the pane
      // around it. Nested inside the pane's own scope; `contain` keeps content
      // selectable while bounding the range.
      userSelect="contain"
    >
      <Box flexDirection="row" width="100%" flexShrink={0} minWidth={0}>
        <Text color={border} flexShrink={0}>
          {"╭─ "}
        </Text>
        <Text color={border} bold flexShrink={0}>
          {title}
        </Text>
        <Text color={border} flexShrink={0}>
          {" "}
        </Text>
        {/* Flex-grow fill: a top-only round border renders the `─` run that
            stretches from the label to the rounded top-right corner. */}
        <Box
          height={1}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          borderStyle="round"
          borderColor={border}
          borderLeft={false}
          borderRight={false}
          borderBottom={false}
        />
        {titleRight === undefined ? null : (
          <Text color={border} flexShrink={0}>
            {` ${titleRight} ─`}
          </Text>
        )}
        <Text color={border} flexShrink={0}>
          {"╮"}
        </Text>
      </Box>
      <Box
        borderStyle="round"
        borderTop={false}
        borderColor={border}
        width="100%"
        flexDirection="column"
        flexGrow={fill ? 1 : undefined}
        minWidth={0}
        minHeight={0}
        {...bodyPadding}
      >
        {children}
      </Box>
    </Box>
  )
}

/**
 * Adaptive runner clock (user directive 2026-07-21): `ss`, `m:ss`, or
 * `h:mm:ss` depending on magnitude — the RUNNER box always shows a timer.
 */
function runnerClock(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`
  return `${seconds}s`
}

/** Newest terminal (completed-group) row timestamp — when the queue last drained anything. */
function timelineLastDrainedMs(projection: QueueTimelineProjection): number | null {
  let newest: number | null = null
  for (const row of projection.rows) {
    if (row.group !== "completed" || row.timestampMs === null) continue
    if (newest === null || row.timestampMs > newest) newest = row.timestampMs
  }
  return newest
}

/** The RUNNER liveness reflected by the leading marker. */
export type QueueHealthKind = "down" | "processing" | "idle"

export type QueueHealthMarker = Readonly<{
  kind: QueueHealthKind
  color: string
  pulse: readonly [string, string] | null
}>

/** Missing/stale is solid red; active is pulsing blue; idle is pulsing grey. */
export function queueHealthMarker(projection: QueueTimelineProjection): QueueHealthMarker {
  const timing = runnerTiming(projection)
  if (projection.runner === null || (timing !== null && timing.ageMs > RUNNER_STALE_MS)) {
    return { kind: "down", color: "$fg-error", pulse: null }
  }
  if (projection.rows.some((row) => row.status === "running")) {
    return { kind: "processing", color: "$fg-info", pulse: ["$fg-info", "$fg-muted"] }
  }
  return { kind: "idle", color: "$fg-muted", pulse: ["$fg-muted", "$bg-surface-default"] }
}

// The runner health marker is the shell prompt itself (user directive
// 2026-07-21): a pulsing `$` leads the runner command instead of a disc.
const QUEUE_HEALTH_GLYPH = "$"

function RunnerActivity({
  marker,
  live,
  children,
  ...rest
}: {
  marker: QueueHealthMarker
  live: boolean
  children: React.ReactNode
} & Omit<TextProps, "color" | "children">) {
  if (marker.pulse !== null && live) {
    return (
      <Pulse synchronized colors={marker.pulse} intervalMs={AG_PULSE_INTERVAL_MS} {...rest}>
        {children}
      </Pulse>
    )
  }
  return (
    <Text color={marker.color} {...rest}>
      {children}
    </Text>
  )
}

/**
 * Resident runner status is always visible in its own RUNNER frame. The
 * queue-pause STATUS line lives INSIDE this frame (user directive 2026-07-21,
 * supersedes the separate STATUS box), the uptime/downtime timer rides the
 * top border right-aligned opposite the RUNNER title, and the health marker
 * is a pulsing `$` shell prompt. Border severity: down/stale red, paused
 * warning, healthy default.
 */
function TimelineRunnerBox({ projection, live = false }: { projection: QueueTimelineProjection; live?: boolean }) {
  const runner = projection.runner
  const timing = runnerTiming(projection)
  const runnerStale = timing !== null && timing.ageMs > RUNNER_STALE_MS
  const marker = queueHealthMarker(projection)
  const pause = projection.pause
  const now = Date.parse(projection.now)
  const drained = timelineLastDrainedMs(projection)
  const downMs =
    runner === null
      ? drained === null
        ? null
        : Math.max(0, now - drained)
      : runnerStale
        ? (timing?.ageMs ?? null)
        : null
  const timer =
    marker.kind === "down"
      ? downMs === null
        ? undefined
        : `downtime ${runnerClock(downMs)}`
      : `uptime ${runnerClock(timing?.uptimeMs ?? 0)}`
  const borderColor = marker.kind === "down" ? "$fg-error" : pause !== undefined ? "$fg-warning" : undefined
  return (
    <TitledBox
      title="RUNNER"
      {...(timer === undefined ? {} : { titleRight: timer })}
      {...(borderColor === undefined ? {} : { borderColor })}
    >
      <Box height={1} flexDirection="row" gap={1} minWidth={0}>
        <RunnerActivity marker={marker} live={live} bold flexShrink={0}>
          {QUEUE_HEALTH_GLYPH}
        </RunnerActivity>
        {runner === null ? (
          <Text color="$fg-error" bold wrap="truncate" minWidth={0}>
            {drained === null
              ? "NO RUNNER - no drained run in window"
              : `NO RUNNER - queue last drained ${mediaDuration(now - drained)} ago`}
          </Text>
        ) : (
          <Text color={marker.color} wrap="truncate" minWidth={0}>
            {runner.command ?? "resident runner"} <Text color="$fg-muted">[{runner.pid}]</Text>
          </Text>
        )}
      </Box>
      {runnerStale && timing !== null ? (
        <Text color="$fg-error" bold wrap="truncate">
          RUNNER STALE — last tick {mediaDuration(timing.ageMs)} ago
        </Text>
      ) : null}
      {pause === undefined ? null : (
        <>
          <Box height={1} flexShrink={0} />
          <Box height={1} flexDirection="row" gap={1} minWidth={0}>
            <Text color="$fg-warning" flexShrink={0}>
              ×
            </Text>
            <Text color="$fg-warning" wrap="truncate" minWidth={0}>
              <Text bold>STATUS</Text> HOLD THE LINE — {pause.reason} · allowed{" "}
              {pause.allowedPRs.length === 0 ? "none" : pause.allowedPRs.join(",")}
            </Text>
          </Box>
        </>
      )}
    </TitledBox>
  )
}

// The separately bordered FLOW and TIME boxes share one rolling-window model;
// TIME's INTEGRATED/FAILED/WAIT groups stack. They render from
// `time-stats-box.tsx`, which windows the SAME
// consolidated `queueFlowMetrics` aggregate (throughput + per-24h +
// oldestOpenMs, landed 36effce43e) across HR/DAY/WK/MON via `time-stats.ts`.

/** The four operator-facing status buckets (user respec 2026-07-15). */
export type QueueTimelineStatusBucket = "pending" | "running" | "failed" | "done"

export const QUEUE_TIMELINE_STATUS_BUCKETS: readonly QueueTimelineStatusBucket[] = [
  "pending",
  "running",
  "failed",
  "done",
]

/** Bucket a row status: every non-integrated terminal outcome is `failed`; integrated is `done`. */
export function queueTimelineStatusBucket(status: QueueTimelineStatus): QueueTimelineStatusBucket {
  // Every pre-run status (draft/rev/ready) buckets with `todo` (the
  // pending pill), so the default view shows them and the `t` toggle owns them —
  // no new operator pill. See `timelineStatusFilter`.
  if (status === "draft" || status === "rev" || status === "ready") return "pending"
  if (status === "pending" || status === "running") return status
  return status === "integrated" ? "done" : "failed"
}

/** Project CLI-level status filters onto the four display buckets. */
export function queueTimelineFilterBuckets(
  statuses: readonly QueueTimelineStatusFilter[],
): ReadonlySet<QueueTimelineStatusBucket> {
  const buckets = new Set<QueueTimelineStatusBucket>()
  for (const status of statuses) {
    if (status === "pending" || status === "running") buckets.add(status)
    else if (status === "integrated") buckets.add("done")
    else buckets.add("failed")
  }
  return buckets
}

/**
 * The rows the timeline renders. In the default (one-shot print) mode the set
 * is capped to `display.shown` and the residue surfaces as `... N more`. In
 * `fill` mode (the interactive pane, item 5) the cap is dropped and every
 * retained row is returned: the pane's ListView virtualizes and shows as many
 * as physically fit, scrolling the rest, so the row set is bounded by pane
 * height rather than a fixed pre-slice. `fill` widens the set to a superset of
 * the capped prefix, so an externally computed cursor over the capped set stays
 * valid against the fill set.
 */
export function queueTimelineVisibleRows(
  projection: Pick<QueueTimelineProjection, "rows" | "display">,
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>,
  fill = false,
): readonly QueueTimelineProjectedRow[] {
  const rows = fill ? projection.rows : projection.rows.slice(0, projection.display.shown)
  if (visibleBuckets === undefined) return rows
  return rows.filter((row) => visibleBuckets.has(queueTimelineStatusBucket(row.status)))
}

function timelineOutcomeKey(row: QueueTimelineProjectedRow): string {
  return JSON.stringify([row.base, row.pr, row.revision, row.headSha, row.status, row.failure?.code ?? ""])
}

function sameTimelineOutcome(left: QueueTimelineProjectedRow, right: QueueTimelineProjectedRow): boolean {
  return (
    left.group === "completed" && right.group === "completed" && timelineOutcomeKey(left) === timelineOutcomeKey(right)
  )
}

function timelineRepeatKey(row: QueueTimelineProjectedRow, boundaryId: string): string {
  return JSON.stringify([timelineOutcomeKey(row), boundaryId])
}

/**
 * Fold consecutive retries of the same immutable PR revision and terminal
 * outcome for display only. The projection stays lossless for metrics, JSON,
 * detail lookup, and expansion; an expanded group returns every source row.
 */
export function queueTimelineDisplayRows(
  rows: readonly QueueTimelineProjectedRow[],
  expanded: ReadonlySet<string> = new Set(),
): readonly QueueTimelineDisplayRow[] {
  const display: QueueTimelineDisplayRow[] = []
  for (let index = 0; index < rows.length; ) {
    const first = rows[index]
    if (first === undefined) break
    const group = [first]
    let next = index + 1
    while (next < rows.length) {
      const candidate = rows[next]
      if (candidate === undefined || !sameTimelineOutcome(first, candidate)) break
      group.push(candidate)
      next += 1
    }
    const last = group.at(-1) ?? first
    if (group.length === 1 || first.timestamp === null || last.timestamp === null) {
      display.push(...group)
      index = next
      continue
    }
    // The next row is the stable boundary of this occurrence. New retries
    // prepend to a storm, so anchoring on `first.id` would collapse an open
    // group on every refresh; the following row also distinguishes disjoint
    // storms with the same PR/outcome identity.
    const key = timelineRepeatKey(first, rows[next]?.id ?? "$tail")
    const repeat = {
      key,
      count: group.length,
      firstTimestamp: last.timestamp,
      lastTimestamp: first.timestamp,
      collapsed: !expanded.has(key),
    } satisfies QueueTimelineRepeat
    if (repeat.collapsed) display.push({ ...first, repeat })
    else display.push({ ...first, repeat }, ...group.slice(1))
    index = next
  }
  return display
}

export function queueTimelineVisibleDefaultCursorId(
  projection: Pick<QueueTimelineProjection, "rows" | "display">,
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>,
  fill = false,
): string | undefined {
  const rows = queueTimelineVisibleRows(projection, visibleBuckets, fill)
  return queueTimelineDefaultCursorId(rows) ?? rows[0]?.id
}

/** The operator's own wall-clock YYYY-MM-DD, matching the local `getFullYear`
 * / `getMonth` / `getDate` treatment `queueLogClock` already uses for its
 * inline date fallback (UTC is never shown to the operator). */
function timelineLocalCalendarDay(timestamp: string): string {
  const when = new Date(timestamp)
  if (Number.isNaN(when.getTime())) throw new Error(`yrd: invalid queue timeline timestamp '${timestamp}'`)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
}

/**
 * The YYYY-MM-DD (local time) date-header label to show above `current`, or
 * `null` when no header belongs there. A header appears strictly BETWEEN two
 * adjacent visible entries whose local calendar day differs: pass the entry
 * immediately above `current` in on-screen order as `previous`.
 *
 * Design call: `previous === undefined` (the very first visible entry) always
 * returns `null` — there is no leading header above day one. The per-row TIME
 * cell already grows to carry an inline date once the visible window spans
 * more than one day (`includeDate` in `timelineCellLayout`), so the top entry
 * is never ambiguous about which day it belongs to, and a pairwise "only
 * BETWEEN entries" rule needs no special top-of-list case. Either side
 * missing a `timestamp` also suppresses the header — an untimed pending
 * entry carries no day to anchor a boundary to.
 */
export function queueTimelineDateSeparatorLabel(
  previous: QueueTimelineProjectedRow | undefined,
  current: QueueTimelineProjectedRow,
): string | null {
  const previousTimestamp = previous?.timestamp
  if (previousTimestamp === undefined || previousTimestamp === null || current.timestamp === null) return null
  const previousDay = timelineLocalCalendarDay(previousTimestamp)
  const currentDay = timelineLocalCalendarDay(current.timestamp)
  return previousDay === currentDay ? null : currentDay
}

/**
 * The YYYY-MM-DD header to show above the row at `index`. The boundary rule is
 * the r5 rule (a header strictly BETWEEN two adjacent rows whose local calendar
 * day differs). In `leading` mode (the fill pane, item 1) the first timed row
 * ALSO gets a header — the fill TIME cell is time-of-day only, so the top day
 * needs its own anchor; the one-shot print path keeps the boundary-only rule
 * because its inline-date TIME cell already anchors the first day.
 */
export function queueTimelineDateHeaderAt(
  rows: readonly QueueTimelineProjectedRow[],
  index: number,
  leading: boolean,
): string | null {
  const current = rows[index]
  if (current === undefined) return null
  if (leading && index === 0) {
    return current.timestamp === null ? null : timelineLocalCalendarDay(current.timestamp)
  }
  return queueTimelineDateSeparatorLabel(rows[index - 1], current)
}

/**
 * The FILTER row (user respec 2026-07-15): only non-default dimensions render
 * — `since=` always has a value, `terms=` only when terms were passed, `latest`
 * only when on; no `none`/`no`/`all` placeholders. The four status buckets
 * render as checkbox-style indicators that are clickable (pointer toggles) and
 * key-toggled by p/r/f/d in the live watch.
 */
function TimelineFilterLine({
  projection,
  buckets,
  onToggleBucket,
}: {
  projection: QueueTimelineProjection
  buckets: ReadonlySet<QueueTimelineStatusBucket>
  onToggleBucket?: (bucket: QueueTimelineStatusBucket) => void
}) {
  const filters = projection.filters
  // The "FILTER" label text is deleted (item 3): the pills stand alone. The
  // non-default dimensions (`since=` only when the window is bounded, `terms=`
  // only when terms were passed, `latest` only when on) survive as a dim group
  // label; the common unbounded/no-terms watch renders no label at all.
  const bounded = filters.windowMs < QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS
  const dimensions = [
    bounded ? `since=${mediaDuration(filters.windowMs)}` : "",
    filters.terms.length === 0 ? "" : `terms=${filters.terms.join("|")}`,
    filters.latest ? "latest" : "",
  ]
    .filter(Boolean)
    .join(" ")
  // The four status buckets are TogglePills labelled by their plain word with a
  // BOLD first letter (item 3) — `todo`/`running`/`failed`/`done` (pending
  // displays as `todo` per user directive 2026-07-21), the bold
  // `t`/`r`/`f`/`d` doubling as the hotkey hint (no `[t]` brackets). The whole
  // cluster sits very dim and lifts together on hover (silvery TogglePillGroup);
  // clicking a pill toggles its bucket, mirroring the t/r/f/d keys.
  return (
    <TogglePillGroup
      {...(dimensions === "" ? {} : { label: dimensions })}
      flexShrink={0}
      minWidth={0}
      overflow="hidden"
    >
      {QUEUE_TIMELINE_STATUS_BUCKETS.map((bucket) => (
        <TogglePill
          key={bucket}
          label={bucket === "pending" ? "todo" : bucket}
          boldFirstLetter
          active={buckets.has(bucket)}
          onToggle={() => onToggleBucket?.(bucket)}
        />
      ))}
    </TogglePillGroup>
  )
}

/**
 * The one temporal-trust cue, `updated HH:MM:SS`. The snapshot clock is always
 * "now", so day qualification never applies. The QUEUE pane renders it flush
 * against the title border (its `flushTop` drops the top padding) so it reads
 * as aligned with the QUEUE title rather than floating below an offset gap
 * (user directive 2026-07-16).
 */
function QueueUpdatedClock({ now }: { now: string }) {
  return (
    <Text color="$fg-muted" flexShrink={0}>
      updated {queueLogClock(now, false, false)}
    </Text>
  )
}

// The grouped round-5 TIME IA occupies 17 rows beside FLOW or 27 when the
// boxes stack. Preserve fixed queue chrome plus at least two data rows; below
// that pane height, omit the complete secondary metrics pair instead of
// collapsing ListView to a zero-height viewport.
const QUEUE_METRICS_ROW_MIN_PANE_ROWS = 28
const QUEUE_METRICS_STACK_MIN_PANE_ROWS = 38

function ProjectedQueueTimeline({
  projection,
  nav,
  cursorKey,
  onCursor,
  onSelect,
  columns,
  paneChrome = false,
  fillHeight = false,
  availableRows,
  visibleBuckets,
  expandedStorms,
  onToggleBucket,
  listRef,
}: {
  projection: QueueTimelineProjection
  nav: boolean
  cursorKey?: number
  onCursor?: (index: number) => void
  onSelect?: (index: number) => void
  columns: number
  paneChrome?: boolean
  fillHeight?: boolean
  /** Actual queue-pane height when hosted in a split; viewport height otherwise. */
  availableRows?: number
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>
  expandedStorms?: ReadonlySet<string>
  onToggleBucket?: (bucket: QueueTimelineStatusBucket) => void
  listRef?: React.Ref<ListViewHandle>
}) {
  // Fold the complete visible set before applying the one-shot row cap. A
  // retry storm must cost one display line everywhere, not `limit` lines plus
  // a misleading raw-row remainder outside the interactive fill pane.
  const displayRows = queueTimelineDisplayRows(
    queueTimelineVisibleRows(projection, visibleBuckets, true),
    expandedStorms,
  )
  const rows = fillHeight ? displayRows : displayRows.slice(0, projection.display.shown)
  const hiddenDisplayRows = Math.max(0, displayRows.length - rows.length)
  const buckets = visibleBuckets ?? queueTimelineFilterBuckets(projection.filters.statuses)
  // In the fill pane the TIME cell is time-of-day only (item 1) and the day is
  // carried by YYYY-MM-DD header rows (leading + per-boundary, below). The
  // one-shot print path is pinned: it keeps the inline-date TIME cell when the
  // visible window spans more than one local day.
  const includeDate =
    !fillHeight &&
    rows.some((row) => row.timestamp !== null && row.timestamp.slice(0, 10) !== projection.now.slice(0, 10))
  const layout = timelineCellLayout(rows, includeDate, columns)
  const { rows: viewportRows } = useWindowSize()
  const metricsMinPaneRows =
    columns >= TIME_STATS_TWO_ACROSS_MIN_WIDTH ? QUEUE_METRICS_ROW_MIN_PANE_ROWS : QUEUE_METRICS_STACK_MIN_PANE_ROWS
  return (
    <Box width="100%" minWidth={0} minHeight={0} flexGrow={fillHeight ? 1 : undefined}>
      <Box flexGrow={1} flexBasis={0} maxWidth={TIMELINE_CONTENT_CAP} flexDirection="column" minWidth={0} minHeight={0}>
        {paneChrome ? (
          // Pane chrome (item L, 2026-07-16): the QUEUE pane is headed by its
          // tab-style label (no surrounding box); the `updated` clock rides the
          // right of that same tab row (item C — flush with the QUEUE tab).
          <Box height={1} flexDirection="row" gap={1} minWidth={0}>
            <QueueTabsLine base={projection.base} />
            <Box flexGrow={1} flexBasis={0} minWidth={0} />
            {/* The `updated HH:MM:SS` clock is gone from the live pane (user
                directive 2026-07-21): the RUNNER box's always-on border timer
                is the watch view's temporal-trust cue. One-shot prints below
                keep the clock — a static snapshot has no ticking timer. */}
          </Box>
        ) : (
          <>
            <QueueTabsLine base={projection.base} />
            <Box height={1} flexDirection="row" justifyContent="flex-end" gap={1} minWidth={0}>
              <QueueUpdatedClock now={projection.now} />
            </Box>
          </>
        )}
        <TimelineRunnerBox projection={projection} live={nav} />
        {/* No blank row above the table header (item 5): the header sits flush
            under the boxes above it. The pills + coverage row moved BELOW the
            list (item 2), rendered after the rows block. */}
        {rows.length === 0 ? (
          <Text color="$fg-muted">No matching queue rows.</Text>
        ) : (
          // In fill mode (item 5) the row block claims the pane's vertical
          // slack so the virtualizing ListView shows as many rows as fit and
          // scrolls the rest; FLOW/TIME then anchor at the bottom. Off fill it
          // stays content-sized.
          <Box flexDirection="column" minWidth={0} flexShrink={1} minHeight={0} flexGrow={fillHeight ? 1 : undefined}>
            <TimelineHeader layout={layout} />
            <ListView
              ref={listRef}
              items={rows}
              nav={nav}
              cursorKey={cursorKey}
              onCursor={onCursor}
              onSelect={onSelect}
              // Hover must NOT move the selection / detail pane (user directive
              // 2026-07-16, item P). Overriding onItemHover suppresses ListView's
              // default hover→cursor (which fires onCursor and switches the
              // detail); CLICK still selects via the default onSelect path.
              onItemHover={NO_HOVER_SELECT}
              active={true}
              getKey={(row) => row.id}
              // A date-header entry grows one cell to two: the separator sits
              // ABOVE the row inside the same list item, so `items`/`getKey`/
              // `cursorKey`/`onCursor`/`onSelect` all keep their existing
              // one-entry-per-row index contract with the caller (watch-pane's
              // externally computed `cursor` indexes this exact `rows` array).
              estimateHeight={(index) => (queueTimelineDateHeaderAt(rows, index, fillHeight) === null ? 1 : 2)}
              renderItem={(row, index, meta) => {
                const dateSeparator = queueTimelineDateHeaderAt(rows, index, fillHeight)
                const entry = (
                  <TimelineProjectedRow
                    row={row}
                    continuation={
                      index > 0 &&
                      row.run !== undefined &&
                      rows[index - 1]?.base === row.base &&
                      rows[index - 1]?.run === row.run
                    }
                    cursor={meta.isCursor}
                    hovered={meta.isHovered}
                    layout={layout}
                    live={nav}
                  />
                )
                return dateSeparator === null ? (
                  entry
                ) : (
                  <Box flexDirection="column">
                    <Text variant="h1">{dateSeparator}</Text>
                    {entry}
                  </Box>
                )
              }}
            />
          </Box>
        )}
        {/* An empty fill pane's spacer pushes the pills + FLOW/TIME boxes to
            the bottom; a non-empty fill pane grows its row block instead, so no
            spacer competes with it. */}
        {fillHeight && rows.length === 0 ? <Box flexGrow={1} minHeight={0} /> : null}
        {/* FILTER pills + coverage row — BELOW the list (item 2, new vertical
            order optional STATUS → header → rows → pills → FLOW/TIME). The "... N more" /
            retained coverage reads on the left, the very-dim toggle-pills
            right-align. In fill mode the coverage degrades to EMPTY (the rows
            virtualize and scroll, so nothing is permanently hidden — no "... 0
            more"); the pills always render. Off fill the coverage renders as
            W1b placed it. */}
        <Box height={1} flexDirection="row" justifyContent="space-between" gap={2} minWidth={0} overflow="hidden">
          <Box flexDirection="row" gap={1} minWidth={0} flexShrink={1}>
            {fillHeight || hiddenDisplayRows === 0 ? null : (
              <Text color="$fg-muted" wrap="truncate">
                ... {hiddenDisplayRows} more
              </Text>
            )}
            {fillHeight || projection.coverage.complete ? null : (
              <Text color="$fg-warning" wrap="truncate">
                retained since {projection.coverage.retainedSince}
              </Text>
            )}
          </Box>
          <TimelineFilterLine projection={projection} buckets={buckets} onToggleBucket={onToggleBucket} />
        </Box>
        {!fillHeight ||
        (availableRows ?? viewportRows) === 0 ||
        (availableRows ?? viewportRows) >= metricsMinPaneRows ? (
          <TimeStatsBox
            facts={projection.timeStatsFacts}
            now={projection.now}
            earliestEventMs={projection.earliestEventMs}
            width={columns}
          />
        ) : null}
      </Box>
    </Box>
  )
}

export function QueueTimelineView({
  projection,
  results,
  now,
  latest = false,
  state,
  nav = false,
  cursorKey,
  onCursor,
  onSelect,
  columns = 120,
  paneChrome = false,
  fillHeight = false,
  availableRows,
  visibleBuckets,
  expandedStorms,
  onToggleBucket,
  listRef,
}: {
  projection?: QueueTimelineProjection
  results?: readonly QueueStatusResult[]
  now?: number
  latest?: boolean
  state?: BaysState
  nav?: boolean
  cursorKey?: number
  onCursor?: (index: number) => void
  onSelect?: (index: number) => void
  columns?: number
  paneChrome?: boolean
  fillHeight?: boolean
  availableRows?: number
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>
  expandedStorms?: ReadonlySet<string>
  onToggleBucket?: (bucket: QueueTimelineStatusBucket) => void
  listRef?: React.Ref<ListViewHandle>
}) {
  if (projection !== undefined) {
    // 15e: the list is left-flush — no gutter, no centering; the surface
    // still caps at 160 cells on wide viewports.
    const surfaceWidth = Math.max(1, Math.min(columns, TIMELINE_CONTENT_CAP))
    return (
      <ProjectedQueueTimeline
        projection={projection}
        nav={nav}
        cursorKey={cursorKey}
        onCursor={onCursor}
        onSelect={onSelect}
        columns={surfaceWidth}
        paneChrome={paneChrome}
        fillHeight={fillHeight}
        availableRows={availableRows}
        visibleBuckets={visibleBuckets}
        expandedStorms={expandedStorms}
        onToggleBucket={onToggleBucket}
        listRef={listRef}
      />
    )
  }
  if (results === undefined || now === undefined) {
    throw new Error("yrd: queue timeline requires results and snapshot time")
  }
  const rows = queueTimelineRows(results, now, latest, state)
  return (
    <Box flexDirection="column">
      {results.map((result) => (
        <SummaryQueue key={result.base} projection={humanQueueProjection(result, now)} />
      ))}
      {rows.length === 0 ? (
        <Text color="$fg-muted">No matching queue rows.</Text>
      ) : (
        <ListView
          ref={listRef}
          items={rows}
          nav={nav}
          cursorKey={cursorKey}
          onCursor={onCursor}
          onSelect={onSelect}
          active={true}
          getKey={(row) => row.key}
          estimateHeight={1}
          renderItem={(row, _index, meta) => (
            <Box height={1}>
              <Text wrap="truncate">
                {meta.isCursor ? "> " : "  "}
                <Text bold>{row.clock}</Text> <Text bold>{row.status}</Text>{" "}
                <QueuePrId pr={row.pr} revision={row.revision} />{" "}
                {row.run === undefined ? "-" : <QueueRunId base={row.base} run={row.run} />} {row.subject}{" "}
                <Text color="$fg-muted">{row.detail}</Text>
              </Text>
            </Box>
          )}
        />
      )}
    </Box>
  )
}

export function queueLogRows(
  results: readonly QueueLogResult[],
  selectedPrs: ReadonlySet<string>,
  prFilter: string | undefined,
  prStatus?: ReadonlyMap<string, PR["status"]>,
  attempts: readonly QueueLogAttempt[] = [],
  revisionSubjects: ReadonlyMap<string, string> = new Map(),
  revisionClocks?: ReadonlyMap<string, PRRunRevisionClock>,
): QueueLogRow[] {
  const rows: QueueLogRow[] = []
  const finished = results.flatMap((result) => result.finished)

  for (const result of results) {
    for (const run of result.finished) {
      for (const pr of run.prs) {
        if (selectedPrs.size > 0 && !selectedPrs.has(pr.id)) continue
        if (prFilter !== undefined && pr.id !== prFilter) continue
        const outcome = queueOutcome(run)
        if (outcome === "running" || outcome === "waiting") continue

        const runError =
          run.error?.message ??
          run.steps
            .toReversed()
            .map((step) => step.job)
            .find((job) => job?.status === "failed")?.error?.message ??
          "-"
        const location = runLocation(run)
        const locations = runLocations(run)
        const runAttempts = attempts.filter((attempt) => attempt.run === run.id)
        const attemptSummaries = runAttempts.map(
          ({
            job,
            run: attemptRun,
            step,
            index,
            attempt,
            runner,
            outcome: attemptOutcome,
            startedAt,
            finishedAt,
            durationMs,
          }) => ({
            job,
            run: attemptRun,
            step,
            index,
            attempt,
            runner,
            outcome: attemptOutcome,
            ...taskStatusFields(jobAttemptTaskStatusOf({ outcome: attemptOutcome })),
            startedAt,
            finishedAt,
            durationMs,
          }),
        )
        const durations = runDurations(run, runAttempts)
        const durationMs = durations.totalDurationMs
        const finishedAt = run.finishedAt === undefined ? undefined : toIso(run.finishedAt)
        const submittedAt = queueLogSubmissionTime(revisionClocks, run, pr)
        const ageMs = elapsedMs(submittedAt, finishedAt, `PR '${pr.id}' submitted-to-terminal age`)
        const showLocation = prStatus?.get(pr.id) === "withdrawn" ? undefined : location
        const taskStatus = runTaskStatusOf(run)
        rows.push({
          run: run.id,
          base: run.base,
          pr: pr.id,
          branch: pr.branch,
          subject: revisionSubjects.get(queueRevisionKey(pr)) ?? pr.branch,
          ...taskStatusFields(taskStatus),
          revision: String(pr.revision),
          headSha: pr.headSha,
          baseSha: pr.baseSha ?? "-",
          outcome,
          startedAt: toIso(run.startedAt),
          ...(finishedAt === undefined ? {} : { finishedAt }),
          submittedAt,
          started: toIso(run.startedAt),
          finished: finishedAt ?? "-",
          age: ageMs === undefined ? "-" : preciseDuration(ageMs),
          ...(ageMs === undefined ? {} : { ageMs }),
          duration: duration(run.startedAt, run.finishedAt),
          ...(durationMs === undefined ? {} : { durationMs }),
          totalDuration: durationMs === undefined ? "-" : preciseDuration(durationMs),
          ...(durationMs === undefined ? {} : { totalDurationMs: durationMs }),
          activeDuration: durations.activeDurationMs === undefined ? "-" : preciseDuration(durations.activeDurationMs),
          ...(durations.activeDurationMs === undefined ? {} : { activeDurationMs: durations.activeDurationMs }),
          waitDuration: durations.waitDurationMs === undefined ? "-" : preciseDuration(durations.waitDurationMs),
          ...(durations.waitDurationMs === undefined ? {} : { waitDurationMs: durations.waitDurationMs }),
          attempts: attemptSummaries,
          activeSteps: durations.activeSteps,
          retries: String(Math.max(0, runOutputQueueageIndex(finished, run, pr.revision, pr.id))),
          landing: queueLanding(run),
          integration: outcome === "integrated" && run.status === "passed" ? queueOutcomeIntegration(run) : undefined,
          parent: run.parent ?? "-",
          isolationPart: isolationPartLabel(run),
          result: safeText(run.prs.length > 0 ? run.prs : ["-"]),
          error: safeText(runError),
          ...correlationField(pr),
          locations,
          ...(showLocation === undefined
            ? {}
            : "path" in showLocation
              ? { location: { path: showLocation.path } }
              : { location: { url: showLocation.url } }),
        })
      }
    }
  }

  if (prFilter !== undefined) {
    const runPrs = prStatus
    const status = runPrs?.get(prFilter)
    const matching = rows.filter((row) => row.pr === prFilter)
    if (status === "withdrawn" && matching.length === 0) {
      const currentPr = results.flatMap((result) => result.prs ?? []).find((pr) => pr.id === prFilter)
      const exampleResult =
        currentPr ??
        Array.from(results)
          .flatMap((result) => result.finished)
          .flatMap((run) => run.prs)
          .find((candidate) => candidate.id === prFilter)
      const headSha = (exampleResult?.headSha ?? "-").slice(0, 40)
      const baseSha = (exampleResult?.baseSha ?? "-").slice(0, 40)
      const taskStatus = runTaskStatusOf({ status: "retired" })
      rows.push({
        run: "-",
        base: exampleResult?.base ?? "-",
        pr: prFilter,
        branch: exampleResult?.branch ?? "-",
        subject:
          (exampleResult === undefined ? undefined : revisionSubjects.get(queueRevisionKey(exampleResult))) ??
          exampleResult?.branch ??
          prFilter,
        ...taskStatusFields(taskStatus),
        revision: String(exampleResult?.revision ?? 0),
        headSha,
        baseSha,
        outcome: "retired",
        startedAt: "-",
        started: "-",
        finished: "-",
        age: "-",
        duration: "-",
        totalDuration: "-",
        activeDuration: "-",
        waitDuration: "-",
        attempts: [],
        activeSteps: [],
        retries: "0",
        landing: "-",
        parent: "-",
        isolationPart: "-",
        result: "-",
        error: "-",
        ...correlationField(exampleResult),
        locations: [],
      })
    }
  }

  return rows.toSorted((left, right) => {
    const leftAt = Date.parse(left.started)
    const rightAt = Date.parse(right.started)
    if (Number.isNaN(leftAt) && Number.isNaN(rightAt)) {
      return byRunStarted(
        { id: left.run, startedAt: left.started, base: left.base } as QueueRun,
        { id: right.run, startedAt: right.started, base: right.base } as QueueRun,
      )
    }
    if (Number.isNaN(leftAt)) return 1
    if (Number.isNaN(rightAt)) return -1
    if (leftAt !== rightAt) return leftAt - rightAt
    return parseRunIdSuffix(left.run) - parseRunIdSuffix(right.run)
  })
}

function correlationField(pr: QueueRun["prs"][number] | PR | undefined): Readonly<{ correlation?: Correlation }> {
  const correlation = pr?.correlation
  if (correlation === undefined) return {}
  return { correlation }
}

function queueShowStepRow(run: QueueRun, step: QueueStep): QueueShowRow {
  const location = artifactLocation(step)
  const locations = stepLocations(step)
  const command = stepCommand(step)
  const taskStatus = stepTaskStatusOf(step)
  const stepFailure = failureFact(undefined, step)
  const gate = step.job !== undefined && "output" in step.job ? gateEvidenceFromOutput(step.job.output) : undefined
  const stepDurationMs =
    step.job === undefined || !("startedAt" in step.job) || !("finishedAt" in step.job)
      ? undefined
      : elapsedMs(step.job.startedAt, step.job.finishedAt)
  return {
    step: step.name,
    revision: step.revision,
    status: jobStatus(step),
    ...taskStatusFields(taskStatus),
    attempt: step.job === undefined ? "-" : String(step.job.attempt),
    uuid: step.job?.id ?? "-",
    runner: step.job !== undefined && "runner" in step.job ? step.job.runner : "-",
    lease: step.job?.status === "running" ? toIso(step.job.leaseExpiresAt) : "-",
    requested: step.job === undefined ? "-" : toIso(step.job.requestedAt),
    started: step.job === undefined || !("startedAt" in step.job) ? "-" : toIso(step.job.startedAt),
    changed: step.job === undefined ? "-" : toIso(step.job.changedAt),
    finished:
      step.job === undefined || step.job.status === "running" || step.job.status === "requested"
        ? "-"
        : toIso((step.job as { finishedAt?: string } | undefined)?.finishedAt),
    duration: step.job === undefined ? "-" : stepDuration(step),
    ...(stepDurationMs === undefined ? {} : { durationMs: stepDurationMs }),
    ...(command === undefined ? {} : { command }),
    errorCode: stepErrorCode(step),
    error: stepError(step),
    ...(stepFailure === undefined ? {} : { failure: projectFailure(stepFailure) }),
    lost: stepLost(step),
    detail: stepDetail(step),
    output: stepOutput(step),
    artifacts: stepArtifactsText(step),
    evidence: stepEvidence(step, gate),
    ...(gate === undefined ? {} : { gate }),
    checkpoint: stepCheckpointText(step),
    landing: queueLanding(run),
    locations,
    ...(location === undefined ? {} : { location }),
  }
}

function queueShowAttemptRow(run: QueueRun, attempt: QueueAttempt): QueueShowRow {
  const step = run.steps[attempt.index] ?? run.steps.find((candidate) => candidate.name === attempt.step)
  if (step?.job?.id === attempt.job && step.job.attempt === attempt.attempt) {
    return {
      ...queueShowStepRow(run, step),
      requested: toIso(attempt.requestedAt),
      started: toIso(attempt.startedAt),
      finished: toIso(attempt.finishedAt),
      duration: preciseDuration(attempt.durationMs),
      durationMs: attempt.durationMs,
    }
  }

  const output = attempt.result.status === "lost" ? undefined : attempt.result.output
  const gate = gateEvidenceFromOutput(output)
  const locations = attemptLocations(attempt)
  const firstLocation = locations[0]?.location
  const artifacts = attemptArtifacts(attempt)
  const detail = isObjectValue(output) && typeof output.detail === "string" ? output.detail : undefined
  const taskStatus = jobAttemptTaskStatusOf(attempt)
  const attemptFailure =
    attempt.result.status === "failed"
      ? projectFailure(attempt.result.error)
      : attempt.result.status === "lost"
        ? projectFailure({ code: "job-lost", message: attempt.result.reason })
        : undefined
  return {
    step: attempt.step,
    revision: attempt.revision,
    status: attempt.outcome,
    ...taskStatusFields(taskStatus),
    attempt: String(attempt.attempt),
    uuid: attempt.job,
    runner: attempt.runner,
    lease: "-",
    requested: toIso(attempt.requestedAt),
    started: toIso(attempt.startedAt),
    changed: toIso(attempt.finishedAt),
    finished: toIso(attempt.finishedAt),
    duration: preciseDuration(attempt.durationMs),
    durationMs: attempt.durationMs,
    errorCode: attempt.result.status === "failed" ? attempt.result.error.code : "-",
    error: attempt.result.status === "failed" ? attempt.result.error.message : "-",
    ...(attemptFailure === undefined ? {} : { failure: attemptFailure }),
    lost: attempt.result.status === "lost" ? attempt.result.reason : "-",
    detail: detail ?? (attempt.result.status === "failed" ? attempt.result.error.message : "-"),
    output:
      attempt.result.status === "lost"
        ? "-"
        : safeText(attempt.result.output ?? (attempt.result.status === "failed" ? attempt.result.error : undefined)),
    artifacts: artifacts.length === 0 ? "-" : artifactLabel(artifacts[0]),
    evidence:
      gate === undefined
        ? isObjectValue(output)
          ? output
          : "-"
        : isObjectValue(output)
          ? { ...output, gate: gateEvidenceLabel(gate) }
          : { gate: gateEvidenceLabel(gate) },
    ...(gate === undefined ? {} : { gate }),
    checkpoint: "-",
    landing: queueLanding(run),
    locations,
    ...(firstLocation === undefined ? {} : { location: firstLocation }),
  }
}

export function queueShowData(
  run: QueueRun,
  allRuns: readonly QueueRun[] = [],
  attempts: readonly QueueAttempt[] = [],
  revisionClock?: PRRunRevisionClock,
): QueueShowData {
  const finished = allRuns.filter((candidate) => candidate.status === "passed" || candidate.status === "failed")
  const runAttempts = attempts
    .filter((attempt) => attempt.run === run.id)
    .toSorted((left, right) => left.index - right.index || left.attempt - right.attempt)
    .map((attempt) => ({ ...attempt, ...taskStatusFields(jobAttemptTaskStatusOf(attempt)) }))
  const durations = runDurations(run, runAttempts)
  const runDurationMs = durations.totalDurationMs
  const taskStatus = runTaskStatusOf(run)
  const runFailure = failureFact(run, relevantStep(run))
  return {
    run: run.id,
    base: run.base,
    status: run.status,
    ...taskStatusFields(taskStatus),
    outcome: queueOutcome(run),
    started: toIso(run.startedAt),
    finished: run.finishedAt === undefined ? "-" : toIso(run.finishedAt),
    duration: runDurationMs === undefined ? "-" : preciseDuration(runDurationMs),
    ...(runDurationMs === undefined ? {} : { durationMs: runDurationMs }),
    totalDuration: runDurationMs === undefined ? "-" : preciseDuration(runDurationMs),
    ...(runDurationMs === undefined ? {} : { totalDurationMs: runDurationMs }),
    activeDuration: durations.activeDurationMs === undefined ? "-" : preciseDuration(durations.activeDurationMs),
    ...(durations.activeDurationMs === undefined ? {} : { activeDurationMs: durations.activeDurationMs }),
    waitDuration: durations.waitDurationMs === undefined ? "-" : preciseDuration(durations.waitDurationMs),
    ...(durations.waitDurationMs === undefined ? {} : { waitDurationMs: durations.waitDurationMs }),
    retries: queueShowRetries(finished, run),
    landing: queueLanding(run),
    integration: run.status === "passed" ? queueIntegration(run) : undefined,
    parent: run.parent ?? "-",
    isolationPart: isolationPartLabel(run),
    ...(runFailure === undefined ? {} : { failure: projectFailure(runFailure) }),
    prs: run.prs,
    ...(revisionClock === undefined ? {} : { revisionClock }),
    attempts: runAttempts,
    steps:
      runAttempts.length === 0
        ? run.steps.map((step) => queueShowStepRow(run, step))
        : runAttempts.map((attempt) => queueShowAttemptRow(run, attempt)),
  }
}

export function QueueLogView({
  rows,
  coverage,
  columns = 120,
}: {
  rows: readonly QueueLogRow[]
  coverage?: QueueLogCoverage
  columns?: number
}) {
  const compact = columns <= 80
  const visibleRows = rows.toReversed().slice(0, 20)
  const visibleDates = new Set(
    visibleRows.flatMap((row) => {
      const timestamp = Date.parse(row.startedAt)
      return Number.isFinite(timestamp) ? [new Date(timestamp).toISOString().slice(0, 10)] : []
    }),
  )
  const includeDate = visibleDates.size > 1
  const tableRows = visibleRows.map((row) => ({
    ...row,
    clock: queueLogClock(row.startedAt, false, includeDate),
    level: queueLogLevel(row.outcome),
    baseLabel: `[${row.base}]`,
    runIdentity: formatNounId(row.base, runIdValue(row.run)),
    ageValue: `age=${row.ageMs === undefined ? "-" : relativeAge(row.ageMs)}`,
    totalValue: `total=${row.totalDurationMs === undefined ? "-" : mediaDuration(row.totalDurationMs)}`,
    activeValue: `active=${row.activeDurationMs === undefined ? "-" : mediaDuration(row.activeDurationMs)}`,
    waitValue: `wait=${row.waitDurationMs === undefined ? "-" : mediaDuration(row.waitDurationMs)}`,
  }))
  const identityColumns = compact
    ? []
    : [
        { header: "LEVEL", key: "level" as const, width: 5 },
        { header: "BASE", key: "baseLabel" as const, width: 12 },
      ]
  const logColumns = [
    { header: "TIME", key: "clock" as const, width: includeDate ? 21 : 9 },
    ...identityColumns,
    {
      header: "PR",
      key: "pr" as const,
      minWidth: compact ? 8 : 10,
      maxWidth: compact ? 12 : 16,
      render: (row: (typeof tableRows)[number]) => <QueuePrId pr={row.pr} revision={row.revision} />,
    },
    { header: "RUN", key: "runIdentity" as const, minWidth: compact ? 8 : 10, maxWidth: compact ? 12 : 18 },
    { header: "OUTCOME", key: "outcome" as const, maxWidth: 13 },
    ...(compact
      ? []
      : [
          {
            header: "ART",
            key: "locations" as const,
            width: 9,
            render: (row: (typeof tableRows)[number]) => <QueueLogLocationLinks entries={row.locations} compact />,
          },
        ]),
    { header: "SUBJECT", key: "subject" as const, minWidth: 0, grow: true },
    { header: "AGE", key: "ageValue" as const, align: "right" as const },
    { header: "TOTAL", key: "totalValue" as const, align: "right" as const },
    { header: "ACTIVE", key: "activeValue" as const, align: "right" as const },
    { header: "WAIT", key: "waitValue" as const, align: "right" as const },
  ]
  const hidden = Math.max(0, rows.length - visibleRows.length)
  void coverage
  return (
    <Box flexDirection="column">
      {rows.length === 0 ? (
        <Text color="$fg-muted">No matching terminal log rows.</Text>
      ) : (
        <Table data={tableRows} columns={logColumns} padding={1} showHeader={false} />
      )}
      {hidden === 0 ? null : <Text color="$fg-muted">... {hidden} more</Text>}
    </Box>
  )
}

function queueShowNextAction(data: QueueShowData): string {
  if (data.outcome === "integrated") return "none — landing proof is recorded"
  if (data.status === "running" || data.status === "waiting") return "follow live output or wait for the current step"
  const actionable = data.failure ?? data.steps.findLast((step) => step.failure !== undefined)?.failure
  if (actionable !== undefined) return actionable.resolution.join("; then ")
  const errorCode = data.steps.find((step) => step.errorCode !== "-")?.errorCode
  if (errorCode === "queue-environment-refused") {
    return "repair the queue environment, then rerun the PR"
  }
  if (["stale-pr", "stale-check", "stale-base"].includes(errorCode ?? "")) {
    return "refresh the current PR revision against queue authority, then rerun it"
  }
  if (errorCode === "job-lost") return "recover the lost run, then rerun the PR"
  if (["canceled", "cancelled", "queue-canceled", "queue-cancelled"].includes(errorCode ?? "")) {
    return "inspect the newer PR revision; resubmit only if delivery is still required"
  }
  return "fix the branch, then run yrd pr submit again"
}

function QueueShowMembersValue({ data, highlightPr }: { data: QueueShowData; highlightPr?: string }) {
  return (
    <>
      {data.prs.map((pr, index) => (
        <Text key={pr.id} color={pr.id === highlightPr ? "$fg-warning" : undefined}>
          {index === 0 ? "" : ","}
          <QueuePrId pr={pr.id} revision={pr.revision} />:{pr.headSha.slice(0, 12)}
        </Text>
      ))}
    </>
  )
}

// The batched-members group is called `PRs`, never `MEMBERS`. The list-selected
// member stays visibly highlighted so shared Run steps/logs do not erase which
// row the user chose.
function QueueShowMembersLine({ data, highlightPr }: { data: QueueShowData; highlightPr?: string }) {
  return (
    <Text wrap="truncate">
      PRs <QueueShowMembersValue data={data} highlightPr={highlightPr} />
    </Text>
  )
}

/**
 * Detail facts render only PRESENT facts (user respec 2026-07-15) — the same
 * non-default-only rule as the FILTER row. `-` placeholders never render.
 */
function presentFact(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" || trimmed === "-" ? undefined : trimmed
}

function queueGateSummary(data: QueueShowData): string | undefined {
  const gates = data.steps.flatMap((step) => (step.gate === undefined ? [] : [step.gate]))
  const [first] = gates
  if (first === undefined) return undefined
  const modes = new Set(gates.map(({ mode }) => mode))
  if (modes.size === 1) {
    return gateEvidenceLabel({
      mode: first.mode,
      residualCount: gates.reduce((total, { residualCount }) => total + residualCount, 0),
    })
  }
  return gates.map(gateEvidenceLabel).join(", ")
}

/** Dedupe `X@X` landings (commit == landing sha) to one SHA. */
export function queueLandingLabel(landing: string): string {
  const [commit, base, ...rest] = landing.split("@")
  if (rest.length === 0 && commit !== undefined && base !== undefined && commit === base) return commit
  return landing
}

/**
 * Detail timestamps share the timeline's clock convention: local HH:MM:SS,
 * date-qualified only across day boundaries (relative to the local today).
 */
function detailClock(value: string): string {
  if (presentFact(value) === undefined) return value
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return value
  const includeDate = when.toDateString() !== new Date().toDateString()
  return queueLogClock(value, false, includeDate)
}

function QueueProofView({ data }: { data: QueueShowData }) {
  return (
    <Box flexDirection="column">
      {data.steps.length === 0 ? (
        <Text color="$fg-muted">No step evidence recorded.</Text>
      ) : (
        data.steps.map((row) => {
          const evidence = presentFact(typeof row.evidence === "string" ? row.evidence : safeText(row.evidence))
          const checkpoint = presentFact(row.checkpoint)
          return (
            <Box key={`${row.uuid}:${row.attempt}:proof`} height={1}>
              <Text wrap="truncate">
                {`PROOF ${row.step}#${row.attempt}`}
                {row.locations.length === 0 ? null : (
                  <>
                    {" ART "}
                    <QueueLogLocationLinks entries={row.locations} compact={false} />
                  </>
                )}
                {evidence === undefined ? "" : ` EVIDENCE ${evidence}`}
                {checkpoint === undefined ? "" : ` CHECKPOINT ${checkpoint}`}
              </Text>
            </Box>
          )
        })
      )}
      {presentFact(data.landing) === undefined ? null : (
        <Text>
          LANDING <Text color="$fg-muted">{queueLandingLabel(data.landing)}</Text>
        </Text>
      )}
    </Box>
  )
}

export function QueueEvidenceView({ data }: { data: QueueShowData }) {
  return (
    <Box flexDirection="column">
      <Text bold>EVIDENCE {data.run}</Text>
      <QueueProofView data={data} />
    </Box>
  )
}

// Integration proof beyond the landed SHA (item J, 2026-07-16): the count of
// source rewrites + submodule resolutions the queue carried into the merge.
function integrationProofDetail(integration: IntegrationProof): string | undefined {
  const parts: string[] = []
  if (integration.sourceRewrites !== undefined && integration.sourceRewrites.length > 0) {
    parts.push(`REWRITES ${integration.sourceRewrites.length}`)
  }
  if (integration.submoduleResolutions !== undefined && integration.submoduleResolutions.length > 0) {
    parts.push(`SUBMODULES ${integration.submoduleResolutions.length}`)
  }
  return parts.length === 0 ? undefined : parts.join(" ")
}

/** Merge-owned landing facts shared by one-shot detail and the watch merge tab. */
export function QueueIntegrationFacts({ data }: { data: QueueShowData }) {
  if (data.integration === undefined) return null
  const proofDetail = integrationProofDetail(data.integration)
  return (
    <Box flexDirection="column" minWidth={0}>
      <Text wrap="truncate">
        Committed as {data.integration.commit} on {data.base}
      </Text>
      {proofDetail === undefined ? null : <Text wrap="wrap">- integration proof: {proofDetail}</Text>}
    </Box>
  )
}

function prReviewLine(review: PR["reviews"][number]): string {
  const note = presentFact(review.note)
  return `REVIEW ${review.decision} ${review.actor} ${detailClock(review.at)}${note === undefined ? "" : ` — ${note}`}`
}

function prCommentLine(comment: PR["comments"][number]): string {
  const note = presentFact(comment.note)
  return `COMMENT ${comment.actor} ${detailClock(comment.at)}${note === undefined ? "" : ` — ${note}`}`
}

/**
 * The selected PR's unlabelled title + linked ISSUE, surfaced directly under
 * the DETAIL identity row
 * so they read without expanding the PRS disclosure (item b, 2026-07-16). The
 * fuller DESCRIPTION / review history stays in the disclosure. Empty fields
 * omit (pre-r5 PRs carry neither — no placeholders). In a batch, the selected
 * member still owns this header while the disclosure carries every member.
 */
export function QueueDetailSinglePrHeader({ pr }: { pr: PR }) {
  // PR `name` is the durable subject for older/pending records that predate
  // the optional richer `title` field. One template must not make pending rows
  // lose their subject merely because no Run exists yet.
  const title = presentFact(pr.title) ?? presentFact(pr.name)
  const issue = presentFact(pr.issue)
  if (title === undefined && issue === undefined) return null
  return (
    <Box flexDirection="column" minWidth={0}>
      {title === undefined ? null : (
        <>
          <Box height={1} flexShrink={0} />
          <Text bold wrap="truncate" bgConflict="ignore">
            {title}
          </Text>
          <Box height={1} flexShrink={0} />
        </>
      )}
      {issue === undefined ? null : (
        <Text wrap="truncate">
          {"ISSUE".padEnd(9, " ")}
          <IssueValue issue={issue} />
        </Text>
      )}
    </Box>
  )
}

function runFailureReason(data: QueueShowData | undefined): string | undefined {
  if (data?.failure !== undefined) return data.failure.summary
  const failed = data?.steps.findLast(
    (step) =>
      presentFact(step.errorCode) !== undefined ||
      presentFact(step.error) !== undefined ||
      presentFact(step.lost) !== undefined ||
      presentFact(step.detail) !== undefined,
  )
  if (failed === undefined) return undefined
  const code = presentFact(failed.errorCode)
  const message = presentFact(failed.error) ?? presentFact(failed.lost) ?? presentFact(failed.detail)
  if (code === undefined) return message
  return actionableFailureSummary(actionableFailure({ code, message: message ?? "failed" }))
}

function prLineageLines(pr: PR, memberRevision: number, runDetails: readonly QueueShowData[]): readonly string[] {
  const terminal = prRevisionClocks(pr)
    .filter((clock) => clock.revision <= memberRevision)
    .flatMap((clock) => {
      if (clock.terminal === undefined) return []
      const submittedAt = clock.submittedAt ?? clock.pushedAt
      const ageMs = elapsedMs(submittedAt, clock.terminal.at, `PR '${pr.id}' revision ${clock.revision} terminal age`)
      const reason =
        clock.terminal.status === "rejected"
          ? (runFailureReason(runDetails.find((detail) => detail.run === clock.terminal?.run)) ?? "reason not recorded")
          : undefined
      const suffix = reason !== undefined ? ` (${reason})` : ageMs === undefined ? "" : ` (age ${mediaDuration(ageMs)})`
      return [
        {
          at: clock.terminal.at,
          line: `${queueLogClock(clock.terminal.at, true, false)} r${clock.revision} ${clock.terminal.status}${suffix}`,
        },
      ]
    })
  const submitted = pr.revisions.find((candidate) => candidate.revision === memberRevision)
  const entries =
    submitted === undefined
      ? terminal
      : [
          ...terminal,
          {
            at: submitted.submittedAt ?? submitted.pushedAt,
            line: `${queueLogClock(submitted.submittedAt ?? submitted.pushedAt, true, false)} submitted by ${submitted.actor ?? "-"}`,
          },
        ]
  // The detail timeline reads strictly newest-first (user directive
  // 2026-07-21): the selected revision's submit sorts among earlier
  // revisions' terminals instead of always trailing them.
  return entries.toSorted((left, right) => right.at.localeCompare(left.at)).map((entry) => entry.line)
}

function prDetailFacts(pr: PR, revision: number): readonly Readonly<{ key: string; value: string }>[] {
  const retained = pr.revisions.find((candidate) => candidate.revision === revision)
  const correlation = retained?.correlation ?? pr.correlation
  const note = presentFact(pr.note)
  const detail = presentFact(pr.detail)
  const requestedReviewers = pr.requestedReviewers ?? []
  const facts: Readonly<{ key: string; value: string }>[] = [
    ...(note === undefined ? [] : [{ key: "note", value: note }]),
    ...(detail === undefined ? [] : [{ key: "detail", value: detail }]),
    ...(correlation === undefined ? [] : [{ key: "correlation", value: `${correlation.namespace}:${correlation.id}` }]),
    { key: "head", value: retained?.headSha ?? pr.headSha },
    { key: "base", value: retained?.base ?? pr.base },
    ...(retained?.recut === undefined ? [] : [{ key: "recut", value: boundedQueue(safeText(retained.recut), 160) }]),
    ...(retained?.composition === undefined
      ? []
      : [{ key: "composition", value: boundedQueue(safeText(retained.composition), 160) }]),
    ...pr.reviews.map((review) => ({
      key: "review",
      value: `${review.decision} by ${review.actor} at ${queueLogClock(review.at, true, false)}${presentFact(review.note) === undefined ? "" : ` — ${presentFact(review.note)}`}`,
    })),
    ...pr.comments.map((comment) => ({
      key: "comment",
      value: `${comment.actor} at ${queueLogClock(comment.at, true, false)} — ${comment.note}`,
    })),
    ...pr.checkRequests.map((request) => ({
      key: "check requested",
      value: queueLogClock(request.at, true, false),
    })),
    ...(requestedReviewers.length === 0 ? [] : [{ key: "requested reviewers", value: requestedReviewers.join(", ") }]),
    ...((pr.regressions?.length ?? 0) === 0
      ? []
      : [{ key: "regressions", value: boundedQueue(safeText(pr.regressions), 160) }]),
  ]
  return facts
}

/**
 * The PR-scoped detail header (user directive 2026-07-21, supersedes Round-6
 * Revision A v4's run-scoped member blocks): the detail view is FOR a PR, so
 * this block leads the pane body — branch under the identity title, then the
 * bold subject, then the newest-first timeline, then the aligned KEY/value
 * facts. `titleAbove` drops the identity row when the pane title (see
 * QueueDetailTitle) already owns it.
 */
export function QueueDetailRunPrBlocks({
  data,
  row,
  rows,
  prs,
  runDetails = [],
  titleAbove = false,
  position,
}: {
  data?: QueueShowData
  row?: QueueTimelineProjectedRow
  rows: readonly QueueTimelineProjectedRow[]
  prs: readonly PR[]
  runDetails?: readonly QueueShowData[]
  /** True when QueueDetailTitle renders the pr#id + ISSUE identity above. */
  titleAbove?: boolean
  /** Queue position for pending rows, rendered as one more KEY/value fact. */
  position?: number
}) {
  const members =
    data?.prs ??
    (row === undefined
      ? []
      : [{ id: row.pr, revision: row.revision, headSha: row.headSha, branch: row.branch, base: row.base }])
  if (members.length === 0) return null
  return (
    <Box flexDirection="column" minWidth={0} flexShrink={0} color="$fg">
      {members.map((member, index) => {
        const memberRow = rows.find(
          (candidate) =>
            candidate.pr === member.id &&
            candidate.revision === member.revision &&
            candidate.headSha === member.headSha,
        )
        const pr = prs.find((candidate) => candidate.id === member.id)
        const subject =
          presentFact(pr?.title) ?? presentFact(member.name) ?? presentFact(pr?.name) ?? memberRow?.subject
        const description = presentFact(pr?.description)
        const issue = presentFact(pr?.issue)
        const lineage =
          pr === undefined
            ? memberRow?.timestamp === null || memberRow?.timestamp === undefined
              ? []
              : [`${queueLogClock(memberRow.timestamp, true, false)} submitted by ${memberRow.submitter ?? "-"}`]
            : prLineageLines(pr, member.revision, runDetails)
        const facts = [
          ...(position === undefined ? [] : [{ key: "position", value: String(position) }]),
          ...(pr === undefined ? [] : prDetailFacts(pr, member.revision)),
        ]
        const factKeyWidth = Math.max(0, ...facts.map((fact) => fact.key.length)) + 2
        return (
          <Box
            key={`${member.id}:${member.revision}:${member.headSha}`}
            flexDirection="column"
            marginTop={index === 0 ? 0 : 1}
            minWidth={0}
          >
            {titleAbove ? null : (
              <Box flexDirection="row" minWidth={0} overflow="hidden">
                <QueuePrId pr={member.id} revision={member.revision} color="$fg-warning" wrap="truncate" />
                {issue === undefined ? null : (
                  <>
                    <Text> </Text>
                    <IssueValue issue={issue} />
                  </>
                )}
              </Box>
            )}
            <Box flexDirection="row" minWidth={0}>
              <Text internal_dim>{TIMELINE_BRANCH_ICON}</Text>
              <Text wrap="wrap" minWidth={0}>
                {` ${member.branch}`}
              </Text>
            </Box>
            {subject === undefined ? null : (
              <>
                <Box height={1} flexShrink={0} />
                <Text bold wrap="wrap" bgConflict="ignore">
                  {subject}
                </Text>
              </>
            )}
            {description === undefined ? null : <DescriptionBlock description={description} />}
            {lineage.length === 0 ? null : (
              <>
                <Box height={1} flexShrink={0} />
                {lineage.map((line, lineIndex) => (
                  <Text key={`lineage:${lineIndex}`} wrap="wrap">
                    {line}
                  </Text>
                ))}
              </>
            )}
            {facts.length === 0 ? null : (
              <>
                <Box height={1} flexShrink={0} />
                {facts.map((fact, factIndex) => (
                  <Box key={`${fact.key}:${factIndex}`} flexDirection="row" minWidth={0}>
                    <Text color="$fg-muted" flexShrink={0}>
                      {fact.key.toUpperCase().padEnd(factKeyWidth)}
                    </Text>
                    <Text wrap="truncate" minWidth={0} bgConflict="ignore">
                      {fact.value}
                    </Text>
                  </Box>
                ))}
              </>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

// PR-level facts (item J, 2026-07-16): the batched members' subject, review /
// comment / check-request activity, and revision history — none of which live
// on the run's `PRSnapshot`, so they are threaded from the full status PRs.
// Timestamps use the local detail clock; only present facts render; every row
// carrying an author-authored string sets `bgConflict="ignore"`.
export function QueueDetailPrFacts({ prs }: { prs: readonly PR[] }) {
  if (prs.length === 0) return null
  return (
    <Box flexDirection="column" minWidth={0}>
      {prs.map((pr, index) => {
        const name = presentFact(pr.name)
        const title = presentFact(pr.title)
        const issue = presentFact(pr.issue)
        const note = presentFact(pr.note)
        const description = presentFact(pr.description)
        const clocks = prRevisionClocks(pr)
        return (
          <Box key={pr.id} flexDirection="column" minWidth={0} marginTop={index === 0 ? 0 : 1}>
            <Text wrap="truncate" bgConflict="ignore">
              <QueuePrId pr={pr.id} revision={pr.revision} />
              {name === undefined ? "" : ` ${name}`}
            </Text>
            {title === undefined ? null : (
              <Text wrap="truncate" bgConflict="ignore">
                TITLE {title}
              </Text>
            )}
            {issue === undefined ? null : (
              <Text wrap="truncate">
                ISSUE <IssueValue issue={issue} />
              </Text>
            )}
            {note === undefined ? null : (
              <Text wrap="truncate" bgConflict="ignore">
                NOTE {note}
              </Text>
            )}
            {description === undefined ? null : (
              <Box flexDirection="column" minWidth={0}>
                <Text bold>DESCRIPTION</Text>
                <DescriptionBlock description={description} />
              </Box>
            )}
            {pr.reviews.map((review, reviewIndex) => (
              <Text key={`review:${reviewIndex}`} wrap="truncate" bgConflict="ignore">
                {prReviewLine(review)}
              </Text>
            ))}
            {pr.comments.map((comment, commentIndex) => (
              <Text key={`comment:${commentIndex}`} wrap="truncate" bgConflict="ignore">
                {prCommentLine(comment)}
              </Text>
            ))}
            {pr.checkRequests.map((request, requestIndex) => (
              <Text key={`check:${requestIndex}`} wrap="truncate">
                CHECK REQUESTED {detailClock(request.at)}
              </Text>
            ))}
            {clocks.map((clock, clockIndex) => (
              <Text key={`rev:${clockIndex}`} wrap="truncate">
                REV {clock.revision} {clock.terminal?.status ?? "open"}{" "}
                {detailClock(clock.terminal?.at ?? clock.submittedAt ?? clock.pushedAt)}
              </Text>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The one compact round-6 timing sentence:
 * `Started HH:MM:SS, ended HH:MM:SS (total M:SS, wait N)`.
 * The landing sentence owns the integration proof on its separate row, so the SHA is never
 * duplicated here.
 */
function queueRunTimingRow(data: QueueShowData): string | undefined {
  // Round 6's sentence is deliberately clock-only even for historical runs;
  // the surrounding queue row already owns the date context.
  const startClock = presentFact(data.started) === undefined ? undefined : queueLogClock(data.started, false, false)
  const endClock = presentFact(data.finished) === undefined ? undefined : queueLogClock(data.finished, false, false)
  if (startClock === undefined) return undefined
  const clocks = endClock === undefined ? `Started ${startClock}` : `Started ${startClock}, ended ${endClock}`
  const total =
    data.totalDurationMs === undefined ? presentFact(data.totalDuration) : mediaDuration(data.totalDurationMs)
  const wait =
    data.waitDurationMs === undefined
      ? presentFact(data.waitDuration)
      : data.waitDurationMs === 0
        ? "0"
        : mediaDuration(data.waitDurationMs)
  const durations = [
    ...(total === undefined ? [] : [`total ${total}`]),
    ...(wait === undefined ? [] : [`wait ${wait}`]),
  ]
  return durations.length === 0 ? clocks : `${clocks} (${durations.join(", ")})`
}

/**
 * NEXT guidance is a failure-only cue (item g, 2026-07-16): suppressed for
 * integrated, passed, running, and waiting runs so the pane never shows the
 * empty `NEXT none`.
 */
function queueShowNeedsNext(data: QueueShowData): boolean {
  return data.status === "failed" || data.outcome === "rejected"
}

/**
 * Round-6's final keyed grammar is `JOB yrd#<job-id>`. Runner and revision are
 * intentionally absent from the default body; failures still carry their
 * runner/revision evidence in the durable log projections.
 */
function QueueStepInternals({ row, issue }: { row: QueueShowRow; issue?: string }) {
  const job = presentFact(row.uuid)
  if (job === undefined) return null
  return (
    <Text bold wrap="truncate">
      JOB <NounId noun="yrd" value={job} />
      {issue === undefined ? null : (
        <>
          {" "}
          <IssueValue issue={issue} />
        </>
      )}
    </Text>
  )
}

// The watch detail pane's vertical facts layout (user respec 2026-07-15):
// stacked label/value rows that always fit the pane width — never a
// horizontally sprawling table. Only present facts render; timestamps share
// the timeline's local clock convention; `X@X` landings dedupe to one SHA.
/**
 * The compact run/step detail. `section` splits it for the workflow-step tabs
 * (user directive 2026-07-16, item H): `"run"` renders the run-level facts (+
 * COMMIT/timing/NEXT) once above the tabs, `"steps"` renders per-step facts under the
 * selected tab, `"all"` (default) renders everything in order for non-tab
 * contexts. When `titleAbove` is set the caller renders the run identity +
 * STATUS/OUTCOME in a title row above, so the RUN header row is dropped here
 * (items a/c, 2026-07-16). Subprocess-derived strings (ERROR, MESSAGE, LOST,
 * EVIDENCE) carry `bgConflict="ignore"` so raw ANSI in the data keeps its
 * colors without crashing the event loop.
 */
function CompactQueueShowView({
  data,
  highlightPr,
  section = "all",
  historyRevision,
  titleAbove = false,
  showMembers = true,
  showLogArtifacts = true,
  showIntegration = true,
  stepIssue,
}: {
  data: QueueShowData
  highlightPr?: string
  section?: "run" | "steps" | "all"
  /**
   * When set, this run executed against a now-superseded PR revision: the RUN
   * header is dimmed and annotated `(rev N · superseded)` so a historical run
   * is never read as the PR's current state (user-reported 2026-07-16).
   */
  historyRevision?: number
  /** When true, the run identity + STATUS/OUTCOME live in a title row above,
   *  so the RUN header row is omitted here (framedDetail title, item a). */
  titleAbove?: boolean
  /** False when the watch's run-scoped PR blocks already own this fact. */
  showMembers?: boolean
  /** False when the surrounding inline output list owns locations/artifact names. */
  showLogArtifacts?: boolean
  /** False when a workflow tab owns landing facts (Round-6 Revision B). */
  showIntegration?: boolean
  /** Selected PR issue shown beside the step's JOB identity. */
  stepIssue?: string
}) {
  const runFacts = section !== "steps"
  const stepFacts = section !== "run"
  const parent = presentFact(data.parent)
  const isolation = data.isolationPart === "-" ? undefined : data.isolationPart
  const timing = queueRunTimingRow(data)
  const gate = queueGateSummary(data)
  const latestStep = data.steps.at(-1)
  return (
    // minWidth={0} lets the long truncate-Text facts shrink to the (narrow)
    // detail pane instead of overflowing it (canonical CSS escape hatch).
    <Box flexDirection="column" minWidth={0} flexShrink={0}>
      {runFacts ? (
        <>
          {titleAbove ? null : (
            <Text bold wrap="truncate" {...(historyRevision === undefined ? {} : { color: "$fg-muted" })}>
              RUN <QueueRunId base={data.base} run={data.run} />
              {historyRevision === undefined ? "" : ` (rev ${historyRevision} · superseded)`} STATUS {data.status}{" "}
              OUTCOME {data.outcome}
            </Text>
          )}
          {showMembers ? (
            <Text wrap="truncate">
              {"PRs".padEnd(9, " ")}
              <QueueShowMembersValue data={data} highlightPr={highlightPr} />
            </Text>
          ) : null}
          {data.retries > 1 && data.prs[0] !== undefined ? (
            <Text wrap="truncate">
              <QueuePrId pr={data.prs[0].id} revision={data.prs[0].revision} times={data.retries} />
            </Text>
          ) : null}
          {timing === undefined ? null : <Text wrap="truncate">{timing}</Text>}
          {gate === undefined ? null : <Text wrap="truncate">GATE {gate}</Text>}
          {showIntegration ? <QueueIntegrationFacts data={data} /> : null}
          {parent === undefined && isolation === undefined ? null : (
            <Text wrap="truncate" color="$fg-muted">
              {parent === undefined ? "" : `PARENT ${parent}`}
              {parent !== undefined && isolation !== undefined ? " " : ""}
              {isolation === undefined ? "" : `ISO ${isolation}`}
            </Text>
          )}
        </>
      ) : null}
      {stepFacts ? (
        <>
          {latestStep === undefined ? null : <QueueStepInternals row={latestStep} issue={stepIssue} />}
          {data.steps.map((row) => {
            const error = presentFact(row.errorCode)
            const detail = presentFact(row.detail)
            const lost = presentFact(row.lost)
            const evidence = presentFact(typeof row.evidence === "string" ? row.evidence : safeText(row.evidence))
            // Artifact/checkpoint facts stay in the selected step body while
            // the surrounding inline output list owns raw execution output.
            const artifacts = presentFact(row.artifacts)
            const checkpoint = presentFact(row.checkpoint)
            const visibleArtifacts = showLogArtifacts ? artifacts : undefined
            const visibleLocations = showLogArtifacts ? row.locations : []
            const hasProof =
              visibleLocations.length > 0 ||
              evidence !== undefined ||
              visibleArtifacts !== undefined ||
              checkpoint !== undefined
            return (
              // The step tab (glyph + name + duration) is the step summary, so
              // the duplicate STEP header row is dropped (item d, 2026-07-16).
              <Box
                key={`${row.uuid}:${row.attempt}:compact`}
                flexDirection="column"
                width="100%"
                minWidth={0}
                overflow="hidden"
              >
                {row.failure !== undefined ? (
                  <ActionableFailureView failure={row.failure} />
                ) : error === undefined ? null : (
                  <Text wrap="wrap" color="$fg-error" bgConflict="ignore">
                    ERROR {errorCodeLabel(error)}
                  </Text>
                )}
                {detail === undefined ? null : (
                  <Box flexDirection="row" width="100%" minWidth={0} overflow="hidden">
                    <Text color="$fg-muted" flexShrink={0}>
                      {"MESSAGE".padEnd(9, " ")}
                    </Text>
                    <Text
                      flexGrow={1}
                      flexBasis={0}
                      flexShrink={1}
                      wrap="truncate"
                      minWidth={0}
                      color="$fg-muted"
                      bgConflict="ignore"
                    >
                      {detail}
                    </Text>
                  </Box>
                )}
                {lost === undefined ? null : (
                  <Text wrap="truncate" color="$fg-warning" bgConflict="ignore">
                    {"LOST".padEnd(9, " ")}
                    {lost}
                  </Text>
                )}
                {!hasProof ? null : (
                  <Text wrap="truncate" minWidth={0} bgConflict="ignore">
                    {"PROOF".padEnd(9, " ")}
                    {visibleLocations.length === 0 ? null : (
                      <>
                        {" "}
                        <QueueLogLocationLinks entries={visibleLocations} compact={false} />
                      </>
                    )}
                    {visibleArtifacts === undefined ? "" : ` ARTIFACTS ${visibleArtifacts}`}
                    {evidence === undefined ? "" : ` EVIDENCE ${evidence}`}
                    {checkpoint === undefined ? "" : ` CHECKPOINT ${checkpoint}`}
                  </Text>
                )}
              </Box>
            )
          })}
        </>
      ) : null}
      {runFacts && queueShowNeedsNext(data) ? <Text wrap="wrap">NEXT {queueShowNextAction(data)}</Text> : null}
    </Box>
  )
}

export function QueueShowView({
  data,
  compact = false,
  highlightPr,
  section = "all",
  historyRevision,
  titleAbove = false,
  showMembers = true,
  showLogArtifacts = true,
  showIntegration = true,
  stepIssue,
}: {
  data: QueueShowData
  compact?: boolean
  highlightPr?: string
  /** Compact-only: split run-level vs step-level facts for the step tabs (item H). */
  section?: "run" | "steps" | "all"
  /** Compact-only: mark this run as history for a now-superseded revision. */
  historyRevision?: number
  /** Compact-only: the run identity + STATUS/OUTCOME live in a title row above,
   *  so drop the RUN header row here (framedDetail title, item a). */
  titleAbove?: boolean
  /** Compact-only: hide the PRs row when surrounding run-scoped PR blocks own it. */
  showMembers?: boolean
  /** Compact-only: hide log locations/artifact names owned by the inline output list. */
  showLogArtifacts?: boolean
  /** Compact-only: keep landing facts out of the run header when a merge tab owns them. */
  showIntegration?: boolean
  /** Compact-only: selected PR issue rendered with the step JOB identity. */
  stepIssue?: string
}) {
  if (compact) {
    return (
      <CompactQueueShowView
        data={data}
        highlightPr={highlightPr}
        section={section}
        titleAbove={titleAbove}
        showMembers={showMembers}
        showLogArtifacts={showLogArtifacts}
        showIntegration={showIntegration}
        {...(stepIssue === undefined ? {} : { stepIssue })}
        {...(historyRevision === undefined ? {} : { historyRevision })}
      />
    )
  }
  return (
    <Box flexDirection="column">
      <QueueShowMembersLine data={data} {...(highlightPr === undefined ? {} : { highlightPr })} />
      <Table
        data={[data]}
        columns={[
          {
            header: "RUN",
            key: "run",
            minWidth: 8,
            render: (row) => <QueueRunId base={row.base} run={row.run} />,
          },
          { header: "BASE", key: "base", minWidth: 5 },
          {
            header: "STATUS",
            key: "status",
            minWidth: 15,
            render: (row) => <TaskStatusValue taskStatus={row.taskStatus} glyph={row.glyph} value={row.status} />,
          },
          { header: "OUTCOME", key: "outcome", minWidth: 11 },
          { header: "START", key: "started", grow: true },
          { header: "END", key: "finished", grow: true },
          { header: "TOTAL", key: "totalDuration", minWidth: 7, align: "right" },
          { header: "ACTIVE", key: "activeDuration", minWidth: 7, align: "right" },
          { header: "WAIT", key: "waitDuration", minWidth: 7, align: "right" },
          {
            header: "PARENT",
            key: "parent",
            minWidth: 8,
            render: (row) => (row.parent === "-" ? "-" : row.parent),
          },
          {
            header: "ISO",
            key: "isolationPart",
            minWidth: 4,
            align: "right",
            render: (row) => (row.isolationPart === "-" ? "-" : row.isolationPart),
          },
          { header: "INTEGRATION", key: "landing", grow: true },
        ]}
        padding={1}
      />
      <Box marginTop={1}>
        <Table
          data={data.steps}
          columns={[
            { header: "STEP", key: "step", minWidth: 8 },
            {
              header: "REV",
              key: "revision",
              minWidth: 8,
              maxWidth: 12,
              render: (row) => <Text wrap="truncate">{row.revision.slice(0, 12)}</Text>,
            },
            {
              header: "STATUS",
              key: "status",
              minWidth: 12,
              render: (row) => <TaskStatusValue taskStatus={row.taskStatus} glyph={row.glyph} value={row.status} />,
            },
            { header: "ATT", key: "attempt", align: "right" },
            { header: "DUR", key: "duration", align: "right", minWidth: 8 },
            {
              header: "ERROR",
              key: "errorCode",
              minWidth: 22,
              maxWidth: 32,
              grow: true,
              render: (row) => (
                <Text wrap="truncate">{row.errorCode === "-" ? "-" : errorCodeLabel(row.errorCode)}</Text>
              ),
            },
            { header: "START", key: "started", grow: true },
            { header: "END", key: "finished", grow: true },
            { header: "REQ", key: "requested" },
            {
              header: "LOST",
              key: "lost",
              grow: true,
              render: (row) => <Text wrap="truncate">{singleQueue(row.lost)}</Text>,
            },
            {
              header: "MESSAGE",
              key: "error",
              grow: true,
              render: (row) => <Text wrap="truncate">{singleQueue(row.error)}</Text>,
            },
            {
              header: "DETAIL",
              key: "detail",
              grow: true,
              render: (row) => <Text wrap="truncate">{singleQueue(row.detail)}</Text>,
            },
            {
              header: "OUTPUT",
              key: "output",
              grow: true,
              minWidth: 10,
              render: (row) => <Text wrap="truncate">{singleQueue(row.output)}</Text>,
            },
            { header: "ART", key: "artifacts", grow: true },
            {
              header: "PATH",
              key: "locations",
              render: (row) => <LocationLinks entries={row.locations} />,
            },
            {
              header: "EVIDENCE",
              key: "evidence",
              minWidth: 10,
              grow: false,
              render: (row) => (
                <Text wrap="truncate">
                  {singleQueue(typeof row.evidence === "string" ? row.evidence : safeText(row.evidence))}
                </Text>
              ),
            },
            { header: "CHECKPOINT", key: "checkpoint", minWidth: 10, grow: false },
          ]}
          padding={1}
        />
      </Box>
      {data.steps.some((step) => step.failure !== undefined) ? (
        <Box marginTop={1} flexDirection="column">
          {data.steps.flatMap((step, index) =>
            step.failure === undefined
              ? []
              : [<ActionableFailureView key={`${step.step}:${index}`} failure={step.failure} />],
          )}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <QueueProofView data={data} />
      </Box>
      <Text wrap="wrap">NEXT {queueShowNextAction(data)}</Text>
    </Box>
  )
}

function RevisionClockView({
  clock,
  checkRequests,
}: {
  clock: PRRevisionHistoryClock
  checkRequests: readonly string[]
}) {
  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        REVISION CLOCK <QueuePrId pr={clock.pr} revision={clock.revision} /> HEAD {clock.headSha}
      </Text>
      <Text wrap="wrap">PUSHED {clock.pushedAt}</Text>
      <Text wrap="wrap">SUBMITTED {clock.submittedAt ?? "-"}</Text>
      <Text wrap="wrap">CHECK REQUESTED {checkRequests.length === 0 ? "-" : checkRequests.join(", ")}</Text>
      <Text wrap="wrap">
        TERMINAL {clock.terminal?.status ?? "-"} AT {clock.terminal?.at ?? "-"}
      </Text>
    </Box>
  )
}

function RunAdmissionClockView({ run }: { run: QueueShowData }) {
  const clock = run.revisionClock
  if (clock === undefined) throw new Error(`yrd: run '${run.run}' has no projected admission clock`)
  const at = clock.admittedBy === "submission" ? clock.submittedAt : clock.checkRequestedAt
  return (
    <Text wrap="wrap">
      RUN <QueueRunId base={run.base} run={run.run} /> ADMITTED {clock.admittedBy} AT {at}
    </Text>
  )
}

export function PRRunsView({ data }: { data: PRRunsData }) {
  const clocks = prRevisionClocks(data.pr)
  if (clocks.length === 0) return <Text color="$fg-muted">No revision history recorded.</Text>
  return (
    <Box flexDirection="column">
      {clocks.map((clock, revisionIndex) => {
        const checkRequests = revisionCheckRequests(data.pr, clock).map((request) => request.at)
        const runs = data.runs.filter(
          (run) =>
            run.revisionClock?.pr === clock.pr &&
            run.revisionClock.revision === clock.revision &&
            run.revisionClock.headSha === clock.headSha,
        )
        return (
          <Box
            key={`${clock.revision}:${clock.headSha}`}
            flexDirection="column"
            marginTop={revisionIndex === 0 ? 0 : 1}
          >
            <RevisionClockView clock={clock} checkRequests={checkRequests} />
            {runs.length === 0 ? (
              <Text color="$fg-muted">No runs recorded for this revision.</Text>
            ) : (
              runs.map((run, runIndex) => (
                <Box key={run.run} flexDirection="column" marginTop={runIndex === 0 ? 0 : 1}>
                  <RunAdmissionClockView run={run} />
                  <QueueShowView data={run} />
                </Box>
              ))
            )}
          </Box>
        )
      })}
    </Box>
  )
}
