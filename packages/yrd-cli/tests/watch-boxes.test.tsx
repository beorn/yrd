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
// One home for the perception floor. This file used to carry its own copy, and
// the detail pane's pulse arm would have carried a second — two tests each
// agreeing with their own duplicate while the thing they measure drifts.
import { PERCEPTIBLE_SWING, PULSE_HALF_PERIOD_MS, contrastRatio } from "./support/perceptible-color.ts"

const NOW = new Date("2026-09-03T12:00:00.000Z")

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
          <RunnerBox facts={RUNNING} label="main" inLine={1} columns={70} live />
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
      await new Promise((resolve) => setTimeout(resolve, PULSE_HALF_PERIOD_MS))
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
