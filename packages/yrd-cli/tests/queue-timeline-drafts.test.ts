// @failure Non-integrated PRs (draft/revising/submitted) vanish from the watch/status timeline, breaking the WIP census
// @level l2
// @consumer @yrd/cli

import type { PR } from "@yrd/bay"
import { describe, expect, it } from "vitest"
import {
  QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS,
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
 * failed submission in its revision history → derived status `revising`. */
function revisingPr(): PR {
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

function result(prs: readonly PR[]): QueueStatusResult {
  return { base: "main", running: [], waiting: [], finished: [], prs: [...prs] }
}

function project(prs: readonly PR[]) {
  const results = [result(prs)]
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

describe("queue timeline non-integrated rows", () => {
  it("labels a clean pushed PR as `draft`, above the submitted rows, with a hollow glyph", () => {
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

    // Draft (group "draft") sorts above the submitted todo row (group "pending").
    const draftIndex = projection.rows.findIndex((row) => row.pr === "PR7")
    const submittedIndex = projection.rows.findIndex((row) => row.pr === "PR3")
    expect(draftIndex).toBeGreaterThanOrEqual(0)
    expect(draftIndex).toBeLessThan(submittedIndex)
  })

  it("labels a re-pushed PR with failed-submission history as `revising` (warn/hollow, editable)", () => {
    const projection = project([revisingPr()])
    const revisingRow = projection.rows.find((row) => row.pr === "PR5")

    expect(revisingRow?.status).toBe("revising")
    expect(revisingRow?.group).toBe("draft")
    expect(revisingRow?.glyph).toBe("◌")
    // No retained run for the prior rejection here, so the detail degrades to the
    // bare `revising` label (it grows a `· <slug>` annotation when the run survives).
    expect(revisingRow?.detail).toBe("revising")
    expect(revisingRow?.run).toBeUndefined()
    expect(revisingRow?.position).toBeUndefined()
    // AGE anchors on the CURRENT (re-pushed) revision's registration.
    expect(revisingRow?.submitter).toBe("carol@example.test")
    expect(revisingRow?.ageMs).toBe(NOW - Date.parse(REGISTERED_AT))
  })

  it("labels a submitted-but-unqueued PR as `submitted`, keeping its queue position and wait", () => {
    const projection = project([submittedPr()])
    const submittedRow = projection.rows.find((row) => row.pr === "PR3")

    expect(submittedRow?.status).toBe("submitted")
    expect(submittedRow?.group).toBe("pending")
    expect(submittedRow?.glyph).toBe("○")
    expect(submittedRow?.submitter).toBe("bob@example.test")
    // A submitted PR keeps the queue position and non-null queue wait it always had.
    expect(submittedRow?.position).toBe(1)
    expect(submittedRow?.detail).toBe("position 1")
    expect(submittedRow?.queueWaitMs).toBe(NOW - Date.parse(REGISTERED_AT))
  })

  it("shows every pre-run status under the default view and the todo bucket, hidden when todo is off", () => {
    const projection = project([draftPr(), revisingPr(), submittedPr()])
    const visiblePrs = (buckets?: ReadonlySet<QueueTimelineStatusBucket>) =>
      new Set(queueTimelineVisibleRows(projection, buckets, true).map((row) => row.pr))

    // Every pre-run status buckets with `todo` — no new operator pill.
    for (const status of ["draft", "revising", "submitted"] as const) {
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
    // Draft + revising are pure WIP: no open-queue age, no terminal facts.
    const wip = project([draftPr(), revisingPr()])
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
