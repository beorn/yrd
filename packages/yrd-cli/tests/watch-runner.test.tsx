/**
 * @failure  The port had no RUNNER box at all: a queue whose service had
 *           died read exactly like one with nothing to do, and a running
 *           check gave no sign of the process behind it (watch-redesign
 *           items 13, 14, 16, 17, 27, 29, 37). The one instrument the new
 *           core leaves is the run journal and the run's own `.pid` file.
 * @level    l1 (the reader and the health word, against a temp workdir) and
 *           l2 (the box, painted)
 * @consumer the operator reading the bottom of `yrd watch`
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { render } from "silvery/test"
import { runId } from "@yrd/queue-core"
import { RunnerBox } from "../src/watch-boxes.tsx"
import { MinuteContext, NowContext } from "../src/watch-clock.ts"
import { SILENT_AFTER_MS, readRunnerFacts, runnerFact, runnerHealth, type RunnerFacts } from "../src/watch-runner.ts"

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
    [
      "Git evidence without a run header",
      `${JSON.stringify({ kind: "git", run: "q-test", at: NOW.toISOString(), evidence: "/logs/git/1.json" })}\n`,
    ],
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
   *          malformed one. The header cannot come first: it carries `queue`,
   *          which the writer computes only after Git reads that are themselves
   *          journaled, so a Git preamble always precedes it (24478).
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

  it("still refuses loudly when a run that is NOT executing has no header", () => {
    expect(() => readRunnerFacts(workdirWith({ ageMs: 1_000, gitBeforeHeader: true, header: "" }))).toThrow(
      /required run header was not found, and the run is not executing/u,
    )
  })

  it("refuses malformed and unreadable run pid files instead of calling the runner idle", () => {
    const malformed = workdirWith({ ageMs: 60_000, pidText: "42junk\n" })
    expect(() => readRunnerFacts(malformed)).toThrow(/run pid file .* positive safe integer/u)

    const unreadable = workdirWith({ ageMs: 60_000, pidDirectory: true })
    expect(() => readRunnerFacts(unreadable)).toThrow(/run pid file .* cannot be read/u)
  })
})

describe("runnerHealth, the one word", () => {
  const facts = (over: Partial<NonNullable<RunnerFacts["latest"]>>): RunnerFacts => ({
    journalDir: "/w/logs",
    latest: { alive: false, id: "q-x", lastWriteAt: NOW, startedAt: NOW, ...over },
  })

  /**
   * CHANGED MEANING, deliberately, and kept here rather than retyped quietly.
   * This arm asserted the defect items 1 and 5 name: `running` whenever the
   * PROCESS lived, "whatever else is true" -- including a journal that had not
   * moved since the epoch. That short-circuit sat ABOVE the silence check, so a
   * live process whose journal had stopped read healthy, and the wedged case
   * was masked by the very process that was wedged.
   */
  it("a live process whose journal has stopped is SILENT, not healthy", () => {
    expect(runnerHealth(facts({ alive: true, lastWriteAt: new Date(0) }), NOW, false)).toBe("silent")
    // And it stays silent even if a row still claims a check is live: a service
    // that died mid-check leaves exactly that residue.
    expect(runnerHealth(facts({ alive: true, lastWriteAt: new Date(0) }), NOW, true)).toBe("silent")
  })

  /**
   * @failure The marker reads the same word in every state it exists to tell
   *          apart, so an operator cannot see whether anything is being checked.
   * @level   l1
   */
  it("is PROCESSING when a change is under a check right now (items 1 and 5)", () => {
    expect(runnerHealth(facts({ alive: true }), NOW, true)).toBe("processing")
    // The process does not enter into it, in either direction.
    expect(runnerHealth(facts({ alive: false }), NOW, true)).toBe("processing")
  })

  /**
   * THE CONTROL, and it is the whole point of the change. The service is a
   * long-running `yrd queue up --interval 120` under hab, so its process is up
   * nearly always; if that still produced the marker, the marker would separate
   * nothing and this slice would have changed only a word.
   */
  it("CONTROL: a live process with NOTHING under a check is idle, never processing", () => {
    expect(runnerHealth(facts({ alive: true }), NOW, false)).toBe("idle")
  })

  it("is absent with no journal, silent past the ceiling, idle otherwise", () => {
    expect(runnerHealth({ journalDir: "/w/logs", absent: "none" }, NOW, false)).toBe("absent")
    const quiet = facts({ lastWriteAt: new Date(NOW.getTime() - SILENT_AFTER_MS - 1) })
    expect(runnerHealth(quiet, NOW, false)).toBe("silent")
    expect(runnerHealth(facts({ lastWriteAt: new Date(NOW.getTime() - SILENT_AFTER_MS + 1_000) }), NOW, false)).toBe("idle")
  })

  /**
   * @failure An empty queue whose service is dead reads `idle`, so the seat
   *          about to submit into it sees a healthy queue and submits.
   */
  it("is silent on an EMPTY queue too — the state a submitter arrives into (@i/10-yrd/24486)", () => {
    const quiet = facts({ lastWriteAt: new Date(NOW.getTime() - SILENT_AFTER_MS - 1) })
    expect(runnerHealth(quiet, NOW, false)).toBe("silent")
  })

  /**
   * @failure The weaker silence condition turns a healthy queue between polls
   *          into a false alarm, and a box that cries wolf gets ignored.
   * @level l1
   */
  it("NEGATIVE CONTROL: a healthy queue between polls is never silent", () => {
    // The live queue's measured cadence, 2026-09-11: journals at 09:01:16,
    // 09:03:21, 09:05:26, 09:07:30, 09:09:35, 09:11:40 — about 2:05 apart,
    // nearly five times inside the ceiling, and written whether or not the
    // round had work.
    const cadenceMs = 125_000
    expect(cadenceMs * 4).toBeLessThan(SILENT_AFTER_MS)
    expect(runnerHealth(facts({ lastWriteAt: new Date(NOW.getTime() - cadenceMs) }), NOW, false)).toBe("idle")
    expect(runnerHealth(facts({ lastWriteAt: new Date(NOW.getTime() - cadenceMs * 4) }), NOW, false)).toBe("idle")
    // And the queue depth cannot change that answer, because the signature no
    // longer admits one: whatever is in line, these are the same two facts.
  })
})

describe("the RUNNER box", () => {
  async function paint(facts: RunnerFacts, inLine: number, pause?: string, underCheck = false): Promise<string> {
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <RunnerBox
            facts={facts}
            label="main"
            inLine={inLine}
            underCheck={underCheck}
            columns={70}
            live={false}
            {...(pause === undefined ? {} : { pause })}
          />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      { cols: 72, rows: 12 },
    )
    await app.waitForLayoutStable()
    const text = app.text
    app.unmount()
    return text
  }
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

  // CHANGED MEANING (items 1 and 5): this used to paint a live PROCESS and
  // expect the run rails. The process being up is no longer the predicate, so
  // the same rails are now reached by a change actually being under a check --
  // which is what they were always describing.
  it("names the run under check with its pid on the `$` line, the run's facts and the measured-at clock under it, hanging off one gutter", async () => {
    const text = await paint(latest({ alive: true, pid: 4242 }), 1, undefined, true)

    expect(text).toContain("RUNNER")
    // Item 1: the marker shows its own word, as idle and silent always did.
    expect(text).toContain("processing 2:00")
    expect(text).toContain("$ yrd queue run · main#")
    expect(text).toContain("[pid 4242]")
    expect(text).toMatch(/^\s*│\s{3}target main · gitlink 3c285a41af46 · checks typecheck, test/mu)
    expect(text).toMatch(/progress \d\d:\d\d:\d\d · 0:02 ago/u)
  })

  it("reads idle between runs, naming the last run and how long ago it wrote", async () => {
    const text = await paint(latest({}), 0)

    expect(text).toContain("idle 0:02")
    expect(text).toContain("$ yrd queue up · last run main#")
    expect(text).toContain("wrote 0:02 ago")
    expect(text).not.toContain("SILENT")
  })

  /**
   * @failure The box reads `idle` at the exact moment a seat is deciding
   *          whether to submit, and the submission goes into a dead queue.
   */
  it("goes loud on an EMPTY queue too, and says what submitting now would do (@i/10-yrd/24486)", async () => {
    const text = await paint(latest({ lastWriteAt: new Date(NOW.getTime() - 12 * 60_000) }), 0)

    // The rail hangs across rows, so read the sentence with the box chrome
    // taken out rather than asserting on wherever this width happens to wrap.
    const rail = text.replaceAll("│", " ").replaceAll(/\s+/gu, " ")

    expect(text).toContain("silent 12:00")
    expect(rail).toContain("RUNNER SILENT — no journal write for 12:00")
    expect(rail).toContain("nothing is in line, so a change submitted now would not be picked up")
    expect(rail).toContain("is yrd-service up? (hab ps yrd-service)")
    // Never the in-line sentence, which would be a lie at zero.
    expect(rail).not.toContain("wait in line")
  })

  it("goes loud when changes wait and nothing has written past the ceiling", async () => {
    const text = await paint(latest({ lastWriteAt: new Date(NOW.getTime() - 12 * 60_000) }), 3)

    expect(text).toContain("silent 12:00")
    // The banner is pre-wrapped into rows under its marker (never a live wrap): read it row by row.
    expect(text).toContain("RUNNER SILENT — no journal write for 12:00 while 3 changes wait")
    expect(text).toContain("in line; is yrd-service up? (hab ps yrd-service)")
    expect(text).toContain("hab ps yrd-service")
  })

  it("says where the journal was looked for when there is none, never a blank", async () => {
    const text = await paint(
      { journalDir: "/w/logs", absent: "no run journal was read: /w/logs — there is no such directory" },
      2,
    )

    expect(text).toContain("$ yrd queue up")
    expect(text).toContain("/w/logs")
  })

  it("carries the pause on its own warning rail (item 27)", async () => {
    const text = await paint(latest({}), 0, "paused by @chief: the host is down")

    expect(text).toContain("⚠︎ paused by @chief: the host is down")
  })

  it("wraps a long command with a hanging indent bounded to three rows, so the rails under it survive (item 29)", async () => {
    // `underCheck` because the long `yrd queue run · <label>` rail this measures
    // only exists while processing; an idle box renders the shorter `queue up`
    // form and the wrap would not be exercised at all.
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <RunnerBox
            facts={latest({ alive: true, pid: 4242 })}
            label="a-very-long-queue-label-indeed-and-then-some-more-of-it"
            inLine={1}
            underCheck
            columns={30}
            live={false}
          />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      { cols: 32, rows: 14 },
    )
    await app.waitForLayoutStable()
    const lines = app.text.split("\n")
    const command = lines.findIndex((line) => line.includes("$ yrd"))
    expect(command).toBeGreaterThan(-1)
    // At most three rows of command, the third ending in an ellipsis, then the rails.
    expect(lines.slice(command, command + 3).join("\n")).toContain("…")
    expect(app.text).toContain("progress")
    app.unmount()
  })
})

/**
 * @failure  `yrd queue list --json` carries no way to ask whether anything is
 *           polling, so a script sees three QUEUED rows and cannot tell that
 *           nothing is working them. Measured during the 2026-09-11 outage:
 *           `queued rows: 3 | any running: False`, and a fourth seat submitted
 *           into it, because every row reads `queued` when the queue is healthy
 *           and merely busy too (@i/10-yrd/24486 row 5).
 * @level    l1 (the shaper, against constructed facts)
 * @consumer any script or seat reading `queue list --json` during an outage
 */
describe("runnerFact, the machine reader's half of the RUNNER box", () => {
  const facts = (over: Partial<NonNullable<RunnerFacts["latest"]>>): RunnerFacts => ({
    journalDir: "/w/logs",
    latest: { alive: false, id: "q-x", lastWriteAt: NOW, startedAt: NOW, ...over },
  })

  it("says a live queue is live, and shows the number silence is decided on", () => {
    const fact = runnerFact(facts({}), new Date(NOW.getTime() + 60_000), false)
    expect(fact.health).toBe("idle")
    expect(fact.latestRun?.sinceWriteMs).toBe(60_000)
    expect(fact.journalDir).toBe("/w/logs")
    expect(fact.absent).toBeUndefined()
  })

  /**
   * THE NEGATIVE CONTROL THE BEAD ASKS FOR, and it is the half that decides
   * whether this line is worth printing: a healthy queue with rows merely
   * waiting their turn must NOT be reported as having no poller. Trading a
   * silent failure for a noisy one is not an improvement.
   */
  it("a healthy queue with work waiting is NOT reported as having no poller", () => {
    const waiting = runnerFact(facts({}), new Date(NOW.getTime() + 60_000), false)
    expect(waiting.health).toBe("idle")
    const working = runnerFact(facts({}), new Date(NOW.getTime() + 60_000), true)
    expect(working.health).toBe("processing")
    for (const fact of [waiting, working]) expect(fact.health).not.toBe("silent")
  })

  it("says SILENT when the journal has stopped, whatever the rows claim", () => {
    const now = new Date(NOW.getTime() + SILENT_AFTER_MS + 1)
    expect(runnerFact(facts({ alive: true }), now, false).health).toBe("silent")
    // A service that died mid-check leaves a row still marked live; the journal
    // outranks it, in the payload exactly as in the box.
    expect(runnerFact(facts({ alive: true }), now, true).health).toBe("silent")
  })

  /**
   * Never a blank and never a zero: with no journal at all the payload says
   * ABSENT and carries the sentence naming where it looked. A reader that got
   * `health: "idle"` with no run would have been told the queue was fine.
   */
  it("carries the sentence when there is no journal here at all", () => {
    const absent: RunnerFacts = { journalDir: "/w/logs", absent: "no run journals under /w/logs" }
    const fact = runnerFact(absent, NOW, false)
    expect(fact.health).toBe("absent")
    expect(fact.absent).toBe("no run journals under /w/logs")
    expect(fact.latestRun).toBeUndefined()
  })

  it("carries the run's pid when the run still claims one", () => {
    expect(runnerFact(facts({ pid: 4242 }), NOW, false).latestRun?.pid).toBe(4242)
    expect(runnerFact(facts({}), NOW, false).latestRun?.pid).toBeUndefined()
  })

  // One derivation, two renderings: the payload must never be able to say a
  // different word from the box for the same facts.
  it("agrees with runnerHealth for every shape the box can paint", () => {
    const now = new Date(NOW.getTime() + 60_000)
    for (const alive of [true, false]) {
      for (const underCheck of [true, false]) {
        const f = facts({ alive })
        expect(runnerFact(f, now, underCheck).health).toBe(runnerHealth(f, now, underCheck))
      }
    }
  })
})
