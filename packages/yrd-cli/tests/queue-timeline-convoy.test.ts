// @failure A co-merged PR renders as a row of dashes, indistinguishable from one that was never attempted
// @level l2
// @consumer @yrd/cli

import type { Change } from "@yrd/bay"
import { createElement } from "react"
import { renderString } from "silvery"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureRun, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { projectedChangeStatus, QueueTimelineView, type QueueTimelineProjection } from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const SUBMITTED_AT = "2026-07-13T11:30:00.000Z"
const MERGED_AT = "2026-07-13T11:45:00.000Z"

/** The R2649 specimen: three PRs admitted together and merged by ONE run. */
const CONVOY = ["PR151", "PR152", "PR153"] as const
const CONVOY_TITLES = CONVOY.map((id) => `Convoy ${id}`)

/**
 * The dash signature of the reported defect: a row whose TIME, STATUS and RUN
 * cells all render `-`, which is simultaneously how a merged convoy member and
 * a never-attempted PR print. Anchored at the row start so it cannot match a
 * legitimately empty duration cell further right.
 */
const DASH_ROW = /^-\s+-\s+-\s/u

function convoySnapshot(): ReturnType<typeof fixtureSnapshot> {
  const prs = CONVOY.map((id) =>
    fixturePr(id, "integrated", SUBMITTED_AT, `Convoy ${id}`, { integratedAt: MERGED_AT, submitter: "@chief" }),
  )
  const run = fixtureRun("R2649", prs, "passed", SUBMITTED_AT, { finishedAt: MERGED_AT })
  return fixtureSnapshot(fixtureResult(prs, [run]))
}

/** A PR withdrawn AFTER a refusal was recorded against it. `PR.needsAuthor` has
 * no clearing path through withdrawn/integrated/canceled, so the refusal
 * outlives the close — the pr#1073 specimen. */
function withdrawnAfterRefusal(): Change {
  return {
    ...fixturePr("PR1073", "withdrawn", SUBMITTED_AT, "Withdrawn change", { withdrawnAt: MERGED_AT }),
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

describe("convoy visibility — every member of a co-merge renders its own outcome", () => {
  it("merges three PRs in one run and renders all three as merged", async () => {
    const rows = await timelineRows(convoySnapshot().projection)

    for (const title of CONVOY_TITLES) {
      const row = rowFor(rows, title)
      expect(row, title).toContain("merged")
      expect(row, title).not.toMatch(DASH_ROW)
    }
  })

  it("marks every convoy member's shared run — id on the lead, membership dots behind it", async () => {
    // Item 38 reshaped the RUN cell: the id renders bright on the FIRST
    // member row and the rest carry a muted `·` continuation. The 22925
    // defect stays impossible: every member row keeps its own TIME and
    // merged STATUS, so a merged member can never print as the dash row a
    // never-attempted PR prints.
    const rows = await timelineRows(convoySnapshot().projection)
    const memberRows = CONVOY_TITLES.map((title) => rowFor(rows, title))
    const withRunId = memberRows.filter((row) => row.includes("#2649"))
    expect(withRunId, "exactly one member row spells the shared run id").toHaveLength(1)
    for (const row of memberRows) {
      expect(row).toContain("✓ merged")
      expect(row).not.toMatch(DASH_ROW)
    }
    const continuations = memberRows.filter((row) => !row.includes("#2649"))
    expect(continuations).toHaveLength(2)
    for (const row of continuations) {
      expect(row, "membership continuation dot").toMatch(/merged\s+·\s/u)
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
      expect(rowFor(rows, member.subject), member.pr).not.toMatch(/^-\s/u)
    }
  })

  it("shows the whole convoy through `yrd watch`, which shares the timeline renderer", async () => {
    const app = createRenderer({ cols: 200, rows: 50 })(createElement(QueueWatchFrame, { snapshot: convoySnapshot() }))
    try {
      await app.waitForLayoutStable()
      // The split panes share terminal lines and the DETAIL side names the
      // members too (change list + boxes) — scope to the LEFT half.
      const frame = app.text.split("\n")
      const divider = (frame[1] ?? "").indexOf("│")
      expect(divider).toBeGreaterThan(0)
      const rows = frame.map((row) => row.slice(0, divider).trimEnd())

      for (const title of CONVOY_TITLES) {
        const row = rowFor(rows, title)
        expect(row, title).toContain("merged")
        expect(row, title).not.toMatch(DASH_ROW)
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
