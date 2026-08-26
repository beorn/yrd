/**
 * @failure The declared step plan silently accepts an invalid shape (blank or
 *          duplicate steps, several merge steps) or loses its declared options.
 * @level l1
 * @consumer @yrd/config authors and the Yrd runtime
 */
import { describe, expect, it } from "vitest"
import { defineStepPlan, withActionStep, withCheckStep, withMergeStep, yrd } from "../src/index.ts"

const check = withCheckStep("check", { run: "bun test" })
const merge = withMergeStep({ run: "git merge" })

describe("step plan configuration", () => {
  it("validates and freezes the declared step plan", () => {
    const plan = defineStepPlan([check, withActionStep("announce"), merge])
    expect(plan.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "check", kind: "check" },
      { name: "announce", kind: "action" },
      { name: "merge", kind: "merge" },
    ])
    expect(Object.isFrozen(plan)).toBe(true)
    expect(plan[0]).toMatchObject({ run: "bun test", runner: "local" })
  })

  it("refuses an empty plan, duplicate steps, and more than one merge step loudly", () => {
    expect(() => defineStepPlan([])).toThrow("has no steps")
    expect(() => defineStepPlan([check, check])).toThrow("duplicate step 'check'")
    // The merge boundary has one canonical name, so a second merge step is
    // always a duplicate of it; the at-most-one-merge rule stays as defense.
    expect(() => defineStepPlan([check, merge, withMergeStep()])).toThrow("duplicate step 'merge'")
  })

  it("refuses blank and malformed step names loudly", () => {
    expect(() => withCheckStep(" ")).toThrow("cannot be blank")
    expect(() => withCheckStep("Check")).toThrow("must match")
  })

  it("declares one journal reader floor", () => {
    const compatibility = { version: 1 }
    expect(yrd.journal(compatibility)).toEqual({ kind: "journal", compatibility })
  })
})
