// @failure The queue timeline row cap is a fixed ~20 instead of deriving from the pane height, so rows do not fill a tall pane and the cap ignores the terminal size.
// @level l2
// @consumer @yrd/cli watch

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineView } from "../src/queue-status-view.tsx"
import { queueTimelineRowLimit } from "../src/run.ts"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

// Item 5 — the row cap derives from the pane height (terminal rows less the
// fixed QUEUE-pane chrome) so the rows fill the pane, and the row block grows to
// claim the pane's vertical slack. The `... N more` coverage row + the cap stay
// authoritative (that coverage row is owned by another builder; item 5 only
// sizes the rows).

function manyPendingSnapshot(rowLimit: number) {
  const prs = Array.from({ length: 10 }, (_, i) =>
    fixturePr(`PR${String(i).padStart(2, "0")}`, "submitted", `2026-07-13T11:${String(10 + i).padStart(2, "0")}:00.000Z`, `Subject ${i}`),
  )
  return fixtureSnapshot(fixtureResult(prs, []), { rowLimit })
}

function pendingRowCount(text: string): number {
  return new Set(text.match(/PR\d\d\.\d/gu) ?? []).size
}

describe("queue timeline row cap derives from pane height (item 5)", () => {
  it("the cap is the terminal rows less the fixed pane chrome, not a fixed ~20", () => {
    // Derives from pane height: a taller terminal yields a larger cap.
    expect(queueTimelineRowLimit({ rows: 40 })).toBe(26)
    expect(queueTimelineRowLimit({ rows: 60 })).toBe(46)
    expect(queueTimelineRowLimit({ rows: 40 })).toBeLessThan(queueTimelineRowLimit({ rows: 80 }))
    // A headless caller with no row count falls back to a conservative page.
    expect(queueTimelineRowLimit({ rows: undefined })).toBe(20)
  })

  it("keeps the cap + coverage authoritative in BOTH the interactive pane and the print path", async () => {
    const snapshot = manyPendingSnapshot(3)
    expect(snapshot.projection.display).toMatchObject({ shown: 3, hidden: 7 })

    const interactive = createRenderer({ cols: 110, rows: 40 })
    const app = interactive(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      expect(pendingRowCount(app.text), "interactive pane honors the cap").toBe(3)
      expect(app.text, "interactive pane keeps the coverage row").toContain("... 7 more")
    } finally {
      app.unmount()
    }

    const print = createRenderer({ cols: 110, rows: 40 })
    const printed = print(createElement(QueueTimelineView, { projection: snapshot.projection, nav: false, columns: 110 }))
    try {
      await printed.waitForLayoutStable()
      expect(pendingRowCount(printed.text), "print path honors the cap").toBe(3)
      expect(printed.text, "print path keeps the coverage row").toContain("... 7 more")
    } finally {
      printed.unmount()
    }
  })

  it("the row block fills the pane so STATS anchors below the rows", async () => {
    // A full-tier single pane (narrow + short → detail collapses) so the
    // timeline owns the whole height with no detail pane below, and the grown
    // row block reaches down the pane with STATS anchored beneath it.
    const snapshot = manyPendingSnapshot(30)
    const render = createRenderer({ cols: 76, rows: 30 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      // Full tier renders no detail pane, so the PR rows are all timeline rows.
      expect(app.text, "detail pane is collapsed at full tier").not.toContain("OUTCOME")
      const rows = app.text.split("\n")
      const statsY = rows.findIndex((row) => row.includes("ACTIVE ALL"))
      const lastRowY = rows.reduce((last, row, index) => (/PR\d\d\.\d/u.test(row) ? index : last), -1)
      expect(statsY, "STATS renders").toBeGreaterThan(0)
      expect(lastRowY, "rows fill past the top chrome").toBeGreaterThan(14)
      expect(statsY, "STATS anchors below the filled rows").toBeGreaterThan(lastRowY)
    } finally {
      app.unmount()
    }
  })
})
