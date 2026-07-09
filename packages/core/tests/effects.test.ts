import { describe, expect, it } from "vitest"
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
import { withEffects, type EffectOutcome, type HasEffects } from "../src/effects.ts"
import { pipe } from "../src/pipe.ts"

const deliver = fx(
  async (_input: { message: string }): Promise<EffectOutcome<{ receipt: string }>> => ({
    status: "failed",
    error: { code: "not-configured", message: "test executor was not configured" },
  }),
  { title: "Deliver message" },
)

type SenderCommands = {
  sender: {
    send: Command<{ message: string }, object>
  }
}

function withSender<A extends AnyYrdApp & HasEffects>(app: A): ExtendYrdApp<A, {}, SenderCommands> {
  const send = op(
    (_state: DeepReadonly<object>, args: { message: string }) => ({
      events: [event("sender/accepted", { message: args.message })],
      effects: [effect(deliver, { message: args.message }, `deliver:${args.message}`)],
    }),
    { title: "Send message" },
  )
  Object.assign(app.commands, { sender: { send } })
  return app as ExtendYrdApp<A, {}, SenderCommands>
}

describe("Era2 durable effects", () => {
  it("delegates effect events so later plugins can project completed effect state", async () => {
    let observedStatus: string | undefined
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      (current) => {
        const project = current.project
        current.project = (state, applied) => {
          const projected = project(state, applied)
          if (applied.name === "effect/finished") {
            const id = (applied.data as { id: string }).id
            observedStatus = projected.effects.runs[id]?.status
          }
          return projected
        }
        current.effectRuns.register(["test", "deliver"], deliver, async () => ({
          status: "passed",
          output: { receipt: "observed" },
        }))
        return current
      },
      withSender,
    )

    const submitted = await app.command(app.commands.sender.send, { message: "observe" })
    await app.effectRuns.run(submitted.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
    expect(observedStatus).toBe("passed")
  })

  it("uses the wrapped fx function by default and persists only its JSON descriptor", async () => {
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      (current) => {
        current.effectRuns.register(["test", "deliver"], deliver)
        return current
      },
      withSender,
    )

    const submitted = await app.command(app.commands.sender.send, { message: "default" })
    const requested = submitted.events.find((applied) => applied.name === "effect/requested")
    expect(JSON.parse(JSON.stringify(requested?.data))).toEqual({
      id: submitted.effectIds[0],
      effect: "test.deliver",
      input: { message: "default" },
      idempotencyKey: "deliver:default",
    })

    await app.effectRuns.run(submitted.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
    expect((await app.state()).effects.runs[submitted.effectIds[0]!]).toMatchObject({
      status: "failed",
      error: { code: "not-configured" },
    })
  })

  it("persists domain events and effect requests atomically before executing a handler", async () => {
    const observed: string[] = []
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      (current) => {
        current.effectRuns.register(["test", "deliver"], deliver, async (input) => {
          observed.push(input.message)
          const state = await current.state()
          expect(Object.values(state.effects.runs)).toMatchObject([{ status: "running" }])
          return { status: "passed", output: { receipt: `ok:${input.message}` } }
        })
        return current
      },
      withSender,
    )

    const submitted = await app.command(app.commands.sender.send, { message: "hello" })
    expect(submitted.events.map((applied) => applied.name)).toEqual(["sender/accepted", "effect/requested"])
    expect(observed).toEqual([])
    const effectId = submitted.effectIds[0]!
    expect((await app.state()).effects.runs[effectId]).toMatchObject({
      effect: "test.deliver",
      status: "requested",
      attempt: 0,
      idempotencyKey: "deliver:hello",
    })

    await app.effectRuns.run(effectId, { executor: "local", leaseMs: 60_000 })
    expect(observed).toEqual(["hello"])
    expect((await app.state()).effects.runs[effectId]).toMatchObject({
      status: "passed",
      attempt: 1,
      output: { receipt: "ok:hello" },
    })
  })

  it("parks remote work as waiting and resumes through the same registered finish command", async () => {
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      (current) => {
        current.effectRuns.register(["test", "deliver"], deliver, async () => ({
          status: "waiting",
          token: "remote-1",
          url: "https://ci.invalid/1",
          detail: "queued on linux-arm64",
          artifacts: [{ kind: "runner-log", uri: "artifact://remote-1/log" }],
        }))
        return current
      },
      withSender,
    )
    const submitted = await app.command(app.commands.sender.send, { message: "remote" })
    const id = submitted.effectIds[0]!

    await app.effectRuns.run(id, { executor: "remote", leaseMs: 60_000 })
    expect((await app.state()).effects.runs[id]).toMatchObject({
      status: "waiting",
      attempt: 1,
      token: "remote-1",
      url: "https://ci.invalid/1",
      detail: "queued on linux-arm64",
      artifacts: [{ kind: "runner-log", uri: "artifact://remote-1/log" }],
    })

    await app.command(app.commands.effect.finish, {
      id,
      attempt: 1,
      token: "remote-1",
      outcome: { status: "passed", output: { receipt: "remote-ok" } },
    })
    expect((await app.state()).effects.runs[id]).toMatchObject({ status: "passed", output: { receipt: "remote-ok" } })
  })

  it("marks expired work lost, retries as a new attempt, and rejects stale completion", async () => {
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      (current) => {
        current.effectRuns.register(["test", "deliver"], deliver, async () => ({
          status: "passed",
          output: { receipt: "new-attempt" },
        }))
        return current
      },
      withSender,
    )
    const submitted = await app.command(app.commands.sender.send, { message: "crash" })
    const id = submitted.effectIds[0]!

    await app.command(app.commands.effect.start, {
      id,
      executor: "dead-host",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z",
    })
    expect(await app.effectRuns.recover({ now: "2026-01-01T00:00:02.000Z" })).toEqual([id])
    expect((await app.state()).effects.runs[id]).toMatchObject({ status: "lost", attempt: 1 })

    await app.command(app.commands.effect.retry, { id })
    await app.effectRuns.run(id, { executor: "replacement", leaseMs: 60_000 })
    expect((await app.state()).effects.runs[id]).toMatchObject({ status: "passed", attempt: 2 })

    await expect(
      app.command(app.commands.effect.finish, {
        id,
        attempt: 1,
        outcome: { status: "passed", output: { receipt: "stale" } },
      }),
    ).rejects.toThrow("attempt 1 is stale; current attempt is 2")
  })

  it("lets long-running executors renew their lease without changing attempt identity", async () => {
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      (current) => {
        current.effectRuns.register(["test", "deliver"], deliver, async () => ({
          status: "passed",
          output: { receipt: "unused" },
        }))
        return current
      },
      withSender,
    )
    const submitted = await app.command(app.commands.sender.send, { message: "long" })
    const id = submitted.effectIds[0]!
    await app.command(app.commands.effect.start, {
      id,
      executor: "remote-host",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z",
    })
    await app.command(app.commands.effect.heartbeat, {
      id,
      attempt: 1,
      executor: "remote-host",
      leaseExpiresAt: "2026-01-01T00:00:03.000Z",
    })

    expect(await app.effectRuns.recover({ now: "2026-01-01T00:00:02.000Z" })).toEqual([])
    expect(await app.effectRuns.recover({ now: "2026-01-01T00:00:04.000Z" })).toEqual([id])
  })

  it("enforces effect capability ordering in the type system", () => {
    const bare = createYrd({ store: createMemoryEventStore() })
    const compileOnly = (_check: () => void): void => {}
    compileOnly(() => {
      // @ts-expect-error withSender requires withEffects first
      withSender(bare)
    })
    withSender(pipe(bare, withEffects()))
  })
})
