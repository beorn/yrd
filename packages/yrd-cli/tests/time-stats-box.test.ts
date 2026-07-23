// @failure The queue STATS panel loses calendar columns, truthful journal-derived values, responsive hour density, accessible detail, or border integrity.
// @level l1
// @consumer yrd queue watch statistics surface

import { createRenderer } from "@silvery/test"
import { act, createElement as h } from "react"
import { Box, createKeyEvent, dispatchKeyEvent, parseKey } from "silvery"
import { describe, expect, it } from "vitest"
import type { QueueTerminalFact } from "../src/queue-status-view.tsx"
import { QueueStatsPanel, queueStatsHourCount } from "../src/time-stats-box.tsx"

const MINUTE = 60_000
const NOW = "2026-07-16T12:30:00.000Z"
const NOW_MS = Date.parse(NOW)

function fact(
  overrides: Partial<QueueTerminalFact> & Pick<QueueTerminalFact, "run" | "terminalAtMs" | "outcome">,
): QueueTerminalFact {
  return {
    activeMs: MINUTE,
    failureClass: overrides.outcome === "integrated" ? null : "other",
    members: [],
    queueWaitMs: [],
    ...overrides,
  }
}

// Three Runs inside the latest local hour: one batched integration containing
// two PRs and one environmental failure. Every displayed statistic is derived
// from these retained terminal/member facts.
const FACTS: readonly QueueTerminalFact[] = [
  fact({
    run: "integrated",
    terminalAtMs: NOW_MS - 5 * MINUTE,
    outcome: "integrated",
    members: [
      {
        pr: "PR1",
        revision: 1,
        totalMs: MINUTE,
        totalApproximate: false,
        codingMs: null,
        queueWaitMs: MINUTE,
        jobRunMs: 3 * MINUTE,
        retries: 0,
      },
      {
        pr: "PR2",
        revision: 2,
        totalMs: 3 * MINUTE,
        totalApproximate: true,
        codingMs: null,
        queueWaitMs: 3 * MINUTE,
        jobRunMs: 5 * MINUTE,
        retries: 2,
      },
    ],
  }),
  fact({
    run: "failed",
    terminalAtMs: NOW_MS - 8 * MINUTE,
    outcome: "environment-refused",
    failureClass: "env",
    members: [
      {
        pr: "PR3",
        revision: 1,
        totalMs: null,
        totalApproximate: false,
        codingMs: null,
        queueWaitMs: 2 * MINUTE,
        jobRunMs: 10 * MINUTE,
        retries: 1,
      },
    ],
  }),
]
const HORIZON = new Date(2026, 5, 1).getTime()

function boxesElement(props: {
  facts: readonly QueueTerminalFact[]
  now: string
  earliestEventMs: number | null
  width: number
}) {
  return h(Box, { width: props.width, flexDirection: "column" }, h(QueueStatsPanel, props))
}

function rowContaining(app: { text: string }, needle: string): string {
  const rows = app.text.split("\n")
  const index = rows.findIndex((row) => row.includes(needle))
  if (index === -1) throw new Error(`no row contains ${needle}\n${app.text}`)
  return rows[index]!
}

/**
 * Assert the titled metrics box is a clean rectangle: the interior rows carry the left/right
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

describe("QueueStatsPanel", () => {
  it("renders the requested period columns and metric hierarchy in one STATS frame", () => {
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 126 }))
    expect(app.text).toContain("╭─ STATS ")
    expect(app.text).not.toContain("╭─ FLOW ")
    expect(app.text).not.toContain("╭─ TIME ")
    for (const header of ["TODAY", "YESTERDAY", "THIS WEEK", "THIS MONTH"]) {
      expect(app.text).toContain(header)
    }
    for (const label of [
      "RUNS",
      "ALL",
      "INTEGRATED",
      "FAILS",
      "AVG TIME",
      "TOTAL",
      "CODING",
      "QUEUE WAIT",
      "JOB RUN",
      "RETRIES",
    ]) {
      expect(app.text).toContain(label)
    }
  })

  it("shows Run counts, landed-PR counts, duration averages, approximation, and unavailable coding truth", () => {
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 126 }))
    expect(rowContaining(app, "ALL")).toMatch(/ALL\s+2\b/u)
    expect(rowContaining(app, "INTEGRATED")).toMatch(/INTEGRATED\s+2\b/u)
    expect(rowContaining(app, "FAILS")).toMatch(/FAILS\s+1\b/u)
    expect(rowContaining(app, "TOTAL")).toContain("~2:00")
    expect(rowContaining(app, "CODING")).toContain("—")
    expect(rowContaining(app, "QUEUE WAIT")).toContain("2:00")
    expect(rowContaining(app, "JOB RUN")).toContain("6:00")
    expect(rowContaining(app, "RETRIES")).toMatch(/RETRIES\s+1\b/u)
  })

  it("renders uncovered buckets as an em dash and never a fabricated number", () => {
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: NOW_MS - 5 * MINUTE, width: 126 }))
    expect(rowContaining(app, "ALL")).not.toMatch(/ALL\s+2\b/u)
    expect(rowContaining(app, "ALL")).toContain("—")
    expect(rowContaining(app, "TOTAL")).not.toContain("~2:00")
  })

  it("adapts only the newest-first local hour columns while retaining all fixed periods", () => {
    expect([48, 49, 53, 80, 145].map(queueStatsHourCount)).toEqual([0, 0, 1, 7, 24])

    const wideRender = createRenderer({ cols: 126, rows: 30 })
    const wide = wideRender(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 126 }))
    const header = rowContaining(wide, "TODAY")
    const currentHour = String(new Date(NOW_MS).getHours()).padStart(2, "0")
    expect(header.indexOf(currentHour)).toBeGreaterThanOrEqual(0)
    expect(header.indexOf(currentHour)).toBeLessThan(header.indexOf("TODAY"))
    expect(header.indexOf("TODAY")).toBeLessThan(header.indexOf("YESTERDAY"))
    expect(header.indexOf("YESTERDAY")).toBeLessThan(header.indexOf("THIS WEEK"))
    expect(header.indexOf("THIS WEEK")).toBeLessThan(header.indexOf("THIS MONTH"))

    const narrowRender = createRenderer({ cols: 49, rows: 30 })
    const narrow = narrowRender(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 49 }))
    const narrowHeader = rowContaining(narrow, "TODAY")
    expect(narrowHeader).not.toContain(currentHour)
    for (const fixed of ["TODAY", "YESTERDAY", "THIS WEEK", "THIS MONTH"]) expect(narrowHeader).toContain(fixed)
  })

  it("shows the shared failure breakdown on hover", async () => {
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 126 }))
    const rows = app.text.split("\n")
    const header = rowContaining(app, "TODAY")
    const x = header.indexOf("TODAY")
    const y = rows.findIndex((row) => row.includes("FAILS"))
    await app.hover(x, y)

    expect(app.text).toContain("FAILS · TODAY")
    for (const label of [
      "check-failed 0",
      "env 1",
      "stale 0",
      "timeout 0",
      "config-drift 0",
      "canceled 0",
      "other 0",
    ]) {
      expect(app.text).toContain(label)
    }
  })

  it("exposes failure, duration, and retry details through the keyboard focus path", async () => {
    const render = createRenderer({ cols: 49, rows: 30 })
    const element = boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width: 49 })
    const app = render(element)

    await app.press("Tab")
    expect(app.text).toContain("FAILS · TODAY")

    const failsRow = app.getByTestId("queue-stats-row-fails").resolve()
    if (failsRow === null) throw new Error("missing focused FAILS statistics row")
    const dispatchArrow = (raw: string) => {
      const [input, key] = parseKey(raw)
      act(() => dispatchKeyEvent(createKeyEvent(input, key, failsRow)))
      app.rerender(element)
    }
    dispatchArrow("\u001b[C")
    expect(app.text).toContain("FAILS · YESTERDAY")
    dispatchArrow("\u001b[D")
    expect(app.text).toContain("FAILS · TODAY")

    await app.press("Tab")
    expect(app.text.replace(/\s+/gu, " ")).toContain("TOTAL · TODAY · avg ~2:00 · p50 ~2:00 · p95 ~3:00")

    for (let index = 0; index < 4; index++) await app.press("Tab")
    const retryDetail = app.text.replace(/\s+/gu, " ")
    expect(retryDetail).toContain("RETRIES · TODAY · avg 1 · p50 1 · p95 2")
    expect(retryDetail).toContain("revisions−1 + failed attempts")
  })

  it("keeps one clean STATS frame at wide and minimum widths", () => {
    for (const width of [49, 126]) {
      const render = createRenderer({ cols: width, rows: 30 })
      const app = render(boxesElement({ facts: FACTS, now: NOW, earliestEventMs: HORIZON, width }))
      assertBoxClean(app.text, "STATS")
    }
  })
})
