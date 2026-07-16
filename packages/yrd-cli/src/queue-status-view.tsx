import { existsSync } from "node:fs"
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
import type { IntegrationProof, PRCheckRecord, PREligibility, QueueRun, QueueStep, QueueSummary } from "@yrd/queue"
import { Box, Divider, Link, ListView, Pulse, Tab, TabList, Table, Tabs, Text, type TableColumn } from "silvery"
import { submittedPrPositions } from "./queue-position.ts"
import {
  formatDuration,
  PRStatusView,
  statusVariant,
  StatusValue,
  TaskStatusGlyph,
  TaskStatusValue,
} from "./status-view.tsx"
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

const sourceRowKey = ["li", "ne"].join("") as `${"li"}${"ne"}`

export type QueueStatusResult = QueueSummary & { headSha?: string; prs: PR[] }

export type QueueTimelineRow = Readonly<{
  key: string
  pr: string
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
export type QueueTimelineStatus = "pending" | "running" | QueueTerminalOutcome
export type QueueTimelineGroup = "pending" | "running" | "completed"

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

export type QueueTimelineRunner = Readonly<{
  pid: number
  startedAt: string
  lastTickAt: string
  /** The resident runner's launch command line; absent for status records written before it was captured. */
  command?: string
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
}>

export type QueueTimelineProjectionOptions = Readonly<{
  now: number
  windowMs: number
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

export type QueueTerminalOutcome = "integrated" | "rejected" | "environment-refused" | "canceled"

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
    canceled: number
  }>
  decisionRejection: Readonly<{
    rejected: number
    decisions: number
    rate: number | null
  }>
  activeRun: Readonly<{
    allTerminal: DurationDistribution
    integratedOnly: DurationDistribution
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

export type HumanFailureProjection = Readonly<{
  code: string
  summary: string
  evidence?: Readonly<{ text: string; href?: string }>
}>

export type HumanPRProjection = Row &
  Readonly<{
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
  errorCode: string
  error: string
  lost: string
  detail: string
  output: string
  artifacts: string
  evidence: string | Record<string, unknown>
  checkpoint: string
  landing: string
  location?: QueueLogLocation
  locations: readonly QueueLogLocationEntry[]
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

export function queueFlowMetrics(
  facts: Iterable<QueueTerminalFact>,
  options: Readonly<{ now: number; windowMs: number }>,
): QueueFlowMetrics {
  const now = finiteNonnegative(options.now, "FLOW snapshot time")
  const windowMs = finiteNonnegative(options.windowMs, "FLOW window")
  const earliest = now - windowMs
  const seenRuns = new Set<string>()
  const activeAll: number[] = []
  const activeIntegrated: number[] = []
  const waits: number[] = []
  let integrated = 0
  let rejected = 0
  let environmentRefused = 0
  let canceled = 0

  for (const fact of facts) {
    const terminalAtMs = finiteNonnegative(fact.terminalAtMs, `Run '${fact.run}' terminal time`)
    if (terminalAtMs < earliest || terminalAtMs > now) continue
    if (seenRuns.has(fact.run)) throw new Error(`yrd: duplicate terminal FLOW fact for Run '${fact.run}'`)
    seenRuns.add(fact.run)

    if (fact.outcome === "integrated") integrated += 1
    else if (fact.outcome === "rejected") rejected += 1
    else if (fact.outcome === "environment-refused") environmentRefused += 1
    else canceled += 1

    if (fact.activeMs !== null) {
      const activeMs = finiteNonnegative(fact.activeMs, `Run '${fact.run}' active duration`)
      activeAll.push(activeMs)
      if (fact.outcome === "integrated") activeIntegrated.push(activeMs)
    }
    for (const wait of fact.queueWaitMs) {
      waits.push(finiteNonnegative(wait, `Run '${fact.run}' queue wait`))
    }
  }

  const decisions = integrated + rejected
  return {
    windowMs,
    terminalAttempts: seenRuns.size,
    outcomes: { integrated, rejected, environmentRefused, canceled },
    decisionRejection: {
      rejected,
      decisions,
      rate: decisions === 0 ? null : rejected / decisions,
    },
    activeRun: {
      allTerminal: durationDistribution(activeAll),
      integratedOnly: durationDistribution(activeIntegrated),
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
      ...(row.run === undefined ? {} : { run: row.run }),
      ...(row.position === undefined ? {} : { position: row.position }),
      base: row.base,
      status: row.status === "pending" ? "submitted" : row.status,
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
  const pad = (value: number) => String(value).padStart(2, "0")
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
  if (includeDate) {
    const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
    return `${day}T${clock}`
  }
  return compact ? clock.slice(0, 5) : clock
}

function queueLogLevel(outcome: string): "DEBUG" | "ERROR" | "INFO" | "WARN" {
  if (["integrated", "submitted"].includes(outcome)) return "INFO"
  if (["rejected", "paused", "resumed"].includes(outcome)) return "WARN"
  if (["failed", "lost"].includes(outcome)) return "ERROR"
  return "DEBUG"
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

function isLocalArtifact(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false
  return !/^[a-z][a-z0-9+.-]*:/iu.test(value)
}

function artifactPath(artifact: unknown): QueueLogLocation | undefined {
  if (!isObjectValue(artifact)) return undefined
  const candidate =
    typeof artifact.uri === "string" && artifact.uri !== ""
      ? artifact.uri
      : typeof artifact.path === "string" && artifact.path !== ""
        ? artifact.path
        : undefined
  if (candidate === undefined) return undefined

  if (!isLocalArtifact(candidate)) return { url: candidate }

  const path = resolve(candidate)
  if (!existsSync(path)) return undefined
  return { path }
}

function artifactLocation(step: QueueStep | undefined): QueueLogLocation | undefined {
  return stepLocations(step)[0]?.location
}

function artifactLabel(artifact: unknown): string {
  if (!isObjectValue(artifact)) return "artifact"
  for (const key of ["name", "kind", "file"] as const) {
    const value = artifact[key]
    if (typeof value === "string" && value !== "") return value
  }
  return "artifact"
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
    if (Array.isArray(step.job.output.artifacts)) {
      artifacts.push(...(step.job.output.artifacts as readonly unknown[]))
    }
  }
  const checkpoint = jobCheckpoint(step.job)
  if (isObjectValue(checkpoint) && Array.isArray(checkpoint.artifacts)) {
    artifacts.push(...(checkpoint.artifacts as readonly unknown[]))
  }
  return [...new Map(artifacts.map((artifact) => [JSON.stringify(artifact), artifact])).values()]
}

function artifactHref(artifact: unknown): string | undefined {
  const location = artifactPath(artifact)
  if (location === undefined) return undefined
  return "path" in location ? pathToFileURL(location.path).href : location.url
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

function queueOutcome(run: QueueRun): "passed" | "integrated" | "rejected" | "running" | "waiting" {
  if (run.status === "passed") return queueIntegration(run) === undefined ? "passed" : "integrated"
  if (run.status === "failed") return "rejected"
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

function stepEvidence(step: QueueStep): string | Record<string, unknown> {
  const job = step.job
  if (job === undefined) return "-"
  const evidence: Record<string, unknown> = {}

  if ("token" in job && typeof job.token === "string" && job.token !== "") evidence.token = job.token
  if ("url" in job && typeof job.url === "string" && job.url !== "") evidence.url = job.url
  if ("detail" in job && typeof job.detail === "string" && job.detail !== "") evidence.detail = job.detail
  if ("artifacts" in job && Array.isArray(job.artifacts) && job.artifacts.length > 0) evidence.artifacts = job.artifacts
  if ("checkpoint" in job && job.checkpoint !== undefined) evidence.checkpoint = job.checkpoint
  return Object.keys(evidence).length === 0 ? "-" : evidence
}

function CellLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} minWidth={0} maxWidth="100%" wrap="truncate">
      {children}
    </Link>
  )
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

// Canonical km/ag marker vocabulary: working disc, hollow pending, red
// failure cross, muted completion check. Never ASCII slash spinners or
// background fills; color is applied by the renderer, foreground-only.
function statusGlyph(status: string): string {
  if (["checking", "running", "waiting"].includes(status)) return "●"
  if (["integrated", "passed"].includes(status)) return "✓"
  if (["rejected", "failed", "lost", "environment-refused"].includes(status)) return "×"
  if (["withdrawn", "retired", "canceled"].includes(status)) return "-"
  return "○"
}

function failureFact(
  run: QueueRun | undefined,
  step: QueueStep | undefined,
): { code: string; message: string } | undefined {
  const job = step?.job
  if (job?.status === "failed") return { code: job.error.code, message: job.error.message }
  if (job?.status === "lost") return { code: "job-lost", message: job.lostReason }
  return run?.error
}

function causalSummary(message: string): string {
  const parts = message
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .filter((part) => part !== "" && !/^at\s+/u.test(part))
  const candidate = parts.find((part) => !/^hint:/iu.test(part)) ?? parts[0] ?? "failed"
  const first = candidate.replace(/^hint:\s*/iu, "")
  const [rawCause, hint] = first.split(/\s+hint:\s*/iu, 2)
  const cause = rawCause ?? first
  const usefulHint = hint === undefined || /^(?:please|this can|[-])/iu.test(hint) ? undefined : hint
  return boundedQueue(`${cause.replace(/[:\s]+$/u, "")}${usefulHint === undefined ? "" : `: ${usefulHint}`}`, 104)
}

const ENVIRONMENT_REFUSAL_CODES = new Set(["queue-environment-refused", "stale-pr", "stale-check", "job-lost"])
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

function terminalOutcome(run: QueueRun): QueueTerminalOutcome {
  if (run.status === "passed") return "integrated"
  const status = run.status as string
  if (status === "canceled" || status === "cancelled") return "canceled"
  const failure = failureFact(run, relevantStep(run))
  if (failure !== undefined && CANCELED_CODES.has(failure.code)) return "canceled"
  if (failure !== undefined && ENVIRONMENT_REFUSAL_CODES.has(failure.code)) return "environment-refused"
  return "rejected"
}

function timelineStatusFilter(status: QueueTimelineStatus): QueueTimelineStatusFilter {
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
    bayPath ?? (isCurrent ? current?.name : undefined) ?? member.name ?? current?.branch ?? member.branch,
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
      return recuts.length === 1 ? path : `${pr} ${path}`
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
  const status: QueueTimelineStatus = running ? "running" : terminalOutcome(run)
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
      : `${failure.code}: ${causalSummary(failure.message)}`
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

function timelinePendingRows(
  result: QueueStatusResult,
  nowIso: string,
  submissionTimes: ReadonlyMap<string, string | null>,
  state: BaysState | undefined,
): QueueTimelineProjectedRow[] {
  const activeRevisions = new Set(
    [...result.running, ...result.waiting].flatMap((run) => run.prs.map((member) => queueRevisionKey(member))),
  )
  const positions = submittedPrPositions(result.prs)
  return result.prs.flatMap((pr) => {
    if (pr.status !== "submitted" || activeRevisions.has(queueRevisionKey(pr))) return []
    const timestamp = submissionTimes.get(queueRevisionKey(pr)) ?? pr.submittedAt ?? null
    const timestampMs = parsedTimelineTimestamp(timestamp ?? undefined, `PR '${pr.id}' submission`)
    const position = positions.get(pr.id)
    const bayPath = pr.bay === undefined ? undefined : state?.byId[pr.bay]?.path
    const revisionLineage = [timelineRevisionLineage(pr)]
    const sourceReadyAt = revisionLineage[0]?.sourceReadyAt ?? timestamp ?? undefined
    const detail = withTimelineLineage(position === undefined ? "queued" : `position ${position}`, revisionLineage)
    const submitter = revisionSubmitter(pr)
    return [
      {
        id: `${pr.base}:pr:${pr.id}:${pr.revision}:${pr.headSha}`,
        base: pr.base,
        group: "pending" as const,
        status: "pending" as const,
        glyph: statusGlyph("pending"),
        timestamp,
        timestampMs,
        pr: pr.id,
        revision: pr.revision,
        headSha: pr.headSha,
        branch: pr.branch,
        subject: boundedQueue(bayPath ?? pr.name ?? pr.branch, 80),
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
  })
}

function timelineSort(left: QueueTimelineProjectedRow, right: QueueTimelineProjectedRow): number {
  const groupOrder: Record<QueueTimelineGroup, number> = { pending: 0, running: 1, completed: 2 }
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

export function queueTimelineProjection(
  results: readonly QueueStatusResult[],
  options: QueueTimelineProjectionOptions,
): QueueTimelineProjection {
  if (!Number.isFinite(options.now) || options.now < 0) throw new TypeError("yrd: timeline snapshot time is invalid")
  if (!Number.isFinite(options.windowMs) || options.windowMs < 0) {
    throw new TypeError("yrd: timeline window is invalid")
  }
  if (!Number.isFinite(options.rowLimit) || options.rowLimit < 0) {
    throw new TypeError("yrd: timeline row limit is invalid")
  }
  const nowIso = new Date(options.now).toISOString()
  const sinceMs = options.now - options.windowMs
  const since = new Date(sinceMs).toISOString()
  const requestedStatuses = options.statuses.length === 0 ? TIMELINE_STATUS_ORDER : options.statuses
  const statuses = TIMELINE_STATUS_ORDER.filter((status) => requestedStatuses.includes(status))
  const selectedStatuses = new Set(statuses)
  const terms = [...new Set(options.terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean))]
  const rawRows = results.flatMap((result) => [
    ...timelinePendingRows(result, nowIso, options.submissionTimes, options.state),
    ...[...result.running, ...result.waiting, ...result.finished].flatMap((run) =>
      timelineRunMemberRows(result, run, nowIso, options.submissionTimes, options.state, options.attempts ?? []),
    ),
  ])
  const filtered = rawRows
    .filter((row) => selectedStatuses.has(timelineStatusFilter(row.status)))
    .filter((row) => row.timestampMs === null || (row.timestampMs >= sinceMs && row.timestampMs <= options.now))
    .filter((row) => timelineMatches(row, terms))
  const rows = (options.latest ? latestTimelineRows(filtered) : filtered).toSorted(timelineSort)
  // Metrics stay per-Run: member rows of one batched Run fold into one
  // terminal fact carrying every visible member's queue wait.
  const terminalFactByRun = new Map<string, QueueTerminalFact>()
  for (const row of rows) {
    if (row.group !== "completed" || row.timestampMs === null || row.run === undefined) continue
    const key = `${row.base}:${row.run}`
    const fact = terminalFactByRun.get(key)
    const waits = row.queueWaitMs === null ? [] : [row.queueWaitMs]
    if (fact === undefined) {
      terminalFactByRun.set(key, {
        run: row.run,
        terminalAtMs: row.timestampMs,
        outcome: row.status as QueueTerminalOutcome,
        activeMs: row.totalMs,
        queueWaitMs: waits,
      })
      continue
    }
    terminalFactByRun.set(key, { ...fact, queueWaitMs: [...fact.queueWaitMs, ...waits] })
  }
  const terminalFacts = [...terminalFactByRun.values()]
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
      complete: options.retainedSinceMs === undefined || options.retainedSinceMs <= sinceMs,
    },
    display: { limit, shown: Math.min(rows.length, limit), hidden: Math.max(0, rows.length - limit) },
    rows,
    details,
    metrics: queueFlowMetrics(terminalFacts, { now: options.now, windowMs: options.windowMs }),
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
  const failure =
    fact === undefined || run === undefined
      ? undefined
      : {
          code: fact.code,
          summary: `${fact.code}: ${causalSummary(fact.message)}`,
          ...(evidence === undefined ? {} : { evidence }),
        }
  return {
    pr: pr.id,
    ...(path === undefined ? {} : { prHref: pathToFileURL(path).href, path }),
    branch: pr.branch,
    subject: boundedQueue(pr.name ?? pr.branch, 80),
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
  const columns: TableColumn<PRListRow>[] = [
    { header: "PR", key: "pr", minWidth: 4, maxWidth: 7 },
    {
      header: "STATE",
      key: "stateLabel",
      minWidth: 15,
      maxWidth: 16,
      render: (row: PRListRow) => <PRStateValue row={row} />,
    },
    { header: "REV", key: "revision", minWidth: 5, maxWidth: 6 },
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
          { header: "PR", key: "pr" },
          { header: "REV", key: "revision" },
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
            {`FAIL ${row.pr}@${row.revision} ${row.check} COMMAND ${row.command} DIAGNOSTIC ${row.diagnostic}${row.artifact === undefined ? "" : ` ARTIFACT ${row.artifact}`}`}
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
  if (job?.status === "failed") return `${job.error.code}: ${singleQueue(job.error.message)}`
  if (job?.status === "lost") return `job-lost: ${singleQueue(job.lostReason)}`
  if (job?.status === "canceled") return `job-canceled: ${singleQueue(job.cancelReason)}`
  if (job?.status === "running") {
    const leaseExpiresAt = Date.parse(job.leaseExpiresAt)
    if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= now) {
      return `job-lease-expired: ${job.leaseExpiresAt} (${formatDuration(now - leaseExpiresAt)} ago)`
    }
  }
  if (job?.status === "waiting") return `waiting: ${singleQueue(job.detail ?? job.url ?? job.token)}`
  if (run?.error !== undefined) return `${run.error.code}: ${singleQueue(run.error.message)}`
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
        <Text bold>PR</Text> {pr.id} <Text bold>STATUS</Text> <StatusValue value={pr.status} />{" "}
        <TaskStatusGlyph taskStatus={projectionFields.taskStatus} glyph={projectionFields.glyph} />
        {position === undefined ? null : ` POSITION ${position}`}
      </Text>
      <Text>
        <Text bold>SOURCE</Text> {pr.branch} <Text bold>REV</Text> {pr.revision} <Text bold>HEAD</Text> {pr.headSha}
      </Text>
      <Text>
        <Text bold>BASE</Text> {pr.base}
        {pr.baseSha === undefined ? null : `@${pr.baseSha}`}
      </Text>
      <Text>
        <Text bold>SOURCE READY</Text> {lineage.sourceReadyAt ?? "-"} <Text bold>LINEAGE</Text> {revisionLineage}
      </Text>
      {detail.run === undefined ? null : <QueueShowView data={detail.run} compact highlightPr={pr.id} />}
      {blocker === undefined ? null : (
        <Text color="$fg-warning">
          <Text bold>BLOCKER</Text> {blocker}
        </Text>
      )}
      {detail.run === undefined && landing !== undefined ? (
        <Text>
          <Text bold>LANDING</Text> {landing.commit}@{landing.baseSha}
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
        <Text bold>ACTIVE</Text> {active.run} {active.pr} {active.subject}{" "}
        <TaskStatusGlyph taskStatus={active.taskStatus} glyph={active.glyph} /> {active.steps} {active.elapsed}
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
        {row.prHref === undefined ? row.pr : <CellLink href={row.prHref}>{row.pr}</CellLink>} {row.subject}{" "}
        <StatusValue value={row.state} href={row.log} /> age={row.age}
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
  run: string
  pr: string
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
    run: run.id,
    pr: member.id,
    subject: boundedQueue(pr?.name ?? member.id, 80),
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

function timelineMetric(value: number | null): string {
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
const TIMELINE_TOTAL_GLYPH = "◷"

type TimelineCellLayout = Readonly<{
  timeWidth: number
  statusWidth: number
  runWidth: number
  /** 0 drops the BY column entirely — the first casualty on narrow tiers. */
  byWidth: number
  stepWidth: number
  ageWidth: number
  runDurationWidth: number
  compact: boolean
  includeDate: boolean
}>

type TimelineRunCell = Readonly<{ text: string; color?: string }>

// The RUN(id) part of the RUN·PR identity cell: main#N (or #N on the compact
// tier); run-less rows render `pending` in blue — colored, never blank (15d).
function timelineRunCell(row: QueueTimelineProjectedRow, compact: boolean): TimelineRunCell {
  if (row.run === undefined) return { text: "pending", color: "$fg-info" }
  const match = /^R(\d+)$/u.exec(row.run)
  if (match === null) return { text: row.run }
  return { text: compact ? `#${match[1]}` : `${row.base}#${match[1]}` }
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
  if (row.status === "running" || row.status === "pending") return "$fg-info"
  if (row.status === "integrated") return "$fg-success"
  if (row.status === "canceled") return "$fg-muted"
  if (row.status === "environment-refused") return "$fg-warning"
  return "$fg-error"
}

type TimelineStatusCell = Readonly<{ word: string; color: string }>

// 15e is later than 15c/15d: STATUS remains a fixed column between TIME
// and the RUN cell, while 15d supplies its semantic foreground colors.
// Vocabulary (user respec 2026-07-15): rejected renders `fail`, integrated
// renders `done` — the display buckets are pending/running/failed/done.
function timelineStatusCell(row: QueueTimelineProjectedRow): TimelineStatusCell {
  const word =
    row.status === "running"
      ? "run"
      : row.status === "pending"
        ? "pend"
        : row.status === "integrated"
          ? "done"
          : row.status === "environment-refused"
            ? "env"
            : row.status === "canceled"
              ? "can"
              : "fail"
  return { word, color: timelineStatusColor(row) }
}

type TimelineStepCell = Readonly<{ text: string; color?: string }>

// The STEP cell carries the current `ordinal:name` while running, semantic
// GREEN `integrated` on success (15d), or the failure CODE (the cause) on
// failed terminals.
function timelineStepCell(row: QueueTimelineProjectedRow): TimelineStepCell {
  if (row.status === "running") return { text: row.step ?? "" }
  if (row.failure !== undefined) {
    return {
      text: fitTimelineLabel(row.failure.code, TIMELINE_STATE_CAP),
      color:
        row.status === "environment-refused" ? "$fg-warning" : row.status === "canceled" ? "$fg-muted" : "$fg-error",
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
    stepWidth: Math.max(4, ...rows.map((row) => timelineStepCell(row).text.length)),
    ageWidth: Math.max(3, ...rows.map((row) => timelineAgeCell(row).length)),
    runDurationWidth: Math.max(3, ...rows.map((row) => (row.totalMs === null ? 0 : timelineTotalCell(row).length + 1))),
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

// The working disc pulses only in the live pane; the one-shot projection has
// no app scope (and a static print cannot pulse), so it renders the same
// glyph statically — byte-identical plain output either way.
function TimelineMarker({ row, live }: { row: QueueTimelineProjectedRow; live: boolean }) {
  if (row.status === "running") {
    if (live) return <Pulse colors={["$fg-info", "$fg-muted"]}>{row.glyph}</Pulse>
    return <Text color="$fg-info">{row.glyph}</Text>
  }
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
  step,
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
  step: React.ReactNode
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
      <Box id={id("step")} width={layout.stepWidth} flexShrink={0} minWidth={0} justifyContent="flex-end">
        {step}
      </Box>
      {layout.byWidth === 0 ? null : (
        <Box id={id("by")} width={layout.byWidth} flexShrink={0} minWidth={0} justifyContent="flex-end">
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

// Header (15c, split-label respec 2026-07-15): TIME | STATUS | RUN | PR |
// STEP | BY | AGE | RUN — RUN(id) and PR are separate labels, each exactly
// over its own column; the trailing bare RUN header belongs to the
// run-duration column that replaced TOTAL.
function TimelineHeader({ layout }: { layout: TimelineCellLayout }) {
  const label = (text: string): React.ReactElement => (
    <Text color="$fg-muted" wrap="truncate">
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
      step={label("STEP")}
      by={label("BY")}
      age={label("AGE")}
      runDuration={label("RUN")}
    />
  )
}

function TimelineProjectedRow({
  row,
  cursor,
  layout,
  live,
}: {
  row: QueueTimelineProjectedRow
  cursor: boolean
  layout: TimelineCellLayout
  live: boolean
}) {
  const active = row.status === "running"
  const status = timelineStatusCell(row)
  const runCell = timelineRunCell(row, layout.compact)
  const step = timelineStepCell(row)
  const runDuration = timelineTotalCell(row)
  // Selection forces the semantic pair on EVERY cell (user respec
  // 2026-07-15): $bg-selected under $fg-on-selected, no per-cell colors.
  const forcedFg = cursor ? "$fg-on-selected" : undefined
  return (
    <TimelineCells
      layout={layout}
      rowId={row.id}
      backgroundColor={cursor ? "$bg-selected" : undefined}
      time={
        <Text color={forcedFg ?? "$fg-muted"} wrap="truncate">
          {timelineClockCell(row, layout)}
        </Text>
      }
      status={
        <>
          <Box width={1} flexShrink={0}>
            {cursor ? <Text color={forcedFg}>{row.glyph}</Text> : <TimelineMarker row={row} live={live} />}
          </Box>
          <Box paddingLeft={1} minWidth={0} overflow="hidden">
            <Text color={forcedFg ?? status.color} wrap="truncate">
              {status.word}
            </Text>
          </Box>
        </>
      }
      run={
        // Real run ids share TIME's muted treatment (user respec 2026-07-15);
        // run-less pending rows keep their info-colored `pending`.
        <Text color={forcedFg ?? runCell.color ?? "$fg-muted"} wrap="truncate">
          {runCell.text}
        </Text>
      }
      pr={
        <>
          <Text bold={active} color={forcedFg} flexShrink={0}>
            {row.pr}.{row.revision}
          </Text>
          <Box paddingLeft={1} minWidth={0} overflow="hidden">
            <Text bold={active} color={forcedFg} wrap="truncate" minWidth={0}>
              {row.subject}
            </Text>
          </Box>
        </>
      }
      step={
        <Text color={forcedFg ?? step.color} wrap="truncate">
          {step.text}
        </Text>
      }
      by={
        <Text color={forcedFg ?? "$fg-muted"} wrap="truncate">
          {timelineByCell(row)}
        </Text>
      }
      age={<Text color={forcedFg ?? "$fg-muted"}>{timelineAgeCell(row)}</Text>}
      runDuration={
        runDuration === "" ? (
          <Text> </Text>
        ) : (
          <Text color={forcedFg}>
            <Text color={forcedFg ?? "$fg-muted"}>{TIMELINE_TOTAL_GLYPH}</Text>
            {runDuration}
          </Text>
        )
      }
    />
  )
}

function QueueTabsLine({
  base,
  siblings,
  showLabel = true,
}: {
  base: string
  siblings: readonly string[]
  showLabel?: boolean
}) {
  if (siblings.length === 0) {
    return (
      <Text bold wrap="truncate">
        {showLabel ? `QUEUE ${base}` : base}
      </Text>
    )
  }
  return (
    <Box flexDirection="row" flexShrink={0} minWidth={0}>
      {showLabel ? (
        <Box paddingRight={1} flexShrink={0}>
          <Text bold>QUEUE</Text>
        </Box>
      ) : null}
      <Tabs value={base} isActive={false}>
        <TabList>
          {[base, ...siblings].map((value) => (
            <Tab key={value} value={value}>
              {value}
            </Tab>
          ))}
        </TabList>
      </Tabs>
    </Box>
  )
}

const RUNNER_STALE_MS = 15_000

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
 * 2026-07-15): a name-in-border-line title over a round box with no top edge —
 * the same style the STATS box established. `fill` makes the frame stretch to
 * its parent (pane usage); `padding` widens the inner content padding from the
 * single-line default (`paddingX=1`).
 */
export function TitledBox({
  title,
  borderColor,
  padding,
  fill = false,
  marginTop,
  children,
}: Readonly<{
  title: string
  borderColor?: string
  padding?: number
  fill?: boolean
  marginTop?: number
  children: React.ReactNode
}>) {
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
    >
      <Divider title={title} titleColor="$fg-muted" color={borderColor} />
      <Box
        borderStyle="round"
        borderTop={false}
        borderColor={borderColor}
        width="100%"
        flexDirection="column"
        flexGrow={fill ? 1 : undefined}
        minWidth={0}
        minHeight={0}
        {...(padding === undefined ? { paddingX: 1 } : { padding })}
      >
        {children}
      </Box>
    </Box>
  )
}

/** Zero-padded H:MM uptime clock (user format: `uptime 03:45`). */
function uptimeClock(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000))
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
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

/**
 * The RUNNER box renders the runner fact exactly once (15d), restyled per the
 * 2026-07-15 user spec: absent → one all-red `NO RUNNER - queue last drained
 * <age> ago` line; present → `[pid] <command line>` with a right-aligned
 * `uptime H:MM`; a stale heartbeat keeps its loud red line inside the box.
 */
function TimelineRunnerBox({ projection }: { projection: QueueTimelineProjection }) {
  const runner = projection.runner
  const timing = runnerTiming(projection)
  const runnerStale = timing !== null && timing.ageMs > RUNNER_STALE_MS
  if (runner === null) {
    const drained = timelineLastDrainedMs(projection)
    const now = Date.parse(projection.now)
    return (
      <TitledBox title="RUNNER" borderColor="$fg-error">
        <Text color="$fg-error" bold wrap="truncate">
          {drained === null
            ? "NO RUNNER - no drained run in window"
            : `NO RUNNER - queue last drained ${mediaDuration(now - drained)} ago`}
        </Text>
      </TitledBox>
    )
  }
  return (
    <TitledBox title="RUNNER" borderColor={runnerStale ? "$fg-error" : undefined}>
      <Box height={1} flexDirection="row" gap={1} minWidth={0}>
        <Text wrap="truncate" minWidth={0}>
          [{runner.pid}] {runner.command ?? "resident runner"}
        </Text>
        <Box flexGrow={1} flexBasis={0} minWidth={0} />
        <Text color="$fg-muted" flexShrink={0}>
          uptime {uptimeClock(timing?.uptimeMs ?? 0)}
        </Text>
      </Box>
      {runnerStale && timing !== null ? (
        <Text color="$fg-error" bold wrap="truncate">
          RUNNER STALE — last tick {mediaDuration(timing.ageMs)} ago
        </Text>
      ) : null}
    </TitledBox>
  )
}

// The STATUS box owns the queue-exception state that is not the runner fact:
// pause. The runner renders exactly once, in the RUNNER box above. Unpaused
// renders no box.
function TimelineStatusBox({ projection }: { projection: QueueTimelineProjection }) {
  const pause = projection.pause
  if (pause === undefined) return null
  const allowed = pause.allowedPRs.length === 0 ? "none" : pause.allowedPRs.join(",")
  return (
    <TitledBox title="STATUS" borderColor="$fg-warning">
      <Text color="$fg-warning" wrap="truncate">
        HOLD THE LINE — {pause.reason} · allowed {allowed}
      </Text>
    </TitledBox>
  )
}

function TimelineStatLine({ label, facts }: { label: string; facts: readonly (readonly [string, string])[] }) {
  return (
    <Text wrap="truncate">
      <Text color="$fg-muted">{label}</Text>
      {facts.map(([key, value]) => (
        <Text key={key}>
          {" "}
          <Text color="$fg-muted">{key}=</Text>
          {value}
        </Text>
      ))}
    </Text>
  )
}

function TimelineStatistics({ projection }: { projection: QueueTimelineProjection }) {
  const metrics = projection.metrics
  const decision = metrics.decisionRejection.rate
  const all = metrics.activeRun.allTerminal
  const integrated = metrics.activeRun.integratedOnly
  const wait = metrics.queueWait
  const count = (group: QueueTimelineGroup) => String(projection.rows.filter((row) => row.group === group).length)
  const distribution = (values: DurationDistribution | QueueWaitDistribution): (readonly [string, string])[] => [
    ["n", String(values.n)],
    ...("minMs" in values ? [["min", timelineMetric(values.minMs)] as const] : []),
    ["avg", timelineMetric(values.avgMs)],
    ["p50", timelineMetric(values.p50Ms)],
    ["p90", timelineMetric(values.p90Ms)],
    ["max", timelineMetric(values.maxMs)],
  ]
  return (
    <TitledBox title="STATS" marginTop={1}>
      <>
        <TimelineStatLine
          label="ROWS"
          facts={[
            ["pending", count("pending")],
            ["running", count("running")],
            ["completed", count("completed")],
            ["oldest", projection.oldestOpenMs === null ? "-" : mediaDuration(projection.oldestOpenMs)],
          ]}
        />
        <TimelineStatLine
          label="FLOW"
          facts={[
            ["attempts", String(metrics.terminalAttempts)],
            ["integrated", String(metrics.outcomes.integrated)],
            ["rejected", String(metrics.outcomes.rejected)],
            ["decision", decision === null ? "-" : `${(decision * 100).toFixed(1)}%`],
            ["env", String(metrics.outcomes.environmentRefused)],
            ["canceled", String(metrics.outcomes.canceled)],
          ]}
        />
        <TimelineStatLine label="ACTIVE ALL" facts={distribution(all)} />
        <TimelineStatLine label="ACTIVE INTEGRATED" facts={distribution(integrated)} />
        <TimelineStatLine label="WAIT" facts={distribution(wait)} />
      </>
    </TitledBox>
  )
}

/** The four operator-facing status buckets (user respec 2026-07-15). */
export type QueueTimelineStatusBucket = "pending" | "running" | "failed" | "done"

export const QUEUE_TIMELINE_STATUS_BUCKETS: readonly QueueTimelineStatusBucket[] = [
  "pending",
  "running",
  "failed",
  "done",
]

/** Bucket a row status: terminal failures (rejected/env-refused/canceled) are `failed`, integrated is `done`. */
export function queueTimelineStatusBucket(status: QueueTimelineStatus): QueueTimelineStatusBucket {
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

export function queueTimelineVisibleRows(
  projection: Pick<QueueTimelineProjection, "rows" | "display">,
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>,
): readonly QueueTimelineProjectedRow[] {
  const rows = projection.rows.slice(0, projection.display.shown)
  if (visibleBuckets === undefined) return rows
  return rows.filter((row) => visibleBuckets.has(queueTimelineStatusBucket(row.status)))
}

export function queueTimelineVisibleDefaultCursorId(
  projection: Pick<QueueTimelineProjection, "rows" | "display">,
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>,
): string | undefined {
  const rows = queueTimelineVisibleRows(projection, visibleBuckets)
  return queueTimelineDefaultCursorId(rows) ?? rows[0]?.id
}

/**
 * The FILTER line (user respec 2026-07-15): only non-default dimensions render
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
  return (
    <Box height={1} flexDirection="row" justifyContent="flex-end" gap={1} minWidth={0} overflow="hidden">
      <Text color="$fg-muted" flexShrink={0}>
        FILTER since={mediaDuration(filters.windowMs)}
      </Text>
      {filters.terms.length === 0 ? null : (
        <Text color="$fg-muted" flexShrink={0} wrap="truncate">
          terms={filters.terms.join("|")}
        </Text>
      )}
      {filters.latest ? (
        <Text color="$fg-muted" flexShrink={0}>
          latest
        </Text>
      ) : null}
      {QUEUE_TIMELINE_STATUS_BUCKETS.map((bucket) => (
        <Box
          key={bucket}
          flexShrink={0}
          onClick={onToggleBucket === undefined ? undefined : () => onToggleBucket(bucket)}
        >
          <Text color="$fg-muted">
            [{buckets.has(bucket) ? "x" : " "}] {bucket}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function ProjectedQueueTimeline({
  projection,
  nav,
  cursorKey,
  onCursor,
  onSelect,
  columns,
  paneChrome = false,
  fillHeight = false,
  visibleBuckets,
  onToggleBucket,
}: {
  projection: QueueTimelineProjection
  nav: boolean
  cursorKey?: number
  onCursor?: (index: number) => void
  onSelect?: (index: number) => void
  columns: number
  paneChrome?: boolean
  fillHeight?: boolean
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>
  onToggleBucket?: (bucket: QueueTimelineStatusBucket) => void
}) {
  const rows = queueTimelineVisibleRows(projection, visibleBuckets)
  const buckets = visibleBuckets ?? queueTimelineFilterBuckets(projection.filters.statuses)
  const includeDate = rows.some(
    (row) => row.timestamp !== null && row.timestamp.slice(0, 10) !== projection.now.slice(0, 10),
  )
  const layout = timelineCellLayout(rows, includeDate, columns)
  const updated = (
    <Text color="$fg-muted" flexShrink={0}>
      {/* The one temporal-trust cue is always `updated HH:MM:SS` — the
          snapshot clock is now, so day qualification never applies. */}
      updated {queueLogClock(projection.now, false, false)}
    </Text>
  )
  return (
    <Box width="100%" minWidth={0} minHeight={0} flexGrow={fillHeight ? 1 : undefined}>
      <Box flexGrow={1} flexBasis={0} maxWidth={TIMELINE_CONTENT_CAP} flexDirection="column" minWidth={0} minHeight={0}>
        {paneChrome ? (
          // Pane chrome: the pane's title-in-border already names the queue,
          // so the header row carries the sibling tabs (when any) on the left
          // and the `updated` clock in the top-right corner.
          <Box height={1} flexDirection="row" gap={1} minWidth={0}>
            {projection.siblingBases.length === 0 ? null : (
              <QueueTabsLine base={projection.base} siblings={projection.siblingBases} showLabel={false} />
            )}
            <Box flexGrow={1} flexBasis={0} minWidth={0} />
            {updated}
          </Box>
        ) : (
          <>
            <QueueTabsLine base={projection.base} siblings={projection.siblingBases} />
            <Box height={1} flexDirection="row" justifyContent="flex-end" gap={1} minWidth={0}>
              {updated}
            </Box>
          </>
        )}
        <TimelineRunnerBox projection={projection} />
        <TimelineStatusBox projection={projection} />
        <TimelineFilterLine projection={projection} buckets={buckets} onToggleBucket={onToggleBucket} />
        {rows.length === 0 ? (
          <Text color="$fg-muted">No matching queue rows.</Text>
        ) : (
          <Box flexDirection="column" minWidth={0} flexShrink={1} minHeight={0}>
            <TimelineHeader layout={layout} />
            <ListView
              items={rows}
              nav={nav}
              cursorKey={cursorKey}
              onCursor={onCursor}
              onSelect={onSelect}
              active={true}
              getKey={(row) => row.id}
              estimateHeight={1}
              renderItem={(row, _index, meta) => (
                <TimelineProjectedRow row={row} cursor={meta.isCursor} layout={layout} live={nav} />
              )}
            />
          </Box>
        )}
        {projection.display.hidden === 0 ? null : <Text color="$fg-muted">... {projection.display.hidden} more</Text>}
        {projection.coverage.complete ? null : (
          <Text color="$fg-warning">retained since {projection.coverage.retainedSince}</Text>
        )}
        {fillHeight ? <Box flexGrow={1} minHeight={0} /> : null}
        <TimelineStatistics projection={projection} />
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
  visibleBuckets,
  onToggleBucket,
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
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>
  onToggleBucket?: (bucket: QueueTimelineStatusBucket) => void
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
        visibleBuckets={visibleBuckets}
        onToggleBucket={onToggleBucket}
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
                <Text bold>{row.clock}</Text> <Text bold>{row.status}</Text> {row.pr} {row.run ?? "-"} {row.subject}{" "}
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
        const taskStatus = runTaskStatusOf({ status: outcome })
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
  const taskStatus = stepTaskStatusOf(step)
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
    errorCode: stepErrorCode(step),
    error: stepError(step),
    lost: stepLost(step),
    detail: stepDetail(step),
    output: stepOutput(step),
    artifacts: stepArtifactsText(step),
    evidence: stepEvidence(step),
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
  const locations = attemptLocations(attempt)
  const firstLocation = locations[0]?.location
  const artifacts = attemptArtifacts(attempt)
  const detail = isObjectValue(output) && typeof output.detail === "string" ? output.detail : undefined
  const taskStatus = jobAttemptTaskStatusOf(attempt)
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
    lost: attempt.result.status === "lost" ? attempt.result.reason : "-",
    detail: detail ?? (attempt.result.status === "failed" ? attempt.result.error.message : "-"),
    output:
      attempt.result.status === "lost"
        ? "-"
        : safeText(attempt.result.output ?? (attempt.result.status === "failed" ? attempt.result.error : undefined)),
    artifacts: artifacts.length === 0 ? "-" : artifactLabel(artifacts[0]),
    evidence: isObjectValue(output) ? output : "-",
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
    runIdentity: compact ? `r${row.revision}/${row.run}` : `(rev${row.revision}, run${row.run.replace(/^R/u, "")})`,
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
    { header: "PR", key: "pr" as const, maxWidth: compact ? 5 : 8 },
    { header: "REV·RUN", key: "runIdentity" as const, maxWidth: compact ? 8 : 18 },
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
  const errorCode = data.steps.find((step) => step.errorCode !== "-")?.errorCode
  if (["queue-environment-refused", "stale-pr", "stale-check", "job-lost"].includes(errorCode ?? "")) {
    return "repair the queue environment, then rerun the PR"
  }
  if (["canceled", "cancelled", "queue-canceled", "queue-cancelled"].includes(errorCode ?? "")) {
    return "inspect the newer PR revision; resubmit only if delivery is still required"
  }
  return "fix the branch, then run yrd pr submit again"
}

function QueueShowMembersValue({ data, highlightPr }: { data: QueueShowData; highlightPr?: string }) {
  return (
    <>
      {data.prs.map((pr, index) => (
        <Text key={pr.id} bold={pr.id === highlightPr}>
          {index === 0 ? "" : ","}
          {pr.id}@r{pr.revision}:{pr.headSha.slice(0, 12)}
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

function QueueStepLifecycleView({ row }: { row: QueueShowRow }) {
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        JOB {row.uuid} RUNNER {row.runner}
      </Text>
      <Text wrap="truncate">
        LEASE {row.lease} CHANGED {row.changed}
      </Text>
      <Text wrap="truncate">
        TIME REQUESTED {row.requested} STARTED {row.started} FINISHED {row.finished}
      </Text>
    </Box>
  )
}

function QueueProofView({ data }: { data: QueueShowData }) {
  return (
    <Box flexDirection="column">
      {data.steps.length === 0 ? (
        <Text color="$fg-muted">No step evidence recorded.</Text>
      ) : (
        data.steps.map((row) => (
          <Box key={`${row.uuid}:${row.attempt}:proof`} height={1}>
            <Text wrap="truncate">
              {`PROOF ${row.step}#${row.attempt} ART `}
              <QueueLogLocationLinks entries={row.locations} compact={false} />
              {` EVIDENCE ${singleQueue(
                typeof row.evidence === "string" ? row.evidence : safeText(row.evidence),
              )} CHECKPOINT ${singleQueue(row.checkpoint)}`}
            </Text>
          </Box>
        ))
      )}
      <Text>
        LANDING <Text color="$fg-muted">{data.landing}</Text>
      </Text>
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

function CompactQueueShowView({ data, highlightPr }: { data: QueueShowData; highlightPr?: string }) {
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate">
        RUN {data.run} STATUS {data.status} OUTCOME {data.outcome}
      </Text>
      <Text wrap="truncate">
        BASE {data.base} PRs <QueueShowMembersValue data={data} highlightPr={highlightPr} /> RETRY {data.retries}
      </Text>
      <Text wrap="truncate">
        START {data.started} END {data.finished}
      </Text>
      <Text wrap="truncate">
        TOTAL {data.totalDuration} ACTIVE {data.activeDuration} WAIT {data.waitDuration}
      </Text>
      {data.steps.map((row) => (
        <Box key={`${row.uuid}:${row.attempt}:compact`} flexDirection="column">
          <Text wrap="truncate">
            STEP {row.step}#{row.attempt} {row.status} DUR {row.duration} ERROR {row.errorCode}
          </Text>
          <QueueStepLifecycleView row={row} />
          <Text wrap="truncate">
            PROOF ART <QueueLogLocationLinks entries={row.locations} compact={false} /> EVIDENCE{" "}
            {singleQueue(typeof row.evidence === "string" ? row.evidence : safeText(row.evidence))}
          </Text>
        </Box>
      ))}
      <Text wrap="truncate">
        LANDING <Text color="$fg-muted">{data.landing}</Text>
      </Text>
      <Text wrap="wrap">NEXT {queueShowNextAction(data)}</Text>
    </Box>
  )
}

export function QueueShowView({
  data,
  compact = false,
  highlightPr,
}: {
  data: QueueShowData
  compact?: boolean
  highlightPr?: string
}) {
  if (compact) return <CompactQueueShowView data={data} highlightPr={highlightPr} />
  return (
    <Box flexDirection="column">
      <QueueShowMembersLine data={data} {...(highlightPr === undefined ? {} : { highlightPr })} />
      <Table
        data={[data]}
        columns={[
          { header: "RUN", key: "run", minWidth: 4 },
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
          { header: "RETRY", key: "retries", minWidth: 6, align: "right" },
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
              minWidth: 15,
              grow: true,
              render: (row) => <Text wrap="truncate">{row.errorCode}</Text>,
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
        REVISION CLOCK {clock.pr} rev{clock.revision} HEAD {clock.headSha}
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
      RUN {run.run} ADMITTED {clock.admittedBy} AT {at}
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
