import {
  GitRefSchema,
  GitShaSchema,
  PRAlreadyLandedSchema,
  PRAdmissionRecordedFactSchema,
  PRIdSchema,
  PRNeedsAuthorFactSchema,
  PRTerminalAssociationSchema,
  PrCheckabilityConflict,
  baseIdentity,
  checkRequest,
  checksRequested,
  currentPRRev,
  normalizeV2Submitter,
  prBaseSha,
  prAdmission,
  prComposition,
  prCorrelation,
  prDeliveryState,
  prHead,
  prNeedsAuthor,
  prRevisionNumber,
  resolveBase,
  resolvePR,
  reviewState,
  type BaysState,
  type HasBays,
  type PR,
  type PRAdmissionRecord,
  type PRAdmissionRecordedFact,
  type PRAdmissionStep,
} from "@yrd/bay"
import {
  command,
  compareNatural,
  event,
  failureFact,
  journalEvent,
  JsonSchema,
  observeYrdLifecycle,
  parseJournalFrame,
  raiseFailure,
  stage,
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
  localRunner,
  type HasJobs,
  type HasRunner,
  type JobDef,
  type JobDefs,
  type JobError,
  type JobObservation,
  type JobCompletion,
  type JobHandler,
  type JobResult,
  type JobsState,
  type Jobs,
  type Runner,
  type RunJobOptions,
} from "@yrd/job"
import { computed, type ReadSignal } from "@silvery/signals"
import { diagnoseFlowPin, type FlowPin, type StepKind, type YrdConfig } from "@yrd/config"
import {
  PinIntentEvaluationFactSchema,
  PinIntentRefusalSchema,
  type IntentsState,
  type PinIntent,
  type PinIntentAdmission,
  type PinTombstone,
} from "@yrd/intent"
import type { ConditionalLogger } from "loggily"
import * as z from "zod"
import { CandidateFailureReceiptEvidenceSchema, candidateFailureReceiptEvidence } from "./check-attribution.ts"
import {
  CandidateSchema,
  IntegrationProofSchema,
  QueuePauseSchema,
  QueueMemberIdSchema,
  QueueRecordSchema,
  ReplayQueueRecordSchema,
  Queues,
  PRSnapshotSchema,
  type AddStepResult,
  type BatchConfig,
  type Candidate,
  type InstalledStep,
  type IntegratedShape,
  type IntegrationProof,
  type QueueAuditFinding,
  type QueueAuditResult,
  type QueueAuthorityState,
  type QueueAuthorityToken,
  type QueueFailure,
  type QueuePause,
  type QueueRecord,
  type QueueRequirement,
  type Run,
  type RunConclusion,
  type RunAuthority,
  type RunId,
  type QueueSummary,
  type QueueTerminalAssociation,
  type QueuesState,
  type QueueStep,
  type QueueUnassociatedTerminal,
  type StepName,
  type StepSelection,
  type PREligibility,
  type PRCheckRecord,
  type PRShape,
  type PRSnapshot,
} from "./model.ts"
import {
  activeQueueRootIds,
  childRunId,
  indexQueueChild,
  indexQueueStart,
  latestExactRunId,
  latestPrefixRunId,
  latestRootRunId,
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
const RunIdSchema = z.string().trim().min(1)
const CandidateCreatedSchema = CandidateSchema.omit({ createdAt: true })
const StepExecutionSchema = z
  .object({
    run: RunIdSchema,
    step: StepNameSchema,
    index: z.number().int().nonnegative(),
    prs: z.array(PRSnapshotSchema).min(1),
    targetSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/iu)
      .optional(),
    /** Immutable Candidate facts carried into every fresh Job request. Optional
     * only while replaying pre-target-model Jobs. */
    candidate: CandidateCreatedSchema.optional(),
    shape: JsonSchema,
  })
  .strict() as unknown as z.ZodType<StepExecution>

const AdmissionStepArgsSchema = z
  .object({
    pr: PRSnapshotSchema,
    candidate: CandidateCreatedSchema,
    step: StepNameSchema,
    index: z.number().int().nonnegative(),
    shape: JsonSchema,
  })
  .strict()
type AdmissionStepArgs = Readonly<z.infer<typeof AdmissionStepArgsSchema>>

const QueueRunArgsSchema = z
  .object({
    prs: z.array(z.string().trim().min(1)).optional(),
    steps: z.array(StepNameSchema).optional(),
    /** Exact queue tip resolved by the effectful Queue facade before dispatch. */
    baseSha: GitShaSchema.optional(),
    /** Immutable Candidate facts prepared by the effectful Queue facade. */
    candidate: CandidateCreatedSchema.optional(),
    /** Carrier-free intent snapshot supplied by the effectful Queue facade. */
    intent: PRSnapshotSchema.optional(),
  })
  .strict()
  .superRefine((args, context) => {
    if (args.intent !== undefined && args.intent.intent === undefined) {
      context.addIssue({ code: "custom", path: ["intent"], message: "intent run requires intent snapshot evidence" })
    }
    if (args.intent !== undefined && args.prs !== undefined) {
      context.addIssue({ code: "custom", message: "one queue run cannot select both PRs and an intent" })
    }
  })
export type QueueRunArgs = Readonly<z.infer<typeof QueueRunArgsSchema>>

export type AdmitSelection = Readonly<{ prs?: readonly string[] }>

const AdvanceArgsSchema = z.object({ run: RunIdSchema }).strict()
const SettledArgsSchema = AdvanceArgsSchema
/** Compatibility fact for runs whose successful projection must survive Job
 * retention. New Run lifecycle words are translated at the command boundary. */
const SettledEventSchema = SettledArgsSchema.extend({
  status: z.enum(["passed", "failed", "canceled"]).optional(),
}).strict()
const IsolateArgsSchema = AdvanceArgsSchema.extend({
  part: z.union([z.literal(0), z.literal(1)]),
  candidate: CandidateCreatedSchema.optional(),
}).strict()
type IsolateArgs = Readonly<z.infer<typeof IsolateArgsSchema>>
const BatchIsolatedSchema = z
  .object({
    parent: RunIdSchema,
    run: RunIdSchema,
    part: z.union([z.literal(0), z.literal(1)]),
    prs: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()
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
/** One compose/admission cycle that skipped a PR without producing a queue run.
 * The `compose-candidate-skip` warns that accompany it are loggily-only, so this
 * is the fact that makes a head-of-line refusal loop survive the process. */
const AdmissionRefusedSchema = z
  .object({
    pr: PRIdSchema,
    code: z.string().trim().min(1),
    kind: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1),
  })
  .strict()
type AdmissionRefusedArgs = Readonly<z.infer<typeof AdmissionRefusedSchema>>
export type RecordAdmissionRefusalArgs = AdmissionRefusedArgs
const AdmissionRefusedFactSchema = AdmissionRefusedSchema.extend({
  /** Optional only for replaying facts written before exact-revision refusal
   * identity was introduced by 22528. New commands always populate both. */
  revision: z.number().int().positive().optional(),
  headSha: GitShaSchema.optional(),
})
  .strict()
  .refine((fact) => (fact.revision === undefined) === (fact.headSha === undefined), {
    message: "revision and headSha must be provided together",
  })
const SettleAdmissionRefusalSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    disposition: z.literal("needs-person"),
    reason: z.string().trim().min(1),
  })
  .strict()
export type SettleAdmissionRefusalArgs = Readonly<z.infer<typeof SettleAdmissionRefusalSchema>>
/** Consecutive refusals before `queue audit` calls a PR wedged. One skip is a
 * normal losable race in a selectorless drain; a third identical cycle is not.
 *
 * Exported because the runner's self-applied-remedy pass (22474) acts on
 * exactly the PRs the queue itself calls wedged — one number, one home, so the
 * remedy can never fire earlier than the finding that justifies it. */
export const ADMISSION_REFUSAL_LOOP_THRESHOLD = 3
const QueueStartSchema = QueueRecordSchema.omit({ startedAt: true, failure: true })
const ReplayQueueStartSchema = ReplayQueueRecordSchema.omit({ startedAt: true, failure: true })
const QueueFailedPRSchema = z.preprocess(
  normalizeV2Submitter,
  z
    .object({
      pr: QueueMemberIdSchema,
      revision: z.number().int().positive(),
      headSha: GitShaSchema,
      submitter: z.string().trim().min(1).optional(),
    })
    .strict(),
)
const LegacyQueueFailedSchema = z.object({ run: RunIdSchema, error: JobErrorSchema }).strict()
const QueueFailedSchema = LegacyQueueFailedSchema.extend({
  prs: z.array(QueueFailedPRSchema).min(1),
  job: z
    .object({ id: z.string().trim().min(1), attempt: z.number().int().positive() })
    .strict()
    .optional(),
}).strict()
const ReplayQueueFailedSchema = z.union([QueueFailedSchema, LegacyQueueFailedSchema])
const CancelRunArgsSchema = z
  .object({
    run: RunIdSchema,
    by: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict()
export type CancelRunArgs = Readonly<z.infer<typeof CancelRunArgsSchema>>
const QueueRunCanceledFactSchema = CancelRunArgsSchema.extend({
  pr: PRIdSchema.optional(),
  revision: z.number().int().positive().optional(),
  headSha: GitShaSchema.optional(),
}).strict()
const QuiesceLegacyRunArgsSchema = z
  .object({
    run: RunIdSchema,
    reason: z.string().trim().min(1),
  })
  .strict()
export type QuiesceLegacyRunArgs = Readonly<z.infer<typeof QuiesceLegacyRunArgsSchema>>
const SettleOrphanedRunArgsSchema = QuiesceLegacyRunArgsSchema
export type SettleOrphanedRunArgs = Readonly<z.infer<typeof SettleOrphanedRunArgsSchema>>
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
  run: RunIdSchema.optional(),
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
  run: RunId
  step: string
  index: number
  prs: readonly PRSnapshot[]
  targetSha?: string
  candidate?: Readonly<Omit<Candidate, "createdAt">>
  shape: Shape
}>

export type StepRunner<Shape extends PRShape, Output extends JsonValue> = JobHandler<StepExecution<Shape>, Output>

declare const inputShape: unique symbol
declare const outputShape: unique symbol

export type StepDef<Input extends PRShape, Output extends PRShape> = Readonly<{
  name: string
  title: string
  revision: string
  kind: StepKind
  classification?: "base" | "carrier"
  implementationSource?: string
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
  kind?: Exclude<StepKind, "merge">
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
    kind: options.kind ?? "check",
    ...(options.classification === undefined ? {} : { classification: options.classification }),
    job,
  }) as StepDef<Shape, AddStepResult<Shape, Name, Output>>
}

export function withMerge<Shape extends PRShape>(
  runner: StepRunner<Shape, IntegrationProof>,
  options: Readonly<{ revision: string; title?: string; implementationSource?: string }>,
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
    kind: "merge",
    ...(options.implementationSource === undefined ? {} : { implementationSource: options.implementationSource }),
    job,
  }) as StepDef<Shape, Shape & IntegratedShape>
}

export type QueueOptions<Steps extends readonly AnyStepDef[]> = Readonly<{
  steps: Steps
  batch?: BatchConfig
  defaultSteps?: readonly string[]
  /** Base branch used by selectorless drains for records that deliberately carry no base pin. */
  defaultBase?: string
  requires?: readonly QueueRequirement[]
  resolveBaseSha?(base: string): string | Promise<string>
  prepareCandidate?: CandidatePreparer
  evaluateIntent?: (
    input: Readonly<{
      intent: PinIntent
      baseSha: string
      tombstones: readonly PinTombstone[]
    }>,
  ) => PinIntentAdmission | Promise<PinIntentAdmission>
  runner?: (jobs: Jobs) => Runner
  /** Live base-authority flows used for drift warnings and resume refusal. */
  flows?: YrdConfig
  /** Progress SLO declaration. Audit emits facts; paging remains a Hab concern. */
  progress?: QueueProgressPolicy
}>

export type QueueProgressPolicy = Readonly<{
  noLandingMs: number
  refusalCount: number
}>

export const DEFAULT_QUEUE_PROGRESS_POLICY: QueueProgressPolicy = Object.freeze({
  noLandingMs: 10 * 60_000,
  refusalCount: ADMISSION_REFUSAL_LOOP_THRESHOLD,
})

export type QueueAuditOptions = Readonly<{ now?: string }>

export type CandidatePreparationInput = Readonly<{
  id: string
  queueId: string
  baseSha: string
  revs: Candidate["revs"]
  prs: readonly PRSnapshot[]
}>

export type PreparedCandidate = Omit<Candidate, "createdAt" | "mergeability"> &
  Readonly<{ mergeability: "mergeable" | "conflicting" }>

export type CandidatePreparer = (input: CandidatePreparationInput) => PreparedCandidate | Promise<PreparedCandidate>

type QueueState = Readonly<{ queues: QueuesState }>
type QueueHostState = Readonly<{ bays: BaysState; jobs: JobsState; intents?: DeepReadonly<IntentsState> }>
export type QueueRuntimeState = QueueHostState & QueueState
type RuntimeState = QueueRuntimeState
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
    admissionStep: CommandHandler<AdmissionStepArgs, RuntimeState>
    run: CommandHandler<QueueRunArgs, RuntimeState>
    pause: CommandHandler<PauseQueueArgs, RuntimeState>
    resume: CommandHandler<Readonly<{ base: string }>, RuntimeState>
    advance: CommandHandler<Readonly<{ run: RunId }>, RuntimeState>
    settled: CommandHandler<Readonly<{ run: RunId }>, RuntimeState>
    isolate: CommandHandler<IsolateArgs, RuntimeState>
    retireStalePlan: CommandHandler<Readonly<{ run: RunId }>, RuntimeState>
    cancelRun: CommandHandler<CancelRunArgs, RuntimeState>
    quiesceLegacyRun: CommandHandler<QuiesceLegacyRunArgs, RuntimeState>
    settleOrphanedRun: CommandHandler<SettleOrphanedRunArgs, RuntimeState>
    associateTerminals: CommandHandler<AssociateTerminalsArgs, RuntimeState>
    admissionRefused: CommandHandler<AdmissionRefusedArgs, RuntimeState>
    settleAdmissionRefusal: CommandHandler<SettleAdmissionRefusalArgs, RuntimeState>
    recordIntentEvaluation: CommandHandler<z.infer<typeof PinIntentEvaluationFactSchema>, RuntimeState>
  }>
}>

export type TerminalAssociationCandidate = Readonly<{
  run: RunId
  status: Run["status"]
  conclusion?: RunConclusion
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
  /** Admit immutable PR revisions and return the admitted PR ids. */
  admit(args: AdmitSelection, options?: RunJobOptions): Promise<readonly string[]>
  pause(args: PauseQueueArgs): Promise<QueuePause>
  resume(base: string): Promise<void>
  run(args: QueueRunArgs, options: QueueRunOptions): Promise<readonly Run[]>
  waiting(selector: string, step?: string): WaitingQueueStep
  waitingAdmission(selector: string, step?: string): WaitingAdmissionStep | undefined
  finish(selector: string, completion: FinishQueueArgs, options: RunJobOptions): Promise<Run>
  finishAdmission(selector: string, completion: FinishQueueArgs, options: RunJobOptions): Promise<void>
  cancel(args: CancelQueueArgs): Promise<readonly Run[]>
  /** Cancel every unfinished standalone admission Job for one exact PR revision. */
  cancelAdmissionJobs(args: CancelAdmissionJobsArgs): Promise<readonly string[]>
  cancelRun(args: CancelRunArgs): Promise<Run>
  recover(options: RecoverQueueOptions): Promise<readonly Run[]>
  audit(options?: QueueAuditOptions): QueueAuditResult
  eligibility(selector: string, snapshot?: DeepReadonly<QueueRuntimeState>): PREligibility
  eligibilities(snapshot?: DeepReadonly<QueueRuntimeState>): readonly PREligibility[]
  /** PR batches whose revisions may be refreshed before the next selectorless drain.
   * Queue owns this projection because it must preserve the same candidate
   * partitioning, batch size, and FIFO order as compose. */
  freshnessCandidateBatches(): readonly (readonly string[])[]
  /** Live PR ids in the exact admission order used by a selectorless drain. */
  admissionOrder(): readonly string[]
  checks(selectors?: readonly string[]): readonly PRCheckRecord[]
  terminalAssociationPlan(): TerminalAssociationPlan
  migrateTerminalAssociations(): Promise<TerminalAssociationPlan>
  quiesceLegacyRoots(options: QuiesceLegacyRootsOptions): Promise<QuiesceLegacyRootsReceipt>
  /** Journal a preparation refusal that happened outside Queue's own admission
   * dispatcher, so the same durable wedge oracle sees every compose robot. */
  recordAdmissionRefusal(args: RecordAdmissionRefusalArgs): Promise<void>
  /** Stop selecting one exact refused revision after its automated remedy has
   * reached a durable needs-person outcome. A new revision clears the fact. */
  settleAdmissionRefusal(args: SettleAdmissionRefusalArgs): Promise<void>
  get(run: RunId): Run | undefined
  retentionDiagnostics(): Readonly<{
    retainedRuns: number
    unsettledTrees: number
    terminalTrees: number
    archiveAvailable: boolean
  }>
  history(): Promise<readonly Run[]>
  status(base: string): QueueSummary
}>

type QueueIntentRunArgs = Readonly<{
  intent: PinIntent
  base: string
  /** Exact base is optional only when Queue has an injected base resolver. */
  baseSha?: string
  steps?: readonly string[]
}>
type QueueIntentRunResult =
  | Readonly<{ outcome: "run"; run: Run }>
  | Readonly<{ outcome: "noop" | "refused"; intent: PinIntent }>

export type QuiesceLegacyRootsOptions = Readonly<{
  /** ISO timestamp used to decide whether a legacy root's writer lease is still live. */
  now: string
  /** Migration identity recorded on each settled job cancellation. */
  by: string
}>

export type QuiesceLegacyRootsReceipt = Readonly<{
  provenance: "migration/21012-legacy-quiesce"
  reason: "legacy-quiesced"
  quiesced: readonly Readonly<{ run: RunId; jobs: readonly string[] }>[]
}>

export type QueueRunOptions = RunJobOptions & Readonly<{ continueAdmissions?: () => boolean }>

export type WaitingQueueStep = Readonly<{
  run: Run
  step: QueueStep & Readonly<{ job: Extract<Job, { status: "waiting" }> }>
}>

export type WaitingAdmissionStep = Readonly<{
  pr: string
  revision: number
  step: Readonly<{ name: string; job: Extract<Job, { status: "waiting" }> }>
}>

export type FinishQueueArgs = Omit<JobCompletion, "token"> & Readonly<{ job: Job["id"]; step?: string; token: string }>

export type CancelQueueArgs = Readonly<{
  prs: readonly string[]
  by: string
  reason: string
}>

export type CancelAdmissionJobsArgs = Readonly<{
  pr: string
  revision: number
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
) => YrdDef<State & QueueState, Commands & QueueCommands, Features & HasQueue<Shape> & HasRunner>) &
  Readonly<{ jobDefs: JobDefs }>

export function withQueue<const Steps extends readonly AnyStepDef[]>(
  options: QueueOptions<Steps> & ValidateStepChain<Steps>,
): QueuePlugin<FinalShape<Steps>> {
  const steps = installSteps(options.steps)
  const progress = validateQueueProgressPolicy(options.progress ?? DEFAULT_QUEUE_PROGRESS_POLICY)
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
  const commands = createQueueCommands(steps, byName, options.flows, options.prepareCandidate !== undefined)

  const install = <State extends object, Commands extends CommandTree, Features extends HasJobs & HasBays>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { queues: initial },
      commands,
      events: {
        "queue/candidate/created": journalEvent(1, CandidateCreatedSchema),
        "queue/run/started": journalEvent(1, z.object({ run: QueueStartSchema }).strict()),
        "queue/run/failed": journalEvent(1, QueueFailedSchema),
        "queue/run/canceled": journalEvent(1, QueueRunCanceledFactSchema),
        "queue/run/settled": journalEvent(1, SettledEventSchema),
        "queue/paused": journalEvent(1, PauseQueueArgsSchema),
        "queue/resumed": journalEvent(1, ResumeQueueArgsSchema),
        "queue/batch/isolated": journalEvent(1, BatchIsolatedSchema),
        "queue/admission/refused": journalEvent(1, AdmissionRefusedFactSchema),
        "queue/admission/settled": journalEvent(1, SettleAdmissionRefusalSchema),
      },
      replayEvents: {
        "queue/candidate/created": CandidateCreatedSchema,
        "queue/run/started": z.object({ run: ReplayQueueStartSchema }).strict(),
        "queue/run/failed": ReplayQueueFailedSchema,
        "queue/run/canceled": QueueRunCanceledFactSchema,
        "queue/run/settled": SettledEventSchema,
      },
      projectionVersion: "queues-v9-progress-slo",
      project: projectQueues,
      compact: (state, complete) => {
        const runtime = complete as unknown as DeepReadonly<RuntimeState>
        return { queues: compactQueueProjection(state.queues, runtime.jobs, runtime.bays) }
      },
      create(yrd) {
        yrd.jobs.requireDefinitions(jobDefs)
        const configuredRunner = options.runner?.(yrd.jobs)
        const runner =
          configuredRunner ??
          localRunner({
            id: "local",
            jobs: yrd.jobs,
            leaseMs: 5 * 60_000,
          })
        if (Symbol.asyncDispose in runner) {
          yrd.scope.use(runner as Runner & AsyncDisposable)
        }
        return {
          runner,
          queue: createQueue(
            computed(() => yrd.state().queues),
            () => yrd.state() as unknown as DeepReadonly<RuntimeState>,
            yrd.jobs,
            {
              refresh: () => yrd.refresh(),
              admissionStep: (args) => yrd.dispatch(commands.queue.admissionStep, args),
              run: (args) => yrd.dispatch(commands.queue.run, args),
              pause: (args) => yrd.dispatch(commands.queue.pause, args),
              resume: (base) => yrd.dispatch(commands.queue.resume, { base }),
              advance: (run) => yrd.dispatch(commands.queue.advance, { run }),
              settled: (run) => yrd.dispatch(commands.queue.settled, { run }),
              isolate: (run, part, candidate) =>
                yrd.dispatch(commands.queue.isolate, {
                  run,
                  part,
                  ...(candidate === undefined ? {} : { candidate }),
                }),
              retireStalePlan: (run) => yrd.dispatch(commands.queue.retireStalePlan, { run }),
              cancelRun: (args) => yrd.dispatch(commands.queue.cancelRun, args),
              quiesceLegacyRun: (args) => yrd.dispatch(commands.queue.quiesceLegacyRun, args),
              settleOrphanedRun: (args) => yrd.dispatch(commands.queue.settleOrphanedRun, args),
              associateTerminals: (args) => yrd.dispatch(commands.queue.associateTerminals, args),
              admissionRefused: (args) => yrd.dispatch(commands.queue.admissionRefused, args),
              settleAdmissionRefusal: (args) => yrd.dispatch(commands.queue.settleAdmissionRefusal, args),
              recordIntentEvaluation: (args) => yrd.dispatch(commands.queue.recordIntentEvaluation, args),
              recordAdmission: (args) => yrd.bays.recordAdmission(args),
              requestChecks: (pr, baseSha) =>
                yrd.bays.requestChecks({ pr, ...(baseSha === undefined ? {} : { baseSha }) }),
            },
            steps,
            options.defaultBase,
            options.resolveBaseSha,
            options.prepareCandidate,
            options.evaluateIntent,
            configuredRunner,
            options.flows,
            progress,
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
  admissionStep(args: AdmissionStepArgs): Promise<CommandResult>
  run(args: QueueRunArgs): Promise<CommandResult>
  pause(args: PauseQueueArgs): Promise<CommandResult>
  resume(base: string): Promise<CommandResult>
  advance(run: RunId): Promise<CommandResult>
  settled(run: RunId): Promise<CommandResult>
  isolate(run: RunId, part: 0 | 1, candidate?: z.infer<typeof CandidateCreatedSchema>): Promise<CommandResult>
  retireStalePlan(run: RunId): Promise<CommandResult>
  cancelRun(args: CancelRunArgs): Promise<CommandResult>
  quiesceLegacyRun(args: QuiesceLegacyRunArgs): Promise<CommandResult>
  settleOrphanedRun(args: SettleOrphanedRunArgs): Promise<CommandResult>
  associateTerminals(args: AssociateTerminalsArgs): Promise<CommandResult>
  admissionRefused(args: AdmissionRefusedArgs): Promise<CommandResult>
  settleAdmissionRefusal(args: SettleAdmissionRefusalArgs): Promise<CommandResult>
  recordAdmission(args: PRAdmissionRecordedFact): Promise<CommandResult>
  requestChecks(pr: string, baseSha?: string): Promise<CommandResult>
  recordIntentEvaluation(args: z.infer<typeof PinIntentEvaluationFactSchema>): Promise<CommandResult>
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
      const revisions = pr.revs.filter(
        (revision) =>
          revision.n === terminal.revision && (terminal.headSha === undefined || revision.head === terminal.headSha),
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
      if (revision.terminal?.kind !== "rejected" || revision.terminal.at !== terminal.at) {
        return refusedTerminalAssociation(
          terminal,
          "terminal-state-mismatch",
          `yrd: legacy terminal '${terminal.event}' is not the projected rejection for ${terminal.pr} revision ${terminal.revision}@${revision.head}`,
          [],
          revision.head,
        )
      }
      const runs = Queues.values(state.queues)
        .filter((record) =>
          record.prs.some(
            (candidate) =>
              candidate.id === terminal.pr &&
              candidate.revision === terminal.revision &&
              candidate.headSha === revision.head,
          ),
        )
        .map((record) => materializeRun(record, state.jobs))
        .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt) || compareNatural(left.id, right.id))
      const candidates = runs.map(
        (run): TerminalAssociationCandidate => ({
          run: run.id,
          status: run.status,
          ...(run.conclusion === undefined ? {} : { conclusion: run.conclusion }),
          startedAt: run.startedAt,
          ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
          eligible:
            Queues.failed(run) &&
            run.finishedAt !== undefined &&
            run.startedAt <= run.finishedAt &&
            run.finishedAt <= terminal.at,
          ...(run.error === undefined ? {} : { error: { ...run.error } }),
        }),
      )
      const eligible = candidates.filter((candidate) => candidate.eligible)
      if (eligible.length === 0) {
        const failed = candidates.filter(({ status, conclusion }) => status === "completed" && conclusion === "failure")
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
          `yrd: legacy terminal '${terminal.event}' cannot prove one failed Queue run for ${terminal.pr} revision ${terminal.revision}@${revision.head}: ${detail}`,
          candidates,
          revision.head,
        )
      }
      if (eligible.length !== 1) {
        return refusedTerminalAssociation(
          terminal,
          "terminal-run-ambiguous",
          `yrd: legacy terminal '${terminal.event}' has ${eligible.length} failed Queue runs for ${terminal.pr} revision ${terminal.revision}@${revision.head}: ${eligible.map(({ run }) => run).join(", ")}`,
          candidates,
          revision.head,
        )
      }
      const selected = eligible[0]
      if (selected === undefined) throw new Error("yrd: terminal run selection lost its only run")
      const association: QueueTerminalAssociation = {
        pr: terminal.pr,
        revision: terminal.revision,
        headSha: revision.head,
        run: selected.run,
        provenance: "migration/21091",
        evidence: { terminalEvent: terminal.event, run: selected.run },
      }
      return {
        status: "ready",
        terminal: { ...terminalIdentity(terminal, revision.head), headSha: revision.head },
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
  defaultBase: string | undefined,
  resolveBaseSha: QueueOptions<readonly AnyStepDef[]>["resolveBaseSha"],
  prepareCandidate: CandidatePreparer | undefined,
  evaluateIntent: QueueOptions<readonly AnyStepDef[]>["evaluateIntent"],
  configuredRunner: Runner | undefined,
  flows: YrdConfig | undefined,
  progress: QueueProgressPolicy,
  log: ConditionalLogger,
  history: JournalHistory<unknown> | undefined,
  historicalState: () => Promise<DeepReadonly<RuntimeState>>,
): Queue<Shape> {
  const current = (id: RunId): Run => materializeRun(Queues.record(state(), id), runtime().jobs)
  const byName = new Map(steps.map((step) => [step.name, step] as const))

  type CycleBaseResolver = (base: string) => Promise<string>
  const createBaseResolutionCycle = (): CycleBaseResolver | undefined => {
    if (resolveBaseSha === undefined) return undefined
    const resolved = new Map<string, Promise<string>>()
    return (selector) => {
      const base = baseIdentity(selector)
      let result = resolved.get(base)
      if (result === undefined) {
        result = Promise.resolve(resolveBaseSha(base))
        resolved.set(base, result)
      }
      return result
    }
  }

  const markSettledRoot = async (id: RunId): Promise<Run> => {
    const snapshot = runtime()
    const record = Queues.record(snapshot.queues, id)
    const run = materializeRun(record, snapshot.jobs)
    if (record.parent === undefined && !needsSettlement(snapshot, run)) await actions.settled(id)
    return current(id)
  }

  const observeRunLifecycle = (
    observed: Run,
    operation: () => Run | Promise<Run>,
    options: Readonly<{ continuation?: boolean }> = {},
  ): Promise<Run> =>
    observeYrdLifecycle(
      log,
      {
        lifecycle: "run",
        identity: { run: observed.id },
        attributes: {
          base: observed.base,
          prs: observed.prs.map(deliveryIdentity),
          steps: observed.steps.map((step) => step.name),
          ...(options.continuation === true ? { continuation: true } : {}),
        },
        outcome: queueRunOutcome,
        resultAttributes: (result) => ({
          status: result.status,
          // A run-owned failure (no step owns the ERROR) carries its JobError so
          // the human row can render `err=<slug>`; harmless on a settled run.
          ...(result.error === undefined ? {} : { error: result.error }),
        }),
      },
      operation,
    )

  const reportFreshTerminal = async (run: Run): Promise<Run> => {
    const reported = await observeRunLifecycle(run, () => current(run.id))
    await markSettledRoot(run.id)
    return reported
  }

  const warnFlowDrift = (pins: readonly (DeepReadonly<FlowPin> | undefined)[]): void => {
    if (flows === undefined) return
    for (const pin of pins) {
      if (pin === undefined) continue
      for (const diagnostic of diagnoseFlowPin(pin, flows)) {
        if (diagnostic.severity !== "warning") continue
        log.warn?.(diagnostic.message, {
          code: diagnostic.code,
          flow: pin.name,
          expectedFingerprint: pin.fingerprint,
          currentFingerprint: diagnostic.current?.fingerprint,
        })
      }
    }
  }

  const archived = (id: RunId): Run | undefined => {
    if (history === undefined) return undefined
    const canonical = /^r\d+$/iu.test(id.trim()) ? id.trim().toUpperCase() : id
    return materializeArchivedRun(history, jobs, state(), canonical)
  }

  const cleanupSettledRoots = async (): Promise<readonly RunId[]> => {
    const cleaned: RunId[] = []
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

  const drive = async (id: RunId, options: RunJobOptions): Promise<Run> => {
    while (true) {
      const snapshot = runtime()
      const run = materializeRun(Queues.record(snapshot.queues, id), snapshot.jobs)
      if (Queues.terminal(run) && !needsAdvance(snapshot, run)) return run
      const active = run.steps[run.cursor]
      if (active?.job?.status === "queued") {
        const guarded = await actions.advance(id)
        if (guarded.events.length > 0) continue
        try {
          const candidate = snapshot.queues.candidates[run.candidateId]
          if (candidate === undefined) {
            throw new Error(`yrd: queue run '${run.id}' names missing Candidate '${run.candidateId}'`)
          }
          const needsCandidate = active.kind !== "merge" && !("integration" in run.shape)
          const materializesCandidate = configuredRunner !== undefined && needsCandidate
          const runner =
            configuredRunner ??
            localRunner({
              id: options.runner,
              jobs,
              leaseMs: options.leaseMs,
              ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
              ...(options.now === undefined ? {} : { now: options.now }),
            })
          const submitted = await runner.submit({
            job: active.job.id,
            context: materializesCandidate
              ? { scope: "job", candidate: "rw", capabilities: ["git"] }
              : { scope: "job", candidate: "none" },
            ...(materializesCandidate && candidate.ref !== undefined ? { candidateRef: candidate.ref } : {}),
          })
          if (submitted.status === "completed" && submitted.conclusion === "cancelled") {
            log.warn?.("Another Yrd runner finished this job first; using its result.", {
              action: "canceled-skip",
              run: id,
              job: submitted.id,
              status: submitted.status,
              conclusion: submitted.conclusion,
              reason: "Runner observed a terminal cancellation while submitting the queued Job",
            })
          }
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
          log.warn?.("Another Yrd runner finished this job first; using its result.", {
            action: "canceled-skip",
            run: id,
            job: active.job.id,
            status: raced.status,
            ...(raced.status === "completed" ? { conclusion: raced.conclusion } : {}),
            reason: cause instanceof Error ? cause.message : String(cause),
          })
        }
        continue
      }
      if (active?.job?.status === "in_progress" || active?.job?.status === "waiting") {
        const guarded = await actions.advance(id)
        if (guarded.events.length > 0) continue
        return run
      }
      const advanced = await actions.advance(id)
      if (advanced.events.length === 0) return current(id)
    }
  }

  const settle = async (id: RunId, options: RunJobOptions): Promise<Run> => {
    const observed = current(id)
    const continuation = observed.steps.some((step) => step.job !== undefined && step.job.status !== "queued")
    // Stale re-report guard #1: a run with nothing left to settle has ALREADY
    // emitted its one run lifecycle at its real settlement. Return it untouched —
    // no drive, no re-emit.
    if (!needsSettlement(runtime(), observed)) return markSettledRoot(id)

    const settleTree = async (): Promise<Run> => {
      const settled = await drive(id, options)
      if (!bisectable(settled)) return settled
      for (const part of [0, 1] as const) {
        let snapshot = runtime()
        let child = childQueue(snapshot.queues, snapshot.jobs, settled.id, part)
        if (child === undefined) {
          const parentCandidate = snapshot.queues.candidates[settled.candidateId]
          if (parentCandidate === undefined) {
            throw new Error(`yrd: queue run '${settled.id}' names missing Candidate '${settled.candidateId}'`)
          }
          const pivot = Math.ceil(settled.prs.length / 2)
          const prs = part === 0 ? settled.prs.slice(0, pivot) : settled.prs.slice(pivot)
          const candidate = await candidateFactsForSnapshots(prs, parentCandidate.baseSha)
          await actions.isolate(settled.id, part, candidate)
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
      return markSettledRoot(id)
    }

    const result = await observeRunLifecycle(observed, settleTree, { continuation })
    await markSettledRoot(id)
    return result
  }

  const refreshCheckIdentities = async (
    prs: readonly DeepReadonly<PR>[],
    resolveCycleBase: CycleBaseResolver | undefined,
  ): Promise<void> => {
    if (resolveCycleBase === undefined) return
    for (const pr of prs) {
      if (!checksRequested(pr)) continue
      const base = baseIdentity(pr.base)
      const baseSha = await resolveCycleBase(base)
      if (checkRequest(pr)?.baseSha === baseSha) continue
      await actions.requestChecks(pr.id, baseSha)
    }
  }

  const resolveCandidateBaseSha = async (
    prs: readonly DeepReadonly<PR>[],
    resolveCycleBase: CycleBaseResolver | undefined,
  ): Promise<string> => {
    const first = prs[0]
    if (first === undefined) throw new Error("yrd: a Candidate requires at least one PR")
    const base = baseIdentity(first.base)
    if (prs.some((pr) => baseIdentity(pr.base) !== base)) {
      throw new Error("yrd: one Candidate cannot span base branches")
    }
    if (resolveCycleBase !== undefined) return resolveCycleBase(base)
    return requiredCandidateBaseSha(prs.map(Queues.snapshot))
  }

  // 22332: ids reserved by in-flight prepares (pin may land on disk before
  // queue/candidate/created is journaled). Without this set, a compose retry
  // reuses nextCandidateId's journal-only max and self-collides on its own ref.
  const reservedCandidateIds = new Set<string>()
  const allocateCandidateId = (): string => {
    const journaled = Object.keys(runtime().queues.candidates)
      .filter((id) => /^C\d+$/u.test(id))
      .map((id) => Number(id.slice(1)))
    const reserved = [...reservedCandidateIds].filter((id) => /^C\d+$/u.test(id)).map((id) => Number(id.slice(1)))
    return `C${Math.max(0, ...journaled, ...reserved) + 1}`
  }
  const CANDIDATE_REF_COLLISION_LIMIT = 32

  const candidateFactsForSnapshots = async (
    snapshots: readonly DeepReadonly<PRSnapshot>[],
    baseSha: string,
  ): Promise<z.infer<typeof CandidateCreatedSchema> | undefined> => {
    const pinned = pinCandidateBaseSha(snapshots, baseSha)
    const existing = candidateFor(runtime().queues, pinned, baseSha)
    if (existing !== undefined && existing.mergeability !== "unknown") {
      const { createdAt: _createdAt, ...facts } = existing
      return CandidateCreatedSchema.parse(facts)
    }
    if (prepareCandidate === undefined) return undefined
    const first = pinned[0]
    if (first === undefined) throw new Error("yrd: a Candidate requires at least one PR")
    const queueId = queueIdentity(first)
    const revs = pinned.map((member) => ({ pr: member.id, n: member.revision, head: member.headSha }))
    let lastRefused: unknown
    for (let collision = 0; collision < CANDIDATE_REF_COLLISION_LIMIT; collision += 1) {
      const id = allocateCandidateId()
      reservedCandidateIds.add(id)
      const input: CandidatePreparationInput = {
        id,
        queueId,
        baseSha,
        revs,
        prs: pinned,
      }
      let prepared: z.infer<typeof CandidateCreatedSchema>
      try {
        prepared = CandidateCreatedSchema.parse(await prepareCandidate(input))
      } catch (error) {
        // Self-collision / orphan ref / foreign holder: bump id and retry.
        // Self-collision becomes structurally impossible rather than fatal.
        if (failureFact(error)?.code === "candidate-ref-refused") {
          lastRefused = error
          continue
        }
        throw error
      }
      if (
        prepared.id !== input.id ||
        prepared.queueId !== input.queueId ||
        prepared.baseSha !== input.baseSha ||
        prepared.revs.length !== input.revs.length ||
        prepared.revs.some((revision, index) => {
          const expected = input.revs[index]
          return (
            expected === undefined ||
            revision.pr !== expected.pr ||
            revision.n !== expected.n ||
            revision.head !== expected.head
          )
        })
      ) {
        throw new Error(`yrd: Candidate preparer changed immutable content identity for '${input.id}'`)
      }
      if (prepared.mergeability === "unknown") {
        throw new Error(`yrd: Candidate preparer left mergeability unknown for '${input.id}'`)
      }
      if (prepared.mergeability === "mergeable") {
        if (prepared.sha === undefined || prepared.ref === undefined) {
          throw new Error(`yrd: mergeable Candidate '${input.id}' requires a synthetic SHA and ref`)
        }
        if (prepared.ref !== `refs/yrd/candidates/${input.id}`) {
          throw new Error(`yrd: Candidate '${input.id}' must publish refs/yrd/candidates/${input.id}`)
        }
      }
      return prepared
    }
    if (lastRefused !== undefined) throw lastRefused
    throw new Error(`yrd: Candidate id allocation exhausted ${CANDIDATE_REF_COLLISION_LIMIT} collision identities`)
  }

  const candidateFacts = (
    prs: readonly DeepReadonly<PR>[],
    baseSha: string,
  ): Promise<z.infer<typeof CandidateCreatedSchema> | undefined> =>
    candidateFactsForSnapshots(prs.map(Queues.snapshot), baseSha)

  const recordRevisionAdmission = (pr: DeepReadonly<PR>, admission: PRAdmissionRecord): Promise<CommandResult> =>
    actions.recordAdmission({
      pr: pr.id,
      revision: prRevisionNumber(pr),
      headSha: prHead(pr),
      admission,
    })

  const refuseRevisionAdmission = async (
    pr: DeepReadonly<PR>,
    baseSha: string,
    step: string,
    receipt: JobError,
    options: Readonly<{
      candidate?: string
      kind?: Extract<PRAdmissionRecord, { status: "refused" }>["kind"]
      steps?: readonly PRAdmissionStep[]
    }> = {},
  ): Promise<
    Readonly<{ code: string; kind: Extract<PRAdmissionRecord, { status: "refused" }>["kind"]; reason: string }>
  > => {
    const kind = options.kind ?? admissionFailureKind(receipt, false)
    await recordRevisionAdmission(pr, {
      status: "refused",
      kind,
      baseSha,
      requestCount: revisionCheckRequestCount(pr, baseSha),
      ...(options.candidate === undefined ? {} : { candidate: options.candidate }),
      steps: [...(options.steps ?? [])],
      step,
      receipt,
    })
    return { code: receipt.code, kind, reason: receipt.message }
  }

  type RevisionAdmissionOutcome = Readonly<{
    processed: boolean
    refusal?: Readonly<{
      code: string
      kind: Extract<PRAdmissionRecord, { status: "refused" }>["kind"]
      reason: string
    }>
  }>

  const admitPRRevision = async (
    pr: DeepReadonly<PR>,
    baseSha: string,
    runOptions?: RunJobOptions,
  ): Promise<RevisionAdmissionOutcome> => {
    const selected = admissionSteps(runtime().queues, steps)
    const prior = prAdmission(pr)
    const freshRetry = prior?.status === "refused" && hasFreshRevisionCheckAuthority(runtime(), pr, steps)
    if (
      prior?.status === "passed" &&
      prior.baseSha === baseSha &&
      prior.steps.length === selected.length &&
      prior.steps.every(
        (evidence, index) =>
          evidence.status === "passed" &&
          evidence.name === selected[index]?.name &&
          evidence.revision === selected[index]?.revision,
      )
    ) {
      return { processed: false }
    }
    const snapshot = pinCandidateBaseSha([Queues.snapshot(pr)], baseSha)[0]
    if (snapshot === undefined) throw new Error(`yrd: required-check run lost PR '${pr.id}'`)
    let prepared: z.infer<typeof CandidateCreatedSchema> | undefined
    try {
      prepared = await candidateFactsForSnapshots([snapshot], baseSha)
    } catch (error) {
      const fact = failureFact(error)
      const receipt = {
        code: fact?.code ?? "candidate-refused",
        message: fact?.message ?? (error instanceof Error ? error.message : String(error)),
      }
      const kind = admissionFailureKind(receipt, fact?.kind === "infrastructure")
      const refusal = await refuseRevisionAdmission(pr, baseSha, "candidate", receipt, { kind })
      if (kind === "infrastructure") throw error
      return { processed: true, refusal }
    }
    const candidate = CandidateCreatedSchema.parse(
      prepared ?? {
        id: allocateCandidateId(),
        queueId: queueIdentity(snapshot),
        baseSha,
        revs: [{ pr: snapshot.id, n: snapshot.revision, head: snapshot.headSha }],
        mergeability: "unknown",
      },
    )
    if (candidate.mergeability === "conflicting") {
      const receipt = {
        code: "candidate-conflicting",
        message: `Candidate '${candidate.id}' conflicts before required checks`,
      }
      const refusal = await refuseRevisionAdmission(pr, baseSha, "candidate", receipt, { candidate: candidate.id })
      return { processed: true, refusal }
    }
    const admissionRunner =
      configuredRunner ??
      (runOptions === undefined
        ? undefined
        : localRunner({
            id: runOptions.runner,
            jobs,
            leaseMs: runOptions.leaseMs,
            ...(runOptions.heartbeatMs === undefined ? {} : { heartbeatMs: runOptions.heartbeatMs }),
            ...(runOptions.now === undefined ? {} : { now: runOptions.now }),
          }))
    const evidence: PRAdmissionStep[] = []
    let shape: PRShape = prShape([snapshot])
    for (const [index, step] of selected.entries()) {
      const requested = await actions.admissionStep({
        pr: snapshot,
        candidate,
        step: step.name,
        index,
        shape,
      })
      const key = admissionJobKey(snapshot, baseSha, index, step.revision)
      const requestedJob = jobs.requested(requested)[0]
      const jobId =
        requestedJob ?? jobs.getByKey(key)?.id ?? jobs.getByKey(admissionJobKey(snapshot, baseSha, index))?.id
      if (jobId === undefined) throw new Error(`yrd: required check '${step.name}' did not request a Job`)
      let beforeRun = jobs.get(jobId)
      if (
        freshRetry &&
        beforeRun?.status === "completed" &&
        (beforeRun.conclusion === "failure" || beforeRun.conclusion === "timed_out")
      ) {
        beforeRun = await jobs.retry(jobId)
      }
      const job =
        admissionRunner === undefined
          ? jobs.get(jobId)
          : await admissionRunner.submit({
              job: jobId,
              context:
                configuredRunner === undefined
                  ? { scope: "job", candidate: "none" }
                  : { scope: "job", candidate: "rw", capabilities: ["git"] },
              ...(configuredRunner !== undefined && candidate.ref !== undefined ? { candidateRef: candidate.ref } : {}),
            })
      if (job === undefined) throw new Error(`yrd: required check '${step.name}' lost Job '${jobId}'`)
      if (job.status !== "completed") {
        // A remote Runner may yield durable waiting work. The revision remains
        // submitted until a later observation calls this idempotent path again;
        // the standalone Job is the live progress fact, never a Queue Run.
        return { processed: requestedJob !== undefined || beforeRun?.status === "queued" }
      }
      if (job.conclusion !== "success") {
        const receipt = jobFailure(job)
        const failed: PRAdmissionStep = {
          name: step.name,
          revision: step.revision,
          job: job.id,
          status: "refused",
          ...("output" in job && job.output !== undefined ? { output: job.output } : {}),
          receipt,
        }
        const refusal = await refuseRevisionAdmission(pr, baseSha, step.name, receipt, {
          candidate: candidate.id,
          kind: admissionFailureKind(receipt, job.conclusion !== "failure"),
          steps: [...evidence, failed],
        })
        return { processed: true, refusal }
      }
      evidence.push({
        name: step.name,
        revision: step.revision,
        job: job.id,
        status: "passed",
        output: job.output,
      })
      shape = { ...shape, results: { ...shape.results, [step.name]: job.output } }
    }
    await recordRevisionAdmission(pr, {
      status: "passed",
      baseSha,
      requestCount: revisionCheckRequestCount(pr, baseSha),
      candidate: candidate.id,
      steps: evidence,
    })
    return { processed: true }
  }

  const waitingRevisionAdmission = (selector: string, requestedStep?: string): WaitingAdmissionStep | undefined => {
    const pr = resolvePR(runtime().bays, selector)
    if (pr === undefined) return undefined
    const request = checkRequest(pr)
    const baseSha = request?.baseSha ?? prBaseSha(pr)
    if (baseSha === undefined) return undefined
    const snapshot = pinCandidateBaseSha([Queues.snapshot(pr)], baseSha)[0]
    if (snapshot === undefined) return undefined
    for (const [index, step] of admissionSteps(runtime().queues, steps).entries()) {
      if (requestedStep !== undefined && step.name !== requestedStep) continue
      const job =
        jobs.getByKey(admissionJobKey(snapshot, baseSha, index, step.revision)) ??
        jobs.getByKey(admissionJobKey(snapshot, baseSha, index))
      if (job?.status !== "waiting") continue
      return { pr: pr.id, revision: prRevisionNumber(pr), step: { name: step.name, job } }
    }
    return undefined
  }

  const cancelAdmissionJobsForRevision = async (args: CancelAdmissionJobsArgs): Promise<readonly string[]> => {
    const pr = resolvePR(runtime().bays, args.pr)
    if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${args.pr}'`)
    if (!pr.revs.some((revision) => revision.n === args.revision)) {
      raiseFailure("refusal", "pr-revision-not-found", `yrd: PR '${pr.id}' has no revision ${args.revision}`)
    }
    const prefix = admissionRevisionKeyPrefix(pr.id, args.revision)
    const selected = Object.values(runtime().jobs.byId)
      .filter((job) => job.status !== "completed" && job.key?.startsWith(prefix) === true)
      .toSorted((left, right) => compareNatural(left.id, right.id))
    for (const job of selected) {
      await jobs.cancel({ id: job.id, attempt: job.attempt, by: args.by, reason: args.reason })
    }
    return selected.map((job) => job.id)
  }

  const cancelRevisionAdmissionJobs = async (pr: DeepReadonly<PR>, reason: string): Promise<void> => {
    await cancelAdmissionJobsForRevision({
      pr: pr.id,
      revision: prRevisionNumber(pr),
      by: "yrd/queue",
      reason,
    })
  }

  const staleRevisionAdmissionJobs = (): Array<DeepReadonly<JobsState["byId"][string]>> => {
    const snapshot = runtime()
    return Object.values(snapshot.jobs.byId).filter((job) => {
      if (job.status === "completed" || job.key?.startsWith("admission:") !== true) return false
      const match = /^admission:([^:]+):(\d+):/u.exec(job.key)
      if (match === null) throw new Error(`yrd: malformed revision admission Job key '${job.key}'`)
      const [, prId, revisionText] = match
      if (prId === undefined || revisionText === undefined) {
        throw new Error(`yrd: malformed revision admission Job key '${job.key}'`)
      }
      const pr = snapshot.bays.prs[prId]
      if (pr === undefined || prRevisionNumber(pr) !== Number(revisionText)) return true
      const delivery = prDeliveryState(pr)
      return delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready"
    })
  }

  /**
   * Journal the per-PR refusal behind every `compose-candidate-skip` warn below.
   * The warns are loggily-only — they die with the process, and a PR refused at
   * ADMISSION never becomes a run record — so without this the whole class of
   * head-of-line wedge is invisible to `queue audit` (22395).
   */
  const appendAdmissionRefusal = async (args: RecordAdmissionRefusalArgs): Promise<void> => {
    await actions.admissionRefused(args)
  }

  const noteCandidateRefusal = async (
    selectors: readonly (string | undefined)[],
    refusal: Readonly<{ code?: string; kind?: string; reason: string }>,
  ): Promise<void> => {
    for (const selector of selectors) {
      if (selector === undefined) continue
      const pr = resolvePR(runtime().bays, selector)
      // A selector that names no PR is the `pr-not-found` refusal itself: there
      // is nothing to attribute a streak to, and the caller already logged it
      // loud. Anything else would invent a wedge against a phantom id.
      if (pr === undefined) continue
      try {
        await appendAdmissionRefusal({
          pr: pr.id,
          // A losable skip always carries a fact code; name the gap rather than
          // dropping the cycle silently if one ever does not.
          code: refusal.code ?? "unclassified-refusal",
          ...(refusal.kind === undefined ? {} : { kind: refusal.kind }),
          reason: refusal.reason,
        })
      } catch (error) {
        // Bookkeeping must never convert a survivable skip into a resident kill,
        // but it must never fail quietly either — an unrecorded cycle is exactly
        // the blindness this ledger exists to remove.
        log.error?.("queue could not journal a required-check failure; the wedge oracle will under-count", {
          action: "admission-refusal-unrecorded",
          pr: pr.id,
          code: refusal.code,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const noteRevisionAdmissionRefusal = async (
    pr: string,
    refusal: NonNullable<RevisionAdmissionOutcome["refusal"]>,
  ): Promise<void> => {
    log.warn?.("queue admit skipped a merge request that failed its required checks", {
      action: "compose-candidate-skip",
      pr,
      ...refusal,
    })
    await noteCandidateRefusal([pr], refusal)
  }

  /** One admission turn's outcome. `refused` names the selectors this turn
   * skipped with a typed per-PR refusal, so the drain can release the line
   * instead of re-picking the same refused head forever (22474). */
  type AdmissionDispatch = Readonly<{ admitted: string[]; refused: readonly string[] }>

  const dispatchAdmissions = async (
    selectors: readonly string[],
    resolveCycleBase: CycleBaseResolver | undefined,
    selection?: "explicit",
    runOptions?: RunJobOptions,
  ): Promise<AdmissionDispatch> => {
    const admitted: string[] = []
    const refused: string[] = []
    // Implicit (selectorless) drains absorb per-PR terminal races; explicit
    // targeting stays fail-loud so a one-shot caller sees the real outcome.
    const selectorless = selection !== "explicit"
    for (const selector of selectors) {
      try {
        const pr = resolvePR(runtime().bays, selector)
        if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${selector}'`)
        const snapshot = runtime()
        const delivery = prDeliveryState(pr)
        if (delivery === "integrated" || delivery === "already-landed") {
          await cancelRevisionAdmissionJobs(pr, `PR became ${delivery}`)
          continue
        }
        if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready" && delivery !== "needs-author") {
          await cancelRevisionAdmissionJobs(pr, `PR became ${delivery}`)
          throw new PrCheckabilityConflict(pr.id, delivery)
        }
        if (
          blockingQueuePause(snapshot, pr) !== undefined ||
          admissionSteps(snapshot.queues, steps).length === 0 ||
          runningQueue(snapshot.queues, snapshot.jobs, pr.base) !== undefined ||
          (selection !== "explicit" && admissionLineHolder(snapshot, steps, pr) !== undefined)
        ) {
          continue
        }
        warnFlowDrift([pr.flow])
        const baseSha = await resolveCandidateBaseSha([pr], resolveCycleBase)
        const outcome = await admitPRRevision(pr, baseSha, runOptions)
        if (outcome.processed) admitted.push(pr.id)
        if (outcome.refusal !== undefined) {
          await noteRevisionAdmissionRefusal(pr.id, outcome.refusal)
          refused.push(pr.id)
        }
      } catch (error) {
        const fact = failureFact(error)
        const checkability = error instanceof PrCheckabilityConflict
        if (!selectorless || (!checkability && fact?.kind !== "refusal")) {
          throw error
        }
        const refusal = {
          ...(checkability ? { code: "pr-not-checkable" } : fact?.code === undefined ? {} : { code: fact.code }),
          ...(checkability ? { kind: "refusal" } : fact?.kind === undefined ? {} : { kind: fact.kind }),
          reason: error instanceof Error ? error.message : String(error),
        }
        log.warn?.("queue admit skipped a merge request that is no longer eligible", {
          action: "compose-candidate-skip",
          pr: selector,
          ...refusal,
        })
        await noteCandidateRefusal([selector], refusal)
        refused.push(selector)
      }
    }
    return { admitted, refused }
  }

  const drainAdmissions = async (
    selectors: readonly string[],
    options: QueueRunOptions,
    resolveCycleBase: CycleBaseResolver | undefined,
    selection?: "explicit",
  ): Promise<string[]> => {
    const targets = new Set(selectors)
    const admitted = new Set<string>()
    for (const selector of targets) {
      const pr = resolvePR(runtime().bays, selector)
      if (pr === undefined) continue
      const delivery = prDeliveryState(pr)
      if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready" && delivery !== "needs-author") {
        await cancelRevisionAdmissionJobs(pr, `PR became ${delivery}`)
      }
    }
    // PRs this drain already refused. A resident drain dispatches ONE queued PR
    // per turn (see below), so without this set a refused head is re-picked as
    // the head every turn and the drain ends having admitted nothing — the
    // head-of-line wedge (22474): PR1791 held the whole queue through 44
    // consecutive refusal cycles while seven ready PRs stacked behind it. The
    // set only releases the LINE; the refusal itself is still ledgered exactly
    // once per cycle by dispatchAdmissions.
    const released = new Set<string>()
    const remember = (candidate: Run): void => {
      for (const pr of candidate.prs) {
        if (targets.has(pr.id)) admitted.add(pr.id)
      }
    }

    while (targets.size > 0) {
      if (options.continueAdmissions?.() === false) break
      await actions.refresh()
      const snapshot = runtime()
      const selected = admissionSteps(snapshot.queues, steps)
      // Admission verdicts no longer mint Runs, but replay can still contain an
      // admission Run from before the cutover. Legacy Runs predate explicit
      // settlement claims, so activeQueueRuns() cannot discover all of them;
      // find the retired shape directly and settle it before selecting a new
      // head. This migration path must never match an integrating Run.
      const active = Queues.values(snapshot.queues)
        .filter((record) => record.stepSelection?.authority === "admission")
        .map((record) => materializeRun(record, snapshot.jobs))
        .filter((candidate) => candidate.status === "queued" || candidate.status === "in_progress")
        .filter((candidate) => selection !== "explicit" || candidate.prs.some((pr) => targets.has(pr.id)))
        .filter((candidate) => samePlan(candidate.steps, selected))
        .toSorted((left, right) => compareNatural(left.id, right.id))[0]
      if (active !== undefined) {
        const settled = await settle(active.id, options)
        remember(settled)
        if (settled.status === "in_progress") break
        continue
      }

      const queued = admissionQueue(snapshot, steps, selection === "explicit" ? targets : undefined).filter(
        (pr) => !released.has(pr.id),
      )
      // A resident (`continueAdmissions` installed) admits one PR per turn so a
      // drain signal can interrupt between admissions; a one-shot dispatches the
      // whole queue in a single turn and needs no release.
      const turn = options.continueAdmissions === undefined ? queued : queued.slice(0, 1)
      const dispatched = await dispatchAdmissions(
        turn.map((pr) => pr.id),
        resolveCycleBase,
        selection,
        options,
      )
      for (const pr of dispatched.admitted) admitted.add(pr)
      for (const pr of dispatched.refused) released.add(pr)
      // Head-of-line release: the turn admitted nothing because it was refused,
      // and PRs behind it have not been tried yet. Take the next one. `released`
      // grows by at least one whenever this branch is taken, so `queued` strictly
      // shrinks and the loop still terminates.
      if (dispatched.refused.length > 0 && queued.length > turn.length) continue
      if (dispatched.admitted.length > 0 && dispatched.refused.length === 0) continue

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
    return [...admitted].toSorted(compareNatural)
  }

  const runIntent = async (args: QueueIntentRunArgs, runOptions: QueueRunOptions): Promise<QueueIntentRunResult> => {
    await actions.refresh()
    const currentIntent = runtime().intents?.records[args.intent.id]
    if (currentIntent === undefined) {
      raiseFailure("refusal", "intent-not-found", `yrd: no intent '${args.intent.id}'`)
    }
    const active = activeQueueRuns(runtime().queues, runtime().jobs).find((run) =>
      run.prs.some((snapshot) => snapshot.intent?.id === currentIntent.id),
    )
    if (active !== undefined) return { outcome: "run", run: await settle(active.id, runOptions) }
    if (currentIntent.status !== "open") {
      raiseFailure(
        "refusal",
        "intent-terminal",
        `yrd: intent '${currentIntent.id}' is already ${currentIntent.status}; it cannot start a Queue run`,
      )
    }
    const intent = currentIntent as PinIntent
    const base = baseIdentity(args.base)
    const baseSha = args.baseSha ?? (resolveBaseSha === undefined ? undefined : await resolveBaseSha(base))
    if (baseSha === undefined) {
      throw new Error(`yrd: intent '${intent.id}' requires an exact base SHA or an injected base resolver`)
    }
    if (evaluateIntent === undefined) {
      throw new Error("yrd: Queue has no merge-time intent evaluator")
    }
    const tombstones = Object.values(runtime().intents?.tombstoneRecords ?? {}).filter(
      (record) => record.component === intent.component,
    ) as PinTombstone[]
    const evaluation = await evaluateIntent({ intent, baseSha, tombstones })
    if (!evaluation.admitted) {
      const { admitted: _admitted, ...rawRefusal } = evaluation
      const refusal = PinIntentRefusalSchema.parse(rawRefusal)
      await actions.recordIntentEvaluation({
        intent: intent.id,
        baseSha,
        outcome: "refused",
        refusal,
      })
      const refused = runtime().intents?.records[intent.id]
      if (refused === undefined) throw new Error(`yrd: the failed intent '${intent.id}' disappeared`)
      return { outcome: "refused", intent: refused as PinIntent }
    }
    if (evaluation.relation === "deferred" || evaluation.target === undefined) {
      throw new Error(`yrd: merge-time evaluation left intent '${intent.id}' target deferred`)
    }
    const evaluated = { priorPin: evaluation.currentPin, target: evaluation.target }
    await actions.recordIntentEvaluation({
      intent: intent.id,
      baseSha,
      outcome: evaluation.relation,
      evaluated,
    })
    if (evaluation.relation === "noop") {
      const noop = runtime().intents?.records[intent.id]
      if (noop === undefined) throw new Error(`yrd: noop intent '${intent.id}' disappeared`)
      return { outcome: "noop", intent: noop as PinIntent }
    }
    const snapshot = PRSnapshotSchema.parse({
      id: intent.id,
      branch: `intent/${intent.id}`,
      base,
      issue: intent.issue.id,
      revision: 1,
      // There is deliberately no authored carrier. The immutable member is
      // anchored to the exact base against which Queue synthesizes it.
      headSha: baseSha,
      baseSha,
      intent: {
        id: intent.id,
        authored: {
          intentId: intent.intentId,
          issue: intent.issue,
          component: intent.component,
          ...(intent.target === undefined ? {} : { target: intent.target }),
        },
        evaluated,
      },
    })
    const candidate = await candidateFactsForSnapshots([snapshot], baseSha)
    const started = await actions.run({
      intent: snapshot,
      ...(args.steps === undefined ? {} : { steps: [...args.steps] }),
      baseSha,
      ...(candidate === undefined ? {} : { candidate }),
    })
    const startedEvent = started.events.find((applied) => applied.name === "queue/run/started")
    if (startedEvent === undefined) throw new Error(`yrd: intent '${intent.id}' did not start a Queue run`)
    const id = QueueStartSchema.parse((startedEvent.data as { run?: unknown }).run).id
    return { outcome: "run", run: await settle(id, runOptions) }
  }

  return Object.freeze({
    state,
    steps: () => steps.map(descriptor),
    admissionOrder: () => requestedPRs(runtime().bays, {}).map((pr) => pr.id),
    async admit(args, runOptions) {
      return observeYrdLifecycle(
        log,
        {
          lifecycle: "admit",
          attributes: { selectors: args.prs },
          outcome: (prs) =>
            prs.some((selector) => {
              const pr = resolvePR(runtime().bays, selector)
              if (pr === undefined) {
                throw new Error(`yrd: accepted merge request '${selector}' disappeared from bay state`)
              }
              return prAdmission(pr) === undefined
            })
              ? "progress"
              : "succeeded",
          resultAttributes: (prs) => ({ prs }),
        },
        async () => {
          const resolveCycleBase = createBaseResolutionCycle()
          const requestedSelectors = args.prs?.length ? args.prs : undefined
          const selection: "explicit" | undefined = requestedSelectors === undefined ? undefined : "explicit"
          await actions.refresh()
          await cleanupSettledRoots()
          let snapshot = runtime()
          const selected =
            requestedSelectors === undefined
              ? admissionQueue(snapshot, steps)
              : requestedSelectors.map((selector) => {
                  const pr = resolvePR(snapshot.bays, selector)
                  if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${selector}'`)
                  return pr
                })
          await refreshCheckIdentities(selected, resolveCycleBase)
          snapshot = runtime()
          const selectors =
            requestedSelectors === undefined
              ? admissionQueue(snapshot, steps).map((pr) => pr.id)
              : selected.map((pr) => pr.id)
          return runOptions === undefined
            ? (await dispatchAdmissions(selectors, resolveCycleBase)).admitted
            : drainAdmissions(selectors, runOptions, resolveCycleBase, selection)
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
    async recordAdmissionRefusal(args) {
      await appendAdmissionRefusal(args)
    },
    async settleAdmissionRefusal(args) {
      await actions.settleAdmissionRefusal(args)
    },
    waitingAdmission(selector, step) {
      return waitingRevisionAdmission(selector, step)
    },
    async finishAdmission(selector, completion, options) {
      const waiting = waitingRevisionAdmission(selector, completion.step)
      if (waiting === undefined) {
        raiseFailure(
          "refusal",
          "admission-step-not-waiting",
          `yrd: PR '${selector}' has no waiting required check${completion.step === undefined ? "" : ` '${completion.step}'`}`,
        )
      }
      if (waiting.step.job.id !== completion.job) {
        raiseFailure(
          "refusal",
          "job-mismatch",
          `yrd: waiting required check '${waiting.step.name}' belongs to Job '${waiting.step.job.id}', not '${completion.job}'`,
        )
      }
      await jobs.finish(completion.job, {
        attempt: completion.attempt,
        runner: completion.runner,
        token: completion.token,
        result: completion.result,
      })
      const pr = resolvePR(runtime().bays, waiting.pr)
      if (pr === undefined || prRevisionNumber(pr) !== waiting.revision) {
        raiseFailure("refusal", "stale-pr", `yrd: PR '${waiting.pr}' changed while a required check was waiting`)
      }
      const request = checkRequest(pr)
      const baseSha = request?.baseSha ?? prBaseSha(pr)
      if (baseSha === undefined) {
        raiseFailure("infrastructure", "base-sha-missing", `yrd: PR '${pr.id}' required checks have no resolved base`)
      }
      const outcome = await admitPRRevision(pr, baseSha, options)
      if (outcome.refusal !== undefined) await noteRevisionAdmissionRefusal(pr.id, outcome.refusal)
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
          const selection = args.prs !== undefined && args.prs.length > 0 ? "explicit" : undefined
          const explicitStepAuthority = args.steps !== undefined
          // A selectorless compose is a multi-candidate drain (the long-lived
          // resident's default path, and any bare `queue run`): one candidate lost
          // to a typed refusal must not abort the whole compose nor kill the
          // resident. Skip it LOUD and continue. A targeted one-shot run has no
          // other candidate to fall through to, so it stays fail-loud, and a
          // non-refusal (a real bug) always propagates.
          const selectorless = args.prs === undefined || args.prs.length === 0
          const settleCandidate = async (candidateId: RunId): Promise<void> => {
            try {
              await settle(candidateId, runOptions)
            } catch (error) {
              const fact = failureFact(error)
              if (!selectorless || fact?.kind !== "refusal") throw error
              // A stale-plan batch can never isolate under the installed catalog.
              // Retire it once so it cannot poison every future resident cycle.
              if (fact.code === "stale-plan") {
                await actions.retireStalePlan(candidateId)
                log.warn?.("Skipped an outdated batch because its PRs can no longer be tested together.", {
                  action: "compose-stale-plan-retire",
                  run: candidateId,
                  code: fact.code,
                  reason: error instanceof Error ? error.message : String(error),
                })
                return
              }
              // Not ledgered: this skip is run-scoped, and a run record already
              // exists — the record walk in `auditQueues` can see it. The ledger
              // covers only the skips that never mint a record.
              log.warn?.("Skipped a PR that changed while its batch was being prepared.", {
                action: "compose-candidate-skip",
                run: candidateId,
                code: fact.code,
                reason: error instanceof Error ? error.message : String(error),
              })
            }
          }
          const resolveCycleBase = createBaseResolutionCycle()
          await actions.refresh()
          await cleanupSettledRoots()
          if (args.steps?.length === 0) return []
          let intentCutoff: QueuePosition | undefined
          if (selectorless) {
            while (true) {
              const intent = queuedIntents(runtime())[0]
              if (intent === undefined) break
              const intentPosition = intentQueuePosition(intent)
              const queuedPR = requestedPRs(runtime().bays, args)[0]
              if (queuedPR !== undefined && compareQueuePosition(prQueuePosition(queuedPR), intentPosition) <= 0) {
                intentCutoff = intentPosition
                break
              }
              if (defaultBase === undefined) {
                throw new Error("yrd: selectorless intent drain requires a configured default base")
              }
              const outcome = await runIntent(
                {
                  intent,
                  base: defaultBase,
                  ...(args.steps === undefined ? {} : { steps: args.steps }),
                },
                runOptions,
              )
              // One synthesized landing is one serial-head turn. Terminal
              // noops/refusals release their position in the same frame, so the
              // same turn keeps walking until it reaches live work.
              if (outcome.outcome === "run") return [outcome.run]
            }
          }
          let snapshot = runtime()
          const resumable = resumableQueueRoots(snapshot, args, steps)
          const roots: RunId[] = resumable.map((run) => run.id)
          for (const run of resumable) await settleCandidate(run.id)

          snapshot = runtime()
          const activeBases = new Set(
            resumable
              .map((run) => materializeRun(Queues.record(snapshot.queues, run.id), snapshot.jobs))
              .filter((run) => !Queues.terminal(run))
              .map((run) => run.base),
          )
          const consumed = new Set(
            resumable.flatMap((run) =>
              run.prs.filter((pr) => pinnedPRError(snapshot, [pr], run.id) === undefined).map((pr) => pr.id),
            ),
          )
          const requested = requestedPRs(snapshot.bays, args, consumed, intentCutoff)
          const authoritySteps = selectSteps(steps, args.steps ?? snapshot.queues.defaultSteps)
          const authorityGaps = selectorless
            ? requested.flatMap((pr) => {
                const prSnapshot = Queues.snapshot(pr)
                return queueAuthorityGaps(
                  snapshot.queues.authority,
                  [prSnapshot],
                  authoritySteps,
                  integratedPRShape([pr]) !== undefined,
                )
              })
            : []
          for (const gap of authorityGaps) {
            try {
              if (gap.reason === "consumed") {
                const ejected = await actions.run({
                  prs: [gap.pr],
                  ...(args.steps === undefined ? {} : { steps: args.steps }),
                })
                if (!ejected.events.some((applied) => applied.name === "pr/needs-author")) {
                  throw new Error(`yrd: consumed authority for PR '${gap.pr}' produced no needs-author receipt`)
                }
              }
              const gapReason =
                gap.reason === "consumed"
                  ? `${gap.kind} authority was consumed by queue run '${gap.consumedBy}'`
                  : `no ${gap.kind} authority fact exists`
              log.warn?.("queue compose ejected a candidate without runnable authority", {
                action: "compose-candidate-skip",
                pr: gap.pr,
                code: `queue-${gap.kind}-authority-${gap.reason}`,
                reason: gapReason,
                remedy: `yrd pr recut ${gap.pr} --preflight --queue`,
              })
              // A `consumed` gap ejects with a durable `pr/needs-author` receipt,
              // so it leaves a trace and stops repeating. A `missing` gap leaves
              // nothing and re-skips the same PR every cycle — ledger that one.
              if (gap.reason === "missing") {
                await noteCandidateRefusal([gap.pr], {
                  code: `queue-${gap.kind}-authority-missing`,
                  reason: gapReason,
                })
              }
            } catch (error) {
              // 22306 class: a single PR's authority/eject refusal must not abort the
              // selectorless drain (same boundary as the per-candidate wrap below).
              const fact = failureFact(error)
              if (!selectorless || fact === undefined || (fact.kind !== "refusal" && fact.kind !== "infrastructure")) {
                throw error
              }
              log.warn?.("queue compose skipped an authority-gap merge request lost to a losable failure", {
                action: "compose-candidate-skip",
                pr: gap.pr,
                code: fact.code,
                kind: fact.kind,
                reason: fact.message,
              })
              await noteCandidateRefusal([gap.pr], { code: fact.code, kind: fact.kind, reason: fact.message })
            }
          }
          const authorityGapIds = new Set(authorityGaps.map((gap) => gap.pr))
          snapshot = runtime()
          const refusedAdmissions = selectorless ? refusedRevisionAdmissions(snapshot) : []
          const checked = explicitStepAuthority
            ? []
            : [...requested, ...refusedAdmissions].filter((pr) => !authorityGapIds.has(pr.id) && checksRequested(pr))
          const before = new Map(checked.map((pr) => [pr.id, checkEligibility(snapshot, pr, steps).status]))
          // Admission is revision-owned evidence, not a Queue Run. Revalidate
          // each requested revision against this cycle's base before selecting
          // landing work. The driver still settles any historical active
          // admission Run before recording a new immutable revision verdict.
          try {
            await refreshCheckIdentities(checked, resolveCycleBase)
            const currentChecked = checked.flatMap((pr) => {
              const current = resolvePR(runtime().bays, pr.id)
              return current === undefined ? [] : [current]
            })
            await drainAdmissions(
              currentChecked.map((pr) => pr.id),
              runOptions,
              resolveCycleBase,
              selection,
            )
          } catch (error) {
            const fact = failureFact(error)
            if (!selectorless || fact === undefined || (fact.kind !== "refusal" && fact.kind !== "infrastructure")) {
              throw error
            }
            log.warn?.("queue compose skipped required-check work lost to a losable failure", {
              action: "compose-candidate-skip",
              code: fact.code,
              kind: fact.kind,
              reason: fact.message,
              prs: checked.map((pr) => pr.id),
            })
            await noteCandidateRefusal(
              checked.map((pr) => pr.id),
              { code: fact.code, kind: fact.kind, reason: fact.message },
            )
          }
          snapshot = runtime()
          const currentChecked = checked.flatMap((pr) => {
            const current = resolvePR(snapshot.bays, pr.id)
            return current === undefined ? [] : [current]
          })
          const unsettled = currentChecked.filter((pr) => checkEligibility(snapshot, pr, steps).status !== "passed")
          const pending = unsettled.filter((pr) => checkEligibility(snapshot, pr, steps).status !== "failed")
          const pendingIds = new Set(pending.map((pr) => pr.id))
          if (unsettled.length > 0) {
            const newlyFailed = unsettled.some(
              (pr) => before.get(pr.id) !== "failed" && checkEligibility(snapshot, pr, steps).status === "failed",
            )
            if (
              selection === "explicit" &&
              (newlyFailed || unsettled.some((pr) => checkEligibility(snapshot, pr, steps).status !== "failed"))
            ) {
              return []
            }
          }
          // The admission phase owns these still-checking PRs for this tick.
          // Exclude them from merge selection without aborting the whole phase,
          // so unrelated ready PRs can integrate while targeted one-PR drains
          // return their admission receipt instead of a checks-running refusal.
          const unavailable = new Set([...consumed, ...pendingIds, ...authorityGaps.map((gap) => gap.pr)])
          const prs = runnablePRs(snapshot, args, steps, unavailable, {
            explicitStepAuthority,
            ...(intentCutoff === undefined ? {} : { implicitBefore: intentCutoff }),
          }).filter((pr) => !activeBases.has(baseIdentity(pr.base)))
          for (const candidate of partitionCandidates(prs, snapshot.queues.batchSize)) {
            if (runOptions.continueAdmissions?.() === false) break
            // 22306 residual: wrap the FULL per-candidate admission (base resolve,
            // prepare, start, settle) so a recut-certificate / command-refused /
            // candidate-ref-refused on ONE partition cannot exit the selectorless
            // drain. Explicit PR targeting still fails loud.
            try {
              warnFlowDrift(candidate.map((pr) => pr.flow))
              const baseSha = await resolveCandidateBaseSha(candidate, resolveCycleBase)
              let facts: z.infer<typeof CandidateCreatedSchema> | undefined
              try {
                facts = await candidateFacts(candidate, baseSha)
              } catch (error) {
                const fact = failureFact(error)
                if (
                  !selectorless ||
                  fact === undefined ||
                  (fact.kind !== "refusal" && fact.kind !== "infrastructure")
                ) {
                  throw error
                }
                log.warn?.("queue compose skipped a Candidate that could not be prepared", {
                  action: "compose-candidate-skip",
                  ...(candidate.length === 1 ? { pr: candidate[0]?.id } : { prs: candidate.map((pr) => pr.id) }),
                  code: fact.code,
                  kind: fact.kind,
                  reason: fact.message,
                })
                await noteCandidateRefusal(
                  candidate.map((pr) => pr.id),
                  { code: fact.code, kind: fact.kind, reason: fact.message },
                )
                continue
              }
              const started = await actions.run({
                prs: candidate.map((pr) => pr.id),
                ...(args.steps === undefined ? {} : { steps: args.steps }),
                baseSha,
                ...(facts === undefined ? {} : { candidate: facts }),
              })
              const ejected = started.events.find((applied) => applied.name === "pr/needs-author")
              if (ejected !== undefined) {
                const refusal = PRNeedsAuthorFactSchema.parse(ejected.data)
                if (!selectorless) raiseFailure("refusal", refusal.receipt.code, refusal.receipt.message)
                log.warn?.("queue compose ejected a candidate without runnable authority", {
                  action: "compose-candidate-skip",
                  pr: refusal.pr,
                  code: refusal.receipt.code,
                  reason: refusal.receipt.message,
                  remedy: `yrd pr recut ${refusal.pr} --preflight --queue`,
                })
                continue
              }
              const startedEvent = started.events.find((applied) => applied.name === "queue/run/started")
              // A submitted PR whose configured plan is entirely admission work can
              // already be satisfied by a retained successful Run. The command is
              // then an intentional idempotent no-op; keep draining later candidates
              // instead of terminating a resident runner at the first cached PR.
              if (
                startedEvent === undefined &&
                started.events.every((event) => event.name === "queue/candidate/created")
              ) {
                continue
              }
              if (startedEvent === undefined) throw new Error("yrd: queue run did not start a run")
              const id = QueueStartSchema.parse((startedEvent.data as { run?: unknown }).run).id
              roots.push(id)
              const root = current(id)
              if (Queues.terminal(root)) await reportFreshTerminal(root)
              else await settleCandidate(id)
            } catch (error) {
              const fact = failureFact(error)
              if (!selectorless || fact === undefined || (fact.kind !== "refusal" && fact.kind !== "infrastructure")) {
                throw error
              }
              log.warn?.("queue compose skipped a candidate lost to a losable failure", {
                action: "compose-candidate-skip",
                ...(candidate.length === 1 ? { pr: candidate[0]?.id } : { prs: candidate.map((pr) => pr.id) }),
                code: fact.code,
                kind: fact.kind,
                reason: fact.message,
              })
              await noteCandidateRefusal(
                candidate.map((pr) => pr.id),
                { code: fact.code, kind: fact.kind, reason: fact.message },
              )
            }
          }
          const final = runtime()
          return [...new Set(roots)].flatMap((root) => queueTree(final.queues, final.jobs, root))
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
          warnFlowDrift([selected.run.flow])
          assertCurrentFlow(selected.run.flow, flows)
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
      const affected: RunId[] = []
      for (const candidate of activeQueueRuns(runtime().queues, runtime().jobs)) {
        if (!candidate.prs.some((pr) => selected.has(pr.id))) continue
        const active = candidate.steps[candidate.cursor]?.job
        const cancelable =
          active?.status === "queued" || active?.status === "in_progress" || active?.status === "waiting"
        if (!cancelable && Queues.terminal(candidate)) continue
        if (cancelable) {
          if (configuredRunner === undefined) {
            await jobs.cancel({ id: active.id, attempt: active.attempt, by: args.by, reason: args.reason })
          } else {
            await configuredRunner.cancel(active.id, { by: args.by, reason: args.reason })
          }
        }
        await actions.advance(candidate.id)
        affected.push(candidate.id)
      }
      return affected.map(current)
    },
    cancelAdmissionJobs: cancelAdmissionJobsForRevision,
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
      const cancelable = active?.status === "queued" || active?.status === "in_progress" || active?.status === "waiting"
      if (cancelable) {
        if (configuredRunner === undefined) {
          await jobs.cancel({ id: active.id, attempt: active.attempt, by: args.by, reason: args.reason })
        } else {
          await configuredRunner.cancel(active.id, { by: args.by, reason: args.reason })
        }
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
            await (configuredRunner === undefined
              ? jobs.recover({
                  now: recoverOptions.recoveryTime,
                  ...(recoverOptions.reason === undefined ? {} : { reason: recoverOptions.reason }),
                  ...(recoverOptions.runner === undefined ? {} : { runner: recoverOptions.runner }),
                })
              : configuredRunner.recover({
                  now: recoverOptions.recoveryTime,
                  ...(recoverOptions.reason === undefined ? {} : { reason: recoverOptions.reason }),
                  ...(recoverOptions.runner === undefined ? {} : { runner: recoverOptions.runner }),
                })),
          )
          const staleAdmissions = staleRevisionAdmissionJobs()
          for (const job of staleAdmissions) {
            await jobs.cancel({
              id: job.id,
              attempt: job.attempt,
              by: recoverOptions.runner ?? "yrd/recover",
              reason: "entry checks no longer belong to a live merge request revision",
            })
          }
          if (staleAdmissions.length > 0) {
            log.warn?.("Stopped required-check jobs whose PR revision is no longer live.", {
              action: "recover-stale-admission-settle",
              reason: "stale-admission-job",
              jobs: staleAdmissions.map((job) => job.id),
            })
          }
          const affected = new Set<RunId>()
          let snapshot = runtime()
          const recoveryRoots = new Set([...rootsBeforeRecovery, ...activeQueueRootIds(snapshot.queues.authority)])
          const candidates = [...recoveryRoots].flatMap((root) => queueTree(snapshot.queues, snapshot.jobs, root))
          const staleQueued: Array<{ run: RunId; step: StepName; drift: string }> = []
          for (const candidate of candidates) {
            const active = candidate.steps[candidate.cursor]
            const drift = active?.job?.status === "queued" ? plannedStepDrift(byName, active) : undefined
            if (active !== undefined && drift !== undefined) {
              const reconciled = await actions.advance(candidate.id)
              if (reconciled.events.length > 0) {
                affected.add(candidate.id)
                staleQueued.push({ run: candidate.id, step: active.name, drift })
              }
              snapshot = runtime()
              continue
            }
            const ownsRecoveredJob = candidate.steps.some(
              (step) => step.job !== undefined && recoveredJobs.has(step.job.id),
            )
            const hasTerminalFailure = candidate.steps.some((step) => step.job !== undefined && jobFailed(step.job))
            if (hasTerminalFailure && needsAdvance(snapshot, candidate)) {
              const reconciled = await actions.advance(candidate.id)
              if (reconciled.events.length > 0) affected.add(candidate.id)
              snapshot = runtime()
            }
            if (ownsRecoveredJob) affected.add(candidate.id)
          }
          if (staleQueued.length > 0) {
            log.warn?.("Stopped queue runs whose queued step definition changed.", {
              action: "recover-stale-steps-release",
              reason: "stale-steps",
              runs: staleQueued.map(({ run }) => run),
              steps: staleQueued.map(({ step }) => step),
              details: staleQueued.map(({ drift }) => drift),
            })
          }
          // Orphan hygiene: cancel every requested Job whose parent run is
          // terminal or absent, so a state upgrade or a settled/canceled run that
          // never terminalized its pending Job cannot strand it forever (the class
          // that fed the selectorless-compose poison). Loud structured receipt
          // naming every settled Job + run; a terminal-run orphan's record is
          // re-materialized into the return, an absent-run orphan has no record to
          // return so the receipt is its report.
          const settledOrphans = orphanedRequestedQueueJobs(runtime())
          for (const orphan of settledOrphans) {
            await jobs.cancel({
              id: orphan.job.id,
              attempt: orphan.job.attempt,
              by: recoverOptions.runner ?? "yrd/recover",
              reason: `orphaned requested job (${orphan.reason})`,
            })
            if (orphan.reason === "run-terminal") affected.add(orphan.run)
          }
          if (settledOrphans.length > 0) {
            log.warn?.("Stopped jobs whose queue run had already ended.", {
              action: "recover-orphan-settle",
              reason: "orphaned-requested-job",
              jobs: settledOrphans.map((orphan) => orphan.job.id),
              runs: [...new Set(settledOrphans.map((orphan) => orphan.run))],
            })
          }
          // Settle every run whose cursor step has had no Job past the orphan
          // grace: nothing else can. `jobs.recover()` above walks Jobs, and
          // `advance` no-ops without one, so a jobless run is projected `running`
          // forever (R1582 ticked for 45h over an already-integrated PR). Loud
          // structured receipt naming every settled run and the step it stalled on.
          const orphanedRuns = orphanedJoblessRuns(runtime(), recoverOptions.recoveryTime)
          for (const orphan of orphanedRuns) {
            await actions.settleOrphanedRun({
              run: orphan.run,
              reason: `yrd: runner disappeared before step '${orphan.step}' started; no job since ${orphan.since}`,
            })
            affected.add(orphan.run)
          }
          if (orphanedRuns.length > 0) {
            log.warn?.("Stopped queue runs whose next step never started.", {
              action: "recover-orphan-run-settle",
              reason: "orphaned-run",
              runs: orphanedRuns.map((orphan) => orphan.run),
              steps: orphanedRuns.map((orphan) => orphan.step),
            })
          }
          // Retire every FAILED batch whose recorded plan drifted so it can never
          // isolate — otherwise it re-refuses isolation every compose cycle forever
          // (the isolate-path zombie). Typed stale-plan release; loud receipt.
          const plannedRetirements = unisolableStalePlanBatches(runtime(), byName)
          const retiredBatches: UnisolableStalePlanBatch[] = []
          for (const planned of plannedRetirements) {
            // Each retirement appends and re-compacts the live projection. That
            // can evict another old planned batch before this loop reaches it
            // (live: retiring R523 crossed the retention boundary and evicted
            // R533). Re-resolve against the refreshed projection instead of
            // dispatching a stale plan into a now-archived run.
            const snapshot = runtime()
            const record = Queues.get(snapshot.queues, planned.run)
            if (record === undefined) continue
            const run = materializeRun(record, snapshot.jobs)
            if (!bisectable(run) || recordedPlanDrift(run.steps, byName) === undefined) continue
            const result = await actions.retireStalePlan(planned.run)
            if (result.events.length === 0) continue
            retiredBatches.push(planned)
            affected.add(planned.run)
          }
          if (retiredBatches.length > 0) {
            log.warn?.("Removed outdated batches that can no longer be tested.", {
              action: "recover-stale-plan-retire",
              reason: "stale-plan",
              runs: retiredBatches.map((batch) => batch.run),
            })
          }
          for (const id of await cleanupSettledRoots()) affected.add(id)
          const final = runtime()
          return [...affected].map((id) => {
            const record = Queues.get(final.queues, id)
            if (record !== undefined) return materializeRun(record, final.jobs)
            const historical = archived(id)
            if (historical !== undefined) return historical
            throw new Error(`yrd: recovered queue run '${id}' is absent from live projection and journal history`)
          })
        },
      )
    },
    audit: (options = {}) => auditQueues(runtime(), steps, progress, options),
    eligibility(selector, projected) {
      // Called once per PR by the queue views, and the single largest stage of a
      // cold `queue ls` — resolvePR plus prEligibility together dominate it.
      return stage("eligibility", () => {
        const snapshot = projected ?? runtime()
        const pr = resolvePR(snapshot.bays, selector)
        if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${selector}'`)
        return prEligibility(snapshot, pr, steps)
      })
    },
    eligibilities(projected) {
      const snapshot = projected ?? runtime()
      return Object.values(snapshot.bays.prs).map((pr) => prEligibility(snapshot, pr, steps))
    },
    freshnessCandidateBatches() {
      const snapshot = runtime()
      const candidates = runnablePRs(snapshot, {}, steps, new Set(), { explicitStepAuthority: true }).filter((pr) =>
        checksRequested(pr),
      )
      return partitionCandidates(candidates, snapshot.queues.batchSize).map((candidate) => candidate.map((pr) => pr.id))
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
      const quiesced: { run: RunId; jobs: string[] }[] = []
      for (const planned of targets) {
        // Every settlement append can compact the live projection. Re-resolve
        // the planned root from refreshed authority instead of dispatching a
        // stale target that replay or compaction has already retired.
        await actions.refresh()
        const target = legacyRootTarget(runtime(), planned.run)
        if (target === undefined) continue
        if (target.leased(now)) {
          raiseFailure(
            "refusal",
            "legacy-root-leased",
            `yrd: Queue projection migration is blocked by live-leased legacy roots; a previous writer still holds ${target.run} — unleased legacy roots would have been auto-quiesced`,
          )
        }
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
        log.warn?.(`Stopped old queue runs during startup: ${quiesced.map((entry) => entry.run).join(", ")}.`, {
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
    ...(result.status === "completed" && result.conclusion === "failure"
      ? nestedStepArtifacts(result.error.evidence)
      : []),
  ]
  if (artifacts.length === 0) return {}
  return {
    artifacts: [...new Map(artifacts.map((artifact) => [JSON.stringify(artifact), artifact])).values()],
  }
}

function runEvidence(run: DeepReadonly<Run>): Record<string, unknown> {
  return {
    run: run.id,
    base: run.base,
    status: run.status,
    ...(run.conclusion === undefined ? {} : { conclusion: run.conclusion }),
    prs: run.prs.map(deliveryIdentity),
    steps: run.steps.map((step) => step.name),
  }
}

function queueRunOutcome(run: DeepReadonly<Run>): YrdLifecycleOutcome {
  if (Queues.succeeded(run)) return "succeeded"
  if (Queues.failed(run)) {
    // When a step Job failed, that step already owns the single ERROR
    // (yrd:jobs:<step>); the run settles at INFO so one failure is not re-raised
    // as a duplicate ERROR one level up. But a run that failed with NO step to
    // own it — a pinned/stale-base refusal rejected before the step's Job ran
    // (record.failure) — has no deeper ERROR. The run must own it, or the
    // failure is silent: fail loud with a run-scoped ERROR.
    const stepOwned = run.steps.some((step) => step.job !== undefined && jobFailed(step.job))
    return stepOwned ? "settled" : "failed"
  }
  if (Queues.terminal(run)) return "settled"
  return "progress"
}

function queueRunsOutcome(runs: readonly DeepReadonly<Run>[]): YrdLifecycleOutcome {
  if (runs.some((run) => run.status === "queued" || run.status === "in_progress" || run.status === "waiting")) {
    return "progress"
  }
  // As with a single run, a batch that finished with failures does not re-raise
  // ERROR: each failing run's deepest job already did. The compose settles at
  // INFO, and composeSettlementLabel names the per-run mix on the message.
  if (runs.some(Queues.failed)) return "settled"
  return "succeeded"
}

/** Name the per-run outcome mix of a settled compose so the flat "compose
 * failed" never misrepresents a batch that also passed runs. Returns undefined
 * for a uniform or still-running batch (the plain outcome word reads fine
 * there); a mixed/all-failed terminal batch gets `settled: N failed, M passed`. */
function composeSettlementLabel(runs: readonly DeepReadonly<Run>[]): string | undefined {
  if (runs.length === 0 || !runs.every(Queues.terminal)) return undefined
  const failed = runs.filter(Queues.failed).length
  if (failed === 0) return undefined
  const passed = runs.filter(Queues.succeeded).length
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
  job?: DeepReadonly<Pick<Job, "id" | "attempt">>,
): EventDraft {
  return event("queue/run/failed", {
    run: run.id,
    error,
    ...(job === undefined ? {} : { job: { id: job.id, attempt: job.attempt } }),
    prs: run.prs.map((pr) => {
      const current = state.bays.prs[pr.id]
      const submitter = current?.revs.find(
        (revision) => revision.n === pr.revision && revision.head === pr.headSha,
      )?.submitter
      return {
        pr: pr.id,
        revision: pr.revision,
        headSha: pr.headSha,
        ...(submitter === undefined ? {} : { submitter }),
      }
    }),
  })
}

function createQueueCommands(
  steps: readonly RuntimeStep[],
  byName: ReadonlyMap<string, RuntimeStep>,
  flows?: YrdConfig,
  requiresPreparedCandidate = false,
): QueueCommands {
  const admissionStep = command({
    title: "Run one revision required check",
    params: AdmissionStepArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: AdmissionStepArgs) {
      const pr = state.bays.prs[args.pr.id]
      if (
        pr === undefined ||
        prRevisionNumber(pr) !== args.pr.revision ||
        prHead(pr) !== args.pr.headSha ||
        baseIdentity(pr.base) !== baseIdentity(args.pr.base)
      ) {
        raiseFailure(
          "refusal",
          "stale-pr",
          `yrd: required checks target stale revision ${args.pr.revision} (${args.pr.headSha}) of PR '${args.pr.id}'`,
        )
      }
      const selected = admissionSteps(state.queues, steps)
      const step = selected[args.index]
      if (step === undefined || step.name !== args.step) {
        throw new Error(`yrd: required check ${args.index} is '${step?.name ?? "missing"}', not '${args.step}'`)
      }
      if (
        args.candidate.baseSha !== args.pr.baseSha ||
        args.candidate.revs.length !== 1 ||
        args.candidate.revs[0]?.pr !== args.pr.id ||
        args.candidate.revs[0]?.n !== args.pr.revision ||
        args.candidate.revs[0]?.head !== args.pr.headSha
      ) {
        throw new Error(`yrd: required-check Candidate '${args.candidate.id}' does not match PR '${args.pr.id}'`)
      }
      const key = admissionJobKey(args.pr, args.candidate.baseSha, args.index, step.revision)
      if (state.jobs.byKey[key] !== undefined) return { events: [] }
      return {
        events: [
          ...(state.queues.candidates[args.candidate.id] === undefined
            ? [event("queue/candidate/created", args.candidate)]
            : []),
          step.job.request(
            {
              run: admissionExecutionId(args.pr, args.candidate.baseSha),
              step: step.name,
              index: args.index,
              prs: [args.pr],
              candidate: args.candidate,
              shape: args.shape as PRShape,
            },
            { key },
          ),
        ],
      }
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
        allowedPRs: [...args.allowedPRs].toSorted(compareNatural),
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
      if (args.intent !== undefined) {
        const snapshot = args.intent
        const base = baseIdentity(snapshot.base)
        const active = runningQueue(state.queues, state.jobs, base)
        if (active !== undefined) throw new QueueRunningConflict(base, active.id)
        const candidateBaseSha = args.baseSha ?? requiredCandidateBaseSha([snapshot])
        const candidateSnapshots = pinCandidateBaseSha([snapshot], candidateBaseSha)
        validateSequence(selected, false)
        if (requiresPreparedCandidate && args.candidate === undefined) {
          throw new Error("yrd: intent queue run requires prepared Candidate facts")
        }
        const reuse = explicitStepAuthority
          ? undefined
          : reusableIntentPrefix(state, candidateSnapshots, args.candidate?.treeSha, selected)
        const remaining = reuse === undefined ? selected : selected.slice(reuse.count)
        if (remaining.length === 0) return { events: [] }
        return startRun(
          state.queues,
          Queues.nextId(state.queues),
          candidateSnapshots,
          candidateBaseSha,
          args.candidate,
          remaining,
          selection,
          reuse?.shape ?? prShape(candidateSnapshots),
          undefined,
          {},
          reuse === undefined ? undefined : { run: reuse.run, results: reuse.shape.results },
        )
      }
      const prs = runnablePRs(state, args, steps, new Set(), { explicitStepAuthority })
      if (prs.length === 0) return { events: [] }
      for (const pr of prs) assertCurrentFlow(pr.flow, flows)
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
      // A check-only admission (no integrating steps) never moves the base, so
      // it must not gate the START of an integrating run — gating here was the
      // deepest layer of the 2026-07-22 merge-starvation livelock. Integrating
      // runs still conflict with each other, a new non-integrating run still
      // waits for whatever is active, and same-PR overlap stays impossible via
      // the claims layer (a PR inside a started admission is not runnable).
      const plansIntegration = (plan: readonly { kind: StepKind }[]): boolean =>
        plan.some((step) => step.kind !== "check")
      const checkOnlyActive = active !== undefined && !plansIntegration(active.steps) && plansIntegration(selected)
      if (active !== undefined && !checkOnlyActive && superseded === undefined) {
        throw new QueueRunningConflict(base, active.id)
      }
      const integrated = integratedPRShape(prs)
      validateSequence(selected, integrated !== undefined)
      const snapshots = prs.map(Queues.snapshot)
      const candidateBaseSha = args.baseSha ?? requiredCandidateBaseSha(snapshots)
      const candidateSnapshots = pinCandidateBaseSha(snapshots, candidateBaseSha)
      const reuse =
        integrated === undefined && !explicitStepAuthority
          ? (reusableRevisionAdmission(state, candidateSnapshots, selected) ??
            reusablePrefix(state, candidateSnapshots, selected))
          : undefined
      const remaining = reuse === undefined ? selected : selected.slice(reuse.count)
      const reusedRun: RunId | undefined =
        reuse !== undefined && "run" in reuse && typeof reuse.run === "string" ? reuse.run : undefined
      if (remaining.length === 0) return { events: [] }
      const authorityGap = queueAuthorityGaps(
        state.queues.authority,
        candidateSnapshots,
        remaining,
        integrated !== undefined,
      )[0]
      if (authorityGap !== undefined) {
        const needsAuthor = queueAuthorityNeedsAuthorEvent(state, authorityGap, remaining)
        if (needsAuthor !== undefined) return { events: [needsAuthor] }
        requireQueueAuthority(state.queues.authority, candidateSnapshots, remaining, integrated !== undefined)
      }
      if (requiresPreparedCandidate && args.candidate === undefined) {
        throw new Error("yrd: queue run requires prepared Candidate facts")
      }
      const started = startRun(
        state.queues,
        Queues.nextId(state.queues),
        candidateSnapshots,
        candidateBaseSha,
        args.candidate,
        remaining,
        selection,
        reuse?.shape ?? integrated ?? prShape(candidateSnapshots),
        integrated?.integration,
        {},
        reuse === undefined
          ? undefined
          : { ...(reusedRun === undefined ? {} : { run: reusedRun }), results: reuse.shape.results },
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
      advanceQueue(state, Queues.record(state.queues, args.run), byName, flows),
  })

  const settled = command({
    title: "Release settled queue run projection",
    params: SettledArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: Readonly<{ run: RunId }>) {
      const record = Queues.record(state.queues, args.run)
      if (record.parent !== undefined) return { events: [] }
      const run = materializeRun(record, state.jobs)
      if (needsSettlement(state, run)) return { events: [] }
      const root = resolveQueueAuthorityRoot(state.queues.authority, run.id)
      const claimed = Object.values(state.queues.authority.claims).some((token) => token.consumedBy === root)
      // Carry the run's terminal projection into the settlement fact. `passed`
      // is the outcome that has no other record-level proof, so without this the
      // run's status dies with its Jobs when retention prunes them. The fact
      // names `root`, so only attach a status the root's own projection owns.
      const settledRun = root === run.id ? run : materializeRun(Queues.record(state.queues, root), state.jobs)
      const status =
        settledRun.status !== "completed"
          ? undefined
          : settledRun.conclusion === "success"
            ? ("passed" as const)
            : settledRun.conclusion === "cancelled"
              ? ("canceled" as const)
              : ("failed" as const)
      return {
        events: claimed ? [event("queue/run/settled", { run: root, ...(status === undefined ? {} : { status }) })] : [],
      }
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

      // A batch can only bisect if its recorded plan still matches the installed
      // catalog. If the plan drifted, isolation is impossible under any config —
      // raise a TYPED stale-plan refusal (not the bare requirePlannedStep throw)
      // so the compose layer can retire it once instead of re-refusing forever.
      const drift = recordedPlanDrift(parent.steps, byName)
      if (drift !== undefined) {
        raiseFailure("refusal", "stale-plan", `yrd: queue run '${parent.id}' cannot isolate: ${drift}`)
      }
      const pivot = Math.ceil(parent.prs.length / 2)
      const prs = args.part === 0 ? parent.prs.slice(0, pivot) : parent.prs.slice(pivot)
      if (prs.length === 0) throw new Error(`yrd: queue run '${parent.id}' has no isolation part ${args.part}`)
      if (requiresPreparedCandidate && args.candidate === undefined) {
        throw new Error("yrd: queue isolation requires prepared Candidate facts")
      }
      const selected = parent.steps.map((planned) => requirePlannedStep(byName, planned))
      const parentCandidate = state.queues.candidates[parent.candidateId]
      if (parentCandidate === undefined) {
        throw new Error(`yrd: queue run '${parent.id}' names missing Candidate '${parent.candidateId}'`)
      }
      const started = startRun(
        state.queues,
        Queues.nextId(state.queues),
        prs,
        parentCandidate.baseSha,
        args.candidate,
        selected,
        parent.stepSelection,
        prShape(prs),
        undefined,
        {
          parent: parent.id,
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

  const retireStalePlan = command({
    title: "Retire an un-isolable stale-plan batch",
    visibility: "public",
    params: AdvanceArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args) {
      const record = Queues.resolve(state.queues, args.run)
      if (record === undefined) raiseFailure("refusal", "run-not-found", `yrd: no queue run '${args.run}'`)
      const run = materializeRun(record, state.jobs)
      // Idempotent: a batch already retired carries a release-reason error, which
      // flips `bisectable` false — re-dispatch (replay, a second recover) is a
      // clean no-op, never a duplicate failed event.
      if (!bisectable(run)) return { events: [] }
      const drift = recordedPlanDrift(run.steps, byName)
      // Guard the typed release: only a genuinely-drifted plan retires. A current
      // plan is still isolable, so refuse rather than silently retiring a live batch.
      if (drift === undefined) {
        raiseFailure(
          "refusal",
          "run-plan-current",
          `yrd: queue run '${args.run}' plan matches the installed catalog; nothing to retire`,
        )
      }
      return {
        events: [queueFailedEvent(state, record, { code: "stale-plan", message: `yrd: cannot isolate: ${drift}` })],
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

  const settleOrphanedRun = command({
    title: "Settle a queue run whose writer disappeared before its step started",
    params: SettleOrphanedRunArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: SettleOrphanedRunArgs) {
      const record = Queues.resolve(state.queues, args.run)
      if (record === undefined) raiseFailure("refusal", "run-not-found", `yrd: no queue run '${args.run}'`)
      const run = materializeRun(record, state.jobs)
      // Idempotent: a replay or a second recover meets a terminal run and settles
      // nothing, never a duplicate failure event.
      if (Queues.terminal(run)) return { events: [] }
      const step = run.steps[run.cursor]
      // Guard the typed release: only a genuinely jobless cursor settles here. A
      // run with a live Job belongs to lease recovery, which reclaims it honestly.
      if (step === undefined || step.job !== undefined) {
        raiseFailure(
          "refusal",
          "run-not-orphaned",
          `yrd: queue run '${args.run}' has a job at step '${step?.name ?? run.cursor}'; nothing to settle`,
        )
      }
      // Fail (not cancel) so record.failure fixes the run terminal; `orphaned-run`
      // releases the run's queue authority, so a member PR that is still submitted
      // re-admits fresh instead of being rejected for a fault that is not its own.
      return { events: [queueFailedEvent(state, record, { code: "orphaned-run", message: args.reason })] }
    },
  })

  const admissionRefused = command({
    title: "Record a compose cycle that skipped a PR without admitting it",
    params: AdmissionRefusedSchema,
    apply(state: DeepReadonly<RuntimeState>, args: AdmissionRefusedArgs) {
      // Fail loud on an unattributable refusal: the ledger's whole job is to name
      // the wedged PR, so a phantom id must never become a phantom finding.
      const pr = state.bays.prs[args.pr]
      if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${args.pr}'`)
      const revision = currentPRRev(pr)
      return {
        events: [
          event("queue/admission/refused", {
            ...args,
            revision: revision.n,
            headSha: revision.head,
          }),
        ],
      }
    },
  })

  const settleAdmissionRefusal = command({
    title: "Settle one exact required-check refusal as needing a person",
    params: SettleAdmissionRefusalSchema,
    apply(state: DeepReadonly<RuntimeState>, args: SettleAdmissionRefusalArgs) {
      const pr = state.bays.prs[args.pr]
      if (pr === undefined) raiseFailure("refusal", "pr-not-found", `yrd: no PR '${args.pr}'`)
      const current = currentPRRev(pr)
      if (current.n !== args.revision || current.head !== args.headSha) {
        raiseFailure(
          "refusal",
          "stale-pr",
          `yrd: this settlement targets stale revision ${args.revision} (${args.headSha}) of merge request '${args.pr}'`,
        )
      }
      const refusal = state.queues.admissionRefusals[args.pr]
      if (refusal === undefined) {
        raiseFailure(
          "refusal",
          "admission-refusal-missing",
          `yrd: merge request '${args.pr}' has no failed required check to settle`,
        )
      }
      if (refusal.revision !== undefined && (refusal.revision !== args.revision || refusal.headSha !== args.headSha)) {
        raiseFailure(
          "refusal",
          "admission-refusal-stale",
          `yrd: the failed check for merge request '${args.pr}' belongs to revision ${refusal.revision} (${refusal.headSha})`,
        )
      }
      if (
        refusal.settlement?.disposition === args.disposition &&
        refusal.settlement.reason === args.reason &&
        refusal.revision === args.revision &&
        refusal.headSha === args.headSha
      ) {
        return { events: [] }
      }
      return { events: [event("queue/admission/settled", args)] }
    },
  })

  const recordIntentEvaluation = command({
    title: "Record one authoritative merge-time intent evaluation",
    params: PinIntentEvaluationFactSchema,
    apply(state: DeepReadonly<RuntimeState>, args: z.infer<typeof PinIntentEvaluationFactSchema>) {
      const record = state.intents?.records[args.intent]
      if (record === undefined) {
        raiseFailure("refusal", "intent-not-found", `yrd: no intent '${args.intent}' to evaluate`)
      }
      return { events: [event("intent/evaluation-recorded", args)] }
    },
  })

  return {
    queue: {
      admissionStep,
      run,
      pause,
      resume,
      advance,
      settled,
      isolate,
      retireStalePlan,
      cancelRun,
      quiesceLegacyRun,
      settleOrphanedRun,
      associateTerminals,
      admissionRefused,
      settleAdmissionRefusal,
      recordIntentEvaluation,
    },
  }
}

type QueueAuthorityKind = "submit" | "checks"
type QueueAuthorityRelease = NonNullable<RunAuthority["released"]>
type QueueAuthorityGap = Readonly<{
  kind: QueueAuthorityKind
  pr: string
  revision: number
  headSha: string
  reason: "missing" | "consumed"
  consumedBy?: RunId
}>

function queueAuthorityNeedsAuthorEvent(
  state: DeepReadonly<RuntimeState>,
  gap: QueueAuthorityGap,
  steps: readonly DeepReadonly<InstalledStep>[],
): EventDraft | undefined {
  if (gap.reason !== "consumed") return undefined
  if (gap.consumedBy === undefined) {
    throw new Error(`yrd: consumed ${gap.kind} authority for PR '${gap.pr}' has no consuming queue run`)
  }
  const pr = state.bays.prs[gap.pr]
  if (pr === undefined || (prDeliveryState(pr) !== "submitted" && prDeliveryState(pr) !== "ready")) {
    return undefined
  }
  const revision = pr.revs.find((candidate) => candidate.n === gap.revision && candidate.head === gap.headSha)
  if (revision === undefined) return undefined
  const code = `queue-${gap.kind}-authority-consumed`
  const remedy = `yrd pr recut ${gap.pr} --preflight --queue`
  const message =
    `yrd: PR '${gap.pr}' revision ${gap.revision} (${gap.headSha}) cannot start a queue run: ` +
    `${gap.kind} authority was consumed by queue run '${gap.consumedBy}'\nresolve: ${remedy}`
  const step = steps.find((candidate) => candidate.kind === "merge")?.name ?? steps[0]?.name ?? "queue"
  return event("pr/needs-author", {
    pr: gap.pr,
    revision: gap.revision,
    headSha: gap.headSha,
    run: gap.consumedBy,
    ...(pr.issue === undefined ? {} : { issueRef: pr.issue }),
    ...(prCorrelation(pr) === undefined ? {} : { correlation: prCorrelation(pr) }),
    ...(revision.submitter === undefined ? {} : { submitter: revision.submitter }),
    step,
    detail: message,
    receipt: { code, message },
  })
}

function queueAuthorityReleaseReason(
  error: DeepReadonly<JobError> | undefined,
): QueueAuthorityRelease["reason"] | undefined {
  // A base race (the base branch or checked candidate ref moved out from under a
  // pinned Run) is environmental, not a PR-content fault: release the Run's queue
  // authority so the still-submitted PR re-admits against the fresh base, instead
  // of terminally rejecting a PR that would merge cleanly once the base settles.
  // `stale-steps` is the same shape one level up: a pending run's not-yet-started
  // step revision drifted out from under it when the installed config moved; the
  // PR is blameless and re-admits fresh under the installed plan. `stale-plan` is
  // the isolate-path sibling: a FAILED bisectable batch whose recorded plan
  // drifted can never be bisected under the installed catalog — retiring it
  // releases authority so it stops being reconciled forever (its terminal member
  // PRs simply re-admit if still submitted).
  if (
    error?.code === "queue-environment-refused" ||
    error?.code === "job-lost" ||
    error?.code === "stale-base" ||
    error?.code === "stale-check" ||
    error?.code === "stale-steps" ||
    error?.code === "stale-plan" ||
    // The authoritative root may already have landed when publication of its
    // derived component-main refs hits a transient push/fetch failure. The
    // promotion is idempotent and the root must never be compensated; release
    // the same PR revision so a fresh merge attempt reconciles the missing refs.
    error?.code === "component-main-promotion-failed" ||
    error?.code === "component-main-inspection-failed" ||
    // `orphaned-run` is the jobless sibling: the run's writer vanished before the
    // cursor step was requested (or its Jobs aged out of retention while the
    // record survived), so no Job exists to lose and no advance can ever move it.
    // The member PRs are blameless — release so they re-admit fresh.
    error?.code === "orphaned-run" ||
    isInfraRetryCompositionFailure(error?.code)
  ) {
    return error.code
  }
  return undefined
}

function authorityRequirement(
  authority: DeepReadonly<QueueAuthorityState>,
  pr: DeepReadonly<PRSnapshot>,
  steps: readonly DeepReadonly<InstalledStep>[],
  alreadyIntegrated = false,
): QueueAuthorityKind | undefined {
  if (pr.intent !== undefined) return undefined
  if (steps.some((step) => step.kind === "merge")) return "submit"
  if (alreadyIntegrated) return undefined
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

function queueAuthorityGaps(
  authority: DeepReadonly<QueueAuthorityState>,
  prs: readonly DeepReadonly<PRSnapshot>[],
  steps: readonly DeepReadonly<InstalledStep>[],
  alreadyIntegrated = false,
): QueueAuthorityGap[] {
  const gaps: QueueAuthorityGap[] = []
  for (const pr of prs) {
    const kind = authorityRequirement(authority, pr, steps, alreadyIntegrated)
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
  alreadyIntegrated = false,
): void {
  const gap = queueAuthorityGaps(authority, prs, steps, alreadyIntegrated)[0]
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

  const gaps = queueAuthorityGaps(authority, run.prs, run.steps, run.initialIntegration !== undefined)
  const submits: Record<string, QueueAuthorityToken> = { ...authority.submits }
  const checks: Record<string, QueueAuthorityToken> = { ...authority.checks }
  const claims: Record<string, QueueAuthorityToken> = { ...authority.claims }
  const explicitSettlement = run.settlement === "explicit"
  const consumesSubmit = run.steps.some((step) => step.kind === "merge")
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
    const kind = authorityRequirement(authority, pr, run.steps, run.initialIntegration !== undefined)
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

function resolveQueueAuthorityRoot(authority: DeepReadonly<QueueAuthorityState>, run: RunId): RunId {
  const seen = new Set<RunId>()
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

function settleRunClaim(authority: DeepReadonly<QueueAuthorityState>, run: RunId): QueueAuthorityState {
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
  const settled = SettledEventSchema.parse(applied.data)
  const record = Queues.get(state.queues, settled.run)
  if (record === undefined) throw new Error(`yrd: no queue run '${settled.run}'`)
  if (record.parent !== undefined) throw new Error(`yrd: settled queue run '${settled.run}' is not a root`)
  // A settled `passed` run is terminal on the record from here on, so Job
  // retention can prune its Jobs without resurrecting it as a phantom `running`.
  // `failed`/`canceled` already carry their own record-level fact.
  const settledRecord =
    settled.status === "passed" && record.passedAt === undefined ? { ...record, passedAt: applied.ts } : record
  return {
    queues: markQueueTerminalRoot(
      {
        ...state.queues,
        authority: settleRunClaim(state.queues.authority, record.id),
        ...(settledRecord === record ? {} : { records: Queues.set(state.queues.records, settledRecord) }),
      },
      record.id,
    ),
  }
}

function markQueueTerminalRoot(queues: DeepReadonly<QueuesState>, root: RunId): QueuesState {
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
      // A pre-settlement root can carry its own durable failure/cancellation
      // without a terminal Job receipt (or after that receipt aged out). Rank
      // that explicit Queue authority before every receipt-ordered root so it
      // compacts first; never invent an order for an unexplained success.
      if (record.failure === undefined && record.canceledAt === undefined) {
        throw new Error(`yrd: quiesced legacy Queue root '${record.id}' has no terminal journal order`)
      }
      terminalOrder[record.id] = 0
      continue
    }
    terminalOrder[record.id] = order
  }
  // A refusal streak only describes a PR that is still trying to get in. Drop
  // the entries for PRs that left the bay or reached a terminal delivery state
  // so the ledger cannot grow without bound (or outlive the wedge it names).
  const admissionRefusals = Object.fromEntries(
    Object.entries(queues.admissionRefusals).filter(([id]) => {
      const pr = bays.prs[id]
      if (pr === undefined) return false
      const delivery = prDeliveryState(pr)
      return delivery === "pushed" || delivery === "submitted"
    }),
  )
  return compactQueuesState(
    { ...queues, admissionRefusals, retention: { terminalOrder } },
    queueDecisionRoots(queues, bays),
  )
}

function queueDecisionRoots(queues: DeepReadonly<QueuesState>, bays: DeepReadonly<BaysState>): ReadonlySet<RunId> {
  const roots = new Set<RunId>()
  for (const record of Queues.values(queues)) {
    // A failed record carries its own terminal fact after Queue-owned Jobs
    // co-evict. Keep it only while that exact plan still governs admission.
    if (record.failure === undefined || record.stepSelection?.authority !== "admission" || record.prs.length !== 1) {
      continue
    }
    const snapshot = record.prs[0]
    if (snapshot === undefined) continue
    const pr = bays.prs[snapshot.id]
    const delivery = pr === undefined ? undefined : prDeliveryState(pr)
    if (pr === undefined || (delivery !== "pushed" && delivery !== "submitted") || !checksRequested(pr)) continue
    if (queueLookupKey(Queues.snapshot(pr), record.steps) !== queueLookupKey(snapshot, record.steps)) continue
    roots.add(queueRetentionRoot(queues, record.id))
  }
  return roots
}

/** The one production projection path for a started Queue run. */
export function projectQueueStarted(queues: DeepReadonly<QueuesState>, record: DeepReadonly<QueueRecord>): QueuesState {
  if (Queues.get(queues, record.id) !== undefined) throw new Error(`yrd: duplicate queue run '${record.id}'`)
  validateRunCandidateReceipt(queues, record)
  return {
    ...queues,
    records: Queues.set(queues.records, record),
    index: indexQueueStart(queues.index, record),
    authority: projectRunAuthority(queues.authority, record),
  }
}

function validateRunCandidateReceipt(queues: DeepReadonly<QueuesState>, record: DeepReadonly<QueueRecord>): void {
  const candidate = queues.candidates[record.candidateId]
  if (candidate === undefined) {
    throw new Error(`yrd: Queue run '${record.id}' names missing Candidate '${record.candidateId}'`)
  }
  const mismatch = (detail: string): never => {
    throw new Error(`yrd: Queue run '${record.id}' ${detail} Candidate '${candidate.id}'`)
  }
  const first = record.prs[0]
  if (first === undefined) {
    throw new Error(`yrd: Queue run '${record.id}' has no PR receipt for Candidate '${candidate.id}'`)
  }
  if (record.queueId !== candidate.queueId) mismatch(`queue '${record.queueId}' does not match`)
  if (queueIdentity(first) !== candidate.queueId) mismatch("snapshot queue does not match")
  if (baseIdentity(record.base) !== baseIdentity(first.base)) mismatch("queue target does not match")
  if (!sameFlow(record.flow, candidateFlow(record.prs))) mismatch("Flow receipt does not match")

  const baseSha = (() => {
    try {
      return requiredCandidateBaseSha(record.prs)
    } catch {
      return mismatch("has an invalid base-SHA receipt for")
    }
  })()
  if (baseSha !== candidate.baseSha) mismatch("base SHA does not match")
  if (
    candidate.revs.length !== record.prs.length ||
    candidate.revs.some((revision, index) => {
      const snapshot = record.prs[index]
      return (
        snapshot === undefined ||
        revision.pr !== snapshot.id ||
        revision.n !== snapshot.revision ||
        revision.head !== snapshot.headSha
      )
    })
  ) {
    mismatch("ordered PR revisions do not match")
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
        // A push or recut is the operator's answer to the refusal: the old streak
        // describes a revision that no longer exists, so it must not keep the
        // wedge finding alive against fresh content.
        ...clearAdmissionRefusals(state.queues, [token.pr]),
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
  if (applied.name === "pr/admission-recorded") {
    const recorded = PRAdmissionRecordedFactSchema.parse(applied.data)
    if (!currentAuthorityMatches(state.queues.authority, recorded)) return state
    const status: QueueAuthorityState["statuses"][string] =
      recorded.admission.status === "passed"
        ? "ready"
        : recorded.admission.kind === "refusal"
          ? "needs-author"
          : "submitted"
    const queues = {
      ...state.queues,
      authority: {
        ...state.queues.authority,
        statuses: { ...state.queues.authority.statuses, [recorded.pr]: status },
      },
    }
    return { queues: status === "ready" ? clearAdmissionRefusals(queues, [recorded.pr]) : queues }
  }
  if (applied.name === "pr/needs-author") {
    const needsAuthor = PRNeedsAuthorFactSchema.parse(applied.data)
    if (!currentAuthorityMatches(state.queues.authority, needsAuthor)) return state
    if (
      state.queues.authority.statuses[needsAuthor.pr] !== "submitted" &&
      state.queues.authority.statuses[needsAuthor.pr] !== "ready"
    ) {
      throw new Error(
        `yrd: queue authority for PR '${needsAuthor.pr}' is ${state.queues.authority.statuses[needsAuthor.pr] ?? "missing"}; '${applied.name}' requires submitted`,
      )
    }
    return {
      queues: {
        ...state.queues,
        authority: {
          ...state.queues.authority,
          statuses: { ...state.queues.authority.statuses, [needsAuthor.pr]: "needs-author" },
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
  if (applied.name === "pr/already-landed") {
    const alreadyLanded = PRAlreadyLandedSchema.parse(applied.data)
    if (!terminalAuthorityMatches(state.queues.authority, alreadyLanded, applied.name, true)) return state
    return {
      queues: {
        ...state.queues,
        authority: invalidatePRAuthority(state.queues.authority, alreadyLanded.pr, "already-landed"),
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
  if (applied.name === "queue/batch/isolated") {
    const isolated = BatchIsolatedSchema.parse(applied.data)
    return {
      queues: {
        ...state.queues,
        index: indexQueueChild(state.queues.index, isolated.parent, isolated.part, isolated.run),
      },
    }
  }
  if (applied.name === "queue/candidate/created") {
    const candidate = CandidateSchema.parse({ ...CandidateCreatedSchema.parse(applied.data), createdAt: applied.ts })
    const existing = state.queues.candidates[candidate.id]
    if (existing !== undefined) {
      throw new Error(`yrd: duplicate Candidate '${candidate.id}'`)
    }
    return {
      queues: {
        ...state.queues,
        candidates: { ...state.queues.candidates, [candidate.id]: candidate },
      },
    }
  }
  if (applied.name === "queue/run/started") {
    const started = ReplayQueueStartSchema.parse((applied.data as { run?: unknown }).run)
    if (Queues.get(state.queues, started.id) !== undefined) throw new Error(`yrd: duplicate queue run '${started.id}'`)
    const candidateId = started.candidateId ?? Queues.nextCandidateId(state.queues)
    const queueId = baseIdentity(started.queueId ?? started.base)
    // Pre-Candidate batch Runs carried each PR's last check base independently,
    // so one immutable Run could contain several base SHAs. Target-model replay
    // gives that synthetic Candidate the first ordered receipt as its stable
    // compatibility anchor and pins the projected snapshots to the same SHA.
    // Fresh Runs always carry candidateId and retain strict common-base checks.
    const legacyBaseSha =
      started.candidateId === undefined ? requiredCandidateBaseSha(started.prs.slice(0, 1)) : undefined
    const candidatePrs = legacyBaseSha === undefined ? started.prs : pinCandidateBaseSha(started.prs, legacyBaseSha)
    const legacyCandidate =
      legacyBaseSha === undefined
        ? undefined
        : CandidateSchema.parse({
            id: candidateId,
            queueId,
            baseSha: legacyBaseSha,
            revs: candidatePrs.map((pr) => ({ pr: pr.id, n: pr.revision, head: pr.headSha })),
            mergeability: "unknown",
            createdAt: applied.ts,
          })
    if (legacyCandidate === undefined && state.queues.candidates[candidateId] === undefined) {
      throw new Error(`yrd: queue run '${started.id}' names missing Candidate '${candidateId}'`)
    }
    const replayed = ReplayQueueRecordSchema.parse({
      ...started,
      queueId,
      candidateId,
      base: baseIdentity(started.base),
      prs: candidatePrs.map((pr) => ({ ...pr, base: baseIdentity(pr.base) })),
      startedAt: applied.ts,
    })
    const record: QueueRecord = { ...replayed, queueId, candidateId }
    const queues = {
      // Admission succeeded for every member PR, so their refusal streaks end
      // here — "consecutive refusals WITHOUT admission" is the whole claim.
      ...clearAdmissionRefusals(
        state.queues,
        record.prs.map(({ id }) => id),
      ),
      candidates:
        legacyCandidate === undefined
          ? state.queues.candidates
          : { ...state.queues.candidates, [legacyCandidate.id]: legacyCandidate },
    }
    return { queues: projectQueueStarted(queues, record) }
  }
  if (applied.name === "queue/run/settled") {
    return projectSettledQueueRun(state, applied)
  }
  if (applied.name === "queue/run/failed") {
    const failed = ReplayQueueFailedSchema.parse(applied.data)
    const record = Queues.get(state.queues, failed.run)
    if (record === undefined) throw new Error(`yrd: no queue run '${failed.run}'`)
    const releaseReason = queueAuthorityReleaseReason(failed.error)
    const failedRecord = {
      ...record,
      failure: {
        at: applied.ts,
        error: failed.error,
        ...(!("job" in failed) || failed.job === undefined ? {} : { job: failed.job }),
      },
    }
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
    const canceled = QueueRunCanceledFactSchema.parse(applied.data)
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
  if (applied.name === "queue/admission/refused") {
    const refusal = AdmissionRefusedFactSchema.parse(applied.data)
    const streak = state.queues.admissionRefusals[refusal.pr]
    const sameRevision =
      refusal.revision === undefined ||
      streak?.revision === undefined ||
      (streak.revision === refusal.revision && streak.headSha === refusal.headSha)
    const prior = sameRevision ? streak : undefined
    const sameCode = prior?.code === refusal.code
    return {
      queues: {
        ...state.queues,
        admissionRefusals: {
          ...state.queues.admissionRefusals,
          [refusal.pr]: {
            pr: refusal.pr,
            ...(refusal.revision === undefined
              ? prior?.revision === undefined
                ? {}
                : { revision: prior.revision, headSha: prior.headSha }
              : { revision: refusal.revision, headSha: refusal.headSha }),
            code: refusal.code,
            ...(refusal.kind === undefined ? {} : { kind: refusal.kind }),
            reason: refusal.reason,
            // The streak counts cycles, not codes: a wedge that flaps between
            // refusal codes is still one PR that never got in. The latest code
            // is what an operator needs to act on.
            count: (prior?.count ?? 0) + 1,
            sameCodeCount: sameCode ? (prior?.sameCodeCount ?? prior?.count ?? 0) + 1 : 1,
            firstAt: prior?.firstAt ?? applied.ts,
            sameCodeFirstAt: sameCode ? (prior?.sameCodeFirstAt ?? prior?.firstAt ?? applied.ts) : applied.ts,
            lastAt: applied.ts,
            ...(prior?.settlement === undefined ? {} : { settlement: prior.settlement }),
          },
        },
      },
    }
  }
  if (applied.name === "queue/admission/settled") {
    const settlement = SettleAdmissionRefusalSchema.parse(applied.data)
    const refusal = state.queues.admissionRefusals[settlement.pr]
    if (refusal === undefined) {
      throw new Error(`yrd: the settlement names merge request '${settlement.pr}', which has no failed check`)
    }
    if (
      refusal.revision !== undefined &&
      (refusal.revision !== settlement.revision || refusal.headSha !== settlement.headSha)
    ) {
      throw new Error(
        `yrd: the settlement for merge request '${settlement.pr}' does not match the revision that failed`,
      )
    }
    return {
      queues: {
        ...state.queues,
        admissionRefusals: {
          ...state.queues.admissionRefusals,
          [settlement.pr]: {
            ...refusal,
            revision: settlement.revision,
            headSha: settlement.headSha,
            settlement: {
              disposition: settlement.disposition,
              reason: settlement.reason,
              settledAt: applied.ts,
            },
          },
        },
      },
    }
  }
  return state
}

/** Drop the refusal streaks for PRs that just got in (or whose refused revision
 * was replaced). Exported semantics live in {@link QueueAdmissionRefusal}. */
function clearAdmissionRefusals(queues: DeepReadonly<QueuesState>, prs: readonly string[]): QueuesState {
  const dropped = new Set(prs.filter((pr) => queues.admissionRefusals[pr] !== undefined))
  if (dropped.size === 0) return queues as QueuesState
  return {
    ...(queues as QueuesState),
    admissionRefusals: Object.fromEntries(Object.entries(queues.admissionRefusals).filter(([pr]) => !dropped.has(pr))),
  }
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
    kind: step.kind,
    ...(step.classification === undefined ? {} : { classification: step.classification }),
    ...(step.implementationSource === undefined ? {} : { implementationSource: step.implementationSource }),
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
    if (step.kind !== "merge") continue
    if (integrated) throw new Error("yrd: merge step cannot run after the PR is already integrated")
    integrated = true
  }
}

function startRun(
  queues: DeepReadonly<QueuesState>,
  id: RunId,
  prs: readonly PRSnapshot[],
  baseSha: string,
  prepared: DeepReadonly<Omit<Candidate, "createdAt">> | undefined,
  selected: readonly RuntimeStep[],
  selection: StepSelection | undefined,
  shape: PRShape,
  integration?: IntegrationProof,
  lineage: Readonly<{ parent?: RunId; isolationPart?: 0 | 1 }> = {},
  reuse?: Readonly<{ run?: RunId; results: Readonly<Record<string, JsonValue>> }>,
): Readonly<{ run: QueueStart; events: readonly EventDraft[] }> {
  const pr = prs[0]
  if (pr === undefined) throw new Error("yrd: a queue run requires at least one PR")
  requiredCandidateBaseSha(prs)
  const flow = candidateFlow(prs)
  const queueId = queueIdentity(pr)
  const selectedCandidate = candidateFor(queues, prs, baseSha)
  const candidate =
    selectedCandidate ??
    CandidateCreatedSchema.parse({
      ...(prepared ?? {
        id: Queues.nextCandidateId(queues),
        queueId,
        baseSha,
        revs: prs.map((member) => ({ pr: member.id, n: member.revision, head: member.headSha })),
        mergeability: "unknown",
      }),
    })
  if (candidate.queueId !== queueId || candidate.baseSha !== baseSha) {
    throw new Error(`yrd: prepared Candidate '${candidate.id}' does not match queue '${queueId}' at ${baseSha}`)
  }
  if (
    candidate.revs.length !== prs.length ||
    candidate.revs.some((revision, index) => {
      const snapshot = prs[index]
      return (
        snapshot === undefined ||
        revision.pr !== snapshot.id ||
        revision.n !== snapshot.revision ||
        revision.head !== snapshot.headSha
      )
    })
  ) {
    throw new Error(`yrd: prepared Candidate '${candidate.id}' does not match its ordered PR revisions`)
  }
  const createdEvents = selectedCandidate === undefined ? [event("queue/candidate/created", candidate)] : []
  const run: QueueStart = {
    id,
    settlement: "explicit",
    queueId: candidate.queueId,
    candidateId: candidate.id,
    prs,
    base: baseIdentity(pr.base),
    ...(flow === undefined ? {} : { flow }),
    steps: selected.map(descriptor),
    ...(selection === undefined ? {} : { stepSelection: selection }),
    ...(integration === undefined ? {} : { initialIntegration: integration }),
    ...(reuse === undefined ? {} : { initialResults: reuse.results }),
    ...(reuse?.run === undefined ? {} : { reusedFrom: reuse.run }),
    ...lineage,
  }
  if (candidate.mergeability === "conflicting") {
    return {
      run,
      events: [
        ...createdEvents,
        event("queue/run/started", { run }),
        event("queue/run/failed", {
          run: run.id,
          prs: run.prs.map((pr) => ({ pr: pr.id, revision: pr.revision, headSha: pr.headSha })),
          error: {
            code: "candidate-conflicting",
            message: `Candidate '${candidate.id}' conflicts before Job execution`,
          },
        }),
      ],
    }
  }
  return {
    run,
    events: [
      ...createdEvents,
      event("queue/run/started", { run }),
      ...(selected[0] === undefined ? [] : [requestStep(selected[0], run, candidate, 0, shape)]),
    ],
  }
}

function pinCandidateBaseSha(prs: readonly DeepReadonly<PRSnapshot>[], baseSha: string): readonly PRSnapshot[] {
  return prs.map((pr) => PRSnapshotSchema.parse({ ...pr, baseSha }))
}

function requiredCandidateBaseSha(prs: readonly DeepReadonly<PRSnapshot>[]): string {
  const baseSha = prs[0]?.baseSha
  if (baseSha === undefined) {
    throw new Error("yrd: a Candidate requires the exact merge-queue base SHA")
  }
  if (prs.some((pr) => pr.baseSha !== baseSha)) {
    throw new Error("yrd: one Candidate cannot span merge-queue base SHAs")
  }
  return baseSha
}

function candidateArtifactKey(prs: readonly DeepReadonly<PRSnapshot>[], baseSha: string): string {
  return JSON.stringify([
    prs[0] === undefined ? "" : queueIdentity(prs[0]),
    baseSha,
    ...prs.map((pr) => [pr.headSha, pr.composition]),
  ])
}

function candidateReceiptKey(prs: readonly DeepReadonly<PRSnapshot>[], baseSha: string): string {
  return JSON.stringify([
    prs[0] === undefined ? "" : queueIdentity(prs[0]),
    baseSha,
    ...prs.map((pr) => [pr.id, pr.revision, pr.headSha, pr.composition]),
  ])
}

function sameFlow(left: DeepReadonly<PRSnapshot["flow"]>, right: DeepReadonly<PRSnapshot["flow"]>): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.name === right.name && left.rev === right.rev && left.fingerprint === right.fingerprint
}

function candidateFlow(prs: readonly DeepReadonly<PRSnapshot>[]): DeepReadonly<PRSnapshot["flow"]> {
  const flow = prs[0]?.flow
  if (prs.some((pr) => !sameFlow(pr.flow, flow))) {
    throw new Error("yrd: one Candidate cannot span Flow revisions")
  }
  return flow
}

function queueIdentity(pr: Pick<DeepReadonly<PRSnapshot>, "base" | "flow">): string {
  const base = baseIdentity(pr.base)
  return pr.flow === undefined ? base : `${pr.flow.name}/${base}`
}

function candidateFor(
  queues: DeepReadonly<QueuesState>,
  prs: readonly DeepReadonly<PRSnapshot>[],
  baseSha: string,
): DeepReadonly<Candidate> | undefined {
  const first = prs[0]
  if (first === undefined) return undefined
  const key = candidateReceiptKey(prs, baseSha)
  const records = Queues.values(queues)
  const record = records.find((run) => {
    const candidate = queues.candidates[run.candidateId]
    return (
      candidate !== undefined &&
      candidate.mergeability !== "unknown" &&
      candidateReceiptKey(run.prs, candidate.baseSha) === key
    )
  })
  if (record !== undefined) return queues.candidates[record.candidateId]
  return Object.values(queues.candidates).find(
    (candidate) =>
      candidate.mergeability !== "unknown" &&
      candidate.queueId === queueIdentity(first) &&
      candidate.baseSha === baseSha &&
      candidate.revs.length === prs.length &&
      candidate.revs.every((revision, index) => {
        const snapshot = prs[index]
        return (
          snapshot !== undefined &&
          revision.pr === snapshot.id &&
          revision.n === snapshot.revision &&
          revision.head === snapshot.headSha
        )
      }),
  )
}

/**
 * A pre-settlement (v1) Queue root that replay left non-terminal. Queue v2 adds
 * explicit live-root claims; historical v1 runs carry no settlement marker, so a
 * genuinely unfinished v1 root cannot be migrated losslessly by projection alone.
 * The migration ({@link Queue.quiesceLegacyRoots}) settles the abandoned ones and
 * refuses only while a previous writer still holds a live lease.
 */
type LegacyRootTarget = Readonly<{
  run: RunId
  /** Non-terminal jobs the migration must cancel so the run and its jobs are all terminal. */
  jobs: readonly DeepReadonly<Job>[]
  /** True when a still-unexpired writer lease is held at `now` (ms since epoch). */
  leased(now: number): boolean
}>

function legacyRootTargets(state: DeepReadonly<RuntimeState>): readonly LegacyRootTarget[] {
  return projectionLookupValues(state.queues.records)
    .flatMap((record) => {
      const target = legacyRootTargetForRecord(state, record)
      return target === undefined ? [] : [target]
    })
    .toSorted((left, right) => compareNatural(left.run, right.run))
}

function legacyRootTarget(state: DeepReadonly<RuntimeState>, run: RunId): LegacyRootTarget | undefined {
  const record = Queues.get(state.queues, run)
  return record === undefined ? undefined : legacyRootTargetForRecord(state, record)
}

function legacyRootTargetForRecord(
  state: DeepReadonly<RuntimeState>,
  record: DeepReadonly<QueueRecord>,
): LegacyRootTarget | undefined {
  if (record.parent !== undefined || record.settlement !== undefined) return undefined
  const run = materializeRun(record, state.jobs)
  if (legacyRunHasTerminalRevisions(state, run) || !needsSettlement(state, run)) return undefined
  const jobs = run.steps
    .map((step) => step.job)
    .filter((job): job is DeepReadonly<Job> => job !== undefined && !Job.terminal(job))
  return {
    run: run.id,
    jobs,
    leased: (now) => jobs.some((job) => job.status === "in_progress" && Date.parse(job.leaseExpiresAt) > now),
  }
}

/** A v1 failed Run settled by writing PR revision terminals instead of the
 * v3 queue/run/failed + explicit-settlement facts. Those terminals are replay
 * evidence that the old writer quiesced the root; applying v3's fresh failure
 * advancement rule to it would falsely classify completed history as live. */
function legacyRunHasTerminalRevisions(state: DeepReadonly<RuntimeState>, run: DeepReadonly<Run>): boolean {
  return (
    Queues.terminal(run) &&
    run.prs.every((snapshot) =>
      state.bays.prs[snapshot.id]?.revs.some(
        (revision) =>
          revision.n === snapshot.revision && revision.head === snapshot.headSha && revision.terminal !== undefined,
      ),
    )
  )
}

function requestStep(
  step: RuntimeStep,
  run: Pick<QueueStart, "id" | "prs">,
  candidate: DeepReadonly<Candidate> | DeepReadonly<Omit<Candidate, "createdAt">>,
  index: number,
  shape: PRShape,
) {
  const { createdAt: _createdAt, ...candidateFacts } = candidate as DeepReadonly<Candidate>
  return step.job.request(
    {
      run: run.id,
      step: step.name,
      index,
      prs: run.prs,
      candidate: CandidateCreatedSchema.parse(candidateFacts),
      shape,
    },
    { key: jobKey(run.id, index) },
  )
}

function advanceQueue(
  state: DeepReadonly<RuntimeState>,
  record: DeepReadonly<QueueRecord>,
  steps: ReadonlyMap<string, RuntimeStep>,
  flows?: YrdConfig,
): Readonly<{ events: readonly EventDraft[] }> {
  assertCurrentFlow(record.flow, flows)
  if (activeQueueFailure(record, state.jobs) !== undefined) return { events: [] }
  // A run-canceled record is terminal: never emit pr/canceled or pr/rejected for
  // its members. Their status is untouched (still submitted), so a future drain
  // re-queues them — cancel is a re-queue, not a rejection.
  if (record.canceledAt !== undefined) return { events: [] }
  const stale = pinnedPRError(state, record.prs, record.id)
  if (stale !== undefined) {
    return { events: [queueFailedEvent(state, record, stale)] }
  }

  const jobs = queueJobs(record, state.jobs)
  const index = jobs.length - 1
  const job = jobs[index]
  if (job === undefined) return { events: [] }
  const planned = record.steps[index]
  if (planned === undefined) throw new Error(`yrd: queue run '${record.id}' lost step ${index}`)
  if (job.status === "queued") {
    const drift = plannedStepDrift(steps, planned)
    return {
      events:
        drift === undefined ? [] : [queueFailedEvent(state, record, { code: "stale-steps", message: `yrd: ${drift}` })],
    }
  }
  if (job.status === "in_progress" || job.status === "waiting") return { events: [] }
  if (!jobSucceeded(job)) {
    const before = shapeThrough(record, state.jobs, index)
    if (job.conclusion === "cancelled") {
      const canceledPr = record.prs.length === 1 ? record.prs[0] : undefined
      return {
        events: isIntegrated(before)
          ? []
          : [
              event("queue/run/canceled", {
                run: record.id,
                by: job.canceledBy,
                reason: job.cancelReason,
                ...(canceledPr === undefined
                  ? {}
                  : {
                      pr: canceledPr.id,
                      revision: canceledPr.revision,
                      headSha: canceledPr.headSha,
                    }),
              }),
            ],
      }
    }

    const failure = jobFailure(job)
    if (queueAuthorityReleaseReason(failure) !== undefined) {
      return { events: [queueFailedEvent(state, record, failure)] }
    }
    const failed = queueFailedEvent(state, record, failure, job)
    const pr = record.prs.length === 1 ? record.prs[0] : undefined
    const intent = pr?.intent
    if (intent !== undefined && planned.kind === "check" && !isIntegrated(before)) {
      const priorFailures = intentCheckFailures(state, intent.id, record.id)
      if (priorFailures >= AUTOMATIC_INTENT_CHECK_RETRIES) {
        const candidate = state.queues.candidates[record.candidateId]
        if (candidate?.sha === undefined) {
          throw new Error(`yrd: failed intent Candidate '${record.candidateId}' carries no synthesized commit`)
        }
        const attempts = priorFailures + 1
        return {
          events: [
            failed,
            event(
              "intent/evaluation-recorded",
              PinIntentEvaluationFactSchema.parse({
                intent: intent.id,
                baseSha: candidate.baseSha,
                outcome: "refused",
                refusal: {
                  code: "intent-checks-failed",
                  message: `Intent '${intent.id}' synthesized candidate failed '${planned.name}' after ${attempts} attempts: ${failure.message}`,
                  evidence: {
                    component: intent.authored.component,
                    target: intent.evaluated.target,
                    currentPin: intent.evaluated.priorPin,
                    candidate: candidate.sha,
                    run: record.id,
                    step: planned.name,
                    attempts,
                  },
                  remedy: [
                    { argv: ["yrd", "intent", "show", intent.id] },
                    {
                      argv: [
                        "yrd",
                        "intent",
                        "submit",
                        "--component",
                        intent.authored.component,
                        "--target",
                        intent.evaluated.target,
                        "--issue",
                        intent.authored.issue.id,
                      ],
                      note: "Fix the failing root or component change before resubmitting.",
                    },
                  ],
                },
              }),
            ),
          ],
        }
      }
    }
    const current = pr === undefined ? undefined : state.bays.prs[pr.id]
    const revision =
      pr === undefined
        ? undefined
        : current?.revs.find((candidate) => candidate.n === pr.revision && candidate.head === pr.headSha)
    const evidence =
      (job.conclusion === "failure" ? firstArtifact(job.error.evidence, "stderr") : undefined) ??
      firstArtifact(checkEvidence(job), "stderr") ??
      ("artifacts" in job ? firstArtifact({ artifacts: job.artifacts }, "stderr") : undefined)
    const authorReceipt = needsAuthorJobReceipt(job)
    if (
      authorReceipt === undefined ||
      isIntegrated(before) ||
      pr === undefined ||
      current === undefined ||
      (prDeliveryState(current) !== "submitted" && prDeliveryState(current) !== "ready")
    ) {
      return { events: [failed] }
    }
    const refusal = {
      pr: pr.id,
      revision: pr.revision,
      headSha: pr.headSha,
      run: record.id,
      ...(current.issue === undefined ? {} : { issueRef: current.issue }),
      ...(prCorrelation(current) === undefined ? {} : { correlation: prCorrelation(current) }),
      ...(revision?.submitter === undefined ? {} : { submitter: revision.submitter }),
      step: planned.name,
      ...(evidence === undefined ? {} : { evidence }),
      detail: failure.message,
    }
    return {
      events: [failed, event("pr/needs-author", { ...refusal, receipt: authorReceipt })],
    }
  }

  const shape = shapeThrough(record, state.jobs, index + 1)
  const events: EventDraft[] = []
  if (planned.kind === "merge") {
    if (!isIntegrated(shape)) throw new Error(`yrd: merge step '${planned.name}' produced no integration proof`)
    for (const snapshot of record.prs.filter((member) => member.intent !== undefined)) {
      const intent = snapshot.intent
      if (intent === undefined) continue
      const currentIntent = state.intents?.records[intent.id]
      if (
        currentIntent?.status === "integrated" &&
        currentIntent.integration?.landing.run === record.id &&
        currentIntent.integration.landing.commit === shape.integration.commit
      ) {
        continue
      }
      const candidate = state.queues.candidates[record.candidateId]
      if (candidate === undefined) {
        throw new Error(`yrd: intent run '${record.id}' names missing Candidate '${record.candidateId}'`)
      }
      if (candidate.treeSha === undefined) {
        throw new Error(`yrd: intent Candidate '${candidate.id}' carries no checked tree identity`)
      }
      events.push(
        event("intent/integrated", {
          intent: intent.id,
          authored: intent.authored,
          evaluated: intent.evaluated,
          landing: {
            candidate: candidate.id,
            run: record.id,
            baseSha: candidate.baseSha,
            commit: shape.integration.commit,
            treeSha: candidate.treeSha,
            componentPin: intent.evaluated.target,
          },
        }),
      )
    }
    const prSnapshots = record.prs.filter((member) => member.intent === undefined)
    for (const current of samePayloadPRs(state.bays, prSnapshots)) {
      const alreadyLanded = shape.integration.alreadyLanded
      if (alreadyLanded !== undefined) {
        const existingEvidence = current.alreadyLanded
        if (
          prDeliveryState(current) === "already-landed" &&
          current.integration?.commit === shape.integration.commit &&
          current.integration?.baseSha === shape.integration.baseSha &&
          existingEvidence?.candidateSha === alreadyLanded.candidateSha &&
          existingEvidence.candidateTreeSha === alreadyLanded.candidateTreeSha &&
          existingEvidence.baseTreeSha === alreadyLanded.baseTreeSha
        ) {
          continue
        }
        const revision = currentPRRev(current)
        events.push(
          event("pr/already-landed", {
            pr: current.id,
            revision: revision.n,
            headSha: revision.head,
            run: record.id,
            ...(current.issue === undefined ? {} : { issueRef: current.issue }),
            baseSha: shape.integration.baseSha,
            candidateSha: alreadyLanded.candidateSha,
            candidateTreeSha: alreadyLanded.candidateTreeSha,
            baseTreeSha: alreadyLanded.baseTreeSha,
            ...(prCorrelation(current) === undefined ? {} : { correlation: prCorrelation(current) }),
            ...(revision?.submitter === undefined ? {} : { submitter: revision.submitter }),
          }),
        )
        continue
      }
      if (
        current.merged &&
        current.integration?.commit === shape.integration.commit &&
        current.integration?.baseSha === shape.integration.baseSha
      ) {
        continue
      }
      const revision = currentPRRev(current)
      events.push(
        event("pr/integrated", {
          pr: current.id,
          revision: revision.n,
          headSha: revision.head,
          run: record.id,
          ...(current.issue === undefined ? {} : { issueRef: current.issue }),
          commit: shape.integration.commit,
          landingSha: shape.integration.commit,
          baseSha: shape.integration.baseSha,
          ...(revision.correlation === undefined ? {} : { correlation: revision.correlation }),
          ...(revision?.submitter === undefined ? {} : { submitter: revision.submitter }),
        }),
      )
    }
  }

  const next = record.steps[index + 1]
  if (next !== undefined) {
    const drift = plannedStepDrift(steps, next)
    if (drift !== undefined && !isIntegrated(shape)) {
      return {
        events: [queueFailedEvent(state, record, { code: "stale-steps", message: `yrd: ${drift}` })],
      }
    }
    const candidate = state.queues.candidates[record.candidateId]
    if (candidate === undefined) {
      throw new Error(`yrd: queue run '${record.id}' names missing Candidate '${record.candidateId}'`)
    }
    events.push(requestStep(requirePlannedStep(steps, next), record, candidate, index + 1, shape))
  }
  return { events }
}

function assertCurrentFlow(flow: DeepReadonly<FlowPin> | undefined, config: YrdConfig | undefined): void {
  if (flow === undefined || config === undefined) return
  const refusal = diagnoseFlowPin(flow, config).find((diagnostic) => diagnostic.severity === "refusal")
  if (refusal !== undefined) raiseFailure("refusal", refusal.code, refusal.message)
}

function samePayloadPRs(
  state: DeepReadonly<BaysState>,
  snapshots: readonly DeepReadonly<PRSnapshot>[],
): readonly DeepReadonly<PR>[] {
  const payloads = new Set(snapshots.map(payloadIdentity))
  return Object.values(state.prs).filter(
    (pr) =>
      prDeliveryState(pr) !== "withdrawn" && prDeliveryState(pr) !== "canceled" && payloads.has(payloadIdentity(pr)),
  )
}

function payloadIdentity(pr: DeepReadonly<PR> | DeepReadonly<PRSnapshot>): string {
  if ("revs" in pr) {
    return `${baseIdentity(pr.base)}\0${prHead(pr)}\0${JSON.stringify(prComposition(pr))}`
  }
  return `${baseIdentity(pr.base)}\0${pr.headSha}\0${JSON.stringify(pr.composition)}`
}

function queueLifecycleRun(applied: Event): RunId | undefined {
  if (applied.name === "queue/run/started") {
    return ReplayQueueStartSchema.parse((applied.data as { run?: unknown }).run).id
  }
  if (applied.name === "queue/run/failed") return ReplayQueueFailedSchema.parse(applied.data).run
  if (applied.name === "queue/run/canceled") return QueueRunCanceledFactSchema.parse(applied.data).run
  if (applied.name === "queue/run/settled") return SettledEventSchema.parse(applied.data).run
  return undefined
}

function materializeArchivedRun(
  history: JournalHistory<unknown>,
  jobs: HasJobs["jobs"],
  live: DeepReadonly<QueuesState>,
  id: RunId,
): Run | undefined {
  const entries = new Map<number, unknown>()
  const runs = new Set<RunId>()
  const visiting = new Set<RunId>()
  const visit = (runId: RunId): boolean => {
    if (runs.has(runId)) return true
    if (visiting.has(runId)) throw new Error(`yrd: archived queue ancestry for '${id}' is cyclic`)
    visiting.add(runId)
    const slice = history.entity("queue", runId)
    if (slice.length === 0) {
      visiting.delete(runId)
      return false
    }
    let parent: RunId | undefined
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

function materializeRun(record: DeepReadonly<QueueRecord>, jobs: DeepReadonly<JobsState>): Run {
  const jobList = queueJobs(record, jobs)
  const steps = record.steps.map(
    (step, index): QueueStep => ({
      ...step,
      ...(jobList[index] === undefined ? {} : { job: jobList[index] }),
    }),
  )
  const cursor = steps.findIndex((step) => step.job === undefined || !Job.terminal(step.job))
  const failed = steps.find((step) => step.job !== undefined && jobFailed(step.job))?.job
  const waiting = steps.some((step) => step.job?.status === "waiting")
  const passed =
    record.passedAt !== undefined || steps.every((step) => step.job !== undefined && jobSucceeded(step.job))
  const started = steps.some((step) => step.job !== undefined && step.job.status !== "queued")
  const projectedFailure = activeQueueFailure(record, jobs)
  const status =
    record.canceledAt !== undefined
      ? "completed"
      : projectedFailure !== undefined
        ? "completed"
        : failed !== undefined
          ? "completed"
          : waiting
            ? "waiting"
            : passed
              ? "completed"
              : started
                ? "in_progress"
                : "queued"
  const conclusion: RunConclusion | undefined =
    record.canceledAt !== undefined
      ? "cancelled"
      : projectedFailure !== undefined
        ? "failure"
        : failed === undefined
          ? passed
            ? "success"
            : undefined
          : failed.status !== "completed"
            ? "failure"
            : failed.conclusion === "cancelled"
              ? "cancelled"
              : failed.conclusion === "timed_out"
                ? "timed_out"
                : failed.conclusion === "skipped"
                  ? "skipped"
                  : "failure"
  const last = steps.at(-1)?.job
  const finishedAt =
    record.canceledAt ??
    projectedFailure?.at ??
    (failed?.status === "completed"
      ? failed.finishedAt
      : status === "completed"
        ? last?.status === "completed"
          ? last.finishedAt
          : (record.passedAt ?? record.startedAt)
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
    ...(conclusion === undefined ? {} : { conclusion }),
    jobs: jobList.map((job) => job.id),
    steps,
    shape,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(projectedFailure === undefined
      ? failed === undefined
        ? {}
        : { error: jobFailure(failed) }
      : { error: projectedFailure.error }),
  }
}

function activeQueueFailure(
  record: DeepReadonly<Pick<QueueRecord, "failure">>,
  jobs: DeepReadonly<JobsState>,
): DeepReadonly<QueueFailure> | undefined {
  const failure = record.failure
  if (failure?.job === undefined) return failure
  const current = jobs.byId[failure.job.id]
  if (current === undefined) return failure
  return current.attempt > failure.job.attempt || !jobFailed(current) ? undefined : failure
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

function jobKey(run: RunId, index: number): string {
  return `queue:${run}:${index}`
}

function admissionExecutionId(pr: DeepReadonly<PRSnapshot>, baseSha: string): string {
  return `${admissionRevisionKeyPrefix(pr.id, pr.revision)}${baseSha}`
}

function admissionRevisionKeyPrefix(pr: string, revision: number): string {
  return `admission:${pr}:${revision}:`
}

function admissionJobKey(pr: DeepReadonly<PRSnapshot>, baseSha: string, index: number, stepRevision?: string): string {
  const prefix = `${admissionExecutionId(pr, baseSha)}:${index}`
  return stepRevision === undefined ? prefix : `${prefix}:${stepRevision}`
}

function shapeThrough(
  record: DeepReadonly<QueueRecord>,
  jobs: DeepReadonly<JobsState>,
  limit = record.steps.length,
): PRShape {
  const hasMerge = record.steps.some((step) => step.kind === "merge")
  let shape: PRShape | IntegratedShape = {
    results: { ...record.initialResults },
    ...(record.initialIntegration === undefined || hasMerge ? {} : { integration: record.initialIntegration }),
  }
  const jobList = queueJobs(record, jobs)
  for (let index = 0; index < Math.min(limit, record.steps.length); index += 1) {
    const planned = record.steps[index]
    const job = jobList[index]
    if (planned === undefined || job === undefined || !jobSucceeded(job)) break
    shape =
      planned.kind === "merge"
        ? { ...shape, integration: IntegrationProofSchema.parse(job.output) }
        : { ...shape, results: { ...shape.results, [planned.name]: job.output } }
  }
  return shape
}

function orderedQueues(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>): Run[] {
  return Queues.values(queues)
    .map((record) => materializeRun(record, jobs))
    .toSorted((left, right) => compareNatural(left.id, right.id))
}

function runningQueue(
  queues: DeepReadonly<QueuesState>,
  jobs: DeepReadonly<JobsState>,
  base: string,
  except?: RunId,
): Run | undefined {
  const identity = baseIdentity(base)
  return activeQueueRuns(queues, jobs).find(
    (run) =>
      run.id !== except &&
      baseIdentity(run.base) === identity &&
      (run.status === "queued" || run.status === "in_progress"),
  )
}

function childQueue(
  queues: DeepReadonly<QueuesState>,
  jobs: DeepReadonly<JobsState>,
  parent: RunId,
  part: 0 | 1,
): Run | undefined {
  const id = childRunId(queues.index, parent, part)
  const record = id === undefined ? undefined : Queues.get(queues, id)
  return record === undefined ? undefined : materializeRun(record, jobs)
}

function queueTree(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>, root: RunId): Run[] {
  const result: Run[] = []
  const visit = (id: RunId): void => {
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

function activeQueueRuns(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>): Run[] {
  return activeQueueRootIds(queues.authority).flatMap((root) => queueTree(queues, jobs, root))
}

function queueSummary(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>, base: string): QueueSummary {
  const identity = baseIdentity(base)
  const runs = orderedQueues(queues, jobs).filter((run) => baseIdentity(run.base) === identity)
  return {
    base: identity,
    running: runs.filter((run) => run.status === "queued" || run.status === "in_progress"),
    waiting: runs.filter((run) => run.status === "waiting"),
    finished: runs.filter(Queues.terminal),
    ...(queues.pauses[identity] === undefined ? {} : { pause: queues.pauses[identity] }),
  }
}

const QUEUE_JOB_KEY_PATTERN = /^queue:(.+):\d+$/u

type OrphanedRequestedJob = Readonly<{
  job: DeepReadonly<JobsState>["byId"][string]
  run: RunId
  reason: "run-absent" | "run-terminal"
}>

/**
 * Requested queue Jobs whose parent run is terminal or absent — a strand a state
 * upgrade, or a settled/canceled run that never terminalized its pending Job,
 * left behind. A NON-terminal run's requested current-step Job is normal
 * in-flight work and is never an orphan. This walks {@link JobsState} directly:
 * {@link auditQueues}'s record walk skips terminal runs, so this class is exactly
 * the audit blind spot that let "queue audit clean" print over poison.
 */
function orphanedRequestedQueueJobs(state: DeepReadonly<RuntimeState>): readonly OrphanedRequestedJob[] {
  const orphans: OrphanedRequestedJob[] = []
  for (const job of Object.values(state.jobs.byId)) {
    if (job.status !== "queued" || job.key === undefined) continue
    const run = QUEUE_JOB_KEY_PATTERN.exec(job.key)?.[1]
    if (run === undefined) continue
    const record = Queues.get(state.queues, run)
    if (record === undefined) {
      orphans.push({ job, run, reason: "run-absent" })
      continue
    }
    if (Queues.terminal(materializeRun(record, state.jobs))) {
      orphans.push({ job, run, reason: "run-terminal" })
    }
  }
  return orphans
}

type UnisolableStalePlanBatch = Readonly<{ run: RunId; drift: string }>

/**
 * FAILED bisectable batches whose recorded plan drifted from the installed
 * catalog. Isolation re-plans every parent step, so such a batch can never
 * bisect — {@link needsSettlement} keeps it alive and every compose cycle re-tries
 * (and re-refuses) isolation forever. This is the isolate-path sibling of the
 * advance-path stale-steps drift. Already-retired batches carry a release reason,
 * which flips {@link bisectable} false, so they self-exclude here — the detection
 * clears once retired (audit stops lying).
 */
/** A run whose cursor step has no Job and that no writer can still be starting.
 *
 * A Job is requested in the SAME event batch as the transition that entitles it
 * (`startRun` emits `queue/run/started` + the step-0 request; `advanceQueue`
 * emits the next request with the previous step's terminal projection), so the
 * only legitimate joblessness at the cursor is the window between a Job
 * finishing and the next `advance` — seconds under a live runner. Past
 * {@link ORPHANED_RUN_GRACE_MS} the writer is gone, and the run can NEVER settle
 * on its own: `advanceQueue` returns no events when the cursor has no Job, and
 * `jobs.recover()` iterates Jobs, so it has nothing to reclaim. That is the
 * permanent phantom `● run` (live incident: R1582, 45h and counting).
 */
const ORPHANED_RUN_GRACE_MS = 15 * 60_000

type OrphanedRun = Readonly<{ run: RunId; step: StepName; since: string }>

/** The last instant this run is known to have been driven: the newest terminal
 * step Job before the cursor, else the run's start. Anchoring on `startedAt`
 * alone would settle a long-lived multi-step run that just advanced. */
function lastDriven(record: DeepReadonly<QueueRecord>, run: Run): string {
  let latest = record.startedAt
  for (const step of run.steps.slice(0, run.cursor)) {
    const job = step.job
    const finishedAt = job?.status === "completed" ? job.finishedAt : undefined
    if (finishedAt !== undefined && Date.parse(finishedAt) > Date.parse(latest)) latest = finishedAt
  }
  return latest
}

function orphanedJoblessRuns(state: DeepReadonly<RuntimeState>, recoveryTime: string): readonly OrphanedRun[] {
  const cutoff = Date.parse(recoveryTime) - ORPHANED_RUN_GRACE_MS
  const orphans: OrphanedRun[] = []
  for (const record of Queues.values(state.queues)) {
    const run = materializeRun(record, state.jobs)
    if (Queues.terminal(run)) continue
    const step = run.steps[run.cursor]
    if (step === undefined || step.job !== undefined) continue
    const since = lastDriven(record, run)
    if (Date.parse(since) > cutoff) continue
    orphans.push({ run: record.id, step: step.name, since })
  }
  return orphans
}

function unisolableStalePlanBatches(
  state: DeepReadonly<RuntimeState>,
  byName: ReadonlyMap<string, RuntimeStep>,
): readonly UnisolableStalePlanBatch[] {
  const batches: UnisolableStalePlanBatch[] = []
  for (const record of Queues.values(state.queues)) {
    const run = materializeRun(record, state.jobs)
    if (!bisectable(run)) continue
    const drift = recordedPlanDrift(run.steps, byName)
    if (drift !== undefined) batches.push({ run: record.id, drift })
  }
  return batches
}

type CandidateRevisionMismatch = Readonly<{
  candidate: string
  run: RunId
  pr: string
  recordedRevision: number
  recordedHead: string
  currentRevision: number
  currentHead: string
}>

/**
 * Content-equivalent historical Candidates are valid artifacts, but they are
 * not authority for a newer PR revision. Surface the exact state that used to
 * make {@link candidateFor} select the old Candidate and then make
 * {@link startRun} refuse its immutable receipt. Once an exact current receipt
 * exists, the old Candidate is ordinary history and the finding clears.
 */
function candidateRevisionMismatches(state: DeepReadonly<RuntimeState>): readonly CandidateRevisionMismatch[] {
  const mismatches: CandidateRevisionMismatch[] = []
  const seen = new Set<string>()
  for (const record of Queues.values(state.queues)) {
    const candidate = state.queues.candidates[record.candidateId]
    if (candidate === undefined || candidate.mergeability === "unknown") continue
    const current: PRSnapshot[] = []
    let live = true
    for (const snapshot of record.prs) {
      const pr = state.bays.prs[snapshot.id]
      const delivery = pr === undefined ? undefined : prDeliveryState(pr)
      if (pr === undefined || (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready")) {
        live = false
        break
      }
      current.push(Queues.snapshot(pr))
    }
    if (!live) continue
    const currentBaseSha = current[0]?.baseSha
    if (currentBaseSha === undefined || current.some((snapshot) => snapshot.baseSha !== currentBaseSha)) continue
    if (candidateArtifactKey(record.prs, candidate.baseSha) !== candidateArtifactKey(current, currentBaseSha)) continue
    if (candidateReceiptKey(record.prs, candidate.baseSha) === candidateReceiptKey(current, currentBaseSha)) continue
    if (candidateFor(state.queues, current, currentBaseSha) !== undefined) continue
    const mismatchIndex = candidate.revs.findIndex((revision, index) => {
      const snapshot = current[index]
      return (
        snapshot === undefined ||
        revision.pr !== snapshot.id ||
        revision.n !== snapshot.revision ||
        revision.head !== snapshot.headSha
      )
    })
    const recorded = candidate.revs[mismatchIndex]
    const latest = current[mismatchIndex]
    if (recorded === undefined || latest === undefined) continue
    const key = candidateReceiptKey(current, currentBaseSha)
    if (seen.has(key)) continue
    seen.add(key)
    mismatches.push({
      candidate: candidate.id,
      run: record.id,
      pr: latest.id,
      recordedRevision: recorded.n,
      recordedHead: recorded.head,
      currentRevision: latest.revision,
      currentHead: latest.headSha,
    })
  }
  return mismatches
}

function auditQueues(
  state: DeepReadonly<RuntimeState>,
  steps: readonly RuntimeStep[],
  progress: QueueProgressPolicy,
  options: QueueAuditOptions,
): QueueAuditResult {
  const findings: QueueAuditFinding[] = []
  const installed = new Map(steps.map((step) => [step.name, step]))
  for (const record of Queues.values(state.queues)) {
    for (const pr of record.prs) {
      if (pr.intent !== undefined || state.bays.prs[pr.id] !== undefined) continue
      findings.push({
        code: "missing-pr",
        message: `queue run '${record.id}' references missing PR '${pr.id}'`,
        run: record.id,
        pr: pr.id,
      })
    }
    const authority = projectionLookupGet(state.queues.authority.runs, record.id)
    if (record.parent === undefined && authority !== undefined) {
      const intentMembers = new Set(record.prs.filter((pr) => pr.intent !== undefined).map((pr) => pr.id))
      for (const pr of authority.missingSubmits) {
        if (intentMembers.has(pr)) continue
        findings.push({
          code: "run-without-submit-ancestry",
          message: `queue run '${record.id}' started PR '${pr}' without an unconsumed matching submit fact`,
          run: record.id,
          pr,
        })
      }
      for (const pr of authority.missingChecks) {
        if (intentMembers.has(pr)) continue
        findings.push({
          code: "run-without-check-ancestry",
          message: `queue run '${record.id}' started pushed PR '${pr}' without an unconsumed matching checks fact`,
          run: record.id,
          pr,
        })
      }
    }
    let run: Run
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
    // Step 0's Job is requested in the same event batch as `queue/run/started`,
    // so a non-terminal run with NO Job at all never started and never can:
    // `advance` no-ops without a Job. Unambiguous — unlike a later cursor step,
    // this cannot be the brief window between a Job finishing and the next
    // advance, so flag it with no clock. `recover` settles it.
    if (run.steps.every((step) => step.job === undefined)) {
      findings.push({
        code: "orphaned-run",
        message: `queue run '${record.id}' is ${run.status} with no job for any step; it can never advance`,
        run: record.id,
        ...(record.steps[0] === undefined ? {} : { step: record.steps[0].name }),
      })
    }
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
  for (const mismatch of candidateRevisionMismatches(state)) {
    findings.push({
      code: "candidate-revision-mismatch",
      message:
        `Candidate '${mismatch.candidate}' from queue run '${mismatch.run}' records PR '${mismatch.pr}' ` +
        `revision ${mismatch.recordedRevision}@${mismatch.recordedHead}, but the content-equivalent current receipt is ` +
        `revision ${mismatch.currentRevision}@${mismatch.currentHead}; no exact current-revision Candidate exists`,
      run: mismatch.run,
      pr: mismatch.pr,
    })
  }
  // The record walk above `continue`s past terminal runs and never inspects Jobs
  // whose run record is gone — so a requested Job stranded under a terminal or
  // absent run was invisible ("queue audit clean" printed over it). Surface it.
  for (const orphan of orphanedRequestedQueueJobs(state)) {
    findings.push({
      code: "orphaned-requested-job",
      message: `requested job '${orphan.job.id}' (${orphan.job.key}) is stranded: its parent queue run '${orphan.run}' is ${orphan.reason === "run-absent" ? "absent" : "terminal"}`,
      run: orphan.run,
    })
  }
  // A FAILED batch is terminal, so the record walk above skipped its step drift.
  // An un-isolable stale-plan batch would otherwise re-refuse isolation every
  // cycle unseen — surface it so "audit clean" stops lying about a live zombie.
  for (const batch of unisolableStalePlanBatches(state, installed)) {
    findings.push({
      code: "unisolable-stale-plan",
      message: `failed batch '${batch.run}' can never isolate under the installed catalog: ${batch.drift}`,
      run: batch.run,
    })
  }
  // Every code above walks RUN RECORDS. A PR refused during required checks
  // never becomes one, so a head-of-line refusal loop was structurally invisible
  // here: `queue audit` reported `findings: []` through a 5h46m block while each
  // cycle logged a loggily-only `compose-candidate-skip`. The refusal ledger is
  // the durable trace of exactly that, so read it (22395).
  const queued = admissionQueue(state, steps)
  const refusalFindings = admissionRefusalAuditFindings(state, queued, progress)
  findings.push(...refusalFindings)
  findings.push(
    ...queueProgressAuditFindings(state, queueProgressQueue(state, steps), refusalFindings, progress, options),
  )
  return { findings }
}

/** Fixed non-ancestral gitlink commits cannot become ancestral on a later retry. */
const STRUCTURALLY_PERMANENT_ADMISSION_REFUSALS = new Set(["recut-gitlink-conflict"])

function admissionRefusalAuditFindings(
  state: DeepReadonly<RuntimeState>,
  queued: readonly DeepReadonly<PR>[],
  progress: QueueProgressPolicy,
): QueueAuditFinding[] {
  const findings: QueueAuditFinding[] = []
  const refused = Object.entries(state.queues.admissionRefusals).flatMap(([id, refusal]) => {
    if (refusal.settlement !== undefined) return []
    const pr = state.bays.prs[id]
    return pr === undefined ? [] : [pr]
  })
  const head = [...new Map([...queued, ...refused].map((pr) => [pr.id, pr])).values()].toSorted(
    (left, right) => checkQueueTime(left).localeCompare(checkQueueTime(right)) || compareNatural(left.id, right.id),
  )[0]
  for (const refusal of Object.values(state.queues.admissionRefusals).toSorted((left, right) =>
    compareNatural(left.pr, right.pr),
  )) {
    const sameCodeCount = refusal.sameCodeCount ?? refusal.count
    const sameCodeFirstAt = refusal.sameCodeFirstAt ?? refusal.firstAt
    if (refusal.settlement !== undefined || head?.id !== refusal.pr) continue
    const threshold = STRUCTURALLY_PERMANENT_ADMISSION_REFUSALS.has(refusal.code) ? 1 : progress.refusalCount
    if (sameCodeCount < threshold) continue
    const blockedMs = Math.max(0, Date.parse(refusal.lastAt) - Date.parse(sameCodeFirstAt))
    findings.push({
      code: "admission-refusal-loop",
      message:
        `merge request '${refusal.pr}' at the head of the required-check queue failed its entry checks ` +
        `${sameCodeCount} consecutive times ` +
        `over ${formatRefusalSpan(blockedMs)} (since ${sameCodeFirstAt}) without ever completing required checks; ` +
        `latest failure '${refusal.code}': ${refusal.reason}`,
      pr: refusal.pr,
      specimen: `pr:${refusal.pr}:refusal:${refusal.code}`,
      refusal: refusal.code,
      count: sameCodeCount,
      since: sameCodeFirstAt,
      blockedMs,
    })
  }
  return findings
}

function queueProgressAuditFindings(
  state: DeepReadonly<RuntimeState>,
  queued: readonly DeepReadonly<PR>[],
  refusalFindings: readonly QueueAuditFinding[],
  progress: QueueProgressPolicy,
  options: QueueAuditOptions,
): QueueAuditFinding[] {
  if (options.now === undefined || queued.length === 0) return []
  const findings: QueueAuditFinding[] = []
  const nowMs = parseAuditTime(options.now, "now")
  const byBase = Map.groupBy(queued, (pr) => baseIdentity(pr.base))
  for (const [base, prs] of [...byBase.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const queuedAtMs = Math.min(...prs.map((pr) => parseAuditTime(checkQueueTime(pr), `queue time for ${pr.id}`)))
    const latestLandingMs = latestQueueLandingMs(state, base)
    const sinceMs = Math.max(queuedAtMs, latestLandingMs ?? queuedAtMs)
    const blockedMs = Math.max(0, nowMs - sinceMs)
    const first = prs[0]
    if (
      blockedMs < progress.noLandingMs ||
      first === undefined ||
      refusalFindings.some((finding) => finding.pr === first.id)
    ) {
      continue
    }
    const since = new Date(sinceMs).toISOString()
    findings.push({
      code: "queue-progress-stalled",
      message:
        `Queue '${base}' has ${prs.length} required-check ${prs.length === 1 ? "PR" : "PRs"} queued and ` +
        `no landing for ${formatRefusalSpan(blockedMs)} (since ${since}); head is '${first.id}'.`,
      pr: first.id,
      specimen: `queue:${base}`,
      count: prs.length,
      since,
      blockedMs,
    })
  }
  return findings
}

function latestQueueLandingMs(state: DeepReadonly<RuntimeState>, base: string): number | undefined {
  return Object.values(state.bays.prs)
    .filter((pr) => baseIdentity(pr.base) === base)
    .flatMap((pr) => [pr.integratedAt, pr.alreadyLandedAt])
    .filter((at): at is string => at !== undefined)
    .map((at) => parseAuditTime(at, "landing time"))
    .reduce<number | undefined>((latest, at) => (latest === undefined ? at : Math.max(latest, at)), undefined)
}

function validateQueueProgressPolicy(policy: QueueProgressPolicy): QueueProgressPolicy {
  if (!Number.isSafeInteger(policy.noLandingMs) || policy.noLandingMs < 1) {
    throw new Error("yrd: queue progress noLandingMs must be an integer >= 1")
  }
  if (!Number.isSafeInteger(policy.refusalCount) || policy.refusalCount < 1) {
    throw new Error("yrd: queue progress refusalCount must be an integer >= 1")
  }
  return Object.freeze({ ...policy })
}

function parseAuditTime(value: string, field: string): number {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error(`yrd: queue audit ${field} must be an ISO timestamp`)
  return milliseconds
}

/** Compact block span for the audit message. Deliberately derived from the two
 * journal timestamps rather than a wall clock, so `queue audit` stays a pure
 * function of projected state and the number is reproducible on replay. */
function formatRefusalSpan(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  return `${seconds}s`
}

/** Classify a planned step against the installed catalog: `undefined` when it
 * still matches, else a human-readable drift reason. The single source of truth
 * for both the fail-loud {@link requirePlannedStep} (isolate path) and the typed
 * stale-steps release (advance path). */
function plannedStepDrift(steps: ReadonlyMap<string, RuntimeStep>, planned: InstalledStep): string | undefined {
  const current = steps.get(planned.name)
  if (current === undefined) return `queue step '${planned.name}' is not installed`
  if (
    current.revision !== planned.revision ||
    current.kind !== planned.kind ||
    current.classification !== planned.classification
  ) {
    return `queue step '${planned.name}' revision '${planned.revision}' does not match installed revision '${current.revision}'`
  }
  return undefined
}

function requirePlannedStep(steps: ReadonlyMap<string, RuntimeStep>, planned: InstalledStep): RuntimeStep {
  const drift = plannedStepDrift(steps, planned)
  if (drift !== undefined) throw new Error(`yrd: ${drift}`)
  const current = steps.get(planned.name)
  if (current === undefined) throw new Error(`yrd: queue step '${planned.name}' is not installed`)
  return current
}

/** First drift across a run's ENTIRE recorded plan against the installed catalog,
 * or `undefined` when every step still matches. Isolation re-plans every parent
 * step ({@link requirePlannedStep} over `parent.steps`), so a drift on ANY of them
 * makes the batch permanently un-isolable — the trigger for a stale-plan retirement. */
function recordedPlanDrift(
  steps: readonly InstalledStep[],
  byName: ReadonlyMap<string, RuntimeStep>,
): string | undefined {
  for (const planned of steps) {
    const drift = plannedStepDrift(byName, planned)
    if (drift !== undefined) return drift
  }
  return undefined
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

type QueuePosition = Readonly<{ at: string; identity: string }>

function prQueuePosition(pr: DeepReadonly<PR>): QueuePosition {
  const submittedAt = currentPRRev(pr).submittedAt
  if (submittedAt === undefined) throw new Error(`yrd: queued merge request '${pr.id}' has no submit time`)
  // Legacy projections expose no cross-plugin journal ordinal. Equal clocks
  // therefore have no recoverable chronology; retain the established PR line
  // ahead of additive intent rows, then use natural identity for replay.
  return { at: submittedAt, identity: `0:pr:${pr.id}` }
}

function intentQueuePosition(intent: DeepReadonly<PinIntent>): QueuePosition {
  return { at: intent.submittedAt, identity: `1:intent:${intent.id}` }
}

function compareQueuePosition(left: QueuePosition, right: QueuePosition): number {
  return left.at.localeCompare(right.at) || compareNatural(left.identity, right.identity)
}

function queuedIntents(state: DeepReadonly<RuntimeState>): PinIntent[] {
  const intents = state.intents
  if (intents === undefined) return []
  return intents.order.flatMap((id) => {
    const intent = intents.records[id]
    return intent?.status === "open" ? [intent as PinIntent] : []
  })
}

function requestedPRs(
  state: DeepReadonly<BaysState>,
  args: QueueRunArgs,
  excluded: ReadonlySet<string> = new Set(),
  implicitBefore?: QueuePosition,
): PR[] {
  const explicit = explicitPRs(state, args)
  const prs = (
    explicit ??
    Object.values(state.prs)
      .filter((pr) => {
        const delivery = prDeliveryState(pr)
        return delivery === "submitted" || delivery === "ready"
      })
      .toSorted((left, right) => {
        const leftSubmittedAt = currentPRRev(left).submittedAt
        const rightSubmittedAt = currentPRRev(right).submittedAt
        if (leftSubmittedAt === undefined) throw new Error(`yrd: queued merge request '${left.id}' has no submit time`)
        if (rightSubmittedAt === undefined) {
          throw new Error(`yrd: queued merge request '${right.id}' has no submit time`)
        }
        return leftSubmittedAt.localeCompare(rightSubmittedAt) || compareNatural(left.id, right.id)
      })
  )
    .filter((pr) => !excluded.has(pr.id))
    .filter(
      (pr) =>
        explicit !== undefined ||
        implicitBefore === undefined ||
        compareQueuePosition(prQueuePosition(pr), implicitBefore) < 0,
    )
  for (const pr of prs) {
    const delivery = prDeliveryState(pr)
    if (
      delivery !== "submitted" &&
      delivery !== "ready" &&
      delivery !== "needs-author" &&
      delivery !== "integrated" &&
      delivery !== "already-landed"
    ) {
      raiseFailure("refusal", "pr-not-ready", `yrd: PR '${pr.id}' is ${delivery}, not ready for the queue`)
    }
  }
  return prs
}

function resumableQueueRoots(
  state: DeepReadonly<RuntimeState>,
  args: QueueRunArgs,
  steps: readonly RuntimeStep[],
): Run[] {
  const explicit = explicitPRs(state.bays, args)
  const selected = explicit === undefined ? undefined : new Set(explicit.map((pr) => pr.id))
  const admissions = admissionSteps(state.queues, steps)
  const requested = args.steps === undefined ? undefined : selectSteps(steps, args.steps)
  const indexed = (explicit ?? []).flatMap((pr) => {
    const id = latestRootRunId(state.queues.index, Queues.snapshot(pr))
    const record = id === undefined ? undefined : Queues.get(state.queues, id)
    return record === undefined ? [] : [materializeRun(record, state.jobs)]
  })
  const candidates = new Map<RunId, Run>(pendingQueueRoots(state).map((run) => [run.id, run]))
  for (const run of indexed) candidates.set(run.id, run)
  return [...candidates.values()].filter(
    (run) =>
      needsSettlement(state, run) &&
      projectionLookupGet(state.queues.authority.runs, run.id)?.released === undefined &&
      !samePlan(run.steps, admissions) &&
      (requested === undefined ||
        (samePlan(run.steps, requested) &&
          (run.stepSelection === undefined || run.stepSelection.authority === "explicit"))) &&
      (selected === undefined || run.prs.every((pr) => selected.has(pr.id))),
  )
}

function pendingQueueRoots(state: DeepReadonly<RuntimeState>): Run[] {
  return activeQueueRootIds(state.queues.authority)
    .map((id) => Queues.get(state.queues, id))
    .filter((record): record is DeepReadonly<QueueRecord> => record !== undefined)
    .map((record) => materializeRun(record, state.jobs))
    .filter((run) => needsSettlement(state, run))
}

function needsSettlement(state: DeepReadonly<RuntimeState>, run: Run): boolean {
  if (!Queues.terminal(run) || needsAdvance(state, run)) return true
  if (!bisectable(run)) return false
  return ([0, 1] as const).some((part) => {
    const child = childQueue(state.queues, state.jobs, run.id, part)
    return child === undefined || needsSettlement(state, child)
  })
}

function admissionSteps(queues: DeepReadonly<QueuesState>, steps: readonly RuntimeStep[]): RuntimeStep[] {
  const selected = selectSteps(steps, queues.defaultSteps)
  const boundary = selected.findIndex((step) => step.kind === "merge")
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
        step.kind === candidate.kind &&
        step.classification === candidate.classification
      )
    })
  )
}

function unstartedAdmission(
  run: DeepReadonly<Run>,
  queues: DeepReadonly<QueuesState>,
  steps: readonly RuntimeStep[],
): boolean {
  return (
    run.stepSelection?.authority === "admission" &&
    samePlan(run.steps, admissionSteps(queues, steps)) &&
    run.steps.every((step) => step.job === undefined || step.job.status === "queued")
  )
}

function admissionRun(
  state: DeepReadonly<RuntimeState>,
  snapshot: DeepReadonly<PRSnapshot>,
  selected: readonly RuntimeStep[],
): Run | undefined {
  const id = latestExactRunId(state.queues.index, snapshot, selected)
  const record = id === undefined ? undefined : Queues.get(state.queues, id)
  return record === undefined ? undefined : materializeRun(record, state.jobs)
}

function checkFactRun(
  state: DeepReadonly<RuntimeState>,
  snapshot: DeepReadonly<PRSnapshot>,
  selected: readonly RuntimeStep[],
): Run | undefined {
  const id = latestPrefixRunId(state.queues.index, snapshot, selected)
  const record = id === undefined ? undefined : Queues.get(state.queues, id)
  return record === undefined ? undefined : materializeRun(record, state.jobs)
}

function checkRunStatus(run: Run, selectedCount: number): PREligibility["checks"]["status"] {
  const selected = run.steps.slice(0, selectedCount)
  if (selected.every((step) => step.job !== undefined && jobSucceeded(step.job))) return "passed"
  if (selected.some((step) => step.job !== undefined && jobFailed(step.job))) {
    return "failed"
  }
  return Queues.failed(run) ? "failed" : "checking"
}

const AUTOMATIC_ADMISSION_RETRIES = 1
const AUTOMATIC_INTENT_CHECK_RETRIES = 1

function intentCheckFailures(state: DeepReadonly<RuntimeState>, intent: string, excluding: RunId): number {
  return Queues.values(state.queues).filter((record) => {
    if (record.id === excluding || !record.prs.some((snapshot) => snapshot.intent?.id === intent)) return false
    const run = materializeRun(record, state.jobs)
    return (
      Queues.failed(run) &&
      run.steps.some((step) => step.kind === "check" && step.job !== undefined && jobFailed(step.job))
    )
  }).length
}

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
      (request.baseSha ?? prBaseSha(pr)) === snapshot.baseSha,
  ).length
  if (exactRequests === 0) return false
  const releasedFailures = releasedAdmissionFailures(state.queues.index, snapshot, selected)
  return releasedFailures >= exactRequests + AUTOMATIC_ADMISSION_RETRIES
}

function admissionQueue(
  state: DeepReadonly<RuntimeState>,
  steps: readonly RuntimeStep[],
  targets?: ReadonlySet<string>,
): PR[] {
  const selected = admissionSteps(state.queues, steps)
  if (selected.length === 0) return []
  return Object.values(state.bays.prs)
    .filter((pr) => targets === undefined || targets.has(pr.id))
    .filter((pr) => {
      const delivery = prDeliveryState(pr)
      if (delivery === "pushed" || delivery === "submitted" || delivery === "ready") return true
      if (delivery !== "needs-author") return false
      const admission = prAdmission(pr)
      return admission?.status === "refused" && hasFreshRevisionCheckAuthority(state, pr, steps)
    })
    .filter((pr) => blockingQueuePause(state, pr) === undefined)
    .filter((pr) => checksRequested(pr))
    .filter((pr) => {
      const admission = prAdmission(pr)
      if (admission === undefined) return true
      const request = checkRequest(pr)
      const requestedBase = request?.baseSha ?? prBaseSha(pr)
      const matches =
        requestedBase !== undefined &&
        admission.baseSha === requestedBase &&
        admission.steps.every(
          (evidence, index) =>
            evidence.name === selected[index]?.name && evidence.revision === selected[index]?.revision,
        )
      if (!matches) return true
      if (admission.status === "passed" && admission.steps.length === selected.length) return false
      return admission.status !== "refused" || hasFreshRevisionCheckAuthority(state, pr, steps)
    })
    .filter((pr) => {
      const refusal = state.queues.admissionRefusals[pr.id]
      if (refusal?.settlement === undefined) return true
      const revision = currentPRRev(pr)
      return refusal.revision !== revision.n || refusal.headSha !== revision.head
    })
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
      return leftAt.localeCompare(rightAt) || compareNatural(left.id, right.id)
    })
}

/** Work that has entered the queue but has not produced a delivery outcome yet.
 *
 * This is deliberately broader than `admissionQueue`: a successful admission
 * removes a PR from the next admission pass, but it remains outstanding until a
 * Queue run lands (or otherwise changes its delivery state). Progress auditing
 * must span that gap or the exact "admission passes, nothing merges" failure is
 * invisible.
 */
function queueProgressQueue(state: DeepReadonly<RuntimeState>, steps: readonly RuntimeStep[]): PR[] {
  const selected = selectSteps(steps, state.queues.defaultSteps)
  if (!selected.some((step) => step.kind === "merge")) return []
  return Object.values(state.bays.prs)
    .filter((pr) => {
      const delivery = prDeliveryState(pr)
      return delivery === "pushed" || delivery === "submitted" || delivery === "ready"
    })
    .filter((pr) => blockingQueuePause(state, pr) === undefined)
    .filter((pr) => checksRequested(pr))
    .toSorted((left, right) => checkQueueTime(left).localeCompare(checkQueueTime(right)))
}

function refusedRevisionAdmissions(state: DeepReadonly<RuntimeState>): PR[] {
  return Object.values(state.bays.prs)
    .filter((pr) => prDeliveryState(pr) === "needs-author" && prAdmission(pr)?.status === "refused")
    .toSorted(
      (left, right) => checkQueueTime(left).localeCompare(checkQueueTime(right)) || compareNatural(left.id, right.id),
    )
}

/**
 * The PR ahead of `pr` that legitimately holds the admission line, or
 * `undefined` when nothing does and `pr` may be admitted now.
 *
 * Admission is FIFO, and it used to be strict: only `admissionQueue[0]` could
 * ever be admitted. That made ONE unadmittable carrier freeze the door for
 * every ready PR behind it, because a refused PR keeps its head position — the
 * 22474 wedge (PR1791 held the line through 44 consecutive refusal cycles,
 * PR1787 through 30, with seven ready PRs stacked behind them, each cleared by
 * hand). A PR carrying a live admission-refusal streak has demonstrably NOT
 * gotten in, so it stops holding the line while keeping its queue position: it
 * is still retried on its own turn, and its streak clears the moment it is
 * admitted, pushed, or recut ({@link QueueAdmissionRefusal}).
 *
 * Only PRs strictly AHEAD of `pr` are considered, so a PR with a stale streak
 * of its own is never blocked by the very PRs it outranks.
 */
function admissionLineHolder(
  state: DeepReadonly<RuntimeState>,
  steps: readonly RuntimeStep[],
  pr: DeepReadonly<PR>,
): DeepReadonly<PR> | undefined {
  const queued = admissionQueue(state, steps)
  const position = queued.findIndex((candidate) => candidate.id === pr.id)
  const ahead = position < 0 ? queued : queued.slice(0, position)
  return ahead.find((candidate) => state.queues.admissionRefusals[candidate.id] === undefined)
}

function blockingQueuePause(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
): DeepReadonly<QueuePause> | undefined {
  const pause = state.queues.pauses[baseIdentity(pr.base)]
  return pause === undefined || pause.allowedPRs.includes(pr.id) ? undefined : pause
}

function checkQueueTime(pr: DeepReadonly<PR>): string {
  const request = checkRequest(pr)
  if (request === undefined) throw new Error(`yrd: queued PR '${pr.id}' has no current check request`)
  return request.at
}

function hasFreshRevisionCheckAuthority(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
  steps: readonly RuntimeStep[],
): boolean {
  const request = checkRequest(pr)
  const baseSha = request?.baseSha ?? prBaseSha(pr)
  if (baseSha === undefined) return false
  const requests = revisionCheckRequestCount(pr, baseSha)
  const admission = prAdmission(pr)
  const attempts = Math.max(
    admission?.baseSha === baseSha ? (admission.requestCount ?? 1) : 0,
    ...(currentRevisionAdmissionJobs(state, pr, steps) ?? []).map((job) => job?.attempt ?? 0),
  )
  return requests > attempts
}

function revisionCheckRequestCount(pr: DeepReadonly<PR>, baseSha: string): number {
  const revision = currentPRRev(pr)
  return pr.checkRequests.filter(
    (candidate) =>
      candidate.revision === revision.n &&
      candidate.headSha === revision.head &&
      (candidate.baseSha ?? prBaseSha(pr)) === baseSha,
  ).length
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
  const admission = prAdmission(pr)
  const requestedBase = request?.baseSha ?? prBaseSha(pr)
  const matchesAdmission =
    admission !== undefined &&
    requestedBase !== undefined &&
    admission.baseSha === requestedBase &&
    admission.steps.every(
      (evidence, index) => evidence.name === selected[index]?.name && evidence.revision === selected[index]?.revision,
    )
  if (
    matchesAdmission &&
    admission.status === "passed" &&
    admission.steps.length === selected.length &&
    selected.every((step) => step.classification !== "base")
  ) {
    return { status: "passed", ...timing }
  }
  if (matchesAdmission && admission.status === "refused") return { status: "failed", ...timing }
  const run = checkFactRun(state, Queues.snapshot(pr), selected)
  if (run !== undefined) return { status: checkRunStatus(run, selected.length), ...timing, run: run.id }
  const admissionJobs = currentRevisionAdmissionJobs(state, pr, steps)
  if (admissionJobs !== undefined) {
    if (admissionJobs.some((job) => job?.status === "in_progress" || job?.status === "waiting")) {
      return { status: "checking", ...timing }
    }
    if (admissionJobs.some((job) => job !== undefined && jobFailed(job))) return { status: "failed", ...timing }
    if (
      admissionJobs.length === selected.length &&
      admissionJobs.every((job) => job !== undefined && jobSucceeded(job))
    ) {
      return { status: "passed", ...timing }
    }
  }
  if (request === undefined) return { status: "not-requested" }
  // Only an open delivery can hold a live admission slot — the same predicate
  // `admissionQueue` filters on. Check requests are append-only history, so a
  // withdrawn/canceled/integrated PR keeps its `queuedAt` fact while its status
  // stops claiming a slot the queue can never run. `admissionQueue` already
  // excludes it, but that exclusion only ever reached `position`, never
  // `status`. Runs that actually executed are settled above and survive: they
  // are recorded facts, not a claim about a live slot. (22390)
  const delivery = prDeliveryState(pr as PR)
  if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready") {
    return { status: "not-requested", ...timing }
  }
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
  if (job.status === "completed" && job.conclusion === "success") return objectValue(job.output)
  if (job.status === "completed" && job.conclusion === "failure") {
    const output = objectValue(job.output)
    if (output !== undefined) return output
    const refusal = objectValue(job.error.evidence)
    if (refusal === undefined) return undefined
    const candidate = objectValue(refusal.candidateEvidence)
    const parent = objectValue(refusal.parent)
    return refusal.phase === "parent" ? (parent ?? candidate ?? refusal) : (candidate ?? parent ?? refusal)
  }
  if (job.status === "waiting") return objectValue(job.checkpoint)
  return undefined
}

function checkError(job: Job | undefined, run: Run): JobError | undefined {
  if (job?.status === "completed" && job.conclusion !== "success") return jobFailure(job)
  return run.error
}

function checkStatus(job: Job | undefined, run: Run): PRCheckRecord["status"] {
  if (Queues.failed(run) && (job === undefined || !Job.terminal(job))) return "failed"
  if (job !== undefined && jobSucceeded(job)) return "passed"
  if (job !== undefined && jobFailed(job)) return "failed"
  return "checking"
}

function projectCheckStep(
  pr: DeepReadonly<PR>,
  run: Run,
  step: QueueStep,
  queuedAt: string | undefined,
): PRCheckRecord | undefined {
  const job = step.job
  if (job === undefined && !Queues.failed(run)) return undefined
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
    revision: prRevisionNumber(pr),
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

function projectRevisionAdmissionJobs(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
  steps: readonly RuntimeStep[],
  queuedAt: string | undefined,
): PRCheckRecord[] | undefined {
  const selected = admissionSteps(state.queues, steps)
  const jobs = currentRevisionAdmissionJobs(state, pr, steps)
  if (jobs === undefined) return undefined
  return selected.map((step, index) => {
    const job = jobs[index]
    if (job === undefined) {
      return {
        pr: pr.id,
        revision: prRevisionNumber(pr),
        step: step.name,
        status: "queued",
        classification: step.classification ?? "carrier",
        command: [`queue.step.${step.name}`],
        ...(queuedAt === undefined ? {} : { queuedAt }),
      }
    }
    const evidence = checkEvidence(job as Job)
    const error = jobFailed(job as Job) ? jobFailure(job as Job) : undefined
    const diagnostics =
      Array.isArray(evidence?.diagnostics) || typeof evidence?.detail === "string"
        ? ((evidence?.diagnostics ?? evidence?.detail) as JsonValue)
        : job.status === "waiting" && job.detail !== undefined
          ? job.detail
          : error?.message
    const artifact = firstArtifact(evidence, error === undefined ? undefined : "stderr")
    const status: PRCheckRecord["status"] =
      job.status !== "completed"
        ? job.status === "queued"
          ? "queued"
          : "checking"
        : job.conclusion === "success"
          ? "passed"
          : "failed"
    return {
      pr: pr.id,
      revision: prRevisionNumber(pr),
      job: job.id,
      step: step.name,
      status,
      classification: step.classification ?? "carrier",
      command: [job.definition],
      ...(queuedAt === undefined ? {} : { queuedAt }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
      ...(artifact === undefined ? {} : { artifact }),
      ...(error === undefined ? {} : { error }),
    }
  })
}

function currentRevisionAdmissionJobs(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
  steps: readonly RuntimeStep[],
): readonly (DeepReadonly<Job> | undefined)[] | undefined {
  const request = checkRequest(pr)
  const baseSha = request?.baseSha ?? prBaseSha(pr)
  if (baseSha === undefined) return undefined
  const snapshot = pinCandidateBaseSha([Queues.snapshot(pr)], baseSha)[0]
  if (snapshot === undefined) return undefined
  const jobs = admissionSteps(state.queues, steps).map((step, index) => {
    const id =
      state.jobs.byKey[admissionJobKey(snapshot, baseSha, index, step.revision)] ??
      state.jobs.byKey[admissionJobKey(snapshot, baseSha, index)]
    return id === undefined ? undefined : state.jobs.byId[id]
  })
  return jobs.every((job) => job === undefined) ? undefined : jobs
}

function projectPRChecks(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
  steps: readonly RuntimeStep[],
): PRCheckRecord[] {
  const checks = checkEligibility(state, pr, steps)
  const admission = prAdmission(pr)
  if (admission !== undefined && checks.run === undefined) {
    const records = admission.steps.map((evidence) => {
      const step = steps.find((candidate) => candidate.name === evidence.name)
      const output = evidence.output === undefined ? undefined : objectValue(evidence.output)
      const diagnostics =
        Array.isArray(output?.diagnostics) || typeof output?.detail === "string"
          ? ((output?.diagnostics ?? output?.detail) as JsonValue)
          : evidence.receipt?.message
      const artifact = firstArtifact(evidence.output, evidence.receipt === undefined ? undefined : "stderr")
      return {
        pr: pr.id,
        revision: prRevisionNumber(pr),
        job: evidence.job,
        step: evidence.name,
        status: evidence.status === "passed" ? ("passed" as const) : ("failed" as const),
        classification: step?.classification ?? "carrier",
        command: [`queue.step.${evidence.name}`],
        ...(checks.queuedAt === undefined ? {} : { queuedAt: checks.queuedAt }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
        ...(artifact === undefined ? {} : { artifact }),
        ...(evidence.receipt === undefined ? {} : { error: evidence.receipt }),
      }
    })
    if (records.length > 0) return records
    if (admission.status === "refused") {
      return [
        {
          pr: pr.id,
          revision: prRevisionNumber(pr),
          status: "failed",
          ...(checks.queuedAt === undefined ? {} : { queuedAt: checks.queuedAt }),
          error: admission.receipt,
        },
      ]
    }
  }
  const revisionJobs =
    checks.run === undefined ? projectRevisionAdmissionJobs(state, pr, steps, checks.queuedAt) : undefined
  if (revisionJobs !== undefined) return revisionJobs
  const run = checks.run === undefined ? undefined : materializeRun(Queues.record(state.queues, checks.run), state.jobs)
  if (run === undefined) {
    return [
      {
        pr: pr.id,
        revision: prRevisionNumber(pr),
        status: checks.status,
        ...(checks.position === undefined ? {} : { position: checks.position }),
        ...(checks.queuedAt === undefined ? {} : { queuedAt: checks.queuedAt }),
      },
    ]
  }
  const hasStartedStep = run.steps.some((step) => step.job !== undefined)
  const records = run.steps
    .filter((step) => step.kind !== "merge")
    .flatMap((step, index) => {
      if (step.job === undefined && (hasStartedStep || index !== run.cursor)) return []
      const record = projectCheckStep(pr, run, step, checks.queuedAt)
      return record === undefined ? [] : [record]
    })
  const evidenceStep =
    run.error?.evidence === undefined
      ? undefined
      : run.steps.find((step) => step.kind !== "check" && step.job !== undefined && jobFailed(step.job))
  const evidenceRecord =
    evidenceStep === undefined ? undefined : projectCheckStep(pr, run, evidenceStep, checks.queuedAt)
  const projected = evidenceRecord === undefined ? records : [...records, evidenceRecord]
  return projected.length === 0
    ? [
        {
          pr: pr.id,
          revision: prRevisionNumber(pr),
          run: run.id,
          status: checks.status,
          ...(checks.queuedAt === undefined ? {} : { queuedAt: checks.queuedAt }),
          ...(run.error === undefined ? {} : { error: run.error }),
        },
      ]
    : projected
}

function reusableRevisionAdmission(
  state: DeepReadonly<RuntimeState>,
  snapshots: readonly DeepReadonly<PRSnapshot>[],
  selected: readonly RuntimeStep[],
): Readonly<{ count: number; shape: PRShape }> | undefined {
  const snapshot = snapshots.length === 1 ? snapshots[0] : undefined
  if (snapshot?.baseSha === undefined) return undefined
  const pr = state.bays.prs[snapshot.id]
  if (pr === undefined || prRevisionNumber(pr) !== snapshot.revision || prHead(pr) !== snapshot.headSha) {
    return undefined
  }
  const boundary = selected.findIndex((step) => step.kind === "merge")
  const prefix = boundary < 0 ? selected : selected.slice(0, boundary)
  if (prefix.length === 0 || prefix.some((step) => step.classification === "base")) return undefined
  const admission = prAdmission(pr)
  if (
    admission?.status !== "passed" ||
    admission.baseSha !== snapshot.baseSha ||
    admission.steps.length !== prefix.length ||
    admission.steps.some(
      (evidence, index) =>
        evidence.status !== "passed" ||
        evidence.name !== prefix[index]?.name ||
        evidence.revision !== prefix[index]?.revision ||
        evidence.output === undefined,
    )
  ) {
    return undefined
  }
  return {
    count: prefix.length,
    shape: {
      results: Object.fromEntries(admission.steps.map((evidence) => [evidence.name, evidence.output as JsonValue])),
    },
  }
}

function reusablePrefix(
  state: DeepReadonly<RuntimeState>,
  snapshots: readonly DeepReadonly<PRSnapshot>[],
  selected: readonly RuntimeStep[],
): Readonly<{ run: RunId; count: number; shape: PRShape }> | undefined {
  const snapshot = snapshots.length === 1 ? snapshots[0] : undefined
  if (snapshot?.baseSha === undefined) return undefined
  const boundary = selected.findIndex((step) => step.kind === "merge")
  const prefix = boundary < 0 ? selected : selected.slice(0, boundary)
  if (prefix.length === 0 || prefix.some((step) => step.classification === "base")) return undefined
  const cached = admissionRun(state, snapshot, prefix)
  if (cached === undefined || !Queues.succeeded(cached)) return undefined
  const record = Queues.record(state.queues, cached.id)
  return { run: cached.id, count: prefix.length, shape: shapeThrough(record, state.jobs) }
}

function reusableIntentPrefix(
  state: DeepReadonly<RuntimeState>,
  snapshots: readonly DeepReadonly<PRSnapshot>[],
  treeSha: string | undefined,
  selected: readonly RuntimeStep[],
): Readonly<{ run: RunId; count: number; shape: PRShape }> | undefined {
  const first = snapshots[0]
  if (first?.intent === undefined || treeSha === undefined) return undefined
  const boundary = selected.findIndex((step) => step.kind === "merge")
  const prefix = boundary < 0 ? selected : selected.slice(0, boundary)
  if (prefix.length === 0 || prefix.some((step) => step.classification === "base")) return undefined
  const record = Queues.values(state.queues).findLast((candidateRun) => {
    const candidate = state.queues.candidates[candidateRun.candidateId]
    if (candidate?.treeSha !== treeSha || candidate.queueId !== queueIdentity(first)) return false
    if (!samePlan(candidateRun.steps.slice(0, prefix.length), prefix)) return false
    const jobs = queueJobs(candidateRun, state.jobs)
    return prefix.every((_step, index) => {
      const job = jobs[index]
      return job !== undefined && jobSucceeded(job)
    })
  })
  if (record === undefined) return undefined
  return { run: record.id, count: prefix.length, shape: shapeThrough(record, state.jobs, prefix.length) }
}

function runnablePRs(
  state: DeepReadonly<RuntimeState>,
  args: QueueRunArgs,
  steps: readonly RuntimeStep[],
  excluded: ReadonlySet<string> = new Set(),
  options: Readonly<{ explicitStepAuthority?: boolean; implicitBefore?: QueuePosition }> = {},
): PR[] {
  const requested = requestedPRs(state.bays, args, excluded, options.implicitBefore)
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
 * - plain-rejected: an ordinary failure with no composition meaning — no
 *   author-blame routing and no auto-retry; the operator re-evaluates. The
 *   intent-* codes live here because a stale evaluation is cured by
 *   re-evaluating the intent, which neither re-authoring nor retrying does.
 */
export const COMPOSITION_FAILURE_BUCKETS = {
  "needs-author": new Set<string>([
    "authored-gitlink",
    "carrier-drops-landed",
    "composition-invalid",
    "gitlink-inspection",
    "merge-tip-carrier",
    "refused-path",
    "refused-path-inspection",
    "wrapper-mismatch",
    "source-missing",
    "source-lineage",
    "payload-certificate",
    "payload-identity",
    "payload-mismatch",
    "payload-overlap",
  ]),
  "infra-retry": new Set<string>([
    "carrier-inspection",
    "source-publish",
    "scratch-cleanup-failed",
    "wrapper-generation",
  ]),
  "recut-lineage": new Set<string>(["recut-certificate", "restack-conflict", "restack-failed"]),
  "plain-rejected": new Set<string>(["intent-base-moved", "intent-batch-refused", "intent-component-unknown"]),
} as const

const NEEDS_AUTHOR_CODES: ReadonlySet<string> = COMPOSITION_FAILURE_BUCKETS["needs-author"]

function admissionFailureKind(
  receipt: DeepReadonly<JobError>,
  infrastructure: boolean,
): Extract<PRAdmissionRecord, { status: "refused" }>["kind"] {
  if (infrastructure) return "infrastructure"
  return NEEDS_AUTHOR_CODES.has(receipt.code) ? "refusal" : "failure"
}

type InfraRetryCompositionFailure =
  | "carrier-inspection"
  | "source-publish"
  | "scratch-cleanup-failed"
  | "wrapper-generation"

function isInfraRetryCompositionFailure(code: string | undefined): code is InfraRetryCompositionFailure {
  return code !== undefined && COMPOSITION_FAILURE_BUCKETS["infra-retry"].has(code)
}

function terminalJobError(job: DeepReadonly<Job> | undefined): JobError | undefined {
  if (job?.status !== "completed") return undefined
  if (job.conclusion === "failure") return job.error
  if (job.conclusion === "timed_out") return { code: "job-lost", message: job.lostReason }
  if (job.conclusion === "cancelled") return jobFailure(job)
  return undefined
}

function needsAuthorJobReceipt(job: DeepReadonly<Job> | undefined): JobError | undefined {
  const error = terminalJobError(job)
  if (error === undefined) return undefined
  if (NEEDS_AUTHOR_CODES.has(error.code)) return error
  if (job?.status !== "completed" || job.conclusion !== "failure") return undefined
  const evidence = candidateFailureReceiptEvidence(job.output)
  return evidence === undefined ? undefined : JobErrorSchema.parse({ ...error, evidence })
}

/** Recover the immutable author-attribution receipt from an exact Queue run.
 * This remains valid after the PR advances to a later revision, unlike a
 * lookup through current PR eligibility. */
export function authorAttributionReceipt(
  run: DeepReadonly<Run> | undefined,
  identity?: Readonly<{ pr: string; revision: number; headSha: string }>,
): JobError | undefined {
  if (run === undefined) return undefined
  if (
    identity !== undefined &&
    !run.prs.some(
      (member) =>
        member.id === identity.pr && member.revision === identity.revision && member.headSha === identity.headSha,
    )
  ) {
    return undefined
  }
  for (const step of run.steps) {
    const receipt = needsAuthorJobReceipt(step.job)
    if (receipt !== undefined) return receipt
  }
  return run.error !== undefined && NEEDS_AUTHOR_CODES.has(run.error.code) ? run.error : undefined
}

/** Recover the attributed receipt for a legacy rejected journal. Scans EVERY
 * step across both the admission/check run and terminal integration run,
 * including integrating steps hidden from ordinary check projections. Native
 * needs-author reads the receipt directly from the PR fact. */
function needsAuthorReceipt(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<PR>,
  steps: readonly RuntimeStep[],
): JobError | undefined {
  const current = prNeedsAuthor(pr)
  if (current !== undefined) return current.receipt
  const runIds = new Set<RunId>()
  const checkRun = checkEligibility(state, pr, steps).run
  if (checkRun !== undefined) runIds.add(checkRun)
  if (pr.terminalRun !== undefined) runIds.add(pr.terminalRun as RunId)
  const latestRoot = latestRootRunId(state.queues.index, Queues.snapshot(pr))
  if (latestRoot !== undefined) runIds.add(latestRoot)
  for (const runId of runIds) {
    const record = Queues.get(state.queues, runId)
    if (record === undefined) continue
    const run = materializeRun(record, state.jobs)
    const receipt = authorAttributionReceipt(run)
    if (receipt !== undefined) return receipt
  }
  return undefined
}

function needsAuthorMessage(pr: DeepReadonly<PR>, receipt: JobError): string {
  const attributed = CandidateFailureReceiptEvidenceSchema.safeParse(receipt.evidence)
  if (!attributed.success) return `PR '${pr.id}' cannot be composed as submitted: ${receipt.message}`
  const failures = attributed.data.failures
    .map(
      (failure) =>
        `${failure.file}:${failure.line}${failure.column === undefined ? "" : `:${failure.column}`} ${failure.message}`,
    )
    .join("; ")
  return `PR '${pr.id}' introduced ${attributed.data.failures.length} check failure(s): ${failures}`
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
    ...(reviewed.current?.by === undefined ? {} : { by: reviewed.current.by }),
    ...(reviewed.current?.ref === undefined ? {} : { ref: reviewed.current.ref }),
  }
  const checks = checkEligibility(state, pr, steps)
  const exhaustedAutomaticAdmissions =
    checks.status === "failed" &&
    automaticAdmissionAttemptsExhausted(state, pr, Queues.snapshot(pr), admissionSteps(state.queues, steps))
  const result = (reason?: PREligibility["reason"]): PREligibility => ({
    pr: pr.id,
    revision: prRevisionNumber(pr),
    runnable: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    review,
    checks,
  })
  const delivery = prDeliveryState(pr)
  const resumingIntegration =
    options.resumeIntegrated === true && (delivery === "integrated" || delivery === "already-landed")
  if (!resumingIntegration) {
    if (delivery === "pushed") {
      return result({ code: "draft", message: `PR '${pr.id}' is pushed, not ready` })
    }
    if (delivery === "needs-author") {
      const admission = prAdmission(pr)
      if (admission?.status === "refused") {
        return result({
          code: "admission-refused",
          message:
            `merge request '${pr.id}' required checks cannot run after the entry-check failure '${admission.receipt.code}': ` +
            `${admission.receipt.message}.\nNext: yrd pr recut ${pr.id} --preflight --queue`,
        })
      }
      const receipt = prNeedsAuthor(pr)?.receipt
      if (receipt === undefined) {
        throw new Error(`yrd: PR '${pr.id}' is needs-author without an attribution receipt`)
      }
      return result({
        code: "needs-author",
        message: needsAuthorMessage(pr, receipt),
        receipt,
      })
    }
    // A composition refusal is deterministic: the queue could not build the
    // candidate from what the author submitted, so re-running the same payload
    // cannot pass — whether the failed compose left the PR `submitted` or drove
    // an automatic `rejected`. Project it as `needs-author` with the refusal
    // receipt attached, ahead of the generic `rejected`/`required-check-failed` verdicts.
    // This is a derived projection over the failed check's recorded refusal
    // evidence; it stores no new PR state (the bay state is untouched).
    if (
      options.ignoreChecks !== true &&
      (delivery === "submitted" || delivery === "ready" || delivery === "rejected")
    ) {
      const receipt = needsAuthorReceipt(state, pr, steps)
      if (receipt !== undefined) {
        return result({
          code: "needs-author",
          message: needsAuthorMessage(pr, receipt),
          receipt,
        })
      }
    }
    if (delivery === "rejected") {
      return result({ code: "rejected", message: `PR '${pr.id}' is rejected; submit it again before queueing` })
    }
    if (delivery !== "submitted" && delivery !== "ready") {
      return result({ code: "terminal", message: `PR '${pr.id}' is ${delivery}, not queueable` })
    }
    const revision = currentPRRev(pr)
    const conflictingCandidate = Object.values(state.queues.candidates)
      .filter(
        (candidate) =>
          candidate.mergeability === "conflicting" &&
          candidate.queueId === queueIdentity(pr) &&
          candidate.revs.some(
            (member) => member.pr === pr.id && member.n === revision.n && member.head === revision.head,
          ),
      )
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .at(-1)
    if (conflictingCandidate !== undefined) {
      return result({
        code: "candidate-conflicting",
        message: `PR '${pr.id}' revision ${revision.n} conflicts in Candidate '${conflictingCandidate.id}'`,
      })
    }
    const admissionRefusal = state.queues.admissionRefusals[pr.id]
    if (
      admissionRefusal?.settlement !== undefined &&
      admissionRefusal.revision === revision.n &&
      admissionRefusal.headSha === revision.head
    ) {
      return result({
        code: "admission-refused",
        message:
          `merge request '${pr.id}' required checks cannot run after the entry-check failure '${admissionRefusal.code}': ` +
          `${admissionRefusal.reason}. ${admissionRefusal.settlement.reason}.\n` +
          `Next: yrd pr recut ${pr.id} --preflight --queue`,
      })
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
        code: "required-check-failed",
        message: `PR '${pr.id}' required check failed${run}; fix the branch and push, or request fresh checks`,
      })
    }
    if (required && !reviewed.approved) {
      if (reviewed.current?.decision === "reject") {
        return result({
          code: "review-rejected",
          message: `PR '${pr.id}' was rejected by ${reviewed.current.by} for revision ${prRevisionNumber(pr)}`,
        })
      }
      return result({
        code: "review-required",
        message: `PR '${pr.id}' needs approval for revision ${prRevisionNumber(pr)}`,
      })
    }
  }
  const base = baseIdentity(pr.base)
  const pause = blockingQueuePause(state, pr)
  if (pause !== undefined) {
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
    const flow = pr.flow
    const key = `${baseIdentity(pr.base)}\0${flow?.name ?? ""}\0${flow?.rev ?? ""}\0${flow?.fingerprint ?? ""}\0${proof?.commit ?? ""}\0${proof?.baseSha ?? ""}`
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
  if (prs.every((pr) => !pr.merged)) return undefined
  const proof = prs[0]?.integration
  const alreadyLanded = prs[0]?.alreadyLanded
  if (
    proof === undefined ||
    prs.some(
      (pr) =>
        !pr.merged ||
        pr.integration?.commit !== proof.commit ||
        pr.integration?.baseSha !== proof.baseSha ||
        (alreadyLanded === undefined) !== (pr.alreadyLanded === undefined) ||
        (alreadyLanded !== undefined &&
          (pr.alreadyLanded?.baseSha !== proof.baseSha ||
            pr.alreadyLanded.candidateSha !== alreadyLanded.candidateSha ||
            pr.alreadyLanded.candidateTreeSha !== alreadyLanded.candidateTreeSha ||
            pr.alreadyLanded.baseTreeSha !== alreadyLanded.baseTreeSha)),
    )
  ) {
    throw new Error("yrd: every PR in a queue candidate must share one integration proof")
  }
  return {
    ...prShape(prs.map(Queues.snapshot)),
    integration:
      alreadyLanded === undefined
        ? proof
        : {
            ...proof,
            alreadyLanded: {
              candidateSha: alreadyLanded.candidateSha,
              candidateTreeSha: alreadyLanded.candidateTreeSha,
              baseTreeSha: alreadyLanded.baseTreeSha,
            },
          },
  }
}

function pinnedPRError(
  state: DeepReadonly<RuntimeState>,
  snapshots: readonly PRSnapshot[],
  runId?: RunId,
): JobError | undefined {
  for (const snapshot of snapshots) {
    const intent = snapshot.intent
    if (intent !== undefined) {
      const current = state.intents?.records[intent.id]
      if (current?.status === "integrated" && current.integration?.landing.run === runId) continue
      const evaluation = current?.evaluation
      const ownsKey =
        current?.status === "open" &&
        current.intentId === intent.authored.intentId &&
        current.issue.source === intent.authored.issue.source &&
        current.issue.id === intent.authored.issue.id &&
        current.component === intent.authored.component &&
        current.target === intent.authored.target &&
        evaluation?.outcome === "advance" &&
        evaluation.baseSha === snapshot.baseSha &&
        evaluation.evaluated.priorPin === intent.evaluated.priorPin &&
        evaluation.evaluated.target === intent.evaluated.target
      if (!ownsKey) {
        return {
          code: current?.status === "superseded" ? "intent-superseded" : "stale-intent",
          message: `Intent '${intent.id}' changed after queue run pinned ${intent.evaluated.target} (${current?.status ?? "missing"})`,
        }
      }
      continue
    }
    const current = state.bays.prs[snapshot.id]
    if (
      current === undefined ||
      prRevisionNumber(current) !== snapshot.revision ||
      prHead(current) !== snapshot.headSha ||
      baseIdentity(current.base) !== baseIdentity(snapshot.base) ||
      (current.state === "closed" && !current.merged)
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

function bisectable(run: Run): boolean {
  const failed = run.steps.some((step) => step.job !== undefined && jobFailed(step.job))
  return (
    Queues.failed(run) &&
    failed &&
    queueAuthorityReleaseReason(run.error) === undefined &&
    !isIntegrated(run.shape) &&
    run.prs.length > 1
  )
}

function needsAdvance(state: DeepReadonly<RuntimeState>, run: Run): boolean {
  if (activeQueueFailure(Queues.record(state.queues, run.id), state.jobs) !== undefined) return false
  const index = run.steps.findLastIndex((step) => step.job !== undefined)
  const step = run.steps[index]
  if (step?.job === undefined || !Job.terminal(step.job)) return false
  if (jobSucceeded(step.job)) {
    if (run.steps[index + 1]?.job === undefined && index + 1 < run.steps.length) return true
    if (step.kind !== "merge" || run.integration === undefined) return false
    return run.prs.some((pr) => {
      const current = state.bays.prs[pr.id]
      const alreadyLanded = run.integration?.alreadyLanded
      const currentAlreadyLanded = current?.alreadyLanded
      return (
        current?.merged !== true ||
        current.integration?.commit !== run.integration?.commit ||
        current.integration?.baseSha !== run.integration?.baseSha ||
        (alreadyLanded === undefined) !== (currentAlreadyLanded === undefined) ||
        (alreadyLanded !== undefined &&
          (currentAlreadyLanded?.baseSha !== run.integration?.baseSha ||
            currentAlreadyLanded?.candidateSha !== alreadyLanded.candidateSha ||
            currentAlreadyLanded?.candidateTreeSha !== alreadyLanded.candidateTreeSha ||
            currentAlreadyLanded?.baseTreeSha !== alreadyLanded.baseTreeSha))
      )
    })
  }
  if (!jobFailed(step.job)) return false
  if (queueAuthorityReleaseReason(jobFailure(step.job)) !== undefined) return true
  if (step.job.conclusion !== "cancelled") return true
  return run.prs.some((member) => {
    const current = state.bays.prs[member.id]
    return (
      current !== undefined &&
      prRevisionNumber(current) === member.revision &&
      prHead(current) === member.headSha &&
      (prDeliveryState(current) === "pushed" ||
        prDeliveryState(current) === "submitted" ||
        prDeliveryState(current) === "ready")
    )
  })
}

function isIntegrated(shape: PRShape): shape is IntegratedShape {
  return "integration" in shape
}

function jobFailure(job: Job): JobError {
  if (job.status === "completed" && job.conclusion === "failure") return job.error
  if (job.status === "completed" && job.conclusion === "timed_out") {
    return { code: "job-lost", message: job.lostReason }
  }
  if (job.status === "completed" && job.conclusion === "cancelled") {
    return { code: "run-canceled", message: `Queue run canceled by ${job.canceledBy}: ${job.cancelReason}` }
  }
  if (job.status === "completed" && job.conclusion === "skipped") {
    return { code: "job-skipped", message: `Job '${job.id}' was skipped` }
  }
  throw new Error(
    `yrd: job '${job.id}' is ${job.status}${job.status === "completed" ? `+${job.conclusion}` : ""}, not failed`,
  )
}

type SuccessfulJob = Extract<Job, { status: "completed"; conclusion: "success" }>
type UnsuccessfulJob = Extract<
  Job,
  { status: "completed"; conclusion: "failure" | "cancelled" | "skipped" | "timed_out" }
>

function jobSucceeded(job: Job): job is SuccessfulJob {
  return job.status === "completed" && job.conclusion === "success"
}

function jobFailed(job: Job): job is UnsuccessfulJob {
  return job.status === "completed" && job.conclusion !== "success"
}
