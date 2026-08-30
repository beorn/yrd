/**
 * @failure A legacy row's compatibility object having grown a key beside `version`
 * — the shape a newer writer's frame carries — aborted the WHOLE legacy-to-SQLite
 * migration scan with a raw ZodError, before the per-row loudspeaker that actually
 * owns "is this row readable" (`parseJournalFrame`, in `publishCandidate`'s own
 * loop) ever got a chance to classify or refuse it.
 * @level l1
 * @consumer @yrd/persistence
 */
import { initialJournalVersionFloor } from "@yrd/persistence"
import { describe, expect, it } from "vitest"

/**
 * `initialJournalVersionFloor`'s `observed` branch (exercised below, `fresh:
 * false`) never reads `runtime` — only its `fresh: true` branch does, via
 * `runtime.writerVersion` — so an empty dummy stands in without needing the
 * module's unexported `Context` type.
 */
const runtime = {} as Parameters<typeof initialJournalVersionFloor>[0]

function liveRow(value: unknown, cursor = 0) {
  return { kind: "live" as const, cursor, value }
}

describe("initial journal version floor", () => {
  it("folds an absent compatibility stamp to 0, same as a frame parse does", () => {
    expect(initialJournalVersionFloor(runtime, [liveRow({})], false)).toBe(0)
    expect(initialJournalVersionFloor(runtime, [], false)).toBe(0)
  })

  it("takes the highest declared version across every live row", () => {
    const rows = [
      liveRow({ compatibility: { version: 1 } }, 0),
      liveRow({ compatibility: { version: 3 } }, 1),
      liveRow({ compatibility: { version: 2 } }, 2),
    ]
    expect(initialJournalVersionFloor(runtime, rows, false)).toBe(3)
  })

  it("never throws on a row whose compatibility object has grown a key beside `version` — contributes its declared version instead of aborting the scan", () => {
    // Regression: reading this row's version through the STRICT
    // `journalFrameCompatibility` here used to throw a raw ZodError on exactly this
    // shape (an extra key beside `version`, e.g. `requires` — the shape a newer
    // writer's frame carries), aborting this floor computation before
    // `publishCandidate`'s own per-row `parseJournalFrame` loop ever got a chance
    // to classify or refuse the row properly.
    const rows = [liveRow({ compatibility: { version: 5, requires: ["some-capability"] } })]

    expect(() => initialJournalVersionFloor(runtime, rows, false)).not.toThrow()
    expect(initialJournalVersionFloor(runtime, rows, false)).toBe(5)
  })

  it("contributes nothing for a row whose compatibility object names no integer version, without throwing", () => {
    const rows = [
      liveRow({ compatibility: { version: "not-a-number" } }, 0),
      liveRow({ compatibility: { version: 0 } }, 1),
      liveRow({ compatibility: null }, 2),
      liveRow({ compatibility: { requires: ["x"] } }, 3),
    ]

    expect(() => initialJournalVersionFloor(runtime, rows, false)).not.toThrow()
    expect(initialJournalVersionFloor(runtime, rows, false)).toBe(0)
  })
})
