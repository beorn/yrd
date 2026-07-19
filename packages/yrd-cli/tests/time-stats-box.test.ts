// @failure The separate FLOW/TIME boxes lose a section, rolling-window values, responsive layout, coverage honesty, or border integrity.
// @level l1
// @consumer yrd queue watch statistics surface

import { createRenderer } from "@silvery/test"
import { createElement as h } from "react"
import { Box } from "silvery"
import { describe, expect, it } from "vitest"
import type { QueueTerminalFact } from "../src/queue-status-view.tsx"
import { TimeStatsBox } from "../src/time-stats-box.tsx"

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
  return h(Box, { width: props.width, flexDirection: "column" }, h(TimeStatsBox, props))
}

function rowContaining(app: { text: string }, needle: string): string {
  const rows = app.text.split("\n")
  const index = rows.findIndex((row) => row.includes(needle))
  if (index === -1) throw new Error(`no row contains ${needle}\n${app.text}`)
  return rows[index]!
}

/**
 * Assert a titled metrics box is a clean rectangle: the interior rows carry the left/right
 * `│` border at the box's own columns and the bottom row is an unbroken
 * `╰──…──╯`. This catches a row drawn over a box border (the reported glitch),
 * since a content glyph landing where a border cell belongs fails the check.
 */
function assertBoxClean(text: string, title: string): number {
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
  return bottomIndex
}

describe("TimeStatsBox", () => {
  it("renders separately titled FLOW and TIME boxes", () => {
    const render = createRenderer({ cols: 126, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 126 }))
    expect(app.text).toContain("╭─ FLOW ")
    expect(app.text).not.toContain("╭─ STATS ")
    expect(app.text).toContain("╭─ TIME ")
    expect(app.text).toContain("FLOW")
    expect(app.text).toContain("TIME")
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
    // MON heads the FLOW section and the TIME INTEGRATED section — exactly two
    // occurrences. A per-section repeat (FAILED/WAIT) would push this to four.
    const monCount = (app.text.match(/MON/gu) ?? []).length
    expect(monCount).toBe(2)
  })

  it("groups TIME metrics under one heading per state instead of repeating state prefixes", () => {
    const render = createRenderer({ cols: 126, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 126 }))
    const rows = app.text.split("\n")
    const timeX = rowContaining(app, "╭─ TIME ").indexOf("╭─ TIME ")
    const timeRows = rows.map((row) => row.slice(timeX))
    const timeText = timeRows.join("\n")
    expect(
      timeRows.find((row) => row.includes("HR")),
      "TIME names the metric column before its windows",
    ).toMatch(/METRIC\s+HR/u)

    for (const section of ["INTEGRATED", "FAILED", "WAIT"]) {
      expect(timeText.match(new RegExp(section, "gu")), `${section} is named once in TIME`).toHaveLength(1)
      const sectionY = timeRows.findIndex((row) => row.includes(section))
      expect(sectionY, `${section} heading exists`).toBeGreaterThanOrEqual(0)
      expect(timeRows[sectionY]).not.toMatch(/\b(?:avg|p50|p90)\b/u)
      expect(timeRows.slice(sectionY + 1, sectionY + 4).map((row) => row.trimStart().split(/\s+/u)[0])).toEqual([
        "avg",
        "p50",
        "p90",
      ])
    }
    expect(timeText).not.toMatch(/(?:INTEGRATED|FAILED|WAIT) (?:avg|p50|p90)/u)
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
    expect(app.text).toContain("- no full window")
  })

  it("places clean FLOW and TIME frames side by side at the live pane width", () => {
    const render = createRenderer({ cols: 126, rows: 40 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 126 }))
    expect(rowContaining(app, "╭─ FLOW ")).toContain("╭─ TIME ")
    const flowBottom = assertBoxClean(app.text, "FLOW")
    const timeBottom = assertBoxClean(app.text, "TIME")
    expect(flowBottom, "side-by-side boxes share one bottom edge").toBe(timeBottom)
  })

  it("stacks the independently framed FLOW and TIME boxes on a narrow pane", () => {
    const render = createRenderer({ cols: 48, rows: 60 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 48 }))
    const rows = app.text.split("\n")
    expect(rows.findIndex((r) => r.includes("╭─ TIME "))).toBeGreaterThan(rows.findIndex((r) => r.includes("╭─ FLOW ")))
    assertBoxClean(app.text, "FLOW")
    assertBoxClean(app.text, "TIME")
  })
})
