/**
 * @failure The queue's progress machinery read the RECORD lane only, so a
 * derived-lane merge advanced nothing: on 2026-08-31 the dead-man reported
 * "no merge for 51m" while PR2769 and PR2770 merged inside that window —
 * a standing false-alarm channel on the one rail built to catch real stalls
 * (@i/10-yrd C3b; the memory row "the runner panel's no-merge-for-N is
 * frozen by derived-lane merges" is this same defect on its read side).
 * `latestQueueMergeMs` now derives from BOTH lanes; a derived member's merge
 * time is the run lane's own stamp (`derivedIntegration` → `passedAt`), the
 * trustworthy source the record fields only mirror. The population switch in
 * `queueProgressQueue` and the `no-submitted-prs` diagnostic ride the same
 * `queueChanges` expression; this file pins the clock, where the measured
 * false alarm lived.
 * @level l1
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import type { BaysState, Change } from "@yrd/bay"
import { Queues, type ChangeSnapshot, type InstalledStep, type QueueRecord, type QueuesState } from "@yrd/queue"
// Relative on purpose: module-exported for this test only, off the package
// surface per the index's own explicit-list rule.
import { latestQueueMergeMs } from "../src/queue.ts"

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
