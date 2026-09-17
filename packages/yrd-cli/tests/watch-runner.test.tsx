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
import { readRunnerFacts, runnerLine, runnerWord, type RunnerFacts } from "../src/watch-runner.ts"

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
    // The ruled runner words have none for this, so the WORD is the ordinary
    // one and the row's second line carries the fact and its evidence.
    expect(runnerWord(facts, false)).toBe("idle")
    expect(runnerLine(facts, NOW).detail).toContain("died in its Git preamble")
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
    expect(runnerLine(facts, NOW).detail).not.toContain("died in its Git preamble")
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
  const STUCK = {
    by: "yrd-service",
    cause: "stuck" as const,
    change: `task/s@${"4".repeat(40)}`,
    since: NOW.toISOString(),
  }
  const PAUSED = { by: "@chief", cause: "operator" as const, change: null, since: NOW.toISOString() }

  /**
   * @failure The marker reads the same word in every state it exists to tell
   *          apart, so an operator cannot see whether anything is being checked.
   * @level   l1
   */
  it("is CHECKING when a change is under a check right now (items 1 and 5)", () => {
    // `processing` retired: it named the checking phase and the merging phase
    // with one word, on a row that now shares its column with a change's.
    expect(runnerWord(facts({ alive: true }), true)).toBe("checking")
    // The process does not enter into it, in either direction.
    expect(runnerWord(facts({ alive: false }), true)).toBe("checking")
  })

  /**
   * THE CONTROL, and it is the whole point of the change. The service is a
   * long-running `yrd queue up --interval 120` under hab, so its process is up
   * nearly always; if that still produced the marker, the marker would separate
   * nothing and this slice would have changed only a word.
   */
  it("CONTROL: a live process with NOTHING under a check is idle, never checking", () => {
    expect(runnerWord(facts({ alive: true }), false)).toBe("idle")
  })

  /**
   * The line is not moving BY DECISION, which is the answer the reader wants,
   * and the stop is a git fact. A pause record naming a stuck change IS `stuck`
   * — the same word that change wears, in the same column.
   */
  it("says stuck at a change, paused by a person, and lets neither hide behind a live row", () => {
    expect(runnerWord(facts({ alive: true }), false, STUCK)).toBe("stuck")
    expect(runnerWord(facts({ alive: true }), false, PAUSED)).toBe("paused")
    // A stop halts the line, so a row still marked live under one is the
    // residue of a run that ended; taking it at face value would announce work
    // over a halted queue.
    expect(runnerWord(facts({ alive: true }), true, STUCK)).toBe("stuck")
  })

  /**
   * S1 does not invent a status source: the runner publishes none of its own
   * until S2, so a reading with no journal of its own says so rather than
   * guessing — and says it whether or not a stop stands.
   */
  it("is `?` with no journal on this machine, whatever else is true", () => {
    expect(runnerWord({ journalDir: "/w/logs", absent: "none" }, false)).toBe("unpublished")
    expect(runnerWord(undefined, false)).toBe("unpublished")
    expect(runnerWord(undefined, true, PAUSED)).toBe("unpublished")
  })

  /**
   * @failure THE GAP THIS TEST EXISTS TO KEEP VISIBLE, not one it closes.
   *
   *          A journal that has not moved for hours reads `idle`, exactly as
   *          one written a second ago does. That is RULED (@cto, relayed by
   *          @chief): `silent` is the runner's own published beat, read from
   *          `refs/yrd/<queue>/runner` from S2, and is never inferred from a run
   *          journal's mtime. The inference this replaces called a healthy queue
   *          between rounds dead and a dead queue alive by turns.
   *
   *          What it costs is @i/10-yrd/24486, and the cost is real: measured
   *          2026-09-11 during an outage, three rows sat queued with no live
   *          check while the service was down, and a fourth seat submitted into
   *          it. Until S2 publishes a beat, NOTHING on this page catches that.
   *
   *          So this arm pins the absence deliberately. Anyone restoring an
   *          mtime-derived silence will fail here and read this first.
   * @level   l1
   */
  it("never infers silence from a journal's age: a stale journal reads idle, and that gap waits for S2", () => {
    const hours = facts({ lastWriteAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000) })

    expect(runnerWord(hours, false)).toBe("idle")
    expect(runnerWord(hours, false)).not.toBe("silent")
    expect(runnerWord(hours, false)).not.toBe("stopped")
    // The age itself is still READ — the row's second line reports it — so the
    // fact is on screen even though no word is derived from it.
    expect(runnerLine(hours, NOW).detail).toContain("beat 6h00m ago")
  })
})

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
   * The count is the queue's, and the row says what it is idle OVER, so an
   * operator never reads "idle" beside a line with work in it and has to go
   * looking for the number somewhere else.
   */
  it("says how many wait while it holds nothing, and reports a stale journal's age without deriving a word from it", () => {
    const stale = latest({ lastWriteAt: new Date(NOW.getTime() - 12 * 60_000) })

    // No word is derived from the age (see the runnerWord block above: `silent`
    // is the runner's own published beat, and S1 publishes none).
    expect(runnerLine(stale, NOW, { waiting: 0 })).toMatchObject({ holds: "nothing in line", state: "idle" })
    expect(runnerLine(stale, NOW, { waiting: 3 }).holds).toBe("nothing under a check, and 3 in line")
    // The age itself is on screen, on the row's own second line.
    expect(runnerLine(stale, NOW, { waiting: 3 }).detail).toContain("beat 12:00 ago")
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
      { queue: "main", waiting: 2 },
    )

    expect(line.state).toBe("unpublished")
    // The ref is named so a reader knows WHERE the status will be, not to claim
    // it is there: S2 writes it, and until then this row says `?`.
    expect(line.holds).toBe("no runner status published at origin (refs/yrd/main/runner)")
    expect(line.detail).toContain("/w/logs")
    expect(line.detail).toContain("the check output is on the queue's machine only")
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
    expect(stopped.holds).toContain("line stopped at task/s since")
    // EVERY cure a reader is handed must be a command they can run: the verb is
    // `yrd queue withdraw` (cli.ts), and there is no `yrd cancel`.
    expect(stopped.holds).toContain("fix and yrd merge <fix>")
    expect(stopped.holds).toContain("yrd queue withdraw task/s")
    expect(stopped.holds).toContain("yrd queue resume")
    expect(stopped.holds).not.toContain("yrd cancel")

    const paused = runnerLine(latest({}), NOW, {
      stopped: { by: "@chief", cause: "operator", change: null, since: since.toISOString() },
    })
    expect(paused.state).toBe("paused")
    expect(paused.holds).toContain("by @chief")
    // The pause RECORD's own sentence is the loud line at the top of the page
    // and is said exactly once; this row says the word and the cure.
    expect(paused.detail).toContain("beat")
  })

  /**
   * 24470 has no WORD in the ruled eight, and inventing one would put a tenth
   * word in a column that is meant to read as one vocabulary. The fact is
   * host-only, so it goes where host-only facts go — the row's second line,
   * which never goes blank — and it still points at the journal row that IS the
   * failing call.
   */
  it("names the journal of a run that died in its Git preamble on its second line, where host-only facts go", () => {
    const line = runnerLine(latest({ unstarted: true }), NOW, {})

    expect(line.state).toBe("idle")
    expect(line.detail).toContain("died in its Git preamble")
    expect(line.detail).toContain("/w/logs/q-20260903T115800000Z-0badf00d.jsonl")
    expect(line.detail).toContain("names the call that failed")
  })
})
