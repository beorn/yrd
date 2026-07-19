/**
 * @failure The live watch UI runs without terminal mouse tracking, so the trackpad
 *   wheel is alt-scrolled into arrow keys that move the ListView cursor instead of
 *   scrolling the viewport. Regression: @km/code/trackpad-wheel-not-scrolling.
 * @level l2
 * @consumer @yrd/cli watch
 */
import { createElement } from "react"
import { createTermless, waitFor } from "silvery/test"
import { run } from "silvery/runtime"
import { Box, ListView, Text } from "silvery"
import { describe, expect, it } from "vitest"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import { WATCH_LIVE_RENDER_OPTIONS } from "../src/host.ts"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

// SGR any-event mouse tracking (CSI ?1003h). Silvery emits this on startup only
// when mouse tracking is enabled. Its presence is the exact terminal-observable
// fact that decides whether a wheel arrives as an SGR mouse report (viewport
// scroll) or is alt-scrolled into arrow keys (cursor movement).
const ENABLE_MOUSE = "\x1b[?1003h"

const settle = (ms = 200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function outputBytes(term: unknown): string {
  return (term as { out?: { getText(): string } }).out?.getText() ?? ""
}

// A stand-in for the watch UI's scrollable surface. The enable-mouse emission
// depends on the run() options, not on the specific tree, so a representative
// ListView is sufficient and keeps the test independent of fixture data.
function ScrollSurface() {
  return createElement(
    Box,
    { flexDirection: "column", width: 40, height: 10 },
    createElement(ListView<{ id: string; label: string }>, {
      items: Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, label: `Row ${i}` })),
      height: 10,
      estimateHeight: 1,
      nav: true,
      getKey: (item: { id: string }) => item.id,
      renderItem: (item: { label: string }) => createElement(Text, null, item.label),
    }),
  )
}

describe("yrd watch enables terminal mouse tracking", () => {
  it("pins mouse tracking on in the live-render options", () => {
    expect(WATCH_LIVE_RENDER_OPTIONS.mouse).toBe(true)
    expect(WATCH_LIVE_RENDER_OPTIONS.mode).toBe("fullscreen")
    expect(WATCH_LIVE_RENDER_OPTIONS.selection).toBe(true)
    expect(WATCH_LIVE_RENDER_OPTIONS.copyOnSelect).toBe(true)
  })

  it("copies selected detail output through OSC 52 while mouse tracking stays enabled", async () => {
    using term = createTermless({ cols: 200, rows: 50 })
    const controller = new AbortController()
    const handle = await run(
      createElement(QueueWatchFrame, { snapshot: queueTimelineStories["production-overview"].snapshot }),
      term,
      { ...WATCH_LIVE_RENDER_OPTIONS, signal: controller.signal },
    )
    try {
      await waitFor(() => term.screen.getText().includes("0: submit"))
      await handle.press("l")
      await handle.press("l")
      await handle.waitForLayoutStable()
      await waitFor(() => term.screen.getText().includes("125 tests collected"))
      const rows = term.screen.getText().split("\n")
      const row = rows.findIndex((line) => line.includes("125 tests collected"))
      const column = rows[row]?.indexOf("125 tests collected") ?? -1
      expect(row).toBeGreaterThanOrEqual(0)
      expect(column).toBeGreaterThanOrEqual(0)

      term.clipboard.clear()
      await term.mouse.drag({ from: [column, row], to: [column + "125 tests collected".length - 1, row] })
      await waitFor(() => term.clipboard.last !== null)
      expect(term.clipboard.last).toBe("125 tests collected")
    } finally {
      controller.abort()
      handle.unmount()
    }
  }, 20_000)

  it("emits the SGR mouse-tracking enable sequence when rendered with the watch options", async () => {
    using term = createTermless({ cols: 40, rows: 10 })
    const controller = new AbortController()
    const handle = await run(createElement(ScrollSurface), term, {
      ...WATCH_LIVE_RENDER_OPTIONS,
      signal: controller.signal,
    })
    try {
      await settle()
      // The fix: mouse tracking is enabled, so the terminal reports the wheel as
      // SGR mouse events (viewport scroll) rather than alt-scrolling to arrows.
      expect(outputBytes(term).includes(ENABLE_MOUSE)).toBe(true)
    } finally {
      controller.abort()
      handle.unmount()
    }
  }, 20_000)

  it("would NOT enable mouse tracking with mouse:false — the pre-fix regression state", async () => {
    using term = createTermless({ cols: 40, rows: 10 })
    const controller = new AbortController()
    const handle = await run(createElement(ScrollSurface), term, {
      ...WATCH_LIVE_RENDER_OPTIONS,
      mouse: false,
      signal: controller.signal,
    })
    try {
      await settle()
      // Documents the root cause: with mouse tracking off, a real terminal
      // alt-scrolls the wheel into arrow keys that move the ListView cursor.
      expect(outputBytes(term).includes(ENABLE_MOUSE)).toBe(false)
    } finally {
      controller.abort()
      handle.unmount()
    }
  }, 20_000)
})
