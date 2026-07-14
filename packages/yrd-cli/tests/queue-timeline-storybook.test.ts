// @failure Queue timeline story fixtures drift from the renderer or developer viewer
// @level l2
// @consumer @yrd/cli

import { act, createElement } from "react"
import { createRenderer, createTermless, waitFor } from "@silvery/test"
import { renderString } from "silvery"
import { run } from "silvery/runtime"
import { describe, expect, it } from "vitest"
import { QUEUE_TIMELINE_STORY_NAMES, queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineStorybook } from "../dev/queue-timeline-storybook.tsx"
import { QueueTimelineView } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const STORY_NAMES = [
  "production-overview",
  "idle",
  "pending-only",
  "running-spinner",
  "mixed-completed",
  "paused",
  "honest-cap",
  "non-default-filters",
  "latest-vs-all-lineage",
  "narrow-wide",
  "anchored-new",
  "selected-pending",
  "selected-running",
  "selected-rejected",
  "selected-integrated",
  "detail-right",
  "detail-below",
  "detail-full",
  "detail-controls",
  "long-subject",
  "live-output-growth",
] as const

const TERMLESS_DETAIL_TIERS = [
  { name: "detail-right", divider: "vertical" },
  { name: "detail-below", divider: "horizontal" },
  { name: "detail-full", divider: "none" },
] as const

function findGlyphColumn(term: ReturnType<typeof createTermless>, glyph: string, row = 1): number {
  const columns = term.cols
  if (columns === undefined) throw new Error("Termless terminal is missing its column count")
  for (let column = 0; column < columns; column += 1) {
    if (term.cell(row, column).char === glyph) return column
  }
  return -1
}

function findGlyphRow(term: ReturnType<typeof createTermless>, glyph: string, column = 1): number {
  const rows = term.rows
  if (rows === undefined) throw new Error("Termless terminal is missing its row count")
  for (let row = 0; row < rows; row += 1) {
    if (term.cell(row, column).char === glyph) return row
  }
  return -1
}

describe("queue timeline storybook", () => {
  it("opens on meaningful production queue rows and selected run detail", async () => {
    using term = createTermless({ cols: 200, rows: 50 })
    const handle = await run(createElement(QueueTimelineStorybook), term, {
      mouse: true,
      selection: false,
    })
    try {
      await waitFor(() => term.screen.getText().includes("production-overview"))
      const frame = term.screen.getText()
      expect(frame).toContain("QUEUE main")
      expect(frame).toContain("running")
      expect(frame).toContain("MEMBERS PR42@r1:cccccccccccc,PR43@r1:dddddddddddd")
      expect(frame).toContain("R42 main running")
      expect(frame).toContain("check     step-v2 running     2")
      expect(frame).toContain("OUTPUT check#2")
      expect(frame).toContain("p pause q quit · Esc close detail · f filters · o evidence")
      expect(frame).not.toContain("No matching queue rows.")
    } finally {
      handle.unmount()
    }
  })

  it("opens the default selected run detail from the narrow production tier", async () => {
    using term = createTermless({ cols: 80, rows: 24 })
    const handle = await run(createElement(QueueTimelineStorybook), term, {
      mouse: true,
      selection: false,
    })
    try {
      await waitFor(() => term.screen.getText().includes("production-overview"))
      expect(term.screen.getText()).toContain("R42·PR42,PR43")
      expect(term.screen.getText()).toContain("Enter detail")

      await act(async () => {
        await handle.press("Enter")
        await handle.waitForLayoutStable()
      })
      const detail = term.screen.getText()
      expect(detail).toContain("RUN R42 STATUS running OUTCOME running")
      expect(detail).toContain("JOB J42-check RUNNER runner-herdr-07")
      expect(detail).toContain("LEASE 2026-07-13T12:05:30.000Z")
      expect(detail).not.toContain("QUEUE main")
    } finally {
      handle.unmount()
    }
  })

  it("shares realistic production contracts across lifecycle, batch, lineage, proof, and output stories", () => {
    const overview = queueTimelineStories["production-overview"].snapshot
    const overviewResult = overview.results[0]
    if (overviewResult === undefined) throw new Error("production-overview is missing its queue result")

    expect(overview.projection.rows.map((row) => row.status)).toEqual([
      "running",
      "canceled",
      "environment-refused",
      "rejected",
      "integrated",
    ])
    const batch = overviewResult.running.find((run) => run.id === "R42")
    if (batch === undefined) throw new Error("production-overview is missing batch run R42")
    expect(batch.prs.map((pr) => pr.id)).toEqual(["PR42", "PR43"])
    expect(batch.steps.map((step) => step.job?.status)).toEqual(["passed", "running", "requested"])
    expect(batch.steps[1]?.job).toMatchObject({
      id: "J42-check",
      status: "running",
      attempt: 2,
      runner: "runner-herdr-07",
      changedAt: "2026-07-13T11:58:30.000Z",
      leaseExpiresAt: "2026-07-13T12:05:30.000Z",
    })
    expect(overview.outputs?.map((output) => output.path)).toEqual([
      "/repo/.git/yrd/artifacts/R42/1-check/attempt-2/stdout.log",
      "/repo/.git/yrd/artifacts/R42/1-check/attempt-2/stderr.log",
    ])

    const integrated = overviewResult.finished.find((run) => run.id === "R4")
    expect(integrated?.integration).toEqual({ commit: "b".repeat(40), baseSha: "a".repeat(40) })
    expect(integrated?.steps[0]?.job).toMatchObject({
      status: "passed",
      checkpoint: { tests: 125, failures: 0 },
      artifacts: [
        {
          kind: "vitest-report",
          uri: "file:///repo/.git/yrd/artifacts/R4/0-check/attempt-1/report.json",
        },
      ],
    })
    expect(overviewResult.finished.find((run) => run.id === "R5")?.error?.code).toBe("typecheck-failed")
    expect(overviewResult.finished.find((run) => run.id === "R6")?.error?.code).toBe("queue-environment-refused")
    expect(overviewResult.finished.find((run) => run.id === "R7")?.steps[0]?.job).toMatchObject({
      status: "canceled",
      canceledBy: "operator@example.test",
    })

    const pending = queueTimelineStories["pending-only"].snapshot
    expect(pending.projection.rows.map((row) => row.position)).toEqual([1, 2])
    expect(pending.results[0]?.prs[0]).toMatchObject({
      issue: "@yrd/core/21120-pr-state-notifications",
      reviews: [{ decision: "approve", ref: "review://PR1/1" }],
      comments: [{ ref: "packages/yrd-cli/src/queue-status-view.tsx:1463" }],
      checkRequests: [{ at: "2026-07-13T11:16:00.000Z" }],
    })

    const lineage = queueTimelineStories["latest-vs-all-lineage"]
    expect(lineage.snapshot.results[0]?.prs[0]?.revisions.map((revision) => revision.revision)).toEqual([1, 2])
    expect(
      lineage.snapshot.results[0]?.finished.map((run) => ({
        run: run.id,
        revision: run.prs[0]?.revision,
        status: run.status,
      })),
    ).toEqual([
      { run: "R8", revision: 1, status: "failed" },
      { run: "R9", revision: 2, status: "passed" },
    ])

    const rejected = queueTimelineStories["selected-rejected"].snapshot.projection.details[0]
    expect(rejected?.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2])
    expect(rejected?.steps.map((step) => step.errorCode)).toEqual(["lint-failed", "typecheck-failed"])

    const live = queueTimelineStories["live-output-growth"]
    expect(live.snapshot.outputs?.map((output) => output.path.split("/").at(-1))).toEqual(["stdout.log", "stderr.log"])
    expect(live.nextSnapshot?.outputs?.[0]?.text).toContain("checking two")
    expect(live.nextSnapshot?.outputs?.[1]?.text).toContain("retry recovered")
  })

  it("shares every deterministic named story with the acceptance surface", async () => {
    expect(QUEUE_TIMELINE_STORY_NAMES).toEqual(STORY_NAMES)
    expect(Object.keys(queueTimelineStories)).toEqual(QUEUE_TIMELINE_STORY_NAMES)

    for (const name of QUEUE_TIMELINE_STORY_NAMES) {
      const story = queueTimelineStories[name]
      const projection = story.snapshot.projection
      expect(projection?.now, name).toBe("2026-07-13T12:00:00.000Z")
      if (projection === undefined) throw new Error(`story '${name}' is missing its projection`)
      for (const width of story.widths) {
        const rendered = await renderString(createElement(QueueTimelineView, { projection }), {
          width,
          height: 24,
          plain: true,
        })
        expect(rendered, name).toContain(`QUEUE ${projection.base}`)
        expect(
          Math.max(...rendered.split("\n").map((line) => line.length)),
          `${name} at ${width} columns`,
        ).toBeLessThanOrEqual(width)
      }
      if (story.selectedStatus !== undefined) {
        expect(projection.rows[0]?.status, name).toBe(story.selectedStatus)
      }
      if (story.nextSnapshot !== undefined) {
        expect(story.nextSnapshot.projection?.now, name).toBe("2026-07-13T12:00:00.000Z")
      }
    }
  })

  it.each(TERMLESS_DETAIL_TIERS)(
    "renders the $name A15 tier through a real terminal buffer",
    async ({ name, divider }) => {
      const story = queueTimelineStories[name]
      const viewport = story.viewport
      if (viewport === undefined) throw new Error(`story '${name}' is missing its viewport`)

      using term = createTermless({ cols: viewport.columns, rows: viewport.rows })
      const handle = await run(createElement(QueueWatchFrame, { snapshot: story.snapshot, paused: false }), term, {
        mouse: true,
        selection: false,
      })
      try {
        await waitFor(() => term.screen.getText().includes("QUEUE main"))
        expect(term.screen.getText(), name).toContain("QUEUE main")

        if (divider === "vertical") {
          await waitFor(() => findGlyphColumn(term, "│") >= 0)
          expect(findGlyphColumn(term, "│"), name).toBeGreaterThan(0)
          expect(term.screen.getText(), name).toContain("MEMBERS PR4")
        } else if (divider === "horizontal") {
          await waitFor(() => findGlyphRow(term, "─") >= 0)
          expect(findGlyphRow(term, "─"), name).toBeGreaterThan(0)
          expect(term.screen.getText(), name).toContain("MEMBERS PR4")
        } else {
          expect(term.screen.getText(), name).not.toContain("MEMBERS PR4")
          await act(async () => {
            await handle.press("Enter")
            await handle.waitForLayoutStable()
          })
          expect(term.screen.getText(), name).toContain("RUN R4 STATUS passed")
          expect(term.screen.getText(), name).toContain("LANDING bbbbbbbbbbbb@aaaaaaaaaaaa")
          expect(term.screen.getText(), name).not.toContain("QUEUE main")
        }
      } finally {
        handle.unmount()
      }
    },
  )

  it("preserves the dragged split ratio when the queue cursor moves", async () => {
    const story = queueTimelineStories["mixed-completed"]
    using term = createTermless({ cols: 200, rows: 50 })
    const handle = await run(createElement(QueueWatchFrame, { snapshot: story.snapshot, paused: false }), term, {
      mouse: true,
      selection: false,
    })
    try {
      await waitFor(() => term.screen.getText().includes("PR PR6 STATUS"))
      const initialDivider = findGlyphColumn(term, "│")
      expect(initialDivider).toBeGreaterThan(0)
      const draggedDivider = initialDivider + 12

      await term.mouse.down(initialDivider, 1)
      await term.mouse.move(draggedDivider, 1)
      await waitFor(() => findGlyphColumn(term, "│") === draggedDivider)
      await term.mouse.up(draggedDivider, 1)

      await handle.press("j")
      await waitFor(() => term.screen.getText().includes("PR PR1 STATUS"))
      expect(findGlyphColumn(term, "│")).toBe(draggedDivider)
    } finally {
      handle.unmount()
    }
  })

  it("drives the shared master-detail and live-output stories without reopening", async () => {
    for (const name of ["detail-right", "detail-below", "detail-full"] as const) {
      const story = queueTimelineStories[name]
      const viewport = story.viewport
      if (viewport === undefined) throw new Error(`story '${name}' is missing its viewport`)
      const handle = await run(createElement(QueueWatchFrame, { snapshot: story.snapshot, paused: false }), {
        writable: { write: () => {} },
        cols: viewport.columns,
        rows: viewport.rows,
      })
      try {
        expect(handle.text, name).toContain("QUEUE main")
        if (name === "detail-full") {
          await handle.press("Enter")
          await handle.waitForLayoutStable()
        }
        expect(handle.text, name).toContain("RUN")
      } finally {
        handle.unmount()
      }
    }

    const boundaryStory = queueTimelineStories["detail-below"]
    const fullAtFooterBoundary = await run(
      createElement(QueueWatchFrame, { snapshot: boundaryStory.snapshot, paused: false }),
      { writable: { write: () => {} }, cols: 100, rows: 25 },
    )
    const belowAfterFooter = await run(
      createElement(QueueWatchFrame, { snapshot: boundaryStory.snapshot, paused: false }),
      { writable: { write: () => {} }, cols: 100, rows: 26 },
    )
    try {
      expect(fullAtFooterBoundary.text).not.toContain("MEMBERS PR4")
      expect(belowAfterFooter.text).toContain("MEMBERS PR4")
    } finally {
      fullAtFooterBoundary.unmount()
      belowAfterFooter.unmount()
    }

    const live = queueTimelineStories["live-output-growth"]
    expect(live.snapshot.outputs?.[0]?.text).toBe("checking one\n")
    expect(live.nextSnapshot?.outputs?.[0]?.text).toBe("checking one\nchecking two\n")
    if (live.nextSnapshot === undefined) throw new Error("live-output-growth is missing its next snapshot")
    const renderLive = createRenderer({ cols: 200, rows: 50 })
    const outputFrame = renderLive(createElement(QueueWatchFrame, { snapshot: live.snapshot, paused: false }))
    try {
      await outputFrame.waitForLayoutStable()
      expect(outputFrame.text).toContain("checking one")
      const nextOutputFrame = renderLive(createElement(QueueWatchFrame, { snapshot: live.nextSnapshot, paused: false }))
      await nextOutputFrame.waitForLayoutStable()
      expect(nextOutputFrame.text).toContain("checking one")
      expect(nextOutputFrame.text).toContain("checking two")
      expect(nextOutputFrame.text).toContain("RUN")
    } finally {
      outputFrame.unmount()
    }

    const anchored = queueTimelineStories["anchored-new"]
    if (anchored.nextSnapshot === undefined) throw new Error("anchored-new is missing its next snapshot")
    const renderAnchored = createRenderer({ cols: 200, rows: 50 })
    const anchoredFrame = renderAnchored(createElement(QueueWatchFrame, { snapshot: anchored.snapshot, paused: false }))
    try {
      await anchoredFrame.waitForLayoutStable()
      expect(anchoredFrame.text).not.toContain("1 new")
      const nextAnchoredFrame = renderAnchored(
        createElement(QueueWatchFrame, { snapshot: anchored.nextSnapshot, paused: false }),
      )
      await nextAnchoredFrame.waitForLayoutStable()
      expect(nextAnchoredFrame.text).toContain("1 new")
    } finally {
      anchoredFrame.unmount()
    }
  })

  it("scrolls detail output independently and resumes tail-follow only at the end", async () => {
    const mixed = queueTimelineStories["mixed-completed"].snapshot
    const outputTemplate = queueTimelineStories["live-output-growth"].snapshot.outputs?.[0]
    if (outputTemplate === undefined) throw new Error("live-output-growth is missing its output fixture")

    const snapshotWithLines = (count: number) => ({
      ...mixed,
      outputs: [
        {
          ...outputTemplate,
          text: `${Array.from(
            { length: count },
            (_, index) => `detail-line-${String(index + 1).padStart(3, "0")}`,
          ).join("\n")}\n`,
        },
      ],
    })

    const render = createRenderer({ cols: 200, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: snapshotWithLines(80), paused: false }))
    try {
      await handle.waitForLayoutStable()
      await handle.press("j")
      await handle.press("j")
      await handle.press("j")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("MEMBERS PR3")
      expect(handle.text).toContain("detail-line-080")

      // This long fixture makes the lossless follow contract observable: wheel
      // input targets the detail pane, never the selected master-list row.
      for (let index = 0; index < 40; index += 1) await handle.wheel(150, 30, -3)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-line-001")
      expect(handle.text).toContain("MEMBERS PR3")

      handle.rerender(createElement(QueueWatchFrame, { snapshot: snapshotWithLines(81), paused: false }))
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-line-001")
      expect(handle.text).not.toContain("detail-line-081")
      expect(handle.text).toContain("MEMBERS PR3")

      for (let index = 0; index < 40; index += 1) await handle.wheel(150, 30, 3)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-line-081")
      expect(handle.text).toContain("MEMBERS PR3")

      handle.rerender(createElement(QueueWatchFrame, { snapshot: snapshotWithLines(82), paused: false }))
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-line-082")
      expect(handle.text).toContain("MEMBERS PR3")
    } finally {
      handle.unmount()
    }
  })

  it("opens the filter and selected-run evidence panes from the documented controls", async () => {
    const story = queueTimelineStories["detail-controls"]
    const viewport = story.viewport
    if (viewport === undefined) throw new Error("detail-controls is missing its viewport")
    const handle = await run(createElement(QueueWatchFrame, { snapshot: story.snapshot, paused: false }), {
      writable: { write: () => {} },
      cols: viewport.columns,
      rows: viewport.rows,
    })
    try {
      expect(handle.text).toContain("MEMBERS PR4")
      expect(handle.text).toContain("f filters")
      expect(handle.text).toContain("o evidence")

      await handle.press("f")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("FILTERS")
      expect(handle.text).toContain("STATUS pending,running,rejected,integrated,other")

      await handle.press("Escape")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("MEMBERS PR4")

      await handle.press("o")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("EVIDENCE R4")
      expect(handle.text).toContain("LANDING")

      await handle.press("Escape")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("MEMBERS PR4")
    } finally {
      handle.unmount()
    }
  })

  it("keeps pointer selection equivalent to keyboard cursor movement", async () => {
    const story = queueTimelineStories["pending-only"]
    const render = createRenderer({ cols: 200, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: story.snapshot, paused: false }))
    try {
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PR PR1 STATUS")

      // Seven summary lines plus the table header put the second height-1 row at y=9.
      await handle.click(2, 9)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PR PR2 STATUS")
      expect(handle.text).not.toContain("PR PR1 STATUS")
    } finally {
      handle.unmount()
    }
  })
})
