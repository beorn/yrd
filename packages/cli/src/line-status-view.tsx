import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BaysState, Submission } from "@yrd/bay"
import type { LineRun, LineSummary, StepEvidence } from "@yrd/line"
import { Box, Link, Table, Text, type TableColumn } from "silvery"
import { formatDuration, StatusValue, SubmissionStatusView } from "./status-view.tsx"

export type LineStatusResult = LineSummary & { submissions: Submission[] }

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
    .sort()
    .at(-1)
}

function latestRun(submission: Submission, summary: LineSummary): LineRun | undefined {
  return [...summary.running, ...summary.waiting, ...summary.finished]
    .filter((run) => run.submissions.some((member) => member.id === submission.id))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .at(-1)
}

function relevantStep(run: LineRun | undefined): StepEvidence | undefined {
  if (run === undefined) return undefined
  return (
    [...run.steps].reverse().find((step) => step.status === "failed") ??
    [...run.steps].reverse().find((step) => ["requested", "running", "waiting", "lost"].includes(step.status)) ??
    [...run.steps].reverse().find((step) => step.status !== "queued")
  )
}

function stepArtifacts(step: StepEvidence | undefined): readonly unknown[] {
  if (step?.artifacts !== undefined) return step.artifacts
  const output = step?.output
  if (typeof output !== "object" || output === null || !("artifacts" in output)) return []
  return Array.isArray(output.artifacts) ? output.artifacts : []
}

function artifactHref(artifact: unknown): string | undefined {
  if (typeof artifact !== "object" || artifact === null) return undefined
  const value = "uri" in artifact ? artifact.uri : "path" in artifact ? artifact.path : undefined
  if (typeof value !== "string" || value === "") return undefined
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) ? value : pathToFileURL(resolve(value)).href
}

function lineState(submission: Submission, run: LineRun | undefined): string {
  if (run?.status === "running") return "checking"
  if (run?.status === "waiting") return "waiting"
  return submission.status
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
    prs: run.submissions.map((submission) => submission.id).join(","),
    state: run.status,
    steps: run.steps.map((step) => `${step.name}=${step.status}`).join(" "),
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

export function SubmissionResultView({
  submissions,
  runs,
}: {
  submissions: readonly Submission[]
  runs: readonly LineRun[]
}) {
  return (
    <Box flexDirection="column">
      <SubmissionStatusView submissions={submissions} />
      {runs.length > 0 && (
        <Box marginTop={1}>
          <LineRunsView runs={runs} />
        </Box>
      )}
    </Box>
  )
}

function lineRows(state: BaysState, result: LineStatusResult, selected: ReadonlySet<string>, now: number): Row[] {
  return result.submissions
    .filter(
      (submission) =>
        selected.has(submission.id) || (submission.status !== "integrated" && submission.status !== "withdrawn"),
    )
    .map((submission) => {
      const run = latestRun(submission, result)
      const step = relevantStep(run)
      const path = submission.bay === undefined ? undefined : state.bays[submission.bay]?.path
      const revision = submission.revisions.at(-1)
      const touched = latest(
        revision?.pushedAt,
        submission.submittedAt,
        submission.rejectedAt,
        submission.integratedAt,
        submission.withdrawnAt,
        run?.startedAt,
        run?.finishedAt,
        ...(run?.steps ?? []).flatMap((item) => [item.startedAt, item.finishedAt]),
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
        pr: submission.id,
        ...(path === undefined ? {} : { prHref: pathToFileURL(path).href, path }),
        state: lineState(submission, run),
        target: submission.base,
        age: age(submission.submittedAt ?? revision?.pushedAt, now),
        touched: age(touched, now),
        run: duration,
        step: step?.name ?? "-",
        result: step?.error?.code ?? step?.detail ?? step?.status ?? "-",
        ...(step?.url === undefined ? {} : { log: step.url }),
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
      render: (row) => (row.prHref === undefined ? row.pr : <CellLink href={row.prHref}>{row.pr}</CellLink>),
    },
    {
      header: "STATE",
      key: "state",
      minWidth: 8,
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
        const all = Object.values(state.submissions).filter((submission) => submission.base === result.base)
        const rows = lineRows(state, result, selected, now)
        const baseSha = all.find((submission) => submission.baseSha !== undefined)?.baseSha
        const summary = [
          {
            line: `${result.base}${baseSha === undefined ? "" : `@${baseSha.slice(0, 12)}`}`,
            open: all.filter((submission) => !["integrated", "withdrawn"].includes(submission.status)).length,
            active: all.filter((submission) =>
              ["checking", "waiting"].includes(lineState(submission, latestRun(submission, result))),
            ).length,
            integrated: all.filter((submission) => submission.status === "integrated").length,
            rejected: all.filter((submission) => submission.status === "rejected").length,
          },
        ]
        return (
          <Box key={result.base} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
            <Table
              data={summary}
              columns={[
                { header: "LINE", key: "line", grow: true },
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
