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
 *
 * The clean reads its own discard set first (`git clean -ffdxn`), because being
 * under a pooled path is containment evidence, not proof of who wrote the bytes:
 * an entry that is an independent repository is another writer's tracked work,
 * and an entry this process cannot read is unknown rather than ours. Such a tree
 * is HELD — never cleaned, never removed — and moved intact into
 * `worktrees/pool/held/` when its slot is needed again (@cto 2026-11-22, #34952).
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, type Dirent } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { Process } from "@yrd/process"
import { createGitWorktreeStore } from "git-super/worktree"
import { gitIn, seamProcess, type Git, type GitInvocationOptions, type GitSelection } from "./git.ts"
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

/**
 * The two trees a round needs: the candidate it judges, and the target it compares against; and the one
 * tree notifications outside a round borrow to run their entries at the target (34755).
 */
export type PoolRole = "candidate" | "base" | "notify"

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
    const base = pooledWorktreePath(this.options.workdir, this.options.ref, input.role)
    const path = base
    if (!existsSync(path)) return this.materialize(path, input)
    let cause: string
    try {
      cause = await this.reuseRefusal(path)
    } catch (error) {
      // Unreadable ground: not a tree this round can warm, and not one it can
      // judge either. The rebuild below is fresh-by-construction, so it is safe
      // to abandon the directory, and the cause is named rather than swallowed.
      this.note(input, `pooled ${input.role} tree could not be inspected: ${messageOf(error)}`)
      return this.materialize(await this.discard(path), input)
    }
    if (cause !== "") {
      this.note(input, cause)
      return this.materialize(await this.discard(path), input)
    }
    try {
      await this.reset(path, input)
    } catch (error) {
      if (error instanceof PooledTreeHeld) {
        // Nothing is deleted: the tree is moved intact under pool custody and the slot is freed for a fresh one.
        this.note(input, `pooled ${input.role} tree held, not cleaned or reused: ${describeHolds(error.holds)}`)
        return this.materialize(await this.holdAside(path, error.holds), input)
      }
      this.note(input, `pooled ${input.role} tree could not be reset: ${messageOf(error)}`)
      return this.materialize(await this.discard(path), input)
    }
    return this.setupAt(path, base, input)
  }

  /** Discard a pooled tree and hand back the path the round should materialize at. */
  private async discard(path: string): Promise<string> {
    await this.forget(path)
    return path
  }

  /**
   * Move a held tree out of its slot, intact, and free the slot. Everything the clean would have DELETED is
   * evidence — another writer's repository, or a subtree this process cannot read — so the whole tree is renamed
   * into `worktrees/pool/held/<ref>/<role>-<stamp>/` and never deleted (@cto 2026-11-22, #34952).
   *
   * A rename needs no permission INSIDE the tree, which is what lets even an unreadable subtree move. The
   * registration is then forgotten by the same removal primitive every other discard uses, so a held tree frees
   * its slot without a raw `git worktree` call: the primitive wants a checkout at the registered path, so a stub
   * holding only the linked worktree's `.git` pointer is left for it to remove.
   */
  private async holdAside(path: string, holds: readonly PooledHold[]): Promise<string> {
    const retained = join(
      this.options.workdir,
      "worktrees",
      "pool",
      "held",
      this.options.ref.replaceAll("/", "_"),
      `${basename(path)}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    )
    mkdirSync(dirname(retained), { recursive: true })
    renameSync(path, retained)
    const pointer = join(retained, ".git")
    if (statSync(pointer, { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(`pooled tree ${path} has no .git pointer file; its registration cannot be forgotten without it`)
    }
    mkdirSync(path)
    copyFileSync(pointer, join(path, ".git"))
    await this.forget(path)
    this.options.plumbing?.trace?.("held pooled worktree aside", {
      from: path,
      path: retained,
      holds: holds.map((hold) => `${hold.entry} (${hold.cause})`),
    })
    return path
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
    try {
      await this.clean(tree.path)
    } catch (error) {
      if (!(error instanceof PooledTreeHeld)) throw error
      // A hold is left in place: the tree returns to the pool uncleaned, and the next borrow moves it aside.
      this.options.note?.(`pooled tree left uncleaned, held: ${describeHolds(error.holds)}`)
      return
    }
    this.options.plumbing?.trace?.("returned worktree to the pool", { commit: tree.commit, path: tree.path })
  }

  /** The note a borrow carries: its own when it has one, the pool's otherwise, silence when neither. */
  private note(input: BorrowPooled, cause: string): void {
    const note = input.note ?? this.options.note
    note?.(cause)
  }

  /** A fresh tree, materialized and provisioned by the same code `yrd check` uses. */
  private async materialize(path: string, input: BorrowPooled): Promise<PreparedWorktree> {
    return prepareWorktree(this.options.git, this.options.repo, input.commit, path, {
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
   *
   * Untracked content does NOT refuse, and neither does untracked content inside
   * a submodule: the reset cleans every ignored and untracked file, so those
   * bytes cannot reach a judgment, and `--ignore-submodules=untracked` stops a
   * submodule that merely holds an untracked file from reporting as modified and
   * turning every borrow back into a fresh materialization (@cto 2026-10-10,
   * the same defect @dev/review2 found on the lane's head).
   */
  private async reuseRefusal(path: string): Promise<string> {
    const at = this.gitAt(path)
    const status = (await at(["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=untracked"])).trim()
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
    await this.store(path).materializeSubmodules(path, {
      force: true,
      hooks: "quarantine",
      excludedSubmodules: [],
    })
    await this.clean(path)
  }

  /**
   * `git clean -ffdx`, keeping `node_modules` and leaving submodules to their
   * own turn: a submodule directory is another repository, so it is excluded
   * here and cleaned from inside, one level down, by this same function.
   */
  private async clean(path: string): Promise<void> {
    const holds = await this.discardHolds(path)
    if (holds.length > 0) throw new PooledTreeHeld(holds)
    await this.cleanRoot(path)
  }

  /**
   * The entries this tree's clean would DELETE that are other writers', root and submodules: an independent
   * repository is another writer's tracked work, and an unreadable subtree is unknown rather than ours. Read with
   * `git clean -ffdxn` and the clean's own exclusions, so the answer is the actual discard set and nothing is
   * destroyed to learn it (@cto 2026-11-22, #34952). A plain untracked file is pool scratch and is not a hold.
   */
  private async discardHolds(path: string): Promise<PooledHold[]> {
    const at = this.gitAt(path)
    const submodules = await gitlinkPaths(at)
    const exclusions = [...submodules, "node_modules"].flatMap((name) => ["-e", name])
    const listed = (await at(["clean", "-ffdxn", ...exclusions]))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("Would remove "))
      .map((line) => line.slice("Would remove ".length))
    const holds: PooledHold[] = []
    for (const entry of listed) {
      const cause = holdCause(join(path, entry))
      if (cause !== undefined) holds.push({ entry, cause })
    }
    for (const submodule of submodules) {
      if (!existsSync(join(path, submodule, ".git"))) continue
      for (const child of await this.discardHolds(join(path, submodule))) {
        holds.push({ entry: join(submodule, child.entry), cause: child.cause })
      }
    }
    return holds
  }

  private async cleanRoot(path: string): Promise<void> {
    const at = this.gitAt(path)
    const submodules = await gitlinkPaths(at)
    const exclusions = [...submodules, "node_modules"].flatMap((name) => ["-e", name])
    await at(["clean", "-ffdx", ...exclusions])
    for (const submodule of submodules) {
      // A gitlink the tree did not materialize names no repository to clean:
      // `-e` above already left it alone.
      if (!existsSync(join(path, submodule, ".git"))) continue
      await this.cleanRoot(join(path, submodule))
    }
  }

  /** A warm tree's `checkedTree`, then the setup that always re-runs on it. */
  private async setupAt(path: string, base: string, input: BorrowPooled): Promise<PreparedWorktree> {
    try {
      const tree = await checkedTree(path, input.targetSha, this.options.process, this.options.selection, {
        ...(this.options.env === undefined ? {} : { env: this.options.env }),
        ...this.options.gitOptions,
      })
      const prepared: PreparedWorktree = {
        commit: input.commit,
        excludedSubmodules: [],
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
      if (error instanceof SetupFailed) {
        await this.forget(path)
      }
      throw error
    }
  }

  /** Remove a pooled tree and forget its registration, exactly as a per-run tree's removal does. */
  private async forget(path: string): Promise<void> {
    // Through git-super's removal primitive, which renames the tree aside so whatever a check wrote
    // rides along, forgets the registration, then deletes the staged copy. It owns the admin-dir
    // custody and the private-store refusal that a bare filesystem delete could not see (28665).
    //
    // The `safeRemoveSync` this replaces had to name its own root in `allowedRoots`, because
    // removely's DEFAULT is [tmpdir()] and the queue service's TMPDIR (/hh/dev/.git/yrd/tmp) never
    // contains the pool: the first discard outside tmpdir threw and exited the whole queue 2
    // (28751). Whole classes of that fix are the primitive's now, so no caller here names a root.
    //
    // No options, so no borrowers or compaction result to read.
    await this.store(path).remove(path)
  }

  /**
   * A store whose seam answers for the reference checkout AND for `path`, the
   * worktree it is materializing, running each request in the cwd that request
   * names: a seam that answered only for the reference - or ran everything
   * there - refused the pooled cwd and rebuilt fresh every round, which is the
   * defect @dev/4 reproduced at cc95eaf9c3.
   */
  private store(path: string): ReturnType<typeof createGitWorktreeStore> {
    const checkout = this.options.repo
    return createGitWorktreeStore({
      gitProcess: seamProcess(this.options.git, checkout, {
        also: [path],
        at: (cwd) => this.gitAt(cwd),
      }),
      repo: checkout,
    })
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

/** One entry a clean would delete, and why the pool may not: another writer's repository, or content it cannot read. */
export type PooledHold = Readonly<{
  entry: string
  cause: "independent repository" | "unreadable" | "uninspected depth"
}>

/** A pooled tree whose clean would delete another writer's repository, or content this process cannot read. */
export class PooledTreeHeld extends Error {
  constructor(readonly holds: readonly PooledHold[]) {
    super(`pooled tree holds ${describeHolds(holds)}`)
    this.name = "PooledTreeHeld"
  }
}

function describeHolds(holds: readonly PooledHold[]): string {
  return holds.map((hold) => `${hold.entry} (${hold.cause})`).join(", ")
}

/**
 * Why deleting `target` would take bytes this program did not write: "independent repository" when a `.git` of its
 * own sits at it or under it, "unreadable" when it cannot be read (unknown is not ours), "uninspected depth" when it
 * sits past the depth this check walks — an uninspected subtree is unknown too, never pool scratch. `undefined`
 * otherwise: a plain untracked file, or a directory of them, is cleaned as before (@cto 2026-11-22, #34952).
 */
function holdCause(target: string, depth = 0): PooledHold["cause"] | undefined {
  // Past this depth the subtree is not inspected, and what is not inspected cannot be proven pool scratch: holding
  // it keeps the clean from deleting another writer's repository nested deeper (@dev/15 review, #34952).
  if (depth > 8) return "uninspected depth"
  let stat
  try {
    stat = statSync(target, { throwIfNoEntry: false })
  } catch (error) {
    // silent-fallback-allow: a stat that vanished has nothing left to lose; one this process cannot read IS the hold and is reported
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    return "unreadable"
  }
  if (stat === undefined || !stat.isDirectory()) return undefined
  let entries: Dirent[]
  try {
    entries = readdirSync(target, { withFileTypes: true })
  } catch (error) {
    // silent-fallback-allow: an entry that vanished between the dry run and this read has nothing left to lose; an unreadable one IS the hold and is reported
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    return "unreadable"
  }
  if (entries.some((entry) => entry.name === ".git")) return "independent repository"
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue
    const nested = holdCause(join(target, entry.name), depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
}
