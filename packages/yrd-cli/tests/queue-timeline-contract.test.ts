// @failure Queue list drifts from the user-settled 21106 presentation contract
// @level l2
// @consumer @yrd/cli

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { renderString } from "silvery"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  QueueTimelineView,
  PRDetailView,
  queueTimelineAdmissionTimes,
  queueTimelineDefaultCursorId,
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

  it("renders the five information groups in the contract order with no status box when normal", async () => {
    const rows = (await renderTimeline(contractProjection(), 120)).map((row) => row.trimEnd())
    const queueLine = rowIndex(rows, "QUEUE")
    const updatedLine = rowIndex(rows, "updated 17:30:00")
    const headerLine = rowIndex(rows, "TIME")
    const lastRowLine = rowIndex(rows, "PR4.1")
    // Item 2 (deliberate contract change): the pills row moved from ABOVE the
    // header to BELOW the list — new order updated → header → rows → pills →
    // time-stats (the FLOW box heads r9's windowed TimeStatsBox grid).
    const pillsLine = rows.findIndex((row) => /pending.*running.*failed.*done/u.test(row))
    const flowBoxLine = rowIndex(rows, "FLOW")

    expect(queueLine).toBeLessThan(updatedLine)
    expect(updatedLine).toBeLessThan(headerLine)
    expect(headerLine).toBeLessThan(lastRowLine)
    expect(lastRowLine).toBeLessThan(pillsLine)
    expect(pillsLine).toBeLessThan(flowBoxLine)

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
    // The standing RUNNER box (user respec 2026-07-15) renders the healthy
    // runner fact exactly once: `[pid] <command>` plus a right-aligned uptime.
    const runnerLine = rowIndex(rows, "[84042]")
    expect(rows[runnerLine]).toContain("uptime 01:00")
    expect(rowIndex(rows, "RUNNER")).toBeLessThan(runnerLine)
    expect(rows.join("\n")).not.toContain("NO RUNNER")
    expect(rows.join("\n")).not.toContain("RUNNER STALE")
    expect(rows.join("\n")).not.toContain("oldest open")
    // The windowed TimeStatsBox grid (respec item 6) replaces the single STATS
    // box: a FLOW throughput box plus TIME INTEGRATED / TIME FAILED / TIME WAIT
    // duration boxes, each headed by the rolling windows HR / DAY / WK / MON.
    const statisticsText = rows.slice(flowBoxLine).join("\n")
    for (const cell of ["RUNS", "INTEGRATED", "FAILS", "TIME WAIT", "AVG", "p90"]) {
      expect(statisticsText).toContain(cell)
    }
    for (const window of ["HR", "DAY", "WK", "MON"]) expect(statisticsText).toContain(window)
  })

  it("renders the user-settled row contract at 160 columns", async () => {
    const rows = (await renderTimeline(contractProjection(), 160)).map((row) => row.trimEnd())
    const pending = rows[rowIndex(rows, "PR1.1")]
    const lead = rows[rowIndex(rows, "PR42.1")]
    const partner = rows[rowIndex(rows, "PR43.1")]
    const rejected = rows[rowIndex(rows, "PR5.1")]
    const integrated = rows[rowIndex(rows, "PR4.1")]

    // Row contract (user directive 2026-07-16): STEP folded into the flexible
    // cell as `<branch-glyph> <branch> (<status>)` (item Q); BY left-aligned
    // (item R); run duration is a bare dimmed time — no `◷` glyph (item S). The
    // branch glyph (U+E0A0) is matched as one non-space char.
    expect(pending?.trim()).toMatch(/^16:40:00 ○ pend\s+-\s+PR1\.1\s+\S topic\/pr1\s+@cto\s+50:00$/u)
    expect(lead?.trim()).toMatch(
      /^17:10:00 ● run\s+main#42 PR42\.1\s+\S topic\/pr42 \(2:check\)\s+@agent\/3 36:00 20:00$/u,
    )
    expect(partner?.trim()).toMatch(
      /^17:10:00 ● run\s+main#42 PR43\.1\s+\S topic\/pr43 \(2:check\)\s+@agent\/5 34:00 20:00$/u,
    )
    expect(rejected?.trim()).toMatch(
      /^16:42:00 × fail\s+main#5\s+PR5\.1\s+\S topic\/pr5 \(typecheck-failed\)\s+@agent\/2 27:00 12:00$/u,
    )
    expect(integrated?.trim()).toMatch(/^16:25:00 ✓ done\s+main#4\s+PR4\.1\s+\S topic\/pr4\s+@agent\/7 25:00 15:00$/u)

    // No row carries the removed clock glyph, and a not-yet-started run shows a
    // muted "-" in the RUN cell (item 9) instead of a run id, no run duration.
    for (const row of [pending, lead, partner, rejected, integrated]) expect(row).not.toContain("◷")
    expect(pending).not.toContain("#")
  })

  it("falls back to the compact #run form and keeps fixed fields intact at 80 columns", async () => {
    const rows = (await renderTimeline(contractProjection(), 80)).map((row) => row.trimEnd())
    for (const row of rows) expect(Array.from(row).length).toBeLessThanOrEqual(80)
    const lead = rows[rowIndex(rows, "PR42.1")]
    expect(lead).toContain("#42")
    expect(lead).not.toContain("main#42")
    expect(lead).toContain("2:check")
    expect(lead).toContain("36:00")
    expect(lead).toContain("20:00")
    expect(lead).not.toContain("◷")
    // The BY column is the first casualty on narrow tiers — dropped before
    // any identity, clock, or measurement column.
    expect(lead?.trimStart().startsWith("17:10:00 ● run")).toBe(true)
    expect(lead).not.toContain("@agent/3")
    expect(rows.some((row) => row.includes("BY"))).toBe(false)
    const rejected = rows[rowIndex(rows, "PR5.1")]
    expect(rejected).toContain("typecheck-failed")
    expect(rejected).toContain("12:00")
    expect(rejected).not.toContain("◷")
  })

  it("renders runner states once, loudly, in the RUNNER box", async () => {
    const projection = contractProjection()
    // Healthy heartbeat: the RUNNER box carries `[pid]` + uptime, no alarms.
    const healthy = (await renderTimeline(projection, 120)).join("\n")
    expect(healthy).toContain("[84042]")
    expect(healthy).toContain("uptime 01:00")
    expect(healthy).not.toContain("NO RUNNER")

    // No heartbeat at all: loud, never blank, in the box above the filter.
    const paused = queueTimelineStories.paused.snapshot.projection
    if (paused === undefined) throw new Error("paused story is missing its projection")
    expect(paused.runner).toBeNull()
    const absentRows = await renderTimeline(paused, 120)
    expect(absentRows.join("\n")).toMatch(/NO RUNNER - (queue last drained .+ ago|no drained run in window)/u)
    const pillsAt = absentRows.findIndex((row) => /pending.*running.*failed.*done/u.test(row))
    expect(rowIndex(absentRows, "NO RUNNER"), "the RUNNER box is above the pills row").toBeLessThan(pillsAt)

    // A heartbeat older than the stale threshold is equally loud.
    const stale = {
      ...projection,
      runner: { pid: 84042, startedAt: "2026-07-13T11:00:00.000Z", lastTickAt: "2026-07-13T11:00:00.000Z" },
    }
    const staleFrame = (await renderTimeline(stale, 120)).join("\n")
    expect(staleFrame).toContain("RUNNER STALE — last tick 1:00:00 ago")
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
      // run id — the blue (info) reference is now the running working disc.
      const runningMarker = cell("●", "PR42.1").fg
      const successMarker = cell("✓", "PR4.1").fg
      const successText = cell("done", "PR4.1").fg
      const failureText = cell("typecheck-failed", "PR5.1").fg
      const mutedTime = cell("16:40:00", "PR1.1").fg
      const mutedAge = cell("50:00", "PR1.1").fg

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
    // The windowed TimeStatsBox grid fills the full capped width with no dead
    // gutter. The leading FLOW box opens with a rounded top-left corner
    // `╭─ FLOW `, and the whole box row (four boxes side by side) spans the cap.
    const wideBorder = wide[rowIndex(wide, "FLOW")]
    if (wideBorder === undefined) throw new Error("expected the statistics border row")
    expect(wideBorder.startsWith("╭─ FLOW ")).toBe(true)
    expect(wideBorder.trimEnd().length).toBe(160)
    for (const row of wide) expect(Array.from(row.trimEnd()).length).toBeLessThanOrEqual(160)
    // Left-anchored surfaces start at column 0; only right-aligned facts
    // (the updated clock, the bucket checkboxes) carry leading padding. Box
    // borders anchor at column 0 with their rounded corner glyph.
    for (const anchor of ["QUEUE", "16:40:00 ○ pend", "╭─ RUNNER", "│ RUNS"]) {
      expect(wide[rowIndex(wide, anchor)]?.startsWith(anchor.slice(0, 1)), anchor).toBe(true)
    }
    expect(wide[rowIndex(wide, "TIME")]?.indexOf("TIME")).toBe(0)

    const narrow = await renderTimeline(contractProjection(), 100)
    const narrowBorder = narrow[rowIndex(narrow, "FLOW")]
    if (narrowBorder === undefined) throw new Error("expected the statistics border row")
    expect(narrowBorder.startsWith("╭─ FLOW ")).toBe(true)
    expect(narrowBorder.trimEnd().length).toBe(100)
  })

  it("attaches the right-aligned pills row directly below the list (item 2)", async () => {
    for (const width of [120, 200]) {
      const rows = await renderTimeline(contractProjection(), width)
      const headerLine = rowIndex(rows, "TIME")
      const pillsLine = rows.findIndex((row) => /pending.*running.*failed.*done/u.test(row))
      // Item 2: the pills row renders BELOW the list, not above the header.
      expect(pillsLine, `width ${width}`).toBeGreaterThan(headerLine)
      const filter = rows[pillsLine]
      if (filter === undefined) throw new Error("expected the pills row")
      // Item 3: no "FILTER" label, no [p] brackets; the `since=` dimension
      // survives and the pills are plain words. Right-aligned to the cap.
      expect(filter).not.toContain("FILTER")
      expect(filter).not.toMatch(/\[[prfd]\]/u)
      expect(filter.trim()).toContain("since=6:00:00 pending running failed done")
      expect(filter.trimEnd().length, `width ${width}`).toBe(Math.min(width, 160))
    }
  })

  it("renders paused queues as a foreground-only STATUS box between metadata and filter", async () => {
    const projection = queueTimelineStories.paused.snapshot.projection
    if (projection === undefined) throw new Error("paused story is missing its projection")
    const rows = await renderTimeline(projection, 120)
    const statusLine = rowIndex(rows, "HOLD THE LINE")
    // Title-in-border chrome: the STATUS name sits on the border row above.
    expect(rows[statusLine - 1]).toContain("STATUS")
    expect(rows[statusLine]).toContain("operator freeze")
    expect(rows[statusLine]).toContain("allowed PR2")
    expect(rowIndex(rows, "updated 17:30:00")).toBeLessThan(statusLine)
    const pillsAt = rows.findIndex((row) => /pending.*running.*failed.*done/u.test(row))
    expect(statusLine, "the STATUS box sits above the pills row").toBeLessThan(pillsAt)

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
    const environment = rows[rowIndex(rows, "PR6.1")]
    expect(environment).toContain("queue-environment")
    expect(environment).not.toContain("queue-environment-")
    const canceled = rows[rowIndex(rows, "PR7.1")]
    expect(canceled).toContain("queue-canceled")
    const integrated = rows[rowIndex(rows, "PR4.1")]
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
      // No running rows: the newest finished run R12 is the default.
      expect(handle.text).toContain("PRs PR12")

      // A manual move is sticky: the arriving newer run R13 must not steal
      // the cursor.
      await handle.press("j")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PRs PR11")
      handle.rerender(createElement(QueueWatchFrame, { snapshot: story.nextSnapshot }))
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PRs PR11")
      expect(handle.text).not.toContain("PRs PR13")
    } finally {
      handle.unmount()
    }

    // A fresh view over the same newer snapshot follows the default again.
    const fresh = createRenderer({ cols: 200, rows: 50 })
    const reopened = fresh(createElement(QueueWatchFrame, { snapshot: story.nextSnapshot }))
    try {
      await reopened.waitForLayoutStable()
      expect(reopened.text).toContain("PRs PR13")
    } finally {
      reopened.unmount()
    }
  })

  it("drops the bottom keybindings footer and highlights the selected batched member", async () => {
    const story = queueTimelineStories["contract-overview"]
    const render = createRenderer({ cols: 200, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: story.snapshot }))
    try {
      await handle.waitForLayoutStable()
      const rows = handle.text.split("\n")
      // The bottom keybindings footer row was removed entirely (item h).
      expect(handle.text).not.toContain("q quit")
      expect(handle.text).not.toContain("⇧-drag")
      // The windowed TimeStatsBox grid still renders — it leads with a bordered
      // FLOW box (there is no "STATS" label), and with the footer gone it sits in
      // the pane's bottom band below the list rows.
      const statistics = rows.findIndex((row) => row.includes("FLOW"))
      expect(statistics).toBeGreaterThan(0)

      // Default cursor is the batch lead; the shared Run detail (agent8's
      // step-tabs composition) names every member of the batch.
      expect(handle.text).toContain("PRs PR42@r1")
      expect(handle.text).toContain("PR43@r1")
      const members = rows.findIndex((row) => row.includes("PRs PR42@r1"))
      const lead = rows[members]?.indexOf("PR42") ?? -1
      const sibling = rows[members]?.indexOf("PR43") ?? -1
      expect(handle.cell(lead, members).bold).toBe(true)
      expect(handle.cell(sibling, members).bold).toBe(false)
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
    // The healthy runner fact renders once, in the standing RUNNER box.
    expect(projection.runner).not.toBeNull()
    expect(frame).toContain("[84042]")

    for (const row of projection.rows) {
      const rendered = rows[rowIndex(rows, `${row.pr}.${row.revision}`)]
      if (rendered === undefined) throw new Error(`missing rendered row for ${row.id}`)
      if (row.timestamp !== null) expect(rendered, row.id).toContain(wallClock(row.timestamp))
      if (row.submitter !== undefined) expect(rendered, row.id).toContain(row.submitter)
      if (row.step !== undefined) expect(rendered, row.id).toContain(row.step)
      if (row.ageMs !== null) expect(rendered, row.id).toContain(duration(row.ageMs))
      // Run duration is a bare dimmed time now \u2014 no `\u25f7` glyph (item S).
      if (row.totalMs !== null) expect(rendered, row.id).toContain(duration(row.totalMs))
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
      const isListRow = (row: string): boolean => /^\s*\d{2}:\d{2}:\d{2}/u.test(row)
      const cursorRow = frame.findIndex((row) => row.includes("PR42.1") && isListRow(row))
      const siblingRow = frame.findIndex((row) => row.includes("PR43.1") && isListRow(row))
      expect(cursorRow).toBeGreaterThan(0)
      expect(siblingRow).toBe(cursorRow + 1)
      const cursorText = frame[cursorRow] ?? ""
      for (const anchor of ["\u25cf", "PR42.1", "2:check"]) {
        const column = cursorText.indexOf(anchor)
        expect(column, anchor).toBeGreaterThanOrEqual(0)
        expect(handle.cell(column, cursorRow).bg, `selection bg under ${anchor}`).not.toBeNull()
      }
      const siblingColumn = (frame[siblingRow] ?? "").indexOf("PR43.1")
      expect(handle.cell(siblingColumn, siblingRow).bg).toBeNull()
    } finally {
      handle.unmount()
    }
  })
})
