/**
 * A fresh worktree of one commit, submodules included
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The queue run).
 *
 * Every check runs in a worktree made for that change and that judgement and
 * removed afterwards: nothing is warmed, pooled or reused, so a result can
 * only ever be about the commit it names. Submodule materialization is
 * git-super's, unchanged, borrowing objects from the reference repository so
 * a fresh worktree does not mean a fresh network fetch.
 *
 * The plumbing's own narration (which submodule, borrowed or fetched, how
 * long) is trace-level: a debug log reads as the queue's decisions, not as a
 * git transcript. The caller hands in a logger only when trace is on.
 */

import { rmSync } from "node:fs"
import { materializeSubmodulesFromLocalWorktreeParallel } from "git-super/submodules"
import type { Git } from "./facts.ts"

/** The logger git-super narrates to; the queue hands one over only at trace. */
export type PlumbingLog = NonNullable<Parameters<typeof materializeSubmodulesFromLocalWorktreeParallel>[0]["log"]>

export type Worktree = Readonly<{
  /** The directory the commit is checked out in. */
  path: string
  /** The commit it holds. */
  commit: string
  /** Remove the worktree and everything under it. */
  remove(): Promise<void>
}>

/**
 * Check `commit` out at `path` as a detached worktree of `repo`, with every
 * gitlink materialized at the commit's own pin. A gitlink that cannot be
 * materialized throws, because a check run against a half-materialized tree
 * would judge something no commit describes.
 */
export async function freshWorktree(git: Git, repo: string, commit: string, path: string, plumbing?: PlumbingLog): Promise<Worktree> {
  await git(["worktree", "add", "--quiet", "--detach", path, commit])
  const materialized = await materializeSubmodulesFromLocalWorktreeParallel({
    ...(plumbing === undefined ? {} : { log: plumbing }),
    referenceWorktree: repo,
    worktree: path,
  })
  if (materialized.exitCode !== 0) {
    await removeWorktree(git, path)
    throw new Error(`submodules of ${commit.slice(0, 12)} did not materialize at ${path}: ${describe(materialized)}`)
  }
  return {
    commit,
    path,
    remove: async () => {
      await removeWorktree(git, path)
      plumbing?.trace?.("released worktree", { commit, path })
    },
  }
}

async function removeWorktree(git: Git, path: string): Promise<void> {
  // `worktree remove --force` refuses a tree with untracked files it did not
  // make; a check may have written anything, so the directory goes first and
  // git is told to forget the entry afterwards.
  rmSync(path, { force: true, recursive: true })
  await git(["worktree", "prune"])
}

function describe(result: Readonly<{ stderr?: string; stdout?: string; message?: string }>): string {
  return (result.message ?? result.stderr ?? result.stdout ?? "no detail").trim().slice(0, 400)
}
