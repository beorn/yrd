import {
  ChangeIdSchema,
  CompositionV1Schema,
  CorrelationSchema,
  GitPayloadPathSchema,
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
  ChangeRemergeCertificateSchema,
  ChangeRemergeProofSchema,
  type ChangeDeliveryState,
  type ChangeTerminalAssociation,
  baseIdentity,
  checkRequest,
  currentChangeRev,
  changeBaseSha,
  changeComposition,
  changeCorrelation,
  changeHead,
  changeRemerge,
  changeRevisionNumber,
  type PR,
  type PRId,
} from "@yrd/bay"
import { compareNatural, JsonSchema, resolveSelector, type JsonValue } from "@yrd/core"
import type { FlowPin, StepKind } from "@yrd/config"
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

const ChangeSnapshotRemergeProofSchema = ChangeRemergeProofSchema.extend({
  /** Current exact carrier certificate. Absence is accepted only for replaying legacy queue records. */
  certificate: ChangeRemergeCertificateSchema.optional(),
  /** Immutable base certified by this recut revision. Optional only for replaying legacy queue records. */
  baseSha: GitShaSchema.optional(),
  /** Immutable approved-source endpoints. Both are absent only for legacy queue records. */
  sourceBaseSha: GitShaSchema.optional(),
  sourceHeadSha: GitShaSchema.optional(),
}).strict()

/**
 * A historical intent record id, in either minted form.
 *
 * `yrdpin#<n>` is what the retired intent rail minted before it was deleted.
 * `I<n>` is what the counter minted before that. The intent rail itself is
 * gone — there is no live `Intents` interface and no new record is ever
 * minted again — but the journal still holds these ids forever, and
 * `QueueMemberIdSchema`/`queueMemberKind` must keep recognizing their SHAPE so
 * a stored member id still parses, selects and prints instead of being
 * mis-kinded or refused. Relocated verbatim from the deleted `@yrd/intent`
 * package (`IntentRecordIdSchema`) rather than re-derived, so the regex a
 * historical id must match never drifts from what actually minted it.
 */
export const IntentRecordIdSchema = z.string().regex(/^(?:I|yrdpin#)\d+$/u, "expected an intent id, e.g. yrdpin#162")

const IntentIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, "expected a lowercase UUID")

/** A queue member is a PR or a pin intent, and this union decides which: both
 * arms are pinned to the shape their mint writes (`PR182` vs `I148` /
 * `yrdpin#164`), so a mis-kinded id fails at the schema rather than much later.
 * Positions that hold members of either kind must use THIS schema — a bare
 * `PRIdSchema` there now refuses every intent id.
 */
export const QueueMemberIdSchema = z.union([PRIdSchema, IntentRecordIdSchema])

/** What kind of record a queue member id names. */
export type QueueMemberKind = "pr" | "gitlink"

/**
 * The ONE discrimination of member kind, decided by the same two schemas the
 * mints write through — so a renderer asks this instead of re-parsing the id,
 * and every surface agrees by construction rather than by parallel guards.
 *
 * Returns `undefined` for an id neither schema claims. That is deliberate: a
 * default of `"pr"` is precisely the failure this closes, a surface asserting a
 * kind nothing ever established (@i/10-merge-queue/22924-pr-prefix-on-non-pr).
 * Callers must decide what an unknown id means for them; none may assume.
 */
export function queueMemberKind(id: string): QueueMemberKind | undefined {
  if (PRIdSchema.safeParse(id).success) return "pr"
  if (IntentRecordIdSchema.safeParse(id).success) return "gitlink"
  return undefined
}
/**
 * The authored-to-evaluated lineage a historical "carrier-free pin intent"
 * run recorded onto its own PR-shaped queue member. Both sub-shapes are
 * relocated verbatim from the deleted `@yrd/intent` package (`PinIntentAuthoredSchema`,
 * `PinIntentEvaluationSchema`) — no live code ever constructs one again (the
 * evaluator and the CLI verb that fed it are both gone), but a Run record
 * minted before the rail's deletion still carries this shape inside its own
 * `queue/run/*` event, which is a SURVIVING event family. Replay must keep
 * parsing it, so the shape stays exact rather than loosened.
 */
const QueueIntentAuthoredSchema = z
  .object({
    intentId: IntentIdSchema,
    // Matches `@yrd/issue`'s IssueRefSchema shape exactly (not `.strict()`,
    // same as the original) without adding a new workspace dependency for one
    // nested field of a replay-only, no-longer-produced shape.
    issue: z.object({ source: z.string().trim().min(1), id: z.string().trim().min(1) }),
    component: GitPayloadPathSchema,
    target: GitShaSchema.optional(),
  })
  .strict()
const QueueIntentEvaluationSchema = z.object({ priorPin: GitShaSchema, target: GitShaSchema }).strict()

export const QueueIntentSnapshotSchema = z
  .object({
    id: IntentRecordIdSchema,
    authored: QueueIntentAuthoredSchema,
    evaluated: QueueIntentEvaluationSchema,
  })
  .strict()
export type QueueIntentSnapshot = Readonly<z.infer<typeof QueueIntentSnapshotSchema>>

export const ChangeSnapshotSchema = z
  .object({
    id: QueueMemberIdSchema,
    /** Missing only while replaying pre-identity Queue records and for pin intents. */
    changeId: ChangeIdSchema.optional(),
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
    recut: ChangeSnapshotRemergeProofSchema.optional(),
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
    const remergeIssue = (path: string[], message: string) =>
      context.addIssue({ code: "custom", path: ["recut", ...path], message })
    const rootSources = snapshot.recut?.sources?.filter(({ repo }) => repo === ".") ?? []
    const rootSource = rootSources[0]
    const frozen = snapshot.recut?.certificate === "frozen-code-carrier-v1"
    if (frozen && snapshot.recut?.baseSha === undefined) {
      remergeIssue(["baseSha"], "a frozen code-carrier certificate requires an immutable candidate base")
    }
    if (frozen && (snapshot.recut?.sourceBaseSha === undefined || snapshot.recut.sourceHeadSha === undefined)) {
      remergeIssue([], "a frozen code-carrier certificate requires a complete immutable source range")
    }
    if (!frozen && (snapshot.recut?.sourceBaseSha !== undefined || snapshot.recut?.sourceHeadSha !== undefined)) {
      remergeIssue([], "immutable source endpoints require a frozen code-carrier certificate")
    }
    if (rootSources.length > 1) {
      remergeIssue(["sources"], "a recut snapshot may carry at most one root source mapping")
    }
    if (frozen && rootSources.length !== 1) {
      remergeIssue(["sources"], "a frozen code-carrier certificate requires exactly one root source mapping")
    }
    if (
      rootSource !== undefined &&
      snapshot.recut?.sourceHeadSha !== undefined &&
      rootSource.fromHeadSha !== snapshot.recut.sourceHeadSha
    ) {
      remergeIssue(["sources"], "root source mapping must start at the certified source head")
    }
    if (rootSource !== undefined && rootSource.toHeadSha !== snapshot.headSha) {
      remergeIssue(["sources"], "root source mapping must end at the current candidate head")
    }
  })
/** answers: Which immutable PR revision did this Queue record select? tense: historical.
 * A snapshot deliberately carries identity and content, never mutable delivery status. */
export type ChangeSnapshot = Readonly<z.infer<typeof ChangeSnapshotSchema>>

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

export const CandidateChangeSchema = z
  .object({
    changeId: ChangeIdSchema,
    /** A queue member, not necessarily a PR: an intent that lands carries its
     * own id here (`command.ts` fills this from the member's `id`). */
    pr: QueueMemberIdSchema,
    revision: z.number().int().positive(),
    submittedHead: GitShaSchema,
    generatedCommit: GitShaSchema,
  })
  .strict()
export type CandidateChange = Readonly<z.infer<typeof CandidateChangeSchema>>

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
  changes?: readonly CandidateChange[]
  sourceRewrites?: readonly SourceRewrite[]
  submoduleResolutions?: readonly QueueSubmoduleResolutionEvidence[]
  /** answers: Did preparation find this immutable Candidate mergeable? tense: historical. */
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
    changes: z.array(CandidateChangeSchema).min(1).optional(),
    sourceRewrites: z.array(SourceRewriteSchema).optional(),
    submoduleResolutions: z.array(QueueSubmoduleResolutionEvidenceSchema).min(1).optional(),
    mergeability: z.enum(["unknown", "mergeable", "conflicting"]),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict()

export type AlreadyMergedEvidence = Readonly<{
  candidateSha: string
  candidateTreeSha: string
  baseTreeSha: string
}>

export const AlreadyMergedEvidenceSchema = z
  .object({
    candidateSha: GitShaSchema,
    candidateTreeSha: GitShaSchema,
    baseTreeSha: GitShaSchema,
  })
  .strict()
  .refine(({ candidateTreeSha, baseTreeSha }) => candidateTreeSha === baseTreeSha, {
    message: "candidateTreeSha must equal baseTreeSha",
    path: ["candidateTreeSha"],
  }) as z.ZodType<AlreadyMergedEvidence>

export type SubmoduleMainResult = Readonly<{
  path: string
  origin: string
  pinSha: string
  mainBeforeSha: string
  mainAfterSha: string
  action: "verified" | "fast-forwarded"
}>

export const SubmoduleMainResultSchema = z
  .object({
    path: z.string().min(1),
    origin: z.string().min(1),
    pinSha: GitShaSchema,
    mainBeforeSha: GitShaSchema,
    mainAfterSha: GitShaSchema,
    action: z.enum(["verified", "fast-forwarded"]),
  })
  .strict() as z.ZodType<SubmoduleMainResult>

export type SubmoduleMainRefusal = Readonly<{
  path: string
  origin: string
  pinSha: string
  mainSha?: string
  code: string
  message: string
}>

export const SubmoduleMainRefusalSchema = z
  .object({
    path: z.string().min(1),
    origin: z.string().min(1),
    pinSha: GitShaSchema,
    mainSha: GitShaSchema.optional(),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict() as z.ZodType<SubmoduleMainRefusal>

export type SubmoduleMainOutcomes = Readonly<{
  kind: "component-main-outcomes"
  results: readonly SubmoduleMainResult[]
  refusals: readonly SubmoduleMainRefusal[]
}>

export const SubmoduleMainOutcomesSchema = z
  .object({
    kind: z.literal("component-main-outcomes"),
    results: z.array(SubmoduleMainResultSchema),
    refusals: z.array(SubmoduleMainRefusalSchema),
  })
  .strict() as z.ZodType<SubmoduleMainOutcomes>

export type IntegrationProof = Readonly<{
  commit: string
  baseSha: string
  alreadyMerged?: AlreadyMergedEvidence
  sourceRewrites?: readonly SourceRewrite[]
  submoduleResolutions?: readonly QueueSubmoduleResolutionEvidence[]
  componentMains?: readonly SubmoduleMainResult[]
}>

export const IntegrationProofSchema = z
  .object({
    commit: GitShaSchema,
    // The base branch tip after integration, not the pre-integration base.
    baseSha: GitShaSchema,
    alreadyMerged: AlreadyMergedEvidenceSchema.optional(),
    sourceRewrites: z.array(SourceRewriteSchema).optional(),
    submoduleResolutions: z.array(QueueSubmoduleResolutionEvidenceSchema).min(1).optional(),
    componentMains: z.array(SubmoduleMainResultSchema).min(1).optional(),
  })
  .strict() as z.ZodType<IntegrationProof>

export type ChangeShape = Readonly<{
  results: Readonly<Record<string, JsonValue>>
}>

export type IntegratedShape = ChangeShape & Readonly<{ integration: IntegrationProof }>

export type AddStepResult<Shape extends ChangeShape, Name extends string, Output extends JsonValue> = Omit<
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
      | "landing-unauthored-deletion"
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

export type QueueTerminalAssociation = ChangeTerminalAssociation

export type QueueTerminalAssociations = Readonly<{
  pending: Readonly<Record<string, QueueUnassociatedTerminal>>
  applied: Readonly<Record<string, QueueTerminalAssociation>>
}>

export type QueueAuthorityState = Readonly<{
  // Same nine values as PRDeliveryState (@yrd/bay); imported rather than
  // re-spelled so the two authorities cannot drift apart silently.
  statuses: Readonly<Record<string, ChangeDeliveryState>>
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
  /** Immutable execution result. Candidate owns the ordered revision identity;
   * projection rejects any result that diverges from it. */
  prs: readonly ChangeSnapshot[]
  /** Queue-target result; Candidate owns the exact base SHA. */
  base: string
  /** Effective Queue batch size when this Run started. Absent only on legacy journal records. */
  batchSize?: number
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
    /** answers: Did this Run produce a proven landing commit? tense: historical. */
    integration?: IntegrationProof
    /** answers: Which execution phase is this Run in now? tense: current. */
    status: RunStatus
    /** answers: How did this Run finish? tense: historical. */
    conclusion?: RunConclusion
    /** Durable Job identities in literal Flow order. */
    jobs: readonly string[]
    steps: readonly QueueStep[]
    shape: ChangeShape | IntegratedShape
    /** answers: When did this Run enter a terminal status? tense: historical. */
    finishedAt?: string
    /** answers: Why did this Run finish without success? tense: historical. */
    error?: JobError
  }>

export type QueuePause = Readonly<{
  base: string
  reason: string
  allowedPRs: readonly string[]
  pausedAt: string
  /** Absolute hold deadline. Missing only while replaying pre-TTL journals. */
  expiresAt?: string
}>
export const QueuePauseSchema = z
  .object({
    base: GitRefSchema,
    reason: z.string().trim().min(1),
    allowedPRs: z.array(PRIdSchema),
    pausedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
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

export type ChangeEligibilityReason = Readonly<{
  /** answers: Why can the current PR revision not run now? tense: current. */
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
  /** The attributed failure result carried by native `pr/needs-author` (or
   * recovered from a legacy rejected journal) for the author to act on. Absent
   * for every other reason code. */
  result?: JobError
}>

export type ChangeEligibility = Readonly<{
  pr: string
  revision: number
  /** answers: Can this exact PR revision enter a Queue run now? tense: current. */
  runnable: boolean
  reason?: ChangeEligibilityReason
  review: Readonly<{
    required: boolean
    approved: boolean
    stale: boolean
    decision?: "approve" | "reject"
    by?: string
    ref?: string
  }>
  checks: Readonly<{
    /** answers: What required-check phase applies to this revision now? tense: current. */
    status: "not-requested" | "queued" | "checking" | "passed" | "failed"
    queuedAt?: string
    position?: number
    run?: RunId
  }>
}>

export type ChangeCheckRecord = Readonly<{
  pr: string
  revision: number
  status: ChangeEligibility["checks"]["status"]
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
  /** Who to route the finding to, as RECORDED on the carrier's own revision —
   * never a seat, a branch owner or a git author guessed at read time. Absent
   * when the revision carries no submitter (journals written before submitter
   * identity existed): a finding with no recorded identity says nothing rather
   * than naming a plausible owner. */
  submitter?: string
  /** How far the carrier got through REVIEW before it stranded. Readers keep
   * the open `string` for the same reason `code` stays open — a value parsed
   * out of a foreign version's JSON must remain readable. Producers emit the
   * closed {@link QueueAuditReviewCertification}. */
  reviewCertification?: string
}>

/** How far a carrier got through review, derived ONLY from review facts the
 * PR already carries — a certification that can lie is worse than none.
 *
 * Named for REVIEW, not handoff: `BayHandoff` already certifies a workspace
 * head in this codebase, and one word carrying two certifications is the
 * ambiguity that costs a reader a wrong assumption. A bay's handoff readiness
 * (`bays.byId[pr.bay].handoff`) is reachable where this is derived and could
 * become a separate signal — it must never be folded into this one.
 *
 * Every member is decided by the SAME two inputs at the derivation point: the
 * verdict on the current revision (`reviewState(pr).current`) and the requested
 * reviewer set. Precedence runs left to right below: an explicit verdict on
 * this exact revision outranks an outstanding request, because the verdict is
 * about the content that actually stranded.
 *
 * Deliberately NOT members, because the discriminating data does not exist
 * where the finding is derived:
 * - `stale-base` would need the live base tip. The audit's state is
 *   `{ bays, jobs, intents, queues }`; no base branch head lives there, and the
 *   revision's own `baseSha` is only the base it was cut against. Deriving
 *   staleness would mean inventing a comparison.
 * - `unrecoverable` would need `rejectedAt` / `terminalRun`. Both are cleared
 *   by EVERY revision-appending reduction (`pr/pushed` and `pr/recut` both
 *   patch them to `undefined`), so a PR in the `pushed` delivery state that
 *   this finding fires on can never carry either. The field would be a
 *   constant, not a discriminator. */
export const YRD_QUEUE_AUDIT_REVIEW_CERTIFICATIONS = [
  /** A verdict of `approve` stands on this exact revision (including one a
   * rebuild carried forward): the change is certified and only the submit is
   * missing. */
  "approved",
  /** A verdict of `reject` stands on this exact revision: the draft is stranded
   * waiting on its author, not on a reviewer. */
  "changes-requested",
  /** Reviewers are requested and none has ruled on this revision. */
  "review-requested",
  /** No verdict on this revision and no outstanding request — the carrier never
   * entered review at all. */
  "unreviewed",
] as const

export type QueueAuditReviewCertification = (typeof YRD_QUEUE_AUDIT_REVIEW_CERTIFICATIONS)[number]

/** Every finding code `yrd queue audit` can emit, in ONE authoritative place.
 * It is the union of BOTH producers whose findings that command concatenates:
 * `auditQueues` in `queue.ts` (the hold, draft, record, refusal and progress
 * walks) and the environment audit in `@yrd/cli` (`installedBaselineDrift` /
 * `runtimeBaselineDrift`). Consumers whitelist these codes to decide what
 * reaches a page, and that whitelist was scattered across repositories — a code
 * added here but missing there pages nobody. Producers emit
 * {@link QueueAuditFindingEmission}, so a new code that is not listed here is a
 * compile error rather than a silently unrendered finding.
 *
 * Deliberately NOT listed: `resident-runner-missing` and its `resident-runner-*`
 * siblings. Those are `hab-service-health/1` errors (`{ code, cause, resolution }`
 * from `runnerHealthError` in `@yrd/cli`), a different document than a
 * `QueueAuditFinding` — a consumer may join the two surfaces onto one page, but
 * the queue audit itself never emits them. */
export const YRD_QUEUE_AUDIT_FINDING_CODES = [
  "queue-hold-ttl-missing",
  "queue-hold-expired",
  "draft-stranded",
  "missing-pr",
  "run-without-submit-ancestry",
  "run-without-check-ancestry",
  "invalid-run",
  "orphaned-run",
  "run-lease-expired",
  "step-unavailable",
  "step-revision-drift",
  "candidate-revision-mismatch",
  "orphaned-requested-job",
  "unisolable-stale-plan",
  "admission-refusal-loop",
  "queue-never-started",
  "queue-progress-stalled",
  "config-drift",
  "runtime-drift",
] as const

export type QueueAuditFindingCode = (typeof YRD_QUEUE_AUDIT_FINDING_CODES)[number]

/** @deprecated Transition alias for the pre-rename name — /hh and /hh/ag mirrors
 * still import it. Remove once both mirrors read YRD_QUEUE_AUDIT_FINDING_CODES
 * (tracked in the I10 landing checklist; the swap gives ag's 5-code PAGED set
 * the PAGE name). */
export const YRD_QUEUE_AUDIT_PAGE_FINDING_CODES = YRD_QUEUE_AUDIT_FINDING_CODES

/** A finding AT ITS PRODUCER: a {@link QueueAuditFinding} whose code is closed
 * over {@link YRD_QUEUE_AUDIT_FINDING_CODES}. Readers keep the open
 * `code: string` — a finding parsed back out of another process's JSON status is
 * data from a foreign version, not an emission, and must stay readable. The
 * same split applies to `reviewCertification`. */
export type QueueAuditFindingEmission = Omit<QueueAuditFinding, "code" | "reviewCertification"> &
  Readonly<{ code: QueueAuditFindingCode; reviewCertification?: QueueAuditReviewCertification }>

export type QueueAuditResult = Readonly<{ findings: readonly QueueAuditFinding[] }>

/** An audit AT ITS PRODUCER: {@link QueueAuditResult} carrying
 * {@link QueueAuditFindingEmission}s. Every function that BUILDS findings
 * returns this — `auditQueues` here and `auditEnvironment` in `@yrd/cli` — so
 * the closed code union survives the return instead of widening at it. A
 * producer typed `QueueAuditResult` still gets its local array checked, but a
 * finding written inline in the returned object literal widens on the way out
 * and type-checks with any string, which is exactly the unrendered-finding hole
 * the code list closes. Widen to {@link QueueAuditResult} only where the two
 * producers' findings are concatenated for DISPLAY (`queueAuditFindings` in
 * `@yrd/cli`), because from there on a finding may equally be one parsed out of
 * a foreign version's JSON. */
export type QueueAuditEmission = Readonly<{ findings: readonly QueueAuditFindingEmission[] }>

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
  prs: z.array(ChangeSnapshotSchema).min(1),
  base: GitRefSchema,
  batchSize: z.number().int().min(1),
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
  batchSize: queueRecordShape.batchSize.optional(),
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

  snapshot(pr: PR): ChangeSnapshot {
    const revision = currentChangeRev(pr)
    const baseSha = checkRequest(pr)?.baseSha ?? changeBaseSha(pr)
    const remerge = changeRemerge(pr)
    const frozen = remerge?.certificate === "frozen-code-carrier-v1"
    const sourceRevision = remerge === undefined ? undefined : pr.revs.find(({ n }) => n === remerge.fromRevision)
    const sourceEndpoints =
      !frozen || sourceRevision?.baseSha === undefined
        ? {}
        : { sourceBaseSha: sourceRevision.baseSha, sourceHeadSha: sourceRevision.head }
    return ChangeSnapshotSchema.parse({
      id: pr.id,
      ...(revision.changeId === undefined ? {} : { changeId: revision.changeId }),
      ...(pr.bay === undefined ? {} : { bay: pr.bay }),
      ...(pr.name === undefined ? {} : { name: pr.name }),
      branch: pr.branch,
      base: baseIdentity(pr.base),
      ...(pr.issue === undefined ? {} : { issue: pr.issue }),
      revision: changeRevisionNumber(pr),
      headSha: changeHead(pr),
      ...(baseSha === undefined ? {} : { baseSha }),
      ...(changeCorrelation(pr) === undefined ? {} : { correlation: changeCorrelation(pr) }),
      ...(changeComposition(pr) === undefined ? {} : { composition: changeComposition(pr) }),
      ...(remerge === undefined
        ? {}
        : {
            recut: {
              ...remerge,
              ...(changeBaseSha(pr) === undefined ? {} : { baseSha: changeBaseSha(pr) }),
              ...sourceEndpoints,
            },
          }),
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
