// @failure Draft PRs (pushed, never submitted) vanish from the watch/queue-status timeline, breaking the WIP census
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
// The draft's registration and the queued PR's submission share one instant, so
// their relative order is decided purely by group precedence (draft above todo)
// and never by the timeline's local-calendar-day grouping — keeping the ordering
// assertion timezone-independent.
const REGISTERED_AT = "2026-07-13T10:00:00.000Z"

/** A registered-but-unsubmitted PR: bay status `pushed`, no `submittedAt`. */
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

/** A queued PR: bay status `submitted`, waiting for a run. */
function queuedPr(): PR {
  const headSha = "3".repeat(40)
  return {
    id: "PR3",
    name: "Queued change",
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

describe("queue timeline draft rows", () => {
  it("surfaces a draft PR as a distinct `draft` row above the queued todo, leaving the queued row unchanged", () => {
    const projection = project([draftPr(), queuedPr()])
    const draftRow = projection.rows.find((row) => row.pr === "PR7")
    const queuedRow = projection.rows.find((row) => row.pr === "PR3")

    // The draft is present with the display-only draft status/group and its own hollow glyph.
    expect(draftRow).toBeDefined()
    expect(draftRow?.status).toBe("draft")
    expect(draftRow?.group).toBe("draft")
    expect(draftRow?.glyph).toBe("◌")
    // A draft is pre-queue WIP: no run id and no queue position.
    expect(draftRow?.run).toBeUndefined()
    expect(draftRow?.position).toBeUndefined()
    // BY is the revision author; AGE is measured from registration (pushedAt).
    expect(draftRow?.submitter).toBe("alice@example.test")
    expect(draftRow?.ageMs).toBe(NOW - Date.parse(REGISTERED_AT))
    expect(draftRow?.queueWaitMs).toBeNull()
    expect(draftRow?.totalMs).toBeNull()

    // The queued PR keeps its existing pending/todo projection untouched.
    expect(queuedRow?.status).toBe("pending")
    expect(queuedRow?.group).toBe("pending")
    expect(queuedRow?.glyph).toBe("○")
    expect(queuedRow?.submitter).toBe("bob@example.test")

    // The draft group sorts above the queued todo row.
    const draftIndex = projection.rows.findIndex((row) => row.pr === "PR7")
    const queuedIndex = projection.rows.findIndex((row) => row.pr === "PR3")
    expect(draftIndex).toBeGreaterThanOrEqual(0)
    expect(draftIndex).toBeLessThan(queuedIndex)
  })

  it("shows drafts under the default view and the todo bucket, and hides them when todo is toggled off", () => {
    const projection = project([draftPr(), queuedPr()])
    const draftVisible = (buckets?: ReadonlySet<QueueTimelineStatusBucket>) =>
      queueTimelineVisibleRows(projection, buckets, true).some((row) => row.pr === "PR7")

    // A draft buckets with `todo` — no fifth operator pill.
    expect(queueTimelineStatusBucket("draft")).toBe("pending")
    // The default watch view (no bucket filter) surfaces the draft.
    expect(draftVisible(undefined)).toBe(true)
    // The `todo` pill alone keeps it; toggling `todo` off (leaving the other
    // three buckets) hides it, exactly as it does the queued todo row.
    expect(draftVisible(new Set<QueueTimelineStatusBucket>(["pending"]))).toBe(true)
    expect(draftVisible(new Set<QueueTimelineStatusBucket>(["running", "failed", "done"]))).toBe(false)
  })

  it("keeps drafts display-only: they never become open-queue or terminal FLOW facts", () => {
    const projection = project([draftPr()])
    // Exactly one row, and it is the draft.
    expect(projection.rows).toHaveLength(1)
    expect(projection.rows[0]?.status).toBe("draft")
    // A draft is not open-queue work, so the DRAIN gauge stays null...
    expect(projection.oldestOpenMs).toBeNull()
    // ...and it contributes no terminal attempts or outcome counts to the FLOW stats.
    expect(projection.metrics.terminalAttempts).toBe(0)
    expect(projection.metrics.outcomes.integrated).toBe(0)
    expect(projection.metrics.throughput.landed).toBe(0)
  })
})
