/**
 * @failure The RUNNER box's `source git:<sha>` line never flags a resident
 *          running a stale checkout: a watcher had to cross-reference the
 *          pin by hand to notice the runner kept executing old code while
 *          the pin advanced several times underneath it.
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * Box 2 of @yrd/core/stale-runner-never-recycles. `sourceBehind` is computed
 * at observation time (`runnerSourceBehind` in run.ts), never on the render
 * path — this test only proves the box renders (or omits) the flag once the
 * observation has supplied it.
 */
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineView, type QueueTimelineProjection } from "../src/queue-status-view.tsx"

const RUNNER_SHA = "8bbb3a96".padEnd(40, "0")

function projectionWithRunner(sourceBehind: number | undefined): QueueTimelineProjection {
  const pending = fixturePr("PR1", "submitted", "2026-07-13T11:10:00.000Z", "Prepare release notes")
  return fixtureSnapshot(fixtureResult([pending], []), {
    runner: {
      pid: 84042,
      startedAt: "2026-07-13T11:00:00.000Z",
      lastTickAt: "2026-07-13T11:59:58.000Z",
      queueProgress: { state: "healthy", observedAt: "2026-07-13T11:59:58.000Z" },
      implementationSource: `git:${RUNNER_SHA}`,
      ...(sourceBehind === undefined ? {} : { sourceBehind }),
    },
  }).projection
}

describe("RUNNER box source staleness flag (@yrd/core/stale-runner-never-recycles box 2)", () => {
  it("flags the source line inline when the resident is behind the checkout's pin", async () => {
    const app = createRenderer({ cols: 120, rows: 30 })(
      createElement(QueueTimelineView, { projection: projectionWithRunner(3), nav: false, columns: 120 }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain(`source git:${RUNNER_SHA} (3 behind pin)`)
    } finally {
      app.unmount()
    }
  })

  it("renders the bare source line, with no parenthetical, when the resident is current", async () => {
    const app = createRenderer({ cols: 120, rows: 30 })(
      createElement(QueueTimelineView, { projection: projectionWithRunner(undefined), nav: false, columns: 120 }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain(`source git:${RUNNER_SHA}`)
      expect(app.text).not.toContain("behind pin")
    } finally {
      app.unmount()
    }
  })
})
