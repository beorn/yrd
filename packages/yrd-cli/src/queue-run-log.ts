/**
 * The queue run's log: one JSONL file per queue run, one JSON object per line.
 *
 * The plan of record (`@i/10-yrd/plan.md` § The final design, Log): "The queue
 * run's log is a JSONL fact stream, one record per fact, each carrying the
 * queue run, branch, head and check ids; the human line is a rendering of the
 * record. Six kinds appear in every queue run." This module is the one writer.
 * It owns the record shape, the file, and nothing else — no decisions, no
 * classification, no reading. Callers hand it facts they already hold.
 *
 * The field names are the boundary suite's table (`tests/boundary/
 * queue-run-log.test.ts`), which is the contract; this file follows it.
 *
 * WHERE THE LOG IS. `YRD_QUEUE_RUN_LOG` names the DIRECTORY, defaulting to the
 * repository's existing log directory; the queue run names the FILE from its
 * own id, one file per queue run; and it reports the full path as the `log`
 * field of its `--json` result, which is how every reader finds it.
 *
 * AN INCUMBENT-ONLY DERIVATION. These records are PROJECTED from what the
 * incumbent queue already wrote elsewhere — its admission refusals, its jobs,
 * its runs, its notifier — and filtered to one queue run by the instant that
 * queue run started. That is right for M2, which is truthful runs on the
 * incumbent, and it is not the end state: in M4 the queue run writes these
 * facts itself as it decides them, and the projection here goes away with the
 * durable rows it reads. Nothing downstream should be built on the projection;
 * build it on the records.
 *
 * THREE PROPERTIES, each load-bearing.
 *
 * 1. ONE PLACE. Every record in the stream is written through `write` here, so
 *    the shape of the stream is readable in one file rather than inferred from
 *    a dozen call sites. Existing loggily lines are untouched: this is a second
 *    stream for a different reader, not a rewrite of the human one. At M4 the
 *    direction inverts and the human line becomes a rendering of these records;
 *    until then they are written beside each other, which is why every field
 *    here is a fact a caller already had rather than a re-derivation.
 *
 * 2. SYNCHRONOUS APPEND. A queue run "may crash freely" (plan, principle 6), and
 *    a fact stream that loses its last lines to a buffer at exactly the moment
 *    something went wrong is worse than no stream, because it is silently
 *    short. Each record is one `appendFileSync` of one line. A queue run writes
 *    tens of records, so the cost does not matter and the guarantee does.
 *
 * 3. NEVER THROWS INTO THE QUEUE RUN. Logging is not the work. A stream that
 *    cannot be written must not turn a passing queue run into a stuck one — but
 *    it must not vanish either, so the first failure reports itself through the
 *    caller's own logger, once, with the path and the reason, and the rest are
 *    counted. NO SILENT ERRORS: the count is the proof that a short stream is
 *    known to be short.
 */
import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/**
 * The six kinds, exactly as the plan names them.
 *
 * - `run`     once per queue run: the pin and the check config it judged from.
 * - `change`  once per change the queue run saw: what it did with it.
 * - `check`   once per check: its start, end, duration and log path.
 * - `result`  once per ended change: pass, fail or stuck, the inputs the
 *             attribution rule used, and who it is billed to.
 * - `merge`   once per landing: the merge commit and the target's new tip.
 * - `message` once per message sent: its recipient and what it says.
 */
export const QUEUE_RUN_LOG_KINDS = ["run", "change", "check", "result", "merge", "message"] as const
export type QueueRunLogKind = (typeof QUEUE_RUN_LOG_KINDS)[number]

/** What a queue run did with a change, in its own vocabulary. */
export type QueueChangeDecision = "checked" | "merged" | "failed" | "stuck" | "waiting"

/** Pass, fail or stuck — the three results, and nothing else. */
export type QueueResult = "pass" | "fail" | "stuck"

/** Who a result is billed to. `queue` is the default a result must be argued
 * out of: a fail is the queue's fault until the attribution rule proves it the
 * submitter's (plan, principle 5). */
export type QueueWhose = "submitter" | "queue"

/** What a message tells its recipient. */
export type QueueMessageSays = "merged" | "fail" | "stuck"

/** On every record: which queue run wrote it, and when that queue run started. */
type QueueRunLogCommon = Readonly<{
  /** The queue run this record belongs to. */
  run: string
  /** When the queue run started, ISO 8601. One value across the whole file:
   * a record's own moment is not a fact anyone reads, and the queue run's is. */
  at: string
}>

export type QueueRunRecord = QueueRunLogCommon &
  Readonly<{
    kind: "run"
    /** The yrd pin the queue run ran, a sha. */
    pin?: string
    /** The target's check config, a blob sha. */
    config?: string
    /** The branch this queue is for. */
    target: string
    /** The target's tip the queue run read first — the commit `config` is the
     * config AT, so the two travel together or a reader can check neither. */
    base?: string
    /** The incumbent's Run ids this queue run built, in order, when it built
     * any. It is what every other instrument on the incumbent still prints, so
     * it stays readable — as a FIELD, never as the log's name: a queue run
     * that builds no Run still has a log, and naming the file after a record
     * the invocation may not make is what made two queue runs share one file.
     * Goes away with the Run record itself at M4. */
    built?: readonly string[]
    /** How many completions of EARLIER Runs this queue run settled on its way
     * past. A count, deliberately: their facts belong to the queue runs that
     * made them, and writing them here claimed merges this run never made. */
    recovered?: number
  }>

export type QueueChangeRecord = QueueRunLogCommon &
  Readonly<{
    kind: "change"
    /** The branch, which is the change's name. */
    branch?: string
    /** The sha it is a branch at. */
    head?: string
    decision: QueueChangeDecision
  }>

export type QueueCheckRecord = QueueRunLogCommon &
  Readonly<{
    kind: "check"
    /** The check's key in the target's config. */
    name: string
    /** Whose worktree it ran in. */
    branch?: string
    head?: string
    start: string
    end: string
    /** How long it took. */
    ms: number
    /** The file holding the check's own output. */
    log?: string
  }>

export type QueueResultRecord = QueueRunLogCommon &
  Readonly<{
    kind: "result"
    branch?: string
    head?: string
    /** The check this result is about. */
    name?: string
    result: QueueResult
    /** The check's results in the change's worktree, in order. */
    worktree?: readonly QueueResult[]
    /** The same check's result at the target, or null when it was not run
     * there. Null is a FACT — "we did not ask" — never a missing field. */
    target: QueueResult | null
    whose: QueueWhose
    /** The failure code, when the result is not a pass. */
    code?: string
  }>

export type QueueMergeRecord = QueueRunLogCommon &
  Readonly<{
    kind: "merge"
    branch?: string
    head?: string
    /** The merge commit. */
    commit: string
    /** The target's new tip. */
    tip: string
  }>

export type QueueMessageRecord = QueueRunLogCommon &
  Readonly<{
    kind: "message"
    /** The recipient. */
    to: string
    /** The branch it is about. */
    about?: string
    says: QueueMessageSays
  }>

export type QueueRunLogRecord =
  | QueueRunRecord
  | QueueChangeRecord
  | QueueCheckRecord
  | QueueResultRecord
  | QueueMergeRecord
  | QueueMessageRecord

/** A record as a CALLER builds it: everything but the two fields the writer
 * stamps itself, so a caller can neither forget them nor disagree with the file
 * it is writing into. */
export type QueueRunLogEntry =
  | Omit<QueueRunRecord, "run" | "at">
  | Omit<QueueChangeRecord, "run" | "at">
  | Omit<QueueCheckRecord, "run" | "at">
  | Omit<QueueResultRecord, "run" | "at">
  | Omit<QueueMergeRecord, "run" | "at">
  | Omit<QueueMessageRecord, "run" | "at">

export type QueueRunLog = Readonly<{
  /** The file this stream is being written to — what the queue run reports as
   * the `log` field of its `--json` result. */
  path: string
  /** Append one record. Never throws; see property 3 above. */
  write(record: QueueRunLogEntry): void
  /** How many records reached the file. */
  written(): number
  /** How many were lost, and to what. Absent when the stream is whole. */
  dropped(): Readonly<{ count: number; reason: string }> | undefined
}>

export type QueueRunLogOptions = Readonly<{
  /** The directory to write into: the queue run's own log directory. */
  directory: string
  /** The queue run's id — the file's name, and every record's `run`. */
  run: string
  /** When the queue run started; every record's `at`. */
  startedAt: string
  /** Where a write failure is reported. Called at most once. */
  onFailure?: (message: string, props: Readonly<Record<string, unknown>>) => void
}>

/** Names the DIRECTORY a queue run writes its log into. Unset, the queue run
 * uses the repository's own log directory; either way the FILE is named from
 * the queue run's id, because the plan says one file per queue run and the
 * service loops queue runs in one process. */
export const QUEUE_RUN_LOG_ENV = "YRD_QUEUE_RUN_LOG" as const

/** The directory the environment names, or undefined when it names none. */
export function queueRunLogDirectory(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[QUEUE_RUN_LOG_ENV]?.trim()
  return value === undefined || value === "" ? undefined : value
}

/** The file one queue run writes: `<directory>/<run>.jsonl`. */
export function queueRunLogFile(directory: string, run: string): string {
  // The run id reaches the filesystem, so anything that is not obviously safe
  // in a name becomes a dash. `openQueueRun` mints ids that already survive
  // this untouched; the guard stands because the id is a string parameter and
  // a caller could hand it anything.
  return join(directory, `${run.replace(/[^A-Za-z0-9._-]/gu, "-")}.jsonl`)
}

/** One invocation of `yrd queue run`: its id and the instant it started. */
export type QueueRunIdentity = Readonly<{
  /** The queue run's own id — its log's name, and every record's `run`. */
  id: string
  /** When it started, ISO 8601 in UTC; every record's `at`. */
  startedAt: string
}>

/**
 * Open one queue run: mint its id and stamp its instant, in one act.
 *
 * A QUEUE RUN IS THE INVOCATION, not a Run it may or may not build (plan of
 * record § The queue run). Naming its log after the first Run it built was the
 * defect: an empty lane mints no Run, so two consecutive empty-lane queue runs
 * both fell back to the last id the incumbent had minted and wrote to ONE file
 * under that name — `R700.jsonl`, two `run` rows, both claiming to be R700
 * (measured 2026-09-02 on pin 0749260a). The identity has to come from the
 * invocation, which always exists, and a Run id, when there is one, is a field
 * on the run row instead.
 *
 * MONOTONIC, then unique. The stamp sorts a log directory into the order the
 * queue runs happened, which is what a mechanic listing it wants; the random
 * tail is what makes two queue runs inside one millisecond — the service loops
 * them in one process — two ids rather than one. Both halves are already
 * filesystem-safe, so the file's name and the `run` field inside it are the
 * same string.
 *
 * The instant is minted HERE, with the id, because the two are one fact: a
 * queue run's window over the durable rows it may report is exactly the time
 * from this call, and an id and a window that came from different clock reads
 * could disagree about which queue run they describe.
 */
export function openQueueRun(): QueueRunIdentity {
  const startedAt = new Date().toISOString()
  const stamp = startedAt.replaceAll(/[-:.]/gu, "")
  return Object.freeze({ id: `q-${stamp}-${randomUUID().replaceAll("-", "").slice(0, 8)}`, startedAt })
}

/** Which of the runs a queue run handed back are its own. */
export type QueueRunOwnership = Readonly<{
  /** The runs this queue run started — the only ones whose facts are its. */
  own: readonly QueueRunSourceRun[]
  /** Completions of EARLIER Runs this queue run settled on its way past. */
  recovered: number
  /** Runs whose start could not be read, so ownership could not be decided.
   * Never empty quietly: the caller reports these by id (NO SILENT ERRORS). */
  unreadable: readonly string[]
}>

/**
 * Split the runs a queue run handed back into the ones it started and the
 * completions of earlier Runs it merely settled.
 *
 * A queue run settles every run whose holder is gone before it composes
 * anything of its own, and hands both sets back as one array. Projecting that
 * array whole made each of two empty-lane queue runs append the same seven
 * historical change/result/merge triplets, so both logs claimed merges neither
 * run made while the debug log and git proved zero events (measured
 * 2026-09-02). A recovered completion is not this run's fact. It is worth one
 * number on the run row, which is what `recovered` becomes.
 *
 * The rule is the one this stream already applies to every other durable row —
 * a row written before this queue run started belongs to an earlier one — and
 * `startedAt` is the fact it turns on. Compared as INSTANTS, never as text: an
 * ISO timestamp may carry an offset, so `…T05:00:00-08:00` is after noon UTC
 * though it sorts before it.
 *
 * INCLUSIVE at the boundary. The queue run stamps its instant before it
 * composes, so a run born in the same millisecond is its own.
 */
export function queueRunOwnRuns(runs: readonly QueueRunSourceRun[], since: string): QueueRunOwnership {
  const start = Date.parse(since)
  if (Number.isNaN(start)) throw new TypeError(`yrd: a queue run's start '${since}' is not a time`)
  const own: QueueRunSourceRun[] = []
  const unreadable: string[] = []
  let recovered = 0
  for (const run of runs) {
    const startedAt = Date.parse(run.startedAt)
    // Unreadable is neither owned nor recovered: it is a run this stream
    // cannot place, said out loud by the caller rather than folded into
    // either count, where it would read as a fact somebody had checked.
    if (Number.isNaN(startedAt)) unreadable.push(run.id)
    else if (startedAt >= start) own.push(run)
    else recovered += 1
  }
  return Object.freeze({ own: Object.freeze(own), recovered, unreadable: Object.freeze(unreadable) })
}

export function createQueueRunLog(options: QueueRunLogOptions): QueueRunLog {
  const path = queueRunLogFile(options.directory, options.run)
  let written = 0
  let droppedCount = 0
  let droppedReason: string | undefined
  let reported = false
  let directoryReady = false

  const fail = (cause: unknown): void => {
    droppedCount += 1
    droppedReason ??= cause instanceof Error ? cause.message : String(cause)
    if (reported) return
    reported = true
    options.onFailure?.(
      `the queue run's log could not be written to '${path}': ${droppedReason}; the run continues and this stream ` +
        "is short from here — every later record is counted, never dropped quietly",
      { action: "queue-run-log-failed", code: "queue-run-log-failed", path, reason: droppedReason },
    )
  }

  return Object.freeze({
    path,
    write(record) {
      try {
        if (!directoryReady) {
          mkdirSync(options.directory, { recursive: true })
          directoryReady = true
        }
        appendFileSync(path, `${JSON.stringify({ ...record, run: options.run, at: options.startedAt })}\n`)
        written += 1
      } catch (cause) {
        fail(cause)
      }
    },
    written: () => written,
    dropped: () => (droppedCount === 0 ? undefined : { count: droppedCount, reason: droppedReason ?? "unknown" }),
  })
}

/**
 * The six kinds, projected from what one queue run already produced.
 *
 * PURE, and separate from the writer on purpose: what belongs in the stream is
 * a question about the queue run, and whether the bytes reached the disk is a
 * question about the filesystem. Keeping them apart means the shape of the
 * stream can be asserted without a temp directory, and the writer without a
 * queue.
 *
 * It reads only what the queue run HANDED BACK. Nothing is re-derived from git
 * and nothing is re-classified: a record that disagreed with the run it
 * describes would be worse than no record, because a reader cannot tell which
 * of the two lied.
 */
export type QueueRunLogSource = Readonly<{
  /** The branch this queue is for. */
  target: string
  /** The yrd pin this queue run ran. */
  pin?: string
  /** The target's check config, a blob sha. */
  config?: string
  /** The target's tip the queue run read first. */
  base?: string
  /** The runs this queue run STARTED, in order — never one it merely settled
   * on its way past. {@link queueRunOwnRuns} is what separates the two. */
  runs: readonly QueueRunSourceRun[]
  /** How many completions of earlier Runs this queue run settled. */
  recovered?: number
  /** Changes considered and not selected, with the reason. */
  blocked?: readonly QueueRunSourceBlocked[]
  /** One row per message the notifier sent this pass. */
  messages?: readonly QueueRunSourceMessage[]
  /** Changes this queue run refused at admission, where most fails and every
   * stuck actually land — they never become a run. */
  refusals?: readonly QueueRunSourceRefusal[]
  /** Every check this queue run ran, from the jobs themselves: most checks
   * never belong to a run, because a change that fails one never becomes one. */
  checks?: readonly QueueRunSourceCheck[]
  /**
   * The queue run threw and did not finish. Every change it had in hand ends
   * STUCK: an uncaught throw judged nothing, so nobody is billed and the
   * changes stay where they were (plan, The queue run).
   */
  crashed?: Readonly<{ code?: string; changes: readonly QueueRunSourceChange[] }>
}>

/** The shape this module reads off a `Run`. Structural, so `@yrd/queue`'s own
 * `Run` satisfies it without this module depending on the whole model. */
export type QueueRunSourceRun = Readonly<{
  id: string
  /** When the run started, ISO 8601. REQUIRED, because it is the fact that
   * separates a run this queue run built from a completion it recovered, and
   * an optional one would let a caller decide ownership by omission. */
  startedAt: string
  base?: string
  conclusion?: string
  status?: string
  error?: Readonly<{ code?: string; message?: string }>
  integration?: Readonly<{ commit?: string; baseSha?: string }>
  prs?: readonly QueueRunSourceChange[]
}>

export type QueueRunSourceChange = Readonly<{ id?: string; branch?: string; headSha?: string }>

export type QueueRunSourceBlocked = Readonly<{
  pr?: QueueRunSourceChange
  eligibility?: Readonly<{ reason?: Readonly<{ code?: string; message?: string }> }>
}>

export type QueueRunSourceMessage = Readonly<{
  attempt?: string
  kind?: string
  recipient?: string
  branch?: string
  ball?: string
  disposition?: string
}>

/** A change this queue run refused at admission. */
export type QueueRunSourceRefusal = Readonly<{
  pr?: string
  branch?: string
  headSha?: string
  code?: string
  /** The admission kind — the billing decision the queue already made. */
  kind?: string
  reason?: string
  lastAt?: string
}>

/** One check this queue run ran. */
export type QueueRunSourceCheck = Readonly<{
  branch?: string
  head?: string
  name?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  log?: string
  exit?: number
}>

/** The first failing step's code — the one fact the result turns on when the
 * run itself recorded none. */
function failedRunCode(run: QueueRunSourceRun): string | undefined {
  return run.error?.code
}

/**
 * Who a result is billed to.
 *
 * `stuck` is the queue's, always. A fail is the SUBMITTER's — but only a fail:
 * "a fail is the queue's fault until proven the submitter's" is enforced one
 * layer down, in whether the code is environment-owned at all, and `stuck` is
 * exactly the answer that rule produces. So this is a projection of that
 * decision, never a second opinion on it.
 */
function whose(result: QueueResult): QueueWhose {
  return result === "fail" ? "submitter" : "queue"
}

/** The change a run is about, when it is about exactly one. */
function soleChange(run: QueueRunSourceRun): Readonly<{ branch?: string; head?: string }> {
  const first = run.prs?.[0]
  return {
    ...(first?.branch === undefined ? {} : { branch: first.branch }),
    ...(first?.headSha === undefined ? {} : { head: first.headSha }),
  }
}

/** What a message the notifier sent tells its recipient, in the log's three
 * words rather than the notifier's own. */
function messageSays(kind: string | undefined): QueueMessageSays {
  if (kind === "landed") return "merged"
  if (kind === "send-back") return "fail"
  return "stuck"
}

/**
 * Every record one queue run writes, in the order a reader wants them: the
 * queue run itself, every check it ran, then per run the change it took, the
 * result it reached and the merge it wrote, then the changes it refused or
 * held, then the messages it sent.
 */
export function queueRunLogRecords(
  source: QueueRunLogSource,
  stuck: (code: string) => boolean,
): readonly QueueRunLogEntry[] {
  const records: QueueRunLogEntry[] = []
  records.push({
    kind: "run",
    ...(source.pin === undefined ? {} : { pin: source.pin }),
    ...(source.config === undefined ? {} : { config: source.config }),
    ...(source.base === undefined ? {} : { base: source.base }),
    target: source.target,
    // Absent rather than empty when there were none: `built: []` and
    // `recovered: 0` read as measurements somebody took, and a queue run that
    // built nothing and recovered nothing took neither.
    ...(source.runs.length === 0 ? {} : { built: source.runs.map((run) => run.id) }),
    ...(source.recovered === undefined || source.recovered === 0 ? {} : { recovered: source.recovered }),
  })
  for (const ran of source.checks ?? []) {
    if (ran.startedAt === undefined || ran.finishedAt === undefined || ran.name === undefined) continue
    records.push({
      kind: "check",
      name: ran.name,
      ...(ran.branch === undefined ? {} : { branch: ran.branch }),
      ...(ran.head === undefined ? {} : { head: ran.head }),
      start: ran.startedAt,
      end: ran.finishedAt,
      ms: ran.durationMs ?? Date.parse(ran.finishedAt) - Date.parse(ran.startedAt),
      ...(ran.log === undefined ? {} : { log: ran.log }),
    })
  }
  for (const run of source.runs) {
    const change = soleChange(run)
    const code = failedRunCode(run)
    const result: QueueResult =
      code === undefined ? (run.conclusion === "failure" ? "fail" : "pass") : stuck(code) ? "stuck" : "fail"
    const merged = run.integration?.commit !== undefined
    records.push({
      kind: "change",
      ...change,
      // What the queue run DID with it, which is not the same as how the check
      // went: a change whose checks passed and which then merged is `merged`,
      // and one that passed its checks without merging is `checked`.
      decision: merged ? "merged" : result === "pass" ? "checked" : result === "stuck" ? "stuck" : "failed",
    })
    records.push({
      kind: "result",
      ...change,
      result,
      // Not run at the target: today's attribution never asks, and null says
      // so. A missing field would read as "no answer recorded", which is a
      // different and untrue claim.
      target: null,
      whose: whose(result),
      ...(code === undefined ? {} : { code }),
    })
    if (run.integration?.commit !== undefined) {
      records.push({
        kind: "merge",
        ...change,
        commit: run.integration.commit,
        // The plan asks for the new target tip, which IS the merge commit: the
        // target fast-forwards onto it.
        tip: run.integration.commit,
      })
    }
  }
  for (const refused of source.refusals ?? []) {
    const subject = {
      ...(refused.branch === undefined ? {} : { branch: refused.branch }),
      ...(refused.headSha === undefined ? {} : { head: refused.headSha }),
    }
    // The admission kind IS the billing decision the queue already made, so it
    // is what the result reads — never recomputed here into a second opinion.
    const result: QueueResult = refused.kind === "infrastructure" ? "stuck" : "fail"
    records.push({ kind: "change", ...subject, decision: result === "stuck" ? "stuck" : "failed" })
    records.push({
      kind: "result",
      ...subject,
      result,
      target: null,
      whose: whose(result),
      ...(refused.code === undefined ? {} : { code: refused.code }),
    })
  }
  for (const held of source.blocked ?? []) {
    records.push({
      kind: "change",
      ...(held.pr?.branch === undefined ? {} : { branch: held.pr.branch }),
      ...(held.pr?.headSha === undefined ? {} : { head: held.pr.headSha }),
      decision: "waiting",
    })
  }
  for (const held of source.crashed?.changes ?? []) {
    const subject = {
      ...(held.branch === undefined ? {} : { branch: held.branch }),
      ...(held.headSha === undefined ? {} : { head: held.headSha }),
    }
    records.push({ kind: "change", ...subject, decision: "stuck" })
    records.push({
      kind: "result",
      ...subject,
      result: "stuck",
      target: null,
      whose: "queue",
      ...(source.crashed?.code === undefined ? {} : { code: source.crashed.code }),
    })
  }
  for (const message of source.messages ?? []) {
    records.push({
      kind: "message",
      to: message.recipient ?? "unknown",
      ...(message.branch === undefined ? {} : { about: message.branch }),
      says: messageSays(message.kind),
    })
  }
  return records
}
