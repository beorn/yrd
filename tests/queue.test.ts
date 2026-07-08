import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createGitbay, createJsonlJournal, pipe, queuedPrs, withQueue } from "../src/index.ts"
import type { BayRuntime, BayState, BayStore, PrId, QueueSlice } from "../src/index.ts"

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
  return pipe(createGitbay({ store: openStore(path), clock: CLOCK, actor: ACTOR }), withQueue())
}

function slice(state: BayState): QueueSlice {
  return state.slices.queue as QueueSlice
}

function stateOf(state: BayState, id: PrId): string {
  return state.prs[id]!.state
}

describe("withQueue — enqueue", () => {
  it("mints sequential PR ids (PR1, PR2) and records a queued PR + target", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    const { events } = await bay.dispatch({ type: "enqueue", args: { target: "task/wi-a", name: "wi-a" } })

    const opened = events.find((e) => e.name === "pr/opened")!
    const id = opened.data!.pr as string
    expect(id).toBe("PR1")
    expect(opened.data!.target).toBe("task/wi-a")

    const state = await bay.state()
    expect(state.prs[id]).toMatchObject({ id, name: "wi-a", revision: 1, repos: [], state: "queued" })
    expect(slice(state).order).toEqual([id])
    expect(slice(state).targets[id]).toBe("task/wi-a")

    // Sequential per repo: the next submit gets the next number.
    const second = await bay.dispatch({ type: "enqueue", args: { target: "task/wi-b" } })
    expect(second.events.find((e) => e.name === "pr/opened")!.data!.pr).toBe("PR2")
  })

  it("uses an explicit pr id when supplied; name defaults to null", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    await bay.dispatch({ type: "enqueue", args: { target: "deadbeef", pr: "X-explicit" } })
    const state = await bay.state()
    expect(state.prs["X-explicit"]).toMatchObject({ id: "X-explicit", name: null, state: "queued" })
    expect(slice(state).targets["X-explicit"]).toBe("deadbeef")
  })

  it("an explicit non-PRn id never disturbs the sequence; an explicit PRn advances it", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    await bay.dispatch({ type: "enqueue", args: { target: "t1", pr: "X-legacy" } })
    const a = await bay.dispatch({ type: "enqueue", args: { target: "t2" } })
    expect(a.events.find((e) => e.name === "pr/opened")!.data!.pr).toBe("PR1")
    await bay.dispatch({ type: "enqueue", args: { target: "t3", pr: "PR9" } })
    const b = await bay.dispatch({ type: "enqueue", args: { target: "t4" } })
    expect(b.events.find((e) => e.name === "pr/opened")!.data!.pr).toBe("PR10")
  })

  it("throws on a missing/blank target", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    await expect(bay.dispatch({ type: "enqueue", args: {} })).rejects.toThrow(/'target'.*required/)
    await expect(bay.dispatch({ type: "enqueue", args: { target: "  " } })).rejects.toThrow(/'target'.*required/)
  })

  it("throws on a duplicate pr id (PR numbers are unique)", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    await bay.dispatch({ type: "enqueue", args: { target: "t1", pr: "PR7" } })
    await expect(
      bay.dispatch({ type: "enqueue", args: { target: "t2", pr: "PR7" } }),
    ).rejects.toThrow(/'PR7' already exists/)
  })
})

describe("withQueue — FIFO ordering", () => {
  it("queuedPrs returns queued PRs in enqueue order across 3", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    for (const t of ["A", "B", "C"]) {
      await bay.dispatch({ type: "enqueue", args: { target: t } })
    }
    const queued = queuedPrs(await bay.state())
    expect(queued.map((c) => c.id)).toEqual(["PR1", "PR2", "PR3"])
    // and the slice order matches
    expect(slice(await bay.state()).order).toEqual(["PR1", "PR2", "PR3"])
  })
})

describe("withQueue — requeue validation (illegal transition throws)", () => {
  it("throws requeueing an unknown PR", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    await expect(bay.dispatch({ type: "requeue", args: { pr: "PR99" } })).rejects.toThrow(
      /no PR 'PR99'/,
    )
  })

  it("throws requeueing a still-queued PR (queued → queued is illegal)", async () => {
    const bay = await buildQueueBay(await tmpJournalPath())
    await bay.dispatch({ type: "enqueue", args: { target: "t1", pr: "PR1" } })
    await expect(bay.dispatch({ type: "requeue", args: { pr: "PR1" } })).rejects.toThrow(
      /illegal PR transition queued → queued/,
    )
    // the illegal op left state untouched — no silent overwrite
    expect(stateOf(await bay.state(), "PR1")).toBe("queued")
  })
})

describe("withQueue — replay", () => {
  it("a fresh bay over the same journal folds to identical PRs + slice", async () => {
    const path = await tmpJournalPath()
    const first = await buildQueueBay(path)
    await first.dispatch({ type: "enqueue", args: { target: "A" } })
    await first.dispatch({ type: "enqueue", args: { target: "B" } })
    const live = await first.state()

    // Fresh createGitbay + fresh store handle over the SAME journal file — proves
    // replay (not the live fold cache) reconstructs identical state.
    const replayed = await (await buildQueueBay(path)).state()

    expect(replayed.prs).toEqual(live.prs)
    expect(slice(replayed)).toEqual(slice(live))
    expect(slice(replayed).order).toEqual(["PR1", "PR2"])
  })
})
