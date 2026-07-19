// @failure The running row loses either its km task marker presentation or its selected-row activity signal.
// @level l2
// @consumer @yrd/cli watch

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it, vi } from "vitest"
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

// Items 12-13 plus 21525: the status word keeps the blue activity pulse while
// the glyph uses km's warning-colored, bold WIP presentation. Both pulses use
// the shared app-scope phase and survive row selection.

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
  it("pulses only the RUNNER marker while the command stays static (round-3 d)", async () => {
    const projection = processingSnapshot().projection
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const render = createRenderer({ cols: 120, rows: 40 })
    const tree = () => createElement(QueueTimelineView, { projection, columns: 120, nav: true })
    const app = render(tree())
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("● [84042] resident runner")
      const markerBefore = cellOf(app, "●", "resident runner").fg
      const commandBefore = cellOf(app, "resident", "resident runner").fg

      await vi.advanceTimersByTimeAsync(900)
      app.rerender(tree())

      expect(cellOf(app, "●", "resident runner").fg, "marker advances to the next pulse phase").not.toEqual(
        markerBefore,
      )
      expect(cellOf(app, "resident", "resident runner").fg, "command remains static across marker phases").toEqual(
        commandBefore,
      )
    } finally {
      app.unmount()
      vi.useRealTimers()
    }
  })

  it("pulses the running row's marker and status word in one shared activity phase", async () => {
    const projection = processingSnapshot().projection
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(
      createElement(QueueTimelineView, { projection, columns: 120, paneChrome: true, fillHeight: true }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("╭─ RUNNER ")
      expect(app.text).not.toContain("╭─ STATUS ")
      const glyph = cellOf(app, "●", "pr#R.1")
      const word = cellOf(app, "run", "pr#R.1")
      expect(word.fg, "running marker and word share the activity phase").toEqual(glyph.fg)
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
      // The shared activity phase survives selection instead of inheriting
      // the selection foreground.
      expect(app.cell(glyphX, runY).fg, "selected running marker stays blue").not.toEqual(selectionFg)
      expect(app.cell(wordX, runY).fg, "selected running word shares the marker phase").toEqual(
        app.cell(glyphX, runY).fg,
      )
      // The selection background still covers the activity cells (unbroken band).
      const timeBg = app.cell(timeX, runY).bg
      expect(app.cell(glyphX, runY).bg, "selection bg covers the activity glyph").toEqual(timeBg)
    } finally {
      app.unmount()
    }
  })
})
