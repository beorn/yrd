/**
 * The watch's pure list: filters, the per-run lens, and the one row renderer
 * both the watch and plain `yrd queue list` draw with.
 *
 * Nothing here touches a ref, a file or a process. That is the point of the
 * two modules under test: every reading was already made by the core, and
 * these decide only what is on screen.
 */

import { describe, expect, it, vi } from "vitest"
import type { Journals, Row } from "@yrd/queue-core"
import { CHANGE_STATUSES, journalKey } from "@yrd/queue-core"
import * as format from "../src/watch-format.ts"
import { noticeLine, watchNotice } from "../src/watch-notice.ts"
import { filterRows, rowLine, watchRows, watchRowKey } from "../src/watch-rows.ts"
import { journalRun } from "../../../tests/support/journal-run.ts"

const since = new Date("2026-09-03T19:00:00.000Z")
const now = new Date("2026-09-03T20:00:00.000Z")

function row(over: Partial<Row> = {}): Row {
  return { branch: "task/one", head: "a".repeat(40), since, state: "queued", ...over }
}

function journals(entries: Readonly<Record<string, readonly string[]>>): Journals {
  const runs = new Map(
    Object.entries(entries).map(([key, ids]) => [
      key,
      ids.map((id) =>
        journalRun({
          at: now,
          branch: "task/one",
          checks: [],
          head: "a".repeat(40),
          id,
          startedAt: now,
        }),
      ),
    ]),
  )
  // 24408: a journal read carries the rows it could not read; this fixture has none.
  return { dir: "/w/logs", malformed: [], runs }
}

describe("the rows a watch shows", () => {
  it("gives a change ONE row by default, however many runs touched it, because the page is about changes", () => {
    // The operator read their own queue on 2026-09-17 and saw one branch twice.
    // Two runs per change was the default wherever a run journal could be read,
    // which made the duplicate host-only by construction: from any other clone
    // there is no journal and each change already had one row.
    const rows = watchRows([row()], {
      journals: journals({ [journalKey("task/one", "a".repeat(40))]: ["q-2", "q-1"] }),
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.run).toBeUndefined()
    const first = rows[0]!
    expect(watchRowKey(first)).not.toBe(watchRowKey({ ...first, row: { ...first.row, branch: "task/other" } }))
  })

  it("preserves every run that touched a change under perRun, the lens STATS counts decisions from", () => {
    const rows = watchRows([row()], {
      perRun: true,
      journals: journals({ [journalKey("task/one", "a".repeat(40))]: ["q-2", "q-1"] }),
    })

    expect(rows.map((entry) => entry.run?.id)).toEqual(["q-2", "q-1"])
  })

  it("accepts --latest and does nothing with it: one row per change is the only lens the table has", () => {
    const options = { journals: journals({ [journalKey("task/one", "a".repeat(40))]: ["q-2", "q-1"] }) }

    expect(watchRows([row()], { ...options, latest: true })).toEqual(watchRows([row()], options))
  })

  it("gives one row per change where there is no journal to split it by, rather than none", () => {
    const rows = watchRows([row()])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.row.branch).toBe("task/one")
  })

  it("clears newer evidence absent from an old run, but keeps the current state and next owner", () => {
    const current = row({
      state: "failed",
      result: "fail later",
      reason: "later",
      log: "/later/log",
      base: "later",
      merge: "later",
      run: "later",
      startedAt: now,
      endedAt: now,
      incident: {
        code: "later",
        subject: "later",
        via: "later",
        evidence: "/later",
        next: "repair",
        owner: "operator",
      },
      live: { run: "later", check: "later", phase: "merge", since: now },
      next: { owner: "submitter", because: "fix the change" },
    })
    const options = { journals: journals({ [journalKey(current.branch, current.head)]: ["old"] }), perRun: true }
    const historical = watchRows([current], options)[0]!
    expect(historical.row).toMatchObject({ state: "failed", next: current.next, run: "old" })
    for (const key of [
      "result",
      "reason",
      "log",
      "base",
      "merge",
      "incident",
      "startedAt",
      "endedAt",
      "live",
    ] as const) {
      expect(historical.row[key], key).toBeUndefined()
    }
    expect(filterRows([historical], ["later"])).toHaveLength(0)
    expect(watchRows([current], { ...options, perRun: false })[0]?.row).toBe(current)
    expect(watchRows([current])[0]?.row).toBe(current)
  })
})

describe("the filter terms", () => {
  const rows = watchRows([
    row({ branch: "task/one", subject: "fix the parser" }),
    row({ branch: "task/two", head: "b".repeat(40), reason: "conflict", state: "failed", subject: "add a check" }),
    row({ branch: "task/three", head: "c".repeat(40), run: "q-20260903T1-abc", state: "merged" }),
  ])

  it("matches a branch, case-insensitively", () => {
    expect(filterRows(rows, ["TASK/TWO"]).map((entry) => entry.row.branch)).toEqual(["task/two"])
  })

  it("matches the change's own subject, which is why the core reads it at all", () => {
    expect(filterRows(rows, ["parser"]).map((entry) => entry.row.branch)).toEqual(["task/one"])
  })

  it("matches the queue run", () => {
    expect(filterRows(rows, ["q-20260903T1"]).map((entry) => entry.row.branch)).toEqual(["task/three"])
  })

  it("matches the failure", () => {
    expect(filterRows(rows, ["conflict"]).map((entry) => entry.row.branch)).toEqual(["task/two"])
  })

  it("is an OR across terms, not an AND", () => {
    expect(filterRows(rows, ["parser", "conflict"]).map((entry) => entry.row.branch)).toEqual(["task/one", "task/two"])
  })

  it("matches the change's STATE, the field the payload itself emits", () => {
    expect(filterRows(rows, ["merged"]).map((entry) => entry.row.branch)).toEqual(["task/three"])
  })

  it("a state name selects by state, not only the row whose BRANCH happens to say so", () => {
    // The live specimen: `merged` returned exactly ONE row, matched on branch
    // text, while several hundred rows whose own state field read merged were
    // excluded. An empty result invites suspicion; one plausible row invites
    // belief (a-state-name-filters-to-zero-rows-and-exit-zero).
    const withTwin = watchRows([
      row({ branch: "task/three", head: "c".repeat(40), state: "merged" }),
      row({ branch: "task/merged-ball-conditional-close", head: "d".repeat(40), state: "queued" }),
    ])
    const matched = filterRows(withTwin, ["merged"]).map((entry) => entry.row.branch)
    expect(matched).toContain("task/three")
    expect(matched).toContain("task/merged-ball-conditional-close")
  })

  it("selects every event status by the same word in JSON and in the table", () => {
    const eventRows = watchRows(
      CHANGE_STATUSES.map((state, index) =>
        row({ branch: `work/${String(index)}`, format: "event", head: String(index).repeat(40), state }),
      ),
    )
    const jsonWords = eventRows.map((entry) => entry.row.state)
    const tableWords = eventRows.map((entry) => format.stateWord(entry.row))

    expect(tableWords).toEqual(jsonWords)
    expect(filterRows(eventRows, jsonWords)).toEqual(eventRows)
    expect(filterRows(eventRows, tableWords)).toEqual(eventRows)
  })

  it("with no terms is no filter, never no rows", () => {
    expect(filterRows(rows, [])).toHaveLength(3)
    expect(filterRows(rows, ["  "])).toHaveLength(3)
  })
})

describe("the one row renderer", () => {
  it("draws the plain list's line unchanged when there is no subject, run or live check to add", () => {
    const current = row({ head: "abcdef0123456789", issue: "@i/1", position: 1, result: "pass" })
    // The state in the one word table's word (24196), in a column as wide as the longest.
    expect(rowLine({ row: current })).toBe(" 1 submitted task/one abcdef012345 pass @i/1")
    // Joined and record-only rows share fixed columns; only the run suffix differs.
    expect(
      rowLine({
        row: current,
        run: journalRun({ id: "q-1", branch: current.branch, head: current.head, startedAt: now, at: now, checks: [] }),
      }),
    ).toBe(" 1 submitted task/one abcdef012345 pass @i/1 [q-1]")
  })

  it("adds the subject, the run and the check running now when there is something to put there", () => {
    const line = rowLine({
      row: row({
        head: "abcdef0123456789",
        live: { check: "test", phase: "merge", run: "q-1", since: now },
        subject: "fix the parser",
      }),
    })

    expect(line).toContain("fix the parser")
    expect(line).toContain("[q-1]")
    expect(line).toContain("(test running)")
  })
})

describe("the notice", () => {
  it("owns the state, the cause and whose move it is, in one line", () => {
    const line = noticeLine(
      row({
        next: { because: "it failed (test), and only the author can move it", owner: "@dev/2" },
        reason: "test",
        state: "failed",
      }),
    )

    expect(line).toContain("failed")
    expect(line).toContain("test")
    expect(line).toContain("next: @dev/2")
  })

  it("says a change is queued AND that a check is running on it, because both are true", () => {
    // The records say queued until the checked record merges; the journal says a
    // check is running now. The notice carries both rather than picking one and
    // inventing a sixth state for the difference.
    const notice = watchNotice(
      row({ live: { check: "typecheck", phase: "merge", run: "q-1", since: now }, position: 1 }),
    )

    expect(notice.word).toBe("submitted #1, checking typecheck")
  })

  it("carries the queue position in the notice, where a live fact belongs", () => {
    expect(watchNotice(row({ position: 3 })).word).toBe("submitted #3")
    const historical = row({ state: "failed", position: 1, result: "stuck verify", run: "q-1" })
    expect(watchNotice(historical, true)).toMatchObject({ word: "change failed #1", cause: "run result: stuck verify" })
    // The join is a caller's fact, not inferred from a result or run identifier.
    expect(watchNotice(historical).word).toBe("failed #1")
  })

  /**
   * @failure  The notice kept a state-to-word map of its own beside the one table's (@i/10-yrd/24196, review
   *           finding 1): the two agreed only because each was typed out, so a change to which word a state
   *           reads would reach the table and leave the notice saying the old one.
   */
  it("reads every state's word from the one word table, so it cannot drift from the table; direct apart", () => {
    // Every state a row can have, each its own value: a state the core adds fails to compile here until listed.
    const states = Object.values({
      cancelled: "cancelled",
      checked: "checked",
      checking: "checking",
      deferred: "deferred",
      direct: "direct",
      draft: "draft",
      failed: "failed",
      merged: "merged",
      merging: "merging",
      queued: "queued",
      stuck: "stuck",
      verifying: "verifying",
      withdrawn: "withdrawn",
    } as const satisfies { readonly [S in Row["state"]]: S })
    // The table answers with a word no second map could hold, so a notice reading a map of its own cannot match.
    const table = vi.spyOn(format, "stateWord").mockImplementation(({ state }) => `the table's word for ${state}`)
    try {
      expect(Object.fromEntries(states.map((state) => [state, watchNotice(row({ state })).word]))).toEqual(
        Object.fromEntries(
          states.map((state) => [
            state,
            state === "direct" ? "went around the queue" : `the table's word for ${state}`,
          ]),
        ),
      )
    } finally {
      table.mockRestore()
    }
  })
})

describe("the timing line", () => {
  it("reads the row's one duration as its table cell does, then the attempt's runtime under its own name (24196)", () => {
    const line = format.timingLine(
      row({
        endedAt: new Date("2026-09-03T19:45:00.000Z"),
        startedAt: new Date("2026-09-03T19:30:00.000Z"),
        state: "merged",
      }),
      now,
    )

    // Took stops at the ending record (19:45 − 19:00 = 45m), and so does the
    // attempt's runtime, rather than counting on to `now` (20:00).
    expect(line).toBe("took 45:00 · runtime 15:00")
  })

  it("leaves out a clock nothing measured rather than printing it as zero", () => {
    expect(format.timingLine(row(), now)).toBe("waiting 1h00m")
  })
})
