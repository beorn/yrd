import { describe, expect, it } from "vitest"
import { holdsPlaceInLine, inLine, readChange } from "../src/state.ts"
import type { ChangeRecord } from "../src/records.ts"
import type { ChangeRecords } from "../src/state.ts"

function record(kind: string, trailers: readonly (readonly [string, string])[] = []): ChangeRecord {
  return {
    at: new Date("2026-09-18T20:00:00.000Z"),
    kind: kind as ChangeRecord["kind"],
    sha: "1".repeat(40),
    subject: `test ${kind}`,
    trailers,
  }
}

describe("deferred state and line placement", () => {
  it("a deferred change holds no place in line; a new head returns it to normal", () => {
    // 1. holdsPlaceInLine("deferred") is false
    expect(holdsPlaceInLine("deferred" as any)).toBe(false)

    // 2. readChange derives state "deferred" and reason from trailers
    const deferredChange: ChangeRecords = {
      branch: "task/wide",
      head: "a".repeat(40),
      headOnTarget: false,
      branchHead: "a".repeat(40),
      records: [
        record("opened", [["Opened", "2026-09-18T19:00:00.000Z"]]),
        record("checked", [["Opened", "2026-09-18T19:00:00.000Z"]]),
        record("deferred", [
          ["Opened", "2026-09-18T19:00:00.000Z"],
          ["Reason", "projection-exceeded"],
          ["ProjectedMs", "3480000"],
          ["BoundMs", "1800000"],
        ]),
      ],
    }

    const reading = readChange(deferredChange)
    expect(reading).toEqual({
      state: "deferred",
      reason: "projection-exceeded",
    })

    // 3. inLine excludes deferred changes
    const queuedChange: ChangeRecords = {
      branch: "task/normal",
      head: "b".repeat(40),
      headOnTarget: false,
      branchHead: "b".repeat(40),
      records: [record("opened", [["Opened", "2026-09-18T19:30:00.000Z"]])],
    }

    const line = inLine([deferredChange, queuedChange])
    expect(line.map((c) => c.branch)).toEqual(["task/normal"])

    // 4. A new head or resubmission returns the change to queued (normal)
    const resubmittedChange: ChangeRecords = {
      branch: "task/wide",
      head: "a".repeat(40),
      headOnTarget: false,
      branchHead: "a".repeat(40),
      records: [
        ...deferredChange.records,
        record("opened", [["Opened", "2026-09-18T20:30:00.000Z"]]),
      ],
    }

    const retriedReading = readChange(resubmittedChange)
    expect(retriedReading).toEqual({ state: "queued" })
    expect(holdsPlaceInLine(retriedReading.state)).toBe(true)

    // And a new head entirely:
    const newHeadChange: ChangeRecords = {
      branch: "task/wide",
      head: "c".repeat(40),
      headOnTarget: false,
      branchHead: "c".repeat(40),
      records: [record("opened", [["Opened", "2026-09-18T20:35:00.000Z"]])],
    }
    const newHeadReading = readChange(newHeadChange)
    expect(newHeadReading).toEqual({ state: "queued" })
    expect(holdsPlaceInLine(newHeadReading.state)).toBe(true)
  })
})
