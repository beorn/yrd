/**
 * @failure A refusal prints a remedy the emitting state refuses to run — the
 * PR1189 wedge: `pr recut --preflight` on a `ready` change whose origin branch
 * is gone printed `yrd pr publish <id>`, which admits `pushed` only and answers
 * `change '<id>' is ready, not pushed`. Naming a command that refuses is the
 * same defect as naming none.
 * @level l1
 * @consumer @yrd/cli refusal remedies
 */
import { describe, expect, it } from "vitest"
import { type ChangeDeliveryState } from "@yrd/bay"
import {
  remedyAdmissibleIn,
  unobservableBranchRemedy,
  REMEDY_VERB_ADMISSIBLE_STATES,
  type RemedyVerb,
} from "../src/remedy-admissibility.ts"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)

/** Every delivery state, spelled out. A new state added to the union without a
 * row here fails `exhaustive` below rather than silently skipping the walk. */
const ALL_DELIVERY_STATES: readonly ChangeDeliveryState[] = [
  "pushed",
  "submitted",
  "ready",
  "needs-author",
  "rejected",
  "integrated",
  "already-landed",
  "withdrawn",
  "canceled",
]

const RECORDED = { base: "main", baseSha: BASE, head: HEAD, n: 1 }

describe("every printed remedy is executable in the state that emits it", () => {
  it("names no verb its own guard would refuse, for every delivery state and both observation faults", () => {
    // The walk the bead asks for: each remedy-emitting state against the named
    // command's admission preconditions. `unobservableBranchRemedy` is the ONE
    // emitter for an unobservable branch, so walking its whole domain walks
    // every site.
    const offenders: string[] = []
    for (const delivery of ALL_DELIVERY_STATES) {
      for (const reason of ["absent", "unreachable"] as const) {
        const remedy = unobservableBranchRemedy(reason, { id: "PR1189", branch: "land-row83" }, delivery, RECORDED, "")
        if (remedy.verb !== undefined && !remedyAdmissibleIn(remedy.verb, delivery)) {
          offenders.push(`${reason}/${delivery} printed 'yrd pr ${remedy.verb}', which that state refuses`)
        }
        // A remedy that names no verb must still not smuggle one into its prose:
        // a pasted command line that refuses is the defect, whatever field it sits in.
        for (const verb of Object.keys(REMEDY_VERB_ADMISSIBLE_STATES) as RemedyVerb[]) {
          if (remedy.text.includes(`yrd pr ${verb} `) && !remedyAdmissibleIn(verb, delivery)) {
            offenders.push(`${reason}/${delivery} prose contains 'yrd pr ${verb}', which that state refuses`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("covers the whole delivery-state union, so a new state cannot skip the walk", () => {
    const exhaustive: Record<ChangeDeliveryState, true> = {
      pushed: true,
      submitted: true,
      ready: true,
      "needs-author": true,
      rejected: true,
      integrated: true,
      "already-landed": true,
      withdrawn: true,
      canceled: true,
    }
    expect([...ALL_DELIVERY_STATES].toSorted()).toEqual(Object.keys(exhaustive).toSorted())
  })

  // The two live-guard cross-checks ("table matches the real publish guard" /
  // "…the real withdraw guard") were deleted with the guards themselves (S7
  // branch-is-change, @i/10 22991): bays.requestPublication and bays.closePr
  // retired with the record store, so the table is the only surface left.

  it("the PR1189 shape: a ready change whose branch is gone is told to withdraw, never to publish", () => {
    const remedy = unobservableBranchRemedy(
      "absent",
      { id: "PR1189", branch: "land-row83" },
      "ready",
      RECORDED,
      " --queue",
    )
    expect(remedy.verb).toBe("withdraw")
    expect(remedy.text).not.toContain("yrd pr publish")
    // Acceptance box 3: the disposal verb is DISCOVERABLE from the error text,
    // spelled with the flag that makes it run as pasted.
    expect(remedy.text).toContain("yrd pr withdraw PR1189 --burn-payload")
    expect(remedy.text).toContain("land-row83")
  })

  it("still names publish for the one state publish admits", () => {
    // The remedy is not deleted, it is state-correct: a change that never left
    // `pushed` genuinely is cured by publication, and that guard admits it.
    const remedy = unobservableBranchRemedy("absent", { id: "PR7", branch: "task/draft" }, "pushed", RECORDED, "")
    expect(remedy.verb).toBe("publish")
    expect(remedy.text).toContain("yrd pr publish PR7")
  })

  it("a transport fault on a submitted change asks for no change to the change", () => {
    // Origin being unreachable is not the change's fault; printing a delivery
    // verb here would be a wrong instruction wearing a remedy's clothes.
    const remedy = unobservableBranchRemedy("unreachable", { id: "PR9", branch: "task/x" }, "ready", RECORDED, "")
    expect(remedy.verb).toBeUndefined()
    expect(remedy.text).not.toContain("yrd pr publish")
    expect(remedy.text).not.toContain("yrd pr withdraw")
  })

  it("an absent branch on a terminal change never wears the transport remedy's clothes", () => {
    // The PR2081 incoherence (@i/10-merge-queue/refsfor-withdrawn-carrier):
    // `pr view` of the withdrawn change reported "its branch is gone from
    // origin" and then a remedy claiming origin "could not be reached" and
    // "still advertises" the branch — two contradictory clauses in one error.
    // `absent` is origin's authoritative answer; every state must print a
    // remedy whose clauses are true of it.
    for (const delivery of ["integrated", "already-landed", "withdrawn", "canceled"] as const) {
      const remedy = unobservableBranchRemedy("absent", { id: "PR2081", branch: "issue/x" }, delivery, RECORDED, "")
      expect(remedy.verb).toBeUndefined()
      expect(remedy.text).not.toContain("still advertises")
      expect(remedy.text).not.toContain("could not be reached")
      expect(remedy.text).toContain("origin no longer has branch 'issue/x'")
      expect(remedy.text).toContain(`already ${delivery}`)
      // ONE true remedy: restoring the branch, stated once, with no Yrd verb.
      expect(remedy.text).toContain("restore it on origin")
    }
  })
})
