/**
 * @failure The watch shows one queue and hides the rest, or it labels queues
 *          on a single-queue repository and changes output nobody asked to
 *          change.
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * Multi-queue watch (user directive 2026-08-13): every queue is shown at once,
 * each carries a 1..N label, the labels are a legend on the filter row, all are
 * selected by default, and the matching digit toggles one off. Run references
 * take the compact `1:main#2173` form ONLY where more than one queue exists.
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

  it("shows both queues' runs at once, each row carrying its queue's label", async () => {
    const app = createRenderer({ cols: 140, rows: 40 })(createElement(QueueWatchFrame, { snapshot: twoQueues() }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("1:main#1")
      expect(app.text).toContain("2:release/next#7")
    } finally {
      app.unmount()
    }
  })

  it("renders the queue legend on the same row as the status filters", async () => {
    const app = createRenderer({ cols: 140, rows: 40 })(createElement(QueueWatchFrame, { snapshot: twoQueues() }))
    try {
      await app.waitForLayoutStable()
      // `N:base` (operator ruling 2026-08-18, item 9), e.g. `1:main` — the
      // SAME prefix shape a RUN identifier now carries (item 11), so the
      // legend row is the one line where BOTH queues' labels co-occur; a
      // single run row only ever carries one.
      const legendRow = app.text.split("\n").find((row) => row.includes("1:main") && row.includes("2:release/next"))
      expect(legendRow, "the legend must render").toBeDefined()
      // Same line as the status filters, and to the LEFT of them.
      expect(legendRow).toContain("failed")
      expect((legendRow ?? "").indexOf("1:main")).toBeLessThan((legendRow ?? "").indexOf("failed"))
    } finally {
      app.unmount()
    }
  })

  it("says QUEUES rather than naming one base while listing several", async () => {
    const app = createRenderer({ cols: 140, rows: 40 })(createElement(QueueWatchFrame, { snapshot: twoQueues() }))
    try {
      await app.waitForLayoutStable()
      // Row 0 is the watch pane's own top line (item 12, always present:
      // "YRD MERGE QUEUE ... for ..."); the QUEUE tab's own label sits one
      // row lower.
      expect(app.text.split("\n")[0]).toContain("YRD MERGE QUEUE")
      expect(app.text.split("\n")[1]).toContain("QUEUES")
      expect(app.text.split("\n")[1]).not.toContain("QUEUE main")
    } finally {
      app.unmount()
    }
  })

  it("filters to only the pressed queue's digit, and `a` restores every queue", async () => {
    // Select-only, the same idiom as the status pills' lowercase o/r/d/f
    // (operator ruling 2026-08-18, item 9 — "pressing 1/2 filters TO that
    // queue"; supersedes the 2026-08-13 toggle-off directive this replaced).
    const app = createRenderer({ cols: 140, rows: 40 })(createElement(QueueWatchFrame, { snapshot: twoQueues() }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("1:main#1")
      expect(app.text).toContain("2:release/next#7")

      await app.press("2")
      await app.waitForLayoutStable()
      expect(app.text, "queue 2 is the only one shown").toContain("2:release/next#7")
      expect(app.text, "queue 1 is filtered out").not.toContain("1:main#1")

      await app.press("1")
      await app.waitForLayoutStable()
      expect(app.text, "pressing 1 now filters to queue 1 instead").toContain("1:main#1")
      expect(app.text, "queue 2 is filtered out").not.toContain("2:release/next#7")

      await app.press("a")
      await app.waitForLayoutStable()
      expect(app.text, "`a` restores every queue").toContain("1:main#1")
      expect(app.text, "`a` restores every queue").toContain("2:release/next#7")
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

  it("leaves a single-queue watch exactly as it was — no labels, no legend", async () => {
    const single = fixtureSnapshot(mainQueue())
    expect(single.projection.queues).toEqual([{ label: 1, base: "main" }])
    expect(single.projection.rows.every((row) => row.queueLabel === undefined)).toBe(true)

    const app = createRenderer({ cols: 140, rows: 40 })(createElement(QueueWatchFrame, { snapshot: single }))
    try {
      await app.waitForLayoutStable()
      // Row 0 is the watch pane's own top line (item 12, always present,
      // orthogonal to single- vs multi-queue); the QUEUE tab's own label
      // sits one row lower.
      expect(app.text.split("\n")[1]).toContain("QUEUE main")
      expect(app.text).toContain("main#1")
      expect(app.text, "no label prefix on a single queue").not.toContain("1:main#1")
      expect(app.text, "no legend to offer a choice that does not exist").not.toContain("1:main")
    } finally {
      app.unmount()
    }
  })
})
