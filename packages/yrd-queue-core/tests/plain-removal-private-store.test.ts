/**
 * @reach fs-walk <fixture-only: temporary repositories under the system temp dir>
 * @failure A plain removal (rmSync + prune, safeRemoveSync) deletes a declared-private submodule store
 *          without asking the declaration, because it never reaches git-super's own refusal (28661).
 * @level   l1
 * @consumer the queue's per-run tree removal and the warm pool's forget()
 * @testonly none
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { PrivateStoreRefusalError } from "git-super/worktree"
import {
  discardWorktree,
  isPrivateStoreRefusal,
  prepareWorktree,
  refusePrivateStoreRemoval,
  removeWorktreeRunScaffold,
  SetupFailed,
  type Worktree,
} from "../src/worktree.ts"
import { testGitIn } from "../../../tests/support/test-git-in.ts"
import { gitSuperBin, gitSuperSha } from "../../../tests/support/git-super-bin.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

const env = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
  YRD_GIT_SUPER_BIN: join(gitSuperBin, "git-super"),
  YRD_GIT_SUPER_SHA: gitSuperSha,
}

const author = ["-c", "user.email=plain-removal@yrd.test", "-c", "user.name=yrd"] as const

/** A product with `vendor/dep` as a submodule, a linked worktree that INITIALIZED it, and the store that follows. */
async function fixture(
  root: string,
  declare: "never" | "head" | "main",
  // The linked worktree's own parent, so a caller can put it INSIDE a scaffold directory it then sweeps (28661 C4).
  linkedUnder: string = root,
): Promise<Readonly<{ repo: string; linked: string; store: string }>> {
  const repo = join(root, "product")
  const component = join(root, "component")
  mkdirSync(repo, { recursive: true })
  mkdirSync(component, { recursive: true })
  const repoGit = testGitIn(repo, undefined, undefined, { env })
  const componentGit = testGitIn(component, undefined, undefined, { env })
  await componentGit(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(component, "dep.txt"), "dep\n")
  await componentGit(["add", "dep.txt"])
  await componentGit([...author, "commit", "--quiet", "--message", "dep"])
  await repoGit(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(repo, "root.txt"), "root\n")
  await repoGit(["add", "root.txt"])
  await repoGit([...author, "commit", "--quiet", "--message", "root"])
  await repoGit(["submodule", "add", "--name", "dep", component, "vendor/dep"])
  await repoGit([...author, "commit", "--quiet", "--message", "add the submodule"])
  const linked = join(linkedUnder, "linked")
  await repoGit(["worktree", "add", "--quiet", "--detach", linked, "HEAD"])
  const linkedGit = testGitIn(linked, undefined, undefined, { env })
  await linkedGit(["submodule", "update", "--init", "vendor/dep"])
  const store = (await linkedGit(["rev-parse", "--path-format=absolute", "--git-path", "modules/dep"])).trim()
  if (declare !== "never") {
    await repoGit(["config", "-f", ".gitmodules", "submodule.dep.private", "true"])
    await repoGit(["add", ".gitmodules"])
    await repoGit([...author, "commit", "--quiet", "--message", "declare the submodule private"])
  }
  return { repo, linked, store }
}

describe("a plain removal asks the declaration before it deletes a checkout (28661)", () => {
  it("refuses when the worktree's own HEAD declares the submodule private", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-plain-removal-head-"))
    roots.push(root)
    const { repo, linked, store } = await fixture(root, "head")
    expect(existsSync(store)).toBe(true)

    const error = await refusePrivateStoreRemoval(testGitIn(repo, undefined, undefined, { env }), linked, repo).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain(store)
    expect(existsSync(store)).toBe(true)
    expect(existsSync(linked)).toBe(true)
  })

  it("refuses when only current main declares it, for a target that predates the declaration", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-plain-removal-main-"))
    roots.push(root)
    const { repo, linked, store } = await fixture(root, "main")
    expect(existsSync(store)).toBe(true)

    const error = await refusePrivateStoreRemoval(testGitIn(repo, undefined, undefined, { env }), linked, repo).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain(store)
    expect(existsSync(store)).toBe(true)
  })

  it("does not refuse an ordinary submodule that declares no privacy", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-plain-removal-public-"))
    roots.push(root)
    const { repo, linked } = await fixture(root, "never")

    await expect(refusePrivateStoreRemoval(testGitIn(repo, undefined, undefined, { env }), linked, repo)).resolves.toBe(
      undefined,
    )
  })

  it("refuses BY CLASS when a store-bearing admin dir records no readable HEAD (N1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-plain-removal-no-head-"))
    roots.push(root)
    const { repo, linked, store } = await fixture(root, "head")
    // The checkout's `.git` file names its own admin dir; point that admin dir's HEAD at a ref that does not
    // resolve, so `rev-parse --verify HEAD` FAILS while `modules/` and the store it holds both remain.
    const admin = readFileSync(join(linked, ".git"), "utf8")
      .trim()
      .replace(/^gitdir:\s*/u, "")
    writeFileSync(join(admin, "HEAD"), "ref: refs/heads/this-branch-does-not-exist\n")

    const error = await refusePrivateStoreRemoval(testGitIn(repo, undefined, undefined, { env }), linked, repo).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    // The CLASS is what lets `discardWorktree` skip the tree and let the round continue: an unreadable HEAD under
    // a store-bearing admin dir must not become a plain fault that wedges the round (the C4 defect).
    expect(error).toBeInstanceOf(PrivateStoreRefusalError)
    expect(isPrivateStoreRefusal(error)).toBe(true)
    expect(String(error)).toContain(admin)
    // Pin the CATCH, not the empty-HEAD fallback: an unresolvable HEAD exits non-zero, so the git call throws.
    expect(String(error)).toContain("cannot be read")
    expect(existsSync(store)).toBe(true)
    expect(existsSync(linked)).toBe(true)
  })
})

// C4: a REFUSED removal must not wedge the round. `discardWorktree` is what every cleanup caller now uses: the
// tree is skipped, named ONCE, and the caller continues with its own verdict intact.
describe("a refused discard skips the tree, names it once and lets the round continue (28661 C4)", () => {
  it("keeps the worktree, warns once, and resolves instead of throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-discard-refused-"))
    roots.push(root)
    const { repo, linked, store } = await fixture(root, "head")
    const git = testGitIn(repo, undefined, undefined, { env })
    const tree: Worktree = {
      path: linked,
      commit: "HEAD",
      excludedSubmodules: [],
      remove: async () => {
        await refusePrivateStoreRemoval(git, linked, repo)
        rmSync(linked, { force: true, recursive: true })
      },
    }
    const warned: string[] = []
    const spy = vi.spyOn(console, "warn").mockImplementation((line?: unknown) => {
      warned.push(String(line))
    })
    try {
      await expect(discardWorktree(tree)).resolves.toBeUndefined()
      await expect(discardWorktree(tree)).resolves.toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    expect(existsSync(linked)).toBe(true)
    expect(existsSync(store)).toBe(true)
    expect(warned.filter((line) => line.includes(linked))).toHaveLength(1)
  })
})

// C4: the cleanup of a FAILED preparation runs through the same handler, so a store-protection refusal cannot
// mask the verdict the caller classifies (worktree.ts prepareWorktree's catch).
describe("a refused cleanup keeps the preparation verdict (28661 C4)", () => {
  it("throws SetupFailed, not the refusal, and leaves the tree and its store in place", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-prepare-refused-"))
    roots.push(root)
    // The LINKED worktree is at the commit that predates the private declaration; current main carries it. The
    // prepared tree is materialized at that same pre-declaration commit, so its materialization is complete,
    // while the guard that runs at cleanup still sees main's declaration (fixture "main").
    const { repo } = await fixture(root, "main")
    const git = testGitIn(repo, undefined, undefined, { env })
    const before = (await git(["rev-parse", "HEAD~1"])).trim()
    const path = join(root, "prepared")
    const logDir = join(root, "setup-log")
    mkdirSync(logDir, { recursive: true })
    const store = join(repo, ".git", "worktrees", path.slice(path.lastIndexOf("/") + 1), "modules", "dep")

    const failure = await prepareWorktree(git, repo, before, path, {
      targetSha: before,
      env,
      // The store the guard protects is placed by the setup itself, inside THIS tree's own admin dir, right
      // before the setup fails: no read, copy or hash of any private byte (27058, chief ruling c8a3b06d).
      setup: {
        run: 'admin=$(sed -n "s/^gitdir: //p" .git) && mkdir -p "$admin/modules/dep" && exit 17',
        logDir,
        tmpdir: root,
      },
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(failure, "the setup verdict reaches the caller").toBeInstanceOf(SetupFailed)
    expect(String(failure)).not.toContain("private submodule store")
    expect(existsSync(path), "a refused cleanup leaves the tree in place").toBe(true)
    expect(existsSync(store), "the store the guard protects survives").toBe(true)
  })
})

// C4: the ENCLOSING cleanup — not just the per-tree discard — must not walk past the refusal. The check
// command, submit's compose scratch and admission's scratch all swept their root with one `rmSync(..., recursive)`,
// which deleted the very checkout `discardWorktree` had just reported kept (review2 HOLD, 28661).
describe("the enclosing scaffold sweep keeps a checkout the removal policy preserved (28661 C4)", () => {
  it("clears the scaffold but leaves the kept checkout, its retained bytes and its store whole", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-scaffold-sweep-"))
    roots.push(root)
    const scratch = join(root, "scratch")
    mkdirSync(scratch, { recursive: true })
    const { repo, linked, store } = await fixture(root, "head", scratch)
    // Scaffold a round's root the way every caller lays one out: a claim file, a helper dir, and the tree.
    writeFileSync(join(scratch, ".pid"), "1\n")
    mkdirSync(join(scratch, "hooks-disabled"))
    const retained = join(linked, "precious.txt")
    writeFileSync(retained, "synthetic retained bytes")
    const git = testGitIn(repo, undefined, undefined, { env })
    const tree: Worktree = {
      path: linked,
      commit: "HEAD",
      excludedSubmodules: [],
      remove: async () => {
        await refusePrivateStoreRemoval(git, linked, repo)
        rmSync(linked, { force: true, recursive: true })
      },
    }
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await discardWorktree(tree)
      removeWorktreeRunScaffold(scratch)
    } finally {
      spy.mockRestore()
    }

    expect(existsSync(linked), "the refused checkout survives the enclosing sweep").toBe(true)
    expect(existsSync(retained), "the bytes the refusal retained survive").toBe(true)
    expect(existsSync(store), "the store the guard protects survives").toBe(true)
    expect(existsSync(scratch), "a kept checkout keeps its scaffold").toBe(true)
    expect(existsSync(join(scratch, ".pid")), "the claim file goes, so the run is reapable").toBe(false)
    expect(existsSync(join(scratch, "hooks-disabled")), "ordinary scaffold goes").toBe(false)
  })

  it("removes the whole root once nothing was kept", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-scaffold-clear-"))
    roots.push(root)
    const scratch = join(root, "scratch")
    mkdirSync(join(scratch, "check", "abc123"), { recursive: true })
    writeFileSync(join(scratch, ".pid"), "1\n")
    writeFileSync(join(scratch, "check", "abc123", "junk.txt"), "junk")

    removeWorktreeRunScaffold(scratch)

    expect(existsSync(scratch)).toBe(false)
  })

  // The gate's own id, on the refusal a person reads: gate-report finds a vendor refusal only through a literal
  // `@gate/` id in the source (tools/gate-report.ts gateIdSites, --recurse-submodules), and the operator reads
  // the same string.
  it("names the gate id and the override in the refusal it prints", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-plain-removal-gate-id-"))
    roots.push(root)
    const { repo, linked, store } = await fixture(root, "head")

    const error = await refusePrivateStoreRemoval(testGitIn(repo, undefined, undefined, { env }), linked, repo).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(String(error)).toContain("@gate/git-worktree-private-store:")
    expect(String(error)).toContain('--discard-private-store --reason "<text>"')
    expect(existsSync(store)).toBe(true)
  })

  // The same pair git-super's removal takes, on the repo-side guard: a reason is REQUIRED (an empty one is a
  // refusal, not consent), and a reasoned discard journals the actor and the reason before any byte goes.
  it("passes the declaration only for a reasoned override, and journals the actor and the reason", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-plain-removal-discard-"))
    roots.push(root)
    const { repo, linked, store } = await fixture(root, "head")
    const journal: Array<Readonly<{ store: string; reason: string; actor: string | null }>> = []

    const refused = await refusePrivateStoreRemoval(testGitIn(repo, undefined, undefined, { env }), linked, repo, {
      discardPrivateStore: { reason: "  " },
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(refused).toBeInstanceOf(PrivateStoreRefusalError)
    expect(existsSync(store)).toBe(true)

    await refusePrivateStoreRemoval(testGitIn(repo, undefined, undefined, { env }), linked, repo, {
      discardPrivateStore: { reason: "abandoned unpushed draft", actor: "seat-under-test" },
      journal: (record) => journal.push(record),
    })

    expect(journal).toHaveLength(1)
    expect(journal[0]?.store).toBe(store)
    expect(journal[0]?.reason).toBe("abandoned unpushed draft")
    expect(journal[0]?.actor).toBe("seat-under-test")
    expect(existsSync(store)).toBe(true)
  })
})
