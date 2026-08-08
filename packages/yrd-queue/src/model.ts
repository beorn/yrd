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
  prBaseSha,
  prComposition,
  prCorrelation,
  prHead,
  prRecut,
  prRevisionNumber,
  type PR,
  type PRId,
} from "@yrd/bay"
import { compareNatural, JsonSchema, resolveSelector, type JsonValue } from "@yrd/core"
import type { FlowPin, StepKind } from "@yrd/config"
import { JobErrorSchema, type Job, type JobError } from "@yrd/job"
import { PinIntentAuthoredSchema, PinIntentEvaluationSchema } from "@yrd/intent"
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

export type CandidateId = string
export type RunId = string
export type StepName = string
export type BatchConfig = false | number
export type QueueRequirement = "review"

const FlowPinSchema = z
  .object({
    name: z.string().trim().min(1),
    rev: z.string().trim().min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()

const PRSnapshotRecutProofSchema = PRRecutProofSchema.extend({
  /** Immutable base certified by this recut revision. Optional only for replaying legacy queue records. */
  baseSha: GitShaSchema.optional(),
}).strict()

const IntentMemberIdSchema = z.string().regex(/^I\d+$/u)
export const QueueMemberIdSchema = z.union([PRIdSchema, IntentMemberIdSchema])
export const QueueIntentSnapshotSchema = z
  .object({
    id: IntentMemberIdSchema,
    authored: PinIntentAuthoredSchema,
    evaluated: PinIntentEvaluationSchema,
  })
  .strict()
export type QueueIntentSnapshot = Readonly<z.infer<typeof QueueIntentSnapshotSchema>>

export const PRSnapshotSchema = z
  .object({
    id: QueueMemberIdSchema,
    bay: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    branch: GitRefSchema,
    base: GitRefSchema,
    issue: z.string().trim().min(1).optional(),
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    baseSha: GitShaSchema.optional(),
    correlation: CorrelationSchema.optional(),
    composition: CompositionV1Schema.optional(),
    recut: PRSnapshotRecutProofSchema.optional(),
    flow: FlowPinSchema.optional(),
    /** Present only for a carrier-free pin intent materialized by Queue. */
    intent: QueueIntentSnapshotSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.intent === undefined && !PRIdSchema.safeParse(snapshot.id).success) {
      context.addIssue({ code: "custom", path: ["id"], message: "a PR snapshot requires a PR id" })
    }
    if (snapshot.intent !== undefined && snapshot.id !== snapshot.intent.id) {
      context.addIssue({ code: "custom", path: ["intent", "id"], message: "intent member id must match snapshot id" })
    }
  })
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

export type CandidateRev = Readonly<{
  pr: string
  n: number
  head: string
}>

/** Immutable attempted integration. Its content identity is derived from the
 * queue/base plus ordered revision heads and their immutable compositions. */
export type Candidate = Readonly<{
  id: CandidateId
  queueId: string
  baseSha: string
  revs: readonly CandidateRev[]
  sha?: string
  treeSha?: string
  ref?: string
  sourceRewrites?: readonly SourceRewrite[]
  submoduleResolutions?: readonly QueueSubmoduleResolutionEvidence[]
  mergeability: "unknown" | "mergeable" | "conflicting"
  createdAt: string
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

export const CandidateSchema = z
  .object({
    id: z.string().regex(/^C\d+$/u),
    queueId: GitRefSchema,
    baseSha: GitShaSchema,
    revs: z
      .array(
        z
          .object({
            pr: QueueMemberIdSchema,
            n: z.number().int().positive(),
            head: GitShaSchema,
          })
          .strict(),
      )
      .min(1),
    sha: GitShaSchema.optional(),
    /** Tree checked for this Candidate; current facts always carry it. */
    treeSha: GitShaSchema.optional(),
    ref: GitRefSchema.optional(),
    sourceRewrites: z.array(SourceRewriteSchema).optional(),
    submoduleResolutions: z.array(QueueSubmoduleResolutionEvidenceSchema).min(1).optional(),
    mergeability: z.enum(["unknown", "mergeable", "conflicting"]),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict()

export type AlreadyLandedEvidence = Readonly<{
  candidateSha: string
  candidateTreeSha: string
  baseTreeSha: string
}>

export const AlreadyLandedEvidenceSchema = z
  .object({
    candidateSha: GitShaSchema,
    candidateTreeSha: GitShaSchema,
    baseTreeSha: GitShaSchema,
  })
  .strict()
  .refine(({ candidateTreeSha, baseTreeSha }) => candidateTreeSha === baseTreeSha, {
    message: "candidateTreeSha must equal baseTreeSha",
    path: ["candidateTreeSha"],
  }) as z.ZodType<AlreadyLandedEvidence>

export type ComponentMainReceipt = Readonly<{
  path: string
  origin: string
  pinSha: string
  mainBeforeSha: string
  mainAfterSha: string
  action: "verified" | "fast-forwarded"
}>

export const ComponentMainReceiptSchema = z
  .object({
    path: z.string().min(1),
    origin: z.string().min(1),
    pinSha: GitShaSchema,
    mainBeforeSha: GitShaSchema,
    mainAfterSha: GitShaSchema,
    action: z.enum(["verified", "fast-forwarded"]),
  })
  .strict() as z.ZodType<ComponentMainReceipt>

export type ComponentMainRefusal = Readonly<{
  path: string
  origin: string
  pinSha: string
  mainSha?: string
  code: string
  message: string
}>

export const ComponentMainRefusalSchema = z
  .object({
    path: z.string().min(1),
    origin: z.string().min(1),
    pinSha: GitShaSchema,
    mainSha: GitShaSchema.optional(),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict() as z.ZodType<ComponentMainRefusal>

export type ComponentMainOutcomes = Readonly<{
  kind: "component-main-outcomes"
  receipts: readonly ComponentMainReceipt[]
  refusals: readonly ComponentMainRefusal[]
}>

export const ComponentMainOutcomesSchema = z
  .object({
    kind: z.literal("component-main-outcomes"),
    receipts: z.array(ComponentMainReceiptSchema),
    refusals: z.array(ComponentMainRefusalSchema),
  })
  .strict() as z.ZodType<ComponentMainOutcomes>

export type IntegrationProof = Readonly<{
  commit: string
  baseSha: string
  alreadyLanded?: AlreadyLandedEvidence
  sourceRewrites?: readonly SourceRewrite[]
  submoduleResolutions?: readonly QueueSubmoduleResolutionEvidence[]
  componentMains?: readonly ComponentMainReceipt[]
}>

export const IntegrationProofSchema = z
  .object({
    commit: GitShaSchema,
    // The base branch tip after integration, not the pre-integration base.
    baseSha: GitShaSchema,
    alreadyLanded: AlreadyLandedEvidenceSchema.optional(),
    sourceRewrites: z.array(SourceRewriteSchema).optional(),
    submoduleResolutions: z.array(QueueSubmoduleResolutionEvidenceSchema).min(1).optional(),
    componentMains: z.array(ComponentMainReceiptSchema).min(1).optional(),
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
  kind: StepKind
  classification?: "base" | "carrier"
  /** Raw source identity captured for the in-process Yrd implementation. */
  implementationSource?: string
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
  /** Present when the Run failure was derived from a retryable Job attempt. */
  job?: Readonly<{ id: string; attempt: number }>
}>

export type QueueAuthorityToken = Readonly<{
  pr: string
  revision: number
  headSha: string
  consumedBy?: RunId
}>

export type RunAuthority = Readonly<{
  inheritedFrom?: RunId
  missingSubmits: readonly string[]
  missingChecks: readonly string[]
  released?: Readonly<{
    reason:
      | "queue-environment-refused"
      | "job-lost"
      | "run-canceled"
      | "stale-base"
      | "stale-check"
      | "stale-steps"
      | "stale-plan"
      | "orphaned-run"
      | "component-main-promotion-failed"
      | "component-main-inspection-failed"
      | "carrier-inspection"
      | "source-publish"
      | "scratch-cleanup-failed"
      | "wrapper-generation"
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
  statuses: Readonly<
    Record<
      string,
      | "pushed"
      | "submitted"
      | "ready"
      | "needs-author"
      | "rejected"
      | "withdrawn"
      | "integrated"
      | "already-landed"
      | "canceled"
    >
  >
  current: Readonly<Record<string, QueueAuthorityToken>>
  submits: Readonly<Record<string, QueueAuthorityToken>>
  checks: Readonly<Record<string, QueueAuthorityToken>>
  claims: Readonly<Record<string, QueueAuthorityToken>>
  runs: QueueProjectionLookup<RunAuthority>
}>

export type QueueProjectionPlan = Readonly<{
  latestExact?: RunId
  latestPrefix?: RunId
  releasedAdmissionFailures?: number
}>

export type QueueProjectionIndex = Readonly<{
  version: 1
  nextRunNumber: number
  childByParentPart: QueueProjectionLookup<RunId>
  rootsByMember: QueueProjectionLookup<RunId>
  plans: QueueProjectionLookup<QueueProjectionPlan>
}>

export type QueueRecord = Readonly<{
  id: RunId
  /** New-run marker. Its absence identifies pre-settlement Queue journals. */
  settlement?: "explicit"
  queueId: string
  candidateId: CandidateId
  /** Immutable execution receipt. Candidate owns the ordered revision identity;
   * projection rejects any receipt that diverges from it. */
  prs: readonly PRSnapshot[]
  /** Queue-target receipt; Candidate owns the exact base SHA. */
  base: string
  flow?: FlowPin
  steps: readonly InstalledStep[]
  stepSelection?: StepSelection
  initialIntegration?: IntegrationProof
  initialResults?: Readonly<Record<string, JsonValue>>
  reusedFrom?: RunId
  startedAt: string
  parent?: RunId
  isolationPart?: 0 | 1
  failure?: QueueFailure
  // Run-level cancellation (the `queue cancel` surface): a run aborted before it lands,
  // but — unlike a failure — its member PRs are NOT rejected/canceled; they stay
  // submitted so a future drain re-queues them. Projection-only; no started run
  // carries these, so QueueRecordSchema stays unchanged.
  canceledAt?: string
  canceledBy?: string
  cancelReason?: string
  // Record-level proof that the run reached `passed`. `failed` and `canceled`
  // already carry their terminal fact on the record (`failure`, `canceledAt`);
  // `passed` was derived from the step Jobs alone, so once Job retention pruned
  // a finished root's Jobs the run re-projected as `running` FOREVER (a phantom
  // `● run` row whose clock ticks up; live incident R1583, 45h). Stamped when
  // the run settles. Projection-only; no started run carries it, so
  // QueueRecordSchema stays unchanged.
  passedAt?: string
}>

export type QueueStep = InstalledStep & Readonly<{ job?: Job }>

export type RunStatus = "queued" | "in_progress" | "waiting" | "completed"
export type RunConclusion = "success" | "failure" | "cancelled" | "skipped" | "timed_out"

export type Run = Omit<QueueRecord, "initialIntegration" | "initialResults" | "steps" | "failure"> &
  Readonly<{
    cursor: number
    integration?: IntegrationProof
    status: RunStatus
    conclusion?: RunConclusion
    /** Durable Job identities in literal Flow order. */
    jobs: readonly string[]
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

/**
 * One PR's live streak of compose/admission refusals — every cycle that skipped
 * it WITHOUT producing a queue run. A refusal at admission never mints a run
 * record, so this ledger is the only durable trace of a head-of-line wedge (the
 * matching `compose-candidate-skip` warns are loggily-only and die with the
 * process). Reset when the PR is admitted, pushed, or recut.
 */
export type QueueAdmissionRefusal = Readonly<{
  pr: PRId
  /** Exact refused revision. Missing only while replaying pre-22528 journals. */
  revision?: number
  /** Exact refused head. Missing only while replaying pre-22528 journals. */
  headSha?: string
  /** The refusal code of the most recent skip in this streak. */
  code: string
  /** The failure-fact kind of the most recent skip, when it carried one. */
  kind?: string
  /** The refusal message of the most recent skip. */
  reason: string
  /** Consecutive refusals since the last admission / push / recut. */
  count: number
  /** Consecutive refusals carrying the current exact `code`. Unlike `count`,
   * this resets when the typed cause changes. */
  sameCodeCount?: number
  /** Journal timestamp of the first refusal in this streak. */
  firstAt: string
  /** Journal timestamp of the first refusal in the current exact-code streak. */
  sameCodeFirstAt?: string
  /** Journal timestamp of the most recent refusal in this streak. */
  lastAt: string
  /** Durable terminal disposition for this exact revision. A new push/recut
   * clears the whole refusal entry and therefore re-arms admission. */
  settlement?: Readonly<{
    disposition: "needs-person"
    reason: string
    settledAt: string
  }>
}>

export type QueuesState = Readonly<{
  batchSize: number
  defaultSteps?: readonly StepName[]
  requires: readonly QueueRequirement[]
  pauses: Readonly<Record<string, QueuePause>>
  candidates: Readonly<Record<CandidateId, Candidate>>
  records: QueueProjectionLookup<QueueRecord>
  index: QueueProjectionIndex
  authority: QueueAuthorityState
  terminalAssociations: QueueTerminalAssociations
  admissionRefusals: Readonly<Record<PRId, QueueAdmissionRefusal>>
  retention: Readonly<{ terminalOrder: Readonly<Record<RunId, number>> }>
}>

export type PREligibilityReason = Readonly<{
  code:
    | "draft"
    | "checks-pending"
    | "admission-refused"
    | "required-check-failed"
    | "needs-author"
    | "candidate-conflicting"
    | "review-required"
    | "review-rejected"
    | "queue-paused"
    | "claimed"
    | "checking"
    | "rejected"
    | "terminal"
  message: string
  /** The attributed failure receipt carried by native `pr/needs-author` (or
   * recovered from a legacy rejected journal) for the author to act on. Absent
   * for every other reason code. */
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
    by?: string
    ref?: string
  }>
  checks: Readonly<{
    status: "not-requested" | "queued" | "checking" | "passed" | "failed"
    queuedAt?: string
    position?: number
    run?: RunId
  }>
}>

export type PRCheckRecord = Readonly<{
  pr: string
  revision: number
  status: PREligibility["checks"]["status"]
  run?: RunId
  job?: string
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
  running: readonly Run[]
  waiting: readonly Run[]
  finished: readonly Run[]
  pause?: QueuePause
}>

export type QueueAuditFinding = Readonly<{
  code: string
  message: string
  /** Exact operator steps for this observed finding. Presentation preserves
   * these as structured resolutions instead of re-deriving them from prose. */
  resolution?: readonly string[]
  run?: RunId
  pr?: string
  /** Stable affected specimen. Page adapters dedupe on this, never a runner PID. */
  specimen?: string
  step?: StepName
  /** The upstream refusal code behind the finding; `code` names the finding class. */
  refusal?: string
  /** Consecutive occurrences behind the finding. */
  count?: number
  /** ISO timestamp of the first occurrence in the current streak. */
  since?: string
  /** Observed block span — last occurrence minus first, in milliseconds. */
  blockedMs?: number
}>

export type QueueAuditResult = Readonly<{ findings: readonly QueueAuditFinding[] }>

export const InstalledStepSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/iu),
    title: z.string().trim().min(1),
    revision: z.string().trim().min(1),
    kind: z.enum(["check", "action", "merge"]),
    classification: z.enum(["base", "carrier"]).optional(),
    implementationSource: z
      .string()
      .regex(/^(?:dirty|git):[0-9a-f]{40,64}$/u)
      .optional(),
  })
  .strict()

export const ReplayInstalledStepSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || !("integrates" in value)) return value
  const legacy = value as Readonly<{
    name?: unknown
    title?: unknown
    revision?: unknown
    integrates?: unknown
    needsIntegration?: unknown
    classification?: unknown
    implementationSource?: unknown
  }>
  return {
    name: legacy.name,
    title: legacy.title,
    revision: legacy.revision,
    kind: legacy.integrates === true ? "merge" : legacy.needsIntegration === true ? "action" : "check",
    ...(legacy.classification === undefined ? {} : { classification: legacy.classification }),
    ...(legacy.implementationSource === undefined ? {} : { implementationSource: legacy.implementationSource }),
  }
}, InstalledStepSchema)

const SkippedStepSchema = InstalledStepSchema.extend({
  index: z.number().int().nonnegative(),
  status: z.literal("skipped"),
  reason: z.literal("not-selected"),
}).strict()

const ReplaySkippedStepSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || !("integrates" in value)) return value
  const legacy = value as Readonly<Record<string, unknown>>
  return {
    name: legacy.name,
    title: legacy.title,
    revision: legacy.revision,
    kind: legacy.integrates === true ? "merge" : legacy.needsIntegration === true ? "action" : "check",
    ...(legacy.classification === undefined ? {} : { classification: legacy.classification }),
    index: legacy.index,
    status: legacy.status,
    reason: legacy.reason,
  }
}, SkippedStepSchema)

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

const ReplayStepSelectionSchema = z
  .object({
    authority: z.enum(["configured", "explicit", "admission"]),
    steps: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/iu)).min(1),
    omittedSteps: z.array(ReplaySkippedStepSchema).min(1).optional(),
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
  queueId: GitRefSchema,
  candidateId: z.string().regex(/^C\d+$/u),
  prs: z.array(PRSnapshotSchema).min(1),
  base: GitRefSchema,
  flow: FlowPinSchema.optional(),
  steps: z.array(InstalledStepSchema).min(1),
  initialIntegration: IntegrationProofSchema.optional(),
  initialResults: z.record(z.string(), JsonSchema).optional(),
  reusedFrom: z.string().trim().min(1).optional(),
  startedAt: z.iso.datetime({ offset: true }),
  parent: z.string().trim().min(1).optional(),
  failure: z
    .object({
      at: z.iso.datetime({ offset: true }),
      error: JobErrorSchema,
      job: z
        .object({ id: z.string().trim().min(1), attempt: z.number().int().positive() })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
}

const replayQueueRecordShape = {
  ...queueRecordShape,
  steps: z.array(ReplayInstalledStepSchema).min(1),
  /** Replay-only provenance; fresh child Runs use Candidate membership + Run.parent. */
  isolationPart: z.union([z.literal(0), z.literal(1)]).optional(),
}

export const QueueRecordSchema = z
  .object({ ...queueRecordShape, settlement: z.literal("explicit"), stepSelection: StepSelectionSchema.optional() })
  .strict()

export const ReplayQueueRecordSchema = z
  .object({
    ...replayQueueRecordShape,
    queueId: GitRefSchema.optional(),
    candidateId: z
      .string()
      .regex(/^C\d+$/u)
      .optional(),
    settlement: z.literal("explicit").optional(),
    stepSelection: z.union([ReplayStepSelectionSchema, LegacyStepSelectionSchema]).optional(),
  })
  .strict()

function resolveQueueRecord(state: QueuesState, id: RunId): QueueRecord | undefined {
  const direct = projectionLookupGet(state.records, id)
  if (direct !== undefined) return direct
  return resolveSelector(
    id,
    queueRecordValues(state).map((record) => ({
      canonical: record.id,
      aliases: printedRunRefAliases(record),
      value: record,
    })),
    { kind: "queue run" },
  )
}

/** The timeline and queue views print a run as `<base>#<number>` (`main#324`
 * for run `R324`); the resolver must accept what those surfaces teach the
 * operator to copy. Bare numbers stay PR selectors — `yrd cancel 324` already
 * means PR324 — so only the full printed form aliases here. */
function printedRunRefAliases(record: QueueRecord): readonly string[] {
  const number = /^R(\d+)$/u.exec(record.id)?.[1]
  return number === undefined ? [] : [`${record.base}#${number}`]
}

function compareRunIds(left: RunId, right: RunId): number {
  return compareNatural(left, right)
}

function queueRecordValues(state: QueuesState): readonly QueueRecord[] {
  return projectionLookupValues(state.records).toSorted((left, right) => compareRunIds(left.id, right.id))
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
      candidates: {},
      records: {},
      index: {
        version: 1,
        nextRunNumber: 1,
        childByParentPart: {},
        rootsByMember: {},
        plans: {},
      },
      authority: { statuses: {}, current: {}, submits: {}, checks: {}, claims: {}, runs: {} },
      terminalAssociations: { pending: {}, applied: {} },
      admissionRefusals: {},
      retention: { terminalOrder: {} },
    }
  },

  resolve(state: QueuesState, id: RunId): QueueRecord | undefined {
    return resolveQueueRecord(state, id)
  },

  get(state: QueuesState, id: RunId): QueueRecord | undefined {
    return projectionLookupGet(state.records, id)
  },

  values(state: QueuesState): readonly QueueRecord[] {
    return queueRecordValues(state)
  },

  ids(state: QueuesState): readonly RunId[] {
    return queueRecordValues(state).map((record) => record.id)
  },

  authorityRun(authority: QueueAuthorityState, id: RunId): RunAuthority | undefined {
    return projectionLookupGet(authority.runs, id)
  },

  set(
    records: Readonly<QueueProjectionLookup<QueueRecord>>,
    record: Readonly<QueueRecord>,
  ): QueueProjectionLookup<QueueRecord> {
    return projectionLookupSet(records, record.id, record)
  },

  record(state: QueuesState, id: RunId): QueueRecord {
    const direct = projectionLookupGet(state.records, id)
    if (direct !== undefined) return direct
    const record = resolveQueueRecord(state, id)
    if (record === undefined) throw new Error(`yrd: no queue run '${id}'`)
    return record
  },

  nextId(state: QueuesState): RunId {
    return `R${state.index.nextRunNumber}`
  },

  nextCandidateId(state: QueuesState): CandidateId {
    const values = Object.keys(state.candidates)
      .filter((id) => /^C\d+$/u.test(id))
      .map((id) => Number(id.slice(1)))
    return `C${Math.max(0, ...values) + 1}`
  },

  snapshot(pr: PR): PRSnapshot {
    const baseSha = checkRequest(pr)?.baseSha ?? prBaseSha(pr)
    const recut = prRecut(pr)
    return PRSnapshotSchema.parse({
      id: pr.id,
      ...(pr.bay === undefined ? {} : { bay: pr.bay }),
      ...(pr.name === undefined ? {} : { name: pr.name }),
      branch: pr.branch,
      base: baseIdentity(pr.base),
      ...(pr.issue === undefined ? {} : { issue: pr.issue }),
      revision: prRevisionNumber(pr),
      headSha: prHead(pr),
      ...(baseSha === undefined ? {} : { baseSha }),
      ...(prCorrelation(pr) === undefined ? {} : { correlation: prCorrelation(pr) }),
      ...(prComposition(pr) === undefined ? {} : { composition: prComposition(pr) }),
      ...(recut === undefined
        ? {}
        : { recut: { ...recut, ...(prBaseSha(pr) === undefined ? {} : { baseSha: prBaseSha(pr) }) } }),
      ...(pr.flow === undefined ? {} : { flow: pr.flow }),
    })
  },

  terminal(run: Run): boolean {
    return run.status === "completed"
  },

  succeeded(run: Run): boolean {
    return run.status === "completed" && run.conclusion === "success"
  },

  failed(run: Run): boolean {
    return run.status === "completed" && run.conclusion === "failure"
  },
})
