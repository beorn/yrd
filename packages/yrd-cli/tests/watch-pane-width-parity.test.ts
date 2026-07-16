// @failure QueueWatchFrame formats the timeline for a width that diverges from its rendered SplitPane allocation
// @level l1
// @consumer @yrd/cli

import { describe, expect, test } from "vitest"
import { queueTimelineColumns } from "../src/watch-pane.tsx"

describe("watch pane width parity", () => {
  test("matches SplitPane's rounded right-split allocation without a gap", () => {
    const columns = 160
    const primary = queueTimelineColumns(columns, "right", true, 0.52)
    const secondary = columns - primary - 1

    expect(primary).toBe(83)
    expect(secondary).toBe(76)
    expect(primary + 1 + secondary).toBe(columns)
  })

  test("restores the full timeline width when the detail pane closes", () => {
    expect(queueTimelineColumns(160, "right", false, 0.52)).toBe(160)
  })

  test("keeps non-right layouts at full terminal width", () => {
    expect(queueTimelineColumns(100, "below", true, 0.52)).toBe(100)
    expect(queueTimelineColumns(80, "full", true, 0.52)).toBe(80)
  })
})
