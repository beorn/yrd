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
  it("renders the recovered queue IA without legacy task or disclosure chrome", async () => {
    using term = createTermless({ cols: 200, rows: 50 })
    const handle = await run(
      createElement(QueueWatchFrame, { snapshot: queueTimelineStories["production-overview"].snapshot }),
      term,
      { mouse: true, selection: false },
    )
    try {
      // Wait for the PR-scoped detail title (which paints after the QUEUE list)
      // so the captured frame is stable — the title now carries pr#id + issue.
      await waitFor(() => term.screen.getText().includes("pr#42.1 @hab/super/21135-herdr-keybindings"))
      const frame = term.screen.getText()

      expect(frame).not.toMatch(/\[(?: |\/|!|x|-)\]/u)
      expect(frame).not.toMatch(/(?:^|\s)[>v]\s+(?:PRS|RUN LOGS)/mu)
      expect(frame).not.toMatch(/(?:^|\s)(?:▸|•)\s+PRS\b/gmu)
      expect(frame).not.toContain("RUN LOGS")
      expect(frame).not.toContain("OUTPUT check#")
      expect(frame).not.toContain("DETAILS")
      expect(frame).toContain("pr#42.1 @hab/super/21135-herdr-keybindings")
      // The synthetic `0: submit` tab is gone (user directive 2026-07-21); the
      // tabs are the real workflow steps, numbered from 1.
      expect(frame).toContain("2: check")
      expect(frame).toContain("pr#42.1")
      expect(frame).toContain("╭─ RUNNER ")
      expect(frame).toContain("╭─ FLOW ")
      expect(frame).toContain("╭─ TIME ")

      // Tabs follow the live step (item 4): `check` is selected by default, so
      // the two-row tab strip and the running check step's command output stream
      // inline without navigating (the `0: submit` tab and its navigation to a
      // separate output header are gone).
      const lines = frame.split("\n")
      const prepareRowIndex = lines.findIndex((line) => line.includes("1: prepare"))
      expect(prepareRowIndex).toBeGreaterThan(0)
      expect(lines[prepareRowIndex]).not.toMatch(/(?:^|\s)(?:passed|running|pending|failed)(?:\s|$)/u)
      expect(lines.slice(prepareRowIndex + 1, prepareRowIndex + 3).join("\n")).toMatch(
        /(?:✓|◉|○|×|−)\s+(?:passed|running|pending|failed|skipped)/u,
      )

      const commandRowIndex = lines.findIndex((row) => row.includes(" $ bun vitest run"))
      expect(commandRowIndex).toBeGreaterThan(0)
      expect(lines[commandRowIndex]).not.toContain("[ $")
      expect(lines[commandRowIndex]).not.toContain("COMMAND")
      expect(frame).toContain("125 tests collected")

      // The PR/submission overview is restored as tab 0 (user directive
      // 2026-07-21), ahead of the real step tabs; the diff lives there, not on
      // the default running-step tab. Navigate left from `check` (tab 2) past
      // `prepare` (tab 1) to reach the PR tab (tab 0).
      await act(async () => {
        await handle.press("h")
        await handle.press("h")
        await handle.waitForLayoutStable()
      })
      const prFrame = term.screen.getText()
      expect(prFrame).toContain("Diff +324 / -323 lines")
    } finally {
      handle.unmount()
    }
  })

  it("opens on meaningful production queue rows and selected run detail", async () => {
    using term = createTermless({ cols: 200, rows: 50 })
    const handle = await run(createElement(QueueTimelineStorybook), term, {
      mouse: true,
      selection: false,
    })
    try {
      // Wait for the detail's step tabs to paint (they follow the QUEUE list)
      // so the captured frame is stable under the recovered IA.
      await waitFor(() => {
        const text = term.screen.getText()
        return text.includes("production-overview") && text.includes("2: check")
      })
      const frame = term.screen.getText()
      expect(frame).toContain("QUEUE main")
      expect(frame).toContain("running")
      expect(frame).not.toMatch(/(?:^|\s)(?:▸|•)\s+PRS\b/gmu)
      // The synthetic `0: submit` tab is gone (user directive 2026-07-21).
      expect(frame).toContain("2: check")
      expect(frame).toContain("pr#42.1")
      // Run identity + STATUS/OUTCOME live in the title row; the tabs follow the
      // live step (item 4), so `check` is selected by default and its output
      // streams inline with no navigation and no repeated PR or output header.
      expect(frame).toContain("RUN main#42")
      expect(frame).toContain("125 tests collected")
      expect(frame).not.toContain("RUN LOGS")
      expect(frame).not.toContain("OUTPUT check#2")
      // The bottom keybindings footer was removed entirely (item h).
      expect(frame).not.toContain("q quit")
      expect(frame).not.toContain("No matching queue rows.")
    } finally {
      handle.unmount()
    }
  })

  it("renders rejected detail without repeated PR, accordion, or DETAILS chrome", async () => {
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot: queueTimelineStories["selected-rejected"].snapshot }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).not.toMatch(/(?:^|\s)(?:▸|•)\s+PRS\b/gmu)
      expect(app.text).not.toContain("RUN LOGS")
      expect(app.text).not.toContain("DETAILS")
      // The synthetic `0: submit` tab is gone (user directive 2026-07-21); the
      // rejected run's single real step tab is `1: check`, and the failed
      // step is the truthful default selection.
      expect(app.text).toContain("1: check")
      expect(app.text).toContain("JOB")
      expect(app.text).toContain("RUNNER")
    } finally {
      app.unmount()
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
        .find((row) => row.includes("TIME") && row.includes("STATUS") && row.includes("PR"))
    try {
      await waitFor(() => term.screen.getText().includes("production-overview"))
      expect(timelineHeader()).not.toContain("BY")
      // The bottom keybindings footer was removed entirely (item h).
      expect(term.screen.getText()).not.toContain("q quit")

      await act(async () => {
        await handle.press("Escape")
        await handle.waitForLayoutStable()
      })

      await waitFor(() => timelineHeader()?.includes("BY") === true)
      expect(timelineHeader()).toContain("BY")
      expect(term.screen.getText()).not.toContain("q quit")
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
      const queue = term.screen.getText()
      expect(queue).toContain("pr#42.1")
      expect(queue).toContain("pr#43.1")
      // The grouped round-5 metrics are secondary to the queue itself. At the
      // 24-row compact tier, omit the whole pair instead of collapsing the
      // ListView to zero rows or clipping a partially truthful metric group.
      expect(queue).not.toContain("╭─ FLOW ")
      expect(queue).not.toContain("╭─ TIME ")
      // The bottom keybindings footer was removed entirely (item h).
      expect(queue).not.toContain("q quit")

      await act(async () => {
        await handle.press("Enter")
        await handle.waitForLayoutStable()
      })
      const detail = term.screen.getText()
      // Run identity + STATUS/OUTCOME live in the title row. The 24-row full
      // tier shows the complete PR facts first; step internals remain below
      // the viewport and are covered by the wide Round-6 acceptance story.
      expect(detail).toContain("RUN main#42")
      expect(detail).not.toContain("runner-herdr-07")
      expect(detail).not.toContain("DETAILS")
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

      // The next snapshot updates the existing frame and keeps physical row 0
      // live without requiring a catch-up affordance or remount.
      expect(term.screen.getText()).toContain("pr#13.1")
      expect(term.screen.getText()).not.toMatch(/new runs?|G jumps/u)
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
    expect(overview.outputs?.filter((output) => output.source === "recorded").map((output) => output.path)).toEqual([
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
    expect(
      live.snapshot.outputs
        ?.filter((output) => output.source === "recorded")
        .map((output) => output.path.split("/").at(-1)),
    ).toEqual(["stdout.log", "stderr.log"])
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
          // Static queue output is unbounded in production. Round 5's grouped
          // TIME box needs the taller fixture canvas so this cross-width
          // contract tests content and wrapping rather than crop behavior.
          height: 48,
          plain: true,
        })
        expect(rendered, name).toContain(`QUEUE ${projection.base}`)
        expect(
          Math.max(...rendered.split("\n").map((row) => row.length)),
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
      frame.split("\n").find((row) => row.includes("TIME") && row.includes("RUN") && row.includes("PR"))
    // Height fits the FLOW/TIME boxes; the standalone
    // QueueTimelineView has no fillHeight list-scroll, so a fixed box tuned to the
    // old short metrics box would clip the header. Production (QueueWatchFrame) keeps
    // the header at any height via the scrolling list.
    const wide = await renderString(createElement(QueueTimelineView, { projection, columns: 120 }), {
      width: 120,
      height: 40,
      plain: true,
    })
    expect(header(wide), "wide header").toContain("BY")
    const batchRow = wide.split("\n").find((row) => row.includes("pr#42.1"))
    expect(batchRow, "batch revision row").toContain("@agent/3")
    const environmentRow = wide.split("\n").find((row) => row.includes("pr#6.1"))
    // PR6's revision has no recorded submitter, so its BY cell falls back to "-" (no handle).
    expect(environmentRow, "environment run row").not.toContain("@")

    const narrow = await renderString(createElement(QueueTimelineView, { projection, columns: 90 }), {
      width: 90,
      height: 40,
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
          // Right-docked: the DETAIL pane's run identity title shares the top
          // row with the QUEUE tab, and the
          // split divider is the lone vertical glyph on that row.
          await waitFor(() => findGlyphColumn(term, "│", 0) >= 0)
          const topRow = term.screen.getText().split("\n")[0] ?? ""
          // The detail title is PR-scoped now (user directive 2026-07-21): the
          // selected run's PR identity (`pr#4.1`), not `RUN main#N`, is the title.
          expect(topRow, name).toContain("pr#4.1")
          expect(topRow, "detail identity is a flush-top title, not a DETAIL tab").not.toContain("DETAIL")
          expect(findGlyphColumn(term, "│", 0), name).toBeGreaterThan(0)
          // The run/timing header persists above every detail tab. The newest
          // terminal step is selected by default.
          expect(term.screen.getText(), name).toContain("RUN main#4")
        } else if (divider === "horizontal") {
          // Below-docked: the detail renders under the list, so the identity
          // title is not on the top row (which holds only the QUEUE tab).
          const topRow = term.screen.getText().split("\n")[0] ?? ""
          expect(topRow, name).not.toContain("RUN main#4")
          // The run/timing header persists above every detail tab. The newest
          // terminal step is selected by default.
          await waitFor(() => term.screen.getText().includes("RUN main#4"))
          expect(term.screen.getText(), name).toContain("RUN main#4")
        } else {
          expect(term.screen.getText(), name).not.toContain("RUN main#4")
          await act(async () => {
            await handle.press("Enter")
            await handle.waitForLayoutStable()
          })
          // Run identity + STATUS/OUTCOME live in the title row now (item a).
          expect(term.screen.getText(), name).toContain("RUN main#4")
          expect(term.screen.getText(), name).toContain("passed, integrated")
          // The integration proof (COMMIT/PARENTS) lives in the merge-step tab
          // panel now. At the 24-row full tier the PR-scoped header + run region
          // fill the pane, leaving one content row in the tab panel, so the
          // merge-tab STRIP is the visible proof that the integrated run's merge
          // step is reached — the COMMIT body itself needs a taller viewport
          // (covered by the wide detail-controls story).
          expect(term.screen.getText(), name).toContain("2: merge")
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
      await waitFor(() => term.screen.getText().includes("RUN main#3"))
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
      // R7 is canceled (no running step), so its detail opens on the restored
      // PR tab (user directive 2026-07-21) rather than a `RUN main#7` step
      // tab; the PR identity title is the stable readiness marker instead.
      await waitFor(() => term.screen.getText().includes("pr#7.1"))
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
        // The run/timing header persists above every detail tab, and the
        // newest terminal step is the default.
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
      expect(fullAtNaturalBoundary.text).not.toContain("RUN main#4")
      expect(fullAtNaturalBoundary.text).toContain("pr#4.1")
      expect(belowAfterNaturalBoundary.text).toContain("RUN main#4")
      expect(belowAfterNaturalBoundary.text).toContain("pr#4.1")
    } finally {
      fullAtNaturalBoundary.unmount()
      belowAfterNaturalBoundary.unmount()
    }

    const right = createRenderer({ cols: 160, rows: 50 })(
      createElement(QueueWatchFrame, {
        snapshot: queueTimelineStories["production-overview"].snapshot,
      }),
    )
    try {
      await right.waitForLayoutStable()
      const header = right.text.split("\n").find((row) => row.includes("TIME") && row.includes("PR"))
      expect(header).toContain("STATUS")
      expect(header).not.toContain("BY")
      expect(right.text).toContain("pr#42.1")
      expect(right.text).toContain("20:00")
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
      // The run's only step is running, so the detail already opens on that
      // step tab (user directive 2026-07-21) — no navigation needed.
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
      expect(nextAnchoredFrame.text).toContain("pr#13.1")
      expect(nextAnchoredFrame.text).not.toMatch(/new runs?|G jumps/u)
    } finally {
      anchoredFrame.unmount()
    }
  })

  it("scrolls complete detail output and follows appended output only from the shared tail", async () => {
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
      // main#3's only step ("check") is running, so the detail opens
      // directly on that step tab (user directive 2026-07-21) — no
      // navigation needed to reach the RUN header / step output.
      expect(handle.text).toContain("RUN main#3")
      expect(handle.text).toContain("detail-row-080")
      expect(handle.text).not.toContain("detail-row-001")

      // Command output beyond the last 10 body lines collapses behind a
      // `… N earlier lines — click to expand` marker (user directive
      // 2026-07-21). Click it to bring the full body into the shared scroller
      // so scrolling up can reach the first line.
      const expandRows = handle.text.split("\n")
      const expandY = expandRows.findIndex((row) => row.includes("earlier lines"))
      expect(expandY).toBeGreaterThan(0)
      const expandX = (expandRows[expandY]?.indexOf("earlier") ?? 0) + 1
      await handle.click(expandX, expandY)
      await handle.waitForLayoutStable()
      expect(handle.text).not.toContain("earlier lines")

      // Wheel input targets the one shared detail-tab scroller, never the
      // selected master-list row or a nested output-only viewport.
      for (let index = 0; index < 40; index += 1) await handle.wheel(150, 30, -3)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-001")
      expect(handle.text).toContain("RUN main#3")

      handle.rerender(createElement(QueueWatchFrame, { snapshot: snapshotWithLines(81) }))
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-001")
      expect(handle.text).not.toContain("detail-row-081")
      expect(handle.text).toContain("RUN main#3")

      for (let index = 0; index < 40; index += 1) await handle.wheel(150, 30, 3)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-081")
      expect(handle.text).toContain("RUN main#3")

      handle.rerender(createElement(QueueWatchFrame, { snapshot: snapshotWithLines(82) }))
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-082")
      expect(handle.text).toContain("RUN main#3")
    } finally {
      handle.unmount()
    }
  })

  it("drives the status-filter toggles from the documented controls", async () => {
    const story = queueTimelineStories["detail-controls"]
    const viewport = story.viewport
    if (viewport === undefined) throw new Error("detail-controls is missing its viewport")
    const handle = await run(createElement(QueueWatchFrame, { snapshot: story.snapshot }), {
      writable: { write: () => {} },
      cols: viewport.columns,
      rows: viewport.rows,
    })
    try {
      // The run/timing header persists above every detail tab, and the newest
      // terminal step is the default.
      expect(handle.text).toContain("RUN main#4")
      // The FILTER row's TogglePills are the toggles (the footer hint row was
      // removed, item h); the `[f]ailed` pill drives the assertions below.

      // `f` is the failed-bucket toggle (user respec 2026-07-15): the lone
      // integrated run stays visible. The bucket is a TogglePill now (state is
      // colour, label constant), so the toggle is proven by the rows.
      expect(handle.text).toContain("failed")
      await handle.press("f")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("pr#4.1")
      await handle.press("f")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("failed")

      // `d` hides the done bucket — the integrated row leaves the list.
      await handle.press("d")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("done")
      expect(handle.text).not.toContain("pr#4.1")
      await handle.press("d")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("pr#4.1")

      // The `d` toggle remounts the row's detail; the newest terminal merge
      // step remains the truthful default and owns the integration proof.
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("COMMIT ")

      // Esc hides the detail pane; the list keeps running.
      await handle.press("Escape")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("pr#4.1")
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
      expect(handle.text).toContain("pr#1.1")
      // Timeline lines are bare now (user directive 2026-07-21): no leading `- `.
      expect(handle.text).toMatch(/\d{2}:\d{2} r1 submitted by @cto/u)
      expect(handle.text).toMatch(/\d{2}:\d{2} r1 check requested ○ queued position \d+/u)
      // A submitted PR renders with the display-only `ready` status.
      expect(handle.text).toContain("○ ready")
      expect(handle.text).toContain("Prepare release notes")
      expect(handle.text).toContain("pr#1.1 @yrd/core/21120-pr-state-notifications")
      expect(handle.text).toContain("topic/pr1")
      expect(handle.text).not.toMatch(/(?:^|\s)(?:▸|•)\s+PRS\b/gmu)
      expect(handle.text).not.toContain("PR PR1 STATUS")
      expect(handle.text).not.toContain("SOURCE ")
      // `BASE main` is a KEY/value fact row now (user directive 2026-07-21) —
      // the uppercase key is padded to the fact column width — so it is expected
      // in the detail rather than legacy chrome to suppress.
      expect(handle.text).toMatch(/BASE\s+main/u)

      const rows = handle.text.split("\n")
      const pr2Y = rows.findIndex((row) => row.includes("pr#2.1"))
      expect(pr2Y, "PR2 screen row").toBeGreaterThanOrEqual(0)
      const pr2Row = rows[pr2Y]
      if (pr2Row === undefined) throw new Error("pending-only story did not render the PR2 revision row")
      const pr2X = pr2Row.indexOf("pr#2.1")
      expect(pr2X, "PR2 screen column").toBeGreaterThanOrEqual(0)
      await handle.click(pr2X, pr2Y)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("pr#2.1")
      expect(handle.text).toMatch(/\d{2}:\d{2} r1 submitted by -/u)
      expect(handle.text).toContain("○ ready")
      expect(handle.text).not.toContain("submitted by @cto")
    } finally {
      handle.unmount()
    }
  })
})
