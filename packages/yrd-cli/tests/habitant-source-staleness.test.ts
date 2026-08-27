/**
 * @failure A habitant runner served three-pins-old code for ~3h while its source
 *          checkout advanced four times underneath it. The driver-stale page
 *          fired and nothing acted on it: no mechanism existed to notice the gap
 *          and recycle, so the queue kept applying yesterday's gates to today's
 *          merges until an operator restarted the runner by hand.
 * @level   l1
 * @consumer @yrd/cli habitant runner
 *
 * Box 1 of @yrd/core/stale-runner-never-recycles — the pure half. The git read
 * that feeds these observations is proved in runner-source-behind.test.ts; the
 * loop wiring, the logs and the durable attempt record in
 * habitant-source-recycle.test.ts.
 */
import { describe, expect, it } from "vitest"
import {
  decideHabitantSource,
  foldSourceStaleness,
  HABITANT_SOURCE_RECYCLE_RETRY_MS,
  HABITANT_SOURCE_STALE_BEHIND,
  HABITANT_SOURCE_STALE_OBSERVATIONS,
  type HabitantSourceObservation,
  type HabitantSourceStall,
} from "../src/source-staleness.ts"

const BOOTED = "a".repeat(40)
const HEAD = "b".repeat(40)
const NEWER_HEAD = "c".repeat(40)
const ATTEMPTED_AT = "2026-08-14T22:39:00.000Z"
/** One minute after the recorded attempt: well inside the retry window. */
const NOW = Date.parse(ATTEMPTED_AT) + 60_000

function behind(count: number | undefined, headSha: string | undefined = HEAD): HabitantSourceObservation {
  return { bootedSha: BOOTED, headSha, behind: count }
}

/** Fold the same observation `times` in a row, as consecutive cycles would. */
function after(times: number, observation: HabitantSourceObservation): HabitantSourceStall | undefined {
  let window: HabitantSourceStall | undefined
  for (let cycle = 0; cycle < times; cycle += 1) window = foldSourceStaleness(window, observation)
  return window
}

describe("habitant source staleness — the window", () => {
  it("counts consecutive observations of the same gap at the same head", () => {
    expect(after(1, behind(2))?.observations).toBe(1)
    expect(after(2, behind(2))?.observations).toBe(2)
    expect(after(9, behind(4))?.observations).toBe(9)
  })

  it("opens no window below the threshold — one commit is routinely our own merge", () => {
    expect(foldSourceStaleness(undefined, behind(1))).toBeUndefined()
    expect(after(5, behind(1))).toBeUndefined()
    expect(foldSourceStaleness(undefined, behind(HABITANT_SOURCE_STALE_BEHIND))?.observations).toBe(1)
  })

  it("opens no window on an unmeasurable read — undefined is not zero and not evidence", () => {
    expect(foldSourceStaleness(undefined, behind(undefined))).toBeUndefined()
    expect(foldSourceStaleness(undefined, { bootedSha: undefined, headSha: HEAD, behind: 5 })).toBeUndefined()
    expect(foldSourceStaleness(undefined, { bootedSha: BOOTED, headSha: undefined, behind: 5 })).toBeUndefined()
  })

  it("clears the window the moment the gap closes — a recycled or advanced source is current", () => {
    const stalled = after(3, behind(2))
    expect(stalled?.observations).toBe(3)
    expect(foldSourceStaleness(stalled, behind(undefined))).toBeUndefined()
  })

  it("restarts the count when the head is still moving — mid-advance is when a torn read is likeliest", () => {
    const first = foldSourceStaleness(undefined, behind(2))
    const moved = foldSourceStaleness(first, behind(3, NEWER_HEAD))
    expect(moved?.observations).toBe(1)
    expect(moved?.headSha).toBe(NEWER_HEAD)
    // And it accumulates again from there, so a moving head delays a recycle
    // rather than preventing one.
    expect(foldSourceStaleness(moved, behind(3, NEWER_HEAD))?.observations).toBe(2)
  })

  it("respects a caller-supplied threshold, including one that admits a single commit", () => {
    expect(foldSourceStaleness(undefined, behind(1), 1)?.observations).toBe(1)
    expect(foldSourceStaleness(undefined, behind(4), 5)).toBeUndefined()
  })
})

describe("habitant source staleness — the verdict", () => {
  it("serves on until the window closes, then recycles", () => {
    expect(decideHabitantSource(undefined, undefined, NOW).kind).toBe("serve")
    expect(decideHabitantSource(after(HABITANT_SOURCE_STALE_OBSERVATIONS - 1, behind(2)), undefined, NOW).kind).toBe(
      "serve",
    )

    const action = decideHabitantSource(after(HABITANT_SOURCE_STALE_OBSERVATIONS, behind(2)), undefined, NOW)
    expect(action).toMatchObject({
      kind: "recycle",
      bootedSha: BOOTED,
      headSha: HEAD,
      behind: 2,
      observations: HABITANT_SOURCE_STALE_OBSERVATIONS,
    })
  })

  it("carries the head a recycle is aiming at, so the restart is auditable", () => {
    const action = decideHabitantSource(after(2, behind(7, NEWER_HEAD)), undefined, NOW)
    expect(action).toMatchObject({ kind: "recycle", headSha: NEWER_HEAD, behind: 7 })
  })

  it("holds instead of a SECOND recycle while the attempt is FRESH — that restart just changed nothing", () => {
    const stall = after(HABITANT_SOURCE_STALE_OBSERVATIONS, behind(2))
    const action = decideHabitantSource(stall, { bootedSha: BOOTED, headSha: HEAD, attemptedAt: ATTEMPTED_AT }, NOW)
    expect(action).toMatchObject({
      kind: "checkout-behind",
      bootedSha: BOOTED,
      headSha: HEAD,
      behind: 2,
      attemptedAt: ATTEMPTED_AT,
    })
  })

  it("holds right up to the retry window's edge, then retries the recycle past it", () => {
    // A recycle that raced the checkout projection must not become a permanent
    // hold: within the window exiting again would change nothing, but the
    // freeze that made the last restart ineffective may since have lifted —
    // re-ask by exiting once per window, bounded, instead of serving stale
    // until an operator notices.
    const stall = after(HABITANT_SOURCE_STALE_OBSERVATIONS, behind(2))
    const attempt = { bootedSha: BOOTED, headSha: HEAD, attemptedAt: ATTEMPTED_AT }
    const edge = Date.parse(ATTEMPTED_AT) + HABITANT_SOURCE_RECYCLE_RETRY_MS
    expect(decideHabitantSource(stall, attempt, edge - 1).kind).toBe("checkout-behind")
    expect(decideHabitantSource(stall, attempt, edge).kind).toBe("recycle")
  })

  it("treats an unreadable attempt timestamp as expired — a corrupt record costs one restart, never a permanent hold", () => {
    const stall = after(HABITANT_SOURCE_STALE_OBSERVATIONS, behind(2))
    const action = decideHabitantSource(stall, { bootedSha: BOOTED, headSha: HEAD, attemptedAt: "not-a-date" }, NOW)
    expect(action.kind).toBe("recycle")
  })

  it("a future-stamped attempt cannot hold the runner — clock skew costs one restart, not an unbounded hold", () => {
    const stall = after(HABITANT_SOURCE_STALE_OBSERVATIONS, behind(2))
    const future = new Date(NOW + 3_600_000).toISOString()
    const action = decideHabitantSource(stall, { bootedSha: BOOTED, headSha: HEAD, attemptedAt: future }, NOW)
    expect(action.kind).toBe("recycle")
  })

  it("recycles again once the source actually moved on — a prior attempt is not a permanent ban", () => {
    // We came back running HEAD (the recycle worked), and the checkout has since
    // advanced again. The stale record names the OLD booted sha, so it must not
    // suppress this genuinely new gap.
    const stall = after(HABITANT_SOURCE_STALE_OBSERVATIONS, { bootedSha: HEAD, headSha: NEWER_HEAD, behind: 2 })
    const action = decideHabitantSource(stall, { bootedSha: BOOTED, headSha: HEAD, attemptedAt: ATTEMPTED_AT }, NOW)
    expect(action.kind).toBe("recycle")
  })

  it("recycles when a prior attempt aimed at a DIFFERENT head, even from the same booted sha", () => {
    const stall = after(HABITANT_SOURCE_STALE_OBSERVATIONS, behind(2, NEWER_HEAD))
    const action = decideHabitantSource(stall, { bootedSha: BOOTED, headSha: HEAD, attemptedAt: ATTEMPTED_AT }, NOW)
    expect(action.kind).toBe("recycle")
  })
})
