/**
 * @i/10-yrd/25303 tier 2: git-super's per-phase durations have to survive the
 * boundary into yrd. The field is additive: absent is an older git-super and
 * reads as none. Present and malformed is a producer defect and throws, as
 * `descents` does, because swallowing it would leave the compose silent inside.
 * A phase name git-super does not document is kept as given; the journal is
 * where that drift is seen.
 */

import { describe, expect, it } from "vitest"
import { readSuperMergeResult } from "../src/run.ts"

const merged = { state: "updated", partial: false, commit: "a".repeat(40), gitlinks: [] }

describe("readSuperMergeResult — git-super's phase durations (25303 tier 2)", () => {
  it("keeps every step in order, a name outside git-super's list included", () => {
    const steps = [
      { name: "preflight", ms: 12 },
      { name: "merge-tree", ms: 840 },
      { name: "a-phase-from-a-newer-git-super", ms: 3 },
    ]

    expect(readSuperMergeResult({ ...merged, steps }).steps).toEqual(steps)
  })

  it("reads an older git-super, which writes no steps, as none", () => {
    expect(readSuperMergeResult(merged)).not.toHaveProperty("steps")
  })

  it.each<[unknown, string]>([
    ["a non-array", "steps"],
    [[{ name: "plan" }], "no ms"],
    [[{ ms: 4 }], "no name"],
    [[{ name: "", ms: 4 }], "an empty name"],
    [[{ name: "plan", ms: -1 }], "a negative ms"],
    [[{ name: "plan", ms: Number.NaN }], "a non-finite ms"],
  ])("refuses %j (%s)", (steps) => {
    expect(() => readSuperMergeResult({ ...merged, steps })).toThrow(/git-super merge step/u)
  })
})
