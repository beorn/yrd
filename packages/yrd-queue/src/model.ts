import {
  CompositionV1Schema,
  CorrelationSchema,
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
  PRRecutProofSchema,
  type PRTerminalAssociation,
  baseIdentity,
  checkRequest,
  type PR,
} from "@yrd/bay"
import { JsonSchema, resolveSelector, type JsonValue } from "@yrd/core"
import { JobErrorSchema, type Job, type JobError } from "@yrd/job"
import * as z from "zod"
import {
  projectionLookupGet,
  projectionLookupSet,
  projectionLookupValues,
  type QueueProjectionLookup,
} from "./projection-lookup.ts"
export type {
  QueueProjectionLookup,
  QueueProjectionLookupEntry,
  QueueProjectionLookupNode,
} from "./projection-lookup.ts"

export type QueueRunId = string
export type StepName = string
export type BatchConfig = false | number
export type QueueRequirement = "review"

const PRSnapshotRecutProofSchema = PRRecutProofSchema.extend({
  /** Immutable base certified by this recut revision. Optional only for replaying legacy queue records. */
  baseSha: GitShaSchema.optional(),
}).strict()

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
    correlation: CorrelationSchema.optional(),
    composition: CompositionV1Schema.optional(),
    recut: PRSnapshotRecutProofSchema.optional(),
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
  patchId: string
  rangeDiff: "="
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
    patchId: GitShaSchema,
    rangeDiff: z.literal("="),
    payload: z.array(z.string().min(1)).min(1),
  })
  .strict() as z.ZodType<SourceRewrite>

export type QueueSubmoduleResolutionEvidence =
  | Readonly<{
      kind: "pin"
      path: string
      sha: string
    }>
  | Readonly<{
      kind: "compose"
      path: string
      sha: string
      ref: string
      reviewedBlobs: readonly Readonly<{
        path: string
        oid: string
        content: string
      }>[]
    }>

export const QueueSubmoduleResolutionEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pin"),
      path: z.string().min(1),
      sha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
    })
    .strict(),
  z
    .object({
      kind: z.literal("compose"),
      path: z.string().min(1),
      sha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
      ref: z.string().min(1),
      reviewedBlobs: z.array(
        z
          .object({
            path: z.string().min(1),
            oid: z.string().regex(/^[0-9a-f]{40,64}$/iu),
            content: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
]) as z.ZodType<QueueSubmoduleResolutionEvidence>

export type IntegrationProof = Readonly<{
  commit: string
  baseSha: string
  sourceRewrites?: readonly SourceRewrite[]
  submoduleResolutions?: readonly QueueSubmoduleResolutionEvidence[]
}>

export const IntegrationProofSchema = z
  .object({
    commit: GitShaSchema,
    // The base branch tip after integration, not the pre-integration base.
    baseSha: GitShaSchema,
    sourceRewrites: z.array(SourceRewriteSchema).optional(),
    submoduleResolutions: z.array(QueueSubmoduleResolutionEvidenceSchema).min(1).optional(),
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
  classification?: "base" | "carrier"
}>

export type SkippedStep = InstalledStep &
  Readonly<{
    index: number
    status: "skipped"
    reason: "not-selected"
  }>

type StepSelectionBase = Readonly<{
  authority: "configured" | "explicit" | "admission"
  steps: readonly StepName[]
}>

export type StepSelection =
  | (StepSelectionBase & Readonly<{ omittedSteps?: readonly SkippedStep[] }>)
  | (StepSelectionBase & Readonly<{ omittedChecks: readonly StepName[] }>)

export type QueueFailure = Readonly<{
  at: string
  error: JobError
}>

export type QueueAuthorityToken = Readonly<{
  pr: string
  revision: number
  headSha: string
  consumedBy?: QueueRunId
}>

export type QueueRunAuthority = Readonly<{
  inheritedFrom?: QueueRunId
  missingSubmits: readonly string[]
  missingChecks: readonly string[]
  released?: Readonly<{
    reason: "queue-environment-refused" | "job-lost" | "run-canceled" | "stale-base" | "stale-check"
    ref: string
  }>
}>

export type QueueUnassociatedTerminal = Readonly<{
  event: string
  at: string
  pr: string
  revision: number
  headSha?: string
}>

export type QueueTerminalAssociation = PRTerminalAssociation

export type QueueTerminalAssociations = Readonly<{
  pending: Readonly<Record<string, QueueUnassociatedTerminal>>
  applied: Readonly<Record<string, QueueTerminalAssociation>>
}>

export type QueueAuthorityState = Readonly<{
  statuses: Readonly<Record<string, "pushed" | "submitted" | "rejected" | "withdrawn" | "integrated" | "canceled">>
  current: Readonly<Record<string, QueueAuthorityToken>>
  submits: Readonly<Record<string, QueueAuthorityToken>>
  checks: Readonly<Record<string, QueueAuthorityToken>>
  claims: Readonly<Record<string, QueueAuthorityToken>>
  runs: QueueProjectionLookup<QueueRunAuthority>
}>

export type QueueProjectionPlan = Readonly<{
  latestExact?: QueueRunId
  latestPrefix?: QueueRunId
  releasedAdmissionFailures?: number
}>

export type QueueProjectionIndex = Readonly<{
  version: 1
  nextRunNumber: number
  childByParentPart: QueueProjectionLookup<QueueRunId>
  plans: QueueProjectionLookup<QueueProjectionPlan>
}>

export type QueueRecord = Readonly<{
  id: QueueRunId
  /** New-run marker. Its absence identifies pre-settlement Queue journals. */
  settlement?: "explicit"
  prs: readonly PRSnapshot[]
  base: string
  steps: readonly InstalledStep[]
  stepSelection?: StepSelection
  initialIntegration?: IntegrationProof
  initialResults?: Readonly<Record<string, JsonValue>>
  reusedFrom?: QueueRunId
  startedAt: string
  parent?: QueueRunId
  isolationPart?: 0 | 1
  failure?: QueueFailure
  // Run-level cancellation (the `run cancel` surface): a run aborted before it lands,
  // but — unlike a failure — its member PRs are NOT rejected/canceled; they stay
  // submitted so a future drain re-queues them. Projection-only; no started run
  // carries these, so QueueRecordSchema stays unchanged.
  canceledAt?: string
  canceledBy?: string
  cancelReason?: string
}>

export type QueueStep = InstalledStep & Readonly<{ job?: Job }>

export type QueueRun = Omit<QueueRecord, "initialIntegration" | "initialResults" | "steps" | "failure"> &
  Readonly<{
    cursor: number
    integration?: IntegrationProof
    status: "running" | "waiting" | "passed" | "failed" | "canceled"
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
  requires: readonly QueueRequirement[]
  pauses: Readonly<Record<string, QueuePause>>
  records: QueueProjectionLookup<QueueRecord>
  index: QueueProjectionIndex
  authority: QueueAuthorityState
  terminalAssociations: QueueTerminalAssociations
  retention: Readonly<{ terminalOrder: Readonly<Record<QueueRunId, number>> }>
}>

export type PREligibilityReason = Readonly<{
  code:
    | "draft"
    | "checks-pending"
    | "checks-failed"
    | "needs-author"
    | "review-required"
    | "review-rejected"
    | "queue-paused"
    | "claimed"
    | "checking"
    | "rejected"
    | "terminal"
  message: string
  /** The composition-refusal receipt that produced a `needs-author` verdict:
   * the queue could not compose the candidate from what the author submitted,
   * so the refusal is projected here (never as a stored status) for the author
   * to act on. Absent for every other reason code. */
  receipt?: JobError
}>

export type PREligibility = Readonly<{
  pr: string
  revision: number
  runnable: boolean
  reason?: PREligibilityReason
  review: Readonly<{
    required: boolean
    approved: boolean
    stale: boolean
    decision?: "approve" | "reject"
    actor?: string
    ref?: string
  }>
  checks: Readonly<{
    status: "not-requested" | "queued" | "checking" | "passed" | "failed"
    queuedAt?: string
    position?: number
    run?: QueueRunId
  }>
}>

export type PRCheckRecord = Readonly<{
  pr: string
  revision: number
  status: PREligibility["checks"]["status"]
  run?: QueueRunId
  step?: StepName
  classification?: "base" | "carrier"
  queuedAt?: string
  position?: number
  command?: readonly string[]
  diagnostics?: JsonValue
  artifact?: string
  error?: JobError
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

export const InstalledStepSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/iu),
    title: z.string().trim().min(1),
    revision: z.string().trim().min(1),
    integrates: z.boolean(),
    needsIntegration: z.boolean(),
    classification: z.enum(["base", "carrier"]).optional(),
  })
  .strict()

const SkippedStepSchema = InstalledStepSchema.extend({
  index: z.number().int().nonnegative(),
  status: z.literal("skipped"),
  reason: z.literal("not-selected"),
}).strict()

const StepSelectionSchema = z
  .object({
    authority: z.enum(["configured", "explicit", "admission"]),
    steps: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/iu)).min(1),
    omittedSteps: z.array(SkippedStepSchema).min(1).optional(),
  })
  .strict()
  .superRefine((selection, context) => {
    const omitted = selection.omittedSteps ?? []
    const selectedNames = new Set(selection.steps)
    const omittedNames = new Set<string>()
    const omittedIndexes = new Set<number>()
    const planLength = selection.steps.length + omitted.length
    for (const step of omitted) {
      if (selectedNames.has(step.name) || omittedNames.has(step.name)) {
        context.addIssue({ code: "custom", message: `duplicate step-selection evidence for '${step.name}'` })
      }
      if (step.index >= planLength || omittedIndexes.has(step.index)) {
        context.addIssue({ code: "custom", message: `invalid omitted-step index ${step.index}` })
      }
      omittedNames.add(step.name)
      omittedIndexes.add(step.index)
    }
  })

const LegacyStepSelectionSchema = z
  .object({
    authority: z.enum(["configured", "explicit", "admission"]),
    steps: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/iu)).min(1),
    omittedChecks: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/iu)).min(1),
  })
  .strict()

const queueRecordShape = {
  id: z.string().trim().min(1),
  prs: z.array(PRSnapshotSchema).min(1),
  base: GitRefSchema,
  steps: z.array(InstalledStepSchema).min(1),
  initialIntegration: IntegrationProofSchema.optional(),
  initialResults: z.record(z.string(), JsonSchema).optional(),
  reusedFrom: z.string().trim().min(1).optional(),
  startedAt: z.iso.datetime({ offset: true }),
  parent: z.string().trim().min(1).optional(),
  isolationPart: z.union([z.literal(0), z.literal(1)]).optional(),
  failure: z
    .object({ at: z.iso.datetime({ offset: true }), error: JobErrorSchema })
    .strict()
    .optional(),
}

export const QueueRecordSchema = z
  .object({ ...queueRecordShape, settlement: z.literal("explicit"), stepSelection: StepSelectionSchema.optional() })
  .strict()

export const ReplayQueueRecordSchema = z
  .object({
    ...queueRecordShape,
    settlement: z.literal("explicit").optional(),
    stepSelection: z.union([StepSelectionSchema, LegacyStepSelectionSchema]).optional(),
  })
  .strict()

function resolveQueueRecord(state: QueuesState, id: QueueRunId): QueueRecord | undefined {
  const direct = projectionLookupGet(state.records, id)
  if (direct !== undefined) return direct
  return resolveSelector(
    id,
    queueRecordValues(state).map((record) => ({ canonical: record.id, value: record })),
    { kind: "queue run" },
  )
}

function compareQueueRunIds(left: QueueRunId, right: QueueRunId): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

function queueRecordValues(state: QueuesState): readonly QueueRecord[] {
  return projectionLookupValues(state.records).toSorted((left, right) => compareQueueRunIds(left.id, right.id))
}

export const Queues = Object.freeze({
  empty(
    options: Readonly<{
      batchSize: number
      defaultSteps?: readonly StepName[]
      requires?: readonly QueueRequirement[]
    }>,
  ): QueuesState {
    return {
      batchSize: options.batchSize,
      ...(options.defaultSteps === undefined ? {} : { defaultSteps: options.defaultSteps }),
      requires: options.requires ?? [],
      pauses: {},
      records: {},
      index: {
        version: 1,
        nextRunNumber: 1,
        childByParentPart: {},
        plans: {},
      },
      authority: { statuses: {}, current: {}, submits: {}, checks: {}, claims: {}, runs: {} },
      terminalAssociations: { pending: {}, applied: {} },
      retention: { terminalOrder: {} },
    }
  },

  resolve(state: QueuesState, id: QueueRunId): QueueRecord | undefined {
    return resolveQueueRecord(state, id)
  },

  get(state: QueuesState, id: QueueRunId): QueueRecord | undefined {
    return projectionLookupGet(state.records, id)
  },

  values(state: QueuesState): readonly QueueRecord[] {
    return queueRecordValues(state)
  },

  ids(state: QueuesState): readonly QueueRunId[] {
    return queueRecordValues(state).map((record) => record.id)
  },

  authorityRun(authority: QueueAuthorityState, id: QueueRunId): QueueRunAuthority | undefined {
    return projectionLookupGet(authority.runs, id)
  },

  set(
    records: Readonly<QueueProjectionLookup<QueueRecord>>,
    record: Readonly<QueueRecord>,
  ): QueueProjectionLookup<QueueRecord> {
    return projectionLookupSet(records, record.id, record)
  },

  record(state: QueuesState, id: QueueRunId): QueueRecord {
    const record = resolveQueueRecord(state, id)
    if (record === undefined) throw new Error(`yrd: no queue run '${id}'`)
    return record
  },

  nextId(state: QueuesState): QueueRunId {
    return `R${state.index.nextRunNumber}`
  },

  snapshot(pr: PR): PRSnapshot {
    const baseSha = checkRequest(pr)?.baseSha ?? pr.baseSha
    return PRSnapshotSchema.parse({
      id: pr.id,
      ...(pr.bay === undefined ? {} : { bay: pr.bay }),
      ...(pr.name === undefined ? {} : { name: pr.name }),
      branch: pr.branch,
      base: baseIdentity(pr.base),
      revision: pr.revision,
      headSha: pr.headSha,
      ...(baseSha === undefined ? {} : { baseSha }),
      ...(pr.correlation === undefined ? {} : { correlation: pr.correlation }),
      ...(pr.composition === undefined ? {} : { composition: pr.composition }),
      ...(pr.recut === undefined
        ? {}
        : { recut: { ...pr.recut, ...(pr.baseSha === undefined ? {} : { baseSha: pr.baseSha }) } }),
    })
  },

  terminal(run: QueueRun): boolean {
    return run.status === "passed" || run.status === "failed" || run.status === "canceled"
  },
})
