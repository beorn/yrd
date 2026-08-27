/**
 * @failure An intent-integrated Run's member id is an intent id with no retained PR, so every
 * retained-PR join in the queue/log read views throws and `yrd queue` / `yrd log` crash for
 * the whole repository the moment the first carrier-free pin intent merges.
 * @level l2
 * @consumer @yrd/cli `yrd queue` / `yrd log` operators
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

/** A carrier-free pin-intent member, shaped like the Queue's materialized
 * ChangeSnapshot for a merged intent (the real R1480/I2 shape). Its id is an
 * intent id, so it can never resolve against the retained PR list. */
function intentMember(id: string = "I2"): Member {
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

/** Clone the fixture's completed Run into an intent-integrated Run whose only
 * member is the intent snapshot; the retained PR list is left untouched, so
 * the member has no PR to join against. */
function withIntentRun(results: readonly QueueStatusResult[], id: string = "I2"): readonly QueueStatusResult[] {
  const first = results[0]
  if (first === undefined) throw new Error("contract-overview has no queue result")
  const seed = first.finished.find((run) => run.status === "completed")
  if (seed === undefined) throw new Error("contract-overview has no completed Run to clone")
  const run: Run = { ...seed, id: "R1480", prs: [intentMember(id)] }
  return [{ ...first, finished: [...first.finished, run] }, ...results.slice(1)]
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

describe("intent-integrated runs in the queue read views", () => {
  it("admission times survive a run member with no retained PR", () => {
    expect(() => queueTimelineAdmissionTimes(withIntentRun(contractResults()))).not.toThrow()
  })

  it("revision clocks tolerate EVERY recordless member — number-independent, because legacy mints interleave", () => {
    const results = withIntentRun(contractResults())
    const first = results[0]
    if (first === undefined) throw new Error("missing result")
    expect(() => queueRunRevisionClocks(first.prs, first.finished)).not.toThrow()

    // Post-S6 a recordless, non-intent run member IS a derived member: records
    // are never deleted, so "a record the store lost" is not a representable
    // state. The rule is deliberately number-independent — an earlier revision
    // classified by number-above-the-record-max, and one record-lane submit
    // (grandfathered A2 legacy mint) moved the max past live derived members
    // and crashed every status view (PR2135 vs PR2131, 2026-08-27). Both a
    // low id (PR9) and a high id (PR777) must tolerate identically.
    for (const id of ["PR9", "PR777"]) {
      const derivedRun: Run = {
        ...first.finished[first.finished.length - 1]!,
        id: "R9999",
        prs: [{ ...intentMember(), id, intent: undefined } as Member],
      }
      expect(() => queueRunRevisionClocks(first.prs, [derivedRun])).not.toThrow()
      expect(queueRunRevisionClocks(first.prs, [derivedRun]).size).toBe(0)
      // And its admission clock derives from the run itself, like an intent's.
      const derivedResults = [{ ...first, finished: [...first.finished, derivedRun] }]
      const times = queueTimelineAdmissionTimes(derivedResults)
      expect(
        times.get(JSON.stringify(["R9999", id, derivedRun.prs[0]!.revision, derivedRun.prs[0]!.headSha])),
      ).toBe(null)
    }
  })

  it("yrd log rows tolerate a derived member's missing revision clock — a record's absence stays loud", () => {
    const results = contractResults()
    const first = results[0]
    if (first === undefined) throw new Error("missing result")
    const seed = first.finished.find((run) => run.status === "completed")
    if (seed === undefined) throw new Error("no completed run to clone")
    // A derived member: recordless (absent from the summary's prs) and not an
    // intent. Post-S6 its admission is the git submit fact; no record-lane
    // clock exists, so the clocks builder skips it and the log reader's lookup
    // misses. That miss must render (age "-"), never throw — the live crash
    // this pins was `yrd log` failing on PR2131 after the clock join was
    // reached once the retained-change join was cured (2026-08-27).
    const derivedRun: Run = { ...seed, id: "R9999", prs: [{ ...intentMember(), id: "PR9", intent: undefined } as Member] }
    const summary = { ...first, finished: [derivedRun] }
    const rows = queueLogRows([summary], new Set<string>(), undefined, new Map(), [], new Map(), new Map())
    const row = rows.find((candidate) => candidate.pr === "PR9")
    expect(row).toBeDefined()
    expect(row?.age).toBe("-")
    expect(row?.submittedAt).toBeUndefined()
  })

  it("the timeline projection renders a row for the intent run instead of crashing", () => {
    const projection = project(withIntentRun(contractResults()))
    const row = projection.rows.find((candidate) => candidate.pr === "I2")
    expect(row).toBeDefined()
    expect(row?.run).toBe("R1480")
    expect(row?.issue).toBe("@i/23-yrd-vocabulary")
  })

  it("renders a row for a yrdpin# member, the id every new intent is minted under", () => {
    const projection = project(withIntentRun(contractResults(), "yrdpin#162"))
    const row = projection.rows.find((candidate) => candidate.pr === "yrdpin#162")
    expect(row).toBeDefined()
    expect(row?.run).toBe("R1480")
  })
})
