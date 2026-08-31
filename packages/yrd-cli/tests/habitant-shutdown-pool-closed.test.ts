/**
 * @failure SIGINT teardown races the habitant watch loop: the shared process
 * pool closes (yrd-process's typed process-closed) while a cycle already
 * mid-drain still has git work queued through it, and the raw refusal used to
 * propagate uncaught out of the habitant instead of ending the drain cleanly
 * — the operator's terminal showed a bare, non-loggily `error: git … could
 * not be started in … Process is closed` line with no owning recovery path.
 * @level l2
 * @consumer @yrd/cli habitant runner
 */
import { describe, expect, it } from "vitest"
import { createFailure } from "@yrd/core"
import { followQueueRuns } from "../src/run.ts"
import { createResponseHabitantHarness as harness } from "./support/habitant-harness.ts"

const processClosed = () =>
  createFailure({ kind: "infrastructure", code: "process-closed", message: "yrd: Process is closed" })

describe("habitant runner — a closed process pool during an active drain stops cleanly (2026-08-31 SIGINT teardown race)", () => {
  it("returns the interrupted exit instead of propagating, with one loud loggily warn", async () => {
    const h = harness([
      // The drain was already requested (SIGINT landed, the graceful message
      // already printed) when app.queue.run's own git usage hit the now-closed
      // shared pool — exactly the ordering from the operator's incident.
      () => {
        h.drain()
        return Promise.reject(processClosed())
      },
    ])

    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(3)

    // One cycle only: retrying would just re-hit a pool that never reopens,
    // spinning the interval sleep forever instead of exiting.
    expect(h.runCalls()).toBe(1)
    expect(h.warnings).toContainEqual(
      expect.objectContaining({
        message: "habitant runner stopped after its own shared process pool closed mid-drain",
        props: expect.objectContaining({ action: "resident-drain-pool-closed" }),
      }),
    )
    // Loud via the structured log stream, never duplicated as a bare
    // human-readable stderr echo (the shape of the operator's actual defect).
    expect(h.stderr.join("")).toBe("")
  })

  it("still fails a targeted one-shot run — no next cycle to stop instead of retry", async () => {
    const h = harness([
      () => {
        h.drain()
        return Promise.reject(processClosed())
      },
    ])
    await expect(followQueueRuns(h.app, ["PR1"], { interval: 1 }, h.io, h.gate)).rejects.toThrow(
      "yrd: Process is closed",
    )
  })

  it("propagates (fail-loud) when the pool closes with NO drain requested — an unexplained closure is a real bug, not a graceful stop", async () => {
    // Negative control: this fix recognizes process-closed only as evidence
    // of THIS runner's own requested drain. A pool that closes on its own,
    // outside any drain, must still crash loud rather than being silently
    // absorbed as if it were expected.
    const h = harness([() => Promise.reject(processClosed())])
    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).rejects.toThrow("yrd: Process is closed")
    expect(h.warnings).toEqual([])
  })
})
