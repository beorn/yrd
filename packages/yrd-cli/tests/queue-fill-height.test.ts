// @failure The queue timeline pane caps visible rows at the projection's coarse pre-slice instead of filling the pane height, hiding rows behind a `... N more` even when they would fit on screen.
// @level l2
// @consumer @yrd/cli watch

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineView } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

// Item 5 — the interactive pane fills the pane height and renders every retained
// row through the virtualizing ListView (scrolling the rest), rather than the
// projection's coarse `display.shown` pre-slice + `... N more`. The one-shot
// print path keeps the cap so `yrd queue` output stays bounded.

function manyPendingSnapshot() {
  const prs = Array.from({ length: 10 }, (_, i) =>
    fixturePr(
      `PR${String(i).padStart(2, "0")}`,
      "submitted",
      `2026-07-13T11:${String(10 + i).padStart(2, "0")}:00.000Z`,
      `Subject ${i}`,
    ),
  )
  // rowLimit 3 forces a tight projection pre-slice: shown=3, hidden=7.
  return fixtureSnapshot(fixtureResult(prs, []), { rowLimit: 3 })
}

function pendingRowCount(text: string): number {
  return new Set(text.match(/PR\d\d\.\d/gu) ?? []).size
}

describe("queue timeline fill height (item 5)", () => {
  it("the projection still carries its coarse cap", () => {
    expect(manyPendingSnapshot().projection.display).toMatchObject({ shown: 3, hidden: 7 })
  })

  it("the fill pane renders past the cap and suppresses the N-more residue", async () => {
    const snapshot = manyPendingSnapshot()
    const render = createRenderer({ cols: 160, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      // Far more than the cap of 3 rows render — the tall pane fits them all.
      expect(pendingRowCount(app.text), "fill renders past the coarse cap").toBeGreaterThan(3)
      // No `... N more` residue: every retained row is reachable in the pane.
      expect(app.text, "fill suppresses the pre-slice residue").not.toMatch(/\.\.\. \d+ more/u)

      // The FLOW box anchors below the filled rows — the row block
      // claims the slack, so the box sits after the last PR row.
      const rows = app.text.split("\n")
      const flowY = rows.findIndex((row) => row.includes("╭─ FLOW "))
      const lastRowY = rows.reduce((last, row, index) => (/PR\d\d\.\d/u.test(row) ? index : last), -1)
      expect(flowY, "FLOW box renders").toBeGreaterThan(0)
      expect(flowY, "FLOW box sits below the filled rows").toBeGreaterThan(lastRowY)
    } finally {
      app.unmount()
    }
  })

  it("the one-shot print path keeps the cap and shows N more", async () => {
    const projection = manyPendingSnapshot().projection
    const render = createRenderer({ cols: 120, rows: 40 })
    // No paneChrome / fillHeight — the default print path.
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      expect(pendingRowCount(app.text), "print path caps at display.shown").toBe(3)
      expect(app.text, "print path shows the residue count").toContain("... 7 more")
    } finally {
      app.unmount()
    }
  })
})
