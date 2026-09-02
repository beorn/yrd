/**
 * @failure R3742 read `checking` for two hours after its runner process died:
 *          the projection's `jobStatus` mapped a stored `in_progress` straight
 *          to `running`, consulting neither the lease nor the holder
 *          (@i/10-yrd/24030). The row's state is now DERIVED at read through
 *          the one liveness function, against the reader's clock and probe.
 * @level l1
 * @consumer @yrd/queue queue-status-projection (jobStatus, runLiveness)
 */
import { describe, expect, it } from "vitest"
import type { Job } from "@yrd/job"
import { jobStatus, orphanedRunLiveness, runLiveness } from "../src/queue-status-projection.ts"
import type { QueueStep } from "../src/model.ts"

const NOW = Date.parse("2026-09-02T05:13:00.000Z")
const HELD = "2026-09-02T05:20:00.000Z"
const LAPSED = "2026-09-02T05:08:00.000Z"

function inProgress(runner: string, leaseExpiresAt: string): Job {
  return {
    id: "019f0000-0000-7000-8000-000000000001",
    key: "queue:R7:0",
    definition: "queue.step.check",
    revision: "rev",
    input: { run: "R7", step: "check", index: 0 },
    status: "in_progress",
    attempt: 1,
    runner,
    leaseExpiresAt,
    requestedAt: "2026-09-02T05:00:00.000Z",
    startedAt: "2026-09-02T05:00:01.000Z",
    changedAt: "2026-09-02T05:00:01.000Z",
  } as unknown as Job
}

function step(job: Job | undefined): QueueStep {
  return { name: "check", index: 0, revision: "rev", ...(job === undefined ? {} : { job }) } as unknown as QueueStep
}

describe("a running row's state is derived at read from its lease holder (24030)", () => {
  it("in_progress with an expired lease projects orphaned, whoever the holder is", () => {
    const status = jobStatus(step(inProgress("yrd-cli:3411471", LAPSED)), { now: NOW, runnerAlive: () => undefined })
    expect(status).toBe("orphaned")
  })

  it("in_progress with a held lease and a dead holder projects orphaned", () => {
    const status = jobStatus(step(inProgress("yrd-cli:3411471", HELD)), { now: NOW, runnerAlive: () => false })
    expect(status).toBe("orphaned")
  })

  it("in_progress with a held lease and a live holder projects running", () => {
    const status = jobStatus(step(inProgress("yrd-cli:3411471", HELD)), { now: NOW, runnerAlive: () => true })
    expect(status).toBe("running")
  })

  it("a pid-less holder with a held lease is judged by its lease alone", () => {
    expect(jobStatus(step(inProgress("yrd-cli", HELD)), { now: NOW, runnerAlive: () => undefined })).toBe("running")
    expect(jobStatus(step(inProgress("yrd-cli", LAPSED)), { now: NOW, runnerAlive: () => undefined })).toBe("orphaned")
  })

  it("without a probe the stored belief is returned — only step SELECTION may read it that way", () => {
    expect(jobStatus(step(inProgress("yrd-cli:3411471", LAPSED)))).toBe("running")
  })

  it("runLiveness judges the cursor step's in_progress job and nothing else", () => {
    const run = { cursor: 1, steps: [step(undefined), step(inProgress("yrd-cli:4242", LAPSED))] }
    expect(runLiveness(run, { now: NOW, runnerAlive: () => undefined })).toEqual({
      state: "orphaned",
      runner: "yrd-cli:4242",
      leaseExpiresAt: LAPSED,
      cause: "lease-expired",
      pid: 4242,
    })
    expect(orphanedRunLiveness(run, { now: NOW, runnerAlive: () => undefined })?.cause).toBe("lease-expired")
    expect(runLiveness({ cursor: 0, steps: [step(undefined)] }, { now: NOW, runnerAlive: () => false })).toBeUndefined()
    expect(
      orphanedRunLiveness(
        { cursor: 0, steps: [step(inProgress("yrd-cli:4242", HELD))] },
        { now: NOW, runnerAlive: () => true },
      ),
    ).toBeUndefined()
  })
})
