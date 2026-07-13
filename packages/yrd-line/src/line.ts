import {
  GitRefSchema,
  PRIdSchema,
  checkRequest,
  checksRequested,
  resolvePR,
  reviewState,
  type BaysState,
  type HasBays,
  type PR,
} from "@yrd/bay"
import {
  command,
  event,
  JsonSchema,
  raiseFailure,
  type CommandHandler,
  type CommandResult,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type EventDraft,
  type JsonValue,
  type YrdDef,
} from "@yrd/core"
import {
  createJobDef,
  Job,
  type HasJobs,
  type JobDef,
  type JobDefs,
  type JobError,
  type JobHandler,
  type JobResult,
  type JobWaiting,
  type JobsState,
  type RunJobOptions,
} from "@yrd/job"
import { computed, type ReadSignal } from "@silvery/signals"
import type { ConditionalLogger } from "loggily"
import * as z from "zod"
import {
  IntegrationProofSchema,
  LineHoldSchema,
  LineRecordSchema,
  Lines,
  PRSnapshotSchema,
  type AddStepResult,
  type BatchConfig,
  type InstalledStep,
  type IntegratedShape,
  type IntegrationProof,
  type LineAuditFinding,
  type LineAuditResult,
  type LineHold,
  type LineRecord,
  type LineRequirement,
  type LineRun,
  type LineRunId,
  type LineSummary,
  type LinesState,
  type PREligibility,
  type PRCheckRecord,
  type LineStep,
  type PRShape,
  type PRSnapshot,
} from "./model.ts"

const StepNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/iu)
const LineRequirementSchema = z.enum(["review"])
const LineRunIdSchema = z.string().trim().min(1)
const StepExecutionSchema = z
  .object({
    run: LineRunIdSchema,
    step: StepNameSchema,
    index: z.number().int().nonnegative(),
    prs: z.array(PRSnapshotSchema).min(1),
    targetSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/iu)
      .optional(),
    shape: JsonSchema,
  })
  .strict() as unknown as z.ZodType<StepExecution>

const IntegrateArgsSchema = z
  .object({
    prs: z.array(z.string().trim().min(1)).optional(),
    steps: z.array(StepNameSchema).optional(),
    retry: z.boolean().optional(),
  })
  .strict()
export type IntegrateArgs = Readonly<z.infer<typeof IntegrateArgsSchema>>

const AdmitArgsSchema = z.object({ pr: z.string().trim().min(1), retry: z.boolean().optional() }).strict()
export type AdmitArgs = Readonly<z.infer<typeof AdmitArgsSchema>>
export type AdmitSelection = Readonly<{ prs?: readonly string[]; retry?: boolean }>

const AdvanceArgsSchema = z.object({ run: LineRunIdSchema }).strict()
const IsolateArgsSchema = AdvanceArgsSchema.extend({ part: z.union([z.literal(0), z.literal(1)]) }).strict()
export type HoldLineArgs = Readonly<{ base: string; reason: string; allowedPRs: readonly string[] }>
const HoldLineArgsSchema = z
  .object({
    base: GitRefSchema,
    reason: z.string().trim().min(1),
    allowedPRs: z.array(PRIdSchema),
  })
  .strict()
  .superRefine((args, context) => {
    if (new Set(args.allowedPRs).size !== args.allowedPRs.length) {
      context.addIssue({ code: "custom", message: "duplicate allowed PR", path: ["allowedPRs"] })
    }
  }) as z.ZodType<HoldLineArgs>
const ReleaseLineArgsSchema = z.object({ base: GitRefSchema }).strict()
const LineStartSchema = LineRecordSchema.omit({ startedAt: true, failure: true })
const LineFailedSchema = z
  .object({ run: LineRunIdSchema, error: z.object({ code: z.string(), message: z.string() }) })
  .strict()

export type StepExecution<Shape extends PRShape = PRShape> = Readonly<{
  run: LineRunId
  step: string
  index: number
  prs: readonly PRSnapshot[]
  targetSha?: string
  shape: Shape
}>

export type StepRunner<Shape extends PRShape, Output extends JsonValue> = JobHandler<StepExecution<Shape>, Output>

declare const inputShape: unique symbol
declare const outputShape: unique symbol

export type StepDef<Input extends PRShape, Output extends PRShape> = Readonly<{
  name: string
  title: string
  revision: string
  integrates: boolean
  needsIntegration: boolean
  classification?: "base" | "carrier"
  job: JobDef<StepExecution, JsonValue>
  readonly [inputShape]?: Input
  readonly [outputShape]?: Output
}>

type AnyStepDef = StepDef<PRShape, PRShape>
type InputOf<Step> = Step extends StepDef<infer Input, infer _Output> ? Input : never
type OutputOf<Step> = Step extends StepDef<infer _Input, infer Output> ? Output : never
type ValidateStepChain<Steps extends readonly AnyStepDef[], Shape extends PRShape = PRShape> = Steps extends readonly [
  infer First extends AnyStepDef,
  ...infer Rest extends readonly AnyStepDef[],
]
  ? Shape extends InputOf<First>
    ? ValidateStepChain<Rest, OutputOf<First>>
    : Readonly<{ "yrd: incompatible line step input": never }>
  : object
type FinalShape<Steps extends readonly AnyStepDef[], Shape extends PRShape = PRShape> = Steps extends readonly [
  infer First extends AnyStepDef,
  ...infer Rest extends readonly AnyStepDef[],
]
  ? FinalShape<Rest, OutputOf<First>>
  : Shape

export type StepOptions<Output extends JsonValue> = Readonly<{
  revision: string
  title?: string
  needsIntegration?: boolean
  classification?: "base" | "carrier"
  output?: z.ZodType<Output>
}>

export function withStep<const Name extends string, Shape extends PRShape, Output extends JsonValue>(
  name: Name,
  runner: StepRunner<Shape, Output>,
  options: StepOptions<Output>,
): StepDef<Shape, AddStepResult<Shape, Name, Output>> {
  const stepName = StepNameSchema.parse(name)
  const output = options.output ?? (JsonSchema as z.ZodType<Output>)
  const job = createJobDef({
    name: `line.step.${stepName}`,
    title: options.title ?? stepName,
    revision: options.revision,
    input: StepExecutionSchema,
    output,
    execute: (input, context) => runner(input as StepExecution<Shape>, context),
  }) as JobDef<StepExecution, JsonValue>
  return Object.freeze({
    name: stepName,
    title: job.title,
    revision: job.revision,
    integrates: false,
    needsIntegration: options.needsIntegration ?? false,
    ...(options.classification === undefined ? {} : { classification: options.classification }),
    job,
  }) as StepDef<Shape, AddStepResult<Shape, Name, Output>>
}

export function withMerge<Shape extends PRShape>(
  runner: StepRunner<Shape, IntegrationProof>,
  options: Readonly<{ revision: string; title?: string }>,
): StepDef<Shape, Shape & IntegratedShape> {
  const job = createJobDef({
    name: "line.step.merge",
    title: options.title ?? "merge",
    revision: options.revision,
    input: StepExecutionSchema,
    output: IntegrationProofSchema,
    execute: (input, context) => runner(input as StepExecution<Shape>, context),
  }) as JobDef<StepExecution, JsonValue>
  return Object.freeze({
    name: "merge",
    title: job.title,
    revision: job.revision,
    integrates: true,
    needsIntegration: false,
    job,
  }) as StepDef<Shape, Shape & IntegratedShape>
}

export type LineOptions<Steps extends readonly AnyStepDef[]> = Readonly<{
  steps: Steps
  batch?: BatchConfig
  defaultSteps?: readonly string[]
  requires?: readonly LineRequirement[]
  resolveBaseSha?(base: string): string | Promise<string>
}>

type LineState = Readonly<{ lines: LinesState }>
type LineHostState = Readonly<{ bays: BaysState; jobs: JobsState }>
type RuntimeState = LineHostState & LineState
type LineStart = Omit<LineRecord, "startedAt" | "failure">

export type LineCommands = Readonly<{
  line: Readonly<{
    admit: CommandHandler<AdmitArgs, RuntimeState>
    integrate: CommandHandler<IntegrateArgs, RuntimeState>
    hold: CommandHandler<HoldLineArgs, RuntimeState>
    release: CommandHandler<Readonly<{ base: string }>, RuntimeState>
    advance: CommandHandler<Readonly<{ run: LineRunId }>, RuntimeState>
    isolate: CommandHandler<Readonly<{ run: LineRunId; part: 0 | 1 }>, RuntimeState>
  }>
}>

export type Line<Shape extends PRShape = PRShape> = Readonly<{
  readonly shape?: Shape
  state: ReadSignal<DeepReadonly<LinesState>>
  steps(): readonly InstalledStep[]
  admit(args: AdmitSelection, options?: RunJobOptions): Promise<readonly LineRun[]>
  hold(args: HoldLineArgs): Promise<LineHold>
  release(base: string): Promise<void>
  integrate(args: IntegrateArgs, options: RunJobOptions): Promise<readonly LineRun[]>
  run(run: LineRunId, options: RunJobOptions): Promise<LineRun>
  waiting(selector: string, step?: string): WaitingLineStep
  finish(selector: string, completion: FinishLineArgs, options: RunJobOptions): Promise<LineRun>
  recover(options: RunJobOptions & Readonly<{ recoveryTime: string; reason?: string }>): Promise<readonly LineRun[]>
  audit(): LineAuditResult
  eligibility(selector: string): PREligibility
  eligibilities(): readonly PREligibility[]
  checks(selectors?: readonly string[]): readonly PRCheckRecord[]
  get(run: LineRunId): LineRun | undefined
  status(base: string): LineSummary
}>

export type WaitingLineStep = Readonly<{
  run: LineRun
  step: LineStep & Readonly<{ job: Extract<Job, { status: "waiting" }> }>
}>

export type FinishLineArgs = Readonly<{
  step?: string
  token?: string
  result: Exclude<JobResult, JobWaiting>
}>

export type HasLine<Shape extends PRShape = PRShape> = Readonly<{ line: Line<Shape> }>

export type LinePlugin<Shape extends PRShape> = (<
  State extends object,
  Commands extends CommandTree,
  Features extends HasJobs & HasBays,
>(
  definition: YrdDef<State, Commands, Features>,
) => YrdDef<State & LineState, Commands & LineCommands, Features & HasLine<Shape>>) &
  Readonly<{ jobDefs: JobDefs }>

export function withLine<const Steps extends readonly AnyStepDef[]>(
  options: LineOptions<Steps> & ValidateStepChain<Steps>,
): LinePlugin<FinalShape<Steps>> {
  const steps = installSteps(options.steps)
  const byName = new Map(steps.map((step) => [step.name, step] as const))
  const batchSize = normalizeBatch(options.batch ?? 1)
  const defaults = options.defaultSteps === undefined ? undefined : selectSteps(steps, options.defaultSteps)
  validateSequence(defaults ?? steps, false)
  const initial = Lines.empty({
    batchSize,
    ...(defaults === undefined ? {} : { defaultSteps: defaults.map((step) => step.name) }),
    ...(options.requires === undefined ? {} : { requires: z.array(LineRequirementSchema).parse(options.requires) }),
  })
  const jobDefs = Object.freeze(Object.fromEntries(steps.map((step) => [step.job.name, step.job])))
  const commands = createLineCommands(steps, byName)

  const install = <State extends object, Commands extends CommandTree, Features extends HasJobs & HasBays>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { lines: initial },
      commands,
      events: {
        "line/run/started": z.object({ run: LineStartSchema }).strict(),
        "line/run/failed": LineFailedSchema,
        "line/held": HoldLineArgsSchema,
        "line/released": ReleaseLineArgsSchema,
        "line/batch/isolated": z
          .object({
            parent: LineRunIdSchema,
            run: LineRunIdSchema,
            part: z.union([z.literal(0), z.literal(1)]),
            prs: z.array(z.string().trim().min(1)).min(1),
          })
          .strict(),
      },
      project: projectLines,
      create(yrd) {
        yrd.jobs.requireDefinitions(jobDefs)
        return {
          line: createLine(
            computed(() => yrd.state().lines),
            () => yrd.state() as unknown as DeepReadonly<RuntimeState>,
            yrd.jobs,
            {
              refresh: () => yrd.refresh(),
              admit: (args) => yrd.dispatch(commands.line.admit, args),
              integrate: (args) => yrd.dispatch(commands.line.integrate, args),
              hold: (args) => yrd.dispatch(commands.line.hold, args),
              release: (base) => yrd.dispatch(commands.line.release, { base }),
              advance: (run) => yrd.dispatch(commands.line.advance, { run }),
              isolate: (run, part) => yrd.dispatch(commands.line.isolate, { run, part }),
              requestChecks: (pr, baseSha) =>
                yrd.bays.requestChecks({ pr, ...(baseSha === undefined ? {} : { baseSha }) }),
            },
            steps,
            options.resolveBaseSha,
            yrd.log.child("line"),
          ),
        }
      },
    })

  Object.defineProperty(install, "jobDefs", { value: jobDefs, enumerable: true })
  return Object.freeze(install) as unknown as LinePlugin<FinalShape<Steps>>
}

type RuntimeStep = AnyStepDef
type LineActions = Readonly<{
  refresh(): Promise<unknown>
  admit(args: AdmitArgs): Promise<CommandResult>
  integrate(args: IntegrateArgs): Promise<CommandResult>
  hold(args: HoldLineArgs): Promise<CommandResult>
  release(base: string): Promise<CommandResult>
  advance(run: LineRunId): Promise<CommandResult>
  isolate(run: LineRunId, part: 0 | 1): Promise<CommandResult>
  requestChecks(pr: string, baseSha?: string): Promise<CommandResult>
}>

function createLine<Shape extends PRShape>(
  state: ReadSignal<DeepReadonly<LinesState>>,
  runtime: () => DeepReadonly<RuntimeState>,
  jobs: HasJobs["jobs"],
  actions: LineActions,
  steps: readonly RuntimeStep[],
  resolveBaseSha: LineOptions<readonly AnyStepDef[]>["resolveBaseSha"],
  log: ConditionalLogger,
): Line<Shape> {
  const current = (id: LineRunId): LineRun => materializeRun(Lines.record(state(), id), runtime().jobs)

  const waiting = (selector: string, stepName?: string): WaitingLineStep => {
    const snapshot = runtime()
    const direct = snapshot.lines.records[selector]
    let selected = direct === undefined ? undefined : materializeRun(direct, snapshot.jobs)
    if (selected === undefined) {
      const pr = resolvePR(snapshot.bays, selector)
      if (pr === undefined) {
        raiseFailure("refusal", "line-selection-missing", `yrd: no line run or PR '${selector}'`)
      }
      const summary = lineSummary(snapshot.lines, snapshot.jobs, pr.base)
      selected = [...summary.waiting, ...summary.running]
        .toReversed()
        .find(
          (candidate) =>
            candidate.prs.some((member) => member.id === pr.id) &&
            candidate.steps.some((step) =>
              stepName === undefined ? step.job?.status === "waiting" : step.name === stepName,
            ),
        )
      if (selected === undefined) {
        raiseFailure(
          "refusal",
          "line-step-not-waiting",
          `yrd: PR '${pr.id}' has no waiting${stepName === undefined ? "" : ` '${stepName}'`} step`,
        )
      }
    }

    const pending = selected.steps.filter((step) => step.job?.status === "waiting")
    const step =
      stepName === undefined
        ? pending.length === 1
          ? pending[0]
          : undefined
        : selected.steps.find((item) => item.name === stepName)
    if (stepName === undefined && pending.length !== 1) {
      raiseFailure(
        "refusal",
        pending.length === 0 ? "line-step-not-waiting" : "line-step-ambiguous",
        `yrd: line run '${selected.id}' ${pending.length === 0 ? "has no waiting step" : "has multiple waiting steps; select one"}`,
      )
    }
    if (step?.job?.status !== "waiting") {
      raiseFailure(
        "refusal",
        "line-step-not-waiting",
        `yrd: line run '${selected.id}' has no waiting '${stepName ?? "unknown"}' step`,
      )
    }
    return { run: selected, step: step as WaitingLineStep["step"] }
  }

  const drive = async (id: LineRunId, options: RunJobOptions): Promise<LineRun> => {
    while (true) {
      const snapshot = runtime()
      const run = materializeRun(Lines.record(snapshot.lines, id), snapshot.jobs)
      if (Lines.terminal(run) && !needsAdvance(snapshot, run)) return run
      const active = run.steps[run.cursor]
      if (active?.job?.status === "requested") {
        const guarded = await actions.advance(id)
        if (guarded.events.length > 0) continue
        await jobs.run(active.job.id, options)
        continue
      }
      if (active?.job?.status === "running" || active?.job?.status === "waiting") return run
      const advanced = await actions.advance(id)
      if (advanced.events.length === 0) return current(id)
    }
  }

  const run = async (id: LineRunId, options: RunJobOptions): Promise<LineRun> => {
    using _span = log.span?.("run", { id })
    const settled = await drive(id, options)
    if (!bisectable(settled)) return settled
    for (const part of [0, 1] as const) {
      let snapshot = runtime()
      let child = childLine(snapshot.lines, snapshot.jobs, settled.id, part)
      if (child === undefined) {
        await actions.isolate(settled.id, part)
        snapshot = runtime()
        child = childLine(snapshot.lines, snapshot.jobs, settled.id, part)
      }
      if (child === undefined) throw new Error(`yrd: line run '${settled.id}' did not create isolation part ${part}`)
      await run(child.id, options)
    }
    return current(id)
  }

  const startedRun = (result: CommandResult): LineRun | undefined => {
    const started = result.events.find((applied) => applied.name === "line/run/started")
    if (started === undefined) return undefined
    return current(LineStartSchema.parse((started.data as { run?: unknown }).run).id)
  }

  const refreshCheckIdentities = async (prs: readonly DeepReadonly<PR>[]): Promise<void> => {
    if (resolveBaseSha === undefined) return
    for (const pr of prs) {
      if (!checksRequested(pr)) continue
      await actions.requestChecks(pr.id, await resolveBaseSha(pr.base))
    }
  }

  const dispatchAdmissions = async (selectors: readonly string[], retry: boolean): Promise<LineRun[]> => {
    const admitted: LineRun[] = []
    for (const selector of selectors) {
      const started = startedRun(await actions.admit({ pr: selector, ...(retry ? { retry: true } : {}) }))
      if (started !== undefined) admitted.push(started)
    }
    return admitted
  }

  const drainAdmissions = async (
    selectors: readonly string[],
    retry: boolean,
    options: RunJobOptions,
  ): Promise<LineRun[]> => {
    const targets = new Set(selectors)
    const outcomes = new Map<LineRunId, LineRun>()
    const remember = (candidate: LineRun): void => {
      if (candidate.prs.some((pr) => targets.has(pr.id))) outcomes.set(candidate.id, candidate)
    }

    while (targets.size > 0) {
      await actions.refresh()
      let snapshot = runtime()
      const active = orderedLines(snapshot.lines, snapshot.jobs).find(
        (candidate) =>
          candidate.status === "running" && samePlan(candidate.steps, admissionSteps(snapshot.lines, steps)),
      )
      if (active !== undefined) {
        const settled = await run(active.id, options)
        remember(settled)
        if (settled.status === "running") break
        continue
      }

      const retryable = [...targets]
        .map((selector) => resolvePR(snapshot.bays, selector))
        .find((pr) => pr !== undefined && checkEligibility(snapshot, pr, steps).status === "failed")
      if (retry && retryable !== undefined) {
        const admitted = await dispatchAdmissions([retryable.id], true)
        if (admitted.length > 0) continue
      }

      snapshot = runtime()
      const queued = admissionQueue(snapshot, steps)
      const admitted = await dispatchAdmissions(
        queued.map((pr) => pr.id),
        false,
      )
      if (admitted.length > 0) continue

      for (const selector of targets) {
        const pr = resolvePR(snapshot.bays, selector)
        if (pr === undefined) continue
        const runId = checkEligibility(snapshot, pr, steps).run
        if (runId !== undefined) {
          const candidate = materializeRun(Lines.record(snapshot.lines, runId), snapshot.jobs)
          remember(candidate)
        }
      }
      break
    }
    return [...outcomes.values()].toSorted((left, right) =>
      left.id.localeCompare(right.id, undefined, { numeric: true }),
    )
  }

  return Object.freeze({
    state,
    steps: () => steps.map(descriptor),
    async admit(args, runOptions) {
      using _span = log.span?.("admit", { prs: args.prs, retry: args.retry === true })
      await actions.refresh()
      let snapshot = runtime()
      const selected =
        args.prs === undefined || args.prs.length === 0
          ? admissionQueue(snapshot, steps)
          : args.prs.map((selector) => {
              const pr = resolvePR(snapshot.bays, selector)
              if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${selector}'`)
              return pr
            })
      await refreshCheckIdentities(selected)
      snapshot = runtime()
      const selectors =
        args.prs === undefined || args.prs.length === 0
          ? admissionQueue(snapshot, steps).map((pr) => pr.id)
          : [...args.prs]
      return runOptions === undefined
        ? dispatchAdmissions(selectors, args.retry === true)
        : drainAdmissions(selectors, args.retry === true, runOptions)
    },
    async hold(args) {
      await actions.hold(args)
      const held = state().holds[args.base]
      if (held === undefined) throw new Error(`yrd: line '${args.base}' did not retain its hold`)
      return held
    },
    async release(base) {
      await actions.release(base)
    },
    async integrate(args, runOptions) {
      using _span = log.span?.("integrate", { prs: args.prs, steps: args.steps, retry: args.retry === true })
      if (args.steps?.length === 0) return []
      await actions.refresh()
      let snapshot = runtime()
      const requested = requestedPRs(snapshot.bays, args)
      const checked = requested.filter((pr) => checksRequested(pr))
      const before = new Map(checked.map((pr) => [pr.id, checkEligibility(snapshot, pr, steps).status]))
      await refreshCheckIdentities(checked)
      const admissions = await drainAdmissions(
        checked.map((pr) => pr.id),
        args.retry === true,
        runOptions,
      )
      snapshot = runtime()
      const unsettled = checked.filter((pr) => checkEligibility(snapshot, pr, steps).status !== "passed")
      if (unsettled.length > 0) {
        if (args.retry === true) return admissions
        const newlyFailed = unsettled.some(
          (pr) => before.get(pr.id) !== "failed" && checkEligibility(snapshot, pr, steps).status === "failed",
        )
        if (newlyFailed || unsettled.some((pr) => checkEligibility(snapshot, pr, steps).status !== "failed")) {
          return admissions
        }
      }
      const prs = runnablePRs(snapshot, args, steps)
      if (prs.length === 0) return []
      const roots: LineRunId[] = []
      for (const candidate of partitionCandidates(prs, snapshot.lines.batchSize)) {
        const started = await actions.integrate({
          prs: candidate.map((pr) => pr.id),
          ...(args.steps === undefined ? {} : { steps: args.steps }),
          ...(args.retry === true ? { retry: true } : {}),
        })
        const startedEvent = started.events.find((applied) => applied.name === "line/run/started")
        if (startedEvent === undefined) throw new Error("yrd: line integrate did not start a run")
        const id = LineStartSchema.parse((startedEvent.data as { run?: unknown }).run).id
        roots.push(id)
        await run(id, runOptions)
      }
      const final = runtime()
      return roots.flatMap((root) => lineTree(final.lines, final.jobs, root))
    },
    run,
    waiting,
    async finish(selector, completion, runOptions) {
      using _span = log.span?.("finish", { selector, step: completion.step })
      const selected = waiting(selector, completion.step)
      await jobs.finish(selected.step.job.id, {
        attempt: selected.step.job.attempt,
        executor: selected.step.job.executor,
        ...(completion.token === undefined ? {} : { token: completion.token }),
        result: completion.result,
      })
      return await run(selected.run.id, runOptions)
    },
    async recover(recoverOptions) {
      using _span = log.span?.("recover", { at: recoverOptions.recoveryTime })
      const recoveredJobs = new Set(
        await jobs.recover({
          now: recoverOptions.recoveryTime,
          ...(recoverOptions.reason === undefined ? {} : { reason: recoverOptions.reason }),
        }),
      )
      const recovered: LineRun[] = []
      const snapshot = runtime()
      for (const candidate of orderedLines(snapshot.lines, snapshot.jobs)) {
        if (Lines.terminal(candidate) && !needsAdvance(snapshot, candidate) && !bisectable(candidate)) {
          if (candidate.steps.some((step) => step.job !== undefined && recoveredJobs.has(step.job.id))) {
            recovered.push(candidate)
          }
          continue
        }
        recovered.push(await run(candidate.id, recoverOptions))
      }
      return recovered
    },
    audit: () => auditLines(runtime(), steps),
    eligibility(selector) {
      const snapshot = runtime()
      const pr = resolvePR(snapshot.bays, selector)
      if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${selector}'`)
      return prEligibility(snapshot, pr, steps)
    },
    eligibilities() {
      const snapshot = runtime()
      return Object.values(snapshot.bays.prs).map((pr) => prEligibility(snapshot, pr, steps))
    },
    checks(selectors) {
      const snapshot = runtime()
      const prs =
        selectors === undefined
          ? Object.values(snapshot.bays.prs)
          : selectors.map((selector) => {
              const pr = resolvePR(snapshot.bays, selector)
              if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${selector}'`)
              return pr
            })
      return prs.flatMap((pr) => projectPRChecks(snapshot, pr, steps))
    },
    get(id) {
      const record = state().records[id]
      return record === undefined ? undefined : materializeRun(record, runtime().jobs)
    },
    status: (base) => lineSummary(state(), runtime().jobs, base),
  }) as Line<Shape>
}

function createLineCommands(steps: readonly RuntimeStep[], byName: ReadonlyMap<string, RuntimeStep>): LineCommands {
  const admit = command({
    title: "Admit PR checks",
    params: AdmitArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: AdmitArgs) {
      const pr = resolvePR(state.bays, args.pr)
      if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${args.pr}'`)
      if (pr.status !== "pushed" && pr.status !== "submitted" && !(args.retry === true && pr.status === "rejected")) {
        raiseFailure("refusal", "pr-not-admissible", `yrd: PR '${pr.id}' is ${pr.status}, not admissible`)
      }
      const selected = admissionSteps(state.lines, steps)
      if (selected.length === 0) return { events: [] }
      const snapshot = Lines.snapshot(pr)
      const existing = admissionRun(state, snapshot, selected)
      if (existing?.status === "passed" || existing?.status === "running" || existing?.status === "waiting") {
        return { events: [] }
      }
      if (existing?.status === "failed" && args.retry !== true) {
        raiseFailure(
          "refusal",
          "checks-failed",
          `yrd: PR '${pr.id}' checks failed in ${existing.id}; retry=true is required`,
        )
      }
      if (runningLine(state.lines, state.jobs, pr.base) !== undefined) return { events: [] }
      if (pr.status !== "rejected" && checksRequested(pr)) {
        const first = admissionQueue(state, steps)[0]
        if (first !== undefined && first.id !== pr.id) return { events: [] }
      }
      return startRun(Lines.nextId(state.lines), [snapshot], selected, prShape([snapshot]))
    },
  })

  const hold = command({
    title: "Hold line",
    visibility: "public",
    params: HoldLineArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: HoldLineArgs) {
      const held = {
        ...args,
        allowedPRs: [...args.allowedPRs].toSorted((left, right) =>
          left.localeCompare(right, undefined, { numeric: true }),
        ),
      }
      const current = state.lines.holds[args.base]
      if (
        current?.reason === held.reason &&
        current.allowedPRs.length === held.allowedPRs.length &&
        current.allowedPRs.every((pr, index) => pr === held.allowedPRs[index])
      ) {
        return { events: [] }
      }
      return { events: [event("line/held", held)] }
    },
  })

  const release = command({
    title: "Release line hold",
    visibility: "public",
    params: ReleaseLineArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: Readonly<{ base: string }>) {
      return { events: state.lines.holds[args.base] === undefined ? [] : [event("line/released", args)] }
    },
  })

  const integrate = command({
    title: "Integrate PR",
    visibility: "public",
    params: IntegrateArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: IntegrateArgs) {
      if (args.steps?.length === 0) return { events: [] }
      const prs = runnablePRs(state, args, steps)
      if (prs.length === 0) return { events: [] }
      const base = prs[0]?.base
      if (base === undefined) throw new Error("yrd: a line run requires at least one PR")
      if (prs.some((pr) => pr.base !== base)) throw new Error("yrd: one line candidate cannot span base branches")
      if (prs.length > state.lines.batchSize) {
        throw new Error(`yrd: line candidate has ${prs.length} PRs; configured batch size is ${state.lines.batchSize}`)
      }
      const active = runningLine(state.lines, state.jobs, base)
      if (active !== undefined) throw new Error(`yrd: line '${base}' is running '${active.id}'`)

      const selected = selectSteps(steps, args.steps ?? state.lines.defaultSteps)
      const integrated = integratedPRShape(prs)
      validateSequence(selected, integrated !== undefined)
      const snapshots = prs.map(Lines.snapshot)
      const reuse = integrated === undefined ? reusablePrefix(state, snapshots, selected) : undefined
      const remaining = reuse === undefined ? selected : selected.slice(reuse.count)
      if (remaining.length === 0) return { events: [] }
      return startRun(
        Lines.nextId(state.lines),
        snapshots,
        remaining,
        reuse?.shape ?? integrated ?? prShape(snapshots),
        integrated?.integration,
        {},
        reuse === undefined ? undefined : { run: reuse.run, results: reuse.shape.results },
      )
    },
  })

  const advance = command({
    title: "Advance line run",
    params: AdvanceArgsSchema,
    apply: (state: DeepReadonly<RuntimeState>, args) => advanceLine(state, Lines.record(state.lines, args.run), byName),
  })

  const isolate = command({
    title: "Isolate failed line batch",
    params: IsolateArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args) {
      const parent = materializeRun(Lines.record(state.lines, args.run), state.jobs)
      if (childLine(state.lines, state.jobs, parent.id, args.part) !== undefined) return { events: [] }
      if (!bisectable(parent)) throw new Error(`yrd: line run '${parent.id}' is not a failed pre-merge batch`)
      const active = runningLine(state.lines, state.jobs, parent.base)
      if (active !== undefined) throw new Error(`yrd: line '${parent.base}' is running '${active.id}'`)

      const pivot = Math.ceil(parent.prs.length / 2)
      const prs = args.part === 0 ? parent.prs.slice(0, pivot) : parent.prs.slice(pivot)
      if (prs.length === 0) throw new Error(`yrd: line run '${parent.id}' has no isolation part ${args.part}`)
      const selected = parent.steps.map((planned) => requirePlannedStep(byName, planned))
      const started = startRun(Lines.nextId(state.lines), prs, selected, prShape(prs), undefined, {
        parent: parent.id,
        isolationPart: args.part,
      })
      return {
        events: [
          event("line/batch/isolated", {
            parent: parent.id,
            run: started.run.id,
            part: args.part,
            prs: prs.map((pr) => pr.id),
          }),
          ...started.events,
        ],
      }
    },
  })

  return { line: { admit, integrate, hold, release, advance, isolate } }
}

function projectLines(state: DeepReadonly<LineState>, applied: Event): LineState {
  if (applied.name === "line/held") {
    const held = LineHoldSchema.parse({ ...HoldLineArgsSchema.parse(applied.data), heldAt: applied.ts })
    return { lines: { ...state.lines, holds: { ...state.lines.holds, [held.base]: held } } }
  }
  if (applied.name === "line/released") {
    const { base } = ReleaseLineArgsSchema.parse(applied.data)
    return {
      lines: {
        ...state.lines,
        holds: Object.fromEntries(Object.entries(state.lines.holds).filter(([candidate]) => candidate !== base)),
      },
    }
  }
  if (applied.name === "line/run/started") {
    const started = LineStartSchema.parse((applied.data as { run?: unknown }).run)
    if (state.lines.records[started.id] !== undefined) throw new Error(`yrd: duplicate line run '${started.id}'`)
    const record = LineRecordSchema.parse({ ...started, startedAt: applied.ts })
    return { lines: { ...state.lines, records: { ...state.lines.records, [record.id]: record } } }
  }
  if (applied.name === "line/run/failed") {
    const failed = LineFailedSchema.parse(applied.data)
    const record = state.lines.records[failed.run]
    if (record === undefined) throw new Error(`yrd: no line run '${failed.run}'`)
    return {
      lines: {
        ...state.lines,
        records: {
          ...state.lines.records,
          [record.id]: { ...record, failure: { at: applied.ts, error: failed.error } },
        },
      },
    }
  }
  return state
}

function installSteps(definitions: readonly AnyStepDef[]): readonly RuntimeStep[] {
  const names = new Set<string>()
  for (const step of definitions) {
    if (names.has(step.name)) throw new Error(`yrd: line step '${step.name}' is already installed`)
    names.add(step.name)
  }
  return Object.freeze([...definitions])
}

function descriptor(step: RuntimeStep | LineStep): InstalledStep {
  return {
    name: step.name,
    title: step.title,
    revision: step.revision,
    integrates: step.integrates,
    needsIntegration: step.needsIntegration,
    ...(step.classification === undefined ? {} : { classification: step.classification }),
  }
}

function selectSteps(steps: readonly RuntimeStep[], names?: readonly string[]): RuntimeStep[] {
  if (names === undefined) return [...steps]
  const selected = new Set(names)
  if (selected.size !== names.length) throw new Error("yrd: line.integrate: duplicate step name")
  for (const name of selected) {
    if (!steps.some((step) => step.name === name)) throw new Error(`yrd: line step '${name}' is not installed`)
  }
  return steps.filter((step) => selected.has(step.name))
}

function validateSequence(steps: readonly RuntimeStep[], alreadyIntegrated: boolean): void {
  let integrated = alreadyIntegrated
  for (const step of steps) {
    if (step.needsIntegration && !integrated) {
      throw new Error(`yrd: line step '${step.name}' requires integration output before it can run`)
    }
    if (!step.integrates) continue
    if (integrated) throw new Error("yrd: merge step cannot run after the PR is already integrated")
    integrated = true
  }
}

function startRun(
  id: LineRunId,
  prs: readonly PRSnapshot[],
  selected: readonly RuntimeStep[],
  shape: PRShape,
  integration?: IntegrationProof,
  lineage: Readonly<{ parent?: LineRunId; isolationPart?: 0 | 1 }> = {},
  reuse?: Readonly<{ run: LineRunId; results: Readonly<Record<string, JsonValue>> }>,
): Readonly<{ run: LineStart; events: readonly EventDraft[] }> {
  const pr = prs[0]
  if (pr === undefined) throw new Error("yrd: a line run requires at least one PR")
  const run: LineStart = {
    id,
    prs,
    base: pr.base,
    steps: selected.map(descriptor),
    ...(integration === undefined ? {} : { initialIntegration: integration }),
    ...(reuse === undefined ? {} : { initialResults: reuse.results, reusedFrom: reuse.run }),
    ...lineage,
  }
  return {
    run,
    events: [
      event("line/run/started", { run }),
      ...(selected[0] === undefined ? [] : [requestStep(selected[0], run, 0, shape)]),
    ],
  }
}

function requestStep(step: RuntimeStep, run: Pick<LineStart, "id" | "prs">, index: number, shape: PRShape) {
  return step.job.request({ run: run.id, step: step.name, index, prs: run.prs, shape }, { key: jobKey(run.id, index) })
}

function advanceLine(
  state: DeepReadonly<RuntimeState>,
  record: DeepReadonly<LineRecord>,
  steps: ReadonlyMap<string, RuntimeStep>,
): Readonly<{ events: readonly EventDraft[] }> {
  const stale = pinnedPRError(state.bays, record.prs)
  if (stale !== undefined && record.failure === undefined) {
    return { events: [event("line/run/failed", { run: record.id, error: stale })] }
  }

  const jobs = lineJobs(record, state.jobs)
  const index = jobs.length - 1
  const job = jobs[index]
  if (job === undefined || job.status === "requested" || job.status === "running" || job.status === "waiting") {
    return { events: [] }
  }
  const planned = record.steps[index]
  if (planned === undefined) throw new Error(`yrd: line run '${record.id}' lost step ${index}`)
  if (runningLine(state.lines, state.jobs, record.base, record.id) !== undefined) return { events: [] }

  if (job.status !== "passed") {
    const before = shapeThrough(record, state.jobs, index)
    const pr = record.prs.length === 1 ? record.prs[0] : undefined
    const current = pr === undefined ? undefined : state.bays.prs[pr.id]
    return {
      events:
        !isIntegrated(before) && pr !== undefined && current?.status === "submitted"
          ? [event("pr/rejected", { pr: pr.id, revision: pr.revision, detail: jobFailure(job).message })]
          : [],
    }
  }

  const shape = shapeThrough(record, state.jobs, index + 1)
  const events: EventDraft[] = []
  if (planned.integrates) {
    if (!isIntegrated(shape)) throw new Error(`yrd: merge step '${planned.name}' produced no integration proof`)
    for (const current of samePayloadPRs(state.bays, record.prs)) {
      if (
        current.status === "integrated" &&
        current.integration?.commit === shape.integration.commit &&
        current.integration?.baseSha === shape.integration.baseSha
      ) {
        continue
      }
      events.push(
        event("pr/integrated", {
          pr: current.id,
          revision: current.revision,
          headSha: current.headSha,
          commit: shape.integration.commit,
          baseSha: shape.integration.baseSha,
        }),
      )
    }
  }

  const next = record.steps[index + 1]
  if (next !== undefined) events.push(requestStep(requirePlannedStep(steps, next), record, index + 1, shape))
  return { events }
}

function samePayloadPRs(
  state: DeepReadonly<BaysState>,
  snapshots: readonly DeepReadonly<PRSnapshot>[],
): readonly DeepReadonly<PR>[] {
  const payloads = new Set(snapshots.map((pr) => `${pr.base}\0${pr.headSha}`))
  return Object.values(state.prs).filter((pr) => pr.status !== "withdrawn" && payloads.has(`${pr.base}\0${pr.headSha}`))
}

function materializeRun(record: DeepReadonly<LineRecord>, jobs: DeepReadonly<JobsState>): LineRun {
  const jobList = lineJobs(record, jobs)
  const steps = record.steps.map(
    (step, index): LineStep => ({
      ...step,
      ...(jobList[index] === undefined ? {} : { job: jobList[index] }),
    }),
  )
  const cursor = steps.findIndex((step) => step.job === undefined || !Job.terminal(step.job))
  const failed = steps.find((step) => step.job?.status === "failed" || step.job?.status === "lost")?.job
  const waiting = steps.some((step) => step.job?.status === "waiting")
  const passed = steps.every((step) => step.job?.status === "passed")
  const status =
    record.failure !== undefined
      ? "failed"
      : failed !== undefined
        ? "failed"
        : waiting
          ? "waiting"
          : passed
            ? "passed"
            : "running"
  const last = steps.at(-1)?.job
  const finishedAt =
    record.failure?.at ??
    (failed?.status === "failed" || failed?.status === "lost"
      ? failed.finishedAt
      : status === "passed"
        ? last?.status === "passed"
          ? last.finishedAt
          : record.startedAt
        : undefined)
  const shape = shapeThrough(record, jobs)
  const {
    initialIntegration: _initialIntegration,
    initialResults: _initialResults,
    failure: _failure,
    steps: _steps,
    ...facts
  } = record
  return {
    ...facts,
    cursor: cursor < 0 ? steps.length : cursor,
    ...(isIntegrated(shape) ? { integration: shape.integration } : {}),
    status,
    steps,
    shape,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(record.failure === undefined
      ? failed === undefined
        ? {}
        : { error: jobFailure(failed) }
      : { error: record.failure.error }),
  }
}

function lineJobs(record: DeepReadonly<LineRecord>, jobs: DeepReadonly<JobsState>): Job[] {
  const result: Job[] = []
  let missing = false
  for (const [index, step] of record.steps.entries()) {
    const id = jobs.byKey[jobKey(record.id, index)]
    if (id === undefined) {
      missing = true
      continue
    }
    if (missing) throw new Error(`yrd: line run '${record.id}' requested steps out of order`)
    const job = jobs.byId[id]
    if (job === undefined) throw new Error(`yrd: line run '${record.id}' lost job '${id}'`)
    const input = StepExecutionSchema.parse(job.input)
    if (
      input.run !== record.id ||
      input.index !== index ||
      input.step !== step.name ||
      job.definition !== `line.step.${step.name}` ||
      job.revision !== step.revision
    ) {
      throw new Error(`yrd: line run '${record.id}' job '${job.id}' does not match step '${step.name}'`)
    }
    result.push(job)
  }
  return result
}

function jobKey(run: LineRunId, index: number): string {
  return `line:${run}:${index}`
}

function shapeThrough(
  record: DeepReadonly<LineRecord>,
  jobs: DeepReadonly<JobsState>,
  limit = record.steps.length,
): PRShape {
  const hasMerge = record.steps.some((step) => step.integrates)
  let shape: PRShape | IntegratedShape = {
    results: { ...record.initialResults },
    ...(record.initialIntegration === undefined || hasMerge ? {} : { integration: record.initialIntegration }),
  }
  const jobList = lineJobs(record, jobs)
  for (let index = 0; index < Math.min(limit, record.steps.length); index += 1) {
    const planned = record.steps[index]
    const job = jobList[index]
    if (planned === undefined || job?.status !== "passed") break
    shape = planned.integrates
      ? { ...shape, integration: IntegrationProofSchema.parse(job.output) }
      : { ...shape, results: { ...shape.results, [planned.name]: job.output } }
  }
  return shape
}

function orderedLines(lines: DeepReadonly<LinesState>, jobs: DeepReadonly<JobsState>): LineRun[] {
  return Object.values(lines.records)
    .map((record) => materializeRun(record, jobs))
    .toSorted((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
}

function runningLine(
  lines: DeepReadonly<LinesState>,
  jobs: DeepReadonly<JobsState>,
  base: string,
  except?: LineRunId,
): LineRun | undefined {
  return orderedLines(lines, jobs).find((run) => run.id !== except && run.base === base && run.status === "running")
}

function childLine(
  lines: DeepReadonly<LinesState>,
  jobs: DeepReadonly<JobsState>,
  parent: LineRunId,
  part: 0 | 1,
): LineRun | undefined {
  const record = Object.values(lines.records).find(
    (candidate) => candidate.parent === parent && candidate.isolationPart === part,
  )
  return record === undefined ? undefined : materializeRun(record, jobs)
}

function lineTree(lines: DeepReadonly<LinesState>, jobs: DeepReadonly<JobsState>, root: LineRunId): LineRun[] {
  const ordered = orderedLines(lines, jobs)
  const result: LineRun[] = []
  const visit = (id: LineRunId): void => {
    const run = ordered.find((candidate) => candidate.id === id)
    if (run === undefined) return
    result.push(run)
    for (const child of ordered.filter((candidate) => candidate.parent === id)) visit(child.id)
  }
  visit(root)
  return result
}

function lineSummary(lines: DeepReadonly<LinesState>, jobs: DeepReadonly<JobsState>, base: string): LineSummary {
  const runs = orderedLines(lines, jobs).filter((run) => run.base === base)
  return {
    base,
    running: runs.filter((run) => run.status === "running"),
    waiting: runs.filter((run) => run.status === "waiting"),
    finished: runs.filter(Lines.terminal),
    ...(lines.holds[base] === undefined ? {} : { hold: lines.holds[base] }),
  }
}

function auditLines(state: DeepReadonly<RuntimeState>, steps: readonly RuntimeStep[]): LineAuditResult {
  const findings: LineAuditFinding[] = []
  const installed = new Map(steps.map((step) => [step.name, step]))
  for (const record of Object.values(state.lines.records)) {
    for (const pr of record.prs) {
      if (state.bays.prs[pr.id] !== undefined) continue
      findings.push({
        code: "missing-pr",
        message: `line run '${record.id}' references missing PR '${pr.id}'`,
        run: record.id,
        pr: pr.id,
      })
    }
    let run: LineRun
    try {
      run = materializeRun(record, state.jobs)
    } catch (error) {
      findings.push({
        code: "invalid-run",
        message: error instanceof Error ? error.message : String(error),
        run: record.id,
      })
      continue
    }
    if (Lines.terminal(run)) continue
    for (const planned of record.steps) {
      const current = installed.get(planned.name)
      if (current === undefined) {
        findings.push({
          code: "step-unavailable",
          message: `line run '${record.id}' requires unavailable step '${planned.name}' revision '${planned.revision}'`,
          run: record.id,
          step: planned.name,
        })
      } else if (current.revision !== planned.revision) {
        findings.push({
          code: "step-revision-drift",
          message: `line run '${record.id}' requires step '${planned.name}' revision '${planned.revision}', installed '${current.revision}'`,
          run: record.id,
          step: planned.name,
        })
      }
    }
  }
  return { findings }
}

function requirePlannedStep(steps: ReadonlyMap<string, RuntimeStep>, planned: InstalledStep): RuntimeStep {
  const current = steps.get(planned.name)
  if (current === undefined) throw new Error(`yrd: line step '${planned.name}' is not installed`)
  if (
    current.revision !== planned.revision ||
    current.integrates !== planned.integrates ||
    current.needsIntegration !== planned.needsIntegration ||
    current.classification !== planned.classification
  ) {
    throw new Error(
      `yrd: line step '${planned.name}' revision '${planned.revision}' does not match installed revision '${current.revision}'`,
    )
  }
  return current
}

function requestedPRs(state: DeepReadonly<BaysState>, args: IntegrateArgs): PR[] {
  const selectors = args.prs === undefined || args.prs.length === 0 ? undefined : args.prs
  const prs =
    selectors === undefined
      ? Object.values(state.prs)
          .filter((pr) => pr.status === "submitted" || (args.retry === true && pr.status === "rejected"))
          .toSorted((left, right) => {
            if (left.submittedAt === undefined) throw new Error(`yrd: queued PR '${left.id}' has no submission time`)
            if (right.submittedAt === undefined) throw new Error(`yrd: queued PR '${right.id}' has no submission time`)
            return (
              left.submittedAt.localeCompare(right.submittedAt) ||
              left.id.localeCompare(right.id, undefined, { numeric: true })
            )
          })
      : selectors.map((selector) => {
          const pr = resolvePR(state, selector)
          if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${selector}'`)
          return pr
        })
  const ids = new Set<string>()
  for (const pr of prs) {
    if (ids.has(pr.id)) {
      raiseFailure("usage", "duplicate-pr", `yrd: line.integrate: duplicate PR '${pr.id}'`)
    }
    ids.add(pr.id)
    if (pr.status === "rejected" && args.retry !== true) {
      raiseFailure("refusal", "retry-required", `yrd: PR '${pr.id}' is rejected; retry=true is required`)
    }
    if (pr.status !== "submitted" && pr.status !== "rejected" && pr.status !== "integrated") {
      raiseFailure("refusal", "pr-not-ready", `yrd: PR '${pr.id}' is ${pr.status}, not ready for the line`)
    }
  }
  return prs
}

function admissionSteps(lines: DeepReadonly<LinesState>, steps: readonly RuntimeStep[]): RuntimeStep[] {
  const selected = selectSteps(steps, lines.defaultSteps)
  const boundary = selected.findIndex((step) => step.integrates || step.needsIntegration)
  return boundary < 0 ? selected : selected.slice(0, boundary)
}

function sameSnapshot(left: DeepReadonly<PRSnapshot>, right: DeepReadonly<PRSnapshot>): boolean {
  return (
    left.id === right.id &&
    left.revision === right.revision &&
    left.headSha === right.headSha &&
    left.base === right.base &&
    left.baseSha === right.baseSha
  )
}

function samePlan(actual: readonly DeepReadonly<InstalledStep>[], expected: readonly RuntimeStep[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((step, index) => {
      const candidate = expected[index]
      return (
        candidate !== undefined &&
        step.name === candidate.name &&
        step.revision === candidate.revision &&
        step.integrates === candidate.integrates &&
        step.needsIntegration === candidate.needsIntegration &&
        step.classification === candidate.classification
      )
    })
  )
}

function admissionRun(
  state: DeepReadonly<RuntimeState>,
  snapshot: DeepReadonly<PRSnapshot>,
  selected: readonly RuntimeStep[],
): LineRun | undefined {
  return orderedLines(state.lines, state.jobs)
    .filter(
      (run) =>
        run.prs.length === 1 &&
        run.prs[0] !== undefined &&
        sameSnapshot(run.prs[0], snapshot) &&
        samePlan(run.steps, selected),
    )
    .at(-1)
}

function admissionQueue(state: DeepReadonly<RuntimeState>, steps: readonly RuntimeStep[]): PR[] {
  const selected = admissionSteps(state.lines, steps)
  if (selected.length === 0) return []
  return Object.values(state.bays.prs)
    .filter((pr) => pr.status === "pushed" || pr.status === "submitted")
    .filter((pr) => checksRequested(pr))
    .filter((pr) => {
      const run = admissionRun(state, Lines.snapshot(pr), selected)
      return run === undefined
    })
    .toSorted((left, right) => {
      const leftAt = checkQueueTime(left)
      const rightAt = checkQueueTime(right)
      return leftAt.localeCompare(rightAt) || left.id.localeCompare(right.id, undefined, { numeric: true })
    })
}

function checkQueueTime(pr: DeepReadonly<PR>): string {
  const request = checkRequest(pr)
  if (request === undefined) throw new Error(`yrd: queued PR '${pr.id}' has no current check request`)
  return request.at
}

function checkEligibility(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
  steps: readonly RuntimeStep[],
): PREligibility["checks"] {
  const request = checkRequest(pr)
  const timing = request === undefined ? {} : { queuedAt: request.at }
  const selected = admissionSteps(state.lines, steps)
  if (selected.length === 0) return { status: "passed", ...timing }
  const run = admissionRun(state, Lines.snapshot(pr), selected)
  if (run?.status === "running" || run?.status === "waiting") {
    return { status: "checking", ...timing, run: run.id }
  }
  if (run?.status === "passed") return { status: "passed", ...timing, run: run.id }
  if (run?.status === "failed") return { status: "failed", ...timing, run: run.id }
  if (request === undefined) return { status: "not-requested" }
  const queued = admissionQueue(state, steps)
  const position = queued.findIndex((candidate) => candidate.id === pr.id)
  return { status: "queued", ...timing, ...(position < 0 ? {} : { position: position + 1 }) }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function firstArtifact(value: unknown, preferredName?: string): string | undefined {
  const artifacts = objectValue(value)?.artifacts
  if (!Array.isArray(artifacts)) return undefined
  const ordered =
    preferredName === undefined
      ? artifacts
      : artifacts.toSorted((left, right) => {
          const leftPreferred = objectValue(left)?.name === preferredName
          const rightPreferred = objectValue(right)?.name === preferredName
          return Number(rightPreferred) - Number(leftPreferred)
        })
  for (const artifact of ordered) {
    const item = objectValue(artifact)
    const location = item?.path ?? item?.uri
    if (typeof location === "string" && location !== "") return location
  }
  return undefined
}

function checkEvidence(job: Job): Record<string, unknown> | undefined {
  if (job.status === "passed" || job.status === "failed") return objectValue(job.output)
  if (job.status === "waiting") return objectValue(job.checkpoint)
  return undefined
}

function checkError(job: Job | undefined, run: LineRun): JobError | undefined {
  if (job?.status === "failed") return job.error
  if (job?.status === "lost") return { code: "job-lost", message: job.lostReason }
  return run.error
}

function checkStatus(job: Job | undefined, run: LineRun): PRCheckRecord["status"] {
  if (run.status === "failed" && (job === undefined || !Job.terminal(job))) return "failed"
  if (job?.status === "passed") return "passed"
  if (job?.status === "failed" || job?.status === "lost") return "failed"
  return "checking"
}

function projectCheckStep(
  pr: DeepReadonly<PR>,
  run: LineRun,
  step: LineStep,
  queuedAt: string | undefined,
): PRCheckRecord | undefined {
  const job = step.job
  if (job === undefined && run.status !== "failed") return undefined
  const evidence = job === undefined ? undefined : checkEvidence(job)
  const error = checkError(job, run)
  const diagnostics =
    Array.isArray(evidence?.diagnostics) || typeof evidence?.detail === "string"
      ? ((evidence?.diagnostics ?? evidence?.detail) as JsonValue)
      : job?.status === "waiting" && job.detail !== undefined
        ? job.detail
        : error?.message
  const artifact =
    firstArtifact(evidence, error === undefined ? undefined : "stderr") ??
    (job !== undefined && "artifacts" in job
      ? firstArtifact({ artifacts: job.artifacts }, error === undefined ? undefined : "stderr")
      : undefined)
  const command = Array.isArray(evidence?.command)
    ? evidence.command.filter((part): part is string => typeof part === "string")
    : job === undefined
      ? [`line.step.${step.name}`]
      : [job.definition]
  return {
    pr: pr.id,
    revision: pr.revision,
    run: run.id,
    step: step.name,
    status: checkStatus(job, run),
    classification: step.classification ?? "carrier",
    command,
    ...(queuedAt === undefined ? {} : { queuedAt }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(artifact === undefined ? {} : { artifact }),
    ...(error === undefined ? {} : { error }),
  }
}

function projectPRChecks(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
  steps: readonly RuntimeStep[],
): PRCheckRecord[] {
  const checks = checkEligibility(state, pr, steps)
  const run = checks.run === undefined ? undefined : materializeRun(Lines.record(state.lines, checks.run), state.jobs)
  if (run === undefined) {
    return [
      {
        pr: pr.id,
        revision: pr.revision,
        status: checks.status,
        ...(checks.position === undefined ? {} : { position: checks.position }),
        ...(checks.queuedAt === undefined ? {} : { queuedAt: checks.queuedAt }),
      },
    ]
  }
  const records = run.steps
    .filter((step) => !step.integrates && !step.needsIntegration)
    .flatMap((step, index) => {
      if (step.job === undefined && index !== run.cursor) return []
      const record = projectCheckStep(pr, run, step, checks.queuedAt)
      return record === undefined ? [] : [record]
    })
  return records.length === 0
    ? [
        {
          pr: pr.id,
          revision: pr.revision,
          run: run.id,
          status: checks.status,
          ...(checks.queuedAt === undefined ? {} : { queuedAt: checks.queuedAt }),
          ...(run.error === undefined ? {} : { error: run.error }),
        },
      ]
    : records
}

function reusablePrefix(
  state: DeepReadonly<RuntimeState>,
  snapshots: readonly DeepReadonly<PRSnapshot>[],
  selected: readonly RuntimeStep[],
): Readonly<{ run: LineRunId; count: number; shape: PRShape }> | undefined {
  const snapshot = snapshots.length === 1 ? snapshots[0] : undefined
  if (snapshot?.baseSha === undefined) return undefined
  const boundary = selected.findIndex((step) => step.integrates || step.needsIntegration)
  const prefix = boundary < 0 ? selected : selected.slice(0, boundary)
  if (prefix.length === 0) return undefined
  const cached = admissionRun(state, snapshot, prefix)
  if (cached?.status !== "passed") return undefined
  const record = Lines.record(state.lines, cached.id)
  return { run: cached.id, count: prefix.length, shape: shapeThrough(record, state.jobs) }
}

function runnablePRs(state: DeepReadonly<RuntimeState>, args: IntegrateArgs, steps: readonly RuntimeStep[]): PR[] {
  const requested = requestedPRs(state.bays, args)
  const implicitQueue = args.prs === undefined || args.prs.length === 0
  return requested.filter((pr) => {
    const eligibility = prEligibility(state, pr, steps, {
      retry: args.retry === true,
      resumeIntegrated: true,
    })
    if (eligibility.runnable) return true
    if (implicitQueue || eligibility.reason?.code === "claimed") return false
    const reason = eligibility.reason
    raiseFailure("refusal", reason?.code ?? "pr-not-ready", `yrd: ${reason?.message ?? `PR '${pr.id}' is not ready`}`)
  })
}

function prEligibility(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
  steps: readonly RuntimeStep[],
  options: Readonly<{ retry?: boolean; resumeIntegrated?: boolean }> = {},
): PREligibility {
  const reviewed = reviewState(pr)
  const required = state.lines.requires.includes("review")
  const review = {
    required,
    approved: reviewed.approved,
    stale: reviewed.stale.length > 0 && reviewed.current === undefined,
    ...(reviewed.current?.decision === undefined ? {} : { decision: reviewed.current.decision }),
    ...(reviewed.current?.actor === undefined ? {} : { actor: reviewed.current.actor }),
    ...(reviewed.current?.ref === undefined ? {} : { ref: reviewed.current.ref }),
  }
  const checks = checkEligibility(state, pr, steps)
  const result = (reason?: PREligibility["reason"]): PREligibility => ({
    pr: pr.id,
    revision: pr.revision,
    runnable: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    review,
    checks,
  })
  const resumingIntegration = options.resumeIntegrated === true && pr.status === "integrated"
  if (!resumingIntegration) {
    if (pr.status === "pushed") {
      return result({ code: "draft", message: `PR '${pr.id}' is pushed, not ready` })
    }
    if (pr.status === "rejected" && options.retry !== true) {
      return result({ code: "rejected", message: `PR '${pr.id}' is rejected; retry=true is required` })
    }
    if (pr.status !== "submitted" && !(options.retry === true && pr.status === "rejected")) {
      return result({ code: "terminal", message: `PR '${pr.id}' is ${pr.status}, not queueable` })
    }
    if (checks.status === "queued") {
      const position = checks.position === undefined ? "" : ` at position ${checks.position}`
      return result({ code: "checks-pending", message: `PR '${pr.id}' checks are queued${position}` })
    }
    if (checks.status === "checking") {
      const run = checks.run === undefined ? "" : ` in ${checks.run}`
      return result({ code: "checking", message: `PR '${pr.id}' checks are running${run}` })
    }
    if (checks.status === "failed" && options.retry !== true) {
      const run = checks.run === undefined ? "" : ` in ${checks.run}`
      return result({ code: "checks-failed", message: `PR '${pr.id}' checks failed${run}; retry=true is required` })
    }
    if (required && !reviewed.approved) {
      if (reviewed.current?.decision === "reject") {
        return result({
          code: "review-rejected",
          message: `PR '${pr.id}' was rejected by ${reviewed.current.actor} for revision ${pr.revision}`,
        })
      }
      return result({
        code: "review-required",
        message: `PR '${pr.id}' needs approval for revision ${pr.revision}`,
      })
    }
  }
  const hold = state.lines.holds[pr.base]
  if (hold !== undefined && !hold.allowedPRs.includes(pr.id)) {
    return result({
      code: "line-held",
      message: `line '${pr.base}' is held: ${hold.reason}; PR '${pr.id}' is not in the allowed set`,
    })
  }
  const claimed = orderedLines(state.lines, state.jobs).some(
    (run) => !Lines.terminal(run) && run.prs.some((candidate) => candidate.id === pr.id),
  )
  return claimed
    ? result({
        code: "claimed",
        message: `PR '${pr.id}' is already in an active line run`,
      })
    : result()
}

function partitionCandidates(prs: readonly PR[], batchSize: number): PR[][] {
  const groups = new Map<string, PR[]>()
  for (const pr of prs) {
    const proof = pr.integration
    const key = `${pr.base}\0${proof?.commit ?? ""}\0${proof?.baseSha ?? ""}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [pr])
    else group.push(pr)
  }
  const candidates: PR[][] = []
  for (const group of groups.values()) {
    for (let index = 0; index < group.length; index += batchSize) candidates.push(group.slice(index, index + batchSize))
  }
  return candidates
}

function prShape(prs: readonly PRSnapshot[]): PRShape {
  if (prs.length === 0) throw new Error("yrd: a line run requires at least one PR")
  return { results: {} }
}

function integratedPRShape(prs: readonly PR[]): IntegratedShape | undefined {
  if (prs.every((pr) => pr.status !== "integrated")) return undefined
  const proof = prs[0]?.integration
  if (
    proof === undefined ||
    prs.some(
      (pr) =>
        pr.status !== "integrated" ||
        pr.integration?.commit !== proof.commit ||
        pr.integration?.baseSha !== proof.baseSha,
    )
  ) {
    throw new Error("yrd: every PR in a line candidate must share one integration proof")
  }
  return { ...prShape(prs.map(Lines.snapshot)), integration: proof }
}

function pinnedPRError(state: DeepReadonly<BaysState>, snapshots: readonly PRSnapshot[]): JobError | undefined {
  for (const snapshot of snapshots) {
    const current = state.prs[snapshot.id]
    if (
      current === undefined ||
      current.revision !== snapshot.revision ||
      current.headSha !== snapshot.headSha ||
      current.base !== snapshot.base ||
      current.status === "withdrawn"
    ) {
      return {
        code: "stale-pr",
        message: `PR '${snapshot.id}' changed after line run pinned revision ${snapshot.revision} (${snapshot.headSha})`,
      }
    }
  }
  return undefined
}

function normalizeBatch(config: BatchConfig): number {
  if (config === false) return 1
  if (!Number.isInteger(config) || config < 0) {
    throw new Error("yrd: batch size must be false or a non-negative integer")
  }
  return config <= 1 ? 1 : config
}

function bisectable(run: LineRun): boolean {
  const failed = run.steps.some((step) => step.job?.status === "failed" || step.job?.status === "lost")
  return run.status === "failed" && failed && !isIntegrated(run.shape) && run.prs.length > 1
}

function needsAdvance(state: DeepReadonly<RuntimeState>, run: LineRun): boolean {
  if (run.error?.code === "stale-pr") return false
  const index = run.steps.findLastIndex((step) => step.job !== undefined)
  const step = run.steps[index]
  if (step?.job === undefined || !Job.terminal(step.job)) return false
  if (step.job.status === "passed") {
    if (run.steps[index + 1]?.job === undefined && index + 1 < run.steps.length) return true
    if (!step.integrates || run.integration === undefined) return false
    return run.prs.some((pr) => {
      const current = state.bays.prs[pr.id]
      return (
        current?.status !== "integrated" ||
        current.integration?.commit !== run.integration?.commit ||
        current.integration?.baseSha !== run.integration?.baseSha
      )
    })
  }
  if (run.prs.length !== 1 || isIntegrated(run.shape)) return false
  const pr = run.prs[0]
  if (pr === undefined) return false
  const current = state.bays.prs[pr.id]
  return current?.status === "submitted"
}

function isIntegrated(shape: PRShape): shape is IntegratedShape {
  return "integration" in shape
}

function jobFailure(job: Job): JobError {
  if (job.status === "failed") return job.error
  if (job.status === "lost") return { code: "job-lost", message: job.lostReason }
  throw new Error(`yrd: job '${job.id}' is ${job.status}, not failed`)
}
