import { BayIdSchema, GitRefSchema, GitShaSchema, PRIdSchema, type Bay, type BaysState, type PR } from "@yrd/bay"
import { JsonSchema, type CommandHandler, type CommandResult, type DeepReadonly, type JsonValue } from "@yrd/core"
import type { Job, JobContext, JobResult, JobsState, RunJobOptions } from "@yrd/job"
import { TaskSchema } from "@yrd/task"
import type { ReadSignal } from "@silvery/signals"
import * as z from "zod"

const TextSchema = z.string().trim().min(1)
const DefIdSchema = z.string().regex(/^[a-z][a-z0-9._-]*$/iu)
const TimestampSchema = z.iso.datetime({ offset: true })
const JsonObjectSchema = z.record(z.string(), JsonSchema)
const CountSchema = z.number().int().nonnegative().nullable()

export type JsonObject = Readonly<Record<string, JsonValue>>

export const CompetitorDefSchema = z
  .object({ model: TextSchema, harness: DefIdSchema, config: JsonObjectSchema })
  .strict()
export type CompetitorDef = DeepReadonly<z.infer<typeof CompetitorDefSchema>>

export const CompetitorSchema = CompetitorDefSchema.extend({ id: TextSchema }).strict()
export type Competitor = DeepReadonly<z.infer<typeof CompetitorSchema>>

export const GitRevisionPinSchema = z
  .object({
    commit: GitShaSchema,
    ref: z.string().regex(/^refs\/[A-Za-z0-9._/@+-]+$/u),
    branch: GitRefSchema,
    bay: BayIdSchema,
    baseSha: GitShaSchema.optional(),
  })
  .strict()
export type GitRevisionPin = DeepReadonly<z.infer<typeof GitRevisionPinSchema>>

export const TokenCountsSchema = z
  .object({
    input: CountSchema,
    output: CountSchema,
    cachedInput: CountSchema,
    cacheWrite: CountSchema,
    reasoning: CountSchema,
  })
  .strict()
export type TokenCounts = DeepReadonly<z.infer<typeof TokenCountsSchema>>

export const UsdCostSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reported"), usd: z.number().nonnegative(), source: TextSchema }).strict(),
  z.object({ kind: z.literal("missing"), reason: TextSchema }).strict(),
])
export type UsdCost = DeepReadonly<z.infer<typeof UsdCostSchema>>

export const ContestArtifactSchema = z
  .object({ kind: TextSchema, uri: TextSchema, digest: TextSchema.optional(), mediaType: TextSchema.optional() })
  .strict()
export type ContestArtifact = DeepReadonly<z.infer<typeof ContestArtifactSchema>>

export const AttemptRunOutputSchema = z
  .object({
    pin: GitRevisionPinSchema,
    wallTimeMs: z.number().nonnegative(),
    tokens: TokenCountsSchema,
    cost: UsdCostSchema,
    artifacts: z.array(ContestArtifactSchema),
  })
  .strict()
export type AttemptRunOutput = DeepReadonly<z.infer<typeof AttemptRunOutputSchema>>

export const EvaluatorResultSchema = z
  .object({
    verdict: z.enum(["passed", "failed"]),
    summary: z.string().optional(),
    artifacts: z.array(ContestArtifactSchema),
    scores: z.record(z.string(), z.number()).optional(),
  })
  .strict()
export type EvaluatorResult = DeepReadonly<z.infer<typeof EvaluatorResultSchema>>

export const ContestBaySchema = z
  .object({
    id: BayIdSchema,
    name: TextSchema,
    branch: GitRefSchema,
    base: GitRefSchema,
    status: z.enum(["opening", "active", "closing", "closed", "failed"]),
    path: TextSchema.optional(),
    headSha: GitShaSchema.optional(),
    baseSha: GitShaSchema.optional(),
    dirty: z.boolean().optional(),
  })
  .strict()
export type ContestBay = DeepReadonly<z.infer<typeof ContestBaySchema>>

export const ContestRunnerInputSchema = z
  .object({
    contest: TextSchema,
    attempt: TextSchema,
    task: TaskSchema,
    competitor: CompetitorSchema,
    base: GitRefSchema,
    bay: ContestBaySchema,
  })
  .strict()
export type ContestRunnerInput = DeepReadonly<z.infer<typeof ContestRunnerInputSchema>>

export const ContestEvaluatorInputSchema = z
  .object({
    contest: TextSchema,
    attempt: TextSchema,
    task: TaskSchema,
    competitor: CompetitorSchema,
    pin: GitRevisionPinSchema,
    artifacts: z.array(ContestArtifactSchema),
  })
  .strict()
export type ContestEvaluatorInput = DeepReadonly<z.infer<typeof ContestEvaluatorInputSchema>>

export type ContestRunnerDef = Readonly<{
  harness: string
  revision: string
  run(
    input: ContestRunnerInput,
    context: JobContext,
  ): JobResult<AttemptRunOutput> | Promise<JobResult<AttemptRunOutput>>
}>

export type ContestEvaluatorDef = Readonly<{
  id: string
  revision: string
  authority: "held-out" | "advisory"
  evaluate(
    input: ContestEvaluatorInput,
    context: JobContext,
  ): JobResult<EvaluatorResult> | Promise<JobResult<EvaluatorResult>>
}>

export type ContestGit = Readonly<{
  revision: string
  resolveCommit(ref: string, signal?: AbortSignal): string | undefined | Promise<string | undefined>
}>

export const ContestEvaluatorSpecSchema = z
  .object({ id: DefIdSchema, authority: z.enum(["held-out", "advisory"]) })
  .strict()
export type ContestEvaluatorSpec = DeepReadonly<z.infer<typeof ContestEvaluatorSpecSchema>>

export const ContestAttemptRecordSchema = z
  .object({
    id: TextSchema,
    competitor: CompetitorSchema,
    bayName: TextSchema,
    branch: GitRefSchema,
    base: GitRefSchema,
  })
  .strict()
export type ContestAttemptRecord = DeepReadonly<z.infer<typeof ContestAttemptRecordSchema>>

export const ContestSelectionSchema = z
  .object({
    attempt: TextSchema,
    method: z.literal("manual"),
    selectedAt: TimestampSchema,
    selectedBy: TextSchema.optional(),
    reason: TextSchema.optional(),
  })
  .strict()
export type ContestSelection = DeepReadonly<z.infer<typeof ContestSelectionSchema>>

export const ContestPromotionResultSchema = z
  .object({ pr: PRIdSchema, revision: z.number().int().positive(), commit: GitShaSchema, promotedAt: TimestampSchema })
  .strict()
export type ContestPromotionResult = DeepReadonly<z.infer<typeof ContestPromotionResultSchema>>

export const ContestPromotionRecordSchema = z
  .object({
    attempt: TextSchema,
    pin: GitRevisionPinSchema,
    requestedAt: TimestampSchema,
    result: ContestPromotionResultSchema.optional(),
  })
  .strict()
export type ContestPromotionRecord = DeepReadonly<z.infer<typeof ContestPromotionRecordSchema>>

export const ContestRecordSchema = z
  .object({
    id: TextSchema,
    task: TaskSchema,
    base: GitRefSchema,
    baseSha: GitShaSchema,
    createdAt: TimestampSchema,
    evaluators: z.array(ContestEvaluatorSpecSchema),
    attemptOrder: z.array(TextSchema).min(2),
    attempts: z.record(z.string(), ContestAttemptRecordSchema),
    selection: ContestSelectionSchema.optional(),
    promotion: ContestPromotionRecordSchema.optional(),
  })
  .strict()
export type ContestRecord = DeepReadonly<z.infer<typeof ContestRecordSchema>>

export type ContestsState = Readonly<{ records: Readonly<Record<string, ContestRecord>> }>

export type ContestEvaluationRun =
  | Readonly<{ generation: number; job: Extract<Job, { status: "passed" }>; result: EvaluatorResult }>
  | Readonly<{ generation: number; job: Exclude<Job, { status: "passed" }>; result?: never }>

export type ContestEvaluation = Readonly<{
  evaluator: string
  authority: "held-out" | "advisory"
  runs: readonly ContestEvaluationRun[]
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

export type ContestAttempt = ContestAttemptRecord &
  Readonly<{
    status: ContestAttemptStatus
    bay?: Bay
    runner?: Job
    evaluations: Readonly<Record<string, ContestEvaluation>>
    pin?: GitRevisionPin
    wallTimeMs?: number
    tokens?: TokenCounts
    cost?: UsdCost
    artifacts: readonly ContestArtifact[]
  }>

export type ContestPromotion = Readonly<{
  attempt: string
  commit: string
  ref: string
  job?: Job
  pr?: PR
}>

export type ContestStatus = "running" | "ready" | "failed" | "selected" | "promoting" | "promoted" | "promotion-failed"

export type Contest = Omit<ContestRecord, "attempts" | "promotion"> &
  Readonly<{
    attempts: Readonly<Record<string, ContestAttempt>>
    status: ContestStatus
    promotion?: ContestPromotion
  }>

export const CompeteArgsSchema = z
  .object({
    task: TaskSchema,
    competitors: z.array(CompetitorDefSchema).min(2),
    evaluators: z.array(DefIdSchema).optional(),
    base: GitRefSchema,
    baseSha: GitShaSchema,
  })
  .strict()
export type CompeteArgs = DeepReadonly<z.infer<typeof CompeteArgsSchema>>

export const ContestSelectArgsSchema = z
  .object({
    contest: TextSchema,
    attempt: TextSchema,
    selectedBy: TextSchema.optional(),
    reason: TextSchema.optional(),
  })
  .strict()
export type ContestSelectArgs = DeepReadonly<z.infer<typeof ContestSelectArgsSchema>>

export const ContestPromoteArgsSchema = z.object({ contest: TextSchema }).strict()
export type ContestPromoteArgs = DeepReadonly<z.infer<typeof ContestPromoteArgsSchema>>

export type ContestState = Readonly<{ contests: ContestsState }>
export type ContestHostState = Readonly<{ jobs: JobsState; bays: BaysState }>
export type ContestRuntimeState = ContestState & ContestHostState

export type ContestCommands = Readonly<{
  task: Readonly<{ compete: CommandHandler<CompeteArgs, ContestRuntimeState> }>
  contest: Readonly<{
    request: CommandHandler<Readonly<{ contest: string; retry?: boolean }>, ContestRuntimeState>
    select: CommandHandler<ContestSelectArgs, ContestRuntimeState>
    promote: CommandHandler<ContestPromoteArgs, ContestRuntimeState>
    finalize: CommandHandler<Readonly<{ contest: string; pr: string }>, ContestRuntimeState>
  }>
}>

export type ContestEvaluateOptions = RunJobOptions & Readonly<{ concurrency: number; retry?: boolean }>

export type ContestWaitingEvaluation = Readonly<{
  contest: string
  attempt: string
  evaluator: string
  generation: number
  job: Extract<Job, { status: "waiting" }>
}>

export type ContestFinishArgs = Readonly<{
  contest: string
  attempt?: string
  evaluator?: string
  token: string
  result: Exclude<JobResult<EvaluatorResult>, { status: "waiting" }>
}>

export type Contests = Readonly<{
  state: ReadSignal<DeepReadonly<ContestsState>>
  resolveBase(base?: string): Promise<Readonly<{ base: string; sha: string }>>
  get(contest: string): Contest | undefined
  list(): readonly Contest[]
  compete(args: CompeteArgs): Promise<Contest>
  select(args: ContestSelectArgs): Promise<Contest>
  evaluate(contest: string, options: ContestEvaluateOptions): Promise<Contest>
  waiting(contest: string, attempt?: string, evaluator?: string): ContestWaitingEvaluation
  finish(args: ContestFinishArgs): Promise<Contest>
  promote(args: ContestPromoteArgs, options: ContestEvaluateOptions): Promise<Contest>
}>

export type HasContests = Readonly<{ contests: Contests }>

export type ContestActions = Readonly<{
  compete(args: CompeteArgs): Promise<CommandResult>
  request(contest: string, retry?: boolean): Promise<CommandResult>
  select(args: ContestSelectArgs): Promise<CommandResult>
  promote(args: ContestPromoteArgs): Promise<CommandResult>
  finalize(contest: string, pr: string): Promise<CommandResult>
}>

export type WithContestsOptions = Readonly<{
  runners: readonly ContestRunnerDef[]
  evaluators: readonly ContestEvaluatorDef[]
  git: ContestGit
  defaultBase?: string
}>
