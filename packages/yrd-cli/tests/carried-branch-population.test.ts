/**
 * @failure The uncarried rail's `pushed-not-submitted` findings are computed over
 * `refs/remotes/origin` MINUS the carried set, and every existing uncarried test
 * supplies that set as a literal `carriedBranches` input. So the one function that
 * actually derives it from runtime state — `carriedBranchSet` — was fenced by
 * nothing: emptying it to `new Set<string>()` left all 119 tests across
 * `uncarried.test.ts`, `uncarried-sweep.test.ts`, `uncarried-facts.test.ts`,
 * `uncarried-rail.test.ts`, `runner-box-live-tick.test.ts`, `runner-box-wrap.test.ts`,
 * `queue-named-subcommand.test.ts` and `habitant-plan-gate.test.ts` GREEN, while every
 * submitted branch in the fleet would have been reported as stranded work.
 *
 * That is the S7 defect class one level out: `classifyPushedRef` is well covered, but a
 * classifier is only as honest as the population handed to it, and under branch-is-change
 * the carried population moved from the deleted `bays.prs` store onto standing submit
 * facts. This file fences the population itself.
 * @level l2
 * @consumer @yrd/cli
 */
import { describe, expect, it } from "vitest"
import { Queues } from "@yrd/queue"
import { carriedBranchSet } from "../src/run.ts"

/** The two fields `carriedBranchSet` reads, and nothing else: a standing submit
 * fact keyed by branch, and the retained run records. */
function appWith(submits: Readonly<Record<string, { sha: string; base: string; at: string }>>) {
  const state = { bays: { submits }, queues: Queues.empty({ batchSize: 1 }) }
  return { state: () => state } as unknown as Parameters<typeof carriedBranchSet>[0]
}

const submit = (sha: string) => ({ sha, base: "main", at: "2026-01-01T00:00:00.000Z" })

describe("carriedBranchSet — the population the uncarried rail subtracts", () => {
  it("counts a standing submit fact as carried, so a submitted branch is never called stranded", () => {
    // The S7 re-sourcing itself. Pre-S7 this read the `bays.prs` store; that store
    // is deleted, and a standing submit fact is what replaced it. If this set ever
    // goes empty, `pushed-not-submitted` fires on every submitted branch at once.
    const carried = carriedBranchSet(appWith({ "issue/submitted": submit("1".repeat(40)) }))

    expect(carried.has("issue/submitted")).toBe(true)
  })

  it("names every standing fact, not just the first", () => {
    const carried = carriedBranchSet(
      appWith({
        "issue/one": submit("1".repeat(40)),
        "issue/two": submit("2".repeat(40)),
        "issue/three": submit("3".repeat(40)),
      }),
    )

    expect([...carried].toSorted()).toEqual(["issue/one", "issue/three", "issue/two"])
  })

  it("leaves a branch with no submit fact uncarried, which is what makes the rail report anything", () => {
    // The other half of the fence. A set that returned every branch would be just
    // as broken as an empty one — it would silence the rail completely — and an
    // assertion on membership alone cannot tell the two apart.
    const carried = carriedBranchSet(appWith({ "issue/submitted": submit("1".repeat(40)) }))

    expect(carried.has("task/pushed-and-forgotten")).toBe(false)
  })

  it("returns an empty set for a fleet that has submitted nothing, without throwing", () => {
    expect([...carriedBranchSet(appWith({}))]).toEqual([])
  })

  /**
   * THE COVERAGE BOUNDARY, pinned because S7 MOVED it and the rail that covers
   * the other side went dark at the same time.
   *
   * Pre-S7, `carried` meant "a change record carries this branch", and a record
   * lived only while its change did. Post-S7 it means "a standing submit fact
   * exists", and `queue.ts` is explicit that nothing retires such a fact on
   * merge — it stands until the receiver sweeps the ref or a re-push renews it.
   * So the carried set only ever GROWS, and `pushed-not-submitted`'s population
   * (origin refs MINUS carried) shrank permanently: a branch that is submitted
   * and going nowhere is, by construction, not this rail's to report.
   *
   * That is correct — the code is named pushed-NOT-submitted — but it is only
   * safe while something else watches the half that fell out. That half belongs
   * to `queue-never-started`, which was itself dark at f7f6d11d, so submitted
   * work that no compose ever served was invisible to BOTH rails at once. This
   * assertion is the marker: if it ever fails, the boundary moved again and
   * `queue-never-started` must be re-checked in the same breath.
   */
  it("treats a submitted-but-unserved branch as carried, handing that half to queue-never-started", () => {
    const carried = carriedBranchSet(appWith({ "issue/submitted-going-nowhere": submit("9".repeat(40)) }))

    expect(carried.has("issue/submitted-going-nowhere")).toBe(true)
  })
})
