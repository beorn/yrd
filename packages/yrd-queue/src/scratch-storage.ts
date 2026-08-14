import { statfs } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
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
 * inodes per run. When that landed on a tmpfs `/tmp`, an unrelated session's
 * test scratch could exhaust the tmpfs INODE table (bytes still half free) and
 * every merge on every queue failed with `No space left on device` — a total
 * landing outage for ~65 minutes on 2026-08-14 (R2224-R2235), which cleared by
 * itself the moment the unrelated holder released its inodes.
 *
 * `.git/yrd/` already hosts the queue's artifacts, deployments and pre-submit
 * worktrees, so the queue's own state directory is the conventional home; it
 * shares the repository's disk, which is orders of magnitude larger than a
 * tmpfs and is not shared with unrelated scratch.
 *
 * Derived from `--git-common-dir` rather than `join(repo, ".git")` because the
 * callers include submodule worktrees (`rebaseSource`) and linked worktrees,
 * where `.git` is a FILE and the naive join is not a directory at all.
 */
export async function queueScratchParent(git: CommonDirGit, repo: string): Promise<string> {
  const common = (await git.run(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim()
  if (common === "") throw new Error(`yrd: git returned an empty common directory for '${repo}'`)
  return join(resolve(repo, common), "yrd", "scratch")
}

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
    } catch {
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
