/**
 * @failure A projection checkpoint can reuse stale reducer semantics, lose retry registries, or parse the cold journal prefix.
 * @level l1
 * @consumer @yrd/core + @yrd/persistence checkpoint seam
 */
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { command, createYrd, createYrdDef, event, type Journal } from "@yrd/core"
import { createJournal } from "@yrd/persistence"
import { createLogger, type Event as LogEvent } from "loggily"
import { afterEach, describe, expect, it } from "vitest"
import * as z from "zod"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-core-checkpoint-"))
  roots.push(root)
  return root
}

function ids() {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function counterDefinition(offset = 0, version: string | null = `counter-v${offset}`) {
  const add = command({
    title: "Add",
    visibility: "public",
    params: z.object({ by: z.number().int() }),
    apply: (_state: { counter: number }, args: { by: number }) => ({
      events: [event("counter/changed", { by: args.by })],
    }),
  })
  return createYrdDef(version === null ? {} : { projectionVersion: version }).extend({
    initialState: { counter: 0 },
    commands: { counter: { add } },
    events: { "counter/changed": z.object({ by: z.number().int() }) },
    project(state, applied) {
      const by = (applied.data as { by: number }).by
      return { counter: state.counter + by + offset }
    },
  })
}

function withoutCheckpoint<Value>(journal: Journal<Value>): Journal<Value> {
  return { read: journal.read, append: journal.append }
}

describe("raw-bound Core projection checkpoint", () => {
  it("restores registries, folds only the tail, and preserves checkpoint plus tail event order", async () => {
    const dir = await stateDir()
    const definition = counterDefinition()
    const id = ids()
    const first = await createYrd(definition, { inject: { journal: createJournal({ dir }), id } })
    const receipt = await first.dispatch({ op: "counter.add", args: { by: 1 } }, { key: "stable" })
    await first.close()

    const seeded = JSON.parse(await readFile(join(dir, "projection-checkpoint-v1.json"), "utf8")) as {
      cursor: number
      value: { receipts: unknown[] }
      valuesJson?: unknown
    }
    expect(seeded.value.receipts).toHaveLength(1)
    expect(seeded.valuesJson).toBeUndefined()

    const storage = createJournal({ dir })
    const tail = await createYrd(definition, { inject: { journal: withoutCheckpoint(storage), id } })
    await tail.dispatch({ op: "counter.add", args: { by: 2 } })
    await tail.close()

    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    await using warm = await createYrd(definition, { inject: { journal: createJournal({ dir }), log, id } })
    expect(warm.state().counter).toBe(3)
    await expect(warm.dispatch({ op: "counter.add", args: { by: 1 } }, { key: "stable" })).resolves.toEqual(receipt)
    expect(warm.state().counter).toBe(3)
    expect(events.find((entry) => entry.kind === "span" && entry.namespace === "test:core:replay")).toMatchObject({
      props: { fromCursor: seeded.cursor, frames: 1 },
    })

    await using control = await createYrd(definition, {
      inject: { journal: withoutCheckpoint(createJournal({ dir })), id },
    })
    await expect(Array.fromAsync(warm.events())).resolves.toEqual(await Array.fromAsync(control.events()))
  })

  it("uses an explicit version for same-source projectors with different captured semantics", async () => {
    const dir = await stateDir()
    const original = await createYrd(counterDefinition(0), {
      inject: { journal: createJournal({ dir }), id: ids() },
    })
    await original.dispatch({ op: "counter.add", args: { by: 2 } })
    await original.close()
    const before = JSON.parse(await readFile(join(dir, "projection-checkpoint-v1.json"), "utf8")) as {
      identity: string
    }

    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    await using changed = await createYrd(counterDefinition(1), {
      inject: { journal: createJournal({ dir }), log, id: ids() },
    })
    expect(changed.state().counter).toBe(3)
    expect(events.filter((entry) => JSON.stringify(entry).includes("checkpoint identity"))).toHaveLength(1)
    expect(events.find((entry) => entry.kind === "span" && entry.namespace === "test:core:replay")).toMatchObject({
      props: { fromCursor: 0, frames: 1 },
    })
    const after = JSON.parse(await readFile(join(dir, "projection-checkpoint-v1.json"), "utf8")) as {
      identity: string
    }
    expect(after.identity).not.toBe(before.identity)
  })

  it("binds the checkpoint to authoritative journal bytes", async () => {
    const source = await stateDir()
    const target = await stateDir()
    const definition = counterDefinition()
    for (const [dir, by] of [
      [source, 1],
      [target, 9],
    ] as const) {
      const app = await createYrd(definition, { inject: { journal: createJournal({ dir }), id: ids() } })
      await app.dispatch({ op: "counter.add", args: { by } })
      await app.close()
    }
    await copyFile(join(source, "projection-checkpoint-v1.json"), join(target, "projection-checkpoint-v1.json"))

    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    await using recovered = await createYrd(definition, {
      inject: { journal: createJournal({ dir: target }), log, id: ids() },
    })
    expect(recovered.state().counter).toBe(9)
    expect(events.filter((entry) => JSON.stringify(entry).includes("journal binding mismatch"))).toHaveLength(1)
  })

  it("hashes but does not replay the historical prefix on an unchanged warm start", async () => {
    const dir = await stateDir()
    const definition = counterDefinition()
    const writer = await createYrd(definition, { inject: { journal: createJournal({ dir }), id: ids() } })
    for (let index = 0; index < 64; index += 1) {
      await writer.dispatch({ op: "counter.add", args: { by: 1 } })
    }
    await writer.close()
    const checkpointBefore = await readFile(join(dir, "projection-checkpoint-v1.json"), "utf8")
    const cursor = (JSON.parse(checkpointBefore) as { cursor: number }).cursor

    const rawReads: Array<{ position: number; length: number }> = []
    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])
    const journal = createJournal({
      dir,
      inject: {
        log,
        io: {
          read(file, bytes, offset, length, position) {
            rawReads.push({ position, length })
            return file.read(bytes, offset, length, position)
          },
        },
      },
    })
    const warm = await createYrd(definition, { inject: { journal, log, id: ids() } })
    expect(warm.state().counter).toBe(64)
    expect(rawReads[0]).toMatchObject({ position: 0 })
    expect(rawReads.reduce((total, read) => total + read.length, 0)).toBe(cursor)
    expect(events.find((entry) => entry.kind === "span" && entry.namespace === "test:core:replay")).toMatchObject({
      props: { fromCursor: cursor, toCursor: cursor, frames: 0 },
    })
    await warm.close()
    expect(await readFile(join(dir, "projection-checkpoint-v1.json"), "utf8")).toBe(checkpointBefore)
  })

  it("does not create a checkpoint for an unversioned projection", async () => {
    const dir = await stateDir()
    const runtime = await createYrd(counterDefinition(0, null), {
      inject: { journal: createJournal({ dir }), id: ids() },
    })
    await runtime.dispatch({ op: "counter.add", args: { by: 2 } })
    await runtime.close()
    await expect(readFile(join(dir, "projection-checkpoint-v1.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
