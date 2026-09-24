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
import { ListRow, changesSuffix, type ListLayout } from "../src/watch-list.tsx"
import { NowContext, NowProvider } from "../src/watch-clock.ts"

const NOW = new Date("2026-09-03T12:00:00.000Z")

const LAYOUT: ListLayout = { agentWidth: 0, ageRunWidth: 11, statusWidth: 12, queueRunWidth: 14 }

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

// AGE / RUN across a real tick: RUN freezes at endedAt − startedAt; AGE stays
// unknown (tip Opened is not total lifetime). An open row without an attempt
// shows dashes and must not count Opened as AGE.
const DECIDED_ROW: Row = {
  branch: "task/merged-thing",
  endedAt: new Date(NOW.getTime() - 15 * 60 * 1000),
  head: "cafef00d".padEnd(40, "0"),
  since: new Date(NOW.getTime() - 45 * 60 * 1000),
  startedAt: new Date(NOW.getTime() - 30 * 60 * 1000),
  state: "merged",
}

const OPEN_ROW: Row = {
  branch: "task/still-open",
  head: "0ddba11f".padEnd(40, "0"),
  since: new Date(NOW.getTime() - 45 * 60 * 1000),
  state: "queued",
}

const AGE_LAYOUT: ListLayout = { ...LAYOUT, ageRunWidth: 13 }

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

describe("AGE / RUN (item 5, 24196): every row has AGE, runner and after have RUN", () => {
  it("shows AGE from since and keeps merged row's RUN at endedAt − startedAt", async () => {
    const { first, second } = await paintAge(DECIDED_ROW)
    expect(first).toContain("45:00 / 15:00")
    expect(second).toContain("45:01 / 15:00")
    expect(first).not.toContain("took")
  }, 10_000)

  it("shows AGE for open row with — for RUN", async () => {
    const { first, second } = await paintAge(OPEN_ROW)
    expect(first).toContain("45:00 / —")
    expect(second).toContain("45:01 / —")
    expect(first).not.toContain("waiting")
  }, 10_000)
})

describe("changesSuffix for deferred row", () => {
  it("shows the projected duration and bound with > when projected exceeds bound", () => {
    const row: Row = {
      branch: "task/wide",
      head: "a".repeat(40),
      state: "deferred" as any,
      projectedMs: 58 * 60 * 1000,
      boundMs: 30 * 60 * 1000,
    }
    const suffix = changesSuffix(row)
    expect(suffix).toEqual({
      color: "$fg-accent",
      text: "projected 58m > 30m, waits for the long check",
    })
  })

  it("shows the projected duration and bound with < when projected is less than bound", () => {
    const row: Row = {
      branch: "task/under",
      head: "b".repeat(40),
      state: "deferred" as any,
      projectedMs: 17 * 60 * 1000,
      boundMs: 30 * 60 * 1000,
    }
    const suffix = changesSuffix(row)
    expect(suffix).toEqual({
      color: "$fg-accent",
      text: "projected 17m < 30m, waits for the long check",
    })
  })

  it("shows the projected duration and bound with = when projected equals bound", () => {
    const row: Row = {
      branch: "task/equal",
      head: "c".repeat(40),
      state: "deferred" as any,
      projectedMs: 30 * 60 * 1000,
      boundMs: 30 * 60 * 1000,
    }
    const suffix = changesSuffix(row)
    expect(suffix).toEqual({
      color: "$fg-accent",
      text: "projected 30m = 30m, waits for the long check",
    })
  })
})
