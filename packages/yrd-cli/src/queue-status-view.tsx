import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BaysState, Correlation, PR, PRRevision, PRRevisionClock, PRRevisionTerminal } from "@yrd/bay"
import type { Event, JsonValue } from "@yrd/core"
import { JobRequestSchema, JobTransitionSchema, type Job, type JobError } from "@yrd/job"
import type { PRCheckRecord, PREligibility, QueueRun, QueueStep, QueueSummary } from "@yrd/queue"
import { Box, Link, ListView, Table, Text } from "silvery"
import { submittedPrPositions } from "./queue-position.ts"
import { formatDuration, PRStatusView, StatusValue } from "./status-view.tsx"

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

type QueueLogResult = QueueSummary & { prs?: readonly PR[] }

export type QueueLogRow = Readonly<{
  run: string
  base: string
  pr: string
  branch: string
  subject: string
  glyph: string
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
  attempts: readonly QueueLogAttempt[]
  activeSteps: readonly Readonly<{ step: string; duration: string; durationMs: number }>[]
  retries: string
  parent: string
  isolationPart: "0" | "1" | "-"
  result: string
  error: string
  location?: QueueLogLocation
  locations: readonly QueueLogLocationEntry[]
  integration?: {
    commit: string
    baseSha: string
  }
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
    glyph: string
    runId?: string
    submittedAt?: string
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
  attempt: string
  uuid: string
  requested: string
  started: string
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
  integration?: {
    commit: string
    baseSha: string
  }
  parent: string
  isolationPart: "0" | "1" | "-"
  prs: QueueRun["prs"]
  revisionClock?: PRRunRevisionClock
  attempts: readonly QueueAttempt[]
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
type QueueLogLocationEntry = Readonly<{ label: string; location: QueueLogLocation }>

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

function queueTimelineTimestamp(run: QueueRun | undefined, pr: PR): string | undefined {
  return run?.finishedAt ?? run?.startedAt ?? pr.submittedAt
}

function queueTimelineDetail(result: QueueStatusResult, pr: PR, run: QueueRun | undefined): string {
  if (run === undefined) {
    const position = submittedPrPositions(result.prs).get(pr.id)
    return position === undefined ? "queued" : `position ${position}`
  }
  const step = relevantStep(run)
  if (step?.job?.status === "failed") return step.job.error.message
  return queueLanding(run)
}

function queueTimelineGroup(row: QueueTimelineRow): 0 | 1 | 2 {
  if (row.run === undefined) return 0
  return row.status === "running" || row.status === "waiting" ? 1 : 2
}

function compareQueueTimelineRows(left: QueueTimelineRow, right: QueueTimelineRow): number {
  const group = queueTimelineGroup(left)
  const groupOrder = group - queueTimelineGroup(right)
  if (groupOrder !== 0) return groupOrder
  if (group === 0) {
    const positionOrder = (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER)
    if (positionOrder !== 0) return positionOrder
  } else if (left.timestampMs !== right.timestampMs) {
    return group === 1 ? left.timestampMs - right.timestampMs : right.timestampMs - left.timestampMs
  }
  const prOrder = left.pr.localeCompare(right.pr, undefined, { numeric: true })
  return prOrder === 0 ? left.key.localeCompare(right.key) : prOrder
}

export function queueTimelineRows(
  results: readonly QueueStatusResult[],
  now: number,
  latest: boolean,
  state?: BaysState,
): QueueTimelineRow[] {
  const rows = results.flatMap((result) => {
    const runs = [...result.running, ...result.waiting, ...result.finished]
    const positions = submittedPrPositions(result.prs)
    const pending = result.prs
      .filter(
        (pr) =>
          pr.status === "submitted" &&
          !runs.some((run) =>
            run.prs.some(
              (member) => member.id === pr.id && member.revision === pr.revision && member.headSha === pr.headSha,
            ),
          ),
      )
      .map((pr) => {
        const position = positions.get(pr.id)
        const timestamp = pr.submittedAt
        const timestampMs = timestamp === undefined ? -1 : Date.parse(timestamp)
        return {
          key: `pending:${result.base}:${pr.id}`,
          pr: pr.id,
          ...(position === undefined ? {} : { position }),
          base: result.base,
          status: pr.status,
          subject: boundedQueue(
            (pr.bay === undefined ? undefined : state?.byId[pr.bay]?.path) ?? pr.branch ?? pr.id,
            80,
          ),
          detail: queueTimelineDetail(result, pr, undefined),
          clock: age(timestamp, now, "queue timeline row"),
          timestampMs: Number.isFinite(timestampMs) ? timestampMs : -1,
        }
      })
    const runRows = runs.flatMap((run) =>
      run.prs.map((member) => {
        const pr = result.prs.find((candidate) => candidate.id === member.id)
        const timestamp = queueTimelineTimestamp(
          run,
          pr ?? ({ id: member.id, branch: member.branch, status: "submitted" } as PR),
        )
        const timestampMs = timestamp === undefined ? -1 : Date.parse(timestamp)
        return {
          key: `run:${result.base}:${run.id}:${member.id}`,
          pr: member.id,
          run: run.id,
          base: result.base,
          status: queueOutcome(run),
          subject: boundedQueue(
            (pr?.bay === undefined ? undefined : state?.byId[pr.bay]?.path) ?? pr?.name ?? member.branch ?? member.id,
            80,
          ),
          detail: queueTimelineDetail(
            result,
            pr ?? ({ id: member.id, branch: member.branch, status: "submitted" } as PR),
            run,
          ),
          clock: age(timestamp, now, "queue timeline row"),
          timestampMs: Number.isFinite(timestampMs) ? timestampMs : -1,
        }
      }),
    )
    return [...pending, ...runRows]
  })

  if (!latest) return rows.toSorted(compareQueueTimelineRows)
  const latestByPr = new Map<string, QueueTimelineRow>()
  for (const row of rows) {
    const previous = latestByPr.get(row.pr)
    if (
      previous === undefined ||
      row.timestampMs > previous.timestampMs ||
      (row.timestampMs === previous.timestampMs && compareQueueTimelineRows(row, previous) < 0)
    ) {
      latestByPr.set(row.pr, row)
    }
  }
  return [...latestByPr.values()].toSorted(compareQueueTimelineRows)
}

function matchingRevision(pr: PR, pinned: PinnedPRRevision): PRRevision | undefined {
  return pr.revisions?.find((revision) => revision.revision === pinned.revision && revision.headSha === pinned.headSha)
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
  const iso = new Date(timestamp).toISOString()
  if (includeDate) return `${iso.slice(0, 19)}Z`
  return compact ? iso.slice(11, 16) : iso.slice(11, 19)
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
    locations.push({ label, location })
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
    return location === undefined ? [] : [{ label: artifactLabel(artifact), location }]
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

function queueOutcome(run: QueueRun): string {
  if (run.status === "passed") return queueIntegration(run) === undefined ? "passed" : "integrated"
  if (run.status === "failed") return "rejected"
  return run.status
}

function queueIntegration(run: QueueRun): { commit: string; baseSha: string } | undefined {
  return run.integration ?? ("integration" in run.shape ? run.shape.integration : undefined)
}

function queueLanding(run: QueueRun): string {
  const proof = queueIntegration(run)
  if (proof === undefined) return "-"
  return `${proof.commit.slice(0, 12)}@${proof.baseSha.slice(0, 12)}`
}

function queueOutcomeIntegration(run: QueueRun): { commit: string; baseSha: string } {
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
            {`${entry.label}=${target}`}
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
            <Link href={href}>{compact ? String(index + 1) : entry.label}</Link>
          </Text>
        )
      })}
    </Text>
  )
}

const QUEUE_ROW_LIMIT = 5
const RECENT_ROW_LIMIT = 3

function statusGlyph(status: string): string {
  if (["checking", "running", "waiting"].includes(status)) return "[/]"
  if (["integrated", "passed"].includes(status)) return "[x]"
  if (["rejected", "failed", "lost"].includes(status)) return "[!]"
  if (["withdrawn", "retired"].includes(status)) return "[-]"
  return "[ ]"
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

function failureEvidence(step: QueueStep | undefined): HumanFailureProjection["evidence"] {
  const location = stepLocations(step)[0]?.location
  if (location === undefined) return undefined
  return "path" in location
    ? { text: location.path, href: pathToFileURL(location.path).href }
    : { text: location.url, href: location.url }
}

function projectPR(
  state: BaysState | undefined,
  result: QueueStatusResult,
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
    glyph: statusGlyph(stateLabel),
    ...(run === undefined ? {} : { runId: run.id }),
    ...(submittedAt === undefined ? {} : { submittedAt }),
    target: pr.base,
    age: age(submittedAt ?? revision?.pushedAt, ageAt, `PR '${pr.id}' submitted age`),
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
    const omitted = run.stepSelection?.omittedChecks
    const steps = run.steps.map((step) => `${step.name}=${jobStatus(step)}`).join(" ")
    return {
      run: run.id,
      prs: run.prs.map((pr) => pr.id).join(","),
      state: run.status,
      steps: boundedQueue(omitted === undefined ? steps : `${steps} (configured checks omitted: ${omitted.join(",")})`),
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
          minWidth: 8,
          render: (row) => <StatusValue value={row.state} />,
        },
        { header: "STEPS", key: "steps", grow: true },
      ]}
    />
  )
}

export function PREligibilityView({ rows }: { rows: readonly Readonly<{ pr: PR; eligibility: PREligibility }>[] }) {
  const data = rows.map(({ pr, eligibility }) => ({
    pr: pr.id,
    branch: pr.branch,
    revision: pr.revision,
    ready: eligibility.runnable ? "yes" : "no",
    why: eligibility.reason?.message ?? "ready",
    review: eligibility.review.required
      ? eligibility.review.approved
        ? `approved${eligibility.review.actor === undefined ? "" : ` by ${eligibility.review.actor}`}`
        : eligibility.review.decision === "reject"
          ? `rejected${eligibility.review.actor === undefined ? "" : ` by ${eligibility.review.actor}`}`
          : "required"
      : "not required",
    checks: `${eligibility.checks.status}${
      eligibility.checks.position === undefined ? "" : ` #${eligibility.checks.position}`
    }`,
  }))
  return (
    <Table
      data={data}
      columns={[
        { header: "PR", key: "pr" },
        { header: "BRANCH", key: "branch" },
        { header: "REV", key: "revision" },
        { header: "READY", key: "ready" },
        { header: "WHY", key: "why", grow: true },
        { header: "REVIEW", key: "review" },
        { header: "CHECKS", key: "checks" },
      ]}
    />
  )
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
  const data = records.map((record) => ({
    pr: record.pr,
    revision: record.revision,
    check: record.step ?? (record.position === undefined ? "-" : `queue #${record.position}`),
    state: record.status,
    classification: record.classification ?? "-",
    age:
      record.queuedAt === undefined || !Number.isFinite(Date.parse(record.queuedAt))
        ? "-"
        : formatDuration(Math.max(0, now - Date.parse(record.queuedAt))),
    command: singleQueue(record.command?.join(" ") ?? "-"),
    diagnostic: checkDiagnosticText(record.diagnostics ?? record.error?.message),
    artifact: record.artifact,
  }))
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
            render: (row) => <StatusValue value={row.state} />,
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
  now,
  position,
}: {
  pr: PR
  runs: readonly QueueRun[]
  now: number
  position?: number
}) {
  const run = latestPRRun(pr, runs)
  const member = run?.prs.find((candidate) => candidate.id === pr.id)
  const activeStep = relevantStep(run)
  const blocker = diagnosticBlocker(pr, run, activeStep, now)
  const landing = pr.integration ?? (run === undefined ? undefined : queueIntegration(run))

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>PR</Text> {pr.id} <Text bold>STATUS</Text> <StatusValue value={pr.status} />
        {position === undefined ? null : ` POSITION ${position}`}
      </Text>
      <Text>
        <Text bold>SOURCE</Text> {pr.branch} <Text bold>REV</Text> {pr.revision} <Text bold>HEAD</Text> {pr.headSha}
      </Text>
      <Text>
        <Text bold>BASE</Text> {pr.base}
        {pr.baseSha === undefined ? null : `@${pr.baseSha}`}
      </Text>
      {run === undefined ? (
        <Text color="$fg-muted">No run recorded.</Text>
      ) : (
        <>
          <Text>
            <Text bold>RUN</Text> {run.id} <StatusValue value={run.status} /> <Text bold>REV</Text>{" "}
            {member?.revision ?? "-"} <Text bold>HEAD</Text> {member?.headSha ?? "-"}
          </Text>
          <Text>
            <Text bold>TIME</Text> START {toIso(run.startedAt)} END {toIso(run.finishedAt)} ELAPSED{" "}
            {duration(run.startedAt, run.finishedAt ?? new Date(now).toISOString())}
          </Text>
          {run.steps.map((step) => {
            const job = step.job
            const runner = job !== undefined && "runner" in job ? job.runner : "-"
            const finished = job !== undefined && "finishedAt" in job ? toIso(job.finishedAt) : "-"
            const lease = job?.status === "running" ? job.leaseExpiresAt : "-"
            return (
              <Box key={`${run.id}:${step.name}`} flexDirection="column" marginTop={1}>
                <Text>
                  <Text bold>STEP</Text> {step.name} <StatusValue value={jobStatus(step)} /> <Text bold>REV</Text>{" "}
                  {step.revision}
                </Text>
                <Text>
                  <Text bold>JOB</Text> {job?.id ?? "-"} <Text bold>ATTEMPT</Text> {job?.attempt ?? "-"}{" "}
                  <Text bold>RUNNER</Text> {runner} <Text bold>LEASE</Text> {lease}
                </Text>
                <Text>
                  <Text bold>TIME</Text> REQUESTED {toIso(job?.requestedAt)} STARTED{" "}
                  {job === undefined || !("startedAt" in job) ? "-" : toIso(job.startedAt)} CHANGED{" "}
                  {toIso(job?.changedAt)} FINISHED {finished}
                </Text>
              </Box>
            )
          })}
        </>
      )}
      {blocker === undefined ? null : (
        <Text color="$fg-warning">
          <Text bold>BLOCKER</Text> {blocker}
        </Text>
      )}
      <Text>
        <Text bold>LANDING</Text> {landing === undefined ? "-" : `${landing.commit}@${landing.baseSha}`}
      </Text>
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
        <Text bold>ACTIVE</Text> {active.run} {active.pr} {active.subject} {active.glyph} {active.step} {active.elapsed}
      </Text>
    </Box>
  )
}

function ProjectedPRQueue({ row, position }: { row: HumanPRProjection; position?: number }) {
  return (
    <Box height={1}>
      <Text wrap="truncate">
        {position === undefined ? "" : `${position}. `}
        {row.glyph} {row.prHref === undefined ? row.pr : <CellLink href={row.prHref}>{row.pr}</CellLink>} {row.subject}{" "}
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
  glyph: string
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
  glyph: string
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
  return {
    run: run.id,
    pr: member.id,
    subject: boundedQueue(pr?.name ?? member.id, 80),
    step: step?.name ?? "-",
    glyph: statusGlyph(run.status),
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

export function QueueTimelineView({
  results,
  now,
  latest = false,
  state,
  nav = false,
  cursorKey,
  onCursor,
  onSelect,
}: {
  results: readonly QueueStatusResult[]
  now: number
  latest?: boolean
  state?: BaysState
  nav?: boolean
  cursorKey?: number
  onCursor?: (index: number) => void
  onSelect?: (index: number) => void
}) {
  const rows = queueTimelineRows(results, now, latest, state)
  if (rows.length === 0) return <Text color="$fg-muted">No matching queue rows.</Text>
  return (
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
        rows.push({
          run: run.id,
          base: run.base,
          pr: pr.id,
          branch: pr.branch,
          subject: revisionSubjects.get(queueRevisionKey(pr)) ?? pr.branch,
          glyph: statusGlyph(outcome),
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
      rows.push({
        run: "-",
        base: exampleResult?.base ?? "-",
        pr: prFilter,
        branch: exampleResult?.branch ?? "-",
        subject:
          (exampleResult === undefined ? undefined : revisionSubjects.get(queueRevisionKey(exampleResult))) ??
          exampleResult?.branch ??
          prFilter,
        glyph: statusGlyph("retired"),
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
  const stepDurationMs =
    step.job === undefined || !("startedAt" in step.job) || !("finishedAt" in step.job)
      ? undefined
      : elapsedMs(step.job.startedAt, step.job.finishedAt)
  return {
    step: step.name,
    revision: step.revision,
    status: jobStatus(step),
    attempt: step.job === undefined ? "-" : String(step.job.attempt),
    uuid: step.job?.id ?? "-",
    requested: step.job === undefined ? "-" : toIso(step.job.requestedAt),
    started: step.job === undefined || !("startedAt" in step.job) ? "-" : toIso(step.job.startedAt),
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
  return {
    step: attempt.step,
    revision: attempt.revision,
    status: attempt.outcome,
    attempt: String(attempt.attempt),
    uuid: attempt.job,
    requested: toIso(attempt.requestedAt),
    started: toIso(attempt.startedAt),
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
  const durations = runDurations(run, runAttempts)
  const runDurationMs = durations.totalDurationMs
  return {
    run: run.id,
    base: run.base,
    status: run.status,
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
  void coverage
  return (
    <Box flexDirection="column">
      {rows.length === 0 ? (
        <Text color="$fg-muted">No matching terminal log rows.</Text>
      ) : (
        <Box flexDirection="column">
          <Box height={1}>
            <Text color="$fg-muted" wrap="truncate">
              {compact
                ? "GLYPH TIME PR REV RUN OUTCOME ART SUBJECT AGE TOTAL"
                : "GLYPH TIME LEVEL [BASE] PR (REV,RUN) OUTCOME ART SUBJECT AGE TOTAL ACTIVE WAIT"}
            </Text>
          </Box>
          {visibleRows.map((row) => {
            const identity = compact
              ? `${row.glyph} ${queueLogClock(row.startedAt, true, includeDate)} ${row.pr} r${row.revision} ${row.run} ${row.outcome}`
              : `${row.glyph} ${queueLogClock(row.startedAt, false, includeDate)} ${queueLogLevel(row.outcome)} [${row.base}] ${row.pr} (rev${row.revision}, run${row.run.replace(/^R/u, "")}) ${row.outcome}`
            const hasWait = Math.round((row.waitDurationMs ?? 0) / 1_000) > 0
            return (
              <Box key={`${row.run}:${row.pr}:${row.revision}`} height={1}>
                <Text wrap="truncate">
                  {identity}
                  {row.locations.length === 0 ? null : (
                    <>
                      {" "}
                      <QueueLogLocationLinks entries={row.locations} compact />
                    </>
                  )}{" "}
                  {row.subject}
                  {row.ageMs === undefined ? null : ` age=${relativeAge(row.ageMs)}`}
                  {row.totalDurationMs === undefined ? null : ` total=${mediaDuration(row.totalDurationMs)}`}
                  {!hasWait || row.activeDurationMs === undefined
                    ? null
                    : ` active=${mediaDuration(row.activeDurationMs)}`}
                  {!hasWait || row.waitDurationMs === undefined ? null : ` wait=${mediaDuration(row.waitDurationMs)}`}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

export function QueueShowView({ data }: { data: QueueShowData }) {
  return (
    <Box flexDirection="column">
      <Table
        data={[data]}
        columns={[
          { header: "RUN", key: "run", minWidth: 4 },
          { header: "BASE", key: "base", minWidth: 5 },
          {
            header: "STATUS",
            key: "status",
            minWidth: 11,
            render: (row) => <StatusValue value={row.status} />,
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
              minWidth: 8,
              render: (row) => <StatusValue value={row.status} />,
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
        <Box flexDirection="column">
          {data.steps.map((row) => (
            <Box key={`${row.uuid}:${row.attempt}:proof`} height={1}>
              <Text wrap="truncate">
                {`PROOF ${row.step}#${row.attempt} ART `}
                <QueueLogLocationLinks entries={row.locations} compact={false} />
                {` EVIDENCE ${singleQueue(
                  typeof row.evidence === "string" ? row.evidence : safeText(row.evidence),
                )} CHECKPOINT ${singleQueue(row.checkpoint)}`}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text>
          LANDING <Text color="$fg-muted">{data.landing}</Text>
        </Text>
      </Box>
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
