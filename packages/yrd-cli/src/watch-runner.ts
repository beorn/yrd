/**
 * What the RUNNER box knows about the service (watch-redesign items 13, 14,
 * 16, 17, 27, 29, 37), read from yrd's own files and nothing else:
 *
 * - the newest run journal under `<workdir>/logs/`: its id (the start
 *   instant is in the name), its header record (target, gitlink, checks) and
 *   the instant it last wrote (the file's mtime: one stat, no parse);
 * - the run's `.pid` file under `<workdir>/worktrees/<run>/`, which a run
 *   writes at its start and removes when it settles, and whether that process
 *   is alive.
 *
 * The queue core has no resident status wire (deleted at M6) and the watch
 * depends on no supervisor, so this is the whole instrument. ONE pure
 * function, {@link runnerHealth}, turns it into one of four words with one
 * named threshold; the box renders the word and never recomputes the
 * conditions. It is about the SERVICE and never competes with `Row.live`,
 * which alone says whether a change is under a check.
 *
 * Off the queue's own machine there is no journal, and {@link RunnerFacts.absent}
 * carries the sentence that says where it looked. Never a blank, never a zero.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { runStartedAt } from "@yrd/queue-core"

/** The run's `.pid` file name, as `claimWorktrees` in the core spells it. */
const RUN_PID = ".pid"

export type RunnerRun = Readonly<{
  id: string
  startedAt: Date
  /** The instant the journal was last appended to: the file's mtime. */
  lastWriteAt: Date
  /** What the run's own header record said, after any initial Git evidence. */
  target?: string
  gitlink?: string
  queue?: string
  checks?: readonly string[]
  /** The process the run's `.pid` file names, when the file is still there. */
  pid?: number
  /** True when that process answers `kill -0`: the run is executing right now. */
  alive: boolean
}>

export type RunnerFacts = Readonly<{
  /** The directory the journals were looked for in. */
  journalDir: string
  /** Why there is no run to show, when there is none: a sentence naming what was looked for and where. */
  absent?: string
  /** The newest run journal on this machine. */
  latest?: RunnerRun
}>

/** Read what the runner box shows. Nothing here writes; one readdir, one stat, one header read, one pid probe. */
export function readRunnerFacts(workdir: string): RunnerFacts {
  const journalDir = join(workdir, "logs")
  let names: readonly string[]
  try {
    names = readdirSync(journalDir)
  } catch (error) {
    const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? "there is no such directory" : String(error)
    return { absent: `no run journal was read: ${journalDir} — ${why}`, journalDir }
  }
  const ours = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .filter((id) => runStartedAt(id) !== undefined)
    .sort()
  const id = ours.at(-1)
  const startedAt = id === undefined ? undefined : runStartedAt(id)
  if (id === undefined || startedAt === undefined) {
    return { absent: `no run journal was read: ${journalDir} — it holds no run journal`, journalDir }
  }
  const path = join(journalDir, `${id}.jsonl`)
  const lastWriteAt = statSync(path).mtime
  // Liveness BEFORE the header read. A run that is still executing has
  // legitimately not written its header yet: the header carries `queue`, which
  // the writer can only compute after Git reads that are themselves journaled
  // (yrd-queue-core/src/run.ts), so a Git preamble always precedes it. Reading
  // the header first turned "not written yet" into "malformed journal", and
  // `latest` selects the NEWEST journal — the one most likely to be in flight.
  const pidPath = join(workdir, "worktrees", id, RUN_PID)
  const pid = existsSync(pidPath) ? readPid(pidPath) : undefined
  const alive = pid !== undefined && running(pid)
  const header = readRunHeader(path, alive)
  return {
    journalDir,
    latest: {
      alive,
      id,
      lastWriteAt,
      startedAt,
      ...(pid === undefined ? {} : { pid }),
      ...header,
    },
  }
}

/**
 * Read the run header after any Git evidence written while resolving its queue.
 *
 * `alive` says whether the run is executing RIGHT NOW. A live run that has not
 * reached its header yet is IN PROGRESS, not malformed, and returns no header
 * fields — every one of them is optional on `RunnerRun` for exactly this case.
 * A run that is NOT alive and still has no header is a real defect and throws,
 * as loudly as before: the guard keeps its teeth, it just stops mistaking
 * "not yet" for "absent". Every malformed-record refusal below is unchanged.
 */
function readRunHeader(path: string, alive: boolean): Pick<RunnerRun, "target" | "gitlink" | "queue" | "checks"> {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    throw new Error(`run journal ${path}: required run header cannot be read: ${errorDetail(error)}`, {
      cause: error,
    })
  }
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  for (const [index, line] of lines.entries()) {
    const where = `run journal ${path}: record ${index + 1} before the run header`
    if (line.trim() === "") throw new Error(`${where} is empty`)
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw new Error(`${where} is not JSON: ${errorDetail(error)}`, { cause: error })
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`${where} must be a run or Git object`)
    }
    const record = parsed as Record<string, unknown>
    if (record.kind === "git") {
      if (typeof record.run !== "string" || typeof record.at !== "string" || typeof record.evidence !== "string") {
        throw new Error(`${where}: Git evidence requires run, at and evidence strings`)
      }
      continue
    }
    if (record.kind !== "run") {
      throw new Error(`${where} must have kind "run" or "git", got ${JSON.stringify(record.kind)}`)
    }
    return {
      ...(typeof record.target === "string" ? { target: record.target } : {}),
      ...(typeof record.gitlink === "string" ? { gitlink: record.gitlink } : {}),
      ...(typeof record.queue === "string" ? { queue: record.queue } : {}),
      ...(Array.isArray(record.checks) && record.checks.every((check) => typeof check === "string")
        ? { checks: record.checks as string[] }
        : {}),
    }
  }
  if (alive) return {}
  throw new Error(
    `run journal ${path}: required run header was not found, and the run is not executing — ` +
      "a finished run must have written its header after its Git preamble",
  )
}

function readPid(path: string): number | undefined {
  let text: string
  try {
    text = readFileSync(path, "utf8").trim()
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      // silent-fallback-allow: the run may remove its pid file after existsSync; absence means no live run while every other read failure throws.
      return undefined
    }
    throw new Error(`run pid file ${path}: cannot be read: ${errorDetail(error)}`, { cause: error })
  }
  const pid = Number(text)
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`run pid file ${path}: expected a positive safe integer, got ${JSON.stringify(text)}`)
  }
  return pid
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The one word the box renders. */
export type RunnerHealth = "processing" | "idle" | "silent" | "absent"

/**
 * The fleet's own ceiling: a request older than ten minutes is broken, not
 * slow (CLAUDE.md), and a queue with changes in line whose journal has not
 * moved for that long is the same thing.
 */
export const SILENT_AFTER_MS = 10 * 60 * 1000

/**
 * ONE derivation of the service's health. `running` while the newest run's
 * process is alive; `absent` when there is no journal on this machine at all;
 * `silent` when changes wait in line and nothing has written for
 * {@link SILENT_AFTER_MS}; `idle` otherwise.
 */
/**
 * IS A CHANGE UNDER A CHECK RIGHT NOW? The ruled predicate, named so it can be
 * tested and audited rather than living as a filter expression in the frame.
 *
 * A row carries `live` only while the runner holds a check open on it
 * (`yrd-queue-core/src/table.ts`: run, check, phase, since). That IS the
 * question, not a stand-in for it.
 */
export function changeUnderCheck(rows: readonly { readonly row: { readonly live?: unknown } }[]): boolean {
  return rows.some((item) => item.row.live !== undefined)
}

/**
 * The one word, and its predicate is A CHANGE IS UNDER A CHECK RIGHT NOW.
 *
 * It used to be `facts.latest.alive` — THE SERVICE PROCESS EXISTS — which is
 * nearly always true, so the marker reported the same value in exactly the case
 * it exists to separate and tracked nothing the reader cares about. Ruled by
 * @chief 2026-09-11, restoring the 2026-08-18 spec rather than changing it.
 *
 * `underCheck` is measured, not inferred: a row carries `live` only while the
 * runner has a check open on it (`yrd-queue-core/src/table.ts`), naming the run,
 * check and phase. No proxy was synthesised — had the data carried only
 * run-level state, the ruling says to report that rather than invent one.
 *
 * SILENCE IS TESTED FIRST, deliberately. A runner that dies mid-check leaves
 * `live` set on its row forever, so asking `underCheck` first would report
 * `processing` for all time and rebuild the always-true defect in a new place.
 * A stalled writer is evidence about the runner; a row's `live` is only a claim
 * it made before it stopped.
 */
export function runnerHealth(facts: RunnerFacts, inLine: number, now: Date, underCheck: boolean): RunnerHealth {
  if (facts.latest === undefined) return "absent"
  if (inLine > 0 && now.getTime() - facts.latest.lastWriteAt.getTime() > SILENT_AFTER_MS) return "silent"
  if (underCheck) return "processing"
  return "idle"
}
