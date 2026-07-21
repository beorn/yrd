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
