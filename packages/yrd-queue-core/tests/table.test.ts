/**
 * @failure An event row loses a check verdict, borrows a stale run's live marker, or reports the wrong clock.
 * @level l1 (pure event row, journal and formatter contracts)
 * @consumer yrd list, show and watch
 */
import { describe, expect, it } from "vitest"
import { checkTrailer, clocks, journalKey, readCheckTrailer, watchRows, type Row } from "../src/index.ts"
import { journalRun } from "../../../tests/support/journal-run.ts"

describe("a packed Check: trailer", () => {
  it("does not promote words in a log path into retained verdict evidence", () => {
    expect(readCheckTrailer("unit exit=0 ms=42 log=/tmp/check result=pass attempt=1 phase=merge tier=long")).toEqual({
      name: "unit",
      exit: "0",
      ms: 42,
      log: "/tmp/check result=pass attempt=1 phase=merge tier=long",
    })
  })

  it("retains an event check verdict, attempt and phase after its temporary log disappears", () => {
    const packed = checkTrailer(
      {
        durationMs: 42,
        exit: "timeout",
        log: "/tmp/removed/check.log",
        name: "affected-tests",
        result: "stuck",
      },
      { attempt: 2, phase: "merge", tier: "long" },
    )

    expect(packed).toBe(
      "affected-tests exit=timeout ms=42 result=stuck attempt=2 phase=merge tier=long log=/tmp/removed/check.log",
    )
    expect(readCheckTrailer(packed)).toEqual({
      name: "affected-tests",
      exit: "timeout",
      ms: 42,
      result: "stuck",
      attempt: 2,
      phase: "merge",
      tier: "long",
      log: "/tmp/removed/check.log",
    })
  })

  it("reads back every field the writer put in it, log path and all", () => {
    // The table renders a row off this trailer, so the pair is the contract:
    // whatever the run writes, the reader has to give back. It gave back two
    // of the four, so a reader that wanted the exit or the duration went to
    // the trailer text with a regex of its own.
    const packed = checkTrailer({
      durationMs: 1234,
      exit: 1,
      log: "/queue/checks/task~one@abc/q-1/merge/type=check.log",
      name: "verify",
      result: "fail",
    })

    expect(packed).toBe("verify exit=1 ms=1234 log=/queue/checks/task~one@abc/q-1/merge/type=check.log")
    expect(readCheckTrailer(packed)).toEqual({
      exit: "1",
      log: "/queue/checks/task~one@abc/q-1/merge/type=check.log",
      ms: 1234,
      name: "verify",
    })
  })

  it("reads back a word exit, which is what a check the queue could not measure carries", () => {
    const packed = checkTrailer({
      durationMs: 1_800_000,
      exit: "timeout",
      log: "/queue/checks/task~one@abc/q-1/merge/test.log",
      name: "test",
      result: "stuck",
    })

    expect(readCheckTrailer(packed)).toEqual({
      exit: "timeout",
      log: "/queue/checks/task~one@abc/q-1/merge/test.log",
      ms: 1_800_000,
      name: "test",
    })
  })
})

describe("event row overlays", () => {
  it("keeps an observed merge's event SHA across run rows without a merge record", () => {
    const branch = "task/observed"
    const head = "a".repeat(40)
    const merge = "b".repeat(40)
    const at = new Date("2026-09-28T05:04:24Z")
    const runs = [
      journalRun({ at, startedAt: at, branch, head, id: "q-2", decision: "merged", reason: "already on target" }),
      journalRun({ at, startedAt: at, branch, head, id: "q-1", decision: "checked" }),
    ]
    const journals = { dir: "/journal-fixture", malformed: [], runs: new Map([[journalKey(branch, head), runs]]) }
    const merged: Row = { branch, head, state: "merged", merge }
    expect(watchRows([merged], { journals, perRun: true }).map(({ row }) => row.merge)).toEqual([merge, merge])

    const withoutEventSha: Row = { branch, head, state: "merged" }
    expect(watchRows([withoutEventSha], { journals, perRun: true }).map(({ row }) => row.merge)).toEqual([
      undefined,
      undefined,
    ])
  })

  it.each([
    ["verifying", true],
    ["checking", true],
    ["merging", true],
    ["cancelled", false],
  ] as const)("an event %s row keeps its running check only while open", (state, kept) => {
    const head = "a".repeat(40)
    const startedAt = new Date("2026-09-24T12:00:00Z")
    const running = { name: "affected-tests", phase: "merge", startedAt }
    const journals = {
      dir: "/journal-fixture",
      malformed: [],
      runs: new Map([
        [
          journalKey("task/one", head),
          [journalRun({ at: startedAt, branch: "task/one", head, id: "q-1", running, startedAt })],
        ],
      ]),
    }
    const current: Row = { branch: "task/one", head, state }
    const [split] = watchRows([current], { journals, perRun: true })
    expect(split?.row.live?.check).toBe(kept ? "affected-tests" : undefined)
  })
})

describe("row clocks", () => {
  describe("clocks() rules (25630 rows 28 & 29)", () => {
    it("pins OLD-UNTIL: a done row read through its notice gets a run end from endedWhen", () => {
      const startedAt = new Date("2026-09-24T12:00:00Z")
      const endingAt = new Date("2026-09-24T12:05:00Z")
      const now = new Date("2026-09-24T13:00:00Z")
      // A merged row read only through its sent notice: has endingAt (or at), but endedAt is undefined
      const noticeRow: Row = {
        branch: "task/notice-only",
        head: "abc123456789",
        state: "merged",
        startedAt,
        endingAt,
        at: endingAt,
        since: startedAt,
      }
      const measured = clocks(noticeRow, now)
      expect(measured.runtimeMs).toBe(5 * 60 * 1000)
    })

    it("pins DIRECT-NOT-ENDED: direct rows count as ended in clocks()", () => {
      const commitAt = new Date("2026-09-24T12:00:00Z")
      const now = new Date("2026-09-24T13:00:00Z")
      const directRow: Row = {
        branch: "main",
        head: "def123456789",
        state: "direct",
        at: commitAt,
      }
      const measured = clocks(directRow, now)
      // Clock is ordered by ended instant (commitAt)
      expect(measured.clockAt).toEqual(commitAt)
      // A direct row has no queue runtime, age, or took
      expect(measured.runtimeMs).toBeUndefined()
      expect(measured.tookMs).toBeUndefined()
      expect(measured.ageMs).toBeUndefined()
    })

    it("done row with no opening instant reads undefined for ageMs and tookMs (Row 28)", () => {
      const startedAt = new Date("2026-09-24T12:00:00Z")
      const endedAt = new Date("2026-09-24T12:05:00Z")
      const now = new Date("2026-09-24T13:00:00Z")
      // Merged row whose Opened line was not read: since is undefined
      const unreadOpened: Row = {
        branch: "task/no-since",
        head: "ghi123456789",
        state: "merged",
        startedAt,
        endedAt,
        at: endedAt,
      }
      const measured = clocks(unreadOpened, now)
      expect(measured.runtimeMs).toBe(5 * 60 * 1000)
      expect(measured.ageMs).toBeUndefined()
      expect(measured.tookMs).toBeUndefined()
    })
  })
})
