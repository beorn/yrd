/**
 * The readings the watch is built on, and every one of them is a reading:
 * the run journal read back, the clocks, the declared checks joined to what
 * ran, who acts next, and the head subjects in one batched call.
 *
 * Each test here exists because the field it covers has no honest default. A
 * reader that answered `0s` for a runtime nobody measured, or an empty string
 * for a subject it could not fetch, would be stating a measurement that was
 * never taken — so the assertions below are as much about what is ABSENT as
 * about what is there.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  checksOf,
  clocks,
  gitIn,
  journalKey,
  nextOwner,
  readJournals,
  runStartedAt,
  subjects,
  watchRows,
} from "../src/index.ts"
import type { CheckSpec, Git, Row } from "../src/index.ts"
// `openLog` is the writer, and index.ts lists only what a consumer outside the
// package imports. A test that writes a journal is inside it.
import { openLog } from "../src/log.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `yrd-${name}-`))
  roots.push(root)
  return root
}

/** A journal directory with one run's records written the way `openLog` writes them. */
function journalDir(
  records: readonly Readonly<Record<string, unknown>>[],
  at = new Date(),
): Readonly<{ dir: string; run: string }> {
  const dir = join(scratch("journal"), "logs")
  const log = openLog(dir, () => at)
  for (const record of records) log.write(record as never)
  return { dir, run: log.id }
}

describe("a run's journal, read back", () => {
  it("names the check running now: a start row this run never ended", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const { dir, run } = journalDir(
      [
        { base: "aaa", checks: ["typecheck", "test"], kind: "run", queue: "q", target: "main" },
        {
          branch: "task/one",
          head: "abc123",
          kind: "check",
          log: "/w/checks/typecheck.log",
          name: "typecheck",
          phase: "merge",
          start: "2026-09-03T19:58:00.000Z",
        },
        {
          branch: "task/one",
          end: "2026-09-03T19:59:00.000Z",
          head: "abc123",
          kind: "check",
          log: "/w/checks/typecheck.log",
          ms: 60_000,
          name: "typecheck",
          phase: "merge",
          start: "2026-09-03T19:58:00.000Z",
        },
        {
          branch: "task/one",
          head: "abc123",
          kind: "check",
          log: "/w/checks/test.log",
          name: "test",
          phase: "merge",
          start: "2026-09-03T19:59:00.000Z",
        },
      ],
      at,
    )

    const journals = readJournals(dir, { now: at })
    expect(journals.absent).toBeUndefined()
    const runs = journals.runs.get(journalKey("task/one", "abc123"))
    expect(runs).toHaveLength(1)
    expect(runs?.[0]?.id).toBe(run)
    // `end` is the one field only an ending can write, so the unended start
    // row IS the check running now — the whole hook the "running" overlay
    // hangs on (log.ts's own contract).
    expect(runs?.[0]?.running?.name).toBe("test")
    expect(runs?.[0]?.running?.log).toBe("/w/checks/test.log")
    // The ended one is settled in place, not appended twice.
    expect(runs?.[0]?.checks).toHaveLength(2)
    expect(runs?.[0]?.checks[0]?.endedAt?.toISOString()).toBe("2026-09-03T19:59:00.000Z")
    expect(runs?.[0]?.checks[0]?.ms).toBe(60_000)
    expect(runs?.[0]?.base).toBe("aaa")
    expect(runs?.[0]?.checks[0]?.result).toBeUndefined()
    expect(checksOf([], "open", [], runs?.[0]?.running, runs?.[0]?.checks).map((check) => check.state)).toEqual([
      "unmeasured",
      "running",
    ])
  })

  it("says nothing is running once the run reached a decision, whatever start row it left open", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const { dir } = journalDir(
      [
        {
          branch: "task/one",
          head: "abc123",
          kind: "check",
          log: "/w/checks/test.log",
          name: "test",
          phase: "merge",
          start: "2026-09-03T19:59:00.000Z",
        },
        { branch: "task/one", decision: "failed", head: "abc123", kind: "change", reason: "test" },
      ],
      at,
    )

    const runs = readJournals(dir, { now: at }).runs.get(journalKey("task/one", "abc123"))
    expect(runs?.[0]?.decision).toBe("failed")
    expect(runs?.[0]?.running).toBeUndefined()
    const views = checksOf([], "failed", [], runs?.[0]?.running, runs?.[0]?.checks)
    expect(views[0]?.state).toBe("unmeasured")
    expect(views[0]?.result).toBeUndefined()
  })

  it("an abandoned older run is unmeasured after a newer run, while the newest unended run stays live", () => {
    // A single decided-run fixture misses a process that died before writing
    // its decision. Serialization makes a subsequent run proof it is no longer live.
    const start = new Date("2026-09-03T19:00:00.000Z")
    const later = new Date("2026-09-03T20:00:00.000Z")
    const check = {
      branch: "task/one",
      head: "abc123",
      kind: "check" as const,
      name: "test",
      phase: "merge",
      log: "/w/old/test.log",
      start: start.toISOString(),
    }
    const { dir, run: oldId } = journalDir([check], start)
    const current: Row = { branch: check.branch, head: check.head, state: "failed" }
    const newestUnended = watchRows([current], { journals: readJournals(dir, { now: later }) })[0]!
    expect(newestUnended.row.live?.run).toBe(oldId)
    const log = openLog(dir, () => later)
    log.write({ ...check, log: "/w/new/test.log", start: later.toISOString() })
    log.write({ ...check, kind: "result", result: "fail", exit: "1" })
    log.write({ branch: check.branch, head: check.head, kind: "change", decision: "failed", reason: "test" })
    const rows = watchRows([current], { journals: readJournals(dir, { now: later }) })
    expect(rows.map(({ row }) => row.run)).toEqual([log.id, oldId])
    const old = rows[1]!
    expect(old.row.live).toBeUndefined()
    const views = checksOf(
      [],
      "failed",
      [],
      old.row.live === undefined
        ? undefined
        : {
            name: old.row.live.check,
            log: old.row.live.log,
          },
      old.run?.checks,
    )
    expect(views[0]?.state).toBe("unmeasured")
    expect(rows[0]?.row).toMatchObject({ result: "fail test", run: log.id, log: "/w/new/test.log" })
  })

  it("says where it looked when there is no journal there at all, and never returns an empty answer silently", () => {
    const dir = join(scratch("nowhere"), "logs")

    const journals = readJournals(dir)

    expect(journals.dir).toBe(dir)
    expect(journals.absent).toContain(dir)
    expect(journals.absent).toContain("there is no such directory")
    expect(journals.runs.size).toBe(0)
  })

  it("says the journals it holds are all older than the window rather than reading none in silence", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const { dir } = journalDir([{ branch: "task/one", decision: "merged", head: "abc", kind: "change" }], at)

    const journals = readJournals(dir, { now: new Date("2026-10-03T20:00:00.000Z") })

    expect(journals.absent).toContain("older than the window")
    expect(journals.runs.size).toBe(0)
  })

  it("reads a run's start instant out of its own id, so a month of journals costs one readdir", () => {
    expect(runStartedAt("q-20260903T200000000Z-deadbeef")?.toISOString()).toBe("2026-09-03T20:00:00.000Z")
    expect(runStartedAt("not-one-of-ours.jsonl")).toBeUndefined()
  })
})

describe("the clocks", () => {
  const since = new Date("2026-09-03T19:00:00.000Z")
  const started = new Date("2026-09-03T19:30:00.000Z")
  const now = new Date("2026-09-03T20:00:00.000Z")

  it("reads age, wait and runtime from one place, so no two views can disagree", () => {
    const row: Row = {
      branch: "task/one",
      endedAt: new Date("2026-09-03T19:45:00.000Z"),
      head: "abc",
      since,
      startedAt: started,
      state: "merged",
    }

    expect(clocks(row, now)).toEqual({ ageMs: 60 * 60 * 1000, runtimeMs: 15 * 60 * 1000, waitMs: 30 * 60 * 1000 })
  })

  it("keeps counting the runtime of a change that has not ended", () => {
    const row: Row = { branch: "task/one", head: "abc", since, startedAt: started, state: "checked" }

    expect(clocks(row, now).runtimeMs).toBe(30 * 60 * 1000)
  })

  it("leaves wait and runtime ABSENT when nothing recorded that checking began, rather than answering zero", () => {
    const row: Row = { branch: "task/one", head: "abc", since, state: "queued" }

    expect(clocks(row, now)).toEqual({ ageMs: 60 * 60 * 1000 })
  })
})

describe("the declared checks, joined to what ran", () => {
  const declared: readonly CheckSpec[] = [
    { name: "typecheck", run: "bun run typecheck" },
    { name: "test", run: "bun run test" },
    { name: "lint", run: "bun run lint" },
  ]

  it("keeps candidate failure and green baseline comparator as separate measured occurrences", () => {
    const startedAt = new Date("2026-09-03T20:00:00Z")
    const measured = [
      {
        name: "test",
        phase: "merge",
        startedAt,
        endedAt: startedAt,
        result: "fail" as const,
        log: "/candidate/test.log",
      },
      { name: "test", phase: "base", startedAt, endedAt: startedAt, result: "pass" as const, log: "/base/test.log" },
    ]
    const views = checksOf([], "failed", [{ name: "test", run: "test" }], undefined, measured)
    expect(views.map((view) => [view.name, view.phase, view.state, view.log])).toEqual([
      ["test", "merge", "failed", "/candidate/test.log"],
      ["test", "base", "passed", "/base/test.log"],
    ])
    const current: Row = { branch: "task/one", head: "abc", state: "failed" }
    const projected = watchRows([current], {
      journals: {
        dir: "/logs",
        runs: new Map([
          [
            journalKey(current.branch, current.head),
            [{ ...current, id: "q", startedAt, at: startedAt, checks: measured, decision: "failed" }],
          ],
        ]),
      },
    })
    expect(projected[0]?.row.log).toBe("/candidate/test.log")
    expect(projected[0]?.row.result).toBe("fail test")
  })

  it("renders every check after a failing one as NOT RUN, with the command that would have run it", () => {
    const views = checksOf(
      ["typecheck exit=0 ms=1000 log=/w/typecheck.log", "test exit=1 ms=2000 log=/w/test.log"],
      "failed",
      declared,
    )

    expect(views.map((view) => [view.name, view.state])).toEqual([
      ["typecheck", "passed"],
      ["test", "failed"],
      ["lint", "not-run"],
    ])
    // S2.21: the command lives with the result, so a reader never has to guess
    // what produced a log.
    expect(views[2]?.spec?.run).toBe("bun run lint")
    expect(views[1]?.log).toBe("/w/test.log")
  })

  it("marks the check the journal says is running now, and keeps its log path", () => {
    const views = checksOf(["typecheck exit=0 ms=1000 log=/w/typecheck.log"], "open", declared, {
      log: "/w/test.log",
      name: "test",
    })

    expect(views.map((view) => view.state)).toEqual(["passed", "running", "not-run"])
    expect(views[1]?.log).toBe("/w/test.log")
  })

  it("uses only the selected run's measured checks, including an end without a result", () => {
    // Historical detail must not mix a current failed trailer into an older
    // run, nor turn an interrupted result write into an invented pass.
    const startedAt = new Date("2026-09-03T20:00:00Z")
    const views = checksOf(["lint exit=1 ms=5 log=/later/lint.log"], "failed", declared, undefined, [
      {
        name: "typecheck",
        phase: "merge",
        startedAt,
        endedAt: startedAt,
        result: "stuck",
        exit: "missing",
        log: "/old/typecheck.log",
      },
      { name: "test", phase: "merge", startedAt, endedAt: startedAt, log: "/old/test.log" },
    ])
    expect(views.map((view) => view.state)).toEqual(["stuck", "unmeasured", "not-run"])
    expect(views[0]?.result).toMatchObject({ result: "stuck", exit: "missing", log: "/old/typecheck.log" })
    expect(views[1]?.result).toBeUndefined()
    expect(views[1]?.log).toBe("/old/test.log")
    expect(views[2]?.log).toBeUndefined()
    expect(
      checksOf(["lint exit=1 ms=5 log=/later/lint.log"], "failed", declared, undefined, []).every(
        (view) => view.state === "not-run",
      ),
    ).toBe(true)
  })

  it("keeps a measured result the declaration no longer names, and says its command is not knowable", () => {
    const views = checksOf(["gone exit=1 ms=5 log=/w/gone.log"], "failed", [
      { name: "typecheck", run: "bun run typecheck" },
    ])

    expect(views.map((view) => [view.name, view.state])).toEqual([
      ["typecheck", "not-run"],
      ["gone", "failed"],
    ])
    // Absent, never an empty command string presented as if it were one.
    expect(views[1]?.spec).toBeUndefined()
  })
})

describe("who acts next", () => {
  it("is the queue while the queue still owes the change work", () => {
    expect(nextOwner({ state: "queued" })?.owner).toBe("the queue")
    expect(nextOwner({ state: "checked" })?.owner).toBe("the queue")
  })

  it("is the submitter once it failed, because only they can move the branch", () => {
    const next = nextOwner({ reason: "test", state: "failed" }, { submitter: "@dev/2" })

    expect(next?.owner).toBe("@dev/2")
    expect(next?.because).toContain("test")
  })

  it("is nobody once it merged", () => {
    expect(nextOwner({ state: "merged" })).toBeUndefined()
  })

  it("points a stuck change at the evidence rather than inventing a person no record names", () => {
    const next = nextOwner({ reason: "setup", state: "stuck" }, { journal: "/w/logs" })

    expect(next?.owner).toBe("the queue's operator")
    expect(next?.because).toContain("/w/logs")
  })
})

describe("the head subjects", () => {
  it("reads every subject in ONE call and simply omits a head this repository has not fetched", async () => {
    const root = scratch("subjects")
    const git = gitIn(root)
    await git(["init", "--quiet", "--initial-branch=main", root])
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", "one.txt"), "one\n")
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", "the first change's own subject"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const absent = "0".repeat(40)

    const found = await subjects(git, [head, absent])

    expect(found.get(head)).toBe("the first change's own subject")
    // Not an empty string, which would read on screen as a change with no
    // subject rather than one this repository has not fetched.
    expect(found.has(absent)).toBe(false)
  })

  it("asks git nothing at all for an empty table, because git with no revision walks HEAD", async () => {
    let asked = 0
    const git: Git = async () => {
      asked += 1
      return ""
    }

    expect((await subjects(git, [])).size).toBe(0)
    expect(asked).toBe(0)
  })
})
