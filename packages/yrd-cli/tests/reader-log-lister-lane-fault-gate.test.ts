/**
 * @failure `queueLogRows` derives its OWN record/derived tolerance from
 * `results[i].prs`, which in production (`logRuns`) is `queueChanges(bays,
 * queues)` — record lane PLUS the derived lane. `queueRunRevisionReads`'s
 * whole-population read joins against the narrower record-only lane
 * (`recordChanges(bays)`) instead, exactly as the e78134986 containment fix
 * wired it. A change that is still a LIVE derived (recordless) member reads as
 * present in the wider set, so `isDerivedMemberId` inside `queueLogRows`
 * answers "not derived" for it — the built-in tolerance for a legitimately
 * clockless derived member never fires — and because
 * `queueRunRevisionReads` never flagged it as a fault either (from the
 * record-only lane it correctly looks derived, not corrupt), nothing stops
 * `queueLogSubmissionTime`'s final refusal from throwing and aborting the
 * whole `yrd log` read. Measured live 2026-09-01 (reported twice by @ci):
 * `yrd log -L 20 --json` exits 3 with "run 'R3578' has no causal
 * submit/check-request clock for change 'PR2131' revision 1@24b8aef…" under
 * every flag combination — the exact run/change the 2026-08-27 incident that
 * `reader-unreadable-member-gate.test.ts` and `reader-lane-gate.test.ts`
 * pinned, surfacing through a THIRD mechanism neither of those gates' fixtures
 * shape: their `results[i].prs` never includes the derived/intent synthetic
 * members they add only to a run's `prs`, so `queueLogRows`'s own `recordIds`
 * never went wide enough in either fixture to reproduce this join.
 * @level l2
 * @consumer @yrd/cli every `yrd log` operator
 *
 * WHAT IS PINNED. `queueLogRows` is the lister's own per-row derivation loop:
 * a member it cannot resolve — for ANY reason, including one
 * `queueRunRevisionReads` did not itself flag — renders as an explicit
 * unreadable row (id, reason, verbatim cause) rather than aborting the rest,
 * whenever the caller passed fault accounting at all. A caller that passed
 * NO accounting (`readFaults` undefined — `--strict`'s shape) keeps the
 * historical loud refusal, because it has no way to tell a legitimate gap
 * from corruption and must not guess
 * ({@link ./reader-unreadable-member-gate.test.ts}'s "still fails LOUD").
 */
import { describe, expect, it } from "vitest"
import type { Change } from "@yrd/bay"

import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import { queueLogRows, queueRunRevisionReads, type QueueStatusResult } from "../src/queue-status-view.tsx"

type Run = QueueStatusResult["finished"][number]
type Member = Run["prs"][number]

const DERIVED_ID = "PR2131"
const DERIVED_HEAD = "24b8aef000000000000000000000000000000000".slice(0, 40)

function contractResults(): readonly QueueStatusResult[] {
  const results = queueTimelineStories["contract-overview"]?.snapshot.results
  if (results === undefined) throw new Error("contract-overview is missing its queue results")
  return results
}

function completedRun(result: QueueStatusResult): Run {
  const run = result.finished.find((candidate) => candidate.status === "completed")
  if (run === undefined) throw new Error("contract-overview has no completed Run to clone")
  return run
}

/**
 * The healthy fixture PLUS one completed run ("R3578") pinning a member
 * ("PR2131") that is a LIVE DERIVED snapshot — present in this base's `prs`
 * population (as `queueChanges` would surface it), never in the record store.
 * Every other row is untouched.
 */
function liveDerivedMemberResults(): readonly QueueStatusResult[] {
  const results = contractResults()
  const first = results[0]
  if (first === undefined) throw new Error("contract-overview has no queue result")
  const seed = completedRun(first)
  const seedRecord = first.prs.find((pr) => pr.id === seed.prs[0]?.id)
  if (seedRecord === undefined) throw new Error("seed run's member has no record")

  const derivedMember: Member = {
    id: DERIVED_ID,
    branch: "yrd/intent/pr2131",
    base: "main",
    revision: 1,
    headSha: DERIVED_HEAD,
    baseSha: seedRecord.revs[0]?.baseSha ?? "a".repeat(40),
  }
  // A recordless Change snapshot, shaped like `changeOfSnapshot` would build
  // one for a still-live derived branch: present in `prs` (queueChanges'
  // record+derived union), absent from the record store proper.
  const derivedSnapshot: Change = { ...seedRecord, id: DERIVED_ID, revs: [], checkRequests: [], submittedAt: undefined }
  const danglingRun: Run = { ...seed, id: "R3578", prs: [derivedMember] }

  return [
    { ...first, prs: [...first.prs, derivedSnapshot], finished: [...first.finished, danglingRun] },
    ...results.slice(1),
  ]
}

/** The whole-population clock read, wired exactly as `run.ts` wires the live
 * `yrd log` path: RECORD-ONLY prs (`recordChanges(state.bays)`) against every
 * finished run — deliberately narrower than `results[i].prs`, which in
 * production carries the derived lane too. */
function readsOf(results: readonly QueueStatusResult[], recordOnlyPrs: readonly Change[]) {
  return queueRunRevisionReads(recordOnlyPrs, results.flatMap((result) => result.finished))
}

describe("reader log-lister lane-fault gate — a live derived member never blinds `yrd log`", () => {
  const healthy = contractResults()
  const faulted = liveDerivedMemberResults()
  const healthyFirst = healthy[0]
  const faultedFirst = faulted[0]
  if (healthyFirst === undefined || faultedFirst === undefined) throw new Error("missing result")
  // recordChanges(state.bays) never grows with the derived lane, so the
  // record-only population is the UNCHANGED original prs list for both reads.
  const recordOnlyPrs = healthyFirst.prs

  it("`yrd log` renders every healthy row and MARKS the live-derived member's row instead of throwing", () => {
    const healthyRows = queueLogRows(
      healthy,
      new Set<string>(),
      undefined,
      new Map(),
      [],
      new Map(),
      readsOf(healthy, recordOnlyPrs).clocks,
      readsOf(healthy, recordOnlyPrs).faults,
    )
    const reads = readsOf(faulted, recordOnlyPrs)
    // The record-only read never even sees PR2131 (it is not in recordOnlyPrs
    // at all), so it neither clocks it nor faults it — from that lane it is
    // legitimately derived, not corrupt.
    expect([...reads.faults.keys()].some((key) => key.includes(DERIVED_ID))).toBe(false)

    let rows: ReturnType<typeof queueLogRows> | undefined
    expect(() => {
      rows = queueLogRows(faulted, new Set<string>(), undefined, new Map(), [], new Map(), reads.clocks, reads.faults)
    }).not.toThrow()

    expect(rows).toHaveLength(healthyRows.length + 1)
    const marked = rows?.find((row) => row.run === "R3578")
    expect(marked?.pr).toBe(DERIVED_ID)
    expect(marked?.unreadable?.reason).toBe("no-causal-clock")
    expect(marked?.unreadable?.run).toBe("R3578")
    expect(marked?.unreadable?.change).toBe(DERIVED_ID)
    expect(marked?.unreadable?.headSha).toBe(DERIVED_HEAD)
    // The verbatim cause, not a paraphrase — loud, never swallowed.
    expect(marked?.unreadable?.message).toContain(
      `run 'R3578' has no causal submit/check-request clock for change '${DERIVED_ID}' revision 1@${DERIVED_HEAD}`,
    )
    expect(marked?.submittedAt).toBeUndefined()
    expect(marked?.age).toBe("-")
    // Every healthy row is untouched.
    expect(rows?.filter((row) => row.run !== "R3578")).toEqual(healthyRows)
  })

  it("still fails LOUD with no fault accounting at all — the `--strict` shape", () => {
    const reads = readsOf(faulted, recordOnlyPrs)
    expect(() =>
      queueLogRows(faulted, new Set<string>(), undefined, new Map(), [], new Map(), reads.clocks),
    ).toThrow(
      `run 'R3578' has no causal submit/check-request clock for change '${DERIVED_ID}' revision 1@${DERIVED_HEAD}`,
    )
  })
})
