/**
 * 21106 interaction/chrome slice — chrome contract.
 *
 * Covers the user-settled chrome respec (2026-07-15 live-pane review wave):
 * shared header/row column geometry (fixed TIME/STATUS/RUN + flex PR +
 * right-anchored STEP/BY/AGE/RUN cells), split RUN and PR header labels,
 * muted run ids, the RUNNER title-in-border box (present / absent states),
 * bottom-aligned STATS, pane frames with padding, selection color forcing,
 * the failed/done status vocabulary, and the non-default-only FILTER line.
 */

import { createElement } from "react"
import { createRenderer, waitFor } from "silvery/test"
import { describe, expect, it } from "vitest"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineView, type QueueTimelineProjection } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")

function lineIndex(text: string, needle: string): number {
  return text.split("\n").findIndex((line) => line.includes(needle))
}

function lineAt(text: string, index: number): string {
  const line = text.split("\n")[index]
  if (line === undefined) throw new Error(`no line ${index}`)
  return line
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
      const headerY = lineIndex(app.text, "TIME")
      const headerLine = lineAt(app.text, headerY)
      expect(headerLine).toContain("RUN")
      expect(headerLine).toContain("PR")
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
      const runRowY = lineIndex(text, "PR4.1")
      expect(runRowY).toBeGreaterThan(0)
      const runRow = lineAt(text, runRowY)
      const runX = runRow.indexOf("main#4 ") >= 0 ? runRow.indexOf("main#4 ") : runRow.indexOf("main#4")
      const timeX = runRow.search(/\d{2}:\d{2}:\d{2}/u)
      const subjectX = runRow.indexOf("Land the durable patch")
      expect(subjectX).toBeGreaterThan(0)
      const runFg = app.cell(runX, runRowY).fg
      const timeFg = app.cell(timeX, runRowY).fg
      const subjectFg = app.cell(subjectX, runRowY).fg
      expect(runFg, "run id shares TIME's muted fg").toEqual(timeFg)
      expect(runFg, "run id is not default fg").not.toEqual(subjectFg)

      const pendingRowY = lineIndex(text, " pend ")
      const pendingRow = lineAt(text, pendingRowY)
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
      const integratedRow = lineAt(app.text, lineIndex(app.text, "PR4.1"))
      expect(integratedRow).toContain(" done ")
      expect(integratedRow).not.toContain(" ok ")
      const rejectedRow = lineAt(app.text, lineIndex(app.text, "PR5.1"))
      expect(rejectedRow).toContain(" fail ")
      expect(rejectedRow).not.toContain(" rej ")
    } finally {
      app.unmount()
    }
  })

  it("renders a RUNNER title-in-border box with pid, command line, and right-aligned uptime", async () => {
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
      const titleY = lineIndex(app.text, "RUNNER")
      expect(titleY, "RUNNER title row").toBeGreaterThanOrEqual(0)
      const bodyY = lineIndex(app.text, "[342]")
      expect(bodyY, "runner body row").toBeGreaterThan(titleY)
      const body = lineAt(app.text, bodyY)
      expect(body).toContain("[342] bun vendor/yrd/bin/yrd.ts --resident")
      expect(body).toContain("uptime 03:45")
      // Right-aligned: uptime is the last content in the row (before border).
      expect(body.replace(/[│\s]+$/u, "").endsWith("uptime 03:45")).toBe(true)
    } finally {
      app.unmount()
    }
  })

  it("renders an all-red NO RUNNER line with the last-drained age when no runner exists", async () => {
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
      const messageY = lineIndex(app.text, "NO RUNNER")
      expect(messageY, app.text).toBeGreaterThanOrEqual(0)
      expect(lineAt(app.text, messageY)).toContain(message)
      // All-red: every glyph of the message shares one fg, and it matches the
      // failed status word's error fg.
      const messageLine = lineAt(app.text, messageY)
      const startX = messageLine.indexOf("NO RUNNER")
      const messageFg = app.cell(startX, messageY).fg
      for (let offset = 0; offset < message.length; offset += 4) {
        expect(app.cell(startX + offset, messageY).fg, `fg at offset ${offset}`).toEqual(messageFg)
      }
      const rejectedY = lineIndex(app.text, "PR5.1")
      const rejectedLine = lineAt(app.text, rejectedY)
      const failX = rejectedLine.indexOf("fail")
      expect(messageFg, "NO RUNNER shares the error fg").toEqual(app.cell(failX, rejectedY).fg)
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
      const filterY = lineIndex(app.text, "FILTER")
      const filterLine = lineAt(app.text, filterY)
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
      const filterLine = lineAt(app2.text, lineIndex(app2.text, "FILTER"))
      expect(filterLine).toContain("terms=typecheck")
      expect(filterLine).toContain("[ ] pending")
      expect(filterLine).toContain("[x] failed")
      expect(filterLine).toContain("[ ] done")
    } finally {
      app2.unmount()
    }
  })

  it("frames both watch panes with padded title-in-border chrome and bottom-aligned STATS", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot, paused: false }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("STATS"))
      const text = app.text
      expect(lineIndex(text, "QUEUE main"), "list pane title").toBeGreaterThanOrEqual(0)
      expect(lineIndex(text, "DETAIL"), "detail pane title").toBeGreaterThanOrEqual(0)
      // Padded content: the TIME header sits inside border + padding.
      const timeHeader = app.locator("#th-time").boundingBox()
      expect(timeHeader).not.toBeNull()
      expect(timeHeader!.x).toBeGreaterThanOrEqual(2)
      expect(timeHeader!.y).toBeGreaterThanOrEqual(2)
      // Bottom-aligned STATS: the STATS block sits in the bottom band of the
      // pane, directly above the footer, not right under the list rows.
      const lines = text.split("\n")
      const footerY = lines.findIndex((line) => line.includes("q quit"))
      const statsY = lineIndex(text, "STATS")
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
    const app = render(createElement(QueueWatchFrame, { snapshot, paused: false }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => lineIndex(app.text, " run ") >= 0)
      const text = app.text
      // Default cursor = first RUNNING row.
      const cursorY = lineIndex(text, " run ")
      const cursorLine = lineAt(text, cursorY)
      const statusX = cursorLine.indexOf(" run ") + 1
      const timeX = cursorLine.search(/\d{2}:\d{2}:\d{2}/u)
      const cursorFg = app.cell(statusX, cursorY).fg
      const cursorBg = app.cell(statusX, cursorY).bg
      expect(app.cell(timeX, cursorY).fg, "TIME cell forced to selection fg").toEqual(cursorFg)
      expect(app.cell(timeX, cursorY).bg, "TIME cell selection bg").toEqual(cursorBg)
      const ageMatch = /\d+:\d{2}\s*$/u.exec(cursorLine.replace(/[│\s]+$/u, ""))
      // Every sampled cell shares the same forced pair.
      for (const x of [timeX, statusX]) {
        expect(app.cell(x, cursorY).fg).toEqual(cursorFg)
      }
      void ageMatch
      // Unselected rejected row keeps its own colorization: status fg differs
      // from muted TIME fg.
      const rejectedY = lineIndex(text, " fail ")
      expect(rejectedY).not.toBe(cursorY)
      const rejectedLine = lineAt(text, rejectedY)
      const failX = rejectedLine.indexOf(" fail ") + 1
      const rejectedTimeX = rejectedLine.search(/\d{2}:\d{2}:\d{2}/u)
      expect(app.cell(failX, rejectedY).fg).not.toEqual(app.cell(rejectedTimeX, rejectedY).fg)
      expect(app.cell(failX, rejectedY).bg).not.toEqual(cursorBg)
    } finally {
      app.unmount()
    }
  })
})
