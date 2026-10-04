/**
 * @reach fs-walk <fixture-only: the Git handle is an in-memory recorder and the git-super store is a stub>
 * @failure  pruneWorktrees derives the git COMMON DIR and hands it to
 *           createGitWorktreeStore as its `repo`, but git-super's `repo` is a
 *           CHECKOUT — its store reads `<repo>/.git`, so with `repo` = the git
 *           dir it reads `<gitdir>/.git` and `yrd submit` from a linked
 *           (commondir) worktree dies ENOENT lstat '<gitdir>/.git' (27392).
 * @level    l1 (pure — the store is replaced; the argument is the subject)
 * @consumer freshWorktree.remove -> removeWorktree -> pruneWorktrees
 */

import { describe, expect, it, vi } from "vitest"
import type { Git } from "../src/git.ts"
import { freshWorktree } from "../src/worktree.ts"

const store = vi.hoisted(() => ({ calls: [] as Array<Readonly<{ repo: string }>> }))

vi.mock("git-super/worktree", () => ({
  createGitWorktreeStore: (options: Readonly<{ repo: string }>) => {
    store.calls.push(options)
    return { prune: async (): Promise<void> => {} }
  },
}))

const CHECKOUT = "/fixture/reference-checkout"
const COMMIT = "d7273ea86df701a590e5b480e7bb1eab2b6145a9"

/** Answers the one question pruneWorktrees asked, plus the plain worktree add. */
function recorder(): Git {
  return async (args) => {
    if (args[0] === "ls-tree") return ""
    if (args.includes("--git-common-dir")) return `${CHECKOUT}/.git\n`
    return ""
  }
}

describe("pruneWorktrees names a CHECKOUT, not a git dir, as git-super's repo (27392)", () => {
  it("hands the reference checkout to createGitWorktreeStore when releasing a worktree", async () => {
    store.calls.length = 0
    const worktree = await freshWorktree(recorder(), CHECKOUT, COMMIT, "/fixture/run/wt")
    await worktree.remove()

    expect(store.calls).toHaveLength(1)
    expect(store.calls[0]?.repo).toBe(CHECKOUT)
    // NEGATIVE: a git dir is exactly what git-super's `repo` is NOT.
    expect(store.calls[0]?.repo).not.toBe(`${CHECKOUT}/.git`)
  })
})
