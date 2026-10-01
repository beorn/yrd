/**
 * @failure  yrd watch stops refreshing snapshots after first read or shunts single-queue watch to multi-queue view on initial read error
 * @level    l2
 * @consumer bead 26543 yrd watch freshness and moved-ref recovery
 * @testonly none
 */

import { describe, expect, it, vi } from "vitest"
import { bufferToText, render } from "silvery/test"
import type { Row } from "@yrd/queue-core"
import { WatchPane, type WatchSnapshot } from "../src/watch-pane.tsx"
import type { WatchRow } from "../src/watch-rows.ts"
import type { ChangeDetail } from "../src/watch-detail.tsx"
import { runOf } from "../src/watch-run.ts"

const NOW = new Date("2026-09-30T12:00:00.000Z")

function row(over: Partial<Row> = {}): Row {
  return {
    branch: "task/one",
    head: "abcdef0123456789abcdef0123456789abcdef01",
    since: new Date(NOW.getTime() - 3_600_000),
    state: "queued",
    subject: "fix the parser",
    ...over,
  }
}

function snapshot(over: Partial<WatchSnapshot> = {}): WatchSnapshot {
  const rows = over.rows ?? [{ row: row() }]
  return {
    at: NOW,
    queue: "github.com/beorn/hh-dev#main",
    queues: [{ branch: "main", label: "github.com/beorn/hh-dev#main", path: "/repo" }],
    ...over,
    rows,
    unfiltered: over.unfiltered ?? rows,
    stopped: null,
    decisions: [],
  }
}

function current(app: ReturnType<typeof render>): string {
  return bufferToText(app.freshRender())
}

async function waitFor<T>(callback: () => T | Promise<T>, timeout = 3000): Promise<T> {
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    try {
      return await callback()
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw last
}

describe("bead 26543: yrd watch snapshot freshness and error recovery", () => {
  it("AC1 & AC2: recovers from initial moved-ref read error and displays later queue readings", async () => {
    const snap1 = snapshot({
      at: NOW,
      rows: [{ row: row({ subject: "first completed reading" }) }],
    })
    const laterTime = new Date(NOW.getTime() + 10_000)
    const snap2 = snapshot({
      at: laterTime,
      rows: [{ row: row({ subject: "second completed reading" }) }],
    })

    let calls = 0
    const load = vi.fn(async () => {
      calls++
      if (calls === 1) return snap1
      return snap2
    })

    const app = render(
      <WatchPane
        snapshot={snapshot({ rows: [] })}
        sources={[
          {
            id: "code#main",
            label: "github.com/beorn/hh-dev#main",
            snapshot: undefined,
            error: "refs/yrd/main/changes/task/fixer-25686b moved during event list",
            load,
          },
        ]}
        intervalMs={20}
        unfocusedIntervalMs={20}
        live
      />,
      { cols: 200, rows: 40 },
    )

    // AC3: Initially names the failed read
    expect(current(app)).toContain("task/fixer-25686b moved during event list")
    expect(current(app)).toContain("⚠︎ the queue read failed")

    // AC2: Recovers from the moved-ref error and displays the first reading
    await waitFor(() => {
      expect(current(app)).toContain("first completed reading")
    })
    expect(current(app)).not.toContain("task/fixer-25686b moved during event list")

    // AC1: Displays a later completed queue reading after the first successful read
    await waitFor(() => {
      expect(current(app)).toContain("second completed reading")
    })

    app.unmount()
  })

  it("AC3: names failed reads in footer with timestamp of retained table, and names aging data", async () => {
    const snap1 = snapshot({
      at: new Date("2026-09-30T12:00:00.000Z"),
      rows: [{ row: row({ subject: "stable reading" }) }],
    })

    let calls = 0
    const load = vi.fn(async () => {
      calls++
      if (calls === 1) return snap1
      throw new Error("refs/heads/main moved during event list: read 111, observed 222")
    })

    const app = render(
      <WatchPane
        snapshot={snap1}
        sources={[
          {
            id: "code#main",
            label: "github.com/beorn/hh-dev#main",
            snapshot: snap1,
            load,
          },
        ]}
        intervalMs={20}
        unfocusedIntervalMs={20}
        live
      />,
      { cols: 200, rows: 40 },
    )

    // Wait for the failure to occur and verify the footer names the failure and retained table time
    await waitFor(() => {
      expect(current(app)).toContain("refs/heads/main moved during event list")
      expect(current(app)).toContain("the table is the")
      expect(current(app)).toContain("stable reading")
    })

    app.unmount()

    // Aging read test: when data is > 120s old, header explicitly displays (data X:XX old)
    const agedTime = new Date(NOW.getTime() - 130_000)
    const agedSnap = snapshot({
      at: agedTime,
      rows: [{ row: row({ subject: "aged reading" }) }],
    })

    const agedApp = render(<WatchPane snapshot={agedSnap} now={NOW} live={false} />, { cols: 200, rows: 40 })
    expect(current(agedApp)).toContain("(data 2:10 old)")
    agedApp.unmount()
  })

  it("AC4: live yrd watch at 200×40 shows two newer readings while stage controls work", async () => {
    const snap1 = snapshot({
      at: NOW,
      rows: [{ row: row({ branch: "task/alpha", subject: "alpha reading 1" }) }],
    })
    const snap2 = snapshot({
      at: new Date(NOW.getTime() + 5000),
      rows: [{ row: row({ branch: "task/alpha", subject: "alpha reading 2" }) }],
    })
    const snap3 = snapshot({
      at: new Date(NOW.getTime() + 10_000),
      rows: [{ row: row({ branch: "task/alpha", subject: "alpha reading 3" }) }],
    })

    let calls = 0
    const load = vi.fn(async () => {
      calls++
      if (calls === 1) return snap2
      return snap3
    })

    const open = vi.fn(
      async (targetRow: WatchRow): Promise<ChangeDetail> => ({
        row: targetRow.row,
        run: runOf(targetRow.row, "main", [], "run-1"),
        checks: [],
      }),
    )

    const app = render(
      <WatchPane
        snapshot={snap1}
        sources={[
          {
            id: "code#main",
            label: "github.com/beorn/hh-dev#main",
            snapshot: snap1,
            load,
            open,
          },
        ]}
        intervalMs={25}
        unfocusedIntervalMs={25}
        live
      />,
      { cols: 200, rows: 40 },
    )

    // Initial render shows snap1
    expect(current(app)).toContain("alpha reading 1")

    // Newer reading 1 (snap2)
    await waitFor(() => {
      expect(current(app)).toContain("alpha reading 2")
    })

    // Newer reading 2 (snap3)
    await waitFor(() => {
      expect(current(app)).toContain("alpha reading 3")
    })

    // Stage controls: open detail
    await app.press("Enter")
    await waitFor(() => {
      expect(current(app)).toContain("task/alpha")
    })

    // Close detail with Escape
    await app.press("Escape")
    await waitFor(() => {
      expect(current(app)).toContain("alpha reading 3")
    })

    app.unmount()
  })
})
