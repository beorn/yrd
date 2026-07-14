// @failure Queue timeline story fixtures drift from the renderer or developer viewer
// @level l2
// @consumer @yrd/cli

import { createElement } from "react"
import { createRenderer } from "@silvery/test"
import { renderString } from "silvery"
import { run } from "silvery/runtime"
import { describe, expect, it } from "vitest"
import { QUEUE_TIMELINE_STORY_NAMES, queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineView } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const STORY_NAMES = [
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

describe("queue timeline storybook", () => {
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
          Math.max(...rendered.split("\n").map((row) => row.length)),
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
          text: `${Array.from({ length: count }, (_, index) => `detail-row-${String(index + 1).padStart(3, "0")}`).join(
            "\n",
          )}\n`,
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
      expect(handle.text).toContain("detail-row-080")

      // This long fixture makes the lossless follow contract observable: wheel
      // input targets the detail pane, never the selected master-list row.
      for (let index = 0; index < 40; index += 1) await handle.wheel(150, 30, -3)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-001")
      expect(handle.text).toContain("MEMBERS PR3")

      handle.rerender(createElement(QueueWatchFrame, { snapshot: snapshotWithLines(81), paused: false }))
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-001")
      expect(handle.text).not.toContain("detail-row-081")
      expect(handle.text).toContain("MEMBERS PR3")

      for (let index = 0; index < 40; index += 1) await handle.wheel(150, 30, 3)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-081")
      expect(handle.text).toContain("MEMBERS PR3")

      handle.rerender(createElement(QueueWatchFrame, { snapshot: snapshotWithLines(82), paused: false }))
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("detail-row-082")
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

      // Seven summary rows plus the table header put the second height-1 row at y=9.
      await handle.click(2, 9)
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PR PR2 STATUS")
      expect(handle.text).not.toContain("PR PR1 STATUS")
    } finally {
      handle.unmount()
    }
  })
})
