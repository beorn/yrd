// @failure Queue timeline entries spanning multiple local calendar days render with no visual day boundary
// @level l2
// @consumer @yrd/cli

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fixturePr, fixtureResult } from "../dev/queue-timeline-fixtures.ts"
import {
  QueueTimelineView,
  queueTimelineAdmissionTimes,
  queueTimelineDateSeparatorLabel,
  queueTimelineProjection,
  queueTimelineVisibleRows,
  type QueueTimelineProjectedRow,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-07-14T12:00:00.000Z")

/**
 * Three pending entries whose LOCAL submission clock (TZ pinned to
 * Asia/Kolkata, UTC+5:30, below) straddles one local midnight: the first two
 * cross a calendar-day boundary five minutes apart (23:50 -> 00:10), the
 * third stays on the later day thirty minutes after that (00:10 -> 00:30).
 */
function twoDayProjection(): QueueTimelineProjection {
  const beforeMidnight = fixturePr("PR1", "submitted", "2026-07-13T18:20:00.000Z", "Before midnight")
  const afterMidnight = fixturePr("PR2", "submitted", "2026-07-13T18:40:00.000Z", "After midnight")
  const sameDayAsAfter = fixturePr("PR3", "submitted", "2026-07-13T19:00:00.000Z", "Still after midnight")
  const result = fixtureResult([beforeMidnight, afterMidnight, sameDayAsAfter], [])
  const submissionTimes = queueTimelineAdmissionTimes([result])
  return queueTimelineProjection([result], {
    now: NOW,
    windowMs: 48 * 60 * 60_000,
    statuses: [],
    terms: [],
    latest: false,
    rowLimit: 20,
    submissionTimes,
  })
}

describe("K date-header sub-item — queue timeline date-header separator", () => {
  let priorTZ: string | undefined
  beforeAll(() => {
    priorTZ = process.env.TZ
    // UTC+5:30, no DST — a deterministic local-midnight boundary for the
    // fixture above, matching the pinned zone the sibling contract suite
    // already uses.
    process.env.TZ = "Asia/Kolkata"
  })
  afterAll(() => {
    if (priorTZ === undefined) delete process.env.TZ
    else process.env.TZ = priorTZ
  })

  it("queueTimelineDateSeparatorLabel fires only across a local calendar-day change", () => {
    const projection = twoDayProjection()
    const rows = queueTimelineVisibleRows(projection)
    expect(rows.map((row) => row.pr)).toEqual(["PR1", "PR2", "PR3"])

    // No separator above the very first row (design call: BETWEEN entries
    // only, never a leading header).
    expect(queueTimelineDateSeparatorLabel(undefined, rows[0]!)).toBeNull()
    // A row compared with itself shares a calendar day.
    expect(queueTimelineDateSeparatorLabel(rows[0]!, rows[0]!)).toBeNull()
    // The local-midnight crossing yields the next day's label.
    expect(queueTimelineDateSeparatorLabel(rows[0]!, rows[1]!)).toBe("2026-07-14")
    // PR2 and PR3 share the later local day: no separator between them.
    expect(queueTimelineDateSeparatorLabel(rows[1]!, rows[2]!)).toBeNull()

    // An untimed entry on either side suppresses the separator — there is no
    // day to anchor a boundary to.
    const untimed: QueueTimelineProjectedRow = { ...rows[1]!, timestamp: null }
    expect(queueTimelineDateSeparatorLabel(rows[0]!, untimed)).toBeNull()
    expect(queueTimelineDateSeparatorLabel(untimed, rows[1]!)).toBeNull()
  })

  it("renders exactly one H1-styled YYYY-MM-DD separator between the two days and none within a day", async () => {
    const projection = twoDayProjection()
    const width = 120
    const render = createRenderer({ cols: width, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, columns: width }))
    try {
      await app.waitForLayoutStable()
      const rendered = app.text.split("\n")
      const separators = rendered.filter((entry) => /^\d{4}-\d{2}-\d{2}$/u.test(entry.trim()))
      expect(separators).toEqual(["2026-07-14"])
      // No leading separator above the first day's entries.
      expect(rendered.some((entry) => entry.trim() === "2026-07-13")).toBe(false)

      const separatorAt = rendered.findIndex((entry) => entry.trim() === "2026-07-14")
      expect(separatorAt).toBeGreaterThan(0)
      const separatorColumn = rendered[separatorAt]!.indexOf("2026-07-14")
      const separatorCell = app.cell(separatorColumn, separatorAt)
      // H1 typography preset: bold, and a fg distinct from a plain body cell.
      expect(separatorCell.bold, "date separator uses the H1 preset (bold)").toBe(true)
      const bodyAt = rendered.findIndex((entry) => entry.includes("PR1"))
      const bodyColumn = rendered[bodyAt]!.indexOf("PR1")
      const bodyCell = app.cell(bodyColumn, bodyAt)
      expect(separatorCell.fg, "H1 fg differs from a plain PR-id cell").not.toEqual(bodyCell.fg)
    } finally {
      app.unmount()
    }
  })
})
