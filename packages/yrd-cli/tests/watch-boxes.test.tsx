/**
 * @failure  The running `$` marker (item 13) swung its live color between two
 *           FOREGROUND tokens — `$fg-info` and `$fg-muted` — whose resolved
 *           colors sit ~1.12:1 apart: imperceptible. The working idle marker,
 *           two lines away in the same file, swings foreground-vs-a-BACKGROUND
 *           token instead, which is why it reads. Nothing in this suite ever
 *           rendered a `RunnerBox` with `live=true`, so this went unnoticed
 *           across three separate live-pane investigation passes (audit,
 *           2026-09-09, @i/10-yrd/yrd-watch-lost-the-operator-spec-detail-pane).
 * @level    l2 (a real silvery render, real wall-clock across one pulse period —
 *           the synchronized phase clock has no injectable substitute)
 * @consumer the operator reading the RUNNER box while a check is running
 */

import { act } from "react"
import { describe, expect, it } from "vitest"
import { render } from "silvery/test"
import { RunnerBox } from "../src/watch-boxes.tsx"
import { MinuteContext, NowContext } from "../src/watch-clock.ts"
import type { RunnerFacts } from "../src/watch-runner.ts"

const NOW = new Date("2026-09-03T12:00:00.000Z")

/** WCAG relative luminance (0..1) of a resolved RGB triple. */
function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (value: number): number => {
    const s = value / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two resolved colors: 1 (identical) to 21 (black/white). */
function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// The audit measured the broken foreground-vs-foreground swing at ~1.12:1 and
// the working idle marker's foreground-vs-background swing well above it.
// This floor sits between the two: it fails the broken pair and clears easily
// for a swing that actually reads as a marker turning on and off.
const PERCEPTIBLE_SWING = 2

// `alive` is retained because the box still names the run's pid, but it is no
// longer what makes the marker pulse: `underCheck` is (items 1 and 5). A fixture
// that only set `alive` would now paint an idle box and the pulse arm would
// measure a marker that is deliberately not pulsing.
const RUNNING: RunnerFacts = {
  journalDir: "/w/logs",
  latest: {
    alive: true,
    checks: ["typecheck"],
    gitlink: "3c285a41af46".padEnd(40, "0"),
    id: "q-20260903T115800000Z-0badf00d",
    lastWriteAt: NOW,
    startedAt: NOW,
    target: "main",
  },
}

describe("RunnerBox `$` marker pulse, live (item 13)", () => {
  it("swings the running marker's own color enough to actually read as pulsing, not two look-alike foregrounds", async () => {
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <RunnerBox facts={RUNNING} label="main" inLine={1} underCheck columns={70} live />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      { cols: 72, rows: 12, autoRender: true },
    )
    await act(async () => {
      await app.waitForLayoutStable()
    })
    const row = app.lines.findIndex((line) => line.includes("$ yrd queue run"))
    expect(row).toBeGreaterThan(-1)
    const col = app.lines[row]!.indexOf("$")
    const phaseA = app.cell(col, row)
    expect(phaseA.char).toBe("$")
    expect(phaseA.fg).not.toBeNull()

    // The marker pulses on a real, shared wall-clock timer (silvery's
    // synchronized phase, item C's 900ms interval) — there is no injectable
    // clock for it, so this waits out one real half-period to see the other
    // phase, the same way an operator's eye would.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 950))
      await app.waitForLayoutStable()
    })
    const phaseB = app.cell(col, row)
    app.unmount()

    expect(phaseB.char).toBe("$")
    expect(phaseB.fg).not.toBeNull()
    expect(phaseA.fg).not.toEqual(phaseB.fg)
    expect(contrastRatio(phaseA.fg!, phaseB.fg!)).toBeGreaterThan(PERCEPTIBLE_SWING)
  }, 10_000)
})
