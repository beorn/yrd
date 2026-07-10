import { pathToFileURL } from "node:url"
import type { Bay, Submission } from "@yrd/bay"
import type { Contest } from "@yrd/contest"
import { Badge, Box, Link, Table } from "silvery"

export function formatDuration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds)
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

export function statusVariant(status: string): "default" | "accent" | "error" | "warning" | "success" | "info" {
  if (["active", "closed", "integrated", "passed", "passing", "promoted"].includes(status)) return "success"
  if (["rejected", "failed", "lost", "promotion-failed"].includes(status)) return "error"
  if (status === "waiting") return "warning"
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
        color={variant === "default" ? "$fg" : `$fg-${variant}`}
        minWidth={0}
        maxWidth="100%"
        wrap="truncate"
      >
        {value}
      </Link>
    )
  }
  return <Badge label={value} variant={variant} minWidth={0} maxWidth="100%" wrap="truncate" />
}

export function BayStatusView({ bays }: { bays: readonly Bay[] }) {
  return (
    <Table
      data={bays}
      columns={[
        { header: "BAY", key: "id" },
        {
          header: "STATUS",
          key: "status",
          minWidth: 10,
          render: (bay) => <StatusValue value={bay.status} />,
        },
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
      ]}
    />
  )
}

export function SubmissionStatusView({ submissions }: { submissions: readonly Submission[] }) {
  const rows = submissions.map((submission) => ({
    ...submission,
    head: submission.headSha.slice(0, 12),
  }))
  return (
    <Table
      data={rows}
      columns={[
        { header: "PR", key: "id" },
        {
          header: "STATUS",
          key: "status",
          minWidth: 10,
          render: (submission) => <StatusValue value={submission.status} />,
        },
        { header: "BRANCH", key: "branch", grow: true },
        { header: "BASE", key: "base", grow: true },
        { header: "REV", key: "revision", align: "right" },
        { header: "HEAD", key: "head" },
      ]}
    />
  )
}

export function ContestStatusView({ contest }: { contest: Contest }) {
  const attempts = contest.attemptOrder.map((id) => {
    const attempt = contest.attempts[id]!
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
  return (
    <Box flexDirection="column">
      <Table
        data={[
          {
            id: contest.id,
            status: contest.status,
            task: contest.task.title,
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
          { header: "TASK", key: "task", grow: true },
          { header: "BASE", key: "base" },
          { header: "WINNER", key: "winner" },
        ]}
      />
      <Box marginTop={1}>
        <Table
          data={attempts}
          padding={1}
          columns={[
            { header: "ATTEMPT", key: "id" },
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
    </Box>
  )
}
