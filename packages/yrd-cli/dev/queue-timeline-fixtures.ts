import { currentPRRev, type PR } from "@yrd/bay"
import type { JsonValue } from "@yrd/core"
import type { Job } from "@yrd/job"
import type { Run } from "@yrd/queue"
import {
  queueTimelineAdmissionTimes,
  queueTimelineProjection,
  type QueueAttempt,
  type QueueStatusResult,
  type QueueTimelineProjection,
  type QueueTimelineStatus,
  type QueueTimelineStatusFilter,
} from "../src/queue-status-view.tsx"
import type { QueueArtifactOutput, QueueWatchSnapshot } from "../src/watch-pane.tsx"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
const NEXT_NOW = Date.parse("2026-07-13T12:00:05.000Z")
const NEXT_NOW_ISO = new Date(NEXT_NOW).toISOString()
const BASE_SHA = "a".repeat(40)
const INTEGRATED_SHA = "b".repeat(40)
const ALL_STATUSES: readonly QueueTimelineStatusFilter[] = ["pending", "running", "rejected", "integrated", "other"]

type FixturePrOptions = Readonly<{
  revision?: number
  headSha?: string
  actor?: string
  revisions?: readonly FixtureRevision[]
  reviews?: PR["reviews"]
  comments?: PR["comments"]
  checkRequests?: PR["checkRequests"]
  issue?: string
  note?: string
  detail?: string
  terminalRun?: string
  rejectedAt?: string
  integratedAt?: string
  withdrawnAt?: string
  withdrawReason?: string
  canceledAt?: string
  canceledBy?: string
  cancelReason?: string
  integration?: NonNullable<PR["integration"]>
}>

type FixtureDeliveryState = "pushed" | "submitted" | "rejected" | "integrated" | "withdrawn" | "canceled"
type LegacyFixtureRevision = Readonly<{
  revision: number
  headSha: string
  base: string
  baseSha?: string
  actor?: string
  correlation?: PR["revs"][number]["correlation"]
  composition?: PR["revs"][number]["composition"]
  recut?: PR["revs"][number]["recut"]
  pushedAt: string
  submittedAt?: string
  terminal?: Readonly<{
    status: "rejected" | "integrated" | "withdrawn" | "canceled"
    at: string
    run?: string
  }>
}>
type FixtureRevision = PR["revs"][number] | LegacyFixtureRevision

function fixtureRevision(revision: FixtureRevision): PR["revs"][number] {
  if ("n" in revision) return revision
  return {
    n: revision.revision,
    head: revision.headSha,
    base: revision.base,
    ...(revision.baseSha === undefined ? {} : { baseSha: revision.baseSha }),
    ...(revision.actor === undefined ? {} : { actor: revision.actor }),
    ...(revision.correlation === undefined ? {} : { correlation: revision.correlation }),
    ...(revision.composition === undefined ? {} : { composition: revision.composition }),
    ...(revision.recut === undefined ? {} : { recut: revision.recut }),
    pushedAt: revision.pushedAt,
    ...(revision.submittedAt === undefined ? {} : { submittedAt: revision.submittedAt }),
    ...(revision.terminal === undefined
      ? {}
      : {
          terminal: {
            kind: revision.terminal.status,
            at: revision.terminal.at,
            ...(revision.terminal.run === undefined ? {} : { run: revision.terminal.run }),
          },
        }),
  }
}

export function fixturePr(
  id: string,
  status: FixtureDeliveryState,
  submittedAt: string,
  name = `Fixture ${id}`,
  options: FixturePrOptions = {},
): PR {
  const digit = id.replace(/\D/gu, "").at(-1) ?? "1"
  const revision = options.revision ?? 1
  const headSha = options.headSha ?? digit.repeat(40)
  const terminalAt =
    status === "rejected"
      ? options.rejectedAt
      : status === "integrated"
        ? options.integratedAt
        : status === "withdrawn"
          ? options.withdrawnAt
          : status === "canceled"
            ? options.canceledAt
            : undefined
  const defaultTerminal =
    status === "rejected" || status === "integrated" || status === "withdrawn" || status === "canceled"
      ? {
          terminal: {
            kind: status,
            at: terminalAt ?? submittedAt,
            ...(options.terminalRun === undefined ? {} : { run: options.terminalRun }),
          },
        }
      : {}
  const revs = (
    options.revisions ?? [
      {
        n: revision,
        head: headSha,
        base: "main",
        baseSha: BASE_SHA,
        pushedAt: submittedAt,
        ...(status === "pushed" ? {} : { submittedAt }),
        ...(options.actor === undefined ? {} : { actor: options.actor }),
        ...defaultTerminal,
      },
    ]
  ).map(fixtureRevision)
  const retainedTerminalAt = currentPRRev({ id, revs }).terminal?.at
  return {
    id,
    name,
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    ...(options.note === undefined ? {} : { note: options.note }),
    branch: `topic/${id.toLocaleLowerCase()}`,
    base: "main",
    state: status === "integrated" || status === "withdrawn" || status === "canceled" ? "closed" : "open",
    merged: status === "integrated",
    revs,
    ...(status === "pushed" ? {} : { submittedAt }),
    reviews: options.reviews ?? [],
    comments: options.comments ?? [],
    checkRequests: options.checkRequests ?? [],
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.terminalRun === undefined ? {} : { terminalRun: options.terminalRun }),
    ...(options.rejectedAt === undefined ? {} : { rejectedAt: options.rejectedAt }),
    ...(options.integratedAt === undefined ? {} : { integratedAt: options.integratedAt }),
    ...(status !== "withdrawn"
      ? {}
      : { withdrawnAt: options.withdrawnAt ?? retainedTerminalAt ?? terminalAt ?? submittedAt }),
    ...(options.withdrawReason === undefined ? {} : { withdrawReason: options.withdrawReason }),
    ...(options.canceledAt === undefined ? {} : { canceledAt: options.canceledAt }),
    ...(options.canceledBy === undefined ? {} : { canceledBy: options.canceledBy }),
    ...(options.cancelReason === undefined ? {} : { cancelReason: options.cancelReason }),
    ...(options.integration === undefined ? {} : { integration: options.integration }),
  }
}

function terminalFixturePr(
  id: string,
  status: Extract<FixtureDeliveryState, "rejected" | "integrated" | "canceled">,
  submittedAt: string,
  terminalAt: string,
  run: string,
  name: string,
  options: Omit<FixturePrOptions, "headSha" | "revisions" | "terminalRun"> = {},
): PR {
  const digit = id.replace(/\D/gu, "").at(-1) ?? "1"
  const headSha = digit.repeat(40)
  return fixturePr(id, status, submittedAt, name, {
    ...options,
    headSha,
    terminalRun: run,
    revisions: [
      {
        revision: 1,
        headSha,
        base: "main",
        baseSha: BASE_SHA,
        pushedAt: submittedAt,
        submittedAt,
        ...(options.actor === undefined ? {} : { actor: options.actor }),
        terminal: { status, at: terminalAt, run },
      },
    ],
    ...(status === "rejected" ? { rejectedAt: terminalAt } : {}),
    ...(status === "integrated"
      ? { integratedAt: terminalAt, integration: { commit: INTEGRATED_SHA, baseSha: BASE_SHA } }
      : {}),
    ...(status === "canceled"
      ? {
          canceledAt: terminalAt,
          canceledBy: options.canceledBy ?? "operator@example.test",
          cancelReason: options.cancelReason ?? "superseded by a newer revision",
        }
      : {}),
  })
}

type FixtureJobOptions = Readonly<{
  attempt?: number
  command?: readonly string[]
  requestedAt?: string
  changedAt?: string
  startedAt?: string
  finishedAt?: string
  runner?: string
  leaseExpiresAt?: string
  token?: string
  url?: string
  detail?: string
  output?: JsonValue
  artifacts?: readonly JsonValue[]
  checkpoint?: JsonValue
  error?: Readonly<{ code: string; message: string }>
  canceledBy?: string
  cancelReason?: string
}>

type FixtureJobStatus = "requested" | "running" | "waiting" | "passed" | "failed" | "lost" | "canceled"

export function fixtureJob(id: string, status: FixtureJobStatus, options: FixtureJobOptions = {}): Job {
  const requestedAt = options.requestedAt ?? "2026-07-13T11:30:00.000Z"
  const base = {
    id,
    definition: "queue.step",
    revision: "fixture-v2",
    input: { command: options.command ?? ["bun", "vitest", "run"] },
    attempt: options.attempt ?? (status === "requested" ? 0 : 1),
    requestedAt,
    changedAt: options.changedAt ?? requestedAt,
  } as const
  if (status === "requested") return { ...base, status: "queued" }
  if (status === "canceled") {
    return {
      ...base,
      status: "completed",
      conclusion: "cancelled",
      finishedAt: options.finishedAt ?? "2026-07-13T11:45:00.000Z",
      canceledBy: options.canceledBy ?? "operator@example.test",
      cancelReason: options.cancelReason ?? "superseded by a newer revision",
    }
  }

  const execution = {
    startedAt: options.startedAt ?? "2026-07-13T11:31:00.000Z",
    runner: options.runner ?? "runner-herdr-03",
  } as const
  if (status === "running") {
    return {
      ...base,
      ...execution,
      status: "in_progress",
      leaseExpiresAt: options.leaseExpiresAt ?? "2026-07-13T12:05:00.000Z",
    }
  }
  if (status === "waiting") {
    return {
      ...base,
      ...execution,
      status,
      token: options.token ?? "approval-token-42",
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
      ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
    }
  }
  if (status === "lost") {
    return {
      ...base,
      ...execution,
      status: "completed",
      conclusion: "timed_out",
      finishedAt: options.finishedAt ?? "2026-07-13T11:45:00.000Z",
      lostReason: options.detail ?? "runner lease expired",
    }
  }

  const finished = {
    ...base,
    ...execution,
    finishedAt: options.finishedAt ?? "2026-07-13T11:40:00.000Z",
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
  } as const
  return status === "passed"
    ? { ...finished, status: "completed", conclusion: "success", output: options.output ?? {} }
    : {
        ...finished,
        status: "completed",
        conclusion: "failure",
        error: options.error ?? { code: "check-failed", message: "focused verification failed" },
        ...(options.output === undefined ? {} : { output: options.output }),
      }
}

export function fixtureStep(
  name: string,
  job: Job,
  options: Readonly<{
    title?: string
    revision?: string
    kind?: "check" | "action" | "merge"
    classification?: "base" | "carrier"
  }> = {},
): Run["steps"][number] {
  return {
    name,
    title: options.title ?? `${name} production gate`,
    revision: options.revision ?? "step-v2",
    kind: options.kind ?? "check",
    ...(options.classification === undefined ? {} : { classification: options.classification }),
    job,
  }
}

export function fixtureRun(
  id: string,
  prs: readonly PR[],
  status: FixtureRunStatus,
  startedAt: string,
  options: Readonly<{
    finishedAt?: string
    error?: Readonly<{ code: string; message: string }>
    steps?: Run["steps"]
    cursor?: number
    results?: Readonly<Record<string, JsonValue>>
    memberRevisions?: Readonly<Record<string, number>>
  }> = {},
): Run {
  const integration = status === "passed" ? { commit: INTEGRATED_SHA, baseSha: BASE_SHA } : undefined
  const runStatus: Run["status"] = status === "running" ? "in_progress" : status === "waiting" ? "waiting" : "completed"
  const conclusion: Run["conclusion"] | undefined =
    status === "passed" ? "success" : status === "failed" ? "failure" : undefined
  const steps = options.steps ?? []
  return {
    id,
    queueId: "main",
    candidateId: `C${id.replace(/\D/gu, "") || "1"}`,
    prs: prs.map((pr) => {
      const revision = options.memberRevisions?.[pr.id] ?? currentPRRev(pr).n
      const clock = pr.revs.find((candidate) => candidate.n === revision)
      if (clock === undefined) throw new Error(`fixture PR '${pr.id}' is missing revision ${revision}`)
      return {
        id: pr.id,
        name: pr.name,
        branch: pr.branch,
        base: pr.base,
        revision,
        headSha: clock.head,
        baseSha: clock.baseSha,
      }
    }),
    base: "main",
    jobs: steps.flatMap((step) => (step.job === undefined ? [] : [step.job.id])),
    steps,
    startedAt,
    cursor: options.cursor ?? 0,
    ...(integration === undefined ? {} : { integration }),
    shape:
      integration === undefined ? { results: options.results ?? {} } : { results: options.results ?? {}, integration },
    status: runStatus,
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
    ...(options.error === undefined ? {} : { error: options.error }),
  }
}

type FixtureRunStatus = "running" | "waiting" | "passed" | "failed"

export function fixtureResult(
  prs: readonly PR[],
  runs: readonly Run[],
  pause?: QueueStatusResult["pause"],
): QueueStatusResult {
  return {
    base: "main",
    headSha: BASE_SHA,
    prs: [...prs],
    running: runs.filter((run) => run.status === "queued" || run.status === "in_progress"),
    waiting: runs.filter((run) => run.status === "waiting"),
    finished: runs.filter((run) => run.status === "completed"),
    ...(pause === undefined ? {} : { pause }),
  }
}

type ProjectionOptions = Readonly<{
  statuses?: readonly QueueTimelineStatusFilter[]
  terms?: readonly string[]
  latest?: boolean
  rowLimit?: number
  retainedSinceMs?: number
  attempts?: readonly QueueAttempt[]
  runner?: Readonly<{ pid: number; startedAt: string; lastTickAt: string }> | null
}>

function fixtureProjection(result: QueueStatusResult, options: ProjectionOptions = {}): QueueTimelineProjection {
  const submissionTimes = queueTimelineAdmissionTimes([result])
  return queueTimelineProjection([result], {
    now: NOW,
    windowMs: 6 * 60 * 60_000,
    statuses: options.statuses ?? ALL_STATUSES,
    terms: options.terms ?? [],
    latest: options.latest ?? false,
    rowLimit: options.rowLimit ?? 20,
    submissionTimes,
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    retainedSinceMs: options.retainedSinceMs ?? Date.parse("2026-07-13T05:00:00.000Z"),
    siblingBases: ["release/next"],
    base: "main",
    runner:
      options.runner === undefined
        ? { pid: 84042, startedAt: "2026-07-13T11:00:00.000Z", lastTickAt: "2026-07-13T11:59:58.000Z" }
        : options.runner,
  })
}

export function fixtureSnapshot(
  result: QueueStatusResult,
  options: ProjectionOptions = {},
  outputs?: readonly QueueArtifactOutput[],
): QueueWatchSnapshot & Readonly<{ projection: QueueTimelineProjection }> {
  return {
    results: [result],
    now: NOW,
    projection: fixtureProjection(result, options),
    ...(outputs === undefined ? {} : { outputs }),
  }
}

const pendingOneHead = "1".repeat(40)
const pendingOne = fixturePr("PR1", "submitted", "2026-07-13T11:10:00.000Z", "Prepare release notes", {
  actor: "@cto",
  issue: "@yrd/core/21120-pr-state-notifications",
  note: "Keep the operator-facing notification contract visible during review.",
  reviews: [
    {
      revision: 1,
      headSha: pendingOneHead,
      actor: "reviewer@example.test",
      decision: "approve",
      at: "2026-07-13T11:14:00.000Z",
      ref: "review://PR1/1",
      note: "Queue presentation matches the accepted contract.",
    },
  ],
  comments: [
    {
      revision: 1,
      headSha: pendingOneHead,
      actor: "author@example.test",
      note: "The selected detail should retain this source position.",
      at: "2026-07-13T11:15:00.000Z",
      ref: "packages/yrd-cli/src/queue-status-view.tsx:1463",
    },
  ],
  checkRequests: [
    {
      revision: 1,
      headSha: pendingOneHead,
      baseSha: BASE_SHA,
      at: "2026-07-13T11:16:00.000Z",
    },
  ],
})
const pendingTwo = fixturePr("PR2", "submitted", "2026-07-13T11:20:00.000Z", "Repair queue view")
const runningPr = fixturePr("PR3", "submitted", "2026-07-13T11:25:00.000Z", "Run focused checks")
const integratedPr = terminalFixturePr(
  "PR4",
  "integrated",
  "2026-07-13T10:30:00.000Z",
  "2026-07-13T10:55:00.000Z",
  "R4",
  "Land the durable patch",
  { actor: "@agent/7" },
)
const rejectedPr = terminalFixturePr(
  "PR5",
  "rejected",
  "2026-07-13T10:45:00.000Z",
  "2026-07-13T11:12:00.000Z",
  "R5",
  "Reject broken payload",
  { actor: "@agent/2", detail: "typecheck-failed: packages/yrd-cli/src/run.ts:1428" },
)
const environmentPr = fixturePr("PR6", "submitted", "2026-07-13T10:50:00.000Z", "Retry stale environment")
const canceledPr = terminalFixturePr(
  "PR7",
  "canceled",
  "2026-07-13T10:55:00.000Z",
  "2026-07-13T11:35:00.000Z",
  "R7",
  "Cancel superseded run",
)

const batchLeadHead = "c".repeat(40)
const batchPartnerHead = "d".repeat(40)
const batchLeadPr = fixturePr(
  "PR42",
  "submitted",
  "2026-07-13T11:24:00.000Z",
  "Align host navigation keybindings without disturbing internal pane controls",
  {
    headSha: batchLeadHead,
    actor: "@agent/3",
    issue: "@hab/super/21135-herdr-keybindings",
    reviews: [
      {
        revision: 1,
        headSha: batchLeadHead,
        actor: "chief@example.test",
        decision: "approve",
        at: "2026-07-13T11:28:00.000Z",
        ref: "request://9097d479",
      },
    ],
    comments: [
      {
        revision: 1,
        headSha: batchLeadHead,
        actor: "operator@example.test",
        note: "Preserve Option+1..9 and the accepted pane-focus precedent.",
        at: "2026-07-13T11:29:00.000Z",
        ref: "config/herdr.toml:18",
      },
    ],
    checkRequests: [
      {
        revision: 1,
        headSha: batchLeadHead,
        baseSha: BASE_SHA,
        at: "2026-07-13T11:30:00.000Z",
      },
    ],
  },
)
const batchPartnerPr = fixturePr(
  "PR43",
  "submitted",
  "2026-07-13T11:26:00.000Z",
  "Carry the production split-pane contract into the queue detail surface",
  {
    headSha: batchPartnerHead,
    actor: "@agent/5",
    issue: "@si/ui/21119-split-pane",
    checkRequests: [
      {
        revision: 1,
        headSha: batchPartnerHead,
        baseSha: BASE_SHA,
        at: "2026-07-13T11:31:00.000Z",
      },
    ],
  },
)

const prepareManifest = {
  kind: "checkout-manifest",
  uri: "file:///repo/.git/yrd/artifacts/R42/0-prepare/attempt-1/manifest.json",
} as const
const checkReport = {
  kind: "vitest-report",
  uri: "file:///repo/.git/yrd/artifacts/R4/0-check/attempt-1/report.json",
} as const
const rejectionEvidence = {
  kind: "diagnostics",
  uri: "file:///repo/.git/yrd/artifacts/R5/0-check/attempt-2/diagnostics.json",
} as const
const environmentEvidence = {
  kind: "environment",
  uri: "file:///repo/.git/yrd/artifacts/R6/0-prepare/attempt-1/environment.json",
} as const

const runningSteps = [
  fixtureStep(
    "check",
    fixtureJob("J3-check", "running", {
      requestedAt: "2026-07-13T11:39:00.000Z",
      startedAt: "2026-07-13T11:40:00.000Z",
      changedAt: "2026-07-13T11:58:30.000Z",
      leaseExpiresAt: "2026-07-13T12:04:30.000Z",
      runner: "runner-herdr-03",
    }),
    { classification: "carrier" },
  ),
]
const batchSteps = [
  fixtureStep(
    "prepare",
    fixtureJob("J42-prepare", "passed", {
      requestedAt: "2026-07-13T11:39:00.000Z",
      startedAt: "2026-07-13T11:40:00.000Z",
      changedAt: "2026-07-13T11:42:00.000Z",
      finishedAt: "2026-07-13T11:42:00.000Z",
      artifacts: [prepareManifest],
      checkpoint: { baseSha: BASE_SHA, members: ["PR42", "PR43"] },
      output: { prepared: true, artifacts: [prepareManifest] },
    }),
    { classification: "base" },
  ),
  fixtureStep(
    "check",
    fixtureJob("J42-check", "running", {
      attempt: 2,
      requestedAt: "2026-07-13T11:42:00.000Z",
      startedAt: "2026-07-13T11:43:00.000Z",
      changedAt: "2026-07-13T11:58:30.000Z",
      leaseExpiresAt: "2026-07-13T12:05:30.000Z",
      runner: "runner-herdr-07",
    }),
    { classification: "carrier" },
  ),
  fixtureStep("merge", fixtureJob("J42-merge", "requested", { requestedAt: "2026-07-13T11:43:00.000Z" }), {
    kind: "merge",
  }),
]
const integratedSteps = [
  fixtureStep(
    "check",
    fixtureJob("J4-check", "passed", {
      requestedAt: "2026-07-13T10:39:00.000Z",
      startedAt: "2026-07-13T10:40:00.000Z",
      changedAt: "2026-07-13T10:47:00.000Z",
      finishedAt: "2026-07-13T10:47:00.000Z",
      artifacts: [checkReport],
      checkpoint: { tests: 125, failures: 0 },
      output: { tests: 125, failures: 0, artifacts: [checkReport] },
    }),
    { classification: "carrier" },
  ),
  fixtureStep(
    "merge",
    fixtureJob("J4-merge", "passed", {
      command: ["git", "merge", "--no-ff", "--no-edit", "4".repeat(40)],
      requestedAt: "2026-07-13T10:47:00.000Z",
      startedAt: "2026-07-13T10:48:00.000Z",
      changedAt: "2026-07-13T10:55:00.000Z",
      finishedAt: "2026-07-13T10:55:00.000Z",
      output: { commit: INTEGRATED_SHA, baseSha: BASE_SHA },
    }),
    { kind: "merge" },
  ),
]
const rejectedSteps = [
  fixtureStep(
    "check",
    fixtureJob("J5-check", "failed", {
      attempt: 2,
      requestedAt: "2026-07-13T10:59:00.000Z",
      startedAt: "2026-07-13T11:00:00.000Z",
      changedAt: "2026-07-13T11:12:00.000Z",
      finishedAt: "2026-07-13T11:12:00.000Z",
      artifacts: [rejectionEvidence],
      checkpoint: { file: "packages/yrd-cli/src/run.ts", line: 1428 },
      output: { diagnostics: [{ file: "packages/yrd-cli/src/run.ts", line: 1428 }], artifacts: [rejectionEvidence] },
      error: { code: "typecheck-failed", message: "payload does not typecheck at run.ts:1428" },
    }),
    { classification: "carrier" },
  ),
]
const rejectedAttempts: readonly QueueAttempt[] = [
  {
    job: "J5-check",
    run: "R5",
    step: "check",
    index: 0,
    attempt: 1,
    runner: "runner-herdr-02",
    outcome: "failed",
    requestedAt: "2026-07-13T10:49:00.000Z",
    startedAt: "2026-07-13T10:50:00.000Z",
    finishedAt: "2026-07-13T10:55:00.000Z",
    durationMs: 5 * 60_000,
    revision: "step-v2",
    result: {
      status: "failed",
      error: { code: "lint-failed", message: "first attempt exposed formatting drift" },
      output: {
        artifacts: [
          {
            kind: "diagnostics",
            uri: "file:///repo/.git/yrd/artifacts/R5/0-check/attempt-1/diagnostics.json",
          },
        ],
      },
    },
  },
  {
    job: "J5-check",
    run: "R5",
    step: "check",
    index: 0,
    attempt: 2,
    runner: "runner-herdr-03",
    outcome: "failed",
    requestedAt: "2026-07-13T10:59:00.000Z",
    startedAt: "2026-07-13T11:00:00.000Z",
    finishedAt: "2026-07-13T11:12:00.000Z",
    durationMs: 12 * 60_000,
    revision: "step-v2",
    result: {
      status: "failed",
      error: { code: "typecheck-failed", message: "payload does not typecheck at run.ts:1428" },
      output: { diagnostics: [{ file: "packages/yrd-cli/src/run.ts", line: 1428 }], artifacts: [rejectionEvidence] },
    },
  },
]
const environmentSteps = [
  fixtureStep(
    "prepare",
    fixtureJob("J6-prepare", "failed", {
      requestedAt: "2026-07-13T11:14:00.000Z",
      startedAt: "2026-07-13T11:15:00.000Z",
      changedAt: "2026-07-13T11:28:00.000Z",
      finishedAt: "2026-07-13T11:28:00.000Z",
      artifacts: [environmentEvidence],
      output: { remote: "origin", retryable: true, artifacts: [environmentEvidence] },
      error: { code: "queue-environment-refused", message: "origin was unavailable after three attempts" },
    }),
    { classification: "base" },
  ),
]
const canceledSteps = [
  fixtureStep(
    "check",
    fixtureJob("J7-check", "canceled", {
      attempt: 1,
      requestedAt: "2026-07-13T11:29:00.000Z",
      changedAt: "2026-07-13T11:35:00.000Z",
      finishedAt: "2026-07-13T11:35:00.000Z",
      canceledBy: "operator@example.test",
      cancelReason: "superseded by PR8 revision 2",
    }),
  ),
]

const runningRun = fixtureRun("R3", [runningPr], "running", "2026-07-13T11:40:00.000Z", {
  steps: runningSteps,
})
const batchRun = fixtureRun("R42", [batchLeadPr, batchPartnerPr], "running", "2026-07-13T11:40:00.000Z", {
  steps: batchSteps,
  cursor: 1,
  results: { prepare: { prepared: true, artifacts: [prepareManifest] } },
})
const integratedRun = fixtureRun("R4", [integratedPr], "passed", "2026-07-13T10:40:00.000Z", {
  finishedAt: "2026-07-13T10:55:00.000Z",
  steps: integratedSteps,
  cursor: integratedSteps.length,
  results: {
    check: { tests: 125, failures: 0, artifacts: [checkReport] },
    merge: { commit: INTEGRATED_SHA, baseSha: BASE_SHA },
  },
})
const rejectedRun = fixtureRun("R5", [rejectedPr], "failed", "2026-07-13T11:00:00.000Z", {
  finishedAt: "2026-07-13T11:12:00.000Z",
  error: { code: "typecheck-failed", message: "payload does not typecheck" },
  steps: rejectedSteps,
  cursor: 0,
})
const environmentRun = fixtureRun("R6", [environmentPr], "failed", "2026-07-13T11:15:00.000Z", {
  finishedAt: "2026-07-13T11:28:00.000Z",
  error: { code: "queue-environment-refused", message: "origin was unavailable" },
  steps: environmentSteps,
  cursor: 0,
})
const canceledRun = fixtureRun("R7", [canceledPr], "failed", "2026-07-13T11:30:00.000Z", {
  finishedAt: "2026-07-13T11:35:00.000Z",
  error: { code: "queue-canceled", message: "superseded by a newer revision" },
  steps: canceledSteps,
  cursor: 0,
})

const mixedResult = fixtureResult(
  [pendingOne, pendingTwo, runningPr, integratedPr, rejectedPr, environmentPr, canceledPr],
  [runningRun, integratedRun, rejectedRun, environmentRun, canceledRun],
)
const pausedResult = fixtureResult([pendingOne, pendingTwo], [], {
  base: "main",
  reason: "operator freeze",
  allowedPRs: ["PR2"],
  pausedAt: "2026-07-13T11:30:00.000Z",
})

const lineageRevisionOneHead = "7".repeat(40)
const lineageRevisionTwoHead = "8".repeat(40)
const lineagePr = fixturePr("PR8", "integrated", "2026-07-13T09:30:00.000Z", "Retry until green", {
  revision: 2,
  headSha: lineageRevisionTwoHead,
  integratedAt: "2026-07-13T09:45:00.000Z",
  terminalRun: "R9",
  integration: { commit: INTEGRATED_SHA, baseSha: BASE_SHA },
  revisions: [
    {
      revision: 1,
      headSha: lineageRevisionOneHead,
      base: "main",
      baseSha: BASE_SHA,
      pushedAt: "2026-07-13T08:55:00.000Z",
      submittedAt: "2026-07-13T09:00:00.000Z",
      terminal: { status: "rejected", at: "2026-07-13T09:25:00.000Z", run: "R8" },
    },
    {
      revision: 2,
      headSha: lineageRevisionTwoHead,
      base: "main",
      baseSha: BASE_SHA,
      pushedAt: "2026-07-13T09:28:00.000Z",
      submittedAt: "2026-07-13T09:30:00.000Z",
      terminal: { status: "integrated", at: "2026-07-13T09:45:00.000Z", run: "R9" },
    },
  ],
  reviews: [
    {
      revision: 1,
      headSha: lineageRevisionOneHead,
      actor: "reviewer@example.test",
      decision: "reject",
      at: "2026-07-13T09:05:00.000Z",
      note: "Revision 1 retained a stale failure.",
    },
    {
      revision: 2,
      headSha: lineageRevisionTwoHead,
      actor: "reviewer@example.test",
      decision: "approve",
      at: "2026-07-13T09:32:00.000Z",
      ref: "review://PR8/2",
    },
  ],
  comments: [
    {
      revision: 2,
      headSha: lineageRevisionTwoHead,
      actor: "author@example.test",
      note: "Revision 2 addresses the exact failed assertion.",
      at: "2026-07-13T09:31:00.000Z",
      ref: "packages/yrd-cli/tests/queue-timeline-storybook.test.ts:1",
    },
  ],
  checkRequests: [
    {
      revision: 2,
      headSha: lineageRevisionTwoHead,
      baseSha: BASE_SHA,
      at: "2026-07-13T09:30:30.000Z",
    },
  ],
})
const lineageRuns = [
  fixtureRun("R8", [lineagePr], "failed", "2026-07-13T09:15:00.000Z", {
    finishedAt: "2026-07-13T09:25:00.000Z",
    error: { code: "check-failed", message: "first attempt failed" },
    memberRevisions: { PR8: 1 },
    steps: [
      fixtureStep(
        "check",
        fixtureJob("J8-check", "failed", {
          requestedAt: "2026-07-13T09:14:00.000Z",
          startedAt: "2026-07-13T09:15:00.000Z",
          changedAt: "2026-07-13T09:25:00.000Z",
          finishedAt: "2026-07-13T09:25:00.000Z",
          error: { code: "check-failed", message: "first attempt failed" },
          output: { assertion: "expected true, received false" },
        }),
      ),
    ],
  }),
  fixtureRun("R9", [lineagePr], "passed", "2026-07-13T09:30:00.000Z", {
    finishedAt: "2026-07-13T09:45:00.000Z",
    memberRevisions: { PR8: 2 },
    steps: [
      fixtureStep(
        "check",
        fixtureJob("J9-check", "passed", {
          requestedAt: "2026-07-13T09:29:00.000Z",
          startedAt: "2026-07-13T09:30:00.000Z",
          changedAt: "2026-07-13T09:45:00.000Z",
          finishedAt: "2026-07-13T09:45:00.000Z",
          output: { assertion: "passed" },
        }),
      ),
    ],
  }),
]
const lineageResult = fixtureResult([lineagePr], lineageRuns)

const anchoredPrs = [10, 11, 12, 13].map((value, index) =>
  terminalFixturePr(
    `PR${value}`,
    "integrated",
    `2026-07-13T11:${value}:00.000Z`,
    `2026-07-13T11:${30 + index}:00.000Z`,
    `R${value}`,
    `Anchored result ${value}`,
  ),
)
const anchoredRuns = anchoredPrs.map((pr, index) =>
  fixtureRun(`R${10 + index}`, [pr], "passed", `2026-07-13T11:${20 + index}:00.000Z`, {
    finishedAt: `2026-07-13T11:${30 + index}:00.000Z`,
  }),
)

const longSubjectPr = terminalFixturePr(
  "PR20",
  "integrated",
  "2026-07-13T11:00:00.000Z",
  "2026-07-13T11:15:00.000Z",
  "R20",
  "Preserve every timing column while this deliberately long subject truncates only inside the flexible subject cell",
)
const longSubjectRun = fixtureRun("R20", [longSubjectPr], "passed", "2026-07-13T11:05:00.000Z", {
  finishedAt: "2026-07-13T11:15:00.000Z",
})

const batchStdout: QueueArtifactOutput = {
  run: "R42",
  step: "check",
  attempt: 2,
  path: "/repo/.git/yrd/artifacts/R42/1-check/attempt-2/stdout.log",
  text: "$ bun vitest run packages/yrd-cli/tests/queue-timeline-storybook.test.ts\n125 tests collected\n",
}
const batchStderr: QueueArtifactOutput = {
  run: "R42",
  step: "check",
  attempt: 2,
  path: "/repo/.git/yrd/artifacts/R42/1-check/attempt-2/stderr.log",
  text: "stderr: waiting for the final focused assertion\n",
}
const initialOutput: QueueArtifactOutput = {
  run: "R3",
  step: "check",
  attempt: 1,
  path: "/repo/.git/yrd/artifacts/R3/0-check/attempt-1/stdout.log",
  text: "checking one\n",
}
const initialStderr: QueueArtifactOutput = {
  run: "R3",
  step: "check",
  attempt: 1,
  path: "/repo/.git/yrd/artifacts/R3/0-check/attempt-1/stderr.log",
  text: "stderr: retry warning retained\n",
}

const productionOverviewResult = fixtureResult(
  [batchLeadPr, batchPartnerPr, integratedPr, rejectedPr, environmentPr, canceledPr],
  [batchRun, integratedRun, rejectedRun, environmentRun, canceledRun],
)

const secondaryQueueResult: QueueStatusResult = {
  ...fixtureResult([], []),
  base: "release/next",
}
const multipleQueuesSnapshot: QueueWatchSnapshot & Readonly<{ projection: QueueTimelineProjection }> = {
  ...fixtureSnapshot(productionOverviewResult),
  results: [productionOverviewResult, secondaryQueueResult],
}

function advanceSnapshotClock(
  snapshot: QueueWatchSnapshot & Readonly<{ projection: QueueTimelineProjection }>,
): QueueWatchSnapshot & Readonly<{ projection: QueueTimelineProjection }> {
  return {
    ...snapshot,
    now: NEXT_NOW,
    projection: {
      ...snapshot.projection,
      now: NEXT_NOW_ISO,
    },
  }
}

export const QUEUE_TIMELINE_STORY_NAMES = [
  "production-overview",
  "contract-overview",
  "idle",
  "multiple-queues",
  "pending-only",
  "running-spinner",
  "mixed-completed",
  "paused",
  "honest-cap",
  "non-default-filters",
  "latest-vs-all-lineage",
  "narrow-wide",
  "anchored-new",
  "selected-pending",
  "selected-running",
  "selected-rejected",
  "selected-integrated",
  "detail-right",
  "detail-below",
  "detail-full",
  "detail-controls",
  "long-subject",
  "live-output-growth",
] as const

export type QueueTimelineStoryName = (typeof QUEUE_TIMELINE_STORY_NAMES)[number]
export type QueueTimelineStory = Readonly<{
  snapshot: QueueWatchSnapshot & Readonly<{ projection: QueueTimelineProjection }>
  widths: readonly number[]
  selectedStatus?: QueueTimelineStatus
  viewport?: Readonly<{ columns: number; rows: number }>
  nextSnapshot?: QueueWatchSnapshot & Readonly<{ projection: QueueTimelineProjection }>
}>

const integratedSnapshot = fixtureSnapshot(fixtureResult([integratedPr], [integratedRun]))

export const queueTimelineStories: Readonly<Record<QueueTimelineStoryName, QueueTimelineStory>> = {
  "production-overview": {
    snapshot: {
      ...fixtureSnapshot(productionOverviewResult, { statuses: ["running", "rejected", "integrated", "other"] }, [
        batchStdout,
        batchStderr,
      ]),
      diffs: [
        {
          pr: "PR42",
          revision: 1,
          additions: 324,
          deletions: 323,
          files: ["packages/yrd-cli/src/watch-pane.tsx", "packages/yrd-cli/tests/queue-watch-round6.test.ts"],
          patch: [
            "diff --git a/packages/yrd-cli/src/watch-pane.tsx b/packages/yrd-cli/src/watch-pane.tsx",
            "--- a/packages/yrd-cli/src/watch-pane.tsx",
            "+++ b/packages/yrd-cli/src/watch-pane.tsx",
            "@@ -1 +1 @@",
            "-legacy detail layout",
            "+synthetic submit step",
          ].join("\n"),
        },
        { pr: "PR43", revision: 1, unavailable: "refs-pruned" },
      ],
    },
    widths: [80, 140],
    selectedStatus: "running",
    viewport: { columns: 200, rows: 50 },
  },
  // The user-settled 21106 mockup shape: one pending PR, one batched running
  // Run rendered one row per member, one rejected and one integrated Run.
  "contract-overview": {
    snapshot: fixtureSnapshot(
      fixtureResult(
        [pendingOne, batchLeadPr, batchPartnerPr, integratedPr, rejectedPr],
        [batchRun, integratedRun, rejectedRun],
      ),
    ),
    widths: [80, 120, 160, 200],
    viewport: { columns: 200, rows: 50 },
  },
  idle: { snapshot: fixtureSnapshot(fixtureResult([], [])), widths: [100] },
  "multiple-queues": {
    snapshot: multipleQueuesSnapshot,
    widths: [100],
  },
  "pending-only": { snapshot: fixtureSnapshot(fixtureResult([pendingOne, pendingTwo], [])), widths: [100] },
  "running-spinner": {
    snapshot: fixtureSnapshot(fixtureResult([runningPr], [runningRun])),
    widths: [100],
    selectedStatus: "running",
  },
  "mixed-completed": { snapshot: fixtureSnapshot(mixedResult), widths: [120] },
  paused: { snapshot: fixtureSnapshot(pausedResult, { runner: null }), widths: [100] },
  "honest-cap": { snapshot: fixtureSnapshot(mixedResult, { rowLimit: 2 }), widths: [100] },
  "non-default-filters": {
    snapshot: fixtureSnapshot(mixedResult, { statuses: ["rejected"], terms: ["typecheck"] }),
    widths: [110],
    selectedStatus: "rejected",
  },
  "latest-vs-all-lineage": {
    snapshot: fixtureSnapshot(lineageResult, { latest: true }),
    nextSnapshot: advanceSnapshotClock(fixtureSnapshot(lineageResult)),
    widths: [100],
  },
  "narrow-wide": { snapshot: fixtureSnapshot(mixedResult), widths: [80, 120, 160, 200] },
  "anchored-new": {
    snapshot: fixtureSnapshot(fixtureResult(anchoredPrs.slice(0, 3), anchoredRuns.slice(0, 3))),
    nextSnapshot: fixtureSnapshot(fixtureResult(anchoredPrs, anchoredRuns)),
    widths: [110],
  },
  "selected-pending": {
    snapshot: fixtureSnapshot(fixtureResult([pendingOne], [])),
    widths: [100],
    selectedStatus: "pending",
  },
  "selected-running": {
    snapshot: fixtureSnapshot(fixtureResult([runningPr], [runningRun])),
    widths: [100],
    selectedStatus: "running",
  },
  "selected-rejected": {
    snapshot: fixtureSnapshot(fixtureResult([rejectedPr], [rejectedRun]), { attempts: rejectedAttempts }),
    widths: [100],
    selectedStatus: "rejected",
  },
  "selected-integrated": { snapshot: integratedSnapshot, widths: [100], selectedStatus: "integrated" },
  "detail-right": { snapshot: integratedSnapshot, widths: [140], viewport: { columns: 200, rows: 50 } },
  "detail-below": { snapshot: integratedSnapshot, widths: [100], viewport: { columns: 100, rows: 40 } },
  "detail-full": { snapshot: integratedSnapshot, widths: [80], viewport: { columns: 80, rows: 24 } },
  "detail-controls": { snapshot: integratedSnapshot, widths: [140], viewport: { columns: 200, rows: 50 } },
  "long-subject": {
    snapshot: fixtureSnapshot(fixtureResult([longSubjectPr], [longSubjectRun])),
    widths: [80, 120, 160, 200],
    selectedStatus: "integrated",
  },
  "live-output-growth": {
    snapshot: fixtureSnapshot(fixtureResult([runningPr], [runningRun]), {}, [initialOutput, initialStderr]),
    nextSnapshot: advanceSnapshotClock(
      fixtureSnapshot(fixtureResult([runningPr], [runningRun]), {}, [
        { ...initialOutput, text: "checking one\nchecking two\n" },
        { ...initialStderr, text: "stderr: retry warning retained\nstderr: retry recovered\n" },
      ]),
    ),
    widths: [120],
    selectedStatus: "running",
    viewport: { columns: 200, rows: 50 },
  },
}
