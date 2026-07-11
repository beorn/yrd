import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { BaysState, PR } from "@yrd/bay"
import type { LineRun, LineStep, LineSummary } from "@yrd/line"
import { Box, Link, Table, Text, type TableColumn } from "silvery"
import { formatDuration, PRStatusView, StatusValue } from "./status-view.tsx"

export type LineStatusResult = LineSummary & { headSha?: string; prs: PR[] }

type JobLike = Readonly<{
  status?: string
  executor?: string
  url?: string
  requestedAt?: string
  changedAt?: string
  startedAt?: string
  finishedAt?: string
  attempt?: number
  output?: unknown
  artifacts?: readonly unknown[]
  error?: { code?: string }
  lostReason?: string
  detail?: string
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

function jobStatus(step: LineStep): string {
  return step.job?.status ?? "queued"
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

function stepArtifacts(step: LineStep | undefined): readonly unknown[] {
  const job = step?.job as JobLike | undefined
  if (job === undefined) return []
  if (job.artifacts !== undefined) return job.artifacts
  const output = job.output
  if (typeof output !== "object" || output === null || !("artifacts" in output)) return []
  return Array.isArray(output.artifacts) ? output.artifacts : []
}

function artifactHref(artifact: unknown): string | undefined {
  if (typeof artifact !== "object" || artifact === null) return undefined
  const value = "uri" in artifact ? artifact.uri : "path" in artifact ? artifact.path : undefined
  if (typeof value !== "string" || value === "") return undefined
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) ? value : pathToFileURL(resolve(value)).href
}

function lineState(pr: PR, run: LineRun | undefined): string {
  if (run?.status === "running") return "checking"
  if (run?.status === "waiting") return "waiting"
  return pr.status
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

function runArchive(run: LineRun): string | undefined {
  const artifact = run.steps
    .flatMap((step) => {
      const job = step.job as JobLike | undefined
      return job?.artifacts ?? stepArtifacts(step)
    })
    .find((item): item is { path?: string; uri?: string } => {
      if (typeof item !== "object" || item === null) return false
      if ("path" in item && typeof item.path === "string") return true
      const uri = "uri" in item && typeof item.uri === "string" ? item.uri : undefined
      return uri !== undefined && (uri.startsWith("file://") || uri.startsWith("/"))
    })
  if (artifact === undefined) return undefined
  if (artifact.path !== undefined) return pathToFileURL(resolve(dirname(artifact.path), "..", "..")).href
  const artifactPath = artifact.uri
  if (artifactPath === undefined) return undefined
  if (artifactPath.startsWith("file://")) return pathToFileURL(fileURLToPath(artifactPath)).href
  if (artifactPath.startsWith("/")) return pathToFileURL(artifactPath).href
  return undefined
}

function logLineLink(value?: string): string {
  return value === undefined ? "-" : value
}

export type LineLogRow = Readonly<{
  base: string
  run: string
  status: string
  prs: string
  startedAt: string
  finishedAt: string
  parent: string
  part: string
  log: string
  archive: string
}>

export function lineLogRows(results: readonly LineSummary[]): LineLogRow[] {
  const finished = results
    .flatMap((summary) => summary.finished)
    .toSorted((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
  return finished.map((run) => {
    const latest = run.steps.at(-1)?.job as JobLike | undefined
    const started = run.steps.find((step) => step.job !== undefined)?.job
    const log = run.steps.find((step) => (step.job as JobLike | undefined)?.url !== undefined)?.job
    const logValue = (log as JobLike | undefined)?.url
    const finishedAt =
      latest?.status === "passed" || latest?.status === "failed"
        ? ((latest as JobLike).finishedAt ?? "")
        : undefined
    const archive = runArchive(run)
    return {
      base: run.base,
      run: run.id,
      status: run.status,
      prs: run.prs.map((pr) => pr.id).join(","),
      startedAt:
        started === undefined
          ? "-"
          : new Date((started as JobLike).requestedAt ?? "").toISOString().replace(/\.\d{3}Z$/u, "Z"),
      finishedAt:
        finishedAt === undefined ? "-" : new Date(finishedAt).toISOString().replace(/\.\d{3}Z$/u, "Z"),
      parent: logLineLink(run.parent),
      part: run.isolationPart === undefined ? "-" : String(run.isolationPart),
      log: logValue === undefined ? "-" : logValue,
      archive: archive === undefined ? "-" : archive,
    }
  })
}

export function LineLogView({ results }: { results: readonly LineSummary[] }) {
  const rows = lineLogRows(results)
  if (rows.length === 0) return <Text color="$fg-muted">No finished runs.</Text>

  return (
    <Table
      data={rows}
      columns={[
        { header: "BASE", key: "base" },
        { header: "RUN", key: "run", minWidth: 5 },
        {
          header: "STATUS",
          key: "status",
          render: (row) => <StatusValue value={row.status} />,
        },
        { header: "PRS", key: "prs", grow: true },
        { header: "STARTED", key: "startedAt" },
        { header: "FINISHED", key: "finishedAt" },
        { header: "PARENT", key: "parent" },
        { header: "PART", key: "part" },
        {
          header: "LOG",
          key: "log",
          render: (row) => (row.log === "-" ? "-" : <Link href={row.log}>{"open"}</Link>),
        },
        {
          header: "ARCHIVE",
          key: "archive",
          render: (row) => (row.archive === "-" ? "-" : <Link href={row.archive}>open</Link>),
        },
      ]}
    />
  )
}

type LineShowRelation = Readonly<{
  role: string
  run: string
  part: string
}>

function showRelations(base: readonly LineSummary[], run: LineRun): LineShowRelation[] {
  const byId = new Map<string, LineRun>(base.flatMap((summary) => summary.finished).map((candidate) => [candidate.id, candidate]))
  const ancestors: LineShowRelation[] = []
  let parent = run.parent
  while (parent !== undefined) {
    const current = byId.get(parent)
    if (current === undefined) break
    ancestors.push({ role: "parent", run: current.id, part: current.isolationPart === undefined ? "-" : String(current.isolationPart) })
    parent = current.parent
  }
  const children = base
    .flatMap((summary) => summary.finished)
    .filter((candidate) => candidate.parent === run.id)
    .map((candidate) => ({
      role: `child`,
      run: candidate.id,
      part: candidate.isolationPart === undefined ? "-" : String(candidate.isolationPart),
    }))
  return [...ancestors.toReversed(), ...children]
}

export function LineShowView({ run, base }: { run: LineRun; base: readonly LineSummary[] }) {
  const archive = runArchive(run)
  const relations = showRelations(base, run)
  const jobRows = run.steps.map((step, index) => {
    const job = step.job as JobLike | undefined
    return {
      step: `${index + 1}:${step.name}`,
      status: job?.status ?? "queued",
      attempt: job?.attempt ?? "-",
      executor: job?.executor ?? "-",
      url: job?.url,
      started: job?.startedAt,
      finished: job?.finishedAt,
      output: job?.output,
    }
  })
  return (
    <Box flexDirection="column">
      <Table
        data={[
          {
            run: run.id,
            base: run.base,
            status: run.status,
            prs: run.prs.map((pr) => pr.id).join(","),
            started: run.steps.find((step) => step.job !== undefined)?.job?.requestedAt ?? "-",
            finished: run.finishedAt ?? "-",
            parent: run.parent ?? "-",
            part: run.isolationPart === undefined ? "-" : String(run.isolationPart),
          },
        ]}
        columns={[
          { header: "RUN", key: "run" },
          { header: "BASE", key: "base" },
          {
            header: "STATUS",
            key: "status",
            render: (row) => <StatusValue value={row.status} />,
          },
          { header: "PRS", key: "prs", grow: true },
          { header: "STARTED", key: "started" },
          { header: "FINISHED", key: "finished" },
          { header: "PARENT", key: "parent" },
          { header: "PART", key: "part" },
        ]}
      />
      <Box marginTop={1}>
        <Table
          data={jobRows}
          columns={[
            { header: "STEP", key: "step" },
            { header: "STATUS", key: "status" },
            { header: "ATTEMPT", key: "attempt", align: "right" },
            { header: "EXECUTOR", key: "executor" },
            { header: "STARTED", key: "started" },
            { header: "FINISHED", key: "finished" },
            {
              header: "LOG",
              key: "url",
              render: (row) => (row.url === undefined ? "-" : <Link href={row.url}>open</Link>),
            },
          ]}
        />
      </Box>
      {relations.length > 0 && (
        <Box marginTop={1}>
          <Text>
            {relations.map((relation) => `${relation.role} ${relation.run}#${relation.part}`).join(" ")}
          </Text>
        </Box>
      )}
      {archive !== undefined ? <Box marginTop={1}>ARCHIVE <Link href={archive}>open</Link></Box> : null}
    </Box>
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

function lineRows(state: BaysState, result: LineStatusResult, selected: ReadonlySet<string>, now: number): Row[] {
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
          const itemJob = item.job as JobLike | undefined
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
        const rows = lineRows(state, result, selected, now)
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
                <Text color="$fg-muted">No open PRs.</Text>
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
