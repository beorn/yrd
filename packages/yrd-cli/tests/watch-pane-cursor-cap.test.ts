// @failure QueueWatchFrame's default cursor and detail name a row the capped timeline never renders
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

// Regression for 21106 r5: when pending rows fill the display row cap ahead of
// the running row (timelineSort orders pending -> running -> completed), the
// mandated "first running" default cursor lands OUTSIDE the rendered slice
// (ProjectedQueueTimeline only renders projection.rows.slice(0, display.shown)).
// Before the fix the numeric cursor pointed at that unrendered running row, so
// the ListView highlighted nothing while the detail pane resolved the hidden
// running run. Selection must be derived from the SAME visible-row set the list
// renders: the cursor must name a rendered row, and detail must show that row.
describe("QueueWatchFrame capped-timeline cursor", () => {
  function cappedPendingAheadOfRunning() {
    const pendingA = fixturePr("PRA", "submitted", "2026-07-13T11:10:00.000Z", "Pending alpha subject")
    const pendingB = fixturePr("PRB", "submitted", "2026-07-13T11:20:00.000Z", "Pending beta subject")
    const runningPr = fixturePr("PRR", "submitted", "2026-07-13T11:25:00.000Z", "Running gamma subject")
    const runningRun = fixtureRun("RR", [runningPr], "running", "2026-07-13T11:40:00.000Z", {
      steps: [fixtureStep("check", fixtureJob("JRR-check", "running"))],
    })
    // rowLimit 2 with two pending rows ahead of the running row: the running row
    // is the third row, one past the cap -> rendered slice is the two pending rows.
    return fixtureSnapshot(fixtureResult([pendingA, pendingB, runningPr], [runningRun]), { rowLimit: 2 })
  }

  it("keeps the default cursor and detail on a rendered row when pending rows fill the cap", async () => {
    const snapshot = cappedPendingAheadOfRunning()

    // Setup facts: pending fills the cap, the running row is present but hidden.
    expect(snapshot.projection.rows.map((row) => row.group)).toEqual(["pending", "pending", "running"])
    expect(snapshot.projection.display).toMatchObject({ shown: 2, hidden: 1 })

    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()

      // The rendered list caps at the two pending rows; the running row is beyond
      // the cap ("... 1 more"). "PRA.1" appears only in the timeline list, so its
      // presence proves the first pending row is within the rendered slice.
      expect(app.text).toContain("PRA.1")
      expect(app.text).toContain("PRB.1")
      expect(app.text).toContain("1 more")

      // The detail pane is driven by rows[cursor] (the selected row), so its
      // content is the observable identity of the selection.
      //
      // Contract — the default cursor selects the first RENDERED row (pending
      // PRA), and detail shows THAT row: PRDetailView renders "PR PRA STATUS ..."
      // only when the pending PRA row is selected.
      expect(app.text, "detail must resolve the first rendered (pending) row").toContain("PR PRA STATUS")

      // Regression — pre-fix the cursor pointed at the unrendered running row, so
      // the detail pane rendered the running run's workflow step tabs
      // ("ACTIVE STEP ...") and its "PRs PRR..." header for a row the list never
      // showed. Selection must never resolve an unrendered row.
      expect(app.text, "detail must not resolve the hidden running run").not.toContain("ACTIVE STEP")
      expect(app.text, "detail must not resolve the hidden running PR").not.toContain("PRs PRR")
    } finally {
      app.unmount()
    }
  })
})
