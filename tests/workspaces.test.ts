import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createBay,
  createJsonlJournal,
  definePlugin,
  makeEvent,
  pipe,
  withWorkspaces,
} from "../src/index.ts"
import type { BayEvent, BayRuntime, BayState, BayStore, WorkspacesSlice } from "../src/index.ts"
import { git } from "../src/layers/git.ts"

// Fixed fake clock + actor — determinism comes from the injected clock and the
// folded state, never from wall time or randomness (the reducer purity rule).
const CLOCK = () => "2024-01-01T00:00:00.000Z"
const ACTOR = "tester"

async function tmpJournalPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-workspaces-"))
  return join(dir, "journal.jsonl")
}

function openStore(path: string): BayStore {
  return { journal: createJsonlJournal(path), close: async () => {} }
}

// Stub git layer: satisfies the workspace.provision / workspace.retire effects
// with synthetic provisioned/retired events so pure transition tests never
// touch real git. It is registered BEFORE withWorkspaces because core.ts
// resolves effect handlers with `.find(Boolean)` over layers in REGISTRATION
// order — the FIRST registered layer whose effects has the key wins, so an
// override must come first (see the report's ordering finding).
const withStubGit = definePlugin({
  name: "stub-git",
  effects: {
    "workspace.provision": async (effect, bay) => {
      const d = effect.data as { lease: string; bay: number; branch: string; changeId: string }
      return [
        makeEvent(
          bay,
          "workspace.provisioned",
          { lease: d.lease, path: `/fake/bays/bay${d.bay}`, branch: d.branch, headSha: "0".repeat(40) },
          { lease: d.lease },
        ),
      ]
    },
    "workspace.retire": async (effect, bay) => {
      const d = effect.data as { lease: string; path: string }
      return [makeEvent(bay, "workspace.retired", { lease: d.lease, path: d.path }, { lease: d.lease })]
    },
  },
})

async function buildStubBay(path: string): Promise<BayRuntime> {
  return pipe(
    createBay({ store: openStore(path), clock: CLOCK, actor: ACTOR }),
    withStubGit, // registered first → its effect handlers shadow the real-git ones
    withWorkspaces(),
  )
}

function bays(state: BayState): Record<number, string> {
  return (state.slices.workspaces as WorkspacesSlice).byBay
}

describe("withWorkspaces — bay allocation (lowest free)", () => {
  it("allocates bay 1, then bay 2 while 1 is open, then reuses bay 1 after abandon", async () => {
    const bay = await buildStubBay(await tmpJournalPath())

    await bay.dispatch({ type: "co", args: { workitem: "wi-a" } })
    expect(bays(await bay.state())).toEqual({ 1: "L1" })
    expect((await bay.state()).leases.L1.branch).toBe("task/wi-a")
    expect((await bay.state()).leases.L1.path).toBe("/fake/bays/bay1") // filled by provisioned

    await bay.dispatch({ type: "co", args: { workitem: "wi-b" } })
    expect(bays(await bay.state())).toEqual({ 1: "L1", 2: "L2" })

    await bay.dispatch({ type: "abandon", args: { lease: "L1" } })
    const afterAbandon = await bay.state()
    expect(bays(afterAbandon)).toEqual({ 2: "L2" }) // bay 1 freed
    expect(afterAbandon.leases.L1.endedAt).toBe("2024-01-01T00:00:00.000Z")
    expect(afterAbandon.leases.L1.endReason).toBe("abandoned")

    await bay.dispatch({ type: "co", args: { workitem: "wi-c" } })
    const reused = await bay.state()
    expect(bays(reused)).toEqual({ 1: "L3", 2: "L2" }) // lowest free (1) reused, new lease L3
    expect(reused.leases.L3.branch).toBe("task/wi-c")
  })

  it("mints a bay/<changeId> branch when no workitem is supplied", async () => {
    const bay = await buildStubBay(await tmpJournalPath())
    const { events } = await bay.dispatch({ type: "co" })
    const opened = events.find((e) => e.type === "lease.opened")!
    const changeId = opened.data!.changeId as string
    expect(changeId).toMatch(/^C-[0-9a-f]{8}$/)
    expect(opened.data!.branch).toBe(`bay/${changeId}`)
    expect((await bay.state()).leases.L1.workitem).toBeNull()
  })
})

describe("withWorkspaces — abandon validation", () => {
  it("throws abandoning an unknown lease", async () => {
    const bay = await buildStubBay(await tmpJournalPath())
    await expect(bay.dispatch({ type: "abandon", args: { lease: "L99" } })).rejects.toThrow(
      /no lease 'L99'/,
    )
  })

  it("throws abandoning an already-ended lease", async () => {
    const bay = await buildStubBay(await tmpJournalPath())
    await bay.dispatch({ type: "co", args: { workitem: "wi-a" } })
    await bay.dispatch({ type: "abandon", args: { lease: "L1" } })
    await expect(bay.dispatch({ type: "abandon", args: { lease: "L1" } })).rejects.toThrow(
      /already ended/,
    )
  })
})

describe("withWorkspaces — determinism", () => {
  it("same command sequence + fixed clock → byte-identical events", async () => {
    const seq = async (bay: BayRuntime): Promise<BayEvent[]> => {
      const out: BayEvent[] = []
      for (const command of [
        { type: "co", args: { workitem: "wi-a" } },
        { type: "co", args: { workitem: "wi-b" } },
        { type: "abandon", args: { lease: "L1" } },
        { type: "co", args: { workitem: "wi-c" } },
      ]) {
        const { events } = await bay.dispatch(command)
        out.push(...events)
      }
      return out
    }

    const runA = await seq(await buildStubBay(await tmpJournalPath()))
    const runB = await seq(await buildStubBay(await tmpJournalPath()))
    expect(runA).toEqual(runB)
    // and the events are genuinely populated, not two empty arrays
    expect(runA.map((e) => e.type)).toEqual([
      "lease.opened",
      "workspace.provisioned",
      "lease.opened",
      "workspace.provisioned",
      "lease.ended",
      "workspace.retired",
      "lease.opened",
      "workspace.provisioned",
    ])
  })
})

describe("withWorkspaces — replay", () => {
  it("a fresh bay over the same journal folds to the same leases + bays", async () => {
    const path = await tmpJournalPath()
    const first = await buildStubBay(path)
    await first.dispatch({ type: "co", args: { workitem: "wi-a" } })
    await first.dispatch({ type: "co", args: { workitem: "wi-b" } })
    await first.dispatch({ type: "abandon", args: { lease: "L1" } })
    await first.dispatch({ type: "co", args: { workitem: "wi-c" } })
    const live = await first.state()

    // Fresh createBay + fresh store handle over the SAME journal file — proves
    // replay (not the live fold cache) reconstructs identical state.
    const replayed = await (await buildStubBay(path)).state()

    expect(replayed.leases).toEqual(live.leases)
    expect(bays(replayed)).toEqual(bays(live))
    expect(bays(replayed)).toEqual({ 1: "L3", 2: "L2" })
  })
})

// One real-git integration test, gated so the default suite stays hermetic.
// Enable with BAY_GIT_TESTS=1.
describe.skipIf(!process.env.BAY_GIT_TESTS)("withWorkspaces — real git", () => {
  it("co provisions a real worktree; abandon retires a clean one", async () => {
    const repo = await mkdtemp(join(tmpdir(), "gitbay-realgit-"))
    try {
      for (const args of [
        ["-C", repo, "init", "-q"],
        ["-C", repo, "config", "user.email", "test@example.com"],
        ["-C", repo, "config", "user.name", "test"],
        ["-C", repo, "config", "commit.gpgsign", "false"],
      ]) {
        const r = await git(args)
        expect(r.code).toBe(0)
      }
      await writeFile(join(repo, "README.md"), "hi\n")
      expect((await git(["-C", repo, "add", "-A"])).code).toBe(0)
      expect((await git(["-C", repo, "commit", "-q", "-m", "init"])).code).toBe(0)

      const baysRoot = join(repo, ".bays")
      const journalPath = join(repo, "journal.jsonl")
      const bay = pipe(
        createBay({ store: openStore(journalPath), clock: CLOCK, actor: ACTOR }),
        withWorkspaces({ mainRepo: repo, baysRoot }),
      )

      await bay.dispatch({ type: "co", args: { workitem: "demo-1" } })
      const lease = (await bay.state()).leases.L1
      const bayPath = join(baysRoot, "bay1")
      expect(lease.path).toBe(bayPath)
      expect(lease.branch).toBe("task/demo-1")
      expect(existsSync(bayPath)).toBe(true)
      expect((await git(["-C", bayPath, "rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe("true")
      // headSha recorded matches the worktree HEAD
      const head = (await git(["-C", bayPath, "rev-parse", "HEAD"])).stdout.trim()
      expect((await bay.state()).slices.workspaces as WorkspacesSlice).toMatchObject({ heads: { L1: head } })

      await bay.dispatch({ type: "abandon", args: { lease: "L1" } })
      expect(existsSync(bayPath)).toBe(false)
      expect((await bay.state()).leases.L1.endReason).toBe("abandoned")
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
