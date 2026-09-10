/**
 * One check, run here, now ([plan](../../../../pm/@i/10-yrd/plan.md)
 * § The final design, The queue run).
 *
 * A check is a command the target declares, run in a change's worktree with a
 * bound. Its result is one of three words, read off the exit code once the run
 * itself settled cleanly: 0 is pass, 1 is fail, 2 is stuck — the check's own
 * statement that it could not judge. A check that is not there, one that runs
 * past its bound, or one that exits with any other code could not judge either,
 * and that is the queue's fault until proven otherwise, so it is stuck too.
 * Every result names the check, its exit, its duration and its log path,
 * because a result nobody can read is not a result. That log is readable while
 * the check is still running: it is created before the child starts and grows
 * as the check writes, so a long check can be WATCHED rather than only
 * autopsied ({@link openCheckLog}).
 *
 * An exit code is only a verdict when the driver got a clean reading. When
 * `@yrd/process` reports a stall, a descendant that outlived the check holding
 * its output open, a settlement signal that could not reach the process group,
 * or output dropped past the capture budget, the check was NOT measured: the
 * result is stuck, the queue's, whatever the child exited with.
 *
 * The environment is built, never inherited (ruling A7), and it says what the
 * check is judging: `YRD_REPO` is the worktree the check runs in, its own
 * cwd; `YRD_CANDIDATE_SHA` is that worktree's HEAD; `YRD_BASE_SHA`
 * is the merge base of that HEAD and the target, so it is always an ancestor
 * of the candidate. A check that selects work by what changed — the affected
 * tests, the co-changed manifests — needs both shas and needs that ancestry, so
 * the queue states them rather than leaving each check to derive them by shell
 * against whatever refs its worktree happens to carry. They are read once per
 * worktree (worktree.ts) and the same for every program that runs in it, the
 * `setup:` included.
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs"
import { join } from "node:path"
import { createProcess, shellCommand, type Process, type ProcessResult } from "@yrd/process"
import type { JournalCheck } from "./log.ts"

/**
 * A check as the target declares it — the whole declaration, in one type.
 * `runCheck` here reads what it runs; the queue run reads `on` and `scripts`
 * to decide when it runs and against which check. Two names for one
 * declaration, with config.ts importing the wider one back from run.ts, was a
 * module cycle and a standing invitation to add a key to only one of them.
 */
export type CheckSpec = Readonly<{
  name: string
  /** The command, run through the shell in the change's worktree. */
  run: string
  /** The bound; the plan's default is thirty minutes. */
  timeoutMs?: number
  /** Environment names passed through from the queue's own environment. */
  environmentPassthrough?: readonly string[]
  /** The phases the check runs in; absent means merge (ruling A1). */
  on?: readonly ("submit" | "merge")[]
  /** Repository paths restored from the base commit before the check runs: the check's own scripts (ruling D5). */
  scripts?: readonly string[]
}>

export const DEFAULT_CHECK_BOUND_MS = 30 * 60 * 1000

/** The environment every check gets, by name; `LC_*` and the check's own `environmentPassthrough` join it. */
const BASE_ENV = ["PATH", "HOME", "SHELL", "LANG", "USER", "LOGNAME"] as const

export type CheckResult = Readonly<{
  name: string
  result: "pass" | "fail" | "stuck"
  /** The exit code, or the word for what ended it when there was none. */
  exit: number | "timeout" | "signal" | "missing" | "unsettled"
  durationMs: number
  /** Where stdout and stderr went, one file per attempt. */
  log: string
  /** Why, when the result is stuck. */
  why?: string
}>

/**
 * What the tree a program judges IS, read once when the worktree was prepared
 * and the same for every check and setup that runs in it.
 */
export type CheckedTree = Readonly<{
  /** `YRD_CANDIDATE_SHA`: the worktree's HEAD — a settled composition in queue phases, or the target itself at the target. */
  candidate: string
  /** `YRD_BASE_SHA`: the merge base of that HEAD and the target, so it is always an ancestor of the candidate. */
  base: string
}>

export type RunCheck = Readonly<{
  spec: CheckSpec
  /** The change's worktree. */
  cwd: string
  /** What that worktree holds, as the check is told it. */
  tree: CheckedTree
  /** Where this check's log is written. */
  logDir: string
  /** The temp root the check gets as `TMPDIR`; on the root filesystem, never a shared tmpfs. */
  tmpdir: string
  process?: Process
  env?: NodeJS.ProcessEnv
  /**
   * What the check itself asked for in this run, read off its own earlier log
   * (narrowing.ts). It joins the environment after the declaration's
   * passthrough and before the queue's own `YRD_*` statements, which stay
   * authoritative.
   */
  extraEnv?: Readonly<Record<string, string>>
}>

/**
 * Where a check's log goes, from the directory its phase writes into and the
 * check's own name. One reading of the two, so a caller can say where the log
 * will be before the check has written a byte of it: the row that says a check
 * STARTED names the same file the row that says it ended names.
 */
export function checkLogPath(logDir: string, name: string): string {
  return join(logDir, `${name}.log`)
}

/**
 * One check result packed onto a record's `Check:` trailer, and the reading of
 * it. They live together because they are one format: the table used to pick
 * the name off with a `split(" ")` and the log path off with a regex of its
 * own, neither of them anywhere near the line that wrote them.
 */
export function checkTrailer(result: CheckResult): string {
  return `${result.name} exit=${String(result.exit)} ms=${String(result.durationMs)} log=${result.log}`
}

/**
 * What a packed `Check:` trailer says: the check's name, how it exited, how
 * long it took, and where its log went — every field {@link checkTrailer}
 * writes, read back. It used to answer with two of the four, so a reader that
 * wanted the exit went to the trailer text itself with a regex of its own; the
 * format has one reader and this is it.
 */
export function readCheckTrailer(packed: string): Readonly<{ name: string; exit?: string; ms?: number; log?: string }> {
  const name = packed.split(" ")[0] ?? ""
  const exit = /(?:^| )exit=([^ ]*)/u.exec(packed)?.[1]
  const written = /(?:^| )ms=(\d+)/u.exec(packed)?.[1]
  const ms = written === undefined ? undefined : Number(written)
  // `log=` is written last, so its value runs to the end and a path with an
  // `=` in it survives the reading.
  const log = /(?:^| )log=(.+)$/u.exec(packed)?.[1]
  return {
    name,
    ...(exit === undefined ? {} : { exit }),
    ...(ms === undefined || Number.isNaN(ms) ? {} : { ms }),
    ...(log === undefined ? {} : { log }),
  }
}

/**
 * The checks a change was judged by: the declaration joined to what actually
 * ran ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The queue run).
 *
 * A `Check:` trailer records only checks that RAN. "Not run" therefore has no
 * meaning without the declared list, and the declared list that matters is the
 * one the change was judged by — the declaration at the commit the record
 * names in `Base:`, not whatever the target carries now. The queue runs the
 * declaration's checks in its own order and stops at the first that is not a
 * pass (run.ts), so the checks after a failed one did not run and this says so
 * rather than leaving them off the screen.
 *
 * The per-check verdict is read off that trailer's OWN recorded exit, through
 * the same classifier `runCheck` judges by — never the change's ending and
 * never the check's position. A change can end `failed` for a reason no check
 * made, a merge conflict foremost among them, and a check that exited 0 stays
 * passed regardless: the ending is the queue's word about the CHANGE, not a
 * substitute for a check's own word about itself. Nothing here re-derives a
 * change's state — `readChange` is the only place that happens.
 */
export type CheckRun = Readonly<{
  result: "pass" | "fail" | "stuck"
  /** The exit as the trailer spells it: a number, or `timeout`, `signal`, `missing`, `unsettled`. */
  exit?: string
  /** How long it took. */
  ms?: number
  /** The real path its output went to. */
  log?: string
}>

export type CheckView = Readonly<{
  /** The check's name — whether the declaration names it, it ran, or both. */
  name: string
  /** The recorded phase of this measured occurrence; absent for trailer-only views. */
  phase?: string
  /**
   * The declaration's own entry, the command included. Absent when the
   * declaration read for this change does not name a check that ran: the
   * declaration moved, and the command that produced this log is not knowable
   * from it. Absent, never an empty string.
   */
  spec?: CheckSpec
  /** What the record says this check did; absent also covers a journal with no measured result. */
  result?: CheckRun
  state: "passed" | "failed" | "stuck" | "running" | "not-run" | "unmeasured"
  /** The real log path: the result's when it ran, the journal's while it runs. */
  log?: string
}>

/** The check a run journal says is running right now on this change. */
export type CheckedNow = Readonly<{ name: string; log?: string }>

export function checksOf(
  packed: readonly string[],
  // Kept for callers that already have it beside `change.checks` (`show`'s
  // own note, `endingOf`) — no longer consulted here. A check's verdict is
  // its own trailer's exit, read by `resultOfExit` below; the change's ending
  // decided the CHANGE, not any one check, and inferring the reverse is the
  // defect this signature used to carry.
  ending: "checked" | "merged" | "failed" | "stuck" | "open",
  declared: readonly CheckSpec[],
  live?: CheckedNow,
  measured?: readonly JournalCheck[],
): readonly CheckView[] {
  void ending
  const ran = measured ?? packed.map(readCheckTrailer)
  const byName = new Map(ran.map((result, index) => [result.name, { index, result }]))
  const seen = new Set<string>()
  const view = (name: string, spec: CheckSpec | undefined, found = byName.get(name)): CheckView => {
    seen.add(name)
    if (found === undefined) {
      const state = measured === undefined && live?.name === name ? "running" : "not-run"
      return {
        name,
        state,
        ...(spec === undefined ? {} : { spec }),
        ...(state === "running" && live?.log !== undefined ? { log: live.log } : {}),
      }
    }
    const measuredCheck = measured?.[found.index]
    const result = measured === undefined ? resultOfExit(found.result.exit) : measuredCheck?.result
    return {
      name,
      ...(measuredCheck === undefined ? {} : { phase: measuredCheck.phase }),
      ...(result === undefined
        ? {}
        : {
            result: {
              result,
              ...(found.result.exit === undefined ? {} : { exit: found.result.exit }),
              ...(found.result.ms === undefined ? {} : { ms: found.result.ms }),
              ...(found.result.log === undefined ? {} : { log: found.result.log }),
            },
          }),
      state:
        result === undefined
          ? measuredCheck?.endedAt === undefined && live?.name === name && live.log === measuredCheck?.log
            ? "running"
            : "unmeasured"
          : result === "pass"
            ? "passed"
            : result === "fail"
              ? "failed"
              : "stuck",
      ...(spec === undefined ? {} : { spec }),
      ...(found.result.log === undefined ? {} : { log: found.result.log }),
    }
  }
  if (measured !== undefined) {
    // Every occurrence survives, including the baseline comparator for a
    // failed candidate. A by-name collapse would relabel its green result.
    const occurrences = measured.map((check, index) =>
      view(
        check.name,
        declared.find((spec) => spec.name === check.name),
        { index, result: check },
      ),
    )
    return [...occurrences, ...declared.filter((spec) => !seen.has(spec.name)).map((spec) => view(spec.name, spec))]
  }
  const declaredViews = declared.map((spec) => view(spec.name, spec))
  // A check that ran but the declaration does not name: the declaration moved
  // under the change. Its result is measured and stays on screen; what is not
  // knowable — the command it ran — is absent rather than guessed.
  const undeclared = ran.filter((result) => !seen.has(result.name)).map((result) => view(result.name, undefined))
  return [...declaredViews, ...undeclared]
}

/**
 * A trailer's own verdict, read off the exit `checkTrailer` packed onto it,
 * through the exact classifier `runCheck` judged the live run by: `0` is a
 * pass, `1` is a fail, and everything else — another number, `timeout`,
 * `signal`, `missing`, `unsettled`, or a trailer so malformed its exit did
 * not parse at all — could not judge, so it is stuck (check.ts's own default
 * for an exit code that is not a verdict). Never the change's ending, never
 * the check's place in the list: a check that stopped the queue's own
 * sequence already said so in this exit, and a change that ended `failed` or
 * `stuck` for a reason no check made — a merge conflict foremost among them —
 * must not borrow that ending as if it were this check's word about itself.
 */
function resultOfExit(exit: string | undefined): CheckRun["result"] {
  return exit === "0" ? "pass" : exit === "1" ? "fail" : "stuck"
}

/**
 * One check's log, open from before its child starts until after it settles.
 *
 * The whole body used to be written once, after the run returned, so a check's
 * log did not EXIST for the check's entire life and `yrd queue show` had one
 * sentence for a fourteen-minute run: "running; nothing written yet". A check
 * nobody can watch cannot be told apart from a wedged one, so the bytes go to
 * the file as they arrive.
 *
 * Create-only stays create-only and moves EARLIER. The `wx` open happens before
 * the child is spawned, so two programs writing one path still refuse loudly,
 * with the same words — and the loser now refuses without running its check at
 * all, rather than after spending its bound on one.
 */
type CheckLog = Readonly<{
  /** Append bytes, in the order they were observed. */
  append: (chunk: Uint8Array) => void
  /** One bracketed line of yrd's own, on a line of its own. */
  note: (text: string) => void
  /** Stop writing, and say whether the file can be trusted. */
  close: () => string | undefined
}>

function openCheckLog(path: string): CheckLog {
  let file: number
  try {
    file = openSync(path, "wx")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    throw new Error(`a check log already exists at ${path}: two checks wrote the same path instead of one each`, {
      cause: error,
    })
  }
  let written = 0
  let failure: string | undefined
  const encoder = new TextEncoder()
  const append = (chunk: Uint8Array): void => {
    // The FIRST failure is the one that explains where the file stops; every
    // later chunk against the same broken descriptor would only bury it.
    if (failure !== undefined) return
    try {
      let offset = 0
      while (offset < chunk.byteLength) {
        // A short write is ordinary, and dropping its remainder in silence is a
        // log missing its middle — so loop. A write that moves nothing cannot be
        // retried into progress, so it is an error here rather than a spin.
        const count = writeSync(file, chunk, offset, chunk.byteLength - offset)
        if (count <= 0) throw new Error(`wrote ${String(count)} of ${String(chunk.byteLength - offset)} bytes`)
        offset += count
      }
      written += chunk.byteLength
    } catch (error) {
      failure = `its log at ${path} could not be written after ${String(written)} bytes: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    append,
    note: (text) => {
      append(encoder.encode(`\n[yrd: ${text}]\n`))
    },
    close: () => {
      if (failure !== undefined) {
        try {
          writeSync(file, encoder.encode(`\n[yrd: this log is INCOMPLETE — ${failure}]\n`))
        } catch {
          // Best effort, and not a swallow: the descriptor that just failed may
          // well fail again, and the durable, loud copy of this same failure is
          // the check's own stuck verdict and `why`, which the caller returns.
        }
      }
      try {
        closeSync(file)
      } catch (error) {
        // A deferred flush fails here or nowhere, and it means the tail of the
        // file never landed.
        failure ??= `its log at ${path} could not be closed: ${error instanceof Error ? error.message : String(error)}`
      }
      return failure
    },
  }
}

export async function runCheck(run: RunCheck): Promise<CheckResult> {
  mkdirSync(run.logDir, { recursive: true })
  mkdirSync(run.tmpdir, { recursive: true })
  const log = checkLogPath(run.logDir, run.spec.name)
  const runner = run.process ?? createProcess({ cwd: run.cwd })
  // The check's environment is built, never inherited: a fixed base a real
  // check needs (measured on the root's own checks), the temp root as
  // TMPDIR, and whatever the check declares. Nothing else reaches the child.
  const source = run.env ?? process.env
  const env: NodeJS.ProcessEnv = { TMPDIR: run.tmpdir }
  for (const name of [...BASE_ENV, ...(run.spec.environmentPassthrough ?? [])]) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith("LC_") && value !== undefined) env[name] = value
  }
  // What this check asked its own next run for. After the declaration, so a
  // check can narrow a scope its passthrough also names, and before the
  // `YRD_*` trio below, which is the queue's word and not the check's.
  for (const [name, value] of Object.entries(run.extraEnv ?? {})) env[name] = value
  // Last, so they cannot be inherited over: what the check is judging is the
  // queue's own statement about the tree it just prepared, and a check told a
  // stale base by the environment would select the wrong work and say nothing.
  env.YRD_REPO = run.cwd
  env.YRD_CANDIDATE_SHA = run.tree.candidate
  env.YRD_BASE_SHA = run.tree.base
  const timeoutMs = run.spec.timeoutMs ?? DEFAULT_CHECK_BOUND_MS
  // Create-only, always, and open before the child exists. Every caller writes
  // under a directory of its own — the queue run's is keyed by change, run and
  // phase, `yrd check`'s by the instant it was invoked — so a path that already
  // exists is two programs writing one log, and the second replacing the
  // first's bytes in silence is the failure this refuses.
  const logFile = openCheckLog(log)
  const started = Date.now()
  let result: ProcessResult
  try {
    result = await runner.run({
      argv: shellCommand(run.spec.run),
      cwd: run.cwd,
      env,
      timeoutMs,
      // stdout and stderr, interleaved in arrival order, the way a terminal
      // shows them. The old body separated them under a `--- stderr ---` rule,
      // which only a whole-file writer can do: it needs both streams complete
      // before it can write the first byte of either, and that wait was the
      // defect. Nothing read the rule (2026-09-09 sweep of this repository).
      onOutput: ({ chunk }) => {
        logFile.append(chunk)
      },
    })
  } catch (error) {
    logFile.close()
    throw error
  }
  const durationMs = Date.now() - started
  // The capture budget drops the MIDDLE of an over-long stream from the text
  // `@yrd/process` returns, while the observer this file is written from
  // receives every byte it read (readBounded). So the file and `result.stdout`
  // can disagree, and the file says which of the two is short instead of
  // letting a reader assume they match.
  for (const dropped of result.outputTruncation ?? []) {
    logFile.note(
      `${dropped.stream} ran past the ${String(dropped.limitBytes)}-byte capture budget: ` +
        `${String(dropped.droppedBytes)} of ${String(dropped.totalBytes)} bytes are missing from the text the queue read, ` +
        `and every byte its capture observed was streamed to this file`,
    )
  }
  const logFailure = logFile.close()

  const base = { durationMs, log, name: run.spec.name }
  /** A stuck reason, carrying a log that could not be written alongside it. */
  const why = (reason: string): string => (logFailure === undefined ? reason : `${reason}; ${logFailure}`)
  if (result.timedOut) {
    return { ...base, exit: "timeout", result: "stuck", why: why(`ran past its bound of ${timeoutMs} ms`) }
  }
  if (result.signal !== null) {
    return { ...base, exit: "signal", result: "stuck", why: why(`ended by ${result.signal}`) }
  }
  // The driver did not get a clean reading of this run, so nothing it read is a
  // verdict: a child that exits 0 while a descendant still holds its output pipe
  // comes back with a partial log and an exit code that means nothing, and used
  // to be classified pass. Whatever the condition, it is the queue's ground and
  // never the submitter's fault.
  const unclean = unsettled(result)
  if (unclean !== undefined) return { ...base, exit: "unsettled", result: "stuck", why: why(unclean) }
  // A log that could not be written is a reading the driver did not get, the
  // same as a dropped capture above: the exit code can be a clean 0 while the
  // only durable evidence for it stops mid-stream. Returning that as a pass is
  // exactly the partial log that reads as complete, so it is stuck, and it is
  // the queue's ground rather than the submitter's.
  if (logFailure !== undefined) return { ...base, exit: "unsettled", result: "stuck", why: logFailure }
  // 127 is the shell's own word for a command it could not find: the check is
  // not there, which is the queue's fault, not the submitter's.
  if (result.exitCode === 127) {
    return { ...base, exit: "missing", result: "stuck", why: `the check command was not found: ${run.spec.run}` }
  }
  switch (result.exitCode) {
    case 0:
      return { ...base, exit: 0, result: "pass" }
    case 1:
      return { ...base, exit: 1, result: "fail" }
    case 2:
      return { ...base, exit: 2, result: "stuck", why: "the check said it could not judge" }
    default:
      return { ...base, exit: result.exitCode, result: "stuck", why: `exit ${result.exitCode} is not a verdict` }
  }
}

/**
 * What `@yrd/process` says went wrong with the RUN, as opposed to what the
 * check said: a stall, a descendant that outlived the check and held its output
 * open, a settlement signal that could not reach the process group, or output
 * dropped past the capture budget. Each is loud in the result and each means
 * the check was not measured; reading its exit code anyway is how a wedged
 * check passes.
 */
function unsettled(result: ProcessResult): string | undefined {
  const found: string[] = []
  if (result.escapedDescendant === true) {
    found.push("a descendant outlived it and held its output open, so the log is partial")
  } else if (result.stalled === true) {
    found.push("it stalled: no output progress within the bound")
  }
  if (result.sweepFailure !== undefined) found.push(result.sweepFailure)
  const truncated = result.outputTruncation ?? []
  if (truncated.length > 0) {
    const dropped = truncated.reduce((total, entry) => total + entry.droppedBytes, 0)
    found.push(`${String(dropped)} bytes of its output were dropped past the capture budget, so the log is partial`)
  }
  return found.length === 0 ? undefined : found.join("; ")
}
