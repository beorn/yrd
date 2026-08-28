/**
 * @failure A read surface joins every run member against the retained change
 * record store and ABORTS the whole read on the first member the store cannot
 * answer for, so one journal write that never landed blinds `yrd log`, `yrd
 * queue list` and the timeline for every caller — including the caller who
 * asked for five rows that did not include it (@i/10-yrd/23228, measured on
 * live main 2026-08-27: `R3578` referencing an unjournaled `PR2131`, exit 3
 * under every flag combination, with no scoping flag able to route around it).
 * @level l2
 * @consumer @yrd/cli every `log` / `queue list` / timeline operator
 *
 * WHAT IS PINNED. A read answers a question about a POPULATION, so it renders
 * every member it can and REPORTS the ones it cannot — never an abort, and
 * never a silent skip, which would be the worse bug: the caller would believe
 * the history was whole. Both directions are pinned here, because either one
 * alone is satisfiable by a wrong fix: the readable members must all survive
 * one unreadable sibling, AND the surfaces that have no fault accounting to
 * report through must still refuse loudly.
 *
 * The sibling gate {@link ./reader-lane-gate.test.ts} pins the other half of
 * the same join — a member with no RECORD AT ALL, which post-S6 is a legal
 * derived member rather than a fault.
 */
import { describe, expect, it } from "vitest"

import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  queueLogRows,
  queueMemberReadFaultSummary,
  queueRunRevisionKey,
  queueRunRevisionReads,
  queueTimelineAdmissionReads,
  queueTimelineProjection,
  runRevisionClock,
  type QueueStatusResult,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
/** A head the fixture's record has never carried a revision at. */
const UNJOURNALED_HEAD = "f".repeat(40)
/** A revision number the fixture's record has never journaled. */
const UNJOURNALED_REVISION = 7

type Run = QueueStatusResult["finished"][number]

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
 * The healthy fixture PLUS one completed run that pins a revision of a real,
 * retained change record which the record never journaled — the shape a merge
 * leaves behind when the writer lock starves and its revision write is lost.
 * The record store is untouched, so every other row stays readable.
 */
function unreadableMemberResults(): readonly QueueStatusResult[] {
  const results = contractResults()
  const first = results[0]
  if (first === undefined) throw new Error("contract-overview has no queue result")
  const seed = completedRun(first)
  const member = seed.prs[0]
  if (member === undefined) throw new Error("seed run has no members")
  const danglingRun: Run = {
    ...seed,
    id: "R9101",
    prs: [{ ...member, revision: UNJOURNALED_REVISION, headSha: UNJOURNALED_HEAD }],
  }
  return [{ ...first, finished: [...first.finished, danglingRun] }, ...results.slice(1)]
}

/** The whole-population clock read, wired exactly as `run.ts` wires the live
 * `yrd log` path: every retained record against every finished run. */
function readsOf(results: readonly QueueStatusResult[]) {
  return queueRunRevisionReads(
    results.flatMap((result) => result.prs),
    results.flatMap((result) => result.finished),
  )
}

function project(results: readonly QueueStatusResult[]): QueueTimelineProjection {
  return queueTimelineProjection(results, {
    now: NOW,
    windowMs: 6 * 60 * 60_000,
    statuses: ["pending", "running", "rejected", "integrated", "other"],
    terms: [],
    latest: false,
    rowLimit: 500,
    submissionTimes: queueTimelineAdmissionReads(results).submissionTimes,
  })
}

describe("reader unreadable-member gate — one unresolvable member never blinds the read", () => {
  const healthy = contractResults()
  const faulted = unreadableMemberResults()
  const healthyFirst = healthy[0]
  const faultedFirst = faulted[0]
  if (healthyFirst === undefined || faultedFirst === undefined) throw new Error("missing result")
  const memberId = completedRun(healthyFirst).prs[0]?.id
  if (memberId === undefined) throw new Error("seed run has no members")

  it("the clock read completes, keeps every readable clock, and reports the one it could not build", () => {
    const healthyReads = readsOf(healthy)
    const reads = readsOf(faulted)

    // Every clock the healthy read built is still built. This is the assertion
    // the abort destroyed: the answer to the caller's actual question.
    expect(reads.clocks.size).toBe(healthyReads.clocks.size)
    expect(healthyReads.faults.size).toBe(0)

    expect([...reads.faults.values()]).toEqual([
      {
        run: "R9101",
        change: memberId,
        revision: UNJOURNALED_REVISION,
        headSha: UNJOURNALED_HEAD,
        reason: "revision-not-retained",
        message: expect.stringContaining("the write was never journaled") as unknown as string,
      },
    ])
    // Keyed exactly like the clocks, so a renderer holding both marks precisely
    // the row that is unreadable.
    expect(reads.faults.has(queueRunRevisionKey({ id: "R9101" }, faultedFirst.finished.at(-1)!.prs[0]!))).toBe(true)
  })

  it("`yrd log` renders every readable row and MARKS the unreadable one with its id and reason", () => {
    const healthyClocks = readsOf(healthy)
    const healthyRows = queueLogRows(
      healthy,
      new Set<string>(),
      undefined,
      new Map(),
      [],
      new Map(),
      healthyClocks.clocks,
      healthyClocks.faults,
    )
    // One read, its clocks and its faults handed to the projector together.
    const reads = readsOf(faulted)
    const rows = queueLogRows(
      faulted,
      new Set<string>(),
      undefined,
      new Map(),
      [],
      new Map(),
      reads.clocks,
      reads.faults,
    )

    expect(rows).toHaveLength(healthyRows.length + 1)
    expect(rows.filter((row) => row.unreadable !== undefined)).toHaveLength(1)
    const marked = rows.find((row) => row.run === "R9101")
    expect(marked?.pr).toBe(memberId)
    expect(marked?.unreadable?.reason).toBe("revision-not-retained")
    expect(marked?.unreadable?.run).toBe("R9101")
    expect(marked?.unreadable?.headSha).toBe(UNJOURNALED_HEAD)
    // No submission time was inventable, and none was invented.
    expect(marked?.submittedAt).toBeUndefined()
    expect(marked?.age).toBe("-")
    // The readable rows are byte-identical to the healthy read.
    expect(rows.filter((row) => row.run !== "R9101")).toEqual(healthyRows)
  })

  it("`yrd queue list` projects the row and reports the fault on the projection", () => {
    const healthyProjection = project(healthy)
    const projection = project(faulted)

    expect(healthyProjection.readFaults).toEqual([])
    expect(projection.rows.filter((row) => row.run === "R9101")).toHaveLength(1)
    expect(projection.readFaults).toHaveLength(1)
    expect(projection.readFaults[0]).toMatchObject({ run: "R9101", change: memberId, reason: "revision-not-retained" })
    const marked = projection.rows.find((row) => row.run === "R9101")
    expect(marked?.unreadable?.reason).toBe("revision-not-retained")
    expect(marked?.detail).toContain("unreadable: revision-not-retained")
    // Every row the healthy projection produced still projects.
    expect(projection.rows.filter((row) => row.run !== "R9101")).toEqual(healthyProjection.rows)
  })

  it("the report names the run, the change, the revision@sha and why", () => {
    const summary = queueMemberReadFaultSummary(project(faulted).readFaults)
    expect(summary).toContain("1 unreadable row")
    expect(summary).toContain(memberId)
    expect(summary).toContain(`rev${String(UNJOURNALED_REVISION)}`)
    expect(summary).toContain(UNJOURNALED_HEAD.slice(0, 12))
    expect(summary).toContain("R9101")
    expect(summary).toContain("revision-not-retained")
    expect(queueMemberReadFaultSummary([])).toBeUndefined()
  })

  it("a healthy population reads exactly as before — no fault, no mark, no extra row", () => {
    const reads = readsOf(healthy)
    const args = [new Set<string>(), undefined, new Map(), [], new Map()] as const
    const rows = queueLogRows(healthy, ...args, reads.clocks, reads.faults)
    expect(rows.some((row) => row.unreadable !== undefined)).toBe(false)
    expect(project(healthy).rows.some((row) => row.unreadable !== undefined)).toBe(false)
    expect(reads.faults.size).toBe(0)
    // …and identical to the read that has no fault channel at all.
    expect(rows).toEqual(queueLogRows(healthy, ...args, reads.clocks))
  })

  it("still fails LOUD where there is no fault accounting to report through", () => {
    const danglingRun = faultedFirst.finished.at(-1)
    const record = faultedFirst.prs.find((pr) => pr.id === memberId)
    if (danglingRun === undefined || record === undefined) throw new Error("missing fixture rows")

    // The writer/gate projection is unchanged: a missing clock is a refusal.
    expect(() => runRevisionClock(record, danglingRun)).toThrow(
      `run 'R9101' has no retained revision clock for change '${memberId}' revision ${String(UNJOURNALED_REVISION)}@${UNJOURNALED_HEAD}`,
    )

    // A projector handed clocks but NO faults has no accounting for the gap and
    // must refuse rather than quietly render a record member with no clock.
    expect(() =>
      queueLogRows(faulted, new Set<string>(), undefined, new Map(), [], new Map(), readsOf(faulted).clocks),
    ).toThrow(
      `run 'R9101' has no causal submit/check-request clock for change '${memberId}' revision ${String(UNJOURNALED_REVISION)}@${UNJOURNALED_HEAD}`,
    )

    // And it refuses instead of answering with an empty population.
    expect(project(faulted).rows.length).toBeGreaterThan(1)
  })
})
