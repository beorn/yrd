import type { Bay, BaysState } from "@yrd/bay"
import type { Command, EffectError, EffectOutcome, EffectRun, EffectsState } from "@yrd/core"
import type { Task } from "@yrd/task"

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export type CompetitorSpec = Readonly<{ model: string; harness: string; config: JsonObject }>
export type Competitor = CompetitorSpec & Readonly<{ id: string }>

export type GitRevisionPin = Readonly<{
  commit: string
  ref: string
  branch: string
  bay: string
  baseSha?: string
}>

export type TokenCounts = Readonly<{
  input: number | null
  output: number | null
  cachedInput: number | null
  cacheWrite: number | null
  reasoning: number | null
}>

export type UsdCost =
  | Readonly<{ kind: "reported"; usd: number; source: string }>
  | Readonly<{ kind: "missing"; reason: string }>

export type ContestArtifact = Readonly<{ kind: string; uri: string; digest?: string; mediaType?: string }>
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
  harness: string
  run(
    input: ContestRunnerInput,
    context: EffectAdapterContext,
  ): EffectOutcome<AttemptRunOutput> | Promise<EffectOutcome<AttemptRunOutput>>
}>
export type ContestEvaluatorAdapter = Readonly<{
  id: string
  authority: "held-out" | "advisory"
  evaluate(
    input: ContestEvaluatorInput,
    context: EffectAdapterContext,
  ): EffectOutcome<EvaluatorResult> | Promise<EffectOutcome<EvaluatorResult>>
}>
export type ContestGitAdapter = Readonly<{
  resolveCommit(ref: string, context: EffectAdapterContext): string | undefined | Promise<string | undefined>
}>

export type ContestEvaluatorSpec = Readonly<{ id: string; authority: "held-out" | "advisory" }>
export type ContestAttemptFacts = Readonly<{
  id: string
  competitor: Competitor
  bayName: string
  branch: string
  base: string
  bay?: string
}>
export type ContestAttemptRecord = ContestAttemptFacts &
  Readonly<{
    runnerEffect?: string
    evaluationEffects: Readonly<Record<string, string>>
  }>
export type ContestSelection = Readonly<{
  attempt: string
  method: "manual"
  selectedAt: string
  selectedBy?: string
  reason?: string
}>
export type ContestPromotionRequest = Readonly<{ attempt: string; pin: GitRevisionPin; effect?: string }>
export type ContestFacts = Readonly<{
  id: string
  task: Task
  base: string
  baseSha: string
  createdAt: string
  evaluators: readonly ContestEvaluatorSpec[]
  attemptOrder: readonly string[]
}>
export type ContestRecord = ContestFacts &
  Readonly<{
    attempts: Readonly<Record<string, ContestAttemptRecord>>
    selection?: ContestSelection
    promotion?: ContestPromotionRequest
  }>
export type ContestsState = { records: Record<string, ContestRecord> }

export type AttemptProcessStatus = "unrequested" | EffectRun["status"]
export type AttemptProcess = Readonly<{
  status: AttemptProcessStatus
  effect?: string
  run?: Readonly<EffectRun>
  error?: EffectError
}>
export type ContestEvaluation = AttemptProcess &
  Readonly<{ evaluator: string; authority: "held-out" | "advisory"; result?: EvaluatorResult }>
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
export type ContestAttempt = ContestAttemptFacts &
  Readonly<{
    status: ContestAttemptStatus
    runner: AttemptProcess
    evaluations: Readonly<Record<string, ContestEvaluation>>
    pin?: GitRevisionPin
    wallTimeMs?: number
    tokens?: TokenCounts
    cost?: UsdCost
    artifacts: readonly ContestArtifact[]
  }>

export type ContestPromotionOutput = Readonly<{ submission: string; revision: number; commit: string }>
export type ContestPromotion = AttemptProcess &
  Readonly<{ attempt: string; commit: string; ref: string; output?: ContestPromotionOutput }>
export type ContestStatus = "running" | "ready" | "failed" | "selected" | "promoting" | "promoted" | "promotion-failed"
export type Contest = ContestFacts &
  Readonly<{
    attempts: Readonly<Record<string, ContestAttempt>>
    status: ContestStatus
    selection?: ContestSelection
    promotion?: ContestPromotion
  }>

export type TaskCompeteArgs = Readonly<{
  task: Task
  competitors: readonly CompetitorSpec[]
  evaluators?: readonly string[]
  base: string
  baseSha: string
}>
export type ContestSelectArgs = Readonly<{ contest: string; attempt: string; selectedBy?: string; reason?: string }>
export type ContestPromoteArgs = Readonly<{ contest: string }>
export type ContestCommandState = { effects: EffectsState; bays: BaysState; contests: ContestsState }
export type ContestCommands = {
  task: { compete: Command<TaskCompeteArgs, ContestCommandState> }
  contest: {
    request: Command<Readonly<{ contest: string }>, ContestCommandState>
    select: Command<ContestSelectArgs, ContestCommandState>
    promote: Command<ContestPromoteArgs, ContestCommandState>
  }
}
export type ContestRunOptions = Readonly<{
  executor: string
  leaseMs: number
  concurrency: number
  now?: () => number
}>
export type ContestReads = Readonly<{
  resolveBase(base?: string): Promise<Readonly<{ base: string; sha: string }>>
  show(contest: string): Promise<Contest>
  list(): Promise<readonly Contest[]>
  run(contest: string, options: ContestRunOptions): Promise<Contest>
}>
export type HasContests = {
  initialState: { contests: ContestsState }
  commands: ContestCommands
  contests: ContestReads
}
export type WithContestsOptions = Readonly<{
  runners: readonly ContestRunnerAdapter[]
  evaluators: readonly ContestEvaluatorAdapter[]
  git: ContestGitAdapter
  defaultBase?: string
}>
