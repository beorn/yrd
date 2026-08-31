/**
 * @failure The queue dashboard's "no merge for N" clock read the RECORD store
 * and stopped there. `state.prs` holds record-lane changes only — a derived
 * member is composed at the S6 door and leaves no row there by design — and the
 * reader PREFERRED that source whenever Bays state was available, so the
 * retained terminal facts, which carry both lanes, were never consulted.
 *
 * Nearly all traffic is derived now, so the clock froze at the last record-lane
 * merge. Measured on the live queue 2026-08-31: the panel read "no merge for
 * 2:11:32" twelve minutes after PR2816 merged, and "no merge for 3:02:42" eight
 * minutes after PR2823. Two seats read that line as an outage on the same
 * afternoon, and one of them stopped the runner over it.
 *
 * FOURTH reader found with this defect, after whole-population eligibility, the
 * tracker bridges, and the runner's published merge position. The other three
 * were cured by moving to the change population; this one is a view with only
 * Bays state in scope, so it unions its two sources instead. That is safe in
 * the direction that matters: neither source can invent a merge, so a union can
 * only move the answer forward to one that some source can prove.
 *
 * Verified to discriminate: with the record-preferring branch restored, the
 * first case asserts `expected null to be 1788203382000` — the derived merge is
 * invisible and the panel reports no merge at all.
 * @level l2
 * @consumer @yrd/cli queue dashboard runner box
 */
import { describe, expect, it } from "vitest"
import { timelineLastMergeMs } from "../src/queue-status-view.tsx"

const RECORD_MERGE_MS = Date.parse("2026-08-31T17:10:09.000Z")
const DERIVED_MERGE_MS = Date.parse("2026-08-31T19:09:42.000Z")

type Projection = Parameters<typeof timelineLastMergeMs>[0]
type Bays = Parameters<typeof timelineLastMergeMs>[1]

/** Only the two fields this reader touches. The rest of the projection is a
 * large view model the clock never consults, and building one here would hide
 * which inputs the answer actually depends on. */
function projection(facts: readonly { outcome: string; terminalAtMs: number }[]): Projection {
  return { base: "main", timeStatsFacts: facts } as unknown as Projection
}

/** A record-lane change with an integrated terminal, shaped as the store holds
 * it. A DERIVED merge has no counterpart here — that absence is the defect. */
function bays(integratedAt: string | undefined): Bays {
  if (integratedAt === undefined) return { prs: {} } as unknown as Bays
  return {
    prs: {
      PR1: {
        id: "PR1",
        base: "main",
        revs: [{ terminal: { kind: "integrated", at: integratedAt } }],
      },
    },
  } as unknown as Bays
}

describe("the dashboard merge clock reads both admission lanes", () => {
  it("reports a DERIVED merge the record store cannot see — the frozen clock this pins", () => {
    expect(
      timelineLastMergeMs(projection([{ outcome: "integrated", terminalAtMs: DERIVED_MERGE_MS }]), bays(undefined)),
      "a derived merge left no record row, and preferring the record store reported no merge at all",
    ).toBe(DERIVED_MERGE_MS)
  })

  it("takes the NEWER of the two sources, not whichever source it looked at first", () => {
    expect(
      timelineLastMergeMs(
        projection([{ outcome: "integrated", terminalAtMs: DERIVED_MERGE_MS }]),
        bays("2026-08-31T17:10:09.000Z"),
      ),
      "the live shape: a record-lane merge two hours stale beside a fresh derived one",
    ).toBe(DERIVED_MERGE_MS)
  })

  it("still answers from the record store when the retained facts carry no merge", () => {
    expect(
      timelineLastMergeMs(
        projection([{ outcome: "failed", terminalAtMs: DERIVED_MERGE_MS }]),
        bays("2026-08-31T17:10:09.000Z"),
      ),
    ).toBe(RECORD_MERGE_MS)
  })

  it("reports null when NEITHER source proves a merge — never a zero, never a floor", () => {
    expect(timelineLastMergeMs(projection([]), bays(undefined))).toBeNull()
  })

  it("ignores a merge on another base", () => {
    const other = { base: "release/2.0", timeStatsFacts: [] } as unknown as Projection
    expect(timelineLastMergeMs(other, bays("2026-08-31T17:10:09.000Z"))).toBeNull()
  })
})
