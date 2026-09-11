/**
 * 24454 row 2 — the descent journal has to survive the boundary into yrd.
 *
 * git-super journals its descent into every Ahead parent, including the EQUAL
 * nested children that emit no settle row of their own. That field reached
 * production PARSED AND DROPPED: `readSuperMergeResult` picked
 * state/partial/commit/detail/gitlinks and ignored every other key, and the run
 * journals only what it copies. `checkouts`, the field whose additive-optional
 * shape `descents` follows, has reached ZERO journals ever — which is how
 * @cto found that row 1's premise ("yrd already captures it") was wrong.
 *
 * The fixture is not synthetic. It is git-super's real output for round
 * q-20260911T172747065Z-d40efc18, the one round in 137 whose frozen
 * Git-Super-Push intent classifies km AHEAD with a nested child beneath it,
 * replayed on the bench against that round's own base and remotes. A fabricated
 * fixture would prove the parser reads what I wrote, not what git-super emits.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readSuperMergeResult } from "../src/run.ts"

const FIXTURE = join(import.meta.dirname, "fixtures", "git-super-merge-descents-q20260911T172747065Z.json")

function productionRound(): unknown {
  return JSON.parse(readFileSync(FIXTURE, "utf8"))
}

describe("readSuperMergeResult — the descent journal (24454 row 2)", () => {
  it("reads descents out of git-super's real output for the 2026-09-11 round", () => {
    const result = readSuperMergeResult(productionRound())

    expect(result.state).toBe("updated")
    // The depth-2 classification, which reaches the journal by NO other route:
    // an Equal nested child emits no settle row, so it is absent from gitlinks.
    expect(result.gitlinks.map((row) => row.path)).not.toContain("km/apps/maddoc")
    expect(result.descents).toEqual([
      {
        parent: "km",
        parentTarget: "8c866eade268626d022021805500ccc4eda3226d",
        children: [
          {
            path: "km/apps/maddoc",
            target: "3fff4578a7df24d75df427a186ce1515f160bded",
            state: "equal",
          },
        ],
      },
    ])
  })

  it("treats an ABSENT descents field as none, so an older git-super still parses", () => {
    const round = productionRound() as Record<string, unknown>
    delete round.descents
    const result = readSuperMergeResult(round)
    expect(result.descents).toBeUndefined()
    expect(result.state).toBe("updated")
  })

  it("keeps an EMPTY children array, which says the walk descended and found none", () => {
    const round = productionRound() as Record<string, unknown>
    round.descents = [{ parent: "km", parentTarget: "8c866eade268626d022021805500ccc4eda3226d", children: [] }]
    const result = readSuperMergeResult(round)
    // Dropping this row would erase the difference between "descended, found
    // nothing" and "never descended" — the pair the whole row exists to separate.
    expect(result.descents).toEqual([
      { parent: "km", parentTarget: "8c866eade268626d022021805500ccc4eda3226d", children: [] },
    ])
  })

  it("THROWS on a malformed descent, exactly as a malformed gitlink does", () => {
    // Absent means none; present-and-wrong is a producer defect. Swallowing it
    // would leave the journal quietly incomplete, which is this row's own bug.
    const missingParent = productionRound() as Record<string, unknown>
    missingParent.descents = [{ parentTarget: "8c866eade2", children: [] }]
    expect(() => readSuperMergeResult(missingParent)).toThrow(/descent 0 is incomplete/u)

    const notAnArray = productionRound() as Record<string, unknown>
    notAnArray.descents = { parent: "km" }
    expect(() => readSuperMergeResult(notAnArray)).toThrow(/descents is not an array/u)

    const badChildState = productionRound() as Record<string, unknown>
    badChildState.descents = [
      {
        parent: "km",
        parentTarget: "8c866eade2",
        children: [{ path: "km/apps/maddoc", target: "3fff4578", state: "raised" }],
      },
    ]
    // "raised" is unreachable for a descent child and git-super no longer emits
    // it — so a row claiming it is a producer defect, not a state to accept.
    expect(() => readSuperMergeResult(badChildState)).toThrow(/descent 0 child 0 is incomplete/u)

    const missingChildren = productionRound() as Record<string, unknown>
    missingChildren.descents = [{ parent: "km", parentTarget: "8c866eade2" }]
    expect(() => readSuperMergeResult(missingChildren)).toThrow(/descent 0 has no children array/u)
  })
})
