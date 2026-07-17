// @failure The RUNNER box shows no whole-queue health at a glance: no leading marker that pulses while a run is active or colorizes recent failures / a stale runner / an idle-healthy queue.
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

// Item 4b — the RUNNER box leads with a single whole-queue health marker,
// derived from the projection's own runner + rows/metrics (no new plumbing):
// active pulses, failures go red, a missing/stale runner goes yellow, an idle
// drained queue is dim green. Precedence is severity-ordered.

function idleProjection(): QueueTimelineProjection {
  const pending = fixturePr("PRA", "submitted", "2026-07-13T11:10:00.000Z", "Alpha")
  return fixtureSnapshot(fixtureResult([pending], [])).projection
}

function activeProjection(): QueueTimelineProjection {
  const runningPr = fixturePr("PRR", "submitted", "2026-07-13T11:25:00.000Z", "Running")
  const runningRun = fixtureRun("RR", [runningPr], "running", "2026-07-13T11:40:00.000Z", {
    steps: [fixtureStep("check", fixtureJob("JRR-check", "running"))],
  })
  return fixtureSnapshot(fixtureResult([runningPr], [runningRun]), { rowLimit: 20 }).projection
}

/** The idle projection with only the fields the marker reads overridden — a
 *  real projection base keeps every other field valid. */
function withOutcomes(base: QueueTimelineProjection, rejected: number): QueueTimelineProjection {
  return { ...base, metrics: { ...base.metrics, outcomes: { ...base.metrics.outcomes, rejected } } }
}

describe("queueHealthMarker (item 4b)", () => {
  it("reads active while a run is checking", () => {
    expect(queueHealthMarker(activeProjection())).toEqual({ kind: "active", color: "$fg-info" })
  })

  it("keeps active precedence even with failures in the window", () => {
    expect(queueHealthMarker(withOutcomes(activeProjection(), 3)).kind).toBe("active")
  })

  it("reads failed when recent terminal failures sit in the window", () => {
    expect(queueHealthMarker(withOutcomes(idleProjection(), 1))).toEqual({ kind: "failed", color: "$fg-error" })
  })

  it("reads stale when the resident runner is missing", () => {
    const base = idleProjection()
    expect(queueHealthMarker({ ...base, runner: null })).toEqual({ kind: "stale", color: "$fg-warning" })
  })

  it("reads stale when the runner heartbeat is stale", () => {
    const base = idleProjection()
    const runner = base.runner
    expect(runner, "idle base has a resident runner").not.toBeNull()
    const staleTick = new Date(Date.parse(base.now) - 60_000).toISOString()
    const stale = { ...base, runner: { ...runner!, lastTickAt: staleTick } }
    expect(queueHealthMarker(stale)).toEqual({ kind: "stale", color: "$fg-warning" })
  })

  it("reads healthy when the queue is idle, drained, and the runner is fresh", () => {
    expect(queueHealthMarker(idleProjection())).toEqual({ kind: "healthy", color: "$fg-success" })
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

describe("RUNNER box leading marker render (item 4b)", () => {
  it("leads the runner row with the disc and colors it like the active status glyph", async () => {
    const projection = activeProjection()
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      // The marker leads the RUNNER content row, before the `[pid]`.
      const markerAt = discPointOnRow(app.text, "84042")
      const pidX = app.text.split("\n")[markerAt[1]]!.indexOf("[84042]")
      expect(markerAt[0], "marker precedes the pid").toBeLessThan(pidX)

      // Active state renders the info-colored disc: its cell fg matches the
      // running row's status disc (both `$fg-info`), proving the color reaches
      // the cell — not just the marker helper.
      const statusAt = discPointOnRow(app.text, "PRR.1")
      expect(app.cell(markerAt[0], markerAt[1]).fg).toEqual(app.cell(statusAt[0], statusAt[1]).fg)
    } finally {
      app.unmount()
    }
  })

  it("leads the NO RUNNER banner with the disc when no runner exists", async () => {
    const projection: QueueTimelineProjection = { ...idleProjection(), runner: null }
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      const markerAt = discPointOnRow(app.text, "NO RUNNER")
      const bannerX = app.text.split("\n")[markerAt[1]]!.indexOf("NO RUNNER")
      expect(markerAt[0], "marker precedes the NO RUNNER banner").toBeLessThan(bannerX)
    } finally {
      app.unmount()
    }
  })
})
