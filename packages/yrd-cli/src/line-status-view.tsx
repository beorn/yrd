import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BaysState, PR } from "@yrd/bay"
import type { Job } from "@yrd/job"
import type { LineRun, LineStep, LineSummary } from "@yrd/line"
import { Box, Link, Table, Text, type TableColumn } from "silvery"
import { formatDuration, PRStatusView, StatusValue } from "./status-view.tsx"

export type LineStatusResult = LineSummary & { headSha?: string; prs: PR[] }

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

function jobStatus(step: LineStep): Job["status"] | "queued" {
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
  if (step?.job === undefined) return []
  if ("artifacts" in step.job && step.job.artifacts !== undefined) return step.job.artifacts
  const output = "output" in step.job ? step.job.output : undefined
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
