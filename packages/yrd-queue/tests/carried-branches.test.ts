/**
 * @failure The stranded-ref sweep's carried set was built from the change-
 * RECORD store alone (the observe rail and `queue uncarried` both read
 * `recordChanges`), so a branch whose change exists only in the derived lane
 * — or whose submission stands at the door awaiting first admission — read as
 * uncarried, and the one rail built to find LOST work could flag a LIVE
 * branch as stranded (@i/10-yrd C3b; the PR2767 class: submitted only in
 * git, composed and merged with no record ever minted). `carriedBranches` is
 * the seam's answer — one derivation of "a change already names this
 * branch", both lanes plus standing submit facts — and these tests pin each
 * lane's membership by name.
 * @level l1
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import type { BaysState, Change } from "@yrd/bay"
import {
  carriedBranches,
  Queues,
  type ChangeSnapshot,
  type QueueRecord,
  type QueuesState,
} from "@yrd/queue"

const BASE = "a".repeat(40)
const AT = "2026-01-01T00:00:00.000Z"

function changeRecord(overrides: Readonly<{ id: string; branch: string; state?: "open" | "closed" }>): Change {
  return {
    id: overrides.id,
    name: `Change ${overrides.id}`,
    branch: overrides.branch,
    base: "main",
    state: overrides.state ?? "open",
    merged: false,
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

function baysWith(
  prs: readonly Change[],
  submits: Readonly<Record<string, Readonly<{ sha: string; base: string; at: string }>>> = {},
): BaysState {
  return { byId: {}, prs: Object.fromEntries(prs.map((pr) => [pr.id, pr])), receipts: {}, submits }
}

function snapshot(overrides: Readonly<{ id: string; branch: string; revision: number }>): ChangeSnapshot {
  return {
    id: overrides.id,
    branch: overrides.branch,
    base: "main",
    revision: overrides.revision,
    headSha: "b".repeat(40),
  }
}

function runRecord(id: string, prs: readonly ChangeSnapshot[]): QueueRecord {
  return { id, queueId: "main", candidateId: "C1", prs, base: "main", steps: [], startedAt: AT }
}

function queuesWith(...records: readonly QueueRecord[]): QueuesState {
  const empty = Queues.empty({ batchSize: 1 })
  return { ...empty, records: records.reduce((lookup, record) => Queues.set(lookup, record), empty.records) }
}

describe("carriedBranches — every lane a change can live in counts as carried", () => {
  it("a record-lane branch is carried, open or terminal", () => {
    const bays = baysWith([
      changeRecord({ id: "PR1", branch: "task/recorded" }),
      changeRecord({ id: "PR2", branch: "task/withdrawn", state: "closed" }),
    ])
    const carried = carriedBranches(bays, queuesWith())
    expect(carried.has("task/recorded")).toBe(true)
    expect(carried.has("task/withdrawn")).toBe(true)
  })

  it("a DERIVED-lane branch is carried — the live branch the record-only set flagged", () => {
    // No record anywhere: the change exists only as a retained snapshot, the
    // post-door shape that composed and merged while the sweep's old carried
    // set could not see it.
    const queues = queuesWith(runRecord("R1", [snapshot({ id: "PR9", branch: "task/derived", revision: 1 })]))
    const carried = carriedBranches(baysWith([]), queues)
    expect(carried.has("task/derived")).toBe(true)
  })

  it("a submission standing at the door — no record, no admission yet — is carried", () => {
    const bays = baysWith([], { "task/pending": { sha: "c".repeat(40), base: "main", at: AT } })
    const carried = carriedBranches(bays, queuesWith())
    expect(carried.has("task/pending")).toBe(true)
  })

  it("a branch no lane names is NOT carried — the sweep must still find genuinely stranded work", () => {
    const bays = baysWith(
      [changeRecord({ id: "PR1", branch: "task/recorded" })],
      { "task/pending": { sha: "c".repeat(40), base: "main", at: AT } },
    )
    const queues = queuesWith(runRecord("R1", [snapshot({ id: "PR9", branch: "task/derived", revision: 1 })]))
    expect(carriedBranches(bays, queues).has("task/stranded")).toBe(false)
  })
})
