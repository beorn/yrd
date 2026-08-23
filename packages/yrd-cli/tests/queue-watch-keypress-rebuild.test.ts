/**
 * @failure Moving the watch cursor rebuilds every Run's detail projection inside the QueueWatchFrame render, so each keypress pays the whole queue's detail cost to change which row is highlighted.
 * @level l2
 * @consumer @yrd/cli `queue list --watch` operators
 */
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"

import { fixturePr, fixtureResult, fixtureRun, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const RUNS = 24

/** Reads of `status` are the probe: `queueShowData` derives its retry peers with
 * `allRuns.filter(c => c.status === "completed")`, so one full detail build over
 * N Runs reads it about N*N times. That makes "did the whole detail set get
 * rebuilt?" directly observable without timing anything — the host's load makes
 * wall-clock useless here. */
function countingSnapshot(tally: { reads: number }): ReturnType<typeof fixtureSnapshot> {
  const prs = Array.from({ length: RUNS }, (_, index) =>
    fixturePr(`PR${String(index)}`, "submitted", `2026-07-13T10:${String(index).padStart(2, "0")}:00.000Z`),
  )
  const runs = prs.map((pr, index) => {
    const at = `2026-07-13T11:${String(index).padStart(2, "0")}:00.000Z`
    const run = fixtureRun(`R${String(index)}`, [pr], "passed", at, { finishedAt: at })
    const status = run.status
    return Object.defineProperty({ ...run }, "status", {
      get(): unknown {
        tally.reads += 1
        return status
      },
      enumerable: true,
      configurable: true,
    }) as typeof run
  })
  return fixtureSnapshot(fixtureResult(prs, runs), { rowLimit: 40 })
}

describe("queue watch cursor movement", () => {
  it("does not rebuild every Run's detail projection on a cursor keypress", async () => {
    const tally = { reads: 0 }
    const snapshot = countingSnapshot(tally)
    const app = createRenderer({ cols: 200, rows: 50 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      const afterFirstPaint = tally.reads
      expect(afterFirstPaint, "the first paint must actually build the details").toBeGreaterThan(0)

      const before = app.text
      tally.reads = 0
      await app.press("j")
      await app.waitForLayoutStable()
      const perKeypress = tally.reads

      // POSITIVE CONTROL, and it is load-bearing: if the keypress never reached
      // the submodule the counter would read zero and this test would pass
      // having proved nothing. The frame must actually have re-rendered.
      expect(before, "the keypress must actually move the cursor and repaint").not.toBe(app.text)

      // A cursor move only changes which row is highlighted, so it must not
      // re-derive every Run's detail. The bound is linear in the Run count
      // because the rebuild is quadratic in it — `queueShowData` rescans the Run
      // list per Run. Measured: 744 reads before the fix, 0 after.
      expect(perKeypress).toBeLessThan(RUNS)
    } finally {
      app.unmount()
    }
  })
})
