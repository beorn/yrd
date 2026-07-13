import {
  command,
  event,
  raiseFailure,
  type CommandHandler,
  type CommandResult,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type EventDraft,
  type YrdDef,
} from "@yrd/core"
import {
  createJobDef,
  type HasJobs,
  type Job,
  type JobContext,
  type JobDef,
  type JobRequest,
  type JobResult,
  type Jobs,
  type JobTransition,
  type RunJobOptions,
} from "@yrd/job"
import { computed, type ReadSignal } from "@silvery/signals"
import * as z from "zod"
import {
  BayIdSchema,
  CorrelationSchema,
  DeprovisionBayInputSchema,
  DeprovisionedBaySchema,
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
  ProvisionBayInputSchema,
  ProvisionedBaySchema,
  RefreshBayInputSchema,
  RefreshedBaySchema,
  baseIdentity,
  defaultBayBranch,
  emptyBaysState,
  isLivePR,
  prForBay,
  resolveBay,
  resolvePR,
  type Bay,
  type BaysState,
  type Correlation,
  type DeprovisionBayInput,
  type DeprovisionedBay,
  type PR,
  type PRRevision,
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
      correlation: CorrelationSchema.optional(),
    })
    .strict(),
])
export type SubmitArgs = z.infer<typeof SubmitArgsSchema>

export type SubmitSelectionOptions = Readonly<{
  base?: string
  issue?: string
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
  })
  .strict()
const PRRevisionSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    correlation: CorrelationSchema.optional(),
  })
  .strict()
const PRCorrelationBoundSchema = z
  .object({ pr: PRIdSchema, revision: RevisionSchema, correlation: CorrelationSchema })
  .strict()
const PRWithdrawnSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema.optional(),
    headSha: GitShaSchema.optional(),
    correlation: CorrelationSchema.optional(),
  })
  .strict()
const PRRejectedSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema.optional(),
    correlation: CorrelationSchema.optional(),
    detail: z.string().optional(),
  })
  .strict()
const PRIntegratedSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    correlation: CorrelationSchema.optional(),
    commit: GitShaSchema,
    baseSha: GitShaSchema,
  })
  .strict()

export const TerminalCorrelationOutcomeSchema = z.enum(["integrated", "rejected", "withdrawn"])
export type TerminalCorrelationOutcome = z.infer<typeof TerminalCorrelationOutcomeSchema>
export const TerminalCorrelationInputSchema = z
  .object({
    correlation: CorrelationSchema,
    pr: PRIdSchema,
    revision: RevisionSchema,
    branch: GitRefSchema,
    base: GitRefSchema,
    headSha: GitShaSchema,
    outcome: TerminalCorrelationOutcomeSchema,
    detail: z.string().min(1).optional(),
  })
  .strict()
export type TerminalCorrelationInput = z.infer<typeof TerminalCorrelationInputSchema>
export const CorrelationSettlementProofSchema = z
  .object({
    correlation: CorrelationSchema,
    disposition: z.enum(["settled", "already-settled"]),
  })
  .strict()
export type CorrelationSettlementProof = z.infer<typeof CorrelationSettlementProofSchema>

export type CorrelationSettlement = Readonly<{
  revision: string
  settle(
    input: TerminalCorrelationInput,
    context: JobContext,
  ): JobResult<CorrelationSettlementProof> | Promise<JobResult<CorrelationSettlementProof>>
}>
export type CorrelationSettlementJobDef = JobDef<TerminalCorrelationInput, CorrelationSettlementProof>

export function createCorrelationSettlementJobDef(settlement: CorrelationSettlement): CorrelationSettlementJobDef {
  return createJobDef({
    name: "correlation.settle",
    title: "Settle terminal correlation",
    revision: settlement.revision,
    input: TerminalCorrelationInputSchema,
    output: CorrelationSettlementProofSchema,
    async execute(input, context) {
      const result = await settlement.settle(input, context)
      if (
        result.status === "passed" &&
        (result.output.correlation.namespace !== input.correlation.namespace ||
          result.output.correlation.id !== input.correlation.id)
      ) {
        throw new Error(
          `yrd: correlation settlement returned '${result.output.correlation.namespace}:${result.output.correlation.id}', expected '${input.correlation.namespace}:${input.correlation.id}'`,
        )
      }
      return result
    },
  })
}

export function requestCorrelationSettlement(
  terminal: CorrelationSettlementJobDef | undefined,
  pr: DeepReadonly<PR>,
  outcome: TerminalCorrelationOutcome,
  detail?: string,
): EventDraft<"job/requested", JobRequest<TerminalCorrelationInput>> | undefined {
  if (pr.correlation === undefined) return undefined
  if (terminal === undefined) {
    raiseFailure(
      "configuration",
      "correlation-settlement-unavailable",
      `yrd: PR '${pr.id}' correlation '${pr.correlation.namespace}:${pr.correlation.id}' cannot advance because no correlation settlement is configured`,
    )
  }
  const correlation = pr.correlation
  return terminal.request(
    {
      correlation,
      pr: pr.id,
      revision: pr.revision,
      branch: pr.branch,
      base: pr.base,
      headSha: pr.headSha,
      outcome,
      ...(detail === undefined || detail.length === 0 ? {} : { detail }),
    },
    {
      key: [
        "correlation-settlement",
        encodeURIComponent(correlation.namespace),
        encodeURIComponent(correlation.id),
        pr.id,
        String(pr.revision),
        outcome,
      ].join(":"),
    },
  )
}

function terminalCorrelation(pr: DeepReadonly<PR>) {
  return {
    revision: pr.revision,
    headSha: pr.headSha,
    ...(pr.correlation === undefined ? {} : { correlation: pr.correlation }),
  }
}

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
  }>
}>

export type Bays = Readonly<{
  state: ReadSignal<DeepReadonly<BaysState>>
  get(selector: string): DeepReadonly<Bay> | undefined
  list(): readonly DeepReadonly<Bay>[]
  pr(selector: string): DeepReadonly<PR> | undefined
  prs(): readonly DeepReadonly<PR>[]
  open(args: OpenBayArgs): Promise<CommandResult>
  refresh(args: RefreshBayArgs): Promise<CommandResult>
  intake(args: IntakePRArgs): Promise<CommandResult>
  submit(args: SubmitArgs): Promise<CommandResult>
  submitSelection(selector: string, options: SubmitSelectionOptions): Promise<DeepReadonly<PR>>
  close(args: CloseBayArgs): Promise<CommandResult>
  closePr(args: PrCloseArgs): Promise<CommandResult>
  editPr(args: PrEditArgs): Promise<CommandResult>
}>

export type HasBays = Readonly<{ bays: Bays }>

type BayActions = Pick<Bays, "open" | "refresh" | "intake" | "submit" | "close" | "closePr" | "editPr">

export type BayBaseTarget = Readonly<{ base: string; baseSha?: string }>
export type ResolveBayBase = (base: string) => BayBaseTarget | Promise<BayBaseTarget>

export function createBays(
  state: ReadSignal<DeepReadonly<BaysState>>,
  jobs: Jobs,
  actions: BayActions,
  options: Readonly<{ defaultBase: string; resolveBase?: ResolveBayBase }>,
): Bays {
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
    const bay = args.bay === undefined ? undefined : resolveBay(state(), args.bay)
    const resolved = await target(args.base ?? bay?.base, args.baseSha ?? bay?.baseSha)
    return actions.intake({ ...args, ...resolved })
  }
  const submit = async (args: SubmitArgs): Promise<CommandResult> => {
    if ("pr" in args) return actions.submit(args)
    const resolved = await target(args.base, args.baseSha)
    return actions.submit({ ...args, ...resolved })
  }

  const submitSelection = async (selector: string, options: SubmitSelectionOptions): Promise<DeepReadonly<PR>> => {
    const sameCorrelation = (left: DeepReadonly<Correlation>, right: DeepReadonly<Correlation>): boolean =>
      left.namespace === right.namespace && left.id === right.id
    const bindCorrelation = async (pr: DeepReadonly<PR>): Promise<DeepReadonly<PR>> => {
      if (options.correlation === undefined) return pr
      if (pr.correlation !== undefined && sameCorrelation(pr.correlation, options.correlation)) return pr
      if (pr.correlation !== undefined) {
        raiseFailure(
          "refusal",
          "correlation-conflict",
          `yrd: PR '${pr.id}' revision ${pr.revision} is already bound to correlation '${pr.correlation.namespace}:${pr.correlation.id}'`,
        )
      }
      if (pr.status !== "submitted") {
        raiseFailure(
          "refusal",
          "correlation-too-late",
          `yrd: PR '${pr.id}' is ${pr.status}; correlation cannot be bound after submission`,
        )
      }
      await submit({ pr: pr.id, correlation: options.correlation })
      const bound = resolvePR(state(), pr.id)
      if (bound === undefined) {
        raiseFailure("infrastructure", "pr-state-invalid", `yrd: PR '${pr.id}' disappeared after correlation binding`)
      }
      return bound
    }

    let snapshot = state()
    let pr = resolvePR(snapshot, selector)
    let bay = resolveBay(snapshot, selector) ?? (pr?.bay === undefined ? undefined : resolveBay(snapshot, pr.bay))
    if (pr?.status === "integrated") return bindCorrelation(pr)

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

    if (pr?.status === "submitted") return bindCorrelation(pr)
    if (pr?.status === "pushed") {
      await submit({ pr: pr.id, ...(options.correlation === undefined ? {} : { correlation: options.correlation }) })
      const submitted = resolvePR(state(), pr.id)
      if (submitted === undefined) {
        raiseFailure("infrastructure", "pr-state-invalid", `yrd: PR '${pr.id}' disappeared after submit`)
      }
      return bindCorrelation(submitted)
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
        if (live.status === "submitted") return bindCorrelation(live)
        await actions.submit({
          pr: live.id,
          ...(options.correlation === undefined ? {} : { correlation: options.correlation }),
        })
        const submitted = resolvePR(state(), live.id)
        if (submitted === undefined) {
          raiseFailure("infrastructure", "pr-state-invalid", `yrd: PR '${live.id}' disappeared after submit`)
        }
        return bindCorrelation(submitted)
      }
      await actions.submit({
        branch: selector,
        headSha,
        ...resolved,
        ...(options.issue === undefined ? {} : { issue: options.issue }),
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
      return bindCorrelation(submitted)
    }

    if (bay.status !== "active") {
      raiseFailure("refusal", "bay-not-active", `yrd: bay '${bay.id}' is ${bay.status}, not active`)
    }
    if (pr === undefined) {
      raiseFailure("infrastructure", "pr-state-invalid", `yrd: bay '${bay.id}' intake did not create a PR`)
    }
    raiseFailure("refusal", "pr-not-pushed", `yrd: PR '${pr.id}' is ${pr.status}, not pushed`)
  }

  return Object.freeze({
    state,
    get: (selector) => resolveBay(state(), selector),
    list: () => Object.freeze(Object.values(state().byId)),
    pr: (selector) => resolvePR(state(), selector),
    prs: () => Object.freeze(Object.values(state().prs)),
    submitSelection,
    open,
    refresh: actions.refresh,
    intake,
    submit,
    close: actions.close,
    closePr: actions.closePr,
    editPr: actions.editPr,
  })
}

export type WithBaysOptions = Readonly<{
  jobs: BayJobDefs
  terminal?: CorrelationSettlementJobDef
  defaultBase?: string
  resolveBase?: ResolveBayBase
}>

export function withBays(options: WithBaysOptions) {
  const defaultBase = baseIdentity(options.defaultBase ?? "main")
  const commands = createBayCommands(options.jobs, defaultBase, options.terminal)

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
        "pr/integrated": PRIntegratedSchema,
        "pr/edited": PrEditArgsSchema,
      },
      project: projectBays,
      create(yrd) {
        yrd.jobs.requireDefinitions(options.jobs)
        if (options.terminal !== undefined) yrd.jobs.requireDefinitions({ [options.terminal.name]: options.terminal })
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
            },
            { defaultBase, ...(options.resolveBase === undefined ? {} : { resolveBase: options.resolveBase }) },
          ),
        }
      },
    })
}

function jobDetail(job: DeepReadonly<Job>): string {
  if (job.status === "failed") return job.error.message
  if (job.status === "lost") return job.lostReason
  if (job.status === "waiting") return job.detail ?? job.status
  return job.status
}

function createBayCommands(jobs: BayJobDefs, defaultBase: string, terminal?: CorrelationSettlementJobDef): BayCommands {
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
        apply: (state: BayState, args: SubmitArgs) => submitWork(state, args, defaultBase, terminal),
      }),
      close: command({
        title: "Close bay",
        visibility: "public",
        params: CloseBayArgsSchema,
        apply: (state: BayState, args: CloseBayArgs) => closeBay(state, args, jobs["bay.deprovision"], terminal),
      }),
    },
    pr: {
      close: command({
        title: "Close a PR",
        visibility: "public",
        params: PrCloseArgsSchema,
        apply: (state: BayState, args: PrCloseArgs) => closePr(state, args, terminal),
      }),
      edit: command({
        title: "Edit a PR",
        visibility: "public",
        params: PrEditArgsSchema,
        apply: (state: BayState, args: PrEditArgs) => editPr(state, args),
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
  if (existing?.status === "integrated" || existing?.status === "withdrawn") {
    throw new Error(`yrd: PR '${existing.id}' is ${existing.status}; start a new bay`)
  }
  const id = existing?.id ?? nextId("PR", current.prs)
  return {
    events: [
      event("pr/pushed", {
        pr: id,
        ...(bay === undefined ? {} : { bay: bay.id }),
        ...((args.name ?? bay?.name) ? { name: args.name ?? bay?.name } : {}),
        ...((args.issue ?? bay?.issue ?? existing?.issue)
          ? { issue: args.issue ?? bay?.issue ?? existing?.issue }
          : {}),
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

function submitWork(
  state: DeepReadonly<BayState>,
  args: SubmitArgs,
  defaultBase: string,
  terminal?: CorrelationSettlementJobDef,
) {
  const current = state.bays
  if (args.correlation !== undefined && terminal === undefined) {
    raiseFailure(
      "configuration",
      "correlation-settlement-unavailable",
      `yrd: correlation '${args.correlation.namespace}:${args.correlation.id}' cannot be bound because no correlation settlement is configured`,
    )
  }
  if ("pr" in args) {
    const pr = required(resolvePR(current, args.pr), "PR", args.pr)
    if (pr.status === "submitted" && args.correlation !== undefined) {
      if (pr.correlation?.namespace === args.correlation.namespace && pr.correlation.id === args.correlation.id) {
        return { events: [] }
      }
      if (pr.correlation !== undefined) {
        raiseFailure(
          "refusal",
          "correlation-conflict",
          `yrd: PR '${pr.id}' revision ${pr.revision} is already bound to correlation '${pr.correlation.namespace}:${pr.correlation.id}'`,
        )
      }
      return {
        events: [event("pr/correlation-bound", { pr: pr.id, revision: pr.revision, correlation: args.correlation })],
      }
    }
    if (pr.status !== "pushed") throw new Error(`yrd: PR '${pr.id}' is ${pr.status}, not pushed`)
    return {
      events: [
        event("pr/submitted", {
          pr: pr.id,
          revision: pr.revision,
          headSha: pr.headSha,
          ...(args.correlation === undefined ? {} : { correlation: args.correlation }),
        }),
      ],
    }
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
  const pushed = {
    pr: id,
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.issue === undefined ? {} : { issue: args.issue }),
    branch: args.branch,
    base,
    headSha: args.headSha,
    ...(args.baseSha === undefined ? {} : { baseSha: args.baseSha }),
    revision,
  }
  return {
    events: [
      event("pr/pushed", pushed),
      event("pr/submitted", {
        pr: id,
        revision,
        headSha: args.headSha,
        ...(args.correlation === undefined ? {} : { correlation: args.correlation }),
      }),
    ],
  }
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

function closeBay(
  state: DeepReadonly<BayState>,
  args: CloseBayArgs,
  deprovision: BayJobDefs["bay.deprovision"],
  terminal?: CorrelationSettlementJobDef,
) {
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
        ? [
            event("pr/withdrawn", { pr: pr.id, ...terminalCorrelation(pr) }),
            requestCorrelationSettlement(terminal, pr, "withdrawn"),
          ].filter((draft) => draft !== undefined)
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

function closePr(state: DeepReadonly<BayState>, args: PrCloseArgs, terminal?: CorrelationSettlementJobDef) {
  const pr = required(resolvePR(state.bays, args.pr), "PR", args.pr)
  if (!isLivePR(pr.status)) {
    throw new Error(`yrd: PR '${pr.id}' is ${pr.status}; only a live PR can be closed`)
  }
  return {
    events: [
      event("pr/withdrawn", { pr: pr.id, ...terminalCorrelation(pr) }),
      requestCorrelationSettlement(terminal, pr, "withdrawn"),
    ].filter((draft) => draft !== undefined),
  }
}

function editPr(state: DeepReadonly<BayState>, args: PrEditArgs) {
  const pr = required(resolvePR(state.bays, args.pr), "PR", args.pr)
  return {
    events: [
      event("pr/edited", {
        pr: pr.id,
        ...(args.issue === undefined ? {} : { issue: args.issue }),
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
              revisions: [record],
            }
          : {
              ...existing,
              ...(pushed.issue === undefined ? {} : { issue: pushed.issue }),
              base,
              status: "pushed",
              revision: pushed.revision,
              headSha: pushed.headSha,
              ...(pushed.baseSha === undefined ? {} : { baseSha: pushed.baseSha }),
              correlation: undefined,
              revisions: [...existing.revisions, record],
              submittedAt: undefined,
              rejectedAt: undefined,
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
      return patchPR(pr, {
        status: "submitted",
        submittedAt: applied.ts,
        correlation: changed.correlation,
        revisions: pr.revisions.map((revision) =>
          revision.revision === changed.revision
            ? { ...revision, ...(changed.correlation === undefined ? {} : { correlation: changed.correlation }) }
            : revision,
        ),
      })
    }
    case "pr/correlation-bound": {
      const changed = PRCorrelationBoundSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined || pr.revision !== changed.revision || pr.status !== "submitted") {
        throw new Error(`yrd: stale PR correlation binding for '${changed.pr}' revision ${changed.revision}`)
      }
      if (
        pr.correlation !== undefined &&
        (pr.correlation.namespace !== changed.correlation.namespace || pr.correlation.id !== changed.correlation.id)
      ) {
        throw new Error(`yrd: conflicting PR correlation binding for '${pr.id}' revision ${pr.revision}`)
      }
      return patchPR(pr, {
        correlation: changed.correlation,
        revisions: pr.revisions.map((revision) =>
          revision.revision === changed.revision ? { ...revision, correlation: changed.correlation } : revision,
        ),
      })
    }
    case "pr/withdrawn": {
      const changed = PRWithdrawnSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (
        pr !== undefined &&
        ((changed.revision !== undefined && changed.revision !== pr.revision) ||
          (changed.headSha !== undefined && changed.headSha !== pr.headSha) ||
          (changed.correlation !== undefined &&
            (changed.correlation.namespace !== pr.correlation?.namespace ||
              changed.correlation.id !== pr.correlation?.id)))
      ) {
        throw new Error(`yrd: stale PR withdrawal for '${changed.pr}'`)
      }
      return pr === undefined ? state : patchPR(pr, { status: "withdrawn", withdrawnAt: applied.ts })
    }
    case "pr/rejected": {
      const changed = PRRejectedSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (
        pr === undefined ||
        pr.revision !== changed.revision ||
        (changed.headSha !== undefined && changed.headSha !== pr.headSha) ||
        (changed.correlation !== undefined &&
          (changed.correlation.namespace !== pr.correlation?.namespace ||
            changed.correlation.id !== pr.correlation?.id))
      ) {
        return state
      }
      return patchPR(pr, {
        status: "rejected",
        rejectedAt: applied.ts,
        ...(changed.detail === undefined ? {} : { detail: changed.detail }),
      })
    }
    case "pr/integrated": {
      const changed = PRIntegratedSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (
        pr === undefined ||
        pr.revision !== changed.revision ||
        pr.headSha !== changed.headSha ||
        (changed.correlation !== undefined &&
          (changed.correlation.namespace !== pr.correlation?.namespace ||
            changed.correlation.id !== pr.correlation?.id))
      ) {
        return state
      }
      return patchPR(pr, {
        status: "integrated",
        integratedAt: applied.ts,
        integration: { commit: changed.commit, baseSha: changed.baseSha },
      })
    }
    case "pr/edited": {
      const changed = PrEditArgsSchema.parse(data)
      const pr = current.prs[changed.pr]
      return pr === undefined
        ? state
        : patchPR(pr, {
            ...(changed.issue === undefined ? {} : { issue: changed.issue }),
            ...(changed.note === undefined ? {} : { note: changed.note }),
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
