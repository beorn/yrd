import { describe, expect, it } from "vitest"
import {
  createMemoryEventStore,
  createYrd,
  event,
  op,
  type AnyYrdApp,
  type Command,
  type DeepReadonly,
  type ExtendYrdApp,
} from "../src/app.ts"
import { pipe } from "../src/pipe.ts"

type CounterState = { value: number }
type CounterCommands = {
  counter: {
    increment: Command<{ by: number }, { counter: CounterState }>
  }
}

type SequenceCommands = {
  sequence: {
    allocate: Command<undefined, { sequence: { issued: number[] } }>
  }
}

function withCounter<A extends AnyYrdApp>(app: A): ExtendYrdApp<A, { counter: CounterState }, CounterCommands> {
  Object.assign(app.initialState, { counter: { value: 0 } })
  const increment = op(
    (_state: DeepReadonly<{ counter: CounterState }>, args: { by: number }) => ({
      events: [event("counter/incremented", { by: args.by })],
      effects: [],
    }),
    {
      title: "Increment counter",
      description: "Add a positive amount to the counter",
      args: {
        parse(input) {
          const by = (input as { by?: unknown } | undefined)?.by
          if (typeof by !== "number" || !Number.isInteger(by) || by < 1)
            throw new Error("by must be a positive integer")
          return { by }
        },
      },
    },
  )
  Object.assign(app.commands, { counter: { increment } })

  const project = app.project
  app.project = (state, applied) => {
    if (applied.name !== "counter/incremented") return project(state, applied)
    const data = applied.data as { by: number }
    const current = (state as { counter: CounterState }).counter
    return { ...state, counter: { value: current.value + data.by } }
  }

  return app as ExtendYrdApp<A, { counter: CounterState }, CounterCommands>
}

function withCounterReset<A extends AnyYrdApp & { initialState: { counter: CounterState } }>(app: A): A {
  return app
}

function withSequence<A extends AnyYrdApp>(
  app: A,
): ExtendYrdApp<A, { sequence: { issued: number[] } }, SequenceCommands> {
  Object.assign(app.initialState, { sequence: { issued: [] } })
  const allocate = op(
    (state: DeepReadonly<{ sequence: { issued: number[] } }>, _args: undefined) => ({
      events: [event("sequence/allocated", { number: state.sequence.issued.length + 1 })],
      effects: [],
    }),
    { title: "Allocate sequence number" },
  )
  Object.assign(app.commands, { sequence: { allocate } })
  const project = app.project
  app.project = (state, applied) => {
    if (applied.name !== "sequence/allocated") return project(state, applied)
    const current = (state as { sequence: { issued: number[] } }).sequence
    return {
      ...state,
      sequence: { issued: [...current.issued, (applied.data as { number: number }).number] },
    }
  }
  return app as ExtendYrdApp<A, { sequence: { issued: number[] } }, SequenceCommands>
}

describe("Era2 Yrd app", () => {
  it("composes plugins in place and infers added state and command namespaces", async () => {
    const store = createMemoryEventStore()
    const seed = createYrd({ store, clock: () => "2026-01-01T00:00:00.000Z", idGen: () => "id" })
    const app = pipe(seed, withCounter)

    expect(app).toBe(seed)
    const command: Command<{ by: number }, { counter: CounterState }> = app.commands.counter.increment
    const value: number = (await app.state()).counter.value
    expect(command).toBe(app.commands.counter.increment)
    expect(value).toBe(0)

    // Ordering is structural: plugins that require counter state cannot be
    // composed before withCounter has added that capability.
    // @ts-expect-error createYrd() has no counter state yet
    withCounterReset(createYrd({ store: createMemoryEventStore() }))
    withCounterReset(app)
  })

  it("uses object command refs in process and one flat registry at serialization boundaries", async () => {
    const app = pipe(createYrd({ store: createMemoryEventStore() }), withCounter)
    const increment = app.commands.counter.increment

    expect(app.commandRegistry.pathOf(increment)).toEqual(["counter", "increment"])
    expect(app.commandRegistry.commandAt("counter.increment")).toBe(increment)
    expect(app.commandRegistry.entries().map((entry) => entry.path.join("."))).toEqual(["counter.increment"])

    await app.command(increment, { by: 2 })
    const serialized = app.operation(increment, { by: 3 })
    expect(serialized).toEqual({ op: "counter.increment", args: { by: 3 } })
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized)
    await app.invoke(JSON.parse(JSON.stringify(serialized)))
    expect((await app.state()).counter).toEqual({ value: 5 })
  })

  it("shares boundary argument validation across serialized command surfaces", async () => {
    const app = pipe(createYrd({ store: createMemoryEventStore() }), withCounter)

    await expect(app.invoke({ op: "counter.increment", args: { by: "2" } })).rejects.toThrow(
      "by must be a positive integer",
    )
    await expect(app.invoke({ op: "counter.missing", args: {} })).rejects.toThrow("unknown command 'counter.missing'")
    expect((await app.state()).counter.value).toBe(0)
  })

  it("refuses operation arguments that JSON would silently discard", async () => {
    const app = pipe(createYrd({ store: createMemoryEventStore() }), withCounter)
    expect(() => app.operation(app.commands.counter.increment, { by: (() => 2) as unknown as number })).toThrow(
      "operation value '$.by' is not JSON data",
    )

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(app.invoke({ op: "counter.increment", args: cyclic })).rejects.toThrow(
      "operation value '$.self' is cyclic",
    )
  })

  it("makes state a pure journal fold and keeps append authority out of the app surface", async () => {
    const store = createMemoryEventStore()
    const first = pipe(
      createYrd({
        store,
        idGen: (() => {
          let id = 0
          return () => `id-${++id}`
        })(),
      }),
      withCounter,
    )
    await first.command(first.commands.counter.increment, { by: 4 })

    const replayed = pipe(createYrd({ store }), withCounter)
    expect(await replayed.state()).toEqual(await first.state())
    expect("store" in first).toBe(false)
    const events = []
    for await (const applied of first.events()) events.push(applied)
    expect(events).toHaveLength(1)
  })

  it("rejects reducers that mutate folded state even through an unsafe cast", async () => {
    const app = pipe(createYrd({ store: createMemoryEventStore() }), withCounter)
    const mutate = op(
      (state: DeepReadonly<{ counter: CounterState }>, _args: undefined) => {
        ;(state as { counter: CounterState }).counter.value += 100
        return { events: [], effects: [] }
      },
      { title: "Mutate counter" },
    )
    Object.assign(app.commands.counter, { mutate })

    await expect(app.command(mutate, undefined)).rejects.toThrow(/read only|readonly|frozen/i)
    expect((await app.state()).counter.value).toBe(0)
  })

  it("rejects duplicate serialization paths before a surface can become ambiguous", () => {
    const app = pipe(createYrd({ store: createMemoryEventStore() }), withCounter)
    const duplicate = op((_state: DeepReadonly<{ counter: CounterState }>, _args: undefined) => ({
      events: [],
      effects: [],
    }))
    expect(() => Object.assign(app.commands.counter, { increment: duplicate })).toThrow(
      "command 'counter.increment' is already registered",
    )
  })

  it("serializes state -> apply -> append while leaving effects outside the writer", async () => {
    const app = pipe(createYrd({ store: createMemoryEventStore() }), withSequence)
    await Promise.all(Array.from({ length: 20 }, () => app.command(app.commands.sequence.allocate, undefined)))
    expect((await app.state()).sequence.issued).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
  })
})
