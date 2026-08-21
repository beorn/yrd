/**
 * 21106 interaction/chrome slice — chrome contract.
 *
 * Covers the user-settled chrome respec (2026-07-15 live-pane review wave):
 * shared header/row column geometry (fixed TIME/STATUS/RUN + flex PR +
 * right-anchored STEP/BY/AGE/RUN cells), split RUN and PR header labels,
 * muted run ids, the RUNNER box (its top border carries a uptime/downtime
 * timer and the queue-pause STATUS line folds inside it — the separate STATUS
 * box is gone, user directive 2026-07-21), bottom-aligned STATS, pane
 * frames with padding, selection color forcing, the open/failed/done status
 * vocabulary, and the non-default-only FILTER row.
 */

import { act, createElement } from "react"
import { run } from "silvery/runtime"
import { createRenderer, createTermless, waitFor } from "silvery/test"
import { describe, expect, it } from "vitest"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS,
  QueueTimelineView,
  queueHealthMarker,
  type QueueStatusResult,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")

function rowIndexOf(text: string, needle: string): number {
  return text.split("\n").findIndex((row) => row.includes(needle))
}

// The converged status words also appear in the STATUS notice above the
// timeline, so a cursor-row lookup must be scoped to timestamped timeline rows.
function timelineRowIndexOf(text: string, needle: string): number {
  return text.split("\n").findIndex((row) => row.includes(needle) && /^\s*\d{2}:\d{2}:\d{2}/u.test(row))
}

function rowAt(text: string, index: number): string {
  const row = text.split("\n")[index]
  if (row === undefined) throw new Error(`no rendered row ${index}`)
  return row
}

/** The status-pills row (no more "FILTER" label; the four plain-word pills
 *  share one row with any non-default dimensions). `all` moved to the top
 *  line's queue-pill group (operator ruling 2026-08-18, item 32). */
function pillsRow(text: string): string {
  const found = text.split("\n").find((row) => /open.*running.*done.*failed/u.test(row))
  if (found === undefined) throw new Error("no pills row")
  return found
}

/** mediaDuration display format (H:MM:SS / M:SS) for expected-age assertions. */
function clockDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = String(seconds % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`
}

function queuedEligibility(pr: string, position: number) {
  return {
    pr,
    revision: 1,
    runnable: false,
    review: { required: false, approved: true, stale: false },
    checks: { status: "queued" as const, position, queuedAt: "2026-07-13T11:16:00.000Z" },
  }
}

describe("queue timeline chrome 21106", () => {
  it("keeps the legacy unprojected dashboard's exact ROOT row per repository", async () => {
    // The legacy (no-projection) path still prints its QUEUE/ROOT summary
    // rows; the path routes through the friendly formatter (item 33).
    const headers: string[] = []
    for (const root of ["/hh", "/hh/pm"] as const) {
      using term = createTermless({ cols: 40, rows: 40 })
      const source = queueTimelineStories["production-overview"].snapshot
      const handle = await act(async () => {
        const mounted = await run(
          createElement(QueueWatchFrame, {
            snapshot: { repositoryRoot: root, results: source.results, state: source.state, now: source.now },
          }),
          term,
          { mouse: false, selection: false },
        )
        await mounted.waitForLayoutStable()
        return mounted
      })
      try {
        const frame = term.screen.getText()
        expect.soft(frame, `${root} summary names its root`).toContain(`ROOT ${root}`)
        headers.push(frame.split("\n").find((row) => row.includes("ROOT ")) ?? "")
      } finally {
        await act(async () => {
          handle.unmount()
        })
      }
    }
    expect(headers[0]).not.toBe(headers[1])
  })

  it("carries the projected repository identity on the top-line pill, distinguishable per root", async () => {
    // Items 30/32b/33: the `QUEUE main` / `ROOT /hh` header row is deleted —
    // the one-shot print leads with the YRD QUEUES top line whose pill
    // carries `path ⎇ branch` through the one friendly-path formatter.
    const headers: string[] = []
    // The pill shows the SHORTEST UNIQUE friendly path (item 32b): a lone
    // `/hh/pm` shortens to its unique suffix `pm`.
    for (const [root, shown] of [
      ["/hh", "/hh"],
      ["/hh/pm", "pm"],
    ] as const) {
      using term = createTermless({ cols: 60, rows: 40 })
      const handle = await act(async () => {
        const mounted = await run(
          createElement(QueueTimelineView, {
            repositoryRoot: root,
            projection: queueTimelineStories["contract-overview"].snapshot.projection,
            columns: 60,
          }),
          term,
          { mouse: false, selection: false },
        )
        await mounted.waitForLayoutStable()
        return mounted
      })
      try {
        const frame = term.screen.getText()
        const topRow = frame.split("\n")[0] ?? ""
        expect.soft(topRow, `${root} top line title`).toContain("YRD QUEUES")
        expect.soft(topRow, `${root} pill carries the path ⎇ branch pair`).toContain(`${shown} ⎇ main`)
        // Item 36: the list's queue rows lead with label + typeable FQN —
        // base-labeled here, no config handle declared.
        expect.soft(frame, `${root} queue row leads with label + FQN`).toContain(`main  ${root}@main`)
        expect.soft(frame, `${root} old ROOT row is deleted`).not.toContain("ROOT ")
        expect.soft(frame, `${root} old QUEUE header is deleted`).not.toContain("QUEUE main")
        // The muted `updated HH:MM:SS` stamp survives on its own row, never
        // on the top line (item 30's sub-point).
        expect.soft(topRow).not.toMatch(/updated \d{2}:\d{2}:\d{2}/u)
        expect.soft(frame).toMatch(/updated \d{2}:\d{2}:\d{2}/u)
        headers.push(topRow)
      } finally {
        await act(async () => {
          handle.unmount()
        })
      }
    }
    expect(headers[0]).not.toBe(headers[1])
  })

  it("survives a 12-column live pane with the RUNNER chrome intact", async () => {
    // Narrow panes cannot fit the pill text; the frame must still render its
    // downstream chrome rather than overflow (the old exact-ROOT pin moved
    // to the wider test above when the pills took over the identity).
    const source = queueTimelineStories.paused.snapshot
    using term = createTermless({ cols: 12, rows: 24 })
    const handle = await act(async () => {
      const mounted = await run(
        createElement(QueueTimelineView, {
          repositoryRoot: "/hh",
          projection: source.projection,
          results: source.results,
          state: source.state,
          columns: 12,
          paneChrome: true,
          fillHeight: true,
          nav: true,
          availableRows: 24,
        }),
        term,
        { mouse: false, selection: false },
      )
      await mounted.waitForLayoutStable()
      return mounted
    })
    try {
      const frame = term.screen.getText()
      for (const witness of ["RUNNER", "TIME", "│ $"]) {
        expect.soft(frame, `${witness} witness`).toContain(witness)
      }
    } finally {
      await act(async () => {
        handle.unmount()
      })
    }
  })

  it("header and row cells share one column geometry with nav on at 120 cols", async () => {
    const projection = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: true, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      for (const cell of ["time", "status", "run", "pr", "by", "age", "dur"]) {
        const header = app.locator(`#th-${cell}`).boundingBox()
        expect(header, `header cell th-${cell}`).not.toBeNull()
        const cells = app.locator(`[id^='td-${cell}-']`)
        const count = cells.count()
        expect(count, `td-${cell} row cells`).toBeGreaterThan(2)
        for (let index = 0; index < count; index += 1) {
          const box = cells.nth(index).boundingBox()
          expect(box?.x, `column '${cell}' row ${index} x-offset`).toBe(header?.x)
        }
      }
      // Split header labels: RUN and CHANGES are separate labels, each over
      // its own column — no merged RUN·CHANGES header.
      expect(app.text).not.toContain("RUN·CHANGES")
      const headerY = rowIndexOf(app.text, "TIME")
      const headerLine = rowAt(app.text, headerY)
      expect(headerLine).toContain("RUN")
      expect(headerLine).toContain("CHANGES")

      // One renderer, two modes (user contract 2026-07-16): the one-shot
      // (nav off) render must be layout-identical to the live (nav on)
      // first frame — same column x-offsets. This permanently kills the
      // "tests pass one-shot, breaks live" nav-wrapper divergence class.
      const oneShot = createRenderer({ cols: 120, rows: 40 })(
        createElement(QueueTimelineView, { projection, nav: false, columns: 120 }),
      )
      try {
        await oneShot.waitForLayoutStable()
        for (const cell of ["time", "status", "run", "pr", "by", "age", "dur"]) {
          const live = app.locator(`#th-${cell}`).boundingBox()
          const plain = oneShot.locator(`#th-${cell}`).boundingBox()
          expect(plain?.x, `one-shot '${cell}' header x`).toBe(live?.x)
          const liveCells = app.locator(`[id^='td-${cell}-']`)
          const plainCells = oneShot.locator(`[id^='td-${cell}-']`)
          expect(plainCells.count(), `one-shot '${cell}' cell count`).toBe(liveCells.count())
          for (let index = 0; index < plainCells.count(); index += 1) {
            expect(plainCells.nth(index).boundingBox()?.x, `one-shot '${cell}' row ${index} x`).toBe(
              liveCells.nth(index).boundingBox()?.x,
            )
          }
        }
      } finally {
        oneShot.unmount()
      }
    } finally {
      app.unmount()
    }
  })

  it("renders the column header white+bold, the PR id always bold, and no blank row above the header", async () => {
    const projection = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 160 }))
    try {
      await app.waitForLayoutStable()
      const text = app.text
      // E: the column header is white (default fg, not muted) AND bold.
      const headerY = rowIndexOf(text, "STATUS")
      const timeHeaderX = rowAt(text, headerY).indexOf("TIME")
      expect(app.cell(timeHeaderX, headerY).bold, "header TIME is bold").toBe(true)
      const mutedRowY = rowIndexOf(text, "pr#4.1")
      const mutedTimeX = rowAt(text, mutedRowY).search(/\d{2}:\d{2}:\d{2}/u)
      expect(app.cell(timeHeaderX, headerY).fg, "header fg is brighter than the muted row TIME").not.toEqual(
        app.cell(mutedTimeX, mutedRowY).fg,
      )
      // Round 6: only the value segment is bold; noun and revision stay plain.
      const doneRow = rowAt(text, mutedRowY)
      const changeX = doneRow.indexOf("pr#4.1")
      expect(app.cell(changeX, mutedRowY).bold, "integrated PR noun is plain").not.toBe(true)
      expect(app.cell(changeX + 3, mutedRowY).bold, "integrated PR value is bold").toBe(true)
      expect(app.cell(changeX + 4, mutedRowY).bold, "integrated PR revision is plain").not.toBe(true)
      // Item 5: the table header sits flush — the row directly above the TIME
      // header is not a blank spacer (it is the QUEUE metadata row).
      expect(rowAt(text, headerY - 1).trim(), "no blank row above the header").not.toBe("")
    } finally {
      app.unmount()
    }
  })

  it("renders run cells as #N + glyph with id+title CHANGES cells, em-dash pre-run", async () => {
    // Items 28/38: the CHANGES cell is `pr#id.rev <title>` (never the
    // branch), the RUN cell is `label#N <glyph>` with the label elided on a
    // single visible queue, and a run-less row carries a muted em-dash.
    const projection = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 160 }))
    try {
      await app.waitForLayoutStable()
      const text = app.text
      const runRowY = rowIndexOf(text, "pr#4.1")
      expect(runRowY).toBeGreaterThan(0)
      const runRow = rowAt(text, runRowY)
      // Single visible queue: the label elides — `#4`, not `main#4` (item 34).
      expect(runRow).toContain("#4 ")
      expect(runRow).not.toContain("main#4")
      // The row shows the change's TITLE, not its branch glyph (item 28).
      expect(runRow).not.toContain("\uE0A0")
      const timeX = runRow.search(/\d{2}:\d{2}:\d{2}/u)
      const timeFg = app.cell(timeX, runRowY).fg
      // The run NUMBER renders bright — distinct from the muted TIME cell
      // (item 38: id bright on the first member row).
      const hashX = runRow.indexOf("#4 ")
      expect(app.cell(hashX, runRowY).fg, "run number is bright, not muted").not.toEqual(timeFg)

      // A not-yet-started run shows a muted em-dash in the RUN cell (item
      // 38). The submitted PR's display-only STATUS cell reads `ready` and
      // keeps its info color.
      const readyRowY = rowIndexOf(text, " ready ")
      const readyRow = rowAt(text, readyRowY)
      expect(readyRow, "run-less row shows no colored pending run id").not.toContain("pending")
      expect(readyRow, "run-less row carries the em-dash placeholder").toContain("—")
      const readyStatusX = readyRow.indexOf("ready")
      expect(readyStatusX, "ready status word present").toBeGreaterThan(0)
      expect(
        app.cell(readyStatusX, readyRowY).fg,
        "ready status word keeps its own (info) color, distinct from muted TIME",
      ).not.toEqual(timeFg)
    } finally {
      app.unmount()
    }
  })

  it("renders the failed/done status vocabulary", async () => {
    const projection = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 160 }))
    try {
      await app.waitForLayoutStable()
      const integratedRow = rowAt(app.text, rowIndexOf(app.text, "pr#4.1"))
      expect(integratedRow).toContain(" merged ")
      expect(integratedRow).not.toContain(" ok ")
      const revisedRow = rowAt(app.text, rowIndexOf(app.text, "pr#5.1"))
      expect(revisedRow).toContain(" rev ")
      const rejectedRow = rowAt(app.text, timelineRowIndexOf(app.text, " failed "))
      expect(rejectedRow).toContain("#5")
      expect(rejectedRow).not.toContain(" rej ")
    } finally {
      app.unmount()
    }
  })

  it("keeps healthy runner chrome visible in the normal queue", async () => {
    const story = queueTimelineStories["contract-overview"].snapshot.projection
    const projection: QueueTimelineProjection = {
      ...story,
      runner: {
        pid: 342,
        startedAt: new Date(NOW - (3 * 60 + 45) * 60_000).toISOString(),
        lastTickAt: new Date(NOW - 2_000).toISOString(),
        command: "bun vendor/yrd/bin/yrd.ts --resident",
      },
    }
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("╭─ RUNNER ")
      expect(app.text).not.toContain("╭─ STATUS ")
      expect(app.text).toContain("[342]")
      // The RUNNER border timer uses the adaptive clock (H:MM:SS above an hour):
      // 3h45m of uptime renders `uptime 3:45:00` (user directive 2026-07-21).
      expect(app.text).toContain("uptime 3:45:00")
      expect(app.text).toContain("PROGRESS NOT MEASURED")
    } finally {
      app.unmount()
    }
  })

  it("shows elapsed uptime when a fresh runner has never merged", async () => {
    const story = queueTimelineStories.idle.snapshot.projection
    const projection: QueueTimelineProjection = {
      ...story,
      runner: {
        pid: 342,
        startedAt: new Date(NOW - 60 * 60_000).toISOString(),
        lastTickAt: new Date(NOW - 2_000).toISOString(),
        command: "resident runner",
        queueProgress: { state: "healthy", observedAt: new Date(NOW - 2_000).toISOString() },
      },
    }
    const app = createRenderer({ cols: 120, rows: 40 })(
      createElement(QueueTimelineView, { projection, state: { byId: {}, prs: {}, receipts: {}, submits: {} }, columns: 120 }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("uptime 1:00:00 · no merge for 1:00:00")
      expect(app.text).not.toContain("no merge recorded")
      expect(app.text).toContain("progress measured 0:02 ago")
    } finally {
      app.unmount()
    }
  })

  it("renders a fresh but stalled runner as loud no-progress failure chrome", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const story = snapshot.projection
    const prs = snapshot.results[0]?.prs ?? []
    const siblingPr = prs[0] === undefined ? undefined : { ...prs[0], id: "PR99", base: "release/next" }
    const queuedTwo = prs[0] === undefined ? undefined : { ...prs[0], id: "PR8", name: "Second eligible PR" }
    const queuedThree = prs[0] === undefined ? undefined : { ...prs[0], id: "PR9", name: "Third eligible PR" }
    const integratedPr = prs.find((pr) => pr.integratedAt !== undefined)
    const siblingIntegrated =
      integratedPr === undefined
        ? undefined
        : {
            ...integratedPr,
            id: "PR100",
            base: "release/next",
            integratedAt: "2026-07-13T11:55:00.000Z",
            revs: integratedPr.revs.map((revision, index) =>
              index === integratedPr.revs.length - 1
                ? {
                    ...revision,
                    base: "release/next",
                    terminal: { kind: "integrated" as const, at: "2026-07-13T11:55:00.000Z", run: "R100" },
                  }
                : revision,
            ),
          }
    const mainPrs = [
      ...prs,
      ...(queuedTwo === undefined ? [] : [queuedTwo]),
      ...(queuedThree === undefined ? [] : [queuedThree]),
    ]
    const mainResult: QueueStatusResult = {
      ...(snapshot.results[0] as QueueStatusResult),
      prs: mainPrs,
      admissionOrder: ["PR1", "PR8", "PR9"],
      eligibilities: [queuedEligibility("PR1", 1), queuedEligibility("PR8", 2), queuedEligibility("PR9", 3)],
    }
    const siblingResult: QueueStatusResult = {
      base: "release/next",
      prs: siblingPr === undefined ? [] : [siblingPr],
      admissionOrder: siblingPr === undefined ? [] : ["PR99"],
      running: [],
      waiting: [],
      finished: [],
      eligibilities: siblingPr === undefined ? [] : [queuedEligibility("PR99", 1)],
    }
    const results = [mainResult, siblingResult]
    const state = {
      byId: {},
      prs: Object.fromEntries(
        [
          ...mainPrs,
          ...(siblingPr === undefined ? [] : [siblingPr]),
          ...(siblingIntegrated === undefined ? [] : [siblingIntegrated]),
        ].map((pr) => [pr.id, pr]),
      ),
      receipts: {},
      submits: {},
    }
    const projection: QueueTimelineProjection = {
      ...story,
      rows: story.rows.filter((row) => row.status !== "integrated"),
      timeStatsFacts: story.timeStatsFacts.filter((fact) => fact.outcome !== "integrated"),
      runner: {
        pid: 342,
        startedAt: new Date(NOW - 60 * 60_000).toISOString(),
        lastTickAt: new Date(NOW - 2_000).toISOString(),
        command: "resident runner",
        queueProgress: {
          state: "stalled",
          observedAt: new Date(NOW - 2_000).toISOString(),
          findings: [
            {
              code: "admission-refusal-loop",
              message: "release queue head is blocked",
              pr: "PR99",
              refusal: "recut-gitlink-conflict",
              count: 1,
              since: "2026-07-13T10:00:00.000Z",
              blockedMs: 0,
            },
            {
              code: "admission-refusal-loop",
              message: "opaque producer finding whose remedy cannot be recovered from prose",
              pr: "PR1",
              refusal: "recut-gitlink-conflict",
              count: 1,
              since: "2026-07-13T11:00:00.000Z",
              blockedMs: 0,
              resolution: ["Preserve this exact producer-authored remedy."],
            },
          ],
        },
      },
    }

    expect(queueHealthMarker(projection, Date.parse(projection.now)).kind).toBe("stalled")

    const app = createRenderer({ cols: 120, rows: 40 })(
      createElement(QueueTimelineView, { projection, results, state, nav: false, columns: 120 }),
    )
    try {
      await app.waitForLayoutStable()
      const titleY = rowIndexOf(app.text, "╭─ RUNNER ")
      const titleLine = rowAt(app.text, titleY)
      const titleX = titleLine.indexOf("RUNNER")
      const borderX = titleLine.indexOf("─", titleX + "RUNNER".length + 1)
      const failedY = timelineRowIndexOf(app.text, " failed ")
      const failedLine = rowAt(app.text, failedY)
      const errorX = failedLine.indexOf("fail")

      expect(app.cell(borderX, titleY).fg, "stalled RUNNER border uses error fg").toEqual(app.cell(errorX, failedY).fg)
      expect(titleLine).toContain("uptime 1:00:00 · no merge for 1:05:00")
      expect(app.text).toContain("NO PROGRESS")
      expect(app.text).toContain("BLOCKED PR1 · Prepare release notes")
      expect(app.text).toContain("position 1 · recut-gitlink-conflict")
      expect(app.text).toContain("blocked 1:00:00 · retry 1 · 2 queued behind")
      expect(app.text).toContain("REMEDY — Preserve this exact producer-authored remedy.")
    } finally {
      app.unmount()
    }
  })

  it("uses the latest actual merge outside the visible rows and ignores newer non-landing terminals", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const newestMerge = snapshot.projection.timeStatsFacts.find((fact) => fact.outcome === "integrated")
    if (newestMerge === undefined) throw new Error("fixture must retain an integrated fact")
    const projection: QueueTimelineProjection = {
      ...snapshot.projection,
      rows: snapshot.projection.rows.filter((row) => row.status !== "integrated"),
      runner: {
        pid: 342,
        startedAt: new Date(NOW - 2 * 60 * 60_000).toISOString(),
        lastTickAt: new Date(NOW - 2_000).toISOString(),
        command: "resident runner",
        queueProgress: { state: "healthy", observedAt: new Date(NOW - 60_000).toISOString() },
      },
    }
    const state = {
      byId: {},
      prs: Object.fromEntries((snapshot.results[0]?.prs ?? []).map((pr) => [pr.id, pr])),
      receipts: {},
      submits: {},
    }
    const app = createRenderer({ cols: 120, rows: 40 })(
      createElement(QueueTimelineView, { projection, state, nav: false, columns: 120 }),
    )
    try {
      await app.waitForLayoutStable()
      expect(projection.rows.some((row) => row.status === "integrated")).toBe(false)
      expect(Math.max(...projection.timeStatsFacts.map((fact) => fact.terminalAtMs))).toBeGreaterThan(
        newestMerge.terminalAtMs,
      )
      expect(app.text).toContain("no merge for 1:05:00")
      expect(app.text).toContain("PROGRESS STALE — last measured 1:00 ago")
    } finally {
      app.unmount()
    }
  })

  it("preserves generic stalled findings when no structured head refusal is available", async () => {
    const story = queueTimelineStories.idle.snapshot.projection
    const projection: QueueTimelineProjection = {
      ...story,
      runner: {
        pid: 342,
        startedAt: new Date(NOW - 60 * 60_000).toISOString(),
        lastTickAt: new Date(NOW - 2_000).toISOString(),
        command: "resident runner",
        queueProgress: {
          state: "stalled",
          observedAt: new Date(NOW - 2_000).toISOString(),
          findings: [
            {
              code: "queue-progress-stalled",
              message: "Queue main has ready work and no landing",
              since: "2026-07-13T11:00:00.000Z",
              blockedMs: 60 * 60_000,
            },
          ],
        },
      },
    }
    const app = createRenderer({ cols: 120, rows: 40 })(
      createElement(QueueTimelineView, { projection, nav: false, columns: 120 }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("NO PROGRESS — Queue main has ready work and no landing")
    } finally {
      app.unmount()
    }
  })

  it("renders an all-red NO RUNNER banner with the last-drained age when no runner exists", async () => {
    const story = queueTimelineStories["contract-overview"].snapshot.projection
    const projection: QueueTimelineProjection = { ...story, runner: null }
    const newestTerminal = Math.max(
      ...projection.rows
        .filter((row) => row.group === "completed" && row.timestampMs !== null)
        .map((row) => row.timestampMs ?? Number.NEGATIVE_INFINITY),
    )
    const expectedAge = clockDuration(NOW - newestTerminal)
    const render = createRenderer({ cols: 120, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection, nav: false, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      const message = `NO RUNNER - queue last drained ${expectedAge} ago`
      const messageY = rowIndexOf(app.text, "NO RUNNER")
      expect(messageY, app.text).toBeGreaterThanOrEqual(0)
      expect(app.text).not.toContain("╭─ STATUS ")
      expect(app.text).toContain("╭─ RUNNER ")
      expect(rowAt(app.text, messageY)).toContain(message)
      // All-red: every glyph of the message shares one fg matching the failed
      // status word's error fg.
      const messageLine = rowAt(app.text, messageY)
      const startX = messageLine.indexOf("NO RUNNER")
      const messageFg = app.cell(startX, messageY).fg
      for (let offset = 0; offset < message.length; offset += 4) {
        expect(app.cell(startX + offset, messageY).fg, `fg at offset ${offset}`).toEqual(messageFg)
      }
      const rejectedY = timelineRowIndexOf(app.text, " failed ")
      const rejectedLine = rowAt(app.text, rejectedY)
      const failX = rejectedLine.indexOf("fail")
      expect(messageFg, "NO RUNNER shares the error fg").toEqual(app.cell(failX, rejectedY).fg)
    } finally {
      app.unmount()
    }
  })

  it("omits since= from the pills row when the window is unbounded (the new default)", async () => {
    const base = queueTimelineStories["contract-overview"].snapshot.projection
    const unbounded: QueueTimelineProjection = {
      ...base,
      filters: { ...base.filters, windowMs: QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS },
    }
    const app = createRenderer({ cols: 160, rows: 40 })(
      createElement(QueueTimelineView, { projection: unbounded, nav: false, columns: 160 }),
    )
    try {
      await app.waitForLayoutStable()
      const filterLine = pillsRow(app.text)
      expect(filterLine, "unbounded window shows no since=").not.toContain("since=")
      expect(filterLine).toContain("open")
    } finally {
      app.unmount()
    }
  })

  it("renders only non-default dimensions plus the four plain-word status pills (no FILTER label)", async () => {
    const defaults = queueTimelineStories["contract-overview"].snapshot.projection
    const render = createRenderer({ cols: 160, rows: 40 })
    const app = render(createElement(QueueTimelineView, { projection: defaults, nav: false, columns: 160 }))
    try {
      await app.waitForLayoutStable()
      const filterLine = pillsRow(app.text)
      // Item 3: the "FILTER" label is gone; the non-default `since=` dimension
      // survives as a dim prefix and the pills are plain words (no brackets).
      expect(app.text, "FILTER label is deleted").not.toContain("FILTER")
      expect(filterLine).toContain("since=6:00:00")
      expect(filterLine).toContain("open")
      expect(filterLine).toContain("running")
      expect(filterLine).toContain("failed")
      expect(filterLine).toContain("done")
      expect(filterLine, "no bracketed hotkey hints").not.toMatch(/\[[trfd]\]/u)
      expect(filterLine).not.toContain("terms=")
      expect(filterLine).not.toContain("latest=")
      expect(filterLine).not.toContain("status=")
    } finally {
      app.unmount()
    }

    const filtered = queueTimelineStories["non-default-filters"].snapshot.projection
    const app2 = createRenderer({ cols: 160, rows: 40 })(
      createElement(QueueTimelineView, { projection: filtered, nav: false, columns: 160 }),
    )
    try {
      await app2.waitForLayoutStable()
      const filterLine = pillsRow(app2.text)
      expect(filterLine).toContain("terms=typecheck")
      // Pills always render their label (bucket on/off is colour, not glyph).
      expect(filterLine).toContain("open")
      expect(filterLine).toContain("failed")
      expect(filterLine).toContain("done")
    } finally {
      app2.unmount()
    }
  })

  it("draws the compact info boxes with full rounded corners, a left label, and a label color matching its border", async () => {
    // Reworked title-in-border chrome (user directives 1+2, 2026-07-16):
    // `╭─ TITLE ─…─╮` on top with the label punched into the LEFT of the top
    // edge, `╰─…─╯` on the bottom (rounded corners everywhere), and the label
    // sharing the border's resolved color. Only the compact info boxes get this
    // — QUEUE and DETAIL are unboxed panes (items L/M).
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const app = createRenderer({ cols: 160, rows: 50 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("╭─ STATS "))
      const rows = app.text.split("\n")
      // Normal chrome includes runner liveness and the calendar metric frame.
      expect(app.text).not.toContain("╭─ STATUS ")
      for (const label of ["RUNNER", "STATS"]) {
        const topY = rows.findIndex((l) => l.includes(`╭─ ${label} `))
        expect(topY, `${label} rounded top-left corner + left label`).toBeGreaterThanOrEqual(0)
        const topLine = rows[topY]
        if (topLine === undefined) throw new Error(`${label} top border row missing`)
        const titleX = topLine.indexOf(label)
        // A rounded top-right corner closes this box's border row after the
        // label.
        expect(topLine.indexOf("╮", titleX), `${label} rounded top-right corner`).toBeGreaterThan(titleX)
        // The label color equals the border-fill color on the same row.
        const fillX = topLine.indexOf("─", titleX + label.length + 1)
        expect(fillX, `${label} border fill after the label`).toBeGreaterThan(titleX)
        expect(app.cell(titleX, topY).fg, `${label} label fg == border fg`).toEqual(app.cell(fillX, topY).fg)
      }
    } finally {
      app.unmount()
    }
  })

  it("heads the live pane with only the top line and keeps the temporal cue on the RUNNER border", async () => {
    // Item 30: the top of the watch is ONLY the top line — the old per-queue
    // `QUEUE main` header row is deleted. The `updated` clock stays absent
    // from the live pane (user directive 2026-07-21): the RUNNER box's
    // always-on border timer is the watch view's temporal-trust cue.
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const app = createRenderer({ cols: 160, rows: 50 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("╭─ STATS "))
      expect(app.text.split("\n")[0], "the top line titles the frame").toContain("YRD QUEUES")
      expect(app.text, "the QUEUE header row is deleted").not.toContain("QUEUE main")
      // The `updated HH:MM:SS` clock is absent from the live pane.
      expect(app.text, "the live pane drops the updated clock").not.toMatch(/updated \d{2}:\d{2}:\d{2}/u)
      // The temporal cue rides the RUNNER box's top border as uptime/downtime.
      const runnerBorderY = rowIndexOf(app.text, "╭─ RUNNER ")
      expect(runnerBorderY, "RUNNER box renders").toBeGreaterThanOrEqual(0)
      expect(rowAt(app.text, runnerBorderY), "RUNNER border carries the uptime/downtime timer").toMatch(
        /(?:uptime|downtime) \d/u,
      )
      // No rounded box border around the QUEUE pane.
      expect(app.text).not.toContain("╭─ QUEUE")
    } finally {
      app.unmount()
    }
  })

  it("turns the RUNNER label and border red together when the heartbeat is stale", async () => {
    // Directive 2 (2026-07-16): the error-red case colors both the border AND
    // the label, matching the STALE banner's error fg.
    const story = queueTimelineStories["contract-overview"].snapshot.projection
    const projection: QueueTimelineProjection = {
      ...story,
      runner: {
        pid: 342,
        startedAt: new Date(NOW - 60_000).toISOString(),
        lastTickAt: new Date(NOW - 60_000).toISOString(),
        command: "resident runner",
      },
    }
    const app = createRenderer({ cols: 120, rows: 40 })(
      createElement(QueueTimelineView, { projection, nav: false, columns: 120 }),
    )
    try {
      await app.waitForLayoutStable()
      const titleY = rowIndexOf(app.text, "╭─ RUNNER ")
      const titleLine = rowAt(app.text, titleY)
      const titleX = titleLine.indexOf("RUNNER")
      const fillX = titleLine.indexOf("─", titleX + "RUNNER".length + 1)
      expect(app.cell(titleX, titleY).fg, "stale RUNNER label fg == border fg").toEqual(app.cell(fillX, titleY).fg)
      expect(app.text).not.toContain("╭─ STATUS ")
      const staleY = rowIndexOf(app.text, "RUNNER STALE")
      expect(staleY, "stale banner present").toBeGreaterThan(titleY)
      const staleLine = rowAt(app.text, staleY)
      const staleX = staleLine.indexOf("RUNNER STALE")
      expect(app.cell(titleX, titleY).fg, "label red == stale-banner error red").toEqual(app.cell(staleX, staleY).fg)
    } finally {
      app.unmount()
    }
  })

  it("renders QUEUE + DETAIL as unboxed panes with bottom-aligned statistics", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("╭─ STATS "))
      const text = app.text
      // The frame is headed by the one top line; DETAIL's identity lives on
      // the status box border (`RUN main#42`) — neither pane is boxed.
      expect(text.split("\n")[0], "top line titles the frame").toContain("YRD QUEUES")
      expect(text, "the QUEUE header row is deleted").not.toContain("QUEUE main")
      expect(text, "DETAIL identity rides the status-box border").toContain("RUN main#42")
      expect(text).not.toContain("╭─ DETAIL")
      expect(text).not.toContain("╭─ QUEUE")
      // Padded content: the TIME header sits inside the pane's horizontal padding.
      const timeHeader = app.locator("#th-time").boundingBox()
      expect(timeHeader).not.toBeNull()
      expect(timeHeader!.x).toBeGreaterThanOrEqual(1)
      expect(timeHeader!.y).toBeGreaterThanOrEqual(1)
      // Bottom-aligned statistics: STATS sits after the list, in the QUEUE
      // pane. A below-split (200 cols < 213) places DETAIL under that pane,
      // so the last ╰ in the frame is the detail box, not STATS.
      const rows = text.split("\n")
      const statsY = rowIndexOf(text, "╭─ STATS ")
      const statsBottomY = rows.findIndex((row, index) => index > statsY && row.includes("╰"))
      const detailY = rowIndexOf(text, "RUN main#42")
      expect(statsY, "STATS box renders below the list header").toBeGreaterThan(timeHeader!.y)
      expect(statsBottomY, "STATS box closes").toBeGreaterThan(statsY)
      expect(detailY, "detail sits below STATS in the below-split").toBeGreaterThan(statsBottomY)
    } finally {
      app.unmount()
    }
  })

  it("forces selection fg/bg across every cell of the cursor row and keeps colorization elsewhere", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => timelineRowIndexOf(app.text, " checking ") >= 0)
      const text = app.text
      // Default cursor = first RUNNING row.
      const cursorY = timelineRowIndexOf(text, " checking ")
      const cursorLine = rowAt(text, cursorY)
      const statusX = cursorLine.indexOf(" checking ") + 1
      const timeX = cursorLine.search(/\d{2}:\d{2}:\d{2}/u)
      // Sample the selection fg/bg from a NON-activity cell (TIME).
      const cursorFg = app.cell(timeX, cursorY).fg
      const cursorBg = app.cell(timeX, cursorY).bg
      expect(app.cell(timeX, cursorY).bg, "TIME cell selection bg").toEqual(cursorBg)
      // Item 13: the running status word keeps its BLUE activity fg under
      // selection — it is NEVER forced to the selection fg — while the selection
      // bg still covers it (the band is unbroken).
      expect(app.cell(statusX, cursorY).fg, "running activity fg stays blue under selection").not.toEqual(cursorFg)
      expect(app.cell(statusX, cursorY).bg, "selection bg still covers the activity cell").toEqual(cursorBg)
      // The selection band spans the FULL row width: the run-duration cell at
      // the right edge (now a bare dimmed time, no glyph — item S) AND the
      // inter-cell gap next to it carry the same selection background as the
      // left-edge cells. Locate the cursor row's `td-dur` cell (robust across
      // the split layout, where a text scan would catch a DETAIL-pane time).
      const durCells = app.locator("[id^='td-dur-']")
      let durBox: { x: number; y: number; width: number } | null = null
      for (let index = 0; index < durCells.count(); index += 1) {
        const box = durCells.nth(index).boundingBox()
        if (box?.y === cursorY) {
          durBox = box
          break
        }
      }
      expect(durBox, "cursor row run-duration cell").not.toBeNull()
      // Sample inside the duration cell, not its last column: a filled
      // ListView scrollbar sits on the row's right edge and is not the
      // selection band.
      const durX = durBox!.x + Math.min(2, Math.max(0, durBox!.width - 1))
      expect(app.cell(durX, cursorY).bg, "selection bg in the duration cell").toEqual(cursorBg)
      expect(app.cell(durBox!.x, cursorY).bg, "selection bg at the duration cell origin").toEqual(cursorBg)
      // Unselected rejected row keeps its own colorization: status fg differs
      // from muted TIME fg.
      const rejectedY = timelineRowIndexOf(text, " failed ")
      expect(rejectedY).not.toBe(cursorY)
      const rejectedLine = rowAt(text, rejectedY)
      const failX = rejectedLine.indexOf(" failed ") + 1
      const rejectedTimeX = rejectedLine.search(/\d{2}:\d{2}:\d{2}/u)
      expect(app.cell(failX, rejectedY).fg).not.toEqual(app.cell(rejectedTimeX, rejectedY).fg)
      expect(app.cell(failX, rejectedY).bg).not.toEqual(cursorBg)
    } finally {
      app.unmount()
    }
  })
})
