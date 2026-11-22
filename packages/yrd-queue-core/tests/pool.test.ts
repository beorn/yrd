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
 *
 * @reach fs-walk <fixture-only: mkdtempSync pool roots, and the held trees this file moves aside and reads>
 */

import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, expect, it } from "vitest"
import type { Git } from "../src/git.ts"
import { WorktreePool } from "../src/pool.ts"
import { SetupFailed } from "../src/worktree.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { gitSuperBin, gitSuperSha } from "../../../tests/support/git-super-bin.ts"

const scratch: string[] = []
/** Fixtures deliberately OUTSIDE tmpdir(), where removely's default allowed root refuses them. */
const outsideScratch: string[] = []

afterAll(() => {
  for (const dir of scratch) safeRemoveSync(dir, { within: realpathSync(tmpdir()), allowMissing: true })
  for (const dir of outsideScratch) {
    const parent = realpathSync(dirname(dir))
    safeRemoveSync(dir, { within: parent, allowedRoots: [parent], allowMissing: true })
  }
})

const WITNESS = join("node_modules", "cache-witness")

/** A repository and a pool over it, with the notes each borrow left behind. */
async function poolFixture(outside?: string): Promise<{
  git: Git
  repo: string
  pool: WorktreePool
  newPool: () => WorktreePool
  notes: string[]
}> {
  const root = outside ?? mkdtempSync(join(tmpdir(), "yrd-pool-"))
  if (outside === undefined) scratch.push(root)
  else outsideScratch.push(root)
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
  const options = {
    git,
    hooksPath,
    note: (cause: string) => notes.push(cause),
    ref: "main",
    repo,
    selection: git.selection,
    env,
    workdir: join(root, "queue"),
  }
  // The queue makes a NEW pool every round (#28503 keeps the warm tree, not the object), so a case that must
  // hold across the round boundary builds its second round through this, not by borrowing twice from one object.
  const newPool = (): WorktreePool => new WorktreePool({ ...options })
  return { git, newPool, notes, pool: newPool(), repo }
}

/** Borrow, leave an install cache where a setup would have, and give the tree back. */
async function borrowWithCache(pool: WorktreePool, commit: string): Promise<string> {
  const tree = await pool.borrow({ commit, role: "candidate", targetSha: commit })
  mkdirSync(join(tree.path, "node_modules"), { recursive: true })
  writeFileSync(join(tree.path, WITNESS), "retained install cache\n")
  await pool.give(tree)
  return tree.path
}

/** A real local child at vendor/pkg on a new commit, so the pool builds a submodule-bearing tree over --reference. */
async function withLocalSubmodule(repo: string, git: Git): Promise<string> {
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
  return (await git(["rev-parse", "HEAD"])).trim()
}

it("keeps the warm tree and its install cache across a second borrow", async () => {
  const { git, notes, pool, repo } = await poolFixture()
  const commit = await withLocalSubmodule(repo, git)

  const first = await borrowWithCache(pool, commit)
  const second = await pool.borrow({ commit, role: "candidate", targetSha: commit })

  expect(second.path).toBe(first)
  expect(existsSync(join(second.path, WITNESS))).toBe(true)
  expect(existsSync(join(second.path, "vendor", "pkg", ".git"))).toBe(true)
  expect(notes).toEqual([])
  await second.remove()
})

it("refuses reuse only for a tracked change inside a submodule, never for an untracked file", async () => {
  const { git, notes, pool, repo } = await poolFixture()
  const commit = await withLocalSubmodule(repo, git)

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

/**
 * A scratch root OUTSIDE `tmpdir()`, which is the whole point of the 28751 case:
 * removely's DEFAULT `allowedRoots` is [tmpdir()], so a fixture under mkdtemp()
 * proves nothing about the real pool, whose trees live at
 * /hh/var/yrd-workdir/<repo>/worktrees/pool while the service's TMPDIR is
 * /hh/dev/.git/yrd/tmp. `homedir()` is NOT reliably outside it — the Vitest home
 * guard pins HOME to `<run root>/home`, i.e. INSIDE tmpdir(), measured 2026-10-10
 * — so prefer tmpdir()'s own parent, outside by construction, and fall back to
 * homedir() where that parent is not writable.
 */
function scratchOutsideTmpdir(): string {
  const tmp = resolve(tmpdir())
  const candidates = [dirname(tmp), homedir()].filter((candidate) => {
    const parent = resolve(candidate)
    return parent !== tmp && !parent.startsWith(`${tmp}${sep}`)
  })
  const refused: string[] = []
  for (const parent of candidates) {
    try {
      accessSync(parent, constants.W_OK)
      return mkdtempSync(join(parent, ".yrd-pool-selftest-"))
    } catch {
      // silent-fallback-allow: a directory this process cannot write is not the
      // fixture's host, so the next candidate must carry it; the throw below
      // names every host refused rather than leaving a bare empty result.
      refused.push(parent)
    }
  }
  throw new Error(`pool fixture: no writable root outside ${tmp} to host the 28751 case; refused ${refused.join(", ")}`)
}

it("discards a dirty warm tree whose pool root is outside tmpdir (28751: allowedRoots)", async () => {
  const { git, notes, pool, repo } = await poolFixture(scratchOutsideTmpdir())
  const commit = await withLocalSubmodule(repo, git)

  const first = await borrowWithCache(pool, commit)
  // A tracked change is what refuses reuse; the REMOVAL that follows it is the
  // one whose containment root is outside removely's default allowed roots.
  writeFileSync(join(first, "vendor", "pkg", "lib.ts"), "export const lib = 2\n")

  const second = await pool.borrow({ commit, role: "candidate", targetSha: commit })
  expect(notes.join(" ")).toContain("tracked modification")
  expect(second.path).toBe(first)
  expect(existsSync(join(second.path, WITNESS))).toBe(false)
  await second.remove()
})

/** The one tree a hold moved aside for `role`, read from the pool beside the slot. */
function heldTrees(slot: string): string[] {
  // `<workdir>/worktrees/pool/<ref>/<role>` -> `<workdir>/worktrees/pool/held/<ref>/<role>-<stamp>`
  const held = join(dirname(dirname(slot)), "held", basename(dirname(slot)))
  return existsSync(held)
    ? readdirSync(held)
        .filter((entry) => entry.startsWith(`${basename(slot)}-`))
        .map((entry) => join(held, entry))
    : []
}

/**
 * @cto 2026-11-22 (#34952): a path inside the pooled tree is containment evidence, not proof of who wrote the bytes.
 * The clean's own discard set is read first, and a tree that holds another writer's repository is moved aside
 * intact instead of being cleaned or removed.
 */
it("holds a warm tree whose discard set holds an independent repository, and keeps its files", async () => {
  const { git, newPool, notes, pool } = await poolFixture()
  const commit = (await git(["rev-parse", "HEAD"])).trim()

  const first = await pool.borrow({ commit, role: "candidate", targetSha: commit })
  // Another writer's repository inside the pooled checkout, at no path the candidate tracks or gitlinks.
  mkdirSync(join(first.path, "elsewhere", ".git"), { recursive: true })
  writeFileSync(join(first.path, "elsewhere", ".git", "HEAD"), "ref: refs/heads/main\n")
  writeFileSync(join(first.path, "elsewhere", "work.txt"), "tracked by the other repository\n")
  await pool.give(first)
  expect(readFileSync(join(first.path, "elsewhere", "work.txt"), "utf8")).toBe("tracked by the other repository\n")

  const second = await newPool().borrow({ commit, role: "candidate", targetSha: commit })
  expect(second.path).toBe(first.path)
  expect(existsSync(join(second.path, "elsewhere"))).toBe(false)
  expect(notes.some((note) => note.includes("held, not cleaned"))).toBe(true)

  const kept = heldTrees(first.path)
  expect(kept).toHaveLength(1)
  expect(readFileSync(join(kept[0] ?? "", "elsewhere", "work.txt"), "utf8")).toBe("tracked by the other repository\n")
  await second.remove()
})

it("holds a warm tree with a subtree it cannot read, instead of treating it as absent", async () => {
  const { git, notes, pool } = await poolFixture()
  const commit = (await git(["rev-parse", "HEAD"])).trim()

  const first = await pool.borrow({ commit, role: "candidate", targetSha: commit })
  mkdirSync(join(first.path, "private"))
  writeFileSync(join(first.path, "private", "secret.txt"), "not this program's bytes\n")
  chmodSync(join(first.path, "private"), 0o000)
  try {
    const second = await pool.borrow({ commit, role: "candidate", targetSha: commit })
    expect(second.path).toBe(first.path)
    expect(notes.some((note) => note.includes("unreadable"))).toBe(true)
    const kept = heldTrees(first.path)
    expect(kept).toHaveLength(1)
    chmodSync(join(kept[0] ?? "", "private"), 0o700)
    expect(readFileSync(join(kept[0] ?? "", "private", "secret.txt"), "utf8")).toBe("not this program's bytes\n")
    await second.remove()
  } finally {
    // The moved copy is the only survivor; the slot tree was renamed, so restoring here is best-effort.
    if (existsSync(join(first.path, "private"))) chmodSync(join(first.path, "private"), 0o700)
  }
})

/**
 * The depth this check walks stops somewhere, and a subtree past it that was never read is unknown, not pool
 * scratch: a repository nested deeper must hold the tree rather than be deleted by the clean (@dev/15, #34952).
 */
it("holds a warm tree whose other writer's repository sits past the inspected depth", async () => {
  const { git, newPool, notes, pool } = await poolFixture()
  const commit = (await git(["rev-parse", "HEAD"])).trim()

  const first = await pool.borrow({ commit, role: "candidate", targetSha: commit })
  const nested = Array.from({ length: 10 }, (_, index) => `d${index + 1}`)
  const deep = join(first.path, ...nested)
  mkdirSync(join(deep, ".git"), { recursive: true })
  writeFileSync(join(deep, ".git", "HEAD"), "ref: refs/heads/main\n")
  writeFileSync(join(deep, "work.txt"), "tracked by the other repository\n")
  await pool.give(first)
  expect(readFileSync(join(deep, "work.txt"), "utf8")).toBe("tracked by the other repository\n")

  const second = await newPool().borrow({ commit, role: "candidate", targetSha: commit })
  expect(second.path).toBe(first.path)
  expect(existsSync(join(second.path, "d1"))).toBe(false)
  expect(notes.some((note) => note.includes("uninspected depth"))).toBe(true)

  const kept = heldTrees(first.path)
  expect(kept).toHaveLength(1)
  expect(readFileSync(join(kept[0] ?? "", ...nested, "work.txt"), "utf8")).toBe(
    "tracked by the other repository\n",
  )
  await second.remove()
})
