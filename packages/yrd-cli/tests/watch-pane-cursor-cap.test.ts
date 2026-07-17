// @failure QueueWatchFrame's default cursor and detail name a row the fill timeline never renders
// @level l2
// @consumer @yrd/cli

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
import { QueueWatchFrame } from "../src/watch-pane.tsx"

// Regression for 21106 r5, updated for the fill pane (item 5): the mandated
// "first running" default cursor must always name a RENDERED row, and detail
// must resolve THAT row. In r5 the pane pre-sliced to projection.display.shown,
// so pending rows ahead of the running row pushed the running row past the cap;
// the cursor then pointed at an unrendered row (empty highlight, detail on a
// hidden run). The fill pane drops that pre-slice: every retained row is in the
// virtualizing ListView, and watch-pane's cursor set is the SAME fill set, so a
// row the cursor names is always in the rendered list. This proves the fill
// pane renders the running row and the default cursor resolves it — the exact
// row the capped pane hid.
describe("QueueWatchFrame fill-timeline cursor", () => {
  function pendingAheadOfRunning() {
    const pendingA = fixturePr("PRA", "submitted", "2026-07-13T11:10:00.000Z", "Pending alpha subject")
    const pendingB = fixturePr("PRB", "submitted", "2026-07-13T11:20:00.000Z", "Pending beta subject")
    const runningPr = fixturePr("PRR", "submitted", "2026-07-13T11:25:00.000Z", "Running gamma subject")
    const runningRun = fixtureRun("RR", [runningPr], "running", "2026-07-13T11:40:00.000Z", {
      steps: [fixtureStep("check", fixtureJob("JRR-check", "running"))],
    })
    // rowLimit 2 forces the projection's coarse pre-slice (display.shown=2) — the
    // fill pane must ignore it and render every row against real pane height.
    return fixtureSnapshot(fixtureResult([pendingA, pendingB, runningPr], [runningRun]), { rowLimit: 2 })
  }

  it("renders every row and resolves the default cursor on the running row the pre-slice would hide", async () => {
    const snapshot = pendingAheadOfRunning()

    // Setup facts: the projection still computes its coarse cap (shown=2,
    // hidden=1), but the fill pane must not apply it.
    expect(snapshot.projection.rows.map((row) => row.group)).toEqual(["pending", "pending", "running"])
    expect(snapshot.projection.display).toMatchObject({ shown: 2, hidden: 1 })

    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()

      // Fill renders every row — the two pending rows AND the running row the
      // pre-slice would have hidden. No `... N more` residue in fill mode.
      expect(app.text, "first pending row renders").toContain("PRA.1")
      expect(app.text, "second pending row renders").toContain("PRB.1")
      expect(app.text, "the running row the cap hid now renders").toContain("PRR.1")
      expect(app.text, "fill suppresses the pre-slice residue").not.toContain("... 1 more")

      // The mandated default cursor is the first RUNNING row. Now that it
      // renders, detail resolves that running run (its RUN LOGS section and
      // `PRs      PRR` header) — the cursor names a rendered row. The detail rework
      // (W3) prints the run status inline rather than an "OUTCOME" label, so
      // anchor on the RUN LOGS accordion the detail body renders.
      expect(app.text, "detail resolves the running run's log section").toContain("RUN LOGS")
      expect(app.text, "detail resolves the running run's PR").toContain("PRs      PRR")
    } finally {
      app.unmount()
    }
  })
})
