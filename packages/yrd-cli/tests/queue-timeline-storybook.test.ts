// @failure Queue timeline story fixtures drift from the renderer or developer viewer
// @level l2
// @consumer @yrd/cli

import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { QUEUE_TIMELINE_STORY_NAMES, queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import { QueueTimelineView } from "../src/queue-status-view.tsx"

describe("queue timeline storybook", () => {
  it("shares every deterministic story with the termless acceptance surface", async () => {
    expect(QUEUE_TIMELINE_STORY_NAMES).toEqual([
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
      "drill-in-open",
    ])
    expect(Object.keys(queueTimelineStories)).toEqual(QUEUE_TIMELINE_STORY_NAMES)

    for (const name of QUEUE_TIMELINE_STORY_NAMES) {
      const story = queueTimelineStories[name]
      expect(story.projection.now).toBe("2026-07-13T12:00:00.000Z")
      for (const width of story.widths) {
        const rendered = await renderString(
          createElement(QueueTimelineView, { projection: story.projection, interactive: false }),
          { width, height: 24, plain: true },
        )
        expect(rendered, name).toContain(`QUEUE ${story.projection.base}`)
        expect(
          Math.max(...rendered.split("\n").map((line) => line.length)),
          `${name} at ${width} columns`,
        ).toBeLessThanOrEqual(width)
      }
      if (story.openRun !== undefined) {
        expect(
          story.projection.details.some((detail) => detail.run === story.openRun),
          name,
        ).toBe(true)
      }
      if (story.nextProjection !== undefined) {
        expect(story.nextProjection.now).toBe("2026-07-13T12:00:00.000Z")
        expect(story.nextProjection.rows.length, name).toBeGreaterThanOrEqual(story.projection.rows.length)
      }
    }
  })
})
