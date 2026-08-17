/**
 * @failure A RUNNER box line longer than the queue pane paints over the box's
 *          right border and loses its tail, instead of clipping inside the box.
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * The uncarried rail is the line that exposed this (operator report,
 * 2026-08-13): at a live split-pane width `uncarried 41 of 4784 refs, …`
 * overran the frame, ate the `│`, and was clipped by the terminal edge rather
 * than the box. The root cause was silvery's own measureFunc skipping the
 * `maxWidth` clamp for a `wrap="truncate"` Text as a direct COLUMN child
 * (@si/render/truncate-clip-bordered-column) — rows were rescued by flexily's
 * min-content query, columns were not. The original remedy swapped every
 * prose rail here to `wrap="wrap"`; once silvery's root fix landed, that swap
 * was reverted back to `truncate` (@yrd/core/stale-runner-never-recycles's
 * sibling bead), so this file now proves the CLIPPED shape — border intact,
 * content elided with `…` — instead of the wrapped one. `boxRows` below is
 * the load-bearing regression guard for both: a line that paints over `│`
 * fails there regardless of which `wrap` mode is active.
 */
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureRun, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { uncarriedLine, uncarriedObservation, type UncarriedObservation } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

/** Width at which the uncarried rail below overflows a full-width queue pane. */
const NARROW_COLS = 80

type BoxRows = Readonly<{ inner: readonly string[]; joined: string }>

/**
 * The rows of a titled box, proven to be inside an intact frame: every row
 * between the corners carries both borders at the columns the top border set.
 * A line that paints over `│` fails here — which is exactly the defect.
 */
function boxRows(text: string, title: string): BoxRows {
  const rows = text.split("\n")
  const topIndex = rows.findIndex((row) => row.includes(`╭─ ${title} `))
  expect(topIndex, `top border for ${title}`).toBeGreaterThanOrEqual(0)
  const top = rows[topIndex] ?? ""
  const left = top.indexOf(`╭─ ${title} `)
  const right = top.indexOf("╮", left)
  expect(right, `top-right corner for ${title}`).toBeGreaterThan(left)

  const inner: string[] = []
  let bottomIndex = -1
  for (let index = topIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? ""
    if (row[left] === "╰") {
      bottomIndex = index
      break
    }
    expect(row[left], `${title} left border at row ${index}`).toBe("│")
    expect(row[right], `${title} right border at row ${index}`).toBe("│")
    inner.push(row.slice(left + 1, right))
  }
  expect(bottomIndex, `bottom border for ${title}`).toBeGreaterThan(topIndex)
  return { inner, joined: inner.join(" ").replace(/\s+/gu, " ").trim() }
}

/** The frame's clock in these fixtures — the rail reads "4m ago" from it. */
const NOW_MS = Date.parse("2026-07-13T12:00:00.000Z")

const UNCARRIED: UncarriedObservation = uncarriedObservation({
  count: 41,
  scanned: 4784,
  missingUpdateClocks: 12,
  observedAt: "2026-07-13T11:56:00.000Z",
})

function snapshotWithUncarried() {
  const pr = fixturePr("PR1", "submitted", "2026-07-13T11:10:00.000Z", "Prepare release notes")
  const run = fixtureRun("R1", [pr], "passed", "2026-07-13T11:20:00.000Z", { finishedAt: "2026-07-13T11:25:00.000Z" })
  return fixtureSnapshot(fixtureResult([pr], [run]), {
    runner: {
      pid: 84042,
      startedAt: "2026-07-13T11:00:00.000Z",
      lastTickAt: "2026-07-13T11:59:58.000Z",
      queueProgress: { state: "healthy", observedAt: "2026-07-13T11:59:58.000Z" },
      uncarried: UNCARRIED,
    },
  })
}

describe("RUNNER box clips rather than overflowing (@yrd/cli/runner-box-overflow, @si/render/truncate-clip-bordered-column)", () => {
  it("keeps an over-wide uncarried rail inside the frame, eliding it on one line instead of painting over the border", async () => {
    const app = createRenderer({ cols: NARROW_COLS, rows: 40 })(
      createElement(QueueWatchFrame, { snapshot: snapshotWithUncarried() }),
    )
    try {
      await app.waitForLayoutStable()
      const box = boxRows(app.text, "RUNNER")

      // Guard: the rail really is wider than the box, so a pass cannot mean
      // "the sentence happened to fit".
      const width = (box.inner[0] ?? "").length
      // Derived from the renderer, never transcribed: this test is about the
      // BOX, and a copied sentence turns every rewording of the rail into a
      // spurious wrap failure. It went stale exactly that way once already.
      const rail = uncarriedLine(UNCARRIED, NOW_MS)
      expect(rail.length, "fixture rail must overflow the box").toBeGreaterThan(width)

      // Clipped, not painted over the border: the rail elides with `…` and the
      // count's leading digits survive — boxRows already proved every row kept
      // both `│` borders, which is the defect this guards: pre-fix, this exact
      // rail ran past the right border and was cut by the terminal instead.
      const started = box.inner.findIndex((row) => row.includes("of 4784 refs"))
      expect(started, "the uncarried rail must be rendered").toBeGreaterThanOrEqual(0)
      const uncarriedRow = box.inner[started] ?? ""
      expect(uncarriedRow).toContain("…")

      // And it stays on its own line — clip means single-line, not a
      // continuation row carrying the "as of …" tail (that was the wrap-era
      // shape, which is why the tail — the half that makes the count
      // trustworthy — is exactly what elides here instead of surviving).
      expect(uncarriedRow, "the elided rail must not carry its own tail").not.toContain("ago")
    } finally {
      app.unmount()
    }
  })

  it("elides the over-wide refusal prose and the NO RUNNER header, both inside the frame", async () => {
    const pr = fixturePr("PR1", "submitted", "2026-07-13T11:10:00.000Z", "Prepare release notes")
    const snapshot = {
      ...fixtureSnapshot(fixtureResult([pr], []), { runner: null }),
      // A refusal message is operator-authored text of unbounded length; it is
      // the second way this box goes over-wide.
      runnerRefusal: {
        // Long enough that both the glyph-led header row and the refusal
        // prose rail below it must elide.
        run: "release/next-hardening-program#2173",
        code: "stale-step-contract",
        message: "the recorded step contract predates the runner's implementation and cannot be replayed safely",
      },
    }
    const app = createRenderer({ cols: NARROW_COLS, rows: 40 })(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      const box = boxRows(app.text, "RUNNER")
      // The prose rail elides — but inside the frame, which boxRows already
      // proved by finding both borders on every row.
      const refusalRow = box.inner.findIndex((row) => row.includes("stale-step-contract:"))
      expect(refusalRow, "the refusal prose rail must be rendered").toBeGreaterThanOrEqual(0)
      expect(box.inner[refusalRow] ?? "").toContain("…")

      // The header elides too — it always did (the two glyph-led header rows
      // keep `truncate` regardless of this bead; see TimelineRunnerBox).
      expect(box.joined).toContain("NO RUNNER - runner stopped: stale step contract")
      expect(
        box.inner.some((row) => row.includes("…")),
        "at least the header row must elide rather than overflow",
      ).toBe(true)
    } finally {
      app.unmount()
    }
  })
})
