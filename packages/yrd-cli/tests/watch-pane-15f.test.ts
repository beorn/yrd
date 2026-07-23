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
      // Round 6 removes the synthetic submit step; the pane opens on the live
      // step. Workflow-step output stays inline and expanded once its tab is
      // selected.
      await waitFor(() => app.text.includes("1: prepare"))

      const tabLine = app.text
        .split("\n")
        .find((row) => row.includes("prepare") && row.includes("check") && row.includes("merge"))
      expect(tabLine, app.text).toBeDefined()
      expect(app.text).not.toContain("RUN LOGS")

      // The pane opens on the live step (check is running); h/l and the arrows
      // cycle the step tab while j/k stay on the QUEUE rows.
      await app.press("h")
      expect(app.text).toContain("J42-prepare")

      await app.press("l")
      await waitFor(() => app.text.includes("125 tests collected"))
      await app.press("ArrowRight")
      await waitFor(() => !app.text.includes("125 tests collected"))
      expect(app.text).not.toContain("125 tests collected")
      expect(app.text).not.toMatch(/Waiting for (?:first )?(?:input|output)/u)

      await app.press("ArrowLeft")
      await waitFor(() => app.text.includes("125 tests collected"))
      await app.press("ArrowRight")
      await waitFor(() => !app.text.includes("125 tests collected"))

      const rows = app.text.split("\n")
      const tabsY = rows.findIndex((row) => row.includes("prepare") && row.includes("check") && row.includes("merge"))
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

      // j/k move the QUEUE cursor (not the tabs); the detail follows the
      // cursor. run#7 has no running step, so its detail opens on the PR tab
      // (no RUN header there) — anchor on the title row instead, which names
      // the selected PR regardless of which tab is active.
      const titleRow = () => app.text.split("\n")[0] ?? ""

      await app.press("j")
      await app.press("j")
      await waitFor(() => titleRow().includes("pr#7.1"))

      await app.press("k")
      await app.press("k")
      await waitFor(() => titleRow().includes("pr#42.1"))

      await app.press("ArrowDown")
      await app.press("ArrowDown")
      await waitFor(() => titleRow().includes("pr#7.1"))
      await app.press("ArrowUp")
      await app.press("ArrowUp")
      await waitFor(() => titleRow().includes("pr#42.1"))
    } finally {
      app.unmount()
    }
  })

  it("labels each step tab with a status glyph + duration, glyph colorized by status (item I)", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const app = createRenderer({ cols: 200, rows: 50 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      // The pane opens on the live step (check is running); its output is visible
      // without navigating.
      await waitFor(() => app.text.includes("125 tests collected"))
      const rows = app.text.split("\n")
      const tabsY = rows.findIndex((row) => row.includes("prepare") && row.includes("check") && row.includes("merge"))
      const tabsLine = rows[tabsY] ?? ""
      const statusLine = rows[tabsY + 1] ?? ""
      expect(statusLine).toMatch(/✓ passed\s+\d+(?:m(?:\d+s)?|s)/u)
      expect(rows[tabsY + 2]).not.toMatch(/◷\s+\d/u)
      const checkX = tabsLine.indexOf("check", tabsLine.indexOf("prepare"))
      const prepareX = tabsLine.indexOf("prepare")
      const mergeX = tabsLine.indexOf("merge", checkX)
      const doneGlyph = app.cell(prepareX - 3, tabsY + 1)
      const runningGlyph = app.cell(checkX - 3, tabsY + 1)
      expect(statusLine).toContain("✓ passed")
      expect(statusLine).toContain("● running")
      expect(doneGlyph.fg, "done and running glyphs retain distinct semantic colors").not.toEqual(runningGlyph.fg)

      // Round 6: active and inactive tabs both have distinct filled surfaces.
      const selectedTab = app.cell(checkX, tabsY)
      const inactiveTab = app.cell(prepareX, tabsY)
      expect(selectedTab.bg, "selected step tab has a solid background").not.toBeNull()
      expect(inactiveTab.bg, "inactive step tab also has a solid background").not.toBeNull()
      expect(selectedTab.bg, "selected and inactive tabs use different surfaces").not.toEqual(inactiveTab.bg)
      expect(rows[tabsY - 1]?.slice(prepareX, mergeX + 20), "step tabs have no top box borders").not.toContain("╭")

      // Round 6: tabs are equal to the widest content and never stretch.
      const firstStride = checkX - prepareX
      const secondStride = mergeX - checkX
      expect(firstStride, "step tabs stay content-sized").toBeLessThan(20)
      expect(Math.abs(firstStride - secondStride), "step tabs have equal widths").toBeLessThanOrEqual(2)
    } finally {
      app.unmount()
    }
  })

  it("orders the detail as run facts → step tabs → step content (items H/J)", async () => {
    const snapshot = queueTimelineStories["detail-full"].snapshot
    // Use the wide tier for an order assertion so the below-tier split does
    // not intentionally clip the tail of a long integrated detail. The 80×24
    // full-tier story separately proves JOB/RUNNER remains visible when narrow.
    const app = createRenderer({ cols: 200, rows: 50 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      await app.press("Enter")
      await app.press("l")
      await app.press("l")
      await app.waitForLayoutStable()
      await waitFor(() => app.text.includes("JOB"))
      const rows = app.text.split("\n")
      // Enter,l,l lands on a real step tab. The composite RUN identity/timing
      // header leads the tab strip; selected step internals begin with JOB.
      const runFactsY = rows.findIndex((l) => l.includes("Started "))
      const tabsY = rows.findIndex((l) => l.includes("check") && l.includes("merge"))
      const stepContentY = rows.findIndex((l) => l.includes("JOB"))
      // 21751 restores the original detail IA: run facts above the tabs, step
      // content below them.
      expect(tabsY, "step tabs present").toBeGreaterThanOrEqual(0)
      expect(runFactsY, "run facts above the step tabs").toBeLessThan(tabsY)
      expect(stepContentY, "step content below the tabs").toBeGreaterThan(tabsY)
      expect(app.text).toContain("RUNNER")
      expect(app.text).not.toContain("DETAILS")
      expect(app.text).not.toContain("RUN LOGS")

      // Command follows JOB/RUNNER; inline output follows the command. The merge
      // step renders its recorded command ($ bun vitest run in the fixture) with
      // the native PARENTS summary as its output; PARENTS also appears once above
      // the command as a merge fact, so anchor the output on the last occurrence.
      const commandY = rows.findIndex((line) => line.includes("$ bun vitest run"))
      expect(commandY, "command header present").toBeGreaterThan(tabsY)
      expect(commandY, "command follows the step internals").toBeGreaterThan(stepContentY)
      const outputY = rows.findLastIndex((row) => row.includes("PARENTS "))
      expect(outputY, "inline output follows the command").toBeGreaterThan(commandY)
      const commandX = rows[commandY]?.indexOf("$ bun vitest run") ?? -1
      // The command execution header is emphasized by bold weight and a filled
      // surface; it inherits the default foreground (no explicit fg color).
      expect(app.cell(commandX, commandY).bold).toBe(true)
      expect(rows[commandY]).not.toContain("[ $")
      expect(app.cell(commandX, commandY).bg, "command row has a deliberate filled surface").not.toBeNull()
    } finally {
      app.unmount()
    }
  })
})
