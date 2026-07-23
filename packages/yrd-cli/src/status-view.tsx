import { pathToFileURL } from "node:url"
import type { Bay, PR, PRRegression } from "@yrd/bay"
import type { Contest, ContestEvaluationRun } from "@yrd/contest"
import type { JobError } from "@yrd/job"
import type { PREligibility } from "@yrd/queue"
import { Box, Link, Table, Text, type TableColumn } from "silvery"
import {
  actionableFailure,
  actionableFailureSummary,
  formatActionableFailure,
  type ActionableFailure,
} from "./actionable-error.ts"
import { formatDuration } from "./runner-timeline.ts"
import { projectPRTaskStatus, type StatusGlyph, type TaskStatus, type TaskStatusFields } from "./task-status.ts"

type EvaluationRow = Readonly<{
  attempt: string
  state: string
  evaluator: string
  generation: string
  verdict: string
  summary: string
  failure?: ActionableFailure
  evidenceLabel: string
  evidenceHref?: string
}>

// formatDuration is the pure watch-timeline duration format, shared with the
// headless resident runner via runner-timeline.ts (which imports no silvery).
// Re-exported so existing `./status-view.tsx` consumers are unaffected.
export { formatDuration }

export function statusVariant(status: string): "default" | "accent" | "error" | "warning" | "success" | "info" {
  if (["active", "closed", "integrated", "passed", "passing", "promoted"].includes(status)) return "success"
  if (["rejected", "failed", "lost", "promotion-failed"].includes(status)) return "error"
  if (status === "waiting" || status === "needs-author") return "warning"
  if (["checking", "running", "evaluating", "promoting"].includes(status)) return "info"
  if (["submitted", "ready", "selected", "queued"].includes(status)) return "accent"
  return "default"
}

export function StatusValue({ value, href }: { value: string; href?: string }) {
  const variant = statusVariant(value)
  if (href !== undefined) {
    return (
      <Link
        href={href}
        bold
        color={variant === "default" ? undefined : `$fg-${variant}`}
        minWidth={0}
        maxWidth="100%"
        wrap="truncate"
      >
        {value}
      </Link>
    )
  }
  return (
    <Text
      bold
      color={variant === "default" ? undefined : `$fg-${variant}`}
      minWidth={0}
      maxWidth="100%"
      wrap="truncate"
    >
      {value}
    </Text>
  )
}

export function taskStatusColor(taskStatus: TaskStatus): string {
  if (taskStatus === "todo" || taskStatus === "wip" || taskStatus === "blocked") return "$fg-warning"
  if (taskStatus === "done") return "$fg-success"
  if (taskStatus === "dropped") return "$fg-muted"
  return "$fg"
}

export function TaskStatusGlyph({ taskStatus, glyph }: TaskStatusFields) {
  return (
    <Text color={taskStatusColor(taskStatus)} bold={taskStatus === "wip"}>
      {glyph}
    </Text>
  )
}

export function TaskStatusValue({
  taskStatus,
  glyph,
  value,
  href,
  compact = false,
}: TaskStatusFields & Readonly<{ value: string; href?: string; compact?: boolean }>) {
  const color = taskStatusColor(taskStatus)
  const label = `${glyph}${compact ? "" : " "}${value}`
  if (href !== undefined) {
    return (
      <Link href={href} bold color={color} minWidth={0} maxWidth="100%" wrap="truncate">
        {label}
      </Link>
    )
  }
  return (
    <Text bold color={color} minWidth={0} maxWidth="100%" wrap="truncate">
      {label}
    </Text>
  )
}

function evaluatorVerdict(run: ContestEvaluationRun | undefined): string {
  if (run?.result !== undefined) return run.result.verdict
  const status = run?.job.status
  return status === undefined || status === "requested" ? "queued" : status
}

function evaluatorSummary(run: ContestEvaluationRun | undefined): string {
  if (run?.result?.summary !== undefined) return run.result.summary
  const job = run?.job
  if (job?.status === "failed") return actionableFailureSummary(actionableFailure(job.error))
  if (job?.status === "lost") {
    return actionableFailureSummary(actionableFailure({ code: "job-lost", message: job.lostReason }))
  }
  if (job !== undefined && "detail" in job && job.detail !== undefined) return job.detail
  return "-"
}

function evaluatorFailure(run: ContestEvaluationRun | undefined): ActionableFailure | undefined {
  const job = run?.job
  if (job?.status === "failed") return actionableFailure(job.error)
  if (job?.status === "lost") return actionableFailure({ code: "job-lost", message: job.lostReason })
  return undefined
}

function primaryEvidence(run: ContestEvaluationRun | undefined):
  | Readonly<{
      label: string
      href: string
    }>
  | undefined {
  const artifacts = run?.result?.artifacts ?? []
  const artifact = artifacts.find(({ kind }) => kind === "evaluator-manifest") ?? artifacts[0]
  if (artifact !== undefined) {
    const additional = artifacts.length - 1
    return { label: additional === 0 ? artifact.kind : `${artifact.kind} +${additional}`, href: artifact.uri }
  }
  const job = run?.job
  return job !== undefined && "url" in job && job.url !== undefined ? { label: "job", href: job.url } : undefined
}

function heldOutEvaluationRows(contest: Contest): EvaluationRow[] {
  return contest.attemptOrder.flatMap((id) => {
    const attempt = contest.attempts[id]
    if (attempt === undefined) throw new Error(`yrd: contest '${contest.id}' lost attempt '${id}'`)
    return contest.evaluators
      .filter(({ authority }) => authority === "held-out")
      .flatMap(({ id: evaluator }) => {
        const evaluation = attempt.evaluations[evaluator]
        const runs = evaluation?.runs.length ? evaluation.runs : [undefined]
        return runs.map((run) => {
          const evidence = primaryEvidence(run)
          const failure = evaluatorFailure(run)
          return {
            attempt: id,
            state: attempt.status,
            evaluator,
            generation: run === undefined ? "-" : String(run.generation),
            verdict: evaluatorVerdict(run),
            summary: evaluatorSummary(run),
            ...(failure === undefined ? {} : { failure }),
            evidenceLabel: evidence?.label ?? "-",
            ...(evidence === undefined ? {} : { evidenceHref: evidence.href }),
          }
        })
      })
  })
}

export function BayStatusView({ bays }: { bays: readonly Bay[] }) {
  const columns: TableColumn<Bay>[] = [
    { header: "BAY", key: "id" },
    {
      header: "STATUS",
      key: "status",
      minWidth: 11,
      render: (bay) => <StatusValue value={bay.status} />,
    },
    ...(bays.some((bay) => bay.issue !== undefined)
      ? ([{ header: "ISSUE", key: "issue", grow: true }] satisfies TableColumn<Bay>[])
      : []),
    ...(bays.some((bay) => bay.actor !== undefined)
      ? ([{ header: "ACTOR", key: "actor" }] satisfies TableColumn<Bay>[])
      : []),
    { header: "BRANCH", key: "branch", grow: true },
    { header: "BASE", key: "base" },
    {
      header: "PATH",
      key: "path",
      grow: true,
      render: (bay) =>
        bay.path === undefined ? (
          "-"
        ) : (
          <Link href={pathToFileURL(bay.path).href} minWidth={0} maxWidth="100%" wrap="truncate">
            {bay.path}
          </Link>
        ),
    },
  ]
  return <Table data={bays} columns={columns} />
}

export function PRStatusView({
  prs,
  eligibilities = [],
}: {
  prs: readonly PR[]
  eligibilities?: readonly PREligibility[]
}) {
  const rows = prs.map((pr) => {
    const projected = projectPRTaskStatus(pr)
    const eligibility = eligibilities.find((candidate) => candidate.pr === pr.id)
    return {
      ...projected,
      status: eligibility?.reason?.code === "needs-author" ? "needs-author" : projected.status,
      head: pr.headSha.slice(0, 12),
    }
  })
  return (
    <Table
      data={rows}
      columns={[
        { header: "PR", key: "id" },
        {
          header: "STATUS",
          key: "status",
          minWidth: 15,
          render: (pr) => <TaskStatusValue taskStatus={pr.taskStatus} glyph={pr.glyph} value={pr.status} compact />,
        },
        { header: "BRANCH", key: "branch", grow: true },
        { header: "BASE", key: "base", grow: true },
        { header: "REV", key: "revision", align: "right" },
        { header: "HEAD", key: "head" },
      ]}
      padding={1}
    />
  )
}

export type IssueLensRow = Readonly<{
  issue: string
  taskStatus: TaskStatus
  glyph: StatusGlyph
  bays: string
  prs: string
  contests: string
  outcome: string
}>

export type IssueDeliveryRow = Readonly<{
  pr: string
  revision: number
  headSha: string
  status: PR["status"] | "needs-author"
  runs: readonly string[]
  landingSha?: string
  bounce?: Readonly<{ run: string; detail?: string }>
  attributedReceipt?: JobError
  regressions?: readonly PRRegression[]
}> &
  TaskStatusFields

export function IssueLensView({
  rows,
  deliveries = [],
}: {
  rows: readonly IssueLensRow[]
  deliveries?: readonly IssueDeliveryRow[]
}) {
  if (deliveries.length === 0 || rows[0] === undefined) {
    return (
      <Table
        data={rows}
        columns={[
          { header: "ISSUE", key: "issue", grow: true },
          {
            header: "STATUS",
            key: "taskStatus",
            minWidth: 13,
            render: (row) => <TaskStatusValue taskStatus={row.taskStatus} glyph={row.glyph} value={row.taskStatus} />,
          },
          { header: "BAYS", key: "bays" },
          { header: "PRS", key: "prs" },
          { header: "CONTESTS", key: "contests" },
          { header: "OUTCOME", key: "outcome", grow: true },
        ]}
      />
    )
  }

  const issue = rows[0]
  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        <Text bold>ISSUE</Text> {issue.issue}
      </Text>
      <Text wrap="wrap">
        <TaskStatusValue taskStatus={issue.taskStatus} glyph={issue.glyph} value={issue.taskStatus} /> BAYS {issue.bays}{" "}
        PRS {issue.prs} CONTESTS {issue.contests}
      </Text>
      <Text wrap="wrap">OUTCOME {issue.outcome}</Text>
      <Text bold>DELIVERIES</Text>
      {deliveries.map((delivery) => (
        <IssueDeliveryView key={`${delivery.pr}:${delivery.revision}:${delivery.headSha}`} delivery={delivery} />
      ))}
    </Box>
  )
}

function IssueDeliveryView({ delivery }: { delivery: IssueDeliveryRow }) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text wrap="wrap">
        <TaskStatusValue
          taskStatus={delivery.taskStatus}
          glyph={delivery.glyph}
          value={`${delivery.pr} rev${delivery.revision} ${delivery.status}`}
        />{" "}
        RUNS {delivery.runs.join(",") || "-"}
      </Text>
      <Text wrap="wrap">HEAD {delivery.headSha}</Text>
      {delivery.landingSha === undefined ? null : <Text wrap="wrap">LANDING {delivery.landingSha}</Text>}
      {delivery.bounce === undefined ? null : (
        <Text wrap="wrap" color="$fg-error">
          BOUNCE {delivery.bounce.run}
          {delivery.bounce.detail === undefined ? "" : ` ${delivery.bounce.detail}`}
        </Text>
      )}
      {delivery.attributedReceipt === undefined ? null : (
        <Text wrap="wrap" color="$fg-warning">
          <Text bold>ATTRIBUTED</Text> {delivery.attributedReceipt.code} — {delivery.attributedReceipt.message}
        </Text>
      )}
      {delivery.regressions?.map((regression) => (
        <IssueRegressionView
          key={`${regression.pr}:${regression.run}:${regression.repairPr}:${regression.repairRun}`}
          regression={regression}
        />
      ))}
    </Box>
  )
}

function IssueRegressionView({ regression }: { regression: PRRegression }) {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color="$fg-warning">
        <Text bold>REGRESSION {regression.severity}</Text> DETECTED {regression.detectedAt} RECORDED{" "}
        {regression.recordedAt}
      </Text>
      <Text wrap="wrap">
        ORIGINAL {regression.issueRef} {regression.pr} {regression.run} LANDING {regression.landingSha}
      </Text>
      <Text wrap="wrap">EVIDENCE {regression.evidence}</Text>
      <Text wrap="wrap">IMPLEMENTATION {regression.implementationRunRef}</Text>
      <Text wrap="wrap">REVIEW {regression.reviewRef}</Text>
      <Text wrap="wrap">
        REPAIR {regression.repairIssueRef} {regression.repairPr} {regression.repairRun} LANDING{" "}
        {regression.repairLandingSha}
      </Text>
    </Box>
  )
}

export function ContestStatusView({ contest }: { contest: Contest }) {
  const attempts = contest.attemptOrder.map((id) => {
    const attempt = contest.attempts[id]
    if (attempt === undefined) throw new Error(`yrd: contest '${contest.id}' lost attempt '${id}'`)
    const tokens = attempt.tokens
      ? Object.values(attempt.tokens).reduce<number>((total, value) => total + (value ?? 0), 0)
      : undefined
    const artifact = attempt.artifacts[0]
    return {
      id,
      model: attempt.competitor.model,
      harness: attempt.competitor.harness,
      status: attempt.status,
      time: attempt.wallTimeMs === undefined ? "-" : formatDuration(attempt.wallTimeMs),
      tokens: tokens === undefined ? "-" : String(tokens),
      cost: attempt.cost?.kind === "reported" ? `$${attempt.cost.usd.toFixed(4)}` : "-",
      artifactCount: attempt.artifacts.length,
      artifact: artifact?.uri,
      pin: attempt.pin?.commit.slice(0, 12) ?? "-",
    }
  })
  const evaluations = heldOutEvaluationRows(contest)
  return (
    <Box flexDirection="column">
      <Table
        data={[
          {
            id: contest.id,
            status: contest.status,
            issue: contest.issue.title,
            base: contest.base,
            winner: contest.selection?.attempt ?? "-",
          },
        ]}
        columns={[
          { header: "CONTEST", key: "id" },
          {
            header: "STATE",
            key: "status",
            minWidth: 10,
            render: (row) => <StatusValue value={row.status} />,
          },
          { header: "ISSUE", key: "issue", grow: true },
          { header: "BASE", key: "base" },
          { header: "WINNER", key: "winner" },
        ]}
      />
      <Box marginTop={1}>
        <Table
          data={attempts}
          padding={1}
          columns={[
            { header: "ATTEMPT", key: "id", minWidth: 8 },
            { header: "AGENT", key: "model", grow: true },
            { header: "HARNESS", key: "harness" },
            {
              header: "STATE",
              key: "status",
              minWidth: 10,
              render: (row) => <StatusValue value={row.status} />,
            },
            { header: "TIME", key: "time", align: "right" },
            { header: "TOKENS", key: "tokens", align: "right" },
            { header: "COST", key: "cost", align: "right" },
            {
              header: "ART",
              key: "artifactCount",
              render: (row) =>
                row.artifact === undefined ? (
                  String(row.artifactCount)
                ) : (
                  <Link href={row.artifact}>{String(row.artifactCount)}</Link>
                ),
            },
            { header: "PIN", key: "pin" },
          ]}
        />
      </Box>
      {evaluations.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Table
            data={evaluations}
            padding={1}
            columns={[
              { header: "ATTEMPT", key: "attempt", minWidth: 8 },
              {
                header: "STATE",
                key: "state",
                minWidth: 10,
                render: (row) => <StatusValue value={row.state} />,
              },
              { header: "EVALUATOR", key: "evaluator" },
              { header: "GEN", key: "generation", align: "right" },
              {
                header: "VERDICT",
                key: "verdict",
                minWidth: 8,
                render: (row) => <StatusValue value={row.verdict} />,
              },
              { header: "SUMMARY", key: "summary", grow: true },
              {
                header: "EVIDENCE",
                key: "evidenceLabel",
                render: (row) =>
                  row.evidenceHref === undefined ? (
                    row.evidenceLabel
                  ) : (
                    <Link href={row.evidenceHref} minWidth={0} maxWidth="100%" wrap="truncate">
                      {row.evidenceLabel}
                    </Link>
                  ),
              },
            ]}
          />
          {evaluations.flatMap((evaluation, index) =>
            evaluation.failure === undefined
              ? []
              : [
                  <Text key={`${evaluation.attempt}:${evaluation.evaluator}:${index}`} wrap="wrap">
                    {formatActionableFailure(evaluation.failure)}
                  </Text>,
                ],
          )}
        </Box>
      )}
    </Box>
  )
}
