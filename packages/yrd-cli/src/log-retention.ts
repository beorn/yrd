import {
  appendFileSync,
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  utimesSync,
  type BigIntStats,
  type Stats,
} from "node:fs"
import { createHash } from "node:crypto"
import { basename, dirname, join, relative, sep } from "node:path"
import { Transform, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip, createGzip } from "node:zlib"
import { pidPresence } from "@yrd/process"
import { readJournalLine, readJournalProjection, readJournals, runStartedAt } from "@yrd/queue-core"
import { environmentDirectoryStartedAt, environmentStampUnreadable } from "./env-commands.ts"
import { safeRemove } from "removely"

/**
 * Round-output retention (28499; @cto ruling 2026-10-10T02:50Z).
 *
 * A round writes two things. Its JOURNAL — `logs/q-<utc>-<id>.jsonl` — is the
 * append-only record (`yrd runs <n>`, the "why not merged" explainer, 22955's
 * "every shape ever written stays readable") and is KEPT. Its RAW OUTPUT — the
 * `logs/q-<utc>-<id>/` that holds the round's git stdout/stderr and trace2, the
 * locally-run `logs/check/q-<utc>-<id>/`, `logs/environments/<name>/<runId>/`,
 * and the separate `checks/<…>/q-<utc>-<id>/` tree — is read only on demand
 * (the run/check output panel), and its absence is already a NAMED degradation
 * there, so it is retained for a window and then removed. Pruning raw output
 * never makes a journal unreadable: the bytes are evidence the journal POINTS
 * AT, not the journal.
 *
 * Selection is by NAME, never by walking or statting a round's contents: a
 * round directory is named by `runStartedAt`'s `q-<utc>-<id>`, so the instant
 * is IN the name and one `readdir` per directory answers "which rounds are
 * older than the window" without opening a single file. Removal goes through
 * removely's guarded `safeRemove`, whose `within` root is the tree the entry
 * was found under — a delete that cannot name the root it may touch does not
 * compile.
 *
 * What is KEPT is gzip-compressed in place by the same round sweep (34923,
 * @cto plan r1 items 3-5): raw output of a FINISHED round older than a day
 * (`*.stdout.bin`, `*.stderr.bin`, check logs `<name>.log`) and run journals
 * `logs/q-*.jsonl` older than the window become `<file>.gz`, which every reader
 * resolves only when the plain file is absent (queue-core `readRetainedFile`).
 * Metadata (`*.json`), projections, trace2, sub-block files, environment trees
 * and anything unknown stay plain. Raw output still expires by its ROUND NAME,
 * so a fresh archive never extends the window; journals never expire. A round
 * is compressed only on proof it finished — its published projection, or a
 * header whose writer pid is gone — and each file only after a verified archive
 * is durably installed beside it ({@link compressRetainedOutput}).
 */

/** Seven days: the round-output window @cto ruled (28499). Journals are never windowed by this. */
export const ROUND_OUTPUT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How many round-output directories are removed per batch, oldest first. Two
 * callers drain through it, and neither removes at once: the queue round's own
 * bounded sweep (`sweepRoundOutputInRound`) removes ONE batch per round, so a
 * queue that keeps running drains the backlog with no operator; the explicit
 * `yrd logs prune` verb selects the whole oldest-first list ONCE and deletes it
 * in batches of this size, so draining thousands never re-walks the tree between
 * batches. Each batch stays a bounded recursive delete, far under the 27723 bar
 * (30 s, 400 spawns).
 */
export const ROUND_REMOVAL_BATCH = 8

/** Raw output of a finished round is compressed once its round NAME is older than a day (34923). */
export const ROUND_OUTPUT_COMPRESS_AFTER_MS = 24 * 60 * 60 * 1000

/** A run journal is compressed once its round NAME is older than the window; it is never removed. */
export const JOURNAL_COMPRESS_AFTER_MS = ROUND_OUTPUT_WINDOW_MS

/**
 * Source bytes one round's sweep streams through gzip (34923 ruling 4). Measured
 * on the live hh-dev queue 2026-11-18: a round leaves ~12.3 MiB of unique raw
 * output in files of a block or more (40 rounds: 491 MB over 1,010 inodes) and
 * ~600 rounds run a day, so 64 MiB is ~5x what one round adds and drains the
 * 1-7 day backlog in about a day. gzip (level 6) streamed 129 MB/s there, so
 * the bound costs well under a second of zlib's thread pool per round; one file
 * larger than the whole bound is taken alone, so it is never starved.
 */
export const ROUND_COMPRESSION_BYTES = 64 * 1024 * 1024

/**
 * Files one round's sweep converts (34923 ruling 4). A round holds ~56 class
 * files of a block or more (2,224 in 40 measured rounds); each conversion costs
 * two fsyncs, a link and a removely removal, so 256 is ~4x one round's output.
 */
export const ROUND_COMPRESSION_FILES = 256

/**
 * Candidates — round directories or journals — one round's sweep examines
 * (34923 ruling 4). Examining a round lists and lstats its ~1,400 entries
 * (measured), which costs milliseconds; this bounds the walk when a restarted
 * service re-examines rounds it already finished.
 */
export const ROUND_COMPRESSION_UNITS = 64

/**
 * Below one filesystem block (4 KiB) a gzip copy frees nothing, so the file stays
 * plain. Measured: 35,274 of 37,498 raw output files are under it (26,727 empty),
 * holding 1.5 MB of 1 GB.
 */
const COMPRESS_MIN_BYTES = 4096

/** Raw output a reader resolves through `readRetainedFile`: git output, and check logs (`checkLogPath`). */
const COMPRESSIBLE_OUTPUT = /\.(?:stdout|stderr)\.bin$|\.log$/u

/** The sweep's own temporary archive: `<file>.gz.tmp-<pid>`. No other name is ever removed as a leftover. */
const SWEEP_TEMP = /\.gz\.tmp-(\d+)$/u

/** How deep a round directory is walked for output: `checks/<change>/<run>/attempt-N/<phase>/<name>.log` is 3. */
const ROUND_WALK_DEPTH = 4

/**
 * How deep a log root is searched for round directories. The shapes are
 * `logs/q-…/` (1), `logs/check/q-…/` and `logs/environments/<name>/<runId>/`
 * (2), `checks/<group>/<topic>@<head>/q-…/` (3) and
 * `checks/<group>/<n>/<topic>@<head>/q-…/` (4). A directory whose OWN name is a
 * round id is a LEAF of this search — descending into it would walk exactly the
 * millions of files this selection exists to avoid.
 */
const MAX_WALK_DEPTH = 4

/** One round-output directory older than the window, with the containment root removely must be given. */
export type ExpiredRoundOutput = Readonly<{ path: string; name: string; within: string; started: Date }>

/**
 * A root the sweep looks under. `optional` marks a tree a host may legitimately
 * not have yet (a host that has never run a check has no `checks/`), so its
 * absence is reported as a NAMED absence. Every other root is REQUIRED and its
 * absence is a loud failure — never a healthy zero, which is the defect
 * @dev/4's F2 named (28499).
 */
export type RetentionRoot = string | Readonly<{ path: string; optional?: boolean }>

/** What one scan saw: the expired entries, and any OPTIONAL roots that were not on disk (named, never silent). */
export type RetentionScan = Readonly<{
  entries: readonly ExpiredRoundOutput[]
  missing: readonly string[]
  /** Directories whose names did not yield a start instant, so they were not selected and not descended into. */
  unreadable: readonly string[]
  /**
   * Stamped environment directories past the window that still hold a round inside it.
   * Named and not removed; the younger round stays.
   */
  withheld: readonly string[]
  /** What the compression pass may act on, when the scan was asked for it ({@link CompressionSelection}). */
  compressible?: CompressionCandidates
}>

/**
 * Ask a scan to ALSO collect what the compression pass may act on, from the
 * same listing: round directories whose name is older than `roundAfterMs` and
 * still inside the window, and the run journals directly in `journalRoot`
 * older than `journalAfterMs`. Selection only; proof comes later.
 */
export type CompressionSelection = Readonly<{ journalRoot: string; roundAfterMs: number; journalAfterMs: number }>

/** One thing the compression pass may act on: a run journal, its own leftover temp, or a round directory. */
export type CompressionCandidate = Readonly<{
  kind: "journal" | "temp" | "round"
  path: string
  /** The run id the name carries. */
  run: string
  within: string
  started: Date
  /** What the listing says the entry is: only a regular file (journal) or real directory (round) is converted. */
  entry: "file" | "directory" | "symlink" | "other"
}>

export type CompressionCandidates = Readonly<{
  candidates: readonly CompressionCandidate[]
  /** The newest run journal in `journalRoot`, plain or gzip: the live round's, never compressed. */
  newestJournal?: string
}>

/** A candidate the compression pass left untouched, and why — named, never silent. */
export type CompressionSkip = Readonly<{ path: string; reason: string }>

/**
 * What one compression pass did (34923): files converted, the bytes streamed
 * through gzip and written, candidates left for a later round by the bound,
 * candidates it would not touch and why, and failures. Both lists are bounded
 * like the removal row; the omitted counts keep the rest visible.
 */
export type RetentionCompression = Readonly<{
  compressed: number
  bytesIn: number
  bytesOut: number
  deferred: number
  skipped: readonly CompressionSkip[]
  skippedOmitted: number
  failures: readonly RetentionFailure[]
  failuresOmitted: number
}>

/** One round-output directory a sweep could not remove, with the error it raised. */
export type RetentionFailure = Readonly<{ path: string; name: string; error: string }>

/**
 * What one pass of the sweep did: the window, what it removed, what it could
 * NOT remove and why, what is STILL older than it, and optional roots not seen.
 * A failure is a RESULT, not an exception (@cto 2026-10-10T23:16Z): a disposal
 * step must never stop the merge line, so one unremovable directory is reported
 * and skipped, never thrown past the round.
 */
export type RetentionResult = Readonly<{
  windowMs: number
  removed: readonly ExpiredRoundOutput[]
  failures: readonly RetentionFailure[]
  /**
   * Failures past the bounded `failures` row (28836): the row names the oldest `limit` and this counts the rest, so
   * a long stuck prefix can never grow the observation row while the omitted work stays visible.
   */
  failuresOmitted: number
  remaining: readonly ExpiredRoundOutput[]
  missing: readonly string[]
  /** The round sweep's compression pass (34923); absent where none ran (`yrd logs prune` only removes). */
  compression?: RetentionCompression
}>

/**
 * A `yrd logs prune` drain: the usual result, plus the list the run SELECTED
 * (everything older than the window) and the oldest `limit` of it it PLANNED to
 * remove. The verb reports both, so it never re-derives them from the scan.
 */
export type RetentionDrain = RetentionResult &
  Readonly<{
    selected: readonly ExpiredRoundOutput[]
    planned: readonly ExpiredRoundOutput[]
    unreadable: readonly string[]
    withheld: readonly string[]
    compressible?: CompressionCandidates
  }>

function rootOf(root: RetentionRoot): Readonly<{ path: string; optional: boolean }> {
  return typeof root === "string"
    ? { path: root, optional: false }
    : { path: root.path, optional: root.optional === true }
}

/** Every round-output directory under `roots` whose own name is a round older than the window, oldest first. */
export function expiredRoundOutput(
  input: Readonly<{ roots: readonly RetentionRoot[]; now: Date; windowMs?: number; compress?: CompressionSelection }>,
): RetentionScan {
  const windowMs = input.windowMs ?? ROUND_OUTPUT_WINDOW_MS
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new Error(`log retention window must be a non-negative number of ms, got ${String(windowMs)}`)
  }
  const cutoff = input.now.getTime() - windowMs
  const found: ExpiredRoundOutput[] = []
  const missing: string[] = []
  const unreadable: string[] = []
  const withheld: string[] = []
  const compress = input.compress
  const roundCutoff = compress === undefined ? 0 : input.now.getTime() - compress.roundAfterMs
  const journalCutoff = compress === undefined ? 0 : input.now.getTime() - compress.journalAfterMs
  const candidates: CompressionCandidate[] = []
  let newestJournal: string | undefined
  for (const root of input.roots) {
    const { path: within, optional } = rootOf(root)
    const stack: { directory: string; depth: number }[] = [{ directory: within, depth: 0 }]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) break
      let entries
      try {
        entries = readdirSync(current.directory, { withFileTypes: true })
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          // NEVER a silent healthy zero (28499 F2). A root the caller DECLARED
          // optional is a NAMED absence; a REQUIRED root that is missing fails
          // loudly, naming the path it queried. A directory that vanished at a
          // deeper level is a race with the writer, not a root, and there is
          // nothing left under it to prune.
          if (current.depth === 0) {
            if (optional) missing.push(current.directory)
            else throw new Error(`log retention: required root ${current.directory} does not exist`)
          }
          continue
        }
        throw new Error(`log retention cannot read ${current.directory}: ${String(cause)}`, { cause })
      }
      // Where a round directory may be a compression candidate: under the journal root only a queue round
      // (`logs/<run>`) or a local check run (`logs/check/<run>`) — never an environment tree or the
      // housekeeping journals, whose output stays plain — and anywhere under another root (`checks/`).
      const roundPlace =
        compress !== undefined &&
        (within !== compress.journalRoot || current.directory === within || current.directory === join(within, "check"))
      for (const entry of entries) {
        if (compress !== undefined && !entry.isDirectory()) {
          // The run journals, and the sweep's own leftover temps of them, sit directly in the journal root.
          const named = current.directory === compress.journalRoot ? journalName(entry.name) : undefined
          if (named !== undefined) {
            const started = runStartedAt(named.run)
            if (started !== undefined) {
              if (named.kind !== "temp" && (newestJournal === undefined || named.run > newestJournal)) {
                newestJournal = named.run
              }
              if (named.kind !== "archive" && started.getTime() <= journalCutoff) {
                candidates.push({
                  kind: named.kind,
                  path: join(current.directory, entry.name),
                  run: named.run,
                  within,
                  started,
                  entry: entryKind(entry),
                })
              }
            }
          } else if (roundPlace && entry.isSymbolicLink() && /^q-[^.]*$/u.test(entry.name)) {
            // A symlink named like a round in the compression range is named, never followed.
            const started = runStartedAt(entry.name)
            if (started !== undefined && started.getTime() > cutoff && started.getTime() <= roundCutoff) {
              const path = join(current.directory, entry.name)
              candidates.push({ kind: "round", path, run: entry.name, within, started, entry: "symlink" })
            }
          }
        }
        // A symlink is neither followed nor removed: only a real directory may be a target.
        if (!entry.isDirectory()) continue
        const path = join(current.directory, entry.name)
        if (basename(current.directory) === "environments") {
          const envStarted = environmentDirectoryStartedAt(entry.name)
          if (envStarted !== undefined) {
            const holdsYoungRound = roundInstants(path).some((started) => started.getTime() > cutoff)
            if (holdsYoungRound) {
              if (envStarted.getTime() <= cutoff) withheld.push(path)
              if (current.depth < MAX_WALK_DEPTH) stack.push({ directory: path, depth: current.depth + 1 })
              continue
            }
            if (envStarted.getTime() <= cutoff) found.push({ path, name: entry.name, within, started: envStarted })
            continue
          }
          if (environmentStampUnreadable(entry.name)) {
            unreadable.push(path)
            continue
          }
          // The live container is `<env>`, not `<env>-q-<utc>-<id>`. Select it only when it is empty
          // and its own mtime is past the window. Any entry keeps the container; the walk below
          // prunes a stale round child on its own. Nested writes do not move this mtime.
          const containerStarted = directoryMtime(path)
          let contained: string[]
          try {
            contained = readdirSync(path)
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue
            throw new Error(`log retention cannot read ${path}: ${String(cause)}`, { cause })
          }
          if (contained.length === 0 && containerStarted !== undefined && containerStarted.getTime() <= cutoff) {
            found.push({ path, name: entry.name, within, started: containerStarted })
            continue
          }
        }
        const started = runStartedAt(entry.name)
        if (started !== undefined) {
          if (started.getTime() <= cutoff) found.push({ path, name: entry.name, within, started })
          else if (roundPlace && started.getTime() <= roundCutoff) {
            candidates.push({ kind: "round", path, run: entry.name, within, started, entry: "directory" })
          }
          continue
        }
        // A name that claims a run id (`q-` then a digit) but does not parse is named and not descended into.
        // Anchored at the start, so a bay or topic that merely contains `-q-` is still entered.
        if (/^q-\d/u.test(entry.name)) {
          unreadable.push(path)
          continue
        }
        if (current.depth < MAX_WALK_DEPTH) stack.push({ directory: path, depth: current.depth + 1 })
      }
    }
  }
  found.sort((left, right) => left.started.getTime() - right.started.getTime() || left.name.localeCompare(right.name))
  unreadable.sort((left, right) => left.localeCompare(right))
  withheld.sort((left, right) => left.localeCompare(right))
  candidates.sort(
    (left, right) => left.started.getTime() - right.started.getTime() || left.path.localeCompare(right.path),
  )
  return {
    entries: found,
    missing,
    unreadable,
    withheld,
    ...(compress === undefined
      ? {}
      : { compressible: { candidates, ...(newestJournal === undefined ? {} : { newestJournal }) } }),
  }
}

/** A journal-root name: a plain run journal, its gzip archive, or the sweep's own temp of one. */
function journalName(name: string): Readonly<{ kind: "journal" | "archive" | "temp"; run: string }> | undefined {
  if (name.endsWith(".jsonl")) return { kind: "journal", run: name.slice(0, -".jsonl".length) }
  if (name.endsWith(".jsonl.gz")) return { kind: "archive", run: name.slice(0, -".jsonl.gz".length) }
  const temp = /^(.*)\.jsonl\.gz\.tmp-\d+$/u.exec(name)
  return temp?.[1] === undefined ? undefined : { kind: "temp", run: temp[1] }
}

function entryKind(entry: Readonly<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>) {
  if (entry.isSymbolicLink()) return "symlink" as const
  if (entry.isFile()) return "file" as const
  if (entry.isDirectory()) return "directory" as const
  return "other" as const
}

/** The directory's own mtime. A name with no round stamp has no other age. A vanished directory has none. */
function directoryMtime(path: string): Date | undefined {
  try {
    return statSync(path).mtime
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error(`log retention cannot read ${path}: ${String(cause)}`, { cause })
  }
}

/** Start instants of round directories directly inside `directory`. Names only; a vanished directory has none. */
function roundInstants(directory: string): Date[] {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new Error(`log retention cannot read ${directory}: ${String(cause)}`, { cause })
  }
  const instants: Date[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const started = runStartedAt(entry.name)
    if (started !== undefined) instants.push(started)
  }
  return instants
}

/** Remove a chosen list of round-output directories, oldest first, at most `limit` of them, through removely. */
export async function removeExpiredRoundOutput(
  input: Readonly<{ selected: readonly ExpiredRoundOutput[]; limit?: number; dryRun?: boolean }>,
): Promise<
  Readonly<{
    removed: readonly ExpiredRoundOutput[]
    failures: readonly RetentionFailure[]
    remaining: readonly ExpiredRoundOutput[]
  }>
> {
  const limit = input.limit ?? input.selected.length
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`log retention batch must be a non-negative integer, got ${String(input.limit)}`)
  }
  const chosen = input.selected.slice(0, limit)
  const removed: ExpiredRoundOutput[] = []
  const failures: RetentionFailure[] = []
  if (input.dryRun !== true) {
    for (const entry of chosen) {
      // The containment root is the tree the entry was FOUND under: a removal
      // that cannot name it does not compile, and removely refuses a target
      // outside it. `allowedRoots` must ALSO name that tree: removely's default
      // is [tmpdir()], and it REPLACES that default rather than adding to it, so
      // without this a real queue root — /hh/var/yrd-workdir/… — is refused
      // ("containment root … is not under an allowed root"), which is exactly the
      // tree this sweep exists to prune.
      try {
        await safeRemove(entry.path, { within: entry.within, allowedRoots: [entry.within] })
        removed.push(entry)
      } catch (cause) {
        // The batch CONTINUES past a directory it cannot remove (@cto
        // 2026-10-10T23:16Z): the failure is a result. It stays in `remaining`
        // and is reported, so one unremovable directory never blocks the drain
        // of the ones behind it, and the next round retries it.
        failures.push({
          path: entry.path,
          name: entry.name,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }
  }
  // `remaining` is everything still older than the window that this pass did NOT
  // remove — failed entries included and in oldest-first order. It is computed
  // from the removed SET, not a prefix length: with a failure in the middle, the
  // older `slice(removed.length)` would have dropped entries still on disk.
  const removedPaths = new Set(removed.map((entry) => entry.path))
  return { removed, failures, remaining: input.selected.filter((entry) => !removedPaths.has(entry.path)) }
}

/**
 * Select expired round output under `roots`, then remove at most `limit` of it
 * (oldest first) through removely — the ONE composition `yrd logs prune` runs,
 * and the interface its tests drive. The list is selected ONCE and removed in
 * batches of `ROUND_REMOVAL_BATCH`, so a drain of thousands never re-walks the
 * tree between batches. `dryRun` selects and reports but removes nothing.
 * `compress` also returns, from the same walk, what the round sweep's
 * compression pass may act on; this function itself never compresses.
 */
export async function pruneRoundOutput(
  input: Readonly<{
    roots: readonly RetentionRoot[]
    now: Date
    windowMs?: number
    limit?: number
    dryRun?: boolean
    compress?: CompressionSelection
  }>,
): Promise<RetentionDrain> {
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 0)) {
    throw new Error(`log retention batch must be a non-negative integer, got ${String(input.limit)}`)
  }
  const windowMs = input.windowMs ?? ROUND_OUTPUT_WINDOW_MS
  const scan = expiredRoundOutput({
    roots: input.roots,
    now: input.now,
    windowMs,
    ...(input.compress === undefined ? {} : { compress: input.compress }),
  })
  const selected = scan.entries
  const planned = input.limit === undefined ? selected : selected.slice(0, input.limit)
  // 28836: the budget counts successful REMOVALS, not attempts. Walk `selected` oldest-first and pass over a
  // failure, so a directory that will not remove can never fill the prefix and starve the entries behind it.
  const budget = input.limit ?? selected.length
  const removed: ExpiredRoundOutput[] = []
  const attemptedFailures: RetentionFailure[] = []
  if (input.dryRun !== true) {
    let index = 0
    while (index < selected.length && removed.length < budget) {
      const take = Math.min(ROUND_REMOVAL_BATCH, budget - removed.length, selected.length - index)
      if (take <= 0) break
      const batch = await removeExpiredRoundOutput({ selected: selected.slice(index, index + take) })
      removed.push(...batch.removed)
      attemptedFailures.push(...batch.failures)
      index += take
    }
  }
  // Bound the failure row (@cto 2bfbca04): name the oldest `budget` failures and count the rest.
  const failures = attemptedFailures.slice(0, budget)
  const failuresOmitted = attemptedFailures.length - failures.length
  const removedPaths = new Set(removed.map((entry) => entry.path))
  return {
    windowMs,
    selected,
    planned,
    removed,
    failures,
    failuresOmitted,
    remaining: selected.filter((entry) => !removedPaths.has(entry.path)),
    missing: scan.missing,
    unreadable: scan.unreadable,
    withheld: scan.withheld,
    ...(scan.compressible === undefined ? {} : { compressible: scan.compressible }),
  }
}

/** Everything one compression pass has done so far. Every step adds to it; nothing throws past it. */
type CompressionPass = {
  /** Source bytes streamed through gzip or a verification read: the byte bound. */
  bytes: number
  /** Conversions attempted: the file bound. */
  files: number
  /** Candidates examined: the examination bound. */
  units: number
  compressed: number
  bytesIn: number
  bytesOut: number
  deferred: number
  skipped: CompressionSkip[]
  failures: RetentionFailure[]
}

/** How one file ended in a pass: converted, left as it is (by rule, already archived, or named), deferred, or failed. */
type FileOutcome = "converted" | "left" | "deferred" | "failed"

/**
 * A hard-linked inode's archive, verified and installed earlier in the same
 * round directory. A round links identical git output to one inode (33388), so
 * the inode's other names link to this archive instead of compressing it again.
 */
type InstalledArchive = Readonly<{ archive: string; size: bigint; mtimeNs: bigint }>

type Digest = Readonly<{ length: number; sha256: string }>

/** A round's journal header is read from its first record only; one longer than this is unproven. */
const HEADER_READ_BYTES = 64 * 1024

const NO_COMPRESSION: RetentionCompression = {
  compressed: 0,
  bytesIn: 0,
  bytesOut: 0,
  deferred: 0,
  skipped: [],
  skippedOmitted: 0,
  failures: [],
  failuresOmitted: 0,
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function skip(pass: CompressionPass, path: string, reason: string): void {
  pass.skipped.push({ path, reason })
}

function fail(pass: CompressionPass, path: string, error: string): void {
  pass.failures.push({ path, name: basename(path), error })
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw cause
  }
}

/** Flush a file's or directory's own entry to disk; a rename or link is durable only once its directory is. */
function fsyncPath(path: string): void {
  const fd = openSync(path, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Stream `plain` through gzip into a new `temp`, hashing what was read. Never holds the file in memory. */
async function gzipInto(plain: string, temp: string): Promise<Digest> {
  const hash = createHash("sha256")
  let length = 0
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk)
      length += chunk.length
      done(null, chunk)
    },
  })
  await pipeline(createReadStream(plain), tap, createGzip(), createWriteStream(temp, { flags: "wx", mode: 0o600 }))
  return { length, sha256: hash.digest("hex") }
}

/** Length and hash of a file's bytes — decoded first when `gzipped` — streamed, never buffered whole. */
async function digestOf(path: string, gzipped: boolean): Promise<Digest> {
  const hash = createHash("sha256")
  let length = 0
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      hash.update(chunk)
      length += chunk.length
      done()
    },
  })
  if (gzipped) await pipeline(createReadStream(path), createGunzip(), sink)
  else await pipeline(createReadStream(path), sink)
  return { length, sha256: hash.digest("hex") }
}

/** zlib's own decoding errors (`Z_DATA_ERROR`, `Z_BUF_ERROR`, …): the bytes are not a gzip, never an I/O failure. */
function notGzip(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code
  return typeof code === "string" && code.startsWith("Z_")
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

/** The first record of a plain journal: the header a round writes first (24470). */
function firstRecord(path: string): Readonly<Record<string, unknown> & { kind: string }> | undefined {
  const fd = openSync(path, "r")
  try {
    const buffer = Buffer.alloc(HEADER_READ_BYTES)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, read).toString("utf8")
    const end = text.indexOf("\n")
    if (end === -1 && read === buffer.length) {
      throw new Error(`its first record is longer than ${String(HEADER_READ_BYTES)} bytes`)
    }
    return readJournalLine(end === -1 ? text : text.slice(0, end), 1).value
  } finally {
    closeSync(fd)
  }
}

type FinishedProof = Readonly<{ proven: true; projection: boolean }> | Readonly<{ proven: false; why: string }>

/**
 * Whether round `run`, journaled in `dir`, has FINISHED, from the evidence Yrd
 * already keeps (34923 ruling 3) — age from the name is selection, never this
 * proof. Two facts prove it, in order:
 *
 *   - its projection reads valid: `finish()` publishes it after every
 *     run-owned disposer has finished, and a reader repairs one only for a
 *     round `runTerminalProbe` proved terminal; its source identity matching
 *     the journal also proves nothing appended since;
 *   - otherwise its header names a writer pid that is gone on this host: a
 *     writer that no longer exists can never write again (`runTerminalProbe`'s
 *     "header pid is gone" verdict).
 *
 * Everything else is UNPROVEN and named: no header first, no pid, this
 * process's own pid (it may still be writing), a pid that is present (a
 * recycled pid cannot be told from a writer still finishing), or a header that
 * cannot be read.
 */
function roundFinished(dir: string, run: string): FinishedProof {
  let projection: ReturnType<typeof readJournalProjection>
  try {
    projection = readJournalProjection(dir, run, { detail: "omit" })
  } catch (cause) {
    return { proven: false, why: `its projection in ${dir} could not be read: ${message(cause)}` }
  }
  if (projection.kind === "projection") return { proven: true, projection: true }
  const missing = `no valid projection (${projection.fallback.reason})`
  let header: ReturnType<typeof firstRecord>
  try {
    header = firstRecord(join(dir, `${run}.jsonl`))
  } catch (cause) {
    return { proven: false, why: `${missing} and its journal header could not be read: ${message(cause)}` }
  }
  const pid = header?.kind === "run" ? header.pid : undefined
  if (typeof pid !== "number") {
    return { proven: false, why: `${missing} and its journal names no writer pid to judge it by` }
  }
  if (pid === process.pid) {
    return { proven: false, why: `${missing} and its writer is this process, which may still be writing it` }
  }
  let presence: "present" | "absent"
  try {
    presence = pidPresence(pid)
  } catch (cause) {
    return { proven: false, why: `${missing} and its writer PID ${String(pid)} cannot be judged: ${message(cause)}` }
  }
  if (presence === "present") {
    return {
      proven: false,
      why: `${missing} and its writer PID ${String(pid)} is present, so the round may still be finishing`,
    }
  }
  return { proven: true, projection: false }
}

/**
 * Where a round directory's journal is, by the tree it was found in: `logs/<run>`
 * is a queue round (`logs/<run>.jsonl`), `logs/check/<run>` a local check run
 * (`logs/check/<run>.jsonl`), and `checks/…/<run>` either. Any other place under
 * `logs` — environment trees, whose bays are live writers and whose setup logs
 * env-commands reads plain, and the housekeeping journals — is not a candidate:
 * undefined, kept plain by class.
 */
function roundJournalDir(
  candidate: CompressionCandidate,
  logs: string,
): Readonly<{ dir: string }> | Readonly<{ why: string }> | undefined {
  const parts = relative(candidate.within, candidate.path).split(sep)
  if (candidate.within === logs) {
    if (parts.length === 1) return { dir: logs }
    if (parts.length === 2 && parts[0] === "check") return { dir: join(logs, "check") }
    return undefined
  }
  for (const dir of [logs, join(logs, "check")]) {
    const held = [`${candidate.run}.jsonl`, `${candidate.run}.jsonl.gz`].some(
      (name) => lstatOrUndefined(join(dir, name)) !== undefined,
    )
    if (held) return { dir }
  }
  return { why: `no run journal names round ${candidate.run} in ${logs} or ${join(logs, "check")}` }
}

/** A round directory's output files a reader resolves, and the sweep's own leftover temps, oldest name order. */
function roundOutput(directory: string): Readonly<{ files: readonly string[]; temps: readonly string[] }> {
  const files: string[] = []
  const temps: string[] = []
  const walk = (dir: string, depth: number): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      // trace2 stays plain (34923 slice 1 ruling 2); a symlinked directory is never followed.
      if (entry.isDirectory()) {
        if (entry.name !== "trace2" && depth < ROUND_WALK_DEPTH) walk(path, depth + 1)
        continue
      }
      if (SWEEP_TEMP.test(entry.name)) temps.push(path)
      else if (COMPRESSIBLE_OUTPUT.test(entry.name)) files.push(path)
    }
  }
  walk(directory, 0)
  return { files, temps }
}

/**
 * Remove a temp the sweep left behind (`<file>.gz.tmp-<pid>`) — only its own
 * pattern, and only when its writer is this process or gone. Returns whether
 * nothing more is owed on it.
 */
async function clearLeftoverTemp(temp: string, within: string, pass: CompressionPass): Promise<boolean> {
  const pid = Number(SWEEP_TEMP.exec(temp)?.[1])
  if (pid !== process.pid) {
    let presence: "present" | "absent"
    try {
      presence = pidPresence(pid)
    } catch (cause) {
      skip(pass, temp, `a sweep temp whose writer PID ${String(pid)} cannot be judged: ${message(cause)}; left alone`)
      return true
    }
    if (presence === "present") {
      skip(pass, temp, `a sweep temp of live PID ${String(pid)}; left alone`)
      return true
    }
  }
  try {
    await safeRemove(temp, { within, allowedRoots: [within], allowMissing: true })
    return true
  } catch (cause) {
    fail(pass, temp, `could not remove the sweep's leftover temp: ${message(cause)}`)
    return false
  }
}

/**
 * An interrupted conversion left both `plain` and `archive`. The plain copy goes
 * only when the archive decodes to exactly its bytes and the plain file did not
 * change meanwhile; a corrupt or different archive is named and both are kept —
 * never overwritten without proof.
 */
async function finishInterrupted(
  plain: string,
  archive: string,
  within: string,
  source: BigIntStats,
  pass: CompressionPass,
): Promise<FileOutcome> {
  let held: Digest
  let decoded: Digest
  try {
    held = await digestOf(plain, false)
  } catch (cause) {
    fail(pass, plain, `cannot read it to verify ${archive}: ${message(cause)}`)
    return "failed"
  }
  try {
    decoded = await digestOf(archive, true)
  } catch (cause) {
    if (notGzip(cause)) {
      skip(
        pass,
        plain,
        `${archive} is not a readable gzip (${message(cause)}); the plain copy is kept, the archive not overwritten`,
      )
      return "left"
    }
    fail(pass, plain, `cannot read ${archive} to verify it: ${message(cause)}`)
    return "failed"
  }
  if (held.length !== decoded.length || held.sha256 !== decoded.sha256) {
    skip(pass, plain, `${archive} decodes to different bytes than ${plain}; both kept`)
    return "left"
  }
  try {
    if (!sameFile(source, lstatSync(plain, { bigint: true }))) {
      skip(pass, plain, "it changed while it was verified; both kept")
      return "left"
    }
    const written = lstatSync(archive).size
    fsyncPath(dirname(archive))
    await safeRemove(plain, { within, allowedRoots: [within] })
    pass.compressed++
    pass.bytesIn += held.length
    pass.bytesOut += written
    return "converted"
  } catch (cause) {
    fail(pass, plain, message(cause))
    return "failed"
  }
}

/**
 * Convert one plain file to `<file>.gz` (34923 ruling 3), in this order: stream
 * it through gzip into the sweep's own temp, fsync, decode the temp back and
 * compare length and hash with what was read, re-stat the source to prove it
 * did not change, LINK the temp to the archive name (a link never replaces an
 * archive another writer installed meanwhile, where a rename would), fsync the
 * directory, and only then remove the plain file through removely. Every exit
 * before the archive is installed leaves the plain file as the sole copy; every
 * exit after leaves both, which the next round verifies and finishes.
 */
async function installArchive(
  plain: string,
  archive: string,
  within: string,
  source: BigIntStats,
  twin: InstalledArchive | undefined,
  links: Map<string, InstalledArchive>,
  pass: CompressionPass,
): Promise<FileOutcome> {
  const temp = `${archive}.tmp-${String(process.pid)}`
  const removeTemp = (): Promise<void> => safeRemove(temp, { within, allowedRoots: [within], allowMissing: true })
  try {
    let read = 0
    if (twin !== undefined) {
      linkSync(twin.archive, temp)
    } else {
      const streamed = await gzipInto(plain, temp)
      chmodSync(temp, Number(source.mode) & 0o7777)
      utimesSync(temp, source.atime, source.mtime)
      fsyncPath(temp)
      const decoded = await digestOf(temp, true)
      if (decoded.length !== streamed.length || decoded.sha256 !== streamed.sha256) {
        throw new Error(`the archive written at ${temp} did not decode to the bytes read from ${plain}`)
      }
      read = streamed.length
    }
    if (!sameFile(source, lstatSync(plain, { bigint: true }))) {
      await removeTemp()
      skip(pass, plain, "it changed while it was compressed; the plain file is kept")
      return "left"
    }
    try {
      linkSync(temp, archive)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
      await removeTemp()
      skip(pass, plain, `${archive} appeared while it was compressed; both kept`)
      return "left"
    }
    const written = twin === undefined ? lstatSync(archive).size : 0
    await removeTemp()
    fsyncPath(dirname(archive))
    await safeRemove(plain, { within, allowedRoots: [within] })
    if (source.nlink > 1n) {
      links.set(`${source.dev}:${source.ino}`, { archive, size: source.size, mtimeNs: source.mtimeNs })
    }
    pass.compressed++
    pass.bytesIn += read
    pass.bytesOut += written
    return "converted"
  } catch (cause) {
    let cleanup = ""
    try {
      await removeTemp()
    } catch (cleanupCause) {
      cleanup = `; its temp ${temp} could not be removed: ${message(cleanupCause)}`
    }
    fail(pass, plain, `${message(cause)}${cleanup}`)
    return "failed"
  }
}

/** One file: filter by kind and size, charge the bounds, then finish an interrupted conversion or install a new one. */
async function compressFile(
  plain: string,
  within: string,
  pass: CompressionPass,
  links: Map<string, InstalledArchive>,
): Promise<FileOutcome> {
  const archive = `${plain}.gz`
  let source: BigIntStats
  let held: Stats | undefined
  try {
    source = lstatSync(plain, { bigint: true })
    held = lstatOrUndefined(archive)
  } catch (cause) {
    // Gone since the listing: only its archive, if any, remains, and that is the done state.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "left"
    fail(pass, plain, `cannot stat it or its archive: ${message(cause)}`)
    return "failed"
  }
  if (source.isSymbolicLink()) {
    skip(pass, plain, "a symbolic link; never followed or compressed")
    return "left"
  }
  if (!source.isFile()) {
    skip(pass, plain, "not a regular file; left as it is")
    return "left"
  }
  if (source.size < BigInt(COMPRESS_MIN_BYTES)) return "left"
  if (held !== undefined && !held.isFile()) {
    skip(pass, plain, `${archive} exists and is not a regular file; both kept`)
    return "left"
  }
  const twinOf = held === undefined ? links.get(`${String(source.dev)}:${String(source.ino)}`) : undefined
  const twin =
    twinOf !== undefined && twinOf.size === source.size && twinOf.mtimeNs === source.mtimeNs ? twinOf : undefined
  const cost = twin === undefined ? Number(source.size) : 0
  if (pass.files >= ROUND_COMPRESSION_FILES) return "deferred"
  if (cost > 0 && pass.bytes > 0 && pass.bytes + cost > ROUND_COMPRESSION_BYTES) return "deferred"
  pass.files++
  pass.bytes += cost
  if (held !== undefined) return finishInterrupted(plain, archive, within, source, pass)
  return installArchive(plain, archive, within, source, twin, links, pass)
}

/** Whether a candidate is finished with after this file outcome; a deferral is counted. */
function settledBy(outcome: FileOutcome, pass: CompressionPass): boolean {
  if (outcome === "deferred") {
    pass.deferred++
    return false
  }
  return outcome !== "failed"
}

/** One candidate. Returns whether nothing more is owed on it, so the service need not examine it again. */
async function compressCandidate(
  candidate: CompressionCandidate,
  context: Readonly<{ logs: string; newestJournal?: string; pass: CompressionPass; refresh: string[] }>,
): Promise<boolean> {
  const { pass } = context
  if (candidate.kind === "temp") return clearLeftoverTemp(candidate.path, candidate.within, pass)
  if (candidate.entry === "symlink") {
    skip(pass, candidate.path, "a symbolic link; never followed or compressed")
    return true
  }
  if (candidate.kind === "journal") {
    if (candidate.entry !== "file") {
      skip(pass, candidate.path, "not a regular file; left as it is")
      return true
    }
    if (candidate.run === context.newestJournal) {
      skip(pass, candidate.path, "the newest round journal: the live round's, never compressed")
      return true
    }
    const proof = roundFinished(context.logs, candidate.run)
    if (!proof.proven) {
      skip(pass, candidate.path, `not proven finished: ${proof.why}`)
      return true
    }
    const outcome = await compressFile(candidate.path, candidate.within, pass, new Map())
    if (outcome === "converted" && proof.projection) context.refresh.push(candidate.run)
    return settledBy(outcome, pass)
  }
  if (candidate.entry !== "directory") {
    skip(pass, candidate.path, "not a directory; left as it is")
    return true
  }
  let listing: ReturnType<typeof roundOutput>
  try {
    const journal = roundJournalDir(candidate, context.logs)
    if (journal === undefined) return true
    if ("why" in journal) {
      skip(pass, candidate.path, `not proven finished: ${journal.why}`)
      return true
    }
    if (journal.dir === context.logs && candidate.run === context.newestJournal) {
      skip(pass, candidate.path, "its run is the newest round journal's: the live round's output, never compressed")
      return true
    }
    const proof = roundFinished(journal.dir, candidate.run)
    if (!proof.proven) {
      skip(pass, candidate.path, `not proven finished: ${proof.why}`)
      return true
    }
    listing = roundOutput(candidate.path)
  } catch (cause) {
    fail(pass, candidate.path, `cannot examine the round: ${message(cause)}`)
    return false
  }
  let settled = true
  for (const temp of listing.temps) settled = (await clearLeftoverTemp(temp, candidate.within, pass)) && settled
  const links = new Map<string, InstalledArchive>()
  for (const file of listing.files) {
    const outcome = await compressFile(file, candidate.within, pass, links)
    if (outcome === "deferred") return settledBy(outcome, pass)
    settled = settledBy(outcome, pass) && settled
  }
  return settled
}

/**
 * A converted journal's projection named the plain file's identity, so it now
 * reads source-changed. The sweep PROVED the round finished, so it hands that
 * fact to the reader's own repair (`runTerminal`) once for the whole pass —
 * the projection is metadata readers need, and is retained (ruling 3). A
 * refresh that does not land is named; readers then fall back to the raw
 * journal, which stays readable.
 */
function refreshProjections(logs: string, runs: readonly string[], now: Date, pass: CompressionPass): void {
  const proven = new Set(runs)
  try {
    readJournals(logs, { runIds: runs, now, detail: "omit", runTerminal: (run) => proven.has(run) })
  } catch (cause) {
    fail(pass, logs, `the projections of compressed journals could not be refreshed: ${message(cause)}`)
    return
  }
  for (const run of runs) {
    const archive = join(logs, `${run}.jsonl.gz`)
    try {
      const read = readJournalProjection(logs, run, { detail: "omit" })
      if (read.kind !== "projection") {
        skip(
          pass,
          archive,
          `compressed, but its projection did not refresh (${read.fallback.reason}: ${read.fallback.detail})`,
        )
      }
    } catch (cause) {
      skip(pass, archive, `compressed, but its projection could not be read back: ${message(cause)}`)
    }
  }
}

/**
 * The round sweep's compression pass (34923 rulings 3, 4): examine the
 * candidates oldest first, at most {@link ROUND_COMPRESSION_UNITS} of them, and
 * convert at most {@link ROUND_COMPRESSION_FILES} files and
 * {@link ROUND_COMPRESSION_BYTES} source bytes; what the bounds leave is counted
 * as deferred and a later round continues. `settled` remembers, for the life of
 * the caller (the service), candidates with nothing more owed — finished, kept
 * plain, or named unproven — so a long-running service never re-examines them;
 * a restart examines them afresh. It only ever holds current candidates.
 */
async function compressRetainedOutput(
  input: Readonly<{ logs: string; now: Date; selection: CompressionCandidates; settled: Set<string> }>,
): Promise<RetentionCompression> {
  const pass: CompressionPass = {
    bytes: 0,
    files: 0,
    units: 0,
    compressed: 0,
    bytesIn: 0,
    bytesOut: 0,
    deferred: 0,
    skipped: [],
    failures: [],
  }
  const current = new Set(input.selection.candidates.map((candidate) => candidate.path))
  for (const path of input.settled) if (!current.has(path)) input.settled.delete(path)
  const refresh: string[] = []
  const context = {
    logs: input.logs,
    pass,
    refresh,
    ...(input.selection.newestJournal === undefined ? {} : { newestJournal: input.selection.newestJournal }),
  }
  for (const candidate of input.selection.candidates) {
    if (input.settled.has(candidate.path)) continue
    if (
      pass.units >= ROUND_COMPRESSION_UNITS ||
      pass.files >= ROUND_COMPRESSION_FILES ||
      pass.bytes >= ROUND_COMPRESSION_BYTES
    ) {
      pass.deferred++
      continue
    }
    pass.units++
    if (await compressCandidate(candidate, context)) input.settled.add(candidate.path)
  }
  if (refresh.length > 0) refreshProjections(input.logs, refresh, input.now, pass)
  const skipped = pass.skipped.slice(0, ROUND_REMOVAL_BATCH)
  const failures = pass.failures.slice(0, ROUND_REMOVAL_BATCH)
  return {
    compressed: pass.compressed,
    bytesIn: pass.bytesIn,
    bytesOut: pass.bytesOut,
    deferred: pass.deferred,
    skipped,
    skippedOmitted: pass.skipped.length - skipped.length,
    failures,
    failuresOmitted: pass.failures.length - failures.length,
  }
}

/** Whether a compression pass has anything a reader of the row must see: work done, a candidate named, a failure. */
function compressionWorthNaming(compression: RetentionCompression | undefined): compression is RetentionCompression {
  return (
    compression !== undefined &&
    (compression.compressed > 0 ||
      compression.skipped.length > 0 ||
      compression.skippedOmitted > 0 ||
      compression.failures.length > 0 ||
      compression.failuresOmitted > 0)
  )
}

/**
 * The ONE observation row `yrd logs prune` writes about its sweep (28499
 * ruling): what it removed, how much round output is STILL older than the
 * window, and the oldest such name — so a reader can watch retention fall
 * behind without opening a single round directory. Absent `oldest` means the
 * tree is inside the window.
 *
 * Journaled BESIDE the run journals, in `<workdir>/retention.jsonl` (the one
 * writer, `appendRetentionObservation`, is shared by cli.ts and the round),
 * never inside the log tree: every `logs/*.jsonl` is a run and this row is not
 * one, so a run-journal name on it made the runner's own header read refuse the
 * newest journal.
 */
export function retentionObservation(result: RetentionResult, input: Readonly<{ at: Date }>): Record<string, unknown> {
  const remaining = result.remaining.length
  return {
    kind: "observation",
    at: input.at.toISOString(),
    scope: "log-retention",
    windowDays: Math.round(result.windowMs / (24 * 60 * 60 * 1000)),
    removed: result.removed.length,
    remaining,
    ...(remaining === 0 ? {} : { oldest: result.remaining[0]?.name }),
    // A removal that FAILED is in the row (@cto 2026-10-10T23:16Z): a reader must
    // see the path and the error, never a "removed 3" hiding a fourth that stayed.
    ...(result.failures.length === 0 ? {} : { failures: result.failures }),
    ...(result.failuresOmitted === 0 ? {} : { failuresOmitted: result.failuresOmitted }),
    // An optional root that was not on disk is named in the row: "removed 0"
    // must never be the only fact a reader has about where the sweep looked.
    ...(result.missing.length === 0 ? {} : { missing: result.missing }),
    // The round sweep's compression pass (34923): what it converted, the bytes
    // in and out, what the bound left for a later round, and every candidate it
    // named or failed on — bounded like `failures`.
    ...(compressionWorthNaming(result.compression)
      ? {
          compression: {
            compressed: result.compression.compressed,
            bytesIn: result.compression.bytesIn,
            bytesOut: result.compression.bytesOut,
            deferred: result.compression.deferred,
            ...(result.compression.skipped.length === 0 ? {} : { skipped: result.compression.skipped }),
            ...(result.compression.skippedOmitted === 0 ? {} : { skippedOmitted: result.compression.skippedOmitted }),
            ...(result.compression.failures.length === 0 ? {} : { failures: result.compression.failures }),
            ...(result.compression.failuresOmitted === 0
              ? {}
              : { failuresOmitted: result.compression.failuresOmitted }),
          },
        }
      : {}),
  }
}

/** The one place the human rendering of a prune lives, so it can be asserted without a terminal. */
export function retentionHumanLines(
  result: RetentionResult,
  input: Readonly<{
    roots: readonly string[]
    dryRun: boolean
    listed: readonly ExpiredRoundOutput[]
    unreadable?: readonly string[]
    withheld?: readonly string[]
  }>,
): string[] {
  const days = Math.round(result.windowMs / (24 * 60 * 60 * 1000))
  return [
    `yrd: log retention: ${input.dryRun ? "would remove" : "removed"} ${input.listed.length} round-output directories older than ${days} days; ${result.remaining.length} still older than the window`,
    // An empty result still says WHERE the sweep looked: "nothing" without the
    // roots and the rule is the silent default this whole change refuses.
    `yrd: log retention: searched ${input.roots.join(", ")} (directories named q-<utc>-<id> older than ${days} days; journals kept; this verb never compresses, the queue round's own sweep does)`,
    // A declared-optional root that was not on disk is NAMED here too, so an
    // absent tree is never indistinguishable from a healthy empty scan.
    ...(result.missing.length === 0
      ? []
      : [`yrd: log retention: no such optional root (absent, not an error): ${result.missing.join(", ")}`]),
    ...((input.unreadable?.length ?? 0) === 0
      ? []
      : [`yrd: log retention: start time unreadable, named and not removed: ${input.unreadable?.join(", ")}`]),
    ...((input.withheld?.length ?? 0) === 0
      ? []
      : [`yrd: log retention: holds a round inside the window, named and not removed: ${input.withheld?.join(", ")}`]),
    ...input.listed.map((entry) => entry.path),
  ]
}

/**
 * The one file an observation row is written to, BESIDE the run journals in the
 * workdir — never inside the log tree: every `logs/*.jsonl` is a run and this
 * row is not one, so a run-journal name on it made the runner's own header read
 * refuse the newest journal (watch-runner readRunHeader).
 */
export const RETENTION_JOURNAL = "retention.jsonl"

/**
 * How large `retention.jsonl` may grow before it is rotated. 8 MiB is @cto's
 * number (2026-10-10T23:16Z): a queue round writes at most one row per interval,
 * and a row is ~230 bytes, so at a 120 s interval this holds several years —
 * while a pathological burst still cannot grow the file without bound.
 */
export const RETENTION_JOURNAL_MAX_BYTES = 8 * 1024 * 1024

/** The row a sweep that could not RUN reports: nothing removed, the error named. */
const NOTHING_SWEPT: RetentionResult = {
  windowMs: ROUND_OUTPUT_WINDOW_MS,
  removed: [],
  failures: [],
  failuresOmitted: 0,
  remaining: [],
  missing: [],
}

/** Rotate `retention.jsonl` to `.1` once it is at the bound, so two files at most ever exist. */
function rotateRetentionJournal(file: string): void {
  let size: number
  try {
    size = statSync(file).size
  } catch (cause) {
    // No file yet is the ordinary first write, not a failure.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return
    throw new Error(`log retention cannot size ${file}: ${String(cause)}`, { cause })
  }
  if (size >= RETENTION_JOURNAL_MAX_BYTES) renameSync(file, `${file}.1`)
}

/** Write one row, rotating first — the one place either caller touches the file. */
function writeRetentionRow(workdir: string, row: Record<string, unknown>): void {
  const file = join(workdir, RETENTION_JOURNAL)
  rotateRetentionJournal(file)
  appendFileSync(file, `${JSON.stringify(row)}\n`)
}

/**
 * Whether a sweep result is worth a row (@cto 2026-10-10T23:16Z): it removed
 * something, or it failed. A round with nothing expired writes NOTHING — "one
 * observation row per round" meant at most one, and a row on every idle round is
 * exactly the unbounded file this note closed. An absent declared-OPTIONAL root
 * is a NORMAL host state and is never a row on its own (@cto 2026-10-10T23:30Z) —
 * a host that never runs a check would re-announce `checks/` every round — but it
 * stays named inside any row that IS written, and in the verb's output, so where
 * the sweep looked is never hidden. A REQUIRED root that is missing is a failure,
 * reported below.
 */
export function retentionRowWorthWriting(result: RetentionResult): boolean {
  return (
    result.removed.length > 0 ||
    result.failures.length > 0 ||
    result.failuresOmitted > 0 ||
    compressionWorthNaming(result.compression)
  )
}

/**
 * Append one observation row for a sweep — the ONE writer both the queue round
 * and `yrd logs prune` share. Returns whether a row was written, so a caller
 * (and a test) can tell "nothing worth saying" from "not called".
 */
export function appendRetentionObservation(workdir: string, result: RetentionResult, at: Date): boolean {
  if (!retentionRowWorthWriting(result)) return false
  writeRetentionRow(workdir, retentionObservation(result, { at }))
  return true
}

/**
 * The queue round's own bounded sweep — the pruner that ACTS in 28499's split
 * AC4 (@cto 2026-10-10T22:53Z; failure isolation 2026-10-10T23:16Z). It removes
 * at most one `ROUND_REMOVAL_BATCH` of expired round output per round, oldest
 * first, then writes at most one observation row, so a queue that keeps running
 * drains the backlog with no operator invoking `yrd logs prune`. It is the SAME
 * selection and removal `pruneRoundOutput` runs; the round only fixes the bound
 * and names the roots (`logs` REQUIRED — the round just wrote its journal there
 * via `openLog`; `checks` OPTIONAL — a host may never have run a check).
 *
 * A disposal step MUST NOT stop the merge line (@cto 2026-10-10T23:16Z): every
 * failure — a directory that will not remove, a missing required root, or a row
 * that will not write — is named on stderr (and in the row, where one can be
 * written), the round's outcome STANDS, and the next round retries. The
 * precedent is the up loop's QueueRunEventRetryExhausted line, never a throw.
 *
 * The same walk selects what the round then gzip-compresses (34923): finished
 * raw output past a day, journals past the window, bounded per round
 * ({@link compressRetainedOutput}). A compression failure is the same kind of
 * result: named on stderr and in the row, and the next round retries. `settled`
 * is the caller's memory of candidates with nothing more owed; the service
 * keeps one for its lifetime, and without it every round examines afresh.
 */
export async function sweepRoundOutputInRound(
  input: Readonly<{ workdir: string; now: Date; report?: (line: string) => void; settled?: Set<string> }>,
): Promise<RetentionDrain | undefined> {
  const report = input.report ?? ((line: string): void => void process.stderr.write(line))
  const logs = join(input.workdir, "logs")
  let result: RetentionDrain
  try {
    result = await pruneRoundOutput({
      roots: [{ path: logs }, { path: join(input.workdir, "checks"), optional: true }],
      now: input.now,
      limit: ROUND_REMOVAL_BATCH,
      compress: {
        journalRoot: logs,
        roundAfterMs: ROUND_OUTPUT_COMPRESS_AFTER_MS,
        journalAfterMs: JOURNAL_COMPRESS_AFTER_MS,
      },
    })
  } catch (cause) {
    // The sweep could not even RUN — a required root missing or unreadable. It is
    // REPORTED, never thrown: the round has already judged and merged.
    const error = cause instanceof Error ? cause.message : String(cause)
    try {
      writeRetentionRow(input.workdir, { ...retentionObservation(NOTHING_SWEPT, { at: input.now }), error })
    } catch (writeCause) {
      report(`yrd: log retention could not record its failure: ${String(writeCause)}\n`)
    }
    report(`yrd: log retention sweep failed: ${error}; the service retries at its next round\n`)
    // silent-fallback-allow: the failure is named loudly on stderr AND recorded in
    // the retention row above; `undefined` means "no drain to report", not "silently
    // gave up". Throwing here is what let one unremovable directory stop the merge
    // line (@cto 2026-10-10T23:16Z).
    return undefined
  }
  for (const failure of result.failures) {
    report(`yrd: log retention could not remove ${failure.path}: ${failure.error}; the next round retries\n`)
  }
  if (result.failuresOmitted > 0) {
    report(
      `yrd: log retention: ${result.failuresOmitted} more removal failure(s) past the bounded row; the next round retries\n`,
    )
  }
  let compression: RetentionCompression
  try {
    compression = await compressRetainedOutput({
      logs,
      now: input.now,
      selection: result.compressible ?? { candidates: [] },
      settled: input.settled ?? new Set(),
    })
  } catch (cause) {
    // Every step inside reports its own failure; this is the pass itself breaking. Still a result, never a throw.
    compression = { ...NO_COMPRESSION, failures: [{ path: logs, name: basename(logs), error: message(cause) }] }
  }
  for (const failure of compression.failures) {
    report(`yrd: log retention could not compress ${failure.path}: ${failure.error}; the next round retries\n`)
  }
  if (compression.failuresOmitted > 0) {
    report(
      `yrd: log retention: ${compression.failuresOmitted} more compression failure(s) past the bounded row; the next round retries\n`,
    )
  }
  const swept: RetentionDrain = { ...result, compression }
  try {
    appendRetentionObservation(input.workdir, swept, input.now)
  } catch (cause) {
    // The sweep RAN; only its row failed. Still never fatal to the round.
    report(`yrd: log retention could not write its observation row: ${String(cause)}; the next round retries\n`)
  }
  return swept
}
