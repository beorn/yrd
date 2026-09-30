/**
 * @failure  yrd watch feedback points 2-5: list column filters, separate runner top lines, wide view flush detail pane, and blank line under stage tabs
 * @level    l2
 * @consumer @yrd/yrd-cli
 * @testonly none
 */

import React from "react"
import { describe, expect, it } from "vitest"
import { bufferToStyledText, render } from "silvery/test"
import { WatchPane, type WatchSnapshot } from "../src/watch-pane.tsx"
import { TopLine } from "../src/watch-list.tsx"
import { NowContext, MinuteContext } from "../src/watch-clock.ts"
import { RUNNER_GLYPH } from "../src/watch-format.ts"
import { STATE_WORDS } from "../src/watch-words.ts"
import type { WatchRow } from "../src/watch-rows.ts"
import type { Row } from "@yrd/queue-core"

const NOW = new Date("2026-09-30T15:20:00.000Z")

function sampleRow(): Row {
  return {
    branch: "task/feature-abc",
    head: "1234567890abcdef1234567890abcdef12345678",
    since: new Date(NOW.getTime() - 3_600_000),
    at: NOW,
    state: "failed",
    subject: "sample failed row",
    reason: "affected-tests failed",
    result: "fail affected-tests",
    run: "q-20260930T150000000Z-test",
    submitter: "@dev/1",
  }
}

function baseSnapshot(overrides: Partial<WatchSnapshot> = {}): WatchSnapshot {
  const rows: WatchRow[] = [{ row: sampleRow() }]
  return {
    queue: "github.com/beorn/hh-dev#main",
    queues: [{ branch: "main", label: "/repo", path: "/repo" }],
    rows,
    unfiltered: rows,
    at: NOW,
    runner: {
      journalDir: "/w/logs",
      service: { kind: "beating", state: "healthy" },
      latest: {
        id: "run-live-1",
        startedAt: new Date(NOW.getTime() - 15_000),
        lastWriteAt: NOW,
        alive: true,
        checks: ["lint"],
        effectiveChecks: ["lint"],
        activeStep: {
          kind: "step",
          name: "prepare",
          phase: "provisioning",
          start: new Date(NOW.getTime() - 7_000),
        },
        steps: [],
      },
    },
    ...overrides,
  }
}

describe("yrd watch feedback: points 2, 3, 4, 5", () => {
  it("point 3: single runner top line has runner glyph, no [1], YRD QUEUE (no YRD RUNNING), and matching runner color", () => {
    const snapshot = baseSnapshot()
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <WatchPane snapshot={snapshot} live={false} />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      { cols: 140, rows: 50 },
    )

    const lines = app.lines
    const topLine = lines[0] ?? ""

    // Marker is RUNNER_GLYPH (▸)
    expect(topLine).toContain(RUNNER_GLYPH)

    // Single runner has no [1]
    expect(topLine).not.toMatch(/\[1\]/)

    // Uses YRD QUEUE, not YRD RUNNING
    expect(topLine).toContain("YRD QUEUE")
    expect(topLine).not.toContain("YRD RUNNING")

    // The top line marker has the runner's status color (STATE_WORDS.provisioning.color)
    const markerIdx = topLine.indexOf(RUNNER_GLYPH)
    expect(markerIdx).toBeGreaterThanOrEqual(0)
    const cell = app.cell(markerIdx, 0)
    expect(cell.fg).toBeDefined()

    app.unmount()
  })

  it("point 3: multiple runners render separate top lines, each with its [n]", () => {
    const snapshot = baseSnapshot({
      queues: [
        { branch: "main", label: "github.com/beorn/hh-dev#main", path: "/hh/dev" },
        { branch: "main", label: "github.com/beorn/hh-pm#main", path: "/hh/pm" },
      ],
    })

    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <WatchPane snapshot={snapshot} live={false} />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      { cols: 140, rows: 50 },
    )

    const lines = app.lines
    // Must NOT have crammed [1] [2] YRD RUNNING
    expect(app.text).not.toContain("[1] [2] YRD RUNNING")
    expect(app.text).not.toContain("[1] [2]")

    // Must have separate top lines for runner 1 and runner 2
    const runner1Line = lines.find((l) => l.includes("[1]") && l.includes("YRD QUEUE"))
    const runner2Line = lines.find((l) => l.includes("[2]") && l.includes("YRD QUEUE"))

    expect(runner1Line).toBeDefined()
    expect(runner2Line).toBeDefined()
    expect(runner1Line).toContain("hh-dev")
    expect(runner2Line).toContain("hh-pm")

    app.unmount()
  })

  it("points 2 & 4: in wide view, detail pane is flush to top and filters stay inside list column", async () => {
    const snapshot = baseSnapshot()
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <WatchPane
            snapshot={snapshot}
            live={false}
            open={async () => ({
              row: snapshot.rows[0]!.row,
              run: {
                id: "run-live-1",
                kind: "queue",
                label: "main",
                row: snapshot.rows[0]!.row,
                steps: [],
              },
              checks: [],
            })}
          />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      { cols: 240, rows: 50 },
    )

    await app.waitForLayoutStable()
    app.press("ArrowDown")
    await app.waitForLayoutStable()
    app.press("Enter")
    await app.waitForLayoutStable()

    const lines = app.lines

    // Point 2: Filters ([o]pen ... [f]ailed) must be inside list column (< 156 cols at 240 width with ratio 0.65)
    const pillsLineIdx = lines.findIndex((l) => l.includes("[o]pen") && l.includes("[f]ailed"))
    expect(pillsLineIdx).toBeGreaterThanOrEqual(0)
    const pillsLine = lines[pillsLineIdx]!
    const failedX = pillsLine.indexOf("[f]ailed")
    expect(failedX).toBeGreaterThanOrEqual(0)
    expect(failedX).toBeLessThan(156) // List column is ~156 cols; filters must NOT float in right detail pane (> 160)

    // Point 4: Detail pane is flush to the top (row 0 in right column has detail box header)
    const line0 = lines[0]!
    // Right half of line 0 (after list column 156) should contain detail content (e.g. status box RUN or border)
    const rightHalfLine0 = line0.slice(156)
    expect(rightHalfLine0).toMatch(/[╭─╮│RUN]/u)

    app.unmount()
  })

  it("point 5: one-line gap between stage tabs and the content below them", async () => {
    const snapshot = baseSnapshot()
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <WatchPane
            snapshot={snapshot}
            live={false}
            open={async () => ({
              row: snapshot.rows[0]!.row,
              run: {
                id: "run-live-1",
                kind: "queue",
                label: "main",
                row: snapshot.rows[0]!.row,
                steps: [],
              },
              checks: [],
            })}
          />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      { cols: 140, rows: 50 },
    )

    await app.waitForLayoutStable()
    app.press("ArrowDown")
    await app.waitForLayoutStable()
    app.press("Enter")
    await app.waitForLayoutStable()

    const lines = app.lines
    const tabsLineIdx = lines.findIndex((l) => l.includes("Timeline"))
    expect(tabsLineIdx).toBeGreaterThanOrEqual(0)
    // Tab bar has 2 lines: line 1 has tab labels, line 2 has attempt count and status
    expect(lines[tabsLineIdx + 1]).toContain("attempt")

    // Point 5: The line immediately below the tabs (tabsLineIdx + 3, after tab bottom padding)
    // must be a blank line (one-line gap under the filled tabs)
    const gapLine = lines[tabsLineIdx + 3]
    expect(gapLine).toBeDefined()
    expect(gapLine!.trim()).toBe("")

    // The line below the gap line should have the detail content
    const contentLine = lines[tabsLineIdx + 4]
    expect(contentLine).toBeDefined()
    expect(contentLine!.trim()).toContain("Submitted")

    app.unmount()
  })
})
