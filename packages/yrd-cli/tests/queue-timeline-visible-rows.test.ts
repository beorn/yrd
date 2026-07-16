import { describe, expect, test } from "vitest"
import {
  queueTimelineVisibleDefaultCursorId,
  queueTimelineVisibleRows,
  type QueueTimelineProjectedRow,
} from "../src/queue-status-view.tsx"

function projectedRow(
  id: string,
  group: QueueTimelineProjectedRow["group"],
  status: QueueTimelineProjectedRow["status"],
): QueueTimelineProjectedRow {
  return {
    id,
    base: "main",
    group,
    status,
    glyph: "",
    timestamp: null,
    timestampMs: null,
    ...(group === "running" ? { run: `run-${id}` } : {}),
    pr: id,
    revision: 1,
    headSha: id.padEnd(40, "0"),
    branch: id,
    subject: id,
    detail: id,
    revisionLineage: [],
    ageMs: null,
    totalMs: null,
    activeMs: null,
    waitMs: null,
    queueWaitMs: null,
  }
}

describe("queue timeline visible-row selection", () => {
  test("does not default to a running row hidden beyond the row limit", () => {
    const pendingOne = projectedRow("pending-1", "pending", "pending")
    const pendingTwo = projectedRow("pending-2", "pending", "pending")
    const hiddenRunning = projectedRow("running-3", "running", "running")
    const projection = {
      rows: [pendingOne, pendingTwo, hiddenRunning],
      display: { limit: 2, shown: 2, hidden: 1 },
    }

    const visibleRows = queueTimelineVisibleRows(projection)

    expect(visibleRows.map((row) => row.id)).toEqual(["pending-1", "pending-2"])
    expect(queueTimelineVisibleDefaultCursorId(projection)).toBe("pending-1")
  })
})
