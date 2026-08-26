/**
 * @failure The per-step check ladder and the run-level check ladder were two
 * separate derivations with opposite tie-breaking — the per-step one consulted
 * `Queues.failed` FIRST, the run-level one consulted it LAST — and only agreed
 * because a completed job happens to be exactly a succeeded-or-failed one. One
 * inattentive edit to either ladder (a new job conclusion, a reordered guard)
 * would have made the checks column and the eligibility verdict disagree about
 * the same run. The ladder now lives once in `checkStatus`; `checkRunStatus`
 * is a pure fold of it. This file pins the tie-break rule and the fold.
 * @level l1
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import type { Job } from "@yrd/job"
import type { QueueStep, Run } from "@yrd/queue"
import { checkRunStatus, checkStatus } from "../src/queue.ts"

function job(status: Job["status"], conclusion?: string): Job {
  return { status, ...(conclusion === undefined ? {} : { conclusion }) } as unknown as Job
}

function run(input: { failed?: boolean; jobs?: readonly (Job | undefined)[] }): Run {
  const steps: QueueStep[] = (input.jobs ?? []).map(
    (candidate, index) =>
      ({ name: `step-${String(index)}`, ...(candidate === undefined ? {} : { job: candidate }) }) as QueueStep,
  )
  return {
    status: input.failed === true ? "completed" : "in_progress",
    ...(input.failed === true ? { conclusion: "failure" } : {}),
    steps,
  } as unknown as Run
}

const healthy = run({})
const failedRun = run({ failed: true })

describe("checkStatus — the one tie-break ladder", () => {
  it("a terminal job outcome beats the run's failure: completed-success stays passed", () => {
    expect(checkStatus(job("completed", "success"), failedRun)).toBe("passed")
  })

  it("any non-success completion reads failed, in a healthy run as much as a failed one", () => {
    for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"]) {
      expect(checkStatus(job("completed", conclusion), healthy)).toBe("failed")
      expect(checkStatus(job("completed", conclusion), failedRun)).toBe("failed")
    }
  })

  it("a failed run settles every step without a terminal outcome as failed, never checking", () => {
    expect(checkStatus(undefined, failedRun)).toBe("failed")
    for (const status of ["queued", "in_progress", "waiting"] as const) {
      expect(checkStatus(job(status), failedRun)).toBe("failed")
    }
  })

  it("a healthy run leaves non-terminal steps checking", () => {
    expect(checkStatus(undefined, healthy)).toBe("checking")
    for (const status of ["queued", "in_progress", "waiting"] as const) {
      expect(checkStatus(job(status), healthy)).toBe("checking")
    }
  })
})

describe("checkRunStatus — a pure fold of checkStatus, no second ladder", () => {
  it("passed only when every selected step passed — even when the run itself failed later", () => {
    const settled = run({ failed: true, jobs: [job("completed", "success"), job("completed", "success")] })
    expect(checkRunStatus(settled, 2)).toBe("passed")
  })

  it("failed as soon as any selected step failed", () => {
    const mixed = run({ jobs: [job("completed", "success"), job("completed", "failure"), job("in_progress")] })
    expect(checkRunStatus(mixed, 3)).toBe("failed")
  })

  it("a failed run folds its unfinished steps to failed, so the run never reads checking", () => {
    const stalled = run({ failed: true, jobs: [job("completed", "success"), job("in_progress"), undefined] })
    expect(checkRunStatus(stalled, 3)).toBe("failed")
  })

  it("a healthy run with unfinished steps is checking", () => {
    const working = run({ jobs: [job("completed", "success"), job("in_progress")] })
    expect(checkRunStatus(working, 2)).toBe("checking")
  })

  it("selection is a prefix: steps beyond selectedCount do not vote", () => {
    const trailingFailure = run({ jobs: [job("completed", "success"), job("completed", "failure")] })
    expect(checkRunStatus(trailingFailure, 1)).toBe("passed")
  })

  it("an empty selection folds to passed (vacuous truth), exactly as the replaced ladder did", () => {
    expect(checkRunStatus(healthy, 0)).toBe("passed")
    expect(checkRunStatus(failedRun, 0)).toBe("passed")
  })

  it("agrees with the explicit fold of checkStatus on every selected prefix", () => {
    const jobs: readonly (Job | undefined)[] = [
      job("completed", "success"),
      job("in_progress"),
      job("completed", "failure"),
      undefined,
      job("waiting"),
    ]
    for (const failed of [false, true]) {
      const candidate = run({ failed, jobs })
      for (let count = 0; count <= jobs.length; count += 1) {
        const statuses = candidate.steps.slice(0, count).map((step) => checkStatus(step.job, candidate))
        const expected = statuses.every((status) => status === "passed")
          ? "passed"
          : statuses.includes("failed")
            ? "failed"
            : "checking"
        expect(checkRunStatus(candidate, count)).toBe(expected)
      }
    }
  })
})
