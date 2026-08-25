/**
 * @failure A merge-tip refusal that says "fast-forward that submodule's main"
 *          without listing what the FF would drag in is the 3652bfe class:
 *          a rejected commit on submodule main, one pin-bump from the estate.
 * @level l1
 * @consumer @yrd/core
 *
 * Refs: @chief 62a8019c — print `git cherry <estate-pin> <submodule-main>`
 * before the FF verb. Not a sibling of 23140 (review door); this is the
 * worker-facing remedy text.
 */
import { describe, expect, it } from "vitest"
import { failureFact } from "../src/failure.ts"
import { cherryFfInstruction, parseCherryVerbose } from "../src/linear-tip.ts"

describe("cherryFfInstruction", () => {
  it("prints the git cherry command when the unique list is not in hand", () => {
    expect(cherryFfInstruction()).toMatch(/git cherry <estate-pin> <submodule-main>/u)
    expect(cherryFfInstruction()).toMatch(/empty unique list = no-op/u)
  })

  it("says the FF is a no-op when the unique list is empty", () => {
    expect(cherryFfInstruction({ unique: [], notYours: 0, unreviewed: 0 })).toMatch(/FF is a no-op/u)
    expect(cherryFfInstruction({ unique: [], notYours: 0, unreviewed: 0 })).not.toMatch(/dragged set/u)
  })

  it("names the dragged set with N not-yours and M unreviewed", () => {
    const text = cherryFfInstruction({
      unique: [{ sha: "3652bfe", subject: "fix(process): retry a STALLED read-only git call" }],
      notYours: 1,
      unreviewed: 1,
    })
    expect(text).toMatch(/dragged set \(1 unique\): 3652bfe /u)
    expect(text).toMatch(/1 are not yours and 1 are unreviewed/u)
  })

  it("names the dragged set without inventing N/M when those counts are not in hand", () => {
    const text = cherryFfInstruction({
      unique: [{ sha: "3652bfe", subject: "fix(process): retry a STALLED read-only git call" }],
    })
    expect(text).toMatch(/dragged set \(1 unique\): 3652bfe /u)
    expect(text).not.toMatch(/not yours/u)
    expect(text).not.toMatch(/unreviewed/u)
  })
})

describe("parseCherryVerbose", () => {
  it("returns an empty unique list when cherry is empty or only equivalents", () => {
    expect(parseCherryVerbose("")).toEqual([])
    expect(parseCherryVerbose("- 21d0a4b already in the estate\n")).toEqual([])
  })

  it("keeps only unique (+) rows as the dragged set", () => {
    expect(
      parseCherryVerbose(
        "+ 3652bfe fix(process): retry a STALLED read-only git call\n" +
          "- 21d0a4b already applied\n" +
          "+ abcdef0 feat(queue): another unique\n",
      ),
    ).toEqual([
      { sha: "3652bfe", subject: "fix(process): retry a STALLED read-only git call" },
      { sha: "abcdef0", subject: "feat(queue): another unique" },
    ])
  })
})
