import {
  command,
  event,
  observeYrdLifecycle,
  raiseFailure,
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
  CorrelationSchema,
  DeprovisionBayInputSchema,
  DeprovisionedBaySchema,
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
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
  prForBay,
  reviewState,
  resolveBay,
  resolvePR,
  type Bay,
  type BaysState,
  type Correlation,
  type DeprovisionBayInput,
  type DeprovisionedBay,
  type PR,
  type PRComment,
  type PRRegression,
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

const IntakePRArgsSchema = z
  .object({
    bay: TextSchema.optional(),
    name: TextSchema.optional(),
    issue: TextSchema.optional(),
    branch: GitRefSchema.optional(),
    base: GitRefSchema.optional(),
    headSha: GitShaSchema,
    baseSha: GitShaSchema.optional(),
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
  z.object({ pr: TextSchema, correlation: CorrelationSchema.optional() }).strict(),
  z
    .object({
      branch: GitRefSchema,
      headSha: GitShaSchema,
      base: GitRefSchema.optional(),
      baseSha: GitShaSchema.optional(),
      name: TextSchema.optional(),
      issue: TextSchema.optional(),
      draft: z.boolean().optional(),
      correlation: CorrelationSchema.optional(),
    })
    .strict(),
])
export type SubmitArgs = z.infer<typeof SubmitArgsSchema>

export type SubmitSelectionOptions = Readonly<{
  base?: string
  issue?: string
  draft?: boolean
  correlation?: Correlation
  resolveRevision(ref: string): Promise<string | undefined>
  run: RunJobOptions
}>

const CloseBayArgsSchema = z.object({ bay: TextSchema, withdraw: z.boolean().optional() }).strict()
export type CloseBayArgs = z.infer<typeof CloseBayArgsSchema>

const PrCloseArgsSchema = z.object({ pr: TextSchema }).strict()
export type PrCloseArgs = z.infer<typeof PrCloseArgsSchema>
const PrEditArgsSchema = z
  .object({ pr: TextSchema, issue: TextSchema.optional(), note: TextSchema.optional() })
  .strict()
  .refine(({ issue, note }) => issue !== undefined || note !== undefined, { message: "'issue' or 'note' is required" })
export type PrEditArgs = z.infer<typeof PrEditArgsSchema>

const PrReadyArgsSchema = z.object({ pr: TextSchema }).strict()
export type PrReadyArgs = z.infer<typeof PrReadyArgsSchema>
const PrRequestChecksArgsSchema = z.object({ pr: TextSchema, baseSha: GitShaSchema.optional() }).strict()
export type PrRequestChecksArgs = z.infer<typeof PrRequestChecksArgsSchema>

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
const PRPushedSchema = z
  .object({
    pr: PRIdSchema,
    bay: BayIdSchema.optional(),
    name: TextSchema.optional(),
    issue: TextSchema.optional(),
    branch: GitRefSchema,
    base: GitRefSchema,
    headSha: GitShaSchema,
    baseSha: GitShaSchema.optional(),
    receipt: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    revision: RevisionSchema,
    correlation: CorrelationSchema.optional(),
  })
  .strict()
const PRRevisionIdentitySchema = z.object({ pr: PRIdSchema, revision: RevisionSchema, headSha: GitShaSchema }).strict()
const PRRevisionSchema = PRRevisionIdentitySchema.extend({ correlation: CorrelationSchema.optional() }).strict()
const PRCorrelationBoundSchema = PRRevisionIdentitySchema.extend({ correlation: CorrelationSchema }).strict()
const PRTerminalIdentitySchema = PRRevisionIdentitySchema.extend({
  issueRef: TextSchema.optional(),
  correlation: CorrelationSchema.optional(),
}).strict()
const PRQueueTerminalIdentitySchema = PRTerminalIdentitySchema.extend({ run: TextSchema }).strict()
const PRWithdrawnSchema = PRTerminalIdentitySchema
const LegacyPRWithdrawnSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema.optional(),
    headSha: GitShaSchema.optional(),
    correlation: CorrelationSchema.optional(),
  })
  .strict()
const PRRejectedSchema = PRQueueTerminalIdentitySchema.extend({ detail: z.string().optional() }).strict()
const LegacyPRRejectedSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema.optional(),
    correlation: CorrelationSchema.optional(),
    detail: z.string().optional(),
  })
  .strict()
const PRIntegratedSchema = PRQueueTerminalIdentitySchema.extend({
  commit: GitShaSchema,
  landingSha: GitShaSchema,
  baseSha: GitShaSchema,
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
const PRCanceledSchema = PRQueueTerminalIdentitySchema.extend({
  by: TextSchema,
  reason: TextSchema,
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
    intake: CommandHandler<IntakePRArgs, BayState>
    submit: CommandHandler<SubmitArgs, BayState>
    close: CommandHandler<CloseBayArgs, BayState>
  }>
  pr: Readonly<{
    close: CommandHandler<PrCloseArgs, BayState>
    edit: CommandHandler<PrEditArgs, BayState>
    ready: CommandHandler<PrReadyArgs, BayState>
    review: CommandHandler<PrReviewArgs, BayState>
    comment: CommandHandler<PrCommentArgs, BayState>
    requestChecks: CommandHandler<PrRequestChecksArgs, BayState>
    regression: CommandHandler<PrRegressionArgs, BayState>
  }>
}>

export type Bays = Readonly<{
  state: ReadSignal<DeepReadonly<BaysState>>
  get(selector: string): DeepReadonly<Bay> | undefined
  list(): readonly DeepReadonly<Bay>[]
  pr(selector: string): DeepReadonly<PR> | undefined
  prs(): readonly DeepReadonly<PR>[]
  reviewState(selector: string): DeepReadonly<PRReviewState>
  checksRequested(selector: string): boolean
  open(args: OpenBayArgs): Promise<CommandResult>
  refresh(args: RefreshBayArgs): Promise<CommandResult>
  intake(args: IntakePRArgs): Promise<CommandResult>
  submit(args: SubmitArgs): Promise<CommandResult>
  submitSelection(selector: string, options: SubmitSelectionOptions): Promise<DeepReadonly<PR>>
  close(args: CloseBayArgs): Promise<CommandResult>
  closePr(args: PrCloseArgs): Promise<CommandResult>
  editPr(args: PrEditArgs): Promise<CommandResult>
  ready(args: PrReadyArgs): Promise<CommandResult>
  review(args: PrReviewArgs): Promise<CommandResult>
  comment(args: PrCommentArgs): Promise<CommandResult>
  requestChecks(args: PrRequestChecksArgs): Promise<CommandResult>
  recordRegression(args: PrRegressionArgs): Promise<CommandResult>
}>

export type HasBays = Readonly<{ bays: Bays }>

type BayActions = Pick<
  Bays,
  | "open"
  | "refresh"
  | "intake"
  | "submit"
  | "close"
  | "closePr"
  | "editPr"
  | "ready"
  | "review"
  | "comment"
  | "requestChecks"
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
  const bindSubmission = async (
    pr: DeepReadonly<PR>,
    submission: Pick<SubmitSelectionOptions, "issue" | "correlation">,
  ): Promise<DeepReadonly<PR>> => bindCorrelation(await bindIssue(pr, submission.issue), submission.correlation)

  const submitSelectionOperation = async (
    selector: string,
    options: SubmitSelectionOptions,
  ): Promise<DeepReadonly<PR>> => {
    let snapshot = state()
    let pr = resolvePR(snapshot, selector)
    let bay = resolveBay(snapshot, selector) ?? (pr?.bay === undefined ? undefined : resolveBay(snapshot, pr.bay))
    if (pr?.status === "integrated") return bindSubmission(pr, options)

    if (bay?.status === "active") {
      const refreshed = await actions.refresh({ bay: bay.id })
      await execute(refreshed, options.run, `bay '${bay.id}' refresh`)
      snapshot = state()
      bay = resolveBay(snapshot, bay.id)
      if (bay === undefined) {
        raiseFailure("infrastructure", "bay-state-invalid", `yrd: bay '${selector}' disappeared after refresh`)
      }
      if (bay.dirty === true) {
        raiseFailure(
          "refusal",
          "bay-dirty",
          `yrd: bay '${bay.id}' has uncommitted work; commit or discard it before submit`,
        )
      }
      if (bay.headSha === undefined) {
        raiseFailure("refusal", "bay-head-missing", `yrd: bay '${bay.id}' has no committed head to submit`)
      }
      pr = prForBay(snapshot, bay.id)
      if (pr === undefined || pr.headSha !== bay.headSha) {
        await intake({
          bay: bay.id,
          headSha: bay.headSha,
          ...(bay.baseSha === undefined ? {} : { baseSha: bay.baseSha }),
          ...(options.issue === undefined ? {} : { issue: options.issue }),
        })
        pr = prForBay(state(), bay.id)
      }
    }

    if (pr?.status === "submitted" && bay === undefined) {
      const headSha = await options.resolveRevision(pr.branch)
      if (headSha === undefined) {
        raiseFailure("refusal", "git-commit-missing", `yrd: no Git commit '${pr.branch}'`)
      }
      const resolved = await target(options.base ?? pr.base, undefined)
      if (headSha !== pr.headSha || resolved.base !== pr.base || resolved.baseSha !== pr.baseSha) {
        await intake({
          branch: pr.branch,
          headSha,
          ...resolved,
          ...(options.issue === undefined ? {} : { issue: options.issue }),
        })
        pr = resolvePR(state(), pr.id)
        if (pr === undefined) {
          raiseFailure("infrastructure", "pr-state-invalid", `yrd: PR '${selector}' disappeared after revision intake`)
        }
      }
    }

    if (pr !== undefined) pr = await bindIssue(pr, options.issue)
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
          candidate.base === resolved.base,
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
      () => submitSelectionOperation(selector, options),
    )
  }

  return Object.freeze({
    state,
    get: (selector) => resolveBay(state(), selector),
    list: () => Object.freeze(Object.values(state().byId)),
    pr: (selector) => resolvePR(state(), selector),
    prs: () => Object.freeze(Object.values(state().prs)),
    reviewState: (selector) => reviewState(required(resolvePR(state(), selector), "PR", selector)),
    checksRequested: (selector) => checksRequested(required(resolvePR(state(), selector), "PR", selector)),
    submitSelection,
    open,
    refresh: actions.refresh,
    intake,
    submit,
    close: actions.close,
    closePr: actions.closePr,
    editPr: actions.editPr,
    ready: actions.ready,
    review: actions.review,
    comment: actions.comment,
    requestChecks: actions.requestChecks,
    recordRegression: actions.recordRegression,
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
        "bay/opened": BayOpenedSchema,
        "bay/closing": BayClosingSchema,
        "pr/pushed": PRPushedSchema,
        "pr/submitted": PRRevisionSchema,
        "pr/correlation-bound": PRCorrelationBoundSchema,
        "pr/withdrawn": PRWithdrawnSchema,
        "pr/rejected": PRRejectedSchema,
        "pr/terminal-associated": PRTerminalAssociationSchema,
        "pr/integrated": PRIntegratedSchema,
        "pr/canceled": PRCanceledSchema,
        "pr/regression-recorded": PRRegressionSchema,
        "pr/edited": PrEditArgsSchema,
        "pr/reviewed": PRReviewFactSchema,
        "pr/commented": PRCommentFactSchema,
        "pr/checks-requested": PRCheckRequestFactSchema,
      },
      replayEvents: {
        "pr/withdrawn": LegacyPRWithdrawnSchema,
        "pr/rejected": LegacyPRRejectedSchema,
        "pr/integrated": LegacyPRIntegratedSchema,
        "pr/canceled": LegacyPRCanceledSchema,
      },
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
              intake: (args) => yrd.dispatch(commands.bay.intake, args),
              submit: (args) => yrd.dispatch(commands.bay.submit, args),
              close: (args) => yrd.dispatch(commands.bay.close, args),
              closePr: (args) => yrd.dispatch(commands.pr.close, args),
              editPr: (args) => yrd.dispatch(commands.pr.edit, args),
              ready: (args) => yrd.dispatch(commands.pr.ready, args),
              review: (args) => yrd.dispatch(commands.pr.review, args),
              comment: (args) => yrd.dispatch(commands.pr.comment, args),
              requestChecks: (args) => yrd.dispatch(commands.pr.requestChecks, args),
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
      intake: command({
        title: "Record pushed revision",
        params: IntakePRArgsSchema,
        apply: (state: BayState, args: IntakePRArgs) => intakePR(state, args, defaultBase),
      }),
      submit: command({
        title: "Submit work",
        visibility: "public",
        params: SubmitArgsSchema,
        apply: (state: BayState, args: SubmitArgs) => submitWork(state, args, defaultBase),
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
      ready: command({
        title: "Mark a PR ready",
        visibility: "public",
        params: PrReadyArgsSchema,
        apply: (state: BayState, args: PrReadyArgs) => readyPr(state, args),
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

function intakePR(state: DeepReadonly<BayState>, args: IntakePRArgs, defaultBase: string) {
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
        received.baseSha === args.baseSha
      if (!matches) throw new Error(`yrd: receiver receipt '${args.receipt}' does not match its recorded intake`)
      return { events: [] }
    }
  }
  const existing = bay === undefined ? resolvePR(current, branch) : prForBay(current, bay.id)
  refuseDuplicatePayload(current, args.headSha, base, existing?.id)
  if (existing?.status === "integrated" || existing?.status === "withdrawn" || existing?.status === "canceled") {
    throw new Error(`yrd: PR '${existing.id}' is ${existing.status}; start a new bay`)
  }
  const id = existing?.id ?? nextId("PR", current.prs)
  const issue = attachedIssue(existing, args.issue, bay?.issue)
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
        ...(args.receipt === undefined ? {} : { receipt: args.receipt }),
        revision: (existing?.revision ?? 0) + 1,
      }),
    ],
  }
}

function submitWork(state: DeepReadonly<BayState>, args: SubmitArgs, defaultBase: string) {
  const current = state.bays
  if ("pr" in args) {
    const pr = required(resolvePR(current, args.pr), "PR", args.pr)
    if (args.correlation !== undefined) return bindPRCorrelation(pr, args.correlation)
    if (pr.status !== "pushed") throw new Error(`yrd: PR '${pr.id}' is ${pr.status}, not pushed`)
    return { events: [event("pr/submitted", { pr: pr.id, ...revisionIdentity(pr) })] }
  }

  const base = baseIdentity(args.base ?? defaultBase)
  const existing = resolvePR(current, args.branch)
  if (existing?.status === "pushed" || existing?.status === "submitted") {
    throw new Error(`yrd: branch '${args.branch}' already has live PR '${existing.id}'`)
  }
  refuseDuplicatePayload(current, args.headSha, base, existing?.id)
  const resubmitted = existing?.status === "rejected" ? existing : undefined
  const id = resubmitted?.id ?? nextId("PR", current.prs)
  const revision = (resubmitted?.revision ?? 0) + 1
  const issue = attachedIssue(resubmitted, args.issue)
  const pushed = {
    pr: id,
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(issue === undefined ? {} : { issue }),
    branch: args.branch,
    base,
    headSha: args.headSha,
    ...(args.baseSha === undefined ? {} : { baseSha: args.baseSha }),
    ...(args.correlation === undefined ? {} : { correlation: args.correlation }),
    revision,
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
              ...(args.correlation === undefined ? {} : { correlation: args.correlation }),
            }),
          ]),
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

function terminalIdentity(pr: DeepReadonly<PR>) {
  return {
    ...revisionIdentity(pr),
    ...(pr.issue === undefined ? {} : { issueRef: pr.issue }),
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

function terminalApplies(
  pr: DeepReadonly<PR>,
  terminal: Readonly<{ revision?: number; headSha?: string; issueRef?: string; correlation?: Correlation }>,
): boolean {
  if (terminal.revision !== undefined && terminal.revision !== pr.revision) return false
  if (terminal.headSha !== undefined && terminal.headSha !== pr.headSha) return false
  if (terminal.issueRef !== undefined && terminal.issueRef !== pr.issue) {
    throw new Error(`yrd: terminal issue '${terminal.issueRef}' does not match PR '${pr.id}'`)
  }
  if (
    terminal.correlation !== undefined &&
    (pr.correlation === undefined || !correlationsEqual(pr.correlation, terminal.correlation))
  ) {
    throw new Error(`yrd: terminal correlation does not match PR '${pr.id}'`)
  }
  return true
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

function readyPr(state: DeepReadonly<BayState>, args: PrReadyArgs) {
  const pr = required(resolvePR(state.bays, args.pr), "PR", args.pr)
  if (pr.status === "submitted") return { events: [] }
  return submitWork(state, args, "main")
}

function reviewPr(state: DeepReadonly<BayState>, args: PrReviewArgs) {
  const pr = required(resolvePR(state.bays, args.pr), "PR", args.pr)
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
  const pr = required(resolvePR(state.bays, args.pr), "PR", args.pr)
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
  const pr = required(resolvePR(state.bays, args.pr), "PR", args.pr)
  if (pr.status !== "pushed" && pr.status !== "submitted" && pr.status !== "rejected") {
    throw new Error(`yrd: PR '${pr.id}' is ${pr.status}, not checkable`)
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
  const original = required(resolvePR(state.bays, args.pr), "PR", args.pr)
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
  if (original.terminalRun !== args.run) {
    raiseFailure(
      "refusal",
      "regression-run-mismatch",
      `yrd: queue run '${args.run}' does not prove integrated revision ${original.revision} of PR '${original.id}'`,
    )
  }
  if (repair.terminalRun !== args.repairRun) {
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
    run: args.run,
    landingSha: original.integration.commit,
    detectedAt,
    severity: args.severity,
    evidence: args.evidence,
    implementationRunRef: args.implementationRunRef,
    reviewRef: args.reviewRef,
    repairIssueRef: repair.issue,
    repairPr: repair.id,
    repairRun: args.repairRun,
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

function refuseDuplicatePayload(state: DeepReadonly<BaysState>, headSha: string, base: string, except?: string): void {
  const identity = baseIdentity(base)
  const duplicate = Object.values(state.prs).find(
    (pr) => pr.id !== except && pr.headSha === headSha && baseIdentity(pr.base) === identity,
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
  const pr = required(resolvePR(state.bays, args.pr), "PR", args.pr)
  if (!isLivePR(pr.status)) {
    throw new Error(`yrd: PR '${pr.id}' is ${pr.status}; only a live PR can be closed`)
  }
  return { events: [event("pr/withdrawn", { pr: pr.id, ...terminalIdentity(pr) })] }
}

function editPr(state: DeepReadonly<BayState>, args: PrEditArgs) {
  const pr = required(resolvePR(state.bays, args.pr), "PR", args.pr)
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
  if (!issueChanged && args.note === undefined) return { events: [] }
  return {
    events: [
      event("pr/edited", {
        pr: pr.id,
        ...(issueChanged ? { issue: args.issue } : {}),
        ...(args.note === undefined ? {} : { note: args.note }),
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
    case "pr/pushed": {
      const pushed = PRPushedSchema.parse(data)
      const base = baseIdentity(pushed.base)
      const existing = current.prs[pushed.pr]
      const record: PRRevision = {
        revision: pushed.revision,
        headSha: pushed.headSha,
        base,
        ...(pushed.baseSha === undefined ? {} : { baseSha: pushed.baseSha }),
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
              revisions: [record],
              reviews: [],
              comments: [],
              checkRequests: [],
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
              revisions: [...existing.revisions, record],
              terminalRun: undefined,
              submittedAt: undefined,
              rejectedAt: undefined,
              integratedAt: undefined,
              integration: undefined,
              withdrawnAt: undefined,
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
                },
              },
            },
      )
    }
    case "pr/submitted": {
      const changed = PRRevisionSchema.parse(data)
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
      const revisions = patchRevisionClock(pr, { submittedAt: applied.ts, terminal: undefined }).map((revision) =>
        correlation !== undefined && revision.revision === pr.revision && revision.headSha === pr.headSha
          ? { ...revision, correlation: { ...correlation } }
          : revision,
      )
      return patchPR(pr, {
        status: "submitted",
        submittedAt: applied.ts,
        rejectedAt: undefined,
        integratedAt: undefined,
        integration: undefined,
        withdrawnAt: undefined,
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
      return pr === undefined || !terminalApplies(pr, changed)
        ? state
        : patchPR(pr, {
            status: "withdrawn",
            withdrawnAt: applied.ts,
            revisions: patchRevisionClock(pr, { terminal: { status: "withdrawn", at: applied.ts } }),
          })
    }
    case "pr/rejected": {
      const parsed = PRRejectedSchema.safeParse(data)
      const changed = parsed.success ? parsed.data : LegacyPRRejectedSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined || !terminalApplies(pr, changed)) return state
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
      return patchPR(
        pr,
        parsed.success ? associateRejectedTerminalRun(rejected, parsed.data, parsed.data.run) : rejected,
      )
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
      if (pr === undefined || !terminalApplies(pr, changed)) return state
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
      return pr === undefined || !terminalApplies(pr, changed)
        ? state
        : patchPR(pr, {
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
  DeprovisionedBaySchema.parse(change.result.output)
  return save({
    status: "closed",
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

function nextId(prefix: string, records: Readonly<Record<string, unknown>>): string {
  const numbers = Object.keys(records)
    .filter((id) => id.startsWith(prefix) && /^\d+$/u.test(id.slice(prefix.length)))
    .map((id) => Number(id.slice(prefix.length)))
  return `${prefix}${Math.max(0, ...numbers) + 1}`
}

function isBayJob(name: string): name is keyof BayJobDefs {
  return name === "bay.provision" || name === "bay.refresh" || name === "bay.deprovision"
}
