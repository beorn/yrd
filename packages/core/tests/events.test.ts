import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createYrd,
  event,
  op,
  type AnyYrdApp,
  type Command,
  type DeepReadonly,
  type ExtendYrdApp,
  type YrdEvent,
} from "../src/app.ts"
import { pipe } from "../src/pipe.ts"
import { createYrdEventStore } from "../src/store/events.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storeDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-app-store-"))
  roots.push(root)
  return root
}

type SequenceCommands = {
  sequence: {
    allocate: Command<undefined, { sequence: { issued: number[] } }>
  }
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
    { title: "Allocate" },
  )
  Object.assign(app.commands, { sequence: { allocate } })
  const project = app.project
  app.project = (state, applied) => {
    if (applied.name !== "sequence/allocated") return project(state, applied)
    const current = (state as { sequence: { issued: number[] } }).sequence.issued
    return { ...state, sequence: { issued: [...current, (applied.data as { number: number }).number] } }
  }
  return app as ExtendYrdApp<A, { sequence: { issued: number[] } }, SequenceCommands>
}

describe("Era2 filesystem event store", () => {
  it("refuses append outside the scoped writer capability", async () => {
    const store = await createYrdEventStore({ dir: await storeDir() })
    const applied: YrdEvent = {
      id: "e1",
      name: "test/event",
      ts: "2026-01-01T00:00:00.000Z",
      cause: { commandId: "c1", op: "test.write" },
      data: {},
    }

    await expect(store.append([applied])).rejects.toThrow("append requires an active writer lease")
    await store.withWriter(() => store.append([applied]))
    await expect(Array.fromAsync(store.replay())).resolves.toEqual([applied])
  })

  it("queues concurrent callers without leaking writer authority across async contexts", async () => {
    const store = await createYrdEventStore({ dir: await storeDir() })
    let releaseFirst!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const order: string[] = []

    const first = store.withWriter(async () => {
      order.push("first:start")
      markStarted()
      await release
      order.push("first:end")
    })
    await started
    await expect(store.append([])).rejects.toThrow("append requires an active writer lease")
    const second = store.withWriter(async () => {
      order.push("second")
    })
    const nested = expect(store.withWriter(() => store.withWriter(async () => undefined))).rejects.toThrow(
      "nested writer lease",
    )

    releaseFirst()
    await Promise.all([first, second, nested])
    expect(order).toEqual(["first:start", "first:end", "second"])
  })

  it("serializes fold -> apply -> append across independent app instances", async () => {
    const dir = await storeDir()
    const appA = pipe(createYrd({ store: await createYrdEventStore({ dir }) }), withSequence)
    const appB = pipe(createYrd({ store: await createYrdEventStore({ dir }) }), withSequence)

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const app = index % 2 === 0 ? appA : appB
        return app.command(app.commands.sequence.allocate, undefined)
      }),
    )

    expect((await appA.state()).sequence.issued).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
  })

  it("maintains a rebuildable SQLite index over the authoritative event log", async () => {
    const dir = await storeDir()
    const store = await createYrdEventStore({ dir })
    const app = pipe(
      createYrd({
        store,
        idGen: (() => {
          let id = 0
          return () => `id-${++id}`
        })(),
      }),
      withSequence,
    )
    await app.command(app.commands.sequence.allocate, undefined)
    await app.command(app.commands.sequence.allocate, undefined)

    expect(store.index.query({ name: "sequence/allocated" })).toMatchObject([
      { seq: 1, name: "sequence/allocated", data: { number: 1 } },
      { seq: 2, name: "sequence/allocated", data: { number: 2 } },
    ])
    await store.close()
    await rm(join(dir, "index.sqlite"), { force: true })
    await rm(join(dir, "index.sqlite-wal"), { force: true })
    await rm(join(dir, "index.sqlite-shm"), { force: true })

    const rebuilt = await createYrdEventStore({ dir })
    expect(rebuilt.index.query({ op: "sequence.allocate" }).map((entry) => entry.id)).toEqual(["id-2", "id-4"])
    await rebuilt.close()
  })

  it("refuses duplicate durable event identities while rebuilding the index", async () => {
    const dir = await storeDir()
    const event = {
      id: "duplicate",
      name: "test/event",
      ts: "2026-01-01T00:00:00.000Z",
      cause: { commandId: "command", op: "test.write" },
      data: {},
    }
    await writeFile(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`)
    await expect(createYrdEventStore({ dir })).rejects.toThrow("duplicate event id 'duplicate'")
  })
})
