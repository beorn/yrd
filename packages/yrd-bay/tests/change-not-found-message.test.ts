/**
 * @failure A lookup that finds nothing stops saying WHAT IT SEARCHED — the
 * denominator is re-sourced from the wrong population, silently dropped, or a
 * `pr#N.R` example form is restored for a record store that no longer exists.
 * @level l2
 * @consumer @yrd/bay `changeNotFoundMessage`, shared verbatim by yrd-cli
 * (`pr withdraw`, `run`) and yrd-queue so one sentence serves twelve emitters.
 *
 * This is operator-facing text whose whole job is to be FALSIFIABLE: `searched
 * 0` is honest absence and `searched 686` is a real miss, but a WRONG
 * denominator reads exactly as plausible as a right one — nobody can catch it
 * by eye. So every assertion here pins the rendered line whole rather than a
 * fragment, and the populated fixture is deliberately asymmetric (three submit
 * facts beside two bays) so that a count drawn from the wrong population
 * renders a different number instead of colliding with the right one by luck.
 *
 * S7 (branch-is-change, @i/10 22991) is what made this file necessary: the
 * denominator used to count change records, and the population it counts now —
 * the standing submit facts — is the only one a selector can still name.
 */
import { describe, expect, it } from "vitest"
import { changeNotFoundMessage, emptyBaysState, type Bay, type BaysState } from "../src/model.ts"

const AT = "2026-01-01T00:00:00.000Z"

const bay = (id: string, name: string): Bay => ({
  id,
  name,
  branch: `issue/${name}`,
  base: "main",
  status: "active",
  openedAt: AT,
  refreshedAt: AT,
})

const submit = (sha: string) => ({ sha, base: "main", at: AT })

/** THREE standing submit facts beside TWO bays. The sizes differ on purpose:
 * "searched 3" is a number only the submits can produce, so a denominator
 * re-sourced from `byId` renders 2 and a dropped one renders 0 — every wrong
 * answer is a different string from the right one. */
const populated: BaysState = {
  byId: { B1: bay("B1", "one"), B2: bay("B2", "two") },
  submits: {
    "task/alpha": submit("1".repeat(40)),
    "task/beta": submit("2".repeat(40)),
    "task/gamma": submit("3".repeat(40)),
  },
}

const single: BaysState = { byId: {}, submits: { "task/only": submit("4".repeat(40)) } }

describe("changeNotFoundMessage — the falsifiable empty answer", () => {
  it("reports a zero denominator on an empty vault instead of bare absence", () => {
    // The reason the function exists. Without the count, "no such change" and
    // "the index returned nothing" print the same sentence, and the reader with
    // no way to tell them apart concludes they mistyped — which is how the
    // defect behind @i/10-merge-queue stayed hidden past two seats.
    expect(changeNotFoundMessage(emptyBaysState(), "task/missing")).toBe(
      "yrd: no change 'task/missing' — searched 0 submitted branches",
    )
  })

  it("counts the standing submit facts, and nothing else in the state", () => {
    // Where this file bites. The fixture holds 3 submits and 2 bays, so a
    // denominator taken from `byId` renders "searched 2" and a dropped one
    // "searched 0". Both are plausible sentences; neither is this string.
    expect(changeNotFoundMessage(populated, "task/missing")).toBe(
      "yrd: no change 'task/missing' — searched 3 submitted branches",
    )
  })

  it("agrees with its own count at one, zero and many", () => {
    // A refusal an operator reads should sound like a person wrote it, so the
    // noun agrees with the number rather than hedging as "branch(es)". Pinned
    // at all three counts because the singular is the case a naive `+ "es"`
    // gets wrong, and it is the count a real miss most often has.
    expect(changeNotFoundMessage(single, "task/missing")).toBe(
      "yrd: no change 'task/missing' — searched 1 submitted branch",
    )
    expect(changeNotFoundMessage(emptyBaysState(), "task/missing")).toBe(
      "yrd: no change 'task/missing' — searched 0 submitted branches",
    )
    expect(changeNotFoundMessage(populated, "task/missing")).toBe(
      "yrd: no change 'task/missing' — searched 3 submitted branches",
    )
  })

  it("gives a record-shaped selector the same plain line as any other miss", () => {
    // The `pr#N.R` example half of this message retired with the records it
    // described: there is no population left to draw an example from, and
    // suggesting a form nothing can satisfy is worse than saying nothing.
    // Exact equality is what pins that — it leaves nowhere for a future reader
    // to helpfully append the hint back.
    for (const selector of ["pr#1410.16", "PR1410", "pr1410", "1410"]) {
      expect(changeNotFoundMessage(populated, selector)).toBe(
        `yrd: no change '${selector}' — searched 3 submitted branches`,
      )
    }
    expect(changeNotFoundMessage(populated, "pr#1410.16")).not.toContain("accepted form")

    // Branch names are the selectors that resolve now, and they come back
    // through the identical sentence: the selector is echoed, never classified.
    expect(changeNotFoundMessage(populated, "task/alpha")).toBe(
      "yrd: no change 'task/alpha' — searched 3 submitted branches",
    )
  })
})
