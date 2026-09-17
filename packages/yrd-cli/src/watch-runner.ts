/**
 * What the page knows about the runner (watch-redesign items 13, 14, 16, 17,
 * 27, 29, 37), read from yrd's own files and nothing else:
 *
 * - the newest run journal under `<workdir>/logs/`: its id (the start
 *   instant is in the name), its header record (target, gitlink, checks) and
 *   the instant it last wrote (the file's mtime: one stat, no parse);
 * - the run's `.pid` file under `<workdir>/worktrees/<run>/`, which a run
 *   writes at its start and removes when it settles, and whether that process
 *   is alive.
 *
 * The queue core has no resident status wire (deleted at M6) and the watch
 * depends on no supervisor, so this is the whole instrument. TWO pure
 * functions turn it into the runner's row on the flow page: {@link runnerWord}
 * picks one word from THE ONE WORD TABLE against one named threshold, and
 * {@link runnerLine} says what it holds, since when and whether it is alive.
 * The row renders them and never recomputes the conditions. Both are about the
 * SERVICE and never compete with `Row.live`, which alone says whether a change
 * is under a check.
 *
 * Off the queue's own machine there is no journal, and {@link RunnerFacts.absent}
 * carries the sentence that says where it looked. Never a blank, never a zero —
 * and never an invented status: the runner publishes none of its own yet, so
 * the row reads `?` there rather than a guess dressed as a reading.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { runDiedInPreamble, runStartedAt, type LogRecord, type StopFact } from "@yrd/queue-core"
import { clock, mediaDuration } from "./watch-format.ts"
import { STATE_WORDS, type RunnerState } from "./watch-words.ts"

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
  /**
   * The run threw in its Git preamble: it is not executing and it never reached
   * the queue it was for. A terminal outcome with its own cure, and deliberately
   * not the malformed-journal refusal it used to read as (24470).
   */
  unstarted?: true
}>

export type RunnerFacts = Readonly<{
  /** The directory the journals were looked for in. */
  journalDir: string
  /** Why there is no run to show, when there is none: a sentence naming what was looked for and where. */
  absent?: string
  /** The newest run journal on this machine. */
  latest?: RunnerRun
}>

/** Read what the runner's row shows. Nothing here writes; one readdir, one stat, one header read, one pid probe. */
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
  // THE HEADER'S PID OUTRANKS THE WORKTREE'S, and during a preamble it is the
  // only one there is: `claimWorktrees` does not run until after the whole Git
  // preamble (yrd-queue-core/src/run.ts:476), so for the entire window in which
  // "executing its preamble" and "died in its preamble" have to be told apart,
  // no `.pid` file exists. Reading liveness from that absence would call a run
  // three seconds old dead. The worktree pid still answers for journals written
  // before 24470, and for a run past its preamble it is the same process.
  const read = readRunHeader(path)
  const pidPath = join(workdir, "worktrees", id, RUN_PID)
  const claimed = existsSync(pidPath) ? readPid(pidPath) : undefined
  const pid = read.pid ?? claimed
  const alive = pid !== undefined && running(pid)
  const header = journalVerdict(path, read, alive)
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

/** What one journal's opening says, before anything is known about liveness. */
type JournalHead = Readonly<{
  /** The header's own fields, empty when there is no header to read. */
  fields: Pick<RunnerRun, "target" | "gitlink" | "queue" | "checks">
  /** Was a `run` record found at all. */
  headed: boolean
  /** The process the HEADER names, which is the only pid a run in its preamble has. */
  pid?: number
  /** The run never reached its queue — true of one still in its preamble as much as one that died there. */
  died: boolean
}>

/**
 * Read the run header, and the queue record that says its Git preamble finished.
 *
 * Since 24470 the header is written FIRST, before any Git call, so its absence
 * from a journal a run is no longer writing means that run threw before it could
 * write anything at all. The queue name follows as its own record once the
 * remote resolves, which is why `queue` is read from there rather than from the
 * header — a legacy journal that carries it on the header still reads.
 *
 * READS, NEVER JUDGES. Whether a run that has not reached its queue is dying or
 * merely slow is decided by {@link journalVerdict} from a pid this cannot know
 * it needs — which is why the header's own `pid` comes back with the fields.
 * Every malformed record below still refuses as loudly as it ever did.
 */
function readRunHeader(path: string): JournalHead {
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
  const records: LogRecord[] = []
  let header: Record<string, unknown> | undefined
  for (const [index, line] of lines.entries()) {
    if (header !== undefined) {
      // PAST THE HEADER the journal is the run's ordinary business, which this
      // reader neither validates nor understands. It wants one more record, the
      // `queue` row that closes the preamble, and reads the rest the way
      // `readRunLog` does: a line that is not a record is skipped, never guessed
      // at. Making those fatal here would refuse journals this box has always
      // rendered.
      let after: unknown
      try {
        after = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof after !== "object" || after === null) continue
      const record = after as Record<string, unknown>
      if (typeof record.kind !== "string") continue
      records.push(record as unknown as LogRecord)
      if (record.kind === "queue") break
      continue
    }
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
      records.push(record as unknown as LogRecord)
      continue
    }
    if (record.kind !== "run") {
      throw new Error(`${where} must have kind "run" or "git", got ${JSON.stringify(record.kind)}`)
    }
    header = record
    records.push(record as unknown as LogRecord)
  }
  // The one derivation, shared with the health probe so the two readers cannot
  // disagree about one journal. Ungated here on purpose: it is true of a run
  // still IN its preamble as well as one that died there, and only a pid tells
  // those apart.
  const died = runDiedInPreamble(records)
  if (header === undefined) return { died, fields: {}, headed: false }
  const resolved = records.find((record) => record.kind === "queue")?.queue ?? header.queue
  const pid = header.pid
  return {
    died,
    headed: true,
    ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    fields: {
      ...(typeof header.target === "string" ? { target: header.target } : {}),
      ...(typeof header.gitlink === "string" ? { gitlink: header.gitlink } : {}),
      ...(typeof resolved === "string" ? { queue: resolved } : {}),
      ...(Array.isArray(header.checks) && header.checks.every((check) => typeof check === "string")
        ? { checks: header.checks as string[] }
        : {}),
    },
  }
}

/**
 * What the journal MEANS, once the run's liveness is known.
 *
 * `alive` is the only thing separating "has not got there yet" from "never
 * will". A live run mid-preamble is IN PROGRESS and keeps whatever header
 * fields it has written; every one of them is optional on `RunnerRun` for
 * exactly this case (24478). A run that is NOT alive and stopped short of its
 * queue is `unstarted`, a named terminal outcome rather than the
 * malformed-journal refusal it used to draw.
 */
function journalVerdict(
  path: string,
  read: JournalHead,
  alive: boolean,
): Pick<RunnerRun, "target" | "gitlink" | "queue" | "checks" | "unstarted"> {
  const unstarted = !alive && read.died
  if (!read.headed) {
    if (alive) return {}
    if (unstarted) return { unstarted: true }
    throw new Error(
      `run journal ${path}: required run header was not found, and the run is not executing — ` +
        "a finished run must have written its header before its Git preamble",
    )
  }
  return { ...read.fields, ...(unstarted ? { unstarted: true as const } : {}) }
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
 * The fleet's own ceiling: a request older than ten minutes is broken, not
 * slow (CLAUDE.md), and a queue with changes in line whose journal has not
 * moved for that long is the same thing.
 */
export const SILENT_AFTER_MS = 10 * 60 * 1000

/**
 * ONE derivation of the runner's word, in THE ONE WORD TABLE's vocabulary
 * (watch-words.ts), because the flow page draws the runner as a row in the
 * same STATUS column as every change.
 *
 * The ladder, and its order is the whole safety argument:
 *
 * 1. `unstarted` — A DEFINITE OUTCOME OUTRANKS A MEASUREMENT OF SILENCE
 *    (@i/10-yrd/24470). The newest run threw in its Git preamble and is not
 *    executing: that is not a queue that has gone quiet, it is a queue that
 *    could not start, and the cure is in the journal's last Git row rather
 *    than in `hab ps`. Reporting it as silence would be true of the symptom
 *    and useless about the cause.
 * 2. `stopped` — nothing has written for {@link SILENT_AFTER_MS}, so nothing
 *    is running on this machine. The word is `stopped` and not `silent`:
 *    `silent` is read from the runner's OWN published status, which does not
 *    exist until S2, and this is read from a file mtime here (@cto, relayed by
 *    @chief cf4677f8). SILENCE OUTRANKS EVERY LIVE WORD, whatever it is
 *    called. `underCheck` is read off the rows, and a
 *    service that died mid-check leaves a row still marked live; taking that
 *    at face value would announce a check running over a dead queue — a worse
 *    lie than the one being removed, and precisely the failure 24486 exists to
 *    prevent. It outranks the stop for the same reason: a round still opens
 *    and records through a PAUSE, so a paused queue whose journal has stopped
 *    moving is a SERVICE that is down on top of a pause, which is the louder
 *    and the more actionable of the two.
 * 3. `stuck` / `paused` — the line is not moving BY DECISION, which is the
 *    answer to the question the reader is asking. The stop is the reading's
 *    own (queue-core `stopFact`), a git fact, so it is the one word this row
 *    can still say off the queue's machine.
 * 4. `checking` — a change is under a check RIGHT NOW. THE PREDICATE IS NOT
 *    "THE PROCESS EXISTS" (items 1 and 5): it used to be `facts.latest.alive`,
 *    and because the service is a long-running `yrd queue up --interval 120`
 *    under hab, that was true nearly always, so the marker said `running` in
 *    every state it existed to tell apart. `underCheck` is supplied by the
 *    caller from the SAME derivation the status pills use (`bucketOf(row) ===
 *    "running"`), so "a change is under a check" has one home and this cannot
 *    drift from the rows below it.
 * 5. `idle` — a journal that is moving and nothing under a check.
 * 6. `unpublished` — no run journal on this machine at all, and no stop to
 *    report. The runner does not publish its own status yet, so `?` is the
 *    honest answer and no source is invented to avoid printing it.
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
 * queue, nearly five times inside this ceiling. So an idle healthy queue is
 * never called silent, whatever is or is not in line.
 */
export function runnerWord(
  facts: RunnerFacts | undefined,
  now: Date,
  underCheck: boolean,
  stopped?: StopFact | null,
): RunnerState {
  const latest = facts?.latest
  if (latest !== undefined) {
    if (latest.unstarted === true) return "unstarted"
    if (now.getTime() - latest.lastWriteAt.getTime() > SILENT_AFTER_MS) return "stopped"
  }
  if (stopped !== undefined && stopped !== null) return stopped.change === null ? "paused" : "stuck"
  if (latest === undefined) return "unpublished"
  if (underCheck) return "checking"
  return "idle"
}

/** The change a check holds right now, as the runner's row draws it. */
export type HeldChange = Readonly<{ branch: string; subject?: string; submitter?: string; since: Date }>

/**
 * The runner's row, in the table's own columns: TIME is the round's start,
 * STATUS the word above, CHANGES what it holds OR why it holds nothing, BY the
 * held change's submitter, and the last cell the word and how long.
 *
 * {@link RunnerLine.detail} is the second, indented line, and it is NEVER
 * blank: off the queue's machine it says so and says where it looked, because
 * a blank line where a fact belongs reads as a queue with nothing to say.
 */
export type RunnerLine = Readonly<{
  state: RunnerState
  /** When this round started; absent when no journal was read on this machine. */
  at?: Date
  /** What it holds, or why it holds nothing. */
  holds: string
  /** The held change's submitter. */
  by?: string
  /** The duration cell: the word and how long it has been true. */
  duration?: string
  /** Host-only detail, and the sentence that says so when there is none. */
  detail: string
}>

/**
 * Everything the runner's row says, derived once. Pure: every input was read
 * by the round that drew the page, and nothing here opens a file or a ref.
 */
export function runnerLine(
  facts: RunnerFacts | undefined,
  now: Date,
  options: Readonly<{ held?: HeldChange; waiting?: number; stopped?: StopFact | null }> = {},
): RunnerLine {
  const { held, waiting = 0, stopped } = options
  const state = runnerWord(facts, now, held !== undefined, stopped)
  const latest = facts?.latest
  const word = STATE_WORDS[state].word
  const since = (at: Date): string => mediaDuration(now.getTime() - at.getTime())
  const beat = latest === undefined ? undefined : since(latest.lastWriteAt)
  const at = latest === undefined ? {} : { at: latest.startedAt }
  // Never a blank: with a journal this says the beat, the round and the
  // checks; without one it says where it looked and that nothing is published.
  const detail =
    latest === undefined
      ? `${facts?.absent ?? "no run journal was read on this machine"} · the runner publishes no status of its own yet, so this row says only what this machine can see`
      : [
          `${latest.alive ? "alive" : "no process"}: beat ${String(beat)} ago`,
          `this round since ${clock(latest.startedAt, { seconds: true })}`,
          `${latest.checks === undefined ? "the run's header record was not read" : latest.checks.join(", ")}, output ${String(beat)} ago (this machine only)`,
        ].join(" · ")
  switch (state) {
    case "checking":
    case "merging": {
      const holding = held as HeldChange
      return {
        ...at,
        detail,
        duration: `${word} ${since(holding.since)}`,
        holds: `${holding.branch}${holding.subject === undefined ? "" : ` ${holding.subject}`}`,
        state,
        ...(holding.submitter === undefined ? {} : { by: holding.submitter }),
      }
    }
    case "stuck":
    case "paused": {
      const stop = stopped as StopFact
      const at2 = new Date(stop.since)
      const change = stop.change === null ? undefined : stop.change.slice(0, stop.change.lastIndexOf("@"))
      return {
        ...at,
        // NOT the pause record's own sentence: that is the loud line at the top
        // of the page and it is said exactly once (watch-frame.tsx LoudPause).
        // This row says the WORD, who stopped the line and what lifts it.
        detail,
        duration: `${word} ${since(at2)}`,
        holds:
          change === undefined
            ? `the line is stopped${stop.by === "" ? "" : ` by ${stop.by}`} since ${clock(at2)} — resume with yrd queue resume`
            : `the line stopped at ${change} since ${clock(at2)} — merge the fix, yrd queue withdraw ${change}, or yrd queue resume`,
        state,
      }
    }
    case "stopped": {
      return {
        ...at,
        detail,
        duration: `${word} ${String(beat)}`,
        holds: `no journal write for ${String(beat)}${waiting === 0 ? ", and nothing is in line, so a change submitted now would not be picked up" : ` while ${String(waiting)} ${waiting === 1 ? "change waits" : "changes wait"} in line`}`,
        state,
      }
    }
    case "unstarted": {
      const run = latest as RunnerRun
      return {
        ...at,
        detail: `${join(facts?.journalDir ?? "", `${run.id}.jsonl`)} — its last Git row names the call that failed`,
        duration: `${word} ${String(beat)}`,
        holds: `run ${run.id} died in its Git preamble before it could read its queue`,
        state,
      }
    }
    case "unpublished": {
      return { detail, holds: "no runner status is published for this queue", state }
    }
    default: {
      return {
        ...at,
        detail,
        ...(beat === undefined ? {} : { duration: `${word} ${beat}` }),
        holds: waiting === 0 ? "nothing in line" : `nothing under a check, and ${String(waiting)} in line`,
        state,
      }
    }
  }
}
