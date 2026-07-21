// @failure Queue list drifts from the user-settled 21106 presentation contract
// @level l2
// @consumer @yrd/cli

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { renderString } from "silvery"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  formatQueuePrId,
  QueueTimelineView,
  PRDetailView,
  queueTimelineAdmissionTimes,
  queueTimelineDefaultCursorId,
  queueTimelineDisplayRows,
  queueTimelineProjection,
  prDetailData,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const contractProjection = (): QueueTimelineProjection => {
  const projection = queueTimelineStories["contract-overview"].snapshot.projection
  if (projection === undefined) throw new Error("contract-overview is missing its projection")
  return projection
}

async function renderTimeline(projection: QueueTimelineProjection, width: number): Promise<string[]> {
  const rendered = await renderString(createElement(QueueTimelineView, { projection, columns: width }), {
    width,
    height: 45,
    plain: true,
  })
  return rendered.split("\n")
}

function rowIndex(rows: readonly string[], needle: string): number {
  const index = rows.findIndex((row) => row.includes(needle))
  if (index < 0) throw new Error(`expected a rendered row containing '${needle}'`)
  return index
}

function detailTitleRow(text: string): string {
  return text.split("\n")[0] ?? ""
}

describe("queue timeline 21106 contract", () => {
  // Queue clocks render in the system-local timezone; pin the suite to a
  // deterministic DST-free offset (+5:30) like the CLI suite does.
  let priorTZ: string | undefined
  beforeAll(() => {
    priorTZ = process.env.TZ
    process.env.TZ = "Asia/Kolkata"
  })
  afterAll(() => {
    if (priorTZ === undefined) delete process.env.TZ
    else process.env.TZ = priorTZ
  })

  it("renders separately bordered FLOW and TIME boxes after the list", async () => {
    const rows = (await renderTimeline(contractProjection(), 120)).map((row) => row.trimEnd())
    const frame = rows.join("\n")
    const pillsLine = rows.findIndex((row) => /todo.*running.*failed.*done/u.test(row))
    const statsLine = rowIndex(rows, "╭─ FLOW ")

    expect(statsLine).toBeGreaterThan(pillsLine)
    expect(rows[statsLine]?.length).toBe(120)
    expect(frame).not.toContain("╭─ STATS ")
    expect(frame).toContain("╭─ TIME ")
    for (const cell of ["RUNS", "INTEGRATED", "FAILS", "FAILED", "WAIT", "avg", "p90", "HR", "DAY", "WK", "MON"]) {
      expect(frame).toContain(cell)
    }
  })

  it("renders resident health in RUNNER with the queue-pause STATUS line folded inside it", async () => {
    const normal = (await renderTimeline(contractProjection(), 120)).join("\n")
    expect(normal).toContain("╭─ RUNNER ")
    expect(normal).not.toContain("╭─ STATUS ")
    expect(normal).toContain("[84042]")

    // The separate STATUS box is gone (user directive 2026-07-21): a paused
    // queue's HOLD THE LINE line now renders INSIDE the one RUNNER box.
    const paused = queueTimelineStories.paused.snapshot.projection
    if (paused === undefined) throw new Error("paused story is missing its projection")
    const exceptional = (await renderTimeline(paused, 120)).join("\n")
    expect(exceptional).not.toContain("╭─ STATUS ")
    expect(exceptional.match(/╭─ RUNNER /gu)).toHaveLength(1)
    expect(exceptional).toContain("HOLD THE LINE")
    expect(exceptional).toContain("NO RUNNER")

    const stale = {
      ...contractProjection(),
      runner: { pid: 84042, startedAt: "2026-07-13T11:00:00.000Z", lastTickAt: "2026-07-13T11:00:00.000Z" },
    }
    const staleFrame = (await renderTimeline(stale, 120)).join("\n")
    expect(staleFrame).not.toContain("╭─ STATUS ")
    expect(staleFrame.match(/╭─ RUNNER /gu)).toHaveLength(1)
    expect(staleFrame).toContain("[84042]")
    expect(staleFrame).toContain("RUNNER STALE — last tick 1:00:00 ago")
  })

  it("projects one selectable row per exact PR revision with composite cursor identity", () => {
    const projection = contractProjection()
    expect(projection.rows.map((row) => [row.group, row.status, row.run ?? row.pr, row.pr, row.revision])).toEqual([
      ["pending", "pending", "PR1", "PR1", 1],
      ["running", "running", "R42", "PR42", 1],
      ["running", "running", "R42", "PR43", 1],
      ["completed", "rejected", "R5", "PR5", 1],
      ["completed", "integrated", "R4", "PR4", 1],
    ])
    expect(projection.rows[0]?.id.startsWith("main:pr:PR1:1:")).toBe(true)
    expect(projection.rows.slice(1).map((row) => row.id)).toEqual([
      "main:run:R42:PR42:1",
      "main:run:R42:PR43:1",
      "main:run:R5:PR5:1",
      "main:run:R4:PR4:1",
    ])

    const minute = 60_000
    // Batched members repeat the Run facts (step, total) while AGE and queue
    // wait stay member facts.
    expect(projection.rows.map((row) => row.step)).toEqual([undefined, "2:check", "2:check", undefined, undefined])
    expect(projection.rows.map((row) => row.totalMs)).toEqual([
      null,
      20 * minute,
      20 * minute,
      12 * minute,
      15 * minute,
    ])
    expect(projection.rows.map((row) => row.ageMs)).toEqual([
      50 * minute,
      36 * minute,
      34 * minute,
      27 * minute,
      25 * minute,
    ])
    expect(projection.rows.map((row) => row.glyph)).toEqual(["○", "●", "●", "×", "✓"])
    // BY: the submitting actor of each exact PR revision, lossless in JSON.
    expect(projection.rows.map((row) => row.submitter)).toEqual([
      "@cto",
      "@agent/3",
      "@agent/5",
      "@agent/2",
      "@agent/7",
    ])
    // RUNNER: probed lease liveness rides the projection and its dedicated box.
    expect(projection.runner).toEqual({
      pid: 84042,
      startedAt: "2026-07-13T11:00:00.000Z",
      lastTickAt: "2026-07-13T11:59:58.000Z",
    })
    expect(projection.rows[1]?.headSha).toBe("c".repeat(40))
    expect(projection.rows.map((row) => row.subject)).toEqual([
      "Prepare release notes",
      "Align host navigation keybindings without disturbing internal pane controls",
      "Carry the production split-pane contract into the queue detail surface",
      "Reject broken payload",
      "Land the durable patch",
    ])

    // Detail and FLOW metrics stay per-Run even though the list denormalizes.
    expect(projection.details.map((detail) => detail.run)).toEqual(["R42", "R5", "R4"])
    expect(projection.metrics.terminalAttempts).toBe(2)
    expect(projection.metrics.queueWait.n).toBe(2)
  })

  it("renders the information groups in order with RUNNER but no STATUS when normal", async () => {
    const rows = (await renderTimeline(contractProjection(), 120)).map((row) => row.trimEnd())
    const queueLine = rowIndex(rows, "QUEUE")
    const updatedLine = rowIndex(rows, "updated 17:30:00")
    const headerLine = rowIndex(rows, "TIME")
    const lastRowLine = rowIndex(rows, "pr#4.1")
    // Item 2 (deliberate contract change): the pills row moved from ABOVE the
    // header to BELOW the list — new order updated → header → rows → pills →
    // the FLOW/TIME boxes.
    const pillsLine = rows.findIndex((row) => /todo.*running.*failed.*done/u.test(row))
    const statsBoxLine = rowIndex(rows, "╭─ FLOW ")

    expect(queueLine).toBeLessThan(updatedLine)
    expect(updatedLine).toBeLessThan(headerLine)
    expect(headerLine).toBeLessThan(lastRowLine)
    expect(lastRowLine).toBeLessThan(pillsLine)
    expect(pillsLine).toBeLessThan(statsBoxLine)

    // The status box is omitted when the queue is normal.
    expect(rows.join("\n")).not.toContain("HOLD THE LINE")
    // ACTIVE/WAIT moved out of the per-row columns into the statistics box.
    const header = rows[headerLine]
    if (header === undefined) throw new Error("expected the table header row")
    expect(header.trim()).toMatch(/^TIME\s+STATUS\s+RUN\s+PR\s+BY\s+AGE\s+RUN$/u)
    expect(header).not.toContain("ACTIVE")
    expect(header).not.toContain("WAIT")
    expect(header).not.toContain("SUBJECT")
    expect(header).not.toContain("DETAIL")
    expect(header).not.toContain("TOTAL")
    expect(header).toContain("STATUS")
    // RUNNER is always visible; STATUS is reserved for actionable queue pause.
    expect(rows.join("\n")).toContain("╭─ RUNNER ")
    expect(rows.join("\n")).not.toContain("╭─ STATUS ")
    expect(rows.join("\n")).toContain("[84042]")
    expect(rows.join("\n")).not.toContain("NO RUNNER")
    expect(rows.join("\n")).not.toContain("RUNNER STALE")
    expect(rows.join("\n")).not.toContain("oldest open")
    // Separately framed FLOW and TIME share the rolling windows.
    const statisticsText = rows.slice(statsBoxLine).join("\n")
    expect(statisticsText).toContain("╭─ TIME ")
    for (const cell of ["RUNS", "INTEGRATED", "FAILS", "FAILED", "WAIT", "avg", "p90"]) {
      expect(statisticsText).toContain(cell)
    }
    for (const window of ["HR", "DAY", "WK", "MON"]) expect(statisticsText).toContain(window)
  })

  it("renders the user-settled row contract at 160 columns", async () => {
    const projection = contractProjection()
    const rows = (await renderTimeline(projection, 160)).map((row) => row.trimEnd())
    const pending = rows[rowIndex(rows, "pr#1.1")]
    const lead = rows[rowIndex(rows, "pr#42.1")]
    const partner = rows[rowIndex(rows, "pr#43.1")]
    const rejected = rows[rowIndex(rows, "pr#5.1")]
    const integrated = rows[rowIndex(rows, "pr#4.1")]

    // Row contract (user directive 2026-07-16): STEP folded into the flexible
    // cell as `<branch-glyph> <branch> (<status>)` (item Q); BY left-aligned
    // (item R); run duration is a bare dimmed time — no `◷` glyph (item S). The
    // branch glyph (U+E0A0) is matched as one non-space char.
    expect(pending?.trim()).toMatch(
      /^16:40:00 ○ todo\s+-\s+pr#1\.1 for @yrd\/core\/21120-pr-state-notifications\s+@cto\s+50:00$/u,
    )
    expect(lead?.trim()).toMatch(
      /^17:10:00 ● run\s+main#42 pr#42\.1 for @hab\/super\/21135-herdr-keybindings\s+@agent\/3 36:00 20:00$/u,
    )
    expect(partner?.trim()).toMatch(/^-\s+-\s+-\s+pr#43\.1 for @si\/ui\/21119-split-pane\s+@agent\/5 34:00\s+-$/u)
    expect(rejected?.trim()).toMatch(
      /^16:42:00 × fail\s+main#5\s+pr#5\.1\s+\S topic\/pr5 \(err=typecheck-failed\)\s+@agent\/2 27:00 12:00$/u,
    )
    expect(integrated?.trim()).toMatch(/^16:25:00 ✓ done\s+main#4\s+pr#4\.1\s+\S topic\/pr4\s+@agent\/7 25:00 15:00$/u)

    // No row carries the removed clock glyph, and a not-yet-started run shows a
    // muted "-" in the RUN cell (item 9) instead of a run id, no run duration.
    for (const row of [pending, lead, partner, rejected, integrated]) expect(row).not.toContain("◷")
    expect(pending).not.toContain("main#")
  })

  it("keys continuation rows by base and run, and keeps the selected issue blue", async () => {
    const source = contractProjection()
    const lead = source.rows.find((row) => row.pr === "PR42")
    const partner = source.rows.find((row) => row.pr === "PR43")
    if (lead === undefined || partner === undefined) {
      throw new Error("contract fixture is missing the active batched run")
    }
    const projection = {
      ...source,
      rows: [lead, { ...partner, id: `release:${partner.id}`, base: "release" }],
      display: { ...source.display, shown: 2, hidden: 0 },
    }
    const app = createRenderer({ cols: 160, rows: 30 })(
      createElement(QueueTimelineView, { projection, columns: 160, nav: true, cursorKey: 0 }),
    )
    try {
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      const leadY = rowIndex(rows, "@hab/super/21135-herdr-keybindings")
      const partnerY = rowIndex(rows, "@si/ui/21119-split-pane")
      const leadIssueX = rows[leadY]?.indexOf("@hab/super/21135-herdr-keybindings") ?? -1
      const partnerIssueX = rows[partnerY]?.indexOf("@si/ui/21119-split-pane") ?? -1
      const leadForX = rows[leadY]?.indexOf("for") ?? -1

      expect(rows[partnerY]).toContain("release#42")
      expect(app.cell(leadIssueX, leadY).fg).toEqual(app.cell(partnerIssueX, partnerY).fg)
      expect(app.cell(leadIssueX, leadY).fg).not.toEqual(app.cell(leadForX, leadY).fg)
    } finally {
      app.unmount()
    }
  })

  it("uses distinct semantic queue glyphs and removes the redundant task/ branch prefix", async () => {
    const source = contractProjection()
    const projection = {
      ...source,
      rows: source.rows.map((row) => ({ ...row, branch: `task/${row.branch}` })),
    }
    const rows = (await renderTimeline(projection, 160)).map((row) => row.trimEnd())
    const pending = rows[rowIndex(rows, "pr#1.1")]
    const running = rows[rowIndex(rows, "pr#42.1")]
    const rejected = rows[rowIndex(rows, "pr#5.1")]
    const integrated = rows[rowIndex(rows, "pr#4.1")]

    expect(pending).toContain("○ todo")
    expect(running).toContain("● run")
    expect(rejected).toContain("× fail")
    expect(integrated).toContain("✓ done")
    for (const row of [pending, running, rejected, integrated]) expect(row).not.toContain("task/")

    const production = queueTimelineStories["production-overview"].snapshot.projection
    if (production === undefined) throw new Error("production-overview is missing its projection")
    const productionRows = (await renderTimeline(production, 160)).map((row) => row.trimEnd())
    const environment = productionRows[rowIndex(productionRows, "pr#6.1")]
    expect(environment).toContain("× env")
    expect(environment).toContain("(err=queue-environment)")
  })

  it("folds a consecutive same-PR outcome storm to one selectable row and expands it on select", async () => {
    const story = queueTimelineStories["production-overview"]
    const projection = story.snapshot.projection
    if (projection === undefined) throw new Error("production-overview is missing its projection")
    const environment = projection.rows.find((row) => row.pr === "PR6")
    if (environment?.timestampMs === undefined || environment.timestampMs === null) {
      throw new Error("production-overview is missing its environment-refused row")
    }
    const environmentTimestampMs = environment.timestampMs
    const stormRows = Array.from({ length: 21 }, (_, index) => {
      const timestampMs = environmentTimestampMs - index * 30_000
      return {
        ...environment,
        id: `main:run:R${909 - index}:PR6:1`,
        run: `R${909 - index}`,
        timestampMs,
        timestamp: new Date(timestampMs).toISOString(),
      }
    })
    const stormProjection = {
      ...projection,
      rows: stormRows,
      display: { limit: 5, shown: 5, hidden: stormRows.length - 5 },
      details: [],
    }
    const oneShot = (await renderTimeline(stormProjection, 200)).join("\n")
    expect(oneShot.match(/pr#6\.1/gu)).toHaveLength(1)
    expect(oneShot).toMatch(/×21 · \d{2}:\d{2}–\d{2}:\d{2}/u)
    expect(oneShot).not.toContain("... 16 more")

    const render = createRenderer({ cols: 200, rows: 117 })
    const app = render(
      createElement(QueueWatchFrame, {
        snapshot: { ...story.snapshot, projection: stormProjection },
      }),
    )
    try {
      await app.waitForLayoutStable()
      await app.press("Escape")
      await app.waitForLayoutStable()
      const stormVisibleRows = () =>
        app.text.split("\n").filter((row) => /^\s*\d{2}:\d{2}:\d{2} × env\b/u.test(row) && row.includes("pr#6.1"))
      expect(stormVisibleRows()).toHaveLength(1)
      expect(app.text).toMatch(/×21 · \d{2}:\d{2}–\d{2}:\d{2}/u)

      await app.press("Enter")
      await app.waitForLayoutStable()
      expect(stormVisibleRows()).toHaveLength(21)
      expect(app.text).not.toMatch(/×21 · \d{2}:\d{2}–\d{2}:\d{2}/u)

      await app.press("Enter")
      await app.waitForLayoutStable()
      expect(stormVisibleRows()).toHaveLength(1)
      expect(app.text).toMatch(/×21 · \d{2}:\d{2}–\d{2}:\d{2}/u)
    } finally {
      app.unmount()
    }
  })

  it("expands only the selected occurrence when matching storms are separated", () => {
    const projection = queueTimelineStories["production-overview"].snapshot.projection
    if (projection === undefined) throw new Error("production-overview is missing its projection")
    const environment = projection.rows.find((row) => row.pr === "PR6")
    const separator = projection.rows.find((row) => row.pr !== "PR6" && row.group === "completed")
    if (environment === undefined || separator === undefined) {
      throw new Error("production-overview fixtures are incomplete")
    }
    const row = (id: string) => ({ ...environment, id, run: id })
    const source = [row("A-new"), row("A-old"), separator, row("B-new"), row("B-old")]
    const folded = queueTimelineDisplayRows(source)
    const firstKey = folded[0]?.repeat?.key

    expect(folded.map((entry) => entry.id)).toEqual(["A-new", separator.id, "B-new"])
    expect(firstKey).toBeDefined()
    expect(folded[0]?.repeat?.key).not.toEqual(folded[2]?.repeat?.key)
    const expanded = queueTimelineDisplayRows(source, new Set([firstKey!]))
    expect(expanded.map((entry) => entry.id)).toEqual(["A-new", "A-old", separator.id, "B-new"])
    expect(expanded[3]?.repeat?.collapsed).toBe(true)
  })

  it("keeps the full run noun and fixed fields intact at 80 columns", async () => {
    const rows = (await renderTimeline(contractProjection(), 80)).map((row) => row.trimEnd())
    for (const row of rows) expect(Array.from(row).length).toBeLessThanOrEqual(80)
    const lead = rows[rowIndex(rows, "pr#42.1")]
    expect(lead).toContain("main#42")
    expect(lead).toContain("for @hab/super/21135-herdr-keybindi…")
    expect(lead).not.toContain("2:check")
    expect(lead).toContain("36:00")
    expect(lead).toContain("20:00")
    expect(lead).not.toContain("◷")
    // The BY column is the first casualty on narrow tiers — dropped before
    // any identity, clock, or measurement column.
    expect(lead?.trimStart().startsWith("17:10:00 ● run")).toBe(true)
    expect(lead).not.toContain("@agent/3")
    expect(rows.some((row) => row.includes("BY"))).toBe(false)
    const rejected = rows[rowIndex(rows, "pr#5.1")]
    expect(rejected).toContain("typecheck-failed")
    expect(rejected).toContain("12:00")
    expect(rejected).not.toContain("◷")
  })

  it("pins the 15d semantic colors on markers, states, and identity cells", async () => {
    const render = createRenderer({ cols: 160, rows: 45 })
    const styled = render(createElement(QueueTimelineView, { projection: contractProjection(), columns: 160 }))
    try {
      await styled.waitForLayoutStable()
      const frame = styled.text.split("\n")
      const cell = (needle: string, anchor: string) => {
        const row = frame.findIndex((text) => text.includes(anchor))
        if (row < 0) throw new Error(`missing rendered row for '${anchor}'`)
        const column = frame[row]?.indexOf(needle) ?? -1
        if (column < 0) throw new Error(`missing '${needle}' in the '${anchor}' row`)
        return styled.cell(column, row)
      }
      // Item 9: a not-yet-started run shows a muted "-", not a blue "pending"
      // run id — the blue (info) reference is now the running km task glyph.
      const runningMarker = cell("●", "pr#42.1").fg
      const successMarker = cell("✓", "pr#4.1").fg
      const successText = cell("done", "pr#4.1").fg
      const failureText = cell("typecheck-failed", "pr#5.1").fg
      const mutedTime = cell("16:40:00", "pr#1.1").fg
      const mutedAge = cell("50:00", "pr#1.1").fg

      for (const pinned of [runningMarker, successMarker, successText, failureText, mutedTime, mutedAge]) {
        expect(pinned).not.toBeNull()
      }
      // GREEN success marker + semantic success text (15d re-rule).
      expect(successMarker).toEqual(successText)
      expect(successMarker).not.toEqual(runningMarker)
      expect(successMarker).not.toEqual(mutedTime)
      // Failure code keeps its own semantic foreground.
      expect(failureText).not.toEqual(successMarker)
      expect(failureText).not.toEqual(runningMarker)
      expect(failureText).not.toEqual(mutedTime)
      // TIME and AGE share the muted foreground.
      expect(mutedTime).toEqual(mutedAge)
      expect(mutedTime).not.toEqual(runningMarker)
    } finally {
      styled.unmount()
    }
  })

  it("renders the list left-flush with the 160-cell cap and no dead gutter", async () => {
    const wide = await renderTimeline(contractProjection(), 200)
    // The FLOW + TIME row fills the full capped width with no dead gutter.
    const wideBorder = wide[rowIndex(wide, "╭─ FLOW ")]
    if (wideBorder === undefined) throw new Error("expected the statistics border row")
    expect(wideBorder.startsWith("╭─ FLOW ")).toBe(true)
    expect(wideBorder.trimEnd().length).toBe(160)
    for (const row of wide) expect(Array.from(row.trimEnd()).length).toBeLessThanOrEqual(160)
    // Left-anchored surfaces start at column 0; only right-aligned facts
    // (the updated clock, the bucket checkboxes) carry leading padding. Box
    // borders anchor at column 0 with their rounded corner glyph.
    for (const anchor of ["QUEUE", "16:40:00 ○ todo", "╭─ FLOW"]) {
      expect(wide[rowIndex(wide, anchor)]?.startsWith(anchor.slice(0, 1)), anchor).toBe(true)
    }
    expect(wide[rowIndex(wide, "TIME")]?.indexOf("TIME")).toBe(0)

    const narrow = await renderTimeline(contractProjection(), 100)
    const narrowBorder = narrow[rowIndex(narrow, "╭─ FLOW ")]
    if (narrowBorder === undefined) throw new Error("expected the statistics border row")
    expect(narrowBorder.startsWith("╭─ FLOW ")).toBe(true)
    expect(narrowBorder.trimEnd().length).toBe(100)
  })

  it("contains long raw JSON output inside the detail side of the split divider", async () => {
    const story = queueTimelineStories["production-overview"]
    const sentinel = `JSON_EDGE_SENTINEL ${JSON.stringify({ payload: "¤".repeat(800) })}`
    const snapshot = {
      ...story.snapshot,
      outputs: [
        {
          source: "recorded" as const,
          run: "R42",
          step: "check",
          attempt: 2,
          path: "/repo/.git/yrd/artifacts/R42/1-check/attempt-2/raw.json",
          text: sentinel,
        },
      ],
    }
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      // The detail defaults to the live `check` step (user directive 2026-07-21:
      // tab selection follows the running step, and the synthetic `0: submit`
      // tab is gone), so R42's recorded check output — the sentinel — is visible
      // without navigating tabs.
      const rows = app.text.split("\n")
      const divider = rows[0]?.indexOf("│") ?? -1
      expect(divider).toBeGreaterThan(0)
      const sentinelRows = rows.filter((row) => row.includes("JSON_EDGE_SENTINEL"))
      expect(sentinelRows).toHaveLength(1)
      for (const row of sentinelRows) {
        expect(row.indexOf("JSON_EDGE_SENTINEL")).toBeGreaterThan(divider)
        expect(row.slice(0, divider)).not.toContain("JSON_EDGE_SENTINEL")
        expect(Array.from(row).length).toBeLessThanOrEqual(200)
      }
      const payloadRows = rows.filter((row) => row.includes("¤"))
      expect(payloadRows.length, app.text).toBeGreaterThan(1)
      for (const row of rows) expect(row.slice(0, divider)).not.toContain("¤")
    } finally {
      app.unmount()
    }
  })

  it("attaches the right-aligned pills row directly below the list (item 2)", async () => {
    for (const width of [120, 200]) {
      const rows = await renderTimeline(contractProjection(), width)
      const headerLine = rowIndex(rows, "TIME")
      const pillsLine = rows.findIndex((row) => /todo.*running.*failed.*done/u.test(row))
      // Item 2: the pills row renders BELOW the list, not above the header.
      expect(pillsLine, `width ${width}`).toBeGreaterThan(headerLine)
      const filter = rows[pillsLine]
      if (filter === undefined) throw new Error("expected the pills row")
      // Item 3: no "FILTER" label, no [t] brackets; the `since=` dimension
      // survives and the pills are plain words (pending reads `todo`, user
      // directive 2026-07-21). Right-aligned to the cap.
      expect(filter).not.toContain("FILTER")
      expect(filter).not.toMatch(/\[[trfd]\]/u)
      expect(filter.trim()).toContain("since=6:00:00 todo running failed done")
      expect(filter.trimEnd().length, `width ${width}`).toBe(Math.min(width, 160))
    }
  })

  it("folds the paused STATUS line inside the one RUNNER box with foreground-only styling", async () => {
    const projection = queueTimelineStories.paused.snapshot.projection
    if (projection === undefined) throw new Error("paused story is missing its projection")
    const rows = await renderTimeline(projection, 120)
    const statusLine = rowIndex(rows, "HOLD THE LINE")
    // The pause STATUS line now lives INSIDE the one RUNNER box (user directive
    // 2026-07-21): STATUS, the reason, and the allow-list ride the same row, and
    // there is no separate `╭─ STATUS` border box.
    expect(rows.join("\n")).not.toContain("╭─ STATUS ")
    expect(rows[statusLine]).toContain("STATUS")
    expect(rows[statusLine]).toContain("operator freeze")
    expect(rows[statusLine]).toContain("allowed PR2")
    // The RUNNER box frames it: `╭─ RUNNER ` opens above and `╰` closes below.
    const runnerTop = rowIndex(rows, "╭─ RUNNER ")
    expect(runnerTop).toBeLessThan(statusLine)
    const runnerBottom = rows.findIndex((row, index) => index > statusLine && row.includes("╰"))
    expect(runnerBottom, "the RUNNER box closes below the pause line").toBeGreaterThan(statusLine)
    // It still renders between the metadata clock and the pills row.
    expect(rowIndex(rows, "updated 17:30:00")).toBeLessThan(statusLine)
    const pillsAt = rows.findIndex((row) => /todo.*running.*failed.*done/u.test(row))
    expect(statusLine, "the RUNNER box sits above the pills row").toBeLessThan(pillsAt)

    const render = createRenderer({ cols: 120, rows: 45 })
    const styled = render(createElement(QueueTimelineView, { projection, columns: 120 }))
    try {
      await styled.waitForLayoutStable()
      const row = styled.text.split("\n").findIndex((row) => row.includes("HOLD THE LINE"))
      expect(row).toBeGreaterThan(0)
      const column = styled.text.split("\n")[row]?.indexOf("HOLD") ?? -1
      expect(column).toBeGreaterThan(0)
      for (let offset = 0; offset < 12; offset += 1) {
        expect(styled.cell(column + offset, row).bg, "status styling is foreground-only").toBeNull()
      }
    } finally {
      styled.unmount()
    }
  })

  it("advances the one temporal-trust cue when the snapshot advances", async () => {
    const projection = contractProjection()
    const first = await renderTimeline(projection, 120)
    expect(first.join("\n")).toContain("updated 17:30:00")
    const advanced = { ...projection, now: "2026-07-13T12:01:00.000Z" }
    const second = await renderTimeline(advanced, 120)
    expect(second.join("\n")).toContain("updated 17:31:00")
    expect(second.join("\n")).not.toContain("updated 17:30:00")
  })

  it("shortens terminal state labels at semantic boundaries instead of clipping", async () => {
    const projection = queueTimelineStories["production-overview"].snapshot.projection
    if (projection === undefined) throw new Error("production-overview is missing its projection")
    const rows = (await renderTimeline(projection, 160)).map((row) => row.trimEnd())
    // queue-environment-refused (25 cells) shortens at its last semantic
    // boundary; nothing mid-token, no lost fixed columns.
    const environment = rows[rowIndex(rows, "pr#6.1")]
    expect(environment).toContain("err=queue-environment")
    expect(environment).not.toContain("queue-environment-")
    const canceled = rows[rowIndex(rows, "pr#7.1")]
    expect(canceled).toContain("queue-canceled")
    const integrated = rows[rowIndex(rows, "pr#4.1")]
    expect(integrated).toContain("✓ done")
  })

  it("defaults the cursor to the first running row, else the newest finished row", () => {
    expect(queueTimelineDefaultCursorId(contractProjection().rows)).toBe("main:run:R42:PR42:1")

    const anchored = queueTimelineStories["anchored-new"].snapshot.projection
    if (anchored === undefined) throw new Error("anchored-new is missing its projection")
    expect(queueTimelineDefaultCursorId(anchored.rows)).toBe("main:run:R12:PR12:1")

    const pending = queueTimelineStories["pending-only"].snapshot.projection
    if (pending === undefined) throw new Error("pending-only is missing its projection")
    expect(queueTimelineDefaultCursorId(pending.rows)).toBe(pending.rows[0]?.id)

    expect(queueTimelineDefaultCursorId([])).toBeUndefined()
  })

  it("opens on the default cursor row and keeps manual cursor moves sticky across snapshots", async () => {
    const story = queueTimelineStories["anchored-new"]
    if (story.nextSnapshot === undefined) throw new Error("anchored-new is missing its next snapshot")
    const render = createRenderer({ cols: 200, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: story.snapshot }))
    try {
      await handle.waitForLayoutStable()
      // No running rows: the newest finished run R12 is the default. The detail
      // title is PR-scoped now (user directive 2026-07-21): `pr#12.1` heads the
      // pane, not `RUN main#12` (which moved into the RUN region header below).
      expect(detailTitleRow(handle.text)).toContain("pr#12.1")

      // A manual move is sticky: the arriving newer run R13 must not steal
      // the cursor.
      await handle.press("j")
      await handle.waitForLayoutStable()
      expect(detailTitleRow(handle.text)).toContain("pr#11.1")
      handle.rerender(createElement(QueueWatchFrame, { snapshot: story.nextSnapshot }))
      await handle.waitForLayoutStable()
      expect(detailTitleRow(handle.text)).toContain("pr#11.1")
      expect(detailTitleRow(handle.text)).not.toContain("pr#13.1")
    } finally {
      handle.unmount()
    }

    // A fresh view over the same newer snapshot follows the default again.
    const fresh = createRenderer({ cols: 200, rows: 50 })
    const reopened = fresh(createElement(QueueWatchFrame, { snapshot: story.nextSnapshot }))
    try {
      await reopened.waitForLayoutStable()
      expect(detailTitleRow(reopened.text)).toContain("pr#13.1")
    } finally {
      reopened.unmount()
    }
  })

  it("drops the footer and scopes batched-run detail to the selected PR while listing its run members", async () => {
    const story = queueTimelineStories["contract-overview"]
    const render = createRenderer({ cols: 200, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: story.snapshot }))
    try {
      await handle.waitForLayoutStable()
      const rows = handle.text.split("\n")
      // The bottom keybindings footer row was removed entirely (item h).
      expect(handle.text).not.toContain("q quit")
      expect(handle.text).not.toContain("⇧-drag")
      // The FLOW/TIME boxes still render in the pane's bottom band below
      // the list rows.
      const statistics = rows.findIndex((row) => row.includes("╭─ FLOW "))
      expect(statistics).toBeGreaterThan(0)

      // Default cursor is the batch lead PR42. The detail is PR-scoped now
      // (user directive 2026-07-21, supersedes Round-6 Revision A's per-member
      // run-as-unit blocks): `pr#42.1` heads the pane, PR42's own submit
      // timeline shows, and the run identity `RUN main#42` moved into the RUN
      // region header. The batch membership surfaces there as a `PRs` members
      // row listing both pr#42.1 and pr#43.1 — the partner PR no longer gets its
      // own block or its own submit-timeline line.
      expect(detailTitleRow(handle.text)).toContain("pr#42.1")
      expect(handle.text, "the run identity moved into the RUN region header").toContain("RUN main#42")
      expect(handle.text).toContain("16:54 submitted by @agent/3")
      expect(handle.text, "the RUN region lists every batch member").toMatch(/PRs\b.*pr#42\.1.*pr#43\.1/u)
      expect(handle.text, "the partner PR's own submit timeline is not shown").not.toContain(
        "16:56 submitted by @agent/5",
      )
      expect(handle.text).not.toMatch(/(?:^|\s)(?:▸|•)\s+PRS\b/gmu)
    } finally {
      handle.unmount()
    }
  })

  it("scopes PR detail to member runs and omits unavailable pending placeholders", async () => {
    const result = queueTimelineStories["contract-overview"].snapshot.results[0]
    if (result === undefined) throw new Error("contract-overview is missing its queue result")
    const runs = [...result.running, ...result.waiting, ...result.finished]
    const running = result.prs.find((pr) => pr.id === "PR42")
    const pending = result.prs.find((pr) => pr.id === "PR1")
    if (running === undefined || pending === undefined) throw new Error("contract fixture is missing expected PRs")

    expect(prDetailData(running, runs).runs.map((run) => run.run)).toEqual(["R42"])
    const rendered = await renderString(createElement(PRDetailView, { pr: pending, runs, now: 0, position: 1 }), {
      width: 100,
      height: 20,
      plain: true,
    })
    expect(rendered).not.toContain("RELATED RUNS")
    expect(rendered).not.toContain("No run recorded.")
    expect(rendered).not.toContain("LANDING -")
  })
  it("freezes AGE at the first terminal outcome while open rows keep aging", () => {
    const results = queueTimelineStories["contract-overview"].snapshot.results
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const minute = 60_000
    const at = (snapshotNow: number) =>
      queueTimelineProjection(results, {
        now: snapshotNow,
        windowMs: 6 * 60 * minute,
        statuses: ["pending", "running", "rejected", "integrated", "other"],
        terms: [],
        latest: false,
        rowLimit: 20,
        submissionTimes: queueTimelineAdmissionTimes(results),
      })
    const before = at(now)
    const after = at(now + 5 * minute)
    const facts = (projection: QueueTimelineProjection) =>
      new Map(projection.rows.map((row) => [row.id, { ageMs: row.ageMs, totalMs: row.totalMs }]))
    const b = facts(before)
    const a = facts(after)

    // Terminal rows are frozen at their outcome.
    for (const id of ["main:run:R5:PR5:1", "main:run:R4:PR4:1"]) {
      expect(a.get(id), id).toEqual(b.get(id))
    }
    // Pending and running rows keep aging with canonical start semantics.
    const growing = before.rows.filter((row) => row.group !== "completed").map((row) => row.id)
    expect(growing).toHaveLength(3)
    for (const id of growing) {
      expect(a.get(id)?.ageMs, id).toBe((b.get(id)?.ageMs ?? Number.NaN) + 5 * minute)
    }
    // A running Run's TOTAL is elapsed-so-far; terminal totals never move.
    expect(a.get("main:run:R42:PR42:1")?.totalMs).toBe(
      (b.get("main:run:R42:PR42:1")?.totalMs ?? Number.NaN) + 5 * minute,
    )
  })

  it("keeps fixed-time human and JSON values byte-identical", async () => {
    const projection = contractProjection()
    const rows = (await renderTimeline(projection, 160)).map((row) => row.trimEnd())
    // The documented duration format, reimplemented independently so the test
    // pins the byte contract rather than sharing the implementation.
    const duration = (ms: number): string => {
      const seconds = Math.round(ms / 1_000)
      const hours = Math.floor(seconds / 3_600)
      const minutes = Math.floor((seconds % 3_600) / 60)
      const remainder = String(seconds % 60).padStart(2, "0")
      return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`
    }
    // Queue clocks render in the system-local timezone.
    const wallClock = (iso: string): string => {
      const when = new Date(iso)
      const pad = (value: number) => String(value).padStart(2, "0")
      return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
    }
    const frame = rows.join("\n")
    expect(frame).toContain(`updated ${wallClock(projection.now)}`)
    // The healthy runner fact is visible while STATUS remains absent.
    expect(projection.runner).not.toBeNull()
    expect(frame).toContain("[84042]")
    expect(frame).toContain("╭─ RUNNER ")
    expect(frame).not.toContain("╭─ STATUS ")

    for (const [index, row] of projection.rows.entries()) {
      const rendered = rows[rowIndex(rows, formatQueuePrId(row.pr, row.revision))]
      if (rendered === undefined) throw new Error(`missing rendered row for ${row.id}`)
      const continuation = index > 0 && row.run !== undefined && projection.rows[index - 1]?.run === row.run
      if (row.timestamp !== null && !continuation) expect(rendered, row.id).toContain(wallClock(row.timestamp))
      if (row.submitter !== undefined) expect(rendered, row.id).toContain(row.submitter)
      if (row.issue !== undefined) expect(rendered, row.id).toContain(row.issue)
      else if (row.step !== undefined && !continuation) expect(rendered, row.id).toContain(row.step)
      if (row.ageMs !== null) expect(rendered, row.id).toContain(duration(row.ageMs))
      // Run duration is a bare dimmed time now \u2014 no `\u25f7` glyph (item S).
      if (row.totalMs !== null && !continuation) expect(rendered, row.id).toContain(duration(row.totalMs))
    }
  })

  it("selects whole rows through the canonical primitive with no textual cursor", async () => {
    const story = queueTimelineStories["contract-overview"]
    const render = createRenderer({ cols: 200, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: story.snapshot }))
    try {
      await handle.waitForLayoutStable()
      const frame = handle.text.split("\n")
      expect(frame.some((row) => row.trimStart().startsWith("> "))).toBe(false)

      // Default cursor row (running batch lead) carries the selection
      // background across the whole row; its sibling does not. Scope to actual
      // list rows (they start with a clock) so the DETAIL pane's identity title
      // — which also names the selected PR (item M) — isn't mistaken for a row.
      const isListRow = (row: string): boolean => /^\s*(?:\d{2}:\d{2}:\d{2}|-)\s/u.test(row)
      const cursorRow = frame.findIndex((row) => row.includes("pr#42.1") && isListRow(row))
      const siblingRow = frame.findIndex((row) => row.includes("pr#43.1") && isListRow(row))
      expect(cursorRow).toBeGreaterThan(0)
      expect(siblingRow).toBe(cursorRow + 1)
      const cursorText = frame[cursorRow] ?? ""
      for (const anchor of ["●", "pr#42.1", "@hab/super/21135-herdr-keybindings"]) {
        const column = cursorText.indexOf(anchor)
        expect(column, anchor).toBeGreaterThanOrEqual(0)
        expect(handle.cell(column, cursorRow).bg, `selection bg under ${anchor}`).not.toBeNull()
      }
      const siblingColumn = (frame[siblingRow] ?? "").indexOf("pr#43.1")
      expect(handle.cell(siblingColumn, siblingRow).bg).toBeNull()
    } finally {
      handle.unmount()
    }
  })
})
