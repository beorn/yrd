/**
 * 21106 W3 — DETAIL pane rework (user screenshot review, 2026-07-16;
 * reshaped by the 2026-08-18 operator rulings, items 23/25).
 *
 * Pins the reshaped detail surface: the RUN status box AS the pane's top
 * (no identity title row above it), every member box carrying its own
 * `pr#id.rev ⎇ branch` header, one truthful status notice, and separate
 * JOB/RUNNER facts.
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
import { QueueShowView, queueStatusNotice, queueShowData, type QueueShowData } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const BRANCH_GLYPH = ""

function integratedRun(): QueueShowData {
  const pr = fixturePr("PR42", "integrated", "2026-07-13T10:30:00.000Z", "Merge the durable patch")
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

function failureData(code: string, message: string): QueueShowData {
  const data = failedRun()
  if (data.failure === undefined) throw new Error("failed-run fixture is missing its projected failure")
  const failure = {
    ...data.failure,
    code,
    message,
    summary: `err=${code}: ${message}`,
  }
  return {
    ...data,
    failure,
    steps: data.steps.map((step, index) => (index === 0 ? { ...step, failure } : step)),
  }
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

describe("detail pane top — the RUN status box, no identity title above it (item 23)", () => {
  it("opens the detail on the status box border and gives the cursor member its own boxed header", async () => {
    const pr = fixturePr("PR42", "submitted", "2026-07-13T10:30:00.000Z", "Merge it")
    const run = fixtureRun("R42", [pr], "passed", "2026-07-13T10:40:00.000Z", {
      finishedAt: "2026-07-13T10:55:00.000Z",
    })
    const app = createRenderer({ cols: 220, rows: 50 })(
      createElement(QueueWatchFrame, { snapshot: fixtureSnapshot(fixtureResult([pr], [run])) }),
    )
    try {
      await app.waitForLayoutStable()
      // The default cursor follows the newest (pre-run) row; select the run
      // row so the box carries the run identity.
      await app.press("j")
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      const divider = rows[1]?.indexOf("│") ?? -1
      expect(divider).toBeGreaterThan(0)
      const detailRows = rows.map((row) => row.slice(divider + 1))
      // The FIRST detail row is the status box's top border, its right side
      // carrying the run identity — no pr#id title row above it.
      const borderY = detailRows.findIndex((row) => row.includes("RUN main#42"))
      expect(borderY, "status box border carries the run identity").toBeGreaterThanOrEqual(0)
      expect(detailRows[borderY]).toContain("╭")
      const firstContentY = detailRows.findIndex((row) => row.trim() !== "")
      expect(firstContentY, "nothing renders above the status box").toBe(borderY)
      // The cursor member's own box still carries its identity + branch
      // header (item 25 — the skip-own-id rule died with the title).
      expect(app.text).toContain("pr#42.1 ⎇ topic/pr42")
      // And the change list bullet names it beneath the box (item 24).
      expect(app.text).toContain("· pr#42.1")
    } finally {
      app.unmount()
    }
  })

  it("renders the no-selection placeholder when the projection has no rows", async () => {
    const app = createRenderer({ cols: 220, rows: 40 })(
      createElement(QueueWatchFrame, { snapshot: fixtureSnapshot(fixtureResult([], [])) }),
    )
    try {
      await app.waitForLayoutStable()
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
        submitter: "@agent/8",
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
            submitter: "@agent/8",
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
    const app = createRenderer({ cols: 220, rows: 50 })(
      createElement(QueueWatchFrame, { snapshot: fixtureSnapshot(fixtureResult([pr], [run])) }),
    )
    try {
      await app.waitForLayoutStable()
      await app.press("j")
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      const runY = rows.findIndex((line) => line.includes("RUN main#9"))
      const timingY = rows.findIndex((line) => line.includes("Started "))
      const tabsY = rows.findIndex((line) => line.includes("1: check"))
      expect(runY, "run identity leads the composite header").toBeGreaterThanOrEqual(0)
      expect(timingY, "run timing is inside the composite header").toBeGreaterThan(runY)
      expect(tabsY, "step tabs follow the composite header").toBeGreaterThan(timingY)

      const noticeY = rows.findIndex((line) => line.includes("failed, rejected"))
      expect(noticeY, "the status notice headline is present").toBeGreaterThanOrEqual(0)
      expect(rows[noticeY]).toContain("×")
      expect(app.cell(rows[noticeY]?.indexOf("failed") ?? -1, noticeY).bold).toBe(true)
      const topBorderY = rows.findLastIndex((line, index) => index < noticeY && line.includes("╭"))
      // `lastIndexOf`, not `indexOf`: the status box's border now carries the
      // RUN identity right in its top border (operator spec item 1), so on a
      // narrow pane that border can merge on the SAME row as the split-pane's
      // list-side RUNNER box border. The detail pane is always the rightmost
      // region, so its own "╭" is the last one on a shared row.
      const borderX = rows[topBorderY]?.lastIndexOf("╭") ?? -1
      expect(topBorderY, "notice has an outline").toBeGreaterThanOrEqual(0)
      expect(app.cell(borderX, topBorderY).fg, "border and headline use the same status tone").toEqual(
        app.cell(rows[noticeY]?.indexOf("failed") ?? -1, noticeY).fg,
      )
      expect(app.text).toContain("err=check-failed")
      // Screen text interleaves the left pane between wrapped right-pane
      // lines, so assert the two visible fragments independently.
      expect(app.text).toContain("This failure is not")
      expect(app.text).toContain("retried automatically; the author")
      expect(app.text).toContain("author must fix the branch and resubmit")
      expect(app.text).not.toMatch(/^(?:ERROR|CAUSE|RESOLVE|LOST|NEXT)\b/mu)
      // The failed step line carries its remedy inline on the status box
      // (item 39), severity-colored.
      expect(app.text).toMatch(/× check.*err=check-failed/u)
      // The member boxes live on the Changes tab; the failed step tab is the
      // default, so switch left to reach them.
      await app.press("h")
      await app.waitForLayoutStable()
      const changeRows = app.text.split("\n")
      const headerY = changeRows.findIndex((line) => line.includes("pr#9.1 ⎇"))
      expect(headerY, "the member box header carries the identity").toBeGreaterThanOrEqual(0)
      const detailX = changeRows[headerY]?.indexOf("pr#9.1") ?? -1
      const detailText = changeRows.map((line) => line.slice(detailX)).join("\n")
      // The ISSUE metadata row owns the issue; the description's own
      // `Issue: …` line stays deduplicated — exactly one occurrence.
      expect(detailText.match(/@yrd\/core\/21096-cli-ux\/21751-watch-detail-status-dry/gu)).toHaveLength(1)
    } finally {
      app.unmount()
    }
  })

  it.each([
    [
      "source-publish",
      "source ref publication failed",
      "env",
      "requeue",
      "Infrastructure fault; the candidate is innocent",
      "Automatically requeued",
      "base advanced",
    ],
    [
      "stale-base",
      "queue base advanced",
      "stale",
      "recut",
      "The base advanced after this revision requested required checks",
      "Automatically re-merged and requeued",
      "installed step configuration",
    ],
    [
      "stale-check",
      "checked candidate ref moved",
      "stale",
      "requeue",
      "The checked candidate changed after its required checks",
      "Automatically requeued",
      "Automatically re-merged",
    ],
    [
      "stale-steps",
      "installed steps changed",
      "stale",
      "requeue",
      "The installed check configuration changed",
      "Automatically requeued",
      "base advanced",
    ],
    [
      "stale-plan",
      "recorded plan drifted",
      "stale",
      "requeue",
      "The recorded run plan changed",
      "Automatically requeued",
      "base advanced",
    ],
    [
      "stale-pr",
      "PR changed after the run was pinned",
      "stale",
      "none",
      "The change revision changed after this run was pinned",
      "This historical run will not retry",
      "Automatically re-merged",
    ],
  ] as const)(
    "renders truthful %s ownership and next-action copy",
    (code, message, state, automaticKind, explanation, next, absent) => {
      const notice = queueStatusNotice(undefined, failureData(code, message))
      expect(notice).toMatchObject({
        state,
        auto: { kind: automaticKind },
        owner: "queue",
      })
      expect(notice?.explanation).toContain(explanation)
      expect(notice?.explanation).toContain(next)
      expect(notice?.explanation).not.toContain(absent)
    },
  )
})

describe("detail run facts — natural timing sentence + merge, no RUN/BASE duplication", () => {
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
      expect(app.text).not.toContain("MERGE")

      expect(app.text.split("\n").findIndex((row) => row.startsWith("Started "))).toBeLessThan(
        app.text.split("\n").findIndex((row) => row.startsWith("Committed as ")),
      )
    } finally {
      app.unmount()
    }
  })

  it("collapses START/END + TOTAL/ACTIVE/WAIT into one sentence while keeping the merge separate", () => {
    const app = createRenderer({ cols: 120, rows: 20 })(
      createElement(QueueShowView, { data: integratedRun(), compact: true, section: "run", titleAbove: true }),
    )
    try {
      // One natural sentence carries clocks/duration; the merge sentence owns the proof SHA.
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
      await app.press("j")
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
