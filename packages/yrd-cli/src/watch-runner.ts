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
 * The runner ref supplies the remote status wire; these files add the local
 * journal and service detail without consulting a supervisor. TWO pure
 * functions turn it into the runner's row on the flow page: {@link runnerWord}
 * picks one word from THE ONE WORD TABLE against one named threshold, and
 * {@link runnerLine} says what it holds, since when and whether it is alive.
 * The row renders them and never recomputes the conditions. Both are about the
 * SERVICE and never compete with `Row.live`, which alone says whether a change
 * is under a check.
 *
 * Off the queue's own machine there is no journal, and {@link RunnerFacts.absent}
 * carries the sentence that says where it looked. The published claim supplies
 * the phase and beat when present; an absent or unreadable claim is named.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  runDiedInPreamble,
  runStartedAt,
  serviceStoppedLine,
  type LogRecord,
  type RoundLine,
  type QueueHealthDocument,
  type ServiceIntentFact,
  type StopFact,
} from "@yrd/queue-core"
import { readQueueHealth, SERVICE } from "./queue-health.ts"
import { clock, mediaDuration } from "./watch-format.ts"
import { STATE_WORDS, type RunnerState } from "./watch-words.ts"
import type { PublishedRunner } from "./runner-publication.ts"

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

export type RunnerJournalStep = Readonly<{
  kind: "step" | "check"
  name: string
  phase: string
  branch?: string
  head?: string
  target?: string
  base?: string
  start: Date
  end?: Date
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
  steps?: readonly RunnerJournalStep[]
  /** The line as this run read it, from its own `observation`/`line` record (25669), once it has. */
  line?: RoundLine
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
 * Five outcomes with different cures, kept apart for the reason the reader
 * itself gives (queue-health.ts): collapsing any two of them is the
 * silent-error shape.
 *
 * - `absent` — no document here. Nothing was started in this workdir, or a hand
 *   `yrd queue run` did the work, which writes no document at all (24523 C5).
 * - `beating` — believable by its OWN deadline, and its writer answers.
 * - `stopped` — graceful stop, or a named writer proven gone.
 * - `unknown` — past the document's deadline, but its writer is alive or unnamed.
 * - `unreadable` — a file that is there and is not a document. That is a defect
 *   in the WRITER and says nothing about the process, so it decides no word;
 *   the next heartbeat clears it, and until then it is loud on the detail line.
 */
export type RunnerService =
  | Readonly<{ kind: "absent"; why: string }>
  | Readonly<{
      kind: "beating"
      state: string
      since?: Date
      flow?: RunnerFlow
      /** The service's own page sentence, when it judged the line stalled. */
      stallCause?: string
      readFailure?: Readonly<{ ref: string; error: string; count: number }>
    }>
  // `graceful`: the service wrote its own stop (25430). False is a stop outside one — a SIGKILL, a crash, a
  // silent writer — and its `why` names where the supervisor's record is.
  | Readonly<{ kind: "stopped"; graceful: boolean; why: string; cause: string; since?: Date; stopReason?: string }>
  | Readonly<{ kind: "unknown"; why: string; cause: string; since?: Date }>
  | Readonly<{ kind: "unreadable"; why: string }>

/**
 * The line's flow as the service's own document states it (25669): how long
 * waiting changes have gone unjudged, whether that is past the round budget,
 * and the stall when the service judged one. Read, never recomputed: the `up`
 * loop is the one home for the stall clock, and this is its last statement.
 */
export type RunnerFlow = Readonly<{
  waiting?: number
  oldestWaiting?: Readonly<{ branch: string; openedAt: string }>
  unjudgedForMs?: number
  slow?: boolean
  stallAfterMs: number
  stalledForMs?: number
  casRefused?: Readonly<{ ref: string; count: number; site?: string; budgetMs?: number; firstAt?: string }>
}>

export type RunnerFacts = Readonly<{
  /** The directory the journals were looked for in. */
  journalDir: string
  /** Why there is no run to show, when there is none: a sentence naming what was looked for and where. */
  absent?: string
  /** The newest run journal on this machine. */
  latest?: RunnerRun
  /** What the service's local heartbeat document says. */
  service: RunnerService
  /** The remote runner ref, read with the queue refs; available on every machine. */
  published?: PublishedRunner
  /** Round lock holder if currently held by an active process. */
  roundLockHolder?: RoundLockHolder
}>

/** The document's flow fact, when it states one with waiting changes; an older writer states none. */
function runnerFlow(document: QueueHealthDocument): RunnerFlow | undefined {
  const flow = document.facts?.flow
  if (typeof flow !== "object" || flow === null) return undefined
  const { waiting, oldestWaiting, unjudgedForMs, slow, stallAfterMs, stalledForMs, casRefused } = flow as Readonly<
    Record<string, unknown>
  >
  if (waiting !== undefined && typeof waiting !== "number") return undefined
  if (unjudgedForMs !== undefined && typeof unjudgedForMs !== "number") return undefined
  if (slow !== undefined && typeof slow !== "boolean") return undefined
  if (typeof waiting === "number" && (typeof unjudgedForMs !== "number" || typeof slow !== "boolean")) {
    return undefined
  }
  if (typeof stallAfterMs !== "number") return undefined
  let oldest: RunnerFlow["oldestWaiting"]
  if (oldestWaiting !== undefined) {
    const value = oldestWaiting as Readonly<Record<string, unknown>>
    if (
      typeof oldestWaiting !== "object" ||
      oldestWaiting === null ||
      typeof value.branch !== "string" ||
      value.branch.length === 0 ||
      typeof value.openedAt !== "string" ||
      !Number.isFinite(Date.parse(value.openedAt)) ||
      new Date(Date.parse(value.openedAt)).toISOString() !== value.openedAt
    ) {
      throw new TypeError("health document facts.flow.oldestWaiting must name a branch and canonical openedAt")
    }
    oldest = { branch: value.branch, openedAt: value.openedAt }
  }
  const refusal = casRefused as Readonly<Record<string, unknown>> | undefined
  if (waiting === undefined && (typeof refusal?.ref !== "string" || typeof refusal.count !== "number")) return undefined
  return {
    stallAfterMs,
    ...(typeof slow === "boolean" ? { slow } : {}),
    ...(typeof unjudgedForMs === "number" ? { unjudgedForMs } : {}),
    ...(typeof waiting === "number" ? { waiting } : {}),
    ...(oldest === undefined ? {} : { oldestWaiting: oldest }),
    ...(typeof stalledForMs === "number" ? { stalledForMs } : {}),
    ...(refusal !== undefined && typeof refusal.ref === "string" && typeof refusal.count === "number"
      ? {
          casRefused: {
            ref: refusal.ref,
            count: refusal.count,
            ...(typeof refusal.site === "string" ? { site: refusal.site } : {}),
            ...(typeof refusal.budgetMs === "number" ? { budgetMs: refusal.budgetMs } : {}),
            ...(typeof refusal.firstAt === "string" ? { firstAt: refusal.firstAt } : {}),
          },
        }
      : {}),
  }
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
  const overdue = document.error?.code === "queue-round-overdue" ? document.error : undefined
  const staleAfter = overdue === undefined ? undefined : document.facts?.staleAfter
  const deadline = typeof staleAfter === "string" ? new Date(Date.parse(staleAfter)) : undefined
  const overdueSince = deadline === undefined || Number.isNaN(deadline.getTime()) ? undefined : deadline
  const pid = writerPid(document)
  // Believable, and its writer is gone. A document outlives its writer by up to
  // one heartbeat plus grace, and this is what closes that window: @cto's "no
  // runner process", read from the loop's own declared liveness rather than
  // from anybody's silence.
  if (pid !== undefined && !running(pid)) {
    const claim = document.facts?.runnerClaim as Readonly<Record<string, unknown>> | undefined
    const host = claim?.pid === pid && typeof claim.host === "string" ? claim.host : undefined
    return {
      cause: `the health document names process ${String(pid)}${host === undefined ? "" : ` on ${host}`} as its writer, and that process does not answer; hh-hab ps ${SERVICE} --json has the supervisor's exit cause`,
      graceful: false,
      kind: "stopped",
      why: outsideGracefulStop(document),
      ...(overdueSince === undefined ? {} : { since: overdueSince }),
    }
  }
  if (overdue !== undefined) {
    return {
      cause: overdue.cause,
      kind: "unknown",
      why: `the health document is overdue: ${overdue.cause}`,
      ...(overdueSince === undefined ? {} : { since: overdueSince }),
    }
  }
  const runner = document.facts?.runner as Readonly<Record<string, unknown>> | undefined
  const startedAt = typeof runner?.startedAt === "string" ? new Date(Date.parse(runner.startedAt)) : undefined
  const since = startedAt !== undefined && !Number.isNaN(startedAt.getTime()) ? startedAt : undefined
  let flow: RunnerFlow | undefined
  try {
    flow = runnerFlow(document)
  } catch (error) {
    return {
      kind: "unreadable",
      why: `health document flow in ${workdir} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const failureFact = document.facts?.roundReadFailure
  let readFailure: Readonly<{ ref: string; error: string; count: number }> | undefined
  if (failureFact !== undefined) {
    const rawFailure =
      typeof failureFact === "object" && failureFact !== null
        ? (failureFact as Readonly<Record<string, unknown>>)
        : undefined
    if (
      rawFailure === undefined ||
      typeof rawFailure.ref !== "string" ||
      rawFailure.ref.length === 0 ||
      typeof rawFailure.error !== "string" ||
      typeof rawFailure.count !== "number" ||
      !Number.isSafeInteger(rawFailure.count) ||
      rawFailure.count < 1
    ) {
      return { kind: "unreadable", why: `health document in ${workdir} has malformed facts.roundReadFailure` }
    }
    readFailure = { ref: rawFailure.ref, error: rawFailure.error, count: rawFailure.count }
  }
  return {
    kind: "beating",
    state: document.state,
    ...(since === undefined ? {} : { since }),
    ...(flow === undefined ? {} : { flow }),
    ...(document.error?.code === "queue-line-stalled" ? { stallCause: document.error.cause } : {}),
    ...(readFailure === undefined ? {} : { readFailure }),
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
  return `stopped outside a graceful stop since ${since}; hh-hab ps ${SERVICE} --json has the supervisor's exit cause`
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
  /** All steps and checks from the journal. */
  steps?: readonly RunnerJournalStep[]
  /** The line as the run journalled it, when it has. */
  line?: RoundLine
}>

/** The run's own reading of its line: the last `observation` record with subject `line` (25669). */
function lineOf(records: readonly LogRecord[]): RoundLine | undefined {
  const record = records.findLast((r) => r.kind === "observation" && r.subject === "line") as
    | Readonly<Record<string, unknown>>
    | undefined
  if (record === undefined || typeof record.waiting !== "number") return undefined
  const { oldestBranch, oldestOpenedAt, lastJudgedAt } = record
  return {
    waiting: record.waiting,
    ...(typeof oldestBranch === "string" && typeof oldestOpenedAt === "string"
      ? { oldest: { branch: oldestBranch, openedAt: oldestOpenedAt } }
      : {}),
    ...(typeof lastJudgedAt === "string" ? { lastJudgedAt } : {}),
  }
}

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
  const allSteps: RunnerJournalStep[] = []
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
          const start = new Date(startStr)
          const validStart = Number.isNaN(start.getTime()) ? new Date() : start
          if (endStr !== undefined) {
            const end = new Date(endStr)
            const validEnd = Number.isNaN(end.getTime()) ? undefined : end
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
            const allIdx = allSteps.findLastIndex(
              (s) =>
                s.kind === kind &&
                s.name === name &&
                s.phase === phase &&
                s.branch === branch &&
                s.head === head &&
                s.target === target &&
                s.end === undefined,
            )
            const prev = allIdx >= 0 ? allSteps[allIdx] : undefined
            if (prev !== undefined) {
              allSteps[allIdx] = { ...prev, end: validEnd }
            } else {
              allSteps.push({ kind, name, phase, branch, head, target, base, start: validStart, end: validEnd })
            }
          } else {
            openSteps.push({
              kind,
              name,
              phase,
              branch,
              head,
              target,
              base,
              start: validStart,
            })
            allSteps.push({
              kind,
              name,
              phase,
              branch,
              head,
              target,
              base,
              start: validStart,
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
  const line = lineOf(records)
  return {
    activeStep,
    ...(allSteps.length === 0 ? {} : { steps: allSteps }),
    ...(line === undefined ? {} : { line }),
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
): Pick<
  RunnerRun,
  "target" | "gitlink" | "queue" | "checks" | "effectiveChecks" | "activeStep" | "steps" | "line" | "unstarted"
> {
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
    ...(read.steps === undefined ? {} : { steps: read.steps }),
    ...(read.line === undefined ? {} : { line: read.line }),
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw error
  }
}

/**
 * ONE derivation of the runner's word, in THE ONE WORD TABLE's vocabulary
 * (watch-words.ts), because the flow page draws the runner as a row in the same
 * STATUS column as every change.
 *
 * The queue's stop record is an authoritative Git fact and wins over any
 * runner status. A fresh runner ref then supplies its phase on every machine;
 * an overdue ref says `silent`. When that claim is absent or unreadable, the
 * local health document and journal supply what they can. An empty local
 * reading says `unpublished` rather than inventing a phase. The hand-runner
 * case has a journal but no service document, so its own pid supplies local
 * liveness. Journal age never supplies `silent`: a healthy long check writes
 * no new journal boundary until it finishes.
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
  // A dead writer is a measured local stop. Its last runner ref may remain
  // fresh for three beats after the exit, but cannot turn that stop back into work.
  if (facts?.service.kind === "stopped") return "stopped"
  if (facts?.published?.signal === "silent") return "silent"
  if (facts?.published?.signal === "fresh") {
    const state = facts.published.claim?.State
    if (state !== undefined) return state
  }
  switch (facts?.service.kind) {
    case "unknown":
      return "stopped"
    case "beating": {
      if (facts.latest?.activeStep !== undefined) {
        const step = facts.latest.activeStep
        if (step.phase === "merge") return "merging"
        if (step.kind === "check") {
          if (step.name === "setup") return "provisioning"
          return "checking"
        }
        if (step.name === "remove" || step.name === "retain" || step.name === "deprovision" || step.name === "retire") {
          return "deprovisioning"
        }
        return "provisioning"
      }
      if (underCheck) return "checking"
      if (facts.roundLockHolder !== undefined) return "provisioning"
      return "idle"
    }
    default:
      // `absent` and `unreadable` alike: no document to read a word from. The
      // defect an unreadable one is stays loud on the detail line rather than
      // being dressed up as a claim about the process.
      break
  }
  if (facts?.latest === undefined) {
    if (facts?.roundLockHolder !== undefined) return "provisioning"
    return "unpublished"
  }
  if (facts.latest.alive && facts.latest.activeStep !== undefined) {
    const step = facts.latest.activeStep
    if (step.phase === "merge") return "merging"
    if (step.kind === "check") {
      if (step.name === "setup") return "provisioning"
      return "checking"
    }
    if (step.name === "remove" || step.name === "retain" || step.name === "deprovision" || step.name === "retire") {
      return "deprovisioning"
    }
    return "provisioning"
  }
  if (facts.roundLockHolder !== undefined) return "provisioning"
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
  /** The running check name when state is checking. */
  subphase?: string
  /** The running merge step name when state is merging. */
  step?: string
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
  const oldest = facts?.service.kind === "beating" ? facts.service.flow?.oldestWaiting : undefined
  const age = oldest === undefined ? undefined : now.getTime() - Date.parse(oldest.openedAt)
  const oldestNote =
    oldest === undefined || age === undefined
      ? undefined
      : age < 0
        ? `oldest waiting ${oldest.branch} opened ${oldest.openedAt} (reader clock earlier)`
        : `oldest waiting ${oldest.branch} for ${mediaDuration(age)}`
  const notes = [oldestNote, note].filter((item): item is string => item !== undefined)
  return notes.length === 0 ? line : { ...line, holds: `${line.holds} · ${notes.join(" · ")}` }
}

/**
 * What the line holds gains the flow's word once no change has been judged for
 * the round budget (25669 row 2): the early warning a person watching sees,
 * and the stall itself once the service pages it. Both come from the service's
 * own document, as of its last beat.
 */
function flowNote(service: RunnerService | undefined): string | undefined {
  if (service?.kind !== "beating") return undefined
  if (service.stallCause !== undefined) return service.stallCause
  if (service.readFailure !== undefined) {
    return `last round failed reading ${service.readFailure.ref} (${String(service.readFailure.count)} consecutive): ${service.readFailure.error}; queue alive, retrying`
  }
  if (service.flow === undefined) return undefined
  const { slow, stallAfterMs, stalledForMs, unjudgedForMs, waiting } = service.flow
  if (service.flow.casRefused !== undefined) {
    const refusal = service.flow.casRefused
    const site =
      refusal.site === undefined
        ? ""
        : ` at ${refusal.site}${refusal.budgetMs === undefined ? "" : ` (${String(refusal.budgetMs)}ms budget)`}`
    const unread = waiting === undefined ? "; line not read this round" : ""
    return `CAS refused ${String(refusal.count)} consecutive times${site} for ${refusal.ref}${unread}; queue alive, retrying`
  }
  if (stalledForMs !== undefined) {
    return `stalled ${mediaDuration(stalledForMs)}: no change judged while ${String(waiting)} waited (threshold ${mediaDuration(stallAfterMs)})`
  }
  if (!slow || unjudgedForMs === undefined) return undefined
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
  const published = facts?.published
  const publishedClaim = published?.claim
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
  const localDetail = service?.kind === "unreadable" ? `${service.why} · ${found}` : found
  const unjudged =
    published?.unjudgedTrailers === undefined ? "" : ` · unjudged trailers: ${published.unjudgedTrailers.join(", ")}`
  const publishedDetail =
    published?.signal === "fresh" || published?.signal === "silent"
      ? `published status from runner ref: ${published.signal}, ${publishedClaim?.State ?? "unreadable state"} since ${publishedClaim?.Since ?? "unknown"}, beat at ${publishedClaim?.At ?? "unknown"}${published.phase?.status === "overdue" ? ` · phase overdue: ${published.phase.reason}` : published.phase?.status === "unavailable" ? ` · ${published.phase.reason}` : ""}${unjudged}`
      : published?.why
  const detail = publishedDetail === undefined ? localDetail : `${publishedDetail} · ${localDetail}`
  switch (state) {
    case "provisioning":
    case "checking":
    case "merging":
    case "deprovisioning": {
      const holding = held as HeldChange | undefined
      const activeStep = facts?.latest?.activeStep

      let holdsText: string
      const byText: string | undefined = holding?.submitter
      let durationText: string
      let subphase: string | undefined
      let step: string | undefined

      if (activeStep !== undefined) {
        const stepName =
          activeStep.kind === "check" ? activeStep.name : activeStep.name === "worktree" ? "compose" : activeStep.name
        const stepElapsed = since(activeStep.start)
        durationText = stepElapsed

        if (activeStep.kind === "check") {
          subphase = activeStep.name === "setup" ? "preparing" : activeStep.name
        } else if (activeStep.name === "compose" || activeStep.name === "worktree") {
          subphase = "composing"
        } else if (activeStep.name === "prepare") {
          subphase = "preparing"
        } else if (activeStep.phase === "merge") {
          step = activeStep.name
          subphase =
            activeStep.name === "publish" || activeStep.name === "components"
              ? "publishing components"
              : activeStep.name === "merge" || activeStep.name === "push" || activeStep.name === "root"
                ? "publishing root"
                : activeStep.name === "notify"
                  ? "notifying"
                  : activeStep.name
        } else if (
          activeStep.name === "remove" ||
          activeStep.name === "retain" ||
          activeStep.name === "deprovision" ||
          activeStep.name === "retire"
        ) {
          subphase = activeStep.name === "retain" ? "retaining" : activeStep.name === "retire" ? "retiring" : "removing"
        } else {
          subphase = stepName
        }

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
      } else if (facts?.roundLockHolder !== undefined) {
        const runnerStart = (service && "since" in service ? service.since : undefined) ?? latest?.startedAt
        const holder = facts.roundLockHolder
        const holderDate = holder.since ? new Date(holder.since) : undefined
        durationText =
          holderDate && !Number.isNaN(holderDate.getTime()) ? `${word} ${since(holderDate)}` : `${word} 0:00`
        holdsText = runnerStart !== undefined ? `runner since ${clock(runnerStart)} · ${durationText}` : durationText
      } else if (holding !== undefined) {
        durationText = `${word} ${since(holding.since)}`
        holdsText = `${holding.branch}${holding.subject === undefined ? "" : ` ${holding.subject}`}`
      } else if (publishedClaim?.Holding !== undefined) {
        const sinceAt = new Date(publishedClaim.Since)
        durationText = `${word} ${since(sinceAt)}`
        holdsText = publishedClaim.Holding
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
        ...(subphase === undefined ? {} : { subphase }),
        ...(step === undefined ? {} : { step }),
      }
    }
    case "stuck":
    case "paused": {
      const stop = stopped ?? undefined
      const stoppedAt = new Date(stop?.since ?? publishedClaim?.Since ?? now.toISOString())
      const change =
        stop === undefined || stop.change === null ? undefined : stop.change.slice(0, stop.change.lastIndexOf("@"))
      return {
        ...at,
        // NOT the pause record's own sentence: that is the loud line at the top
        // of the page and it is said exactly once (watch-frame.tsx LoudPause).
        // This row says the WORD, who stopped the line and what lifts it.
        detail,
        duration: `${word} ${since(stoppedAt)}`,
        holds:
          stop === undefined
            ? `${word} since ${clock(stoppedAt)}${publishedClaim?.Holding === undefined ? "" : ` on ${publishedClaim.Holding}`}`
            : change === undefined
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
      const gone = service?.kind === "stopped" || service?.kind === "unknown" ? service : undefined
      return {
        ...at,
        detail: gone === undefined ? detail : `${gone.cause} · ${detail}`,
        ...(gone?.since === undefined ? {} : { duration: `${word} ${since(gone.since)}` }),
        holds: `${gone?.kind === "stopped" ? (gone.stopReason ?? "") : ""} · start: yrd queue up`,
        state,
      }
    }
    case "silent": {
      return {
        ...at,
        detail,
        holds: `runner silent since ${publishedClaim?.At ?? "an unreadable instant"}; inspect the queue service on ${publishedClaim?.Runner ?? "the queue machine"}`,
        state,
      }
    }
    case "unpublished": {
      return {
        detail,
        holds:
          published?.signal === "unreadable"
            ? `runner status unreadable: ${published.why ?? "the remote claim could not be read"}`
            : `no runner status published at origin (refs/yrd/${queue}/runner)`,
        state,
      }
    }
    default: {
      let holdsText: string
      if (facts?.roundLockHolder !== undefined) {
        const runnerStart = (service && "since" in service ? service.since : undefined) ?? latest?.startedAt
        const startText = runnerStart !== undefined ? `runner since ${clock(runnerStart)}` : "runner"
        holdsText = `${startText} · ${word} ${beat ?? "0:00"}`
      } else if (waiting === 0) {
        holdsText = "nothing in line"
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
