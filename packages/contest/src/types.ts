import type { Bay, BaysState } from "@yrd/bay"
import type { Command, EffectError, EffectOutcome } from "@yrd/core"
import type { Task, TaskRef, TasksState } from "@yrd/task"

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** A competitor is the complete model + harness + configuration tuple. */
export type CompetitorSpec = Readonly<{
  model: string
  harness: string
  config: JsonObject
}>

export type Competitor = CompetitorSpec &
  Readonly<{
    /** Content-derived from model, harness, and canonical configuration. */
    id: string
  }>

export type GitRevisionPin = Readonly<{
  /** Immutable Git object id and the authority used for promotion. */
  commit: string
  /** Write-once attempt ref, verified against commit again at promotion. */
  ref: string
  branch: string
  bay: string
  baseSha?: string
}>

export type TokenCounts = Readonly<{
  input: number
  output: number
  cachedInput: number
  cacheWrite: number
  reasoning: number
}>

export type UsdCost =
  | Readonly<{ kind: "reported"; usd: number; source: string }>
  | Readonly<{ kind: "missing"; reason: string }>

export type ContestArtifact = Readonly<{
  kind: string
  uri: string
  digest?: string
  mediaType?: string
}>

export type AttemptRunOutput = Readonly<{
  pin: GitRevisionPin
  wallTimeMs: number
  tokens: TokenCounts
  cost: UsdCost
  artifacts: readonly ContestArtifact[]
}>

export type EvaluatorResult = Readonly<{
  verdict: "passed" | "failed"
  summary?: string
  artifacts: readonly ContestArtifact[]
  scores?: Readonly<Record<string, number>>
}>

export type ContestRunnerInput = Readonly<{
  contest: string
  attempt: string
  task: Task
  competitor: Competitor
  base: string
  bay: Bay
}>

export type ContestEvaluatorInput = Readonly<{
  contest: string
  attempt: string
  task: Task
  competitor: Competitor
  pin: GitRevisionPin
  artifacts: readonly ContestArtifact[]
}>

export type EffectAdapterContext = Readonly<{ id: string; attempt: number; executor: string }>

export type ContestRunnerAdapter = Readonly<{
  /** Stable adapter id selected by CompetitorSpec.harness. */
  harness: string
  run(
    input: ContestRunnerInput,
    context: EffectAdapterContext,
  ): EffectOutcome<AttemptRunOutput> | Promise<EffectOutcome<AttemptRunOutput>>
}>

export type ContestEvaluatorAdapter = Readonly<{
  id: string
  /** Only held-out evidence gates promotion. LLM/review signals are advisory. */
  authority: "held-out" | "advisory"
  evaluate(
    input: ContestEvaluatorInput,
    context: EffectAdapterContext,
  ): EffectOutcome<EvaluatorResult> | Promise<EffectOutcome<EvaluatorResult>>
}>

export type ContestGitAdapter = Readonly<{
  resolveCommit(ref: string, context: EffectAdapterContext): string | undefined | Promise<string | undefined>
}>

export type AttemptProcessStatus = "unrequested" | "requested" | "running" | "waiting" | "passed" | "failed" | "lost"

export type ProcessAttemptEvidence = Readonly<{
  attempt: number
  status: "passed" | "failed" | "lost"
  executor?: string
  token?: string
  url?: string
  detail?: string
  artifacts?: readonly ContestArtifact[]
  startedAt?: string
  finishedAt: string
  error?: EffectError
}>

export type AttemptProcess = Readonly<{
  status: AttemptProcessStatus
  effect?: string
  attempt: number
  executor?: string
  leaseExpiresAt?: string
  token?: string
  url?: string
  detail?: string
  artifacts?: readonly ContestArtifact[]
  startedAt?: string
  finishedAt?: string
  error?: EffectError
  history: readonly ProcessAttemptEvidence[]
}>

export type ContestEvaluation = Readonly<{
  evaluator: string
  authority: "held-out" | "advisory"
  status: AttemptProcessStatus
  effect?: string
  attempt: number
  executor?: string
  leaseExpiresAt?: string
  token?: string
  url?: string
  detail?: string
  artifacts?: readonly ContestArtifact[]
  startedAt?: string
  finishedAt?: string
  result?: EvaluatorResult
  error?: EffectError
  history: readonly ProcessAttemptEvidence[]
}>

export type ContestAttemptStatus =
  | "preparing"
  | "queued"
  | "running"
  | "waiting"
  | "evaluating"
  | "passing"
  | "rejected"
  | "failed"
  | "lost"

export type ContestAttempt = Readonly<{
  id: string
  competitor: Competitor
  bayName: string
  branch: string
  base: string
  bay?: string
  status: ContestAttemptStatus
  runner: AttemptProcess
  evaluations: Readonly<Record<string, ContestEvaluation>>
  pin?: GitRevisionPin
  wallTimeMs?: number
  tokens?: TokenCounts
  cost?: UsdCost
  artifacts: readonly ContestArtifact[]
}>

export type ContestSelection = Readonly<{
  attempt: string
  method: "manual"
  selectedAt: string
  selectedBy?: string
  reason?: string
}>

export type ContestPromotionOutput = Readonly<{
  submission: string
  revision: number
  commit: string
}>

export type ContestPromotion = Readonly<{
  attempt: string
  commit: string
  ref: string
  status: AttemptProcessStatus
  effect?: string
  attemptNumber: number
  executor?: string
  leaseExpiresAt?: string
  token?: string
  url?: string
  detail?: string
  artifacts?: readonly ContestArtifact[]
  startedAt?: string
  finishedAt?: string
  output?: ContestPromotionOutput
  error?: EffectError
  history: readonly ProcessAttemptEvidence[]
}>

export type ContestStatus = "running" | "ready" | "failed" | "selected" | "promoting" | "promoted" | "promotion-failed"

export type Contest = Readonly<{
  id: string
  task: Task
  base: string
  baseSha: string
  createdAt: string
  evaluators: readonly Readonly<{ id: string; authority: "held-out" | "advisory" }>[]
  attemptOrder: readonly string[]
  attempts: Readonly<Record<string, ContestAttempt>>
  status: ContestStatus
  selection?: ContestSelection
  promotion?: ContestPromotion
}>

export type ContestsState = {
  records: Record<string, Contest>
}

export type TaskCompeteArgs = Readonly<{
  task: TaskRef
  competitors: readonly CompetitorSpec[]
  evaluators?: readonly string[]
  base: string
  baseSha: string
}>

export type ContestSelectArgs = Readonly<{
  contest: string
  attempt: string
  selectedBy?: string
  reason?: string
}>

export type ContestPromoteArgs = Readonly<{ contest: string }>

export type ContestRunArgs = Readonly<{ contest: string; attempt: string; bay: string }>
export type ContestEvaluateArgs = Readonly<{ contest: string; attempt: string; evaluator: string }>

export type ContestCommandState = {
  tasks: TasksState
  bays: BaysState
  contests: ContestsState
}

export type ContestCommands = {
  task: {
    compete: Command<TaskCompeteArgs, ContestCommandState>
  }
  contest: {
    run: Command<ContestRunArgs, ContestCommandState>
    evaluate: Command<ContestEvaluateArgs, ContestCommandState>
    select: Command<ContestSelectArgs, ContestCommandState>
    promote: Command<ContestPromoteArgs, ContestCommandState>
  }
}

export type ContestReads = Readonly<{
  resolveBase(base?: string): Promise<Readonly<{ base: string; sha: string }>>
  show(contest: string): Promise<Contest>
  list(): Promise<readonly Contest[]>
}>

export type ContestWork = Readonly<{
  contest: string
  attempt: string
  kind: "bay" | "runner" | "evaluator" | "promotion"
  effect: string
  status: AttemptProcessStatus
  evaluator?: string
  token?: string
  url?: string
}>

export type ContestEffects = Readonly<{
  /** Materialize missing Bay/runner/evaluator work, then return durable work. */
  reconcile(contest?: string): Promise<readonly ContestWork[]>
}>

export type HasContests = {
  initialState: { contests: ContestsState }
  commands: ContestCommands
  contests: ContestReads
  contestEffects: ContestEffects
}

export type WithContestsOptions = Readonly<{
  runners: readonly ContestRunnerAdapter[]
  evaluators: readonly ContestEvaluatorAdapter[]
  git: ContestGitAdapter
  defaultBase?: string
}>
