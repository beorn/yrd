import {
  GitRefSchema,
  PRIdSchema,
  baseIdentity,
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
  JobErrorSchema,
  type HasJobs,
  type JobDef,
  type JobDefs,
  type JobError,
  type JobCompletion,
  type JobHandler,
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
  type QueueRequirement,
  type QueueRun,
  type QueueRunId,
  type QueueSummary,
  type QueuesState,
  type QueueStep,
  type PREligibility,
  type PRCheckRecord,
  type PRShape,
  type PRSnapshot,
} from "./model.ts"

const StepNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/iu)
const QueueRequirementSchema = z.enum(["review"])
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

const AdmitArgsSchema = z.object({ pr: z.string().trim().min(1), retry: z.boolean().optional() }).strict()
export type AdmitArgs = Readonly<z.infer<typeof AdmitArgsSchema>>
export type AdmitSelection = Readonly<{ prs?: readonly string[]; retry?: boolean }>

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
const QueueFailedSchema = z.object({ run: QueueRunIdSchema, error: JobErrorSchema }).strict()

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
    ...(options.classification === undefined ? {} : { classification: options.classification }),
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
  requires?: readonly QueueRequirement[]
  resolveBaseSha?(base: string): string | Promise<string>
}>

type QueueState = Readonly<{ queues: QueuesState }>
type QueueHostState = Readonly<{ bays: BaysState; jobs: JobsState }>
type RuntimeState = QueueHostState & QueueState
type QueueStart = Omit<QueueRecord, "startedAt" | "failure">

export type QueueCommands = Readonly<{
  queue: Readonly<{
    admit: CommandHandler<AdmitArgs, RuntimeState>
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
  admit(args: AdmitSelection, options?: RunJobOptions): Promise<readonly QueueRun[]>
  pause(args: PauseQueueArgs): Promise<QueuePause>
  resume(base: string): Promise<void>
  run(args: QueueRunArgs, options: QueueRunOptions): Promise<readonly QueueRun[]>
  waiting(selector: string, step?: string): WaitingQueueStep
  finish(selector: string, completion: FinishQueueArgs, options: RunJobOptions): Promise<QueueRun>
  recover(options: RecoverQueueOptions): Promise<readonly QueueRun[]>
  audit(): QueueAuditResult
  eligibility(selector: string): PREligibility
  eligibilities(): readonly PREligibility[]
  checks(selectors?: readonly string[]): readonly PRCheckRecord[]
  get(run: QueueRunId): QueueRun | undefined
  status(base: string): QueueSummary
}>

export type QueueRunOptions = RunJobOptions & Readonly<{ continueAdmissions?: () => boolean }>

export type WaitingQueueStep = Readonly<{
  run: QueueRun
  step: QueueStep & Readonly<{ job: Extract<Job, { status: "waiting" }> }>
}>

export type FinishQueueArgs = Omit<JobCompletion, "token"> & Readonly<{ job: Job["id"]; step?: string; token: string }>

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
    ...(options.requires === undefined ? {} : { requires: z.array(QueueRequirementSchema).parse(options.requires) }),
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
              admit: (args) => yrd.dispatch(commands.queue.admit, args),
              run: (args) => yrd.dispatch(commands.queue.run, args),
              pause: (args) => yrd.dispatch(commands.queue.pause, args),
              resume: (base) => yrd.dispatch(commands.queue.resume, { base }),
              advance: (run) => yrd.dispatch(commands.queue.advance, { run }),
              isolate: (run, part) => yrd.dispatch(commands.queue.isolate, { run, part }),
              requestChecks: (pr, baseSha) =>
                yrd.bays.requestChecks({ pr, ...(baseSha === undefined ? {} : { baseSha }) }),
            },
            steps,
            options.resolveBaseSha,
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
  admit(args: AdmitArgs): Promise<CommandResult>
  run(args: QueueRunArgs): Promise<CommandResult>
  pause(args: PauseQueueArgs): Promise<CommandResult>
  resume(base: string): Promise<CommandResult>
  advance(run: QueueRunId): Promise<CommandResult>
  isolate(run: QueueRunId, part: 0 | 1): Promise<CommandResult>
  requestChecks(pr: string, baseSha?: string): Promise<CommandResult>
}>

function createQueue<Shape extends PRShape>(
  state: ReadSignal<DeepReadonly<QueuesState>>,
  runtime: () => DeepReadonly<RuntimeState>,
  jobs: HasJobs["jobs"],
  actions: QueueActions,
  steps: readonly RuntimeStep[],
  resolveBaseSha: QueueOptions<readonly AnyStepDef[]>["resolveBaseSha"],
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
      if (active?.job?.status === "running" || active?.job?.status === "waiting") {
        const guarded = await actions.advance(id)
        if (guarded.events.length > 0) continue
        return run
      }
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

  const startedRun = (result: CommandResult): QueueRun | undefined => {
    const started = result.events.find((applied) => applied.name === "queue/run/started")
    if (started === undefined) return undefined
    return current(QueueStartSchema.parse((started.data as { run?: unknown }).run).id)
  }

  const refreshCheckIdentities = async (prs: readonly DeepReadonly<PR>[]): Promise<void> => {
    if (resolveBaseSha === undefined) return
    for (const pr of prs) {
      if (!checksRequested(pr)) continue
      await actions.requestChecks(pr.id, await resolveBaseSha(pr.base))
    }
  }

  const dispatchAdmissions = async (selectors: readonly string[], retry: boolean): Promise<QueueRun[]> => {
    const admitted: QueueRun[] = []
    for (const selector of selectors) {
      const started = startedRun(await actions.admit({ pr: selector, ...(retry ? { retry: true } : {}) }))
      if (started !== undefined) admitted.push(started)
    }
    return admitted
  }

  const drainAdmissions = async (
    selectors: readonly string[],
    retry: boolean,
    options: QueueRunOptions,
  ): Promise<QueueRun[]> => {
    const targets = new Set(selectors)
    const outcomes = new Map<QueueRunId, QueueRun>()
    const remember = (candidate: QueueRun): void => {
      if (candidate.prs.some((pr) => targets.has(pr.id))) outcomes.set(candidate.id, candidate)
    }

    while (targets.size > 0) {
      if (options.continueAdmissions?.() === false) break
      await actions.refresh()
      let snapshot = runtime()
      const active = orderedQueues(snapshot.queues, snapshot.jobs).find(
        (candidate) =>
          candidate.status === "running" && samePlan(candidate.steps, admissionSteps(snapshot.queues, steps)),
      )
      if (active !== undefined) {
        const settled = await settle(active.id, options)
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
        (options.continueAdmissions === undefined ? queued : queued.slice(0, 1)).map((pr) => pr.id),
        false,
      )
      if (admitted.length > 0) continue

      for (const selector of targets) {
        const pr = resolvePR(snapshot.bays, selector)
        if (pr === undefined) continue
        const runId = checkEligibility(snapshot, pr, steps).run
        if (runId !== undefined) {
          const candidate = materializeRun(Queues.record(snapshot.queues, runId), snapshot.jobs)
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
      return await (runOptions === undefined
        ? dispatchAdmissions(selectors, args.retry === true)
        : drainAdmissions(selectors, args.retry === true, runOptions))
    },
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
      let snapshot = runtime()
      const resumable = resumableQueueRoots(snapshot, args, steps)
      const roots: QueueRunId[] = resumable.map((run) => run.id)
      for (const run of resumable) await settle(run.id, runOptions)

      snapshot = runtime()
      const activeBases = new Set(
        resumable
          .map((run) => materializeRun(Queues.record(snapshot.queues, run.id), snapshot.jobs))
          .filter((run) => !Queues.terminal(run))
          .map((run) => run.base),
      )
      const consumed = new Set(
        resumable.flatMap((run) =>
          run.prs.filter((pr) => pinnedPRError(snapshot.bays, [pr]) === undefined).map((pr) => pr.id),
        ),
      )
      const requested = requestedPRs(snapshot.bays, args, consumed)
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
      const prs = runnablePRs(snapshot, args, steps, consumed).filter((pr) => !activeBases.has(baseIdentity(pr.base)))
      for (const candidate of partitionCandidates(prs, snapshot.queues.batchSize)) {
        if (runOptions.continueAdmissions?.() === false) break
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
      using _span = log.span?.("finish", { selector, step: completion.step, job: completion.job })
      const selected = waiting(selector, completion.step)
      if (selected.step.job.id !== completion.job) {
        raiseFailure(
          "refusal",
          "queue-job-mismatch",
          `yrd: Job '${completion.job}' is not the waiting '${selected.step.name}' Job '${selected.step.job.id}' for queue run '${selected.run.id}'`,
        )
      }
      await jobs.finish(completion.job, {
        attempt: completion.attempt,
        runner: completion.runner,
        token: completion.token,
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
    status: (base) => queueSummary(state(), runtime().jobs, baseIdentity(base)),
  }) as Queue<Shape>
}

function createQueueCommands(steps: readonly RuntimeStep[], byName: ReadonlyMap<string, RuntimeStep>): QueueCommands {
  const admit = command({
    title: "Admit PR checks",
    params: AdmitArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: AdmitArgs) {
      const pr = resolvePR(state.bays, args.pr)
      if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${args.pr}'`)
      if (pr.status !== "pushed" && pr.status !== "submitted" && !(args.retry === true && pr.status === "rejected")) {
        raiseFailure("refusal", "pr-not-admissible", `yrd: PR '${pr.id}' is ${pr.status}, not admissible`)
      }
      const selected = admissionSteps(state.queues, steps)
      if (selected.length === 0) return { events: [] }
      const snapshot = Queues.snapshot(pr)
      const existing = checkFactRun(state, snapshot, selected)
      const status = existing === undefined ? undefined : checkRunStatus(existing, selected.length)
      if (status === "passed" || status === "checking") {
        return { events: [] }
      }
      if (existing !== undefined && status === "failed" && args.retry !== true) {
        raiseFailure(
          "refusal",
          "checks-failed",
          `yrd: PR '${pr.id}' checks failed in ${existing.id}; retry=true is required`,
        )
      }
      if (runningQueue(state.queues, state.jobs, pr.base) !== undefined) return { events: [] }
      if (pr.status !== "rejected" && checksRequested(pr)) {
        const first = admissionQueue(state, steps)[0]
        if (first !== undefined && first.id !== pr.id) return { events: [] }
      }
      return startRun(Queues.nextId(state.queues), [snapshot], selected, prShape([snapshot]))
    },
  })

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
      const prs = runnablePRs(state, args, steps)
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
      const reuse = integrated === undefined ? reusablePrefix(state, snapshots, selected) : undefined
      const remaining = reuse === undefined ? selected : selected.slice(reuse.count)
      if (remaining.length === 0) return { events: [] }
      return startRun(
        Queues.nextId(state.queues),
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

  return { queue: { admit, run, pause, resume, advance, isolate } }
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
    ...(step.classification === undefined ? {} : { classification: step.classification }),
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
  reuse?: Readonly<{ run: QueueRunId; results: Readonly<Record<string, JsonValue>> }>,
): Readonly<{ run: QueueStart; events: readonly EventDraft[] }> {
  const pr = prs[0]
  if (pr === undefined) throw new Error("yrd: a queue run requires at least one PR")
  const run: QueueStart = {
    id,
    prs,
    base: baseIdentity(pr.base),
    steps: selected.map(descriptor),
    ...(integration === undefined ? {} : { initialIntegration: integration }),
    ...(reuse === undefined ? {} : { initialResults: reuse.results, reusedFrom: reuse.run }),
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
    const failure = jobFailure(job)
    return {
      events:
        failure.code !== "queue-environment-refused" &&
        !isIntegrated(before) &&
        pr !== undefined &&
        current?.status === "submitted"
          ? [event("pr/rejected", { pr: pr.id, revision: pr.revision, detail: failure.message })]
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
    results: { ...record.initialResults },
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
    current.needsIntegration !== planned.needsIntegration ||
    current.classification !== planned.classification
  ) {
    throw new Error(
      `yrd: queue step '${planned.name}' revision '${planned.revision}' does not match installed revision '${current.revision}'`,
    )
  }
  return current
}

function explicitPRs(state: DeepReadonly<BaysState>, args: QueueRunArgs): PR[] | undefined {
  const selectors = args.prs === undefined || args.prs.length === 0 ? undefined : args.prs
  if (selectors === undefined) return undefined
  const prs = selectors.map((selector) => {
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
  }
  return prs
}

function requestedPRs(
  state: DeepReadonly<BaysState>,
  args: QueueRunArgs,
  excluded: ReadonlySet<string> = new Set(),
): PR[] {
  const explicit = explicitPRs(state, args)
  const prs = (
    explicit ??
    Object.values(state.prs)
      .filter((pr) => pr.status === "submitted" || (args.retry === true && pr.status === "rejected"))
      .toSorted((left, right) => {
        if (left.submittedAt === undefined) throw new Error(`yrd: queued PR '${left.id}' has no submission time`)
        if (right.submittedAt === undefined) throw new Error(`yrd: queued PR '${right.id}' has no submission time`)
        return (
          left.submittedAt.localeCompare(right.submittedAt) ||
          left.id.localeCompare(right.id, undefined, { numeric: true })
        )
      })
  ).filter((pr) => !excluded.has(pr.id))
  for (const pr of prs) {
    if (pr.status === "rejected" && args.retry !== true) {
      raiseFailure("refusal", "retry-required", `yrd: PR '${pr.id}' is rejected; retry=true is required`)
    }
    if (pr.status !== "submitted" && pr.status !== "rejected" && pr.status !== "integrated") {
      raiseFailure("refusal", "pr-not-ready", `yrd: PR '${pr.id}' is ${pr.status}, not ready for the queue`)
    }
  }
  return prs
}

function resumableQueueRoots(
  state: DeepReadonly<RuntimeState>,
  args: QueueRunArgs,
  steps: readonly RuntimeStep[],
): QueueRun[] {
  const explicit = explicitPRs(state.bays, args)
  const selected = explicit === undefined ? undefined : new Set(explicit.map((pr) => pr.id))
  const admissions = admissionSteps(state.queues, steps)
  return pendingQueueRoots(state).filter(
    (run) => !samePlan(run.steps, admissions) && (selected === undefined || run.prs.some((pr) => selected.has(pr.id))),
  )
}

function pendingQueueRoots(state: DeepReadonly<RuntimeState>): QueueRun[] {
  return orderedQueues(state.queues, state.jobs).filter(
    (run) => run.parent === undefined && needsSettlement(state, run),
  )
}

function needsSettlement(state: DeepReadonly<RuntimeState>, run: QueueRun): boolean {
  if (!Queues.terminal(run) || needsAdvance(state, run)) return true
  if (!bisectable(run)) return false
  return ([0, 1] as const).some((part) => {
    const child = childQueue(state.queues, state.jobs, run.id, part)
    return child === undefined || needsSettlement(state, child)
  })
}

function admissionSteps(queues: DeepReadonly<QueuesState>, steps: readonly RuntimeStep[]): RuntimeStep[] {
  const selected = selectSteps(steps, queues.defaultSteps)
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
): QueueRun | undefined {
  return orderedQueues(state.queues, state.jobs)
    .filter(
      (run) =>
        run.prs.length === 1 &&
        run.prs[0] !== undefined &&
        sameSnapshot(run.prs[0], snapshot) &&
        samePlan(run.steps, selected),
    )
    .at(-1)
}

function checkFactRun(
  state: DeepReadonly<RuntimeState>,
  snapshot: DeepReadonly<PRSnapshot>,
  selected: readonly RuntimeStep[],
): QueueRun | undefined {
  return orderedQueues(state.queues, state.jobs)
    .filter(
      (run) =>
        run.prs.length === 1 &&
        run.prs[0] !== undefined &&
        sameSnapshot(run.prs[0], snapshot) &&
        run.steps.length >= selected.length &&
        samePlan(run.steps.slice(0, selected.length), selected),
    )
    .at(-1)
}

function checkRunStatus(run: QueueRun, selectedCount: number): PREligibility["checks"]["status"] {
  const selected = run.steps.slice(0, selectedCount)
  if (selected.every((step) => step.job?.status === "passed")) return "passed"
  if (selected.some((step) => step.job?.status === "failed" || step.job?.status === "lost")) return "failed"
  return run.status === "failed" ? "failed" : "checking"
}

function admissionQueue(state: DeepReadonly<RuntimeState>, steps: readonly RuntimeStep[]): PR[] {
  const selected = admissionSteps(state.queues, steps)
  if (selected.length === 0) return []
  return Object.values(state.bays.prs)
    .filter((pr) => pr.status === "pushed" || pr.status === "submitted")
    .filter((pr) => checksRequested(pr))
    .filter((pr) => {
      const run = admissionRun(state, Queues.snapshot(pr), selected)
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
  const selected = admissionSteps(state.queues, steps)
  if (selected.length === 0) return { status: "passed", ...timing }
  const run = checkFactRun(state, Queues.snapshot(pr), selected)
  if (run !== undefined) return { status: checkRunStatus(run, selected.length), ...timing, run: run.id }
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

function checkError(job: Job | undefined, run: QueueRun): JobError | undefined {
  if (job?.status === "failed") return job.error
  if (job?.status === "lost") return { code: "job-lost", message: job.lostReason }
  return run.error
}

function checkStatus(job: Job | undefined, run: QueueRun): PRCheckRecord["status"] {
  if (run.status === "failed" && (job === undefined || !Job.terminal(job))) return "failed"
  if (job?.status === "passed") return "passed"
  if (job?.status === "failed" || job?.status === "lost") return "failed"
  return "checking"
}

function projectCheckStep(
  pr: DeepReadonly<PR>,
  run: QueueRun,
  step: QueueStep,
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
      ? [`queue.step.${step.name}`]
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
  const run = checks.run === undefined ? undefined : materializeRun(Queues.record(state.queues, checks.run), state.jobs)
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
  const hasStartedStep = run.steps.some((step) => step.job !== undefined)
  const records = run.steps
    .filter((step) => !step.integrates && !step.needsIntegration)
    .flatMap((step, index) => {
      if (step.job === undefined && (hasStartedStep || index !== run.cursor)) return []
      const record = projectCheckStep(pr, run, step, checks.queuedAt)
      return record === undefined ? [] : [record]
    })
  const evidenceStep =
    run.error?.evidence === undefined
      ? undefined
      : run.steps.find(
          (step) =>
            (step.integrates || step.needsIntegration) &&
            (step.job?.status === "failed" || step.job?.status === "lost"),
        )
  const evidenceRecord =
    evidenceStep === undefined ? undefined : projectCheckStep(pr, run, evidenceStep, checks.queuedAt)
  const projected = evidenceRecord === undefined ? records : [...records, evidenceRecord]
  return projected.length === 0
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
    : projected
}

function reusablePrefix(
  state: DeepReadonly<RuntimeState>,
  snapshots: readonly DeepReadonly<PRSnapshot>[],
  selected: readonly RuntimeStep[],
): Readonly<{ run: QueueRunId; count: number; shape: PRShape }> | undefined {
  const snapshot = snapshots.length === 1 ? snapshots[0] : undefined
  if (snapshot?.baseSha === undefined) return undefined
  const boundary = selected.findIndex((step) => step.integrates || step.needsIntegration)
  const prefix = boundary < 0 ? selected : selected.slice(0, boundary)
  if (prefix.length === 0 || prefix.some((step) => step.classification === "base")) return undefined
  const cached = admissionRun(state, snapshot, prefix)
  if (cached?.status !== "passed") return undefined
  const record = Queues.record(state.queues, cached.id)
  return { run: cached.id, count: prefix.length, shape: shapeThrough(record, state.jobs) }
}

function runnablePRs(
  state: DeepReadonly<RuntimeState>,
  args: QueueRunArgs,
  steps: readonly RuntimeStep[],
  excluded: ReadonlySet<string> = new Set(),
): PR[] {
  const requested = requestedPRs(state.bays, args, excluded)
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
  const required = state.queues.requires.includes("review")
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
  const base = baseIdentity(pr.base)
  const pause = state.queues.pauses[base]
  if (pause !== undefined && !pause.allowedPRs.includes(pr.id)) {
    return result({
      code: "queue-paused",
      message: `queue '${base}' is paused: ${pause.reason}; PR '${pr.id}' is not in the allowed set`,
    })
  }
  const claimed = orderedQueues(state.queues, state.jobs).some(
    (run) => !Queues.terminal(run) && run.prs.some((candidate) => candidate.id === pr.id),
  )
  return claimed
    ? result({
        code: "claimed",
        message: `PR '${pr.id}' is already in an active queue run`,
      })
    : result()
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
