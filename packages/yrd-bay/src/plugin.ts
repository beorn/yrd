import {
  command,
  event,
  journalEvent,
  observeYrdLifecycle,
  raiseFailure,
  resolveSelector,
  type CommandHandler,
  type CommandResult,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type YrdDef,
  type YrdDeliveryIdentity,
  type YrdLifecycleOptions,
} from "@yrd/core"
import {
  createJobDef,
  type HasJobs,
  type Job,
  type JobContext,
  type JobDef,
  type JobResult,
  type Jobs,
  type JobTransition,
  type RunJobOptions,
} from "@yrd/job"
import type { PrNumberMint } from "@yrd/persistence"
import { computed, type ReadSignal } from "@silvery/signals"
import type { ConditionalLogger } from "loggily"
import * as z from "zod"
import { ChangeIdSchema, changeIdForCommand, type ChangeId } from "./change-identity.ts"
import {
  BayIdSchema,
  CheckpointBayInputSchema,
  CheckpointedBaySchema,
  CompositionV1Schema,
  ChangePropsSchema,
  DeprovisionBayInputSchema,
  DeprovisionedBaySchema,
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
  ChangeFreshnessTransitionSchema,
  ChangeAdmissionRecordedFactSchema,
  ChangeRemergeCertificateSchema,
  ChangeRemergeSourceSchema,
  ChangeReviewDecisionSchema,
  ChangeReviewSchema,
  ChangeNeedsAuthorFactSchema,
  ChangeRejectedFactSchema,
  ProvisionBayInputSchema,
  ProvisionedBaySchema,
  RefreshBayInputSchema,
  RefreshedBaySchema,
  RemoteBranchSnapshotSchema,
  baseIdentity,
  defaultBayBranch,
  checksRequested,
  currentChangeRev,
  emptyBaysState,
  isLiveChange,
  isTracked,
  needsReview,
  normalizeV2By,
  normalizeLegacyChangeKeys,
  normalizeV1CorrelationToProps,
  changeBaseSha,
  changeComposition,
  changeProps,
  changeDeliveryState,
  changeForBay,
  requireLiveChange,
  changeHead,
  changeNeedsAuthor,
  changeRemerge,
  changeRevisionNumber,
  ChangeCheckabilityConflict,
  projectBranchLifecycles,
  reviewState,
  resolveBay,
  resolveChange,
  resolveChangeMatch,
  type Bay,
  type BranchLifecycle,
  type BaysState,
  type CheckpointBayInput,
  type CheckpointedBay,
  type CompositionV1,
  type ChangeProps,
  type DeprovisionBayInput,
  type DeprovisionedBay,
  type LiveChange,
  type Change,
  type ChangeAdmissionRecordedFact,
  type ChangeComment,
  type ChangeRemergeProof,
  type ChangeReview,
  type ChangeReviewState,
  type ChangeRev,
  type ChangeRevClock,
  type ProvisionBayInput,
  type ProvisionedBay,
  type RefreshBayInput,
  type RefreshedBay,
  type RemoteBranchSnapshot,
  BranchSubmitSchema,
  BranchUnsubmitSchema,
  type BranchSubmit,
  type BranchUnsubmit,
} from "./model.ts"

const TextSchema = z.string().trim().min(1)
const RevisionSchema = z.number().int().positive()
const FlowPinSchema = z
  .object({
    name: TextSchema,
    rev: TextSchema,
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()

const OpenBayArgsSchema = z
  .object({
    name: TextSchema,
    issue: TextSchema.optional(),
    by: TextSchema.optional(),
    branch: GitRefSchema.optional(),
    from: GitRefSchema.optional(),
    base: GitRefSchema.optional(),
    baseSha: GitShaSchema.optional(),
    remoteBranch: RemoteBranchSnapshotSchema.optional(),
  })
  .strict()
export type OpenBayArgs = z.infer<typeof OpenBayArgsSchema>

const RefreshBayArgsSchema = z.object({ bay: TextSchema }).strict()
export type RefreshBayArgs = z.infer<typeof RefreshBayArgsSchema>

const CheckpointBayArgsSchema = z.object({ bay: TextSchema, claim: TextSchema }).strict()
export type CheckpointBayArgs = z.infer<typeof CheckpointBayArgsSchema>

const OrphanBayArgsSchema = z
  .object({
    bay: TextSchema,
    reason: TextSchema,
    exitCode: z.number().int().optional(),
    signal: TextSchema.optional(),
    timedOut: z.boolean().optional(),
    stalled: z.boolean().optional(),
    sweepFailure: TextSchema.optional(),
    escapedDescendant: z.boolean().optional(),
  })
  .strict()
export type OrphanBayArgs = z.infer<typeof OrphanBayArgsSchema>

const BayOrphanedSchema = OrphanBayArgsSchema.extend({ bay: BayIdSchema }).strict()

const CertifyHandoffArgsSchema = z
  .object({ bay: TextSchema, branch: GitRefSchema, headSha: GitShaSchema, evidence: TextSchema })
  .strict()
export type CertifyHandoffArgs = z.infer<typeof CertifyHandoffArgsSchema>

const BayHandoffCertifiedSchema = z
  .object({ bay: BayIdSchema, branch: GitRefSchema, headSha: GitShaSchema, evidence: TextSchema })
  .strict()

const ChangeExpectedCurrentSchema = z
  .object({
    pr: TextSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    track: z.boolean().optional(),
  })
  .strict()
type ChangeExpectedCurrent = Readonly<z.infer<typeof ChangeExpectedCurrentSchema>>

const IntakeChangeArgsSchema = z
  .object({
    bay: TextSchema.optional(),
    name: TextSchema.optional(),
    issue: TextSchema.optional(),
    branch: GitRefSchema.optional(),
    base: GitRefSchema.optional(),
    headSha: GitShaSchema,
    baseSha: GitShaSchema.optional(),
    submitter: TextSchema.optional(),
    /** The accepted ref was refs/for, so intake and submission are one act. */
    submit: z.literal(true).optional(),
    composition: CompositionV1Schema.optional(),
    receipt: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    expectedCurrent: ChangeExpectedCurrentSchema.optional(),
  })
  .strict()
  .refine(({ bay, branch }) => bay !== undefined || branch !== undefined, {
    message: "'bay' or 'branch' is required",
  })
export type IntakeChangeArgs = z.infer<typeof IntakeChangeArgsSchema>

const SubmitArgsSchema = z.union([
  z
    .object({
      pr: TextSchema,
      submitter: TextSchema.optional(),
      props: ChangePropsSchema.optional(),
      flow: FlowPinSchema.optional(),
      expectedCurrent: ChangeExpectedCurrentSchema.optional(),
    })
    .strict(),
  z
    .object({
      branch: GitRefSchema,
      headSha: GitShaSchema,
      base: GitRefSchema.optional(),
      baseSha: GitShaSchema.optional(),
      name: TextSchema.optional(),
      issue: TextSchema.optional(),
      draft: z.boolean().optional(),
      submitter: TextSchema.optional(),
      props: ChangePropsSchema.optional(),
      reviewers: z.array(TextSchema).optional(),
      flow: FlowPinSchema.optional(),
    })
    .strict(),
])
export type SubmitArgs = z.infer<typeof SubmitArgsSchema>

export type SubmitSelectionOptions = Readonly<{
  base?: string
  issue?: string
  title?: string
  description?: string
  /** Opt in to habitant "merge into latest" and every later manual implicit
   * re-merge of this change (see `PR.track`). Only a live change records it: tracking
   * governs future revisions, which a terminal change no longer has. */
  track?: boolean
  draft?: boolean
  props?: ChangeProps
  resolveRevision(ref: string): Promise<string | undefined>
  /** Parent SHAs of one commit in the submission repository. The active-Bay
   * path proves the checked-out head is linear BEFORE the ledger write — the
   * one submit entrance the branch resolver's check never covers. */
  resolveParents?(sha: string): Promise<readonly string[]> | readonly string[]
  run: RunJobOptions
  /** Caller-owned advisory-warning sink for a submission that SUCCEEDS with a
   * caveat (same `readonly string[]` shape the queue list/status envelope uses).
   * The operation appends; the caller renders them in its result envelope. A
   * dirty-worktree submit (D3) pushes one here AND logs it — by-construction
   * loud, not by convention. */
  warnings?: string[]
}>

const CloseBayArgsSchema = z.object({ bay: TextSchema, withdraw: z.boolean().optional() }).strict()
export type CloseBayArgs = z.infer<typeof CloseBayArgsSchema>

const ChangeCloseArgsSchema = z.object({ pr: TextSchema, reason: TextSchema.optional() }).strict()
export type ChangeCloseArgs = z.infer<typeof ChangeCloseArgsSchema>
const ChangeEditArgsSchema = z
  .object({
    pr: TextSchema,
    issue: TextSchema.optional(),
    note: TextSchema.optional(),
    title: TextSchema.optional(),
    description: TextSchema.optional(),
    track: z.boolean().optional(),
  })
  .strict()
  .refine(
    ({ issue, note, title, description, track }) =>
      issue !== undefined ||
      note !== undefined ||
      title !== undefined ||
      description !== undefined ||
      track !== undefined,
    { message: "'issue', 'note', 'title', 'description', or 'track' is required" },
  )
export type ChangeEditArgs = z.infer<typeof ChangeEditArgsSchema>

const ChangeReadyArgsSchema = z
  .object({ pr: TextSchema, expectedCurrent: ChangeExpectedCurrentSchema.optional() })
  .strict()
export type ChangeReadyArgs = z.infer<typeof ChangeReadyArgsSchema>
const ChangeRemergeExpectedCurrentSchema = z
  .object({
    revision: RevisionSchema,
    headSha: GitShaSchema,
    track: z.boolean().optional(),
  })
  .strict()
const ChangeRemergeArgsSchema = z
  .object({
    pr: TextSchema,
    fromRevision: RevisionSchema,
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
    treeSha: GitShaSchema,
    patchId: GitShaSchema,
    reviewCarried: z.boolean(),
    sources: z.array(ChangeRemergeSourceSchema).min(1).readonly().optional(),
    expectedCurrent: ChangeRemergeExpectedCurrentSchema.optional(),
    transition: ChangeFreshnessTransitionSchema.optional(),
  })
  .strict()
export type ChangeRemergeArgs = z.infer<typeof ChangeRemergeArgsSchema>
const ChangeSettleSupersededArgsSchema = z
  .object({
    pr: TextSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
    baseTreeSha: GitShaSchema,
    patchId: GitShaSchema,
  })
  .strict()
export type ChangeSettleSupersededArgs = z.infer<typeof ChangeSettleSupersededArgsSchema>
const ChangeRequestChecksArgsSchema = z
  .object({ pr: TextSchema, baseSha: GitShaSchema.optional(), expectedCurrent: ChangeExpectedCurrentSchema.optional() })
  .strict()
export type ChangeRequestChecksArgs = z.infer<typeof ChangeRequestChecksArgsSchema>
const ChangeRequestReviewArgsSchema = z
  .object({ pr: TextSchema, reviewers: z.array(TextSchema), by: TextSchema.optional() })
  .strict()
export type ChangeRequestReviewArgs = z.infer<typeof ChangeRequestReviewArgsSchema>

const ChangePublicationSubmoduleSchema = z.object({ path: TextSchema, pin: GitShaSchema }).strict()
export const ChangePublicationInputSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
    branch: GitRefSchema,
    sourceRoot: TextSchema,
    components: z.array(ChangePublicationSubmoduleSchema).readonly(),
    continuation: z.enum(["none", "queue"]),
  })
  .strict()
export type ChangePublicationInput = z.infer<typeof ChangePublicationInputSchema>
const PublishedRefSchema = z.object({ path: TextSchema, sha: GitShaSchema, ref: GitRefSchema }).strict()
export const ChangePublicationOutputSchema = z
  .object({ pr: PRIdSchema, revision: RevisionSchema, refs: z.array(PublishedRefSchema).readonly() })
  .strict()
export type ChangePublicationOutput = z.infer<typeof ChangePublicationOutputSchema>
export type ChangePublicationService = Readonly<{
  revision: string
  publish(
    input: ChangePublicationInput,
    context: JobContext,
  ): JobResult<ChangePublicationOutput> | Promise<JobResult<ChangePublicationOutput>>
}>

export function changePublicationJobKey(identity: Pick<ChangePublicationInput, "pr" | "revision" | "headSha">): string {
  return `pr-publication:${identity.pr}:${String(identity.revision)}:${identity.headSha}`
}

const ChangeReviewArgsSchema = z
  .object({
    pr: TextSchema,
    by: TextSchema,
    decision: ChangeReviewDecisionSchema,
    ref: TextSchema.optional(),
    note: TextSchema.optional(),
  })
  .strict()
export type ChangeReviewArgs = z.infer<typeof ChangeReviewArgsSchema>

const ChangeCommentArgsSchema = z
  .object({
    pr: TextSchema,
    by: TextSchema,
    note: TextSchema,
    ref: TextSchema.optional(),
    expectedCurrent: ChangeExpectedCurrentSchema.optional(),
  })
  .strict()
export type ChangeCommentArgs = z.infer<typeof ChangeCommentArgsSchema>

const BayOpenedSchema = z.preprocess(
  normalizeV2By,
  z
    .object({
      id: BayIdSchema,
      name: TextSchema,
      issue: TextSchema.optional(),
      by: TextSchema.optional(),
      from: GitRefSchema.optional(),
      branch: GitRefSchema,
      base: GitRefSchema,
      baseSha: GitShaSchema.optional(),
    })
    .strict(),
)
const BayClosingSchema = z.object({ bay: BayIdSchema }).strict()
const LegacyChangePushedSchema = z
  .object({
    pr: PRIdSchema,
    bay: BayIdSchema.optional(),
    name: TextSchema.optional(),
    issue: TextSchema.optional(),
    branch: GitRefSchema,
    base: GitRefSchema,
    headSha: GitShaSchema,
    baseSha: GitShaSchema.optional(),
    composition: CompositionV1Schema.optional(),
    receipt: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    revision: RevisionSchema,
    props: ChangePropsSchema.optional(),
  })
  .strict()
const ChangeRemergeLineageSchema = z
  .object({ revision: RevisionSchema, headSha: GitShaSchema, baseSha: GitShaSchema.optional() })
  .strict()
const ChangeRemergeReplaySchema = z
  .object({
    pr: PRIdSchema,
    fromRevision: RevisionSchema,
    patchId: GitShaSchema,
    baseSha: GitShaSchema,
    treeSha: GitShaSchema,
    reviewCarried: z.boolean(),
    certificate: ChangeRemergeCertificateSchema.optional(),
    submitter: TextSchema.optional(),
    sources: z.array(ChangeRemergeSourceSchema).min(1).readonly().optional(),
    predecessor: ChangeRemergeLineageSchema,
    successor: ChangeRemergeLineageSchema.extend({ baseSha: GitShaSchema }).strict(),
    composition: CompositionV1Schema.optional(),
    transition: ChangeFreshnessTransitionSchema.optional(),
  })
  .strict()
const ChangeRemergeFactSchema = ChangeRemergeReplaySchema.extend({
  changeId: ChangeIdSchema,
  submitter: TextSchema,
}).strict()
const ChangePushedV1Schema = z.preprocess(
  normalizeLegacyChangeKeys,
  LegacyChangePushedSchema.extend({ submitter: TextSchema }).strict(),
)
const ChangePushedSchema = z.preprocess(
  normalizeLegacyChangeKeys,
  LegacyChangePushedSchema.extend({ changeId: ChangeIdSchema, submitter: TextSchema }).strict(),
)
const ChangePushedReplaySchema = z.preprocess(
  normalizeV1CorrelationToProps,
  z.union([ChangePushedV1Schema, LegacyChangePushedSchema]),
)
const ChangeRevisionIdentitySchema = z
  .object({ pr: PRIdSchema, revision: RevisionSchema, headSha: GitShaSchema })
  .strict()
const LegacyChangeRevisionSchema = ChangeRevisionIdentitySchema.extend({
  props: ChangePropsSchema.optional(),
}).strict()
const ChangeRevisionSchema = z.preprocess(
  normalizeLegacyChangeKeys,
  LegacyChangeRevisionSchema.extend({ submitter: TextSchema, flow: FlowPinSchema.optional() }).strict(),
)
const ChangePropsBoundSchema = z.preprocess(
  normalizeV1CorrelationToProps,
  ChangeRevisionIdentitySchema.extend({ props: ChangePropsSchema }).strict(),
)
const ChangeTerminalIdentitySchema = ChangeRevisionIdentitySchema.extend({
  issueRef: TextSchema.optional(),
  props: ChangePropsSchema.optional(),
}).strict()
const ChangeQueueTerminalIdentitySchema = ChangeTerminalIdentitySchema.extend({ run: TextSchema }).strict()
export const ChangeWithdrawnSchema = z.preprocess(
  normalizeLegacyChangeKeys,
  ChangeTerminalIdentitySchema.extend({
    reason: TextSchema.optional(),
    /** Carried so terminal ball closures can route back to the revision submitter. */
    submitter: TextSchema.optional(),
  }).strict(),
)
const LegacyChangeWithdrawnSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema.optional(),
    headSha: GitShaSchema.optional(),
    props: ChangePropsSchema.optional(),
  })
  .strict()
const LegacyChangeRejectedSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema.optional(),
    props: ChangePropsSchema.optional(),
    detail: z.string().optional(),
  })
  .strict()
const TransitionalChangeRejectedSchema = ChangeQueueTerminalIdentitySchema.extend({
  detail: z.string().optional(),
}).strict()
const ChangeReplayRejectedSchema = z.preprocess(
  normalizeV1CorrelationToProps,
  z.union([ChangeRejectedFactSchema, TransitionalChangeRejectedSchema, LegacyChangeRejectedSchema]),
)
const ChangeIntegratedV1Schema = z.preprocess(
  normalizeLegacyChangeKeys,
  ChangeQueueTerminalIdentitySchema.extend({
    commit: GitShaSchema,
    landingSha: GitShaSchema,
    baseSha: GitShaSchema,
    /** Missing only when a current integration terminates a pre-identity legacy revision. */
    submitter: TextSchema.optional(),
  })
    .strict()
    .refine(({ commit, landingSha }) => commit === landingSha, {
      message: "landingSha must equal the integration proof commit",
      path: ["landingSha"],
    }),
)
export const ChangeIntegratedSchema = z.preprocess(
  normalizeLegacyChangeKeys,
  ChangeQueueTerminalIdentitySchema.extend({
    commit: GitShaSchema,
    landingSha: GitShaSchema,
    baseSha: GitShaSchema,
    changeId: ChangeIdSchema,
    submitter: TextSchema.optional(),
  })
    .strict()
    .refine(({ commit, landingSha }) => commit === landingSha, {
      message: "landingSha must equal the integration proof commit",
      path: ["landingSha"],
    }),
)
const ChangeAlreadyMergedSettlementSchema = z
  .object({
    kind: z.literal("refresh-superseded"),
    proof: z.literal("payload-already-contained"),
    patchId: GitShaSchema,
  })
  .strict()
export const ChangeAlreadyMergedSchema = z.preprocess(
  normalizeLegacyChangeKeys,
  ChangeTerminalIdentitySchema.extend({
    run: TextSchema.optional(),
    settlement: ChangeAlreadyMergedSettlementSchema.optional(),
    baseSha: GitShaSchema,
    candidateSha: GitShaSchema,
    candidateTreeSha: GitShaSchema,
    baseTreeSha: GitShaSchema,
    /** Missing only when a current terminal event closes a pre-identity legacy revision. */
    submitter: TextSchema.optional(),
  })
    .strict()
    .refine(({ run, settlement }) => (run === undefined) !== (settlement === undefined), {
      message: "exactly one of run or settlement is required",
      path: ["run"],
    })
    .refine(({ candidateTreeSha, baseTreeSha }) => candidateTreeSha === baseTreeSha, {
      message: "candidateTreeSha must equal baseTreeSha",
      path: ["candidateTreeSha"],
    }),
)
const LegacyChangeIntegratedSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    commit: GitShaSchema,
    baseSha: GitShaSchema,
    props: ChangePropsSchema.optional(),
  })
  .strict()
export const ChangeCanceledSchema = z.preprocess(
  normalizeLegacyChangeKeys,
  ChangeQueueTerminalIdentitySchema.extend({
    by: TextSchema,
    reason: TextSchema,
    /** Carried so terminal ball closures can route back to the revision submitter. */
    submitter: TextSchema.optional(),
  }).strict(),
)
const LegacyChangeCanceledSchema = ChangeRevisionIdentitySchema.extend({
  props: ChangePropsSchema.optional(),
  by: TextSchema,
  reason: TextSchema,
}).strict()
const ChangeReviewFactSchema = z.preprocess(
  normalizeV2By,
  ChangeReviewSchema.omit({ at: true, carriedFrom: true }).extend({ pr: PRIdSchema }).strict(),
)
const ChangeCommentFactSchema = z.preprocess(
  normalizeV2By,
  z
    .object({
      pr: PRIdSchema,
      revision: RevisionSchema,
      headSha: GitShaSchema,
      by: TextSchema,
      note: TextSchema,
      ref: TextSchema.optional(),
    })
    .strict(),
)
/** Read-only decoders for journals written before Hab session ownership left
 * Yrd. No command can append these facts and projection deliberately ignores
 * them after validation. */
const RetiredChangeSessionStartedFactSchema = z.object({ pr: PRIdSchema, launchId: TextSchema }).strict()
const RetiredChangeSessionEndedFactSchema = RetiredChangeSessionStartedFactSchema.extend({
  outcome: z.enum(["completed", "withdrawn", "crashed", "superseded"]),
}).strict()
const ChangeCheckRequestFactSchema = ChangeRevisionIdentitySchema.extend({ baseSha: GitShaSchema.optional() }).strict()
const ChangeReviewRequestFactSchema = z
  .object({ pr: PRIdSchema, reviewers: z.array(TextSchema), requestedBy: TextSchema })
  .strict()

/** Two unrelated "checkpoint" concepts exist in yrd; this is the BAY one.
 * `BayWorkspace.checkpoint` preserves a bay's working tree (commit + push WIP
 * before recycle). The JOURNAL checkpoint — `projectionCheckpointIdentity` and
 * the checkpoint store in yrd-core/src/app.ts — is a projection-state snapshot
 * keyed by schema identity. They share nothing but the word. */
export type BayWorkspace = Readonly<{
  revision: string
  provision(
    input: ProvisionBayInput,
    context: JobContext,
  ): JobResult<ProvisionedBay> | Promise<JobResult<ProvisionedBay>>
  refresh(input: RefreshBayInput, context: JobContext): JobResult<RefreshedBay> | Promise<JobResult<RefreshedBay>>
  checkpoint(
    input: CheckpointBayInput,
    context: JobContext,
  ): JobResult<CheckpointedBay> | Promise<JobResult<CheckpointedBay>>
  deprovision(
    input: DeprovisionBayInput,
    context: JobContext,
  ): JobResult<DeprovisionedBay> | Promise<JobResult<DeprovisionedBay>>
}>

export type BayJobDefs = Readonly<{
  "bay.provision": JobDef<ProvisionBayInput, ProvisionedBay>
  "bay.refresh": JobDef<RefreshBayInput, RefreshedBay>
  "bay.checkpoint": JobDef<CheckpointBayInput, CheckpointedBay>
  "bay.deprovision": JobDef<DeprovisionBayInput, DeprovisionedBay>
  "pr.publish": JobDef<ChangePublicationInput, ChangePublicationOutput>
}>

export function createBayJobDefs(workspace: BayWorkspace, publication?: ChangePublicationService): BayJobDefs {
  const publisher: ChangePublicationService =
    publication ??
    Object.freeze({
      revision: "publication-unavailable-v1",
      publish: (): JobResult<ChangePublicationOutput> => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "publication-unavailable", message: "PR publication service is not installed" },
      }),
    })
  return Object.freeze({
    "bay.provision": createJobDef({
      name: "bay.provision",
      title: "Provision bay workspace",
      revision: workspace.revision,
      input: ProvisionBayInputSchema,
      output: ProvisionedBaySchema,
      execute: (input, context) => workspace.provision(input, context),
    }),
    "bay.refresh": createJobDef({
      name: "bay.refresh",
      title: "Refresh bay workspace",
      revision: workspace.revision,
      input: RefreshBayInputSchema,
      output: RefreshedBaySchema,
      execute: (input, context) => workspace.refresh(input, context),
    }),
    "bay.checkpoint": createJobDef({
      name: "bay.checkpoint",
      title: "Checkpoint and push bay workspace",
      revision: workspace.revision,
      input: CheckpointBayInputSchema,
      output: CheckpointedBaySchema,
      execute: (input, context) => workspace.checkpoint(input, context),
    }),
    "bay.deprovision": createJobDef({
      name: "bay.deprovision",
      title: "Deprovision bay workspace",
      revision: workspace.revision,
      input: DeprovisionBayInputSchema,
      output: DeprovisionedBaySchema,
      execute: (input, context) => workspace.deprovision(input, context),
    }),
    "pr.publish": createJobDef({
      name: "pr.publish",
      title: "Publish an immutable PR revision",
      revision: publisher.revision,
      input: ChangePublicationInputSchema,
      output: ChangePublicationOutputSchema,
      observe: (input) => ({
        lifecycle: "publication",
        identity: { pr: input.pr, revision: input.revision, headSha: input.headSha },
        attributes: { continuation: input.continuation, submoduleCount: input.components.length },
      }),
      execute: (input, context) => publisher.publish(input, context),
    }),
  })
}

type BayState = Readonly<{ bays: BaysState }>

export type BayCommands = Readonly<{
  bay: Readonly<{
    open: CommandHandler<OpenBayArgs, BayState>
    refresh: CommandHandler<RefreshBayArgs, BayState>
    checkpoint: CommandHandler<CheckpointBayArgs, BayState>
    orphan: CommandHandler<OrphanBayArgs, BayState>
    certifyHandoff: CommandHandler<CertifyHandoffArgs, BayState>
    intake: CommandHandler<IntakeChangeArgs, BayState>
    submit: CommandHandler<SubmitArgs, BayState>
    close: CommandHandler<CloseBayArgs, BayState>
  }>
  pr: Readonly<{
    close: CommandHandler<ChangeCloseArgs, BayState>
    edit: CommandHandler<ChangeEditArgs, BayState>
    recut: CommandHandler<ChangeRemergeArgs, BayState>
    settleSuperseded: CommandHandler<ChangeSettleSupersededArgs, BayState>
    ready: CommandHandler<ChangeReadyArgs, BayState>
    review: CommandHandler<ChangeReviewArgs, BayState>
    comment: CommandHandler<ChangeCommentArgs, BayState>
    requestChecks: CommandHandler<ChangeRequestChecksArgs, BayState>
    recordAdmission: CommandHandler<ChangeAdmissionRecordedFact, BayState>
    requestReview: CommandHandler<ChangeRequestReviewArgs, BayState>
    publish: CommandHandler<ChangePublicationInput, BayState>
  }>
  branch: Readonly<{
    recordSubmit: CommandHandler<BranchSubmit, BayState>
    recordUnsubmit: CommandHandler<BranchUnsubmit, BayState>
  }>
}>

export type Bays = Readonly<{
  state: ReadSignal<DeepReadonly<BaysState>>
  get(selector: string): DeepReadonly<Bay> | undefined
  list(): readonly DeepReadonly<Bay>[]
  branchLifecycles(): readonly DeepReadonly<BranchLifecycle>[]
  pr(selector: string): DeepReadonly<Change> | undefined
  prs(): readonly DeepReadonly<Change>[]
  reviewState(selector: string): DeepReadonly<ChangeReviewState>
  needsReview(selector: string, reviewer?: string): boolean
  checksRequested(selector: string): boolean
  open(args: OpenBayArgs): Promise<CommandResult>
  refresh(args: RefreshBayArgs): Promise<CommandResult>
  checkpoint(args: CheckpointBayArgs): Promise<CommandResult>
  orphan(args: OrphanBayArgs): Promise<CommandResult>
  certifyHandoff(args: CertifyHandoffArgs): Promise<CommandResult>
  intake(args: IntakeChangeArgs): Promise<CommandResult>
  submit(args: SubmitArgs): Promise<CommandResult>
  submitSelection(selector: string, options: SubmitSelectionOptions): Promise<DeepReadonly<Change>>
  /** Live queue SHA `pr create` will consume for this bay — not the historical pin. */
  effectiveBase(selector: string, requestedBase?: string): Promise<BayBaseTarget>
  close(args: CloseBayArgs): Promise<CommandResult>
  closePr(args: ChangeCloseArgs): Promise<CommandResult>
  editPr(args: ChangeEditArgs): Promise<CommandResult>
  recut(args: ChangeRemergeArgs): Promise<CommandResult>
  settleSuperseded(args: ChangeSettleSupersededArgs): Promise<CommandResult>
  ready(args: ChangeReadyArgs): Promise<CommandResult>
  review(args: ChangeReviewArgs): Promise<CommandResult>
  comment(args: ChangeCommentArgs): Promise<CommandResult>
  requestChecks(args: ChangeRequestChecksArgs): Promise<CommandResult>
  recordAdmission(args: ChangeAdmissionRecordedFact): Promise<CommandResult>
  requestReview(args: ChangeRequestReviewArgs): Promise<CommandResult>
  requestPublication(args: ChangePublicationInput): Promise<CommandResult>
  /** The receiver ACCEPTED a `refs/yrd/submit/<branch>` write — project the approval fact. */
  recordBranchSubmit(args: BranchSubmit): Promise<CommandResult>
  /** The receiver removed a submit ref (delete, archival sweep) or a record superseded it. */
  recordBranchUnsubmit(args: BranchUnsubmit): Promise<CommandResult>
}>

export type HasBays = Readonly<{ bays: Bays }>

type BayActions = Pick<
  Bays,
  | "open"
  | "refresh"
  | "checkpoint"
  | "orphan"
  | "certifyHandoff"
  | "intake"
  | "submit"
  | "close"
  | "closePr"
  | "editPr"
  | "recut"
  | "settleSuperseded"
  | "ready"
  | "review"
  | "comment"
  | "requestChecks"
  | "recordAdmission"
  | "requestReview"
  | "requestPublication"
  | "recordBranchSubmit"
  | "recordBranchUnsubmit"
>

export type BayBaseTarget = Readonly<{
  base: string
  baseSha?: string
  remoteBranch?: RemoteBranchSnapshot
}>
export type ResolveBayBaseContext = Readonly<{ branch?: string }>
export type ResolveBayBase = (base: string, context?: ResolveBayBaseContext) => BayBaseTarget | Promise<BayBaseTarget>

function hasBranchReuseProvenance(
  state: DeepReadonly<BaysState>,
  identity: Pick<OpenBayArgs, "name" | "issue">,
  branch: string,
): boolean {
  return (
    Object.values(state.prs).some((pr) => pr.branch === branch && pr.issue === identity.issue && isLiveChange(pr)) ||
    Object.values(state.byId).some(
      (bay) =>
        bay.status === "closed" && bay.branch === branch && bay.name === identity.name && bay.issue === identity.issue,
    )
  )
}

export function createBays(
  state: ReadSignal<DeepReadonly<BaysState>>,
  jobs: Jobs,
  actions: BayActions,
  options: Readonly<{
    defaultBase: string
    resolveBase?: ResolveBayBase
  }>,
  log?: ConditionalLogger,
): Bays {
  const observe = async <Result>(
    lifecycle: YrdLifecycleOptions<Result>,
    operation: () => Result | Promise<Result>,
  ): Promise<Result> => (log === undefined ? operation() : observeYrdLifecycle(log, lifecycle, operation))
  const execute = async (result: CommandResult, options: RunJobOptions, action: string): Promise<void> => {
    const results = await jobs.runMany(jobs.requested(result), options)
    const failed = results.find((job) => job.status !== "completed" || job.conclusion !== "success")
    if (failed !== undefined) {
      raiseFailure("infrastructure", "bay-job-failed", `yrd: ${action} ${failed.status}: ${jobDetail(failed)}`)
    }
  }

  const target = async (
    base: string | undefined,
    baseSha: string | undefined,
    branch?: string,
  ): Promise<BayBaseTarget> => {
    const requested = base ?? options.defaultBase
    const selected =
      options.resolveBase === undefined
        ? { base: requested, ...(baseSha === undefined ? {} : { baseSha }) }
        : await options.resolveBase(requested, branch === undefined ? undefined : { branch })
    const resolved = { ...selected, base: baseIdentity(selected.base) }
    if (resolved.remoteBranch !== undefined && resolved.remoteBranch.branch !== branch) {
      raiseFailure(
        "infrastructure",
        "bay-branch-authority-mismatch",
        `yrd: Bay branch authority resolved '${resolved.remoteBranch.branch}', expected '${branch ?? "none"}'`,
      )
    }
    if (baseSha !== undefined && resolved.baseSha !== undefined && baseSha !== resolved.baseSha) {
      raiseFailure(
        "refusal",
        "base-authority-conflict",
        `yrd: caller pin ${baseSha.slice(0, 12)} contradicts live queue '${resolved.base}' at ${resolved.baseSha.slice(0, 12)}`,
      )
    }
    return { ...resolved, ...(baseSha === undefined ? {} : { baseSha }) }
  }

  const open = async (args: OpenBayArgs): Promise<CommandResult> => {
    const branch = args.branch ?? args.from ?? defaultBayBranch(args.name)
    const reusesKnownBranch =
      args.from === undefined && hasBranchReuseProvenance(state(), { name: args.name, issue: args.issue }, branch)
    const resolved = await target(
      args.base,
      args.baseSha,
      args.from === undefined && (args.issue !== undefined || reusesKnownBranch) ? branch : undefined,
    )
    return actions.open({ ...args, ...resolved })
  }
  const intake = async (args: IntakeChangeArgs): Promise<CommandResult> => {
    const selectedPR = (): DeepReadonly<Change> | undefined => {
      const snapshot = state()
      const bay = args.bay === undefined ? undefined : resolveBay(snapshot, args.bay)
      return bay === undefined
        ? args.branch === undefined
          ? undefined
          : resolveChange(snapshot, args.branch)
        : changeForBay(snapshot, bay.id)
    }
    const before = selectedPR()
    return observe(
      {
        lifecycle: "intake",
        identity: before === undefined ? undefined : changeIdentity(before),
        attributes: {
          ...(args.bay === undefined ? {} : { bay: args.bay }),
          ...(args.branch === undefined ? {} : { branch: args.branch }),
        },
        resultAttributes: () => {
          const selected = selectedPR()
          return selected === undefined ? {} : changeIdentity(selected)
        },
      },
      async () => {
        const bay = args.bay === undefined ? undefined : resolveBay(state(), args.bay)
        const recorded = selectedPR()
        // Historical bay/PR pins are not an authority against the live queue.
        // Only an explicit caller baseSha may contradict resolveBase (AC2).
        const resolved = await target(args.base ?? bay?.base ?? recorded?.base, args.baseSha)
        return actions.intake({ ...args, ...resolved })
      },
    )
  }
  const submitOperation = async (args: SubmitArgs): Promise<CommandResult> => {
    if ("pr" in args) return actions.submit(args)
    const resolved = await target(args.base, args.baseSha)
    return actions.submit({ ...args, ...resolved })
  }
  const submit = (args: SubmitArgs): Promise<CommandResult> => {
    const selector = "pr" in args ? args.pr : args.branch
    const before = resolveChange(state(), selector)
    return observe(
      {
        lifecycle: "submit",
        identity: before === undefined ? undefined : changeIdentity(before),
        attributes: { selector },
        resultAttributes: () => {
          const selected = resolveChange(state(), selector)
          return selected === undefined ? {} : changeIdentity(selected)
        },
      },
      () => submitOperation(args),
    )
  }
  const bindProps = async (pr: DeepReadonly<Change>, props: ChangeProps | undefined): Promise<DeepReadonly<Change>> => {
    if (props === undefined) return pr
    await submitOperation({ pr: pr.id, props })
    const bound = resolveChange(state(), pr.id)
    if (bound === undefined) {
      raiseFailure("infrastructure", "pr-state-invalid", `yrd: change '${pr.id}' disappeared after props bind`)
    }
    return bound
  }
  const bindIssue = async (pr: DeepReadonly<Change>, issue: string | undefined): Promise<DeepReadonly<Change>> => {
    if (issue === undefined || pr.issue === issue) return pr
    if (pr.issue !== undefined) {
      raiseFailure(
        "refusal",
        "issue-conflict",
        `yrd: change '${pr.id}' is already linked to issue '${pr.issue}'; close it before linking another issue`,
      )
    }
    const delivery = changeDeliveryState(pr)
    if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready") {
      raiseFailure(
        "refusal",
        "issue-too-late",
        `yrd: change '${pr.id}' is ${delivery}; issue can only be linked while pushed or submitted`,
      )
    }
    await actions.editPr({ pr: pr.id, issue })
    const bound = resolveChange(state(), pr.id)
    if (bound === undefined) {
      raiseFailure("infrastructure", "pr-state-invalid", `yrd: change '${pr.id}' disappeared after issue bind`)
    }
    return bound
  }
  const bindMetadata = async (
    pr: DeepReadonly<Change>,
    metadata: Pick<SubmitSelectionOptions, "title" | "description" | "track" | "warnings">,
  ): Promise<DeepReadonly<Change>> => {
    const titleChanged = metadata.title !== undefined && metadata.title !== pr.title
    const descriptionChanged = metadata.description !== undefined && metadata.description !== pr.description
    // Tracking only governs FUTURE habitant preparation or a manual implicit
    // re-merge, which a terminal change (an integrated/already-landed same-head
    // resubmit reaches this seam at exit 0) no longer has. Recording it there
    // would refuse the whole submit, so state loudly that the flag was not
    // recorded instead of pretending it was.
    const trackable = isLiveChange(pr)
    const trackChanged = metadata.track !== undefined && metadata.track !== isTracked(pr)
    if (trackChanged && !trackable) {
      const warning =
        `change '${pr.id}' is ${changeDeliveryState(pr)}; --track was NOT recorded. ` +
        "Tracking governs future rebuilds, and this change has none."
      metadata.warnings?.push(warning)
      log?.warn?.(warning, { action: "submit-track-terminal", pr: pr.id })
    }
    const recordTrack = trackChanged && trackable
    if (!titleChanged && !descriptionChanged && !recordTrack) return pr
    await actions.editPr({
      pr: pr.id,
      ...(titleChanged ? { title: metadata.title } : {}),
      ...(descriptionChanged ? { description: metadata.description } : {}),
      ...(recordTrack ? { track: metadata.track } : {}),
    })
    const bound = resolveChange(state(), pr.id)
    if (bound === undefined) {
      raiseFailure("infrastructure", "pr-state-invalid", `yrd: change '${pr.id}' disappeared after metadata bind`)
    }
    return bound
  }
  const bindSubmission = async (
    pr: DeepReadonly<Change>,
    submission: Pick<SubmitSelectionOptions, "issue" | "props">,
  ): Promise<DeepReadonly<Change>> => bindProps(await bindIssue(pr, submission.issue), submission.props)

  const submitSelectionOperation = async (
    selector: string,
    options: SubmitSelectionOptions,
  ): Promise<DeepReadonly<Change>> => {
    let snapshot = state()
    const resolved = resolveChangeMatch(snapshot, selector)
    if (resolved?.revision !== undefined) requireLiveChange(snapshot, selector)
    const selectedBay = resolveBay(snapshot, selector)
    let pr = resolved?.value ?? (selectedBay === undefined ? undefined : resolveChange(snapshot, selectedBay.branch))
    // A closed Bay is archive evidence, not permanent ownership of its branch
    // alias. Addressing that branch again must use the direct-branch delivery
    // path; canonical Bay id/name selectors still resolve the closed Bay and
    // receive the ordinary not-active refusal.
    const closedBranchAlias =
      selectedBay?.status === "closed" && selectedBay.branch.toLowerCase() === selector.toLowerCase()
    let bay = closedBranchAlias
      ? undefined
      : (selectedBay ?? (pr?.bay === undefined ? undefined : resolveBay(snapshot, pr.bay)))
    // D2 — a branch whose PR reached a non-merged terminal status
    // (withdrawn/canceled) mints its next revision automatically down the
    // direct-branch resubmit path below (the reopen preserves the change identity,
    // so branch→PR stays 1:1). The author no longer hand-makes a delivery branch.
    //
    // Q1 — an integrated/already-landed branch identity is FROZEN evidence, never reopened:
    //  - addressed by its branch, resubmitting the SAME merged head is an
    //    informational "already merged" no-op (returns the integrated change, exit
    //    0 — delivered work is not a dark queue), while a NEW head mints a fresh
    //    delivery PR (revision 1) via the direct-branch path below, so no
    //    hand-made `<branch>-delivery-<nonce>` branch is needed;
    //  - addressed by its id, it stays idempotent.
    if (
      pr !== undefined &&
      (changeDeliveryState(pr) === "integrated" || changeDeliveryState(pr) === "already-landed")
    ) {
      // Addressed by its canonical id, an integrated change is frozen evidence:
      // idempotent. Addressed by a moving alias (its branch), a new head mints a
      // fresh delivery. The canonical-vs-alias fold lives in resolveSelectorMatch.
      if (resolved?.matchedBy === "canonical") return bindSubmission(pr, options)
      const mergedHead = await options.resolveRevision(selector)
      if (mergedHead === undefined) {
        raiseFailure("refusal", "git-commit-missing", `yrd: no Git commit '${selector}'`)
      }
      if (mergedHead === changeHead(pr)) return bindSubmission(pr, options)
      // A new head on a merged branch mints a fresh delivery identity below.
    }

    if (bay?.status === "active") {
      // An active Bay asks "which commit is checked out in the managed authored
      // workspace after refresh?" It does not ask what the same branch name
      // currently means on origin; direct/non-active submission asks that
      // remote question through resolveRevision below.
      const refreshed = await actions.refresh({ bay: bay.id })
      await execute(refreshed, options.run, `bay '${bay.id}' refresh`)
      snapshot = state()
      bay = resolveBay(snapshot, bay.id)
      if (bay === undefined) {
        raiseFailure("infrastructure", "bay-state-invalid", `yrd: bay '${selector}' disappeared after refresh`)
      }
      if (bay.dirty === true) {
        // D3 — a dirty worktree no longer refuses the submit. Submit is a ledger
        // write: it records the committed HEAD (resolved just below) and warns
        // loudly that the uncommitted worktree changes are NOT part of this
        // submission. The warning rides the result envelope (options.warnings)
        // AND the log stream — loud by construction, never a silent fallback.
        const warning =
          `Bay '${bay.id}' has uncommitted work; the change includes only committed changes. ` +
          "The uncommitted changes remain in the Bay."
        options.warnings?.push(warning)
        log?.warn?.(warning, { action: "submit-dirty-worktree", bay: bay.id })
      }
      if (bay.headSha === undefined) {
        raiseFailure("refusal", "bay-head-missing", `yrd: bay '${bay.id}' has no committed head to submit`)
      }
      pr = changeForBay(snapshot, bay.id) ?? resolveChange(snapshot, bay.branch)
      const composition = pr === undefined ? undefined : changeComposition(pr)
      if (pr === undefined || changeHead(pr) !== bay.headSha || !sameComposition(composition, changeComposition(pr))) {
        await intake({
          bay: bay.id,
          headSha: bay.headSha,
          ...(options.base === undefined ? {} : { base: options.base }),
          ...(options.issue === undefined ? {} : { issue: options.issue }),
          ...(composition === undefined ? {} : { composition }),
        })
        pr = changeForBay(state(), bay.id) ?? resolveChange(state(), bay.branch)
      }
    }

    // Re-submitting a change that has no LIVE workspace must re-resolve the branch's current tip
    // rather than reuse the recorded revision's head: a pushed (e.g. draft) or submitted PR
    // whose branch has since moved would otherwise re-register the stale head. Only an ACTIVE
    // bay asks for the managed workspace's committed HEAD (handled above); every other shape — bay-less
    // direct branch, and a change whose bay is closing/closed/failed (reachable by PR id or by the
    // retired bay's id, where the closedBranchAlias escape above does not apply) — resolves the
    // branch tip here. Without this, an idempotent retry re-presented the recorded head at
    // exit 0 and an automated driver concluded the carrier matched its branch when it did not.
    if (
      pr !== undefined &&
      (changeDeliveryState(pr) === "submitted" ||
        changeDeliveryState(pr) === "ready" ||
        changeDeliveryState(pr) === "needs-author" ||
        changeDeliveryState(pr) === "pushed") &&
      bay?.status !== "active"
    ) {
      const headSha = await options.resolveRevision(pr.branch)
      if (headSha === undefined && (changeDeliveryState(pr) === "submitted" || changeDeliveryState(pr) === "ready")) {
        // A submitted PR whose branch no longer resolves cannot be re-submitted from a tip.
        raiseFailure("refusal", "git-commit-missing", `yrd: no Git commit '${pr.branch}'`)
      }
      if (headSha !== undefined) {
        const resolved = await target(options.base ?? pr.base, undefined)
        const composition = changeComposition(pr)
        if (
          headSha !== changeHead(pr) ||
          resolved.base !== pr.base ||
          resolved.baseSha !== changeBaseSha(pr) ||
          !sameComposition(composition, changeComposition(pr))
        ) {
          await intake({
            branch: pr.branch,
            headSha,
            ...resolved,
            ...(options.issue === undefined ? {} : { issue: options.issue }),
            ...(composition === undefined ? {} : { composition }),
          })
          pr = resolveChange(state(), pr.id)
          if (pr === undefined) {
            raiseFailure(
              "infrastructure",
              "pr-state-invalid",
              `yrd: change '${selector}' disappeared after revision intake`,
            )
          }
        }
      }
    }

    // Only a live change binds an issue in place. A terminal change resolved here is a
    // withdrawn/canceled branch about to be reopened by the direct-branch
    // resubmit below (D2); its issue rides along when that mint records the
    // fresh revision, so binding here (which refuses on a terminal change) is skipped.
    if (pr !== undefined && isLiveChange(pr)) pr = await bindIssue(pr, options.issue)
    if (
      pr !== undefined &&
      (changeDeliveryState(pr) === "submitted" ||
        changeDeliveryState(pr) === "ready" ||
        changeDeliveryState(pr) === "needs-author")
    ) {
      return bindProps(pr, options.props)
    }
    if (pr !== undefined && changeDeliveryState(pr) === "pushed") {
      pr = await bindProps(pr, options.props)
      if (options.draft === true) return pr
      await submitOperation({ pr: pr.id })
      const submitted = resolveChange(state(), pr.id)
      if (submitted === undefined) {
        raiseFailure("infrastructure", "pr-state-invalid", `yrd: change '${pr.id}' disappeared after submit`)
      }
      return submitted
    }

    if (bay === undefined) {
      const headSha = await options.resolveRevision(selector)
      if (headSha === undefined) {
        raiseFailure("refusal", "git-commit-missing", `yrd: no Git commit '${selector}'`)
      }
      const resolved = await target(options.base, undefined)
      const live = Object.values(snapshot.prs).find(
        (candidate) =>
          (changeDeliveryState(candidate) === "pushed" ||
            changeDeliveryState(candidate) === "submitted" ||
            changeDeliveryState(candidate) === "ready" ||
            changeDeliveryState(candidate) === "needs-author") &&
          changeHead(candidate) === headSha &&
          candidate.base === resolved.base &&
          changeComposition(candidate) === undefined,
      )
      if (live !== undefined) {
        const correlated = await bindSubmission(live, options)
        if (changeDeliveryState(correlated) === "submitted" || changeDeliveryState(correlated) === "ready") {
          return correlated
        }
        if (options.draft === true) return correlated
        await submitOperation({ pr: correlated.id })
        const submitted = resolveChange(state(), live.id)
        if (submitted === undefined) {
          raiseFailure("infrastructure", "pr-state-invalid", `yrd: change '${live.id}' disappeared after submit`)
        }
        return submitted
      }
      await submitOperation({
        branch: selector,
        headSha,
        ...resolved,
        ...(options.issue === undefined ? {} : { issue: options.issue }),
        ...(options.draft === true ? { draft: true } : {}),
        ...(options.props === undefined ? {} : { props: options.props }),
      })
      const submitted = resolveChange(state(), selector)
      if (submitted === undefined) {
        raiseFailure(
          "infrastructure",
          "pr-state-invalid",
          `yrd: direct branch submit '${selector}' did not create a change`,
        )
      }
      return submitted
    }

    if (bay.status !== "active") {
      raiseFailure("refusal", "bay-not-active", `yrd: bay '${bay.id}' is ${bay.status}, not active`)
    }
    if (pr === undefined) {
      raiseFailure("infrastructure", "pr-state-invalid", `yrd: bay '${bay.id}' intake did not create a change`)
    }
    raiseFailure("refusal", "pr-not-pushed", `yrd: change '${pr.id}' is ${changeDeliveryState(pr)}, not pushed`)
  }

  const submitSelection = (selector: string, options: SubmitSelectionOptions): Promise<DeepReadonly<Change>> => {
    const before = resolveChange(state(), selector)
    return observe(
      {
        lifecycle: "submit",
        identity: before === undefined ? undefined : changeIdentity(before),
        attributes: { selector },
        resultAttributes: changeIdentity,
      },
      // Bind the resolved title/description in one seam AFTER the change is
      // materialized, so every submit path (bay, direct branch, resubmit,
      // draft, integrated) records the same metadata without threading it
      // through each early return.
      async () => bindMetadata(await submitSelectionOperation(selector, options), options),
    )
  }

  return Object.freeze({
    state,
    get: (selector) => resolveBay(state(), selector),
    list: () => Object.freeze(Object.values(state().byId)),
    branchLifecycles: () => Object.freeze(projectBranchLifecycles(state())),
    pr: (selector) => resolveChange(state(), selector),
    prs: () => Object.freeze(Object.values(state().prs)),
    reviewState: (selector) => reviewState(required(resolveChange(state(), selector), "change", selector)),
    needsReview: (selector, reviewer) =>
      needsReview(required(resolveChange(state(), selector), "change", selector), reviewer),
    checksRequested: (selector) => checksRequested(required(resolveChange(state(), selector), "change", selector)),
    submitSelection,
    effectiveBase: async (selector, requestedBase) => {
      const snapshot = state()
      const bay = resolveBay(snapshot, selector)
      const baseName = requestedBase ?? bay?.base
      if (baseName === undefined) {
        raiseFailure("refusal", "bay-not-found", `yrd: no bay '${selector}'`)
      }
      return target(baseName, undefined)
    },
    open,
    refresh: actions.refresh,
    checkpoint: actions.checkpoint,
    orphan: actions.orphan,
    certifyHandoff: actions.certifyHandoff,
    intake,
    submit,
    close: actions.close,
    closePr: actions.closePr,
    editPr: actions.editPr,
    recut: actions.recut,
    settleSuperseded: actions.settleSuperseded,
    ready: actions.ready,
    review: actions.review,
    comment: actions.comment,
    requestChecks: actions.requestChecks,
    recordAdmission: actions.recordAdmission,
    requestReview: actions.requestReview,
    requestPublication: actions.requestPublication,
    recordBranchSubmit: actions.recordBranchSubmit,
    recordBranchUnsubmit: actions.recordBranchUnsubmit,
  })
}

export type { PrNumberMint } from "@yrd/persistence"

/** An in-process `PrNumberMint` for tests and deliberately ephemeral
 * compositions. The name is the warning: nothing survives the process, so a
 * production composition wiring this recycles PR numbers on every restart —
 * pass `createDurablePrNumberMint` (@yrd/persistence) there instead. */
export function volatilePrNumberMint(initial = 0): PrNumberMint {
  if (!Number.isSafeInteger(initial) || initial < 0) {
    throw new TypeError(
      `yrd: volatile PR-number mint requires a non-negative safe integer, got ${JSON.stringify(initial)}`,
    )
  }
  let highWater = initial
  return Object.freeze({
    highWater: () => highWater,
    commit(next: number): void {
      if (!Number.isSafeInteger(next) || next <= highWater) {
        throw new Error(
          `yrd: volatile PR-number mint refuses to move its high-water from ${String(highWater)} to ${JSON.stringify(next)}`,
        )
      }
      highWater = next
    },
  })
}

export type WithBaysOptions = Readonly<{
  jobs: BayJobDefs
  /** Durable authority for new PR numbers. Deliberately not optional: an
   * omitted mint would silently degrade to the record-set scan whose recycling
   * this option exists to end (22986). */
  prNumberMint: PrNumberMint
  defaultBase?: string
  defaultSubmitter?: string
  resolveBase?: ResolveBayBase
}>

export function withBays(options: WithBaysOptions) {
  const defaultBase = baseIdentity(options.defaultBase ?? "main")
  const defaultSubmitter = TextSchema.parse(options.defaultSubmitter ?? "operator")
  const commands = createBayCommands(options.jobs, defaultBase, defaultSubmitter, options.prNumberMint)

  return <State extends object, Commands extends CommandTree, Features extends HasJobs>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { bays: emptyBaysState() },
      commands,
      events: {
        // `by` arrived before field-versioning did, so v1 journals in the field
        // already hold rows carrying it. Declaring it at v1 records what was
        // written; the annotation is what keeps that from reading as an
        // oversight.
        "bay/opened": journalEvent(1, BayOpenedSchema, {}, { by: { introducedAt: "53f67709" } }),
        "bay/closing": journalEvent(1, BayClosingSchema),
        "bay/orphaned": journalEvent(1, BayOrphanedSchema),
        "bay/handoff-certified": journalEvent(1, BayHandoffCertifiedSchema),
        "pr/pushed": journalEvent(2, ChangePushedSchema),
        "pr/recut": journalEvent(3, ChangeRemergeFactSchema),
        "pr/submitted": journalEvent(1, ChangeRevisionSchema),
        "pr/props-set": journalEvent(1, ChangePropsBoundSchema),
        // Retired writer: only pre-props journals carry this name. The schema's
        // read-boundary fold maps its correlation pair into props on replay.
        "pr/correlation-bound": journalEvent(1, ChangePropsBoundSchema),
        "pr/withdrawn": journalEvent(1, ChangeWithdrawnSchema),
        "pr/needs-author": journalEvent(1, ChangeNeedsAuthorFactSchema),
        "pr/rejected": journalEvent(1, ChangeRejectedFactSchema),
        "pr/integrated": journalEvent(2, ChangeIntegratedSchema),
        "pr/already-landed": journalEvent(1, ChangeAlreadyMergedSchema),
        "pr/canceled": journalEvent(1, ChangeCanceledSchema),
        "pr/edited": journalEvent(1, ChangeEditArgsSchema),
        "pr/reviewed": journalEvent(1, ChangeReviewFactSchema),
        "pr/commented": journalEvent(1, ChangeCommentFactSchema),
        "pr/session-started": journalEvent(1, RetiredChangeSessionStartedFactSchema),
        "pr/session-ended": journalEvent(1, RetiredChangeSessionEndedFactSchema),
        "pr/checks-requested": journalEvent(1, ChangeCheckRequestFactSchema),
        "pr/admission-recorded": journalEvent(2, ChangeAdmissionRecordedFactSchema),
        "pr/review-requested": journalEvent(1, ChangeReviewRequestFactSchema),
        // branch-is-change phase 2a (@yrd/core/22991; @cto efd1fa9a): the
        // receiver projects an ACCEPTED refs/yrd/submit/<branch> write, and its
        // removal, as journal facts — the queue reads the projection and never
        // enumerates git refs. 2b's bridge is the receiver INTAKING a direct
        // submit-ref push exactly as it intakes refs/for (record created, ref
        // already there); never a second bridge teaching `pr submit` to write
        // the ref. These two events are what make that a small write.
        "branch/submitted": journalEvent(1, BranchSubmitSchema),
        "branch/unsubmitted": journalEvent(1, BranchUnsubmitSchema),
      },
      replayEvents: {
        "pr/pushed": ChangePushedReplaySchema,
        "pr/recut": ChangeRemergeReplaySchema,
        "pr/submitted": z.preprocess(normalizeV1CorrelationToProps, LegacyChangeRevisionSchema),
        "pr/withdrawn": z.preprocess(
          normalizeV1CorrelationToProps,
          z.union([ChangeWithdrawnSchema, LegacyChangeWithdrawnSchema]),
        ),
        "pr/needs-author": ChangeNeedsAuthorFactSchema,
        "pr/rejected": ChangeReplayRejectedSchema,
        "pr/integrated": z.preprocess(
          normalizeV1CorrelationToProps,
          z.union([ChangeIntegratedSchema, ChangeIntegratedV1Schema, LegacyChangeIntegratedSchema]),
        ),
        "pr/already-landed": ChangeAlreadyMergedSchema,
        "pr/canceled": z.preprocess(
          normalizeV1CorrelationToProps,
          z.union([ChangeCanceledSchema, LegacyChangeCanceledSchema]),
        ),
        "pr/admission-recorded": ChangeAdmissionRecordedFactSchema,
      },
      projectionVersion: "bays-v15-retired-regressions",
      project: projectBays,
      create(yrd) {
        yrd.jobs.requireDefinitions(options.jobs)
        const state = computed(() => yrd.state().bays)
        return {
          bays: createBays(
            state,
            yrd.jobs,
            {
              open: (args) => yrd.dispatch(commands.bay.open, args),
              refresh: (args) => yrd.dispatch(commands.bay.refresh, args),
              checkpoint: (args) => yrd.dispatch(commands.bay.checkpoint, args),
              orphan: (args) => yrd.dispatch(commands.bay.orphan, args),
              certifyHandoff: (args) => yrd.dispatch(commands.bay.certifyHandoff, args),
              intake: (args) => yrd.dispatch(commands.bay.intake, args),
              submit: (args) => yrd.dispatch(commands.bay.submit, args),
              close: (args) => yrd.dispatch(commands.bay.close, args),
              closePr: (args) => yrd.dispatch(commands.pr.close, args),
              editPr: (args) => yrd.dispatch(commands.pr.edit, args),
              recut: (args) => yrd.dispatch(commands.pr.recut, args),
              settleSuperseded: (args) => yrd.dispatch(commands.pr.settleSuperseded, args),
              ready: (args) => yrd.dispatch(commands.pr.ready, args),
              review: (args) => yrd.dispatch(commands.pr.review, args),
              comment: (args) => yrd.dispatch(commands.pr.comment, args),
              requestChecks: (args) => yrd.dispatch(commands.pr.requestChecks, args),
              recordAdmission: (args) => yrd.dispatch(commands.pr.recordAdmission, args),
              requestReview: (args) => yrd.dispatch(commands.pr.requestReview, args),
              requestPublication: (args) => yrd.dispatch(commands.pr.publish, args),
              recordBranchSubmit: (args) => yrd.dispatch(commands.branch.recordSubmit, args),
              recordBranchUnsubmit: (args) => yrd.dispatch(commands.branch.recordUnsubmit, args),
            },
            {
              defaultBase,
              ...(options.resolveBase === undefined ? {} : { resolveBase: options.resolveBase }),
            },
            yrd.log.child("bay"),
          ),
        }
      },
    })
}

function changeIdentity(pr: DeepReadonly<Change>): YrdDeliveryIdentity {
  return {
    pr: pr.id,
    revision: changeRevisionNumber(pr),
    headSha: changeHead(pr),
    ...(changeProps(pr) === undefined ? {} : { props: changeProps(pr) }),
  }
}

function jobDetail(job: DeepReadonly<Job>): string {
  if (job.status === "completed" && job.conclusion === "failure") return job.error.message
  if (job.status === "completed" && job.conclusion === "timed_out") return job.lostReason
  if (job.status === "completed" && job.conclusion === "cancelled") return job.cancelReason
  if (job.status === "waiting") return job.detail ?? job.status
  return job.status
}

function createBayCommands(
  jobs: BayJobDefs,
  defaultBase: string,
  defaultSubmitter: string,
  prNumberMint: PrNumberMint,
): BayCommands {
  return {
    bay: {
      open: command({
        title: "Open bay",
        visibility: "public",
        params: OpenBayArgsSchema,
        apply: (state: BayState, args: OpenBayArgs) => openBay(state, args, defaultBase, jobs["bay.provision"]),
      }),
      refresh: command({
        title: "Refresh bay",
        visibility: "public",
        params: RefreshBayArgsSchema,
        apply: (state: BayState, args: RefreshBayArgs) => refreshBay(state, args, jobs["bay.refresh"]),
      }),
      checkpoint: command({
        title: "Checkpoint bay",
        params: CheckpointBayArgsSchema,
        apply: (state: BayState, args: CheckpointBayArgs) => checkpointBay(state, args, jobs["bay.checkpoint"]),
      }),
      orphan: command({
        title: "Record an orphaned bay",
        params: OrphanBayArgsSchema,
        apply: (state: BayState, args: OrphanBayArgs) => orphanBay(state, args),
      }),
      certifyHandoff: command({
        title: "Certify a materialized Bay handoff",
        visibility: "public",
        params: CertifyHandoffArgsSchema,
        apply: (state: BayState, args: CertifyHandoffArgs) => certifyBayHandoff(state, args),
      }),
      intake: command({
        title: "Record pushed revision",
        params: IntakeChangeArgsSchema,
        apply: (state: BayState, args: IntakeChangeArgs, context) =>
          intakePR(state, args, defaultBase, defaultSubmitter, prNumberMint, context.command.id),
      }),
      submit: command({
        title: "Submit work",
        visibility: "public",
        params: SubmitArgsSchema,
        apply: (state: BayState, args: SubmitArgs, context) =>
          submitWork(state, args, defaultBase, defaultSubmitter, prNumberMint, context.command.id),
      }),
      close: command({
        title: "Close bay",
        visibility: "public",
        params: CloseBayArgsSchema,
        apply: (state: BayState, args: CloseBayArgs) => closeBay(state, args, jobs["bay.deprovision"]),
      }),
    },
    pr: {
      close: command({
        title: "Close a change",
        visibility: "public",
        params: ChangeCloseArgsSchema,
        apply: (state: BayState, args: ChangeCloseArgs) => closePr(state, args),
      }),
      edit: command({
        title: "Edit a change",
        visibility: "public",
        params: ChangeEditArgsSchema,
        apply: (state: BayState, args: ChangeEditArgs) => editPr(state, args),
      }),
      // The R-b escape hatch (5e unit 8): the CLI verb is retired, but this
      // public command remains the sanctioned drill for untracked changes,
      // wedge repair, and pre-TD adoption — the habitant's self-remedy
      // machine and any surviving printed recut drill dispatch through it.
      // Death condition: this command dies when the last pre-TD draft is
      // adopted or withdrawn (adoption census 0). Comment only — no mechanism.
      recut: command({
        title: "Record a mechanically equivalent PR re-merge",
        visibility: "public",
        params: ChangeRemergeArgsSchema,
        apply: (state: BayState, args: ChangeRemergeArgs) => remergeChange(state, args, defaultSubmitter),
      }),
      settleSuperseded: command({
        title: "Settle a queued PR whose payload current main already contains",
        params: ChangeSettleSupersededArgsSchema,
        apply: (state: BayState, args: ChangeSettleSupersededArgs) => settleSupersededPr(state, args),
      }),
      ready: command({
        title: "Mark a change ready",
        visibility: "public",
        params: ChangeReadyArgsSchema,
        apply: (state: BayState, args: ChangeReadyArgs) => readyPr(state, args, defaultSubmitter, prNumberMint),
      }),
      review: command({
        title: "Review a change revision",
        visibility: "public",
        params: ChangeReviewArgsSchema,
        apply: (state: BayState, args: ChangeReviewArgs) => reviewPr(state, args),
      }),
      comment: command({
        title: "Comment on a change revision",
        visibility: "public",
        params: ChangeCommentArgsSchema,
        apply: (state: BayState, args: ChangeCommentArgs) => commentPr(state, args),
      }),
      requestChecks: command({
        title: "Request checks for a change revision",
        params: ChangeRequestChecksArgsSchema,
        apply: (state: BayState, args: ChangeRequestChecksArgs) => requestChangeChecks(state, args),
      }),
      recordAdmission: command({
        title: "Record checks-before-queueing evidence for a change revision",
        params: ChangeAdmissionRecordedFactSchema,
        apply: (state: BayState, args: ChangeAdmissionRecordedFact) => recordChangeAdmission(state, args),
      }),
      requestReview: command({
        title: "Replace the requested reviewers for a change",
        visibility: "public",
        params: ChangeRequestReviewArgsSchema,
        apply: (state: BayState, args: ChangeRequestReviewArgs) => requestChangeReview(state, args, defaultSubmitter),
      }),
      publish: command({
        title: "Request immutable PR publication",
        params: ChangePublicationInputSchema,
        apply: (state: BayState, args: ChangePublicationInput) =>
          requestChangePublication(state, args, jobs["pr.publish"]),
      }),
    },
    branch: {
      // The receiver is the only legitimate caller of these two: it has already
      // accepted (or swept) the git ref when it dispatches them, so neither
      // command validates liveness again — a second judge of the same fact
      // would be the second derivation 22895 exists to delete. A branch that
      // never had a standing submit can still be "unsubmitted" (the archival
      // sweep names every scope ref it clears); that is a no-op projection,
      // not a refusal, because the receiver's sweep is already atomic.
      recordSubmit: command({
        title: "Project an accepted refs/yrd/submit/<branch> write",
        params: BranchSubmitSchema,
        apply: (_state: BayState, args: BranchSubmit) => ({ events: [event("branch/submitted", args)] }),
      }),
      recordUnsubmit: command({
        title: "Project a removed refs/yrd/submit/<branch> ref",
        params: BranchUnsubmitSchema,
        apply: (state: BayState, args: BranchUnsubmit) =>
          state.bays.submits[args.branch] === undefined
            ? { events: [] }
            : { events: [event("branch/unsubmitted", args)] },
      }),
    },
  }
}

function requestChangePublication(
  state: DeepReadonly<BayState>,
  args: ChangePublicationInput,
  publication: BayJobDefs["pr.publish"],
) {
  const pr = required(resolveChange(state.bays, args.pr), "change", args.pr)
  const revision = currentChangeRev(pr)
  if (changeDeliveryState(pr) !== "pushed") {
    raiseFailure(
      "refusal",
      "publication-pr-not-draft",
      `yrd: change '${pr.id}' is ${changeDeliveryState(pr)}, not pushed`,
    )
  }
  if (revision.n !== args.revision || revision.head !== args.headSha || pr.branch !== args.branch) {
    raiseFailure(
      "refusal",
      "publication-revision-moved",
      `yrd: change '${pr.id}' is revision ${revision.n} head '${revision.head}' on '${pr.branch}', not requested ` +
        `revision ${args.revision} head '${args.headSha}' on '${args.branch}'`,
    )
  }
  if (changeBaseSha(pr) !== args.baseSha) {
    raiseFailure(
      "refusal",
      "publication-base-moved",
      `yrd: change '${pr.id}' base is '${changeBaseSha(pr) ?? "missing"}', not requested '${args.baseSha}'`,
    )
  }
  return { events: [publication.request(args, { key: changePublicationJobKey(args) })] }
}

function openBay(
  state: DeepReadonly<BayState>,
  args: OpenBayArgs,
  defaultBase: string,
  provision: BayJobDefs["bay.provision"],
) {
  if (args.by === undefined) throw new Error("yrd: Bay open requires non-empty 'by'")
  const current = state.bays
  if (Object.values(current.byId).some((bay) => bay.status !== "closed" && bay.name === args.name)) {
    throw new Error(`yrd: bay '${args.name}' is already open`)
  }
  const id = nextId("B", current.byId)
  const base = baseIdentity(args.base ?? defaultBase)
  const branch = args.branch ?? args.from ?? defaultBayBranch(args.name)
  // A Bay's pushes reach materializeCarrier, which fast-forwards
  // refs/heads/<branch> under a compare-and-swap. On a Bay whose branch IS its
  // base that makes the Bay a second writer to the mainline ref, which the
  // queue has to own alone — so refuse at open, the one place a Bay's branch
  // and base are ever chosen (`bay/opened` has no other emitter, and no later
  // Bay event rewrites either field). `base` arrives canonical — createBays'
  // own `target` runs baseIdentity over it — so the branch side needs the same
  // treatment for `origin/main` to be recognized as the ref `main` names.
  if (baseIdentity(branch) === base) {
    raiseFailure(
      "refusal",
      "bay-branch-equals-base",
      `yrd: a bay's branch must differ from its base; branch '${branch}' and base '${base}' are the same ref`,
    )
  }
  if (Object.values(current.byId).some((bay) => bay.status !== "closed" && bay.branch === branch)) {
    throw new Error(`yrd: branch '${branch}' is already open in another bay`)
  }
  const reuseBranch = hasBranchReuseProvenance(current, { name: args.name, issue: args.issue }, branch)
  const opened = {
    id,
    name: args.name,
    ...(args.issue === undefined ? {} : { issue: args.issue }),
    ...(args.by === undefined ? {} : { by: args.by }),
    ...(args.from === undefined ? {} : { from: args.from }),
    ...(args.baseSha === undefined ? {} : { baseSha: args.baseSha }),
    branch,
    base,
  }
  return {
    events: [
      event("bay/opened", opened),
      provision.request({
        bay: id,
        name: args.name,
        branch,
        base,
        ...(args.baseSha === undefined ? {} : { baseSha: args.baseSha }),
        ...(args.from === undefined ? {} : { from: args.from }),
        ...(args.issue === undefined ? {} : { issue: args.issue }),
        ...(reuseBranch ? { reuseBranch: true } : {}),
        ...(args.remoteBranch === undefined ? {} : { remoteBranch: args.remoteBranch }),
      }),
    ],
  }
}

function refreshBay(state: DeepReadonly<BayState>, args: RefreshBayArgs, refresh: BayJobDefs["bay.refresh"]) {
  const bay = required(resolveBay(state.bays, args.bay), "bay", args.bay)
  if (bay.status !== "active") throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
  return {
    events: [
      refresh.request({
        bay: bay.id,
        ...(bay.path === undefined ? {} : { path: bay.path }),
        branch: bay.branch,
        ...(bay.from === undefined ? {} : { from: bay.from }),
        base: bay.base,
      }),
    ],
  }
}

function checkpointBay(
  state: DeepReadonly<BayState>,
  args: CheckpointBayArgs,
  checkpoint: BayJobDefs["bay.checkpoint"],
) {
  const bay = required(resolveBay(state.bays, args.bay), "bay", args.bay)
  if (bay.status !== "active") throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
  return {
    events: [
      checkpoint.request({
        bay: bay.id,
        ...(bay.path === undefined ? {} : { path: bay.path }),
        branch: bay.branch,
        ...(bay.from === undefined ? {} : { from: bay.from }),
        claim: args.claim,
      }),
    ],
  }
}

function orphanBay(state: DeepReadonly<BayState>, args: OrphanBayArgs) {
  const bay = required(resolveBay(state.bays, args.bay), "bay", args.bay)
  if (bay.status === "closed") throw new Error(`yrd: bay '${bay.id}' is closed, not recoverable`)
  return {
    events: [
      event("bay/orphaned", {
        ...args,
        bay: bay.id,
      }),
    ],
  }
}

function certifyBayHandoff(state: DeepReadonly<BayState>, args: CertifyHandoffArgs) {
  const bay = required(resolveBay(state.bays, args.bay), "bay", args.bay)
  if (bay.status !== "active") throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
  if (bay.branch !== args.branch) {
    throw new Error(`yrd: certified branch '${args.branch}' does not match current branch '${bay.branch}'`)
  }
  if (bay.headSha !== args.headSha) {
    throw new Error(
      `yrd: certified head '${args.headSha}' does not match current head '${bay.headSha ?? "unknown"}' for bay '${bay.id}'`,
    )
  }
  if (bay.handoff?.evidence === args.evidence) {
    if (bay.handoff.headSha === args.headSha) return { events: [] }
    throw new Error(`yrd: certificate '${args.evidence}' already certifies a different bay head`)
  }
  return {
    events: [
      event("bay/handoff-certified", {
        bay: bay.id,
        branch: bay.branch,
        headSha: args.headSha,
        evidence: args.evidence,
      }),
    ],
  }
}

function requireExpectedChangeCurrent(
  state: DeepReadonly<BaysState>,
  expected: ChangeExpectedCurrent,
  operation: "intake" | "submit" | "ready" | "request-checks" | "comment",
): LiveChange {
  const pr = resolveChange(state, expected.pr)
  const matches =
    pr !== undefined &&
    isLiveChange(pr) &&
    changeRevisionNumber(pr) === expected.revision &&
    changeHead(pr) === expected.headSha &&
    (expected.track === undefined || isTracked(pr) === expected.track)
  if (matches) return pr as LiveChange
  const actual =
    pr === undefined
      ? "missing"
      : `${changeDeliveryState(pr)} revision ${changeRevisionNumber(pr)}@${changeHead(pr)} track=${String(isTracked(pr))}`
  const expectedTracking = expected.track === undefined ? "" : ` track=${String(expected.track)}`
  raiseFailure(
    "refusal",
    `${operation}-current-changed`,
    `yrd: change '${expected.pr}' changed from revision ${expected.revision}@${expected.headSha}` +
      `${expectedTracking} to ${actual} before ${operation}`,
  )
}

function requireExpectedChangeTargetCurrent(
  state: DeepReadonly<BaysState>,
  target: string,
  expected: ChangeExpectedCurrent,
  operation: "submit" | "ready" | "request-checks" | "comment",
): LiveChange {
  const pr = requireExpectedChangeCurrent(state, expected, operation)
  const targetPr = resolveChange(state, target)
  if (targetPr?.id === pr.id) return pr
  raiseFailure(
    "refusal",
    `${operation}-current-changed`,
    `yrd: expected change '${pr.id}' does not match ${operation} target '${target}'`,
  )
}

function changeIdForRevision(existing: DeepReadonly<Change> | undefined, commandId: string): ChangeId {
  if (existing === undefined) return changeIdForCommand(commandId)
  const changeId = currentChangeRev(existing).changeId
  if (changeId !== undefined) return changeId
  raiseFailure(
    "refusal",
    "legacy-change-id-missing",
    `yrd: change '${existing.id}' predates stable Change-Id identity; migrate it before rebuilding`,
  )
}

function intakePR(
  state: DeepReadonly<BayState>,
  args: IntakeChangeArgs,
  defaultBase: string,
  defaultSubmitter: string,
  mint: PrNumberMint,
  commandId: string,
) {
  const current = state.bays
  const bay = args.bay === undefined ? undefined : required(resolveBay(current, args.bay), "bay", args.bay)
  if (bay !== undefined && bay.status !== "active") throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
  const branch = args.branch ?? bay?.branch
  if (branch === undefined) throw new Error("yrd: bay.intake: 'bay' or 'branch' is required")
  const expected =
    args.expectedCurrent === undefined
      ? undefined
      : requireExpectedChangeCurrent(current, args.expectedCurrent, "intake")
  if (expected !== undefined && expected.branch !== branch) {
    raiseFailure(
      "refusal",
      "intake-current-changed",
      `yrd: expected change '${expected.id}' branch '${expected.branch}' does not match intake branch '${branch}'`,
    )
  }
  const associated = bay === undefined ? undefined : changeForBay(current, bay.id)
  const branchPR = resolveChange(current, branch)
  const existing = associated ?? (branchPR !== undefined && isLiveChange(branchPR) ? branchPR : undefined)
  // An omitted receiver base belongs to the recorded PR before the process
  // default. Otherwise replaying an unchanged needs-author PR against a
  // non-default base silently looks like a new authored revision.
  const base = baseIdentity(args.base ?? bay?.base ?? existing?.base ?? defaultBase)
  if (args.receipt !== undefined) {
    const received = current.receipts[args.receipt]
    if (received !== undefined) {
      const matches =
        received.branch === branch &&
        received.headSha === args.headSha &&
        received.base === base &&
        received.baseSha === args.baseSha &&
        sameComposition(received.composition, args.composition)
      if (!matches) throw new Error(`yrd: receiver result '${args.receipt}' does not match its recorded intake`)
      return { events: [] }
    }
  }
  if (existing !== undefined && !isLiveChange(existing)) {
    throw new Error(`yrd: change '${existing.id}' is ${changeDeliveryState(existing)}; start a new bay`)
  }
  const issue = attachedIssue(existing, args.issue, bay?.issue)
  const name = args.name ?? bay?.name ?? existing?.name
  // Omitted receiver fields inherit the recorded payload for idempotence, while
  // an explicit base/composition delta remains an authored re-merge and may resume
  // the change. Display-name drift alone never mints a content revision.
  const replayBaseSha = args.baseSha ?? (existing === undefined ? undefined : changeBaseSha(existing))
  const replayComposition = args.composition ?? (existing === undefined ? undefined : changeComposition(existing))
  refuseDuplicatePayload(current, args.headSha, base, replayComposition, existing?.id)
  const resumesSubmission =
    existing !== undefined &&
    (changeNeedsAuthor(existing) !== undefined || changeDeliveryState(existing) === "rejected")
  const submitsRevision = args.submit === true || resumesSubmission
  if (
    existing !== undefined &&
    changeHead(existing) === args.headSha &&
    baseIdentity(existing.base) === base &&
    changeBaseSha(existing) === replayBaseSha &&
    sameComposition(changeComposition(existing), replayComposition) &&
    existing.issue === issue
  ) {
    return { events: [] }
  }
  const id = existing?.id ?? mintChangeId(mint, current.prs)
  const changeId = changeIdForRevision(existing, commandId)
  const submitter = args.submitter ?? defaultSubmitter
  const revision = (existing === undefined ? 0 : changeRevisionNumber(existing)) + 1
  const pushed = {
    pr: id,
    changeId,
    ...(bay === undefined ? {} : { bay: bay.id }),
    ...(name === undefined ? {} : { name }),
    ...(issue === undefined ? {} : { issue }),
    branch,
    base,
    headSha: args.headSha,
    ...(replayBaseSha === undefined ? {} : { baseSha: replayBaseSha }),
    ...(replayComposition === undefined ? {} : { composition: replayComposition }),
    ...(args.receipt === undefined ? {} : { receipt: args.receipt }),
    revision,
    submitter,
  }
  return {
    events: [
      event("pr/pushed", pushed),
      ...(submitsRevision
        ? [
            event("pr/submitted", { pr: id, revision, headSha: args.headSha, submitter }),
            event("pr/checks-requested", {
              pr: id,
              revision,
              headSha: args.headSha,
              ...(replayBaseSha === undefined ? {} : { baseSha: replayBaseSha }),
            }),
          ]
        : []),
    ],
  }
}

function submitWork(
  state: DeepReadonly<BayState>,
  args: SubmitArgs,
  defaultBase: string,
  defaultSubmitter: string,
  mint: PrNumberMint,
  commandId?: string,
) {
  const current = state.bays
  if ("pr" in args) {
    // Submit-by-id routes through the same live guard as the other 9 mutating
    // verbs (no resolve exemption): an id-addressed terminal change passes through
    // (matchedBy canonical) to the state check below; a live-less branch
    // selector refuses no-live-pr here. The D2/Q1 terminal-branch reopen/mint
    // semantics live entirely in the {branch} path and submitSelectionOperation,
    // never this {pr} path, so no pre-guard resolution is needed here.
    const pr: LiveChange =
      args.expectedCurrent === undefined
        ? requireLiveChange(current, args.pr)
        : requireExpectedChangeTargetCurrent(current, args.pr, args.expectedCurrent, "submit")
    if (args.props !== undefined) return bindChangeProps(pr, args.props)
    if (changeDeliveryState(pr) !== "pushed") {
      throw new Error(`yrd: change '${pr.id}' is ${changeDeliveryState(pr)}, not pushed`)
    }
    return {
      events: [
        event("pr/submitted", {
          pr: pr.id,
          ...revisionIdentity(pr),
          submitter: args.submitter ?? defaultSubmitter,
          ...(args.flow === undefined ? {} : { flow: args.flow }),
        }),
      ],
    }
  }

  const existing = resolveChange(current, args.branch)
  const resumesSubmission =
    existing !== undefined &&
    (changeNeedsAuthor(existing) !== undefined || changeDeliveryState(existing) === "rejected")
  const base = baseIdentity(args.base ?? (resumesSubmission ? existing.base : defaultBase))
  if (
    existing !== undefined &&
    !resumesSubmission &&
    (changeDeliveryState(existing) === "pushed" ||
      changeDeliveryState(existing) === "submitted" ||
      changeDeliveryState(existing) === "ready")
  ) {
    throw new Error(`yrd: branch '${args.branch}' already has live change '${existing.id}'`)
  }
  const baseSha = args.baseSha ?? (resumesSubmission ? changeBaseSha(existing) : undefined)
  const composition = resumesSubmission ? changeComposition(existing) : undefined
  if (
    resumesSubmission &&
    changeHead(existing) === args.headSha &&
    baseIdentity(existing.base) === base &&
    changeBaseSha(existing) === baseSha &&
    sameComposition(changeComposition(existing), composition)
  ) {
    return { events: [] }
  }
  refuseDuplicatePayload(current, args.headSha, base, composition, existing?.id)
  // D2 — reopen the existing PR identity (next revision) for a non-merged
  // terminal branch, not just a rejected one. `rejected` already reopened;
  // `withdrawn`/`canceled` now do too, so resubmitting the branch mints the
  // next revision in place instead of demanding a hand-made delivery branch.
  // The pr/pushed projection clears the terminal markers on reopen. `pushed`/
  // `submitted` are already refused above, and `integrated`/`already-landed` are intercepted by
  // the terminal-branch guard before this path (its redelivery is parked).
  const resubmitted =
    existing !== undefined &&
    (changeNeedsAuthor(existing) !== undefined ||
      (["rejected", "withdrawn", "canceled"] as const).includes(
        changeDeliveryState(existing) as "rejected" | "withdrawn" | "canceled",
      ))
      ? existing
      : undefined
  if (commandId === undefined) {
    raiseFailure("infrastructure", "change-id-command-missing", "yrd: change creation requires its durable command id")
  }
  const id = resubmitted?.id ?? mintChangeId(mint, current.prs)
  const changeId = changeIdForRevision(resubmitted, commandId)
  const revision = (resubmitted === undefined ? 0 : changeRevisionNumber(resubmitted)) + 1
  const issue = attachedIssue(resubmitted, args.issue)
  const submitter = args.submitter ?? defaultSubmitter
  const pushed = {
    pr: id,
    changeId,
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(issue === undefined ? {} : { issue }),
    branch: args.branch,
    base,
    headSha: args.headSha,
    ...(baseSha === undefined ? {} : { baseSha }),
    ...(args.props === undefined ? {} : { props: args.props }),
    ...(composition === undefined ? {} : { composition }),
    revision,
    submitter,
  }
  return {
    events: [
      event("pr/pushed", pushed),
      ...(args.draft === true
        ? []
        : [
            event("pr/submitted", {
              pr: id,
              revision,
              headSha: args.headSha,
              submitter,
              ...(args.flow === undefined ? {} : { flow: args.flow }),
              ...(args.props === undefined ? {} : { props: args.props }),
            }),
          ]),
      ...(args.reviewers === undefined || args.reviewers.length === 0
        ? []
        : [event("pr/review-requested", { pr: id, reviewers: args.reviewers, requestedBy: submitter })]),
    ],
  }
}

function propsEqual(left: DeepReadonly<ChangeProps>, right: DeepReadonly<ChangeProps>): boolean {
  const entries = Object.entries(left)
  return entries.length === Object.keys(right).length && entries.every(([key, value]) => right[key] === value)
}

/** True when every entry of `next` is already recorded with the same value. */
function propsCovered(current: DeepReadonly<ChangeProps> | undefined, next: DeepReadonly<ChangeProps>): boolean {
  return current !== undefined && Object.entries(next).every(([key, value]) => current[key] === value)
}

/** The first key `next` would overwrite with a different value, if any. */
function propsConflictKey(
  current: DeepReadonly<ChangeProps> | undefined,
  next: DeepReadonly<ChangeProps>,
): string | undefined {
  if (current === undefined) return undefined
  for (const [key, value] of Object.entries(next)) {
    const existing = current[key]
    if (existing !== undefined && existing !== value) return key
  }
  return undefined
}

function propsLabel(props: DeepReadonly<ChangeProps>): string {
  return Object.entries(props)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")
}

function bindChangeProps(pr: DeepReadonly<Change>, props: ChangeProps) {
  const currentProps = changeProps(pr)
  if (propsCovered(currentProps, props)) return { events: [] }
  const conflict = propsConflictKey(currentProps, props)
  if (conflict !== undefined) {
    raiseFailure(
      "refusal",
      "prop-conflict",
      `yrd: change '${pr.id}' already carries prop '${conflict}=${currentProps?.[conflict]}'; a prop is a fact, set once`,
    )
  }
  const delivery = changeDeliveryState(pr)
  if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready" && delivery !== "needs-author") {
    raiseFailure(
      "refusal",
      "prop-too-late",
      `yrd: change '${pr.id}' is ${delivery}; props can only be set while pushed, submitted, or needs-author`,
    )
  }
  return {
    events: [
      event("pr/props-set", {
        pr: pr.id,
        revision: changeRevisionNumber(pr),
        headSha: changeHead(pr),
        props,
      }),
    ],
  }
}

function revisionIdentity(pr: DeepReadonly<Change>) {
  return {
    revision: changeRevisionNumber(pr),
    headSha: changeHead(pr),
    ...(changeProps(pr) === undefined ? {} : { props: changeProps(pr) }),
  }
}

function currentRevisionSubmitter(pr: DeepReadonly<Change>): string | undefined {
  return currentChangeRev(pr).submitter
}

function terminalIdentity(pr: DeepReadonly<Change>) {
  const submitter = currentRevisionSubmitter(pr)
  return {
    ...revisionIdentity(pr),
    ...(pr.issue === undefined ? {} : { issueRef: pr.issue }),
    ...(submitter === undefined ? {} : { submitter }),
  }
}

function attachedIssue(
  existing: DeepReadonly<Change> | undefined,
  requested: string | undefined,
  fallback?: string,
): string | undefined {
  if (existing?.issue !== undefined && requested !== undefined && existing.issue !== requested) {
    raiseFailure(
      "refusal",
      "issue-conflict",
      `yrd: change '${existing.id}' is already linked to issue '${existing.issue}'; close it before linking another issue`,
    )
  }
  return requested ?? existing?.issue ?? fallback
}

function propsPatch(pr: DeepReadonly<Change>, props: DeepReadonly<ChangeProps>) {
  return {
    revs: pr.revs.map((revision) =>
      revision.n === changeRevisionNumber(pr) && revision.head === changeHead(pr)
        ? { ...revision, props: { ...props } }
        : revision,
    ),
  }
}

function assertTerminalApplies(
  pr: DeepReadonly<Change>,
  terminal: Readonly<{ revision?: number; headSha?: string; issueRef?: string; props?: ChangeProps }>,
  eventName: string,
): void {
  const currentProps = changeProps(pr)
  if (
    (terminal.revision !== undefined && terminal.revision !== changeRevisionNumber(pr)) ||
    (terminal.headSha !== undefined && terminal.headSha !== changeHead(pr))
  ) {
    throw new Error(
      `yrd: stale terminal '${eventName}' for change '${pr.id}' targets ${terminal.revision ?? "unknown"}@${terminal.headSha ?? "unknown"}; current is ${changeRevisionNumber(pr)}@${changeHead(pr)}`,
    )
  }
  if (terminal.issueRef !== undefined && terminal.issueRef !== pr.issue) {
    throw new Error(`yrd: terminal issue '${terminal.issueRef}' does not match change '${pr.id}'`)
  }
  if (terminal.props !== undefined && (currentProps === undefined || !propsEqual(currentProps, terminal.props))) {
    throw new Error(`yrd: terminal props does not match change '${pr.id}'`)
  }
}

function associateRejectedTerminalRun(
  pr: DeepReadonly<Change>,
  identity: Readonly<{ revision: number; headSha: string }>,
  run: string,
): Change {
  let found = false
  const revisions = pr.revs.map((revision) => {
    if (revision.n !== identity.revision || revision.head !== identity.headSha) return revision
    found = true
    if (revision.terminal?.kind !== "rejected") {
      throw new Error(
        `yrd: change '${pr.id}' revision ${identity.revision}@${identity.headSha} has no rejected terminal to associate`,
      )
    }
    if (revision.terminal.run !== undefined && revision.terminal.run !== run) {
      throw new Error(
        `yrd: change '${pr.id}' revision ${identity.revision}@${identity.headSha} is already associated with '${revision.terminal.run}'`,
      )
    }
    return { ...revision, terminal: { ...revision.terminal, run } }
  })
  if (!found) {
    throw new Error(`yrd: change '${pr.id}' has no revision ${identity.revision}@${identity.headSha} to associate`)
  }
  const current = changeRevisionNumber(pr) === identity.revision && changeHead(pr) === identity.headSha
  if (current && changeDeliveryState(pr) !== "rejected") {
    throw new Error(`yrd: current change '${pr.id}' is ${changeDeliveryState(pr)}, not rejected`)
  }
  if (current && pr.terminalRun !== undefined && pr.terminalRun !== run) {
    throw new Error(`yrd: current change '${pr.id}' is already associated with '${pr.terminalRun}'`)
  }
  return { ...pr, revs: revisions, ...(current ? { terminalRun: run } : {}) }
}

function readyPr(state: DeepReadonly<BayState>, args: ChangeReadyArgs, defaultSubmitter: string, mint: PrNumberMint) {
  const pr: LiveChange =
    args.expectedCurrent === undefined
      ? requireLiveChange(state.bays, args.pr)
      : requireExpectedChangeTargetCurrent(state.bays, args.pr, args.expectedCurrent, "ready")
  if (changeDeliveryState(pr) === "submitted" || changeDeliveryState(pr) === "ready") return { events: [] }
  return submitWork(state, args, "main", defaultSubmitter, mint)
}

function settleSupersededPr(state: DeepReadonly<BayState>, args: ChangeSettleSupersededArgs) {
  const pr: LiveChange = requireLiveChange(state.bays, args.pr)
  const current = currentChangeRev(pr)
  if (current.n !== args.revision || current.head !== args.headSha) {
    raiseFailure(
      "refusal",
      "recut-current-changed",
      `yrd: change '${pr.id}' current revision changed from ${args.revision}@${args.headSha} ` +
        `to ${current.n}@${current.head} while the refresh proof was computed`,
    )
  }
  const delivery = changeDeliveryState(pr)
  if ((delivery !== "submitted" && delivery !== "ready") || !checksRequested(pr)) {
    raiseFailure(
      "refusal",
      "recut-transition-not-admitted",
      `yrd: change '${pr.id}' revision ${current.n} is not the accepted revision selected for refresh`,
    )
  }
  if (current.recut !== undefined && current.recut.patchId !== args.patchId) {
    raiseFailure(
      "refusal",
      "recut-patch-drift",
      `yrd: change '${pr.id}' automatic refresh changed patch identity from ${current.recut.patchId} to ${args.patchId}`,
    )
  }
  return {
    events: [
      event("pr/already-landed", {
        pr: pr.id,
        revision: current.n,
        headSha: current.head,
        ...(pr.issue === undefined ? {} : { issueRef: pr.issue }),
        ...(changeProps(pr) === undefined ? {} : { props: changeProps(pr) }),
        ...(current.submitter === undefined ? {} : { submitter: current.submitter }),
        baseSha: args.baseSha,
        candidateSha: args.baseSha,
        candidateTreeSha: args.baseTreeSha,
        baseTreeSha: args.baseTreeSha,
        settlement: {
          kind: "refresh-superseded",
          proof: "payload-already-contained",
          patchId: args.patchId,
        },
      }),
    ],
  }
}

function remergeChange(state: DeepReadonly<BayState>, args: ChangeRemergeArgs, defaultSubmitter: string) {
  const pr: LiveChange = requireLiveChange(state.bays, args.pr)
  if (!isLiveChange(pr)) {
    raiseFailure(
      "refusal",
      "terminal-target",
      `yrd: change '${pr.id}' is ${changeDeliveryState(pr)}; a finished change cannot be rebuilt`,
    )
  }
  const predecessor = pr.revs.find((revision) => revision.n === args.fromRevision)
  if (predecessor === undefined) {
    raiseFailure("refusal", "revision-missing", `yrd: change '${pr.id}' has no revision ${args.fromRevision}`)
  }
  const remerge = changeRemerge(pr)
  const payloadUnchanged = changeHead(pr) === args.headSha && changeBaseSha(pr) === args.baseSha
  const unchanged =
    payloadUnchanged &&
    remerge?.fromRevision === args.fromRevision &&
    remerge.patchId === args.patchId &&
    remerge.treeSha === args.treeSha &&
    remerge.reviewCarried === args.reviewCarried &&
    JSON.stringify(remerge.sources) === JSON.stringify(args.sources) &&
    remerge.transition?.from === args.transition?.from &&
    remerge.transition?.to === args.transition?.to
  if (args.expectedCurrent?.track !== undefined && isTracked(pr) !== args.expectedCurrent.track) {
    raiseFailure(
      "refusal",
      "recut-current-changed",
      `yrd: change '${pr.id}' tracking changed from ${String(args.expectedCurrent.track)} ` +
        `to ${String(isTracked(pr))} while the rebuild was being computed`,
    )
  }
  if (
    args.expectedCurrent !== undefined &&
    (changeRevisionNumber(pr) !== args.expectedCurrent.revision || changeHead(pr) !== args.expectedCurrent.headSha) &&
    !unchanged
  ) {
    raiseFailure(
      "refusal",
      "recut-current-changed",
      `yrd: change '${pr.id}' current revision changed from ${args.expectedCurrent.revision}@${args.expectedCurrent.headSha}` +
        ` to ${changeRevisionNumber(pr)}@${changeHead(pr)} while the rebuild was being computed`,
    )
  }
  // Only Queue authority-consumption results make an identical re-merge an
  // author reauthorization act. Authored-content failures need new bytes;
  // minting the same bytes would manufacture the same refusal at revision N+1.
  const needsAuthorCode = changeNeedsAuthor(pr)?.receipt.code
  const reauthorizesConsumedQueueAuthority =
    needsAuthorCode === "queue-submit-authority-consumed" || needsAuthorCode === "queue-checks-authority-consumed"
  if (!reauthorizesConsumedQueueAuthority && (unchanged || (needsAuthorCode !== undefined && payloadUnchanged))) {
    return { events: [] }
  }

  if (args.transition !== undefined) {
    if (args.expectedCurrent === undefined) {
      raiseFailure(
        "refusal",
        "recut-transition-current-required",
        `yrd: change '${pr.id}' Queue freshness transition requires an expected current revision`,
      )
    }
    if (
      (changeDeliveryState(pr) !== "submitted" && changeDeliveryState(pr) !== "ready") ||
      !checksRequested(pr) ||
      args.fromRevision !== changeRevisionNumber(pr)
    ) {
      raiseFailure(
        "refusal",
        "recut-transition-not-admitted",
        `yrd: change '${pr.id}' revision ${changeRevisionNumber(pr)} is not the accepted revision selected for refresh`,
      )
    }
    if (predecessor.recut !== undefined && predecessor.recut.patchId !== args.patchId) {
      raiseFailure(
        "refusal",
        "recut-patch-drift",
        `yrd: change '${pr.id}' automatic refresh changed patch identity from ${predecessor.recut.patchId} to ${args.patchId}`,
      )
    }
  }

  const effectiveReview = pr.reviews.findLast(
    (review) => review.revision === predecessor.n && review.headSha === predecessor.head,
  )
  const approved = effectiveReview?.decision === "approve" ? effectiveReview : undefined
  if (args.reviewCarried && approved === undefined) {
    raiseFailure(
      "refusal",
      "review-carry-invalid",
      `yrd: change '${pr.id}' revision ${predecessor.n} has no approval to carry`,
    )
  }
  const successor = { revision: changeRevisionNumber(pr) + 1, headSha: args.headSha, baseSha: args.baseSha }
  const changeId = predecessor.changeId
  if (changeId === undefined) {
    raiseFailure(
      "refusal",
      "legacy-change-id-missing",
      `yrd: change '${pr.id}' predates stable Change-Id identity; migrate it before rebuilding`,
    )
  }
  const successorSubmitter = predecessor.submitter ?? defaultSubmitter
  return {
    events: [
      event("pr/recut", {
        pr: pr.id,
        changeId,
        fromRevision: predecessor.n,
        patchId: args.patchId,
        baseSha: args.baseSha,
        treeSha: args.treeSha,
        reviewCarried: args.reviewCarried,
        submitter: successorSubmitter,
        ...(args.sources === undefined ? {} : { sources: args.sources }),
        predecessor: {
          revision: predecessor.n,
          headSha: predecessor.head,
          ...(predecessor.baseSha === undefined ? {} : { baseSha: predecessor.baseSha }),
        },
        successor,
        ...(args.transition === undefined ? {} : { transition: args.transition }),
      }),
      ...(args.transition === undefined
        ? []
        : [
            event("pr/submitted", {
              pr: pr.id,
              revision: successor.revision,
              headSha: successor.headSha,
              submitter: successorSubmitter,
              ...(predecessor.props === undefined ? {} : { props: predecessor.props }),
            }),
            event("pr/checks-requested", {
              pr: pr.id,
              revision: successor.revision,
              headSha: successor.headSha,
              baseSha: successor.baseSha,
            }),
          ]),
    ],
  }
}

function requestChangeReview(state: DeepReadonly<BayState>, args: ChangeRequestReviewArgs, defaultSubmitter: string) {
  const pr: LiveChange = requireLiveChange(state.bays, args.pr)
  const delivery = changeDeliveryState(pr)
  if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready") {
    raiseFailure(
      "refusal",
      "terminal-target",
      `yrd: change '${pr.id}' is ${delivery}; terminal PRs cannot change requested reviewers`,
    )
  }
  const requested = pr.requestedReviewers ?? []
  const unchanged =
    requested.length === args.reviewers.length &&
    requested.every((reviewer, index) => reviewer === args.reviewers[index])
  if (unchanged) return { events: [] }
  return {
    events: [
      event("pr/review-requested", { pr: pr.id, reviewers: args.reviewers, requestedBy: args.by ?? defaultSubmitter }),
    ],
  }
}

function reviewPr(state: DeepReadonly<BayState>, args: ChangeReviewArgs) {
  const pr: LiveChange = requireLiveChange(state.bays, args.pr)
  const fact = ChangeReviewFactSchema.parse({
    pr: pr.id,
    revision: changeRevisionNumber(pr),
    headSha: changeHead(pr),
    by: args.by,
    decision: args.decision,
    ...(args.ref === undefined ? {} : { ref: args.ref }),
    ...(args.note === undefined ? {} : { note: args.note }),
  })
  return reviewFact(pr, fact, "review")
}

function commentPr(state: DeepReadonly<BayState>, args: ChangeCommentArgs) {
  const pr: LiveChange =
    args.expectedCurrent === undefined
      ? requireLiveChange(state.bays, args.pr)
      : requireExpectedChangeTargetCurrent(state.bays, args.pr, args.expectedCurrent, "comment")
  const fact = ChangeCommentFactSchema.parse({
    pr: pr.id,
    revision: changeRevisionNumber(pr),
    headSha: changeHead(pr),
    by: args.by,
    note: args.note,
    ...(args.ref === undefined ? {} : { ref: args.ref }),
  })
  return reviewFact(pr, fact, "comment")
}

function requestChangeChecks(state: DeepReadonly<BayState>, args: ChangeRequestChecksArgs) {
  const pr: LiveChange =
    args.expectedCurrent === undefined
      ? requireLiveChange(state.bays, args.pr)
      : requireExpectedChangeTargetCurrent(state.bays, args.pr, args.expectedCurrent, "request-checks")
  const delivery = changeDeliveryState(pr)
  if (
    delivery !== "pushed" &&
    delivery !== "submitted" &&
    delivery !== "ready" &&
    delivery !== "rejected" &&
    delivery !== "needs-author"
  ) {
    throw new ChangeCheckabilityConflict(pr.id, delivery)
  }
  const baseSha = args.baseSha ?? changeBaseSha(pr)
  return {
    events: [
      event("pr/checks-requested", {
        pr: pr.id,
        revision: changeRevisionNumber(pr),
        headSha: changeHead(pr),
        ...(baseSha === undefined ? {} : { baseSha }),
      }),
    ],
  }
}

function recordChangeAdmission(state: DeepReadonly<BayState>, args: ChangeAdmissionRecordedFact) {
  const pr: LiveChange = requireLiveChange(state.bays, args.pr)
  if (changeRevisionNumber(pr) !== args.revision || changeHead(pr) !== args.headSha) {
    raiseFailure(
      "refusal",
      "stale-pr",
      `yrd: entry checks target stale revision ${args.revision} (${args.headSha}) of change '${pr.id}'`,
    )
  }
  const delivery = changeDeliveryState(pr)
  if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready" && delivery !== "needs-author") {
    throw new ChangeCheckabilityConflict(pr.id, delivery)
  }
  const prior = currentChangeRev(pr).admission
  if (
    prior !== undefined &&
    JSON.stringify({ ...prior, at: undefined }) === JSON.stringify({ ...args.admission, at: undefined })
  ) {
    return { events: [] }
  }
  return { events: [event("pr/admission-recorded", args)] }
}

function reviewFact(
  pr: DeepReadonly<Change>,
  fact: z.infer<typeof ChangeReviewFactSchema> | z.infer<typeof ChangeCommentFactSchema>,
  kind: "review" | "comment",
) {
  if (fact.ref !== undefined) {
    const prior = [...pr.reviews, ...pr.comments].find((candidate) => candidate.ref === fact.ref)
    if (prior !== undefined) {
      const same =
        prior.revision === fact.revision &&
        prior.headSha === fact.headSha &&
        prior.by === fact.by &&
        prior.ref === fact.ref &&
        (kind === "review"
          ? "decision" in prior && "decision" in fact && prior.decision === fact.decision && prior.note === fact.note
          : !("decision" in prior) && !("decision" in fact) && prior.note === fact.note)
      if (same) return { events: [] }
      throw new Error(`yrd: review ref '${fact.ref}' already records a different fact`)
    }
  }
  return { events: [event(kind === "review" ? "pr/reviewed" : "pr/commented", fact)] }
}

/** A withdrawn/canceled PR still holds its payload, so no OTHER branch may
 * carry that commit — but its OWN branch reopens it in place (D2), which is the
 * whole remedy. Naming it here is the difference between a one-line rebuild and
 * forging a tree-identical commit whose only purpose is to change a hash. A
 * live or merged duplicate has no such door, so it keeps the bare refusal
 * rather than a remedy its state would refuse. */
function duplicatePayloadRemedy(duplicate: DeepReadonly<Change>): string {
  const delivery = changeDeliveryState(duplicate)
  if (delivery !== "withdrawn" && delivery !== "canceled") return ""
  const at = delivery === "withdrawn" ? duplicate.withdrawnAt : duplicate.canceledAt
  return (
    `; ${duplicate.id} is ${delivery}${at === undefined ? "" : ` (${at})`} and still holds this payload, ` +
    "so no other branch can carry it — resubmitting its own branch reopens it in place, " +
    `no rebuilt commit needed; run 'yrd pr submit ${duplicate.branch}'`
  )
}

function refuseDuplicatePayload(
  state: DeepReadonly<BaysState>,
  headSha: string,
  base: string,
  composition: CompositionV1 | undefined,
  except?: string,
): void {
  const identity = baseIdentity(base)
  const duplicate = Object.values(state.prs).find(
    (pr) =>
      pr.id !== except &&
      changeHead(pr) === headSha &&
      baseIdentity(pr.base) === identity &&
      sameComposition(changeComposition(pr), composition),
  )
  if (duplicate !== undefined) {
    throw new Error(
      `yrd: payload already recorded as change '${duplicate.id}' on queue '${identity}'` +
        duplicatePayloadRemedy(duplicate),
    )
  }
}

function closeBay(state: DeepReadonly<BayState>, args: CloseBayArgs, deprovision: BayJobDefs["bay.deprovision"]) {
  const current = state.bays
  const bay = required(resolveBay(current, args.bay), "bay", args.bay)
  if (bay.status === "opening" || bay.status === "closing") {
    throw new Error(`yrd: bay '${bay.id}' is ${bay.status}; wait for its workspace job`)
  }
  if (bay.status === "closed") throw new Error(`yrd: bay '${bay.id}' is already closed`)
  const pr = changeForBay(current, bay.id) ?? resolveChange(current, bay.branch)
  if (pr !== undefined && changeDeliveryState(pr) !== "pushed" && isLiveChange(pr) && args.withdraw !== true) {
    throw new Error(
      `yrd: change '${pr.id}' is ${changeDeliveryState(pr)}; run it through the merge queue before closing, or pass --withdraw`,
    )
  }
  return {
    events: [
      ...(args.withdraw === true && pr !== undefined && isLiveChange(pr)
        ? [event("pr/withdrawn", { pr: pr.id, ...terminalIdentity(pr) })]
        : []),
      event("bay/closing", { bay: bay.id }),
      deprovision.request({
        bay: bay.id,
        ...(bay.path === undefined ? {} : { path: bay.path }),
        branch: bay.branch,
        ...(bay.headSha === undefined ? {} : { headSha: bay.headSha }),
      }),
    ],
  }
}

function closePr(state: DeepReadonly<BayState>, args: ChangeCloseArgs) {
  const pr: LiveChange = requireLiveChange(state.bays, args.pr)
  if (!isLiveChange(pr)) {
    throw new Error(`yrd: change '${pr.id}' is ${changeDeliveryState(pr)}; only a live change can be closed`)
  }
  return {
    events: [
      event("pr/withdrawn", {
        pr: pr.id,
        ...terminalIdentity(pr),
        ...(args.reason === undefined ? {} : { reason: args.reason }),
      }),
    ],
  }
}

function editPr(state: DeepReadonly<BayState>, args: ChangeEditArgs) {
  const pr: LiveChange = requireLiveChange(state.bays, args.pr)
  const issueChanged = args.issue !== undefined && args.issue !== pr.issue
  if (args.issue !== undefined && pr.issue !== undefined && issueChanged) {
    raiseFailure(
      "refusal",
      "issue-conflict",
      `yrd: change '${pr.id}' is already linked to issue '${pr.issue}'; close it before linking another issue`,
    )
  }
  const delivery = changeDeliveryState(pr)
  if (issueChanged && delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready") {
    raiseFailure(
      "refusal",
      "issue-too-late",
      `yrd: change '${pr.id}' is ${delivery}; issue can only be linked while pushed or submitted`,
    )
  }
  // Title, description and tracking are mutable delivery metadata (unlike the
  // immutable issue join): a later edit overwrites the prior value with no conflict.
  const titleChanged = args.title !== undefined && args.title !== pr.title
  const descriptionChanged = args.description !== undefined && args.description !== pr.description
  const trackChanged = args.track !== undefined && args.track !== isTracked(pr)
  // requireLiveChange admits a terminal change addressed by canonical id, so
  // a track edit must re-check liveness here or it records a bit nothing will
  // ever read — silently, unlike bindMetadata's warned skip on the submit path.
  if (trackChanged && !isLiveChange(pr)) {
    raiseFailure(
      "refusal",
      "track-terminal",
      `yrd: change '${pr.id}' is ${changeDeliveryState(pr)}; tracking governs future rebuilds and a terminal ` +
        `change has none, so the flag was not recorded`,
    )
  }
  if (!issueChanged && args.note === undefined && !titleChanged && !descriptionChanged && !trackChanged) {
    return { events: [] }
  }
  return {
    events: [
      event("pr/edited", {
        pr: pr.id,
        ...(issueChanged ? { issue: args.issue } : {}),
        ...(args.note === undefined ? {} : { note: args.note }),
        ...(titleChanged ? { title: args.title } : {}),
        ...(descriptionChanged ? { description: args.description } : {}),
        ...(trackChanged ? { track: args.track } : {}),
      }),
    ],
  }
}

function bayState(bays: BaysState): BayState {
  return { bays }
}

function projectBays(state: DeepReadonly<BayState>, applied: Event): BayState {
  const current = state.bays
  const saveBay = (bay: Bay): BayState => bayState({ ...current, byId: { ...current.byId, [bay.id]: bay } })
  const patchBay = (bay: Bay, patch: Partial<Bay>): BayState => saveBay({ ...bay, ...patch })
  const patchPR = (pr: Change, patch: Partial<Change>): BayState =>
    bayState({ ...current, prs: { ...current.prs, [pr.id]: { ...pr, ...patch } } })
  const patchRevisionClock = (pr: Change, patch: Partial<ChangeRevClock>): readonly ChangeRev[] => {
    const currentRevision = currentChangeRev(pr)
    let found = false
    const revisions = pr.revs.map((revision) => {
      if (revision.n !== currentRevision.n || revision.head !== currentRevision.head) return revision
      found = true
      return { ...revision, ...patch }
    })
    if (!found) {
      throw new Error(
        `yrd: change '${pr.id}' has no clock for current revision ${currentRevision.n}@${currentRevision.head}`,
      )
    }
    return revisions
  }
  const data = applied.data as Record<string, unknown>

  switch (applied.name) {
    case "bay/opened": {
      const opened = BayOpenedSchema.parse(data)
      return saveBay({
        ...opened,
        base: baseIdentity(opened.base),
        status: "opening",
        openedAt: applied.ts,
        refreshedAt: applied.ts,
      })
    }
    case "branch/submitted": {
      // Newest wins, unconditionally — the receiver's submit ref has no CAS
      // either (writeSubmitRefForCarrier), so the projection mirrors the ref.
      const submitted = BranchSubmitSchema.parse(data)
      return bayState({
        ...current,
        submits: {
          ...current.submits,
          [submitted.branch]: { sha: submitted.sha, base: baseIdentity(submitted.base), at: applied.ts },
        },
      })
    }
    case "branch/unsubmitted": {
      const unsubmitted = BranchUnsubmitSchema.parse(data)
      if (current.submits[unsubmitted.branch] === undefined) return bayState(current)
      const { [unsubmitted.branch]: _removed, ...submits } = current.submits
      return bayState({ ...current, submits })
    }
    case "bay/closing": {
      const bay = current.byId[data.bay as string]
      return bay === undefined ? state : patchBay(bay, { status: "closing", failure: undefined })
    }
    case "bay/orphaned": {
      const orphaned = BayOrphanedSchema.parse(data)
      const bay = current.byId[orphaned.bay]
      if (bay === undefined) return state
      const { bay: _bay, ...orphan } = orphaned
      return patchBay(bay, {
        orphan: {
          ...orphan,
          recordedAt: applied.ts,
          eventId: applied.id,
        },
      })
    }
    case "bay/handoff-certified": {
      const certified = BayHandoffCertifiedSchema.parse(data)
      const bay = current.byId[certified.bay]
      if (bay === undefined) return state
      if (bay.branch !== certified.branch || bay.headSha !== certified.headSha) {
        throw new Error(`yrd: certification does not match bay '${certified.bay}' current branch and head`)
      }
      return patchBay(bay, {
        handoff: {
          headSha: certified.headSha,
          evidence: certified.evidence,
          certifiedAt: applied.ts,
          eventId: applied.id,
        },
      })
    }
    case "pr/pushed": {
      const parsed = ChangePushedSchema.safeParse(data)
      const previous = ChangePushedV1Schema.safeParse(data)
      const pushed = parsed.success
        ? parsed.data
        : previous.success
          ? previous.data
          : LegacyChangePushedSchema.parse(normalizeV1CorrelationToProps(data))
      const base = baseIdentity(pushed.base)
      const existing = current.prs[pushed.pr]
      const record: ChangeRev = {
        n: pushed.revision,
        ...(parsed.success ? { changeId: parsed.data.changeId } : {}),
        head: pushed.headSha,
        base,
        ...(pushed.baseSha === undefined ? {} : { baseSha: pushed.baseSha }),
        ...(pushed.composition === undefined ? {} : { composition: pushed.composition }),
        ...(parsed.success
          ? { submitter: parsed.data.submitter }
          : previous.success
            ? { submitter: previous.data.submitter }
            : {}),
        pushedAt: applied.ts,
        ...(pushed.props === undefined ? {} : { props: pushed.props }),
      }
      const pr: Change =
        existing === undefined
          ? {
              id: pushed.pr,
              ...(pushed.bay === undefined ? {} : { bay: pushed.bay }),
              ...(pushed.name === undefined ? {} : { name: pushed.name }),
              ...(pushed.issue === undefined ? {} : { issue: pushed.issue }),
              branch: pushed.branch,
              base,
              state: "open",
              merged: false,
              revs: [record],
              reviews: [],
              comments: [],
              checkRequests: [],
              requestedReviewers: [],
            }
          : {
              ...existing,
              ...(pushed.bay === undefined ? {} : { bay: pushed.bay }),
              ...(pushed.name === undefined ? {} : { name: pushed.name }),
              ...(pushed.issue === undefined ? {} : { issue: pushed.issue }),
              base,
              state: "open",
              merged: false,
              revs: [...existing.revs, record],
              terminalRun: undefined,
              submittedAt: undefined,
              rejectedAt: undefined,
              integratedAt: undefined,
              integration: undefined,
              alreadyLandedAt: undefined,
              alreadyLanded: undefined,
              withdrawnAt: undefined,
              withdrawReason: undefined,
              canceledAt: undefined,
              canceledBy: undefined,
              cancelReason: undefined,
              detail: undefined,
            }
      const next = { ...current, prs: { ...current.prs, [pr.id]: pr } }
      return bayState(
        pushed.receipt === undefined
          ? next
          : {
              ...next,
              receipts: {
                ...next.receipts,
                [pushed.receipt]: {
                  pr: pushed.pr,
                  branch: pushed.branch,
                  headSha: pushed.headSha,
                  base,
                  ...(pushed.baseSha === undefined ? {} : { baseSha: pushed.baseSha }),
                  ...(pushed.composition === undefined ? {} : { composition: pushed.composition }),
                },
              },
            },
      )
    }
    case "pr/recut": {
      const parsed = ChangeRemergeFactSchema.safeParse(data)
      const remerge = parsed.success ? parsed.data : ChangeRemergeReplaySchema.parse(data)
      const pr = current.prs[remerge.pr]
      if (pr === undefined) throw new Error(`yrd: no change '${remerge.pr}' to rebuild`)
      const predecessor = pr.revs.find(
        (revision) => revision.n === remerge.predecessor.revision && revision.head === remerge.predecessor.headSha,
      )
      if (
        predecessor === undefined ||
        remerge.fromRevision !== remerge.predecessor.revision ||
        predecessor.baseSha !== remerge.predecessor.baseSha ||
        remerge.successor.revision !== changeRevisionNumber(pr) + 1
      ) {
        throw new Error(`yrd: rebuild history does not match change '${pr.id}'`)
      }
      const proof: ChangeRemergeProof = {
        fromRevision: remerge.fromRevision,
        patchId: remerge.patchId,
        treeSha: remerge.treeSha,
        reviewCarried: remerge.reviewCarried,
        ...(remerge.certificate === undefined ? {} : { certificate: remerge.certificate }),
        ...(remerge.sources === undefined ? {} : { sources: remerge.sources }),
        ...(remerge.transition === undefined ? {} : { transition: remerge.transition }),
      }
      const props = predecessor.props
      const submitter = remerge.submitter ?? predecessor.submitter
      // An admission is a verdict about a tree merged into a base. A rebuild
      // that merges on the identical head AND the identical certified base has
      // not changed either, so the verdict is still about this revision's
      // content and carries — exactly as an approved review does below.
      //
      // Without this a byte-identical rebuild discards its own green: the
      // carrier drops out of the queue, the runner re-requests, admission
      // passes, the next rebuild discards it again, and nothing merges while
      // every instrument reads healthy
      // (@i/10-merge-queue/admission-passes-nothing-merges; one carrier reached
      // revision 66). Any real change moves the head or the base and correctly
      // leaves the new revision unadmitted.
      const carriedAdmission =
        remerge.successor.headSha === predecessor.head && remerge.successor.baseSha === predecessor.baseSha
          ? predecessor.admission
          : undefined
      const revision: ChangeRev = {
        n: remerge.successor.revision,
        ...(parsed.success ? { changeId: parsed.data.changeId } : {}),
        head: remerge.successor.headSha,
        base: pr.base,
        baseSha: remerge.successor.baseSha,
        ...(submitter === undefined ? {} : { submitter }),
        ...(props === undefined ? {} : { props: { ...props } }),
        ...(remerge.composition === undefined ? {} : { composition: remerge.composition }),
        ...(carriedAdmission === undefined ? {} : { admission: carriedAdmission }),
        recut: proof,
        pushedAt: applied.ts,
      }
      const effectiveReview = pr.reviews.findLast(
        (review) => review.revision === predecessor.n && review.headSha === predecessor.head,
      )
      const approval = effectiveReview?.decision === "approve" ? effectiveReview : undefined
      if (remerge.reviewCarried && approval === undefined) {
        throw new Error(`yrd: change '${pr.id}' rebuild carries a missing approval`)
      }
      const carriedReview: ChangeReview | undefined =
        remerge.reviewCarried && approval !== undefined
          ? {
              revision: revision.n,
              headSha: revision.head,
              by: approval.by,
              decision: "approve",
              at: applied.ts,
              ...(approval.note === undefined ? {} : { note: approval.note }),
              carriedFrom: { revision: predecessor.n, headSha: predecessor.head },
            }
          : undefined
      return patchPR(pr, {
        state: "open",
        merged: false,
        revs: [...pr.revs, revision],
        reviews: carriedReview === undefined ? pr.reviews : [...pr.reviews, carriedReview],
        needsAuthor: undefined,
        terminalRun: undefined,
        submittedAt: undefined,
        rejectedAt: undefined,
        integratedAt: undefined,
        integration: undefined,
        alreadyLandedAt: undefined,
        alreadyLanded: undefined,
        withdrawnAt: undefined,
        withdrawReason: undefined,
        canceledAt: undefined,
        canceledBy: undefined,
        cancelReason: undefined,
        detail: undefined,
      })
    }
    case "pr/submitted": {
      const parsed = ChangeRevisionSchema.safeParse(data)
      const changed = parsed.success
        ? parsed.data
        : LegacyChangeRevisionSchema.parse(normalizeV1CorrelationToProps(data))
      const changedFlow = parsed.success ? parsed.data.flow : undefined
      const pr = current.prs[changed.pr]
      if (pr === undefined) return state
      if (changeRevisionNumber(pr) !== changed.revision || changeHead(pr) !== changed.headSha) {
        throw new Error(`yrd: stale change event for '${pr.id}'`)
      }
      const currentProps = changeProps(pr)
      const submittedConflict = changed.props === undefined ? undefined : propsConflictKey(currentProps, changed.props)
      if (submittedConflict !== undefined) {
        throw new Error(`yrd: submitted prop '${submittedConflict}' does not match change '${pr.id}'`)
      }
      const props = changed.props === undefined ? currentProps : { ...currentProps, ...changed.props }
      if (
        pr.flow !== undefined &&
        changedFlow !== undefined &&
        (pr.flow.name !== changedFlow.name ||
          pr.flow.rev !== changedFlow.rev ||
          pr.flow.fingerprint !== changedFlow.fingerprint)
      ) {
        throw new Error(`yrd: submitted flow does not match change '${pr.id}'`)
      }
      const revisions = patchRevisionClock(pr, { submittedAt: applied.ts, terminal: undefined }).map((revision) => {
        if (revision.n !== changeRevisionNumber(pr) || revision.head !== changeHead(pr)) return revision
        return {
          ...revision,
          ...(parsed.success ? { submitter: parsed.data.submitter } : {}),
          ...(props === undefined ? {} : { props: { ...props } }),
        }
      })
      return patchPR(pr, {
        state: "open",
        merged: false,
        submittedAt: applied.ts,
        needsAuthor: undefined,
        rejectedAt: undefined,
        integratedAt: undefined,
        integration: undefined,
        alreadyLandedAt: undefined,
        alreadyLanded: undefined,
        withdrawnAt: undefined,
        withdrawReason: undefined,
        canceledAt: undefined,
        canceledBy: undefined,
        cancelReason: undefined,
        revs: revisions,
        flow: pr.flow ?? changedFlow,
      })
    }
    case "pr/props-set":
    case "pr/correlation-bound": {
      const changed = ChangePropsBoundSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) return state
      if (changeRevisionNumber(pr) !== changed.revision || changeHead(pr) !== changed.headSha) {
        throw new Error(`yrd: stale props for change '${pr.id}'`)
      }
      const delivery = changeDeliveryState(pr)
      if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready" && delivery !== "needs-author") {
        throw new Error(`yrd: change '${pr.id}' is ${delivery}; props cannot be set`)
      }
      const currentProps = changeProps(pr)
      const conflict = propsConflictKey(currentProps, changed.props)
      if (conflict !== undefined) {
        throw new Error(`yrd: prop '${conflict}' conflicts with change '${pr.id}'`)
      }
      return patchPR(pr, propsPatch(pr, { ...currentProps, ...changed.props }))
    }
    case "pr/withdrawn": {
      const parsed = ChangeWithdrawnSchema.safeParse(data)
      const changed = parsed.success
        ? parsed.data
        : LegacyChangeWithdrawnSchema.parse(normalizeV1CorrelationToProps(data))
      const pr = current.prs[changed.pr]
      if (pr === undefined) throw new Error(`yrd: terminal '${applied.name}' names missing change '${changed.pr}'`)
      assertTerminalApplies(pr, changed, applied.name)
      return patchPR(pr, {
        state: "closed",
        merged: false,
        withdrawnAt: applied.ts,
        ...(parsed.success && parsed.data.reason !== undefined ? { withdrawReason: parsed.data.reason } : {}),
        revs: patchRevisionClock(pr, { terminal: { kind: "withdrawn", at: applied.ts } }),
      })
    }
    case "pr/needs-author": {
      const changed = ChangeNeedsAuthorFactSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) throw new Error(`yrd: '${applied.name}' names missing change '${changed.pr}'`)
      assertTerminalApplies(pr, changed, applied.name)
      const delivery = changeDeliveryState(pr)
      if (delivery !== "submitted" && delivery !== "ready") {
        throw new Error(`yrd: change '${pr.id}' is ${delivery}; '${applied.name}' requires a submitted revision`)
      }
      return patchPR(pr, {
        needsAuthor: {
          at: applied.ts,
          run: changed.run,
          step: changed.step,
          receipt: changed.receipt,
          ...(changed.evidence === undefined ? {} : { evidence: changed.evidence }),
          ...(changed.detail === undefined ? {} : { detail: changed.detail }),
        },
        terminalRun: undefined,
        rejectedAt: undefined,
        detail: changed.detail,
      })
    }
    case "pr/rejected": {
      const changed = ChangeReplayRejectedSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) throw new Error(`yrd: terminal '${applied.name}' names missing change '${changed.pr}'`)
      assertTerminalApplies(pr, changed, applied.name)
      const rejected: Change = {
        ...pr,
        state: "open",
        merged: false,
        rejectedAt: applied.ts,
        terminalRun: undefined,
        revs: patchRevisionClock(pr, {
          terminal: { kind: "rejected", at: applied.ts },
        }),
        ...(changed.detail === undefined ? {} : { detail: changed.detail }),
      }
      return patchPR(pr, "run" in changed ? associateRejectedTerminalRun(rejected, changed, changed.run) : rejected)
    }
    case "pr/integrated": {
      const parsed = ChangeIntegratedSchema.safeParse(data)
      const v1 = parsed.success ? undefined : ChangeIntegratedV1Schema.safeParse(data)
      const changed = parsed.success
        ? parsed.data
        : v1?.success === true
          ? v1.data
          : LegacyChangeIntegratedSchema.parse(normalizeV1CorrelationToProps(data))
      const pr = current.prs[changed.pr]
      if (pr === undefined) throw new Error(`yrd: terminal '${applied.name}' names missing change '${changed.pr}'`)
      assertTerminalApplies(pr, changed, applied.name)
      const run = parsed.success ? parsed.data.run : v1?.success === true ? v1.data.run : undefined
      return patchPR(pr, {
        state: "closed",
        merged: true,
        integratedAt: applied.ts,
        alreadyLandedAt: undefined,
        alreadyLanded: undefined,
        terminalRun: run,
        integration: {
          commit: changed.commit,
          baseSha: changed.baseSha,
          ...(parsed.success ? { changeId: parsed.data.changeId } : {}),
        },
        revs: patchRevisionClock(pr, {
          terminal: { kind: "integrated", at: applied.ts, ...(run === undefined ? {} : { run }) },
        }),
      })
    }
    case "pr/already-landed": {
      const changed = ChangeAlreadyMergedSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) throw new Error(`yrd: terminal '${applied.name}' names missing change '${changed.pr}'`)
      assertTerminalApplies(pr, changed, applied.name)
      return patchPR(pr, {
        state: "closed",
        merged: true,
        needsAuthor: undefined,
        integratedAt: undefined,
        alreadyLandedAt: applied.ts,
        terminalRun: changed.run,
        integration: { commit: changed.baseSha, baseSha: changed.baseSha },
        alreadyLanded: {
          baseSha: changed.baseSha,
          candidateSha: changed.candidateSha,
          candidateTreeSha: changed.candidateTreeSha,
          baseTreeSha: changed.baseTreeSha,
          ...(changed.settlement === undefined ? {} : { settlement: changed.settlement }),
        },
        revs: patchRevisionClock(pr, {
          terminal: {
            kind: "already-landed",
            at: applied.ts,
            ...(changed.run === undefined ? {} : { run: changed.run }),
          },
        }),
      })
    }
    case "pr/canceled": {
      const parsed = ChangeCanceledSchema.safeParse(data)
      const changed = parsed.success
        ? parsed.data
        : LegacyChangeCanceledSchema.parse(normalizeV1CorrelationToProps(data))
      const pr = current.prs[changed.pr]
      const run = parsed.success ? parsed.data.run : undefined
      if (pr === undefined) throw new Error(`yrd: terminal '${applied.name}' names missing change '${changed.pr}'`)
      assertTerminalApplies(pr, changed, applied.name)
      return patchPR(pr, {
        state: "closed",
        merged: false,
        canceledAt: applied.ts,
        canceledBy: changed.by,
        cancelReason: changed.reason,
        terminalRun: run,
        revs: patchRevisionClock(pr, {
          terminal: { kind: "canceled", at: applied.ts, ...(run === undefined ? {} : { run }) },
        }),
      })
    }
    case "pr/edited": {
      const changed = ChangeEditArgsSchema.parse(data)
      const pr = current.prs[changed.pr]
      const attachIssue =
        changed.issue !== undefined &&
        pr !== undefined &&
        pr.issue === undefined &&
        (changeDeliveryState(pr) === "pushed" ||
          changeDeliveryState(pr) === "submitted" ||
          changeDeliveryState(pr) === "ready")
      return pr === undefined
        ? state
        : patchPR(pr, {
            ...(attachIssue ? { issue: changed.issue } : {}),
            ...(changed.note === undefined ? {} : { note: changed.note }),
            ...(changed.title === undefined ? {} : { title: changed.title }),
            ...(changed.description === undefined ? {} : { description: changed.description }),
            ...(changed.track === undefined ? {} : { track: changed.track }),
          })
    }
    case "pr/reviewed": {
      const reviewed = ChangeReviewFactSchema.parse(data)
      const { pr: prId, ...fact } = reviewed
      const pr = current.prs[prId]
      if (pr === undefined) return state
      const review: ChangeReview = { ...fact, at: applied.ts }
      return patchPR(pr, { reviews: [...pr.reviews, review] })
    }
    case "pr/commented": {
      const commented = ChangeCommentFactSchema.parse(data)
      const pr = current.prs[commented.pr]
      if (pr === undefined) return state
      const comment: ChangeComment = { ...commented, at: applied.ts }
      return patchPR(pr, { comments: [...pr.comments, comment] })
    }
    case "pr/session-started": {
      RetiredChangeSessionStartedFactSchema.parse(data)
      return state
    }
    case "pr/session-ended": {
      RetiredChangeSessionEndedFactSchema.parse(data)
      return state
    }
    case "pr/review-requested": {
      const requested = ChangeReviewRequestFactSchema.parse(data)
      const pr = current.prs[requested.pr]
      if (pr === undefined) return state
      return patchPR(pr, { requestedReviewers: requested.reviewers })
    }
    case "pr/checks-requested": {
      const requested = ChangeCheckRequestFactSchema.parse(data)
      const pr = current.prs[requested.pr]
      if (pr === undefined) return state
      if (changeRevisionNumber(pr) !== requested.revision || changeHead(pr) !== requested.headSha) return state
      return patchPR(pr, {
        checkRequests: [
          ...pr.checkRequests,
          {
            revision: requested.revision,
            headSha: requested.headSha,
            ...(requested.baseSha === undefined ? {} : { baseSha: requested.baseSha }),
            at: applied.ts,
          },
        ],
      })
    }
    case "pr/admission-recorded": {
      const recorded = ChangeAdmissionRecordedFactSchema.parse(data)
      const pr = current.prs[recorded.pr]
      if (pr === undefined) return state
      if (changeRevisionNumber(pr) !== recorded.revision || changeHead(pr) !== recorded.headSha) return state
      return patchPR(pr, {
        needsAuthor: undefined,
        revs: pr.revs.map((revision) =>
          revision.n === recorded.revision && revision.head === recorded.headSha
            ? { ...revision, admission: { ...recorded.admission, at: applied.ts } }
            : revision,
        ),
      })
    }
    case "job/requested": {
      if (typeof data.definition !== "string" || !isBayJob(data.definition)) return state
      const input = data.input as { bay?: unknown }
      const bay = typeof input.bay === "string" ? current.byId[input.bay] : undefined
      return bay === undefined
        ? state
        : patchBay(bay, { jobId: applied.id, jobDef: data.definition, failure: undefined })
    }
    case "job/transitioned":
      return projectBayJob(state, applied, data as JobTransition)
    default:
      return state
  }
}

function projectBayJob(state: DeepReadonly<BayState>, applied: Event, change: JobTransition): BayState {
  if (change.type !== "finish" && change.type !== "lose") return state
  const bay = Object.values(state.bays.byId).find((candidate) => candidate.jobId === change.id)
  if (bay?.jobDef === undefined || !isBayJob(bay.jobDef)) return state
  const save = (patch: Partial<Bay>): BayState => ({
    bays: { ...state.bays, byId: { ...state.bays.byId, [bay.id]: { ...bay, ...patch } } },
  })
  if (change.type === "lose") {
    if (bay.jobDef === "bay.provision") {
      return save({
        status: "closed",
        closure: { kind: "closed-degenerate", at: applied.ts, eventId: applied.id },
        closedAt: applied.ts,
        failure: { code: "job-lost", message: change.reason },
        jobId: undefined,
        jobDef: undefined,
      })
    }
    return save({
      status: "active",
      failure: { code: "job-lost", message: change.reason },
    })
  }
  if (change.result.conclusion === "failure") {
    if (bay.jobDef === "bay.provision") {
      return save({
        status: "closed",
        closure: { kind: "closed-degenerate", at: applied.ts, eventId: applied.id },
        closedAt: applied.ts,
        failure: change.result.error,
        jobId: undefined,
        jobDef: undefined,
      })
    }
    return save({
      status: "active",
      failure: change.result.error,
    })
  }
  if (bay.jobDef === "bay.provision") {
    const output = ProvisionedBaySchema.parse(change.result.output)
    return save({
      status: "active",
      path: output.path,
      headSha: output.headSha,
      baseSha: output.baseSha,
      dirty: false,
      failure: undefined,
      jobId: undefined,
      jobDef: undefined,
    })
  }
  if (bay.jobDef === "bay.refresh") {
    const output = RefreshedBaySchema.parse(change.result.output)
    return save({
      status: "active",
      path: output.path,
      headSha: output.headSha,
      baseSha: output.baseSha,
      dirty: output.dirty,
      refreshedAt: applied.ts,
      failure: undefined,
      jobId: undefined,
      jobDef: undefined,
    })
  }
  if (bay.jobDef === "bay.checkpoint") {
    const output = CheckpointedBaySchema.parse(change.result.output)
    return save({
      status: "active",
      headSha: output.headSha,
      dirty: false,
      refreshedAt: applied.ts,
      failure: undefined,
      jobId: undefined,
      jobDef: undefined,
    })
  }
  const output = DeprovisionedBaySchema.parse(change.result.output)
  return save({
    status: "closed",
    ...(output.headSha === undefined ? {} : { headSha: output.headSha }),
    ...(output.headSha === undefined || output.preservedRef === undefined
      ? {}
      : {
          archive: {
            headSha: output.headSha,
            preservedRef: output.preservedRef,
            archivedAt: applied.ts,
            eventId: applied.id,
          },
        }),
    closedAt: applied.ts,
    failure: undefined,
    jobId: undefined,
    jobDef: undefined,
  })
}

function required<Value>(value: Value | undefined, kind: "bay" | "change", selector: string): Value {
  if (value === undefined) throw new Error(`yrd: no ${kind} '${selector}'`)
  return value
}

function sameComposition(left: CompositionV1 | undefined, right: CompositionV1 | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function maxRecordNumber(prefix: string, records: Readonly<Record<string, unknown>>): number {
  const numbers = Object.keys(records)
    .filter((id) => id.startsWith(prefix) && /^\d+$/u.test(id.slice(prefix.length)))
    .map((id) => Number(id.slice(prefix.length)))
  return Math.max(0, ...numbers)
}

function nextId(prefix: string, records: Readonly<Record<string, unknown>>): string {
  return `${prefix}${maxRecordNumber(prefix, records) + 1}`
}

/** Mint the next PR id against the durable high-water, never the record set
 * alone: `max(existing) + 1` restarts at 1 whenever the store is
 * re-initialized, re-issuing numbers that already name landed changes (22986).
 * The record-set max still participates so a store whose mint file was lost
 * but whose records survived keeps counting upward. The new high-water is
 * committed BEFORE the id escapes — a crash between commit and use skips a
 * number, which is reversible, where re-issuing one never is. */
export function mintChangeId(mint: PrNumberMint, records: Readonly<Record<string, unknown>>): string {
  const next = Math.max(mint.highWater(), maxRecordNumber("PR", records)) + 1
  mint.commit(next)
  return `PR${next}`
}

function isBayJob(name: string): name is keyof BayJobDefs {
  return name === "bay.provision" || name === "bay.refresh" || name === "bay.checkpoint" || name === "bay.deprovision"
}
