// @failure The FILTER/pills row sits above the list with a "FILTER" label and bracketed [p]ending pills, and a blank row pads above the table header.
// @level l2
// @consumer @yrd/cli watch

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult } from "../dev/queue-timeline-fixtures.ts"
import {
  QueueTimelineView,
  queueTimelineAdmissionTimes,
  queueTimelineProjection,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"

// Items 2/3/5 — the pills row moves BELOW the list (new order table header →
// rows → pills → stats), the "FILTER" label and the [p] brackets are
// gone (pills are plain words, hotkey hint carried by a bold first letter — the
// bold weight is verified by silvery's TogglePill unit test), and the blank row
// above the table header is removed.
//
// NOTE (deliberate contract change): the earlier "pills row directly ABOVE the
// list" layout-order call is overruled — the row now renders below the list.

const NOW = Date.parse("2026-07-14T12:00:00.000Z")

/** A runner-backed, unbounded-window projection (like the live watch) with a
 *  handful of pending rows — so no `since=` dimension and no detail pane. */
function paneProjection(): QueueTimelineProjection {
  const prs = Array.from({ length: 4 }, (_, i) =>
    fixturePr(`PR${i}`, "submitted", `2026-07-14T11:${String(10 + i).padStart(2, "0")}:00.000Z`, `Subject ${i}`),
  )
  const result = fixtureResult(prs, [])
  return queueTimelineProjection([result], {
    now: NOW,
    windowMs: 100 * 365 * 24 * 60 * 60_000,
    statuses: [],
    terms: [],
    latest: false,
    rowLimit: 20,
    submissionTimes: queueTimelineAdmissionTimes([result]),
    runner: { pid: 4242, startedAt: "2026-07-14T11:00:00.000Z", lastTickAt: "2026-07-14T11:59:58.000Z" },
  })
}

function rowIndex(text: string, pattern: RegExp): number {
  return text.split("\n").findIndex((row) => pattern.test(row))
}

describe("queue timeline FILTER pills row (items 2/3/5)", () => {
  it("orders table header → rows → pills → stats with no blank above the header", async () => {
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(
      createElement(QueueTimelineView, {
        projection: paneProjection(),
        columns: 120,
        paneChrome: true,
        fillHeight: true,
        nav: true,
        cursorKey: 0,
      }),
    )
    try {
      await app.waitForLayoutStable()
      const headerY = rowIndex(app.text, /\bTIME\b/u)
      const firstRowY = rowIndex(app.text, /pr#0\.\d/u)
      const pillsY = rowIndex(app.text, /pending.*running.*failed.*done/u)
      const flowY = rowIndex(app.text, /╭─ FLOW /u)

      expect(app.text).toContain("╭─ RUNNER ")
      expect(app.text).not.toContain("╭─ STATUS ")
      expect(headerY, "table header renders").toBeGreaterThanOrEqual(0)
      expect(firstRowY, "rows render below the header").toBeGreaterThan(headerY)
      expect(pillsY, "pills render below the rows").toBeGreaterThan(firstRowY)
      expect(flowY, "flow metrics render below the pills").toBeGreaterThan(pillsY)

      // Item 5: no blank row directly above the table header.
      const textRows = app.text.split("\n")
      expect(textRows[headerY - 1]?.trim(), "no blank row above the TIME header").not.toBe("")
    } finally {
      app.unmount()
    }
  })

  it("drops the FILTER label and the [p] brackets — pills are plain words", async () => {
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(
      createElement(QueueTimelineView, {
        projection: paneProjection(),
        columns: 120,
        paneChrome: true,
        fillHeight: true,
        nav: true,
        cursorKey: 0,
      }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text, "the FILTER label text is gone").not.toContain("FILTER")
      expect(app.text, "no [p]/[r]/[f]/[d] brackets").not.toMatch(/\[[prfd]\]/u)
      for (const word of ["pending", "running", "failed", "done"]) {
        expect(app.text, `the ${word} pill renders as a plain word`).toContain(word)
      }
    } finally {
      app.unmount()
    }
  })
})
