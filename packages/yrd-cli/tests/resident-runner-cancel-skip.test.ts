/**
 * @failure A resident queue runner dies when a peer cancels or settles a Job between its snapshot and its action, idling the whole merge queue.
 * @level l2
 * @consumer @yrd/cli resident runner
 */
import { describe, expect, it } from "vitest"
import { JobStateConflict } from "@yrd/job"
import { watchQueueRuns } from "../src/run.ts"
import type { YrdCliApp, YrdCliIO } from "../src/types.ts"

const JOB_ID = "00000000-0000-7000-8000-00000000abcd"

type WarnCall = Readonly<{ message: string; props: Record<string, unknown> }>

function harness(runResponses: readonly (() => Promise<readonly unknown[]>)[]) {
  const signal = { aborted: false }
  const warnings: WarnCall[] = []
  const stderr: string[] = []
  const stdout: string[] = []
  let runCalls = 0
  const app = {
    scope: { signal, sleep: async () => undefined },
    log: {
      warn: (message: string, props: Record<string, unknown>) => warnings.push({ message, props }),
    },
    queue: {
      run: async () => {
        const responder = runResponses[runCalls] ?? runResponses.at(-1)
        runCalls += 1
        if (responder === undefined) throw new Error("no run responder configured")
        return responder()
      },
    },
  } as unknown as YrdCliApp
  const io = {
    stdout: (row: string) => stdout.push(row),
    stderr: (row: string) => stderr.push(row),
  } as unknown as YrdCliIO
  const gate = async (): Promise<void> => undefined
  return {
    app,
    io,
    gate,
    signal,
    warnings,
    stderr,
    stdout,
    runCalls: () => runCalls,
  }
}

describe("resident runner — a concurrently-canceled Job never kills the watch loop", () => {
  it("logs a loud skip and processes the NEXT cycle after a peer settles a Job mid-pickup", async () => {
    const h = harness([
      // Cycle 1: a peer canceled the Job between this runner's snapshot and its
      // settlement commit — the throw that used to escape the loop.
      () => Promise.reject(new JobStateConflict(JOB_ID, "canceled", "running or waiting")),
      // Cycle 2: the runner keeps going and drains normally, then the watch stops.
      () => {
        h.signal.aborted = true
        return Promise.resolve([])
      },
    ])

    await expect(watchQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(0)

    // Survived the race AND reached the next interval's work.
    expect(h.runCalls()).toBe(2)
    // The skip is LOUD and typed — structured log + operator-visible stderr.
    expect(h.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({ action: "resident-cancel-skip", job: JOB_ID, status: "canceled" }),
      }),
    )
    expect(h.stderr.join("")).toContain(`peer settled job '${JOB_ID}' (canceled) mid-pickup`)
  })

  it("still dies on a conflict against a still-LIVE Job — narrow catch, no blanket swallow", async () => {
    // A conflict whose Job is NOT terminal signals a real invalid transition
    // (single-writer bug), not a losable race. It must propagate (fail-loud).
    const h = harness([() => Promise.reject(new JobStateConflict(JOB_ID, "running", "requested"))])
    await expect(watchQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).rejects.toThrow(
      `yrd: job '${JOB_ID}' is running, not requested`,
    )
    expect(h.runCalls()).toBe(1)
    expect(h.warnings).toEqual([])
  })

  it("propagates any non-settlement error unchanged", async () => {
    const h = harness([() => Promise.reject(new Error("boom: unexpected"))])
    await expect(watchQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).rejects.toThrow("boom: unexpected")
    expect(h.warnings).toEqual([])
  })

  it("does NOT swallow a settlement race for a one-shot targeted run — it has no next interval", async () => {
    // Recovery-by-skip is only for the looping resident watch. A targeted
    // `queue run PR1` propagates the race so the caller sees the outcome.
    const h = harness([() => Promise.reject(new JobStateConflict(JOB_ID, "canceled", "running or waiting"))])
    await expect(watchQueueRuns(h.app, ["PR1"], { interval: 1 }, h.io, h.gate)).rejects.toThrow(
      `yrd: job '${JOB_ID}' is canceled, not running or waiting`,
    )
    expect(h.warnings).toEqual([])
  })
})
