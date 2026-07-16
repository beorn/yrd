import { createElement } from "react"
import { createRenderer, waitFor } from "silvery/test"
import { describe, expect, it } from "vitest"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

describe("QueueWatchFrame 21106 addendum 15f", () => {
  it("keeps j/k on runs while h/l, arrows, and pointer select one workflow-step tab", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot, paused: false }))

    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("ACTIVE STEP check"))

      const tabLine = app.text
        .split("\n")
        .find((line) => line.includes("prepare") && line.includes("check") && line.includes("integrate"))
      expect(tabLine, app.text).toBeDefined()
      expect(app.text).toContain("ACTIVE STEP check")
      expect(app.text).not.toContain("ACTIVE STEP prepare")
      expect(app.text).toContain("125 tests collected")
      expect(app.text).toContain("v LOG")
      expect(app.text.match(/(?:>|v) LOG/gu)).toHaveLength(1)
      expect(app.text).toContain("h/l steps")

      await app.press("h")
      await waitFor(() => app.text.includes("ACTIVE STEP prepare"))
      expect(app.text).not.toContain("125 tests collected")
      expect(app.text).toContain("> LOG")

      await app.press("l")
      await waitFor(() => app.text.includes("ACTIVE STEP check"))
      await app.press("ArrowRight")
      await waitFor(() => app.text.includes("ACTIVE STEP integrate"))
      expect(app.text).not.toContain("125 tests collected")
      expect(app.text).toContain("v LOG")
      expect(app.text).toContain("Waiting for first output…")

      await app.press("ArrowLeft")
      await waitFor(() => app.text.includes("ACTIVE STEP check"))
      await app.press("ArrowRight")
      await waitFor(() => app.text.includes("ACTIVE STEP integrate"))

      const lines = app.text.split("\n")
      const tabsY = lines.findIndex(
        (line) => line.includes("prepare") && line.includes("check") && line.includes("integrate"),
      )
      const tabsLine = lines[tabsY]
      if (tabsLine === undefined) throw new Error("workflow-step tab bar did not render")
      const checkX = tabsLine.indexOf("check")
      expect(tabsY).toBeGreaterThanOrEqual(0)
      expect(checkX).toBeGreaterThanOrEqual(0)
      await app.click(checkX, tabsY)
      await waitFor(() => app.text.includes("ACTIVE STEP check"))

      await app.press("j")
      await app.press("j")
      await waitFor(() => app.text.includes("PRs PR7"))
      expect(app.text).toContain("ACTIVE STEP check")

      await app.press("k")
      await app.press("k")
      await waitFor(() => app.text.includes("PRs PR42"))
      expect(app.text).toContain("ACTIVE STEP check")

      await app.press("ArrowDown")
      await app.press("ArrowDown")
      await waitFor(() => app.text.includes("PRs PR7"))
      await app.press("ArrowUp")
      await app.press("ArrowUp")
      await waitFor(() => app.text.includes("PRs PR42"))
    } finally {
      app.unmount()
    }
  })
})
