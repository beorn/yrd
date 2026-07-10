import {
  command,
  event,
  type Command,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type Frame,
  type JsonValue,
  type YrdDef,
  JsonSchema,
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
  executor: string
}>

type JobEvidence = Readonly<{
  token?: string
  url?: string
  detail?: string
  artifacts?: readonly JsonValue[]
  checkpoint?: JsonValue
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

export const JobTransitionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("start"),
      id: IdSchema,
      attempt: AttemptSchema,
      executor: IdSchema,
      leaseExpiresAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("heartbeat"),
      id: IdSchema,
      attempt: AttemptSchema,
      executor: IdSchema,
      leaseExpiresAt: TimestampSchema,
    })
    .strict(),
  JobWaitingSchema.omit({ status: true })
    .extend({
      type: z.literal("wait"),
      id: IdSchema,
      attempt: AttemptSchema,
      executor: IdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("finish"),
      id: IdSchema,
      attempt: AttemptSchema,
      executor: IdSchema,
      token: IdSchema.optional(),
      result: TerminalResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("lose"),
      id: IdSchema,
      attempt: AttemptSchema,
      executor: IdSchema,
      leaseExpiresAt: TimestampSchema,
      reason: z.string().min(1),
    })
    .strict(),
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
          executor: change.executor,
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

      case "retry":
        requireStatus(current, "lost or failed", "lost", "failed")
        return { ...jobBase(current), status: "requested", changedAt: at }
    }
  },

  owns(job: Job, attempt: number, executor: string, status: Job["status"]): boolean {
    return job.status === status && job.attempt === attempt && "executor" in job && job.executor === executor
  },

  terminal(job: DeepReadonly<Job>): boolean {
    return job.status === "passed" || job.status === "failed" || job.status === "lost"
  },
})

export type RunJobOptions = Readonly<{
  executor: string
  leaseMs: number
  heartbeatMs?: number
  now?: () => number
}>

export type RunManyJobOptions = RunJobOptions & Readonly<{ concurrency?: number }>

export type JobCompletion<Output extends JsonValue = JsonValue> = Readonly<{
  attempt: number
  executor: string
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
  retry(id: string): Promise<Job>
  recover(options: Readonly<{ now: string; reason?: string }>): Promise<readonly string[]>
  requested(source: Frame | readonly Event[]): readonly string[]
}>

type JobScope = Scope

export type CreateJobsOptions = Readonly<{
  definitions: JobDefs
  state: ReadSignal<DeepReadonly<JobsState>>
  transition(change: JobTransition): Promise<Frame>
  scope: JobScope
  log: ConditionalLogger
}>

const RunOptionsSchema = z
  .object({
    executor: IdSchema,
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
    executor: IdSchema,
    token: IdSchema.optional(),
  })
  .strict()

const RecoverOptionsSchema = z
  .object({
    now: TimestampSchema,
    reason: z.string().min(1).optional(),
  })
  .strict()

export function createJobs(options: CreateJobsOptions): Jobs {
  const definitions = new Map(Object.entries(options.definitions))
  const state = options.state
  const commit = options.transition

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
      executor: runOptions.executor,
      leaseMs: runOptions.leaseMs,
      heartbeatMs: runOptions.heartbeatMs,
    })
    const heartbeatMs = parsed.heartbeatMs ?? Math.max(1, Math.floor(parsed.leaseMs / 3))
    const requested = current(id)
    requireStatus(requested, "requested", "requested")
    using _span = options.log.span?.("run", {
      id,
      definition: requested.definition,
      attempt: requested.attempt + 1,
    })
    const installed = definitionFor(requested)
    const attempt = requested.attempt + 1
    const now = runOptions.now ?? Date.now

    await commit({
      type: "start",
      id,
      attempt,
      executor: parsed.executor,
      leaseExpiresAt: lease(now, parsed.leaseMs),
    })
    const started = current(id)
    if (!Job.owns(started, attempt, parsed.executor, "running")) return started

    const scope = options.scope.child(`job:${id}:${attempt}`)
    const outcome = await executeWithHeartbeat(
      scope,
      () => installed.execute(requested.input, { id, attempt, executor: parsed.executor, signal: scope.signal }),
      heartbeatMs,
      async () => {
        const active = current(id)
        if (!Job.owns(active, attempt, parsed.executor, "running")) {
          throw new Error(`yrd: job '${id}' lost execution ownership`)
        }
        await commit({
          type: "heartbeat",
          id,
          attempt,
          executor: parsed.executor,
          leaseExpiresAt: lease(now, parsed.leaseMs),
        })
      },
    )

    const active = current(id)
    if (!Job.owns(active, attempt, parsed.executor, "running")) return active
    const result = outcome.heartbeatError ? failed("heartbeat-failed", outcome.heartbeatError) : outcome.result
    await commit(settlement(id, attempt, parsed.executor, result))
    return current(id)
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
        executor: runManyOptions.executor,
        leaseMs: runManyOptions.leaseMs,
        ...(runManyOptions.heartbeatMs === undefined ? {} : { heartbeatMs: runManyOptions.heartbeatMs }),
        ...(runManyOptions.now === undefined ? {} : { now: runManyOptions.now }),
      }
      const results: Job[] = []
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < ids.length) {
          const index = next++
          const id = ids[index]!
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
        executor: completion.executor,
        token: completion.token,
      })
      const result = jobTerminalResultSchema(installedDef.output).parse(completion.result)
      await commit({ type: "finish", id, ...metadata, result })
      return current(id)
    },

    async retry(id) {
      await commit({ type: "retry", id })
      return current(id)
    },

    async recover(recoverOptions) {
      const parsed = RecoverOptionsSchema.parse(recoverOptions)
      const cutoff = Date.parse(parsed.now)
      const recovered: string[] = []
      for (const job of Object.values(state().byId)) {
        if (job.status !== "running" || Date.parse(job.leaseExpiresAt) > cutoff) continue
        try {
          await commit({
            type: "lose",
            id: job.id,
            attempt: job.attempt,
            executor: job.executor,
            leaseExpiresAt: job.leaseExpiresAt,
            reason: parsed.reason ?? "executor lease expired",
          })
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
    transition: Command<JobTransition, object>
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
      project: projectJobs,
      create(yrd) {
        return {
          jobs: createJobs({
            definitions,
            state: computed(() => yrd.state().jobs),
            transition: (change) => yrd.command(transition, change),
            scope: yrd.scope,
            log: yrd.log.child("jobs"),
          }),
        }
      },
    })
}

function mergeJobDefs(input: JobsOptions["definitions"]): JobDefs {
  const groups: readonly JobDefs[] = input === undefined ? [] : Array.isArray(input) ? input : [input as JobDefs]
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

async function executeWithHeartbeat(
  scope: JobScope,
  execute: () => Promise<JobResult>,
  heartbeatMs: number,
  heartbeat: () => Promise<void>,
): Promise<{ result: JobResult; heartbeatError?: unknown }> {
  let heartbeatError: unknown
  let heartbeats = Promise.resolve()
  scope.interval(() => {
    heartbeats = heartbeats.then(async () => {
      if (heartbeatError === undefined) {
        try {
          await heartbeat()
        } catch (error) {
          heartbeatError = error
          await scope.disposeAsync()
        }
      }
      return undefined
    })
  }, heartbeatMs)

  let result: JobResult
  try {
    result = await execute()
  } catch (error) {
    result = failed("executor-error", error)
  } finally {
    await scope[Symbol.asyncDispose]()
    await heartbeats
  }
  return { result, ...(heartbeatError === undefined ? {} : { heartbeatError }) }
}

function settlement(id: string, attempt: number, executor: string, result: JobResult): JobTransition {
  if (result.status === "waiting") {
    const { status: _status, ...waiting } = result
    return { type: "wait", id, attempt, executor, ...waiting }
  }
  return { type: "finish", id, attempt, executor, result }
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

function execution(job: Exclude<Job, { status: "requested" }>): JobBase & JobExecution {
  return { ...jobBase(job), startedAt: job.startedAt, executor: job.executor }
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

function requireOwner(job: Job, change: { attempt: number; executor: string }): void {
  if (job.attempt !== change.attempt) {
    throw new Error(`yrd: job '${job.id}' attempt ${change.attempt} is stale; current attempt is ${job.attempt}`)
  }
  if (!("executor" in job) || job.executor !== change.executor) {
    throw new Error(`yrd: job '${job.id}' executor mismatch`)
  }
}

function requireStatus<Status extends Job["status"]>(
  job: Job,
  expected: string,
  ...allowed: readonly Status[]
): asserts job is Extract<Job, { status: Status }> {
  if (!(allowed as readonly Job["status"][]).includes(job.status)) {
    throw new Error(`yrd: job '${job.id}' is ${job.status}, not ${expected}`)
  }
}

function sameLease(left: Job, right: Extract<Job, { status: "running" }>): boolean {
  return (
    left.status === "running" &&
    left.attempt === right.attempt &&
    left.executor === right.executor &&
    left.leaseExpiresAt === right.leaseExpiresAt
  )
}
