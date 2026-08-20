/**
 * @failure The RUNNER box's relative ages ("progress measured X ago", the
 *          runner's own health detection) freeze between watch polls even
 *          though real time keeps passing, or the box's other text stays at
 *          full color while the queue is actively running and the activity
 *          line has nothing to stand out against.
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * Operator ruling 2026-08-18, items 14/16/17. Root cause of the reported
 * freeze: `projection.now` is the data snapshot's own clock — it only
 * advances once per watch poll (~15s) — so a `now` pinned to it stalls every
 * "X ago" reading on-screen for up to that long. The fix is ONE coarse
 * re-render tick shared by every age computation in the box, live only in
 * the interactive pane.
 */
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it, vi } from "vitest"
import {
  fixtureJob,
  fixturePr,
  fixtureResult,
  fixtureRun,
  fixtureSnapshot,
  fixtureStep,
} from "../dev/queue-timeline-fixtures.ts"
import { uncarriedObservation, QueueTimelineView } from "../src/queue-status-view.tsx"

// Matches dev/queue-timeline-fixtures.ts's own NOW — fixtureSnapshot embeds
// it as `projection.now`, so the fake clock has to agree with it for the
// "X ago" math below to land on round, checkable numbers.
const NOW = Date.parse("2026-07-13T12:00:00.000Z")

// 2s old at mount: fresh (well under RUNNER_STALE_MS=15s) and stays fresh
// through this file's 5s time advances, so the marker never flips to
// stalled/down mid-test. Shared verbatim by the processing and idle
// fixtures below — only whether a row is RUNNING differs between them.
function runnerConfig() {
  const freshAgo = new Date(NOW - 2000).toISOString()
  return {
    pid: 84042,
    startedAt: "2026-07-13T11:00:00.000Z",
    lastTickAt: freshAgo,
    queueProgress: { state: "healthy" as const, observedAt: freshAgo },
    sourcePin: { state: "behind" as const, commits: 3 },
    implementationSource: "abc1234",
    uncarried: uncarriedObservation({ count: 5, scanned: 100, missingUpdateClocks: 0, observedAt: freshAgo }),
  }
}

function processingSnapshot() {
  const pr = fixturePr("PR19", "submitted", "2026-07-13T11:25:00.000Z", "Running")
  const run = fixtureRun("RR", [pr], "running", "2026-07-13T11:40:00.000Z", {
    steps: [fixtureStep("check", fixtureJob("JRR-check", "running"))],
  })
  return fixtureSnapshot(fixtureResult([pr], [run]), { runner: runnerConfig() })
}

function idleSnapshot() {
  const pr = fixturePr("PR11", "submitted", "2026-07-13T11:10:00.000Z", "Alpha")
  return fixtureSnapshot(fixtureResult([pr], []), { runner: runnerConfig() })
}

describe("RUNNER box live coarse tick (@yrd/cli/runner-box-live-tick, items 16/17)", () => {
  it("advances 'progress measured X ago' between events in the live pane, instead of freezing until the next poll", async () => {
    const projection = processingSnapshot().projection
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const render = createRenderer({ cols: 120, rows: 40 })
    const tree = () => createElement(QueueTimelineView, { projection, columns: 120, nav: true, paneChrome: true })
    const app = render(tree())
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("progress measured 0:02 ago")

      // No new snapshot/poll — the SAME projection object, only real
      // wall-clock time passing. A `now` pinned to `projection.now` would
      // show this exact same "0:02 ago" text forever.
      await vi.advanceTimersByTimeAsync(5000)
      app.rerender(tree())

      expect(app.text, "the reading must advance with real time, not stay pinned to the last poll").toContain(
        "progress measured 0:07 ago",
      )
    } finally {
      app.unmount()
      vi.useRealTimers()
    }
  })

  it("keeps the one-shot (non-live) render byte-static across the same time advance", async () => {
    const projection = processingSnapshot().projection
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const render = createRenderer({ cols: 120, rows: 40 })
    // nav:false — the one-shot print path has no app scope and cannot tick
    // (matches the file's existing live/static split for the activity pulse).
    const tree = () => createElement(QueueTimelineView, { projection, columns: 120, nav: false, paneChrome: true })
    const app = render(tree())
    try {
      await app.waitForLayoutStable()
      const before = app.text
      expect(before).toContain("progress measured 0:02 ago")

      await vi.advanceTimersByTimeAsync(5000)
      app.rerender(tree())

      expect(app.text, "a static print never ticks").toBe(before)
    } finally {
      app.unmount()
      vi.useRealTimers()
    }
  })

  it("ticks the runner's own health/staleness detection too, not only the progress text", async () => {
    // A second relative age sharing the same cause (item 17): the uptime
    // timer in the RUNNER border title also derives from the coarse clock.
    const projection = processingSnapshot().projection
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const render = createRenderer({ cols: 120, rows: 40 })
    const tree = () => createElement(QueueTimelineView, { projection, columns: 120, nav: true, paneChrome: true })
    const app = render(tree())
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("uptime 1:00:00")

      await vi.advanceTimersByTimeAsync(5000)
      app.rerender(tree())

      expect(app.text, "uptime must advance too — one shared clock, not a parallel derivation").toContain(
        "uptime 1:00:05",
      )
    } finally {
      app.unmount()
      vi.useRealTimers()
    }
  })
})

describe("RUNNER box state-conditional coloring (@yrd/cli/runner-box-severity-never-muted, item 27)", () => {
  function cellAt(app: ReturnType<ReturnType<typeof createRenderer>>, needle: string, anchor = needle) {
    const rows = app.text.split("\n")
    const y = rows.findIndex((row) => row.includes(anchor))
    if (y < 0) throw new Error(`no row containing '${anchor}':\n${app.text}`)
    const x = rows[y]!.indexOf(needle)
    return app.cell(x, y)
  }

  it("keeps the source rail's warning color while the queue is actively running — severity never mutes", async () => {
    // Operator ruling 2026-08-18, item 27, superseding item 14's blanket
    // muting: informational rails stay muted, but WARNING/ERROR text keeps
    // the severity color regardless of runner activity. The pre-27 build
    // muted a behind-pin warning while running — exactly the bug banned.
    const processing = processingSnapshot().projection
    const idle = idleSnapshot().projection
    const render = createRenderer({ cols: 120, rows: 40 })

    const idleApp = render(
      createElement(QueueTimelineView, { projection: idle, columns: 120, nav: true, paneChrome: true }),
    )
    const idleWarning = cellAt(idleApp, "source", "source abc1234").fg
    idleApp.unmount()

    const processingApp = render(
      createElement(QueueTimelineView, { projection: processing, columns: 120, nav: true, paneChrome: true }),
    )
    try {
      expect(
        cellAt(processingApp, "source", "source abc1234").fg,
        "the behind-pin warning keeps its severity color while processing",
      ).toEqual(idleWarning)
      // The command line takes the health-marker color: blue while
      // processing, muted when idle — the state-conditional half of item 27.
      const processingCommand = cellAt(processingApp, "resident runner", "resident runner").fg
      expect(processingCommand, "the running command line is not muted").not.toEqual(
        cellAt(processingApp, "progress measured", "progress measured").fg,
      )
    } finally {
      processingApp.unmount()
    }
  })
})
