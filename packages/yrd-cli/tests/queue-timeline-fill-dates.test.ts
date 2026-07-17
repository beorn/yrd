// @failure In the live fill pane the TIME cell shows the full ISO datetime and the day is not carried by date-header rows, so multi-day queues read as a wall of redundant datestamps with no clean day boundary.
// @level l2
// @consumer @yrd/cli watch

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fixturePr, fixtureResult } from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineView, queueTimelineAdmissionTimes, queueTimelineProjection } from "../src/queue-status-view.tsx"

// Item 1 (regression) — in the fill pane the TIME cell must show time-of-day
// only (HH:MM:SS), and the day must be carried by r5-style YYYY-MM-DD header
// rows: a leading header for the first visible day (since the TIME cell no
// longer carries the date) plus one at each local calendar-day boundary. The
// one-shot print path is pinned unchanged (it keeps its inline-date TIME cell).

const NOW = Date.parse("2026-07-14T12:00:00.000Z")

/** Three pending rows whose LOCAL clock (Asia/Kolkata, UTC+5:30) straddles one
 *  midnight: 23:50 (day 13) -> 00:10, 00:30 (day 14). */
function twoDayProjection() {
  const a = fixturePr("PR1", "submitted", "2026-07-13T18:20:00.000Z", "Before midnight")
  const b = fixturePr("PR2", "submitted", "2026-07-13T18:40:00.000Z", "After midnight")
  const c = fixturePr("PR3", "submitted", "2026-07-13T19:00:00.000Z", "Still after midnight")
  const result = fixtureResult([a, b, c], [])
  return queueTimelineProjection([result], {
    now: NOW,
    windowMs: 48 * 60 * 60_000,
    statuses: [],
    terms: [],
    latest: false,
    rowLimit: 20,
    submissionTimes: queueTimelineAdmissionTimes([result]),
  })
}

const ISO_DATETIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u

function headerRows(text: string): string[] {
  return text
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/u.test(row))
}

describe("queue timeline fill-mode dates (item 1)", () => {
  let priorTZ: string | undefined
  beforeAll(() => {
    priorTZ = process.env.TZ
    process.env.TZ = "Asia/Kolkata"
  })
  afterAll(() => {
    if (priorTZ === undefined) delete process.env.TZ
    else process.env.TZ = priorTZ
  })

  it("fill pane shows time-only TIME and carries the day in leading + boundary headers", async () => {
    const projection = twoDayProjection()
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(
      createElement(QueueTimelineView, {
        projection,
        columns: 120,
        paneChrome: true,
        fillHeight: true,
        nav: true,
        cursorKey: 0,
      }),
    )
    try {
      await app.waitForLayoutStable()
      // TIME cell is time-of-day only — no full ISO datetime anywhere in the pane.
      expect(app.text, "fill TIME cell drops the inline date").not.toMatch(ISO_DATETIME)
      const firstRow = app.text.split("\n").find((row) => row.includes("PR1")) ?? ""
      expect(firstRow, "the PR1 row shows HH:MM:SS").toContain("23:50:00")

      // The day is carried by header rows: a LEADING header for the first day
      // AND a boundary header at the local midnight crossing.
      expect(headerRows(app.text), "leading + boundary day headers render in fill mode").toEqual([
        "2026-07-13",
        "2026-07-14",
      ])
    } finally {
      app.unmount()
    }
  })

  it("pins the one-shot print path: inline-date TIME, boundary header only, no leading header", async () => {
    const projection = twoDayProjection()
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      expect(app.text, "print keeps its inline-date TIME cell").toMatch(ISO_DATETIME)
      expect(headerRows(app.text), "print keeps the boundary header, no leading header").toEqual(["2026-07-14"])
    } finally {
      app.unmount()
    }
  })
})
