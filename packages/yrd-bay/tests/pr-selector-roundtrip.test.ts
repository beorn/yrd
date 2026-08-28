/**
 * @failure Yrd prints a revision-qualified change identity that its own selector
 * grammar rejects, or aliases to a different revision than the one displayed.
 * @level l2
 * @consumer @yrd/bay selector and formatter boundary
 *
 * S7 (branch-is-change, @i/10 22991) split this file's subject in two. The
 * GRAMMAR — `parseChangeSelector` and `formatChangeRevisionSelector` — survives
 * intact and is what remains under test here: a rendered identity must parse
 * back to the identity it names, and a bare non-numeric token must stay outside
 * the grammar so branch aliases keep resolving. RESOLUTION against the record
 * store (`resolveChangeMatch`, `requireLiveChange`) went with the store, and the
 * cases that only existed to exercise it went with them.
 */
import { describe, expect, it } from "vitest"
import { formatChangeRevisionSelector, parseChangeSelector } from "../src/model.ts"

const RETAINED_REVISION = { n: 16, head: "f".repeat(40), base: "main", pushedAt: "2026-08-06T00:00:00.000Z" } as const

describe("displayed change selector round trip", () => {
  it.each([
    ["pr#1410.16", { pr: "PR1410", revision: 16 }],
    ["PR1410.16", { pr: "PR1410", revision: 16 }],
    ["pr1410.16", { pr: "PR1410", revision: 16 }],
    ["pr#1410", { pr: "PR1410" }],
    ["PR1410", { pr: "PR1410" }],
    ["pr1410", { pr: "PR1410" }],
    ["1410", { pr: "PR1410" }],
    ["1410.16", { pr: "PR1410", revision: 16 }],
  ] as const)("parses %s without guessing", (selector, expected) => {
    expect(parseChangeSelector(selector)).toEqual(expected)
  })

  it("keeps a bare non-numeric token out of the change grammar (branch/name aliases stay reachable)", () => {
    expect(parseChangeSelector("topic/round-trip")).toBeUndefined()
    expect(parseChangeSelector("fix-thing")).toBeUndefined()
  })

  it("feeds the canonical renderer output back to the exact revision it displayed", () => {
    const displayed = formatChangeRevisionSelector("PR1410", RETAINED_REVISION)

    expect(displayed).toBe("pr#1410.16")
    // The round trip, and the whole point of the pair: what a renderer prints,
    // the grammar reads back as the same change at the same revision — never
    // the bare change, and never a neighbouring revision.
    expect(parseChangeSelector(displayed)).toEqual({ pr: "PR1410", revision: RETAINED_REVISION.n })
  })
})
