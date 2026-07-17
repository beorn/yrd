/**
 * 21106 W3 — DETAIL pane rework (user screenshot review, 2026-07-16).
 *
 * Pins the reshaped detail surface: the emphasized identity title row with a
 * dimmed branch glyph and right-aligned colorized STATUS/OUTCOME (a/i); the
 * single-PR TITLE + ISSUE surfaced inline (b); the one compact timing row that
 * replaces the START/END + TOTAL/ACTIVE/WAIT rows (c); the dropped duplicate
 * STEP header row (d); the `> DETAILS` disclosure over JOB/RUNNER/REV and the
 * RETRY-only-when-greater-than-one rule (f); and the failure-only NEXT cue (g).
 */

import { createElement } from "react"
import { Box } from "silvery"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import {
  fixtureJob,
  fixturePr,
  fixtureResult,
  fixtureRun,
  fixtureSnapshot,
  fixtureStep,
} from "../dev/queue-timeline-fixtures.ts"
import {
  QueueDetailSinglePrHeader,
  QueueDetailTitle,
  QueueShowView,
  queueShowData,
  type QueueShowData,
} from "../src/queue-status-view.tsx"

const BRANCH_GLYPH = ""

function integratedRun(): QueueShowData {
  const pr = fixturePr("PR42", "integrated", "2026-07-13T10:30:00.000Z", "Land the durable patch")
  const run = fixtureRun("R42", [pr], "passed", "2026-07-13T10:40:00.000Z", {
    finishedAt: "2026-07-13T10:55:00.000Z",
    steps: [
      fixtureStep(
        "check",
        fixtureJob("J42-check", "passed", {
          requestedAt: "2026-07-13T10:39:00.000Z",
          startedAt: "2026-07-13T10:40:00.000Z",
          finishedAt: "2026-07-13T10:55:00.000Z",
        }),
      ),
    ],
  })
  return queueShowData(run, [run])
}

function failedRun(): QueueShowData {
  const pr = fixturePr("PR9", "rejected", "2026-07-13T10:30:00.000Z", "Repair the check")
  const run = fixtureRun("R9", [pr], "failed", "2026-07-13T10:40:00.000Z", {
    finishedAt: "2026-07-13T10:42:00.000Z",
    error: { code: "check-failed", message: "check command exited 1" },
    steps: [
      fixtureStep(
        "check",
        fixtureJob("J9-check", "failed", {
          requestedAt: "2026-07-13T10:39:00.000Z",
          startedAt: "2026-07-13T10:40:00.000Z",
          finishedAt: "2026-07-13T10:42:00.000Z",
          error: { code: "check-failed", message: "check command exited 1" },
        }),
      ),
    ],
  })
  return queueShowData(run, [run])
}

function glyphColumn(app: ReturnType<ReturnType<typeof createRenderer>>, row: number): number {
  for (let column = 0; column < app.width; column += 1) {
    if (app.cell(column, row).char === BRANCH_GLYPH) return column
  }
  return -1
}

describe("detail title row — identity emphasis + right-aligned outcome + dim glyph (items a/i)", () => {
  it("emphasizes the identity like the QUEUE tab, dims the branch glyph, and colorizes STATUS/OUTCOME", () => {
    const pr = fixturePr("PR42", "submitted", "2026-07-13T10:30:00.000Z", "Land it")
    const run = fixtureRun("R42", [pr], "passed", "2026-07-13T10:40:00.000Z", {
      finishedAt: "2026-07-13T10:55:00.000Z",
    })
    const snapshot = fixtureSnapshot(fixtureResult([pr], [run]))
    const row = snapshot.projection.rows.find((candidate) => candidate.run === "R42")
    const data = snapshot.projection.details.find((candidate) => candidate.run === "R42")
    if (row === undefined || data === undefined) throw new Error("fixture is missing the R42 projection")

    const app = createRenderer({ cols: 120, rows: 6 })(
      createElement(Box, { width: 120 }, createElement(QueueDetailTitle, { row, data })),
    )
    try {
      // Identity reads like the row, not the word DETAIL, and carries the run's
      // outcome on the same row (deduped `passed, integrated`).
      expect(app.text).toContain("main#42 PR42.1")
      expect(app.text).toContain("topic/pr42")
      expect(app.text).toContain("passed, integrated")

      const titleRow = app.text.split("\n").findIndex((text) => text.includes("main#42"))
      expect(titleRow).toBeGreaterThanOrEqual(0)

      // Identity is emphasized like the QUEUE tab: warning-colored + bold.
      const identityColumn = app.text.split("\n")[titleRow]?.indexOf("PR42.1") ?? -1
      const identityCell = app.cell(identityColumn, titleRow)
      expect(identityCell.bold).toBe(true)
      expect(identityCell.fg).not.toBeNull()

      // The branch glyph is dimmed apart from the identity (item i).
      const glyph = glyphColumn(app, titleRow)
      expect(glyph).toBeGreaterThan(0)
      expect(app.cell(glyph, titleRow).fg).not.toEqual(identityCell.fg)

      // STATUS/OUTCOME is colorized, distinct from the identity emphasis.
      const outcomeColumn = app.text.split("\n")[titleRow]?.indexOf("integrated") ?? -1
      const outcomeCell = app.cell(outcomeColumn, titleRow)
      expect(outcomeCell.fg).not.toBeNull()
      expect(outcomeCell.fg).not.toEqual(identityCell.fg)
    } finally {
      app.unmount()
    }
  })

  it("renders the no-selection placeholder when no row is selected", () => {
    const app = createRenderer({ cols: 60, rows: 4 })(createElement(QueueDetailTitle, {}))
    try {
      expect(app.text).toContain("No queue row selected.")
    } finally {
      app.unmount()
    }
  })
})

describe("detail run facts — RUN/BASE rows removed, one timing row (items a/c)", () => {
  it("drops the RUN header and BASE rows when the title renders them above", () => {
    const app = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: integratedRun(), compact: true, section: "run", titleAbove: true }),
    )
    try {
      expect(app.text).not.toContain("RUN R42")
      expect(app.text).not.toContain("OUTCOME")
      expect(app.text).not.toContain("BASE ")
      // The batched-members row survives (BASE prefix dropped).
      expect(app.text).toContain("PRs PR42@r1")
    } finally {
      app.unmount()
    }
  })

  it("collapses START/END + TOTAL/ACTIVE/WAIT into one timing row with a landed sha", () => {
    const app = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: integratedRun(), compact: true, section: "run", titleAbove: true }),
    )
    try {
      // One row: `<start> → <end> · <total> · landed <sha>`. Clocks are
      // date-qualified when the run pre-dates today, so pin the arrow + total.
      expect(app.text).toContain(" → ")
      expect(app.text).toMatch(/\d{2}:\d{2}:\d{2} → /u)
      expect(app.text).toContain("· 15m00s")
      expect(app.text).toContain("landed bbbbbbbbbbbb")
      // The whole run ran active, so the wait segment is omitted (rule: >0 only).
      expect(app.text).not.toContain("(wait")
      // The retired label rows are gone.
      expect(app.text).not.toContain("START ")
      expect(app.text).not.toContain("TOTAL ")
      expect(app.text).not.toContain("ACTIVE ")
    } finally {
      app.unmount()
    }
  })

  it("shows the wait segment only when the queue wait was non-zero", () => {
    const pr = fixturePr("PR8", "integrated", "2026-07-13T10:30:00.000Z", "Waited before running")
    const run = fixtureRun("R8", [pr], "passed", "2026-07-13T10:40:00.000Z", {
      finishedAt: "2026-07-13T10:55:00.000Z",
      steps: [
        fixtureStep(
          "check",
          fixtureJob("J8-check", "passed", {
            requestedAt: "2026-07-13T10:39:00.000Z",
            startedAt: "2026-07-13T10:40:00.000Z",
            finishedAt: "2026-07-13T10:50:00.000Z",
          }),
        ),
      ],
    })
    const app = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, {
        data: queueShowData(run, [run]),
        compact: true,
        section: "run",
        titleAbove: true,
      }),
    )
    try {
      expect(app.text).toContain("(wait 5m00s)")
    } finally {
      app.unmount()
    }
  })
})

describe("detail run facts — RETRY only above one, NEXT only on failure (items f/g)", () => {
  it("hides RETRY at one attempt and shows it above one", () => {
    const base = integratedRun()
    const once = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: { ...base, retries: 1 }, compact: true, section: "run", titleAbove: true }),
    )
    try {
      expect(once.text).not.toContain("RETRY")
    } finally {
      once.unmount()
    }
    const retried = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: { ...base, retries: 3 }, compact: true, section: "run", titleAbove: true }),
    )
    try {
      expect(retried.text).toContain("RETRY 3")
    } finally {
      retried.unmount()
    }
  })

  it("suppresses NEXT for a healthy run and shows it on failure", () => {
    const clean = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: integratedRun(), compact: true, section: "run", titleAbove: true }),
    )
    try {
      expect(clean.text).not.toContain("NEXT")
    } finally {
      clean.unmount()
    }
    const failed = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: failedRun(), compact: true, section: "run", titleAbove: true }),
    )
    try {
      expect(failed.text).toContain("NEXT")
    } finally {
      failed.unmount()
    }
  })
})

describe("detail step facts — DETAILS disclosure demotes the internals (item f)", () => {
  it("hides JOB/RUNNER/REV behind a collapsed `> DETAILS` disclosure", () => {
    const app = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: integratedRun(), compact: true, section: "steps" }),
    )
    try {
      expect(app.text).toContain("DETAILS")
      // Collapsed: the uuid is not on screen until the disclosure expands.
      expect(app.text).not.toContain("J42-check")
    } finally {
      app.unmount()
    }
  })
})

describe("detail single-PR header — TITLE + ISSUE inline (item b)", () => {
  it("renders TITLE and the ISSUE hyperlink for a single-PR run", () => {
    const pr = {
      ...fixturePr("PR5", "submitted", "2026-07-13T10:30:00.000Z", "PR5", {
        issue: "@yrd/core/21106-queue-timeline",
      }),
      title: "Wire the detail surface",
    }
    const app = createRenderer({ cols: 120, rows: 6 })(createElement(QueueDetailSinglePrHeader, { pr }))
    try {
      expect(app.text).toContain("TITLE Wire the detail surface")
      expect(app.text).toContain("ISSUE @yrd/core/21106-queue-timeline")
    } finally {
      app.unmount()
    }
  })

  it("renders nothing when the PR carries neither title nor issue", () => {
    const pr = fixturePr("PR6", "submitted", "2026-07-13T10:30:00.000Z", "Fixture PR6")
    const bare = { ...pr, title: undefined, issue: undefined }
    const app = createRenderer({ cols: 80, rows: 4 })(createElement(QueueDetailSinglePrHeader, { pr: bare }))
    try {
      expect(app.text.trim()).toBe("")
    } finally {
      app.unmount()
    }
  })
})
