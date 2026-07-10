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
import { createJobDef, withJobs, type JobContext, type JobDef, type JobHandler, type JobResult } from "@yrd/job"

type Delivery = { message: string }
type Receipt = { receipt: string }
type SendArgs = Delivery & { key?: string }

const SendArgsSchema = z.object({ message: z.string().min(1), key: z.string().min(1).optional() })

function ids(...values: string[]) {
  let index = 0
  return () => values[index++] ?? `id-${index}`
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
  } = {},
) {
  const definition = pipe(createYrdDef(), withJobs(), withSender(job))
  const app = await createYrd(definition, {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      clock: options.clock,
      id: options.id,
    },
  })
  app.jobs.add(job)
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
  it("projects request IDs and keys, executes once, and replays the same state", async () => {
    const journal = createMemoryJournal()
    let tick = 0
    const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
    const job = delivery()
    const app = await jobsApp(job, {
      journal,
      clock,
      id: ids("send", "J1", "start", "E-start", "finish", "E-finish"),
    })

    const result = await app.command(app.commands.sender.send, { message: "hello", key: "delivery:1" })
    expect(app.jobs.requested(result)).toEqual(["J1"])
    expect(app.jobs.state()).toMatchObject({
      byId: { J1: { id: "J1", status: "requested", attempt: 0, input: { message: "hello" } } },
      byKey: { "delivery:1": "J1" },
    })
    expect(app.jobs.get("J1")).toMatchObject({ id: "J1", status: "requested" })

    await expect(app.jobs.run("J1", { executor: "worker-1", leaseMs: 60_000 })).resolves.toMatchObject({
      id: "J1",
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

  it("pins revisions and keeps keyed requests unique", async () => {
    const journal = createMemoryJournal()
    const original = await jobsApp(delivery(), { journal, id: ids("send", "J1") })
    await original.command(original.commands.sender.send, { message: "hello", key: "delivery:1" })
    await expect(
      original.command(original.commands.sender.send, { message: "again", key: "delivery:1" }),
    ).rejects.toThrow("job key")
    await original.close()

    const changed = await jobsApp(delivery(undefined, "transport-v2"), { journal })
    await expect(changed.jobs.run("J1", { executor: "worker-1", leaseMs: 60_000 })).rejects.toThrow(
      "definition revision",
    )
    expect(changed.jobs.state().byId.J1?.status).toBe("requested")
    await changed.close()
  })

  it("parks remote work and fences its terminal completion", async () => {
    const job = delivery(async () => ({
      status: "waiting",
      token: "remote-1",
      url: "https://runner.invalid/jobs/1",
      checkpoint: { sha: "abc" },
    }))
    const app = await jobsApp(job, { id: ids("send", "J1", "start", "E-start", "wait", "E-wait") })
    await app.command(app.commands.sender.send, { message: "remote" })
    await app.jobs.run("J1", { executor: "launcher", leaseMs: 60_000 })

    expect(app.jobs.state().byId.J1).toMatchObject({
      status: "waiting",
      attempt: 1,
      executor: "launcher",
      token: "remote-1",
      checkpoint: { sha: "abc" },
    })
    expect(app.jobs.state().byId.J1).not.toHaveProperty("leaseExpiresAt")
    await expect(
      app.jobs.finish("J1", {
        attempt: 1,
        executor: "other",
        token: "remote-1",
        result: { status: "passed", output: { receipt: "ok" } },
      }),
    ).rejects.toThrow("executor mismatch")
    await expect(
      app.jobs.finish("J1", {
        attempt: 1,
        executor: "launcher",
        token: "remote-1",
        result: { status: "passed", output: { receipt: "" } },
      }),
    ).rejects.toThrow()

    await app.jobs.finish("J1", {
      attempt: 1,
      executor: "launcher",
      token: "remote-1",
      result: { status: "passed", output: { receipt: "remote-ok" } },
    })
    expect(app.jobs.state().byId.J1).toMatchObject({
      status: "passed",
      output: { receipt: "remote-ok" },
      checkpoint: { sha: "abc" },
    })
    await app.close()
  })

  it("recovers only the observed expired lease, then retries as a new attempt", async () => {
    const app = await jobsApp(delivery(), { id: ids("send", "J1") })
    await app.command(app.commands.sender.send, { message: "recover" })
    await app.command(app.commands.job.transition, {
      type: "start",
      id: "J1",
      attempt: 1,
      executor: "lost-worker",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z",
    })
    await app.command(app.commands.job.transition, {
      type: "heartbeat",
      id: "J1",
      attempt: 1,
      executor: "lost-worker",
      leaseExpiresAt: "2026-01-01T00:00:03.000Z",
    })

    expect(await app.jobs.recover({ now: "2026-01-01T00:00:02.000Z" })).toEqual([])
    expect(await app.jobs.recover({ now: "2026-01-01T00:00:04.000Z" })).toEqual(["J1"])
    expect(app.jobs.state().byId.J1).toMatchObject({ status: "lost", attempt: 1 })

    await app.jobs.retry("J1")
    await app.jobs.run("J1", { executor: "replacement", leaseMs: 60_000 })
    expect(app.jobs.state().byId.J1).toMatchObject({ status: "passed", attempt: 2 })
    await expect(
      app.command(app.commands.job.transition, {
        type: "finish",
        id: "J1",
        attempt: 1,
        executor: "lost-worker",
        result: { status: "passed", output: { receipt: "stale" } },
      }),
    ).rejects.toThrow("attempt 1 is stale")
    await app.close()
  })

  it("renews a lease through the Job run scope", async () => {
    let release = () => {}
    let signalStarted = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const started = new Promise<void>((resolve) => (signalStarted = resolve))
    const app = await jobsApp(
      delivery(async () => {
        signalStarted()
        await gate
        return { status: "passed", output: { receipt: "slow-ok" } }
      }),
      { id: ids("send", "J1") },
    )
    await app.command(app.commands.sender.send, { message: "slow" })
    let now = 0

    vi.useFakeTimers()
    try {
      const running = app.jobs.run("J1", {
        executor: "worker-1",
        leaseMs: 20,
        heartbeatMs: 5,
        now: () => (now += 10),
      })
      await started
      await vi.advanceTimersByTimeAsync(20)
      release()
      await expect(running).resolves.toMatchObject({ status: "passed", attempt: 1 })
    } finally {
      release()
      vi.useRealTimers()
    }

    const transitions = (await recorded(app))
      .filter(({ name }) => name === "job/transitioned")
      .map(({ data }) => data as { type: string })
    expect(transitions.filter(({ type }) => type === "heartbeat").length).toBeGreaterThanOrEqual(2)
    await app.close()
  })
})
