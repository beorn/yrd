/**
 * @failure QueueWatchFrame used full terminal width inside a right SplitPane, hiding fixed columns and failing to restore BY after detail closed.
 * @level l2
 * @consumer @yrd/cli QueueWatchFrame SplitPane width and collapse contract (21106)
 */
import { describe, expect, test } from "vitest"
import { queueTimelineColumns } from "../src/watch-pane.tsx"

describe("watch pane width parity", () => {
  test("matches SplitPane's rounded right-split allocation without a gap", () => {
    const columns = 160
    const primary = queueTimelineColumns(columns, "right", true, 0.52)
    const secondary = columns - primary - 1

    // 160 is below LIST_NATURAL_WIDTH + divider + DETAIL_NATURAL_WIDTH (213),
    // so the clamp shrinks both mins in proportion rather than the raw 0.52.
    const listNaturalWidth = 140
    const detailNaturalWidth = 72
    expect(primary).toBe(Math.round((listNaturalWidth / (listNaturalWidth + detailNaturalWidth)) * (columns - 1)))
    expect(primary + 1 + secondary).toBe(columns)
    expect(secondary).toBeGreaterThan(0)
  })

  test("restores the full timeline width when the detail pane closes", () => {
    expect(queueTimelineColumns(160, "right", false, 0.52)).toBe(160)
  })

  test("keeps non-right layouts at full terminal width", () => {
    expect(queueTimelineColumns(100, "below", true, 0.52)).toBe(100)
    expect(queueTimelineColumns(80, "full", true, 0.52)).toBe(80)
  })
})
