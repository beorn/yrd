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
 *    counted and reported by `close`. NO SILENT ERRORS: the count is the proof
 *    that a short stream is known to be short.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/** Names the DIRECTORY the queue run writes its log into. One file per queue
 * run is created inside it, named by the queue run's id, because the plan says
 * one file per queue run and a service loops queue runs in one process. Unset =
 * no JSONL stream, and the human log is unaffected. */
export const QUEUE_RUN_LOG_ENV = "YRD_QUEUE_RUN_LOG" as const

/**
 * The six kinds, exactly as the plan names them.
 *
 * - `run`     once per queue run: the pin and the check-config blob it read.
 * - `change`  once per change the queue run considered: what it decided.
 * - `check`   once per check: its start, end, duration and log path.
 * - `result`  once per ended change: pass, fail or stuck, and the inputs the
 *             rule used to say so.
 * - `merge`   once per landing: the merge commit and the target's new tip.
 * - `message` once per message sent: its recipient.
 */
export const QUEUE_RUN_LOG_KINDS = ["run", "change", "check", "result", "merge", "message"] as const
export type QueueRunLogKind = (typeof QUEUE_RUN_LOG_KINDS)[number]

/** What every record carries, whatever its kind: which queue run wrote it, when,
 * and the ids that join it to the others (plan: "each carrying the queue run,
 * branch, head and check ids"). */
type QueueRunLogCommon = Readonly<{
  /** The queue run this record belongs to. */
  run: string
  /** ISO-8601, when the record was written. */
  at: string
  /** The change's branch, on every record that is about one change. */
  branch?: string
  /** The change's head sha, on every record that is about one change. */
  head?: string
  /** The check's id, on every record that is about one check. */
  check?: string
}>

export type QueueRunRecord = QueueRunLogCommon &
  Readonly<{
    kind: "run"
    /** The target branch this queue run is draining. */
    target: string
    /** The target's tip when the queue run read it. */
    base?: string
    /** The recorded yrd pin the queue run is executing. */
    pin?: string
    /** The blob sha of the check config read from the target. */
    config?: string
  }>

export type QueueChangeRecord = QueueRunLogCommon &
  Readonly<{
    kind: "change"
    /** What the queue run decided about this change. */
    decision: string
    /** Why, when the decision carries a code. */
    code?: string
    /** The human sentence behind the decision. */
    reason?: string
  }>

export type QueueCheckRecord = QueueRunLogCommon &
  Readonly<{
    kind: "check"
    started: string
    ended: string
    durationMs: number
    /** The file holding the check's own output. */
    log?: string
    /** The check's exit status, when the check reached one. */
    exit?: number
  }>

export type QueueResultRecord = QueueRunLogCommon &
  Readonly<{
    kind: "result"
    result: "pass" | "fail" | "stuck"
    /** The failure code, when the result is not a pass. */
    code?: string
    /** The inputs the attribution rule used to reach this result. */
    inputs?: Readonly<Record<string, unknown>>
  }>

export type QueueMergeRecord = QueueRunLogCommon &
  Readonly<{
    kind: "merge"
    /** The merge commit written. */
    commit: string
    /** The target's new tip, which the target fast-forwards onto. */
    tip: string
  }>

export type QueueMessageRecord = QueueRunLogCommon &
  Readonly<{
    kind: "message"
    recipient: string
    /** What the message says, in one word: `landed`, `send-back`, `yrd-broken`. */
    says: string
    /** The id the notifier printed for the message it opened, when it opened one. */
    id?: string
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
  /** The file this stream is being written to. */
  path: string
  /** Append one record. Never throws; see property 3 above. */
  write(record: QueueRunLogEntry): void
  /** How many records reached the file. */
  written(): number
  /** How many were lost, and to what. Empty when the stream is whole. */
  dropped(): Readonly<{ count: number; reason: string }> | undefined
}>

export type QueueRunLogOptions = Readonly<{
  /** The directory to write into ({@link QUEUE_RUN_LOG_ENV}). */
  directory: string
  /** The queue run's id — the file's name, and every record's `run`. */
  run: string
  /** Where a write failure is reported. Called at most once. */
  onFailure?: (message: string, props: Readonly<Record<string, unknown>>) => void
  /** The clock, for the `at` field. */
  now?: () => Date
}>

/**
 * The directory a queue run logs into, or `undefined` when nothing named one.
 *
 * Read once, from the environment, and never defaulted to a path of our
 * choosing: a log that appears somewhere nobody asked for is a file nobody
 * finds and nobody prunes. Absent means no stream, which is a supported state,
 * not a degraded one.
 */
export function queueRunLogDirectory(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[QUEUE_RUN_LOG_ENV]?.trim()
  return value === undefined || value === "" ? undefined : value
}

/** The file one queue run writes: `<directory>/<run>.jsonl`. */
export function queueRunLogFile(directory: string, run: string): string {
  // The run id reaches the filesystem, so anything that is not obviously safe
  // in a name becomes a dash. Ids are uuids and `admission:PR1:1:<sha>` forms
  // today; neither survives a naive join on every filesystem.
  return join(directory, `${run.replace(/[^A-Za-z0-9._-]/gu, "-")}.jsonl`)
}

export function createQueueRunLog(options: QueueRunLogOptions): QueueRunLog {
  const path = queueRunLogFile(options.directory, options.run)
  const now = options.now ?? ((): Date => new Date())
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
        // `at` and `run` are the writer's to stamp, so a caller can neither
        // forget them nor disagree with the file it is writing into.
        appendFileSync(path, `${JSON.stringify({ ...record, run: options.run, at: now().toISOString() })}\n`)
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
 * stream can be asserted without a temp directory, and the writer can be
 * asserted without a queue.
 *
 * It reads only what the queue run HANDED BACK — the runs it drove, the changes
 * it declined to select, the step selection it resolved and the outcomes it
 * notified. Nothing is re-derived from git and nothing is re-classified: a
 * record that disagreed with the run it describes would be worse than no
 * record, because a reader cannot tell which of the two lied.
 */
export type QueueRunLogSource = Readonly<{
  /** The target this queue run drained. */
  target: string
  /** The recorded yrd pin this queue run executed, when it could be read. */
  pin?: string
  /** The runs this queue run drove, in order. */
  runs: readonly QueueRunSourceRun[]
  /** Changes considered and not selected, with the reason. */
  blocked?: readonly QueueRunSourceBlocked[]
  /** One row per outcome the notifier handled this pass. */
  messages?: readonly QueueRunSourceMessage[]
  /** Changes this queue run refused at admission, where most fails and every
   * stuck actually land — they never become a run. */
  refusals?: readonly QueueRunSourceRefusal[]
  /** Checks this queue run ran outside a run's steps, which is most of them:
   * the on-submit checks run at admission. */
  checks?: readonly QueueRunSourceCheck[]
}>

/**
 * A change the queue run REFUSED at admission, as its `change` and `result`
 * records.
 *
 * Needed because most changes never become a `Run`: a check that fails or gets
 * stuck at admission leaves no run at all, so a log built from `runs` alone
 * showed the pass's message and nothing about the change it was about —
 * measured 2026-09-02, a failing queue run whose log held two lines and named
 * neither the branch nor the check.
 *
 * The refusal row is a STREAK, so it is filtered to this queue run by its own
 * `lastAt`: a row last written before this queue run started belongs to an
 * earlier one and is not re-reported here.
 */
export type QueueRunSourceRefusal = Readonly<{
  pr?: string
  branch?: string
  headSha?: string
  code?: string
  kind?: string
  reason?: string
  lastAt?: string
}>

/** A check this queue run ran, whatever it was admitting or merging. */
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


/** The shape this module reads off a `Run`. Structural, so `@yrd/queue`'s own
 * `Run` satisfies it without this module depending on the whole model. */
export type QueueRunSourceRun = Readonly<{
  id: string
  base?: string
  conclusion?: string
  status?: string
  error?: Readonly<{ code?: string; message?: string }>
  integration?: Readonly<{ commit?: string; baseSha?: string }>
  stepSelection?: Readonly<{ baseSha?: string; configBlobSha?: string }>
  prs?: readonly QueueRunSourceChange[]
  steps?: readonly QueueRunSourceStep[]
}>

export type QueueRunSourceChange = Readonly<{ id?: string; branch?: string; headSha?: string }>

export type QueueRunSourceStep = Readonly<{
  name?: string
  kind?: string
  job?: Readonly<{
    id?: string
    startedAt?: string
    finishedAt?: string
    requestedAt?: string
    conclusion?: string
    status?: string
    error?: Readonly<{ code?: string; message?: string }>
    output?: unknown
  }>
}>

export type QueueRunSourceBlocked = Readonly<{
  pr?: QueueRunSourceChange
  eligibility?: Readonly<{ reason?: Readonly<{ code?: string; message?: string }> }>
}>

export type QueueRunSourceMessage = Readonly<{
  attempt?: string
  kind?: string
  recipient?: string
  ball?: string
  disposition?: string
}>

/** The first failing step's code — the one fact the result turns on when the
 * run itself recorded none. */
function failedStepCode(run: QueueRunSourceRun): string | undefined {
  for (const step of run.steps ?? []) {
    if (step.job?.conclusion === "failure" && step.job.error?.code !== undefined) return step.job.error.code
  }
  return undefined
}

/**
 * Pass, fail or stuck — the three results, read from what the run recorded.
 *
 * `stuck` is handed in rather than imported so this stays pure and so the ONE
 * definition of who owns a code (ENVIRONMENT_OWNED_FAILURE_CODES) is the one
 * the caller passes. A second copy of that judgement here is exactly the kind
 * of disagreement the log exists to prevent.
 */
function runResult(run: QueueRunSourceRun, stuck: (code: string) => boolean): "pass" | "fail" | "stuck" {
  const code = run.error?.code ?? failedStepCode(run)
  if (code === undefined) return run.conclusion === "failure" ? "fail" : "pass"
  return stuck(code) ? "stuck" : "fail"
}

/** The change a run is about, when it is about exactly one. */
function soleChange(run: QueueRunSourceRun): Readonly<{ branch?: string; head?: string }> {
  const first = run.prs?.[0]
  return {
    ...(first?.branch === undefined ? {} : { branch: first.branch }),
    ...(first?.headSha === undefined ? {} : { head: first.headSha }),
  }
}

/**
 * Every record one queue run writes, in the order a reader wants them: the
 * queue run itself, then per run the changes it took, the checks it ran, the
 * result it reached and the merge it wrote, then the changes it held, then the
 * messages it sent.
 *
 * `run` and `at` are stamped by the writer, so they are absent here — which is
 * also what makes two queue runs' records comparable.
 */
export function queueRunLogRecords(
  source: QueueRunLogSource,
  stuck: (code: string) => boolean,
): readonly QueueRunLogEntry[] {
  const records: QueueRunLogEntry[] = []
  const selection = source.runs.find((run) => run.stepSelection !== undefined)?.stepSelection
  records.push({
    kind: "run",
    target: source.target,
    ...(source.pin === undefined ? {} : { pin: source.pin }),
    ...(selection?.baseSha === undefined ? {} : { base: selection.baseSha }),
    ...(selection?.configBlobSha === undefined ? {} : { config: selection.configBlobSha }),
  })
  for (const ran of source.checks ?? []) {
    if (ran.startedAt === undefined || ran.finishedAt === undefined) continue
    records.push({
      kind: "check",
      ...(ran.branch === undefined ? {} : { branch: ran.branch }),
      ...(ran.head === undefined ? {} : { head: ran.head }),
      ...(ran.name === undefined ? {} : { check: ran.name }),
      started: ran.startedAt,
      ended: ran.finishedAt,
      durationMs: ran.durationMs ?? Date.parse(ran.finishedAt) - Date.parse(ran.startedAt),
      ...(ran.log === undefined ? {} : { log: ran.log }),
      ...(ran.exit === undefined ? {} : { exit: ran.exit }),
    })
  }
  for (const run of source.runs) {
    const change = soleChange(run)
    for (const taken of run.prs ?? []) {
      records.push({
        kind: "change",
        ...(taken.branch === undefined ? {} : { branch: taken.branch }),
        ...(taken.headSha === undefined ? {} : { head: taken.headSha }),
        decision: "selected",
      })
    }
    const code = run.error?.code ?? failedStepCode(run)
    records.push({
      kind: "result",
      ...change,
      result: runResult(run, stuck),
      ...(code === undefined ? {} : { code }),
      // The inputs the rule used, so a reader can check the result rather than
      // trust it — the whole point of naming inputs in the plan.
      inputs: {
        conclusion: run.conclusion ?? run.status ?? "unknown",
        ...(code === undefined ? {} : { environmentOwned: stuck(code) }),
      },
    })
    if (run.integration?.commit !== undefined) {
      records.push({
        kind: "merge",
        ...change,
        commit: run.integration.commit,
        // The plan asks for the new target tip, which IS the merge commit: the
        // target fast-forwards onto it. The tip BEFORE the merge is not carried
        // here, because the integration proof's own `baseSha` is the merge
        // commit too, and a `base` field holding the merge would be a lie a
        // reader cannot detect (measured 2026-09-02).
        tip: run.integration.commit,
      })
    }
  }
  for (const refused of source.refusals ?? []) {
    const subject = {
      ...(refused.branch === undefined ? {} : { branch: refused.branch }),
      ...(refused.headSha === undefined ? {} : { head: refused.headSha }),
    }
    records.push({
      kind: "change",
      ...subject,
      decision: "refused",
      ...(refused.code === undefined ? {} : { code: refused.code }),
      ...(refused.reason === undefined ? {} : { reason: refused.reason }),
    })
    records.push({
      kind: "result",
      ...subject,
      // The admission kind IS the billing decision the queue already made, so
      // it is the input the result rule used — read off the row, never
      // recomputed here into a second opinion.
      result: refused.kind === "infrastructure" ? "stuck" : "fail",
      ...(refused.code === undefined ? {} : { code: refused.code }),
      inputs: {
        admission: refused.kind ?? "unknown",
        ...(refused.code === undefined ? {} : { environmentOwned: stuck(refused.code) }),
      },
    })
  }
  for (const held of source.blocked ?? []) {
    records.push({
      kind: "change",
      ...(held.pr?.branch === undefined ? {} : { branch: held.pr.branch }),
      ...(held.pr?.headSha === undefined ? {} : { head: held.pr.headSha }),
      decision: "held",
      ...(held.eligibility?.reason?.code === undefined ? {} : { code: held.eligibility.reason.code }),
      ...(held.eligibility?.reason?.message === undefined ? {} : { reason: held.eligibility.reason.message }),
    })
  }
  for (const message of source.messages ?? []) {
    records.push({
      kind: "message",
      recipient: message.recipient ?? "unknown",
      says: message.kind ?? message.disposition ?? "unknown",
      ...(message.ball === undefined ? {} : { id: message.ball }),
    })
  }
  return records
}
