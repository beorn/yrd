/**
 * @failure A re-submitted change with a LATE rejected settle was silently held
 * out of the queue. `branch/submitted` rewrites the revision's `submittedAt`
 * forward and clears both `terminal` and `pr.rejectedAt` (yrd-bay plugin.ts).
 * A settle from a run that has since died can still land after that, stamping
 * `terminal: { kind: "rejected", at }` with its own OLDER time — and
 * `changeDeliveryState` read that stale terminal straight off the record and
 * answered `rejected`.
 *
 * `requestedPRs` (yrd-queue/src/queue.ts, the implicit-queue selection) admits
 * only `submitted` or `ready`, so the change never entered the queue again. It
 * was held out in silence while every reader told the author they had
 * re-pushed and were waiting — and `currentTerminalFact` then refused outright
 * for want of the `rejectedAt` the re-submission had already cleared, which is
 * how one such change emptied `yrd pr list --json` for all 2275 rows
 * (2026-09-01, change 'PR2749').
 * @level l1
 * @consumer @yrd/queue queue admission; every reader of `changeDeliveryState`
 *
 * WHAT IS PINNED. Only a terminal fact from the revision's CURRENT admission
 * decides delivery. A settle stamped before that revision's own submit fact
 * belongs to a previous admission, so the change is PENDING and the queue must
 * admit it — while a settle that genuinely follows its submit fact still
 * rejects, and an untouched record is unaffected.
 */
import { describe, expect, it } from "vitest"
import type { Change } from "../src/model.ts"
import { changeDeliveryState, currentAdmissionFinish, currentRevisionTerminal } from "../src/model.ts"

const CHANGE = "PR2749"
const HEAD = `b3e5141d${"0".repeat(32)}`
const BASE_SHA = "a".repeat(40)
const PUSHED_AT = "2026-08-30T21:00:00.000Z"
/** The settle the dead run R3675 stamped, with its own older time. */
const SETTLE_AT = "2026-08-30T22:56:51.000Z"
/** The re-submission that landed BEFORE that settle was applied. */
const RESUBMITTED_AT = "2026-09-01T18:40:25.870Z"

/**
 * The record as the journal leaves it when the settle lands after the
 * re-submission: submit fact refreshed forward, `rejectedAt` already cleared by
 * `branch/submitted`, and a rejected terminal stamped with the older time.
 */
function lateRejectedSettle(): Change {
  return {
    id: CHANGE,
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
        terminal: { kind: "rejected", at: SETTLE_AT, run: "R3675" },
      },
    ],
    reviews: [],
    comments: [],
    checkRequests: [],
    submittedAt: RESUBMITTED_AT,
  }
}

/** The ordinary case: the settle FOLLOWS the submit fact it belongs to. */
function ordinaryRejection(): Change {
  const pr = lateRejectedSettle()
  const submittedAt = "2026-08-30T22:00:00.000Z"
  return {
    ...pr,
    revs: [{ ...pr.revs[0]!, submittedAt }],
    submittedAt,
    rejectedAt: SETTLE_AT,
  }
}

/** The exact predicate the implicit-queue selection applies
 * (yrd-queue/src/queue.ts, `requestedPRs`). */
function admitted(pr: Change): boolean {
  const delivery = changeDeliveryState(pr)
  return delivery === "submitted" || delivery === "ready"
}

describe("late-settle admission — a stale terminal never holds a re-submitted change out of the queue", () => {
  it("a re-submitted change with a late rejected settle is PENDING, and the queue admits it", () => {
    const pr = lateRejectedSettle()
    expect(changeDeliveryState(pr)).toBe("submitted")
    expect(admitted(pr)).toBe(true)
  })

  it("the re-submission's cleared rejection stays cleared — nothing is written back", () => {
    const pr = lateRejectedSettle()
    expect(pr.rejectedAt).toBeUndefined()
    // The stale fact itself is not erased from the record; it is simply not
    // the one that decides delivery.
    expect(pr.revs[0]?.terminal?.kind).toBe("rejected")
    expect(currentRevisionTerminal(pr.revs[0]!)).toBeUndefined()
  })

  it("a settle that genuinely follows its submit fact still rejects", () => {
    const pr = ordinaryRejection()
    expect(changeDeliveryState(pr)).toBe("rejected")
    expect(admitted(pr)).toBe(false)
    expect(currentRevisionTerminal(pr.revs[0]!)?.kind).toBe("rejected")
  })

  it("the shared rule is the same one the read projections apply", () => {
    expect(currentAdmissionFinish(RESUBMITTED_AT, SETTLE_AT)).toBeUndefined()
    expect(currentAdmissionFinish("2026-08-30T22:00:00.000Z", SETTLE_AT)).toBe(SETTLE_AT)
  })

  it("a revision with no submit fact keeps its terminal — nothing to scope against", () => {
    const pr = lateRejectedSettle()
    const unsubmitted: Change = {
      ...pr,
      revs: [{ n: 1, head: HEAD, base: "main", baseSha: BASE_SHA, pushedAt: PUSHED_AT, terminal: { kind: "rejected", at: SETTLE_AT } }],
      submittedAt: undefined,
    }
    expect(currentRevisionTerminal(unsubmitted.revs[0]!)?.kind).toBe("rejected")
    expect(changeDeliveryState(unsubmitted)).toBe("rejected")
  })
})
