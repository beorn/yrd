/**
 * The queue run's log: a JSONL fact stream
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Log).
 *
 * One record per fact, each carrying the queue run's id and, where there is
 * one, the branch, head and check it is about. Six kinds appear in every run:
 * the run itself (pin, target, config blob), each change considered and its
 * decision, each check's start and end with duration and log path, each merge,
 * and each message sent. The human line is a rendering of the record, never a
 * second source: whatever a reader prints, the file is what happened.
 *
 * The file is named by this run's own id, minted here at open, so two runs
 * never write one file and a run that built nothing still has its own log.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export const LOG_KINDS = ["run", "change", "check", "result", "merge", "message"] as const

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

export type QueueRunLog = Readonly<{
  /** This run's own id: the start instant, then a random tail. */
  id: string
  /** The file every record of this run is appended to. */
  path: string
  write(record: Omit<LogRecord, "run" | "at">): void
}>

/** Open the log for one queue run. */
export function openLog(directory: string, now: () => Date = () => new Date()): QueueRunLog {
  mkdirSync(directory, { recursive: true })
  const started = now()
  const id = `q-${started.toISOString().replace(/[-:.]/gu, "")}-${Math.random().toString(16).slice(2, 10)}`
  const path = join(directory, `${id}.jsonl`)
  return {
    id,
    path,
    write(record) {
      appendFileSync(path, `${JSON.stringify({ ...record, at: now().toISOString(), run: id })}\n`)
    },
  }
}
