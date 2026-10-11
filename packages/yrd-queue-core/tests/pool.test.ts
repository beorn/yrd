/**
 * The pool's own contract (#28503): a warm tree is REALLY reused.
 *
 * The queue-level regressions assert where a check ran and that the path is
 * pooled, and a FRESH materialization at the same path satisfies both. Measured
 * 2026-10-10 by @dev/4: at cc95eaf9c3 the store's seam answered only for the
 * reference checkout, so reset() refused the pooled cwd, borrow() forgot the
 * tree and materialized fresh, and every borrow was cold. What only this file
 * can show is the artifact the pool exists to keep - node_modules - surviving a
 * second borrow, with no refusal note on the way.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, expect, it } from "vitest"
import type { Git } from "../src/git.ts"
import { WorktreePool } from "../src/pool.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { gitSuperBin, gitSuperSha } from "../../../tests/support/git-super-bin.ts"

const scratch: string[] = []

afterAll(() => {
  for (const dir of scratch) safeRemoveSync(dir, { within: realpathSync(tmpdir()), allowMissing: true })
})

const WITNESS = join("node_modules", "cache-witness")

/** A repository and a pool over it, with the notes each borrow left behind. */
async function poolFixture(): Promise<{
  git: Git
  repo: string
  pool: WorktreePool
  notes: string[]
}> {
  const root = mkdtempSync(join(tmpdir(), "yrd-pool-"))
  scratch.push(root)
  const repo = join(root, "repo")
  mkdirSync(repo)
  const env = {
    ...process.env,
    YRD_GIT_SUPER_BIN: join(gitSuperBin, "git-super"),
    YRD_GIT_SUPER_SHA: gitSuperSha,
  }
  const git = gitIn(repo, undefined, undefined, { env })
  await git(["init", "--quiet", "--initial-branch=main"])
  await git(["config", "user.email", "pool@yrd.test"])
  await git(["config", "user.name", "pool-fixture"])
  writeFileSync(join(repo, "target.txt"), "target\n")
  await git(["add", "target.txt"])
  await git(["commit", "--quiet", "-m", "target"])
  const hooksPath = join(root, "hooks")
  mkdirSync(hooksPath)
  const notes: string[] = []
  const pool = new WorktreePool({
    git,
    hooksPath,
    note: (cause) => notes.push(cause),
    ref: "main",
    repo,
    selection: git.selection,
    env,
    workdir: join(root, "queue"),
  })
  return { git, notes, pool, repo }
}

/** Borrow, leave an install cache where a setup would have, and give the tree back. */
async function borrowWithCache(pool: WorktreePool, commit: string): Promise<string> {
  const tree = await pool.borrow({ commit, role: "candidate", targetSha: commit })
  mkdirSync(join(tree.path, "node_modules"), { recursive: true })
  writeFileSync(join(tree.path, WITNESS), "retained install cache\n")
  await pool.give(tree)
  return tree.path
}

it("keeps the warm tree and its install cache across a second borrow", async () => {
  const { git, repo, pool, notes } = await poolFixture()
  // A private child is declared and never initialized, so this fixture needs no
  // store for it: the point is the cache, on a commit whose submodules exist.
  writeFileSync(
    join(repo, ".gitmodules"),
    '[submodule "vendor/secret"]\n\tpath = vendor/secret\n\turl = https://example.invalid/secret.git\n\tprivate = true\n',
  )
  await git(["add", ".gitmodules"])
  await git(["update-index", "--add", "--cacheinfo", "160000," + "1".repeat(40) + ",vendor/secret"])
  await git(["commit", "--quiet", "-m", "private child"])
  const commit = (await git(["rev-parse", "HEAD"])).trim()

  const first = await borrowWithCache(pool, commit)
  const second = await pool.borrow({ commit, role: "candidate", targetSha: commit })

  expect(second.path).toBe(first)
  expect(existsSync(join(second.path, WITNESS))).toBe(true)
  expect(existsSync(join(second.path, "vendor", "secret", ".git"))).toBe(false)
  expect(notes).toEqual([])
  await second.remove()
})

it("refuses reuse only for a tracked change inside a submodule, never for an untracked file", async () => {
  const { git, notes, pool, repo } = await poolFixture()
  const sub = join(repo, "..", "sub")
  mkdirSync(sub)
  writeFileSync(join(sub, "lib.ts"), "export const lib = 1\n")
  const subGit = gitIn(sub)
  await subGit(["init", "--quiet", "--initial-branch=main"])
  await subGit(["config", "user.email", "pool@yrd.test"])
  await subGit(["config", "user.name", "pool-fixture"])
  await subGit(["add", "lib.ts"])
  await subGit(["commit", "--quiet", "-m", "sub"])
  await git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sub, "vendor/pkg"])
  await git(["commit", "--quiet", "-m", "add submodule"])
  const commit = (await git(["rev-parse", "HEAD"])).trim()

  const first = await borrowWithCache(pool, commit)
  expect(existsSync(join(first, "vendor", "pkg", ".git"))).toBe(true)

  // Round two: an untracked file inside the submodule is cleaned, not refused.
  writeFileSync(join(first, "vendor", "pkg", "untracked.txt"), "untracked\n")
  const second = await pool.borrow({ commit, role: "candidate", targetSha: commit })
  expect(second.path).toBe(first)
  expect(existsSync(join(second.path, WITNESS))).toBe(true)
  expect(existsSync(join(second.path, "vendor", "pkg", "untracked.txt"))).toBe(false)
  expect(notes).toEqual([])
  await pool.give(second)

  // Round three: a TRACKED change inside the submodule refuses by name, so the
  // round is judged on a fresh tree rather than on bytes a check wrote.
  writeFileSync(join(first, "vendor", "pkg", "lib.ts"), "export const lib = 2\n")
  const third = await pool.borrow({ commit, role: "candidate", targetSha: commit })
  expect(notes.join(" ")).toContain("tracked modification")
  expect(existsSync(join(third.path, WITNESS))).toBe(false)
  await third.remove()
})

// C4: a pooled tree whose removal is REFUSED to protect a private store is skipped, named once, and the round
// continues on a spare path. It is never counted as free capacity and never retried in a later round.
it("abandons a pooled tree it may not delete, and continues on a spare path", async () => {
  const { git, repo, pool, notes } = await poolFixture()
  // A PUBLIC child the tree actually materializes, so a tracked change in it refuses reuse by name...
  const sub = join(repo, "..", "sub")
  mkdirSync(sub)
  writeFileSync(join(sub, "lib.ts"), "export const lib = 1\n")
  const subGit = gitIn(sub)
  await subGit(["init", "--quiet", "--initial-branch=main"])
  await subGit(["config", "user.email", "pool@yrd.test"])
  await subGit(["config", "user.name", "pool-fixture"])
  await subGit(["add", "lib.ts"])
  await subGit(["commit", "--quiet", "-m", "sub"])
  await git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sub, "vendor/pkg"])
  await git(["commit", "--quiet", "-m", "add submodule"])
  // ...and a PRIVATE child, declared and never initialized, whose store the guard protects.
  writeFileSync(
    join(repo, ".gitmodules"),
    '[submodule "vendor/pkg"]\n\tpath = vendor/pkg\n\turl = ' +
      sub +
      '\n[submodule "vendor/secret"]\n\tpath = vendor/secret\n\turl = https://example.invalid/secret.git\n\tprivate = true\n',
  )
  await git(["add", ".gitmodules"])
  await git(["update-index", "--add", "--cacheinfo", "160000," + "1".repeat(40) + ",vendor/secret"])
  await git(["commit", "--quiet", "-m", "declare the private child"])
  const commit = (await git(["rev-parse", "HEAD"])).trim()

  const first = await borrowWithCache(pool, commit)
  // The store the guard protects, placed in THIS tree's own admin dir, where prune and rmSync would take it.
  const admin = (
    await git(["rev-parse", "--path-format=absolute", "--git-path", join("worktrees", basename(first))])
  ).trim()
  mkdirSync(join(admin, "modules", "vendor", "secret"), { recursive: true })
  // A TRACKED change inside the public child: reuse is refused by name, so the round must discard the tree.
  writeFileSync(join(first, "vendor", "pkg", "lib.ts"), "export const lib = 2\n")

  const second = await pool.borrow({ commit, role: "candidate", targetSha: commit })
  expect(notes.join(" ")).toContain("tracked modification")
  expect(existsSync(first), "the tree is skipped, never deleted").toBe(true)
  expect(existsSync(join(admin, "modules", "vendor", "secret"))).toBe(true)
  expect(second.path, "an abandoned tree is not free capacity").not.toBe(first)
  expect(second.path).toContain("-spare-")
  expect(notes.join(" ")).toContain("keeps it and continues")

  const third = await pool.borrow({ commit, role: "candidate", targetSha: commit })
  // Named ONCE: a later round must not retry a removal nobody has cured.
  expect(notes.filter((note) => note.includes("keeps it and continues"))).toHaveLength(1)
  await third.remove()
  await second.remove()
})
