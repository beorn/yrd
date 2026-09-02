/**
 * @failure The queue's progress machinery read the RECORD lane only, so a
 * derived-lane merge advanced nothing: on 2026-08-31 the dead-man reported
 * "no merge for 51m" while PR2769 and PR2770 merged inside that window —
 * a standing false-alarm channel on the one rail built to catch real stalls
 * (@i/10-yrd C3b; the memory row "the runner panel's no-merge-for-N is
 * frozen by derived-lane merges" is this same defect on its read side).
 * `latestQueueMergeMs` now derives from BOTH lanes; a derived member's merge
 * time is the run lane's own stamp (`derivedIntegration` → `integrationAt`), the
 * trustworthy source the record fields only mirror. The population switch in
 * `queueProgressQueue` and the `no-submitted-prs` diagnostic ride the same
 * `queueChanges` expression; this file pins the clock, where the measured
 * false alarm lived.
 * @level l1
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import type { BaysState, Change } from "@yrd/bay"
import {
  Queues,
  queueChanges,
  queueSnapshot,
  type ChangeSnapshot,
  type InstalledStep,
  type QueueRecord,
  type QueuesState,
} from "@yrd/queue"
// Relative on purpose: module-exported for this test only, off the package
// surface per the index's own explicit-list rule.
import { backfillIntegrationTimes, latestQueueMergeMs } from "../src/queue.ts"

const BASE = "a".repeat(40)
const AT = "2026-01-01T00:00:00.000Z"
const RECORD_MERGE_AT = "2026-01-02T00:00:00.000Z"
const DERIVED_MERGE_AT = "2026-01-03T00:00:00.000Z"
const RECORD_NEWER_MERGE_AT = "2026-01-04T00:00:00.000Z"

const MERGE_STEP: InstalledStep = { name: "merge", title: "Merge", revision: "merge-v1", kind: "merge" }

function mergedRecord(overrides: Readonly<{ id: string; branch: string; integratedAt: string }>): Change {
  return {
    id: overrides.id,
    name: `Change ${overrides.id}`,
    branch: overrides.branch,
    base: "main",
    state: "closed",
    merged: true,
    integratedAt: overrides.integratedAt,
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

function snapshot(overrides: Readonly<{ id: string; branch: string; revision: number }>): ChangeSnapshot {
  return {
    id: overrides.id,
    branch: overrides.branch,
    base: "main",
    revision: overrides.revision,
    headSha: "b".repeat(40),
  }
}

function mergedRun(id: string, prs: readonly ChangeSnapshot[], passedAt: string): QueueRecord {
  return {
    id,
    queueId: "main",
    candidateId: "C1",
    prs,
    base: "main",
    steps: [MERGE_STEP],
    startedAt: AT,
    passedAt,
    integration: { commit: "e".repeat(40), baseSha: BASE },
  }
}

function runningRun(id: string, prs: readonly ChangeSnapshot[]): QueueRecord {
  return {
    id,
    queueId: "main",
    candidateId: "C1",
    prs,
    base: "main",
    steps: [MERGE_STEP],
    startedAt: AT,
  }
}

function queuesWith(...records: readonly QueueRecord[]): QueuesState {
  const empty = Queues.empty({ batchSize: 1 })
  return { ...empty, records: records.reduce((lookup, record) => Queues.set(lookup, record), empty.records) }
}

describe("latestQueueMergeMs — the last-merge clock reads both lanes", () => {
  it.each([
    {
      case: "a DERIVED merged run advances the clock — the 2026-08-31 false alarm",
      // No record row anywhere: the merge exists only as a settled run whose
      // retained snapshot names a recordless member — the PR2769/PR2770 shape.
      bays: baysWith(),
      queues: queuesWith(
        mergedRun("R1", [snapshot({ id: "PR9", branch: "task/derived", revision: 1 })], DERIVED_MERGE_AT),
      ),
      expected: Date.parse(DERIVED_MERGE_AT),
    },
    {
      case: "the record lane still answers exactly as before",
      bays: baysWith(mergedRecord({ id: "PR1", branch: "task/recorded", integratedAt: RECORD_MERGE_AT })),
      queues: queuesWith(),
      expected: Date.parse(RECORD_MERGE_AT),
    },
    {
      case: "both lanes together: the newest merge wins whichever lane holds it",
      bays: baysWith(mergedRecord({ id: "PR1", branch: "task/recorded", integratedAt: RECORD_MERGE_AT })),
      queues: queuesWith(
        mergedRun("R1", [snapshot({ id: "PR9", branch: "task/derived", revision: 1 })], DERIVED_MERGE_AT),
      ),
      expected: Date.parse(DERIVED_MERGE_AT),
    },
    {
      case: "both lanes together: the record lane wins when it is newer",
      bays: baysWith(mergedRecord({ id: "PR1", branch: "task/recorded", integratedAt: RECORD_NEWER_MERGE_AT })),
      queues: queuesWith(
        mergedRun("R1", [snapshot({ id: "PR9", branch: "task/derived", revision: 1 })], DERIVED_MERGE_AT),
      ),
      expected: Date.parse(RECORD_NEWER_MERGE_AT),
    },
    {
      case: "no merge in either lane is honestly undefined",
      bays: baysWith(),
      queues: queuesWith(),
      expected: undefined,
    },
  ])("$case", ({ bays, queues, expected }) => {
    expect(latestQueueMergeMs({ bays, queues }, "main")).toBe(expected)
  })
})

describe("queueSnapshot — eligibility and last merge are one revision fold", () => {
  it("removes a merged revision even while its submit fact still stands", () => {
    const branch = "task/merged-with-standing-fact"
    const queues = queuesWith(mergedRun("R1", [snapshot({ id: "PR9", branch, revision: 1 })], DERIVED_MERGE_AT))
    const bays: BaysState = {
      ...baysWith(),
      submits: { [branch]: { sha: "b".repeat(40), base: "main", at: AT } },
    }
    const view = queueSnapshot(queueChanges(bays, queues), Queues.values(queues), "main")

    expect(view.eligible).toEqual([])
    expect(view.lastMerge).toEqual({ commit: "e".repeat(40), at: DERIVED_MERGE_AT })
  })

  it("does not let an older merged revision settle a newer submitted revision", () => {
    const branch = "task/resubmitted-after-merge"
    const oldHead = "b".repeat(40)
    const currentHead = "c".repeat(40)
    const current: Change = {
      id: "PR9",
      name: "Change PR9",
      branch,
      base: "main",
      state: "open",
      merged: false,
      submittedAt: RECORD_NEWER_MERGE_AT,
      revs: [
        {
          n: 1,
          head: oldHead,
          base: "main",
          baseSha: BASE,
          pushedAt: AT,
          submittedAt: AT,
          submitter: "author@example.test",
        },
        {
          n: 2,
          head: currentHead,
          base: "main",
          baseSha: BASE,
          pushedAt: RECORD_NEWER_MERGE_AT,
          submittedAt: RECORD_NEWER_MERGE_AT,
          submitter: "author@example.test",
        },
      ],
      reviews: [],
      comments: [],
      checkRequests: [],
    }
    const oldRun = mergedRun(
      "R1",
      [{ ...snapshot({ id: "PR9", branch, revision: 1 }), headSha: oldHead }],
      DERIVED_MERGE_AT,
    )

    expect(queueSnapshot([current], [oldRun], "main").eligible).toEqual([current])
  })

  it("does not treat an old revision's check request as eligibility for new pushed content", () => {
    const oldHead = "b".repeat(40)
    const currentHead = "c".repeat(40)
    const pushed: Change = {
      id: "PR9",
      name: "Change PR9",
      branch: "task/pushed-new-content",
      base: "main",
      state: "open",
      merged: false,
      revs: [
        { n: 1, head: oldHead, base: "main", baseSha: BASE, pushedAt: AT },
        { n: 2, head: currentHead, base: "main", baseSha: BASE, pushedAt: DERIVED_MERGE_AT },
      ],
      reviews: [],
      comments: [],
      checkRequests: [{ revision: 1, headSha: oldHead, baseSha: BASE, at: RECORD_MERGE_AT }],
    }

    expect(queueSnapshot([pushed], [], "main").eligible).toEqual([])
  })

  it("removes a revision whose submit fact was withdrawn", () => {
    const branch = "task/withdrawn"
    const queues = queuesWith(runningRun("R1", [snapshot({ id: "PR9", branch, revision: 1 })]))
    const view = queueSnapshot(queueChanges(baysWith(), queues), Queues.values(queues), "main")

    expect(view.eligible).toEqual([])
    expect(view.lastMerge).toBeNull()
  })

  it("settles an already-landed revision without claiming a new merge", () => {
    const branch = "task/already-landed"
    const landedRun = {
      ...mergedRun("R1", [snapshot({ id: "PR9", branch, revision: 1 })], DERIVED_MERGE_AT),
      integration: {
        commit: BASE,
        baseSha: BASE,
        alreadyLanded: {
          candidateSha: "b".repeat(40),
          candidateTreeSha: "c".repeat(40),
          baseTreeSha: "c".repeat(40),
        },
      },
    }
    const bays: BaysState = {
      ...baysWith(),
      submits: { [branch]: { sha: "b".repeat(40), base: "main", at: AT } },
    }

    expect(queueSnapshot(queueChanges(bays, queuesWith(landedRun)), [landedRun], "main")).toEqual({
      eligible: [],
      lastMerge: null,
    })
  })

  it("keeps only the newest merge from either lane", () => {
    const bays = baysWith(mergedRecord({ id: "PR1", branch: "task/recorded", integratedAt: RECORD_MERGE_AT }))
    const queues = queuesWith(
      mergedRun("R1", [snapshot({ id: "PR9", branch: "task/derived", revision: 1 })], DERIVED_MERGE_AT),
    )
    const view = queueSnapshot(queueChanges(bays, queues), Queues.values(queues), "main")

    expect(view.lastMerge).toEqual({ commit: "e".repeat(40), at: DERIVED_MERGE_AT })
  })

  it("uses the merge clock instead of a later whole-run settlement", () => {
    const branch = "task/merge-before-deploy"
    const run = {
      ...mergedRun("R1", [snapshot({ id: "PR9", branch, revision: 1 })], RECORD_NEWER_MERGE_AT),
      integrationAt: DERIVED_MERGE_AT,
    }

    expect(queueSnapshot(queueChanges(baysWith(), queuesWith(run)), [run], "main").lastMerge).toEqual({
      commit: "e".repeat(40),
      at: DERIVED_MERGE_AT,
    })
  })

  it("deduplicates a record-lane merge and keeps its exact clock over a migrated Run clock", () => {
    const record = mergedRecord({ id: "PR1", branch: "task/record-clock", integratedAt: RECORD_MERGE_AT })
    const run = {
      ...mergedRun(
        "R1",
        [
          {
            ...snapshot({ id: "PR1", branch: record.branch, revision: 1 }),
            headSha: "2".repeat(40),
          },
        ],
        RECORD_NEWER_MERGE_AT,
      ),
      integrationAt: RECORD_NEWER_MERGE_AT,
    }

    expect(queueSnapshot([record], [run], "main").lastMerge).toEqual({
      commit: "e".repeat(40),
      at: RECORD_MERGE_AT,
    })
  })

  it("chooses the chronologically newest merge across timestamp offsets", () => {
    const olderByInstant = mergedRecord({
      id: "PR1",
      branch: "task/offset-clock",
      integratedAt: "2026-01-04T00:00:00.000+03:00",
    })
    const newerByInstant = mergedRun(
      "R1",
      [snapshot({ id: "PR9", branch: "task/utc-clock", revision: 1 })],
      "2026-01-03T22:00:00.000Z",
    )

    expect(queueSnapshot(queueChanges(baysWith(olderByInstant), queuesWith(newerByInstant)), [newerByInstant])).toEqual(
      {
        eligible: [],
        lastMerge: { commit: "e".repeat(40), at: "2026-01-03T22:00:00.000Z" },
      },
    )
  })
})

describe("legacy merge-clock migration", () => {
  it("preserves the honest whole-run upper bound after merge Jobs were pruned", () => {
    const legacy = mergedRun(
      "R1",
      [snapshot({ id: "PR9", branch: "task/legacy-clock", revision: 1 })],
      DERIVED_MERGE_AT,
    )
    const queues = queuesWith(legacy)
    const jobs = {
      byId: {},
      byKey: {},
      retention: {
        next: 1,
        standaloneTerminalOrder: {},
        queueRoots: {},
        queueTerminalOrder: {},
        legacyQueueRoots: {},
        detachedQueueJobs: {},
      },
    }

    expect(Queues.get(backfillIntegrationTimes(queues, jobs), "R1")).toMatchObject({
      integrationAt: DERIVED_MERGE_AT,
      passedAt: DERIVED_MERGE_AT,
    })
  })
})
