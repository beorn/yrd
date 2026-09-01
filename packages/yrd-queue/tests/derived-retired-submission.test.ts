/**
 * @failure A derived member admitted into a run whose submit fact later
 * vanished reads `open`/`submitted` off its retained snapshot FOREVER, so it
 * sits at the head of the queue with `checks-pending` and nothing can dispose
 * of it.
 *
 * Live specimen PR2131 (issue/sop-sherif-sort-recut, 2026-09-01): admitted
 * 2026-08-27, one check request from that day, `runnable false`,
 * `checks-pending "checks are queued"`, and `queue audit` naming it the head of
 * 24 queued changes. Origin had no such branch and the receiver store held no
 * `refs/yrd/submit/` ref for it — the fact was swept when the branch was
 * deleted, five days before anyone looked.
 *
 * Nothing on the COMPOSE side can retire it, which is why the cure lives here
 * rather than there: `deriveRefOnlyMembers` derives members from LIVE submit
 * facts, so a member whose fact is gone is never re-derived; `retireStaleDerived`
 * re-validates only the members the CURRENT pass admitted. A member that
 * entered a run in an earlier pass and lost its fact afterwards is therefore
 * never re-judged by any pass, and its whole remaining existence is the
 * projection in `derivedChange` — the one expression both lanes shape a derived
 * change from. Making that projection honest is what makes the state
 * unrepresentable: there is no pass boundary for it to survive, because it is
 * not a member of any pass.
 *
 * Pinned here rather than through the CLI because this population feeds every
 * reader at once — `pr list`, `pr view`, `pr withdraw`, eligibility, and
 * `queueProgressQueue`, whose filter (`queue.ts`, delivery ∈
 * submitted/ready/pushed-with-checks) selects the queue whose FIRST element is
 * the `queue-progress-stalled` head. The four states below are the whole
 * truth table, and three of them must not move.
 * @level l1
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { changeDeliveryState, isLiveChange, type BaysState, type ProjectedBranchSubmit } from "@yrd/bay"
import {
  Queues,
  queueChanges,
  resolveQueueChange,
  type ChangeSnapshot,
  type InstalledStep,
  type QueueRecord,
  type QueuesState,
} from "@yrd/queue"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const REPUSHED_SHA = "c".repeat(40)
const MERGED_SHA = "e".repeat(40)
const CANDIDATE_SHA = "d".repeat(40)
const TREE_SHA = "f".repeat(40)
const ADMITTED_AT = "2026-08-27T14:19:42.000Z"
const MERGED_AT = "2026-08-28T00:00:00.000Z"
/** The live specimen's branch, so a reader can match this file to the incident. */
const BRANCH = "issue/sop-sherif-sort-recut"

const MERGE_STEP: InstalledStep = { name: "merge", title: "Merge", revision: "merge-v1", kind: "merge" }

function bays(submits: Readonly<Record<string, ProjectedBranchSubmit>> = {}): BaysState {
  return { byId: {}, prs: {}, receipts: {}, submits }
}

function standingFact(sha: string): ProjectedBranchSubmit {
  return { sha, base: "main", at: ADMITTED_AT }
}

function snapshot(id: string, branch: string, headSha = HEAD_SHA): ChangeSnapshot {
  return { id, branch, base: "main", revision: 1, headSha }
}

/** A run that ADMITTED the member and is still running it: a merge step is
 * declared, but nothing passed and no integration proof was stamped. This is
 * the specimen's shape — checks requested 2026-08-27, never merged. */
function runningRun(id: string, prs: readonly ChangeSnapshot[]): QueueRecord {
  return { id, queueId: "main", candidateId: "C1", prs, base: "main", steps: [MERGE_STEP], startedAt: ADMITTED_AT }
}

/** A run that MERGED the member — `passedAt` plus a retained integration proof,
 * which is the only home a recordless member's landing has. */
function mergedRun(
  id: string,
  prs: readonly ChangeSnapshot[],
  integration: QueueRecord["integration"] = { commit: MERGED_SHA, baseSha: BASE_SHA },
): QueueRecord {
  return {
    id,
    queueId: "main",
    candidateId: "C1",
    prs,
    base: "main",
    steps: [MERGE_STEP],
    startedAt: ADMITTED_AT,
    passedAt: MERGED_AT,
    integration,
  }
}

function queues(...records: readonly QueueRecord[]): QueuesState {
  const empty = Queues.empty({ batchSize: 1 })
  return { ...empty, records: records.reduce((lookup, record) => Queues.set(lookup, record), empty.records) }
}

describe("a derived member whose submit fact is gone is a RETIRED submission, not a queued change", () => {
  it("reads withdrawn once the fact is swept — the PR2131 ghost head", () => {
    const state = { bays: bays(), queues: queues(runningRun("R1", [snapshot("PR2131", BRANCH)])) }
    const pr = resolveQueueChange(state.bays, state.queues, "PR2131")

    expect(pr, "the change stays ADDRESSABLE — erasing it would restore the 'no change PR2131' typo").toBeDefined()
    expect(changeDeliveryState(pr!)).toBe("withdrawn")
    expect(pr!.state).toBe("closed")
    expect(pr!.merged, "withdrawn is not merged — no run ever landed this sha").toBe(false)
  })

  it("leaves the queued population, which is where the audit reads its head", () => {
    // The audit's filter, not a paraphrase of it: `queueProgressQueue` keeps
    // exactly the deliveries below and reports `started[0]` as the stalled
    // head. A withdrawn change is in neither set.
    const state = {
      bays: bays({ "issue/live": standingFact(REPUSHED_SHA) }),
      queues: queues(
        runningRun("R1", [snapshot("PR2131", BRANCH)]),
        runningRun("R2", [snapshot("PR2200", "issue/live", REPUSHED_SHA)]),
      ),
    }
    const queued = queueChanges(state.bays, state.queues).filter((pr) => {
      const delivery = changeDeliveryState(pr)
      return delivery === "submitted" || delivery === "ready"
    })

    expect(queued.map((pr) => pr.id)).toEqual(["PR2200"])
  })

  it("is terminal, so every live-change guard refuses it instead of offering a cure", () => {
    // `requiredLivePr` (pr-withdraw.ts) checks `isLiveChange` BEFORE its
    // derived-lane arm, so this one bit is what turns the false
    // `git push bay :refs/yrd/submit/...` cure into an honest `pr-terminal`.
    const state = { bays: bays(), queues: queues(runningRun("R1", [snapshot("PR2131", BRANCH)])) }
    expect(isLiveChange(resolveQueueChange(state.bays, state.queues, "PR2131")!)).toBe(false)
  })

  it("carries the terminal fact its own revision clock demands", () => {
    // `currentTerminalFact` throws when the change-level state and the
    // revision's terminal disagree, and `currentAdmissionFinish` discards a
    // terminal that predates its submit clock — either would crash `pr list`
    // for all rows rather than fix one. Both are satisfied by construction.
    const state = { bays: bays(), queues: queues(runningRun("R1", [snapshot("PR2131", BRANCH)])) }
    const pr = resolveQueueChange(state.bays, state.queues, "PR2131")!

    expect(pr.withdrawnAt).toBe(ADMITTED_AT)
    expect(pr.revs[0]?.terminal).toEqual({ kind: "withdrawn", at: ADMITTED_AT })
    expect(Date.parse(pr.revs[0]!.terminal!.at)).toBeGreaterThanOrEqual(Date.parse(pr.revs[0]!.submittedAt!))
  })

  it("reads the same terminal on every call — a projection, never a clock", () => {
    const state = { bays: bays(), queues: queues(runningRun("R1", [snapshot("PR2131", BRANCH)])) }
    const first = resolveQueueChange(state.bays, state.queues, "PR2131")
    const second = resolveQueueChange(state.bays, state.queues, "PR2131")

    expect(first?.withdrawnAt).toBe(second?.withdrawnAt)
  })
})

describe("the three states the retired arm must NOT touch", () => {
  it("a MERGED member keeps reading integrated, though merging swept its fact too", () => {
    // The precedence that makes the fix safe: a merged derived member's fact is
    // swept BY DESIGN, so asking about the fact before asking about the landing
    // would read every merged change in the queue's history as withdrawn.
    const state = { bays: bays(), queues: queues(mergedRun("R1", [snapshot("PR2100", "issue/merged")])) }
    const pr = resolveQueueChange(state.bays, state.queues, "PR2100")!

    expect(changeDeliveryState(pr)).toBe("integrated")
    expect(pr.merged).toBe(true)
  })

  it("an ALREADY-LANDED member keeps reading already-landed", () => {
    const state = {
      bays: bays(),
      queues: queues(
        mergedRun("R1", [snapshot("PR2101", "issue/already")], {
          commit: MERGED_SHA,
          baseSha: BASE_SHA,
          alreadyLanded: { candidateSha: CANDIDATE_SHA, candidateTreeSha: TREE_SHA, baseTreeSha: TREE_SHA },
        }),
      ),
    }
    const pr = resolveQueueChange(state.bays, state.queues, "PR2101")!

    expect(changeDeliveryState(pr)).toBe("already-landed")
    expect(pr.merged).toBe(true)
  })

  it("a RE-PUSHED member stays open, because its branch still has a submission", () => {
    // The regression this arm is one line away from: the fact stands at a
    // different sha, so the retained snapshot is stale — but the branch IS
    // still submitted and the next compose re-derives it under the same id.
    // Reading `moved` as terminal would flip an author's change to withdrawn
    // for the whole window between their push and that pass.
    const state = {
      bays: bays({ [BRANCH]: standingFact(REPUSHED_SHA) }),
      queues: queues(runningRun("R1", [snapshot("PR2131", BRANCH)])),
    }
    const pr = resolveQueueChange(state.bays, state.queues, "PR2131")!

    expect(changeDeliveryState(pr)).toBe("submitted")
    expect(isLiveChange(pr)).toBe(true)
  })

  it("a STANDING member at its own sha stays open, exactly as before", () => {
    const state = {
      bays: bays({ [BRANCH]: standingFact(HEAD_SHA) }),
      queues: queues(runningRun("R1", [snapshot("PR2131", BRANCH)])),
    }
    const pr = resolveQueueChange(state.bays, state.queues, "PR2131")!

    expect(changeDeliveryState(pr)).toBe("submitted")
    expect(pr.state).toBe("open")
  })
})
