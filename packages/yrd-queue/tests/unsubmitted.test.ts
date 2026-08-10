/**
 * @failure A pushed ref that never became a carrier stays invisible to the
 * queue, or the rail that would surface it drowns in refs that already landed
 * or were abandoned months ago.
 * @level l1
 * @consumer @yrd/queue
 *
 * P2 of the hardening program (@yrd/core/22716-yrd-hardening-program). The
 * predicate here is pure: it takes already-gathered facts and decides whether a
 * ref is a genuine dark carrier. Git I/O lives at the CLI boundary, so this
 * stays deterministic and the rail's judgement is testable without a repo.
 *
 * The thresholds are not guesses. Measured 2026-08-10 across origin: 1,546
 * pushed task/* refs carry no PR, and 1,502 of them are older than seven days.
 * A rail with no age bound pages on all 1,546 on its first run and is switched
 * off the same day. Bounded to 24 hours it is eleven rows — of which SEVEN had
 * already landed (six ancestral, one regenerated with every commit applied).
 * Without the landedness half the rail is 64% false positives in exactly the
 * window it cares about.
 */
import { describe, expect, it } from "vitest"
import { classifyPushedRef, type PushedRefFact } from "../src/unsubmitted.ts"

const HOUR = 60 * 60 * 1000
const NOW = Date.parse("2026-08-10T12:00:00.000Z")

const OPTIONS = { nowMs: NOW, ttlMs: 10 * 60 * 1000, ageBoundMs: 24 * HOUR } as const

function fact(overrides: Partial<PushedRefFact> = {}): PushedRefFact {
  return {
    ref: "task/example",
    tipSha: "a".repeat(40),
    pushedAtMs: NOW - HOUR,
    carried: false,
    uniqueCommits: 2,
    equivalentCommits: 0,
    ...overrides,
  }
}

describe("classifyPushedRef", () => {
  it("reports a pushed ref with unlanded commits and no carrier", () => {
    const finding = classifyPushedRef(fact(), OPTIONS)
    expect(finding?.code).toBe("pushed-not-submitted")
    expect(finding?.ref).toBe("task/example")
    expect(finding?.ageMs).toBe(HOUR)
  })

  it("says nothing about a ref that already has a carrier", () => {
    expect(classifyPushedRef(fact({ carried: true }), OPTIONS)).toBeUndefined()
  })

  it("holds its tongue until the TTL has passed, so a normal push is not a finding", () => {
    // The whole point of push-IS-submit is that admission happens on push; a
    // ref seen one minute old is mid-flight, not stranded.
    expect(classifyPushedRef(fact({ pushedAtMs: NOW - 60_000 }), OPTIONS)).toBeUndefined()
  })

  // 1,502 of 1,546 measured refs are older than seven days. Without this bound
  // the rail's first run is 1,546 rows and its second run is never.
  it("ignores refs older than the age bound — abandoned history is not a to-do list", () => {
    expect(classifyPushedRef(fact({ pushedAtMs: NOW - 8 * 24 * HOUR }), OPTIONS)).toBeUndefined()
  })

  it("ignores a ref whose commits all landed, however they landed", () => {
    // Ancestral: nothing unique left.
    expect(classifyPushedRef(fact({ uniqueCommits: 0 }), OPTIONS)).toBeUndefined()
    // Regenerated: the carrier that merged was not this head, but every commit
    // is patch-equivalent to one already on the base. Ancestry alone calls this
    // unfinished and would have asked its author to redo shipped work.
    expect(classifyPushedRef(fact({ uniqueCommits: 0, equivalentCommits: 6 }), OPTIONS)).toBeUndefined()
  })

  it("carries the unique/equivalent SPLIT rather than a bare verdict", () => {
    // Measured specimen task/ag-lock-survives-crash-dev5: nine commits, two of
    // them already equivalent. Reporting only "unfinished" invites its author
    // to redo the two that shipped.
    const finding = classifyPushedRef(fact({ uniqueCommits: 9, equivalentCommits: 2 }), OPTIONS)
    expect(finding?.uniqueCommits).toBe(9)
    expect(finding?.equivalentCommits).toBe(2)
    expect(finding?.message).toContain("2 of 11 already applied")
  })

  it("names the ref and its age in the message, because a code alone is not actionable", () => {
    const finding = classifyPushedRef(fact({ ref: "task/maddoc-top-bar-r2", pushedAtMs: NOW - 3 * HOUR }), OPTIONS)
    expect(finding?.message).toContain("task/maddoc-top-bar-r2")
    expect(finding?.message).toContain("3h")
  })

  it("treats a ref pushed in the future as due now rather than negative", () => {
    // Clock skew between the pusher and the sweeper must not produce a negative
    // age that silently fails the TTL comparison.
    const finding = classifyPushedRef(fact({ pushedAtMs: NOW + 5 * 60_000 }), OPTIONS)
    expect(finding).toBeUndefined()
  })
})
