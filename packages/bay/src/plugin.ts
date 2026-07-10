import {
  effect,
  event,
  fx,
  op,
  type AnyYrdApp,
  type Command,
  type DeepReadonly,
  type EffectOutcome,
  type EffectRun,
  type ExtendYrdApp,
  type Fx,
  type HasEffects,
  type StateOf,
  type YrdEvent,
} from "@yrd/core"
import {
  defaultBayBranch,
  emptyBaysState,
  isLiveSubmission,
  resolveBay,
  resolveSubmission,
  submissionForBay,
  type Bay,
  type BayFailure,
  type BayId,
  type BaysState,
  type DeprovisionBayInput,
  type DeprovisionedBay,
  type ProvisionBayInput,
  type ProvisionedBay,
  type RefreshBayInput,
  type RefreshedBay,
  type Submission,
  type SubmissionId,
  type SubmissionRevision,
} from "./model.ts"

type EffectContext = { id: string; attempt: number; executor: string }

export type BayWorkspaceAdapter = {
  provision(
    input: ProvisionBayInput,
    context: EffectContext,
  ): EffectOutcome<ProvisionedBay> | Promise<EffectOutcome<ProvisionedBay>>
  refresh(
    input: RefreshBayInput,
    context: EffectContext,
  ): EffectOutcome<RefreshedBay> | Promise<EffectOutcome<RefreshedBay>>
  deprovision(
    input: DeprovisionBayInput,
    context: EffectContext,
  ): EffectOutcome<DeprovisionedBay> | Promise<EffectOutcome<DeprovisionedBay>>
}

export type WithBaysOptions = {
  workspace: BayWorkspaceAdapter
  defaultBase?: string
}

export function withBays(options: WithBaysOptions) {
  return <App extends AnyYrdApp & HasEffects>(app: App): BaysApp<App> => {
    const bay = createBayPlugin(options)
    Object.assign(app.initialState, { bays: emptyBaysState() })

    app.effectRuns.register(["bay", "provision"], bay.effects.provision)
    app.effectRuns.register(["bay", "refresh"], bay.effects.refresh)
    app.effectRuns.register(["bay", "deprovision"], bay.effects.deprovision)
    Object.assign(app.commands, { bay: bay.commands })
    Object.assign(app, { bayEffects: bay.effects })

    const project = app.project as (state: StateOf<App>, applied: YrdEvent) => StateOf<App>
    app.project = (state: StateOf<App>, applied: YrdEvent): StateOf<App> =>
      projectBays(project(state, applied), applied)
    return app as unknown as BaysApp<App>
  }
}

export type OpenBayArgs = {
  name: string
  task?: string
  actor?: string
  from?: string
  base?: string
  baseSha?: string
}

export type RefreshBayArgs = { bay: string }

export type IntakeSubmissionArgs = {
  bay?: string
  name?: string
  branch?: string
  base?: string
  headSha: string
  baseSha?: string
  receipt?: string
}

export type SubmitArgs =
  | { submission: string; branch?: never; headSha?: never; base?: never; name?: never }
  | { submission?: never; branch: string; headSha: string; base?: string; name?: string }

export type CloseBayArgs = { bay: string; withdraw?: boolean }

type BayState = { bays: BaysState }

type BayCommands = {
  bay: {
    open: Command<OpenBayArgs, BayState>
    refresh: Command<RefreshBayArgs, BayState>
    intake: Command<IntakeSubmissionArgs, BayState>
    submit: Command<SubmitArgs, BayState>
    close: Command<CloseBayArgs, BayState>
  }
}

export type BayEffects = {
  provision: Fx<ProvisionBayInput, EffectOutcome<ProvisionedBay>>
  refresh: Fx<RefreshBayInput, EffectOutcome<RefreshedBay>>
  deprovision: Fx<DeprovisionBayInput, EffectOutcome<DeprovisionedBay>>
}

export type HasBays = {
  initialState: BayState
  commands: BayCommands
  bayEffects: BayEffects
}

type BaysApp<App extends AnyYrdApp> = ExtendYrdApp<App, BayState, BayCommands> & {
  bayEffects: BayEffects
}

type BayPlugin = { commands: BayCommands["bay"]; effects: BayEffects }

function createBayPlugin(options: WithBaysOptions): BayPlugin {
  const defaultBase = options.defaultBase ?? "main"
  const effects: BayEffects = {
    provision: fx(options.workspace.provision.bind(options.workspace), { title: "Provision bay workspace" }),
    refresh: fx(options.workspace.refresh.bind(options.workspace), { title: "Refresh bay workspace" }),
    deprovision: fx(options.workspace.deprovision.bind(options.workspace), { title: "Deprovision bay workspace" }),
  }
  const commands: BayCommands["bay"] = {
    open: op((state, args) => openBay(state, args, defaultBase, effects.provision), {
      title: "Open bay",
      visibility: "public",
      args: { parse: BayArgs.open },
    }),
    refresh: op((state, args) => refreshBay(state, args, effects.refresh), {
      title: "Refresh bay",
      visibility: "public",
      args: { parse: BayArgs.refresh },
    }),
    intake: op((state, args) => intakeSubmission(state, args, defaultBase), {
      title: "Record pushed revision",
      visibility: "internal",
      args: { parse: BayArgs.intake },
    }),
    submit: op((state, args) => submitWork(state, args, defaultBase), {
      title: "Submit work",
      visibility: "public",
      args: { parse: BayArgs.submit },
    }),
    close: op((state, args) => closeBay(state, args, effects.deprovision), {
      title: "Close bay",
      visibility: "public",
      args: { parse: BayArgs.close },
    }),
  }
  return { commands, effects }
}

const BayArgs = Object.freeze({
  open: argParser<OpenBayArgs>("bay.open", {
    name: "string",
    task: "string?",
    actor: "string?",
    from: "string?",
    base: "string?",
    baseSha: "sha?",
  }),
  refresh: argParser<RefreshBayArgs>("bay.refresh", { bay: "string" }),
  intake: argParser<IntakeSubmissionArgs>(
    "bay.intake",
    {
      bay: "string?",
      name: "string?",
      branch: "string?",
      base: "string?",
      headSha: "sha",
      baseSha: "sha?",
      receipt: "string?",
    },
    (args) => {
      if (args.bay === undefined && args.branch === undefined) {
        throw new Error("yrd: bay.intake: 'bay' or 'branch' is required")
      }
      if (typeof args.receipt === "string" && !/^[0-9a-f]{64}$/u.test(args.receipt)) {
        throw new Error("yrd: bay.intake: 'receipt' must be a 64-character lowercase hex id")
      }
    },
  ),
  submit: argParser<SubmitArgs>(
    "bay.submit",
    { submission: "string?", branch: "string?", headSha: "sha?", base: "string?", name: "string?" },
    (args) => {
      if (args.submission !== undefined) {
        if (args.branch !== undefined || args.headSha !== undefined) {
          throw new Error("yrd: bay.submit: use either 'submission' or direct 'branch'+'headSha'")
        }
        delete args.base
        delete args.name
      } else if (args.branch === undefined) {
        throw new Error("yrd: bay.submit: 'submission' or 'branch' is required")
      } else if (args.headSha === undefined) {
        throw new Error("yrd: bay.submit: 'headSha' is required")
      }
    },
  ),
  close: argParser<CloseBayArgs>("bay.close", { bay: "string", withdraw: "boolean?" }, (args) => {
    if (args.withdraw !== true) delete args.withdraw
  }),
})

function openBay(
  state: DeepReadonly<BayState>,
  args: OpenBayArgs,
  defaultBase: string,
  provision: BayEffects["provision"],
) {
  const current = state.bays as BaysState
  if (Object.values(current.bays).some((bay) => bay.status !== "closed" && bay.name === args.name)) {
    throw new Error(`yrd: bay '${args.name}' is already open`)
  }
  const id = nextId("B", current.bays)
  const base = args.base ?? defaultBase
  const branch = args.from ?? defaultBayBranch(args.name)
  if (Object.values(current.bays).some((bay) => bay.status !== "closed" && bay.branch === branch)) {
    throw new Error(`yrd: branch '${branch}' is already open in another bay`)
  }
  return {
    events: [event("bay/opened", defined({ id, ...args, branch, base }))],
    effects: [
      effect(
        provision,
        defined({ bay: id, name: args.name, branch, base, baseSha: args.baseSha, from: args.from }),
        `bay:${id}:provision`,
      ),
    ],
  }
}

function refreshBay(state: DeepReadonly<BayState>, args: RefreshBayArgs, refresh: BayEffects["refresh"]) {
  const bay = required(resolveBay(state.bays as BaysState, args.bay), "bay", args.bay)
  if (bay.status !== "active") throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
  return {
    events: [],
    effects: [
      effect(
        refresh,
        defined({ bay: bay.id, path: bay.path, branch: bay.branch, base: bay.base }),
        `bay:${bay.id}:refresh`,
      ),
    ],
  }
}

function intakeSubmission(state: DeepReadonly<BayState>, args: IntakeSubmissionArgs, defaultBase: string) {
  const current = state.bays as BaysState
  const bay = args.bay === undefined ? undefined : required(resolveBay(current, args.bay), "bay", args.bay)
  if (bay !== undefined && bay.status !== "active") {
    throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
  }
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
      return { events: [], effects: [] }
    }
  }
  const existing = bay === undefined ? resolveSubmission(current, branch) : submissionForBay(current, bay.id)
  if (existing?.status === "integrated" || existing?.status === "withdrawn") {
    throw new Error(`yrd: submission '${existing.id}' is ${existing.status}; start a new bay`)
  }
  const id = existing?.id ?? nextId("PR", current.submissions)
  return {
    events: [
      event(
        "submission/pushed",
        defined({
          submission: id,
          bay: bay?.id,
          name: args.name ?? bay?.name,
          branch,
          base,
          headSha: args.headSha,
          baseSha: args.baseSha,
          receipt: args.receipt,
          revision: (existing?.revision ?? 0) + 1,
        }),
      ),
    ],
    effects: [],
  }
}

function submitWork(state: DeepReadonly<BayState>, args: SubmitArgs, defaultBase: string) {
  const current = state.bays as BaysState
  if (args.submission !== undefined) {
    const submission = required(resolveSubmission(current, args.submission), "submission", args.submission)
    if (submission.status !== "pushed") {
      throw new Error(`yrd: submission '${submission.id}' is ${submission.status}, not pushed`)
    }
    return {
      events: [
        event("submission/submitted", {
          submission: submission.id,
          revision: submission.revision,
          headSha: submission.headSha,
        }),
      ],
      effects: [],
    }
  }

  const existing = resolveSubmission(current, args.branch)
  if (existing !== undefined && isLiveSubmission(existing.status)) {
    throw new Error(`yrd: branch '${args.branch}' already has live submission '${existing.id}'`)
  }
  const id = nextId("PR", current.submissions)
  const pushed = {
    submission: id,
    ...defined({ name: args.name }),
    branch: args.branch,
    base: args.base ?? defaultBase,
    headSha: args.headSha,
    revision: 1,
  }
  return {
    events: [
      event("submission/pushed", pushed),
      event("submission/submitted", { submission: id, revision: 1, headSha: args.headSha }),
    ],
    effects: [],
  }
}

function closeBay(state: DeepReadonly<BayState>, args: CloseBayArgs, deprovision: BayEffects["deprovision"]) {
  const current = state.bays as BaysState
  const bay = required(resolveBay(current, args.bay), "bay", args.bay)
  if (bay.status === "opening" || bay.status === "closing") {
    throw new Error(`yrd: bay '${bay.id}' is ${bay.status}; wait for its workspace effect`)
  }
  if (bay.status === "closed") throw new Error(`yrd: bay '${bay.id}' is already closed`)
  const submission = submissionForBay(current, bay.id)
  if (submission !== undefined && isLiveSubmission(submission.status) && args.withdraw !== true) {
    throw new Error(
      `yrd: submission '${submission.id}' is ${submission.status}; integrate it or close with withdraw=true`,
    )
  }
  return {
    events: [
      ...(submission !== undefined && isLiveSubmission(submission.status)
        ? [event("submission/withdrawn", { submission: submission.id })]
        : []),
      event("bay/closing", { bay: bay.id }),
    ],
    effects: [
      effect(
        deprovision,
        defined({ bay: bay.id, path: bay.path, branch: bay.branch, headSha: bay.headSha }),
        `bay:${bay.id}:deprovision`,
      ),
    ],
  }
}

type BayProjectionState = BayState & { effects: { runs: Record<string, EffectRun> } }

function projectBays<State extends object>(state: State, applied: YrdEvent): State {
  const projection = state as State & BayProjectionState
  const current = projection.bays
  const update = (next: BaysState): State => (next === current ? state : { ...state, bays: next })
  const saveBay = (bay: Bay): State => update({ ...current, bays: { ...current.bays, [bay.id]: bay } })
  const patchBay = (bay: Bay, patch: Partial<Bay>): State => saveBay({ ...bay, ...patch })
  const patchSubmission = (submission: Submission, patch: Partial<Submission>): State =>
    update({
      ...current,
      submissions: { ...current.submissions, [submission.id]: { ...submission, ...patch } },
    })
  const data = applied.data as Record<string, unknown>

  switch (applied.name) {
    case "bay/opened": {
      const bay = data as unknown as Omit<Bay, "status" | "openedAt" | "refreshedAt">
      return saveBay({ ...bay, status: "opening", openedAt: applied.ts, refreshedAt: applied.ts })
    }
    case "bay/closing": {
      const bay = current.bays[data.bay as string]
      return bay === undefined ? state : patchBay(bay, { status: "closing", failure: undefined, effectId: undefined })
    }
    case "submission/pushed": {
      const id = data.submission as SubmissionId
      const existing = current.submissions[id]
      const record: SubmissionRevision = defined({
        revision: data.revision as number,
        headSha: data.headSha as string,
        base: data.base as string,
        baseSha: data.baseSha as string | undefined,
        pushedAt: applied.ts,
      })
      const submission: Submission =
        existing === undefined
          ? defined({
              id,
              bay: data.bay as BayId | undefined,
              name: data.name as string | undefined,
              branch: data.branch as string,
              base: record.base,
              status: "pushed" as const,
              revision: record.revision,
              headSha: record.headSha,
              baseSha: record.baseSha,
              revisions: [record],
            })
          : {
              ...existing,
              base: record.base,
              status: "pushed",
              revision: record.revision,
              headSha: record.headSha,
              ...(record.baseSha === undefined ? {} : { baseSha: record.baseSha }),
              revisions: [...existing.revisions, record],
              submittedAt: undefined,
              rejectedAt: undefined,
              detail: undefined,
            }
      const next = { ...current, submissions: { ...current.submissions, [submission.id]: submission } }
      return update(
        typeof data.receipt !== "string"
          ? next
          : {
              ...next,
              receipts: {
                ...next.receipts,
                [data.receipt]: defined({
                  submission: id,
                  branch: data.branch as string,
                  headSha: data.headSha as string,
                  base: data.base as string,
                  baseSha: data.baseSha as string | undefined,
                }),
              },
            },
      )
    }
    case "submission/submitted": {
      const submission = current.submissions[data.submission as string]
      if (submission === undefined) return state
      if (submission.revision !== data.revision || submission.headSha !== data.headSha) {
        throw new Error(`yrd: stale submission event for '${submission.id}'`)
      }
      return patchSubmission(submission, { status: "submitted", submittedAt: applied.ts })
    }
    case "submission/withdrawn": {
      const submission = current.submissions[data.submission as string]
      return submission === undefined
        ? state
        : patchSubmission(submission, { status: "withdrawn", withdrawnAt: applied.ts })
    }
    case "submission/rejected": {
      const submission = current.submissions[data.submission as string]
      if (submission === undefined || submission.revision !== data.revision) return state
      return patchSubmission(submission, {
        status: "rejected",
        rejectedAt: applied.ts,
        ...(data.detail === undefined ? {} : { detail: data.detail as string }),
      })
    }
    case "submission/integrated": {
      const submission = current.submissions[data.submission as string]
      if (submission === undefined || submission.revision !== data.revision || submission.headSha !== data.headSha) {
        return state
      }
      return patchSubmission(submission, {
        status: "integrated",
        integratedAt: applied.ts,
        integration: { commit: data.commit as string, baseSha: data.baseSha as string },
      })
    }
    case "effect/requested": {
      if (typeof data.effect !== "string" || !BAY_EFFECTS.includes(data.effect)) return state
      const input = data.input as { bay?: unknown }
      const bay = typeof input.bay === "string" ? current.bays[input.bay] : undefined
      return bay === undefined ? state : patchBay(bay, { effectId: data.id as string })
    }
    case "effect/finished":
    case "effect/lost": {
      const run = projection.effects.runs[data.id as string]
      if (run === undefined || !BAY_EFFECTS.includes(run.effect)) return state
      const bay = current.bays[(run.input as { bay: BayId }).bay]
      if (bay === undefined) return state
      if (run.status !== "passed") {
        return patchBay(bay, {
          status: run.effect === "bay.provision" ? "failed" : "active",
          failure: failureOf(run),
        })
      }
      if (run.effect === "bay.provision") {
        const output = run.output as ProvisionedBay
        return patchBay(bay, {
          status: "active",
          path: output.path,
          headSha: output.headSha,
          baseSha: output.baseSha,
          dirty: false,
          failure: undefined,
        })
      }
      if (run.effect === "bay.refresh") {
        const output = run.output as RefreshedBay
        return patchBay(bay, {
          status: "active",
          path: output.path,
          headSha: output.headSha,
          baseSha: output.baseSha,
          dirty: output.dirty,
          refreshedAt: applied.ts,
          failure: undefined,
        })
      }
      return patchBay(bay, { status: "closed", closedAt: applied.ts, failure: undefined })
    }
    default:
      return state
  }
}

type ArgKind = "string" | "string?" | "sha" | "sha?" | "boolean?"

function argParser<Args>(
  command: string,
  fields: Record<string, ArgKind>,
  refine?: (args: Record<string, unknown>) => void,
): (input: unknown) => Args {
  return (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error(`yrd: ${command}: arguments must be an object`)
    }
    const source = input as Record<string, unknown>
    const parsed: Record<string, unknown> = {}
    for (const [field, kind] of Object.entries(fields)) {
      const value = source[field]
      const optional = kind.endsWith("?")
      if (value === undefined && optional) continue
      if (kind === "boolean?") {
        if (typeof value !== "boolean") {
          throw new Error(`yrd: ${command}: '${field}' must be boolean`)
        }
      } else {
        if (typeof value !== "string" || value.trim() === "") {
          const detail = optional && kind === "string?" ? "must be a non-empty string" : "is required"
          throw new Error(`yrd: ${command}: '${field}' ${detail}`)
        }
        if (kind.startsWith("sha") && !/^[0-9a-f]{40,64}$/iu.test(value)) {
          throw new Error(`yrd: ${command}: '${field}' must be a full Git commit SHA`)
        }
      }
      parsed[field] = value
    }
    refine?.(parsed)
    return parsed as Args
  }
}

function defined<Value extends Record<string, unknown>>(value: Value): Value {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Value
}

function required<Value>(value: Value | undefined, kind: "bay" | "submission", selector: string): Value {
  if (value === undefined) throw new Error(`yrd: no ${kind} '${selector}'`)
  return value
}

function nextId(prefix: string, records: Record<string, unknown>): string {
  const numbers = Object.keys(records)
    .filter((id) => id.startsWith(prefix) && /^\d+$/u.test(id.slice(prefix.length)))
    .map((id) => Number(id.slice(prefix.length)))
  return `${prefix}${Math.max(0, ...numbers) + 1}`
}

function failureOf(run: EffectRun): BayFailure {
  return run.error ?? { code: "effect-lost", message: run.lostReason ?? "effect executor was lost" }
}

const BAY_EFFECTS: readonly string[] = ["bay.provision", "bay.refresh", "bay.deprovision"]
