/**
 * 21106 W3 — DETAIL pane rework (user screenshot review, 2026-07-16).
 *
 * Pins the reshaped detail surface: the PR-scoped identity title
 * (`pr#<id>.<rev>`), the linked ISSUE primitive, one composite run header,
 * one truthful status notice, and separate JOB/RUNNER facts.
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

function deltaRun(): QueueShowData {
  const baseSha = "a".repeat(40)
  const candidateSha = "b".repeat(40)
  const pr = fixturePr("PR71", "submitted", "2026-07-13T10:30:00.000Z", "Carry inherited red")
  const run = fixtureRun("R71", [pr], "passed", "2026-07-13T10:40:00.000Z", {
    finishedAt: "2026-07-13T10:42:00.000Z",
    steps: [
      fixtureStep(
        "check",
        fixtureJob("J71-check", "passed", {
          output: {
            certificate: {
              version: 1,
              mode: "delta",
              baseSha,
              candidateSha,
              reports: [
                {
                  version: 1,
                  comparator: { id: "affected-tests", version: 1 },
                  residual: { count: 3, hash: "c".repeat(64) },
                },
              ],
            },
          },
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

describe("detail title row — PR identity only", () => {
  it("emphasizes the identity and leaves status to the notice below", () => {
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
      // The title is PR-scoped. Run identity, timing, and status belong to the
      // composite header + notice below it.
      expect(app.text).toContain("pr#42.1")
      expect(app.text).not.toContain("RUN main#42")
      expect(app.text).not.toContain("topic/pr42")
      expect(app.text).not.toContain("passed")
      expect(app.text).not.toContain("integrated")

      const titleRow = app.text.split("\n").findIndex((text) => text.includes("pr#42.1"))
      expect(titleRow).toBeGreaterThanOrEqual(0)

      // Identity is emphasized like the QUEUE tab: warning-colored.
      const identityColumn = app.text.split("\n")[titleRow]?.indexOf("pr#42.1") ?? -1
      const identityCell = app.cell(identityColumn, titleRow)
      expect(identityCell.fg).not.toBeNull()

      expect(glyphColumn(app, titleRow), "branch marker belongs in the member block, not the title").toBe(-1)

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

describe("delta admission visibility", () => {
  it("surfaces the carried-red count in the run proof line", () => {
    const data = deltaRun()
    expect(data.steps[0]?.gate).toEqual({ mode: "delta", residualCount: 3 })
    expect(data.steps[0]?.evidence).toMatchObject({ gate: "delta residual:3" })

    const app = createRenderer({ cols: 120, rows: 12 })(
      createElement(Box, { width: 120 }, createElement(QueueShowView, { data, compact: true })),
    )
    try {
      expect(app.text).toContain("delta residual:3")
    } finally {
      app.unmount()
    }
  })
})

describe("watch detail composite header + status notice", () => {
  it("puts run identity/timing above tabs and replaces flat failure chrome with one outlined notice", async () => {
    const headSha = "9".repeat(40)
    const pr = {
      ...fixturePr("PR9", "rejected", "2026-07-13T10:30:00.000Z", "Repair the check", {
        actor: "@agent/8",
        headSha,
        issue: "@yrd/core/21096-cli-ux/21751-watch-detail-status-dry",
        revisions: [
          {
            revision: 1,
            headSha,
            base: "main",
            baseSha: "a".repeat(40),
            pushedAt: "2026-07-13T10:30:00.000Z",
            submittedAt: "2026-07-13T10:30:00.000Z",
            actor: "@agent/8",
            terminal: {
              status: "rejected",
              at: "2026-07-13T10:42:00.000Z",
              run: "R9",
            },
          },
        ],
        terminalRun: "R9",
        rejectedAt: "2026-07-13T10:42:00.000Z",
      }),
      description:
        "A concise explanation of the change.\n\nIssue: @yrd/core/21096-cli-ux/21751-watch-detail-status-dry",
    }
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
    const app = createRenderer({ cols: 180, rows: 50 })(
      createElement(QueueWatchFrame, { snapshot: fixtureSnapshot(fixtureResult([pr], [run])) }),
    )
    try {
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      const runY = rows.findIndex((line) => line.includes("RUN main#9"))
      const timingY = rows.findIndex(
        (line) => line.includes("Admitted ") && line.includes("started ") && line.includes("completed "),
      )
      const metricsY = rows.findIndex(
        (line) => line.includes("Age ") && line.includes("runtime ") && line.includes("wait "),
      )
      const tabsY = rows.findIndex((line) => line.includes("1: check"))
      expect(runY, "run identity leads the composite header").toBeGreaterThanOrEqual(0)
      expect(timingY, "run timing is inside the composite header").toBeGreaterThan(runY)
      expect(metricsY, "run age/runtime/wait metrics are inside the composite header").toBeGreaterThan(timingY)
      expect(tabsY, "step tabs follow the composite header").toBeGreaterThan(metricsY)

      const noticeY = rows.findIndex((line) => line.includes("failed, rejected"))
      expect(noticeY, "the status notice headline is present").toBeGreaterThanOrEqual(0)
      expect(rows[noticeY]).toContain("×")
      expect(app.cell(rows[noticeY]?.indexOf("failed") ?? -1, noticeY).bold).toBe(true)
      const topBorderY = rows.findLastIndex((line, index) => index < noticeY && line.includes("╭"))
      const borderX = rows[topBorderY]?.indexOf("╭") ?? -1
      expect(topBorderY, "notice has an outline").toBeGreaterThanOrEqual(0)
      expect(app.cell(borderX, topBorderY).fg, "border and headline use the same status tone").toEqual(
        app.cell(rows[noticeY]?.indexOf("failed") ?? -1, noticeY).fg,
      )
      expect(app.text).toContain("err=check-failed")
      expect(app.text).toContain("not retried")
      expect(app.text).toContain("automatically")
      expect(app.text).toContain("author must fix")
      expect(app.text).toContain("branch and resubmit")
      expect(app.text).not.toMatch(/^(?:ERROR|CAUSE|RESOLVE|LOST|NEXT)\b/mu)
      const titleY = rows.findIndex((line) => line.includes("pr#9.1"))
      const detailX = rows[titleY]?.indexOf("pr#9.1") ?? -1
      const detailText = rows.map((line) => line.slice(detailX)).join("\n")
      expect(detailText.match(/@yrd\/core\/21096-cli-ux\/21751-watch-detail-status-dry/gu)).toHaveLength(1)
    } finally {
      app.unmount()
    }
  })

  it("states the live step's elapsed time and historical p50 without inventing a current-run duration", async () => {
    const terminalPr = (id: string, run: string, submittedAt: string, finishedAt: string) => {
      const headSha = id.at(-1)?.repeat(40) ?? "1".repeat(40)
      return fixturePr(id, "integrated", submittedAt, `Historical ${id}`, {
        headSha,
        terminalRun: run,
        integratedAt: finishedAt,
        integration: { commit: "b".repeat(40), baseSha: "a".repeat(40) },
        revisions: [
          {
            revision: 1,
            headSha,
            base: "main",
            baseSha: "a".repeat(40),
            pushedAt: submittedAt,
            submittedAt,
            terminal: { status: "integrated", at: finishedAt, run },
          },
        ],
      })
    }
    const twoMinutePr = terminalPr("PR1", "R1", "2026-07-13T10:59:00.000Z", "2026-07-13T11:02:00.000Z")
    const fourMinutePr = terminalPr("PR2", "R2", "2026-07-13T11:09:00.000Z", "2026-07-13T11:14:00.000Z")
    const livePr = fixturePr("PR3", "submitted", "2026-07-13T11:39:00.000Z", "Live check")
    const twoMinuteRun = fixtureRun("R1", [twoMinutePr], "passed", "2026-07-13T11:00:00.000Z", {
      finishedAt: "2026-07-13T11:02:00.000Z",
      steps: [
        fixtureStep(
          "check",
          fixtureJob("J1-check", "passed", {
            startedAt: "2026-07-13T11:00:00.000Z",
            finishedAt: "2026-07-13T11:02:00.000Z",
          }),
        ),
      ],
    })
    const fourMinuteRun = fixtureRun("R2", [fourMinutePr], "passed", "2026-07-13T11:10:00.000Z", {
      finishedAt: "2026-07-13T11:14:00.000Z",
      steps: [
        fixtureStep(
          "check",
          fixtureJob("J2-check", "passed", {
            startedAt: "2026-07-13T11:10:00.000Z",
            finishedAt: "2026-07-13T11:14:00.000Z",
          }),
        ),
      ],
    })
    const liveRun = fixtureRun("R3", [livePr], "running", "2026-07-13T11:40:00.000Z", {
      steps: [
        fixtureStep(
          "check",
          fixtureJob("J3-check", "running", {
            startedAt: "2026-07-13T11:40:00.000Z",
          }),
        ),
      ],
    })
    const app = createRenderer({ cols: 180, rows: 50 })(
      createElement(QueueWatchFrame, {
        snapshot: fixtureSnapshot(
          fixtureResult([twoMinutePr, fourMinutePr, livePr], [twoMinuteRun, fourMinuteRun, liveRun]),
        ),
      }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("Step check is running (20:00 elapsed; step p50 3:00).")
    } finally {
      app.unmount()
    }
  })

  it("names a lost job as an observed lease timeout with elapsed time and truthful ownership", async () => {
    const headSha = "8".repeat(40)
    const pr = fixturePr("PR8", "rejected", "2026-07-13T11:25:00.000Z", "Recover timed-out check", {
      headSha,
      terminalRun: "R8",
      rejectedAt: "2026-07-13T11:45:00.000Z",
      revisions: [
        {
          revision: 1,
          headSha,
          base: "main",
          baseSha: "a".repeat(40),
          pushedAt: "2026-07-13T11:25:00.000Z",
          submittedAt: "2026-07-13T11:25:00.000Z",
          terminal: {
            status: "rejected",
            at: "2026-07-13T11:45:00.000Z",
            run: "R8",
          },
        },
      ],
    })
    const run = fixtureRun("R8", [pr], "failed", "2026-07-13T11:31:00.000Z", {
      finishedAt: "2026-07-13T11:45:00.000Z",
      error: { code: "job-lost", message: "runner lease expired" },
      steps: [
        fixtureStep(
          "check",
          fixtureJob("J8-check", "lost", {
            startedAt: "2026-07-13T11:31:00.000Z",
            finishedAt: "2026-07-13T11:45:00.000Z",
            detail: "runner lease expired",
          }),
        ),
      ],
    })
    const app = createRenderer({ cols: 180, rows: 50 })(
      createElement(QueueWatchFrame, { snapshot: fixtureSnapshot(fixtureResult([pr], [run])) }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("failed, timeout")
      expect(app.text).toContain("job lease expired after 14:00")
      expect(app.text).toContain("does not distinguish a killed process,")
      expect(app.text).toContain("crash, or hang")
      expect(app.text).toContain("candidate is innocent")
      expect(app.text).toContain("automatically requeued")
    } finally {
      app.unmount()
    }
  })

  it("calls an unsubmitted revision registered rather than manufacturing a submission event", async () => {
    const headSha = "7".repeat(40)
    const pr = fixturePr("PR7", "pushed", "2026-07-13T11:25:00.000Z", "Draft watch detail", {
      headSha,
      actor: "@agent/8",
      revisions: [
        {
          revision: 1,
          headSha,
          base: "main",
          baseSha: "a".repeat(40),
          pushedAt: "2026-07-13T11:25:00.000Z",
          actor: "@agent/8",
        },
      ],
    })
    const app = createRenderer({ cols: 180, rows: 50 })(
      createElement(QueueWatchFrame, { snapshot: fixtureSnapshot(fixtureResult([pr], [])) }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("r1 registered by @agent/8")
      expect(app.text).not.toContain("r1 submitted by @agent/8")
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

describe("detail run facts — ×N retry mark and no parallel NEXT block", () => {
  it("hides the retry mark at one attempt and shows it above one", () => {
    const base = integratedRun()
    const once = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: { ...base, retries: 1 }, compact: true, section: "run", titleAbove: true }),
    )
    try {
      expect(once.text).not.toMatch(/×\d/)
    } finally {
      once.unmount()
    }
    const retried = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: { ...base, retries: 3 }, compact: true, section: "run", titleAbove: true }),
    )
    try {
      expect(retried.text).toContain("pr#42.1×3")
    } finally {
      retried.unmount()
    }
  })

  it("leaves next-action ownership to the status notice", () => {
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
      expect(failed.text).not.toContain("NEXT")
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
    const headSha = "1".repeat(40)
    const pr = fixturePr("PR11", "rejected", "2026-07-13T10:30:00.000Z", "Explain a long failure", {
      headSha,
      terminalRun: "R11",
      rejectedAt: "2026-07-13T10:42:00.000Z",
      revisions: [
        {
          revision: 1,
          headSha,
          base: "main",
          baseSha: "a".repeat(40),
          pushedAt: "2026-07-13T10:30:00.000Z",
          submittedAt: "2026-07-13T10:30:00.000Z",
          terminal: {
            status: "rejected",
            at: "2026-07-13T10:42:00.000Z",
            run: "R11",
          },
        },
      ],
    })
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
