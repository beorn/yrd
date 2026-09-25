/**
 * What the page knows about the runner (watch-redesign items 13, 14, 16, 17,
 * 27, 29, 37), read from yrd's own files and nothing else:
 *
 * - the newest run journal under `<workdir>/logs/`: its id (the start
 *   instant is in the name), its header record (target, gitlink, checks) and
 *   the instant it last wrote (the file's mtime: one stat, no parse);
 * - the run's `.pid` file under `<workdir>/worktrees/<run>/`, which a run
 *   writes at its start and removes when it settles, and whether that process
 *   is alive;
 * - the SERVICE's own health document, `service-health.json`, read through this
 *   package's existing reader. The loop restates that document on a heartbeat
 *   that keeps firing through open rounds, idle sleeps and a stopped line alike
 *   (@i/4-supervision/24523 D6), which makes it the ONE liveness instrument
 *   here. A run journal's mtime is not one and never becomes one: a check
 *   writes nothing to its journal until it ends, so any reading that called a
 *   quiet journal dead called every round longer than its threshold dead too.
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
import {
  runDiedInPreamble,
  runStartedAt,
  serviceStoppedLine,
  type LogRecord,
  type QueueHealthDocument,
  type ServiceIntentFact,
  type StopFact,
} from "@yrd/queue-core"
import { readQueueHealth, SERVICE } from "./queue-health.ts"
import { clock, mediaDuration } from "./watch-format.ts"
import { STATE_WORDS, type RunnerState } from "./watch-words.ts"

/** The run's `.pid` file name, as `claimWorktrees` in the core spells it. */
const RUN_PID = ".pid"

export type ActiveRunnerStep = Readonly<{
  kind: "step" | "check"
  name: string
  phase: string
  branch?: string
  head?: string
  target?: string
  base?: string
  start: Date
}>

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
  effectiveChecks?: readonly string[]
  activeStep?: ActiveRunnerStep
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

export type RoundLockHolder = Readonly<{
  command: string
  pid: number
  since: string
}>

/**
 * What the SERVICE's own health document says about the loop that publishes it.
 *
 * Four outcomes with four different cures, kept apart for the reason the reader
 * itself gives (queue-health.ts): collapsing any two of them is the
 * silent-error shape.
 *
 * - `absent` — no document here. Nothing was started in this workdir, or a hand
 *   `yrd queue run` did the work, which writes no document at all (24523 C5).
 * - `beating` — believable by its OWN deadline, and its writer answers.
 * - `stopped` — past that deadline, or believable with its writer gone.
 * - `unreadable` — a file that is there and is not a document. That is a defect
 *   in the WRITER and says nothing about the process, so it decides no word;
 *   the next heartbeat clears it, and until then it is loud on the detail line.
 */
export type RunnerService =
  | Readonly<{ kind: "absent"; why: string }>
  | Readonly<{ kind: "beating"; state: string; since?: Date; flow?: RunnerFlow }>
  // `graceful`: the service wrote its own stop (25430). False is a stop outside one — a SIGKILL, a crash, a
  // silent writer — and its `why` names where the supervisor's record is.
  | Readonly<{ kind: "stopped"; graceful: boolean; why: string; cause: string; since?: Date; stopReason?: string }>
  | Readonly<{ kind: "unreadable"; why: string }>

/**
 * The line's flow as the service's own document states it (25669): how long
 * waiting changes have gone unjudged, whether that is past the round budget,
 * and the stall when the service judged one. Read, never recomputed: the `up`
 * loop is the one home for the stall clock, and this is its last statement.
 */
export type RunnerFlow = Readonly<{
  waiting: number
  unjudgedForMs: number
  slow: boolean
  stallAfterMs: number
  stalledForMs?: number
}>

export type RunnerFacts = Readonly<{
  /** The directory the journals were looked for in. */
  journalDir: string
  /** Why there is no run to show, when there is none: a sentence naming what was looked for and where. */
  absent?: string
  /** The newest run journal on this machine. */
  latest?: RunnerRun
  /** What the service's own heartbeat document says: the ONE liveness reading. */
  service: RunnerService
  /** Round lock holder if currently held by an active process. */
  roundLockHolder?: RoundLockHolder
}>

/** The document's flow fact, when it states one with waiting changes; an older writer states none. */
function runnerFlow(document: QueueHealthDocument): RunnerFlow | undefined {
  const flow = document.facts?.flow
  if (typeof flow !== "object" || flow === null) return undefined
  const { waiting, unjudgedForMs, slow, stallAfterMs, stalledForMs } = flow as Readonly<Record<string, unknown>>
  if (typeof waiting !== "number" || typeof unjudgedForMs !== "number" || typeof slow !== "boolean") return undefined
  if (typeof stallAfterMs !== "number") return undefined
  return { slow, stallAfterMs, unjudgedForMs, waiting, ...(typeof stalledForMs === "number" ? { stalledForMs } : {}) }
}

/** The pid the health document names as its writer, when it names one. */
function writerPid(document: QueueHealthDocument): number | undefined {
  const runner = document.facts?.runner
  if (typeof runner !== "object" || runner === null) return undefined
  const pid = (runner as Readonly<Record<string, unknown>>).pid
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * The service's pulse, read through the package's OWN reader
 * ({@link readQueueHealth}) rather than a second one written here.
 *
 * THE FRESHNESS RULE IS NOT RE-DERIVED. The writer declares `staleAfter =
 * intervalMs + graceMs` and `believableHealthDocument` applies it; nothing
 * below recomputes a deadline or picks a threshold, because a reader with its
 * own opinion about freshness is a second opinion on the one thing the writer
 * is authoritative about. hab's start gate reads exactly this document, and so
 * does `yrd queue health`; this is the same reading, drawn as a word.
 */
export async function readRunnerService(workdir: string, now: Date = new Date()): Promise<RunnerService> {
  const document = await readQueueHealth(workdir, SERVICE, now)
  // A graceful stop's last document (25430): who stopped the service and why,
  // as the supervisor's intent file said, beside the line's own "stopped by".
  const serviceStopped = serviceStoppedFact(document)
  if (serviceStopped !== undefined) {
    const since = new Date(Date.parse(serviceStopped.since))
    return {
      cause: "the service wrote this as its last document when it was stopped",
      graceful: true,
      kind: "stopped",
      why: serviceStoppedLine(serviceStopped, Number.isNaN(since.getTime()) ? serviceStopped.since : clock(since)),
      ...(serviceStopped.reason === undefined ? {} : { stopReason: serviceStopped.reason }),
      ...(Number.isNaN(since.getTime()) ? {} : { since }),
    }
  }
  if (document.state === "absent") {
    // The reader carries the sentence on `facts.why`, never on `error`: an
    // `absent` document with a typed error is refused by the supervisor's own
    // parser, which is why it is not there to read.
    const why = document.facts?.why
    return { kind: "absent", why: typeof why === "string" ? why : `no health document under ${workdir}` }
  }
  if (document.state === "unknown") {
    return { kind: "unreadable", why: document.error?.cause ?? "the health document could not be read" }
  }
  if (document.error?.code === "queue-round-overdue") {
    const staleAfter = document.facts?.staleAfter
    const since = typeof staleAfter === "string" ? new Date(Date.parse(staleAfter)) : undefined
    return {
      cause: document.error.cause,
      graceful: false,
      kind: "stopped",
      why: outsideGracefulStop(document),
      ...(since === undefined || Number.isNaN(since.getTime()) ? {} : { since }),
    }
  }
  const pid = writerPid(document)
  // Believable, and its writer is gone. A document outlives its writer by up to
  // one heartbeat plus grace, and this is what closes that window: @cto's "no
  // runner process", read from the loop's own declared liveness rather than
  // from anybody's silence.
  if (pid !== undefined && !running(pid)) {
    return {
      cause: `the health document names process ${String(pid)} as its writer, and that process does not answer`,
      graceful: false,
      kind: "stopped",
      why: outsideGracefulStop(document),
    }
  }
  const runner = document.facts?.runner as Readonly<Record<string, unknown>> | undefined
  const startedAt = typeof runner?.startedAt === "string" ? new Date(Date.parse(runner.startedAt)) : undefined
  const since = startedAt !== undefined && !Number.isNaN(startedAt.getTime()) ? startedAt : undefined
  const flow = runnerFlow(document)
  return {
    kind: "beating",
    state: document.state,
    ...(since === undefined ? {} : { since }),
    ...(flow === undefined ? {} : { flow }),
  }
}

/** The graceful stop's own fact, when this is the document a stopping service left (25430). */
function serviceStoppedFact(document: QueueHealthDocument): ServiceIntentFact | undefined {
  const fact = document.facts?.serviceStopped
  if (typeof fact !== "object" || fact === null) return undefined
  const { by, reason, since } = fact as Readonly<Record<string, unknown>>
  if (typeof since !== "string") return undefined
  return {
    since,
    ...(typeof by === "string" ? { by } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  }
}

/**
 * A document with no graceful stop in it whose writer is gone or silent: the
 * service stopped without leaving its reason — a SIGKILL, a crash, a held
 * event loop. Never an invented reason: the supervisor's record is the place
 * to read what happened (25430).
 */
function outsideGracefulStop(document: QueueHealthDocument): string {
  const writtenAt = document.facts?.writtenAt
  const since = typeof writtenAt === "string" ? writtenAt : "an unrecorded instant"
  return `stopped outside a graceful stop since ${since}; hab ps ${SERVICE} has the supervisor's record`
}

/** Read what the runner's row shows. Nothing here writes; one readdir, one stat, two file reads, two pid probes. */
export async function readRunnerFacts(workdir: string, now: Date = new Date()): Promise<RunnerFacts> {
  const service = await readRunnerService(workdir, now)
  const journalDir = join(workdir, "logs")
  let names: readonly string[]
  try {
    names = readdirSync(journalDir)
  } catch (error) {
    const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? "there is no such directory" : String(error)
    return { absent: `no run journal was read: ${journalDir} — ${why}`, journalDir, service }
  }
  const ours = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .filter((id) => runStartedAt(id) !== undefined)
    .sort()
  const id = ours.at(-1)
  const startedAt = id === undefined ? undefined : runStartedAt(id)
  if (id === undefined || startedAt === undefined) {
    return { absent: `no run journal was read: ${journalDir} — it holds no run journal`, journalDir, service }
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
  const lockPath = join(workdir, "round.lock")
  let roundLockHolder: RoundLockHolder | undefined
  if (existsSync(lockPath)) {
    try {
      const body = readFileSync(lockPath, "utf8").trim()
      if (body !== "") {
        const parsed = JSON.parse(body) as Record<string, unknown>
        if (typeof parsed === "object" && parsed !== null && typeof parsed.pid === "number" && running(parsed.pid)) {
          roundLockHolder = {
            command: typeof parsed.command === "string" ? parsed.command : "yrd",
            pid: parsed.pid,
            since: typeof parsed.since === "string" ? parsed.since : "",
          }
        }
      }
    } catch {
      // silent-fallback-allow: unreadable lock body means no usable holder
    }
  }
  return {
    journalDir,
    service,
    ...(roundLockHolder === undefined ? {} : { roundLockHolder }),
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
  fields: Pick<RunnerRun, "target" | "gitlink" | "queue" | "checks" | "effectiveChecks">
  /** Was a `run` record found at all. */
  headed: boolean
  /** The process the HEADER names, which is the only pid a run in its preamble has. */
  pid?: number
  /** The run never reached its queue — true of one still in its preamble as much as one that died there. */
  died: boolean
  /** The step or check currently running, if any. */
  activeStep?: ActiveRunnerStep
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
  const openSteps: ActiveRunnerStep[] = []
  for (const [index, line] of lines.entries()) {
    if (header !== undefined) {
      // PAST THE HEADER the journal is the run's ordinary business, which this
      // reader neither validates nor understands. It reads steps and checks to
      // track the active step, skipping unparseable lines as readRunLog does.
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
      if (record.kind === "step" || record.kind === "check") {
        const kind = record.kind as "step" | "check"
        const name = typeof record.name === "string" ? record.name : ""
        const phase = typeof record.phase === "string" ? record.phase : ""
        const startStr = typeof record.start === "string" ? record.start : undefined
        const endStr = typeof record.end === "string" ? record.end : undefined
        const branch = typeof record.branch === "string" ? record.branch : undefined
        const head = typeof record.head === "string" ? record.head : undefined
        const target = typeof record.target === "string" ? record.target : undefined
        const base = typeof record.base === "string" ? record.base : undefined

        if (startStr !== undefined) {
          if (endStr !== undefined) {
            const idx = openSteps.findLastIndex(
              (s) =>
                s.kind === kind &&
                s.name === name &&
                s.phase === phase &&
                s.branch === branch &&
                s.head === head &&
                s.target === target,
            )
            if (idx >= 0) openSteps.splice(idx, 1)
          } else {
            const start = new Date(startStr)
            openSteps.push({
              kind,
              name,
              phase,
              branch,
              head,
              target,
              base,
              start: Number.isNaN(start.getTime()) ? new Date() : start,
            })
          }
        }
      }
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
  const activeStep = openSteps.at(-1)
  return {
    activeStep,
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
      ...(Array.isArray(header.effectiveChecks) && header.effectiveChecks.every((check) => typeof check === "string")
        ? { effectiveChecks: header.effectiveChecks as string[] }
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
): Pick<RunnerRun, "target" | "gitlink" | "queue" | "checks" | "effectiveChecks" | "activeStep" | "unstarted"> {
  const unstarted = !alive && read.died
  if (!read.headed) {
    if (alive) return {}
    if (unstarted) return { unstarted: true }
    throw new Error(
      `run journal ${path}: required run header was not found, and the run is not executing — ` +
        "a finished run must have written its header before its Git preamble",
    )
  }
  return {
    ...read.fields,
    ...(alive && read.activeStep !== undefined ? { activeStep: read.activeStep } : {}),
    ...(unstarted ? { unstarted: true as const } : {}),
  }
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
 * ONE derivation of the runner's word, in THE ONE WORD TABLE's vocabulary
 * (watch-words.ts), because the flow page draws the runner as a row in the same
 * STATUS column as every change.
 *
 * The ladder, and every rung of it is a fact somebody WROTE DOWN:
 *
 * 1. `stuck` / `paused` — the line is not moving BY DECISION, read from the
 *    queue's own stop record (queue-core `stopFact`). It is first because it is
 *    a GIT fact and so is readable from any clone: a stop outranks both a live
 *    check and a missing journal, because a stop halts the line and a row still
 *    marked live under one is the residue of a run that ended.
 * 2. `stopped` — the service's own health document is past the deadline its
 *    WRITER declared, or is believable and names a writer that does not answer.
 *    Not silence, and not a threshold picked here: {@link readRunnerService}.
 * 3. `checking` — a change is under a check RIGHT NOW **and** the document is
 *    believable. THE PREDICATE IS NOT "THE PROCESS EXISTS" (items 1 and 5): it
 *    used to be `facts.latest.alive`, and because the service is a long-running
 *    `yrd queue up --interval 120` under hab, that was true nearly always, so
 *    the marker said `running` in every state it existed to tell apart.
 *    `underCheck` is supplied by the caller from the SAME derivation the status
 *    pills use (`bucketOf(row) === "running"`, i.e. `row.live !== undefined`),
 *    so "a change is under a check" has one home and this cannot drift from the
 *    rows below it. A live row over an unbelievable document is the residue of
 *    a death, and `bandOf` sends it back to waiting while this row says why.
 * 4. `idle` — the document is believable and nothing is live.
 * 5. `?` — nothing local to read at all: no document and no journal. The runner
 *    publishes no status of its own yet, so off its machine there is nothing to
 *    read and the row says so. An implementer who invents a source to avoid
 *    printing `?` has broken S2's acceptance before S2 starts.
 *
 * THE HAND-RUNNER EDGE, last because it is the residue of the ladder: a journal
 * and no usable document, which is what `yrd queue run` by hand leaves behind
 * (24523 C5) — it writes no document at all. The only local liveness fact left
 * is the run's own pid, read above, so under a live check row a run that does
 * not answer reads `stopped` and one that does reads `checking`, which is the
 * same rung 3 with the run's pid standing in for the document. Nothing live
 * reads `idle`.
 *
 * `checking` rather than `idle` there is deliberate: the alternative draws a
 * page that contradicts itself three times over, measured 2026-09-17 on a
 * rendered hand-runner page — the header line says `checking task/x for
 * 30:00`, the change's own row says `checking`, and the runner's row between
 * them says `idle · nothing in line` above its own second line saying `alive`.
 * `holdsChange` then reads false, so the change under a check is drawn in the
 * WAITING band under a rule counting it as waiting.
 *
 * NOTHING HERE MEASURES SILENCE, and that is a ruling, not an oversight (@cto,
 * relayed by @chief). `silent` is read from the beat the runner publishes at
 * `refs/yrd/<queue>/runner` from S2. It is NOT derived from a journal's mtime,
 * and neither is any other word: {@link RunnerFacts.latest} still carries
 * `lastWriteAt` because the row's second line reports it as an age, and a
 * reading that turned that age into a word printed a red `stopped` over every
 * check that ran longer than the threshold.
 *
 * The incident this ladder answers is @i/10-yrd/24486 — measured 2026-09-11
 * during an outage, three rows sat queued with no live check on any of them
 * while the service was down, and a fourth seat submitted into it, because
 * every row read `queued`, which is what a row reads when the queue is healthy
 * and merely busy. A dead queue cannot read `idle` here: rung 2 is above it.
 */
export function runnerWord(
  facts: RunnerFacts | undefined,
  underCheck: boolean,
  stopped?: StopFact | null,
): RunnerState {
  if (stopped !== undefined && stopped !== null) return stopped.change === null ? "paused" : "stuck"
  switch (facts?.service.kind) {
    case "stopped":
      return "stopped"
    case "beating": {
      if (facts.latest?.activeStep !== undefined) {
        return facts.latest.activeStep.phase === "merge" ? "merging" : "checking"
      }
      return underCheck ? "checking" : "idle"
    }
    default:
      // `absent` and `unreadable` alike: no document to read a word from. The
      // defect an unreadable one is stays loud on the detail line rather than
      // being dressed up as a claim about the process.
      break
  }
  if (facts?.latest === undefined) return "unpublished"
  if (facts.latest.alive && facts.latest.activeStep !== undefined) {
    return facts.latest.activeStep.phase === "merge" ? "merging" : "checking"
  }
  // No document, so the run's own pid is the liveness fact. Nothing is claimed
  // about a SERVICE here, because on this edge there is not one to claim it of.
  if (!underCheck) return "idle"
  return facts.latest.alive ? "checking" : "stopped"
}

/** The change a check holds right now, as the runner's row draws it. */
export type HeldChange = Readonly<{ branch: string; subject?: string; submitter?: string; since: Date }>

/**
 * The runner's row, in the table's own columns: TIME is the round's start,
 * STATUS the word above, CHANGES what it holds OR why it holds nothing, BY the
 * held change's submitter, and the last cell the word and how long.
 *
 * {@link RunnerLine.detail} is the second, indented line, and it is NEVER
 * blank: off the queue's machine it says so and says that the check output is
 * on the queue's machine only, because a blank line where a fact belongs reads
 * as a queue with nothing to say.
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
 * Everything the runner's row says, derived once. Pure: every input was read by
 * the round that drew the page, and nothing here opens a file or a ref.
 */
export function runnerLine(
  facts: RunnerFacts | undefined,
  now: Date,
  options: Readonly<{ held?: HeldChange; waiting?: number; stopped?: StopFact | null; queue?: string }> = {},
): RunnerLine {
  const line = runnerLineOf(facts, now, options)
  const note = flowNote(facts?.service)
  return note === undefined ? line : { ...line, holds: `${line.holds} · ${note}` }
}

/**
 * What the line holds gains the flow's word once no change has been judged for
 * the round budget (25669 row 2): the early warning a person watching sees,
 * and the stall itself once the service pages it. Both come from the service's
 * own document, as of its last beat.
 */
function flowNote(service: RunnerService | undefined): string | undefined {
  if (service?.kind !== "beating" || service.flow === undefined) return undefined
  const { slow, stallAfterMs, stalledForMs, unjudgedForMs, waiting } = service.flow
  if (stalledForMs !== undefined) {
    return `stalled ${mediaDuration(stalledForMs)}: no change judged while ${String(waiting)} waited (threshold ${mediaDuration(stallAfterMs)})`
  }
  if (!slow) return undefined
  return `no change judged for ${mediaDuration(unjudgedForMs)} while ${String(waiting)} waited`
}

function runnerLineOf(
  facts: RunnerFacts | undefined,
  now: Date,
  options: Readonly<{ held?: HeldChange; waiting?: number; stopped?: StopFact | null; queue?: string }>,
): RunnerLine {
  const { held, waiting = 0, stopped, queue = "main" } = options
  const state = runnerWord(facts, held !== undefined, stopped)
  const latest = facts?.latest
  const word = STATE_WORDS[state].word
  const since = (at: Date): string => mediaDuration(now.getTime() - at.getTime())
  const beat = latest === undefined ? undefined : since(latest.lastWriteAt)
  const at = latest === undefined ? {} : { at: latest.startedAt }
  const service = facts?.service
  // 24470: a run that threw in its Git preamble is host-only detail, and this
  // line is where host-only detail goes. It earns no WORD of its own — the
  // ruled eight have none for it — but the journal's last Git row IS the
  // failing call, so the row still points at the evidence rather than reading
  // like a queue with nothing to do.
  const died =
    latest?.unstarted === true
      ? `run ${latest.id} died in its Git preamble before it could read its queue; its last Git row names the call that failed (${join(facts?.journalDir ?? "", `${latest.id}.jsonl`)})`
      : undefined
  const displayChecks = latest?.effectiveChecks ?? latest?.checks?.map((check) => (check === "true" ? "off" : check))
  const checksText = displayChecks === undefined ? "the run's header record was not read" : displayChecks.join(", ")
  // Never a blank: with a journal this says the beat, the round and the checks;
  // without one it says where it looked and whose machine the output is on.
  const found =
    latest === undefined
      ? `${facts?.absent ?? "no run journal was read on this machine"} · the check output is on the queue's machine only`
      : (died ??
        [
          `${latest.alive ? "alive" : "no process"}: beat ${String(beat)} ago`,
          `this round since ${clock(latest.startedAt, { seconds: true })}`,
          `${checksText}, output ${String(beat)} ago (this machine only)`,
        ].join(" · "))
  // A health document that is there and is not a document decides no word, so
  // it would go unsaid entirely if it were not said here.
  const detail = service?.kind === "unreadable" ? `${service.why} · ${found}` : found
  switch (state) {
    case "verifying":
    case "provisioning":
    case "checking":
    case "merging":
    case "deprovisioning": {
      const holding = held as HeldChange | undefined
      const activeStep = facts?.latest?.activeStep

      let holdsText: string
      const byText: string | undefined = holding?.submitter
      let durationText: string

      if (activeStep !== undefined) {
        const stepName =
          activeStep.kind === "check" ? activeStep.name : activeStep.name === "worktree" ? "compose" : activeStep.name
        const stepElapsed = since(activeStep.start)
        durationText = `${word} ${stepElapsed}`

        if (activeStep.phase === "submit") {
          const entry =
            activeStep.branch !== undefined
              ? `${activeStep.branch}${activeStep.head ? `@${activeStep.head.slice(0, 12)}` : ""}`
              : (holding?.branch ?? "entry")
          holdsText = `judging ${entry}: ${stepName}`
        } else if (activeStep.phase === "merge") {
          const entry =
            activeStep.branch !== undefined
              ? `${activeStep.branch}${activeStep.head ? `@${activeStep.head.slice(0, 12)}` : ""}`
              : (holding?.branch ?? "entry")
          holdsText = `merging ${entry}: ${stepName}`
        } else if (activeStep.phase === "run" && activeStep.name === "read") {
          holdsText = "between entries: re-reading main"
        } else {
          holdsText = `${stepName} ${activeStep.branch ?? ""}`.trim()
        }
      } else if (holding !== undefined) {
        durationText = `${word} ${since(holding.since)}`
        holdsText = `${holding.branch}${holding.subject === undefined ? "" : ` ${holding.subject}`}`
      } else {
        durationText = `${word} 0:00`
        holdsText = `${word}`
      }

      return {
        ...at,
        detail,
        duration: durationText,
        holds: holdsText,
        state,
        ...(byText === undefined ? {} : { by: byText }),
      }
    }
    case "stuck":
    case "paused": {
      const stop = stopped as StopFact
      const stoppedAt = new Date(stop.since)
      const change = stop.change === null ? undefined : stop.change.slice(0, stop.change.lastIndexOf("@"))
      return {
        ...at,
        // NOT the pause record's own sentence: that is the loud line at the top
        // of the page and it is said exactly once (watch-frame.tsx LoudPause).
        // This row says the WORD, who stopped the line and what lifts it.
        detail,
        duration: `${word} ${since(stoppedAt)}`,
        holds:
          change === undefined
            ? `paused: by ${stop.by === "" ? "an operator" : stop.by} since ${clock(stoppedAt)} · resume: yrd queue resume`
            : // The spec's cure text, with ONE correction: the verb is
              // `yrd queue withdraw` (cli.ts). There is no `yrd cancel`, and a
              // cure a reader cannot run is worse than no cure at all.
              `line stopped at ${change} since ${clock(stoppedAt)} — fix and yrd merge <fix>, or yrd queue withdraw ${change}, or yrd queue resume`,
        state,
      }
    }
    case "stopped": {
      // The document's own typed cause when it is the document talking; on the
      // hand-runner edge there is no document, and the journal's detail — which
      // already says `no process` — is what there is.
      const gone = service?.kind === "stopped" ? service : undefined
      return {
        ...at,
        detail: gone === undefined ? detail : `${gone.cause} · ${detail}`,
        ...(gone?.since === undefined ? {} : { duration: `${word} ${since(gone.since)}` }),
        holds: `${gone?.stopReason ?? ""} · start: yrd queue up`,
        state,
      }
    }
    case "unpublished": {
      return {
        detail,
        holds: `no runner status published at origin (refs/yrd/${queue}/runner)`,
        state,
      }
    }
    default: {
      let holdsText: string
      if (waiting === 0) {
        holdsText = "nothing in line"
      } else if (facts?.roundLockHolder !== undefined) {
        const holder = facts.roundLockHolder
        holdsText = `round lock held by pid ${String(holder.pid)} (${holder.command})`
      } else {
        holdsText = `nothing under a check, and ${String(waiting)} in line`
      }
      return {
        ...at,
        detail,
        ...(beat === undefined ? {} : { duration: `${word} ${beat}` }),
        holds: holdsText,
        state,
      }
    }
  }
}
