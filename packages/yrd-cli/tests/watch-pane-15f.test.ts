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
      expect(app.text).toContain("• RUN LOGS")
      expect(app.text.match(/[▸•] RUN LOGS/gu)).toHaveLength(1)

      await app.press("h")
      await waitFor(() => !app.text.includes("125 tests collected"))
      expect(app.text).toContain("▸ RUN LOGS")

      await app.press("l")
      await waitFor(() => app.text.includes("125 tests collected"))
      await app.press("ArrowRight")
      await waitFor(() => app.text.includes("Waiting for first output…"))
      expect(app.text).not.toContain("125 tests collected")
      expect(app.text).toContain("• RUN LOGS")

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
      await waitFor(() => app.text.includes("PRs      PR7"))

      await app.press("k")
      await app.press("k")
      await waitFor(() => app.text.includes("PRs      PR42"))

      await app.press("ArrowDown")
      await app.press("ArrowDown")
      await waitFor(() => app.text.includes("PRs      PR7"))
      await app.press("ArrowUp")
      await app.press("ArrowUp")
      await waitFor(() => app.text.includes("PRs      PR42"))
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
      const statusLine = rows[tabsY + 1] ?? ""
      const durationLine = rows[tabsY + 2] ?? ""
      expect(durationLine).toMatch(/◷\s+\d+(?:m|s|:\d{2})/u)
      const checkX = tabsLine.indexOf("check", tabsLine.indexOf("prepare"))
      const prepareX = tabsLine.indexOf("prepare")
      const doneGlyph = app.cell(prepareX - 3, tabsY + 1)
      const runningGlyph = app.cell(checkX - 3, tabsY + 1)
      expect(statusLine).toContain("✓ passed")
      expect(statusLine).toContain("● running")
      expect(doneGlyph.fg, "done and running glyphs retain distinct semantic colors").not.toEqual(runningGlyph.fg)

      // Recovered 21514 IA: tabs are deliberately wide and equal rather than
      // a compact run of content-sized pills.
      const integrateX = tabsLine.indexOf("integrate", checkX)
      const firstStride = checkX - prepareX
      const secondStride = integrateX - checkX
      expect(firstStride, "step tabs have a wide hit/read target").toBeGreaterThanOrEqual(20)
      expect(Math.abs(firstStride - secondStride), "step tabs have equal widths").toBeLessThanOrEqual(2)
    } finally {
      app.unmount()
    }
  })

  it("orders the detail as run facts → step tabs → step content (items H/J)", async () => {
    const snapshot = queueTimelineStories["detail-full"].snapshot
    // Use the wide tier for an order assertion so the below-tier split does
    // not intentionally clip the tail of a long integrated detail. The 80×24
    // full-tier story separately proves DETAILS remains visible when narrow.
    const app = createRenderer({ cols: 200, rows: 50 })(createElement(QueueWatchFrame, { snapshot }))
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
      // J: the step internals (JOB/RUNNER/REV) live in one inline DETAILS row.
      expect(app.text).toContain("DETAILS")

      // The command owns a boxed, bold header above logs. It is step content,
      // never compressed into the tab label.
      const commandY = rows.findIndex((line) => line.includes("[ $ bun vitest run ]"))
      expect(commandY, "boxed command header present").toBeGreaterThan(tabsY)
      expect(commandY, "command header sits above logs").toBeLessThan(stepContentY)
      const commandX = rows[commandY]?.indexOf("$ bun vitest run") ?? -1
      expect(app.cell(commandX, commandY).bold).toBe(true)
      expect(app.cell(commandX, commandY).fg).not.toBeNull()
      expect(rows[commandY - 1]).toContain("╭")
      expect(rows[commandY + 1]).toContain("╰")
    } finally {
      app.unmount()
    }
  })
})
