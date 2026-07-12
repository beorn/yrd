import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BaysState, PR } from "@yrd/bay"
import type { Event, JsonValue } from "@yrd/core"
import { JobRequestSchema, JobTransitionSchema, type Job } from "@yrd/job"
import type { LineRun, LineStep, LineSummary } from "@yrd/line"
import { Box, Link, Table, Text, type TableColumn } from "silvery"
import { formatDuration, PRStatusView, StatusValue } from "./status-view.tsx"

export type LineStatusResult = LineSummary & { headSha?: string; prs: PR[] }

export type LineLogRow = Readonly<{
  run: string
  base: string
  pr: string
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
  attempts: readonly LineLogAttempt[]
  activeSteps: readonly Readonly<{ step: string; duration: string; durationMs: number }>[]
  retries: string
  parent: string
  isolationPart: "0" | "1" | "-"
  result: string
  error: string
  location?: LineLogLocation
  locations: readonly LineLogLocationEntry[]
  integration?: {
    commit: string
    baseSha: string
  }
  landing: string
}>

export type LineLogAttempt = Readonly<{
  job: string
  run: string
  step: string
  index: number
  attempt: number
  executor: string
  outcome: "passed" | "failed" | "lost"
  startedAt: string
  finishedAt: string
  durationMs: number
}>

type LineAttemptResult =
  | Readonly<{ status: "passed"; output: JsonValue }>
  | Readonly<{ status: "failed"; error: Readonly<{ code: string; message: string }>; output?: JsonValue }>
  | Readonly<{ status: "lost"; reason: string }>

export type LineAttempt = LineLogAttempt &
  Readonly<{
    requestedAt: string
    revision: string
    result: LineAttemptResult
  }>

type RequestedJob = Readonly<{ run: string; step: string; index: number; requestedAt: string; revision: string }>
type StartedAttempt = Readonly<{ attempt: number; executor: string; startedAt: string }>

export async function lineLogAttempts(events: AsyncIterable<Event> | Iterable<Event>): Promise<LineAttempt[]> {
  const requested = new Map<string, RequestedJob>()
  const started = new Map<string, StartedAttempt>()
  const attempts: LineAttempt[] = []

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
        executor: transition.executor,
        startedAt: event.ts,
      })
      continue
    }
    if (transition.type !== "finish" && transition.type !== "lose") continue

    const request = requested.get(transition.id)
    const start = started.get(`${transition.id}:${transition.attempt}`)
    if (request === undefined || start === undefined) continue
    attempts.push({
      job: transition.id,
      ...request,
      attempt: transition.attempt,
      executor: start.executor,
      outcome: transition.type === "lose" ? "lost" : transition.result.status === "passed" ? "passed" : "failed",
      startedAt: start.startedAt,
      finishedAt: event.ts,
      durationMs: Date.parse(event.ts) - Date.parse(start.startedAt),
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

type LineShowRow = Readonly<{
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
  location?: LineLogLocation
  locations: readonly LineLogLocationEntry[]
}>

type LineShowData = Readonly<{
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
  prs: LineRun["prs"]
  attempts: readonly LineAttempt[]
  steps: readonly LineShowRow[]
}>

type LegacyLineCoverage = Readonly<{
  path: string
  frames: number
}>

export type LineLogCoverage = Readonly<{
  since: string
  completeness: "queue-only"
  legacy: LegacyLineCoverage
}>

type LineLogLocation = Readonly<{ path: string }> | Readonly<{ url: string }>
type LineLogLocationEntry = Readonly<{ label: string; location: LineLogLocation }>

function age(timestamp: string | undefined, now: number): string {
  if (timestamp === undefined) return "-"
  const time = Date.parse(timestamp)
  return Number.isFinite(time) ? formatDuration(now - time) : "-"
}

function latest(...timestamps: (string | undefined)[]): string | undefined {
  return timestamps
    .filter((value): value is string => value !== undefined)
    .toSorted()
    .at(-1)
}

function latestRun(pr: PR, summary: LineSummary): LineRun | undefined {
  return [...summary.running, ...summary.waiting, ...summary.finished]
    .filter((run) => run.prs.some((member) => member.id === pr.id))
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt))
    .at(-1)
}

type JobByStatus<Status extends Job["status"]> = Extract<Job, { status: Status }>

function jobStatus(step: LineStep): Job["status"] | "queued" {
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

function singleLine(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim()
  return normalized === "" ? "-" : normalized
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

function elapsedMs(started: string | undefined, finished: string | undefined): number | undefined {
  if (started === undefined || finished === undefined) return undefined
  const start = Date.parse(started)
  const end = Date.parse(finished)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined
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

function compactTimestamp(timestamp: string, compact: boolean): string {
  if (timestamp === "-") return timestamp
  const iso = new Date(timestamp).toISOString()
  return compact
    ? `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`
    : `${iso.slice(0, 16)}Z`
}

function runDurations(
  run: LineRun,
  attempts: readonly LineLogAttempt[],
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

function byRunStarted(left: LineRun, right: LineRun): number {
  const leftAt = Date.parse(left.startedAt)
  const rightAt = Date.parse(right.startedAt)
  if (leftAt !== rightAt) return leftAt - rightAt
  return parseRunIdSuffix(left.id) - parseRunIdSuffix(right.id)
}

function isLocalArtifact(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false
  return !/^[a-z][a-z0-9+.-]*:/iu.test(value)
}

function artifactPath(artifact: unknown): LineLogLocation | undefined {
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

function artifactLocation(step: LineStep | undefined): LineLogLocation | undefined {
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

function stepLocations(step: LineStep | undefined): LineLogLocationEntry[] {
  if (step?.job === undefined) return []
  const locations: LineLogLocationEntry[] = []
  const seen = new Set<string>()
  const add = (label: string, location: LineLogLocation): void => {
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

function attemptArtifacts(attempt: LineAttempt): readonly unknown[] {
  if (attempt.result.status === "lost" || !isObjectValue(attempt.result.output)) return []
  return Array.isArray(attempt.result.output.artifacts) ? attempt.result.output.artifacts : []
}

function attemptLocations(attempt: LineAttempt): LineLogLocationEntry[] {
  return attemptArtifacts(attempt).flatMap((artifact) => {
    const location = artifactPath(artifact)
    return location === undefined ? [] : [{ label: artifactLabel(artifact), location }]
  })
}

function runLocations(run: LineRun): LineLogLocationEntry[] {
  const locations = run.steps.flatMap((step) => stepLocations(step))
  return [...new Map(locations.map((entry) => [JSON.stringify(entry.location), entry])).values()]
}

function runLocation(run: LineRun): LineLogLocation | undefined {
  return run.steps.toReversed().flatMap(stepLocations).at(0)?.location
}

function jobCheckpoint(job: Job | undefined): unknown {
  if (job === undefined) return undefined
  if (job.status === "waiting" || job.status === "passed" || job.status === "failed") return job.checkpoint
  return undefined
}

function relevantStep(run: LineRun | undefined): LineStep | undefined {
  if (run === undefined) return undefined
  const latestFirst = run.steps.toReversed()
  return (
    latestFirst.find((step) => jobStatus(step) === "failed") ??
    latestFirst.find((step) => ["requested", "running", "waiting", "lost"].includes(jobStatus(step))) ??
    latestFirst.find((step) => jobStatus(step) !== "queued")
  )
}

function runOutputLineageIndex(finished: readonly LineRun[], run: LineRun, revision: number, prId: string): number {
  const related = finished
    .filter((candidate) => candidate.prs.some((pr) => pr.id === prId && pr.revision === revision))
    .toSorted(byRunStarted)
  return related.findIndex((candidate) => candidate.id === run.id) + 1
}

function stepArtifacts(step: LineStep | undefined): readonly unknown[] {
  if (step?.job === undefined) return []
  const artifacts: unknown[] = []
  if ("artifacts" in step.job && Array.isArray(step.job.artifacts)) artifacts.push(...step.job.artifacts)
  if ((step.job.status === "passed" || step.job.status === "failed") && isObjectValue(step.job.output)) {
    if (Array.isArray(step.job.output.artifacts)) artifacts.push(...step.job.output.artifacts)
  }
  const checkpoint = jobCheckpoint(step.job)
  if (isObjectValue(checkpoint) && Array.isArray(checkpoint.artifacts)) artifacts.push(...checkpoint.artifacts)
  return [...new Map(artifacts.map((artifact) => [JSON.stringify(artifact), artifact])).values()]
}

function artifactHref(artifact: unknown): string | undefined {
  const location = artifactPath(artifact)
  if (location === undefined) return undefined
  return "path" in location ? pathToFileURL(location.path).href : location.url
}

function stepOutput(step: LineStep): string {
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

function lineOutcome(run: LineRun): string {
  if (run.status === "passed") return "integrated"
  if (run.status === "failed") return "rejected"
  return run.status
}

function lineIntegration(run: LineRun): { commit: string; baseSha: string } | undefined {
  return run.integration ?? ("integration" in run.shape ? run.shape.integration : undefined)
}

function lineLanding(run: LineRun): string {
  const proof = lineIntegration(run)
  if (proof === undefined) return "-"
  return `${proof.commit.slice(0, 12)}@${proof.baseSha.slice(0, 12)}`
}

function lineOutcomeIntegration(run: LineRun): { commit: string; baseSha: string } {
  const proof = lineIntegration(run)
  if (proof === undefined) throw new Error(`yrd: passed run '${run.id}' is missing integration proof`)
  return proof
}

function isolationPartLabel(run: LineRun): "0" | "1" | "-" {
  return run.isolationPart === undefined ? "-" : run.isolationPart === 0 ? "0" : "1"
}

function lineShowRetries(finished: readonly LineRun[], run: LineRun): number {
  if (run.prs.length === 0) return 0
  const first = run.prs[0]
  if (first === undefined) return 0
  return runOutputLineageIndex(finished, run, first.revision, first.id)
}

function lineState(pr: PR, run: LineRun | undefined): string {
  if (run?.status === "running") return "checking"
  if (run?.status === "waiting") return "waiting"
  return pr.status
}

function stepError(step: LineStep): string {
  const job = step.job
  if (job === undefined) return "-"
  if (job.status === "failed") return (job as JobByStatus<"failed">).error.message
  return "-"
}

function stepErrorCode(step: LineStep): string {
  const job = step.job
  return job?.status === "failed" ? (job as JobByStatus<"failed">).error.code : "-"
}

function stepLost(step: LineStep): string {
  const job = step.job
  if (job?.status !== "lost") return "-"
  return job.lostReason
}

function stepDetail(step: LineStep): string {
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

function stepDuration(step: LineStep): string {
  const job = step.job
  if (job === undefined) return "-"
  if (job.status === "requested" || job.status === "running" || job.status === "waiting") return "-"
  if (job.status === "passed" || job.status === "failed" || job.status === "lost") {
    return duration(job.startedAt, (job as { finishedAt?: string }).finishedAt)
  }
  return "-"
}

function stepArtifactsText(step: LineStep): string {
  const artifacts = stepArtifacts(step)
  if (artifacts.length === 0) return "-"
  const first = artifacts[0]
  if (isObjectValue(first) && typeof first.name === "string") return first.name
  return String(artifacts.length)
}

function stepCheckpointText(step: LineStep): string {
  const checkpoint = jobCheckpoint(step.job)
  if (!isObjectValue(checkpoint)) return "-"
  const value = [] as string[]
  if (typeof checkpoint.baseSha === "string") value.push(`base:${checkpoint.baseSha.slice(0, 12)}`)
  if (typeof checkpoint.candidateSha === "string") value.push(`candidate:${checkpoint.candidateSha.slice(0, 12)}`)
  return value.length === 0 ? safeText(checkpoint) : value.join(" ")
}

function stepEvidence(step: LineStep): string | Record<string, unknown> {
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

function LocationLinks({ entries }: { entries: readonly LineLogLocationEntry[] }) {
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

function LineLogLocationLinks({ entries, compact }: { entries: readonly LineLogLocationEntry[]; compact: boolean }) {
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

export function LineRunsView({ runs }: { runs: readonly LineRun[] }) {
  if (runs.length === 0) return <Text color="$fg-muted">Line idle.</Text>
  const data = runs.map((run) => ({
    run: run.id,
    prs: run.prs.map((pr) => pr.id).join(","),
    state: run.status,
    steps: run.steps.map((step) => `${step.name}=${jobStatus(step)}`).join(" "),
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

export function PRResultView({ prs, runs }: { prs: readonly PR[]; runs: readonly LineRun[] }) {
  return (
    <Box flexDirection="column">
      <PRStatusView prs={prs} />
      {runs.length > 0 && (
        <Box marginTop={1}>
          <LineRunsView runs={runs} />
        </Box>
      )}
    </Box>
  )
}

export function lineStatusRows(
  state: BaysState,
  result: LineStatusResult,
  selected: ReadonlySet<string>,
  now: number,
): Row[] {
  return result.prs
    .filter((pr) => selected.has(pr.id) || (pr.status !== "integrated" && pr.status !== "withdrawn"))
    .map((pr) => {
      const run = latestRun(pr, result)
      const step = relevantStep(run)
      const job = step?.job
      const path = pr.bay === undefined ? undefined : state.byId[pr.bay]?.path
      const revision = pr.revisions.at(-1)
      const touched = latest(
        revision?.pushedAt,
        pr.submittedAt,
        pr.rejectedAt,
        pr.integratedAt,
        pr.withdrawnAt,
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
      const duration =
        run === undefined
          ? "-"
          : formatDuration(
              (run.finishedAt === undefined ? now : Date.parse(run.finishedAt)) - Date.parse(run.startedAt),
            )
      const artifacts = stepArtifacts(step)
      const artifact = artifactHref(artifacts[0])
      return {
        pr: pr.id,
        ...(path === undefined ? {} : { prHref: pathToFileURL(path).href, path }),
        state: lineState(pr, run),
        target: pr.base,
        age: age(pr.submittedAt ?? revision?.pushedAt, now),
        touched: age(touched, now),
        run: duration,
        step: step?.name ?? "-",
        result:
          (job !== undefined && "error" in job ? job.error.message : undefined) ??
          (job !== undefined && "lostReason" in job ? job.lostReason : undefined) ??
          (job !== undefined && "detail" in job ? job.detail : undefined) ??
          (step === undefined ? "-" : jobStatus(step)),
        ...(job !== undefined && "url" in job && job.url !== undefined ? { log: job.url } : {}),
        artifactCount: artifacts.length,
        ...(artifact === undefined ? {} : { artifact }),
      }
    })
}

function detailColumns(): TableColumn<Row>[] {
  return [
    {
      header: "PR",
      key: "pr",
      minWidth: 6,
      render: (row) => (row.prHref === undefined ? row.pr : <CellLink href={row.prHref}>{row.pr}</CellLink>),
    },
    {
      header: "STATE",
      key: "state",
      minWidth: 11,
      render: (row) => <StatusValue value={row.state} href={row.log} />,
    },
    { header: "TARGET", key: "target" },
    { header: "AGE", key: "age" },
    { header: "TOUCHED", key: "touched", minWidth: 8 },
    { header: "RUN", key: "run" },
    { header: "STEP", key: "step" },
    {
      header: "RESULT",
      key: "result",
      grow: true,
      render: (row) => (row.log === undefined ? row.result : <CellLink href={row.log}>{row.result}</CellLink>),
    },
    {
      header: "LOG",
      render: (row) => (row.log === undefined ? "-" : <CellLink href={row.log}>open</CellLink>),
    },
    {
      header: "ART",
      key: "artifactCount",
      render: (row) =>
        row.artifactCount === 0 ? (
          "-"
        ) : row.artifact === undefined ? (
          String(row.artifactCount)
        ) : (
          <CellLink href={row.artifact}>{String(row.artifactCount)}</CellLink>
        ),
    },
    {
      header: "PATH",
      key: "path",
      grow: true,
      render: (row) =>
        row.path === undefined ? "-" : <CellLink href={pathToFileURL(row.path).href}>{row.path}</CellLink>,
    },
  ]
}

export function LineStatusView({
  state,
  results,
  selected,
  now,
}: {
  state: BaysState
  results: readonly LineStatusResult[]
  selected: ReadonlySet<string>
  now: number
}) {
  return (
    <Box flexDirection="column">
      {results.map((result, index) => {
        const all = Object.values(state.prs).filter((pr) => pr.base === result.base)
        const rows = lineStatusRows(state, result, selected, now)
        const summary = [
          {
            line: `${result.base}${result.headSha === undefined ? "" : `@${result.headSha.slice(0, 12)}`}`,
            open: all.filter((pr) => !["integrated", "withdrawn"].includes(pr.status)).length,
            active: all.filter((pr) => ["checking", "waiting"].includes(lineState(pr, latestRun(pr, result)))).length,
            integrated: all.filter((pr) => pr.status === "integrated").length,
            rejected: all.filter((pr) => pr.status === "rejected").length,
          },
        ]
        const allowed = result.hold?.allowedPRs.length === 0 ? "none" : result.hold?.allowedPRs.join(", ")
        return (
          <Box key={result.base} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
            {result.hold !== undefined && (
              <Box marginBottom={1}>
                <Text>
                  <Text color="$fg-warning" bold>
                    HOLD
                  </Text>
                  {`: ${result.hold.reason} (allowed: ${allowed})`}
                </Text>
              </Box>
            )}
            <Table
              data={summary}
              padding={1}
              columns={[
                { header: "LINE", key: "line", grow: true, minWidth: 6, maxWidth: 24 },
                { header: "OPEN", key: "open", align: "right" },
                { header: "ACTIVE", key: "active", align: "right" },
                { header: "INTEGRATED", key: "integrated", align: "right" },
                { header: "REJECTED", key: "rejected", align: "right" },
              ]}
            />
            {rows.length === 0 ? (
              <Box marginTop={1}>
                <Text color="$fg-muted">No matching PRs.</Text>
              </Box>
            ) : (
              <Box marginTop={1}>
                <Table data={rows} columns={detailColumns()} padding={1} />
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export function lineLogRows(
  results: readonly LineSummary[],
  selectedPrs: ReadonlySet<string>,
  prFilter: string | undefined,
  prStatus?: ReadonlyMap<string, PR["status"]>,
  now = Date.now(),
  attempts: readonly LineLogAttempt[] = [],
): LineLogRow[] {
  const rows: LineLogRow[] = []
  const finished = results.flatMap((result) => result.finished)

  for (const result of results) {
    for (const run of result.finished) {
      for (const pr of run.prs) {
        if (selectedPrs.size > 0 && !selectedPrs.has(pr.id)) continue
        if (prFilter !== undefined && pr.id !== prFilter) continue
        const outcome = lineOutcome(run)
        if (outcome === "running" || outcome === "waiting") continue

        const runError =
          run.error?.message ??
          run.steps
            .toReversed()
            .map((step) => step.job)
            .find((job) => job !== undefined && job.status === "failed")?.error?.message ??
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
            executor,
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
            executor,
            outcome: attemptOutcome,
            startedAt,
            finishedAt,
            durationMs,
          }),
        )
        const durations = runDurations(run, runAttempts)
        const durationMs = durations.totalDurationMs
        const finishedAt = run.finishedAt === undefined ? undefined : toIso(run.finishedAt)
        const ageMs = Math.max(0, now - Date.parse(finishedAt ?? run.startedAt))
        const showLocation = prStatus?.get(pr.id) === "withdrawn" ? undefined : location
        rows.push({
          run: run.id,
          base: run.base,
          pr: pr.id,
          revision: String(pr.revision),
          headSha: pr.headSha,
          baseSha: pr.baseSha ?? "-",
          outcome,
          startedAt: toIso(run.startedAt),
          ...(finishedAt === undefined ? {} : { finishedAt }),
          started: toIso(run.startedAt),
          finished: finishedAt ?? "-",
          age: preciseDuration(ageMs),
          ageMs,
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
          retries: String(Math.max(0, runOutputLineageIndex(finished, run, pr.revision, pr.id))),
          landing: lineLanding(run),
          integration: outcome === "integrated" && run.status === "passed" ? lineOutcomeIntegration(run) : undefined,
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
        { id: left.run, startedAt: left.started, base: left.base } as LineRun,
        { id: right.run, startedAt: right.started, base: right.base } as LineRun,
      )
    }
    if (Number.isNaN(leftAt)) return 1
    if (Number.isNaN(rightAt)) return -1
    if (leftAt !== rightAt) return leftAt - rightAt
    return parseRunIdSuffix(left.run) - parseRunIdSuffix(right.run)
  })
}

function lineShowStepRow(run: LineRun, step: LineStep): LineShowRow {
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
    landing: lineLanding(run),
    locations,
    ...(location === undefined ? {} : { location }),
  }
}

function lineShowAttemptRow(run: LineRun, attempt: LineAttempt): LineShowRow {
  const step = run.steps[attempt.index] ?? run.steps.find((candidate) => candidate.name === attempt.step)
  if (step?.job?.id === attempt.job && step.job.attempt === attempt.attempt) {
    return {
      ...lineShowStepRow(run, step),
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
    landing: lineLanding(run),
    locations,
    ...(firstLocation === undefined ? {} : { location: firstLocation }),
  }
}

export function lineShowData(
  run: LineRun,
  allRuns: readonly LineRun[] = [],
  attempts: readonly LineAttempt[] = [],
): LineShowData {
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
    outcome: lineOutcome(run),
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
    retries: lineShowRetries(finished, run),
    landing: lineLanding(run),
    integration: run.status === "passed" ? lineOutcomeIntegration(run) : undefined,
    parent: run.parent ?? "-",
    isolationPart: isolationPartLabel(run),
    prs: run.prs,
    attempts: runAttempts,
    steps:
      runAttempts.length === 0
        ? run.steps.map((step) => lineShowStepRow(run, step))
        : runAttempts.map((attempt) => lineShowAttemptRow(run, attempt)),
  }
}

export function LineLogView({
  rows,
  coverage,
  columns = 120,
}: {
  rows: readonly LineLogRow[]
  coverage?: LineLogCoverage
  columns?: number
}) {
  const compact = columns <= 80
  return (
    <Box flexDirection="column">
      {coverage !== undefined ? (
        <Text color="$fg-muted">
          Legacy queue coverage: <Link href={pathToFileURL(coverage.legacy.path).href}>{coverage.legacy.path}</Link>{" "}
          (since {coverage.since}; {coverage.legacy.frames} frames)
        </Text>
      ) : null}
      {rows.length === 0 ? (
        <Text color="$fg-muted">No matching terminal log rows.</Text>
      ) : (
        <Box flexDirection="column">
          <Text color="$fg-muted">
            {compact
              ? "RUN/PR@REV/OUTCOME AT(UTC) AGE TOTAL ACTIVE WAIT ART"
              : "RUN/PR@REV/OUTCOME AT(UTC) AGE TOTAL ACTIVE WAIT ARTIFACTS"}
          </Text>
          {rows.map((row) => {
            const identity = `${row.run}/${row.pr}@${row.revision}/${row.outcome}`
            const active = row.activeDurationMs === undefined ? "-" : preciseDuration(row.activeDurationMs, compact)
            return (
              <Box key={`${row.run}:${row.pr}:${row.revision}`} height={1}>
                <Text wrap="truncate">
                  {identity} {compact ? null : `head:${row.headSha.slice(0, 12)} `}
                  {compactTimestamp(row.startedAt, compact)}{" "}
                  {row.ageMs === undefined ? "-" : preciseDuration(row.ageMs, compact)}{" "}
                  {row.totalDurationMs === undefined ? "-" : preciseDuration(row.totalDurationMs, compact)}{" "}
                  {active === "" ? "-" : active}{" "}
                  {row.waitDurationMs === undefined ? "-" : preciseDuration(row.waitDurationMs, compact)}{" "}
                  <LineLogLocationLinks entries={row.locations} compact={compact} />
                </Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

export function LineShowView({ data }: { data: LineShowData }) {
  return (
    <Box flexDirection="column">
      <Table
        data={[data]}
        columns={[
          { header: "RUN", key: "run" },
          { header: "BASE", key: "base" },
          {
            header: "STATUS",
            key: "status",
            minWidth: 11,
            render: (row) => <StatusValue value={row.status} />,
          },
          { header: "OUTCOME", key: "outcome" },
          { header: "START", key: "started", grow: true },
          { header: "END", key: "finished", grow: true },
          { header: "TOTAL", key: "totalDuration", align: "right" },
          { header: "ACTIVE", key: "activeDuration", align: "right" },
          { header: "WAIT", key: "waitDuration", align: "right" },
          { header: "RETRY", key: "retries", align: "right" },
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
              render: (row) => <Text wrap="truncate">{singleLine(row.lost)}</Text>,
            },
            {
              header: "MESSAGE",
              key: "error",
              grow: true,
              render: (row) => <Text wrap="truncate">{singleLine(row.error)}</Text>,
            },
            {
              header: "DETAIL",
              key: "detail",
              grow: true,
              render: (row) => <Text wrap="truncate">{singleLine(row.detail)}</Text>,
            },
            {
              header: "OUTPUT",
              key: "output",
              grow: true,
              minWidth: 10,
              render: (row) => <Text wrap="truncate">{singleLine(row.output)}</Text>,
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
                  {singleLine(typeof row.evidence === "string" ? row.evidence : safeText(row.evidence))}
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
                {`PROOF ${row.step}#${row.attempt} EVIDENCE ${singleLine(
                  typeof row.evidence === "string" ? row.evidence : safeText(row.evidence),
                )} CHECKPOINT ${singleLine(row.checkpoint)}`}
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
