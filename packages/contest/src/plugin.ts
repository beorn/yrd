import { createHash } from "node:crypto"
import { defaultBayBranch, resolveBay, submissionForBay, type Bay, type HasBays, type Submission } from "@yrd/bay"
import {
  effect,
  event,
  fx,
  op,
  type AnyYrdApp,
  type DeepReadonly,
  type EffectError,
  type EffectOutcome,
  type EffectRun,
  type ExtendYrdApp,
  type Fx,
  type HasEffects,
  type YrdEvent,
} from "@yrd/core"
import type { HasTasks, Task, TaskRef } from "@yrd/task"
import type {
  AttemptProcess,
  AttemptProcessStatus,
  AttemptRunOutput,
  Competitor,
  CompetitorSpec,
  Contest,
  ContestArtifact,
  ContestCommandState,
  ContestCommands,
  ContestEffects,
  ContestEvaluateArgs,
  ContestEvaluation,
  ContestEvaluatorInput,
  ContestPromotion,
  ContestPromotionOutput,
  ContestPromoteArgs,
  ContestReads,
  ContestRunArgs,
  ContestRunnerInput,
  ContestSelectArgs,
  ContestsState,
  ContestWork,
  EvaluatorResult,
  GitRevisionPin,
  HasContests,
  JsonObject,
  JsonValue,
  ProcessAttemptEvidence,
  TaskCompeteArgs,
  TokenCounts,
  UsdCost,
  WithContestsOptions,
} from "./types.ts"

type ContestAppBase = AnyYrdApp & HasEffects & HasTasks & HasBays
type ContestsApp<App extends ContestAppBase> = ExtendYrdApp<App, { contests: ContestsState }, ContestCommands> &
  Pick<HasContests, "contests" | "contestEffects">

type RunnerRequest = ContestRunnerInput & Readonly<{ kind: "contest-runner" }>
type EvaluatorRequest = ContestEvaluatorInput &
  Readonly<{ kind: "contest-evaluator"; evaluator: string; authority: "held-out" | "advisory" }>
type PromotionRequest = Readonly<{
  kind: "contest-promotion"
  contest: string
  attempt: string
  pin: GitRevisionPin
}>
type ContestEffectRequest = RunnerRequest | EvaluatorRequest | PromotionRequest

const SHA = /^[0-9a-f]{40,64}$/iu
const GIT_REF = /^refs\/[A-Za-z0-9._/@+-]+$/u

const COMPETE_KEYS = new Set(["task", "competitors", "evaluators", "base", "baseSha"])
const COMPETITOR_KEYS = new Set(["model", "harness", "config"])
const TASK_REF_KEYS = new Set(["source", "id"])
const SELECT_KEYS = new Set(["contest", "attempt", "selectedBy", "reason"])
const PROMOTE_KEYS = new Set(["contest"])
const RUN_KEYS = new Set(["contest", "attempt", "bay"])
const EVALUATE_KEYS = new Set(["contest", "attempt", "evaluator"])
const RUN_OUTPUT_KEYS = new Set(["pin", "wallTimeMs", "tokens", "cost", "artifacts"])
const PIN_KEYS = new Set(["commit", "ref", "branch", "bay", "baseSha"])
const TOKEN_KEYS = new Set(["input", "output", "cachedInput", "cacheWrite", "reasoning"])
const COST_KEYS = new Set(["kind", "usd", "source", "reason"])
const ARTIFACT_KEYS = new Set(["kind", "uri", "digest", "mediaType"])
const EVALUATOR_RESULT_KEYS = new Set(["verdict", "summary", "artifacts", "scores"])

function plainObject(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`yrd: ${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`yrd: ${label} must be a plain object`)
  return input as Record<string, unknown>
}

function rejectUnknown(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate))
  if (key !== undefined) throw new Error(`yrd: ${label} has unknown field '${key}'`)
}

function requiredString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim() === "") throw new Error(`yrd: ${label} must be a non-empty string`)
  return input
}

function optionalString(input: unknown, label: string): string | undefined {
  return input === undefined ? undefined : requiredString(input, label)
}

function nonNegativeInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new Error(`yrd: ${label} must be a non-negative safe integer`)
  }
  return input as number
}

function nonNegativeNumber(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new Error(`yrd: ${label} must be a non-negative finite number`)
  }
  return input
}

function parseTaskRef(input: unknown): TaskRef {
  const value = plainObject(input, "task ref")
  rejectUnknown(value, TASK_REF_KEYS, "task ref")
  return { source: requiredString(value.source, "task ref 'source'"), id: requiredString(value.id, "task ref 'id'") }
}

function canonicalJson(input: unknown, label: string): JsonValue {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`yrd: ${label} must contain only finite JSON numbers`)
    return input
  }
  if (Array.isArray(input)) return input.map((item, index) => canonicalJson(item, `${label}[${index}]`))
  const value = plainObject(input, label)
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key], `${label}.${key}`)]),
  )
}

function parseConfig(input: unknown): JsonObject {
  const value = canonicalJson(input, "competitor config")
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("yrd: competitor config must be an object")
  }
  return value as JsonObject
}

function parseCompetitor(input: unknown): CompetitorSpec {
  const value = plainObject(input, "competitor")
  rejectUnknown(value, COMPETITOR_KEYS, "competitor")
  return {
    model: requiredString(value.model, "competitor 'model'"),
    harness: requiredString(value.harness, "competitor 'harness'"),
    config: parseConfig(value.config),
  }
}

function competitorOf(spec: CompetitorSpec): Competitor {
  const identity = JSON.stringify({ model: spec.model, harness: spec.harness, config: spec.config })
  return { ...spec, id: `cmp-${createHash("sha256").update(identity).digest("hex")}` }
}

function parseStringList(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error(`yrd: ${label} must be a non-empty array`)
  const values = input.map((item) => requiredString(item, `${label} entry`))
  if (new Set(values).size !== values.length) throw new Error(`yrd: ${label} contains duplicates`)
  return values
}

function parseCompete(input: unknown): TaskCompeteArgs {
  const value = plainObject(input, "task.compete arguments")
  rejectUnknown(value, COMPETE_KEYS, "task.compete arguments")
  if (!Array.isArray(value.competitors) || value.competitors.length < 2) {
    throw new Error("yrd: task.compete requires at least two competitors")
  }
  const evaluators = value.evaluators === undefined ? undefined : parseStringList(value.evaluators, "evaluators")
  return {
    task: parseTaskRef(value.task),
    competitors: value.competitors.map(parseCompetitor),
    ...(evaluators === undefined ? {} : { evaluators }),
    base: requiredString(value.base, "task.compete 'base'"),
    baseSha: parseCommit(value.baseSha, "task.compete 'baseSha'"),
  }
}

function parseSelect(input: unknown): ContestSelectArgs {
  const value = plainObject(input, "contest.select arguments")
  rejectUnknown(value, SELECT_KEYS, "contest.select arguments")
  const selectedBy = optionalString(value.selectedBy, "contest.select 'selectedBy'")
  const reason = optionalString(value.reason, "contest.select 'reason'")
  return {
    contest: requiredString(value.contest, "contest.select 'contest'"),
    attempt: requiredString(value.attempt, "contest.select 'attempt'"),
    ...(selectedBy === undefined ? {} : { selectedBy }),
    ...(reason === undefined ? {} : { reason }),
  }
}

function parsePromote(input: unknown): ContestPromoteArgs {
  const value = plainObject(input, "contest.promote arguments")
  rejectUnknown(value, PROMOTE_KEYS, "contest.promote arguments")
  return { contest: requiredString(value.contest, "contest.promote 'contest'") }
}

function parseRun(input: unknown): ContestRunArgs {
  const value = plainObject(input, "contest.run arguments")
  rejectUnknown(value, RUN_KEYS, "contest.run arguments")
  return {
    contest: requiredString(value.contest, "contest.run 'contest'"),
    attempt: requiredString(value.attempt, "contest.run 'attempt'"),
    bay: requiredString(value.bay, "contest.run 'bay'"),
  }
}

function parseEvaluate(input: unknown): ContestEvaluateArgs {
  const value = plainObject(input, "contest.evaluate arguments")
  rejectUnknown(value, EVALUATE_KEYS, "contest.evaluate arguments")
  return {
    contest: requiredString(value.contest, "contest.evaluate 'contest'"),
    attempt: requiredString(value.attempt, "contest.evaluate 'attempt'"),
    evaluator: requiredString(value.evaluator, "contest.evaluate 'evaluator'"),
  }
}

function parseCommit(input: unknown, label: string): string {
  const commit = requiredString(input, label)
  if (!SHA.test(commit)) throw new Error(`yrd: ${label} must be a full Git commit SHA`)
  return commit.toLowerCase()
}

function parsePin(input: unknown): GitRevisionPin {
  const value = plainObject(input, "attempt pin")
  rejectUnknown(value, PIN_KEYS, "attempt pin")
  const ref = requiredString(value.ref, "attempt pin 'ref'")
  if (!GIT_REF.test(ref)) throw new Error("yrd: attempt pin 'ref' must be a full Git ref")
  const baseSha = value.baseSha === undefined ? undefined : parseCommit(value.baseSha, "attempt pin 'baseSha'")
  return {
    commit: parseCommit(value.commit, "attempt pin 'commit'"),
    ref,
    branch: requiredString(value.branch, "attempt pin 'branch'"),
    bay: requiredString(value.bay, "attempt pin 'bay'"),
    ...(baseSha === undefined ? {} : { baseSha }),
  }
}

function parseTokens(input: unknown): TokenCounts {
  const value = plainObject(input, "token counts")
  rejectUnknown(value, TOKEN_KEYS, "token counts")
  const count = (field: keyof TokenCounts): number | null =>
    value[field] === null ? null : nonNegativeInteger(value[field], `token count '${field}'`)
  return {
    input: count("input"),
    output: count("output"),
    cachedInput: count("cachedInput"),
    cacheWrite: count("cacheWrite"),
    reasoning: count("reasoning"),
  }
}

function parseCost(input: unknown): UsdCost {
  const value = plainObject(input, "USD cost")
  rejectUnknown(value, COST_KEYS, "USD cost")
  if (value.kind === "reported") {
    return {
      kind: "reported",
      usd: nonNegativeNumber(value.usd, "USD cost 'usd'"),
      source: requiredString(value.source, "USD cost 'source'"),
    }
  }
  if (value.kind === "missing") {
    return { kind: "missing", reason: requiredString(value.reason, "missing USD cost 'reason'") }
  }
  throw new Error("yrd: USD cost 'kind' must be reported or missing")
}

function parseArtifact(input: unknown): ContestArtifact {
  const value = plainObject(input, "contest artifact")
  rejectUnknown(value, ARTIFACT_KEYS, "contest artifact")
  const digest = optionalString(value.digest, "contest artifact 'digest'")
  const mediaType = optionalString(value.mediaType, "contest artifact 'mediaType'")
  return {
    kind: requiredString(value.kind, "contest artifact 'kind'"),
    uri: requiredString(value.uri, "contest artifact 'uri'"),
    ...(digest === undefined ? {} : { digest }),
    ...(mediaType === undefined ? {} : { mediaType }),
  }
}

function parseArtifacts(input: unknown): readonly ContestArtifact[] {
  if (!Array.isArray(input)) throw new Error("yrd: artifacts must be an array")
  return input.map(parseArtifact)
}

function parseRunOutput(input: unknown, expected?: RunnerRequest): AttemptRunOutput {
  const value = plainObject(input, "attempt run output")
  rejectUnknown(value, RUN_OUTPUT_KEYS, "attempt run output")
  const pin = parsePin(value.pin)
  if (expected !== undefined && (pin.bay !== expected.bay.id || pin.branch !== expected.bay.branch)) {
    throw new Error(`yrd: attempt pin does not match Bay '${expected.bay.id}' at '${expected.bay.branch}'`)
  }
  return {
    pin,
    wallTimeMs: nonNegativeNumber(value.wallTimeMs, "attempt wallTimeMs"),
    tokens: parseTokens(value.tokens),
    cost: parseCost(value.cost),
    artifacts: parseArtifacts(value.artifacts),
  }
}

function parseEvaluatorResult(input: unknown): EvaluatorResult {
  const value = plainObject(input, "evaluator result")
  rejectUnknown(value, EVALUATOR_RESULT_KEYS, "evaluator result")
  if (value.verdict !== "passed" && value.verdict !== "failed") {
    throw new Error("yrd: evaluator result 'verdict' must be passed or failed")
  }
  const summary = optionalString(value.summary, "evaluator result 'summary'")
  let scores: Record<string, number> | undefined
  if (value.scores !== undefined) {
    const raw = plainObject(value.scores, "evaluator scores")
    scores = Object.fromEntries(
      Object.entries(raw).map(([name, score]) => [name, nonNegativeNumber(score, `evaluator score '${name}'`)]),
    )
  }
  return {
    verdict: value.verdict,
    ...(summary === undefined ? {} : { summary }),
    artifacts: parseArtifacts(value.artifacts),
    ...(scores === undefined ? {} : { scores }),
  }
}

function parsePromotionOutput(input: unknown): ContestPromotionOutput {
  const value = plainObject(input, "contest promotion output")
  const allowed = new Set(["submission", "revision", "commit"])
  rejectUnknown(value, allowed, "contest promotion output")
  const revision = value.revision
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new Error("yrd: contest promotion output 'revision' must be a positive integer")
  }
  return {
    submission: requiredString(value.submission, "contest promotion output 'submission'"),
    revision: revision as number,
    commit: parseCommit(value.commit, "contest promotion output 'commit'"),
  }
}

function parseAdapterOutcome<Output>(input: unknown, parse: (output: unknown) => Output): EffectOutcome<Output> {
  const value = plainObject(input, "effect adapter outcome")
  if (value.status === "passed") return { status: "passed", output: parse(value.output) }
  if (value.status === "waiting") {
    const url = optionalString(value.url, "effect waiting 'url'")
    const detail = optionalString(value.detail, "effect waiting 'detail'")
    const artifacts = value.artifacts === undefined ? undefined : parseArtifacts(value.artifacts)
    return {
      status: "waiting",
      token: requiredString(value.token, "effect waiting 'token'"),
      ...(url === undefined ? {} : { url }),
      ...(detail === undefined ? {} : { detail }),
      ...(artifacts === undefined ? {} : { artifacts }),
    }
  }
  if (value.status === "failed") {
    const error = plainObject(value.error, "effect error")
    return {
      status: "failed",
      error: {
        code: requiredString(error.code, "effect error 'code'"),
        message: requiredString(error.message, "effect error 'message'"),
      },
    }
  }
  throw new Error("yrd: effect adapter outcome status must be passed, failed, or waiting")
}

function own<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function taskAt(state: DeepReadonly<ContestCommandState>, ref: TaskRef): Task | undefined {
  const source = own(state.tasks.bySource, ref.source)
  return source === undefined ? undefined : (own(source, ref.id) as Task | undefined)
}

function taskKey(ref: TaskRef): string {
  return `${ref.source}:${ref.id}`
}

function nextId(prefix: string, records: Readonly<Record<string, unknown>>): string {
  let largest = 0
  for (const id of Object.keys(records)) {
    const match = new RegExp(`^${prefix}(\\d+)$`, "u").exec(id)
    if (match !== null) largest = Math.max(largest, Number(match[1]))
  }
  return `${prefix}${largest + 1}`
}

function contestsOf(state: unknown): ContestsState {
  return (state as { contests: ContestsState }).contests
}

function requiredContest(state: DeepReadonly<ContestsState>, id: string): DeepReadonly<Contest> {
  const contest = own(state.records, id)
  if (contest === undefined) throw new Error(`yrd: no contest '${id}'`)
  return contest
}

function requiredAttempt(contest: DeepReadonly<Contest>, id: string) {
  const attempt = own(contest.attempts, id)
  if (attempt === undefined) throw new Error(`yrd: contest '${contest.id}' has no attempt '${id}'`)
  return attempt
}

function emptyProcess(): AttemptProcess {
  return { status: "unrequested", attempt: 0, history: [] }
}

function effectError(run: EffectRun): EffectError | undefined {
  if (run.status === "failed") return run.error ?? { code: "effect-failed", message: "effect failed without detail" }
  if (run.status === "lost") return { code: "effect-lost", message: run.lostReason ?? "effect executor was lost" }
  return undefined
}

function processEvidence(
  previous: AttemptProcess | ContestEvaluation,
  run: EffectRun,
  applied: YrdEvent,
): AttemptProcess {
  const terminal = run.status === "passed" || run.status === "failed" || run.status === "lost"
  const error = effectError(run)
  const existing = previous.history.find((entry) => entry.attempt === run.attempt)
  const resetCurrent = applied.name === "effect/retried" || applied.name === "effect/started"
  const finishedAt = terminal ? applied.ts : resetCurrent ? undefined : previous.finishedAt
  const evidence: ProcessAttemptEvidence | undefined =
    terminal && existing === undefined
      ? {
          attempt: run.attempt,
          status: run.status as ProcessAttemptEvidence["status"],
          ...(run.executor === undefined ? {} : { executor: run.executor }),
          ...(run.token === undefined ? {} : { token: run.token }),
          ...(run.url === undefined ? {} : { url: run.url }),
          ...(run.detail === undefined ? {} : { detail: run.detail }),
          ...(run.artifacts === undefined ? {} : { artifacts: parseArtifacts(run.artifacts) }),
          ...(previous.startedAt === undefined ? {} : { startedAt: previous.startedAt }),
          finishedAt: applied.ts,
          ...(error === undefined ? {} : { error }),
        }
      : undefined
  return {
    status: run.status,
    effect: run.id,
    attempt: run.attempt,
    ...(run.executor === undefined ? {} : { executor: run.executor }),
    ...(run.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: run.leaseExpiresAt }),
    ...(run.token === undefined ? {} : { token: run.token }),
    ...(run.url === undefined ? {} : { url: run.url }),
    ...(run.detail === undefined ? {} : { detail: run.detail }),
    ...(run.artifacts === undefined ? {} : { artifacts: parseArtifacts(run.artifacts) }),
    ...(applied.name === "effect/started"
      ? { startedAt: applied.ts }
      : previous.startedAt === undefined
        ? {}
        : { startedAt: previous.startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(error === undefined ? {} : { error }),
    history: evidence === undefined ? previous.history : [...previous.history, evidence],
  }
}

function invalidProcess(previous: AttemptProcess, run: EffectRun, applied: YrdEvent, error: Error): AttemptProcess {
  const failure = { code: "invalid-effect-output", message: error.message }
  const history = previous.history.filter((entry) => entry.attempt !== run.attempt)
  return {
    ...previous,
    status: "failed",
    finishedAt: applied.ts,
    error: failure,
    history: [
      ...history,
      {
        attempt: run.attempt,
        status: "failed",
        ...(run.executor === undefined ? {} : { executor: run.executor }),
        ...(previous.startedAt === undefined ? {} : { startedAt: previous.startedAt }),
        finishedAt: applied.ts,
        error: failure,
      },
    ],
  }
}

function evaluationProcess(
  previous: ContestEvaluation,
  process: AttemptProcess,
  result?: EvaluatorResult,
): ContestEvaluation {
  return {
    evaluator: previous.evaluator,
    authority: previous.authority,
    ...process,
    ...(result === undefined ? {} : { result }),
  }
}

function deriveAttempt(attempt: Contest["attempts"][string]): Contest["attempts"][string] {
  let status = attempt.status
  if (attempt.runner.status === "unrequested") status = "preparing"
  else if (attempt.runner.status === "requested") status = "queued"
  else if (attempt.runner.status === "running") status = "running"
  else if (attempt.runner.status === "waiting") status = "waiting"
  else if (attempt.runner.status === "lost") status = "lost"
  else if (attempt.runner.status === "failed") status = "failed"
  else {
    const evaluations = Object.values(attempt.evaluations).filter((evaluation) => evaluation.authority === "held-out")
    if (evaluations.some((evaluation) => evaluation.status === "lost")) status = "lost"
    else if (evaluations.some((evaluation) => evaluation.status === "failed")) status = "failed"
    else if (evaluations.some((evaluation) => evaluation.status === "waiting")) status = "waiting"
    else if (evaluations.some((evaluation) => evaluation.status !== "passed")) status = "evaluating"
    else if (evaluations.some((evaluation) => evaluation.result?.verdict !== "passed")) status = "rejected"
    else status = "passing"
  }
  return status === attempt.status ? attempt : { ...attempt, status }
}

function deriveContest(contest: Contest): Contest {
  let status: Contest["status"]
  if (contest.promotion?.status === "passed") status = "promoted"
  else if (
    contest.promotion !== undefined &&
    (contest.promotion.status === "requested" ||
      contest.promotion.status === "running" ||
      contest.promotion.status === "waiting")
  )
    status = "promoting"
  else if (contest.promotion?.status === "failed" || contest.promotion?.status === "lost") status = "promotion-failed"
  else if (contest.selection !== undefined) status = "selected"
  else {
    const attempts = contest.attemptOrder.map((id) => contest.attempts[id]!)
    const terminal = attempts.every((attempt) => ["passing", "rejected", "failed", "lost"].includes(attempt.status))
    status = terminal ? (attempts.some((attempt) => attempt.status === "passing") ? "ready" : "failed") : "running"
  }
  return status === contest.status ? contest : { ...contest, status }
}

function replaceAttempt(contest: Contest, attempt: Contest["attempts"][string]): Contest {
  return deriveContest({ ...contest, attempts: { ...contest.attempts, [attempt.id]: deriveAttempt(attempt) } })
}

function replaceContest(state: ContestsState, contest: Contest): ContestsState {
  return { records: { ...state.records, [contest.id]: deriveContest(contest) } }
}

function pinConflict(state: ContestsState, contestId: string, attemptId: string, pin: GitRevisionPin): boolean {
  return Object.values(state.records).some((contest) =>
    Object.values(contest.attempts).some(
      (attempt) =>
        (contest.id !== contestId || attempt.id !== attemptId) &&
        attempt.pin?.ref === pin.ref &&
        attempt.pin.commit !== pin.commit,
    ),
  )
}

function contestRequest(run: EffectRun): ContestEffectRequest | undefined {
  if (typeof run.input !== "object" || run.input === null || Array.isArray(run.input)) return undefined
  const kind = (run.input as { kind?: unknown }).kind
  return kind === "contest-runner" || kind === "contest-evaluator" || kind === "contest-promotion"
    ? (run.input as ContestEffectRequest)
    : undefined
}

function projectRunnerEffect(
  state: ContestsState,
  run: EffectRun,
  input: RunnerRequest,
  applied: YrdEvent,
): ContestsState {
  const contest = state.records[input.contest]
  const current = contest?.attempts[input.attempt]
  if (contest === undefined || current === undefined) return state
  let runner = processEvidence(current.runner, run, applied)
  let next = { ...current, bay: input.bay.id, runner }
  if (run.status === "passed") {
    try {
      const output = parseRunOutput(run.output, input)
      if (pinConflict(state, contest.id, current.id, output.pin)) {
        throw new Error(`yrd: Git ref '${output.pin.ref}' is already pinned to a different commit`)
      }
      next = {
        ...next,
        pin: output.pin,
        wallTimeMs: output.wallTimeMs,
        tokens: output.tokens,
        cost: output.cost,
        artifacts: output.artifacts,
      }
    } catch (error) {
      runner = invalidProcess(runner, run, applied, error instanceof Error ? error : new Error(String(error)))
      next = { ...next, runner }
    }
  }
  return replaceContest(state, replaceAttempt(contest, next))
}

function projectEvaluatorEffect(
  state: ContestsState,
  run: EffectRun,
  input: EvaluatorRequest,
  applied: YrdEvent,
): ContestsState {
  const contest = state.records[input.contest]
  const attempt = contest?.attempts[input.attempt]
  const current = attempt?.evaluations[input.evaluator]
  if (contest === undefined || attempt === undefined || current === undefined) return state
  let process = processEvidence(current, run, applied)
  let result: EvaluatorResult | undefined
  if (run.status === "passed") {
    try {
      result = parseEvaluatorResult(run.output)
    } catch (error) {
      process = invalidProcess(process, run, applied, error instanceof Error ? error : new Error(String(error)))
    }
  }
  const evaluation = evaluationProcess(current, process, result)
  const next = { ...attempt, evaluations: { ...attempt.evaluations, [input.evaluator]: evaluation } }
  return replaceContest(state, replaceAttempt(contest, next))
}

function projectPromotionEffect(
  state: ContestsState,
  run: EffectRun,
  input: PromotionRequest,
  applied: YrdEvent,
): ContestsState {
  const contest = state.records[input.contest]
  if (contest?.promotion === undefined || contest.promotion.attempt !== input.attempt) return state
  const previous: AttemptProcess = {
    status: contest.promotion.status,
    ...(contest.promotion.effect === undefined ? {} : { effect: contest.promotion.effect }),
    attempt: contest.promotion.attemptNumber,
    ...(contest.promotion.executor === undefined ? {} : { executor: contest.promotion.executor }),
    ...(contest.promotion.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: contest.promotion.leaseExpiresAt }),
    ...(contest.promotion.token === undefined ? {} : { token: contest.promotion.token }),
    ...(contest.promotion.url === undefined ? {} : { url: contest.promotion.url }),
    ...(contest.promotion.detail === undefined ? {} : { detail: contest.promotion.detail }),
    ...(contest.promotion.artifacts === undefined ? {} : { artifacts: contest.promotion.artifacts }),
    ...(contest.promotion.startedAt === undefined ? {} : { startedAt: contest.promotion.startedAt }),
    ...(contest.promotion.finishedAt === undefined ? {} : { finishedAt: contest.promotion.finishedAt }),
    ...(contest.promotion.error === undefined ? {} : { error: contest.promotion.error }),
    history: contest.promotion.history,
  }
  let process = processEvidence(previous, run, applied)
  let output: ContestPromotionOutput | undefined
  if (run.status === "passed") {
    try {
      output = parsePromotionOutput(run.output)
      if (output.commit !== contest.promotion.commit) throw new Error("yrd: promoted commit does not match selection")
    } catch (error) {
      process = invalidProcess(process, run, applied, error instanceof Error ? error : new Error(String(error)))
    }
  }
  const promotion: ContestPromotion = {
    attempt: contest.promotion.attempt,
    commit: contest.promotion.commit,
    ref: contest.promotion.ref,
    status: process.status,
    ...(process.effect === undefined ? {} : { effect: process.effect }),
    attemptNumber: process.attempt,
    ...(process.executor === undefined ? {} : { executor: process.executor }),
    ...(process.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: process.leaseExpiresAt }),
    ...(process.token === undefined ? {} : { token: process.token }),
    ...(process.url === undefined ? {} : { url: process.url }),
    ...(process.detail === undefined ? {} : { detail: process.detail }),
    ...(process.artifacts === undefined ? {} : { artifacts: process.artifacts }),
    ...(process.startedAt === undefined ? {} : { startedAt: process.startedAt }),
    ...(process.finishedAt === undefined ? {} : { finishedAt: process.finishedAt }),
    ...(output === undefined ? {} : { output }),
    ...(process.error === undefined ? {} : { error: process.error }),
    history: process.history,
  }
  return replaceContest(state, { ...contest, promotion })
}

function projectContestState(state: ContestsState, applied: YrdEvent, runs: Record<string, EffectRun>): ContestsState {
  if (applied.name === "contest/opened") {
    const opened = (applied.data as { contest: Omit<Contest, "createdAt"> }).contest
    return replaceContest(state, { ...opened, createdAt: applied.ts })
  }
  if (applied.name === "contest/selected") {
    const data = applied.data as ContestSelectArgs
    const contest = state.records[data.contest]
    if (contest === undefined) return state
    return replaceContest(state, {
      ...contest,
      selection: {
        attempt: data.attempt,
        method: "manual",
        selectedAt: applied.ts,
        ...(data.selectedBy === undefined ? {} : { selectedBy: data.selectedBy }),
        ...(data.reason === undefined ? {} : { reason: data.reason }),
      },
    })
  }
  if (applied.name === "contest/promotion-requested") {
    const data = applied.data as PromotionRequest
    const contest = state.records[data.contest]
    if (contest === undefined) return state
    return replaceContest(state, {
      ...contest,
      promotion: {
        attempt: data.attempt,
        commit: data.pin.commit,
        ref: data.pin.ref,
        status: "unrequested",
        attemptNumber: 0,
        history: [],
      },
    })
  }
  if (!applied.name.startsWith("effect/")) return state
  const id = (applied.data as { id?: unknown }).id
  if (typeof id !== "string") return state
  const run = runs[id]
  if (run === undefined) return state
  const input = contestRequest(run)
  if (input === undefined) return state
  if (input.kind === "contest-runner") return projectRunnerEffect(state, run, input, applied)
  if (input.kind === "contest-evaluator") return projectEvaluatorEffect(state, run, input, applied)
  return projectPromotionEffect(state, run, input, applied)
}

function adapterMap<Value extends { readonly [Key in Name]: string }, Name extends string>(
  values: readonly Value[],
  key: Name,
  label: string,
): Map<string, Value> {
  const result = new Map<string, Value>()
  for (const value of values) {
    const id = requiredString(value[key], `${label} id`)
    if (result.has(id)) throw new Error(`yrd: duplicate ${label} '${id}'`)
    result.set(id, value)
  }
  return result
}

function effectPath(kind: string, id: string): readonly string[] {
  return ["contest", kind, `${kind}-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`]
}

function failed(code: string, message: string): EffectOutcome<never> {
  return { status: "failed", error: { code, message } }
}

function exactSubmission(submission: Submission | undefined, pin: GitRevisionPin): submission is Submission {
  return submission !== undefined && submission.headSha === pin.commit && submission.branch === pin.branch
}

function baySnapshot(bay: DeepReadonly<Bay>): Bay {
  return {
    id: bay.id,
    name: bay.name,
    branch: bay.branch,
    base: bay.base,
    status: bay.status,
    openedAt: bay.openedAt,
    refreshedAt: bay.refreshedAt,
    ...(bay.task === undefined ? {} : { task: bay.task }),
    ...(bay.actor === undefined ? {} : { actor: bay.actor }),
    ...(bay.from === undefined ? {} : { from: bay.from }),
    ...(bay.path === undefined ? {} : { path: bay.path }),
    ...(bay.headSha === undefined ? {} : { headSha: bay.headSha }),
    ...(bay.baseSha === undefined ? {} : { baseSha: bay.baseSha }),
    ...(bay.dirty === undefined ? {} : { dirty: bay.dirty }),
    ...(bay.effectId === undefined ? {} : { effectId: bay.effectId }),
    ...(bay.closedAt === undefined ? {} : { closedAt: bay.closedAt }),
    ...(bay.failure === undefined ? {} : { failure: bay.failure }),
  }
}

/** Install contest orchestration over the existing task, Bay, and durable-effect capabilities. */
export function withContests(options: WithContestsOptions) {
  const runners = adapterMap(options.runners, "harness", "contest runner")
  const evaluators = adapterMap(options.evaluators, "id", "contest evaluator")
  if (![...evaluators.values()].some((evaluator) => evaluator.authority === "held-out")) {
    throw new Error("yrd: withContests requires at least one held-out evaluator")
  }
  const defaultBase = options.defaultBase ?? "main"

  return <App extends ContestAppBase>(app: App): ContestsApp<App> => {
    Object.assign(app.initialState, { contests: { records: {} } satisfies ContestsState })

    const runnerEffects = new Map<string, Fx<RunnerRequest, EffectOutcome<AttemptRunOutput>>>()
    for (const adapter of runners.values()) {
      const runner = fx(
        async (input: RunnerRequest, context) =>
          parseAdapterOutcome(await adapter.run(input, context), (output) => parseRunOutput(output, input)),
        { title: `Run contest attempt with ${adapter.harness}` },
      )
      app.effectRuns.register(effectPath("runner", adapter.harness), runner)
      runnerEffects.set(adapter.harness, runner)
    }

    const evaluatorEffects = new Map<string, Fx<EvaluatorRequest, EffectOutcome<EvaluatorResult>>>()
    for (const adapter of evaluators.values()) {
      const evaluator = fx(
        async (input: EvaluatorRequest, context) =>
          parseAdapterOutcome(await adapter.evaluate(input, context), parseEvaluatorResult),
        { title: `Evaluate contest attempt with ${adapter.id}` },
      )
      app.effectRuns.register(effectPath("evaluator", adapter.id), evaluator)
      evaluatorEffects.set(adapter.id, evaluator)
    }

    const promotion = fx(
      async (input: PromotionRequest, context): Promise<EffectOutcome<ContestPromotionOutput>> => {
        try {
          const state = await app.state()
          const contest = requiredContest(state.contests, input.contest)
          if (contest.selection?.attempt !== input.attempt) {
            return failed("selection-changed", `contest '${input.contest}' no longer selects '${input.attempt}'`)
          }
          const attempt = requiredAttempt(contest, input.attempt)
          if (attempt.status !== "passing" || attempt.pin === undefined) {
            return failed("attempt-not-passing", `attempt '${input.attempt}' is ${attempt.status}, not passing`)
          }
          if (attempt.pin.commit !== input.pin.commit || attempt.pin.ref !== input.pin.ref) {
            return failed("selection-changed", `attempt '${input.attempt}' pin changed after promotion was requested`)
          }
          const resolved = await options.git.resolveCommit(input.pin.ref, context)
          if (resolved === undefined || resolved.toLowerCase() !== input.pin.commit) {
            return failed(
              "pin-moved",
              `Git ref '${input.pin.ref}' resolves to '${resolved ?? "missing"}', expected '${input.pin.commit}'`,
            )
          }

          let current = await app.state()
          const bay = resolveBay(current.bays, input.pin.bay)
          if (bay === undefined) return failed("bay-missing", `selected Bay '${input.pin.bay}' no longer exists`)
          if (bay.branch !== input.pin.branch) {
            return failed(
              "bay-mismatch",
              `selected Bay '${bay.id}' is on '${bay.branch}', expected '${input.pin.branch}'`,
            )
          }

          let submission = submissionForBay(current.bays, bay.id)
          if (!exactSubmission(submission, input.pin) || submission.status === "rejected") {
            await app.command(app.commands.bay.intake, {
              bay: bay.id,
              headSha: input.pin.commit,
              ...(input.pin.baseSha === undefined ? {} : { baseSha: input.pin.baseSha }),
            })
            current = await app.state()
            submission = submissionForBay(current.bays, bay.id)
          }
          if (!exactSubmission(submission, input.pin)) {
            return failed("submission-mismatch", `Bay '${bay.id}' did not retain selected commit '${input.pin.commit}'`)
          }
          if (submission.status === "pushed") {
            await app.command(app.commands.bay.submit, { submission: submission.id })
            current = await app.state()
            submission = submissionForBay(current.bays, bay.id)
          }
          if (
            !exactSubmission(submission, input.pin) ||
            (submission.status !== "submitted" && submission.status !== "integrated")
          ) {
            return failed(
              "submission-not-ready",
              `selected commit '${input.pin.commit}' was not submitted through Bay '${bay.id}'`,
            )
          }
          return {
            status: "passed",
            output: { submission: submission.id, revision: submission.revision, commit: submission.headSha },
          }
        } catch (error) {
          return failed("promotion-error", error instanceof Error ? error.message : String(error))
        }
      },
      { title: "Promote selected contest attempt through Bay" },
    )
    app.effectRuns.register(["contest", "promotion"], promotion)

    const compete = op(
      (state: DeepReadonly<ContestCommandState>, args: TaskCompeteArgs) => {
        const task = taskAt(state, args.task)
        if (task === undefined) throw new Error(`yrd: task '${taskKey(args.task)}' is not recorded`)
        const competitors = args.competitors.map(competitorOf)
        const duplicate = competitors.find(
          (competitor, index) => competitors.findIndex((candidate) => candidate.id === competitor.id) !== index,
        )
        if (duplicate !== undefined) throw new Error(`yrd: duplicate competitor identity '${duplicate.id}'`)
        for (const competitor of competitors) {
          if (!runners.has(competitor.harness)) {
            throw new Error(`yrd: no contest runner '${competitor.harness}' is registered`)
          }
        }
        const evaluatorIds = args.evaluators ?? [...evaluators.keys()]
        const selectedEvaluators = evaluatorIds.map((id) => {
          const adapter = evaluators.get(id)
          if (adapter === undefined) throw new Error(`yrd: no contest evaluator '${id}' is registered`)
          return { id, authority: adapter.authority }
        })
        if (!selectedEvaluators.some((evaluator) => evaluator.authority === "held-out")) {
          throw new Error("yrd: task.compete requires at least one held-out evaluator")
        }
        const id = nextId("C", state.contests.records)
        const base = args.base
        const attempts = Object.fromEntries(
          competitors.map((competitor, index) => {
            const attempt = `A${index + 1}`
            return [
              attempt,
              {
                id: attempt,
                competitor,
                bayName: `contest-${id.toLowerCase()}-${attempt.toLowerCase()}`,
                branch: defaultBayBranch(`contest-${id.toLowerCase()}-${attempt.toLowerCase()}`),
                base,
                status: "preparing" as const,
                runner: emptyProcess(),
                evaluations: Object.fromEntries(
                  selectedEvaluators.map((evaluator) => [
                    evaluator.id,
                    {
                      evaluator: evaluator.id,
                      authority: evaluator.authority,
                      status: "unrequested" as const,
                      attempt: 0,
                      history: [],
                    },
                  ]),
                ),
                artifacts: [],
              },
            ]
          }),
        )
        const contest: Omit<Contest, "createdAt"> = {
          id,
          task: task as Task,
          base,
          baseSha: args.baseSha,
          evaluators: selectedEvaluators,
          attemptOrder: Object.keys(attempts),
          attempts,
          status: "running",
        }
        return { events: [event("contest/opened", { contest })], effects: [] }
      },
      {
        title: "Compete on a real task",
        description: "Create isolated Bay attempts for model + harness + config competitors",
        visibility: "public",
        args: { parse: parseCompete },
      },
    )

    const run = op(
      (state: DeepReadonly<ContestCommandState>, args: ContestRunArgs) => {
        const contest = requiredContest(state.contests, args.contest)
        const attempt = requiredAttempt(contest, args.attempt)
        if (attempt.runner.effect !== undefined) return { events: [], effects: [] }
        const bay = resolveBay(state.bays as never, args.bay)
        if (bay === undefined) throw new Error(`yrd: no bay '${args.bay}'`)
        if (bay.status !== "active") throw new Error(`yrd: bay '${bay.id}' is ${bay.status}, not active`)
        if (bay.name !== attempt.bayName || bay.branch !== attempt.branch || bay.base !== attempt.base) {
          throw new Error(`yrd: bay '${bay.id}' does not match contest attempt '${attempt.id}'`)
        }
        const runner = runnerEffects.get(attempt.competitor.harness)
        if (runner === undefined)
          throw new Error(`yrd: no contest runner '${attempt.competitor.harness}' is registered`)
        const input: RunnerRequest = {
          kind: "contest-runner",
          contest: contest.id,
          attempt: attempt.id,
          task: contest.task as Task,
          competitor: attempt.competitor as Competitor,
          base: contest.base,
          bay: baySnapshot(bay),
        }
        return { events: [], effects: [effect(runner, input, `contest:${contest.id}:${attempt.id}:runner`)] }
      },
      { title: "Schedule contest runner", args: { parse: parseRun } },
    )

    const evaluate = op(
      (state: DeepReadonly<ContestCommandState>, args: ContestEvaluateArgs) => {
        const contest = requiredContest(state.contests, args.contest)
        const attempt = requiredAttempt(contest, args.attempt)
        if (attempt.runner.status !== "passed" || attempt.pin === undefined) {
          throw new Error(`yrd: contest attempt '${attempt.id}' has no passing pinned runner result`)
        }
        const current = own(attempt.evaluations, args.evaluator)
        if (current === undefined)
          throw new Error(`yrd: contest '${contest.id}' does not use evaluator '${args.evaluator}'`)
        if (current.effect !== undefined) return { events: [], effects: [] }
        const evaluator = evaluatorEffects.get(args.evaluator)
        if (evaluator === undefined) throw new Error(`yrd: no contest evaluator '${args.evaluator}' is registered`)
        const input: EvaluatorRequest = {
          kind: "contest-evaluator",
          contest: contest.id,
          attempt: attempt.id,
          evaluator: current.evaluator,
          authority: current.authority,
          task: contest.task as Task,
          competitor: attempt.competitor as Competitor,
          pin: attempt.pin as GitRevisionPin,
          artifacts: attempt.artifacts,
        }
        return {
          events: [],
          effects: [effect(evaluator, input, `contest:${contest.id}:${attempt.id}:evaluator:${args.evaluator}`)],
        }
      },
      { title: "Schedule contest evaluator", args: { parse: parseEvaluate } },
    )

    const select = op(
      (state: DeepReadonly<ContestCommandState>, args: ContestSelectArgs) => {
        const contest = requiredContest(state.contests, args.contest)
        requiredAttempt(contest, args.attempt)
        if (contest.promotion !== undefined) {
          throw new Error(`yrd: contest '${contest.id}' already requested promotion; selection is frozen`)
        }
        return { events: [event("contest/selected", args)], effects: [] }
      },
      {
        title: "Select contest winner",
        description: "Record a manual winner without automatic or LLM-judge authority",
        visibility: "public",
        args: { parse: parseSelect },
      },
    )

    const promote = op(
      (state: DeepReadonly<ContestCommandState>, args: ContestPromoteArgs) => {
        const contest = requiredContest(state.contests, args.contest)
        if (contest.selection === undefined) throw new Error(`yrd: contest '${contest.id}' has no selected attempt`)
        const attempt = requiredAttempt(contest, contest.selection.attempt)
        if (attempt.pin === undefined) throw new Error(`yrd: selected attempt '${attempt.id}' has no immutable Git pin`)
        if (attempt.status !== "passing") {
          throw new Error(`yrd: selected attempt '${attempt.id}' is ${attempt.status}, not passing`)
        }
        if (contest.promotion !== undefined) {
          if (contest.promotion.status === "passed") return { events: [], effects: [] }
          throw new Error(
            `yrd: contest '${contest.id}' promotion is ${contest.promotion.status}; retry its durable effect instead`,
          )
        }
        const input: PromotionRequest = {
          kind: "contest-promotion",
          contest: contest.id,
          attempt: attempt.id,
          pin: attempt.pin as GitRevisionPin,
        }
        return {
          events: [event("contest/promotion-requested", input)],
          effects: [effect(promotion, input, `contest:${contest.id}:${attempt.id}:promotion:${attempt.pin.commit}`)],
        }
      },
      {
        title: "Promote selected contest winner",
        description: "Verify and submit the selected immutable revision through Bay",
        visibility: "public",
        args: { parse: parsePromote },
      },
    )

    Object.assign(app.commands.task, { compete })
    Object.assign(app.commands, { contest: { run, evaluate, select, promote } })

    const project = app.project
    app.project = (state, applied) => {
      const projected = project(state, applied)
      const current = contestsOf(projected)
      const runs = (projected as { effects: { runs: Record<string, EffectRun> } }).effects.runs
      const next = projectContestState(current, applied, runs)
      return next === current ? projected : { ...projected, contests: next }
    }

    const reads: ContestReads = {
      async resolveBase(input) {
        const base = input ?? defaultBase
        const resolved = await options.git.resolveCommit(base, {
          id: `contest-base:${base}`,
          attempt: 1,
          executor: "contest-base-resolver",
        })
        if (resolved === undefined) throw new Error(`yrd: no Git commit '${base}'`)
        return { base, sha: parseCommit(resolved, `resolved base '${base}'`) }
      },
      async show(id) {
        return requiredContest((await app.state()).contests, requiredString(id, "contest id")) as Contest
      },
      async list() {
        const records = (await app.state()).contests.records
        return Object.keys(records)
          .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
          .map((id) => records[id]!)
      },
    }

    const controls: ContestEffects = {
      async reconcile(selector) {
        const initial = await app.state()
        const ids =
          selector === undefined
            ? Object.keys(initial.contests.records)
            : [requiredContest(initial.contests, requiredString(selector, "contest id")).id]
        for (const id of ids) {
          const snapshot = requiredContest((await app.state()).contests, id)
          for (const attemptId of snapshot.attemptOrder) {
            let state = await app.state()
            let contest = requiredContest(state.contests, id)
            let attempt = requiredAttempt(contest, attemptId)
            let bay = resolveBay(state.bays, attempt.bay ?? attempt.bayName)
            if (bay === undefined) {
              await app.command(app.commands.bay.open, {
                name: attempt.bayName,
                task: taskKey(contest.task.ref),
                actor: attempt.competitor.id,
                base: attempt.base,
                baseSha: contest.baseSha,
              })
              state = await app.state()
              contest = requiredContest(state.contests, id)
              attempt = requiredAttempt(contest, attemptId)
              bay = resolveBay(state.bays, attempt.bayName)
            }
            if (bay?.status === "active" && attempt.runner.effect === undefined) {
              await app.command(run, { contest: id, attempt: attemptId, bay: bay.id })
              state = await app.state()
              contest = requiredContest(state.contests, id)
              attempt = requiredAttempt(contest, attemptId)
            }
            if (attempt.runner.status === "passed" && attempt.pin !== undefined) {
              for (const evaluator of Object.values(attempt.evaluations)) {
                if (evaluator.effect === undefined) {
                  await app.command(evaluate, { contest: id, attempt: attemptId, evaluator: evaluator.evaluator })
                }
              }
            }
          }
        }

        const state = await app.state()
        const work: ContestWork[] = []
        for (const id of ids) {
          const contest = requiredContest(state.contests, id)
          for (const attemptId of contest.attemptOrder) {
            const attempt = requiredAttempt(contest, attemptId)
            const bay = resolveBay(state.bays, attempt.bay ?? attempt.bayName)
            if (bay?.effectId !== undefined) {
              const run = state.effects.runs[bay.effectId]
              if (run !== undefined) {
                work.push({ contest: id, attempt: attemptId, kind: "bay", ...workFields(run) })
              }
            }
            if (attempt.runner.effect !== undefined) {
              const run = state.effects.runs[attempt.runner.effect]
              if (run !== undefined) work.push({ contest: id, attempt: attemptId, kind: "runner", ...workFields(run) })
            }
            for (const evaluation of Object.values(attempt.evaluations)) {
              if (evaluation.effect === undefined) continue
              const run = state.effects.runs[evaluation.effect]
              if (run !== undefined) {
                work.push({
                  contest: id,
                  attempt: attemptId,
                  kind: "evaluator",
                  evaluator: evaluation.evaluator,
                  ...workFields(run),
                })
              }
            }
          }
          if (contest.promotion?.effect !== undefined) {
            const run = state.effects.runs[contest.promotion.effect]
            if (run !== undefined) {
              work.push({ contest: id, attempt: contest.promotion.attempt, kind: "promotion", ...workFields(run) })
            }
          }
        }
        return work
      },
    }

    Object.assign(app, { contests: reads, contestEffects: controls })
    return app as unknown as ContestsApp<App>
  }
}

function workFields(run: EffectRun): Pick<ContestWork, "effect" | "status" | "token" | "url"> {
  return {
    effect: run.id,
    status: run.status as AttemptProcessStatus,
    ...(run.token === undefined ? {} : { token: run.token }),
    ...(run.url === undefined ? {} : { url: run.url }),
  }
}
