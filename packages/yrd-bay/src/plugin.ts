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
import { computed, type ReadSignal } from "@silvery/signals"
import type { FlowPin, Submission } from "@yrd/config"
import { isDeepStrictEqual } from "node:util"
import type { ConditionalLogger } from "loggily"
import * as z from "zod"
import { ChangeIdSchema, changeIdForCommand, type ChangeId } from "./change-identity.ts"
import {
  BayIdSchema,
  CheckpointBayInputSchema,
  CheckpointedBaySchema,
  CompositionV1Schema,
  CorrelationSchema,
  DeprovisionBayInputSchema,
  DeprovisionedBaySchema,
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
  PRFreshnessTransitionSchema,
  PRAdmissionRecordedFactSchema,
  PRRecutCertificateSchema,
  PRRecutSourceSchema,
  PRReviewDecisionSchema,
  PRReviewSchema,
  PRNeedsAuthorFactSchema,
  PRRejectedFactSchema,
  PRTerminalAssociationSchema,
  ProvisionBayInputSchema,
  ProvisionedBaySchema,
  RefreshBayInputSchema,
  RefreshedBaySchema,
  RemoteBranchSnapshotSchema,
  baseIdentity,
  defaultBayBranch,
  checksRequested,
  currentPRRev,
  emptyBaysState,
  isLivePR,
  needsReview,
  normalizeV2By,
  normalizeV2Submitter,
  prBaseSha,
  prComposition,
  prCorrelation,
  prDeliveryState,
  prForBay,
  requireLivePR,
  prHead,
  prNeedsAuthor,
  prRecut,
  prRevisionNumber,
  PrCheckabilityConflict,
  projectBranchLifecycles,
  reviewState,
  resolveBay,
  resolvePR,
  resolvePRMatch,
  type Bay,
  type BranchLifecycle,
  type BaysState,
  type CheckpointBayInput,
  type CheckpointedBay,
  type CompositionV1,
  type Correlation,
  type DeprovisionBayInput,
  type DeprovisionedBay,
  type LivePR,
  type PR,
  type PRAdmissionRecordedFact,
  type PRComment,
  type PRRegression,
  type PRRecutProof,
  type PRReview,
  type PRReviewState,
  type PRRev,
  type PRRevClock,
  type ProvisionBayInput,
  type ProvisionedBay,
  type RefreshBayInput,
  type RefreshedBay,
  type RemoteBranchSnapshot,
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

const PRExpectedCurrentSchema = z
  .object({
    pr: TextSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    track: z.boolean().optional(),
  })
  .strict()
type PRExpectedCurrent = Readonly<z.infer<typeof PRExpectedCurrentSchema>>

const IntakePRArgsSchema = z
  .object({
    bay: TextSchema.optional(),
    name: TextSchema.optional(),
    issue: TextSchema.optional(),
    branch: GitRefSchema.optional(),
    base: GitRefSchema.optional(),
    headSha: GitShaSchema,
    baseSha: GitShaSchema.optional(),
    submitter: TextSchema.optional(),
    composition: CompositionV1Schema.optional(),
    receipt: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    expectedCurrent: PRExpectedCurrentSchema.optional(),
  })
  .strict()
  .refine(({ bay, branch }) => bay !== undefined || branch !== undefined, {
    message: "'bay' or 'branch' is required",
  })
export type IntakePRArgs = z.infer<typeof IntakePRArgsSchema>

const SubmitArgsSchema = z.union([
  z
    .object({
      pr: TextSchema,
      submitter: TextSchema.optional(),
      correlation: CorrelationSchema.optional(),
      flow: FlowPinSchema.optional(),
      expectedCurrent: PRExpectedCurrentSchema.optional(),
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
      correlation: CorrelationSchema.optional(),
      composition: CompositionV1Schema.optional(),
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
  /** Opt in to resident "merge into latest" and every later manual implicit
   * recut of this PR (see `PR.track`). Only a live PR records it: tracking
   * governs future revisions, which a terminal PR no longer has. */
  track?: boolean
  draft?: boolean
  correlation?: Correlation
  composition?: CompositionV1
  resolveRevision(ref: string): Promise<string | undefined>
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

const PrCloseArgsSchema = z.object({ pr: TextSchema, reason: TextSchema.optional() }).strict()
export type PrCloseArgs = z.infer<typeof PrCloseArgsSchema>
const PrEditArgsSchema = z
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
export type PrEditArgs = z.infer<typeof PrEditArgsSchema>

const PrReadyArgsSchema = z.object({ pr: TextSchema, expectedCurrent: PRExpectedCurrentSchema.optional() }).strict()
export type PrReadyArgs = z.infer<typeof PrReadyArgsSchema>
const PrRecutExpectedCurrentSchema = z
  .object({
    revision: RevisionSchema,
    headSha: GitShaSchema,
    track: z.boolean().optional(),
    effectiveReview: PRReviewSchema.optional(),
    checksPassed: z.boolean().optional(),
  })
  .strict()
const PrRecutArgsSchema = z
  .object({
    pr: TextSchema,
    fromRevision: RevisionSchema,
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
    treeSha: GitShaSchema,
    patchId: GitShaSchema,
    reviewCarried: z.boolean(),
    certificate: PRRecutCertificateSchema.optional(),
    sources: z.array(PRRecutSourceSchema).min(1).readonly().optional(),
    composition: CompositionV1Schema.optional(),
    expectedCurrent: PrRecutExpectedCurrentSchema.optional(),
    transition: PRFreshnessTransitionSchema.optional(),
  })
  .strict()
export type PrRecutArgs = z.infer<typeof PrRecutArgsSchema>
const PrSettleSupersededArgsSchema = z
  .object({
    pr: TextSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
    baseTreeSha: GitShaSchema,
    patchId: GitShaSchema,
  })
  .strict()
export type PrSettleSupersededArgs = z.infer<typeof PrSettleSupersededArgsSchema>
const PrRequestChecksArgsSchema = z
  .object({ pr: TextSchema, baseSha: GitShaSchema.optional(), expectedCurrent: PRExpectedCurrentSchema.optional() })
  .strict()
export type PrRequestChecksArgs = z.infer<typeof PrRequestChecksArgsSchema>
const PrRequestReviewArgsSchema = z
  .object({ pr: TextSchema, reviewers: z.array(TextSchema), by: TextSchema.optional() })
  .strict()
export type PrRequestReviewArgs = z.infer<typeof PrRequestReviewArgsSchema>

const PrPublicationComponentSchema = z.object({ path: TextSchema, pin: GitShaSchema }).strict()
export const PrPublicationInputSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
    branch: GitRefSchema,
    sourceRoot: TextSchema,
    components: z.array(PrPublicationComponentSchema).readonly(),
    continuation: z.enum(["none", "queue"]),
  })
  .strict()
export type PrPublicationInput = z.infer<typeof PrPublicationInputSchema>
const PublishedRefSchema = z.object({ path: TextSchema, sha: GitShaSchema, ref: GitRefSchema }).strict()
export const PrPublicationOutputSchema = z
  .object({ pr: PRIdSchema, revision: RevisionSchema, refs: z.array(PublishedRefSchema).readonly() })
  .strict()
export type PrPublicationOutput = z.infer<typeof PrPublicationOutputSchema>
export type PrPublicationService = Readonly<{
  revision: string
  publish(
    input: PrPublicationInput,
    context: JobContext,
  ): JobResult<PrPublicationOutput> | Promise<JobResult<PrPublicationOutput>>
}>

export function prPublicationJobKey(identity: Pick<PrPublicationInput, "pr" | "revision" | "headSha">): string {
  return `pr-publication:${identity.pr}:${String(identity.revision)}:${identity.headSha}`
}

const PrReviewArgsSchema = z
  .object({
    pr: TextSchema,
    by: TextSchema,
    decision: PRReviewDecisionSchema,
    ref: TextSchema.optional(),
    note: TextSchema.optional(),
  })
  .strict()
export type PrReviewArgs = z.infer<typeof PrReviewArgsSchema>

const PrCommentArgsSchema = z
  .object({
    pr: TextSchema,
    by: TextSchema,
    note: TextSchema,
    ref: TextSchema.optional(),
    expectedCurrent: PRExpectedCurrentSchema.optional(),
  })
  .strict()
export type PrCommentArgs = z.infer<typeof PrCommentArgsSchema>

const PRRegressionSeveritySchema = z.enum(["low", "medium", "high", "critical"])
const PrRegressionArgsSchema = z
  .object({
    pr: TextSchema,
    run: TextSchema,
    detectedAt: z.iso.datetime({ offset: true }),
    severity: PRRegressionSeveritySchema,
    evidence: TextSchema,
    implementationRunRef: TextSchema,
    reviewRef: TextSchema,
    repairPr: TextSchema,
    repairRun: TextSchema,
  })
  .strict()
export type PrRegressionArgs = z.infer<typeof PrRegressionArgsSchema>

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
const LegacyPRPushedSchema = z
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
    correlation: CorrelationSchema.optional(),
  })
  .strict()
const PRRecutLineageSchema = z
  .object({ revision: RevisionSchema, headSha: GitShaSchema, baseSha: GitShaSchema.optional() })
  .strict()
const PRRecutReplaySchema = z
  .object({
    pr: PRIdSchema,
    fromRevision: RevisionSchema,
    patchId: GitShaSchema,
    baseSha: GitShaSchema,
    treeSha: GitShaSchema,
    reviewCarried: z.boolean(),
    certificate: PRRecutCertificateSchema.optional(),
    submitter: TextSchema.optional(),
    sources: z.array(PRRecutSourceSchema).min(1).readonly().optional(),
    predecessor: PRRecutLineageSchema,
    successor: PRRecutLineageSchema.extend({ baseSha: GitShaSchema }).strict(),
    composition: CompositionV1Schema.optional(),
    transition: PRFreshnessTransitionSchema.optional(),
  })
  .strict()
const PRRecutFactSchema = PRRecutReplaySchema.extend({ changeId: ChangeIdSchema, submitter: TextSchema }).strict()
const PRPushedV1Schema = z.preprocess(
  normalizeV2Submitter,
  LegacyPRPushedSchema.extend({ submitter: TextSchema }).strict(),
)
const PRPushedSchema = z.preprocess(
  normalizeV2Submitter,
  LegacyPRPushedSchema.extend({ changeId: ChangeIdSchema, submitter: TextSchema }).strict(),
)
const PRPushedReplaySchema = z.union([PRPushedV1Schema, LegacyPRPushedSchema])
const PRRevisionIdentitySchema = z.object({ pr: PRIdSchema, revision: RevisionSchema, headSha: GitShaSchema }).strict()
const LegacyPRRevisionSchema = PRRevisionIdentitySchema.extend({ correlation: CorrelationSchema.optional() }).strict()
const PRRevisionSchema = z.preprocess(
  normalizeV2Submitter,
  LegacyPRRevisionSchema.extend({ submitter: TextSchema, flow: FlowPinSchema.optional() }).strict(),
)
const PRCorrelationBoundSchema = PRRevisionIdentitySchema.extend({ correlation: CorrelationSchema }).strict()
const PRTerminalIdentitySchema = PRRevisionIdentitySchema.extend({
  issueRef: TextSchema.optional(),
  correlation: CorrelationSchema.optional(),
}).strict()
const PRQueueTerminalIdentitySchema = PRTerminalIdentitySchema.extend({ run: TextSchema }).strict()
export const PRWithdrawnSchema = z.preprocess(
  normalizeV2Submitter,
  PRTerminalIdentitySchema.extend({
    reason: TextSchema.optional(),
    /** Carried so terminal ball closures can route back to the revision submitter. */
    submitter: TextSchema.optional(),
  }).strict(),
)
const LegacyPRWithdrawnSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema.optional(),
    headSha: GitShaSchema.optional(),
    correlation: CorrelationSchema.optional(),
  })
  .strict()
const LegacyPRRejectedSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema.optional(),
    correlation: CorrelationSchema.optional(),
    detail: z.string().optional(),
  })
  .strict()
const TransitionalPRRejectedSchema = PRQueueTerminalIdentitySchema.extend({
  detail: z.string().optional(),
}).strict()
const PRReplayRejectedSchema = z.union([PRRejectedFactSchema, TransitionalPRRejectedSchema, LegacyPRRejectedSchema])
const PRIntegratedSchema = z.preprocess(
  normalizeV2Submitter,
  PRQueueTerminalIdentitySchema.extend({
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
const PRAlreadyLandedSettlementSchema = z
  .object({
    kind: z.literal("refresh-superseded"),
    proof: z.literal("payload-already-contained"),
    patchId: GitShaSchema,
  })
  .strict()
export const PRAlreadyLandedSchema = z.preprocess(
  normalizeV2Submitter,
  PRTerminalIdentitySchema.extend({
    run: TextSchema.optional(),
    settlement: PRAlreadyLandedSettlementSchema.optional(),
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
const LegacyPRIntegratedSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    commit: GitShaSchema,
    baseSha: GitShaSchema,
    correlation: CorrelationSchema.optional(),
  })
  .strict()
export const PRCanceledSchema = z.preprocess(
  normalizeV2Submitter,
  PRQueueTerminalIdentitySchema.extend({
    by: TextSchema,
    reason: TextSchema,
    /** Carried so terminal ball closures can route back to the revision submitter. */
    submitter: TextSchema.optional(),
  }).strict(),
)
const LegacyPRCanceledSchema = PRRevisionIdentitySchema.extend({
  correlation: CorrelationSchema.optional(),
  by: TextSchema,
  reason: TextSchema,
}).strict()
type PRRegressionFact = Omit<PRRegression, "recordedAt">
const PRRegressionSchema: z.ZodType<PRRegressionFact> = z
  .object({
    pr: PRIdSchema,
    issueRef: TextSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    run: TextSchema,
    landingSha: GitShaSchema,
    detectedAt: z.iso.datetime({ offset: true }),
    severity: PRRegressionSeveritySchema,
    evidence: TextSchema,
    implementationRunRef: TextSchema,
    reviewRef: TextSchema,
    repairIssueRef: TextSchema,
    repairPr: PRIdSchema,
    repairRun: TextSchema,
    repairLandingSha: GitShaSchema,
  })
  .strict()
const PRReviewFactSchema = z.preprocess(
  normalizeV2By,
  PRReviewSchema.omit({ at: true, carriedFrom: true }).extend({ pr: PRIdSchema }).strict(),
)
const PRCommentFactSchema = z.preprocess(
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
const RetiredPRSessionStartedFactSchema = z.object({ pr: PRIdSchema, launchId: TextSchema }).strict()
const RetiredPRSessionEndedFactSchema = RetiredPRSessionStartedFactSchema.extend({
  outcome: z.enum(["completed", "withdrawn", "crashed", "superseded"]),
}).strict()
const PRCheckRequestFactSchema = PRRevisionIdentitySchema.extend({ baseSha: GitShaSchema.optional() }).strict()
const PRReviewRequestFactSchema = z
  .object({ pr: PRIdSchema, reviewers: z.array(TextSchema), requestedBy: TextSchema })
  .strict()

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
  "pr.publish": JobDef<PrPublicationInput, PrPublicationOutput>
}>

export function createBayJobDefs(workspace: BayWorkspace, publication?: PrPublicationService): BayJobDefs {
  const publisher: PrPublicationService =
    publication ??
    Object.freeze({
      revision: "publication-unavailable-v1",
      publish: (): JobResult<PrPublicationOutput> => ({
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
      input: PrPublicationInputSchema,
      output: PrPublicationOutputSchema,
      observe: (input) => ({
        lifecycle: "publication",
        identity: { pr: input.pr, revision: input.revision, headSha: input.headSha },
        attributes: { continuation: input.continuation, componentCount: input.components.length },
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
    intake: CommandHandler<IntakePRArgs, BayState>
    submit: CommandHandler<SubmitArgs, BayState>
    close: CommandHandler<CloseBayArgs, BayState>
  }>
  pr: Readonly<{
    close: CommandHandler<PrCloseArgs, BayState>
    edit: CommandHandler<PrEditArgs, BayState>
    recut: CommandHandler<PrRecutArgs, BayState>
    settleSuperseded: CommandHandler<PrSettleSupersededArgs, BayState>
    ready: CommandHandler<PrReadyArgs, BayState>
    review: CommandHandler<PrReviewArgs, BayState>
    comment: CommandHandler<PrCommentArgs, BayState>
    requestChecks: CommandHandler<PrRequestChecksArgs, BayState>
    recordAdmission: CommandHandler<PRAdmissionRecordedFact, BayState>
    requestReview: CommandHandler<PrRequestReviewArgs, BayState>
    regression: CommandHandler<PrRegressionArgs, BayState>
    publish: CommandHandler<PrPublicationInput, BayState>
  }>
}>

export type Bays = Readonly<{
  state: ReadSignal<DeepReadonly<BaysState>>
  get(selector: string): DeepReadonly<Bay> | undefined
  list(): readonly DeepReadonly<Bay>[]
  branchLifecycles(): readonly DeepReadonly<BranchLifecycle>[]
  pr(selector: string): DeepReadonly<PR> | undefined
  prs(): readonly DeepReadonly<PR>[]
  reviewState(selector: string): DeepReadonly<PRReviewState>
  needsReview(selector: string, reviewer?: string): boolean
  checksRequested(selector: string): boolean
  open(args: OpenBayArgs): Promise<CommandResult>
  refresh(args: RefreshBayArgs): Promise<CommandResult>
  checkpoint(args: CheckpointBayArgs): Promise<CommandResult>
  orphan(args: OrphanBayArgs): Promise<CommandResult>
  certifyHandoff(args: CertifyHandoffArgs): Promise<CommandResult>
  intake(args: IntakePRArgs): Promise<CommandResult>
  submit(args: SubmitArgs): Promise<CommandResult>
  submitSelection(selector: string, options: SubmitSelectionOptions): Promise<DeepReadonly<PR>>
  close(args: CloseBayArgs): Promise<CommandResult>
  closePr(args: PrCloseArgs): Promise<CommandResult>
  editPr(args: PrEditArgs): Promise<CommandResult>
  recut(args: PrRecutArgs): Promise<CommandResult>
  settleSuperseded(args: PrSettleSupersededArgs): Promise<CommandResult>
  ready(args: PrReadyArgs): Promise<CommandResult>
  review(args: PrReviewArgs): Promise<CommandResult>
  comment(args: PrCommentArgs): Promise<CommandResult>
  requestChecks(args: PrRequestChecksArgs): Promise<CommandResult>
  recordAdmission(args: PRAdmissionRecordedFact): Promise<CommandResult>
  requestReview(args: PrRequestReviewArgs): Promise<CommandResult>
  recordRegression(args: PrRegressionArgs): Promise<CommandResult>
  requestPublication(args: PrPublicationInput): Promise<CommandResult>
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
  | "recordRegression"
  | "requestPublication"
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
    Object.values(state.prs).some((pr) => pr.branch === branch && pr.issue === identity.issue && isLivePR(pr)) ||
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
    selectFlow?: (submission: Submission) => FlowPin
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
        "queue-base-moved",
        `yrd: queue '${resolved.base}' resolved to ${resolved.baseSha.slice(0, 12)}, not pinned ${baseSha.slice(0, 12)}`,
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
  const intake = async (args: IntakePRArgs): Promise<CommandResult> => {
    const selectedPR = (): DeepReadonly<PR> | undefined => {
      const snapshot = state()
      const bay = args.bay === undefined ? undefined : resolveBay(snapshot, args.bay)
      return bay === undefined
        ? args.branch === undefined
          ? undefined
          : resolvePR(snapshot, args.branch)
        : prForBay(snapshot, bay.id)
    }
    const before = selectedPR()
    return observe(
      {
        lifecycle: "intake",
        identity: before === undefined ? undefined : prIdentity(before),
        attributes: {
          ...(args.bay === undefined ? {} : { bay: args.bay }),
          ...(args.branch === undefined ? {} : { branch: args.branch }),
        },
        resultAttributes: () => {
          const selected = selectedPR()
          return selected === undefined ? {} : prIdentity(selected)
        },
      },
      async () => {
        const bay = args.bay === undefined ? undefined : resolveBay(state(), args.bay)
        const recorded = selectedPR()
        const resolved = await target(
          args.base ?? bay?.base ?? recorded?.base,
          args.baseSha ?? bay?.baseSha ?? (recorded === undefined ? undefined : prBaseSha(recorded)),
        )
        return actions.intake({ ...args, ...resolved })
      },
    )
  }
  const submitOperation = async (args: SubmitArgs): Promise<CommandResult> => {
    if ("pr" in args) {
      if (args.flow !== undefined || args.correlation !== undefined || options.selectFlow === undefined) {
        return actions.submit(args)
      }
      const pr = required(resolvePR(state(), args.pr), "PR", args.pr)
      const selected = options.selectFlow({
        base: pr.base,
        branch: pr.branch,
        head: prHead(pr),
        ...(prComposition(pr) === undefined ? {} : { composition: prComposition(pr) }),
        ...(pr.bay === undefined ? {} : { bay: pr.bay }),
        ...(pr.issue === undefined ? {} : { issue: pr.issue }),
      })
      const flow = pr.flow ?? selected
      if (
        pr.flow !== undefined &&
        (pr.flow.name !== selected.name || pr.flow.rev !== selected.rev || pr.flow.fingerprint !== selected.fingerprint)
      ) {
        log?.warn?.(
          pr.flow.name === selected.name && pr.flow.rev === selected.rev
            ? `yrd: flow '${pr.flow.name}' changed structure without bumping revision ${pr.flow.rev}`
            : `yrd: PR '${pr.id}' remains pinned to flow ${pr.flow.name}@${pr.flow.rev}; base config selects ${selected.name}@${selected.rev}`,
          {
            code:
              pr.flow.name === selected.name && pr.flow.rev === selected.rev
                ? "flow-fingerprint-drift"
                : "flow-revision-drift",
            pr: pr.id,
            expectedFlow: pr.flow.name,
            expectedRevision: pr.flow.rev,
            currentFlow: selected.name,
            currentRevision: selected.rev,
          },
        )
      }
      return actions.submit({ ...args, flow })
    }
    const resolved = await target(args.base, args.baseSha)
    const flow =
      args.flow ??
      (args.draft === true || options.selectFlow === undefined
        ? undefined
        : options.selectFlow({
            base: resolved.base,
            branch: args.branch,
            head: args.headSha,
            ...(args.composition === undefined ? {} : { composition: args.composition }),
            ...(args.issue === undefined ? {} : { issue: args.issue }),
          }))
    return actions.submit({ ...args, ...resolved, ...(flow === undefined ? {} : { flow }) })
  }
  const submit = (args: SubmitArgs): Promise<CommandResult> => {
    const selector = "pr" in args ? args.pr : args.branch
    const before = resolvePR(state(), selector)
    return observe(
      {
        lifecycle: "submit",
        identity: before === undefined ? undefined : prIdentity(before),
        attributes: { selector },
        resultAttributes: () => {
          const selected = resolvePR(state(), selector)
          return selected === undefined ? {} : prIdentity(selected)
        },
      },
      () => submitOperation(args),
    )
  }
  const bindCorrelation = async (
    pr: DeepReadonly<PR>,
    correlation: Correlation | undefined,
  ): Promise<DeepReadonly<PR>> => {
    if (correlation === undefined) return pr
    await submitOperation({ pr: pr.id, correlation })
    const bound = resolvePR(state(), pr.id)
    if (bound === undefined) {
      raiseFailure("infrastructure", "pr-state-invalid", `yrd: PR '${pr.id}' disappeared after correlation bind`)
    }
    return bound
  }
  const bindIssue = async (pr: DeepReadonly<PR>, issue: string | undefined): Promise<DeepReadonly<PR>> => {
    if (issue === undefined || pr.issue === issue) return pr
    if (pr.issue !== undefined) {
      raiseFailure(
        "refusal",
        "issue-conflict",
        `yrd: PR '${pr.id}' is already linked to issue '${pr.issue}'; close it before linking another issue`,
      )
    }
    const delivery = prDeliveryState(pr)
    if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready") {
      raiseFailure(
        "refusal",
        "issue-too-late",
        `yrd: PR '${pr.id}' is ${delivery}; issue can only be linked while pushed or submitted`,
      )
    }
    await actions.editPr({ pr: pr.id, issue })
    const bound = resolvePR(state(), pr.id)
    if (bound === undefined) {
      raiseFailure("infrastructure", "pr-state-invalid", `yrd: PR '${pr.id}' disappeared after issue bind`)
    }
    return bound
  }
  const bindMetadata = async (
    pr: DeepReadonly<PR>,
    metadata: Pick<SubmitSelectionOptions, "title" | "description" | "track" | "warnings">,
  ): Promise<DeepReadonly<PR>> => {
    const titleChanged = metadata.title !== undefined && metadata.title !== pr.title
    const descriptionChanged = metadata.description !== undefined && metadata.description !== pr.description
    // Tracking only governs FUTURE resident preparation or a manual implicit
    // recut, which a terminal PR (an integrated/already-landed same-head
    // resubmit reaches this seam at exit 0) no longer has. Recording it there
    // would refuse the whole submit, so state loudly that the flag was not
    // recorded instead of pretending it was.
    const trackable = isLivePR(pr)
    const trackChanged = metadata.track !== undefined && metadata.track !== (pr.track ?? false)
    if (trackChanged && !trackable) {
      const warning =
        `PR '${pr.id}' is ${prDeliveryState(pr)}; --track was NOT recorded. ` +
        "Tracking governs future rebuilds, and this merge request has none."
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
    const bound = resolvePR(state(), pr.id)
    if (bound === undefined) {
      raiseFailure("infrastructure", "pr-state-invalid", `yrd: PR '${pr.id}' disappeared after metadata bind`)
    }
    return bound
  }
  const bindSubmission = async (
    pr: DeepReadonly<PR>,
    submission: Pick<SubmitSelectionOptions, "issue" | "correlation">,
  ): Promise<DeepReadonly<PR>> => bindCorrelation(await bindIssue(pr, submission.issue), submission.correlation)

  const submitSelectionOperation = async (
    selector: string,
    options: SubmitSelectionOptions,
  ): Promise<DeepReadonly<PR>> => {
    const requestedComposition =
      options.composition === undefined ? undefined : CompositionV1Schema.parse(options.composition)
    let snapshot = state()
    const resolved = resolvePRMatch(snapshot, selector)
    if (resolved?.revision !== undefined) requireLivePR(snapshot, selector)
    const selectedBay = resolveBay(snapshot, selector)
    let pr = resolved?.value ?? (selectedBay === undefined ? undefined : resolvePR(snapshot, selectedBay.branch))
    // A closed Bay is archive evidence, not permanent ownership of its branch
    // alias. Addressing that branch again must use the direct-branch delivery
    // path; canonical Bay id/name selectors still resolve the closed Bay and
    // receive the ordinary not-active refusal.
    const closedBranchAlias =
      selectedBay?.status === "closed" && selectedBay.branch.toLowerCase() === selector.toLowerCase()
    let bay = closedBranchAlias
      ? undefined
      : (selectedBay ?? (pr?.bay === undefined ? undefined : resolveBay(snapshot, pr.bay)))
    // D2 — a branch whose PR reached a non-landed terminal status
    // (withdrawn/canceled) mints its next revision automatically down the
    // direct-branch resubmit path below (the reopen preserves the PR identity,
    // so branch→PR stays 1:1). The author no longer hand-makes a delivery branch.
    //
    // Q1 — an integrated/already-landed branch identity is FROZEN evidence, never reopened:
    //  - addressed by its branch, resubmitting the SAME landed head is an
    //    informational "already merged" no-op (returns the integrated PR, exit
    //    0 — delivered work is not a dark queue), while a NEW head mints a fresh
    //    delivery PR (revision 1) via the direct-branch path below, so no
    //    hand-made `<branch>-delivery-<nonce>` branch is needed;
    //  - addressed by its id, it stays idempotent.
    if (pr !== undefined && (prDeliveryState(pr) === "integrated" || prDeliveryState(pr) === "already-landed")) {
      // Addressed by its canonical id, an integrated PR is frozen evidence:
      // idempotent. Addressed by a moving alias (its branch), a new head mints a
      // fresh delivery. The canonical-vs-alias fold lives in resolveSelectorMatch.
      if (resolved?.matchedBy === "canonical") return bindSubmission(pr, options)
      const landedHead = await options.resolveRevision(selector)
      if (landedHead === undefined) {
        raiseFailure("refusal", "git-commit-missing", `yrd: no Git commit '${selector}'`)
      }
      if (landedHead === prHead(pr)) return bindSubmission(pr, options)
      // A new head on a landed branch mints a fresh delivery identity below.
    }

    if (bay?.status === "active") {
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
          `Bay '${bay.id}' has uncommitted work; the PR includes only committed changes. ` +
          "The uncommitted changes remain in the Bay."
        options.warnings?.push(warning)
        log?.warn?.(warning, { action: "submit-dirty-worktree", bay: bay.id })
      }
      if (bay.headSha === undefined) {
        raiseFailure("refusal", "bay-head-missing", `yrd: bay '${bay.id}' has no committed head to submit`)
      }
      pr = prForBay(snapshot, bay.id) ?? resolvePR(snapshot, bay.branch)
      const composition = requestedComposition ?? (pr === undefined ? undefined : prComposition(pr))
      if (pr === undefined || prHead(pr) !== bay.headSha || !sameComposition(composition, prComposition(pr))) {
        await intake({
          bay: bay.id,
          headSha: bay.headSha,
          ...(bay.baseSha === undefined ? {} : { baseSha: bay.baseSha }),
          ...(options.issue === undefined ? {} : { issue: options.issue }),
          ...(composition === undefined ? {} : { composition }),
        })
        pr = prForBay(state(), bay.id) ?? resolvePR(state(), bay.branch)
      }
    }

    // Re-submitting a PR that has no LIVE workspace must re-resolve the branch's current tip
    // rather than reuse the recorded revision's head: a pushed (e.g. draft) or submitted PR
    // whose branch has since moved would otherwise re-register the stale head. Only an ACTIVE
    // bay reads its head from the workspace (handled above); every other shape — bay-less
    // direct branch, and a PR whose bay is closing/closed/failed (reachable by PR id or by the
    // retired bay's id, where the closedBranchAlias escape above does not apply) — resolves the
    // branch tip here. Without this, an idempotent retry re-presented the recorded head at
    // exit 0 and an automated driver concluded the carrier matched its branch when it did not.
    if (
      pr !== undefined &&
      (prDeliveryState(pr) === "submitted" ||
        prDeliveryState(pr) === "ready" ||
        prDeliveryState(pr) === "needs-author" ||
        prDeliveryState(pr) === "pushed") &&
      bay?.status !== "active"
    ) {
      const headSha = await options.resolveRevision(pr.branch)
      if (headSha === undefined && (prDeliveryState(pr) === "submitted" || prDeliveryState(pr) === "ready")) {
        // A submitted PR whose branch no longer resolves cannot be re-submitted from a tip.
        raiseFailure("refusal", "git-commit-missing", `yrd: no Git commit '${pr.branch}'`)
      }
      if (headSha !== undefined) {
        const resolved = await target(options.base ?? pr.base, undefined)
        const composition = requestedComposition ?? prComposition(pr)
        if (
          headSha !== prHead(pr) ||
          resolved.base !== pr.base ||
          resolved.baseSha !== prBaseSha(pr) ||
          !sameComposition(composition, prComposition(pr))
        ) {
          await intake({
            branch: pr.branch,
            headSha,
            ...resolved,
            ...(options.issue === undefined ? {} : { issue: options.issue }),
            ...(composition === undefined ? {} : { composition }),
          })
          pr = resolvePR(state(), pr.id)
          if (pr === undefined) {
            raiseFailure(
              "infrastructure",
              "pr-state-invalid",
              `yrd: PR '${selector}' disappeared after revision intake`,
            )
          }
        }
      }
    }

    // Only a live PR binds an issue in place. A terminal PR resolved here is a
    // withdrawn/canceled branch about to be reopened by the direct-branch
    // resubmit below (D2); its issue rides along when that mint records the
    // fresh revision, so binding here (which refuses on a terminal PR) is skipped.
    if (pr !== undefined && isLivePR(pr)) pr = await bindIssue(pr, options.issue)
    if (
      pr !== undefined &&
      (prDeliveryState(pr) === "submitted" || prDeliveryState(pr) === "ready" || prDeliveryState(pr) === "needs-author")
    ) {
      return bindCorrelation(pr, options.correlation)
    }
    if (pr !== undefined && prDeliveryState(pr) === "pushed") {
      pr = await bindCorrelation(pr, options.correlation)
      if (options.draft === true) return pr
      await submitOperation({ pr: pr.id })
      const submitted = resolvePR(state(), pr.id)
      if (submitted === undefined) {
        raiseFailure("infrastructure", "pr-state-invalid", `yrd: PR '${pr.id}' disappeared after submit`)
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
          (prDeliveryState(candidate) === "pushed" ||
            prDeliveryState(candidate) === "submitted" ||
            prDeliveryState(candidate) === "ready" ||
            prDeliveryState(candidate) === "needs-author") &&
          prHead(candidate) === headSha &&
          candidate.base === resolved.base &&
          sameComposition(prComposition(candidate), requestedComposition),
      )
      if (live !== undefined) {
        const correlated = await bindSubmission(live, options)
        if (prDeliveryState(correlated) === "submitted" || prDeliveryState(correlated) === "ready") {
          return correlated
        }
        if (options.draft === true) return correlated
        await submitOperation({ pr: correlated.id })
        const submitted = resolvePR(state(), live.id)
        if (submitted === undefined) {
          raiseFailure("infrastructure", "pr-state-invalid", `yrd: PR '${live.id}' disappeared after submit`)
        }
        return submitted
      }
      await submitOperation({
        branch: selector,
        headSha,
        ...resolved,
        ...(options.issue === undefined ? {} : { issue: options.issue }),
        ...(options.draft === true ? { draft: true } : {}),
        ...(options.correlation === undefined ? {} : { correlation: options.correlation }),
        ...(requestedComposition === undefined ? {} : { composition: requestedComposition }),
      })
      const submitted = resolvePR(state(), selector)
      if (submitted === undefined) {
        raiseFailure(
          "infrastructure",
          "pr-state-invalid",
          `yrd: direct branch submit '${selector}' did not create a PR`,
        )
      }
      return submitted
    }

    if (bay.status !== "active") {
      raiseFailure("refusal", "bay-not-active", `yrd: bay '${bay.id}' is ${bay.status}, not active`)
    }
    if (pr === undefined) {
      raiseFailure("infrastructure", "pr-state-invalid", `yrd: bay '${bay.id}' intake did not create a PR`)
    }
    raiseFailure("refusal", "pr-not-pushed", `yrd: PR '${pr.id}' is ${prDeliveryState(pr)}, not pushed`)
  }

  const submitSelection = (selector: string, options: SubmitSelectionOptions): Promise<DeepReadonly<PR>> => {
    const before = resolvePR(state(), selector)
    return observe(
      {
        lifecycle: "submit",
        identity: before === undefined ? undefined : prIdentity(before),
        attributes: { selector },
        resultAttributes: prIdentity,
      },
      // Bind the resolved title/description in one seam AFTER the PR is
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
    pr: (selector) => resolvePR(state(), selector),
    prs: () => Object.freeze(Object.values(state().prs)),
    reviewState: (selector) => reviewState(required(resolvePR(state(), selector), "PR", selector)),
    needsReview: (selector, reviewer) => needsReview(required(resolvePR(state(), selector), "PR", selector), reviewer),
    checksRequested: (selector) => checksRequested(required(resolvePR(state(), selector), "PR", selector)),
    submitSelection,
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
    recordRegression: actions.recordRegression,
    requestPublication: actions.requestPublication,
  })
}

export type WithBaysOptions = Readonly<{
  jobs: BayJobDefs
  defaultBase?: string
  defaultSubmitter?: string
  resolveBase?: ResolveBayBase
  selectFlow?: (submission: Submission) => FlowPin
}>

export function withBays(options: WithBaysOptions) {
  const defaultBase = baseIdentity(options.defaultBase ?? "main")
  const defaultSubmitter = TextSchema.parse(options.defaultSubmitter ?? "operator")
  const commands = createBayCommands(options.jobs, defaultBase, defaultSubmitter)

  return <State extends object, Commands extends CommandTree, Features extends HasJobs>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { bays: emptyBaysState() },
      commands,
      events: {
        "bay/opened": journalEvent(1, BayOpenedSchema),
        "bay/closing": journalEvent(1, BayClosingSchema),
        "bay/orphaned": journalEvent(1, BayOrphanedSchema),
        "bay/handoff-certified": journalEvent(1, BayHandoffCertifiedSchema),
        "pr/pushed": journalEvent(2, PRPushedSchema),
        "pr/recut": journalEvent(3, PRRecutFactSchema),
        "pr/submitted": journalEvent(1, PRRevisionSchema),
        "pr/correlation-bound": journalEvent(1, PRCorrelationBoundSchema),
        "pr/withdrawn": journalEvent(1, PRWithdrawnSchema),
        "pr/needs-author": journalEvent(1, PRNeedsAuthorFactSchema),
        "pr/rejected": journalEvent(1, PRRejectedFactSchema),
        "pr/terminal-associated": journalEvent(1, PRTerminalAssociationSchema),
        "pr/integrated": journalEvent(1, PRIntegratedSchema),
        "pr/already-landed": journalEvent(1, PRAlreadyLandedSchema),
        "pr/canceled": journalEvent(1, PRCanceledSchema),
        "pr/regression-recorded": journalEvent(1, PRRegressionSchema),
        "pr/edited": journalEvent(1, PrEditArgsSchema),
        "pr/reviewed": journalEvent(1, PRReviewFactSchema),
        "pr/commented": journalEvent(1, PRCommentFactSchema),
        "pr/session-started": journalEvent(1, RetiredPRSessionStartedFactSchema),
        "pr/session-ended": journalEvent(1, RetiredPRSessionEndedFactSchema),
        "pr/checks-requested": journalEvent(1, PRCheckRequestFactSchema),
        "pr/admission-recorded": journalEvent(2, PRAdmissionRecordedFactSchema),
        "pr/review-requested": journalEvent(1, PRReviewRequestFactSchema),
      },
      replayEvents: {
        "pr/pushed": PRPushedReplaySchema,
        "pr/recut": PRRecutReplaySchema,
        "pr/submitted": LegacyPRRevisionSchema,
        "pr/withdrawn": z.union([PRWithdrawnSchema, LegacyPRWithdrawnSchema]),
        "pr/needs-author": PRNeedsAuthorFactSchema,
        "pr/rejected": PRReplayRejectedSchema,
        "pr/integrated": z.union([PRIntegratedSchema, LegacyPRIntegratedSchema]),
        "pr/already-landed": PRAlreadyLandedSchema,
        "pr/canceled": z.union([PRCanceledSchema, LegacyPRCanceledSchema]),
        "pr/admission-recorded": PRAdmissionRecordedFactSchema,
      },
      projectionVersion: "bays-v13-recut-certificate",
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
              recordRegression: (args) => yrd.dispatch(commands.pr.regression, args),
              requestPublication: (args) => yrd.dispatch(commands.pr.publish, args),
            },
            {
              defaultBase,
              ...(options.resolveBase === undefined ? {} : { resolveBase: options.resolveBase }),
              ...(options.selectFlow === undefined ? {} : { selectFlow: options.selectFlow }),
            },
            yrd.log.child("bay"),
          ),
        }
      },
    })
}

function prIdentity(pr: DeepReadonly<PR>): YrdDeliveryIdentity {
  return {
    pr: pr.id,
    revision: prRevisionNumber(pr),
    headSha: prHead(pr),
    ...(prCorrelation(pr) === undefined ? {} : { correlation: prCorrelation(pr) }),
  }
}

function jobDetail(job: DeepReadonly<Job>): string {
  if (job.status === "completed" && job.conclusion === "failure") return job.error.message
  if (job.status === "completed" && job.conclusion === "timed_out") return job.lostReason
  if (job.status === "completed" && job.conclusion === "cancelled") return job.cancelReason
  if (job.status === "waiting") return job.detail ?? job.status
  return job.status
}

function createBayCommands(jobs: BayJobDefs, defaultBase: string, defaultSubmitter: string): BayCommands {
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
        params: IntakePRArgsSchema,
        apply: (state: BayState, args: IntakePRArgs, context) =>
          intakePR(state, args, defaultBase, defaultSubmitter, context.command.id),
      }),
      submit: command({
        title: "Submit work",
        visibility: "public",
        params: SubmitArgsSchema,
        apply: (state: BayState, args: SubmitArgs, context) =>
          submitWork(state, args, defaultBase, defaultSubmitter, context.command.id),
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
        title: "Close a PR",
        visibility: "public",
        params: PrCloseArgsSchema,
        apply: (state: BayState, args: PrCloseArgs) => closePr(state, args),
      }),
      edit: command({
        title: "Edit a PR",
        visibility: "public",
        params: PrEditArgsSchema,
        apply: (state: BayState, args: PrEditArgs) => editPr(state, args),
      }),
      recut: command({
        title: "Record a mechanically equivalent PR recut",
        visibility: "public",
        params: PrRecutArgsSchema,
        apply: (state: BayState, args: PrRecutArgs) => recutPr(state, args, defaultSubmitter),
      }),
      settleSuperseded: command({
        title: "Settle a queued PR whose payload current main already contains",
        params: PrSettleSupersededArgsSchema,
        apply: (state: BayState, args: PrSettleSupersededArgs) => settleSupersededPr(state, args),
      }),
      ready: command({
        title: "Mark a PR ready",
        visibility: "public",
        params: PrReadyArgsSchema,
        apply: (state: BayState, args: PrReadyArgs) => readyPr(state, args, defaultSubmitter),
      }),
      review: command({
        title: "Review a PR revision",
        visibility: "public",
        params: PrReviewArgsSchema,
        apply: (state: BayState, args: PrReviewArgs) => reviewPr(state, args),
      }),
      comment: command({
        title: "Comment on a PR revision",
        visibility: "public",
        params: PrCommentArgsSchema,
        apply: (state: BayState, args: PrCommentArgs) => commentPr(state, args),
      }),
      requestChecks: command({
        title: "Request checks for a PR revision",
        params: PrRequestChecksArgsSchema,
        apply: (state: BayState, args: PrRequestChecksArgs) => requestPrChecks(state, args),
      }),
      recordAdmission: command({
        title: "Record admission evidence for a PR revision",
        params: PRAdmissionRecordedFactSchema,
        apply: (state: BayState, args: PRAdmissionRecordedFact) => recordPrAdmission(state, args),
      }),
      requestReview: command({
        title: "Replace the requested reviewers for a PR",
        visibility: "public",
        params: PrRequestReviewArgsSchema,
        apply: (state: BayState, args: PrRequestReviewArgs) => requestPrReview(state, args, defaultSubmitter),
      }),
      regression: command({
        title: "Record a completed escaped regression",
        params: PrRegressionArgsSchema,
        apply: (state: BayState, args: PrRegressionArgs) => recordPrRegression(state, args),
      }),
      publish: command({
        title: "Request immutable PR publication",
        params: PrPublicationInputSchema,
        apply: (state: BayState, args: PrPublicationInput) => requestPrPublication(state, args, jobs["pr.publish"]),
      }),
    },
  }
}

function requestPrPublication(
  state: DeepReadonly<BayState>,
  args: PrPublicationInput,
  publication: BayJobDefs["pr.publish"],
) {
  const pr = required(resolvePR(state.bays, args.pr), "PR", args.pr)
  const revision = currentPRRev(pr)
  if (prDeliveryState(pr) !== "pushed") {
    raiseFailure("refusal", "publication-pr-not-draft", `yrd: PR '${pr.id}' is ${prDeliveryState(pr)}, not pushed`)
  }
  if (revision.n !== args.revision || revision.head !== args.headSha || pr.branch !== args.branch) {
    raiseFailure(
      "refusal",
      "publication-revision-moved",
      `yrd: PR '${pr.id}' is revision ${revision.n} head '${revision.head}' on '${pr.branch}', not requested ` +
        `revision ${args.revision} head '${args.headSha}' on '${args.branch}'`,
    )
  }
  if (prBaseSha(pr) !== args.baseSha) {
    raiseFailure(
      "refusal",
      "publication-base-moved",
      `yrd: PR '${pr.id}' base is '${prBaseSha(pr) ?? "missing"}', not requested '${args.baseSha}'`,
    )
  }
  return { events: [publication.request(args, { key: prPublicationJobKey(args) })] }
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

function requireExpectedPRCurrent(
  state: DeepReadonly<BaysState>,
  expected: PRExpectedCurrent,
  operation: "intake" | "submit" | "ready" | "request-checks" | "comment",
): LivePR {
  const pr = resolvePR(state, expected.pr)
  const matches =
    pr !== undefined &&
    isLivePR(pr) &&
    prRevisionNumber(pr) === expected.revision &&
    prHead(pr) === expected.headSha &&
    (expected.track === undefined || (pr.track ?? false) === expected.track)
  if (matches) return pr as LivePR
  const actual =
    pr === undefined
      ? "missing"
      : `${prDeliveryState(pr)} revision ${prRevisionNumber(pr)}@${prHead(pr)} track=${String(pr.track ?? false)}`
  const expectedTracking = expected.track === undefined ? "" : ` track=${String(expected.track)}`
  raiseFailure(
    "refusal",
    `${operation}-current-changed`,
    `yrd: PR '${expected.pr}' changed from revision ${expected.revision}@${expected.headSha}` +
      `${expectedTracking} to ${actual} before ${operation}`,
  )
}

function requireExpectedPRTargetCurrent(
  state: DeepReadonly<BaysState>,
  target: string,
  expected: PRExpectedCurrent,
  operation: "submit" | "ready" | "request-checks" | "comment",
): LivePR {
  const pr = requireExpectedPRCurrent(state, expected, operation)
  const targetPr = resolvePR(state, target)
  if (targetPr?.id === pr.id) return pr
  raiseFailure(
    "refusal",
    `${operation}-current-changed`,
    `yrd: expected PR '${pr.id}' does not match ${operation} target '${target}'`,
  )
}

function changeIdForRevision(existing: DeepReadonly<PR> | undefined, commandId: string): ChangeId {
  if (existing === undefined) return changeIdForCommand(commandId)
  const changeId = currentPRRev(existing).changeId
  if (changeId !== undefined) return changeId
  raiseFailure(
    "refusal",
    "legacy-change-id-missing",
    `yrd: PR '${existing.id}' predates stable Change-Id identity; run the landing-receipt migration before rebuilding it`,
  )
}

function intakePR(
  state: DeepReadonly<BayState>,
  args: IntakePRArgs,
  defaultBase: string,
  defaultSubmitter: string,
  commandId: string,
) {
  const current = state.bays
  const bay = args.bay === undefined ? undefined : required(resolveBay(current, args.bay), "bay", args.bay)
  if (bay !== undefined && bay.status !== "active") throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
  const branch = args.branch ?? bay?.branch
  if (branch === undefined) throw new Error("yrd: bay.intake: 'bay' or 'branch' is required")
  const expected =
    args.expectedCurrent === undefined ? undefined : requireExpectedPRCurrent(current, args.expectedCurrent, "intake")
  if (expected !== undefined && expected.branch !== branch) {
    raiseFailure(
      "refusal",
      "intake-current-changed",
      `yrd: expected PR '${expected.id}' branch '${expected.branch}' does not match intake branch '${branch}'`,
    )
  }
  const associated = bay === undefined ? undefined : prForBay(current, bay.id)
  const branchPR = resolvePR(current, branch)
  const existing = associated ?? (branchPR !== undefined && isLivePR(branchPR) ? branchPR : undefined)
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
      if (!matches) throw new Error(`yrd: receiver receipt '${args.receipt}' does not match its recorded intake`)
      return { events: [] }
    }
  }
  if (existing !== undefined && !isLivePR(existing)) {
    throw new Error(`yrd: PR '${existing.id}' is ${prDeliveryState(existing)}; start a new bay`)
  }
  const issue = attachedIssue(existing, args.issue, bay?.issue)
  const name = args.name ?? bay?.name ?? existing?.name
  // Omitted receiver fields inherit the recorded payload for idempotence, while
  // an explicit base/composition delta remains an authored recut and may resume
  // the PR. Display-name drift alone never mints a content revision.
  const replayBaseSha = args.baseSha ?? (existing === undefined ? undefined : prBaseSha(existing))
  const replayComposition = args.composition ?? (existing === undefined ? undefined : prComposition(existing))
  refuseDuplicatePayload(current, args.headSha, base, replayComposition, existing?.id)
  const resumesSubmission =
    existing !== undefined && (prNeedsAuthor(existing) !== undefined || prDeliveryState(existing) === "rejected")
  if (
    existing !== undefined &&
    prHead(existing) === args.headSha &&
    baseIdentity(existing.base) === base &&
    prBaseSha(existing) === replayBaseSha &&
    sameComposition(prComposition(existing), replayComposition) &&
    existing.issue === issue
  ) {
    return { events: [] }
  }
  const id = existing?.id ?? nextId("PR", current.prs)
  const changeId = changeIdForRevision(existing, commandId)
  const submitter = args.submitter ?? defaultSubmitter
  const revision = (existing === undefined ? 0 : prRevisionNumber(existing)) + 1
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
      ...(resumesSubmission
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
  commandId?: string,
) {
  const current = state.bays
  if ("pr" in args) {
    // Submit-by-id routes through the same live guard as the other 9 mutating
    // verbs (no resolve exemption): an id-addressed terminal PR passes through
    // (matchedBy canonical) to the state check below; a live-less branch
    // selector refuses no-live-pr here. The D2/Q1 terminal-branch reopen/mint
    // semantics live entirely in the {branch} path and submitSelectionOperation,
    // never this {pr} path, so no pre-guard resolution is needed here.
    const pr: LivePR =
      args.expectedCurrent === undefined
        ? requireLivePR(current, args.pr)
        : requireExpectedPRTargetCurrent(current, args.pr, args.expectedCurrent, "submit")
    if (args.correlation !== undefined) return bindPRCorrelation(pr, args.correlation)
    if (prDeliveryState(pr) !== "pushed") {
      throw new Error(`yrd: PR '${pr.id}' is ${prDeliveryState(pr)}, not pushed`)
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

  const existing = resolvePR(current, args.branch)
  const resumesSubmission =
    existing !== undefined && (prNeedsAuthor(existing) !== undefined || prDeliveryState(existing) === "rejected")
  const base = baseIdentity(args.base ?? (resumesSubmission ? existing.base : defaultBase))
  if (
    existing !== undefined &&
    !resumesSubmission &&
    (prDeliveryState(existing) === "pushed" ||
      prDeliveryState(existing) === "submitted" ||
      prDeliveryState(existing) === "ready")
  ) {
    throw new Error(`yrd: branch '${args.branch}' already has live PR '${existing.id}'`)
  }
  const baseSha = args.baseSha ?? (resumesSubmission ? prBaseSha(existing) : undefined)
  const composition = args.composition ?? (resumesSubmission ? prComposition(existing) : undefined)
  if (
    resumesSubmission &&
    prHead(existing) === args.headSha &&
    baseIdentity(existing.base) === base &&
    prBaseSha(existing) === baseSha &&
    sameComposition(prComposition(existing), composition)
  ) {
    return { events: [] }
  }
  refuseDuplicatePayload(current, args.headSha, base, composition, existing?.id)
  // D2 — reopen the existing PR identity (next revision) for a non-landed
  // terminal branch, not just a rejected one. `rejected` already reopened;
  // `withdrawn`/`canceled` now do too, so resubmitting the branch mints the
  // next revision in place instead of demanding a hand-made delivery branch.
  // The pr/pushed projection clears the terminal markers on reopen. `pushed`/
  // `submitted` are already refused above, and `integrated`/`already-landed` are intercepted by
  // the terminal-branch guard before this path (its redelivery is parked).
  const resubmitted =
    existing !== undefined &&
    (prNeedsAuthor(existing) !== undefined ||
      (["rejected", "withdrawn", "canceled"] as const).includes(
        prDeliveryState(existing) as "rejected" | "withdrawn" | "canceled",
      ))
      ? existing
      : undefined
  const id = resubmitted?.id ?? nextId("PR", current.prs)
  if (commandId === undefined) {
    raiseFailure("infrastructure", "change-id-command-missing", "yrd: change creation requires its durable command id")
  }
  const changeId = changeIdForRevision(resubmitted, commandId)
  const revision = (resubmitted === undefined ? 0 : prRevisionNumber(resubmitted)) + 1
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
    ...(args.correlation === undefined ? {} : { correlation: args.correlation }),
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
              ...(args.correlation === undefined ? {} : { correlation: args.correlation }),
            }),
          ]),
      ...(args.reviewers === undefined || args.reviewers.length === 0
        ? []
        : [event("pr/review-requested", { pr: id, reviewers: args.reviewers, requestedBy: submitter })]),
    ],
  }
}

function correlationsEqual(left: DeepReadonly<Correlation>, right: DeepReadonly<Correlation>): boolean {
  return left.namespace === right.namespace && left.id === right.id
}

function correlationLabel(correlation: DeepReadonly<Correlation>): string {
  return `${correlation.namespace}:${correlation.id}`
}

function bindPRCorrelation(pr: DeepReadonly<PR>, correlation: Correlation) {
  const currentCorrelation = prCorrelation(pr)
  if (currentCorrelation !== undefined) {
    if (correlationsEqual(currentCorrelation, correlation)) return { events: [] }
    raiseFailure(
      "refusal",
      "correlation-conflict",
      `yrd: PR '${pr.id}' is already bound to correlation '${correlationLabel(currentCorrelation)}'`,
    )
  }
  const delivery = prDeliveryState(pr)
  if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready" && delivery !== "needs-author") {
    raiseFailure(
      "refusal",
      "correlation-too-late",
      `yrd: PR '${pr.id}' is ${delivery}; correlation can only be bound while pushed, submitted, or needs-author`,
    )
  }
  return {
    events: [
      event("pr/correlation-bound", {
        pr: pr.id,
        revision: prRevisionNumber(pr),
        headSha: prHead(pr),
        correlation,
      }),
    ],
  }
}

function revisionIdentity(pr: DeepReadonly<PR>) {
  return {
    revision: prRevisionNumber(pr),
    headSha: prHead(pr),
    ...(prCorrelation(pr) === undefined ? {} : { correlation: prCorrelation(pr) }),
  }
}

function currentRevisionSubmitter(pr: DeepReadonly<PR>): string | undefined {
  return currentPRRev(pr).submitter
}

function terminalIdentity(pr: DeepReadonly<PR>) {
  const submitter = currentRevisionSubmitter(pr)
  return {
    ...revisionIdentity(pr),
    ...(pr.issue === undefined ? {} : { issueRef: pr.issue }),
    ...(submitter === undefined ? {} : { submitter }),
  }
}

function attachedIssue(
  existing: DeepReadonly<PR> | undefined,
  requested: string | undefined,
  fallback?: string,
): string | undefined {
  if (existing?.issue !== undefined && requested !== undefined && existing.issue !== requested) {
    raiseFailure(
      "refusal",
      "issue-conflict",
      `yrd: PR '${existing.id}' is already linked to issue '${existing.issue}'; close it before linking another issue`,
    )
  }
  return requested ?? existing?.issue ?? fallback
}

function correlationPatch(pr: DeepReadonly<PR>, correlation: DeepReadonly<Correlation>) {
  return {
    revs: pr.revs.map((revision) =>
      revision.n === prRevisionNumber(pr) && revision.head === prHead(pr)
        ? { ...revision, correlation: { ...correlation } }
        : revision,
    ),
  }
}

function assertTerminalApplies(
  pr: DeepReadonly<PR>,
  terminal: Readonly<{ revision?: number; headSha?: string; issueRef?: string; correlation?: Correlation }>,
  eventName: string,
): void {
  const currentCorrelation = prCorrelation(pr)
  if (
    (terminal.revision !== undefined && terminal.revision !== prRevisionNumber(pr)) ||
    (terminal.headSha !== undefined && terminal.headSha !== prHead(pr))
  ) {
    throw new Error(
      `yrd: stale terminal '${eventName}' for PR '${pr.id}' targets ${terminal.revision ?? "unknown"}@${terminal.headSha ?? "unknown"}; current is ${prRevisionNumber(pr)}@${prHead(pr)}`,
    )
  }
  if (terminal.issueRef !== undefined && terminal.issueRef !== pr.issue) {
    throw new Error(`yrd: terminal issue '${terminal.issueRef}' does not match PR '${pr.id}'`)
  }
  if (
    terminal.correlation !== undefined &&
    (currentCorrelation === undefined || !correlationsEqual(currentCorrelation, terminal.correlation))
  ) {
    throw new Error(`yrd: terminal correlation does not match PR '${pr.id}'`)
  }
}

function associateRejectedTerminalRun(
  pr: DeepReadonly<PR>,
  identity: Readonly<{ revision: number; headSha: string }>,
  run: string,
): PR {
  let found = false
  const revisions = pr.revs.map((revision) => {
    if (revision.n !== identity.revision || revision.head !== identity.headSha) return revision
    found = true
    if (revision.terminal?.kind !== "rejected") {
      throw new Error(
        `yrd: PR '${pr.id}' revision ${identity.revision}@${identity.headSha} has no rejected terminal to associate`,
      )
    }
    if (revision.terminal.run !== undefined && revision.terminal.run !== run) {
      throw new Error(
        `yrd: PR '${pr.id}' revision ${identity.revision}@${identity.headSha} is already associated with '${revision.terminal.run}'`,
      )
    }
    return { ...revision, terminal: { ...revision.terminal, run } }
  })
  if (!found) {
    throw new Error(`yrd: PR '${pr.id}' has no revision ${identity.revision}@${identity.headSha} to associate`)
  }
  const current = prRevisionNumber(pr) === identity.revision && prHead(pr) === identity.headSha
  if (current && prDeliveryState(pr) !== "rejected") {
    throw new Error(`yrd: current PR '${pr.id}' is ${prDeliveryState(pr)}, not rejected`)
  }
  if (current && pr.terminalRun !== undefined && pr.terminalRun !== run) {
    throw new Error(`yrd: current PR '${pr.id}' is already associated with '${pr.terminalRun}'`)
  }
  return { ...pr, revs: revisions, ...(current ? { terminalRun: run } : {}) }
}

function readyPr(state: DeepReadonly<BayState>, args: PrReadyArgs, defaultSubmitter: string) {
  const pr: LivePR =
    args.expectedCurrent === undefined
      ? requireLivePR(state.bays, args.pr)
      : requireExpectedPRTargetCurrent(state.bays, args.pr, args.expectedCurrent, "ready")
  if (prDeliveryState(pr) === "submitted" || prDeliveryState(pr) === "ready") return { events: [] }
  return submitWork(state, args, "main", defaultSubmitter)
}

function settleSupersededPr(state: DeepReadonly<BayState>, args: PrSettleSupersededArgs) {
  const pr: LivePR = requireLivePR(state.bays, args.pr)
  const current = currentPRRev(pr)
  if (current.n !== args.revision || current.head !== args.headSha) {
    raiseFailure(
      "refusal",
      "recut-current-changed",
      `yrd: PR '${pr.id}' current revision changed from ${args.revision}@${args.headSha} ` +
        `to ${current.n}@${current.head} while the refresh proof was computed`,
    )
  }
  const delivery = prDeliveryState(pr)
  if ((delivery !== "submitted" && delivery !== "ready") || !checksRequested(pr)) {
    raiseFailure(
      "refusal",
      "recut-transition-not-admitted",
      `yrd: PR '${pr.id}' revision ${current.n} is not the accepted revision selected for refresh`,
    )
  }
  if (current.recut !== undefined && current.recut.patchId !== args.patchId) {
    raiseFailure(
      "refusal",
      "recut-patch-drift",
      `yrd: PR '${pr.id}' automatic refresh changed patch identity from ${current.recut.patchId} to ${args.patchId}`,
    )
  }
  return {
    events: [
      event("pr/already-landed", {
        pr: pr.id,
        revision: current.n,
        headSha: current.head,
        ...(pr.issue === undefined ? {} : { issueRef: pr.issue }),
        ...(prCorrelation(pr) === undefined ? {} : { correlation: prCorrelation(pr) }),
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

function recutPr(state: DeepReadonly<BayState>, args: PrRecutArgs, defaultSubmitter: string) {
  const pr: LivePR = requireLivePR(state.bays, args.pr)
  if (!isLivePR(pr)) {
    raiseFailure(
      "refusal",
      "terminal-target",
      `yrd: PR '${pr.id}' is ${prDeliveryState(pr)}; a finished merge request cannot be rebuilt`,
    )
  }
  const predecessor = pr.revs.find((revision) => revision.n === args.fromRevision)
  if (predecessor === undefined) {
    raiseFailure("refusal", "revision-missing", `yrd: PR '${pr.id}' has no revision ${args.fromRevision}`)
  }
  if (args.certificate !== undefined) {
    const expectedReview = args.expectedCurrent?.effectiveReview
    const rootSources = args.sources?.filter((source) => source.repo === ".") ?? []
    const rootSource = rootSources[0]
    if (
      args.expectedCurrent === undefined ||
      expectedReview?.decision !== "approve" ||
      !args.reviewCarried ||
      rootSources.length !== 1 ||
      rootSource?.fromHeadSha !== predecessor.head ||
      rootSource.toHeadSha !== args.headSha ||
      rootSource.patchId !== args.patchId
    ) {
      raiseFailure(
        "refusal",
        "recut-certificate-invalid",
        `yrd: PR '${pr.id}' certified rebuild requires an approved expected-current review and exactly one matching root source`,
      )
    }
  }
  const recut = prRecut(pr)
  const unchanged =
    prHead(pr) === args.headSha &&
    prBaseSha(pr) === args.baseSha &&
    recut?.fromRevision === args.fromRevision &&
    recut.patchId === args.patchId &&
    recut.treeSha === args.treeSha &&
    recut.reviewCarried === args.reviewCarried &&
    recut.certificate === args.certificate &&
    JSON.stringify(recut.sources) === JSON.stringify(args.sources) &&
    recut.transition?.from === args.transition?.from &&
    recut.transition?.to === args.transition?.to &&
    sameComposition(prComposition(pr), args.composition)
  if (args.expectedCurrent?.track !== undefined && (pr.track ?? false) !== args.expectedCurrent.track) {
    raiseFailure(
      "refusal",
      "recut-current-changed",
      `yrd: PR '${pr.id}' tracking changed from ${String(args.expectedCurrent.track)} ` +
        `to ${String(pr.track ?? false)} while the rebuild was being computed`,
    )
  }
  if (
    args.expectedCurrent !== undefined &&
    (prRevisionNumber(pr) !== args.expectedCurrent.revision || prHead(pr) !== args.expectedCurrent.headSha) &&
    !(unchanged && args.certificate === undefined)
  ) {
    raiseFailure(
      "refusal",
      "recut-current-changed",
      `yrd: PR '${pr.id}' current revision changed from ${args.expectedCurrent.revision}@${args.expectedCurrent.headSha}` +
        ` to ${prRevisionNumber(pr)}@${prHead(pr)} while the rebuild was being computed`,
    )
  }
  if (
    args.expectedCurrent?.effectiveReview !== undefined &&
    !isDeepStrictEqual(reviewState(pr).current, args.expectedCurrent.effectiveReview)
  ) {
    raiseFailure(
      "refusal",
      "recut-review-changed",
      `yrd: PR '${pr.id}' effective review changed while the rebuild was being computed`,
    )
  }
  if (args.expectedCurrent?.checksPassed !== undefined) {
    const checksPassed = currentPRRev(pr).admission?.status === "passed"
    if (checksPassed !== args.expectedCurrent.checksPassed) {
      if (checksPassed) {
        raiseFailure(
          "refusal",
          "recut-would-discard-green",
          `yrd: PR '${pr.id}' checks passed while the rebuild was being computed; re-run with --force to replace green evidence`,
        )
      }
      raiseFailure(
        "refusal",
        "recut-current-changed",
        `yrd: PR '${pr.id}' check status changed while the rebuild was being computed`,
      )
    }
  }
  if (unchanged) return { events: [] }

  if (args.transition !== undefined) {
    if (args.expectedCurrent === undefined) {
      raiseFailure(
        "refusal",
        "recut-transition-current-required",
        `yrd: PR '${pr.id}' Queue freshness transition requires an expected current revision`,
      )
    }
    if (
      (prDeliveryState(pr) !== "submitted" && prDeliveryState(pr) !== "ready") ||
      !checksRequested(pr) ||
      args.fromRevision !== prRevisionNumber(pr)
    ) {
      raiseFailure(
        "refusal",
        "recut-transition-not-admitted",
        `yrd: PR '${pr.id}' revision ${prRevisionNumber(pr)} is not the accepted revision selected for refresh`,
      )
    }
    if (predecessor.recut !== undefined && predecessor.recut.patchId !== args.patchId) {
      raiseFailure(
        "refusal",
        "recut-patch-drift",
        `yrd: PR '${pr.id}' automatic refresh changed patch identity from ${predecessor.recut.patchId} to ${args.patchId}`,
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
      `yrd: PR '${pr.id}' revision ${predecessor.n} has no approval to carry`,
    )
  }
  const successor = { revision: prRevisionNumber(pr) + 1, headSha: args.headSha, baseSha: args.baseSha }
  const changeId = predecessor.changeId
  if (changeId === undefined) {
    raiseFailure(
      "refusal",
      "legacy-change-id-missing",
      `yrd: PR '${pr.id}' predates stable Change-Id identity; run the landing-receipt migration before rebuilding it`,
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
        ...(args.certificate === undefined ? {} : { certificate: args.certificate }),
        ...(args.sources === undefined ? {} : { sources: args.sources }),
        predecessor: {
          revision: predecessor.n,
          headSha: predecessor.head,
          ...(predecessor.baseSha === undefined ? {} : { baseSha: predecessor.baseSha }),
        },
        successor,
        ...(args.composition === undefined ? {} : { composition: args.composition }),
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
              ...(predecessor.correlation === undefined ? {} : { correlation: predecessor.correlation }),
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

function requestPrReview(state: DeepReadonly<BayState>, args: PrRequestReviewArgs, defaultSubmitter: string) {
  const pr: LivePR = requireLivePR(state.bays, args.pr)
  const delivery = prDeliveryState(pr)
  if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready") {
    raiseFailure(
      "refusal",
      "terminal-target",
      `yrd: PR '${pr.id}' is ${delivery}; terminal PRs cannot change requested reviewers`,
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

function reviewPr(state: DeepReadonly<BayState>, args: PrReviewArgs) {
  const pr: LivePR = requireLivePR(state.bays, args.pr)
  const fact = PRReviewFactSchema.parse({
    pr: pr.id,
    revision: prRevisionNumber(pr),
    headSha: prHead(pr),
    by: args.by,
    decision: args.decision,
    ...(args.ref === undefined ? {} : { ref: args.ref }),
    ...(args.note === undefined ? {} : { note: args.note }),
  })
  return reviewFact(pr, fact, "review")
}

function commentPr(state: DeepReadonly<BayState>, args: PrCommentArgs) {
  const pr: LivePR =
    args.expectedCurrent === undefined
      ? requireLivePR(state.bays, args.pr)
      : requireExpectedPRTargetCurrent(state.bays, args.pr, args.expectedCurrent, "comment")
  const fact = PRCommentFactSchema.parse({
    pr: pr.id,
    revision: prRevisionNumber(pr),
    headSha: prHead(pr),
    by: args.by,
    note: args.note,
    ...(args.ref === undefined ? {} : { ref: args.ref }),
  })
  return reviewFact(pr, fact, "comment")
}

function requestPrChecks(state: DeepReadonly<BayState>, args: PrRequestChecksArgs) {
  const pr: LivePR =
    args.expectedCurrent === undefined
      ? requireLivePR(state.bays, args.pr)
      : requireExpectedPRTargetCurrent(state.bays, args.pr, args.expectedCurrent, "request-checks")
  const delivery = prDeliveryState(pr)
  if (
    delivery !== "pushed" &&
    delivery !== "submitted" &&
    delivery !== "ready" &&
    delivery !== "rejected" &&
    delivery !== "needs-author"
  ) {
    throw new PrCheckabilityConflict(pr.id, delivery)
  }
  const baseSha = args.baseSha ?? prBaseSha(pr)
  return {
    events: [
      event("pr/checks-requested", {
        pr: pr.id,
        revision: prRevisionNumber(pr),
        headSha: prHead(pr),
        ...(baseSha === undefined ? {} : { baseSha }),
      }),
    ],
  }
}

function recordPrAdmission(state: DeepReadonly<BayState>, args: PRAdmissionRecordedFact) {
  const pr: LivePR = requireLivePR(state.bays, args.pr)
  if (prRevisionNumber(pr) !== args.revision || prHead(pr) !== args.headSha) {
    raiseFailure(
      "refusal",
      "stale-pr",
      `yrd: entry checks target stale revision ${args.revision} (${args.headSha}) of PR '${pr.id}'`,
    )
  }
  const delivery = prDeliveryState(pr)
  if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready" && delivery !== "needs-author") {
    throw new PrCheckabilityConflict(pr.id, delivery)
  }
  const prior = currentPRRev(pr).admission
  if (
    prior !== undefined &&
    JSON.stringify({ ...prior, at: undefined }) === JSON.stringify({ ...args.admission, at: undefined })
  ) {
    return { events: [] }
  }
  return { events: [event("pr/admission-recorded", args)] }
}

function recordPrRegression(state: DeepReadonly<BayState>, args: PrRegressionArgs) {
  const original: LivePR = requireLivePR(state.bays, args.pr)
  const repair = resolvePR(state.bays, args.repairPr)
  if (repair === undefined) throw new Error(`yrd: no repair PR '${args.repairPr}'`)
  if (original.id === repair.id) throw new Error("yrd: an escaped regression requires a different repair PR")
  if (!original.merged || original.integration === undefined) {
    throw new Error(`yrd: original PR '${original.id}' is ${prDeliveryState(original)}, not integrated`)
  }
  if (!repair.merged || repair.integration === undefined) {
    throw new Error(`yrd: repair PR '${repair.id}' is ${prDeliveryState(repair)}, not integrated`)
  }
  if (original.issue === undefined) throw new Error(`yrd: original PR '${original.id}' has no issue reference`)
  if (repair.issue === undefined) throw new Error(`yrd: repair PR '${repair.id}' has no issue reference`)
  if (original.integratedAt === undefined || repair.integratedAt === undefined) {
    throw new Error("yrd: integrated regression tuple is missing its journal timestamp")
  }
  const run = resolveSelector(
    args.run,
    original.terminalRun === undefined ? [] : [{ canonical: original.terminalRun, value: original.terminalRun }],
    { kind: "queue run" },
  )
  if (run === undefined) {
    raiseFailure(
      "refusal",
      "regression-run-mismatch",
      `yrd: queue run '${args.run}' does not prove integrated revision ${prRevisionNumber(original)} of PR '${original.id}'`,
    )
  }
  const repairRun = resolveSelector(
    args.repairRun,
    repair.terminalRun === undefined ? [] : [{ canonical: repair.terminalRun, value: repair.terminalRun }],
    { kind: "queue run" },
  )
  if (repairRun === undefined) {
    raiseFailure(
      "refusal",
      "regression-repair-run-mismatch",
      `yrd: queue run '${args.repairRun}' does not prove integrated revision ${prRevisionNumber(repair)} of repair PR '${repair.id}'`,
    )
  }

  const detectedAt = new Date(args.detectedAt).toISOString()
  if (
    Date.parse(original.integratedAt) > Date.parse(detectedAt) ||
    Date.parse(detectedAt) > Date.parse(repair.integratedAt)
  ) {
    raiseFailure(
      "refusal",
      "regression-chronology-invalid",
      `yrd: regression chronology must satisfy original integration <= detection <= repair integration ` +
        `(${original.integratedAt} <= ${detectedAt} <= ${repair.integratedAt})`,
    )
  }

  const fact = PRRegressionSchema.parse({
    pr: original.id,
    issueRef: original.issue,
    revision: prRevisionNumber(original),
    headSha: prHead(original),
    run,
    landingSha: original.integration.commit,
    detectedAt,
    severity: args.severity,
    evidence: args.evidence,
    implementationRunRef: args.implementationRunRef,
    reviewRef: args.reviewRef,
    repairIssueRef: repair.issue,
    repairPr: repair.id,
    repairRun,
    repairLandingSha: repair.integration.commit,
  })
  if (original.regressions?.some((existing) => regressionKey(existing) === regressionKey(fact)) === true) {
    return { events: [], value: fact }
  }
  return { events: [event("pr/regression-recorded", fact)], value: fact }
}

function regressionKey(fact: PRRegressionFact | PRRegression): string {
  return JSON.stringify([
    fact.pr,
    fact.issueRef,
    fact.revision,
    fact.headSha,
    fact.run,
    fact.landingSha,
    fact.detectedAt,
    fact.severity,
    fact.evidence,
    fact.implementationRunRef,
    fact.reviewRef,
    fact.repairIssueRef,
    fact.repairPr,
    fact.repairRun,
    fact.repairLandingSha,
  ])
}

function reviewFact(
  pr: DeepReadonly<PR>,
  fact: z.infer<typeof PRReviewFactSchema> | z.infer<typeof PRCommentFactSchema>,
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
      prHead(pr) === headSha &&
      baseIdentity(pr.base) === identity &&
      sameComposition(prComposition(pr), composition),
  )
  if (duplicate !== undefined) {
    throw new Error(`yrd: payload already recorded as PR '${duplicate.id}' on queue '${identity}'`)
  }
}

function closeBay(state: DeepReadonly<BayState>, args: CloseBayArgs, deprovision: BayJobDefs["bay.deprovision"]) {
  const current = state.bays
  const bay = required(resolveBay(current, args.bay), "bay", args.bay)
  if (bay.status === "opening" || bay.status === "closing") {
    throw new Error(`yrd: bay '${bay.id}' is ${bay.status}; wait for its workspace job`)
  }
  if (bay.status === "closed") throw new Error(`yrd: bay '${bay.id}' is already closed`)
  const pr = prForBay(current, bay.id) ?? resolvePR(current, bay.branch)
  if (pr !== undefined && prDeliveryState(pr) !== "pushed" && isLivePR(pr) && args.withdraw !== true) {
    throw new Error(
      `yrd: PR '${pr.id}' is ${prDeliveryState(pr)}; run it through the merge queue before closing, or pass --withdraw`,
    )
  }
  return {
    events: [
      ...(args.withdraw === true && pr !== undefined && isLivePR(pr)
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

function closePr(state: DeepReadonly<BayState>, args: PrCloseArgs) {
  const pr: LivePR = requireLivePR(state.bays, args.pr)
  if (!isLivePR(pr)) {
    throw new Error(`yrd: PR '${pr.id}' is ${prDeliveryState(pr)}; only a live PR can be closed`)
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

function editPr(state: DeepReadonly<BayState>, args: PrEditArgs) {
  const pr: LivePR = requireLivePR(state.bays, args.pr)
  const issueChanged = args.issue !== undefined && args.issue !== pr.issue
  if (args.issue !== undefined && pr.issue !== undefined && issueChanged) {
    raiseFailure(
      "refusal",
      "issue-conflict",
      `yrd: PR '${pr.id}' is already linked to issue '${pr.issue}'; close it before linking another issue`,
    )
  }
  const delivery = prDeliveryState(pr)
  if (issueChanged && delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready") {
    raiseFailure(
      "refusal",
      "issue-too-late",
      `yrd: PR '${pr.id}' is ${delivery}; issue can only be linked while pushed or submitted`,
    )
  }
  // Title, description and tracking are mutable delivery metadata (unlike the
  // immutable issue join): a later edit overwrites the prior value with no conflict.
  const titleChanged = args.title !== undefined && args.title !== pr.title
  const descriptionChanged = args.description !== undefined && args.description !== pr.description
  const trackChanged = args.track !== undefined && args.track !== (pr.track ?? false)
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
  const patchPR = (pr: PR, patch: Partial<PR>): BayState =>
    bayState({ ...current, prs: { ...current.prs, [pr.id]: { ...pr, ...patch } } })
  const patchRevisionClock = (pr: PR, patch: Partial<PRRevClock>): readonly PRRev[] => {
    const currentRevision = currentPRRev(pr)
    let found = false
    const revisions = pr.revs.map((revision) => {
      if (revision.n !== currentRevision.n || revision.head !== currentRevision.head) return revision
      found = true
      return { ...revision, ...patch }
    })
    if (!found) {
      throw new Error(
        `yrd: PR '${pr.id}' has no clock for current revision ${currentRevision.n}@${currentRevision.head}`,
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
      const parsed = PRPushedSchema.safeParse(data)
      const previous = PRPushedV1Schema.safeParse(data)
      const pushed = parsed.success ? parsed.data : previous.success ? previous.data : LegacyPRPushedSchema.parse(data)
      const base = baseIdentity(pushed.base)
      const existing = current.prs[pushed.pr]
      const record: PRRev = {
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
        ...(pushed.correlation === undefined ? {} : { correlation: pushed.correlation }),
      }
      const pr: PR =
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
              regressions: [],
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
      const parsed = PRRecutFactSchema.safeParse(data)
      const recut = parsed.success ? parsed.data : PRRecutReplaySchema.parse(data)
      const pr = current.prs[recut.pr]
      if (pr === undefined) throw new Error(`yrd: no merge request '${recut.pr}' to rebuild`)
      const predecessor = pr.revs.find(
        (revision) => revision.n === recut.predecessor.revision && revision.head === recut.predecessor.headSha,
      )
      if (
        predecessor === undefined ||
        recut.fromRevision !== recut.predecessor.revision ||
        predecessor.baseSha !== recut.predecessor.baseSha ||
        recut.successor.revision !== prRevisionNumber(pr) + 1
      ) {
        throw new Error(`yrd: rebuild history does not match merge request '${pr.id}'`)
      }
      const proof: PRRecutProof = {
        fromRevision: recut.fromRevision,
        patchId: recut.patchId,
        treeSha: recut.treeSha,
        reviewCarried: recut.reviewCarried,
        ...(recut.certificate === undefined ? {} : { certificate: recut.certificate }),
        ...(recut.sources === undefined ? {} : { sources: recut.sources }),
        ...(recut.transition === undefined ? {} : { transition: recut.transition }),
      }
      const correlation = predecessor.correlation
      const submitter = recut.submitter ?? predecessor.submitter
      const revision: PRRev = {
        n: recut.successor.revision,
        ...(parsed.success ? { changeId: parsed.data.changeId } : {}),
        head: recut.successor.headSha,
        base: pr.base,
        baseSha: recut.successor.baseSha,
        ...(submitter === undefined ? {} : { submitter }),
        ...(correlation === undefined ? {} : { correlation: { ...correlation } }),
        ...(recut.composition === undefined ? {} : { composition: recut.composition }),
        recut: proof,
        pushedAt: applied.ts,
      }
      const effectiveReview = pr.reviews.findLast(
        (review) => review.revision === predecessor.n && review.headSha === predecessor.head,
      )
      const approval = effectiveReview?.decision === "approve" ? effectiveReview : undefined
      if (recut.reviewCarried && approval === undefined) {
        throw new Error(`yrd: PR '${pr.id}' rebuild carries a missing approval`)
      }
      const carriedReview: PRReview | undefined =
        recut.reviewCarried && approval !== undefined
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
      const parsed = PRRevisionSchema.safeParse(data)
      const changed = parsed.success ? parsed.data : LegacyPRRevisionSchema.parse(data)
      const changedFlow = parsed.success ? parsed.data.flow : undefined
      const pr = current.prs[changed.pr]
      if (pr === undefined) return state
      if (prRevisionNumber(pr) !== changed.revision || prHead(pr) !== changed.headSha) {
        throw new Error(`yrd: stale PR event for '${pr.id}'`)
      }
      const currentCorrelation = prCorrelation(pr)
      if (
        changed.correlation !== undefined &&
        currentCorrelation !== undefined &&
        !correlationsEqual(currentCorrelation, changed.correlation)
      ) {
        throw new Error(`yrd: submitted correlation does not match PR '${pr.id}'`)
      }
      const correlation = changed.correlation ?? currentCorrelation
      if (
        pr.flow !== undefined &&
        changedFlow !== undefined &&
        (pr.flow.name !== changedFlow.name ||
          pr.flow.rev !== changedFlow.rev ||
          pr.flow.fingerprint !== changedFlow.fingerprint)
      ) {
        throw new Error(`yrd: submitted flow does not match PR '${pr.id}'`)
      }
      const revisions = patchRevisionClock(pr, { submittedAt: applied.ts, terminal: undefined }).map((revision) => {
        if (revision.n !== prRevisionNumber(pr) || revision.head !== prHead(pr)) return revision
        return {
          ...revision,
          ...(parsed.success ? { submitter: parsed.data.submitter } : {}),
          ...(correlation === undefined ? {} : { correlation: { ...correlation } }),
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
    case "pr/correlation-bound": {
      const changed = PRCorrelationBoundSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) return state
      if (prRevisionNumber(pr) !== changed.revision || prHead(pr) !== changed.headSha) {
        throw new Error(`yrd: stale correlation bind for PR '${pr.id}'`)
      }
      const delivery = prDeliveryState(pr)
      if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready" && delivery !== "needs-author") {
        throw new Error(`yrd: PR '${pr.id}' is ${delivery}; correlation cannot be bound`)
      }
      const currentCorrelation = prCorrelation(pr)
      if (currentCorrelation !== undefined && !correlationsEqual(currentCorrelation, changed.correlation)) {
        throw new Error(`yrd: correlation bind conflicts with PR '${pr.id}'`)
      }
      return patchPR(pr, correlationPatch(pr, changed.correlation))
    }
    case "pr/withdrawn": {
      const parsed = PRWithdrawnSchema.safeParse(data)
      const changed = parsed.success ? parsed.data : LegacyPRWithdrawnSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) throw new Error(`yrd: terminal '${applied.name}' names missing PR '${changed.pr}'`)
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
      const changed = PRNeedsAuthorFactSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) throw new Error(`yrd: '${applied.name}' names missing PR '${changed.pr}'`)
      assertTerminalApplies(pr, changed, applied.name)
      const delivery = prDeliveryState(pr)
      if (delivery !== "submitted" && delivery !== "ready") {
        throw new Error(`yrd: PR '${pr.id}' is ${delivery}; '${applied.name}' requires a submitted revision`)
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
      const changed = PRReplayRejectedSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) throw new Error(`yrd: terminal '${applied.name}' names missing PR '${changed.pr}'`)
      assertTerminalApplies(pr, changed, applied.name)
      const rejected: PR = {
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
    case "pr/terminal-associated": {
      const associated = PRTerminalAssociationSchema.parse(data)
      const pr = current.prs[associated.pr]
      if (pr === undefined) throw new Error(`yrd: no PR '${associated.pr}' for terminal association`)
      return patchPR(pr, associateRejectedTerminalRun(pr, associated, associated.run))
    }
    case "pr/integrated": {
      const parsed = PRIntegratedSchema.safeParse(data)
      const changed = parsed.success ? parsed.data : LegacyPRIntegratedSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) throw new Error(`yrd: terminal '${applied.name}' names missing PR '${changed.pr}'`)
      assertTerminalApplies(pr, changed, applied.name)
      const run = parsed.success ? parsed.data.run : undefined
      return patchPR(pr, {
        state: "closed",
        merged: true,
        integratedAt: applied.ts,
        alreadyLandedAt: undefined,
        alreadyLanded: undefined,
        terminalRun: run,
        integration: { commit: changed.commit, baseSha: changed.baseSha },
        revs: patchRevisionClock(pr, {
          terminal: { kind: "integrated", at: applied.ts, ...(run === undefined ? {} : { run }) },
        }),
      })
    }
    case "pr/already-landed": {
      const changed = PRAlreadyLandedSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) throw new Error(`yrd: terminal '${applied.name}' names missing PR '${changed.pr}'`)
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
      const parsed = PRCanceledSchema.safeParse(data)
      const changed = parsed.success ? parsed.data : LegacyPRCanceledSchema.parse(data)
      const pr = current.prs[changed.pr]
      const run = parsed.success ? parsed.data.run : undefined
      if (pr === undefined) throw new Error(`yrd: terminal '${applied.name}' names missing PR '${changed.pr}'`)
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
    case "pr/regression-recorded": {
      const fact = PRRegressionSchema.parse(data)
      const pr = current.prs[fact.pr]
      const repair = current.prs[fact.repairPr]
      if (
        pr === undefined ||
        repair === undefined ||
        !pr.merged ||
        !repair.merged ||
        pr.issue !== fact.issueRef ||
        prRevisionNumber(pr) !== fact.revision ||
        prHead(pr) !== fact.headSha ||
        pr.terminalRun !== fact.run ||
        pr.integration?.commit !== fact.landingSha ||
        repair.issue !== fact.repairIssueRef ||
        repair.terminalRun !== fact.repairRun ||
        repair.integration?.commit !== fact.repairLandingSha
      ) {
        throw new Error(
          `yrd: regression tuple does not match current integrated PR '${fact.pr}' and repair '${fact.repairPr}'`,
        )
      }
      if (pr.integratedAt === undefined || repair.integratedAt === undefined) {
        throw new Error("yrd: regression tuple is missing an integration timestamp")
      }
      if (
        Date.parse(pr.integratedAt) > Date.parse(fact.detectedAt) ||
        Date.parse(fact.detectedAt) > Date.parse(repair.integratedAt) ||
        Date.parse(repair.integratedAt) > Date.parse(applied.ts)
      ) {
        throw new Error(
          `yrd: regression chronology must satisfy original integration <= detection <= repair integration <= recorded time`,
        )
      }
      if (pr.regressions?.some((existing) => regressionKey(existing) === regressionKey(fact)) === true) return state
      return patchPR(pr, { regressions: [...(pr.regressions ?? []), { ...fact, recordedAt: applied.ts }] })
    }
    case "pr/edited": {
      const changed = PrEditArgsSchema.parse(data)
      const pr = current.prs[changed.pr]
      const attachIssue =
        changed.issue !== undefined &&
        pr !== undefined &&
        pr.issue === undefined &&
        (prDeliveryState(pr) === "pushed" || prDeliveryState(pr) === "submitted" || prDeliveryState(pr) === "ready")
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
      const reviewed = PRReviewFactSchema.parse(data)
      const { pr: prId, ...fact } = reviewed
      const pr = current.prs[prId]
      if (pr === undefined) return state
      const review: PRReview = { ...fact, at: applied.ts }
      return patchPR(pr, { reviews: [...pr.reviews, review] })
    }
    case "pr/commented": {
      const commented = PRCommentFactSchema.parse(data)
      const pr = current.prs[commented.pr]
      if (pr === undefined) return state
      const comment: PRComment = { ...commented, at: applied.ts }
      return patchPR(pr, { comments: [...pr.comments, comment] })
    }
    case "pr/session-started": {
      RetiredPRSessionStartedFactSchema.parse(data)
      return state
    }
    case "pr/session-ended": {
      RetiredPRSessionEndedFactSchema.parse(data)
      return state
    }
    case "pr/review-requested": {
      const requested = PRReviewRequestFactSchema.parse(data)
      const pr = current.prs[requested.pr]
      if (pr === undefined) return state
      return patchPR(pr, { requestedReviewers: requested.reviewers })
    }
    case "pr/checks-requested": {
      const requested = PRCheckRequestFactSchema.parse(data)
      const pr = current.prs[requested.pr]
      if (pr === undefined) return state
      if (prRevisionNumber(pr) !== requested.revision || prHead(pr) !== requested.headSha) return state
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
      const recorded = PRAdmissionRecordedFactSchema.parse(data)
      const pr = current.prs[recorded.pr]
      if (pr === undefined) return state
      if (prRevisionNumber(pr) !== recorded.revision || prHead(pr) !== recorded.headSha) return state
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

function required<Value>(value: Value | undefined, kind: "bay" | "PR", selector: string): Value {
  if (value === undefined) throw new Error(`yrd: no ${kind} '${selector}'`)
  return value
}

function sameComposition(left: CompositionV1 | undefined, right: CompositionV1 | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function nextId(prefix: string, records: Readonly<Record<string, unknown>>): string {
  const numbers = Object.keys(records)
    .filter((id) => id.startsWith(prefix) && /^\d+$/u.test(id.slice(prefix.length)))
    .map((id) => Number(id.slice(prefix.length)))
  return `${prefix}${Math.max(0, ...numbers) + 1}`
}

function isBayJob(name: string): name is keyof BayJobDefs {
  return name === "bay.provision" || name === "bay.refresh" || name === "bay.checkpoint" || name === "bay.deprovision"
}
