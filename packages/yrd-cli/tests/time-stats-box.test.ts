// @failure The windowed TimeStatsBox surface stops rendering the four boxes, the coverage "-" gate, or the responsive 4-across / 2x2 / stacked arrangement.
// @level l1
// @consumer yrd queue watch statistics surface

import { createRenderer } from "@silvery/test"
import { createElement as h } from "react"
import { Box } from "silvery"
import { describe, expect, it } from "vitest"
import type { QueueTerminalFact } from "../src/queue-status-view.tsx"
import { TimeStatsBoxes } from "../src/time-stats-box.tsx"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const NOW = "2026-07-16T12:00:00.000Z"
const NOW_MS = Date.parse(NOW)

function fact(
  overrides: Partial<QueueTerminalFact> & Pick<QueueTerminalFact, "run" | "terminalAtMs" | "outcome">,
): QueueTerminalFact {
  return { activeMs: MINUTE, queueWaitMs: [], ...overrides }
}

// Three runs inside the last hour: two integrated (1m, 3m active), one decision
// rejection (10m active, 2m wait). Horizon is 10 days back, so HR/DAY/WK are
// covered and MON is not.
const FACTS: readonly QueueTerminalFact[] = [
  fact({ run: "i1", terminalAtMs: NOW_MS - 5 * MINUTE, outcome: "integrated", activeMs: 1 * MINUTE }),
  fact({ run: "i2", terminalAtMs: NOW_MS - 8 * MINUTE, outcome: "integrated", activeMs: 3 * MINUTE }),
  fact({
    run: "r1",
    terminalAtMs: NOW_MS - 9 * MINUTE,
    outcome: "rejected",
    activeMs: 10 * MINUTE,
    queueWaitMs: [2 * MINUTE],
  }),
]
const HORIZON = NOW_MS - 10 * DAY

function boxesElement(props: {
  facts: readonly QueueTerminalFact[]
  now: string
  earliestEventMs: number | null
  width: number
}) {
  return h(Box, { width: props.width, flexDirection: "column" }, h(TimeStatsBoxes, props))
}

function rowContaining(app: { text: string }, needle: string): string {
  const rows = app.text.split("\n")
  const index = rows.findIndex((row) => row.includes(needle))
  if (index === -1) throw new Error(`no row contains ${needle}\n${app.text}`)
  return rows[index]!
}

describe("TimeStatsBoxes", () => {
  it("renders all four boxes with window headers and the labelled rows", () => {
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 160 }))
    for (const title of ["FLOW", "TIME INTEGRATED", "TIME FAILED", "TIME WAIT"]) expect(app.text).toContain(title)
    for (const header of ["HR", "DAY", "WK", "MON"]) expect(app.text).toContain(header)
    for (const label of ["RUNS", "INTEGRATED", "FAILS", "decision", "env", "canceled", "AVG", "p50", "p90"]) {
      expect(app.text).toContain(label)
    }
  })

  it("shows covered counts, the fail share, and integrated durations", () => {
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 160 }))
    // RUNS row leads with the HR count of 3.
    expect(rowContaining(app, "RUNS")).toMatch(/RUNS\s+3\b/u)
    // FAILS = 1 of 3 runs = 33%.
    expect(app.text).toContain("33%")
    // Integrated active AVG of 1m and 3m = 2:00; p50 nearest-rank = 1:00.
    expect(app.text).toContain("2:00")
    expect(app.text).toContain("1:00")
  })

  it("renders the uncovered windows as '-' and never a fabricated number", () => {
    // Horizon only 5 minutes back: every window is a partial window.
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: NOW_MS - 5 * MINUTE, width: 160 }))
    // No window is covered, so no run count and no share renders anywhere.
    expect(app.text).not.toContain("33%")
    expect(rowContaining(app, "RUNS")).not.toMatch(/RUNS\s+3\b/u)
    expect(app.text).toContain("-")
  })

  it("places the four boxes side by side when the pane is wide", () => {
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 160 }))
    // All four titles share the same border row.
    expect(rowContaining(app, "FLOW")).toContain("TIME WAIT")
  })

  it("wraps to a 2x2 grid on a medium pane", () => {
    const render = createRenderer({ cols: 84, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 84 }))
    const flowRow = rowContaining(app, "FLOW")
    // First pair shares a row; the second pair (TIME FAILED / TIME WAIT) does not.
    expect(flowRow).toContain("TIME INTEGRATED")
    expect(flowRow).not.toContain("TIME WAIT")
  })

  it("stacks into a single column on a narrow pane", () => {
    const render = createRenderer({ cols: 40, rows: 60 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 40 }))
    const flowRow = rowContaining(app, "FLOW")
    expect(flowRow).not.toContain("TIME INTEGRATED")
    expect(flowRow).not.toContain("TIME WAIT")
  })
})
