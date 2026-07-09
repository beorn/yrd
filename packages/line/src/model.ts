import type { Submission } from "@yrd/bay"
import type { EffectError } from "@yrd/core"

export type LineRunId = string
export type StepName = string

export type SubmissionSnapshot = Pick<
  Submission,
  "id" | "bay" | "name" | "branch" | "base" | "revision" | "headSha" | "baseSha"
>

export type IntegrationProof = {
  commit: string
  baseSha: string
}

export type SubmissionShape = {
  submission: SubmissionSnapshot
  results: Record<string, unknown>
}

export type IntegratedShape = SubmissionShape & {
  integration: IntegrationProof
}

export type AddStepResult<Shape extends SubmissionShape, Name extends string, Output> = Omit<Shape, "results"> & {
  results: Shape["results"] & Record<Name, Output>
}

export type InstalledStep = {
  name: StepName
  title: string
  index: number
  kind: "step" | "merge"
  needsIntegration: boolean
}

export type StepEvidence = {
  name: StepName
  index: number
  status: "queued" | "requested" | "running" | "waiting" | "passed" | "failed" | "lost"
  effectId?: string
  attempt?: number
  startedAt?: string
  finishedAt?: string
  token?: string
  url?: string
  detail?: string
  artifacts?: readonly unknown[]
  output?: unknown
  error?: EffectError
}

export type LineRun = {
  id: LineRunId
  submission: SubmissionSnapshot
  base: string
  status: "running" | "waiting" | "passed" | "failed"
  selected: StepName[]
  cursor: number
  steps: StepEvidence[]
  shape: SubmissionShape | IntegratedShape
  startedAt: string
  finishedAt?: string
  error?: EffectError
}

export type LinesState = {
  installed: Record<StepName, InstalledStep>
  runs: Record<LineRunId, LineRun>
}

export type LineSummary = {
  base: string
  running: LineRun[]
  waiting: LineRun[]
  finished: LineRun[]
}

export function emptyLinesState(): LinesState {
  return { installed: {}, runs: {} }
}

export function lineSummary(state: LinesState, base: string): LineSummary {
  const runs = Object.values(state.runs).filter((run) => run.base === base)
  return {
    base,
    running: runs.filter((run) => run.status === "running"),
    waiting: runs.filter((run) => run.status === "waiting"),
    finished: runs.filter((run) => run.status === "passed" || run.status === "failed"),
  }
}
