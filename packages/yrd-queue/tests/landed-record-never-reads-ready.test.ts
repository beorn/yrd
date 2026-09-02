/**
 * @failure PR3216 rev 1 merged in run #3766 at 06:36 on 2026-09-02 (integration
 *          commit b2e0dc9a) and `queue status` kept printing
 *          `○ ready … (change 'PR3216' checks are queued)` two hours later. The
 *          `pr/integrated` event is applied in a SEPARATE write from the run's
 *          own settle, and the resident restarted at 06:39 in that window, so
 *          the record kept `submitted` / `checks: queued` forever. Two older
 *          records — PR2462 (merged in R3605) and PR2145 (merged in R3590) —
 *          had been printing the same lie since 2026-08-28.
 *
 *          The run record carries the merge proof, so the landing is derivable
 *          without the record's stamp. `queueDisplayState` now reads it, and a
 *          landed change can no longer render as ready whatever the store lost.
 * @level l1
 * @consumer @yrd/queue queue-status-projection (queueDisplayState, landedRunForCurrentRevision)
 */
import { describe, expect, it } from "vitest"
import type { Change } from "@yrd/bay"
import { landedRunForCurrentRevision, queueDisplayState } from "../src/queue-status-projection.ts"
import type { Run } from "../src/model.ts"

const HEAD = "707da89cf0edfd47973459bbce15316f0787d8c6"
const OTHER_HEAD = "addc7651aa1b4c9d8e2f30516a7b9c0d1e2f3a4b"
const MERGE = "b2e0dc9a34b41d04bc55073b6f56680ef7384035"
const BASE = "7f4f3305c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6"

/** An OPEN record whose current revision is submitted and awaiting its run —
 * exactly what PR3216 still read two hours after it merged. */
function submittedChange(head = HEAD, revision = 1): Change {
  return {
    id: "PR3216",
    state: "open",
    branch: "issue/@i/15-docs-reorg/24023-setup-writes-outside-its-own-repository-family-r4",
    base: "main",
    reviews: [],
    revs: [{ n: revision, head, submittedAt: "2026-09-02T13:21:50.659Z" }],
  } as unknown as Change
}

function run(
  overrides: Partial<Run> & Readonly<{ members?: ReadonlyArray<Readonly<{ id: string; revision: number; headSha: string }>> }> = {},
): Run {
  const { members, ...rest } = overrides
  return {
    id: "R3766",
    base: "main",
    status: "completed",
    conclusion: "success",
    integration: { commit: MERGE, baseSha: BASE },
    finishedAt: "2026-09-02T13:36:35.534Z",
    prs: members ?? [{ id: "PR3216", revision: 1, headSha: HEAD }],
    ...rest,
  } as unknown as Run
}

describe("a change its run already merged never reads as ready (L2)", () => {
  it("projects integrated and leaves the pre-run band, though the record still says submitted", () => {
    const pr = submittedChange()
    // The store's own word, unrepaired: this is the lie the surface used to relay.
    expect(queueDisplayState(pr).delivery).toBe("submitted")
    expect(queueDisplayState(pr).preRun).toBe("ready")

    const display = queueDisplayState(pr, { runs: [run()] })
    expect(display.delivery).toBe("integrated")
    expect(display.terminal).toBe(true)
    // `preRun: undefined` is what drops the row from `timelineNonIntegratedRows`.
    expect(display.preRun).toBeUndefined()
  })

  it("names the run that merged it, so a repair pass and the surface share one predicate", () => {
    const landed = landedRunForCurrentRevision(submittedChange(), [run()])
    expect(landed?.id).toBe("R3766")
    expect(landed?.integration?.commit).toBe(MERGE)
  })

  it("ignores a run that merged a DIFFERENT revision of the same change", () => {
    // Revision 2 is open; revision 1 landed. The open revision is not integrated.
    const pr = submittedChange(OTHER_HEAD, 2)
    expect(landedRunForCurrentRevision(pr, [run()])).toBeUndefined()
    expect(queueDisplayState(pr, { runs: [run()] }).preRun).toBe("ready")
  })

  it("ignores a run that is still going, one that failed, and one that merged nothing", () => {
    const pr = submittedChange()
    const running = run({ status: "in_progress", conclusion: undefined, finishedAt: undefined })
    const failed = run({ conclusion: "failure" })
    const noProof = run({ integration: undefined })
    for (const candidate of [running, failed, noProof]) {
      expect(landedRunForCurrentRevision(pr, [candidate])).toBeUndefined()
      expect(queueDisplayState(pr, { runs: [candidate] }).preRun).toBe("ready")
    }
  })

  it("holds for a batch member, not just the run's first change", () => {
    const pr = submittedChange()
    const batch = run({
      members: [
        { id: "PR3221", revision: 1, headSha: OTHER_HEAD },
        { id: "PR3216", revision: 1, headSha: HEAD },
      ],
    })
    expect(landedRunForCurrentRevision(pr, [batch])?.id).toBe("R3766")
    expect(queueDisplayState(pr, { runs: [batch] }).delivery).toBe("integrated")
  })
})
