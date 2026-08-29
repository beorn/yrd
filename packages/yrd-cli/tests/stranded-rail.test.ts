/**
 * @failure The stranded rail renders a stored count as if it were current, or
 *          renders an absent measurement as zero.
 * @level   l1
 * @consumer @yrd/core/22716-yrd-hardening-program/p2-push-is-submit
 */
import { describe, expect, it } from "vitest"
import {
  strandedCoverageFloor,
  strandedDenominator,
  strandedFloorCount,
  strandedLine,
  strandedObservation,
  strandedRailColor,
  type StrandedBuckets,
  type StrandedObservation,
} from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-08-12T02:00:00.000Z")

function observed(count: number, agoMs: number, scanned = 4784, missingUpdateClocks = 0): StrandedObservation {
  return strandedObservation({ count, scanned, missingUpdateClocks, observedAt: new Date(NOW - agoMs).toISOString() })
}

/** Re-mint with an added/overridden field, since the derived coverage fields
 * must be recomputed rather than spread from a record built without them. */
function withMeasurable(base: StrandedObservation, measurable: number): StrandedObservation {
  return strandedObservation({ ...base, measurable })
}

describe("strandedLine", () => {
  it("never renders an unmeasured rail as zero", () => {
    // The whole reason the rail is trustworthy. "0" and "nobody looked" are
    // different facts about the fleet, and collapsing them asserts a healthy
    // queue that was never swept.
    const line = strandedLine(undefined, NOW)
    // Plain language, own label (operator ruling 2026-08-18, item 15):
    // "STRANDED — the sweep hasn't produced an observation yet".
    expect(line).toContain("STRANDED")
    expect(line).toContain("the sweep hasn't produced an observation yet")
    expect(line).not.toMatch(/\b0\b/u)
  })

  it("carries the age on every reading, including a healthy zero", () => {
    // A zero is exactly where staleness hides: nothing about "0 stranded"
    // looks wrong when the runner died three hours ago.
    expect(strandedLine(observed(0, 4 * 60_000), NOW)).toContain("as of 4m ago")
    expect(strandedLine(observed(3, 90 * 60_000), NOW)).toContain("as of 1h30m ago")
  })

  it("says how long ago a dead runner last looked, rather than going quiet", () => {
    const line = strandedLine(observed(0, 3 * 60 * 60_000), NOW)
    expect(line).toContain("as of 3h ago")
    expect(line).toContain("0 of 4784 refs")
  })

  it("reports the denominator so a small number is readable", () => {
    expect(strandedLine(observed(3, 60_000, 4784), NOW)).toContain("3 of 4784 refs")
  })

  it("reports refs without retained update clocks on the habitant rail", () => {
    expect(strandedLine(observed(3, 60_000, 4784, 12), NOW)).toContain("12 refs without retained update clocks")
  })

  it("does not interpret an old habitant's missing clock field as complete coverage", () => {
    // The shape a pre-coverage habitant's status.json still deserializes to:
    // no clock counts at all. Minting is the repair — it is what stops that
    // record reaching a renderer as a bare count.
    const oldObservation = strandedObservation({
      count: 0,
      scanned: 4784,
      observedAt: new Date(NOW - 60_000).toISOString(),
    })
    expect(strandedLine(oldObservation, NOW)).toContain("push-clock coverage unknown")
    expect(oldObservation.bounded).toBe("≥0")
  })

  it("says the count is a floor and what share of the population it could measure", () => {
    // Measured 2026-08-14: 2,442 of 2,786 stranded refs had no retained
    // reflog clock, so the rail judged 12% of its population. A bare "63"
    // beside an 88% blind spot reads as a total, and a bare "0" from the same
    // reading reads as a clean fleet — which is the reading that gets a
    // monitoring rail trusted right up until it misses everything.
    const line = strandedLine(withMeasurable(observed(63, 60_000, 3618, 2442), 344), NOW)
    expect(line).toContain("≥63 of 3618 refs")
    expect(line).toContain("a floor")
    expect(line).toContain("12% of 2786 candidates measurable")
    expect(line).toContain("2442 refs without retained update clocks")
  })

  it("marks a zero as a floor too, so an unmeasured population cannot read as clean", () => {
    const line = strandedLine(withMeasurable(observed(0, 60_000, 3618, 2442), 344), NOW)
    expect(line).toContain("≥0 of 3618 refs")
    expect(line).toContain("a floor")
  })

  it("drops the floor marker only when every candidate was actually measured", () => {
    const line = strandedLine(withMeasurable(observed(2, 60_000, 3618, 0), 344), NOW)
    expect(line).toContain("stranded 2 of 3618 refs")
    expect(line).not.toContain("≥")
    expect(line).toContain("every candidate had a retained update clock")
  })

  it("does not round a sliver of coverage down to none measurable", () => {
    // "0% measurable" says the sweep saw nothing; it saw one ref. Different
    // facts, and the rounded one invites someone to switch the rail off.
    const line = strandedLine(withMeasurable(observed(1, 60_000, 3618, 999), 1), NOW)
    expect(line).toContain("<1% of 1000 candidates measurable")
  })

  it("does not claim a candidate population an older habitant never recorded", () => {
    const line = strandedLine(observed(3, 60_000, 4784, 12), NOW)
    expect(line).toContain("against an unknown candidate population")
    expect(line).not.toContain("candidates measurable")
  })

  it("bounds its own count through the shared helper the command also uses", () => {
    // One definition of "this number is a floor", so the rail and
    // `queue uncarried` cannot phrase the same gap differently — the drift the
    // floor was introduced to close (22925).
    const partial = withMeasurable(observed(63, 60_000, 3618, 2442), 344)
    expect(strandedLine(partial, NOW)).toContain(`stranded ${strandedFloorCount(63, 2442)} of`)
  })

  it("does not render a future observation as a negative age", () => {
    // Clock skew between the runner host and the viewer is real; a negative
    // age would read as a nonsense future measurement rather than a fresh one.
    expect(strandedLine(observed(1, -30_000), NOW)).toContain("under a minute")
  })
})

describe("strandedObservation — coverage travels ON the record, not beside it", () => {
  it("mints the floor as a FIELD, so a JSON emission cannot serialize the count without it", () => {
    // Five machine consumers serialize this object (queue.uncarried --json,
    // queue.list, the watch stream, RunnerHealthFacts, the habitant heartbeat).
    // Every one of them used to carry a bare `count`. Making coverage a field
    // rather than a call-site concern fixes them all by construction.
    const observation = strandedObservation({
      count: 33,
      scanned: 4071,
      measurable: 391,
      missingUpdateClocks: 2211,
      observedAt: new Date(NOW).toISOString(),
    })

    expect(observation.floor).toContain("a floor")
    expect(observation.floor).toContain("2211 refs without retained update clocks")
    expect(observation.bounded).toBe("≥33")
    expect(JSON.parse(JSON.stringify(observation))).toMatchObject({ floor: observation.floor, bounded: "≥33" })
  })

  it("says every candidate was measured when the sweep really did measure them all", () => {
    const observation = strandedObservation({
      count: 2,
      scanned: 10,
      measurable: 10,
      missingUpdateClocks: 0,
      observedAt: new Date(NOW).toISOString(),
    })

    expect(observation.bounded).toBe("2")
    expect(observation.floor).toBe("every candidate had a retained update clock")
  })
})

describe("strandedRailColor — colour claims an ACTION, coverage lives in the text", () => {
  const partialZero = withMeasurable(observed(0, 60_000, 3618, 2442), 344)

  it("warns only when the sweep actually found stranded work", () => {
    expect(strandedRailColor(withMeasurable(observed(7, 60_000, 3618, 2442), 344))).toBe("$fg-warning")
  })

  it("stays muted on a zero even when most of the population went unmeasured", () => {
    // Ruled deliberately (@chief 2026-08-17) against the instinct this file
    // otherwise teaches: a partial-coverage zero really is an unmeasured fleet,
    // but colouring it would light the rail permanently on a real repository
    // and re-create the noise that got the previous rail ignored. The honesty
    // is carried by the TEXT, which is asserted immediately below.
    expect(strandedRailColor(partialZero)).toBe("$fg-muted")
    expect(strandedLine(partialZero, NOW)).toContain("≥0")
    expect(strandedLine(partialZero, NOW)).toContain("a floor")
  })

  it("leaves an unswept rail muted, because it makes no claim at all", () => {
    expect(strandedRailColor(undefined)).toBe("$fg-muted")
  })
})

describe("strandedFloorCount", () => {
  it("marks any count from a partly-measured sweep as a floor", () => {
    // The acceptance the runner box already met and the `queue uncarried`
    // command did not: a count drawn from 15% coverage is a floor on EVERY
    // surface that prints it, not only the one that happened to be written
    // first (@i/10-merge-queue/22925-watch-shows-every-pr).
    expect(strandedFloorCount(33, 2211)).toBe("≥33")
    expect(strandedFloorCount(0, 2211)).toBe("≥0")
  })

  it("drops the bound only when every candidate carried a retained clock", () => {
    expect(strandedFloorCount(4, 0)).toBe("4")
    expect(strandedFloorCount(0, 0)).toBe("0")
  })

  it("treats unknown coverage as a floor, never as complete coverage", () => {
    // An older habitant that cannot report its clock gap has not proven it had
    // none; assuming completeness is how a partial sweep reads as a total.
    expect(strandedFloorCount(7, undefined)).toBe("≥7")
  })
})

describe("unenumerable refs are a coverage gap, not a rounding error", () => {
  it("refuses to call coverage complete while a ref went unenumerable", () => {
    // The whole point of the skipped bucket. A sweep that hit a ref with no
    // merge base measured LESS of the fleet than one that did not, and saying
    // "every candidate had a retained update clock" here would be true about
    // clocks and false about coverage — the exact under-count that made
    // skipping worse than the original crash.
    expect(strandedCoverageFloor(51, 0, 1)).not.toContain("every candidate")
    expect(strandedCoverageFloor(51, 0, 1)).toContain("1 ref with no merge base")
    expect(strandedCoverageFloor(51, 0, 1)).toContain("a floor")
  })

  it("still reports full coverage when nothing was skipped", () => {
    expect(strandedCoverageFloor(51, 0, 0)).toBe("every candidate had a retained update clock")
  })

  it("names both gaps separately rather than folding one into the other", () => {
    // A ref with no merge base is not a ref with no clock. Folding them would
    // attribute the gap to a cause that was never measured.
    const line = strandedCoverageFloor(592, 2211, 1)
    expect(line).toContain("2211 refs without retained update clocks")
    expect(line).toContain("1 ref with no merge base")
  })

  it("counts unenumerable refs in the candidate population, never as coverage", () => {
    // 1 measurable of 2 candidates is 50%. Dropping the skipped ref from the
    // denominator would report 100% and flatter the sweep with the very ref it
    // could not judge.
    expect(strandedCoverageFloor(1, 0, 1)).toContain("50% of 2 candidates measurable")
  })

  it("bounds the count as a floor when a ref was skipped, even with perfect clocks", () => {
    expect(strandedFloorCount(21, 0, 1)).toBe("\u226521")
    expect(strandedFloorCount(21, 0, 0)).toBe("21")
  })

  it("pluralises the gap so a single skipped ref does not read as a tally bug", () => {
    expect(strandedCoverageFloor(51, 0, 2)).toContain("2 refs with no merge base")
  })
})

describe("strandedDenominator — a policy exclusion a reader cannot see is a silent one", () => {
  const BUCKETS = {
    scanned: 6352,
    carried: 12,
    exempt: 7,
    superseded: 40,
    outsideAgeBound: 6280,
    examined: 9,
    missingUpdateClocks: 3,
    unenumerable: 1,
  } as const satisfies StrandedBuckets

  it("names the policy exclusions rather than folding them into another bucket", () => {
    // The rail's own ruling: exempt, never silent. Refs dropped by policy that
    // appeared nowhere would be indistinguishable from a rail that quietly
    // stopped covering a namespace.
    expect(strandedDenominator(BUCKETS)).toContain("7 exempt by policy")
  })

  it("prints the exemption bucket at zero too", () => {
    // A term that appears only when non-zero cannot be used to check the
    // identity, which is the only reason the line carries every term at all.
    expect(strandedDenominator({ ...BUCKETS, exempt: 0 })).toContain("0 exempt by policy")
  })

  it("carries every term, so the identity is checkable from the line alone", () => {
    const line = strandedDenominator(BUCKETS)
    // Derived a second way: pull the numbers back OUT of the rendered line and
    // require them to reconstruct `scanned`. A dropped term does not read as a
    // bug — it reads as a smaller fleet — so nothing but the sum catches it.
    const printed = [
      ...line.matchAll(/(\d+)(?= carried| exempt| superseded| outside| examined| refs without| unenumerable)/gu),
    ].map((match) => Number(match[1]))
    expect(printed).toHaveLength(7)
    expect(printed.reduce((sum, term) => sum + term, 0)).toBe(BUCKETS.scanned)
  })
})
