// @failure a legacy head, state or record commit disappears during event conversion.
// @level l1
// @consumer one-shot 25041 converter and its per-head parity receipt

import { describe, expect, it } from "vitest"
import { eventRows } from "../src/event-table.ts"
import { evolve, initial } from "../src/events.ts"
import { inputsForLegacy, migratedStatus, sourcesForMigration, type LegacyMigrationChange } from "../src/migration.ts"
import type { ChangeRecord } from "../src/legacy-records.ts"
import type { QueueRead } from "../src/remote.ts"

const HEAD = "a".repeat(40)
const QUEUE = "b".repeat(40)
const REF = `refs/yrd/main/task/example@${HEAD}`
const OPENED = "2026-09-24T10:00:00.000Z"

function record(
  kind: ChangeRecord["kind"],
  sha: string,
  at: string,
  extra: readonly (readonly [string, string])[] = [],
  openedAt = OPENED,
): ChangeRecord {
  return {
    kind,
    sha,
    at: new Date(at),
    subject: `${kind} task/example`,
    trailers: [["Opened", openedAt], ["Submitter", "@dev/2"], ["Issue", "25041"], ...extra],
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
  it("uses the captured list state when hydrating a record history changes its fold", () => {
    const opened = record("opened", "1".repeat(40), OPENED)
    const tip = record("sent", "2".repeat(40), "2026-09-24T10:05:00.000Z")
    const captured: QueueRead = [
      {
        change: { branch: "task/example", head: HEAD, headOnTarget: true, records: [tip] },
        reading: { state: "merged" },
      },
    ]
    const hydrated: QueueRead = [
      {
        change: { branch: "task/example", head: HEAD, headOnTarget: true, records: [opened, tip] },
        reading: { state: "withdrawn" as const, reason: "superseded" },
      },
    ]
    const selected = sourcesForMigration("main", captured, hydrated)
    expect(selected[0]?.reading.state).toBe("merged")
    expect(selected[0]?.change.records).toEqual([opened, tip])
    expect(selected[0]?.ref).toBe(REF)
    expect(() =>
      sourcesForMigration("main", captured, [
        {
          change: { branch: "task/example", head: HEAD, headOnTarget: true, records: [opened] },
          reading: { state: "withdrawn" },
        },
      ]),
    ).toThrow(/tip differs/)
  })
  it("absorbs checked-at-rest into one queued event and keeps every old record", () => {
    const opened = record("opened", "1".repeat(40), OPENED)
    const checked = record("checked", "2".repeat(40), "2026-09-24T10:05:00.000Z")
    const inputs = inputsForLegacy(source([opened, checked], { state: "checked" }), QUEUE)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.type).toBe("opened")
    expect(inputs[0]?.props).toContainEqual(["Time", OPENED])
    expect(inputs[0]?.props?.filter(([key]) => key === "Migrated-From")).toEqual([
      ["Migrated-From", `${REF}@${opened.sha}`],
      ["Migrated-From", `${REF}@${checked.sha}`],
    ])
    expect(inputs[0]?.keeps).toEqual([HEAD, opened.sha, checked.sha])
    expect(migrated(inputs).status).toBe("queued")
  })

  it("keeps two queued heads in Opened order when their later record times invert", () => {
    const first = source(
      [record("opened", "1".repeat(40), OPENED), record("checked", "2".repeat(40), "2026-09-24T10:05:00.000Z")],
      { state: "checked" },
    )
    const secondOpened = "2026-09-24T10:03:00.000Z"
    const secondHead = "c".repeat(40)
    const second = {
      ref: `refs/yrd/main/task/second@${secondHead}`,
      change: {
        branch: "task/second",
        head: secondHead,
        headOnTarget: false,
        records: [
          record("opened", "3".repeat(40), secondOpened, [], secondOpened),
          record("checked", "4".repeat(40), "2026-09-24T10:04:00.000Z", [], secondOpened),
        ],
      },
      reading: { state: "checked" },
    } satisfies LegacyMigrationChange
    const rows = eventRows(
      new Map([
        ["task/example", migrated(inputsForLegacy(first, QUEUE))],
        ["task/second", migrated(inputsForLegacy(second, QUEUE))],
      ]),
    )
    expect(rows.map(({ branch, position }) => [branch, position])).toEqual([
      ["task/example", 1],
      ["task/second", 2],
    ])
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

  it("keeps a merged head merged when a later head gives its fold a superseded reason", () => {
    const opened = record("opened", "1".repeat(40), OPENED)
    const ended = record("merged", "2".repeat(40), "2026-09-24T10:05:00.000Z")
    const reading = { state: "merged" as const, reason: "superseded", supersededBy: "c".repeat(40) }
    expect(migratedStatus(reading)).toBe("merged")
    expect(inputsForLegacy(source([opened, ended], reading), QUEUE).map(({ type }) => type)).toEqual([
      "opened",
      "merged",
    ])
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
