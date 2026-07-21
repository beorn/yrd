import {
  command,
  event,
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
import type { ConditionalLogger } from "loggily"
import * as z from "zod"
import {
  BayIdSchema,
  CompositionV1Schema,
  CorrelationSchema,
  DeprovisionBayInputSchema,
  DeprovisionedBaySchema,
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
  PRFreshnessTransitionSchema,
  PRRejectedFactSchema,
  PRTerminalAssociationSchema,
  ProvisionBayInputSchema,
  ProvisionedBaySchema,
  RefreshBayInputSchema,
  RefreshedBaySchema,
  baseIdentity,
  defaultBayBranch,
  checksRequested,
  emptyBaysState,
  isLivePR,
  needsReview,
  prForBay,
  requireLivePR,
  PrCheckabilityConflict,
  projectBranchLifecycles,
  reviewState,
  resolveBay,
  resolvePR,
  resolvePRMatch,
  type Bay,
  type BranchLifecycle,
  type BaysState,
  type CompositionV1,
  type Correlation,
  type DeprovisionBayInput,
  type DeprovisionedBay,
  type PR,
  type PRComment,
  type PRRegression,
  type PRRecutProof,
  type PRReview,
  type PRReviewState,
  type PRRevision,
  type PRRevisionClock,
  type ProvisionBayInput,
  type ProvisionedBay,
  type RefreshBayInput,
  type RefreshedBay,
} from "./model.ts"

const TextSchema = z.string().trim().min(1)
const RevisionSchema = z.number().int().positive()

const OpenBayArgsSchema = z
  .object({
    name: TextSchema,
    issue: TextSchema.optional(),
    actor: TextSchema.optional(),
    from: GitRefSchema.optional(),
    base: GitRefSchema.optional(),
    baseSha: GitShaSchema.optional(),
  })
  .strict()
export type OpenBayArgs = z.infer<typeof OpenBayArgsSchema>

const RefreshBayArgsSchema = z.object({ bay: TextSchema }).strict()
export type RefreshBayArgs = z.infer<typeof RefreshBayArgsSchema>

const CertifyHandoffArgsSchema = z
  .object({ bay: TextSchema, branch: GitRefSchema, headSha: GitShaSchema, evidence: TextSchema })
  .strict()
export type CertifyHandoffArgs = z.infer<typeof CertifyHandoffArgsSchema>

const BayHandoffCertifiedSchema = z
  .object({ bay: BayIdSchema, branch: GitRefSchema, headSha: GitShaSchema, evidence: TextSchema })
  .strict()

const IntakePRArgsSchema = z
  .object({
    bay: TextSchema.optional(),
    name: TextSchema.optional(),
    issue: TextSchema.optional(),
    branch: GitRefSchema.optional(),
    base: GitRefSchema.optional(),
    headSha: GitShaSchema,
    baseSha: GitShaSchema.optional(),
    actor: TextSchema.optional(),
    composition: CompositionV1Schema.optional(),
    receipt: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
  })
  .strict()
  .refine(({ bay, branch }) => bay !== undefined || branch !== undefined, {
    message: "'bay' or 'branch' is required",
  })
export type IntakePRArgs = z.infer<typeof IntakePRArgsSchema>

const SubmitArgsSchema = z.union([
  z.object({ pr: TextSchema, actor: TextSchema.optional(), correlation: CorrelationSchema.optional() }).strict(),
  z
    .object({
      branch: GitRefSchema,
      headSha: GitShaSchema,
      base: GitRefSchema.optional(),
      baseSha: GitShaSchema.optional(),
      name: TextSchema.optional(),
      issue: TextSchema.optional(),
      draft: z.boolean().optional(),
      actor: TextSchema.optional(),
      correlation: CorrelationSchema.optional(),
      composition: CompositionV1Schema.optional(),
      reviewers: z.array(TextSchema).optional(),
    })
    .strict(),
])
export type SubmitArgs = z.infer<typeof SubmitArgsSchema>

export type SubmitSelectionOptions = Readonly<{
  base?: string
  issue?: string
  title?: string
  description?: string
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
  })
  .strict()
  .refine(
    ({ issue, note, title, description }) =>
      issue !== undefined || note !== undefined || title !== undefined || description !== undefined,
    { message: "'issue', 'note', 'title', or 'description' is required" },
  )
export type PrEditArgs = z.infer<typeof PrEditArgsSchema>

const PrReadyArgsSchema = z.object({ pr: TextSchema }).strict()
export type PrReadyArgs = z.infer<typeof PrReadyArgsSchema>
const PrRecutExpectedCurrentSchema = z.object({ revision: RevisionSchema, headSha: GitShaSchema }).strict()
const PrRecutArgsSchema = z
  .object({
    pr: TextSchema,
    fromRevision: RevisionSchema,
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
    treeSha: GitShaSchema,
    patchId: GitShaSchema,
    reviewCarried: z.boolean(),
    composition: CompositionV1Schema.optional(),
    expectedCurrent: PrRecutExpectedCurrentSchema.optional(),
    transition: PRFreshnessTransitionSchema.optional(),
  })
  .strict()
export type PrRecutArgs = z.infer<typeof PrRecutArgsSchema>
const PrRequestChecksArgsSchema = z.object({ pr: TextSchema, baseSha: GitShaSchema.optional() }).strict()
export type PrRequestChecksArgs = z.infer<typeof PrRequestChecksArgsSchema>
const PrRequestReviewArgsSchema = z
  .object({ pr: TextSchema, reviewers: z.array(TextSchema), actor: TextSchema.optional() })
  .strict()
export type PrRequestReviewArgs = z.infer<typeof PrRequestReviewArgsSchema>

const PRReviewDecisionSchema = z.enum(["approve", "reject"])
const PrReviewArgsSchema = z
  .object({
    pr: TextSchema,
    actor: TextSchema,
    decision: PRReviewDecisionSchema,
    ref: TextSchema.optional(),
    note: TextSchema.optional(),
  })
  .strict()
export type PrReviewArgs = z.infer<typeof PrReviewArgsSchema>

const PrCommentArgsSchema = z
  .object({ pr: TextSchema, actor: TextSchema, note: TextSchema, ref: TextSchema.optional() })
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

const BayOpenedSchema = z
  .object({
    id: BayIdSchema,
    name: TextSchema,
    issue: TextSchema.optional(),
    actor: TextSchema.optional(),
    from: GitRefSchema.optional(),
    branch: GitRefSchema,
    base: GitRefSchema,
    baseSha: GitShaSchema.optional(),
  })
  .strict()
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
const PRRecutFactSchema = z
  .object({
    pr: PRIdSchema,
    fromRevision: RevisionSchema,
    patchId: GitShaSchema,
    baseSha: GitShaSchema,
    treeSha: GitShaSchema,
    reviewCarried: z.boolean(),
    predecessor: PRRecutLineageSchema,
    successor: PRRecutLineageSchema.extend({ baseSha: GitShaSchema }).strict(),
    composition: CompositionV1Schema.optional(),
    transition: PRFreshnessTransitionSchema.optional(),
  })
  .strict()
const PRPushedSchema = LegacyPRPushedSchema.extend({ actor: TextSchema }).strict()
const PRRevisionIdentitySchema = z.object({ pr: PRIdSchema, revision: RevisionSchema, headSha: GitShaSchema }).strict()
const LegacyPRRevisionSchema = PRRevisionIdentitySchema.extend({ correlation: CorrelationSchema.optional() }).strict()
const PRRevisionSchema = LegacyPRRevisionSchema.extend({ actor: TextSchema }).strict()
const PRCorrelationBoundSchema = PRRevisionIdentitySchema.extend({ correlation: CorrelationSchema }).strict()
const PRTerminalIdentitySchema = PRRevisionIdentitySchema.extend({
  issueRef: TextSchema.optional(),
  correlation: CorrelationSchema.optional(),
}).strict()
const PRQueueTerminalIdentitySchema = PRTerminalIdentitySchema.extend({ run: TextSchema }).strict()
export const PRWithdrawnSchema = PRTerminalIdentitySchema.extend({
  reason: TextSchema.optional(),
  /** Submitter of the withdrawn revision — carried so terminal ball closures can route back to the author. */
  actor: TextSchema.optional(),
}).strict()
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
const PRIntegratedSchema = PRQueueTerminalIdentitySchema.extend({
  commit: GitShaSchema,
  landingSha: GitShaSchema,
  baseSha: GitShaSchema,
  /** Missing only when a current integration terminates a pre-actor legacy revision. */
  actor: TextSchema.optional(),
})
  .strict()
  .refine(({ commit, landingSha }) => commit === landingSha, {
    message: "landingSha must equal the integration proof commit",
    path: ["landingSha"],
  })
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
export const PRCanceledSchema = PRQueueTerminalIdentitySchema.extend({
  by: TextSchema,
  reason: TextSchema,
  /** Submitter of the canceled revision — carried so terminal ball closures can route back to the author. */
  actor: TextSchema.optional(),
}).strict()
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
const PRReviewFactSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    actor: TextSchema,
    decision: PRReviewDecisionSchema,
    ref: TextSchema.optional(),
    note: TextSchema.optional(),
  })
  .strict()
const PRCommentFactSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    actor: TextSchema,
    note: TextSchema,
    ref: TextSchema.optional(),
  })
  .strict()
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
  deprovision(
    input: DeprovisionBayInput,
    context: JobContext,
  ): JobResult<DeprovisionedBay> | Promise<JobResult<DeprovisionedBay>>
}>

export type BayJobDefs = Readonly<{
  "bay.provision": JobDef<ProvisionBayInput, ProvisionedBay>
  "bay.refresh": JobDef<RefreshBayInput, RefreshedBay>
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
    certifyHandoff: CommandHandler<CertifyHandoffArgs, BayState>
    intake: CommandHandler<IntakePRArgs, BayState>
    submit: CommandHandler<SubmitArgs, BayState>
    close: CommandHandler<CloseBayArgs, BayState>
  }>
  pr: Readonly<{
    close: CommandHandler<PrCloseArgs, BayState>
    edit: CommandHandler<PrEditArgs, BayState>
    recut: CommandHandler<PrRecutArgs, BayState>
    ready: CommandHandler<PrReadyArgs, BayState>
    review: CommandHandler<PrReviewArgs, BayState>
    comment: CommandHandler<PrCommentArgs, BayState>
    requestChecks: CommandHandler<PrRequestChecksArgs, BayState>
    requestReview: CommandHandler<PrRequestReviewArgs, BayState>
    regression: CommandHandler<PrRegressionArgs, BayState>
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
  certifyHandoff(args: CertifyHandoffArgs): Promise<CommandResult>
  intake(args: IntakePRArgs): Promise<CommandResult>
  submit(args: SubmitArgs): Promise<CommandResult>
  submitSelection(selector: string, options: SubmitSelectionOptions): Promise<DeepReadonly<PR>>
  close(args: CloseBayArgs): Promise<CommandResult>
  closePr(args: PrCloseArgs): Promise<CommandResult>
  editPr(args: PrEditArgs): Promise<CommandResult>
  recut(args: PrRecutArgs): Promise<CommandResult>
  ready(args: PrReadyArgs): Promise<CommandResult>
  review(args: PrReviewArgs): Promise<CommandResult>
  comment(args: PrCommentArgs): Promise<CommandResult>
  requestChecks(args: PrRequestChecksArgs): Promise<CommandResult>
  requestReview(args: PrRequestReviewArgs): Promise<CommandResult>
  recordRegression(args: PrRegressionArgs): Promise<CommandResult>
}>

export type HasBays = Readonly<{ bays: Bays }>

type BayActions = Pick<
  Bays,
  | "open"
  | "refresh"
  | "certifyHandoff"
  | "intake"
  | "submit"
  | "close"
  | "closePr"
  | "editPr"
  | "recut"
  | "ready"
  | "review"
  | "comment"
  | "requestChecks"
  | "requestReview"
  | "recordRegression"
>

export type BayBaseTarget = Readonly<{ base: string; baseSha?: string }>
export type ResolveBayBase = (base: string) => BayBaseTarget | Promise<BayBaseTarget>

export function createBays(
  state: ReadSignal<DeepReadonly<BaysState>>,
  jobs: Jobs,
  actions: BayActions,
  options: Readonly<{ defaultBase: string; resolveBase?: ResolveBayBase }>,
  log?: ConditionalLogger,
): Bays {
  const observe = async <Result>(
    lifecycle: YrdLifecycleOptions<Result>,
    operation: () => Result | Promise<Result>,
  ): Promise<Result> => (log === undefined ? operation() : observeYrdLifecycle(log, lifecycle, operation))
  const execute = async (result: CommandResult, options: RunJobOptions, action: string): Promise<void> => {
    const results = await jobs.runMany(jobs.requested(result), options)
    const failed = results.find((job) => job.status !== "passed")
    if (failed !== undefined) {
      raiseFailure("infrastructure", "bay-job-failed", `yrd: ${action} ${failed.status}: ${jobDetail(failed)}`)
    }
  }

  const target = async (base: string | undefined, baseSha: string | undefined): Promise<BayBaseTarget> => {
    const requested = base ?? options.defaultBase
    const selected =
      options.resolveBase === undefined
        ? { base: requested, ...(baseSha === undefined ? {} : { baseSha }) }
        : await options.resolveBase(requested)
    const resolved = { ...selected, base: baseIdentity(selected.base) }
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
    const resolved = await target(args.base, args.baseSha)
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
        const resolved = await target(args.base ?? bay?.base, args.baseSha ?? bay?.baseSha)
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
        `yrd: PR '${pr.id}' is already linked to issue '${pr.issue}'; withdraw it before linking another issue`,
      )
    }
    if (pr.status !== "pushed" && pr.status !== "submitted") {
      raiseFailure(
        "refusal",
        "issue-too-late",
        `yrd: PR '${pr.id}' is ${pr.status}; issue can only be linked while pushed or submitted`,
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
    metadata: Pick<SubmitSelectionOptions, "title" | "description">,
  ): Promise<DeepReadonly<PR>> => {
    const titleChanged = metadata.title !== undefined && metadata.title !== pr.title
    const descriptionChanged = metadata.description !== undefined && metadata.description !== pr.description
    if (!titleChanged && !descriptionChanged) return pr
    await actions.editPr({
      pr: pr.id,
      ...(titleChanged ? { title: metadata.title } : {}),
      ...(descriptionChanged ? { description: metadata.description } : {}),
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
    let pr = resolved?.value
    let bay = resolveBay(snapshot, selector) ?? (pr?.bay === undefined ? undefined : resolveBay(snapshot, pr.bay))
    // D2 — a branch whose PR reached a non-landed terminal status
    // (withdrawn/canceled) mints its next revision automatically down the
    // direct-branch resubmit path below (the reopen preserves the PR identity,
    // so branch→PR stays 1:1). The author no longer hand-makes a delivery branch.
    //
    // Q1 — an integrated branch identity is FROZEN evidence, never reopened:
    //  - addressed by its branch, resubmitting the SAME landed head is an
    //    informational "already merged" no-op (returns the integrated PR, exit
    //    0 — delivered work is not a dark queue), while a NEW head mints a fresh
    //    delivery PR (revision 1) via the direct-branch path below, so no
    //    hand-made `<branch>-delivery-<nonce>` branch is needed;
    //  - addressed by its id, it stays idempotent.
    if (pr?.status === "integrated") {
      // Addressed by its canonical id, an integrated PR is frozen evidence:
      // idempotent. Addressed by a moving alias (its branch), a new head mints a
      // fresh delivery. The canonical-vs-alias fold lives in resolveSelectorMatch.
      if (resolved?.matchedBy === "canonical") return bindSubmission(pr, options)
      const landedHead = await options.resolveRevision(selector)
      if (landedHead === undefined) {
        raiseFailure("refusal", "git-commit-missing", `yrd: no Git commit '${selector}'`)
      }
      if (landedHead === pr.headSha) return bindSubmission(pr, options)
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
        const warning = `yrd: bay '${bay.id}' has uncommitted work; submitting the committed head only`
        options.warnings?.push(warning)
        log?.warn?.(warning, { action: "submit-dirty-worktree", bay: bay.id })
      }
      if (bay.headSha === undefined) {
        raiseFailure("refusal", "bay-head-missing", `yrd: bay '${bay.id}' has no committed head to submit`)
      }
      pr = prForBay(snapshot, bay.id)
      const composition = requestedComposition ?? pr?.composition
      if (pr === undefined || pr.headSha !== bay.headSha || !sameComposition(composition, pr.composition)) {
        await intake({
          bay: bay.id,
          headSha: bay.headSha,
          ...(bay.baseSha === undefined ? {} : { baseSha: bay.baseSha }),
          ...(options.issue === undefined ? {} : { issue: options.issue }),
          ...(composition === undefined ? {} : { composition }),
        })
        pr = prForBay(state(), bay.id)
      }
    }

    // Re-submitting a bay-less PR must re-resolve the branch's current tip rather than reuse
    // the recorded revision's head: a pushed (e.g. draft) or submitted PR whose branch has since
    // moved would otherwise re-register the stale head. Only an active bay reads its head from
    // the workspace (handled above), so this covers the direct-branch case.
    if ((pr?.status === "submitted" || pr?.status === "pushed") && bay === undefined) {
      const headSha = await options.resolveRevision(pr.branch)
      if (headSha === undefined && pr.status === "submitted") {
        // A submitted PR whose branch no longer resolves cannot be re-submitted from a tip.
        raiseFailure("refusal", "git-commit-missing", `yrd: no Git commit '${pr.branch}'`)
      }
      if (headSha !== undefined) {
        const resolved = await target(options.base ?? pr.base, undefined)
        const composition = requestedComposition ?? pr.composition
        if (
          headSha !== pr.headSha ||
          resolved.base !== pr.base ||
          resolved.baseSha !== pr.baseSha ||
          !sameComposition(composition, pr.composition)
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
    if (pr !== undefined && isLivePR(pr.status)) pr = await bindIssue(pr, options.issue)
    if (pr?.status === "submitted") return bindCorrelation(pr, options.correlation)
    if (pr?.status === "pushed") {
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
          (candidate.status === "pushed" || candidate.status === "submitted") &&
          candidate.headSha === headSha &&
          candidate.base === resolved.base &&
          sameComposition(candidate.composition, requestedComposition),
      )
      if (live !== undefined) {
        const correlated = await bindSubmission(live, options)
        if (correlated.status === "submitted") return correlated
        if (options.draft === true) return correlated
        await actions.submit({ pr: correlated.id })
        const submitted = resolvePR(state(), live.id)
        if (submitted === undefined) {
          raiseFailure("infrastructure", "pr-state-invalid", `yrd: PR '${live.id}' disappeared after submit`)
        }
        return submitted
      }
      await actions.submit({
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
    raiseFailure("refusal", "pr-not-pushed", `yrd: PR '${pr.id}' is ${pr.status}, not pushed`)
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
    certifyHandoff: actions.certifyHandoff,
    intake,
    submit,
    close: actions.close,
    closePr: actions.closePr,
    editPr: actions.editPr,
    recut: actions.recut,
    ready: actions.ready,
    review: actions.review,
    comment: actions.comment,
    requestChecks: actions.requestChecks,
    requestReview: actions.requestReview,
    recordRegression: actions.recordRegression,
  })
}

export type WithBaysOptions = Readonly<{
  jobs: BayJobDefs
  defaultBase?: string
  defaultActor?: string
  resolveBase?: ResolveBayBase
}>

export function withBays(options: WithBaysOptions) {
  const defaultBase = baseIdentity(options.defaultBase ?? "main")
  const defaultActor = TextSchema.parse(options.defaultActor ?? "operator")
  const commands = createBayCommands(options.jobs, defaultBase, defaultActor)

  return <State extends object, Commands extends CommandTree, Features extends HasJobs>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { bays: emptyBaysState() },
      commands,
      events: {
        "bay/opened": BayOpenedSchema,
        "bay/closing": BayClosingSchema,
        "bay/handoff-certified": BayHandoffCertifiedSchema,
        "pr/pushed": PRPushedSchema,
        "pr/recut": PRRecutFactSchema,
        "pr/submitted": PRRevisionSchema,
        "pr/correlation-bound": PRCorrelationBoundSchema,
        "pr/withdrawn": PRWithdrawnSchema,
        "pr/rejected": PRRejectedFactSchema,
        "pr/terminal-associated": PRTerminalAssociationSchema,
        "pr/integrated": PRIntegratedSchema,
        "pr/canceled": PRCanceledSchema,
        "pr/regression-recorded": PRRegressionSchema,
        "pr/edited": PrEditArgsSchema,
        "pr/reviewed": PRReviewFactSchema,
        "pr/commented": PRCommentFactSchema,
        "pr/checks-requested": PRCheckRequestFactSchema,
        "pr/review-requested": PRReviewRequestFactSchema,
      },
      replayEvents: {
        "pr/pushed": LegacyPRPushedSchema,
        "pr/submitted": LegacyPRRevisionSchema,
        "pr/withdrawn": z.union([PRWithdrawnSchema, LegacyPRWithdrawnSchema]),
        "pr/rejected": PRReplayRejectedSchema,
        "pr/integrated": z.union([PRIntegratedSchema, LegacyPRIntegratedSchema]),
        "pr/canceled": z.union([PRCanceledSchema, LegacyPRCanceledSchema]),
      },
      projectionVersion: "bays-v4-freshness",
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
              certifyHandoff: (args) => yrd.dispatch(commands.bay.certifyHandoff, args),
              intake: (args) => yrd.dispatch(commands.bay.intake, args),
              submit: (args) => yrd.dispatch(commands.bay.submit, args),
              close: (args) => yrd.dispatch(commands.bay.close, args),
              closePr: (args) => yrd.dispatch(commands.pr.close, args),
              editPr: (args) => yrd.dispatch(commands.pr.edit, args),
              recut: (args) => yrd.dispatch(commands.pr.recut, args),
              ready: (args) => yrd.dispatch(commands.pr.ready, args),
              review: (args) => yrd.dispatch(commands.pr.review, args),
              comment: (args) => yrd.dispatch(commands.pr.comment, args),
              requestChecks: (args) => yrd.dispatch(commands.pr.requestChecks, args),
              requestReview: (args) => yrd.dispatch(commands.pr.requestReview, args),
              recordRegression: (args) => yrd.dispatch(commands.pr.regression, args),
            },
            { defaultBase, ...(options.resolveBase === undefined ? {} : { resolveBase: options.resolveBase }) },
            yrd.log.child("bay"),
          ),
        }
      },
    })
}

function prIdentity(pr: DeepReadonly<PR>): YrdDeliveryIdentity {
  return {
    pr: pr.id,
    revision: pr.revision,
    headSha: pr.headSha,
    ...(pr.correlation === undefined ? {} : { correlation: pr.correlation }),
  }
}

function jobDetail(job: DeepReadonly<Job>): string {
  if (job.status === "failed") return job.error.message
  if (job.status === "lost") return job.lostReason
  if (job.status === "waiting") return job.detail ?? job.status
  return job.status
}

function createBayCommands(jobs: BayJobDefs, defaultBase: string, defaultActor: string): BayCommands {
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
      certifyHandoff: command({
        title: "Certify a materialized Bay handoff",
        visibility: "public",
        params: CertifyHandoffArgsSchema,
        apply: (state: BayState, args: CertifyHandoffArgs) => certifyBayHandoff(state, args),
      }),
      intake: command({
        title: "Record pushed revision",
        params: IntakePRArgsSchema,
        apply: (state: BayState, args: IntakePRArgs) => intakePR(state, args, defaultBase, defaultActor),
      }),
      submit: command({
        title: "Submit work",
        visibility: "public",
        params: SubmitArgsSchema,
        apply: (state: BayState, args: SubmitArgs) => submitWork(state, args, defaultBase, defaultActor),
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
        apply: (state: BayState, args: PrRecutArgs) => recutPr(state, args, defaultActor),
      }),
      ready: command({
        title: "Mark a PR ready",
        visibility: "public",
        params: PrReadyArgsSchema,
        apply: (state: BayState, args: PrReadyArgs) => readyPr(state, args, defaultActor),
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
      requestReview: command({
        title: "Replace the requested reviewers for a PR",
        visibility: "public",
        params: PrRequestReviewArgsSchema,
        apply: (state: BayState, args: PrRequestReviewArgs) => requestPrReview(state, args, defaultActor),
      }),
      regression: command({
        title: "Record a completed escaped regression",
        params: PrRegressionArgsSchema,
        apply: (state: BayState, args: PrRegressionArgs) => recordPrRegression(state, args),
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
  const current = state.bays
  if (Object.values(current.byId).some((bay) => bay.status !== "closed" && bay.name === args.name)) {
    throw new Error(`yrd: bay '${args.name}' is already open`)
  }
  const id = nextId("B", current.byId)
  const base = baseIdentity(args.base ?? defaultBase)
  const branch = args.from ?? defaultBayBranch(args.name)
  if (Object.values(current.byId).some((bay) => bay.status !== "closed" && bay.branch === branch)) {
    throw new Error(`yrd: branch '${branch}' is already open in another bay`)
  }
  const opened = {
    id,
    name: args.name,
    ...(args.issue === undefined ? {} : { issue: args.issue }),
    ...(args.actor === undefined ? {} : { actor: args.actor }),
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
        base: bay.base,
      }),
    ],
  }
}

function certifyBayHandoff(state: DeepReadonly<BayState>, args: CertifyHandoffArgs) {
  const bay = required(resolveBay(state.bays, args.bay), "bay", args.bay)
  if (bay.status !== "active") throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
  if (bay.branch !== args.branch) {
    throw new Error(`yrd: handoff branch '${args.branch}' does not match current branch '${bay.branch}'`)
  }
  if (bay.headSha !== args.headSha) {
    throw new Error(
      `yrd: handoff head '${args.headSha}' does not match current head '${bay.headSha ?? "unknown"}' for bay '${bay.id}'`,
    )
  }
  if (bay.handoff?.evidence === args.evidence) {
    if (bay.handoff.headSha === args.headSha) return { events: [] }
    throw new Error(`yrd: handoff evidence '${args.evidence}' already certifies a different Bay head`)
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

function intakePR(state: DeepReadonly<BayState>, args: IntakePRArgs, defaultBase: string, defaultActor: string) {
  const current = state.bays
  const bay = args.bay === undefined ? undefined : required(resolveBay(current, args.bay), "bay", args.bay)
  if (bay !== undefined && bay.status !== "active") throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
  const branch = args.branch ?? bay?.branch
  if (branch === undefined) throw new Error("yrd: bay.intake: 'bay' or 'branch' is required")
  const base = baseIdentity(args.base ?? bay?.base ?? defaultBase)
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
  const existing = bay === undefined ? resolvePR(current, branch) : prForBay(current, bay.id)
  refuseDuplicatePayload(current, args.headSha, base, args.composition, existing?.id)
  if (existing?.status === "integrated" || existing?.status === "withdrawn" || existing?.status === "canceled") {
    throw new Error(`yrd: PR '${existing.id}' is ${existing.status}; start a new bay`)
  }
  const id = existing?.id ?? nextId("PR", current.prs)
  const issue = attachedIssue(existing, args.issue, bay?.issue)
  const actor = args.actor ?? bay?.actor ?? defaultActor
  return {
    events: [
      event("pr/pushed", {
        pr: id,
        ...(bay === undefined ? {} : { bay: bay.id }),
        ...((args.name ?? bay?.name) ? { name: args.name ?? bay?.name } : {}),
        ...(issue === undefined ? {} : { issue }),
        branch,
        base,
        headSha: args.headSha,
        ...(args.baseSha === undefined ? {} : { baseSha: args.baseSha }),
        ...(args.composition === undefined ? {} : { composition: args.composition }),
        ...(args.receipt === undefined ? {} : { receipt: args.receipt }),
        revision: (existing?.revision ?? 0) + 1,
        actor,
      }),
    ],
  }
}

function submitWork(state: DeepReadonly<BayState>, args: SubmitArgs, defaultBase: string, defaultActor: string) {
  const current = state.bays
  if ("pr" in args) {
    const pr = required(resolvePR(current, args.pr), "PR", args.pr)
    if (args.correlation !== undefined) return bindPRCorrelation(pr, args.correlation)
    if (pr.status !== "pushed") throw new Error(`yrd: PR '${pr.id}' is ${pr.status}, not pushed`)
    return {
      events: [event("pr/submitted", { pr: pr.id, ...revisionIdentity(pr), actor: args.actor ?? defaultActor })],
    }
  }

  const base = baseIdentity(args.base ?? defaultBase)
  const existing = resolvePR(current, args.branch)
  if (existing?.status === "pushed" || existing?.status === "submitted") {
    throw new Error(`yrd: branch '${args.branch}' already has live PR '${existing.id}'`)
  }
  refuseDuplicatePayload(current, args.headSha, base, args.composition, existing?.id)
  // D2 — reopen the existing PR identity (next revision) for a non-landed
  // terminal branch, not just a rejected one. `rejected` already reopened;
  // `withdrawn`/`canceled` now do too, so resubmitting the branch mints the
  // next revision in place instead of demanding a hand-made delivery branch.
  // The pr/pushed projection clears the terminal markers on reopen. `pushed`/
  // `submitted` are already refused above, and `integrated` is intercepted by
  // the terminal-branch guard before this path (its redelivery is parked).
  const resubmitted =
    existing?.status === "rejected" || existing?.status === "withdrawn" || existing?.status === "canceled"
      ? existing
      : undefined
  const id = resubmitted?.id ?? nextId("PR", current.prs)
  const revision = (resubmitted?.revision ?? 0) + 1
  const issue = attachedIssue(resubmitted, args.issue)
  const actor = args.actor ?? defaultActor
  const pushed = {
    pr: id,
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(issue === undefined ? {} : { issue }),
    branch: args.branch,
    base,
    headSha: args.headSha,
    ...(args.baseSha === undefined ? {} : { baseSha: args.baseSha }),
    ...(args.correlation === undefined ? {} : { correlation: args.correlation }),
    ...(args.composition === undefined ? {} : { composition: args.composition }),
    revision,
    actor,
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
              actor,
              ...(args.correlation === undefined ? {} : { correlation: args.correlation }),
            }),
          ]),
      ...(args.reviewers === undefined || args.reviewers.length === 0
        ? []
        : [event("pr/review-requested", { pr: id, reviewers: args.reviewers, requestedBy: actor })]),
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
  if (pr.correlation !== undefined) {
    if (correlationsEqual(pr.correlation, correlation)) return { events: [] }
    raiseFailure(
      "refusal",
      "correlation-conflict",
      `yrd: PR '${pr.id}' is already bound to correlation '${correlationLabel(pr.correlation)}'`,
    )
  }
  if (pr.status !== "pushed" && pr.status !== "submitted") {
    raiseFailure(
      "refusal",
      "correlation-too-late",
      `yrd: PR '${pr.id}' is ${pr.status}; correlation can only be bound while pushed or submitted`,
    )
  }
  return {
    events: [
      event("pr/correlation-bound", {
        pr: pr.id,
        revision: pr.revision,
        headSha: pr.headSha,
        correlation,
      }),
    ],
  }
}

function revisionIdentity(pr: DeepReadonly<PR>) {
  return {
    revision: pr.revision,
    headSha: pr.headSha,
    ...(pr.correlation === undefined ? {} : { correlation: pr.correlation }),
  }
}

function currentRevisionActor(pr: DeepReadonly<PR>): string | undefined {
  return pr.revisions.find((revision) => revision.revision === pr.revision && revision.headSha === pr.headSha)?.actor
}

function terminalIdentity(pr: DeepReadonly<PR>) {
  const actor = currentRevisionActor(pr)
  return {
    ...revisionIdentity(pr),
    ...(pr.issue === undefined ? {} : { issueRef: pr.issue }),
    ...(actor === undefined ? {} : { actor }),
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
      `yrd: PR '${existing.id}' is already linked to issue '${existing.issue}'; withdraw it before linking another issue`,
    )
  }
  return requested ?? existing?.issue ?? fallback
}

function correlationPatch(pr: DeepReadonly<PR>, correlation: DeepReadonly<Correlation>) {
  return {
    correlation: { ...correlation },
    revisions: pr.revisions.map((revision) =>
      revision.revision === pr.revision && revision.headSha === pr.headSha
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
  if (
    (terminal.revision !== undefined && terminal.revision !== pr.revision) ||
    (terminal.headSha !== undefined && terminal.headSha !== pr.headSha)
  ) {
    throw new Error(
      `yrd: stale terminal '${eventName}' for PR '${pr.id}' targets ${terminal.revision ?? "unknown"}@${terminal.headSha ?? "unknown"}; current is ${pr.revision}@${pr.headSha}`,
    )
  }
  if (terminal.issueRef !== undefined && terminal.issueRef !== pr.issue) {
    throw new Error(`yrd: terminal issue '${terminal.issueRef}' does not match PR '${pr.id}'`)
  }
  if (
    terminal.correlation !== undefined &&
    (pr.correlation === undefined || !correlationsEqual(pr.correlation, terminal.correlation))
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
  const revisions = pr.revisions.map((revision) => {
    if (revision.revision !== identity.revision || revision.headSha !== identity.headSha) return revision
    found = true
    if (revision.terminal?.status !== "rejected") {
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
  const current = pr.revision === identity.revision && pr.headSha === identity.headSha
  if (current && pr.status !== "rejected") {
    throw new Error(`yrd: current PR '${pr.id}' is ${pr.status}, not rejected`)
  }
  if (current && pr.terminalRun !== undefined && pr.terminalRun !== run) {
    throw new Error(`yrd: current PR '${pr.id}' is already associated with '${pr.terminalRun}'`)
  }
  return { ...pr, revisions, ...(current ? { terminalRun: run } : {}) }
}

function readyPr(state: DeepReadonly<BayState>, args: PrReadyArgs, defaultActor: string) {
  const pr = requireLivePR(state.bays, args.pr)
  if (pr.status === "submitted") return { events: [] }
  return submitWork(state, args, "main", defaultActor)
}

function recutPr(state: DeepReadonly<BayState>, args: PrRecutArgs, defaultActor: string) {
  const pr = requireLivePR(state.bays, args.pr)
  if (pr.status === "integrated" || pr.status === "withdrawn" || pr.status === "canceled") {
    raiseFailure("refusal", "terminal-target", `yrd: PR '${pr.id}' is ${pr.status}; terminal PRs cannot be recut`)
  }
  const predecessor = pr.revisions.find((revision) => revision.revision === args.fromRevision)
  if (predecessor === undefined) {
    raiseFailure("refusal", "revision-missing", `yrd: PR '${pr.id}' has no revision ${args.fromRevision}`)
  }
  const unchanged =
    pr.headSha === args.headSha &&
    pr.baseSha === args.baseSha &&
    pr.recut?.fromRevision === args.fromRevision &&
    pr.recut.patchId === args.patchId &&
    pr.recut.treeSha === args.treeSha &&
    pr.recut.reviewCarried === args.reviewCarried &&
    pr.recut.transition?.from === args.transition?.from &&
    pr.recut.transition?.to === args.transition?.to &&
    sameComposition(pr.composition, args.composition)
  if (unchanged) return { events: [] }

  if (
    args.expectedCurrent !== undefined &&
    (pr.revision !== args.expectedCurrent.revision || pr.headSha !== args.expectedCurrent.headSha)
  ) {
    raiseFailure(
      "refusal",
      "recut-current-changed",
      `yrd: PR '${pr.id}' current revision changed from ${args.expectedCurrent.revision}@${args.expectedCurrent.headSha} ` +
        `to ${pr.revision}@${pr.headSha} while the recut was computed`,
    )
  }
  if (args.transition !== undefined) {
    if (args.expectedCurrent === undefined) {
      raiseFailure(
        "refusal",
        "recut-transition-current-required",
        `yrd: PR '${pr.id}' Queue freshness transition requires an expected current revision`,
      )
    }
    if (pr.status !== "submitted" || !checksRequested(pr) || args.fromRevision !== pr.revision) {
      raiseFailure(
        "refusal",
        "recut-transition-not-admitted",
        `yrd: PR '${pr.id}' revision ${pr.revision} is not the admitted revision selected for refresh`,
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

  const approved = pr.reviews.findLast(
    (review) =>
      review.revision === predecessor.revision &&
      review.headSha === predecessor.headSha &&
      review.decision === "approve",
  )
  if (args.reviewCarried && approved === undefined) {
    raiseFailure(
      "refusal",
      "review-carry-invalid",
      `yrd: PR '${pr.id}' revision ${predecessor.revision} has no approval to carry`,
    )
  }
  const successor = { revision: pr.revision + 1, headSha: args.headSha, baseSha: args.baseSha }
  const successorActor = predecessor.actor ?? defaultActor
  return {
    events: [
      event("pr/recut", {
        pr: pr.id,
        fromRevision: predecessor.revision,
        patchId: args.patchId,
        baseSha: args.baseSha,
        treeSha: args.treeSha,
        reviewCarried: args.reviewCarried,
        predecessor: {
          revision: predecessor.revision,
          headSha: predecessor.headSha,
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
              actor: successorActor,
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

function requestPrReview(state: DeepReadonly<BayState>, args: PrRequestReviewArgs, defaultActor: string) {
  const pr = requireLivePR(state.bays, args.pr)
  if (pr.status !== "pushed" && pr.status !== "submitted") {
    raiseFailure(
      "refusal",
      "terminal-target",
      `yrd: PR '${pr.id}' is ${pr.status}; terminal PRs cannot change requested reviewers`,
    )
  }
  const requested = pr.requestedReviewers ?? []
  const unchanged =
    requested.length === args.reviewers.length &&
    requested.every((reviewer, index) => reviewer === args.reviewers[index])
  if (unchanged) return { events: [] }
  return {
    events: [
      event("pr/review-requested", { pr: pr.id, reviewers: args.reviewers, requestedBy: args.actor ?? defaultActor }),
    ],
  }
}

function reviewPr(state: DeepReadonly<BayState>, args: PrReviewArgs) {
  const pr = requireLivePR(state.bays, args.pr)
  const fact = PRReviewFactSchema.parse({
    pr: pr.id,
    revision: pr.revision,
    headSha: pr.headSha,
    actor: args.actor,
    decision: args.decision,
    ...(args.ref === undefined ? {} : { ref: args.ref }),
    ...(args.note === undefined ? {} : { note: args.note }),
  })
  return reviewFact(pr, fact, "review")
}

function commentPr(state: DeepReadonly<BayState>, args: PrCommentArgs) {
  const pr = requireLivePR(state.bays, args.pr)
  const fact = PRCommentFactSchema.parse({
    pr: pr.id,
    revision: pr.revision,
    headSha: pr.headSha,
    actor: args.actor,
    note: args.note,
    ...(args.ref === undefined ? {} : { ref: args.ref }),
  })
  return reviewFact(pr, fact, "comment")
}

function requestPrChecks(state: DeepReadonly<BayState>, args: PrRequestChecksArgs) {
  const pr = requireLivePR(state.bays, args.pr)
  if (pr.status !== "pushed" && pr.status !== "submitted" && pr.status !== "rejected") {
    throw new PrCheckabilityConflict(pr.id, pr.status)
  }
  const baseSha = args.baseSha ?? pr.baseSha
  return {
    events: [
      event("pr/checks-requested", {
        pr: pr.id,
        revision: pr.revision,
        headSha: pr.headSha,
        ...(baseSha === undefined ? {} : { baseSha }),
      }),
    ],
  }
}

function recordPrRegression(state: DeepReadonly<BayState>, args: PrRegressionArgs) {
  const original = requireLivePR(state.bays, args.pr)
  const repair = resolvePR(state.bays, args.repairPr)
  if (repair === undefined) throw new Error(`yrd: no repair PR '${args.repairPr}'`)
  if (original.id === repair.id) throw new Error("yrd: an escaped regression requires a different repair PR")
  if (original.status !== "integrated" || original.integration === undefined) {
    throw new Error(`yrd: original PR '${original.id}' is ${original.status}, not integrated`)
  }
  if (repair.status !== "integrated" || repair.integration === undefined) {
    throw new Error(`yrd: repair PR '${repair.id}' is ${repair.status}, not integrated`)
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
      `yrd: queue run '${args.run}' does not prove integrated revision ${original.revision} of PR '${original.id}'`,
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
      `yrd: queue run '${args.repairRun}' does not prove integrated revision ${repair.revision} of repair PR '${repair.id}'`,
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
    revision: original.revision,
    headSha: original.headSha,
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
        prior.actor === fact.actor &&
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
      pr.headSha === headSha &&
      baseIdentity(pr.base) === identity &&
      sameComposition(pr.composition, composition),
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
  const pr = prForBay(current, bay.id)
  if (pr !== undefined && isLivePR(pr.status) && args.withdraw !== true) {
    throw new Error(`yrd: PR '${pr.id}' is ${pr.status}; run it through the queue or withdraw it before closing`)
  }
  return {
    events: [
      ...(pr !== undefined && isLivePR(pr.status)
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
  const pr = requireLivePR(state.bays, args.pr)
  if (!isLivePR(pr.status)) {
    throw new Error(`yrd: PR '${pr.id}' is ${pr.status}; only a live PR can be closed`)
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
  const pr = requireLivePR(state.bays, args.pr)
  const issueChanged = args.issue !== undefined && args.issue !== pr.issue
  if (args.issue !== undefined && pr.issue !== undefined && issueChanged) {
    raiseFailure(
      "refusal",
      "issue-conflict",
      `yrd: PR '${pr.id}' is already linked to issue '${pr.issue}'; withdraw it before linking another issue`,
    )
  }
  if (issueChanged && pr.status !== "pushed" && pr.status !== "submitted") {
    raiseFailure(
      "refusal",
      "issue-too-late",
      `yrd: PR '${pr.id}' is ${pr.status}; issue can only be linked while pushed or submitted`,
    )
  }
  // Title and description are mutable delivery metadata (unlike the immutable
  // issue join): a later edit overwrites the prior value with no conflict.
  const titleChanged = args.title !== undefined && args.title !== pr.title
  const descriptionChanged = args.description !== undefined && args.description !== pr.description
  if (!issueChanged && args.note === undefined && !titleChanged && !descriptionChanged) return { events: [] }
  return {
    events: [
      event("pr/edited", {
        pr: pr.id,
        ...(issueChanged ? { issue: args.issue } : {}),
        ...(args.note === undefined ? {} : { note: args.note }),
        ...(titleChanged ? { title: args.title } : {}),
        ...(descriptionChanged ? { description: args.description } : {}),
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
  const patchRevisionClock = (pr: PR, patch: Partial<PRRevisionClock>): readonly PRRevision[] => {
    let found = false
    const revisions = pr.revisions.map((revision) => {
      if (revision.revision !== pr.revision || revision.headSha !== pr.headSha) return revision
      found = true
      return { ...revision, ...patch }
    })
    if (!found) {
      throw new Error(`yrd: PR '${pr.id}' has no clock for current revision ${pr.revision}@${pr.headSha}`)
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
    case "bay/handoff-certified": {
      const certified = BayHandoffCertifiedSchema.parse(data)
      const bay = current.byId[certified.bay]
      if (bay === undefined) return state
      if (bay.branch !== certified.branch || bay.headSha !== certified.headSha) {
        throw new Error(`yrd: handoff certification does not match Bay '${certified.bay}' current branch and head`)
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
      const pushed = parsed.success ? parsed.data : LegacyPRPushedSchema.parse(data)
      const base = baseIdentity(pushed.base)
      const existing = current.prs[pushed.pr]
      const record: PRRevision = {
        revision: pushed.revision,
        headSha: pushed.headSha,
        base,
        ...(pushed.baseSha === undefined ? {} : { baseSha: pushed.baseSha }),
        ...(pushed.composition === undefined ? {} : { composition: pushed.composition }),
        ...(parsed.success ? { actor: parsed.data.actor } : {}),
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
              status: "pushed",
              revision: pushed.revision,
              headSha: pushed.headSha,
              ...(pushed.baseSha === undefined ? {} : { baseSha: pushed.baseSha }),
              ...(pushed.correlation === undefined ? {} : { correlation: pushed.correlation }),
              ...(pushed.composition === undefined ? {} : { composition: pushed.composition }),
              revisions: [record],
              reviews: [],
              comments: [],
              checkRequests: [],
              requestedReviewers: [],
              regressions: [],
            }
          : {
              ...existing,
              ...(pushed.issue === undefined ? {} : { issue: pushed.issue }),
              base,
              status: "pushed",
              revision: pushed.revision,
              headSha: pushed.headSha,
              ...(pushed.baseSha === undefined ? {} : { baseSha: pushed.baseSha }),
              correlation: pushed.correlation,
              ...(pushed.composition === undefined ? { composition: undefined } : { composition: pushed.composition }),
              recut: undefined,
              revisions: [...existing.revisions, record],
              terminalRun: undefined,
              submittedAt: undefined,
              rejectedAt: undefined,
              integratedAt: undefined,
              integration: undefined,
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
      const recut = PRRecutFactSchema.parse(data)
      const pr = current.prs[recut.pr]
      if (pr === undefined) throw new Error(`yrd: no PR '${recut.pr}' for recut`)
      const predecessor = pr.revisions.find(
        (revision) =>
          revision.revision === recut.predecessor.revision && revision.headSha === recut.predecessor.headSha,
      )
      if (
        predecessor === undefined ||
        recut.fromRevision !== recut.predecessor.revision ||
        predecessor.baseSha !== recut.predecessor.baseSha ||
        recut.successor.revision !== pr.revision + 1
      ) {
        throw new Error(`yrd: recut lineage does not match PR '${pr.id}'`)
      }
      const proof: PRRecutProof = {
        fromRevision: recut.fromRevision,
        patchId: recut.patchId,
        treeSha: recut.treeSha,
        reviewCarried: recut.reviewCarried,
        ...(recut.transition === undefined ? {} : { transition: recut.transition }),
      }
      const correlation = predecessor.correlation
      const revision: PRRevision = {
        revision: recut.successor.revision,
        headSha: recut.successor.headSha,
        base: pr.base,
        baseSha: recut.successor.baseSha,
        ...(correlation === undefined ? {} : { correlation: { ...correlation } }),
        ...(recut.composition === undefined ? {} : { composition: recut.composition }),
        recut: proof,
        pushedAt: applied.ts,
      }
      const approval = pr.reviews.findLast(
        (review) =>
          review.revision === predecessor.revision &&
          review.headSha === predecessor.headSha &&
          review.decision === "approve",
      )
      if (recut.reviewCarried && approval === undefined) {
        throw new Error(`yrd: PR '${pr.id}' recut carries a missing approval`)
      }
      const carriedReview: PRReview | undefined =
        recut.reviewCarried && approval !== undefined
          ? {
              revision: revision.revision,
              headSha: revision.headSha,
              actor: approval.actor,
              decision: "approve",
              at: applied.ts,
              ...(approval.note === undefined ? {} : { note: approval.note }),
              carriedFrom: { revision: predecessor.revision, headSha: predecessor.headSha },
            }
          : undefined
      return patchPR(pr, {
        status: "pushed",
        revision: revision.revision,
        headSha: revision.headSha,
        baseSha: revision.baseSha,
        ...(correlation === undefined ? { correlation: undefined } : { correlation: { ...correlation } }),
        ...(recut.composition === undefined ? { composition: undefined } : { composition: recut.composition }),
        recut: proof,
        revisions: [...pr.revisions, revision],
        reviews: carriedReview === undefined ? pr.reviews : [...pr.reviews, carriedReview],
        terminalRun: undefined,
        submittedAt: undefined,
        rejectedAt: undefined,
        integratedAt: undefined,
        integration: undefined,
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
      const pr = current.prs[changed.pr]
      if (pr === undefined) return state
      if (pr.revision !== changed.revision || pr.headSha !== changed.headSha) {
        throw new Error(`yrd: stale PR event for '${pr.id}'`)
      }
      if (
        changed.correlation !== undefined &&
        pr.correlation !== undefined &&
        !correlationsEqual(pr.correlation, changed.correlation)
      ) {
        throw new Error(`yrd: submitted correlation does not match PR '${pr.id}'`)
      }
      const correlation = changed.correlation ?? pr.correlation
      const revisions = patchRevisionClock(pr, { submittedAt: applied.ts, terminal: undefined }).map((revision) => {
        if (revision.revision !== pr.revision || revision.headSha !== pr.headSha) return revision
        return {
          ...revision,
          ...(parsed.success ? { actor: parsed.data.actor } : {}),
          ...(correlation === undefined ? {} : { correlation: { ...correlation } }),
        }
      })
      return patchPR(pr, {
        status: "submitted",
        submittedAt: applied.ts,
        rejectedAt: undefined,
        integratedAt: undefined,
        integration: undefined,
        withdrawnAt: undefined,
        withdrawReason: undefined,
        canceledAt: undefined,
        canceledBy: undefined,
        cancelReason: undefined,
        ...(correlation === undefined ? {} : { correlation: { ...correlation } }),
        revisions,
      })
    }
    case "pr/correlation-bound": {
      const changed = PRCorrelationBoundSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) return state
      if (pr.revision !== changed.revision || pr.headSha !== changed.headSha) {
        throw new Error(`yrd: stale correlation bind for PR '${pr.id}'`)
      }
      if (pr.status !== "pushed" && pr.status !== "submitted") {
        throw new Error(`yrd: PR '${pr.id}' is ${pr.status}; correlation cannot be bound`)
      }
      if (pr.correlation !== undefined && !correlationsEqual(pr.correlation, changed.correlation)) {
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
        status: "withdrawn",
        withdrawnAt: applied.ts,
        ...(parsed.success && parsed.data.reason !== undefined ? { withdrawReason: parsed.data.reason } : {}),
        revisions: patchRevisionClock(pr, { terminal: { status: "withdrawn", at: applied.ts } }),
      })
    }
    case "pr/rejected": {
      const changed = PRReplayRejectedSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined) throw new Error(`yrd: terminal '${applied.name}' names missing PR '${changed.pr}'`)
      assertTerminalApplies(pr, changed, applied.name)
      const rejected: PR = {
        ...pr,
        status: "rejected",
        rejectedAt: applied.ts,
        terminalRun: undefined,
        revisions: patchRevisionClock(pr, {
          terminal: { status: "rejected", at: applied.ts },
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
        status: "integrated",
        integratedAt: applied.ts,
        terminalRun: run,
        integration: { commit: changed.commit, baseSha: changed.baseSha },
        revisions: patchRevisionClock(pr, {
          terminal: { status: "integrated", at: applied.ts, ...(run === undefined ? {} : { run }) },
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
        status: "canceled",
        canceledAt: applied.ts,
        canceledBy: changed.by,
        cancelReason: changed.reason,
        terminalRun: run,
        revisions: patchRevisionClock(pr, {
          terminal: { status: "canceled", at: applied.ts, ...(run === undefined ? {} : { run }) },
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
        pr.status !== "integrated" ||
        repair.status !== "integrated" ||
        pr.issue !== fact.issueRef ||
        pr.revision !== fact.revision ||
        pr.headSha !== fact.headSha ||
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
        (pr.status === "pushed" || pr.status === "submitted")
      return pr === undefined
        ? state
        : patchPR(pr, {
            ...(attachIssue ? { issue: changed.issue } : {}),
            ...(changed.note === undefined ? {} : { note: changed.note }),
            ...(changed.title === undefined ? {} : { title: changed.title }),
            ...(changed.description === undefined ? {} : { description: changed.description }),
          })
    }
    case "pr/reviewed": {
      const reviewed = PRReviewFactSchema.parse(data)
      const pr = current.prs[reviewed.pr]
      if (pr === undefined) return state
      const review: PRReview = { ...reviewed, at: applied.ts }
      return patchPR(pr, { reviews: [...pr.reviews, review] })
    }
    case "pr/commented": {
      const commented = PRCommentFactSchema.parse(data)
      const pr = current.prs[commented.pr]
      if (pr === undefined) return state
      const comment: PRComment = { ...commented, at: applied.ts }
      return patchPR(pr, { comments: [...pr.comments, comment] })
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
      if (pr.revision !== requested.revision || pr.headSha !== requested.headSha) return state
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
    return save({
      status: bay.jobDef === "bay.provision" ? "failed" : "active",
      failure: { code: "job-lost", message: change.reason },
    })
  }
  if (change.result.status === "failed") {
    return save({
      status: bay.jobDef === "bay.provision" ? "failed" : "active",
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
  return name === "bay.provision" || name === "bay.refresh" || name === "bay.deprovision"
}
