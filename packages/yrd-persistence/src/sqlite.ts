import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { gunzipSync } from "node:zlib"
import { constants, Database } from "bun:sqlite"
import {
  JOURNAL_READER_VERSION,
  createFailure,
  journalFrameCompatibility,
  observeYrdLifecycle,
  parseJournalFrame,
  raiseFailure,
  type Journal,
  type JournalCheckpoint,
  type JournalEntityKind,
  type JournalHistory,
  type JournalHistoryDiagnostics,
  type JournalHistoryEntry,
  type JournalIdentityKind,
  type JournalFrame,
} from "@yrd/core"
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
const SCHEMA_VERSION = 2
const JOURNAL_VIEWS_GENERATION = "journal_views_generation"
const JOURNAL_VERSION_FLOOR = "journal_version_floor"
const HISTORY_EVICTED_THROUGH = "history_evicted_through"
/**
 * Sized against the live hh journal: ~1.9 KB per frame and ~3.2k frames a day,
 * so this window holds roughly six days and about 37 MB of history.
 *
 * The age window is off unless an operator sets it. It is the wrong default:
 * on a busy journal the frame cap always binds first, and on a quiet one age
 * eviction reclaims nothing while still shortening how far a reader can replay.
 */
const DEFAULT_KEEP_FRAMES = 20_000
const LEGACY_PRIVATE_PATH = /^events-v4\.[a-zA-Z0-9._-]+$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
const LEGACY_CANDIDATE_PATH = /^\.journal\.sqlite-[0-9a-f-]{36}$/iu

export type JournalViewEntry = Readonly<{
  cursor: number
  value: unknown
}>

/**
 * One rebuildable, SQLite-backed query view maintained by the Journal writer.
 *
 * The contributing package owns every domain table, index, and projection
 * rule. Persistence owns only registration and the transaction that invokes
 * `apply`, so a thrown projection rolls back the authoritative Frame too.
 */
export type JournalView = Readonly<{
  id: string
  version: number
  fingerprint: string
  install(database: Database): void
  reset(database: Database): void
  apply(database: Database, entry: JournalViewEntry): void
}>

export type JournalViewRebuildResult = Readonly<{
  cursor: number
  frames: number
  views: number
}>

export type MutableJournal = Journal<unknown> &
  Readonly<{
    views: Readonly<{
      rebuild(): Promise<JournalViewRebuildResult>
    }>
    administration: Readonly<{
      bump(version: number): Promise<JournalVersionBumpResult>
    }>
  }>

export type JournalVersionBumpResult = Readonly<{
  from: number
  to: number
  snapshot: string
  restoreDrill: "passed"
}>

/**
 * How much already-checkpointed history the journal keeps. A frame is evicted
 * when it falls outside EITHER window, so both are caps and growth is bounded
 * by whichever binds first. `"disabled"` keeps every frame forever.
 */
export type JournalRetention =
  | "disabled"
  | Readonly<{
      /** Newest frames always kept, counted back from the checkpoint boundary. */
      keepFrames?: number
      /** Opt-in second cap: frames older than this many days go even inside the frame window. */
      keepDays?: number
    }>

export type JournalOptions = Readonly<{
  dir: string
  /** Version written by this process. Fresh journals are born at this floor. */
  writerVersion?: number
  lock?: ExclusiveOptions
  views?: readonly JournalView[]
  /** Defaults to the `YRD_JOURNAL_KEEP_FRAMES` / `YRD_JOURNAL_KEEP_DAYS` env pair. */
  retention?: JournalRetention
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
  writerVersion: number
  exclusive: Exclusive
  log: ConditionalLogger
  platform: string
  sqliteVersion?: string
  views: readonly JournalView[]
  retention: ResolvedRetention
  phase(phase: string, details?: Readonly<Record<string, unknown>>): Promise<void>
}>

export type ResolvedRetention = Readonly<{ keepFrames: number; keepDays?: number }> | "disabled"

type EvictionOutcome = Readonly<{ frames: number; facts: number; evictedThrough: number; floor: number }>

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
  const log = inject.log?.child("storage") ?? createLogger("yrd:storage", [{ level: "warn" }])
  const views = validateViews(options.views ?? [])
  return {
    dir: options.dir,
    path: join(options.dir, DATABASE_FILE),
    writerVersion: journalWriterVersion(options.writerVersion),
    exclusive: inject.exclusive ?? createExclusive(options.dir, options.lock, { log }),
    log,
    platform: inject.platform ?? process.platform,
    ...(inject.sqliteVersion === undefined ? {} : { sqliteVersion: inject.sqliteVersion }),
    views,
    retention: resolveRetention(options.retention),
    async phase(name, details = {}) {
      await inject.phase?.(name, details)
    },
  }
}

/**
 * Exported for tests: the opt-in default is what lets this land ahead of the
 * floor-aware readers, and the window that would prove it through a journal is
 * larger than any fixture worth writing, so the contract is pinned here.
 */
export function resolveRetention(configured: JournalRetention | undefined): ResolvedRetention {
  if (configured === "disabled") return "disabled"
  // Opt-in until the cursor-0 readers are floor-aware: an unconfigured journal
  // evicts nothing, so landing this cannot break a reader that has not been
  // taught where history now begins.
  if (
    configured === undefined &&
    process.env.YRD_JOURNAL_KEEP_FRAMES === undefined &&
    process.env.YRD_JOURNAL_KEEP_DAYS === undefined
  ) {
    return "disabled"
  }
  const keepDays = retentionBound("keepDays", configured?.keepDays, "YRD_JOURNAL_KEEP_DAYS", undefined)
  return {
    keepFrames: retentionBound("keepFrames", configured?.keepFrames, "YRD_JOURNAL_KEEP_FRAMES", DEFAULT_KEEP_FRAMES),
    ...(keepDays === undefined ? {} : { keepDays }),
  }
}

function retentionBound<Fallback extends number | undefined>(
  field: string,
  configured: number | undefined,
  variable: string,
  fallback: Fallback,
): number | Fallback {
  if (configured !== undefined) {
    if (!Number.isSafeInteger(configured) || configured < 1) {
      throw new RangeError(`yrd: journal retention ${field} must be a positive safe integer, not ${String(configured)}`)
    }
    return configured
  }
  const raw = process.env[variable]?.trim()
  if (raw === undefined || raw === "") return fallback
  const parsed = Number(raw)
  // A malformed knob must not silently degrade to the default: the operator
  // would believe a window is in force that never was.
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`yrd: ${variable}='${raw}' must be a positive safe integer`)
  }
  return parsed
}

function journalWriterVersion(value: number | undefined): number {
  const version = value ?? 0
  if (!Number.isSafeInteger(version) || version < 0 || version > JOURNAL_READER_VERSION) {
    throw new RangeError(
      `yrd: journal writer version must be an integer from 0 through ${String(JOURNAL_READER_VERSION)}`,
    )
  }
  return version
}

function validateViews(views: readonly JournalView[]): readonly JournalView[] {
  const ids = new Set<string>()
  for (const view of views) {
    if (!/^[a-z][a-z0-9.-]*$/u.test(view.id)) {
      throw new TypeError(`yrd: journal view id '${view.id}' is invalid`)
    }
    if (ids.has(view.id)) throw new TypeError(`yrd: duplicate journal view '${view.id}'`)
    ids.add(view.id)
    if (!Number.isSafeInteger(view.version) || view.version < 1) {
      throw new TypeError(`yrd: journal view '${view.id}' version must be a positive safe integer`)
    }
    if (!SHA256_PATTERN.test(view.fingerprint)) {
      throw new TypeError(`yrd: journal view '${view.id}' fingerprint must be a lowercase SHA-256`)
    }
  }
  return Object.freeze([...views].toSorted((left, right) => left.id.localeCompare(right.id)))
}

export function createJournal(options: JournalOptions & Readonly<{ views: readonly JournalView[] }>): MutableJournal
export function createJournal(options: JournalOptions): Journal<unknown>
export function createJournal(options: JournalOptions): Journal<unknown> {
  return createJournalWithMode(options, "mutable") as MutableJournal
}

export function createReadOnlyJournal(options: JournalOptions): Journal<unknown> {
  return createJournalWithMode(options, "read-only")
}

function createJournalWithMode(options: JournalOptions, mode: JournalMode): Journal<unknown> {
  const runtime = context(options)
  let archiveFallbacks = 0
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
    async append(value, expectedCursor) {
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
            const required = journalFrameCompatibility(frame)
            const head = readHead(database)
            const floor = readJournalVersionFloor(database)
            if (required !== undefined && required.version > floor) {
              raiseFailure(
                "refusal",
                "journal-write-version-floor",
                `yrd: journal schema v${required.version} exceeds journal floor v${floor}; run 'yrd admin journal bump ${String(required.version)}' after stopping older residents`,
              )
            }
            if (head !== expectedCursor) return { appended: false as const, cursor: head }
            const cursor = head + 1
            assertCursor(cursor)
            const valueJson = JSON.stringify(frame)
            database.run("BEGIN IMMEDIATE")
            try {
              database
                .query("INSERT INTO journal_events(cursor, value_json, sha256) VALUES (?, ?, ?)")
                .run(cursor, valueJson, digestText(valueJson))
              insertFrameFacts(database, cursor, frame)
              applyJournalViews(database, runtime.views, { cursor, value: frame })
              writeMetadata(database, "head_cursor", String(cursor))
              writeMetadata(database, "facts_head", String(cursor))
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
  const history: JournalHistory<unknown> = Object.freeze({
    command(query) {
      archiveFallbacks += 1
      return lookupCommand(runtime, query)
    },
    hasIdentity(kind, id) {
      return lookupIdentity(runtime, kind, id)
    },
    entity(kind, id) {
      archiveFallbacks += 1
      return lookupEntity(runtime, kind, id)
    },
    diagnostics() {
      return historyDiagnostics(runtime, archiveFallbacks)
    },
  })
  Object.defineProperty(journal, "history", { value: history, enumerable: false })
  if (mode === "mutable") {
    Object.defineProperty(journal, "views", {
      value: Object.freeze({ rebuild: () => rebuildJournalViews(runtime) }),
      enumerable: false,
    })
    Object.defineProperty(journal, "administration", {
      value: Object.freeze({ bump: (version: number) => bumpJournalVersion(runtime, version) }),
      enumerable: false,
    })
  }
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
        runtime.log.warn?.("Saved state is damaged; rebuilding it.")
        return undefined
      }
      if (snapshot.checkpoint_identity !== identity) {
        runtime.log.info?.("Saved state is outdated; rebuilding it.")
        return undefined
      }
      const checkpoint = JSON.parse(checkpointJson) as JournalCheckpoint
      if (checkpoint.identity !== identity || checkpoint.cursor !== snapshot.cursor) {
        runtime.log.warn?.("Saved state is inconsistent; rebuilding it.")
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
      let evicted: EvictionOutcome | undefined
      const current = readSnapshotHeader(database)
      const head = readHead(database)
      if (
        checkpoint.cursor > head ||
        checkpoint.cursor < current.cursor ||
        current.cursor !== prepared.snapshotCursor ||
        current.prefix_sha256 !== prepared.snapshotPrefixSha256 ||
        current.prefix_last_cursor !== prepared.snapshotPrefixLastCursor
      ) {
        runtime.log.debug?.("Saved state changed before this update finished; skipped this update.")
        return false
      }
      database.run("BEGIN IMMEDIATE")
      try {
        database
          .query(
            `INSERT INTO journal_history(cursor, value_json, sha256)
           SELECT cursor, value_json, sha256 FROM journal_events WHERE cursor <= ?
           ON CONFLICT(cursor) DO NOTHING`,
          )
          .run(checkpoint.cursor)
        const emptyPrefix = "[]"
        const updated = database
          .query(
            `UPDATE journal_snapshot
             SET cursor = ?, prefix_json = ?, prefix_sha256 = ?, prefix_last_cursor = ?,
                 checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ?
             WHERE singleton = 1 AND cursor = ? AND prefix_sha256 = ? AND prefix_last_cursor = ?`,
          )
          .run(
            checkpoint.cursor,
            emptyPrefix,
            digestText(emptyPrefix),
            0,
            checkpoint.identity,
            prepared.checkpointJson,
            prepared.checkpointSha256,
            prepared.snapshotCursor,
            prepared.snapshotPrefixSha256,
            prepared.snapshotPrefixLastCursor,
          )
        if (updated.changes !== 1) {
          rollback(database)
          runtime.log.debug?.("Saved state changed before this update finished; skipped this update.")
          return false
        }
        database.query("DELETE FROM journal_events WHERE cursor <= ?").run(checkpoint.cursor)
        evicted = evictHistory(runtime, database, checkpoint.cursor)
        database.run("COMMIT")
      } catch (error) {
        rollback(database)
        throw error
      }
      runtime.log.debug?.("Saved current state.", {
        action: "checkpoint-written",
        path: runtime.path,
        cursor: checkpoint.cursor,
        compactedEvents: prepared.compactedEvents,
      })
      if (evicted !== undefined) reportEviction(runtime, evicted)
      incrementalVacuum(runtime, database)
      return true
    })
  } catch (error) {
    runtime.log.warn?.(
      "Could not save Yrd's current state; the command succeeded, but the next command may start more slowly.",
      { error: error instanceof Error ? error.message : String(error) },
    )
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
      runtime.log.debug?.("Saved state is already newer; skipped this update.")
      return null
    }
    if (checkpoint.cursor !== snapshot.cursor) {
      const committed = database
        .query<{ committed: number }, [number, number, number]>(
          `SELECT EXISTS(SELECT 1 FROM journal_events WHERE cursor = ?)
                OR EXISTS(SELECT 1 FROM journal_history WHERE cursor = ?)
                OR EXISTS(SELECT 1 FROM journal_orphans WHERE cursor = ?) AS committed`,
        )
        .get(checkpoint.cursor, checkpoint.cursor, checkpoint.cursor)
      if (committed?.committed !== 1) {
        database.run("COMMIT")
        runtime.log.warn?.(
          "Could not save Yrd's current state because part of its history is missing; no work was lost.",
        )
        return null
      }
    }
    const covered =
      database
        .query<{ count: number }, [number, number]>(
          "SELECT COUNT(*) AS count FROM journal_events WHERE cursor > ? AND cursor <= ?",
        )
        .get(snapshot.cursor, checkpoint.cursor)?.count ?? 0
    database.run("COMMIT")
    const checkpointJson = JSON.stringify(checkpoint)
    return {
      snapshotCursor: snapshot.cursor,
      snapshotPrefixSha256: snapshot.prefix_sha256,
      snapshotPrefixLastCursor: snapshot.prefix_last_cursor,
      checkpointJson,
      checkpointSha256: sha256(Buffer.from(checkpointJson)),
      compactedEvents: covered,
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
    // Serving this range would mean handing back a history with a hole in it and
    // no way for the reader to tell. Refuse instead, and name the first cursor
    // that can still be replayed.
    const evictedThrough = readEvictedThrough(database)
    if (after < evictedThrough) {
      throw new RangeError(
        `yrd: journal history through cursor ${evictedThrough} was evicted by the retention window; replay from ${evictedThrough} or later, or use the checkpoint`,
      )
    }
    if (after === end) return []

    const batches: Array<Readonly<{ cursor: number; values: readonly unknown[] }>> = []
    let served = after
    if (after < snapshot.cursor) {
      const coveredEnd = Math.min(end, snapshot.cursor)
      const entries = database
        .query<StoredEvent, [number, number]>(
          `SELECT cursor, value_json, sha256 FROM journal_history
           WHERE cursor > ? AND cursor <= ? ORDER BY cursor`,
        )
        .all(after, coveredEnd)
        .map(decodeStoredEvent)
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

/**
 * How long SQLite waits for a held lock before returning SQLITE_BUSY.
 *
 * SQLite's default is 0 — a reader that arrives while a writer holds the lock
 * fails INSTANTLY with "database is locked" rather than waiting. That default is
 * wrong for this journal: `wal_autocheckpoint` is 0, so checkpoints are explicit,
 * and `wal_checkpoint(TRUNCATE)` takes an EXCLUSIVE lock on the whole database.
 * A long-lived reader such as `yrd watch` running beside an active queue runner
 * therefore hits a lock window regularly, and with no timeout it crashes instead
 * of waiting the few milliseconds the writer needs.
 */
const BUSY_TIMEOUT_MS = 5000

/** Wait on contention instead of failing instantly (see BUSY_TIMEOUT_MS). */
function applyBusyTimeout(database: Database): void {
  database.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
}

function openReadOnly(path: string): Database {
  const database = new Database(path, { readonly: true, strict: true })
  applyBusyTimeout(database)
  return database
}

function rethrowSqliteBusy(error: unknown): never {
  const fact =
    typeof error === "object" && error !== null ? (error as Readonly<{ code?: unknown; errno?: unknown }>) : undefined
  if (fact?.code !== "SQLITE_BUSY" && fact?.errno !== 5) throw error
  const reason = error instanceof Error ? error.message : String(error)
  throw createFailure(
    {
      kind: "infrastructure",
      code: "journal-busy",
      message: `yrd: journal is busy: ${reason}`,
    },
    error,
  )
}

async function withMutableDatabase<Result>(
  runtime: Context,
  operation: (database: Database) => Result,
): Promise<Result> {
  assertMutablePlatform(runtime)
  try {
    return await runtime.exclusive.run(async () => {
      await ensureDatabase(runtime)
      const database = openMutable(runtime)
      try {
        return operation(database)
      } finally {
        checkpointWal(runtime, database)
        database.close()
      }
    })
  } catch (error) {
    rethrowSqliteBusy(error)
  }
}

function openMutable(runtime: Context, verifyViews = true): Database {
  const database = new Database(runtime.path, { create: false, readwrite: true, strict: true })
  try {
    const observed = sqliteVersion(database)
    assertSafeWalVersion(runtime.sqliteVersion ?? observed)
    applyBusyTimeout(database)
    database.run("PRAGMA synchronous = FULL")
    database.run("PRAGMA wal_autocheckpoint = 0")
    database.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1)
    const row = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()
    if (row?.journal_mode.toLowerCase() !== "wal") throw new Error("yrd: SQLite would not enable WAL journal mode")
    const { head } = assertComplete(database, runtime.path)
    if (verifyViews) assertJournalViews(database, runtime.views, head)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

async function ensureDatabase(runtime: Context, verifyViews = true): Promise<void> {
  assertMutablePlatform(runtime)
  if (await exists(runtime.path)) {
    let userVersion: number | undefined
    let maintenancePending = false
    {
      using database = openReadOnly(runtime.path)
      userVersion = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
      maintenancePending = userVersion === SCHEMA_VERSION && readMetadata(database, "maintenance_pending") === "1"
    }
    if (userVersion === 1) {
      await migrateSchemaV1(runtime)
    } else if (userVersion === SCHEMA_VERSION && maintenancePending) {
      await finishSchemaMaintenance(runtime)
    }
    {
      using database = openReadOnly(runtime.path)
      assertComplete(database, runtime.path)
      if (!hasJournalViewRegistry(database)) await installJournalViews(runtime)
    }
    ensureJournalVersionFloor(runtime)
    using complete = openReadOnly(runtime.path)
    const { head } = assertComplete(complete, runtime.path)
    if (verifyViews) assertJournalViews(complete, runtime.views, head)
    await finalizeExistingSqliteCutover(runtime, complete)
    return
  }
  await mkdir(runtime.dir, { recursive: true })
  using versionDatabase = new Database(":memory:", { strict: true })
  assertSafeWalVersion(runtime.sqliteVersion ?? sqliteVersion(versionDatabase))
  if (await recoverInterruptedSqliteCutover(runtime)) return
  const legacy = await readLegacySource(runtime)
  await publishCandidate(runtime, legacy)
}

async function migrateSchemaV1(runtime: Context): Promise<void> {
  using database = new Database(runtime.path, { create: false, readwrite: true, strict: true })
  assertSafeWalVersion(runtime.sqliteVersion ?? sqliteVersion(database))
  const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
  if (version !== 1) throw new Error(`yrd: journal v1 migration expected schema 1, observed ${version ?? "missing"}`)
  const snapshot = readSnapshotHeader(database)
  const prefix = readVerifiedPrefix(database, snapshot)
  const tail = database
    .query<StoredEvent, []>("SELECT cursor, value_json, sha256 FROM journal_events ORDER BY cursor")
    .all()
  await runtime.phase("schema-v2-prepared", { historyFrames: prefix.length, tailFrames: tail.length })
  database.run("BEGIN IMMEDIATE")
  try {
    database.run(`
      CREATE TABLE journal_history (
        cursor INTEGER PRIMARY KEY NOT NULL CHECK (cursor > 0),
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64)
      ) STRICT;
      CREATE TABLE journal_commands (
        cursor INTEGER PRIMARY KEY NOT NULL CHECK (cursor > 0),
        command_id TEXT UNIQUE NOT NULL,
        command_key TEXT UNIQUE,
        command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
        cause_id TEXT UNIQUE NOT NULL
      ) STRICT;
      CREATE TABLE journal_event_ids (
        event_id TEXT PRIMARY KEY NOT NULL,
        cursor INTEGER NOT NULL CHECK (cursor > 0),
        event_index INTEGER NOT NULL CHECK (event_index >= 0),
        UNIQUE(cursor, event_index)
      ) STRICT;
      CREATE TABLE journal_entities (
        kind TEXT NOT NULL CHECK (kind IN ('job', 'job-key', 'queue')),
        id TEXT NOT NULL,
        cursor INTEGER NOT NULL CHECK (cursor > 0),
        PRIMARY KEY(kind, id, cursor)
      ) STRICT;
      CREATE INDEX journal_entities_cursor ON journal_entities(cursor);
    `)
    const insertHistory = database.query("INSERT INTO journal_history(cursor, value_json, sha256) VALUES (?, ?, ?)")
    for (const entry of prefix) {
      const valueJson = JSON.stringify(entry.value)
      insertHistory.run(entry.cursor, valueJson, digestText(valueJson))
      insertFrameFacts(database, entry.cursor, parseJournalFrame(entry.value))
    }
    for (const row of tail) insertFrameFacts(database, row.cursor, decodeStoredEvent(row).value as JournalFrame)
    const emptyPrefix = "[]"
    database
      .query(
        `UPDATE journal_snapshot
         SET prefix_json = ?, prefix_sha256 = ?, prefix_last_cursor = 0
         WHERE singleton = 1`,
      )
      .run(emptyPrefix, digestText(emptyPrefix))
    writeMetadata(database, "schema_version", String(SCHEMA_VERSION))
    writeMetadata(database, "maintenance_pending", "1")
    writeMetadata(database, "facts_head", readMetadata(database, "head_cursor"))
    database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    assertJournalFacts(database)
    database.run("COMMIT")
  } catch (error) {
    rollback(database)
    throw error
  }
  await runtime.phase("schema-v2-committed", { path: runtime.path })
  database.close()
  await finishSchemaMaintenance(runtime)
}

async function installJournalViews(runtime: Context): Promise<void> {
  using database = new Database(runtime.path, { create: false, readwrite: true, strict: true })
  assertSafeWalVersion(runtime.sqliteVersion ?? sqliteVersion(database))
  const { head } = assertComplete(database, runtime.path)
  const entries = liveJournalEntries(database)
  await runtime.phase("journal-views-schema-prepared", { frames: entries.length, views: runtime.views.length })
  database.run("BEGIN IMMEDIATE")
  try {
    createJournalViewRegistry(database, runtime.views)
    writeMetadata(database, JOURNAL_VIEWS_GENERATION, "1")
    for (const entry of entries) applyJournalViews(database, runtime.views, entry)
    setJournalViewsCursor(database, runtime.views, head)
    assertJournalViews(database, runtime.views, head)
    database.run("COMMIT")
  } catch (error) {
    rollback(database)
    throw error
  }
  await runtime.phase("journal-views-schema-committed", {
    path: runtime.path,
    cursor: head,
    views: runtime.views.length,
  })
}

async function rebuildJournalViews(runtime: Context): Promise<JournalViewRebuildResult> {
  assertMutablePlatform(runtime)
  return runtime.exclusive.run(async () => {
    await ensureDatabase(runtime, false)
    const database = openMutable(runtime, false)
    try {
      const { head } = assertComplete(database, runtime.path)
      const entries = liveJournalEntries(database)
      await runtime.phase("journal-views-rebuild-prepared", {
        cursor: head,
        frames: entries.length,
        views: runtime.views.length,
      })
      database.run("BEGIN IMMEDIATE")
      try {
        incrementJournalViewsGeneration(database)
        for (const view of runtime.views) view.reset(database)
        database.run("DELETE FROM journal_views")
        registerJournalViews(database, runtime.views)
        for (const entry of entries) applyJournalViews(database, runtime.views, entry)
        setJournalViewsCursor(database, runtime.views, head)
        assertJournalViews(database, runtime.views, head)
        database.run("COMMIT")
      } catch (error) {
        rollback(database)
        throw error
      }
      await runtime.phase("journal-views-rebuild-committed", {
        cursor: head,
        frames: entries.length,
        views: runtime.views.length,
      })
      return { cursor: head, frames: entries.length, views: runtime.views.length }
    } finally {
      checkpointWal(runtime, database)
      database.close()
    }
  })
}

async function finishSchemaMaintenance(runtime: Context): Promise<void> {
  await runtime.phase("schema-v2-maintenance-started", { path: runtime.path })
  using database = new Database(runtime.path, { create: false, readwrite: true, strict: true })
  database.run("PRAGMA synchronous = FULL")
  database.run("PRAGMA auto_vacuum = INCREMENTAL")
  database.run("VACUUM")
  writeMetadata(database, "maintenance_pending", "0")
  await runtime.phase("schema-v2-maintenance-complete", { path: runtime.path })
}

function assertMutablePlatform(runtime: Context): void {
  if (runtime.platform === "win32") {
    throw new Error("yrd: journal writes are not supported on win32")
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
    applyBusyTimeout(database)
    database.run("PRAGMA journal_mode = DELETE")
    database.run("PRAGMA synchronous = FULL")
    database.run("PRAGMA auto_vacuum = INCREMENTAL")
    createSchema(database, head, fingerprint, runtime.views, initialJournalVersionFloor(runtime, rows, legacy === null))
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
          const frame = parseJournalFrame(row.value)
          insertFrameFacts(database, row.cursor, frame)
          applyJournalViews(database, runtime.views, { cursor: row.cursor, value: frame })
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
      setJournalViewsCursor(database, runtime.views, head)
      assertJournalFacts(database)
      writeMetadata(database, "migration_complete", "1")
      writeMetadata(database, "facts_head", String(head))
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
    runtime.log.info?.("Yrd's saved state is ready.", {
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

function createSchema(
  database: Database,
  head: number,
  fingerprint: string,
  views: readonly JournalView[],
  journalVersionFloor: number,
): void {
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
    CREATE TABLE journal_history (
      cursor INTEGER PRIMARY KEY NOT NULL CHECK (cursor > 0),
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64)
    ) STRICT;
    CREATE TABLE journal_commands (
      cursor INTEGER PRIMARY KEY NOT NULL CHECK (cursor > 0),
      command_id TEXT UNIQUE NOT NULL,
      command_key TEXT UNIQUE,
      command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
      cause_id TEXT UNIQUE NOT NULL
    ) STRICT;
    CREATE TABLE journal_event_ids (
      event_id TEXT PRIMARY KEY NOT NULL,
      cursor INTEGER NOT NULL CHECK (cursor > 0),
      event_index INTEGER NOT NULL CHECK (event_index >= 0),
      UNIQUE(cursor, event_index)
    ) STRICT;
    CREATE TABLE journal_entities (
      kind TEXT NOT NULL CHECK (kind IN ('job', 'job-key', 'queue')),
      id TEXT NOT NULL,
      cursor INTEGER NOT NULL CHECK (cursor > 0),
      PRIMARY KEY(kind, id, cursor)
    ) STRICT;
    CREATE INDEX journal_entities_cursor ON journal_entities(cursor);
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
  writeMetadata(database, "facts_head", String(head))
  writeMetadata(database, "source_fingerprint", fingerprint)
  writeMetadata(database, "migration_complete", "0")
  writeMetadata(database, "maintenance_pending", "0")
  writeMetadata(database, JOURNAL_VIEWS_GENERATION, "1")
  writeMetadata(database, JOURNAL_VERSION_FLOOR, String(journalVersionFloor))
  createJournalViewRegistry(database, views)
}

function initialJournalVersionFloor(runtime: Context, rows: readonly LegacyRow[], fresh: boolean): number {
  const observed = rows.reduce((floor, row) => {
    if (row.kind !== "live") return floor
    return Math.max(floor, journalFrameCompatibility(row.value)?.version ?? 0)
  }, 0)
  return fresh ? runtime.writerVersion : observed
}

function readJournalVersionFloor(database: Database): number {
  const value = database
    .query<{ value: string }, [string]>("SELECT value FROM journal_metadata WHERE key = ?")
    .get(JOURNAL_VERSION_FLOOR)?.value
  const version = value === undefined ? Number.NaN : Number(value)
  if (!Number.isSafeInteger(version) || version < 0 || version > JOURNAL_READER_VERSION) {
    throw new Error(`yrd: journal version floor '${value ?? "missing"}' is invalid`)
  }
  return version
}

function ensureJournalVersionFloor(runtime: Context): void {
  let observed = 0
  {
    using read = openReadOnly(runtime.path)
    const current = read
      .query<{ value: string }, [string]>("SELECT value FROM journal_metadata WHERE key = ?")
      .get(JOURNAL_VERSION_FLOOR)?.value
    if (current !== undefined) return
    observed =
      read
        .query<{ version: number | null }, []>(
          `SELECT MAX(version) AS version FROM (
             SELECT CAST(json_extract(value_json, '$.compatibility.version') AS INTEGER) AS version FROM journal_events
             UNION ALL
             SELECT CAST(json_extract(value_json, '$.compatibility.version') AS INTEGER) AS version FROM journal_history
           )`,
        )
        .get()?.version ?? 0
  }
  using database = new Database(runtime.path, { create: false, readwrite: true, strict: true })
  writeMetadata(database, JOURNAL_VERSION_FLOOR, String(observed))
}

async function bumpJournalVersion(runtime: Context, target: number): Promise<JournalVersionBumpResult> {
  const version = journalWriterVersion(target)
  if (version === 0) throw new RangeError("yrd: journal version bump target must be at least 1")
  await mkdir(join(runtime.dir, "journal-snapshots"), { recursive: true })
  const snapshot = join(
    runtime.dir,
    "journal-snapshots",
    `pre-bump-v${String(version)}-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}.sqlite`,
  )
  return withMutableDatabase(runtime, (database) => {
    const from = readJournalVersionFloor(database)
    if (version < from) {
      raiseFailure(
        "refusal",
        "journal-version-bump-one-way",
        `yrd: journal floor v${from} cannot be lowered to v${version}; restore a pre-bump snapshot with all writers stopped`,
      )
    }
    if (version === from) {
      raiseFailure("refusal", "journal-version-current", `yrd: journal floor is already v${version}`)
    }
    database.run("VACUUM INTO ?", [snapshot])
    using restored = openReadOnly(snapshot)
    assertComplete(restored, snapshot)
    if (readJournalVersionFloor(restored) !== from) {
      throw new Error(`yrd: journal snapshot restore drill did not preserve floor v${from}`)
    }
    database.run("BEGIN IMMEDIATE")
    try {
      writeMetadata(database, JOURNAL_VERSION_FLOOR, String(version))
      database.run("COMMIT")
    } catch (error) {
      rollback(database)
      throw error
    }
    return { from, to: version, snapshot, restoreDrill: "passed" as const }
  })
}

function createJournalViewRegistry(database: Database, views: readonly JournalView[]): void {
  database.run(`
    CREATE TABLE journal_views (
      view_id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
      cursor INTEGER NOT NULL CHECK (cursor >= 0)
    ) STRICT
  `)
  registerJournalViews(database, views)
}

function registerJournalViews(database: Database, views: readonly JournalView[]): void {
  const register = database.query(
    "INSERT INTO journal_views(view_id, version, fingerprint, cursor) VALUES (?, ?, ?, ?)",
  )
  for (const view of views) {
    view.install(database)
    register.run(view.id, view.version, view.fingerprint, 0)
  }
}

function applyJournalViews(database: Database, views: readonly JournalView[], entry: JournalViewEntry): void {
  for (const view of views) {
    view.apply(database, entry)
    const updated = database
      .query(
        `UPDATE journal_views
         SET cursor = ?
         WHERE view_id = ? AND version = ? AND fingerprint = ?`,
      )
      .run(entry.cursor, view.id, view.version, view.fingerprint)
    if (updated.changes !== 1) {
      throw new Error(
        `yrd: journal view '${view.id}' is not registered at v${String(view.version)}; run 'yrd doctor --rebuild-views'`,
      )
    }
  }
}

function setJournalViewsCursor(database: Database, views: readonly JournalView[], cursor: number): void {
  for (const view of views) {
    const updated = database
      .query(
        `UPDATE journal_views
         SET cursor = ?
         WHERE view_id = ? AND version = ? AND fingerprint = ?`,
      )
      .run(cursor, view.id, view.version, view.fingerprint)
    if (updated.changes !== 1) {
      throw new Error(
        `yrd: journal view '${view.id}' is not registered at v${String(view.version)}; run 'yrd doctor --rebuild-views'`,
      )
    }
  }
}

function assertJournalViews(database: Database, views: readonly JournalView[], head: number): void {
  const registered = database
    .query<{ view_id: string; version: number; fingerprint: string; cursor: number }, []>(
      "SELECT view_id, version, fingerprint, cursor FROM journal_views ORDER BY view_id",
    )
    .all()
  const generation = database
    .query<{ value: string }, [string]>("SELECT value FROM journal_metadata WHERE key = ?")
    .get(JOURNAL_VIEWS_GENERATION)?.value
  const parsedGeneration = Number(generation)
  const matches =
    Number.isSafeInteger(parsedGeneration) &&
    parsedGeneration >= 1 &&
    registered.length === views.length &&
    registered.every((row, index) => {
      const view = views[index]
      return (
        view !== undefined &&
        row.view_id === view.id &&
        row.version === view.version &&
        row.fingerprint === view.fingerprint &&
        row.cursor === head
      )
    })
  if (!matches) {
    throw new Error("yrd: journal view registration does not match; run 'yrd doctor --rebuild-views'")
  }
}

function incrementJournalViewsGeneration(database: Database): void {
  const current = database
    .query<{ value: string }, [string]>("SELECT value FROM journal_metadata WHERE key = ?")
    .get(JOURNAL_VIEWS_GENERATION)?.value
  const generation = current === undefined ? 0 : Number(current)
  if (!Number.isSafeInteger(generation) || generation < 0 || generation === Number.MAX_SAFE_INTEGER) {
    throw new Error("yrd: journal view generation is invalid")
  }
  writeMetadata(database, JOURNAL_VIEWS_GENERATION, String(generation + 1))
}

function assertComplete(database: Database, path: string): Readonly<{ head: number; snapshot: SnapshotHeader }> {
  const userVersion = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
  if (userVersion !== SCHEMA_VERSION) {
    throw new Error(`yrd: unsupported or incomplete SQLite journal schema at ${path} (v${userVersion ?? "missing"})`)
  }
  if (readMetadata(database, "migration_complete") !== "1") {
    throw new Error(`yrd: incomplete SQLite journal migration at ${path}`)
  }
  if (readMetadata(database, "maintenance_pending") !== "0") {
    throw new Error(`yrd: incomplete SQLite journal maintenance at ${path}`)
  }
  const autoVacuum = database.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum
  if (autoVacuum !== 2) throw new Error(`yrd: SQLite journal incremental auto-vacuum is not active at ${path}`)
  const head = readHead(database)
  const snapshot = readSnapshotHeader(database)
  assertCursor(snapshot.cursor)
  assertCursor(snapshot.prefix_last_cursor)
  if (snapshot.prefix_last_cursor !== 0 || readVerifiedPrefix(database, snapshot).length !== 0) {
    throw new Error("yrd: SQLite journal snapshot must not duplicate row history in prefix_json")
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
  const futureHistory = database
    .query<{ cursor: number }, [number]>("SELECT cursor FROM journal_history WHERE cursor > ? ORDER BY cursor LIMIT 1")
    .get(snapshot.cursor)
  if (futureHistory !== null) {
    throw new Error(`yrd: SQLite journal history cursor ${futureHistory.cursor} is above snapshot ${snapshot.cursor}`)
  }
  const evictedThrough = readEvictedThrough(database)
  if (evictedThrough >= snapshot.cursor && snapshot.cursor > 0) {
    throw new Error(`yrd: SQLite journal retention floor ${evictedThrough} reaches snapshot ${snapshot.cursor}`)
  }
  const survivor = database
    .query<{ cursor: number }, [number]>("SELECT cursor FROM journal_history WHERE cursor <= ? ORDER BY cursor LIMIT 1")
    .get(evictedThrough)
  if (survivor !== null) {
    throw new Error(`yrd: SQLite journal history cursor ${survivor.cursor} survives retention floor ${evictedThrough}`)
  }
  const tableOverlap = database
    .query<{ cursor: number }, []>(
      `SELECT cursor FROM (
         SELECT event.cursor FROM journal_events event
          WHERE EXISTS(SELECT 1 FROM journal_history history WHERE history.cursor = event.cursor)
         UNION ALL
         SELECT orphan.cursor FROM journal_orphans orphan
          WHERE EXISTS(SELECT 1 FROM journal_events event WHERE event.cursor = orphan.cursor)
             OR EXISTS(SELECT 1 FROM journal_history history WHERE history.cursor = orphan.cursor)
       )
       LIMIT 1`,
    )
    .get()
  if (tableOverlap !== null) {
    throw new Error(`yrd: SQLite journal cursor ${tableOverlap.cursor} overlaps live and orphan tables`)
  }
  const snapshotBoundary =
    snapshot.cursor > 0 &&
    database
      .query<{ committed: number }, [number, number]>(
        `SELECT EXISTS(SELECT 1 FROM journal_history WHERE cursor = ?)
             OR EXISTS(SELECT 1 FROM journal_orphans WHERE cursor = ?) AS committed`,
      )
      .get(snapshot.cursor, snapshot.cursor)?.committed === 1
  if (snapshot.cursor > 0 && !snapshotBoundary) {
    throw new Error(`yrd: SQLite journal snapshot cursor ${snapshot.cursor} has no committed boundary`)
  }
  const eventMax =
    database.query<{ cursor: number | null }, []>("SELECT MAX(cursor) AS cursor FROM journal_events").get()?.cursor ?? 0
  const orphanMax =
    database.query<{ cursor: number | null }, []>("SELECT MAX(cursor) AS cursor FROM journal_orphans").get()?.cursor ??
    0
  const historyMax =
    database.query<{ cursor: number | null }, []>("SELECT MAX(cursor) AS cursor FROM journal_history").get()?.cursor ??
    0
  const committedHead = Math.max(snapshot.cursor, eventMax, historyMax, orphanMax)
  if (snapshot.cursor > head || head !== committedHead) {
    throw new Error(
      `yrd: SQLite journal head/cursor binding is invalid at ${path} (head=${head}, snapshot=${snapshot.cursor}, events=${eventMax}, orphans=${orphanMax})`,
    )
  }
  if (readMetadata(database, "facts_head") !== String(head)) {
    throw new Error(`yrd: SQLite journal lookup facts are not bound to head ${head}`)
  }
  return { head, snapshot }
}

function hasJournalViewRegistry(database: Database): boolean {
  return (
    database
      .query<{ present: number }, []>(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'journal_views'",
      )
      .get()?.present === 1
  )
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

function liveJournalEntries(database: Database): readonly PrefixEntry[] {
  return database
    .query<StoredEvent, []>(
      `SELECT cursor, value_json, sha256 FROM journal_history
       UNION ALL
       SELECT cursor, value_json, sha256 FROM journal_events
       ORDER BY cursor`,
    )
    .all()
    .map(decodeStoredEvent)
}

function insertFrameFacts(database: Database, cursor: number, frame: JournalFrame): void {
  database
    .query(
      `INSERT INTO journal_commands(cursor, command_id, command_key, command_hash, cause_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(cursor, frame.command.id, frame.cause.key ?? null, frame.cause.commandHash, frame.cause.id)
  const insertEvent = database.query("INSERT INTO journal_event_ids(event_id, cursor, event_index) VALUES (?, ?, ?)")
  for (const [index, applied] of frame.events.entries()) insertEvent.run(applied.id, cursor, index)
  const insertEntity = database.query("INSERT OR IGNORE INTO journal_entities(kind, id, cursor) VALUES (?, ?, ?)")
  for (const [kind, id] of frameEntities(frame)) insertEntity.run(kind, id, cursor)
}

function frameEntities(frame: JournalFrame): readonly Readonly<[JournalEntityKind, string]>[] {
  const facts = new Set<string>()
  const add = (kind: JournalEntityKind, id: unknown): void => {
    if (typeof id === "string" && id !== "") facts.add(`${kind}\0${id}`)
  }
  for (const applied of frame.events) {
    const data =
      typeof applied.data === "object" && applied.data !== null && !Array.isArray(applied.data)
        ? (applied.data as Readonly<Record<string, unknown>>)
        : undefined
    if (applied.name === "job/requested") {
      add("job", applied.id)
      add("job-key", data?.key)
    } else if (applied.name === "job/transitioned") {
      add("job", data?.id)
    } else if (applied.name === "job/restored") {
      const job =
        typeof data?.job === "object" && data.job !== null && !Array.isArray(data.job)
          ? (data.job as Readonly<Record<string, unknown>>)
          : undefined
      add("job", job?.id)
      add("job-key", job?.key)
    }

    const run = data?.run
    if (typeof run === "string") add("queue", run)
    else if (typeof run === "object" && run !== null && !Array.isArray(run)) {
      add("queue", (run as Readonly<Record<string, unknown>>).id)
    }
    if (applied.name === "queue/batch/isolated") add("queue", data?.parent)
  }
  return [...facts].map((fact) => {
    const separator = fact.indexOf("\0")
    return [fact.slice(0, separator) as JournalEntityKind, fact.slice(separator + 1)] as const
  })
}

function storedFrameAt(database: Database, cursor: number): JournalFrame {
  const row = database
    .query<StoredEvent, [number, number]>(
      `SELECT cursor, value_json, sha256 FROM journal_history WHERE cursor = ?
       UNION ALL
       SELECT cursor, value_json, sha256 FROM journal_events WHERE cursor = ?`,
    )
    .get(cursor, cursor)
  if (row === null) throw new Error(`yrd: journal lookup cursor ${cursor} has no immutable frame`)
  return decodeStoredEvent(row).value as JournalFrame
}

function lookupCommand(runtime: Context, query: Readonly<{ id?: string; key?: string }>): JournalFrame | undefined {
  if (query.id === undefined && query.key === undefined) {
    throw new TypeError("yrd: journal command lookup requires id or key")
  }
  if (!existsSync(runtime.path)) return undefined
  using database = openReadOnly(runtime.path)
  return readTransaction(database, () => {
    assertComplete(database, runtime.path)
    const rows = database
      .query<
        { cursor: number; command_id: string; command_key: string | null; command_hash: string; cause_id: string },
        [string | null, string | null, string | null, string | null]
      >(
        `SELECT cursor, command_id, command_key, command_hash, cause_id
         FROM journal_commands
         WHERE (? IS NOT NULL AND command_id = ?) OR (? IS NOT NULL AND command_key = ?)
         ORDER BY cursor`,
      )
      .all(query.id ?? null, query.id ?? null, query.key ?? null, query.key ?? null)
    if (rows.length === 0) return undefined
    if (rows.length !== 1) throw new Error("yrd: journal command id and key resolve to different immutable frames")
    const row = rows[0]
    if (row === undefined) return undefined
    const frame = storedFrameAt(database, row.cursor)
    if (
      frame.command.id !== row.command_id ||
      frame.cause.key !== (row.command_key ?? undefined) ||
      frame.cause.commandHash !== row.command_hash ||
      frame.cause.id !== row.cause_id
    ) {
      throw new Error(`yrd: journal command lookup facts disagree at cursor ${row.cursor}`)
    }
    return frame
  })
}

function lookupIdentity(runtime: Context, kind: JournalIdentityKind, id: string): boolean {
  if (!existsSync(runtime.path)) return false
  using database = openReadOnly(runtime.path)
  return readTransaction(database, () => {
    assertComplete(database, runtime.path)
    const cursor =
      kind === "cause"
        ? database.query<{ cursor: number }, [string]>("SELECT cursor FROM journal_commands WHERE cause_id = ?").get(id)
            ?.cursor
        : database
            .query<{ cursor: number }, [string]>("SELECT cursor FROM journal_event_ids WHERE event_id = ?")
            .get(id)?.cursor
    if (cursor === undefined) return false
    const frame = storedFrameAt(database, cursor)
    const matches = kind === "cause" ? frame.cause.id === id : frame.events.some((applied) => applied.id === id)
    if (!matches) throw new Error(`yrd: journal ${kind} lookup facts disagree at cursor ${cursor}`)
    return true
  })
}

function lookupEntity(
  runtime: Context,
  kind: JournalEntityKind,
  id: string,
): readonly JournalHistoryEntry<JournalFrame>[] {
  if (!existsSync(runtime.path)) return []
  using database = openReadOnly(runtime.path)
  return readTransaction(database, () => {
    assertComplete(database, runtime.path)
    return database
      .query<{ cursor: number }, [JournalEntityKind, string]>(
        "SELECT cursor FROM journal_entities WHERE kind = ? AND id = ? ORDER BY cursor",
      )
      .all(kind, id)
      .map(({ cursor }) => {
        const value = storedFrameAt(database, cursor)
        if (
          !frameEntities(value).some(([candidateKind, candidateId]) => candidateKind === kind && candidateId === id)
        ) {
          throw new Error(`yrd: journal entity lookup facts disagree at cursor ${cursor}`)
        }
        return { cursor, value }
      })
  })
}

function historyDiagnostics(runtime: Context, archiveFallbacks: number): JournalHistoryDiagnostics {
  if (!existsSync(runtime.path)) {
    return {
      pageCount: 0,
      freelistCount: 0,
      autoVacuum: "incremental",
      historyFrames: 0,
      tailFrames: 0,
      evictedThrough: 0,
      archiveFallbacks,
    }
  }
  using database = openReadOnly(runtime.path)
  return readTransaction(database, () => {
    assertComplete(database, runtime.path)
    assertJournalFacts(database)
    const scalar = (sql: string, field: string): number => {
      // Bun caches Database.query() statements. Large freelists can leave a
      // cached PRAGMA statement busy at connection disposal, so diagnostics
      // prepares and finalizes these one-shot scalar reads explicitly.
      const statement = database.prepare<Record<string, number>, []>(sql)
      try {
        return statement.get()?.[field] ?? 0
      } finally {
        statement.finalize()
      }
    }
    const pageCount = scalar("PRAGMA page_count", "page_count")
    const freelistCount = scalar("PRAGMA freelist_count", "freelist_count")
    const autoVacuumValue = scalar("PRAGMA auto_vacuum", "auto_vacuum")
    const autoVacuum = autoVacuumValue === 2 ? "incremental" : autoVacuumValue === 1 ? "full" : "none"
    const historyFrames = scalar("SELECT COUNT(*) AS count FROM journal_history", "count")
    const tailFrames = scalar("SELECT COUNT(*) AS count FROM journal_events", "count")
    const evictedThrough = readEvictedThrough(database)
    return { pageCount, freelistCount, autoVacuum, historyFrames, tailFrames, evictedThrough, archiveFallbacks }
  })
}

function assertJournalFacts(database: Database): void {
  const frames = database
    .query<StoredEvent, []>(
      `SELECT cursor, value_json, sha256 FROM journal_history
       UNION ALL
       SELECT cursor, value_json, sha256 FROM journal_events
       ORDER BY cursor`,
    )
    .all()
  const commands = database
    .query<
      { cursor: number; command_id: string; command_key: string | null; command_hash: string; cause_id: string },
      []
    >("SELECT cursor, command_id, command_key, command_hash, cause_id FROM journal_commands ORDER BY cursor")
    .all()
  const events = database
    .query<{ event_id: string; cursor: number; event_index: number }, []>(
      "SELECT event_id, cursor, event_index FROM journal_event_ids ORDER BY cursor, event_index",
    )
    .all()
  const entities = database
    .query<{ kind: JournalEntityKind; id: string; cursor: number }, []>(
      "SELECT kind, id, cursor FROM journal_entities ORDER BY kind, id, cursor",
    )
    .all()
  const expectedCommands: typeof commands = []
  const expectedEvents: typeof events = []
  const expectedEntities: typeof entities = []
  for (const row of frames) {
    const frame = decodeStoredEvent(row).value as JournalFrame
    expectedCommands.push({
      cursor: row.cursor,
      command_id: frame.command.id,
      command_key: frame.cause.key ?? null,
      command_hash: frame.cause.commandHash,
      cause_id: frame.cause.id,
    })
    for (const [event_index, applied] of frame.events.entries()) {
      expectedEvents.push({ event_id: applied.id, cursor: row.cursor, event_index })
    }
    for (const [kind, id] of frameEntities(frame)) expectedEntities.push({ kind, id, cursor: row.cursor })
  }
  expectedEntities.sort(
    (left, right) =>
      Buffer.compare(Buffer.from(left.kind), Buffer.from(right.kind)) ||
      Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)) ||
      left.cursor - right.cursor,
  )
  if (JSON.stringify(commands) !== JSON.stringify(expectedCommands)) {
    throw new Error("yrd: journal command lookup index does not equal immutable frame facts")
  }
  if (JSON.stringify(events) !== JSON.stringify(expectedEvents)) {
    throw new Error("yrd: journal event lookup index does not equal immutable frame facts")
  }
  if (JSON.stringify(entities) !== JSON.stringify(expectedEntities)) {
    throw new Error("yrd: journal entity lookup index does not equal immutable frame facts")
  }
}

function readEvictedThrough(database: Database): number {
  const row = database
    .query<{ value: string }, [string]>("SELECT value FROM journal_metadata WHERE key = ?")
    .get(HISTORY_EVICTED_THROUGH)
  if (row === null) return 0
  const value = Number(row.value)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`yrd: journal retention floor '${row.value}' is invalid`)
  }
  return value
}

/**
 * The lowest cursor history keeps. Frames below it are already folded into the
 * checkpoint, so they are audit trail rather than state — but only whole
 * entities may go, because `history.entity()` rehydrates archived jobs and runs
 * from their frame slice and a half-evicted slice projects a wrong answer
 * without ever looking empty.
 */
function retentionFloor(
  database: Database,
  snapshotCursor: number,
  retention: Readonly<{ keepFrames: number; keepDays?: number }>,
): number {
  const byCount = snapshotCursor - retention.keepFrames + 1
  const byAge = retention.keepDays === undefined ? 1 : ageFloor(database, retention.keepDays, snapshotCursor)
  const requested = Math.min(snapshotCursor, Math.max(1, byCount, byAge))
  return entityAtomicFloor(database, requested)
}

function ageFloor(database: Database, keepDays: number, snapshotCursor: number): number {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString()
  const timestamped = database
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM journal_history WHERE json_extract(value_json, '$.events[0].ts') IS NOT NULL`,
    )
    .get()?.n
  // A journal whose frames carry no event timestamp cannot be judged by age at
  // all — about a third of live frames are command-only, with an empty event
  // list — so the age window simply declines to evict rather than guessing.
  if (timestamped === undefined || timestamped === 0) return 1
  const youngest = database
    .query<{ cursor: number | null }, [string]>(
      `SELECT MIN(cursor) AS cursor FROM journal_history WHERE json_extract(value_json, '$.events[0].ts') >= ?`,
    )
    .get(cutoff)?.cursor
  // Frames are not strictly ordered by wall clock, so the floor is the FIRST
  // frame still inside the age window, not the last one outside it.
  return youngest === null || youngest === undefined ? snapshotCursor : youngest
}

function entityAtomicFloor(database: Database, requested: number): number {
  const spanning = database.query<{ cursor: number | null }, [number]>(
    `SELECT MIN(entity.cursor) AS cursor FROM journal_entities entity
      WHERE EXISTS(
        SELECT 1 FROM journal_entities live
         WHERE live.kind = entity.kind AND live.id = entity.id AND live.cursor >= ?)`,
  )
  let floor = requested
  // Lowering the floor can pull in entities that only just reached above it, so
  // this walks to a fixpoint. Each round strictly lowers the floor, so it ends.
  for (let round = 0; round < 1024; round += 1) {
    const earliest = spanning.get(floor)?.cursor
    if (earliest === null || earliest === undefined || earliest >= floor) return floor
    floor = earliest
  }
  throw new Error(`yrd: journal retention floor did not settle below cursor ${requested}`)
}

function evictHistory(runtime: Context, database: Database, snapshotCursor: number): EvictionOutcome | undefined {
  if (runtime.retention === "disabled" || snapshotCursor <= 1) return undefined
  const evictedThrough = readEvictedThrough(database)
  const floor = retentionFloor(database, snapshotCursor, runtime.retention)
  if (floor <= evictedThrough + 1) return undefined
  const frames = database.query("DELETE FROM journal_history WHERE cursor < ?").run(floor).changes
  const facts =
    database.query("DELETE FROM journal_commands WHERE cursor < ?").run(floor).changes +
    database.query("DELETE FROM journal_event_ids WHERE cursor < ?").run(floor).changes +
    database.query("DELETE FROM journal_entities WHERE cursor < ?").run(floor).changes
  writeMetadata(database, HISTORY_EVICTED_THROUGH, String(floor - 1))
  return { frames, facts, evictedThrough: floor - 1, floor }
}

function reportEviction(runtime: Context, outcome: EvictionOutcome): void {
  const window = runtime.retention === "disabled" ? {} : runtime.retention
  runtime.log.info?.("Trimmed Yrd's saved history to its retention window.", {
    action: "history-evicted",
    path: runtime.path,
    frames: outcome.frames,
    facts: outcome.facts,
    evictedThrough: outcome.evictedThrough,
    historyFloor: outcome.floor,
    ...window,
  })
}

function incrementalVacuum(runtime: Context, database: Database): void {
  try {
    database.run("PRAGMA incremental_vacuum(256)")
  } catch (error) {
    runtime.log.warn?.("Saved state, but could not reclaim old storage yet; Yrd will retry later.", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function readTransaction<Result>(database: Database, operation: () => Result): Result {
  try {
    database.run("BEGIN")
    const result = operation()
    database.run("COMMIT")
    return result
  } catch (error) {
    rollback(database)
    rethrowSqliteBusy(error)
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
      runtime.log.debug?.("Another Yrd command is still reading; storage cleanup will retry later.", details)
    } else {
      const truncated = database
        .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
        .get()
      if (truncated === null) throw new Error("SQLite returned no WAL truncation result")
      if (truncated.busy > 0 || truncated.log !== 0 || truncated.checkpointed !== 0) {
        runtime.log.debug?.("Another Yrd command is still reading; storage cleanup will retry later.")
      } else {
        runtime.log.debug?.("Finished storage cleanup.", { action: "checkpointed", ...details })
      }
    }
  } catch (error) {
    // A reader may pin the WAL. The acknowledged transaction remains durable;
    // a later writer close retries the maintenance checkpoint under the lock.
    runtime.log.warn?.("Could not finish storage cleanup; saved work is safe and Yrd will retry later.", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function rollback(database: Database): void {
  try {
    database.run("ROLLBACK")
  } catch {
    // silent-fallback-allow: rollback cleanup must not replace the original transaction failure.
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
    runtime.log.warn?.("Ignored an incomplete old state record while upgrading; saved work is unchanged.")
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
      throw new Error(`yrd: saved state is missing at ${runtime.path}; stopped to avoid restoring outdated data`)
    }
    const candidate = join(runtime.dir, marker.candidate)
    if (!(await exists(candidate))) {
      throw new Error(
        `yrd: interrupted state upgrade is missing ${candidate}; stopped to avoid restoring outdated data`,
      )
    }
    using database = openReadOnly(candidate)
    const { snapshot } = assertComplete(database, candidate)
    readVerifiedPrefix(database, snapshot)
    if (readMetadata(database, "source_fingerprint") !== marker.fingerprint) {
      throw new Error(`yrd: interrupted state upgrade changed at ${candidate}; stopped to avoid using it`)
    }
    database.close()
    await rename(candidate, runtime.path)
    await syncDirectory(runtime.dir)
    await writeSqliteCutoverMarker(runtime, marker, "published")
    runtime.log.info?.("Finished an interrupted Yrd state upgrade.")
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
    views?: readonly JournalView[]
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
    ...(options.views === undefined ? {} : { views: options.views }),
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
      writeMetadata(database, "facts_head", String(cursor))
      setJournalViewsCursor(database, runtime.views, cursor)
      database.run("COMMIT")
      return { status: "imported" as const, cursor, records: records.length, sourceSha256 }
    } catch (error) {
      rollback(database)
      throw error
    }
  })
}

function allLiveFrames(database: Database): readonly unknown[] {
  return [
    ...database
      .query<StoredEvent, []>("SELECT cursor, value_json, sha256 FROM journal_history ORDER BY cursor")
      .all()
      .map(decodeStoredEvent)
      .map((entry) => entry.value),
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
