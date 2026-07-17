// @failure The RUNNER box marker reflects job activity/outcomes instead of runner liveness, so an operator cannot tell at a glance whether the runner is down (red), processing (pulsing blue), or idle-alive (pulsing grey).
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
import { QueueTimelineView, queueHealthMarker, type QueueTimelineProjection } from "../src/queue-status-view.tsx"

// Item 4 — the RUNNER box marker reflects RUNNER LIVENESS, not job activity:
// runner down (missing or stale heartbeat) → solid red; runner alive +
// processing → pulsing blue; runner alive + idle → pulsing grey.

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

describe("queueHealthMarker liveness (item 4)", () => {
  it("reads processing (pulsing blue) while the runner is alive and a run is checking", () => {
    expect(queueHealthMarker(processingProjection())).toEqual({
      kind: "processing",
      color: "$fg-info",
      pulse: ["$fg-info", "$fg-muted"],
    })
  })

  it("reads idle (pulsing grey) while the runner is alive with no run in flight", () => {
    expect(queueHealthMarker(idleProjection())).toEqual({
      kind: "idle",
      color: "$fg-muted",
      pulse: ["$fg-muted", "$bg-surface-default"],
    })
  })

  it("reads down (solid red) when the resident runner is missing", () => {
    const base = idleProjection()
    expect(queueHealthMarker({ ...base, runner: null })).toEqual({ kind: "down", color: "$fg-error", pulse: null })
  })

  it("reads down (solid red) when the runner heartbeat is stale — even mid-run", () => {
    const base = processingProjection()
    const runner = base.runner
    expect(runner, "processing base has a resident runner").not.toBeNull()
    const staleTick = new Date(Date.parse(base.now) - 60_000).toISOString()
    const stale = { ...base, runner: { ...runner!, lastTickAt: staleTick } }
    // Down maps a stale heartbeat to red regardless of an in-flight run: nothing
    // is reliably draining the queue.
    expect(queueHealthMarker(stale)).toEqual({ kind: "down", color: "$fg-error", pulse: null })
  })
})

/** The screen point of the disc marker on the first row matching `rowNeedle`. */
function discPointOnRow(text: string, rowNeedle: string): readonly [number, number] {
  const rows = text.split("\n")
  const y = rows.findIndex((row) => row.includes(rowNeedle))
  if (y < 0) throw new Error(`no row containing '${rowNeedle}'`)
  const x = rows[y]!.indexOf("●")
  if (x < 0) throw new Error(`no disc marker on the '${rowNeedle}' row`)
  return [x, y]
}

describe("RUNNER box liveness marker render (item 4)", () => {
  it("leads the runner row with the disc and colors processing like the active status glyph", async () => {
    const projection = processingProjection()
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      // The marker leads the RUNNER content row, before the `[pid]`.
      const markerAt = discPointOnRow(app.text, "84042")
      const pidX = app.text.split("\n")[markerAt[1]]!.indexOf("[84042]")
      expect(markerAt[0], "marker precedes the pid").toBeLessThan(pidX)

      // The static (non-live) processing dot is info-colored — its cell fg
      // matches the running row's status disc (both `$fg-info`).
      const statusAt = discPointOnRow(app.text, "PRR.1")
      expect(app.cell(markerAt[0], markerAt[1]).fg).toEqual(app.cell(statusAt[0], statusAt[1]).fg)
    } finally {
      app.unmount()
    }
  })

  it("leads the NO RUNNER banner with a red disc when the runner is down", async () => {
    const projection: QueueTimelineProjection = { ...idleProjection(), runner: null }
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      const markerAt = discPointOnRow(app.text, "NO RUNNER")
      const bannerX = app.text.split("\n")[markerAt[1]]!.indexOf("NO RUNNER")
      expect(markerAt[0], "marker precedes the NO RUNNER banner").toBeLessThan(bannerX)
      // The down dot shares the error fg with the banner text.
      const bannerCell = app.cell(bannerX, markerAt[1])
      expect(app.cell(markerAt[0], markerAt[1]).fg, "down marker is error-red like the banner").toEqual(bannerCell.fg)
    } finally {
      app.unmount()
    }
  })
})
