import { existsSync } from "node:fs"
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BaysState, PR } from "@yrd/bay"
import type { Event, JsonValue } from "@yrd/core"
import { JobRequestSchema, JobTransitionSchema, type Job } from "@yrd/job"
import type { QueueRun, QueueStep, QueueSummary } from "@yrd/queue"
import { Box, Link, Spinner, Table, Text } from "silvery"
import {
  queueFlowMetrics,
  type QueueFlowMetrics,
  type QueueTerminalFact,
  type QueueTerminalOutcome,
} from "./queue-metrics.ts"
import { submittedPrPositions } from "./queue-position.ts"
import { formatDuration, PRStatusView, StatusValue } from "./status-view.tsx"

export type QueueStatusResult = QueueSummary & { headSha?: string; prs: PR[] }

export type QueueTimelineStatusFilter = "pending" | "running" | "rejected" | "integrated" | "other"
export type QueueTimelineStatus = "pending" | "running" | QueueTerminalOutcome
export type QueueTimelineGroup = "pending" | "running" | "completed"

export type QueueTimelineRow = Readonly<{
  id: string
  base: string
  group: QueueTimelineGroup
  status: QueueTimelineStatus
  glyph: string
  timestamp: string | null
  timestampMs: number | null
  run?: string
  prs: readonly string[]
  branches: readonly string[]
  subject: string
  detail: string
  position?: number
  failure?: Readonly<{ code: string; message: string }>
  ageMs: number | null
  tookMs: number | null
  activeMs: number | null
  queueWaitMs: readonly (number | null)[]
}>

export type QueueTimelineProjection = Readonly<{
  now: string
  base: string
  siblingBases: readonly string[]
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
  rows: readonly QueueTimelineRow[]
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
  submissionTimes: ReadonlyMap<string, string>
  attempts?: readonly QueueAttempt[]
  retainedSinceMs?: number
  siblingBases?: readonly string[]
  base?: string
}>

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
  | Readonly<{ status: "failed"; error: Readonly<{ code: string; message: string }>; output?: JsonValue }>
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

export async function queueSubmissionTimes(
  events: AsyncIterable<Event> | Iterable<Event>,
): Promise<Map<string, string>> {
  const submissions = new Map<string, string>()
  for await (const event of events) {
    if (event.name !== "pr/submitted" || !isObjectValue(event.data)) continue
    const { pr, revision, headSha } = event.data
    if (typeof pr !== "string" || typeof revision !== "number" || typeof headSha !== "string") continue
    submissions.set(queueRevisionKey({ id: pr, revision, headSha }), event.ts)
  }
  return submissions
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
  attempts: readonly QueueAttempt[]
  steps: readonly QueueShowRow[]
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
  return [...summary.running, ...summary.waiting, ...summary.finished]
    .filter((run) => run.prs.some((member) => member.id === pr.id))
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt))
    .at(-1)
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

function repoRelativePath(path: string): string {
  return relative(process.cwd(), path) || "."
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
  if (run.status === "passed") return "integrated"
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
        const target = "path" in entry.location ? repoRelativePath(entry.location.path) : entry.location.url
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
  const value = elapsedMs(timestamp, nowIso, subject)
  return value ?? null
}

function timelineSubject(result: QueueStatusResult, run: QueueRun): string {
  return run.prs
    .map((member) => {
      const current = result.prs.find((candidate) => candidate.id === member.id)
      return current?.name ?? member.name ?? current?.branch ?? member.branch
    })
    .join(" · ")
}

function timelineQueueWaits(run: QueueRun, submissionTimes: ReadonlyMap<string, string>): (number | null)[] {
  return run.prs.map((member) => {
    const submittedAt = submissionTimes.get(queueRevisionKey(member))
    const wait = elapsedMs(submittedAt, run.startedAt, `PR '${member.id}' queue wait`)
    return wait ?? null
  })
}

function timelineRunRow(
  result: QueueStatusResult,
  run: QueueRun,
  nowIso: string,
  submissionTimes: ReadonlyMap<string, string>,
): QueueTimelineRow {
  const running = run.status === "running" || run.status === "waiting"
  const status: QueueTimelineStatus = running ? "running" : terminalOutcome(run)
  const timestamp = running ? toIso(run.startedAt) : run.finishedAt === undefined ? null : toIso(run.finishedAt)
  const timestampMs = parsedTimelineTimestamp(timestamp ?? undefined, `Run '${run.id}' timeline`)
  const activeMs = running
    ? timelineAge(run.startedAt, nowIso, `Run '${run.id}' active duration`)
    : (elapsedMs(run.startedAt, run.finishedAt, `Run '${run.id}' active duration`) ?? null)
  const failure = status === "integrated" ? undefined : failureFact(run, relevantStep(run))
  const step = relevantStep(run)
  const subject = timelineSubject(result, run)
  const detail =
    failure === undefined
      ? status === "integrated"
        ? queueLanding(run)
        : step === undefined
          ? run.status
          : `${step.name}: ${jobStatus(step)}`
      : `${failure.code}: ${causalSummary(failure.message)}`
  return {
    id: `${run.base}:run:${run.id}`,
    base: run.base,
    group: running ? "running" : "completed",
    status,
    glyph: statusGlyph(status),
    timestamp,
    timestampMs,
    run: run.id,
    prs: run.prs.map((member) => member.id),
    branches: run.prs.map((member) => member.branch),
    subject,
    detail,
    ...(failure === undefined ? {} : { failure }),
    ageMs: timelineAge(timestamp ?? undefined, nowIso, `Run '${run.id}' recency`),
    tookMs: activeMs,
    activeMs,
    queueWaitMs: running ? [] : timelineQueueWaits(run, submissionTimes),
  }
}

function timelinePendingRows(
  result: QueueStatusResult,
  nowIso: string,
  submissionTimes: ReadonlyMap<string, string>,
): QueueTimelineRow[] {
  const activePrs = new Set([...result.running, ...result.waiting].flatMap((run) => run.prs.map((member) => member.id)))
  const positions = submittedPrPositions(result.prs)
  return result.prs.flatMap((pr) => {
    if (pr.status !== "submitted" || activePrs.has(pr.id)) return []
    const timestamp = submissionTimes.get(queueRevisionKey(pr)) ?? pr.submittedAt ?? null
    const timestampMs = parsedTimelineTimestamp(timestamp ?? undefined, `PR '${pr.id}' submission`)
    const position = positions.get(pr.id)
    return [
      {
        id: `${pr.base}:pr:${pr.id}:${pr.revision}:${pr.headSha}`,
        base: pr.base,
        group: "pending" as const,
        status: "pending" as const,
        glyph: statusGlyph("pending"),
        timestamp,
        timestampMs,
        prs: [pr.id],
        branches: [pr.branch],
        subject: pr.name ?? pr.branch,
        detail: position === undefined ? "queued" : `position ${position}`,
        ...(position === undefined ? {} : { position }),
        ageMs: timelineAge(timestamp ?? undefined, nowIso, `PR '${pr.id}' queue age`),
        tookMs: timelineAge(timestamp ?? undefined, nowIso, `PR '${pr.id}' queue wait`),
        activeMs: null,
        queueWaitMs: [],
      },
    ]
  })
}

function timelineSort(left: QueueTimelineRow, right: QueueTimelineRow): number {
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

function timelineMatches(row: QueueTimelineRow, terms: readonly string[]): boolean {
  if (terms.length === 0) return true
  const searchable = [row.run ?? "", ...row.prs, ...row.branches, row.subject, row.failure?.code ?? ""]
    .join("\n")
    .toLocaleLowerCase()
  return terms.some((term) => searchable.includes(term))
}

function latestTimelineRows(rows: readonly QueueTimelineRow[]): QueueTimelineRow[] {
  const latestByPr = new Map<string, QueueTimelineRow>()
  for (const row of rows) {
    for (const pr of row.prs) {
      const current = latestByPr.get(pr)
      const currentAt = current?.timestampMs ?? Number.NEGATIVE_INFINITY
      const nextAt = row.timestampMs ?? Number.NEGATIVE_INFINITY
      if (current === undefined || nextAt > currentAt || (nextAt === currentAt && row.id > current.id)) {
        latestByPr.set(pr, row)
      }
    }
  }
  return rows.flatMap((row) => {
    const memberIndexes = row.prs.flatMap((pr, index) => (latestByPr.get(pr)?.id === row.id ? [index] : []))
    if (memberIndexes.length === 0) return []
    if (memberIndexes.length === row.prs.length) return [row]
    const prs = memberIndexes.flatMap((index) => {
      const pr = row.prs[index]
      return pr === undefined ? [] : [pr]
    })
    const branches = memberIndexes.flatMap((index) => {
      const branch = row.branches[index]
      return branch === undefined ? [] : [branch]
    })
    const queueWaitMs = memberIndexes.map((index) => row.queueWaitMs[index] ?? null)
    return [{ ...row, prs, branches, subject: branches.join(" · "), queueWaitMs }]
  })
}

export function queueTimelineProjection(
  results: readonly QueueStatusResult[],
  options: QueueTimelineProjectionOptions,
): QueueTimelineProjection {
  if (!Number.isFinite(options.now) || options.now < 0) throw new TypeError("yrd: timeline snapshot time is invalid")
  if (!Number.isFinite(options.windowMs) || options.windowMs < 0) throw new TypeError("yrd: timeline window is invalid")
  const nowIso = new Date(options.now).toISOString()
  const sinceMs = options.now - options.windowMs
  const since = new Date(sinceMs).toISOString()
  const requestedStatuses = options.statuses.length === 0 ? TIMELINE_STATUS_ORDER : options.statuses
  const statuses = TIMELINE_STATUS_ORDER.filter((status) => requestedStatuses.includes(status))
  const selectedStatuses = new Set(statuses)
  const terms = [...new Set(options.terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean))]
  const rawRows = results.flatMap((result) => [
    ...timelinePendingRows(result, nowIso, options.submissionTimes),
    ...[...result.running, ...result.waiting, ...result.finished].map((run) =>
      timelineRunRow(result, run, nowIso, options.submissionTimes),
    ),
  ])
  const filtered = rawRows
    .filter((row) => selectedStatuses.has(timelineStatusFilter(row.status)))
    .filter((row) => row.timestampMs === null || (row.timestampMs >= sinceMs && row.timestampMs <= options.now))
    .filter((row) => timelineMatches(row, terms))
  const rows = (options.latest ? latestTimelineRows(filtered) : filtered).toSorted(timelineSort)
  const terminalFacts: QueueTerminalFact[] = rows.flatMap((row) => {
    if (row.group !== "completed" || row.timestampMs === null) return []
    return [
      {
        run: row.id,
        terminalAtMs: row.timestampMs,
        outcome: row.status as QueueTerminalOutcome,
        activeMs: row.activeMs,
        queueWaitMs: row.queueWaitMs.filter((wait): wait is number => wait !== null),
      },
    ]
  })
  const allRuns = results.flatMap((result) => [...result.running, ...result.waiting, ...result.finished])
  const finished = results.flatMap((result) => result.finished)
  const details = rows.flatMap((row) => {
    if (row.run === undefined) return []
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
    ? { text: repoRelativePath(location.path), href: pathToFileURL(location.path).href }
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
  const revision = pr.revisions?.at(-1)
  const touchedAt = latest(
    ...(runOverride === undefined
      ? [revision?.pushedAt, pr.submittedAt, pr.rejectedAt, pr.integratedAt, pr.withdrawnAt]
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
    runOverride?.finishedAt ??
    (pr.status === "rejected"
      ? pr.rejectedAt
      : pr.status === "integrated"
        ? pr.integratedAt
        : pr.status === "withdrawn"
          ? pr.withdrawnAt
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
    ...(pr.submittedAt === undefined ? {} : { submittedAt: pr.submittedAt }),
    target: pr.base,
    age: age(pr.submittedAt ?? revision?.pushedAt, ageAt, `PR '${pr.id}' submitted age`),
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
  const data = runs.map((run) => ({
    run: run.id,
    prs: run.prs.map((pr) => pr.id).join(","),
    state: run.status,
    steps: boundedQueue(run.steps.map((step) => `${step.name}=${jobStatus(step)}`).join(" ")),
  }))
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

export function PRResultView({ prs, runs }: { prs: readonly PR[]; runs: readonly QueueRun[] }) {
  return (
    <Box flexDirection="column">
      <PRStatusView prs={prs} />
      {runs.length > 0 && (
        <Box marginTop={1}>
          <QueueRunsView runs={runs} />
        </Box>
      )}
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

function timelineMetric(value: number | null): string {
  return value === null ? "-" : mediaDuration(value)
}

function timelineDistribution(label: string, distribution: QueueFlowMetrics["activeRun"]["allTerminal"]): string {
  return `${label} n=${distribution.n} min=${timelineMetric(distribution.minMs)} avg=${timelineMetric(distribution.avgMs)} p50=${timelineMetric(distribution.p50Ms)} p90=${timelineMetric(distribution.p90Ms)} max=${timelineMetric(distribution.maxMs)}`
}

function timelineStatusCell(row: QueueTimelineRow) {
  const colors: Record<QueueTimelineStatus, Readonly<{ backgroundColor: string; color: string }>> = {
    pending: { backgroundColor: "$bg-accent", color: "$fg-on-accent" },
    running: { backgroundColor: "$bg-info", color: "$fg-on-info" },
    integrated: { backgroundColor: "$bg-success", color: "$fg-on-success" },
    rejected: { backgroundColor: "$bg-error", color: "$fg-on-error" },
    "environment-refused": { backgroundColor: "$bg-warning", color: "$fg-on-warning" },
    canceled: { backgroundColor: "$bg-inverse", color: "$fg-on-inverse" },
  }
  const label = row.status === "environment-refused" ? "env-refused" : row.status
  return (
    <Box
      width="100%"
      height={1}
      minWidth={0}
      gap={1}
      paddingX={1}
      overflow="hidden"
      backgroundColor={colors[row.status].backgroundColor}
      color={colors[row.status].color}
    >
      {row.status === "running" ? <Spinner type="line" /> : <Text>{row.glyph}</Text>}
      <Text bold wrap="truncate">
        {label}
      </Text>
    </Box>
  )
}

function timelineCell(row: QueueTimelineRow, value: string) {
  return (
    <Text color={row.status === "integrated" ? "$fg-muted" : undefined} wrap="truncate">
      {value}
    </Text>
  )
}

function timelineDetailCell(row: QueueTimelineRow) {
  if (row.failure === undefined) return timelineCell(row, row.detail)
  return (
    <Text wrap="truncate">
      {row.failure.code}: <Text color="$fg-muted">{causalSummary(row.failure.message)}</Text>
    </Text>
  )
}

function timelineClock(row: QueueTimelineRow, includeDate: boolean): string {
  if (row.timestamp === null) return "-"
  const iso = new Date(row.timestamp).toISOString()
  return includeDate ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(11, 19)
}

type QueueTimelineTableRow = QueueTimelineRow &
  Readonly<{
    clock: string
    identity: string
    transit: string
  }>

export function QueueTimelineView({
  projection,
  interactive,
  active = true,
  cursorId,
  onActivate,
  onCursorIdChange,
}: {
  projection: QueueTimelineProjection
  interactive: boolean
  active?: boolean
  cursorId?: string | number | null
  onActivate?: (row: QueueTimelineRow) => void
  onCursorIdChange?: (id: string | number | null) => void
}) {
  const visibleRows = projection.rows.slice(0, projection.display.limit)
  const dates = new Set(visibleRows.flatMap((row) => (row.timestamp === null ? [] : [row.timestamp.slice(0, 10)])))
  const includeDate = dates.size > 1
  const rows: QueueTimelineTableRow[] = visibleRows.map((row) => ({
    ...row,
    clock: timelineClock(row, includeDate),
    identity: `${row.run === undefined ? "" : `${row.run}·`}${row.prs.join(",")}`,
    transit: `${timelineMetric(row.ageMs)}/${timelineMetric(row.tookMs)}`,
  }))
  const { metrics } = projection
  const statusFilter = projection.filters.statuses.join(",")
  const filterSummary = [
    statusFilter === TIMELINE_STATUS_ORDER.join(",") ? undefined : `status=${statusFilter}`,
    projection.filters.latest ? "latest" : undefined,
    projection.filters.terms.length === 0 ? undefined : `match=${projection.filters.terms.join("|")}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ")
  const columns = [
    {
      header: "TIME",
      key: "clock" as const,
      width: includeDate ? 19 : 8,
      render: (row: QueueTimelineTableRow) => timelineCell(row, row.clock),
    },
    { header: "STATUS", key: "status" as const, width: 22, render: timelineStatusCell },
    {
      header: "RUN·PR",
      key: "identity" as const,
      minWidth: 10,
      maxWidth: 24,
      render: (row: QueueTimelineTableRow) => timelineCell(row, row.identity),
    },
    {
      header: "SUBJECT",
      key: "subject" as const,
      minWidth: 8,
      grow: true,
      render: (row: QueueTimelineTableRow) => timelineCell(row, row.subject),
    },
    {
      header: "DETAIL",
      key: "detail" as const,
      minWidth: 8,
      grow: true,
      render: timelineDetailCell,
    },
    {
      header: "AGE/TOOK",
      key: "transit" as const,
      width: 17,
      align: "right" as const,
      render: (row: QueueTimelineTableRow) => timelineCell(row, row.transit),
    },
  ]
  const table =
    rows.length === 0 ? (
      <Text color="$fg-muted">No timeline rows match this snapshot.</Text>
    ) : interactive ? (
      <Table
        interactive
        active={active}
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        {...(cursorId === undefined || cursorId === null ? {} : { cursorId })}
        height={rows.length}
        follow="end"
        anchorKey={`${projection.base}:${projection.filters.windowMs}:${statusFilter}:${projection.filters.terms.join("|")}:${projection.filters.latest}`}
        onActivate={onActivate}
        onCursorIdChange={onCursorIdChange}
      />
    ) : (
      <Table data={rows} columns={columns} />
    )
  return (
    <Box flexDirection="column">
      <Box height={1}>
        <Text wrap="truncate">
          <Text bold>QUEUE</Text> {projection.base}
          {projection.siblingBases.length === 0 ? "" : ` siblings=${projection.siblingBases.join(",")}`} since=
          {projection.filters.since}
          {` updated=${projection.now.slice(11, 19)} oldest-open=${timelineMetric(projection.oldestOpenMs)}`}
          {filterSummary === "" ? "" : ` ${filterSummary}`}
        </Text>
      </Box>
      {projection.pause === undefined ? null : (
        <Box height={1}>
          <Text color="$fg-warning" wrap="truncate">
            <Text bold>PAUSED</Text> {projection.pause.reason} allowed=
            {projection.pause.allowedPRs.length === 0 ? "none" : projection.pause.allowedPRs.join(",")}
          </Text>
        </Box>
      )}
      <Box height={1}>
        <Text wrap="truncate">
          <Text bold>FLOW</Text> terminal={metrics.terminalAttempts} integrated={metrics.outcomes.integrated} rejected=
          {metrics.outcomes.rejected} decision=
          {metrics.decisionRejection.rate === null ? "-" : `${(metrics.decisionRejection.rate * 100).toFixed(1)}%`}{" "}
          environment=
          {metrics.outcomes.environmentRefused} canceled={metrics.outcomes.canceled}
        </Text>
      </Box>
      <Box height={1}>
        <Text wrap="truncate">{timelineDistribution("ACTIVE ALL", metrics.activeRun.allTerminal)}</Text>
      </Box>
      <Box height={1}>
        <Text wrap="truncate">{timelineDistribution("ACTIVE INTEGRATED", metrics.activeRun.integratedOnly)}</Text>
      </Box>
      <Box height={1}>
        <Text wrap="truncate">
          WAIT n={metrics.queueWait.n} avg={timelineMetric(metrics.queueWait.avgMs)} p50=
          {timelineMetric(metrics.queueWait.p50Ms)} p90={timelineMetric(metrics.queueWait.p90Ms)} max=
          {timelineMetric(metrics.queueWait.maxMs)}
        </Text>
      </Box>
      {!projection.coverage.complete && projection.coverage.retainedSince !== undefined ? (
        <Box height={1}>
          <Text color="$fg-warning" wrap="truncate">
            Window incomplete: retained since {projection.coverage.retainedSince}
          </Text>
        </Box>
      ) : null}
      {table}
      {projection.display.hidden === 0 ? null : (
        <Box height={1}>
          <Text color="$fg-muted">... {projection.display.hidden} more</Text>
        </Box>
      )}
    </Box>
  )
}

export function QueueWatchView({ results, now }: { results: readonly QueueStatusResult[]; now: number }) {
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

export function queueLogRows(
  results: readonly QueueSummary[],
  selectedPrs: ReadonlySet<string>,
  prFilter: string | undefined,
  prStatus?: ReadonlyMap<string, PR["status"]>,
  attempts: readonly QueueLogAttempt[] = [],
  revisionSubjects: ReadonlyMap<string, string> = new Map(),
  submissionTimes: ReadonlyMap<string, string> = new Map(),
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
        const submittedAt = submissionTimes.get(queueRevisionKey(pr))
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
      const exampleResult = Array.from(results)
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

function queueShowStepRow(run: QueueRun, step: QueueStep): QueueShowRow {
  const location = artifactLocation(step)
  const locations = stepLocations(step)
  const stepDurationMs =
    step.job === undefined || !("finishedAt" in step.job)
      ? undefined
      : elapsedMs(step.job.startedAt, step.job.finishedAt)
  return {
    step: step.name,
    revision: step.revision,
    status: jobStatus(step),
    attempt: step.job === undefined ? "-" : String(step.job.attempt),
    uuid: step.job?.id ?? "-",
    requested: step.job === undefined ? "-" : toIso(step.job.requestedAt),
    started: step.job === undefined ? "-" : step.job.status === "requested" ? "-" : toIso(step.job.startedAt),
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
    integration: run.status === "passed" ? queueOutcomeIntegration(run) : undefined,
    parent: run.parent ?? "-",
    isolationPart: isolationPartLabel(run),
    prs: run.prs,
    attempts: runAttempts,
    steps:
      runAttempts.length === 0
        ? run.steps.map((step) => queueShowStepRow(run, step))
        : runAttempts.map((attempt) => queueShowAttemptRow(run, attempt)),
  }
}

export function QueueLogView(props: {
  rows: readonly QueueLogRow[]
  coverage?: QueueLogCoverage
  columns?: number
  disclosure?: string
}) {
  const { rows, columns = 120, disclosure } = props
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
  return (
    <Box flexDirection="column">
      {disclosure === undefined ? null : (
        <Box height={1}>
          <Text color="$fg-muted" wrap="truncate">
            {disclosure}
          </Text>
        </Box>
      )}
      {rows.length === 0 ? (
        <Text color="$fg-muted">No matching terminal log rows.</Text>
      ) : (
        <Table data={tableRows} columns={logColumns} padding={1} showHeader={false} />
      )}
      {hidden === 0 ? null : (
        <Box height={1}>
          <Text color="$fg-muted">... {hidden} more</Text>
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

export function PRRunsView({ runs }: { runs: readonly QueueShowData[] }) {
  if (runs.length === 0) return <Text color="$fg-muted">No runs recorded.</Text>
  return (
    <Box flexDirection="column">
      {runs.map((run, index) => (
        <Box key={run.run} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
          <QueueShowView data={run} />
        </Box>
      ))}
    </Box>
  )
}
