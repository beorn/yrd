/**
 * @failure Core composition, command identity, event validation, or reactive projection violates journal authority.
 * @level l1
 * @consumer @yrd/core
 */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createScope } from "@silvery/scope"
import { createLogger, type Event as LogEvent } from "loggily"
import * as Core from "@yrd/core"
import {
  command,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  event,
  type CommandTree,
  type Journal,
  type YrdDef,
} from "@yrd/core"

type CounterState = { counter: { value: number } }

type StoredCheckpoint = Readonly<{ identity: string; cursor: number; value: unknown }>

let idSequence = 0
function ids(..._labels: string[]) {
  return () => `00000000-0000-7000-8000-${(++idSequence).toString(16).padStart(12, "0")}`
}

function withCounter() {
  const add = command({
    title: "Add to counter",
    visibility: "public",
    params: z.object({ by: z.number().int() }),
    apply: (state: CounterState, args: { by: number }) => ({
      events: [event("counter/changed", { from: state.counter.value, by: args.by })],
      value: { value: state.counter.value + args.by },
    }),
  })

  return <State extends object, Commands extends CommandTree, Features extends object>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { counter: { value: 0 } },
      commands: { counter: { add } },
      events: {
        "counter/changed": z.object({ from: z.number().int(), by: z.number().int() }),
      },
      project(state, applied) {
        if (applied.name !== "counter/changed") return { counter: state.counter }
        const { by } = applied.data as { by: number }
        return { counter: { value: state.counter.value + by } }
      },
      create(yrd) {
        return {
          counter: {
            value() {
              return yrd.state().counter.value
            },
          },
        }
      },
    })
}

function createCheckpointJournal(base: Journal<unknown>) {
  const reads: number[] = []
  let stored: StoredCheckpoint | undefined
  const journal = {
    read(after = 0, before?: number) {
      reads.push(after)
      return base.read(after, before)
    },
    append: (value: unknown, expectedCursor: number) => base.append(value, expectedCursor),
    checkpoint: {
      load(identity: string) {
        return Promise.resolve(stored?.identity === identity ? structuredClone(stored) : undefined)
      },
      save(checkpoint: StoredCheckpoint) {
        stored = structuredClone(checkpoint)
        return Promise.resolve(true)
      },
    },
  } as Journal<unknown>

  return {
    journal,
    reads,
    stored: () => stored,
    corrupt() {
      if (stored === undefined) throw new Error("expected a stored projection checkpoint")
      stored = { ...stored, value: { v: 999, state: null } }
    },
  }
}

describe("Yrd domain objects", () => {
  it("exposes one dispatch surface and returns commands instead of storage frames", async () => {
    const app = await createYrd(withCounter()(createYrdDef()), {
      inject: { journal: createMemoryJournal(), clock: () => "2026-07-09T12:00:00.000Z" },
    })

    expect(Core).not.toHaveProperty("Operation")
    expect(Core).not.toHaveProperty("Frame")
    expect(app).toHaveProperty("dispatch")
    expect(app).not.toHaveProperty("operation")
    expect(app).not.toHaveProperty("command")
    expect(app).not.toHaveProperty("invoke")

    const publicResult = await app.dispatch({ op: "counter.add", args: { by: 2 } })
    expect(publicResult).toMatchObject({
      command: { op: "counter.add", args: { by: 2 } },
      events: [{ name: "counter/changed", data: { from: 0, by: 2 } }],
      value: { value: 2 },
    })
    expect(publicResult.command.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(publicResult.events[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(publicResult).not.toHaveProperty("cause")

    const trustedResult = await app.dispatch(app.commands.counter.add, { by: 1 })
    expect(trustedResult.command).toMatchObject({ op: "counter.add", args: { by: 1 } })
    expect(app.state().counter.value).toBe(3)

    // @ts-expect-error The three legacy runtime surfaces are intentionally absent.
    void app.command
    // @ts-expect-error The three legacy runtime surfaces are intentionally absent.
    void app.operation
    // @ts-expect-error The three legacy runtime surfaces are intentionally absent.
    void app.invoke
    await app.close()
  })

  it("composes immutable definitions into methodful plain objects", async () => {
    const base = createYrdDef()
    const definition = withCounter()(base)

    expect(base.initialState).toEqual({})
    expect(definition.initialState).toEqual({ counter: { value: 0 } })

    const app = await createYrd(definition, {
      inject: {
        journal: createMemoryJournal(),
        clock: () => "2026-07-09T12:00:00.000Z",
        id: ids("command-1", "event-1"),
      },
    })

    expect(Object.getPrototypeOf(app)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(app.counter)).toBe(Object.prototype)
    expect(app.counter.value()).toBe(0)

    await app.dispatch(app.commands.counter.add, { by: 3 })

    expect(app.counter.value()).toBe(3)
    expect(app.state().counter.value).toBe(3)
    await app.close()
  })

  it("replays before exposing state and refreshes ordinary reads", async () => {
    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    const journal = createMemoryJournal()
    const definition = withCounter()(createYrdDef())
    const writer = await createYrd(definition, {
      inject: {
        journal,
        clock: () => "2026-07-09T12:00:00.000Z",
        id: ids("writer-command", "writer-event"),
      },
    })

    await writer.dispatch(writer.commands.counter.add, { by: 4 })

    const reader = await createYrd(definition, {
      inject: {
        journal,
        log,
        clock: () => "2026-07-09T12:00:00.000Z",
        id: ids("reader-command", "reader-event"),
      },
    })
    expect(reader.state().counter.value).toBe(4)
    expect(events.find((event) => event.kind === "span" && event.namespace === "test:core:replay")).toMatchObject({
      props: { frames: 1, events: 1, fromCursor: 0, toCursor: 1 },
    })

    await writer.dispatch(writer.commands.counter.add, { by: 2 })
    expect(reader.state().counter.value).toBe(4)
    expect((await reader.refresh()).counter.value).toBe(6)
    expect(reader.state().counter.value).toBe(6)

    await Promise.all([writer.close(), reader.close()])
  })

  it("captures projected state and its journal cursor as one immutable snapshot", async () => {
    await using app = await createYrd(withCounter()(createYrdDef()), {
      inject: {
        journal: createMemoryJournal(),
        clock: () => "2026-07-09T12:00:00.000Z",
        id: ids("snapshot-command-1", "snapshot-event-1", "snapshot-command-2", "snapshot-event-2"),
      },
    })

    expect(await app.journalSnapshot()).toEqual({ state: { counter: { value: 0 } }, asOf: { cursor: 0 } })
    await app.dispatch(app.commands.counter.add, { by: 1 })
    const first = await app.journalSnapshot()
    await app.dispatch(app.commands.counter.add, { by: 1 })
    const second = await app.journalSnapshot()

    expect(first).toEqual({
      state: { counter: { value: 1 } },
      asOf: { cursor: 1, at: "2026-07-09T12:00:00.000Z" },
    })
    expect(second).toEqual({
      state: { counter: { value: 2 } },
      asOf: { cursor: 2, at: "2026-07-09T12:00:00.000Z" },
    })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.state)).toBe(true)
    expect(Object.isFrozen(first.asOf)).toBe(true)
  })

  it("restores projection registries and folds only journal frames after the checkpoint cursor", async () => {
    const backing = createMemoryJournal<unknown>()
    const cache = createCheckpointJournal(backing)
    const definition = withCounter()(createYrdDef())
    const first = await createYrd(definition, {
      inject: { journal: cache.journal, id: ids("first-command", "first-event") },
    })
    const receipt = await first.dispatch({ op: "counter.add", args: { by: 1 } }, { key: "stable-retry" })
    await first.close()

    const saved = cache.stored()
    expect(saved).toMatchObject({ cursor: 1, value: { v: 1 } })

    await using tailWriter = await createYrd(definition, {
      inject: { journal: backing, id: ids("tail-command", "tail-event") },
    })
    await tailWriter.dispatch({ op: "counter.add", args: { by: 2 } })
    await tailWriter.close()

    cache.reads.length = 0
    await using warm = await createYrd(definition, {
      inject: { journal: cache.journal, id: ids("retry-command", "retry-cause") },
    })

    expect(cache.reads[0]).toBe(saved?.cursor)
    expect(warm.state().counter.value).toBe(3)
    await expect(warm.dispatch({ op: "counter.add", args: { by: 1 } }, { key: "stable-retry" })).resolves.toEqual(
      receipt,
    )
    expect(warm.state().counter.value).toBe(3)
  })

  it("warns once, full-replays, and rewrites a corrupt projection checkpoint", async () => {
    const backing = createMemoryJournal<unknown>()
    const cache = createCheckpointJournal(backing)
    const definition = withCounter()(createYrdDef())
    const writer = await createYrd(definition, {
      inject: { journal: cache.journal, id: ids("writer-command", "writer-event") },
    })
    await writer.dispatch({ op: "counter.add", args: { by: 4 } }, { key: "preserved-retry" })
    await writer.close()
    cache.corrupt()
    cache.reads.length = 0

    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    await using recovered = await createYrd(definition, { inject: { journal: cache.journal, log } })

    expect(cache.reads[0]).toBe(0)
    expect(recovered.state().counter.value).toBe(4)
    expect(cache.stored()).toMatchObject({ cursor: 1, value: { v: 1 } })
    expect(events.filter((entry) => JSON.stringify(entry).includes("projection checkpoint"))).toHaveLength(1)
    await expect(
      recovered.dispatch({ op: "counter.add", args: { by: 4 } }, { key: "preserved-retry" }),
    ).resolves.toMatchObject({ events: [{ name: "counter/changed" }] })
    expect(recovered.state().counter.value).toBe(4)
  })

  it("allows legacy payloads only while replaying and never widens current appends", async () => {
    type FactState = { facts: { total: number } }
    const journal = createMemoryJournal()
    const record = command({
      title: "Record fact",
      visibility: "public",
      params: z.object({ value: z.number().int(), identity: z.string().optional() }).strict(),
      apply: (_state: FactState, args: { value: number; identity?: string }) => ({
        events: [event("fact/recorded", args)],
      }),
    })
    const projectFact = (state: FactState, applied: Core.Event) => ({
      facts: {
        total:
          state.facts.total +
          (applied.name === "fact/recorded" ? (applied.data as Readonly<{ value: number }>).value : 0),
      },
    })
    const legacy = createYrdDef().extend({
      initialState: { facts: { total: 0 } },
      commands: { fact: { record } },
      events: { "fact/recorded": z.object({ value: z.number().int() }).strict() },
      project: projectFact,
    })

    await using writer = await createYrd(legacy, {
      inject: { journal, id: ids("legacy-command", "legacy-event") },
    })
    await writer.dispatch(writer.commands.fact.record, { value: 2 })
    await writer.close()

    const current = createYrdDef().extend({
      initialState: { facts: { total: 0 } },
      commands: { fact: { record } },
      events: {
        "fact/recorded": z.object({ value: z.number().int(), identity: z.string().min(1) }).strict(),
      },
      replayEvents: { "fact/recorded": z.object({ value: z.number().int() }).strict() },
      project: projectFact,
    })

    const strictOnly = createYrdDef().extend({
      initialState: { facts: { total: 0 } },
      commands: { fact: { record } },
      events: {
        "fact/recorded": z.object({ value: z.number().int(), identity: z.string().min(1) }).strict(),
      },
      project: projectFact,
    })
    await expect(createYrd(strictOnly, { inject: { journal } })).rejects.toThrow()

    await using reader = await createYrd(current, {
      inject: { journal, id: ids("current-command", "current-event") },
    })
    expect(reader.state().facts.total).toBe(2)
    await expect(reader.dispatch(reader.commands.fact.record, { value: 3 })).rejects.toThrow()
    expect(reader.state().facts.total).toBe(2)
    await reader.dispatch(reader.commands.fact.record, { value: 3, identity: "current-v1" })
    expect(reader.state().facts.total).toBe(5)
  })

  it("retries cursor conflicts without losing concurrent commands", async () => {
    const journal = createMemoryJournal()
    const definition = withCounter()(createYrdDef())
    const appA = await createYrd(definition, {
      inject: {
        journal,
        clock: () => "2026-07-09T12:00:00.000Z",
        id: ids("a-command", "a-event", "a-retry-event"),
      },
    })
    const appB = await createYrd(definition, {
      inject: {
        journal,
        clock: () => "2026-07-09T12:00:00.000Z",
        id: ids("b-command", "b-event", "b-retry-event"),
      },
    })

    await Promise.all([
      appA.dispatch(appA.commands.counter.add, { by: 1 }),
      appB.dispatch(appB.commands.counter.add, { by: 1 }),
    ])

    await Promise.all([appA.refresh(), appB.refresh()])
    expect(appA.state().counter.value).toBe(2)
    expect(appB.state().counter.value).toBe(2)
    await Promise.all([appA.close(), appB.close()])
  })

  it("deduplicates command retries and validates params and event payloads", async () => {
    const definition = withCounter()(createYrdDef())
    const app = await createYrd(definition, {
      inject: {
        journal: createMemoryJournal(),
        clock: () => "2026-07-09T12:00:00.000Z",
        id: ids("generated-command", "event-1", "event-2"),
      },
    })

    const first = await app.dispatch({ op: "counter.add", args: { by: 2 } }, { key: "stable-command" })
    const retried = await app.dispatch({ op: "counter.add", args: { by: 2 } }, { key: "stable-command" })

    expect(retried).toEqual(first)
    expect(app.state().counter.value).toBe(2)
    await expect(app.dispatch({ op: "counter.add", args: { by: 3 } }, { key: "stable-command" })).rejects.toThrow(
      "different command",
    )
    await expect(app.dispatch({ op: "counter.add", args: { by: 1.5 } })).rejects.toThrow()
    await expect(app.dispatch({ op: "missing.command" })).rejects.toThrow("unknown command")

    await app.close()
  })

  it("uses caller-supplied UUIDv7 command ids as public retry identities", async () => {
    const app = await createYrd(withCounter()(createYrdDef()), {
      inject: { journal: createMemoryJournal(), clock: () => "2026-07-09T12:00:00.000Z" },
    })
    const id = "00000000-0000-7000-8000-000000000001"

    const first = await app.dispatch({ id, op: "counter.add", args: { by: 2 } })
    await expect(app.dispatch({ id, op: "counter.add", args: { by: 2 } })).resolves.toEqual(first)
    await expect(app.dispatch({ id, op: "counter.add", args: { by: 3 } })).rejects.toThrow("different command")
    await expect(app.dispatch({ id: "not-a-uuid", op: "counter.add", args: { by: 1 } })).rejects.toThrow()
    expect(app.state().counter.value).toBe(2)

    await app.close()
  })

  it("validates projections before append", async () => {
    const journal = createMemoryJournal()
    const definition = withCounter()(createYrdDef()).extend({
      initialState: { guard: {} },
      commands: {},
      project(state, applied) {
        if (applied.name === "counter/changed") throw new Error("projection refused")
        return { guard: state.guard }
      },
    })
    const app = await createYrd(definition, {
      inject: {
        journal,
        clock: () => "2026-07-09T12:00:00.000Z",
        id: ids("command", "event"),
      },
    })

    await expect(app.dispatch(app.commands.counter.add, { by: 1 })).rejects.toThrow("projection refused")
    expect(await Array.fromAsync(journal.read())).toEqual([])
    await app.close()
  })

  it("preserves owned state slices and publishes deeply frozen snapshots", async () => {
    let projectedKeys: string[] = []
    const definition = withCounter()(createYrdDef()).extend({
      initialState: { flag: { seen: false } },
      project(state, applied) {
        projectedKeys = Object.keys(state)
        return { flag: { seen: state.flag.seen || applied.name === "counter/changed" } }
      },
    })
    const app = await createYrd(definition, {
      inject: {
        journal: createMemoryJournal(),
        clock: () => "2026-07-09T12:00:00.000Z",
        id: ids("command", "event"),
      },
    })

    await app.dispatch(app.commands.counter.add, { by: 2 })

    const state = app.state()
    expect(state).toEqual({ counter: { value: 2 }, flag: { seen: true } })
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.counter)).toBe(true)
    expect(Reflect.set(state.counter, "value", 99)).toBe(false)
    expect(app.state().counter.value).toBe(2)
    expect(projectedKeys).toEqual(["flag"])
    await app.close()
  })

  it("returns an existing receipt before re-evaluating current availability", async () => {
    const close = command({
      title: "Close gate",
      visibility: "public",
      isAvailable: ({ state }: { state: { gate: { open: boolean } } }) => state.gate.open,
      apply: () => ({ events: [event("gate/closed", {})] }),
    })
    const definition = createYrdDef().extend({
      initialState: { gate: { open: true } },
      commands: { gate: { close } },
      events: { "gate/closed": z.object({}) },
      project(state, applied) {
        return { gate: { open: applied.name === "gate/closed" ? false : state.gate.open } }
      },
    })
    const app = await createYrd(definition, {
      inject: { journal: createMemoryJournal(), id: ids("generated-command", "event") },
    })

    const first = await app.dispatch({ op: "gate.close" }, { key: "same-command" })
    expect(app.state().gate.open).toBe(false)
    await expect(app.dispatch({ op: "gate.close" }, { key: "same-command" })).resolves.toEqual(first)
    await expect(app.dispatch({ op: "gate.close" }, { key: "new-command" })).rejects.toThrow("unavailable")
    await app.close()
  })

  it("rejects feature collisions and disposes a failed construction", async () => {
    let disposed = false
    const definition = createYrdDef().extend({
      create(yrd) {
        yrd.scope.defer(() => {
          disposed = true
        })
        return { state: "collision" }
      },
    })

    await expect(createYrd(definition, { inject: { journal: createMemoryJournal() } })).rejects.toThrow(
      "duplicate feature 'state'",
    )
    expect(disposed).toBe(true)

    const duplicate = createYrdDef()
      .extend({ create: () => ({ counter: { first: true } }) })
      .extend({ create: () => ({ counter: { second: true } }) })
    await expect(createYrd(duplicate, { inject: { journal: createMemoryJournal() } })).rejects.toThrow(
      "duplicate feature 'counter'",
    )
  })

  it("disposes its Scope when initial journal replay fails", async () => {
    const parent = createScope("test-parent")
    const runtime = createScope("test-runtime")
    parent.child = () => runtime
    const journal: Journal<unknown> = {
      async *read() {
        yield* []
        throw new Error("injected replay failure")
      },
      async append() {
        throw new Error("unexpected append")
      },
    }

    await expect(createYrd(createYrdDef(), { inject: { journal, scope: parent } })).rejects.toThrow(
      "injected replay failure",
    )
    expect(runtime.signal.aborted).toBe(true)
    await parent[Symbol.asyncDispose]()
  })

  it("records eventless commands while keeping internal commands off the public boundary", async () => {
    const noop = command({ title: "Internal no-op", apply: () => ({ events: [] }) })
    const definition = createYrdDef().extend({
      initialState: { noop: {} },
      commands: { internal: { noop } },
      project: (state) => state,
    })
    const journal = createMemoryJournal()
    const app = await createYrd(definition, {
      inject: { journal, id: ids("eventless-command") },
    })

    await expect(app.dispatch({ op: "internal.noop" })).rejects.toThrow("not publicly available")
    const first = await app.dispatch(app.commands.internal.noop, undefined, { key: "eventless" })
    const retry = await app.dispatch(app.commands.internal.noop, undefined, { key: "eventless" })
    expect(first.events).toEqual([])
    expect(retry).toEqual(first)
    expect((await Array.fromAsync(journal.read()))[0]?.values).toHaveLength(1)
    await app.close()
  })

  it("rejects duplicate command paths and unknown replayed events", async () => {
    const noop = command({ title: "No-op", apply: () => ({ events: [] }) })
    const once = createYrdDef().extend({
      initialState: { once: {} },
      commands: { duplicate: { noop } },
      project: (state) => ({ once: state.once }),
    })
    expect(() =>
      once.extend({
        initialState: { twice: {} },
        commands: { duplicate: { noop: command({ title: "Again", apply: () => ({ events: [] }) }) } },
        project: (state) => ({ twice: state.twice }),
      }),
    ).toThrow("duplicate command 'duplicate.noop'")

    const corruptCommandId = ids()()
    const corrupt = {
      cause: {
        id: ids()(),
        commandId: corruptCommandId,
        op: "corrupt",
        commandHash: "0".repeat(64),
      },
      command: { id: corruptCommandId, op: "corrupt" },
      events: [],
    }
    await expect(createYrd(createYrdDef(), { inject: { journal: createMemoryJournal([corrupt]) } })).rejects.toThrow(
      "command hash",
    )

    const unknownCommandId = ids()()
    const unknown = {
      cause: {
        id: ids()(),
        commandId: unknownCommandId,
        op: "unknown",
        commandHash: Core.Command.hash({ op: "unknown" }),
      },
      command: { id: unknownCommandId, op: "unknown" },
      events: [
        {
          id: ids()(),
          name: "unknown/event",
          ts: "2026-07-09T12:00:00.000Z",
          data: {},
        },
      ],
    }
    await expect(createYrd(createYrdDef(), { inject: { journal: createMemoryJournal([unknown]) } })).rejects.toThrow(
      "no event definition",
    )
  })
})

describe("entity selector resolution", () => {
  const candidates: readonly Core.SelectorCandidate<{ readonly id: string }>[] = [
    { canonical: "PR13", aliases: ["Topic/Alpha", "B13"], value: { id: "PR13" } },
    { canonical: "PR14", aliases: ["Topic/Beta", "B14"], value: { id: "PR14" } },
  ]

  it.each([
    ["PR13", "PR13"],
    ["pr13", "PR13"],
    ["TOPIC/ALPHA", "PR13"],
    ["b14", "PR14"],
    ["missing", undefined],
  ])("resolves %s without changing canonical identity", (selector, expected) => {
    expect(Core.resolveSelector(selector, candidates, { kind: "PR" })?.id).toBe(expected)
  })

  it("prefers an exact canonical identity and rejects an ambiguous folded selector", () => {
    const colliding: readonly Core.SelectorCandidate<{ readonly id: string }>[] = [
      { canonical: "PR13", aliases: ["topic/one"], value: { id: "PR13" } },
      { canonical: "PR14", aliases: ["pr13", "PR13"], value: { id: "PR14" } },
    ]

    expect(Core.resolveSelector("PR13", colliding, { kind: "PR" })?.id).toBe("PR13")

    try {
      Core.resolveSelector("Pr13", colliding, { kind: "PR" })
      throw new Error("expected folded selector ambiguity")
    } catch (error) {
      expect(Core.failureFact(error)).toEqual({
        kind: "refusal",
        code: "selector-ambiguous",
        message: "yrd: PR selector 'Pr13' is ambiguous: PR13, PR14",
      })
    }
  })
})

describe("Memory Journal", () => {
  it("is a passable cursor-CAS object", async () => {
    const journal = createMemoryJournal([1, 2])

    expect(await Array.fromAsync(journal.read())).toEqual([{ cursor: 2, values: [1, 2] }])
    await expect(journal.append(3, 1)).resolves.toEqual({ appended: false, cursor: 2 })
    await expect(journal.append(3, 2)).resolves.toEqual({ appended: true, cursor: 3 })
    expect(await Array.fromAsync(journal.read(2))).toEqual([{ cursor: 3, values: [3] }])
  })
})
