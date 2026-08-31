/**
 * @failure `yrd pr status` (and every verb that resolves "the change here")
 * read the RECORD lane only, so from a branch whose change is a derived
 * member it refused "the current bay or branch has no PR; submit it with
 * 'yrd pr submit'" — about a change the queue was actively running. Specimen
 * 2026-08-31: issue/advance-yrd-4f27b0a-take2 existed only as derived member
 * PR2773 from admission to merge; the same expression also fed the queue
 * position shown by `pr merge` refusals and the advance's own status line
 * (@i/10-yrd C3b). `changeForBayOrBranch` now resolves over `queueChanges`,
 * the one both-lane population; this file pins the resolution and its
 * bay-over-branch precedence.
 * @level l1
 * @consumer @yrd/cli
 */
import { describe, expect, it } from "vitest"
import type { BaysState, Change } from "@yrd/bay"
import { Queues, type ChangeSnapshot, type InstalledStep, type QueueRecord, type QueuesState } from "@yrd/queue"
// Relative on purpose: module-exported for tests, off the package surface.
import { changeForBayOrBranch } from "../src/run.ts"

const BASE = "a".repeat(40)
const AT = "2026-01-01T00:00:00.000Z"

const MERGE_STEP: InstalledStep = { name: "merge", title: "Merge", revision: "merge-v1", kind: "merge" }

function openRecord(overrides: Readonly<{ id: string; branch: string; bay?: string }>): Change {
  return {
    id: overrides.id,
    name: `Change ${overrides.id}`,
    branch: overrides.branch,
    base: "main",
    state: "open",
    merged: false,
    ...(overrides.bay === undefined ? {} : { bay: overrides.bay }),
    revs: [
      {
        n: 1,
        head: "2".repeat(40),
        base: "main",
        baseSha: BASE,
        pushedAt: AT,
        submittedAt: AT,
        submitter: "author@example.test",
      },
    ],
    reviews: [],
    comments: [],
    checkRequests: [],
  }
}

function baysWith(...prs: readonly Change[]): BaysState {
  return { byId: {}, prs: Object.fromEntries(prs.map((pr) => [pr.id, pr])), receipts: {}, submits: {} }
}

function snapshot(overrides: Readonly<{ id: string; branch: string }>): ChangeSnapshot {
  return { id: overrides.id, branch: overrides.branch, base: "main", revision: 1, headSha: "b".repeat(40) }
}

function queuedRun(id: string, prs: readonly ChangeSnapshot[]): QueueRecord {
  return { id, queueId: "main", candidateId: "C1", prs, base: "main", steps: [MERGE_STEP], startedAt: AT }
}

function queuesWith(...records: readonly QueueRecord[]): QueuesState {
  const empty = Queues.empty({ batchSize: 1 })
  return { ...empty, records: records.reduce((lookup, record) => Queues.set(lookup, record), empty.records) }
}

describe("changeForBayOrBranch — the current change resolves over both lanes", () => {
  it("a DERIVED member resolves by branch — the false 'has no PR' refusal", () => {
    const bays = baysWith()
    const queues = queuesWith(queuedRun("R1", [snapshot({ id: "PR9", branch: "task/derived" })]))
    expect(changeForBayOrBranch(bays, queues, undefined, "task/derived")?.id).toBe("PR9")
  })

  it("a record change still resolves by bay id exactly as before", () => {
    const bays = baysWith(openRecord({ id: "PR1", branch: "task/recorded", bay: "B7" }))
    expect(changeForBayOrBranch(bays, queuesWith(), "B7", undefined)?.id).toBe("PR1")
  })

  it("a record change still resolves by branch exactly as before", () => {
    const bays = baysWith(openRecord({ id: "PR1", branch: "task/recorded" }))
    expect(changeForBayOrBranch(bays, queuesWith(), undefined, "task/recorded")?.id).toBe("PR1")
  })

  it("the bay arm wins over the branch arm, as it always has", () => {
    const bays = baysWith(
      openRecord({ id: "PR1", branch: "task/a", bay: "B7" }),
      openRecord({ id: "PR2", branch: "task/b" }),
    )
    expect(changeForBayOrBranch(bays, queuesWith(), "B7", "task/b")?.id).toBe("PR1")
  })

  it("no match in either lane is honestly undefined", () => {
    expect(changeForBayOrBranch(baysWith(), queuesWith(), undefined, "task/absent")).toBeUndefined()
  })
})
