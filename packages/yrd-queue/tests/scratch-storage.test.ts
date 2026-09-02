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
  CHECK_STORAGE_EXHAUSTED,
  describeScratchReap,
  describeStorageState,
  isStorageExhaustion,
  liveScratchOwners,
  liveWorktreeEntries,
  ORPHANED_SCRATCH_MAX_AGE_MS,
  queueScratchParent,
  readStorageState,
  reapOrphanedScratch,
  storageExhaustionError,
  storageExhaustionPath,
  storageExhaustionStatement,
  WORKTREE_STORAGE_EXHAUSTED,
  writeScratchOwner,
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

/**
 * The `affected-tests` check output for PR3159 (2026-09-01 22:24 PDT, root-pinned
 * epoch 7fd4f79a), the lines as the check's output.log carried them — the
 * elided path segments filled in — where `/tmp` is a quota'd tmpfs and the
 * check's child hit the USER quota, not the device: EDQUOT, which the
 * ENOSPC-only classifier did not know, so yrd retired the submission as
 * `affected-tests-failed` for content that was never at fault.
 */
const PR3159_OUTPUT = [
  "fatal: unable to write loose object file: Disk quota exceeded",
  "error: copy-fd: write returned: Disk quota exceeded",
  "fatal: cannot copy '/nix/store/9k2b7q1x-git-2.45.2/share/git-core/templates/info/exclude' to " +
    "'/tmp/km-vitest-3001/run-0ab3e2db-7c1e/lint-bead-hygiene-delta-72eZkv/.git/info/exclude'",
  "error: copy-fd: write returned: Disk quota exceeded",
  "affected evidence kept: /tmp/tent-affected-fe8520e8ea72/attempt-YgSeTT — the check did not pass; inspect it, then remove it",
  "EDQUOT: unknown error, write",
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

    expect(live.listed).toBe(true)
    expect([...live.live]).toEqual([entry])
  })

  it("ignores a live worktree that sits outside root", async () => {
    const repo = await initRepo("yrd-live-worktree-outside-")
    const root = join(repo, "..", "scratch")
    await git(repo, ["worktree", "add", "-q", "--detach", join(repo, "..", "elsewhere", "worktree")])

    const live = await liveWorktreeEntries(runner, repo, root)

    expect(live.listed).toBe(true)
    expect(live.live.size).toBe(0)
  })

  it("reports that git could NOT answer, so a caller never mistakes it for an empty keep set", async () => {
    const failing = { run: async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }) }

    const live = await liveWorktreeEntries(failing, "/nowhere-a-repo-exists", "/nowhere-a-repo-exists/scratch")

    // Both arms are an empty set; only `listed` separates "nothing is live"
    // from "the keep set is unknown", and a caller about to DELETE must act
    // oppositely on the two.
    expect(live.listed).toBe(false)
    expect(live.live.size).toBe(0)
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
    expect(keep.listed).toBe(true)
    const report = await reapOrphanedScratch(root, { keep: keep.live, namePrefix: "check-" })

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

  // Quota exhaustion is a second errno for the same "no room" answer, and the
  // one a quota'd tmpfs gives while `df` still shows the device half empty.
  it("classifies a Node filesystem EDQUOT error by its code", () => {
    expect(isStorageExhaustion(Object.assign(new Error("write failed"), { code: "EDQUOT" }))).toBe(true)
  })

  it("classifies git's quota stderr and Node's own EDQUOT message (PR3159)", () => {
    expect(isStorageExhaustion(new Error("fatal: unable to write loose object file: Disk quota exceeded"))).toBe(true)
    expect(isStorageExhaustion(new Error("EDQUOT: unknown error, write"))).toBe(true)
    expect(isStorageExhaustion("error: copy-fd: write returned: disk quota exceeded")).toBe(true)
  })

  it("looks inside an AggregateError — the shape the command runner throws when process and artifact stream both fail", () => {
    const member = Object.assign(new Error("write failed"), { code: "EDQUOT" })
    expect(isStorageExhaustion(new AggregateError([new Error("spawn"), member], "both failed"))).toBe(true)
    expect(isStorageExhaustion(new AggregateError([new Error("spawn")], "both failed"))).toBe(false)
  })
})

describe("storageExhaustionStatement — the line in which a tool said the filesystem ran out", () => {
  it("finds the first quota statement in the PR3159 output and names it a quota", () => {
    expect(storageExhaustionStatement(PR3159_OUTPUT)).toEqual({
      line: "fatal: unable to write loose object file: Disk quota exceeded",
      kind: "quota",
    })
  })

  it("names the R2233 device exhaustion a space exhaustion", () => {
    expect(storageExhaustionStatement(R2233_STDERR)?.kind).toBe("space")
  })

  it("reads Node's own errno form even when it is the only line", () => {
    expect(storageExhaustionStatement("EDQUOT: unknown error, write")).toEqual({
      line: "EDQUOT: unknown error, write",
      kind: "quota",
    })
  })

  // The trap this shape exists to avoid: a check's output QUOTES things that are
  // not its own failures. A vitest verdict row naming a test with the errno's
  // name in it is a verdict on the author's content, and reading it as the
  // filesystem's would re-admit a genuine red forever.
  it("does NOT read a test-name mention of the errno as the filesystem's statement", () => {
    expect(
      storageExhaustionStatement(
        [
          " FAIL  packages/yrd-queue/tests/scratch-storage.test.ts > isStorageExhaustion — ENOSPC is not a merge conflict > classifies a Node filesystem ENOSPC error by its code",
          "AssertionError: expected false to be true",
        ].join("\n"),
      ),
    ).toBeUndefined()
  })

  it("finds nothing in a content merge conflict", () => {
    expect(storageExhaustionStatement(CONTENT_CONFLICT_STDERR)).toBeUndefined()
  })
})

describe("storageExhaustionPath — the path the output named as the write that failed", () => {
  it("extracts the destination of git's `cannot copy … to '<path>'` line (PR3159)", () => {
    expect(storageExhaustionPath(PR3159_OUTPUT)).toBe(
      "/tmp/km-vitest-3001/run-0ab3e2db-7c1e/lint-bead-hygiene-delta-72eZkv/.git/info/exclude",
    )
  })

  it("extracts an absolute path from the statement line itself", () => {
    expect(storageExhaustionPath("write /tmp/yrd-scratch/blob: disk quota exceeded")).toBe("/tmp/yrd-scratch/blob")
    expect(storageExhaustionPath("fatal: cannot create directory at '/tmp/x/docs': No space left on device")).toBe(
      "/tmp/x/docs",
    )
  })

  it("names no path when the output named none — never a guess", () => {
    expect(storageExhaustionPath("fatal: unable to write loose object file: Disk quota exceeded")).toBeUndefined()
    expect(storageExhaustionPath("EDQUOT: unknown error, write")).toBeUndefined()
    // A relative path cannot be read for its filesystem, so it is not one.
    expect(storageExhaustionPath(R2233_STDERR)).toBeUndefined()
  })
})

describe("CHECK_STORAGE_EXHAUSTED — the check-output twin of the scratch code", () => {
  it("is its own registered spelling, distinct from the scratch-preparation code", () => {
    expect(CHECK_STORAGE_EXHAUSTED).toBe("check-storage-exhausted")
    expect(CHECK_STORAGE_EXHAUSTED).not.toBe(WORKTREE_STORAGE_EXHAUSTED)
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

describe("liveScratchOwners — liveness a pre-submit checkout RECORDS, not one git infers", () => {
  /** A pid that has provably exited: spawned, awaited, and never reused in the same tick. */
  async function deadPid(): Promise<number> {
    const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" })
    await child.exited
    return child.pid
  }

  /**
   * Measured on the live queue state dir 2026-09-01: all 94 abandoned
   * `check-*` entries under `pre-submit-worktrees` were STILL registered
   * worktrees, bidirectionally — `.git` named an admin dir that existed, and
   * that admin dir's `gitdir` named the entry back. `git worktree list` prints
   * every one of them, so a keep set built from that listing protects all 94
   * and the reaper frees nothing even on its happy path. Registration outlives
   * the process exactly the way the directory does, which is why it cannot
   * separate the two.
   */
  it("does not keep an abandoned entry that is still a registered worktree", async () => {
    const repo = await initRepo("yrd-owner-registered-")
    const root = join(repo, "..", "check-scratch")
    const entry = join(root, "check-abandoned")
    await git(repo, ["worktree", "add", "-q", "--detach", join(entry, "worktree")])

    // git still lists it — the old keep set would protect it.
    const byGit = await liveWorktreeEntries(runner, repo, root)
    expect([...byGit.live]).toEqual([entry])
    // Nothing recorded an owner, so nothing claims it.
    const owned = await liveScratchOwners(root)

    expect(owned.live.size).toBe(0)
    expect(owned.unowned).toBe(1)
  })

  it("keeps an entry whose recorded owner is still running, however old", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-owner-live-"))
    roots.push(root)
    const entry = join(root, "check-running")
    await mkdir(entry, { recursive: true })
    await writeScratchOwner(entry, { pid: process.pid, startedAtMs: Date.now() })

    const owned = await liveScratchOwners(root)

    expect([...owned.live]).toEqual([entry])
    expect(owned.running).toBe(1)
  })

  it("keeps a retained entry after its process is gone — the evidence --keep-on-failure was asked for", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-owner-retained-"))
    roots.push(root)
    const entry = join(root, "check-retained")
    await mkdir(entry, { recursive: true })
    await writeScratchOwner(entry, { pid: await deadPid(), startedAtMs: Date.now(), retained: true })

    const owned = await liveScratchOwners(root)

    expect([...owned.live]).toEqual([entry])
    expect(owned.retained).toBe(1)
    expect(owned.running).toBe(0)
  })

  it("releases an entry whose recorded owner has exited", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-owner-dead-"))
    roots.push(root)
    const entry = join(root, "check-dead")
    await mkdir(entry, { recursive: true })
    await writeScratchOwner(entry, { pid: await deadPid(), startedAtMs: Date.now() })

    const owned = await liveScratchOwners(root)

    expect(owned.live.size).toBe(0)
    expect(owned.exited).toBe(1)
  })

  it("reaps the abandoned entry and keeps the running, retained and young ones, with the counts split", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-owner-sweep-"))
    roots.push(root)
    const gone = await deadPid()
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000)
    const age = async (path: string) => utimes(path, stale, stale)

    const abandoned = join(root, "check-abandoned")
    await mkdir(join(abandoned, "worktree"), { recursive: true })
    await writeFile(join(abandoned, "worktree", "big"), "x".repeat(1024))
    await writeScratchOwner(abandoned, { pid: gone, startedAtMs: stale.getTime() })
    await age(abandoned)

    const running = join(root, "check-running")
    await mkdir(running, { recursive: true })
    // The record is written when the entry is created and the owner necessarily
    // precedes it; only the directory mtime is aged, which is the reading the
    // age floor makes and the one a long check cannot refresh.
    await writeScratchOwner(running, { pid: process.pid, startedAtMs: Date.now() })
    await age(running)

    const retained = join(root, "check-retained")
    await mkdir(retained, { recursive: true })
    await writeScratchOwner(retained, { pid: gone, startedAtMs: stale.getTime(), retained: true })
    await age(retained)

    // Owned by nobody living, but too young to touch: the age floor is the
    // protection that survives every liveness question.
    const young = join(root, "check-young")
    await mkdir(young, { recursive: true })
    await writeScratchOwner(young, { pid: gone, startedAtMs: Date.now() })

    const owned = await liveScratchOwners(root)
    const report = await reapOrphanedScratch(root, { keep: owned.live, namePrefix: "check-" })

    expect(report).toMatchObject({ entries: 4, reaped: 1, keptLive: 2, keptYoung: 1, keptForeign: 0, failures: [] })
    expect(report.bytes).toBeGreaterThanOrEqual(1024)
    expect(existsSync(abandoned)).toBe(false)
    expect(existsSync(running)).toBe(true)
    expect(existsSync(retained)).toBe(true)
    expect(existsSync(young)).toBe(true)
  })

  it("names every count in the one sweep line, so a clean sweep and an inert one read differently", () => {
    const line = describeScratchReap({
      root: "/state/pre-submit-worktrees",
      entries: 4,
      reaped: 1,
      kept: 3,
      keptLive: 2,
      keptYoung: 1,
      keptForeign: 0,
      bytes: 1024,
      failures: [],
    })

    expect(line).toContain("reaped 1 of 4 scanned")
    expect(line).toContain("2 kept live")
    expect(line).toContain("1 kept young")
    expect(line).toContain("0 failed")
  })
})
