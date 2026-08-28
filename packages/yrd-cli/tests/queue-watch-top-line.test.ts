/**
 * @failure The watch frame has no identifying top line, the queue pills lose
 *          the repository ⎇ branch identity pair, or the deleted QUEUE/ROOT
 *          header row comes back.
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * Operator rulings 2026-08-18, items 30/32/32b/32d/33/36: the top of the
 * watch is ONLY the top line — `YRD QUEUES` plus the queue pills, each pill
 * `digit [label] path ⎇ branch`. The old `QUEUE main` / `ROOT /hh` header
 * row and the `for /hh` right aside are gone: the pills carry the identity.
 */
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import type { BaysState } from "@yrd/bay"
import { fixturePr, fixtureResult, fixtureRun, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { QueueTopLine } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

function snapshot() {
  const pr = fixturePr("PR1", "submitted", "2026-07-13T11:10:00.000Z", "Prepare release notes")
  const run = fixtureRun("R1", [pr], "passed", "2026-07-13T11:20:00.000Z", { finishedAt: "2026-07-13T11:25:00.000Z" })
  return fixtureSnapshot(fixtureResult([pr], [run]))
}

describe("watch pane top line (@yrd/cli/queue-watch-top-line)", () => {
  it("renders YRD QUEUES left and the queue pill carrying the path ⎇ branch identity", async () => {
    const app = createRenderer({ cols: 140, rows: 40 })(
      createElement(QueueWatchFrame, { snapshot: { ...snapshot(), repositoryRoot: "/hh" } }),
    )
    try {
      await app.waitForLayoutStable()
      const topRow = app.text.split("\n")[0] ?? ""
      expect(topRow).toContain("YRD QUEUES")
      expect(topRow.indexOf("YRD QUEUES")).toBe(topRow.indexOf("YRD"))
      // The pill is `1 /hh ⎇ main` — digit accelerator, friendly path, branch
      // glyph. Identity lives ON the pill; no `for /hh` aside repeats it.
      expect(topRow).toContain("1 /hh ⎇ main")
      expect(topRow).not.toContain("for /hh")
      expect(topRow).not.toContain("YRD MERGE QUEUE")
      // Item 30: the old per-queue header row is deleted everywhere below.
      expect(app.text).not.toContain("QUEUE main")
      expect(app.text).not.toContain("ROOT /hh")
    } finally {
      app.unmount()
    }
  })

  it("renders a pathless snapshot's pill without inventing a path", async () => {
    const app = createRenderer({ cols: 140, rows: 40 })(createElement(QueueWatchFrame, { snapshot: snapshot() }))
    try {
      await app.waitForLayoutStable()
      const topRow = app.text.split("\n")[0] ?? ""
      expect(topRow).toContain("YRD QUEUES")
      expect(topRow, "the identity pair degrades to the branch half").toContain("1 ⎇ main")
      expect(topRow).not.toContain("undefined")
    } finally {
      app.unmount()
    }
  })

  it("spells the three-tier pill — digit, config handle, pretty name (item 36)", async () => {
    // `1 code /hh ⎇ main` — the digit accelerator, the config-handle label
    // when one is declared, and the pretty rendering of the FQN identity
    // pair with the shortest unique friendly path (/hh/pm shortens to pm).
    const app = createRenderer({ cols: 140, rows: 6 })(
      createElement(QueueTopLine, {
        queues: [
          { label: 1, base: "main", name: "code", path: "/hh", address: "/hh@main" },
          { label: 2, base: "main", name: "pm", path: "/hh/pm", address: "/hh/pm@main" },
        ],
      }),
    )
    try {
      await app.waitForLayoutStable()
      const topRow = app.text.split("\n")[0] ?? ""
      expect(topRow).toContain("1 code /hh ⎇ main")
      expect(topRow).toContain("2 pm pm ⎇ main")
      expect(topRow, "digits are filter accelerators, never name prefixes").not.toContain("1:code")
    } finally {
      app.unmount()
    }
  })

  it("stays present, title-only, before a projection has loaded", async () => {
    // The `snapshot.projection === undefined` render path is a separate
    // early return in QueueWatchFrame — the top line must not depend on it.
    const app = createRenderer({ cols: 140, rows: 40 })(
      createElement(QueueWatchFrame, {
        snapshot: {
          results: [],
          // A pre-load frame: nothing read yet, so the record lane is empty
          // and so is the derived one. The state is stated, never omitted.
          state: { byId: {}, prs: {}, receipts: {}, submits: {} } satisfies BaysState,
          now: Date.parse("2026-07-13T11:10:00.000Z"),
          repositoryRoot: "/hh",
        },
      }),
    )
    try {
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      expect(rows[0]).toContain("YRD QUEUES")
    } finally {
      app.unmount()
    }
  })
})
