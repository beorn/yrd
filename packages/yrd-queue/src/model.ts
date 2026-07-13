import { CompositionV1Schema, GitRefSchema, GitShaSchema, PRIdSchema, type PR } from "@yrd/bay"
import type { JsonValue } from "@yrd/core"
import { JobErrorSchema, type Job, type JobError } from "@yrd/job"
import * as z from "zod"

export type QueueRunId = string
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
    composition: CompositionV1Schema.optional(),
  })
  .strict()
export type PRSnapshot = Readonly<z.infer<typeof PRSnapshotSchema>>

export type SourceRewrite = Readonly<{
  repo: string
  branch: string
  oldBaseSha: string
  oldTipSha: string
  newBaseSha: string
  newTipSha: string
  candidateRef: string
  payload: readonly string[]
}>

export const SourceRewriteSchema = z
  .object({
    repo: z.string().min(1),
    branch: GitRefSchema,
    oldBaseSha: GitShaSchema,
    oldTipSha: GitShaSchema,
    newBaseSha: GitShaSchema,
    newTipSha: GitShaSchema,
    candidateRef: GitRefSchema,
    payload: z.array(z.string().min(1)).min(1),
  })
  .strict() as z.ZodType<SourceRewrite>

export type IntegrationProof = Readonly<{
  commit: string
  baseSha: string
  sourceRewrites?: readonly SourceRewrite[]
}>

export const IntegrationProofSchema = z
  .object({
    commit: GitShaSchema,
    // The base branch tip after integration, not the pre-integration base.
    baseSha: GitShaSchema,
    sourceRewrites: z.array(SourceRewriteSchema).optional(),
  })
  .strict() as z.ZodType<IntegrationProof>

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

export type QueueFailure = Readonly<{
  at: string
  error: JobError
}>

export type QueueRecord = Readonly<{
  id: QueueRunId
  prs: readonly PRSnapshot[]
  base: string
  steps: readonly InstalledStep[]
  initialIntegration?: IntegrationProof
  startedAt: string
  parent?: QueueRunId
  isolationPart?: 0 | 1
  failure?: QueueFailure
}>

export type QueueStep = InstalledStep & Readonly<{ job?: Job }>

export type QueueRun = Omit<QueueRecord, "initialIntegration" | "steps" | "failure"> &
  Readonly<{
    cursor: number
    integration?: IntegrationProof
    status: "running" | "waiting" | "passed" | "failed"
    steps: readonly QueueStep[]
    shape: PRShape | IntegratedShape
    finishedAt?: string
    error?: JobError
  }>

export type QueuePause = Readonly<{
  base: string
  reason: string
  allowedPRs: readonly string[]
  pausedAt: string
}>
export const QueuePauseSchema = z
  .object({
    base: GitRefSchema,
    reason: z.string().trim().min(1),
    allowedPRs: z.array(PRIdSchema),
    pausedAt: z.iso.datetime({ offset: true }),
  })
  .strict() as z.ZodType<QueuePause>

export type QueuesState = Readonly<{
  batchSize: number
  defaultSteps?: readonly StepName[]
  pauses: Readonly<Record<string, QueuePause>>
  records: Readonly<Record<QueueRunId, QueueRecord>>
}>

export type QueueSummary = Readonly<{
  base: string
  running: readonly QueueRun[]
  waiting: readonly QueueRun[]
  finished: readonly QueueRun[]
  pause?: QueuePause
}>

export type QueueAuditFinding = Readonly<{
  code: string
  message: string
  run?: QueueRunId
  pr?: string
  step?: StepName
}>

export type QueueAuditResult = Readonly<{ findings: readonly QueueAuditFinding[] }>

export const QueueRecordSchema = z
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

export const Queues = Object.freeze({
  empty(options: Readonly<{ batchSize: number; defaultSteps?: readonly StepName[] }>): QueuesState {
    return {
      batchSize: options.batchSize,
      ...(options.defaultSteps === undefined ? {} : { defaultSteps: options.defaultSteps }),
      pauses: {},
      records: {},
    }
  },

  record(state: QueuesState, id: QueueRunId): QueueRecord {
    const record = state.records[id]
    if (record === undefined) throw new Error(`yrd: no queue run '${id}'`)
    return record
  },

  nextId(state: QueuesState): QueueRunId {
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
      ...(pr.composition === undefined ? {} : { composition: pr.composition }),
    })
  },

  terminal(run: QueueRun): boolean {
    return run.status === "passed" || run.status === "failed"
  },
})
