/**
 * @failure  The port had no RUNNER at all: a queue whose service had died
 *           read exactly like one with nothing to do, and a running check
 *           gave no sign of the process behind it (watch-redesign items 13,
 *           14, 16, 17, 27, 29, 37). The one instrument the new core leaves is
 *           the run journal and the run's own `.pid` file. Since S1 it is a
 *           ROW in the table's own columns rather than a box beside it, so its
 *           word comes from THE ONE WORD TABLE and sits in the same STATUS
 *           column as every change's.
 * @level    l1 (the reader, the word and the line, against a temp workdir)
 * @consumer the operator reading `yrd list` and `yrd watch`
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runId } from "@yrd/queue-core"
import { SILENT_AFTER_MS, readRunnerFacts, runnerLine, runnerWord, type RunnerFacts } from "../src/watch-runner.ts"

const NOW = new Date("2026-09-03T12:00:00.000Z")

/** A workdir with one run journal started `ageMs` ago, its header record, and optionally a `.pid` file. */
function workdirWith(
  options: Readonly<{
    ageMs: number
    pid?: number
    pidDirectory?: boolean
    pidText?: string
    header?: boolean | string
    gitBeforeHeader?: boolean
    lastWriteAgoMs?: number
  }>,
): string {
  const workdir = mkdtempSync(join(tmpdir(), "yrd-watch-runner-"))
  const logs = join(workdir, "logs")
  mkdirSync(logs, { recursive: true })
  const id = runId(new Date(NOW.getTime() - options.ageMs))
  const path = join(logs, `${id}.jsonl`)
  const header =
    typeof options.header === "string"
      ? options.header
      : options.header === false
        ? "not a record\n"
        : `${JSON.stringify({ at: NOW.toISOString(), checks: ["typecheck", "test"], gitlink: "3c285a41af46".padEnd(40, "0"), kind: "run", queue: "main", run: id, target: "main" })}\n`
  const prefix = options.gitBeforeHeader
    ? `${JSON.stringify({ kind: "git", run: id, at: NOW.toISOString(), evidence: join(logs, id, "git", "1.stdout.bin.json") })}\n`
    : ""
  writeFileSync(path, `${prefix}${header}`)
  const lastWrite = new Date(NOW.getTime() - (options.lastWriteAgoMs ?? 0))
  utimesSync(path, lastWrite, lastWrite)
  if (options.pid !== undefined || options.pidText !== undefined || options.pidDirectory === true) {
    mkdirSync(join(workdir, "worktrees", id), { recursive: true })
    const pidPath = join(workdir, "worktrees", id, ".pid")
    if (options.pidDirectory === true) mkdirSync(pidPath)
    else writeFileSync(pidPath, options.pidText ?? `${String(options.pid)}\n`)
  }
  return workdir
}

describe("readRunnerFacts", () => {
  it("says where it looked when there is no journal directory, and when the directory holds no run", () => {
    const empty = mkdtempSync(join(tmpdir(), "yrd-watch-runner-"))
    expect(readRunnerFacts(empty).absent).toContain("there is no such directory")
    mkdirSync(join(empty, "logs"))
    expect(readRunnerFacts(empty).absent).toContain("holds no run journal")
  })

  it.each([false, true])(
    "reads the newest run, including its header after Git evidence: prefix=%s",
    (gitBeforeHeader) => {
      const facts = readRunnerFacts(
        workdirWith({ ageMs: 60_000, pid: process.pid, lastWriteAgoMs: 5_000, gitBeforeHeader }),
      )
      const latest = facts.latest
      if (latest === undefined) throw new Error("no run read")
      expect(latest.alive).toBe(true)
      expect(latest.pid).toBe(process.pid)
      expect(latest.startedAt.getTime()).toBe(NOW.getTime() - 60_000)
      expect(Math.abs(latest.lastWriteAt.getTime() - (NOW.getTime() - 5_000))).toBeLessThan(1_500)
      expect(latest.target).toBe("main")
      expect(latest.checks).toEqual(["typecheck", "test"])
      expect(latest.gitlink?.startsWith("3c285a41af46")).toBe(true)
    },
  )

  it("reads a dead pid as not alive", () => {
    // 2147483647 is the largest pid Linux can hand out and is not ours.
    const dead = readRunnerFacts(workdirWith({ ageMs: 60_000, pid: 2_147_483_647 }))
    expect(dead.latest?.alive).toBe(false)
  })

  it.each([
    ["invalid JSON", "not a record\n"],
    ["an empty record", "\n"],
    ["the wrong record kind", `${JSON.stringify({ kind: "message" })}\n`],
    ["an incomplete Git record", `${JSON.stringify({ kind: "git" })}\n`],
  ])("refuses a required run journal with %s", (_case, header) => {
    const workdir = workdirWith({ ageMs: 60_000, header })
    expect(() => readRunnerFacts(workdir)).toThrow(/run journal .* (record|header)/u)
  })

  it("refuses a newest run journal that cannot be read", () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-watch-runner-"))
    const logs = join(workdir, "logs")
    mkdirSync(logs)
    const path = join(logs, `${runId(new Date(NOW.getTime() - 60_000))}.jsonl`)
    mkdirSync(path)

    expect(() => readRunnerFacts(workdir)).toThrow(`run journal ${path}`)
  })

  /**
   * @failure A close verb read the NEWEST journal while its run was still
   *          executing, before the run header had been appended, and reported
   *          "required run header was not found" — a live run reading as a
   *          malformed one (24478). Since 24470 the header comes FIRST and a
   *          new run cannot reach this state, but a journal written before that
   *          landed still can, so the tolerance stays and keeps its own proof.
   */
  it("reads a live run that has not reached its header yet as in progress, not malformed", () => {
    const facts = readRunnerFacts(workdirWith({ ageMs: 1_000, gitBeforeHeader: true, header: "", pid: process.pid }))
    expect(facts.absent).toBeUndefined()
    expect(facts.latest?.alive).toBe(true)
    // No header fields: the run has not written them yet, and every one of them
    // is optional precisely so this state is representable.
    expect(facts.latest?.target).toBeUndefined()
    expect(facts.latest?.queue).toBeUndefined()
    expect(facts.latest?.gitlink).toBeUndefined()
    expect(facts.latest?.checks).toBeUndefined()
  })

  /**
   * @failure  A run that threw in its Git preamble left a journal of Git rows
   *           and no header, and the reader called that a malformed journal —
   *           the same words a writer defect gets. A terminal outcome with its
   *           own cure was reported as a tolerated absence (@i/10-yrd/24470 AC2).
   */
  it("names a run that died in its Git preamble UNSTARTED, not malformed", () => {
    const facts = readRunnerFacts(workdirWith({ ageMs: 1_000, gitBeforeHeader: true, header: "" }))
    expect(facts.latest?.unstarted).toBe(true)
    expect(facts.latest?.alive).toBe(false)
    // No header fields, and that is now a NAMED state rather than a refusal.
    expect(facts.latest?.queue).toBeUndefined()
    expect(runnerWord(facts, NOW, false)).toBe("unstarted")
  })

  /**
   * Since 24470 the header is written before the first journaled Git call, so a
   * run that dies after it reads unstarted by the MISSING QUEUE RECORD instead.
   * Both eras of journal reach the same word through the same predicate.
   */
  it("names a headed run that never resolved its queue UNSTARTED too", () => {
    const header = `${JSON.stringify({ at: NOW.toISOString(), checks: ["typecheck"], gitlink: "3c285a41af46".padEnd(40, "0"), kind: "run", run: "q-test", target: "main" })}\n`
    const facts = readRunnerFacts(workdirWith({ ageMs: 1_000, header }))
    expect(facts.latest?.unstarted).toBe(true)
    expect(facts.latest?.target).toBe("main")
    expect(facts.latest?.queue).toBeUndefined()
  })

  /**
   * @failure  THE FALSE ALARM. `claimWorktrees` does not run until after the
   *           whole Git preamble (queue-core run.ts:476), so throughout the
   *           window this state exists in there is no `.pid` file to read. A
   *           reader taking liveness from that absence calls a run three seconds
   *           into a healthy preamble dead. The header's own pid is the only one
   *           there is, and it is why the header carries one.
   */
  it("reads liveness from the header's pid while no worktree has been claimed", () => {
    const header = `${JSON.stringify({ at: NOW.toISOString(), kind: "run", pid: process.pid, run: "q-test", target: "main" })}\n`
    const facts = readRunnerFacts(workdirWith({ ageMs: 1_000, header }))
    expect(facts.latest?.alive).toBe(true)
    expect(facts.latest?.pid).toBe(process.pid)
    // Mid-preamble, so no queue yet — and emphatically not a dead run.
    expect(facts.latest?.queue).toBeUndefined()
    expect(facts.latest?.unstarted).toBeUndefined()
    expect(runnerWord(facts, NOW, false)).not.toBe("unstarted")
  })

  // The control: a run whose queue record IS there is an ordinary run, and the
  // legacy header that carries `queue` on itself is one too.
  it("reads a resolved queue from the queue record, and from a legacy header", () => {
    const id = "q-test"
    const header =
      `${JSON.stringify({ at: NOW.toISOString(), checks: ["typecheck"], gitlink: "3c285a41af46".padEnd(40, "0"), kind: "run", run: id, target: "main" })}\n` +
      `${JSON.stringify({ at: NOW.toISOString(), kind: "queue", queue: "main on origin", run: id })}\n`
    const resolved = readRunnerFacts(workdirWith({ ageMs: 1_000, header }))
    expect(resolved.latest?.unstarted).toBeUndefined()
    expect(resolved.latest?.queue).toBe("main on origin")
    const legacy = readRunnerFacts(workdirWith({ ageMs: 1_000, gitBeforeHeader: true }))
    expect(legacy.latest?.unstarted).toBeUndefined()
    expect(legacy.latest?.queue).toBe("main")
  })

  it("refuses malformed and unreadable run pid files instead of calling the runner idle", () => {
    const malformed = workdirWith({ ageMs: 60_000, pidText: "42junk\n" })
    expect(() => readRunnerFacts(malformed)).toThrow(/run pid file .* positive safe integer/u)

    const unreadable = workdirWith({ ageMs: 60_000, pidDirectory: true })
    expect(() => readRunnerFacts(unreadable)).toThrow(/run pid file .* cannot be read/u)
  })
})

describe("runnerWord, the one word", () => {
  const facts = (over: Partial<NonNullable<RunnerFacts["latest"]>>): RunnerFacts => ({
    journalDir: "/w/logs",
    latest: { alive: false, id: "q-x", lastWriteAt: NOW, startedAt: NOW, ...over },
  })
  const STOPPED = { by: "yrd-service", cause: "stuck" as const, change: `task/s@${"4".repeat(40)}`, since: NOW.toISOString() }
  const PAUSED = { by: "@chief", cause: "operator" as const, change: null, since: NOW.toISOString() }

  /**
   * CHANGED MEANING, deliberately, and kept here rather than retyped quietly.
   * This arm asserted the defect items 1 and 5 name: `running` whenever the
   * PROCESS lived, "whatever else is true" -- including a journal that had not
   * moved since the epoch. That short-circuit sat ABOVE the silence check, so a
   * live process whose journal had stopped read healthy, and the wedged case
   * was masked by the very process that was wedged.
   */
  it("a live process whose journal has stopped reads STOPPED, not healthy", () => {
    expect(runnerWord(facts({ alive: true, lastWriteAt: new Date(0) }), NOW, false)).toBe("stopped")
    // And it stays silent even if a row still claims a check is live: a service
    // that died mid-check leaves exactly that residue.
    expect(runnerWord(facts({ alive: true, lastWriteAt: new Date(0) }), NOW, true)).toBe("stopped")
  })

  /**
   * @failure The marker reads the same word in every state it exists to tell
   *          apart, so an operator cannot see whether anything is being checked.
   * @level   l1
   */
  it("is CHECKING when a change is under a check right now (items 1 and 5)", () => {
    // `processing` retired in S1: it named the checking phase and the merging
    // phase with one word, on a row that now shares its column with a change's.
    expect(runnerWord(facts({ alive: true }), NOW, true)).toBe("checking")
    // The process does not enter into it, in either direction.
    expect(runnerWord(facts({ alive: false }), NOW, true)).toBe("checking")
  })

  /**
   * THE CONTROL, and it is the whole point of the change. The service is a
   * long-running `yrd queue up --interval 120` under hab, so its process is up
   * nearly always; if that still produced the marker, the marker would separate
   * nothing and this slice would have changed only a word.
   */
  it("CONTROL: a live process with NOTHING under a check is idle, never checking", () => {
    expect(runnerWord(facts({ alive: true }), NOW, false)).toBe("idle")
  })

  it("is `?` with no journal and no stop, stopped past the ceiling, idle otherwise", () => {
    // S1 does not invent a status source: the runner publishes none of its own
    // until S2, so a reading off its machine says so rather than guessing.
    expect(runnerWord({ journalDir: "/w/logs", absent: "none" }, NOW, false)).toBe("unpublished")
    expect(runnerWord(undefined, NOW, false)).toBe("unpublished")
    const quiet = facts({ lastWriteAt: new Date(NOW.getTime() - SILENT_AFTER_MS - 1) })
    expect(runnerWord(quiet, NOW, false)).toBe("stopped")
    expect(runnerWord(facts({ lastWriteAt: new Date(NOW.getTime() - SILENT_AFTER_MS + 1_000) }), NOW, false)).toBe(
      "idle",
    )
  })

  /**
   * The line is not moving BY DECISION, which is the answer the reader wants,
   * and the stop is a git fact — the one word this row can still say off the
   * queue's own machine.
   */
  it("says stopped at a change, paused by a person, and says either with no journal here", () => {
    // @cto, relayed by @chief cf4677f8: a pause record naming a stuck change
    // IS `stuck` — the same word the change wears, in the same column.
    expect(runnerWord(facts({ alive: true }), NOW, false, STOPPED)).toBe("stuck")
    expect(runnerWord(facts({ alive: true }), NOW, false, PAUSED)).toBe("paused")
    expect(runnerWord(undefined, NOW, false, PAUSED)).toBe("paused")
    // A stop never hides a check that IS running, because the stop outranks it.
    expect(runnerWord(facts({ alive: true }), NOW, true, STOPPED)).toBe("stuck")
  })

  /**
   * SILENCE OUTRANKS THE STOP. A round still opens and records through a pause,
   * so a paused queue whose journal has stopped moving is a SERVICE that is
   * down on top of a pause — the louder and the more actionable of the two.
   */
  it("CONTROL: a quiet journal outranks a stop, and a definite outcome outranks both", () => {
    const quiet = facts({ lastWriteAt: new Date(NOW.getTime() - SILENT_AFTER_MS - 1) })
    expect(runnerWord(quiet, NOW, false, PAUSED)).toBe("stopped")
    expect(runnerWord({ ...quiet, latest: { ...quiet.latest!, unstarted: true } }, NOW, false, PAUSED)).toBe(
      "unstarted",
    )
  })

  /**
   * @failure An empty queue whose service is dead reads `idle`, so the seat
   *          about to submit into it sees a healthy queue and submits.
   */
  it("goes loud on an EMPTY queue too — the state a submitter arrives into (@i/10-yrd/24486)", () => {
    const quiet = facts({ lastWriteAt: new Date(NOW.getTime() - SILENT_AFTER_MS - 1) })
    expect(runnerWord(quiet, NOW, false)).toBe("stopped")
  })

  /**
   * @failure The weaker silence condition turns a healthy queue between polls
   *          into a false alarm, and a box that cries wolf gets ignored.
   * @level l1
   */
  it("NEGATIVE CONTROL: a healthy queue between polls never reads stopped", () => {
    // The live queue's measured cadence, 2026-09-11: journals at 09:01:16,
    // 09:03:21, 09:05:26, 09:07:30, 09:09:35, 09:11:40 — about 2:05 apart,
    // nearly five times inside the ceiling, and written whether or not the
    // round had work.
    const cadenceMs = 125_000
    expect(cadenceMs * 4).toBeLessThan(SILENT_AFTER_MS)
    expect(runnerWord(facts({ lastWriteAt: new Date(NOW.getTime() - cadenceMs) }), NOW, false)).toBe("idle")
    expect(runnerWord(facts({ lastWriteAt: new Date(NOW.getTime() - cadenceMs * 4) }), NOW, false)).toBe("idle")
    // And the queue depth cannot change that answer, because the signature no
    // longer admits one: whatever is in line, these are the same two facts.
  })
})

/**
 * The runner's ROW, as the flow page draws it: the word, what it holds or why
 * it holds nothing, and the second line of host-only detail that is NEVER
 * blank. The box's four rails are gone with the box; what survived is the one
 * line an operator acted on, in the table's own columns.
 */
describe("the runner's row", () => {
  const latest = (over: Partial<NonNullable<RunnerFacts["latest"]>>): RunnerFacts => ({
    journalDir: "/w/logs",
    latest: {
      alive: false,
      checks: ["typecheck", "test"],
      gitlink: "3c285a41af46".padEnd(40, "0"),
      id: "q-20260903T115800000Z-0badf00d",
      lastWriteAt: new Date(NOW.getTime() - 2_000),
      startedAt: new Date(NOW.getTime() - 120_000),
      target: "main",
      ...over,
    },
  })
  const held = {
    branch: "task/x",
    since: new Date(NOW.getTime() - 120_000),
    subject: "the change under a check",
    submitter: "@dev/2",
  }

  // CHANGED MEANING (items 1 and 5): this used to paint a live PROCESS and
  // expect the run rails. The process being up is no longer the predicate, so
  // the same facts are now reached by a change actually being under a check --
  // which is what they were always describing.
  it("names the change under a check, its submitter and how long, with the beat and the round under it", () => {
    const line = runnerLine(latest({ alive: true, pid: 4242 }), NOW, { held, waiting: 1 })

    expect(line.state).toBe("checking")
    expect(line.holds).toBe("task/x the change under a check")
    expect(line.by).toBe("@dev/2")
    expect(line.duration).toBe("checking 2:00")
    expect(line.at).toEqual(new Date(NOW.getTime() - 120_000))
    expect(line.detail).toContain("alive: beat 0:02 ago")
    expect(line.detail).toMatch(/this round since \d\d:\d\d:\d\d/u)
    expect(line.detail).toContain("typecheck, test, output 0:02 ago (this machine only)")
  })

  it("reads idle between runs, and says what it is idle over", () => {
    expect(runnerLine(latest({}), NOW, { waiting: 0 })).toMatchObject({
      duration: "idle 0:02",
      holds: "nothing in line",
      state: "idle",
    })
    expect(runnerLine(latest({}), NOW, { waiting: 3 }).holds).toBe("nothing under a check, and 3 in line")
  })

  /**
   * @failure The runner reads `idle` at the exact moment a seat is deciding
   *          whether to submit, and the submission goes into a dead queue.
   */
  it("goes loud on an EMPTY queue too, and says what submitting now would do (@i/10-yrd/24486)", () => {
    const line = runnerLine(latest({ lastWriteAt: new Date(NOW.getTime() - 12 * 60_000) }), NOW, { waiting: 0 })

    expect(line.state).toBe("stopped")
    expect(line.duration).toBe("stopped 12:00")
    expect(line.holds).toContain("no journal write for 12:00")
    expect(line.holds).toContain("nothing is in line, so a change submitted now would not be picked up")
    // Never the in-line sentence, which would be a lie at zero.
    expect(line.holds).not.toContain("wait in line")
  })

  it("goes loud when changes wait and nothing has written past the ceiling", () => {
    const line = runnerLine(latest({ lastWriteAt: new Date(NOW.getTime() - 12 * 60_000) }), NOW, { waiting: 3 })

    expect(line.duration).toBe("stopped 12:00")
    expect(line.holds).toBe("no journal write for 12:00 while 3 changes wait in line")
  })

  /**
   * @failure A blank where a fact belongs reads as a queue with nothing to say.
   *          Off the queue's own machine there is no journal at all, and S1
   *          publishes no status to replace it, so the row must say both.
   */
  it("says where the journal was looked for when there is none, never a blank, and never an invented status", () => {
    const line = runnerLine(
      { journalDir: "/w/logs", absent: "no run journal was read: /w/logs — there is no such directory" },
      NOW,
      { waiting: 2 },
    )

    expect(line.state).toBe("unpublished")
    expect(line.holds).toBe("no runner status is published for this queue")
    expect(line.detail).toContain("/w/logs")
    expect(line.detail).toContain("publishes no status of its own yet")
    expect(line.at).toBeUndefined()
    expect(line.duration).toBeUndefined()
    // And with no facts at all, still a sentence and still no guess.
    expect(runnerLine(undefined, NOW).detail).not.toBe("")
  })

  it("names the change the line stopped at and what lifts it, and an operator's pause by who", () => {
    const since = new Date(NOW.getTime() - 6 * 60_000)
    const stopped = runnerLine(latest({}), NOW, {
      stopped: { by: "yrd-service", cause: "stuck", change: `task/s@${"4".repeat(40)}`, since: since.toISOString() },
    })
    expect(stopped.state).toBe("stuck")
    expect(stopped.duration).toBe("stuck 6:00")
    expect(stopped.holds).toContain("the line stopped at task/s since")
    expect(stopped.holds).toContain("yrd queue resume")

    const paused = runnerLine(latest({}), NOW, {
      stopped: { by: "@chief", cause: "operator", change: null, since: since.toISOString() },
    })
    expect(paused.state).toBe("paused")
    expect(paused.holds).toContain("by @chief")
    // The pause RECORD's own sentence is the loud line at the top of the page
    // and is said exactly once; this row says the word and the cure.
    expect(paused.detail).toContain("beat")
  })

  it("names the journal of a run that died in its Git preamble, which is where the failing call is", () => {
    const line = runnerLine(latest({ unstarted: true }), NOW, {})

    expect(line.state).toBe("unstarted")
    expect(line.holds).toContain("died in its Git preamble")
    expect(line.detail).toContain("/w/logs/q-20260903T115800000Z-0badf00d.jsonl")
    expect(line.detail).toContain("names the call that failed")
  })
})
