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
import { foldDrafts, type Draft, type Row, type WatchRow } from "@yrd/queue-core"
import {
  ListRow,
  changesSuffix,
  listLayout,
  taskExtrasLayout,
  truncateWithEllipsis,
  type ListLayout,
} from "../src/watch-list.tsx"
import { draftsSaid } from "../src/watch-frame.tsx"
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
  it("shows AGE from since and keeps merged row's RUN at endedAt − startedAt (freezes on done, 25630)", async () => {
    const { first, second } = await paintAge(DECIDED_ROW)
    expect(first).toContain("30:00 / 15:00")
    expect(second).toContain("30:00 / 15:00")
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

describe("the drafts the home list folds into a count (25424)", () => {
  const now = new Date("2026-09-23T20:00:00Z")
  const draft = (branch: string, hoursAgo: number | undefined): Draft => ({
    branch,
    head: branch.padEnd(40, "0"),
    ...(hoursAgo === undefined ? {} : { committedAt: new Date(now.getTime() - hoursAgo * 3_600_000) }),
    movedSinceSubmit: false,
  })

  it("lists the drafts of the last day as rows and counts the older ones of the week", () => {
    const folded = foldDrafts(
      [draft("task/hour", 1), draft("task/day", 24), draft("task/days", 30), draft("task/week", 6 * 24)],
      now,
    )
    expect({ rows: folded.rows.map((row) => row.branch), older: folded.older }).toEqual({
      rows: ["task/hour", "task/day"],
      older: 2,
    })
  })

  it("says the fold in words: the day's rows, then how many older ones and unread heads there are", () => {
    const rows: readonly WatchRow[] = ["task/a", "task/b"].map((branch) => ({
      row: { at: now, branch, head: branch.padEnd(40, "0"), state: "draft" } as Row,
    }))
    expect(draftsSaid(rows, { older: 98, unread: 2, window: "7d" })).toBe("2 drafts (1d), 98 older, 2 not yet read")
    expect(draftsSaid(rows, { older: 0, unread: 0, window: "all" })).toBe("2 drafts (all)")
    expect(draftsSaid([], { older: 0, unread: 0, window: "7d" })).toBeUndefined()
  })
})

describe("ISSUE / BRANCH column capping and title preservation (25716)", () => {
  const longBranch =
    "task/@i/10-yrd/25041-readers-tolerate-an-unknown-event-kind/25647-advance-pins/25667-readers-tolerate-an-unknown-event-kind-with-extra-padding-to-reach-150-chars-total-length"
  const longError =
    "failure in step check with very long diagnostic explanation that extends past normal terminal boundaries and squeezes the row"

  it("truncates with ellipsis when string exceeds maxLen", () => {
    expect(truncateWithEllipsis("short", 10)).toBe("short")
    expect(truncateWithEllipsis("exact10len", 10)).toBe("exact10len")
    expect(truncateWithEllipsis("longer-than-ten", 10)).toBe("longer-th…")
    expect(truncateWithEllipsis("longer", 1)).toBe("…")
    expect(truncateWithEllipsis("longer", 0)).toBe("")
  })

  // Acceptance: in the ISSUE / BRANCH column, an error and a branch name each take at most 50%
  // of the column's width; the title keeps the remainder and never less than a third;
  // anything cut ends with an ellipsis; the full text stays in the detail pane.
  // Witness: a 150-character branch and a 120-character error, each at three terminal widths (80, 120, 160).
  for (const cols of [80, 120, 160]) {
    it(`caps a 150-character branch at 50% width and guarantees title keeps >= 1/3 at ${cols} columns`, () => {
      expect(longBranch.length).toBeGreaterThanOrEqual(150)
      const layout = listLayout([], cols, NOW)
      const taskWidth = layout.taskWidth!
      expect(taskWidth).toBeGreaterThan(0)

      const result = taskExtrasLayout(taskWidth, longBranch, undefined)
      // Branch takes at most 50% of column width (including leading space: 1 + displayBranch.length <= 0.5 * taskWidth)
      const branchDisplayWidth = result.displayBranch.length + 1
      expect(branchDisplayWidth).toBeLessThanOrEqual(Math.floor(taskWidth * 0.5))
      expect(result.displayBranch.endsWith("…")).toBe(true)

      // Title keeps the remainder and never less than a third
      const titleRemainder = taskWidth - branchDisplayWidth
      expect(titleRemainder).toBeGreaterThanOrEqual(Math.ceil(taskWidth / 3))
      expect(titleRemainder).toBeGreaterThanOrEqual(result.minTitle)
    })

    it(`caps a 120-character error at 50% width and guarantees title keeps >= 1/3 at ${cols} columns`, () => {
      expect(longError.length).toBeGreaterThanOrEqual(120)
      const layout = listLayout([], cols, NOW)
      const taskWidth = layout.taskWidth!
      expect(taskWidth).toBeGreaterThan(0)

      const result = taskExtrasLayout(taskWidth, "task/short", `err=${longError}`)
      // Suffix takes at most 50% of column width (including space and parens: 3 + displaySuffix.length <= 0.5 * taskWidth)
      const suffixDisplayWidth = (result.displaySuffix?.length ?? 0) + 3
      expect(suffixDisplayWidth).toBeLessThanOrEqual(Math.floor(taskWidth * 0.5))
      expect(result.displaySuffix?.endsWith("…")).toBe(true)

      // Title keeps the remainder and never less than a third
      const totalExtras = result.displayBranch.length + 1 + suffixDisplayWidth
      const titleRemainder = taskWidth - totalExtras
      expect(titleRemainder).toBeGreaterThanOrEqual(Math.ceil(taskWidth / 3))
    })

    it(`renders a 150-char branch without squeezing out title in Silvery terminal at ${cols} columns`, async () => {
      const row: Row = {
        branch: longBranch,
        head: "deadbeef".padEnd(40, "0"),
        state: "queued",
        subject: "feat(yrd): preserve the issue title",
      }
      const layout = listLayout([{ row }], cols, NOW)
      const app = render(
        <NowContext.Provider value={NOW}>
          <ListRow cursor={false} item={{ row }} layout={layout} />
        </NowContext.Provider>,
        { cols, rows: 2 },
      )
      await act(async () => {
        await app.waitForLayoutStable()
      })
      const line = app.lines[0] ?? ""
      // Both title and truncated branch must be visible in the rendered terminal line
      expect(line).toContain("feat(yrd):")
      expect(line).toContain("task/@i/10-yrd/")
      expect(line).toContain("…")
      app.unmount()
    })

    it(`renders a 120-char error without squeezing out title in Silvery terminal at ${cols} columns`, async () => {
      const row: Row = {
        branch: "task/short-branch",
        head: "deadbeef".padEnd(40, "0"),
        state: "failed",
        reason: longError,
        subject: "feat(yrd): preserve the issue title",
      }
      const layout = listLayout([{ row }], cols, NOW)
      const app = render(
        <NowContext.Provider value={NOW}>
          <ListRow cursor={false} item={{ row }} layout={layout} />
        </NowContext.Provider>,
        { cols, rows: 2 },
      )
      await act(async () => {
        await app.waitForLayoutStable()
      })
      const line = app.lines[0] ?? ""
      // Both title, branch, and truncated error must be visible in the rendered terminal line
      expect(line).toContain("feat(yrd):")
      expect(line).toContain("task/short")
      expect(line).toContain("err=")
      expect(line).toContain("…")
      app.unmount()
    })
  }
})
