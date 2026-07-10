import type { Submission } from "@yrd/bay"
import type { EffectError, EffectRun } from "@yrd/core"

export type LineRunId = string
export type StepName = string
export type BatchConfig = false | number

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
  submissions: SubmissionSnapshot[]
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
  integrates: boolean
  needsIntegration: boolean
}

export type LineRecord = {
  id: LineRunId
  submission: SubmissionSnapshot
  submissions: SubmissionSnapshot[]
  base: string
  selected: StepName[]
  cursor: number
  effectIds: string[]
  integration?: IntegrationProof
  startedAt: string
  parent?: LineRunId
  isolationPart?: 0 | 1
}

type StepTrace = Pick<EffectRun, "token" | "url" | "detail" | "artifacts" | "checkpoint"> & {
  effectId: string
  attempt: number
  startedAt: string
  finishedAt: string
  output: unknown
  error: EffectError
}
type TraceKey = keyof StepTrace
type Without<Key extends TraceKey = TraceKey> = { [Field in Key]?: never }
type Started = Pick<StepTrace, "effectId" | "attempt" | "startedAt">
type Remote = Pick<StepTrace, "token" | "url" | "detail" | "artifacts" | "checkpoint">

export type StepEvidence = { name: StepName; index: number } & Partial<StepTrace> &
  (
    | (Without & { status: "queued" })
    | ({ status: "requested"; effectId: string } & Without<Exclude<TraceKey, "effectId">>)
    | (Started &
        Without<"finishedAt" | "token" | "url" | "detail" | "artifacts" | "checkpoint" | "output" | "error"> & {
          status: "running"
        })
    | (Started & Remote & Without<"finishedAt" | "output" | "error"> & { status: "waiting"; token: string })
    | (Started & Remote & { status: "passed"; finishedAt: string; output: unknown; error?: never })
    | (Started &
        Remote & {
          status: "failed" | "lost"
          finishedAt: string
          output?: unknown
          error: EffectError
        })
  )

export type LineRun = LineRecord & {
  status: "running" | "waiting" | "passed" | "failed"
  steps: StepEvidence[]
  shape: SubmissionShape | IntegratedShape
  finishedAt?: string
  error?: EffectError
}

export type LinesState = {
  batchSize: number
  defaultSteps?: StepName[]
  installed: Record<StepName, InstalledStep>
  records: Record<LineRunId, LineRecord>
  runs: Record<LineRunId, LineRun>
}

export type LineSummary = { base: string } & Record<"running" | "waiting" | "finished", LineRun[]>

export const Lines = {
  empty: (): LinesState => ({ batchSize: 1, installed: {}, records: {}, runs: {} }),

  require: (state: LinesState, id: LineRunId): LineRun => state.runs[id] ?? missing(id),
  record: (state: LinesState, id: LineRunId): LineRecord => state.records[id] ?? missing(id),
  nextId: (state: LinesState): LineRunId => `R${Object.keys(state.records).length + 1}`,

  running: (state: LinesState, base: string, except?: LineRunId): LineRun | undefined =>
    Object.values(state.runs).find((run) => run.id !== except && run.base === base && run.status === "running"),

  child: (state: LinesState, parent: LineRunId, part: 0 | 1): LineRun | undefined =>
    Object.values(state.runs).find((run) => run.parent === parent && run.isolationPart === part),

  ordered: (state: LinesState): LineRun[] => Object.values(state.runs).sort(runOrder),

  tree(state: LinesState, root: LineRunId): LineRun[] {
    const result: LineRun[] = []
    const visit = (id: LineRunId): void => {
      const run = state.runs[id]
      if (run === undefined) return
      result.push(run)
      for (const child of Lines.ordered(state).filter((candidate) => candidate.parent === id)) {
        visit(child.id)
      }
    }
    visit(root)
    return result
  },

  terminal: (run: LineRun): boolean => run.status === "passed" || run.status === "failed",

  summary(state: LinesState, base: string): LineSummary {
    const runs = Object.values(state.runs).filter((run) => run.base === base)
    return {
      base,
      running: runs.filter((run) => run.status === "running"),
      waiting: runs.filter((run) => run.status === "waiting"),
      finished: runs.filter(Lines.terminal),
    }
  },
}

function missing(id: LineRunId): never {
  throw new Error(`yrd: no line run '${id}'`)
}

function runOrder(left: LineRun, right: LineRun): number {
  return left.id.localeCompare(right.id, undefined, { numeric: true })
}
