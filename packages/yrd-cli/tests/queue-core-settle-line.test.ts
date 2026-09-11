/**
 * What a settle row SAYS. The log is the only durable account of what a landing
 * did to a gitlink, and the arrow form asserts a move.
 *
 * 24454 row 4 added a nested rung whose whole meaning is that nothing moved: a
 * nested pin behind its own main is classified and then deliberately left as
 * the parent wrote it, because a root merge does not rewrite a parent
 * component's commit. Rendering that as `from -> to (submodule main)` would put
 * a landing in the log that never happened, and the reader has nothing else to
 * check it against.
 */

import { describe, expect, it } from "vitest"
import { summarize } from "../src/queue-core-commands.ts"

const FROM = "1111111111111111111111111111111111111111"
const TO = "2222222222222222222222222222222222222222"

function settle(state: string, path = "km/apps/maddoc"): string {
  return summarize("settle", { branch: "task/x", from: FROM, head: "abc", path, state, to: TO })
}

describe("a settle row's line", () => {
  it("says a nested pin was KEPT BEHIND, never that it moved", () => {
    const line = settle("kept-behind")
    expect(line).toContain("km/apps/maddoc")
    expect(line).toContain(`kept behind submodule main ${TO.slice(0, 12)}`)
    // The arrow is the claim this rung must not make.
    expect(line, "a pin that did not move must not be rendered as one that did").not.toContain("->")
  })

  it("still says a raise moved, and an off-main pin was left", () => {
    expect(settle("raised")).toContain(`${FROM.slice(0, 12)} -> ${TO.slice(0, 12)} (submodule main)`)
    expect(settle("kept-ahead")).toContain(`${FROM.slice(0, 12)} -> ${TO.slice(0, 12)} (submodule main)`)
    expect(settle("left-off-main")).toContain(`left off submodule main ${TO.slice(0, 12)}`)
  })
})
