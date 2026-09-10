/**
 * The queue run's log: a JSONL record stream
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Log).
 *
 * One log record per occurrence, each carrying the queue run's id and, where there is
 * one, the branch, head and check it is about. Six kinds appear in every run:
 * the run itself (gitlink, target, config blob), each change considered and its
 * decision, each check's start and end with duration and log path, each merge,
 * and each message sent. A seventh, `merged-direct`, appears only when
 * something went around the queue: one record per commit on the target the
 * queue did not put there (E5). An
 * eighth, `settle`, names each gitlink a candidate or landing merge raised,
 * plus each pre-existing off-main anomaly it retained without lowering.
 * A ninth, `pause`, appears only when an active pause stops a run before a
 * merge. A tenth, `reap`, appears only when a run before this one died without removing
 * its worktrees: one record per worktree taken down. An eleventh, `orphan`,
 * appears only when a reaped worktree named a merge candidate for a change
 * still "checked": one row for what recovery decided, or for a candidate it
 * found but would not trust (@i/10-yrd/24344). The human line is a
 * rendering of the record, never a second source: whatever a reader prints, the
 * file is what happened.
 *
 * A check writes its `check` kind twice, once at each end of it: the start row
 * carries the name, the phase and the log the check is about to write, and the
 * end row adds `end` and `ms`. `end` is what tells them apart — only ending
 * can say it — so a reader after the result reads exactly what it always did,
 * and a reader watching a run sees the check that is running now (plan § Owed
 * after M5; a queue run whose log went quiet for 28.7 minutes was stopped as a
 * hang). The target's `setup:` writes the same two rows under the name
 * `setup`, because it is the longest thing a fresh worktree does.
 *
 * The file is named by this run's own id, minted here at open, so two runs
 * never write one file and a run that built nothing still has its own log.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { incidentTrailers, type Incident } from "./incident.ts"
import type { GitInvocation, GitInvocationOptions, GitOutputSink } from "./git.ts"

/** Ref-write diagnostics emitted by run.ts's refused bookkeeping-write path. */
export const CHANGE_REF_DIAGNOSTICS = {
  taken: "change-ref-taken",
  contended: "change-ref-contended",
} as const

/**
 * A run's own id: the instant it started, then a random tail, so two runs never
 * write one path however close together they start.
 *
 * Minted here because the queue's whole workdir is keyed by it — the
 * log, the worktrees, the check logs — and `yrd check` is a run of checks too:
 * it takes an id from the same minter and writes under the same directories,
 * rather than a second scheme that a reader would have to learn.
 */
export function runId(started: Date = new Date()): string {
  return `q-${started.toISOString().replace(/[-:.]/gu, "")}-${Math.random().toString(16).slice(2, 10)}`
}

export const LOG_KINDS = [
  "run",
  "pause",
  "change",
  "check",
  "result",
  "settle",
  "merge",
  "message",
  "merged-direct",
  "reap",
  "orphan",
  "git",
  "observation",
] as const

export type LogKind = (typeof LOG_KINDS)[number]

export type LogRecord = Readonly<{
  kind: LogKind
  run: string
  at: string
  branch?: string
  head?: string
  check?: string
  [field: string]: string | number | boolean | undefined | readonly string[]
}>

/** A record as the run writes it; the log adds `run` and `at`. */
export type LogWrite = Readonly<{
  kind: LogKind
  [field: string]: string | number | boolean | undefined | readonly string[]
}>

export type QueueRunLog = Readonly<{
  /** This run's own id: the start instant, then a random tail. */
  id: string
  /** The file every record of this run is appended to. */
  path: string
  write(record: LogWrite): void
  openGitOutput: NonNullable<GitInvocationOptions["openOutput"]>
  writeGitInvocation(invocation: GitInvocation): void
}>

/**
 * Open the log for one queue run. `render`, when given, receives every record
 * as it is written: the human line is a rendering of the record, and this is
 * the one place a rendering can come from.
 */
export function openLog(
  directory: string,
  now: () => Date = () => new Date(),
  render?: (record: LogRecord) => void,
): QueueRunLog {
  mkdirSync(directory, { recursive: true })
  const id = runId(now())
  const path = join(directory, `${id}.jsonl`)
  const gitDirectory = join(directory, id, "git")
  let invocationCount = 0
  const write = (record: LogWrite): void => {
    const kind: LogKind = record.kind
    const full: LogRecord = { ...record, at: now().toISOString(), kind, run: id }
    appendFileSync(path, `${JSON.stringify(full)}\n`)
    render?.(full)
  }
  return {
    id,
    path,
    write,
    openGitOutput() {
      mkdirSync(gitDirectory, { recursive: true })
      const stem = join(gitDirectory, String(++invocationCount))
      return openGitOutput(`${stem}.stdout.bin`, `${stem}.stderr.bin`)
    },
    writeGitInvocation(invocation) {
      mkdirSync(gitDirectory, { recursive: true })
      const evidence =
        invocation.artifacts === undefined
          ? join(gitDirectory, `${++invocationCount}.failed.json`)
          : `${invocation.artifacts.stdout}.json`
      const result = invocation.result
      // Ordinary bytes are in the raw files. Keep loss/settlement metadata and
      // the exact bounded control bytes beside them, never in a parsed child row.
      const metadata = {
        ...invocation,
        result:
          result === undefined
            ? undefined
            : {
                ...result,
                stdout: undefined,
                stderr: undefined,
                rawOutput: undefined,
                extraStdio:
                  result.extraStdio === undefined
                    ? undefined
                    : {
                        ...result.extraStdio,
                        bytes: undefined,
                        bytesBase64: Buffer.from(result.extraStdio.bytes).toString("base64"),
                      },
              },
      }
      writeFileSync(evidence, `${JSON.stringify(metadata)}\n`, { flag: "wx" })
      write({
        kind: "git",
        cwd: invocation.cwd,
        args: invocation.args,
        evidence,
        executable: invocation.selection?.executable ?? "git",
        contract: invocation.selection?.contract ?? "native",
        scope: invocation.selection?.scope,
        origin: invocation.selection?.origin,
        exit: result?.exitCode,
        complete: invocation.artifacts?.complete ?? false,
        failure: invocation.failure,
        refusal: invocation.protocol?.refusal?.kind,
      })
    },
  }
}

/** Run-owned raw artifacts; Process is still the only stream reader. */
function openGitOutput(stdout: string, stderr: string): GitOutputSink {
  const out = openSync(stdout, "wx")
  let err: number
  try {
    err = openSync(stderr, "wx")
  } catch (error) {
    try {
      closeSync(out)
    } catch (closeError) {
      throw new AggregateError([error, closeError], `could not open raw Git output ${stderr} or close ${stdout}`)
    }
    throw error
  }
  let closed = false
  return {
    stdout,
    stderr,
    onOutput({ stream, chunk }) {
      if (closed) throw new Error(`raw Git output ${stream} is already closed`)
      const fd = stream === "stdout" ? out : err
      let at = 0
      while (at < chunk.byteLength) {
        const wrote = writeSync(fd, chunk, at, chunk.byteLength - at)
        if (wrote === 0) throw new Error(`raw Git output ${stream} made no write progress`)
        at += wrote
      }
    },
    close() {
      if (closed) return
      closed = true
      const errors: unknown[] = []
      try {
        closeSync(out)
      } catch (error) {
        errors.push(error)
      }
      try {
        closeSync(err)
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) throw new AggregateError(errors, `could not close raw Git output ${stdout}, ${stderr}`)
    },
  }
}

/**
 * Reading the log back.
 *
 * The writer above is one half of the JSONL format; these are the other, and
 * they live here so the format has ONE home and a change to it cannot land on
 * only one side. Nothing below writes.
 *
 * The journal is LOCAL to the machine the queue runs on: `<workdir>/logs/`,
 * and `workdir` is git configuration about THIS MACHINE (`yrd.workdir`). So a
 * reader on any other machine has no journal, and every field derived from one
 * — which check is running now, a run's id before it merged, when checking
 * began — is ABSENT there. Absent, and said out loud: {@link Journals.absent}
 * carries the sentence a caller prints, naming the directory it looked in.
 * Never a blank, never a zero.
 */

/** A check as a run's journal records it: the start row, and the end row when it ended. */
export type JournalCheck = Readonly<{
  name: string
  /** The phase it ran in — `submit`, `merge`, or `check`. */
  phase: string
  startedAt: Date
  /** The file it wrote; the start row names it before the check has written a byte. */
  log?: string
  /** Absent while it is still running: `end` is the one field only an ending can write. */
  endedAt?: Date
  /** How long it took, from the end row. */
  ms?: number
  /** The separate result row's measured verdict and exit, not the change's current state. */
  result?: "pass" | "fail" | "stuck"
  exit?: string
}>

/** What one run's journal says about one change. */
export type JournalRun = Readonly<{
  /** The run's own id, which is also its file's name. */
  id: string
  /** When the run started, read from the id itself. */
  startedAt: Date
  branch: string
  head: string
  /** Every check this run ran on this change, in the order it ran them. */
  checks: readonly JournalCheck[]
  /** The check running now: a start row this run never ended. */
  running?: JournalCheck
  /** The decision this run recorded — `checked`, `merged`, `failed`, `stuck` — when it made one. */
  decision?: string
  reason?: string
  incident?: Incident
  /** Original ref-write warnings; they are not decisions or queue incidents. */
  diagnostics?: readonly LogRecord[]
  /**
   * A row of this run's journal that could not be read, as the sentence saying
   * what was wrong with it. The row was skipped and everything else in the run
   * was kept (24408): a writer's short row costs the row it is on, never the
   * read. Absent when every row of this run about this change was sound.
   */
  malformed?: readonly string[]
  /** The target recorded in this run's header; never borrowed from a later run. */
  base?: string
  /** The merge commit this run recorded, if it recorded one. */
  merge?: string
  /** Last non-diagnostic record, or the first diagnostic when there is no other record. */
  at: Date
}>

export type Journals = Readonly<{
  /** The directory that was read. */
  dir: string
  /** Why there is nothing, when there is nothing: a sentence naming what was looked for and where. */
  absent?: string
  /**
   * Every journal row in the window that could not be read, each naming the run
   * it was in, the `<branch>@<head>` it was about, and what was wrong with it.
   * Empty when the window was clean — never absent, because a caller that
   * prints nothing here is stating that every row read, and a skipped row that
   * nobody prints is exactly the silent error this reader must not commit.
   */
  malformed: readonly Readonly<{ run: string; key: string; message: string }>[]
  /** Every run that wrote about a change, newest run first, keyed `<branch>@<head>`. */
  runs: ReadonlyMap<string, readonly JournalRun[]>
}>

/** The key a change's runs are held under: the same `<branch>@<head>` a change ref is named by. */
export function journalKey(branch: string, head: string): string {
  return `${branch}@${head}`
}

/**
 * When a run started, read from its own id. `runId` mints
 * `q-<ISO with -:. removed>-<random>`, so the instant is IN the name and a
 * reader can window the files it opens without opening any of them.
 * Undefined for a name that is not one of ours.
 */
export function runStartedAt(id: string): Date | undefined {
  const stamp = /^q-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-/u.exec(id)
  if (stamp === null) return undefined
  const [, year, month, day, hour, minute, second, milliseconds] = stamp
  if ([year, month, day, hour, minute, second, milliseconds].some((part) => part === undefined)) return undefined
  const at = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${milliseconds}Z`)
  return Number.isNaN(at.getTime()) ? undefined : at
}

/** One run's journal, read: every record it wrote, in order. A line that is not a record is skipped and counted, never guessed at. */
export function readRunLog(dir: string, run: string): readonly LogRecord[] {
  const text = readFileSync(join(dir, `${run}.jsonl`), "utf8")
  const records: LogRecord[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== "object" || parsed === null) continue
    const record = parsed as LogRecord
    if (typeof record.kind !== "string" || typeof record.run !== "string" || typeof record.at !== "string") continue
    records.push(record)
  }
  return records
}

export type ReadJournalsOptions = Readonly<{
  now?: Date
  /** How far back the runs read reach; the same seven days `list` windows its ended rows by. */
  sinceMs?: number
}>

/**
 * Every run journal in the window, read into what each says about each change.
 *
 * The window is applied to the FILE NAME, so a directory holding months of runs
 * costs one `readdir` and opens only the files that can still be about a row on
 * screen. A run whose name is not one of ours is not opened at all, and the
 * count of them is in {@link Journals.absent} when nothing else was found.
 */
export function readJournals(dir: string, options: ReadJournalsOptions = {}): Journals {
  const now = options.now ?? new Date()
  const sinceMs = options.sinceMs ?? 7 * 24 * 60 * 60 * 1000
  let names: readonly string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? "there is no such directory" : String(error)
    return { absent: `no run journal was read: ${dir} — ${why}`, dir, malformed: [], runs: new Map() }
  }
  const ours = names.filter((name) => name.endsWith(".jsonl")).map((name) => name.slice(0, -".jsonl".length))
  const windowed = ours.filter((id) => {
    const startedAt = runStartedAt(id)
    return startedAt !== undefined && now.getTime() - startedAt.getTime() <= sinceMs
  })
  if (windowed.length === 0) {
    const held =
      ours.length === 0
        ? "it holds no run journal"
        : `its ${String(ours.length)} run journal(s) are all older than the window`
    return { absent: `no run journal was read: ${dir} — ${held}`, dir, malformed: [], runs: new Map() }
  }
  const runs = new Map<string, JournalRun[]>()
  const malformed: { run: string; key: string; message: string }[] = []
  for (const id of [...windowed].sort()) {
    const startedAt = runStartedAt(id)
    if (startedAt === undefined) continue
    for (const run of runsIn(readRunLog(dir, id), id, startedAt)) {
      const key = journalKey(run.branch, run.head)
      for (const message of run.malformed ?? []) malformed.push({ key, message, run: run.id })
      const held = runs.get(key)
      if (held === undefined) runs.set(key, [run])
      else held.unshift(run)
    }
  }
  return { dir, malformed, runs }
}

/**
 * What one change record claims about an incident: the incident itself, the
 * SENTENCE naming its defect, or nothing when it claims none.
 *
 * Reading a defect instead of throwing one is 24408. `waiting()` wrote four of
 * the six authority fields onto a journal row, and every read verb — `yrd
 * list`, `yrd queue list`, `yrd queue show`, the watch — refused for that
 * journal's whole seven-day window while the queue itself was healthy and
 * merging. One short row now costs the row it is on, and the change it was
 * about carries the sentence. The WRITER's validator is deliberately
 * unchanged: a malformed incident must still never be written.
 */
function incidentIn(record: LogRecord, id: string, branch: string, head: string): Incident | string | undefined {
  const { code, subject, via, evidence, next, owner } = record
  if ([code, subject, via, evidence, next, owner].every((value) => value === undefined)) return undefined
  if (
    typeof code !== "string" ||
    typeof subject !== "string" ||
    typeof via !== "string" ||
    typeof evidence !== "string" ||
    typeof next !== "string" ||
    typeof owner !== "string"
  ) {
    // Name WHICH of the six are gone. "Incomplete" alone sends the reader back
    // to the JSONL with jq — the very cost 24408 was opened to remove — and a
    // field that is present but not a string is a different bug from one that
    // was never written, so the two are never reported as one.
    const claimed = [
      ["code", code],
      ["subject", subject],
      ["via", via],
      ["evidence", evidence],
      ["next", next],
      ["owner", owner],
    ] as const
    const absent = claimed.filter(([, value]) => value === undefined).map(([name]) => name)
    const unreadable = claimed
      .filter(([, value]) => value !== undefined && typeof value !== "string")
      .map(([name]) => name)
    const said = [
      ...(absent.length === 0 ? [] : [`missing ${absent.join(", ")}`]),
      ...(unreadable.length === 0 ? [] : [`not a string: ${unreadable.join(", ")}`]),
    ].join("; ")
    return `run journal ${id} has an incomplete incident for ${journalKey(branch, head)}: ${said}`
  }
  const incident = { code, subject, via, evidence, next, owner }
  try {
    // The writer's own validator, run on the read path: a malformed value is a
    // defect of this ROW, and the reader reports it rather than dying on it.
    incidentTrailers(incident)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return incident
}

/** What one run's records say about each change it touched. */
function runsIn(records: readonly LogRecord[], id: string, startedAt: Date): readonly JournalRun[] {
  const byChange = new Map<
    string,
    {
      branch: string
      head: string
      checks: JournalCheck[]
      decision?: string
      reason?: string
      incident?: Incident
      diagnostics?: LogRecord[]
      malformed?: string[]
      merge?: string
      at: Date
    }
  >()
  const base = records.find((record) => record.kind === "run")?.base
  const held = (branch: string, head: string, at: Date) => {
    const key = journalKey(branch, head)
    const found = byChange.get(key) ?? { at, branch, checks: [], head }
    found.at = at
    byChange.set(key, found)
    return found
  }
  for (const record of records) {
    const { branch, head } = record
    if (typeof branch !== "string" || typeof head !== "string") continue
    const at = new Date(record.at)
    if (Number.isNaN(at.getTime())) continue
    const reason = typeof record.reason === "string" ? record.reason : undefined
    // `next` is deliberately not read here: it is legacy diagnostic text as
    // often as it is incident authority, so only `incidentIn` weighs it.
    const { code, subject, via, evidence, owner } = record
    const diagnostic =
      record.kind === "change" &&
      Object.values(CHANGE_REF_DIAGNOSTICS).some((value) => value === reason) &&
      [code, subject, via, evidence, owner].every((value) => value === undefined)
    // Legacy `next` and current `inspect` are both diagnostic fields here.
    // Any incident authority field above instead takes normal validation.
    // A warning must not advance an existing run's completion clock; a run
    // containing only warnings gets its first instant, never a decision.
    const prior = byChange.get(journalKey(branch, head))
    const change = held(branch, head, diagnostic && prior !== undefined ? prior.at : at)
    if (diagnostic) {
      ;(change.diagnostics ??= []).push(record)
      continue
    }
    if (record.kind === "change") {
      // Read the incident BEFORE adopting anything else this record says: a
      // row that cannot be read is skipped whole, so nothing half of it
      // claimed reaches the change. Whatever state the run's OTHER records
      // give still stands, and no decision is invented for the gap.
      const claimed = incidentIn(record, id, branch, head)
      if (typeof claimed === "string") {
        ;(change.malformed ??= []).push(claimed)
        continue
      }
      if (typeof record.decision === "string") {
        change.decision = record.decision
        change.reason = reason
      }
      if (claimed !== undefined) change.incident = claimed
    }
    if (record.kind === "merge" && typeof record.commit === "string") change.merge = record.commit
    if (record.kind === "result") {
      const index = change.checks.findLastIndex((check) => check.name === record.name && check.phase === record.phase)
      const check = change.checks[index]
      if (check === undefined) {
        ;(change.malformed ??= []).push(
          `run journal ${id} has a result without a check for ${journalKey(branch, head)}: ${String(record.name)}`,
        )
        continue
      }
      if (record.result !== "pass" && record.result !== "fail" && record.result !== "stuck") {
        ;(change.malformed ??= []).push(`run journal ${id} has an invalid check result: ${String(record.result)}`)
        continue
      }
      change.checks[index] = {
        ...check,
        result: record.result,
        ...(typeof record.exit === "string" ? { exit: record.exit } : {}),
      }
    }
    if (record.kind !== "check") continue
    const name = record.name
    const phase = record.phase
    const start = record.start
    if (typeof name !== "string" || typeof phase !== "string" || typeof start !== "string") continue
    const checkStartedAt = new Date(start)
    if (Number.isNaN(checkStartedAt.getTime())) continue
    const log = typeof record.log === "string" ? record.log : undefined
    // `end` is what tells the two rows apart — only an ending can write it —
    // so the end row settles the start row this run already wrote (log.ts's
    // own contract above), and a start row still standing IS the running check.
    const standing = change.checks.findIndex(
      (candidate) =>
        candidate.name === name &&
        candidate.phase === phase &&
        candidate.startedAt.getTime() === checkStartedAt.getTime(),
    )
    const end = typeof record.end === "string" ? new Date(record.end) : undefined
    const ended = end === undefined || Number.isNaN(end.getTime()) ? undefined : end
    const check: JournalCheck = {
      name,
      phase,
      startedAt: checkStartedAt,
      ...(log === undefined ? {} : { log }),
      ...(ended === undefined ? {} : { endedAt: ended }),
      ...(typeof record.ms === "number" ? { ms: record.ms } : {}),
    }
    if (standing === -1) change.checks.push(check)
    else change.checks[standing] = check
  }
  return [...byChange.values()].map((change) => {
    const running = change.checks.findLast((check) => check.endedAt === undefined)
    return {
      at: change.at,
      branch: change.branch,
      checks: change.checks,
      ...(change.decision === undefined ? {} : { decision: change.decision }),
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...(change.incident === undefined ? {} : { incident: change.incident }),
      ...(change.diagnostics === undefined ? {} : { diagnostics: change.diagnostics }),
      ...(change.malformed === undefined ? {} : { malformed: change.malformed }),
      ...(change.merge === undefined ? {} : { merge: change.merge }),
      ...(typeof base === "string" ? { base } : {}),
      head: change.head,
      id,
      // A run that reached a decision about the change is not running a check
      // on it, whatever start row went unended when the run was killed.
      ...(running === undefined || change.decision !== undefined ? {} : { running }),
      startedAt,
    }
  })
}
