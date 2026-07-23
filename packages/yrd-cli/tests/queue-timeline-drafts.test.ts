// @failure Non-integrated PRs (draft/rev/ready) vanish from the watch/status timeline, breaking the WIP census
// @level l2
// @consumer @yrd/cli

import type { PR } from "@yrd/bay"
import type { QueueRun } from "@yrd/queue"
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import {
  QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS,
  QueueTimelineView,
  queueTimelineAdmissionTimes,
  queueTimelineProjection,
  queueTimelineStatusBucket,
  queueTimelineVisibleRows,
  type QueueStatusResult,
  type QueueTimelineProjectionOptions,
  type QueueTimelineStatusBucket,
} from "../src/queue-status-view.tsx"

const BASE_SHA = "a".repeat(40)
const NOW = Date.parse("2026-07-13T12:00:00.000Z")
// Every pre-run PR shares one registration/submission instant, so row order is
// decided purely by group precedence (the draft group above the pending group)
// and never by the timeline's local-calendar-day grouping — keeping the ordering
// assertion timezone-independent.
const REGISTERED_AT = "2026-07-13T10:00:00.000Z"

/** A registered-but-unsubmitted PR: bay status `pushed`, no failure history. */
function draftPr(): PR {
  const headSha = "7".repeat(40)
  return {
    id: "PR7",
    name: "Draft change",
    branch: "topic/pr7",
    base: "main",
    status: "pushed",
    revision: 1,
    headSha,
    baseSha: BASE_SHA,
    revisions: [
      { revision: 1, headSha, base: "main", baseSha: BASE_SHA, pushedAt: REGISTERED_AT, actor: "alice@example.test" },
    ],
    reviews: [],
    comments: [],
    checkRequests: [],
  }
}

/** A re-pushed PR whose prior submission was rejected: bay status `pushed` with a
 * failed submission in its revision history → derived display status `rev`. */
function revisionPr(): PR {
  const headSha = "5".repeat(40)
  const priorHeadSha = "4".repeat(40)
  return {
    id: "PR5",
    name: "Revising change",
    branch: "topic/pr5",
    base: "main",
    status: "pushed",
    revision: 2,
    headSha,
    baseSha: BASE_SHA,
    revisions: [
      {
        revision: 1,
        headSha: priorHeadSha,
        base: "main",
        baseSha: BASE_SHA,
        pushedAt: "2026-07-13T08:00:00.000Z",
        submittedAt: "2026-07-13T08:05:00.000Z",
        actor: "carol@example.test",
        terminal: { status: "rejected", at: "2026-07-13T09:00:00.000Z", run: "R9" },
      },
      { revision: 2, headSha, base: "main", baseSha: BASE_SHA, pushedAt: REGISTERED_AT, actor: "carol@example.test" },
    ],
    reviews: [],
    comments: [],
    checkRequests: [],
  }
}

/** A submitted PR awaiting its run: bay status `submitted`. */
function submittedPr(): PR {
  const headSha = "3".repeat(40)
  return {
    id: "PR3",
    name: "Submitted change",
    branch: "topic/pr3",
    base: "main",
    status: "submitted",
    revision: 1,
    headSha,
    baseSha: BASE_SHA,
    revisions: [
      {
        revision: 1,
        headSha,
        base: "main",
        baseSha: BASE_SHA,
        pushedAt: REGISTERED_AT,
        submittedAt: REGISTERED_AT,
        actor: "bob@example.test",
      },
    ],
    submittedAt: REGISTERED_AT,
    reviews: [],
    comments: [],
    checkRequests: [],
  }
}

function result(prs: readonly PR[], finished: readonly QueueRun[] = []): QueueStatusResult {
  return { base: "main", running: [], waiting: [], finished: [...finished], prs: [...prs] }
}

function project(prs: readonly PR[], finished: readonly QueueRun[] = []) {
  const results = [result(prs, finished)]
  const options: QueueTimelineProjectionOptions = {
    now: NOW,
    windowMs: QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS,
    statuses: [],
    terms: [],
    latest: false,
    rowLimit: 100,
    submissionTimes: queueTimelineAdmissionTimes(results),
    base: "main",
  }
  return queueTimelineProjection(results, options)
}

function rejectedRun(): QueueRun {
  return {
    id: "R9",
    prs: [
      {
        id: "PR5",
        branch: "topic/pr5",
        base: "main",
        revision: 1,
        headSha: "4".repeat(40),
        baseSha: BASE_SHA,
      },
    ],
    base: "main",
    steps: [],
    startedAt: "2026-07-13T08:30:00.000Z",
    cursor: 0,
    status: "failed",
    shape: { results: {} },
    finishedAt: "2026-07-13T09:00:00.000Z",
    error: { code: "typecheck-failed", message: "payload does not typecheck" },
  }
}

describe("queue timeline non-integrated rows", () => {
  it("labels a clean pushed PR as `draft`, above the ready rows, with a hollow glyph", () => {
    const projection = project([draftPr(), submittedPr()])
    const draftRow = projection.rows.find((row) => row.pr === "PR7")

    expect(draftRow?.status).toBe("draft")
    expect(draftRow?.group).toBe("draft")
    expect(draftRow?.glyph).toBe("◌")
    expect(draftRow?.detail).toBe("draft")
    // A draft is pre-queue WIP: no run id and no queue position.
    expect(draftRow?.run).toBeUndefined()
    expect(draftRow?.position).toBeUndefined()
    // BY is the revision author; AGE is measured from registration (pushedAt).
    expect(draftRow?.submitter).toBe("alice@example.test")
    expect(draftRow?.ageMs).toBe(NOW - Date.parse(REGISTERED_AT))
    expect(draftRow?.queueWaitMs).toBeNull()

    // Draft (group "draft") sorts above the ready row (group "pending").
    const draftIndex = projection.rows.findIndex((row) => row.pr === "PR7")
    const readyIndex = projection.rows.findIndex((row) => row.pr === "PR3")
    expect(draftIndex).toBeGreaterThanOrEqual(0)
    expect(draftIndex).toBeLessThan(readyIndex)
  })

  it("labels a re-pushed PR with failed-submission history as `rev` (needs-author/error, editable)", async () => {
    const projection = project([draftPr(), revisionPr(), submittedPr()])
    const revRow = projection.rows.find((row) => row.pr === "PR5")

    expect(revRow?.status).toBe("rev")
    expect(revRow?.group).toBe("draft")
    expect(revRow?.glyph).toBe("×")
    // No retained run for the prior rejection here, so the detail degrades to the
    // bare `rev` label (it grows a `· <slug>` annotation when the run survives).
    expect(revRow?.detail).toBe("rev")
    expect(revRow?.run).toBeUndefined()
    expect(revRow?.position).toBeUndefined()
    // AGE anchors on the CURRENT (re-pushed) revision's registration.
    expect(revRow?.submitter).toBe("carol@example.test")
    expect(revRow?.ageMs).toBe(NOW - Date.parse(REGISTERED_AT))

    const app = createRenderer({ cols: 120, rows: 30 })(createElement(QueueTimelineView, { projection, columns: 120 }))
    try {
      await app.waitForLayoutStable()
      expect(app.text).toContain("× rev")
      expect(app.text).not.toContain("revising")

      const statusFg = (pr: string, status: string) => {
        const rows = app.text.split("\n")
        const y = rows.findIndex((row) => row.includes(pr))
        const row = rows[y]
        if (row === undefined) throw new Error(`missing rendered row for ${pr}`)
        const x = row.indexOf(status)
        if (x < 0) throw new Error(`missing status '${status}' on ${pr} row`)
        return app.cell(x, y).fg
      }
      const revFg = statusFg("pr#5.2", "rev")
      expect(revFg, "rev uses its own warning treatment, not draft muted").not.toEqual(statusFg("pr#7.1", "draft"))
      expect(revFg, "rev uses its own warning treatment, not ready info").not.toEqual(statusFg("pr#3.1", "ready"))
    } finally {
      app.unmount()
    }
  })

  it("annotates a retained failed submission without double-counting terminal FLOW facts", () => {
    const projection = project([revisionPr()], [rejectedRun()])
    const revRow = projection.rows.find((row) => row.pr === "PR5" && row.status === "rev")

    expect(revRow?.detail).toBe("rev · typecheck-failed")
    expect(projection.metrics.terminalAttempts).toBe(1)
    expect(projection.oldestOpenMs).toBeNull()
  })

  it("labels a submitted-but-unqueued PR as `ready`, keeping its queue position and wait", () => {
    const projection = project([submittedPr()])
    const readyRow = projection.rows.find((row) => row.pr === "PR3")

    expect(readyRow?.status).toBe("ready")
    expect(readyRow?.group).toBe("pending")
    expect(readyRow?.glyph).toBe("○")
    expect(readyRow?.submitter).toBe("bob@example.test")
    // A submitted PR keeps the queue position and non-null queue wait it always had.
    expect(readyRow?.position).toBe(1)
    expect(readyRow?.detail).toBe("position 1")
    expect(readyRow?.queueWaitMs).toBe(NOW - Date.parse(REGISTERED_AT))
  })

  it("shows every pre-run status under the default view and the todo bucket, hidden when todo is off", () => {
    const projection = project([draftPr(), revisionPr(), submittedPr()])
    const visiblePrs = (buckets?: ReadonlySet<QueueTimelineStatusBucket>) =>
      new Set(queueTimelineVisibleRows(projection, buckets, true).map((row) => row.pr))

    // Every pre-run status buckets with `todo` — no new operator pill.
    for (const status of ["draft", "rev", "ready"] as const) {
      expect(queueTimelineStatusBucket(status)).toBe("pending")
    }
    // The default view (no bucket filter) surfaces all three.
    expect(visiblePrs(undefined)).toEqual(new Set(["PR7", "PR5", "PR3"]))
    // The `todo` pill alone keeps them; toggling `todo` off (the other three
    // buckets) hides all three.
    expect(visiblePrs(new Set<QueueTimelineStatusBucket>(["pending"]))).toEqual(new Set(["PR7", "PR5", "PR3"]))
    expect(visiblePrs(new Set<QueueTimelineStatusBucket>(["running", "failed", "done"])).size).toBe(0)
  })

  it("keeps pre-run rows display-only: they never become terminal FLOW facts", () => {
    // Draft + rev are pure WIP: no open-queue age, no terminal facts.
    const wip = project([draftPr(), revisionPr()])
    expect(wip.oldestOpenMs).toBeNull()
    expect(wip.metrics.terminalAttempts).toBe(0)
    expect(wip.metrics.outcomes.integrated).toBe(0)
    expect(wip.metrics.throughput.landed).toBe(0)

    // A submitted PR is open-queue work (it drives the DRAIN gauge) but still
    // contributes no terminal FLOW fact.
    const submitted = project([submittedPr()])
    expect(submitted.oldestOpenMs).toBe(NOW - Date.parse(REGISTERED_AT))
    expect(submitted.metrics.terminalAttempts).toBe(0)
  })
})
