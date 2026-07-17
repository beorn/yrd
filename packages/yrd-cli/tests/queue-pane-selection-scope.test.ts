// @failure Cross-pane mouse drags select the whole screen because the QUEUE / DETAIL / STATUS / STATS surfaces declare no selection scope, so a drag resolves to their common screen root.
// @level l2
// @consumer @yrd/cli watch

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import type { AgNode } from "@silvery/ag/types"
import { findContainBoundary, resolveUserSelect } from "@silvery/ag-term/mouse-events"
import { describe, expect, it } from "vitest"
import {
  fixtureJob,
  fixturePr,
  fixtureResult,
  fixtureRun,
  fixtureSnapshot,
  fixtureStep,
} from "../dev/queue-timeline-fixtures.ts"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

// Item 4a — per-pane selection scopes. Silvery selection is document-aware: on a
// drag it resolves the anchor and focus to their nearest common selectable
// ancestor, and a `userSelect="contain"` node is a hard boundary the range
// cannot escape (docs/guide/text-selection.md; findContainBoundary in
// ag-term/mouse-events is the exact runtime resolver). Without per-surface
// scopes, a drag spanning two panes resolves to the whole screen. This test
// drives that real resolver against the live render: it proves each surface is
// its own contain scope, that an in-pane drag resolves to ONE shared scope
// (so it selects), and that a cross-pane drag cannot escape its anchor pane.

type Boundary = Readonly<{ top: number; bottom: number; left: number; right: number }>

/** The screen point (1 cell inside the glyph) of the first `needle` whose
 *  column falls within `[minX, maxX]` — used to target the left (QUEUE) or
 *  right (DETAIL) pane by column band. */
function pointOf(text: string, needle: string, minX = 0, maxX = Number.MAX_SAFE_INTEGER): readonly [number, number] {
  const rows = text.split("\n")
  for (let y = 0; y < rows.length; y += 1) {
    const x = rows[y]?.indexOf(needle) ?? -1
    if (x >= 0 && x >= minX && x <= maxX) return [x + 1, y]
  }
  throw new Error(`no on-screen '${needle}' within columns ${minX}..${maxX}`)
}

function nodeAt(app: { nodeAt(x: number, y: number): AgNode | null }, point: readonly [number, number]): AgNode {
  const node = app.nodeAt(point[0], point[1])
  if (node === null) throw new Error(`no node at ${point[0]},${point[1]}`)
  return node
}

/** The nearest `contain` boundary the runtime would bound a drag anchored here
 *  to — the exact function ag-term's selection feature calls per drag. */
function scopeAt(app: { nodeAt(x: number, y: number): AgNode | null }, point: readonly [number, number]): Boundary {
  const boundary = findContainBoundary(nodeAt(app, point))
  if (boundary === null) throw new Error(`no contain scope at ${point[0]},${point[1]}`)
  return boundary
}

function sameScope(a: Boundary, b: Boundary): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right
}

/** `a` sits strictly inside `b` and is not the same box (a nested scope). */
function nestedWithin(a: Boundary, b: Boundary): boolean {
  return !sameScope(a, b) && a.top >= b.top && a.bottom <= b.bottom && a.left >= b.left && a.right <= b.right
}

function twoPaneSnapshot() {
  const prs = [
    fixturePr("PRA", "submitted", "2026-07-13T11:10:00.000Z", "Alpha"),
    fixturePr("PRB", "submitted", "2026-07-13T11:12:00.000Z", "Beta"),
    fixturePr("PRC", "submitted", "2026-07-13T11:14:00.000Z", "Gamma"),
  ]
  const runningPr = fixturePr("PRR", "submitted", "2026-07-13T11:25:00.000Z", "Running")
  const runningRun = fixtureRun("RR", [runningPr], "running", "2026-07-13T11:40:00.000Z", {
    steps: [fixtureStep("check", fixtureJob("JRR-check", "running"))],
  })
  return fixtureSnapshot(
    fixtureResult([...prs, runningPr], [runningRun], {
      base: "main",
      reason: "operator freeze",
      allowedPRs: [],
      pausedAt: "2026-07-13T11:45:00.000Z",
    }),
    { rowLimit: 20 },
  )
}

describe("queue watch per-pane selection scopes (item 4a)", () => {
  it("gives QUEUE, DETAIL, exceptional STATUS, and STATS each their own contain scope", async () => {
    const render = createRenderer({ cols: 200, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot: twoPaneSnapshot() }))
    try {
      await app.waitForLayoutStable()
      const text = app.text
      // Columns 0..103 are the QUEUE pane, 104+ the DETAIL pane (0.52 split of 200).
      const LEFT_MAX = 103
      const RIGHT_MIN = 104

      // Three consecutive rows in the QUEUE list — all selectable, all resolving
      // to ONE shared scope: an in-pane drag between them selects and stays put.
      const rowA = pointOf(text, "PRA.1", 0, LEFT_MAX)
      const rowB = pointOf(text, "PRB.1", 0, LEFT_MAX)
      const rowC = pointOf(text, "PRC.1", 0, LEFT_MAX)
      for (const point of [rowA, rowB, rowC]) {
        expect(resolveUserSelect(nodeAt(app, point)), "queue row stays selectable").not.toBe("none")
      }
      const queueScope = scopeAt(app, rowA)
      expect(sameScope(scopeAt(app, rowB), queueScope), "in-pane rows share one scope").toBe(true)
      expect(sameScope(scopeAt(app, rowC), queueScope), "in-pane rows share one scope").toBe(true)

      // A DETAIL-pane node resolves to a DISJOINT scope: a drag anchored in the
      // QUEUE pane cannot reach it (its contain boundary ends before DETAIL begins).
      // The detail rework (W3) prints the run status/outcome inline rather than an
      // "OUTCOME" label, so anchor on the RUN LOGS accordion — a detail-body node.
      const detailPoint = pointOf(text, "RUN LOGS", RIGHT_MIN)
      expect(resolveUserSelect(nodeAt(app, detailPoint)), "detail stays selectable").not.toBe("none")
      const detailScope = scopeAt(app, detailPoint)
      expect(sameScope(detailScope, queueScope), "QUEUE and DETAIL are different scopes").toBe(false)
      expect(queueScope.right, "QUEUE scope ends before DETAIL scope begins").toBeLessThan(detailScope.left)

      // The reported regression starts in EMPTY space under RUN LOGS, not on
      // a glyph. The DETAIL surface must therefore fill the pane all the way
      // down: hit-testing a blank cell near its bottom still resolves to the
      // same contain boundary as its visible body. If the detail only hugs its
      // content, this point falls through to the screen root and a drag can
      // incorrectly range over QUEUE rows.
      const blankDetailPoint = [RIGHT_MIN + 24, 48] as const
      const blankDetailScope = scopeAt(app, blankDetailPoint)
      expect(
        sameScope(blankDetailScope, detailScope),
        "blank detail body stays inside the full-height DETAIL scope",
      ).toBe(true)

      // The exceptional STATUS box and STATS box are each their own scope, nested inside the
      // QUEUE pane — a drag inside one never grows into the list or its sibling.
      const statusScope = scopeAt(app, pointOf(text, "HOLD THE LINE", 0, LEFT_MAX))
      const statsScope = scopeAt(app, pointOf(text, "STATS", 0, LEFT_MAX))
      expect(nestedWithin(statusScope, queueScope), "STATUS is its own scope inside QUEUE").toBe(true)
      expect(nestedWithin(statsScope, queueScope), "STATS is its own scope inside QUEUE").toBe(true)
      expect(sameScope(statusScope, statsScope), "STATUS and STATS are different scopes").toBe(false)
    } finally {
      app.unmount()
    }
  })
})
