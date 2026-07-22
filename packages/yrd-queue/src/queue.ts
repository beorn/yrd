import {
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
  PRTerminalAssociationSchema,
  baseIdentity,
  checkRequest,
  checksRequested,
  resolveBase,
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
  observeYrdLifecycle,
  parseJournalFrame,
  raiseFailure,
  type CommandHandler,
  type CommandResult,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type EventDraft,
  type JsonValue,
  type JournalHistory,
  type YrdDef,
  type YrdDeliveryIdentity,
  type YrdLifecycleOutcome,
} from "@yrd/core"
import {
  createJobDef,
  Job,
  JobErrorSchema,
  type HasJobs,
  type JobDef,
  type JobDefs,
  type JobError,
  type JobObservation,
  type JobCompletion,
  type JobHandler,
  type JobResult,
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
  ReplayQueueRecordSchema,
  Queues,
  PRSnapshotSchema,
  type AddStepResult,
  type BatchConfig,
  type InstalledStep,
  type IntegratedShape,
  type IntegrationProof,
  type QueueAuditFinding,
  type QueueAuditResult,
  type QueueAuthorityState,
  type QueueAuthorityToken,
  type QueuePause,
  type QueueRecord,
  type QueueRequirement,
  type QueueRun,
  type QueueRunAuthority,
  type QueueRunId,
  type QueueSummary,
  type QueueTerminalAssociation,
  type QueuesState,
  type QueueStep,
  type QueueUnassociatedTerminal,
  type StepSelection,
  type PREligibility,
  type PRCheckRecord,
  type PRShape,
  type PRSnapshot,
} from "./model.ts"
import {
  activeQueueRootIds,
  childRunId,
  indexQueueStart,
  latestExactRunId,
  latestPrefixRunId,
  projectionLookupGet,
  projectionLookupSet,
  projectionLookupValues,
  queueLookupKey,
  recordReleasedAdmissionFailure,
  releasedAdmissionFailures,
} from "./projection-index.ts"
import { compactQueuesState, queueRetentionRoot } from "./retention.ts"

/**
 * A queue command refused to compose because a peer's Queue run already holds
 * the base branch. Always thrown, never returned, so a genuine caller error
 * still fails loud. The carried `base`/`runId` let a resident, multi-tenant
 * runner tell this losable "the queue is busy right now" race apart from other
 * failures — without matching on the message text. For a long-lived resident
 * watch this is losable: the peer's run settles and frees the base by the next
 * interval, so defer and retry (see isQueueRunningConflict). A one-shot
 * targeted `queue run <selector>` still sees it propagate — it has no next
 * interval.
 */
export class QueueRunningConflict extends Error {
  readonly base: string
  readonly runId: string

  constructor(base: string, runId: string) {
    super(`yrd: queue '${base}' is running '${runId}'`)
    this.name = "QueueRunningConflict"
    this.base = base
    this.runId = runId
  }
}

/** True when an error is a QueueRunningConflict — a peer already holds the base.
 * A losable race for a resident runner: defer this cycle and retry next. */
export function isQueueRunningConflict(error: unknown): error is QueueRunningConflict {
  return error instanceof QueueRunningConflict
}

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
  })
  .strict()
export type QueueRunArgs = Readonly<z.infer<typeof QueueRunArgsSchema>>

const AdmitArgsSchema = z.object({ pr: z.string().trim().min(1) }).strict()
export type AdmitArgs = Readonly<z.infer<typeof AdmitArgsSchema>>
export type AdmitSelection = Readonly<{ prs?: readonly string[] }>

const AdvanceArgsSchema = z.object({ run: QueueRunIdSchema }).strict()
const SettledArgsSchema = AdvanceArgsSchema
const IsolateArgsSchema = AdvanceArgsSchema.extend({ part: z.union([z.literal(0), z.literal(1)]) }).strict()
export type PauseQueueArgs = Readonly<{ base: string; reason: string; allowedPRs: readonly string[] }>
export type RecoverQueueOptions = Readonly<{ recoveryTime: string; reason?: string; runner?: string }>
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
const ReplayQueueStartSchema = ReplayQueueRecordSchema.omit({ startedAt: true, failure: true })
const QueueFailedPRSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    actor: z.string().trim().min(1).optional(),
  })
  .strict()
const LegacyQueueFailedSchema = z.object({ run: QueueRunIdSchema, error: JobErrorSchema }).strict()
const QueueFailedSchema = LegacyQueueFailedSchema.extend({ prs: z.array(QueueFailedPRSchema).min(1) }).strict()
const ReplayQueueFailedSchema = z.union([QueueFailedSchema, LegacyQueueFailedSchema])
const CancelRunArgsSchema = z
  .object({
    run: QueueRunIdSchema,
    by: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict()
export type CancelRunArgs = Readonly<z.infer<typeof CancelRunArgsSchema>>
const QuiesceLegacyRunArgsSchema = z
  .object({
    run: QueueRunIdSchema,
    reason: z.string().trim().min(1),
  })
  .strict()
export type QuiesceLegacyRunArgs = Readonly<z.infer<typeof QuiesceLegacyRunArgsSchema>>
const QueueAuthorityTokenFactSchema = z.object({
  pr: PRIdSchema,
  revision: z.number().int().positive(),
  headSha: GitShaSchema,
})
const QueueRecutAuthorityFactSchema = z.object({
  pr: PRIdSchema,
  successor: z.object({ revision: z.number().int().positive(), headSha: GitShaSchema }),
})
const QueueAuthorityPRFactSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive().optional(),
    headSha: GitShaSchema.optional(),
  })
  .refine((fact) => (fact.revision === undefined) === (fact.headSha === undefined), {
    message: "revision and headSha must be provided together",
  })
const QueueRejectedTerminalFactSchema = z.object({
  pr: PRIdSchema,
  revision: z.number().int().positive(),
  headSha: GitShaSchema.optional(),
  run: QueueRunIdSchema.optional(),
})
const AssociateTerminalsArgsSchema = z
  .object({ associations: z.array(PRTerminalAssociationSchema) })
  .strict()
  .superRefine(({ associations }, context) => {
    const seen = new Set<string>()
    for (const [index, association] of associations.entries()) {
      if (seen.has(association.evidence.terminalEvent)) {
        context.addIssue({ code: "custom", message: "duplicate terminal event", path: ["associations", index] })
      }
      seen.add(association.evidence.terminalEvent)
    }
  })
type AssociateTerminalsArgs = Readonly<z.infer<typeof AssociateTerminalsArgsSchema>>

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
    observe: stepObservation,
    observeResult: stepResultObservation,
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
    observe: stepObservation,
    observeResult: stepResultObservation,
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

function queueBase(state: DeepReadonly<RuntimeState>, selector: string): string {
  const known = [
    "main",
    ...Object.values(state.bays.byId).map((bay) => bay.base),
    ...Object.values(state.bays.prs).map((pr) => pr.base),
    ...Queues.values(state.queues).map((run) => run.base),
    ...Object.values(state.queues.pauses).map((pause) => pause.base),
  ]
  return resolveBase(known, selector) ?? baseIdentity(selector)
}

export type QueueCommands = Readonly<{
  queue: Readonly<{
    admit: CommandHandler<AdmitArgs, RuntimeState>
    run: CommandHandler<QueueRunArgs, RuntimeState>
    pause: CommandHandler<PauseQueueArgs, RuntimeState>
    resume: CommandHandler<Readonly<{ base: string }>, RuntimeState>
    advance: CommandHandler<Readonly<{ run: QueueRunId }>, RuntimeState>
    settled: CommandHandler<Readonly<{ run: QueueRunId }>, RuntimeState>
    isolate: CommandHandler<Readonly<{ run: QueueRunId; part: 0 | 1 }>, RuntimeState>
    cancelRun: CommandHandler<CancelRunArgs, RuntimeState>
    quiesceLegacyRun: CommandHandler<QuiesceLegacyRunArgs, RuntimeState>
    associateTerminals: CommandHandler<AssociateTerminalsArgs, RuntimeState>
  }>
}>

export type TerminalAssociationCandidate = Readonly<{
  run: QueueRunId
  status: QueueRun["status"]
  startedAt: string
  finishedAt?: string
  eligible: boolean
  error?: JobError
}>

export type TerminalAssociationTerminal = Readonly<{
  event: string
  at: string
  pr: string
  revision: number
  headSha?: string
}>

export type TerminalAssociationReady = Readonly<{
  status: "ready"
  terminal: TerminalAssociationTerminal & Readonly<{ headSha: string }>
  association: QueueTerminalAssociation
  proof: Readonly<{ candidates: readonly TerminalAssociationCandidate[] }>
}>

export type TerminalAssociationRefused = Readonly<{
  status: "refused"
  terminal: TerminalAssociationTerminal
  refusal: Readonly<{
    code:
      | "terminal-pr-missing"
      | "terminal-revision-missing"
      | "terminal-revision-ambiguous"
      | "terminal-state-mismatch"
      | "terminal-run-missing"
      | "terminal-run-not-failed"
      | "terminal-run-chronology"
      | "terminal-run-ambiguous"
    message: string
  }>
  candidates: readonly TerminalAssociationCandidate[]
}>

export type TerminalAssociationRow = TerminalAssociationReady | TerminalAssociationRefused

export type TerminalAssociationPlan = Readonly<{
  provenance: "migration/21091"
  rows: readonly TerminalAssociationRow[]
  summary: Readonly<{ unprojectable: number; ready: number; refused: number; appended: number }>
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
  cancel(args: CancelQueueArgs): Promise<readonly QueueRun[]>
  cancelRun(args: CancelRunArgs): Promise<QueueRun>
  recover(options: RecoverQueueOptions): Promise<readonly QueueRun[]>
  audit(): QueueAuditResult
  eligibility(selector: string): PREligibility
  eligibilities(): readonly PREligibility[]
  checks(selectors?: readonly string[]): readonly PRCheckRecord[]
  terminalAssociationPlan(): TerminalAssociationPlan
  migrateTerminalAssociations(): Promise<TerminalAssociationPlan>
  quiesceLegacyRoots(options: QuiesceLegacyRootsOptions): Promise<QuiesceLegacyRootsReceipt>
  retentionDiagnostics(): Readonly<{
    retainedRuns: number
    unsettledTrees: number
    terminalTrees: number
    archiveAvailable: boolean
  }>
  get(run: QueueRunId): QueueRun | undefined
  history(): Promise<readonly QueueRun[]>
  status(base: string): QueueSummary
}>

export type QuiesceLegacyRootsOptions = Readonly<{
  /** ISO timestamp used to decide whether a legacy root's writer lease is still live. */
  now: string
  /** Migration identity recorded on each settled job cancellation. */
  by: string
}>

export type QuiesceLegacyRootsReceipt = Readonly<{
  provenance: "migration/21012-legacy-quiesce"
  reason: "legacy-quiesced"
  quiesced: readonly Readonly<{ run: QueueRunId; jobs: readonly string[] }>[]
}>

export type QueueRunOptions = RunJobOptions & Readonly<{ continueAdmissions?: () => boolean }>

export type WaitingQueueStep = Readonly<{
  run: QueueRun
  step: QueueStep & Readonly<{ job: Extract<Job, { status: "waiting" }> }>
}>

export type FinishQueueArgs = Omit<JobCompletion, "token"> & Readonly<{ job: Job["id"]; step?: string; token: string }>

export type CancelQueueArgs = Readonly<{
  prs: readonly string[]
  by: string
  reason: string
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
        "queue/run/canceled": CancelRunArgsSchema,
        "queue/run/settled": SettledArgsSchema,
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
      replayEvents: {
        "queue/run/started": z.object({ run: ReplayQueueStartSchema }).strict(),
        "queue/run/failed": ReplayQueueFailedSchema,
        "queue/run/canceled": CancelRunArgsSchema,
        "queue/run/settled": SettledArgsSchema,
      },
      projectionVersion: "queues-v5-legacy-root-retention",
      project: projectQueues,
      compact: (state, complete) => {
        const runtime = complete as unknown as DeepReadonly<RuntimeState>
        return { queues: compactQueueProjection(state.queues, runtime.jobs, runtime.bays) }
      },
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
              settled: (run) => yrd.dispatch(commands.queue.settled, { run }),
              isolate: (run, part) => yrd.dispatch(commands.queue.isolate, { run, part }),
              cancelRun: (args) => yrd.dispatch(commands.queue.cancelRun, args),
              quiesceLegacyRun: (args) => yrd.dispatch(commands.queue.quiesceLegacyRun, args),
              associateTerminals: (args) => yrd.dispatch(commands.queue.associateTerminals, args),
              requestChecks: (pr, baseSha) =>
                yrd.bays.requestChecks({ pr, ...(baseSha === undefined ? {} : { baseSha }) }),
            },
            steps,
            options.resolveBaseSha,
            yrd.log.child("queue"),
            yrd.history,
            async () => (await yrd.historySnapshot()).state as unknown as DeepReadonly<RuntimeState>,
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
  settled(run: QueueRunId): Promise<CommandResult>
  isolate(run: QueueRunId, part: 0 | 1): Promise<CommandResult>
  cancelRun(args: CancelRunArgs): Promise<CommandResult>
  quiesceLegacyRun(args: QuiesceLegacyRunArgs): Promise<CommandResult>
  associateTerminals(args: AssociateTerminalsArgs): Promise<CommandResult>
  requestChecks(pr: string, baseSha?: string): Promise<CommandResult>
}>

function terminalIdentity(
  terminal: DeepReadonly<QueueUnassociatedTerminal>,
  headSha?: string,
): TerminalAssociationTerminal {
  const resolvedHeadSha = headSha ?? terminal.headSha
  return {
    event: terminal.event,
    at: terminal.at,
    pr: terminal.pr,
    revision: terminal.revision,
    ...(resolvedHeadSha === undefined ? {} : { headSha: resolvedHeadSha }),
  }
}

function refusedTerminalAssociation(
  terminal: DeepReadonly<QueueUnassociatedTerminal>,
  code: TerminalAssociationRefused["refusal"]["code"],
  message: string,
  candidates: readonly TerminalAssociationCandidate[] = [],
  headSha?: string,
): TerminalAssociationRefused {
  return {
    status: "refused",
    terminal: terminalIdentity(terminal, headSha),
    refusal: { code, message },
    candidates,
  }
}

function terminalAssociationPlan(state: DeepReadonly<RuntimeState>, appended = 0): TerminalAssociationPlan {
  const rows = Object.values(state.queues.terminalAssociations.pending)
    .toSorted((left, right) => left.at.localeCompare(right.at) || left.event.localeCompare(right.event))
    .map((terminal): TerminalAssociationRow => {
      const pr = state.bays.prs[terminal.pr]
      if (pr === undefined) {
        return refusedTerminalAssociation(
          terminal,
          "terminal-pr-missing",
          `yrd: legacy terminal '${terminal.event}' names missing PR '${terminal.pr}'`,
        )
      }
      const revisions = pr.revisions.filter(
        (revision) =>
          revision.revision === terminal.revision &&
          (terminal.headSha === undefined || revision.headSha === terminal.headSha),
      )
      if (revisions.length === 0) {
        return refusedTerminalAssociation(
          terminal,
          "terminal-revision-missing",
          `yrd: legacy terminal '${terminal.event}' has no PR '${terminal.pr}' revision ${terminal.revision}`,
        )
      }
      if (revisions.length !== 1) {
        return refusedTerminalAssociation(
          terminal,
          "terminal-revision-ambiguous",
          `yrd: legacy terminal '${terminal.event}' matches ${revisions.length} revisions of PR '${terminal.pr}'`,
        )
      }
      const revision = revisions[0]
      if (revision === undefined) throw new Error("yrd: terminal revision selection lost its only revision")
      if (revision.terminal?.status !== "rejected" || revision.terminal.at !== terminal.at) {
        return refusedTerminalAssociation(
          terminal,
          "terminal-state-mismatch",
          `yrd: legacy terminal '${terminal.event}' is not the projected rejection for ${terminal.pr} revision ${terminal.revision}@${revision.headSha}`,
          [],
          revision.headSha,
        )
      }
      const runs = Queues.values(state.queues)
        .filter((record) =>
          record.prs.some(
            (candidate) =>
              candidate.id === terminal.pr &&
              candidate.revision === terminal.revision &&
              candidate.headSha === revision.headSha,
          ),
        )
        .map((record) => materializeRun(record, state.jobs))
        .toSorted(
          (left, right) =>
            left.startedAt.localeCompare(right.startedAt) ||
            left.id.localeCompare(right.id, undefined, { numeric: true }),
        )
      const candidates = runs.map(
        (run): TerminalAssociationCandidate => ({
          run: run.id,
          status: run.status,
          startedAt: run.startedAt,
          ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
          eligible:
            run.status === "failed" &&
            run.finishedAt !== undefined &&
            run.startedAt <= run.finishedAt &&
            run.finishedAt <= terminal.at,
          ...(run.error === undefined ? {} : { error: { ...run.error } }),
        }),
      )
      const eligible = candidates.filter((candidate) => candidate.eligible)
      if (eligible.length === 0) {
        const failed = candidates.filter(({ status }) => status === "failed")
        const code =
          candidates.length === 0
            ? "terminal-run-missing"
            : failed.length === 0
              ? "terminal-run-not-failed"
              : "terminal-run-chronology"
        const detail =
          code === "terminal-run-missing"
            ? "no matching Queue run exists"
            : code === "terminal-run-not-failed"
              ? `matching Queue runs are not failed: ${candidates.map(({ run, status }) => `${run}=${status}`).join(", ")}`
              : `failed Queue run chronology does not end before the terminal: ${failed
                  .map(({ run, startedAt, finishedAt }) => `${run}=${startedAt}..${finishedAt ?? "unterminated"}`)
                  .join(", ")}`
        return refusedTerminalAssociation(
          terminal,
          code,
          `yrd: legacy terminal '${terminal.event}' cannot prove one failed Queue run for ${terminal.pr} revision ${terminal.revision}@${revision.headSha}: ${detail}`,
          candidates,
          revision.headSha,
        )
      }
      if (eligible.length !== 1) {
        return refusedTerminalAssociation(
          terminal,
          "terminal-run-ambiguous",
          `yrd: legacy terminal '${terminal.event}' has ${eligible.length} failed Queue runs for ${terminal.pr} revision ${terminal.revision}@${revision.headSha}: ${eligible.map(({ run }) => run).join(", ")}`,
          candidates,
          revision.headSha,
        )
      }
      const selected = eligible[0]
      if (selected === undefined) throw new Error("yrd: terminal run selection lost its only run")
      const association: QueueTerminalAssociation = {
        pr: terminal.pr,
        revision: terminal.revision,
        headSha: revision.headSha,
        run: selected.run,
        provenance: "migration/21091",
        evidence: { terminalEvent: terminal.event, run: selected.run },
      }
      return {
        status: "ready",
        terminal: { ...terminalIdentity(terminal, revision.headSha), headSha: revision.headSha },
        association,
        proof: { candidates },
      }
    })
  const ready = rows.filter(({ status }) => status === "ready").length
  const refused = rows.length - ready
  return {
    provenance: "migration/21091",
    rows,
    summary: { unprojectable: rows.length, ready, refused, appended },
  }
}

function sameTerminalAssociation(
  left: DeepReadonly<QueueTerminalAssociation>,
  right: DeepReadonly<QueueTerminalAssociation>,
): boolean {
  return (
    left.pr === right.pr &&
    left.revision === right.revision &&
    left.headSha === right.headSha &&
    left.run === right.run &&
    left.provenance === right.provenance &&
    left.evidence.terminalEvent === right.evidence.terminalEvent &&
    left.evidence.run === right.evidence.run
  )
}

function createQueue<Shape extends PRShape>(
  state: ReadSignal<DeepReadonly<QueuesState>>,
  runtime: () => DeepReadonly<RuntimeState>,
  jobs: HasJobs["jobs"],
  actions: QueueActions,
  steps: readonly RuntimeStep[],
  resolveBaseSha: QueueOptions<readonly AnyStepDef[]>["resolveBaseSha"],
  log: ConditionalLogger,
  history: JournalHistory<unknown> | undefined,
  historicalState: () => Promise<DeepReadonly<RuntimeState>>,
): Queue<Shape> {
  const current = (id: QueueRunId): QueueRun => materializeRun(Queues.record(state(), id), runtime().jobs)

  const archived = (id: QueueRunId): QueueRun | undefined => {
    if (history === undefined) return undefined
    const canonical = /^r\d+$/iu.test(id.trim()) ? id.trim().toUpperCase() : id
    return materializeArchivedRun(history, jobs, state(), canonical)
  }

  const cleanupSettledRoots = async (): Promise<readonly QueueRunId[]> => {
    const cleaned: QueueRunId[] = []
    for (const id of activeQueueRootIds(runtime().queues.authority)) {
      const snapshot = runtime()
      const record = Queues.record(snapshot.queues, id)
      const run = materializeRun(record, snapshot.jobs)
      if (record.parent !== undefined || needsSettlement(snapshot, run)) continue
      const result = await actions.settled(id)
      if (result.events.length > 0) cleaned.push(id)
    }
    return cleaned
  }

  const waiting = (selector: string, stepName?: string): WaitingQueueStep => {
    const snapshot = runtime()
    let record = Queues.resolve(snapshot.queues, selector)
    let pr = resolvePR(snapshot.bays, selector)
    if (record !== undefined && pr !== undefined) {
      if (record.id === selector) pr = undefined
      else if (pr.id === selector) record = undefined
      else {
        const candidates = [record.id, pr.id].toSorted((left, right) => left.localeCompare(right))
        raiseFailure(
          "refusal",
          "selector-ambiguous",
          `yrd: queue run or PR selector '${selector}' is ambiguous: ${candidates.join(", ")}`,
        )
      }
    }
    let selected = record === undefined ? undefined : materializeRun(record, snapshot.jobs)
    if (selected === undefined) {
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
        try {
          await jobs.run(active.job.id, options)
        } catch (cause) {
          // merge-queue R43: a peer runtime can cancel (or otherwise settle)
          // the Job between this runtime's ownership check and its settlement
          // commit — the commit re-folds the journal, meets the terminal Job,
          // and the transition guard throws. That guard protects state
          // integrity and stays; HERE the condition is recoverable: the Job is
          // already settled, so record a loud typed skip and keep composing
          // instead of killing the resident runner. The skip is
          // terminal-state-verified against the refreshed projection — any
          // failure while the Job is still live propagates unchanged.
          await actions.refresh()
          const raced = runtime().jobs.byId[active.job.id]
          if (raced === undefined || !Job.terminal(raced)) throw cause
          log.warn?.("queue step settlement lost to a peer transition; skipping the settled job", {
            action: "canceled-skip",
            run: id,
            job: active.job.id,
            status: raced.status,
            reason: cause instanceof Error ? cause.message : String(cause),
          })
        }
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
    const observed = current(id)
    const continuation = observed.steps.some((step) => step.job !== undefined && step.job.status !== "requested")
    const markSettledRoot = async (): Promise<QueueRun> => {
      const snapshot = runtime()
      const record = Queues.record(snapshot.queues, id)
      const run = materializeRun(record, snapshot.jobs)
      if (record.parent === undefined && !needsSettlement(snapshot, run)) await actions.settled(id)
      return current(id)
    }
    // Stale re-report guard #1: a run with nothing left to settle has ALREADY
    // emitted its one run lifecycle at its real settlement. Return it untouched —
    // no drive, no re-emit.
    if (!needsSettlement(runtime(), observed)) return markSettledRoot()

    const settleTree = async (): Promise<QueueRun> => {
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
        if (child === undefined) {
          throw new Error(`yrd: queue run '${settled.id}' did not create isolation part ${part}`)
        }
        await settle(child.id, options)
      }
      return current(id)
    }

    // Stale re-report guard #2: a run that is ALREADY terminal at entry but still
    // needs settlement is a bisection parent whose child runs are being driven
    // this cycle. Its own status/outcome is fixed, so its run lifecycle was
    // emitted when it first settled — progress the bisection tree WITHOUT
    // re-observing the parent (re-emitting a terminal run each cycle with a bogus
    // few-millisecond duration is the "R603 re-reported later, durationMs:3"
    // artifact). The child runs observe their own settlements.
    if (Queues.terminal(observed)) {
      await settleTree()
      return markSettledRoot()
    }

    const result = await observeYrdLifecycle(
      log,
      {
        lifecycle: "run",
        identity: { run: id },
        attributes: {
          base: observed.base,
          prs: observed.prs.map(deliveryIdentity),
          steps: observed.steps.map((step) => step.name),
          ...(continuation ? { continuation: true } : {}),
        },
        outcome: queueRunOutcome,
        resultAttributes: (result) => ({
          status: result.status,
          // A run-owned failure (no step owns the ERROR) carries its JobError so
          // the human row can render `err=<slug>`; harmless on a settled run.
          ...(result.error === undefined ? {} : { error: result.error }),
        }),
      },
      settleTree,
    )
    await markSettledRoot()
    return result
  }

  const startedRun = (result: CommandResult): QueueRun | undefined => {
    const started = result.events.find((applied) => applied.name === "queue/run/started")
    if (started === undefined) return undefined
    return current(QueueStartSchema.parse((started.data as { run?: unknown }).run).id)
  }

  const refreshCheckIdentities = async (prs: readonly DeepReadonly<PR>[]): Promise<void> => {
    if (resolveBaseSha === undefined) return
    const resolvedBaseShas = new Map<string, string>()
    for (const pr of prs) {
      if (!checksRequested(pr)) continue
      const base = baseIdentity(pr.base)
      let baseSha = resolvedBaseShas.get(base)
      if (baseSha === undefined) {
        baseSha = await resolveBaseSha(base)
        resolvedBaseShas.set(base, baseSha)
      }
      if (checkRequest(pr)?.baseSha === baseSha) continue
      await actions.requestChecks(pr.id, baseSha)
    }
  }

  const dispatchAdmissions = async (selectors: readonly string[]): Promise<QueueRun[]> => {
    const admitted: QueueRun[] = []
    for (const selector of selectors) {
      const started = startedRun(await actions.admit({ pr: selector }))
      if (started !== undefined) admitted.push(started)
    }
    return admitted
  }

  const drainAdmissions = async (selectors: readonly string[], options: QueueRunOptions): Promise<QueueRun[]> => {
    const targets = new Set(selectors)
    const outcomes = new Map<QueueRunId, QueueRun>()
    const remember = (candidate: QueueRun): void => {
      if (candidate.prs.some((pr) => targets.has(pr.id))) outcomes.set(candidate.id, candidate)
    }

    while (targets.size > 0) {
      if (options.continueAdmissions?.() === false) break
      await actions.refresh()
      const snapshot = runtime()
      const active = activeQueueRuns(snapshot.queues, snapshot.jobs).find(
        (candidate) =>
          candidate.status === "running" && samePlan(candidate.steps, admissionSteps(snapshot.queues, steps)),
      )
      if (active !== undefined) {
        const settled = await settle(active.id, options)
        remember(settled)
        if (settled.status === "running") break
        continue
      }

      const queued = admissionQueue(snapshot, steps)
      const admitted = await dispatchAdmissions(
        (options.continueAdmissions === undefined ? queued : queued.slice(0, 1)).map((pr) => pr.id),
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
      return observeYrdLifecycle(
        log,
        {
          lifecycle: "admit",
          attributes: { selectors: args.prs },
          outcome: queueRunsOutcome,
          resultAttributes: (runs) => ({ runs: runs.map(runEvidence) }),
        },
        async () => {
          await actions.refresh()
          await cleanupSettledRoots()
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
          return runOptions === undefined ? dispatchAdmissions(selectors) : drainAdmissions(selectors, runOptions)
        },
      )
    },
    async pause(args) {
      const snapshot = runtime()
      const base = queueBase(snapshot, args.base)
      const allowedPRs = args.allowedPRs.map((selector) => {
        const pr = resolvePR(snapshot.bays, selector)
        if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${selector}'`)
        return pr.id
      })
      await actions.pause({ ...args, base, allowedPRs })
      const pause = state().pauses[base]
      if (pause === undefined) throw new Error(`yrd: queue '${base}' did not retain its pause`)
      return pause
    },
    async resume(base) {
      await actions.resume(queueBase(runtime(), base))
    },
    async run(args, runOptions) {
      return observeYrdLifecycle(
        log,
        {
          lifecycle: "compose",
          attributes: { selectors: args.prs, steps: args.steps },
          outcome: queueRunsOutcome,
          label: composeSettlementLabel,
          resultAttributes: (runs) => ({ runs: runs.map(runEvidence) }),
        },
        async () => {
          const explicitStepAuthority = args.steps !== undefined
          await actions.refresh()
          await cleanupSettledRoots()
          if (args.steps?.length === 0) return []
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
          const checked = explicitStepAuthority ? [] : requested.filter((pr) => checksRequested(pr))
          const before = new Map(checked.map((pr) => [pr.id, checkEligibility(snapshot, pr, steps).status]))
          await refreshCheckIdentities(checked)
          const admissions = await drainAdmissions(
            checked.map((pr) => pr.id),
            runOptions,
          )
          const implicitQueue = args.prs === undefined || args.prs.length === 0
          const drainMerges = async (): Promise<void> => {
            const current = runtime()
            const prs = runnablePRs(current, args, steps, consumed, { explicitStepAuthority }).filter(
              (pr) => !activeBases.has(baseIdentity(pr.base)),
            )
            for (const candidate of partitionCandidates(prs, current.queues.batchSize)) {
              if (runOptions.continueAdmissions?.() === false) break
              const started = await actions.run({
                prs: candidate.map((pr) => pr.id),
                ...(args.steps === undefined ? {} : { steps: args.steps }),
              })
              const startedEvent = started.events.find((applied) => applied.name === "queue/run/started")
              // Re-evaluation inside the serialized command may prove that this
              // candidate's complete plan is already satisfied by a cached run.
              // That idempotent no-op must not starve later candidates in the
              // same resident drain.
              if (startedEvent === undefined) continue
              const id = QueueStartSchema.parse((startedEvent.data as { run?: unknown }).run).id
              roots.push(id)
              await settle(id, runOptions)
            }
          }
          // The implicit (resident-drain) queue merges already-passed PRs
          // BEFORE the unsettled-window return below: under continuous
          // admissions the check window may never settle, and gating the merge
          // phase on a settled window starves every passed candidate forever
          // (the 2026-07-22 merge-phase livelock). runnablePRs silently filters
          // the implicit queue to check-passed PRs, so a pending PR can never
          // leak into a merge candidate. The explicit path keeps merge after
          // the window check: there runnablePRs raises for not-ready PRs, and
          // "checks still running" must stay a receipt, not a refusal.
          if (implicitQueue) await drainMerges()
          snapshot = runtime()
          const unsettled = checked.filter((pr) => checkEligibility(snapshot, pr, steps).status !== "passed")
          if (unsettled.length > 0) {
            const newlyFailed = unsettled.some(
              (pr) => before.get(pr.id) !== "failed" && checkEligibility(snapshot, pr, steps).status === "failed",
            )
            if (newlyFailed || unsettled.some((pr) => checkEligibility(snapshot, pr, steps).status !== "failed")) {
              // Merge/resumable runs settled in this drain stay visible in the
              // receipts even when the check window is still unsettled.
              const final = runtime()
              return [...admissions, ...roots.flatMap((root) => queueTree(final.queues, final.jobs, root))]
            }
          }
          if (!implicitQueue) await drainMerges()
          const final = runtime()
          return roots.flatMap((root) => queueTree(final.queues, final.jobs, root))
        },
      )
    },
    waiting,
    async finish(selector, completion, runOptions) {
      return observeYrdLifecycle(
        log,
        {
          lifecycle: "finish",
          identity: { job: completion.job, attempt: completion.attempt, runner: completion.runner },
          attributes: { selector, step: completion.step },
          outcome: queueRunOutcome,
          resultAttributes: runEvidence,
        },
        async () => {
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
          return settle(selected.run.id, runOptions)
        },
      )
    },
    async cancel(args) {
      const selected = new Set(args.prs)
      const affected: QueueRunId[] = []
      for (const candidate of activeQueueRuns(runtime().queues, runtime().jobs)) {
        if (!candidate.prs.some((pr) => selected.has(pr.id))) continue
        const active = candidate.steps[candidate.cursor]?.job
        const cancelable =
          active?.status === "requested" || active?.status === "running" || active?.status === "waiting"
        if (!cancelable && Queues.terminal(candidate)) continue
        if (cancelable) {
          await jobs.cancel({ id: active.id, attempt: active.attempt, by: args.by, reason: args.reason })
        }
        await actions.advance(candidate.id)
        affected.push(candidate.id)
      }
      return affected.map(current)
    },
    async cancelRun(args) {
      const record = Queues.resolve(runtime().queues, args.run)
      if (record === undefined) raiseFailure("refusal", "run-not-found", `yrd: no queue run '${args.run}'`)
      const run = materializeRun(record, runtime().jobs)
      if (Queues.terminal(run)) {
        raiseFailure(
          "refusal",
          "run-terminal",
          `yrd: queue run '${args.run}' is ${run.status}; only a running or waiting run can be canceled`,
        )
      }
      // Multi-tenant, deadlock-free cancel. This runs as a SEPARATE cli process
      // from the resident follow-runner. Journal the run cancellation FIRST: it
      // marks the record canceled (advanceQueue then stops reconciling it, so no
      // pr/canceled) and releases authority so the still-submitted PRs re-queue on
      // a future drain. THEN cancel the active job to abort in-flight work. We
      // NEVER synchronously cancel our own loop's active merge from inside the
      // drive loop (that deadlocks: the loop holds the queue writer while blocked
      // mid-merge). When the run's merge is in flight in the resident, this
      // journaled job cancellation surfaces there as a typed settlement conflict
      // that residentCycleRecovery honors at the next safe cycle boundary — no
      // second scheduler, no daemon.
      await actions.cancelRun(args)
      const active = run.steps[run.cursor]?.job
      const cancelable = active?.status === "requested" || active?.status === "running" || active?.status === "waiting"
      if (cancelable) {
        await jobs.cancel({ id: active.id, attempt: active.attempt, by: args.by, reason: args.reason })
      }
      return current(args.run)
    },
    async recover(recoverOptions) {
      // Capture ownership at the synchronous API boundary. A resident runner can
      // settle and release a lost root while recovery is entering its observed
      // async operation; that race must not erase the run from recovery evidence.
      const rootsBeforeRecovery = activeQueueRootIds(runtime().queues.authority)
      return observeYrdLifecycle(
        log,
        {
          lifecycle: "recover",
          attributes: {
            recoveryTime: recoverOptions.recoveryTime,
            ...(recoverOptions.reason === undefined ? {} : { reason: recoverOptions.reason }),
            ...(recoverOptions.runner === undefined ? {} : { runner: recoverOptions.runner }),
          },
          outcome: (runs) => (runs.length === 0 ? "succeeded" : "recovered"),
          resultAttributes: (runs) => ({ runs: runs.map(runEvidence) }),
        },
        async () => {
          const recoveredJobs = new Set(
            await jobs.recover({
              now: recoverOptions.recoveryTime,
              ...(recoverOptions.reason === undefined ? {} : { reason: recoverOptions.reason }),
              ...(recoverOptions.runner === undefined ? {} : { runner: recoverOptions.runner }),
            }),
          )
          const affected = new Set<QueueRunId>()
          let snapshot = runtime()
          const recoveryRoots = new Set([...rootsBeforeRecovery, ...activeQueueRootIds(snapshot.queues.authority)])
          const candidates = [...recoveryRoots].flatMap((root) => queueTree(snapshot.queues, snapshot.jobs, root))
          for (const candidate of candidates) {
            const ownsRecoveredJob = candidate.steps.some(
              (step) => step.job !== undefined && recoveredJobs.has(step.job.id),
            )
            const hasTerminalFailure = candidate.steps.some(
              (step) => step.job?.status === "failed" || step.job?.status === "lost" || step.job?.status === "canceled",
            )
            if (hasTerminalFailure && needsAdvance(snapshot, candidate)) {
              const reconciled = await actions.advance(candidate.id)
              if (reconciled.events.length > 0) affected.add(candidate.id)
              snapshot = runtime()
            }
            if (ownsRecoveredJob) affected.add(candidate.id)
          }
          for (const id of await cleanupSettledRoots()) affected.add(id)
          const final = runtime()
          return [...affected].map((id) => materializeRun(Queues.record(final.queues, id), final.jobs))
        },
      )
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
    terminalAssociationPlan: () => terminalAssociationPlan(runtime()),
    async migrateTerminalAssociations() {
      await actions.refresh()
      const plan = terminalAssociationPlan(runtime())
      const associations = plan.rows.flatMap((row) => (row.status === "ready" ? [row.association] : []))
      if (associations.length === 0) return plan
      const result = await actions.associateTerminals({ associations })
      const appended = result.events.filter(({ name }) => name === "pr/terminal-associated").length
      return { ...plan, summary: { ...plan.summary, appended } }
    },
    async quiesceLegacyRoots(options) {
      await actions.refresh()
      const now = Date.parse(options.now)
      if (Number.isNaN(now)) throw new Error(`yrd: quiesceLegacyRoots requires an ISO 'now'; got '${options.now}'`)
      const targets = legacyRootTargets(runtime())
      const leased = targets.filter((target) => target.leased(now)).map((target) => target.run)
      if (leased.length > 0) {
        // A genuinely-active previous writer is protected: name the leased roots so
        // the operator learns which are held, and that unleased ones auto-quiesce.
        raiseFailure(
          "refusal",
          "legacy-root-leased",
          `yrd: Queue projection migration is blocked by live-leased legacy roots; a previous writer still holds ${leased.join(
            ", ",
          )} — unleased legacy roots would have been auto-quiesced`,
        )
      }
      const quiesced: { run: QueueRunId; jobs: string[] }[] = []
      for (const target of targets) {
        // Settle the run terminal first (record.failure stops re-advance), then
        // cancel each still-live job so the run AND its jobs all reach terminal.
        await actions.quiesceLegacyRun({ run: target.run, reason: "legacy-quiesced" })
        for (const job of target.jobs) {
          await jobs.cancel({ id: job.id, attempt: job.attempt, by: options.by, reason: "legacy-quiesced" })
        }
        quiesced.push({ run: target.run, jobs: target.jobs.map((job) => job.id) })
      }
      if (quiesced.length > 0) {
        // ONE loud structured receipt naming every settled root and job.
        log.warn?.(`legacy pre-settlement queue roots quiesced: ${quiesced.map((entry) => entry.run).join(", ")}`, {
          action: "legacy-quiesce",
          reason: "legacy-quiesced",
          by: options.by,
          runs: quiesced.map((entry) => entry.run),
          jobs: quiesced.flatMap((entry) => entry.jobs),
        })
      }
      return { provenance: "migration/21012-legacy-quiesce", reason: "legacy-quiesced", quiesced }
    },
    retentionDiagnostics() {
      const snapshot = state()
      const roots = new Set(Queues.values(snapshot).map((record) => queueRetentionRoot(snapshot, record.id)))
      const terminalTrees = [...roots].filter((root) => snapshot.retention.terminalOrder[root] !== undefined).length
      return {
        retainedRuns: Queues.values(snapshot).length,
        unsettledTrees: roots.size - terminalTrees,
        terminalTrees,
        archiveAvailable: history !== undefined,
      }
    },
    get(id) {
      const record = Queues.resolve(state(), id)
      return record === undefined ? archived(id) : materializeRun(record, runtime().jobs)
    },
    async history() {
      const snapshot = await historicalState()
      return orderedQueues(snapshot.queues, snapshot.jobs)
    },
    status: (base) => queueSummary(state(), runtime().jobs, queueBase(runtime(), base)),
  }) as Queue<Shape>
}

function deliveryIdentity(pr: DeepReadonly<PRSnapshot>): YrdDeliveryIdentity {
  return {
    pr: pr.id,
    revision: pr.revision,
    headSha: pr.headSha,
    // Carried so the resident runner's timeline rows can name the branch — the
    // watch-pane grammar (`R604 PR411.2  branch (merge ✓)`) needs it.
    branch: pr.branch,
    ...(pr.issue === undefined ? {} : { issue: pr.issue }),
    ...(pr.correlation === undefined ? {} : { correlation: pr.correlation }),
  }
}

function stepObservation(input: StepExecution): JobObservation {
  return {
    lifecycle: input.step,
    identity: { run: input.run, step: input.step },
    attributes: {
      index: input.index,
      // The run's base, carried so the resident timeline can name a step row
      // `[<base>#<run> <index>:<step>]`; every PR in a run shares its base.
      ...(input.prs[0]?.base === undefined ? {} : { base: input.prs[0].base }),
      prs: input.prs.map(deliveryIdentity),
      ...(input.targetSha === undefined ? {} : { targetSha: input.targetSha }),
    },
  }
}

type StepArtifactReference = Readonly<{
  name?: string
  path?: string
  kind?: string
  uri?: string
}>

function stepArtifactReference(value: unknown): StepArtifactReference | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Readonly<Record<string, unknown>>
  const path = typeof record.path === "string" && record.path !== "" ? record.path : undefined
  const uri = typeof record.uri === "string" && record.uri !== "" ? record.uri : undefined
  if (path === undefined && uri === undefined) return undefined
  return {
    ...(typeof record.name === "string" && record.name !== "" ? { name: record.name } : {}),
    ...(path === undefined ? {} : { path }),
    ...(typeof record.kind === "string" && record.kind !== "" ? { kind: record.kind } : {}),
    ...(uri === undefined ? {} : { uri }),
  }
}

function directStepArtifacts(value: unknown): readonly StepArtifactReference[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return []
  const artifacts = (value as Readonly<Record<string, unknown>>).artifacts
  if (!Array.isArray(artifacts)) return []
  return artifacts.flatMap((artifact) => {
    const reference = stepArtifactReference(artifact)
    return reference === undefined ? [] : [reference]
  })
}

function nestedStepArtifacts(value: unknown): readonly StepArtifactReference[] {
  if (value === null || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap(nestedStepArtifacts)
  const record = value as Readonly<Record<string, unknown>>
  return [
    ...directStepArtifacts(record),
    ...Object.entries(record).flatMap(([key, nested]) => (key === "artifacts" ? [] : nestedStepArtifacts(nested))),
  ]
}

/** Queue owns the standardized artifact convention for its step definitions.
 * Generic Jobs keeps result/evidence payloads opaque and invokes only this
 * definition-owned typed projection. Output and waiting artifacts are direct;
 * typed refusal evidence may nest the command evidence that owns its files. */
function stepResultObservation(result: JobResult): Readonly<Record<string, unknown>> {
  const artifacts = [
    ...(result.status === "waiting" ? directStepArtifacts(result) : directStepArtifacts(result.output)),
    ...(result.status === "failed" ? nestedStepArtifacts(result.error.evidence) : []),
  ]
  if (artifacts.length === 0) return {}
  return {
    artifacts: [...new Map(artifacts.map((artifact) => [JSON.stringify(artifact), artifact])).values()],
  }
}

function runEvidence(run: DeepReadonly<QueueRun>): Record<string, unknown> {
  return {
    run: run.id,
    base: run.base,
    status: run.status,
    prs: run.prs.map(deliveryIdentity),
    steps: run.steps.map((step) => step.name),
  }
}

function queueRunOutcome(run: DeepReadonly<QueueRun>): YrdLifecycleOutcome {
  if (run.status === "passed") return "succeeded"
  if (run.status === "failed") {
    // When a step Job failed, that step already owns the single ERROR
    // (yrd:jobs:<step>); the run settles at INFO so one failure is not re-raised
    // as a duplicate ERROR one level up. But a run that failed with NO step to
    // own it — a pinned/stale-base refusal rejected before the step's Job ran
    // (record.failure) — has no deeper ERROR. The run must own it, or the
    // failure is silent: fail loud with a run-scoped ERROR.
    const stepOwned = run.steps.some(
      (step) => step.job?.status === "failed" || step.job?.status === "lost" || step.job?.status === "canceled",
    )
    return stepOwned ? "settled" : "failed"
  }
  return "progress"
}

function queueRunsOutcome(runs: readonly DeepReadonly<QueueRun>[]): YrdLifecycleOutcome {
  if (runs.some((run) => run.status === "running" || run.status === "waiting")) return "progress"
  // As with a single run, a batch that finished with failures does not re-raise
  // ERROR: each failing run's deepest job already did. The compose settles at
  // INFO, and composeSettlementLabel names the per-run mix on the message.
  if (runs.some((run) => run.status === "failed")) return "settled"
  return "succeeded"
}

/** Name the per-run outcome mix of a settled compose so the flat "compose
 * failed" never misrepresents a batch that also passed runs. Returns undefined
 * for a uniform or still-running batch (the plain outcome word reads fine
 * there); a mixed/all-failed terminal batch gets `settled: N failed, M passed`. */
function composeSettlementLabel(runs: readonly DeepReadonly<QueueRun>[]): string | undefined {
  if (runs.length === 0 || !runs.every(Queues.terminal)) return undefined
  const failed = runs.filter((run) => run.status === "failed").length
  if (failed === 0) return undefined
  const passed = runs.filter((run) => run.status === "passed").length
  const other = runs.length - failed - passed
  const parts = [`${failed} failed`]
  if (passed > 0) parts.push(`${passed} passed`)
  if (other > 0) parts.push(`${other} other`)
  return `settled: ${parts.join(", ")}`
}

function queueFailedEvent(
  state: DeepReadonly<RuntimeState>,
  run: DeepReadonly<Pick<QueueRecord, "id" | "prs">>,
  error: DeepReadonly<JobError>,
): EventDraft {
  return event("queue/run/failed", {
    run: run.id,
    error,
    prs: run.prs.map((pr) => {
      const current = state.bays.prs[pr.id]
      const actor = current?.revisions.find(
        (revision) => revision.revision === pr.revision && revision.headSha === pr.headSha,
      )?.actor
      return {
        pr: pr.id,
        revision: pr.revision,
        headSha: pr.headSha,
        ...(actor === undefined ? {} : { actor }),
      }
    }),
  })
}

function createQueueCommands(steps: readonly RuntimeStep[], byName: ReadonlyMap<string, RuntimeStep>): QueueCommands {
  const admit = command({
    title: "Admit PR checks",
    params: AdmitArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: AdmitArgs) {
      const pr = resolvePR(state.bays, args.pr)
      if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${args.pr}'`)
      if (pr.status !== "pushed" && pr.status !== "submitted") {
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
      if (
        existing !== undefined &&
        status === "failed" &&
        projectionLookupGet(state.queues.authority.runs, existing.id)?.released === undefined
      ) {
        requireFreshCheckAuthority(state.queues.authority, snapshot, existing.id)
      } else {
        requireQueueAuthority(state.queues.authority, [snapshot], selected)
      }
      if (runningQueue(state.queues, state.jobs, pr.base) !== undefined) return { events: [] }
      if (checksRequested(pr)) {
        const first = admissionQueue(state, steps)[0]
        if (first !== undefined && first.id !== pr.id) return { events: [] }
      }
      return startRun(
        Queues.nextId(state.queues),
        [snapshot],
        selected,
        stepSelection(state.queues, steps, selected, "admission"),
        prShape([snapshot]),
      )
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
      const selected = selectSteps(steps, args.steps ?? state.queues.defaultSteps)
      const selection = stepSelection(
        state.queues,
        steps,
        selected,
        args.steps === undefined ? "configured" : "explicit",
      )
      const explicitStepAuthority = selection.authority === "explicit"
      const prs = runnablePRs(state, args, steps, new Set(), { explicitStepAuthority })
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
      const selectedPRs = new Set(prs.map((pr) => pr.id))
      const superseded =
        active !== undefined &&
        explicitStepAuthority &&
        active.prs.every((pr) => selectedPRs.has(pr.id)) &&
        unstartedAdmission(active, state.queues, steps)
          ? active
          : undefined
      if (active !== undefined && superseded === undefined) {
        throw new QueueRunningConflict(base, active.id)
      }
      const integrated = integratedPRShape(prs)
      validateSequence(selected, integrated !== undefined)
      const snapshots = prs.map(Queues.snapshot)
      const reuse =
        integrated === undefined && !explicitStepAuthority ? reusablePrefix(state, snapshots, selected) : undefined
      const remaining = reuse === undefined ? selected : selected.slice(reuse.count)
      if (remaining.length === 0) return { events: [] }
      requireQueueAuthority(state.queues.authority, snapshots, remaining)
      const started = startRun(
        Queues.nextId(state.queues),
        snapshots,
        remaining,
        selection,
        reuse?.shape ?? integrated ?? prShape(snapshots),
        integrated?.integration,
        {},
        reuse === undefined ? undefined : { run: reuse.run, results: reuse.shape.results },
      )
      return superseded === undefined
        ? started
        : {
            run: started.run,
            events: [
              queueFailedEvent(state, superseded, {
                code: "step-selection-superseded",
                message: `explicit steps '${selection.steps.join(",")}' superseded unstarted configured checks`,
              }),
              ...started.events,
            ],
          }
    },
  })

  const advance = command({
    title: "Advance queue run",
    params: AdvanceArgsSchema,
    apply: (state: DeepReadonly<RuntimeState>, args) =>
      advanceQueue(state, Queues.record(state.queues, args.run), byName),
  })

  const settled = command({
    title: "Release settled queue run projection",
    params: SettledArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: Readonly<{ run: QueueRunId }>) {
      const record = Queues.record(state.queues, args.run)
      if (record.parent !== undefined) return { events: [] }
      const run = materializeRun(record, state.jobs)
      if (needsSettlement(state, run)) return { events: [] }
      const root = resolveQueueAuthorityRoot(state.queues.authority, run.id)
      const claimed = Object.values(state.queues.authority.claims).some((token) => token.consumedBy === root)
      return { events: claimed ? [event("queue/run/settled", { run: root })] : [] }
    },
  })

  const isolate = command({
    title: "Isolate failed queue batch",
    params: IsolateArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args) {
      const parent = materializeRun(Queues.record(state.queues, args.run), state.jobs)
      if (childQueue(state.queues, state.jobs, parent.id, args.part) !== undefined) return { events: [] }
      if (!bisectable(parent)) throw new Error(`yrd: queue run '${parent.id}' is not a failed pre-merge batch`)
      const active = runningQueue(state.queues, state.jobs, parent.base)
      if (active !== undefined) throw new QueueRunningConflict(parent.base, active.id)

      const pivot = Math.ceil(parent.prs.length / 2)
      const prs = args.part === 0 ? parent.prs.slice(0, pivot) : parent.prs.slice(pivot)
      if (prs.length === 0) throw new Error(`yrd: queue run '${parent.id}' has no isolation part ${args.part}`)
      const selected = parent.steps.map((planned) => requirePlannedStep(byName, planned))
      const started = startRun(
        Queues.nextId(state.queues),
        prs,
        selected,
        parent.stepSelection,
        prShape(prs),
        undefined,
        {
          parent: parent.id,
          isolationPart: args.part,
        },
      )
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

  const associateTerminals = command({
    title: "Associate legacy PR terminals with Queue runs",
    params: AssociateTerminalsArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: AssociateTerminalsArgs) {
      const plan = terminalAssociationPlan(state)
      const ready = new Map(
        plan.rows.flatMap((row) =>
          row.status === "ready" ? [[row.association.evidence.terminalEvent, row] as const] : [],
        ),
      )
      const events: EventDraft[] = []
      for (const association of args.associations) {
        const terminalEvent = association.evidence.terminalEvent
        const prior = state.queues.terminalAssociations.applied[terminalEvent]
        if (prior !== undefined) {
          if (!sameTerminalAssociation(prior, association)) {
            raiseFailure(
              "refusal",
              "terminal-association-conflict",
              `yrd: legacy terminal '${terminalEvent}' is already associated with Queue run '${prior.run}'`,
            )
          }
          continue
        }
        const row = ready.get(terminalEvent)
        if (row === undefined) {
          const refused = plan.rows.find((candidate) => candidate.terminal.event === terminalEvent)
          raiseFailure(
            "refusal",
            refused?.status === "refused" ? refused.refusal.code : "terminal-association-unproven",
            refused?.status === "refused"
              ? refused.refusal.message
              : `yrd: legacy terminal '${terminalEvent}' has no unassociated proof row`,
          )
        }
        if (!sameTerminalAssociation(row.association, association)) {
          raiseFailure(
            "refusal",
            "terminal-association-proof-mismatch",
            `yrd: requested association for legacy terminal '${terminalEvent}' does not match its unique Queue proof`,
          )
        }
        events.push(event("pr/terminal-associated", association))
      }
      return { events }
    },
  })

  const cancelRun = command({
    title: "Cancel queue run",
    visibility: "public",
    params: CancelRunArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: CancelRunArgs) {
      const record = Queues.resolve(state.queues, args.run)
      if (record === undefined) {
        raiseFailure("refusal", "run-not-found", `yrd: no queue run '${args.run}'`)
      }
      const run = materializeRun(record, state.jobs)
      if (Queues.terminal(run)) {
        raiseFailure(
          "refusal",
          "run-terminal",
          `yrd: queue run '${args.run}' is ${run.status}; only a running or waiting run can be canceled`,
        )
      }
      return { events: [event("queue/run/canceled", { run: args.run, by: args.by, reason: args.reason })] }
    },
  })

  const quiesceLegacyRun = command({
    title: "Quiesce a pre-settlement legacy queue run",
    params: QuiesceLegacyRunArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: QuiesceLegacyRunArgs) {
      const record = Queues.resolve(state.queues, args.run)
      if (record === undefined) {
        raiseFailure("refusal", "run-not-found", `yrd: no queue run '${args.run}'`)
      }
      const run = materializeRun(record, state.jobs)
      if (Queues.terminal(run)) {
        // Idempotent: a replay that already folded the settlement meets a terminal
        // root and re-quiescing it is a no-op, never a duplicate failure event.
        return { events: [] }
      }
      // Fail (not cancel) so record.failure fixes the run terminal: a canceled run
      // whose PR is still submitted re-queues (needsAdvance), which is not settled.
      return { events: [queueFailedEvent(state, record, { code: "legacy-quiesced", message: args.reason })] }
    },
  })

  return {
    queue: { admit, run, pause, resume, advance, settled, isolate, cancelRun, quiesceLegacyRun, associateTerminals },
  }
}

type QueueAuthorityKind = "submit" | "checks"
type QueueAuthorityRelease = NonNullable<QueueRunAuthority["released"]>
type QueueAuthorityGap = Readonly<{
  kind: QueueAuthorityKind
  pr: string
  revision: number
  headSha: string
  reason: "missing" | "consumed"
  consumedBy?: QueueRunId
}>

function queueAuthorityReleaseReason(
  error: DeepReadonly<JobError> | undefined,
): QueueAuthorityRelease["reason"] | undefined {
  // A base race (the base branch or checked candidate ref moved out from under a
  // pinned Run) is environmental, not a PR-content fault: release the Run's queue
  // authority so the still-submitted PR re-admits against the fresh base, instead
  // of terminally rejecting a PR that would merge cleanly once the base settles.
  if (
    error?.code === "queue-environment-refused" ||
    error?.code === "job-lost" ||
    error?.code === "stale-base" ||
    error?.code === "stale-check"
  ) {
    return error.code
  }
  return undefined
}

function authorityRequirement(
  authority: DeepReadonly<QueueAuthorityState>,
  pr: DeepReadonly<PRSnapshot>,
  steps: readonly DeepReadonly<InstalledStep>[],
): QueueAuthorityKind | undefined {
  if (steps.some((step) => step.integrates)) return "submit"
  if (steps.some((step) => step.needsIntegration)) return undefined
  if (availableAuthorityToken(authority.checks[pr.id], pr)) return "checks"
  if (availableAuthorityToken(authority.submits[pr.id], pr)) return "submit"
  return authority.statuses[pr.id] === "pushed" ? "checks" : "submit"
}

function sameAuthorityToken(
  token: DeepReadonly<QueueAuthorityToken> | undefined,
  pr: DeepReadonly<PRSnapshot>,
): boolean {
  if (token === undefined) return false
  return token.pr === pr.id && token.revision === pr.revision && token.headSha === pr.headSha
}

function availableAuthorityToken(
  token: DeepReadonly<QueueAuthorityToken> | undefined,
  pr: DeepReadonly<PRSnapshot>,
): boolean {
  return sameAuthorityToken(token, pr) && token?.consumedBy === undefined
}

function requireFreshCheckAuthority(
  authority: DeepReadonly<QueueAuthorityState>,
  pr: DeepReadonly<PRSnapshot>,
  failedRun: QueueRunId,
): void {
  const token = authority.checks[pr.id]
  if (availableAuthorityToken(token, pr)) return
  const detail =
    sameAuthorityToken(token, pr) && token?.consumedBy !== undefined
      ? `the matching checks fact was consumed by queue run '${token.consumedBy}'`
      : "no fresh matching checks fact exists"
  raiseFailure("refusal", "checks-failed", `yrd: PR '${pr.id}' checks failed in ${failedRun}; ${detail}`)
}

function queueAuthorityGaps(
  authority: DeepReadonly<QueueAuthorityState>,
  prs: readonly DeepReadonly<PRSnapshot>[],
  steps: readonly DeepReadonly<InstalledStep>[],
): QueueAuthorityGap[] {
  const gaps: QueueAuthorityGap[] = []
  for (const pr of prs) {
    const kind = authorityRequirement(authority, pr, steps)
    if (kind === undefined) continue
    const token = kind === "submit" ? authority.submits[pr.id] : authority.checks[pr.id]
    if (token === undefined || !sameAuthorityToken(token, pr)) {
      gaps.push({ kind, pr: pr.id, revision: pr.revision, headSha: pr.headSha, reason: "missing" })
    } else {
      const consumedBy = token.consumedBy
      if (consumedBy === undefined) continue
      gaps.push({
        kind,
        pr: pr.id,
        revision: pr.revision,
        headSha: pr.headSha,
        reason: "consumed",
        consumedBy,
      })
    }
  }
  return gaps
}

function requireQueueAuthority(
  authority: DeepReadonly<QueueAuthorityState>,
  prs: readonly DeepReadonly<PRSnapshot>[],
  steps: readonly DeepReadonly<InstalledStep>[],
): void {
  const gap = queueAuthorityGaps(authority, prs, steps)[0]
  if (gap === undefined) return
  const detail =
    gap.reason === "consumed"
      ? `${gap.kind} authority was consumed by queue run '${gap.consumedBy}'`
      : `no ${gap.kind} authority fact exists`
  raiseFailure(
    "refusal",
    `queue-${gap.kind}-authority-${gap.reason}`,
    `yrd: PR '${gap.pr}' revision ${gap.revision} (${gap.headSha}) cannot start a queue run: ${detail}`,
  )
}

function projectRunAuthority(
  authority: DeepReadonly<QueueAuthorityState>,
  run: DeepReadonly<QueueStart>,
): QueueAuthorityState {
  if (run.parent !== undefined) {
    const inherited = projectionLookupGet(authority.runs, run.parent)
    const members = new Set(run.prs.map((pr) => pr.id))
    return {
      ...authority,
      runs: projectionLookupSet(authority.runs, run.id, {
        inheritedFrom: run.parent,
        missingSubmits:
          inherited === undefined
            ? run.prs.map((pr) => pr.id)
            : inherited.missingSubmits.filter((pr) => members.has(pr)),
        missingChecks: inherited === undefined ? [] : inherited.missingChecks.filter((pr) => members.has(pr)),
      }),
    }
  }

  const gaps = queueAuthorityGaps(authority, run.prs, run.steps)
  const submits: Record<string, QueueAuthorityToken> = { ...authority.submits }
  const checks: Record<string, QueueAuthorityToken> = { ...authority.checks }
  const claims: Record<string, QueueAuthorityToken> = { ...authority.claims }
  const explicitSettlement = run.settlement === "explicit"
  const consumesSubmit = run.steps.some((step) => step.integrates)
  for (const pr of run.prs) {
    const current = authority.current[pr.id]
    if (explicitSettlement && current !== undefined && sameAuthorityToken(current, pr)) {
      claims[pr.id] = {
        pr: current.pr,
        revision: current.revision,
        headSha: current.headSha,
        consumedBy: run.id,
      }
    }
    const kind = authorityRequirement(authority, pr, run.steps)
    if (kind === undefined) continue
    const token = kind === "submit" ? authority.submits[pr.id] : authority.checks[pr.id]
    if (token === undefined || !sameAuthorityToken(token, pr) || token.consumedBy !== undefined) continue
    const consumed: QueueAuthorityToken = {
      pr: token.pr,
      revision: token.revision,
      headSha: token.headSha,
      consumedBy: run.id,
    }
    if (explicitSettlement) claims[pr.id] = consumed
    if (kind === "submit" && consumesSubmit) submits[pr.id] = consumed
    if (kind === "checks") checks[pr.id] = consumed
  }
  return {
    ...authority,
    submits,
    checks,
    claims,
    runs: projectionLookupSet(authority.runs, run.id, {
      missingSubmits: gaps.filter((gap) => gap.kind === "submit").map((gap) => gap.pr),
      missingChecks: gaps.filter((gap) => gap.kind === "checks").map((gap) => gap.pr),
    }),
  }
}

function resolveQueueAuthorityRoot(authority: DeepReadonly<QueueAuthorityState>, run: QueueRunId): QueueRunId {
  const seen = new Set<QueueRunId>()
  let root = run
  while (true) {
    if (seen.has(root)) throw new Error(`yrd: queue authority ancestry for '${run}' is cyclic`)
    seen.add(root)
    const projected = projectionLookupGet(authority.runs, root)
    if (projected === undefined) throw new Error(`yrd: queue run '${root}' has no authority projection`)
    if (projected.inheritedFrom === undefined) return root
    root = projected.inheritedFrom
  }
}

function releaseRunAuthority(
  authority: DeepReadonly<QueueAuthorityState>,
  run: DeepReadonly<QueueRecord>,
  release: QueueAuthorityRelease,
): QueueAuthorityState {
  const root = resolveQueueAuthorityRoot(authority, run.id)
  const projected = projectionLookupGet(authority.runs, run.id)
  if (projected === undefined) throw new Error(`yrd: queue run '${run.id}' has no authority projection`)
  const submits: Record<string, QueueAuthorityToken> = { ...authority.submits }
  const checks: Record<string, QueueAuthorityToken> = { ...authority.checks }
  const claims: Record<string, QueueAuthorityToken> = { ...authority.claims }
  for (const pr of run.prs) {
    const submit = authority.submits[pr.id]
    if (submit !== undefined && sameAuthorityToken(submit, pr) && submit.consumedBy === root) {
      submits[pr.id] = { pr: submit.pr, revision: submit.revision, headSha: submit.headSha }
    }
    const check = authority.checks[pr.id]
    if (check !== undefined && sameAuthorityToken(check, pr) && check.consumedBy === root) {
      checks[pr.id] = { pr: check.pr, revision: check.revision, headSha: check.headSha }
    }
    if (claims[pr.id]?.consumedBy === root) delete claims[pr.id]
  }
  return {
    ...authority,
    submits,
    checks,
    claims,
    runs: projectionLookupSet(authority.runs, run.id, { ...projected, released: release }),
  }
}

function settleRunClaim(authority: DeepReadonly<QueueAuthorityState>, run: QueueRunId): QueueAuthorityState {
  const root = resolveQueueAuthorityRoot(authority, run)
  const claims: Record<string, QueueAuthorityToken> = { ...authority.claims }
  for (const [pr, token] of Object.entries(authority.claims)) {
    if (token.consumedBy === root) delete claims[pr]
  }
  return { ...authority, claims }
}

function invalidatePRAuthority(
  authority: DeepReadonly<QueueAuthorityState>,
  pr: string,
  status: DeepReadonly<QueueAuthorityState>["statuses"][string],
): QueueAuthorityState {
  const submits: Record<string, QueueAuthorityToken> = { ...authority.submits }
  const checks: Record<string, QueueAuthorityToken> = { ...authority.checks }
  delete submits[pr]
  delete checks[pr]
  return { ...authority, statuses: { ...authority.statuses, [pr]: status }, submits, checks }
}

function currentAuthorityMatches(
  authority: DeepReadonly<QueueAuthorityState>,
  token: DeepReadonly<QueueAuthorityToken>,
): boolean {
  const current = authority.current[token.pr]
  return current?.revision === token.revision && current.headSha === token.headSha
}

function terminalAuthorityMatches(
  authority: DeepReadonly<QueueAuthorityState>,
  terminal: DeepReadonly<{ pr: string; revision: number; headSha?: string }>,
  eventName: string,
  requireCurrent: boolean,
): boolean {
  const current = authority.current[terminal.pr]
  if (current === undefined) {
    if (requireCurrent) {
      throw new Error(`yrd: terminal '${eventName}' for PR '${terminal.pr}' has no current queue authority`)
    }
    return false
  }
  if (
    current.revision !== terminal.revision ||
    (terminal.headSha !== undefined && current.headSha !== terminal.headSha)
  ) {
    throw new Error(
      `yrd: stale terminal '${eventName}' for PR '${terminal.pr}' targets ${terminal.revision}@${terminal.headSha ?? "unknown"}; queue authority is ${current.revision}@${current.headSha}`,
    )
  }
  return true
}

function projectSettledQueueRun(state: DeepReadonly<QueueState>, applied: Event): QueueState {
  const settled = SettledArgsSchema.parse(applied.data)
  const record = Queues.get(state.queues, settled.run)
  if (record === undefined) throw new Error(`yrd: no queue run '${settled.run}'`)
  if (record.parent !== undefined) throw new Error(`yrd: settled queue run '${settled.run}' is not a root`)
  return {
    queues: markQueueTerminalRoot(
      {
        ...state.queues,
        authority: settleRunClaim(state.queues.authority, record.id),
      },
      record.id,
    ),
  }
}

function markQueueTerminalRoot(queues: DeepReadonly<QueuesState>, root: QueueRunId): QueuesState {
  if (queues.retention.terminalOrder[root] !== undefined) return queues as QueuesState
  const next = Math.max(0, ...Object.values(queues.retention.terminalOrder)) + 1
  return {
    ...queues,
    retention: { terminalOrder: { ...queues.retention.terminalOrder, [root]: next } },
  }
}

function compactQueueProjection(
  queues: DeepReadonly<QueuesState>,
  jobs: DeepReadonly<JobsState>,
  bays: DeepReadonly<BaysState>,
): QueuesState {
  const runtime = { queues, jobs, bays }
  const terminalOrder = { ...queues.retention.terminalOrder }
  for (const root of Object.keys(terminalOrder)) {
    const order = jobs.retention.queueTerminalOrder[root]
    if (order !== undefined) terminalOrder[root] = order
  }
  for (const record of Queues.values(queues)) {
    if (record.parent !== undefined || record.settlement !== undefined) continue
    if (needsSettlement(runtime, materializeRun(record, jobs))) continue
    const order = jobs.retention.queueTerminalOrder[record.id]
    if (order === undefined) {
      throw new Error(`yrd: quiesced legacy Queue root '${record.id}' has no terminal journal order`)
    }
    terminalOrder[record.id] = order
  }
  return compactQueuesState({ ...queues, retention: { terminalOrder } }, queueDecisionRoots(queues, bays))
}

function queueDecisionRoots(queues: DeepReadonly<QueuesState>, bays: DeepReadonly<BaysState>): ReadonlySet<QueueRunId> {
  const roots = new Set<QueueRunId>()
  for (const record of Queues.values(queues)) {
    // A failed record carries its own terminal fact after Queue-owned Jobs
    // co-evict. Keep it only while that exact plan still governs admission.
    if (record.failure === undefined || record.stepSelection?.authority !== "admission" || record.prs.length !== 1) {
      continue
    }
    const snapshot = record.prs[0]
    if (snapshot === undefined) continue
    const pr = bays.prs[snapshot.id]
    if (pr === undefined || (pr.status !== "pushed" && pr.status !== "submitted") || !checksRequested(pr)) continue
    if (queueLookupKey(Queues.snapshot(pr), record.steps) !== queueLookupKey(snapshot, record.steps)) continue
    roots.add(queueRetentionRoot(queues, record.id))
  }
  return roots
}

/** The one production projection path for a started Queue run. */
export function projectQueueStarted(queues: DeepReadonly<QueuesState>, record: DeepReadonly<QueueRecord>): QueuesState {
  if (Queues.get(queues, record.id) !== undefined) throw new Error(`yrd: duplicate queue run '${record.id}'`)
  return {
    ...queues,
    records: Queues.set(queues.records, record),
    index: indexQueueStart(queues.index, record),
    authority: projectRunAuthority(queues.authority, record),
  }
}

function projectQueues(state: DeepReadonly<QueueState>, applied: Event): QueueState {
  if (applied.name === "pr/pushed" || applied.name === "pr/recut") {
    const token =
      applied.name === "pr/pushed"
        ? QueueAuthorityTokenFactSchema.parse(applied.data)
        : ((fact) => ({ pr: fact.pr, ...fact.successor }))(QueueRecutAuthorityFactSchema.parse(applied.data))
    const invalidated = invalidatePRAuthority(state.queues.authority, token.pr, "pushed")
    return {
      queues: {
        ...state.queues,
        authority: { ...invalidated, current: { ...invalidated.current, [token.pr]: token } },
      },
    }
  }
  if (applied.name === "pr/submitted") {
    const token = QueueAuthorityTokenFactSchema.parse(applied.data)
    const current = state.queues.authority.current[token.pr]
    if (current !== undefined && !currentAuthorityMatches(state.queues.authority, token)) return state
    return {
      queues: {
        ...state.queues,
        authority: {
          ...state.queues.authority,
          statuses: { ...state.queues.authority.statuses, [token.pr]: "submitted" },
          current: { ...state.queues.authority.current, [token.pr]: token },
          submits: { ...state.queues.authority.submits, [token.pr]: token },
        },
      },
    }
  }
  if (applied.name === "pr/checks-requested") {
    const token = QueueAuthorityTokenFactSchema.parse(applied.data)
    const current = state.queues.authority.current[token.pr]
    if (current !== undefined && !currentAuthorityMatches(state.queues.authority, token)) return state
    return {
      queues: {
        ...state.queues,
        authority: {
          ...state.queues.authority,
          current: { ...state.queues.authority.current, [token.pr]: token },
          checks: { ...state.queues.authority.checks, [token.pr]: token },
        },
      },
    }
  }
  if (applied.name === "pr/rejected") {
    const rejected = QueueRejectedTerminalFactSchema.parse(applied.data)
    if (!terminalAuthorityMatches(state.queues.authority, rejected, applied.name, typeof rejected.run === "string")) {
      return state
    }
    const terminalAssociations =
      rejected.run !== undefined
        ? state.queues.terminalAssociations
        : {
            ...state.queues.terminalAssociations,
            pending: {
              ...state.queues.terminalAssociations.pending,
              [applied.id]: {
                event: applied.id,
                at: applied.ts,
                pr: rejected.pr,
                revision: rejected.revision,
                ...(rejected.headSha === undefined ? {} : { headSha: rejected.headSha }),
              },
            },
          }
    return {
      queues: {
        ...state.queues,
        authority: invalidatePRAuthority(state.queues.authority, rejected.pr, "rejected"),
        terminalAssociations,
      },
    }
  }
  if (applied.name === "pr/terminal-associated") {
    const associated = PRTerminalAssociationSchema.parse(applied.data)
    const terminalEvent = associated.evidence.terminalEvent
    const prior = state.queues.terminalAssociations.applied[terminalEvent]
    if (prior !== undefined) {
      if (!sameTerminalAssociation(prior, associated)) {
        throw new Error(`yrd: legacy terminal '${terminalEvent}' has conflicting Queue run associations`)
      }
      return state
    }
    const pending = state.queues.terminalAssociations.pending[terminalEvent]
    if (pending === undefined) {
      throw new Error(`yrd: terminal association references unknown legacy event '${terminalEvent}'`)
    }
    if (
      pending.pr !== associated.pr ||
      pending.revision !== associated.revision ||
      (pending.headSha !== undefined && pending.headSha !== associated.headSha)
    ) {
      throw new Error(`yrd: terminal association does not match legacy event '${terminalEvent}'`)
    }
    const remaining = { ...state.queues.terminalAssociations.pending }
    delete remaining[terminalEvent]
    return {
      queues: {
        ...state.queues,
        terminalAssociations: {
          pending: remaining,
          applied: { ...state.queues.terminalAssociations.applied, [terminalEvent]: associated },
        },
      },
    }
  }
  if (applied.name === "pr/integrated") {
    const integrated = QueueAuthorityTokenFactSchema.parse(applied.data)
    const currentTerminal = typeof (applied.data as { run?: unknown }).run === "string"
    if (!terminalAuthorityMatches(state.queues.authority, integrated, applied.name, currentTerminal)) return state
    return {
      queues: {
        ...state.queues,
        authority: invalidatePRAuthority(state.queues.authority, integrated.pr, "integrated"),
      },
    }
  }
  if (applied.name === "pr/withdrawn" || applied.name === "pr/canceled") {
    const closed = QueueAuthorityPRFactSchema.parse(applied.data)
    if (closed.revision !== undefined && closed.headSha !== undefined) {
      const currentTerminal =
        applied.name === "pr/withdrawn" || typeof (applied.data as { run?: unknown }).run === "string"
      const terminal = { pr: closed.pr, revision: closed.revision, headSha: closed.headSha }
      if (!terminalAuthorityMatches(state.queues.authority, terminal, applied.name, currentTerminal)) return state
    }
    return {
      queues: {
        ...state.queues,
        authority: invalidatePRAuthority(
          state.queues.authority,
          closed.pr,
          applied.name === "pr/withdrawn" ? "withdrawn" : "canceled",
        ),
      },
    }
  }
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
    const started = ReplayQueueStartSchema.parse((applied.data as { run?: unknown }).run)
    const record = ReplayQueueRecordSchema.parse({
      ...started,
      base: baseIdentity(started.base),
      prs: started.prs.map((pr) => ({ ...pr, base: baseIdentity(pr.base) })),
      startedAt: applied.ts,
    })
    return { queues: projectQueueStarted(state.queues, record) }
  }
  if (applied.name === "queue/run/settled") {
    return projectSettledQueueRun(state, applied)
  }
  if (applied.name === "queue/run/failed") {
    const failed = ReplayQueueFailedSchema.parse(applied.data)
    const record = Queues.get(state.queues, failed.run)
    if (record === undefined) throw new Error(`yrd: no queue run '${failed.run}'`)
    const releaseReason = queueAuthorityReleaseReason(failed.error)
    const failedRecord = { ...record, failure: { at: applied.ts, error: failed.error } }
    return {
      queues: {
        ...state.queues,
        authority:
          releaseReason === undefined
            ? state.queues.authority
            : releaseRunAuthority(state.queues.authority, record, {
                reason: releaseReason,
                ref: applied.id,
              }),
        records: Queues.set(state.queues.records, failedRecord),
        index:
          releaseReason === undefined
            ? state.queues.index
            : recordReleasedAdmissionFailure(state.queues.index, failedRecord),
      },
    }
  }
  if (applied.name === "queue/run/canceled") {
    const canceled = CancelRunArgsSchema.parse(applied.data)
    const record = Queues.get(state.queues, canceled.run)
    if (record === undefined) throw new Error(`yrd: no queue run '${canceled.run}'`)
    // A canceled run is terminal, but — unlike a failure — its member PRs are NOT
    // rejected. Release the run's queue authority (mirroring queue/run/failed) so
    // the still-submitted PRs are re-admissible on a future drain, and mark the
    // record canceled so advanceQueue stops reconciling it (no pr/canceled emission).
    const canceledRecord = {
      ...record,
      canceledAt: applied.ts,
      canceledBy: canceled.by,
      cancelReason: canceled.reason,
    }
    const queues = {
      ...state.queues,
      authority: releaseRunAuthority(state.queues.authority, record, {
        reason: "run-canceled",
        ref: applied.id,
      }),
      records: Queues.set(state.queues.records, canceledRecord),
      index: recordReleasedAdmissionFailure(state.queues.index, canceledRecord),
    }
    return { queues: record.parent === undefined ? markQueueTerminalRoot(queues, record.id) : queues }
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

function stepSelection(
  queues: DeepReadonly<QueuesState>,
  installed: readonly RuntimeStep[],
  selected: readonly RuntimeStep[],
  authority: StepSelection["authority"],
): StepSelection {
  const names = selected.map((step) => step.name)
  const selectedNames = new Set(names)
  const configuredNames = new Set(selectSteps(installed, queues.defaultSteps).map((step) => step.name))
  const plan = installed.filter((step) => selectedNames.has(step.name) || configuredNames.has(step.name))
  const omittedSteps =
    authority === "explicit"
      ? plan.flatMap((step, index) =>
          selectedNames.has(step.name)
            ? []
            : [
                {
                  ...descriptor(step),
                  index,
                  status: "skipped" as const,
                  reason: "not-selected" as const,
                },
              ],
        )
      : []
  return {
    authority,
    steps: names,
    ...(omittedSteps.length === 0 ? {} : { omittedSteps }),
  }
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
  selection: StepSelection | undefined,
  shape: PRShape,
  integration?: IntegrationProof,
  lineage: Readonly<{ parent?: QueueRunId; isolationPart?: 0 | 1 }> = {},
  reuse?: Readonly<{ run: QueueRunId; results: Readonly<Record<string, JsonValue>> }>,
): Readonly<{ run: QueueStart; events: readonly EventDraft[] }> {
  const pr = prs[0]
  if (pr === undefined) throw new Error("yrd: a queue run requires at least one PR")
  const run: QueueStart = {
    id,
    settlement: "explicit",
    prs,
    base: baseIdentity(pr.base),
    steps: selected.map(descriptor),
    ...(selection === undefined ? {} : { stepSelection: selection }),
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

/**
 * A pre-settlement (v1) Queue root that replay left non-terminal. Queue v2 adds
 * explicit live-root claims; historical v1 runs carry no settlement marker, so a
 * genuinely unfinished v1 root cannot be migrated losslessly by projection alone.
 * The migration ({@link Queue.quiesceLegacyRoots}) settles the abandoned ones and
 * refuses only while a previous writer still holds a live lease.
 */
type LegacyRootTarget = Readonly<{
  run: QueueRunId
  /** Non-terminal jobs the migration must cancel so the run and its jobs are all terminal. */
  jobs: readonly DeepReadonly<Job>[]
  /** True when a still-unexpired writer lease is held at `now` (ms since epoch). */
  leased(now: number): boolean
}>

function legacyRootTargets(state: DeepReadonly<RuntimeState>): readonly LegacyRootTarget[] {
  return projectionLookupValues(state.queues.records)
    .filter((record) => record.parent === undefined && record.settlement === undefined)
    .map((record) => materializeRun(record, state.jobs))
    .filter((run) => needsSettlement(state, run))
    .map((run): LegacyRootTarget => {
      const jobs = run.steps
        .map((step) => step.job)
        .filter((job): job is DeepReadonly<Job> => job !== undefined && !Job.terminal(job))
      return {
        run: run.id,
        jobs,
        leased: (now) =>
          jobs.some((job) => job.status === "running" && Date.parse(job.leaseExpiresAt) > now),
      }
    })
    .toSorted((left, right) => left.run.localeCompare(right.run, undefined, { numeric: true }))
}

function requestStep(step: RuntimeStep, run: Pick<QueueStart, "id" | "prs">, index: number, shape: PRShape) {
  return step.job.request({ run: run.id, step: step.name, index, prs: run.prs, shape }, { key: jobKey(run.id, index) })
}

function advanceQueue(
  state: DeepReadonly<RuntimeState>,
  record: DeepReadonly<QueueRecord>,
  steps: ReadonlyMap<string, RuntimeStep>,
): Readonly<{ events: readonly EventDraft[] }> {
  if (record.failure !== undefined) return { events: [] }
  // A run-canceled record is terminal: never emit pr/canceled or pr/rejected for
  // its members. Their status is untouched (still submitted), so a future drain
  // re-queues them — cancel is a re-queue, not a rejection.
  if (record.canceledAt !== undefined) return { events: [] }
  const stale = pinnedPRError(state.bays, record.prs)
  if (stale !== undefined) {
    return { events: [queueFailedEvent(state, record, stale)] }
  }

  const jobs = queueJobs(record, state.jobs)
  const index = jobs.length - 1
  const job = jobs[index]
  if (job === undefined || job.status === "requested" || job.status === "running" || job.status === "waiting") {
    return { events: [] }
  }
  const planned = record.steps[index]
  if (planned === undefined) throw new Error(`yrd: queue run '${record.id}' lost step ${index}`)
  if (job.status !== "passed") {
    const before = shapeThrough(record, state.jobs, index)
    if (job.status === "canceled") {
      return {
        events: isIntegrated(before)
          ? []
          : record.prs.flatMap((pr) => {
              const current = state.bays.prs[pr.id]
              if (
                current === undefined ||
                current.revision !== pr.revision ||
                current.headSha !== pr.headSha ||
                (current.status !== "pushed" && current.status !== "submitted")
              ) {
                return []
              }
              const revision = current.revisions.find(
                (candidate) => candidate.revision === pr.revision && candidate.headSha === pr.headSha,
              )
              return [
                event("pr/canceled", {
                  pr: pr.id,
                  revision: pr.revision,
                  headSha: pr.headSha,
                  run: record.id,
                  ...(current.issue === undefined ? {} : { issueRef: current.issue }),
                  ...(current.correlation === undefined ? {} : { correlation: current.correlation }),
                  ...(revision?.actor === undefined ? {} : { actor: revision.actor }),
                  by: job.canceledBy,
                  reason: job.cancelReason,
                }),
              ]
            }),
      }
    }

    const failure = jobFailure(job)
    if (queueAuthorityReleaseReason(failure) !== undefined) {
      return { events: [queueFailedEvent(state, record, failure)] }
    }
    const pr = record.prs.length === 1 ? record.prs[0] : undefined
    const current = pr === undefined ? undefined : state.bays.prs[pr.id]
    const revision =
      pr === undefined
        ? undefined
        : current?.revisions.find((candidate) => candidate.revision === pr.revision && candidate.headSha === pr.headSha)
    const evidence =
      (job.status === "failed" ? firstArtifact(job.error.evidence, "stderr") : undefined) ??
      firstArtifact(checkEvidence(job), "stderr") ??
      ("artifacts" in job ? firstArtifact({ artifacts: job.artifacts }, "stderr") : undefined)
    return {
      events:
        !isIntegrated(before) && pr !== undefined && current?.status === "submitted"
          ? [
              event("pr/rejected", {
                pr: pr.id,
                revision: pr.revision,
                headSha: pr.headSha,
                run: record.id,
                ...(current.issue === undefined ? {} : { issueRef: current.issue }),
                ...(current.correlation === undefined ? {} : { correlation: current.correlation }),
                ...(revision?.actor === undefined ? {} : { actor: revision.actor }),
                step: planned.name,
                ...(evidence === undefined ? {} : { evidence }),
                detail: failure.message,
              }),
            ]
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
      const revision = current.revisions.find(
        (candidate) => candidate.revision === current.revision && candidate.headSha === current.headSha,
      )
      events.push(
        event("pr/integrated", {
          pr: current.id,
          revision: current.revision,
          headSha: current.headSha,
          run: record.id,
          ...(current.issue === undefined ? {} : { issueRef: current.issue }),
          commit: shape.integration.commit,
          landingSha: shape.integration.commit,
          baseSha: shape.integration.baseSha,
          ...(current.correlation === undefined ? {} : { correlation: current.correlation }),
          ...(revision?.actor === undefined ? {} : { actor: revision.actor }),
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
  const payloads = new Set(snapshots.map(payloadIdentity))
  return Object.values(state.prs).filter(
    (pr) => pr.status !== "withdrawn" && pr.status !== "canceled" && payloads.has(payloadIdentity(pr)),
  )
}

function payloadIdentity(pr: Pick<DeepReadonly<PR>, "base" | "headSha" | "composition">): string {
  return `${baseIdentity(pr.base)}\0${pr.headSha}\0${JSON.stringify(pr.composition)}`
}

function queueLifecycleRun(applied: Event): QueueRunId | undefined {
  if (applied.name === "queue/run/started") {
    return ReplayQueueStartSchema.parse((applied.data as { run?: unknown }).run).id
  }
  if (applied.name === "queue/run/failed") return ReplayQueueFailedSchema.parse(applied.data).run
  if (applied.name === "queue/run/canceled") return CancelRunArgsSchema.parse(applied.data).run
  if (applied.name === "queue/run/settled") return SettledArgsSchema.parse(applied.data).run
  return undefined
}

function materializeArchivedRun(
  history: JournalHistory<unknown>,
  jobs: HasJobs["jobs"],
  live: DeepReadonly<QueuesState>,
  id: QueueRunId,
): QueueRun | undefined {
  const entries = new Map<number, unknown>()
  const runs = new Set<QueueRunId>()
  const visiting = new Set<QueueRunId>()
  const visit = (runId: QueueRunId): boolean => {
    if (runs.has(runId)) return true
    if (visiting.has(runId)) throw new Error(`yrd: archived queue ancestry for '${id}' is cyclic`)
    visiting.add(runId)
    const slice = history.entity("queue", runId)
    if (slice.length === 0) {
      visiting.delete(runId)
      return false
    }
    let parent: QueueRunId | undefined
    for (const entry of slice) {
      entries.set(entry.cursor, entry.value)
      const frame = parseJournalFrame(entry.value)
      for (const applied of frame.events) {
        if (applied.name !== "queue/run/started") continue
        const started = ReplayQueueStartSchema.parse((applied.data as { run?: unknown }).run)
        if (started.id === runId) parent = started.parent
      }
    }
    if (parent !== undefined && !visit(parent)) {
      throw new Error(`yrd: archived queue run '${runId}' references missing parent '${parent}'`)
    }
    visiting.delete(runId)
    runs.add(runId)
    return true
  }
  if (!visit(id)) return undefined

  let projection: QueueState = {
    queues: Queues.empty({
      batchSize: live.batchSize,
      ...(live.defaultSteps === undefined ? {} : { defaultSteps: live.defaultSteps }),
      requires: live.requires,
    }),
  }
  for (const [, value] of [...entries].toSorted(([left], [right]) => left - right)) {
    const frame = parseJournalFrame(value)
    for (const applied of frame.events) {
      const runId = queueLifecycleRun(applied)
      if (runId !== undefined && runs.has(runId)) projection = projectQueues(projection, applied)
    }
  }
  const record = Queues.get(projection.queues, id)
  if (record === undefined) {
    throw new Error(`yrd: journal queue index names '${id}' without a queue/run/started event`)
  }

  const byId: Record<string, Job> = {}
  const byKey: Record<string, string> = {}
  for (const [index] of record.steps.entries()) {
    const key = jobKey(record.id, index)
    const job = jobs.getByKey(key)
    if (job === undefined) continue
    if (job.key !== key) throw new Error(`yrd: archived queue job '${job.id}' does not match key '${key}'`)
    byId[job.id] = job
    byKey[key] = job.id
  }
  return materializeRun(record, {
    byId,
    byKey,
    retention: {
      next: 1,
      standaloneTerminalOrder: {},
      queueRoots: {},
      queueTerminalOrder: {},
      legacyQueueRoots: {},
      detachedQueueJobs: {},
    },
  })
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
  const failed = steps.find(
    (step) => step.job?.status === "failed" || step.job?.status === "lost" || step.job?.status === "canceled",
  )?.job
  const waiting = steps.some((step) => step.job?.status === "waiting")
  const passed = steps.every((step) => step.job?.status === "passed")
  const status =
    record.canceledAt !== undefined
      ? "canceled"
      : record.failure !== undefined
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
    record.canceledAt ??
    record.failure?.at ??
    (failed?.status === "failed" || failed?.status === "lost" || failed?.status === "canceled"
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
  return Queues.values(queues)
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
  return activeQueueRuns(queues, jobs).find(
    (run) => run.id !== except && baseIdentity(run.base) === identity && run.status === "running",
  )
}

function childQueue(
  queues: DeepReadonly<QueuesState>,
  jobs: DeepReadonly<JobsState>,
  parent: QueueRunId,
  part: 0 | 1,
): QueueRun | undefined {
  const id = childRunId(queues.index, parent, part)
  const record = id === undefined ? undefined : Queues.get(queues, id)
  return record === undefined ? undefined : materializeRun(record, jobs)
}

function queueTree(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>, root: QueueRunId): QueueRun[] {
  const result: QueueRun[] = []
  const visit = (id: QueueRunId): void => {
    const record = Queues.get(queues, id)
    if (record === undefined) return
    result.push(materializeRun(record, jobs))
    for (const part of [0, 1] as const) {
      const child = childRunId(queues.index, id, part)
      if (child !== undefined) visit(child)
    }
  }
  visit(root)
  return result
}

function activeQueueRuns(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>): QueueRun[] {
  return activeQueueRootIds(queues.authority).flatMap((root) => queueTree(queues, jobs, root))
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
  for (const record of Queues.values(state.queues)) {
    for (const pr of record.prs) {
      if (state.bays.prs[pr.id] !== undefined) continue
      findings.push({
        code: "missing-pr",
        message: `queue run '${record.id}' references missing PR '${pr.id}'`,
        run: record.id,
        pr: pr.id,
      })
    }
    const authority = projectionLookupGet(state.queues.authority.runs, record.id)
    if (record.parent === undefined && authority !== undefined) {
      for (const pr of authority.missingSubmits) {
        findings.push({
          code: "run-without-submit-ancestry",
          message: `queue run '${record.id}' started PR '${pr}' without an unconsumed matching submit fact`,
          run: record.id,
          pr,
        })
      }
      for (const pr of authority.missingChecks) {
        findings.push({
          code: "run-without-check-ancestry",
          message: `queue run '${record.id}' started pushed PR '${pr}' without an unconsumed matching checks fact`,
          run: record.id,
          pr,
        })
      }
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
      .filter((pr) => pr.status === "submitted")
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
    if (pr.status !== "submitted" && pr.status !== "integrated") {
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
  const requested = args.steps === undefined ? undefined : selectSteps(steps, args.steps)
  return pendingQueueRoots(state).filter(
    (run) =>
      projectionLookupGet(state.queues.authority.runs, run.id)?.released === undefined &&
      !samePlan(run.steps, admissions) &&
      (requested === undefined ||
        (samePlan(run.steps, requested) &&
          (run.stepSelection === undefined || run.stepSelection.authority === "explicit"))) &&
      (selected === undefined || run.prs.every((pr) => selected.has(pr.id))),
  )
}

function pendingQueueRoots(state: DeepReadonly<RuntimeState>): QueueRun[] {
  return activeQueueRootIds(state.queues.authority)
    .map((id) => Queues.get(state.queues, id))
    .filter((record): record is DeepReadonly<QueueRecord> => record !== undefined)
    .map((record) => materializeRun(record, state.jobs))
    .filter((run) => needsSettlement(state, run))
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

function unstartedAdmission(
  run: DeepReadonly<QueueRun>,
  queues: DeepReadonly<QueuesState>,
  steps: readonly RuntimeStep[],
): boolean {
  return (
    run.stepSelection?.authority === "admission" &&
    samePlan(run.steps, admissionSteps(queues, steps)) &&
    run.steps.every((step) => step.job === undefined || step.job.status === "requested")
  )
}

function admissionRun(
  state: DeepReadonly<RuntimeState>,
  snapshot: DeepReadonly<PRSnapshot>,
  selected: readonly RuntimeStep[],
): QueueRun | undefined {
  const id = latestExactRunId(state.queues.index, snapshot, selected)
  const record = id === undefined ? undefined : Queues.get(state.queues, id)
  return record === undefined ? undefined : materializeRun(record, state.jobs)
}

function checkFactRun(
  state: DeepReadonly<RuntimeState>,
  snapshot: DeepReadonly<PRSnapshot>,
  selected: readonly RuntimeStep[],
): QueueRun | undefined {
  const id = latestPrefixRunId(state.queues.index, snapshot, selected)
  const record = id === undefined ? undefined : Queues.get(state.queues, id)
  return record === undefined ? undefined : materializeRun(record, state.jobs)
}

function checkRunStatus(run: QueueRun, selectedCount: number): PREligibility["checks"]["status"] {
  const selected = run.steps.slice(0, selectedCount)
  if (selected.every((step) => step.job?.status === "passed")) return "passed"
  if (
    selected.some(
      (step) => step.job?.status === "failed" || step.job?.status === "lost" || step.job?.status === "canceled",
    )
  ) {
    return "failed"
  }
  return run.status === "failed" ? "failed" : "checking"
}

const AUTOMATIC_ADMISSION_RETRIES = 1

function automaticAdmissionAttemptsExhausted(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
  snapshot: DeepReadonly<PRSnapshot>,
  selected: readonly RuntimeStep[],
): boolean {
  const exactRequests = pr.checkRequests.filter(
    (request) =>
      request.revision === snapshot.revision &&
      request.headSha === snapshot.headSha &&
      (request.baseSha ?? pr.baseSha) === snapshot.baseSha,
  ).length
  if (exactRequests === 0) return false
  const releasedFailures = releasedAdmissionFailures(state.queues.index, snapshot, selected)
  return releasedFailures >= exactRequests + AUTOMATIC_ADMISSION_RETRIES
}

function admissionQueue(state: DeepReadonly<RuntimeState>, steps: readonly RuntimeStep[]): PR[] {
  const selected = admissionSteps(state.queues, steps)
  if (selected.length === 0) return []
  return Object.values(state.bays.prs)
    .filter((pr) => pr.status === "pushed" || pr.status === "submitted")
    .filter((pr) => checksRequested(pr))
    .filter((pr) => {
      const snapshot = Queues.snapshot(pr)
      const run = admissionRun(state, snapshot, selected)
      if (run === undefined) return true
      return (
        checkRunStatus(run, selected.length) === "failed" &&
        availableAuthorityToken(state.queues.authority.checks[pr.id], snapshot) &&
        !automaticAdmissionAttemptsExhausted(state, pr, snapshot, selected)
      )
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
  if (job?.status === "canceled") return jobFailure(job)
  return run.error
}

function checkStatus(job: Job | undefined, run: QueueRun): PRCheckRecord["status"] {
  if (run.status === "failed" && (job === undefined || !Job.terminal(job))) return "failed"
  if (job?.status === "passed") return "passed"
  if (job?.status === "failed" || job?.status === "lost" || job?.status === "canceled") return "failed"
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
  options: Readonly<{ explicitStepAuthority?: boolean }> = {},
): PR[] {
  const requested = requestedPRs(state.bays, args, excluded)
  const implicitQueue = args.prs === undefined || args.prs.length === 0
  const ignoredClaims = new Set(
    options.explicitStepAuthority === true
      ? activeQueueRuns(state.queues, state.jobs)
          .filter((run) => unstartedAdmission(run, state.queues, steps))
          .map((run) => run.id)
      : [],
  )
  return requested.filter((pr) => {
    const eligibility = prEligibility(state, pr, steps, {
      resumeIntegrated: true,
      ignoreChecks: options.explicitStepAuthority,
      ignoredClaims,
    })
    if (eligibility.runnable) return true
    if (implicitQueue || (eligibility.reason?.code === "claimed" && options.explicitStepAuthority !== true)) {
      return false
    }
    const reason = eligibility.reason
    raiseFailure("refusal", reason?.code ?? "pr-not-ready", `yrd: ${reason?.message ?? `PR '${pr.id}' is not ready`}`)
  })
}

/**
 * How every `candidateFailure(...)` code produced by command.ts is handled.
 * Each such code must fall in EXACTLY ONE bucket — the partition is asserted by
 * composition-failure-buckets.test.ts, which grep-derives the candidateFailure
 * code set from command.ts so a NEW unclassified code reddens by construction.
 *
 * - needs-author: the queue cannot build the candidate from what the author
 *   submitted; the author must re-author (fix the composition, push a
 *   gitlink-free root, correct a declared source range or payload).
 * - infra-retry: transient infrastructure — a git push / update-ref that can
 *   fail on a network/remote blip, or scratch cleanup. Retried with backoff by
 *   the env-storm path (21622 condition 4); never routed to the author.
 * - recut-lineage: owned by the auto-recut slice, which classifies these on its
 *   own path — not surfaced as needs-author here.
 * - plain-rejected: an ordinary failure with no composition meaning. Currently
 *   no candidateFailure code lands here; the bucket keeps the partition total.
 */
export const COMPOSITION_FAILURE_BUCKETS = {
  "needs-author": new Set<string>([
    "authored-gitlink",
    "composition-invalid",
    "gitlink-inspection",
    "wrapper-mismatch",
    "source-missing",
    "source-lineage",
    "payload-certificate",
    "payload-identity",
    "payload-mismatch",
    "payload-overlap",
  ]),
  "infra-retry": new Set<string>(["source-publish", "scratch-cleanup-failed"]),
  "recut-lineage": new Set<string>(["recut-certificate", "restack-conflict", "restack-failed"]),
  "plain-rejected": new Set<string>(),
} as const

const NEEDS_AUTHOR_CODES: ReadonlySet<string> = COMPOSITION_FAILURE_BUCKETS["needs-author"]

function terminalJobError(job: DeepReadonly<Job> | undefined): JobError | undefined {
  if (job?.status === "failed") return job.error
  if (job?.status === "lost") return { code: "job-lost", message: job.lostReason }
  if (job?.status === "canceled") return jobFailure(job)
  return undefined
}

/** The refusal receipt behind a `needs-author` verdict, or `undefined` when a
 * failed check is an ordinary check failure. Scans EVERY step's terminal job
 * error plus the run-level error across BOTH the PR's admission/check run and
 * the run that terminalized it — INCLUDING the integrating/needsIntegration
 * steps that projectPRChecks filters out. A composition refusal produced during
 * integration lands on a SEPARATE integration run (the check run passed), and
 * on the integrating step of it, which projectPRChecks hides (candidateFailure
 * carries no evidence, so its zero-other-records run.error fallback never fires
 * when a passed check record is present); it still means the author must
 * re-author. */
function compositionRefusalReceipt(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
  steps: readonly RuntimeStep[],
): JobError | undefined {
  const runIds = new Set<QueueRunId>()
  const checkRun = checkEligibility(state, pr, steps).run
  if (checkRun !== undefined) runIds.add(checkRun)
  if (pr.terminalRun !== undefined) runIds.add(pr.terminalRun as QueueRunId)
  for (const runId of runIds) {
    const record = Queues.get(state.queues, runId)
    if (record === undefined) continue
    const run = materializeRun(record, state.jobs)
    const errors: (JobError | undefined)[] = [...run.steps.map((step) => terminalJobError(step.job)), run.error]
    for (const error of errors) {
      if (error !== undefined && NEEDS_AUTHOR_CODES.has(error.code)) return error
    }
  }
  return undefined
}

function prEligibility(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
  steps: readonly RuntimeStep[],
  options: Readonly<{
    resumeIntegrated?: boolean
    ignoreChecks?: boolean
    ignoredClaims?: ReadonlySet<string>
  }> = {},
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
  const exhaustedAutomaticAdmissions =
    checks.status === "failed" &&
    automaticAdmissionAttemptsExhausted(state, pr, Queues.snapshot(pr), admissionSteps(state.queues, steps))
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
    // A composition refusal is deterministic: the queue could not build the
    // candidate from what the author submitted, so re-running the same payload
    // cannot pass — whether the failed compose left the PR `submitted` or drove
    // an automatic `rejected`. Project it as `needs-author` with the refusal
    // receipt attached, ahead of the generic `rejected`/`checks-failed` verdicts.
    // This is a derived projection over the failed check's recorded refusal
    // evidence; it stores no new PRStatus (the bay status is untouched).
    if (options.ignoreChecks !== true && (pr.status === "submitted" || pr.status === "rejected")) {
      const receipt = compositionRefusalReceipt(state, pr, steps)
      if (receipt !== undefined) {
        return result({
          code: "needs-author",
          message: `PR '${pr.id}' cannot be composed as submitted: ${receipt.message}`,
          receipt,
        })
      }
    }
    if (pr.status === "rejected") {
      return result({ code: "rejected", message: `PR '${pr.id}' is rejected; submit it again before queueing` })
    }
    if (pr.status !== "submitted") {
      return result({ code: "terminal", message: `PR '${pr.id}' is ${pr.status}, not queueable` })
    }
    if (options.ignoreChecks !== true && checks.status === "queued") {
      const position = checks.position === undefined ? "" : ` at position ${checks.position}`
      return result({ code: "checks-pending", message: `PR '${pr.id}' checks are queued${position}` })
    }
    if (options.ignoreChecks !== true && checks.status === "checking") {
      const run = checks.run === undefined ? "" : ` in ${checks.run}`
      return result({ code: "checking", message: `PR '${pr.id}' checks are running${run}` })
    }
    if (
      options.ignoreChecks !== true &&
      checks.status === "failed" &&
      (checks.run === undefined ||
        projectionLookupGet(state.queues.authority.runs, checks.run)?.released === undefined ||
        exhaustedAutomaticAdmissions)
    ) {
      const run = checks.run === undefined ? "" : ` in ${checks.run}`
      return result({
        code: "checks-failed",
        message: `PR '${pr.id}' checks failed${run}; a new push or check request is required`,
      })
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
  const claimed = activeQueueRuns(state.queues, state.jobs).find(
    (run) =>
      !Queues.terminal(run) &&
      !options.ignoredClaims?.has(run.id) &&
      run.prs.some((candidate) => candidate.id === pr.id),
  )
  return claimed !== undefined
    ? result({
        code: "claimed",
        message: `PR '${pr.id}' is already in active queue run '${claimed.id}'`,
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
  return (
    run.status === "failed" &&
    failed &&
    queueAuthorityReleaseReason(run.error) === undefined &&
    !isIntegrated(run.shape) &&
    run.prs.length > 1
  )
}

function needsAdvance(state: DeepReadonly<RuntimeState>, run: QueueRun): boolean {
  if (Queues.record(state.queues, run.id).failure !== undefined) return false
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
  if (queueAuthorityReleaseReason(jobFailure(step.job)) !== undefined) return true
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
  if (job.status === "canceled") {
    return { code: "run-canceled", message: `Queue run canceled by ${job.canceledBy}: ${job.cancelReason}` }
  }
  throw new Error(`yrd: job '${job.id}' is ${job.status}, not failed`)
}
