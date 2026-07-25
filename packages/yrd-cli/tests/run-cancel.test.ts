/**
 * @failure `run cancel` / watch x-to-cancel either deadlocks the resident when its active merge is canceled, or the watch affordance fires on an ambiguous key, diverging from the shared cancel path.
 * @level l2
 * @consumer @yrd/cli run cancel + watch x-to-cancel
 */
import { createElement } from "react"
import { createRenderer, waitFor } from "silvery/test"
import { describe, expect, it } from "vitest"
import { JobStateConflict } from "@yrd/job"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import { followQueueRuns, residentRecoverySweep } from "../src/run.ts"
import { reduceRunCancelKey } from "../src/watch-cancel.ts"
import type { YrdCliApp, YrdCliIO } from "../src/types.ts"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const idle = { char: "", escape: false, return: false }

describe("reduceRunCancelKey — watch x-to-cancel affordance", () => {
  it("arms the confirmation on x for the selected run, without canceling yet", () => {
    expect(reduceRunCancelKey({ ...idle, char: "x" }, false, "R7")).toEqual({ armed: true })
  })

  it("fires the cancel for the selected run on y once armed", () => {
    expect(reduceRunCancelKey({ ...idle, char: "y" }, true, "R7")).toEqual({ armed: false, cancel: "R7" })
  })

  it("fires the cancel for the selected run on Enter once armed", () => {
    expect(reduceRunCancelKey({ ...idle, return: true }, true, "R7")).toEqual({ armed: false, cancel: "R7" })
  })

  it("dismisses without canceling on any other key, a second x, or Escape once armed", () => {
    expect(reduceRunCancelKey({ ...idle, char: "p" }, true, "R7")).toEqual({ armed: false })
    expect(reduceRunCancelKey({ ...idle, char: "x" }, true, "R7")).toEqual({ armed: false })
    expect(reduceRunCancelKey({ ...idle, escape: true }, true, "R7")).toEqual({ armed: false })
    // Escape wins even if the terminal reports a stray return flag with it.
    expect(reduceRunCancelKey({ char: "", escape: true, return: true }, true, "R7")).toEqual({ armed: false })
  })

  it("can neither arm nor fire when no run is under the cursor", () => {
    expect(reduceRunCancelKey({ ...idle, char: "x" }, false, undefined)).toEqual({ armed: false })
    expect(reduceRunCancelKey({ ...idle, char: "y" }, true, undefined)).toEqual({ armed: false })
  })
})

const MERGE_JOB_ID = "00000000-0000-7000-8000-00000000cace"

type WarnCall = Readonly<{ message: string; props: Record<string, unknown> }>

function residentHarness(runResponses: readonly (() => Promise<readonly unknown[]>)[]) {
  const signal = { aborted: false }
  const warnings: WarnCall[] = []
  const stderr: string[] = []
  let runCalls = 0
  const app = {
    scope: { signal, sleep: async () => undefined },
    log: { warn: (message: string, props: Record<string, unknown>) => warnings.push({ message, props }) },
    queue: {
      run: async () => {
        const responder = runResponses[runCalls] ?? runResponses.at(-1)
        runCalls += 1
        if (responder === undefined) throw new Error("no run responder configured")
        return responder()
      },
    },
  } as unknown as YrdCliApp
  const io = { stdout: () => undefined, stderr: (text: string) => stderr.push(text) } as unknown as YrdCliIO
  const gate = async (): Promise<void> => undefined
  return { app, io, gate, signal, warnings, stderr, runCalls: () => runCalls }
}

describe("run cancel of an ACTIVE (merging) run never deadlocks the resident", () => {
  it("observes a peer's cancel of its in-flight merge as a settlement conflict and recovers", async () => {
    // The `run cancel <R>` surface is a SEPARATE process: it journals the cancel
    // and aborts the run's active merge JOB. The resident is NOT the canceler, so
    // it never does an in-writer synchronous cancel of its own active merge (which
    // deadlocks — the drive loop holds the writer while blocked mid-merge).
    // Instead it observes the canceled merge job as a typed settlement conflict
    // and recovers at the next cycle boundary, staying alive.
    const h = residentHarness([
      // Cycle 1: the peer canceled this run's active merge between the resident's
      // snapshot and its settlement — the conflict that must NOT kill the loop.
      () => Promise.reject(new JobStateConflict(MERGE_JOB_ID, "completed", "in_progress or waiting")),
      // Cycle 2: the resident keeps draining what remains, then the watch stops.
      () => {
        h.signal.aborted = true
        return Promise.resolve([])
      },
    ])

    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(0)

    // Survived the cancel AND reached the next cycle's work — no deadlock, no death.
    expect(h.runCalls()).toBe(2)
    expect(h.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({ action: "resident-cancel-skip", job: MERGE_JOB_ID, status: "completed" }),
      }),
    )
    // Resident output stays loggily-only — no bare 'yrd:' stderr duplicate.
    expect(h.stderr.join("")).toBe("")
  })
})

describe("residentRecoverySweep — the resident's per-tick lease-expiry sweep (D1b)", () => {
  type RecoverCall = Readonly<{ recoveryTime: string; reason?: string; runner?: string }>

  function sweepHarness(settle: (call: RecoverCall) => readonly { id: string }[]) {
    const recoverCalls: RecoverCall[] = []
    const warnings: WarnCall[] = []
    const app = {
      queue: {
        recover: async (call: RecoverCall) => {
          recoverCalls.push(call)
          return settle(call)
        },
      },
      log: { warn: (message: string, props: Record<string, unknown>) => warnings.push({ message, props }) },
    } as unknown as Parameters<typeof residentRecoverySweep>[0]
    return { app, recoverCalls, warnings }
  }

  it("recovers expired leases unscoped, throttled ~60s, logging loudly only when it settles", async () => {
    // Startup reclaim was the ONLY automatic settle; a runner that died AFTER it left
    // ghosts stuck "running" forever. This sweep runs each tick but throttles to ~60s
    // of wall time, settles by lease expiry with NO runner arg, and stays cheap+quiet
    // when nothing lapsed.
    const h = sweepHarness((call) => (call.recoveryTime === "2026-06-01T00:00:00.000Z" ? [{ id: "R9" }] : []))
    const io = (now: number) => ({ now: () => now }) as Parameters<typeof residentRecoverySweep>[1]

    // Tick 1 at t0 (lastSweepAt 0): sweeps, settles R9.
    const afterFirst = await residentRecoverySweep(h.app, io(Date.parse("2026-06-01T00:00:00.000Z")), 0)
    expect(afterFirst).toBe(Date.parse("2026-06-01T00:00:00.000Z"))
    // Tick 2 at t0+15s: throttled out — lastSweepAt unchanged, no new recover call.
    const afterThrottled = await residentRecoverySweep(h.app, io(afterFirst + 15_000), afterFirst)
    expect(afterThrottled).toBe(afterFirst)
    // Tick 3 at t0+75s: >60s elapsed, sweeps again but nothing lapsed → no warn.
    const afterThird = await residentRecoverySweep(h.app, io(afterFirst + 75_000), afterFirst)
    expect(afterThird).toBe(afterFirst + 75_000)

    // Two actual sweeps (tick 1 + tick 3); the throttled tick made no call.
    expect(h.recoverCalls.map((call) => call.recoveryTime)).toEqual([
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:01:15.000Z",
    ])
    // Unscoped: never a runner arg; reason names the sweep.
    expect(h.recoverCalls.every((call) => call.runner === undefined)).toBe(true)
    expect(h.recoverCalls[0]).toMatchObject({ reason: expect.stringContaining("sweep") })
    // Loud structured warn ONLY on the tick that settled something, naming the ids.
    const sweepWarnings = h.warnings.filter((warning) => warning.props.action === "resident-recovery-sweep")
    expect(sweepWarnings).toHaveLength(1)
    expect(sweepWarnings[0]?.props).toMatchObject({ runs: ["R9"], reason: expect.any(String) })
  })

  it("defaults to the wall clock and does not sweep again within the throttle window", async () => {
    const h = sweepHarness(() => [])
    const io = {} as Parameters<typeof residentRecoverySweep>[1]
    // lastSweepAt = now-ish → within the window → no sweep, timestamp unchanged.
    const justSwept = Date.now()
    expect(await residentRecoverySweep(h.app, io, justSwept)).toBe(justSwept)
    expect(h.recoverCalls).toHaveLength(0)
  })
})

describe("resident runner exit-code contract (D3)", () => {
  const drainSignalOn = (io: unknown) => {
    ;(io as { drainSignal: { aborted: boolean } }).drainSignal = { aborted: true }
  }

  it("exits 0 when an operator drain finishes with the queue drained", async () => {
    // The clean operator stop: Ctrl-C #1 requested a drain, the last in-flight run
    // reached a terminal state, no hard abort. hab restart=on-failure must NOT
    // restart it — the stop was intentional.
    const h = residentHarness([() => Promise.resolve([{ id: "R1", status: "completed", conclusion: "success" }])])
    drainSignalOn(h.io)
    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(0)
  })

  it("exits non-zero when a hard signal cuts an unfinished drain short with work in flight", async () => {
    // Ctrl-C #1 requested a drain; Ctrl-C #2 (hard scope abort) forces the stop while
    // a run is still in flight (non-terminal). That is "exiting with in-flight work
    // due to a signal" — hab restart=on-failure must see non-zero so it resumes
    // draining, unlike the drain-finished case above. A killed runner exiting 0 with
    // work left was the whole reason ghosts stayed stuck.
    const h = residentHarness([
      () => Promise.resolve([{ id: "R1", status: "waiting" }]),
      // Would complete the drain (exit 0) if the loop ever reached a second cycle —
      // it must not, because the hard abort returns first.
      () => Promise.resolve([{ id: "R1", status: "completed", conclusion: "success" }]),
    ])
    drainSignalOn(h.io)
    h.signal.aborted = true
    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(3)
    expect(h.runCalls()).toBe(1)
    // Loggily-only; the interrupt is not echoed to stderr.
    expect(h.stderr.join("")).toBe("")
  })
})

describe("watch x-to-cancel confirmation banner (render)", () => {
  it("renders a VISIBLE standalone confirm when armed and dismisses it on another key", async () => {
    // The keybindings footer was removed (W3 detail rework), so the cancel
    // affordance can no longer render its confirm via the footer path. Arming
    // must still surface a visible confirmation as a STANDALONE banner row — a
    // silent armed state (confirm rendered nowhere) would be a regression. This
    // asserts the banner itself, not any footer text.
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot, onCancelRun: () => undefined }))
    try {
      await app.waitForLayoutStable()
      expect(app.text, "no confirm renders before arming").not.toContain("Cancel run")

      // `x` arms the confirmation for the default-selected (running) run.
      await app.press("x")
      await waitFor(() => app.text.includes("Cancel run"))
      expect(app.text, "the armed confirm names the fire/abort keys").toContain(
        "y/Enter to confirm, any other key to abort",
      )

      // Any other key dismisses without firing; the standalone banner disappears.
      await app.press("z")
      await waitFor(() => !app.text.includes("Cancel run"))
    } finally {
      app.unmount()
    }
  })
})
