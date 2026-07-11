import { existsSync } from "node:fs"
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
  parent: string
  isolationPart: "0" | "1" | "-"
  result: string
  error: string
  location?: LineLogLocation
  integration?: {
    commit: string
    baseSha: string
  }
  landing: string
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
  uuid: string
  requested: string
  started: string
  finished: string
  duration: string
  error: string
  lost: string
  detail: string
  output: string
  artifacts: string
  evidence: string | Record<string, unknown>
  checkpoint: string
  landing: string
  location?: LineLogLocation
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
  integration?: {
    commit: string
    baseSha: string
  }
  parent: string
  isolationPart: "0" | "1" | "-"
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
  if (step?.job === undefined) return undefined

  if ("artifacts" in step.job && step.job.artifacts !== undefined) {
    for (const item of step.job.artifacts) {
      const location = artifactPath(item)
      if (location !== undefined) return location
    }
  }

  if (step.job.status === "passed" || step.job.status === "failed") {
    const output = step.job.output
    if (isObjectValue(output) && Array.isArray(output.artifacts)) {
      for (const item of output.artifacts) {
        const location = artifactPath(item)
        if (location !== undefined) return location
      }
    }
  }

  const checkpoint = jobCheckpoint(step.job)
  if (isObjectValue(checkpoint) && isObjectValue(checkpoint.artifacts) && Array.isArray(checkpoint.artifacts)) {
    for (const item of checkpoint.artifacts) {
      const location = artifactPath(item)
      if (location !== undefined) return location
    }
  }

  if (typeof (step.job as { url?: unknown }).url === "string") {
    const evidenceUrl = (step.job as { url: string }).url
    if (evidenceUrl !== "") return { url: evidenceUrl }
  }

  return undefined
}

function runLocation(run: LineRun): LineLogLocation | undefined {
  return run.steps
    .toReversed()
    .map((step) => artifactLocation(step))
    .find((location) => location !== undefined)
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

function runOutputLineageIndex(finished: readonly LineRun[], run: LineRun, revision: number, prId: string): number {
  const related = finished
    .filter((candidate) => candidate.prs.some((pr) => pr.id === prId && pr.revision === revision))
    .toSorted(byRunStarted)
  return related.findIndex((candidate) => candidate.id === run.id) + 1
}

function stepArtifacts(step: LineStep | undefined): readonly unknown[] {
  if (step?.job === undefined) return []
  if ("artifacts" in step.job && step.job.artifacts !== undefined) return step.job.artifacts
  if ((step.job.status !== "passed" && step.job.status !== "failed") || !isObjectValue(step.job.output)) return []
  const output = step.job.output
  if (!isObjectValue(output) || !("artifacts" in output)) return []
  return Array.isArray(output.artifacts) ? output.artifacts : []
}

function artifactHref(artifact: unknown): string | undefined {
  const location = artifactPath(artifact)
  if (location === undefined) return undefined
  return "path" in location ? pathToFileURL(location.path).href : location.url
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

function stepLost(step: LineStep): string {
  const job = step.job
  if (job?.status !== "lost") return "-"
  return job.lostReason
}

function stepDetail(step: LineStep): string {
  const job = step.job
  if (job === undefined) return "-"
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
  prStatus?: ReadonlyMap<string, PR["status"]>,
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
        const showLocation = prStatus?.get(pr.id) === "withdrawn" ? undefined : location
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
          retries: String(Math.max(0, runOutputLineageIndex(finished, run, pr.revision, pr.id))),
          landing: lineLanding(run),
          integration: outcome === "integrated" && run.status === "passed" ? lineOutcomeIntegration(run) : undefined,
          parent: run.parent ?? "-",
          isolationPart: isolationPartLabel(run),
          result: safeText(run.prs.length > 0 ? run.prs : ["-"]),
          error: safeText(runError),
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
        started: "-",
        finished: "-",
        duration: "-",
        retries: "0",
        landing: "-",
        parent: "-",
        isolationPart: "-",
        result: "-",
        error: "-",
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

export function lineShowData(run: LineRun, allRuns: readonly LineRun[] = []): LineShowData {
  const finished = allRuns.filter((candidate) => candidate.status === "passed" || candidate.status === "failed")
  return {
    run: run.id,
    base: run.base,
    status: run.status,
    outcome: lineOutcome(run),
    started: toIso(run.startedAt),
    finished: run.finishedAt === undefined ? "-" : toIso(run.finishedAt),
    duration: run.finishedAt === undefined ? "-" : duration(run.startedAt, run.finishedAt),
    retries: lineShowRetries(finished, run),
    landing: lineLanding(run),
    integration: run.status === "passed" ? lineOutcomeIntegration(run) : undefined,
    parent: run.parent ?? "-",
    isolationPart: isolationPartLabel(run),
    steps: run.steps.map((step) => {
      const location = artifactLocation(step)
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
        error: stepError(step),
        lost: stepLost(step),
        detail: stepDetail(step),
        output: stepOutput(step),
        artifacts: stepArtifactsText(step),
        evidence: stepEvidence(step),
        checkpoint: stepCheckpointText(step),
        landing: lineLanding(run),
        ...(location === undefined ? {} : { location }),
      }
    }),
  }
}

export function LineLogView({ rows, coverage }: { rows: readonly LineLogRow[]; coverage?: LineLogCoverage }) {
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
        <Table
          data={rows}
          columns={[
            { header: "RUN", key: "run", minWidth: 5, maxWidth: 8 },
            { header: "PR", key: "pr", minWidth: 4 },
            { header: "OUTCOME", key: "outcome", minWidth: 9 },
            { header: "REV", key: "revision", align: "right" },
            { header: "BASE", key: "base", minWidth: 8 },
            { header: "BASE SHA", key: "baseSha", minWidth: 12 },
            { header: "HEAD", key: "headSha", minWidth: 12, maxWidth: 14 },
            { header: "START", key: "started", grow: true },
            { header: "END", key: "finished", grow: true },
            { header: "DUR", key: "duration", align: "right" },
            { header: "RETRY", key: "retries", align: "right" },
            { header: "PARENT", key: "parent", minWidth: 6 },
            {
              header: "ISO",
              key: "isolationPart",
              minWidth: 4,
              align: "right",
              render: (row) => (row.isolationPart === "-" ? "-" : row.isolationPart),
            },
            { header: "RESULT", key: "error", grow: true },
            {
              header: "PATH",
              key: "location",
              render: (row) =>
                row.location === undefined ? (
                  "-"
                ) : "path" in row.location ? (
                  <CellLink href={pathToFileURL(row.location.path).href}>{row.location.path}</CellLink>
                ) : (
                  <CellLink href={row.location.url}>{row.location.url}</CellLink>
                ),
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
          { header: "END", key: "finished", grow: true },
          { header: "DUR", key: "duration", align: "right" },
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
            {
              header: "PATH",
              key: "location",
              render: (row) =>
                row.location === undefined ? (
                  "-"
                ) : "path" in row.location ? (
                  <CellLink href={pathToFileURL(row.location.path).href}>{row.location.path}</CellLink>
                ) : (
                  <CellLink href={row.location.url}>{row.location.url}</CellLink>
                ),
            },
            {
              header: "EVIDENCE",
              key: "evidence",
              minWidth: 10,
              grow: false,
              render: (row) => (typeof row.evidence === "string" ? row.evidence : safeText(row.evidence)),
            },
            { header: "CHECKPOINT", key: "checkpoint", minWidth: 10, grow: false },
            { header: "LANDING", key: "landing", minWidth: 10, grow: false },
          ]}
          padding={1}
        />
      </Box>
    </Box>
  )
}
