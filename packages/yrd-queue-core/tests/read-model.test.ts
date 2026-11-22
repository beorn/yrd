/**
 * @failure A journal-only field is published as if the change ref had said it, or a
 *           local execution collection is handed to a reader without a marker to narrow on.
 * @level    l1 — the real projection, collection and `Local` construction
 * @consumer Yrd locality marking (#28522, #24340; @cto disposition 6e5624aa)
 * @testonly none
 *
 * ROW 1  `publishedChange` carries the published side only: every journal-only field
 *        (result, log, incident, diagnostics, malformed, unknownKinds, live, base) is gone,
 *        and two mixed fields keep the published answer.
 * ROW 2  The compiler refuses to read a journal-only field off a `PublishedChange`.
 * ROW 3  `executionOf` flattens every run and keeps the keyed defects beside them.
 * ROW 4  `executionAnswer` returns an answered collection for readable and partly-defective
 *        sources, and a `local:false` sentence for absent and unreadable ones.
 */
import { describe, expect, it } from "vitest"
import { executionAnswer, executionOf, publishedChange } from "../src/index.ts"
import type { JournalSummary, Journals } from "../src/log.ts"
import type { Row } from "../src/table.ts"

const row: Row = {
  format: "event",
  branch: "task/1",
  head: "a".repeat(40),
  state: "merged",
  position: 3,
  issue: "@i/10-yrd/1",
  submitter: "@dev/1",
  reason: "pass",
  since: new Date("2026-11-22T10:00:00Z"),
  at: new Date("2026-11-22T11:00:00Z"),
  merge: "b".repeat(40),
  subject: "a change",
  run: "q-1",
  startedAt: new Date("2026-11-22T10:30:00Z"),
  endedAt: new Date("2026-11-22T11:00:00Z"),
  result: "pass test",
  log: "/tmp/test.log",
  incident: { code: "x", subject: "y" },
  diagnostics: [],
  malformed: ["unreadable row"],
  unknownKinds: ["future-kind"],
  live: { run: "q-1", check: "test", phase: "test", since: new Date("2026-11-22T10:31:00Z") },
  base: "c".repeat(40),
}

describe("publishedChange", () => {
  it("drops every journal-only field and keeps the published answer", () => {
    const published = publishedChange(row)
    const keys = Object.keys(published)
    for (const field of ["result", "log", "incident", "diagnostics", "malformed", "unknownKinds", "live", "base"]) {
      expect(keys, field).not.toContain(field)
    }
    expect(published).toMatchObject({
      branch: "task/1",
      state: "merged",
      position: 3,
      issue: "@i/10-yrd/1",
      reason: "pass",
      merge: "b".repeat(40),
      run: "q-1",
    })
  })

  it("is not a Row: a journal-only field cannot be read off it", () => {
    const published = publishedChange(row)
    // @ts-expect-error `result` is journal-only and is carried by `execution`, not by a published change
    void published.result
  })
})

const journals: Journals<JournalSummary> = {
  dir: "/queue/logs",
  malformed: [{ run: "q-2", key: "task/2@" + "d".repeat(40), message: "unreadable row" }],
  runs: new Map([
    [
      "task/1@" + "a".repeat(40),
      [
        {
          id: "q-1",
          startedAt: new Date("2026-11-22T10:30:00Z"),
          branch: "task/1",
          head: "a".repeat(40),
          checks: [],
          at: new Date("2026-11-22T11:00:00Z"),
        },
      ],
    ],
    [
      "task/2@" + "d".repeat(40),
      [
        {
          id: "q-2",
          startedAt: new Date("2026-11-22T10:40:00Z"),
          branch: "task/2",
          head: "d".repeat(40),
          checks: [],
          at: new Date("2026-11-22T10:50:00Z"),
        },
      ],
    ],
  ]),
}

/** Two attempts at ONE branch@head, newest first, as the journal map holds them. */
const attempts: Journals<JournalSummary> = {
  dir: "/queue/logs",
  malformed: [],
  runs: new Map([
    [
      "task/1@" + "a".repeat(40),
      [
        {
          id: "q-later",
          startedAt: new Date("2026-11-22T10:40:00Z"),
          branch: "task/1",
          head: "a".repeat(40),
          checks: [],
          at: new Date("2026-11-22T10:50:00Z"),
          merge: "b".repeat(40),
        },
        {
          id: "q-earlier",
          startedAt: new Date("2026-11-22T10:30:00Z"),
          branch: "task/1",
          head: "a".repeat(40),
          checks: [],
          at: new Date("2026-11-22T10:35:00Z"),
        },
      ],
    ],
  ]),
}

describe("two attempts at one head (28522)", () => {
  it("keeps both runs, each identified by its own id and the same branch@head", () => {
    const execution = executionOf(attempts)
    // group-by-branch+head identifies the CANDIDATES only; each attempt keeps its own id,
    // in the journal's own newest-first order, with no index given a meaning.
    expect(execution.runs.map((run) => run.id)).toEqual(["q-later", "q-earlier"])
    expect(execution.runs.map((run) => `${run.branch}@${run.head}`)).toEqual([
      `task/1@${"a".repeat(40)}`,
      `task/1@${"a".repeat(40)}`,
    ])
  })

  it("publishes the row's own ending, never a run's", () => {
    // The published failure is the first attempt's ending and says so itself: no
    // run list is folded into it, so a later attempt's merge cannot ride along.
    const published = publishedChange({
      format: "event",
      branch: "task/1",
      head: "a".repeat(40),
      state: "failed",
      run: "q-earlier",
      reason: "check failed",
    } as Row)
    expect(published.run).toBe("q-earlier")
    expect(published.merge).toBeUndefined()
    expect("result" in published).toBe(false)
  })
})

describe("executionOf / executionAnswer", () => {
  it("flattens every run and keeps the keyed defects", () => {
    const execution = executionOf(journals)
    expect(execution.dir).toBe("/queue/logs")
    expect(execution.runs.map((run) => run.id)).toEqual(["q-1", "q-2"])
    expect(execution.runs.map((run) => `${run.branch}@${run.head}`)).toEqual([
      `task/1@${"a".repeat(40)}`,
      `task/2@${"d".repeat(40)}`,
    ])
    expect(execution.malformed).toHaveLength(1)
  })

  it("answers a readable source, including an empty one", () => {
    const readable = executionAnswer({ kind: "readable", value: journals }, journals.dir)
    expect(readable).toEqual({ local: true, value: executionOf(journals) })
    const empty: Journals = { dir: journals.dir, malformed: [], runs: new Map() }
    expect(executionAnswer({ kind: "readable", value: empty }, empty.dir)).toEqual({
      local: true,
      value: { dir: empty.dir, runs: [], malformed: [] },
    })
  })

  it("keeps the valid runs of a partly-defective source", () => {
    const answer = executionAnswer({ kind: "malformed-partial", value: journals, why: "one row" }, journals.dir)
    expect(answer.local).toBe(true)
    if (answer.local) expect(answer.value.malformed).toHaveLength(1)
  })

  it("names the source it could not read", () => {
    expect(executionAnswer({ kind: "absent" }, "/queue/logs")).toEqual({
      local: false,
      why: "run journal not found at /queue/logs",
    })
    expect(executionAnswer({ kind: "unreadable", why: "EACCES /queue/logs" }, "/queue/logs")).toEqual({
      local: false,
      why: "EACCES /queue/logs",
    })
  })
})
