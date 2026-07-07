import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createBay,
  createJsonlJournal,
  pipe,
  queuedChangesets,
  withMergeWorker,
  withQueue,
  withWorkspaces,
} from "../src/index.ts"
import type { BayRuntime, BayState, BayStore, ChangeId } from "../src/index.ts"
import { withAdopt } from "../src/layers/adopt.ts"

const TS = "2024-01-01T00:00:00.000Z"
const CLOCK = () => TS
const ACTOR = "tester"

function openStore(path: string): BayStore {
  return { journal: createJsonlJournal(path), close: async () => {} }
}

async function tmpJournalPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-adopt-"))
  return join(dir, "journal.jsonl")
}

async function buildAdoptBay(path: string): Promise<BayRuntime> {
  return pipe(createBay({ store: openStore(path), clock: CLOCK, actor: ACTOR }), withQueue(), withAdopt())
}

function queueSlice(state: BayState): unknown {
  return state.slices.queue
}

describe("withAdopt — mint + enqueue", () => {
  it("mints a C-adopt-<hash> id, records the adoption, and enqueues FIFO behind existing entries", async () => {
    const bay = await buildAdoptBay(await tmpJournalPath())
    await bay.dispatch({ type: "enqueue", args: { target: "first-branch", changeId: "C-first" } })

    const { events } = await bay.dispatch({ type: "adopt", args: { branch: "legacy-x", workitem: "wi-x" } })

    const enqueued = events.find((e) => e.type === "changeset.enqueued")!
    const changeId = enqueued.data!.changeset as ChangeId
    expect(changeId).toMatch(/^C-adopt-[0-9a-f]{8}$/)
    expect(enqueued.data!.target).toBe("legacy-x")

    const recorded = events.find((e) => e.type === "adopt.recorded")!
    expect(recorded.data).toMatchObject({ branch: "legacy-x", changeId, workitem: "wi-x" })

    const state = await bay.state()
    expect(queuedChangesets(state).map((c) => c.id)).toEqual(["C-first", changeId]) // FIFO behind existing
    expect(state.changesets[changeId]).toMatchObject({ id: changeId, workitem: "wi-x", state: "queued" })
  })

  it("adopts without a workitem (records workitem: null)", async () => {
    const bay = await buildAdoptBay(await tmpJournalPath())
    const { events } = await bay.dispatch({ type: "adopt", args: { branch: "legacy-y" } })
    const changeId = events.find((e) => e.type === "changeset.enqueued")!.data!.changeset as ChangeId
    expect(events.find((e) => e.type === "adopt.recorded")!.data).toMatchObject({ workitem: null })
    expect((await bay.state()).changesets[changeId]!.workitem).toBeNull()
  })
})

describe("withAdopt — refusals", () => {
  it("throws on a double-adopt, naming the tracking changeset", async () => {
    const bay = await buildAdoptBay(await tmpJournalPath())
    await bay.dispatch({ type: "adopt", args: { branch: "legacy-x" } })
    await expect(bay.dispatch({ type: "adopt", args: { branch: "legacy-x" } })).rejects.toThrow(
      /already tracked by changeset C-adopt-/,
    )
  })

  it("throws adopting a branch that an OPEN lease already owns", async () => {
    const path = await tmpJournalPath()
    // Seed an open lease (lease.opened, no lease.ended) for task/loaned.
    const journal = createJsonlJournal(path)
    await journal.append({
      v: 1, ts: TS, actor: ACTOR, type: "lease.opened", lease: "L1", changeset: "C-x",
      data: { lease: "L1", bay: 1, workitem: "wi-x", changeId: "C-x", branch: "task/loaned" },
    })
    const bay = pipe(
      createBay({ store: openStore(path), clock: CLOCK, actor: ACTOR }),
      withWorkspaces(),
      withQueue(),
      withAdopt(),
    )
    await expect(bay.dispatch({ type: "adopt", args: { branch: "task/loaned" } })).rejects.toThrow(
      /already loaned \(lease L1/,
    )
  })

  it("adopts a branch whose lease already ENDED (recovers a stray)", async () => {
    const path = await tmpJournalPath()
    const journal = createJsonlJournal(path)
    await journal.append({
      v: 1, ts: TS, actor: ACTOR, type: "lease.opened", lease: "L1", changeset: "C-x",
      data: { lease: "L1", bay: 1, workitem: "wi-x", changeId: "C-x", branch: "task/abandoned" },
    })
    await journal.append({
      v: 1, ts: TS, actor: ACTOR, type: "lease.ended", lease: "L1", changeset: "C-x",
      data: { lease: "L1", endReason: "abandoned" },
    })
    const bay = pipe(
      createBay({ store: openStore(path), clock: CLOCK, actor: ACTOR }),
      withWorkspaces(),
      withQueue(),
      withAdopt(),
    )
    const { events } = await bay.dispatch({ type: "adopt", args: { branch: "task/abandoned", workitem: "wi-x" } })
    expect(events.find((e) => e.type === "changeset.enqueued")).toBeDefined()
  })

  it("throws on a missing branch", async () => {
    const bay = await buildAdoptBay(await tmpJournalPath())
    await expect(bay.dispatch({ type: "adopt", args: {} })).rejects.toThrow(/'branch'.*required/)
  })
})

describe("withAdopt — determinism", () => {
  it("same (clock, actor, branch) → same id; different branch → different id", async () => {
    const idFor = async (branch: string): Promise<string> => {
      const bay = await buildAdoptBay(await tmpJournalPath())
      const { events } = await bay.dispatch({ type: "adopt", args: { branch } })
      return events.find((e) => e.type === "changeset.enqueued")!.data!.changeset as string
    }
    expect(await idFor("legacy-x")).toBe(await idFor("legacy-x"))
    expect(await idFor("legacy-x")).not.toBe(await idFor("legacy-y"))
  })
})

describe("withAdopt — replay", () => {
  it("a fresh bay over the same journal folds identical changesets + queue slice", async () => {
    const path = await tmpJournalPath()
    const first = await buildAdoptBay(path)
    await first.dispatch({ type: "enqueue", args: { target: "e1", changeId: "C-e1" } })
    await first.dispatch({ type: "adopt", args: { branch: "legacy-x", workitem: "wi-x" } })
    const live = await first.state()

    const replayed = await (await buildAdoptBay(path)).state()
    expect(replayed.changesets).toEqual(live.changesets)
    expect(queueSlice(replayed)).toEqual(queueSlice(live))
  })
})

describe("withAdopt — pipeline acceptance", () => {
  it("an adopted changeset drains through the merge worker to merged", async () => {
    const bay = pipe(
      createBay({ store: openStore(await tmpJournalPath()), clock: CLOCK, actor: ACTOR }),
      withQueue(),
      withMergeWorker({ mergeCommand: "true" }), // trivial real command → exit 0 → merged
      withAdopt(),
    )
    const { events } = await bay.dispatch({ type: "adopt", args: { branch: "legacy-x", workitem: "wi-x" } })
    const changeId = events.find((e) => e.type === "changeset.enqueued")!.data!.changeset as ChangeId

    await bay.dispatch({ type: "drain" })
    expect((await bay.state()).changesets[changeId]!.state).toBe("merged")
  })
})

describe("withAdopt — receiver seam (adopt-then-push, no duplicate changeset)", () => {
  it("submit of an adopted branch reuses the adopted changeset id", async () => {
    const { withReceive } = await import("../src/layers/receive.ts")
    const stubSubmit = (bay0: ReturnType<typeof createBay>) =>
      bay0.use({ name: "stub-submit", effects: { "submit.run": async () => [] } })
    const bay = pipe(
      createBay({ store: openStore(await tmpJournalPath()), clock: CLOCK, actor: ACTOR }),
      stubSubmit, // registered first → wins effect resolution; keeps the test pure
      withQueue(),
      withAdopt(),
      withReceive(),
    )
    const { events } = await bay.dispatch({ type: "adopt", args: { branch: "legacy-y", workitem: "wi-y" } })
    const adoptedId = events.find((e) => e.type === "changeset.enqueued")!.data!.changeset

    await bay.dispatch({ type: "submit", args: { branch: "legacy-y", sha: "f".repeat(40) } })
    const state = await bay.state()
    expect(Object.keys(state.changesets)).toEqual([adoptedId]) // ONE changeset, the adopted one
    expect(state.changesets[adoptedId as string]!.state).toBe("checking")
  })
})
