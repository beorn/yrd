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
 * found but would not trust (@i/10-yrd/24344). A twelfth, `step`, times the
 * round's own steps that are neither a check nor a program (the queue read,
 * each compose, each prepare): a start row, then an end row with `ms`, so the
 * journal is never silent across one (@i/10-yrd/25303). The human line is a
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
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { incidentTrailers, type Incident } from "./incident.ts"
import type { GitInvocation, GitInvocationOptions, GitOutputSink } from "./git.ts"

/**
 * The decisions a run can record about a change — the journal's type contract
 * (`JournalRun.decision`). Any other string on a `kind=change` row is a
 * defective writer: a refused bookkeeping write once logged `decision=sent`
 * and folded a merged run to sent (@i/10-yrd/24129). The fold refuses it
 * loudly and never synthesises a decision for the gap.
 *
 * Exported only so tests/vocabulary.test.ts can pin it: a reader built before
 * a new decision refuses the rows that carry it.
 */
export const TERMINAL_DECISIONS: ReadonlySet<string> = new Set(["checked", "merged", "failed", "stuck", "withdrawn"])

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
  // The queue this run is for, written the instant its remote URL resolves
  // (24470). It is a record of its own rather than a header field because the
  // header is written FIRST, before any Git call, and the queue name is the one
  // thing that cannot be known that early. Its presence is therefore also the
  // mark that the Git preamble completed: a header with no `queue` record after
  // it is a run that died before it could read its own target.
  "queue",
  "pause",
  "change",
  "check",
  "result",
  "settle",
  // A diverged gitlink the queue composed itself (24977): the change's head, the
  // component main merged in, and the component and root commits that came out.
  // The re-cut is a new head of the queue's making; nothing is amended.
  "recut",
  // A submodule main the queue moved at land, children first, to a pin the
  // settling merge kept ahead of it (24454): one row per published path, so the
  // journal says which submodule mains a landing moved and to what.
  "publish",
  "merge",
  "message",
  "merged-direct",
  "reap",
  "orphan",
  "git",
  // 24573: what the checks are about to read, hashed — one row per path the
  // candidate changed, carrying the blob the merge commit records and the hash
  // of the bytes on disk. A `judged` row with same=false says the root does not
  // contain the commit it claims to be, which is the question three seats could
  // not answer because the root was gone by the time anyone looked.
  "judged",
  // The merge root a failing run KEPT, and where. Written only when a check
  // fails, so the next investigator reads bytes instead of inferring.
  "retained",
  "observation",
  // A store the queue's reference repository had to be given before a compose
  // could borrow from it, and a compose that succeeded without borrowing. Two
  // kinds rather than one because they are a cause and its symptom: a
  // `reference` row is the queue repairing its own ground, and a `warning` row
  // is a compose that went to the network anyway. On 2026-09-09 the second
  // happened fifteen times per compose for four hours with no row of either
  // kind to read, because the counts that carried it were indistinguishable
  // from an ordinary fetch.
  "reference",
  "warning",
  // A scope a failing check offered its own settled-base run that the queue
  // could not honour (narrowing.ts). Only the refusal is a row of its own: an
  // honoured offer and an absent one are both readable on the base check's own
  // `scope` field, and a refusal that left no trace would be indistinguishable
  // from a check that never offered anything.
  "narrowing",
  // git-super's descent into an Ahead parent (24454 row 2). One record per
  // parent, because an EQUAL nested child emits no settle row -- so without
  // this the commonest nested outcome is invisible in the journal and the only
  // proof of the walk is a hand run. Readers match kinds by equality and none
  // refuses an unrecognised one, so adding this cannot break an existing reader.
  "descent",
  // A verdict this run computed and then threw away, because the change ended
  // under it while the check was running (24979). The row exists so the discard
  // is never silent (24924 row 2): without it, a round that judged a change and
  // recorded nothing about it reads exactly like a round that skipped it, and
  // the only other account of the work was the crash this replaced.
  "discarded",
  // A step of the round that is neither a check nor a program, timed so the
  // journal never goes silent across it (@i/10-yrd/25303 box 1): the queue
  // read, a candidate's compose, and its prepare. Two rows per step, in the
  // `setup` shape: `start` as it begins, then `end` and `ms` as it ends, with
  // `threw` when it ended by throwing. Before these rows, a compose was one
  // 20 to 28 s silence between the queue read and the first `settle` row.
  "step",
  // A merge check an override held off for one change's merge (25296): one row
  // per skipped check, naming the override record, its actor and its window.
  // Never a `result` row: a skip is not a check that ran, and a skip counted
  // as a result would let a phase that stopped early read as complete.
  "skipped",
  // A write to the override ref this run made itself: the `expired` record for
  // a window that passed, written before the round took its snapshot (25296).
  "override",
  // A merged change's task branch, deleted on origin after its merged record
  // landed, leased on the merged head so origin's advertisement stops growing
  // (@i/10-yrd/25568, @cto 50480459). `branch-kept` is the refused lease: the
  // branch moved or was already gone, and `saw` says which, a sha or "absent".
  "branch-deleted",
  "branch-kept",
  // The round's remote calls, counted from git's trace2 log when the round ends (25570 row 3): processes,
  // ssh_children (an upper bound on logins), remote_ms, unreadable lines and one field per remote verb. Readers match kinds by equality, so this
  // closing row breaks none of them.
  "remote-calls",
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

/**
 * Did this run die in its Git preamble, before it could name its queue?
 *
 * A NAMED TERMINAL OUTCOME, and the reason it needs one: such a run leaves a
 * journal its readers used to call malformed, which is a writer defect with a
 * different cure. The run's own Git rows are right there and name the call that
 * failed. Both eras of journal reach the word through this one predicate, so
 * `yrd watch` and the health probe can never disagree about it (24470).
 *
 * Says nothing about WHEN: a run still executing its preamble looks exactly
 * like one that died in it, so every caller must gate this on the run not being
 * alive. That is the caller's evidence to hold, never this function's to guess.
 */
export function runDiedInPreamble(records: readonly LogRecord[]): boolean {
  const header = records.find((record) => record.kind === "run")
  // Before 24470 the header came last and carried `queue` itself, so a journal
  // of nothing but Git rows is the old shape of this same death, and a legacy
  // header that names its queue resolved it and did not die here.
  if (header === undefined) return records.length > 0 && records.every((record) => record.kind === "git")
  if (typeof header.queue === "string") return false
  return !records.some((record) => record.kind === "queue")
}

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
  result?: "pass" | "fail" | "stuck" | "deferred"
  exit?: string
  /**
   * On a `base` phase row, which of the two base runs this was: `full` is the
   * whole check re-run at the settled base, `narrowed` is the scope the check
   * itself asked for (narrowing.ts). Absent on every other phase, and on a
   * base row written before this field existed.
   */
  scope?: "narrowed" | "full"
}>

/**
 * One git command a round ran, as its journal row says it (25441): the row is
 * written when the command has finished. Output is never inline: `stdout` and
 * `stderr` are the run's raw files, read only when a reader asks for them, and
 * both are absent when the invocation failed before it could write any.
 */
export type JournalCommand = Readonly<{
  args: readonly string[]
  cwd: string
  exit?: number
  stdout?: string
  stderr?: string
  /** Why there is no output: the invocation's own failure, as the row says it. */
  failure?: string
}>

/**
 * One step of a round (25441): compose, worktree, prepare, read, push, merge,
 * publish — the queue's own names — with the git commands it ran. Steps NEST
 * (a compose times its worktree inside it, measured on a live journal), so a
 * command belongs to the innermost step open when its row was written. That
 * pairing is exact because a round is serial within those nested scopes:
 * `timedStep` writes its end row on a throw too, and git rows come only from
 * the round's own runner. An end row settles its own start; a step still open
 * inside it was cut short by a killed call: it is closed there and `unended`.
 */
export type JournalStep = Readonly<{
  name: string
  phase: string
  startedAt: Date
  endedAt?: Date
  ms?: number
  threw?: true
  unended?: true
  commands: readonly JournalCommand[]
  /** git-super's own timed phases of a compose, written after its end row: sub-rows, never steps. */
  parts?: readonly Readonly<{ name: string; ms: number }>[]
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
  /**
   * Every step of the round that touched this change, in journal order: its
   * own (compose, merge, …) and the round's (read), which serve every change
   * the round held (25441).
   */
  steps: readonly JournalStep[]
  /** Git commands the round ran outside any step; the display's `round` tab, shown only when non-empty. */
  commands: readonly JournalCommand[]
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

const journalFileCache = new Map<string, { mtimeMs: number; size: number; runs: JournalRun[] }>()

function journalPath(dir: string, id: string): string {
  return join(dir, `${id}.jsonl`)
}

function pruneJournalCache(dir: string, windowed: readonly string[]): void {
  const live = new Set(windowed.map((id) => journalPath(dir, id)))
  const prefix = dir.endsWith("/") ? dir : `${dir}/`
  for (const key of journalFileCache.keys()) {
    if (key.startsWith(prefix) && !live.has(key)) journalFileCache.delete(key)
  }
}

function cachedRunsIn(dir: string, id: string, startedAt: Date): readonly JournalRun[] {
  const path = journalPath(dir, id)
  const st = statSync(path)
  const hit = journalFileCache.get(path)
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.runs
  const runs = [...runsIn(readRunLog(dir, id), id, startedAt)]
  journalFileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, runs })
  return runs
}

/**
 * Every record across every run journal in the directory that matches,
 * oldest run first — unwindowed, unlike {@link readJournals}: a caller asking
 * "has this already happened" needs the true history, not the seven days
 * `list` renders, and a run journal is never pruned once written. A missing
 * directory reads as no runs made yet, the same absence `readJournals` reads;
 * any other failure to list it is thrown rather than read as "no runs" or
 * "every run", because a caller using this to decide whether to do something
 * again needs to know the question could not be answered, not be handed
 * either wrong answer silently. A direct merge's own notifier is the first
 * of these: having no change ref to hold a receipt (with-notify.ts), it reads
 * its own prior "message" rows back through here.
 */
export function recordsMatching(dir: string, matches: (record: LogRecord) => boolean): readonly LogRecord[] {
  let names: readonly string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const ids = names.filter((name) => name.endsWith(".jsonl")).map((name) => name.slice(0, -".jsonl".length))
  const found: LogRecord[] = []
  for (const id of ids.sort()) {
    for (const record of readRunLog(dir, id)) {
      if (matches(record)) found.push(record)
    }
  }
  return found
}

/** Count this marker's latest refused publications, stopping at its successful merge or three refusals. */
function recentPublicationWarnings(
  dir: string,
  ref: string,
  marker: string,
  openedAt: Date,
  subject: "cas-refused" | "publication-not-landed",
): number {
  let names: readonly string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw error
  }
  const firstRun = `q-${openedAt.toISOString().replace(/[-:.]/gu, "")}`
  const ids = names
    .filter((name) => name.startsWith("q-") && name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .filter((id) => id.slice(0, firstRun.length) >= firstRun)
    .sort()
    .reverse()
  let count = 0
  for (const id of ids) {
    for (const record of [...readRunLog(dir, id)].reverse()) {
      if (record.ref !== ref || record.marker !== marker) continue
      if (record.kind === "merge") return count
      if (
        record.kind === "warning" &&
        (record.subject === "cas-refused" || record.subject === "publication-not-landed") &&
        record.subject !== subject
      ) {
        return count
      }
      if (record.kind === "warning" && record.subject === subject) {
        count++
        if (count >= 3) return count
      }
    }
  }
  return count
}

/** Count a marker's typed CAS refusals across run journals. */
export function recentCasRefusals(dir: string, ref: string, marker: string, openedAt: Date): number {
  return recentPublicationWarnings(dir, ref, marker, openedAt, "cas-refused")
}

/** Count a marker's consecutive transport outcomes that definitely did not land. */
export function recentPublicationNotLanded(dir: string, ref: string, marker: string, openedAt: Date): number {
  return recentPublicationWarnings(dir, ref, marker, openedAt, "publication-not-landed")
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
    pruneJournalCache(dir, [])
    const held =
      ours.length === 0
        ? "it holds no run journal"
        : `its ${String(ours.length)} run journal(s) are all older than the window`
    return { absent: `no run journal was read: ${dir} — ${held}`, dir, malformed: [], runs: new Map() }
  }
  pruneJournalCache(dir, windowed)
  const runs = new Map<string, JournalRun[]>()
  const malformed: { run: string; key: string; message: string }[] = []
  for (const id of [...windowed].sort()) {
    const startedAt = runStartedAt(id)
    if (startedAt === undefined) continue
    for (const run of cachedRunsIn(dir, id, startedAt)) {
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
/**
 * The steps of one run's journal and the git commands each ran, in journal
 * order (see {@link JournalStep} for why the pairing is exact). A step naming
 * a change is that change's; a step naming only the target (`read`) is the
 * round's. A row that is not a well-formed step or git row is left to
 * `runsIn`'s own reading and never invents a step.
 */
function stepsIn(records: readonly LogRecord[]): Readonly<{
  byChange: ReadonlyMap<string, readonly Readonly<{ order: number; step: JournalStep }>[]>
  round: readonly Readonly<{ order: number; step: JournalStep }>[]
  commands: readonly JournalCommand[]
}> {
  type Building = {
    order: number
    key?: string
    step: { -readonly [K in keyof JournalStep]: JournalStep[K] } & {
      commands: JournalCommand[]
      parts?: { name: string; ms: number }[]
    }
  }
  const built: Building[] = []
  const commands: JournalCommand[] = []
  // The steps open now, outermost first: a start pushes, its own end row pops it.
  const open: Building[] = []
  const date = (value: unknown): Date | undefined => {
    if (typeof value !== "string") return undefined
    const at = new Date(value)
    return Number.isNaN(at.getTime()) ? undefined : at
  }
  for (const [order, record] of records.entries()) {
    if (record.kind === "git") {
      const command = commandOf(record)
      if (command === undefined) continue
      const innermost = open.at(-1)
      if (innermost === undefined) commands.push(command)
      else innermost.step.commands.push(command)
      continue
    }
    if (record.kind !== "step" || typeof record.name !== "string") continue
    const key =
      typeof record.branch === "string" && typeof record.head === "string"
        ? journalKey(record.branch, record.head)
        : undefined
    if (record.within === "compose") {
      // git-super's phases, written after the compose's end row: parts of the last compose.
      const compose = built.findLast((entry) => entry.step.name === "compose" && entry.key === key)
      if (compose !== undefined && typeof record.ms === "number") {
        ;(compose.step.parts ??= []).push({ ms: record.ms, name: record.name })
      }
      continue
    }
    const startedAt = date(record.start)
    if (startedAt === undefined || typeof record.phase !== "string") continue
    const endedAt = date(record.end)
    if (endedAt === undefined) {
      const started: Building = {
        order,
        ...(key === undefined ? {} : { key }),
        step: { commands: [], name: record.name, phase: record.phase, startedAt },
      }
      built.push(started)
      open.push(started)
      continue
    }
    const ending = {
      endedAt,
      ...(typeof record.ms === "number" ? { ms: record.ms } : {}),
      ...(record.threw === true ? { threw: true as const } : {}),
    }
    // The end row settles its own start; anything still open inside it never ended.
    const at = open.findLastIndex(
      (entry) => entry.step.name === record.name && entry.step.startedAt.getTime() === startedAt.getTime(),
    )
    if (at === -1) {
      built.push({
        order,
        ...(key === undefined ? {} : { key }),
        step: { commands: [], name: record.name, phase: record.phase, startedAt, ...ending },
      })
      continue
    }
    for (const inner of open.splice(at + 1)) inner.step.unended = true
    const settled = open.pop()
    if (settled !== undefined) Object.assign(settled.step, ending)
  }
  const byChange = new Map<string, Readonly<{ order: number; step: JournalStep }>[]>()
  const round: Readonly<{ order: number; step: JournalStep }>[] = []
  for (const entry of built) {
    const settled = { order: entry.order, step: entry.step as JournalStep }
    if (entry.key === undefined) round.push(settled)
    else byChange.set(entry.key, [...(byChange.get(entry.key) ?? []), settled])
  }
  return { byChange, commands, round }
}

/** A git row as a command, with its raw output files named by the evidence path; undefined for a row that is not one. */
function commandOf(record: LogRecord): JournalCommand | undefined {
  const { args, cwd, evidence, exit, failure } = record
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string") || typeof cwd !== "string") return undefined
  const stdout =
    typeof evidence === "string" && evidence.endsWith(".stdout.bin.json")
      ? evidence.slice(0, -".json".length)
      : undefined
  return {
    args: args as string[],
    cwd,
    ...(typeof exit === "number" ? { exit } : {}),
    ...(stdout === undefined ? {} : { stdout, stderr: stdout.replace(/\.stdout\.bin$/u, ".stderr.bin") }),
    ...(typeof failure === "string" ? { failure } : {}),
  }
}

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
        // Only a terminal decision can become the run's decision; a stray
        // non-terminal row must not overwrite a merged run, and no decision
        // is invented for the gap (@i/10-yrd/24129).
        if (TERMINAL_DECISIONS.has(record.decision)) {
          change.decision = record.decision
          change.reason = reason
        } else {
          ;(change.malformed ??= []).push(
            `run journal ${id} has a non-terminal decision for ${journalKey(branch, head)}: ${record.decision}`,
          )
        }
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
      if (
        record.result !== "pass" &&
        record.result !== "fail" &&
        record.result !== "stuck" &&
        record.result !== "deferred"
      ) {
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
    const scope = record.scope === "narrowed" || record.scope === "full" ? record.scope : undefined
    const check: JournalCheck = {
      name,
      phase,
      startedAt: checkStartedAt,
      ...(log === undefined ? {} : { log }),
      ...(ended === undefined ? {} : { endedAt: ended }),
      ...(typeof record.ms === "number" ? { ms: record.ms } : {}),
      ...(scope === undefined ? {} : { scope }),
    }
    if (standing === -1) change.checks.push(check)
    else change.checks[standing] = check
  }
  const stepped = stepsIn(records)
  return [...byChange.values()].map((change) => {
    const running = change.checks.findLast((check) => check.endedAt === undefined)
    const own = stepped.byChange.get(journalKey(change.branch, change.head)) ?? []
    return {
      at: change.at,
      branch: change.branch,
      checks: change.checks,
      steps: [...own, ...stepped.round].sort((left, right) => left.order - right.order).map(({ step }) => step),
      commands: stepped.commands,
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
