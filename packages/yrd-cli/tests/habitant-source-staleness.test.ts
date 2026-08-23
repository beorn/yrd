/**
 * @failure A habitant runner served three-pins-old code for ~3h while its source
 *          checkout advanced four times underneath it. The driver-stale page
 *          fired and nothing acted on it: no mechanism existed to notice the gap
 *          and recycle, so the queue kept applying yesterday's gates to today's
 *          landings until an operator restarted the runner by hand.
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
  HABITANT_SOURCE_STALE_BEHIND,
  HABITANT_SOURCE_STALE_OBSERVATIONS,
  type HabitantSourceObservation,
  type HabitantSourceStall,
} from "../src/source-staleness.ts"

const BOOTED = "a".repeat(40)
const HEAD = "b".repeat(40)
const NEWER_HEAD = "c".repeat(40)

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
    expect(decideHabitantSource(undefined, undefined).kind).toBe("serve")
    expect(decideHabitantSource(after(HABITANT_SOURCE_STALE_OBSERVATIONS - 1, behind(2)), undefined).kind).toBe("serve")

    const action = decideHabitantSource(after(HABITANT_SOURCE_STALE_OBSERVATIONS, behind(2)), undefined)
    expect(action).toMatchObject({
      kind: "recycle",
      bootedSha: BOOTED,
      headSha: HEAD,
      behind: 2,
      observations: HABITANT_SOURCE_STALE_OBSERVATIONS,
    })
  })

  it("carries the head a recycle is aiming at, so the restart is auditable", () => {
    const action = decideHabitantSource(after(2, behind(7, NEWER_HEAD)), undefined)
    expect(action).toMatchObject({ kind: "recycle", headSha: NEWER_HEAD, behind: 7 })
  })

  it("refuses a SECOND recycle for the same gap — the restart changed nothing, so it cannot help", () => {
    const stall = after(HABITANT_SOURCE_STALE_OBSERVATIONS, behind(2))
    const action = decideHabitantSource(stall, {
      bootedSha: BOOTED,
      headSha: HEAD,
      attemptedAt: "2026-08-14T22:39:00.000Z",
    })
    expect(action).toMatchObject({
      kind: "checkout-behind",
      bootedSha: BOOTED,
      headSha: HEAD,
      behind: 2,
      attemptedAt: "2026-08-14T22:39:00.000Z",
    })
  })

  it("recycles again once the source actually moved on — a prior attempt is not a permanent ban", () => {
    // We came back running HEAD (the recycle worked), and the checkout has since
    // advanced again. The stale record names the OLD booted sha, so it must not
    // suppress this genuinely new gap.
    const stall = after(HABITANT_SOURCE_STALE_OBSERVATIONS, { bootedSha: HEAD, headSha: NEWER_HEAD, behind: 2 })
    const action = decideHabitantSource(stall, {
      bootedSha: BOOTED,
      headSha: HEAD,
      attemptedAt: "2026-08-14T22:39:00.000Z",
    })
    expect(action.kind).toBe("recycle")
  })

  it("recycles when a prior attempt aimed at a DIFFERENT head, even from the same booted sha", () => {
    const stall = after(HABITANT_SOURCE_STALE_OBSERVATIONS, behind(2, NEWER_HEAD))
    const action = decideHabitantSource(stall, {
      bootedSha: BOOTED,
      headSha: HEAD,
      attemptedAt: "2026-08-14T22:39:00.000Z",
    })
    expect(action.kind).toBe("recycle")
  })
})
