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
    payloadKind: "content",
    pinDirection: "none",
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
    // Measured specimen task/ag-lock-survives-crash-dev5: NINE commits ahead of
    // the base, of which `git cherry` marks 7 unique (+) and 2 already applied
    // (-). Reporting only "unfinished" invites its author to redo the two that
    // shipped.
    //
    // The first version of this fixture said 9 unique / 2 equivalent, because
    // the measurement script fed `rev-list --count` — the AHEAD count — into
    // the unique field. Ahead is unique PLUS equivalent, so the two numbers can
    // never both be read off the same command. @chief caught it by re-deriving
    // with `git cherry` before acting on the row.
    const finding = classifyPushedRef(fact({ uniqueCommits: 7, equivalentCommits: 2 }), OPTIONS)
    expect(finding?.uniqueCommits).toBe(7)
    expect(finding?.equivalentCommits).toBe(2)
    expect(finding?.message).toContain("2 of 9 already applied")
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

/**
 * Direction is the second, orthogonal verdict — established with @fable/0 on
 * 2026-08-10 by correcting each other in turn.
 *
 * I had DIRECTION blindness: `git cherry` counts patch-equivalence, and for a
 * gitlink bump the patch IS the pointer, so pointer values are never equivalent
 * even when the content behind them already landed. Cherry counts pointers, not
 * payload, and it reported four "unique commits" on a branch that would have
 * deleted five modules from trunk.
 *
 * @fable/0 had LANDEDNESS blindness: a branch whose work landed under a
 * regenerated head has a non-ancestral tip and a pin trunk has moved past, so it
 * reads as a revert risk when it is merely SPENT. Two such rows in their table
 * were carriers of mine that had already integrated.
 *
 * Neither verdict implies the other. Direction says which way the pin walks;
 * landedness says whether there is anything to walk it for.
 */
describe("classifyPushedRef — pin direction", () => {
  it("REFUSES to call a diverged pin a rescue, whatever the commit count says", () => {
    // i10-status-root-narrow-linear-dev3: adds 2, drops 1, and the one it drops
    // is on trunk. Neither side contains the other, so carrying it as-is loses
    // trunk's half however many commits ride along.
    const finding = classifyPushedRef(
      fact({ payloadKind: "gitlink-only", pinDirection: "diverged", uniqueCommits: 4 }),
      OPTIONS,
    )
    expect(finding?.verdict).toBe("rebase-required")
    expect(finding?.message).toContain("DIVERGED")
  })

  it("stays SILENT on a backward gitlink-only ref — trunk already contains it", () => {
    // This is the false-alarm case, and getting it wrong is how the rail dies.
    // `backward` means trunk CONTAINS the branch's pin: nothing to carry and
    // nothing to rebase, the work is already home. @fable/0's file-count scan
    // labelled two of my own integrated carriers "pure revert" for this reason.
    expect(classifyPushedRef(fact({ payloadKind: "gitlink-only", pinDirection: "backward" }), OPTIONS)).toBeUndefined()
    expect(
      classifyPushedRef(fact({ payloadKind: "gitlink-only", pinDirection: "backward", uniqueCommits: 9 }), OPTIONS),
    ).toBeUndefined()
  })

  it("warns on a backward pin when there IS unlanded content — rebase, do not carry", () => {
    // ag-lock-survives-crash-dev5 shape: real unlanded files riding beside pins
    // that would drop 40 ag commits. The content is worth rescuing; this branch
    // is not the way to do it.
    const finding = classifyPushedRef(
      fact({ payloadKind: "content", pinDirection: "backward", uniqueCommits: 7, equivalentCommits: 2 }),
      OPTIONS,
    )
    expect(finding?.verdict).toBe("rebase-required")
    expect(finding?.message).toContain("BACKWARD")
  })

  it("a forward pin on a gitlink-only ref is a genuine bump worth carrying", () => {
    const finding = classifyPushedRef(fact({ payloadKind: "gitlink-only", pinDirection: "forward" }), OPTIONS)
    expect(finding?.verdict).toBe("rescue")
  })

  it("says NOTHING about a gitlink-only ref whose pin already matches trunk", () => {
    // Spent: the bump landed and trunk now carries it. Cherry still calls its
    // commits unique, which is exactly the trap — so the count is not consulted
    // for a gitlink-only payload.
    expect(classifyPushedRef(fact({ payloadKind: "gitlink-only", pinDirection: "aligned" }), OPTIONS)).toBeUndefined()
    expect(
      classifyPushedRef(fact({ payloadKind: "gitlink-only", pinDirection: "aligned", uniqueCommits: 9 }), OPTIONS),
    ).toBeUndefined()
  })

  it("still says nothing about a SPENT content branch even when its pin is forward", () => {
    // PR705/PR706 shape: integrated, tip non-ancestral because the queue
    // regenerated the carrier, zero unlanded commits. Landedness decides here,
    // not direction.
    expect(classifyPushedRef(fact({ uniqueCommits: 0, pinDirection: "forward" }), OPTIONS)).toBeUndefined()
  })
})
