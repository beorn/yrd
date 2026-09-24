// @failure a legacy head, state or record commit disappears during event conversion.
// @level l1
// @consumer one-shot 25041 converter and its per-head parity receipt

import { describe, expect, it } from "vitest"
import { evolve, initial } from "../src/events.ts"
import { inputsForLegacy, migratedStatus, type LegacyMigrationChange } from "../src/migration.ts"
import type { ChangeRecord } from "../src/legacy-records.ts"

const HEAD = "a".repeat(40)
const QUEUE = "b".repeat(40)
const REF = `refs/yrd/main/task/example@${HEAD}`
const OPENED = "2026-09-24T10:00:00.000Z"

function record(
  kind: ChangeRecord["kind"],
  sha: string,
  at: string,
  extra: readonly (readonly [string, string])[] = [],
): ChangeRecord {
  return {
    kind,
    sha,
    at: new Date(at),
    subject: `${kind} task/example`,
    trailers: [["Opened", OPENED], ["Submitter", "@dev/2"], ["Issue", "25041"], ...extra],
  }
}

function source(
  records: readonly [ChangeRecord, ...ChangeRecord[]],
  reading: LegacyMigrationChange["reading"],
): LegacyMigrationChange {
  return { ref: REF, change: { branch: "task/example", head: HEAD, headOnTarget: false, records }, reading }
}

function migrated(inputs: ReturnType<typeof inputsForLegacy>) {
  const asEvent = inputs.map((input, index) => ({
    id: String(index + 1).repeat(40),
    type: input.type,
    props: input.props ?? [],
    links: input.keeps ?? [],
  }))
  return asEvent.reduce(evolve, initial)
}

describe("25041 old resting-state conversion", () => {
  it("absorbs checked-at-rest into one queued event and keeps every old record", () => {
    const opened = record("opened", "1".repeat(40), OPENED)
    const checked = record("checked", "2".repeat(40), "2026-09-24T10:05:00.000Z")
    const inputs = inputsForLegacy(source([opened, checked], { state: "checked" }), QUEUE)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.type).toBe("opened")
    expect(inputs[0]?.props).toContainEqual(["Time", checked.at.toISOString()])
    expect(inputs[0]?.props?.filter(([key]) => key === "Migrated-From")).toEqual([
      ["Migrated-From", `${REF}@${opened.sha}`],
      ["Migrated-From", `${REF}@${checked.sha}`],
    ])
    expect(inputs[0]?.keeps).toEqual([HEAD, opened.sha, checked.sha])
    expect(migrated(inputs).status).toBe("queued")
  })

  it("maps a merged chain into opened then merged, with each source record on one event", () => {
    const opened = record("opened", "1".repeat(40), OPENED)
    const ended = record("merged", "2".repeat(40), "2026-09-24T10:05:00.000Z")
    const inputs = inputsForLegacy(source([opened, ended], { state: "merged" }), QUEUE)
    expect(inputs.map(({ type }) => type)).toEqual(["opened", "merged"])
    expect(inputs[0]?.props).toContainEqual(["Migrated-From", `${REF}@${opened.sha}`])
    expect(inputs[1]?.props).toContainEqual(["Migrated-From", `${REF}@${ended.sha}`])
    expect(migrated(inputs).status).toBe("merged")
  })

  it("projects a superseded head to the live resubmission word and fences unrecorded reasons", () => {
    const opened = record("opened", "1".repeat(40), OPENED)
    const withdrawn = record("withdrawn", "2".repeat(40), "2026-09-24T10:05:00.000Z")
    const superseded = source([opened, withdrawn], {
      state: "withdrawn",
      reason: "superseded",
      supersededBy: "c".repeat(40),
    })
    expect(migratedStatus(superseded.reading)).toBe("cancelled")
    const inputs = inputsForLegacy(superseded, QUEUE)
    expect(inputs[1]?.props).toContainEqual(["Reason", "resubmitted"])
    expect(migrated(inputs).status).toBe("cancelled")

    const unknown = inputsForLegacy(source([opened, withdrawn], { state: "withdrawn" }), QUEUE)
    expect(unknown[1]?.props).toContainEqual(["Reason", "unrecorded"])
    expect(migrated(unknown).reason).toBe("unrecorded")
  })
})
