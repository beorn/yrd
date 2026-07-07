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
} from "../src/index.ts"
import type { BayEvent, BayRuntime, BayState, BayStore, ChangeId, MergeWorkerOptions } from "../src/index.ts"

const CLOCK = () => "2024-01-01T00:00:00.000Z"
const ACTOR = "tester"

async function tmpJournalPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-merge-"))
  return join(dir, "journal.jsonl")
}

function openStore(path: string): BayStore {
  return { journal: createJsonlJournal(path), close: async () => {} }
}

// The merge worker runs the REAL effect handler against trivial shell commands
// (`true` / `false` / `echo`), so there are no mocks — the config resolution,
// sh -c spawn, exit-code→state mapping, and detail capture all execute for real.
async function buildMergeBay(path: string, opts: MergeWorkerOptions): Promise<BayRuntime> {
  return pipe(
    createBay({ store: openStore(path), clock: CLOCK, actor: ACTOR }),
    withQueue(),
    withMergeWorker(opts),
  )
}

function stateOf(state: BayState, id: ChangeId): string {
  return state.changesets[id]!.state
}

function detailOf(events: BayEvent[], to: string): string | undefined {
  const ev = events.find((e) => e.type === "changeset.state-changed" && e.data!.to === to)
  return ev?.data!.detail as string | undefined
}

describe("withMergeWorker — drain → merged (happy path)", () => {
  it("transitions queued → merging → merged and captures stdout (both placeholders) as detail", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "echo {changeset} {target}" })
    await bay.dispatch({ type: "enqueue", args: { target: "task/x", changeId: "C-x" } })

    const { events } = await bay.dispatch({ type: "drain" })

    const transitions = events
      .filter((e) => e.type === "changeset.state-changed")
      .map((e) => `${e.data!.from}→${e.data!.to}`)
    expect(transitions).toEqual(["queued→merging", "merging→merged"])
    expect(detailOf(events, "merged")).toBe("C-x task/x") // {changeset} {target} both substituted
    expect(stateOf(await bay.state(), "C-x")).toBe("merged")
  })
})

describe("withMergeWorker — drain → rejected (non-zero is a domain outcome, not a crash)", () => {
  it("a non-zero merge command rejects with the exit code in detail (never throws)", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "false" })
    await bay.dispatch({ type: "enqueue", args: { target: "t", changeId: "C-r" } })

    const { events } = await bay.dispatch({ type: "drain" }) // resolves, does NOT reject
    expect(detailOf(events, "rejected")).toBe("exit 1")
    expect(stateOf(await bay.state(), "C-r")).toBe("rejected")
  })

  it("captures the stderr tail alongside the exit code", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "echo boom >&2; exit 3" })
    await bay.dispatch({ type: "enqueue", args: { target: "t", changeId: "C-e" } })

    const { events } = await bay.dispatch({ type: "drain" })
    expect(detailOf(events, "rejected")).toBe("exit 3: boom")
    expect(stateOf(await bay.state(), "C-e")).toBe("rejected")
  })
})

describe("withMergeWorker — serial FIFO drain", () => {
  it("each drain merges exactly the oldest queued changeset", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true" })
    for (const t of ["A", "B", "C"]) {
      await bay.dispatch({ type: "enqueue", args: { target: t, changeId: `C-${t}` } })
    }

    await bay.dispatch({ type: "drain" })
    let s = await bay.state()
    expect(stateOf(s, "C-A")).toBe("merged")
    expect(queuedChangesets(s).map((c) => c.id)).toEqual(["C-B", "C-C"]) // B, C still queued in order

    await bay.dispatch({ type: "drain" })
    expect(stateOf(await bay.state(), "C-B")).toBe("merged")

    await bay.dispatch({ type: "drain" })
    s = await bay.state()
    expect(stateOf(s, "C-C")).toBe("merged")
    expect(queuedChangesets(s)).toEqual([])
  })
})

describe("withMergeWorker — empty drain", () => {
  it("emits a queue.empty event and mutates no state", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true" })
    const { events } = await bay.dispatch({ type: "drain" })
    expect(events.map((e) => e.type)).toEqual(["queue.empty"])
    expect(Object.keys((await bay.state()).changesets)).toEqual([])
  })
})

describe("withMergeWorker — missing merge command", () => {
  it("throws a loud error naming the config key, and the queued→merging event stays durable", async () => {
    const saved = process.env.BAY_MERGE_COMMAND
    delete process.env.BAY_MERGE_COMMAND
    try {
      const path = await tmpJournalPath()
      const configCwd = await mkdtemp(join(tmpdir(), "gitbay-noconfig-")) // not a git repo → bay.mergeCommand unset
      const bay = await buildMergeBay(path, { configCwd })
      await bay.dispatch({ type: "enqueue", args: { target: "t", changeId: "C-m" } })

      await expect(bay.dispatch({ type: "drain" })).rejects.toThrow(/merge command not configured/)
      // Journal-first: the queued→merging event was durable before the effect ran
      // and threw — so the changeset is left `merging` (resumable), not lost.
      expect(stateOf(await bay.state(), "C-m")).toBe("merging")
    } finally {
      if (saved !== undefined) process.env.BAY_MERGE_COMMAND = saved
    }
  })
})

describe("withMergeWorker — resume-on-restart via replay + requeue", () => {
  it("a changeset stuck in merging replays as merging and is re-drained after requeue", async () => {
    const saved = process.env.BAY_MERGE_COMMAND
    delete process.env.BAY_MERGE_COMMAND
    try {
      const path = await tmpJournalPath()
      const configCwd = await mkdtemp(join(tmpdir(), "gitbay-noconfig-"))

      // Run 1: no command → drain throws mid-effect, leaving C-s durable in `merging`.
      const bay1 = await buildMergeBay(path, { configCwd })
      await bay1.dispatch({ type: "enqueue", args: { target: "task/s", changeId: "C-s" } })
      await expect(bay1.dispatch({ type: "drain" })).rejects.toThrow(/merge command not configured/)

      // Run 2 (restart): fresh bay over the SAME journal with a working command.
      // Replay reconstructs C-s in `merging` WITHOUT re-running any effect.
      const bay2 = await buildMergeBay(path, { mergeCommand: "true" })
      expect(stateOf(await bay2.state(), "C-s")).toBe("merging")

      // requeue resumes it (merging → queued); the next drain merges it.
      await bay2.dispatch({ type: "requeue", args: { changeset: "C-s" } })
      expect(stateOf(await bay2.state(), "C-s")).toBe("queued")
      await bay2.dispatch({ type: "drain" })
      expect(stateOf(await bay2.state(), "C-s")).toBe("merged")
    } finally {
      if (saved !== undefined) process.env.BAY_MERGE_COMMAND = saved
    }
  })
})
