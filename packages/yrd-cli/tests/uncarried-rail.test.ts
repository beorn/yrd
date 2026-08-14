/**
 * @failure The uncarried rail renders a stored count as if it were current, or
 *          renders an absent measurement as zero.
 * @level   l1
 * @consumer @yrd/core/22716-yrd-hardening-program/p2-push-is-submit
 */
import { describe, expect, it } from "vitest"
import { uncarriedLine, type UncarriedObservation } from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-08-12T02:00:00.000Z")

function observed(count: number, agoMs: number, scanned = 4784, missingUpdateClocks = 0): UncarriedObservation {
  return { count, scanned, missingUpdateClocks, observedAt: new Date(NOW - agoMs).toISOString() }
}

describe("uncarriedLine", () => {
  it("never renders an unmeasured rail as zero", () => {
    // The whole reason the rail is trustworthy. "0" and "nobody looked" are
    // different facts about the fleet, and collapsing them asserts a healthy
    // queue that was never swept.
    const line = uncarriedLine(undefined, NOW)
    expect(line).toContain("not swept")
    expect(line).not.toMatch(/\b0\b/u)
  })

  it("carries the age on every reading, including a healthy zero", () => {
    // A zero is exactly where staleness hides: nothing about "0 uncarried"
    // looks wrong when the runner died three hours ago.
    expect(uncarriedLine(observed(0, 4 * 60_000), NOW)).toContain("as of 4m ago")
    expect(uncarriedLine(observed(3, 90 * 60_000), NOW)).toContain("as of 1h30m ago")
  })

  it("says how long ago a dead runner last looked, rather than going quiet", () => {
    const line = uncarriedLine(observed(0, 3 * 60 * 60_000), NOW)
    expect(line).toContain("as of 3h ago")
    expect(line).toContain("0 of 4784 refs")
  })

  it("reports the denominator so a small number is readable", () => {
    expect(uncarriedLine(observed(3, 60_000, 4784), NOW)).toContain("3 of 4784 refs")
  })

  it("reports refs without retained update clocks on the resident rail", () => {
    expect(uncarriedLine(observed(3, 60_000, 4784, 12), NOW)).toContain("12 refs without retained update clocks")
  })

  it("does not interpret an old resident's missing clock field as complete coverage", () => {
    const oldObservation: UncarriedObservation = {
      count: 0,
      scanned: 4784,
      observedAt: new Date(NOW - 60_000).toISOString(),
    }
    expect(uncarriedLine(oldObservation, NOW)).toContain("push-clock coverage unknown")
  })

  it("says the count is a floor and what share of the population it could measure", () => {
    // Measured 2026-08-14: 2,442 of 2,786 uncarried refs had no retained
    // reflog clock, so the rail judged 12% of its population. A bare "63"
    // beside an 88% blind spot reads as a total, and a bare "0" from the same
    // reading reads as a clean fleet — which is the reading that gets a
    // monitoring rail trusted right up until it misses everything.
    const line = uncarriedLine({ ...observed(63, 60_000, 3618, 2442), measurable: 344 }, NOW)
    expect(line).toContain("≥63 of 3618 refs")
    expect(line).toContain("a floor")
    expect(line).toContain("12% of 2786 candidates measurable")
    expect(line).toContain("2442 refs without retained update clocks")
  })

  it("marks a zero as a floor too, so an unmeasured population cannot read as clean", () => {
    const line = uncarriedLine({ ...observed(0, 60_000, 3618, 2442), measurable: 344 }, NOW)
    expect(line).toContain("≥0 of 3618 refs")
    expect(line).toContain("a floor")
  })

  it("drops the floor marker only when every candidate was actually measured", () => {
    const line = uncarriedLine({ ...observed(2, 60_000, 3618, 0), measurable: 344 }, NOW)
    expect(line).toContain("uncarried 2 of 3618 refs")
    expect(line).not.toContain("≥")
    expect(line).toContain("every candidate had a retained update clock")
  })

  it("does not round a sliver of coverage down to none measurable", () => {
    // "0% measurable" says the sweep saw nothing; it saw one ref. Different
    // facts, and the rounded one invites someone to switch the rail off.
    const line = uncarriedLine({ ...observed(1, 60_000, 3618, 999), measurable: 1 }, NOW)
    expect(line).toContain("<1% of 1000 candidates measurable")
  })

  it("does not claim a candidate population an older resident never recorded", () => {
    const line = uncarriedLine(observed(3, 60_000, 4784, 12), NOW)
    expect(line).toContain("against an unknown candidate population")
    expect(line).not.toContain("candidates measurable")
  })

  it("does not render a future observation as a negative age", () => {
    // Clock skew between the runner host and the viewer is real; a negative
    // age would read as a nonsense future measurement rather than a fresh one.
    expect(uncarriedLine(observed(1, -30_000), NOW)).toContain("under a minute")
  })
})
