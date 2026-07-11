import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BaysState, PR } from "@yrd/bay"
import type { Job } from "@yrd/job"
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
  started: string
  finished: string
  duration: string
  retries: string
  landing: string
  result: string
  error: string
  location?: {
    path: string
    url: string
  }
}>

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
  requested: string
  started: string
  finished: string
  duration: string
  error: string
  lost: string
  detail: string
  output: string
  artifacts: string
  evidence: string
  checkpoint: string
  landing: string
}>

type LineShowData = Readonly<{
  run: string
  base: string
  status: string
  outcome: string
  started: string
  finished: string
  duration: string
  retries: number
  landing: string
  steps: readonly LineShowRow[]
}>

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

function jobOutput(job: Job | undefined): unknown | undefined {
  if (job === undefined) return undefined
  if (job.status !== "passed" && job.status !== "failed") return undefined
  return job.output
}

function jobCheckpoint(job: Job | undefined): unknown | undefined {
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

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stepArtifacts(step: LineStep | undefined): readonly unknown[] {
  if (step?.job === undefined) return []
  if ("artifacts" in step.job && step.job.artifacts !== undefined) return step.job.artifacts
  const output = jobOutput(step.job)
  if (!isObjectValue(output) || !("artifacts" in output)) return []
  return Array.isArray(output.artifacts) ? output.artifacts : []
}

function artifactHref(artifact: unknown): string | undefined {
  if (!isObjectValue(artifact)) return undefined
  const value = "uri" in artifact ? artifact.uri : "path" in artifact ? artifact.path : undefined
  if (typeof value !== "string" || value === "") return undefined
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) ? value : pathToFileURL(resolve(value)).href
}

function artifactLocation(artifact: unknown): { path: string; url: string } | undefined {
  if (!isObjectValue(artifact) || typeof artifact.path !== "string" || artifact.path === "") return undefined
  const path = resolve(artifact.path)
  return { path, url: pathToFileURL(path).href }
}

function toIso(timestamp: string | undefined): string {
  if (timestamp === undefined) return "-"
  const when = new Date(timestamp)
  return Number.isNaN(when.getTime()) ? "-" : when.toISOString()
}

function duration(started: string | undefined, finished: string | undefined): string {
  if (started === undefined || finished === undefined) return "-"
  const start = Date.parse(started)
  const end = Date.parse(finished)
  return Number.isFinite(start) && Number.isFinite(end) ? formatDuration(end - start) : "-"
}

function jobRetries(step: LineStep): number {
  return step.job === undefined ? 0 : Math.max(0, step.job.attempt - 1)
}

function totalRetries(steps: readonly LineStep[]): number {
  return steps.reduce((total, step) => total + jobRetries(step), 0)
}

function runOutcome(run: LineRun, prStatusById?: ReadonlyMap<string, PR["status"]>): string {
  if (run.status === "passed") return "integrated"
  if (run.status === "failed") return "rejected"
  if (
    prStatusById !== undefined &&
    run.prs.length > 0 &&
    run.prs.every((pr) => prStatusById.get(pr.id) === "withdrawn")
  ) {
    return "retired"
  }
  if (run.prs.length === 0) return run.status
  return run.status
}

function landingProof(run: LineRun): string {
  const proof = run.integration ?? ("integration" in run.shape ? run.shape.integration : undefined)
  if (proof === undefined) return "-"
  return `${proof.commit.slice(0, 12)}@${proof.baseSha.slice(0, 12)}`
}

function firstLocation(run: LineRun, pathByPr: ReadonlyMap<string, string>): { path?: string; url?: string } {
  for (const step of run.steps) {
    if (step.job === undefined) continue
    const output = jobOutput(step.job)
    if (isObjectValue(output) && Array.isArray(output.artifacts)) {
      for (const item of output.artifacts) {
        const found = artifactLocation(item)
        if (found !== undefined) return found
      }
    }
    const checkpoint = jobCheckpoint(step.job)
    if (isObjectValue(checkpoint) && isObjectValue(checkpoint.artifacts) && Array.isArray(checkpoint.artifacts)) {
      for (const item of checkpoint.artifacts) {
        const found = artifactLocation(item)
        if (found !== undefined) return found
      }
    }
  }
  for (const pr of run.prs) {
    const path = pathByPr.get(pr.id)
    if (path !== undefined) return { path, url: pathToFileURL(path).href }
  }
  return {}
}

function lineState(pr: PR, run: LineRun | undefined): string {
  if (run?.status === "running") return "checking"
  if (run?.status === "waiting") return "waiting"
  return pr.status
}

function safeText(value: unknown): string {
  if (value === undefined) return "-"
  if (typeof value === "string") return value === "" ? "-" : value
  return JSON.stringify(value)
}

function stepEvidence(step: LineStep): string {
  const job = step.job
  if (job === undefined) return "-"
  const parts: string[] = []
  if ("url" in job && typeof job.url === "string") parts.push(`url=${job.url}`)
  if ("token" in job && typeof job.token === "string") parts.push(`token=${job.token}`)
  if ("checkpoint" in job && isObjectValue(job.checkpoint)) parts.push("checkpoint")
  return parts.length === 0 ? "-" : parts.join(" ")
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

function stepError(step: LineStep): string {
  const job = step.job
  if (job === undefined) return "-"
  if (job.status === "failed") return (job as JobByStatus<"failed">).error.message
  return "-"
}

function stepLost(step: LineStep): string {
  const job = step.job
  if (job?.status !== "lost") return "-"
  return job.lostReason
}

function stepDetail(step: LineStep): string {
  const job = step.job
  if (job === undefined) return "-"
  const detail = job.status === "waiting" || job.status === "passed" || job.status === "failed" ? job.detail : undefined
  if (typeof detail === "string" && detail !== "") return detail
  if (job.status === "failed") return (job as JobByStatus<"failed">).error.message
  return "-"
}

function stepOutput(step: LineStep): string {
  const job = step.job
  if (job === undefined) return "-"
  if (job.status === "failed") return safeText((job as JobByStatus<"failed">).error)
  if (job.status === "passed") return safeText((job as JobByStatus<"passed">).output)
  if (job.status === "waiting" || job.status === "running") {
    const detail = job.status === "waiting" && typeof job.detail === "string" ? job.detail : undefined
    return detail === undefined ? "waiting" : detail
  }
  return "-"
}

function stepDuration(step: LineStep): string {
  const job = step.job
  if (job === undefined) return "-"
  if (job.status === "requested") return "-"
  if (job.status === "running") return job.startedAt === undefined || job.changedAt === undefined ? "-" : duration(job.startedAt, job.changedAt)
  if (job.status === "waiting") return job.startedAt === undefined || job.changedAt === undefined ? "-" : duration(job.startedAt, job.changedAt)
  if (job.status === "passed" || job.status === "failed") return duration(job.startedAt, job.finishedAt)
  return "-"
}

function CellLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} minWidth={0} maxWidth="100%" wrap="truncate">
      {children}
    </Link>
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

export function lineStatusRows(state: BaysState, result: LineStatusResult, selected: ReadonlySet<string>, now: number): Row[] {
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
          (job !== undefined && "error" in job ? job.error.code : undefined) ??
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
        return (
          <Box key={result.base} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
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
  pathByPr: ReadonlyMap<string, string>,
  prStatus?: ReadonlyMap<string, PR["status"]>,
): LineLogRow[] {
  const rows: LineLogRow[] = []
  for (const result of results) {
    for (const run of result.finished) {
      for (const pr of run.prs) {
        if (selectedPrs.size > 0 && !selectedPrs.has(pr.id)) continue
        if (prFilter !== undefined && pr.id !== prFilter) continue
        const outcome = runOutcome(run, prStatus)
        if (outcome === "running" || outcome === "waiting") continue
        const runError =
          run.error?.message ??
          run.steps
            .toReversed()
            .map((step) => step.job)
            .find((job) => job !== undefined && job.status === "failed")?.error?.message ??
          "-"
        const location = firstLocation(run, pathByPr)
        rows.push({
          run: run.id,
          base: run.base,
          pr: pr.id,
          revision: String(pr.revision),
          headSha: pr.headSha,
          baseSha: pr.baseSha ?? "-",
          outcome,
          started: toIso(run.startedAt),
          finished: run.finishedAt === undefined ? "-" : toIso(run.finishedAt),
          duration: duration(run.startedAt, run.finishedAt),
          retries: String(totalRetries(run.steps)),
          landing: landingProof(run),
          result: safeText(run.prs.length > 0 ? run.prs : ["-"]),
          error: safeText(runError),
          ...(location.path === undefined || location.url === undefined
            ? {}
            : { location: { path: location.path, url: location.url } }),
        })
      }
    }
  }
  return rows.toSorted((left, right) => {
    const leftAt = Date.parse(left.finished)
    const rightAt = Date.parse(right.finished)
    if (Number.isNaN(leftAt) && Number.isNaN(rightAt)) return left.run.localeCompare(right.run)
    if (Number.isNaN(leftAt)) return 1
    if (Number.isNaN(rightAt)) return -1
    return rightAt - leftAt
  })
}

export function lineShowData(run: LineRun): LineShowData {
  const prStatus = new Map<string, PR["status"]>(run.prs.map((pr) => [pr.id, "pushed"]))
  return {
    run: run.id,
    base: run.base,
    status: run.status,
    outcome: runOutcome(run, prStatus),
    started: toIso(run.startedAt),
    finished: run.finishedAt === undefined ? "-" : toIso(run.finishedAt),
    duration: run.finishedAt === undefined ? "-" : duration(run.startedAt, run.finishedAt),
    retries: totalRetries(run.steps),
    landing: landingProof(run),
    steps: run.steps.map((step) => ({
      step: step.name,
      revision: step.revision,
      status: jobStatus(step),
      attempt: step.job === undefined ? "-" : String(step.job.attempt),
      requested: step.job === undefined ? "-" : toIso(step.job.requestedAt),
      started: step.job === undefined ? "-" : (step.job.status === "requested" ? "-" : toIso(step.job.changedAt)),
      finished: step.job === undefined || step.job.status === "running" || step.job.status === "requested"
        ? "-"
        : toIso((step.job as { finishedAt?: string } | undefined)?.finishedAt),
      duration: step.job === undefined ? "-" : stepDuration(step),
      error: stepError(step),
      lost: stepLost(step),
      detail: stepDetail(step),
      output: stepOutput(step),
      artifacts: stepArtifactsText(step),
      evidence: stepEvidence(step),
      checkpoint: stepCheckpointText(step),
      landing: landingProof(run),
    })),
  }
}

export function LineLogView({ rows }: { rows: readonly LineLogRow[] }) {
  return (
    <Box flexDirection="column">
      {rows.length === 0 ? (
        <Text color="$fg-muted">No matching terminal log rows.</Text>
      ) : (
        <Table
          data={rows}
          columns={[
            { header: "RUN", key: "run", minWidth: 5, maxWidth: 8 },
            { header: "PR", key: "pr", minWidth: 4 },
            { header: "OUTCOME", key: "outcome", minWidth: 9 },
            { header: "REV", key: "revision", align: "right" },
            { header: "BASE SHA", key: "baseSha", minWidth: 12 },
            { header: "HEAD", key: "headSha", minWidth: 12, maxWidth: 14 },
            { header: "START", key: "started", grow: true },
            { header: "END", key: "finished", grow: true },
            { header: "DUR", key: "duration", align: "right" },
            { header: "RETRY", key: "retries", align: "right" },
            {
              header: "BASE",
              key: "base",
              render: (row) =>
                row.location === undefined ? row.base : <CellLink href={row.location.url}>{`${row.base}`}</CellLink>,
            },
            { header: "RESULT", key: "error", grow: true },
            {
              header: "PATH",
              key: "location",
              render: (row) =>
                row.location === undefined ? "-" : <CellLink href={row.location.url}>{row.location.path}</CellLink>,
            },
            { header: "INTEGRATION", key: "landing", grow: true },
          ]}
          padding={1}
        />
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
          { header: "END", key:  "finished", grow: true },
          { header: "DUR", key: "duration", align: "right" },
          { header: "RETRY", key: "retries", align: "right" },
          { header: "INTEGRATION", key: "landing", grow: true },
        ]}
        padding={1}
      />
      <Box marginTop={1}>
        <Table
          data={data.steps}
          columns={[
            { header: "STEP", key: "step", minWidth: 8 },
            { header: "REV", key: "revision", minWidth: 8 },
            {
              header: "STATUS",
              key: "status",
              minWidth: 8,
              render: (row) => <StatusValue value={row.status} />,
            },
            { header: "ATT", key: "attempt", align: "right" },
            { header: "REQ", key: "requested" },
            { header: "START", key: "started", grow: true },
            { header: "END", key: "finished", grow: true },
            { header: "DUR", key: "duration", align: "right", minWidth: 8 },
            { header: "ERROR", key: "error", grow: true },
            { header: "LOST", key: "lost", grow: true },
            { header: "DETAIL", key: "detail", grow: true },
            { header: "OUTPUT", key: "output", grow: true, minWidth: 10 },
            { header: "ART", key: "artifacts", grow: true },
            { header: "EVIDENCE", key: "evidence", minWidth: 10, grow: false },
            { header: "CHECKPOINT", key: "checkpoint", minWidth: 10, grow: false },
            { header: "LANDING", key: "landing", minWidth: 10, grow: false },
          ]}
          padding={1}
        />
      </Box>
    </Box>
  )
}
