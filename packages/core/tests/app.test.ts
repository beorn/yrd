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
  type YrdEventStore,
} from "../src/app.ts"
import { pipe } from "../src/pipe.ts"

type CounterState = { value: number }
type CounterCommands = {
  counter: { increment: Command<{ by: number }, { counter: CounterState }> }
}

function withCounter<App extends AnyYrdApp>(app: App): ExtendYrdApp<App, { counter: CounterState }, CounterCommands> {
  Object.assign(app.initialState, { counter: { value: 0 } })
  const increment = op(
    (_state: DeepReadonly<{ counter: CounterState }>, args: { by: number }) => ({
      events: [event("counter/incremented", args)],
      effects: [],
    }),
    {
      args: {
        parse(input) {
          const by = (input as { by?: unknown } | undefined)?.by
          if (typeof by !== "number" || !Number.isInteger(by) || by < 1) {
            throw new Error("by must be a positive integer")
          }
          return { by }
        },
      },
    },
  )
  Object.assign(app.commands, { counter: { increment } })

  const project = app.project
  app.project = (state, applied) => {
    const projected = project(state, applied)
    if (applied.name !== "counter/incremented") return projected
    const current = (projected as { counter: CounterState }).counter
    return { ...projected, counter: { value: current.value + (applied.data as { by: number }).by } }
  }
  return app as ExtendYrdApp<App, { counter: CounterState }, CounterCommands>
}

function counterApp(store: YrdEventStore = createMemoryEventStore()) {
  return pipe(createYrd({ store }), withCounter)
}

describe("Era2 Yrd app", () => {
  it("threads typed plugin capabilities through pipe", () => {
    const seed = createYrd({ store: createMemoryEventStore() })
    const app = pipe(seed, withCounter)
    const built = pipe(createYrd({ store: createMemoryEventStore() }), withCounter, (current) => {
      current.initialState.counter.value = 1
      return current
    })

    const command: Command<{ by: number }, { counter: CounterState }> = app.commands.counter.increment
    const state: { counter: CounterState } = app.initialState
    // @ts-expect-error createYrd() has no counter state before composition
    const missing: { counter: CounterState } = createYrd({ store: createMemoryEventStore() }).initialState

    expect(app).toBe(seed)
    expect(command).toBe(app.commands.counter.increment)
    expect(state.counter.value).toBe(0)
    expect(built.initialState.counter.value).toBe(1)
    void missing
  })

  it("routes serialized command refs through apply and folds their events into state", async () => {
    const app = counterApp()
    const increment = app.commands.counter.increment
    const apply = app.apply
    let appliedOperation: unknown
    app.apply = (state, invocation) => {
      appliedOperation = invocation.operation
      return apply(state, invocation)
    }

    expect(app.commandRegistry.pathOf(increment)).toEqual(["counter", "increment"])
    expect(app.commandRegistry.commandAt("counter.increment")).toBe(increment)
    expect(app.commandRegistry.entries().map(({ path }) => path.join("."))).toEqual(["counter.increment"])

    await app.command(increment, { by: 2 })
    const serialized = app.operation(increment, { by: 3 })
    expect(serialized).toEqual({ op: "counter.increment", args: { by: 3 } })
    await app.invoke(JSON.parse(JSON.stringify(serialized)))

    expect(appliedOperation).toEqual(serialized)
    expect((await app.state()).counter.value).toBe(5)
  })

  it("rejects invalid serialized operations before they reach the journal", async () => {
    const app = counterApp()
    await expect(app.invoke({ op: "counter.increment", args: { by: "2" } })).rejects.toThrow(
      "by must be a positive integer",
    )
    await expect(app.invoke({ op: "counter.missing", args: {} })).rejects.toThrow("unknown command 'counter.missing'")
    expect(() => app.operation(app.commands.counter.increment, { by: (() => 2) as unknown as number })).toThrow(
      "operation value '$.by' is not JSON data",
    )

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(app.invoke({ op: "counter.increment", args: cyclic })).rejects.toThrow(
      "operation value '$.self' is cyclic",
    )
    expect((await app.state()).counter.value).toBe(0)
  })

  it("rebuilds state solely by folding the journal", async () => {
    const store = createMemoryEventStore()
    const first = counterApp(store)
    await first.command(first.commands.counter.increment, { by: 4 })

    const replayed = counterApp(store)
    expect(await replayed.state()).toEqual(await first.state())
    expect("store" in first).toBe(false)
    expect(await Array.fromAsync(first.events())).toHaveLength(1)
  })

  it("freezes folded state before applying an operation", async () => {
    const app = counterApp()
    const mutate = op((state: DeepReadonly<{ counter: CounterState }>, _args: undefined) => {
      ;(state as { counter: CounterState }).counter.value++
      return { events: [], effects: [] }
    })
    Object.assign(app.commands.counter, { mutate })

    await expect(app.command(mutate, undefined)).rejects.toThrow(/read only|readonly|frozen/i)
    expect((await app.state()).counter.value).toBe(0)
  })

  it("rejects duplicate command paths during composition", () => {
    const app = counterApp()
    const duplicate = op((_state: DeepReadonly<{ counter: CounterState }>, _args: undefined) => ({
      events: [],
      effects: [],
    }))
    expect(() => Object.assign(app.commands.counter, { increment: duplicate })).toThrow(
      "command 'counter.increment' is already registered",
    )
  })
})
