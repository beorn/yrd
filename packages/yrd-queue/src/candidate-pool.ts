import { appendFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import type { JsonValue } from "@yrd/core"
import type { JobResult } from "@yrd/job"
import type { Process } from "@yrd/process"
import type { ConditionalLogger } from "loggily"

/**
 * Bounded warm candidate-worktree pool (merge-queue R40).
 *
 * The cold path in `withScratch` pays full worktree creation + submodule
 * materialization on every candidate: run R40 spent 39s in that setup. This
 * pool keeps a small, bounded set of candidate worktrees warm per repository:
 * a Git worktree is created once, then RESET cleanly to each immutable
 * candidate ref for reuse. Cross-run residue is rejected loud (never run a
 * check in a dirty candidate) and the entry is evicted and recreated.
 *
 * Observability: each phase emits a loggily span — acquire / reset /
 * materialize / check / release — carrying { repo, ref, outcome } where
 * outcome is `hit` (reused a warm worktree), `miss` (created a fresh one), or
 * `residue-evicted` (a reused worktree could not be made clean and was
 * discarded). Span disposal records the measured duration.
 */

/** The narrow Git surface the pool drives. Structural to keep the pool decoupled
 * from the command module's private `createGit` (which the pool would otherwise
 * form an import cycle with). `command.ts` passes its own `git`; the host builds
 * one via {@link createCandidatePoolGit}. */
export type CandidatePoolGit = Readonly<{
  run(repo: string, args: readonly string[], allowFailure?: boolean): Promise<CandidatePoolGitResult>
}>

export type CandidatePoolGitResult = Readonly<{ code: number; stdout: string; stderr: string }>

export type CandidatePoolOptions = Readonly<{
  repo: string
  /** Directory under which warm worktrees are materialized (the Bays root). */
  parent: string
  /** Maximum concurrent warm worktrees held for this repository. */
  capacity?: number
  git: CandidatePoolGit
  log?: ConditionalLogger
}>

export type CandidateAcquisition = Readonly<{ hits: number; misses: number; evictions: number }>

export type CandidatePool = Readonly<{
  /** Acquire a clean worktree pinned to `ref`, run `use` against it, then return
   * the worktree to the pool. `use` receives the worktree path and a per-run
   * ephemeral scratch directory (removed on release). */
  withCandidate<Output extends JsonValue>(
    ref: string,
    use: (path: string, scratch: string) => Promise<JobResult<Output>>,
  ): Promise<JobResult<Output>>
  /** Cumulative acquisition counters, for measurement and assertions. */
  stats(): CandidateAcquisition
  /** Remove every warm worktree. Idempotent; also runs on async disposal. */
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}>

const DEFAULT_CAPACITY = 2

type PoolEntry = {
  busy: boolean
  /** Persistent per-entry root; the worktree lives at `<root>/worktree`. Absent
   * until the entry has been materialized (or after eviction). */
  root?: string
  path?: string
}

type AcquireOutcome = "hit" | "miss" | "residue-evicted"

/** Build a Git surface for the pool from a Process, scrubbing inherited GIT_*
 * variables so warm worktrees never adopt the host's GIT_DIR/GIT_WORK_TREE. */
export function createCandidatePoolGit(
  process: Pick<Process, "run">,
  environment: NodeJS.ProcessEnv = globalThis.process.env,
): CandidatePoolGit {
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  ) as Record<string, string>
  return Object.freeze({
    async run(repo, args, allowFailure = false): Promise<CandidatePoolGitResult> {
      const result = await process.run({ argv: ["git", "-C", repo, ...args], cwd: repo, env })
      const completed = { code: result.exitCode, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
      if (!allowFailure && completed.code !== 0) {
        throw new Error(completed.stderr || completed.stdout || `git ${args.join(" ")} failed`)
      }
      return completed
    },
  })
}

export function createCandidatePool(options: CandidatePoolOptions): CandidatePool {
  const { repo, parent, git } = options
  const log = options.log
  const capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY)
  const entries: PoolEntry[] = []
  const waiters: Array<(entry: PoolEntry) => void> = []
  let hits = 0
  let misses = 0
  let evictions = 0
  let closed = false

  // `git worktree add/remove/reset` all lock the shared repository, so the pool
  // serializes its Git mutations onto one chain. Checks (the caller's `run`)
  // stay OFF this chain and run concurrently — the point of the pool.
  let gitChain: Promise<unknown> = Promise.resolve()
  function serializeGit<T>(work: () => Promise<T>): Promise<T> {
    const result = gitChain.then(work, work)
    gitChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function takeEntry(): PoolEntry | Promise<PoolEntry> {
    const free = entries.find((entry) => !entry.busy)
    if (free !== undefined) {
      free.busy = true
      return free
    }
    if (entries.length < capacity) {
      const entry: PoolEntry = { busy: true }
      entries.push(entry)
      return entry
    }
    return new Promise<PoolEntry>((resolve) => waiters.push(resolve))
  }

  function returnEntry(entry: PoolEntry): void {
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      waiter(entry)
      return
    }
    entry.busy = false
  }

  async function removeWorktree(entry: PoolEntry): Promise<void> {
    const path = entry.path
    const root = entry.root
    entry.path = undefined
    entry.root = undefined
    if (path !== undefined) {
      await git.run(repo, ["worktree", "remove", "--force", path], true)
    }
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true })
    }
  }

  async function hasSubmodules(worktree: string, ref: string): Promise<boolean> {
    const probe = await git.run(worktree, ["cat-file", "-e", `${ref}:.gitmodules`], true)
    return probe.code === 0
  }

  async function materialize(worktree: string, ref: string): Promise<void> {
    if (!(await hasSubmodules(worktree, ref))) return
    using _span = log?.span?.("materialize", { repo, ref })
    const allow = ["-c", "protocol.file.allow=always"]
    const updated = await git.run(worktree, [...allow, "submodule", "update", "--init", "--recursive", "--force"], true)
    if (updated.code !== 0) {
      throw new Error(updated.stderr || updated.stdout || `could not materialize submodules for '${ref}'`)
    }
    await git.run(worktree, ["submodule", "foreach", "--recursive", "git reset --hard"], true)
    await git.run(worktree, ["submodule", "foreach", "--recursive", "git clean -fdx"], true)
  }

  async function resolveCommit(worktree: string, ref: string): Promise<string> {
    const parsed = await git.run(worktree, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
    return parsed.stdout
  }

  /** Reset a warm worktree to `ref` and prove it is residue-free. Resolves true
   * when the entry is clean and pinned; false when it must be evicted. */
  async function resetEntry(entry: PoolEntry, ref: string): Promise<boolean> {
    const worktree = entry.path
    if (worktree === undefined) return false
    using _span = log?.span?.("reset", { repo, ref })
    const target = await resolveCommit(repo, ref)
    const reset = await git.run(worktree, ["reset", "--hard", target], true)
    if (reset.code !== 0) return false
    await git.run(worktree, ["clean", "-fdx"], true)
    await materialize(worktree, ref)
    const head = await git.run(worktree, ["rev-parse", "--verify", "--end-of-options", "HEAD"], true)
    if (head.code !== 0 || head.stdout !== target) return false
    const dirty = await git.run(worktree, ["status", "--porcelain", "--untracked-files=all"], true)
    return dirty.code === 0 && dirty.stdout === ""
  }

  // When the warm-worktree parent lives inside the repository working tree, a
  // persistent worktree there would show as untracked in the base worktree's
  // `git status` and make the native merge refuse with `dirty-base`. Exclude the
  // parent once (idempotently), mirroring the Bays workspace. A parent OUTSIDE
  // the working tree needs no exclusion — Git never scans it.
  let excludeEnsured = false
  async function ensureParentExcluded(): Promise<void> {
    if (excludeEnsured) return
    const local = relative(repo, parent)
    if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      excludeEnsured = true
      return
    }
    const normalized = local.split(sep).join("/")
    const ignored = await git.run(repo, ["check-ignore", "--quiet", "--no-index", "--", normalized], true)
    if (ignored.code !== 0) {
      const exclude = (
        await git.run(repo, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])
      ).stdout
      if (exclude === "") throw new Error("yrd: candidate pool could not resolve the repository exclude path")
      const escaped = normalized.replace(/([\\[\]*?!#])/gu, "\\$1")
      await appendFile(exclude, `\n/${escaped}/\n`, { encoding: "utf8", mode: 0o600 })
    }
    excludeEnsured = true
  }

  async function createEntry(entry: PoolEntry, ref: string): Promise<void> {
    await ensureParentExcluded()
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(join(await realpath(parent), "yrd-warm-"))
    const path = join(root, "worktree")
    entry.root = root
    entry.path = path
    await git.run(repo, ["worktree", "add", "--detach", path, ref])
    await materialize(path, ref)
  }

  async function acquire(entry: PoolEntry, ref: string): Promise<AcquireOutcome> {
    return serializeGit(async () => {
      if (entry.path !== undefined) {
        if (await resetEntry(entry, ref)) {
          hits += 1
          return "hit"
        }
        // A warm worktree that cannot be made clean is residue — never run a
        // check in it. Evict and recreate so the check runs in a pristine tree.
        await removeWorktree(entry)
        evictions += 1
        await createEntry(entry, ref)
        misses += 1
        return "residue-evicted"
      }
      await createEntry(entry, ref)
      misses += 1
      return "miss"
    })
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    for (const entry of entries) {
      using _span = log?.span?.("release", { repo, outcome: "closed" })
      await serializeGit(() => removeWorktree(entry))
    }
    entries.length = 0
  }

  return Object.freeze({
    async withCandidate<Output extends JsonValue>(
      ref: string,
      use: (path: string, scratch: string) => Promise<JobResult<Output>>,
    ): Promise<JobResult<Output>> {
      if (closed) throw new Error("yrd: candidate pool is closed")
      const entry = await takeEntry()
      try {
        let outcome: AcquireOutcome
        {
          using acquireSpan = log?.span?.("acquire", { repo, ref })
          outcome = await acquire(entry, ref)
          if (acquireSpan !== undefined) Object.assign(acquireSpan.spanData, { outcome })
        }
        const root = entry.root
        const path = entry.path
        if (root === undefined || path === undefined) {
          throw new Error("yrd: candidate pool produced no worktree")
        }
        const scratch = await mkdtemp(join(root, "run-"))
        try {
          using checkSpan = log?.span?.("check", { repo, ref })
          const result = await use(path, scratch)
          if (checkSpan !== undefined) {
            Object.assign(checkSpan.spanData, {
              outcome: result.status === "passed" ? "succeeded" : result.status,
            })
          }
          return result
        } finally {
          await rm(scratch, { recursive: true, force: true })
        }
      } finally {
        using _releaseSpan = log?.span?.("release", { repo, ref, outcome: "warm" })
        returnEntry(entry)
      }
    },
    stats(): CandidateAcquisition {
      return { hits, misses, evictions }
    },
    close,
    [Symbol.asyncDispose]: close,
  })
}
