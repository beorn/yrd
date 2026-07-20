import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { gunzipSync } from "node:zlib"
import { constants, Database } from "bun:sqlite"
import { observeYrdLifecycle, parseJournalFrame, type Journal, type JournalCheckpoint } from "@yrd/core"
import canonicalize from "canonicalize"
import { createLogger, type ConditionalLogger } from "loggily"
import { createExclusive, type Exclusive, type ExclusiveOptions } from "./lock.ts"

const DARWIN_HOMEBREW_SQLITE = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"

export function resolveCustomSqliteLibrary(
  env: string | undefined,
  platform: string,
  fileExists: (path: string) => boolean,
): string | undefined {
  const explicit = env?.trim()
  if (explicit) return explicit
  if (platform === "darwin" && fileExists(DARWIN_HOMEBREW_SQLITE)) return DARWIN_HOMEBREW_SQLITE
  return undefined
}

// Bun bundles its own SQLite, and affected builds (< 3.51.3 without a fixed
// backport) fail assertSafeWalVersion. Bun can substitute an external library,
// but only before the process opens its first connection — hence module load.
// YRD_SQLITE_LIB is the explicit override (fails loud when unloadable); on
// darwin the Homebrew keg is probed as a fallback, and assertSafeWalVersion
// still gates whichever library actually loads.
{
  const candidate = resolveCustomSqliteLibrary(process.env.YRD_SQLITE_LIB, process.platform, existsSync)
  if (candidate) {
    try {
      Database.setCustomSQLite(candidate)
    } catch (error) {
      if (process.env.YRD_SQLITE_LIB?.trim()) {
        throw new Error(
          `yrd: YRD_SQLITE_LIB could not be loaded (${candidate}): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      // silent-fallback-allow: darwin auto-probe only — another library may
      // already be active in this process (a host app that opened SQLite
      // first); the bundled build then still faces assertSafeWalVersion,
      // which fails loud when it is unsafe.
    }
  }
}

const DATABASE_FILE = "journal.sqlite"
const LEGACY_MANIFEST_FILE = "events-v4.manifest.json"
const LEGACY_RECOVERY_FILE = "events-v4.recovery.json"
const LEGACY_V3_FILE = "events-v3.jsonl"
const LEGACY_CUTOVER = `{"v":4,"cutover":"${LEGACY_MANIFEST_FILE}"}\n`
const SQLITE_CUTOVER_VERSION = 1
const SCHEMA_VERSION = 1
const LEGACY_PRIVATE_PATH = /^events-v4\.[a-zA-Z0-9._-]+$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
const LEGACY_CANDIDATE_PATH = /^\.journal\.sqlite-[0-9a-f-]{36}$/iu

type JournalOptions = Readonly<{
  dir: string
  lock?: ExclusiveOptions
  inject?: Readonly<{
    exclusive?: Exclusive
    log?: ConditionalLogger
  }>
}>

type InternalInject = NonNullable<JournalOptions["inject"]> &
  Readonly<{
    platform?: string
    sqliteVersion?: string
    phase?: (phase: string, details: Readonly<Record<string, unknown>>) => void | Promise<void>
  }>

type JournalMode = "mutable" | "read-only"

type Context = Readonly<{
  dir: string
  path: string
  exclusive: Exclusive
  log: ConditionalLogger
  platform: string
  sqliteVersion?: string
  phase(phase: string, details?: Readonly<Record<string, unknown>>): Promise<void>
}>

type PrefixEntry = Readonly<{ cursor: number; value: unknown }>
type StoredEvent = Readonly<{ cursor: number; value_json: string; sha256: string }>
type StoredMarker = Readonly<{ cursor: number }>

export type ArchivedOrphanRecord = Readonly<{
  kind: "archived-orphan"
  provenance: Readonly<{
    "origin-lane": "v3-phantom"
    "origin-file": string
    "origin-row": string
    "source-sha256"?: string
    "imported-at": string
    "imported-by": string
    "collision-policy": "refuse"
  }>
  frame: unknown
}>

export type ArchivedOrphanSnapshot = Readonly<{
  cursor: number
  records: readonly ArchivedOrphanRecord[]
}>

export type ArchivedOrphanCollision = Readonly<{
  kind: "cause" | "command" | "event" | "payload"
  id: string
}>

export type OrphanJournalImportResult =
  | Readonly<{
      status: "imported" | "already-imported"
      cursor: number
      records: number
      sourceSha256: string
    }>
  | Readonly<{
      status: "live-collision"
      cursor: number
      records: number
      sourceSha256: string
      collisions: readonly ArchivedOrphanCollision[]
    }>

type SnapshotHeader = Readonly<{
  cursor: number
  prefix_sha256: string
  prefix_last_cursor: number
  checkpoint_identity: string | null
  checkpoint_json_present: number
  checkpoint_sha256: string | null
}>

type SnapshotPrefix = Readonly<{
  cursor: number
  prefix_json: string
  prefix_sha256: string
  prefix_last_cursor: number
}>

type PreparedCheckpoint = Readonly<{
  snapshotCursor: number
  snapshotPrefixSha256: string
  snapshotPrefixLastCursor: number
  prefixJson: string
  prefixSha256: string
  prefixLastCursor: number
  checkpointJson: string
  checkpointSha256: string
  compactedEvents: number
}>

type LegacyRow =
  | Readonly<{ kind: "live"; cursor: number; value: unknown }>
  | Readonly<{ kind: "orphan"; cursor: number; value: ArchivedOrphanRecord }>

type LegacySource = Readonly<{
  fingerprint: string
  head: number
  rows: readonly LegacyRow[]
  paths: readonly string[]
  pointer: typeof LEGACY_MANIFEST_FILE | typeof LEGACY_V3_FILE
}>

type LegacySqliteCutover = Readonly<{
  v: typeof SQLITE_CUTOVER_VERSION
  cutover: typeof DATABASE_FILE
  state: "pre-publish" | "published"
  backup: string
  fingerprint: string
  pointer: typeof LEGACY_MANIFEST_FILE | typeof LEGACY_V3_FILE
  candidate: string
  digest: string
}>

type LegacySegment = Readonly<{
  path: string
  codec: "gzip"
  codecVersion: string
  codecParameters: "level=9;mtime=0"
  rawSha256: string
  compressedSha256: string
  logicalStart: number
  logicalEnd: number
  rawBytes: number
  frames: number
  generationCreated: number
  sourceGeneration: number
  sourceTailIdentity: string
}>

type LegacyManifest = Readonly<{
  formatVersion: 4
  generation: number
  sourceGeneration: number
  logicalStart: 0
  logicalEnd: number
  frames: number
  segments: readonly LegacySegment[]
  tail: Readonly<{ path: string; identity: string; logicalStart: number; initialSha256: string }>
  tailState: Readonly<{ path: string }>
}>

type LegacyTailState = Readonly<{
  formatVersion: 4
  generation: number
  tailIdentity: string
  committedBytes: number
  logicalEnd: number
  frames: number
  lastChecksum: string | null
}>

function context(options: JournalOptions): Context {
  const inject = (options.inject ?? {}) as InternalInject
  const log = inject.log?.child("journal") ?? createLogger("yrd:journal", [{ level: "warn" }])
  return {
    dir: options.dir,
    path: join(options.dir, DATABASE_FILE),
    exclusive: inject.exclusive ?? createExclusive(options.dir, options.lock, { log }),
    log,
    platform: inject.platform ?? process.platform,
    ...(inject.sqliteVersion === undefined ? {} : { sqliteVersion: inject.sqliteVersion }),
    async phase(name, details = {}) {
      await inject.phase?.(name, details)
    },
  }
}

export function createJournal(options: JournalOptions): Journal<unknown> {
  return createJournalWithMode(options, "mutable")
}

export function createReadOnlyJournal(options: JournalOptions): Journal<unknown> {
  return createJournalWithMode(options, "read-only")
}

function createJournalWithMode(options: JournalOptions, mode: JournalMode): Journal<unknown> {
  const runtime = context(options)
  const checkpoint = {
    load: (identity: string) => loadCheckpoint(runtime, mode, identity),
    ...(mode === "mutable" ? { save: (value: JournalCheckpoint) => saveCheckpoint(runtime, value) } : {}),
  }
  const journal: Journal<unknown> = {
    async *read(after = 0, before) {
      assertCursor(after)
      if (before !== undefined) assertCursor(before)
      const batches =
        mode === "mutable"
          ? await runtime.exclusive.run(async () => {
              await ensureDatabase(runtime)
              return readBatches(runtime, after, before)
            })
          : await readBatches(runtime, after, before)
      for (const batch of batches) yield batch
    },
    append(value, expectedCursor) {
      assertCursor(expectedCursor)
      if (mode === "read-only") return Promise.reject(new Error("yrd: read-only journal cannot append"))
      const frame = parseJournalFrame(value)
      return observeYrdLifecycle(
        runtime.log,
        {
          lifecycle: "append",
          identity: { command: frame.command.id, cause: frame.cause.id, op: frame.command.op },
          attributes: { expectedCursor, events: frame.events.length },
          outcome: (result) => (result.appended ? "succeeded" : "progress"),
          resultAttributes: (result) => result,
        },
        () =>
          withMutableDatabase(runtime, (database) => {
            const head = readHead(database)
            if (head !== expectedCursor) return { appended: false as const, cursor: head }
            const cursor = head + 1
            assertCursor(cursor)
            const valueJson = JSON.stringify(frame)
            database.run("BEGIN IMMEDIATE")
            try {
              database
                .query("INSERT INTO journal_events(cursor, value_json, sha256) VALUES (?, ?, ?)")
                .run(cursor, valueJson, digestText(valueJson))
              writeMetadata(database, "head_cursor", String(cursor))
              database.run("COMMIT")
            } catch (error) {
              rollback(database)
              throw error
            }
            return { appended: true as const, cursor }
          }),
      )
    },
  }
  Object.defineProperty(journal, "checkpoint", { value: checkpoint, enumerable: false })
  return journal
}

async function loadCheckpoint(
  runtime: Context,
  mode: JournalMode,
  identity: string,
): Promise<JournalCheckpoint | undefined> {
  const load = async (): Promise<JournalCheckpoint | undefined> => {
    if (!(await exists(runtime.path))) return undefined
    using database = openReadOnly(runtime.path)
    return readTransaction(database, () => {
      const { snapshot } = assertComplete(database, runtime.path)
      if (snapshot.checkpoint_identity === null) return undefined
      const checkpointJson = readCheckpointJson(database)
      if (
        checkpointJson === null ||
        snapshot.checkpoint_sha256 === null ||
        sha256(Buffer.from(checkpointJson)) !== snapshot.checkpoint_sha256
      ) {
        runtime.log.warn?.("journal projection checkpoint invalid; replaying journal authority", {
          action: "full-replay",
          reason: "checkpoint-checksum-mismatch",
          path: runtime.path,
        })
        return undefined
      }
      if (snapshot.checkpoint_identity !== identity) {
        runtime.log.warn?.("journal projection checkpoint identity changed; replaying journal authority", {
          action: "full-replay",
          reason: "checkpoint-identity-mismatch",
          expected: identity,
          observed: snapshot.checkpoint_identity,
        })
        return undefined
      }
      const checkpoint = JSON.parse(checkpointJson) as JournalCheckpoint
      if (checkpoint.identity !== identity || checkpoint.cursor !== snapshot.cursor) {
        runtime.log.warn?.("journal projection checkpoint binding is invalid; replaying journal authority", {
          action: "full-replay",
          reason: "checkpoint-binding-mismatch",
        })
        return undefined
      }
      return checkpoint
    })
  }
  if (mode === "read-only") return load()
  return runtime.exclusive.run(async () => {
    await ensureDatabase(runtime)
    return load()
  })
}

async function saveCheckpoint(runtime: Context, checkpoint: JournalCheckpoint): Promise<boolean> {
  assertCursor(checkpoint.cursor)
  try {
    await runtime.exclusive.run(async () => ensureDatabase(runtime))
    const prepared = prepareCheckpoint(runtime, checkpoint)
    if (prepared === null) return false
    await runtime.phase("checkpoint-prepared", {
      cursor: checkpoint.cursor,
      snapshotCursor: prepared.snapshotCursor,
      compactedEvents: prepared.compactedEvents,
    })
    return await withMutableDatabase(runtime, (database) => {
      const current = readSnapshotHeader(database)
      const head = readHead(database)
      if (
        checkpoint.cursor > head ||
        checkpoint.cursor < current.cursor ||
        current.cursor !== prepared.snapshotCursor ||
        current.prefix_sha256 !== prepared.snapshotPrefixSha256 ||
        current.prefix_last_cursor !== prepared.snapshotPrefixLastCursor
      ) {
        runtime.log.warn?.("journal projection checkpoint refused: snapshot advanced under the prepared save", {
          action: "skipped",
          reason: "checkpoint-cas-stale",
          cursor: checkpoint.cursor,
          head,
          snapshotCursor: current.cursor,
          preparedSnapshotCursor: prepared.snapshotCursor,
        })
        return false
      }
      database.run("BEGIN IMMEDIATE")
      try {
        const updated = database
          .query(
            `UPDATE journal_snapshot
             SET cursor = ?, prefix_json = ?, prefix_sha256 = ?, prefix_last_cursor = ?,
                 checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ?
             WHERE singleton = 1 AND cursor = ? AND prefix_sha256 = ? AND prefix_last_cursor = ?`,
          )
          .run(
            checkpoint.cursor,
            prepared.prefixJson,
            prepared.prefixSha256,
            prepared.prefixLastCursor,
            checkpoint.identity,
            prepared.checkpointJson,
            prepared.checkpointSha256,
            prepared.snapshotCursor,
            prepared.snapshotPrefixSha256,
            prepared.snapshotPrefixLastCursor,
          )
        if (updated.changes !== 1) {
          rollback(database)
          runtime.log.warn?.("journal projection checkpoint refused: snapshot row CAS matched no rows", {
            action: "skipped",
            reason: "checkpoint-cas-miss",
            cursor: checkpoint.cursor,
          })
          return false
        }
        database.query("DELETE FROM journal_events WHERE cursor <= ?").run(checkpoint.cursor)
        database.run("COMMIT")
      } catch (error) {
        rollback(database)
        throw error
      }
      runtime.log.debug?.("journal projection checkpoint written", {
        action: "checkpoint-written",
        path: runtime.path,
        cursor: checkpoint.cursor,
        compactedEvents: prepared.compactedEvents,
      })
      return true
    })
  } catch (error) {
    runtime.log.error?.("journal projection checkpoint write failed; journal remains authoritative", {
      action: "skipped",
      reason: "checkpoint-write-failed",
      path: runtime.path,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

function prepareCheckpoint(runtime: Context, checkpoint: JournalCheckpoint): PreparedCheckpoint | null {
  using database = openReadOnly(runtime.path)
  database.run("BEGIN")
  try {
    const { head, snapshot } = assertComplete(database, runtime.path)
    if (checkpoint.cursor > head || checkpoint.cursor < snapshot.cursor) {
      database.run("COMMIT")
      runtime.log.warn?.("journal projection checkpoint refused: cursor outside snapshot..head", {
        action: "skipped",
        reason: "checkpoint-cursor-out-of-range",
        cursor: checkpoint.cursor,
        head,
        snapshotCursor: snapshot.cursor,
      })
      return null
    }
    if (checkpoint.cursor !== snapshot.cursor) {
      const committed = database
        .query<{ committed: number }, [number, number]>(
          `SELECT EXISTS(SELECT 1 FROM journal_events WHERE cursor = ?)
                OR EXISTS(SELECT 1 FROM journal_orphans WHERE cursor = ?) AS committed`,
        )
        .get(checkpoint.cursor, checkpoint.cursor)
      if (committed?.committed !== 1) {
        database.run("COMMIT")
        runtime.log.warn?.("journal projection checkpoint refused: no committed row at cursor", {
          action: "skipped",
          reason: "checkpoint-cursor-uncommitted",
          cursor: checkpoint.cursor,
        })
        return null
      }
    }
    const prefix = readVerifiedPrefix(database, snapshot)
    const covered = database
      .query<StoredEvent, [number, number]>(
        "SELECT cursor, value_json, sha256 FROM journal_events WHERE cursor > ? AND cursor <= ? ORDER BY cursor",
      )
      .all(snapshot.cursor, checkpoint.cursor)
      .map(decodeStoredEvent)
    database.run("COMMIT")
    const prefixJson = JSON.stringify([...prefix, ...covered])
    const prefixLastCursor = covered.at(-1)?.cursor ?? snapshot.prefix_last_cursor
    const checkpointJson = JSON.stringify(checkpoint)
    return {
      snapshotCursor: snapshot.cursor,
      snapshotPrefixSha256: snapshot.prefix_sha256,
      snapshotPrefixLastCursor: snapshot.prefix_last_cursor,
      prefixJson,
      prefixSha256: sha256(Buffer.from(prefixJson)),
      prefixLastCursor,
      checkpointJson,
      checkpointSha256: sha256(Buffer.from(checkpointJson)),
      compactedEvents: covered.length,
    }
  } catch (error) {
    rollback(database)
    throw error
  }
}

async function readBatches(
  runtime: Context,
  after: number,
  before: number | undefined,
): Promise<readonly Readonly<{ cursor: number; values: readonly unknown[] }>[]> {
  if (!(await exists(runtime.path))) {
    const legacy =
      (await exists(join(runtime.dir, LEGACY_MANIFEST_FILE))) || (await exists(join(runtime.dir, LEGACY_V3_FILE)))
    if (legacy) throw new Error("yrd: journal SQLite migration is required before read-only access")
    if (after !== 0 || (before !== undefined && before !== 0)) {
      throw new RangeError(`yrd: journal range ${after}..${before ?? 0} is outside 0..0`)
    }
    return []
  }

  using database = openReadOnly(runtime.path)
  return readTransaction(database, () => {
    const { head, snapshot } = assertComplete(database, runtime.path)
    const end = before ?? head
    validateRange(after, end, head)
    if (after === end) return []

    const batches: Array<Readonly<{ cursor: number; values: readonly unknown[] }>> = []
    let served = after
    if (after < snapshot.cursor) {
      const coveredEnd = Math.min(end, snapshot.cursor)
      const entries = readVerifiedPrefix(database, snapshot).filter(
        (entry) => entry.cursor > after && entry.cursor <= coveredEnd,
      )
      const markers = database
        .query<StoredMarker, [number, number]>(
          "SELECT cursor FROM journal_orphans WHERE cursor > ? AND cursor <= ? ORDER BY cursor",
        )
        .all(after, coveredEnd)
      const lastCursor =
        coveredEnd === snapshot.cursor
          ? snapshot.cursor
          : Math.max(entries.at(-1)?.cursor ?? after, markers.at(-1)?.cursor ?? after)
      if (lastCursor > served) {
        batches.push({ cursor: lastCursor, values: entries.map((entry) => entry.value) })
        served = lastCursor
      }
    }

    if (served < end) {
      const events = database
        .query<StoredEvent, [number, number]>(
          "SELECT cursor, value_json, sha256 FROM journal_events WHERE cursor > ? AND cursor <= ? ORDER BY cursor",
        )
        .all(served, end)
      const markers = database
        .query<StoredMarker, [number, number]>(
          "SELECT cursor FROM journal_orphans WHERE cursor > ? AND cursor <= ? ORDER BY cursor",
        )
        .all(served, end)
      const values = events.map(decodeStoredEvent).map((entry) => entry.value)
      const lastCursor = Math.max(events.at(-1)?.cursor ?? served, markers.at(-1)?.cursor ?? served)
      if (lastCursor < end && end === head) {
        throw new Error(`yrd: journal head ${head} has no committed cursor marker`)
      }
      if (lastCursor > served) batches.push({ cursor: lastCursor, values })
    }
    return batches
  })
}

function openReadOnly(path: string): Database {
  return new Database(path, { readonly: true, strict: true })
}

async function withMutableDatabase<Result>(
  runtime: Context,
  operation: (database: Database) => Result,
): Promise<Result> {
  assertMutablePlatform(runtime)
  return runtime.exclusive.run(async () => {
    await ensureDatabase(runtime)
    const database = openMutable(runtime)
    try {
      return operation(database)
    } finally {
      checkpointWal(runtime, database)
      database.close()
    }
  })
}

function openMutable(runtime: Context): Database {
  const database = new Database(runtime.path, { create: false, readwrite: true, strict: true })
  try {
    const observed = sqliteVersion(database)
    assertSafeWalVersion(runtime.sqliteVersion ?? observed)
    database.run("PRAGMA synchronous = FULL")
    database.run("PRAGMA wal_autocheckpoint = 0")
    database.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1)
    const row = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()
    if (row?.journal_mode.toLowerCase() !== "wal") throw new Error("yrd: SQLite refused WAL journal mode")
    assertComplete(database, runtime.path)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

async function ensureDatabase(runtime: Context): Promise<void> {
  assertMutablePlatform(runtime)
  if (await exists(runtime.path)) {
    using database = openReadOnly(runtime.path)
    assertComplete(database, runtime.path)
    await finalizeExistingSqliteCutover(runtime, database)
    return
  }
  await mkdir(runtime.dir, { recursive: true })
  using versionDatabase = new Database(":memory:", { strict: true })
  assertSafeWalVersion(runtime.sqliteVersion ?? sqliteVersion(versionDatabase))
  if (await recoverInterruptedSqliteCutover(runtime)) return
  const legacy = await readLegacySource(runtime)
  await publishCandidate(runtime, legacy)
}

function assertMutablePlatform(runtime: Context): void {
  if (runtime.platform === "win32") {
    throw new Error("yrd: journal SQLite mutation refused: unsupported platform win32")
  }
}

async function publishCandidate(runtime: Context, legacy: LegacySource | null): Promise<void> {
  const candidate = join(runtime.dir, `.journal.sqlite-${randomUUID()}`)
  const rows = legacy?.rows ?? []
  const head = legacy?.head ?? 0
  const fingerprint = legacy?.fingerprint ?? "fresh"
  let published = false
  let preserveCandidate = false
  let retirement: Readonly<{ legacy: LegacySource; backup: string }> | undefined
  try {
    using database = new Database(candidate, { create: true, readwrite: true, strict: true })
    database.run("PRAGMA journal_mode = DELETE")
    database.run("PRAGMA synchronous = FULL")
    createSchema(database, head, fingerprint)
    database.run("BEGIN IMMEDIATE")
    try {
      const insertEvent = database.query("INSERT INTO journal_events(cursor, value_json, sha256) VALUES (?, ?, ?)")
      const insertOrphan = database.query(
        "INSERT INTO journal_orphans(origin_row, cursor, record_json, sha256, source_sha256) VALUES (?, ?, ?, ?, ?)",
      )
      for (const row of rows) {
        if (row.kind === "live") {
          const valueJson = JSON.stringify(row.value)
          insertEvent.run(row.cursor, valueJson, digestText(valueJson))
          continue
        }
        const recordJson = JSON.stringify(row.value)
        insertOrphan.run(
          row.value.provenance["origin-row"],
          row.cursor,
          recordJson,
          digestText(recordJson),
          row.value.provenance["source-sha256"] ?? "legacy-v4",
        )
      }
      writeMetadata(database, "migration_complete", "1")
      database.run("COMMIT")
    } catch (error) {
      rollback(database)
      throw error
    }
    const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`yrd: SQLite candidate integrity failed: ${integrity?.integrity_check}`)
    }
    database.close()

    await verifyCandidateFresh(runtime, candidate, rows, head, fingerprint)
    await runtime.phase("migration-candidate-verified", { candidate, rows: rows.length, head })
    if (legacy !== null) retirement = { legacy, backup: await preserveLegacyCopy(runtime, legacy) }
    await syncFile(candidate)
    await syncDirectory(runtime.dir)
    await runtime.phase("migration-before-publish", { candidate, path: runtime.path })
    if (retirement !== undefined) {
      await writeSqliteCutover(runtime, retirement.legacy, retirement.backup, basename(candidate), "pre-publish")
      await runtime.phase("migration-after-retire", { candidate, path: runtime.path })
    }
    await rename(candidate, runtime.path)
    published = true
    await syncDirectory(runtime.dir)
    await runtime.phase("migration-after-sqlite-rename", { path: runtime.path })
    if (retirement !== undefined) {
      await writeSqliteCutover(runtime, retirement.legacy, retirement.backup, basename(candidate), "published")
    }
    await runtime.phase("migration-after-publish", { path: runtime.path })

    const live = openMutable(runtime)
    try {
      checkpointWal(runtime, live)
    } finally {
      live.close()
    }
    runtime.log.info?.("journal SQLite authority published", {
      action: legacy === null ? "initialized" : "migrated",
      path: runtime.path,
      cursor: head,
      frames: rows.filter((row) => row.kind === "live").length,
      sourceFingerprint: fingerprint,
    })
  } catch (error) {
    if (!published && retirement !== undefined) {
      try {
        await restoreLegacyPointer(runtime, retirement.legacy.pointer, retirement.backup)
      } catch (restoreError) {
        preserveCandidate = true
        throw new AggregateError(
          [error, restoreError],
          "yrd: SQLite publication failed and legacy-pointer rollback failed; preserving the verified candidate",
        )
      }
    }
    throw error
  } finally {
    if (!published && !preserveCandidate) await rm(candidate, { force: true })
    await rm(`${candidate}-journal`, { force: true })
    await rm(`${candidate}-wal`, { force: true })
    await rm(`${candidate}-shm`, { force: true })
  }
}

function createSchema(database: Database, head: number, fingerprint: string): void {
  database.run(`
    CREATE TABLE journal_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE journal_events (
      cursor INTEGER PRIMARY KEY NOT NULL CHECK (cursor > 0),
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64)
    ) STRICT;
    CREATE TABLE journal_snapshot (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      cursor INTEGER NOT NULL CHECK (cursor >= 0),
      prefix_json TEXT NOT NULL CHECK (json_valid(prefix_json)),
      prefix_sha256 TEXT NOT NULL CHECK (length(prefix_sha256) = 64),
      prefix_last_cursor INTEGER NOT NULL CHECK (prefix_last_cursor >= 0 AND prefix_last_cursor <= cursor),
      checkpoint_identity TEXT,
      checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
      checkpoint_sha256 TEXT CHECK (checkpoint_sha256 IS NULL OR length(checkpoint_sha256) = 64),
      CHECK ((checkpoint_identity IS NULL) = (checkpoint_json IS NULL)),
      CHECK ((checkpoint_json IS NULL) = (checkpoint_sha256 IS NULL))
    ) STRICT;
    CREATE TABLE journal_orphans (
      origin_row TEXT PRIMARY KEY NOT NULL,
      cursor INTEGER UNIQUE NOT NULL CHECK (cursor > 0),
      record_json TEXT NOT NULL CHECK (json_valid(record_json)),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      source_sha256 TEXT NOT NULL CHECK (length(source_sha256) > 0)
    ) STRICT;
    PRAGMA user_version = ${SCHEMA_VERSION};
  `)
  const empty: readonly PrefixEntry[] = []
  const emptyJson = JSON.stringify(empty)
  database
    .query(
      `INSERT INTO journal_snapshot(
         singleton, cursor, prefix_json, prefix_sha256, prefix_last_cursor,
         checkpoint_identity, checkpoint_json, checkpoint_sha256
       ) VALUES (1, 0, ?, ?, 0, NULL, NULL, NULL)`,
    )
    .run(emptyJson, sha256(Buffer.from(emptyJson)))
  writeMetadata(database, "schema_version", String(SCHEMA_VERSION))
  writeMetadata(database, "head_cursor", String(head))
  writeMetadata(database, "source_fingerprint", fingerprint)
  writeMetadata(database, "migration_complete", "0")
}

function assertComplete(database: Database, path: string): Readonly<{ head: number; snapshot: SnapshotHeader }> {
  const userVersion = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
  if (userVersion !== SCHEMA_VERSION) {
    throw new Error(`yrd: unsupported or incomplete SQLite journal schema at ${path} (v${userVersion ?? "missing"})`)
  }
  if (readMetadata(database, "migration_complete") !== "1") {
    throw new Error(`yrd: incomplete SQLite journal migration at ${path}`)
  }
  const head = readHead(database)
  const snapshot = readSnapshotHeader(database)
  assertCursor(snapshot.cursor)
  assertCursor(snapshot.prefix_last_cursor)
  if (snapshot.prefix_last_cursor > snapshot.cursor) {
    throw new Error("yrd: SQLite journal snapshot prefix boundary is invalid")
  }
  if (snapshot.checkpoint_json_present !== 0 && snapshot.checkpoint_json_present !== 1) {
    throw new Error("yrd: SQLite journal checkpoint presence is invalid")
  }
  const checkpointColumns = [
    snapshot.checkpoint_identity !== null,
    snapshot.checkpoint_json_present === 1,
    snapshot.checkpoint_sha256 !== null,
  ].filter(Boolean).length
  if (checkpointColumns !== 0 && checkpointColumns !== 3) {
    throw new Error("yrd: SQLite journal checkpoint columns are not all-or-none")
  }
  const hiddenEvent = database
    .query<{ cursor: number }, [number]>("SELECT cursor FROM journal_events WHERE cursor <= ? ORDER BY cursor LIMIT 1")
    .get(snapshot.cursor)
  if (hiddenEvent !== null) {
    throw new Error(
      `yrd: SQLite journal event cursor ${hiddenEvent.cursor} is hidden at or below snapshot ${snapshot.cursor}`,
    )
  }
  const tableOverlap = database
    .query<{ cursor: number }, []>(
      `SELECT orphan.cursor FROM journal_orphans orphan
       WHERE EXISTS(SELECT 1 FROM journal_events event WHERE event.cursor = orphan.cursor)
       LIMIT 1`,
    )
    .get()
  if (tableOverlap !== null) {
    throw new Error(`yrd: SQLite journal cursor ${tableOverlap.cursor} overlaps live and orphan tables`)
  }
  const snapshotOrphan =
    snapshot.cursor > 0 &&
    database
      .query<{ committed: number }, [number]>(
        "SELECT EXISTS(SELECT 1 FROM journal_orphans WHERE cursor = ?) AS committed",
      )
      .get(snapshot.cursor)?.committed === 1
  if (snapshot.cursor > 0 && snapshot.prefix_last_cursor !== snapshot.cursor && !snapshotOrphan) {
    throw new Error(`yrd: SQLite journal snapshot cursor ${snapshot.cursor} has no committed boundary`)
  }
  const eventMax =
    database.query<{ cursor: number | null }, []>("SELECT MAX(cursor) AS cursor FROM journal_events").get()?.cursor ?? 0
  const orphanMax =
    database.query<{ cursor: number | null }, []>("SELECT MAX(cursor) AS cursor FROM journal_orphans").get()?.cursor ??
    0
  const committedHead = Math.max(snapshot.cursor, eventMax, orphanMax)
  if (snapshot.cursor > head || head !== committedHead) {
    throw new Error(
      `yrd: SQLite journal head/cursor binding is invalid at ${path} (head=${head}, snapshot=${snapshot.cursor}, events=${eventMax}, orphans=${orphanMax})`,
    )
  }
  return { head, snapshot }
}

function readHead(database: Database): number {
  const value = Number(readMetadata(database, "head_cursor"))
  assertCursor(value)
  return value
}

function readMetadata(database: Database, key: string): string {
  const row = database.query<{ value: string }, [string]>("SELECT value FROM journal_metadata WHERE key = ?").get(key)
  if (row === null) throw new Error(`yrd: SQLite journal metadata '${key}' is missing`)
  return row.value
}

function writeMetadata(database: Database, key: string, value: string): void {
  database
    .query("INSERT INTO journal_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, value)
}

function readSnapshotHeader(database: Database): SnapshotHeader {
  const row = database
    .query<SnapshotHeader, []>(
      `SELECT cursor, prefix_sha256, prefix_last_cursor,
              checkpoint_identity,
              checkpoint_json IS NOT NULL AS checkpoint_json_present,
              checkpoint_sha256
       FROM journal_snapshot WHERE singleton = 1`,
    )
    .get()
  if (row === null) throw new Error("yrd: SQLite journal snapshot row is missing")
  return row
}

function readCheckpointJson(database: Database): string | null {
  const row = database
    .query<{ checkpoint_json: string | null }, []>("SELECT checkpoint_json FROM journal_snapshot WHERE singleton = 1")
    .get()
  if (row === null) throw new Error("yrd: SQLite journal snapshot row is missing")
  return row.checkpoint_json
}

function readSnapshotPrefix(database: Database): SnapshotPrefix {
  const row = database
    .query<SnapshotPrefix, []>(
      `SELECT cursor, prefix_json, prefix_sha256, prefix_last_cursor
       FROM journal_snapshot WHERE singleton = 1`,
    )
    .get()
  if (row === null) throw new Error("yrd: SQLite journal snapshot row is missing")
  return row
}

function readVerifiedPrefix(database: Database, header: SnapshotHeader): readonly PrefixEntry[] {
  const snapshot = readSnapshotPrefix(database)
  if (
    snapshot.cursor !== header.cursor ||
    snapshot.prefix_sha256 !== header.prefix_sha256 ||
    snapshot.prefix_last_cursor !== header.prefix_last_cursor
  ) {
    throw new Error("yrd: SQLite journal snapshot changed during its read transaction")
  }
  const prefix = parsePrefix(snapshot)
  const orphanPrefixCursors = new Set(
    database
      .query<{ cursor: number }, [number]>("SELECT cursor FROM journal_orphans WHERE cursor <= ?")
      .all(snapshot.cursor)
      .map(({ cursor }) => cursor),
  )
  const overlap = prefix.find(({ cursor }) => orphanPrefixCursors.has(cursor))
  if (overlap !== undefined) {
    throw new Error(`yrd: SQLite journal cursor ${overlap.cursor} overlaps snapshot prefix and orphan table`)
  }
  return prefix
}

function parsePrefix(snapshot: SnapshotPrefix): readonly PrefixEntry[] {
  if (digestText(snapshot.prefix_json) !== snapshot.prefix_sha256) {
    throw new Error("yrd: SQLite journal snapshot prefix checksum mismatch")
  }
  const parsed = JSON.parse(snapshot.prefix_json) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error("yrd: SQLite journal snapshot prefix checksum mismatch")
  }
  let previous = 0
  const entries = parsed.map((value): PrefixEntry => {
    if (typeof value !== "object" || value === null || !("cursor" in value) || !("value" in value)) {
      throw new Error("yrd: SQLite journal snapshot prefix is invalid")
    }
    const cursor = (value as { cursor: unknown }).cursor
    assertCursor(cursor as number)
    if ((cursor as number) <= previous || (cursor as number) > snapshot.cursor) {
      throw new Error("yrd: SQLite journal snapshot prefix cursors are invalid")
    }
    previous = cursor as number
    return { cursor: cursor as number, value: parseJournalFrame((value as { value: unknown }).value) }
  })
  if ((entries.at(-1)?.cursor ?? 0) !== snapshot.prefix_last_cursor) {
    throw new Error("yrd: SQLite journal snapshot prefix boundary is invalid")
  }
  return entries
}

function decodeStoredEvent(row: StoredEvent): PrefixEntry {
  if (digestText(row.value_json) !== row.sha256) {
    throw new Error(`yrd: SQLite journal event checksum mismatch at cursor ${row.cursor}`)
  }
  return { cursor: row.cursor, value: parseJournalFrame(JSON.parse(row.value_json)) }
}

function readTransaction<Result>(database: Database, operation: () => Result): Result {
  database.run("BEGIN")
  try {
    const result = operation()
    database.run("COMMIT")
    return result
  } catch (error) {
    rollback(database)
    throw error
  }
}

function checkpointWal(runtime: Context, database: Database): void {
  try {
    const result = database
      .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(PASSIVE)")
      .get()
    if (result === null) throw new Error("SQLite returned no WAL checkpoint result")
    const details = {
      path: runtime.path,
      busy: result.busy,
      logFrames: result.log,
      checkpointedFrames: result.checkpointed,
    }
    if (result.busy > 0 || result.checkpointed < result.log) {
      runtime.log.warn?.("journal WAL checkpoint deferred by a pinned reader", {
        action: "deferred",
        reason: "wal-checkpoint-pinned",
        ...details,
      })
    } else {
      const truncated = database
        .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
        .get()
      if (truncated === null) throw new Error("SQLite returned no WAL truncation result")
      if (truncated.busy > 0 || truncated.log !== 0 || truncated.checkpointed !== 0) {
        runtime.log.warn?.("journal WAL truncation deferred by a pinned reader", {
          action: "deferred",
          reason: "wal-truncate-pinned",
          path: runtime.path,
          busy: truncated.busy,
          logFrames: truncated.log,
          checkpointedFrames: truncated.checkpointed,
        })
      } else {
        runtime.log.debug?.("journal WAL checkpoint completed", { action: "checkpointed", ...details })
      }
    }
  } catch (error) {
    // A reader may pin the WAL. The acknowledged transaction remains durable;
    // a later writer close retries the maintenance checkpoint under the lock.
    runtime.log.warn?.("journal WAL checkpoint deferred after a maintenance failure", {
      action: "deferred",
      reason: "wal-checkpoint-failed",
      path: runtime.path,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function rollback(database: Database): void {
  try {
    database.run("ROLLBACK")
  } catch {
    // Preserve the original transaction failure.
  }
}

function sqliteVersion(database: Database): string {
  const row = database.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()
  if (row === null) throw new Error("yrd: SQLite runtime did not report its version")
  return row.version
}

export function assertSafeWalVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\D.*)?$/u.exec(version)
  if (match === null) throw new Error(`yrd: unsupported SQLite version '${version}'`)
  const [, majorText, minorText, patchText] = match
  const major = Number(majorText)
  const minor = Number(minorText)
  const patch = Number(patchText)
  const fixed =
    major > 3 ||
    (major === 3 && minor > 51) ||
    (major === 3 && minor === 51 && patch >= 3) ||
    (major === 3 && minor === 50 && patch >= 7) ||
    (major === 3 && minor === 44 && patch >= 6)
  if (!fixed) {
    throw new Error(`yrd: SQLite ${version} is unsafe for WAL; use >=3.51.3 or a fixed 3.50.7/3.44.6 backport`)
  }
}

async function readLegacySource(runtime: Context): Promise<LegacySource | null> {
  const manifestPath = join(runtime.dir, LEGACY_MANIFEST_FILE)
  if (await exists(manifestPath)) return readLegacyV4(runtime, manifestPath)
  const v3Path = join(runtime.dir, LEGACY_V3_FILE)
  if (!(await exists(v3Path))) return null
  const source = await readFile(v3Path)
  if (source.equals(Buffer.from(LEGACY_CUTOVER))) {
    throw new Error("yrd: legacy cutover points to a missing v4 manifest")
  }
  const committedEnd = source.lastIndexOf(10) + 1
  const raw = source.subarray(0, committedEnd)
  if (committedEnd !== source.length) {
    runtime.log.warn?.("journal discarded an unacknowledged partial v3 tail before migration", {
      action: "recovered",
      reason: "uncommitted-v3-tail",
      path: v3Path,
      committedBytes: committedEnd,
      discardedBytes: source.length - committedEnd,
    })
  }
  const rows = decodeLegacyBytes(raw, 0, v3Path)
  return {
    fingerprint: sha256(source),
    head: raw.length,
    rows,
    paths: [LEGACY_V3_FILE],
    pointer: LEGACY_V3_FILE,
  }
}

async function recoverInterruptedSqliteCutover(runtime: Context): Promise<boolean> {
  for (const pointer of [LEGACY_MANIFEST_FILE, LEGACY_V3_FILE] as const) {
    const path = join(runtime.dir, pointer)
    if (!(await exists(path))) continue
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(path, "utf8"))
    } catch {
      continue
    }
    if (!isRecord(raw) || raw.cutover !== DATABASE_FILE) continue
    const marker = legacySqliteCutover(parseSignedJson(await readFile(path), path))
    assertSqliteCutoverBinding(marker, pointer, path)
    if (marker.state === "published") {
      throw new Error(
        `yrd: published SQLite journal authority is missing at ${runtime.path}; refusing legacy resurrection`,
      )
    }
    const candidate = join(runtime.dir, marker.candidate)
    if (!(await exists(candidate))) {
      throw new Error(
        `yrd: interrupted SQLite cutover candidate is missing at ${candidate}; refusing legacy resurrection`,
      )
    }
    using database = openReadOnly(candidate)
    const { snapshot } = assertComplete(database, candidate)
    readVerifiedPrefix(database, snapshot)
    if (readMetadata(database, "source_fingerprint") !== marker.fingerprint) {
      throw new Error(`yrd: interrupted SQLite cutover candidate fingerprint mismatch at ${candidate}`)
    }
    database.close()
    await rename(candidate, runtime.path)
    await syncDirectory(runtime.dir)
    await writeSqliteCutoverMarker(runtime, marker, "published")
    runtime.log.warn?.("journal completed an interrupted SQLite cutover from its verified candidate", {
      action: "recovered",
      reason: "sqlite-cutover-pre-publish",
      pointer: path,
      backup: join(runtime.dir, marker.backup),
    })
    return true
  }
  return false
}

function assertSqliteCutoverBinding(
  marker: LegacySqliteCutover,
  pointer: LegacySqliteCutover["pointer"],
  path: string,
): void {
  if (marker.pointer !== pointer) throw new Error(`yrd: SQLite cutover pointer mismatch at ${path}`)
  const expectedBackup = `journal-v4-pre-sqlite-${marker.fingerprint.slice(0, 16)}`
  if (marker.backup !== expectedBackup) throw new Error(`yrd: SQLite cutover backup binding mismatch at ${path}`)
}

function legacySqliteCutover(value: Record<string, unknown>): LegacySqliteCutover {
  if (
    !exactKeys(value, ["v", "cutover", "state", "backup", "fingerprint", "pointer", "candidate", "digest"]) ||
    value.v !== SQLITE_CUTOVER_VERSION ||
    value.cutover !== DATABASE_FILE ||
    (value.state !== "pre-publish" && value.state !== "published") ||
    typeof value.backup !== "string" ||
    !/^journal-v4-pre-sqlite-[0-9a-f]{16}$/u.test(value.backup) ||
    !legacySha256(value.fingerprint) ||
    (value.pointer !== LEGACY_MANIFEST_FILE && value.pointer !== LEGACY_V3_FILE) ||
    typeof value.candidate !== "string" ||
    !LEGACY_CANDIDATE_PATH.test(value.candidate) ||
    !legacySha256(value.digest)
  ) {
    throw new Error("yrd: invalid legacy SQLite cutover marker")
  }
  return value as LegacySqliteCutover
}

async function readLegacyV4(runtime: Context, manifestPath: string): Promise<LegacySource> {
  const recoveryPath = join(runtime.dir, LEGACY_RECOVERY_FILE)
  if (await exists(recoveryPath)) {
    legacyRecovery(parseSignedJson(await readFile(recoveryPath), recoveryPath))
    throw new Error(`yrd: pending legacy v4 recovery must be resolved before SQLite migration (${recoveryPath})`)
  }
  const manifestBytes = await readFile(manifestPath)
  const manifest = legacyManifest(parseSignedJson(manifestBytes, manifestPath))

  const rows: LegacyRow[] = []
  const paths = new Set<string>([LEGACY_MANIFEST_FILE])
  let logicalEnd = 0
  let frames = 0
  for (const segment of manifest.segments) {
    if (segment.logicalStart !== logicalEnd || segment.logicalEnd !== logicalEnd + segment.rawBytes) {
      throw new Error("yrd: legacy v4 manifest ranges or frame counts are inconsistent")
    }
    const compressed = await readFile(join(runtime.dir, segment.path))
    if (sha256(compressed) !== segment.compressedSha256) throw new Error("yrd: legacy segment checksum mismatch")
    const raw = gunzipSync(compressed)
    if (sha256(raw) !== segment.rawSha256 || raw.length !== segment.rawBytes) {
      throw new Error("yrd: legacy segment raw checksum mismatch")
    }
    const decoded = decodeLegacyBytes(raw, segment.logicalStart, segment.path)
    if (decoded.length !== segment.frames) {
      throw new Error("yrd: legacy v4 manifest ranges or frame counts are inconsistent")
    }
    rows.push(...decoded)
    logicalEnd = segment.logicalEnd
    frames += decoded.length
    paths.add(segment.path)
  }
  if (
    manifest.logicalStart !== 0 ||
    manifest.logicalEnd !== logicalEnd ||
    manifest.frames !== frames ||
    manifest.tail.logicalStart !== logicalEnd ||
    manifest.tail.initialSha256 !== sha256(Buffer.alloc(0))
  ) {
    throw new Error("yrd: legacy v4 manifest ranges or frame counts are inconsistent")
  }

  const tail = manifest.tail
  const statePath = manifest.tailState.path
  const stateBytes = await readFile(join(runtime.dir, statePath))
  const state = legacyTailState(parseSignedJson(stateBytes, statePath))
  if (
    state.generation !== manifest.generation ||
    state.tailIdentity !== tail.identity ||
    state.logicalEnd !== manifest.logicalEnd + state.committedBytes ||
    (state.frames === 0) !== (state.lastChecksum === null)
  ) {
    throw new Error("yrd: legacy v4 tail state does not match the manifest")
  }
  const tailBytes = await readFile(join(runtime.dir, tail.path))
  if (tailBytes.length < state.committedBytes) throw new Error("yrd: legacy v4 tail is shorter than committed state")
  const committedTail = tailBytes.subarray(0, state.committedBytes)
  const decodedTail = decodeLegacyBytes(committedTail, tail.logicalStart, tail.path)
  if (decodedTail.length !== state.frames || legacyLastChecksum(committedTail) !== state.lastChecksum) {
    throw new Error("yrd: legacy v4 tail state does not match committed records")
  }
  rows.push(...decodedTail)
  logicalEnd += state.committedBytes
  paths.add(tail.path)
  paths.add(statePath)
  const v3Path = join(runtime.dir, LEGACY_V3_FILE)
  if (await exists(v3Path)) {
    const v3 = await readFile(v3Path)
    if (!v3.equals(Buffer.from(LEGACY_CUTOVER))) {
      throw new Error(`yrd: legacy v3 lane beside v4 authority is not the cutover marker (${v3Path})`)
    }
    paths.add(LEGACY_V3_FILE)
  }

  const fingerprint = sha256(
    Buffer.concat(await Promise.all([...paths].toSorted().map((path) => readFile(join(runtime.dir, path))))),
  )
  return { fingerprint, head: logicalEnd, rows, paths: [...paths].toSorted(), pointer: LEGACY_MANIFEST_FILE }
}

function legacyManifest(value: Record<string, unknown>): LegacyManifest {
  if (
    !exactKeys(value, [
      "formatVersion",
      "generation",
      "sourceGeneration",
      "logicalStart",
      "logicalEnd",
      "frames",
      "segments",
      "tail",
      "tailState",
      "digest",
    ]) ||
    value.formatVersion !== 4 ||
    !legacyInteger(value.generation) ||
    !legacyInteger(value.sourceGeneration) ||
    value.logicalStart !== 0 ||
    !legacyInteger(value.logicalEnd) ||
    !legacyInteger(value.frames) ||
    !Array.isArray(value.segments) ||
    !isRecord(value.tail) ||
    !exactKeys(value.tail, ["path", "identity", "logicalStart", "initialSha256"]) ||
    !legacyPrivatePath(value.tail.path) ||
    typeof value.tail.identity !== "string" ||
    !UUID_PATTERN.test(value.tail.identity) ||
    !legacyInteger(value.tail.logicalStart) ||
    !legacySha256(value.tail.initialSha256) ||
    !isRecord(value.tailState) ||
    !exactKeys(value.tailState, ["path"]) ||
    !legacyPrivatePath(value.tailState.path)
  ) {
    throw new Error("yrd: invalid legacy v4 manifest")
  }
  const segments = value.segments.map(legacySegment)
  return { ...(value as Omit<LegacyManifest, "segments">), segments }
}

function legacySegment(value: unknown): LegacySegment {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "path",
      "codec",
      "codecVersion",
      "codecParameters",
      "rawSha256",
      "compressedSha256",
      "logicalStart",
      "logicalEnd",
      "rawBytes",
      "frames",
      "generationCreated",
      "sourceGeneration",
      "sourceTailIdentity",
    ]) ||
    !legacyPrivatePath(value.path) ||
    value.codec !== "gzip" ||
    typeof value.codecVersion !== "string" ||
    value.codecVersion === "" ||
    value.codecParameters !== "level=9;mtime=0" ||
    !legacySha256(value.rawSha256) ||
    !legacySha256(value.compressedSha256) ||
    !legacyInteger(value.logicalStart) ||
    !legacyInteger(value.logicalEnd) ||
    !legacyInteger(value.rawBytes) ||
    !legacyInteger(value.frames) ||
    !legacyInteger(value.generationCreated) ||
    !legacyInteger(value.sourceGeneration) ||
    typeof value.sourceTailIdentity !== "string" ||
    value.sourceTailIdentity === ""
  ) {
    throw new Error("yrd: invalid legacy v4 segment metadata")
  }
  return value as LegacySegment
}

function legacyTailState(value: Record<string, unknown>): LegacyTailState {
  if (
    !exactKeys(value, [
      "formatVersion",
      "generation",
      "tailIdentity",
      "committedBytes",
      "logicalEnd",
      "frames",
      "lastChecksum",
      "digest",
    ]) ||
    value.formatVersion !== 4 ||
    !legacyInteger(value.generation) ||
    typeof value.tailIdentity !== "string" ||
    !UUID_PATTERN.test(value.tailIdentity) ||
    !legacyInteger(value.committedBytes) ||
    !legacyInteger(value.logicalEnd) ||
    !legacyInteger(value.frames) ||
    !(value.lastChecksum === null || legacySha256(value.lastChecksum))
  ) {
    throw new Error("yrd: invalid legacy v4 tail state")
  }
  return value as LegacyTailState
}

function legacyRecovery(value: Record<string, unknown>): void {
  const privatePaths = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) && candidate.every(legacyPrivatePath)
  const successPaths = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) && candidate.every((path) => path === LEGACY_V3_FILE || legacyPrivatePath(path))
  if (
    !exactKeys(value, [
      "formatVersion",
      "kind",
      "fromGeneration",
      "toGeneration",
      "previousManifest",
      "previousManifestDigest",
      "sourceV3Path",
      "rollbackPaths",
      "successPaths",
      "verifyStart",
      "verifyEnd",
      "verifyFrames",
      "verifyDigest",
      "digest",
    ]) ||
    value.formatVersion !== 4 ||
    (value.kind !== "initialize" && value.kind !== "migrate-v3" && value.kind !== "compact") ||
    !legacyInteger(value.fromGeneration) ||
    !legacyInteger(value.toGeneration) ||
    !(value.previousManifest === null || typeof value.previousManifest === "string") ||
    !(value.previousManifestDigest === null || legacySha256(value.previousManifestDigest)) ||
    (value.previousManifest === null) !== (value.previousManifestDigest === null) ||
    (value.previousManifest !== null && sha256(Buffer.from(value.previousManifest)) !== value.previousManifestDigest) ||
    !(value.sourceV3Path === null || value.sourceV3Path === LEGACY_V3_FILE) ||
    !privatePaths(value.rollbackPaths) ||
    !successPaths(value.successPaths) ||
    !legacyInteger(value.verifyStart) ||
    !legacyInteger(value.verifyEnd) ||
    !legacyInteger(value.verifyFrames) ||
    !legacySha256(value.verifyDigest) ||
    !legacySha256(value.digest)
  ) {
    throw new Error("yrd: invalid legacy v4 recovery metadata")
  }
}

function legacyLastChecksum(raw: Buffer): string | null {
  if (raw.length === 0) return null
  const previous = raw.lastIndexOf(10, raw.length - 2)
  const row = JSON.parse(raw.subarray(previous + 1, raw.length - 1).toString("utf8")) as Record<string, unknown>
  return legacySha256(row.checksum) ? row.checksum : null
}

function legacyInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function legacySha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value)
}

function legacyPrivatePath(value: unknown): value is string {
  return typeof value === "string" && LEGACY_PRIVATE_PATH.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && actual.every((key) => expected.includes(key))
}

function requiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const actual = Object.keys(value)
  return (
    required.every((key) => key in value) && actual.every((key) => required.includes(key) || optional.includes(key))
  )
}

function decodeLegacyFrame(value: unknown, path: string, cursor: number): ReturnType<typeof parseJournalFrame> {
  if (
    !isRecord(value) ||
    !requiredAndOptionalKeys(value, ["v", "cause", "command", "events", "checksum"], ["value"]) ||
    value.v !== 3 ||
    !legacySha256(value.checksum)
  ) {
    throw new Error(`yrd: invalid legacy journal frame at ${path}:${cursor}`)
  }
  const { checksum, v: _version, ...frame } = value
  if (checksum !== digest({ v: 3, ...frame })) {
    throw new Error(`yrd: legacy journal checksum mismatch at ${path}:${cursor}`)
  }
  return parseJournalFrame(frame)
}

function decodeLegacyBytes(raw: Buffer, logicalStart: number, path: string): LegacyRow[] {
  const rows: LegacyRow[] = []
  let start = 0
  while (start < raw.length) {
    const newline = raw.indexOf(10, start)
    if (newline < 0) throw new Error(`yrd: legacy journal corrupt at ${path}:${logicalStart + start}`)
    const bytes = raw.subarray(start, newline)
    const cursor = logicalStart + newline + 1
    let value: unknown
    try {
      value = JSON.parse(bytes.toString("utf8"))
    } catch (cause) {
      throw new Error(`yrd: invalid legacy journal JSON at ${path}:${logicalStart + start}`, { cause })
    }
    if (!isRecord(value) || !legacySha256(value.checksum)) {
      throw new Error(`yrd: invalid legacy journal record at ${path}:${logicalStart + start}`)
    }
    const { checksum, ...data } = value
    if (checksum !== digest(data)) throw new Error(`yrd: legacy journal checksum mismatch at ${path}:${cursor}`)
    if (data.kind === "archived-orphan") {
      if (!exactKeys(data, ["v", "kind", "provenance", "frame"]) || data.v !== 3) {
        throw new Error(`yrd: invalid legacy archived orphan at ${path}:${cursor}`)
      }
      const { v: _version, frame: storedFrame, ...record } = data
      const orphan: ArchivedOrphanRecord = {
        ...(record as Omit<ArchivedOrphanRecord, "frame">),
        frame: decodeLegacyFrame(storedFrame, path, cursor),
      }
      validateArchivedOrphan(orphan)
      rows.push({ kind: "orphan", cursor, value: orphan })
    } else {
      rows.push({ kind: "live", cursor, value: decodeLegacyFrame(value, path, cursor) })
    }
    start = newline + 1
  }
  return rows
}

function parseSignedJson(bytes: Buffer, path: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch (cause) {
    throw new Error(`yrd: invalid legacy metadata JSON at ${path}`, { cause })
  }
  if (typeof value !== "object" || value === null || !("digest" in value)) {
    throw new Error(`yrd: unsigned legacy metadata at ${path}`)
  }
  const { digest: observed, ...payload } = value as Record<string, unknown>
  if (observed !== digest(payload)) throw new Error(`yrd: legacy metadata checksum mismatch at ${path}`)
  return value as Record<string, unknown>
}

async function preserveLegacyCopy(runtime: Context, legacy: LegacySource): Promise<string> {
  const backupName = `journal-v4-pre-sqlite-${legacy.fingerprint.slice(0, 16)}`
  const backup = join(runtime.dir, backupName)
  if (await exists(backup)) {
    await verifyLegacyCopy(backup, legacy)
    return backupName
  }
  const candidate = `${backup}-${randomUUID()}`
  await mkdir(candidate)
  try {
    for (const path of legacy.paths) await copyFile(join(runtime.dir, path), join(candidate, basename(path)))
    await Promise.all(legacy.paths.map((path) => syncFile(join(candidate, basename(path)))))
    await syncDirectory(candidate)
    await rename(candidate, backup)
    await syncDirectory(runtime.dir)
  } catch (error) {
    await rm(candidate, { recursive: true, force: true })
    throw error
  }
  await verifyLegacyCopy(backup, legacy)
  return backupName
}

async function verifyLegacyCopy(backup: string, legacy: LegacySource): Promise<void> {
  const expected = legacy.paths.map((path) => basename(path)).toSorted()
  const actual = (await readdir(backup)).toSorted()
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error(`yrd: preserved legacy backup path set is incomplete at ${backup}`)
  }
  const fingerprint = sha256(Buffer.concat(await Promise.all(actual.map((path) => readFile(join(backup, path))))))
  if (fingerprint !== legacy.fingerprint) {
    throw new Error(`yrd: preserved legacy backup fingerprint mismatch at ${backup}`)
  }
}

async function writeSqliteCutover(
  runtime: Context,
  legacy: LegacySource,
  backup: string,
  candidate: string,
  state: LegacySqliteCutover["state"],
): Promise<void> {
  await writeSqliteCutoverMarker(
    runtime,
    {
      v: SQLITE_CUTOVER_VERSION,
      cutover: DATABASE_FILE,
      state,
      backup,
      fingerprint: legacy.fingerprint,
      pointer: legacy.pointer,
      candidate,
      digest: "",
    },
    state,
  )
}

async function writeSqliteCutoverMarker(
  runtime: Context,
  marker: LegacySqliteCutover,
  state: LegacySqliteCutover["state"],
): Promise<void> {
  const { digest: _oldDigest, ...oldPayload } = marker
  const payload = { ...oldPayload, state }
  const encoded = JSON.stringify({ ...payload, digest: digest(payload) })
  const target = join(runtime.dir, marker.pointer)
  const candidate = join(runtime.dir, `.legacy-cutover-${randomUUID()}`)
  await writeFile(candidate, encoded)
  try {
    await syncFile(candidate)
    await rename(candidate, target)
    await syncDirectory(runtime.dir)
  } catch (error) {
    await rm(candidate, { force: true })
    throw error
  }
}

async function restoreLegacyPointer(runtime: Context, pointer: LegacySource["pointer"], backup: string): Promise<void> {
  const preserved = join(runtime.dir, backup, pointer)
  if (!(await exists(preserved))) throw new Error(`yrd: SQLite cutover recovery source is missing at ${preserved}`)
  const candidate = join(runtime.dir, `.legacy-restore-${randomUUID()}`)
  await copyFile(preserved, candidate)
  try {
    await syncFile(candidate)
    await rename(candidate, join(runtime.dir, pointer))
    await syncDirectory(runtime.dir)
  } catch (error) {
    await rm(candidate, { force: true })
    throw error
  }
}

async function finalizeExistingSqliteCutover(runtime: Context, database: Database): Promise<void> {
  for (const pointer of [LEGACY_MANIFEST_FILE, LEGACY_V3_FILE] as const) {
    const path = join(runtime.dir, pointer)
    if (!(await exists(path))) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, "utf8"))
    } catch {
      continue
    }
    if (!isRecord(parsed) || parsed.cutover !== DATABASE_FILE) continue
    const marker = legacySqliteCutover(parseSignedJson(await readFile(path), path))
    assertSqliteCutoverBinding(marker, pointer, path)
    if (readMetadata(database, "source_fingerprint") !== marker.fingerprint) {
      throw new Error(`yrd: SQLite authority fingerprint does not match its cutover marker at ${path}`)
    }
    if (marker.state === "published") return
    await writeSqliteCutoverMarker(runtime, marker, "published")
    return
  }
}

async function verifyCandidateFresh(
  runtime: Context,
  path: string,
  expected: readonly LegacyRow[],
  head: number,
  fingerprint: string,
): Promise<void> {
  const verificationDir = join(runtime.dir, `.journal-verify-${randomUUID()}`)
  await mkdir(verificationDir)
  try {
    await copyFile(path, join(verificationDir, DATABASE_FILE))
    const live = expected.filter((row): row is Extract<LegacyRow, { kind: "live" }> => row.kind === "live")
    const orphans = expected.filter((row): row is Extract<LegacyRow, { kind: "orphan" }> => row.kind === "orphan")
    const expectedResult = {
      replay: head === 0 ? [] : [{ cursor: head, values: live.map((row) => row.value) }],
      orphans: { cursor: head, records: orphans.map((row) => row.value) },
      integrity: "ok",
      userVersion: SCHEMA_VERSION,
      migrationComplete: "1",
      sourceFingerprint: fingerprint,
    }
    const source = `
      import { Database } from "bun:sqlite"
      import { createReadOnlyJournal, readArchivedOrphans } from ${JSON.stringify(import.meta.url)}
      const dir = ${JSON.stringify(verificationDir)}
      const replay = await Array.fromAsync(createReadOnlyJournal({ dir }).read())
      const orphans = await readArchivedOrphans({ dir })
      using database = new Database(${JSON.stringify(join(verificationDir, DATABASE_FILE))}, { readonly: true, strict: true })
      const integrity = database.query("PRAGMA integrity_check").get()?.integrity_check
      const userVersion = database.query("PRAGMA user_version").get()?.user_version
      const metadata = Object.fromEntries(database.query("SELECT key, value FROM journal_metadata").all().map(({ key, value }) => [key, value]))
      process.stdout.write(JSON.stringify({
        replay,
        orphans,
        integrity,
        userVersion,
        migrationComplete: metadata.migration_complete,
        sourceFingerprint: metadata.source_fingerprint,
      }))
    `
    const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`yrd: fresh-process SQLite verification failed (${code}): ${stderr.trim()}`)
    let observed: unknown
    try {
      observed = JSON.parse(stdout)
    } catch (cause) {
      throw new Error("yrd: fresh-process SQLite verification returned invalid JSON", { cause })
    }
    if (digest(observed) !== digest(expectedResult)) {
      throw new Error("yrd: fresh-process SQLite replay equivalence mismatch")
    }
  } finally {
    await rm(verificationDir, { recursive: true, force: true })
  }
}

export async function readArchivedOrphans(options: Readonly<{ dir: string }>): Promise<ArchivedOrphanSnapshot> {
  const runtime = context({ dir: options.dir })
  if (!(await exists(runtime.path))) {
    const legacy =
      (await exists(join(runtime.dir, LEGACY_MANIFEST_FILE))) || (await exists(join(runtime.dir, LEGACY_V3_FILE)))
    if (legacy) throw new Error("yrd: journal SQLite migration is required before archived-orphan access")
    return { cursor: 0, records: [] }
  }
  using database = openReadOnly(runtime.path)
  return readTransaction(database, () => {
    const { head } = assertComplete(database, runtime.path)
    const rows = database
      .query<{ record_json: string; sha256: string }, []>(
        "SELECT record_json, sha256 FROM journal_orphans ORDER BY cursor",
      )
      .all()
    return {
      cursor: head,
      records: rows.map((row) => {
        if (digestText(row.record_json) !== row.sha256) throw new Error("yrd: archived orphan checksum mismatch")
        const record = JSON.parse(row.record_json) as ArchivedOrphanRecord
        validateArchivedOrphan(record)
        return record
      }),
    }
  })
}

export async function importOrphanJournal(
  options: Readonly<{
    dir: string
    sourcePath: string
    importedBy: string
    importedAt?: string
    log?: ConditionalLogger
  }>,
): Promise<OrphanJournalImportResult> {
  const internal = options as typeof options & Readonly<{ inject?: InternalInject }>
  const raw = await readFile(options.sourcePath)
  const sourceSha256 = sha256(raw)
  const importedAt = options.importedAt ?? new Date().toISOString()
  const sourceRows = decodeLegacyBytes(raw, 0, options.sourcePath)
  const records = sourceRows.map((row): ArchivedOrphanRecord => {
    if (row.kind !== "live") throw new Error("yrd: orphan source must contain live v3 frames")
    const frame = parseJournalFrame(row.value)
    return {
      kind: "archived-orphan",
      provenance: {
        "origin-lane": "v3-phantom",
        "origin-file": options.sourcePath,
        "origin-row": frame.command.id,
        "source-sha256": sourceSha256,
        "imported-at": importedAt,
        "imported-by": options.importedBy,
        "collision-policy": "refuse",
      },
      frame,
    }
  })
  if (records.length === 0) throw new Error("yrd: orphan journal source contains no records")
  assertDistinctOrphanSource(records)
  const runtime = context({
    dir: options.dir,
    inject: {
      ...internal.inject,
      ...(options.log !== undefined && { log: options.log }),
    },
  } as JournalOptions)

  return withMutableDatabase(runtime, (database) => {
    const head = readHead(database)
    const live = allLiveFrames(database)
    const collisions = liveCollisions(live, records)
    if (collisions.length > 0) {
      return { status: "live-collision" as const, cursor: head, records: records.length, sourceSha256, collisions }
    }

    const existing = new Map(
      database
        .query<{ origin_row: string; record_json: string }, []>(
          "SELECT origin_row, record_json FROM journal_orphans ORDER BY cursor",
        )
        .all()
        .map((row) => [row.origin_row, row.record_json] as const),
    )
    let found = 0
    for (const record of records) {
      const encoded = existing.get(record.provenance["origin-row"])
      if (encoded === undefined) continue
      const archived = JSON.parse(encoded) as unknown
      validateArchivedOrphan(archived)
      if (orphanImportIdentity(archived) !== orphanImportIdentity(record)) {
        throw new Error(`yrd: archived origin row '${record.provenance["origin-row"]}' has different payload`)
      }
      found += 1
    }
    if (found === records.length) {
      return { status: "already-imported" as const, cursor: head, records: records.length, sourceSha256 }
    }
    if (found > 0) throw new Error("yrd: orphan journal source was only partially archived")

    database.run("BEGIN IMMEDIATE")
    try {
      const insert = database.query(
        "INSERT INTO journal_orphans(origin_row, cursor, record_json, sha256, source_sha256) VALUES (?, ?, ?, ?, ?)",
      )
      let cursor = head
      for (const record of records) {
        cursor += 1
        const recordJson = JSON.stringify(record)
        insert.run(record.provenance["origin-row"], cursor, recordJson, digestText(recordJson), sourceSha256)
      }
      writeMetadata(database, "head_cursor", String(cursor))
      database.run("COMMIT")
      return { status: "imported" as const, cursor, records: records.length, sourceSha256 }
    } catch (error) {
      rollback(database)
      throw error
    }
  })
}

function allLiveFrames(database: Database): readonly unknown[] {
  const snapshot = readSnapshotHeader(database)
  return [
    ...readVerifiedPrefix(database, snapshot).map((entry) => entry.value),
    ...database
      .query<StoredEvent, []>("SELECT cursor, value_json, sha256 FROM journal_events ORDER BY cursor")
      .all()
      .map(decodeStoredEvent)
      .map((entry) => entry.value),
  ]
}

function liveCollisions(
  live: readonly unknown[],
  records: readonly ArchivedOrphanRecord[],
): readonly ArchivedOrphanCollision[] {
  const frames = live.map(parseJournalFrame)
  const liveIds = new Set(frames.flatMap((frame) => frameIdentities(frame).map(({ id }) => id)))
  const livePayloads = new Set(frames.map(payloadIdentity))
  const collisions: ArchivedOrphanCollision[] = []
  for (const record of records) {
    const orphan = parseJournalFrame(record.frame)
    collisions.push(...frameIdentities(orphan).filter(({ id }) => liveIds.has(id)))
    const payload = payloadIdentity(orphan)
    if (livePayloads.has(payload)) collisions.push({ kind: "payload", id: payload })
  }
  return [
    ...new Map(collisions.map((collision) => [`${collision.kind}:${collision.id}`, collision])).values(),
  ].toSorted((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
}

function frameIdentities(frame: ReturnType<typeof parseJournalFrame>): ArchivedOrphanCollision[] {
  return [
    { kind: "command", id: frame.command.id },
    { kind: "cause", id: frame.cause.id },
    ...frame.events.map((event) => ({ kind: "event" as const, id: event.id })),
  ]
}

function payloadIdentity(frame: ReturnType<typeof parseJournalFrame>): string {
  return digest({
    command: {
      op: frame.command.op,
      ...(frame.command.args === undefined ? {} : { args: frame.command.args }),
    },
    events: frame.events.map((event) => ({ name: event.name, data: event.data })),
    ...(frame.value === undefined ? {} : { value: frame.value }),
  })
}

function assertDistinctOrphanSource(records: readonly ArchivedOrphanRecord[]): void {
  const identities = new Set<string>()
  const payloads = new Set<string>()
  for (const record of records) {
    validateArchivedOrphan(record)
    const frame = parseJournalFrame(record.frame)
    for (const identity of frameIdentities(frame)) {
      if (identities.has(identity.id)) throw new Error(`yrd: duplicate identity '${identity.id}' in orphan source`)
      identities.add(identity.id)
    }
    const payload = payloadIdentity(frame)
    if (payloads.has(payload)) throw new Error(`yrd: duplicate payload '${payload}' in orphan source`)
    payloads.add(payload)
  }
}

function orphanImportIdentity(record: ArchivedOrphanRecord): string {
  return digest({
    "origin-row": record.provenance["origin-row"],
    "source-sha256": record.provenance["source-sha256"],
    frame: record.frame,
  })
}

function validateArchivedOrphan(record: unknown): asserts record is ArchivedOrphanRecord {
  if (
    !isRecord(record) ||
    !exactKeys(record, ["kind", "provenance", "frame"]) ||
    record.kind !== "archived-orphan" ||
    !isRecord(record.provenance) ||
    !requiredAndOptionalKeys(
      record.provenance,
      ["origin-lane", "origin-file", "origin-row", "imported-at", "imported-by", "collision-policy"],
      ["source-sha256"],
    ) ||
    record.provenance["origin-lane"] !== "v3-phantom" ||
    typeof record.provenance["origin-file"] !== "string" ||
    record.provenance["origin-file"].trim().length === 0 ||
    typeof record.provenance["origin-row"] !== "string" ||
    !UUID_V7_PATTERN.test(record.provenance["origin-row"]) ||
    (record.provenance["source-sha256"] !== undefined && !legacySha256(record.provenance["source-sha256"])) ||
    typeof record.provenance["imported-at"] !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(record.provenance["imported-at"]) ||
    !Number.isFinite(Date.parse(record.provenance["imported-at"])) ||
    typeof record.provenance["imported-by"] !== "string" ||
    record.provenance["imported-by"].trim().length === 0 ||
    record.provenance["collision-policy"] !== "refuse"
  ) {
    throw new Error("yrd: invalid archived orphan record")
  }
  const frame = parseJournalFrame(record.frame)
  if (record.provenance["origin-row"] !== frame.command.id) {
    throw new Error("yrd: archived orphan origin row does not match the source command")
  }
}

function digest(value: unknown): string {
  const encoded = canonicalize(value)
  if (encoded === undefined) throw new TypeError("yrd: journal value must be canonical JSON data")
  return createHash("sha256").update(encoded).digest("hex")
}

function digestText(value: string): string {
  return sha256(Buffer.from(value))
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function assertCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("yrd: journal cursor must be a non-negative safe integer")
  }
}

function validateRange(after: number, before: number, head: number): void {
  if (after > before || before > head) {
    throw new RangeError(`yrd: journal range ${after}..${before} is outside 0..${head}`)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, "r")
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
