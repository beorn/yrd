import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  command,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  event,
  journalEvent,
  type CommandTree,
  type Journal,
  type YrdDef,
} from "@yrd/core"

/**
 * Replay-only quarantine for unregistered event NAMES.
 *
 * A shared journal outlives any one checkout's composed definition: newer
 * code appends names an older checkout never registered, and a deleted
 * feature leaves its names behind in history. Before the quarantine,
 * `canonicalEvent` threw over the first such frame and took the WHOLE app's
 * replay down with it (the PR1128 shape). These tests pin the contract:
 * writers stay strict, readers skip-and-report, and the report survives a
 * checkpoint resume.
 */

type CounterState = { counter: { value: number } }

let idSequence = 0
function ids() {
  return () => `00000000-0000-7000-8000-${(++idSequence).toString(16).padStart(12, "0")}`
}

/** The narrow definition: registers only `counter/changed`. */
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
        "counter/changed": journalEvent(1, z.object({ from: z.number().int(), by: z.number().int() }).strict()),
      },
      projectionVersion: "counter-v1",
      project: (state: CounterState, applied) => {
        if (applied.name !== "counter/changed") return state
        const data = applied.data as { by: number }
        return { ...state, counter: { value: state.counter.value + data.by } }
      },
      validate: () => {},
    })
}

/** The wide definition: counter plus a second registered name the narrow one lacks. */
function withAuditedCounter() {
  const audit = command({
    title: "Audit the counter",
    visibility: "public",
    params: z.object({}).strict(),
    apply: (state: CounterState) => ({
      events: [event("counter/audited", { seen: state.counter.value })],
      value: { seen: state.counter.value },
    }),
  })

  return <State extends object, Commands extends CommandTree, Features extends object>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: {},
      commands: { audit: { record: audit } },
      events: {
        "counter/audited": journalEvent(1, z.object({ seen: z.number().int() }).strict()),
      },
      project: (state) => state,
    })
}

/** A command whose apply emits a name nobody registered — the writer-side error. */
function withRogueEmitter() {
  const rogue = command({
    title: "Emit an unregistered event",
    visibility: "public",
    params: z.object({}).strict(),
    apply: () => ({ events: [event("counter/rogue", { oops: true })], value: {} }),
  })

  return <State extends object, Commands extends CommandTree, Features extends object>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: {},
      commands: { rogue: { emit: rogue } },
      project: (state) => state,
    })
}

type StoredCheckpoint = Readonly<{ identity: string; cursor: number; value: unknown }>

function createCheckpointJournal(base: Journal<unknown>) {
  let stored: StoredCheckpoint | undefined
  const journal = {
    read: (after = 0, before?: number) => base.read(after, before),
    append: (value: unknown, expectedCursor: number) => base.append(value, expectedCursor),
    checkpoint: {
      load(identity: string) {
        return Promise.resolve(stored?.identity === identity ? structuredClone(stored) : undefined)
      },
      inspect() {
        return Promise.resolve(stored === undefined ? undefined : structuredClone(stored))
      },
      save(checkpoint: StoredCheckpoint) {
        stored = structuredClone(checkpoint)
        return Promise.resolve(true)
      },
    },
  } as Journal<unknown>
  return { journal, stored: () => stored }
}

describe("unknown event name quarantine", () => {
  it("replays past unregistered names, reports them, and keeps registered state exact", async () => {
    const journal = createMemoryJournal()
    const wide = await createYrd(withAuditedCounter()(withCounter()(createYrdDef())), {
      inject: { journal, clock: () => "2026-08-18T12:00:00.000Z", id: ids() },
    })
    await wide.dispatch(wide.commands.counter.add, { by: 2 })
    await wide.dispatch(wide.commands.audit.record, {})
    await wide.dispatch(wide.commands.counter.add, { by: 3 })
    await wide.dispatch(wide.commands.audit.record, {})
    await wide.close()

    const narrow = await createYrd(withCounter()(createYrdDef()), {
      inject: { journal, clock: () => "2026-08-18T12:05:00.000Z", id: ids() },
    })
    try {
      expect(narrow.state().counter.value).toBe(5)
      const report = narrow.unknownEventNames()
      expect(report).toHaveLength(1)
      expect(report[0]).toMatchObject({ name: "counter/audited", count: 2 })
      expect(report[0]?.sampleId).toMatch(/^[0-9a-f-]{36}$/u)
      expect(report[0]?.firstTs).toBe("2026-08-18T12:00:00.000Z")

      // historySnapshot replays from cursor 0 through the same quarantine.
      const historical = await narrow.historySnapshot()
      expect((historical.state as CounterState).counter.value).toBe(5)

      // events() default skips the unknown frames but keeps the stream alive…
      const names: string[] = []
      for await (const applied of narrow.events()) names.push(applied.name)
      expect(names).toEqual(["counter/changed", "counter/changed"])

      // …and the raw option hands diagnostic callers the stored envelope.
      const rawNames: string[] = []
      for await (const applied of narrow.events(undefined, undefined, { unknownNames: "raw" })) {
        rawNames.push(applied.name)
      }
      expect(rawNames).toEqual(["counter/changed", "counter/audited", "counter/changed", "counter/audited"])
    } finally {
      await narrow.close()
    }
  })

  it("still refuses to APPEND an unregistered name — writers stay strict", async () => {
    const app = await createYrd(withRogueEmitter()(withCounter()(createYrdDef())), {
      inject: { journal: createMemoryJournal(), clock: () => "2026-08-18T12:00:00.000Z", id: ids() },
    })
    try {
      await expect(app.dispatch(app.commands.rogue.emit, {})).rejects.toThrow(/no event definition for 'counter\/rogue'/u)
      expect(app.unknownEventNames()).toEqual([])
    } finally {
      await app.close()
    }
  })

  it("persists the quarantine report through a checkpoint resume, and omits the field while empty", async () => {
    const base = createMemoryJournal()
    const { journal, stored } = createCheckpointJournal(base)

    // A clean boot saves a checkpoint WITHOUT the field — predecessors whose
    // strict schema predates it can still read this checkpoint.
    const clean = await createYrd(withCounter()(createYrdDef()), {
      inject: { journal, clock: () => "2026-08-18T12:00:00.000Z", id: ids() },
    })
    await clean.dispatch(clean.commands.counter.add, { by: 1 })
    await clean.close()
    expect(stored()).toBeDefined()

    const wide = await createYrd(withAuditedCounter()(withCounter()(createYrdDef())), {
      inject: { journal, clock: () => "2026-08-18T12:01:00.000Z", id: ids() },
    })
    await wide.dispatch(wide.commands.audit.record, {})
    await wide.close()

    const narrow = await createYrd(withCounter()(createYrdDef()), {
      inject: { journal, clock: () => "2026-08-18T12:02:00.000Z", id: ids() },
    })
    const bootReport = narrow.unknownEventNames()
    expect(bootReport).toMatchObject([{ name: "counter/audited", count: 1 }])
    await narrow.close()
    const checkpointValue = stored()?.value as { unknownEvents?: readonly { name: string }[] }
    expect(checkpointValue.unknownEvents).toMatchObject([{ name: "counter/audited", count: 1 }])

    // Resume from that checkpoint: the cursor is already past the quarantined
    // frame, so only the persisted report can still know about it.
    const resumed = await createYrd(withCounter()(createYrdDef()), {
      inject: { journal, clock: () => "2026-08-18T12:03:00.000Z", id: ids() },
    })
    try {
      expect(resumed.unknownEventNames()).toMatchObject([{ name: "counter/audited", count: 1 }])
    } finally {
      await resumed.close()
    }
  })
})
