/**
 * @failure A projection checkpoint can bypass journal authority, stale reducer semantics, lose retry registries, or replay the cold prefix.
 * @level l1
 * @consumer @yrd/core + @yrd/persistence checkpoint seam
 */
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { command, createYrd, createYrdDef, event, type CommandTree, type Journal, type YrdDef } from "@yrd/core"
import { createJournal } from "@yrd/persistence"
import { createLogger, type Event as LogEvent } from "loggily"
import { afterEach, describe, expect, it } from "vitest"
import * as z from "zod"

type CounterState = { counter: { value: number } }

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

function withoutCheckpoint<Value>(journal: Journal<Value>): Journal<Value> {
  return { read: journal.read, append: journal.append }
}

describe("persistent Core projection checkpoint", () => {
  it("restores state and retry registries, then folds only the post-checkpoint tail", async () => {
    const dir = await stateDir()
    const definition = counterDefinition()
    const id = ids()
    const first = await createYrd(definition, { inject: { journal: createJournal({ dir }), id } })
    const receipt = await first.dispatch({ op: "counter.add", args: { by: 1 } }, { key: "stable" })
    await first.close()

    const seeded = JSON.parse(await readFile(join(dir, "projection-checkpoint-v1.json"), "utf8")) as {
      checkpoint: { identity: string; cursor: number }
    }
    expect(seeded.checkpoint).toMatchObject({ cursor: expect.any(Number), identity: expect.any(String) })

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
      props: { fromCursor: seeded.checkpoint.cursor, toCursor: expect.any(Number) },
    })
  })

  it("rejects a checkpoint from different reducer semantics and rewrites it from journal authority", async () => {
    const dir = await stateDir()
    const original = await createYrd(counterDefinition(), {
      inject: { journal: createJournal({ dir }), id: ids() },
    })
    await original.dispatch({ op: "counter.add", args: { by: 2 } })
    await original.close()

    const before = JSON.parse(await readFile(join(dir, "projection-checkpoint-v1.json"), "utf8")) as {
      checkpoint: { identity: string }
    }
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
    const after = JSON.parse(await readFile(join(dir, "projection-checkpoint-v1.json"), "utf8")) as {
      checkpoint: { identity: string }
    }
    expect(after.checkpoint.identity).not.toBe(before.checkpoint.identity)
  })

  it("never parses or rewrites historical snapshot values on an unchanged warm start", async () => {
    const dir = await stateDir()
    const definition = counterDefinition()
    const id = ids()
    const first = await createYrd(definition, { inject: { journal: createJournal({ dir }), id } })
    await first.dispatch({ op: "counter.add", args: { by: 2 } })
    await first.close()

    const checkpointPath = join(dir, "projection-checkpoint-v1.json")
    const tail = await createYrd(definition, { inject: { journal: withoutCheckpoint(createJournal({ dir })), id } })
    await tail.dispatch({ op: "counter.add", args: { by: 3 } })
    await tail.close()

    const poisonedSnapshot = '{"v":1,"values":[THIS MUST NOT BE PARSED'
    await writeFile(join(dir, "snapshot-v4.json"), poisonedSnapshot)
    const events: LogEvent[] = []
    const log = createLogger("test", [
      { level: "trace" },
      { write: (value: unknown) => events.push(value as LogEvent) },
    ])

    const warm = await createYrd(definition, { inject: { journal: createJournal({ dir, inject: { log } }), log } })
    expect(warm.state().counter.value).toBe(5)
    expect(await Array.fromAsync(warm.events())).toHaveLength(2)
    const advancedCheckpoint = await readFile(checkpointPath, "utf8")
    await warm.close()
    expect(await readFile(checkpointPath, "utf8")).toBe(advancedCheckpoint)
    expect(await readFile(join(dir, "snapshot-v4.json"), "utf8")).toBe(poisonedSnapshot)
    expect(events.some((entry) => JSON.stringify(entry).includes("snapshot-hit"))).toBe(true)

    const unchanged = await createYrd(definition, { inject: { journal: createJournal({ dir }), id } })
    expect(unchanged.state().counter.value).toBe(5)
    await unchanged.close()
    expect(await readFile(checkpointPath, "utf8")).toBe(advancedCheckpoint)
    expect(await readFile(join(dir, "snapshot-v4.json"), "utf8")).toBe(poisonedSnapshot)
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

    await expect(access(join(dir, "snapshot-v4.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(access(join(dir, "projection-checkpoint-v1.json"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(events.filter((entry) => JSON.stringify(entry).includes("identity could not be derived"))).toHaveLength(1)
  })
})
