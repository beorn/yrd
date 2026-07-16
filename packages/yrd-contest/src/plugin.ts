import { defaultBayBranch, prForBay, resolveBay, type Bay, type HasBays, type PR } from "@yrd/bay"
import {
  command,
  event,
  Command,
  raiseFailure,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type EventDraft,
  type YrdDef,
} from "@yrd/core"
import { createJobDef, Job, type HasJobs, type JobDef, type JobDefs, type JobResult, type Jobs } from "@yrd/job"
import type { HasIssues } from "@yrd/issue"
import { computed } from "@silvery/signals"
import type { ConditionalLogger } from "loggily"
import * as z from "zod"
import {
  AttemptRunOutputSchema,
  CompetitorDefSchema,
  ContestBaySchema,
  ContestEvaluatorInputSchema,
  ContestEvaluatorSpecSchema,
  ContestPromoteArgsSchema,
  ContestRecordSchema,
  ContestRunnerInputSchema,
  ContestSelectArgsSchema,
  EvaluatorResultSchema,
  GitRevisionPinSchema,
  CompeteArgsSchema,
  type AttemptRunOutput,
  type Competitor,
  type CompetitorDef,
  type Contest,
  type ContestActions,
  type ContestAttempt,
  type ContestAttemptRecord,
  type ContestCommands,
  type ContestEvaluation,
  type ContestEvaluationRun,
  type ContestEvaluatorDef,
  type ContestEvaluatorInput,
  type ContestFinishArgs,
  type ContestGit,
  type ContestPromotion,
  type ContestRecord,
  type ContestRunnerDef,
  type ContestRunnerInput,
  type ContestEvaluateOptions,
  type Contests,
  type ContestsState,
  type ContestRuntimeState,
  type ContestSelectArgs,
  type ContestWaitingEvaluation,
  type CompeteArgs,
  type EvaluatorResult,
  type HasContests,
  type WithContestsOptions,
} from "./types.ts"

const TextSchema = z.string().trim().min(1)
const DefIdSchema = z.string().regex(/^[a-z][a-z0-9._-]*$/iu)
const RequestArgsSchema = z.object({ contest: TextSchema, retry: z.boolean().optional() }).strict()
const FinalizeArgsSchema = z.object({ contest: TextSchema, pr: TextSchema }).strict()
const OpenedRecordSchema = ContestRecordSchema.omit({ createdAt: true, selection: true, promotion: true })
const OpenedSchema = z.object({ contest: OpenedRecordSchema }).strict()
const PromotionRequestSchema = z
  .object({ contest: TextSchema, attempt: TextSchema, pin: GitRevisionPinSchema })
  .strict()
const PromotionVerifiedSchema = z.object({ commit: GitRevisionPinSchema.shape.commit }).strict()
const PromotedSchema = z
  .object({
    contest: TextSchema,
    pr: TextSchema,
    revision: z.number().int().positive(),
    commit: GitRevisionPinSchema.shape.commit,
  })
  .strict()

type RunnerJobDef = JobDef<ContestRunnerInput, AttemptRunOutput>
type EvaluatorJobDef = JobDef<ContestEvaluatorInput, EvaluatorResult>
type PromotionRequest = z.infer<typeof PromotionRequestSchema>
type PromotionJobDef = JobDef<PromotionRequest, z.infer<typeof PromotionVerifiedSchema>>
type ContestState = Readonly<{ contests: ContestsState }>
type ContestFeatures = HasJobs & HasIssues & HasBays

export type ContestPlugin = (<State extends object, Commands extends CommandTree, Features extends ContestFeatures>(
  definition: YrdDef<State, Commands, Features>,
) => YrdDef<State & ContestState, Commands & ContestCommands, Features & HasContests>) &
  Readonly<{ jobDefs: JobDefs }>

/** Compose immutable runner, evaluator, and exact-promotion definitions. */
export function withContests(options: WithContestsOptions): ContestPlugin {
  const runners = definitionMap(options.runners, "harness", "contest runner")
  const evaluators = definitionMap(options.evaluators, "id", "contest evaluator")
  const git = normalizeGit(options.git)
  const defaultBase = options.defaultBase ?? "main"
  const runnerJobs = new Map<string, RunnerJobDef>()
  const evaluatorJobs = new Map<string, EvaluatorJobDef>()

  for (const runner of runners.values()) runnerJobs.set(runner.harness, runnerJobDef(runner))
  for (const evaluator of evaluators.values()) evaluatorJobs.set(evaluator.id, evaluatorJobDef(evaluator))
  const promotionJob = promotionJobDef(git)
  const jobDefs = Object.freeze(
    Object.fromEntries(
      [...runnerJobs.values(), ...evaluatorJobs.values(), promotionJob].map((definition) => [
        definition.name,
        definition,
      ]),
    ),
  )
  const commands = createContestCommands(runners, evaluators, runnerJobs, evaluatorJobs, promotionJob)

  const install = <State extends object, Commands extends CommandTree, Features extends ContestFeatures>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { contests: { records: {} } satisfies ContestsState },
      commands,
      events: {
        "contest/opened": OpenedSchema,
        "contest/selected": ContestSelectArgsSchema,
        "contest/promotion/requested": PromotionRequestSchema,
        "contest/promoted": PromotedSchema,
      },
      projectionVersion: "contests-v1",
      project: projectContests,
      create(yrd) {
        yrd.jobs.requireDefinitions(jobDefs)
        const runtime = () => yrd.state() as unknown as DeepReadonly<ContestRuntimeState>
        return {
          contests: createContests({
            state: computed(() => yrd.state().contests),
            runtime,
            jobs: yrd.jobs,
            bays: yrd.bays,
            git,
            defaultBase,
            signal: yrd.scope.signal,
            log: yrd.log.child("contests"),
            actions: {
              compete: (args) => yrd.dispatch(commands.issue.compete, args),
              request: (contest, retry) =>
                yrd.dispatch(commands.contest.request, { contest, ...(retry === undefined ? {} : { retry }) }),
              select: (args) => yrd.dispatch(commands.contest.select, args),
              promote: (args) => yrd.dispatch(commands.contest.promote, args),
              finalize: (contest, pr) => yrd.dispatch(commands.contest.finalize, { contest, pr }),
            },
          }),
        }
      },
    })

  Object.defineProperty(install, "jobDefs", { value: jobDefs, enumerable: true })
  return Object.freeze(install) as ContestPlugin
}

function createContestCommands(
  runners: ReadonlyMap<string, ContestRunnerDef>,
  evaluators: ReadonlyMap<string, ContestEvaluatorDef>,
  runnerJobs: ReadonlyMap<string, RunnerJobDef>,
  evaluatorJobs: ReadonlyMap<string, EvaluatorJobDef>,
  promotionJob: PromotionJobDef,
): ContestCommands {
  const compete = command({
    title: "Compete on issue",
    visibility: "public",
    params: CompeteArgsSchema,
    apply(state: DeepReadonly<ContestRuntimeState>, args: CompeteArgs) {
      const competitors = args.competitors.map(competitorOf)
      const duplicate = competitors.find(
        (candidate, index) => competitors.findIndex((other) => other.id === candidate.id) !== index,
      )
      if (duplicate !== undefined) throw new Error(`yrd: duplicate competitor identity '${duplicate.id}'`)
      for (const competitor of competitors) {
        if (!runners.has(competitor.harness)) {
          throw new Error(`yrd: no contest runner '${competitor.harness}' is installed`)
        }
      }

      const evaluatorIds = args.evaluators ?? [...evaluators.keys()]
      if (new Set(evaluatorIds).size !== evaluatorIds.length) throw new Error("yrd: duplicate contest evaluator")
      const selectedEvaluators = evaluatorIds.map((id) => {
        const evaluator = evaluators.get(id)
        if (evaluator === undefined) throw new Error(`yrd: no contest evaluator '${id}' is installed`)
        return ContestEvaluatorSpecSchema.parse({ id, authority: evaluator.authority })
      })
      if (!selectedEvaluators.some(({ authority }) => authority === "held-out")) {
        throw new Error("yrd: issue.compete requires at least one held-out evaluator")
      }

      const id = nextId("C", state.contests.records)
      const attempts = Object.fromEntries(
        competitors.map((competitor, index) => {
          const attempt = `A${index + 1}`
          const bayName = `contest-${id.toLowerCase()}-${attempt.toLowerCase()}`
          return [
            attempt,
            {
              id: attempt,
              competitor,
              bayName,
              branch: defaultBayBranch(bayName),
              base: args.base,
            } satisfies ContestAttemptRecord,
          ]
        }),
      )
      return {
        events: [
          event("contest/opened", {
            contest: {
              id,
              issue: args.issue,
              base: args.base,
              baseSha: args.baseSha,
              evaluators: selectedEvaluators,
              attemptOrder: Object.keys(attempts),
              attempts,
            },
          }),
        ],
      }
    },
  })

  const request = command({
    title: "Request ready contest jobs",
    params: RequestArgsSchema,
    apply(state: DeepReadonly<ContestRuntimeState>, args) {
      const record = requiredContest(state.contests, args.contest)
      if (record.selection !== undefined) {
        throw new Error(`yrd: contest '${record.id}' is selected; evaluations are frozen`)
      }
      const events: EventDraft[] = []
      for (const attemptId of record.attemptOrder) {
        const attempt = requiredAttempt(record, attemptId)
        const bay = attemptBay(state, attempt)
        if (bay?.status !== "active") continue
        const runnerKey = attemptRunnerKey(record.id, attempt.id)
        const runner = jobByKey(state, runnerKey)
        if (runner === undefined) {
          const definition = runnerJobs.get(attempt.competitor.harness)
          if (definition === undefined) throw new Error(`yrd: no contest runner '${attempt.competitor.harness}'`)
          events.push(
            definition.request(
              ContestRunnerInputSchema.parse({
                contest: record.id,
                attempt: attempt.id,
                issue: record.issue,
                competitor: attempt.competitor,
                base: record.base,
                bay: baySnapshot(bay),
              }),
              { key: runnerKey },
            ),
          )
          continue
        }
        const output = passedRunnerOutput(runner)
        if (output === undefined) continue
        for (const spec of record.evaluators) {
          const history = evaluationJobs(state, record.id, attempt.id, spec.id)
          const latest = history.at(-1)
          if (latest !== undefined && (args.retry !== true || !failedEvaluationVerdict(latest))) continue
          const generation = history.length + 1
          const key = attemptEvaluatorKey(record.id, attempt.id, spec.id, generation)
          const definition = evaluatorJobs.get(spec.id)
          if (definition === undefined) throw new Error(`yrd: no contest evaluator '${spec.id}'`)
          events.push(
            definition.request(
              ContestEvaluatorInputSchema.parse({
                contest: record.id,
                attempt: attempt.id,
                issue: record.issue,
                competitor: attempt.competitor,
                pin: output.pin,
                artifacts: output.artifacts,
              }),
              { key },
            ),
          )
        }
      }
      return { events }
    },
  })

  const select = command({
    title: "Select contest winner",
    visibility: "public",
    params: ContestSelectArgsSchema,
    apply(state: DeepReadonly<ContestRuntimeState>, args: ContestSelectArgs) {
      const record = requiredContest(state.contests, args.contest)
      if (record.promotion !== undefined) {
        throw new Error(`yrd: contest '${record.id}' already requested promotion; selection is frozen`)
      }
      if (record.selection !== undefined) {
        throw new Error(`yrd: contest '${record.id}' is already selected; selection is frozen`)
      }
      const contest = contestView(record, state)
      if (contest.status !== "ready") {
        throw new Error(`yrd: contest '${record.id}' is ${contest.status}, not ready for selection`)
      }
      const attempt = contest.attempts[args.attempt]
      if (attempt === undefined) throw new Error(`yrd: contest '${record.id}' has no attempt '${args.attempt}'`)
      if (attempt.status !== "passing") {
        throw new Error(`yrd: contest attempt '${attempt.id}' is ${attempt.status}, not passing`)
      }
      return { events: [event("contest/selected", args)] }
    },
  })

  const promote = command({
    title: "Promote contest winner",
    visibility: "public",
    params: ContestPromoteArgsSchema,
    apply(state: DeepReadonly<ContestRuntimeState>, args) {
      const record = requiredContest(state.contests, args.contest)
      if (record.promotion?.result !== undefined) return { events: [] }
      if (record.promotion !== undefined) return { events: [] }
      if (record.selection === undefined) throw new Error(`yrd: contest '${record.id}' has no selected attempt`)
      const attempt = contestView(record, state).attempts[record.selection.attempt]
      if (attempt === undefined) throw new Error("yrd: selected contest attempt disappeared")
      if (attempt.status !== "passing" || attempt.pin === undefined) {
        throw new Error(`yrd: selected attempt '${attempt.id}' is ${attempt.status}, not passing`)
      }
      const input = PromotionRequestSchema.parse({ contest: record.id, attempt: attempt.id, pin: attempt.pin })
      return {
        events: [
          event("contest/promotion/requested", input),
          promotionJob.request(input, { key: promotionKey(record.id) }),
        ],
      }
    },
  })

  const finalize = command({
    title: "Finalize contest promotion",
    params: FinalizeArgsSchema,
    apply(state: DeepReadonly<ContestRuntimeState>, args) {
      const record = requiredContest(state.contests, args.contest)
      const promotion = record.promotion
      if (promotion === undefined) throw new Error(`yrd: contest '${record.id}' has no promotion request`)
      if (promotion.result !== undefined) {
        if (promotion.result.pr !== args.pr) {
          throw new Error(`yrd: contest '${record.id}' was promoted as '${promotion.result.pr}'`)
        }
        return { events: [] }
      }
      if (record.selection?.attempt !== promotion.attempt) {
        throw new Error("yrd: contest selection changed during promotion")
      }
      const verification = jobByKey(state, promotionKey(record.id))
      if (verification?.status !== "passed") throw new Error(`yrd: contest promotion verification has not passed`)
      const verified = PromotionVerifiedSchema.parse(verification.output)
      if (verified.commit.toLowerCase() !== promotion.pin.commit.toLowerCase()) {
        throw new Error("yrd: contest promotion verified a different commit")
      }
      const pr = state.bays.prs[args.pr]
      if (pr === undefined || !exactPR(pr, promotion.pin, record.base)) {
        throw new Error(`yrd: PR '${args.pr}' does not contain the selected contest commit`)
      }
      if (pr.status !== "submitted" && pr.status !== "integrated") {
        throw new Error(`yrd: PR '${pr.id}' is ${pr.status}, not submitted`)
      }
      return {
        events: [
          event("contest/promoted", {
            contest: record.id,
            pr: pr.id,
            revision: pr.revision,
            commit: promotion.pin.commit,
          }),
        ],
      }
    },
  })

  return { issue: { compete }, contest: { request, select, promote, finalize } }
}

function createContests(
  options: Readonly<{
    state: Contests["state"]
    runtime(): DeepReadonly<ContestRuntimeState>
    jobs: Jobs
    bays: HasBays["bays"]
    git: ContestGit
    defaultBase: string
    signal: AbortSignal
    log: ConditionalLogger
    actions: ContestActions
  }>,
): Contests {
  const get = (id: string): Contest | undefined => {
    const state = options.runtime()
    const record = state.contests.records[id]
    return record === undefined ? undefined : contestView(record, state)
  }
  const required = (id: string): Contest => {
    const contest = get(id)
    if (contest === undefined) raiseFailure("refusal", "contest-not-found", `yrd: no contest '${id}'`)
    return contest
  }

  const waiting = (id: string, selectedAttempt?: string, selectedEvaluator?: string): ContestWaitingEvaluation => {
    const contest = required(TextSchema.parse(id))
    const matches: ContestWaitingEvaluation[] = []
    for (const attemptId of contest.attemptOrder) {
      if (selectedAttempt !== undefined && attemptId !== selectedAttempt) continue
      const attempt = contest.attempts[attemptId]
      if (attempt === undefined) throw new Error(`yrd: contest '${contest.id}' lost attempt '${attemptId}'`)
      for (const evaluator of contest.evaluators) {
        if (selectedEvaluator !== undefined && evaluator.id !== selectedEvaluator) continue
        const run = attempt.evaluations[evaluator.id]?.runs.at(-1)
        if (run?.job.status !== "waiting") continue
        matches.push({
          contest: contest.id,
          attempt: attempt.id,
          evaluator: evaluator.id,
          generation: run.generation,
          job: run.job,
        })
      }
    }
    const match = matches[0]
    if (match === undefined) {
      raiseFailure(
        "refusal",
        "evaluation-not-waiting",
        `yrd: contest '${contest.id}' has no matching waiting evaluation`,
      )
    }
    if (matches.length > 1) {
      raiseFailure(
        "refusal",
        "evaluation-ambiguous",
        `yrd: contest '${contest.id}' has multiple waiting evaluations; select an attempt and evaluator`,
      )
    }
    return match
  }

  const advance = async (id: string, runOptions: ContestEvaluateOptions): Promise<Contest> => {
    const contestId = TextSchema.parse(id)
    const concurrency = z.number().int().positive().parse(runOptions.concurrency)
    let retry = runOptions.retry === true
    await ensureBays(contestId, options)
    if (retry) await retryFailedJobs(contestId, options)
    while (true) {
      const requested = requestedJobs(contestId, options.runtime())
      if (requested.length > 0) {
        await options.jobs.runMany(requested, { ...runOptions, concurrency })
        continue
      }
      if (await finalizePromotion(contestId, options)) continue
      if (required(contestId).selection !== undefined) return required(contestId)
      const result = await options.actions.request(contestId, retry)
      retry = false
      if (options.jobs.requested(result).length === 0) return required(contestId)
    }
  }

  return Object.freeze({
    state: options.state,
    async resolveBase(input) {
      const base = input ?? options.defaultBase
      const resolved = await options.git.resolveCommit(base, options.signal)
      if (resolved === undefined) {
        raiseFailure("refusal", "git-commit-missing", `yrd: no Git commit '${base}'`)
      }
      return { base, sha: GitRevisionPinSchema.shape.commit.parse(resolved.toLowerCase()) }
    },
    get,
    list() {
      return Object.keys(options.state().records)
        .toSorted((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .map(required)
    },
    async compete(args) {
      using _span = options.log.span?.("compete", { issue: args.issue.ref, competitors: args.competitors.length })
      const result = await options.actions.compete(args)
      const opened = result.events.find(({ name }) => name === "contest/opened")
      if (opened === undefined) throw new Error("yrd: issue.compete did not open a contest")
      return required(OpenedSchema.parse(opened.data).contest.id)
    },
    async select(args) {
      using _span = options.log.span?.("select", { contest: args.contest, attempt: args.attempt })
      await options.actions.select(args)
      return required(args.contest)
    },
    async evaluate(id, runOptions) {
      using _span = options.log.span?.("evaluate", { contest: id, retry: runOptions.retry === true })
      const contest = required(TextSchema.parse(id))
      if (contest.selection !== undefined) {
        raiseFailure("refusal", "contest-frozen", `yrd: contest '${contest.id}' is selected; evaluations are frozen`)
      }
      return await advance(id, runOptions)
    },
    waiting,
    async finish(args: ContestFinishArgs) {
      using _span = options.log.span?.("finish", {
        contest: args.contest,
        attempt: args.attempt,
        evaluator: args.evaluator,
      })
      const current = waiting(args.contest, args.attempt, args.evaluator)
      const token = TextSchema.parse(args.token)
      await options.jobs.finish(current.job.id, {
        attempt: current.job.attempt,
        runner: current.job.runner,
        token,
        result: args.result,
      })
      return required(current.contest)
    },
    async promote(args, runOptions) {
      using _span = options.log.span?.("promote", { contest: args.contest })
      await options.actions.promote(args)
      return await advance(args.contest, { ...runOptions, retry: false })
    },
  })
}

async function retryFailedJobs(contestId: string, options: Parameters<typeof createContests>[0]): Promise<void> {
  const state = options.runtime()
  const record = requiredContest(state.contests, contestId)
  const ids = new Set<string>()
  for (const attemptId of record.attemptOrder) {
    const runner = jobByKey(state, attemptRunnerKey(record.id, attemptId))
    if (runner?.status === "failed" || runner?.status === "lost") ids.add(runner.id)
    for (const evaluator of record.evaluators) {
      const latest = evaluationJobs(state, record.id, attemptId, evaluator.id).at(-1)
      if (latest?.status === "failed" || latest?.status === "lost") ids.add(latest.id)
    }
  }
  for (const id of ids) await options.jobs.retry(id)
}

async function ensureBays(contestId: string, options: Parameters<typeof createContests>[0]): Promise<void> {
  const record = requiredContest(options.runtime().contests, contestId)
  for (const attemptId of record.attemptOrder) {
    const attempt = requiredAttempt(record, attemptId)
    if (attemptBay(options.runtime(), attempt) !== undefined) continue
    try {
      await options.bays.open({
        name: attempt.bayName,
        issue: `${record.issue.ref.source}:${record.issue.ref.id}`,
        actor: attempt.competitor.id,
        base: attempt.base,
        baseSha: record.baseSha,
      })
    } catch (error) {
      if (attemptBay(options.runtime(), attempt) === undefined) throw error
    }
  }
}

function requestedJobs(contestId: string, state: DeepReadonly<ContestRuntimeState>): readonly string[] {
  const record = requiredContest(state.contests, contestId)
  const ids = new Set<string>()
  if (record.selection !== undefined) {
    addRequested(ids, state, promotionKey(record.id))
    return [...ids]
  }
  for (const attemptId of record.attemptOrder) {
    const attempt = requiredAttempt(record, attemptId)
    const bay = attemptBay(state, attempt)
    if (bay?.jobId !== undefined && state.jobs.byId[bay.jobId]?.status === "requested") ids.add(bay.jobId)
    addRequested(ids, state, attemptRunnerKey(record.id, attempt.id))
    for (const evaluator of record.evaluators) {
      const current = evaluationJobs(state, record.id, attempt.id, evaluator.id).at(-1)
      if (current?.status === "requested") ids.add(current.id)
    }
  }
  addRequested(ids, state, promotionKey(record.id))
  return [...ids]
}

function addRequested(ids: Set<string>, state: DeepReadonly<ContestRuntimeState>, key: string): void {
  const id = state.jobs.byKey[key]
  if (id !== undefined && state.jobs.byId[id]?.status === "requested") ids.add(id)
}

async function finalizePromotion(contestId: string, options: Parameters<typeof createContests>[0]): Promise<boolean> {
  const state = options.runtime()
  const record = requiredContest(state.contests, contestId)
  const promotion = record.promotion
  if (promotion === undefined || promotion.result !== undefined) return false
  const verification = jobByKey(state, promotionKey(contestId))
  if (verification?.status !== "passed") return false
  const pr = await ensureExactPR(record, promotion.pin, options)
  const finalized = await options.actions.finalize(contestId, pr.id)
  return finalized.events.length > 0
}

async function ensureExactPR(
  record: DeepReadonly<ContestRecord>,
  pin: DeepReadonly<z.infer<typeof GitRevisionPinSchema>>,
  options: Parameters<typeof createContests>[0],
): Promise<DeepReadonly<PR>> {
  let pr = prForBay(options.runtime().bays, pin.bay)
  if (pr === undefined || !exactPR(pr, pin, record.base) || pr.status === "rejected") {
    // Promotion intake trusts the verified write-once pin and intentionally re-drives a rejected winner.
    await options.bays.intake({
      bay: pin.bay,
      headSha: pin.commit,
      ...(pin.baseSha === undefined ? {} : { baseSha: pin.baseSha }),
    })
    pr = prForBay(options.runtime().bays, pin.bay)
  }
  if (pr === undefined || !exactPR(pr, pin, record.base)) {
    throw new Error(`yrd: selected Bay '${pin.bay}' did not produce the exact contest PR`)
  }
  if (pr.status === "pushed") {
    await options.bays.submit({ pr: pr.id })
    pr = prForBay(options.runtime().bays, pin.bay)
  }
  if (pr === undefined || !exactPR(pr, pin, record.base) || (pr.status !== "submitted" && pr.status !== "integrated")) {
    throw new Error(`yrd: selected contest commit was not submitted`)
  }
  return pr
}

function projectContests(state: DeepReadonly<ContestState>, applied: Event): ContestState {
  if (applied.name === "contest/opened") {
    const opened = OpenedSchema.parse(applied.data).contest
    if (state.contests.records[opened.id] !== undefined) throw new Error(`yrd: duplicate contest '${opened.id}'`)
    return replaceContest(state, ContestRecordSchema.parse({ ...opened, createdAt: applied.ts }))
  }
  if (applied.name === "contest/selected") {
    const selected = ContestSelectArgsSchema.parse(applied.data)
    const record = state.contests.records[selected.contest]
    if (record === undefined) return state
    return replaceContest(state, {
      ...record,
      selection: {
        attempt: selected.attempt,
        method: "manual",
        selectedAt: applied.ts,
        ...(selected.selectedBy === undefined ? {} : { selectedBy: selected.selectedBy }),
        ...(selected.reason === undefined ? {} : { reason: selected.reason }),
      },
    })
  }
  if (applied.name === "contest/promotion/requested") {
    const requested = PromotionRequestSchema.parse(applied.data)
    const record = state.contests.records[requested.contest]
    if (record === undefined) return state
    return replaceContest(state, {
      ...record,
      promotion: { attempt: requested.attempt, pin: requested.pin, requestedAt: applied.ts },
    })
  }
  if (applied.name === "contest/promoted") {
    const promoted = PromotedSchema.parse(applied.data)
    const record = state.contests.records[promoted.contest]
    if (record?.promotion === undefined) return state
    return replaceContest(state, {
      ...record,
      promotion: {
        ...record.promotion,
        result: { pr: promoted.pr, revision: promoted.revision, commit: promoted.commit, promotedAt: applied.ts },
      },
    })
  }
  return state
}

function replaceContest(state: DeepReadonly<ContestState>, contest: ContestRecord): ContestState {
  return { contests: { records: { ...state.contests.records, [contest.id]: contest } } }
}

function contestView(record: DeepReadonly<ContestRecord>, state: DeepReadonly<ContestRuntimeState>): Contest {
  const attempts = Object.fromEntries(
    record.attemptOrder.map((id) => [id, attemptView(record, requiredAttempt(record, id), state)]),
  )
  let promotion: ContestPromotion | undefined
  if (record.promotion !== undefined) {
    const job = jobByKey(state, promotionKey(record.id))
    const pr =
      record.promotion.result === undefined
        ? prForBay(state.bays, record.promotion.pin.bay)
        : state.bays.prs[record.promotion.result.pr]
    promotion = {
      attempt: record.promotion.attempt,
      commit: record.promotion.pin.commit,
      ref: record.promotion.pin.ref,
      ...(job === undefined ? {} : { job }),
      ...(pr === undefined ? {} : { pr }),
    }
  }

  let status: Contest["status"]
  if (record.promotion?.result !== undefined) status = "promoted"
  else if (promotion?.job?.status === "failed" || promotion?.job?.status === "lost") status = "promotion-failed"
  else if (promotion !== undefined) status = "promoting"
  else if (record.selection !== undefined) status = "selected"
  else {
    const values = Object.values(attempts)
    const terminal = values.every((attempt) => {
      if (!["passing", "rejected", "failed", "lost"].includes(attempt.status)) return false
      if (attempt.runner?.status !== "passed") return true
      return record.evaluators.every((evaluator) => {
        const latest = attempt.evaluations[evaluator.id]?.runs.at(-1)
        return latest !== undefined && Job.terminal(latest.job)
      })
    })
    status = terminal ? (values.some((attempt) => attempt.status === "passing") ? "ready" : "failed") : "running"
  }
  return {
    id: record.id,
    issue: record.issue,
    base: record.base,
    baseSha: record.baseSha,
    createdAt: record.createdAt,
    evaluators: record.evaluators,
    attemptOrder: record.attemptOrder,
    attempts,
    status,
    ...(record.selection === undefined ? {} : { selection: record.selection }),
    ...(promotion === undefined ? {} : { promotion }),
  }
}

function attemptView(
  record: DeepReadonly<ContestRecord>,
  attempt: DeepReadonly<ContestAttemptRecord>,
  state: DeepReadonly<ContestRuntimeState>,
): ContestAttempt {
  const bay = attemptBay(state, attempt)
  const runner = jobByKey(state, attemptRunnerKey(record.id, attempt.id))
  const output = passedRunnerOutput(runner)
  const evaluations = Object.fromEntries(
    record.evaluators.map((spec) => {
      const runs = evaluationJobs(state, record.id, attempt.id, spec.id).map((job, index): ContestEvaluationRun => {
        if (job.status === "passed") {
          return { generation: index + 1, job, result: EvaluatorResultSchema.parse(job.output) }
        }
        return { generation: index + 1, job }
      })
      const evaluation: ContestEvaluation = {
        evaluator: spec.id,
        authority: spec.authority,
        runs,
      }
      return [spec.id, evaluation]
    }),
  )
  const status = attemptStatus(bay, runner, output, evaluations)
  return {
    id: attempt.id,
    competitor: attempt.competitor,
    bayName: attempt.bayName,
    branch: attempt.branch,
    base: attempt.base,
    status,
    ...(bay === undefined ? {} : { bay }),
    ...(runner === undefined ? {} : { runner }),
    evaluations,
    ...(output === undefined
      ? { artifacts: [] }
      : {
          pin: output.pin,
          wallTimeMs: output.wallTimeMs,
          tokens: output.tokens,
          cost: output.cost,
          artifacts: output.artifacts,
        }),
  }
}

function attemptStatus(
  bay: DeepReadonly<Bay> | undefined,
  runner: DeepReadonly<Job> | undefined,
  output: AttemptRunOutput | undefined,
  evaluations: Readonly<Record<string, ContestEvaluation>>,
): ContestAttempt["status"] {
  if (bay === undefined || bay.status === "opening") return "preparing"
  if (bay.status !== "active") return "failed"
  if (runner === undefined) return "preparing"
  if (runner.status === "requested") return "queued"
  if (runner.status === "running") return "running"
  if (runner.status === "waiting") return "waiting"
  if (runner.status === "lost") return "lost"
  if (runner.status === "failed" || output === undefined) return "failed"
  const heldOut = Object.values(evaluations).filter(({ authority }) => authority === "held-out")
  const latest = heldOut.map(({ runs }) => runs.at(-1))
  if (latest.some((run) => run?.job.status === "lost")) return "lost"
  if (latest.some((run) => run?.job.status === "failed")) return "failed"
  if (latest.some((run) => run?.job.status === "waiting")) return "waiting"
  if (latest.some((run) => run?.job.status !== "passed")) return "evaluating"
  return latest.some((run) => run?.result?.verdict !== "passed") ? "rejected" : "passing"
}

function requiredContest(state: DeepReadonly<ContestsState>, id: string): DeepReadonly<ContestRecord> {
  const contest = state.records[id]
  if (contest === undefined) throw new Error(`yrd: no contest '${id}'`)
  return contest
}

function requiredAttempt(contest: DeepReadonly<ContestRecord>, id: string): DeepReadonly<ContestAttemptRecord> {
  const attempt = contest.attempts[id]
  if (attempt === undefined) throw new Error(`yrd: contest '${contest.id}' has no attempt '${id}'`)
  return attempt
}

function attemptBay(
  state: DeepReadonly<Pick<ContestRuntimeState, "bays">>,
  attempt: DeepReadonly<ContestAttemptRecord>,
): DeepReadonly<Bay> | undefined {
  const bay = resolveBay(state.bays, attempt.bayName)
  if (bay === undefined) return undefined
  if (bay.name !== attempt.bayName || bay.branch !== attempt.branch || bay.base !== attempt.base) {
    throw new Error(`yrd: Bay '${bay.id}' does not match contest attempt '${attempt.id}'`)
  }
  return bay
}

function baySnapshot(bay: DeepReadonly<Bay>) {
  return ContestBaySchema.parse({
    id: bay.id,
    name: bay.name,
    branch: bay.branch,
    base: bay.base,
    status: bay.status,
    ...(bay.path === undefined ? {} : { path: bay.path }),
    ...(bay.headSha === undefined ? {} : { headSha: bay.headSha }),
    ...(bay.baseSha === undefined ? {} : { baseSha: bay.baseSha }),
    ...(bay.dirty === undefined ? {} : { dirty: bay.dirty }),
  })
}

function jobByKey(state: DeepReadonly<Pick<ContestRuntimeState, "jobs">>, key: string): DeepReadonly<Job> | undefined {
  const id = state.jobs.byKey[key]
  return id === undefined ? undefined : state.jobs.byId[id]
}

function evaluationJobs(
  state: DeepReadonly<Pick<ContestRuntimeState, "jobs">>,
  contest: string,
  attempt: string,
  evaluator: string,
): readonly DeepReadonly<Job>[] {
  const jobs: DeepReadonly<Job>[] = []
  for (let generation = 1; ; generation += 1) {
    const job = jobByKey(state, attemptEvaluatorKey(contest, attempt, evaluator, generation))
    if (job === undefined) return jobs
    jobs.push(job)
  }
}

function failedEvaluationVerdict(job: DeepReadonly<Job>): boolean {
  return job.status === "passed" && EvaluatorResultSchema.parse(job.output).verdict !== "passed"
}

function passedRunnerOutput(job: DeepReadonly<Job> | undefined): AttemptRunOutput | undefined {
  return job?.status === "passed" ? AttemptRunOutputSchema.parse(job.output) : undefined
}

function exactPR(pr: DeepReadonly<PR>, pin: DeepReadonly<z.infer<typeof GitRevisionPinSchema>>, base: string): boolean {
  return (
    pr.bay === pin.bay &&
    pr.branch === pin.branch &&
    pr.base === base &&
    pr.headSha.toLowerCase() === pin.commit.toLowerCase()
  )
}

function competitorOf(definition: CompetitorDef): Competitor {
  const parsed = CompetitorDefSchema.parse(definition)
  const id = `cmp-${Command.hash({ op: "contest.competitor", args: parsed })}`
  return { ...parsed, id }
}

function runnerJobDef(runner: ContestRunnerDef): RunnerJobDef {
  return createJobDef({
    name: `contest.runner.${DefIdSchema.parse(runner.harness)}`,
    title: `Run ${runner.harness} contest attempt`,
    revision: TextSchema.parse(runner.revision),
    input: ContestRunnerInputSchema,
    output: AttemptRunOutputSchema,
    async execute(input, context) {
      const result = await runner.run(input, context)
      if (result.status !== "passed") return result
      const output = AttemptRunOutputSchema.parse(result.output)
      const expectedRef = `refs/yrd/attempts/${input.contest}/${input.attempt}`
      if (output.pin.bay !== input.bay.id || output.pin.branch !== input.bay.branch || output.pin.ref !== expectedRef) {
        return failed("attempt-pin-mismatch", `runner returned a pin outside '${input.contest}/${input.attempt}'`)
      }
      if (input.bay.baseSha !== undefined && output.pin.baseSha !== input.bay.baseSha) {
        return failed("attempt-base-mismatch", "runner returned a pin from a different base commit")
      }
      return { status: "passed", output }
    },
  })
}

function evaluatorJobDef(evaluator: ContestEvaluatorDef): EvaluatorJobDef {
  return createJobDef({
    name: `contest.evaluator.${DefIdSchema.parse(evaluator.id)}`,
    title: `Evaluate contest attempt with ${evaluator.id}`,
    revision: TextSchema.parse(evaluator.revision),
    input: ContestEvaluatorInputSchema,
    output: EvaluatorResultSchema,
    execute: (input, context) => evaluator.evaluate(input, context),
  })
}

function promotionJobDef(git: ContestGit): PromotionJobDef {
  return createJobDef({
    name: "contest.promotion.verify",
    title: "Verify selected contest revision",
    revision: git.revision,
    input: PromotionRequestSchema,
    output: PromotionVerifiedSchema,
    async execute(input, context) {
      try {
        const resolved = await git.resolveCommit(input.pin.ref, context.signal)
        if (resolved?.toLowerCase() !== input.pin.commit.toLowerCase()) {
          return failed("pin-moved", `Git ref '${input.pin.ref}' resolves to '${resolved ?? "missing"}'`)
        }
        return { status: "passed", output: { commit: input.pin.commit.toLowerCase() } }
      } catch (error) {
        return failed("pin-resolution-failed", error)
      }
    },
  })
}

function failed(code: string, cause: unknown): JobResult<never> {
  return { status: "failed", error: { code, message: cause instanceof Error ? cause.message : String(cause) } }
}

function definitionMap<Value extends object, Key extends keyof Value>(
  values: readonly Value[],
  key: Key,
  label: string,
): ReadonlyMap<string, Value> {
  const result = new Map<string, Value>()
  for (const value of values) {
    const id = DefIdSchema.parse(value[key])
    if (result.has(id)) throw new Error(`yrd: duplicate ${label} '${id}'`)
    result.set(id, Object.freeze({ ...value }))
  }
  return result
}

function normalizeGit(git: ContestGit): ContestGit {
  return Object.freeze({ revision: TextSchema.parse(git.revision), resolveCommit: git.resolveCommit.bind(git) })
}

function nextId(prefix: string, records: Readonly<Record<string, unknown>>): string {
  const values = Object.keys(records)
    .filter((id) => new RegExp(`^${prefix}\\d+$`, "u").test(id))
    .map((id) => Number(id.slice(prefix.length)))
  return `${prefix}${Math.max(0, ...values) + 1}`
}

function attemptRunnerKey(contest: string, attempt: string): string {
  return `contest:${contest}:attempt:${attempt}:runner`
}

function attemptEvaluatorKey(contest: string, attempt: string, evaluator: string, generation = 1): string {
  const base = `contest:${contest}:attempt:${attempt}:evaluator:${evaluator}`
  return generation === 1 ? base : `${base}:generation:${generation}`
}

function promotionKey(contest: string): string {
  return `contest:${contest}:promotion`
}
