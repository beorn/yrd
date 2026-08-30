import {
  ChangeIdSchema,
  CompositionV1Schema,
  ChangePropsSchema,
  GitPayloadPathSchema,
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
  ChangeRemergeCertificateSchema,
  ChangeRemergeProofSchema,
  ChangeRemergeSourceSchema,
  baseIdentity,
  checkRequest,
  currentChangeRev,
  changeBaseSha,
  changeComposition,
  changeProps,
  changeHead,
  changeRemerge,
  changeRevisionNumber,
  isLiveChange,
  parseChangeSelector,
  resolveChange,
  type BaysState,
  type Change,
  type PRId,
  type ProjectedBranchSubmit,
} from "@yrd/bay"
import { compareNatural, JsonSchema, resolveSelector, type JsonValue } from "@yrd/core"
import type { StepKind } from "@yrd/config"
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

/** Stored fact from the retired flow rail (5e cut 3): journal rows written
 * before the cut carry it; nothing consumes it. */
const FlowPinSchema = z
  .object({
    name: z.string().trim().min(1),
    rev: z.string().trim().min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
type FlowPin = Readonly<z.infer<typeof FlowPinSchema>>

const ChangeSnapshotRemergeProofSchema = ChangeRemergeProofSchema.extend({
  /** Replay-only: certificate-era queue records carry these; nothing mints
   * them since the re-merge refactor deleted payload certificates. */
  certificate: ChangeRemergeCertificateSchema.optional(),
  baseSha: GitShaSchema.optional(),
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

/** A queue member is a change or a pin intent, and this union decides which: both
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
    /** Missing only while replaying pre-identity Queue records and for min-commit changes. */
    changeId: ChangeIdSchema.optional(),
    bay: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    branch: GitRefSchema,
    base: GitRefSchema,
    issue: z.string().trim().min(1).optional(),
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    baseSha: GitShaSchema.optional(),
    props: ChangePropsSchema.optional(),
    composition: CompositionV1Schema.optional(),
    recut: ChangeSnapshotRemergeProofSchema.optional(),
    flow: FlowPinSchema.optional(),
    /** Present only for a carrier-free pin intent materialized by Queue. */
    intent: QueueIntentSnapshotSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.intent === undefined && !PRIdSchema.safeParse(snapshot.id).success) {
      context.addIssue({ code: "custom", path: ["id"], message: "a change snapshot requires a change id" })
    }
    if (snapshot.intent !== undefined && snapshot.id !== snapshot.intent.id) {
      context.addIssue({ code: "custom", path: ["intent", "id"], message: "intent member id must match snapshot id" })
    }
    const remergeIssue = (path: string[], message: string) =>
      context.addIssue({ code: "custom", path: ["recut", ...path], message })
    const rootSources = snapshot.recut?.sources?.filter(({ repo }) => repo === ".") ?? []
    const rootSource = rootSources[0]
    if (rootSources.length > 1) {
      remergeIssue(["sources"], "a re-merge snapshot may carry at most one root source mapping")
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
    /** A queue member, not necessarily a change: an intent that merges carries its
     * own id here (`command.ts` fills this from the member's `id`). */
    pr: QueueMemberIdSchema,
    revision: z.number().int().positive(),
    submittedHead: GitShaSchema,
    generatedCommit: GitShaSchema,
    /**
     * Whether the base ALREADY contained this member's authored head when the
     * candidate was built, so nothing was merged for it.
     *
     * A measurement, recorded where it is taken: `prepareCandidateMembers` runs
     * `git merge-base --is-ancestor <submittedHead> HEAD` against the base
     * checkout, a check that can genuinely answer no. Everything downstream
     * used to re-derive the same question from the COLLAPSED candidate instead
     * — `candidateSha === baseSha`, `is-ancestor X X`, `tree(X) === tree(X)` —
     * and all three degenerate to yes for free, because a candidate that merged
     * nothing IS its base. Three fake measurements stood in for one real one
     * that was computed and thrown away.
     *
     * Absent on records written before this field existed; absence means "not
     * measured", never "false".
     */
    containedInBase: z.boolean().optional(),
  })
  .strict()
export type CandidateChange = Readonly<z.infer<typeof CandidateChangeSchema>>

export const SubmoduleModelChangeAuthorizationSchema = z
  .object({
    operation: z.enum(["add", "remove"]),
    path: z.string().trim().min(1),
    ruling: z.uuid(),
    authorizer: z.string().trim().min(1),
    pr: QueueMemberIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    /** Stable identity of the authorized code change. Optional only while
     * replaying Candidates written before patch-bound authorization receipts. */
    patchId: GitShaSchema.optional(),
    /** Mechanical proof that a later revision is the same code change at a
     * different commit. Present only when authorization crossed a re-merge. */
    source: ChangeRemergeSourceSchema.optional(),
  })
  .strict()
  .superRefine(({ headSha, patchId, source }, context) => {
    if (source === undefined) return
    if (patchId === undefined) {
      context.addIssue({ code: "custom", message: "re-merge source requires patchId", path: ["patchId"] })
    } else if (source.patchId !== patchId) {
      context.addIssue({
        code: "custom",
        message: "re-merge source patchId must match receipt patchId",
        path: ["source"],
      })
    }
    if (source.toHeadSha !== headSha) {
      context.addIssue({ code: "custom", message: "re-merge source must end at receipt headSha", path: ["source"] })
    }
  })
export type SubmoduleModelChangeAuthorization = Readonly<z.infer<typeof SubmoduleModelChangeAuthorizationSchema>>

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
  componentModelChanges?: readonly SubmoduleModelChangeAuthorization[]
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
    componentModelChanges: z.array(SubmoduleModelChangeAuthorizationSchema).min(1).optional(),
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
  alreadyLanded?: AlreadyMergedEvidence
  sourceRewrites?: readonly SourceRewrite[]
  submoduleResolutions?: readonly QueueSubmoduleResolutionEvidence[]
  componentMains?: readonly SubmoduleMainResult[]
}>

export const IntegrationProofSchema = z
  .object({
    commit: GitShaSchema,
    // The base branch tip after integration, not the pre-integration base.
    baseSha: GitShaSchema,
    alreadyLanded: AlreadyMergedEvidenceSchema.optional(),
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

/** Where the step list that judged a Run came from.
 *
 * - `declared-at-base` — read from the config blob at the Run's base sha. This
 *   is the git-derived answer and the only default authority.
 * - `explicit` — an operator's `--steps` selection on the run itself.
 *
 * Absent on records written before 23192, where a default-authority plan was
 * read out of the durable `QueuesState.defaultSteps` — a stored copy that could
 * disagree with the configuration and silently won when it did. */
export type StepPlanSource = "declared-at-base" | "explicit"

/** The step plan a base ref declares, as read from git.
 *
 * Both shas are recorded on the Run so an audit can compare what executed
 * against what the config declares now WITHOUT a written baseline file: the
 * base sha says which commit's config was read, and the blob id says which
 * exact config bytes it was. */
export type DeclaredStepPlan = Readonly<{
  baseSha: string
  configBlobSha: string
  steps: readonly StepName[]
}>

/** What a reader of the config blob returns: the port is ASKED for one exact
 * base sha, so it never echoes it back. */
export type DeclaredStepPlanAtBase = Omit<DeclaredStepPlan, "baseSha">

export const DeclaredStepPlanSchema = z
  .object({
    baseSha: GitShaSchema,
    configBlobSha: GitShaSchema,
    steps: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/iu)).min(1),
  })
  .strict()

type StepSelectionBase = Readonly<{
  authority: "configured" | "explicit" | "admission"
  source?: StepPlanSource
  /** The commit whose config declared this plan, and that config's blob id.
   * Present whenever `source` is `declared-at-base`. */
  baseSha?: string
  configBlobSha?: string
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
      | "merge-unauthored-deletion"
      | "source-publish"
      | "scratch-cleanup-failed"
      | "wrapper-generation"
    ref: string
  }>
}>

export type QueueAuthorityState = Readonly<{
  // Deliberately NO per-change delivery-status copy here. ChangeDeliveryState
  // is "derived, never stored" (@yrd/bay model.ts) and the queue used to store
  // it anyway, as `statuses` — the second state copy 22991 phase 2 deletes.
  // Delivery state derives from the change record (`changeDeliveryState`) and
  // the live submit facts (`bays.submits`) at the moment it is read; the
  // authority level a member runs under derives from the token facts below.
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
  // Run-level cancellation (the `queue cancel` surface): a run aborted before it merges,
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
  // Record-level copy of the merge proof this run produced, for the same reason
  // as `passedAt`: the proof is otherwise readable only through the merge step's
  // Job output, so Job retention takes it and the run keeps `passedAt` while
  // losing WHAT it landed. A DERIVED member has no store row to absorb its
  // `pr/integrated`, so this record IS the only projected home its merged truth
  // can have (see `derivedIntegration`). Stamped by `stampRunIntegration` from
  // the `pr/integrated`/`pr/already-landed` fact that names the run — those
  // already carry the proof, so no registered event schema widens and the
  // checkpoint identity does not move. Projection-only; no started run carries
  // it, so QueueRecordSchema stays unchanged. Distinct from
  // `initialIntegration`, which is a proof the run was HANDED, not one it made.
  integration?: IntegrationProof
}>

export type QueueStep = InstalledStep & Readonly<{ job?: Job }>

export type RunStatus = "queued" | "in_progress" | "waiting" | "completed"
export type RunConclusion = "success" | "failure" | "cancelled" | "skipped" | "timed_out"

export type Run = Omit<QueueRecord, "initialIntegration" | "initialResults" | "steps" | "failure"> &
  Readonly<{
    cursor: number
    /** answers: Did this Run produce a proven merge commit? tense: historical. */
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
 * process). Reset when the change is admitted, pushed, or re-merge.
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
  /** Consecutive refusals since the last admission / push / re-merge. */
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
  /** Durable terminal disposition for this exact revision. A new push/re-merge
   * clears the whole refusal entry and therefore re-arms admission. */
  settlement?: Readonly<{
    disposition: "needs-person"
    reason: string
    settledAt: string
  }>
}>

export type QueuesState = Readonly<{
  batchSize: number
  requires: readonly QueueRequirement[]
  pauses: Readonly<Record<string, QueuePause>>
  candidates: Readonly<Record<CandidateId, Candidate>>
  records: QueueProjectionLookup<QueueRecord>
  index: QueueProjectionIndex
  authority: QueueAuthorityState
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

/**
 * A branch approved in git (`refs/yrd/submit/<branch>`, projected by the
 * receiver as `branch/submitted`) that no PR record carries and that the
 * DERIVED lane has not yet admitted at this sha (S6). Post-door such a branch
 * is runnable — the next compose derives its admission — so this row is a
 * not-yet-picked-up fact, not a refusal; it persists only while no runner
 * composes, derived admission is unwired, or the derivation refused, and it
 * must SAY WHICH wherever a waiting author looks: status, watch, audit and the
 * considered rows of an empty run (@cto efd1fa9a, constraint 3). `message` is
 * built from the wiring the compose itself acts on, so the unwired case reads
 * differently from a lane simply waiting on a compose — listing all three at
 * once implied a distinction the row could not make
 * (@i/10-yrd/23996-derived-empty-silent). When a
 * record exists for the same branch, the record wins and this row does not
 * appear; once a retained run snapshot names the branch at this exact sha,
 * the member's own rows take over and this one retires.
 */
/**
 * Why a standing submit fact's landing question has no answer for this reader.
 *
 * `degenerate` and `unreadable` are the repository's own two non-answers
 * (@yrd/queue `UnresolvedSubmitReason`). `unscanned` is this reader's: nothing
 * asked the repository at all, because the surface is a pure reducer or a
 * projection read that ran before any scan primed the queue. It is NEVER a
 * verdict — a row carrying it says so in its own message.
 */
export type SubmitLandingUnresolved = "degenerate" | "unreadable" | "unscanned"

/**
 * Is a standing submit fact still waiting, and how do we know?
 *
 * THREE states, never two. Ancestry is not a total predicate: a rebased
 * landing rewrites content identity, so the original tip is not an ancestor
 * and reads as not-landed forever, and merged-truth's own degeneracies
 * (self-comparison, collapsed-onto-base) answer nothing at all. Collapsing an
 * unanswerable fact into either `pending` or `landed` is how a waiting list
 * lies in one direction or the other, so the unanswerable case carries its own
 * state and its own reason.
 *
 * `landed` never appears on a rendered row — a landed fact is not pending, so
 * it is absent from the waiting list entirely. The state exists so the reader
 * that decides absence and the reader that decides annotation are the SAME
 * derivation.
 */
export type SubmitLanding =
  | Readonly<{ state: "pending" }>
  | Readonly<{ state: "landed"; mergeCommit?: string }>
  | Readonly<{ state: "unresolved"; reason: SubmitLandingUnresolved; detail: string }>

export type UnrecordedSubmit = Readonly<{
  branch: string
  sha: string
  base: string
  /** When the receiver projected the approval. */
  at: string
  /**
   * What the REPOSITORY says about this fact, derived at read time — never a
   * stored bit, and never the change-record store's answer.
   *
   * A row exists only when this is not `landed`: pendingness is derived, so a
   * fact whose content main already carries stops being reported without
   * anything retiring the ref. Retirement becomes housekeeping the report no
   * longer depends on.
   */
  landing: SubmitLanding
  reason: Readonly<{
    code: "unrecorded-submit"
    message: string
  }>
}>

/**
 * One branch, both sources, one answer. `record` (and its `eligibility`) is
 * present when a change record exists for the branch; `submit` is the projected
 * live submit ref when one stands; `unrecorded` is the row rendered for a
 * submit with no record. Never both `eligibility` and `unrecorded`.
 *
 * `authority` is the S6 newest-truth arbitration verdict over the same two
 * sources ({@link arbitrateDerivedChange}). While record writes still flow it
 * is advisory — no consumer is cut over — and the legacy fields keep their
 * exact pre-S6 semantics (`record` stays the first store match, `unrecorded`
 * stays hidden by a record in ANY state). The S6 door flips consumers onto the
 * verdict; it never changes the verdict.
 */
export type DerivedChange = Readonly<{
  branch: string
  record?: Change
  eligibility?: ChangeEligibility
  submit?: Readonly<{ sha: string; base: string; at: string }>
  unrecorded?: UnrecordedSubmit
  authority: DerivedChangeAuthority
}>

/**
 * The record×submit corner a branch occupies — the 9-cell matrix of the S6
 * door design (@i/10-merge-queue/s6-door-design §3 leg 3). Both axes are
 * mechanical: `record` is the newest-truth record's liveness
 * ({@link newestTruthRecord}); `submit` compares the live submit fact's sha to
 * that record's CURRENT head. With no record there is no head to equal, so
 * every live submit on a recordless branch classifies as `different-sha` and
 * the none×same-sha cell is zero by construction — counted as zero, never
 * omitted, by the door-2 preflight.
 */
export type DerivedChangeCell = Readonly<{
  record: "none" | "live" | "terminal"
  submit: "none" | "same-sha" | "different-sha"
}>

/**
 * Which regime answers for a branch. Exactly one lane per branch — never both,
 * which is the A4 "never both lanes for one push" guarantee made structural.
 */
export type DerivedChangeLane = "record" | "derived" | "none"

export type DerivedChangeAuthority = Readonly<{
  lane: DerivedChangeLane
  cell: DerivedChangeCell
  /** The newest-truth record the verdict arbitrated over: the live record when
   * one exists, else the newest terminal one (highest number — the mint is
   * monotone, so number order is creation order). May differ from
   * `DerivedChange.record` (legacy FIRST store match) on a multi-record
   * branch, e.g. an integrated record plus the live record a re-submission of
   * the same branch minted. */
  record?: Change
}>

/**
 * The newest-truth record for one branch: live beats terminal, then highest
 * number wins within each class. A branch acquires multiple records when it is
 * re-submitted after integration (intake mints a fresh id for a terminal
 * branch), so "the" record for a branch is an arbitration, not a lookup.
 */
export function newestTruthRecord(records: readonly Change[]): Change | undefined {
  const ordered = records.toSorted((left, right) => compareNatural(left.id, right.id))
  return ordered.findLast(isLiveChange) ?? ordered.at(-1)
}

export function classifyDerivedChangeCell(
  record: Change | undefined,
  submit: ProjectedBranchSubmit | undefined,
): DerivedChangeCell {
  const recordAxis = record === undefined ? "none" : isLiveChange(record) ? "live" : "terminal"
  const submitAxis =
    submit === undefined
      ? "none"
      : record !== undefined && changeHead(record) === submit.sha
        ? "same-sha"
        : "different-sha"
  return { record: recordAxis, submit: submitAxis }
}

/**
 * S6 newest-truth-by-branch arbitration (@i/10-merge-queue/s6-door-design §2):
 *
 * - live record ⇒ `record` lane, whatever the submit fact says: a live submit
 *   sha differing from a live record's head is the record's pending revision,
 *   resolved AT WRITE TIME by the receiver's conditional intake dispatch, so
 *   the read side never owns that ambiguity.
 * - terminal record + live submit whose sha is NOT the record's current head ⇒
 *   `derived` lane: a post-door re-submission of a pre-door branch. The
 *   derived member is the live truth and the record is history — the one cell
 *   where the legacy "a record in ANY state wins" filter is wrong and S6 flips
 *   it (the branch is NOT shadowed). NOTE: this cell is a STATUS statement
 *   only. Compose ADMISSION additionally requires the branch to be recordless
 *   (`derivedLaneBranches` — one lane consumes one push): the same cell also
 *   describes a branch the record lane just merged whose fact survived, and
 *   admitting it re-merged one approval twice (PR2139, 2026-08-27). The
 *   excluded branches stay loud via `recordShadowedSubmits`.
 * - terminal record + same-sha submit ⇒ `record` lane: the standing ref names
 *   exactly the head the record already accounts for; nothing new exists to
 *   run.
 * - no record ⇒ `derived` when a live submit fact stands, else `none`.
 */
export function arbitrateDerivedChange(
  records: readonly Change[],
  submit: ProjectedBranchSubmit | undefined,
): DerivedChangeAuthority {
  const record = newestTruthRecord(records)
  const cell = classifyDerivedChangeCell(record, submit)
  const lane =
    cell.record === "live"
      ? "record"
      : cell.record === "terminal"
        ? cell.submit === "different-sha"
          ? "derived"
          : "record"
        : cell.submit === "none"
          ? "none"
          : "derived"
  return { lane, cell, ...(record === undefined ? {} : { record }) }
}

/**
 * The store-first-by-id half of the S6 seam: `PRnnn` selectors answer from the
 * record store when a record exists (the frozen store is complete for its own
 * era), else from the newest retained `ChangeSnapshot` naming that id (the
 * only home a post-door derived member's identity has). The two sources cannot
 * disagree about one id: post-door ids are minted strictly above the frozen
 * store's max (mint monotonicity, pr-mint commit-before-escape), so an id has
 * a record or snapshots, never a record AND recordless snapshots.
 */
export type ResolvedMember =
  | Readonly<{ source: "record"; id: PRId; record: Change }>
  | Readonly<{ source: "snapshot"; id: string; snapshot: ChangeSnapshot }>

export function resolveMemberById(bays: BaysState, queues: QueuesState, selector: string): ResolvedMember | undefined {
  const record = resolveChange(bays, selector)
  if (record !== undefined) return { source: "record", id: record.id, record }
  const id = parseChangeSelector(selector)?.pr ?? selector
  const snapshot = latestChangeSnapshot(queues, (candidate) => candidate.id === id)
  return snapshot === undefined ? undefined : { source: "snapshot", id: snapshot.id, snapshot }
}

/**
 * Newest retained `ChangeSnapshot` matching `match`: Queue run records in
 * natural run-id order, the latest run's snapshot winning. Intent members are
 * pin-advance materializations, not changes, and never match. Retention bounds
 * the walk to retained runs — a pruned member simply stops resolving, which is
 * the design's accepted re-mint case (number skip, never recycle).
 */
export function latestChangeSnapshot(
  state: QueuesState,
  match: (snapshot: ChangeSnapshot) => boolean,
): ChangeSnapshot | undefined {
  let latest: ChangeSnapshot | undefined
  for (const record of queueRecordValues(state)) {
    for (const snapshot of record.prs) {
      if (snapshot.intent === undefined && match(snapshot)) latest = snapshot
    }
  }
  return latest
}

/** Highest revision any retained snapshot records for `id`; 0 when none does. */
export function maxChangeSnapshotRevision(state: QueuesState, id: string): number {
  let max = 0
  for (const record of queueRecordValues(state)) {
    for (const snapshot of record.prs) {
      if (snapshot.intent === undefined && snapshot.id === id && snapshot.revision > max) max = snapshot.revision
    }
  }
  return max
}

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
  /**
   * Who a JUDGMENT disposition (a refusal with no mechanical remedy) routes
   * to — a STATIC, repository-declared routing fact, deliberately different
   * from {@link submitter}: `submitter` names an individual, recorded per
   * instance, and is absent rather than guessed when unrecorded; `owner`
   * names a ROLE, declared once for the whole repository (`.yrd.yml`
   * `needsPerson.owner`), true regardless of who currently staffs it. A
   * finding that carries `owner` at all always sets it to a real string — an
   * unconfigured repository reads it as explicitly unowned, never by
   * omitting the field, so the empty slot itself is what a reader sees
   * (@i/10-merge-queue/22918-needs-person-unowned).
   */
  owner?: string
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
 *   patch them to `undefined`), so a change in the `pushed` delivery state that
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
 * walks) and the derived plan audit in `@yrd/cli` (`plan-audit.ts`:
 * `runPlanMismatch` / `installedPlanStale`). Consumers whitelist these codes to decide what
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
  "unrecorded-submit",
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
  "admission-refusal-needs-person",
  "queue-never-started",
  "queue-progress-stalled",
  /** @i/10-yrd/queue-liveness-pair: the (eligible, advanced-since-last-tick)
   * pair. Deliberately independent of `admission-refusal-loop` and never
   * suppressed by it, unlike `queue-progress-stalled` above — see that
   * finding's own doc comment for the gap this closes. */
  "queue-liveness-wedged",
  /** A recorded Run's plan is not the plan git derives at that Run's own base
   * sha (23193 leg a): the journal and the repository disagree about what
   * judged it. Equal by construction, so any instance is a real finding. */
  "run-plan-mismatch",
  /** The plan this process installed is not the plan the base tip declares
   * (23192 leg c): a declared step with no Job here makes every Run refuse
   * with `declared-step-not-installed`; any other delta means stale step
   * definitions. The remedy is restarting the runner, never a state write. */
  "installed-plan-stale",
  /** A submodule object store whose EVERY `objects/info/alternates` line
   * dangles: the borrowed store — usually a recycled worktree's
   * `worktrees/<wt>/modules` store — is gone and no live line remains, so
   * every object read in that checkout fails (2026-08-25: 62 stores, all
   * traced to two recycled trees). Emitted by the environment audit's
   * alternates census (`alternates-audit.ts`); read-only, repair is
   * chief-routed, never automatic. */
  "submodule-alternates-dead-store",
  /** A submodule object store whose only LIVE alternates lines point into
   * `worktrees/<wt>/modules` stores: it reads today and dies the moment that
   * worktree is recycled. Armed, not detonated — lower severity than
   * dead-store. Re-materializing the checkout anchors the durable
   * `modules/<name>` line and disarms it. */
  "submodule-alternates-worktree-only",
] as const

export type QueueAuditFindingCode = (typeof YRD_QUEUE_AUDIT_FINDING_CODES)[number]

/** @deprecated Transition alias for the pre-rename name — /hh and /hh/ag mirrors
 * still import it. Remove once both mirrors read YRD_QUEUE_AUDIT_FINDING_CODES
 * (tracked in the I10 merge checklist; the swap gives ag's 5-code PAGED set
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
    source: z.enum(["declared-at-base", "explicit"]).optional(),
    baseSha: GitShaSchema.optional(),
    configBlobSha: GitShaSchema.optional(),
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
    source: z.enum(["declared-at-base", "explicit"]).optional(),
    baseSha: GitShaSchema.optional(),
    configBlobSha: GitShaSchema.optional(),
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
 * for run `R324`) and, label-elided on a single visible queue, as `#324`
 * (operator rulings 2026-08-18, items 34/38); the resolver must accept what
 * those surfaces teach the operator to copy. `#324` refuses loudly when two
 * bases share the number (the shared selector machinery names both). Bare
 * numbers stay PR selectors — `yrd cancel 324` already means PR324. */
function printedRunRefAliases(record: QueueRecord): readonly string[] {
  const number = /^R(\d+)$/u.exec(record.id)?.[1]
  return number === undefined ? [] : [`${record.base}#${number}`, `#${number}`]
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
      requires?: readonly QueueRequirement[]
    }>,
  ): QueuesState {
    return {
      batchSize: options.batchSize,
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
      authority: { current: {}, submits: {}, checks: {}, claims: {}, runs: {} },
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

  snapshot(pr: Change): ChangeSnapshot {
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
      ...(changeProps(pr) === undefined ? {} : { props: changeProps(pr) }),
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
