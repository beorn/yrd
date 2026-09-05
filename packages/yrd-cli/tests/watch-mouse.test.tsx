/**
 * The pointer in the live pane (24169). The retired pane ran its terminal with
 * SGR mouse tracking, click-to-select, an affordance-only hover tint and
 * copy-on-drag; the port left the terminal to the runtime's detection, and on
 * 2026-09-05 a click on a row selected nothing. These pin the options the pane
 * runs with and the three things a pointer buys: tracking is switched on, a
 * click moves the cursor, a hover only tints.
 */

import React from "react"
import { describe, expect, it } from "vitest"
import { run } from "silvery/runtime"
import { createTermless } from "silvery/test"
import type { Row } from "@yrd/queue-core"
import { WatchPane, type WatchSnapshot } from "../src/watch-pane.tsx"
import { WATCH_RUN_OPTIONS } from "../src/watch-run-options.ts"

const NOW = new Date("2026-09-03T12:00:00.000Z")

function row(branch: string, state: Row["state"], over: Partial<Row> = {}): Row {
  return {
    at: NOW,
    branch,
    endedAt: NOW,
    head: `${branch.replace(/\W/gu, "").padEnd(8, "0").slice(0, 8)}0123456789abcdef0123456789abcdef`,
    since: new Date(NOW.getTime() - 3_600_000),
    startedAt: new Date(NOW.getTime() - 1_800_000),
    state,
    subject: `work on ${branch}`,
    submitter: "@dev/1",
    ...over,
  }
}

const ROWS: readonly Row[] = [
  row("task/alpha", "failed", { reason: "test", result: "fail test" }),
  row("task/bravo", "merged", { merge: "9".repeat(40), result: "pass test" }),
  row("task/charlie", "merged", { merge: "8".repeat(40), result: "pass test" }),
]

const SNAPSHOT: WatchSnapshot = {
  at: NOW,
  queue: "example.test/repo#main",
  queues: [{ branch: "main", label: "main", path: "/repo" }],
  rows: ROWS.map((item) => ({ row: item })),
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The screen row a branch is drawn on, or a failure naming the screen. */
function rowOf(lines: readonly string[], branch: string): number {
  const index = lines.findIndex((line) => line.includes(branch))
  expect(index, lines.join("\n")).toBeGreaterThanOrEqual(0)
  return index
}

describe("the pointer in the live pane", () => {
  it("runs the terminal the retired pane ran: alternate screen, mouse, selection, copy on drag", () => {
    expect(WATCH_RUN_OPTIONS).toEqual({ copyOnSelect: true, mode: "fullscreen", mouse: true, selection: true })
  })

  it("switches SGR mouse tracking on, so a wheel scrolls and a click reaches a row", async () => {
    using term = createTermless({ cols: 140, rows: 30 })
    const handle = await run(<WatchPane snapshot={SNAPSHOT} live={false} />, term, WATCH_RUN_OPTIONS)
    try {
      await handle.waitForLayoutStable()
      const written = term.out.getText()
      expect(written, "any-event tracking (1003) and SGR encoding (1006) are asked of the terminal").toContain(
        "\x1b[?1003h",
      )
      expect(written).toContain("\x1b[?1006h")
    } finally {
      handle.unmount()
    }
  })

  it("a click selects the row under the pointer; a hover only tints it and leaves the selection alone", async () => {
    using term = createTermless({ cols: 140, rows: 30 })
    const handle = await run(<WatchPane snapshot={SNAPSHOT} live={false} />, term, WATCH_RUN_OPTIONS)
    try {
      await handle.waitForLayoutStable()
      await sleep(50)
      const lines = term.screen.getLines()
      const alpha = rowOf(lines, "task/alpha")
      const bravo = rowOf(lines, "task/bravo")
      const charlie = rowOf(lines, "task/charlie")
      const column = lines[alpha]!.indexOf("task/alpha")
      const selected = term.cell(alpha, column).bg
      const plain = term.cell(charlie, column).bg
      expect(selected, "the cursor starts on the first row and paints it selected").not.toEqual(plain)

      // Hover over the third row: a tint of its own, neither the selection nor nothing.
      await term.mouse.move(column, charlie)
      await sleep(80)
      await handle.waitForLayoutStable()
      const hovered = term.cell(charlie, column).bg
      expect(hovered, "hover is an affordance, painted apart from the selection").not.toEqual(selected)
      expect(hovered, "hover paints something").not.toEqual(plain)
      expect(term.cell(alpha, column).bg, "hover does not move the selection").toEqual(selected)

      // Click the second row: the selection moves there, and only there.
      await term.mouse.click(column, bravo)
      await sleep(80)
      await handle.waitForLayoutStable()
      expect(term.cell(bravo, column).bg, "the clicked row is selected").toEqual(selected)
      expect(term.cell(alpha, column).bg, "the first row is no longer selected").not.toEqual(selected)
    } finally {
      handle.unmount()
    }
  })
})
