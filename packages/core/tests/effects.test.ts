import { describe, expect, it, vi } from "vitest"
import {
  createMemoryEventStore,
  createYrd,
  effect,
  event,
  fx,
  op,
  type AnyYrdApp,
  type Command,
  type DeepReadonly,
  type ExtendYrdApp,
} from "../src/app.ts"
import { withEffects, type EffectExecutor, type EffectOutcome, type HasEffects } from "../src/effects.ts"
import { pipe } from "../src/pipe.ts"

type Delivery = { message: string }
type Receipt = { receipt: string }

const deliver = fx(
  async (_input: Delivery): Promise<EffectOutcome<Receipt>> => ({
    status: "failed",
    error: { code: "not-configured", message: "test executor was not configured" },
  }),
  { title: "Deliver message" },
)

type SenderCommands = { sender: { send: Command<Delivery, object> } }

function withSender<App extends AnyYrdApp & HasEffects>(app: App): ExtendYrdApp<App, object, SenderCommands> {
  const send = op(
    (_state: DeepReadonly<object>, args: Delivery) => ({
      events: [event("sender/accepted", args)],
      effects: [effect(deliver, args, `deliver:${args.message}`)],
    }),
    { title: "Send message" },
  )
  Object.assign(app.commands, { sender: { send } })
  return app as ExtendYrdApp<App, object, SenderCommands>
}

function createEffectsApp(handler?: EffectExecutor<Delivery, Receipt>) {
  return pipe(
    createYrd({ store: createMemoryEventStore() }),
    withEffects(),
    (app) => {
      app.effectRuns.register(["test", "deliver"], deliver, handler)
      return app
    },
    withSender,
  )
}

function transition(app: AnyYrdApp, args: Record<string, unknown>) {
  return app.invoke({ op: "effect.transition", args })
}

describe("durable effects", () => {
  it("composes one writer-owned transition after the effects capability", () => {
    const bare = createYrd({ store: createMemoryEventStore() })
    const app = pipe(bare, withEffects())

    expect(
      app.commandRegistry.entries.map(({ path, command }) => ({
        op: path.join("."),
        visibility: command.metadata.visibility,
      })),
    ).toEqual([{ op: "effect.transition", visibility: "internal" }])

    const compileOnly = (_check: () => void): void => {}
    compileOnly(() => {
      // @ts-expect-error withSender requires withEffects first
      withSender(bare)
    })
    withSender(app)
  })

  it("keeps request, execution, history, and downstream projection on one contract", async () => {
    const executions: string[] = []
    const projected: string[] = []
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      (current) => {
        current.effectRuns.register(["test", "deliver"], deliver, async (input, context) => {
          executions.push(`${input.message}:${(await current.state()).effects.runs[context.id]?.status}`)
          if (input.message === "explode") throw new Error("transport down")
          return { status: "passed", output: { receipt: `ok:${input.message}` } }
        })
        const project = current.project
        current.project = (state, applied) => {
          const next = project(state, applied)
          if (applied.name === "effect/finished") {
            projected.push(next.effects.runs[(applied.data as { id: string }).id]?.status ?? "missing")
          }
          return next
        }
        return current
      },
      withSender,
    )

    const requested = await app.command(app.commands.sender.send, { message: "hello" })
    const id = requested.effectIds[0]!
    expect(executions).toEqual([])
    expect(JSON.parse(JSON.stringify(requested.events[1]?.data))).toEqual({
      id,
      effect: "test.deliver",
      input: { message: "hello" },
      idempotencyKey: "deliver:hello",
    })

    await expect(app.effectRuns.run(id, { executor: "local", leaseMs: 60_000 })).resolves.toMatchObject({
      status: "passed",
      attempt: 1,
      output: { receipt: "ok:hello" },
    })
    expect(executions).toEqual(["hello:running"])
    expect(projected).toEqual(["passed"])
    expect((await Array.fromAsync(app.events())).map(({ name, cause }) => [name, cause.op])).toEqual([
      ["sender/accepted", "sender.send"],
      ["effect/requested", "sender.send"],
      ["effect/started", "effect.transition"],
      ["effect/finished", "effect.transition"],
    ])

    const throwing = await app.command(app.commands.sender.send, { message: "explode" })
    await expect(
      app.effectRuns.run(throwing.effectIds[0]!, { executor: "local", leaseMs: 60_000 }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "executor-error", message: "transport down" },
    })

    const replayed = pipe(
      createYrd({ store: createMemoryEventStore(await Array.fromAsync(app.events())) }),
      withEffects(),
    )
    expect((await replayed.state()).effects).toEqual((await app.state()).effects)

    const defaultApp = createEffectsApp()
    const fallback = await defaultApp.command(defaultApp.commands.sender.send, { message: "default" })
    await expect(
      defaultApp.effectRuns.run(fallback.effectIds[0]!, { executor: "local", leaseMs: 60_000 }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "not-configured" } })
  })

  it("preserves waiting leases, loss, retries, and structured terminal evidence", async () => {
    const app = createEffectsApp(async (input, context) => {
      if (input.message === "remote" || context.attempt === 1) {
        return {
          status: "waiting",
          token: `${input.message}-${context.attempt}`,
          url: `https://ci.invalid/${input.message}`,
          detail: "queued",
          artifacts: [{ kind: "log", uri: `artifact://${input.message}` }],
          checkpoint: { base: "abc" },
        }
      }
      return {
        status: "failed",
        error: { code: "remote-failed", message: "runner rejected work" },
        output: { exitCode: 17, logs: ["compile failed"] },
      }
    })
    const remote = await app.command(app.commands.sender.send, { message: "remote" })
    const remoteId = remote.effectIds[0]!
    await app.effectRuns.run(remoteId, { executor: "remote-host", leaseMs: 1_000, now: () => 0 })
    expect((await app.state()).effects.runs[remoteId]).toMatchObject({
      status: "waiting",
      token: "remote-1",
      checkpoint: { base: "abc" },
    })

    const eventCount = (await Array.fromAsync(app.events())).length
    await expect(
      transition(app, {
        type: "finish",
        id: remoteId,
        attempt: 1,
        token: "wrong",
        outcome: { status: "passed", output: { receipt: "no" } },
      }),
    ).rejects.toThrow("token mismatch")
    expect((await Array.fromAsync(app.events())).length).toBe(eventCount)
    await transition(app, {
      type: "finish",
      id: remoteId,
      attempt: 1,
      token: "remote-1",
      outcome: { status: "passed", output: { receipt: "remote-ok" } },
    })
    expect((await app.state()).effects.runs[remoteId]).toMatchObject({
      status: "passed",
      checkpoint: { base: "abc" },
      output: { receipt: "remote-ok" },
    })

    const crashed = await app.command(app.commands.sender.send, { message: "crash" })
    const crashedId = crashed.effectIds[0]!
    const epoch = Date.parse("2026-01-01T00:00:00.000Z")
    await app.effectRuns.run(crashedId, { executor: "dead-host", leaseMs: 1_000, now: () => epoch })
    await transition(app, {
      type: "heartbeat",
      id: crashedId,
      attempt: 1,
      executor: "dead-host",
      leaseExpiresAt: "2026-01-01T00:00:03.000Z",
    })
    expect(await app.effectRuns.recover({ now: "2026-01-01T00:00:02.000Z" })).toEqual([])
    expect(await app.effectRuns.recover({ now: "2026-01-01T00:00:04.000Z" })).toEqual([crashedId])
    expect((await app.state()).effects.runs[crashedId]).toMatchObject({ status: "lost", attempt: 1 })

    await transition(app, { type: "retry", id: crashedId })
    await app.effectRuns.run(crashedId, { executor: "replacement", leaseMs: 1_000, now: () => epoch + 4_000 })
    expect((await app.state()).effects.runs[crashedId]).toMatchObject({
      status: "failed",
      attempt: 2,
      error: { code: "remote-failed", message: "runner rejected work" },
      output: { exitCode: 17, logs: ["compile failed"] },
    })

    await transition(app, { type: "retry", id: crashedId })
    const retried = (await app.state()).effects.runs[crashedId]!
    expect(retried).toMatchObject({ status: "requested", attempt: 2 })
    expect([retried.executor, retried.output, retried.error]).toEqual([undefined, undefined, undefined])
    await expect(
      transition(app, {
        type: "finish",
        id: crashedId,
        attempt: 1,
        outcome: { status: "passed", output: { receipt: "stale" } },
      }),
    ).rejects.toThrow("attempt 1 is stale; current attempt is 2")
    expect(
      (await Array.fromAsync(app.events()))
        .filter(({ name }) => name.startsWith("effect/") && name !== "effect/requested")
        .every(({ cause }) => cause.op === "effect.transition"),
    ).toBe(true)
  })

  it("renews a running lease without changing attempt identity", async () => {
    let release = () => {}
    let signalStarted = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const started = new Promise<void>((resolve) => (signalStarted = resolve))
    const app = createEffectsApp(async () => {
      signalStarted()
      await gate
      return { status: "passed", output: { receipt: "slow-ok" } }
    })
    const requested = await app.command(app.commands.sender.send, { message: "slow" })
    let now = 0

    vi.useFakeTimers()
    try {
      const running = app.effectRuns.run(requested.effectIds[0]!, {
        executor: "local",
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

    const heartbeats = (await Array.fromAsync(app.events())).filter(({ name }) => name === "effect/heartbeat")
    expect(heartbeats.length).toBeGreaterThanOrEqual(2)
    expect((await app.state()).effects.runs[requested.effectIds[0]!]).toMatchObject({
      status: "passed",
      attempt: 1,
      output: { receipt: "slow-ok" },
    })
  })
})
