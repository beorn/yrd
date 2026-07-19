// @failure The anchored-freshness cue is a passive `N new` label — it does not read as a down-arrow jump affordance and clicking it does nothing, so an operator cannot jump to the newest row and clear the count.
// @level l2
// @consumer @yrd/cli watch

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it, vi } from "vitest"
import { fixturePr, fixtureResult, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineView } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

// Item 4-new — the freshness cue renders as `↓ N new` in the dim warning color
// and is a click-to-jump affordance: clicking it jumps the cursor to the newest
// row and clears the count (wired to the pane's default-follow path).

function pendingSnapshot(prs: ReadonlyArray<readonly [string, string]>) {
  return fixtureSnapshot(
    fixtureResult(
      prs.map(([id, ts]) => fixturePr(id, "submitted", ts, `Subj ${id}`)),
      [],
    ),
    { rowLimit: 20 },
  )
}

function pointOf(text: string, pattern: RegExp): readonly [number, number] {
  const rows = text.split("\n")
  for (let y = 0; y < rows.length; y += 1) {
    const match = pattern.exec(rows[y] ?? "")
    if (match !== null) return [match.index, y]
  }
  throw new Error(`no on-screen match for ${pattern}`)
}

describe("queue freshness cue is a click-to-jump affordance (item 4-new)", () => {
  it("renders `↓ N new` and fires the jump handler when clicked", async () => {
    const onJumpToNewest = vi.fn()
    const projection = pendingSnapshot([["PRA", "2026-07-13T11:10:00.000Z"]]).projection
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(
      createElement(QueueTimelineView, {
        projection,
        nav: true,
        columns: 160,
        paneChrome: true,
        freshRows: 3,
        onJumpToNewest,
      }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text, "cue reads as a down-arrow jump affordance").toContain("↓ 3 new")

      const cue = pointOf(app.text, /↓ 3 new/u)
      app.click(cue[0], cue[1])
      expect(onJumpToNewest, "clicking the cue fires the jump handler").toHaveBeenCalledTimes(1)
    } finally {
      app.unmount()
    }
  })

  it("clears the count once the newest row is reached by clicking the cue", async () => {
    // Pin the cursor to a lower row, then let a newer row arrive above it — the
    // count rises. Clicking the cue jumps to the newest row and clears it.
    const before = pendingSnapshot([
      ["PRB", "2026-07-13T11:20:00.000Z"],
      ["PRC", "2026-07-13T11:30:00.000Z"],
    ])
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(createElement(QueueWatchFrame, { snapshot: before }))
    try {
      await app.waitForLayoutStable()
      const pin = pointOf(app.text, /pr#C\.1/u)
      app.click(pin[0], pin[1])
      await app.waitForLayoutStable()

      const after = pendingSnapshot([
        ["PRA", "2026-07-13T11:10:00.000Z"],
        ["PRB", "2026-07-13T11:20:00.000Z"],
        ["PRC", "2026-07-13T11:30:00.000Z"],
      ])
      app.rerender(createElement(QueueWatchFrame, { snapshot: after }))
      await app.waitForLayoutStable()
      expect(app.text, "a new row above the pinned cursor raises the count").toMatch(/↓ \d+ new/u)

      const cue = pointOf(app.text, /↓/u)
      app.click(cue[0], cue[1])
      await app.waitForLayoutStable()
      expect(app.text, "clicking the cue clears the count").not.toMatch(/↓ \d+ new/u)
    } finally {
      app.unmount()
    }
  })
})
