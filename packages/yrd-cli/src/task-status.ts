import { prDeliveryState, type PR, type PRDeliveryState } from "@yrd/bay"
import type { Contest } from "@yrd/contest"
import type { Job } from "@yrd/job"
import type { PRCheckRecord, Run, QueueStep } from "@yrd/queue"

export type TaskStatus = "todo" | "wip" | "blocked" | "done" | "dropped"

const TASK_STATUS_GLYPHS = {
  // Exact width-one km task-state vocabulary. Yrd remains standalone (and
  // therefore cannot import the higher-level @km/tui package), so this leaf
  // mapping mirrors km/packages/km-tui/src/icons.ts::getStatusIcon verbatim.
  todo: "▢",
  wip: "▢",
  blocked: "⧗",
  done: "✓",
  dropped: "−",
} as const satisfies Record<TaskStatus, string>

const TASK_FOLD_GLYPHS = {
  collapsed: "▸",
  expanded: "•",
} as const

export type StatusGlyph = (typeof TASK_STATUS_GLYPHS)[TaskStatus]

export type TaskStatusFields = Readonly<{
  taskStatus: TaskStatus
  glyph: StatusGlyph
}>

export function taskStatusGlyph(taskStatus: TaskStatus): StatusGlyph {
  return TASK_STATUS_GLYPHS[taskStatus]
}

/** Exact width-one km tree disclosure vocabulary. */
export function taskFoldGlyph(expanded: boolean): (typeof TASK_FOLD_GLYPHS)[keyof typeof TASK_FOLD_GLYPHS] {
  return expanded ? TASK_FOLD_GLYPHS.expanded : TASK_FOLD_GLYPHS.collapsed
}

export function taskStatusFields(taskStatus: TaskStatus): TaskStatusFields {
  return { taskStatus, glyph: taskStatusGlyph(taskStatus) }
}

export function prTaskStatusOf(pr: PR): TaskStatus {
  return prDeliveryTaskStatusOf(prDeliveryState(pr))
}

export function prDeliveryTaskStatusOf(delivery: PRDeliveryState): TaskStatus {
  switch (delivery) {
    case "pushed":
      return "todo"
    case "submitted":
      return "wip"
    case "rejected":
      return "blocked"
    case "integrated":
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

export function checkTaskStatusOf(check: Pick<PRCheckRecord, "status">): TaskStatus {
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

export function issueTaskStatusOf(
  issue: Readonly<{
    prs: readonly PR[]
    contests: readonly Pick<Contest, "status">[]
  }>,
): TaskStatus {
  const children = [
    ...issue.prs.map((pr) => prTaskStatusOf(pr)),
    ...issue.contests.map((contest) => contestTaskStatusOf(contest)),
  ]
  if (children.length === 0) return "todo"
  if (children.includes("blocked")) return "blocked"
  if (children.includes("wip")) return "wip"
  if (children.includes("todo")) return "todo"
  if (children.includes("done")) return "done"
  return "dropped"
}

export type ProjectedPR = PR & TaskStatusFields

export function projectPRTaskStatus(pr: PR): ProjectedPR {
  return { ...pr, ...taskStatusFields(prTaskStatusOf(pr)) }
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
