import { changeDeliveryState, isTracked, type Change, type ChangeDeliveryState } from "@yrd/bay"
import type { Contest } from "@yrd/contest"
import type { Job } from "@yrd/job"
import type { ChangeCheckRecord, Run, QueueStep } from "@yrd/queue"

export type TaskStatus = "todo" | "wip" | "blocked" | "done" | "dropped"

const WORK_STATUS_GLYPHS = {
  // Exact width-one km work-state vocabulary. Yrd remains standalone (and
  // therefore cannot import the higher-level @km/tui package), so this leaf
  // mapping mirrors km/packages/km-tui/src/icons.ts::getStatusIcon verbatim.
  todo: "▢",
  wip: "▢",
  blocked: "⧗",
  done: "✓",
  dropped: "−",
} as const satisfies Record<TaskStatus, string>

const WORK_FOLD_GLYPHS = {
  collapsed: "▸",
  expanded: "•",
} as const

export type StatusGlyph = (typeof WORK_STATUS_GLYPHS)[TaskStatus]

/** The stored/emitted task-status envelope carries only the status word;
 * the glyph is presentation and derives at render via {@link taskStatusGlyph}
 * (5e cut 4 — glyph left the stored shape). */
export type TaskStatusFields = Readonly<{
  /** answers: How does this object map to the shared work-state vocabulary? tense: current. */
  taskStatus: TaskStatus
}>

export function taskStatusGlyph(taskStatus: TaskStatus): StatusGlyph {
  return WORK_STATUS_GLYPHS[taskStatus]
}

/** Exact width-one km tree disclosure vocabulary. */
export function taskFoldGlyph(expanded: boolean): (typeof WORK_FOLD_GLYPHS)[keyof typeof WORK_FOLD_GLYPHS] {
  return expanded ? WORK_FOLD_GLYPHS.expanded : WORK_FOLD_GLYPHS.collapsed
}

export function taskStatusFields(taskStatus: TaskStatus): TaskStatusFields {
  return { taskStatus }
}

export function changeTaskStatusOf(pr: Change): TaskStatus {
  return changeDeliveryTaskStatusOf(changeDeliveryState(pr))
}

export function changeDeliveryTaskStatusOf(delivery: ChangeDeliveryState | "needs-author"): TaskStatus {
  switch (delivery) {
    case "pushed":
      return "todo"
    case "submitted":
    case "ready":
      return "wip"
    case "needs-author":
    case "rejected":
      return "blocked"
    case "integrated":
    case "already-landed":
      return "done"
    case "withdrawn":
    case "canceled":
      return "dropped"
  }
}

type RunLifecycleStatus =
  | Run["status"]
  | "pending"
  | "queued"
  | "integrated"
  | "rejected"
  | "environment-refused"
  | "stale"
  | "lost"
  | "legacy"
  | "refused"
  | "retired"
  | "canceled"

export function runTaskStatusOf(
  run: Readonly<{ status: RunLifecycleStatus; conclusion?: Run["conclusion"] }>,
): TaskStatus {
  switch (run.status) {
    case "pending":
    case "queued":
      return "todo"
    case "in_progress":
    case "waiting":
      return "wip"
    case "rejected":
    case "environment-refused":
    case "stale":
    case "lost":
    case "legacy":
    case "refused":
      return "blocked"
    case "completed":
      if (run.conclusion === "success") return "done"
      if (run.conclusion === "cancelled" || run.conclusion === "skipped") return "dropped"
      return "blocked"
    case "integrated":
      return "done"
    case "retired":
    case "canceled":
      return "dropped"
  }
}

type AttemptOutcome = "passed" | "failed" | "lost" | "superseded"
type JobAttempt = Job | Readonly<{ status: "started" | "superseded" }> | Readonly<{ outcome: AttemptOutcome }>

export function jobAttemptTaskStatusOf(attempt: JobAttempt): TaskStatus {
  if ("outcome" in attempt) {
    if (attempt.outcome === "passed") return "done"
    if (attempt.outcome === "superseded") return "dropped"
    return "blocked"
  }
  switch (attempt.status) {
    case "queued":
      return "todo"
    case "in_progress":
    case "waiting":
    case "started":
      return "wip"
    case "completed":
      if (attempt.conclusion === "success") return "done"
      if (attempt.conclusion === "cancelled" || attempt.conclusion === "skipped") return "dropped"
      return "blocked"
    case "superseded":
      return "dropped"
  }
}

type StepLifecycleStatus = "pending" | "running" | "failed" | "passed" | "skipped"
type ProjectableStep = Pick<QueueStep, "job"> | Readonly<{ status: StepLifecycleStatus }>

export function stepTaskStatusOf(step: ProjectableStep): TaskStatus {
  if (!("status" in step)) return step.job === undefined ? "todo" : jobAttemptTaskStatusOf(step.job)
  switch (step.status) {
    case "pending":
      return "todo"
    case "running":
      return "wip"
    case "failed":
      return "blocked"
    case "passed":
      return "done"
    case "skipped":
      return "dropped"
  }
}

export function checkTaskStatusOf(check: Pick<ChangeCheckRecord, "status">): TaskStatus {
  switch (check.status) {
    case "not-requested":
    case "queued":
      return "todo"
    case "checking":
      return "wip"
    case "failed":
      return "blocked"
    case "passed":
      return "done"
  }
}

export function contestTaskStatusOf(contest: Pick<Contest, "status">): TaskStatus {
  switch (contest.status) {
    case "running":
    case "ready":
    case "selected":
    case "promoting":
      return "wip"
    case "failed":
    case "promotion-failed":
      return "blocked"
    case "promoted":
      return "done"
  }
}

/** The task status of one retained run member, from the outcome of its latest
 * run. This replaces `changeTaskStatusOf` for the issue lens: S7 deleted the
 * change record the old mapping read, and a member's run outcome is the same
 * question asked of the surviving evidence. A member with no finished run is
 * work in progress, never `todo` — compose has already picked it up. */
export function memberRunTaskStatusOf(outcome: string): TaskStatus {
  if (outcome === "success") return "done"
  if (outcome === "failure" || outcome === "cancelled" || outcome === "timed_out") return "blocked"
  return "wip"
}

export function issueTaskStatusOf(
  issue: Readonly<{
    /** One entry per retained run member joined to the issue. */
    deliveries: readonly TaskStatus[]
    contests: readonly Pick<Contest, "status">[]
  }>,
): TaskStatus {
  const children = [...issue.deliveries, ...issue.contests.map((contest) => contestTaskStatusOf(contest))]
  if (children.length === 0) return "todo"
  if (children.includes("blocked")) return "blocked"
  if (children.includes("wip")) return "wip"
  if (children.includes("todo")) return "todo"
  if (children.includes("done")) return "done"
  return "dropped"
}

export type ProjectedChange = Change &
  TaskStatusFields &
  Readonly<{
    /** answers: What delivery result should a reader act on? tense: current. */
    status: ChangeDeliveryState
  }>

export function projectChangeTaskStatus(pr: Change): ProjectedChange {
  // Readers get the EFFECTIVE tracking state: a record minted before tracking
  // became the default carries no bit yet behaves tracked, and the envelope
  // must not make watchers re-derive the accessor's fallback.
  return { ...pr, track: isTracked(pr), status: changeDeliveryState(pr), ...taskStatusFields(changeTaskStatusOf(pr)) }
}

export type ProjectedJob = Job & TaskStatusFields
export type ProjectedQueueStep = Omit<QueueStep, "job"> & TaskStatusFields & Readonly<{ job?: ProjectedJob }>
export type ProjectedQueueRun = Omit<Run, "steps"> &
  TaskStatusFields &
  Readonly<{ steps: readonly ProjectedQueueStep[] }>

export function projectQueueRunTaskStatus(run: Run): ProjectedQueueRun {
  return {
    ...run,
    ...taskStatusFields(runTaskStatusOf(run)),
    steps: run.steps.map(({ job, ...step }) => ({
      ...step,
      ...taskStatusFields(stepTaskStatusOf({ job })),
      ...(job === undefined ? {} : { job: { ...job, ...taskStatusFields(jobAttemptTaskStatusOf(job)) } }),
    })),
  }
}
