/**
 * @failure The watch pane has no identifying top line, or the repository it
 *          projects reads as part of the title instead of a muted aside.
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * Operator ruling 2026-08-18, item 12: `YRD MERGE QUEUE` left, the repository
 * this snapshot's Journal projects muted and right-aligned — `for /hh`. Sits
 * above BOTH the QUEUE and DETAIL panes (and above the QUEUE tab's own
 * "QUEUE main"/"QUEUES" label), since it identifies the whole pane rather
 * than either side of the split.
 */
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureRun, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

function snapshot() {
  const pr = fixturePr("PR1", "submitted", "2026-07-13T11:10:00.000Z", "Prepare release notes")
  const run = fixtureRun("R1", [pr], "passed", "2026-07-13T11:20:00.000Z", { finishedAt: "2026-07-13T11:25:00.000Z" })
  return fixtureSnapshot(fixtureResult([pr], [run]))
}

describe("watch pane top line (@yrd/cli/queue-watch-top-line)", () => {
  it("renders YRD MERGE QUEUE left and the repository muted and right-aligned", async () => {
    const app = createRenderer({ cols: 140, rows: 40 })(
      createElement(QueueWatchFrame, { snapshot: { ...snapshot(), repositoryRoot: "/hh" } }),
    )
    try {
      await app.waitForLayoutStable()
      const topRow = app.text.split("\n")[0] ?? ""
      expect(topRow).toContain("YRD MERGE QUEUE")
      expect(topRow).toContain("for /hh")
      // Left title, right-aligned repository aside — not adjacent, not swapped.
      expect(topRow.indexOf("YRD MERGE QUEUE")).toBeLessThan(topRow.indexOf("for /hh"))
      expect(topRow.indexOf("YRD MERGE QUEUE")).toBe(topRow.indexOf("YRD"))
      expect(topRow.trimEnd().endsWith("for /hh")).toBe(true)
    } finally {
      app.unmount()
    }
  })

  it("omits the repository aside when the snapshot does not carry one, rather than printing 'for undefined'", async () => {
    const app = createRenderer({ cols: 140, rows: 40 })(createElement(QueueWatchFrame, { snapshot: snapshot() }))
    try {
      await app.waitForLayoutStable()
      const topRow = app.text.split("\n")[0] ?? ""
      expect(topRow).toContain("YRD MERGE QUEUE")
      expect(topRow).not.toContain("for ")
      expect(topRow).not.toContain("undefined")
    } finally {
      app.unmount()
    }
  })

  it("stays above the QUEUE tab even before a projection has loaded", async () => {
    // The `snapshot.projection === undefined` render path is a separate
    // early return in QueueWatchFrame — the top line must not depend on it.
    const app = createRenderer({ cols: 140, rows: 40 })(
      createElement(QueueWatchFrame, {
        snapshot: { results: [], now: Date.parse("2026-07-13T11:10:00.000Z"), repositoryRoot: "/hh" },
      }),
    )
    try {
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      expect(rows[0]).toContain("YRD MERGE QUEUE")
      expect(rows[0]).toContain("for /hh")
    } finally {
      app.unmount()
    }
  })
})
