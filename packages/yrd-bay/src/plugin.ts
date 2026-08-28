import {
  command,
  event,
  journalEvent,
  observeYrdLifecycle,
  raiseFailure,
  type CommandHandler,
  type CommandResult,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type YrdDef,
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
import { ChangeIdSchema } from "./change-identity.ts"
import { RECEIVER_REMOTE_NAME } from "./git.ts"
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
  currentChangeRev,
  emptyBaysState,
  isLiveChange,
  normalizeV2By,
  normalizeLegacyChangeKeys,
  normalizeV1CorrelationToProps,
  changeProps,
  changeDeliveryState,
  changeHead,
  changeRevisionNumber,
  projectBranchLifecycles,
  resolveBay,
  type Bay,
  type BranchLifecycle,
  type BaysState,
  type CheckpointBayInput,
  type CheckpointedBay,
  type ChangeProps,
  type DeprovisionBayInput,
  type DeprovisionedBay,
  type Change,
  type ChangeComment,
  type ChangeRemergeProof,
  type ChangeReview,
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
  type DerivedSubmission,
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
  /** Pre-submit staging pass. On a recordless branch it is a pure preview:
   * the derived acceptance returns and nothing writes. On record paths it
   * stops exactly where a draft stops — the pass may record a moved tip as a
   * revision (intake, draft semantics) but never runs the real submit, so
   * gates that run between staging and submit see an unsubmitted change. */
  stage?: boolean
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

/** Journal decoder for `pr/edited` rows. The `pr edit` command retired with
 * the record store (S7 branch-is-change, @i/10 22991); only replay reads this. */
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
}>

export function createBayJobDefs(workspace: BayWorkspace): BayJobDefs {
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
  open(args: OpenBayArgs): Promise<CommandResult>
  refresh(args: RefreshBayArgs): Promise<CommandResult>
  checkpoint(args: CheckpointBayArgs): Promise<CommandResult>
  orphan(args: OrphanBayArgs): Promise<CommandResult>
  certifyHandoff(args: CertifyHandoffArgs): Promise<CommandResult>
  /** Retired (S7): refuses `record-mint-retired` with the push-path cure — the
   * receiver's accepted push IS the intake. Kept on the surface so callers get
   * the cure instead of a missing method. */
  intake(args: IntakeChangeArgs): Promise<CommandResult>
  /** Retired (S7): refuses `record-mint-retired` naming `yrd pr submit <branch>`. */
  submit(args: SubmitArgs): Promise<CommandResult>
  submitSelection(selector: string, options: SubmitSelectionOptions): Promise<DerivedSubmission>
  /** Live queue SHA `pr create` will consume for this bay — not the historical pin. */
  effectiveBase(selector: string, requestedBase?: string): Promise<BayBaseTarget>
  close(args: CloseBayArgs): Promise<CommandResult>
  /** The receiver ACCEPTED a `refs/yrd/submit/<branch>` write — project the approval fact. */
  recordBranchSubmit(args: BranchSubmit): Promise<CommandResult>
  /** The receiver removed a submit ref (delete, archival sweep). */
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

/** Whether this exact branch name was already earned by this same identity, so
 * reopening onto it is a resumption rather than a collision.
 *
 * S7: the record half of this question is gone with the store — a live change
 * record for the branch and issue used to count as provenance. A closed Bay
 * carrying the same name and issue is now the whole answer, which is the
 * durable half: it is Bay state, not delivery state, and reopening a Bay is a
 * Bay question. A branch whose only provenance was a live record would have
 * had a standing submit fact too, and the caller checks branch ownership
 * separately. */
function hasBranchReuseProvenance(
  state: DeepReadonly<BaysState>,
  identity: Pick<OpenBayArgs, "name" | "issue">,
  branch: string,
): boolean {
  return Object.values(state.byId).some(
    (bay) =>
      bay.status === "closed" && bay.branch === branch && bay.name === identity.name && bay.issue === identity.issue,
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
  const submitSelectionOperation = async (
    selector: string,
    options: SubmitSelectionOptions,
  ): Promise<DerivedSubmission> => {
    const snapshot = state()
    const selectedBay = resolveBay(snapshot, selector)
    // A closed Bay is archive evidence, not permanent ownership of its branch
    // alias. Addressing that branch again must use the direct-branch delivery
    // path; canonical Bay id/name selectors still resolve the closed Bay and
    // receive the ordinary not-active refusal.
    const closedBranchAlias =
      selectedBay?.status === "closed" && selectedBay.branch.toLowerCase() === selector.toLowerCase()
    const bay = closedBranchAlias ? undefined : selectedBay
    if (bay !== undefined && bay.status !== "active") {
      raiseFailure("refusal", "bay-not-active", `yrd: bay '${bay.id}' is ${bay.status}, not active`)
    }

    let branch: string
    let headSha: string
    let baseSelector = options.base
    if (bay !== undefined) {
      // S7 (branch-is-change): a bay submission is a branch push like every
      // other submission. Refresh answers "which commit is checked out in the
      // managed workspace", checkpoint commits any WIP and pushes the branch,
      // and the branch/submitted fact below is the submission itself — the
      // record intake this arm used to run retired with the store.
      const refreshed = await actions.refresh({ bay: bay.id })
      await execute(refreshed, options.run, `bay '${bay.id}' refresh`)
      let live = resolveBay(state(), bay.id)
      if (live === undefined) {
        raiseFailure("infrastructure", "bay-state-invalid", `yrd: bay '${selector}' disappeared after refresh`)
      }
      if (live.headSha === undefined) {
        raiseFailure("refusal", "bay-head-missing", `yrd: bay '${live.id}' has no committed head to submit`)
      }
      if (options.stage !== true) {
        // D3 (revised at S7): a dirty worktree no longer means "committed head
        // only" — checkpoint folds the uncommitted work into a `wip: submit`
        // commit and pushes it, so the submission carries exactly what the
        // workspace held. Silent inclusion would be a silent error, so the
        // fold rides the result envelope's warnings sink AND the log.
        const dirtyBefore = live.dirty === true
        const checkpointed = await actions.checkpoint({ bay: live.id, claim: "submit" })
        await execute(checkpointed, options.run, `bay '${live.id}' checkpoint`)
        live = resolveBay(state(), bay.id)
        if (live?.headSha === undefined) {
          raiseFailure("infrastructure", "bay-state-invalid", `yrd: bay '${selector}' disappeared after checkpoint`)
        }
        if (dirtyBefore) {
          const warning =
            `Bay '${live.id}' had uncommitted work; checkpoint committed it ('wip: submit') and it IS part of ` +
            "this submission."
          options.warnings?.push(warning)
          log?.warn?.(warning, { action: "submit-dirty-worktree-checkpointed", bay: live.id })
        }
      }
      branch = live.branch
      headSha = live.headSha
      baseSelector = options.base ?? live.base
    } else {
      branch = selector
      const resolvedHead = await options.resolveRevision(selector)
      if (resolvedHead === undefined) {
        raiseFailure("refusal", "git-commit-missing", `yrd: no Git commit '${selector}'`)
      }
      headSha = resolvedHead
    }
    const resolved = await target(baseSelector, undefined)

    // THE RECORD LANE IS RETIRED (S7, @i/10 22991): every submission routes to
    // the DERIVED lane — the branch/submitted fact is the submission, compose
    // admits it under the synthetic identity, and no record ever mints. The
    // staging pass previews without recording the fact; draft records were a
    // record-lane feature and refuse with the cure.
    if (options.stage === true) {
      return { lane: "derived", branch, sha: headSha, base: resolved.base }
    }
    if (options.draft === true) {
      raiseFailure(
        "refusal",
        "record-mint-retired",
        `yrd: draft records are retired — push '${branch}' and submit it plainly ('yrd pr submit ${branch}'), which runs it as a derived member`,
      )
    }
    // Record-only options have no record to bind on the derived lane. The
    // common ones are commit-derived by the CLI anyway (title/description
    // from the head commit), so dropping them loses nothing — but dropping
    // them SILENTLY would be a silent error, so the drop rides the result
    // envelope's warnings sink and the log, D3-style, and names the cure.
    const recordOnly = [
      options.title !== undefined ? "title" : undefined,
      options.description !== undefined ? "description" : undefined,
      options.issue !== undefined ? "issue" : undefined,
      options.track !== undefined ? "track" : undefined,
      options.props !== undefined && Object.keys(options.props).length > 0 ? "props" : undefined,
    ].filter((field): field is string => field !== undefined)
    if (recordOnly.length > 0) {
      const dropped = recordOnly.join("/")
      options.warnings?.push(
        `${dropped} ${recordOnly.length > 1 ? "bind" : "binds"} to change records; the derived lane reads identity from the branch and metadata from the commit, so they were not recorded — amend the commit on '${branch}' to carry them`,
      )
      log?.warn?.("record-only submit options dropped on the derived lane", {
        action: "submit-derived-metadata-dropped",
        branch,
        dropped: recordOnly,
      })
    }
    await actions.recordBranchSubmit({ branch, sha: headSha, base: resolved.base })
    log?.info?.("submit routed to the derived lane; the fact is the submission, no record minted", {
      action: "submit-derived-routed",
      branch,
      sha: headSha,
      base: resolved.base,
    })
    return { lane: "derived", branch, sha: headSha, base: resolved.base }
  }

  const submitSelection = (selector: string, options: SubmitSelectionOptions): Promise<DerivedSubmission> =>
    observe(
      {
        lifecycle: "submit",
        attributes: { selector },
        resultAttributes: (result) => ({ branch: result.branch }),
      },
      () => submitSelectionOperation(selector, options),
    )

  return Object.freeze({
    state,
    get: (selector) => resolveBay(state(), selector),
    list: () => Object.freeze(Object.values(state().byId)),
    branchLifecycles: () => Object.freeze(projectBranchLifecycles(state())),
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
    intake: actions.intake,
    submit: actions.submit,
    close: actions.close,
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
  defaultBase?: string
  resolveBase?: ResolveBayBase
}>

export function withBays(options: WithBaysOptions) {
  const defaultBase = baseIdentity(options.defaultBase ?? "main")
  const commands = createBayCommands(options.jobs, defaultBase)

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
      projectionVersion: "bays-v16-retired-record-store",
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

function jobDetail(job: DeepReadonly<Job>): string {
  if (job.status === "completed" && job.conclusion === "failure") return job.error.message
  if (job.status === "completed" && job.conclusion === "timed_out") return job.lostReason
  if (job.status === "completed" && job.conclusion === "cancelled") return job.cancelReason
  if (job.status === "waiting") return job.detail ?? job.status
  return job.status
}

function createBayCommands(jobs: BayJobDefs, defaultBase: string): BayCommands {
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
      // S7 (branch-is-change, @i/10 22991): the record store's two remaining
      // mint sites — intakePR and submitWork — are retired. Both commands
      // survive as refusals so every caller receives the cure instead of a
      // missing method; the receiver's accepted push is the intake, and the
      // branch/submitted fact (recordBranchSubmit) is the submission.
      intake: command({
        title: "Record pushed revision (retired)",
        params: IntakeChangeArgsSchema,
        apply: (_state: BayState, args: IntakeChangeArgs): never =>
          raiseFailure(
            "refusal",
            "record-mint-retired",
            `yrd: record intake is retired (S7 branch-is-change): the receiver's accepted push IS the intake — ` +
              `push the branch and submit it in one act ` +
              `('git push ${RECEIVER_REMOTE_NAME} HEAD:refs/for/${args.base ?? defaultBase}/<issue>'), or approve ` +
              `an existing branch's tip ('git push ${RECEIVER_REMOTE_NAME} HEAD:refs/yrd/submit/<branch>')`,
          ),
      }),
      submit: command({
        title: "Submit work (retired record lane)",
        visibility: "public",
        params: SubmitArgsSchema,
        apply: (_state: BayState, args: SubmitArgs): never =>
          raiseFailure(
            "refusal",
            "record-mint-retired",
            `yrd: record submission is retired (S7 branch-is-change): run ` +
              `'yrd pr submit ${"pr" in args ? args.pr : args.branch}' — the branch push is the change and the ` +
              `submit fact is the submission; no record mints`,
          ),
      }),
      close: command({
        title: "Close bay",
        visibility: "public",
        params: CloseBayArgsSchema,
        apply: (state: BayState, args: CloseBayArgs) => closeBay(state, args, jobs["bay.deprovision"]),
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

function propsEqual(left: DeepReadonly<ChangeProps>, right: DeepReadonly<ChangeProps>): boolean {
  const entries = Object.entries(left)
  return entries.length === Object.keys(right).length && entries.every(([key, value]) => right[key] === value)
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

function closeBay(state: DeepReadonly<BayState>, args: CloseBayArgs, deprovision: BayJobDefs["bay.deprovision"]) {
  const current = state.bays
  const bay = required(resolveBay(current, args.bay), "bay", args.bay)
  if (bay.status === "opening" || bay.status === "closing") {
    throw new Error(`yrd: bay '${bay.id}' is ${bay.status}; wait for its workspace job`)
  }
  if (bay.status === "closed") throw new Error(`yrd: bay '${bay.id}' is already closed`)
  // S7: the "run it through the queue before closing" guard re-keys on the
  // branch's standing submit fact — the record join it used to read retired
  // with the store. Closing the workspace does not retract the submission
  // (the receiver's branch and submit ref outlive the bay), so `--withdraw`
  // now means "close the workspace while the submission stands"; retracting
  // the submission itself is a receiver ref delete, named in the cure. No
  // pr/withdrawn fact is emitted — no live command writes pr/* events.
  const submit = current.submits[bay.branch]
  if (submit !== undefined && args.withdraw !== true) {
    throw new Error(
      `yrd: branch '${bay.branch}' has a live submission (${submit.sha.slice(0, 12)} for '${submit.base}'); ` +
        `run it through the merge queue before closing, retract it ` +
        `('git push ${RECEIVER_REMOTE_NAME} :refs/yrd/submit/${bay.branch}'), or pass --withdraw to close the ` +
        `workspace while the submission stands`,
    )
  }
  return {
    events: [
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

function bayState(bays: BaysState): BayState {
  return { bays }
}

/**
 * S7 replay contract (branch-is-change, @i/10 22991): every `pr/*` event stays
 * PARSEABLE forever, and — until the checkpoint migration deletes
 * `BaysState.prs` in the integration step — the reducers below stay LIVE, so
 * an old journal still materializes its record history exactly as written.
 * What S7 removed is every COMMAND that could emit a NEW `pr/*` record event:
 * the only live writers left in this plugin are the `bay/*`, `branch/*` and
 * job events. Two projection changes ride this boundary: the `receipts`
 * satellite is no longer written (its only reader, intake idempotence, retired
 * with intakePR), and the four terminal reducers that threw on a missing
 * record (withdrawn/rejected/canceled/recut) relax to no-ops — queue-side
 * terminals for DERIVED members name no record by design.
 */
function projectBays(state: DeepReadonly<BayState>, applied: Event): BayState {
  const current = state.bays
  const saveBay = (bay: Bay): BayState => bayState({ ...current, byId: { ...current.byId, [bay.id]: bay } })
  const patchBay = (bay: Bay, patch: Partial<Bay>): BayState => saveBay({ ...bay, ...patch })
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
    // S7 (branch-is-change, @i/10 22991): the change-record store is deleted, so
    // no `pr/*` frame projects state any more. They must still be ACCEPTED —
    // an old journal has to stay readable — and a malformed one must still fail
    // loud, but neither obligation belongs here: the `events` and `replayEvents`
    // registries above are this plugin's acceptance authority, and they refuse a
    // corrupt frame before replay ever reaches a reducer (proven per family, one
    // deliberately malformed frame each, with this switch stubbed out). A second
    // parse here would restate a rule it cannot enforce.
    case "pr/pushed":
    case "pr/recut":
    case "pr/submitted":
    case "pr/props-set":
    case "pr/correlation-bound":
    case "pr/withdrawn":
    case "pr/needs-author":
    case "pr/rejected":
    case "pr/integrated":
    case "pr/already-landed":
    case "pr/canceled":
    case "pr/edited":
    case "pr/reviewed":
    case "pr/commented":
    case "pr/session-started":
    case "pr/session-ended":
    case "pr/review-requested":
    case "pr/checks-requested":
    case "pr/admission-recorded":
      return state as BayState
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
