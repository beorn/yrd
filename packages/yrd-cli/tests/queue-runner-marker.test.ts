// @failure Runner liveness disappears from its dedicated box or is conflated with queue pause/status chrome.
// @level l2
// @consumer @yrd/cli watch

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import {
  fixtureJob,
  fixturePr,
  fixtureResult,
  fixtureRun,
  fixtureSnapshot,
  fixtureStep,
} from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineView, type QueueTimelineProjection } from "../src/queue-status-view.tsx"

// Runner liveness is always explicit; job activity remains on the queue row.

function idleProjection(): QueueTimelineProjection {
  const pending = fixturePr("PRA", "submitted", "2026-07-13T11:10:00.000Z", "Alpha")
  return fixtureSnapshot(fixtureResult([pending], [])).projection
}

function processingProjection(): QueueTimelineProjection {
  const runningPr = fixturePr("PRR", "submitted", "2026-07-13T11:25:00.000Z", "Running")
  const runningRun = fixtureRun("RR", [runningPr], "running", "2026-07-13T11:40:00.000Z", {
    steps: [fixtureStep("check", fixtureJob("JRR-check", "running"))],
  })
  return fixtureSnapshot(fixtureResult([runningPr], [runningRun]), { rowLimit: 20 }).projection
}

/** The screen point of the leading `glyph` marker on the first row matching
 * `rowNeedle`. The queue rows carry the `◉` activity disc; the RUNNER box
 * health marker is now the `$` shell prompt (user directive 2026-07-21). */
function markerPointOnRow(text: string, rowNeedle: string, glyph = "◉"): readonly [number, number] {
  const rows = text.split("\n")
  const y = rows.findIndex((row) => row.includes(rowNeedle))
  if (y < 0) throw new Error(`no row containing '${rowNeedle}'`)
  const x = rows[y]!.indexOf(glyph)
  if (x < 0) throw new Error(`no '${glyph}' marker on the '${rowNeedle}' row`)
  return [x, y]
}

describe("queue liveness status render (item 4)", () => {
  it("shows healthy runner chrome while preserving the active row marker", async () => {
    const projection = processingProjection()
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("╭─ RUNNER ")
      expect(app.text).not.toContain("╭─ STATUS ")
      expect(app.text).toContain("[84042]")
      const statusAt = markerPointOnRow(app.text, "pr#R.1")
      expect(app.cell(statusAt[0], statusAt[1]).fg).not.toBeNull()
    } finally {
      app.unmount()
    }
  })

  it("leads the NO RUNNER banner with a red $ marker when the runner is down", async () => {
    const projection: QueueTimelineProjection = { ...idleProjection(), runner: null }
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).not.toContain("╭─ STATUS ")
      expect(app.text).toContain("╭─ RUNNER ")
      // The runner health marker is now the `$` shell prompt, not the `◉` disc.
      const markerAt = markerPointOnRow(app.text, "NO RUNNER", "$")
      const bannerX = app.text.split("\n")[markerAt[1]]!.indexOf("NO RUNNER")
      expect(markerAt[0], "marker precedes the NO RUNNER banner").toBeLessThan(bannerX)
      // The down `$` shares the error fg with the banner text.
      const bannerCell = app.cell(bannerX, markerAt[1])
      expect(app.cell(markerAt[0], markerAt[1]).fg, "down marker is error-red like the banner").toEqual(bannerCell.fg)
    } finally {
      app.unmount()
    }
  })
})
