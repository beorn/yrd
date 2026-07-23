// @failure The live queue-watch detail and metric panes drift from the user's round-6 mock
// @level l2
// @consumer @yrd/cli

import { createElement as h } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import {
  fixtureJob,
  fixturePr,
  fixtureResult,
  fixtureRun,
  fixtureSnapshot,
  fixtureStep,
  queueTimelineStories,
} from "../dev/queue-timeline-fixtures.ts"
import {
  queueShowData,
  queueTimelineAdmissionTimes,
  queueTimelineDateHeaderAt,
  queueTimelineProjection,
} from "../src/queue-status-view.tsx"
import { TimeStatsBox } from "../src/time-stats-box.tsx"
import { QueueWatchFrame, QueueWorkflowStepTabs } from "../src/watch-pane.tsx"

const BRANCH_GLYPH = ""

function branchGlyphColumn(app: ReturnType<ReturnType<typeof createRenderer>>, row: number): number {
  let match = -1
  for (let column = 0; column < app.width; column += 1) {
    if (app.cell(column, row).char === BRANCH_GLYPH) match = column
  }
  return match
}

function pointOf(text: string, needle: string): readonly [number, number] {
  const rows = text.split("\n")
  const y = rows.findIndex((row) => row.includes(needle))
  if (y < 0) throw new Error(`missing '${needle}' in rendered frame`)
  return [rows[y]?.indexOf(needle) ?? -1, y]
}

describe("queue watch user round 6", () => {
  it("removes METRIC titles and moves TIME's INTEGRATED heading onto the window row", () => {
    const projection = queueTimelineStories["production-overview"].snapshot.projection
    const app = createRenderer({ cols: 126, rows: 40 })(
      h(TimeStatsBox, {
        facts: projection.timeStatsFacts,
        now: projection.now,
        earliestEventMs: projection.earliestEventMs,
        width: 126,
      }),
    )
    try {
      expect(app.text).not.toContain("METRIC")
      const rows = app.text.split("\n")
      const integratedWindowRows = rows.filter((row) => /INTEGRATED\s+HR\s+DAY\s+WK\s+MON/u.test(row))
      expect(integratedWindowRows).toHaveLength(1)
    } finally {
      app.unmount()
    }
  })

  it("renders the final v4 run header, the primary PR block, and reverse-chronological revisions", async () => {
    const commit = "b".repeat(40)
    const baseSha = "a".repeat(40)
    const leadHead1 = "7".repeat(40)
    const leadHead2 = "8".repeat(40)
    const leadHead3 = "9".repeat(40)
    const leadHead = "0".repeat(40)
    const partnerHead = "1".repeat(40)
    const lead = {
      ...fixturePr("PR60", "integrated", "2026-07-13T10:30:00.000Z", "Lead fallback", {
        revision: 4,
        actor: "@ci",
        issue: "@yrd/core/21514-detail-pane",
        note: "visual confirmation required",
        headSha: leadHead,
        revisions: [
          {
            revision: 1,
            headSha: leadHead1,
            base: "main",
            baseSha,
            pushedAt: "2026-07-12T22:14:00.000Z",
            submittedAt: "2026-07-12T22:14:00.000Z",
            actor: "@ci",
            terminal: { status: "rejected" as const, at: "2026-07-12T22:15:00.000Z", run: "R57" },
          },
          {
            revision: 2,
            headSha: leadHead2,
            base: "main",
            baseSha,
            recut: {
              fromRevision: 1,
              patchId: "2".repeat(40),
              treeSha: "3".repeat(40),
              reviewCarried: false,
            },
            pushedAt: "2026-07-12T22:19:00.000Z",
            submittedAt: "2026-07-12T22:19:00.000Z",
            actor: "@ci",
            terminal: { status: "rejected" as const, at: "2026-07-12T22:20:00.000Z", run: "R58" },
          },
          {
            revision: 3,
            headSha: leadHead3,
            base: "main",
            baseSha,
            recut: {
              fromRevision: 2,
              patchId: "4".repeat(40),
              treeSha: "5".repeat(40),
              reviewCarried: false,
            },
            pushedAt: "2026-07-12T22:29:00.000Z",
            submittedAt: "2026-07-12T22:29:00.000Z",
            actor: "@ci",
            terminal: { status: "rejected" as const, at: "2026-07-12T22:30:00.000Z", run: "R59" },
          },
          {
            revision: 4,
            headSha: leadHead,
            base: "main",
            baseSha,
            recut: {
              fromRevision: 3,
              patchId: "6".repeat(40),
              treeSha: "7".repeat(40),
              reviewCarried: false,
            },
            pushedAt: "2026-07-13T10:30:00.000Z",
            submittedAt: "2026-07-13T10:30:00.000Z",
            actor: "@ci",
            terminal: { status: "integrated" as const, at: "2026-07-13T10:41:00.000Z", run: "R60" },
          },
        ],
        terminalRun: "R60",
        integratedAt: "2026-07-13T10:41:00.000Z",
        integration: { commit, baseSha },
      }),
      title: "Lead title may wrap across the detail pane",
      description: "First description line\nSecond description line may wrap\n\nIssue: @yrd/core/21514-detail-pane",
      correlation: { namespace: "tribe", id: "21514-round6-agent1" },
      requestedReviewers: ["@chief"],
      checkRequests: [
        { revision: 1, headSha: leadHead1, baseSha, at: "2026-07-12T22:14:30.000Z" },
        { revision: 2, headSha: leadHead2, baseSha, at: "2026-07-12T22:19:30.000Z" },
        { revision: 3, headSha: leadHead3, baseSha, at: "2026-07-12T22:29:30.000Z" },
        {
          revision: 4,
          headSha: leadHead,
          baseSha,
          at: "2026-07-13T10:35:00.000Z",
        },
      ],
      reviews: [
        {
          revision: 4,
          headSha: leadHead,
          actor: "@chief",
          decision: "approve",
          at: "2026-07-13T10:36:00.000Z",
          note: "The final hierarchy is clear.",
        },
      ],
      comments: [
        {
          revision: 4,
          headSha: leadHead,
          actor: "@agent/8",
          at: "2026-07-13T10:37:00.000Z",
          note: "Focused evidence is attached.",
        },
      ],
    }
    const partner = fixturePr("PR61", "integrated", "2026-07-13T10:31:00.000Z", "Partner subject", {
      actor: "@ci",
      issue: "@yrd/core/21525-queue-watch",
      headSha: partnerHead,
      revisions: [
        {
          revision: 1,
          headSha: partnerHead,
          base: "main",
          baseSha,
          pushedAt: "2026-07-13T10:31:00.000Z",
          submittedAt: "2026-07-13T10:31:00.000Z",
          actor: "@ci",
          terminal: { status: "integrated", at: "2026-07-13T10:41:00.000Z", run: "R60" },
        },
      ],
      terminalRun: "R60",
      integratedAt: "2026-07-13T10:41:00.000Z",
      integration: { commit, baseSha },
    })
    const merge = fixtureStep(
      "merge",
      fixtureJob("J60-merge", "passed", {
        runner: "runner-herdr-09",
        output: { commit, baseSha },
      }),
      { integrates: true },
    )
    const rejectedRuns = [
      fixtureRun("R57", [lead], "failed", "2026-07-12T22:14:00.000Z", {
        finishedAt: "2026-07-12T22:15:00.000Z",
        memberRevisions: { PR60: 1 },
        steps: [
          fixtureStep(
            "check",
            fixtureJob("J57-check", "failed", {
              error: { code: "mock-mismatch", message: "round-1 detail layout was rejected" },
            }),
          ),
        ],
      }),
      fixtureRun("R58", [lead], "failed", "2026-07-12T22:19:00.000Z", {
        finishedAt: "2026-07-12T22:20:00.000Z",
        memberRevisions: { PR60: 2 },
        error: { code: "visual-rejected", message: "round-2 hierarchy was rejected" },
      }),
      fixtureRun("R59", [lead], "failed", "2026-07-12T22:29:00.000Z", {
        finishedAt: "2026-07-12T22:30:00.000Z",
        memberRevisions: { PR60: 3 },
        error: { code: "visual-rejected", message: "round-3 density was rejected" },
      }),
    ]
    const run = fixtureRun("R60", [lead, partner], "passed", "2026-07-13T10:40:00.000Z", {
      finishedAt: "2026-07-13T10:41:00.000Z",
      steps: [merge],
      results: { merge: { commit, baseSha } },
    })
    const snapshot = {
      ...fixtureSnapshot(fixtureResult([lead, partner], [...rejectedRuns, run])),
      diffs: [
        {
          pr: "PR60",
          revision: 4,
          additions: 324,
          deletions: 323,
          files: ["src/detail-pane.tsx", "src/watch-pane.tsx"],
          patch: "diff --git a/src/detail-pane.tsx b/src/detail-pane.tsx\n-old detail\n+new detail",
        },
        { pr: "PR61", revision: 1, unavailable: "refs-pruned" as const },
      ],
    }
    const app = createRenderer({ cols: 200, rows: 70 })(h(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()

      const initialRows = app.text.split("\n")
      const tabsY = initialRows.findIndex((row) => row.includes("PR") && row.includes("1: merge"))
      const prTabX = initialRows[tabsY]?.indexOf("PR") ?? -1
      expect(tabsY, "detail tab bar renders").toBeGreaterThanOrEqual(0)
      await app.click(prTabX, tabsY)
      await app.waitForLayoutStable()

      const rows = app.text.split("\n")
      const titleY = rows.findIndex((row) => row.includes("pr#60.4"))
      const detailX = rows[titleY]?.indexOf("pr#60.4") ?? -1
      expect(titleY).toBeGreaterThanOrEqual(0)
      const runY = rows.findIndex((row) => row.slice(detailX).includes("RUN main#60"))
      const tabY = rows.findIndex((row) => row.slice(detailX).includes("1: merge"))
      expect(runY, "the composite run header follows the PR identity").toBeGreaterThan(titleY)
      expect(tabY, "the step tabs follow the composite run header").toBeGreaterThan(runY)
      expect(rows[titleY]?.slice(detailX)).not.toMatch(/\d+(?:h|m|s)/u)
      expect(rows[titleY]).not.toContain("RUN main#60")
      expect(rows[titleY]).not.toContain("PR60")
      expect(rows[titleY]).not.toContain("PR61")
      expect(app.text).not.toMatch(/[▸•]\s+PRS\b/u)
      expect(app.text).not.toContain("TIMELINE")
      expect(app.text).not.toContain("LANDING")
      expect(app.text).not.toContain("ISSUE")
      expect(app.text).toContain("1: merge")
      // Round 6 replaces the per-member PR blocks with the primary block plus a
      // PRs summary row that lists every member PR.
      expect(app.text).toMatch(/PRs\s+pr#60\.4.*pr#61\.1/u)
      expect(app.text).not.toContain(`Committed as ${commit} on main`)
      expect(app.text).toMatch(
        /Started \d{2}:\d{2}:\d{2}, ended \d{2}:\d{2}:\d{2} \(total \d+:\d{2}, wait (?:0|\d+:\d{2})\)/u,
      )
      expect(app.text).toContain("pr#60.4")
      expect(app.text).toContain("pr#61.1")
      expect(app.text).not.toContain("PR60.4")
      expect(app.text).toContain("pr#60.4 @yrd/core/21514-detail-pane")
      expect(app.text).toContain(`${BRANCH_GLYPH} topic/pr60`)
      expect(app.text).not.toContain(`${BRANCH_GLYPH} topic/pr60 - @yrd/core/21514-detail-pane`)
      // Subject has no "- " prefix; description lines have no 2-space indent.
      expect(app.text).toContain("Lead title may wrap across the detail pane")
      expect(app.text).toContain("First description line")
      expect(app.text).toContain("Second description line may wrap")
      // Scalar properties stay keyed; event-shaped facts move into the shared
      // chronological activity stream.
      expect(app.text).toMatch(/NOTE\s+visual confirmation required/u)
      expect(app.text).toMatch(/CORRELATION\s+tribe:21514-round6-agent1/u)
      expect(app.text).toMatch(/REQUESTED REVIEWERS\s+@chief/u)
      expect(app.text).not.toContain("CHECK REQUESTED")
      expect(app.text).not.toMatch(/^RECUT\s/mu)

      const activity = [
        "r1 submitted by @ci",
        "r1 check requested",
        "r1 run main#57",
        "r2 recut of r1",
        "r2 submitted by @ci",
        "r2 check requested",
        "r2 run main#58",
        "r3 recut of r2",
        "r3 submitted by @ci",
        "r3 check requested",
        "r3 run main#59",
        "r4 recut of r3",
        "r4 submitted by @ci",
        "r4 check requested",
        "r4 review approve by @chief",
        "r4 comment by @agent/8",
        "r4 run main#60",
      ]
      for (const event of activity) expect(app.text, `activity includes ${event}`).toContain(event)
      for (let index = 1; index < activity.length; index += 1) {
        expect(
          app.text.indexOf(activity[index]!),
          `${activity[index - 1]} precedes ${activity[index]}`,
        ).toBeGreaterThan(app.text.indexOf(activity[index - 1]!))
      }

      const activityY = rows.findIndex((row) => row.includes("r1 submitted by @ci"))
      const activityClockX = rows[activityY]?.search(/\d{2}:\d{2}/u) ?? -1
      const activityTextX = rows[activityY]?.indexOf("r1 submitted") ?? -1
      expect(app.cell(activityClockX, activityY).fg, "activity time is muted").not.toEqual(
        app.cell(activityTextX, activityY).fg,
      )
      const detailText = rows.map((row) => row.slice(detailX)).join("\n")
      expect(detailText.match(/@yrd\/core\/21514-detail-pane/gu)).toHaveLength(1)
      expect(app.text).toContain("Diff +324 / -323 lines")
      expect(app.text).not.toContain("src/detail-pane.tsx")
      expect(app.text).not.toContain("click to expand")

      const branchY = rows.findIndex((row) => row.slice(detailX).includes(`${BRANCH_GLYPH} topic/pr60`))
      const branchX = branchGlyphColumn(app, branchY)
      const branchTextX = branchX + 2
      expect(app.cell(branchX, branchY).fg, "branch marker inherits its branch-row foreground").toEqual(
        app.cell(branchTextX, branchY).fg,
      )
      expect(app.cell(branchX, branchY).dim).toBe(true)

      const prY = rows.findIndex((line) => line.slice(detailX).includes("pr#60.4"))
      const prX = rows[prY]?.indexOf("pr#60.4") ?? -1
      const titleBlockY = rows.findIndex((line) => line.slice(detailX).includes("Lead title may wrap"))
      const titleX = rows[titleBlockY]?.indexOf("Lead title") ?? -1
      const bodyY = rows.findIndex((line) => line.slice(detailX).includes("First description line"))
      const bodyX = rows[bodyY]?.indexOf("First description line") ?? -1
      expect(app.cell(prX, prY).fg).not.toEqual(app.cell(branchTextX, branchY).fg)
      expect(app.cell(prX, prY).bold).not.toBe(true)
      expect(app.cell(prX + 3, prY).bold).toBe(true)
      expect(app.cell(prX + 5, prY).bold).not.toBe(true)
      expect(app.cell(titleX, titleBlockY).bold).toBe(true)
      expect(app.cell(bodyX, bodyY).bold).not.toBe(true)

      const diff = pointOf(app.text, "Diff +324 / -323 lines")
      const collapsedRows = app.text.split("\n")
      expect(collapsedRows[diff[1] - 1]?.slice(detailX).trim(), "blank row above the diff summary").toBe("")
      expect(collapsedRows[diff[1] + 1]?.slice(detailX).trim(), "blank row below the diff summary").toBe("")
      expect(
        collapsedRows.slice(diff[1] + 1, diff[1] + 4).some((line) => line.slice(detailX).includes("─")),
        "a horizontal divider terminates the PR diff section",
      ).toBe(true)
      await app.click(diff[0], diff[1])
      await app.waitForLayoutStable()
      expect(app.text).toContain("src/detail-pane.tsx")
      expect(app.text).toContain("+new detail")

      const expandedPatch = pointOf(app.text, "+new detail")
      await app.click(expandedPatch[0], expandedPatch[1])
      await app.waitForLayoutStable()
      expect(app.text).not.toContain("src/detail-pane.tsx")
      await app.press("Tab")
      await app.press("Enter")
      await app.waitForLayoutStable()
      expect(app.text).toContain("src/detail-pane.tsx")

      const mergeTab = pointOf(app.text, "1: merge")
      await app.click(mergeTab[0], mergeTab[1])
      await app.waitForLayoutStable()
      expect(app.text).toContain(`COMMIT ${commit}`)
      // The merge tab's step content (below the tab bar) carries the run-level
      // COMMIT/PARENTS, never a repeated PR-id block — the pr#id now lives only in
      // the persistent identity title above the tabs.
      const divider = app.text.split("\n")[0]?.indexOf("│") ?? -1
      const stepRows = app.text.split("\n")
      const mergeTabRow = stepRows.findIndex((line) => line.includes("1: merge"))
      expect(
        stepRows
          .slice(mergeTabRow)
          .map((line) => line.slice(divider + 1))
          .join("\n"),
      ).not.toContain("pr#60.4")
    } finally {
      app.unmount()
    }
  })

  it("labels both total lineage age and the current revision's queue age", async () => {
    const head1 = "1".repeat(40)
    const head2 = "2".repeat(40)
    const head3 = "3".repeat(40)
    const pr = fixturePr("PR63", "submitted", "2026-07-13T11:52:00.000Z", "Long-suffering queue item", {
      revision: 3,
      headSha: head3,
      actor: "@agent/8",
      revisions: [
        {
          revision: 1,
          headSha: head1,
          base: "main",
          baseSha: "a".repeat(40),
          pushedAt: "2026-07-13T11:03:00.000Z",
          submittedAt: "2026-07-13T11:03:00.000Z",
          actor: "@agent/8",
          terminal: { status: "rejected", at: "2026-07-13T11:08:00.000Z", run: "R61" },
        },
        {
          revision: 2,
          headSha: head2,
          base: "main",
          baseSha: "a".repeat(40),
          recut: {
            fromRevision: 1,
            patchId: "4".repeat(40),
            treeSha: "5".repeat(40),
            reviewCarried: false,
          },
          pushedAt: "2026-07-13T11:20:00.000Z",
          submittedAt: "2026-07-13T11:20:00.000Z",
          actor: "@agent/8",
          terminal: { status: "rejected", at: "2026-07-13T11:25:00.000Z", run: "R62" },
        },
        {
          revision: 3,
          headSha: head3,
          base: "main",
          baseSha: "a".repeat(40),
          recut: {
            fromRevision: 2,
            patchId: "6".repeat(40),
            treeSha: "7".repeat(40),
            reviewCarried: false,
          },
          pushedAt: "2026-07-13T11:52:00.000Z",
          submittedAt: "2026-07-13T11:52:00.000Z",
          actor: "@agent/8",
        },
      ],
    })
    const app = createRenderer({ cols: 150, rows: 45 })(
      h(QueueWatchFrame, { snapshot: fixtureSnapshot(fixtureResult([pr], [])) }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).toMatch(/AGE\s+3 revisions · 57:00 total · r3 queued 8:00/u)
    } finally {
      app.unmount()
    }
  })

  it("groups rows by local day before status so date headers never interleave", () => {
    const pending = fixturePr("PR70", "submitted", "2026-07-18T12:00:00.000Z")
    const runningPr = fixturePr("PR71", "submitted", "2026-07-19T12:00:00.000Z")
    const finishedHead = "2".repeat(40)
    const finishedPr = fixturePr("PR72", "integrated", "2026-07-18T10:00:00.000Z", "Finished", {
      headSha: finishedHead,
      revisions: [
        {
          revision: 1,
          headSha: finishedHead,
          base: "main",
          baseSha: "a".repeat(40),
          pushedAt: "2026-07-18T10:00:00.000Z",
          submittedAt: "2026-07-18T10:00:00.000Z",
          terminal: { status: "integrated", at: "2026-07-18T11:00:00.000Z", run: "R72" },
        },
      ],
      terminalRun: "R72",
      integratedAt: "2026-07-18T11:00:00.000Z",
      integration: { commit: "c".repeat(40), baseSha: "a".repeat(40) },
    })
    const running = fixtureRun("R71", [runningPr], "running", "2026-07-19T12:00:00.000Z")
    const finished = fixtureRun("R72", [finishedPr], "passed", "2026-07-18T10:30:00.000Z", {
      finishedAt: "2026-07-18T11:00:00.000Z",
      results: { integrate: { commit: "c".repeat(40), baseSha: "a".repeat(40) } },
    })
    const result = fixtureResult([pending, runningPr, finishedPr], [running, finished])
    const projection = queueTimelineProjection([result], {
      now: Date.parse("2026-07-19T13:00:00.000Z"),
      windowMs: 48 * 60 * 60_000,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: queueTimelineAdmissionTimes([result]),
      base: "main",
      runner: null,
    })
    const headers = projection.rows
      .map((_, index) => queueTimelineDateHeaderAt(projection.rows, index, true))
      .filter((header): header is string => header !== null)

    expect(headers).toEqual([...new Set(headers)])
    expect(projection.rows.map((row) => row.pr)).toEqual(["PR71", "PR70", "PR72"])
  })

  it("distinguishes pruned refs from other Git failures", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const diffs = snapshot.diffs?.map((diff, index) =>
      index === 0 ? { pr: diff.pr, revision: diff.revision, unavailable: "git-error" as const } : diff,
    )
    const app = createRenderer({ cols: 200, rows: 50 })(h(QueueWatchFrame, { snapshot: { ...snapshot, diffs } }))
    try {
      await app.waitForLayoutStable()
      // The detail shows only the cursor PR's diff, so each member PR's
      // unavailable reason is read from that PR's own row: git error on the first
      // member, pruned refs on the second.
      expect(app.text).toContain("diff unavailable (git error)")
      await app.press("j")
      await app.waitForLayoutStable()
      expect(app.text).toContain("diff unavailable (refs pruned)")
    } finally {
      app.unmount()
    }
  })

  it("uses compact equal-width filled tabs with two-cell horizontal and one-row vertical padding", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const app = createRenderer({ cols: 200, rows: 50 })(h(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      const tabsY = rows.findIndex(
        (row) => row.includes("1: prepare") && row.includes("2: check") && row.includes("3: merge"),
      )
      const tabRow = rows[tabsY] ?? ""
      const statusRow = rows[tabsY + 1] ?? ""
      const prepareX = tabRow.indexOf("1: prepare")
      const checkX = tabRow.indexOf("2: check", prepareX)
      const mergeX = tabRow.indexOf("3: merge", checkX)
      const firstStride = checkX - prepareX
      const secondStride = mergeX - checkX

      expect(tabsY).toBeGreaterThanOrEqual(0)
      // Round 6 drops the synthetic submit tab; the pane opens on the live step
      // (check is running), so check is the default-selected tab and prepare is
      // inactive. Both tabs are filled, with distinct surfaces.
      expect(app.cell(prepareX, tabsY).bg, "inactive tab has a background fill").not.toBeNull()
      expect(app.cell(checkX, tabsY).bg, "default-selected check tab has a background fill").not.toBeNull()
      expect(app.cell(prepareX, tabsY).bg).not.toEqual(app.cell(checkX, tabsY).bg)
      expect(Math.abs(firstStride - secondStride), "all tabs use the widest content width").toBeLessThanOrEqual(1)
      expect(firstStride, "tabs do not stretch across the whole detail pane").toBeLessThan(20)
      expect(statusRow).toMatch(/✓ passed\s+\d+(?:m(?:\d+s)?|s)/u)
      expect(app.cell(prepareX - 2, tabsY).bg, "two cells of left padding inherit the tab fill").toEqual(
        app.cell(prepareX, tabsY).bg,
      )
      expect(app.cell(prepareX, tabsY - 1).bg, "one blank row above content inherits the tab fill").toEqual(
        app.cell(prepareX, tabsY).bg,
      )
      expect(app.cell(prepareX, tabsY + 2).bg, "one blank row below content inherits the tab fill").toEqual(
        app.cell(prepareX, tabsY).bg,
      )
      expect(rows[tabsY - 2]?.slice(prepareX - 2).trim(), "one unfilled blank row sits above the padded tab row").toBe(
        "",
      )
      expect(rows[tabsY + 3]?.slice(prepareX - 2).trim(), "one unfilled blank row sits below the padded tab row").toBe(
        "",
      )
      expect(rows[tabsY + 2]).not.toMatch(/◷\s+\d/u)

      const duration = /\d+(?:m(?:\d+s)?|s)/u.exec(statusRow)
      expect(duration).not.toBeNull()
      expect(app.cell(duration?.index ?? -1, tabsY + 1).dim).toBe(true)
    } finally {
      app.unmount()
    }
  })

  it("renders JOB yrd#id before a bold $ command and always-expanded grey output", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const app = createRenderer({ cols: 200, rows: 50 })(h(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      const checkTab = pointOf(app.text, ": check")
      await app.click(checkTab[0], checkTab[1])
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      const jobY = rows.findIndex(
        (row) =>
          row.includes("JOB") && row.includes("yrd#J42-check") && row.includes("@hab/super/21135-herdr-keybindings"),
      )
      const commandY = rows.findIndex((row) => row.includes("$ bun vitest run"))
      const outputY = rows.findIndex((row) => row.includes("125 tests collected"))

      expect(jobY).toBeGreaterThanOrEqual(0)
      expect(commandY).toBeGreaterThan(jobY)
      expect(outputY).toBeGreaterThan(commandY)
      const divider = rows[0]?.indexOf("│") ?? -1
      expect(rows[commandY - 1]?.slice(divider + 1).trim(), "one blank row separates metadata from execution").toBe("")
      expect(app.text).not.toContain("runner-herdr-07")
      expect(app.text).not.toContain("DETAILS")
      expect(app.text).not.toContain("COMMAND $ ")
      expect(app.text).not.toContain("RUN LOGS")
      expect(app.text).not.toContain("FOLLOWING END")
      expect(app.text).not.toContain("OUTPUT check#")

      const commandX = rows[commandY]?.indexOf("$ bun vitest run") ?? -1
      const outputX = rows[outputY]?.indexOf("125 tests collected") ?? -1
      const jobIdX = rows[jobY]?.indexOf("J42-check") ?? -1
      const jobLabelX = rows[jobY]?.indexOf("JOB") ?? -1
      const issueX = rows[jobY]?.indexOf("@hab/super/21135-herdr-keybindings") ?? -1
      expect(app.cell(jobLabelX, jobY).bold).toBe(true)
      expect(app.cell(jobIdX, jobY).bold).toBe(true)
      expect(app.cell(issueX, jobY).bold).toBe(true)
      expect(app.cell(commandX, commandY).bold).toBe(true)
      expect(app.cell(outputX, outputY).fg, "inline output is greyed against the command").not.toEqual(
        app.cell(commandX, commandY).fg,
      )
    } finally {
      app.unmount()
    }
  })

  it("renders every recorded command with its own output block in attempt order", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const result = snapshot.results[0]
    const run = result?.running.find((candidate) => candidate.id === "R42")
    if (result === undefined || run === undefined) throw new Error("production fixture is missing R42")
    const data = queueShowData(run)
    const check = data.steps.find((row) => row.step === "check")
    if (check === undefined) throw new Error("production fixture is missing the check step")
    const repeated = {
      ...data,
      steps: [
        ...data.steps.filter((row) => row.step !== "check"),
        { ...check, uuid: "J42-check-1", attempt: "1", command: "bun vitest run first.spec.ts" },
        { ...check, uuid: "J42-check-2", attempt: "2", command: "bun vitest run second.spec.ts" },
      ],
    }
    const app = createRenderer({ cols: 120, rows: 36 })(
      h(QueueWorkflowStepTabs, {
        data: repeated,
        row: snapshot.projection.rows.find((candidate) => candidate.pr === "PR42"),
        outputs: [
          {
            source: "recorded",
            run: "R42",
            step: "check",
            attempt: 1,
            path: "attempt-1.log",
            text: "first attempt output",
          },
          {
            source: "recorded",
            run: "R42",
            step: "check",
            attempt: 2,
            path: "attempt-2.log",
            text: "second attempt output",
          },
        ],
        compact: true,
        active: false,
        highlightPr: "PR42",
        prs: result.prs,
      }),
    )
    try {
      await app.waitForLayoutStable()
      const checkTab = pointOf(app.text, ": check")
      await app.click(checkTab[0], checkTab[1])
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      const firstCommand = rows.findIndex((row) => row.includes("$ bun vitest run first.spec.ts"))
      const firstOutput = rows.findIndex((row) => row.includes("first attempt output"))
      const secondCommand = rows.findIndex((row) => row.includes("$ bun vitest run second.spec.ts"))
      const secondOutput = rows.findIndex((row) => row.includes("second attempt output"))

      expect(firstCommand).toBeGreaterThanOrEqual(0)
      expect(firstOutput).toBeGreaterThan(firstCommand)
      expect(secondCommand).toBeGreaterThan(firstOutput)
      expect(secondOutput).toBeGreaterThan(secondCommand)
      expect(rows[firstCommand - 1]?.trim()).toBe("")
      expect(rows[secondCommand - 1]?.trim()).toBe("")
    } finally {
      app.unmount()
    }
  })

  it("preserves recorded merge attempts instead of collapsing them into one synthetic command", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const result = snapshot.results[0]
    const run = result?.running.find((candidate) => candidate.id === "R42")
    if (result === undefined || run === undefined) throw new Error("production fixture is missing R42")
    const data = queueShowData(run)
    const merge = data.steps.find((row) => row.step === "merge")
    if (merge === undefined) throw new Error("production fixture is missing the merge step")
    const repeated = {
      ...data,
      steps: [
        ...data.steps.filter((row) => row.step !== "merge"),
        { ...merge, attempt: "1", command: "git merge first-head" },
        { ...merge, attempt: "2", command: "git merge second-head" },
      ],
    }
    const app = createRenderer({ cols: 120, rows: 36 })(
      h(QueueWorkflowStepTabs, {
        data: repeated,
        row: snapshot.projection.rows.find((candidate) => candidate.pr === "PR42"),
        outputs: [
          {
            source: "recorded",
            run: "R42",
            step: "merge",
            attempt: 1,
            path: "attempt-1.log",
            text: "first merge failed",
          },
          {
            source: "recorded",
            run: "R42",
            step: "merge",
            attempt: 2,
            path: "attempt-2.log",
            text: "second merge passed",
          },
        ],
        compact: true,
        active: false,
        highlightPr: "PR42",
        prs: result.prs,
      }),
    )
    try {
      await app.waitForLayoutStable()
      const mergeTab = pointOf(app.text, ": merge")
      await app.click(mergeTab[0], mergeTab[1])
      await app.waitForLayoutStable()
      expect(app.text).toMatch(
        /\$ git merge first-head[\s\S]*first merge failed[\s\S]*\$ git merge second-head[\s\S]*second merge passed/u,
      )
    } finally {
      app.unmount()
    }
  })

  it("renders the complete expanded diff inline, tail included, without a submit-tab scroll", async () => {
    const story = queueTimelineStories["production-overview"]
    const firstDiff = story.snapshot.diffs?.[0]
    if (firstDiff === undefined || "unavailable" in firstDiff) {
      throw new Error("production fixture has no available diff")
    }
    const tail = "round-8-long-diff-tail"
    const snapshot = {
      ...story.snapshot,
      diffs: [
        {
          ...firstDiff,
          patch: `${Array.from({ length: 90 }, (_, index) => `+long diff row ${index + 1}`).join("\n")}\n+${tail}`,
        },
      ],
    }
    // Round 6 moves the diff out of the scrollable submit tab into the PR header
    // section, where an expanded diff renders its full patch inline (no per-diff
    // scroll). A viewport tall enough to hold the whole diff shows the complete
    // patch, tail included; a collapsed diff shows only its summary.
    const app = createRenderer({ cols: 200, rows: 130 })(h(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).not.toContain(tail)
      const summary = pointOf(app.text, "Diff +")
      await app.click(summary[0], summary[1])
      await app.waitForLayoutStable()
      expect(app.text).toContain("+long diff row 1")
      expect(app.text).toContain(tail)
    } finally {
      app.unmount()
    }
  })

  it("shows native merge command and summary without an artifact stream or expand action", async () => {
    const headSha = "0".repeat(40)
    const pr = fixturePr("PR60", "integrated", "2026-07-13T10:30:00.000Z", "Native merge evidence", {
      headSha,
      integratedAt: "2026-07-13T10:41:00.000Z",
      terminalRun: "R60",
      integration: { commit: "b".repeat(40), baseSha: "a".repeat(40) },
      revisions: [
        {
          revision: 1,
          headSha,
          base: "main",
          baseSha: "a".repeat(40),
          pushedAt: "2026-07-13T10:30:00.000Z",
          submittedAt: "2026-07-13T10:30:00.000Z",
          terminal: { status: "integrated", at: "2026-07-13T10:41:00.000Z", run: "R60" },
        },
      ],
    })
    const merge = fixtureStep(
      "merge",
      fixtureJob("J60-merge", "passed", {
        runner: "runner-herdr-09",
        output: { commit: "b".repeat(40), baseSha: "a".repeat(40) },
      }),
      { integrates: true },
    )
    const run = fixtureRun("R60", [pr], "passed", "2026-07-13T10:40:00.000Z", {
      finishedAt: "2026-07-13T10:41:00.000Z",
      steps: [merge],
      results: { merge: { commit: "b".repeat(40), baseSha: "a".repeat(40) } },
    })
    const projected = queueShowData(run)
    const runHeadSha = projected.prs[0]?.headSha
    if (runHeadSha === undefined) throw new Error("round-6 merge fixture has no head SHA")
    const nativeCommand = `git merge --no-ff --no-edit ${runHeadSha}`
    const data = {
      ...projected,
      steps: projected.steps.map((row) => (row.step === "merge" ? { ...row, command: nativeCommand } : row)),
    }
    const app = createRenderer({ cols: 100, rows: 30 })(
      h(QueueWorkflowStepTabs, {
        data,
        outputs: [],
        compact: true,
        active: false,
        highlightPr: pr.id,
        prs: [pr],
      }),
    )
    try {
      await app.waitForLayoutStable()
      const mergeTab = pointOf(app.text, "1: merge")
      await app.click(mergeTab[0], mergeTab[1])
      await app.waitForLayoutStable()
      expect(app.text).toContain(`COMMIT ${data.integration?.commit}`)
      expect(app.text).toContain(`$ ${nativeCommand}`)
      expect(app.text).toContain(`PARENTS ${data.integration?.baseSha} ${runHeadSha}`)
      expect(app.text).not.toContain(`MERGE ${data.integration?.commit}`)
      expect(app.text).not.toMatch(/Waiting for (?:first )?(?:input|output)/u)
      expect(app.text).not.toContain("RUN LOGS")
    } finally {
      app.unmount()
    }
  })
})
