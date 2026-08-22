/**
 * @failure A merge-tip refusal that says "fast-forward that component's main"
 *          without listing what the FF would drag in is the 3652bfe class:
 *          a rejected commit on component main, one pin-bump from the estate.
 * @level l1
 * @consumer @yrd/core
 *
 * Refs: @chief 62a8019c — print `git cherry <estate-pin> <component-main>`
 * before the FF verb. Not a sibling of 23140 (review door); this is the
 * worker-facing remedy text.
 */
import { describe, expect, it } from "vitest"
import { failureFact } from "../src/failure.ts"
import { requireLinearRootTip } from "../src/linear-tip.ts"

describe("requireLinearRootTip", () => {
  it("is silent for a linear tip", () => {
    expect(() => requireLinearRootTip("change PR42", "task/x", ["deadbeef"])).not.toThrow()
    expect(() => requireLinearRootTip("change PR42", "task/x", [])).not.toThrow()
  })

  it("refuses a merge tip as merge-tip-carrier", () => {
    try {
      requireLinearRootTip("change PR42", "task/x", ["aaa", "bbb"])
      throw new Error("expected refusal")
    } catch (error) {
      const fact = failureFact(error)
      expect(fact?.kind).toBe("refusal")
      expect(fact?.code).toBe("merge-tip-carrier")
    }
  })

  it("names git cherry <estate-pin> <component-main> before instructing the FF", () => {
    try {
      requireLinearRootTip("change PR42", "task/x", ["aaa", "bbb"])
      throw new Error("expected refusal")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toMatch(/git cherry <estate-pin> <component-main>/u)
      expect(message).toMatch(/fast-forward/iu)
    }
  })
})
