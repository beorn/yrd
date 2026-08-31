/**
 * @failure Queue scratch merges on the system temp dir, so an unrelated process
 * exhausting a tmpfs `/tmp` fails every merge fleet-wide, and the ENOSPC is
 * reported as `merge-failed` — indistinguishable from a content conflict the
 * author must resolve.
 * @level l2
 * @consumer @yrd/queue scratch storage
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  describeScratchReap,
  describeStorageState,
  isStorageExhaustion,
  liveWorktreeEntries,
  ORPHANED_SCRATCH_MAX_AGE_MS,
  queueScratchParent,
  readStorageState,
  reapOrphanedScratch,
  storageExhaustionError,
  WORKTREE_STORAGE_EXHAUSTED,
} from "../src/scratch-storage.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

/** A `Pick<Git, "run">` over the real binary — the projection the production helper takes. */
const runner = {
  run: async (repo: string, args: readonly string[]) => ({ code: 0, stdout: await git(repo, args), stderr: "" }),
}

async function initRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "seed\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "seed"])
  return repo
}

/**
 * The exact stderr git produced during the 2026-08-14 merge outage (R2233),
 * where a merge worktree could not be prepared because the tmpfs holding it had
 * no inodes left. Captured verbatim so the classifier is proven against the
 * real text, not a paraphrase of it.
 */
const R2233_STDERR = [
  "Preparing worktree (detached HEAD 8f2fc41c6a)",
  "error: unable to create file hub/silvery/research/cc-rendering-issues.md: No space left on device",
  "error: unable to create file hub/silvery/research/cmux.md: No space left on device",
  "fatal: could not detach HEAD",
].join("\n")

/** A genuine content merge conflict — the state ENOSPC must never be confused with. */
const CONTENT_CONFLICT_STDERR = [
  "Auto-merging hab.yml",
  "CONFLICT (content): Merge conflict in hab.yml",
  "Automatic merge failed; fix conflicts and then commit the result.",
].join("\n")

describe("queueScratchParent — scratch follows the repository, not the temp dir", () => {
  it("puts scratch under the repository's own git common dir", async () => {
    const repo = await initRepo("yrd-scratch-parent-")

    expect(await queueScratchParent(runner, repo)).toBe(join(repo, ".git", "yrd", "scratch"))
  })

  it("resolves a linked worktree back to the SHARED common dir, not its private git file", async () => {
    const repo = await initRepo("yrd-scratch-linked-")
    const linked = join(repo, "..", "linked")
    await git(repo, ["worktree", "add", "-q", "--detach", linked])

    // A linked worktree's `.git` is a FILE. Joining `.git/yrd` onto it would
    // not be a directory at all, so the parent must come from --git-common-dir.
    expect(await queueScratchParent(runner, linked)).toBe(join(repo, ".git", "yrd", "scratch"))
  })

  it("resolves a submodule worktree to the submodule's own git dir (rebaseSource's caller shape)", async () => {
    const repo = await initRepo("yrd-scratch-submodule-")
    const dep = await initRepo("yrd-scratch-dep-")
    await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dep, "dep"])
    await git(repo, ["commit", "-qm", "add submodule"])

    // `rebaseSource` passes a SUBMODULE path, whose `.git` is a file pointing
    // at ../.git/modules/dep — the naive `join(repo, ".git")` is ENOTDIR here.
    expect(await queueScratchParent(runner, join(repo, "dep"))).toBe(
      join(repo, ".git", "modules", "dep", "yrd", "scratch"),
    )
  })

  it("raises loud rather than returning a relative path when git reports no common dir", async () => {
    const empty = { run: async () => ({ code: 0, stdout: "", stderr: "" }) }

    await expect(queueScratchParent(empty, "/nowhere")).rejects.toThrow(/empty common directory/u)
  })
})

describe("liveWorktreeEntries — the entries git still calls live worktrees, keyed one level up", () => {
  it("maps a live 'worktree' checkout back to its containing scratch entry", async () => {
    const repo = await initRepo("yrd-live-worktree-")
    const root = join(repo, "..", "scratch")
    const entry = join(root, "yrd-queue-abc123")
    await git(repo, ["worktree", "add", "-q", "--detach", join(entry, "worktree")])

    const live = await liveWorktreeEntries(runner, repo, root)

    expect([...live]).toEqual([entry])
  })

  it("ignores a live worktree that sits outside root", async () => {
    const repo = await initRepo("yrd-live-worktree-outside-")
    const root = join(repo, "..", "scratch")
    await git(repo, ["worktree", "add", "-q", "--detach", join(repo, "..", "elsewhere", "worktree")])

    const live = await liveWorktreeEntries(runner, repo, root)

    expect(live.size).toBe(0)
  })

  it("returns empty rather than raising when git cannot list worktrees", async () => {
    const failing = { run: async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }) }

    const live = await liveWorktreeEntries(failing, "/nowhere-a-repo-exists", "/nowhere-a-repo-exists/scratch")

    expect(live.size).toBe(0)
  })

  it("composes with reapOrphanedScratch to protect a live entry sharing the pre-submit-worktrees shape", async () => {
    const repo = await initRepo("yrd-live-worktree-reap-")
    const root = join(repo, "..", "check-scratch")
    const liveEntry = join(root, "check-abc123")
    await git(repo, ["worktree", "add", "-q", "--detach", join(liveEntry, "worktree")])
    // An abandoned sibling with the same 'check-' shape, old enough to reap —
    // no live worktree registration, standing in for a checkout a killed
    // process never got to `finally`-remove.
    const abandonedEntry = join(root, "check-def456")
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await mkdir(join(abandonedEntry, "worktree"), { recursive: true })
    await utimes(join(abandonedEntry, "worktree"), stale, stale)
    await utimes(abandonedEntry, stale, stale)

    const keep = await liveWorktreeEntries(runner, repo, root)
    const report = await reapOrphanedScratch(root, { keep, namePrefix: "check-" })

    expect(report).toMatchObject({ entries: 2, reaped: 1, kept: 1 })
    expect(existsSync(liveEntry)).toBe(true)
    expect(existsSync(abandonedEntry)).toBe(false)
  })
})

describe("isStorageExhaustion — ENOSPC is not a merge conflict", () => {
  it("classifies the R2233 worktree-preparation stderr as storage exhaustion", () => {
    expect(isStorageExhaustion(new Error(R2233_STDERR))).toBe(true)
  })

  it("classifies a Node filesystem ENOSPC error by its code", () => {
    expect(isStorageExhaustion(Object.assign(new Error("write failed"), { code: "ENOSPC" }))).toBe(true)
  })

  it("classifies an ENOSPC wrapped as the cause of an outer error", () => {
    const cause = Object.assign(new Error("write failed"), { code: "ENOSPC" })
    expect(isStorageExhaustion(new Error("scratch preparation failed", { cause }))).toBe(true)
  })

  it("classifies the raw submodule-checkout stderr the outage also produced", () => {
    expect(
      isStorageExhaustion(
        "Cloning into '/tmp/yrd-queue-e8hQfo/worktree/vendor/termless'...\nfatal: cannot create directory at 'docs/reference': No space left on device",
      ),
    ).toBe(true)
  })

  it("does NOT classify a content merge conflict as storage exhaustion", () => {
    expect(isStorageExhaustion(new Error(CONTENT_CONFLICT_STDERR))).toBe(false)
  })

  it("does NOT classify an ordinary git failure", () => {
    expect(isStorageExhaustion(new Error("fatal: not a valid object name"))).toBe(false)
    expect(isStorageExhaustion(undefined)).toBe(false)
    expect(isStorageExhaustion(null)).toBe(false)
  })
})

describe("readStorageState — the filesystem's inode and byte split", () => {
  it("reports both inode and byte totals for a real directory", async () => {
    const repo = await initRepo("yrd-scratch-statfs-")

    const state = await readStorageState(repo)

    expect(state).toBeDefined()
    if (state === undefined) throw new Error("unreachable")
    expect(state.inodes.total).toBeGreaterThan(0)
    expect(state.bytes.total).toBeGreaterThan(0)
    expect(state.inodes.used + state.inodes.free).toBe(state.inodes.total)
  })

  it("falls back to the nearest existing ancestor when the scratch dir is already gone", async () => {
    const repo = await initRepo("yrd-scratch-missing-")

    // Classification runs AFTER cleanup, so the path usually no longer exists;
    // losing the numbers there would defeat the whole point of the typed error.
    const state = await readStorageState(join(repo, "yrd", "scratch", "yrd-queue-deleted", "worktree"))

    expect(state).toBeDefined()
    expect(state?.inodes.total).toBeGreaterThan(0)
  })

  it("renders inodes and bytes separately, so an inode-only exhaustion is legible", () => {
    const rendered = describeStorageState({
      path: "/tmp",
      inodes: { total: 1_048_576, free: 0, used: 1_048_576, usedPercent: 100 },
      bytes: { total: 8_589_934_592, free: 4_194_304_000, used: 4_395_630_592, usedPercent: 51.2 },
    })

    // The 2026-08-14 outage had bytes at 51% and inodes at 100%: a byte-only
    // report sends the reader looking in exactly the wrong place.
    expect(rendered).toContain("inodes 1048576/1048576 used (100%)")
    expect(rendered).toContain("51.2%")
    expect(rendered).toContain("/tmp")
  })
})

describe("storageExhaustionError — the typed failure", () => {
  it("names its own code, never merge-failed", async () => {
    const repo = await initRepo("yrd-scratch-typed-")

    const error = await storageExhaustionError(repo, new Error(R2233_STDERR))

    expect(error.code).toBe(WORKTREE_STORAGE_EXHAUSTED)
    expect(error.code).not.toBe("merge-failed")
  })

  it("carries the filesystem state and the underlying git error in the message", async () => {
    const repo = await initRepo("yrd-scratch-message-")

    const error = await storageExhaustionError(repo, new Error(R2233_STDERR))

    expect(error.message).toContain("inodes")
    expect(error.message).toContain("bytes")
    expect(error.message).toContain("No space left on device")
  })

  it("carries machine-readable inode counts as evidence", async () => {
    const repo = await initRepo("yrd-scratch-evidence-")

    const error = await storageExhaustionError(repo, new Error(R2233_STDERR))
    const evidence = error.evidence as Readonly<{ kind?: string; inodesTotal?: number; bytesTotal?: number }>

    expect(evidence.kind).toBe("storage-exhaustion")
    expect(evidence.inodesTotal).toBeGreaterThan(0)
    expect(evidence.bytesTotal).toBeGreaterThan(0)
  })
})

describe("reapOrphanedScratch — scratch a killed process could not clean up", () => {
  async function scratchRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "yrd-scratch-reap-"))
    roots.push(root)
    return root
  }

  /** A scratch entry as `withScratchRoot` leaves it: a directory holding a worktree. */
  async function entry(root: string, name: string, ageMs: number): Promise<string> {
    const path = join(root, name)
    await mkdir(join(path, "worktree"), { recursive: true })
    await writeFile(join(path, "worktree", "file.txt"), "x".repeat(64))
    const at = new Date(Date.now() - ageMs)
    await utimes(join(path, "worktree", "file.txt"), at, at)
    await utimes(path, at, at)
    return path
  }

  it("removes only entries past the threshold, and reports the denominator it chose from", async () => {
    const root = await scratchRoot()
    const abandoned = await entry(root, "yrd-queue-abandoned", 48 * 60 * 60 * 1000)
    const fresh = await entry(root, "yrd-queue-fresh", 60 * 1000)

    const report = await reapOrphanedScratch(root)

    expect(report).toMatchObject({ root, entries: 2, reaped: 1, kept: 1, failures: [] })
    expect(report.bytes).toBeGreaterThan(0)
    expect(existsSync(abandoned)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    // The count is worthless without what it was drawn from: "reaped 1" alone
    // cannot distinguish a healthy sweep from one that missed 400 entries.
    expect(describeScratchReap(report)).toContain("1 of 2")
  })

  it("never reaps an entry git still lists as a live worktree, however old", async () => {
    const root = await scratchRoot()
    const live = await entry(root, "yrd-queue-live", 48 * 60 * 60 * 1000)

    const report = await reapOrphanedScratch(root, { keep: new Set([live]) })

    expect(report).toMatchObject({ entries: 1, reaped: 0, kept: 1 })
    expect(existsSync(live)).toBe(true)
  })

  it("never reaps an entry it did not create, however old — a shared parent holds other work", async () => {
    const root = await scratchRoot()
    const foreign = await entry(root, "someone-elses-checkout", 48 * 60 * 60 * 1000)

    const report = await reapOrphanedScratch(root)

    expect(report).toMatchObject({ entries: 1, reaped: 0, kept: 1 })
    expect(existsSync(foreign)).toBe(true)
  })

  it("treats an absent scratch root as nothing-prepared-yet, not a failure", async () => {
    const root = join(await scratchRoot(), "never-created")

    const report = await reapOrphanedScratch(root)

    expect(report).toMatchObject({ root, entries: 0, reaped: 0, kept: 0, bytes: 0, failures: [] })
  })

  it("defaults to a full day, so a job running under its own timeout is never swept", () => {
    expect(ORPHANED_SCRATCH_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000)
  })
})
