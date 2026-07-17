// @failure The windowed TimeStatsBox surface stops rendering the FLOW + TIME boxes, the stacked TIME sections, the window-key header once, the coverage "-" gate, the responsive side-by-side/stacked arrangement, or draws a row over a box border.
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

/**
 * Assert one box is a clean rectangle: the interior rows carry the left/right
 * `│` border at the box's own columns and the bottom row is an unbroken
 * `╰──…──╯`. This catches a row drawn over a box border (the reported glitch),
 * since a content glyph landing where a border cell belongs fails the check.
 */
function assertBoxClean(text: string, title: string): void {
  const rows = text.split("\n")
  const topIndex = rows.findIndex((row) => row.includes(`╭─ ${title} `))
  expect(topIndex, `top border for ${title}`).toBeGreaterThanOrEqual(0)
  const top = rows[topIndex]!
  const left = top.indexOf(`╭─ ${title} `)
  const right = top.indexOf("╮", left)
  expect(right, `top-right corner for ${title}`).toBeGreaterThan(left)
  let bottomIndex = -1
  for (let i = topIndex + 1; i < rows.length; i++) {
    if (rows[i]![left] === "╰") {
      bottomIndex = i
      break
    }
  }
  expect(bottomIndex, `bottom border for ${title}`).toBeGreaterThan(topIndex)
  for (let i = topIndex + 1; i < bottomIndex; i++) {
    expect(rows[i]![left], `${title} left border at row ${i}`).toBe("│")
    expect(rows[i]![right], `${title} right border at row ${i}`).toBe("│")
  }
  const bottom = rows[bottomIndex]!
  expect(bottom[right], `${title} bottom-right corner`).toBe("╯")
  expect(/^[─]+$/u.test(bottom.slice(left + 1, right)), `${title} bottom edge unbroken`).toBe(true)
}

describe("TimeStatsBoxes", () => {
  it("renders the FLOW box and the stacked TIME box with all sections and rows", () => {
    const render = createRenderer({ cols: 126, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 126 }))
    expect(app.text).toContain("╭─ FLOW ")
    expect(app.text).toContain("╭─ TIME ")
    for (const header of ["HR", "DAY", "WK", "MON"]) expect(app.text).toContain(header)
    // FLOW rows.
    for (const label of ["RUNS", "INTEGRATED", "FAILS", "decision", "env", "canceled"]) {
      expect(app.text).toContain(label)
    }
    // TIME stacked sections + metric rows.
    for (const section of ["INTEGRATED", "FAILED", "WAIT"]) expect(app.text).toContain(section)
    for (const metric of ["avg", "p50", "p90"]) expect(app.text).toContain(metric)
  })

  it("renders the window-key header once per box, not once per TIME section", () => {
    const render = createRenderer({ cols: 126, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 126 }))
    // MON heads the FLOW box and the TIME INTEGRATED section — exactly two
    // occurrences. A per-section repeat (FAILED/WAIT) would push this to four.
    const monCount = (app.text.match(/MON/gu) ?? []).length
    expect(monCount).toBe(2)
  })

  it("shows covered counts, the fail share, and integrated durations", () => {
    const render = createRenderer({ cols: 126, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 126 }))
    // RUNS row leads with the HR count of 3.
    expect(rowContaining(app, "RUNS")).toMatch(/RUNS\s+3\b/u)
    // FAILS = 1 of 3 runs = 33%.
    expect(app.text).toContain("33%")
    // Integrated active durations 1m and 3m: AVG = 2:00, p50 = median 2:00, p90 = 3:00.
    expect(app.text).toContain("2:00")
    expect(app.text).toContain("3:00")
  })

  it("renders the uncovered windows as '-' and never a fabricated number", () => {
    // Horizon only 5 minutes back: every window is a partial window.
    const render = createRenderer({ cols: 126, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: NOW_MS - 5 * MINUTE, width: 126 }))
    expect(app.text).not.toContain("33%")
    expect(rowContaining(app, "RUNS")).not.toMatch(/RUNS\s+3\b/u)
    expect(app.text).toContain("-")
  })

  it("places FLOW and TIME side by side at the live pane width with clean borders", () => {
    const render = createRenderer({ cols: 126, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 126 }))
    // Both titles head the same border row.
    expect(rowContaining(app, "╭─ FLOW ")).toContain("╭─ TIME ")
    // Neither box draws a row over the other's border despite differing heights.
    assertBoxClean(app.text, "FLOW")
    assertBoxClean(app.text, "TIME")
  })

  it("stacks FLOW above TIME on a narrow pane with clean borders", () => {
    const render = createRenderer({ cols: 48, rows: 60 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 48 }))
    // The FLOW title row does not also carry the TIME title — they are stacked.
    expect(rowContaining(app, "╭─ FLOW ")).not.toContain("╭─ TIME ")
    const rows = app.text.split("\n")
    expect(rows.findIndex((r) => r.includes("╭─ TIME "))).toBeGreaterThan(rows.findIndex((r) => r.includes("╭─ FLOW ")))
    assertBoxClean(app.text, "FLOW")
    assertBoxClean(app.text, "TIME")
  })
})
