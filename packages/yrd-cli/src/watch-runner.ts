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

/**
 * The one word the box renders.
 *
 * `processing` REPLACES `running`, and the word follows the predicate rather
 * than the other way round (spec items 1 and 5, ruled by @chief 2026-09-11).
 * The ported marker said `running` whenever the service PROCESS was up, which
 * is nearly always, so it separated nothing; the operator's question is whether
 * a change is under a check RIGHT NOW.
 */
export type RunnerHealth = "processing" | "idle" | "silent" | "absent"

/**
 * The fleet's own ceiling: a request older than ten minutes is broken, not
 * slow (CLAUDE.md), and a queue with changes in line whose journal has not
 * moved for that long is the same thing.
 */
export const SILENT_AFTER_MS = 10 * 60 * 1000

/**
 * ONE derivation of the service's health. `absent` when there is no journal on
 * this machine at all; `silent` when nothing has written for
 * {@link SILENT_AFTER_MS}; `processing` when a change is under a check right
 * now; `idle` otherwise.
 *
 * THE PREDICATE IS NOT "THE PROCESS EXISTS" (items 1 and 5). It used to be
 * `facts.latest.alive`, and because the service is a long-running
 * `yrd queue up --interval 120` under hab, that was true nearly always: the
 * marker said `running` in every state it existed to tell apart. It also
 * short-circuited ABOVE the silence check, so a live process whose journal had
 * stopped moving still read healthy -- the wedged case, masked by the very
 * process that was wedged.
 *
 * `underCheck` is supplied by the caller from the SAME derivation the status
 * pills use (`bucketOf(row) === "running"`, i.e. `row.live !== undefined`), so
 * "a change is under a check" has one home and the marker cannot drift from the
 * list beside it. It is not a proxy: it is the fact itself, already on the row.
 *
 * SILENCE DOES NOT WAIT FOR A QUEUE (@i/10-yrd/24486). It used to also require
 * a change in line, on the reading that silence only matters while something
 * waits. It matters more when nothing does: that is the state a submitter
 * ARRIVES INTO, and they submit on the strength of it. Measured 2026-09-11
 * during an outage — three rows sat queued with no live check on any of them
 * while the service was down, and a fourth seat submitted into it, because
 * every row read `queued`, which is what a row reads when the queue is healthy
 * and merely busy.
 *
 * The journal is a heartbeat and that is what makes the weaker condition
 * sound: a round writes one whether or not it has work, so the newest mtime
 * moves on the service's own cadence — measured at about 2:05 on the live
 * queue, nearly five times inside this ceiling — and it keeps moving through a
 * PAUSE, where a round still opens and records before it stops. So an idle
 * healthy queue is never called silent, whatever is or is not in line.
 */
export function runnerHealth(facts: RunnerFacts, now: Date, underCheck: boolean): RunnerHealth {
  if (facts.latest === undefined) return "absent"
  // SILENCE OUTRANKS PROCESSING, and the order is the whole safety argument.
  // `underCheck` is read off the rows, and a service that died mid-check leaves
  // a row still marked live; taking that at face value would announce
  // `processing` over a dead queue -- a worse lie than the one being removed,
  // and precisely the failure 24486 exists to prevent. A journal that has not
  // moved for the ceiling is silent whatever the rows claim.
  if (now.getTime() - facts.latest.lastWriteAt.getTime() > SILENT_AFTER_MS) return "silent"
  if (underCheck) return "processing"
  return "idle"
}

/**
 * The runner, as a machine reader sees it (@i/10-yrd/24486 row 5).
 *
 * The human page has had this since the RUNNER box landed — one word and a
 * duration, on every row state. `--json` had nothing: `changes`, `journal`,
 * `observation`, `pause`, and no way to ask whether anything was polling. That
 * gap is what produced this bead's own second specimen, `queued rows: 3 | any
 * running: False` — a script that could count the line but could not tell that
 * nothing was working it, while a fourth seat submitted into the outage because
 * every row read `queued`, which is what a row reads when the queue is healthy
 * and merely busy.
 *
 * Same {@link runnerHealth} the box renders, so the page and the payload cannot
 * disagree; this shapes the facts and derives nothing of its own. `absent`
 * carries the sentence naming where it looked — never a blank, never a zero.
 */
export type RunnerFact = Readonly<{
  health: RunnerHealth
  /** Where the journals were looked for; present whatever the health. */
  journalDir: string
  /** Why there is no run to show, when there is none. */
  absent?: string
  latestRun?: Readonly<{
    id: string
    startedAt: string
    lastWriteAt: string
    /** Milliseconds since the journal last moved: the number `silent` is decided on. */
    sinceWriteMs: number
    pid?: number
  }>
}>

export function runnerFact(facts: RunnerFacts, now: Date, underCheck: boolean): RunnerFact {
  const latest = facts.latest
  return {
    health: runnerHealth(facts, now, underCheck),
    journalDir: facts.journalDir,
    ...(facts.absent === undefined ? {} : { absent: facts.absent }),
    ...(latest === undefined
      ? {}
      : {
          latestRun: {
            id: latest.id,
            startedAt: latest.startedAt.toISOString(),
            lastWriteAt: latest.lastWriteAt.toISOString(),
            sinceWriteMs: now.getTime() - latest.lastWriteAt.getTime(),
            ...(latest.pid === undefined ? {} : { pid: latest.pid }),
          },
        }),
  }
}
