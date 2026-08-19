/**
 * @failure A closed PR reports `needs-author` — a value its own delivery model
 * says is impossible once the record is closed — because the projection reads a
 * never-cleared stored fact before it looks at live state.
 * @level l1
 * @consumer @yrd/cli
 *
 * Specimen, 2026-08-10: PR715, PR717 and PR720 were closed as spent carriers and
 * still read `state=closed, status=needs-author` in `pr list` and in `--json`.
 * Two functions produce the same declared vocabulary and disagree on live data:
 * `prDeliveryState` checks `pr.state` first, so a closed PR maps to exactly
 * integrated / already-landed / canceled / withdrawn. `projectedPrStatus` — the
 * one that actually feeds the STATE column — consulted `prNeedsAuthor` first.
 *
 * `PR.needsAuthor` is cleared by recut, submitted, admission-recorded and
 * already-landed, and NEVER by withdrawn, integrated or canceled. So the stored
 * fact outlives every closing path and wins over the observation.
 */
import { changeDeliveryState, type PR } from "@yrd/bay"
import type { ChangeEligibility } from "@yrd/queue"
import { describe, expect, it } from "vitest"
import { projectedChangeStatus } from "../src/queue-status-view.tsx"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const AT = "2026-08-10T16:00:00.000Z"

/** The stored refusal fact that no closing path clears. */
const STICKY_NEEDS_AUTHOR = {
  at: AT,
  run: "run-1",
  step: "typecheck",
  receipt: { code: "candidate-drops-landed", message: "carrier drops landed work" },
} as const

function pr(overrides: Partial<PR>): PR {
  return {
    id: "PR715",
    name: "Spent carrier",
    branch: "task/pin-gatherer-contract",
    base: "main",
    state: "open",
    merged: false,
    revs: [{ n: 1, head: HEAD_SHA, base: "main", baseSha: BASE_SHA, pushedAt: AT, submittedAt: AT }],
    reviews: [],
    comments: [],
    checkRequests: [],
    needsAuthor: STICKY_NEEDS_AUTHOR,
    ...overrides,
  }
}

/** Every way a PR reaches `state: "closed"`, with the sticky fact still on it. */
const CLOSED_CASES = [
  ["withdrawn", pr({ state: "closed" }), "withdrawn"],
  ["integrated", pr({ state: "closed", merged: true }), "integrated"],
  ["canceled", pr({ state: "closed", canceledAt: AT }), "canceled"],
] as const

describe("projectedPrStatus", () => {
  it.each(CLOSED_CASES)("a %s PR never reports needs-author, however stale the stored fact", (_label, closed, want) => {
    expect(projectedChangeStatus(closed)).toBe(want)
  })

  // The eligibility argument is a second door into the same wrong answer: a
  // stale reason code must not resurrect an open-only value on a closed record.
  it("refuses to resurrect needs-author from a stale eligibility reason", () => {
    const eligibility = { reason: { code: "needs-author" } } as unknown as ChangeEligibility
    expect(projectedChangeStatus(pr({ state: "closed" }), eligibility)).toBe("withdrawn")
  })

  // The regression guard in the other direction. needs-author is a real and
  // useful answer while the PR is open, and this fix must not cost us that.
  it("still reports needs-author while the PR is open", () => {
    expect(projectedChangeStatus(pr({}))).toBe("needs-author")
  })

  // The general invariant, and the one worth keeping if the cases above ever
  // get rewritten: the two producers of this vocabulary may not contradict each
  // other about a closed record. Whatever prDeliveryState says a closed PR is,
  // the projection says the same.
  it.each(CLOSED_CASES)("agrees with prDeliveryState on a %s PR", (_label, closed) => {
    expect(projectedChangeStatus(closed)).toBe(changeDeliveryState(closed))
  })
})
