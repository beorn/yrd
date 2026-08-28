/**
 * @failure The runner prints a deterministic refusal remedy every cycle and waits for a human to type it, so one wedged PR loops for hours; or it retries a failed remedy every cycle instead of once per revision.
 * @level l1
 * @consumer @yrd/cli habitant runner
 */
import { describe, expect, it } from "vitest"
import type { QueueAdmissionRefusal } from "@yrd/queue"
import { planRefusalRemedies, refusalRemedyKey, type RefusalRemedySubject } from "../src/refusal-remedy.ts"

const HEAD = "1".repeat(40)

/** What one refusal streak names since S7: the retained run member's identity
 * plus the branch's standing submit fact, resolved by the caller. */
function subject(id: string, overrides: Partial<RefusalRemedySubject> = {}): RefusalRemedySubject {
  return { id, branch: `task/${id.toLowerCase()}`, revision: 1, headSha: HEAD, redeliverable: true, ...overrides }
}

/** The lookup the runner threads in, over a fixed table — a streak naming an id
 * the table does not hold resolves to `undefined`, as it does in the runner. */
function subjects(
  table: Readonly<Record<string, RefusalRemedySubject>>,
): (id: string) => RefusalRemedySubject | undefined {
  return (id) => table[id]
}

function refusal(id: string, overrides: Partial<QueueAdmissionRefusal> = {}): QueueAdmissionRefusal {
  return {
    pr: id,
    code: "authored-gitlink",
    kind: "refusal",
    reason: `yrd: change '${id}' changes generated-only gitlinks [km]`,
    count: 3,
    firstAt: "2026-07-27T15:00:00.000Z",
    lastAt: "2026-07-27T15:51:00.000Z",
    ...overrides,
  }
}

describe("refusal remedy plan — the runner acts on exactly the PRs the queue calls wedged", () => {
  it("plans one needs-person settlement for a wedged authored-gitlink carrier", () => {
    const plans = planRefusalRemedies({ PR1791: refusal("PR1791") }, subjects({ PR1791: subject("PR1791") }), new Set())

    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      pr: "PR1791",
      branch: "task/pr1791",
      revision: 1,
      count: 3,
      key: refusalRemedyKey("PR1791", 1, HEAD),
      remedy: { kind: "judgment" },
    })
  })

  it("stays quiet below the queue's own wedge threshold — one losable race is not a wedge", () => {
    expect(planRefusalRemedies({ PR1: refusal("PR1", { count: 1 }) }, subjects({ PR1: subject("PR1") }), new Set())).toEqual([])
    expect(planRefusalRemedies({ PR1: refusal("PR1", { count: 2 }) }, subjects({ PR1: subject("PR1") }), new Set())).toEqual([])
    expect(planRefusalRemedies({ PR1: refusal("PR1", { count: 3 }) }, subjects({ PR1: subject("PR1") }), new Set())).toHaveLength(1)
  })

  it("keeps a judgment-required environment refusal below the queue's wedge threshold", () => {
    const missingObject = (count: number) =>
      refusal("PR1", {
        code: "recut-gitlink-object-missing",
        reason: "submodule 'km' commit 'abc123' is not present in its local store; fetch it and retry",
        count,
      })

    expect(planRefusalRemedies({ PR1: missingObject(1) }, subjects({ PR1: subject("PR1") }), new Set())).toEqual([])
    expect(planRefusalRemedies({ PR1: missingObject(2) }, subjects({ PR1: subject("PR1") }), new Set())).toEqual([])
    expect(planRefusalRemedies({ PR1: missingObject(3) }, subjects({ PR1: subject("PR1") }), new Set())).toHaveLength(1)
  })

  it("plans a wedged PR at most once per revision, so a failed remedy is not a retry loop", () => {
    const refusals = { PR1: refusal("PR1", { count: 44 }) }
    const subjectOf = subjects({ PR1: subject("PR1") })
    const attempted = new Set<string>()

    const first = planRefusalRemedies(refusals, subjectOf, attempted)
    expect(first).toHaveLength(1)
    attempted.add(first[0]!.key)

    expect(planRefusalRemedies(refusals, subjectOf, attempted)).toEqual([])
  })

  it("plans again once the change reaches a NEW revision — a fresh revision is fresh evidence", () => {
    const refusals = { PR1: refusal("PR1", { count: 5 }) }
    const attempted = new Set([refusalRemedyKey("PR1", 1, HEAD)])
    const next = "2".repeat(40)
    const advanced = subject("PR1", { revision: 2, headSha: next })

    const plans = planRefusalRemedies(refusals, subjects({ PR1: advanced }), attempted)

    expect(plans).toHaveLength(1)
    expect(plans[0]?.key).toBe(refusalRemedyKey("PR1", 2, next))
  })

  it("plans judgment-required refusals too — so the escalation is logged once, not every cycle", () => {
    const plans = planRefusalRemedies(
      {
        PR9: refusal("PR9", {
          code: "recut-certificate",
          reason: "yrd: change 'PR9' recut tree certificate does not match revision 1",
        }),
      },
      subjects({ PR9: subject("PR9") }),
      new Set(),
    )

    expect(plans).toHaveLength(1)
    expect(plans[0]?.remedy.kind).toBe("judgment")
  })

  it("does not re-plan a durably settled refusal after process restart (22528)", () => {
    const settled = refusal("PR9", {
      revision: 1,
      headSha: HEAD,
      settlement: {
        disposition: "needs-person",
        reason: "the recut certificate requires human judgment",
        settledAt: "2026-07-27T16:00:00.000Z",
      },
    })

    expect(planRefusalRemedies({ PR9: settled }, subjects({ PR9: subject("PR9") }), new Set())).toEqual([])
  })

  it("names nothing for a streak whose PR the state no longer holds", () => {
    expect(planRefusalRemedies({ PR404: refusal("PR404") }, subjects({}), new Set())).toEqual([])
  })

  it("escalates a streak whose branch has no standing submit fact left", () => {
    // The subject's `redeliverable` is the S7 replacement for the record's
    // terminal-delivery test; it has to reach the classifier or an ended
    // delivery would be resubmitted mechanically.
    const plans = planRefusalRemedies(
      {
        PR1: refusal("PR1", {
          code: "composition-invalid",
          reason:
            "yrd: change 'PR1' needs a certified refresh; " +
            "tracked changes re-merge implicitly; fallback: 'yrd pr submit <branch>'",
        }),
      },
      subjects({ PR1: subject("PR1", { redeliverable: false }) }),
      new Set(),
    )

    expect(plans).toHaveLength(1)
    expect(plans[0]?.remedy).toEqual({
      kind: "judgment",
      reason:
        "this delivery has ended — no submit fact stands for its branch, " +
        "so it cannot be redelivered mechanically",
    })
  })

  it("orders plans by PR number so a cycle's remedies are deterministic", () => {
    const plans = planRefusalRemedies(
      { PR20: refusal("PR20"), PR3: refusal("PR3"), PR100: refusal("PR100") },
      subjects({ PR20: subject("PR20"), PR3: subject("PR3"), PR100: subject("PR100") }),
      new Set(),
    )

    expect(plans.map((plan) => plan.pr)).toEqual(["PR3", "PR20", "PR100"])
  })
})
