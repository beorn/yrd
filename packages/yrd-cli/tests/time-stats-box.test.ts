// @failure The queue STATS panel loses calendar columns, truthful journal-derived values, responsive hour density, accessible detail, or border integrity.
// @level l1
// @consumer yrd queue watch statistics surface

import { createRenderer } from "silvery/test"
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
    failureClass: overrides.outcome === "integrated" || overrides.outcome === "already-landed" ? null : "other",
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
    queueWaitMs: [MINUTE, 3 * MINUTE],
    members: [
      {
        pr: "PR1",
        revision: 1,
        totalMs: MINUTE,
        totalApproximate: false,
        codingMs: null,
        jobRunMs: 3 * MINUTE,
        retries: 0,
      },
      {
        pr: "PR2",
        revision: 2,
        totalMs: 3 * MINUTE,
        totalApproximate: true,
        codingMs: null,
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
    queueWaitMs: [2 * MINUTE],
    members: [
      {
        pr: "PR3",
        revision: 1,
        totalMs: null,
        totalApproximate: false,
        codingMs: null,
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
  earliestFactMs: number | null
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
 * since a content glyph merge where a border cell belongs fails the check.
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
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestFactMs: HORIZON, width: 126 }))
    expect(app.text).toContain("╭─ STATS ")
    expect(app.text).not.toContain("╭─ FLOW ")
    expect(app.text).not.toContain("╭─ TIME ")
    for (const header of ["TODAY", "YSTRDAY", "WEEK", "MONTH"]) {
      expect(app.text).toContain(header)
    }
    expect(app.text).not.toContain("THIS WEEK")
    expect(app.text).not.toContain("THIS MONTH")
    for (const label of [
      "RUNS",
      "ALL",
      "MERGED",
      "DUP",
      "PASS",
      "FAILS",
      "AVG TIME",
      "TOTAL",
      "QUEUING",
      "RUNNING",
      "RETRIES/RUN",
    ]) {
      expect(app.text).toContain(label)
    }
    for (const removed of ["INTEGRATED", "ALREADY", "CODING", "QUEUE WAIT", "JOB RUN"]) {
      expect(app.text).not.toContain(removed)
    }

    const rows = app.text.split("\n")
    const headerRow = rows.findIndex((row) => row.includes("TODAY"))
    expect(rows[headerRow]).toContain("RUNS")
    expect(rows.filter((row) => row.includes("RUNS"))).toHaveLength(1)
    // DUP sits just above FAILS (operator ruling 2026-08-18) — the two rows a
    // merge could have gone to instead of a clean MERGED.
    const countRows = ["ALL", "MERGED", "PASS", "DUP", "FAILS"].map((label) =>
      rows.findIndex((row) => row.includes(label)),
    )
    expect(countRows.every((index) => index >= 0)).toBe(true)
    expect(countRows).toEqual(countRows.toSorted((left, right) => left - right))
  })

  it("draws the midnight boundary as its own column running through the header and every data row", () => {
    // Two active hours either side of LOCAL midnight: 00:10 today, 23:05
    // yesterday. Local `Date` submodule constructors throughout (matching
    // the day-boundary test in time-stats.test.ts) so the crossing is real
    // regardless of the test runner's own TZ — a UTC ISO fixture would only
    // merge on a local midnight by coincidence of that TZ's offset.
    const boundaryNow = new Date(2026, 6, 16, 0, 20).toISOString()
    const facts: readonly QueueTerminalFact[] = [
      fact({ run: "today-hour", terminalAtMs: new Date(2026, 6, 16, 0, 10).getTime(), outcome: "passed" }),
      fact({ run: "yesterday-hour", terminalAtMs: new Date(2026, 6, 15, 23, 5).getTime(), outcome: "passed" }),
    ]
    const app = createRenderer({ cols: 126, rows: 30 })(
      boxesElement({ facts, now: boundaryNow, earliestFactMs: HORIZON, width: 126 }),
    )
    const rows = app.text.split("\n")
    const headerRow = rows.find((row) => row.includes("00") && row.includes("23"))
    if (headerRow === undefined) throw new Error(`missing hour header row:\n${app.text}`)

    // Never fused onto the "23" label: a bare boundary marker followed
    // directly by the digits (no separating space) is exactly the shape
    // this test rules out.
    expect(headerRow).not.toContain("│23")

    // Skip the box's own left border, which is the same "│" glyph.
    const boundaryX = headerRow.indexOf("│", headerRow.indexOf("RUNS"))
    expect(boundaryX, "the header must carry the boundary column").toBeGreaterThanOrEqual(0)
    expect(headerRow.indexOf("00")).toBeLessThan(boundaryX)
    expect(boundaryX).toBeLessThan(headerRow.indexOf("23"))

    // The SAME column, on every data row below the header — a vertical rule,
    // not a header-only annotation.
    const allRow = rows.find((row) => row.includes("ALL") && !row.includes("RUNS"))
    if (allRow === undefined) throw new Error(`missing ALL row:\n${app.text}`)
    expect(allRow[boundaryX]).toBe("│")
    const failsRow = rows.find((row) => row.includes("FAILS"))
    if (failsRow === undefined) throw new Error(`missing FAILS row:\n${app.text}`)
    expect(failsRow[boundaryX]).toBe("│")
  })

  it("shows Run counts, merged-PR counts, and duration averages using the compact vocabulary", () => {
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestFactMs: HORIZON, width: 126 }))
    expect(rowContaining(app, "ALL")).toMatch(/ALL\s+2\b/u)
    expect(rowContaining(app, "MERGED")).toMatch(/MERGED\s+2\b/u)
    expect(rowContaining(app, "FAILS")).toMatch(/FAILS\s+1\b/u)
    expect(rowContaining(app, "TOTAL")).toContain("~2:00")
    expect(app.text).not.toContain("CODING")
    expect(rowContaining(app, "QUEUING")).toContain("2:00")
    expect(rowContaining(app, "RUNNING")).toContain("6:00")
    expect(rowContaining(app, "RETRIES/RUN")).toMatch(/RETRIES\/RUN\s+1\b/u)
  })

  it("shows already-landed PRs without inflating integrated or failed metrics", () => {
    const deduplicated = fact({
      run: "deduplicated",
      terminalAtMs: NOW_MS - 4 * MINUTE,
      outcome: "already-landed",
      members: [
        {
          pr: "PR4",
          revision: 1,
          totalMs: 4 * MINUTE,
          totalApproximate: false,
          codingMs: null,
          jobRunMs: 4 * MINUTE,
          retries: 0,
        },
      ],
    })
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: [...FACTS, deduplicated], now: NOW, earliestFactMs: HORIZON, width: 126 }))
    expect(rowContaining(app, "ALL")).toMatch(/ALL\s+3\b/u)
    expect(rowContaining(app, "MERGED")).toMatch(/MERGED\s+2\b/u)
    expect(rowContaining(app, "DUP")).toMatch(/DUP\s+1\b/u)
    expect(rowContaining(app, "FAILS")).toMatch(/FAILS\s+1\b/u)
  })

  it("renders uncovered buckets as an em dash and never a fabricated number", () => {
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestFactMs: NOW_MS - 5 * MINUTE, width: 126 }))
    expect(rowContaining(app, "ALL")).not.toMatch(/ALL\s+2\b/u)
    expect(rowContaining(app, "ALL")).toContain("—")
    // An uncovered bucket is NOT a measured zero: it keeps the em dash and
    // must never borrow the "-" that means "measured, and it was zero".
    expect(rowContaining(app, "ALL")).not.toContain("-")
    expect(rowContaining(app, "TOTAL")).not.toContain("~2:00")
  })

  it("renders a measured zero as a muted hyphen while a nonzero keeps its row color", () => {
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestFactMs: HORIZON, width: 126 }))
    const rows = app.text.split("\n")
    const header = rows.findIndex((row) => row.includes("YSTRDAY"))
    const failsY = rows.findIndex((row) => row.includes("FAILS"))
    const yesterdayX = rows[header]!.indexOf("YSTRDAY") + "YSTRDAY".length - 1
    const todayX = rows[header]!.indexOf("TODAY") + "TODAY".length - 1

    // The row label is the panel's own muted tone; the hyphen must match it
    // rather than FAILS' error red, so a measured zero never reads as a fail.
    const muted = app.cell(rows[failsY]!.indexOf("FAILS"), failsY).fg
    expect(app.cell(yesterdayX, failsY).char, "yesterday measured zero fails").toBe("-")
    expect(app.cell(yesterdayX, failsY).fg, "the zero hyphen is muted, not error red").toEqual(muted)

    // The measured nonzero in the same row is untouched, color included.
    expect(app.cell(todayX, failsY).char, "today measured one fail").toBe("1")
    expect(app.cell(todayX, failsY).fg, "a nonzero keeps the row's error color").not.toEqual(muted)

    // Rows that are all zeros carry no digit at all.
    expect(rowContaining(app, "PASS")).not.toContain("0")
    expect(rowContaining(app, "DUP")).not.toContain("0")
    expect(rowContaining(app, "PASS")).toContain("-")
  })

  it("keeps the no-data em dash distinct from the measured-zero hyphen in one row", () => {
    // One integrated run whose only member retried zero times — the retry
    // distribution samples integrated members only, so the outcome matters.
    // Its buckets average exactly 0 while the unsampled ones have no average
    // at all: the two states the panel must not conflate.
    const noRetries = fact({
      run: "clean",
      terminalAtMs: NOW_MS - 3 * MINUTE,
      outcome: "integrated",
      members: [
        {
          pr: "PR9",
          revision: 1,
          totalMs: MINUTE,
          totalApproximate: false,
          codingMs: null,
          jobRunMs: MINUTE,
          retries: 0,
        },
      ],
    })
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: [noRetries], now: NOW, earliestFactMs: HORIZON, width: 126 }))
    const retries = rowContaining(app, "RETRIES/RUN")
    expect(retries, "sampled average of 0 renders as the hyphen").toContain("-")
    expect(retries, "an unsampled covered bucket keeps the em dash").toContain("—")
    expect(retries, "no bare zero survives anywhere in the row").not.toContain("0")
  })

  it("adapts only the newest-first local hour columns while retaining all fixed periods", () => {
    expect([47, 48, 49, 54, 55, 80, 145, 160].map(queueStatsHourCount)).toEqual([0, 0, 0, 0, 1, 6, 19, 22])

    const wideRender = createRenderer({ cols: 126, rows: 30 })
    const wide = wideRender(boxesElement({ facts: FACTS, now: NOW, earliestFactMs: HORIZON, width: 126 }))
    const header = rowContaining(wide, "TODAY")
    const currentHour = String(new Date(NOW_MS).getHours()).padStart(2, "0")
    expect(header.indexOf(currentHour)).toBeGreaterThanOrEqual(0)
    expect(header.indexOf(currentHour)).toBeLessThan(header.indexOf("TODAY"))
    expect(header.indexOf("TODAY")).toBeLessThan(header.indexOf("YSTRDAY"))
    expect(header.indexOf("YSTRDAY")).toBeLessThan(header.indexOf("WEEK"))
    expect(header.indexOf("WEEK")).toBeLessThan(header.indexOf("MONTH"))

    const narrowRender = createRenderer({ cols: 49, rows: 30 })
    const narrow = narrowRender(boxesElement({ facts: FACTS, now: NOW, earliestFactMs: HORIZON, width: 49 }))
    const narrowHeader = rowContaining(narrow, "TODAY")
    expect(narrowHeader).not.toContain(currentHour)
    for (const fixed of ["TODAY", "YSTRDAY", "WEEK", "MONTH"]) expect(narrowHeader).toContain(fixed)

    const hourRender = createRenderer({ cols: 55, rows: 30 })
    const hour = hourRender(boxesElement({ facts: FACTS, now: NOW, earliestFactMs: HORIZON, width: 55 }))
    const hourHeader = rowContaining(hour, "TODAY")
    expect(hourHeader).toContain(currentHour)
    expect(hourHeader.indexOf(currentHour)).toBeLessThan(hourHeader.indexOf("…"))
    expect(hourHeader.indexOf("…")).toBeLessThan(hourHeader.indexOf("TODAY"))
    expect(rowContaining(hour, "TOTAL").match(/~2:00/gu)).toHaveLength(3)
  })

  it("keeps the non-exhaustive marker visible when active hours fill the width budget", () => {
    const activeHours = Array.from({ length: 15 }, (_, index) =>
      fact({
        run: `active-hour-${String(index)}`,
        terminalAtMs: NOW_MS - (5 + index * 60) * MINUTE,
        outcome: "passed",
      }),
    )
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: activeHours, now: NOW, earliestFactMs: HORIZON, width: 126 }))

    expect(rowContaining(app, "TODAY")).toContain("…")
    expect(rowContaining(app, "ALL")).toContain("·")
  })

  it("renders PASS with the same success foreground as the merged count", () => {
    const passed = fact({
      run: "passed",
      terminalAtMs: NOW_MS - 4 * MINUTE,
      outcome: "passed",
    })
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: [...FACTS, passed], now: NOW, earliestFactMs: HORIZON, width: 126 }))
    const rows = app.text.split("\n")
    const successY = rows.findIndex((row) => row.includes("MERGED"))
    const passY = rows.findIndex((row) => row.includes("PASS"))
    const successX = rows[successY]!.indexOf("2")
    const passX = rows[passY]!.indexOf("1")

    expect(app.cell(successX, successY).char).toBe("2")
    expect(app.cell(passX, passY).char).toBe("1")
    expect(app.cell(passX, passY).fg).toEqual(app.cell(successX, successY).fg)
  })

  it("shows the shared failure breakdown on hover", async () => {
    const render = createRenderer({ cols: 126, rows: 30 })
    const app = render(boxesElement({ facts: FACTS, now: NOW, earliestFactMs: HORIZON, width: 126 }))
    const rows = app.text.split("\n")
    const header = rowContaining(app, "TODAY")
    const x = header.indexOf("TODAY")
    const y = rows.findIndex((row) => row.includes("FAILS"))
    await app.hover(x, y)

    expect(app.text).toContain("FAILS · TODAY")
    for (const label of ["check-failed 0", "env 1", "stale 0", "timeout 0", "canceled 0", "other 0"]) {
      expect(app.text).toContain(label)
    }
    expect(app.text).not.toContain("config-drift")
  })

  it("exposes failure, duration, and retry details through the keyboard focus path", async () => {
    const render = createRenderer({ cols: 49, rows: 30 })
    const element = boxesElement({ facts: FACTS, now: NOW, earliestFactMs: HORIZON, width: 49 })
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
    expect(app.text).toContain("FAILS · YSTRDAY")
    dispatchArrow("\u001b[D")
    expect(app.text).toContain("FAILS · TODAY")

    await app.press("Tab")
    expect(app.text.replace(/\s+/gu, " ")).toContain("TOTAL · TODAY · avg ~2:00 · p50 ~2:00 · p95 ~3:00")

    for (let index = 0; index < 3; index++) await app.press("Tab")
    const retryDetail = app.text.replace(/\s+/gu, " ")
    expect(retryDetail).toContain("RETRIES/RUN · TODAY · avg 1 · p50 1 · p95 2")
    expect(retryDetail).toContain("revisions−1 + failed attempts")
  })

  it("omits a semantically incomplete compact panel and keeps complete frames clean", () => {
    for (const width of [40, 47]) {
      const render = createRenderer({ cols: width, rows: 30 })
      const app = render(boxesElement({ facts: FACTS, now: NOW, earliestFactMs: HORIZON, width }))
      expect(app.text).not.toContain("STATS")
    }
    for (const width of [48, 126]) {
      const render = createRenderer({ cols: width, rows: 30 })
      const app = render(boxesElement({ facts: FACTS, now: NOW, earliestFactMs: HORIZON, width }))
      assertBoxClean(app.text, "STATS")
    }
  })
})
