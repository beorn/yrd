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
  /** What the run's own header record said, when the first line was one. */
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

/** Read what the runner box shows. Nothing here writes; one readdir, one stat, one first line, one pid probe. */
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
  const header = firstRecord(path)
  const pidPath = join(workdir, "worktrees", id, RUN_PID)
  const pid = existsSync(pidPath) ? readPid(pidPath) : undefined
  return {
    journalDir,
    latest: {
      alive: pid !== undefined && running(pid),
      id,
      lastWriteAt,
      startedAt,
      ...(pid === undefined ? {} : { pid }),
      ...header,
    },
  }
}

/** The run's own header record, from the first line of its journal: target, gitlink, queue, checks. */
function firstRecord(path: string): Pick<RunnerRun, "target" | "gitlink" | "queue" | "checks"> {
  let line: string
  try {
    const text = readFileSync(path, "utf8")
    line = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"))
  } catch {
    return {}
  }
  if (line.trim() === "") return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null) return {}
  const record = parsed as Record<string, unknown>
  if (record.kind !== "run") return {}
  return {
    ...(typeof record.target === "string" ? { target: record.target } : {}),
    ...(typeof record.gitlink === "string" ? { gitlink: record.gitlink } : {}),
    ...(typeof record.queue === "string" ? { queue: record.queue } : {}),
    ...(Array.isArray(record.checks) && record.checks.every((check) => typeof check === "string")
      ? { checks: record.checks as string[] }
      : {}),
  }
}

function readPid(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
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
export type RunnerHealth = "running" | "idle" | "silent" | "absent"

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
export function runnerHealth(facts: RunnerFacts, inLine: number, now: Date): RunnerHealth {
  if (facts.latest === undefined) return "absent"
  if (facts.latest.alive) return "running"
  if (inLine > 0 && now.getTime() - facts.latest.lastWriteAt.getTime() > SILENT_AFTER_MS) return "silent"
  return "idle"
}
