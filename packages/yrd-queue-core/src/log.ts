/**
 * The queue run's log: a JSONL event stream
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Log).
 *
 * One record per event, each carrying the queue run's id and, where there is
 * one, the branch, head and check it is about. Six kinds appear in every run:
 * the run itself (pin, target, config blob), each change considered and its
 * decision, each check's start and end with duration and log path, each merge,
 * and each message sent. A seventh, `merged-bypass`, appears only when
 * something went around the queue: one record per commit on the target the
 * queue did not put there (E5). An
 * eighth, `freeze`, appears only when an active freeze stops a run before a
 * merge. A ninth, `reap`, appears only when a run before this one died without removing
 * its worktrees: one record per worktree taken down. The human line is a
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

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/**
 * A run's own id: the instant it started, then a random tail, so two runs never
 * write one path however close together they start.
 *
 * Minted here because the queue's whole working directory is keyed by it — the
 * log, the worktrees, the check logs — and `yrd check` is a run of checks too:
 * it takes an id from the same minter and writes under the same directories,
 * rather than a second scheme that a reader would have to learn.
 */
export function runId(started: Date = new Date()): string {
  return `q-${started.toISOString().replace(/[-:.]/gu, "")}-${Math.random().toString(16).slice(2, 10)}`
}

export const LOG_KINDS = [
  "run",
  "freeze",
  "change",
  "check",
  "result",
  "merge",
  "message",
  "merged-bypass",
  "reap",
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
  return {
    id,
    path,
    write(record) {
      const kind: LogKind = record.kind
      const full: LogRecord = { ...record, at: now().toISOString(), kind, run: id }
      appendFileSync(path, `${JSON.stringify(full)}\n`)
      render?.(full)
    },
  }
}
