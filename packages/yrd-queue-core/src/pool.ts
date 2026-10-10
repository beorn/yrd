/**
 * A worktree a round BORROWS and gives back, instead of one it makes and throws
 * away: one directory per (repository, ref, role), kept warm between rounds so
 * `node_modules` survives and only `setup:` re-runs (#28503, ruling 2026-10-10).
 *
 * The per-run parents stay for `yrd check`, which keeps fresh trees as today:
 * only the event queue's own check tree and its base-probe tree are pooled, and
 * both live under `worktrees/pool/`, a sibling a run's teardown cannot reach.
 *
 * The reset is the whole contract, so it is one function and one order: refuse
 * a tracked modification (a check wrote over the candidate and the reuse would
 * judge the write, not the commit), move to the candidate detached with hooks
 * off and read HEAD back, clean every ignored and untracked file except
 * `node_modules` in the root and in every submodule, then re-sync the
 * submodules to the candidate's gitlinks through the materializer that made
 * them. Setup ALWAYS runs afterwards, because `node_modules` is the cache and
 * nothing else may be: a stale ignored artifact must never reach a judgment.
 */

import { existsSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Process } from "@yrd/process"
import { createGitWorktreeStore } from "git-super/worktree"
import { gitIn, seamProcess, type Git, type GitInvocationOptions, type GitSelection } from "./git.ts"
import { declaredPrivateSubmodules } from "./private-submodules.ts"
import {
  checkedTree,
  prepareWorktree,
  runSetup,
  SetupFailed,
  type PlumbingLog,
  type PreparedWorktree,
  type SetupRan,
  type SetupSpec,
} from "./worktree.ts"

/** The two trees a round needs: the candidate it judges, and the target it compares against. */
export type PoolRole = "candidate" | "base"

/** Where one pooled tree lives: a sibling of the per-run parents, keyed by the ref whose rounds are serialized. */
export function pooledWorktreePath(workdir: string, ref: string, role: PoolRole): string {
  return join(workdir, "worktrees", "pool", ref.replaceAll("/", "_"), role)
}

/** What one borrow needs: the commit to stand at, and how to provision it. */
export type BorrowPooled = Readonly<{
  role: PoolRole
  commit: string
  targetSha: string
  setup?: SetupSpec
  record?: (ran: SetupRan) => void
  starting?: (about: Readonly<{ start: string; log: string }>) => void
  /** Names a refused reuse on the round's own output; falls back to the pool's. */
  note?: (cause: string) => void
}>

export type WorktreePoolOptions = Readonly<{
  /** The run directory whose `worktrees/` holds the pool; `yrd check` never passes one. */
  workdir: string
  /** The ref whose rounds are serialized, so two refs never share one warm tree. */
  ref: string
  repo: string
  git: Git
  /** The queue-owned empty hooks directory every reset command runs with. */
  hooksPath: string
  process?: Process
  env?: NodeJS.ProcessEnv
  selection?: GitSelection
  gitOptions?: GitInvocationOptions
  populateReference?: boolean
  plumbing?: PlumbingLog
  /**
   * Names a refused reuse, so the round's own output carries why a warm tree
   * was abandoned instead of the reader finding it only on disk. A borrow may
   * override it with one that names its own branch and head.
   */
  note?: (cause: string) => void
}>

/** The pool of one ref: borrow a role's tree, give it back, never make one per phase. */
export class WorktreePool {
  constructor(private readonly options: WorktreePoolOptions) {}

  /** A prepared tree of `commit` for `role`, warm when it can be, fresh when it must be. */
  async borrow(input: BorrowPooled): Promise<PreparedWorktree> {
    const path = pooledWorktreePath(this.options.workdir, this.options.ref, input.role)
    if (!existsSync(path)) return await this.materialize(path, input)
    let cause: string
    try {
      cause = await this.reuseRefusal(path)
    } catch (error) {
      // Unreadable ground: not a tree this round can warm, and not one it can
      // judge either. The rebuild below is fresh-by-construction, so it is safe
      // to abandon the directory, and the cause is named rather than swallowed.
      this.note(input, `pooled ${input.role} tree could not be inspected: ${messageOf(error)}`)
      await this.forget(path)
      return await this.materialize(path, input)
    }
    if (cause !== "") {
      this.note(input, cause)
      await this.forget(path)
      return await this.materialize(path, input)
    }
    try {
      await this.reset(path, input)
    } catch (error) {
      this.note(input, `pooled ${input.role} tree could not be reset: ${messageOf(error)}`)
      await this.forget(path)
      return await this.materialize(path, input)
    }
    return await this.setupAt(path, input)
  }

  /**
   * Return a borrowed tree to the pool. The tree is NOT removed: its
   * `node_modules` is the cache the pool exists to keep, and a tree whose setup
   * failed was already discarded by `borrow`.
   *
   * The clean here is the one part of a return that can fail, and the caller
   * decides what that failure may do — never change a verdict that is already
   * measured. The next borrow resets and cleans again regardless, so a return
   * that fails costs a warning and nothing else.
   */
  async give(tree: PreparedWorktree): Promise<void> {
    await this.clean(tree.path)
    this.options.plumbing?.trace?.("returned worktree to the pool", { commit: tree.commit, path: tree.path })
  }

  /** The note a borrow carries: its own when it has one, the pool's otherwise, silence when neither. */
  private note(input: BorrowPooled, cause: string): void {
    const note = input.note ?? this.options.note
    note?.(cause)
  }

  /** A fresh tree, materialized and provisioned by the same code `yrd check` uses. */
  private async materialize(path: string, input: BorrowPooled): Promise<PreparedWorktree> {
    return await prepareWorktree(this.options.git, this.options.repo, input.commit, path, {
      targetSha: input.targetSha,
      queueRun: true,
      ...this.selectionOptions(),
      ...(input.setup === undefined ? {} : { setup: input.setup }),
      ...(input.record === undefined ? {} : { record: input.record }),
      ...(input.starting === undefined ? {} : { starting: input.starting }),
    })
  }

  /**
   * Why this warm tree must NOT be reused, or `""` when it may be. A tracked
   * modification is the one refusal that matters: the bytes on disk are not the
   * candidate's, so the reset's checkout would either fail or judge the write.
   * Submodule rows count too — a checkout that no longer matches the recorded
   * gitlink is the same lie one level down.
   */
  private async reuseRefusal(path: string): Promise<string> {
    const at = this.gitAt(path)
    const status = (await at(["status", "--porcelain", "--untracked-files=no"])).trim()
    if (status === "") return ""
    const first = status.split("\n")[0] ?? ""
    return `a tracked modification stands in the pooled tree (${first.trim()})`
  }

  /**
   * Move a warm tree to the candidate and make it clean: detached with hooks
   * off, HEAD read back, submodules re-synced to the candidate's gitlinks, and
   * every ignored or untracked file but `node_modules` removed in the root and
   * in every submodule.
   */
  private async reset(path: string, input: BorrowPooled): Promise<void> {
    const at = this.gitAt(path)
    await at(["-c", `core.hooksPath=${this.options.hooksPath}`, "checkout", "--detach", input.commit])
    const head = (await at(["rev-parse", "HEAD"])).trim()
    if (head !== input.commit) {
      throw new Error(`pooled tree ${path} read back ${head} after checking out ${input.commit}`)
    }
    await this.store().materializeSubmodules(path, { force: true, hooks: "quarantine" })
    await this.clean(path)
  }

  /**
   * `git clean -ffdx`, keeping `node_modules` and leaving submodules to their
   * own turn: a submodule directory is another repository, so it is excluded
   * here and cleaned from inside, one level down, by this same function.
   */
  private async clean(path: string): Promise<void> {
    const at = this.gitAt(path)
    const submodules = await gitlinkPaths(at)
    const exclusions = [...submodules, "node_modules"].flatMap((name) => ["-e", name])
    await at(["clean", "-ffdx", ...exclusions])
    for (const submodule of submodules) {
      // A gitlink the tree did not materialize names no repository to clean:
      // `-e` above already left it alone.
      if (!existsSync(join(path, submodule, ".git"))) continue
      await this.clean(join(path, submodule))
    }
  }

  /** A warm tree's `checkedTree`, then the setup that always re-runs on it. */
  private async setupAt(path: string, input: BorrowPooled): Promise<PreparedWorktree> {
    try {
      const tree = await checkedTree(path, input.targetSha, this.options.process, this.options.selection, {
        ...(this.options.env === undefined ? {} : { env: this.options.env }),
        ...this.options.gitOptions,
      })
      const prepared: PreparedWorktree = {
        commit: input.commit,
        excludedSubmodules: await this.excludedSubmodules(input.commit),
        path,
        remove: async () => {
          await this.forget(path)
        },
        tree,
      }
      if (input.setup !== undefined) {
        await runSetup({
          cwd: path,
          tree,
          setup: input.setup,
          queueRun: true,
          ...(input.record === undefined ? {} : { record: input.record }),
          ...(input.starting === undefined ? {} : { starting: input.starting }),
          ...(this.options.env === undefined ? {} : { env: this.options.env }),
          ...(this.options.process === undefined ? {} : { process: this.options.process }),
        })
      }
      return prepared
    } catch (error) {
      // A failed setup discards the tree: a half-installed cache must never be
      // the next round's warm start. The materializer does this for a fresh
      // tree; this is the same ending for a warm one.
      if (error instanceof SetupFailed) await this.forget(path)
      throw error
    }
  }

  /** The root-relative private submodules of `commit`, so a warm tree carries the same boundary a fresh one does. */
  private async excludedSubmodules(commit: string): Promise<readonly string[]> {
    const modules = await this.options.git(["ls-tree", commit, "--", ".gitmodules"])
    if (modules.trim() === "") return []
    return await declaredPrivateSubmodules(this.options.git, resolve(this.options.repo), commit)
  }

  /** Remove a pooled tree and forget its registration, exactly as a per-run tree's removal does. */
  private async forget(path: string): Promise<void> {
    rmSync(path, { force: true, recursive: true })
    await this.store().prune()
  }

  private store(): ReturnType<typeof createGitWorktreeStore> {
    const checkout = this.options.repo
    return createGitWorktreeStore({ gitProcess: seamProcess(this.options.git, checkout), repo: checkout })
  }

  private gitAt(path: string): Git {
    if (this.options.selection === undefined) {
      throw new Error(`yrd: the pooled tree at ${path} needs a resolved Git selection`)
    }
    return gitIn(path, this.options.process, this.options.selection, {
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...this.options.gitOptions,
    })
  }

  private selectionOptions(): Pick<
    Parameters<typeof prepareWorktree>[4],
    "env" | "gitOptions" | "plumbing" | "populateReference" | "process" | "selection"
  > {
    return {
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(this.options.gitOptions === undefined ? {} : { gitOptions: this.options.gitOptions }),
      ...(this.options.plumbing === undefined ? {} : { plumbing: this.options.plumbing }),
      ...(this.options.populateReference === undefined ? {} : { populateReference: this.options.populateReference }),
      ...(this.options.process === undefined ? {} : { process: this.options.process }),
      ...(this.options.selection === undefined ? {} : { selection: this.options.selection }),
    }
  }
}

/** The root-relative paths a tree's HEAD records a gitlink at, at any depth. */
async function gitlinkPaths(at: Git): Promise<readonly string[]> {
  const entries = (await at(["ls-tree", "-r", "-z", "--full-tree", "HEAD"])).split("\0")
  const paths: string[] = []
  for (const entry of entries) {
    const [meta, path] = entry.split("\t")
    if (meta === undefined || path === undefined || path === "") continue
    const [mode] = meta.split(" ")
    if (mode === "160000") paths.push(path)
  }
  return paths
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
