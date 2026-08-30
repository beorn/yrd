/**
 * @failure `yrd watch` RSS grows unboundedly over long uptimes — a 4h live
 *          soak measured 1,775.8 MB -> 14,918.0 MB, 59 MB/min, OLS r²=0.990,
 *          root-caused to React 19's dev-build `performance.measure()`/
 *          `mark()` firing ~342/s and never cleared (@yrd/cli/
 *          watch-rss-bounded, 2026-08-30).
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * `useCoarseNow` (queue-status-view.tsx) owns the ONE `setInterval` that
 * runs for the life of `yrd watch`'s live pane. This test drives that loop
 * through many ticks while entries keep landing on the shared `performance`
 * timeline — standing in for whatever dev-build instrumentation produces
 * them, independent of this test's own renderer — and asserts the entry
 * count STAYS BOUNDED across the run. It never asserts that a particular
 * clearing function was called; an implementation that bounds the count by
 * any means satisfies it, and one that clears only marks or only measures
 * fails it, because half the injected noise keeps accumulating.
 */
import { act, createElement } from "react"
import { createRenderer } from "silvery/test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fixtureResult, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineView } from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
const TICK_MS = 1000
const ENTRIES_PER_TICK = 40
const ROUNDS = 25

// Stands in for React's dev-build profiling marks/measures: one mark plus
// one measure derived from it, `ENTRIES_PER_TICK` times. `measure()` leaves
// its start mark on the timeline too, so this exercises both entry types —
// an implementation that clears only one of `clearMeasures`/`clearMarks`
// still lets half the noise accumulate.
function addPerformanceNoise() {
  for (let i = 0; i < ENTRIES_PER_TICK; i += 1) {
    performance.mark(`watch-rss-bounded-mark-${i}`)
    performance.measure(`watch-rss-bounded-measure-${i}`, `watch-rss-bounded-mark-${i}`)
  }
}

describe("watch tick loop bounds the performance timeline (@yrd/cli/watch-rss-bounded)", () => {
  beforeEach(() => {
    performance.clearMarks()
    performance.clearMeasures()
  })

  afterEach(() => {
    performance.clearMarks()
    performance.clearMeasures()
  })

  it("keeps the performance entry count bounded across many live ticks instead of growing with tick count", async () => {
    const projection = fixtureSnapshot(fixtureResult([], [])).projection
    // `performance` is deliberately left OUT of the faked method set: Vitest's
    // (sinon) fake timers, when they fake `performance`, replace
    // `mark`/`measure` with no-ops and `getEntries*` with a constant empty
    // array — which would make this test pass unconditionally, with or
    // without the fix, because the injected noise would never really land on
    // the timeline. Only the timer surface the tick loop itself needs is
    // faked, so `setInterval` still advances deterministically while
    // `performance` stays real.
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
        "queueMicrotask",
      ],
    })
    vi.setSystemTime(NOW)
    const render = createRenderer({ cols: 120, rows: 40 })
    const tree = () => createElement(QueueTimelineView, { projection, columns: 120, nav: true, paneChrome: true })
    const app = await act(async () => render(tree()))
    try {
      await act(async () => {
        await app.waitForLayoutStable()
      })

      const countsAfterTick: number[] = []
      for (let round = 0; round < ROUNDS; round += 1) {
        addPerformanceNoise()
        // The tick's own `forceTick` state update happens inside this fake
        // timer advance (queue-status-view.tsx's `useCoarseNow` interval) —
        // `act` keeps it and the resulting re-render batched the way the
        // interactive pane's real event loop would.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(TICK_MS)
          app.rerender(tree())
        })
        countsAfterTick.push(performance.getEntries().length)
      }

      // Unbounded accumulation puts round N's count near
      // N * 2 * ENTRIES_PER_TICK (one mark + one measure per noise entry,
      // never cleared) — 2,000 by the last of 25 rounds here, and already
      // past this bound (200 = 5 ticks' worth) by round 3. A tick loop that
      // clears every tick keeps every round's count near a single round's
      // leftover, nowhere close to that line, at any point in the run — so
      // this checks the max across the WHOLE run, not just the final tick.
      const bound = 5 * ENTRIES_PER_TICK
      const peak = Math.max(...countsAfterTick)
      expect(
        peak,
        `entry count must stay bounded across ${ROUNDS} ticks, not grow with tick count (samples: ${countsAfterTick.join(", ")})`,
      ).toBeLessThan(bound)
    } finally {
      await act(async () => {
        app.unmount()
      })
      vi.useRealTimers()
    }
  })
})
