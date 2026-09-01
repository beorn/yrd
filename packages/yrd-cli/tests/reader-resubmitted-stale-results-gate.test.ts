/**
 * @failure A change re-submitted over stale results — the documented remedy
 * when a run consumes a change's submit authority — leaves a revision whose
 * `submittedAt` was rewritten FORWARD past the terminal fact, and the check
 * results behind it, that an earlier settle left in place. Every projection
 * that measured an age from that submit start to that stale finish computed a
 * NEGATIVE duration and threw, and the throw escaped the whole read.
 *
 * Measured live 2026-09-01 on yrd 0.0.1+caacf98e21, change 'PR2749'
 * (task/w28-silentsites, sha b3e5141d) re-submitted at 18:40:25Z over a
 * 2026-08-30T22:56Z settle against the now-dead run R3675:
 *
 *   yrd watch --repo dev   -> died: "change 'PR2749' source-ready age
 *                             finish '2026-08-30T22:56:44.041Z' precedes
 *                             start '2026-09-01T18:40:25.870Z'"
 *   yrd pr list --json     -> exit 3, EMPTY stdout for all 2275 rows:
 *                             "submitted-to-terminal age finish
 *                             '2026-08-30T22:56:51Z' precedes start
 *                             '2026-09-01T18:40:25Z'"
 *   yrd queue list         -> survived only because its 20-row text window
 *                             never reached that row.
 *
 * `yrd pr list --json` fell over on the HUMAN projection: `listPrs` builds
 * `changeListRows(...)` eagerly as a call argument, so the machine-readable
 * path evaluates it even when it will never render it.
 * @level l2
 * @consumer @yrd/cli every `yrd watch`, `yrd pr list` and `yrd queue list` operator
 *
 * WHAT IS PINNED. One rule, applied at every surface: a finish that precedes
 * its own start belongs to a PREVIOUS admission of the same sha, so the
 * current admission has no finish yet and the change reads PENDING — never a
 * negative age, and never an abort. `currentAdmissionFinish` is the single
 * home for that judgement; the per-row containment behind it is pinned by
 * {@link ./reader-watch-source-ready-age-gate.test.ts}.
 */
import { describe, expect, it } from "vitest"
import type { Change } from "@yrd/bay"
import type { BaysState } from "@yrd/bay"
import { currentAdmissionFinish, type ChangeEligibility } from "@yrd/queue"

import {
  changeListRows,
  humanQueueProjection,
  queueTimelineProjection,
  type QueueStatusResult,
} from "../src/queue-status-view.tsx"

const CHANGE = "PR2749"
const HEAD = `b3e5141d${"0".repeat(32)}`
const BASE_SHA = "a".repeat(40)
const PUSHED_AT = "2026-08-30T21:00:00.000Z"
/** The stale settle the dead run R3675 left behind. */
const TERMINAL_AT = "2026-08-30T22:56:51.000Z"
/** The re-submission that rewrote the submit fact forward past it. */
const RESUBMITTED_AT = "2026-09-01T18:40:25.870Z"
const NOW = Date.parse("2026-09-01T19:00:00.000Z")
const NO_BAYS: BaysState = { byId: {}, prs: {}, receipts: {}, submits: {} }

/** The record exactly as the re-submission leaves it. */
function resubmitted(): Change {
  return {
    id: CHANGE,
    name: "silent sites",
    branch: "task/w28-silentsites",
    base: "main",
    state: "open",
    merged: false,
    revs: [
      {
        n: 1,
        head: HEAD,
        base: "main",
        baseSha: BASE_SHA,
        pushedAt: PUSHED_AT,
        submittedAt: RESUBMITTED_AT,
        submitter: "author@example.test",
        terminal: { kind: "canceled", at: TERMINAL_AT, run: "R3675" },
      },
    ],
    reviews: [],
    comments: [],
    checkRequests: [],
    submittedAt: RESUBMITTED_AT,
  }
}

const ELIGIBILITY: ChangeEligibility = {
  pr: CHANGE,
  revision: 1,
  runnable: true,
  review: { required: false, approved: true, stale: false },
  checks: { status: "not-requested" },
}

function result(): QueueStatusResult {
  return {
    base: "main",
    prs: [resubmitted()],
    admissionOrder: [CHANGE],
    running: [],
    waiting: [],
    finished: [],
    eligibilities: [ELIGIBILITY],
  }
}

describe("reader resubmitted-stale-results gate — one rule, every listing", () => {
  it("the scoping helper is the single home for the judgement", () => {
    // A finish before its start belongs to a previous admission: no finish yet.
    expect(currentAdmissionFinish(RESUBMITTED_AT, TERMINAL_AT)).toBeUndefined()
    // A finish after its start is this admission's, and passes through.
    expect(currentAdmissionFinish(PUSHED_AT, TERMINAL_AT)).toBe(TERMINAL_AT)
    // Nothing to scope against, or nothing to scope: unchanged.
    expect(currentAdmissionFinish(undefined, TERMINAL_AT)).toBe(TERMINAL_AT)
    expect(currentAdmissionFinish(RESUBMITTED_AT, undefined)).toBeUndefined()
    // An unparseable clock is a DIFFERENT defect and is not swallowed here.
    expect(currentAdmissionFinish("not-a-date", TERMINAL_AT)).toBe(TERMINAL_AT)
  })

  it("`yrd watch` renders the row and reads it as pending", () => {
    let projection: ReturnType<typeof queueTimelineProjection> | undefined
    expect(() => {
      projection = queueTimelineProjection([result()], {
        now: NOW,
        windowMs: 100 * 365 * 24 * 60 * 60 * 1_000,
        statuses: ["pending", "running", "rejected", "integrated", "other"],
        terms: [],
        latest: false,
        rowLimit: 50,
        submissionTimes: new Map(),
      })
    }).not.toThrow()

    const row = projection?.rows.find((candidate) => candidate.pr === CHANGE)
    expect(row).toBeDefined()
    // Pending, and aged from the RE-SUBMISSION — not from the stale settle.
    expect(row?.status).toBe("ready")
    expect(row?.ageMs).toBe(NOW - Date.parse(RESUBMITTED_AT))
    expect(projection?.readFaults).toEqual([])
  })

  it("`yrd pr list` renders the row and reads it as pending", () => {
    let rows: ReturnType<typeof changeListRows> | undefined
    expect(() => {
      rows = changeListRows([{ pr: resubmitted(), eligibility: ELIGIBILITY }], [], NOW)
    }).not.toThrow()

    expect(rows).toHaveLength(1)
    const row = rows?.[0]
    expect(row?.pr).toBe(CHANGE)
    // Not the containment row — the scoping rule resolved this one cleanly.
    expect(row?.state).not.toBe("unreadable")
    expect(row?.why).not.toBe("clock-unreadable")
    // A real age measured forward from the re-submission, never "-".
    expect(row?.age).not.toBe("-")
  })

  it("`yrd queue list` renders the row and reads it as pending", () => {
    let projection: ReturnType<typeof humanQueueProjection> | undefined
    expect(() => {
      projection = humanQueueProjection(result(), NOW, { state: NO_BAYS })
    }).not.toThrow()

    // The change is OPEN queue work, not a terminal row in `recent`.
    expect(projection?.queue.map((row) => row.pr)).toEqual([CHANGE])
    expect(projection?.recent.map((row) => row.pr)).toEqual([])
    const row = projection?.queue[0]
    expect(row?.nativeStatus).toBe("submitted")
    expect(row?.state).not.toBe("unreadable")
    expect(row?.age).not.toBe("-")
  })

  /**
   * The variant the scoping rule deliberately does NOT resolve. A late
   * REJECTED settle is read by `changeDeliveryState` (yrd-bay model.ts, the
   * `revision.terminal?.kind === "rejected"` branch) straight off the raw
   * record, so the change reports `rejected` while the re-submission has
   * already cleared `pr.rejectedAt` — and `currentTerminalFact` then refuses
   * for want of the timestamp. Teaching the delivery state to ignore a
   * superseded terminal would change what the QUEUE admits, not just what a
   * reader prints, so it is left for a ruling. What must hold either way is
   * that it costs one row and not the listing.
   */
  it("a late REJECTED settle costs its own row, never the whole listing", () => {
    const lateRejected: Change = {
      ...resubmitted(),
      revs: [{ ...resubmitted().revs[0]!, terminal: { kind: "rejected", at: TERMINAL_AT, run: "R3675" } }],
    }
    const healthy: Change = { ...resubmitted(), id: "PR2750", branch: "task/other" }
    const healthyEligibility: ChangeEligibility = { ...ELIGIBILITY, pr: "PR2750" }

    let rows: ReturnType<typeof changeListRows> | undefined
    expect(() => {
      rows = changeListRows(
        [
          { pr: lateRejected, eligibility: ELIGIBILITY },
          { pr: healthy, eligibility: healthyEligibility },
        ],
        [],
        NOW,
      )
    }).not.toThrow()

    expect(rows).toHaveLength(2)
    const marked = rows?.find((row) => row.pr === CHANGE)
    expect(marked?.state).toBe("unreadable")
    expect(marked?.why).toBe("clock-unreadable")
    expect(marked?.whyMessage).toContain("has no rejected timestamp")
    expect(marked?.whyMessage).toContain(`yrd log --pr ${CHANGE}`)
    // Its neighbour is untouched — this is the containment, not a blanket.
    expect(rows?.find((row) => row.pr === "PR2750")?.state).not.toBe("unreadable")
  })

  it("a settle that is genuinely this admission's still measures to it", () => {
    // Same record, but submitted BEFORE the settle — the ordinary case. The
    // scoping rule must not swallow a real terminal fact.
    const ordinary: Change = {
      ...resubmitted(),
      state: "closed",
      merged: false,
      canceledAt: TERMINAL_AT,
      revs: [{ ...resubmitted().revs[0]!, submittedAt: "2026-08-30T22:00:00.000Z" }],
      submittedAt: "2026-08-30T22:00:00.000Z",
    }
    const rows = changeListRows([{ pr: ordinary, eligibility: ELIGIBILITY }], [], NOW)
    expect(rows[0]?.state).not.toBe("unreadable")
    // Aged to the settle, not to `now` — the terminal fact is still in force.
    expect(rows[0]?.age).toBe("56m")
  })
})
