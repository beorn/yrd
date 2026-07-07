import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createBay, createJsonlJournal, pipe, queuedChangesets, withQueue } from "../src/index.ts"
import type { BayRuntime, BayState, BayStore, ChangeId, QueueSlice } from "../src/index.ts"

// Fixed fake clock + actor — determinism comes from the injected clock and the
// folded state, never from wall time or randomness (the reducer purity rule).
const CLOCK = () => "2024-01-01T00:00:00.000Z"
const ACTOR = "tester"

async function tmpJournalPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-queue-"))
  return join(dir, "journal.jsonl")
}

function openStore(path: string): BayStore {
  return { journal: createJsonlJournal(path), close: async () => {} }
}

async function buildQueueBay(path: string): Promise<BayRuntime> {
  return pipe(createBay({ store: openStore(path), clock: CLOCK, actor: ACTOR }), withQueue())
}

function slice(state: BayState): QueueSlice {
  return state.slices.queue as QueueSlice
}

function stateOf(state: BayState, id: ChangeId): string {
  return state.changesets[id]!.state
}

describe("withQueue — enqueue", () => {
  it("mints a deterministic C-<hash> id and records a queued changeset + target", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    const { events } = await bay.dispatch({ type: "enqueue", args: { target: "task/wi-a", workitem: "wi-a" } })

    const enqueued = events.find((e) => e.type === "changeset.enqueued")!
    const id = enqueued.data!.changeset as string
    expect(id).toMatch(/^C-[0-9a-f]{8}$/)
    expect(enqueued.data!.target).toBe("task/wi-a")

    const state = await bay.state()
    expect(state.changesets[id]).toMatchObject({ id, workitem: "wi-a", revision: 1, repos: [], state: "queued" })
    expect(slice(state).order).toEqual([id])
    expect(slice(state).targets[id]).toBe("task/wi-a")
  })

  it("uses an explicit changeId when supplied; workitem defaults to null", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    await bay.dispatch({ type: "enqueue", args: { target: "deadbeef", changeId: "C-explicit" } })
    const state = await bay.state()
    expect(state.changesets["C-explicit"]).toMatchObject({ id: "C-explicit", workitem: null, state: "queued" })
    expect(slice(state).targets["C-explicit"]).toBe("deadbeef")
  })

  it("throws on a missing/blank target", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    await expect(bay.dispatch({ type: "enqueue", args: {} })).rejects.toThrow(/'target'.*required/)
    await expect(bay.dispatch({ type: "enqueue", args: { target: "  " } })).rejects.toThrow(/'target'.*required/)
  })

  it("throws on a duplicate changeId (ids are unique)", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    await bay.dispatch({ type: "enqueue", args: { target: "t1", changeId: "C-dup" } })
    await expect(
      bay.dispatch({ type: "enqueue", args: { target: "t2", changeId: "C-dup" } }),
    ).rejects.toThrow(/'C-dup' already exists/)
  })
})

describe("withQueue — FIFO ordering", () => {
  it("queuedChangesets returns queued changesets in enqueue order across 3", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    for (const t of ["A", "B", "C"]) {
      await bay.dispatch({ type: "enqueue", args: { target: t, changeId: `C-${t}` } })
    }
    const queued = queuedChangesets(await bay.state())
    expect(queued.map((c) => c.id)).toEqual(["C-A", "C-B", "C-C"])
    // and the slice order matches
    expect(slice(await bay.state()).order).toEqual(["C-A", "C-B", "C-C"])
  })
})

describe("withQueue — requeue validation (illegal transition throws)", () => {
  it("throws requeueing an unknown changeset", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    await expect(bay.dispatch({ type: "requeue", args: { changeset: "C-nope" } })).rejects.toThrow(
      /no changeset 'C-nope'/,
    )
  })

  it("throws requeueing a still-queued changeset (queued → queued is illegal)", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    await bay.dispatch({ type: "enqueue", args: { target: "t1", changeId: "C-q" } })
    await expect(bay.dispatch({ type: "requeue", args: { changeset: "C-q" } })).rejects.toThrow(
      /illegal changeset transition queued → queued/,
    )
    // the illegal op left state untouched — no silent overwrite
    expect(stateOf(await bay.state(), "C-q")).toBe("queued")
  })
})

describe("withQueue — replay", () => {
  it("a fresh bay over the same journal folds to identical changesets + slice", async () => {
    const path = await tmpJournalPath()
    const first = await buildQueueBay(path)
    await first.dispatch({ type: "enqueue", args: { target: "A", changeId: "C-A" } })
    await first.dispatch({ type: "enqueue", args: { target: "B", changeId: "C-B" } })
    const live = await first.state()

    // Fresh createBay + fresh store handle over the SAME journal file — proves
    // replay (not the live fold cache) reconstructs identical state.
    const replayed = await (await buildQueueBay(path)).state()

    expect(replayed.changesets).toEqual(live.changesets)
    expect(slice(replayed)).toEqual(slice(live))
    expect(slice(replayed).order).toEqual(["C-A", "C-B"])
  })
})
