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
  type BatchConfig,
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

type AdvanceArgs = { run: LineRunId }
type IsolateArgs = AdvanceArgs & { part: 0 | 1 }

type LineCommands = {
  line: {
    integrate: Command<IntegrateArgs, { lines: LinesState; bays: BaysState }>
    advance: Command<AdvanceArgs, { lines: LinesState; effects: { runs: Record<string, EffectRun> } }>
    resume: Command<AdvanceArgs, { lines: LinesState; effects: { runs: Record<string, EffectRun> } }>
    isolate: Command<IsolateArgs, { lines: LinesState }>
  }
}

export type LineRunOptions = {
  executor: string
  leaseMs: number
  now?: () => number
}

export type IntegrateLine = {
  (args: SingleIntegrateArgs, options: LineRunOptions): Promise<LineRun>
  (args: BatchIntegrateArgs, options: LineRunOptions): Promise<LineRun[]>
}

export type LineRuntime<Shape extends SubmissionShape = SubmissionShape> = {
  readonly output: Shape
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
  configureBatch(config: BatchConfig): void
  configureDefaultSteps(names: readonly string[]): void
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
  const submission = args.submission
  const submissions = args.submissions
  if (submission !== undefined && submissions !== undefined) {
    throw new Error("yrd: line.integrate: use either 'submission' or 'submissions', not both")
  }
  if (submission !== undefined && (typeof submission !== "string" || submission.trim() === "")) {
    throw new Error("yrd: line.integrate: 'submission' must be a non-empty string")
  }
  if (
    submissions !== undefined &&
    (!Array.isArray(submissions) ||
      submissions.some((selector) => typeof selector !== "string" || selector.trim() === ""))
  ) {
    throw new Error("yrd: line.integrate: 'submissions' must be an array of non-empty strings")
  }
  const steps = args.steps
  if (steps !== undefined && (!Array.isArray(steps) || steps.some((step) => typeof step !== "string" || step === ""))) {
    throw new Error("yrd: line.integrate: 'steps' must be an array of step names")
  }
  if (args.retry !== undefined && typeof args.retry !== "boolean") {
    throw new Error("yrd: line.integrate: 'retry' must be boolean")
  }
  const options = {
    ...(steps === undefined ? {} : { steps: [...steps] as string[] }),
    ...(args.retry === true ? { retry: true } : {}),
  }
  return submission === undefined
    ? { ...options, ...(submissions === undefined ? {} : { submissions: [...submissions] as string[] }) }
    : { ...options, submission }
}

function parseAdvance(input: unknown): AdvanceArgs {
  const args = object(input, "line.advance")
  return { run: requiredString(args, "run", "line.advance") }
}

function parseIsolate(input: unknown): IsolateArgs {
  const args = object(input, "line.isolate")
  if (args.part !== 0 && args.part !== 1) throw new Error("yrd: line.isolate: 'part' must be 0 or 1")
  return { run: requiredString(args, "run", "line.isolate"), part: args.part }
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

function normalizeBatchConfig(config: BatchConfig): number {
  if (config === false) return 1
  if (!Number.isInteger(config) || config < 0) {
    throw new Error("yrd: batch size must be false or a non-negative integer")
  }
  return config <= 1 ? 1 : config
}

function submissionShape(submissions: readonly SubmissionSnapshot[]): SubmissionShape {
  const submission = submissions[0]
  if (submission === undefined) throw new Error("yrd: a line run requires at least one submission")
  return { submission, submissions: [...submissions], results: {} }
}

function integrationShape(submissions: readonly Submission[]): IntegratedShape | undefined {
  const integrated = submissions.filter((submission) => submission.status === "integrated")
  if (integrated.length === 0) return undefined
  if (integrated.length !== submissions.length) {
    throw new Error("yrd: a line candidate cannot mix integrated and unintegrated submissions")
  }
  const proof = integrated[0]?.integration
  if (proof === undefined) throw new Error(`yrd: integrated submission '${integrated[0]!.id}' has no integration proof`)
  if (
    integrated.some(
      (submission) =>
        submission.integration?.commit !== proof.commit || submission.integration?.baseSha !== proof.baseSha,
    )
  ) {
    throw new Error("yrd: integrated submissions with different landing commits cannot share a line candidate")
  }
  const snapshots = submissions.map(snapshot)
  return {
    submission: snapshots[0]!,
    submissions: snapshots,
    results: {},
    integration: proof,
  }
}

function eligibleSubmissions(state: BaysState, retry: boolean): Submission[] {
  return Object.values(state.submissions)
    .filter((submission) => submission.status === "submitted" || (retry && submission.status === "rejected"))
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
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
      ? eligibleSubmissions(state, args.retry === true)
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

function guardPinnedSubmissions<Shape extends SubmissionShape, Output>(
  app: AnyYrdApp & HasBays,
  runner: StepRunner<Shape, Output>,
): StepRunner<Shape, Output> {
  return async (input, context) => {
    const stale = pinnedSubmissionError((await app.state()).bays, input.submissions)
    return stale === undefined ? await runner(input, context) : { status: "failed", error: stale }
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
      run: Pick<LineRun, "id" | "submission" | "submissions">,
      index: number,
      shape: SubmissionShape | IntegratedShape,
    ) =>
      effect(
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

    const createRun = (
      id: LineRunId,
      submissions: readonly SubmissionSnapshot[],
      selected: readonly RuntimeStep[],
      shape: SubmissionShape | IntegratedShape,
      lineage: { parent?: LineRunId; isolationPart?: 0 | 1 } = {},
    ): Omit<LineRun, "startedAt"> => ({
      id,
      submission: submissions[0]!,
      submissions: [...submissions],
      base: submissions[0]!.base,
      status: "running",
      selected: selected.map((step) => step.descriptor.name),
      cursor: 0,
      steps: selected.map((step, index) => ({ name: step.descriptor.name, index, status: "queued" })),
      shape,
      ...lineage,
    })

    const startRun = (run: Omit<LineRun, "startedAt">, selected: readonly RuntimeStep[]) => {
      const events: EventDraft[] = [event("line/run/started", { run })]
      if (selected.length === 0) events.push(event("line/run/finished", { run: run.id, status: "passed" }))
      return {
        events,
        effects: selected.length === 0 ? [] : [requestFor(selected[0]!, run, 0, run.shape)],
      }
    }

    const integrate = op(
      (state: DeepReadonly<{ lines: LinesState; bays: BaysState }>, args: IntegrateArgs) => {
        const submissions = requestedSubmissions(state.bays as BaysState, args)
        if (submissions.length === 0) return { events: [], effects: [] }
        const bases = new Set(submissions.map((submission) => submission.base))
        if (bases.size !== 1) throw new Error("yrd: one line candidate cannot span multiple base branches")
        if (submissions.length > state.lines.batchSize) {
          throw new Error(
            `yrd: line candidate has ${submissions.length} submissions; configured batch size is ${state.lines.batchSize}`,
          )
        }
        const active = Object.values(state.lines.runs).find(
          (run) => run.base === submissions[0]!.base && run.status === "running",
        )
        if (active !== undefined) throw new Error(`yrd: line '${submissions[0]!.base}' is running '${active.id}'`)

        const selected = selectedSteps(runtimeSteps, args.steps ?? state.lines.defaultSteps)
        const integrated = integrationShape(submissions)
        validateSequence(selected, integrated !== undefined)
        const id = nextRunId(state.lines as LinesState)
        const snapshots = submissions.map(snapshot)
        const shape = integrated ?? submissionShape(snapshots)
        return startRun(createRun(id, snapshots, selected, shape), selected)
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
          if (!("integration" in run.shape) && run.submissions.length === 1) {
            events.push(
              event("submission/rejected", {
                submission: run.submissions[0]!.id,
                revision: run.submissions[0]!.revision,
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
          for (const submission of run.submissions) {
            events.push(
              event("submission/integrated", {
                submission: submission.id,
                revision: submission.revision,
                headSha: submission.headSha,
                commit: proof.commit,
                baseSha: proof.baseSha,
              }),
            )
          }
        }
        const nextIndex = run.cursor + 1
        const next = runtimeSteps.find((step) => step.descriptor.name === run.selected[nextIndex])
        if (next === undefined) {
          events.push(event("line/run/finished", { run: run.id, status: "passed" }))
          return { events, effects: [] }
        }
        return {
          events,
          effects: [requestFor(next, run, nextIndex, shape)],
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

    const isolate = op(
      (state: DeepReadonly<{ lines: LinesState }>, args: IsolateArgs) => {
        const parent = requiredRun(state.lines as LinesState, args.run)
        const existing = Object.values(state.lines.runs).find(
          (candidate) => candidate.parent === parent.id && candidate.isolationPart === args.part,
        )
        if (existing !== undefined) return { events: [], effects: [] }
        if (parent.status !== "failed" || "integration" in parent.shape || parent.submissions.length < 2) {
          throw new Error(`yrd: line run '${parent.id}' is not a failed pre-merge batch`)
        }
        const active = Object.values(state.lines.runs).find(
          (candidate) => candidate.base === parent.base && candidate.status === "running",
        )
        if (active !== undefined) throw new Error(`yrd: line '${parent.base}' is running '${active.id}'`)

        const pivot = Math.ceil(parent.submissions.length / 2)
        const submissions = args.part === 0 ? parent.submissions.slice(0, pivot) : parent.submissions.slice(pivot)
        if (submissions.length === 0) throw new Error(`yrd: line run '${parent.id}' has no isolation part ${args.part}`)
        const selected = parent.selected.map((name) => {
          const step = runtimeSteps.find((candidate) => candidate.descriptor.name === name)
          if (step === undefined) throw new Error(`yrd: line step '${name}' is no longer installed`)
          return step
        })
        const id = nextRunId(state.lines as LinesState)
        const child = createRun(id, submissions, selected, submissionShape(submissions), {
          parent: parent.id,
          isolationPart: args.part,
        })
        const started = startRun(child, selected)
        return {
          events: [
            event("line/batch/isolated", {
              parent: parent.id,
              run: child.id,
              part: args.part,
              submissions: submissions.map((submission) => submission.id),
            }),
            ...started.events,
          ],
          effects: started.effects,
        }
      },
      { title: "Isolate failed line batch", visibility: "internal", args: { parse: parseIsolate } },
    )

    Object.assign(app.commands, { line: { integrate, advance, resume, isolate } })

    const project = app.project
    app.project = (state, applied) => {
      const projected = project(state, applied)
      const current = linesOf(projected)
      const next = projectLineState(current, applied, effectsOf(projected))
      return next === current ? projected : { ...projected, lines: next }
    }

    const startedRun = (events: readonly YrdEvent[]): LineRunId | undefined => {
      const row = events.find((applied) => applied.name === "line/run/started")
      return row === undefined ? undefined : ((row.data as { run: LineRun }).run.id as LineRunId)
    }

    const childRun = (state: LinesState, parent: LineRunId, part: 0 | 1): LineRun | undefined =>
      Object.values(state.runs).find((run) => run.parent === parent && run.isolationPart === part)

    const runIdOrder = (left: LineRun, right: LineRun): number => {
      const leftNumber = Number(/^R(\d+)$/u.exec(left.id)?.[1] ?? Number.MAX_SAFE_INTEGER)
      const rightNumber = Number(/^R(\d+)$/u.exec(right.id)?.[1] ?? Number.MAX_SAFE_INTEGER)
      return leftNumber - rightNumber || left.id.localeCompare(right.id)
    }

    const runTree = (state: LinesState, root: LineRunId): LineRun[] => {
      const result: LineRun[] = []
      const visit = (id: LineRunId): void => {
        const run = state.runs[id]
        if (run === undefined) return
        result.push(run)
        for (const child of Object.values(state.runs)
          .filter((candidate) => candidate.parent === id)
          .sort(runIdOrder)) {
          visit(child.id)
        }
      }
      visit(root)
      return result
    }

    const partitionCandidates = (submissions: readonly Submission[], batchSize: number): Submission[][] => {
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
        for (let index = 0; index < group.length; index += batchSize) {
          candidates.push(group.slice(index, index + batchSize))
        }
      }
      return candidates
    }

    let runtime: InternalLineRuntime

    const driveRun = async (id: LineRunId, options: LineRunOptions): Promise<LineRun> => {
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
        if (effectRun.status === "running" || effectRun.status === "waiting") {
          return requiredRun((await app.state()).lines, id)
        }
        if (run.status === "waiting") {
          const resumed = await app.command(resume, { run: id })
          if (resumed.events.length === 0) return requiredRun((await app.state()).lines, id)
        }
        await app.command(advance, { run: id })
      }
    }

    const settleRun = async (id: LineRunId, options: LineRunOptions): Promise<LineRun> => {
      const settled = await driveRun(id, options)
      if (settled.status !== "failed" || "integration" in settled.shape || settled.submissions.length < 2) {
        return settled
      }
      for (const part of [0, 1] as const) {
        let child = childRun((await app.state()).lines, settled.id, part)
        if (child === undefined) {
          const isolated = await app.command(isolate, { run: settled.id, part })
          const childId = startedRun(isolated.events)
          child =
            childId === undefined ? childRun((await app.state()).lines, settled.id, part) : await runtime.get(childId)
        }
        if (child === undefined) throw new Error(`yrd: line run '${settled.id}' did not create isolation part ${part}`)
        await settleRun(child.id, options)
      }
      return requiredRun((await app.state()).lines, id)
    }

    const integrateRuntime = (async (args: IntegrateArgs, options: LineRunOptions): Promise<LineRun | LineRun[]> => {
      if (typeof args.submission === "string") {
        const started = await app.command(integrate, args)
        const id = startedRun(started.events)
        if (id === undefined) throw new Error("yrd: line integrate did not start a run")
        return await runtime.run(id, options)
      }

      const state = await app.state()
      const submissions = requestedSubmissions(state.bays, args)
      if (submissions.length === 0) return []
      const roots: LineRunId[] = []
      for (const candidate of partitionCandidates(submissions, state.lines.batchSize)) {
        const started = await app.command(integrate, {
          submissions: candidate.map((submission) => submission.id),
          ...(args.steps === undefined ? {} : { steps: args.steps }),
          ...(args.retry === true ? { retry: true } : {}),
        })
        const id = startedRun(started.events)
        if (id === undefined) throw new Error("yrd: line integrate did not start a run")
        roots.push(id)
        await runtime.run(id, options)
      }
      const lines = (await app.state()).lines
      return roots.flatMap((root) => runTree(lines, root))
    }) as IntegrateLine

    runtime = {
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
      configureBatch(config) {
        ;(app.initialState.lines as LinesState).batchSize = normalizeBatchConfig(config)
      },
      configureDefaultSteps(names) {
        const selected = selectedSteps(runtimeSteps, names)
        validateSequence(selected, false)
        ;(app.initialState.lines as LinesState).defaultSteps = selected.map((step) => step.descriptor.name)
      },
      steps() {
        return runtimeSteps.map((step) => step.descriptor)
      },
      integrate: integrateRuntime,
      async run(id, options) {
        return await settleRun(id, options)
      },
      async recover(options) {
        await app.effectRuns.recover({
          now: options.recoveryTime,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        })
        const state = await app.state()
        const recovered: LineRun[] = []
        for (const run of Object.values((state.lines as LinesState).runs).sort(runIdOrder)) {
          if (
            terminal(run) &&
            !(run.status === "failed" && !("integration" in run.shape) && run.submissions.length > 1)
          ) {
            continue
          }
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

export function withBatch(config: BatchConfig) {
  return <App extends AnyYrdApp & HasLine<any>>(app: App): App => {
    ;(app.line as InternalLineRuntime).configureBatch(config)
    return app
  }
}

/** Select the installed steps used when line.integrate omits --steps. Apply
 * this after withStep()/withMerge() so unknown names fail during composition. */
export function withDefaultSteps(names: readonly string[]) {
  return <App extends AnyYrdApp & HasLine<any>>(app: App): App => {
    try {
      ;(app.line as InternalLineRuntime).configureDefaultSteps(names)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("unknown step")) {
        const name = /'([^']+)'/u.exec(message)?.[1] ?? "unknown"
        throw new Error(`yrd: unknown default line step '${name}'`)
      }
      throw error
    }
    return app
  }
}

export function withStep<const Name extends string, Shape extends SubmissionShape, Output>(
  name: Name,
  runner: StepRunner<Shape, Output>,
  options: StepOptions = {},
) {
  return <App extends AnyYrdApp & HasBays & HasLine<Shape>>(
    app: App,
  ): ReplaceLine<App, AddStepResult<Shape, Name, Output>> => {
    const step = fx(guardPinnedSubmissions(app, runner), { title: options.title ?? name })
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
  return <App extends AnyYrdApp & HasBays & HasLine<Shape>>(app: App): ReplaceLine<App, Shape & IntegratedShape> => {
    const merge = fx(guardPinnedSubmissions(app, runner), { title: "merge" })
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
