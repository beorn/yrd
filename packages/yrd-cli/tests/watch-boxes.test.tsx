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

// 24196 (A2-set-v2 item 8): the `$` no longer pulses. The one thing on screen that pulses is the marker of
// the change a check holds, on its own row (watch-pane.test.tsx), so this arm now pins the marker still
// across the same real half-period, while a check runs.
describe("RunnerBox `$` marker, live (item 13, 24196)", () => {
  it("holds the running marker still: the one pulse on screen is the held change's row", async () => {
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <RunnerBox facts={RUNNING} label="main" inLine={1} underCheck columns={70} />
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

    // A pulse would run on a real, shared wall-clock timer (silvery's
    // synchronized phase, a 900ms interval) with no injectable clock, so this
    // waits out one real half-period, where a pulsing marker would show its
    // other phase.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 950))
      await app.waitForLayoutStable()
    })
    const phaseB = app.cell(col, row)
    app.unmount()

    expect(phaseB.char).toBe("$")
    expect(phaseB.fg).toEqual(phaseA.fg)
  }, 10_000)
})

/**
 * @failure  Spec item 27's error half: "On an ERROR state — the affected text
 *           takes the box's severity color (red / whatever the box border
 *           shows), NOT muted; muting must never dim an error." NOTHING pinned
 *           it, and it was mis-measured TWICE: reported NOT SATISFIED on
 *           2026-09-07 through a PTY that `FORCE_COLOR=1` had pinned to ansi16,
 *           where `fg-error` and `fg-muted` both quantise to the same grey, so
 *           "the error is not red" was guaranteed by the instrument and carried
 *           no information (@km/silvery/24277, @i/1-instruments/24276). The
 *           finding was voided 2026-09-08 and the row sat NOT MEASURED.
 * @level    l2 — a real silvery render, colour read from the CELL BUFFER after
 *           the renderer resolves tokens, which is the only reading that is not
 *           at the mercy of the capture terminal's palette.
 * @consumer the operator who must see, at a glance, that the queue is wedged.
 *
 * Measured 2026-09-11 at truecolor: border, the SILENT explanation across both
 * wrapped rows, the timer word, the marker and the command all resolve to
 * rgb(225,127,135); the last-run metadata rails resolve to rgb(143,149,161).
 * Asserted RELATIONALLY below rather than by those literals, so a theme change
 * moves the arm with it instead of breaking it.
 */
describe("item 27 — an ERROR is never dimmed, and wears the border's own color", () => {
  const SILENT: RunnerFacts = {
    journalDir: "/w/logs",
    latest: {
      alive: true,
      checks: ["typecheck"],
      gitlink: "3c285a41af46".padEnd(40, "0"),
      id: "q-20260903T115800000Z-0badf00d",
      lastWriteAt: new Date(NOW.getTime() - 12 * 60_000),
      startedAt: new Date(NOW.getTime() - 20 * 60_000),
      target: "main",
    },
  }

  async function paintSilent() {
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <RunnerBox facts={SILENT} label="main" inLine={3} underCheck={false} columns={70} />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      { cols: 72, rows: 14, autoRender: true },
    )
    await app.waitForLayoutStable()
    const at = (needle: string, within?: string) => {
      const row = app.lines.findIndex((line) => line.includes(within ?? needle))
      expect(row, `expected a row containing ${JSON.stringify(within ?? needle)}`).toBeGreaterThan(-1)
      return app.cell(app.lines[row]!.indexOf(needle), row)
    }
    return { app, at }
  }

  it("the affected text wears the BORDER's color, not a muted one", async () => {
    const { app, at } = await paintSilent()
    const border = at("╭")
    const explain = at("RUNNER SILENT")
    const continuation = at("in line")
    const timer = at("silent", "silent 12:00")
    app.unmount()

    expect(border.fg).not.toBeNull()
    // "whatever the box border shows" — asserted against the border itself, so
    // this survives a theme change that moves what `$fg-error` resolves to.
    expect(explain.fg, "the error explanation is the affected text").toEqual(border.fg)
    expect(continuation.fg, "including the row it wraps onto").toEqual(border.fg)
    expect(timer.fg, "and the word naming the state").toEqual(border.fg)
  })

  it("CONTROL: the last-run metadata rails ARE still muted, so this is a distinction and not a red box", async () => {
    const { app, at } = await paintSilent()
    const border = at("╭")
    const target = at("target")
    const progress = at("progress")
    app.unmount()

    // Without this, painting every glyph in the box red would satisfy the arm
    // above while destroying the muting item 14 asks for.
    expect(target.fg).not.toEqual(border.fg)
    expect(progress.fg).not.toEqual(border.fg)
    // NO CONTRAST-RATIO ASSERTION HERE, and the reason is worth keeping: I wrote
    // one, and it FAILED ON CORRECT CODE. A WCAG contrast ratio is relative
    // luminance, and these two differ by HUE at near-identical lightness —
    // muted rgb(143,149,161) against error rgb(225,127,135) measures 1.09:1.
    // The retired pulse arm used that ratio correctly, because a pulse swung
    // foreground against BACKGROUND, which is a luminance swing. Asserting a
    // luminance floor on a hue distinction measures the wrong axis and would
    // reject a correct implementation. Inequality is the honest claim.
    //
    // That near-equal luminance is a real observation, not a defect of this box:
    // an operator who cannot separate those hues sees two similar greys. That
    // belongs to the theme, beside @km/silvery/24277, not to this arm.
  })
})
