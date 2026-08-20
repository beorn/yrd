/**
 * @failure The RUNNER box's `source git:<sha>` line never flags a resident
 *          running a stale checkout: a watcher had to cross-reference the
 *          pin by hand to notice the runner kept executing old code while
 *          the pin advanced several times underneath it.
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * Box 2 of @yrd/core/stale-runner-never-recycles. `sourcePin` is computed at
 * observation time (`runnerPinBehind` in run.ts) against the queue's RECORDED
 * pin (@i/10-merge-queue/23041-staleness-measures-the-observer) — this test
 * only proves the box renders (or omits) each pin state once the observation
 * has supplied it: a behind-count, a positive "at pin", a LOUD unknown with
 * its reason, and bare silence for an unpinned queue.
 */
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineView, type QueueTimelineProjection, type RunnerSourcePin } from "../src/queue-status-view.tsx"

const RUNNER_SHA = "8bbb3a96".padEnd(40, "0")

function projectionWithRunner(sourcePin: RunnerSourcePin | undefined): QueueTimelineProjection {
  const pending = fixturePr("PR1", "submitted", "2026-07-13T11:10:00.000Z", "Prepare release notes")
  return fixtureSnapshot(fixtureResult([pending], []), {
    runner: {
      pid: 84042,
      startedAt: "2026-07-13T11:00:00.000Z",
      lastTickAt: "2026-07-13T11:59:58.000Z",
      queueProgress: { state: "healthy", observedAt: "2026-07-13T11:59:58.000Z" },
      implementationSource: `git:${RUNNER_SHA}`,
      ...(sourcePin === undefined ? {} : { sourcePin }),
    },
  }).projection
}

async function renderedText(sourcePin: RunnerSourcePin | undefined): Promise<string> {
  const app = createRenderer({ cols: 120, rows: 30 })(
    createElement(QueueTimelineView, { projection: projectionWithRunner(sourcePin), nav: false, columns: 120 }),
  )
  try {
    await app.waitForLayoutStable()
    return app.text
  } finally {
    app.unmount()
  }
}

describe("RUNNER box source staleness flag (@yrd/core/stale-runner-never-recycles box 2)", () => {
  it("flags the source line inline when the resident is behind the recorded pin", async () => {
    const text = await renderedText({ state: "behind", commits: 3 })
    expect(text).toContain(`source git:${RUNNER_SHA} (3 behind pin)`)
  })

  it("states at-pin POSITIVELY when the resident sits exactly on the recorded pin", async () => {
    // "at pin" is a measured claim, not a default: silence is reserved for
    // queues with no pin at all, so a healthy pinned resident says so.
    const text = await renderedText({ state: "at" })
    expect(text).toContain(`source git:${RUNNER_SHA} (at pin)`)
  })

  it("renders an unreadable pin LOUDLY, with its reason, never as silence or a number", async () => {
    const text = await renderedText({ state: "unknown", reason: "origin/main unresolvable in the queue repository" })
    expect(text).toContain("pin unknown: origin/main unresolvable")
    expect(text).not.toContain("behind pin")
    expect(text).not.toContain("(at pin)")
  })

  it("renders the bare source line, with no parenthetical, for an unpinned queue", async () => {
    const text = await renderedText(undefined)
    expect(text).toContain(`source git:${RUNNER_SHA}`)
    expect(text).not.toContain("behind pin")
    expect(text).not.toContain("(at pin)")
    expect(text).not.toContain("pin unknown")
  })
})
