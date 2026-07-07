import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createBay, createJsonlJournal, definePlugin, pipe } from "../src/index.ts"
import type { BayEvent, BayStore } from "../src/index.ts"

// Fixed fake clock — every event gets the same timestamp; determinism comes
// from journal append order (core.ts dispatch is journal-first), never from
// wall-clock time. Matches the "opts.clock — never Date.now() in core" rule.
const CLOCK = () => "2024-01-01T00:00:00.000Z"
const ACTOR = "test"

function event(type: string, data?: BayEvent["data"]): BayEvent {
  return { v: 1, ts: CLOCK(), actor: ACTOR, type, data }
}

async function tmpJournalPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-core-"))
  return join(dir, "journal.jsonl")
}

function openStore(path: string): BayStore {
  return { journal: createJsonlJournal(path), close: async () => {} }
}

describe("createBay — zero-plugin core", () => {
  it("state() folds to the empty shape with no layers registered", async () => {
    const bay = createBay({ store: openStore(await tmpJournalPath()), clock: CLOCK })
    expect(await bay.state()).toEqual({ leases: {}, changesets: {}, slices: {} })
  })

  it("dispatching an unregistered verb throws, naming the command and the registered layers", async () => {
    const bay = createBay({ store: openStore(await tmpJournalPath()), clock: CLOCK })
    bay.use({ name: "foo" })
    bay.use({ name: "bar" })
    await expect(bay.dispatch({ type: "no-such-verb" })).rejects.toThrow(
      /unknown command 'no-such-verb'.*Registered layers: foo, bar/s,
    )
  })

  it("registering the same layer name twice throws", async () => {
    const bay = createBay({ store: openStore(await tmpJournalPath()), clock: CLOCK })
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
      events: [event("greeted", { name })],
      effects: [{ type: "notify", data: { name } }],
    }
  },
  apply(state, evt) {
    if (evt.type !== "greeted" && evt.type !== "notified") return state
    const seen = (state.slices.greet as string[] | undefined) ?? []
    return { ...state, slices: { ...state.slices, greet: [...seen, evt.type] } }
  },
  effects: {
    async notify(effect) {
      const { name } = effect.data as { name: string }
      return [event("notified", { name })]
    },
  },
})

describe("createBay — layer dispatch, journal durability, replay", () => {
  it("dispatch returns the verb's event AND the effect's follow-up event, in order", async () => {
    const bay = pipe(createBay({ store: openStore(await tmpJournalPath()), clock: CLOCK }), withGreet)

    const { events } = await bay.dispatch({ type: "greet", args: { name: "world" } })

    expect(events.map((e) => e.type)).toEqual(["greeted", "notified"])
    expect(events.every((e) => e.data?.name === "world")).toBe(true)
  })

  it("both events are durable in the journal, in append order", async () => {
    const path = await tmpJournalPath()
    const bay = pipe(createBay({ store: openStore(path), clock: CLOCK }), withGreet)
    await bay.dispatch({ type: "greet", args: { name: "world" } })

    const journaled: BayEvent[] = []
    for await (const evt of createJsonlJournal(path).replay()) journaled.push(evt)

    expect(journaled.map((e) => e.type)).toEqual(["greeted", "notified"])
  })

  it("a fresh bay over the same store folds both events via the layer's apply", async () => {
    const path = await tmpJournalPath()
    const first = pipe(createBay({ store: openStore(path), clock: CLOCK }), withGreet)
    await first.dispatch({ type: "greet", args: { name: "world" } })

    // Fresh createBay + fresh store handle over the SAME journal file —
    // proves replay (not just the live-dispatch fold cache) sees the history.
    const second = pipe(createBay({ store: openStore(path), clock: CLOCK }), withGreet)
    const state = await second.state()

    expect(state.slices.greet).toEqual(["greeted", "notified"])
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
      events: [event("started", {})],
      effects: [{ type: "boom" }],
    }
  },
  apply(state, evt) {
    if (evt.type !== "started") return state
    return { ...state, slices: { ...state.slices, crashy: "started" } }
  },
  effects: {
    async boom() {
      throw new Error("effect exploded")
    },
  },
})

describe("createBay — journal-first crash safety", () => {
  it("an effect that throws after journaling still leaves a fresh bay able to resume from the pre-effect events", async () => {
    const path = await tmpJournalPath()
    const first = pipe(createBay({ store: openStore(path), clock: CLOCK }), withCrashyEffect)

    await expect(first.dispatch({ type: "go" })).rejects.toThrow("effect exploded")

    // Fresh createBay + fresh store handle over the SAME journal file —
    // simulates the process crashing right after the effect threw, then
    // restarting and replaying from disk.
    const second = pipe(createBay({ store: openStore(path), clock: CLOCK }), withCrashyEffect)
    const state = await second.state()

    expect(state.slices.crashy).toBe("started")
  })
})

describe("createJsonlJournal — corruption", () => {
  it("replay throws, naming the corrupt file:line", async () => {
    const path = await tmpJournalPath()
    await writeFile(path, `${JSON.stringify(event("greeted", { name: "world" }))}\nnot json at all\n`, "utf8")

    const drain = async () => {
      for await (const _evt of createJsonlJournal(path).replay()) {
        // draining is the point of the test — assertions happen on rejection
      }
    }

    await expect(drain()).rejects.toThrow(`${path}:2`)
  })
})
