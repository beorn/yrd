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
import { cherryFfInstruction, requireLinearRootTip } from "../src/linear-tip.ts"

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

  it("says the FF is a no-op when the unique list is empty", () => {
    try {
      requireLinearRootTip("change PR42", "task/x", ["aaa", "bbb"], {
        unique: [],
        notYours: 0,
        unreviewed: 0,
      })
      throw new Error("expected refusal")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toMatch(/FF is a no-op/u)
      expect(message).toMatch(/unique list is empty/u)
      expect(message).not.toMatch(/dragged set/u)
    }
  })

  it("names the dragged set with N not-yours and M unreviewed", () => {
    try {
      requireLinearRootTip("change PR42", "task/x", ["aaa", "bbb"], {
        unique: [{ sha: "3652bfe", subject: "fix(process): retry a STALLED read-only git call" }],
        notYours: 1,
        unreviewed: 1,
      })
      throw new Error("expected refusal")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toMatch(/dragged set/u)
      expect(message).toMatch(/3652bfe/)
      expect(message).toMatch(/of the commits this FF would carry, 1 are not yours and 1 are unreviewed/u)
    }
  })
})

describe("cherryFfInstruction", () => {
  it("prints the git cherry command when the unique list is not in hand", () => {
    expect(cherryFfInstruction()).toMatch(/git cherry <estate-pin> <component-main>/u)
    expect(cherryFfInstruction()).toMatch(/empty unique list = no-op/u)
  })

  it("says the FF is a no-op when the unique list is empty", () => {
    expect(cherryFfInstruction({ unique: [], notYours: 0, unreviewed: 0 })).toMatch(/FF is a no-op/u)
    expect(cherryFfInstruction({ unique: [], notYours: 0, unreviewed: 0 })).not.toMatch(/dragged set/u)
  })

  it("names the dragged set with N not-yours and M unreviewed", () => {
    const text = cherryFfInstruction({
      unique: [{ sha: "3652bfe", subject: "fix(process): retry a STALLED read-only git call" }],
      notYours: 1,
      unreviewed: 1,
    })
    expect(text).toMatch(/dragged set \(1 unique\): 3652bfe /u)
    expect(text).toMatch(/1 are not yours and 1 are unreviewed/u)
  })
})
