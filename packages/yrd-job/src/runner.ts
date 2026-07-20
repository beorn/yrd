import * as z from "zod"
import { isConcurrentSettlementConflict, Job, type Jobs } from "./jobs.ts"
import type { ContextReq, RuntimeContext } from "./job.ts"

const IdSchema = z.string().trim().min(1)
const ContextReqSchema = z
  .object({
    scope: z.enum(["job", "run", "session", "shared"]),
    candidate: z.enum(["none", "ro", "rw"]),
    capabilities: z.array(IdSchema).optional(),
  })
  .strict()

export type RunnerContextRequest = Readonly<{
  context: ContextReq
  candidateRef?: string
}>

export type RunnerContexts = Readonly<{
  maxInFlight: number
  withContext<Output>(
    request: RunnerContextRequest,
    runInContext: (context: RuntimeContext) => Promise<Output>,
  ): Promise<Output>
}>

export type RunnerSubmission = Readonly<{
  job: string
  context?: ContextReq
  candidateRef?: string
}>

export type Runner = Readonly<{
  maxInFlight: number
  submit(input: RunnerSubmission): Promise<Job>
  observe(job: string): ReturnType<Jobs["get"]>
  cancel(job: string, options: Readonly<{ by: string; reason: string }>): Promise<Job>
  recover(options: Readonly<{ now: string; reason?: string; runner?: string }>): Promise<readonly string[]>
}>

export type LocalRunnerOptions = Readonly<{
  id?: string
  jobs: Jobs
  leaseMs: number
  heartbeatMs?: number
  maxInFlight?: number
  contexts?: RunnerContexts
  now?: () => number
}>

const DEFAULT_CONTEXT: ContextReq = Object.freeze({ scope: "job", candidate: "none" })

function inlineContexts(id: string, maxInFlight: number): RunnerContexts {
  let sequence = 0
  return Object.freeze({
    maxInFlight,
    async withContext(request, runInContext) {
      sequence += 1
      return runInContext({
        id: `${id}:context:${sequence}`,
        request: request.context,
        ...(request.candidateRef === undefined ? {} : { candidateRef: request.candidateRef }),
      })
    },
  })
}

/** Local control-plane adapter over the durable Jobs machine. The Runner owns
 * admission and ephemeral Context materialization; Jobs retain leases,
 * recovery, waiting, retry, and terminal evidence. */
export function localRunner(options: LocalRunnerOptions): Runner {
  const id = IdSchema.parse(options.id ?? "local")
  const requestedMax = z
    .number()
    .int()
    .positive()
    .parse(options.maxInFlight ?? options.contexts?.maxInFlight ?? 1)
  const maxInFlight = Math.min(requestedMax, options.contexts?.maxInFlight ?? requestedMax)
  const contexts = options.contexts ?? inlineContexts(id, maxInFlight)
  const jobs = options.jobs
  const inFlight = new Map<string, Promise<Job>>()
  const waiters: Array<() => void> = []
  let active = 0

  const acquire = async (): Promise<void> => {
    if (active < maxInFlight) {
      active += 1
      return
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve)
    })
    active += 1
  }

  const release = (): void => {
    active -= 1
    waiters.shift()?.()
  }

  const submit = (input: RunnerSubmission): Promise<Job> => {
    const job = IdSchema.parse(input.job)
    const existing = inFlight.get(job)
    if (existing !== undefined) return existing
    const context = ContextReqSchema.parse(input.context ?? DEFAULT_CONTEXT) as ContextReq
    const candidateRef = input.candidateRef === undefined ? undefined : IdSchema.parse(input.candidateRef)
    const execution = (async () => {
      await acquire()
      try {
        const observed = jobs.get(job)
        if (observed === undefined) throw new Error(`yrd: no job '${job}'`)
        if (observed.status !== "queued") return observed as Job
        return await contexts.withContext(
          { context, ...(candidateRef === undefined ? {} : { candidateRef }) },
          async (runtimeContext) => {
            try {
              return await jobs.run(job, {
                runner: id,
                leaseMs: options.leaseMs,
                ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
                ...(options.now === undefined ? {} : { now: options.now }),
                context: runtimeContext,
              })
            } catch (cause) {
              if (!isConcurrentSettlementConflict(cause)) throw cause
              const settled = jobs.get(job)
              if (settled === undefined || !Job.terminal(settled as Job)) throw cause
              return settled as Job
            }
          },
        )
      } finally {
        release()
      }
    })()
    inFlight.set(job, execution)
    const forget = (): void => {
      if (inFlight.get(job) === execution) inFlight.delete(job)
    }
    void execution.then(forget, forget)
    return execution
  }

  return Object.freeze({
    maxInFlight,
    submit,
    observe(job) {
      return jobs.get(IdSchema.parse(job))
    },
    async cancel(job, cancelOptions) {
      const id = IdSchema.parse(job)
      const observed = jobs.get(id)
      if (observed === undefined) throw new Error(`yrd: no job '${id}'`)
      if (Job.terminal(observed as Job)) return observed as Job
      return jobs.cancel({
        id,
        attempt: observed.attempt,
        by: IdSchema.parse(cancelOptions.by),
        reason: z.string().trim().min(1).parse(cancelOptions.reason),
      })
    },
    recover(recoverOptions) {
      return jobs.recover({ ...recoverOptions, runner: recoverOptions.runner ?? id })
    },
  })
}
