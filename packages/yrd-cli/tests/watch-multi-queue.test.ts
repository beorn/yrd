/**
 * @failure The watch shows one queue and hides the rest, the queue pills
 *          leave the top line, digits stop toggling, or run cells regress to
 *          the killed digit-prefix form.
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * Multi-queue watch under the ratified display model (operator rulings
 * 2026-08-18, items 32/34/36/38): every queue is shown at once as an ON/OFF
 * pill on the TOP line (`1 /hh ⎇ main`), its digit TOGGLES the queue, `a`
 * restores everything, and run cells read `label#N <glyph>` — the label
 * eliding when exactly one queue is visible, never spelled as a digit.
 */
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import {
  fixtureMultiQueueSnapshot,
  fixturePr,
  fixtureRebase,
  fixtureResult,
  fixtureRun,
  fixtureSnapshot,
} from "../dev/queue-timeline-fixtures.ts"
import { queueTimelineVisibleRows } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

function mainQueue() {
  const pr = fixturePr("PR1", "submitted", "2026-07-13T11:10:00.000Z", "Prepare release notes")
  const run = fixtureRun("R1", [pr], "passed", "2026-07-13T11:20:00.000Z", { finishedAt: "2026-07-13T11:25:00.000Z" })
  return fixtureResult([pr], [run])
}

function releaseQueue() {
  const pr = fixturePr("PR7", "submitted", "2026-07-13T11:22:00.000Z", "Cut the release branch")
  const run = fixtureRun("R7", [pr], "passed", "2026-07-13T11:30:00.000Z", { finishedAt: "2026-07-13T11:44:00.000Z" })
  return fixtureRebase("release/next", fixtureResult([pr], [run]))
}

function twoQueues() {
  return fixtureMultiQueueSnapshot([mainQueue(), releaseQueue()])
}

describe("multi-queue watch (@yrd/cli/watch-multi-queue)", () => {
  it("labels every queue it covers, primary base first", () => {
    expect(twoQueues().projection.queues).toEqual([
      { label: 1, base: "main" },
      { label: 2, base: "release/next" },
    ])
  })

  it("shows both queues' runs at once, run cells label-led, never digit-prefixed", async () => {
    const app = createRenderer({ cols: 140, rows: 40 })(createElement(QueueWatchFrame, { snapshot: twoQueues() }))
    try {
      await app.waitForLayoutStable()
      // Item 38: `label#N` + state glyph — the label is the queue's base
      // branch until config handles exist; digits never appear in names
      // (item 34 killed `1:main#1`).
      expect(app.text).toContain("main#1 ✓")
      expect(app.text).toContain("release/next#7 ✓")
      expect(app.text).not.toContain("1:main#1")
      expect(app.text).not.toContain("2:release/next#7")
    } finally {
      app.unmount()
    }
  })

  it("renders the queue pills on the top line, branch glyph and all", async () => {
    const app = createRenderer({ cols: 140, rows: 40 })(createElement(QueueWatchFrame, { snapshot: twoQueues() }))
    try {
      await app.waitForLayoutStable()
      const topRow = app.text.split("\n")[0] ?? ""
      expect(topRow).toContain("YRD QUEUES")
      // No repository path in these fixtures, so the pair degrades to its
      // branch half — digit, then `⎇ branch` (items 32d/36).
      expect(topRow).toContain("1 ⎇ main")
      expect(topRow).toContain("2 ⎇ release/next")
      // `all` rides the same pill group (it clears both filter kinds).
      expect(topRow).toContain("all")
      // The bottom row keeps only the status pills (item 32) — the legend no
      // longer renders beside them.
      const statusRow = app.text.split("\n").find((row) => /open.*running.*done.*failed/u.test(row))
      expect(statusRow, "status pills row renders").toBeDefined()
      expect(statusRow).not.toContain("⎇")
    } finally {
      app.unmount()
    }
  })

  it("toggles a queue off and on with its digit, and `a` restores every queue", async () => {
    // Digits TOGGLE membership (item 32, restoring the 2026-08-13 toggle the
    // items-8-22 build had replaced with select-only).
    const app = createRenderer({ cols: 140, rows: 40 })(createElement(QueueWatchFrame, { snapshot: twoQueues() }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("main#1")
      expect(app.text).toContain("release/next#7")

      await app.press("2")
      await app.waitForLayoutStable()
      expect(app.text, "queue 2 toggled off").not.toContain("release/next#7")
      expect(app.text, "queue 1 still shown; its label elides as the only visible queue").toContain("#1 ✓")

      await app.press("2")
      await app.waitForLayoutStable()
      expect(app.text, "pressing 2 again toggles the queue back on").toContain("release/next#7")

      await app.press("1")
      await app.press("2")
      await app.waitForLayoutStable()
      expect(app.text, "both toggled off leaves no queue rows").not.toContain("#1 ✓")
      expect(app.text).not.toContain("release/next#7")

      await app.press("a")
      await app.waitForLayoutStable()
      expect(app.text, "`a` restores every queue").toContain("main#1")
      expect(app.text, "`a` restores every queue").toContain("release/next#7")
    } finally {
      app.unmount()
    }
  })

  it("filters rows by queue at the projection seam, not only in the view", () => {
    const projection = twoQueues().projection
    const onlyMain = queueTimelineVisibleRows(projection, undefined, true, new Set(["main"]))
    expect(onlyMain.length).toBeGreaterThan(0)
    expect(onlyMain.every((row) => row.base === "main")).toBe(true)
    expect(queueTimelineVisibleRows(projection, undefined, true).length).toBeGreaterThan(onlyMain.length)
  })

  it("elides the run-cell label on a single-queue watch while the pill still names the queue", async () => {
    const single = fixtureSnapshot(mainQueue())
    expect(single.projection.queues).toEqual([{ label: 1, base: "main" }])
    expect(single.projection.rows.every((row) => row.queueLabel === undefined)).toBe(true)

    const app = createRenderer({ cols: 140, rows: 40 })(createElement(QueueWatchFrame, { snapshot: single }))
    try {
      await app.waitForLayoutStable()
      // Exactly one queue visible: context supplies the label, the run CELL
      // elides it (items 34/38) — `#1 ✓`, never `main#1 ✓`. The detail box
      // border legitimately keeps the full `RUN main#1` identity (item 39).
      expect(app.text).toContain("#1 ✓")
      expect(app.text).not.toContain("main#1 ✓")
      // The queue's identity still shows — on its top-line pill.
      expect(app.text.split("\n")[0]).toContain("1 ⎇ main")
    } finally {
      app.unmount()
    }
  })
})
