/**
 * @failure  A box whose identity lived in a title row above it, not on its
 *           border (item 23), and marker-led lines whose wrapped text fell
 *           back under the marker instead of hanging off it (item 29a).
 * @level    l2 (a real silvery render into a headless terminal buffer)
 * @consumer the operator reading any `yrd watch` box
 */

import { describe, expect, it } from "vitest"
import { Text } from "silvery"
import { run } from "silvery/runtime"
import { createTermless, render } from "silvery/test"
import type { Row } from "@yrd/queue-core"
import { ListRow, listLayout } from "../src/watch-list.tsx"
import {
  ACTIVITY_PULSE_COLORS,
  AG_PULSE_INTERVAL_MS,
  ActivityPulse,
  MarkerRow,
  TitledBox,
} from "../src/watch-primitives.tsx"
import { WATCH_RUN_OPTIONS } from "../src/watch-run-options.ts"

async function paint(element: Parameters<typeof render>[0], cols = 40): Promise<string> {
  const app = render(element, { cols, rows: 8 })
  await app.waitForLayoutStable()
  const text = app.text
  app.unmount()
  return text
}

describe("TitledBox", () => {
  it("punches the left title and the right label into the top border", async () => {
    const text = await paint(
      <TitledBox title="RUNNER" titleRight="RUN main#170406">
        <Text>body</Text>
      </TitledBox>,
    )
    const [top] = text.split("\n")
    expect(top).toContain("╭─ RUNNER ─")
    expect(top).toContain("─ RUN main#170406 ─╮")
    expect(text).toContain("│ body")
  })

  it("carries only the right label when no left title is given, so the status box's border IS its identity", async () => {
    const text = await paint(
      <TitledBox titleRight="RUN main#170406">
        <Text>✓ merged</Text>
      </TitledBox>,
    )
    const [top] = text.split("\n")
    expect(top?.startsWith("╭──")).toBe(true)
    expect(top).toContain(" RUN main#170406 ─╮")
  })
})

describe("MarkerRow (item 29a)", () => {
  it("puts the marker in a gutter and hangs wrapped text off it", async () => {
    const text = await paint(
      <MarkerRow marker={<Text>$</Text>}>
        <Text wrap="wrap">alpha beta gamma delta epsilon zeta eta theta</Text>
      </MarkerRow>,
      20,
    )
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    expect(lines[0]?.startsWith("$ alpha")).toBe(true)
    // Every continuation line starts at the text column, two cells in, never under the marker.
    for (const line of lines.slice(1)) expect(line.startsWith("  ")).toBe(true)
    expect(lines.length).toBeGreaterThan(1)
  })

  it("reserves the gutter when there is no marker, so sibling rows share one text column", async () => {
    const text = await paint(
      <MarkerRow>
        <Text>aligned</Text>
      </MarkerRow>,
    )
    expect(text.split("\n")[0]?.startsWith("  aligned")).toBe(true)
  })
})

const PULSE_NOW = new Date("2026-09-03T12:00:00.000Z")

function liveRow(): Row {
  return {
    branch: "task/one",
    head: "1111111111111111111111111111111111111111",
    state: "checked",
    since: new Date(PULSE_NOW.getTime() - 60_000),
    at: PULSE_NOW,
    submitter: "@dev/1",
    subject: "task/one does its work",
    live: { check: "typecheck" },
  } as Row
}

/**
 * One cell's foreground, GUARDED BEFORE IT IS MEASURED.
 *
 * Under a 16-colour capture Nord `#81a1c1` collapses to `#c0c0c0`, and two
 * earlier findings on this exact view were WITHDRAWN on 2026-09-07 for that
 * artifact. Termless hands back a truecolor `{r,g,b}` only when it really
 * captured one, so the SHAPE is the guard: assert each channel is a number
 * before any comparison runs, or a degraded capture answers confidently and
 * wrongly — the defect family this whole view belongs to.
 */
function fgOf(cell: { readonly fg: unknown }): readonly [number, number, number] {
  const fg = cell.fg as { r?: unknown; g?: unknown; b?: unknown } | null
  expect(fg, "the cell must carry a colour at all").not.toBeNull()
  for (const channel of ["r", "g", "b"] as const) {
    expect(typeof fg?.[channel], `${channel} must be a truecolor channel, not an ANSI index`).toBe("number")
  }
  return [fg?.r as number, fg?.g as number, fg?.b as number]
}

/**
 * Wait for the OBSERVABLE flip rather than sleeping one interval: the phase
 * comes from a shared synchronized clock these components do not expose, so a
 * fixed sleep can sample the same phase twice. Deterministic in OUTCOME.
 */
async function nextPhase(
  read: () => readonly [number, number, number],
  first: readonly [number, number, number],
): Promise<readonly [number, number, number]> {
  let seen = first
  const deadline = Date.now() + 4_000
  while (seen.every((value, at) => value === first[at]) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    seen = read()
  }
  return seen
}

/**
 * @failure  The activity pulse was rebuilt without its cadence or its row-level
 *           presence, and the cursor's forced colour flattened what remained.
 *           Three separate losses reading as one "the marker does not blink":
 *           every call site omitted `intervalMs`, so silvery's 500 ms default
 *           ran the pulse 1.8x too fast; `ListRow` carried no `Pulse` at all;
 *           and a selected row forced one colour onto both phases, killing the
 *           pulse on row 0 — the row being checked, and so the one always
 *           looked at. Restored from yrd `1f638504`.
 * @level    l0 (the restored constants) and l1 (a real render, phases read off
 *           the terminal buffer)
 * @consumer the operator watching whether the queue is working
 */
describe("the activity pulse, restored", () => {
  it("carries the retired pane's own cadence and pair, unchanged", () => {
    // `queue-status-projection.ts:2005-2008` at yrd 1f638504. ag pulses on an
    // 1800 ms period and silvery's `Pulse` toggles ONCE per `intervalMs`, so
    // half the period reproduces the blink.
    //
    // THIS ARM EXISTS BECAUSE THE PAIR WAS ALREADY "IMPROVED" ONCE. It measures
    // 1.12:1 on Nord, which is faint, and the faintness is the original's. A
    // more legible pair may well be right — it is a design decision owned by
    // `@chief` and `@cto`, and it does not get made by a passing edit here.
    expect(AG_PULSE_INTERVAL_MS).toBe(900)
    expect(ACTIVITY_PULSE_COLORS).toEqual(["$fg-info", "$fg-muted"])
  })

  it("actually alternates two colours, captured in truecolor", async () => {
    using term = createTermless({ cols: 24, rows: 4 })
    const handle = await run(<ActivityPulse>◉</ActivityPulse>, term, WATCH_RUN_OPTIONS)
    try {
      await handle.waitForLayoutStable()
      const lines = term.screen.getLines()
      const row = lines.findIndex((line) => line.includes("◉"))
      expect(row, "the marker must be painted").toBeGreaterThan(-1)
      const column = lines[row]!.indexOf("◉")

      const read = (): readonly [number, number, number] => fgOf(term.cell(row, column))
      const first = read()
      const second = await nextPhase(read, first)
      expect(second, "a marker that never changes colour is not pulsing").not.toEqual(first)
    } finally {
      handle.unmount()
    }
  })

  it("KEEPS PULSING ON THE SELECTED ROW — the cursor's forced colour must not reach it", async () => {
    // The regression this pins is the expensive one. The cursor forces
    // `$fg-on-selected` onto every cell so the selection reads as one block; if
    // the activity marker takes it too, both phases resolve to the same colour
    // and the row stops pulsing. That row is normally row 0, which is the row
    // under check — so the pulse died exactly where it was being read.
    const item = { row: liveRow() }
    using term = createTermless({ cols: 120, rows: 4 })
    const handle = await run(
      <ListRow
        item={item}
        previous={undefined}
        label="main"
        layout={listLayout([item], "main", 120, PULSE_NOW)}
        cursor
      />,
      term,
      WATCH_RUN_OPTIONS,
    )
    try {
      await handle.waitForLayoutStable()
      const lines = term.screen.getLines()
      const row = lines.findIndex((line) => line.includes("checked"))
      expect(row, "the live row must be painted").toBeGreaterThan(-1)
      const column = lines[row]!.indexOf("checked")

      const read = (): readonly [number, number, number] => fgOf(term.cell(row, column))
      const first = read()
      const second = await nextPhase(read, first)
      expect(second, "the selected row's status word stopped pulsing: the cursor colour reached it").not.toEqual(first)
    } finally {
      handle.unmount()
    }
  })
})
