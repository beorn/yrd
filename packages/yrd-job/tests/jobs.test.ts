/**
 * @failure Durable Jobs accept invalid data, lose lifecycle state, or let stale executors settle work.
 * @level l1
 * @consumer @yrd/job
 */
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import {
  command,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  pipe,
  type CommandTree,
  type Event,
  type YrdDef,
} from "@yrd/core"
import {
  createJobDef,
  withJobs,
  type JobAttemptResources,
  type JobContext,
  type JobDef,
  type JobHandler,
} from "@yrd/job"

type Delivery = { message: string }
type Receipt = { receipt: string }
type SendArgs = Delivery & { key?: string }

const SendArgsSchema = z.object({ message: z.string().min(1), key: z.string().min(1).optional() })

function testId(value: number): string {
  return `00000000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`
}

const JOB_ID = testId(1)
let idSequence = 1

function ids(...values: string[]) {
  let index = 0
  return () => {
    const value = values[index++]
    return value === JOB_ID ? value : testId(++idSequence)
  }
}

function delivery(
  execute: JobHandler<Delivery, Receipt> = async ({ message }) => ({
    status: "passed",
    output: { receipt: `ok:${message}` },
  }),
  revision = "transport-v1",
) {
  return createJobDef({
    name: "message.deliver",
    title: "Deliver message",
    revision,
    input: z.object({ message: z.string().min(1) }),
    output: z.object({ receipt: z.string().min(1) }),
    execute,
  })
}

function withSender(job: JobDef<Delivery, Receipt>) {
  const send = command({
    title: "Send message",
    visibility: "public",
    params: SendArgsSchema,
    apply: (_state: { sender: Record<string, never> }, args: SendArgs) => ({
      events: [job.request({ message: args.message }, args.key === undefined ? undefined : { key: args.key })],
    }),
  })

  return <State extends object, Commands extends CommandTree, Features extends object>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { sender: {} },
      commands: { sender: { send } },
      project: (state) => state,
    })
}

async function jobsApp(
  job: JobDef<Delivery, Receipt>,
  options: {
    journal?: ReturnType<typeof createMemoryJournal>
    clock?: () => string
    id?: () => string
    attemptResources?: JobAttemptResources
  } = {},
) {
  const definition = pipe(
    createYrdDef(),
    withJobs({
      definitions: { [job.name]: job },
      ...(options.attemptResources === undefined ? {} : { attemptResources: options.attemptResources }),
    }),
    withSender(job),
  )
  const app = await createYrd(definition, {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      clock: options.clock,
      id: options.id,
    },
  })
  return app
}

async function recorded(app: { events(): AsyncIterable<unknown> }): Promise<Event[]> {
  return (await Array.fromAsync(app.events())) as Event[]
}

describe("JobDef", () => {
  it("is a typed plain object that validates durable input and output", async () => {
    const deliver = delivery()
    const context: JobContext = {
      id: "J1",
      attempt: 1,
      executor: "worker-1",
      signal: new AbortController().signal,
    }

    expect(Object.getPrototypeOf(deliver)).toBe(Object.prototype)
    expect(deliver.request({ message: "hello" }, { key: "message:1" })).toEqual({
      name: "job/requested",
      data: {
        definition: "message.deliver",
        revision: "transport-v1",
        input: { message: "hello" },
        key: "message:1",
      },
    })
    await expect(deliver.execute({ message: "hello" }, context)).resolves.toEqual({
      status: "passed",
      output: { receipt: "ok:hello" },
    })
    expect(() => deliver.request({ message: "" })).toThrow()

    const invalid = delivery(async () => ({ status: "passed", output: { receipt: "" } }))
    await expect(invalid.execute({ message: "hello" }, context)).rejects.toThrow()
  })
})

describe("Jobs", () => {
  it("freezes definitions at composition and rejects duplicate paths", async () => {
    const first = delivery()
    const second = delivery(undefined, "transport-v2")
    expect(() => withJobs({ definitions: [{ [first.name]: first }, { [second.name]: second }] })).toThrow(
      "duplicate job definition 'message.deliver'",
    )

    const app = await jobsApp(first)
    expect(app.jobs.definition("message.deliver")).toBe(first)
    expect(() => app.jobs.requireDefinitions({ [first.name]: first })).not.toThrow()
    expect(() => app.jobs.requireDefinitions({ [second.name]: second })).toThrow("does not match required revision")
    expect(() => app.jobs.definition("missing")).toThrow("no job definition 'missing'")
    await app.close()
  })

  it("refills bounded concurrency slots and preserves input order", async () => {
    let active = 0
    let peak = 0
    const first = Promise.withResolvers<void>()
    const slow = Promise.withResolvers<void>()
    const started: string[] = []
    const app = await jobsApp(
      delivery(async ({ message }) => {
        started.push(message)
        active++
        peak = Math.max(peak, active)
        if (message === "first") await first.promise
        if (message === "slow") await slow.promise
        active--
        return { status: "passed", output: { receipt: `ok:${message}` } }
      }),
    )
    const firstResult = await app.dispatch(app.commands.sender.send, { message: "first" })
    const slowResult = await app.dispatch(app.commands.sender.send, { message: "slow" })
    const thirdResult = await app.dispatch(app.commands.sender.send, { message: "third" })
    const jobIds = [
      ...app.jobs.requested(firstResult),
      ...app.jobs.requested(slowResult),
      ...app.jobs.requested(thirdResult),
    ]

    const running = app.jobs.runMany(jobIds, { executor: "worker", leaseMs: 60_000, concurrency: 2 })
    await vi.waitFor(() => expect(started).toEqual(["first", "slow"]))
    first.resolve()
    await vi.waitFor(() => expect(started).toEqual(["first", "slow", "third"]))
    slow.resolve()
    const jobs = await running

    expect(jobs).toMatchObject([
      { id: jobIds[0], status: "passed", output: { receipt: "ok:first" } },
      { id: jobIds[1], status: "passed", output: { receipt: "ok:slow" } },
      { id: jobIds[2], status: "passed", output: { receipt: "ok:third" } },
    ])
    expect(peak).toBe(2)
    await app.close()
  })

  it("does not hide a settlement append failure after runMany starts a Job", async () => {
    const memory = createMemoryJournal()
    let appends = 0
    const journal = {
      read: memory.read,
      append(value: Parameters<typeof memory.append>[0], cursor: number) {
        appends++
        return appends === 3 ? Promise.reject(new Error("settlement append failed")) : memory.append(value, cursor)
      },
    }
    const app = await jobsApp(delivery(), { journal })
    const result = await app.dispatch(app.commands.sender.send, { message: "hello" })
    const [id] = app.jobs.requested(result)

    await expect(app.jobs.runMany([id!], { executor: "worker", leaseMs: 60_000 })).rejects.toThrow(
      "settlement append failed",
    )
    expect(app.jobs.get(id!)).toMatchObject({ status: "running", attempt: 1 })
    await app.close()
  })

  it("projects request IDs and keys, executes once, and replays the same state", async () => {
    const journal = createMemoryJournal()
    let tick = 0
    const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
    const job = delivery()
    const app = await jobsApp(job, {
      journal,
      clock,
      id: ids("send", "C-send", JOB_ID, "start", "C-start", "E-start", "finish", "C-finish", "E-finish"),
    })

    const result = await app.dispatch(app.commands.sender.send, { message: "hello", key: "delivery:1" })
    expect(app.jobs.requested(result)).toEqual([JOB_ID])
    expect(app.jobs.state()).toMatchObject({
      byId: { [JOB_ID]: { id: JOB_ID, status: "requested", attempt: 0, input: { message: "hello" } } },
      byKey: { "delivery:1": JOB_ID },
    })
    expect(app.jobs.get(JOB_ID)).toMatchObject({ id: JOB_ID, status: "requested" })

    await expect(app.jobs.run(JOB_ID, { executor: "worker-1", leaseMs: 60_000 })).resolves.toMatchObject({
      id: JOB_ID,
      status: "passed",
      attempt: 1,
      output: { receipt: "ok:hello" },
    })
    expect((await recorded(app)).map(({ name }) => name)).toEqual([
      "job/requested",
      "job/transitioned",
      "job/transitioned",
    ])

    const replayed = await jobsApp(job, { journal })
    expect(replayed.jobs.state()).toEqual(app.jobs.state())
    await replayed.close()
    await app.close()
  })

  it.each([
    {
      outcome: "success",
      execute: async () => ({ status: "passed", output: { receipt: "ok" } }) as const,
      status: "passed",
    },
    {
      outcome: "failure",
      execute: async () => ({ status: "failed", error: { code: "delivery-failed", message: "no route" } }) as const,
      status: "failed",
    },
  ])("releases job-owned attempt resources before $outcome settlement", async ({ execute, status }) => {
    const lifecycle: string[] = []
    const app = await jobsApp(
      delivery(async () => {
        lifecycle.push("execute")
        return execute()
      }),
      {
        id: ids("send", "C-send", JOB_ID),
        attemptResources: {
          prepare: async ({ id, attempt, executor }) => {
            lifecycle.push(`prepare:${id}:${attempt}:${executor}`)
          },
          release: async ({ id, attempt, executor }) => {
            lifecycle.push(`release:${id}:${attempt}:${executor}`)
          },
        },
      },
    )
    await app.dispatch(app.commands.sender.send, { message: "hello" })

    await expect(app.jobs.run(JOB_ID, { executor: "worker-1", leaseMs: 60_000 })).resolves.toMatchObject({ status })
    expect(lifecycle).toEqual([`prepare:${JOB_ID}:1:worker-1`, "execute", `release:${JOB_ID}:1:worker-1`])
    await app.close()
  })

  it("fences an expired owner before release and retries interrupted recovery cleanup", async () => {
    let app: Awaited<ReturnType<typeof jobsApp>>
    let releaseFailure = true
    const releasedStatuses: string[] = []
    app = await jobsApp(delivery(), {
      id: ids("send", "C-send", JOB_ID),
      attemptResources: {
        prepare: () => Promise.resolve(),
        release: () => {
          releasedStatuses.push(app.jobs.get(JOB_ID)?.status ?? "missing")
          return releaseFailure ? Promise.reject(new Error("resident still alive")) : Promise.resolve()
        },
      },
    })
    await app.dispatch(app.commands.sender.send, { message: "recover" })
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: JOB_ID,
      attempt: 1,
      executor: "lost-worker",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z",
    })

    await expect(app.jobs.recover({ now: "2026-01-01T00:00:02.000Z" })).rejects.toThrow("resident still alive")
    expect(app.jobs.get(JOB_ID)).toMatchObject({ status: "lost", attempt: 1 })
    expect(releasedStatuses).toEqual(["lost"])

    releaseFailure = false
    await expect(app.jobs.recover({ now: "2026-01-01T00:00:03.000Z" })).resolves.toEqual([])
    expect(releasedStatuses).toEqual(["lost", "lost"])
    await app.close()
  })

  it("pins revisions and keeps keyed requests unique", async () => {
    const journal = createMemoryJournal()
    const original = await jobsApp(delivery(), { journal, id: ids("send", "C-send", JOB_ID) })
    await original.dispatch(original.commands.sender.send, { message: "hello", key: "delivery:1" })
    await expect(
      original.dispatch(original.commands.sender.send, { message: "again", key: "delivery:1" }),
    ).rejects.toThrow("job key")
    await original.close()

    const changed = await jobsApp(delivery(undefined, "transport-v2"), { journal })
    await expect(changed.jobs.run(JOB_ID, { executor: "worker-1", leaseMs: 60_000 })).rejects.toThrow(
      "definition revision",
    )
    expect(changed.jobs.state().byId[JOB_ID]?.status).toBe("requested")
    await changed.close()
  })

  it("omits an absent completion token from durable command data", async () => {
    const app = await jobsApp(delivery(), { id: ids("send", "C-send", JOB_ID) })
    await app.dispatch(app.commands.sender.send, { message: "manual" })
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: JOB_ID,
      attempt: 1,
      executor: "manual-runner",
      leaseExpiresAt: "2026-01-01T00:01:00.000Z",
    })

    await app.jobs.finish(JOB_ID, {
      attempt: 1,
      executor: "manual-runner",
      result: { status: "passed", output: { receipt: "manual-ok" } },
    })

    const completion = (await recorded(app)).findLast(
      ({ name, data }) => name === "job/transitioned" && (data as { type?: string }).type === "finish",
    )
    expect(completion?.data).not.toHaveProperty("token")
    await app.close()
  })

  it("parks remote work and fences its terminal completion", async () => {
    const job = delivery(async () => ({
      status: "waiting",
      token: "remote-1",
      url: "https://runner.invalid/jobs/1",
      checkpoint: { sha: "abc" },
    }))
    const app = await jobsApp(job, {
      id: ids("send", "C-send", JOB_ID, "start", "C-start", "E-start", "wait", "C-wait", "E-wait"),
    })
    await app.dispatch(app.commands.sender.send, { message: "remote" })
    await app.jobs.run(JOB_ID, { executor: "launcher", leaseMs: 60_000 })

    expect(app.jobs.state().byId[JOB_ID]).toMatchObject({
      status: "waiting",
      attempt: 1,
      executor: "launcher",
      token: "remote-1",
      checkpoint: { sha: "abc" },
    })
    expect(app.jobs.state().byId[JOB_ID]).not.toHaveProperty("leaseExpiresAt")
    await expect(
      app.jobs.finish(JOB_ID, {
        attempt: 1,
        executor: "other",
        token: "remote-1",
        result: { status: "passed", output: { receipt: "ok" } },
      }),
    ).rejects.toThrow("executor mismatch")
    await expect(
      app.jobs.finish(JOB_ID, {
        attempt: 1,
        executor: "launcher",
        token: "remote-1",
        result: { status: "passed", output: { receipt: "" } },
      }),
    ).rejects.toThrow()

    await app.jobs.finish(JOB_ID, {
      attempt: 1,
      executor: "launcher",
      token: "remote-1",
      result: { status: "passed", output: { receipt: "remote-ok" } },
    })
    expect(app.jobs.state().byId[JOB_ID]).toMatchObject({
      status: "passed",
      output: { receipt: "remote-ok" },
      checkpoint: { sha: "abc" },
    })
    const completion = (await recorded(app)).findLast(
      ({ name, data }) => name === "job/transitioned" && (data as { type?: string }).type === "finish",
    )
    expect(completion?.data).toMatchObject({ token: "remote-1" })
    await app.close()
  })

  it("finishes pinned waiting work after a compatible definition revision changes", async () => {
    const journal = createMemoryJournal()
    const waiting = delivery(
      async () => ({ status: "waiting", token: "remote-1", url: "https://runner.invalid/jobs/1" }),
      "transport-v1",
    )
    const original = await jobsApp(waiting, { journal, id: ids("send", "C-send", JOB_ID) })
    await original.dispatch(original.commands.sender.send, { message: "remote" })
    await original.jobs.run(JOB_ID, { executor: "launcher", leaseMs: 60_000 })
    await original.close()

    const resumed = await jobsApp(delivery(undefined, "transport-v2"), { journal })
    await expect(
      resumed.jobs.finish(JOB_ID, {
        attempt: 1,
        executor: "launcher",
        token: "remote-1",
        result: { status: "passed", output: { receipt: "remote-ok" } },
      }),
    ).resolves.toMatchObject({ status: "passed", revision: "transport-v1", output: { receipt: "remote-ok" } })
    await resumed.close()
  })

  it("recovers only the observed expired lease, then retries as a new attempt", async () => {
    const app = await jobsApp(delivery(), { id: ids("send", "C-send", JOB_ID) })
    await app.dispatch(app.commands.sender.send, { message: "recover" })
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: JOB_ID,
      attempt: 1,
      executor: "lost-worker",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z",
    })
    await app.dispatch(app.commands.job.transition, {
      type: "heartbeat",
      id: JOB_ID,
      attempt: 1,
      executor: "lost-worker",
      leaseExpiresAt: "2026-01-01T00:00:03.000Z",
    })

    expect(await app.jobs.recover({ now: "2026-01-01T00:00:02.000Z" })).toEqual([])
    expect(await app.jobs.recover({ now: "2026-01-01T00:00:04.000Z" })).toEqual([JOB_ID])
    expect(app.jobs.state().byId[JOB_ID]).toMatchObject({ status: "lost", attempt: 1 })

    await app.jobs.retry(JOB_ID)
    await app.jobs.run(JOB_ID, { executor: "replacement", leaseMs: 60_000 })
    expect(app.jobs.state().byId[JOB_ID]).toMatchObject({ status: "passed", attempt: 2 })
    await expect(
      app.dispatch(app.commands.job.transition, {
        type: "finish",
        id: JOB_ID,
        attempt: 1,
        executor: "lost-worker",
        result: { status: "passed", output: { receipt: "stale" } },
      }),
    ).rejects.toThrow("attempt 1 is stale")
    await app.close()
  })

  it("renews a lease through the Job run scope", async () => {
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const app = await jobsApp(
      delivery(async () => {
        started.resolve()
        await gate.promise
        return { status: "passed", output: { receipt: "slow-ok" } }
      }),
      { id: ids("send", "C-send", JOB_ID) },
    )
    await app.dispatch(app.commands.sender.send, { message: "slow" })
    let now = 0

    vi.useFakeTimers()
    try {
      const running = app.jobs.run(JOB_ID, {
        executor: "worker-1",
        leaseMs: 20,
        heartbeatMs: 5,
        now: () => (now += 10),
      })
      await started.promise
      await vi.advanceTimersByTimeAsync(20)
      gate.resolve()
      await expect(running).resolves.toMatchObject({ status: "passed", attempt: 1 })
    } finally {
      gate.resolve()
      vi.useRealTimers()
    }

    const transitions = (await recorded(app))
      .filter(({ name }) => name === "job/transitioned")
      .map(({ data }) => data as { type: string })
    expect(transitions.filter(({ type }) => type === "heartbeat").length).toBeGreaterThanOrEqual(2)
    await app.close()
  })

  it("aborts and awaits active executor cleanup when the runtime closes", async () => {
    const started = Promise.withResolvers<void>()
    let cleaned = false
    const app = await jobsApp(
      delivery(async (_input, context) => {
        started.resolve()
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        await Bun.sleep(10)
        cleaned = true
        return { status: "passed", output: { receipt: "too-late" } }
      }),
      { id: ids("send", "C-send", JOB_ID) },
    )
    await app.dispatch(app.commands.sender.send, { message: "slow" })
    const running = app.jobs.run(JOB_ID, { executor: "worker-1", leaseMs: 60_000 })
    const settled = running.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await started.promise

    await app.close()

    expect(cleaned).toBe(true)
    await expect(settled).resolves.toEqual({ error: expect.objectContaining({ message: "yrd: runtime is closed" }) })
  })

  it("aborts an executor after heartbeat observes lost ownership", async () => {
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const app = await jobsApp(
      delivery(async (_input, context) => {
        started.resolve()
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted.resolve()
              resolve()
            },
            { once: true },
          )
        })
        return { status: "passed", output: { receipt: "too-late" } }
      }),
      {
        id: ids("send", "C-send", JOB_ID),
        attemptResources: {
          prepare: () => Promise.resolve(),
          release: () => {
            released.resolve()
            return Promise.resolve()
          },
        },
      },
    )
    await app.dispatch(app.commands.sender.send, { message: "slow" })

    vi.useFakeTimers()
    try {
      const running = app.jobs.run(JOB_ID, {
        executor: "worker-1",
        leaseMs: 20,
        heartbeatMs: 5,
        now: () => 0,
      })
      await started.promise
      const job = app.jobs.get(JOB_ID)
      if (job?.status !== "running") throw new Error("job did not start")
      await app.dispatch(app.commands.job.transition, {
        type: "lose",
        id: job.id,
        attempt: job.attempt,
        executor: job.executor,
        leaseExpiresAt: job.leaseExpiresAt,
        reason: "lease transferred",
      })
      await vi.advanceTimersByTimeAsync(5)
      await aborted.promise
      await expect(running).resolves.toMatchObject({ status: "lost", lostReason: "lease transferred" })
      await released.promise
    } finally {
      vi.useRealTimers()
    }
    await app.close()
  })
})
