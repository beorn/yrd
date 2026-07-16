// @failure Queue list reports a different or ever-growing terminal AGE across its human and JSON surfaces
// @level l2
// @consumer @yrd/cli

import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  QueueTimelineView,
  queueTimelineAdmissionTimes,
  queueTimelineProjection,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"

const minute = 60_000

function duration(ms: number): string {
  const seconds = Math.round(ms / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = String(seconds % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`
}

function projectionAt(now: number): QueueTimelineProjection {
  const results = queueTimelineStories["production-overview"].snapshot.results
  return queueTimelineProjection(results, {
    now,
    windowMs: 6 * 60 * minute,
    statuses: ["pending", "running", "rejected", "integrated", "other"],
    terms: [],
    latest: false,
    rowLimit: 20,
    submissionTimes: queueTimelineAdmissionTimes(results),
  })
}

function integratedRow(projection: QueueTimelineProjection) {
  const row = projection.rows.find(({ run }) => run === "R4")
  if (row === undefined || row.ageMs === null) throw new Error("production-overview is missing integrated PR4.1")
  return row
}

describe("queue list terminal AGE contract", () => {
  it("freezes terminal AGE and carries the same duration through human and lossless JSON output", async () => {
    const terminalAtNoon = integratedRow(projectionAt(Date.parse("2026-07-13T12:00:00.000Z")))
    const laterProjection = projectionAt(Date.parse("2026-07-13T12:05:00.000Z"))
    const terminalLater = integratedRow(laterProjection)

    expect(terminalLater.ageMs).toBe(terminalAtNoon.ageMs)

    const envelope = JSON.parse(JSON.stringify({ command: "queue.list", projection: laterProjection })) as {
      projection: QueueTimelineProjection
    }
    expect(integratedRow(envelope.projection).ageMs).toBe(terminalLater.ageMs)

    const frame = await renderString(createElement(QueueTimelineView, { projection: laterProjection, columns: 160 }), {
      width: 160,
      height: 45,
      plain: true,
    })
    const line = frame.split("\n").find((row) => row.includes("PR4.1"))
    expect(line).toContain(duration(terminalLater.ageMs))
  })
})
