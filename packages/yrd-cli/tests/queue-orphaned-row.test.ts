/**
 * @failure R3742 printed `checking` in `queue list` and `watch` for two hours
 *          after its runner process died, and counted as active: every reader
 *          mapped the stored `in_progress` straight to the working word
 *          (@i/10-yrd/24030). A running row's state is now DERIVED at read —
 *          lease and holder through the one liveness function — and an
 *          orphaned row prints `orphaned: …`, never `checking`, on the
 *          timeline, the watch queue rows, and the run detail.
 * @level l1
 * @consumer @yrd/cli queue list / watch / pr runs (queue-status-view)
 */
import { describe, expect, it } from "vitest"
import { emptyBaysState } from "@yrd/bay"
import { queueTimelineAdmissionTimes } from "@yrd/queue"
import { fixtureJob, fixturePr, fixtureResult, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"
import {
  humanQueueProjection,
  queueShowData,
  queueTimelineProjection,
  timelineStatusCell,
  watchQueueRows,
} from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
const LAPSED = "2026-07-13T11:50:00.000Z"
const HELD = "2026-07-13T12:05:00.000Z"
const HOLDER = "yrd-cli:4242"

function runningResult(leaseExpiresAt: string) {
  const pr = fixturePr("PR42", "submitted", "2026-07-13T11:20:00.000Z")
  const job = fixtureJob("J42-check", "running", {
    runner: HOLDER,
    leaseExpiresAt,
    startedAt: "2026-07-13T11:31:00.000Z",
  })
  const run = fixtureRun("R42", [pr], "running", "2026-07-13T11:30:00.000Z", {
    steps: [fixtureStep("check", job)],
    cursor: 0,
  })
  return { result: fixtureResult([pr], [run]), run }
}

function timeline(result: ReturnType<typeof runningResult>["result"], runnerAlive?: () => boolean | undefined) {
  return queueTimelineProjection([result], {
    now: NOW,
    ...(runnerAlive === undefined ? {} : { runnerAlive }),
    windowMs: 6 * 60 * 60_000,
    statuses: [],
    terms: [],
    latest: false,
    rowLimit: 20,
    submissionTimes: queueTimelineAdmissionTimes([result]),
  })
}

describe("an orphaned run row prints orphaned, never checking (24030)", () => {
  it("timeline: an expired lease projects orphaned with the holder and lease in the detail", () => {
    const { result } = runningResult(LAPSED)
    const [row] = timeline(result).rows
    expect(row?.status).toBe("orphaned")
    expect(row?.detail).toContain(`orphaned: lease expired ${LAPSED}, holder ${HOLDER} (pid 4242)`)
    expect(row === undefined ? undefined : timelineStatusCell(row).word).toBe("orphaned")
    expect(JSON.stringify(row)).not.toContain("checking")
  })

  it("timeline: a held lease with a dead holder projects orphaned; a live holder projects running", () => {
    const { result } = runningResult(HELD)
    const [dead] = timeline(result, () => false).rows
    expect(dead?.status).toBe("orphaned")
    expect(dead?.detail).toContain(`orphaned: holder ${HOLDER} (pid 4242) is dead, lease until ${HELD}`)
    const [alive] = timeline(result, () => true).rows
    expect(alive?.status).toBe("running")
    expect(alive === undefined ? undefined : timelineStatusCell(alive).word).toBe("checking")
  })

  it("watch queue rows: the row's STATE is orphaned and it is not counted active", () => {
    const { result } = runningResult(LAPSED)
    const state = emptyBaysState()
    const projection = humanQueueProjection(result, NOW, { state })
    expect(projection.queue.map((row) => [row.pr, row.state])).toEqual([["PR42", "orphaned"]])
    expect(projection.queue[0]?.result).toContain("orphaned: lease expired")
    expect(projection.activeCount).toBe(0)
    expect(projection.active).toBeUndefined()
    expect(watchQueueRows(state, result, NOW).map((row) => row.state)).toEqual(["orphaned"])

    const held = runningResult(HELD)
    expect(humanQueueProjection(held.result, NOW, { state, runnerAlive: () => false }).queue[0]?.state).toBe("orphaned")
    const live = humanQueueProjection(held.result, NOW, { state, runnerAlive: () => true })
    expect(live.queue[0]?.state).toBe("checking")
    expect(live.activeCount).toBe(1)
  })

  it("run detail (pr runs): the run carries the orphaned line and its step reads orphaned", () => {
    const { run } = runningResult(LAPSED)
    const data = queueShowData(run, [run], [], undefined, { now: NOW, runnerAlive: () => undefined })
    expect(data.orphaned).toBe(`orphaned: lease expired ${LAPSED}, holder ${HOLDER} (pid 4242)`)
    expect(data.steps.map((step) => step.status)).toEqual(["orphaned"])
    const stored = queueShowData(run, [run], [])
    expect(stored.orphaned).toBeUndefined()
  })
})
