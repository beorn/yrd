import {
  command,
  event,
  journalEvent,
  type CommandHandler,
  type CommandResult,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type JsonValue,
  type YrdDef,
  JsonSchema,
  observeYrdLifecycle,
  parseJournalFrame,
  type JournalHistory,
  systemClock,
} from "@yrd/core"
import type { Scope } from "@silvery/scope"
import { computed, type ReadSignal } from "@silvery/signals"
import type { ConditionalLogger } from "loggily"
import * as z from "zod"
import {
  JobRequestSchema,
  JobWaitingSchema,
  JobErrorSchema,
  jobTerminalResultSchema,
  type JobDef,
  type JobConclusion,
  type JobError,
  type JobRequest,
  type JobResult,
  type JobWaiting,
  type RuntimeContext,
} from "./job.ts"

const IdSchema = z.string().trim().min(1)
const AttemptSchema = z.number().int().positive()
const TimestampSchema = z.iso.datetime({ precision: 3 })
const JobBaseSchema = z
  .object({
    id: IdSchema,
    definition: IdSchema,
    revision: IdSchema,
    input: JsonSchema,
    key: IdSchema.optional(),
    attempt: z.number().int().nonnegative(),
    requestedAt: TimestampSchema,
    changedAt: TimestampSchema,
  })
  .strict()
const JobExecutionSchema = z
  .object({ startedAt: TimestampSchema, runner: IdSchema, context: IdSchema.optional() })
  .strict()
const JobEvidenceSchema = z
  .object({
    token: IdSchema.optional(),
    url: z.string().min(1).optional(),
    detail: z.string().optional(),
    artifacts: z.array(JsonSchema).optional(),
    checkpoint: JsonSchema.optional(),
  })
  .strict()
const ExecutingJobBaseSchema = JobBaseSchema.extend(JobExecutionSchema.shape)
const EvidencedJobBaseSchema = ExecutingJobBaseSchema.extend(JobEvidenceSchema.shape)
const JobSchema = z.union([
  JobBaseSchema.extend({ status: z.literal("queued") }).strict(),
  ExecutingJobBaseSchema.extend({ status: z.literal("in_progress"), leaseExpiresAt: TimestampSchema }).strict(),
  EvidencedJobBaseSchema.extend({ status: z.literal("waiting"), token: IdSchema }).strict(),
  EvidencedJobBaseSchema.extend({
    status: z.literal("completed"),
    conclusion: z.literal("success"),
    finishedAt: TimestampSchema,
    output: JsonSchema,
  }).strict(),
  EvidencedJobBaseSchema.extend({
    status: z.literal("completed"),
    conclusion: z.literal("failure"),
    finishedAt: TimestampSchema,
    error: JobErrorSchema,
    output: JsonSchema.optional(),
  }).strict(),
  ExecutingJobBaseSchema.extend({
    status: z.literal("completed"),
    conclusion: z.literal("timed_out"),
    finishedAt: TimestampSchema,
    lostReason: z.string().min(1),
  }).strict(),
  JobBaseSchema.extend({
    status: z.literal("completed"),
    conclusion: z.literal("skipped"),
    finishedAt: TimestampSchema,
  }).strict(),
  JobBaseSchema.extend({
    status: z.literal("completed"),
    conclusion: z.literal("cancelled"),
    finishedAt: TimestampSchema,
    canceledBy: IdSchema,
    cancelReason: z.string().min(1),
  }).strict(),
  EvidencedJobBaseSchema.extend({
    status: z.literal("completed"),
    conclusion: z.literal("cancelled"),
    finishedAt: TimestampSchema,
    canceledBy: IdSchema,
    cancelReason: z.string().min(1),
  }).strict(),
])
const LegacyJobSchema = z.union([
  JobBaseSchema.extend({ status: z.literal("requested") })
    .strict()
    .transform((job) => ({ ...job, status: "queued" as const })),
  ExecutingJobBaseSchema.extend({ status: z.literal("running"), leaseExpiresAt: TimestampSchema })
    .strict()
    .transform((job) => ({ ...job, status: "in_progress" as const })),
  EvidencedJobBaseSchema.extend({
    status: z.literal("passed"),
    finishedAt: TimestampSchema,
    output: JsonSchema,
  })
    .strict()
    .transform((job) => ({ ...job, status: "completed" as const, conclusion: "success" as const })),
  EvidencedJobBaseSchema.extend({
    status: z.literal("failed"),
    finishedAt: TimestampSchema,
    error: JobErrorSchema,
    output: JsonSchema.optional(),
  })
    .strict()
    .transform((job) => ({ ...job, status: "completed" as const, conclusion: "failure" as const })),
  ExecutingJobBaseSchema.extend({
    status: z.literal("lost"),
    finishedAt: TimestampSchema,
    lostReason: z.string().min(1),
  })
    .strict()
    .transform((job) => ({ ...job, status: "completed" as const, conclusion: "timed_out" as const })),
  JobBaseSchema.extend({
    status: z.literal("canceled"),
    finishedAt: TimestampSchema,
    canceledBy: IdSchema,
    cancelReason: z.string().min(1),
  })
    .strict()
    .transform((job) => ({ ...job, status: "completed" as const, conclusion: "cancelled" as const })),
  EvidencedJobBaseSchema.extend({
    status: z.literal("canceled"),
    finishedAt: TimestampSchema,
    canceledBy: IdSchema,
    cancelReason: z.string().min(1),
  })
    .strict()
    .transform((job) => ({ ...job, status: "completed" as const, conclusion: "cancelled" as const })),
])
const ReplayJobSchema = z.union([JobSchema, LegacyJobSchema])

type JobBase = Readonly<z.infer<typeof JobBaseSchema>>

type JobExecution = Readonly<{
  startedAt: string
  runner: string
  context?: string
}>

type JobEvidence = Readonly<{
  token?: string
  url?: string
  detail?: string
  artifacts?: readonly JsonValue[]
  checkpoint?: JsonValue
}>

type JobCancellation = Readonly<{
  status: "completed"
  conclusion: "cancelled"
  finishedAt: string
  canceledBy: string
  cancelReason: string
}>

export type Job =
  | (JobBase & { status: "queued" })
  | (JobBase & JobExecution & { status: "in_progress"; leaseExpiresAt: string })
  | (JobBase & JobExecution & JobEvidence & { status: "waiting"; token: string })
  | (JobBase &
      JobExecution &
      JobEvidence & { status: "completed"; conclusion: "success"; finishedAt: string; output: JsonValue })
  | (JobBase &
      JobExecution &
      JobEvidence & {
        status: "completed"
        conclusion: "failure"
        finishedAt: string
        error: JobError
        output?: JsonValue
      })
  | (JobBase & JobExecution & { status: "completed"; conclusion: "timed_out"; finishedAt: string; lostReason: string })
  | (JobBase & { status: "completed"; conclusion: "skipped"; finishedAt: string })
  | (JobBase & JobCancellation)
  | (JobBase & JobExecution & JobEvidence & JobCancellation)

function jobResultAttributes(definition: JobDef, result: Job, observed?: JobResult): Readonly<Record<string, unknown>> {
  const projected = observed === undefined ? undefined : definition.observeResult?.(observed)
  return {
    ...projected,
    status: result.status,
    // Surface the failed Job's canonical error code so a human row can render
    // `err=<slug>` — the failing step owns the single ERROR record. Definition
    // projections cannot replace this durable status/error truth.
    ...(result.status === "completed" ? { conclusion: result.conclusion } : {}),
    ...(result.status === "completed" && result.conclusion === "failure" ? { error: result.error } : {}),
  }
}

export type JobsState = Readonly<{
  byId: Readonly<Record<string, Job>>
  byKey: Readonly<Record<string, string>>
  retention: Readonly<{
    next: number
    standaloneTerminalOrder: Readonly<Record<string, number>>
    queueRoots: Readonly<Record<string, string>>
    queueTerminalOrder: Readonly<Record<string, number>>
    legacyQueueRoots: Readonly<Record<string, true>>
    detachedQueueJobs: Readonly<Record<string, true>>
  }>
}>

const TERMINAL_QUEUE_RUN_WINDOW = 512
const TERMINAL_STANDALONE_JOB_WINDOW = 512
const QUEUE_JOB_KEY = /^queue:(.+):\d+$/u

function emptyJobsState(): JobsState {
  return {
    byId: {},
    byKey: {},
    retention: {
      next: 1,
      standaloneTerminalOrder: {},
      queueRoots: {},
      queueTerminalOrder: {},
      legacyQueueRoots: {},
      detachedQueueJobs: {},
    },
  }
}

function queueJobRun(key: string | undefined): string | undefined {
  return key === undefined ? undefined : QUEUE_JOB_KEY.exec(key)?.[1]
}

function rememberQueueRoot(
  retention: DeepReadonly<JobsState["retention"]>,
  run: string,
  root = run,
): JobsState["retention"] {
  if (retention.queueRoots[run] === root) return retention as JobsState["retention"]
  return { ...retention, queueRoots: { ...retention.queueRoots, [run]: root } }
}

function markStandaloneTerminal(retention: DeepReadonly<JobsState["retention"]>, job: string): JobsState["retention"] {
  if (retention.standaloneTerminalOrder[job] !== undefined) return retention as JobsState["retention"]
  return {
    ...retention,
    next: retention.next + 1,
    standaloneTerminalOrder: { ...retention.standaloneTerminalOrder, [job]: retention.next },
  }
}

function markQueueTerminal(retention: DeepReadonly<JobsState["retention"]>, root: string): JobsState["retention"] {
  if (retention.queueTerminalOrder[root] !== undefined) return retention as JobsState["retention"]
  return {
    ...retention,
    next: retention.next + 1,
    queueTerminalOrder: { ...retention.queueTerminalOrder, [root]: retention.next },
  }
}

function rememberLegacyQueueRoot(
  retention: DeepReadonly<JobsState["retention"]>,
  root: string,
): JobsState["retention"] {
  if (retention.legacyQueueRoots[root] === true) return retention as JobsState["retention"]
  return {
    ...retention,
    legacyQueueRoots: { ...retention.legacyQueueRoots, [root]: true },
  }
}

function touchLegacyQueueRoot(retention: DeepReadonly<JobsState["retention"]>, root: string): JobsState["retention"] {
  if (retention.legacyQueueRoots[root] !== true) return retention as JobsState["retention"]
  return {
    ...retention,
    next: retention.next + 1,
    queueTerminalOrder: { ...retention.queueTerminalOrder, [root]: retention.next },
  }
}

function markLegacyQueueTerminal(
  retention: DeepReadonly<JobsState["retention"]>,
  jobs: Readonly<Record<string, DeepReadonly<Job>>>,
  root: string,
): JobsState["retention"] {
  if (retention.legacyQueueRoots[root] !== true) return retention as JobsState["retention"]
  const members = Object.values(jobs).filter((job) => {
    const run = queueJobRun(job.key)
    return run !== undefined && (retention.queueRoots[run] ?? run) === root
  })
  return members.length > 0 && members.every(Job.terminal)
    ? touchLegacyQueueRoot(retention, root)
    : (retention as JobsState["retention"])
}

function terminalizeUnstartedLegacyQueueFailure(state: DeepReadonly<JobsState>, run: string, at: string): JobsState {
  const root = state.retention.queueRoots[run] ?? run
  if (state.retention.legacyQueueRoots[root] !== true) return state as JobsState

  let byId: Record<string, Job> | undefined
  for (const [id, job] of Object.entries(state.byId)) {
    if (queueJobRun(job.key) !== run || job.status !== "queued") continue
    byId ??= { ...state.byId } as Record<string, Job>
    // Old Queue writers could journal the terminal failure without the matching
    // Job cancellation. Derive that missing terminal projection from immutable
    // failure authority; a started Job is deliberately never touched here.
    byId[id] = Job.apply(
      job,
      {
        type: "cancel",
        id,
        attempt: job.attempt,
        by: "yrd/queue",
        reason: `Legacy Queue run '${run}' failed before the Job started`,
      },
      at,
    )
  }
  if (byId === undefined) return state as JobsState

  return {
    ...state,
    byId,
    retention: markLegacyQueueTerminal(state.retention, byId, root),
  }
}

function projectQueueFailure(state: DeepReadonly<JobsState>, applied: Event): JobsState {
  const failed = applied.data as Readonly<{ run?: unknown; error?: Readonly<{ code?: unknown }> }>
  if (typeof failed.run !== "string") return state as JobsState

  const projected = terminalizeUnstartedLegacyQueueFailure(state, failed.run, applied.ts)
  const root = projected.retention.queueRoots[failed.run] ?? failed.run
  // Migration can meet a Queue root whose old terminal Jobs already aged out.
  // Its explicit quiesce failure is fresh terminal authority, so mint the
  // jobs-side order before Queue and Job projections co-compact.
  const retention =
    failed.error?.code === "legacy-quiesced"
      ? markQueueTerminal(rememberQueueRoot(projected.retention, failed.run, root), root)
      : markLegacyQueueTerminal(projected.retention, projected.byId, root)
  return retention === projected.retention ? projected : { ...projected, retention }
}

function reopenRetention(
  retention: DeepReadonly<JobsState["retention"]>,
  job: DeepReadonly<Job>,
  restoredAs?: "detached-queue",
): JobsState["retention"] {
  const detached = restoredAs === "detached-queue" || retention.detachedQueueJobs[job.id] === true
  if (detached) {
    const standaloneTerminalOrder = { ...retention.standaloneTerminalOrder }
    delete standaloneTerminalOrder[job.id]
    return {
      ...retention,
      standaloneTerminalOrder,
      detachedQueueJobs: { ...retention.detachedQueueJobs, [job.id]: true },
    }
  }
  const run = queueJobRun(job.key)
  if (run !== undefined) {
    const root = retention.queueRoots[run] ?? run
    if (retention.queueTerminalOrder[root] === undefined) return rememberQueueRoot(retention, run, root)
    const queueTerminalOrder = { ...retention.queueTerminalOrder }
    delete queueTerminalOrder[root]
    return { ...rememberQueueRoot(retention, run, root), queueTerminalOrder }
  }
  if (retention.standaloneTerminalOrder[job.id] === undefined) return retention as JobsState["retention"]
  const standaloneTerminalOrder = { ...retention.standaloneTerminalOrder }
  delete standaloneTerminalOrder[job.id]
  return { ...retention, standaloneTerminalOrder }
}

/** @internal Pure live-projection compactor; immutable Journal history remains authoritative. */
export function compactJobsState(state: DeepReadonly<JobsState>): JobsState {
  if (
    Object.keys(state.retention.standaloneTerminalOrder).length <= TERMINAL_STANDALONE_JOB_WINDOW &&
    Object.keys(state.retention.queueTerminalOrder).length <= TERMINAL_QUEUE_RUN_WINDOW
  ) {
    return state as JobsState
  }
  const standalone: Job[] = []
  const queueGroups = new Map<string, Job[]>()
  for (const job of Object.values(state.byId)) {
    const run = job.key === undefined ? undefined : QUEUE_JOB_KEY.exec(job.key)?.[1]
    if (run === undefined || state.retention.detachedQueueJobs[job.id] === true) standalone.push(job as Job)
    else {
      const root = state.retention.queueRoots[run] ?? run
      queueGroups.set(root, [...(queueGroups.get(root) ?? []), job as Job])
    }
  }

  const keep = new Set<string>()
  const standaloneTerminal: Array<Readonly<{ job: Job; order: number }>> = []
  for (const job of standalone) {
    const order = state.retention.standaloneTerminalOrder[job.id]
    if (!Job.terminal(job) || order === undefined) keep.add(job.id)
    else standaloneTerminal.push({ job, order })
  }
  standaloneTerminal
    .toSorted((left, right) => right.order - left.order || right.job.id.localeCompare(left.job.id))
    .slice(0, TERMINAL_STANDALONE_JOB_WINDOW)
    .forEach(({ job }) => keep.add(job.id))

  const terminalGroups: Array<Readonly<{ root: string; jobs: readonly Job[]; order: number }>> = []
  const roots = new Set([...queueGroups.keys(), ...Object.keys(state.retention.queueTerminalOrder)])
  for (const root of roots) {
    const jobs = queueGroups.get(root) ?? []
    const order = state.retention.queueTerminalOrder[root]
    if (!jobs.every(Job.terminal) || order === undefined) {
      for (const job of jobs) keep.add(job.id)
      continue
    }
    terminalGroups.push({ root, jobs, order })
  }
  const retainedTerminalRoots = new Set(
    terminalGroups
      .toSorted((left, right) => right.order - left.order || right.root.localeCompare(left.root))
      .slice(0, TERMINAL_QUEUE_RUN_WINDOW)
      .map(({ root }) => root),
  )
  terminalGroups
    .filter(({ root }) => retainedTerminalRoots.has(root))
    .slice(0, TERMINAL_QUEUE_RUN_WINDOW)
    .forEach(({ jobs }) => jobs.forEach((job) => keep.add(job.id)))

  const byId = Object.fromEntries(Object.entries(state.byId).filter(([id]) => keep.has(id))) as Record<string, Job>
  const byKey = Object.fromEntries(Object.entries(state.byKey).filter(([, id]) => keep.has(id)))
  const standaloneTerminalOrder = Object.fromEntries(
    Object.entries(state.retention.standaloneTerminalOrder).filter(([id]) => keep.has(id)),
  )
  const queueTerminalOrder = Object.fromEntries(
    Object.entries(state.retention.queueTerminalOrder).filter(([root]) => retainedTerminalRoots.has(root)),
  )
  const queueRoots = Object.fromEntries(
    Object.entries(state.retention.queueRoots).filter(([, root]) => {
      const order = state.retention.queueTerminalOrder[root]
      return order === undefined || retainedTerminalRoots.has(root)
    }),
  )
  const legacyQueueRoots = Object.fromEntries(
    Object.entries(state.retention.legacyQueueRoots).filter(([root]) => {
      const order = state.retention.queueTerminalOrder[root]
      return order === undefined || retainedTerminalRoots.has(root)
    }),
  ) as Record<string, true>
  const detachedQueueJobs = Object.fromEntries(
    Object.entries(state.retention.detachedQueueJobs).filter(([id]) => keep.has(id)),
  ) as Record<string, true>
  return {
    byId,
    byKey,
    retention: {
      ...state.retention,
      standaloneTerminalOrder,
      queueRoots,
      queueTerminalOrder,
      legacyQueueRoots,
      detachedQueueJobs,
    },
  }
}

const RestoreJobSchema = z.object({ job: JobSchema, retention: z.literal("detached-queue").optional() }).strict()
const ReplayRestoreJobSchema = z
  .object({ job: ReplayJobSchema, retention: z.literal("detached-queue").optional() })
  .strict()
type RestoreJob = Readonly<z.infer<typeof RestoreJobSchema>>

const TerminalResultSchema = jobTerminalResultSchema(JsonSchema)
const LegacyTerminalResultSchema = z.union([
  z
    .object({ status: z.literal("passed"), output: JsonSchema })
    .strict()
    .transform((result) => ({
      ...result,
      status: "completed" as const,
      conclusion: "success" as const,
    })),
  z
    .object({ status: z.literal("failed"), error: JobErrorSchema, output: JsonSchema.optional() })
    .strict()
    .transform((result) => ({
      ...result,
      status: "completed" as const,
      conclusion: "failure" as const,
    })),
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

const FinishJobTransitionBaseSchema = z
  .object({
    type: z.literal("finish"),
    id: IdSchema,
    attempt: AttemptSchema,
    runner: IdSchema,
    token: IdSchema.optional(),
  })
  .strict()

export const JobTransitionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("start"),
      id: IdSchema,
      attempt: AttemptSchema,
      runner: IdSchema,
      context: IdSchema.optional(),
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
  FinishJobTransitionBaseSchema.extend({ result: TerminalResultSchema }).strict(),
  z
    .object({
      type: z.literal("lose"),
      id: IdSchema,
      attempt: AttemptSchema,
      runner: IdSchema,
      // An in_progress job is fenced by its lease, a waiting job by its token:
      // exactly one is present, and `apply` requires the one that matches the
      // status it meets. Both are optional here so a single transition can end
      // either hold; history written before waiting jobs were reclaimable
      // carries `leaseExpiresAt` and replays unchanged.
      leaseExpiresAt: TimestampSchema.optional(),
      token: IdSchema.optional(),
      reason: z.string().min(1),
    })
    .strict(),
  CancelJobInputSchema.extend({ type: z.literal("cancel") }).strict(),
  z.object({ type: z.literal("retry"), id: IdSchema }).strict(),
])
const ReplayJobTransitionSchema = z.union([
  JobTransitionSchema,
  FinishJobTransitionBaseSchema.extend({ result: LegacyTerminalResultSchema }).strict(),
])
export type JobTransition = z.infer<typeof JobTransitionSchema>

export function parseJobTransitionForReplay(value: unknown): JobTransition {
  const parsed = ReplayJobTransitionSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const encoded = JSON.stringify(value)
  throw new Error(`yrd: unsupported Job transition in immutable history: ${encoded ?? String(value)}`, {
    cause: parsed.error,
  })
}

export const Job = Object.freeze({
  requested(id: string, at: string, request: JobRequest): Job {
    return {
      id,
      definition: request.definition,
      revision: request.revision,
      input: request.input,
      ...(request.key === undefined ? {} : { key: request.key }),
      status: "queued",
      attempt: 0,
      requestedAt: at,
      changedAt: at,
    }
  },

  apply(current: Job | undefined, change: JobTransition, at: string): Job {
    if (current === undefined) throw new Error(`yrd: no job '${change.id}'`)

    switch (change.type) {
      case "start":
        requireStatus(current, "queued", "queued")
        if (change.attempt !== current.attempt + 1) {
          throw new Error(`yrd: job '${current.id}' started attempt ${change.attempt} after attempt ${current.attempt}`)
        }
        return {
          ...jobBase(current),
          status: "in_progress",
          attempt: change.attempt,
          changedAt: at,
          startedAt: at,
          runner: change.runner,
          ...(change.context === undefined ? {} : { context: change.context }),
          leaseExpiresAt: change.leaseExpiresAt,
        }

      case "heartbeat":
        requireOwner(current, change)
        requireStatus(current, "in_progress", "in_progress")
        return { ...current, changedAt: at, leaseExpiresAt: change.leaseExpiresAt }

      case "wait":
        requireOwner(current, change)
        requireStatus(current, "in_progress", "in_progress")
        return {
          ...execution(current),
          ...evidence(change),
          status: "waiting",
          changedAt: at,
          token: change.token,
        }

      case "finish": {
        requireOwner(current, change)
        requireStatus(current, "in_progress or waiting", "in_progress", "waiting")
        if (current.status === "waiting" && change.token !== current.token) {
          throw new Error(`yrd: job '${current.id}' token mismatch`)
        }
        const finished = {
          ...execution(current),
          ...(current.status === "waiting" ? evidence(current) : {}),
          changedAt: at,
          finishedAt: at,
        }
        return change.result.conclusion === "success"
          ? { ...finished, status: "completed", conclusion: "success", output: change.result.output }
          : {
              ...finished,
              status: "completed",
              conclusion: "failure",
              error: change.result.error,
              ...(change.result.output === undefined ? {} : { output: change.result.output }),
            }
      }

      case "lose":
        requireOwner(current, change)
        requireStatus(current, "in_progress or waiting", "in_progress", "waiting")
        if (current.status === "in_progress" && current.leaseExpiresAt !== change.leaseExpiresAt) {
          throw new Error(`yrd: job '${current.id}' lease changed before recovery`)
        }
        // A waiting job holds no lease, so the token is its fence: recovery must
        // name the exact wait it is ending, or a callback that arrived first
        // could be overwritten by a stale reclaim.
        if (current.status === "waiting" && current.token !== change.token) {
          throw new Error(`yrd: job '${current.id}' token mismatch`)
        }
        return {
          ...execution(current),
          status: "completed",
          conclusion: "timed_out",
          changedAt: at,
          finishedAt: at,
          lostReason: change.reason,
        }

      case "cancel":
        requireAttempt(current, change)
        requireStatus(current, "queued, in_progress or waiting", "queued", "in_progress", "waiting")
        return {
          ...(current.status === "queued" ? jobBase(current) : execution(current)),
          ...(current.status === "waiting" ? evidence(current) : {}),
          status: "completed",
          conclusion: "cancelled",
          changedAt: at,
          finishedAt: at,
          canceledBy: change.by,
          cancelReason: change.reason,
        }

      case "retry":
        requireConclusion(current, "timed_out or failure", "timed_out", "failure")
        return { ...jobBase(current), status: "queued", changedAt: at }
    }
  },

  owns(job: Job, attempt: number, runner: string, status: Job["status"]): boolean {
    return job.status === status && job.attempt === attempt && "runner" in job && job.runner === runner
  },

  terminal(job: DeepReadonly<Job>): boolean {
    return isTerminalJobStatus(job.status)
  },
})

const TERMINAL_JOB_STATUSES: ReadonlySet<Job["status"]> = new Set<Job["status"]>(["completed"])

/** A Job status is terminal once it is completed; conclusion records how it ended. */
export function isTerminalJobStatus(status: Job["status"]): boolean {
  return TERMINAL_JOB_STATUSES.has(status)
}

/**
 * A transition guard rejected a Job change because the Job's current status did
 * not permit it. Always thrown, never returned, so an invalid single-writer
 * transition still fails loud. The carried `actual`/`expected` let a habitant,
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
 * terminal status — i.e. a concurrent writer completed the Job between a
 * runtime's snapshot and its action. This is a normal,
 * losable race for a long-lived habitant runner: skip and continue. A conflict
 * against a still-live status (queued/in_progress/waiting) is NOT losable — it
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
  context?: RuntimeContext
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
  retentionDiagnostics(): Readonly<{
    retainedJobs: number
    liveJobs: number
    standaloneTerminalJobs: number
    queueJobs: number
    terminalQueueRoots: number
  }>
  get(id: string): DeepReadonly<Job> | undefined
  getByKey(key: string): DeepReadonly<Job> | undefined
  run(id: string, options: RunJobOptions): Promise<Job>
  runMany(ids: readonly string[], options: RunManyJobOptions): Promise<readonly Job[]>
  finish(id: string, completion: JobCompletion): Promise<Job>
  cancel(input: CancelJobInput): Promise<Job>
  retry(id: string): Promise<Job>
  recover(
    options: Readonly<{ now: string; reason?: string; runner?: string; waitBoundMs?: number }>,
  ): Promise<readonly string[]>
  requested(source: CommandResult | readonly Event[]): readonly string[]
}>

type JobScope = Scope

export type CreateJobsOptions = Readonly<{
  definitions: JobDefs
  state: ReadSignal<DeepReadonly<JobsState>>
  transition(change: JobTransition): Promise<CommandResult>
  restore(job: Job, retention?: "detached-queue"): Promise<CommandResult>
  history?: JournalHistory<unknown>
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

/**
 * How long a job may sit `waiting` on an external callback before recovery
 * ends the wait as a typed failure.
 *
 * A waiting job has no lease to expire, so before this bound existed nothing
 * could ever end one: `recover` walked only `in_progress` jobs and the queue's
 * jobless-run reaper skips a step that HAS a job. A wait whose callback never
 * came was therefore a permanent park, holding its run and the base behind it.
 *
 * The bound exists to end that park, NOT to race a legitimate check. The
 * longest observed real wait — a parked check that leaked a core for 63
 * minutes — sets the floor; a day is far outside it while still ending the
 * park inside the operator's next session. Callers that know their checks
 * (queue recovery, tests) pass `waitBoundMs` instead.
 */
const DEFAULT_JOB_WAIT_BOUND_MS = 24 * 60 * 60_000

const RecoverOptionsSchema = z
  .object({
    now: TimestampSchema,
    reason: z.string().min(1).optional(),
    runner: IdSchema.optional(),
    waitBoundMs: z.number().int().positive().optional(),
  })
  .strict()

export function createJobs(options: CreateJobsOptions): Jobs {
  const definitions = new Map(Object.entries(options.definitions))
  const state = options.state
  const commit = options.transition
  const activeScopes = new Map<string, Readonly<{ attempt: number; scope: JobScope }>>()

  const archivedJobId = (key: string, entries: readonly Readonly<{ value: unknown }>[]): string => {
    let jobId: string | undefined
    const bind = (candidate: string): void => {
      if (jobId !== undefined && jobId !== candidate) {
        throw new Error(`yrd: archived job key '${key}' resolves to multiple Jobs`)
      }
      jobId = candidate
    }
    for (const entry of entries) {
      const frame = parseJournalFrame(entry.value)
      for (const applied of frame.events) {
        if (applied.name === "job/requested") {
          const request = JobRequestSchema.parse(applied.data)
          if (request.key === key) bind(applied.id)
        } else if (applied.name === "job/restored") {
          const restored = ReplayRestoreJobSchema.parse(applied.data)
          if (restored.job.key === key) bind(restored.job.id)
        }
      }
    }
    if (jobId === undefined) throw new Error(`yrd: journal job-key index names '${key}' without a matching Job`)
    return jobId
  }

  const archived = (kind: "job" | "job-key", id: string): Job | undefined => {
    const seed = options.history?.entity(kind, id)
    if (seed === undefined || seed.length === 0) return undefined
    const jobId = kind === "job" ? id : archivedJobId(id, seed)
    const entries = kind === "job" ? seed : (options.history?.entity("job", jobId) ?? [])
    if (entries.length === 0) throw new Error(`yrd: archived Job '${jobId}' has no immutable event slice`)
    let projection: { jobs: JobsState } = { jobs: emptyJobsState() }
    for (const entry of entries) {
      const frame = parseJournalFrame(entry.value)
      for (const applied of frame.events) projection = projectJobs(projection, applied)
    }
    const job = projection.jobs.byId[jobId]
    if (job === undefined) {
      throw new Error(`yrd: archived Job '${jobId}' did not project from its immutable event slice`)
    }
    return job
  }

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
    const executionContext = runOptions.context
    const contextId = executionContext === undefined ? undefined : IdSchema.parse(executionContext.id)
    const heartbeatMs = parsed.heartbeatMs ?? Math.max(1, Math.floor(parsed.leaseMs / 3))
    const requested = current(id)
    requireStatus(requested, "queued", "queued")
    const installed = definitionFor(requested)
    const attempt = requested.attempt + 1
    const now = runOptions.now ?? systemClock.now
    const observation = installed.observe?.(requested.input) ?? {}
    let observedResult: JobResult | undefined
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
          result.status === "completed" && result.conclusion === "success"
            ? "succeeded"
            : result.status === "in_progress" || result.status === "waiting" || result.status === "queued"
              ? "progress"
              : "failed",
        // A failure this job's own definition marked required is a gating
        // verdict against the revision under test — the change dies, not the
        // process — and stays loud at ERROR; everything else (undeclared or
        // explicitly optional/advisory) settles at the abnormal-recoverable
        // WARN rather than the prior silent INFO.
        failureLevel: () => (observation.required === true ? "error" : "warn"),
        resultAttributes: (result) => jobResultAttributes(installed, result, observedResult),
      },
      async () => {
        await commit({
          type: "start",
          id,
          attempt,
          runner: parsed.runner,
          ...(contextId === undefined ? {} : { context: contextId }),
          leaseExpiresAt: lease(now, parsed.leaseMs),
        })
        const started = current(id)
        if (!Job.owns(started, attempt, parsed.runner, "in_progress")) return started
        if (!("startedAt" in started)) throw new Error(`yrd: started job '${id}' has no durable start timestamp`)

        const scope = options.scope.child(`job:${id}:${attempt}`)
        activeScopes.set(id, { attempt, scope })
        let outcome: Awaited<ReturnType<typeof executeWithHeartbeat>>
        try {
          outcome = await executeWithHeartbeat(
            scope,
            (execution) =>
              installed.execute(requested.input, {
                id,
                attempt,
                runner: parsed.runner,
                startedAt: started.startedAt,
                signal: execution.signal,
                ...(executionContext === undefined ? {} : { context: executionContext }),
              }),
            heartbeatMs,
            async () => {
              const active = current(id)
              if (active.status !== "in_progress" || !Job.owns(active, attempt, parsed.runner, "in_progress")) {
                throw new Error(`yrd: job '${id}' lost execution ownership`)
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
        if (!Job.owns(active, attempt, parsed.runner, "in_progress")) return active
        const result =
          outcome.heartbeatError === undefined
            ? outcome.result
            : verdictlessFailure("heartbeat-failed", outcome.heartbeatError)
        await commit(settlement(id, attempt, parsed.runner, result))
        observedResult = result
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

    retentionDiagnostics() {
      const snapshot = state()
      const values = Object.values(snapshot.byId)
      const standalone = (job: DeepReadonly<Job>) =>
        queueJobRun(job.key) === undefined || snapshot.retention.detachedQueueJobs[job.id] === true
      return {
        retainedJobs: values.length,
        liveJobs: values.filter((job) => !Job.terminal(job)).length,
        standaloneTerminalJobs: values.filter((job) => standalone(job) && Job.terminal(job)).length,
        queueJobs: values.filter((job) => !standalone(job)).length,
        terminalQueueRoots: Object.keys(snapshot.retention.queueTerminalOrder).length,
      }
    },

    get(id) {
      return state().byId[id] ?? archived("job", id)
    },

    getByKey(key) {
      const id = state().byKey[key]
      return id === undefined ? archived("job-key", key) : state().byId[id]
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
        ...(runManyOptions.context === undefined ? {} : { context: runManyOptions.context }),
      }
      const results: Job[] = []
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < ids.length) {
          const index = next++
          const id = ids[index]
          if (id === undefined) break
          const job = current(id)
          results[index] = job.status === "queued" ? await run(id, runOptions) : job
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
      // The installed definition's output contract remains compatible across
      // revisions, but its input projection may not. A pinned waiting job must
      // not be stranded because a newer revision reinterprets old input.
      const observation = installedDef.revision === job.revision ? (installedDef.observe?.(job.input) ?? {}) : {}
      return observeYrdLifecycle(
        options.log,
        {
          lifecycle: observation.lifecycle ?? "run",
          identity: { ...observation.identity, job: id, attempt: metadata.attempt, runner: metadata.runner },
          attributes: {
            ...observation.attributes,
            definition: job.definition,
            revision: job.revision,
            completion: true,
          },
          outcome: (finished) =>
            finished.status === "completed" && finished.conclusion === "success" ? "succeeded" : "failed",
          // Same required/advisory split as the in-process `run` completion
          // above — a required job's failure is a content verdict against the
          // revision (ERROR), everything else is abnormal-recoverable (WARN),
          // and success is untouched at INFO.
          failureLevel: () => (observation.required === true ? "error" : "warn"),
          resultAttributes: (finished) => jobResultAttributes(installedDef, finished, result),
        },
        async () => {
          await commit({ type: "finish", id, ...metadata, result })
          return current(id)
        },
      )
    },

    async cancel(input) {
      const parsed = CancelJobInputSchema.parse(input)
      await commit({ type: "cancel", ...parsed })
      const active = activeScopes.get(parsed.id)
      if (active?.attempt === parsed.attempt) await active.scope[Symbol.asyncDispose]()
      return current(parsed.id)
    },

    async retry(id) {
      const live = state().byId[id]
      if (live === undefined) {
        const historical = archived("job", id)
        if (historical === undefined) throw new Error(`yrd: no job '${id}'`)
        requireConclusion(historical, "timed_out or failure", "timed_out", "failure")
        await options.restore(historical, queueJobRun(historical.key) === undefined ? undefined : "detached-queue")
        return current(id)
      }
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
      const waitBoundMs = parsed.waitBoundMs ?? DEFAULT_JOB_WAIT_BOUND_MS
      const recovered: string[] = []
      for (const job of Object.values(state().byId)) {
        if (job.status !== "in_progress" && job.status !== "waiting") continue
        const named = deadRunner !== undefined && job.runner === deadRunner
        // A waiting job holds no lease. Its two ways out are the same dead-runner
        // evidence the in_progress arm uses, and the wait bound — without both it
        // parks forever, which the no-parking ruling forbids.
        const expired =
          job.status === "in_progress"
            ? Date.parse(job.leaseExpiresAt) <= cutoff
            : Date.parse(job.changedAt) + waitBoundMs <= cutoff
        if (!named && !expired) continue
        const reason =
          job.status === "waiting"
            ? waitEndedReason(job, named ? (parsed.reason ?? "runner disappeared") : undefined, waitBoundMs)
            : named || deadRunner === undefined
              ? (parsed.reason ?? (named ? "runner disappeared" : "runner lease expired"))
              : "runner lease expired"
        const fence = job.status === "in_progress" ? { leaseExpiresAt: job.leaseExpiresAt } : { token: job.token }
        try {
          await observeYrdLifecycle(
            options.log,
            {
              lifecycle: "recover",
              identity: { job: job.id, attempt: job.attempt, runner: job.runner },
              attributes: {
                ...fence,
                waitingSince: job.status === "waiting" ? job.changedAt : undefined,
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
                ...fence,
                reason,
              }),
          )
        } catch (error) {
          const latest = current(job.id)
          if (!sameHold(latest, job)) continue
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
    restore: CommandHandler<RestoreJob, { jobs: JobsState }>
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
  const restore = command({
    title: "Restore archived job for retry",
    params: RestoreJobSchema,
    apply(state: DeepReadonly<{ jobs: JobsState }>, args: RestoreJob) {
      if (state.jobs.byId[args.job.id] !== undefined) return { events: [] }
      if (args.job.key !== undefined && state.jobs.byKey[args.job.key] !== undefined) {
        throw new Error(`yrd: job key '${args.job.key}' is already in use`)
      }
      requireConclusion(args.job, "timed_out or failure", "timed_out", "failure")
      return { events: [event("job/restored", args)] }
    },
  })

  return <State extends object, Commands extends CommandTree, Features extends object>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { jobs: emptyJobsState() },
      commands: { job: { transition, restore } },
      events: {
        "job/requested": journalEvent(1, JobRequestSchema),
        "job/transitioned": journalEvent(1, JobTransitionSchema),
        "job/restored": journalEvent(1, RestoreJobSchema),
      },
      replayEvents: {
        "job/transitioned": ReplayJobTransitionSchema,
        "job/restored": ReplayRestoreJobSchema,
      },
      projectionVersion: "jobs-v8-target-model-retention",
      project: projectJobs,
      compact: (state) => ({ jobs: compactJobsState(state.jobs) }),
      create(yrd) {
        return {
          jobs: createJobs({
            definitions,
            state: computed(() => yrd.state().jobs),
            transition: (change) => yrd.dispatch(transition, change),
            restore: (job, retention) =>
              yrd.dispatch(restore, {
                job: JobSchema.parse(job),
                ...(retention === undefined ? {} : { retention }),
              }),
            ...(yrd.history === undefined ? {} : { history: yrd.history }),
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
  if (applied.name === "queue/batch/isolated") {
    const data = applied.data as Readonly<{ parent?: unknown; run?: unknown }>
    if (typeof data.parent !== "string" || typeof data.run !== "string") return state as { jobs: JobsState }
    const root = state.jobs.retention.queueRoots[data.parent] ?? data.parent
    return {
      jobs: { ...state.jobs, retention: rememberQueueRoot(state.jobs.retention, data.run, root) },
    }
  }
  if (applied.name === "queue/run/started") {
    const run = (applied.data as Readonly<{ run?: unknown }>).run
    if (typeof run !== "object" || run === null) return state as { jobs: JobsState }
    const record = run as Readonly<{ id?: unknown; parent?: unknown; settlement?: unknown; steps?: unknown }>
    if (typeof record.id !== "string" || record.settlement === "explicit") return state as { jobs: JobsState }
    const parent = typeof record.parent === "string" ? record.parent : undefined
    const root = parent === undefined ? record.id : (state.jobs.retention.queueRoots[parent] ?? parent)
    const remembered = rememberQueueRoot(state.jobs.retention, record.id, root)
    const legacy = rememberLegacyQueueRoot(remembered, root)
    return {
      jobs: {
        ...state.jobs,
        retention:
          Array.isArray(record.steps) && record.steps.length === 0 ? touchLegacyQueueRoot(legacy, root) : legacy,
      },
    }
  }
  if (applied.name === "queue/run/settled" || applied.name === "queue/run/canceled") {
    const run = (applied.data as Readonly<{ run?: unknown }>).run
    if (typeof run !== "string") return state as { jobs: JobsState }
    const root = state.jobs.retention.queueRoots[run] ?? run
    if (applied.name === "queue/run/canceled" && root !== run) return state as { jobs: JobsState }
    const remembered = rememberQueueRoot(state.jobs.retention, run, root)
    return {
      jobs: {
        ...state.jobs,
        retention:
          remembered.legacyQueueRoots[root] === true
            ? touchLegacyQueueRoot(remembered, root)
            : markQueueTerminal(remembered, root),
      },
    }
  }
  if (applied.name === "queue/run/failed") {
    return { jobs: projectQueueFailure(state.jobs, applied) }
  }
  if (applied.name === "job/requested") {
    const request = applied.data as JobRequest
    if (state.jobs.byId[applied.id] !== undefined) throw new Error(`yrd: duplicate job '${applied.id}'`)
    if (request.key !== undefined && state.jobs.byKey[request.key] !== undefined) {
      throw new Error(`yrd: job key '${request.key}' is already in use`)
    }
    const requested = Job.requested(applied.id, applied.ts, request)
    const run = queueJobRun(request.key)
    const retention = run === undefined ? state.jobs.retention : rememberQueueRoot(state.jobs.retention, run)
    return {
      ...state,
      jobs: {
        byId: { ...state.jobs.byId, [applied.id]: requested },
        byKey: request.key === undefined ? state.jobs.byKey : { ...state.jobs.byKey, [request.key]: applied.id },
        retention,
      },
    }
  }
  if (applied.name === "job/restored") {
    const restoredFact = ReplayRestoreJobSchema.parse(applied.data)
    const archived = restoredFact.job
    const current = state.jobs.byId[archived.id]
    if (current !== undefined && JSON.stringify(JobSchema.parse(current)) !== JSON.stringify(archived)) {
      throw new Error(`yrd: restored job '${archived.id}' does not match projected journal history`)
    }
    const keyed = archived.key === undefined ? undefined : state.jobs.byKey[archived.key]
    if (keyed !== undefined && keyed !== archived.id) {
      throw new Error(`yrd: job key '${archived.key}' is already in use`)
    }
    const restored = Job.apply(current ?? archived, { type: "retry", id: archived.id }, applied.ts)
    return {
      jobs: {
        byId: { ...state.jobs.byId, [archived.id]: restored },
        byKey: archived.key === undefined ? state.jobs.byKey : { ...state.jobs.byKey, [archived.key]: archived.id },
        retention: reopenRetention(state.jobs.retention, archived, restoredFact.retention),
      },
    }
  }
  if (applied.name !== "job/transitioned") return state
  const change = parseJobTransitionForReplay(applied.data)
  const current = state.jobs.byId[change.id]
  const projected = Job.apply(current, change, applied.ts)
  const byId = { ...state.jobs.byId, [change.id]: projected }
  let retention = change.type === "retry" ? reopenRetention(state.jobs.retention, projected) : state.jobs.retention
  if (Job.terminal(projected) && (current === undefined || !Job.terminal(current))) {
    const run = queueJobRun(projected.key)
    if (run === undefined || retention.detachedQueueJobs[projected.id] === true) {
      retention = markStandaloneTerminal(retention, projected.id)
    } else {
      retention = rememberQueueRoot(retention, run)
      const root = retention.queueRoots[run] ?? run
      retention = markLegacyQueueTerminal(retention, byId, root)
    }
  }
  return {
    ...state,
    jobs: {
      ...state.jobs,
      byId,
      retention,
    },
  }
}

/**
 * The lease is a RUNNER-liveness signal, so the heartbeat renews it for as
 * long as this runner still owns a live execution. It deliberately does not
 * consult the child's output: a check that prints nothing for a lease interval
 * is quiet, not dead, and gating renewal on bytes printed put a productivity
 * signal where a liveness signal belongs (@yrd/core/21085-target-model/21094).
 * Judging a silent child is the process supervisor's job — it holds the child
 * handle and settles a stall as `<purpose>-stalled` (yrd-queue command.ts).
 */
async function executeWithHeartbeat(
  scope: JobScope,
  execute: (execution: Readonly<{ signal: AbortSignal }>) => Promise<JobResult>,
  heartbeatMs: number,
  heartbeat: () => Promise<void>,
): Promise<{ result: JobResult; heartbeatError?: unknown }> {
  let heartbeatError: unknown
  let heartbeats = Promise.resolve()
  let detachExecution = false
  const executionScope = scope.child("execute")
  const heartbeatFailure = Promise.withResolvers<void>()
  const cancelHeartbeat = scope.interval(() => {
    heartbeats = heartbeats.then(async () => {
      if (heartbeatError === undefined) {
        try {
          await heartbeat()
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
  const execution = execute({ signal: executionScope.signal })
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
        : verdictlessFailure("runner-error", settled.type === "error" ? settled.error : heartbeatError)
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

/** A Job-owned machinery failure that says nothing about the submitted content. */
function verdictlessFailure(code: string, error: unknown): JobResult<never> {
  return {
    status: "completed",
    conclusion: "failure",
    error: { code, message: error instanceof Error ? error.message : String(error), verdictless: true },
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
  return {
    ...jobBase(job),
    startedAt: job.startedAt,
    runner: job.runner,
    ...(job.context === undefined ? {} : { context: job.context }),
  }
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

function requireConclusion<Conclusion extends JobConclusion>(
  job: Job,
  expected: string,
  ...allowed: readonly Conclusion[]
): asserts job is Extract<Job, { status: "completed"; conclusion: Conclusion }> {
  if (job.status !== "completed" || !(allowed as readonly JobConclusion[]).includes(job.conclusion)) {
    const actual = job.status === "completed" ? `${job.status}+${job.conclusion}` : job.status
    throw new JobStateConflict(job.id, job.status, `${expected}; actual ${actual}`)
  }
}

/** True while the job still holds the exact lease (in_progress) or wait token
 * (waiting) recovery observed — i.e. a failed reclaim was NOT a losable race
 * against a writer that moved the job on, and must keep propagating. */
function sameHold(left: Job, right: Extract<Job, { status: "in_progress" | "waiting" }>): boolean {
  if (left.status !== right.status || left.attempt !== right.attempt) return false
  if (!("runner" in left) || left.runner !== right.runner) return false
  return right.status === "in_progress"
    ? left.status === "in_progress" && left.leaseExpiresAt === right.leaseExpiresAt
    : left.status === "waiting" && left.token === right.token
}

/**
 * Why a waiting job's wait ended, as reason - evidence - remedy in the one
 * string that becomes the `job-lost` refusal message downstream.
 *
 * `deadRunnerReason` is the caller's dead-runner assertion when it named this
 * job's runner; without it the wait ended on the bound alone. Either way the
 * text names the wait and its holder, so an operator reading the refusal knows
 * which external result never arrived and who was owed it.
 */
function waitEndedReason(
  job: Extract<Job, { status: "waiting" }>,
  deadRunnerReason: string | undefined,
  waitBoundMs: number,
): string {
  const held = `waiting on token '${job.token}' held by runner '${job.runner}' since ${job.changedAt}`
  return deadRunnerReason === undefined
    ? `job was ${held}, past the ${waitBoundMs}ms wait bound; the external result never arrived. Retry the job to run the step again, or raise the wait bound if this check legitimately runs longer.`
    : `${deadRunnerReason}; job was ${held}, and no callback can arrive for a dead holder. Retry the job to run the step again.`
}
