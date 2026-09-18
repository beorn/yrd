/**
 * @failure  The list's STATUS cell never pulsed a live row at all — no
 *           `<Pulse>` existed anywhere in this file — so a change with a
 *           check running RIGHT NOW read identically to one sitting still,
 *           the same silent-flicker regression item 13 named for the RUNNER
 *           marker (watch-boxes.test.tsx), just never restored here.
 *           And a naive restoration would let the pulse fight the cursor
 *           row's forced selection color, since `forced` otherwise
 *           unconditionally overrides every cell color; the cursor row
 *           pulses in the selection's own pair instead (24196 P1).
 * @level    l2 (a real silvery render, real wall-clock across one pulse period)
 * @consumer the operator watching a change check run from the list, cursor
 *           on it or off it
 */

import { act } from "react"
import { describe, expect, it } from "vitest"
import { render } from "silvery/test"
import type { Row, WatchRow } from "@yrd/queue-core"
import { ListRow, type ListLayout } from "../src/watch-list.tsx"
import { NowContext, NowProvider } from "../src/watch-clock.ts"

const NOW = new Date("2026-09-03T12:00:00.000Z")

const LAYOUT: ListLayout = { byWidth: 0, durationWidth: 7, statusWidth: 12, timeWidth: 8 }

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
      <ListRow cursor={cursor} item={item()} layout={LAYOUT} />
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

  // Item 13 exempted the cursor row. The held row sorts first, so the cursor starts on it, and the
  // exemption hid the only live marker on screen (24196 P1). The cursor row pulses in the selection's
  // own pair: its glyph's colour moves while the row keeps the selection background.
  it("pulses the cursor row too, in the selection's pair: the glyph moves, the selection background holds", async () => {
    const { first, second } = await paint(true)
    expect(first.char).toBe("◉")
    expect(second.char).toBe("◉")
    expect(first.fg).not.toEqual(second.fg)
    expect(first.bg).toEqual(second.bg)
  }, 10_000)
})

// The duration cell, read across a real tick of the watch's own clock
// (`NowProvider`, not a still `NowContext.Provider` value): a decided row's
// duration must read the same before and after, while an open row's keeps
// counting — the operator's 2026-09-09 report that AGE "just goes forever"
// past a merge. AGE is gone (24196): an ended row's one duration is `took`,
// submitted to ended, and it stops there the way AGE had to.
const DECIDED_ROW: Row = {
  branch: "task/merged-thing",
  endedAt: new Date(NOW.getTime() - 15 * 60 * 1000),
  head: "cafef00d".padEnd(40, "0"),
  since: new Date(NOW.getTime() - 45 * 60 * 1000),
  state: "merged",
}

const OPEN_ROW: Row = {
  branch: "task/still-open",
  head: "0ddba11f".padEnd(40, "0"),
  since: new Date(NOW.getTime() - 45 * 60 * 1000),
  state: "queued",
}

// LAYOUT's durationWidth (7) is sized for the pulse tests above, which never
// read this cell; "took 30:00" and "waiting 45:00" would not fit in it.
const AGE_LAYOUT: ListLayout = { ...LAYOUT, durationWidth: 13 }

async function paintAge(row: Row) {
  const app = render(
    <NowProvider readAt={NOW} live>
      <ListRow cursor={false} item={{ row }} layout={AGE_LAYOUT} />
    </NowProvider>,
    { autoRender: true, cols: 80, rows: 3 },
  )
  await act(async () => {
    await app.waitForLayoutStable()
  })
  const first = app.text
  await act(async () => {
    // Past the clock's 1-second tick, not just the pulse's 900ms one: this is
    // NowProvider's own setInterval, the thing that must stop moving AGE.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await app.waitForLayoutStable()
  })
  const second = app.text
  app.unmount()
  return { first, second }
}

describe("the duration freezes once a row is decided (the operator's 2026-09-09 report)", () => {
  it("keeps a merged row's duration at its ending record, not at `now`, across a real tick", async () => {
    const { first, second } = await paintAge(DECIDED_ROW)
    // endedAt (15m ago) − since (45m ago) = 30m, fixed — never 45m (now − since).
    expect(first).toContain("took 30:00")
    expect(second).toContain("took 30:00")
  }, 10_000)

  it("keeps counting an open row's wait past the same tick (existing behavior preserved)", async () => {
    const { first, second } = await paintAge(OPEN_ROW)
    expect(first).toContain("waiting 45:00")
    expect(second).not.toContain("45:00")
  }, 10_000)
})
