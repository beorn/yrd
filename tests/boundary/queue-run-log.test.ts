/**
 * @failure A queue run's log is prose in the plan and nothing in the code, so
 *          what a queue run did is readable only by reading four WARN rows on
 *          stderr and guessing. Nothing pins the fact stream, so the rebuild at
 *          M4 could ship any shape, or none, and every existing test would
 *          still pass.
 * @level   l3
 * @consumer the mechanic reading a garage queue run · `queue list`'s log path ·
 *           any later reader of what one round did
 *
 * Black box, on the M1 harness: a real repository, a fake check whose result
 * the test picks, one `yrd queue run --once`. This file adds exactly one
 * observable to that boundary — the queue run's own log — and reads nothing
 * else about the queue's insides.
 *
 * WHERE THE LOG IS. The queue run names its log itself and reports the path as
 * the `log` field of its `--json` result. No new environment variable and no
 * new flag: `queue list` has to print a log path per change anyway, so the
 * queue run must own the naming, and one field on the object it already prints
 * is the whole mechanism. `logOfQueueRun` below is the single place that reads
 * it, so naming it some other way costs one edit here.
 *
 * THE FIELDS. Every record is one JSON object on one line. `kind` says which
 * fact it is; `run` is the queue run every record belongs to. Six kinds:
 *
 *   kind       fields beyond `kind` and `run`
 *   ────────   ──────────────────────────────────────────────────────────────
 *   run        pin      the yrd pin the queue run ran, a sha
 *              config   the target's check config, a blob sha
 *              target   the branch this queue is for
 *              at       when the queue run started, ISO 8601
 *   change     branch   the branch, which is the change's name
 *              head     the sha it is a branch at
 *              decision what this queue run did with it: checked, merged,
 *                       failed, stuck or waiting
 *   check      name     the check's key in the target's config
 *              branch, head   whose worktree it ran in
 *              start, end     ISO 8601
 *              ms       how long it took
 *              log      the file holding the check's own output
 *   result     branch, head, name
 *              result   pass, fail or stuck
 *              worktree the check's results in the change's worktree, in order
 *              target   the same check's result at the target, or null when it
 *                       was not run there
 *              whose    submitter or queue — who the result is billed to
 *   merge      branch, head
 *              commit   the merge commit
 *              tip      the target's new tip
 *   message    to       the recipient
 *              about    the branch it is about
 *              says     merged, fail or stuck
 *
 * `worktree`, `target` and `whose` on a result are the inputs the attribution
 * rule used and the answer it reached; a passing result carries the result and
 * needs no inputs, so only the stuck case below reads them.
 */
import { readdir, readFile } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  boundaryRepository,
  type QueueRunResult,
  queueRunOnce,
  removeScratchRoots,
  submitOneCommit,
} from "./fixture.ts"

afterEach(removeScratchRoots)

/** One record of the queue run's log. */
type LogRecord = Readonly<Record<string, unknown>> & { kind: unknown }

/**
 * The queue run's log, as it named it. The ONE place that knows how a queue run
 * says where its log went: change this function and every case below follows.
 */
async function logOfQueueRun(run: QueueRunResult): Promise<{ path: string; records: readonly LogRecord[] }> {
  let reported: unknown
  try {
    reported = (JSON.parse(run.stdout) as { log?: unknown }).log
  } catch {
    throw new Error(`the queue run's --json result did not parse, so it named no log\n${run.report}`)
  }
  if (typeof reported !== "string" || reported === "") {
    throw new Error(`the queue run named no log: its --json result has no 'log' field\n${run.report}`)
  }
  const text = await readFile(reported, "utf8")
  const records = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error(`line ${String(index + 1)} of ${reported} is not JSON: ${line}`)
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`line ${String(index + 1)} of ${reported} is not a JSON object: ${line}`)
      }
      return parsed as LogRecord
    })
  return { path: reported, records }
}

/** Every record of one kind. */
function ofKind(records: readonly LogRecord[], kind: string): readonly LogRecord[] {
  return records.filter((record) => record.kind === kind)
}

/** Exactly one record of that kind, or a failure naming what was there. */
function theOne(records: readonly LogRecord[], kind: string): LogRecord {
  const matching = ofKind(records, kind)
  if (matching.length !== 1) {
    const kinds = records.map((record) => String(record.kind)).join(", ")
    throw new Error(`expected exactly one '${kind}' record, found ${String(matching.length)} among: ${kinds}`)
  }
  return matching[0] as LogRecord
}

/** Every stderr row loggily prints at WARN or above. */
function warningRows(stderr: string): readonly string[] {
  return stderr.split("\n").filter((row) => /\b(WARN|ERROR|FATAL)\b/.test(row))
}

describe("the queue run's log", { timeout: 120_000 }, () => {
  /**
   * One file, JSONL, at a path the queue run itself names.
   */
  it("is one JSONL file the queue run names, every line a JSON object with a kind", async () => {
    const { repo } = await boundaryRepository({ exit: 0, notify: true })
    await submitOneCommit(repo, "green")

    const run = await queueRunOnce(repo)
    const { path, records } = await logOfQueueRun(run)

    // Exactly one, so the queue run's account of itself is in one place and a
    // reader is never asked which file was the real one.
    const alongside = (await readdir(dirname(path))).filter((entry) => entry.endsWith(".jsonl"))
    expect(alongside, run.report).toHaveLength(1)

    expect(records.length, run.report).toBeGreaterThan(0)
    for (const record of records) expect(typeof record.kind, run.report).toBe("string")
    // One queue run, so one id across every record.
    expect(new Set(records.map((record) => record.run)).size, run.report).toBe(1)
  })

  /**
   * The six kinds, on a queue run that exercises all of them: a change is seen,
   * a check runs, a result is reached, the change merges, and the submitter is
   * told.
   */
  it("names the six kinds when one change is checked and merged", async () => {
    const { repo } = await boundaryRepository({ exit: 0, notify: true })
    const { branch, headSha } = await submitOneCommit(repo, "green")

    const run = await queueRunOnce(repo)
    const { records } = await logOfQueueRun(run)

    // run — once, naming what the queue run judged from.
    const opened = theOne(records, "run")
    expect(opened.pin, run.report).toEqual(expect.any(String))
    expect(opened.config, run.report).toEqual(expect.any(String))
    expect(opened.target, run.report).toBe("main")
    expect(opened.at, run.report).toEqual(expect.any(String))

    // change — one per change seen, with what the queue run did with it.
    const changes = ofKind(records, "change")
    expect(changes, run.report).toHaveLength(1)
    expect(changes[0]?.branch, run.report).toBe(branch)
    expect(changes[0]?.head, run.report).toBe(headSha)
    expect(changes[0]?.decision, run.report).toBe("merged")

    // check — start, end, duration and the check's own log.
    const checks = ofKind(records, "check")
    expect(checks.length, run.report).toBeGreaterThanOrEqual(1)
    for (const check of checks) {
      expect(check.name, run.report).toEqual(expect.any(String))
      expect(check.branch, run.report).toBe(branch)
      expect(check.head, run.report).toBe(headSha)
      expect(check.start, run.report).toEqual(expect.any(String))
      expect(check.end, run.report).toEqual(expect.any(String))
      expect(typeof check.ms, run.report).toBe("number")
      expect(check.log, run.report).toEqual(expect.any(String))
    }

    // result — how it ended, and against which check.
    const results = ofKind(records, "result")
    expect(results.length, run.report).toBeGreaterThanOrEqual(1)
    for (const result of results) {
      expect(["pass", "fail", "stuck"], run.report).toContain(result.result)
      expect(result.branch, run.report).toBe(branch)
      expect(result.head, run.report).toBe(headSha)
    }
    expect(results.some((result) => result.result === "pass"), run.report).toBe(true)

    // merge — the merge commit and the tip it put on the target.
    const merged = theOne(records, "merge")
    expect(merged.branch, run.report).toBe(branch)
    expect(merged.head, run.report).toBe(headSha)
    expect(merged.commit, run.report).toEqual(expect.any(String))
    expect(merged.tip, run.report).toEqual(expect.any(String))

    // message — one, to the submitter, saying the change merged.
    const message = theOne(records, "message")
    expect(message.to, run.report).toEqual(expect.any(String))
    expect(message.about, run.report).toBe(branch)
    expect(message.says, run.report).toBe("merged")
  })

  /**
   * BOTH PASS TODAY, and are here to keep passing. M2 owes zero standing
   * warnings, and on the two paths that are the ordinary course it already has
   * them: measured 2026-09-02, an idle queue run prints no WARN row and a
   * merging one prints no WARN row. The single warning a merging queue run used
   * to print was `notify-unconfigured` — the target declaring no notifier, the
   * fixture's own gap, never a defect in the queue. Pinned so the rewrite
   * cannot quietly spend what is already earned.
   *
   * The abnormal paths are NOT pinned here, and deliberately: a queue run that
   * ends fail or stuck prints three WARN rows each today. Whether M2's zero
   * standing warnings reaches those is @cto's call, not this file's.
   */
  describe("says nothing at WARN or above", () => {
    it("with nothing submitted", async () => {
      const { repo } = await boundaryRepository({ exit: 0, notify: true })

      const run = await queueRunOnce(repo)

      expect(run.exitCode, run.report).toBe(0)
      expect(warningRows(run.stderr), run.report).toEqual([])
    })

    it("with one change checked and merged", async () => {
      const { repo } = await boundaryRepository({ exit: 0, notify: true })
      await submitOneCommit(repo, "green")

      const run = await queueRunOnce(repo)

      expect(run.exitCode, run.report).toBe(0)
      expect(warningRows(run.stderr), run.report).toEqual([])
    })
  })

  /**
   * The `run` record's two facts are read from the TARGET at the queue run's
   * start, not from a run it may never build.
   *
   * A queue run that refuses its change at admission builds no run and resolves
   * no step selection, so both facts were missing from exactly the queue runs a
   * reader most needs them for — every fail and every stuck (measured
   * 2026-09-02). The pair below is the proof that the derivation is the same
   * one: a merging queue run and a stuck one, on the same target, must report
   * the same base and the same config blob.
   */
  it("names the base and the check config whether or not a run was built", async () => {
    const merging = await boundaryRepository({ exit: 0, notify: true })
    await submitOneCommit(merging.repo, "green")
    const mergedRun = await queueRunOnce(merging.repo)
    const merged = theOne((await logOfQueueRun(mergedRun)).records, "run")

    // The queue run that DID build a run resolved these two itself and printed
    // them. The record must carry the same values, or the log is describing a
    // different queue run from the one that happened — which is the whole
    // reason the derivation is allowed to be independent.
    const printed = JSON.parse(mergedRun.stdout) as {
      results?: readonly { stepSelection?: { baseSha?: string; configBlobSha?: string } }[]
      base?: string
      config?: string
    }
    // The incumbent prints them on its first result's selection; the new core
    // prints them on the run itself, which has no selections to hang them on.
    const selection =
      printed.results?.[0]?.stepSelection ??
      (printed.base === undefined ? undefined : { baseSha: printed.base, configBlobSha: printed.config })
    expect(selection?.baseSha, mergedRun.report).toEqual(expect.any(String))
    expect(merged.base, mergedRun.report).toBe(selection?.baseSha)
    expect(merged.config, mergedRun.report).toBe(selection?.configBlobSha)

    // A check that gets stuck builds no run and resolves no step selection at
    // all, and both facts must still be there.
    const stuck = await boundaryRepository({ exit: 2, notify: true })
    await submitOneCommit(stuck.repo, "two")
    const stuckRun = await queueRunOnce(stuck.repo)
    expect(stuckRun.exitCode, stuckRun.report).toBe(2)
    expect(
      // The incumbent prints an empty results list; the new core builds no
      // Run records at all and prints none, which is the same fact.
      (JSON.parse(stuckRun.stdout) as { results?: readonly unknown[] }).results ?? [],
      "a stuck queue run builds no run, which is what makes this case the point",
    ).toEqual([])
    const opened = theOne((await logOfQueueRun(stuckRun)).records, "run")

    expect(opened.base, stuckRun.report).toEqual(expect.any(String))
    expect(opened.config, stuckRun.report).toEqual(expect.any(String))
  })

  /**
   * A refusal is a durable row that outlives the queue run that wrote it, so
   * the stream is filtered to this queue run by the instant it started.
   *
   * Without the filter every queue run re-reports every standing refusal, and a
   * queue run that did nothing at all reads exactly like the one that refused
   * the change yesterday. Planted here as a real earlier queue run, because a
   * hand-written row would prove only that the filter can read a timestamp.
   */
  it("reports only this queue run's refusals, not an earlier one's", async () => {
    const { repo } = await boundaryRepository({ exit: 1, notify: true })
    const { branch } = await submitOneCommit(repo, "red")

    // Queue run one: the change is refused, and the refusal row is written.
    const first = await queueRunOnce(repo)
    expect(first.exitCode, first.report).toBe(1)
    const refusedFirst = (await logOfQueueRun(first)).records.filter(
      (record) => record.kind === "change" && record.decision === "failed",
    )
    expect(refusedFirst, first.report).toHaveLength(1)
    expect(refusedFirst[0]?.branch, first.report).toBe(branch)

    // Queue run two: the standing refusal keeps the change out, so this queue
    // run refuses nothing itself. The row from queue run one is still there.
    const second = await queueRunOnce(repo)
    const { records } = await logOfQueueRun(second)

    // A different file, so the two accounts are never confused for one.
    expect((await logOfQueueRun(second)).path, second.report).not.toBe((await logOfQueueRun(first)).path)
    for (const record of records) {
      expect(
        record.kind === "result" || (record.kind === "change" && record.decision === "failed"),
        `queue run two re-reported queue run one's refusal: ${JSON.stringify(record)}\n${second.report}`,
      ).toBe(false)
    }
  })

  /**
   * The M2 row's own measure: "git chatter at trace; a real log under 200
   * lines". Read at DEBUG, because that is the level a mechanic runs a garage
   * queue run at.
   *
   * Measured before the change, on this exact case: 537 rows, 405 of them the
   * git command wrapper's finish line and span, two per invocation across ~200
   * git calls. The bound below is the plan's number, and the git assertion is
   * why the number holds — a bound alone would pass again the moment something
   * else grew to fill the space.
   */
  it("reads as the queue's own decisions at debug, not a git transcript", async () => {
    const { repo } = await boundaryRepository({ exit: 0, notify: true })
    await submitOneCommit(repo, "green")

    process.env.LOG_LEVEL = "debug"
    let run: QueueRunResult
    try {
      run = await queueRunOnce(repo)
    } finally {
      delete process.env.LOG_LEVEL
    }

    expect(run.exitCode, run.report).toBe(0)
    // A log ROW starts with a timestamp; the rest of a line is one row's
    // payload, so counting physical lines counts JSON, not log lines.
    const rows = run.stderr.split("\n").filter((row) => /^\d\d:\d\d:\d\d /u.test(row))
    // A positive control: a debug log that says nothing at all would satisfy
    // every bound below and tell a reader nothing. The new core renders exactly
    // its records, six kinds on a merging run; the incumbent narrates more.
    expect(rows.length, run.report).toBeGreaterThan(5)
    expect(rows.length, run.report).toBeLessThan(200)

    // No git invocation and no git span, at any level above trace.
    const chatter = rows.filter((row) => / git | git$|"argv":\["git"/u.test(row))
    expect(chatter, `git chatter at debug:\n${chatter.slice(0, 5).join("\n")}`).toEqual([])
  })

  describe("a queue run with nothing submitted", () => {
    /** Nothing happened, so the log says only that the queue run looked. */
    it("writes exactly the run line", async () => {
      const { repo } = await boundaryRepository({ exit: 0, notify: true })

      const run = await queueRunOnce(repo)
      const { records } = await logOfQueueRun(run)

      // An honest zero: one record, saying the queue run ran and what it read
      // the queue from. "I found nothing" and "I never looked" must not be the
      // same bytes.
      expect(records, run.report).toHaveLength(1)
      expect(records[0]?.kind, run.report).toBe("run")
    })

    /**
     * A queue run is one invocation, so it has its own log whether or not it
     * built a Run.
     *
     * Measured 2026-09-02 on pin 0749260a: two consecutive empty-queue queue
     * runs in shared main both wrote `R700.jsonl`, because the file and the
     * `run` row were named by the last Run the incumbent had minted and an
     * empty queue mints none. One file then held two `run` rows, both calling
     * themselves R700, and nothing in it said which queue run wrote which.
     */
    it("writes its own file, twice in a row", async () => {
      const { repo } = await boundaryRepository({ exit: 0, notify: true })

      const first = await logOfQueueRun(await queueRunOnce(repo))
      const second = await logOfQueueRun(await queueRunOnce(repo))

      expect(second.path).not.toBe(first.path)
      expect(second.records[0]?.run).not.toBe(first.records[0]?.run)
      // Two files, each holding exactly one account of itself.
      for (const { path, records } of [first, second]) {
        expect(ofKind(records, "run"), `two run rows in ${path}`).toHaveLength(1)
      }
    })
  })

  /**
   * The queue run names its log after ITSELF, and a Run it built is a field.
   *
   * Naming the file after the Run is what made two queue runs share one file:
   * the name was a fact about a record the invocation might never make, so
   * every queue run that built no Run reused the last name minted. The Run id
   * is still worth reading — it is what the incumbent's other instruments
   * print — so it moves onto the run row rather than being dropped.
   */
  it("names its log after the queue run, never after a Run it built", async () => {
    const { repo } = await boundaryRepository({ exit: 0, notify: true })
    await submitOneCommit(repo, "green")

    const run = await queueRunOnce(repo)
    const { path, records } = await logOfQueueRun(run)

    const built = theOne(records, "run").built
    // Nothing is minted per merge, and the record says so with an empty list
    // rather than a missing field.
    expect(built, run.report).toEqual([])
    // The file is named by the queue run's own id, and by nothing else.
    expect(basename(path), run.report).toBe(`${String(records[0]?.run)}.jsonl`)
  })

  /**
   * A completion the queue run recovered belongs to the queue run that made
   * it.
   *
   * Measured 2026-09-02: each of two empty-queue queue runs appended the same
   * seven historical change/result/merge triplets, recovered from the
   * checkpoint, so both logs claimed merges neither run made while the debug
   * log and git proved zero events. The recovery is worth one number; it is
   * not worth a merge row.
   */
  it("claims no merge it did not make", async () => {
    const { repo } = await boundaryRepository({ exit: 0, notify: true })
    const { branch } = await submitOneCommit(repo, "green")

    const merging = await queueRunOnce(repo)
    expect(ofKind((await logOfQueueRun(merging)).records, "merge"), merging.report).toHaveLength(1)

    // The queue is empty now. Whatever this queue run settles from the last
    // one, it merged nothing itself, and its log must say exactly that.
    const after = await queueRunOnce(repo)
    const { records } = await logOfQueueRun(after)

    for (const kind of ["change", "result", "merge"]) {
      expect(
        ofKind(records, kind),
        `queue run two reported queue run one's ${kind} for ${branch}\n${after.report}`,
      ).toEqual([])
    }
    const recovered = theOne(records, "run").recovered
    expect(
      recovered === undefined || typeof recovered === "number",
      `recovery is a count on the run row, not ${JSON.stringify(recovered)}\n${after.report}`,
    ).toBe(true)
  })

  /**
   * An empty-queue run's debug log is the queue's own work and nothing else.
   *
   * Measured 2026-09-02 on pin 0749260a, one empty-queue run in shared main:
   * 565 rows at debug, of which 124 debug plus 62 span were
   * `yrd:storage:lock`, 61 each of debug, info and span were
   * `yrd:storage:append`, 64 were `yrd:core:replay` spans and 63 were
   * `yrd:storage` checkpoint rows — the queue's own decisions were a
   * remainder. The store those rows narrated is deleted at M6 (there is no
   * store but git), so the case that moved them to trace went with it; what
   * stays is the bound they were measured against, and a positive control that
   * the queue still says what it did.
   */
  describe("an empty-queue run at debug", () => {
    /** Every stderr row loggily prints, one per log line. */
    const logRows = (stderr: string): readonly string[] =>
      stderr.split("\n").filter((row) => /^\d\d:\d\d:\d\d /u.test(row))

    it("says what it did, and stays well under the plan's bound", async () => {
      const { repo } = await boundaryRepository({ exit: 0, notify: true })
      process.env.LOG_LEVEL = "debug"
      let run: QueueRunResult
      try {
        run = await queueRunOnce(repo)
      } finally {
        delete process.env.LOG_LEVEL
      }
      expect(run.exitCode, run.report).toBe(0)

      const rows = logRows(run.stderr)
      // The positive control under the bound: a zero row count would satisfy
      // "under 200" while meaning the log had gone silent.
      expect(
        rows.filter((row) => /^\d\d:\d\d:\d\d [A-Z]+ yrd:queue:run\b/u.test(row)),
        run.report,
      ).toHaveLength(1)
      expect(rows.length, run.report).toBeLessThan(200)
    })
  })

  /**
   * The worktree pool's own housekeeping, and the submodule materialization it
   * delegates, are plumbing by the same rule as the storage rows above.
   *
   * Measured 2026-09-02 on pin 0749260a, one real merging queue run in shared
   * main: 464 rows at debug, of which 80 were `yrd:submodules:update` spans, 10
   * `yrd:submodules:walk` and 6 `yrd:release`. What a mechanic reads a merging
   * run for is each change and its decision, each check's start and end, the
   * merge and the message — and those are all `yrd:queue`, `yrd:jobs` and
   * `yrd:outcome` rows, which the positive control below keeps honest.
   *
   * The boundary repository has no submodules, so git-super finds no gitlinks
   * and its per-submodule `update` and `walk` spans never fire here; what this
   * proves is the SEAM — the logger the pool hands it opens no span below
   * trace, and every `yrd:submodules:*` span goes through that one logger.
   */
  describe("worktree and submodule plumbing", () => {
    const logRows = (stderr: string): readonly string[] =>
      stderr.split("\n").filter((row) => /^\d\d:\d\d:\d\d /u.test(row))

    const plumbing = (rows: readonly string[]): readonly string[] =>
      rows.filter((row) => /^\d\d:\d\d:\d\d [A-Z]+ (?:yrd:submodules\b|yrd:release\b)/u.test(row))

    const mergingAt = async (level: string): Promise<QueueRunResult> => {
      const { repo } = await boundaryRepository({ exit: 0, notify: true })
      await submitOneCommit(repo, "green")
      process.env.LOG_LEVEL = level
      try {
        return await queueRunOnce(repo)
      } finally {
        delete process.env.LOG_LEVEL
      }
    }

    it("is absent at debug and present at trace on a merging run", async () => {
      const debug = await mergingAt("debug")
      expect(debug.exitCode, debug.report).toBe(0)
      const debugRows = logRows(debug.stderr)

      // The positive control is what the plan says a merging run's debug log is
      // FOR: the queue reached a decision, ran a check and merged. Without it a
      // run that logged nothing would satisfy the zero below.
      // The new core renders its records under yrd:queue:<kind>; the incumbent
      // narrates from yrd:queue:run and yrd:jobs:*. Either way: a run, a check, a merge.
      expect(
        debugRows.some((row) => /yrd:queue:run\b/u.test(row)),
        debug.report,
      ).toBe(true)
      expect(
        debugRows.some((row) => /yrd:(jobs|queue):(check|merge)\b/u.test(row)),
        debug.report,
      ).toBe(true)
      expect(
        plumbing(debugRows),
        `worktree and submodule plumbing at debug:\n${plumbing(debugRows).slice(0, 5).join("\n")}`,
      ).toEqual([])

      const trace = await mergingAt("trace")
      expect(trace.exitCode, trace.report).toBe(0)
      expect(plumbing(logRows(trace.stderr)).length, trace.report).toBeGreaterThan(0)
    })
  })

  /**
   * Stuck is the queue's own fault, so the log says so and the submitter hears
   * nothing: the two messages a submitter gets are `merged` and `fail`, and
   * neither may be sent for a queue run that could not do its job.
   *
   * The billing underneath is M1's: exit 2 and `check-stuck`, landed
   * 2026-09-02. This adds the log's account of it.
   */
  it("records a stuck result and bills the submitter nothing", async () => {
    const { repo, notifyLog } = await boundaryRepository({ exit: 2, notify: true })
    const { branch, headSha } = await submitOneCommit(repo, "two")

    const run = await queueRunOnce(repo)
    expect(run.exitCode, run.report).toBe(2)

    const { records } = await logOfQueueRun(run)

    const stuck = theOne(records, "result")
    expect(stuck.result, run.report).toBe("stuck")
    expect(stuck.branch, run.report).toBe(branch)
    expect(stuck.head, run.report).toBe(headSha)
    // Nobody is billed, said in the field that says who is billed.
    expect(stuck.whose, run.report).toBe("queue")

    // The submitter's two messages are `merged` and `fail`. Neither is sent.
    for (const message of ofKind(records, "message")) {
      expect(["merged", "fail"], run.report).not.toContain(message.says)
    }
    // ...and the notifier was handed nothing that says either, so the log and
    // what actually went out agree. The notifier really is reached on this
    // path — measured 2026-09-02, one `yrd-broken` message — so this is a
    // checked zero, not an empty file nobody wrote to.
    const sent = await readFile(notifyLog, "utf8").catch(() => "")
    expect(sent, run.report).toMatch(/"kind":"yrd-broken"/)
    expect(sent, run.report).not.toMatch(/"kind":"(landed|send-back)"/)

    // The change stays where it was, so the next queue run takes it again.
    expect(ofKind(records, "merge"), run.report).toEqual([])
  })
})
