import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { parseJournalFrame, type Event, type Journal } from "@yrd/core"
import { createExclusive } from "@yrd/persistence"
import type { ConditionalLogger } from "loggily"
import * as z from "zod"

const DATABASE_FILE = "run-index.sqlite"
const ARTIFACT_DIRECTORY = "artifacts"
const MANIFEST_FILE = "manifest.json"
const DETAIL_LIMIT = 500

const RunManifestSchema = z
  .object({
    version: z.literal(1),
    run: z.string().min(1),
    prs: z
      .array(
        z
          .object({
            id: z.string().min(1),
            revision: z.number().int().positive(),
            issue: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
    status: z.enum(["running", "passed", "failed", "canceled"]),
    terminalStep: z.string().min(1).optional(),
    failureCode: z.string().min(1).optional(),
    detailExcerpt: z.string().min(1).optional(),
    artifactDir: z.string().min(1),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1).optional(),
  })
  .strict()

type RunManifest = z.infer<typeof RunManifestSchema>

type RunStatus = "running" | "passed" | "failed" | "canceled"

type RunIndexRow = Readonly<{
  run_id: string
  pr_id: string
  revision: number
  issue: string | null
  status: RunStatus
  terminal_step: string | null
  failure_code: string | null
  detail_excerpt: string | null
  artifact_dir: string
  started_at: string
  finished_at: string | null
}>

export type RunIndexObserver = Readonly<{
  journal: Journal<unknown>
  start(): void
  close(): Promise<void>
}>

export type PrunedRunArtifact = Readonly<{ run: string; artifactDir: string }>

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function detailExcerpt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const oneLine = value.replace(/\s+/gu, " ").trim()
  if (oneLine === "") return undefined
  return oneLine.length <= DETAIL_LIMIT ? oneLine : `${oneLine.slice(0, DETAIL_LIMIT - 1)}…`
}

function safeArtifactDirectory(stateDir: string, run: string): string {
  if (!/^[a-z0-9._-]+$/iu.test(run)) throw new Error(`yrd: unsafe Queue run id '${run}' for artifact projection`)
  const root = resolve(stateDir, ARTIFACT_DIRECTORY)
  const candidate = resolve(root, run)
  if (dirname(candidate) !== root) throw new Error(`yrd: Queue run '${run}' escapes the artifact root`)
  return candidate
}

function openDatabase(stateDir: string): Database {
  const database = new Database(join(stateDir, DATABASE_FILE), { create: true })
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;")
  database.exec(`
    CREATE TABLE IF NOT EXISTS run_index_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pr_metadata (
      pr_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      issue TEXT,
      PRIMARY KEY (pr_id, revision)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS run_index (
      run_id TEXT NOT NULL,
      pr_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      issue TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'canceled')),
      terminal_step TEXT,
      failure_code TEXT,
      detail_excerpt TEXT,
      artifact_dir TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      PRIMARY KEY (run_id, pr_id, revision)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS run_index_pr_finished
      ON run_index(pr_id, finished_at DESC);
    INSERT OR IGNORE INTO run_index_metadata(key, value) VALUES ('cursor', '0');
    INSERT OR IGNORE INTO run_index_metadata(key, value) VALUES ('manifests_rebuilt', '0');
  `)
  return database
}

function manifestRebuildPending(database: Database): boolean {
  return (
    database
      .query<{ value: string }, [string]>("SELECT value FROM run_index_metadata WHERE key = ?")
      .get("manifests_rebuilt")?.value !== "1"
  )
}

function isMissingFile(error: unknown): boolean {
  return record(error)?.code === "ENOENT"
}

async function readManifest(path: string): Promise<RunManifest | undefined> {
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  return RunManifestSchema.parse(JSON.parse(source))
}

async function rebuildFromManifests(database: Database, stateDir: string): Promise<void> {
  if (!manifestRebuildPending(database)) return
  const root = resolve(stateDir, ARTIFACT_DIRECTORY)
  await mkdir(root, { recursive: true })
  const manifests: Array<Readonly<{ manifest: RunManifest; artifactDir: string }>> = []
  for (const entry of (await readdir(root, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const artifactDir = safeArtifactDirectory(stateDir, entry.name)
    const manifest = await readManifest(join(artifactDir, MANIFEST_FILE))
    if (manifest === undefined) continue
    if (manifest.run !== entry.name) {
      throw new Error(
        `yrd: run manifest '${join(artifactDir, MANIFEST_FILE)}' names '${manifest.run}', expected '${entry.name}'`,
      )
    }
    manifests.push({ manifest, artifactDir })
  }

  const insertMetadata = database.query(
    `INSERT INTO pr_metadata(pr_id, revision, issue) VALUES (?, ?, ?)
     ON CONFLICT(pr_id, revision) DO UPDATE SET issue = COALESCE(excluded.issue, pr_metadata.issue)`,
  )
  const insertRun = database.query(
    `INSERT INTO run_index(
       run_id, pr_id, revision, issue, status, terminal_step, failure_code,
       detail_excerpt, artifact_dir, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, pr_id, revision) DO UPDATE SET
       issue = COALESCE(excluded.issue, run_index.issue),
       status = excluded.status,
       terminal_step = excluded.terminal_step,
       failure_code = excluded.failure_code,
       detail_excerpt = excluded.detail_excerpt,
       artifact_dir = excluded.artifact_dir,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at`,
  )

  database.run("BEGIN IMMEDIATE")
  try {
    for (const { manifest, artifactDir } of manifests) {
      for (const member of manifest.prs) {
        insertMetadata.run(member.id, member.revision, member.issue ?? null)
        insertRun.run(
          manifest.run,
          member.id,
          member.revision,
          member.issue ?? null,
          manifest.status,
          manifest.terminalStep ?? null,
          manifest.failureCode ?? null,
          manifest.detailExcerpt ?? null,
          artifactDir,
          manifest.startedAt,
          manifest.finishedAt ?? null,
        )
      }
    }
    database.query("UPDATE run_index_metadata SET value = '1' WHERE key = 'manifests_rebuilt'").run()
    database.run("COMMIT")
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {
      // Preserve the rebuild error; rollback is best-effort after a failed transaction.
    }
    throw error
  }
}

/**
 * Delete terminal run artifacts only under an explicit caller-supplied policy.
 * There is intentionally no host default: retention and the per-call bound are
 * product/operations policy, and every committed deletion is announced.
 */
export async function pruneRunArtifacts(
  options: Readonly<{
    stateDir: string
    retentionMs: number
    maxDeletes: number
    now?: string
    write(line: string): void
  }>,
): Promise<readonly PrunedRunArtifact[]> {
  if (!Number.isSafeInteger(options.retentionMs) || options.retentionMs <= 0) {
    throw new Error("yrd: artifact GC retentionMs must be a positive integer")
  }
  if (!Number.isSafeInteger(options.maxDeletes) || options.maxDeletes <= 0) {
    throw new Error("yrd: artifact GC maxDeletes must be a positive integer")
  }
  const now = options.now === undefined ? Date.now() : Date.parse(options.now)
  if (!Number.isFinite(now)) throw new Error(`yrd: artifact GC now '${options.now}' is not a timestamp`)
  const cutoff = new Date(now - options.retentionMs).toISOString()
  const exclusive = createExclusive(join(options.stateDir, "run-index"), { timeoutMs: 30_000 })
  const deleted: PrunedRunArtifact[] = []
  await mkdir(options.stateDir, { recursive: true })
  await exclusive.run(async () => {
    using database = openDatabase(options.stateDir)
    await rebuildFromManifests(database, options.stateDir)
    const candidates = database
      .query<Readonly<{ run_id: string; artifact_dir: string }>, [string, number]>(
        `SELECT run_id, MIN(artifact_dir) AS artifact_dir
           FROM run_index
          GROUP BY run_id
         HAVING SUM(
                  CASE
                    WHEN status IN ('passed', 'failed', 'canceled') AND finished_at IS NOT NULL THEN 0
                    ELSE 1
                  END
                ) = 0
            AND MAX(finished_at) <= ?
            AND MIN(artifact_dir) = MAX(artifact_dir)
          ORDER BY MAX(finished_at), run_id
          LIMIT ?`,
      )
      .all(cutoff, options.maxDeletes)

    const removeRows = database.query("DELETE FROM run_index WHERE run_id = ?")
    for (const candidate of candidates) {
      const artifactDir = safeArtifactDirectory(options.stateDir, candidate.run_id)
      if (candidate.artifact_dir !== artifactDir) {
        throw new Error(
          `yrd: artifact GC index path '${candidate.artifact_dir}' is not canonical for run '${candidate.run_id}'`,
        )
      }
      await rm(artifactDir, { recursive: true, force: true })
      removeRows.run(candidate.run_id)
      options.write(`yrd: artifact GC deleted ${artifactDir} (run ${candidate.run_id})`)
      deleted.push({ run: candidate.run_id, artifactDir })
    }
  })
  return deleted
}

function projectionCursor(database: Database): number {
  const row = database
    .query<{ value: string }, [string]>("SELECT value FROM run_index_metadata WHERE key = ?")
    .get("cursor")
  const cursor = Number(row?.value ?? 0)
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("yrd: run index cursor is invalid")
  return cursor
}

function setProjectionCursor(database: Database, cursor: number): void {
  database
    .query(
      "INSERT INTO run_index_metadata(key, value) VALUES ('cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(String(cursor))
}

function projectPRMetadata(database: Database, event: Event): void {
  const data = record(event.data)
  if (data === undefined) return
  const pr = text(data.pr)
  const revision = positiveInteger(data.revision)
  const issue = text(data.issue) ?? text(data.issueRef)
  if (pr === undefined || revision === undefined || issue === undefined) return
  database
    .query(
      `INSERT INTO pr_metadata(pr_id, revision, issue) VALUES (?, ?, ?)
       ON CONFLICT(pr_id, revision) DO UPDATE SET issue = excluded.issue`,
    )
    .run(pr, revision, issue)
  database.query("UPDATE run_index SET issue = ? WHERE pr_id = ? AND revision = ?").run(issue, pr, revision)
}

function issueFor(database: Database, pr: string, revision: number): string | null {
  return (
    database
      .query<{ issue: string | null }, [string, number]>(
        "SELECT issue FROM pr_metadata WHERE pr_id = ? AND revision = ?",
      )
      .get(pr, revision)?.issue ?? null
  )
}

function projectStarted(database: Database, stateDir: string, event: Event): string | undefined {
  if (event.name !== "queue/run/started") return undefined
  const runData = record(record(event.data)?.run)
  const run = text(runData?.id)
  const members = Array.isArray(runData?.prs) ? runData.prs : []
  if (run === undefined || members.length === 0) return undefined
  const artifactDir = safeArtifactDirectory(stateDir, run)
  const insert = database.query(
    `INSERT INTO run_index(
       run_id, pr_id, revision, issue, status, terminal_step, failure_code,
       detail_excerpt, artifact_dir, started_at, finished_at
     ) VALUES (?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, ?, NULL)
     ON CONFLICT(run_id, pr_id, revision) DO UPDATE SET
       issue = COALESCE(excluded.issue, run_index.issue),
       artifact_dir = excluded.artifact_dir,
       started_at = excluded.started_at`,
  )
  for (const memberValue of members) {
    const member = record(memberValue)
    const pr = text(member?.id)
    const revision = positiveInteger(member?.revision)
    if (pr === undefined || revision === undefined) continue
    const issue = text(member?.issue) ?? issueFor(database, pr, revision)
    if (issue !== null) {
      database
        .query(
          `INSERT INTO pr_metadata(pr_id, revision, issue) VALUES (?, ?, ?)
           ON CONFLICT(pr_id, revision) DO UPDATE SET issue = excluded.issue`,
        )
        .run(pr, revision, issue)
    }
    insert.run(run, pr, revision, issue, artifactDir, event.ts)
  }
  return run
}

function projectFailed(database: Database, event: Event): string | undefined {
  if (event.name !== "queue/run/failed") return undefined
  const data = record(event.data)
  const run = text(data?.run)
  const error = record(data?.error)
  if (run === undefined || error === undefined) return undefined
  database
    .query(
      `UPDATE run_index
          SET status = 'failed', terminal_step = COALESCE(?, terminal_step),
              failure_code = ?, detail_excerpt = ?, finished_at = ?
        WHERE run_id = ?`,
    )
    .run(
      text(data?.step) ?? null,
      text(error.code) ?? "queue-run-failed",
      detailExcerpt(error.message) ?? "Queue run failed",
      event.ts,
      run,
    )
  return run
}

function projectRejected(database: Database, event: Event): string | undefined {
  if (event.name !== "pr/rejected") return undefined
  const data = record(event.data)
  const run = text(data?.run)
  const pr = text(data?.pr)
  const revision = positiveInteger(data?.revision)
  if (data === undefined || run === undefined || pr === undefined || revision === undefined) return undefined
  const issue = text(data?.issueRef) ?? issueFor(database, pr, revision)
  database
    .query(
      `UPDATE run_index
          SET status = 'failed', issue = COALESCE(?, issue), terminal_step = COALESCE(?, terminal_step),
              detail_excerpt = COALESCE(?, detail_excerpt), finished_at = ?
        WHERE run_id = ? AND pr_id = ? AND revision = ?`,
    )
    .run(issue, text(data.step) ?? null, detailExcerpt(data.detail) ?? null, event.ts, run, pr, revision)
  return run
}

function projectIntegrated(database: Database, event: Event): string | undefined {
  if (event.name !== "pr/integrated") return undefined
  const data = record(event.data)
  const run = text(data?.run)
  const pr = text(data?.pr)
  const revision = positiveInteger(data?.revision)
  if (run === undefined || pr === undefined || revision === undefined) return undefined
  database
    .query(
      `UPDATE run_index SET status = 'passed', finished_at = ?
        WHERE run_id = ? AND pr_id = ? AND revision = ?`,
    )
    .run(event.ts, run, pr, revision)
  return run
}

function projectCanceled(database: Database, event: Event): string | undefined {
  if (event.name !== "queue/run/canceled") return undefined
  const data = record(event.data)
  const run = text(data?.run)
  if (data === undefined || run === undefined) return undefined
  database
    .query(
      `UPDATE run_index
          SET status = 'canceled', detail_excerpt = ?, finished_at = ?
        WHERE run_id = ?`,
    )
    .run(detailExcerpt(data.reason) ?? "Queue run canceled", event.ts, run)
  return run
}

function projectEvent(database: Database, stateDir: string, event: Event): string | undefined {
  projectPRMetadata(database, event)
  return (
    projectStarted(database, stateDir, event) ??
    projectFailed(database, event) ??
    projectRejected(database, event) ??
    projectIntegrated(database, event) ??
    projectCanceled(database, event)
  )
}

function manifestStatus(rows: readonly RunIndexRow[]): RunStatus {
  if (rows.some((row) => row.status === "failed")) return "failed"
  if (rows.some((row) => row.status === "canceled")) return "canceled"
  if (rows.every((row) => row.status === "passed")) return "passed"
  return "running"
}

async function writeManifest(database: Database, run: string): Promise<void> {
  const rows = database
    .query<RunIndexRow, [string]>(
      `SELECT run_id, pr_id, revision, issue, status, terminal_step, failure_code,
              detail_excerpt, artifact_dir, started_at, finished_at
         FROM run_index WHERE run_id = ? ORDER BY pr_id, revision`,
    )
    .all(run)
  const first = rows[0]
  if (first === undefined) return
  const terminal = rows.find((row) => row.terminal_step !== null)
  const failure = rows.find((row) => row.failure_code !== null)
  const detail = rows.find((row) => row.detail_excerpt !== null)
  const finished = rows
    .map((row) => row.finished_at)
    .filter((value): value is string => value !== null)
    .toSorted()
    .at(-1)
  const manifest = {
    version: 1,
    run,
    prs: rows.map((row) => ({
      id: row.pr_id,
      revision: row.revision,
      ...(row.issue === null ? {} : { issue: row.issue }),
    })),
    status: manifestStatus(rows),
    ...(terminal?.terminal_step === null || terminal?.terminal_step === undefined
      ? {}
      : { terminalStep: terminal.terminal_step }),
    ...(failure?.failure_code === null || failure?.failure_code === undefined
      ? {}
      : { failureCode: failure.failure_code }),
    ...(detail?.detail_excerpt === null || detail?.detail_excerpt === undefined
      ? {}
      : { detailExcerpt: detail.detail_excerpt }),
    artifactDir: first.artifact_dir,
    startedAt: rows.map((row) => row.started_at).toSorted()[0]!,
    ...(finished === undefined ? {} : { finishedAt: finished }),
  }
  await mkdir(first.artifact_dir, { recursive: true })
  const target = join(first.artifact_dir, MANIFEST_FILE)
  const candidate = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(candidate, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" })
    await rename(candidate, target)
  } finally {
    await rm(candidate, { force: true })
  }
}

/**
 * Maintain the Queue-run lookup as a rebuildable host projection. The wrapped
 * journal remains the sole authority; append only wakes an idempotent reader,
 * and Core's checkpoint capability is passed through unchanged.
 */
export function createRunIndexObserver(
  options: Readonly<{ journal: Journal<unknown>; stateDir: string; log?: ConditionalLogger }>,
): RunIndexObserver {
  const log = options.log?.child("run-index")
  const exclusive = createExclusive(
    join(options.stateDir, "run-index"),
    { timeoutMs: 30_000 },
    log === undefined ? {} : { log },
  )
  let requested = false
  let closed = false
  let failure: unknown
  let worker: Promise<void> | undefined

  const drain = async (): Promise<void> => {
    await mkdir(options.stateDir, { recursive: true })
    await exclusive.run(async () => {
      using database = openDatabase(options.stateDir)
      await rebuildFromManifests(database, options.stateDir)
      let cursor = projectionCursor(database)
      for await (const batch of options.journal.read(cursor)) {
        const changed = new Set<string>()
        database.run("BEGIN IMMEDIATE")
        try {
          for (const value of batch.values) {
            const frame = parseJournalFrame(value)
            for (const event of frame.events) {
              const run = projectEvent(database, options.stateDir, event)
              if (run !== undefined) changed.add(run)
            }
          }
          database.run("COMMIT")
        } catch (error) {
          try {
            database.run("ROLLBACK")
          } catch {
            // Preserve the projection error; rollback is best-effort after a failed transaction.
          }
          throw error
        }
        for (const run of changed) await writeManifest(database, run)
        setProjectionCursor(database, batch.cursor)
        cursor = batch.cursor
      }
    })
  }

  const run = async (): Promise<void> => {
    while (requested && !closed) {
      requested = false
      try {
        await drain()
        failure = undefined
      } catch (error) {
        failure = error
        log?.error?.("run index projection deferred; journal cursor remains replayable", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const wake = (): void => {
    if (closed) return
    requested = true
    if (worker !== undefined) return
    worker = run().finally(() => {
      worker = undefined
      if (requested && !closed) wake()
    })
  }

  const journal: Journal<unknown> = Object.freeze({
    read: (after, before) => options.journal.read(after, before),
    async append(value, expectedCursor) {
      const appended = await options.journal.append(value, expectedCursor)
      if (appended.appended) wake()
      return appended
    },
    ...(options.journal.checkpoint === undefined ? {} : { checkpoint: options.journal.checkpoint }),
  })

  return Object.freeze({
    journal,
    start: wake,
    async close() {
      wake()
      while (worker !== undefined) await worker
      closed = true
      if (failure !== undefined) throw failure
    },
  })
}
