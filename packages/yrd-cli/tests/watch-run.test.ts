/**
 * @failure  The status box read `passed, change merged` for the operator's own
 *           `passed, merged` sample, said nothing about a change merged with
 *           no record naming the merge, and HISTORY called a retry a second
 *           `submitted`. All three are projections over facts the core already
 *           derived; none may decide a state (watch-redesign items 1, 31, 39).
 * @level    l1 (pure functions)
 * @consumer the operator reading the detail's status box and Changes tab
 */

import { describe, expect, it } from "vitest"
import type { Row } from "@yrd/queue-core"
import { metadataGroups, metadataKeyWidth, timelineOf } from "../src/watch-change.ts"
import { explanationLine, headlineOf, runOf, runTitle, statusLineOf, stepsOf, timingRows } from "../src/watch-run.ts"

const NOW_MS = Date.UTC(2026, 8, 3, 12, 0, 0)

function row(over: Partial<Row> = {}): Row {
  return {
    branch: "task/one",
    head: "abcdef0123456789abcdef0123456789abcdef01",
    since: new Date(NOW_MS - 3_600_000),
    state: "queued",
    subject: "fix the parser",
    ...over,
  }
}

describe("the status box's own lines", () => {
  it("reads `passed, merged` for a merged change whose run passed, joined or not (item 1)", () => {
    const merged = row({ result: "pass test", state: "merged" })
    expect(headlineOf(merged)).toBe("passed, merged")
    expect(headlineOf(merged, true)).toBe("passed, merged")
  })

  it("keeps the change's word beside a historical run's own result when they disagree", () => {
    expect(headlineOf(row({ result: "stuck verify", state: "merged" }), true)).toBe(
      "change merged, run result: stuck verify",
    )
  })

  // 24735, @cto a04a006b: the skew belongs IN the status string the box draws,
  // so a clean merged row and a skewed one can never print the same status.
  it("keeps a row's reader skew inside the status string, never beside it", () => {
    const clean = row({ result: "pass test", state: "merged" })
    const skewed = { ...clean, unknownKinds: ["a-kind-from-a-newer-writer"] }
    expect(statusLineOf(clean).status).toBe("Merged")
    expect(statusLineOf(skewed).status).toBe("Merged · reader skew")
    expect(statusLineOf(clean).status).not.toBe(statusLineOf(skewed).status)
  })

  // @dev/4 R3: the merged branch returned its merge explanation before reading
  // the row's next, so a merged row wore the skew and never the cure behind it.
  it("carries a merged row's reader cure into the box's explanation, not only into its status", () => {
    const merged = row({ state: "merged" })
    const skewed = {
      ...merged,
      next: {
        because:
          "journal q-newer carries record kind a-kind-from-a-newer-writer this watch does not know; restart the watch from the landing root",
        owner: "the watch's own build",
      },
      unknownKinds: ["a-kind-from-a-newer-writer"],
    }
    const box = statusLineOf(skewed)
    expect(box.status).toBe("Merged · reader skew")
    expect(box.explanation).toContain("q-newer")
    expect(box.explanation).toContain("restart the watch from the landing root")
    expect(statusLineOf(merged).explanation ?? "").not.toContain("reader skew")
  })

  // @dev/4 R4: the marker has ONE home — stateWord, read through watchNotice by
  // headlineOf — so appending it again in the box printed it twice. Their
  // production proof read `Failed · reader skew · reader skew`.
  it("prints exactly one reader-skew marker in the box, a failed row and a direct one alike", () => {
    const markers = (text: string | undefined): number => (text?.split("reader skew").length ?? 1) - 1
    const failed = row({ state: "failed", unknownKinds: ["future-kind"] })
    expect(statusLineOf(failed).status).toBe("Failed · reader skew")
    expect(markers(statusLineOf(failed).status)).toBe(1)
    const direct = row({ state: "direct", unknownKinds: ["future-kind"] })
    expect(statusLineOf(direct).status).toBe("Went around the queue · reader skew")
    expect(markers(statusLineOf(direct).status)).toBe(1)
  })

  // @dev/4 R4: the note was gated on the status marker, so a merged row whose
  // NEWEST run read clean lost the older run's partial history (@cto 25d6aa5f)
  // in both merge forms. The note hangs off `next`, never off the marker.
  it("shows an older run's partial-history note in a clean merged box, both merge forms", () => {
    const note = {
      because: "older run q-old carries kind future-kind this watch does not know; folded counts may be partial",
      owner: "the watch's own build",
    }
    const ancestryOnly = statusLineOf(row({ next: note, state: "merged" }))
    expect(ancestryOnly.status).toBe("Merged")
    expect(ancestryOnly.explanation).toContain("older run q-old")
    expect(ancestryOnly.explanation).toContain("folded counts may be partial")
    const recorded = statusLineOf(row({ merge: "2f5d9fbe7653abcd", next: note, state: "merged" }))
    expect(recorded.status).toBe("Merged")
    expect(recorded.explanation).toContain("older run q-old")
    expect(recorded.explanation).toContain("2f5d9fbe7653")
  })

  it("names the reason a failed or stuck change carries, and the position of one in line", () => {
    expect(headlineOf(row({ reason: "test", state: "failed" }))).toBe("failed test")
    expect(headlineOf(row({ position: 2, state: "queued" }))).toBe("queued #2")
  })

  it("says how a change merged, whether or not a record names the merge", () => {
    const at = new Date(NOW_MS + 2 * 3_600_000 + 15 * 60_000 + 31_000)
    expect(
      explanationLine(row({ endedAt: at, merge: "b234234abcde0123456789abcdef0123456789ab", state: "merged" })),
    ).toMatch(/^Merged as b234234abcde at \d\d:\d\d\.$/u)
    expect(explanationLine(row({ state: "merged" }))).toContain("no merged record names the merge commit")
  })

  it("explains an open change by whose move it is, in the core's own words", () => {
    expect(explanationLine(row({ next: { because: "it starts when the queue reaches it", owner: "the queue" } }))).toBe(
      "It starts when the queue reaches it; the queue acts next.",
    )
  })

  it("puts the run's clocks and the one timing line on two rows, leaving out what nobody measured", () => {
    const started = new Date(NOW_MS - 60_000)
    const held = row({ live: { check: "test", phase: "merge", run: "q-1", since: started }, startedAt: started })
    const rows = timingRows(held, new Date(NOW_MS))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/^Submitted \d\d:\d\d, Started \d\d:\d\d$/u)
    expect(rows[1]).toBe("checking 1:00 · runtime 1:00")
    expect(timingRows(row({ since: undefined }), new Date(NOW_MS))).toEqual([])
  })

  it("names a published run by number, an unnumbered one by opaque id, and a pre-run row by no title", () => {
    const id = "q-20260903T113000000Z-0badf00d"
    expect(runTitle({ id, label: "main", number: 7 })).toBe("RUN main#7")
    expect(runTitle({ id, label: "main" })).toBe(`RUN main [${id}]`)
    expect(runTitle({ label: "main" })).toBeUndefined()
  })

  it("is a lens: the run holds the row itself and the checks as steps, and puts the remedy on the failed one", () => {
    const failed = row({ next: { because: "it failed (test)", owner: "@chief" }, state: "failed" })
    const run = runOf(
      failed,
      "main",
      [
        { name: "typecheck", result: { ms: 62_000, result: "pass" }, state: "passed" },
        { log: "/w/test.log", name: "test", result: { ms: 4_000, result: "fail" }, state: "failed" },
        { name: "lint", state: "not-run" },
      ],
      "q-20260903T113000000Z-0badf00d",
    )
    expect(run.kind).toBe("queue")
    expect(run.row).toBe(failed)
    expect(run.steps).toEqual([
      { ms: 62_000, name: "typecheck", state: "passed" },
      { log: "/w/test.log", ms: 4_000, name: "test", remedy: "@chief — it failed (test)", state: "failed" },
      { name: "lint", state: "not-run" },
    ])
    expect(stepsOf([], failed)).toEqual([])
  })
})

describe("HISTORY and METADATA (watch-change)", () => {
  /** Event history already arrives newest first; the timeline keeps only the selected cut. */
  it("draws the latest event cut with measured gaps and a drafted lead", () => {
    const start = NOW_MS - 3_600_000
    const history = [
      { at: new Date(start + 92_000), text: "merged by yrd" },
      { at: new Date(start + 62_000), text: "checking by yrd" },
      { at: new Date(start + 2_000), text: "opened by @chief", opens: true as const },
      { at: new Date(start), text: "opened by @chief", opens: true as const },
    ]
    const timeline = timelineOf(history, new Date(start - 60_000))

    expect({ cut: timeline.cut, cuts: timeline.cuts }).toEqual({ cut: 2, cuts: 2 })
    expect(timeline.entries.map((entry) => [entry.text, entry.toNextMs])).toEqual([
      ["drafted", 62_000],
      ["opened by @chief", 60_000],
      ["checking by yrd", 30_000],
      ["merged by yrd", undefined],
    ])
  })

  it("leaves an empty event timeline unmeasured", () => {
    expect(timelineOf([], undefined)).toEqual({ cut: 1, cuts: 1, entries: [] })
  })

  it("lays the metadata out in three groups with the live facts absent", () => {
    const groups = metadataGroups(
      row({
        at: new Date(NOW_MS),
        base: "3c285a41af46".padEnd(40, "0"),
        issue: "@i/10-yrd/24096",
        position: 1,
        submitter: "@chief",
      }),
      new Date(NOW_MS),
      { commits: { count: 2 }, runId: "q-20260903T113000000Z-0badf00d" },
    )
    expect(groups.map((group) => group.map((fact) => fact.key))).toEqual([
      ["ISSUE", "BY"],
      ["CREATED", "UPDATED", "COMMITS"],
      ["HEAD", "BASE", "RUN"],
    ])
    expect(groups.flat().find((fact) => fact.key === "COMMITS")?.value).toBe("2 commits")
    expect(groups.flat().find((fact) => fact.key === "CREATED")?.value).toMatch(/^\d\d:\d\d · 1h00m ago$/u)
    expect(metadataKeyWidth(groups)).toBe("COMMITS".length + 2)
  })

  it("drops a group with nothing in it rather than rendering a blank", () => {
    const groups = metadataGroups(row({ since: undefined }), new Date(NOW_MS))
    expect(groups).toEqual([[{ key: "HEAD", value: "abcdef012345" }]])
  })
})

describe("a check running now", () => {
  it("drops the joined-run qualifier from the headline: the present is not a historical reading", () => {
    const live = row({
      live: { check: "affected-tests", phase: "merge", run: "q-x", since: new Date(NOW_MS) },
      position: 1,
      state: "verifying",
    })
    expect(headlineOf(live, true)).toBe("verifying #1, checking affected-tests")
    expect(headlineOf(live)).toBe("verifying #1, checking affected-tests")
  })
})
