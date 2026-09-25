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
import { gracefulStopHealthDocument, QUEUE_HEALTH_DOCUMENT, QUEUE_HEALTH_SCHEMA, runId } from "@yrd/queue-core"
import { SERVICE } from "../src/queue-health.ts"
import { clock } from "../src/watch-format.ts"
import {
  readRunnerFacts,
  readRunnerService,
  runnerLine,
  runnerWord,
  type RunnerFacts,
  type RunnerService,
} from "../src/watch-runner.ts"

const NOW = new Date("2026-09-03T12:00:00.000Z")

/** A believable health document, as `writtenHealthDocument` shapes one: its writer declares its own deadline. */
const BEATING: RunnerService = { kind: "beating", state: "healthy", since: NOW }

/**
 * What the service's own health document says, as the loop writes it.
 *
 * `staleAfter` is the WRITER's declaration (one heartbeat plus grace from the
 * write), never a threshold this test picks: these fixtures move that instant
 * around the reading instant, which is the only thing freshness turns on.
 */
function healthDocument(
  options: Readonly<{
    staleAfterMs: number
    pid?: number
    flow?: Readonly<Record<string, unknown>>
    readFailure?: unknown
  }>,
): string {
  return JSON.stringify({
    schema: QUEUE_HEALTH_SCHEMA,
    service: "yrd",
    state: "healthy",
    verdict: { kind: "running" },
    facts: {
      writtenAt: new Date(NOW.getTime() - 60_000).toISOString(),
      staleAfter: new Date(NOW.getTime() + options.staleAfterMs).toISOString(),
      runner: { pid: options.pid ?? process.pid, startedAt: NOW.toISOString(), command: "yrd queue up" },
      ...(options.flow === undefined ? {} : { flow: options.flow }),
      ...(options.readFailure === undefined ? {} : { roundReadFailure: options.readFailure }),
    },
  })
}

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
    /** The service's health document, when the workdir has one. */
    health?: string
  }>,
): string {
  const workdir = mkdtempSync(join(tmpdir(), "yrd-watch-runner-"))
  if (options.health !== undefined) writeFileSync(join(workdir, QUEUE_HEALTH_DOCUMENT), options.health)
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
  it("says where it looked when there is no journal directory, and when the directory holds no run", async () => {
    const empty = mkdtempSync(join(tmpdir(), "yrd-watch-runner-"))
    expect((await readRunnerFacts(empty)).absent).toContain("there is no such directory")
    mkdirSync(join(empty, "logs"))
    expect((await readRunnerFacts(empty)).absent).toContain("holds no run journal")
  })

  it.each([false, true])(
    "reads the newest run, including its header after Git evidence: prefix=%s",
    async (gitBeforeHeader) => {
      const facts = await readRunnerFacts(
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

  it("reads a dead pid as not alive", async () => {
    // 2147483647 is the largest pid Linux can hand out and is not ours.
    const dead = await readRunnerFacts(workdirWith({ ageMs: 60_000, pid: 2_147_483_647 }))
    expect(dead.latest?.alive).toBe(false)
  })

  it.each([
    ["invalid JSON", "not a record\n"],
    ["an empty record", "\n"],
    ["the wrong record kind", `${JSON.stringify({ kind: "message" })}\n`],
    ["an incomplete Git record", `${JSON.stringify({ kind: "git" })}\n`],
  ])("refuses a required run journal with %s", async (_case, header) => {
    const workdir = workdirWith({ ageMs: 60_000, header })
    await expect(readRunnerFacts(workdir)).rejects.toThrow(/run journal .* (record|header)/u)
  })

  it("refuses a newest run journal that cannot be read", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-watch-runner-"))
    const logs = join(workdir, "logs")
    mkdirSync(logs)
    const path = join(logs, `${runId(new Date(NOW.getTime() - 60_000))}.jsonl`)
    mkdirSync(path)

    await expect(readRunnerFacts(workdir)).rejects.toThrow(`run journal ${path}`)
  })

  /**
   * @failure A close verb read the NEWEST journal while its run was still
   *          executing, before the run header had been appended, and reported
   *          "required run header was not found" — a live run reading as a
   *          malformed one (24478). Since 24470 the header comes FIRST and a
   *          new run cannot reach this state, but a journal written before that
   *          landed still can, so the tolerance stays and keeps its own proof.
   */
  it("reads a live run that has not reached its header yet as in progress, not malformed", async () => {
    const facts = await readRunnerFacts(
      workdirWith({ ageMs: 1_000, gitBeforeHeader: true, header: "", pid: process.pid }),
    )
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
  it("names a run that died in its Git preamble UNSTARTED, not malformed", async () => {
    const facts = await readRunnerFacts(workdirWith({ ageMs: 1_000, gitBeforeHeader: true, header: "" }))
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
  it("names a headed run that never resolved its queue UNSTARTED too", async () => {
    const header = `${JSON.stringify({ at: NOW.toISOString(), checks: ["typecheck"], gitlink: "3c285a41af46".padEnd(40, "0"), kind: "run", run: "q-test", target: "main" })}\n`
    const facts = await readRunnerFacts(workdirWith({ ageMs: 1_000, header }))
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
  it("reads liveness from the header's pid while no worktree has been claimed", async () => {
    const header = `${JSON.stringify({ at: NOW.toISOString(), kind: "run", pid: process.pid, run: "q-test", target: "main" })}\n`
    const facts = await readRunnerFacts(workdirWith({ ageMs: 1_000, header }))
    expect(facts.latest?.alive).toBe(true)
    expect(facts.latest?.pid).toBe(process.pid)
    // Mid-preamble, so no queue yet — and emphatically not a dead run.
    expect(facts.latest?.queue).toBeUndefined()
    expect(facts.latest?.unstarted).toBeUndefined()
    expect(runnerLine(facts, NOW).detail).not.toContain("died in its Git preamble")
  })

  // The control: a run whose queue record IS there is an ordinary run, and the
  // legacy header that carries `queue` on itself is one too.
  it("reads a resolved queue from the queue record, and from a legacy header", async () => {
    const id = "q-test"
    const header =
      `${JSON.stringify({ at: NOW.toISOString(), checks: ["typecheck"], gitlink: "3c285a41af46".padEnd(40, "0"), kind: "run", run: id, target: "main" })}\n` +
      `${JSON.stringify({ at: NOW.toISOString(), kind: "queue", queue: "main on origin", run: id })}\n`
    const resolved = await readRunnerFacts(workdirWith({ ageMs: 1_000, header }))
    expect(resolved.latest?.unstarted).toBeUndefined()
    expect(resolved.latest?.queue).toBe("main on origin")
    const legacy = await readRunnerFacts(workdirWith({ ageMs: 1_000, gitBeforeHeader: true }))
    expect(legacy.latest?.unstarted).toBeUndefined()
    expect(legacy.latest?.queue).toBe("main")
  })

  it("refuses malformed and unreadable run pid files instead of calling the runner idle", async () => {
    const malformed = workdirWith({ ageMs: 60_000, pidText: "42junk\n" })
    await expect(readRunnerFacts(malformed)).rejects.toThrow(/run pid file .* positive safe integer/u)

    const unreadable = workdirWith({ ageMs: 60_000, pidDirectory: true })
    await expect(readRunnerFacts(unreadable)).rejects.toThrow(/run pid file .* cannot be read/u)
  })
})

/**
 * @failure  THE INSTRUMENT ITSELF. Every word below rests on this reading, so
 *           four fixtures with four different cures are read from real files
 *           rather than from a hand-built fact: a fixture-only proof would pass
 *           against a reader that opens nothing.
 * @level    l1 (a real health document in a real workdir)
 */
describe("readRunnerService, the loop's own liveness", () => {
  it("reads a document believable by its OWN deadline as beating", async () => {
    const workdir = workdirWith({ ageMs: 1_000, health: healthDocument({ staleAfterMs: 5 * 60_000 }) })
    expect(await readRunnerService(workdir, NOW)).toEqual(BEATING)
  })

  it("names a malformed remote-read fact instead of hiding the round failure", async () => {
    const workdir = workdirWith({
      ageMs: 1_000,
      health: healthDocument({ staleAfterMs: 5 * 60_000, readFailure: { ref: "refs/yrd/main/changes/task/a" } }),
    })
    expect(await readRunnerService(workdir, NOW)).toEqual({
      kind: "unreadable",
      why: `health document in ${workdir} has malformed facts.roundReadFailure`,
    })
  })

  /**
   * The deadline is the WRITER's, applied by `believableHealthDocument`: past
   * it, the stored verdict is a measurement nobody took. Nothing here picks a
   * threshold, and this fixture proves that by moving only that one instant.
   */
  it("reads a document past that deadline as stopped, and carries the document's own cause", async () => {
    const workdir = workdirWith({ ageMs: 1_000, health: healthDocument({ staleAfterMs: -60_000 }) })
    const service = await readRunnerService(workdir, NOW)

    expect(service.kind).toBe("stopped")
    if (service.kind !== "stopped") throw new Error("not stopped")
    // 25430 witness: a SIGKILL leaves the last heartbeat document, with no
    // graceful stop in it, and it ages into this — never an invented reason.
    expect(service.why).toBe(
      `stopped outside a graceful stop since ${new Date(NOW.getTime() - 60_000).toISOString()}; ` +
        `hab ps ${SERVICE} has the supervisor's record`,
    )
    expect(service.graceful, "a stop outside a graceful stop, so the watch shows this sentence").toBe(false)
    expect(service.cause).toContain("no longer a measurement of anything")
    expect(service.since?.getTime()).toBe(NOW.getTime() - 60_000)
  })

  /**
   * A document outlives its writer by up to one heartbeat plus grace, so a
   * believable document alone does not prove a process. `facts.runner.pid` is
   * what closes that window — @cto's "no runner process", read from the loop's
   * own declaration of who is writing.
   */
  it("reads a believable document whose writer does not answer as stopped", async () => {
    const workdir = workdirWith({
      ageMs: 1_000,
      health: healthDocument({ pid: 2_147_483_647, staleAfterMs: 5 * 60_000 }),
    })
    const service = await readRunnerService(workdir, NOW)

    expect(service.kind).toBe("stopped")
    if (service.kind !== "stopped") throw new Error("not stopped")
    expect(service.cause).toContain("process 2147483647")
    expect(service.why).toContain("stopped outside a graceful stop")
    expect(service.since).toBeUndefined()
  })

  it("reads a graceful stop's last document as who stopped the service and why (25430)", async () => {
    const since = new Date(NOW.getTime() - 30_000).toISOString()
    const stopped = gracefulStopHealthDocument(SERVICE, { by: "@chief", reason: "cutover", since })
    const service = await readRunnerService(
      workdirWith({ ageMs: 1_000, health: JSON.stringify(stopped) }),
      new Date(NOW.getTime() + 24 * 60 * 60_000),
    )

    // No deadline on the last document, so a day later it still says why.
    const at = clock(new Date(since))
    expect(service).toMatchObject({
      kind: "stopped",
      graceful: true,
      why: `stopped by @chief since ${at}: cutover`,
      stopReason: "cutover",
    })
    if (service.kind !== "stopped") throw new Error("not stopped")
    expect(service.since?.toISOString()).toBe(since)

    const unexplained = gracefulStopHealthDocument(SERVICE, { since })
    const unexplainedService = await readRunnerService(
      workdirWith({ ageMs: 1_000, health: JSON.stringify(unexplained) }),
      NOW,
    )
    expect(unexplainedService).toMatchObject({
      kind: "stopped",
      why: `stopped since ${at}: no stop reason was recorded`,
    })
    expect(unexplainedService).not.toHaveProperty("stopReason")
  })

  it("keeps no document and an unreadable one apart: two facts with two cures", async () => {
    const none = await readRunnerService(workdirWith({ ageMs: 1_000 }), NOW)
    expect(none.kind).toBe("absent")
    if (none.kind !== "absent") throw new Error("not absent")
    expect(none.why).toContain("no health document at")

    const garbage = await readRunnerService(workdirWith({ ageMs: 1_000, health: "not a document\n" }), NOW)
    expect(garbage.kind).toBe("unreadable")
    if (garbage.kind !== "unreadable") throw new Error("not unreadable")
    expect(garbage.why).toContain(QUEUE_HEALTH_DOCUMENT)
  })
})

describe("runnerWord, the one word", () => {
  const facts = (over: Partial<NonNullable<RunnerFacts["latest"]>>, service: RunnerService = BEATING): RunnerFacts => ({
    journalDir: "/w/logs",
    service,
    latest: { alive: false, id: "q-x", lastWriteAt: NOW, startedAt: NOW, ...over },
  })
  const STOPPED: RunnerService = {
    cause: "the service last wrote this document at 11:59 and declared it believable until 12:00",
    kind: "stopped",
    graceful: false,
    why: "the service stopped restating its health document",
    since: new Date(NOW.getTime() - 60_000),
  }
  const STUCK = {
    by: "yrd",
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
  it("is `?` with nothing local to read at all: no document and no journal", () => {
    const off: RunnerFacts = { journalDir: "/w/logs", absent: "none", service: { kind: "absent", why: "none" } }
    expect(runnerWord(off, false)).toBe("unpublished")
    expect(runnerWord(undefined, false)).toBe("unpublished")
  })

  /**
   * A stop record is a GIT fact and reads from any clone, so it outranks a
   * missing journal: a clone with nothing local to read still knows the line is
   * stopped, and printing `?` over a standing stop would hide the one thing an
   * operator most needs to see.
   */
  it("says paused and stuck off the queue's machine, where there is no journal to read", () => {
    expect(runnerWord(undefined, true, PAUSED)).toBe("paused")
    expect(runnerWord(undefined, false, STUCK)).toBe("stuck")
  })

  /**
   * @failure  24486, and it is the reason this ladder exists: measured
   *           2026-09-11 during an outage, three rows sat queued with no live
   *           check on any of them while the service was down, and a fourth
   *           seat submitted into it, because every row read like a healthy
   *           queue that was merely busy. A DEAD QUEUE MUST NEVER READ IDLE.
   * @level    l1
   */
  it("is STOPPED, never idle, when the service's own document is past its deadline (24486)", () => {
    expect(runnerWord(facts({ alive: false }, STOPPED), false)).toBe("stopped")
    // And a row still marked live over a dead document is the residue of a
    // death, not a check in progress: `bandOf` sends that row back to waiting
    // and this row says why. It is emphatically not `checking`.
    expect(runnerWord(facts({ alive: true }, STOPPED), true)).toBe("stopped")
  })

  /**
   * @failure  THE ARM THAT MOTIVATED THE RULING. A reading that derived death
   *           from a quiet journal printed a red `stopped` over every check that
   *           ran longer than its threshold — a check writes nothing to its
   *           journal until it ends, so a thirty-minute check looked exactly
   *           like a dead service. The heartbeat keeps firing DURING a check
   *           (queue-core-commands `beat`), which is what tells them apart.
   * @level    l1
   */
  it("is CHECKING over a thirty-minute-old journal while the document is fresh, never stopped", () => {
    const quiet = facts({ alive: true, lastWriteAt: new Date(NOW.getTime() - 30 * 60_000) })

    expect(runnerWord(quiet, true)).toBe("checking")
    expect(runnerWord(quiet, true)).not.toBe("stopped")
  })

  /**
   * The hand-runner edge (@i/4-supervision/24523 C5): `yrd queue run` writes no
   * health document at all, so the only local liveness fact is the run's own
   * pid. It is the LAST rung, not the first, and it never runs while a document
   * is readable.
   */
  it("falls back to the run's own pid only when there is no document: a dead run under a live check is stopped", () => {
    const hand: RunnerService = { kind: "absent", why: "no health document at /w/service-health.json" }
    expect(runnerWord(facts({ alive: false }, hand), true)).toBe("stopped")
    expect(runnerWord(facts({ alive: true }, hand), true)).toBe("checking")
    expect(runnerWord(facts({ alive: false }, hand), false)).toBe("idle")
  })

  /**
   * A file that is there and is not a document is a defect in the WRITER, and
   * says nothing whatever about the process. Reading `stopped` from it would
   * page an operator about a parse error; it decides no word, and the row's
   * second line carries it instead.
   */
  it("derives no word from an unreadable document, and does not call it stopped", () => {
    const garbled: RunnerService = { kind: "unreadable", why: "the health document at /w/x is not a document" }
    expect(runnerWord(facts({ alive: true }, garbled), false)).toBe("idle")
    expect(runnerWord(facts({ alive: true }, garbled), false)).not.toBe("stopped")
    expect(runnerLine(facts({ alive: true }, garbled), NOW).detail).toContain("is not a document")
  })

  /**
   * @failure THE GAP THIS TEST EXISTS TO KEEP VISIBLE, not one it closes.
   *
   *          A journal that has not moved for hours reads `idle` while the
   *          service's document is believable, exactly as one written a second
   *          ago does. That is RULED (@cto, relayed by @chief): no word is
   *          derived from a run journal's mtime, and the reading this replaces
   *          called a healthy queue between rounds dead and a dead queue alive
   *          by turns.
   *
   *          What S1 still cannot say is `silent` — the runner's own beat,
   *          published at `refs/yrd/<queue>/runner` from S2 and readable from
   *          any clone. The health document is a FILE on the queue's own
   *          machine, so off that machine this page still reads `?` rather than
   *          a liveness word. 24486's on-host half is closed by the arm above;
   *          its off-host half waits for S2.
   *
   *          So this arm pins the absence deliberately. Anyone restoring an
   *          mtime-derived silence will fail here and read this first.
   * @level   l1
   */
  it("never infers silence from a journal's age: a stale journal under a beating document reads idle", () => {
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
  const latest = (
    over: Partial<NonNullable<RunnerFacts["latest"]>>,
    service: RunnerService = BEATING,
  ): RunnerFacts => ({
    journalDir: "/w/logs",
    service,
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
  const STOPPED_SERVICE: RunnerService = {
    cause:
      "the service last wrote this document at 2026-09-03T11:54:00.000Z and declared it believable until " +
      "2026-09-03T11:55:00.000Z; nothing has been written since, so its last verdict (healthy) is no longer " +
      "a measurement of anything",
    kind: "stopped",
    graceful: false,
    since: new Date(NOW.getTime() - 5 * 60_000),
    why: "the service stopped restating its health document",
  }
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
      {
        journalDir: "/w/logs",
        absent: "no run journal was read: /w/logs — there is no such directory",
        service: { kind: "absent", why: "no health document at /w/service-health.json" },
      },
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
      stopped: { by: "yrd", cause: "stuck", change: `task/s@${"4".repeat(40)}`, since: since.toISOString() },
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

  /**
   * The stopped row hands back a command that clears it, and the document's own
   * typed cause — the sentence its writer wrote about itself — rather than a
   * summary this file would have to keep in step with the writer.
   */
  it("says how long the service has been overdue, why, and the one command that starts it", () => {
    const line = runnerLine(latest({}, STOPPED_SERVICE), NOW, { waiting: 3 })

    expect(line.state).toBe("stopped")
    expect(line.duration).toBe("stopped 5:00")
    expect(line.holds).toBe(" · start: yrd queue up")
    expect(line.detail).toContain("no longer a measurement of anything")
    // The journal's own facts are not lost behind the document's.
    expect(line.detail).toContain("beat 0:02 ago")
  })

  /**
   * On the hand-runner edge there is no document, so there is no overdue
   * interval to report and none is invented: the row says what it does know,
   * which is that the check it is holding has no process behind it.
   */
  it("says a dead run under a live check with no document at all, without inventing a duration", () => {
    const hand: RunnerService = { kind: "absent", why: "no health document at /w/service-health.json" }
    const line = runnerLine(latest({ alive: false }, hand), NOW, { held })

    expect(line.state).toBe("stopped")
    expect(line.duration).toBeUndefined()
    expect(line.holds).toBe(" · start: yrd queue up")
    expect(line.detail).toContain("no process: beat 0:02 ago")
  })

  describe("active round steps and effective checks (25364)", () => {
    it("reads active steps and effective checks from journal records", async () => {
      const workdir = mkdtempSync(join(tmpdir(), "yrd-watch-active-step-"))
      const logs = join(workdir, "logs")
      mkdirSync(logs, { recursive: true })
      const id = runId(new Date(NOW.getTime() - 60_000))
      const path = join(logs, `${id}.jsonl`)
      const header = {
        at: NOW.toISOString(),
        checks: ["typecheck", "manifest-co-change", "affected-tests"],
        effectiveChecks: ["typecheck", "off", "off"],
        config: "b9a2fe721c65",
        gitlink: "3c285a41af46".padEnd(40, "0"),
        kind: "run",
        queue: "main",
        run: id,
        target: "main",
      }
      const step1 = {
        at: new Date(NOW.getTime() - 50_000).toISOString(),
        branch: "task/feat",
        head: "abcdef0123456789abcdef0123456789abcdef01",
        kind: "step",
        name: "worktree",
        phase: "submit",
        run: id,
        start: new Date(NOW.getTime() - 50_000).toISOString(),
      }
      writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(step1)}\n`)
      mkdirSync(join(workdir, "worktrees", id), { recursive: true })
      writeFileSync(join(workdir, "worktrees", id, ".pid"), `${String(process.pid)}\n`)

      const facts = await readRunnerFacts(workdir)
      expect(facts.latest?.effectiveChecks).toEqual(["typecheck", "off", "off"])
      expect(facts.latest?.activeStep).toEqual({
        branch: "task/feat",
        head: "abcdef0123456789abcdef0123456789abcdef01",
        kind: "step",
        name: "worktree",
        phase: "submit",
        start: new Date(NOW.getTime() - 50_000),
      })

      const line = runnerLine(facts, NOW, { waiting: 5 })
      expect(line.state).toBe("provisioning")
      expect(line.holds).toBe("judging task/feat@abcdef012345: compose")
      expect(line.duration).toBe("provisioning 0:50")
      expect(line.detail).toContain("typecheck, off, off")
    })

    it("formats checking phase check with subphase", () => {
      const factsWithCheck = (check: NonNullable<NonNullable<RunnerFacts["latest"]>["activeStep"]>): RunnerFacts => ({
        journalDir: "/w/logs",
        service: BEATING,
        latest: {
          activeStep: check,
          alive: true,
          effectiveChecks: ["vitest", "typecheck"],
          id: "q-check",
          lastWriteAt: NOW,
          startedAt: NOW,
        },
      })

      const checkStep = factsWithCheck({
        branch: "task/check",
        head: "abcdef0123456789abcdef0123456789abcdef01",
        kind: "check",
        name: "vitest",
        phase: "submit",
        start: new Date(NOW.getTime() - 25_000),
      })
      const checkLine = runnerLine(checkStep, NOW, {})
      expect(checkLine.state).toBe("checking")
      expect(checkLine.subphase).toBe("vitest")
      expect(checkLine.duration).toBe("checking 0:25")
    })

    it("formats merge phase steps (merge, publish, push)", () => {
      const factsWithStep = (step: NonNullable<NonNullable<RunnerFacts["latest"]>["activeStep"]>): RunnerFacts => ({
        journalDir: "/w/logs",
        service: BEATING,
        latest: {
          activeStep: step,
          alive: true,
          effectiveChecks: ["off", "off", "off"],
          id: "q-test",
          lastWriteAt: NOW,
          startedAt: NOW,
        },
      })

      const mergeStep = factsWithStep({
        branch: "task/land",
        head: "1111222233334444555566667777888899990000",
        kind: "step",
        name: "merge",
        phase: "merge",
        start: new Date(NOW.getTime() - 15_000),
      })
      const mergeLine = runnerLine(mergeStep, NOW, {})
      expect(mergeLine.state).toBe("merging")
      expect(mergeLine.step).toBe("merge")
      expect(mergeLine.holds).toBe("merging task/land@111122223333: merge")
      expect(mergeLine.duration).toBe("merging 0:15")
      expect(mergeLine.detail).toContain("off, off, off")

      const publishStep = factsWithStep({
        branch: "task/land",
        head: "1111222233334444555566667777888899990000",
        kind: "step",
        name: "publish",
        phase: "merge",
        start: new Date(NOW.getTime() - 5_000),
      })
      const publishLine = runnerLine(publishStep, NOW, {})
      expect(publishLine.state).toBe("merging")
      expect(publishLine.step).toBe("publish")
      expect(publishLine.holds).toBe("merging task/land@111122223333: publish")
      expect(publishLine.duration).toBe("merging 0:05")

      const readStep = factsWithStep({
        kind: "step",
        name: "read",
        phase: "run",
        start: new Date(NOW.getTime() - 2_000),
      })
      const readLine = runnerLine(readStep, NOW, {})
      expect(readLine.state).toBe("provisioning")
      expect(readLine.holds).toBe("between entries: re-reading main")
      expect(readLine.duration).toBe("provisioning 0:02")
    })

    it("formats runner line when round lock is held between rounds (never warning, 25630)", () => {
      const idleWithLock: RunnerFacts = {
        journalDir: "/w/logs",
        service: BEATING,
        roundLockHolder: {
          command: "bun yrd queue up",
          pid: 99999,
          since: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
        },
        latest: {
          alive: true,
          id: "q-idle",
          lastWriteAt: NOW,
          startedAt: NOW,
        },
      }
      const line = runnerLine(idleWithLock, NOW, { waiting: 3 })
      expect(line.state).toBe("provisioning")
      expect(line.duration).toBe("provisioning 10:00")
      expect(line.holds).toBe(`runner since ${clock(NOW)} · provisioning 10:00`)
    })
  })
})

// 25669 row 2: past the round budget with no change judged, the runner's line
// says so, from the service's own flow fact; and the stall once it pages.
describe("the line's flow on the runner's row (25669)", () => {
  const minutes = (n: number) => n * 60_000
  const flow = { slow: true, stallAfterMs: minutes(45), unjudgedForMs: minutes(12), waiting: 11 }

  it("reads the flow the service's document states, and nothing when an older writer states none", async () => {
    const stated = workdirWith({ ageMs: 1_000, health: healthDocument({ flow, staleAfterMs: 5 * 60_000 }) })
    expect(await readRunnerService(stated, NOW)).toEqual({ ...BEATING, flow })
    const older = workdirWith({ ageMs: 1_000, health: healthDocument({ staleAfterMs: 5 * 60_000 }) })
    expect(await readRunnerService(older, NOW)).toEqual(BEATING)
  })

  const facts = (service: RunnerService): RunnerFacts => ({ journalDir: "/w/logs", service })

  it("says no change judged, and how many waited, once the round budget has passed", () => {
    const line = runnerLine(facts({ ...BEATING, flow }), NOW, { waiting: 11 })
    expect(line.holds).toBe("nothing under a check, and 11 in line · no change judged for 12:00 while 11 waited")
  })

  it("says nothing extra inside the round budget", () => {
    const line = runnerLine(facts({ ...BEATING, flow: { ...flow, slow: false, unjudgedForMs: minutes(8) } }), NOW, {
      waiting: 11,
    })
    expect(line.holds).toBe("nothing under a check, and 11 in line")
  })

  it("says stalled, with the threshold, once the service pages the line", () => {
    const stalled = { ...flow, stalledForMs: minutes(47), unjudgedForMs: minutes(47) }
    const line = runnerLine(facts({ ...BEATING, flow: stalled, state: "unhealthy" }), NOW, { waiting: 11 })
    expect(line.holds).toContain("stalled 47:00: no change judged while 11 waited (threshold 45:00)")
  })
})
