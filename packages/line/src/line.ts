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
  type EffectRun,
  type EventDraft,
  type ExtendYrdApp,
  type Fx,
  type HasEffects,
  type YrdEvent,
} from "@yrd/core"
import { resolveSubmission, type BaysState, type HasBays, type Submission } from "@yrd/bay"
import {
  emptyLinesState,
  lineSummary,
  type AddStepResult,
  type InstalledStep,
  type IntegratedShape,
  type IntegrationProof,
  type LineRun,
  type LineRunId,
  type LinesState,
  type LineSummary,
  type SubmissionShape,
  type SubmissionSnapshot,
} from "./model.ts"

export type StepExecution<Shape extends SubmissionShape = SubmissionShape> = {
  run: LineRunId
  step: string
  index: number
  submission: SubmissionSnapshot
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

export type IntegrateArgs = {
  submission: string
  steps?: string[]
  retry?: boolean
}

type AdvanceArgs = { run: LineRunId }

type LineCommands = {
  line: {
    integrate: Command<IntegrateArgs, { lines: LinesState; bays: BaysState }>
    advance: Command<AdvanceArgs, { lines: LinesState; effects: { runs: Record<string, EffectRun> } }>
    resume: Command<AdvanceArgs, { lines: LinesState; effects: { runs: Record<string, EffectRun> } }>
  }
}

export type LineRunOptions = {
  executor: string
  leaseMs: number
  now?: () => number
}

export type LineRuntime<Shape extends SubmissionShape = SubmissionShape> = {
  readonly output: Shape
  steps(): readonly InstalledStep[]
  integrate(args: IntegrateArgs, options: LineRunOptions): Promise<LineRun>
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

type LinesApp<App extends AnyYrdApp, Shape extends SubmissionShape> = ExtendYrdApp<
  App,
  { lines: LinesState },
  LineCommands
> & {
  line: LineRuntime<Shape>
}

type ReplaceLine<App, Shape extends SubmissionShape> = Omit<App, "line"> & { line: LineRuntime<Shape> }

type RuntimeStep = {
  descriptor: InstalledStep
  effect: Fx<StepExecution<any>, EffectOutcome<any>>
  apply(shape: SubmissionShape | IntegratedShape, output: unknown): SubmissionShape | IntegratedShape
}

type InternalLineRuntime = LineRuntime<any> & {
  install(step: RuntimeStep): void
}

function object(input: unknown, command: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`yrd: ${command}: arguments must be an object`)
  }
  return input as Record<string, unknown>
}

function requiredString(input: Record<string, unknown>, field: string, command: string): string {
  const value = input[field]
  if (typeof value !== "string" || value.trim() === "") throw new Error(`yrd: ${command}: '${field}' is required`)
  return value
}

function parseIntegrate(input: unknown): IntegrateArgs {
  const args = object(input, "line.integrate")
  const steps = args.steps
  if (steps !== undefined && (!Array.isArray(steps) || steps.some((step) => typeof step !== "string" || step === ""))) {
    throw new Error("yrd: line.integrate: 'steps' must be an array of step names")
  }
  if (args.retry !== undefined && typeof args.retry !== "boolean") {
    throw new Error("yrd: line.integrate: 'retry' must be boolean")
  }
  return {
    submission: requiredString(args, "submission", "line.integrate"),
    ...(steps === undefined ? {} : { steps: [...steps] as string[] }),
    ...(args.retry === true ? { retry: true } : {}),
  }
}

function parseAdvance(input: unknown): AdvanceArgs {
  const args = object(input, "line.advance")
  return { run: requiredString(args, "run", "line.advance") }
}

function linesOf(state: unknown): LinesState {
  return (state as { lines: LinesState }).lines
}

function effectsOf(state: unknown): Record<string, EffectRun> {
  return (state as { effects: { runs: Record<string, EffectRun> } }).effects.runs
}

function nextRunId(state: LinesState): LineRunId {
  let largest = 0
  for (const id of Object.keys(state.runs)) {
    const match = /^R(\d+)$/u.exec(id)
    if (match !== null) largest = Math.max(largest, Number(match[1]))
  }
  return `R${largest + 1}`
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

function integrationShape(submission: Submission): IntegratedShape | undefined {
  if (submission.status !== "integrated" || submission.integration === undefined) return undefined
  return {
    submission: snapshot(submission),
    results: {},
    integration: submission.integration,
  }
}

function requiredRun(state: LinesState, id: LineRunId): LineRun {
  const run = state.runs[id]
  if (run === undefined) throw new Error(`yrd: no line run '${id}'`)
  return run
}

function terminal(run: LineRun): boolean {
  return run.status === "passed" || run.status === "failed"
}

function fullSha(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/iu.test(value)) {
    throw new Error(`yrd: merge output '${field}' must be a full Git commit SHA`)
  }
  return value
}

function integrationProof(input: unknown): IntegrationProof {
  const value = object(input, "merge output")
  return { commit: fullSha(value.commit, "commit"), baseSha: fullSha(value.baseSha, "baseSha") }
}

function failure(run: EffectRun): EffectError {
  return run.error ?? { code: "effect-lost", message: run.lostReason ?? "step executor was lost" }
}

function replaceRun(state: LinesState, run: LineRun): LinesState {
  return { ...state, runs: { ...state.runs, [run.id]: run } }
}

function projectLineState(state: LinesState, applied: YrdEvent, effectRuns: Record<string, EffectRun>): LinesState {
  const data = applied.data as Record<string, unknown>
  if (applied.name === "line/run/started") {
    const run = data.run as unknown as LineRun
    return replaceRun(state, { ...run, startedAt: applied.ts })
  }
  if (applied.name === "line/run/resumed") {
    const run = state.runs[data.run as string]
    return run === undefined ? state : replaceRun(state, { ...run, status: "running" })
  }
  if (applied.name === "line/step/finished") {
    const run = state.runs[data.run as string]
    if (run === undefined) return state
    const index = data.index as number
    const current = run.steps[index]
    if (current === undefined) return state
    const passed = data.status === "passed"
    const step = {
      ...current,
      status: passed ? ("passed" as const) : data.status === "lost" ? ("lost" as const) : ("failed" as const),
      finishedAt: applied.ts,
      ...(data.output === undefined ? {} : { output: data.output }),
      ...(data.error === undefined ? {} : { error: data.error as EffectError }),
    }
    const steps = [...run.steps]
    steps[index] = step
    return replaceRun(state, {
      ...run,
      steps,
      cursor: index + 1,
      ...(data.shape === undefined ? {} : { shape: data.shape as SubmissionShape | IntegratedShape }),
    })
  }
  if (applied.name === "line/run/finished") {
    const run = state.runs[data.run as string]
    if (run === undefined) return state
    return replaceRun(state, {
      ...run,
      status: data.status === "passed" ? "passed" : "failed",
      finishedAt: applied.ts,
      ...(data.error === undefined ? {} : { error: data.error as EffectError }),
    })
  }
  if (!applied.name.startsWith("effect/")) return state

  const id = data.id as string
  const effectRun = effectRuns[id]
  if (effectRun === undefined || !effectRun.effect.startsWith("line.step.")) return state
  const input = effectRun.input as StepExecution
  const run = state.runs[input.run]
  const current = run?.steps[input.index]
  if (run === undefined || current === undefined) return state
  const steps = [...run.steps]
  let nextRun = run
  if (applied.name === "effect/requested") {
    steps[input.index] = { ...current, status: "requested", effectId: id }
  } else if (applied.name === "effect/started" || applied.name === "effect/heartbeat") {
    steps[input.index] = {
      ...current,
      status: "running",
      effectId: id,
      attempt: effectRun.attempt,
      startedAt: current.startedAt ?? applied.ts,
    }
    nextRun = { ...run, status: "running" }
  } else if (applied.name === "effect/waiting") {
    steps[input.index] = {
      ...current,
      status: "waiting",
      effectId: id,
      attempt: effectRun.attempt,
      token: effectRun.token,
      url: effectRun.url,
      detail: effectRun.detail,
      artifacts: effectRun.artifacts,
    }
    nextRun = { ...run, status: "waiting" }
  } else {
    return state
  }
  return replaceRun(state, { ...nextRun, steps })
}

function selectedSteps(steps: readonly RuntimeStep[], requested: readonly string[] | undefined): RuntimeStep[] {
  if (requested === undefined) return [...steps]
  const names = new Set(requested)
  if (names.size !== requested.length) throw new Error("yrd: line.integrate: duplicate step name")
  for (const name of names) {
    if (!steps.some((step) => step.descriptor.name === name))
      throw new Error(`yrd: line.integrate: unknown step '${name}'`)
  }
  return steps.filter((step) => names.has(step.descriptor.name))
}

function validateSequence(steps: readonly RuntimeStep[], integrated: boolean): void {
  let hasIntegration = integrated
  for (const step of steps) {
    if (step.descriptor.needsIntegration && !hasIntegration) {
      throw new Error(`yrd: line step '${step.descriptor.name}' requires integration output before it can run`)
    }
    if (step.descriptor.kind === "merge") {
      if (hasIntegration) throw new Error("yrd: merge step cannot run after the submission is already integrated")
      hasIntegration = true
    }
  }
}

export function withLine() {
  return <App extends AnyYrdApp & HasEffects & HasBays>(app: App): LinesApp<App, SubmissionShape> => {
    Object.assign(app.initialState, { lines: emptyLinesState() })
    const runtimeSteps: RuntimeStep[] = []

    const requestFor = (
      step: RuntimeStep,
      run: LineRunId,
      index: number,
      submission: SubmissionSnapshot,
      shape: SubmissionShape | IntegratedShape,
    ) => effect(step.effect, { run, step: step.descriptor.name, index, submission, shape }, `line:${run}:${index}`)

    const integrate = op(
      (state: DeepReadonly<{ lines: LinesState; bays: BaysState }>, args: IntegrateArgs) => {
        const submission = resolveSubmission(state.bays as BaysState, args.submission)
        if (submission === undefined) throw new Error(`yrd: no submission '${args.submission}'`)
        if (submission.status === "rejected" && args.retry !== true) {
          throw new Error(`yrd: submission '${submission.id}' is rejected; retry=true is required`)
        }
        if (
          submission.status !== "submitted" &&
          submission.status !== "rejected" &&
          submission.status !== "integrated"
        ) {
          throw new Error(`yrd: submission '${submission.id}' is ${submission.status}, not ready for the line`)
        }
        const active = Object.values(state.lines.runs).find(
          (run) => run.base === submission.base && run.status === "running",
        )
        if (active !== undefined) throw new Error(`yrd: line '${submission.base}' is running '${active.id}'`)

        const selected = selectedSteps(runtimeSteps, args.steps)
        const integrated = integrationShape(submission)
        validateSequence(selected, integrated !== undefined)
        const id = nextRunId(state.lines as LinesState)
        const shape: SubmissionShape | IntegratedShape = integrated ?? { submission: snapshot(submission), results: {} }
        const run: Omit<LineRun, "startedAt"> = {
          id,
          submission: snapshot(submission),
          base: submission.base,
          status: "running",
          selected: selected.map((step) => step.descriptor.name),
          cursor: 0,
          steps: selected.map((step, index) => ({ name: step.descriptor.name, index, status: "queued" })),
          shape,
        }
        const events: EventDraft[] = [event("line/run/started", { run })]
        if (selected.length === 0) events.push(event("line/run/finished", { run: id, status: "passed" }))
        return {
          events,
          effects: selected.length === 0 ? [] : [requestFor(selected[0]!, id, 0, run.submission, shape)],
        }
      },
      { title: "Integrate submission", visibility: "public", args: { parse: parseIntegrate } },
    )

    const advance = op(
      (state: DeepReadonly<{ lines: LinesState; effects: { runs: Record<string, EffectRun> } }>, args: AdvanceArgs) => {
        const run = requiredRun(state.lines as LinesState, args.run)
        if (terminal(run)) return { events: [], effects: [] }
        const stepEvidence = run.steps[run.cursor]
        if (stepEvidence === undefined || stepEvidence.effectId === undefined) {
          throw new Error(`yrd: line run '${run.id}' has no requested step at index ${run.cursor}`)
        }
        const effectRun = effectsOf(state)[stepEvidence.effectId]
        if (effectRun === undefined) throw new Error(`yrd: line run '${run.id}' lost effect '${stepEvidence.effectId}'`)
        if (effectRun.status === "requested" || effectRun.status === "running" || effectRun.status === "waiting") {
          throw new Error(`yrd: line run '${run.id}' step '${stepEvidence.name}' is ${effectRun.status}`)
        }
        const installed = runtimeSteps.find((step) => step.descriptor.name === stepEvidence.name)
        if (installed === undefined) throw new Error(`yrd: line step '${stepEvidence.name}' is no longer installed`)

        if (effectRun.status !== "passed") {
          const error = failure(effectRun as EffectRun)
          const events: EventDraft[] = [
            event("line/step/finished", {
              run: run.id,
              step: stepEvidence.name,
              index: run.cursor,
              status: effectRun.status,
              error,
            }),
            event("line/run/finished", { run: run.id, status: "failed", error }),
          ]
          if (!("integration" in run.shape)) {
            events.push(
              event("submission/rejected", {
                submission: run.submission.id,
                revision: run.submission.revision,
                detail: error.message,
              }),
            )
          }
          return { events, effects: [] }
        }

        const shape = installed.apply(run.shape, effectRun.output)
        const events: EventDraft[] = [
          event("line/step/finished", {
            run: run.id,
            step: stepEvidence.name,
            index: run.cursor,
            status: "passed",
            output: effectRun.output,
            shape,
          }),
        ]
        if (installed.descriptor.kind === "merge") {
          const proof = (shape as IntegratedShape).integration
          events.push(
            event("submission/integrated", {
              submission: run.submission.id,
              revision: run.submission.revision,
              headSha: run.submission.headSha,
              commit: proof.commit,
              baseSha: proof.baseSha,
            }),
          )
        }
        const nextIndex = run.cursor + 1
        const next = runtimeSteps.find((step) => step.descriptor.name === run.selected[nextIndex])
        if (next === undefined) {
          events.push(event("line/run/finished", { run: run.id, status: "passed" }))
          return { events, effects: [] }
        }
        return {
          events,
          effects: [requestFor(next, run.id, nextIndex, run.submission, shape)],
        }
      },
      { title: "Advance line run", visibility: "internal", args: { parse: parseAdvance } },
    )

    const resume = op(
      (state: DeepReadonly<{ lines: LinesState; effects: { runs: Record<string, EffectRun> } }>, args: AdvanceArgs) => {
        const run = requiredRun(state.lines as LinesState, args.run)
        if (run.status !== "waiting") return { events: [], effects: [] }
        const step = run.steps[run.cursor]
        const effectRun = step?.effectId === undefined ? undefined : effectsOf(state)[step.effectId]
        if (effectRun === undefined || effectRun.status === "waiting" || effectRun.status === "running") {
          return { events: [], effects: [] }
        }
        const active = Object.values(state.lines.runs).find(
          (candidate) => candidate.id !== run.id && candidate.base === run.base && candidate.status === "running",
        )
        return active === undefined
          ? { events: [event("line/run/resumed", { run: run.id })], effects: [] }
          : { events: [], effects: [] }
      },
      { title: "Resume line run", visibility: "internal", args: { parse: parseAdvance } },
    )

    Object.assign(app.commands, { line: { integrate, advance, resume } })

    const project = app.project
    app.project = (state, applied) => {
      const projected = project(state, applied)
      const current = linesOf(projected)
      const next = projectLineState(current, applied, effectsOf(projected))
      return next === current ? projected : { ...projected, lines: next }
    }

    const runtime: InternalLineRuntime = {
      output: undefined as unknown as SubmissionShape,
      install(step) {
        if (!/^[a-z][a-z0-9_-]*$/iu.test(step.descriptor.name)) {
          throw new Error(`yrd: invalid line step name '${step.descriptor.name}'`)
        }
        if (runtimeSteps.some((installed) => installed.descriptor.name === step.descriptor.name)) {
          throw new Error(`yrd: line step '${step.descriptor.name}' is already installed`)
        }
        const descriptor = { ...step.descriptor, index: runtimeSteps.length }
        const installed = { ...step, descriptor }
        runtimeSteps.push(installed)
        app.effectRuns.register(["line", "step", descriptor.name], installed.effect)
        ;(app.initialState.lines as LinesState).installed[descriptor.name] = descriptor
      },
      steps() {
        return runtimeSteps.map((step) => step.descriptor)
      },
      async integrate(args, options) {
        const started = await app.command(integrate, args)
        const row = started.events.find((applied) => applied.name === "line/run/started")
        if (row === undefined) throw new Error("yrd: line integrate did not start a run")
        return await runtime.run((row.data as { run: LineRun }).run.id, options)
      },
      async run(id, options) {
        while (true) {
          const state = await app.state()
          const run = requiredRun(state.lines, id)
          if (terminal(run)) return run
          const step = run.steps[run.cursor]
          if (step === undefined) {
            await app.command(advance, { run: id })
            continue
          }
          if (step.effectId === undefined) throw new Error(`yrd: line run '${id}' has no effect for '${step.name}'`)
          const effectRun = state.effects.runs[step.effectId]
          if (effectRun === undefined) throw new Error(`yrd: line run '${id}' lost effect '${step.effectId}'`)
          if (effectRun.status === "requested") {
            await app.effectRuns.run(step.effectId, options)
            continue
          }
          if (effectRun.status === "running" || effectRun.status === "waiting")
            return requiredRun((await app.state()).lines, id)
          if (run.status === "waiting") {
            const resumed = await app.command(resume, { run: id })
            if (resumed.events.length === 0) return requiredRun((await app.state()).lines, id)
          }
          await app.command(advance, { run: id })
        }
      },
      async recover(options) {
        await app.effectRuns.recover({
          now: options.recoveryTime,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        })
        const state = await app.state()
        const recovered: LineRun[] = []
        for (const run of Object.values((state.lines as LinesState).runs)) {
          if (terminal(run)) continue
          recovered.push(await runtime.run(run.id, options))
        }
        return recovered
      },
      async get(id) {
        return (await app.state()).lines.runs[id]
      },
      async status(base) {
        return lineSummary((await app.state()).lines, base)
      },
    }
    Object.assign(app, { line: runtime })
    return app as unknown as LinesApp<App, SubmissionShape>
  }
}

export function withStep<const Name extends string, Shape extends SubmissionShape, Output>(
  name: Name,
  runner: StepRunner<Shape, Output>,
  options: StepOptions = {},
) {
  return <App extends AnyYrdApp & HasLine<Shape>>(app: App): ReplaceLine<App, AddStepResult<Shape, Name, Output>> => {
    const step = fx(runner, { title: options.title ?? name })
    const runtime = app.line as InternalLineRuntime
    runtime.install({
      descriptor: {
        name,
        title: options.title ?? name,
        index: runtime.steps().length,
        kind: "step",
        needsIntegration: options.needsIntegration ?? false,
      },
      effect: step,
      apply(shape, output) {
        return { ...shape, results: { ...shape.results, [name]: output } }
      },
    })
    return app as unknown as ReplaceLine<App, AddStepResult<Shape, Name, Output>>
  }
}

export function withMerge<Shape extends SubmissionShape>(runner: StepRunner<Shape, IntegrationProof>) {
  return <App extends AnyYrdApp & HasLine<Shape>>(app: App): ReplaceLine<App, Shape & IntegratedShape> => {
    const merge = fx(runner, { title: "merge" })
    const runtime = app.line as InternalLineRuntime
    runtime.install({
      descriptor: {
        name: "merge",
        title: "merge",
        index: runtime.steps().length,
        kind: "merge",
        needsIntegration: false,
      },
      effect: merge,
      apply(shape, output) {
        return { ...shape, integration: integrationProof(output) }
      },
    })
    return app as unknown as ReplaceLine<App, Shape & IntegratedShape>
  }
}
