import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureRun, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { queueTimelineDisplayRows, queueTimelineVisibleRows } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

/**
 * The watch timeline must not MOUNT every retained row (@yrd/cli/22258).
 *
 * ListView's default virtualization is "none" for lists up to
 * DEFAULT_VIRTUALIZATION_THRESHOLD items — raised 100 → 10,000 in 15332 Wave 3
 * (W7) for silvercode chat — so a production timeline (~1,000 rows) silently
 * mounted every row: React fibers, flexily layout nodes, and per-row props for
 * the whole retained set, walked by the render pipeline on every frame. A live
 * pane measured ~260 KB RSS and ~2 idle-CPU points per 100 rows from that;
 * with ~40 rows visible, ~96% of the mounted tree was never on screen.
 *
 * The timeline opts into index-window virtualization explicitly, and this test
 * pins the MOUNT bound — not the ANSI output (clipped rows never appear in the
 * frame text either way, so a text assertion cannot fail for this defect).
 * Mounted rows are counted through the per-cell `td-time-<rowId>` ids the row
 * submodule already carries.
 */
describe("queue timeline mounts a bounded row window (@yrd/cli/22258)", () => {
  it("keeps the mounted row count bounded when the projection holds hundreds of rows", async () => {
    const at = (index: number): string =>
      new Date(Date.parse("2026-07-13T06:00:00.000Z") + index * 45_000).toISOString()
    const prs = Array.from({ length: 400 }, (_, index) =>
      fixturePr(`PR${index + 1}`, "rejected", at(index), `Fixture PR${index + 1}`, { rejectedAt: at(index) }),
    )
    const runs = prs.map((pr, index) =>
      fixtureRun(`R${index + 1}`, [pr], "failed", at(index), { finishedAt: at(index) }),
    )
    const snapshot = fixtureSnapshot(fixtureResult(prs, runs))

    // Guard: the DATA really carries hundreds of display rows, so the mount
    // bound below cannot pass because a projection cap emptied the list.
    const displayRows = queueTimelineDisplayRows(
      queueTimelineVisibleRows(snapshot.projection, undefined, true),
      new Set(),
    )
    expect(displayRows.length, "fixture must produce a large timeline").toBeGreaterThanOrEqual(400)

    const app = createRenderer({ cols: 120, rows: 40 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      const mounted = app.locator('[id^="td-time-"]').count()
      expect(mounted, "at least a viewport of rows must mount").toBeGreaterThanOrEqual(10)
      // Index-window bound: DEFAULT_MAX_RENDERED (100) plus slack for the
      // window's date-header composites. Render-every-row puts 400 here.
      expect(mounted, "the timeline must window its mounts, not render every retained row").toBeLessThanOrEqual(120)
    } finally {
      app.unmount()
    }
  })
})
