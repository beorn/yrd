// @failure Queue timeline story fixtures drift from the renderer or developer viewer
// @level l2
// @consumer @yrd/cli

import { act, createElement } from "react"
import { createRenderer, createTermless, waitFor } from "silvery/test"
import { renderString } from "silvery"
import { run } from "silvery/runtime"
import { describe, expect, it } from "vitest"
import { QUEUE_TIMELINE_STORY_NAMES, queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  QUEUE_TIMELINE_STORYBOOK_CONTRACT,
  QUEUE_TIMELINE_STORYBOOK_EXTERNAL_OWNERS,
  QueueTimelineStorybook,
} from "../dev/queue-timeline-storybook.tsx"
import { QueueTimelineView } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const STORY_NAMES = [
  "production-overview",
  "contract-overview",
  "idle",
  "multiple-queues",
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
      expect(frame).toContain("PRs PR42@r1:cccccccccccc,PR43@r1:dddddddddddd")
      expect(frame).toContain("RUN R42 STATUS running OUTCOME running")
      expect(frame).toContain("STEP check#2 running")
      expect(frame).toContain("OUTPUT check#2")
      expect(frame).toContain("q quit - enter/esc show/hide detail - p/r/f/d toggle filters - h/j/k/l navigate")
      expect(frame).not.toContain("No matching queue rows.")
    } finally {
      handle.unmount()
    }
  })

  it("restores the wide BY column when Escape closes right-side detail", async () => {
    using term = createTermless({ cols: 160, rows: 50 })
    const handle = await run(createElement(QueueTimelineStorybook), term, {
      mouse: true,
      selection: false,
    })
    const timelineHeader = (): string | undefined =>
      term.screen
        .getText()
        .split("\n")
        .find((line) => line.includes("TIME") && line.includes("STATUS") && line.includes("STEP"))
    try {
      await waitFor(() => term.screen.getText().includes("production-overview"))
      expect(timelineHeader()).not.toContain("BY")
      expect(term.screen.getText()).toContain(
        "q quit - enter/esc show/hide detail - p/r/f/d toggle filters - h/j/k/l navigate",
      )

      await act(async () => {
        await handle.press("Escape")
        await handle.waitForLayoutStable()
      })

      await waitFor(() => timelineHeader()?.includes("BY") === true)
      expect(timelineHeader()).toContain("BY")
      expect(term.screen.getText()).toContain(
        "q quit - enter/esc show/hide detail - p/r/f/d toggle filters - h/j/k/l navigate",
      )
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
      expect(term.screen.getText()).toContain("PR42.1")
      expect(term.screen.getText()).toContain("PR43.1")
      expect(term.screen.getText()).toContain(
        "q quit - enter/esc show/hide detail - p/r/f/d toggle filters - h/j/k/l navigate",
      )

      await act(async () => {
        await handle.press("Enter")
        await handle.waitForLayoutStable()
      })
      const detail = term.screen.getText()
      expect(detail).toContain("RUN R42 STATUS running OUTCOME running")
      expect(detail).toContain("JOB J42-check RUNNER runner-herdr-07")
      // Detail clocks share the timeline convention: local HH:MM:SS with a
      // cross-day date qualifier (fixtures are 2026-07-13, tests run later).
      expect(detail).toMatch(/LEASE \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u)
      expect(detail).not.toContain("QUEUE main")
    } finally {
      handle.unmount()
    }
  })

  it("advances shared snapshots without remounting the interactive watch state", async () => {
    using term = createTermless({ cols: 200, rows: 50 })
    const handle = await run(createElement(QueueTimelineStorybook), term, {
      mouse: true,
      selection: false,
    })
    try {
      await waitFor(() => term.screen.getText().includes("production-overview"))
      const anchoredStoryIndex = STORY_NAMES.indexOf("anchored-new")
      for (let index = 0; index < anchoredStoryIndex; index += 1) {
        await handle.press("]")
        await handle.waitForLayoutStable()
      }
      await waitFor(() => term.screen.getText().includes("anchored-new · initial"))

      await handle.press("n")
      await waitFor(() => term.screen.getText().includes("anchored-new · next"))

      // The next snapshot must update the existing frame. Remounting loses the
      // anchor/follow state and makes this named visual story falsely show no new rows.
      expect(term.screen.getText()).toContain("1 new")
    } finally {
      handle.unmount()
    }
  })

  it("shares realistic production contracts across lifecycle, batch, lineage, proof, and output stories", () => {
    const overview = queueTimelineStories["production-overview"].snapshot
    const overviewResult = overview.results[0]
    if (overviewResult === undefined) throw new Error("production-overview is missing its queue result")

    expect(overview.projection.rows.map((row) => [row.status, row.pr])).toEqual([
      ["running", "PR42"],
      ["running", "PR43"],
      ["canceled", "PR7"],
      ["environment-refused", "PR6"],
      ["rejected", "PR5"],
      ["integrated", "PR4"],
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

  it("publishes the recovered contract against one shared fixture graph", () => {
    const coveredStories = QUEUE_TIMELINE_STORYBOOK_CONTRACT.flatMap(({ stories }) => [...stories])

    expect([...new Set(coveredStories)].sort()).toEqual([...STORY_NAMES].sort())
    expect(QUEUE_TIMELINE_STORYBOOK_EXTERNAL_OWNERS).toEqual({
      degradedQueueStatus: "packages/yrd-cli/src/queue-status-view.tsx",
      followPauseAndEndResume: "packages/yrd-cli/src/watch-pane.tsx",
      rootQueueWiring: "packages/yrd-cli/src/run.ts",
    })
    expect(queueTimelineStories["multiple-queues"].snapshot.results.map(({ base }) => base)).toEqual([
      "main",
      "release/next",
    ])
    expect(queueTimelineStories["narrow-wide"].widths).toEqual([80, 120, 160, 200])
    expect(queueTimelineStories["long-subject"].widths).toEqual([80, 120, 160, 200])
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
        const rendered = await renderString(createElement(QueueTimelineView, { projection, columns: width }), {
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
        if (name === "anchored-new") {
          expect(story.nextSnapshot.projection?.now, name).toBe(projection.now)
        } else {
          expect(Date.parse(story.nextSnapshot.projection?.now ?? ""), name).toBeGreaterThan(Date.parse(projection.now))
          expect(story.nextSnapshot.now, name).toBe(Date.parse(story.nextSnapshot.projection?.now ?? ""))
        }
      }
    }
  })

  it("surfaces the latest revision submitter in the wide BY column and hides it on the narrow tier", async () => {
    const projection = queueTimelineStories["production-overview"].snapshot.projection
    const header = (frame: string) =>
      frame.split("\n").find((line) => line.includes("TIME") && line.includes("RUN") && line.includes("PR"))
    const wide = await renderString(createElement(QueueTimelineView, { projection, columns: 120 }), {
      width: 120,
      height: 20,
      plain: true,
    })
    expect(header(wide), "wide header").toContain("BY")
    const batchRow = wide.split("\n").find((row) => row.includes("PR42.1"))
    expect(batchRow, "batch revision row").toContain("@agent/3")
    const environmentRow = wide.split("\n").find((row) => row.includes("PR6.1"))
    // PR6's revision has no recorded submitter, so its BY cell falls back to "-" (no handle).
    expect(environmentRow, "environment run row").not.toContain("@")

    const narrow = await renderString(createElement(QueueTimelineView, { projection, columns: 90 }), {
      width: 90,
      height: 20,
      plain: true,
    })
    expect(header(narrow), "narrow header").not.toContain("BY")
  })

  it.each(TERMLESS_DETAIL_TIERS)(
    "renders the $name A15 tier through a real terminal buffer",
    async ({ name, divider }) => {
      const story = queueTimelineStories[name]
      const viewport = story.viewport
      if (viewport === undefined) throw new Error(`story '${name}' is missing its viewport`)

      using term = createTermless({ cols: viewport.columns, rows: viewport.rows })
      const handle = await run(createElement(QueueWatchFrame, { snapshot: story.snapshot }), term, {
        mouse: true,
        selection: false,
      })
      try {
        await waitFor(() => term.screen.getText().includes("QUEUE main"))
        expect(term.screen.getText(), name).toContain("QUEUE main")

        if (divider === "vertical") {
          // Right-docked: the framed DETAIL pane title shares the top row
          // with the QUEUE pane title, and the split divider is the lone
          // vertical glyph on that row.
          await waitFor(() => findGlyphColumn(term, "│", 0) >= 0)
          const topRow = term.screen.getText().split("\n")[0] ?? ""
          expect(topRow, name).toContain("DETAIL")
          expect(findGlyphColumn(term, "│", 0), name).toBeGreaterThan(0)
          expect(term.screen.getText(), name).toContain("PRs PR4")
        } else if (divider === "horizontal") {
          // Below-docked: DETAIL renders under the list, not on the top row.
          await waitFor(() => term.screen.getText().includes("DETAIL"))
          const topRow = term.screen.getText().split("\n")[0] ?? ""
          expect(topRow, name).not.toContain("DETAIL")
          expect(term.screen.getText(), name).toContain("PRs PR4")
        } else {
          expect(term.screen.getText(), name).not.toContain("PRs PR4")
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
    const handle = await run(createElement(QueueWatchFrame, { snapshot: story.snapshot }), term, {
      mouse: true,
      selection: false,
    })
    try {
      await waitFor(() => term.screen.getText().includes("PRs PR3@r1"))
      // Row 0 carries the two pane titles; the only vertical glyph there is
      // the SplitPane divider (pane side walls start below the title rows).
      const initialDivider = findGlyphColumn(term, "│", 0)
      expect(initialDivider).toBeGreaterThan(0)
      const draggedDivider = initialDivider + 12

      await term.mouse.down(initialDivider, 1)
      await term.mouse.move(draggedDivider, 1)
      await waitFor(() => findGlyphColumn(term, "│", 0) === draggedDivider)
      await term.mouse.up(draggedDivider, 1)

      await handle.press("j")
      await waitFor(() => term.screen.getText().includes("PRs PR7@r1"))
      expect(findGlyphColumn(term, "│", 0)).toBe(draggedDivider)
    } finally {
      handle.unmount()
    }
  })

  it("drives the shared master-detail and live-output stories without reopening", async () => {
    for (const name of ["detail-right", "detail-below", "detail-full"] as const) {
      const story = queueTimelineStories[name]
      const viewport = story.viewport
      if (viewport === undefined) throw new Error(`story '${name}' is missing its viewport`)
      const handle = await run(createElement(QueueWatchFrame, { snapshot: story.snapshot }), {
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
    const fullAtNaturalBoundary = await run(createElement(QueueWatchFrame, { snapshot: boundaryStory.snapshot }), {
      writable: { write: () => {} },
      cols: 100,
      rows: 32,
    })
    const belowAfterNaturalBoundary = await run(createElement(QueueWatchFrame, { snapshot: boundaryStory.snapshot }), {
      writable: { write: () => {} },
      cols: 100,
      rows: 33,
    })
    try {
      expect(fullAtNaturalBoundary.text).not.toContain("PRs PR4")
      expect(fullAtNaturalBoundary.text).toContain("PR4.1")
      expect(belowAfterNaturalBoundary.text).toContain("PRs PR4")
      expect(belowAfterNaturalBoundary.text).toContain("PR4.1")
    } finally {
      fullAtNaturalBoundary.unmount()
      belowAfterNaturalBoundary.unmount()
    }

    const right = createRenderer({ cols: 160, rows: 50 })(
      createElement(QueueWatchFrame, {
        snapshot: queueTimelineStories["production-overview"].snapshot,
        paused: false,
      }),
    )
    try {
      await right.waitForLayoutStable()
      const header = right.text.split("\n").find((row) => row.includes("TIME") && row.includes("STEP"))
      expect(header).toContain("STATUS")
      expect(header).not.toContain("BY")
      expect(right.text).toContain("PR42.1")
      expect(right.text).toContain("◷20:00")
    } finally {
      right.unmount()
    }

    const live = queueTimelineStories["live-output-growth"]
    expect(live.snapshot.outputs?.[0]?.text).toBe("checking one\n")
    expect(live.nextSnapshot?.outputs?.[0]?.text).toBe("checking one\nchecking two\n")
    if (live.nextSnapshot === undefined) throw new Error("live-output-growth is missing its next snapshot")
    const renderLive = createRenderer({ cols: 200, rows: 50 })
    const outputFrame = renderLive(createElement(QueueWatchFrame, { snapshot: live.snapshot }))
    try {
      await outputFrame.waitForLayoutStable()
      expect(outputFrame.text).toContain("checking one")
      const nextOutputFrame = renderLive(createElement(QueueWatchFrame, { snapshot: live.nextSnapshot }))
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
    const anchoredFrame = renderAnchored(createElement(QueueWatchFrame, { snapshot: anchored.snapshot }))
    try {
      await anchoredFrame.waitForLayoutStable()
      expect(anchoredFrame.text).not.toContain("1 new")
      const nextAnchoredFrame = renderAnchored(createElement(QueueWatchFrame, { snapshot: anchored.nextSnapshot }))
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
          text: `${Array.from({ length: count }, (_, index) => `detail-row-${String(index + 1).padStart(3, "0")}`).join(
            "\n",
          )}\n`,
        },
      ],
    })

    const render = createRenderer({ cols: 200, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: snapshotWithLines(80) }))
    try {
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PRs PR3")
      expect(handle.text).toContain("detail-row-080")

      // This long fixture makes the lossless follow contract observable: wheel
      // input targets the detail pane, never the selected master-list row.
      for (let index = 0; index < 40; index += 1) await handle.wheel(150, 30, -3)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-001")
      expect(handle.text).toContain("PRs PR3")

      handle.rerender(createElement(QueueWatchFrame, { snapshot: snapshotWithLines(81) }))
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-001")
      expect(handle.text).not.toContain("detail-row-081")
      expect(handle.text).toContain("PRs PR3")

      for (let index = 0; index < 40; index += 1) await handle.wheel(150, 30, 3)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-081")
      expect(handle.text).toContain("PRs PR3")

      handle.rerender(createElement(QueueWatchFrame, { snapshot: snapshotWithLines(82) }))
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-082")
      expect(handle.text).toContain("PRs PR3")
    } finally {
      handle.unmount()
    }
  })

  it("drives the status-filter toggles and evidence section from the documented controls", async () => {
    const story = queueTimelineStories["detail-controls"]
    const viewport = story.viewport
    if (viewport === undefined) throw new Error("detail-controls is missing its viewport")
    const handle = await run(createElement(QueueWatchFrame, { snapshot: story.snapshot }), {
      writable: { write: () => {} },
      cols: viewport.columns,
      rows: viewport.rows,
    })
    try {
      expect(handle.text).toContain("PRs PR4")
      expect(handle.text).toContain("p/r/f/d toggle filters")

      // `f` is the failed-bucket toggle (user respec 2026-07-15): the lone
      // integrated run stays visible and the checkbox flips off and back.
      expect(handle.text).toContain("[x] failed")
      await handle.press("f")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("[ ] failed")
      expect(handle.text).toContain("PR4.1")
      await handle.press("f")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("[x] failed")

      // `d` hides the done bucket — the integrated row leaves the list.
      await handle.press("d")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("[ ] done")
      expect(handle.text).not.toContain("PR4.1 Land the durable patch")
      await handle.press("d")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PR4.1 Land the durable patch")

      // `o` expands the EVIDENCE section inside the detail body.
      await handle.press("o")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("EVIDENCE R4")
      expect(handle.text).toContain("LANDING")

      // Esc hides the detail pane; the list keeps running.
      await handle.press("Escape")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PR4.1")
    } finally {
      handle.unmount()
    }
  })

  it("keeps pointer selection equivalent to keyboard cursor movement", async () => {
    const story = queueTimelineStories["pending-only"]
    const render = createRenderer({ cols: 200, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: story.snapshot }))
    try {
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PR PR1 STATUS")

      const rows = handle.text.split("\n")
      const pr2Y = rows.findIndex((row) => row.includes("PR2.1"))
      expect(pr2Y, "PR2 screen row").toBeGreaterThanOrEqual(0)
      const pr2Row = rows[pr2Y]
      if (pr2Row === undefined) throw new Error("pending-only story did not render the PR2 revision row")
      const pr2X = pr2Row.indexOf("PR2.1")
      expect(pr2X, "PR2 screen column").toBeGreaterThanOrEqual(0)
      await handle.click(pr2X, pr2Y)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PR PR2 STATUS")
      expect(handle.text).not.toContain("PR PR1 STATUS")
    } finally {
      handle.unmount()
    }
  })
})
