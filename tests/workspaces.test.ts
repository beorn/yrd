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
import { staleLeases } from "../src/layers/workspaces.ts"

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
          {
            lease: d.lease,
            path: `/fake/bays/bay${d.bay}`,
            branch: d.branch,
            baseSha: `base-sha-${d.bay}`,
            headSha: "0".repeat(40),
          },
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

function lastActive(state: BayState): Record<string, string> {
  return (state.slices.workspaces as WorkspacesSlice).lastActive
}

// A settable clock: fixed within a dispatch, advanced between dispatches so a
// lease can age past its TTL deterministically (no wall-clock, no sleeps).
function makeClock(initial: string) {
  let value = initial
  return { clock: () => value, set: (iso: string) => (value = iso) }
}

/** ISO for T0 (2024-01-01T00:00:00Z) + `ms`. */
function at(ms: number): string {
  return new Date(Date.parse("2024-01-01T00:00:00.000Z") + ms).toISOString()
}

async function buildTtlBay(
  path: string,
  clock: () => string,
  leaseTimeoutMs: number,
): Promise<BayRuntime> {
  return pipe(
    createBay({ store: openStore(path), clock, actor: ACTOR }),
    withStubGit, // registered first → its effect handlers shadow the real-git ones
    withWorkspaces({ leaseTimeoutMs }),
  )
}

describe("withWorkspaces — bay allocation (lowest free)", () => {
  it("allocates bay 1, then bay 2 while 1 is open, then reuses bay 1 after abandon", async () => {
    const bay = await buildStubBay(await tmpJournalPath())

    await bay.dispatch({ type: "co", args: { workitem: "wi-a" } })
    expect(bays(await bay.state())).toEqual({ 1: "L1" })
    const l1 = (await bay.state()).leases.L1!
    expect(l1.branch).toBe("task/wi-a")
    expect(l1.path).toBe("/fake/bays/bay1") // filled by provisioned
    expect(l1.baseSha).toBe("base-sha-1") // folded from the provisioned event
    expect(l1.actor).toBe(ACTOR) // folded from the lease.opened event envelope

    await bay.dispatch({ type: "co", args: { workitem: "wi-b" } })
    expect(bays(await bay.state())).toEqual({ 1: "L1", 2: "L2" })

    await bay.dispatch({ type: "abandon", args: { lease: "L1" } })
    const afterAbandon = await bay.state()
    expect(bays(afterAbandon)).toEqual({ 2: "L2" }) // bay 1 freed
    expect(afterAbandon.leases.L1!.endedAt).toBe("2024-01-01T00:00:00.000Z")
    expect(afterAbandon.leases.L1!.endReason).toBe("abandoned")

    await bay.dispatch({ type: "co", args: { workitem: "wi-c" } })
    const reused = await bay.state()
    expect(bays(reused)).toEqual({ 1: "L3", 2: "L2" }) // lowest free (1) reused, new lease L3
    expect(reused.leases.L3!.branch).toBe("task/wi-c")
  })

  it("mints a bay/<changeId> branch when no workitem is supplied", async () => {
    const bay = await buildStubBay(await tmpJournalPath())
    const { events } = await bay.dispatch({ type: "co" })
    const opened = events.find((e) => e.type === "lease.opened")!
    const changeId = opened.data!.changeId as string
    expect(changeId).toMatch(/^C-[0-9a-f]{8}$/)
    expect(opened.data!.branch).toBe(`bay/${changeId}`)
    expect((await bay.state()).leases.L1!.workitem).toBeNull()
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

describe("withWorkspaces — lease TTL (ping + gc)", () => {
  const TTL = 1000

  it("gc.clean (observable no-op) when nothing is stale", async () => {
    const bay = await buildTtlBay(await tmpJournalPath(), () => at(0), TTL)
    // no leases at all
    const empty = await bay.dispatch({ type: "gc" })
    expect(empty.events.map((e) => e.type)).toEqual(["gc.clean"])
    expect(empty.events[0]!.data).toMatchObject({ checked: 0, expired: 0, ttlMs: TTL })

    // a fresh (well-inside-TTL) lease is left untouched
    const c = makeClock(at(0))
    const bay2 = await buildTtlBay(await tmpJournalPath(), c.clock, TTL)
    await bay2.dispatch({ type: "co", args: { workitem: "wi-a" } })
    c.set(at(500)) // +500ms < TTL
    const clean = await bay2.dispatch({ type: "gc" })
    expect(clean.events.map((e) => e.type)).toEqual(["gc.clean"])
    expect(clean.events[0]!.data).toMatchObject({ checked: 1, expired: 0 })
    expect((await bay2.state()).leases.L1!.endedAt).toBeUndefined()
  })

  it("gc expires a lease idle past the TTL: lease.ended{expired} + retire, bay freed", async () => {
    const c = makeClock(at(0))
    const bay = await buildTtlBay(await tmpJournalPath(), c.clock, TTL)
    await bay.dispatch({ type: "co", args: { workitem: "wi-a" } }) // L1 created at T0

    c.set(at(2000)) // +2000ms > TTL
    const { events } = await bay.dispatch({ type: "gc" })
    expect(events.map((e) => e.type)).toEqual(["lease.ended", "workspace.retired"])
    const ended = events.find((e) => e.type === "lease.ended")!
    expect(ended.lease).toBe("L1")
    expect(ended.data!.endReason).toBe("expired")

    const st = await bay.state()
    expect(st.leases.L1!.endedAt).toBe(at(2000))
    expect(st.leases.L1!.endReason).toBe("expired")
    expect(bays(st)).toEqual({}) // bay 1 freed
  })

  it("expires several idle leases in one gc, freeing every bay", async () => {
    const c = makeClock(at(0))
    const bay = await buildTtlBay(await tmpJournalPath(), c.clock, TTL)
    await bay.dispatch({ type: "co", args: { workitem: "wi-a" } }) // L1
    await bay.dispatch({ type: "co", args: { workitem: "wi-b" } }) // L2

    c.set(at(2000))
    const { events } = await bay.dispatch({ type: "gc" })
    expect(events.filter((e) => e.type === "lease.ended").map((e) => e.lease)).toEqual(["L1", "L2"])
    expect(events.filter((e) => e.type === "workspace.retired").map((e) => e.lease)).toEqual(["L1", "L2"])

    const st = await bay.state()
    expect(st.leases.L1!.endReason).toBe("expired")
    expect(st.leases.L2!.endReason).toBe("expired")
    expect(bays(st)).toEqual({})
  })

  it("ping resets the idle window so gc leaves the lease alone until idle again", async () => {
    const c = makeClock(at(0))
    const bay = await buildTtlBay(await tmpJournalPath(), c.clock, TTL)
    await bay.dispatch({ type: "co", args: { workitem: "wi-a" } }) // L1 at T0

    c.set(at(800)) // still within TTL of T0
    await bay.dispatch({ type: "ping", args: { lease: "L1" } }) // lastActive = T0+800
    expect(lastActive(await bay.state()).L1).toBe(at(800))

    c.set(at(1500)) // +1500 from T0 but only +700 from the ping → NOT stale
    const survived = await bay.dispatch({ type: "gc" })
    expect(survived.events.map((e) => e.type)).toEqual(["gc.clean"])
    expect((await bay.state()).leases.L1!.endedAt).toBeUndefined()

    c.set(at(2000)) // +1200 from the ping → now stale
    const expired = await bay.dispatch({ type: "gc" })
    expect(expired.events.map((e) => e.type)).toEqual(["lease.ended", "workspace.retired"])
    expect((await bay.state()).leases.L1!.endReason).toBe("expired")
  })

  it("ping throws for an unknown or already-ended lease", async () => {
    const bay = await buildStubBay(await tmpJournalPath())
    await expect(bay.dispatch({ type: "ping", args: { lease: "L99" } })).rejects.toThrow(/no lease 'L99'/)
    await bay.dispatch({ type: "co", args: { workitem: "wi-a" } })
    await bay.dispatch({ type: "abandon", args: { lease: "L1" } })
    await expect(bay.dispatch({ type: "ping", args: { lease: "L1" } })).rejects.toThrow(/already ended/)
  })

  it("staleLeases is a pure predicate over open leases + lastActive", async () => {
    const c = makeClock(at(0))
    const bay = await buildTtlBay(await tmpJournalPath(), c.clock, TTL)
    await bay.dispatch({ type: "co", args: { workitem: "wi-a" } }) // L1
    await bay.dispatch({ type: "co", args: { workitem: "wi-b" } }) // L2
    c.set(at(500))
    await bay.dispatch({ type: "ping", args: { lease: "L2" } }) // L2 refreshed at +500
    const state = await bay.state()

    // At +1200: L1 (created T0) idle 1200 > TTL → stale; L2 (pinged +500) idle 700 → fresh.
    expect(staleLeases(state, at(1200), TTL).map((l) => l.id)).toEqual(["L1"])
    // At +1600: both stale (L2 idle 1100 > TTL).
    expect(staleLeases(state, at(1600), TTL).map((l) => l.id)).toEqual(["L1", "L2"])
    // Wide TTL: nothing stale.
    expect(staleLeases(state, at(9999), 60_000)).toEqual([])
  })

  it("replay reconstructs identical leases, bays, and lastActive after ping + gc", async () => {
    const path = await tmpJournalPath()
    const c = makeClock(at(0))
    const first = await buildTtlBay(path, c.clock, TTL)
    await first.dispatch({ type: "co", args: { workitem: "wi-a" } }) // L1
    await first.dispatch({ type: "co", args: { workitem: "wi-b" } }) // L2
    c.set(at(800))
    await first.dispatch({ type: "ping", args: { lease: "L1" } }) // L1 refreshed
    c.set(at(1500)) // L1 idle 700 (fresh); L2 idle 1500 (stale)
    await first.dispatch({ type: "gc" }) // expires L2 only
    const live = await first.state()

    expect(live.leases.L1!.endedAt).toBeUndefined()
    expect(live.leases.L2!.endReason).toBe("expired")
    expect(bays(live)).toEqual({ 1: "L1" }) // bay 2 freed, bay 1 held

    // Fresh bay over the same journal — clock is irrelevant to replay (fold reads
    // event ts from the journal), so any clock proves the point.
    const replayed = await (await buildTtlBay(path, () => at(0), TTL)).state()
    expect(replayed.leases).toEqual(live.leases)
    expect(bays(replayed)).toEqual(bays(live))
    expect(lastActive(replayed)).toEqual(lastActive(live))
  })
})

// Real-git integration tests, gated so the default suite stays hermetic.
// Enable with BAY_GIT_TESTS=1.
async function initGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "gitbay-realgit-"))
  for (const args of [
    ["-C", repo, "init", "-q"],
    ["-C", repo, "config", "user.email", "test@example.com"],
    ["-C", repo, "config", "user.name", "test"],
    ["-C", repo, "config", "commit.gpgsign", "false"],
  ]) {
    const r = await git(args)
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
  }
  await writeFile(join(repo, "README.md"), "hi\n")
  if ((await git(["-C", repo, "add", "-A"])).code !== 0) throw new Error("git add failed")
  if ((await git(["-C", repo, "commit", "-q", "-m", "init"])).code !== 0) throw new Error("git commit failed")
  return repo
}

describe.skipIf(!process.env.BAY_GIT_TESTS)("withWorkspaces — real git", () => {
  it("co provisions a real worktree, pins baseSha; abandon snapshots a findability ref and retires", async () => {
    const repo = await initGitRepo()
    try {
      const baysRoot = join(repo, ".bays")
      const bay = pipe(
        createBay({ store: openStore(join(repo, "journal.jsonl")), clock: CLOCK, actor: ACTOR }),
        withWorkspaces({ mainRepo: repo, baysRoot }),
      )

      await bay.dispatch({ type: "co", args: { workitem: "demo-1" } })
      const lease = (await bay.state()).leases.L1!
      const bayPath = join(baysRoot, "bay1")
      const repoHead = (await git(["-C", repo, "rev-parse", "HEAD"])).stdout.trim()

      expect(lease.path).toBe(bayPath)
      expect(lease.branch).toBe("task/demo-1")
      expect(lease.baseSha).toBe(repoHead) // pinned from the resolved base ref (HEAD; no origin/main)
      expect(existsSync(bayPath)).toBe(true)
      expect((await git(["-C", bayPath, "rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe("true")
      const head = (await git(["-C", bayPath, "rev-parse", "HEAD"])).stdout.trim()
      expect((await bay.state()).slices.workspaces as WorkspacesSlice).toMatchObject({ heads: { L1: head } })

      // Abandon: findability ref created at the branch tip, worktree removed,
      // branch itself untouched.
      const { events } = await bay.dispatch({ type: "abandon", args: { lease: "L1" } })
      const abandonedRef = `refs/bay/abandoned/${lease.changeId}`
      const retired = events.find((e) => e.type === "workspace.retired")!
      expect(retired.data!.abandonedRef).toBe(abandonedRef)
      expect((await git(["-C", repo, "rev-parse", abandonedRef])).stdout.trim()).toBe(repoHead)
      expect((await git(["-C", repo, "rev-parse", "--verify", "task/demo-1"])).code).toBe(0) // branch survives
      expect(existsSync(bayPath)).toBe(false)
      expect((await bay.state()).leases.L1!.endReason).toBe("abandoned")
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("wires the bay remote + push defaults; the second bay hits the set-url fallback", async () => {
    const repo = await initGitRepo()
    const remoteDir = await mkdtemp(join(tmpdir(), "gitbay-bare-"))
    try {
      expect((await git(["init", "--bare", "-q", remoteDir])).code).toBe(0)

      const baysRoot = join(repo, ".bays")
      const bay = pipe(
        createBay({ store: openStore(join(repo, "journal.jsonl")), clock: CLOCK, actor: ACTOR }),
        withWorkspaces({ mainRepo: repo, baysRoot, bayRemote: remoteDir }),
      )

      const assertWired = async (bayPath: string): Promise<void> => {
        expect((await git(["-C", bayPath, "config", "remote.bay.url"])).stdout.trim()).toBe(remoteDir)
        expect((await git(["-C", bayPath, "config", "remote.pushdefault"])).stdout.trim()).toBe("bay")
        expect((await git(["-C", bayPath, "config", "push.default"])).stdout.trim()).toBe("current")
      }

      // First bay: `remote add bay` path. `upstream: "bay"` in the event.
      const r1 = await bay.dispatch({ type: "co", args: { workitem: "wi-1" } })
      expect(r1.events.find((e) => e.type === "workspace.provisioned")!.data!.upstream).toBe("bay")
      await assertWired(join(baysRoot, "bay1"))

      // Second bay shares the repo config, so `remote add bay` now fails
      // "already exists" → the set-url fallback must keep it green.
      const r2 = await bay.dispatch({ type: "co", args: { workitem: "wi-2" } })
      expect(r2.events.find((e) => e.type === "workspace.provisioned")!.data!.upstream).toBe("bay")
      await assertWired(join(baysRoot, "bay2"))
    } finally {
      await rm(remoteDir, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })
})
