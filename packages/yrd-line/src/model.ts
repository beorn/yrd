import { GitRefSchema, GitShaSchema, PRIdSchema, type PR } from "@yrd/bay"
import type { JsonValue } from "@yrd/core"
import { JobErrorSchema, type Job, type JobError } from "@yrd/job"
import * as z from "zod"

export type LineRunId = string
export type StepName = string
export type BatchConfig = false | number

export const PRSnapshotSchema = z
  .object({
    id: PRIdSchema,
    bay: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    branch: GitRefSchema,
    base: GitRefSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    baseSha: GitShaSchema.optional(),
  })
  .strict()
export type PRSnapshot = Readonly<z.infer<typeof PRSnapshotSchema>>

export const IntegrationProofSchema = z
  .object({
    commit: GitShaSchema,
    // The base branch tip after integration, not the pre-integration base.
    baseSha: GitShaSchema,
  })
  .strict()
export type IntegrationProof = Readonly<z.infer<typeof IntegrationProofSchema>>

export type PRShape = Readonly<{
  results: Readonly<Record<string, JsonValue>>
}>

export type IntegratedShape = PRShape & Readonly<{ integration: IntegrationProof }>

export type AddStepResult<Shape extends PRShape, Name extends string, Output extends JsonValue> = Omit<
  Shape,
  "results"
> & {
  results: Shape["results"] & Readonly<Record<Name, Output>>
}

export type InstalledStep = Readonly<{
  name: StepName
  title: string
  revision: string
  integrates: boolean
  needsIntegration: boolean
}>

export type LineFailure = Readonly<{
  at: string
  error: JobError
}>

export type LineRecord = Readonly<{
  id: LineRunId
  prs: readonly PRSnapshot[]
  base: string
  steps: readonly InstalledStep[]
  initialIntegration?: IntegrationProof
  startedAt: string
  parent?: LineRunId
  isolationPart?: 0 | 1
  failure?: LineFailure
}>

export type LineStep = InstalledStep & Readonly<{ job?: Job }>

export type LineRun = Omit<LineRecord, "initialIntegration" | "steps" | "failure"> &
  Readonly<{
    cursor: number
    integration?: IntegrationProof
    status: "running" | "waiting" | "passed" | "failed"
    steps: readonly LineStep[]
    shape: PRShape | IntegratedShape
    finishedAt?: string
    error?: JobError
  }>

export type LineHold = Readonly<{
  base: string
  reason: string
  allowedPRs: readonly string[]
  heldAt: string
}>
export const LineHoldSchema = z
  .object({
    base: GitRefSchema,
    reason: z.string().trim().min(1),
    allowedPRs: z.array(PRIdSchema),
    heldAt: z.iso.datetime({ offset: true }),
  })
  .strict() as z.ZodType<LineHold>

export type LinesState = Readonly<{
  batchSize: number
  defaultSteps?: readonly StepName[]
  holds: Readonly<Record<string, LineHold>>
  records: Readonly<Record<LineRunId, LineRecord>>
}>

export type LineSummary = Readonly<{
  base: string
  running: readonly LineRun[]
  waiting: readonly LineRun[]
  finished: readonly LineRun[]
  hold?: LineHold
}>

export type LineAuditFinding = Readonly<{
  code: string
  message: string
  run?: LineRunId
  pr?: string
  step?: StepName
}>

export type LineAuditResult = Readonly<{ findings: readonly LineAuditFinding[] }>

export const LineRecordSchema = z
  .object({
    id: z.string().trim().min(1),
    prs: z.array(PRSnapshotSchema).min(1),
    base: GitRefSchema,
    steps: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_-]*$/iu),
            title: z.string().trim().min(1),
            revision: z.string().trim().min(1),
            integrates: z.boolean(),
            needsIntegration: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    initialIntegration: IntegrationProofSchema.optional(),
    startedAt: z.iso.datetime({ offset: true }),
    parent: z.string().trim().min(1).optional(),
    isolationPart: z.union([z.literal(0), z.literal(1)]).optional(),
    failure: z
      .object({ at: z.iso.datetime({ offset: true }), error: JobErrorSchema })
      .strict()
      .optional(),
  })
  .strict()

export const Lines = Object.freeze({
  empty(options: Readonly<{ batchSize: number; defaultSteps?: readonly StepName[] }>): LinesState {
    return {
      batchSize: options.batchSize,
      ...(options.defaultSteps === undefined ? {} : { defaultSteps: options.defaultSteps }),
      holds: {},
      records: {},
    }
  },

  record(state: LinesState, id: LineRunId): LineRecord {
    const record = state.records[id]
    if (record === undefined) throw new Error(`yrd: no line run '${id}'`)
    return record
  },

  nextId(state: LinesState): LineRunId {
    const values = Object.keys(state.records)
      .filter((id) => /^R\d+$/u.test(id))
      .map((id) => Number(id.slice(1)))
    return `R${Math.max(0, ...values) + 1}`
  },

  snapshot(pr: PR): PRSnapshot {
    return PRSnapshotSchema.parse({
      id: pr.id,
      ...(pr.bay === undefined ? {} : { bay: pr.bay }),
      ...(pr.name === undefined ? {} : { name: pr.name }),
      branch: pr.branch,
      base: pr.base,
      revision: pr.revision,
      headSha: pr.headSha,
      ...(pr.baseSha === undefined ? {} : { baseSha: pr.baseSha }),
    })
  },

  terminal(run: LineRun): boolean {
    return run.status === "passed" || run.status === "failed"
  },
})
