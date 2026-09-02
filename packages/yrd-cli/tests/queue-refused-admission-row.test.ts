/**
 * @failure An admission refused BEFORE any run existed was invisible. The
 *          refusal mints no run, so no run row carries it, and a recordless
 *          carrier is in no pre-run band either, so `timelineNonIntegratedRows`
 *          emits nothing for it. On 2026-09-02 the stats box read `FAILS 1`
 *          while eight carriers had been turned back.
 *          `queues.admissionRefusals` already held every one of them; nothing
 *          rendered it.
 * @level l1
 * @consumer @yrd/cli queue status / watch (queue-status-view)
 */
import { describe, expect, it } from "vitest"
import { queueTimelineAdmissionTimes } from "@yrd/queue"
import type { QueueStatusResult } from "@yrd/queue"
import { fixturePr, fixtureResult } from "../dev/queue-timeline-fixtures.ts"
import { queueTimelineProjection } from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-09-02T12:00:00.000Z")
const REFUSED_AT = "2026-09-02T11:40:00.000Z"
const FIRST_AT = "2026-09-02T09:05:00.000Z"
const HEAD = "9".repeat(40)

type Refusal = NonNullable<QueueStatusResult["admissionRefusals"]>[number]

/** The live shape: a carrier the queue turned back that has NO change record,
 * so nothing else on the timeline can carry it. */
function refusedResult(overrides: Partial<Refusal> = {}): QueueStatusResult {
  return {
    ...fixtureResult([], []),
    admissionRefusals: [
      {
        pr: "PR2909",
        revision: 1,
        headSha: HEAD,
        code: "check-failed",
        reason: "typecheck failed at src/a.ts:12",
        count: 1,
        firstAt: FIRST_AT,
        lastAt: REFUSED_AT,
        ...overrides,
      },
    ],
  }
}

function timeline(result: QueueStatusResult) {
  return queueTimelineProjection([result], {
    now: NOW,
    windowMs: 24 * 60 * 60_000,
    statuses: [],
    terms: [],
    latest: false,
    rowLimit: 40,
    submissionTimes: queueTimelineAdmissionTimes([result]),
  })
}

const rejected = (result: QueueStatusResult) => timeline(result).rows.filter((row) => row.status === "rejected")

describe("an admission refused before any run gets a row of its own (L8)", () => {
  it("renders one rejected row naming the code, the reason and the refusal clock", () => {
    const rows = rejected(refusedResult())
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row?.pr).toBe("PR2909")
    expect(row?.revision).toBe(1)
    expect(row?.detail).toBe("refused at admission [check-failed] — typecheck failed at src/a.ts:12")
    expect(row?.timestamp).toBe(REFUSED_AT)
    expect(row?.failure).toEqual({ code: "check-failed", message: "typecheck failed at src/a.ts:12" })
    // The age is the refusal's own, so a carrier turned back hours ago reads that way.
    expect(row?.ageMs).toBe(NOW - Date.parse(REFUSED_AT))
  })

  it("a repeated refusal says how many times and since when — nine turn-backs is not one", () => {
    const [row] = rejected(refusedResult({ count: 9 }))
    expect(row?.detail).toBe(
      `refused at admission [check-failed] — typecheck failed at src/a.ts:12 (refused 9x since ${FIRST_AT})`,
    )
  })

  it("renders nothing when the queue has refused nothing", () => {
    expect(rejected({ ...refusedResult(), admissionRefusals: [] })).toEqual([])
  })

  it("never doubles a revision another row already carries — one fact, one row", () => {
    // The change record exists and holds the refused revision, so it already
    // has its own band row; the refusal must not add a second.
    const pr = fixturePr("PR2909", "pushed", "2026-09-02T09:00:00.000Z")
    const withRecord = {
      ...refusedResult({ headSha: pr.revs[0]!.head }),
      prs: [pr],
    }
    expect(timeline(withRecord).rows.filter((row) => row.pr === "PR2909")).toHaveLength(1)
    expect(rejected(withRecord)).toEqual([])
  })

  it("skips a refusal too old to name its exact revision rather than inventing one", () => {
    // Pre-22528 journals carry no revision/headSha. There is no revision to
    // render, and guessing a current one would pin an old refusal to a
    // revision it never judged.
    expect(rejected(refusedResult({ revision: undefined, headSha: undefined }))).toEqual([])
  })
})
