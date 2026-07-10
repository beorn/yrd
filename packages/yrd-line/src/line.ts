import { resolvePR, type BaysState, type HasBays, type PR } from "@yrd/bay"
import {
  command,
  event,
  JsonSchema,
  type Command,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type EventDraft,
  type Frame,
  type JsonValue,
  type YrdDef,
} from "@yrd/core"
import {
  createJobDef,
  type HasJobs,
  type Job,
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
import * as z from "zod"
import {
  IntegrationProofSchema,
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
  type LineRecord,
  type LineRun,
  type LineRunId,
  type LineSummary,
  type LinesState,
  type LineStep,
  type PRShape,
  type PRSnapshot,
} from "./model.ts"

const StepNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/iu)
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

const AdvanceArgsSchema = z.object({ run: LineRunIdSchema }).strict()
const IsolateArgsSchema = AdvanceArgsSchema.extend({ part: z.union([z.literal(0), z.literal(1)]) }).strict()
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
}>

type LineState = Readonly<{ lines: LinesState }>
type LineHostState = Readonly<{ bays: BaysState; jobs: JobsState }>
type RuntimeState = LineHostState & LineState
type LineStart = Omit<LineRecord, "startedAt" | "failure">

export type LineCommands = Readonly<{
  line: Readonly<{
    integrate: Command<IntegrateArgs, RuntimeState>
    advance: Command<Readonly<{ run: LineRunId }>, RuntimeState>
    isolate: Command<Readonly<{ run: LineRunId; part: 0 | 1 }>, RuntimeState>
  }>
}>

export type Line<Shape extends PRShape = PRShape> = Readonly<{
  readonly shape?: Shape
  state: ReadSignal<DeepReadonly<LinesState>>
  steps(): readonly InstalledStep[]
  integrate(args: IntegrateArgs, options: RunJobOptions): Promise<readonly LineRun[]>
  run(run: LineRunId, options: RunJobOptions): Promise<LineRun>
  waiting(selector: string, step?: string): WaitingLineStep
  finish(selector: string, completion: FinishLineArgs, options: RunJobOptions): Promise<LineRun>
  recover(options: RunJobOptions & Readonly<{ recoveryTime: string; reason?: string }>): Promise<readonly LineRun[]>
  audit(): LineAuditResult
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
              integrate: (args) => yrd.command(commands.line.integrate, args),
              advance: (run) => yrd.command(commands.line.advance, { run }),
              isolate: (run, part) => yrd.command(commands.line.isolate, { run, part }),
            },
            steps,
          ),
        }
      },
    })

  Object.defineProperty(install, "jobDefs", { value: jobDefs, enumerable: true })
  return Object.freeze(install) as unknown as LinePlugin<FinalShape<Steps>>
}

type RuntimeStep = AnyStepDef
type LineActions = Readonly<{
  integrate(args: IntegrateArgs): Promise<Frame>
  advance(run: LineRunId): Promise<Frame>
  isolate(run: LineRunId, part: 0 | 1): Promise<Frame>
}>

function createLine<Shape extends PRShape>(
  state: ReadSignal<DeepReadonly<LinesState>>,
  runtime: () => DeepReadonly<RuntimeState>,
  jobs: HasJobs["jobs"],
  actions: LineActions,
  steps: readonly RuntimeStep[],
): Line<Shape> {
  const current = (id: LineRunId): LineRun => materializeRun(Lines.record(state(), id), runtime().jobs)

  const waiting = (selector: string, stepName?: string): WaitingLineStep => {
    const snapshot = runtime()
    const direct = snapshot.lines.records[selector]
    let selected = direct === undefined ? undefined : materializeRun(direct, snapshot.jobs)
    if (selected === undefined) {
      const pr = resolvePR(snapshot.bays, selector)
      if (pr === undefined) throw new Error(`yrd: no line run or PR '${selector}'`)
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
        throw new Error(`yrd: PR '${pr.id}' has no waiting${stepName === undefined ? "" : ` '${stepName}'`} step`)
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
      throw new Error(
        `yrd: line run '${selected.id}' ${pending.length === 0 ? "has no waiting step" : "has multiple waiting steps; select one"}`,
      )
    }
    if (step?.job?.status !== "waiting") {
      throw new Error(`yrd: line run '${selected.id}' has no waiting '${stepName ?? "unknown"}' step`)
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

  return Object.freeze({
    state,
    steps: () => steps.map(descriptor),
    async integrate(args, runOptions) {
      if (args.steps?.length === 0) return []
      const snapshot = runtime()
      const prs = runnablePRs(snapshot, args)
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
      const selected = waiting(selector, completion.step)
      await jobs.finish(selected.step.job.id, {
        attempt: selected.step.job.attempt,
        executor: selected.step.job.executor,
        ...(completion.token === undefined ? {} : { token: completion.token }),
        result: completion.result,
      })
      return run(selected.run.id, runOptions)
    },
    async recover(recoverOptions) {
      await jobs.recover({
        now: recoverOptions.recoveryTime,
        ...(recoverOptions.reason === undefined ? {} : { reason: recoverOptions.reason }),
      })
      const recovered: LineRun[] = []
      const snapshot = runtime()
      for (const candidate of orderedLines(snapshot.lines, snapshot.jobs)) {
        if (Lines.terminal(candidate) && !needsAdvance(snapshot, candidate) && !bisectable(candidate)) continue
        recovered.push(await run(candidate.id, recoverOptions))
      }
      return recovered
    },
    audit: () => auditLines(runtime(), steps),
    get(id) {
      const record = state().records[id]
      return record === undefined ? undefined : materializeRun(record, runtime().jobs)
    },
    status: (base) => lineSummary(state(), runtime().jobs, base),
  }) as Line<Shape>
}

function createLineCommands(steps: readonly RuntimeStep[], byName: ReadonlyMap<string, RuntimeStep>): LineCommands {
  const integrate = command({
    title: "Integrate PR",
    visibility: "public",
    params: IntegrateArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: IntegrateArgs) {
      if (args.steps?.length === 0) return { events: [] }
      const prs = runnablePRs(state, args)
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
      return startRun(
        Lines.nextId(state.lines),
        snapshots,
        selected,
        integrated ?? prShape(snapshots),
        integrated?.integration,
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

  return { line: { integrate, advance, isolate } }
}

function projectLines(state: DeepReadonly<LineState>, applied: Event): LineState {
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
): Readonly<{ run: LineStart; events: readonly EventDraft[] }> {
  const pr = prs[0]
  if (pr === undefined) throw new Error("yrd: a line run requires at least one PR")
  const run: LineStart = {
    id,
    prs,
    base: pr.base,
    steps: selected.map(descriptor),
    ...(integration === undefined ? {} : { initialIntegration: integration }),
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
    for (const pr of record.prs) {
      const current = state.bays.prs[pr.id]
      if (
        current?.status === "integrated" &&
        current.integration?.commit === shape.integration.commit &&
        current.integration?.baseSha === shape.integration.baseSha
      ) {
        continue
      }
      events.push(
        event("pr/integrated", {
          pr: pr.id,
          revision: pr.revision,
          headSha: pr.headSha,
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

function materializeRun(record: DeepReadonly<LineRecord>, jobs: DeepReadonly<JobsState>): LineRun {
  const jobList = lineJobs(record, jobs)
  const steps = record.steps.map(
    (step, index): LineStep => ({
      ...step,
      ...(jobList[index] === undefined ? {} : { job: jobList[index] }),
    }),
  )
  const cursor = steps.findIndex((step) => step.job === undefined || !terminalJob(step.job))
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
  const { initialIntegration: _initialIntegration, failure: _failure, steps: _steps, ...facts } = record
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

function terminalJob(job: Job): boolean {
  return job.status === "passed" || job.status === "failed" || job.status === "lost"
}

function shapeThrough(
  record: DeepReadonly<LineRecord>,
  jobs: DeepReadonly<JobsState>,
  limit = record.steps.length,
): PRShape {
  const hasMerge = record.steps.some((step) => step.integrates)
  let shape: PRShape | IntegratedShape = {
    ...prShape(record.prs),
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
    current.needsIntegration !== planned.needsIntegration
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
          .toSorted((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
      : selectors.map((selector) => {
          const pr = resolvePR(state, selector)
          if (pr === undefined) throw new Error(`yrd: no PR '${selector}'`)
          return pr
        })
  const ids = new Set<string>()
  for (const pr of prs) {
    if (ids.has(pr.id)) throw new Error(`yrd: line.integrate: duplicate PR '${pr.id}'`)
    ids.add(pr.id)
    if (pr.status === "rejected" && args.retry !== true) {
      throw new Error(`yrd: PR '${pr.id}' is rejected; retry=true is required`)
    }
    if (pr.status !== "submitted" && pr.status !== "rejected" && pr.status !== "integrated") {
      throw new Error(`yrd: PR '${pr.id}' is ${pr.status}, not ready for the line`)
    }
  }
  return prs
}

function runnablePRs(state: DeepReadonly<RuntimeState>, args: IntegrateArgs): PR[] {
  const claimed = new Set(
    orderedLines(state.lines, state.jobs)
      .filter((run) => !Lines.terminal(run))
      .flatMap((run) => run.prs.map((pr) => pr.id)),
  )
  return requestedPRs(state.bays, args).filter((pr) => !claimed.has(pr.id))
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
  if (step?.job === undefined || !terminalJob(step.job)) return false
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
