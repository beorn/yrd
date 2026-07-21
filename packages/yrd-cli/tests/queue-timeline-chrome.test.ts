/**
 * 21106 interaction/chrome slice — chrome contract.
 *
 * Covers the user-settled chrome respec (2026-07-15 live-pane review wave):
 * shared header/row column geometry (fixed TIME/STATUS/RUN + flex PR +
 * right-anchored STEP/BY/AGE/RUN cells), split RUN and PR header labels,
 * muted run ids, the RUNNER box (its top border carries a uptime/downtime
 * timer and the queue-pause STATUS line folds inside it — the separate STATUS
 * box is gone, user directive 2026-07-21), bottom-aligned FLOW/TIME, pane
 * frames with padding, selection color forcing, the todo/failed/done status
 * vocabulary, and the non-default-only FILTER row.
 */

import { createElement } from "react"
import { createRenderer, waitFor } from "silvery/test"
import { describe, expect, it } from "vitest"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS,
  QueueTimelineView,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")

function rowIndexOf(text: string, needle: string): number {
  return text.split("\n").findIndex((row) => row.includes(needle))
}

function rowAt(text: string, index: number): string {
  const row = text.split("\n")[index]
  if (row === undefined) throw new Error(`no rendered row ${index}`)
  return row
}

/** The status-pills row (no more "FILTER" label; the four plain-word pills share
 *  one row with any non-default dimensions). The pending bucket's pill reads
 *  `todo` (user directive 2026-07-21). */
function pillsRow(text: string): string {
  const found = text.split("\n").find((row) => /todo.*running.*failed.*done/u.test(row))
  if (found === undefined) throw new Error("no pills row")
  return found
}

/** mediaDuration display format (H:MM:SS / M:SS) for expected-age assertions. */
function clockDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = String(seconds % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`
}

describe("queue timeline chrome 21106", () => {
  it("header and row cells share one column geometry with nav on at 120 cols", async () => {
    const projection = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: true, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      for (const cell of ["time", "status", "run", "pr", "by", "age", "dur"]) {
        const header = app.locator(`#th-${cell}`).boundingBox()
        expect(header, `header cell th-${cell}`).not.toBeNull()
        const cells = app.locator(`[id^='td-${cell}-']`)
        const count = cells.count()
        expect(count, `td-${cell} row cells`).toBeGreaterThan(2)
        for (let index = 0; index < count; index += 1) {
          const box = cells.nth(index).boundingBox()
          expect(box?.x, `column '${cell}' row ${index} x-offset`).toBe(header?.x)
        }
      }
      // Split header labels: RUN and PR are separate labels, each over its
      // own column — no merged RUN·PR header.
      expect(app.text).not.toContain("RUN·PR")
      const headerY = rowIndexOf(app.text, "TIME")
      const headerLine = rowAt(app.text, headerY)
      expect(headerLine).toContain("RUN")
      expect(headerLine).toContain("PR")

      // One renderer, two modes (user contract 2026-07-16): the one-shot
      // (nav off) render must be layout-identical to the live (nav on)
      // first frame — same column x-offsets. This permanently kills the
      // "tests pass one-shot, breaks live" nav-wrapper divergence class.
      const oneShot = createRenderer({ cols: 120, rows: 40 })(
        createElement(QueueTimelineView, { projection, nav: false, columns: 120 }),
      )
      try {
        await oneShot.waitForLayoutStable()
        for (const cell of ["time", "status", "run", "pr", "by", "age", "dur"]) {
          const live = app.locator(`#th-${cell}`).boundingBox()
          const plain = oneShot.locator(`#th-${cell}`).boundingBox()
          expect(plain?.x, `one-shot '${cell}' header x`).toBe(live?.x)
          const liveCells = app.locator(`[id^='td-${cell}-']`)
          const plainCells = oneShot.locator(`[id^='td-${cell}-']`)
          expect(plainCells.count(), `one-shot '${cell}' cell count`).toBe(liveCells.count())
          for (let index = 0; index < plainCells.count(); index += 1) {
            expect(plainCells.nth(index).boundingBox()?.x, `one-shot '${cell}' row ${index} x`).toBe(
              liveCells.nth(index).boundingBox()?.x,
            )
          }
        }
      } finally {
        oneShot.unmount()
      }
    } finally {
      app.unmount()
    }
  })

  it("renders the column header white+bold, the PR id always bold, and no blank row above the header", async () => {
    const projection = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 160 }))
    try {
      await app.waitForLayoutStable()
      const text = app.text
      // E: the column header is white (default fg, not muted) AND bold.
      const headerY = rowIndexOf(text, "STATUS")
      const timeHeaderX = rowAt(text, headerY).indexOf("TIME")
      expect(app.cell(timeHeaderX, headerY).bold, "header TIME is bold").toBe(true)
      const mutedRowY = rowIndexOf(text, "pr#4.1")
      const mutedTimeX = rowAt(text, mutedRowY).search(/\d{2}:\d{2}:\d{2}/u)
      expect(app.cell(timeHeaderX, headerY).fg, "header fg is brighter than the muted row TIME").not.toEqual(
        app.cell(mutedTimeX, mutedRowY).fg,
      )
      // Round 6: only the value segment is bold; noun and revision stay plain.
      const doneRow = rowAt(text, mutedRowY)
      const prX = doneRow.indexOf("pr#4.1")
      expect(app.cell(prX, mutedRowY).bold, "integrated PR noun is plain").not.toBe(true)
      expect(app.cell(prX + 3, mutedRowY).bold, "integrated PR value is bold").toBe(true)
      expect(app.cell(prX + 4, mutedRowY).bold, "integrated PR revision is plain").not.toBe(true)
      // Item 5: the table header sits flush — the row directly above the TIME
      // header is not a blank spacer (it is the QUEUE metadata row).
      expect(rowAt(text, headerY - 1).trim(), "no blank row above the header").not.toBe("")
    } finally {
      app.unmount()
    }
  })

  it("mutes real run ids like TIME while a not-yet-started run shows a muted dash", async () => {
    const projection = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 160 }))
    try {
      await app.waitForLayoutStable()
      const text = app.text
      const runRowY = rowIndexOf(text, "pr#4.1")
      expect(runRowY).toBeGreaterThan(0)
      const runRow = rowAt(text, runRowY)
      const runX = runRow.indexOf("main#4 ") >= 0 ? runRow.indexOf("main#4 ") : runRow.indexOf("main#4")
      const timeX = runRow.search(/\d{2}:\d{2}:\d{2}/u)
      // The flexible cell now holds the branch (item Q); its `/` marks a branch
      // char rendered in the default (non-muted) fg.
      const branchX = runRow.indexOf("/")
      expect(branchX).toBeGreaterThan(0)
      const runFg = app.cell(runX, runRowY).fg
      const timeFg = app.cell(timeX, runRowY).fg
      const branchFg = app.cell(branchX, runRowY).fg
      expect(runFg, "run id shares TIME's muted fg").toEqual(timeFg)
      expect(runFg, "run id is not default fg").not.toEqual(branchFg)

      // The branch glyph (U+E0A0) is a dim decoration (W2, 2026-07-16): muted
      // like TIME, and distinctly dimmer than the branch name it prefixes.
      const iconX = runRow.indexOf("")
      expect(iconX, "branch glyph present").toBeGreaterThan(0)
      const iconFg = app.cell(iconX, runRowY).fg
      expect(iconFg, "branch glyph is muted, like TIME").toEqual(timeFg)
      expect(iconFg, "branch glyph is dimmer than the branch name").not.toEqual(branchFg)

      // Item 9: a not-yet-started run shows a muted "-" in the RUN cell — no
      // colored pending word there. The pending STATUS cell reads `todo` (user
      // directive 2026-07-21) and keeps its info color.
      const todoRowY = rowIndexOf(text, " todo ")
      const todoRow = rowAt(text, todoRowY)
      expect(todoRow, "run-less row shows no colored pending run id").not.toContain("pending")
      const todoStatusX = todoRow.indexOf("todo")
      expect(todoStatusX, "todo status word present").toBeGreaterThan(0)
      expect(
        app.cell(todoStatusX, todoRowY).fg,
        "todo status word keeps its own (info) color, distinct from muted TIME",
      ).not.toEqual(timeFg)
    } finally {
      app.unmount()
    }
  })

  it("renders the failed/done status vocabulary", async () => {
    const projection = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 160 }))
    try {
      await app.waitForLayoutStable()
      const integratedRow = rowAt(app.text, rowIndexOf(app.text, "pr#4.1"))
      expect(integratedRow).toContain(" done ")
      expect(integratedRow).not.toContain(" ok ")
      const rejectedRow = rowAt(app.text, rowIndexOf(app.text, "pr#5.1"))
      expect(rejectedRow).toContain(" fail ")
      expect(rejectedRow).not.toContain(" rej ")
    } finally {
      app.unmount()
    }
  })

  it("keeps healthy runner chrome visible in the normal queue", async () => {
    const story = queueTimelineStories["contract-overview"].snapshot.projection
    const projection: QueueTimelineProjection = {
      ...story,
      runner: {
        pid: 342,
        startedAt: new Date(NOW - (3 * 60 + 45) * 60_000).toISOString(),
        lastTickAt: new Date(NOW - 2_000).toISOString(),
        command: "bun vendor/yrd/bin/yrd.ts --resident",
      },
    }
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("╭─ RUNNER ")
      expect(app.text).not.toContain("╭─ STATUS ")
      expect(app.text).toContain("[342]")
      // The RUNNER border timer uses the adaptive clock (H:MM:SS above an hour):
      // 3h45m of uptime renders `uptime 3:45:00` (user directive 2026-07-21).
      expect(app.text).toContain("uptime 3:45:00")
    } finally {
      app.unmount()
    }
  })

  it("renders an all-red NO RUNNER banner with the last-drained age when no runner exists", async () => {
    const story = queueTimelineStories["contract-overview"].snapshot.projection
    const projection: QueueTimelineProjection = { ...story, runner: null }
    const newestTerminal = Math.max(
      ...projection.rows
        .filter((row) => row.group === "completed" && row.timestampMs !== null)
        .map((row) => row.timestampMs ?? Number.NEGATIVE_INFINITY),
    )
    const expectedAge = clockDuration(NOW - newestTerminal)
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      const message = `NO RUNNER - queue last drained ${expectedAge} ago`
      const messageY = rowIndexOf(app.text, "NO RUNNER")
      expect(messageY, app.text).toBeGreaterThanOrEqual(0)
      expect(app.text).not.toContain("╭─ STATUS ")
      expect(app.text).toContain("╭─ RUNNER ")
      expect(rowAt(app.text, messageY)).toContain(message)
      // All-red: every glyph of the message shares one fg matching the failed
      // status word's error fg.
      const messageLine = rowAt(app.text, messageY)
      const startX = messageLine.indexOf("NO RUNNER")
      const messageFg = app.cell(startX, messageY).fg
      for (let offset = 0; offset < message.length; offset += 4) {
        expect(app.cell(startX + offset, messageY).fg, `fg at offset ${offset}`).toEqual(messageFg)
      }
      const rejectedY = rowIndexOf(app.text, "pr#5.1")
      const rejectedLine = rowAt(app.text, rejectedY)
      const failX = rejectedLine.indexOf("fail")
      expect(messageFg, "NO RUNNER shares the error fg").toEqual(app.cell(failX, rejectedY).fg)
    } finally {
      app.unmount()
    }
  })

  it("omits since= from the pills row when the window is unbounded (the new default)", async () => {
    const base = queueTimelineStories["contract-overview"].snapshot.projection
    const unbounded: QueueTimelineProjection = {
      ...base,
      filters: { ...base.filters, windowMs: QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS },
    }
    const app = createRenderer({ cols: 160, rows: 40 })(
      createElement(QueueTimelineView, { projection: unbounded, nav: false, columns: 160 }),
    )
    try {
      await app.waitForLayoutStable()
      const filterLine = pillsRow(app.text)
      expect(filterLine, "unbounded window shows no since=").not.toContain("since=")
      expect(filterLine).toContain("todo")
    } finally {
      app.unmount()
    }
  })

  it("renders only non-default dimensions plus the four plain-word status pills (no FILTER label)", async () => {
    const defaults = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection: defaults, nav: false, columns: 160 }))
    try {
      await app.waitForLayoutStable()
      const filterLine = pillsRow(app.text)
      // Item 3: the "FILTER" label is gone; the non-default `since=` dimension
      // survives as a dim prefix and the pills are plain words (no brackets).
      expect(app.text, "FILTER label is deleted").not.toContain("FILTER")
      expect(filterLine).toContain("since=6:00:00")
      expect(filterLine).toContain("todo")
      expect(filterLine).toContain("running")
      expect(filterLine).toContain("failed")
      expect(filterLine).toContain("done")
      expect(filterLine, "no bracketed hotkey hints").not.toMatch(/\[[trfd]\]/u)
      expect(filterLine).not.toContain("terms=")
      expect(filterLine).not.toContain("latest=")
      expect(filterLine).not.toContain("status=")
    } finally {
      app.unmount()
    }

    const filtered = queueTimelineStories["non-default-filters"].snapshot.projection
    const app2 = createRenderer({ cols: 160, rows: 40 })(
      createElement(QueueTimelineView, { projection: filtered, nav: false, columns: 160 }),
    )
    try {
      await app2.waitForLayoutStable()
      const filterLine = pillsRow(app2.text)
      expect(filterLine).toContain("terms=typecheck")
      // Pills always render their label (bucket on/off is colour, not glyph).
      expect(filterLine).toContain("todo")
      expect(filterLine).toContain("failed")
      expect(filterLine).toContain("done")
    } finally {
      app2.unmount()
    }
  })

  it("draws the compact info boxes with full rounded corners, a left label, and a label color matching its border", async () => {
    // Reworked title-in-border chrome (user directives 1+2, 2026-07-16):
    // `╭─ TITLE ─…─╮` on top with the label punched into the LEFT of the top
    // edge, `╰─…─╯` on the bottom (rounded corners everywhere), and the label
    // sharing the border's resolved color. Only the compact info boxes get this
    // — QUEUE and DETAIL are unboxed panes (items L/M).
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const app = createRenderer({ cols: 160, rows: 50 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("╭─ FLOW "))
      const rows = app.text.split("\n")
      // Normal chrome includes runner liveness and the two metric frames.
      expect(app.text).not.toContain("╭─ STATUS ")
      for (const label of ["RUNNER", "FLOW", "TIME"]) {
        const topY = rows.findIndex((l) => l.includes(`╭─ ${label} `))
        expect(topY, `${label} rounded top-left corner + left label`).toBeGreaterThanOrEqual(0)
        const topLine = rows[topY]
        if (topLine === undefined) throw new Error(`${label} top border row missing`)
        const titleX = topLine.indexOf(label)
        // A rounded top-right corner closes this box's border row after the
        // label.
        expect(topLine.indexOf("╮", titleX), `${label} rounded top-right corner`).toBeGreaterThan(titleX)
        // The label color equals the border-fill color on the same row.
        const fillX = topLine.indexOf("─", titleX + label.length + 1)
        expect(fillX, `${label} border fill after the label`).toBeGreaterThan(titleX)
        expect(app.cell(titleX, topY).fg, `${label} label fg == border fg`).toEqual(app.cell(fillX, topY).fg)
      }
    } finally {
      app.unmount()
    }
  })

  it("heads the live QUEUE pane with one clean tab and moves the temporal cue to the RUNNER border (items L + C)", async () => {
    // The QUEUE pane is headed by its tab-style label (item L). The `updated`
    // clock is GONE from the live pane header (user directive 2026-07-21): the
    // RUNNER box's always-on border timer is the watch view's temporal-trust
    // cue now. Sibling branch names still do not wrap through the table header.
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const app = createRenderer({ cols: 160, rows: 50 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("╭─ FLOW "))
      const queueLine = rowAt(app.text, rowIndexOf(app.text, "QUEUE main"))
      expect(queueLine, "QUEUE tab row omits sibling branch noise").not.toContain("release/")
      // The `updated HH:MM:SS` clock is absent from the live pane header.
      expect(app.text, "the live pane drops the updated clock").not.toMatch(/updated \d{2}:\d{2}:\d{2}/u)
      // The temporal cue rides the RUNNER box's top border as uptime/downtime.
      const runnerBorderY = rowIndexOf(app.text, "╭─ RUNNER ")
      expect(runnerBorderY, "RUNNER box renders").toBeGreaterThanOrEqual(0)
      expect(rowAt(app.text, runnerBorderY), "RUNNER border carries the uptime/downtime timer").toMatch(
        /(?:uptime|downtime) \d/u,
      )
      // No rounded box border around the QUEUE pane.
      expect(app.text).not.toContain("╭─ QUEUE")
    } finally {
      app.unmount()
    }
  })

  it("turns the RUNNER label and border red together when the heartbeat is stale", async () => {
    // Directive 2 (2026-07-16): the error-red case colors both the border AND
    // the label, matching the STALE banner's error fg.
    const story = queueTimelineStories["contract-overview"].snapshot.projection
    const projection: QueueTimelineProjection = {
      ...story,
      runner: {
        pid: 342,
        startedAt: new Date(NOW - 60_000).toISOString(),
        lastTickAt: new Date(NOW - 60_000).toISOString(),
        command: "resident runner",
      },
    }
    const app = createRenderer({ cols: 120, rows: 40 })(
      createElement(QueueTimelineView, { projection, nav: false, columns: 120 }),
    )
    try {
      await app.waitForLayoutStable()
      const titleY = rowIndexOf(app.text, "╭─ RUNNER ")
      const titleLine = rowAt(app.text, titleY)
      const titleX = titleLine.indexOf("RUNNER")
      const fillX = titleLine.indexOf("─", titleX + "RUNNER".length + 1)
      expect(app.cell(titleX, titleY).fg, "stale RUNNER label fg == border fg").toEqual(app.cell(fillX, titleY).fg)
      expect(app.text).not.toContain("╭─ STATUS ")
      const staleY = rowIndexOf(app.text, "RUNNER STALE")
      expect(staleY, "stale banner present").toBeGreaterThan(titleY)
      const staleLine = rowAt(app.text, staleY)
      const staleX = staleLine.indexOf("RUNNER STALE")
      expect(app.cell(titleX, titleY).fg, "label red == stale-banner error red").toEqual(app.cell(staleX, staleY).fg)
    } finally {
      app.unmount()
    }
  })

  it("renders QUEUE + DETAIL as unboxed panes with bottom-aligned statistics", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("╭─ FLOW "))
      const text = app.text
      // QUEUE is a tab-headed pane; DETAIL is headed by the selected run's
      // identity title (`RUN main#42`), not the word "DETAIL" — neither is boxed.
      expect(rowIndexOf(text, "QUEUE main"), "QUEUE pane tab").toBeGreaterThanOrEqual(0)
      expect(text, "DETAIL pane shows the run identity title, not a DETAIL box").toContain("RUN main#42")
      expect(text).not.toContain("╭─ DETAIL")
      expect(text).not.toContain("╭─ QUEUE")
      // Padded content: the TIME header sits inside the pane's horizontal padding.
      const timeHeader = app.locator("#th-time").boundingBox()
      expect(timeHeader).not.toBeNull()
      expect(timeHeader!.x).toBeGreaterThanOrEqual(1)
      expect(timeHeader!.y).toBeGreaterThanOrEqual(1)
      // Bottom-aligned statistics: the FLOW + TIME frames are pushed to the
      // bottom of the pane by a flex spacer. The keybindings footer was removed
      // (item h), so the box's bottom border hugs the pane's last content row.
      const rows = text.split("\n")
      const lastY = rows.findLastIndex((row) => row.trim() !== "")
      const flowY = rowIndexOf(text, "╭─ FLOW ")
      const lastBoxBottomY = rows.findLastIndex((row) => row.includes("╰"))
      expect(lastY).toBeGreaterThan(0)
      expect(flowY, "FLOW box renders below the list header").toBeGreaterThan(timeHeader!.y)
      expect(lastBoxBottomY).toBeGreaterThan(0)
      expect(lastY - lastBoxBottomY, "the grid's last box border hugs the pane bottom band").toBeLessThanOrEqual(1)
    } finally {
      app.unmount()
    }
  })

  it("forces selection fg/bg across every cell of the cursor row and keeps colorization elsewhere", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => rowIndexOf(app.text, " run ") >= 0)
      const text = app.text
      // Default cursor = first RUNNING row.
      const cursorY = rowIndexOf(text, " run ")
      const cursorLine = rowAt(text, cursorY)
      const statusX = cursorLine.indexOf(" run ") + 1
      const timeX = cursorLine.search(/\d{2}:\d{2}:\d{2}/u)
      // Sample the selection fg/bg from a NON-activity cell (TIME).
      const cursorFg = app.cell(timeX, cursorY).fg
      const cursorBg = app.cell(timeX, cursorY).bg
      expect(app.cell(timeX, cursorY).bg, "TIME cell selection bg").toEqual(cursorBg)
      // Item 13: the running status word keeps its BLUE activity fg under
      // selection — it is NEVER forced to the selection fg — while the selection
      // bg still covers it (the band is unbroken).
      expect(app.cell(statusX, cursorY).fg, "running activity fg stays blue under selection").not.toEqual(cursorFg)
      expect(app.cell(statusX, cursorY).bg, "selection bg still covers the activity cell").toEqual(cursorBg)
      // The selection band spans the FULL row width: the run-duration cell at
      // the right edge (now a bare dimmed time, no glyph — item S) AND the
      // inter-cell gap next to it carry the same selection background as the
      // left-edge cells. Locate the cursor row's `td-dur` cell (robust across
      // the split layout, where a text scan would catch a DETAIL-pane time).
      const durCells = app.locator("[id^='td-dur-']")
      let durBox: { x: number; y: number; width: number } | null = null
      for (let index = 0; index < durCells.count(); index += 1) {
        const box = durCells.nth(index).boundingBox()
        if (box?.y === cursorY) {
          durBox = box
          break
        }
      }
      expect(durBox, "cursor row run-duration cell").not.toBeNull()
      const durX = durBox!.x + durBox!.width - 1
      expect(app.cell(durX, cursorY).bg, "selection bg at the right edge").toEqual(cursorBg)
      expect(app.cell(durX - 1, cursorY).bg, "selection bg across cell gaps").toEqual(cursorBg)
      // Unselected rejected row keeps its own colorization: status fg differs
      // from muted TIME fg.
      const rejectedY = rowIndexOf(text, " fail ")
      expect(rejectedY).not.toBe(cursorY)
      const rejectedLine = rowAt(text, rejectedY)
      const failX = rejectedLine.indexOf(" fail ") + 1
      const rejectedTimeX = rejectedLine.search(/\d{2}:\d{2}:\d{2}/u)
      expect(app.cell(failX, rejectedY).fg).not.toEqual(app.cell(rejectedTimeX, rejectedY).fg)
      expect(app.cell(failX, rejectedY).bg).not.toEqual(cursorBg)
    } finally {
      app.unmount()
    }
  })
})
