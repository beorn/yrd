import {
  command,
  event,
  type CommandHandler,
  type CommandResult,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type JsonValue,
  type YrdDef,
  JsonSchema,
  observeYrdLifecycle,
} from "@yrd/core"
import type { Scope } from "@silvery/scope"
import { computed, type ReadSignal } from "@silvery/signals"
import type { ConditionalLogger } from "loggily"
import * as z from "zod"
import {
  JobErrorSchema,
  JobRequestSchema,
  JobWaitingSchema,
  jobTerminalResultSchema,
  type JobDef,
  type JobError,
  type JobRequest,
  type JobResult,
  type JobWaiting,
} from "./job.ts"

type JobBase = Readonly<{
  id: string
  definition: string
  revision: string
  input: JsonValue
  key?: string
  attempt: number
  requestedAt: string
  changedAt: string
}>

type JobExecution = Readonly<{
  startedAt: string
  runner: string
}>

type JobEvidence = Readonly<{
  token?: string
  url?: string
  detail?: string
  artifacts?: readonly JsonValue[]
  checkpoint?: JsonValue
}>

type JobCancellation = Readonly<{
  status: "canceled"
  finishedAt: string
  canceledBy: string
  cancelReason: string
}>

export type Job =
  | (JobBase & { status: "requested" })
  | (JobBase & JobExecution & { status: "running"; leaseExpiresAt: string })
  | (JobBase & JobExecution & JobEvidence & { status: "waiting"; token: string })
  | (JobBase & JobExecution & JobEvidence & { status: "passed"; finishedAt: string; output: JsonValue })
  | (JobBase &
      JobExecution &
      JobEvidence & { status: "failed"; finishedAt: string; error: JobError; output?: JsonValue })
  | (JobBase & JobExecution & { status: "lost"; finishedAt: string; lostReason: string })
  | (JobBase & JobCancellation)
  | (JobBase & JobExecution & JobEvidence & JobCancellation)

export type JobsState = Readonly<{
  byId: Readonly<Record<string, Job>>
  byKey: Readonly<Record<string, string>>
}>

const IdSchema = z.string().trim().min(1)
const AttemptSchema = z.number().int().positive()
const TimestampSchema = z.iso.datetime({ precision: 3 })

const TerminalResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("passed"), output: JsonSchema }).strict(),
  z.object({ status: z.literal("failed"), error: JobErrorSchema, output: JsonSchema.optional() }).strict(),
])

const CancelJobInputSchema = z
  .object({
    id: IdSchema,
    attempt: z.number().int().nonnegative(),
    by: IdSchema,
    reason: z.string().trim().min(1),
  })
  .strict()
export type CancelJobInput = Readonly<z.infer<typeof CancelJobInputSchema>>

export const JobTransitionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("start"),
      id: IdSchema,
      attempt: AttemptSchema,
      runner: IdSchema,
      leaseExpiresAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("heartbeat"),
      id: IdSchema,
      attempt: AttemptSchema,
      runner: IdSchema,
      leaseExpiresAt: TimestampSchema,
    })
    .strict(),
  JobWaitingSchema.omit({ status: true })
    .extend({
      type: z.literal("wait"),
      id: IdSchema,
      attempt: AttemptSchema,
      runner: IdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("finish"),
      id: IdSchema,
      attempt: AttemptSchema,
      runner: IdSchema,
      token: IdSchema.optional(),
      result: TerminalResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("lose"),
      id: IdSchema,
      attempt: AttemptSchema,
      runner: IdSchema,
      leaseExpiresAt: TimestampSchema,
      reason: z.string().min(1),
    })
    .strict(),
  CancelJobInputSchema.extend({ type: z.literal("cancel") }).strict(),
  z.object({ type: z.literal("retry"), id: IdSchema }).strict(),
])
export type JobTransition = z.infer<typeof JobTransitionSchema>

export const Job = Object.freeze({
  requested(id: string, at: string, request: JobRequest): Job {
    return {
      id,
      definition: request.definition,
      revision: request.revision,
      input: request.input,
      ...(request.key === undefined ? {} : { key: request.key }),
      status: "requested",
      attempt: 0,
      requestedAt: at,
      changedAt: at,
    }
  },

  apply(current: Job | undefined, change: JobTransition, at: string): Job {
    if (current === undefined) throw new Error(`yrd: no job '${change.id}'`)

    switch (change.type) {
      case "start":
        requireStatus(current, "requested", "requested")
        if (change.attempt !== current.attempt + 1) {
          throw new Error(`yrd: job '${current.id}' started attempt ${change.attempt} after attempt ${current.attempt}`)
        }
        return {
          ...jobBase(current),
          status: "running",
          attempt: change.attempt,
          changedAt: at,
          startedAt: at,
          runner: change.runner,
          leaseExpiresAt: change.leaseExpiresAt,
        }

      case "heartbeat":
        requireOwner(current, change)
        requireStatus(current, "running", "running")
        return { ...current, changedAt: at, leaseExpiresAt: change.leaseExpiresAt }

      case "wait":
        requireOwner(current, change)
        requireStatus(current, "running", "running")
        return {
          ...execution(current),
          ...evidence(change),
          status: "waiting",
          changedAt: at,
          token: change.token,
        }

      case "finish": {
        requireOwner(current, change)
        requireStatus(current, "running or waiting", "running", "waiting")
        if (current.status === "waiting" && change.token !== current.token) {
          throw new Error(`yrd: job '${current.id}' token mismatch`)
        }
        const finished = {
          ...execution(current),
          ...(current.status === "waiting" ? evidence(current) : {}),
          changedAt: at,
          finishedAt: at,
        }
        return change.result.status === "passed"
          ? { ...finished, status: "passed", output: change.result.output }
          : {
              ...finished,
              status: "failed",
              error: change.result.error,
              ...(change.result.output === undefined ? {} : { output: change.result.output }),
            }
      }

      case "lose":
        requireOwner(current, change)
        requireStatus(current, "running", "running")
        if (current.leaseExpiresAt !== change.leaseExpiresAt) {
          throw new Error(`yrd: job '${current.id}' lease changed before recovery`)
        }
        return {
          ...execution(current),
          status: "lost",
          changedAt: at,
          finishedAt: at,
          lostReason: change.reason,
        }

      case "cancel":
        requireAttempt(current, change)
        requireStatus(current, "requested, running or waiting", "requested", "running", "waiting")
        return {
          ...(current.status === "requested" ? jobBase(current) : execution(current)),
          ...(current.status === "waiting" ? evidence(current) : {}),
          status: "canceled",
          changedAt: at,
          finishedAt: at,
          canceledBy: change.by,
          cancelReason: change.reason,
        }

      case "retry":
        requireStatus(current, "lost or failed", "lost", "failed")
        return { ...jobBase(current), status: "requested", changedAt: at }
    }
  },

  owns(job: Job, attempt: number, runner: string, status: Job["status"]): boolean {
    return job.status === status && job.attempt === attempt && "runner" in job && job.runner === runner
  },

  terminal(job: DeepReadonly<Job>): boolean {
    return isTerminalJobStatus(job.status)
  },
})

const TERMINAL_JOB_STATUSES: ReadonlySet<Job["status"]> = new Set<Job["status"]>([
  "passed",
  "failed",
  "lost",
  "canceled",
])

/** A Job status is terminal once no further transition can run: passed/failed/lost/canceled. */
export function isTerminalJobStatus(status: Job["status"]): boolean {
  return TERMINAL_JOB_STATUSES.has(status)
}

/**
 * A transition guard rejected a Job change because the Job's current status did
 * not permit it. Always thrown, never returned, so an invalid single-writer
 * transition still fails loud. The carried `actual`/`expected` let a resident,
 * multi-tenant runner tell a losable concurrent-settlement race (a peer moved
 * the Job to a terminal state under it — see isConcurrentSettlementConflict)
 * apart from a genuine programmer error, without matching on the message text.
 */
export class JobStateConflict extends Error {
  readonly jobId: string
  readonly actual: Job["status"]
  readonly expected: string

  constructor(jobId: string, actual: Job["status"], expected: string) {
    super(`yrd: job '${jobId}' is ${actual}, not ${expected}`)
    this.name = "JobStateConflict"
    this.jobId = jobId
    this.actual = actual
    this.expected = expected
  }
}

/**
 * True when an error is a JobStateConflict whose Job had already reached a
 * terminal status — i.e. a concurrent writer settled (canceled/passed/failed/
 * lost) the Job between a runtime's snapshot and its action. This is a normal,
 * losable race for a long-lived resident runner: skip and continue. A conflict
 * against a still-live status (requested/running/waiting) is NOT losable — it
 * signals a real invalid transition and must keep propagating (fail-loud).
 */
export function isConcurrentSettlementConflict(error: unknown): error is JobStateConflict {
  return error instanceof JobStateConflict && isTerminalJobStatus(error.actual)
}

export type RunJobOptions = Readonly<{
  runner: string
  leaseMs: number
  heartbeatMs?: number
  now?: () => number
}>

export type RunManyJobOptions = RunJobOptions & Readonly<{ concurrency?: number }>

export type JobCompletion<Output extends JsonValue = JsonValue> = Readonly<{
  attempt: number
  runner: string
  token?: string
  result: Exclude<JobResult<Output>, JobWaiting>
}>

export type JobDefs = Readonly<Record<string, JobDef>>

export type Jobs = Readonly<{
  state: ReadSignal<DeepReadonly<JobsState>>
  definition(name: string): JobDef
  requireDefinitions(definitions: JobDefs): void
  get(id: string): DeepReadonly<Job> | undefined
  run(id: string, options: RunJobOptions): Promise<Job>
  runMany(ids: readonly string[], options: RunManyJobOptions): Promise<readonly Job[]>
  finish(id: string, completion: JobCompletion): Promise<Job>
  cancel(input: CancelJobInput): Promise<Job>
  retry(id: string): Promise<Job>
  recover(options: Readonly<{ now: string; reason?: string; runner?: string }>): Promise<readonly string[]>
  requested(source: CommandResult | readonly Event[]): readonly string[]
}>

type JobScope = Scope

export type CreateJobsOptions = Readonly<{
  definitions: JobDefs
  state: ReadSignal<DeepReadonly<JobsState>>
  transition(change: JobTransition): Promise<CommandResult>
  scope: JobScope
  log: ConditionalLogger
}>

const RunOptionsSchema = z
  .object({
    runner: IdSchema,
    leaseMs: z.number().int().min(2),
    heartbeatMs: z.number().int().positive().optional(),
  })
  .strict()
  .refine(({ heartbeatMs, leaseMs }) => heartbeatMs === undefined || heartbeatMs < leaseMs, {
    message: "heartbeatMs must be smaller than leaseMs",
    path: ["heartbeatMs"],
  })

const CompletionSchema = z
  .object({
    attempt: AttemptSchema,
    runner: IdSchema,
    token: IdSchema.optional(),
  })
  .strict()

const RecoverOptionsSchema = z
  .object({
    now: TimestampSchema,
    reason: z.string().min(1).optional(),
    runner: IdSchema.optional(),
  })
  .strict()

export function createJobs(options: CreateJobsOptions): Jobs {
  const definitions = new Map(Object.entries(options.definitions))
  const state = options.state
  const commit = options.transition
  const activeScopes = new Map<string, Readonly<{ attempt: number; scope: JobScope }>>()

  const definition = (name: string): JobDef => {
    const found = definitions.get(name)
    if (found === undefined) throw new Error(`yrd: no job definition '${name}'`)
    return found
  }

  const definitionFor = (job: Job): JobDef => {
    const found = definition(job.definition)
    if (found.revision !== job.revision) {
      throw new Error(
        `yrd: job '${job.id}' definition revision '${job.revision}' does not match installed revision '${found.revision}'`,
      )
    }
    return found
  }

  const current = (id: string): Job => {
    const job = state().byId[id]
    if (job === undefined) throw new Error(`yrd: no job '${id}'`)
    return job
  }

  const run = async (id: string, runOptions: RunJobOptions): Promise<Job> => {
    const parsed = RunOptionsSchema.parse({
      runner: runOptions.runner,
      leaseMs: runOptions.leaseMs,
      heartbeatMs: runOptions.heartbeatMs,
    })
    const heartbeatMs = parsed.heartbeatMs ?? Math.max(1, Math.floor(parsed.leaseMs / 3))
    const requested = current(id)
    requireStatus(requested, "requested", "requested")
    const installed = definitionFor(requested)
    const attempt = requested.attempt + 1
    const now = runOptions.now ?? Date.now
    const observation = installed.observe?.(requested.input) ?? {}
    return observeYrdLifecycle(
      options.log,
      {
        lifecycle: observation.lifecycle ?? "run",
        identity: { ...observation.identity, job: id, attempt, runner: parsed.runner },
        attributes: {
          ...observation.attributes,
          definition: requested.definition,
          revision: requested.revision,
          leaseMs: parsed.leaseMs,
        },
        outcome: (result) =>
          result.status === "passed"
            ? "succeeded"
            : result.status === "running" || result.status === "waiting"
              ? "progress"
              : "failed",
        resultAttributes: (result) => ({ status: result.status }),
      },
      async () => {
        await commit({
          type: "start",
          id,
          attempt,
          runner: parsed.runner,
          leaseExpiresAt: lease(now, parsed.leaseMs),
        })
        const started = current(id)
        if (!Job.owns(started, attempt, parsed.runner, "running")) return started

        const scope = options.scope.child(`job:${id}:${attempt}`)
        activeScopes.set(id, { attempt, scope })
        let outcome: Awaited<ReturnType<typeof executeWithHeartbeat>>
        try {
          outcome = await executeWithHeartbeat(
            scope,
            (progress) =>
              installed.execute(requested.input, {
                id,
                attempt,
                runner: parsed.runner,
                signal: progress.signal,
                observeProgress: progress.observe,
                reportProgress: progress.report,
              }),
            heartbeatMs,
            async (renew) => {
              const active = current(id)
              if (!Job.owns(active, attempt, parsed.runner, "running")) {
                throw new Error(`yrd: job '${id}' lost execution ownership`)
              }
              if (!renew) {
                if (Date.parse(active.leaseExpiresAt) <= now()) {
                  throw new ProgressLeaseExpiredError(id, active.leaseExpiresAt)
                }
                return
              }
              await commit({
                type: "heartbeat",
                id,
                attempt,
                runner: parsed.runner,
                leaseExpiresAt: lease(now, parsed.leaseMs),
              })
            },
          )
        } finally {
          const active = activeScopes.get(id)
          if (active?.attempt === attempt && active.scope === scope) activeScopes.delete(id)
        }

        const active = current(id)
        if (!Job.owns(active, attempt, parsed.runner, "running")) return active
        const result =
          outcome.heartbeatError === undefined
            ? outcome.result
            : failed(
                outcome.heartbeatError instanceof ProgressLeaseExpiredError ? "progress-stalled" : "heartbeat-failed",
                outcome.heartbeatError,
              )
        await commit(settlement(id, attempt, parsed.runner, result))
        return current(id)
      },
    )
  }

  return {
    state,
    definition,

    requireDefinitions(required) {
      for (const [name, expected] of Object.entries(required)) {
        const installed = definition(name)
        if (installed.revision !== expected.revision) {
          throw new Error(
            `yrd: installed job definition '${name}' revision '${installed.revision}' does not match required revision '${expected.revision}'`,
          )
        }
      }
    },

    get(id) {
      return state().byId[id]
    },

    run,

    async runMany(ids, runManyOptions) {
      if (new Set(ids).size !== ids.length) throw new Error("yrd: Jobs.runMany requires unique Job ids")
      const concurrency = z
        .number()
        .int()
        .positive()
        .parse(runManyOptions.concurrency ?? 1)
      const runOptions: RunJobOptions = {
        runner: runManyOptions.runner,
        leaseMs: runManyOptions.leaseMs,
        ...(runManyOptions.heartbeatMs === undefined ? {} : { heartbeatMs: runManyOptions.heartbeatMs }),
        ...(runManyOptions.now === undefined ? {} : { now: runManyOptions.now }),
      }
      const results: Job[] = []
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < ids.length) {
          const index = next++
          const id = ids[index]
          if (id === undefined) break
          const job = current(id)
          results[index] = job.status === "requested" ? await run(id, runOptions) : job
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker))
      return results
    },

    async finish(id, completion) {
      const job = current(id)
      // A revision pins execution behavior. Its output contract remains stable under the definition name.
      const installedDef = definition(job.definition)
      const metadata = CompletionSchema.parse({
        attempt: completion.attempt,
        runner: completion.runner,
        ...(completion.token === undefined ? {} : { token: completion.token }),
      })
      const result = jobTerminalResultSchema(installedDef.output).parse(completion.result)
      await commit({ type: "finish", id, ...metadata, result })
      return current(id)
    },

    async cancel(input) {
      const parsed = CancelJobInputSchema.parse(input)
      await commit({ type: "cancel", ...parsed })
      const active = activeScopes.get(parsed.id)
      if (active?.attempt === parsed.attempt) await active.scope[Symbol.asyncDispose]()
      return current(parsed.id)
    },

    async retry(id) {
      await commit({ type: "retry", id })
      return current(id)
    },

    async recover(recoverOptions) {
      const parsed = RecoverOptionsSchema.parse(recoverOptions)
      const cutoff = Date.parse(parsed.now)
      // With `runner` set the caller asserts that runner is dead: reclaim its
      // running jobs regardless of lease expiry, PLUS every other running job
      // whose lease has lapsed past `now` — the UNION (merge-queue R40a2). A
      // runner-scoped reclaim must never walk past cutoff-expired leases: this
      // is lease-cutoff recovery, the named runner only widens it. Without
      // `runner`, reclaim expired leases alone. Per-job reasons stay truthful:
      // the caller's dead-runner reason applies only to the named runner's
      // jobs; an expired lease of another runner says so.
      const deadRunner = parsed.runner
      const recovered: string[] = []
      for (const job of Object.values(state().byId)) {
        if (job.status !== "running") continue
        const named = deadRunner !== undefined && job.runner === deadRunner
        const expired = Date.parse(job.leaseExpiresAt) <= cutoff
        if (!named && !expired) continue
        const reason =
          named || deadRunner === undefined
            ? (parsed.reason ?? (named ? "runner disappeared" : "runner lease expired"))
            : "runner lease expired"
        try {
          await observeYrdLifecycle(
            options.log,
            {
              lifecycle: "recover",
              identity: { job: job.id, attempt: job.attempt, runner: job.runner },
              attributes: {
                leaseExpiresAt: job.leaseExpiresAt,
                reason,
              },
              outcome: "recovered",
            },
            () =>
              commit({
                type: "lose",
                id: job.id,
                attempt: job.attempt,
                runner: job.runner,
                leaseExpiresAt: job.leaseExpiresAt,
                reason,
              }),
          )
        } catch (error) {
          const latest = current(job.id)
          if (!sameLease(latest, job)) continue
          throw error
        }
        recovered.push(job.id)
      }
      return recovered
    },

    requested(source) {
      const events: readonly Event[] = "events" in source ? source.events : source
      return events.filter(({ name }) => name === "job/requested").map(({ id }) => id)
    },
  }
}

export type JobCommands = Readonly<{
  job: Readonly<{
    transition: CommandHandler<JobTransition, object>
  }>
}>

export type HasJobs = Readonly<{ jobs: Jobs }>

export type JobsOptions = Readonly<{
  definitions?: JobDefs | readonly JobDefs[]
}>

export function withJobs(options: JobsOptions = {}) {
  const definitions = mergeJobDefs(options.definitions)
  const transition = command({
    title: "Transition job",
    params: JobTransitionSchema,
    apply: (_state: object, change: JobTransition) => ({
      events: [event("job/transitioned", change)],
    }),
  })

  return <State extends object, Commands extends CommandTree, Features extends object>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { jobs: { byId: {}, byKey: {} } satisfies JobsState },
      commands: { job: { transition } },
      events: {
        "job/requested": JobRequestSchema,
        "job/transitioned": JobTransitionSchema,
      },
      projectionVersion: "jobs-v1",
      project: projectJobs,
      create(yrd) {
        return {
          jobs: createJobs({
            definitions,
            state: computed(() => yrd.state().jobs),
            transition: (change) => yrd.dispatch(transition, change),
            scope: yrd.scope,
            log: yrd.log.child("jobs"),
          }),
        }
      },
    })
}

function mergeJobDefs(input: JobsOptions["definitions"]): JobDefs {
  const groups: readonly JobDefs[] =
    input === undefined ? [] : Array.isArray(input) ? (input as readonly JobDefs[]) : [input as JobDefs]
  const definitions: Record<string, JobDef> = {}
  for (const group of groups) {
    for (const [name, definition] of Object.entries(group)) {
      if (name !== definition.name) {
        throw new Error(`yrd: job definition '${definition.name}' is registered as '${name}'`)
      }
      if (Object.hasOwn(definitions, name)) throw new Error(`yrd: duplicate job definition '${name}'`)
      definitions[name] = definition
    }
  }
  return Object.freeze(definitions)
}

function projectJobs(state: DeepReadonly<{ jobs: JobsState }>, applied: Event): { jobs: JobsState } {
  if (applied.name === "job/requested") {
    const request = applied.data as JobRequest
    if (state.jobs.byId[applied.id] !== undefined) throw new Error(`yrd: duplicate job '${applied.id}'`)
    if (request.key !== undefined && state.jobs.byKey[request.key] !== undefined) {
      throw new Error(`yrd: job key '${request.key}' is already in use`)
    }
    return {
      ...state,
      jobs: {
        byId: { ...state.jobs.byId, [applied.id]: Job.requested(applied.id, applied.ts, request) },
        byKey: request.key === undefined ? state.jobs.byKey : { ...state.jobs.byKey, [request.key]: applied.id },
      },
    }
  }
  if (applied.name !== "job/transitioned") return state
  const change = applied.data as JobTransition
  return {
    ...state,
    jobs: {
      ...state.jobs,
      byId: {
        ...state.jobs.byId,
        [change.id]: Job.apply(state.jobs.byId[change.id], change, applied.ts),
      },
    },
  }
}

class ProgressLeaseExpiredError extends Error {
  constructor(job: string, leaseExpiresAt: string) {
    super(`yrd: job '${job}' progress lease expired at ${leaseExpiresAt}`)
  }
}

async function executeWithHeartbeat(
  scope: JobScope,
  execute: (progress: Readonly<{ signal: AbortSignal; observe(): void; report(): void }>) => Promise<JobResult>,
  heartbeatMs: number,
  heartbeat: (renew: boolean) => Promise<void>,
): Promise<{ result: JobResult; heartbeatError?: unknown }> {
  let heartbeatError: unknown
  let heartbeats = Promise.resolve()
  let observesProgress = false
  let progressRevision = 0
  let renewedRevision = 0
  let detachExecution = false
  const executionScope = scope.child("execute")
  const heartbeatFailure = Promise.withResolvers<void>()
  const cancelHeartbeat = scope.interval(() => {
    const renew = !observesProgress || progressRevision !== renewedRevision
    if (renew) renewedRevision = progressRevision
    heartbeats = heartbeats.then(async () => {
      if (heartbeatError === undefined) {
        try {
          await heartbeat(renew)
        } catch (error) {
          heartbeatError = error
          detachExecution = true
          await executionScope[Symbol.asyncDispose]()
          heartbeatFailure.resolve()
        }
      }
      return undefined
    })
  }, heartbeatMs)
  const execution = execute({
    signal: executionScope.signal,
    observe() {
      observesProgress = true
    },
    report() {
      observesProgress = true
      progressRevision += 1
    },
  })
  scope.use({
    async [Symbol.asyncDispose]() {
      cancelHeartbeat()
      if (detachExecution) {
        void execution.catch(() => undefined)
        return
      }
      await execution.catch(() => undefined)
    },
  })

  let result: JobResult
  try {
    const settled = await Promise.race([
      execution.then(
        (value) => ({ type: "result" as const, value }),
        (error: unknown) => ({ type: "error" as const, error }),
      ),
      heartbeatFailure.promise.then(() => ({ type: "heartbeat" as const })),
    ])
    result =
      settled.type === "result"
        ? settled.value
        : failed("runner-error", settled.type === "error" ? settled.error : heartbeatError)
  } finally {
    await scope[Symbol.asyncDispose]()
    await heartbeats
  }
  return { result, ...(heartbeatError === undefined ? {} : { heartbeatError }) }
}

function settlement(id: string, attempt: number, runner: string, result: JobResult): JobTransition {
  if (result.status === "waiting") {
    const { status: _status, ...waiting } = result
    return { type: "wait", id, attempt, runner, ...waiting }
  }
  return { type: "finish", id, attempt, runner, result }
}

function failed(code: string, error: unknown): JobResult<never> {
  return {
    status: "failed",
    error: { code, message: error instanceof Error ? error.message : String(error) },
  }
}

function lease(now: () => number, leaseMs: number): string {
  return new Date(now() + leaseMs).toISOString()
}

function jobBase(job: Job): JobBase {
  const { id, definition, revision, input, key, attempt, requestedAt, changedAt } = job
  return { id, definition, revision, input, ...(key === undefined ? {} : { key }), attempt, requestedAt, changedAt }
}

function execution(job: Job & JobExecution): JobBase & JobExecution {
  return { ...jobBase(job), startedAt: job.startedAt, runner: job.runner }
}

function evidence(source: JobEvidence): JobEvidence {
  return {
    ...(source.token === undefined ? {} : { token: source.token }),
    ...(source.url === undefined ? {} : { url: source.url }),
    ...(source.detail === undefined ? {} : { detail: source.detail }),
    ...(source.artifacts === undefined ? {} : { artifacts: source.artifacts }),
    ...(source.checkpoint === undefined ? {} : { checkpoint: source.checkpoint }),
  }
}

function requireOwner(job: Job, change: { attempt: number; runner: string }): void {
  requireAttempt(job, change)
  if (!("runner" in job) || job.runner !== change.runner) {
    throw new Error(`yrd: job '${job.id}' runner mismatch`)
  }
}

function requireAttempt(job: Job, change: { attempt: number }): void {
  if (job.attempt !== change.attempt) {
    throw new Error(`yrd: job '${job.id}' attempt ${change.attempt} is stale; current attempt is ${job.attempt}`)
  }
}

function requireStatus<Status extends Job["status"]>(
  job: Job,
  expected: string,
  ...allowed: readonly Status[]
): asserts job is Extract<Job, { status: Status }> {
  if (!(allowed as readonly Job["status"][]).includes(job.status)) {
    throw new JobStateConflict(job.id, job.status, expected)
  }
}

function sameLease(left: Job, right: Extract<Job, { status: "running" }>): boolean {
  return (
    left.status === "running" &&
    left.attempt === right.attempt &&
    left.runner === right.runner &&
    left.leaseExpiresAt === right.leaseExpiresAt
  )
}
