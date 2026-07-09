import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createGitbay, createJsonlJournal, definePlugin, makeEvent, pipe } from "../src/index.ts"
import type { BayEvent, BayRuntime, BayStore, Cause } from "../src/index.ts"

// Fixed fake clock — every event gets the same timestamp; determinism comes
// from journal append order (core.ts dispatch is journal-first), never from
// wall-clock time. Matches the "opts.clock — never Date.now() in core" rule.
const CLOCK = () => "2024-01-01T00:00:00.000Z"

// A tiny deterministic id source for these generic-core tests — they exercise
// the pluggable layer mechanism itself (not gitbay's own vocabulary), so they
// build events by hand rather than through makeEvent()/a bay closure.
let idSeq = 0
function event(name: string, data: BayEvent["data"], cause: Cause): BayEvent {
  idSeq++
  return { id: `e${idSeq}`, ts: CLOCK(), name, cause, data }
}

async function tmpJournalPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-core-"))
  return join(dir, "journal.jsonl")
}

function openStore(path: string): BayStore {
  return { journal: createJsonlJournal(path), close: async () => {} }
}

describe("createGitbay — zero-plugin core", () => {
  it("state() folds to the empty shape with no layers registered", async () => {
    const bay = createGitbay({ store: openStore(await tmpJournalPath()), clock: CLOCK })
    expect(await bay.state()).toEqual({ leases: {}, prs: {}, slices: {} })
  })

  it("dispatching an unregistered verb throws, naming the command and the registered layers", async () => {
    const bay = createGitbay({ store: openStore(await tmpJournalPath()), clock: CLOCK })
    bay.use({ name: "foo" })
    bay.use({ name: "bar" })
    await expect(bay.dispatch({ type: "no-such-verb" })).rejects.toThrow(
      /unknown command 'no-such-verb'.*Registered layers: foo, bar/s,
    )
  })

  it("registering the same layer name twice throws", async () => {
    const bay = createGitbay({ store: openStore(await tmpJournalPath()), clock: CLOCK })
    bay.use({ name: "dup" })
    expect(() => bay.use({ name: "dup" })).toThrow(/layer 'dup' registered twice/)
  })
})

// A minimal test layer: one verb ("greet") emits one event ("greeted") and
// one effect ("notify"); the effect handler emits a follow-up event
// ("notified"). apply() folds both event types into a slice so a fresh
// replay can prove the layer sees its own history back, not just the live
// dispatch path.
const withGreet = definePlugin({
  name: "greet",
  reduce(state, command, next) {
    if (command.type !== "greet") return next(state, command)
    const name = command.args?.name as string
    return {
      state,
      events: [event("greeted", { name }, command.cause!)],
      effects: [{ type: "notify", data: { name } }],
    }
  },
  apply(state, evt) {
    if (evt.name !== "greeted" && evt.name !== "notified") return state
    const seen = (state.slices.greet as string[] | undefined) ?? []
    return { ...state, slices: { ...state.slices, greet: [...seen, evt.name] } }
  },
  effects: {
    async notify(effect) {
      const { name } = effect.data as { name: string }
      return [event("notified", { name }, effect.cause!)]
    },
  },
})

describe("createGitbay — layer dispatch, journal durability, replay", () => {
  it("dispatch returns the verb's event AND the effect's follow-up event, in order", async () => {
    const bay = pipe(createGitbay({ store: openStore(await tmpJournalPath()), clock: CLOCK }), withGreet)

    const { events } = await bay.dispatch({ type: "greet", args: { name: "world" } })

    expect(events.map((e) => e.name)).toEqual(["greeted", "notified"])
    expect(events.every((e) => e.data.name === "world")).toBe(true)
  })

  it("both events are durable in the journal, in append order", async () => {
    const path = await tmpJournalPath()
    const bay = pipe(createGitbay({ store: openStore(path), clock: CLOCK }), withGreet)
    await bay.dispatch({ type: "greet", args: { name: "world" } })

    const journaled: BayEvent[] = []
    for await (const evt of createJsonlJournal(path).replay()) journaled.push(evt)

    expect(journaled.map((e) => e.name)).toEqual(["greeted", "notified"])
  })

  it("a fresh bay over the same store folds both events via the layer's apply", async () => {
    const path = await tmpJournalPath()
    const first = pipe(createGitbay({ store: openStore(path), clock: CLOCK }), withGreet)
    await first.dispatch({ type: "greet", args: { name: "world" } })

    // Fresh createGitbay + fresh store handle over the SAME journal file —
    // proves replay (not just the live-dispatch fold cache) sees the history.
    const second = pipe(createGitbay({ store: openStore(path), clock: CLOCK }), withGreet)
    const state = await second.state()

    expect(state.slices.greet).toEqual(["greeted", "notified"])
  })

  it("mints unique event and command ids across fresh runtimes over one journal", async () => {
    const path = await tmpJournalPath()
    const first = withRuntimeStampedEvent(createGitbay({ store: openStore(path), clock: CLOCK }))
    const second = withRuntimeStampedEvent(createGitbay({ store: openStore(path), clock: CLOCK }))

    await first.dispatch({ type: "stamp" })
    await second.dispatch({ type: "stamp" })

    const rows: BayEvent[] = []
    for await (const row of createJsonlJournal(path).replay()) rows.push(row)
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
    expect(new Set(rows.map((row) => row.cause.commandId)).size).toBe(rows.length)
  })

  it("never accepts a caller-supplied durable command id", async () => {
    const bay = withRuntimeStampedEvent(createGitbay({ store: openStore(await tmpJournalPath()), clock: CLOCK }))

    const { events } = await bay.dispatch({
      type: "stamp",
      cause: { commandId: "caller-owned", traceId: "trace-1", spanId: "span-1" },
    })

    expect(events[0]?.cause).toMatchObject({ traceId: "trace-1", spanId: "span-1" })
    expect(events[0]?.cause.commandId).not.toBe("caller-owned")
  })

  it("rejects reducer state changes that are not represented by events", async () => {
    const bay = pipe(createGitbay({ store: openStore(await tmpJournalPath()), clock: CLOCK }), withForgedState)

    await expect(bay.dispatch({ type: "forge" })).rejects.toThrow(/state changes must be represented by events/)
  })
})

function withRuntimeStampedEvent(bay: BayRuntime): BayRuntime {
  return bay.use({
    name: "runtime-stamped-event",
    reduce(state, command, next) {
      if (command.type !== "stamp") return next(state, command)
      return {
        state,
        events: [makeEvent(bay, "gitbay/audited", { findings: [], clean: true }, command.cause!)],
        effects: [],
      }
    },
  })
}

const withForgedState = definePlugin({
  name: "forged-state",
  reduce(state, command, next) {
    if (command.type !== "forge") return next(state, command)
    return {
      state: { ...state, slices: { ...state.slices, forged: true } },
      events: [],
      effects: [],
    }
  },
})

// Two effects from one dispatch: the SECOND handler must observe the FIRST
// handler's events already journaled and folded (incremental per-effect fold).
// This is what lets a follow-up effect (e.g. batch settle) read the outcome an
// earlier effect (the merge) just journaled, inside the same dispatch.
function withTwoEffects(seen: string[]) {
  return definePlugin({
    name: "two-effects",
    reduce(state, command, next) {
      if (command.type !== "run") return next(state, command)
      return { state, events: [], effects: [{ type: "first" }, { type: "second" }] }
    },
    apply(state, evt) {
      if (evt.name !== "first-done") return state
      return { ...state, slices: { ...state.slices, twoFx: "first-done" } }
    },
    effects: {
      async first(effect) {
        return [event("first-done", {}, effect.cause!)]
      },
      async second(effect, bay) {
        const state = await bay.state()
        seen.push((state.slices.twoFx as string | undefined) ?? "(first effect not folded)")
        return [event("second-done", {}, effect.cause!)]
      },
    },
  })
}

describe("createGitbay — effects observe earlier effects' events (incremental fold)", () => {
  it("the second effect's handler sees the first effect's journaled event in state()", async () => {
    const path = await tmpJournalPath()
    const seen: string[] = []
    const bay = pipe(createGitbay({ store: openStore(path), clock: CLOCK }), withTwoEffects(seen))

    const { events } = await bay.dispatch({ type: "run" })

    expect(seen).toEqual(["first-done"])
    expect(events.map((e) => e.name)).toEqual(["first-done", "second-done"])

    // Journal order is unchanged by the incremental fold: production order.
    const journaled: BayEvent[] = []
    for await (const evt of createJsonlJournal(path).replay()) journaled.push(evt)
    expect(journaled.map((e) => e.name)).toEqual(["first-done", "second-done"])
  })
})

// A layer whose effect handler always throws — proves journal-first
// ordering: the verb's event is appended to the journal (and folded into
// the in-memory state) BEFORE runEffects() executes, so a crash inside an
// effect handler never loses the events that already happened.
const withCrashyEffect = definePlugin({
  name: "crashy",
  reduce(state, command, next) {
    if (command.type !== "go") return next(state, command)
    return {
      state,
      events: [event("started", {}, command.cause!)],
      effects: [{ type: "boom" }],
    }
  },
  apply(state, evt) {
    if (evt.name !== "started") return state
    return { ...state, slices: { ...state.slices, crashy: "started" } }
  },
  effects: {
    async boom() {
      throw new Error("effect exploded")
    },
  },
})

describe("createGitbay — journal-first crash safety", () => {
  it("an effect that throws after journaling still leaves a fresh bay able to resume from the pre-effect events", async () => {
    const path = await tmpJournalPath()
    const first = pipe(createGitbay({ store: openStore(path), clock: CLOCK }), withCrashyEffect)

    await expect(first.dispatch({ type: "go" })).rejects.toThrow("effect exploded")

    // Fresh createGitbay + fresh store handle over the SAME journal file —
    // simulates the process crashing right after the effect threw, then
    // restarting and replaying from disk.
    const second = pipe(createGitbay({ store: openStore(path), clock: CLOCK }), withCrashyEffect)
    const state = await second.state()

    expect(state.slices.crashy).toBe("started")
  })
})

describe("createJsonlJournal — corruption", () => {
  it("replay throws, naming the corrupt file:line", async () => {
    const path = await tmpJournalPath()
    const cause: Cause = { commandId: "c1" }
    await writeFile(path, `${JSON.stringify(event("greeted", { name: "world" }, cause))}\nnot json at all\n`, "utf8")

    const drain = async () => {
      for await (const _evt of createJsonlJournal(path).replay()) {
        // draining is the point of the test — assertions happen on rejection
      }
    }

    await expect(drain()).rejects.toThrow(`${path}:2`)
  })
})
