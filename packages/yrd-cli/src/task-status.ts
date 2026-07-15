import type { PR } from "@yrd/bay"
import type { Contest } from "@yrd/contest"
import type { Job } from "@yrd/job"
import type { PRCheckRecord, QueueRun, QueueStep } from "@yrd/queue"

export type TaskStatus = "todo" | "wip" | "blocked" | "done" | "dropped"

const TASK_STATUS_GLYPHS = {
  todo: "[ ]",
  wip: "[/]",
  blocked: "[!]",
  done: "[x]",
  dropped: "[-]",
} as const satisfies Record<TaskStatus, string>

export type StatusGlyph = (typeof TASK_STATUS_GLYPHS)[TaskStatus]

export type TaskStatusFields = Readonly<{
  taskStatus: TaskStatus
  glyph: StatusGlyph
}>

export function taskStatusGlyph(taskStatus: TaskStatus): StatusGlyph {
  return TASK_STATUS_GLYPHS[taskStatus]
}

export function taskStatusFields(taskStatus: TaskStatus): TaskStatusFields {
  return { taskStatus, glyph: taskStatusGlyph(taskStatus) }
}

export function prTaskStatusOf(pr: Pick<PR, "status">): TaskStatus {
  switch (pr.status) {
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
  | QueueRun["status"]
  | "pending"
  | "queued"
  | "integrated"
  | "rejected"
  | "environment-refused"
  | "retired"
  | "canceled"

export function runTaskStatusOf(run: Readonly<{ status: RunLifecycleStatus }>): TaskStatus {
  switch (run.status) {
    case "pending":
    case "queued":
      return "todo"
    case "running":
    case "waiting":
      return "wip"
    case "failed":
    case "rejected":
    case "environment-refused":
      return "blocked"
    case "passed":
    case "integrated":
      return "done"
    case "retired":
    case "canceled":
      return "dropped"
  }
}

type AttemptOutcome = "passed" | "failed" | "lost" | "superseded"
type JobAttempt =
  | Pick<Job, "status">
  | Readonly<{ status: "started" | "superseded" }>
  | Readonly<{ outcome: AttemptOutcome }>

export function jobAttemptTaskStatusOf(attempt: JobAttempt): TaskStatus {
  const status = "outcome" in attempt ? attempt.outcome : attempt.status
  switch (status) {
    case "requested":
      return "todo"
    case "running":
    case "waiting":
    case "started":
      return "wip"
    case "failed":
    case "lost":
      return "blocked"
    case "passed":
      return "done"
    case "superseded":
    case "canceled":
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
    prs: readonly Pick<PR, "status">[]
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
export type ProjectedQueueRun = Omit<QueueRun, "steps"> &
  TaskStatusFields &
  Readonly<{ steps: readonly ProjectedQueueStep[] }>

export function projectQueueRunTaskStatus(run: QueueRun): ProjectedQueueRun {
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
