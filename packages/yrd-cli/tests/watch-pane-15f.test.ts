import { createElement } from "react"
import { createRenderer, waitFor } from "silvery/test"
import { describe, expect, it } from "vitest"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

describe("QueueWatchFrame 21106 addendum 15f", () => {
  it("keeps j/k on runs while h/l, arrows, and pointer select one workflow-step tab", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))

    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("STEP check#"))

      const tabLine = app.text
        .split("\n")
        .find((line) => line.includes("prepare") && line.includes("check") && line.includes("integrate"))
      expect(tabLine, app.text).toBeDefined()
      expect(app.text).toContain("STEP check#")
      expect(app.text).not.toContain("STEP prepare#")
      expect(app.text).toContain("125 tests collected")
      expect(app.text).toContain("v LOG")
      expect(app.text.match(/(?:>|v) LOG/gu)).toHaveLength(1)
      expect(app.text).toContain("h/j/k/l navigate")

      await app.press("h")
      await waitFor(() => app.text.includes("STEP prepare#"))
      expect(app.text).not.toContain("125 tests collected")
      expect(app.text).toContain("> LOG")

      await app.press("l")
      await waitFor(() => app.text.includes("STEP check#"))
      await app.press("ArrowRight")
      await waitFor(() => app.text.includes("STEP integrate#"))
      expect(app.text).not.toContain("125 tests collected")
      expect(app.text).toContain("v LOG")
      expect(app.text).toContain("Waiting for first output…")

      await app.press("ArrowLeft")
      await waitFor(() => app.text.includes("STEP check#"))
      await app.press("ArrowRight")
      await waitFor(() => app.text.includes("STEP integrate#"))

      const lines = app.text.split("\n")
      const tabsY = lines.findIndex(
        (line) => line.includes("prepare") && line.includes("check") && line.includes("integrate"),
      )
      const tabsLine = lines[tabsY]
      if (tabsLine === undefined) throw new Error("workflow-step tab bar did not render")
      // The tab bar sits below the run header + PRS disclosure, so it can share a
      // text row with a left-pane timeline cell that also reads `…:check`. Anchor
      // on the tab bar's own `check`, which follows its `prepare` tab.
      const checkX = tabsLine.indexOf("check", tabsLine.indexOf("prepare"))
      expect(tabsY).toBeGreaterThanOrEqual(0)
      expect(checkX).toBeGreaterThanOrEqual(0)
      await app.click(checkX, tabsY)
      await waitFor(() => app.text.includes("STEP check#"))

      await app.press("j")
      await app.press("j")
      await waitFor(() => app.text.includes("PRs PR7"))
      expect(app.text).toContain("STEP check#")

      await app.press("k")
      await app.press("k")
      await waitFor(() => app.text.includes("PRs PR42"))
      expect(app.text).toContain("STEP check#")

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

  it("labels each step tab with a status glyph + duration, glyph colorized by status (item I)", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const app = createRenderer({ cols: 200, rows: 50 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("STEP check#"))
      const lines = app.text.split("\n")
      const tabsY = lines.findIndex(
        (line) => line.includes("prepare") && line.includes("check") && line.includes("integrate"),
      )
      const tabsLine = lines[tabsY] ?? ""
      // Durations ride the tab labels (e.g. `check 7m`) — the tab bar carries at
      // least one duration token, which the old bare name-only labels lacked.
      expect(tabsLine, tabsLine).toMatch(/\d+(?:m|s|:\d{2})/u)
      // The glyph immediately left of a step name is colorized by status, so its
      // fg differs from the plain (uncolored) space separating labels. Anchor on
      // the tab bar's own `check` (after `prepare`), not a left-pane `…:check`
      // cell the tab bar now shares a row with.
      const checkX = tabsLine.indexOf("check", tabsLine.indexOf("prepare"))
      const glyphCell = app.cell(checkX - 2, tabsY)
      const nameCell = app.cell(checkX, tabsY)
      expect(glyphCell.fg, "step glyph is status-colored, not the plain label fg").not.toEqual(nameCell.fg)
    } finally {
      app.unmount()
    }
  })

  it("orders the detail as run facts → step tabs → step content, with extra step fields (items H/J)", async () => {
    const snapshot = queueTimelineStories["detail-full"].snapshot
    const app = createRenderer({ cols: 120, rows: 40 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      app.press("\r")
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("STEP integrate#"))
      const lines = app.text.split("\n")
      const runFactsY = lines.findIndex((l) => l.includes("RUN R") && l.includes("OUTCOME"))
      const tabsY = lines.findIndex((l) => l.includes("check") && l.includes("integrate") && !l.includes("STEP"))
      const stepContentY = lines.findIndex((l) => l.includes("STEP integrate#"))
      // H: run-level facts sit ABOVE the step tabs, which sit ABOVE the step content.
      expect(runFactsY, "run facts present").toBeGreaterThanOrEqual(0)
      expect(tabsY, "step tabs below run facts").toBeGreaterThan(runFactsY)
      expect(stepContentY, "step content below the tabs").toBeGreaterThan(tabsY)
      // J: the per-step line surfaces the revision field (REV).
      expect(lines[stepContentY]).toContain("REV")
    } finally {
      app.unmount()
    }
  })
})
