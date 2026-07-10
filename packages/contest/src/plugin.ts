import { createHash } from "node:crypto"
import { defaultBayBranch, submissionForBay, type Bay, type HasBays, type Submission } from "@yrd/bay"
import {
  effect,
  event,
  fx,
  op,
  type AnyYrdApp,
  type DeepReadonly,
  type EffectError,
  type EffectOutcome,
  type EffectRequest,
  type EffectRun,
  type ExtendYrdApp,
  type Fx,
  type HasEffects,
  type YrdEvent,
} from "@yrd/core"
import { Task as TaskDomain, type HasTasks, type Task } from "@yrd/task"
import type {
  AttemptProcess,
  AttemptRunOutput,
  Competitor,
  CompetitorSpec,
  Contest,
  ContestArtifact,
  ContestAttempt,
  ContestAttemptRecord,
  ContestCommandState,
  ContestCommands,
  ContestEvaluation,
  ContestEvaluatorInput,
  ContestGitAdapter,
  ContestPromotion,
  ContestPromotionOutput,
  ContestPromoteArgs,
  ContestReads,
  ContestRecord,
  ContestRunOptions,
  ContestRunnerInput,
  ContestSelectArgs,
  ContestsState,
  EvaluatorResult,
  GitRevisionPin,
  HasContests,
  JsonObject,
  JsonValue,
  TaskCompeteArgs,
  TokenCounts,
  UsdCost,
  WithContestsOptions,
} from "./types.ts"

type ContestAppBase = AnyYrdApp & HasEffects & HasTasks & HasBays
type ContestsApp<App extends ContestAppBase> = ExtendYrdApp<App, { contests: ContestsState }, ContestCommands> &
  Pick<HasContests, "contests">
type RunnerRequest = ContestRunnerInput & Readonly<{ kind: "contest-runner" }>
type EvaluatorRequest = ContestEvaluatorInput &
  Readonly<{ kind: "contest-evaluator"; evaluator: string; authority: "held-out" | "advisory" }>
type PromotionRequest = Readonly<{ kind: "contest-promotion"; contest: string; attempt: string; pin: GitRevisionPin }>
type ContestRequest = RunnerRequest | EvaluatorRequest | PromotionRequest
type RunnableEffectRequest =
  | EffectRequest<RunnerRequest, EffectOutcome<AttemptRunOutput>>
  | EffectRequest<EvaluatorRequest, EffectOutcome<EvaluatorResult>>
type PromotionApp = Pick<AnyYrdApp, "state" | "command"> & { commands: HasBays["commands"] }

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu
const GIT_REF = /^refs\/[A-Za-z0-9._/@+-]+$/u

function object(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`yrd: ${label} must be an object`)
  }
  const prototype: unknown = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`yrd: ${label} must be a plain object`)
  return input as Record<string, unknown>
}

function text(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim() === "") throw new Error(`yrd: ${label} must be a non-empty string`)
  return input
}

function defined<Value extends object>(value: Value): Value {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as Value
}

function canonical(input: JsonValue): JsonValue {
  if (Array.isArray(input)) return input.map(canonical)
  if (typeof input !== "object" || input === null) return input
  const record = input as JsonObject
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, canonical(value)]),
  )
}

function competitorOf(spec: CompetitorSpec): Competitor {
  const model = text(spec.model, "competitor model")
  const harness = text(spec.harness, "competitor harness")
  const config = canonical(spec.config) as JsonObject
  const identity = JSON.stringify({ model, harness, config })
  return { model, harness, config, id: `cmp-${createHash("sha256").update(identity).digest("hex")}` }
}

function commit(input: unknown, label: string): string {
  const value = text(input, label).toLowerCase()
  if (!SHA.test(value)) throw new Error(`yrd: ${label} must be a full Git commit SHA`)
  return value
}

function parseArtifact(input: unknown): ContestArtifact {
  const value = object(input, "contest artifact")
  return defined({
    kind: text(value.kind, "artifact kind"),
    uri: text(value.uri, "artifact uri"),
    digest: value.digest === undefined ? undefined : text(value.digest, "artifact digest"),
    mediaType: value.mediaType === undefined ? undefined : text(value.mediaType, "artifact media type"),
  })
}

function parseArtifacts(input: unknown): readonly ContestArtifact[] {
  if (!Array.isArray(input)) throw new Error("yrd: artifacts must be an array")
  return input.map(parseArtifact)
}

function parseTokens(input: unknown): TokenCounts {
  const value = object(input, "token counts")
  for (const key of ["input", "output", "cachedInput", "cacheWrite", "reasoning"] as const) {
    const count = value[key]
    if (count !== null && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) {
      throw new Error(`yrd: token count '${key}' is invalid`)
    }
  }
  return value as unknown as TokenCounts
}

function parseCost(input: unknown): UsdCost {
  const value = object(input, "USD cost")
  if (value.kind === "missing") return { kind: "missing", reason: text(value.reason, "missing cost reason") }
  if (value.kind !== "reported" || typeof value.usd !== "number" || value.usd < 0) {
    throw new Error("yrd: reported USD cost is invalid")
  }
  return { kind: "reported", usd: value.usd, source: text(value.source, "cost source") }
}

function parsePin(input: unknown): GitRevisionPin {
  const value = object(input, "attempt pin")
  const ref = text(value.ref, "attempt pin ref")
  if (!GIT_REF.test(ref)) throw new Error("yrd: attempt pin ref must be a full Git ref")
  return defined({
    commit: commit(value.commit, "attempt pin commit"),
    ref,
    branch: text(value.branch, "attempt pin branch"),
    bay: text(value.bay, "attempt pin bay"),
    baseSha: value.baseSha === undefined ? undefined : commit(value.baseSha, "attempt pin baseSha"),
  })
}

function parseRunOutput(input: unknown, expected: RunnerRequest): AttemptRunOutput {
  const value = object(input, "attempt run output")
  const pin = parsePin(value.pin)
  if (pin.bay !== expected.bay.id || pin.branch !== expected.bay.branch) {
    throw new Error(`yrd: attempt pin does not match Bay '${expected.bay.id}' at '${expected.bay.branch}'`)
  }
  if (typeof value.wallTimeMs !== "number" || !Number.isFinite(value.wallTimeMs) || value.wallTimeMs < 0) {
    throw new Error("yrd: attempt wallTimeMs must be a non-negative number")
  }
  return {
    pin,
    wallTimeMs: value.wallTimeMs,
    tokens: parseTokens(value.tokens),
    cost: parseCost(value.cost),
    artifacts: parseArtifacts(value.artifacts),
  }
}

function parseEvaluatorResult(input: unknown): EvaluatorResult {
  const value = object(input, "evaluator result")
  if (value.verdict !== "passed" && value.verdict !== "failed") {
    throw new Error("yrd: evaluator verdict must be passed or failed")
  }
  const scores = value.scores === undefined ? undefined : object(value.scores, "evaluator scores")
  if (
    scores !== undefined &&
    Object.values(scores).some((score) => typeof score !== "number" || !Number.isFinite(score))
  ) {
    throw new Error("yrd: evaluator scores must be finite numbers")
  }
  return defined({
    verdict: value.verdict,
    summary: value.summary === undefined ? undefined : text(value.summary, "evaluator summary"),
    artifacts: parseArtifacts(value.artifacts),
    scores: scores as Record<string, number> | undefined,
  })
}

function parsePromotionOutput(input: unknown): ContestPromotionOutput {
  const value = object(input, "contest promotion output")
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw new Error("yrd: contest promotion revision must be positive")
  }
  return {
    submission: text(value.submission, "contest promotion submission"),
    revision: value.revision as number,
    commit: commit(value.commit, "contest promotion commit"),
  }
}

function own<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function nextId(prefix: string, records: Readonly<Record<string, unknown>>): string {
  const largest = Object.keys(records).reduce(
    (max, id) => Math.max(max, Number(new RegExp(`^${prefix}(\\d+)$`, "u").exec(id)?.[1] ?? 0)),
    0,
  )
  return `${prefix}${largest + 1}`
}

function requiredContest(state: DeepReadonly<ContestsState>, id: string): DeepReadonly<ContestRecord> {
  const contest = own(state.records, id)
  if (contest === undefined) throw new Error(`yrd: no contest '${id}'`)
  return contest
}

function requiredAttempt(contest: DeepReadonly<ContestRecord>, id: string): DeepReadonly<ContestAttemptRecord> {
  const attempt = own(contest.attempts, id)
  if (attempt === undefined) throw new Error(`yrd: contest '${contest.id}' has no attempt '${id}'`)
  return attempt
}

function requestOf(input: unknown): ContestRequest | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const kind = (input as { kind?: unknown }).kind
  return kind === "contest-runner" || kind === "contest-evaluator" || kind === "contest-promotion"
    ? (input as ContestRequest)
    : undefined
}

function replaceAttempt(contest: ContestRecord, attempt: ContestAttemptRecord): ContestRecord {
  return { ...contest, attempts: { ...contest.attempts, [attempt.id]: attempt } }
}

function replaceContest(state: ContestsState, contest: ContestRecord): ContestsState {
  return { records: { ...state.records, [contest.id]: contest } }
}

function bind(previous: string | undefined, id: string, label: string): string {
  if (previous !== undefined && previous !== id) throw new Error(`yrd: ${label} is already bound to '${previous}'`)
  return previous ?? id
}

function projectContestState(state: ContestsState, applied: YrdEvent): ContestsState {
  const data = applied.data as Record<string, unknown>
  if (applied.name === "contest/opened") {
    const contest = data.contest as Omit<ContestRecord, "createdAt">
    return replaceContest(state, { ...contest, createdAt: applied.ts })
  }
  if (applied.name === "contest/selected") {
    const selection = data as ContestSelectArgs
    const contest = state.records[selection.contest]
    if (contest === undefined) return state
    return replaceContest(state, {
      ...contest,
      selection: defined({
        attempt: selection.attempt,
        method: "manual" as const,
        selectedAt: applied.ts,
        selectedBy: selection.selectedBy,
        reason: selection.reason,
      }),
    })
  }
  if (applied.name === "contest/promotion-requested") {
    const request = data as PromotionRequest
    const contest = state.records[request.contest]
    return contest === undefined
      ? state
      : replaceContest(state, { ...contest, promotion: { attempt: request.attempt, pin: request.pin } })
  }
  if (applied.name === "bay/opened") {
    for (const contest of Object.values(state.records)) {
      const attempt = Object.values(contest.attempts).find(
        (candidate) => candidate.bay === undefined && candidate.bayName === data.name,
      )
      if (attempt !== undefined) {
        return replaceContest(state, replaceAttempt(contest, { ...attempt, bay: data.id as string }))
      }
    }
    return state
  }
  if (applied.name !== "effect/requested") return state
  const request = requestOf(data.input)
  const id = data.id
  if (request === undefined || typeof id !== "string") return state
  const contest = state.records[request.contest]
  const attempt = contest?.attempts[request.attempt]
  if (contest === undefined || attempt === undefined) return state
  if (request.kind === "contest-runner") {
    return replaceContest(
      state,
      replaceAttempt(contest, {
        ...attempt,
        runnerEffect: bind(attempt.runnerEffect, id, `runner '${contest.id}/${attempt.id}'`),
      }),
    )
  }
  if (request.kind === "contest-evaluator") {
    const effects = {
      ...attempt.evaluationEffects,
      [request.evaluator]: bind(attempt.evaluationEffects[request.evaluator], id, `evaluator '${request.evaluator}'`),
    }
    return replaceContest(state, replaceAttempt(contest, { ...attempt, evaluationEffects: effects }))
  }
  if (contest.promotion === undefined) return state
  return replaceContest(state, {
    ...contest,
    promotion: { ...contest.promotion, effect: bind(contest.promotion.effect, id, `promotion '${contest.id}'`) },
  })
}

function runError(run: EffectRun): EffectError | undefined {
  if (run.status === "failed") return run.error ?? { code: "effect-failed", message: "effect failed without detail" }
  return run.status === "lost"
    ? { code: "effect-lost", message: run.lostReason ?? "effect executor was lost" }
    : undefined
}

function processOf(id: string | undefined, runs: Readonly<Record<string, EffectRun>>): AttemptProcess {
  if (id === undefined) return { status: "unrequested" }
  const run = runs[id]
  if (run === undefined) {
    return {
      status: "lost",
      effect: id,
      error: { code: "effect-missing", message: `effect '${id}' is missing` },
    }
  }
  const error = runError(run)
  return defined({ status: run.status, effect: id, run, error })
}

function outputOf<Output>(
  id: string | undefined,
  runs: Readonly<Record<string, EffectRun>>,
  parse: (run: EffectRun) => Output,
): { process: AttemptProcess; output?: Output } {
  const process = processOf(id, runs)
  const run = id === undefined ? undefined : runs[id]
  if (run?.status !== "passed") return { process }
  try {
    return { process, output: parse(run) }
  } catch (error) {
    return {
      process: {
        ...process,
        status: "failed",
        error: { code: "invalid-effect-output", message: error instanceof Error ? error.message : String(error) },
      },
    }
  }
}

function runnerOutput(run: EffectRun): AttemptRunOutput {
  const request = requestOf(run.input)
  if (request?.kind !== "contest-runner") throw new Error("yrd: runner effect has the wrong input")
  return parseRunOutput(run.output, request)
}

function hasPinConflict(id: string, pin: GitRevisionPin, runs: Readonly<Record<string, EffectRun>>): boolean {
  return Object.values(runs).some((candidate) => {
    if (candidate.id === id || candidate.status !== "passed") return false
    try {
      const other = runnerOutput(candidate).pin
      return other.ref === pin.ref && other.commit !== pin.commit
    } catch {
      return false
    }
  })
}

function attemptView(record: ContestRecord, attempt: ContestAttemptRecord, state: ContestCommandState): ContestAttempt {
  const runner = outputOf(attempt.runnerEffect, state.effects.runs, (run) => {
    const output = runnerOutput(run)
    if (hasPinConflict(run.id, output.pin, state.effects.runs)) {
      throw new Error(`yrd: Git ref '${output.pin.ref}' has conflicting commits`)
    }
    return output
  })
  const evaluations = Object.fromEntries(
    record.evaluators.map((spec) => {
      const evidence = outputOf(attempt.evaluationEffects[spec.id], state.effects.runs, (run) =>
        parseEvaluatorResult(run.output),
      )
      const evaluation: ContestEvaluation = defined({
        evaluator: spec.id,
        authority: spec.authority,
        ...evidence.process,
        result: evidence.output,
      })
      return [spec.id, evaluation]
    }),
  )
  const bay = attempt.bay === undefined ? undefined : state.bays.bays[attempt.bay]
  let status: ContestAttempt["status"]
  if (attempt.bay === undefined || bay?.status === "opening") status = "preparing"
  else if (bay?.status !== "active") status = "failed"
  else if (runner.process.status === "unrequested") status = "preparing"
  else if (runner.process.status === "requested") status = "queued"
  else if (runner.process.status === "running") status = "running"
  else if (runner.process.status === "waiting") status = "waiting"
  else if (runner.process.status === "lost") status = "lost"
  else if (runner.process.status === "failed" || runner.output === undefined) status = "failed"
  else {
    const heldOut = Object.values(evaluations).filter((evaluation) => evaluation.authority === "held-out")
    if (heldOut.some((evaluation) => evaluation.status === "lost")) status = "lost"
    else if (heldOut.some((evaluation) => evaluation.status === "failed")) status = "failed"
    else if (heldOut.some((evaluation) => evaluation.status === "waiting")) status = "waiting"
    else if (heldOut.some((evaluation) => evaluation.status !== "passed")) status = "evaluating"
    else status = heldOut.some((evaluation) => evaluation.result?.verdict !== "passed") ? "rejected" : "passing"
  }
  return defined({
    id: attempt.id,
    competitor: attempt.competitor,
    bayName: attempt.bayName,
    branch: attempt.branch,
    base: attempt.base,
    bay: attempt.bay,
    status,
    runner: runner.process,
    evaluations,
    pin: runner.output?.pin,
    wallTimeMs: runner.output?.wallTimeMs,
    tokens: runner.output?.tokens,
    cost: runner.output?.cost,
    artifacts: runner.output?.artifacts ?? [],
  })
}

function contestView(record: ContestRecord, state: ContestCommandState): Contest {
  const attempts = Object.fromEntries(
    record.attemptOrder.map((id) => [
      id,
      attemptView(record, requiredAttempt(record, id) as ContestAttemptRecord, state),
    ]),
  )
  let promotion: ContestPromotion | undefined
  if (record.promotion !== undefined) {
    const request = record.promotion
    const evidence = outputOf(request.effect, state.effects.runs, (run) => {
      const output = parsePromotionOutput(run.output)
      if (output.commit !== request.pin.commit) throw new Error("yrd: promoted commit does not match selection")
      return output
    })
    promotion = defined({
      ...evidence.process,
      attempt: request.attempt,
      commit: request.pin.commit,
      ref: request.pin.ref,
      output: evidence.output,
    })
  }
  let status: Contest["status"]
  if (promotion?.status === "passed") status = "promoted"
  else if (promotion !== undefined && ["unrequested", "requested", "running", "waiting"].includes(promotion.status)) {
    status = "promoting"
  } else if (promotion !== undefined) status = "promotion-failed"
  else if (record.selection !== undefined) status = "selected"
  else {
    const values = Object.values(attempts)
    const terminal = values.every((attempt) => ["passing", "rejected", "failed", "lost"].includes(attempt.status))
    status = terminal ? (values.some((attempt) => attempt.status === "passing") ? "ready" : "failed") : "running"
  }
  return defined({
    id: record.id,
    task: record.task,
    base: record.base,
    baseSha: record.baseSha,
    createdAt: record.createdAt,
    evaluators: record.evaluators,
    attemptOrder: record.attemptOrder,
    attempts,
    status,
    selection: record.selection,
    promotion,
  })
}

function adapterMap<Value extends Record<Key, string>, Key extends string>(
  values: readonly Value[],
  key: Key,
  label: string,
): Map<string, Value> {
  const result = new Map<string, Value>()
  for (const value of values) {
    const id = text(value[key], `${label} id`)
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

function stateOf(state: DeepReadonly<ContestCommandState>): ContestCommandState {
  return state as unknown as ContestCommandState
}

function baySnapshot(bay: DeepReadonly<Bay>): Bay {
  return Object.fromEntries(Object.entries(bay).filter(([, value]) => value !== undefined)) as Bay
}

function samePin(left: GitRevisionPin, right: GitRevisionPin): boolean {
  return (
    left.commit === right.commit &&
    left.ref === right.ref &&
    left.branch === right.branch &&
    left.bay === right.bay &&
    left.baseSha === right.baseSha
  )
}

async function promoteSelected(
  app: PromotionApp,
  git: ContestGitAdapter,
  input: PromotionRequest,
  context: { id: string; attempt: number; executor: string },
): Promise<EffectOutcome<ContestPromotionOutput>> {
  try {
    let state = (await app.state()) as ContestCommandState
    const record = requiredContest(state.contests, input.contest) as ContestRecord
    const contest = contestView(record, state)
    if (contest.selection?.attempt !== input.attempt) return failed("selection-changed", "contest selection changed")
    const attempt = contest.attempts[input.attempt]
    if (attempt === undefined) return failed("selection-changed", "selected attempt disappeared")
    if (attempt.status !== "passing" || attempt.pin === undefined) {
      return failed("attempt-not-passing", `attempt '${input.attempt}' is ${attempt.status}`)
    }
    if (!samePin(attempt.pin, input.pin)) return failed("selection-changed", "selected pin changed")
    const resolved = await git.resolveCommit(input.pin.ref, context)
    if (resolved?.toLowerCase() !== input.pin.commit) {
      return failed("pin-moved", `Git ref '${input.pin.ref}' resolves to '${resolved ?? "missing"}'`)
    }
    const bay = state.bays.bays[input.pin.bay]
    if (bay === undefined || record.attempts[input.attempt]?.bay !== bay.id) {
      return failed("bay-missing", `selected Bay '${input.pin.bay}' no longer exists`)
    }
    if (bay.branch !== input.pin.branch) return failed("bay-mismatch", `selected Bay '${bay.id}' changed branch`)
    let submission = submissionForBay(state.bays, bay.id)
    if (!exactSubmission(submission, input.pin) || submission.status === "rejected") {
      await app.command(
        app.commands.bay.intake,
        defined({ bay: bay.id, headSha: input.pin.commit, baseSha: input.pin.baseSha }),
      )
      state = (await app.state()) as ContestCommandState
      submission = submissionForBay(state.bays, bay.id)
    }
    if (!exactSubmission(submission, input.pin)) return failed("submission-mismatch", "Bay changed selected commit")
    if (submission.status === "pushed") {
      await app.command(app.commands.bay.submit, { submission: submission.id })
      state = (await app.state()) as ContestCommandState
      submission = submissionForBay(state.bays, bay.id)
    }
    if (
      !exactSubmission(submission, input.pin) ||
      (submission.status !== "submitted" && submission.status !== "integrated")
    ) {
      return failed("submission-not-ready", "selected commit was not submitted")
    }
    return {
      status: "passed",
      output: { submission: submission.id, revision: submission.revision, commit: submission.headSha },
    }
  } catch (error) {
    return failed("promotion-error", error instanceof Error ? error.message : String(error))
  }
}

/** Install contest orchestration over tasks, Bays, and durable core effects. */
export function withContests(options: WithContestsOptions) {
  const runners = adapterMap(options.runners, "harness", "contest runner")
  const evaluators = adapterMap(options.evaluators, "id", "contest evaluator")
  if (![...evaluators.values()].some((evaluator) => evaluator.authority === "held-out")) {
    throw new Error("yrd: withContests requires at least one held-out evaluator")
  }
  const defaultBase = options.defaultBase ?? "main"

  return <App extends ContestAppBase>(app: App): ContestsApp<App> => {
    Object.assign(app.initialState, { contests: { records: {} } satisfies ContestsState })
    const bayCommands = (app as HasBays).commands.bay
    const runnerEffects = new Map<string, Fx<RunnerRequest, EffectOutcome<AttemptRunOutput>>>()
    for (const adapter of runners.values()) {
      const runner = fx((input: RunnerRequest, context) => adapter.run(input, context))
      app.effectRuns.register(effectPath("runner", adapter.harness), runner)
      runnerEffects.set(adapter.harness, runner)
    }
    const evaluatorEffects = new Map<string, Fx<EvaluatorRequest, EffectOutcome<EvaluatorResult>>>()
    for (const adapter of evaluators.values()) {
      const evaluator = fx((input: EvaluatorRequest, context) => adapter.evaluate(input, context))
      app.effectRuns.register(effectPath("evaluator", adapter.id), evaluator)
      evaluatorEffects.set(adapter.id, evaluator)
    }

    const promotionEffect = fx((input: PromotionRequest, context) =>
      promoteSelected(app as PromotionApp, options.git, input, context),
    )
    app.effectRuns.register(["contest", "promotion"], promotionEffect)

    const compete = op(
      (state: DeepReadonly<ContestCommandState>, args: TaskCompeteArgs) => {
        if (!Array.isArray(args.competitors) || args.competitors.length < 2) {
          throw new Error("yrd: task.compete requires at least two competitors")
        }
        const task = TaskDomain.parse(args.task)
        const base = text(args.base, "task.compete base")
        const baseSha = commit(args.baseSha, "task.compete baseSha")
        const competitors = args.competitors.map(competitorOf)
        const duplicate = competitors.find(
          (candidate, index) => competitors.findIndex((other) => other.id === candidate.id) !== index,
        )
        if (duplicate !== undefined) throw new Error(`yrd: duplicate competitor identity '${duplicate.id}'`)
        for (const candidate of competitors) {
          if (!runners.has(candidate.harness)) {
            throw new Error(`yrd: no contest runner '${candidate.harness}' is registered`)
          }
        }
        const evaluatorIds = args.evaluators ?? [...evaluators.keys()]
        if (new Set(evaluatorIds).size !== evaluatorIds.length) throw new Error("yrd: duplicate contest evaluator")
        const selectedEvaluators = evaluatorIds.map((id) => {
          const adapter = evaluators.get(id)
          if (adapter === undefined) throw new Error(`yrd: no contest evaluator '${id}' is registered`)
          return { id, authority: adapter.authority }
        })
        if (!selectedEvaluators.some((evaluator) => evaluator.authority === "held-out")) {
          throw new Error("yrd: task.compete requires at least one held-out evaluator")
        }
        const id = nextId("C", state.contests.records)
        const attempts = Object.fromEntries(
          competitors.map((candidate, index) => {
            const attempt = `A${index + 1}`
            const name = `contest-${id.toLowerCase()}-${attempt.toLowerCase()}`
            return [
              attempt,
              {
                id: attempt,
                competitor: candidate,
                bayName: name,
                branch: defaultBayBranch(name),
                base,
                evaluationEffects: {},
              } satisfies ContestAttemptRecord,
            ]
          }),
        )
        const contest: Omit<ContestRecord, "createdAt"> = {
          id,
          task,
          base,
          baseSha,
          evaluators: selectedEvaluators,
          attemptOrder: Object.keys(attempts),
          attempts,
        }
        return { events: [event("contest/opened", { contest })], effects: [] }
      },
      { visibility: "public" },
    )

    const requestEffects = op((state: DeepReadonly<ContestCommandState>, args: { contest: string }) => {
      const record = requiredContest(state.contests, args.contest)
      const joined = stateOf(state)
      const view = contestView(record as ContestRecord, joined)
      const requests: RunnableEffectRequest[] = []
      for (const attemptId of record.attemptOrder) {
        const attempt = requiredAttempt(record, attemptId)
        const common = {
          contest: record.id,
          attempt: attempt.id,
          task: record.task as Task,
          competitor: attempt.competitor as Competitor,
        }
        if (attempt.runnerEffect === undefined) {
          const bay = attempt.bay === undefined ? undefined : state.bays.bays[attempt.bay]
          if (bay?.status !== "active") continue
          if (bay.name !== attempt.bayName || bay.branch !== attempt.branch || bay.base !== attempt.base) {
            throw new Error(`yrd: bay '${bay.id}' does not match contest attempt '${attempt.id}'`)
          }
          const runner = runnerEffects.get(attempt.competitor.harness)
          if (runner === undefined) throw new Error(`yrd: no contest runner '${attempt.competitor.harness}'`)
          const input: RunnerRequest = {
            kind: "contest-runner",
            ...common,
            base: record.base,
            bay: baySnapshot(bay),
          }
          requests.push(effect(runner, input, `contest:${record.id}:${attempt.id}:runner`))
          continue
        }
        const result = view.attempts[attemptId]
        if (result === undefined) throw new Error(`yrd: contest attempt '${attemptId}' disappeared`)
        if (result.runner.status !== "passed" || result.pin === undefined) continue
        for (const spec of record.evaluators) {
          if (attempt.evaluationEffects[spec.id] !== undefined) continue
          const evaluator = evaluatorEffects.get(spec.id)
          if (evaluator === undefined) throw new Error(`yrd: no contest evaluator '${spec.id}'`)
          const input: EvaluatorRequest = {
            kind: "contest-evaluator",
            ...common,
            evaluator: spec.id,
            authority: spec.authority,
            pin: result.pin,
            artifacts: result.artifacts,
          }
          requests.push(effect(evaluator, input, `contest:${record.id}:${attempt.id}:evaluator:${spec.id}`))
        }
      }
      return { events: [], effects: requests }
    })

    const select = op(
      (state: DeepReadonly<ContestCommandState>, args: ContestSelectArgs) => {
        const contest = requiredContest(state.contests, text(args.contest, "contest.select contest"))
        requiredAttempt(contest, text(args.attempt, "contest.select attempt"))
        if (contest.promotion !== undefined) {
          throw new Error(`yrd: contest '${contest.id}' already requested promotion; selection is frozen`)
        }
        return { events: [event("contest/selected", args)], effects: [] }
      },
      { visibility: "public" },
    )

    const promote = op(
      (state: DeepReadonly<ContestCommandState>, args: ContestPromoteArgs) => {
        const record = requiredContest(state.contests, text(args.contest, "contest.promote contest"))
        const contest = contestView(record as ContestRecord, stateOf(state))
        if (contest.selection === undefined) throw new Error(`yrd: contest '${contest.id}' has no selected attempt`)
        const attempt = contest.attempts[contest.selection.attempt]
        if (attempt === undefined) throw new Error(`yrd: selected attempt disappeared`)
        if (attempt.pin === undefined) throw new Error(`yrd: selected attempt '${attempt.id}' has no immutable Git pin`)
        if (attempt.status !== "passing") {
          throw new Error(`yrd: selected attempt '${attempt.id}' is ${attempt.status}, not passing`)
        }
        if (record.promotion !== undefined) {
          if (contest.promotion?.status === "passed") return { events: [], effects: [] }
          throw new Error(
            `yrd: contest '${contest.id}' promotion is ${contest.promotion?.status ?? "requested"}; retry its durable effect instead`,
          )
        }
        const input: PromotionRequest = {
          kind: "contest-promotion",
          contest: contest.id,
          attempt: attempt.id,
          pin: attempt.pin,
        }
        return {
          events: [event("contest/promotion-requested", input)],
          effects: [
            effect(promotionEffect, input, `contest:${contest.id}:${attempt.id}:promotion:${attempt.pin.commit}`),
          ],
        }
      },
      { visibility: "public" },
    )

    const taskCommands = (app.commands as Record<string, Record<string, unknown> | undefined>).task
    if (taskCommands === undefined) Object.assign(app.commands, { task: { compete } })
    else Object.assign(taskCommands, { compete })
    Object.assign(app.commands, { contest: { request: requestEffects, select, promote } })

    const project = app.project as (state: Record<string, unknown>, applied: YrdEvent) => Record<string, unknown>
    const projectContests = (state: Record<string, unknown>, applied: YrdEvent): Record<string, unknown> => {
      const projected = project(state, applied)
      const current = (projected as { contests: ContestsState }).contests
      const next = projectContestState(current, applied)
      return next === current ? projected : { ...projected, contests: next }
    }
    app.project = projectContests as typeof app.project

    const snapshot = async (): Promise<ContestCommandState> => (await app.state()) as ContestCommandState
    const runRequested = async (ids: readonly (string | undefined)[], runtime: ContestRunOptions): Promise<void> => {
      const pending = [...new Set(ids.filter((id): id is string => id !== undefined))]
      for (let offset = 0; offset < pending.length; offset += runtime.concurrency) {
        await Promise.all(
          pending.slice(offset, offset + runtime.concurrency).map(async (id) => {
            if ((await snapshot()).effects.runs[id]?.status !== "requested") return
            try {
              await app.effectRuns.run(id, {
                executor: runtime.executor,
                leaseMs: runtime.leaseMs,
                ...(runtime.now === undefined ? {} : { now: runtime.now }),
              })
            } catch (error) {
              if ((await snapshot()).effects.runs[id]?.status === "requested") throw error
            }
          }),
        )
      }
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
        return { base, sha: commit(resolved, `resolved base '${base}'`) }
      },
      async show(id) {
        const state = await snapshot()
        return contestView(requiredContest(state.contests, text(id, "contest id")) as ContestRecord, state)
      },
      async list() {
        const state = await snapshot()
        return Object.keys(state.contests.records)
          .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
          .map((id) => contestView(requiredContest(state.contests, id) as ContestRecord, state))
      },
      async run(id, runtime) {
        if (!Number.isSafeInteger(runtime.concurrency) || runtime.concurrency < 1) {
          throw new Error("yrd: contest concurrency must be a positive integer")
        }
        const contestId = text(id, "contest id")
        let state = await snapshot()
        let record = requiredContest(state.contests, contestId)
        for (const attemptId of record.attemptOrder) {
          state = await snapshot()
          const attempt = requiredAttempt(requiredContest(state.contests, contestId), attemptId)
          if (attempt.bay !== undefined) continue
          try {
            await app.command(bayCommands.open, {
              name: attempt.bayName,
              task: `${record.task.ref.source}:${record.task.ref.id}`,
              actor: attempt.competitor.id,
              base: attempt.base,
              baseSha: record.baseSha,
            })
          } catch (error) {
            if (requiredAttempt(requiredContest((await snapshot()).contests, contestId), attemptId).bay === undefined) {
              throw error
            }
          }
        }
        state = await snapshot()
        record = requiredContest(state.contests, contestId)
        await runRequested(
          record.attemptOrder.map((attemptId) => {
            const bay = record.attempts[attemptId]?.bay
            return bay === undefined ? undefined : state.bays.bays[bay]?.effectId
          }),
          runtime,
        )
        await app.command(requestEffects, { contest: contestId })
        state = await snapshot()
        record = requiredContest(state.contests, contestId)
        await runRequested(
          record.attemptOrder.map((attemptId) => record.attempts[attemptId]?.runnerEffect),
          runtime,
        )
        await app.command(requestEffects, { contest: contestId })
        state = await snapshot()
        record = requiredContest(state.contests, contestId)
        await runRequested(
          record.attemptOrder.flatMap((attemptId) =>
            Object.values(record.attempts[attemptId]?.evaluationEffects ?? {}),
          ),
          runtime,
        )
        state = await snapshot()
        record = requiredContest(state.contests, contestId)
        await runRequested([record.promotion?.effect], runtime)
        return reads.show(contestId)
      },
    }

    Object.assign(app, { contests: reads })
    return app as unknown as ContestsApp<App>
  }
}
