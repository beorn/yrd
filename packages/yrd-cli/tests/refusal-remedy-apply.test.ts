/**
 * @failure The resident can mistake an author-owned intent remedy for a safe PR rewrite, or re-apply a failed mechanical remedy every cycle instead of degrading to the printed refusal.
 * @level l2
 * @consumer @yrd/cli resident runner
 */
import { describe, expect, it } from "vitest"
import { createFailure } from "@yrd/core"
import { applyRefusalRemedies } from "../src/run.ts"
import type { YrdCliApp, YrdCliIO, YrdCliServices } from "../src/types.ts"

const HEAD = "1".repeat(40)
const NEXT = "2".repeat(40)
const BASE = "a".repeat(40)
const TARGET = "b".repeat(40)

type Call = Readonly<{ op: string; detail?: string }>
type LogCall = Readonly<{ message: string; props: Record<string, unknown> }>

function mechanicalRemergeReason(pr: string): string {
  return `yrd: PR '${pr}' needs a certified refresh; run 'yrd pr recut ${pr} --preflight --queue --apply'`
}

function harness(
  options: Readonly<{
    code?: string
    reason?: string
    count?: number
    /** Fail the named operation, the way a real remedy step can refuse. */
    failOn?: string
    /** Preflight verdict the recut classifier reaches. */
    verdict?: "RECUT" | "RECUT-FORCE" | "FRESH-NOOP" | "SUBSUMED-WITHDRAW"
  }> = {},
) {
  const calls: Call[] = []
  const infos: LogCall[] = []
  const warns: LogCall[] = []
  const verdict = options.verdict ?? "RECUT"
  let head = HEAD
  let revision = 1
  let settled = false
  const guard = (op: string, detail?: string): void => {
    calls.push({ op, ...(detail === undefined ? {} : { detail }) })
    if (options.failOn === op) {
      throw createFailure({ kind: "refusal", code: "recut-not-ready", message: `yrd: ${op} refused` })
    }
  }
  const pr = () => ({
    id: "PR1791",
    state: "open",
    merged: false,
    branch: "task/22474-carrier",
    base: "main",
    revs: [
      {
        n: revision,
        head,
        baseSha: BASE,
        at: "2026-07-27T15:00:00.000Z",
        submittedAt: "2026-07-27T15:00:00.000Z",
        // FRESH-NOOP is "already certified onto the current base"; only a recut
        // revision can be that.
        ...(verdict === "FRESH-NOOP"
          ? { recut: { fromRevision: 1, treeSha: "c".repeat(40), patchId: "d".repeat(40) } }
          : {}),
      },
    ],
    reviews: [],
    checkRequests: [{ revision, headSha: head, baseSha: BASE, at: "2026-07-27T15:00:00.000Z" }],
  })
  const app = {
    state: () => ({
      bays: { prs: { PR1791: pr() } },
      queues: {
        admissionRefusals: {
          PR1791: {
            pr: "PR1791",
            code: options.code ?? "composition-invalid",
            kind: "refusal",
            reason: options.reason ?? mechanicalRemergeReason("PR1791"),
            count: options.count ?? 3,
            firstAt: "2026-07-27T15:00:00.000Z",
            lastAt: "2026-07-27T15:51:00.000Z",
            ...(settled
              ? {
                  revision,
                  headSha: head,
                  settlement: {
                    disposition: "needs-person",
                    reason: "the recut certificate requires human judgment",
                    settledAt: "2026-07-27T16:00:00.000Z",
                  },
                }
              : {}),
          },
        },
      },
    }),
    log: {
      info: (message: string, props: Record<string, unknown>) => infos.push({ message, props }),
      warn: (message: string, props: Record<string, unknown>) => warns.push({ message, props }),
    },
    bays: {
      pr: () => pr(),
      reviewState: () => ({ current: undefined }),
      checksRequested: () => true,
      ready: async () => guard("ready"),
      requestChecks: async () => guard("requestChecks"),
      submitSelection: async (selector: string) => {
        guard("submitSelection", selector)
        head = NEXT
        revision = 2
        return pr()
      },
      recut: async () => {
        guard("bays.recut")
        return { events: [{ name: "pr/recut" }] }
      },
    },
    queue: {
      eligibility: () => ({ checks: { status: verdict === "RECUT-FORCE" ? "passed" : "queued" } }),
      cancel: async () => guard("queue.cancel"),
      cancelAdmissionJobs: async () => {
        guard("queue.cancelAdmissionJobs")
        return []
      },
      settleAdmissionRefusal: async () => {
        guard("queue.settleAdmissionRefusal")
        settled = true
      },
    },
  } as unknown as YrdCliApp
  const io = {
    cwd: "/repo",
    stdout: () => undefined,
    stderr: () => undefined,
    pruneGit: () => ({
      // Every ref this preflight resolves is present: the base tip, and the
      // PR head the submit step just recorded.
      resolveCommit: async (ref: string) => (ref === "origin/main" || ref === "main" ? TARGET : ref),
      isAncestor: async () => verdict === "SUBSUMED-WITHDRAW",
      mergeTree: async () => "tree-merged",
      treeOf: async () => (verdict === "SUBSUMED-WITHDRAW" ? "tree-merged" : "tree-base"),
      pinDistance: async () => ({ sourceOnly: 0, targetOnly: verdict === "FRESH-NOOP" ? 0 : 3 }),
      patchMatch: async () => ({}),
    }),
  } as unknown as YrdCliIO
  const services = {
    recut: {
      recut: async () => {
        guard("services.recut")
        return { headSha: NEXT, baseSha: TARGET, treeSha: "c".repeat(40), patchId: "d".repeat(40) }
      },
    },
  } as unknown as YrdCliServices
  return { app, io, services, calls, infos, warns, ops: () => calls.map((call) => call.op) }
}

describe("resident refusal remedies — only PR-local drills are self-applied", () => {
  it("settles authored-gitlink as needs-person without mutating the PR", async () => {
    const h = harness({
      code: "authored-gitlink",
      reason:
        "yrd: PR 'PR1791' changes generated-only gitlinks [km]; use " +
        "'yrd intent submit --component km --target 1111111111111111111111111111111111111111 --issue one'",
    })

    const outcomes = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    expect(outcomes).toEqual([expect.objectContaining({ status: "escalated", pr: "PR1791", code: "authored-gitlink" })])
    expect(h.ops()).toEqual(["queue.settleAdmissionRefusal"])
  })

  it("runs the printed drill end to end and logs every applied command verbatim", async () => {
    const h = harness()

    const outcomes = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    expect(outcomes).toEqual([
      {
        status: "applied",
        pr: "PR1791",
        revision: 1,
        code: "composition-invalid",
        count: 3,
        commands: ["yrd pr recut PR1791 --preflight --queue --apply", "yrd pr recut PR1791 --queue"],
        verdict: "RECUT",
      },
    ])
    expect(h.ops()).not.toContain("submitSelection")
    expect(h.ops()).toContain("services.recut")
    expect(h.infos).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          action: "queue-refusal-remedy-applied",
          pr: "PR1791",
          verdict: "RECUT",
          commands: ["yrd pr recut PR1791 --preflight --queue --apply", "yrd pr recut PR1791 --queue"],
        }),
      }),
    )
  })

  it("runs the FORCE spelling when the preflight verdict says a green check would be discarded", async () => {
    const h = harness({ verdict: "RECUT-FORCE" })

    const [outcome] = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    expect(outcome).toMatchObject({ status: "applied", verdict: "RECUT-FORCE" })
    expect(outcome?.status === "applied" ? outcome.commands.at(-1) : undefined).toBe(
      "yrd pr recut PR1791 --queue --force",
    )
  })

  it("re-readies instead of recutting when the preflight verdict is FRESH-NOOP", async () => {
    const h = harness({ verdict: "FRESH-NOOP" })

    const [outcome] = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    expect(outcome).toMatchObject({ status: "applied", verdict: "FRESH-NOOP" })
    expect(outcome?.status === "applied" ? outcome.commands.at(-1) : undefined).toBe("yrd pr ready PR1791")
    expect(h.ops()).not.toContain("services.recut")
  })

  it("applies a PR's remedy at most once per revision — including the revision it just minted", async () => {
    // The drill re-records the branch, so the PR ends the cycle on a NEW
    // revision. Without bounding that one too, "once per revision" would be
    // satisfied by a loop that mints a fresh revision every cycle forever.
    const h = harness()
    const attempted = new Set<string>()

    expect(await applyRefusalRemedies(h.app, h.services, h.io, attempted)).toHaveLength(1)
    const afterFirst = h.calls.length

    expect(await applyRefusalRemedies(h.app, h.services, h.io, attempted)).toEqual([])
    expect(h.calls).toHaveLength(afterFirst)
  })

  it("degrades to the printed refusal when a remedy step refuses, and does NOT retry it", async () => {
    const h = harness({ failOn: "services.recut" })
    const attempted = new Set<string>()

    const [outcome] = await applyRefusalRemedies(h.app, h.services, h.io, attempted)

    expect(outcome).toMatchObject({
      status: "failed",
      pr: "PR1791",
      code: "composition-invalid",
      resolution: ["yrd pr recut PR1791 --preflight --queue --apply"],
    })
    expect(h.warns).toContainEqual(
      expect.objectContaining({ props: expect.objectContaining({ action: "queue-refusal-remedy-failed" }) }),
    )
    // The wedge is now a human's problem — but exactly once, not once per cycle.
    expect(await applyRefusalRemedies(h.app, h.services, h.io, attempted)).toEqual([])
  })

  it("never withdraws a subsumed carrier on its own — that ends a delivery", async () => {
    const h = harness({ verdict: "SUBSUMED-WITHDRAW" })

    const [outcome] = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    expect(outcome).toMatchObject({ status: "failed", failure: expect.stringContaining("SUBSUMED-WITHDRAW") })
    expect(h.ops()).not.toContain("services.recut")
  })

  it("escalates a judgment-required refusal with its printed remedy and touches nothing", async () => {
    const h = harness({
      code: "recut-certificate",
      reason: "yrd: PR 'PR1791' recut tree certificate does not match revision 1",
    })

    const outcomes = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    expect(outcomes).toEqual([
      expect.objectContaining({ status: "escalated", pr: "PR1791", code: "recut-certificate" }),
    ])
    expect(h.ops()).toEqual(["queue.settleAdmissionRefusal"])
    // A restarted resident has an empty process-local Set. The durable Queue
    // settlement remains authoritative and must still suppress re-selection.
    expect(await applyRefusalRemedies(h.app, h.services, h.io, new Set())).toEqual([])
    expect(h.warns).toContainEqual(
      expect.objectContaining({ props: expect.objectContaining({ action: "queue-refusal-escalated" }) }),
    )
  })

  it("leaves a streak below the wedge threshold entirely alone", async () => {
    const h = harness({ count: 2 })

    expect(await applyRefusalRemedies(h.app, h.services, h.io, new Set())).toEqual([])
    expect(h.calls).toEqual([])
  })
})
