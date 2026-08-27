/**
 * @failure A read view joins a run member against the retained record store and
 * throws on the first member the store does not hold, so ONE mixed-lane state —
 * record, derived, and intent members coexisting — crashes `yrd queue status`,
 * `yrd log`, and the timeline for the whole repository. This exact state is
 * live main post-S6 (2026-08-27: PR2131's derived member crashed three readers
 * serially, each discovered by a production incident, because no fixture held
 * the mix). This gate is the batch report: every reader entry point runs over
 * one composed mixed-lane state, so an S5 consumer regression fails HERE, once,
 * instead of live, serially.
 * @level l2
 * @consumer @yrd/cli every status/log/timeline operator; the 22991 S5 cutover
 */
import { describe, expect, it } from "vitest"

import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  queueLogRows,
  queueRunRevisionClocks,
  queueTimelineAdmissionTimes,
  queueTimelineProjection,
  type QueueStatusResult,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"

type Run = QueueStatusResult["finished"][number]
type Member = Run["prs"][number]

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
const PRIOR_PIN = "91297cd0be71845fb268f1e9d999172d3660caf1"
const TARGET = "a659df38e3ec2a093b9a16b7514adab10966630a"

function contractResults(): readonly QueueStatusResult[] {
  const results = queueTimelineStories["contract-overview"]?.snapshot.results
  if (results === undefined) throw new Error("contract-overview is missing its queue results")
  return results
}

/** An intent member (carrier-free pin intent, the R1480/I2 shape). */
function intentMember(id: string): Member {
  return {
    id,
    branch: "yrd/intent/yrd-e8220247527a",
    base: "main",
    issue: "@i/23-yrd-vocabulary",
    revision: 1,
    headSha: "e8220247527a9189e42dc7354ecf62712ea38ee4",
    baseSha: PRIOR_PIN,
    intent: {
      id,
      authored: {
        intentId: "01b3cb0b-c24d-4c38-a578-8434f041fb4a",
        issue: { source: "km", id: "@i/23-yrd-vocabulary" },
        component: "vendor/yrd",
        target: TARGET,
      },
      evaluated: { priorPin: PRIOR_PIN, target: TARGET },
    },
  } as Member
}

/** A derived member: recordless and non-intent — post-S6 the normal shape for
 * a refs/for submission. Its id deliberately sits BELOW the record range,
 * because lane numbering interleaves (the frontier rule died on this). */
function derivedMember(id: string): Member {
  return { ...intentMember(id), id, intent: undefined } as Member
}

/**
 * The gate state: the contract fixture's retained records and completed runs,
 * PLUS one run holding a record member, a derived member, and an intent member
 * TOGETHER, plus one all-derived run. The retained prs list is untouched, so
 * the derived/intent members have no record to join — exactly live main.
 */
function mixedLaneResults(): readonly QueueStatusResult[] {
  const results = contractResults()
  const first = results[0]
  if (first === undefined) throw new Error("contract-overview has no queue result")
  const seed = first.finished.find((run) => run.status === "completed")
  if (seed === undefined) throw new Error("contract-overview has no completed Run to clone")
  const recordMember = seed.prs[0]
  if (recordMember === undefined) throw new Error("seed run has no members")
  const mixedRun: Run = {
    ...seed,
    id: "R9001",
    prs: [recordMember, derivedMember("PR9"), intentMember("I9")],
  }
  const derivedRun: Run = { ...seed, id: "R9002", prs: [derivedMember("PR9002")] }
  return [{ ...first, finished: [...first.finished, mixedRun, derivedRun] }, ...results.slice(1)]
}

function project(results: readonly QueueStatusResult[]): QueueTimelineProjection {
  return queueTimelineProjection(results, {
    now: NOW,
    windowMs: 6 * 60 * 60_000,
    statuses: ["pending", "running", "rejected", "integrated", "other"],
    terms: [],
    latest: false,
    rowLimit: 500,
    submissionTimes: queueTimelineAdmissionTimes(results),
  })
}

describe("reader lane gate — every read view survives one mixed-lane state", () => {
  const results = mixedLaneResults()
  const first = results[0]
  if (first === undefined) throw new Error("missing result")

  it("admission times: no member kind throws; derived and intent clock null", () => {
    const times = queueTimelineAdmissionTimes(results)
    expect(times.size).toBeGreaterThan(0)
    const derivedKey = JSON.stringify(["R9001", "PR9", 1, "e8220247527a9189e42dc7354ecf62712ea38ee4"])
    expect(times.get(derivedKey)).toBe(null)
  })

  it("revision clocks: records clock, derived and intent members are skipped, never thrown on", () => {
    const clocks = queueRunRevisionClocks(first.prs, first.finished)
    expect(clocks.size).toBeGreaterThan(0)
    for (const key of clocks.keys()) {
      expect(key.includes('"PR9"')).toBe(false)
      expect(key.includes('"I9"')).toBe(false)
    }
  })

  it("timeline projection renders a row for every member of the mixed run", () => {
    const projection = project(results)
    for (const id of [String(first.finished.find((run) => run.status === "completed")?.prs[0]?.id), "PR9", "I9", "PR9002"]) {
      const row = projection.rows.find((candidate) => candidate.pr === id)
      expect(row, `timeline row for ${id}`).toBeDefined()
    }
  })

  it("log rows render every member; derived and intent carry age '-', records carry a real age", () => {
    // Clocks built from the same state, exactly as run.ts wires the live path —
    // an empty map with record members present is the deliberate loud path.
    const clocks = queueRunRevisionClocks(first.prs, first.finished)
    const rows = queueLogRows(results, new Set<string>(), undefined, new Map(), [], new Map(), clocks)
    const derived = rows.find((row) => row.pr === "PR9")
    const intent = rows.find((row) => row.pr === "I9")
    expect(derived).toBeDefined()
    expect(intent).toBeDefined()
    expect(derived?.age).toBe("-")
    expect(derived?.submittedAt).toBeUndefined()
  })

  it("the whole battery runs on the all-derived run too — a run with zero records is a legal state", () => {
    const derivedOnly = [{ ...first, finished: first.finished.filter((run) => run.id === "R9002") }]
    expect(() => queueTimelineAdmissionTimes(derivedOnly)).not.toThrow()
    expect(() => queueRunRevisionClocks(first.prs, derivedOnly[0]!.finished)).not.toThrow()
    const rows = queueLogRows(derivedOnly, new Set<string>(), undefined, new Map(), [], new Map(), new Map())
    expect(rows.find((row) => row.pr === "PR9002")).toBeDefined()
  })
})
