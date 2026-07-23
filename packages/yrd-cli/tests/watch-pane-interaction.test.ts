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

function rowIndexOf(text: string, needle: string): number {
  return text.split("\n").findIndex((row) => row.includes(needle))
}

function detailTitleRow(text: string): string {
  return text.split("\n")[0] ?? ""
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
  it("removes the bottom keybindings footer and keeps the detail clean", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      // The bottom keybindings footer row is gone entirely (item h).
      expect(app.text).not.toContain("q quit")
      expect(app.text).not.toContain("⇧-drag")
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
      await waitFor(() => detailTitleRow(app.text).includes("pr#42.1"))

      const rowY = rowIndexOf(app.text, "pr#4.1")
      const rowX = app.text.split("\n")[rowY]?.indexOf("pr#4.1") ?? -1
      expect(rowY).toBeGreaterThan(0)
      expect(rowX).toBeGreaterThan(0)
      await app.click(rowX, rowY)
      await waitFor(() => detailTitleRow(app.text).includes("pr#4.1"))
      expect(detailTitleRow(app.text)).not.toContain("pr#42.1")
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
      await waitFor(() => detailTitleRow(term.screen.getText()).includes("pr#42.1"))
      const text = term.screen.getText()
      const row4Y = rowIndexOf(text, "pr#4.1")
      const row4X = text.split("\n")[row4Y]?.indexOf("pr#4.1") ?? -1
      expect(row4Y).toBeGreaterThan(0)
      expect(row4X).toBeGreaterThan(0)

      // Hover over pr#4.1's row — the detail must STAY on PR42, not follow the pointer.
      await term.mouse.move(row4X, row4Y)
      await handle.waitForLayoutStable()
      expect(detailTitleRow(term.screen.getText()), "hover must not switch the detail selection").toContain("pr#42.1")
      expect(detailTitleRow(term.screen.getText())).not.toContain("pr#4.1")

      // Click pr#4.1's row — NOW the detail follows the click to PR4.
      await term.mouse.down(row4X, row4Y)
      await term.mouse.up(row4X, row4Y)
      await waitFor(() => detailTitleRow(term.screen.getText()).includes("pr#4.1"))
      expect(detailTitleRow(term.screen.getText())).not.toContain("pr#42.1")
    } finally {
      handle.unmount()
    }
  })

  it("paints a hover-affordance background under the pointer, distinct from selection, and clears on leave (item P)", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      // Default cursor is the first running row (PR42); its detail is open.
      await waitFor(() => detailTitleRow(app.text).includes("pr#42.1"))
      const rows = app.text.split("\n")

      // A non-cursor QUEUE list row (clock-prefixed, so we never match the
      // identity-title row of the DETAIL pane).
      const isListRow = (needle: string) => (row: string) => row.includes(needle) && /^\s*\d{2}:\d{2}:\d{2}/u.test(row)
      const hoverY = rows.findIndex(isListRow("pr#4.1"))
      const hoverX = rows[hoverY]?.indexOf("pr#4.1") ?? -1
      const cursorY = rows.findIndex(isListRow("pr#42.1"))
      const cursorX = rows[cursorY]?.indexOf("pr#42.1") ?? -1
      expect(hoverY).toBeGreaterThan(0)
      expect(hoverX).toBeGreaterThan(0)
      expect(cursorY).toBeGreaterThan(0)

      // The cursor row carries a selection background; the non-cursor row is bare.
      const selectionBg = app.cell(cursorX, cursorY).bg
      expect(selectionBg, "cursor row carries a selection background").not.toBeNull()
      expect(app.cell(hoverX, hoverY).bg, "an un-hovered non-cursor row has no background").toBeNull()

      // Hover the non-cursor row: an affordance background appears...
      await app.hover(hoverX, hoverY)
      await app.waitForLayoutStable()
      const hoverBg = app.cell(hoverX, hoverY).bg
      expect(hoverBg, "the hovered row paints an affordance background").not.toBeNull()
      // ...it is the hover tint, NOT the selection background...
      expect(hoverBg, "hover affordance is distinct from selection").not.toEqual(selectionBg)
      // ...and hover never moves the cursor/detail (hover paints, click selects).
      expect(detailTitleRow(app.text), "hover must not switch the detail selection").toContain("pr#42.1")
      expect(detailTitleRow(app.text)).not.toContain("pr#4.1 ")
      expect(app.cell(cursorX, cursorY).bg, "cursor selection is unchanged by hover").toEqual(selectionBg)

      // Moving the pointer onto the cursor row clears the prior affordance
      // (transient) while selection still wins on the cursor row itself.
      await app.hover(cursorX, cursorY)
      await app.waitForLayoutStable()
      expect(app.cell(hoverX, hoverY).bg, "affordance clears when the pointer leaves the row").toBeNull()
      expect(app.cell(cursorX, cursorY).bg, "selection still wins over hover on the cursor row").toEqual(selectionBg)
    } finally {
      app.unmount()
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
      await waitFor(() => detailTitleRow(app.text).includes("pr#1.1"))
      expect(app.text).toContain("pr#1.1")
      expect(app.text).not.toContain("pr#24.1")

      // Scope to the QUEUE list row (starts with a clock) — the DETAIL pane's
      // identity title also names pr#1.1 (item M) and must not be wheeled.
      const listY = app.text
        .split("\n")
        .findIndex((row) => row.includes("pr#1.1") && /^\s*\d{2}:\d{2}:\d{2}/u.test(row))
      const listX = (app.text.split("\n")[listY]?.indexOf("pr#1.1") ?? 0) + 2
      for (let index = 0; index < 12; index += 1) await app.wheel(listX, listY, 3)
      await waitFor(() => app.text.includes("pr#24.1"))
      // Contract literal: scrolling never activates a different run — the
      // detail pane still shows the selected pending PR1.
      expect(detailTitleRow(app.text)).toContain("pr#1.1")
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
      await waitFor(() => detailTitleRow(app.text).includes("pr#42.1"))
      // The detail pane docks right; wheel well inside it.
      const detailX = 170
      const detailY = 20
      for (let index = 0; index < 8; index += 1) await app.wheel(detailX, detailY, 3)
      await app.waitForLayoutStable()
      expect(detailTitleRow(app.text)).toContain("pr#42.1")
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
      await waitFor(() => detailTitleRow(term.screen.getText()).includes("pr#3.1"))
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

  it("toggles status buckets with p/r/f/d and filters the timeline rows", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("pr#5.1")
      // The status buckets are TogglePills now (label constant, state by colour),
      // so the toggle is verified by the rows appearing/disappearing, not by an
      // ✓/○ lifecycle glyph. Item 3: pills are plain words, no [f] brackets.
      expect(app.text, "the failed pill renders").toContain("failed")

      await app.press("f")
      await waitFor(() => !app.text.includes("pr#5.1"))

      await app.press("f")
      await waitFor(() => app.text.includes("pr#5.1"))

      await app.press("d")
      await waitFor(() => !app.text.includes("pr#4.1"))

      // `p` toggles the pending bucket — it never pauses.
      await app.press("p")
      await waitFor(() => !app.text.includes("Prepare release notes"))
      expect(app.text).not.toContain("PAUSED")
      await app.press("p")
      await app.press("d")
      await waitFor(() => app.text.includes("pr#4.1"))
    } finally {
      app.unmount()
    }
  })

  it("toggles a status bucket by clicking its pill", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("pr#42.1")
      // The pills row (the one carrying all four plain-word pills) sits below
      // the list; find `running` there, not in a running PR row above it.
      const filterY = app.text.split("\n").findIndex((row) => /todo.*running.*failed.*done/u.test(row))
      const filterX = app.text.split("\n")[filterY]?.indexOf("running") ?? -1
      expect(filterY).toBeGreaterThan(0)
      expect(filterX).toBeGreaterThan(0)
      // Clicking the running pill toggles the running bucket off — the running
      // rows drop out (state is colour, so the filtering behaviour is the proof).
      await app.click(filterX + 1, filterY)
      await waitFor(() => !app.text.includes("pr#42.1"))
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
      // The detail pane is identity-headed; its selected PR title proves presence.
      await waitFor(() => detailTitleRow(app.text).includes("pr#42.1"))

      await app.press("Escape")
      await waitFor(() => !detailTitleRow(app.text).includes("pr#42.1"))
      // Esc at top never quits; the list is still live.
      expect(app.text).toContain("QUEUE main")

      await app.press("Enter")
      await waitFor(() => detailTitleRow(app.text).includes("pr#42.1"))
    } finally {
      app.unmount()
    }
  })
})
