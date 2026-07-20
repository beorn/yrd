import { appendFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import type { RunnerContextRequest, RunnerContexts, RuntimeContext } from "@yrd/job"
import type { Process } from "@yrd/process"
import type { ConditionalLogger } from "loggily"
import { materializeSubmodules } from "@yrd/bay"

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
  /** Acquire a clean worktree pinned to `ref`, run `runCandidate` against it, then return
   * the worktree to the pool. `runCandidate` receives the worktree path and a per-run
   * ephemeral scratch directory (removed on release). */
  withCandidate<Output>(ref: string, runCandidate: (path: string, scratch: string) => Promise<Output>): Promise<Output>
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
  env.KM_NO_AUTO_SUBMODULE_UPDATE = "1"
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
  const waiters: Array<Readonly<{ resolve: (entry: PoolEntry) => void; reject: (cause: unknown) => void }>> = []
  let hits = 0
  let misses = 0
  let evictions = 0
  let closing = false
  let closed = false
  let closePromise: Promise<void> | undefined

  // In-flight accounting so a draining close waits for active checks to settle
  // before removing their worktrees. `active` counts entries currently checked
  // out to a running withCandidate; idleWaiters wake when it reaches zero.
  let active = 0
  const idleWaiters: Array<() => void> = []
  function whenIdle(): Promise<void> {
    if (active === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      idleWaiters.push(resolve)
    })
  }
  function releaseHold(): void {
    active -= 1
    if (active === 0) {
      for (const wake of idleWaiters.splice(0)) wake()
    }
  }
  const closedError = (): Error => new Error("yrd: candidate pool is closed")

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

  // Hand out an entry and record the hold in one synchronous step (no await gap
  // between the hand-off and the `active` bump), so a concurrent close cannot
  // observe a stale zero and tear down a worktree an about-to-run check owns.
  function takeEntry(): PoolEntry | Promise<PoolEntry> {
    const free = entries.find((entry) => !entry.busy)
    if (free !== undefined) {
      free.busy = true
      active += 1
      return free
    }
    if (entries.length < capacity) {
      const entry: PoolEntry = { busy: true }
      entries.push(entry)
      active += 1
      return entry
    }
    return new Promise<PoolEntry>((resolve, reject) => {
      waiters.push({ resolve, reject })
    })
  }

  function returnEntry(entry: PoolEntry): void {
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      active += 1 // hand the hold straight to the queued caller
      waiter.resolve(entry)
      return
    }
    entry.busy = false
  }

  /** Remove a warm worktree. Fail closed and retry-safe (mirrors the cold
   * withScratch cleanup contract): a nonzero `worktree remove` raises loud and
   * leaves the entry state INTACT so a later close/evict retries the removal —
   * it never claims success while leaving Git worktree-admin residue behind. */
  async function removeWorktree(entry: PoolEntry): Promise<void> {
    if (entry.path !== undefined) {
      const removed = await git.run(repo, ["worktree", "remove", "--force", entry.path], true)
      if (removed.code !== 0) {
        throw new Error(removed.stderr || removed.stdout || `yrd: could not remove candidate worktree '${entry.path}'`)
      }
      // The Git admin removal succeeded; the root directory is the remaining
      // cleanup obligation. Keep entry.root populated until the rm SUCCEEDS —
      // clearing it earlier turned an rm failure into an EMPTY survivor whose
      // close() retry no-oped and reported closed over on-disk residue.
      entry.path = undefined
    }
    if (entry.root !== undefined) {
      await rm(entry.root, { recursive: true, force: true })
      entry.root = undefined
    }
  }

  async function materialize(worktree: string, ref: string): Promise<void> {
    using _span = log?.span?.("materialize", { repo, ref })
    const updated = await materializeSubmodules(git, {
      worktree,
      referenceWorktree: repo,
      force: true,
      log: (message) => log?.debug?.(message),
    })
    if (updated.code !== 0) {
      throw new Error(updated.stderr || updated.stdout || `could not materialize submodules for '${ref}'`)
    }
    // Fail closed: an unreset or unclean submodule is residue. Never swallow it —
    // resetEntry treats any throw here as "cannot prove clean" and evicts.
    const reset = await git.run(worktree, ["submodule", "foreach", "--recursive", "git reset --hard"], true)
    if (reset.code !== 0) {
      throw new Error(reset.stderr || reset.stdout || `could not reset submodules for '${ref}'`)
    }
    const cleaned = await git.run(worktree, ["submodule", "foreach", "--recursive", "git clean -fdx"], true)
    if (cleaned.code !== 0) {
      throw new Error(cleaned.stderr || cleaned.stdout || `could not clean submodules for '${ref}'`)
    }
  }

  async function resolveCommit(worktree: string, ref: string): Promise<string> {
    const parsed = await git.run(worktree, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
    return parsed.stdout
  }

  /** Reset a warm worktree to `ref` and PROVE it is residue-free. Fail closed:
   * any reset/clean/materialize failure, a moved HEAD, or a non-empty status
   * (submodules included) resolves false so the caller evicts and recreates —
   * a tree that cannot be proven clean is NEVER reused. The span records the
   * outcome and the reason, so a failure is loud, not silent. */
  async function resetEntry(entry: PoolEntry, ref: string): Promise<boolean> {
    const worktree = entry.path
    if (worktree === undefined) return false
    using span = log?.span?.("reset", { repo, ref })
    const record = (clean: boolean, reason?: string): boolean => {
      if (span !== undefined) {
        Object.assign(span.spanData, {
          outcome: clean ? "clean" : "unclean",
          ...(reason === undefined ? {} : { reason }),
        })
      }
      return clean
    }
    try {
      const target = await resolveCommit(repo, ref)
      const reset = await git.run(worktree, ["reset", "--hard", target], true)
      if (reset.code !== 0) return record(false, reset.stderr || reset.stdout || "reset --hard failed")
      const cleaned = await git.run(worktree, ["clean", "-fdx"], true)
      if (cleaned.code !== 0) return record(false, cleaned.stderr || cleaned.stdout || "clean -fdx failed")
      await materialize(worktree, ref)
      const head = await git.run(worktree, ["rev-parse", "--verify", "--end-of-options", "HEAD"], true)
      if (head.code !== 0 || head.stdout !== target) return record(false, "HEAD does not match the candidate")
      const dirty = await git.run(
        worktree,
        ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
        true,
      )
      if (dirty.code !== 0 || dirty.stdout !== "") return record(false, dirty.stdout || "status probe failed")
      return record(true)
    } catch (cause) {
      return record(false, cause instanceof Error ? cause.message : String(cause))
    }
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
      const exclude = (await git.run(repo, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]))
        .stdout
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
    let added = false
    try {
      await git.run(repo, ["worktree", "add", "--detach", path, ref])
      added = true
      await materialize(path, ref)
    } catch (cause) {
      if (added) {
        const removed = await git.run(repo, ["worktree", "remove", "--force", path], true)
        if (removed.code !== 0) {
          // The worktree was created but neither materialized nor removed. RETAIN
          // the entry so a later close()/evict retries the removal (retry-safe,
          // like removeWorktree), and surface the cleanup failure AGGREGATED with
          // the primary cause — never orphan Git worktree-admin residue silently.
          entry.root = root
          entry.path = path
          const cleanup = new Error(
            removed.stderr || removed.stdout || `yrd: could not remove candidate worktree '${path}'`,
          )
          const detail = cause instanceof Error ? cause.message : String(cause)
          throw new AggregateError(
            [cause, cleanup],
            `yrd: candidate creation failed and its worktree could not be cleaned up: ${detail}`,
            { cause },
          )
        }
      }
      // Add never happened, or the removal succeeded: no worktree-admin residue
      // remains, so drop the orphan root and raise the primary cause.
      await rm(root, { recursive: true, force: true })
      throw cause
    }
    // Publish the entry only once it is a fully materialized, clean worktree.
    entry.root = root
    entry.path = path
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

  // Draining close: (1) refuse new acquires loud, (2) reject queued waiters loud
  // so none wake into torn-down state, (3) WAIT for in-flight checks to settle so
  // no active run loses its worktree mid-check, (4) then remove worktrees with the
  // loud retry-safe semantics. Idempotent; a failed removal stays retryable.
  function close(): Promise<void> {
    if (closed) return Promise.resolve()
    if (closePromise !== undefined) return closePromise
    closing = true
    for (const waiter of waiters.splice(0)) waiter.reject(closedError())
    closePromise = drainAndRemove()
    return closePromise
  }

  async function drainAndRemove(): Promise<void> {
    await whenIdle()
    const survivors: PoolEntry[] = []
    let failure: unknown
    for (const entry of entries) {
      using _span = log?.span?.("release", { repo, outcome: "closed" })
      try {
        await serializeGit(() => removeWorktree(entry))
      } catch (cause) {
        survivors.push(entry)
        failure ??= cause
      }
    }
    entries.length = 0
    entries.push(...survivors)
    if (failure !== undefined) {
      // `closing` stays true forever once close begins — new withCandidate/acquire
      // keep refusing loud, never re-admitted into teardown-failed state with
      // retained/half-removed worktrees. Only the close() retry path re-opens.
      closePromise = undefined
      throw failure
    }
    closed = true
  }

  return Object.freeze({
    async withCandidate<Output>(
      ref: string,
      runCandidate: (path: string, scratch: string) => Promise<Output>,
    ): Promise<Output> {
      if (closing || closed) throw closedError()
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
          const result = await runCandidate(path, scratch)
          if (checkSpan !== undefined && typeof result === "object" && result !== null && "status" in result) {
            const status = String(result.status)
            const conclusion = "conclusion" in result ? String(result.conclusion) : undefined
            Object.assign(checkSpan.spanData, {
              outcome: status === "completed" ? (conclusion === "success" ? "succeeded" : "failed") : status,
            })
          }
          return result
        } finally {
          await rm(scratch, { recursive: true, force: true })
        }
      } finally {
        using _releaseSpan = log?.span?.("release", { repo, ref, outcome: "warm" })
        returnEntry(entry)
        releaseHold()
      }
    },
    stats(): CandidateAcquisition {
      return { hits, misses, evictions }
    },
    close,
    [Symbol.asyncDispose]: close,
  })
}

export type WorktreeContextsOptions = Omit<CandidatePoolOptions, "capacity"> &
  Readonly<{
    size: number
    submodules: "isolated"
  }>

export type WorktreeContexts = RunnerContexts &
  Readonly<{
    stats(): CandidateAcquisition
    close(): Promise<void>
    [Symbol.asyncDispose](): Promise<void>
  }>

/** Candidate-aware Context provider for the local Runner. Each lease owns one
 * independently materialized worktree; the underlying pool proves it clean on
 * every handoff and initializes submodules into that worktree's own mutable
 * Git directories. */
export function worktreeContexts(options: WorktreeContextsOptions): WorktreeContexts {
  if (!Number.isInteger(options.size) || options.size < 1) {
    throw new RangeError("yrd: worktree context size must be a positive integer")
  }
  const pool = createCandidatePool({
    repo: options.repo,
    parent: options.parent,
    capacity: options.size,
    git: options.git,
    ...(options.log === undefined ? {} : { log: options.log }),
  })
  let sequence = 0

  const withContext = async <Output>(
    request: RunnerContextRequest,
    runInContext: (context: RuntimeContext) => Promise<Output>,
  ): Promise<Output> => {
    sequence += 1
    const id = `worktree-context:${sequence}`
    if (request.context.candidate === "none") {
      if (request.candidateRef !== undefined) {
        throw new Error("yrd: a candidateRef requires a ro or rw candidate Context")
      }
      return runInContext({ id, request: request.context, cwd: options.repo })
    }
    if (request.candidateRef === undefined) {
      throw new Error(`yrd: ${request.context.candidate} candidate Context requires candidateRef`)
    }
    return pool.withCandidate(request.candidateRef, (cwd) =>
      runInContext({ id, request: request.context, candidateRef: request.candidateRef, cwd }),
    )
  }

  return Object.freeze({
    maxInFlight: options.size,
    withContext,
    stats: pool.stats,
    close: pool.close,
    [Symbol.asyncDispose]: pool[Symbol.asyncDispose],
  })
}
