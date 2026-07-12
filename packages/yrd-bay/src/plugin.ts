import {
  command,
  event,
  raiseFailure,
  type CommandHandler,
  type CommandResult,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type YrdDef,
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
import * as z from "zod"
import {
  BayIdSchema,
  DeprovisionBayInputSchema,
  DeprovisionedBaySchema,
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
  ProvisionBayInputSchema,
  ProvisionedBaySchema,
  RefreshBayInputSchema,
  RefreshedBaySchema,
  defaultBayBranch,
  emptyBaysState,
  isLivePR,
  prForBay,
  resolveBay,
  resolvePR,
  type Bay,
  type BaysState,
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
    task: TextSchema.optional(),
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
  z.object({ pr: TextSchema }).strict(),
  z
    .object({
      branch: GitRefSchema,
      headSha: GitShaSchema,
      base: GitRefSchema.optional(),
      baseSha: GitShaSchema.optional(),
      name: TextSchema.optional(),
    })
    .strict(),
])
export type SubmitArgs = z.infer<typeof SubmitArgsSchema>

export type SubmitSelectionOptions = Readonly<{
  base?: string
  resolveRevision(ref: string): Promise<string | undefined>
  run: RunJobOptions
}>

const CloseBayArgsSchema = z.object({ bay: TextSchema, withdraw: z.boolean().optional() }).strict()
export type CloseBayArgs = z.infer<typeof CloseBayArgsSchema>

const BayOpenedSchema = z
  .object({
    id: BayIdSchema,
    name: TextSchema,
    task: TextSchema.optional(),
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
const PRRevisionSchema = z.object({ pr: PRIdSchema, revision: RevisionSchema, headSha: GitShaSchema }).strict()
const PRRejectedSchema = z.object({ pr: PRIdSchema, revision: RevisionSchema, detail: z.string().optional() }).strict()
const PRIntegratedSchema = z
  .object({
    pr: PRIdSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    commit: GitShaSchema,
    baseSha: GitShaSchema,
  })
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
    intake: CommandHandler<IntakePRArgs, BayState>
    submit: CommandHandler<SubmitArgs, BayState>
    close: CommandHandler<CloseBayArgs, BayState>
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
}>

export type HasBays = Readonly<{ bays: Bays }>

type BayActions = Pick<Bays, "open" | "refresh" | "intake" | "submit" | "close">

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
    const resolved =
      options.resolveBase === undefined
        ? { base: base ?? options.defaultBase, ...(baseSha === undefined ? {} : { baseSha }) }
        : await options.resolveBase(base ?? options.defaultBase)
    if (baseSha !== undefined && resolved.baseSha !== undefined && baseSha !== resolved.baseSha) {
      raiseFailure(
        "refusal",
        "line-base-moved",
        `yrd: line '${resolved.base}' resolved to ${resolved.baseSha.slice(0, 12)}, not pinned ${baseSha.slice(0, 12)}`,
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
    let snapshot = state()
    let pr = resolvePR(snapshot, selector)
    let bay = resolveBay(snapshot, selector) ?? (pr?.bay === undefined ? undefined : resolveBay(snapshot, pr.bay))
    if (pr?.status === "integrated") return pr

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

    if (pr?.status === "submitted") return pr
    if (pr?.status === "pushed") {
      await submit({ pr: pr.id })
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
      await submit({
        branch: selector,
        headSha,
        ...(options.base === undefined ? {} : { base: options.base }),
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
  })
}

export type WithBaysOptions = Readonly<{
  jobs: BayJobDefs
  defaultBase?: string
  resolveBase?: ResolveBayBase
}>

export function withBays(options: WithBaysOptions) {
  const defaultBase = options.defaultBase ?? "main"
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
        "pr/withdrawn": z.object({ pr: PRIdSchema }).strict(),
        "pr/rejected": PRRejectedSchema,
        "pr/integrated": PRIntegratedSchema,
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
  const base = args.base ?? defaultBase
  const branch = args.from ?? defaultBayBranch(args.name)
  if (Object.values(current.byId).some((bay) => bay.status !== "closed" && bay.branch === branch)) {
    throw new Error(`yrd: branch '${branch}' is already open in another bay`)
  }
  const opened = {
    id,
    name: args.name,
    ...(args.task === undefined ? {} : { task: args.task }),
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
  const base = args.base ?? bay?.base ?? defaultBase
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
    if (pr.status !== "pushed") throw new Error(`yrd: PR '${pr.id}' is ${pr.status}, not pushed`)
    return { events: [event("pr/submitted", { pr: pr.id, revision: pr.revision, headSha: pr.headSha })] }
  }

  const base = args.base ?? defaultBase
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
    branch: args.branch,
    base,
    headSha: args.headSha,
    ...(args.baseSha === undefined ? {} : { baseSha: args.baseSha }),
    revision,
  }
  return {
    events: [event("pr/pushed", pushed), event("pr/submitted", { pr: id, revision, headSha: args.headSha })],
  }
}

function refuseDuplicatePayload(state: DeepReadonly<BaysState>, headSha: string, base: string, except?: string): void {
  const duplicate = Object.values(state.prs).find(
    (pr) => pr.id !== except && pr.headSha === headSha && pr.base === base,
  )
  if (duplicate !== undefined) {
    throw new Error(`yrd: payload already recorded as PR '${duplicate.id}' on line '${base}'`)
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
    throw new Error(`yrd: PR '${pr.id}' is ${pr.status}; integrate it or close with withdraw=true`)
  }
  return {
    events: [
      ...(pr !== undefined && isLivePR(pr.status) ? [event("pr/withdrawn", { pr: pr.id })] : []),
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
      return saveBay({ ...opened, status: "opening", openedAt: applied.ts, refreshedAt: applied.ts })
    }
    case "bay/closing": {
      const bay = current.byId[data.bay as string]
      return bay === undefined ? state : patchBay(bay, { status: "closing", failure: undefined })
    }
    case "pr/pushed": {
      const pushed = PRPushedSchema.parse(data)
      const existing = current.prs[pushed.pr]
      const record: PRRevision = {
        revision: pushed.revision,
        headSha: pushed.headSha,
        base: pushed.base,
        ...(pushed.baseSha === undefined ? {} : { baseSha: pushed.baseSha }),
        pushedAt: applied.ts,
      }
      const pr: PR =
        existing === undefined
          ? {
              id: pushed.pr,
              ...(pushed.bay === undefined ? {} : { bay: pushed.bay }),
              ...(pushed.name === undefined ? {} : { name: pushed.name }),
              branch: pushed.branch,
              base: pushed.base,
              status: "pushed",
              revision: pushed.revision,
              headSha: pushed.headSha,
              ...(pushed.baseSha === undefined ? {} : { baseSha: pushed.baseSha }),
              revisions: [record],
            }
          : {
              ...existing,
              base: pushed.base,
              status: "pushed",
              revision: pushed.revision,
              headSha: pushed.headSha,
              ...(pushed.baseSha === undefined ? {} : { baseSha: pushed.baseSha }),
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
                  base: pushed.base,
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
      return patchPR(pr, { status: "submitted", submittedAt: applied.ts })
    }
    case "pr/withdrawn": {
      const pr = current.prs[data.pr as string]
      return pr === undefined ? state : patchPR(pr, { status: "withdrawn", withdrawnAt: applied.ts })
    }
    case "pr/rejected": {
      const changed = PRRejectedSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined || pr.revision !== changed.revision) return state
      return patchPR(pr, {
        status: "rejected",
        rejectedAt: applied.ts,
        ...(changed.detail === undefined ? {} : { detail: changed.detail }),
      })
    }
    case "pr/integrated": {
      const changed = PRIntegratedSchema.parse(data)
      const pr = current.prs[changed.pr]
      if (pr === undefined || pr.revision !== changed.revision || pr.headSha !== changed.headSha) return state
      return patchPR(pr, {
        status: "integrated",
        integratedAt: applied.ts,
        integration: { commit: changed.commit, baseSha: changed.baseSha },
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
