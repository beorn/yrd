import { mkdtemp, rm } from "node:fs/promises"
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
import { createYrdEventStore } from "../src/store/app.ts"

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
})
