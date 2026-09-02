/**
 * @failure `queue list` / `watch` resolved a missing `--since` to a hundred-year
 * window (2026-09-01: 88 MB, rc 124 under a 25 s timeout). The default must be
 * the bounded 7-day window, and `--since` must still be the explicit override.
 * @level l2
 * @consumer @yrd/cli `queue list`, `queue list --watch`, `watch`
 */
import { describe, expect, it } from "vitest"
import { QUEUE_TIMELINE_DEFAULT_WINDOW_MS, QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS } from "@yrd/queue"
import { queueTimelineWindow } from "../src/run.ts"

const DAY_MS = 24 * 60 * 60 * 1_000

describe("the queue timeline window option", () => {
  it("defaults a missing --since to seven days, not to everything", () => {
    expect(QUEUE_TIMELINE_DEFAULT_WINDOW_MS).toBe(7 * DAY_MS)
    expect(queueTimelineWindow(undefined)).toBe(QUEUE_TIMELINE_DEFAULT_WINDOW_MS)
    expect(queueTimelineWindow(undefined)).toBeLessThan(QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS)
  })

  it("keeps --since as the explicit override, in either direction", () => {
    expect(queueTimelineWindow("30d")).toBe(30 * DAY_MS)
    expect(queueTimelineWindow("6h")).toBe(6 * 60 * 60_000)
  })
})
