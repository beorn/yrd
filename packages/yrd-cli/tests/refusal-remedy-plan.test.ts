/**
 * @failure The runner prints a deterministic refusal remedy every cycle and waits for a human to type it, so one wedged PR loops for hours; or it retries a failed remedy every cycle instead of once per revision.
 * @level l1
 * @consumer @yrd/cli resident runner
 */
import { describe, expect, it } from "vitest"
import type { PR } from "@yrd/bay"
import type { QueueAdmissionRefusal } from "@yrd/queue"
import { planRefusalRemedies, refusalRemedyKey } from "../src/refusal-remedy.ts"

const HEAD = "1".repeat(40)

function pr(id: string, overrides: Partial<PR> = {}): PR {
  return {
    id,
    branch: `task/${id.toLowerCase()}`,
    base: "main",
    revs: [{ n: 1, head: HEAD, at: "2026-07-27T00:00:00.000Z" }],
    reviews: [],
    checkRequests: [{ revision: 1, headSha: HEAD, at: "2026-07-27T00:00:00.000Z" }],
    submittedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  } as unknown as PR
}

function refusal(id: string, overrides: Partial<QueueAdmissionRefusal> = {}): QueueAdmissionRefusal {
  return {
    pr: id,
    code: "authored-gitlink",
    kind: "refusal",
    reason:
      `yrd: PR '${id}' changes generated-only gitlinks [km]; authored root carriers use 'yrd pr submit <branch>', ` +
      `then 'yrd pr recut ${id} --preflight --queue' and run its exact next command on that same PR`,
    count: 3,
    firstAt: "2026-07-27T15:00:00.000Z",
    lastAt: "2026-07-27T15:51:00.000Z",
    ...overrides,
  }
}

describe("refusal remedy plan — the runner acts on exactly the PRs the queue calls wedged", () => {
  it("plans the deterministic drill for a wedged authored-gitlink carrier", () => {
    const plans = planRefusalRemedies({ PR1791: refusal("PR1791") }, { PR1791: pr("PR1791") }, new Set())

    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      pr: "PR1791",
      branch: "task/pr1791",
      revision: 1,
      count: 3,
      key: refusalRemedyKey("PR1791", 1, HEAD),
      remedy: { kind: "self-applicable" },
    })
  })

  it("stays quiet below the queue's own wedge threshold — one losable race is not a wedge", () => {
    expect(planRefusalRemedies({ PR1: refusal("PR1", { count: 1 }) }, { PR1: pr("PR1") }, new Set())).toEqual([])
    expect(planRefusalRemedies({ PR1: refusal("PR1", { count: 2 }) }, { PR1: pr("PR1") }, new Set())).toEqual([])
    expect(planRefusalRemedies({ PR1: refusal("PR1", { count: 3 }) }, { PR1: pr("PR1") }, new Set())).toHaveLength(1)
  })

  it("plans a wedged PR at most once per revision, so a failed remedy is not a retry loop", () => {
    const refusals = { PR1: refusal("PR1", { count: 44 }) }
    const prs = { PR1: pr("PR1") }
    const attempted = new Set<string>()

    const first = planRefusalRemedies(refusals, prs, attempted)
    expect(first).toHaveLength(1)
    attempted.add(first[0]!.key)

    expect(planRefusalRemedies(refusals, prs, attempted)).toEqual([])
  })

  it("plans again once the PR reaches a NEW revision — a fresh revision is fresh evidence", () => {
    const refusals = { PR1: refusal("PR1", { count: 5 }) }
    const attempted = new Set([refusalRemedyKey("PR1", 1, HEAD)])
    const next = "2".repeat(40)
    const advanced = pr("PR1", {
      revs: [
        { n: 1, head: HEAD, at: "2026-07-27T00:00:00.000Z" },
        { n: 2, head: next, at: "2026-07-27T16:00:00.000Z" },
      ],
    } as unknown as Partial<PR>)

    const plans = planRefusalRemedies(refusals, { PR1: advanced }, attempted)

    expect(plans).toHaveLength(1)
    expect(plans[0]?.key).toBe(refusalRemedyKey("PR1", 2, next))
  })

  it("plans judgment-required refusals too — so the escalation is logged once, not every cycle", () => {
    const plans = planRefusalRemedies(
      {
        PR9: refusal("PR9", {
          code: "recut-certificate",
          reason: "yrd: PR 'PR9' recut tree certificate does not match revision 1",
        }),
      },
      { PR9: pr("PR9") },
      new Set(),
    )

    expect(plans).toHaveLength(1)
    expect(plans[0]?.remedy.kind).toBe("judgment")
  })

  it("names nothing for a streak whose PR the state no longer holds", () => {
    expect(planRefusalRemedies({ PR404: refusal("PR404") }, {}, new Set())).toEqual([])
  })

  it("orders plans by PR number so a cycle's remedies are deterministic", () => {
    const plans = planRefusalRemedies(
      { PR20: refusal("PR20"), PR3: refusal("PR3"), PR100: refusal("PR100") },
      { PR20: pr("PR20"), PR3: pr("PR3"), PR100: pr("PR100") },
      new Set(),
    )

    expect(plans.map((plan) => plan.pr)).toEqual(["PR3", "PR20", "PR100"])
  })
})
