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

type SequenceState = { issued: number[] }
type SequenceCommands = {
  sequence: { allocate: Command<undefined, { sequence: SequenceState }> }
}

function withSequence<App extends AnyYrdApp>(
  app: App,
): ExtendYrdApp<App, { sequence: SequenceState }, SequenceCommands> {
  Object.assign(app.initialState, { sequence: { issued: [] } })
  const allocate = op((state: DeepReadonly<{ sequence: SequenceState }>, _args: undefined) => ({
    events: [event("sequence/allocated", { number: state.sequence.issued.length + 1 })],
    effects: [],
  }))
  Object.assign(app.commands, { sequence: { allocate } })

  const project = app.project
  app.project = (state, applied) => {
    const projected = project(state, applied)
    if (applied.name !== "sequence/allocated") return projected
    const sequence = (projected as { sequence: SequenceState }).sequence
    return { ...projected, sequence: { issued: [...sequence.issued, (applied.data as { number: number }).number] } }
  }
  return app as ExtendYrdApp<App, { sequence: SequenceState }, SequenceCommands>
}

describe("Era2 filesystem event store", () => {
  it("scopes append authority and serializes concurrent writers", async () => {
    const store = await createYrdEventStore({ dir: await storeDir() })
    const applied: YrdEvent = {
      id: "e1",
      name: "test/event",
      ts: "2026-01-01T00:00:00.000Z",
      cause: { commandId: "c1", op: "test.write" },
      data: {},
    }
    let releaseFirst!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const order: string[] = []

    await expect(store.append([applied])).rejects.toThrow("append requires an active writer lease")
    const first = store.withWriter(async () => {
      order.push("first:start")
      await store.append([applied])
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
    await expect(Array.fromAsync(store.replay())).resolves.toEqual([applied])
    await store.close()
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
    await Promise.all([appA.close(), appB.close()])
  })

  it("refuses duplicate identities and malformed event envelopes on replay", async () => {
    const dir = await storeDir()
    const event = {
      id: "duplicate",
      name: "test/event",
      ts: "2026-01-01T00:00:00.000Z",
      cause: { commandId: "command", op: "test.write" },
      data: {},
    }
    await writeFile(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`)
    const duplicates = await createYrdEventStore({ dir })
    await expect(Array.fromAsync(duplicates.replay())).rejects.toThrow("duplicate event id 'duplicate'")
    await duplicates.close()

    const malformedDir = await storeDir()
    const legacy = { id: "old", name: "bay/opened", ts: "2026-01-01T00:00:00.000Z", data: {} }
    await writeFile(join(malformedDir, "events.jsonl"), `${JSON.stringify(legacy)}\n`)
    const malformed = await createYrdEventStore({ dir: malformedDir })
    await expect(Array.fromAsync(malformed.replay())).rejects.toThrow("invalid event envelope")
    await malformed.close()
  })
})
