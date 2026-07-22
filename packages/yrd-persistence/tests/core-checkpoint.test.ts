/**
 * @failure A projection checkpoint can bypass journal authority, stale reducer semantics, lose retry registries, or replay the cold prefix.
 * @level l1
 * @consumer @yrd/core + @yrd/persistence checkpoint seam
 */
import { createHash } from "node:crypto"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import {
  command,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  event,
  parseJournalFrame,
  type CommandTree,
  type Journal,
  type JournalCheckpoint,
  type JournalFrame,
  type YrdDef,
} from "@yrd/core"
import { createJournal as createSqliteJournal } from "@yrd/persistence"
import { createLogger, type Event as LogEvent } from "loggily"
import { afterEach, describe, expect, it } from "vitest"
import * as z from "zod"

type CounterState = { counter: { value: number } }
type PrototypeKeyState = { values: Record<string, string> }

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-core-checkpoint-"))
  roots.push(root)
  return root
}

function createJournal(options: Parameters<typeof createSqliteJournal>[0]): Journal<unknown> {
  const inject = options.inject ?? {}
  return createSqliteJournal({
    ...options,
    inject: { ...inject, sqliteVersion: "3.53.0" },
  } as unknown as Parameters<typeof createSqliteJournal>[0])
}

function storedCheckpoint(dir: string): JournalCheckpoint | undefined {
  using database = new Database(join(dir, "journal.sqlite"), { readonly: true, strict: true })
  const row = database
    .query<{ checkpoint_json: string | null }, []>("SELECT checkpoint_json FROM journal_snapshot WHERE singleton=1")
    .get()
  return row?.checkpoint_json === null || row === null
    ? undefined
    : (JSON.parse(row.checkpoint_json) as JournalCheckpoint)
}

function storedCheckpointBytes(dir: string): string {
  using database = new Database(join(dir, "journal.sqlite"), { readonly: true, strict: true })
  const row = database
    .query<
      {
        cursor: number
        checkpoint_identity: string | null
        checkpoint_json: string | null
        checkpoint_sha256: string | null
      },
      []
    >(
      `SELECT cursor, checkpoint_identity, checkpoint_json, checkpoint_sha256
       FROM journal_snapshot WHERE singleton=1`,
    )
    .get()
  return JSON.stringify(row)
}

function ids() {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function counterDefinition(offset = 0, projectionVersion: string | null = `counter-v${offset}`) {
  const add = command({
    title: "Add",
    visibility: "public",
    params: z.object({ by: z.number().int() }),
    apply: (state: CounterState, args: { by: number }) => ({
      events: [event("counter/changed", { from: state.counter.value, by: args.by })],
    }),
  })
  const contribution = {
    initialState: { counter: { value: 0 } },
    commands: { counter: { add } },
    events: { "counter/changed": z.object({ from: z.number().int(), by: z.number().int() }) },
    ...(projectionVersion === null ? {} : { projectionVersion }),
    project(state: CounterState, applied: { name: string; data: unknown }) {
      const by = (applied.data as { by: number }).by
      return { counter: { value: state.counter.value + by + offset } }
    },
  }
  return createYrdDef().extend(contribution) as YrdDef<CounterState, CommandTree, object>
}

function prototypeKeyDefinition() {
  const put = command({
    title: "Put",
    visibility: "public",
    params: z.object({ key: z.string(), value: z.string() }),
    apply: (_state: PrototypeKeyState, args: { key: string; value: string }) => ({
      events: [event("values/put", args)],
    }),
  })
  return createYrdDef().extend({
    initialState: { values: {} as Record<string, string> },
    commands: { values: { put } },
    events: { "values/put": z.object({ key: z.string(), value: z.string() }) },
    projectionVersion: "prototype-key-v1",
    project(state: PrototypeKeyState, applied: { name: string; data: unknown }) {
      const { key, value } = applied.data as { key: string; value: string }
      return { values: Object.fromEntries([...Object.entries(state.values), [key, value]]) }
    },
  })
}

function withoutCheckpoint<Value>(journal: Journal<Value>): Journal<Value> {
  return { read: journal.read, append: journal.append }
}

function indexedCheckpointJournal(): Readonly<{
  journal: Journal<unknown>
  checkpoint(): JournalCheckpoint | undefined
}> {
  const values: JournalFrame[] = []
  let stored: JournalCheckpoint | undefined
  const journal: Journal<unknown> = {
    async *read(after = 0, before = values.length) {
      const end = Math.min(before, values.length)
      if (after < end) yield { cursor: end, values: structuredClone(values.slice(after, end)) }
    },
    append(value, expectedCursor) {
      if (expectedCursor !== values.length) return Promise.resolve({ appended: false as const, cursor: values.length })
      values.push(parseJournalFrame(structuredClone(value)))
      return Promise.resolve({ appended: true as const, cursor: values.length })
    },
    checkpoint: {
      load(identity) {
        return Promise.resolve(stored?.identity === identity ? structuredClone(stored) : undefined)
      },
      save(checkpoint) {
        stored = structuredClone(checkpoint)
        return Promise.resolve(true)
      },
    },
    history: {
      command(query) {
        return structuredClone(
          values.find(
            (frame) =>
              (query.id !== undefined && frame.command.id === query.id) ||
              (query.key !== undefined && frame.cause.key === query.key),
          ),
        )
      },
      hasIdentity(kind, id) {
        return values.some((frame) =>
          kind === "cause" ? frame.cause.id === id : frame.events.some((applied) => applied.id === id),
        )
      },
      entity: () => [],
      diagnostics: () => ({
        pageCount: 0,
        freelistCount: 0,
        autoVacuum: "incremental",
        historyFrames: 0,
        tailFrames: values.length,
        archiveFallbacks: 0,
      }),
    },
  }
  return { journal, checkpoint: () => (stored === undefined ? undefined : structuredClone(stored)) }
}

describe("persistent Core projection checkpoint", () => {
  it("disables contribution eviction when a custom Journal has no history capability", async () => {
    const add = command({
      title: "Add retained item",
      visibility: "public",
      params: z.object({ value: z.number().int() }),
      apply: (_state: { items: number[] }, args: { value: number }) => ({
        events: [event("items/added", args)],
      }),
    })
    const definition = createYrdDef().extend({
      initialState: { items: [] as number[] },
      commands: { items: { add } },
      events: { "items/added": z.object({ value: z.number().int() }) },
      projectionVersion: "custom-journal-retention-v1",
      project(state: { items: number[] }, applied: { data: unknown }) {
        return { items: [...state.items, (applied.data as { value: number }).value] }
      },
      compact(state: { items: number[] }) {
        return { items: state.items.slice(-1) }
      },
    })
    await using app = await createYrd(definition, { inject: { journal: createMemoryJournal(), id: ids() } })
    for (const value of [1, 2, 3]) await app.dispatch({ op: "items.add", args: { value } })

    expect(app.state().items).toEqual([1, 2, 3])
    expect(app.retentionDiagnostics()).toMatchObject({ receiptFrames: 3 })
    expect(app.retentionDiagnostics()).not.toHaveProperty("journal")
  })

  it("compacts a history-backed projection once after each atomic frame", async () => {
    let compactions = 0
    const addPair = command({
      title: "Add an atomic item pair",
      visibility: "public",
      params: z.object({ first: z.number().int(), second: z.number().int() }),
      apply: (_state: { items: number[] }, args: { first: number; second: number }) => ({
        events: [event("items/added", { value: args.first }), event("items/added", { value: args.second })],
      }),
    })
    const definition = createYrdDef().extend({
      initialState: { items: [] as number[] },
      commands: { items: { addPair } },
      events: { "items/added": z.object({ value: z.number().int() }) },
      projectionVersion: "atomic-frame-compaction-v1",
      project(state: { items: number[] }, applied: { data: unknown }) {
        return { items: [...state.items, (applied.data as { value: number }).value] }
      },
      compact(state: { items: number[] }) {
        compactions += 1
        return { items: state.items.slice(-1) }
      },
    })
    const indexed = indexedCheckpointJournal()
    await using app = await createYrd(definition, { inject: { journal: indexed.journal, id: ids() } })

    await app.dispatch({ op: "items.addPair", args: { first: 1, second: 2 } })

    expect(app.state().items).toEqual([2])
    expect(compactions).toBe(1)
  })

  it("validates the complete cold replay before one projection compaction", async () => {
    const add = command({
      title: "Add a retained item",
      visibility: "public",
      params: z.object({ value: z.number().int() }),
      apply: (_state: { items: number[] }, args: { value: number }) => ({
        events: [event("items/added", args)],
      }),
    })
    const definition = (version: string, observe?: (items: readonly number[]) => void) =>
      createYrdDef().extend({
        initialState: { items: [] as number[] },
        commands: { items: { add } },
        events: { "items/added": z.object({ value: z.number().int() }) },
        projectionVersion: version,
        project(state: { items: number[] }, applied: { data: unknown }) {
          return { items: [...state.items, (applied.data as { value: number }).value] }
        },
        validate(state: { items: number[] }) {
          observe?.(state.items)
        },
        compact(state: { items: number[] }) {
          return { items: state.items.slice(-1) }
        },
      })
    const indexed = indexedCheckpointJournal()
    const writer = await createYrd(definition("cold-replay-writer-v1"), {
      inject: { journal: indexed.journal, id: ids() },
    })
    await writer.dispatch({ op: "items.add", args: { value: 1 } })
    await writer.dispatch({ op: "items.add", args: { value: 2 } })
    await writer.close()

    const validations: number[][] = []
    await using reader = await createYrd(
      definition("cold-replay-reader-v1", (items) => validations.push([...items])),
      { inject: { journal: indexed.journal, id: ids() } },
    )

    expect(validations).toEqual([[1, 2]])
    expect(reader.state().items).toEqual([2])
    await expect(reader.historySnapshot()).resolves.toMatchObject({ state: { items: [1, 2] } })
    expect(validations).toEqual([
      [1, 2],
      [1, 2],
    ])
  })

  it("bounds the warm receipt cache while exact old retries and complete events stay journal-backed", async () => {
    const definition = counterDefinition()
    const indexed = indexedCheckpointJournal()
    const writer = await createYrd(definition, { inject: { journal: indexed.journal, id: ids() } })
    const first = await writer.dispatch({ op: "counter.add", args: { by: 1 } }, { key: "oldest-retry" })
    for (let index = 1; index < 4_097; index += 1) {
      await writer.dispatch({ op: "counter.add", args: { by: 1 } })
    }
    await writer.close()

    const checkpoint = indexed.checkpoint()
    expect(checkpoint).toMatchObject({ cursor: 4_097, value: { v: 1 } })
    if (checkpoint === undefined) throw new Error("expected the warm checkpoint")
    expect((checkpoint.value as { receipts: unknown[] }).receipts).toHaveLength(4_096)

    await using reader = await createYrd(definition, { inject: { journal: indexed.journal, id: ids() } })
    const before = await Array.fromAsync(reader.events())
    expect(before).toHaveLength(4_097)
    await expect(
      reader.dispatch({ id: first.command.id, op: "counter.add", args: { by: 1 } }, { key: "oldest-retry" }),
    ).resolves.toEqual(first)
    await expect(
      reader.dispatch({ id: first.command.id, op: "counter.add", args: { by: 2 } }, { key: "oldest-retry" }),
    ).rejects.toThrow(/different command/iu)
    await expect(Array.fromAsync(reader.events())).resolves.toHaveLength(4_097)
    const oldest = parseJournalFrame(indexed.journal.history?.command({ id: first.command.id }))
    await reader.close()

    const causeIds = [oldest.cause.id, "00000000-0000-7000-8000-00000000f001"]
    const causeReader = await createYrd(definition, {
      inject: { journal: indexed.journal, id: () => causeIds.shift() ?? "00000000-0000-7000-8000-00000000f002" },
    })
    await expect(
      causeReader.dispatch({ id: "00000000-0000-7000-8000-00000000f003", op: "counter.add", args: { by: 1 } }),
    ).rejects.toThrow(/cause id.*already in use/iu)
    await causeReader.close()

    const eventIds = ["00000000-0000-7000-8000-00000000f004", oldest.events[0]!.id]
    const eventReader = await createYrd(definition, {
      inject: { journal: indexed.journal, id: () => eventIds.shift() ?? "00000000-0000-7000-8000-00000000f005" },
    })
    await expect(
      eventReader.dispatch({ id: "00000000-0000-7000-8000-00000000f006", op: "counter.add", args: { by: 1 } }),
    ).rejects.toThrow(/event id.*already in use/iu)
    await expect(Array.fromAsync(eventReader.events())).resolves.toHaveLength(4_097)
    await eventReader.close()
  })

  it("restores checkpoint state at cursor zero during runtime activation", async () => {
    const readAfter: number[] = []
    let saves = 0
    const journal: Journal<unknown> = {
      read(after = 0) {
        readAfter.push(after)
        return (async function* () {})()
      },
      append() {
        return Promise.reject(new Error("append is not expected during activation"))
      },
      checkpoint: {
        load(identity) {
          return Promise.resolve({
            identity,
            cursor: 0,
            value: {
              v: 1,
              state: { counter: { value: 41 } },
              receipts: [],
              causeIds: [],
              eventIds: [],
            },
          })
        },
        save() {
          saves += 1
          return Promise.resolve(true)
        },
      },
    }

    await using runtime = await createYrd(counterDefinition(), { inject: { journal, id: ids() } })

    expect(runtime.state().counter.value).toBe(41)
    expect(readAfter).toEqual([0])
    expect(saves).toBe(0)
  })

  it("never schedules a checkpoint write when a read-only journal exposes load only", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const journal = {
      read() {
        return (async function* () {})()
      },
      append() {
        return Promise.reject(new Error("append is not expected"))
      },
      checkpoint: {
        load() {
          return Promise.resolve(undefined)
        },
      },
    } as unknown as Journal<unknown>

    await using runtime = await createYrd(counterDefinition(), { inject: { journal, log, id: ids() } })
    expect(runtime.state().counter.value).toBe(0)
    expect(events.filter((event) => event.props?.reason === "projection-checkpoint-write-failed")).toEqual([])
  })

  it("checkpoints a long-lived writer after 256 projected frames without waiting for close", async () => {
    const values: unknown[] = []
    const saves: number[] = []
    const journal: Journal<unknown> = {
      async *read(after = 0) {
        if (after < values.length) yield { cursor: values.length, values: values.slice(after) }
      },
      append(value, expectedCursor) {
        if (expectedCursor !== values.length) {
          return Promise.resolve({ appended: false as const, cursor: values.length })
        }
        values.push(value)
        return Promise.resolve({ appended: true as const, cursor: values.length })
      },
      checkpoint: {
        load() {
          return Promise.resolve(undefined)
        },
        save(checkpoint) {
          saves.push(checkpoint.cursor)
          return Promise.resolve(true)
        },
      },
    }
    await using runtime = await createYrd(counterDefinition(), { inject: { journal, id: ids() } })
    expect(saves).toEqual([0])

    for (let index = 0; index < 255; index += 1) {
      await runtime.dispatch({ op: "counter.add", args: { by: 1 } })
    }
    await Promise.resolve()
    expect(saves).toEqual([0])

    await runtime.dispatch({ op: "counter.add", args: { by: 1 } })
    await Promise.resolve()
    expect(saves).toEqual([0, 256])
  })

  it("does not busy-retry a refused background checkpoint without new projection work", async () => {
    const values: unknown[] = []
    const saves: number[] = []
    const retry = Promise.withResolvers<boolean>()
    let savesAtRefreshCursor = 0
    const journal: Journal<unknown> = {
      async *read(after = 0) {
        if (after < values.length) yield { cursor: values.length, values: values.slice(after) }
      },
      append(value, expectedCursor) {
        if (expectedCursor !== values.length) {
          return Promise.resolve({ appended: false as const, cursor: values.length })
        }
        values.push(value)
        return Promise.resolve({ appended: true as const, cursor: values.length })
      },
      checkpoint: {
        load() {
          return Promise.resolve(undefined)
        },
        save(checkpoint) {
          saves.push(checkpoint.cursor)
          if (checkpoint.cursor !== 256) return Promise.resolve(true)
          savesAtRefreshCursor += 1
          return savesAtRefreshCursor === 1 ? Promise.resolve(false) : retry.promise
        },
      },
    }
    const runtime = await createYrd(counterDefinition(), { inject: { journal, id: ids() } })

    for (let index = 0; index < 256; index += 1) {
      await runtime.dispatch({ op: "counter.add", args: { by: 1 } })
    }
    await Promise.resolve()
    await Promise.resolve()
    const observed = [...saves]

    retry.resolve(true)
    await runtime.close()
    expect(observed).toEqual([0, 256])
  })

  it("holds frame 513 behind the hard checkpoint high-water while one coalesced save is in flight", async () => {
    const values: unknown[] = []
    const saves: number[] = []
    let releaseFirst: ((saved: boolean) => void) | undefined
    const firstSave = new Promise<boolean>((resolve) => {
      releaseFirst = resolve
    })
    const journal: Journal<unknown> = {
      async *read(after = 0) {
        if (after < values.length) yield { cursor: values.length, values: values.slice(after) }
      },
      append(value, expectedCursor) {
        if (expectedCursor !== values.length) {
          return Promise.resolve({ appended: false as const, cursor: values.length })
        }
        values.push(value)
        return Promise.resolve({ appended: true as const, cursor: values.length })
      },
      checkpoint: {
        load() {
          return Promise.resolve(undefined)
        },
        save(checkpoint) {
          saves.push(checkpoint.cursor)
          return checkpoint.cursor === 256 ? firstSave : Promise.resolve(true)
        },
      },
    }
    await using runtime = await createYrd(counterDefinition(), { inject: { journal, id: ids() } })
    for (let index = 0; index < 512; index += 1) {
      await runtime.dispatch({ op: "counter.add", args: { by: 1 } })
    }
    expect(saves).toEqual([0, 256])

    let settled = false
    const blocked = runtime.dispatch({ op: "counter.add", args: { by: 1 } }).then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(values).toHaveLength(512)

    releaseFirst?.(true)
    await blocked
    expect(saves).toEqual([0, 256, 512])
    expect(values).toHaveLength(513)
  })

  it("never wedges a load-only consumer behind the checkpoint high-water", async () => {
    const values: unknown[] = []
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const journal: Journal<unknown> = {
      async *read(after = 0) {
        if (after < values.length) yield { cursor: values.length, values: values.slice(after) }
      },
      append(value, expectedCursor) {
        if (expectedCursor !== values.length) {
          return Promise.resolve({ appended: false as const, cursor: values.length })
        }
        values.push(value)
        return Promise.resolve({ appended: true as const, cursor: values.length })
      },
      checkpoint: {
        load() {
          return Promise.resolve(undefined)
        },
      },
    }
    await using runtime = await createYrd(counterDefinition(), { inject: { journal, log, id: ids() } })
    for (let index = 0; index < 520; index += 1) {
      await runtime.dispatch({ op: "counter.add", args: { by: 1 } })
    }
    expect(values).toHaveLength(520)
    expect(runtime.state().counter.value).toBe(520)
    expect(events.some((event) => event.props?.reason === "checkpoint-flush-unavailable")).toBe(true)
  })

  it("restores state and retry registries, then folds only the post-checkpoint tail", async () => {
    const dir = await stateDir()
    const definition = counterDefinition()
    const id = ids()
    const first = await createYrd(definition, { inject: { journal: createJournal({ dir }), id } })
    const receipt = await first.dispatch({ op: "counter.add", args: { by: 1 } }, { key: "stable" })
    await first.close()

    const seeded = storedCheckpoint(dir)
    expect(seeded).toMatchObject({ cursor: expect.any(Number), identity: expect.any(String) })
    expect(seeded!.cursor).toBeGreaterThan(0)

    const tail = await createYrd(definition, { inject: { journal: withoutCheckpoint(createJournal({ dir })), id } })
    await tail.dispatch({ op: "counter.add", args: { by: 2 } })
    await tail.close()

    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    await using warm = await createYrd(definition, { inject: { journal: createJournal({ dir }), log, id } })

    expect(warm.state().counter.value).toBe(3)
    await expect(warm.dispatch({ op: "counter.add", args: { by: 1 } }, { key: "stable" })).resolves.toEqual(receipt)
    expect(warm.state().counter.value).toBe(3)
    expect(events.find((entry) => entry.kind === "span" && entry.namespace === "test:core:replay")).toMatchObject({
      props: { fromCursor: seeded!.cursor, toCursor: expect.any(Number) },
    })
  })

  it("rejects a checkpoint from different reducer semantics and rewrites it from journal authority", async () => {
    const dir = await stateDir()
    const original = await createYrd(counterDefinition(), {
      inject: { journal: createJournal({ dir }), id: ids() },
    })
    await original.dispatch({ op: "counter.add", args: { by: 2 } })
    await original.close()

    const before = storedCheckpoint(dir)
    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    await using changed = await createYrd(counterDefinition(1), {
      inject: { journal: createJournal({ dir, inject: { log } }), log, id: ids() },
    })

    expect(changed.state().counter.value).toBe(3)
    expect(events.filter((entry) => JSON.stringify(entry).includes("checkpoint identity"))).toHaveLength(1)
    expect(events.find((entry) => entry.kind === "span" && entry.namespace === "test:core:replay")).toMatchObject({
      props: { fromCursor: 0 },
    })
    const after = storedCheckpoint(dir)
    expect(after?.identity).not.toBe(before?.identity)
  })

  it("rejects a re-signed checkpoint whose receipt breaks the command/cause binding", async () => {
    const dir = await stateDir()
    const definition = counterDefinition()
    const seed = await createYrd(definition, { inject: { journal: createJournal({ dir }), id: ids() } })
    await seed.dispatch({ op: "counter.add", args: { by: 2 } })
    await seed.close()

    using database = new Database(join(dir, "journal.sqlite"), { strict: true })
    const row = database
      .query<{ checkpoint_json: string }, []>("SELECT checkpoint_json FROM journal_snapshot WHERE singleton=1")
      .get()
    if (row === null) throw new Error("expected a persisted checkpoint")
    const poisoned = JSON.parse(row.checkpoint_json) as {
      value: { receipts: Array<{ command: { id: string }; cause: { commandId: string } }> }
    }
    poisoned.value.receipts[0]!.cause.commandId = "00000000-0000-7000-8000-ffffffffffff"
    const checkpointJson = JSON.stringify(poisoned)
    const checkpointSha256 = createHash("sha256").update(checkpointJson).digest("hex")
    database
      .query(
        `UPDATE journal_snapshot
         SET checkpoint_json = ?, checkpoint_sha256 = ?
         WHERE singleton=1`,
      )
      .run(checkpointJson, checkpointSha256)

    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    await using warm = await createYrd(definition, {
      inject: { journal: createJournal({ dir }), log, id: ids() },
    })

    expect(warm.state().counter.value).toBe(2)
    expect(events.filter((entry) => entry.props?.reason === "projection-checkpoint-invalid")).toHaveLength(1)
    expect(events.find((entry) => entry.kind === "span" && entry.namespace === "test:core:replay")).toMatchObject({
      props: { fromCursor: 0 },
    })
    const repaired = storedCheckpoint(dir)
    expect(repaired?.value).toMatchObject({
      receipts: [{ command: { id: expect.any(String) }, cause: { commandId: expect.any(String) } }],
    })
    if (repaired === undefined) throw new Error("expected repaired checkpoint")
    const [receipt] = (
      repaired.value as {
        receipts: Array<{ command: { id: string }; cause: { commandId: string } }>
      }
    ).receipts
    expect(receipt?.cause.commandId).toBe(receipt?.command.id)
  })

  it("rejects a re-signed checkpoint whose command intent no longer matches its cause hash", async () => {
    const dir = await stateDir()
    const definition = counterDefinition()
    const seed = await createYrd(definition, { inject: { journal: createJournal({ dir }), id: ids() } })
    await seed.dispatch({ op: "counter.add", args: { by: 2 } })
    await seed.close()

    using database = new Database(join(dir, "journal.sqlite"), { strict: true })
    const row = database
      .query<{ checkpoint_json: string }, []>("SELECT checkpoint_json FROM journal_snapshot WHERE singleton=1")
      .get()
    if (row === null) throw new Error("expected a persisted checkpoint")
    const poisoned = JSON.parse(row.checkpoint_json) as {
      value: { receipts: Array<{ command: { args: { by: number } }; cause: { commandHash: string } }> }
    }
    const receipt = poisoned.value.receipts[0]
    if (receipt === undefined) throw new Error("expected a persisted receipt")
    const originalHash = receipt.cause.commandHash
    receipt.command.args.by = 999
    expect(receipt.cause.commandHash).toBe(originalHash)
    const checkpointJson = JSON.stringify(poisoned)
    const checkpointSha256 = createHash("sha256").update(checkpointJson).digest("hex")
    database
      .query(
        `UPDATE journal_snapshot
         SET checkpoint_json = ?, checkpoint_sha256 = ?
         WHERE singleton=1`,
      )
      .run(checkpointJson, checkpointSha256)

    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    await using warm = await createYrd(definition, {
      inject: { journal: createJournal({ dir }), log, id: ids() },
    })

    expect(warm.state().counter.value).toBe(2)
    expect(events.filter((entry) => entry.props?.reason === "projection-checkpoint-invalid")).toHaveLength(1)
    expect(events.find((entry) => entry.kind === "span" && entry.namespace === "test:core:replay")).toMatchObject({
      props: { fromCursor: 0 },
    })
  })

  it("restores a warm checkpoint and bounded tail without materializing row history", async () => {
    const dir = await stateDir()
    const definition = counterDefinition()
    const id = ids()
    const first = await createYrd(definition, { inject: { journal: createJournal({ dir }), id } })
    await first.dispatch({ op: "counter.add", args: { by: 2 } })
    await first.close()

    const firstCheckpoint = storedCheckpoint(dir)
    const tail = await createYrd(definition, { inject: { journal: withoutCheckpoint(createJournal({ dir })), id } })
    await tail.dispatch({ op: "counter.add", args: { by: 3 } })
    await tail.close()

    {
      using database = new Database(join(dir, "journal.sqlite"), { readwrite: true, strict: true })
      database.query("UPDATE journal_history SET value_json = value_json || ' ' WHERE cursor = 1").run()
    }
    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])

    const warm = await createYrd(definition, { inject: { journal: createJournal({ dir, inject: { log } }), log } })
    expect(warm.state().counter.value).toBe(5)
    await expect(Array.fromAsync(createJournal({ dir }).read())).rejects.toThrow("journal event checksum mismatch")
    await warm.close()
    expect(storedCheckpoint(dir)?.cursor).toBe(2)
    expect(events.some((entry) => entry.props?.reason === "checkpoint-write-failed")).toBe(false)
    expect(events.find((entry) => entry.kind === "span" && entry.namespace === "test:core:replay")).toMatchObject({
      props: { fromCursor: firstCheckpoint?.cursor },
    })

    const unchanged = await createYrd(definition, { inject: { journal: createJournal({ dir }), id } })
    expect(unchanged.state().counter.value).toBe(5)
    await unchanged.close()
    expect(storedCheckpoint(dir)?.cursor).toBe(2)
  })

  it("disables projection checkpoints when reducer semantics are not explicitly versioned", async () => {
    const dir = await stateDir()
    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    const runtime = await createYrd(counterDefinition(0, null), {
      inject: { journal: createJournal({ dir }), log, id: ids() },
    })
    await runtime.dispatch({ op: "counter.add", args: { by: 2 } })
    await runtime.close()

    expect(storedCheckpoint(dir)).toBeUndefined()
    await expect(access(join(dir, "snapshot-v4.json"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(events.filter((entry) => JSON.stringify(entry).includes("identity could not be derived"))).toHaveLength(1)
  })

  it("preserves own JSON keys that shadow Object prototype names across warm restore", async () => {
    const dir = await stateDir()
    const definition = prototypeKeyDefinition()
    const first = await createYrd(definition, { inject: { journal: createJournal({ dir }), id: ids() } })
    await first.dispatch({ op: "values.put", args: { key: "__proto__", value: "preserved" } })
    expect(Object.hasOwn(first.state().values, "__proto__")).toBe(true)
    await first.close()

    const persisted = storedCheckpoint(dir)
    if (persisted === undefined) throw new Error("expected persisted checkpoint")
    const persistedState = (persisted.value as { state: PrototypeKeyState }).state
    expect(persisted?.cursor).toBeGreaterThan(0)
    expect(Object.hasOwn(persistedState.values, "__proto__")).toBe(true)
    expect(persistedState.values.__proto__).toBe("preserved")

    await using warm = await createYrd(definition, { inject: { journal: createJournal({ dir }), id: ids() } })
    expect(Object.hasOwn(warm.state().values, "__proto__")).toBe(true)
    expect(warm.state().values.__proto__).toBe("preserved")
  })

  it("stays checkpoint-warm on the invocation after an identity-mismatch replay rewrites the checkpoint", async () => {
    const dir = await stateDir()
    const seed = await createYrd(counterDefinition(), { inject: { journal: createJournal({ dir }), id: ids() } })
    await seed.dispatch({ op: "counter.add", args: { by: 2 } })
    await seed.close()
    const stale = storedCheckpoint(dir)

    // A projector-semantics change shifts the derived identity; the stored checkpoint now carries the old one.
    const mismatchEvents: LogEvent[] = []
    const mismatchLog = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => mismatchEvents.push(value as LogEvent) },
    ])
    const rewritten = await createYrd(counterDefinition(1), {
      inject: { journal: createJournal({ dir, inject: { log: mismatchLog } }), log: mismatchLog, id: ids() },
    })
    // Read the checkpoint after activation but before close: a read-only invocation that never closes must still heal.
    const refreshed = storedCheckpoint(dir)
    await rewritten.close()
    expect(mismatchEvents.filter((entry) => JSON.stringify(entry).includes("identity changed"))).toHaveLength(1)
    expect(refreshed?.identity).not.toBe(stale?.identity)
    expect(refreshed?.cursor).toBeGreaterThan(0)

    // The very next invocation under the new identity must load warm: no warning, replay only from the fresh checkpoint.
    const warmEvents: LogEvent[] = []
    const warmLog = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => warmEvents.push(value as LogEvent) },
    ])
    await using warm = await createYrd(counterDefinition(1), {
      inject: { journal: createJournal({ dir, inject: { log: warmLog } }), log: warmLog, id: ids() },
    })
    expect(warm.state().counter.value).toBe(3)
    expect(warmEvents.filter((entry) => JSON.stringify(entry).includes("identity changed"))).toHaveLength(0)
    expect(warmEvents.find((entry) => entry.kind === "span" && entry.namespace === "test:core:replay")).toMatchObject({
      props: { fromCursor: refreshed?.cursor },
    })
  })

  it("never writes a checkpoint and warns on every open while the projector identity is underivable", async () => {
    const dir = await stateDir()
    const firstEvents: LogEvent[] = []
    const firstLog = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => firstEvents.push(value as LogEvent) },
    ])
    const first = await createYrd(counterDefinition(0, null), {
      inject: { journal: createJournal({ dir }), log: firstLog, id: ids() },
    })
    await first.dispatch({ op: "counter.add", args: { by: 2 } })
    await first.close()
    expect(firstEvents.filter((entry) => JSON.stringify(entry).includes("identity could not be derived"))).toHaveLength(
      1,
    )
    expect(storedCheckpoint(dir)).toBeUndefined()

    const secondEvents: LogEvent[] = []
    const secondLog = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => secondEvents.push(value as LogEvent) },
    ])
    await using second = await createYrd(counterDefinition(0, null), {
      inject: { journal: createJournal({ dir }), log: secondLog, id: ids() },
    })
    expect(second.state().counter.value).toBe(2)
    expect(
      secondEvents.filter((entry) => JSON.stringify(entry).includes("identity could not be derived")),
    ).toHaveLength(1)
    expect(storedCheckpoint(dir)).toBeUndefined()
  })

  it("does not warn or rewrite the checkpoint when the projector identity is unchanged", async () => {
    const dir = await stateDir()
    const definition = counterDefinition()
    const seed = await createYrd(definition, { inject: { journal: createJournal({ dir }), id: ids() } })
    await seed.dispatch({ op: "counter.add", args: { by: 2 } })
    await seed.close()
    const stored = storedCheckpointBytes(dir)

    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    await using warm = await createYrd(definition, {
      inject: { journal: createJournal({ dir, inject: { log } }), log, id: ids() },
    })
    expect(warm.state().counter.value).toBe(2)
    expect(events.filter((entry) => JSON.stringify(entry).includes("identity changed"))).toHaveLength(0)
    expect(storedCheckpointBytes(dir)).toBe(stored)
  })
})
