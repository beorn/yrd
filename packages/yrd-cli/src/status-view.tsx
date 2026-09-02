import { homedir } from "node:os"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import { changeHead, changeRevisionNumber, type Bay, type Change, type ChangeDeliveryState } from "@yrd/bay"
import type { Contest, ContestEvaluationRun } from "@yrd/contest"
import type { JobErrorFact } from "@yrd/job"
import { projectedChangeStatus, type ChangeEligibility } from "@yrd/queue"
import { Box, Link, Table, Text, type TableColumn } from "silvery"
import {
  actionableFailure,
  actionableFailureSummary,
  formatActionableFailure,
  type ActionableFailure,
} from "./actionable-error.ts"
import { formatDuration } from "./runner-timeline.ts"
import { changeStateColor, changeStateGlyph, changeStateLabel, deriveChangeState } from "./derived-change-state.ts"
import { hasStatusPresentation, lifecyclePresentation, statusPresentation } from "./status-presentation.ts"
import { projectChangeTaskStatus, taskStatusGlyph, type TaskStatus, type TaskStatusFields } from "./task-status.ts"

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
// headless habitant runner via runner-timeline.ts (which imports no silvery).
// Re-exported so existing `./status-view.tsx` consumers are unaffected.
export { formatDuration }

type StatusVariant = "default" | "accent" | "error" | "warning" | "success" | "info" | "muted"

export function statusVariant(status: string): StatusVariant {
  if (hasStatusPresentation(status)) {
    return statusPresentation(status).color.slice("$fg-".length) as Exclude<StatusVariant, "default">
  }
  if (["passing", "promoted", "safe"].includes(status)) return "success"
  if (["promotion-failed", "blocked"].includes(status)) return "error"
  if (status === "waiting" || status === "needs-author" || status === "unknown") return "warning"
  if (["evaluating", "promoting"].includes(status)) return "info"
  if (status === "selected") return "accent"
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

/** Glyphs are presentation, derived here at render from the stored
 * `taskStatus` (5e cut 4). `glyph` stays as an optional override for the few
 * cells with a status the work vocabulary cannot spell (non-landing "\u25cc"). */
export function TaskStatusGlyph({ taskStatus, glyph }: TaskStatusFields & Readonly<{ glyph?: string }>) {
  return (
    <Text color={taskStatusColor(taskStatus)} bold={taskStatus === "wip"}>
      {glyph ?? taskStatusGlyph(taskStatus)}
    </Text>
  )
}

export function TaskStatusValue({
  taskStatus,
  glyph,
  value,
  href,
  compact = false,
}: TaskStatusFields & Readonly<{ glyph?: string; value: string; href?: string; compact?: boolean }>) {
  const color = taskStatusColor(taskStatus)
  const label = `${glyph ?? taskStatusGlyph(taskStatus)}${compact ? "" : " "}${value}`
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
  const job = run?.job
  if (job === undefined || job.status === "queued") return "queued"
  if (job.status === "in_progress") return "running"
  return job.status === "completed" ? job.conclusion : job.status
}

function evaluatorSummary(run: ContestEvaluationRun | undefined): string {
  if (run?.result?.summary !== undefined) return run.result.summary
  const job = run?.job
  if (job?.status === "completed" && job.conclusion === "failure") {
    return actionableFailureSummary(actionableFailure(job.error))
  }
  if (job?.status === "completed" && job.conclusion === "timed_out") {
    return actionableFailureSummary(actionableFailure({ code: "job-lost", message: job.lostReason }))
  }
  if (job !== undefined && "detail" in job && job.detail !== undefined) return job.detail
  return "-"
}

function evaluatorFailure(run: ContestEvaluationRun | undefined): ActionableFailure | undefined {
  const job = run?.job
  if (job?.status === "completed" && job.conclusion === "failure") return actionableFailure(job.error)
  if (job?.status === "completed" && job.conclusion === "timed_out") {
    return actionableFailure({ code: "job-lost", message: job.lostReason })
  }
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

type BayStatusRow = Readonly<{
  bay: string
  status: string
  safety: string
  issue: string
  by: string
  base: string
  branch: string
}>

function friendlyPath(path: string): string {
  const home = process.env["HOME"] ?? homedir()
  if (path === home) return "~"
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

function bayRoot(bays: readonly Bay[]): string | undefined {
  const roots = new Set(bays.flatMap((bay) => (bay.path === undefined ? [] : [dirname(bay.path)])))
  return roots.size === 1 ? roots.values().next().value : undefined
}

function LifecycleStatusValue({ value }: { value: string }) {
  return (
    <Text bold color={lifecyclePresentation(value).color} minWidth={0} maxWidth="100%" wrap="truncate">
      {value}
    </Text>
  )
}

export function BayStatusView({
  bays,
  safety,
  statuses,
}: {
  bays: readonly Bay[]
  safety?: ReadonlyMap<string, "safe" | "blocked" | "unknown">
  statuses?: ReadonlyMap<string, string>
}) {
  const rows: BayStatusRow[] = bays.map((bay) => ({
    bay: bay.id,
    status: statuses?.get(bay.id) ?? bay.status,
    safety: safety?.get(bay.id) ?? "-",
    issue: bay.issue ?? "-",
    by: bay.by ?? "-",
    base: bay.base,
    branch: bay.branch,
  }))
  const columns: TableColumn<BayStatusRow>[] = [
    { header: "BAY", key: "bay" },
    {
      header: "STATUS",
      key: "status",
      minWidth: 7,
      render: (bay) => <LifecycleStatusValue value={bay.status} />,
    },
    { header: "ISSUE", key: "issue", grow: true },
    { header: "BY", key: "by" },
    { header: "BASE", key: "base" },
    { header: "BRANCH", key: "branch", grow: true },
  ]
  if (safety !== undefined) {
    columns.splice(2, 0, {
      header: "SAFETY",
      key: "safety",
      minWidth: 7,
      render: (bay) => <StatusValue value={bay.safety} />,
    })
  }
  const root = bayRoot(bays)
  return (
    <Box flexDirection="column" width="100%">
      {root === undefined ? (
        <Text>Bays</Text>
      ) : (
        <Text>
          Bays in <Link href={pathToFileURL(root).href}>{friendlyPath(root)}/</Link>
        </Text>
      )}
      <Box marginTop={1} width="100%">
        <Table data={rows} columns={columns} />
      </Box>
    </Box>
  )
}

export function ChangeStatusView({
  prs,
  eligibilities,
  columns,
}: {
  prs: readonly Change[]
  eligibilities?: readonly ChangeEligibility[]
  /** Terminal width, when the caller knows it — narrow tables drop WHY the
   * same way ChangeListView drops BY/AGE below its width thresholds. */
  columns?: number
}) {
  const rows = prs.map((pr) => {
    const revision = changeRevisionNumber(pr)
    const eligibility = eligibilities?.find((candidate) => candidate.pr === pr.id && candidate.revision === revision)
    const reading = deriveChangeState(pr, {
      ...(eligibility?.reason === undefined ? {} : { reason: { code: eligibility.reason.code } }),
    })
    return {
      ...projectChangeTaskStatus(pr),
      // The one display-state derivation (change-state.ts): the five words a
      // change is in, so this surface stops printing `submitted` both for a
      // change the queue could not carry and for one a check judged.
      state: reading.state,
      stateLabel: `${changeStateGlyph(reading.state)} ${changeStateLabel(reading)}`,
      // The word this column printed before the five states, unshown, so
      // nothing that reads a row loses it during the flag-day cycle.
      delivery: projectedChangeStatus(pr, eligibility),
      revision,
      head: changeHead(pr).slice(0, 12),
      why: eligibility?.reason?.message ?? "",
    }
  })
  // The WHY column exists only when a row carries a reason (so eligibility-less
  // renders and every runnable result stay byte-identical to the old table),
  // and only when the table is wide enough that it cannot starve BRANCH/BASE.
  const why = rows.some((row) => row.why !== "") && (columns === undefined || columns >= 100)
  return (
    <Table
      data={rows}
      columns={[
        { header: "PR", key: "id" },
        {
          header: "STATE",
          key: "stateLabel",
          minWidth: 15,
          maxWidth: 28,
          render: (pr) => (
            <Text bold color={changeStateColor(pr.state)} minWidth={0} maxWidth="100%" wrap="truncate">
              {pr.stateLabel}
            </Text>
          ),
        },
        { header: "BRANCH", key: "branch", grow: true },
        { header: "BASE", key: "base", grow: true },
        { header: "REV", key: "revision", align: "right" },
        { header: "HEAD", key: "head" },
        // The reason the change cannot proceed, in the author's language — the
        // eligibility message every JSON envelope already carried while no
        // human surface showed it (22895's unshipped half). Capped so it can
        // never starve BRANCH/BASE at narrow widths; the full message stays in
        // `pr view` and every JSON envelope.
        ...(why ? [{ header: "WHY", key: "why" as const, grow: true, maxWidth: 56 }] : []),
      ]}
      padding={1}
    />
  )
}

export type IssueLensRow = Readonly<{
  issue: string
  taskStatus: TaskStatus
  bays: string
  prs: string
  contests: string
  outcome: string
}>

export type IssueDeliveryRow = Readonly<{
  pr: string
  revision: number
  headSha: string
  status: ChangeDeliveryState | "needs-author"
  runs: readonly string[]
  landingSha?: string
  baseSha?: string
  candidateSha?: string
  candidateTreeSha?: string
  baseTreeSha?: string
  bounce?: Readonly<{ run: string; detail?: string }>
  attributedResult?: JobErrorFact
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
            render: (row) => <TaskStatusValue taskStatus={row.taskStatus} value={row.taskStatus} />,
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
        <TaskStatusValue taskStatus={issue.taskStatus} value={issue.taskStatus} /> BAYS {issue.bays} PRS {issue.prs}{" "}
        CONTESTS {issue.contests}
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
          value={`${delivery.pr} rev${delivery.revision} ${delivery.status}`}
        />{" "}
        RUNS {delivery.runs.join(",") || "-"}
      </Text>
      <Text wrap="wrap">HEAD {delivery.headSha}</Text>
      {delivery.landingSha === undefined ? null : <Text wrap="wrap">MERGE {delivery.landingSha}</Text>}
      {delivery.candidateSha === undefined ? null : (
        <Text wrap="wrap">
          ALREADY MERGED {delivery.candidateSha} TREE {delivery.candidateTreeSha} = BASE {delivery.baseSha} TREE{" "}
          {delivery.baseTreeSha}
        </Text>
      )}
      {delivery.bounce === undefined ? null : (
        <Text wrap="wrap" color="$fg-error">
          BOUNCE {delivery.bounce.run}
          {delivery.bounce.detail === undefined ? "" : ` ${delivery.bounce.detail}`}
        </Text>
      )}
      {delivery.attributedResult === undefined ? null : (
        <Text wrap="wrap" color="$fg-warning">
          <Text bold>ATTRIBUTED</Text> {delivery.attributedResult.code} — {delivery.attributedResult.message}
        </Text>
      )}
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
      competitor: attempt.competitor.id,
      runner: attempt.competitor.runner,
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
            { header: "COMPETITOR", key: "competitor", grow: true },
            { header: "RUNNER", key: "runner" },
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
