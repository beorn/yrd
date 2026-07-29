import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { EventSchema } from "@yrd/core"
import { JobRequestSchema, JobTransitionSchema } from "@yrd/job"
import type { JournalView, JournalViewEntry } from "@yrd/persistence"
import type { QueueAttempt } from "./queue-status-view.tsx"

export type QueueReadModel = Readonly<{
  view: JournalView
  attempts(): Promise<readonly QueueAttempt[]>
}>

export function createQueueReadModel(options: Readonly<{ dir: string }>): QueueReadModel {
  const path = join(options.dir, "journal.sqlite")
  let cachedCursor: number | undefined
  let cachedGeneration: number | undefined
  let cachedAttempts: readonly QueueAttempt[] = []
  const view: JournalView = Object.freeze({
    id: VIEW_ID,
    version: VIEW_VERSION,
    fingerprint: VIEW_FINGERPRINT,
    install(database) {
      database.run(SCHEMA)
    },
    reset(database) {
      database.run(`
        DROP TABLE IF EXISTS queue_attempts;
        DROP TABLE IF EXISTS queue_job_starts;
        DROP TABLE IF EXISTS queue_job_requests;
      `)
    },
    apply(database, entry) {
      projectQueueFrame(database, entry)
    },
  })

  return Object.freeze({
    view,
    attempts() {
      return Promise.resolve().then(() => {
        if (!existsSync(path)) return []
        using database = new Database(path, { readonly: true, strict: true })
        database.run("BEGIN")
        try {
          const { cursor, generation } = assertCurrentQueueView(database, view)
          if (cursor === cachedCursor && generation === cachedGeneration) {
            database.run("COMMIT")
            return cachedAttempts
          }
          const attempts = Object.freeze(
            database
              .query<QueueAttemptRow, []>(
                `SELECT
                 job_id,
                 run_id,
                 step_name,
                 step_index,
                 revision,
                 attempt,
                 runner,
                 outcome,
                 requested_at,
                 started_at,
                 finished_at,
                 duration_ms,
                 result_json
               FROM queue_attempts
               ORDER BY sequence_id`,
              )
              .all()
              .map(queueAttempt),
          )
          database.run("COMMIT")
          cachedCursor = cursor
          cachedGeneration = generation
          cachedAttempts = attempts
          return attempts
        } catch (error) {
          database.run("ROLLBACK")
          throw error
        }
      })
    },
  })
}

const VIEW_ID = "yrd.queue-attempts"
const VIEW_VERSION = 1
const ATTEMPT_SEQUENCE_SCALE = 1_000_000
const SCHEMA = `
CREATE TABLE queue_job_requests (
  job_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  revision TEXT NOT NULL,
  requested_at TEXT NOT NULL
) STRICT;
CREATE TABLE queue_job_starts (
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  runner TEXT NOT NULL,
  started_at TEXT NOT NULL,
  PRIMARY KEY (job_id, attempt)
) STRICT;
CREATE TABLE queue_attempts (
  sequence_id INTEGER PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  revision TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  runner TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'lost')),
  requested_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json)
    AND COALESCE((
      (
        json_extract(result_json, '$.status') = 'passed'
        AND json_type(result_json, '$.output') IS NOT NULL
      )
      OR (
        json_extract(result_json, '$.status') = 'failed'
        AND json_type(result_json, '$.error') = 'object'
      )
      OR (
        json_extract(result_json, '$.status') = 'lost'
        AND json_type(result_json, '$.reason') = 'text'
        AND length(json_extract(result_json, '$.reason')) > 0
      )
    ), 0)
  )
) STRICT;
CREATE INDEX queue_attempts_run_sequence ON queue_attempts(run_id, sequence_id);
CREATE INDEX queue_attempts_finished_sequence ON queue_attempts(finished_at, sequence_id);
CREATE INDEX queue_attempts_outcome_sequence ON queue_attempts(outcome, sequence_id);
`
const VIEW_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify({ id: VIEW_ID, version: VIEW_VERSION, schema: SCHEMA, projection: "queue-attempts-v1" }))
  .digest("hex")

type QueueRequestRow = Readonly<{
  run_id: string
  step_name: string
  step_index: number
  revision: string
  requested_at: string
}>

type QueueStartRow = Readonly<{
  runner: string
  started_at: string
}>

type QueueAttemptRow = Readonly<{
  job_id: string
  run_id: string
  step_name: string
  step_index: number
  revision: string
  attempt: number
  runner: string
  outcome: QueueAttempt["outcome"]
  requested_at: string
  started_at: string
  finished_at: string
  duration_ms: number
  result_json: string
}>

function projectQueueFrame(database: Database, entry: JournalViewEntry): void {
  const value = entry.value as Readonly<{ events?: readonly unknown[] }>
  if (!Array.isArray(value.events)) throw new Error("yrd: queue read model requires a Journal Frame")
  for (const [index, candidate] of value.events.entries()) {
    const event = EventSchema.parse(candidate)
    if (event.name === "job/requested") {
      const request = JobRequestSchema.parse(event.data)
      const input = request.input
      if (
        typeof input === "object" &&
        input !== null &&
        "run" in input &&
        typeof input.run === "string" &&
        "step" in input &&
        typeof input.step === "string" &&
        "index" in input &&
        typeof input.index === "number"
      ) {
        database
          .query(
            `INSERT INTO queue_job_requests(
               job_id, run_id, step_name, step_index, revision, requested_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(event.id, input.run, input.step, input.index, request.revision, event.ts)
      }
      continue
    }
    if (event.name !== "job/transitioned") continue
    const transition = JobTransitionSchema.parse(event.data)
    if (transition.type === "start") {
      database
        .query(
          `INSERT INTO queue_job_starts(job_id, attempt, runner, started_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(transition.id, transition.attempt, transition.runner, event.ts)
      continue
    }
    if (transition.type !== "finish" && transition.type !== "lose") continue

    const request = database
      .query<QueueRequestRow, [string]>(
        `SELECT run_id, step_name, step_index, revision, requested_at
         FROM queue_job_requests
         WHERE job_id = ?`,
      )
      .get(transition.id)
    const start = database
      .query<QueueStartRow, [string, number]>(
        `SELECT runner, started_at
         FROM queue_job_starts
         WHERE job_id = ? AND attempt = ?`,
      )
      .get(transition.id, transition.attempt)
    if (request === null || start === null) continue
    const durationMs = elapsedMs(start.started_at, event.ts, transition.id, transition.attempt)
    const outcome =
      transition.type === "lose" ? "lost" : transition.result.conclusion === "success" ? "passed" : "failed"
    const result =
      transition.type === "lose"
        ? { status: "lost" as const, reason: transition.reason }
        : transition.result.conclusion === "success"
          ? { status: "passed" as const, output: transition.result.output }
          : {
              status: "failed" as const,
              error: transition.result.error,
              ...(transition.result.output === undefined ? {} : { output: transition.result.output }),
            }
    const sequenceId = entry.cursor * ATTEMPT_SEQUENCE_SCALE + index
    if (!Number.isSafeInteger(sequenceId)) throw new Error("yrd: queue attempt sequence exceeds SQLite integer safety")
    database
      .query(
        `INSERT INTO queue_attempts(
           sequence_id, job_id, run_id, step_name, step_index, revision,
           attempt, runner, outcome, requested_at, started_at, finished_at,
           duration_ms, result_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sequenceId,
        transition.id,
        request.run_id,
        request.step_name,
        request.step_index,
        request.revision,
        transition.attempt,
        start.runner,
        outcome,
        request.requested_at,
        start.started_at,
        event.ts,
        durationMs,
        JSON.stringify(result),
      )
  }
}

function elapsedMs(startedAt: string, finishedAt: string, job: string, attempt: number): number {
  const start = Date.parse(startedAt)
  const finish = Date.parse(finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(finish)) {
    throw new Error(`yrd: queue attempt '${job}:${String(attempt)}' has invalid time`)
  }
  if (finish < start) {
    throw new Error(
      `yrd: queue attempt '${job}:${String(attempt)}' finish '${finishedAt}' precedes start '${startedAt}'`,
    )
  }
  return finish - start
}

function assertCurrentQueueView(
  database: Database,
  view: JournalView,
): Readonly<{ cursor: number; generation: number }> {
  try {
    const head = database
      .query<{ value: string }, []>("SELECT value FROM journal_metadata WHERE key = 'head_cursor'")
      .get()?.value
    const generationValue = database
      .query<{ value: string }, []>("SELECT value FROM journal_metadata WHERE key = 'journal_views_generation'")
      .get()?.value
    const registered = database
      .query<{ version: number; fingerprint: string; cursor: number }, [string]>(
        "SELECT version, fingerprint, cursor FROM journal_views WHERE view_id = ?",
      )
      .get(view.id)
    const cursor = Number(head)
    const generation = Number(generationValue)
    if (
      head === undefined ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      generationValue === undefined ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      registered === null ||
      registered.version !== view.version ||
      registered.fingerprint !== view.fingerprint ||
      registered.cursor !== cursor
    ) {
      throw new Error("stale")
    }
    return { cursor, generation }
  } catch {
    throw new Error("yrd: queue read model is unavailable or stale; run 'yrd doctor --rebuild-views'")
  }
}

function queueAttempt(row: QueueAttemptRow): QueueAttempt {
  return {
    job: row.job_id,
    run: row.run_id,
    step: row.step_name,
    index: row.step_index,
    requestedAt: row.requested_at,
    revision: row.revision,
    attempt: row.attempt,
    runner: row.runner,
    outcome: row.outcome,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    result: JSON.parse(row.result_json) as QueueAttempt["result"],
  }
}
