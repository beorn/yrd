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
import { followQueueRuns } from "../src/run.ts"
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

type RecoverCall = Readonly<{ recoveryTime: string; reason?: string; runner?: string }>

function residentHarness(
  runResponses: readonly (() => Promise<readonly unknown[]>)[],
  options: Readonly<{ recover?: (call: RecoverCall) => readonly unknown[]; now?: () => number }> = {},
) {
  const signal = { aborted: false }
  const warnings: WarnCall[] = []
  const stderr: string[] = []
  const recoverCalls: RecoverCall[] = []
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
      recover: async (call: RecoverCall) => {
        recoverCalls.push(call)
        return options.recover?.(call) ?? []
      },
    },
  } as unknown as YrdCliApp
  const io = {
    stdout: () => undefined,
    stderr: (text: string) => stderr.push(text),
    ...(options.now === undefined ? {} : { now: options.now }),
  } as unknown as YrdCliIO
  const gate = async (): Promise<void> => undefined
  return { app, io, gate, signal, warnings, stderr, recoverCalls, runCalls: () => runCalls }
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
      () => Promise.reject(new JobStateConflict(MERGE_JOB_ID, "canceled", "running or waiting")),
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
        props: expect.objectContaining({ action: "resident-cancel-skip", job: MERGE_JOB_ID, status: "canceled" }),
      }),
    )
    // Resident output stays loggily-only — no bare 'yrd:' stderr duplicate.
    expect(h.stderr.join("")).toBe("")
  })
})

describe("resident follow loop sweeps lapsed leases per tick (D1b)", () => {
  it("recovers expired leases unscoped each tick, throttled ~60s, logging loudly only when it settles", async () => {
    // The startup reclaim was the ONLY automatic settle; a runner that dies AFTER
    // it left ghosts stuck "running" forever. The follow loop now runs an unscoped
    // (no runner) lease-expiry recovery sweep every ~60s of ticks, so any orphaned
    // running Job whose lease lapsed is settled regardless of who left it.
    let clock = Date.parse("2026-06-01T00:00:00.000Z")
    // Tick 1: sweep settles a lapsed run. Tick 2: throttled out (only 15s later).
    // Tick 3: >60s later, sweep runs again but nothing lapsed → no warn. Then abort.
    const settleOnce = [{ id: "R9" }]
    let sweepReturns = 0
    const h = residentHarness(
      [
        () => Promise.resolve([]),
        () => Promise.resolve([]),
        () => {
          h.signal.aborted = true
          return Promise.resolve([])
        },
      ],
      {
        now: () => clock,
        recover: () => (sweepReturns++ === 0 ? settleOnce : []),
      },
    )

    // Advance the clock between cycles via the sleep hook the loop awaits each tick.
    let tick = 0
    ;(h.app.scope as unknown as { sleep: () => Promise<void> }).sleep = async () => {
      tick += 1
      clock += tick === 1 ? 15_000 : 60_001
    }

    await followQueueRuns(h.app, [], { interval: 15 }, h.io, h.gate)

    // The sweep is unscoped (no runner arg) and time-based, not once-at-startup.
    expect(h.recoverCalls.length).toBe(2)
    expect(h.recoverCalls[0]).toMatchObject({ reason: expect.stringContaining("sweep") })
    expect(h.recoverCalls.every((call) => call.runner === undefined)).toBe(true)
    // Tick 1 (t0) and tick 3 (t≈75s) swept; tick 2 (t15s) was throttled out.
    expect(h.recoverCalls.map((call) => call.recoveryTime)).toEqual([
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:01:15.001Z",
    ])
    // Loud structured warn ONLY when it actually settled something (tick 1), naming ids.
    const sweepWarnings = h.warnings.filter((warning) => warning.props.action === "resident-recovery-sweep")
    expect(sweepWarnings).toHaveLength(1)
    expect(sweepWarnings[0]?.props).toMatchObject({ runs: ["R9"], reason: expect.any(String) })
    // Cheap no-op when nothing lapsed: no stderr, loggily-only.
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
