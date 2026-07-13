import type { PR, PRStatus } from "@yrd/bay"
import type { QueueRun } from "@yrd/queue"
import {
  queueRevisionKey,
  queueTimelineProjection,
  type QueueStatusResult,
  type QueueTimelineProjection,
  type QueueTimelineStatusFilter,
} from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
const BASE_SHA = "a".repeat(40)
const INTEGRATED_SHA = "b".repeat(40)
const ALL_STATUSES: readonly QueueTimelineStatusFilter[] = ["pending", "running", "rejected", "integrated", "other"]

function fixturePr(id: string, status: PRStatus, submittedAt: string, name = `Fixture ${id}`): PR {
  const digit = id.replace(/\D/gu, "").at(-1) ?? "1"
  return {
    id,
    name,
    branch: `topic/${id.toLocaleLowerCase()}`,
    base: "main",
    status,
    revision: 1,
    headSha: digit.repeat(40),
    baseSha: BASE_SHA,
    revisions: [],
    submittedAt,
  }
}

function fixtureRun(
  id: string,
  prs: readonly PR[],
  status: QueueRun["status"],
  startedAt: string,
  options: Readonly<{
    finishedAt?: string
    error?: Readonly<{ code: string; message: string }>
  }> = {},
): QueueRun {
  const integration = status === "passed" ? { commit: INTEGRATED_SHA, baseSha: BASE_SHA } : undefined
  return {
    id,
    prs: prs.map((pr) => ({
      id: pr.id,
      name: pr.name,
      branch: pr.branch,
      base: pr.base,
      revision: pr.revision,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
    })),
    base: "main",
    steps: [],
    startedAt,
    cursor: 0,
    ...(integration === undefined ? {} : { integration }),
    shape: integration === undefined ? { results: {} } : { results: {}, integration },
    status,
    ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
    ...(options.error === undefined ? {} : { error: options.error }),
  }
}

function fixtureResult(
  prs: readonly PR[],
  runs: readonly QueueRun[],
  pause?: QueueStatusResult["pause"],
): QueueStatusResult {
  return {
    base: "main",
    headSha: BASE_SHA,
    prs: [...prs],
    running: runs.filter((run) => run.status === "running"),
    waiting: runs.filter((run) => run.status === "waiting"),
    finished: runs.filter((run) => run.status === "passed" || run.status === "failed"),
    ...(pause === undefined ? {} : { pause }),
  }
}

type ProjectionOptions = Readonly<{
  statuses?: readonly QueueTimelineStatusFilter[]
  terms?: readonly string[]
  latest?: boolean
  rowLimit?: number
  retainedSinceMs?: number
}>

function fixtureProjection(result: QueueStatusResult, options: ProjectionOptions = {}): QueueTimelineProjection {
  const submissionTimes = new Map(
    result.prs.flatMap((pr) => (pr.submittedAt === undefined ? [] : [[queueRevisionKey(pr), pr.submittedAt] as const])),
  )
  return queueTimelineProjection([result], {
    now: NOW,
    windowMs: 6 * 60 * 60_000,
    statuses: options.statuses ?? ALL_STATUSES,
    terms: options.terms ?? [],
    latest: options.latest ?? false,
    rowLimit: options.rowLimit ?? 20,
    submissionTimes,
    retainedSinceMs: options.retainedSinceMs ?? Date.parse("2026-07-13T05:00:00.000Z"),
    siblingBases: ["release/next"],
    base: "main",
  })
}

const pendingOne = fixturePr("PR1", "submitted", "2026-07-13T11:10:00.000Z", "Prepare release notes")
const pendingTwo = fixturePr("PR2", "submitted", "2026-07-13T11:20:00.000Z", "Repair queue view")
const runningPr = fixturePr("PR3", "submitted", "2026-07-13T11:25:00.000Z", "Run focused checks")
const integratedPr = fixturePr("PR4", "integrated", "2026-07-13T10:30:00.000Z", "Land the durable patch")
const rejectedPr = fixturePr("PR5", "rejected", "2026-07-13T10:45:00.000Z", "Reject broken payload")
const environmentPr = fixturePr("PR6", "submitted", "2026-07-13T10:50:00.000Z", "Retry stale environment")
const canceledPr = fixturePr("PR7", "submitted", "2026-07-13T10:55:00.000Z", "Cancel superseded run")

const runningRun = fixtureRun("R3", [runningPr], "running", "2026-07-13T11:40:00.000Z")
const integratedRun = fixtureRun("R4", [integratedPr], "passed", "2026-07-13T10:40:00.000Z", {
  finishedAt: "2026-07-13T10:55:00.000Z",
})
const rejectedRun = fixtureRun("R5", [rejectedPr], "failed", "2026-07-13T11:00:00.000Z", {
  finishedAt: "2026-07-13T11:12:00.000Z",
  error: { code: "typecheck-failed", message: "payload does not typecheck" },
})
const environmentRun = fixtureRun("R6", [environmentPr], "failed", "2026-07-13T11:15:00.000Z", {
  finishedAt: "2026-07-13T11:28:00.000Z",
  error: { code: "queue-environment-refused", message: "origin was unavailable" },
})
const canceledRun = fixtureRun("R7", [canceledPr], "failed", "2026-07-13T11:30:00.000Z", {
  finishedAt: "2026-07-13T11:35:00.000Z",
  error: { code: "queue-canceled", message: "superseded by a newer revision" },
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

const lineagePr = fixturePr("PR8", "integrated", "2026-07-13T09:00:00.000Z", "Retry until green")
const lineageRuns = [
  fixtureRun("R8", [lineagePr], "failed", "2026-07-13T09:15:00.000Z", {
    finishedAt: "2026-07-13T09:25:00.000Z",
    error: { code: "check-failed", message: "first attempt failed" },
  }),
  fixtureRun("R9", [lineagePr], "passed", "2026-07-13T09:30:00.000Z", {
    finishedAt: "2026-07-13T09:45:00.000Z",
  }),
]
const lineageResult = fixtureResult([lineagePr], lineageRuns)

const anchoredPrs = [10, 11, 12, 13].map((value) =>
  fixturePr(`PR${value}`, "integrated", `2026-07-13T11:${value}:00.000Z`, `Anchored result ${value}`),
)
const anchoredRuns = anchoredPrs.map((pr, index) =>
  fixtureRun(`R${10 + index}`, [pr], "passed", `2026-07-13T11:${20 + index}:00.000Z`, {
    finishedAt: `2026-07-13T11:${30 + index}:00.000Z`,
  }),
)

export const QUEUE_TIMELINE_STORY_NAMES = [
  "idle",
  "pending-only",
  "running-spinner",
  "mixed-completed",
  "paused",
  "honest-cap",
  "non-default-filters",
  "latest-vs-all-lineage",
  "narrow-wide",
  "anchored-new",
  "drill-in-open",
] as const

export type QueueTimelineStoryName = (typeof QUEUE_TIMELINE_STORY_NAMES)[number]
export type QueueTimelineStory = Readonly<{
  projection: QueueTimelineProjection
  widths: readonly number[]
  nextProjection?: QueueTimelineProjection
  openRun?: string
}>

export const queueTimelineStories: Readonly<Record<QueueTimelineStoryName, QueueTimelineStory>> = {
  idle: {
    projection: fixtureProjection(fixtureResult([], [])),
    widths: [100],
  },
  "pending-only": {
    projection: fixtureProjection(fixtureResult([pendingOne, pendingTwo], [])),
    widths: [100],
  },
  "running-spinner": {
    projection: fixtureProjection(fixtureResult([runningPr], [runningRun])),
    widths: [100],
  },
  "mixed-completed": {
    projection: fixtureProjection(mixedResult),
    widths: [120],
  },
  paused: {
    projection: fixtureProjection(pausedResult),
    widths: [100],
  },
  "honest-cap": {
    projection: fixtureProjection(mixedResult, { rowLimit: 2 }),
    widths: [100],
  },
  "non-default-filters": {
    projection: fixtureProjection(mixedResult, { statuses: ["rejected"], terms: ["typecheck"] }),
    widths: [110],
  },
  "latest-vs-all-lineage": {
    projection: fixtureProjection(lineageResult, { latest: true }),
    nextProjection: fixtureProjection(lineageResult),
    widths: [100],
  },
  "narrow-wide": {
    projection: fixtureProjection(mixedResult),
    widths: [72, 140],
  },
  "anchored-new": {
    projection: fixtureProjection(fixtureResult(anchoredPrs.slice(0, 3), anchoredRuns.slice(0, 3))),
    nextProjection: fixtureProjection(fixtureResult(anchoredPrs, anchoredRuns)),
    widths: [110],
  },
  "drill-in-open": {
    projection: fixtureProjection(mixedResult),
    widths: [120],
    openRun: "R4",
  },
}
