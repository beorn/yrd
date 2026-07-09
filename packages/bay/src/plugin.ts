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
  type YrdEvent,
} from "@yrd/core"
import {
  emptyBaysState,
  defaultBayBranch,
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
  type Submission,
  type SubmissionId,
} from "./model.ts"

type EffectContext = { id: string; attempt: number; executor: string }

export type BayWorkspaceAdapter = {
  provision(
    input: ProvisionBayInput,
    context: EffectContext,
  ): EffectOutcome<ProvisionedBay> | Promise<EffectOutcome<ProvisionedBay>>
  deprovision(
    input: DeprovisionBayInput,
    context: EffectContext,
  ): EffectOutcome<DeprovisionedBay> | Promise<EffectOutcome<DeprovisionedBay>>
}

export type OpenBayArgs = {
  name: string
  task?: string
  actor?: string
  from?: string
  base?: string
}

export type RefreshBayArgs = { bay: string }

export type IntakeSubmissionArgs = {
  bay?: string
  name?: string
  branch?: string
  base?: string
  headSha: string
  baseSha?: string
}

export type SubmitArgs =
  | { submission: string; branch?: never; headSha?: never; base?: never; name?: never }
  | { submission?: never; branch: string; headSha: string; base?: string; name?: string }

export type CloseBayArgs = { bay: string; withdraw?: boolean }

type BayCommands = {
  bay: {
    open: Command<OpenBayArgs, { bays: BaysState }>
    refresh: Command<RefreshBayArgs, { bays: BaysState }>
    intake: Command<IntakeSubmissionArgs, { bays: BaysState }>
    submit: Command<SubmitArgs, { bays: BaysState }>
    close: Command<CloseBayArgs, { bays: BaysState }>
  }
}

export type BayEffects = {
  provision: Fx<ProvisionBayInput, EffectOutcome<ProvisionedBay>>
  deprovision: Fx<DeprovisionBayInput, EffectOutcome<DeprovisionedBay>>
}

export type HasBays = {
  initialState: { bays: BaysState }
  commands: BayCommands
  bayEffects: BayEffects
}

type BaysApp<App extends AnyYrdApp> = ExtendYrdApp<App, { bays: BaysState }, BayCommands> & {
  bayEffects: BayEffects
}

export type WithBaysOptions = {
  workspace: BayWorkspaceAdapter
  defaultBase?: string
}

function object(input: unknown, command: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`yrd: ${command}: arguments must be an object`)
  }
  return input as Record<string, unknown>
}

function requiredString(input: Record<string, unknown>, field: string, command: string): string {
  const value = input[field]
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`yrd: ${command}: '${field}' is required`)
  }
  return value
}

function optionalString(input: Record<string, unknown>, field: string, command: string): string | undefined {
  const value = input[field]
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`yrd: ${command}: '${field}' must be a non-empty string`)
  }
  return value
}

function commitSha(input: Record<string, unknown>, field: string, command: string): string {
  const value = requiredString(input, field, command)
  if (!/^[0-9a-f]{40,64}$/iu.test(value)) throw new Error(`yrd: ${command}: '${field}' must be a full Git commit SHA`)
  return value
}

function parseOpen(input: unknown): OpenBayArgs {
  const args = object(input, "bay.open")
  return {
    name: requiredString(args, "name", "bay.open"),
    ...(optionalString(args, "task", "bay.open") === undefined ? {} : { task: args.task as string }),
    ...(optionalString(args, "actor", "bay.open") === undefined ? {} : { actor: args.actor as string }),
    ...(optionalString(args, "from", "bay.open") === undefined ? {} : { from: args.from as string }),
    ...(optionalString(args, "base", "bay.open") === undefined ? {} : { base: args.base as string }),
  }
}

function parseRefresh(input: unknown): RefreshBayArgs {
  const args = object(input, "bay.refresh")
  return { bay: requiredString(args, "bay", "bay.refresh") }
}

function parseIntake(input: unknown): IntakeSubmissionArgs {
  const args = object(input, "bay.intake")
  const bay = optionalString(args, "bay", "bay.intake")
  const branch = optionalString(args, "branch", "bay.intake")
  if (bay === undefined && branch === undefined) throw new Error("yrd: bay.intake: 'bay' or 'branch' is required")
  return {
    ...(bay === undefined ? {} : { bay }),
    ...(optionalString(args, "name", "bay.intake") === undefined ? {} : { name: args.name as string }),
    ...(branch === undefined ? {} : { branch }),
    ...(optionalString(args, "base", "bay.intake") === undefined ? {} : { base: args.base as string }),
    headSha: commitSha(args, "headSha", "bay.intake"),
    ...(args.baseSha === undefined ? {} : { baseSha: commitSha(args, "baseSha", "bay.intake") }),
  }
}

function parseSubmit(input: unknown): SubmitArgs {
  const args = object(input, "bay.submit")
  const submission = optionalString(args, "submission", "bay.submit")
  const branch = optionalString(args, "branch", "bay.submit")
  if (submission !== undefined) {
    if (branch !== undefined || args.headSha !== undefined) {
      throw new Error("yrd: bay.submit: use either 'submission' or direct 'branch'+'headSha'")
    }
    return { submission }
  }
  if (branch === undefined) throw new Error("yrd: bay.submit: 'submission' or 'branch' is required")
  return {
    branch,
    headSha: commitSha(args, "headSha", "bay.submit"),
    ...(optionalString(args, "base", "bay.submit") === undefined ? {} : { base: args.base as string }),
    ...(optionalString(args, "name", "bay.submit") === undefined ? {} : { name: args.name as string }),
  }
}

function parseClose(input: unknown): CloseBayArgs {
  const args = object(input, "bay.close")
  if (args.withdraw !== undefined && typeof args.withdraw !== "boolean") {
    throw new Error("yrd: bay.close: 'withdraw' must be boolean")
  }
  return {
    bay: requiredString(args, "bay", "bay.close"),
    ...(args.withdraw === true ? { withdraw: true } : {}),
  }
}

function nextId(prefix: string, records: Record<string, unknown>): string {
  let largest = 0
  for (const id of Object.keys(records)) {
    const match = new RegExp(`^${prefix}(\\d+)$`, "u").exec(id)
    if (match !== null) largest = Math.max(largest, Number(match[1]))
  }
  return `${prefix}${largest + 1}`
}

function baysOf(state: unknown): BaysState {
  return (state as { bays: BaysState }).bays
}

function requiredBay(state: BaysState, selector: string): Bay {
  const bay = resolveBay(state, selector)
  if (bay === undefined) throw new Error(`yrd: no bay '${selector}'`)
  return bay
}

function requiredSubmission(state: BaysState, selector: string): Submission {
  const submission = resolveSubmission(state, selector)
  if (submission === undefined) throw new Error(`yrd: no submission '${selector}'`)
  return submission
}

function failureOf(run: EffectRun): BayFailure {
  return run.error ?? { code: "effect-lost", message: run.lostReason ?? "effect executor was lost" }
}

function replaceBay(state: BaysState, bay: Bay): BaysState {
  return { ...state, bays: { ...state.bays, [bay.id]: bay } }
}

function replaceSubmission(state: BaysState, submission: Submission): BaysState {
  return { ...state, submissions: { ...state.submissions, [submission.id]: submission } }
}

function projectBayState(state: BaysState, applied: YrdEvent, effectRuns: Record<string, EffectRun>): BaysState {
  const data = applied.data as Record<string, unknown>
  switch (applied.name) {
    case "bay/opened": {
      const bay = data as unknown as Omit<Bay, "status" | "openedAt" | "refreshedAt">
      return replaceBay(state, { ...bay, status: "opening", openedAt: applied.ts, refreshedAt: applied.ts })
    }
    case "bay/refreshed": {
      const bay = state.bays[data.bay as string]
      return bay === undefined ? state : replaceBay(state, { ...bay, refreshedAt: applied.ts })
    }
    case "bay/closing": {
      const bay = state.bays[data.bay as string]
      return bay === undefined
        ? state
        : replaceBay(state, { ...bay, status: "closing", failure: undefined, effectId: undefined })
    }
    case "submission/pushed": {
      const id = data.submission as SubmissionId
      const existing = state.submissions[id]
      const revision = data.revision as number
      const record = {
        revision,
        headSha: data.headSha as string,
        base: data.base as string,
        ...(data.baseSha === undefined ? {} : { baseSha: data.baseSha as string }),
        pushedAt: applied.ts,
      }
      const submission: Submission =
        existing === undefined
          ? {
              id,
              ...(data.bay === undefined ? {} : { bay: data.bay as BayId }),
              ...(data.name === undefined ? {} : { name: data.name as string }),
              branch: data.branch as string,
              base: data.base as string,
              status: "pushed",
              revision,
              headSha: data.headSha as string,
              ...(data.baseSha === undefined ? {} : { baseSha: data.baseSha as string }),
              revisions: [record],
            }
          : {
              ...existing,
              base: record.base,
              status: "pushed",
              revision,
              headSha: record.headSha,
              ...(record.baseSha === undefined ? {} : { baseSha: record.baseSha }),
              revisions: [...existing.revisions, record],
              submittedAt: undefined,
              rejectedAt: undefined,
              detail: undefined,
            }
      return replaceSubmission(state, submission)
    }
    case "submission/submitted": {
      const submission = state.submissions[data.submission as string]
      if (submission === undefined) return state
      if (submission.revision !== data.revision || submission.headSha !== data.headSha) {
        throw new Error(`yrd: stale submission event for '${submission.id}'`)
      }
      return replaceSubmission(state, { ...submission, status: "submitted", submittedAt: applied.ts })
    }
    case "submission/withdrawn": {
      const submission = state.submissions[data.submission as string]
      return submission === undefined
        ? state
        : replaceSubmission(state, { ...submission, status: "withdrawn", withdrawnAt: applied.ts })
    }
    case "submission/rejected": {
      const submission = state.submissions[data.submission as string]
      if (submission === undefined || submission.revision !== data.revision) return state
      return replaceSubmission(state, {
        ...submission,
        status: "rejected",
        rejectedAt: applied.ts,
        ...(data.detail === undefined ? {} : { detail: data.detail as string }),
      })
    }
    case "submission/integrated": {
      const submission = state.submissions[data.submission as string]
      if (submission === undefined || submission.revision !== data.revision || submission.headSha !== data.headSha) {
        return state
      }
      return replaceSubmission(state, {
        ...submission,
        status: "integrated",
        integratedAt: applied.ts,
        integration: { commit: data.commit as string, baseSha: data.baseSha as string },
      })
    }
    case "effect/requested": {
      if (data.effect !== "bay.provision" && data.effect !== "bay.deprovision") return state
      const input = data.input as { bay?: unknown }
      const bay = typeof input.bay === "string" ? state.bays[input.bay] : undefined
      return bay === undefined ? state : replaceBay(state, { ...bay, effectId: data.id as string })
    }
    case "effect/finished":
    case "effect/lost": {
      const run = effectRuns[data.id as string]
      if (run === undefined || (run.effect !== "bay.provision" && run.effect !== "bay.deprovision")) return state
      const input = run.input as { bay: BayId }
      const bay = state.bays[input.bay]
      if (bay === undefined) return state
      if (run.effect === "bay.provision") {
        if (run.status !== "passed") return replaceBay(state, { ...bay, status: "failed", failure: failureOf(run) })
        const output = run.output as ProvisionedBay
        return replaceBay(state, {
          ...bay,
          status: "active",
          path: output.path,
          headSha: output.headSha,
          baseSha: output.baseSha,
          failure: undefined,
        })
      }
      if (run.status !== "passed") return replaceBay(state, { ...bay, status: "active", failure: failureOf(run) })
      return replaceBay(state, { ...bay, status: "closed", closedAt: applied.ts, failure: undefined })
    }
    default:
      return state
  }
}

export function withBays(options: WithBaysOptions) {
  const defaultBase = options.defaultBase ?? "main"
  return <App extends AnyYrdApp & HasEffects>(app: App): BaysApp<App> => {
    Object.assign(app.initialState, { bays: emptyBaysState() })

    const provision = fx(options.workspace.provision.bind(options.workspace), { title: "Provision bay workspace" })
    const deprovision = fx(options.workspace.deprovision.bind(options.workspace), {
      title: "Deprovision bay workspace",
    })
    app.effectRuns.register(["bay", "provision"], provision)
    app.effectRuns.register(["bay", "deprovision"], deprovision)

    const open = op(
      (state: DeepReadonly<{ bays: BaysState }>, args: OpenBayArgs) => {
        const current = baysOf(state)
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
          events: [
            event("bay/opened", {
              id,
              name: args.name,
              branch,
              base,
              ...(args.task === undefined ? {} : { task: args.task }),
              ...(args.actor === undefined ? {} : { actor: args.actor }),
              ...(args.from === undefined ? {} : { from: args.from }),
            }),
          ],
          effects: [
            effect(
              provision,
              { bay: id, name: args.name, branch, base, ...(args.from === undefined ? {} : { from: args.from }) },
              `bay:${id}:provision`,
            ),
          ],
        }
      },
      { title: "Open bay", visibility: "public", args: { parse: parseOpen } },
    )

    const refresh = op(
      (state: DeepReadonly<{ bays: BaysState }>, args: RefreshBayArgs) => {
        const bay = requiredBay(baysOf(state), args.bay)
        if (bay.status !== "active") throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
        return { events: [event("bay/refreshed", { bay: bay.id })], effects: [] }
      },
      { title: "Refresh bay", visibility: "public", args: { parse: parseRefresh } },
    )

    const intake = op(
      (state: DeepReadonly<{ bays: BaysState }>, args: IntakeSubmissionArgs) => {
        const current = baysOf(state)
        const bay = args.bay === undefined ? undefined : requiredBay(current, args.bay)
        if (bay !== undefined && bay.status !== "active")
          throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
        const existing =
          bay === undefined ? resolveSubmission(current, args.branch!) : submissionForBay(current, bay.id)
        if (existing?.status === "integrated" || existing?.status === "withdrawn") {
          throw new Error(`yrd: submission '${existing.id}' is ${existing.status}; start a new bay`)
        }
        const id = existing?.id ?? nextId("S", current.submissions)
        const revision = (existing?.revision ?? 0) + 1
        return {
          events: [
            event("submission/pushed", {
              submission: id,
              ...(bay === undefined ? {} : { bay: bay.id }),
              ...((args.name ?? bay?.name) ? { name: args.name ?? bay?.name } : {}),
              branch: args.branch ?? bay!.branch,
              base: args.base ?? bay?.base ?? defaultBase,
              headSha: args.headSha,
              ...(args.baseSha === undefined ? {} : { baseSha: args.baseSha }),
              revision,
            }),
          ],
          effects: [],
        }
      },
      { title: "Record pushed revision", visibility: "internal", args: { parse: parseIntake } },
    )

    const submit = op(
      (state: DeepReadonly<{ bays: BaysState }>, args: SubmitArgs) => {
        const current = baysOf(state)
        if ("submission" in args && args.submission !== undefined) {
          const submission = requiredSubmission(current, args.submission)
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

        const id = nextId("S", current.submissions)
        const base = args.base ?? defaultBase
        const existing = resolveSubmission(current, args.branch)
        if (existing !== undefined && isLiveSubmission(existing.status)) {
          throw new Error(`yrd: branch '${args.branch}' already has live submission '${existing.id}'`)
        }
        return {
          events: [
            event("submission/pushed", {
              submission: id,
              ...(args.name === undefined ? {} : { name: args.name }),
              branch: args.branch,
              base,
              headSha: args.headSha,
              revision: 1,
            }),
            event("submission/submitted", { submission: id, revision: 1, headSha: args.headSha }),
          ],
          effects: [],
        }
      },
      { title: "Submit work", visibility: "public", args: { parse: parseSubmit } },
    )

    const close = op(
      (state: DeepReadonly<{ bays: BaysState }>, args: CloseBayArgs) => {
        const current = baysOf(state)
        const bay = requiredBay(current, args.bay)
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
        const events = [
          ...(submission !== undefined && isLiveSubmission(submission.status)
            ? [event("submission/withdrawn", { submission: submission.id })]
            : []),
          event("bay/closing", { bay: bay.id }),
        ]
        return {
          events,
          effects: [
            effect(
              deprovision,
              {
                bay: bay.id,
                ...(bay.path === undefined ? {} : { path: bay.path }),
                branch: bay.branch,
                ...(bay.headSha === undefined ? {} : { headSha: bay.headSha }),
              },
              `bay:${bay.id}:deprovision`,
            ),
          ],
        }
      },
      { title: "Close bay", visibility: "public", args: { parse: parseClose } },
    )

    Object.assign(app.commands, { bay: { open, refresh, intake, submit, close } })
    Object.assign(app, { bayEffects: { provision, deprovision } })

    const project = app.project
    app.project = (state, applied) => {
      const projected = project(state, applied)
      const current = baysOf(projected)
      const effectRuns = (projected as { effects: { runs: Record<string, EffectRun> } }).effects.runs
      const next = projectBayState(current, applied, effectRuns)
      return next === current ? projected : { ...projected, bays: next }
    }

    return app as unknown as BaysApp<App>
  }
}
