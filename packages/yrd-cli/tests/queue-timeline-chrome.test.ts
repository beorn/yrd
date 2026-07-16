/**
 * 21106 interaction/chrome slice — chrome contract.
 *
 * Covers the user-settled chrome respec (2026-07-15 live-pane review wave):
 * shared header/row column geometry (fixed TIME/STATUS/RUN + flex PR +
 * right-anchored STEP/BY/AGE/RUN cells), split RUN and PR header labels,
 * muted run ids, the RUNNER title-in-border box (present / absent states),
 * bottom-aligned STATS, pane frames with padding, selection color forcing,
 * the failed/done status vocabulary, and the non-default-only FILTER row.
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
      for (const cell of ["time", "status", "run", "pr", "step", "by", "age", "dur"]) {
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
        for (const cell of ["time", "status", "run", "pr", "step", "by", "age", "dur"]) {
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

  it("renders the column header white+bold, the PR id always bold, and a blank line above FILTER", async () => {
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
      const mutedRowY = rowIndexOf(text, "PR4.1")
      const mutedTimeX = rowAt(text, mutedRowY).search(/\d{2}:\d{2}:\d{2}/u)
      expect(app.cell(timeHeaderX, headerY).fg, "header fg is brighter than the muted row TIME").not.toEqual(
        app.cell(mutedTimeX, mutedRowY).fg,
      )
      // F: an integrated (non-running) PR id is still bold.
      const doneRow = rowAt(text, mutedRowY)
      const prX = doneRow.indexOf("PR4.1")
      expect(app.cell(prX, mutedRowY).bold, "integrated PR id is bold").toBe(true)
      // D: the row directly above FILTER is blank.
      const filterY = rowIndexOf(text, "FILTER ")
      expect(rowAt(text, filterY - 1).trim(), "blank line above FILTER").toBe("")
    } finally {
      app.unmount()
    }
  })

  it("mutes real run ids like TIME while pending keeps its own color", async () => {
    const projection = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 160 }))
    try {
      await app.waitForLayoutStable()
      const text = app.text
      const runRowY = rowIndexOf(text, "PR4.1")
      expect(runRowY).toBeGreaterThan(0)
      const runRow = rowAt(text, runRowY)
      const runX = runRow.indexOf("main#4 ") >= 0 ? runRow.indexOf("main#4 ") : runRow.indexOf("main#4")
      const timeX = runRow.search(/\d{2}:\d{2}:\d{2}/u)
      const subjectX = runRow.indexOf("Land the durable patch")
      expect(subjectX).toBeGreaterThan(0)
      const runFg = app.cell(runX, runRowY).fg
      const timeFg = app.cell(timeX, runRowY).fg
      const subjectFg = app.cell(subjectX, runRowY).fg
      expect(runFg, "run id shares TIME's muted fg").toEqual(timeFg)
      expect(runFg, "run id is not default fg").not.toEqual(subjectFg)

      const pendingRowY = rowIndexOf(text, " pend ")
      const pendingRow = rowAt(text, pendingRowY)
      const pendingX = pendingRow.lastIndexOf("pending")
      expect(pendingX, "pending run cell present on the pending row").toBeGreaterThan(0)
      const pendingFg = app.cell(pendingX, pendingRowY).fg
      expect(pendingFg, "pending run cell keeps info color").not.toEqual(timeFg)
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
      const integratedRow = rowAt(app.text, rowIndexOf(app.text, "PR4.1"))
      expect(integratedRow).toContain(" done ")
      expect(integratedRow).not.toContain(" ok ")
      const rejectedRow = rowAt(app.text, rowIndexOf(app.text, "PR5.1"))
      expect(rejectedRow).toContain(" fail ")
      expect(rejectedRow).not.toContain(" rej ")
    } finally {
      app.unmount()
    }
  })

  it("renders a RUNNER title-in-border box with pid, command row, and right-aligned uptime", async () => {
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
      const titleY = rowIndexOf(app.text, "RUNNER")
      expect(titleY, "RUNNER title row").toBeGreaterThanOrEqual(0)
      const bodyY = rowIndexOf(app.text, "[342]")
      expect(bodyY, "runner body row").toBeGreaterThan(titleY)
      const body = rowAt(app.text, bodyY)
      expect(body).toContain("[342] bun vendor/yrd/bin/yrd.ts --resident")
      expect(body).toContain("uptime 03:45")
      // Right-aligned: uptime ends the row content (before the border).
      expect(body.replace(/[│\s]+$/u, "").endsWith("uptime 03:45")).toBe(true)
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
      expect(rowAt(app.text, messageY)).toContain(message)
      // All-red: every glyph of the message shares one fg matching the failed
      // status word's error fg.
      const messageLine = rowAt(app.text, messageY)
      const startX = messageLine.indexOf("NO RUNNER")
      const messageFg = app.cell(startX, messageY).fg
      for (let offset = 0; offset < message.length; offset += 4) {
        expect(app.cell(startX + offset, messageY).fg, `fg at offset ${offset}`).toEqual(messageFg)
      }
      const rejectedY = rowIndexOf(app.text, "PR5.1")
      const rejectedLine = rowAt(app.text, rejectedY)
      const failX = rejectedLine.indexOf("fail")
      expect(messageFg, "NO RUNNER shares the error fg").toEqual(app.cell(failX, rejectedY).fg)
    } finally {
      app.unmount()
    }
  })

  it("omits since= from FILTER when the window is unbounded (the new default)", async () => {
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
      const filterLine = rowAt(app.text, rowIndexOf(app.text, "FILTER"))
      expect(filterLine, "unbounded window shows no since=").not.toContain("since=")
      expect(filterLine).toContain("[x] pending")
    } finally {
      app.unmount()
    }
  })

  it("renders only non-default FILTER dimensions plus the four status checkboxes", async () => {
    const defaults = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection: defaults, nav: false, columns: 160 }))
    try {
      await app.waitForLayoutStable()
      const filterY = rowIndexOf(app.text, "FILTER")
      const filterLine = rowAt(app.text, filterY)
      expect(filterLine).toContain("since=6:00:00")
      expect(filterLine).toContain("[x] pending")
      expect(filterLine).toContain("[x] running")
      expect(filterLine).toContain("[x] failed")
      expect(filterLine).toContain("[x] done")
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
      const filterLine = rowAt(app2.text, rowIndexOf(app2.text, "FILTER"))
      expect(filterLine).toContain("terms=typecheck")
      expect(filterLine).toContain("[ ] pending")
      expect(filterLine).toContain("[x] failed")
      expect(filterLine).toContain("[ ] done")
    } finally {
      app2.unmount()
    }
  })

  it("draws every watch box with full rounded corners, a left label, and a label color matching its border", async () => {
    // Reworked title-in-border chrome (user directives 1+2, 2026-07-16):
    // `╭─ TITLE ─…─╮` on top with the label punched into the LEFT of the top
    // edge, `╰─…─╯` on the bottom (rounded corners everywhere), and the label
    // sharing the border's resolved color.
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const app = createRenderer({ cols: 160, rows: 50 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("STATS"))
      const lines = app.text.split("\n")
      for (const label of ["QUEUE main", "RUNNER", "STATS", "DETAIL"]) {
        const topY = lines.findIndex((l) => l.includes(`╭─ ${label} `))
        expect(topY, `${label} rounded top-left corner + left label`).toBeGreaterThanOrEqual(0)
        const topLine = lines[topY]
        const titleX = topLine.indexOf(label)
        // A rounded top-right corner closes this box's border row after the
        // label (nested/side-by-side boxes still close with `╮`; search from the
        // label so a neighbouring box's corner to the left is not mistaken).
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

  it("floats the QUEUE chrome flush against the title, not below an offset gap", async () => {
    // Directive 3 (2026-07-16): the QUEUE pane drops its top padding so the
    // first content row — the sibling tabs on the left and the `updated` clock
    // on the right — sits flush directly beneath the QUEUE title border, instead
    // of the temporal cue floating below a blank offset row.
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const app = createRenderer({ cols: 160, rows: 50 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("STATS"))
      const queueY = rowIndexOf(app.text, "QUEUE main")
      const firstContent = rowAt(app.text, queueY + 1)
      // The row directly under the title is real chrome (sibling tabs), not a
      // blank padding gap.
      expect(
        firstContent.replace(/[│\s]/gu, "").length,
        "first content row is flush chrome, not a blank gap",
      ).toBeGreaterThan(0)
      expect(firstContent, "flush header carries the queue sibling tabs").toContain("release/")
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
      const titleY = rowIndexOf(app.text, "RUNNER")
      const titleLine = rowAt(app.text, titleY)
      const titleX = titleLine.indexOf("RUNNER")
      const fillX = titleLine.indexOf("─", titleX + "RUNNER".length + 1)
      expect(app.cell(titleX, titleY).fg, "stale RUNNER label fg == border fg").toEqual(app.cell(fillX, titleY).fg)
      const staleY = rowIndexOf(app.text, "RUNNER STALE")
      expect(staleY, "stale banner present").toBeGreaterThan(titleY)
      const staleLine = rowAt(app.text, staleY)
      const staleX = staleLine.indexOf("RUNNER STALE")
      expect(app.cell(titleX, titleY).fg, "label red == stale-banner error red").toEqual(app.cell(staleX, staleY).fg)
    } finally {
      app.unmount()
    }
  })

  it("frames both watch panes with padded title-in-border chrome and bottom-aligned STATS", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("STATS"))
      const text = app.text
      expect(rowIndexOf(text, "QUEUE main"), "list pane title").toBeGreaterThanOrEqual(0)
      expect(rowIndexOf(text, "DETAIL"), "detail pane title").toBeGreaterThanOrEqual(0)
      // Padded content: the TIME header sits inside border + padding.
      const timeHeader = app.locator("#th-time").boundingBox()
      expect(timeHeader).not.toBeNull()
      expect(timeHeader!.x).toBeGreaterThanOrEqual(2)
      expect(timeHeader!.y).toBeGreaterThanOrEqual(2)
      // Bottom-aligned STATS: the STATS block sits in the bottom band of the
      // pane, directly above the footer, not right under the list rows.
      const rows = text.split("\n")
      const footerY = rows.findIndex((row) => row.includes("q quit"))
      const statsY = rowIndexOf(text, "STATS")
      expect(footerY).toBeGreaterThan(0)
      expect(statsY).toBeGreaterThan(0)
      expect(footerY - statsY, "STATS anchors to the bottom band").toBeLessThanOrEqual(12)
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
      const cursorFg = app.cell(statusX, cursorY).fg
      const cursorBg = app.cell(statusX, cursorY).bg
      expect(app.cell(timeX, cursorY).fg, "TIME cell forced to selection fg").toEqual(cursorFg)
      expect(app.cell(timeX, cursorY).bg, "TIME cell selection bg").toEqual(cursorBg)
      // Every sampled cell shares the same forced pair.
      for (const x of [timeX, statusX]) {
        expect(app.cell(x, cursorY).fg).toEqual(cursorFg)
      }
      // The selection band spans the FULL row width: the run-duration glyph
      // near the right edge AND the inter-cell gap next to it carry the same
      // selection background as the left-edge cells.
      const durX = cursorLine.indexOf("◷")
      expect(durX, "cursor row run-duration glyph").toBeGreaterThan(statusX)
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
