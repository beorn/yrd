/**
 * One check, run here, now ([plan](../../../../pm/@i/10-yrd/plan.md)
 * § The final design, The queue run).
 *
 * A check is a command the target declares, run in a change's worktree with a
 * bound. Its result is one of three words, read off the exit code once the run
 * itself settled cleanly: 0 is pass, 1 is fail, and everything else is stuck.
 * 2 and 3 are the check's own statement that it could not judge (3 is the
 * affected tests' cannot-judge). Neither is ever billed to the submitter: a
 * stuck change stops the line until the fault is fixed (the andon, @cto
 * 7645ec3a ruling 1, which reverted bouncing 3 to the submitter as a fail). A
 * check that is not there, one that runs past its bound, or one that exits
 * with any other code could not judge either, and that is the queue's fault
 * until proven otherwise, so it is stuck too.
 * Every result names the check, its exit, its duration and its log path,
 * because a result nobody can read is not a result. That log is readable while
 * the check is still running: it is created before the child starts and grows
 * as the check writes, so a long check can be WATCHED rather than only
 * autopsied ({@link openCheckLog}).
 *
 * An exit code is only a verdict when the driver got a clean reading. When
 * `@yrd/process` reports a stall, a descendant that outlived the check holding
 * its output open, a settlement signal that could not reach the process group,
 * the check was NOT measured: the result is stuck, whatever the child exited
 * with. Display overflow alone is acceptable only when the streamed log
 * proves complete raw-byte retention at normal completion.
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

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs"
import { isAbsolute, join } from "node:path"
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
  /** Long-tier configuration overrides. */
  long?: Readonly<{
    timeoutMs: number
  }>
  /** Environment names passed through from the queue's own environment. */
  environmentPassthrough?: readonly string[]
  /** The phases the check runs in; absent means merge (ruling A1). */
  on?: readonly ("submit" | "merge")[]
  /** Repository paths the check owns: legacy mode restores them from base; program-root mode validates them in the target program root without overlaying the candidate checkout. */
  scripts?: readonly string[]
  /** Opt in to the queue-provided, immutable program root for this check. */
  programRoot?: true
}>

export const DEFAULT_CHECK_BOUND_MS = 30 * 60 * 1000

/**
 * The line a check writes when it has already computed a pass/fail, before any
 * extra work that may then outlive the bound. Same shape as YRD-BASE-NARROWING:
 * one marker, a JSON payload, last line wins. On timeout the queue reads this
 * and uses it as the round's result instead of discarding a finished comparison
 * as `yrd-check-unresolved` (24623).
 */
export const CHECK_RESULT_MARKER = "YRD-CHECK-RESULT"

/**
 * The line a check writes while extra work is still in flight, so a timeout
 * can name what consumed the bound instead of only the constant (24623
 * acceptance 3). Same shape: one marker, JSON, last line wins.
 */
export const CHECK_PROGRESS_MARKER = "YRD-CHECK-PROGRESS"

/** The environment every check gets, by name; `LC_*` and the check's own `environmentPassthrough` join it. */
const BASE_ENV = ["PATH", "HOME", "SHELL", "LANG", "USER", "LOGNAME"] as const

export type CheckResult = Readonly<{
  name: string
  result: "pass" | "fail" | "stuck" | "deferred"
  /** The exit code, or the word for what ended it when there was none. */
  exit: number | "timeout" | "signal" | "missing" | "unsettled"
  durationMs: number
  /** Where stdout and stderr went, one file per attempt. */
  log: string
  /** Why, when the result is stuck or deferred. */
  why?: string
  projectedMs?: number
  boundMs?: number
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
  /** Which check tier is running: normal (default) or long. */
  tier?: "normal" | "long"
  /**
   * What the check itself asked for in this run, read off its own earlier log
   * (narrowing.ts). It joins the environment after the declaration's
   * passthrough and before the queue's own `YRD_*` statements, which stay
   * authoritative.
   */
  extraEnv?: Readonly<Record<string, string>>
  /**
   * The absolute root carrying queue-owned program code, supplied only to a
   * check that declared {@link CheckSpec.programRoot}. The runner rejects a
   * missing, relative, or legacy use before it starts the child.
   */
  programRoot?: string
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
 * The program root is a queue statement, just as the checked-tree trio is.
 * Keep the declaration and the call boundary together: a legacy command
 * cannot acquire a new authority merely because its caller happened to carry
 * one, and an opted-in command cannot silently fall back to its worktree.
 */
function checkedProgramRoot(run: RunCheck): string | undefined {
  if (run.spec.programRoot !== undefined && run.spec.programRoot !== true) {
    throw new Error(`check ${run.spec.name}: programRoot must be true when present`)
  }
  if (run.spec.programRoot !== true) {
    if (run.programRoot !== undefined) {
      throw new Error(
        `check ${run.spec.name} does not declare programRoot: true, so its caller must not supply programRoot`,
      )
    }
    return undefined
  }
  if (run.programRoot === undefined) {
    throw new Error(`check ${run.spec.name}: programRoot: true requires an absolute programRoot`)
  }
  if (typeof run.programRoot !== "string" || !isAbsolute(run.programRoot)) {
    throw new Error(`check ${run.spec.name}: programRoot must be an absolute path`)
  }
  return run.programRoot
}

/**
 * One check result packed onto a record's `Check:` trailer, and the reading of
 * it. They live together because they are one format: the table used to pick
 * the name off with a `split(" ")` and the log path off with a regex of its
 * own, neither of them anywhere near the line that wrote them.
 */
export function checkTrailer(
  result: CheckResult,
  occurrence?: Readonly<{ attempt: number; phase: "submit" | "merge"; tier?: "long" }>,
): string {
  if (occurrence !== undefined && (!Number.isSafeInteger(occurrence.attempt) || occurrence.attempt < 1)) {
    throw new TypeError(`check ${result.name}: attempt must be a positive integer`)
  }
  if (occurrence !== undefined && occurrence.phase !== "submit" && occurrence.phase !== "merge") {
    throw new TypeError(`check ${result.name}: phase must be submit or merge`)
  }
  if (occurrence?.tier !== undefined && occurrence.tier !== "long") {
    throw new TypeError(`check ${result.name}: tier must be long when present`)
  }
  const evidence =
    occurrence === undefined
      ? ""
      : ` result=${result.result} attempt=${String(occurrence.attempt)} phase=${occurrence.phase}${occurrence.tier === undefined ? "" : ` tier=${occurrence.tier}`}`
  return `${result.name} exit=${String(result.exit)} ms=${String(result.durationMs)}${evidence} log=${result.log}`
}

/**
 * What a packed `Check:` trailer says: the check's name, how it exited, how
 * long it took, and where its log went — every field {@link checkTrailer}
 * writes, read back. It used to answer with two of the four, so a reader that
 * wanted the exit went to the trailer text itself with a regex of its own; the
 * format has one reader and this is it.
 */
export function readCheckTrailer(packed: string): Readonly<{
  name: string
  exit?: string
  ms?: number
  result?: CheckResult["result"]
  attempt?: number
  phase?: "submit" | "merge"
  tier?: "long"
  log?: string
}> {
  // `log=` is last and may contain words that look like evidence fields.
  // Parse only the header before that delimiter.
  const logAt = packed.indexOf(" log=")
  const header = logAt < 0 ? packed : packed.slice(0, logAt)
  const log = logAt < 0 ? undefined : packed.slice(logAt + " log=".length)
  const name = header.split(" ")[0] ?? ""
  const exit = /(?:^| )exit=([^ ]*)/u.exec(header)?.[1]
  const written = /(?:^| )ms=(\d+)/u.exec(header)?.[1]
  const ms = written === undefined ? undefined : Number(written)
  const result = /(?:^| )result=(pass|fail|stuck|deferred)(?: |$)/u.exec(header)?.[1] as
    | CheckResult["result"]
    | undefined
  const attemptWritten = /(?:^| )attempt=(\d+)(?: |$)/u.exec(header)?.[1]
  const attempt = attemptWritten === undefined ? undefined : Number(attemptWritten)
  const phase = /(?:^| )phase=(submit|merge)(?: |$)/u.exec(header)?.[1] as "submit" | "merge" | undefined
  const tier = /(?:^| )tier=(long)(?: |$)/u.exec(header)?.[1] as "long" | undefined
  return {
    name,
    ...(exit === undefined ? {} : { exit }),
    ...(ms === undefined || Number.isNaN(ms) ? {} : { ms }),
    ...(result === undefined ? {} : { result }),
    ...(attempt === undefined || !Number.isSafeInteger(attempt) || attempt < 1 ? {} : { attempt }),
    ...(phase === undefined ? {} : { phase }),
    ...(tier === undefined ? {} : { tier }),
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
  result: "pass" | "fail" | "stuck" | "deferred"
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
  /** The phase this occurrence ran in: the measured reading's own when there is one; otherwise the declaration's own `on:` (ruling A1's default), positioned by which of that name's own occurrences this is. */
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
  /**
   * `skipped`: a merge-check override held it off (25296); its record's `Skipped:` trailer says whose and until when.
   * `off`: the declaration switched it off by making its command `true` (25422), so a pass proves nothing.
   */
  state: "passed" | "failed" | "stuck" | "running" | "not-run" | "unmeasured" | "deferred" | "skipped" | "off"
  /** The real log path: the result's when it ran, the journal's while it runs. */
  log?: string
}>

/** A check whose command is `true` is switched off: it runs, exits 0 and tests nothing (25422). */
function isSwitchedOff(spec: Pick<CheckSpec, "run">): boolean {
  return spec.run.trim() === "true"
}

/** The check names a change's records say an override skipped: the first word of each `Skipped:` trailer. */
export function skippedChecks(
  records: readonly Readonly<{ trailers: readonly (readonly [string, string])[] }>[],
): ReadonlySet<string> {
  return new Set(
    records.flatMap((record) =>
      record.trailers.filter(([name]) => name === "Skipped").map(([, value]) => value.split(" ")[0] ?? ""),
    ),
  )
}

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
  /** The checks a record's `Skipped:` trailers name: an override held them off at merge, so they read skipped, never not run. */
  skipped: ReadonlySet<string> = new Set(),
): readonly CheckView[] {
  void ending
  // An ending record's own `Check:` trailers are carried forward verbatim
  // onto the `sent` record that follows it (legacy-records.ts), so one real
  // occurrence's exact trailer text — name, exit, ms and its create-only,
  // therefore never-reused, log path together — can be folded in twice by
  // `show()`. Two trailers that are not byte-identical are never the same
  // occurrence; two that ARE can only be this carry-forward, so collapsing
  // exact duplicates (order-preserving) loses nothing and stops it being
  // double-counted as a second run of the same check.
  const ran = measured ?? [...new Set(packed)].map(readCheckTrailer)
  // Every occurrence of a name, in the order it ran — never collapsed to the
  // last. A check declared in two phases writes one trailer per phase under
  // the same name, and a change retried after "stuck" writes a fresh trailer
  // under that same name again; a by-name Map's own overwrite kept only the
  // last of those and erased the rest's own result — a row vanishing is this
  // bucket's fix, the same guarantee CTO b55a973f already holds the measured
  // reading below to ("every occurrence survives").
  const byName = new Map<string, { index: number; result: (typeof ran)[number] }[]>()
  for (const [index, result] of ran.entries()) {
    const bucket = byName.get(result.name)
    if (bucket === undefined) byName.set(result.name, [{ index, result }])
    else bucket.push({ index, result })
  }
  const seen = new Set<string>()
  const view = (
    name: string,
    spec: CheckSpec | undefined,
    found: Readonly<{ index: number; result: (typeof ran)[number] }> | undefined,
    phase?: string,
  ): CheckView => {
    seen.add(name)
    const off = spec !== undefined && isSwitchedOff(spec)
    if (found === undefined) {
      const state = off
        ? "off"
        : measured === undefined && live?.name === name
          ? "running"
          : skipped.has(name)
            ? "skipped"
            : "not-run"
      return {
        name,
        state,
        ...(spec === undefined ? {} : { spec }),
        ...(state === "running" && live?.log !== undefined ? { log: live.log } : {}),
      }
    }
    const measuredCheck = measured?.[found.index]
    const result = measured === undefined ? resultOfExit(found.result.exit) : measuredCheck?.result
    // The measured reading's own phase when there is one; otherwise the
    // declaration's, at whichever of its own occurrences this call was given
    // (below) — a packed trailer never carried a phase of its own.
    const resolvedPhase = measuredCheck?.phase ?? phase
    return {
      name,
      ...(resolvedPhase === undefined ? {} : { phase: resolvedPhase }),
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
        off && result !== "fail" && result !== "stuck"
          ? "off"
          : result === undefined
            ? measuredCheck?.endedAt === undefined && live?.name === name && live.log === measuredCheck?.log
              ? "running"
              : "unmeasured"
            : result === "pass"
              ? "passed"
              : result === "fail"
                ? "failed"
                : result === "deferred"
                  ? "deferred"
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
    return [
      ...occurrences,
      ...declared.filter((spec) => !seen.has(spec.name)).map((spec) => view(spec.name, spec, undefined)),
    ]
  }
  // No measured reading, so no occurrence carries its own phase: read it off
  // the declaration instead. A check declared in ONE phase keeps its ORIGINAL
  // reading here — its own last occurrence, the same one a by-name Map's
  // overwrite always kept: more than one packed trailer under a single
  // declared phase is that check's own re-run of the ONE slot the declaration
  // gives it (1fca452c's fixture: `affected-tests`, declared merge-only,
  // still carries a trailer from the submit-phase record too), not a second
  // phase of equal standing, so the reader keeps only the check's own final
  // say, not both. A check declared in TWO phases is different: each is its
  // own distinct, equally-valid evidence, so it keeps one row per declared
  // phase, in run order — submit before merge (ruling A1) — consuming that
  // many of its own occurrences in that order rather than the collapse
  // b55a973f forbids.
  const nextOccurrence = new Map<string, number>()
  const phased = (["submit", "merge"] as const).flatMap((phase) =>
    declared
      .filter((spec) => (spec.on ?? ["merge"]).includes(phase))
      .map((spec) => {
        const bucket = byName.get(spec.name) ?? []
        const phases = spec.on ?? ["merge"]
        if (phases.length <= 1) return view(spec.name, spec, bucket.at(-1), phase)
        const at = nextOccurrence.get(spec.name) ?? 0
        nextOccurrence.set(spec.name, at + 1)
        return view(spec.name, spec, bucket[at], phase)
      }),
  )
  // A check declared in two-or-more phases that ALSO ran more times than it
  // has declared phases for keeps every extra occurrence too, under its last
  // declared phase, rather than dropping the evidence a fresh trailer just
  // wrote. A check declared in only one phase has no "extra" here: multiple
  // occurrences under one phase are the collapse-to-latest case above, not
  // this one.
  const extra = declared.flatMap((spec) => {
    const phases = spec.on ?? ["merge"]
    if (phases.length <= 1) return []
    const bucket = byName.get(spec.name) ?? []
    return bucket.length <= phases.length
      ? []
      : bucket.slice(phases.length).map((found) => view(spec.name, spec, found, phases.at(-1)))
  })
  // A check that ran but the declaration does not name: the declaration moved
  // under the change. Its result is measured and stays on screen; what is not
  // knowable — the command it ran — is absent rather than guessed.
  const undeclared = [...byName.entries()]
    .filter(([name]) => !seen.has(name))
    .flatMap(([name, bucket]) => bucket.map((found) => view(name, undefined, found)))
  return [...phased, ...extra, ...undeclared]
}

/**
 * The last computed pass/fail a check named on its log, or nothing when it
 * never did. A malformed line is not a verdict: timeout then stays stuck,
 * which is the existing bound path — and the failure is loud, so a stuck
 * round is distinguishable from a rescued one (24623).
 */
export type CheckVerdict = Readonly<{
  result: "pass" | "fail" | "deferred"
  exit?: number
  reason?: string
  projectedMs?: number
  boundMs?: number
}>

/**
 * Parse the structured CheckVerdict from the last YRD-CHECK-RESULT marker.
 * Condition 6: An unknown result marker is refused loudly.
 */
export function readCheckVerdict(text: string): CheckVerdict | undefined {
  const marked = text.split("\n").filter((line) => line.startsWith(`${CHECK_RESULT_MARKER} `))
  const line = marked.at(-1)
  if (line === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(line.slice(CHECK_RESULT_MARKER.length + 1).trim())
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(`${CHECK_RESULT_MARKER} payload is not an object; not treating it as a verdict`)
      return undefined
    }
    const body = parsed as {
      result?: unknown
      exit?: unknown
      reason?: unknown
      projectedMs?: unknown
      boundMs?: unknown
    }
    if (body.result !== undefined) {
      if (body.result === "pass" || body.result === "fail" || body.result === "deferred") {
        return {
          result: body.result,
          exit: typeof body.exit === "number" ? body.exit : undefined,
          reason: typeof body.reason === "string" ? body.reason : undefined,
          projectedMs: typeof body.projectedMs === "number" ? body.projectedMs : undefined,
          boundMs: typeof body.boundMs === "number" ? body.boundMs : undefined,
        }
      }
      throw new Error(`${CHECK_RESULT_MARKER}: unknown result "${String(body.result)}"`)
    }
    if (body.exit === 0 || body.exit === "0") return { result: "pass", exit: 0 }
    if (body.exit === 1 || body.exit === "1") return { result: "fail", exit: 1 }
    console.error(`${CHECK_RESULT_MARKER} named neither pass nor fail (exit 0 or 1); not treating it as a verdict`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${CHECK_RESULT_MARKER}: unknown result`)) {
      throw error
    }
    console.error(
      `${CHECK_RESULT_MARKER} is unreadable; not treating it as a verdict:`,
      error instanceof Error ? error.message : String(error),
    )
    return undefined
  }
  return undefined
}

/**
 * The last computed pass/fail/deferred string a check named on its log, or nothing when it
 * never did.
 */
export function readCheckResult(text: string): "pass" | "fail" | "deferred" | undefined {
  return readCheckVerdict(text)?.result
}

function checkResultFromLog(log: string): CheckVerdict | undefined {
  try {
    return readCheckVerdict(readFileSync(log, "utf8"))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${CHECK_RESULT_MARKER}: unknown result`)) {
      throw error
    }
    console.error(
      `${CHECK_RESULT_MARKER}: check log ${log} could not be read; not treating it as a verdict:`,
      error instanceof Error ? error.message : String(error),
    )
    return undefined
  }
}

/** Compact last YRD-CHECK-PROGRESS on the log, or nothing. Never a verdict. */
export function readCheckProgress(text: string): string | undefined {
  const marked = text.split("\n").filter((line) => line.startsWith(`${CHECK_PROGRESS_MARKER} `))
  const line = marked.at(-1)
  if (line === undefined) return undefined
  const payload = line.slice(CHECK_PROGRESS_MARKER.length + 1).trim()
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return payload.slice(0, 200)
    const body = parsed as Record<string, unknown>
    const parts: string[] = []
    for (const key of ["stage", "files", "done", "total", "suite"]) {
      const value = body[key]
      if (value === undefined || value === null) continue
      if (typeof value !== "string" && typeof value !== "number") continue
      parts.push(`${key}=${String(value)}`)
    }
    return parts.length > 0 ? parts.join(" ") : payload.slice(0, 200)
  } catch (error) {
    console.error(
      `${CHECK_PROGRESS_MARKER} is unreadable; not naming it on the timeout:`,
      error instanceof Error ? error.message : String(error),
    )
    return undefined
  }
}

function checkProgressFromLog(log: string): string | undefined {
  try {
    return readCheckProgress(readFileSync(log, "utf8"))
  } catch (error) {
    console.error(
      `${CHECK_PROGRESS_MARKER}: check log ${log} could not be read:`,
      error instanceof Error ? error.message : String(error),
    )
    return undefined
  }
}

/**
 * A trailer's own verdict, read off the exit `checkTrailer` packed onto it,
 * through the exact classifier `runCheck` judged the live run by: `0` is a
 * pass, `1` is a fail, and everything else — `2` or `3` (the check's own
 * could-not-judge), another number, `timeout`, `signal`, `missing`,
 * `unsettled`, or a trailer so malformed its exit did not parse at all —
 * could not judge, so it is stuck (check.ts's own default for an exit code
 * that is not a verdict). Never the change's ending, never the check's place
 * in the list: a check that stopped the queue's own sequence already said so
 * in this exit, and a change that ended `failed` or `stuck` for a reason no
 * check made — a merge conflict foremost among them — must not borrow that
 * ending as if it were this check's word about itself.
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
  append: (stream: "stdout" | "stderr", chunk: Uint8Array) => void
  /** One bracketed line of yrd's own, on a line of its own. */
  note: (text: string) => void
  /** Verify normal-completion byte retention and close; no crash-durability promise. */
  close: (result?: ProcessResult) => string | undefined
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
  const observed = { stdout: 0, stderr: 0 }
  const written = { stdout: 0, stderr: 0, notes: 0 }
  let failure: string | undefined
  const encoder = new TextEncoder()
  const write = (chunk: Uint8Array, stream: keyof typeof written): void => {
    try {
      let offset = 0
      while (offset < chunk.byteLength) {
        const remaining = chunk.byteLength - offset
        const count = writeSync(file, chunk, offset, remaining)
        if (!Number.isSafeInteger(count) || count <= 0 || count > remaining) {
          throw new Error(`wrote ${String(count)} of ${String(remaining)} bytes`)
        }
        offset += count
        // Count each successful partial write, even if the next write fails.
        written[stream] += count
      }
    } catch (error) {
      failure ??= `its log at ${path} could not write ${stream} after ${String(written[stream])} bytes: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    append: (stream, chunk) => {
      observed[stream] += chunk.byteLength
      if (failure === undefined) write(chunk, stream)
    },
    note: (text) => {
      if (failure === undefined) write(encoder.encode(`\n[yrd: ${text}]\n`), "notes")
    },
    close: (result) => {
      const truncated = result?.outputTruncation ?? []
      if (truncated.length > 0) {
        // Only display-overflow acceptance needs this additional process
        // receipt. Ordinary checks retain their existing verdict semantics.
        for (const stream of ["stdout", "stderr"] as const) {
          const total = result?.rawOutput?.[stream]?.totalBytes
          const counts = `process=${String(total)}, observed=${observed[stream]}, written=${written[stream]}`
          if (
            total === undefined ||
            !Number.isSafeInteger(total) ||
            total < 0 ||
            total !== observed[stream] ||
            total !== written[stream]
          ) {
            failure ??= `its log at ${path} has no complete ${stream} raw-byte proof (${counts})`
          }
          const entries = truncated.filter((entry) => entry.stream === stream)
          if (entries.length > 1) {
            failure ??= `its log at ${path} has duplicate ${stream} truncation receipts (${counts})`
          }
          for (const entry of entries) {
            const values = [entry.totalBytes, entry.keptBytes, entry.droppedBytes, entry.limitBytes]
            if (
              values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
              entry.totalBytes !== total ||
              entry.keptBytes + entry.droppedBytes !== entry.totalBytes ||
              entry.keptBytes > entry.limitBytes ||
              entry.totalBytes <= entry.limitBytes ||
              entry.droppedBytes === 0
            ) {
              failure ??= `its log at ${path} has an inconsistent ${stream} truncation receipt (${counts}; kept=${entry.keptBytes}, dropped=${entry.droppedBytes}, limit=${entry.limitBytes})`
            }
          }
        }
        if (truncated.some((entry) => entry.stream !== "stdout" && entry.stream !== "stderr")) {
          failure ??= `its log at ${path} has a truncation receipt for an unknown stream`
        }
      }
      if (failure !== undefined) {
        // Best effort annotation of an already-failed sink. The first failure
        // remains in the returned stuck reason if this write also fails.
        write(encoder.encode(`\n[yrd: this log is INCOMPLETE — ${failure}]\n`), "notes")
      }
      try {
        const size = fstatSync(file).size
        const expected = written.stdout + written.stderr + written.notes
        if (size !== expected) {
          failure ??= `its log at ${path} has size ${size}, expected ${expected} written bytes (stdout=${written.stdout}, stderr=${written.stderr}, notes=${written.notes})`
        }
      } catch (error) {
        failure ??= `its log at ${path} could not be measured: ${error instanceof Error ? error.message : String(error)}`
      }
      try {
        closeSync(file)
      } catch (error) {
        failure ??= `its log at ${path} could not be closed: ${error instanceof Error ? error.message : String(error)}`
      }
      return failure
    },
  }
}

export async function runCheck(run: RunCheck): Promise<CheckResult> {
  const programRoot = checkedProgramRoot(run)
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
  // A check may pass through or request every other declared value, but this
  // name belongs to the queue. Remove either caller source in both modes, and
  // set it only after its declaration and absolute queue argument agreed.
  delete env.YRD_PROGRAM_ROOT
  if (programRoot !== undefined) env.YRD_PROGRAM_ROOT = programRoot
  const timeoutMs =
    (run.tier === "long" ? run.spec.long?.timeoutMs : undefined) ?? run.spec.timeoutMs ?? DEFAULT_CHECK_BOUND_MS
  delete env.YRD_CHECK_TIMEOUT_MS
  env.YRD_CHECK_TIMEOUT_MS = String(timeoutMs)
  delete env.YRD_CHECK_TIER
  env.YRD_CHECK_TIER = run.tier ?? "normal"
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
      captureRawOutput: true,
      onOutput: ({ stream, chunk }) => {
        logFile.append(stream, chunk)
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
  const logFailure = logFile.close(result)

  const base = { durationMs, log, name: run.spec.name }
  /** A stuck reason, carrying a log that could not be written alongside it. */
  const why = (reason: string): string => (logFailure === undefined ? reason : `${reason}; ${logFailure}`)
  if (result.timedOut) {
    // 24623: a comparison that already named pass/fail on this log is the
    // round's result. The bound still killed leftover work; it must not throw
    // the verdict away as yrd-check-unresolved. A check that named nothing
    // stays stuck, which is the existing "past its bound" path.
    const rescued = checkResultFromLog(log)
    if (rescued !== undefined) {
      if (rescued.result === "deferred") {
        return {
          ...base,
          exit: rescued.exit ?? "timeout",
          result: "deferred",
          why: rescued.reason,
          projectedMs: rescued.projectedMs,
          boundMs: rescued.boundMs,
        }
      }
      return { ...base, exit: rescued.result === "pass" ? 0 : 1, result: rescued.result }
    }
    const progress = checkProgressFromLog(log)
    const named = progress === undefined ? "" : `; last progress ${progress}`
    return {
      ...base,
      exit: "timeout",
      result: "stuck",
      why: why(`ran past its bound of ${timeoutMs} ms; log named no usable ${CHECK_RESULT_MARKER}${named}`),
    }
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
  // same as an incomplete raw capture: the exit code can be a clean 0 while the
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
      return { ...base, exit: result.exitCode, result: "stuck", why: "the check said it could not judge" }
    // 3 is the affected tests' cannot-judge. It is stuck like 2, never a fail
    // billed to the submitter: a check that did not judge the change has no
    // verdict about it, and a stuck change stops the line (@cto 7645ec3a).
    case 3: {
      const marker = checkResultFromLog(log)
      if (marker?.result === "deferred") {
        return {
          ...base,
          exit: result.exitCode,
          result: "deferred",
          why: marker.reason,
          projectedMs: marker.projectedMs,
          boundMs: marker.boundMs,
        }
      }
      return { ...base, exit: result.exitCode, result: "stuck", why: "the check said it could not judge" }
    }
    default:
      return { ...base, exit: result.exitCode, result: "stuck", why: `exit ${result.exitCode} is not a verdict` }
  }
}

/**
 * What `@yrd/process` says went wrong with the RUN, as opposed to what the
 * check said: a stall, a descendant that outlived the check and held its output
 * open, or a settlement signal that could not reach the process group.
 * Each is loud in the result and each means
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
  return found.length === 0 ? undefined : found.join("; ")
}
