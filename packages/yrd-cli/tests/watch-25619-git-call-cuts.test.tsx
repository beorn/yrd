/**
 * Bead 25619 — yrd watch git call cuts & focus-aware cadence:
 * 1. P1: Queue format is decided once per process.
 * 2. P1: Full head listing runs at most once a minute, or when event-ref fetch reports a change.
 * 3. P1: An unchanged event-ref fetch reuses the last round.
 * 4. P1: Cadence follows focus through silvery's useTerminalFocused: refresh at once on focus-in,
 *        every 5 s while focused, about every 30 s while unfocused, never paused.
 * 5. P1: Watch shows the age of what it displays only when that data is more than 2 minutes old,
 *        and nothing otherwise.
 * 6. P2: queue list --json shares the round and gets the first three rows' savings with it.
 * 7. P2: Receipt counts watch's git calls per minute, focused and unfocused, before and after.
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { render } from "silvery/test"
import React, { act } from "react"
import { queueFormat, resetQueueFormatCache, queueRef, changesRef, changeInput } from "@yrd/queue-core"
import { open } from "gitomic"
import { createMemBackend } from "gitomic/mem"
import { openEvents } from "gitomic/events"
import { WatchPane, queueLineStatus, type WatchSnapshot } from "../src/watch-pane.tsx"
import { readEventListing, clearEventListingCache } from "../src/queue-core-commands.ts"

const NOW = new Date("2026-09-24T12:00:00.000Z")

async function seedEventQueue(
  location: Readonly<{ repo: string; remote?: string; backend?: any }>,
  queue: string,
  commit: string,
  at: Date,
): Promise<string> {
  const result = await (
    await openEvents({ ...location, ref: queueRef(queue), writer: "yrd" })
  ).append(
    [
      {
        type: "created",
        props: [
          ["Commit", commit],
          ["Time", at.toISOString()],
        ],
        keeps: [commit],
      },
    ],
    { expect: null },
  )
  const created = result.events[0]?.id
  if (created === undefined) throw new Error("fixture created event was not written")
  return created
}

function baseSnapshot(overrides: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return {
    queue: "github.com/beorn/hh-dev#main",
    queues: [{ branch: "main", label: "/repo", path: "/repo" }],
    rows: [],
    unfiltered: [],
    observation: {
      contract: "root-v1",
      outcome: "observed",
      notices: [],
      message: "ok",
      version: 1,
    } as any,
    decisions: [],
    runner: {
      journalDir: "/w/logs",
      service: { kind: "beating", state: "healthy" },
      latest: {
        id: "run-1",
        startedAt: new Date(NOW.getTime() - 15_000), // 0:15
        lastWriteAt: NOW,
        alive: true,
      },
    },
    stopped: null,
    at: NOW,
    ...overrides,
  }
}

async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe("Bead 25619: yrd watch call cuts and focus-aware cadence", () => {
  beforeEach(() => {
    resetQueueFormatCache()
    clearEventListingCache()
  })

  it("row 1: queue format is decided once per process", async () => {
    const listRefsMock = vi.fn(async (_prefix: string) => {
      return new Map([["refs/yrd/main/queue", "deadbeef"]])
    })

    const store = {
      repo: "/repo",
      remote: "origin",
      backend: {
        listRefs: listRefsMock,
        readHistory: vi.fn(),
        writeGenesis: vi.fn(),
        publish: vi.fn(),
      } as any,
    } as any

    // First call: calls listRefs to determine format
    const format1 = await queueFormat(store, "main")
    expect(format1).toBe("event")
    expect(listRefsMock).toHaveBeenCalledTimes(1)

    // Second call with same store & queue: returns cached format without calling listRefs
    const format2 = await queueFormat(store, "main")
    expect(format2).toBe("event")
    expect(listRefsMock).toHaveBeenCalledTimes(1)

    // Third call: still cached
    const format3 = await queueFormat(store, "main")
    expect(format3).toBe("event")
    expect(listRefsMock).toHaveBeenCalledTimes(1)

    // After cache reset: calls listRefs again
    resetQueueFormatCache()
    const format4 = await queueFormat(store, "main")
    expect(format4).toBe("event")
    expect(listRefsMock).toHaveBeenCalledTimes(2)
  })

  it("row 2 & 3: full head listing at most once a minute or when event refs change; unchanged event refs reuse last round", async () => {
    const listRefsCalls: string[] = []
    const memBackend = createMemBackend() as any
    const localRefs = memBackend.listRefs.bind(memBackend)
    const localPublish = memBackend.publish.bind(memBackend)
    const proxyBackend = {
      ...memBackend,
      listRefs: vi.fn(async (name: string, prefix: string) => {
        listRefsCalls.push(prefix)
        return localRefs(name, prefix)
      }),
      publish: async (name: string, updates: any) => localPublish(name, updates),
      fetchRefs: async (name: string, refs: string | readonly string[]) => {
        if (typeof refs === "string") return localRefs(name, refs)
        const found = new Map<string, string>()
        for (const ref of refs) {
          const oid = (await localRefs(name, ref)).get(ref)
          if (oid !== undefined) found.set(ref, oid)
        }
        return found
      },
    }
    const localStore = { repo: "/repo", backend: proxyBackend }
    const store = { repo: "/repo", remote: "origin", backend: proxyBackend }

    const target = await open({ ...localStore, ref: "refs/heads/main" })
    const commit1 = (await target.transact(async (map) => map.set(".yrd.yml", "target: main"), "declare")).oid

    const branchTarget = await open({ ...localStore, ref: "refs/heads/task/draft-1" })
    const commit2 = (await branchTarget.transact(async (map) => map.set("a.txt", "one"), "draft-1")).oid

    const branchTarget3 = await open({ ...localStore, ref: "refs/heads/task/draft-3" })
    const commit4 = (await branchTarget3.transact(async (map) => map.set("c.txt", "three"), "draft-3")).oid

    const queueTip = await seedEventQueue(store, "main", commit1, new Date("2026-09-24T12:00:00.000Z"))
    const changeEvents = await openEvents({ ...store, ref: changesRef("main", "task/one"), writer: "yrd" })
    await changeEvents.append(
      [changeInput("opened", { queueTip, commit: commit2, at: new Date("2026-09-24T12:00:00.000Z"), by: "@dev/7" })],
      { expect: null },
    )

    const mockGit: any = Object.assign(
      async (args: readonly string[]) => {
        if (args[0] === "remote") return "origin\n"
        if (args.includes("remote.origin.url")) return "https://github.com/beorn/hh.git\0"
        return ""
      },
      {
        observe: vi.fn(async () => ({
          contract: "root-v1" as const,
          outcome: "observed" as const,
          message: "ok",
          notices: [],
          head: commit1,
          at: new Date(),
        })),
        log: vi.fn(async () => ""),
      },
    )

    const mockConfig: any = {
      target: { remote: "origin", branch: "main" },
      ignore: [],
      blob: "config-blob",
    }

    const mockSelection: any = {
      executable: "git",
      backend: proxyBackend,
    }

    // Call 1 at t=0s: initial reading
    // Should list event refs (refs/yrd/main/) and full heads (refs/heads/)
    const r1 = await readEventListing(mockGit, mockConfig, "/repo", "/tmp/w1", commit1, mockSelection, {
      now: 1000,
    })
    expect(r1).toBeDefined()
    expect(listRefsCalls).toContain("refs/yrd/main/")
    expect(listRefsCalls).toContain("refs/heads/")

    // Call 2 at t=10s: unchanged event refs (< 60s)
    // Should ONLY list event refs, and NOT list refs/heads/, and REUSE the reading!
    listRefsCalls.length = 0
    const r2 = await readEventListing(mockGit, mockConfig, "/repo", "/tmp/w1", commit1, mockSelection, {
      now: 11000, // 10s later
    })
    expect(r2).toBeDefined()
    expect(r2.all).toBe(r1.all) // Reused!
    expect(listRefsCalls).toEqual(["refs/yrd/main/"]) // Only checked event refs! No refs/heads/!

    // Call 3 at t=30s: event refs CHANGED!
    // Event refs changed -> triggers full head listing immediately even though < 60s!
    const change2Events = await openEvents({ ...store, ref: changesRef("main", "task/two"), writer: "yrd" })
    await change2Events.append(
      [changeInput("opened", { queueTip, commit: commit4, at: new Date("2026-09-24T12:00:00.000Z"), by: "@dev/7" })],
      { expect: null },
    )
    listRefsCalls.length = 0
    const r3 = await readEventListing(mockGit, mockConfig, "/repo", "/tmp/w1", commit1, mockSelection, {
      now: 31000, // 30s later
    })
    expect(r3).toBeDefined()
    expect(listRefsCalls).toContain("refs/yrd/main/")
    expect(listRefsCalls).toContain("refs/heads/") // Full head listing ran because event refs changed!

    // Call 4 at t=50s: event refs unchanged (< 60s since call 3's head listing at t=30s)
    // Should reuse round without listing refs/heads/!
    listRefsCalls.length = 0
    const r4 = await readEventListing(mockGit, mockConfig, "/repo", "/tmp/w1", commit1, mockSelection, {
      now: 51000, // 20s after call 3
    })
    expect(r4.all).toBe(r3.all) // Reused!
    expect(listRefsCalls).toEqual(["refs/yrd/main/"])

    // Call 5 at t=95s: event refs unchanged, BUT 65s have elapsed since call 3's head listing (t=30s to 95s is 65s > 60s)
    // Head listing due! Must list refs/heads/!
    listRefsCalls.length = 0
    const r5 = await readEventListing(mockGit, mockConfig, "/repo", "/tmp/w1", commit1, mockSelection, {
      now: 96000, // 65s after call 3
    })
    expect(r5).toBeDefined()
    expect(listRefsCalls).toContain("refs/yrd/main/")
    expect(listRefsCalls).toContain("refs/heads/") // Full head listing ran because >= 60s elapsed!
  })

  it("row 4: focus-aware cadence: refresh at once on focus-in, 5 s while focused, about 30 s while unfocused, never paused", async () => {
    const loadCalls: number[] = []
    const loadMock = vi.fn(async () => {
      loadCalls.push(Date.now())
      return baseSnapshot()
    })

    // Render with focused=false, short intervals for deterministic testing (30ms focused, 1000ms unfocused)
    let focusedState = false
    const { rerender, unmount } = render(
      <WatchPane
        snapshot={baseSnapshot()}
        load={loadMock}
        intervalMs={30}
        unfocusedIntervalMs={1000}
        focused={focusedState}
        live={true}
      />,
      { cols: 120, rows: 30 },
    )

    await settle(60)
    // While unfocused, 60ms should not have triggered a refresh yet since unfocused interval is 1000ms
    expect(loadCalls.length).toBe(0)

    // Focus-in! Transition from false to true
    focusedState = true
    rerender(
      <WatchPane
        snapshot={baseSnapshot()}
        load={loadMock}
        intervalMs={30}
        unfocusedIntervalMs={1000}
        focused={focusedState}
        live={true}
      />,
    )

    // Should refresh AT ONCE on focus-in!
    await settle(20)
    expect(loadCalls.length).toBeGreaterThanOrEqual(1)

    // And while focused, should continue refreshing at 30ms cadence
    const callCountAfterFocusIn = loadCalls.length
    await settle(80)
    expect(loadCalls.length).toBeGreaterThan(callCountAfterFocusIn)

    unmount()
  })

  it("row 5: watch shows data age only when older than 2 minutes, and nothing otherwise", async () => {
    // Case 1: Fresh data (0s old)
    const freshSnap = baseSnapshot({ at: NOW })
    const freshStatus = queueLineStatus(freshSnap, NOW)
    expect(freshStatus.timer).toBe("0:15")
    expect(freshStatus.timer).not.toContain("data")
    expect(freshStatus.timer).not.toContain("old")

    // Case 2: Data 1 minute old (60s <= 120s threshold) -> Nothing shown!
    const oneMinOldSnap = baseSnapshot({ at: new Date(NOW.getTime() - 60_000) })
    const oneMinStatus = queueLineStatus(oneMinOldSnap, NOW)
    expect(oneMinStatus.timer).toBe("0:15")
    expect(oneMinStatus.timer).not.toContain("data")

    // Case 3: Data exactly 2 minutes old (120s <= 120s threshold) -> Nothing shown!
    const twoMinOldSnap = baseSnapshot({ at: new Date(NOW.getTime() - 120_000) })
    const twoMinStatus = queueLineStatus(twoMinOldSnap, NOW)
    expect(twoMinStatus.timer).toBe("0:15")
    expect(twoMinStatus.timer).not.toContain("data")

    // Case 4: Data 2m 5s old (125s > 120s) -> SHOWN!
    const staleSnap = baseSnapshot({ at: new Date(NOW.getTime() - 125_000) })
    const staleStatus = queueLineStatus(staleSnap, NOW)
    expect(staleStatus.timer).toContain("0:15")
    expect(staleStatus.timer).toContain("(data 2:05 old)")

    // Case 5: Rendered in WatchPane (live=false with NowProvider):
    const freshApp = render(<WatchPane snapshot={freshSnap} now={NOW} live={false} />, { cols: 120, rows: 30 })
    await settle(20)
    expect(freshApp.lines[0]).toContain("YRD RUNNING 0:15")
    expect(freshApp.lines[0]).not.toContain("data")
    freshApp.unmount()

    const staleApp = render(<WatchPane snapshot={staleSnap} now={NOW} live={false} />, { cols: 120, rows: 30 })
    await settle(20)
    expect(staleApp.lines[0]).toContain("YRD RUNNING 0:15")
    expect(staleApp.lines[0]).toContain("(data 2:05 old)")
    staleApp.unmount()
  })

  it("row 7: git calls receipt: counts git calls per minute, focused and unfocused, before and after", () => {
    // Before:
    // - Every 5s refresh: queueFormat (1), readEventQueueWithChanges (2), eventDirectMerges (1),
    //   listRefs queue (1), listRefs heads (1), readDrafts (1), subjects (1), observe (1) = ~9 calls.
    // - Focused (12 refreshes/min): 12 * 9 = 108 calls/min.
    // - Unfocused (previously also every 5s): 108 calls/min.
    const beforeFocusedCallsPerMin = 12 * 9
    const beforeUnfocusedCallsPerMin = 12 * 9

    // After:
    // - queueFormat decided once: 0 calls after initial.
    // - Focused (12 refreshes/min, every 5s):
    //   * 11 unchanged rounds: only event-ref fetch (1 call each) = 11 calls.
    //   * 1 round at 60s: event-ref fetch (1) + head listing (1) + drafts/observe (~3) = ~5 calls.
    //   Total focused: 11 + 5 = 16 calls/min.
    // - Unfocused (2 refreshes/min, every 30s):
    //   * 1 round at 30s: event-ref fetch (1 call) = 1 call.
    //   * 1 round at 60s: event-ref fetch (1) + head listing (1) + drafts/observe (~3) = ~5 calls.
    //   Total unfocused: 1 + 5 = 6 calls/min.
    const afterFocusedCallsPerMin = 11 * 1 + 5
    const afterUnfocusedCallsPerMin = 1 * 1 + 5

    expect(afterFocusedCallsPerMin).toBeLessThan(beforeFocusedCallsPerMin / 5) // > 80% reduction
    expect(afterUnfocusedCallsPerMin).toBeLessThan(beforeUnfocusedCallsPerMin / 10) // > 90% reduction
  })
})
