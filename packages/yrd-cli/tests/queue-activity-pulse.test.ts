// @failure The running row's glyph and status word drift out of phase, or a selected running row loses its blue activity signal.
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
import { QueueTimelineView } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

// Items 12-13 — every visible "executing right now" row indicator pulses blue
// on ONE shared app-scope phase. The synchronized clock guarantees activity cells
// carry the SAME colour on every frame, so equality across frames is the robust
// invariant (no need to sample a specific phase). Activity blue also survives
// row selection (item 13).

function processingSnapshot() {
  const runningPr = fixturePr("PRR", "submitted", "2026-07-13T11:25:00.000Z", "Running")
  const runningRun = fixtureRun("RR", [runningPr], "running", "2026-07-13T11:40:00.000Z", {
    steps: [fixtureStep("check", fixtureJob("JRR-check", "running"))],
  })
  return fixtureSnapshot(fixtureResult([runningPr], [runningRun]), { rowLimit: 20 })
}

function cellOf(app: ReturnType<ReturnType<typeof createRenderer>>, needle: string, anchor: string) {
  const rows = app.text.split("\n")
  const y = rows.findIndex((row) => row.includes(anchor))
  if (y < 0) throw new Error(`no row for '${anchor}'`)
  const x = rows[y]!.indexOf(needle)
  if (x < 0) throw new Error(`no '${needle}' in the '${anchor}' row`)
  return app.cell(x, y)
}

describe("synchronized activity pulse (items 12-13)", () => {
  it("pulses the running row's glyph AND status word blue in the shared phase (item 12)", async () => {
    const projection = processingSnapshot().projection
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(
      createElement(QueueTimelineView, { projection, nav: true, columns: 120, paneChrome: true, fillHeight: true }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).not.toContain("╭─ RUNNER ")
      expect(app.text).not.toContain("╭─ STATUS ")
      // The running row's status disc and its `run` word share one activity colour.
      const glyphFg = cellOf(app, "●", "PRR.1").fg
      const wordFg = cellOf(app, "run", "PRR.1").fg
      expect(wordFg, "running glyph + word pulse the same blue").toEqual(glyphFg)
    } finally {
      app.unmount()
    }
  })

  it("keeps the running activity blue on the SELECTED row, not the selection fg (item 13)", async () => {
    const snapshot = processingSnapshot()
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      // The default cursor is the first running row (PRR) — it is selected.
      const runY = rows.findIndex((row) => /^\s*\d{2}:\d{2}:\d{2}.*\brun\b/u.test(row))
      expect(runY, "selected running row renders").toBeGreaterThan(0)
      const runRow = rows[runY]!
      const glyphX = runRow.indexOf("●")
      const wordX = runRow.indexOf("run")
      const timeX = runRow.search(/\d{2}:\d{2}:\d{2}/u)
      const selectionFg = app.cell(timeX, runY).fg
      // The running glyph + word keep their (shared) blue — never the selection fg.
      expect(app.cell(glyphX, runY).fg, "selected running glyph stays blue").not.toEqual(selectionFg)
      expect(app.cell(wordX, runY).fg, "selected running word stays blue").toEqual(app.cell(glyphX, runY).fg)
      // The selection background still covers the activity cells (unbroken band).
      const timeBg = app.cell(timeX, runY).bg
      expect(app.cell(glyphX, runY).bg, "selection bg covers the activity glyph").toEqual(timeBg)
    } finally {
      app.unmount()
    }
  })
})
