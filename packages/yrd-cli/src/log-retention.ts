import { readdirSync } from "node:fs"
import { join } from "node:path"
import { runStartedAt } from "@yrd/queue-core"
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
 */

/** Seven days: the round-output window @cto ruled (28499). Journals are never windowed by this. */
export const ROUND_OUTPUT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How many round-output directories `yrd logs prune` removes per batch, oldest
 * first. Retention is drained EXPLICITLY by that verb — no queue round prunes
 * automatically (the round-side sweep was split out of this head, 28499). The
 * verb selects the whole oldest-first list ONCE and deletes it in batches of
 * this size, so draining thousands never re-walks the tree between batches and
 * each batch stays a bounded recursive delete, far under the 27723 bar (30 s,
 * 400 spawns).
 */
export const ROUND_REMOVAL_BATCH = 8

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
export type RetentionScan = Readonly<{ entries: readonly ExpiredRoundOutput[]; missing: readonly string[] }>

/** What one pass of the sweep did: the window, what it removed, what is STILL older than it, and optional roots not seen. */
export type RetentionResult = Readonly<{
  windowMs: number
  removed: readonly ExpiredRoundOutput[]
  remaining: readonly ExpiredRoundOutput[]
  missing: readonly string[]
}>

/**
 * A `yrd logs prune` drain: the usual result, plus the list the run SELECTED
 * (everything older than the window) and the oldest `limit` of it it PLANNED to
 * remove. The verb reports both, so it never re-derives them from the scan.
 */
export type RetentionDrain = RetentionResult &
  Readonly<{ selected: readonly ExpiredRoundOutput[]; planned: readonly ExpiredRoundOutput[] }>

function rootOf(root: RetentionRoot): Readonly<{ path: string; optional: boolean }> {
  return typeof root === "string"
    ? { path: root, optional: false }
    : { path: root.path, optional: root.optional === true }
}

/** Every round-output directory under `roots` whose own name is a round older than the window, oldest first. */
export function expiredRoundOutput(
  input: Readonly<{ roots: readonly RetentionRoot[]; now: Date; windowMs?: number }>,
): RetentionScan {
  const windowMs = input.windowMs ?? ROUND_OUTPUT_WINDOW_MS
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new Error(`log retention window must be a non-negative number of ms, got ${String(windowMs)}`)
  }
  const cutoff = input.now.getTime() - windowMs
  const found: ExpiredRoundOutput[] = []
  const missing: string[] = []
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
      for (const entry of entries) {
        // A symlink is neither followed nor removed: only a real directory may be a target.
        if (!entry.isDirectory()) continue
        const path = join(current.directory, entry.name)
        const started = runStartedAt(entry.name)
        if (started !== undefined) {
          if (started.getTime() <= cutoff) found.push({ path, name: entry.name, within, started })
          continue
        }
        if (current.depth < MAX_WALK_DEPTH) stack.push({ directory: path, depth: current.depth + 1 })
      }
    }
  }
  found.sort((left, right) => left.started.getTime() - right.started.getTime() || left.name.localeCompare(right.name))
  return { entries: found, missing }
}

/** Remove a chosen list of round-output directories, oldest first, at most `limit` of them, through removely. */
export async function removeExpiredRoundOutput(
  input: Readonly<{ selected: readonly ExpiredRoundOutput[]; limit?: number; dryRun?: boolean }>,
): Promise<Readonly<{ removed: readonly ExpiredRoundOutput[]; remaining: readonly ExpiredRoundOutput[] }>> {
  const limit = input.limit ?? input.selected.length
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`log retention batch must be a non-negative integer, got ${String(input.limit)}`)
  }
  const chosen = input.selected.slice(0, limit)
  const removed: ExpiredRoundOutput[] = []
  if (input.dryRun !== true) {
    for (const entry of chosen) {
      // The containment root is the tree the entry was FOUND under: a removal
      // that cannot name it does not compile, and removely refuses a target
      // outside it. `allowedRoots` must ALSO name that tree: removely's default
      // is [tmpdir()], and it REPLACES that default rather than adding to it, so
      // without this a real queue root — /hh/var/yrd-workdir/… — is refused
      // ("containment root … is not under an allowed root"), which is exactly the
      // tree this sweep exists to prune.
      await safeRemove(entry.path, { within: entry.within, allowedRoots: [entry.within] })
      removed.push(entry)
    }
  }
  // `remaining` is everything still older than the window, not just this batch:
  // chosen is the oldest prefix of an oldest-first list, so removal is a prefix too.
  return { removed, remaining: input.selected.slice(removed.length) }
}

/**
 * Select expired round output under `roots`, then remove at most `limit` of it
 * (oldest first) through removely — the ONE composition `yrd logs prune` runs,
 * and the interface its tests drive. The list is selected ONCE and removed in
 * batches of `ROUND_REMOVAL_BATCH`, so a drain of thousands never re-walks the
 * tree between batches. `dryRun` selects and reports but removes nothing.
 */
export async function pruneRoundOutput(
  input: Readonly<{
    roots: readonly RetentionRoot[]
    now: Date
    windowMs?: number
    limit?: number
    dryRun?: boolean
  }>,
): Promise<RetentionDrain> {
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 0)) {
    throw new Error(`log retention batch must be a non-negative integer, got ${String(input.limit)}`)
  }
  const windowMs = input.windowMs ?? ROUND_OUTPUT_WINDOW_MS
  const scan = expiredRoundOutput({ roots: input.roots, now: input.now, windowMs })
  const selected = scan.entries
  const planned = input.limit === undefined ? selected : selected.slice(0, input.limit)
  const removed: ExpiredRoundOutput[] = []
  if (input.dryRun !== true) {
    for (let index = 0; index < planned.length; index += ROUND_REMOVAL_BATCH) {
      const batch = await removeExpiredRoundOutput({ selected: planned.slice(index, index + ROUND_REMOVAL_BATCH) })
      removed.push(...batch.removed)
    }
  }
  return { windowMs, selected, planned, removed, remaining: selected.slice(removed.length), missing: scan.missing }
}

/**
 * The ONE observation row `yrd logs prune` writes about its sweep (28499
 * ruling): what it removed, how much round output is STILL older than the
 * window, and the oldest such name — so a reader can watch retention fall
 * behind without opening a single round directory. Absent `oldest` means the
 * tree is inside the window.
 *
 * Journaled BESIDE the run journals, in `<workdir>/retention.jsonl` (the one
 * writer is cli.ts), never inside the log tree: every `logs/*.jsonl` is a run
 * and this row is not one, so a run-journal name on it made the runner's own
 * header read refuse the newest journal.
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
    // An optional root that was not on disk is named in the row: "removed 0"
    // must never be the only fact a reader has about where the sweep looked.
    ...(result.missing.length === 0 ? {} : { missing: result.missing }),
  }
}

/** The one place the human rendering of a prune lives, so it can be asserted without a terminal. */
export function retentionHumanLines(
  result: RetentionResult,
  input: Readonly<{ roots: readonly string[]; dryRun: boolean; listed: readonly ExpiredRoundOutput[] }>,
): string[] {
  const days = Math.round(result.windowMs / (24 * 60 * 60 * 1000))
  return [
    `yrd: log retention: ${input.dryRun ? "would remove" : "removed"} ${input.listed.length} round-output directories older than ${days} days; ${result.remaining.length} still older than the window`,
    // An empty result still says WHERE the sweep looked: "nothing" without the
    // roots and the rule is the silent default this whole change refuses.
    `yrd: log retention: searched ${input.roots.join(", ")} (directories named q-<utc>-<id> older than ${days} days; journals kept)`,
    // A declared-optional root that was not on disk is NAMED here too, so an
    // absent tree is never indistinguishable from a healthy empty scan.
    ...(result.missing.length === 0
      ? []
      : [`yrd: log retention: no such optional root (absent, not an error): ${result.missing.join(", ")}`]),
    ...input.listed.map((entry) => entry.path),
  ]
}
