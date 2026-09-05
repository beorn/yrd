/**
 * The watch's pure list: filters, the `--latest` lens, and the one row
 * renderer both the watch and plain `yrd queue list` draw with.
 *
 * Nothing here touches a ref, a file or a process. That is the point of the
 * two modules under test: every reading was already made by the core, and
 * these decide only what is on screen.
 */

import { describe, expect, it } from "vitest"
import type { Journals, Row } from "@yrd/queue-core"
import { journalKey } from "@yrd/queue-core"
import { clocksLine, noticeLine, watchNotice } from "../src/watch-notice.ts"
import { filterRows, rowLine, rowTable, watchRows } from "../src/watch-rows.ts"

const since = new Date("2026-09-03T19:00:00.000Z")
const now = new Date("2026-09-03T20:00:00.000Z")

function row(over: Partial<Row> = {}): Row {
  return { branch: "task/one", head: "a".repeat(40), since, state: "queued", ...over }
}

function journals(entries: Readonly<Record<string, readonly string[]>>): Journals {
  const runs = new Map(
    Object.entries(entries).map(([key, ids]) => [
      key,
      ids.map((id) => ({
        at: now,
        branch: "task/one",
        checks: [],
        head: "a".repeat(40),
        id,
        startedAt: now,
      })),
    ]),
  )
  return { dir: "/w/logs", runs }
}

describe("the rows a watch shows", () => {
  it("preserves every run that touched a change by default, which is what a reader asking what the queue DID wants", () => {
    const rows = watchRows([row()], {
      journals: journals({ [journalKey("task/one", "a".repeat(40))]: ["q-2", "q-1"] }),
    })

    expect(rows.map((entry) => entry.run?.id)).toEqual(["q-2", "q-1"])
  })

  it("collapses to one row per change under --latest, the opt-in lens", () => {
    const rows = watchRows([row()], {
      latest: true,
      journals: journals({ [journalKey("task/one", "a".repeat(40))]: ["q-2", "q-1"] }),
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.run).toBeUndefined()
  })

  it("gives one row per change where there is no journal to split it by, rather than none", () => {
    const rows = watchRows([row()])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.row.branch).toBe("task/one")
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

  it("with no terms is no filter, never no rows", () => {
    expect(filterRows(rows, [])).toHaveLength(3)
    expect(filterRows(rows, ["  "])).toHaveLength(3)
  })
})

describe("the one row renderer", () => {
  it("draws the plain list's line unchanged when there is no subject, run or live check to add", () => {
    expect(rowLine({ row: row({ head: "abcdef0123456789", issue: "@i/1", position: 1, result: "pass" }) })).toBe(
      " 1 queued  task/one abcdef012345 pass @i/1",
    )
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

  it("says there is nothing in line rather than printing an empty table", () => {
    expect(rowTable([])).toBe("nothing in line")
  })
})

describe("the notice", () => {
  it("keeps ordinary ownership and renders incident advice without inventing an owner", () => {
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

    const advice = "repair the queue environment, then run yrd queue run"
    const code = "yrd-historical-unknown"
    const subject = "the queue could not judge task/one after its captured configuration disappeared"
    const advised = row({
      incident: { code, subject, next: advice },
      reason: code,
      state: "stuck",
    })
    const advisedNotice = watchNotice(advised)
    expect(advisedNotice.next).toBe(advice)
    if (advisedNotice.cause === undefined) throw new Error("the incident notice omitted its cause")
    expect(advisedNotice.cause).toContain(subject)
    expect(advisedNotice.cause).toContain(code)
    expect(advisedNotice.cause.indexOf(subject)).toBeLessThan(advisedNotice.cause.indexOf(code))
    expect(noticeLine(advised)).toContain(`next: ${advice}`)
    expect(noticeLine(advised)).not.toContain("owner")

    const withoutAdvice = row({
      incident: { code, subject },
      next: { because: "this generic fallback must be ignored", owner: "wrong owner" },
      reason: code,
      state: "stuck",
    })
    expect(watchNotice(withoutAdvice).next).toBeUndefined()
    expect(noticeLine(withoutAdvice)).not.toContain("next:")
    expect(noticeLine(withoutAdvice)).not.toContain("wrong owner")
  })

  it("says a change is queued AND that a check is running on it, because both are true", () => {
    // The records say queued until the checked record lands; the journal says a
    // check is running now. The notice carries both rather than picking one and
    // inventing a sixth state for the difference.
    const notice = watchNotice(
      row({ live: { check: "typecheck", phase: "merge", run: "q-1", since: now }, position: 1 }),
    )

    expect(notice.word).toBe("queued #1, checking typecheck")
  })

  it("carries the queue position in the notice, where a live fact belongs", () => {
    expect(watchNotice(row({ position: 3 })).word).toBe("queued #3")
  })
})

describe("the clocks line", () => {
  it("reads Age, Runtime and Wait in the operator's own order", () => {
    const line = clocksLine(
      row({
        endedAt: new Date("2026-09-03T19:45:00.000Z"),
        startedAt: new Date("2026-09-03T19:30:00.000Z"),
        state: "merged",
      }),
      now,
    )

    expect(line).toBe("Age 1h · Runtime 15m · Wait 30m")
  })

  it("leaves out a clock nothing measured rather than printing it as zero", () => {
    expect(clocksLine(row(), now)).toBe("Age 1h")
  })
})
