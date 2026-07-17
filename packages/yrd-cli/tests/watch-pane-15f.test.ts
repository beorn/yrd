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
      // The active tab IS the step summary now (item d) — no STEP header row.
      // The default active tab is the running check step; detect it by its
      // streaming output under the RUN LOGS section (item e).
      await waitFor(() => app.text.includes("125 tests collected"))

      const tabLine = app.text
        .split("\n")
        .find((row) => row.includes("prepare") && row.includes("check") && row.includes("integrate"))
      expect(tabLine, app.text).toBeDefined()
      expect(app.text).toContain("v RUN LOGS")
      expect(app.text.match(/(?:>|v) RUN LOGS/gu)).toHaveLength(1)

      await app.press("h")
      await waitFor(() => !app.text.includes("125 tests collected"))
      expect(app.text).toContain("> RUN LOGS")

      await app.press("l")
      await waitFor(() => app.text.includes("125 tests collected"))
      await app.press("ArrowRight")
      await waitFor(() => app.text.includes("Waiting for first output…"))
      expect(app.text).not.toContain("125 tests collected")
      expect(app.text).toContain("v RUN LOGS")

      await app.press("ArrowLeft")
      await waitFor(() => app.text.includes("125 tests collected"))
      await app.press("ArrowRight")
      await waitFor(() => app.text.includes("Waiting for first output…"))

      const rows = app.text.split("\n")
      const tabsY = rows.findIndex(
        (row) => row.includes("prepare") && row.includes("check") && row.includes("integrate"),
      )
      const tabsLine = rows[tabsY]
      if (tabsLine === undefined) throw new Error("workflow-step tab bar did not render")
      // The tab bar sits below the run facts, so it can share a text row with a
      // left-pane timeline cell that also reads `…:check`. Anchor on the tab
      // bar's own `check`, which follows its `prepare` tab.
      const checkX = tabsLine.indexOf("check", tabsLine.indexOf("prepare"))
      expect(tabsY).toBeGreaterThanOrEqual(0)
      expect(checkX).toBeGreaterThanOrEqual(0)
      await app.click(checkX, tabsY)
      await waitFor(() => app.text.includes("125 tests collected"))

      // j/k move the QUEUE cursor (not the tabs); the detail follows the cursor.
      await app.press("j")
      await app.press("j")
      await waitFor(() => app.text.includes("PRs PR7"))

      await app.press("k")
      await app.press("k")
      await waitFor(() => app.text.includes("PRs PR42"))

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
      await waitFor(() => app.text.includes("125 tests collected"))
      const rows = app.text.split("\n")
      const tabsY = rows.findIndex(
        (row) => row.includes("prepare") && row.includes("check") && row.includes("integrate"),
      )
      const tabsLine = rows[tabsY] ?? ""
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

  it("orders the detail as run facts → step tabs → step content (items H/J)", async () => {
    const snapshot = queueTimelineStories["detail-full"].snapshot
    const app = createRenderer({ cols: 120, rows: 40 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      app.press("\r")
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("RUN LOGS"))
      const rows = app.text.split("\n")
      // Run facts are the batched-members row (the RUN header + STATUS/OUTCOME
      // moved to the title row above, item a); the step content is the active
      // tab's RUN LOGS section (item e).
      const runFactsY = rows.findIndex((l) => l.includes("PRs "))
      const tabsY = rows.findIndex((l) => l.includes("check") && l.includes("integrate"))
      const stepContentY = rows.findIndex((l) => l.includes("RUN LOGS"))
      // H: run-level facts sit ABOVE the step tabs, which sit ABOVE the step content.
      expect(runFactsY, "run facts present").toBeGreaterThanOrEqual(0)
      expect(tabsY, "step tabs below run facts").toBeGreaterThan(runFactsY)
      expect(stepContentY, "step content below the tabs").toBeGreaterThan(tabsY)
      // J: the step internals (JOB/RUNNER/REV) live behind the `> DETAILS`
      // disclosure (item f).
      expect(app.text).toContain("DETAILS")
    } finally {
      app.unmount()
    }
  })
})
