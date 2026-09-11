import { describe, expect, it } from "vitest"

import { sameFailureReason } from "../src/with-notify.ts"

/**
 * The notifier's third disposition — hold and route, do not resubmit — fires
 * only when a failure is the SAME failure again, and this is the rule that
 * decides it. Getting it wrong in either direction is a defect: too loose and an
 * author whose change is genuinely broken a new way each time is told to stop
 * working on it; too tight and the case it exists for never fires.
 *
 * Specimen: `task/dev4-24385` was sent back five times with one error byte for
 * byte, across four distinct upstream causes. Every one of the five was the
 * queue's environment, and the old text's only answer was "submit it again".
 */
describe("sameFailureReason — the one reason they all carry, or nothing", () => {
  it("returns the reason when every prior failure carries it", () => {
    expect(sameFailureReason(["typecheck", "typecheck", "typecheck"])).toBe("typecheck")
  })

  it("returns it for a single prior failure", () => {
    expect(sameFailureReason(["affected-tests"])).toBe("affected-tests")
  })

  it("NEGATIVE CONTROL: two distinct reasons are not a repeat, in either order", () => {
    expect(sameFailureReason(["typecheck", "affected-tests"])).toBeUndefined()
    expect(sameFailureReason(["affected-tests", "typecheck"])).toBeUndefined()
  })

  it("one disagreement anywhere in a long run is enough to refuse", () => {
    expect(sameFailureReason(["a", "a", "a", "a", "b"])).toBeUndefined()
    expect(sameFailureReason(["b", "a", "a", "a", "a"])).toBeUndefined()
  })

  it("no prior failures is not a repeat", () => {
    expect(sameFailureReason([])).toBeUndefined()
  })

  it("a missing or empty reason never becomes a repeat, however many agree", () => {
    // Two absent reasons comparing equal into "the same error again" is the way
    // this rule would most plausibly go wrong, and it is the one an author would
    // never be able to argue with.
    expect(sameFailureReason([undefined, undefined])).toBeUndefined()
    expect(sameFailureReason(["", ""])).toBeUndefined()
    expect(sameFailureReason(["typecheck", undefined])).toBeUndefined()
    expect(sameFailureReason([undefined, "typecheck"])).toBeUndefined()
  })
})
