/**
 * @failure  The list's STATUS cell never pulsed a live row at all — no
 *           `<Pulse>` existed anywhere in this file — so a change with a
 *           check running RIGHT NOW read identically to one sitting still,
 *           the same silent-flicker regression item 13 named for the RUNNER
 *           box's `$` marker (watch-boxes.test.tsx), just never restored here.
 *           And a naive restoration would let the pulse fight the cursor
 *           row's forced selection color, since `forced` otherwise
 *           unconditionally overrides every cell color.
 * @level    l2 (a real silvery render, real wall-clock across one pulse period)
 * @consumer the operator watching a change check run from the list, cursor
 *           on it or off it
 */

import { act } from "react"
import { describe, expect, it } from "vitest"
import { render } from "silvery/test"
import type { Row, WatchRow } from "@yrd/queue-core"
import { ListRow, type ListLayout } from "../src/watch-list.tsx"
import { NowContext } from "../src/watch-clock.ts"

const NOW = new Date("2026-09-03T12:00:00.000Z")

const LAYOUT: ListLayout = { ageWidth: 4, byWidth: 0, durationWidth: 7, runWidth: 6, statusWidth: 12, timeWidth: 8 }

const RUNNING_ROW: Row = {
  branch: "task/checking-something",
  head: "deadbeef".padEnd(40, "0"),
  live: { check: "typecheck", phase: "typecheck", run: "q-1", since: NOW },
  state: "checked",
}

function item(): WatchRow {
  return { row: RUNNING_ROW }
}

async function paint(cursor: boolean) {
  const app = render(
    <NowContext.Provider value={NOW}>
      <ListRow cursor={cursor} item={item()} label="main" layout={LAYOUT} previous={undefined} />
    </NowContext.Provider>,
    { cols: 60, rows: 3, autoRender: true },
  )
  await act(async () => {
    await app.waitForLayoutStable()
  })
  const line = app.lines[0] ?? ""
  const col = line.indexOf("◉")
  expect(col).toBeGreaterThan(-1)
  const first = app.cell(col, 0)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 950))
    await app.waitForLayoutStable()
  })
  const second = app.cell(col, 0)
  app.unmount()
  return { first, second }
}

describe("ListRow STATUS cell pulse, live (item 13 archaeology)", () => {
  it("pulses a running row's glyph off the cursor", async () => {
    const { first, second } = await paint(false)
    expect(first.char).toBe("◉")
    expect(second.char).toBe("◉")
    expect(first.fg).not.toEqual(second.fg)
  }, 10_000)

  it("exempts the cursor row: the forced selection color stays put, never overridden by a pulse", async () => {
    const { first, second } = await paint(true)
    expect(first.char).toBe("◉")
    expect(second.char).toBe("◉")
    expect(first.fg).toEqual(second.fg)
  }, 10_000)
})
