import { GitRefSchema, PRIdSchema, baseIdentity, resolvePR, type BaysState, type HasBays, type PR } from "@yrd/bay"
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
  QueuePauseSchema,
  QueueRecordSchema,
  Queues,
  PRSnapshotSchema,
  type AddStepResult,
  type BatchConfig,
  type InstalledStep,
  type IntegratedShape,
  type IntegrationProof,
  type QueueAuditFinding,
  type QueueAuditResult,
  type QueuePause,
  type QueueRecord,
  type QueueRun,
  type QueueRunId,
  type QueueSummary,
  type QueuesState,
  type QueueStep,
  type PRShape,
  type PRSnapshot,
} from "./model.ts"

const StepNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/iu)
const QueueRunIdSchema = z.string().trim().min(1)
const StepExecutionSchema = z
  .object({
    run: QueueRunIdSchema,
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

const QueueRunArgsSchema = z
  .object({
    prs: z.array(z.string().trim().min(1)).optional(),
    steps: z.array(StepNameSchema).optional(),
    retry: z.boolean().optional(),
  })
  .strict()
export type QueueRunArgs = Readonly<z.infer<typeof QueueRunArgsSchema>>

const AdvanceArgsSchema = z.object({ run: QueueRunIdSchema }).strict()
const IsolateArgsSchema = AdvanceArgsSchema.extend({ part: z.union([z.literal(0), z.literal(1)]) }).strict()
export type PauseQueueArgs = Readonly<{ base: string; reason: string; allowedPRs: readonly string[] }>
export type RecoverQueueOptions = Readonly<{ recoveryTime: string; reason?: string }>
const PauseQueueArgsSchema = z
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
  }) as z.ZodType<PauseQueueArgs>
const ResumeQueueArgsSchema = z.object({ base: GitRefSchema }).strict()
const QueueStartSchema = QueueRecordSchema.omit({ startedAt: true, failure: true })
const QueueFailedSchema = z
  .object({ run: QueueRunIdSchema, error: z.object({ code: z.string(), message: z.string() }) })
  .strict()

export type StepExecution<Shape extends PRShape = PRShape> = Readonly<{
  run: QueueRunId
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
    : Readonly<{ "yrd: incompatible queue step input": never }>
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
    name: `queue.step.${stepName}`,
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
    name: "queue.step.merge",
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

export type QueueOptions<Steps extends readonly AnyStepDef[]> = Readonly<{
  steps: Steps
  batch?: BatchConfig
  defaultSteps?: readonly string[]
}>

type QueueState = Readonly<{ queues: QueuesState }>
type QueueHostState = Readonly<{ bays: BaysState; jobs: JobsState }>
type RuntimeState = QueueHostState & QueueState
type QueueStart = Omit<QueueRecord, "startedAt" | "failure">

export type QueueCommands = Readonly<{
  queue: Readonly<{
    run: CommandHandler<QueueRunArgs, RuntimeState>
    pause: CommandHandler<PauseQueueArgs, RuntimeState>
    resume: CommandHandler<Readonly<{ base: string }>, RuntimeState>
    advance: CommandHandler<Readonly<{ run: QueueRunId }>, RuntimeState>
    isolate: CommandHandler<Readonly<{ run: QueueRunId; part: 0 | 1 }>, RuntimeState>
  }>
}>

export type Queue<Shape extends PRShape = PRShape> = Readonly<{
  readonly shape?: Shape
  state: ReadSignal<DeepReadonly<QueuesState>>
  steps(): readonly InstalledStep[]
  pause(args: PauseQueueArgs): Promise<QueuePause>
  resume(base: string): Promise<void>
  run(args: QueueRunArgs, options: RunJobOptions): Promise<readonly QueueRun[]>
  waiting(selector: string, step?: string): WaitingQueueStep
  finish(selector: string, completion: FinishQueueArgs, options: RunJobOptions): Promise<QueueRun>
  recover(options: RecoverQueueOptions): Promise<readonly QueueRun[]>
  audit(): QueueAuditResult
  get(run: QueueRunId): QueueRun | undefined
  status(base: string): QueueSummary
}>

export type WaitingQueueStep = Readonly<{
  run: QueueRun
  step: QueueStep & Readonly<{ job: Extract<Job, { status: "waiting" }> }>
}>

export type FinishQueueArgs = Readonly<{
  step?: string
  token?: string
  result: Exclude<JobResult, JobWaiting>
}>

export type HasQueue<Shape extends PRShape = PRShape> = Readonly<{ queue: Queue<Shape> }>

export type QueuePlugin<Shape extends PRShape> = (<
  State extends object,
  Commands extends CommandTree,
  Features extends HasJobs & HasBays,
>(
  definition: YrdDef<State, Commands, Features>,
) => YrdDef<State & QueueState, Commands & QueueCommands, Features & HasQueue<Shape>>) &
  Readonly<{ jobDefs: JobDefs }>

export function withQueue<const Steps extends readonly AnyStepDef[]>(
  options: QueueOptions<Steps> & ValidateStepChain<Steps>,
): QueuePlugin<FinalShape<Steps>> {
  const steps = installSteps(options.steps)
  const byName = new Map(steps.map((step) => [step.name, step] as const))
  const batchSize = normalizeBatch(options.batch ?? 1)
  const defaults = options.defaultSteps === undefined ? undefined : selectSteps(steps, options.defaultSteps)
  validateSequence(defaults ?? steps, false)
  const initial = Queues.empty({
    batchSize,
    ...(defaults === undefined ? {} : { defaultSteps: defaults.map((step) => step.name) }),
  })
  const jobDefs = Object.freeze(Object.fromEntries(steps.map((step) => [step.job.name, step.job])))
  const commands = createQueueCommands(steps, byName)

  const install = <State extends object, Commands extends CommandTree, Features extends HasJobs & HasBays>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { queues: initial },
      commands,
      events: {
        "queue/run/started": z.object({ run: QueueStartSchema }).strict(),
        "queue/run/failed": QueueFailedSchema,
        "queue/paused": PauseQueueArgsSchema,
        "queue/resumed": ResumeQueueArgsSchema,
        "queue/batch/isolated": z
          .object({
            parent: QueueRunIdSchema,
            run: QueueRunIdSchema,
            part: z.union([z.literal(0), z.literal(1)]),
            prs: z.array(z.string().trim().min(1)).min(1),
          })
          .strict(),
      },
      project: projectQueues,
      create(yrd) {
        yrd.jobs.requireDefinitions(jobDefs)
        return {
          queue: createQueue(
            computed(() => yrd.state().queues),
            () => yrd.state() as unknown as DeepReadonly<RuntimeState>,
            yrd.jobs,
            {
              refresh: () => yrd.refresh(),
              run: (args) => yrd.dispatch(commands.queue.run, args),
              pause: (args) => yrd.dispatch(commands.queue.pause, args),
              resume: (base) => yrd.dispatch(commands.queue.resume, { base }),
              advance: (run) => yrd.dispatch(commands.queue.advance, { run }),
              isolate: (run, part) => yrd.dispatch(commands.queue.isolate, { run, part }),
            },
            steps,
            yrd.log.child("queue"),
          ),
        }
      },
    })

  Object.defineProperty(install, "jobDefs", { value: jobDefs, enumerable: true })
  return Object.freeze(install) as unknown as QueuePlugin<FinalShape<Steps>>
}

type RuntimeStep = AnyStepDef
type QueueActions = Readonly<{
  refresh(): Promise<unknown>
  run(args: QueueRunArgs): Promise<CommandResult>
  pause(args: PauseQueueArgs): Promise<CommandResult>
  resume(base: string): Promise<CommandResult>
  advance(run: QueueRunId): Promise<CommandResult>
  isolate(run: QueueRunId, part: 0 | 1): Promise<CommandResult>
}>

function createQueue<Shape extends PRShape>(
  state: ReadSignal<DeepReadonly<QueuesState>>,
  runtime: () => DeepReadonly<RuntimeState>,
  jobs: HasJobs["jobs"],
  actions: QueueActions,
  steps: readonly RuntimeStep[],
  log: ConditionalLogger,
): Queue<Shape> {
  const current = (id: QueueRunId): QueueRun => materializeRun(Queues.record(state(), id), runtime().jobs)

  const waiting = (selector: string, stepName?: string): WaitingQueueStep => {
    const snapshot = runtime()
    const direct = snapshot.queues.records[selector]
    let selected = direct === undefined ? undefined : materializeRun(direct, snapshot.jobs)
    if (selected === undefined) {
      const pr = resolvePR(snapshot.bays, selector)
      if (pr === undefined) {
        raiseFailure("refusal", "queue-selection-missing", `yrd: no queue run or PR '${selector}'`)
      }
      const summary = queueSummary(snapshot.queues, snapshot.jobs, pr.base)
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
          "queue-step-not-waiting",
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
        pending.length === 0 ? "queue-step-not-waiting" : "queue-step-ambiguous",
        `yrd: queue run '${selected.id}' ${pending.length === 0 ? "has no waiting step" : "has multiple waiting steps; select one"}`,
      )
    }
    if (step?.job?.status !== "waiting") {
      raiseFailure(
        "refusal",
        "queue-step-not-waiting",
        `yrd: queue run '${selected.id}' has no waiting '${stepName ?? "unknown"}' step`,
      )
    }
    return { run: selected, step: step as WaitingQueueStep["step"] }
  }

  const drive = async (id: QueueRunId, options: RunJobOptions): Promise<QueueRun> => {
    while (true) {
      const snapshot = runtime()
      const run = materializeRun(Queues.record(snapshot.queues, id), snapshot.jobs)
      if (Queues.terminal(run) && !needsAdvance(snapshot, run)) return run
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

  const settle = async (id: QueueRunId, options: RunJobOptions): Promise<QueueRun> => {
    using _span = log.span?.("run", { id })
    const settled = await drive(id, options)
    if (!bisectable(settled)) return settled
    for (const part of [0, 1] as const) {
      let snapshot = runtime()
      let child = childQueue(snapshot.queues, snapshot.jobs, settled.id, part)
      if (child === undefined) {
        await actions.isolate(settled.id, part)
        snapshot = runtime()
        child = childQueue(snapshot.queues, snapshot.jobs, settled.id, part)
      }
      if (child === undefined) throw new Error(`yrd: queue run '${settled.id}' did not create isolation part ${part}`)
      await settle(child.id, options)
    }
    return current(id)
  }

  return Object.freeze({
    state,
    steps: () => steps.map(descriptor),
    async pause(args) {
      const base = baseIdentity(args.base)
      await actions.pause({ ...args, base })
      const pause = state().pauses[base]
      if (pause === undefined) throw new Error(`yrd: queue '${base}' did not retain its pause`)
      return pause
    },
    async resume(base) {
      await actions.resume(baseIdentity(base))
    },
    async run(args, runOptions) {
      using _span = log.span?.("run", { prs: args.prs, steps: args.steps, retry: args.retry === true })
      if (args.steps?.length === 0) return []
      await actions.refresh()
      const snapshot = runtime()
      const prs = runnablePRs(snapshot, args)
      if (prs.length === 0) return []
      const roots: QueueRunId[] = []
      for (const candidate of partitionCandidates(prs, snapshot.queues.batchSize)) {
        const started = await actions.run({
          prs: candidate.map((pr) => pr.id),
          ...(args.steps === undefined ? {} : { steps: args.steps }),
          ...(args.retry === true ? { retry: true } : {}),
        })
        const startedEvent = started.events.find((applied) => applied.name === "queue/run/started")
        if (startedEvent === undefined) throw new Error("yrd: queue run did not start a run")
        const id = QueueStartSchema.parse((startedEvent.data as { run?: unknown }).run).id
        roots.push(id)
        await settle(id, runOptions)
      }
      const final = runtime()
      return roots.flatMap((root) => queueTree(final.queues, final.jobs, root))
    },
    waiting,
    async finish(selector, completion, runOptions) {
      using _span = log.span?.("finish", { selector, step: completion.step })
      const selected = waiting(selector, completion.step)
      await jobs.finish(selected.step.job.id, {
        attempt: selected.step.job.attempt,
        runner: selected.step.job.runner,
        ...(completion.token === undefined ? {} : { token: completion.token }),
        result: completion.result,
      })
      return await settle(selected.run.id, runOptions)
    },
    async recover(recoverOptions) {
      using _span = log.span?.("recover", { at: recoverOptions.recoveryTime })
      const recoveredJobs = new Set(
        await jobs.recover({
          now: recoverOptions.recoveryTime,
          ...(recoverOptions.reason === undefined ? {} : { reason: recoverOptions.reason }),
        }),
      )
      const affected = new Set<QueueRunId>()
      let snapshot = runtime()
      for (const candidate of orderedQueues(snapshot.queues, snapshot.jobs)) {
        const ownsRecoveredJob = candidate.steps.some(
          (step) => step.job !== undefined && recoveredJobs.has(step.job.id),
        )
        const hasTerminalFailure = candidate.steps.some(
          (step) => step.job?.status === "failed" || step.job?.status === "lost",
        )
        if (hasTerminalFailure && needsAdvance(snapshot, candidate)) {
          const reconciled = await actions.advance(candidate.id)
          if (reconciled.events.length > 0) affected.add(candidate.id)
          snapshot = runtime()
        }
        if (ownsRecoveredJob) affected.add(candidate.id)
      }
      const final = runtime()
      return [...affected].map((id) => materializeRun(Queues.record(final.queues, id), final.jobs))
    },
    audit: () => auditQueues(runtime(), steps),
    get(id) {
      const record = state().records[id]
      return record === undefined ? undefined : materializeRun(record, runtime().jobs)
    },
    status: (base) => queueSummary(state(), runtime().jobs, baseIdentity(base)),
  }) as Queue<Shape>
}

function createQueueCommands(steps: readonly RuntimeStep[], byName: ReadonlyMap<string, RuntimeStep>): QueueCommands {
  const pause = command({
    title: "Pause queue",
    visibility: "public",
    params: PauseQueueArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: PauseQueueArgs) {
      const base = baseIdentity(args.base)
      const paused = {
        ...args,
        base,
        allowedPRs: [...args.allowedPRs].toSorted((left, right) =>
          left.localeCompare(right, undefined, { numeric: true }),
        ),
      }
      const current = state.queues.pauses[base]
      if (
        current?.reason === paused.reason &&
        current.allowedPRs.length === paused.allowedPRs.length &&
        current.allowedPRs.every((pr, index) => pr === paused.allowedPRs[index])
      ) {
        return { events: [] }
      }
      return { events: [event("queue/paused", paused)] }
    },
  })

  const resume = command({
    title: "Resume queue",
    visibility: "public",
    params: ResumeQueueArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: Readonly<{ base: string }>) {
      const base = baseIdentity(args.base)
      return { events: state.queues.pauses[base] === undefined ? [] : [event("queue/resumed", { base })] }
    },
  })

  const run = command({
    title: "Run queue",
    visibility: "public",
    params: QueueRunArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: QueueRunArgs) {
      if (args.steps?.length === 0) return { events: [] }
      const prs = runnablePRs(state, args)
      if (prs.length === 0) return { events: [] }
      const base = prs[0] === undefined ? undefined : baseIdentity(prs[0].base)
      if (base === undefined) throw new Error("yrd: a queue run requires at least one PR")
      if (prs.some((pr) => baseIdentity(pr.base) !== base)) {
        throw new Error("yrd: one queue candidate cannot span base branches")
      }
      if (prs.length > state.queues.batchSize) {
        throw new Error(
          `yrd: queue candidate has ${prs.length} PRs; configured batch size is ${state.queues.batchSize}`,
        )
      }
      const active = runningQueue(state.queues, state.jobs, base)
      if (active !== undefined) throw new Error(`yrd: queue '${base}' is running '${active.id}'`)

      const selected = selectSteps(steps, args.steps ?? state.queues.defaultSteps)
      const integrated = integratedPRShape(prs)
      validateSequence(selected, integrated !== undefined)
      const snapshots = prs.map(Queues.snapshot)
      return startRun(
        Queues.nextId(state.queues),
        snapshots,
        selected,
        integrated ?? prShape(snapshots),
        integrated?.integration,
      )
    },
  })

  const advance = command({
    title: "Advance queue run",
    params: AdvanceArgsSchema,
    apply: (state: DeepReadonly<RuntimeState>, args) =>
      advanceQueue(state, Queues.record(state.queues, args.run), byName),
  })

  const isolate = command({
    title: "Isolate failed queue batch",
    params: IsolateArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args) {
      const parent = materializeRun(Queues.record(state.queues, args.run), state.jobs)
      if (childQueue(state.queues, state.jobs, parent.id, args.part) !== undefined) return { events: [] }
      if (!bisectable(parent)) throw new Error(`yrd: queue run '${parent.id}' is not a failed pre-merge batch`)
      const active = runningQueue(state.queues, state.jobs, parent.base)
      if (active !== undefined) throw new Error(`yrd: queue '${parent.base}' is running '${active.id}'`)

      const pivot = Math.ceil(parent.prs.length / 2)
      const prs = args.part === 0 ? parent.prs.slice(0, pivot) : parent.prs.slice(pivot)
      if (prs.length === 0) throw new Error(`yrd: queue run '${parent.id}' has no isolation part ${args.part}`)
      const selected = parent.steps.map((planned) => requirePlannedStep(byName, planned))
      const started = startRun(Queues.nextId(state.queues), prs, selected, prShape(prs), undefined, {
        parent: parent.id,
        isolationPart: args.part,
      })
      return {
        events: [
          event("queue/batch/isolated", {
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

  return { queue: { run, pause, resume, advance, isolate } }
}

function projectQueues(state: DeepReadonly<QueueState>, applied: Event): QueueState {
  if (applied.name === "queue/paused") {
    const parsed = PauseQueueArgsSchema.parse(applied.data)
    const paused = QueuePauseSchema.parse({ ...parsed, base: baseIdentity(parsed.base), pausedAt: applied.ts })
    return { queues: { ...state.queues, pauses: { ...state.queues.pauses, [paused.base]: paused } } }
  }
  if (applied.name === "queue/resumed") {
    const base = baseIdentity(ResumeQueueArgsSchema.parse(applied.data).base)
    return {
      queues: {
        ...state.queues,
        pauses: Object.fromEntries(Object.entries(state.queues.pauses).filter(([candidate]) => candidate !== base)),
      },
    }
  }
  if (applied.name === "queue/run/started") {
    const started = QueueStartSchema.parse((applied.data as { run?: unknown }).run)
    if (state.queues.records[started.id] !== undefined) throw new Error(`yrd: duplicate queue run '${started.id}'`)
    const record = QueueRecordSchema.parse({
      ...started,
      base: baseIdentity(started.base),
      prs: started.prs.map((pr) => ({ ...pr, base: baseIdentity(pr.base) })),
      startedAt: applied.ts,
    })
    return { queues: { ...state.queues, records: { ...state.queues.records, [record.id]: record } } }
  }
  if (applied.name === "queue/run/failed") {
    const failed = QueueFailedSchema.parse(applied.data)
    const record = state.queues.records[failed.run]
    if (record === undefined) throw new Error(`yrd: no queue run '${failed.run}'`)
    return {
      queues: {
        ...state.queues,
        records: {
          ...state.queues.records,
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
    if (names.has(step.name)) throw new Error(`yrd: queue step '${step.name}' is already installed`)
    names.add(step.name)
  }
  return Object.freeze([...definitions])
}

function descriptor(step: RuntimeStep | QueueStep): InstalledStep {
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
  if (selected.size !== names.length) throw new Error("yrd: queue.run: duplicate step name")
  for (const name of selected) {
    if (!steps.some((step) => step.name === name)) throw new Error(`yrd: queue step '${name}' is not installed`)
  }
  return steps.filter((step) => selected.has(step.name))
}

function validateSequence(steps: readonly RuntimeStep[], alreadyIntegrated: boolean): void {
  let integrated = alreadyIntegrated
  for (const step of steps) {
    if (step.needsIntegration && !integrated) {
      throw new Error(`yrd: queue step '${step.name}' requires integration output before it can run`)
    }
    if (!step.integrates) continue
    if (integrated) throw new Error("yrd: merge step cannot run after the PR is already integrated")
    integrated = true
  }
}

function startRun(
  id: QueueRunId,
  prs: readonly PRSnapshot[],
  selected: readonly RuntimeStep[],
  shape: PRShape,
  integration?: IntegrationProof,
  lineage: Readonly<{ parent?: QueueRunId; isolationPart?: 0 | 1 }> = {},
): Readonly<{ run: QueueStart; events: readonly EventDraft[] }> {
  const pr = prs[0]
  if (pr === undefined) throw new Error("yrd: a queue run requires at least one PR")
  const run: QueueStart = {
    id,
    prs,
    base: baseIdentity(pr.base),
    steps: selected.map(descriptor),
    ...(integration === undefined ? {} : { initialIntegration: integration }),
    ...lineage,
  }
  return {
    run,
    events: [
      event("queue/run/started", { run }),
      ...(selected[0] === undefined ? [] : [requestStep(selected[0], run, 0, shape)]),
    ],
  }
}

function requestStep(step: RuntimeStep, run: Pick<QueueStart, "id" | "prs">, index: number, shape: PRShape) {
  return step.job.request({ run: run.id, step: step.name, index, prs: run.prs, shape }, { key: jobKey(run.id, index) })
}

function advanceQueue(
  state: DeepReadonly<RuntimeState>,
  record: DeepReadonly<QueueRecord>,
  steps: ReadonlyMap<string, RuntimeStep>,
): Readonly<{ events: readonly EventDraft[] }> {
  const stale = pinnedPRError(state.bays, record.prs)
  if (stale !== undefined && record.failure === undefined) {
    return { events: [event("queue/run/failed", { run: record.id, error: stale })] }
  }

  const jobs = queueJobs(record, state.jobs)
  const index = jobs.length - 1
  const job = jobs[index]
  if (job === undefined || job.status === "requested" || job.status === "running" || job.status === "waiting") {
    return { events: [] }
  }
  const planned = record.steps[index]
  if (planned === undefined) throw new Error(`yrd: queue run '${record.id}' lost step ${index}`)
  if (runningQueue(state.queues, state.jobs, record.base, record.id) !== undefined) return { events: [] }

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
  const payloads = new Set(snapshots.map((pr) => `${baseIdentity(pr.base)}\0${pr.headSha}`))
  return Object.values(state.prs).filter(
    (pr) => pr.status !== "withdrawn" && payloads.has(`${baseIdentity(pr.base)}\0${pr.headSha}`),
  )
}

function materializeRun(record: DeepReadonly<QueueRecord>, jobs: DeepReadonly<JobsState>): QueueRun {
  const jobList = queueJobs(record, jobs)
  const steps = record.steps.map(
    (step, index): QueueStep => ({
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

function queueJobs(record: DeepReadonly<QueueRecord>, jobs: DeepReadonly<JobsState>): Job[] {
  const result: Job[] = []
  let missing = false
  for (const [index, step] of record.steps.entries()) {
    const id = jobs.byKey[jobKey(record.id, index)]
    if (id === undefined) {
      missing = true
      continue
    }
    if (missing) throw new Error(`yrd: queue run '${record.id}' requested steps out of order`)
    const job = jobs.byId[id]
    if (job === undefined) throw new Error(`yrd: queue run '${record.id}' lost job '${id}'`)
    const input = StepExecutionSchema.parse(job.input)
    if (
      input.run !== record.id ||
      input.index !== index ||
      input.step !== step.name ||
      job.definition !== `queue.step.${step.name}` ||
      job.revision !== step.revision
    ) {
      throw new Error(`yrd: queue run '${record.id}' job '${job.id}' does not match step '${step.name}'`)
    }
    result.push(job)
  }
  return result
}

function jobKey(run: QueueRunId, index: number): string {
  return `queue:${run}:${index}`
}

function shapeThrough(
  record: DeepReadonly<QueueRecord>,
  jobs: DeepReadonly<JobsState>,
  limit = record.steps.length,
): PRShape {
  const hasMerge = record.steps.some((step) => step.integrates)
  let shape: PRShape | IntegratedShape = {
    ...prShape(record.prs),
    ...(record.initialIntegration === undefined || hasMerge ? {} : { integration: record.initialIntegration }),
  }
  const jobList = queueJobs(record, jobs)
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

function orderedQueues(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>): QueueRun[] {
  return Object.values(queues.records)
    .map((record) => materializeRun(record, jobs))
    .toSorted((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
}

function runningQueue(
  queues: DeepReadonly<QueuesState>,
  jobs: DeepReadonly<JobsState>,
  base: string,
  except?: QueueRunId,
): QueueRun | undefined {
  const identity = baseIdentity(base)
  return orderedQueues(queues, jobs).find(
    (run) => run.id !== except && baseIdentity(run.base) === identity && run.status === "running",
  )
}

function childQueue(
  queues: DeepReadonly<QueuesState>,
  jobs: DeepReadonly<JobsState>,
  parent: QueueRunId,
  part: 0 | 1,
): QueueRun | undefined {
  const record = Object.values(queues.records).find(
    (candidate) => candidate.parent === parent && candidate.isolationPart === part,
  )
  return record === undefined ? undefined : materializeRun(record, jobs)
}

function queueTree(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>, root: QueueRunId): QueueRun[] {
  const ordered = orderedQueues(queues, jobs)
  const result: QueueRun[] = []
  const visit = (id: QueueRunId): void => {
    const run = ordered.find((candidate) => candidate.id === id)
    if (run === undefined) return
    result.push(run)
    for (const child of ordered.filter((candidate) => candidate.parent === id)) visit(child.id)
  }
  visit(root)
  return result
}

function queueSummary(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>, base: string): QueueSummary {
  const identity = baseIdentity(base)
  const runs = orderedQueues(queues, jobs).filter((run) => baseIdentity(run.base) === identity)
  return {
    base: identity,
    running: runs.filter((run) => run.status === "running"),
    waiting: runs.filter((run) => run.status === "waiting"),
    finished: runs.filter(Queues.terminal),
    ...(queues.pauses[identity] === undefined ? {} : { pause: queues.pauses[identity] }),
  }
}

function auditQueues(state: DeepReadonly<RuntimeState>, steps: readonly RuntimeStep[]): QueueAuditResult {
  const findings: QueueAuditFinding[] = []
  const installed = new Map(steps.map((step) => [step.name, step]))
  for (const record of Object.values(state.queues.records)) {
    for (const pr of record.prs) {
      if (state.bays.prs[pr.id] !== undefined) continue
      findings.push({
        code: "missing-pr",
        message: `queue run '${record.id}' references missing PR '${pr.id}'`,
        run: record.id,
        pr: pr.id,
      })
    }
    let run: QueueRun
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
    if (Queues.terminal(run)) continue
    for (const planned of record.steps) {
      const current = installed.get(planned.name)
      if (current === undefined) {
        findings.push({
          code: "step-unavailable",
          message: `queue run '${record.id}' requires unavailable step '${planned.name}' revision '${planned.revision}'`,
          run: record.id,
          step: planned.name,
        })
      } else if (current.revision !== planned.revision) {
        findings.push({
          code: "step-revision-drift",
          message: `queue run '${record.id}' requires step '${planned.name}' revision '${planned.revision}', installed '${current.revision}'`,
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
  if (current === undefined) throw new Error(`yrd: queue step '${planned.name}' is not installed`)
  if (
    current.revision !== planned.revision ||
    current.integrates !== planned.integrates ||
    current.needsIntegration !== planned.needsIntegration
  ) {
    throw new Error(
      `yrd: queue step '${planned.name}' revision '${planned.revision}' does not match installed revision '${current.revision}'`,
    )
  }
  return current
}

function requestedPRs(state: DeepReadonly<BaysState>, args: QueueRunArgs): PR[] {
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
      raiseFailure("usage", "duplicate-pr", `yrd: queue.run: duplicate PR '${pr.id}'`)
    }
    ids.add(pr.id)
    if (pr.status === "rejected" && args.retry !== true) {
      raiseFailure("refusal", "retry-required", `yrd: PR '${pr.id}' is rejected; retry=true is required`)
    }
    if (pr.status !== "submitted" && pr.status !== "rejected" && pr.status !== "integrated") {
      raiseFailure("refusal", "pr-not-ready", `yrd: PR '${pr.id}' is ${pr.status}, not ready for the queue`)
    }
  }
  return prs
}

function runnablePRs(state: DeepReadonly<RuntimeState>, args: QueueRunArgs): PR[] {
  const requested = requestedPRs(state.bays, args)
  const implicitQueue = args.prs === undefined || args.prs.length === 0
  const eligible = requested.filter((pr) => {
    const base = baseIdentity(pr.base)
    const pause = state.queues.pauses[base]
    if (pause === undefined || pause.allowedPRs.includes(pr.id)) return true
    if (implicitQueue) return false
    raiseFailure(
      "refusal",
      "queue-paused",
      `yrd: queue '${base}' is paused: ${pause.reason}; PR '${pr.id}' is not in the allowed set`,
    )
  })
  const claimed = new Set(
    orderedQueues(state.queues, state.jobs)
      .filter((run) => !Queues.terminal(run))
      .flatMap((run) => run.prs.map((pr) => pr.id)),
  )
  return eligible.filter((pr) => !claimed.has(pr.id))
}

function partitionCandidates(prs: readonly PR[], batchSize: number): PR[][] {
  const groups = new Map<string, PR[]>()
  for (const pr of prs) {
    const proof = pr.integration
    const key = `${baseIdentity(pr.base)}\0${proof?.commit ?? ""}\0${proof?.baseSha ?? ""}`
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
  if (prs.length === 0) throw new Error("yrd: a queue run requires at least one PR")
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
    throw new Error("yrd: every PR in a queue candidate must share one integration proof")
  }
  return { ...prShape(prs.map(Queues.snapshot)), integration: proof }
}

function pinnedPRError(state: DeepReadonly<BaysState>, snapshots: readonly PRSnapshot[]): JobError | undefined {
  for (const snapshot of snapshots) {
    const current = state.prs[snapshot.id]
    if (
      current === undefined ||
      current.revision !== snapshot.revision ||
      current.headSha !== snapshot.headSha ||
      baseIdentity(current.base) !== baseIdentity(snapshot.base) ||
      current.status === "withdrawn"
    ) {
      return {
        code: "stale-pr",
        message: `PR '${snapshot.id}' changed after queue run pinned revision ${snapshot.revision} (${snapshot.headSha})`,
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

function bisectable(run: QueueRun): boolean {
  const failed = run.steps.some((step) => step.job?.status === "failed" || step.job?.status === "lost")
  return run.status === "failed" && failed && !isIntegrated(run.shape) && run.prs.length > 1
}

function needsAdvance(state: DeepReadonly<RuntimeState>, run: QueueRun): boolean {
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
