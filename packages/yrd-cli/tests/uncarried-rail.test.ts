/**
 * @failure The uncarried rail renders a stored count as if it were current, or
 *          renders an absent measurement as zero.
 * @level   l1
 * @consumer @yrd/core/22716-yrd-hardening-program/p2-push-is-submit
 */
import { describe, expect, it } from "vitest"
import { uncarriedLine, type UncarriedObservation } from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-08-12T02:00:00.000Z")

function observed(count: number, agoMs: number, scanned = 4784): UncarriedObservation {
  return { count, scanned, observedAt: new Date(NOW - agoMs).toISOString() }
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

  it("does not render a future observation as a negative age", () => {
    // Clock skew between the runner host and the viewer is real; a negative
    // age would read as a nonsense future measurement rather than a fresh one.
    expect(uncarriedLine(observed(1, -30_000), NOW)).toContain("under a minute")
  })
})
