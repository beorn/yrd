/**
 * @failure Durable Jobs accept invalid data, lose lifecycle state, or let stale runners settle work.
 * @level l1
 * @consumer @yrd/job
 */
import { describe, expect, it, vi } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
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
  isConcurrentSettlementConflict,
  isTerminalJobStatus,
  Job,
  JobStateConflict,
  withJobs,
  type JobContext,
  type JobDef,
  type JobHandler,
  type JobTransition,
} from "@yrd/job"

type Delivery = {
  message: string
  run?: string
  step?: string
  prs?: { id: string; revision: number; headSha: string }[]
}
type Receipt = { receipt: string }
type SendArgs = Delivery & { key?: string }

const SendArgsSchema = z.object({
  message: z.string().min(1),
  run: z.string().optional(),
  step: z.string().optional(),
  prs: z.array(z.object({ id: z.string(), revision: z.number(), headSha: z.string() })).optional(),
  key: z.string().min(1).optional(),
})

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
    input: SendArgsSchema.omit({ key: true }),
    output: z.object({ receipt: z.string().min(1) }),
    execute,
  })
}

function withSender(job: JobDef<Delivery, Receipt>) {
  const send = command({
    title: "Send message",
    visibility: "public",
    params: SendArgsSchema,
    apply: (_state: { sender: Record<string, never> }, args: SendArgs) => {
      const { key, ...input } = args
      return { events: [job.request(input, key === undefined ? undefined : { key })] }
    },
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
    log?: ReturnType<typeof createLogger>
  } = {},
) {
  const definition = pipe(createYrdDef(), withJobs({ definitions: { [job.name]: job } }), withSender(job))
  const app = await createYrd(definition, {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      clock: options.clock,
      id: options.id,
      log: options.log,
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
      runner: "worker-1",
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
  it("keeps generic Job input opaque when no lifecycle projection is declared", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const app = await jobsApp(delivery(), { id: ids("send", "C-send", JOB_ID), log })
    const requested = await app.dispatch(app.commands.sender.send, {
      message: "ordinary domain payload",
      run: "not-a-queue-run",
      step: "not-a-queue-step",
      prs: [{ id: "not-a-pr", revision: 7, headSha: "not-a-sha" }],
    })

    await app.jobs.run(app.jobs.requested(requested)[0]!, { runner: "worker", leaseMs: 60_000 })

    const terminal = events.find(
      (event) =>
        event.kind === "log" && event.props?.outcome === "succeeded" && event.namespace.startsWith("yrd:jobs:"),
    )
    expect(terminal).toMatchObject({ namespace: "yrd:jobs:run" })
    expect(terminal?.props).not.toHaveProperty("run")
    expect(terminal?.props).not.toHaveProperty("prs")
    await app.close()
    log.end()
  })

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

    const running = app.jobs.runMany(jobIds, { runner: "worker", leaseMs: 60_000, concurrency: 2 })
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

    await expect(app.jobs.runMany([id!], { runner: "worker", leaseMs: 60_000 })).rejects.toThrow(
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

    await expect(app.jobs.run(JOB_ID, { runner: "worker-1", leaseMs: 60_000 })).resolves.toMatchObject({
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

  it("pins revisions and keeps keyed requests unique", async () => {
    const journal = createMemoryJournal()
    const original = await jobsApp(delivery(), { journal, id: ids("send", "C-send", JOB_ID) })
    await original.dispatch(original.commands.sender.send, { message: "hello", key: "delivery:1" })
    await expect(
      original.dispatch(original.commands.sender.send, { message: "again", key: "delivery:1" }),
    ).rejects.toThrow("job key")
    await original.close()

    const changed = await jobsApp(delivery(undefined, "transport-v2"), { journal })
    await expect(changed.jobs.run(JOB_ID, { runner: "worker-1", leaseMs: 60_000 })).rejects.toThrow(
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
      runner: "manual-runner",
      leaseExpiresAt: "2026-01-01T00:01:00.000Z",
    })

    await app.jobs.finish(JOB_ID, {
      attempt: 1,
      runner: "manual-runner",
      result: { status: "passed", output: { receipt: "manual-ok" } },
    })

    const completion = (await recorded(app)).findLast(
      ({ name, data }) => name === "job/transitioned" && (data as { type?: string }).type === "finish",
    )
    expect(completion?.data).not.toHaveProperty("token")
    await app.close()
  })

  it("validates and replays structured failure evidence", async () => {
    const journal = createMemoryJournal()
    const app = await jobsApp(delivery(), { journal, id: ids("send", "C-send", JOB_ID) })
    await app.dispatch(app.commands.sender.send, { message: "manual failure" })
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: JOB_ID,
      attempt: 1,
      runner: "manual-runner",
      leaseExpiresAt: "2026-01-01T00:01:00.000Z",
    })

    await expect(
      app.jobs.finish(JOB_ID, {
        attempt: 1,
        runner: "manual-runner",
        result: {
          status: "failed",
          error: { code: "environment-refused", message: "typed refusal", evidence: new Date() as never },
        },
      }),
    ).rejects.toThrow()
    await app.jobs.finish(JOB_ID, {
      attempt: 1,
      runner: "manual-runner",
      result: {
        status: "failed",
        error: {
          code: "environment-refused",
          message: "typed refusal",
          evidence: { kind: "environment-refusal", attempts: 3 },
        },
      },
    })

    expect(app.jobs.get(JOB_ID)).toMatchObject({
      status: "failed",
      error: {
        code: "environment-refused",
        message: "typed refusal",
        evidence: { kind: "environment-refusal", attempts: 3 },
      },
    })
    const replayed = await jobsApp(delivery(), { journal })
    expect(replayed.jobs.get(JOB_ID)).toEqual(app.jobs.get(JOB_ID))
    await replayed.close()
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
    await app.jobs.run(JOB_ID, { runner: "launcher", leaseMs: 60_000 })

    expect(app.jobs.state().byId[JOB_ID]).toMatchObject({
      status: "waiting",
      attempt: 1,
      runner: "launcher",
      token: "remote-1",
      checkpoint: { sha: "abc" },
    })
    expect(app.jobs.state().byId[JOB_ID]).not.toHaveProperty("leaseExpiresAt")
    await expect(
      app.jobs.finish(JOB_ID, {
        attempt: 1,
        runner: "other",
        token: "remote-1",
        result: { status: "passed", output: { receipt: "ok" } },
      }),
    ).rejects.toThrow("runner mismatch")
    await expect(
      app.jobs.finish(JOB_ID, {
        attempt: 1,
        runner: "launcher",
        token: "remote-1",
        result: { status: "passed", output: { receipt: "" } },
      }),
    ).rejects.toThrow()

    await app.jobs.finish(JOB_ID, {
      attempt: 1,
      runner: "launcher",
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
    await original.jobs.run(JOB_ID, { runner: "launcher", leaseMs: 60_000 })
    await original.close()

    const resumed = await jobsApp(delivery(undefined, "transport-v2"), { journal })
    await expect(
      resumed.jobs.finish(JOB_ID, {
        attempt: 1,
        runner: "launcher",
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
      runner: "lost-worker",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z",
    })
    await app.dispatch(app.commands.job.transition, {
      type: "heartbeat",
      id: JOB_ID,
      attempt: 1,
      runner: "lost-worker",
      leaseExpiresAt: "2026-01-01T00:00:03.000Z",
    })

    expect(await app.jobs.recover({ now: "2026-01-01T00:00:02.000Z" })).toEqual([])
    expect(await app.jobs.recover({ now: "2026-01-01T00:00:04.000Z" })).toEqual([JOB_ID])
    expect(app.jobs.state().byId[JOB_ID]).toMatchObject({ status: "lost", attempt: 1 })

    await app.jobs.retry(JOB_ID)
    await app.jobs.run(JOB_ID, { runner: "replacement", leaseMs: 60_000 })
    expect(app.jobs.state().byId[JOB_ID]).toMatchObject({ status: "passed", attempt: 2 })
    await expect(
      app.dispatch(app.commands.job.transition, {
        type: "finish",
        id: JOB_ID,
        attempt: 1,
        runner: "lost-worker",
        result: { status: "passed", output: { receipt: "stale" } },
      }),
    ).rejects.toThrow("attempt 1 is stale")
    await app.close()
  })

  it("emits recovered lease identity at WARN without inventing a replacement runner", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const app = await jobsApp(delivery(), { id: ids("send", "C-send", JOB_ID), log })
    await app.dispatch(app.commands.sender.send, { message: "recover" })
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: JOB_ID,
      attempt: 1,
      runner: "lost-worker",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z",
    })

    await expect(app.jobs.recover({ now: "2026-01-01T00:00:02.000Z" })).resolves.toEqual([JOB_ID])

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:jobs:recover",
        level: "warn",
        props: expect.objectContaining({
          lifecycle: "recover",
          outcome: "recovered",
          job: JOB_ID,
          attempt: 1,
          runner: "lost-worker",
          leaseExpiresAt: "2026-01-01T00:00:01.000Z",
          durationMs: expect.any(Number),
        }),
      }),
    )
    await app.close()
    log.end()
  })

  it("reclaims a named dead runner's live-leased jobs and leaves other runners untouched", async () => {
    const app = await jobsApp(delivery())
    await app.dispatch(app.commands.sender.send, { message: "one" })
    await app.dispatch(app.commands.sender.send, { message: "two" })
    const [dead, alive] = Object.keys(app.jobs.state().byId)
    // Both leases are LIVE (far in the future): the caller asserts the first
    // runner is dead, so its live lease is reclaimed regardless of expiry.
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: dead!,
      attempt: 1,
      runner: "yrd-cli:111",
      leaseExpiresAt: "2026-01-01T00:05:00.000Z",
    })
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: alive!,
      attempt: 1,
      runner: "yrd-cli:222",
      leaseExpiresAt: "2026-01-01T00:05:00.000Z",
    })

    expect(await app.jobs.recover({ now: "2026-01-01T00:00:02.000Z", runner: "yrd-cli:111" })).toEqual([dead])
    expect(app.jobs.state().byId[dead!]).toMatchObject({
      status: "lost",
      attempt: 1,
      lostReason: "runner disappeared",
    })
    expect(app.jobs.state().byId[alive!]).toMatchObject({ status: "running", runner: "yrd-cli:222" })
    await app.close()
  })

  it("emits the dead-runner reclaim reason and identity at WARN", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const app = await jobsApp(delivery(), { id: ids("send", "C-send", JOB_ID), log })
    await app.dispatch(app.commands.sender.send, { message: "reclaim" })
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: JOB_ID,
      attempt: 1,
      runner: "yrd-cli:333",
      leaseExpiresAt: "2026-01-01T00:05:00.000Z",
    })

    await expect(app.jobs.recover({ now: "2026-01-01T00:00:02.000Z", runner: "yrd-cli:333" })).resolves.toEqual([
      JOB_ID,
    ])

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:jobs:recover",
        level: "warn",
        props: expect.objectContaining({
          lifecycle: "recover",
          outcome: "recovered",
          job: JOB_ID,
          runner: "yrd-cli:333",
          reason: "runner disappeared",
        }),
      }),
    )
    await app.close()
    log.end()
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
        runner: "worker-1",
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

  it("aborts and awaits active runner cleanup when the runtime closes", async () => {
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
    const running = app.jobs.run(JOB_ID, { runner: "worker-1", leaseMs: 60_000 })
    const settled = running.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await started.promise

    await app.close()

    expect(cleaned).toBe(true)
    await expect(settled).resolves.toEqual({ error: expect.objectContaining({ message: "yrd: runtime is closed" }) })
  })

  it("cancels an unclaimed requested Job without inventing runner identity", async () => {
    await using app = await jobsApp(delivery(), { id: ids("send", "C-send", JOB_ID) })
    await app.dispatch(app.commands.sender.send, { message: "unclaimed" })

    const canceled = await app.jobs.cancel({
      id: JOB_ID,
      attempt: 0,
      by: "@chief",
      reason: "authorization withdrawn before claim",
    })

    expect(canceled).toMatchObject({
      id: JOB_ID,
      attempt: 0,
      status: "canceled",
      canceledBy: "@chief",
      cancelReason: "authorization withdrawn before claim",
    })
    expect(canceled).not.toHaveProperty("runner")
    expect(canceled).not.toHaveProperty("startedAt")
  })

  it("cancels an active Job immediately without projecting runner loss", async () => {
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    await using app = await jobsApp(
      delivery(async (_input, context) => {
        started.resolve()
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            aborted.resolve()
            resolve()
          }
          if (context.signal.aborted) onAbort()
          else context.signal.addEventListener("abort", onAbort, { once: true })
        })
        return { status: "passed", output: { receipt: "too-late" } }
      }),
      { id: ids("send", "C-send", JOB_ID) },
    )
    await app.dispatch(app.commands.sender.send, { message: "slow" })
    const running = app.jobs.run(JOB_ID, { runner: "worker-1", leaseMs: 60_000 })
    await started.promise

    const canceled = await app.jobs.cancel({
      id: JOB_ID,
      attempt: 1,
      by: "@chief",
      reason: "authorization revoked",
    })

    await aborted.promise
    expect(canceled).toMatchObject({
      id: JOB_ID,
      attempt: 1,
      status: "canceled",
      canceledBy: "@chief",
      cancelReason: "authorization revoked",
    })
    expect(canceled).not.toHaveProperty("lostReason")
    await expect(running).resolves.toMatchObject({ status: "canceled" })
    const transition = (await recorded(app)).findLast(
      ({ name, data }) => name === "job/transitioned" && (data as { type?: string }).type === "cancel",
    )
    expect(transition?.data).toEqual({
      type: "cancel",
      id: JOB_ID,
      attempt: 1,
      by: "@chief",
      reason: "authorization revoked",
    })
  })

  it("aborts an runner after heartbeat observes lost ownership", async () => {
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
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
      { id: ids("send", "C-send", JOB_ID) },
    )
    await app.dispatch(app.commands.sender.send, { message: "slow" })

    vi.useFakeTimers()
    try {
      const running = app.jobs.run(JOB_ID, {
        runner: "worker-1",
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
        runner: job.runner,
        leaseExpiresAt: job.leaseExpiresAt,
        reason: "lease transferred",
      })
      await vi.advanceTimersByTimeAsync(5)
      await aborted.promise
      await expect(running).resolves.toMatchObject({ status: "lost", lostReason: "lease transferred" })
    } finally {
      vi.useRealTimers()
    }
    await app.close()
  })
})

describe("JobStateConflict — transition guards stay loud but carry a losable-race signal", () => {
  const at = "2026-01-01T00:00:00.000Z"
  const requested = () => Job.requested(JOB_ID, at, { definition: "d", revision: "r", input: {} })
  const running = () =>
    Job.apply(requested(), { type: "start", id: JOB_ID, attempt: 1, runner: "w", leaseExpiresAt: at }, at)
  const canceled = () =>
    Job.apply(running(), { type: "cancel", id: JOB_ID, attempt: 1, by: "@peer", reason: "superseded" }, at)
  const finish: JobTransition = {
    type: "finish",
    id: JOB_ID,
    attempt: 1,
    runner: "w",
    result: { status: "passed", output: { receipt: "ok" } },
  }

  it("throws a typed JobStateConflict — same message — when a finish meets an already-canceled Job", () => {
    let thrown: unknown
    try {
      Job.apply(canceled(), finish, at)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(JobStateConflict)
    expect(thrown).toMatchObject({ jobId: JOB_ID, actual: "canceled", expected: "running or waiting" })
    // Message byte-identical to the pre-typed Error so existing catchers/logs are unaffected.
    expect((thrown as Error).message).toBe(`yrd: job '${JOB_ID}' is canceled, not running or waiting`)
    // The canceled Job is terminal → a peer settled it under us → losable race.
    expect(isConcurrentSettlementConflict(thrown)).toBe(true)
  })

  it("classifies a conflict against a still-LIVE Job as fatal, never losable", () => {
    // Trying to start a running Job is a real invalid transition, not a race.
    let thrown: unknown
    try {
      Job.apply(running(), { type: "start", id: JOB_ID, attempt: 2, runner: "w", leaseExpiresAt: at }, at)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(JobStateConflict)
    expect((thrown as JobStateConflict).actual).toBe("running")
    // running is NOT terminal → must keep propagating (fail-loud).
    expect(isConcurrentSettlementConflict(thrown)).toBe(false)
  })

  it("only treats JobStateConflict against a terminal status as a losable race", () => {
    expect(isConcurrentSettlementConflict(new Error("unrelated"))).toBe(false)
    expect(isConcurrentSettlementConflict(new JobStateConflict("J", "requested", "running"))).toBe(false)
    expect(isConcurrentSettlementConflict(new JobStateConflict("J", "waiting", "requested"))).toBe(false)
    for (const status of ["passed", "failed", "lost", "canceled"] as const) {
      expect(isTerminalJobStatus(status)).toBe(true)
      expect(isConcurrentSettlementConflict(new JobStateConflict("J", status, "running"))).toBe(true)
    }
    for (const status of ["requested", "running", "waiting"] as const) {
      expect(isTerminalJobStatus(status)).toBe(false)
    }
  })

  it("reproduces the genuine race: a peer cancels between a runner's ownership check and its settlement", async () => {
    // Two runtimes over ONE journal (separate processes in production). The runner
    // starts the Job and blocks in execute; a peer cancels the Job; the runner's
    // stale projection still shows it owning a running Job, so it commits a finish
    // that re-folds the journal and meets the canceled Job — the escaping throw
    // that killed the resident runner on 2026-07-15.
    const journal = createMemoryJournal()
    const executing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<{ status: "passed"; output: Receipt }>()
    const job = delivery(() => {
      executing.resolve()
      return release.promise
    })
    const runnerApp = await jobsApp(job, { journal })
    const peerApp = await jobsApp(job, { journal })

    const dispatched = await runnerApp.dispatch(runnerApp.commands.sender.send, { message: "hello" })
    const [id] = runnerApp.jobs.requested(dispatched)
    const running = runnerApp.jobs.run(id!, { runner: "worker-1", leaseMs: 60_000 })
    await executing.promise

    await peerApp.jobs.cancel({ id: id!, attempt: 1, by: "@peer", reason: "superseded" })
    release.resolve({ status: "passed", output: { receipt: "ok:hello" } })

    const outcome = await running.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("unreachable")
    expect(outcome.error).toBeInstanceOf(JobStateConflict)
    expect((outcome.error as JobStateConflict).actual).toBe("canceled")
    expect(isConcurrentSettlementConflict(outcome.error)).toBe(true)

    await runnerApp.close()
    await peerApp.close()
  })
})
