/**
 * @failure An unchanged `yrd watch` snapshot schedules the full React/Silvery
 *          render pipeline on every tick and burns a core while nobody is
 *          interacting.
 * @why    Correctness assertions cannot see a render spin: the screen is
 *         identical either way. Only elapsed CPU over a real idle window can
 *         tell a pane that ticks once a second from one that never stops.
 * @level  l3 (real wall-clock time, real CPU accounting; `bun run test:slow`)
 * @consumer @yrd/cli queue watch
 *
 * Ported from `1f638504^:packages/yrd-cli/tests/watch-idle-cpu.slow.test.ts`,
 * with ONE deliberate change of method, stated here rather than buried: the
 * retired drill spawned an INSTALLED `yrd watch` in a PTY through
 * `@termless/test` and read the child's CPU time out of `ps`. That chain needs
 * a globally installed binary, a devDependency Yrd dropped at 916a4e20, and a
 * repository the watch will actually run in. This measures the same invariant
 * against the same loop, in this process: the pane is mounted live, left alone
 * for a real minute, and its own CPU time is read from
 * `process.cpuUsage()` — the accounting the kernel gives us for exactly the
 * work the retired test was reading out of `ps`.
 *
 * What it can no longer catch is a cost that lives OUTSIDE the render loop —
 * the process boundary, the terminal driver, the installed bundle's own
 * startup. That is a real reduction in coverage and it is named in the bead.
 */

import { act, createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import type { Row } from "@yrd/queue-core"
import { WatchPane, type WatchSnapshot } from "../src/watch-pane.tsx"

const SAMPLE_MS = 60_000
/** Five percent of one core across the window, the retired drill's own bound. */
const MAX_IDLE_CPU_SECONDS = 3

function snapshot(): WatchSnapshot {
  const at = new Date()
  const rows: readonly Row[] = ["task/one", "task/two", "task/three", "task/four"].map((branch, index) => ({
    branch,
    head: branch.padEnd(40, String(index)),
    since: new Date(at.getTime() - 3_600_000),
    state: index === 0 ? "queued" : index === 1 ? "checked" : index === 2 ? "merged" : "failed",
    subject: `${branch} does its work`,
  }))
  return { at, detail: new Map(), queue: "example.test/repo#main", rows: rows.map((row) => ({ row })) }
}

/** CPU seconds this process has burned, user and system together. */
function cpuSeconds(): number {
  const used = process.cpuUsage()
  return (used.user + used.system) / 1_000_000
}

describe("yrd watch idle CPU", () => {
  it(
    "uses at most 5% of one core across a 60-second idle window with the pane live",
    async () => {
      const render = createRenderer({ cols: 120, rows: 40 })
      const tree = () => createElement(WatchPane, { live: true, snapshot: snapshot() })
      const app = await act(async () => render(tree()))
      try {
        await act(async () => {
          await app.waitForLayoutStable()
        })
        // Warm-up is not the measurement: the first paint, the layout settle
        // and the module loads all land before the clock starts.
        await Bun.sleep(2_000)

        const startedAt = Date.now()
        const startedCpu = cpuSeconds()
        // Nobody touches it. The only thing that should run is the one tick.
        await Bun.sleep(SAMPLE_MS)
        const usedCpuSeconds = cpuSeconds() - startedCpu
        const elapsedSeconds = (Date.now() - startedAt) / 1_000

        expect(
          usedCpuSeconds,
          `idle watch used ${usedCpuSeconds.toFixed(2)} CPU seconds across ${elapsedSeconds.toFixed(2)} wall seconds`,
        ).toBeLessThanOrEqual(MAX_IDLE_CPU_SECONDS)
      } finally {
        await act(async () => {
          app.unmount()
        })
      }
    },
    110_000,
  )
})
