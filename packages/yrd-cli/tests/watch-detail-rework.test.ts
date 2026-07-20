/**
 * 21106 W3 — DETAIL pane rework (user screenshot review, 2026-07-16).
 *
 * Pins the reshaped detail surface: the run-scoped identity title with
 * right-aligned colorized STATUS/OUTCOME; the linked ISSUE primitive; the
 * natural clock sentence plus COMMIT; separate JOB/RUNNER facts; and the
 * failure-only NEXT cue.
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
import { QueueWatchFrame } from "../src/watch-pane.tsx"

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

describe("detail title row — run identity emphasis + right-aligned outcome", () => {
  it("emphasizes the identity, right-aligns STATUS/OUTCOME, and omits corner time", () => {
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
      // Revision A makes the title run-scoped; PR and branch move into member
      // blocks while the deduped run outcome stays on this line.
      expect(app.text).toContain("RUN main#42")
      expect(app.text).not.toContain("PR42.1")
      expect(app.text).not.toContain("topic/pr42")
      expect(app.text).toContain(`${data.glyph} completed, integrated`)

      const titleRow = app.text.split("\n").findIndex((text) => text.includes("main#42"))
      expect(titleRow).toBeGreaterThanOrEqual(0)

      // Identity is emphasized like the QUEUE tab: warning-colored + bold.
      const identityColumn = app.text.split("\n")[titleRow]?.indexOf("RUN main#42") ?? -1
      const identityCell = app.cell(identityColumn, titleRow)
      expect(identityCell.bold).toBe(true)
      expect(identityCell.fg).not.toBeNull()

      expect(glyphColumn(app, titleRow), "branch marker belongs in the member block, not the run title").toBe(-1)

      // STATUS/OUTCOME is colorized, distinct from the identity emphasis.
      const outcomeColumn = app.text.split("\n")[titleRow]?.indexOf("integrated") ?? -1
      const outcomeCell = app.cell(outcomeColumn, titleRow)
      expect(outcomeCell.fg).not.toBeNull()
      expect(outcomeCell.fg).not.toEqual(identityCell.fg)

      expect(app.text).not.toContain("15m00s")
    } finally {
      app.unmount()
    }
  })

  it("does not put live elapsed time in the title corner", () => {
    const pr = fixturePr("PR43", "submitted", "2026-07-13T11:30:00.000Z", "Still running")
    const run = fixtureRun("R43", [pr], "running", "2026-07-13T11:40:00.000Z", {
      steps: [fixtureStep("check", fixtureJob("J43-check", "running"))],
    })
    const snapshot = fixtureSnapshot(fixtureResult([pr], [run]))
    const row = snapshot.projection.rows.find((candidate) => candidate.run === "R43")
    const data = snapshot.projection.details.find((candidate) => candidate.run === "R43")
    if (row === undefined || data === undefined) throw new Error("fixture is missing the live R43 projection")
    expect(data.totalDuration).toBe("-")
    expect(row.totalMs).toBe(20 * 60_000)

    const app = createRenderer({ cols: 120, rows: 4 })(
      createElement(Box, { width: 120 }, createElement(QueueDetailTitle, { row, data })),
    )
    try {
      expect(app.text).not.toContain("20m00s")
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

describe("detail run facts — natural timing sentence + landing, no RUN/BASE duplication", () => {
  it("drops the RUN header and BASE rows when the title renders them above", () => {
    const app = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: integratedRun(), compact: true, section: "run", titleAbove: true }),
    )
    try {
      expect(app.text).not.toContain("RUN R42")
      expect(app.text).not.toContain("OUTCOME")
      expect(app.text).not.toContain("BASE ")
      expect(app.text).not.toContain("TITLE ")
      // Direct QueueShowView retains its member fact; the watch passes
      // showMembers=false because run member blocks own it there.
      expect(app.text).toContain("PRs      pr#42.1")
      expect(app.text).toContain("Started 03:40:00, ended 03:55:00 (total 15:00, wait 0)")
      expect(app.text).not.toContain("TIMELINE")
      expect(app.text).toContain(`Committed as ${"b".repeat(40)} on main`)
      expect(app.text).not.toContain("LANDING")

      expect(app.text.split("\n").findIndex((row) => row.startsWith("Started "))).toBeLessThan(
        app.text.split("\n").findIndex((row) => row.startsWith("Committed as ")),
      )
    } finally {
      app.unmount()
    }
  })

  it("collapses START/END + TOTAL/ACTIVE/WAIT into one sentence while keeping the landing separate", () => {
    const app = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: integratedRun(), compact: true, section: "run", titleAbove: true }),
    )
    try {
      // One natural sentence carries clocks/duration; the landing sentence owns the proof SHA.
      expect(app.text).toContain("Started 03:40:00, ended 03:55:00 (total 15:00, wait 0)")
      const timingRow = app.text.split("\n").find((row) => row.includes("Started ")) ?? ""
      expect(timingRow).not.toContain("bbbbbbbbbbbb")
      expect(app.text).toContain(`Committed as ${"b".repeat(40)} on main`)
      // The retired label rows are gone.
      expect(app.text).not.toContain("TIMELINE")
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
      expect(app.text).toContain("(total 15:00, wait 5:00)")
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

describe("detail step facts — final JOB yrd# grammar without duplication", () => {
  it("uses the durable command evidence and hides the shell transport wrapper", () => {
    const pr = fixturePr("PR10", "integrated", "2026-07-13T10:30:00.000Z", "Command evidence")
    const run = fixtureRun("R10", [pr], "passed", "2026-07-13T10:40:00.000Z", {
      finishedAt: "2026-07-13T10:42:00.000Z",
      steps: [
        fixtureStep(
          "check",
          fixtureJob("J10-check", "passed", {
            output: { command: ["sh", "-c", "bun check"] },
          }),
        ),
      ],
    })
    expect(queueShowData(run).steps[0]?.command).toBe("bun check")
  })

  it("renders one JOB yrd# row and omits runner/revision from the default body", () => {
    const app = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: integratedRun(), compact: true, section: "steps" }),
    )
    try {
      expect(app.text).toContain("JOB yrd#J42-check")
      expect(app.text).not.toContain("runner-herdr-03")
      expect(app.text).not.toContain("DETAILS")
      expect(app.text).not.toContain("REV")
      expect(app.text.match(/J42-check/gu)).toHaveLength(1)
    } finally {
      app.unmount()
    }
  })

  it("labels subprocess detail as MESSAGE so it cannot collide with DETAILS", async () => {
    const pr = fixturePr("PR11", "submitted", "2026-07-13T10:30:00.000Z", "Explain a long failure")
    const run = fixtureRun("R11", [pr], "failed", "2026-07-13T10:40:00.000Z", {
      finishedAt: "2026-07-13T10:42:00.000Z",
      steps: [
        fixtureStep(
          "check",
          fixtureJob("J11-check", "failed", {
            detail: `The subprocess explained this failure ${"without clipping a word ".repeat(8)}`,
          }),
        ),
      ],
    })
    const app = createRenderer({ cols: 70, rows: 60 })(
      createElement(QueueWatchFrame, { snapshot: fixtureSnapshot(fixtureResult([pr], [run])) }),
    )
    try {
      await app.waitForLayoutStable()
      await app.press("Enter")
      await app.press("l")
      await app.waitForLayoutStable()
      expect(app.text).toContain("MESSAGE")
      expect(app.text).not.toMatch(/^DETAIL\s/mu)
      expect(app.text).not.toContain("DETAILS")
      const messageLine = app.text.split("\n").find((line) => line.includes("MESSAGE"))
      expect(messageLine, "the MESSAGE row is visible at the narrow full-detail tier").toBeDefined()
      expect(messageLine?.trimEnd(), "MESSAGE ends with an ellipsis instead of clipping mid-word").toMatch(/…$/u)
    } finally {
      app.unmount()
    }
  })
})

describe("detail single-PR header — unlabelled bold title + linked ISSUE", () => {
  it("surrounds the bare bold title with whitespace and renders ISSUE as a hyperlink", () => {
    const pr = {
      ...fixturePr("PR5", "submitted", "2026-07-13T10:30:00.000Z", "PR5", {
        issue: "@yrd/core/21106-queue-timeline",
      }),
      title: "Wire the detail surface",
    }
    const app = createRenderer({ cols: 120, rows: 6 })(createElement(QueueDetailSinglePrHeader, { pr }))
    try {
      expect(app.text).toContain("Wire the detail surface")
      expect(app.text).not.toContain("TITLE ")
      expect(app.text).toContain("ISSUE    @yrd/core/21106-queue-timeline")

      const rows = app.text.split("\n")
      const titleRow = rows.findIndex((row) => row.includes("Wire the detail surface"))
      const issueRow = rows.findIndex((row) => row.includes("ISSUE    @yrd/core/21106-queue-timeline"))
      expect(titleRow).toBeGreaterThan(0)
      expect(rows[titleRow - 1]?.trim()).toBe("")
      expect(rows[titleRow + 1]?.trim()).toBe("")
      expect(issueRow).toBe(titleRow + 2)

      const titleColumn = rows[titleRow]?.indexOf("Wire") ?? -1
      expect(app.cell(titleColumn, titleRow).bold).toBe(true)
      const issueColumn = rows[issueRow]?.indexOf("@yrd") ?? -1
      expect(app.cell(issueColumn, issueRow).hyperlink).toBeDefined()
    } finally {
      app.unmount()
    }
  })

  it("renders nothing when the PR carries neither subject nor issue", () => {
    const pr = fixturePr("PR6", "submitted", "2026-07-13T10:30:00.000Z", "Fixture PR6")
    const bare = { ...pr, name: "", title: undefined, issue: undefined }
    const app = createRenderer({ cols: 80, rows: 4 })(createElement(QueueDetailSinglePrHeader, { pr: bare }))
    try {
      expect(app.text.trim()).toBe("")
    } finally {
      app.unmount()
    }
  })
})
