/**
 * @failure queueTimelineProjection rescans every attempt in the journal once per Run, so a queue with many Runs pays O(runs x attempts) on every 1s watch tick and every cursor movement.
 * @level l2
 * @consumer @yrd/cli `queue list` / `queue list --watch` operators
 */
import { describe, expect, it } from "vitest"

import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  queueTimelineAdmissionTimes,
  queueTimelineProjection,
  type QueueAttempt,
  type QueueStatusResult,
} from "../src/queue-status-view.tsx"

function contractResults(): readonly QueueStatusResult[] {
  const results = queueTimelineStories["contract-overview"]?.snapshot.results
  if (results === undefined) throw new Error("contract-overview is missing its queue results")
  return results
}

function runIdsOf(results: readonly QueueStatusResult[]): readonly string[] {
  return results.flatMap((result) => [...result.running, ...result.waiting, ...result.finished]).map((run) => run.id)
}

/** An attempt that tallies every read of `.run`. A per-Run `attempts.filter(a =>
 * a.run === run.id)` reads it once per Run per attempt; grouping the attempts
 * once reads it once per attempt, whatever the Run count. */
function countingAttempt(run: string, index: number, tally: { reads: number }): QueueAttempt {
  const attempt: QueueAttempt = {
    job: `job-${String(index)}`,
    run,
    step: "check",
    index: 0,
    attempt: 1,
    runner: "runner-1",
    outcome: "passed",
    startedAt: "2026-07-13T10:00:00.000Z",
    finishedAt: "2026-07-13T10:01:00.000Z",
    durationMs: 60_000,
    requestedAt: "2026-07-13T09:59:00.000Z",
    revision: "1",
    result: { status: "passed", output: null },
  }
  return Object.defineProperty({ ...attempt }, "run", {
    get(): string {
      tally.reads += 1
      return run
    },
    enumerable: true,
    configurable: true,
  }) as QueueAttempt
}

describe("queue timeline attempt scanning", () => {
  it("groups attempts by Run once instead of rescanning them for every Run", () => {
    const results = contractResults()
    const runIds = runIdsOf(results)
    expect(runIds.length, "the fixture needs several Runs for the scan cost to be visible").toBeGreaterThan(1)

    const tally = { reads: 0 }
    const attempts = Array.from({ length: 300 }, (_, index) =>
      countingAttempt(runIds[index % runIds.length] ?? "R42", index, tally),
    )

    queueTimelineProjection(results, {
      now: Date.parse("2026-07-13T12:00:00.000Z"),
      windowMs: 6 * 60 * 60_000,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: queueTimelineAdmissionTimes(results),
      attempts,
    })

    // What matters is the SHAPE, not the constant: reads must stay linear in the
    // ATTEMPT count and independent of the RUN count.
    //
    // Grouped, this is a fixed number of linear passes — the grouping pass, the
    // narrowed re-filter inside `queueShowData`, and its attempt spread — plus a
    // couple of per-Run reads, so ~3x the attempt count however many Runs exist.
    // Rescanning per Run instead costs `attempts.length` for the row build and
    // again for the detail build FOR EVERY RUN, merge near
    // `attempts.length * runIds.length * 2` and growing as the queue accumulates
    // Runs. With this fixture that is 2100 reads against 903.
    expect(tally.reads).toBeLessThanOrEqual(attempts.length * 4)
    // The sharper statement of the same property: the total must stay under one
    // full rescan per Run, which is exactly what the quadratic shape costs.
    expect(tally.reads).toBeLessThan(attempts.length * runIds.length * 2)
  })
})
