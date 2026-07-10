import { resolveSubmission, type BaysState, type HasBays, type Submission } from "@yrd/bay"
import {
  effect,
  event,
  fx,
  op,
  type AnyYrdApp,
  type Command,
  type DeepReadonly,
  type EffectError,
  type EffectFunction,
  type EffectOutcome,
  type EffectRequest,
  type EffectRun,
  type EffectRunOptions,
  type EffectsState,
  type EventDraft,
  type ExtendYrdApp,
  type Fx,
  type HasEffects,
  type YrdEvent,
} from "@yrd/core"
import {
  Lines,
  type AddStepResult,
  type BatchConfig,
  type InstalledStep,
  type IntegratedShape,
  type IntegrationProof,
  type LineRecord,
  type LineRun,
  type LineRunId,
  type LinesState,
  type LineSummary,
  type StepEvidence,
  type SubmissionShape,
  type SubmissionSnapshot,
} from "./model.ts"

/** Install the line state machine, command surface, projection, and runtime. */
export function withLine() {
  return <App extends AnyYrdApp & HasEffects & HasBays>(app: App): LinesApp<App, SubmissionShape> => {
    const initial = Lines.empty()
    Object.assign(app.initialState, { lines: initial })
    const registry = createStepRegistry(app, initial)
    const commands = createLineCommands(registry)
    Object.assign(app.commands, { line: commands })

    const project = app.project
    app.project = (state, applied) => {
      const projected = project(state, applied)
      const current = (projected as { lines: LinesState }).lines
      const effects = (projected as { effects: EffectsState }).effects.runs
      const lines = projectLine(current, applied, effects, registry)
      return lines === current ? projected : { ...projected, lines }
    }

    Object.assign(app, { line: createLineRuntime(app, registry, commands) })
    return app as unknown as LinesApp<App, SubmissionShape>
  }
}

/** Register an ordered state transition. Each result becomes part of the next step's input shape. */
export function withStep<const Name extends string, Shape extends SubmissionShape, Output>(
  name: Name,
  runner: StepRunner<Shape, Output>,
  options: StepOptions = {},
) {
  return <App extends AnyYrdApp & HasBays & HasLine<Shape>>(
    app: App,
  ): ReplaceLine<App, AddStepResult<Shape, Name, Output>> => {
    registryOf(app).register({
      descriptor: {
        name,
        title: options.title ?? name,
        integrates: false,
        needsIntegration: options.needsIntegration ?? false,
      },
      effect: stepEffect(app, runner, options.title ?? name),
      apply: (shape, output) => ({ ...shape, results: { ...shape.results, [name]: output } }),
    })
    return app as unknown as ReplaceLine<App, AddStepResult<Shape, Name, Output>>
  }
}

/** Register the one transition allowed to produce durable integration proof. */
export function withMerge<Shape extends SubmissionShape>(runner: StepRunner<Shape, IntegrationProof>) {
  return <App extends AnyYrdApp & HasBays & HasLine<Shape>>(app: App): ReplaceLine<App, Shape & IntegratedShape> => {
    registryOf(app).register({
      descriptor: { name: "merge", title: "merge", integrates: true, needsIntegration: false },
      effect: stepEffect(app, runner, "merge"),
      apply: (shape, output) => ({ ...shape, integration: parseIntegrationProof(output) }),
    })
    return app as unknown as ReplaceLine<App, Shape & IntegratedShape>
  }
}

/** Configure the largest candidate evaluated as one batch. false, 0, and 1 are serial. */
export function withBatch(config: BatchConfig) {
  return <App extends AnyYrdApp & HasLineSurface>(app: App): App => {
    app.initialState.lines.batchSize = normalizeBatch(config)
    return app
  }
}

/** Select the installed steps used when line.integrate omits --steps. */
export function withDefaultSteps(names: readonly string[]) {
  return <App extends AnyYrdApp & HasLineSurface>(app: App): App => {
    const selected = registryOf(app).select(names)
    validateSequence(selected, false)
    app.initialState.lines.defaultSteps = selected.map((step) => step.descriptor.name)
    return app
  }
}

export type StepExecution<Shape extends SubmissionShape = SubmissionShape> = {
  run: LineRunId
  step: string
  index: number
  submission: SubmissionSnapshot
  submissions: SubmissionSnapshot[]
  targetSha?: string
  shape: Shape
}

export type StepRunner<Shape extends SubmissionShape, Output> = EffectFunction<
  StepExecution<Shape>,
  EffectOutcome<Output>
>

export type StepOptions = {
  title?: string
  needsIntegration?: boolean
}

type IntegrateOptions = {
  steps?: string[]
  retry?: boolean
}

export type SingleIntegrateArgs = IntegrateOptions & {
  submission: string
  submissions?: never
}

export type BatchIntegrateArgs = IntegrateOptions & {
  submission?: never
  submissions?: string[]
}

export type IntegrateArgs = SingleIntegrateArgs | BatchIntegrateArgs
export type LineRunOptions = EffectRunOptions

export type IntegrateLine = {
  (args: SingleIntegrateArgs, options: LineRunOptions): Promise<LineRun>
  (args: BatchIntegrateArgs, options: LineRunOptions): Promise<LineRun[]>
}

declare const lineShape: unique symbol

export type LineRuntime<Shape extends SubmissionShape = SubmissionShape> = {
  readonly [lineShape]?: Shape
  steps(): readonly InstalledStep[]
  integrate: IntegrateLine
  run(run: LineRunId, options: LineRunOptions): Promise<LineRun>
  recover(options: LineRunOptions & { recoveryTime: string; reason?: string }): Promise<LineRun[]>
  get(run: LineRunId): Promise<LineRun | undefined>
  status(base: string): Promise<LineSummary>
}

export type HasLine<Shape extends SubmissionShape = SubmissionShape> = {
  initialState: { lines: LinesState }
  commands: LineCommands
  line: LineRuntime<Shape>
}

type AdvanceArgs = { run: LineRunId }
type IsolateArgs = AdvanceArgs & { part: 0 | 1 }

type LineCommands = {
  line: {
    integrate: Command<IntegrateArgs, { lines: LinesState; bays: BaysState }>
    advance: Command<AdvanceArgs, { lines: LinesState; effects: EffectsState }>
    isolate: Command<IsolateArgs, { lines: LinesState }>
  }
}

type LinesApp<App extends AnyYrdApp, Shape extends SubmissionShape> = ExtendYrdApp<
  App,
  { lines: LinesState },
  LineCommands
> & {
  line: LineRuntime<Shape>
}

type ReplaceLine<App, Shape extends SubmissionShape> = Omit<App, "line"> & { line: LineRuntime<Shape> }
type HasLineSurface = Omit<HasLine, "line"> & { line: Omit<LineRuntime, typeof lineShape> }

type RuntimeState = { lines: LinesState; bays: BaysState; effects: EffectsState }
type LineStart = Omit<LineRecord, "effectIds" | "startedAt">
type StepDefinition = {
  descriptor: Omit<InstalledStep, "index">
  effect: Fx<StepExecution, EffectOutcome<unknown>>
  apply(shape: SubmissionShape, output: unknown): SubmissionShape
}
type RuntimeStep = Omit<StepDefinition, "descriptor"> & { descriptor: InstalledStep }
type StepRegistry = {
  register(step: StepDefinition): void
  entries(): readonly RuntimeStep[]
  select(names?: readonly string[]): RuntimeStep[]
  require(name: string): RuntimeStep
}

const registryKey = Symbol("yrd.line.registry")
type InternalLineRuntime = LineRuntime & { [registryKey]: StepRegistry }

function createStepRegistry(app: AnyYrdApp & HasEffects, initial: LinesState): StepRegistry {
  const steps = new Map<string, RuntimeStep>()
  const entries = (): RuntimeStep[] => [...steps.values()]
  const requireStep = (name: string): RuntimeStep => {
    const step = steps.get(name)
    if (step === undefined) throw new Error(`yrd: line step '${name}' is not installed`)
    return step
  }

  const select = (names?: readonly string[]): RuntimeStep[] => {
    if (names === undefined) return entries()
    const selected = new Set(names)
    if (selected.size !== names.length) throw new Error("yrd: line.integrate: duplicate step name")
    for (const name of selected) requireStep(name)
    return entries().filter((step) => selected.has(step.descriptor.name))
  }

  return {
    register(step) {
      const name = step.descriptor.name
      if (!/^[a-z][a-z0-9_-]*$/iu.test(name)) throw new Error(`yrd: invalid line step name '${name}'`)
      if (steps.has(name)) throw new Error(`yrd: line step '${name}' is already installed`)
      const descriptor = { ...step.descriptor, index: steps.size }
      const installed = { ...step, descriptor }
      app.effectRuns.register(["line", "step", name], installed.effect)
      steps.set(name, installed)
      initial.installed[name] = descriptor
    },
    entries,
    select,
    require: requireStep,
  }
}

function registryOf(app: HasLineSurface): StepRegistry {
  return (app.line as InternalLineRuntime)[registryKey]
}

function stepEffect<Shape extends SubmissionShape, Output>(
  app: AnyYrdApp & HasBays,
  runner: StepRunner<Shape, Output>,
  title: string,
): Fx<StepExecution, EffectOutcome<unknown>> {
  return fx(
    async (input, context) => {
      const stale = pinnedSubmissionError((await stateOf(app)).bays, input.submissions)
      return stale === undefined
        ? await runner(input as StepExecution<Shape>, context)
        : { status: "failed", error: stale }
    },
    { title },
  )
}

function createLineCommands(registry: StepRegistry): LineCommands["line"] {
  const integrate = op(
    (state: DeepReadonly<{ lines: LinesState; bays: BaysState }>, args: IntegrateArgs) => {
      const lines = state.lines as LinesState
      const submissions = requestedSubmissions(state.bays as BaysState, args)
      if (submissions.length === 0) return { events: [], effects: [] }
      const base = submissions[0]?.base
      if (base === undefined) throw new Error("yrd: a line run requires at least one submission")
      if (submissions.some((submission) => submission.base !== base)) {
        throw new Error("yrd: one line candidate cannot span multiple base branches")
      }
      if (submissions.length > lines.batchSize) {
        throw new Error(
          `yrd: line candidate has ${submissions.length} submissions; configured batch size is ${lines.batchSize}`,
        )
      }
      const active = Lines.running(lines, base)
      if (active !== undefined) throw new Error(`yrd: line '${base}' is running '${active.id}'`)

      const selected = registry.select(args.steps ?? lines.defaultSteps)
      const integrated = integratedSubmissionShape(submissions)
      validateSequence(selected, integrated !== undefined)
      const snapshots = submissions.map(snapshot)
      const shape = integrated ?? submissionShape(snapshots)
      return startRun(Lines.nextId(lines), snapshots, selected, shape, integrated?.integration)
    },
    { title: "Integrate submission", visibility: "public", args: { parse: parseIntegrate } },
  )

  const advance = op(
    (state: DeepReadonly<{ lines: LinesState; effects: EffectsState }>, args: AdvanceArgs) => {
      const lines = state.lines as LinesState
      const record = Lines.record(lines, args.run)
      const name = record.selected[record.cursor]
      if (name === undefined) return { events: [], effects: [] }
      const effectId = record.effectIds[record.cursor]
      if (effectId === undefined) {
        throw new Error(`yrd: line run '${record.id}' has no requested step at index ${record.cursor}`)
      }
      const effectRun = state.effects.runs[effectId] as EffectRun | undefined
      if (effectRun === undefined) throw new Error(`yrd: line run '${record.id}' lost effect '${effectId}'`)
      if (effectRun.status === "requested" || effectRun.status === "running" || effectRun.status === "waiting") {
        throw new Error(`yrd: line run '${record.id}' step '${name}' is ${effectRun.status}`)
      }
      if (Lines.running(lines, record.base, record.id) !== undefined) return { events: [], effects: [] }

      const step = registry.require(name)
      const events: EventDraft[] = [event("line/run/advanced", { run: record.id, index: record.cursor })]
      if (effectRun.status !== "passed") {
        const error = effectFailure(effectRun)
        if (record.integration === undefined && record.submissions.length === 1) {
          const submission = record.submissions[0]
          if (submission !== undefined) {
            events.push(
              event("submission/rejected", {
                submission: submission.id,
                revision: submission.revision,
                detail: error.message,
              }),
            )
          }
        }
        return { events, effects: [] }
      }

      const shape = shapeThrough(record, state.effects.runs as Record<string, EffectRun>, registry, record.cursor + 1)
      if (step.descriptor.integrates) {
        if (!isIntegrated(shape))
          throw new Error(`yrd: merge step '${step.descriptor.name}' produced no integration proof`)
        events.push(event("line/run/integrated", { run: record.id, integration: shape.integration }))
        for (const submission of record.submissions) {
          events.push(
            event("submission/integrated", {
              submission: submission.id,
              revision: submission.revision,
              headSha: submission.headSha,
              commit: shape.integration.commit,
              baseSha: shape.integration.baseSha,
            }),
          )
        }
      }

      const nextIndex = record.cursor + 1
      const nextName = record.selected[nextIndex]
      if (nextName === undefined) return { events, effects: [] }
      const next = registry.require(nextName)
      return { events, effects: [requestStep(next, record, nextIndex, shape)] }
    },
    { title: "Advance line run", visibility: "internal" },
  )

  const isolate = op(
    (state: DeepReadonly<{ lines: LinesState }>, args: IsolateArgs) => {
      const lines = state.lines as LinesState
      const parent = Lines.require(lines, args.run)
      if (Lines.child(lines, parent.id, args.part) !== undefined) return { events: [], effects: [] }
      if (!bisectable(parent)) throw new Error(`yrd: line run '${parent.id}' is not a failed pre-merge batch`)
      const active = Lines.running(lines, parent.base)
      if (active !== undefined) throw new Error(`yrd: line '${parent.base}' is running '${active.id}'`)

      const pivot = Math.ceil(parent.submissions.length / 2)
      const submissions = args.part === 0 ? parent.submissions.slice(0, pivot) : parent.submissions.slice(pivot)
      if (submissions.length === 0) throw new Error(`yrd: line run '${parent.id}' has no isolation part ${args.part}`)
      const selected = parent.selected.map((name) => registry.require(name))
      const started = startRun(Lines.nextId(lines), submissions, selected, submissionShape(submissions), undefined, {
        parent: parent.id,
        isolationPart: args.part,
      })
      return {
        events: [
          event("line/batch/isolated", {
            parent: parent.id,
            run: started.run.id,
            part: args.part,
            submissions: submissions.map((submission) => submission.id),
          }),
          ...started.events,
        ],
        effects: started.effects,
      }
    },
    { title: "Isolate failed line batch", visibility: "internal" },
  )

  return { integrate, advance, isolate }
}

function createLineRuntime(
  app: AnyYrdApp & HasEffects & HasBays,
  registry: StepRegistry,
  commands: LineCommands["line"],
): InternalLineRuntime {
  const start = async (args: IntegrateArgs): Promise<LineRunId> => {
    const result = await app.command(commands.integrate, args)
    const started = result.events.find((applied) => applied.name === "line/run/started")
    if (started === undefined) throw new Error("yrd: line integrate did not start a run")
    return (started.data as { run: LineStart }).run.id
  }

  const drive = async (id: LineRunId, options: LineRunOptions): Promise<LineRun> => {
    while (true) {
      const state = await stateOf(app)
      const run = Lines.require(state.lines, id)
      const record = Lines.record(state.lines, id)
      const effectId = record.effectIds[record.cursor]
      if (effectId === undefined) {
        if (Lines.terminal(run)) return run
        throw new Error(`yrd: line run '${id}' has no effect at index ${record.cursor}`)
      }
      const effectRun = state.effects.runs[effectId]
      if (effectRun === undefined) throw new Error(`yrd: line run '${id}' lost effect '${effectId}'`)
      if (effectRun.status === "requested") {
        await app.effectRuns.run(effectId, options)
        continue
      }
      if (effectRun.status === "running" || effectRun.status === "waiting") return run
      const advanced = await app.command(commands.advance, { run: id })
      if (advanced.events.length === 0) return Lines.require((await stateOf(app)).lines, id)
    }
  }

  const run = async (id: LineRunId, options: LineRunOptions): Promise<LineRun> => {
    const settled = await drive(id, options)
    if (!bisectable(settled)) return settled
    for (const part of [0, 1] as const) {
      let child = Lines.child((await stateOf(app)).lines, settled.id, part)
      if (child === undefined) {
        await app.command(commands.isolate, { run: settled.id, part })
        child = Lines.child((await stateOf(app)).lines, settled.id, part)
      }
      if (child === undefined) throw new Error(`yrd: line run '${settled.id}' did not create isolation part ${part}`)
      await run(child.id, options)
    }
    return Lines.require((await stateOf(app)).lines, id)
  }

  const integrate = (async (args: IntegrateArgs, options: LineRunOptions): Promise<LineRun | LineRun[]> => {
    if (typeof args.submission === "string") return await run(await start(args), options)

    const state = await stateOf(app)
    const submissions = requestedSubmissions(state.bays, args)
    if (submissions.length === 0) return []
    const roots: LineRunId[] = []
    for (const candidate of partitionCandidates(submissions, state.lines.batchSize)) {
      const id = await start({
        submissions: candidate.map((submission) => submission.id),
        ...(args.steps === undefined ? {} : { steps: args.steps }),
        ...(args.retry === true ? { retry: true } : {}),
      })
      roots.push(id)
      await run(id, options)
    }
    const lines = (await stateOf(app)).lines
    return roots.flatMap((root) => Lines.tree(lines, root))
  }) as IntegrateLine

  return {
    [registryKey]: registry,
    steps: () => registry.entries().map((step) => step.descriptor),
    integrate,
    run,
    async recover(options) {
      await app.effectRuns.recover({
        now: options.recoveryTime,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      })
      const recovered: LineRun[] = []
      for (const candidate of Lines.ordered((await stateOf(app)).lines)) {
        if (Lines.terminal(candidate) && !pendingAdvance(candidate) && !bisectable(candidate)) continue
        recovered.push(await run(candidate.id, options))
      }
      return recovered
    },
    async get(id) {
      return (await stateOf(app)).lines.runs[id]
    },
    async status(base) {
      return Lines.summary((await stateOf(app)).lines, base)
    },
  }
}

function projectLine(
  state: LinesState,
  applied: YrdEvent,
  effectRuns: Record<string, EffectRun>,
  registry: StepRegistry,
): LinesState {
  const data = applied.data as Record<string, unknown>
  let record: LineRecord | undefined

  if (applied.name === "line/run/started") {
    const started = data.run as LineStart
    record = { ...started, effectIds: [], startedAt: applied.ts }
  } else if (applied.name === "line/run/advanced") {
    const current = state.records[data.run as string]
    if (current === undefined) return state
    const index = data.index as number
    if (index !== current.cursor) throw new Error(`yrd: line run '${current.id}' advanced out of order`)
    record = { ...current, cursor: index + 1 }
  } else if (applied.name === "line/run/integrated") {
    const current = state.records[data.run as string]
    if (current === undefined) return state
    record = { ...current, integration: data.integration as IntegrationProof }
  } else if (applied.name.startsWith("effect/")) {
    const id = data.id as string
    const effectRun = effectRuns[id]
    if (effectRun === undefined || !effectRun.effect.startsWith("line.step.")) return state
    const input = effectRun.input as { run?: unknown; step?: unknown; index?: unknown }
    if (typeof input.run !== "string" || typeof input.index !== "number") return state
    const current = state.records[input.run]
    if (current === undefined || current.selected[input.index] !== input.step) return state
    if (applied.name === "effect/requested") {
      const existing = current.effectIds[input.index]
      if (existing !== undefined && existing !== id) {
        throw new Error(`yrd: line run '${current.id}' step ${input.index} requested twice`)
      }
      if (existing === undefined && input.index !== current.effectIds.length) {
        throw new Error(`yrd: line run '${current.id}' requested step ${input.index} out of order`)
      }
      record = existing === id ? current : { ...current, effectIds: [...current.effectIds, id] }
    } else {
      if (current.effectIds[input.index] !== id) return state
      record = current
    }
  }

  if (record === undefined) return state
  const run = materializeRun(record, effectRuns, registry, state.runs[record.id], applied)
  return {
    ...state,
    records: { ...state.records, [record.id]: record },
    runs: { ...state.runs, [record.id]: run },
  }
}

function materializeRun(
  record: LineRecord,
  effects: Record<string, EffectRun>,
  registry: StepRegistry,
  previous: LineRun | undefined,
  applied: YrdEvent,
): LineRun {
  const steps = record.selected.map((name, index) =>
    materializeStep(name, index, record.effectIds[index], effects, previous?.steps[index], applied),
  )
  const failure = steps.find((step) => step.status === "failed" || step.status === "lost")
  const waiting = steps.some((step) => step.status === "waiting")
  const passed = steps.every((step) => step.status === "passed") && record.cursor === steps.length
  const status = failure === undefined ? (waiting ? "waiting" : passed ? "passed" : "running") : "failed"
  const finishedAt =
    status === "failed" ? failure?.finishedAt : status === "passed" ? steps.at(-1)?.finishedAt : undefined
  return {
    ...record,
    status,
    steps,
    shape: shapeThrough(record, effects, registry),
    ...(finishedAt === undefined ? (steps.length === 0 ? { finishedAt: record.startedAt } : {}) : { finishedAt }),
    ...(failure?.error === undefined ? {} : { error: failure.error }),
  }
}

function materializeStep(
  name: string,
  index: number,
  effectId: string | undefined,
  effects: Record<string, EffectRun>,
  previous: StepEvidence | undefined,
  applied: YrdEvent,
): StepEvidence {
  if (effectId === undefined) return { name, index, status: "queued" }
  const run = effects[effectId]
  if (run === undefined) throw new Error(`yrd: line step '${name}' lost effect '${effectId}'`)
  if (run.status === "requested") return { name, index, status: "requested", effectId }

  const currentEvent = (applied.data as { id?: unknown }).id === effectId
  const startedAt = currentEvent && applied.name === "effect/started" ? applied.ts : previous?.startedAt
  const finishedAt =
    currentEvent && (applied.name === "effect/finished" || applied.name === "effect/lost")
      ? applied.ts
      : previous?.finishedAt
  if (startedAt === undefined) throw new Error(`yrd: line effect '${effectId}' was never started`)
  const execution = { name, index, effectId, attempt: run.attempt, startedAt }
  if (run.status === "running") return { ...execution, status: "running" }
  const remote = {
    token: run.token,
    url: run.url,
    detail: run.detail,
    artifacts: run.artifacts,
    checkpoint: run.checkpoint,
  }
  if (run.status === "waiting") {
    if (run.token === undefined) throw new Error(`yrd: waiting line effect '${effectId}' has no token`)
    return { ...execution, ...remote, status: "waiting", token: run.token }
  }
  if (finishedAt === undefined) throw new Error(`yrd: terminal line effect '${effectId}' has no finish time`)
  const terminal = { ...execution, ...remote, finishedAt }
  if (run.status === "passed") return { ...terminal, status: "passed", output: run.output }
  return {
    ...terminal,
    status: run.status,
    ...(run.output === undefined ? {} : { output: run.output }),
    error: effectFailure(run),
  }
}

function startRun(
  id: LineRunId,
  submissions: readonly SubmissionSnapshot[],
  selected: readonly RuntimeStep[],
  shape: SubmissionShape,
  integration?: IntegrationProof,
  lineage: { parent?: LineRunId; isolationPart?: 0 | 1 } = {},
): {
  run: LineStart
  events: EventDraft[]
  effects: EffectRequest<StepExecution, EffectOutcome<unknown>>[]
} {
  const submission = submissions[0]
  if (submission === undefined) throw new Error("yrd: a line run requires at least one submission")
  const run: LineStart = {
    id,
    submission,
    submissions: [...submissions],
    base: submission.base,
    selected: selected.map((step) => step.descriptor.name),
    cursor: 0,
    ...(integration === undefined ? {} : { integration }),
    ...lineage,
  }
  return {
    run,
    events: [event("line/run/started", { run })],
    effects: selected[0] === undefined ? [] : [requestStep(selected[0], run, 0, shape)],
  }
}

function requestStep(
  step: RuntimeStep,
  run: Pick<LineRecord, "id" | "submission" | "submissions">,
  index: number,
  shape: SubmissionShape,
): EffectRequest<StepExecution, EffectOutcome<unknown>> {
  return effect(
    step.effect,
    {
      run: run.id,
      step: step.descriptor.name,
      index,
      submission: run.submission,
      submissions: run.submissions,
      shape,
    },
    `line:${run.id}:${index}`,
  )
}

function shapeThrough(
  record: LineRecord,
  effects: Record<string, EffectRun>,
  registry: StepRegistry,
  limit = record.selected.length,
): SubmissionShape {
  const hasMerge = record.selected.some((name) => registry.require(name).descriptor.integrates)
  let shape: SubmissionShape = {
    ...submissionShape(record.submissions),
    ...(record.integration === undefined || hasMerge ? {} : { integration: record.integration }),
  }
  for (let index = 0; index < Math.min(limit, record.selected.length); index++) {
    const name = record.selected[index]
    const run = effects[record.effectIds[index] ?? ""]
    if (name === undefined || run?.status !== "passed") break
    shape = registry.require(name).apply(shape, run.output)
  }
  return shape
}

function validateSequence(steps: readonly RuntimeStep[], alreadyIntegrated: boolean): void {
  let integrated = alreadyIntegrated
  for (const step of steps) {
    if (step.descriptor.needsIntegration && !integrated) {
      throw new Error(`yrd: line step '${step.descriptor.name}' requires integration output before it can run`)
    }
    if (!step.descriptor.integrates) continue
    if (integrated) throw new Error("yrd: merge step cannot run after the submission is already integrated")
    integrated = true
  }
}

function requestedSubmissions(state: BaysState, args: IntegrateArgs): Submission[] {
  const selectors =
    typeof args.submission === "string"
      ? [args.submission]
      : args.submissions === undefined || args.submissions.length === 0
        ? undefined
        : args.submissions
  const submissions =
    selectors === undefined
      ? Object.values(state.submissions)
          .filter(
            (submission) =>
              submission.status === "submitted" || (args.retry === true && submission.status === "rejected"),
          )
          .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
      : selectors.map((selector) => {
          const submission = resolveSubmission(state, selector)
          if (submission === undefined) throw new Error(`yrd: no submission '${selector}'`)
          return submission
        })
  const ids = new Set<string>()
  for (const submission of submissions) {
    if (ids.has(submission.id)) throw new Error(`yrd: line.integrate: duplicate submission '${submission.id}'`)
    ids.add(submission.id)
    if (submission.status === "rejected" && args.retry !== true) {
      throw new Error(`yrd: submission '${submission.id}' is rejected; retry=true is required`)
    }
    if (submission.status !== "submitted" && submission.status !== "rejected" && submission.status !== "integrated") {
      throw new Error(`yrd: submission '${submission.id}' is ${submission.status}, not ready for the line`)
    }
  }
  return submissions
}

function partitionCandidates(submissions: readonly Submission[], batchSize: number): Submission[][] {
  const groups = new Map<string, Submission[]>()
  for (const submission of submissions) {
    const proof = submission.integration
    const key = `${submission.base}\0${proof?.commit ?? ""}\0${proof?.baseSha ?? ""}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [submission])
    else group.push(submission)
  }
  const candidates: Submission[][] = []
  for (const group of groups.values()) {
    for (let index = 0; index < group.length; index += batchSize) candidates.push(group.slice(index, index + batchSize))
  }
  return candidates
}

function snapshot(submission: Submission): SubmissionSnapshot {
  return {
    id: submission.id,
    ...(submission.bay === undefined ? {} : { bay: submission.bay }),
    ...(submission.name === undefined ? {} : { name: submission.name }),
    branch: submission.branch,
    base: submission.base,
    revision: submission.revision,
    headSha: submission.headSha,
    ...(submission.baseSha === undefined ? {} : { baseSha: submission.baseSha }),
  }
}

function submissionShape(submissions: readonly SubmissionSnapshot[]): SubmissionShape {
  const submission = submissions[0]
  if (submission === undefined) throw new Error("yrd: a line run requires at least one submission")
  return { submission, submissions: [...submissions], results: {} }
}

function integratedSubmissionShape(submissions: readonly Submission[]): IntegratedShape | undefined {
  if (submissions.every((submission) => submission.status !== "integrated")) return undefined
  const proof = submissions[0]?.integration
  if (
    proof === undefined ||
    submissions.some(
      (submission) =>
        submission.status !== "integrated" ||
        submission.integration?.commit !== proof.commit ||
        submission.integration?.baseSha !== proof.baseSha,
    )
  ) {
    throw new Error("yrd: every submission in a line candidate must share one integration proof")
  }
  return { ...submissionShape(submissions.map(snapshot)), integration: proof }
}

function pinnedSubmissionError(state: BaysState, snapshots: readonly SubmissionSnapshot[]): EffectError | undefined {
  for (const snapshot of snapshots) {
    const current = state.submissions[snapshot.id]
    if (
      current === undefined ||
      current.revision !== snapshot.revision ||
      current.headSha !== snapshot.headSha ||
      current.base !== snapshot.base
    ) {
      return {
        code: "stale-submission",
        message: `submission '${snapshot.id}' changed after line run pinned revision ${snapshot.revision} (${snapshot.headSha})`,
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
  const failed = run.steps.findIndex((step) => step.status === "failed" || step.status === "lost")
  return (
    run.status === "failed" &&
    failed >= 0 &&
    run.cursor > failed &&
    !isIntegrated(run.shape) &&
    run.submissions.length > 1
  )
}

function pendingAdvance(run: LineRun): boolean {
  const step = run.steps[run.cursor]
  return step?.status === "passed" || step?.status === "failed" || step?.status === "lost"
}

function isIntegrated(shape: SubmissionShape): shape is IntegratedShape {
  return "integration" in shape
}

function effectFailure(run: EffectRun): EffectError {
  return run.error ?? { code: "effect-lost", message: run.lostReason ?? "step executor was lost" }
}

function parseIntegrationProof(input: unknown): IntegrationProof {
  const value = object(input, "merge output")
  return { commit: fullSha(value.commit, "commit"), baseSha: fullSha(value.baseSha, "baseSha") }
}

function fullSha(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/iu.test(value)) {
    throw new Error(`yrd: merge output '${field}' must be a full Git commit SHA`)
  }
  return value
}

function parseIntegrate(input: unknown): IntegrateArgs {
  const args = object(input, "line.integrate")
  const submission = args.submission
  const submissions = optionalStrings(
    args.submissions,
    "yrd: line.integrate: 'submissions' must be an array of non-empty strings",
  )
  if (submission !== undefined && submissions !== undefined) {
    throw new Error("yrd: line.integrate: use either 'submission' or 'submissions', not both")
  }
  if (submission !== undefined && (typeof submission !== "string" || submission.trim() === "")) {
    throw new Error("yrd: line.integrate: 'submission' must be a non-empty string")
  }
  const steps = optionalStrings(args.steps, "yrd: line.integrate: 'steps' must be an array of step names")
  if (args.retry !== undefined && typeof args.retry !== "boolean") {
    throw new Error("yrd: line.integrate: 'retry' must be boolean")
  }
  const options = {
    ...(steps === undefined ? {} : { steps }),
    ...(args.retry === true ? { retry: true } : {}),
  }
  return submission === undefined
    ? { ...options, ...(submissions === undefined ? {} : { submissions }) }
    : { ...options, submission }
}

function object(input: unknown, command: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`yrd: ${command}: arguments must be an object`)
  }
  return input as Record<string, unknown>
}

function optionalStrings(value: unknown, error: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(error)
  }
  return [...value] as string[]
}

async function stateOf(app: AnyYrdApp): Promise<RuntimeState> {
  return (await app.state()) as RuntimeState
}
