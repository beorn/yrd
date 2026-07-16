// @failure A check step's `output.log` tail (e.g. vitest's ` RUN  v4.1.10 <path>` banner) carries
// background SGR codes; rendered raw into the watch UI's log pane they collide with the pane's own
// background and silvery's background-conflict guard (default `throw`) kills the whole `yrd watch`
// event loop. The fix must KEEP the colors (they belong in a log pane), not strip them.
// @level l2
// @consumer yrd watch / queue list --watch artifact log pane

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { Box } from "silvery"
import { describe, expect, it } from "vitest"
import { QueueArtifactOutputView, type QueueArtifactOutput } from "../src/watch-pane.tsx"

// The exact row from the user-reproduced crash: vitest's run banner with a
// bold + black-fg + cyan-bg ` RUN ` segment, then version + path in fg colors.
const VITEST_BANNER =
  "\x1b[1m\x1b[30m\x1b[46m RUN \x1b[49m\x1b[39m\x1b[22m \x1b[36mv4.1.10 \x1b[39m\x1b[90m/Users/beorn/Code/hh/vendor/yrd\x1b[39m"

function bannerOutput(text: string): QueueArtifactOutput {
  return {
    run: "R1",
    step: "check",
    attempt: 1,
    path: "/artifacts/R1/0-check/attempt-1/output.log",
    text,
  }
}

function rowContaining(app: { text: string }, needle: string): { row: number; col: number } {
  const rows = app.text.split("\n")
  const row = rows.findIndex((text) => text.includes(needle))
  if (row === -1) throw new Error(`no rendered row contains ${JSON.stringify(needle)}`)
  return { row, col: rows[row]!.indexOf(needle.trimStart()) }
}

describe("QueueArtifactOutputView foreign ANSI", () => {
  // Reproduces the live crash: the log pane inherits the watch UI's dark
  // background (rgb(50,50,50) == #323232), so a cyan-bg segment from the log
  // trips silvery's background-conflict guard (default mode: throw). The fix
  // marks these rows as foreign content (`bgConflict="ignore"`) so the colors
  // render and the guard cannot fire.
  it("renders a background-SGR log row over a dark pane without crashing", async () => {
    const render = createRenderer({ cols: 120, rows: 14 })
    const app = render(
      createElement(
        Box,
        { width: 120, height: 12, flexDirection: "column", backgroundColor: "#323232" },
        createElement(QueueArtifactOutputView, { outputs: [bannerOutput(`${VITEST_BANNER}\n`)] }),
      ),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("RUN")
      expect(app.text).toContain("v4.1.10")
    } finally {
      app.unmount()
    }
  })

  it("keeps the log's own colors — cyan background on ` RUN `, not the pane background", async () => {
    const render = createRenderer({ cols: 120, rows: 14 })
    const app = render(
      createElement(
        Box,
        { width: 120, height: 12, flexDirection: "column", backgroundColor: "#323232" },
        createElement(QueueArtifactOutputView, { outputs: [bannerOutput(`${VITEST_BANNER}\n`)] }),
      ),
    )
    try {
      await app.waitForLayoutStable()
      const { row, col } = rowContaining(app, " RUN ")
      const runCell = app.cell(col, row)
      // The log's cyan (ANSI 46) background survives — it is NOT stripped, and it
      // is NOT the pane's rgb(50,50,50).
      expect(runCell.bg).toStrictEqual({ r: 0, g: 128, b: 128, index: 6 })
      expect(runCell.fg).toStrictEqual({ r: 0, g: 0, b: 0, index: 0 })
      expect(runCell.bold).toBe(true)
      // The version segment keeps its cyan (36) foreground over the pane bg.
      const vPos = rowContaining(app, "v4.1.10")
      const vCell = app.cell(vPos.col, vPos.row)
      expect(vCell.fg).toStrictEqual({ r: 0, g: 128, b: 128, index: 6 })
    } finally {
      app.unmount()
    }
  })
})
