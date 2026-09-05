/**
 * @failure `yrd watch` RSS grows unboundedly over long uptimes — a 4h live
 *          soak measured 1,775.8 MB -> 14,918.0 MB, 59 MB/min, OLS r²=0.990,
 *          root-caused to React 19's dev-build `performance.measure()`/
 *          `mark()` firing ~342/s and never cleared (@yrd/cli/
 *          watch-rss-bounded, 2026-08-30; integrated at yrd f42e8022).
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * Silvery bounds the development performance timeline at its commit boundary.
 * Render with the watch timer off so a Yrd-specific interval cannot mask a
 * missing renderer bound. Real marks and measures arrive before each commit;
 * clearing only one type still lets the other accumulate.
 */

import { createElement } from "react"
import { render } from "silvery/test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Row } from "@yrd/queue-core"
import { WatchPane, type WatchSnapshot } from "../src/watch-pane.tsx"

const NOW = Date.parse("2026-09-03T12:00:00.000Z")
const ENTRIES_PER_COMMIT = 40
const ROUNDS = 25

/**
 * Stands in for React's dev-build profiling marks/measures: one mark plus one
 * measure derived from it, `ENTRIES_PER_COMMIT` times. `measure()` leaves its
 * start mark on the timeline too, so this exercises both entry types — an
 * implementation that clears only one of `clearMeasures`/`clearMarks` still
 * lets half the noise accumulate.
 */
function addPerformanceNoise(): void {
  for (let index = 0; index < ENTRIES_PER_COMMIT; index += 1) {
    performance.mark(`watch-rss-bounded-mark-${String(index)}`)
    performance.measure(`watch-rss-bounded-measure-${String(index)}`, `watch-rss-bounded-mark-${String(index)}`)
  }
}

function row(branch: string, state: Row["state"]): Row {
  return {
    branch,
    head: branch.padEnd(40, "0"),
    since: new Date(NOW - 60_000),
    state,
    subject: `${branch} does its work`,
  }
}

function snapshot(): WatchSnapshot {
  return {
    at: new Date(NOW),
    detail: new Map(),
    queue: "example.test/repo#main",
    rows: [row("task/one", "queued"), row("task/two", "checked"), row("task/three", "merged")].map((each) => ({
      row: each,
    })),
  }
}

describe("watch rendering bounds the performance timeline (@yrd/cli/watch-rss-bounded)", () => {
  beforeEach(() => {
    performance.clearMarks()
    performance.clearMeasures()
  })

  afterEach(() => {
    performance.clearMarks()
    performance.clearMeasures()
  })

  it("keeps entries bounded across commits without the watch timer", async () => {
    const app = render(createElement(WatchPane, { live: false, snapshot: snapshot() }), { cols: 120, rows: 40 })
    try {
      await app.waitForLayoutStable()

      const countsAfterCommit: number[] = []
      for (let round = 0; round < ROUNDS; round += 1) {
        addPerformanceNoise()
        // A stubbed performance API must not turn boundedness into a vacuous pass.
        if (round === 0) expect(performance.getEntries().length).toBeGreaterThanOrEqual(2 * ENTRIES_PER_COMMIT)
        // The snapshot prop seeds state only once. Toggle visible help to
        // force a real commit without relying on the watch's aging timer.
        await app.press(round % 2 === 0 ? "?" : "Escape")
        await app.waitForLayoutStable()
        expect(app.text.includes("leave the watch"), app.text).toBe(round % 2 === 0)
        countsAfterCommit.push(performance.getEntries().length)
      }

      // Each round adds 80 entries: without a bound, 25 rounds retain 2,000.
      // Check the whole run, not only the final commit; one uncleared type
      // alone grows past this bound of 200.
      const bound = 5 * ENTRIES_PER_COMMIT
      const peak = Math.max(...countsAfterCommit)
      expect(
        peak,
        `entry count must stay bounded across ${String(ROUNDS)} commits (samples: ${countsAfterCommit.join(", ")})`,
      ).toBeLessThan(bound)
    } finally {
      app.unmount()
    }
  })
})
