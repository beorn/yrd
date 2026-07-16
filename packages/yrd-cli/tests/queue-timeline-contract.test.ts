// @failure Queue list drifts from the user-settled 21106 presentation contract
// @level l2
// @consumer @yrd/cli

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  QueueTimelineView,
  queueTimelineDefaultCursorId,
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

describe("queue timeline 21106 contract", () => {
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
    // RUNNER: probed lease liveness rides the projection for header + JSON.
    expect(projection.runner).toEqual({ pid: 84042, startedAt: "2026-07-13T11:00:00.000Z" })
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

  it("renders the five information groups in the contract order with no status box when normal", async () => {
    const rows = (await renderTimeline(contractProjection(), 120)).map((row) => row.trimEnd())
    const queueLine = rowIndex(rows, "QUEUE")
    const updatedLine = rowIndex(rows, "updated 12:00:00")
    const filterLine = rowIndex(rows, "FILTER ")
    const headerLine = rowIndex(rows, "TIME")
    const lastRowLine = rowIndex(rows, "PR4.1 Land the durable patch")
    const statisticsLine = rowIndex(rows, "STATISTICS")
    const flowLine = rowIndex(rows, "FLOW ")

    expect(queueLine).toBeLessThan(updatedLine)
    expect(updatedLine).toBeLessThan(filterLine)
    expect(filterLine).toBeLessThan(headerLine)
    expect(headerLine).toBeLessThan(lastRowLine)
    expect(lastRowLine).toBeLessThan(statisticsLine)
    expect(statisticsLine).toBeLessThan(flowLine)

    // The status box is omitted when the queue is normal.
    expect(rows.join("\n")).not.toContain("HOLD THE LINE")
    // ACTIVE/WAIT moved out of the per-row columns into the statistics box.
    const header = rows[headerLine]
    if (header === undefined) throw new Error("expected the table header row")
    expect(header.trim()).toMatch(/^TIME\s+RUN\s+BY\s+PR\s+STEP\s+AGE\s+TOTAL$/u)
    expect(header).not.toContain("ACTIVE")
    expect(header).not.toContain("WAIT")
    expect(header).not.toContain("SUBJECT")
    expect(header).not.toContain("DETAIL")
    expect(header).not.toContain("STATUS")
    expect(rows[statisticsLine + 3]).toContain("ACTIVE ALL")
    expect(rows[statisticsLine + 5]).toContain("WAIT")
  })

  it("renders the user-settled row contract at 160 columns", async () => {
    const rows = (await renderTimeline(contractProjection(), 160)).map((row) => row.trimEnd())
    const pending = rows[rowIndex(rows, "PR1.1")]
    const lead = rows[rowIndex(rows, "PR42.1")]
    const partner = rows[rowIndex(rows, "PR43.1")]
    const rejected = rows[rowIndex(rows, "PR5.1")]
    const integrated = rows[rowIndex(rows, "PR4.1")]

    expect(pending?.trim()).toMatch(/^○ 11:10:00\s+@cto\s+PR1\.1 Prepare release notes\s+50:00$/u)
    expect(lead?.trim()).toMatch(
      /^● 11:40:00 main#42 @agent\/3 PR42\.1 Align host navigation keybindings without disturbing internal pane controls\s+2:check\s+36:00 ◷20:00$/u,
    )
    expect(partner?.trim()).toMatch(
      /^● 11:40:00 main#42 @agent\/5 PR43\.1 Carry the production split-pane contract into the queue detail surface\s+2:check\s+34:00 ◷20:00$/u,
    )
    expect(rejected?.trim()).toMatch(
      /^× 11:12:00 main#5\s+@agent\/2 PR5\.1 Reject broken payload\s+typecheck-failed\s+27:00 ◷12:00$/u,
    )
    expect(integrated?.trim()).toMatch(
      /^✓ 10:55:00 main#4\s+@agent\/7 PR4\.1 Land the durable patch\s+integrated\s+25:00 ◷15:00$/u,
    )

    // Fixed cells stay aligned: the clock glyph column is shared by every
    // row that has a total.
    const glyphColumns = [lead, partner, rejected, integrated].map((row) => row?.indexOf("◷"))
    expect(new Set(glyphColumns).size).toBe(1)
    // The pending row has no Run yet: no run id, no step, no total.
    expect(pending).not.toContain("#")
    expect(pending).not.toContain("◷")
  })

  it("falls back to the compact #run form and keeps fixed fields intact at 80 columns", async () => {
    const rows = (await renderTimeline(contractProjection(), 80)).map((row) => row.trimEnd())
    for (const row of rows) expect(Array.from(row).length).toBeLessThanOrEqual(80)
    const lead = rows[rowIndex(rows, "PR42.1")]
    expect(lead).toContain("#42")
    expect(lead).not.toContain("main#42")
    expect(lead).toContain("2:check")
    expect(lead).toContain("36:00")
    expect(lead).toContain("◷20:00")
    // The BY column is the first casualty on narrow tiers — dropped before
    // any identity, clock, or measurement column.
    expect(lead).not.toContain("@agent/3")
    expect(rows.some((row) => row.includes("BY"))).toBe(false)
    const rejected = rows[rowIndex(rows, "PR5.1")]
    expect(rejected).toContain("typecheck-failed")
    expect(rejected).toContain("◷12:00")
  })

  it("shows runner liveness in the header and renders a probed absence loudly", async () => {
    const projection = contractProjection()
    const present = (await renderTimeline(projection, 120)).map((row) => row.trimEnd())
    const runnerRow = present[rowIndex(present, "RUNNER")]
    expect(runnerRow).toContain("RUNNER yrd-cli:84042")
    expect(runnerRow).toContain("up 1:00:00")
    expect(runnerRow).toContain("lease live")
    expect(runnerRow).toContain("updated 12:00:00")

    // Probed and nobody holds the lease: loud, never blank.
    const paused = queueTimelineStories.paused.snapshot.projection
    if (paused === undefined) throw new Error("paused story is missing its projection")
    expect(paused.runner).toBeNull()
    const absent = (await renderTimeline(paused, 120)).join("\n")
    expect(absent).toContain("RUNNER none — nothing drains this queue")

    // An unprobed host omits the fact instead of claiming absence.
    const { runner: _unused, ...unprobed } = projection
    const silent = (await renderTimeline(unprobed as QueueTimelineProjection, 120)).join("\n")
    expect(silent).not.toContain("RUNNER")
  })

  it("caps the content surface at 160 cells with one-cell side padding and centers wider viewports", async () => {
    const wide = await renderTimeline(contractProjection(), 200)
    const wideBorder = wide[rowIndex(wide, "╭")]
    if (wideBorder === undefined) throw new Error("expected the statistics border row")
    expect(wideBorder.slice(0, 20).trim()).toBe("")
    expect(wideBorder.trimEnd().length).toBe(180)
    expect(Array.from(wideBorder.trim()).length).toBe(160)
    for (const row of wide) expect(Array.from(row.trimEnd()).length).toBeLessThanOrEqual(180)

    const narrow = await renderTimeline(contractProjection(), 100)
    const narrowBorder = narrow[rowIndex(narrow, "╭")]
    if (narrowBorder === undefined) throw new Error("expected the statistics border row")
    expect(narrowBorder.trimEnd().length).toBe(99)
    expect(Array.from(narrowBorder.trim()).length).toBe(98)
  })

  it("attaches the right-aligned FILTER row directly above the list", async () => {
    for (const width of [120, 200]) {
      const rows = await renderTimeline(contractProjection(), width)
      const filterLine = rowIndex(rows, "FILTER ")
      const header = rows[filterLine + 1]
      expect(header, `width ${width}`).toContain("TIME")
      const filter = rows[filterLine]
      if (filter === undefined) throw new Error("expected the FILTER row")
      expect(filter.trim()).toBe("FILTER since=6:00:00 status=all terms=none latest=no")
      const contentRight = width >= 162 ? (width + 160) / 2 : width - 1
      expect(filter.trimEnd().length, `width ${width}`).toBe(contentRight)
    }
  })

  it("renders paused queues as a foreground-only STATUS box between metadata and filter", async () => {
    const projection = queueTimelineStories.paused.snapshot.projection
    if (projection === undefined) throw new Error("paused story is missing its projection")
    const rows = await renderTimeline(projection, 120)
    const statusLine = rowIndex(rows, "HOLD THE LINE")
    expect(rows[statusLine]).toContain("STATUS")
    expect(rows[statusLine]).toContain("operator freeze")
    expect(rows[statusLine]).toContain("allowed PR2")
    expect(rowIndex(rows, "updated 12:00:00")).toBeLessThan(statusLine)
    expect(statusLine).toBeLessThan(rowIndex(rows, "FILTER "))

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
    expect(first.join("\n")).toContain("updated 12:00:00")
    const advanced = { ...projection, now: "2026-07-13T12:01:00.000Z" }
    const second = await renderTimeline(advanced, 120)
    expect(second.join("\n")).toContain("updated 12:01:00")
    expect(second.join("\n")).not.toContain("updated 12:00:00")
  })

  it("shortens terminal state labels at semantic boundaries instead of clipping", async () => {
    const projection = queueTimelineStories["production-overview"].snapshot.projection
    if (projection === undefined) throw new Error("production-overview is missing its projection")
    const rows = (await renderTimeline(projection, 160)).map((row) => row.trimEnd())
    // queue-environment-refused (25 cells) shortens at its last semantic
    // boundary; nothing mid-token, no lost fixed columns.
    const environment = rows[rowIndex(rows, "PR6.1")]
    expect(environment).toContain("queue-environment")
    expect(environment).not.toContain("queue-environment-")
    const canceled = rows[rowIndex(rows, "PR7.1")]
    expect(canceled).toContain("queue-canceled")
    const integrated = rows[rowIndex(rows, "PR4.1")]
    expect(integrated).toContain("integrated")
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
    const handle = render(createElement(QueueWatchFrame, { snapshot: story.snapshot, paused: false }))
    try {
      await handle.waitForLayoutStable()
      // No running rows: the newest finished run R12 is the default.
      expect(handle.text).toContain("PRs PR12")

      // A manual move is sticky: the arriving newer run R13 must not steal
      // the cursor.
      await handle.press("j")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PRs PR11")
      handle.rerender(createElement(QueueWatchFrame, { snapshot: story.nextSnapshot, paused: false }))
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PRs PR11")
      expect(handle.text).not.toContain("PRs PR13")
    } finally {
      handle.unmount()
    }

    // A fresh view over the same newer snapshot follows the default again.
    const fresh = createRenderer({ cols: 200, rows: 50 })
    const reopened = fresh(createElement(QueueWatchFrame, { snapshot: story.nextSnapshot, paused: false }))
    try {
      await reopened.waitForLayoutStable()
      expect(reopened.text).toContain("PRs PR13")
    } finally {
      reopened.unmount()
    }
  })

  it("keeps the keybindings footer last and the batched detail highlighting the selected member", async () => {
    const story = queueTimelineStories["contract-overview"]
    const render = createRenderer({ cols: 200, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: story.snapshot, paused: false }))
    try {
      await handle.waitForLayoutStable()
      const rows = handle.text.split("\n")
      const footer = rows.findLastIndex((row) => row.includes("q quit"))
      expect(footer).toBeGreaterThan(0)
      expect(rows.slice(footer + 1).every((row) => row.trim() === "")).toBe(true)
      expect(rows[footer]).toContain("p pause")
      const statistics = rows.findIndex((row) => row.includes("STATISTICS"))
      expect(statistics).toBeGreaterThan(0)
      expect(statistics).toBeLessThan(footer)

      // Default cursor is the batch lead; the shared Run detail names every
      // member and highlights the selected one.
      expect(handle.text).toContain("PRs PR42@r1")
      const detailRow = handle.text.split("\n").findIndex((row) => row.includes("PRs PR42@r1"))
      const leadColumn = handle.text.split("\n")[detailRow]?.indexOf("PR42@r1") ?? -1
      expect(handle.cell(leadColumn, detailRow).bold).toBe(true)

      await handle.press("j")
      await handle.waitForLayoutStable()
      const partnerRow = handle.text.split("\n").findIndex((row) => row.includes("PR43@r1"))
      const partnerColumn = handle.text.split("\n")[partnerRow]?.indexOf("PR43@r1") ?? -1
      expect(handle.cell(partnerColumn, partnerRow).bold).toBe(true)
    } finally {
      handle.unmount()
    }
  })
})
