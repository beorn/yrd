import { lstat, readdir, rm, statfs } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { systemClock } from "@yrd/core"
import type { JobError } from "@yrd/job"

/**
 * Minimal structural view of the queue's private git helper: enough to ask a
 * repository where its common directory lives, without exporting the whole
 * `Git` surface out of `command.ts`.
 */
type CommonDirGit = Readonly<{
  run: (repo: string, args: readonly string[]) => Promise<Readonly<{ stdout: string }>>
}>

/**
 * Queue scratch — merge worktrees, source rebases, patch-id diffs, union
 * proofs — belongs on the repository's own filesystem, never on the system
 * temp dir.
 *
 * A merge worktree materializes the entire tree, which is tens of thousands of
 * inodes per run. When that merged on a tmpfs `/tmp`, an unrelated session's
 * test scratch could exhaust the tmpfs INODE table (bytes still half free) and
 * every merge on every queue failed with `No space left on device` — a total
 * merge outage for ~65 minutes on 2026-08-14 (R2224-R2235), which cleared by
 * itself the moment the unrelated holder released its inodes.
 *
 * `.git/yrd/` already hosts the queue's artifacts, deployments and pre-submit
 * worktrees, so the queue's own state directory is the conventional home; it
 * shares the repository's disk, which is orders of magnitude larger than a
 * tmpfs and is not shared with unrelated scratch.
 *
 * Derived from `--git-common-dir` rather than `join(repo, ".git")` because the
 * callers include submodule worktrees and linked worktrees,
 * where `.git` is a FILE and the naive join is not a directory at all.
 */
export async function queueScratchParent(git: CommonDirGit, repo: string): Promise<string> {
  const key = resolve(repo)
  const memoized = commonDirs.get(key)
  if (memoized !== undefined) return join(memoized, "yrd", "scratch")
  const common = (await git.run(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim()
  if (common === "") throw new Error(`yrd: git returned an empty common directory for '${repo}'`)
  const root = resolve(repo, common)
  commonDirs.set(key, root)
  return join(root, "yrd", "scratch")
}

/**
 * A repository's common directory does not move under a running process, and
 * every scratch preparation asked git for it again — a fork per merge worktree,
 * per source rebase, per union proof. The CLI already memoizes the same lookup
 * (`queueGitDir` in `yrd-cli/src/run.ts`), for the sharper reason that forking
 * on the watch UI's render path stalls it; that memo cannot be shared across
 * the package boundary, so the queue keeps its own. Only a proven answer is
 * cached: a failed lookup leaves the memo empty and is raised to the caller.
 */
const commonDirs = new Map<string, string>()

/**
 * ENOSPC reaches us two ways: as a Node filesystem error carrying `code`, and
 * — far more often — as the queue git helper's thrown `Error` whose message is
 * git's own stderr. Both must classify, because the outage surfaced through
 * `worktree add` stderr and through submodule checkout stderr alike.
 */
export function isStorageExhaustion(cause: unknown): boolean {
  if (cause === null || cause === undefined) return false
  if (typeof cause === "object") {
    const code = (cause as Readonly<{ code?: unknown }>).code
    if (code === "ENOSPC") return true
    const nested = (cause as Readonly<{ cause?: unknown }>).cause
    if (nested !== undefined && nested !== cause && isStorageExhaustion(nested)) return true
  }
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : ""
  return /no space left on device|ENOSPC/iu.test(message)
}

export type StorageState = Readonly<{
  path: string
  inodes: Readonly<{ total: number; free: number; used: number; usedPercent: number }>
  bytes: Readonly<{ total: number; free: number; used: number; usedPercent: number }>
}>

const percent = (used: number, total: number): number => (total <= 0 ? 0 : Math.round((used / total) * 1000) / 10)

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${unit === 0 ? scaled : scaled.toFixed(1)} ${units[unit]}`
}

/**
 * Read the filesystem backing `path`. The scratch directory is often already
 * gone (or was never created) by the time a failure is classified, so walk up
 * to the nearest ancestor that still resolves rather than losing the numbers.
 */
export async function readStorageState(path: string): Promise<StorageState | undefined> {
  let probe = resolve(path)
  for (;;) {
    try {
      const stats = await statfs(probe)
      const inodesTotal = Number(stats.files)
      const inodesFree = Number(stats.ffree)
      const blockSize = Number(stats.bsize)
      const bytesTotal = Number(stats.blocks) * blockSize
      const bytesFree = Number(stats.bavail) * blockSize
      return {
        path: probe,
        inodes: {
          total: inodesTotal,
          free: inodesFree,
          used: inodesTotal - inodesFree,
          usedPercent: percent(inodesTotal - inodesFree, inodesTotal),
        },
        bytes: {
          total: bytesTotal,
          free: bytesFree,
          used: bytesTotal - bytesFree,
          usedPercent: percent(bytesTotal - bytesFree, bytesTotal),
        },
      }
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
      const parent = dirname(probe)
      if (parent === probe) return undefined
      probe = parent
    }
  }
}

export function describeStorageState(state: StorageState): string {
  return (
    `filesystem backing '${state.path}' is exhausted: ` +
    `inodes ${state.inodes.used}/${state.inodes.total} used (${state.inodes.usedPercent}%), ${state.inodes.free} free; ` +
    `bytes ${formatBytes(state.bytes.used)}/${formatBytes(state.bytes.total)} used ` +
    `(${state.bytes.usedPercent}%), ${formatBytes(state.bytes.free)} free`
  )
}

/** The typed code for storage exhaustion during scratch/worktree preparation. */
export const WORKTREE_STORAGE_EXHAUSTED = "worktree-storage-exhausted"

/**
 * Build the typed failure for an ENOSPC that struck while preparing scratch.
 *
 * This must never be reported as a content merge conflict: nothing about the
 * candidate is wrong, no author can act on it, and the very same candidate
 * merges first try once the filesystem has room. Naming the filesystem and its
 * inode/byte split is the whole point — the 2026-08-14 outage looked like
 * bytes were fine (51% used) while inodes sat at 100%, so a byte-only report
 * would have sent the reader looking in the wrong place.
 */
export async function storageExhaustionError(path: string, cause: unknown): Promise<JobError> {
  const state = await readStorageState(path)
  const detail = state === undefined ? `filesystem backing '${path}' is exhausted` : describeStorageState(state)
  const original = cause instanceof Error ? cause.message : String(cause)
  return {
    code: WORKTREE_STORAGE_EXHAUSTED,
    message: `yrd: scratch preparation ran out of space — ${detail}. Underlying error: ${original}`,
    ...(state === undefined
      ? {}
      : {
          evidence: {
            kind: "storage-exhaustion",
            path: state.path,
            inodesTotal: state.inodes.total,
            inodesFree: state.inodes.free,
            inodesUsedPercent: state.inodes.usedPercent,
            bytesTotal: state.bytes.total,
            bytesFree: state.bytes.free,
            bytesUsedPercent: state.bytes.usedPercent,
          },
        }),
  }
}

const STORAGE_EXHAUSTION_TAG = Symbol.for("yrd.queue.scratch-storage-exhaustion")

/**
 * Carry the typed failure on the thrown error itself, so classification happens
 * once — at the scratch primitive, while the directory still exists and its
 * inode/byte split is still true — and every catch downstream reads the answer
 * instead of re-deriving it. Re-deriving later is not equivalent:
 * `readStorageState` walks up to the nearest surviving ancestor, so a catch that
 * classifies after cleanup can report a different filesystem than the one that
 * ran out.
 */
export function tagStorageExhaustion<E extends Error>(error: E, failure: JobError): E {
  return Object.assign(error, { [STORAGE_EXHAUSTION_TAG]: failure })
}

/** The typed failure a scratch primitive already prepared for this cause, if any. */
export function taggedStorageExhaustion(cause: unknown): JobError | undefined {
  if (cause === null || typeof cause !== "object") return undefined
  const tagged = (cause as Readonly<Record<symbol, unknown>>)[STORAGE_EXHAUSTION_TAG]
  if (tagged !== undefined) return tagged as JobError
  const nested = (cause as Readonly<{ cause?: unknown }>).cause
  return nested === undefined || nested === cause ? undefined : taggedStorageExhaustion(nested)
}

/**
 * How long an entry under the scratch root may sit before it is treated as
 * abandoned. Queue jobs are bounded well below this by their own timeouts, so a
 * full day of no writes cannot describe live work.
 */
export const ORPHANED_SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Every queue scratch directory is `mkdtemp`-ed with a `yrd-` prefix
 * (`yrd-queue-`, `yrd-source-`, `yrd-union-proof-`, `yrd-component-main-`). It is
 * the only thing that identifies an entry as the queue's own to delete.
 */
export const SCRATCH_NAME_PREFIX = "yrd-"

export type ScratchReapReport = Readonly<{
  root: string
  /** The denominator: every entry directly under the scratch root. */
  entries: number
  reaped: number
  /** Entries left alone because they are younger than the threshold or still live. */
  kept: number
  bytes: number
  /** Removals that failed, kept loud rather than folded into `kept`. */
  failures: readonly string[]
}>

async function directorySize(path: string): Promise<number> {
  let total = 0
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(child)
        continue
      }
      total += (await lstat(child)).size
    }
  }
  await walk(path)
  return total
}

/**
 * Remove scratch left behind by a queue process that died between creating a
 * worktree and its `finally`. `withScratchRoot` cleans up on every ordinary
 * path, including failures, but a SIGKILL or a host crash has no `finally` — and
 * this scratch lives on the repository's own disk (`<git-common-dir>/yrd/scratch`,
 * chosen over a tmpfs after the 2026-08-14 inode outage), so nothing clears it at
 * reboot either. Each abandoned merge worktree is a materialized tree: tens of
 * thousands of inodes, on the very filesystem whose exhaustion this module
 * exists to report.
 *
 * Bounded and conservative: one non-recursive listing of the root, and an entry
 * is removed only when all three hold — its name carries `namePrefix`, it is
 * older than `olderThanMs`, and it is absent from `keep`, the paths git still
 * lists as live worktrees, which is the read that separates an abandoned
 * worktree from a slow one. The name check is not decoration: the scratch parent
 * is the queue's own state dir by default but a host may point it at a bays
 * root it shares with other work, and only the `mkdtemp` prefix says an entry is
 * ours to delete. A missing root is a legitimate absence (nothing has prepared
 * scratch yet) and reports zero entries; anything else about the root is raised.
 */
export async function reapOrphanedScratch(
  root: string,
  options: Readonly<{ olderThanMs?: number; now?: number; keep?: ReadonlySet<string>; namePrefix?: string }> = {},
): Promise<ScratchReapReport> {
  const olderThanMs = options.olderThanMs ?? ORPHANED_SCRATCH_MAX_AGE_MS
  const now = options.now ?? systemClock.now()
  const keep = options.keep ?? new Set<string>()
  const namePrefix = options.namePrefix ?? SCRATCH_NAME_PREFIX
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (cause) {
    if ((cause as Readonly<{ code?: unknown }>).code === "ENOENT") {
      return { root, entries: 0, reaped: 0, kept: 0, bytes: 0, failures: [] }
    }
    throw cause
  }
  let reaped = 0
  let kept = 0
  let bytes = 0
  const failures: string[] = []
  for (const name of entries) {
    const path = join(root, name)
    try {
      const stats = await lstat(path)
      if (!name.startsWith(namePrefix) || keep.has(path) || now - stats.mtimeMs <= olderThanMs) {
        kept += 1
        continue
      }
      const size = await directorySize(path)
      await rm(path, { recursive: true, force: true })
      reaped += 1
      bytes += size
    } catch (cause) {
      failures.push(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  return { root, entries: entries.length, reaped, kept, bytes, failures }
}

/** One line naming what was reaped against the denominator it was chosen from. */
export function describeScratchReap(report: ScratchReapReport): string {
  return (
    `yrd: reaped ${report.reaped} of ${report.entries} scratch entr${report.entries === 1 ? "y" : "ies"} ` +
    `under '${report.root}' (${formatBytes(report.bytes)} freed, ${report.kept} kept as live or younger than the ` +
    `threshold)${report.failures.length === 0 ? "" : `; ${report.failures.length} could not be removed: ${report.failures.join("; ")}`}`
  )
}
