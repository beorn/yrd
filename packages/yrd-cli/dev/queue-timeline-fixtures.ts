import type { PR, PRStatus } from "@yrd/bay"
import type { QueueRun } from "@yrd/queue"
import {
  queueRevisionKey,
  queueTimelineProjection,
  type QueueStatusResult,
  type QueueTimelineProjection,
  type QueueTimelineStatus,
  type QueueTimelineStatusFilter,
} from "../src/queue-status-view.tsx"
import type { QueueArtifactOutput, QueueWatchSnapshot } from "../src/watch-pane.tsx"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
const BASE_SHA = "a".repeat(40)
const INTEGRATED_SHA = "b".repeat(40)
const ALL_STATUSES: readonly QueueTimelineStatusFilter[] = ["pending", "running", "rejected", "integrated", "other"]

function fixturePr(id: string, status: PRStatus, submittedAt: string, name = `Fixture ${id}`): PR {
  const digit = id.replace(/\D/gu, "").at(-1) ?? "1"
  const headSha = digit.repeat(40)
  return {
    id,
    name,
    branch: `topic/${id.toLocaleLowerCase()}`,
    base: "main",
    status,
    revision: 1,
    headSha,
    baseSha: BASE_SHA,
    revisions: [
      {
        revision: 1,
        headSha,
        base: "main",
        baseSha: BASE_SHA,
        pushedAt: submittedAt,
        submittedAt,
      },
    ],
    submittedAt,
    reviews: [],
    comments: [],
    checkRequests: [],
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
    result.prs.flatMap((pr) =>
      pr.submittedAt === undefined ? [] : ([[queueRevisionKey(pr), pr.submittedAt]] as const),
    ),
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

function fixtureSnapshot(
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

const pendingOne = fixturePr("PR1", "submitted", "2026-07-13T11:10:00.000Z", "Prepare release notes")
const pendingTwo = fixturePr("PR2", "submitted", "2026-07-13T11:20:00.000Z", "Repair queue view")
const runningPr = fixturePr("PR3", "submitted", "2026-07-13T11:25:00.000Z", "Run focused checks")
const integratedPr = fixturePr("PR4", "integrated", "2026-07-13T10:30:00.000Z", "Land the durable patch")
const rejectedPr = fixturePr("PR5", "rejected", "2026-07-13T10:45:00.000Z", "Reject broken payload")
const environmentPr = fixturePr("PR6", "submitted", "2026-07-13T10:50:00.000Z", "Retry stale environment")
const canceledPr = fixturePr("PR7", "canceled", "2026-07-13T10:55:00.000Z", "Cancel superseded run")

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

const longSubjectPr = fixturePr(
  "PR20",
  "integrated",
  "2026-07-13T11:00:00.000Z",
  "Preserve every timing column while this deliberately long subject truncates only inside the flexible subject cell",
)
const longSubjectRun = fixtureRun("R20", [longSubjectPr], "passed", "2026-07-13T11:05:00.000Z", {
  finishedAt: "2026-07-13T11:15:00.000Z",
})

const initialOutput: QueueArtifactOutput = {
  run: "R3",
  step: "check",
  attempt: 1,
  path: "/repo/.git/yrd/artifacts/R3/0-check/attempt-1/output.log",
  text: "checking one\n",
}

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
  idle: { snapshot: fixtureSnapshot(fixtureResult([], [])), widths: [100] },
  "pending-only": { snapshot: fixtureSnapshot(fixtureResult([pendingOne, pendingTwo], [])), widths: [100] },
  "running-spinner": {
    snapshot: fixtureSnapshot(fixtureResult([runningPr], [runningRun])),
    widths: [100],
    selectedStatus: "running",
  },
  "mixed-completed": { snapshot: fixtureSnapshot(mixedResult), widths: [120] },
  paused: { snapshot: fixtureSnapshot(pausedResult), widths: [100] },
  "honest-cap": { snapshot: fixtureSnapshot(mixedResult, { rowLimit: 2 }), widths: [100] },
  "non-default-filters": {
    snapshot: fixtureSnapshot(mixedResult, { statuses: ["rejected"], terms: ["typecheck"] }),
    widths: [110],
    selectedStatus: "rejected",
  },
  "latest-vs-all-lineage": {
    snapshot: fixtureSnapshot(lineageResult, { latest: true }),
    nextSnapshot: fixtureSnapshot(lineageResult),
    widths: [100],
  },
  "narrow-wide": { snapshot: fixtureSnapshot(mixedResult), widths: [80, 140] },
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
    snapshot: fixtureSnapshot(fixtureResult([rejectedPr], [rejectedRun])),
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
    widths: [80, 140],
    selectedStatus: "integrated",
  },
  "live-output-growth": {
    snapshot: fixtureSnapshot(fixtureResult([runningPr], [runningRun]), {}, [initialOutput]),
    nextSnapshot: fixtureSnapshot(fixtureResult([runningPr], [runningRun]), {}, [
      { ...initialOutput, text: "checking one\nchecking two\n" },
    ]),
    widths: [120],
    selectedStatus: "running",
    viewport: { columns: 200, rows: 50 },
  },
}
