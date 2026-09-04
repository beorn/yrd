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
 * because a result nobody can read is not a result.
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

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createProcess, shellCommand, type Process, type ProcessResult } from "@yrd/process"

/**
 * A check as the target declares it — the whole declaration, in one type.
 * `runCheck` here reads what it runs; the queue run reads `on` and `scripts`
 * to decide when it runs and against which gate. Two names for one
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
  /** `YRD_CANDIDATE_SHA`: the worktree's HEAD — the change's head at submit, the merge commit at merge, the target itself at the target. */
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
 * The per-check verdict follows from that same stopping rule: every trailer
 * but the last is a check the queue ran and went on from, which is a pass, and
 * the last one's verdict is the one the change's ending record already states.
 * Nothing here re-derives a change's state — `readChange` is the only place
 * that happens.
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
  /**
   * The declaration's own entry, the command included. Absent when the
   * declaration read for this change does not name a check that ran: the
   * declaration moved, and the command that produced this log is not knowable
   * from it. Absent, never an empty string.
   */
  spec?: CheckSpec
  /** What the record says this check did; absent means it did not run. */
  result?: CheckRun
  state: "passed" | "failed" | "stuck" | "running" | "not-run"
  /** The real log path: the result's when it ran, the journal's while it runs. */
  log?: string
}>

/** The check a run journal says is running right now on this change. */
export type CheckedNow = Readonly<{ name: string; log?: string }>

export function checksOf(
  packed: readonly string[],
  ending: "checked" | "merged" | "failed" | "stuck" | "open",
  declared: readonly CheckSpec[],
  live?: CheckedNow,
): readonly CheckView[] {
  const ran = packed.map(readCheckTrailer)
  const verdict = (index: number): CheckRun["result"] => {
    if (index < ran.length - 1) return "pass"
    return ending === "failed" ? "fail" : ending === "stuck" ? "stuck" : "pass"
  }
  const byName = new Map(ran.map((result, index) => [result.name, { index, result }]))
  const seen = new Set<string>()
  const view = (name: string, spec: CheckSpec | undefined): CheckView => {
    seen.add(name)
    const found = byName.get(name)
    if (found === undefined) {
      const state = live?.name === name ? "running" : "not-run"
      return {
        name,
        state,
        ...(spec === undefined ? {} : { spec }),
        ...(state === "running" && live?.log !== undefined ? { log: live.log } : {}),
      }
    }
    const result = verdict(found.index)
    return {
      name,
      result: {
        result,
        ...(found.result.exit === undefined ? {} : { exit: found.result.exit }),
        ...(found.result.ms === undefined ? {} : { ms: found.result.ms }),
        ...(found.result.log === undefined ? {} : { log: found.result.log }),
      },
      state: result === "pass" ? "passed" : result === "fail" ? "failed" : "stuck",
      ...(spec === undefined ? {} : { spec }),
      ...(found.result.log === undefined ? {} : { log: found.result.log }),
    }
  }
  const declaredViews = declared.map((spec) => view(spec.name, spec))
  // A check that ran but the declaration does not name: the declaration moved
  // under the change. Its result is measured and stays on screen; what is not
  // knowable — the command it ran — is absent rather than guessed.
  const undeclared = ran.filter((result) => !seen.has(result.name)).map((result) => view(result.name, undefined))
  return [...declaredViews, ...undeclared]
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
  // Last, so they cannot be inherited over: what the check is judging is the
  // queue's own statement about the tree it just prepared, and a check told a
  // stale base by the environment would select the wrong work and say nothing.
  env.YRD_REPO = run.cwd
  env.YRD_CANDIDATE_SHA = run.tree.candidate
  env.YRD_BASE_SHA = run.tree.base
  const timeoutMs = run.spec.timeoutMs ?? DEFAULT_CHECK_BOUND_MS
  const started = Date.now()
  const result = await runner.run({ argv: shellCommand(run.spec.run), cwd: run.cwd, env, timeoutMs })
  const durationMs = Date.now() - started
  const body = `${result.stdout}${result.stderr === "" ? "" : `\n--- stderr ---\n${result.stderr}`}`
  // Create-only, always. Every caller now writes under a directory of its own
  // — the queue run's is keyed by change, run and phase, `yrd check`'s by the
  // instant it was invoked — so a path that already exists is two programs
  // writing one log, and the second replacing the first's bytes in silence is
  // the failure this refuses.
  try {
    writeFileSync(log, body, { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    throw new Error(`a check log already exists at ${log}: two checks wrote the same path instead of one each`, {
      cause: error,
    })
  }

  const base = { durationMs, log, name: run.spec.name }
  if (result.timedOut) {
    return { ...base, exit: "timeout", result: "stuck", why: `ran past its bound of ${timeoutMs} ms` }
  }
  if (result.signal !== null) {
    return { ...base, exit: "signal", result: "stuck", why: `ended by ${result.signal}` }
  }
  // The driver did not get a clean reading of this run, so nothing it read is a
  // verdict: a child that exits 0 while a descendant still holds its output pipe
  // comes back with a partial log and an exit code that means nothing, and used
  // to be classified pass. Whatever the condition, it is the queue's ground and
  // never the submitter's fault.
  const unclean = unsettled(result)
  if (unclean !== undefined) return { ...base, exit: "unsettled", result: "stuck", why: unclean }
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
