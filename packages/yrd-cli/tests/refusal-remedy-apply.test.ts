/**
 * @failure The habitant can mistake an author-owned remedy for a mechanical redelivery, resubmit a payload the base already contains, or re-apply a failed remedy every cycle instead of degrading to the printed refusal.
 * @level l2
 * @consumer @yrd/cli habitant runner
 */
import { describe, expect, it } from "vitest"
import { createFailure } from "@yrd/core"
import { applyRefusalRemedies } from "../src/run.ts"
import type { YrdCliApp, YrdCliIO, YrdCliServices } from "../src/types.ts"
// Package-private to @yrd/queue: the radix writer the Run projection stores
// through. Imported by source path rather than widening the package surface
// for a fixture, the same way other suites reach across packages here.
import { projectionLookupSet } from "../../yrd-queue/src/projection-lookup.ts"

const PR = "PR1791"
const BRANCH = "task/22474-carrier"
const REVISION = 1
const HEAD = "1".repeat(40)
const NEXT = "2".repeat(40)
const BASE = "a".repeat(40)
const TARGET = "b".repeat(40)
const AT = "2026-07-27T15:00:00.000Z"

type Call = Readonly<{ op: string; detail?: string }>
type LogCall = Readonly<{ message: string; props: Record<string, unknown> }>

/** The drill the compose path prints for a wedged code carrier: one quoted Yrd
 * command, which the actionable-error projection lifts into `resolution`. */
function mechanicalRedeliveryReason(pr: string): string {
  return `yrd: change '${pr}' needs a certified refresh; tracked changes re-merge implicitly; fallback: 'yrd pr submit <branch>'`
}

/** One retained Run naming the delivery under remedy.
 *
 * S7 moved the streak's identity here: the ledger is keyed by member id, and
 * `remedySubject` resolves that id through the retained run snapshots — where
 * the change record used to answer. Built through the real radix writer, so the
 * fixture cannot drift from the shape the projection actually stores. */
function retainedRun(): unknown {
  return projectionLookupSet({}, "R1", {
    id: "R1",
    base: "main",
    baseSha: BASE,
    startedAt: AT,
    prs: [{ id: PR, branch: BRANCH, base: "main", revision: REVISION, headSha: HEAD }],
  })
}

function harness(
  options: Readonly<{
    code?: string
    reason?: string
    count?: number
    /** Fail the named operation, the way a real remedy step can refuse. */
    failOn?: string
    /** The head is already contained in its base — the one preflight question
     * that survived the change-record store, and the only one still asked. */
    subsumed?: boolean
    /** Drop the branch's standing submit fact: the delivery has ended, so
     * nothing is left to redeliver mechanically. */
    submitted?: boolean
    /** Drop the retained run member the streak names — what retention leaves
     * behind when a delivery ages out from under its ledger row. */
    retained?: boolean
  }> = {},
) {
  const calls: Call[] = []
  const infos: LogCall[] = []
  const warns: LogCall[] = []
  const subsumed = options.subsumed ?? false
  let head = HEAD
  let settled = false
  const guard = (op: string, detail?: string): void => {
    calls.push({ op, ...(detail === undefined ? {} : { detail }) })
    if (options.failOn === op) {
      throw createFailure({
        kind: "refusal",
        code: "bay-head-missing",
        message: `yrd: bay head for '${BRANCH}' is missing`,
      })
    }
  }
  const records = options.retained === false ? {} : retainedRun()
  const app = {
    state: () => ({
      bays: {
        byId: {},
        // The standing submit fact IS the delivery since S7: its sha is the
        // head a remedy redelivers, and its absence is the delivery having
        // ended.
        submits: options.submitted === false ? {} : { [BRANCH]: { sha: head, base: "main", at: AT } },
      },
      queues: {
        records,
        admissionRefusals: {
          [PR]: {
            pr: PR,
            code: options.code ?? "composition-invalid",
            kind: "refusal",
            reason: options.reason ?? mechanicalRedeliveryReason(PR),
            count: options.count ?? 3,
            firstAt: AT,
            lastAt: "2026-07-27T15:51:00.000Z",
            ...(settled
              ? {
                  revision: REVISION,
                  headSha: head,
                  settlement: {
                    disposition: "needs-person",
                    reason: "the printed remedy requires human judgment",
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
      submitSelection: async (selector: string) => {
        guard("submitSelection", selector)
        // A redelivery re-records the branch: the standing fact now names the
        // corrected head, which is what makes the next cycle's identity differ.
        head = NEXT
      },
    },
    queue: {
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
      // Every ref the containment check resolves is present: the base tip, and
      // the head under remedy.
      resolveCommit: async (ref: string) => (ref === "origin/main" || ref === "main" ? TARGET : ref),
      isAncestor: async () => subsumed,
      mergeTree: async () => "tree-merged",
      treeOf: async () => "tree-base",
    }),
  } as unknown as YrdCliIO
  // Empty on purpose: the record-side re-mint service is gone, and the loop
  // must not reach for one. Anything it touched here would throw by name.
  const services = {} as unknown as YrdCliServices
  return { app, io, services, calls, infos, warns, ops: () => calls.map((call) => call.op) }
}

describe("habitant refusal remedies — only mechanical redeliveries are self-applied", () => {
  it("settles authored-gitlink as needs-person without redelivering anything", async () => {
    const h = harness({
      code: "authored-gitlink",
      reason: "yrd: change 'PR1791' changes generated-only gitlinks [km]",
    })

    const outcomes = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    expect(outcomes).toEqual([
      expect.objectContaining({
        status: "escalated",
        pr: PR,
        code: "authored-gitlink",
        reason: expect.stringContaining("is not a mechanical Yrd redelivery command"),
      }),
    ])
    expect(h.ops()).toEqual(["queue.settleAdmissionRefusal"])
  })

  // DELIBERATE RED — a src defect I do not own, reported rather than fenced in.
  //
  // The runner performs ONE redelivery and reports TWO. `applyRefusalRemedy`
  // (run.ts) records the step at the top of its loop
  // (`commands.push(formatRemedyCommand(step))`) and then, for the delivery
  // under remedy, pushes `yrd pr submit ${step.branch}` again after the
  // containment check. Before S7 the second push was `preflight.next` — a
  // DIFFERENT command (the verdict's own spelling); the rewrite replaced it
  // with a spelling byte-identical to the first, so the pair became a
  // duplicate. Both are already branch-resolved, so the second carries nothing.
  //
  // Why it is worth a red rather than an updated expectation: `commands` is
  // what an operator reads to reconstruct what the runner did to their branch,
  // and two submits of one branch read as a retry — the exact loop this module
  // exists to bound. The log accuses the runner of the failure mode it prevents.
  //
  // Fix is one line in run.ts: drop the second push. The `yrd draft` push in
  // the subsumed branch stays — that one IS a different command, and printed
  // rather than run.
  it("runs the printed drill end to end and logs every applied command verbatim", async () => {
    const h = harness()

    const outcomes = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    // Measured first, so the red cannot be misread: the redelivery itself is
    // correct — one submit of the branch tip, with the `<branch>` placeholder
    // filled from the subject rather than by a human. Only the report is wrong.
    expect(h.calls).toEqual([{ op: "submitSelection", detail: BRANCH }])
    expect(outcomes).toEqual([
      {
        status: "applied",
        pr: PR,
        revision: REVISION,
        code: "composition-invalid",
        count: 3,
        commands: [`yrd pr submit ${BRANCH}`],
        verdict: "RESUBMIT",
      },
    ])
    expect(h.infos).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          action: "queue-refusal-remedy-applied",
          pr: PR,
          verdict: "RESUBMIT",
          commands: [`yrd pr submit ${BRANCH}`],
        }),
      }),
    )
  })

  it("escalates end to end when a refusal still prints the retired recut spelling", async () => {
    // The verb is gone and no projection emits it. A refusal that still names
    // it must escalate to a person, naming the exact unrunnable step — and
    // must NOT be run as an equivalent drill it was never asked for.
    const h = harness({
      reason: "yrd: change 'PR1791' needs a certified refresh; run 'yrd pr recut PR1791 --preflight --queue --apply'",
    })

    const outcomes = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    expect(outcomes).toEqual([
      expect.objectContaining({
        status: "escalated",
        pr: PR,
        reason:
          "remedy step 'yrd pr recut PR1791 --preflight --queue --apply' is not a mechanical Yrd redelivery command",
      }),
    ])
    expect(h.ops()).toEqual(["queue.settleAdmissionRefusal"])
  })

  it("escalates instead of redelivering when the branch has no standing submit fact", async () => {
    // The seam the pure planner cannot see: `remedySubject` derives
    // `redeliverable` from `bays.submits`, so an ended delivery escalates on
    // the same refusal that would otherwise be redelivered mechanically.
    const h = harness({ submitted: false })

    const outcomes = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    expect(outcomes).toEqual([
      expect.objectContaining({
        status: "escalated",
        pr: PR,
        reason:
          "this delivery has ended — no submit fact stands for its branch, so it cannot be redelivered mechanically",
      }),
    ])
    expect(h.ops()).toEqual(["queue.settleAdmissionRefusal"])
  })

  it("leaves a streak whose delivery is no longer retained entirely alone", async () => {
    // The ledger outlives retention: a streak naming a member no run record
    // still carries resolves to no subject, and a remedy needs a branch and a
    // head to name. Skipping is the only safe reading — the alternative is
    // guessing at a delivery the state no longer holds.
    const h = harness({ retained: false })

    expect(await applyRefusalRemedies(h.app, h.services, h.io, new Set())).toEqual([])
    expect(h.calls).toEqual([])
  })

  it("applies a remedy at most once per delivered head — including the head it just recorded", async () => {
    // The drill re-records the branch, so the delivery ends the cycle on a NEW
    // head. Without bounding that one too, "once per head" would be satisfied
    // by a loop that redelivers a fresh head every cycle forever. Since S7 the
    // moving part of the key is the submit fact's sha: a revision is minted at
    // admission, a cycle later, so it cannot be what bounds this loop.
    const h = harness()
    const attempted = new Set<string>()

    expect(await applyRefusalRemedies(h.app, h.services, h.io, attempted)).toHaveLength(1)
    const afterFirst = h.calls.length

    expect(await applyRefusalRemedies(h.app, h.services, h.io, attempted)).toEqual([])
    expect(h.calls).toHaveLength(afterFirst)
  })

  it("degrades to the printed refusal when a remedy step refuses, and does NOT retry it", async () => {
    const h = harness({ failOn: "submitSelection" })
    const attempted = new Set<string>()

    const [outcome] = await applyRefusalRemedies(h.app, h.services, h.io, attempted)

    expect(outcome).toMatchObject({
      status: "failed",
      pr: PR,
      code: "composition-invalid",
      failure: expect.stringContaining(`bay head for '${BRANCH}' is missing`),
      resolution: ["yrd pr submit <branch>"],
    })
    expect(h.warns).toContainEqual(
      expect.objectContaining({ props: expect.objectContaining({ action: "queue-refusal-remedy-failed" }) }),
    )
    // The wedge is now a human's problem — but exactly once, not once per
    // cycle, and with nothing further attempted against it.
    const afterFirst = h.calls.length
    expect(await applyRefusalRemedies(h.app, h.services, h.io, attempted)).toEqual([])
    expect(h.calls).toHaveLength(afterFirst)
  })

  it("never redelivers a payload the base already contains — that merges it twice", async () => {
    const h = harness({ subsumed: true })

    const [outcome] = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    expect(outcome).toMatchObject({
      status: "failed",
      pr: PR,
      failure: expect.stringContaining(`is already contained in main at ${TARGET.slice(0, 12)}`),
    })
    // Ending a delivery stays an operator decision, so the runner prints the
    // withdrawal rather than taking it. `commands` records the drill it
    // attempted, up to and including the step that refused.
    expect(outcome?.status === "failed" ? outcome.commands : undefined).toEqual([
      `yrd pr submit ${BRANCH}`,
      `yrd draft ${BRANCH}`,
    ])
    expect(h.ops()).toEqual(["queue.settleAdmissionRefusal"])
  })

  it("escalates a judgment-required refusal with its printed remedy and touches nothing", async () => {
    const h = harness({
      code: "recut-certificate",
      reason: "yrd: change 'PR1791' recut tree certificate does not match revision 1",
    })

    const outcomes = await applyRefusalRemedies(h.app, h.services, h.io, new Set())

    expect(outcomes).toEqual([
      expect.objectContaining({
        status: "escalated",
        pr: PR,
        code: "recut-certificate",
        resolution: ["Correct the cause above, then retry the same Yrd command."],
      }),
    ])
    expect(h.ops()).toEqual(["queue.settleAdmissionRefusal"])
    // A restarted habitant has an empty process-local Set. The durable Queue
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
