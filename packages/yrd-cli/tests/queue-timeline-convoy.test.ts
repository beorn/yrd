// @failure A co-landed PR renders as a row of dashes, indistinguishable from one that was never attempted
// @level l2
// @consumer @yrd/cli

import type { PR } from "@yrd/bay"
import { createElement } from "react"
import { renderString } from "silvery"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureRun, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { projectedChangeStatus, QueueTimelineView, type QueueTimelineProjection } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const SUBMITTED_AT = "2026-07-13T11:30:00.000Z"
const LANDED_AT = "2026-07-13T11:45:00.000Z"

/** The R2649 specimen: three PRs admitted together and landed by ONE run. */
const CONVOY = ["PR151", "PR152", "PR153"] as const
const CONVOY_BRANCHES = CONVOY.map((id) => `topic/${id.toLocaleLowerCase()}`)

/**
 * The dash signature of the reported defect: a row whose TIME, STATUS and RUN
 * cells all render `-`, which is simultaneously how a merged convoy member and
 * a never-attempted PR print. Anchored at the row start so it cannot match a
 * legitimately empty duration cell further right.
 */
const DASH_ROW = /^-\s+-\s+-\s/u

function convoySnapshot(): ReturnType<typeof fixtureSnapshot> {
  const prs = CONVOY.map((id) =>
    fixturePr(id, "integrated", SUBMITTED_AT, `Convoy ${id}`, { integratedAt: LANDED_AT, submitter: "@chief" }),
  )
  const run = fixtureRun("R2649", prs, "passed", SUBMITTED_AT, { finishedAt: LANDED_AT })
  return fixtureSnapshot(fixtureResult(prs, [run]))
}

/** A PR withdrawn AFTER a refusal was recorded against it. `PR.needsAuthor` has
 * no clearing path through withdrawn/integrated/canceled, so the refusal
 * outlives the close — the pr#1073 specimen. */
function withdrawnAfterRefusal(): PR {
  return {
    ...fixturePr("PR1073", "withdrawn", SUBMITTED_AT, "Withdrawn change", { withdrawnAt: LANDED_AT }),
    needsAuthor: {
      at: "2026-07-13T11:35:00.000Z",
      run: "R2600",
      step: "typecheck",
      receipt: { code: "typecheck", message: "tsc --noEmit reported 3 errors" },
    },
  }
}

async function timelineRows(projection: QueueTimelineProjection, width = 160): Promise<string[]> {
  const rendered = await renderString(createElement(QueueTimelineView, { projection, columns: width }), {
    width,
    height: 45,
    plain: true,
  })
  return rendered.split("\n").map((row) => row.trimEnd())
}

function rowFor(rows: readonly string[], needle: string): string {
  const row = rows.find((candidate) => candidate.includes(needle))
  if (row === undefined) throw new Error(`expected a rendered row containing '${needle}'`)
  return row.trimStart()
}

describe("convoy visibility — every member of a co-landing renders its own outcome", () => {
  it("lands three PRs in one run and renders all three as merged", async () => {
    const rows = await timelineRows(convoySnapshot().projection)

    for (const branch of CONVOY_BRANCHES) {
      const row = rowFor(rows, branch)
      expect(row, branch).toContain("merged")
      expect(row, branch).not.toMatch(DASH_ROW)
    }
  })

  it("gives every convoy member its own landing run, not just the lead", async () => {
    const rows = await timelineRows(convoySnapshot().projection)

    for (const branch of CONVOY_BRANCHES) {
      expect(rowFor(rows, branch), branch).toContain("#2649")
    }
  })

  it("gives every convoy member its own TIME cell rather than a placeholder dash", async () => {
    const snapshot = convoySnapshot()
    const rows = await timelineRows(snapshot.projection)
    // The projection carries a timestamp for EVERY member; the defect was the
    // renderer discarding it, so derive the expectation from the projection
    // rather than from a hardcoded clock (which would be timezone-fragile).
    const members = snapshot.projection.rows.filter((row) => row.run === "R2649")
    expect(members).toHaveLength(3)

    for (const member of members) {
      expect(member.timestamp, member.pr).not.toBeNull()
      expect(rowFor(rows, member.branch), member.pr).not.toMatch(/^-\s/u)
    }
  })

  it("shows the whole convoy through `yrd watch`, which shares the timeline renderer", async () => {
    const app = createRenderer({ cols: 200, rows: 50 })(createElement(QueueWatchFrame, { snapshot: convoySnapshot() }))
    try {
      await app.waitForLayoutStable()
      const rows = app.text.split("\n").map((row) => row.trimEnd())

      for (const branch of CONVOY_BRANCHES) {
        const row = rowFor(rows, branch)
        expect(row, branch).toContain("merged")
        expect(row, branch).not.toMatch(DASH_ROW)
      }
    } finally {
      app.unmount()
    }
  })
})

describe("withdrawn PRs — a stale refusal never outranks a settled close", () => {
  it("never renders a withdrawn PR as rev, however stale its needsAuthor refusal", async () => {
    const pr = withdrawnAfterRefusal()
    // The sibling projection already reads the close first; the timeline's
    // pre-run status is the one that did not.
    expect(projectedChangeStatus(pr)).toBe("withdrawn")

    const snapshot = fixtureSnapshot(fixtureResult([pr], []))
    expect(snapshot.projection.rows.map((row) => row.status)).not.toContain("rev")

    const rows = await timelineRows(snapshot.projection)
    expect(rows.some((row) => row.includes("topic/pr1073"))).toBe(false)
  })
})
