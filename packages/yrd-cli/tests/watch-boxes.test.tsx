/**
 * @failure  The running `$` marker (item 13) swung its live color between two
 *           FOREGROUND tokens — `$fg-info` and `$fg-muted` — whose resolved
 *           colors sit ~1.12:1 apart: imperceptible. The working idle marker,
 *           two lines away in the same file, swings foreground-vs-a-BACKGROUND
 *           token instead, which is why it reads. Nothing in this suite ever
 *           rendered a `RunnerBox` with `live=true`, so this went unnoticed
 *           across three separate live-pane investigation passes (audit,
 *           2026-09-09, @i/10-yrd/yrd-watch-lost-the-operator-spec-detail-pane).
 *           The box is a ROW since S1; both properties are the row's now, and
 *           the colour is read off the word's own entry in THE ONE WORD TABLE,
 *           which is what makes item 27 automatic rather than remembered.
 * @level    l2 (a real silvery render, real wall-clock across one pulse period —
 *           the synchronized phase clock has no injectable substitute)
 * @consumer the operator reading the runner's row while a check is running
 */

import { act } from "react"
import { describe, expect, it } from "vitest"
import { render } from "silvery/test"
import { MinuteContext, NowContext } from "../src/watch-clock.ts"
import { RunnerRow, listLayout } from "../src/watch-list.tsx"
import { runnerLine, type RunnerFacts } from "../src/watch-runner.ts"

/** The service's own health document, believable by the deadline its writer declared: the runner is up. */
const BEATING = { kind: "beating", state: "healthy" } as const

const NOW = new Date("2026-09-03T12:00:00.000Z")

// `alive` is retained because the row still says whether the process answers,
// but it is no longer what makes anything pulse: `underCheck` is (items 1 and
// 5). A fixture that only set `alive` would paint an idle row and the pulse arm
// would measure a marker that is deliberately not pulsing.
const RUNNING: RunnerFacts = {
  journalDir: "/w/logs",
  service: BEATING,
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

const HELD = { branch: "task/x", since: NOW, subject: "the change under a check", submitter: "@dev/2" }

/** The runner's row on its own, at the table's own geometry. */
function runnerRow(facts: RunnerFacts, options: Parameters<typeof runnerLine>[2] = {}) {
  const line = runnerLine(facts, NOW, options)
  return (
    <NowContext.Provider value={NOW}>
      <MinuteContext.Provider value={NOW}>
        <RunnerRow line={line} layout={listLayout([], 120, NOW, line)} />
      </MinuteContext.Provider>
    </NowContext.Provider>
  )
}

// 24196 (A2-set-v2 item 8): the runner's marker no longer pulses. The one thing
// on screen that pulses is the marker of the change a check holds, on its own
// row (watch-pane.test.tsx) — which, since S1, IS the runner's row.
describe("the runner's marker, live (item 13, 24196)", () => {
  it("holds the running marker still: the one pulse on screen is the held change's row", async () => {
    const app = render(runnerRow(RUNNING, { held: HELD, waiting: 1 }), { cols: 120, rows: 4, autoRender: true })
    await act(async () => {
      await app.waitForLayoutStable()
    })
    const row = app.lines.findIndex((line) => line.includes("\u25b8"))
    expect(row).toBeGreaterThan(-1)
    const col = app.lines[row]!.indexOf("\u25b8")
    const phaseA = app.cell(col, row)
    expect(phaseA.char).toBe("\u25b8")
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

    expect(phaseB.char).toBe("\u25b8")
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
 * The box had a border to anchor "the box's severity colour" to. The row has
 * the WORD, which is the same anchor read from the same place the colour comes
 * from: the state's own entry in THE ONE WORD TABLE. Asserted RELATIONALLY, so
 * a theme change moves the arm with it instead of breaking it.
 */
describe("item 27 — an ERROR is never dimmed, and wears the state's own color", () => {
  // `stuck` is the loudest word an S1 reading can actually produce: the line
  // stopped at a change the queue could not judge, read from the queue's own
  // stop record. The states that would have been louder — `silent`, `stopped` —
  // are the runner's own published beat, and it publishes none yet.
  const STUCK = {
    by: "yrd-service",
    cause: "stuck" as const,
    change: `task/s@${"4".repeat(40)}`,
    since: new Date(NOW.getTime() - 6 * 60_000).toISOString(),
  }

  async function paintStopped() {
    const app = render(runnerRow(RUNNING, { stopped: STUCK, waiting: 3 }), {
      cols: 120,
      rows: 4,
      autoRender: true,
    })
    await app.waitForLayoutStable()
    const at = (needle: string, within?: string) => {
      const row = app.lines.findIndex((line) => line.includes(within ?? needle))
      expect(row, `expected a row containing ${JSON.stringify(within ?? needle)}`).toBeGreaterThan(-1)
      return app.cell(app.lines[row]!.indexOf(needle), row)
    }
    return { app, at }
  }

  it("the affected text wears the state word's color, not a muted one", async () => {
    const { app, at } = await paintStopped()
    const word = at("stuck", "\u25b8 stuck")
    const explain = at("line stopped at")
    const timer = at("stuck 6:00")
    app.unmount()

    expect(word.fg).not.toBeNull()
    // "whatever the box border shows" is "whatever the WORD shows" now, and
    // both come from the state's one entry, so this survives a theme change.
    expect(explain.fg, "the error explanation is the affected text").toEqual(word.fg)
    expect(timer.fg, "and the cell naming the state and its age").toEqual(word.fg)
  })

  it("CONTROL: an idle runner's own text is muted, so this is a distinction and not a red row", async () => {
    const { app, at } = await paintStopped()
    const word = at("stuck", "\u25b8 stuck")
    app.unmount()

    const idle = render(runnerRow(RUNNING, { waiting: 0 }), { cols: 120, rows: 4, autoRender: true })
    await idle.waitForLayoutStable()
    const row = idle.lines.findIndex((line) => line.includes("nothing in line"))
    const quiet = idle.cell(idle.lines[row]!.indexOf("nothing in line"), row)
    idle.unmount()

    // Without this, painting every glyph on the row in the error colour would
    // satisfy the arm above while destroying the muting item 14 asks for.
    expect(quiet.fg).not.toEqual(word.fg)
    // NO CONTRAST-RATIO ASSERTION HERE, and the reason is worth keeping: one was
    // written, and it FAILED ON CORRECT CODE. A WCAG contrast ratio is relative
    // luminance, and these two differ by HUE at near-identical lightness —
    // muted rgb(143,149,161) against error rgb(225,127,135) measures 1.09:1.
    // The retired pulse arm used that ratio correctly, because a pulse swung
    // foreground against BACKGROUND, which is a luminance swing. Asserting a
    // luminance floor on a hue distinction measures the wrong axis and would
    // reject a correct implementation. Inequality is the honest claim.
  })
})
