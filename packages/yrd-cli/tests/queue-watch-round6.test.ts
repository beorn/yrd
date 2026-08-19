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
  QueueDetailRunPrBlocks,
  type QueueTerminalFact,
  queueShowData,
  queueTimelineAdmissionTimes,
  queueTimelineDateHeaderAt,
  queueTimelineProjection,
} from "../src/queue-status-view.tsx"
import { QueueStatsPanel } from "../src/time-stats-box.tsx"
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

// Renamed from the "PR" tab (operator spec item 3: the first tab is now
// "Changes").
async function selectPrTab(app: ReturnType<ReturnType<typeof createRenderer>>): Promise<void> {
  const rows = app.text.split("\n")
  const y = rows.findIndex((row) => row.includes("Changes") && row.includes("1: prepare"))
  const divider = rows[y]?.indexOf("│") ?? -1
  const x = rows[y]?.indexOf("Changes", divider + 1) ?? -1
  if (x < 0 || y < 0) throw new Error(`missing Changes tab in rendered frame:\n${app.text}`)
  await app.click(x, y)
  await app.waitForLayoutStable()
}

describe("queue watch user round 6", () => {
  it("replaces the legacy METRIC boxes with one calendar STATS hierarchy", () => {
    const projection = queueTimelineStories["production-overview"].snapshot.projection
    const app = createRenderer({ cols: 126, rows: 40 })(
      h(QueueStatsPanel, {
        facts: projection.timeStatsFacts,
        now: projection.now,
        earliestFactMs: projection.earliestFactMs,
        width: 126,
      }),
    )
    try {
      expect(app.text).not.toContain("METRIC")
      expect(app.text).toContain("╭─ STATS ")
      expect(app.text).toContain("TODAY")
      expect(app.text).toContain("YSTRDAY")
      expect(app.text).toContain("WEEK")
      expect(app.text).toContain("MONTH")
      expect(app.text).toContain("AVG TIME")
      expect(app.text).toContain("RETRIES/RUN")
      expect(app.text).not.toContain("CODING")
    } finally {
      app.unmount()
    }
  })

  it("reserves pane padding before budgeting the STATS hour columns", async () => {
    const snapshot = queueTimelineStories["production-overview"].snapshot
    const nowMs = Date.parse(snapshot.projection.now)
    const activeHours: QueueTerminalFact[] = Array.from({ length: 15 }, (_, index) => ({
      run: `active-hour-${String(index)}`,
      terminalAtMs: nowMs - (5 + index * 60) * 60_000,
      outcome: "passed",
      failureClass: null,
      activeMs: 60_000,
      queueWaitMs: [],
      members: [],
    }))
    const app = createRenderer({ cols: 126, rows: 40 })(
      h(QueueWatchFrame, {
        snapshot: {
          ...snapshot,
          projection: {
            ...snapshot.projection,
            timeStatsFacts: activeHours,
            earliestFactMs: nowMs - 30 * 24 * 60 * 60_000,
          },
        },
      }),
    )
    try {
      await app.press("Escape")
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      const header = rows.find((row) => row.includes("TODAY"))
      const allRuns = rows.find((row) => row.includes("ALL"))
      if (header === undefined || allRuns === undefined) throw new Error(`missing STATS rows:\n${app.text}`)
      expect(header).toContain("…")
      expect(allRuns).toContain("·")
    } finally {
      app.unmount()
    }
  })

  it("renders the final v4 run header, primary PR block, and full chronological activity", async () => {
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
        submitter: "@ci",
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
            submitter: "@ci",
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
            submitter: "@ci",
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
            submitter: "@ci",
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
            submitter: "@ci",
            correlation: { namespace: "tribe", id: "21514-round6-agent1" },
            terminal: { status: "integrated" as const, at: "2026-07-13T10:41:00.000Z", run: "R60" },
          },
        ],
        terminalRun: "R60",
        integratedAt: "2026-07-13T10:41:00.000Z",
        integration: { commit, baseSha },
      }),
      title: "Lead title may wrap across the detail pane",
      description: "First description row\nSecond description row may wrap",
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
          by: "@chief",
          decision: "approve" as const,
          at: "2026-07-13T10:36:00.000Z",
          note: "The final hierarchy is clear.",
        },
      ],
      comments: [
        {
          revision: 4,
          headSha: leadHead,
          by: "@agent/8",
          at: "2026-07-13T10:37:00.000Z",
          note: "Focused evidence is attached.",
        },
      ],
    }
    const partner = fixturePr("PR61", "integrated", "2026-07-13T10:31:00.000Z", "Partner subject", {
      submitter: "@ci",
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
          submitter: "@ci",
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
      { kind: "merge" },
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
    const activityProjection = queueTimelineProjection([fixtureResult([lead, partner], [...rejectedRuns, run])], {
      now: snapshot.now,
      windowMs: 24 * 60 * 60_000,
      statuses: snapshot.projection.filters.statuses,
      terms: [],
      latest: false,
      rowLimit: 100,
      submissionTimes: queueTimelineAdmissionTimes([fixtureResult([lead, partner], [...rejectedRuns, run])]),
    })
    const olderRun = rejectedRuns[1]
    if (olderRun === undefined) throw new Error("missing older activity fixture")
    const olderRow = activityProjection.rows.find((candidate) => candidate.run === olderRun.id)
    if (olderRow === undefined) throw new Error("missing older activity row")
    const allRuns = [...rejectedRuns, run]
    const olderActivity = createRenderer({ cols: 120, rows: 40 })(
      h(QueueDetailRunPrBlocks, {
        data: queueShowData(olderRun, allRuns),
        row: olderRow,
        rows: activityProjection.rows,
        prs: [lead],
        runDetails: allRuns.map((candidate) => queueShowData(candidate, allRuns)),
        titleAbove: true,
      }),
    )
    try {
      expect(olderActivity.text).toContain("r2 run main#58")
      expect(olderActivity.text, "an older-run selection still shows the PR's later activity").toContain(
        "r4 run main#60",
      )
    } finally {
      olderActivity.unmount()
    }
    const app = createRenderer({ cols: 200, rows: 70 })(h(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()

      const initialRows = app.text.split("\n")
      const tabsY = initialRows.findIndex((row) => row.includes("Changes") && row.includes("1: merge"))
      const prTabX = initialRows[tabsY]?.indexOf("Changes") ?? -1
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
      // ISSUE now legitimately renders as a KEY/value fact (operator spec item
      // 4.a moved it off the identity row) — see the ISSUE assertions below,
      // which pin its new uppercase KEY/value form for both batch members.
      expect(app.text).toContain("1: merge")
      // Run membership/timing still belongs to the real workflow-step tabs (the
      // "PRs pr#60.4...pr#61.1" summary line), not this tab. But the Changes tab
      // itself now lists EVERY batched member, each in its own box (operator spec
      // item 4) — not just the cursor's selected PR, as it did before.
      expect(app.text).not.toMatch(/PRs\s+pr#60\.4.*pr#61\.1/u)
      expect(app.text).not.toContain(`Committed as ${commit} on main`)
      expect(app.text).not.toMatch(/Started \d{2}:\d{2}:\d{2}, ended/u)
      expect(app.text).toContain("pr#60.4")
      const changesText = rows.map((row) => row.slice(detailX)).join("\n")
      expect(changesText, "the batch's other member gets its own box too").toContain("pr#61.1")
      expect(changesText).toContain(`${BRANCH_GLYPH} topic/pr61`)
      expect(changesText).toMatch(/ISSUE\s+@yrd\/core\/21525-queue-watch/u)
      expect(app.text).not.toContain("PR60.4")
      // The cursor's own PR (pr#60.4) skips repeating its id — the pane title
      // above already owns it — so its ISSUE now renders as a KEY/value fact
      // instead of riding the old identity+issue row.
      expect(app.text).toMatch(/ISSUE\s+@yrd\/core\/21514-detail-pane/u)
      expect(app.text).toContain(`${BRANCH_GLYPH} topic/pr60`)
      expect(app.text).not.toContain(`${BRANCH_GLYPH} topic/pr60 - @yrd/core/21514-detail-pane`)
      // Subject has no "- " prefix; description rows have no 2-space indent.
      expect(app.text).toContain("Lead title may wrap across the detail pane")
      expect(app.text).toContain("First description row")
      expect(app.text).toContain("Second description row may wrap")
      // note / correlation / requested reviewers / check-requested render as
      // uppercase KEY/value fact rows, not "- key: value" timeline entries.
      expect(app.text).toMatch(/NOTE\s+visual confirmation required/u)
      expect(app.text).toMatch(/CORRELATION\s+tribe:21514-round6-agent1/u)
      expect(app.text).toMatch(/REQUESTED REVIEWERS\s+@chief/u)
      expect(app.text).toMatch(/CHECK REQUESTED\s+\d{2}:\d{2}/u)
      expect(app.text).not.toMatch(/- check requested: \d{2}:\d{2}/u)
      // Timeline rows are bare (no leading "- "), strictly newest-first.
      expect(app.text).toMatch(/\d{2}:\d{2} r4 integrated \(age 11:00\)/u)
      expect(app.text).toMatch(/\d{2}:\d{2} r3 rejected \(err=visual-rejected — round-3 density was rejected\)/u)
      expect(app.text).toMatch(/\d{2}:\d{2} r2 rejected \(err=visual-rejected — round-2 hierarchy was rejected\)/u)
      expect(app.text).toMatch(/\d{2}:\d{2} r1 rejected \(err=mock-mismatch — round-1 detail layout was rejected\)/u)
      expect(app.text).toMatch(/\d{2}:\d{2} submitted by @ci/u)
      // Newest first (operator spec item 4: "reverse-chronological history").
      // "submitted by @ci" is r4's OWN submit event (10:30), which falls
      // between r4's 10:41 integration and r3's rejection the day before — so
      // by clock time the order is r4, submitted, r3, r2, r1, not r4..r1 then
      // submitted last.
      const r4Y = rows.findIndex((line) => line.includes("r4 integrated"))
      const submittedY = rows.findIndex((line) => line.includes("submitted by @ci"))
      const r3Y = rows.findIndex((line) => line.includes("r3 rejected"))
      const r2Y = rows.findIndex((line) => line.includes("r2 rejected"))
      const r1Y = rows.findIndex((line) => line.includes("r1 rejected"))
      expect(r4Y, "every history entry renders").toBeGreaterThanOrEqual(0)
      expect([r4Y, submittedY, r3Y, r2Y, r1Y], "history renders newest clock time first").toEqual(
        [r4Y, submittedY, r3Y, r2Y, r1Y].toSorted((left, right) => left - right),
      )
      expect(app.text).toContain(`▶️ Diff +324 / -323 ${["li", "nes"].join("")}`)
      expect(app.text).not.toContain("src/detail-pane.tsx")
      expect(app.text).not.toContain("click to expand")

      const branchY = rows.findIndex((row) => row.slice(detailX).includes(`${BRANCH_GLYPH} topic/pr60`))
      const branchX = branchGlyphColumn(app, branchY)
      const branchTextX = branchX + 2
      expect(app.cell(branchX, branchY).fg, "branch marker inherits its branch-row foreground").toEqual(
        app.cell(branchTextX, branchY).fg,
      )
      expect(app.cell(branchX, branchY).dim).toBe(true)

      const prY = rows.findIndex((row) => row.slice(detailX).includes("pr#60.4"))
      const prX = rows[prY]?.indexOf("pr#60.4") ?? -1
      // Skip the item-2 PR-list row above the tabs — it ALSO shows this bold
      // title (next to "pr#60.4"), so anchor on the per-change box's own
      // title-only line instead (nothing else shares that row).
      const titleBlockY = rows.findIndex(
        (row) => row.slice(detailX).includes("Lead title may wrap") && !row.includes("pr#60.4"),
      )
      const titleX = rows[titleBlockY]?.indexOf("Lead title") ?? -1
      const bodyY = rows.findIndex((row) => row.slice(detailX).includes("First description row"))
      const bodyX = rows[bodyY]?.indexOf("First description row") ?? -1
      expect(app.cell(prX, prY).fg).not.toEqual(app.cell(branchTextX, branchY).fg)
      expect(app.cell(prX, prY).bold).not.toBe(true)
      expect(app.cell(prX + 3, prY).bold).toBe(true)
      expect(app.cell(prX + 5, prY).bold).not.toBe(true)
      expect(app.cell(titleX, titleBlockY).bold).toBe(true)
      expect(app.cell(bodyX, bodyY).bold).not.toBe(true)

      const diff = pointOf(app.text, `Diff +324 / -323 ${["li", "nes"].join("")}`)
      const collapsedRows = app.text.split("\n")
      // Each change now sits inside its own box (operator spec item 4), so the
      // rows immediately above/below the diff summary carry that box's own
      // left/right border ("│") at the detailX offset — strip border chars
      // too, not just whitespace, to check for "no content" rather than "no
      // characters at all".
      const blank = (row: string | undefined) => (row?.slice(detailX) ?? "").replace(/[│\s]/gu, "")
      expect(blank(collapsedRows[diff[1] - 1]), "blank row above the diff summary").toBe("")
      expect(blank(collapsedRows[diff[1] + 1]), "blank row below the diff summary").toBe("")
      expect(
        collapsedRows.slice(diff[1] + 1, diff[1] + 4).some((row) => row.slice(detailX).includes("─")),
        "a horizontal divider terminates the PR diff section",
      ).toBe(true)
      await app.click(diff[0], diff[1])
      await app.waitForLayoutStable()
      expect(app.text).toContain("src/detail-pane.tsx")
      expect(app.text).toContain("+new detail")
      // The fold marker flips collapsed->expanded (▶->▼) in place.
      expect(app.text).toContain(`▼ Diff +324 / -323 ${["li", "nes"].join("")}`)
      expect(app.text).not.toContain(`▶️ Diff +324 / -323 ${["li", "nes"].join("")}`)

      const expandedPatch = pointOf(app.text, "+new detail")
      await app.click(expandedPatch[0], expandedPatch[1])
      await app.waitForLayoutStable()
      expect(app.text).not.toContain("src/detail-pane.tsx")
      app.focus("queue-submit-diff-PR60-4")
      await app.waitForLayoutStable()
      await app.press("Enter")
      await app.waitForLayoutStable()
      expect(app.text).toContain("src/detail-pane.tsx")

      const mergeTab = pointOf(app.text, "1: merge")
      await app.click(mergeTab[0], mergeTab[1])
      await app.waitForLayoutStable()
      expect(app.text).toMatch(/PRs\s+pr#60\.4.*pr#61\.1/u)
      expect(app.text).toMatch(
        /Started \d{2}:\d{2}:\d{2}, ended \d{2}:\d{2}:\d{2} \(total \d+:\d{2}, wait (?:0|\d+:\d{2})\)/u,
      )
      expect(app.text).toContain(`COMMIT ${commit}`)
      // The merge tab's step content (below the tab bar) carries the run-level
      // COMMIT/PARENTS, never a repeated PR-id block — the pr#id now lives only in
      // the persistent identity title above the tabs.
      // Row 0 is the watch pane's own top line (item 12, always present) and
      // carries no divider; the SplitPane content starts one row lower.
      const divider = app.text.split("\n")[1]?.indexOf("│") ?? -1
      const stepRows = app.text.split("\n")
      const mergeTabRow = stepRows.findIndex((row) => row.includes("1: merge"))
      const mergeDetail = stepRows
        .slice(mergeTabRow)
        .map((row) => row.slice(divider + 1))
        .join("\n")
      expect(mergeDetail.match(/pr#60\.4/gu)).toHaveLength(1)
      expect(mergeDetail).not.toContain("topic/pr60")
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
      submitter: "@agent/8",
      revisions: [
        {
          revision: 1,
          headSha: head1,
          base: "main",
          baseSha: "a".repeat(40),
          pushedAt: "2026-07-13T11:03:00.000Z",
          submittedAt: "2026-07-13T11:03:00.000Z",
          submitter: "@agent/8",
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
          submitter: "@agent/8",
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
          submitter: "@agent/8",
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
    // Tall enough that both batch members' full boxes (facts + diff) render
    // without scrolling — the Changes tab now lists every member (operator
    // spec item 4), not just the cursor's, so both reasons show at once.
    const app = createRenderer({ cols: 200, rows: 90 })(h(QueueWatchFrame, { snapshot: { ...snapshot, diffs } }))
    try {
      await app.waitForLayoutStable()
      // The running `check` step is selected initially. Move left through
      // `prepare` to the Changes tab before asserting the diff reasons.
      await app.press("h")
      await app.press("h")
      await app.waitForLayoutStable()
      // Each member's unavailable reason is read from that member's own box:
      // git error on the first member, pruned refs on the second — both
      // visible together now that every batch member gets its own box.
      expect(app.text).toContain("diff unavailable (git error)")
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
      expect(statusRow).toMatch(/◌ passed\s+\d+(?:m(?:\d+s)?|s)/u)
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
      const checkTab = pointOf(app.text, "2: check")
      await app.click(checkTab[0], checkTab[1])
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      const jobY = rows.findIndex((row) => row.includes("JOB") && row.includes("yrd#J42-check"))
      const commandY = rows.findIndex((row) => row.includes("$ bun vitest run"))
      const outputY = rows.findIndex((row) => row.includes("125 tests collected"))

      expect(jobY).toBeGreaterThanOrEqual(0)
      expect(commandY).toBeGreaterThan(jobY)
      expect(outputY).toBeGreaterThan(commandY)
      // Row 0 is the watch pane's own top line (item 12, always present) and
      // carries no divider; the SplitPane content starts one row lower.
      const divider = rows[1]?.indexOf("│") ?? -1
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
      expect(app.cell(jobLabelX, jobY).bold).toBe(true)
      expect(app.cell(jobIdX, jobY).bold).toBe(true)
      expect(rows[jobY], "the pane-header issue is not repeated beside JOB").not.toContain(
        "@hab/super/21135-herdr-keybindings",
      )
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
      await app.press("h")
      await app.press("h")
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
      { kind: "merge" },
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
