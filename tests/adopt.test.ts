import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createBay,
  createJsonlJournal,
  pipe,
  queuedPrs,
  withMergeWorker,
  withQueue,
  withWorkspaces,
} from "../src/index.ts"
import type { BayRuntime, BayState, BayStore, PrId } from "../src/index.ts"
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

describe("withAdopt — mint + enqueue (the submit-a-branch reducer)", () => {
  it("mints the next sequential PR id, records the adoption, and enqueues FIFO behind existing entries", async () => {
    const bay = await buildAdoptBay(await tmpJournalPath())
    await bay.dispatch({ type: "enqueue", args: { target: "first-branch" } }) // PR1

    const { events } = await bay.dispatch({ type: "adopt", args: { branch: "legacy-x", name: "wi-x" } })

    const opened = events.find((e) => e.type === "pr.opened")!
    const prId = opened.data!.pr as PrId
    expect(prId).toBe("PR2") // sequential behind the enqueued PR1
    expect(opened.data!.target).toBe("legacy-x")

    const recorded = events.find((e) => e.type === "adopt.recorded")!
    expect(recorded.data).toMatchObject({ branch: "legacy-x", pr: prId, name: "wi-x" })

    const state = await bay.state()
    expect(queuedPrs(state).map((c) => c.id)).toEqual(["PR1", prId]) // FIFO behind existing
    expect(state.prs[prId]).toMatchObject({ id: prId, name: "wi-x", state: "queued" })
  })

  it("submits without a name (records name: null)", async () => {
    const bay = await buildAdoptBay(await tmpJournalPath())
    const { events } = await bay.dispatch({ type: "adopt", args: { branch: "legacy-y" } })
    const prId = events.find((e) => e.type === "pr.opened")!.data!.pr as PrId
    expect(events.find((e) => e.type === "adopt.recorded")!.data).toMatchObject({ name: null })
    expect((await bay.state()).prs[prId]!.name).toBeNull()
  })
})

describe("withAdopt — refusals", () => {
  it("throws on a double-submit, naming the tracking PR", async () => {
    const bay = await buildAdoptBay(await tmpJournalPath())
    await bay.dispatch({ type: "adopt", args: { branch: "legacy-x" } })
    await expect(bay.dispatch({ type: "adopt", args: { branch: "legacy-x" } })).rejects.toThrow(
      /already tracked by PR1/,
    )
  })

  it("throws submitting a branch that an OPEN worktree already owns", async () => {
    const path = await tmpJournalPath()
    // Seed an open lease (lease.opened, no lease.ended) for task/loaned.
    const journal = createJsonlJournal(path)
    await journal.append({
      v: 1, ts: TS, actor: ACTOR, type: "lease.opened", lease: "L1", pr: "PR1",
      data: { lease: "L1", bay: 1, workitem: "wi-x", changeId: "PR1", branch: "task/loaned" },
    })
    const bay = pipe(
      createBay({ store: openStore(path), clock: CLOCK, actor: ACTOR }),
      withWorkspaces(),
      withQueue(),
      withAdopt(),
    )
    await expect(bay.dispatch({ type: "adopt", args: { branch: "task/loaned" } })).rejects.toThrow(
      /already open in worktree wt1.*git push from that worktree submits it/s,
    )
  })

  it("submits a branch whose worktree already CLOSED (recovers a stray)", async () => {
    const path = await tmpJournalPath()
    const journal = createJsonlJournal(path)
    await journal.append({
      v: 1, ts: TS, actor: ACTOR, type: "lease.opened", lease: "L1", pr: "PR1",
      data: { lease: "L1", bay: 1, workitem: "wi-x", changeId: "PR1", branch: "task/abandoned" },
    })
    await journal.append({
      v: 1, ts: TS, actor: ACTOR, type: "lease.ended", lease: "L1", pr: "PR1",
      data: { lease: "L1", endReason: "abandoned" },
    })
    const bay = pipe(
      createBay({ store: openStore(path), clock: CLOCK, actor: ACTOR }),
      withWorkspaces(),
      withQueue(),
      withAdopt(),
    )
    const { events } = await bay.dispatch({ type: "adopt", args: { branch: "task/abandoned", name: "wi-x" } })
    const opened = events.find((e) => e.type === "pr.opened")!
    expect(opened).toBeDefined()
    // The closed worktree's pre-minted PR1 is burned: the recovered branch gets PR2.
    expect(opened.data!.pr).toBe("PR2")
  })

  it("throws on a missing branch", async () => {
    const bay = await buildAdoptBay(await tmpJournalPath())
    await expect(bay.dispatch({ type: "adopt", args: {} })).rejects.toThrow(/'branch'.*required/)
  })
})

describe("withAdopt — sequential ids", () => {
  it("mints PR1 in a fresh repo and the next number after existing PRs", async () => {
    const fresh = await buildAdoptBay(await tmpJournalPath())
    const first = await fresh.dispatch({ type: "adopt", args: { branch: "legacy-x" } })
    expect(first.events.find((e) => e.type === "pr.opened")!.data!.pr).toBe("PR1")
    const second = await fresh.dispatch({ type: "adopt", args: { branch: "legacy-y" } })
    expect(second.events.find((e) => e.type === "pr.opened")!.data!.pr).toBe("PR2")
  })
})

describe("withAdopt — replay", () => {
  it("a fresh bay over the same journal folds identical PRs + queue slice", async () => {
    const path = await tmpJournalPath()
    const first = await buildAdoptBay(path)
    await first.dispatch({ type: "enqueue", args: { target: "e1" } })
    await first.dispatch({ type: "adopt", args: { branch: "legacy-x", name: "wi-x" } })
    const live = await first.state()

    const replayed = await (await buildAdoptBay(path)).state()
    expect(replayed.prs).toEqual(live.prs)
    expect(queueSlice(replayed)).toEqual(queueSlice(live))
  })
})

describe("withAdopt — pipeline acceptance", () => {
  it("a submitted branch drains through the merge worker to merged", async () => {
    const bay = pipe(
      createBay({ store: openStore(await tmpJournalPath()), clock: CLOCK, actor: ACTOR }),
      withQueue(),
      withMergeWorker({ mergeCommand: "true" }), // trivial real command → exit 0 → merged
      withAdopt(),
    )
    const { events } = await bay.dispatch({ type: "adopt", args: { branch: "legacy-x", name: "wi-x" } })
    const prId = events.find((e) => e.type === "pr.opened")!.data!.pr as PrId

    await bay.dispatch({ type: "drain" })
    expect((await bay.state()).prs[prId]!.state).toBe("merged")
  })
})

describe("withAdopt — receiver seam (submit-then-push, no duplicate PR)", () => {
  it("a push of a submitted branch reuses the PR id — the retry-keeps-number contract", async () => {
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
    const { events } = await bay.dispatch({ type: "adopt", args: { branch: "legacy-y", name: "wi-y" } })
    const adoptedId = events.find((e) => e.type === "pr.opened")!.data!.pr

    await bay.dispatch({ type: "submit", args: { branch: "legacy-y", sha: "f".repeat(40) } })
    const state = await bay.state()
    expect(Object.keys(state.prs)).toEqual([adoptedId]) // ONE PR, the submitted one
    expect(state.prs[adoptedId as string]!.state).toBe("checking")
  })
})
