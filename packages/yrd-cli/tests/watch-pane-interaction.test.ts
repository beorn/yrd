/**
 * 21106 interaction/chrome slice — interaction contract.
 *
 * User respec 2026-07-15: clickable list rows (click = move cursor, detail
 * follows), wheel scrolls the list viewport without moving the selection,
 * wheel over the detail never activates a different run, divider drag with
 * min-size clamps, direct p/r/f/d status-filter toggles (pause/resume is
 * REMOVED — `p` toggles the pending bucket), clickable checkbox indicators
 * on the FILTER row, the exact keybinding footer, Enter/Esc show/hide of
 * the detail pane, and `o` jumping to the EVIDENCE section of the detail.
 */

import { createElement } from "react"
import { createRenderer, createTermless, waitFor } from "silvery/test"
import { run } from "silvery/runtime"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureSnapshot, queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import { queueLandingLabel } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const FOOTER = "q quit - enter/esc show/hide detail - p/r/f/d toggle filters - h/j/k/l navigate"

function rowIndexOf(text: string, needle: string): number {
  return text.split("\n").findIndex((row) => row.includes(needle))
}

function findGlyphColumn(term: ReturnType<typeof createTermless>, glyph: string, row: number): number {
  const columns = term.cols
  if (columns === undefined) throw new Error("Termless terminal is missing its column count")
  for (let column = 0; column < columns; column += 1) {
    if (term.cell(row, column).char === glyph) return column
  }
  return -1
}

describe("queueLandingLabel", () => {
  it("dedupes commit==landing SHAs to one SHA and keeps distinct pairs", () => {
    expect(queueLandingLabel("abcdef123456@abcdef123456")).toBe("abcdef123456")
    expect(queueLandingLabel("bbbbbbbbbbbb@aaaaaaaaaaaa")).toBe("bbbbbbbbbbbb@aaaaaaaaaaaa")
    expect(queueLandingLabel("-")).toBe("-")
  })
})

describe("QueueWatchFrame 21106 interaction", () => {
  it("renders the exact keybinding footer with pause/resume removed", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      const footer = rows.findLast((row) => row.trim() !== "")
      expect(footer?.trim()).toBe(FOOTER)
      expect(app.text).not.toContain("p pause")
      expect(app.text).not.toContain("PAUSED")
      expect(app.text).not.toContain("LIVE")
      // Detail facts: no raw ISO timestamps (timeline clock convention) and
      // no `-` placeholder facts anywhere in the watch surface.
      expect(app.text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u)
      expect(app.text).not.toContain(" EVIDENCE -")
      expect(app.text).not.toContain(" CHECKPOINT -")
      expect(app.text).not.toContain(" ERROR -")
      expect(app.text).not.toContain(" END -")
    } finally {
      app.unmount()
    }
  })

  it("selects a run by clicking its row and follows it in the detail pane", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("PRs PR42@r1"))

      const rowY = rowIndexOf(app.text, "PR4.1")
      const rowX = app.text.split("\n")[rowY]?.indexOf("PR4.1") ?? -1
      expect(rowY).toBeGreaterThan(0)
      expect(rowX).toBeGreaterThan(0)
      await app.click(rowX, rowY)
      await waitFor(() => app.text.includes("PRs PR4@r1"))
      expect(app.text).not.toContain("PRs PR42@r1")
    } finally {
      app.unmount()
    }
  })

  it("hovering a row does not switch the detail selection; clicking does (item P)", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    using term = createTermless({ cols: 200, rows: 50 })
    const handle = await run(createElement(QueueWatchFrame, { snapshot }), term, { mouse: true, selection: false })
    try {
      // Default cursor is the first running row (PR42), so the detail opens on it.
      await waitFor(() => term.screen.getText().includes("PRs PR42@r1"))
      const text = term.screen.getText()
      const row4Y = rowIndexOf(text, "PR4.1")
      const row4X = text.split("\n")[row4Y]?.indexOf("PR4.1") ?? -1
      expect(row4Y).toBeGreaterThan(0)
      expect(row4X).toBeGreaterThan(0)

      // Hover over PR4.1's row — the detail must STAY on PR42, not follow the pointer.
      await term.mouse.move(row4X, row4Y)
      await handle.waitForLayoutStable()
      expect(term.screen.getText(), "hover must not switch the detail selection").toContain("PRs PR42@r1")
      expect(term.screen.getText()).not.toContain("PRs PR4@r1")

      // Click PR4.1's row — NOW the detail follows the click to PR4.
      await term.mouse.down(row4X, row4Y)
      await term.mouse.up(row4X, row4Y)
      await waitFor(() => term.screen.getText().includes("PRs PR4@r1"))
      expect(term.screen.getText()).not.toContain("PRs PR42@r1")
    } finally {
      handle.unmount()
    }
  })

  it("wheel-scrolls the list viewport without moving the selection", async () => {
    const prs = Array.from({ length: 24 }, (_, index) =>
      fixturePr(`PR${index + 1}`, "submitted", `2026-07-13T11:${String(10 + index).padStart(2, "0")}:00.000Z`),
    )
    const snapshot = fixtureSnapshot(fixtureResult(prs, []), { rowLimit: 30 })
    const render = createRenderer({ cols: 200, rows: 28 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      // Default cursor: the first pending row; the detail pane follows it.
      await waitFor(() => app.text.includes("PR PR1 STATUS"))
      expect(app.text).toContain("PR1.1")
      expect(app.text).not.toContain("PR24.1")

      // Scope to the QUEUE list row (starts with a clock) — the DETAIL pane's
      // identity title also names PR1.1 (item M) and must not be wheeled.
      const listY = app.text
        .split("\n")
        .findIndex((row) => row.includes("PR1.1") && /^\s*\d{2}:\d{2}:\d{2}/u.test(row))
      const listX = (app.text.split("\n")[listY]?.indexOf("PR1.1") ?? 0) + 2
      for (let index = 0; index < 12; index += 1) await app.wheel(listX, listY, 3)
      await waitFor(() => app.text.includes("PR24.1"))
      // Contract literal: scrolling never activates a different run — the
      // detail pane still shows the selected pending PR1.
      expect(app.text).toContain("PR PR1 STATUS")
    } finally {
      app.unmount()
    }
  })

  it("keeps the selected run while wheel-scrolling inside the detail pane", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("PRs PR42@r1"))
      // The detail pane docks right; wheel well inside it.
      const detailX = 170
      const detailY = 20
      for (let index = 0; index < 8; index += 1) await app.wheel(detailX, detailY, 3)
      await app.waitForLayoutStable()
      expect(app.text).toContain("PRs PR42@r1")
    } finally {
      app.unmount()
    }
  })

  it("clamps divider drag at the panes' minimum sizes", async () => {
    const story = queueTimelineStories["mixed-completed"]
    using term = createTermless({ cols: 200, rows: 50 })
    const handle = await run(createElement(QueueWatchFrame, { snapshot: story.snapshot }), term, {
      mouse: true,
      selection: false,
    })
    try {
      await waitFor(() => term.screen.getText().includes("PRs PR3@r1"))
      const initialDivider = findGlyphColumn(term, "│", 0)
      expect(initialDivider).toBeGreaterThan(0)

      // Drag far past the list's minimum width: the divider must clamp at
      // the LIST natural width (80), never collapsing the list pane.
      await term.mouse.down(initialDivider, 1)
      await term.mouse.move(10, 1)
      await waitFor(() => findGlyphColumn(term, "│", 0) !== initialDivider)
      await term.mouse.up(10, 1)
      const clamped = findGlyphColumn(term, "│", 0)
      expect(clamped).toBeGreaterThanOrEqual(80)
      expect(clamped).toBeLessThan(initialDivider)
    } finally {
      handle.unmount()
    }
  })

  it("toggles status buckets with p/r/f/d and reflects them in the checkboxes", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("PR5.1")
      expect(app.text).toContain("[x] failed")

      await app.press("f")
      await waitFor(() => !app.text.includes("PR5.1"))
      expect(app.text).toContain("[ ] failed")

      await app.press("f")
      await waitFor(() => app.text.includes("PR5.1"))
      expect(app.text).toContain("[x] failed")

      await app.press("d")
      await waitFor(() => !app.text.includes("PR4.1"))
      expect(app.text).toContain("[ ] done")

      // `p` toggles the pending bucket — it never pauses.
      await app.press("p")
      await waitFor(() => !app.text.includes("Prepare release notes"))
      expect(app.text).not.toContain("PAUSED")
      await app.press("p")
      await app.press("d")
      await waitFor(() => app.text.includes("PR4.1"))
    } finally {
      app.unmount()
    }
  })

  it("toggles a status bucket by clicking its checkbox", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("PR42.1")
      const filterY = rowIndexOf(app.text, "[x] running")
      const filterX = app.text.split("\n")[filterY]?.indexOf("[x] running") ?? -1
      expect(filterY).toBeGreaterThan(0)
      expect(filterX).toBeGreaterThan(0)
      await app.click(filterX + 1, filterY)
      await waitFor(() => !app.text.includes("PR42.1"))
      expect(app.text).toContain("[ ] running")
    } finally {
      app.unmount()
    }
  })

  it("hides and shows the detail pane with Esc and Enter", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      // The detail pane is identity-headed now (item M), so its presence is
      // marked by the run detail body (`OUTCOME`), not the word "DETAIL".
      await waitFor(() => app.text.includes("OUTCOME"))

      await app.press("Escape")
      await waitFor(() => !app.text.includes("OUTCOME"))
      // Esc at top never quits; the list is still live.
      expect(app.text).toContain("QUEUE main")

      await app.press("Enter")
      await waitFor(() => app.text.includes("OUTCOME"))
    } finally {
      app.unmount()
    }
  })

  it("jumps to the expanded EVIDENCE section of the detail body with o", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("STEP check#"))
      // Evidence lives INSIDE the scrollable detail body as a collapsed
      // section; `o` expands it (and opens the detail when hidden).
      expect(app.text).not.toContain("EVIDENCE R42")

      await app.press("o")
      await waitFor(() => app.text.includes("EVIDENCE R42"))
      // A section of the detail body, not a replacement surface: the step
      // tabs stay visible alongside the evidence.
      expect(app.text).toContain("STEP check#")

      // Esc still only hides the detail pane; o reopens straight to evidence.
      await app.press("Escape")
      await waitFor(() => !app.text.includes("EVIDENCE R42"))
      await app.press("o")
      await waitFor(() => app.text.includes("EVIDENCE R42"))
      expect(app.text).toContain("STEP check#")
    } finally {
      app.unmount()
    }
  })
})
