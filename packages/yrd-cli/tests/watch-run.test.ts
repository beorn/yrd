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
import type { ChangeRecord, Row } from "@yrd/queue-core"
import { historyEntries, metadataGroups, metadataKeyWidth } from "../src/watch-change.ts"
import { explanationLine, headlineOf, runOf, runTitle, stepsOf, timingRows } from "../src/watch-run.ts"

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

  it("names the reason a failed or stuck change carries, and the position of one in line", () => {
    expect(headlineOf(row({ reason: "test", state: "failed" }))).toBe("failed test")
    expect(headlineOf(row({ position: 2, state: "queued" }))).toBe("queued #2")
  })

  it("says how a change merged, whether or not a record names the merge", () => {
    const at = new Date(NOW_MS + 2 * 3_600_000 + 15 * 60_000 + 31_000)
    expect(
      explanationLine(row({ endedAt: at, merge: "b234234abcde0123456789abcdef0123456789ab", state: "merged" })),
    ).toMatch(/^Merged as b234234abcde at \d\d:\d\d:\d\d\.$/u)
    expect(explanationLine(row({ state: "merged" }))).toContain("no merged record names the merge commit")
  })

  it("explains an open change by whose move it is, in the core's own words", () => {
    expect(explanationLine(row({ next: { because: "it starts when the queue reaches it", owner: "the queue" } }))).toBe(
      "It starts when the queue reaches it; the queue acts next.",
    )
  })

  it("puts the run's clocks and the operator's three metrics on two rows, leaving out what nobody measured", () => {
    const rows = timingRows(row({ startedAt: new Date(NOW_MS - 60_000) }), { ageMs: 3_600_000, runtimeMs: 60_000 })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/^Submitted \d\d:\d\d:\d\d, Started \d\d:\d\d:\d\d$/u)
    expect(rows[1]).toBe("Age 1h00m · Runtime 1:00")
    expect(timingRows(row({ since: undefined }), {})).toEqual([])
  })

  it("names the run on the border by its start instant and gives a pre-run row no title", () => {
    expect(runTitle({ id: "q-20260903T113000000Z-0badf00d", label: "main" })).toMatch(/^RUN main#\d{6}$/u)
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
  const record = (
    kind: ChangeRecord["kind"],
    offset: number,
    trailers: readonly (readonly [string, string])[],
  ): ChangeRecord => ({
    at: new Date(NOW_MS - 3_600_000 + offset),
    kind,
    sha: String(offset).padStart(40, "0"),
    subject: kind,
    trailers,
  })

  it("reads newest first, calls a second opening a resubmission, and keeps a sent echo only when delivery failed", () => {
    const entries = historyEntries([
      record("opened", 0, [["Submitter", "@chief"]]),
      record("checked", 1_000, [["Base", "3c285a41af46".padEnd(40, "0")]]),
      record("sent", 1_500, [
        ["Delivery", "sent"],
        ["To", "@chief"],
      ]),
      record("opened", 2_000, [["Submitter", "@chief"]]),
      record("failed", 3_000, [["Reason", "test"]]),
      record("sent", 4_000, [
        ["Delivery", "failed"],
        ["To", "@chief"],
      ]),
    ])
    expect(entries.map((entry) => entry.text)).toEqual([
      "message to @chief failed",
      "failed test",
      "resubmitted by @chief",
      "checked at 3c285a41af46",
      "submitted by @chief",
    ])
  })

  it("says a direct merge went around the queue, says nothing about the queue's own merges, and carries a failure's detail", () => {
    const entries = historyEntries([
      record("merged", 0, [
        ["Merge", "b234234abcde".padEnd(40, "0")],
        ["Merged-By", "direct"],
      ]),
      record("merged", 500, [
        ["Merge", "c345345bcdef".padEnd(40, "0")],
        ["Merged-By", "yrd queue main [q-20260903T113000000Z-0badf00d]"],
      ]),
      record("failed", 1_000, [
        ["Reason", "conflict"],
        ["Detail", "CONFLICT (content): x.ts"],
      ]),
    ])
    expect(entries).toEqual([
      expect.objectContaining({ detail: "CONFLICT (content): x.ts", text: "failed conflict" }),
      { at: expect.any(Date), text: "merged as c345345bcdef" },
      expect.objectContaining({ detail: "a direct merge, around the queue", text: "merged as b234234abcde" }),
    ])
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
    expect(groups.flat().find((fact) => fact.key === "CREATED")?.value).toMatch(/^\d\d:\d\d:\d\d · 1h00m ago$/u)
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
      state: "checked",
    })
    expect(headlineOf(live, true)).toBe("checked #1, checking affected-tests")
    expect(headlineOf(live)).toBe("checked #1, checking affected-tests")
  })
})
