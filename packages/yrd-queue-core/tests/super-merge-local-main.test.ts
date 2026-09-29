/**
 * @failure GitSuper reports local Equal reads but Yrd drops or silently accepts malformed evidence.
 * @level l1
 * @consumer submit verification receipt
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { readSuperMergeResult } from "../src/run.ts"

const merged = { state: "updated", partial: false, commit: "a".repeat(40), gitlinks: [] }

describe("readSuperMergeResult — local Equal reads (25626)", () => {
  it("preserves identified local reads and accepts an older result without the field", () => {
    const row = { path: "vendor/alpha", pin: "b".repeat(40), store: ".git/modules/vendor/alpha" }
    expect(readSuperMergeResult({ ...merged, unboundedLocalMains: [row] }).unboundedLocalMains).toEqual([row])
    expect(readSuperMergeResult(merged)).not.toHaveProperty("unboundedLocalMains")
  })

  it.each(["bad", [{ path: "vendor/alpha", pin: "b".repeat(40) }]])(
    "refuses malformed present evidence (%j)",
    (unboundedLocalMains) => {
      expect(() => readSuperMergeResult({ ...merged, unboundedLocalMains })).toThrow(/unboundedLocalMain/u)
    },
  )
})
