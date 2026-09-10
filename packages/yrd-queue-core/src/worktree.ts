/**
 * A fresh worktree of one commit, submodules included, ready to be checked
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The queue run).
 *
 * Every check runs in a worktree made for that change and that judgement and
 * removed afterwards: nothing is warmed, pooled or reused, so a result can
 * only ever be about the commit it names. Submodule materialization is
 * git-super's, unchanged, borrowing objects from the reference repository so
 * a fresh worktree does not mean a fresh network fetch.
 *
 * Materialization gives a worktree its submodules and nothing else: no
 * dependencies, no build. The target says how to finish it in one line,
 * `setup:`, and `prepareWorktree` is the one place that runs it — once per
 * fresh worktree, after materialization and before any check, so a check never
 * carries the provisioning of the tree it judges. Every caller that judges
 * anything goes through it, the queue run and `yrd check` alike, or a check by
 * a seat would run in a tree the queue never builds.
 *
 * The plumbing's own narration (which submodule, borrowed or fetched, how
 * long) is trace-level: a debug log reads as the queue's decisions, not as a
 * git transcript. The caller hands in a logger only when trace is on.
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import type { Process } from "@yrd/process"
import { checkLogPath, DEFAULT_CHECK_BOUND_MS, runCheck, type CheckedTree, type CheckResult } from "./check.ts"
import { frozenLockfileDiagnosis } from "./lockfile-diagnosis.ts"
import type { LogWrite } from "./log.ts"
import { GIT_SUPER_ABSENT_STORE, populateReferenceStores, ReferenceUnpopulated } from "./reference.ts"
import type { Git } from "./records.ts"
import { gitIn, mergeBase, type GitInvocationOptions, type GitSelection } from "./git.ts"

/**
 * What the worktree plumbing narrates to.
 *
 * `trace` is the git transcript and the queue hands one over only at trace.
 * `journal` is not: a store the reference had to create, and a compose that had
 * to go to the network for a pin, are facts about the queue's own ground that
 * an operator must be able to read after the fact, so they are records in the
 * run's journal rather than lines in a log nobody turned on.
 */
export type PlumbingLog = Readonly<{
  trace?: (message: string, detail: Readonly<Record<string, unknown>>) => void
  journal?: (record: LogWrite) => void
}>

export type Worktree = Readonly<{
  /** The directory the commit is checked out in. */
  path: string
  /** The commit it holds. */
  commit: string
  /** Remove the worktree and everything under it. */
  remove(): Promise<void>
}>

/** What a fresh worktree needs beyond the repository and the commit: how to run Git elsewhere, and where to narrate. */
export type FreshWorktree = Readonly<{
  /**
   * Whether this repository is the queue's OWN clone, and may therefore be
   * given the stores it lends.
   *
   * Off by default, because `repo` is not always the queue's. `yrd check` and
   * `yrd env` compose from the seat's own checkout, and populating there would
   * write a clone into an uninitialized submodule directory as a side effect of
   * a command the seat asked nothing of the kind from. A tree somebody is
   * working in is not ours to provision; git-super's own refusal names the
   * `submodule update --init` that would fix it, and the person reading it owns
   * that decision.
   */
  populateReference?: boolean
  plumbing?: PlumbingLog
  /** The command's fixed selection and invocation evidence, for the reference stores as for the tree. */
  selection?: GitSelection
  gitOptions?: GitInvocationOptions
  process?: Process
  env?: NodeJS.ProcessEnv
}>

/**
 * Check `commit` out at `path` as a detached worktree of `repo`, with every
 * gitlink materialized at the commit's own gitlink. A gitlink that cannot be
 * materialized throws, because a check run against a half-materialized tree
 * would judge something no commit describes.
 *
 * The reference is made self-contained FIRST, for this exact commit
 * (reference.ts). It has to happen here rather than once at the queue's start:
 * a change that adds a submodule declares it at its own commit and nowhere
 * else, so a reference populated from the queue's HEAD would have no store for
 * precisely the change that needs one. The ordinary call finds every store
 * already there and creates nothing.
 */
export async function freshWorktree(
  git: Git,
  repo: string,
  commit: string,
  path: string,
  options: FreshWorktree = {},
): Promise<Worktree> {
  const plumbing = options.plumbing
  // Query the selected commit, not the reference checkout's working tree.
  // An invalid commit makes ls-tree fail; only empty output means absence.
  const modules = await git(["ls-tree", commit, "--", ".gitmodules"])
  if (modules.trim() === "") {
    await git(["worktree", "add", "--quiet", "--detach", path, commit])
  } else {
    if (options.populateReference === true) {
      const gitAt = (cwd: string): Git =>
        gitIn(cwd, options.process, options.selection, {
          ...(options.env === undefined ? {} : { env: options.env }),
          ...options.gitOptions,
        })
      await populateReferenceStores({
        commit,
        gitIn: gitAt,
        populated: (store) => {
          plumbing?.journal?.({ head: commit, kind: "reference", ms: store.ms, path: store.path, sha: store.sha })
        },
        repo,
      })
    }
    let output: string
    try {
      output = await git(["super", "--json", "worktree", "add", path, commit, "--reference", repo])
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error)
      // The reference has no store for a gitlink of this commit — because it
      // was never populated (a seat's own checkout), or because it lost one
      // between the population and now. Same condition and same remedy either
      // way, so the same ending, never the generic crash one, which would name
      // the change and not the ground it could not be judged on. git-super's
      // full refusal is carried through, so the command that populates it
      // reaches whoever reads this.
      if (said.includes(GIT_SUPER_ABSENT_STORE)) {
        throw new ReferenceUnpopulated(
          repo,
          undefined,
          `git super worktree add refused for ${commit} after the reference was populated:\n${said}`,
        )
      }
      throw new Error(
        `worktree ${path} at ${commit} requires git-super because that commit records .gitmodules; ` +
          `git super worktree add failed: ${said}. ` +
          "Ensure git-super is available on PATH and resolve the reported condition before retrying; no plain-git fallback was attempted",
        { cause: error },
      )
    }
    let result: unknown
    try {
      result = JSON.parse(output)
    } catch (error) {
      throw new Error(
        `malformed git-super output for worktree ${path} at ${commit}: expected one JSON result; inspect git worktree list before retrying`,
        { cause: error },
      )
    }
    if (!materializedWorktree(result, resolve(repo, path), commit)) {
      throw new Error(
        `malformed git-super result for worktree ${path} at ${commit}: no complete matching materialization; inspect git worktree list before retrying`,
      )
    }
    // A COMPOSE THAT SUCCEEDED IS NOT THE SAME AS A COMPOSE THAT BORROWED. With
    // the reference populated every gitlink should come off local disk, so a
    // fetch here says a store is behind and an absent one says a level had no
    // reference at all. Neither stops the run — the tree is correct and the
    // judgement stands — and both are exactly the signal that read as ordinary
    // for four hours on 2026-09-09 while fifteen submodules cloned per compose.
    const degraded = degradedGitlinks(result)
    if (degraded !== undefined) {
      plumbing?.journal?.({
        absent: degraded.absent,
        borrowed: degraded.borrowed,
        considered: degraded.considered,
        fetched: degraded.fetched,
        head: commit,
        kind: "warning",
        paths: degraded.paths,
        reason: "reference-not-borrowed",
        reference: repo,
      })
    }
    plumbing?.trace?.("materialized worktree", { commit, path, result })
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

/**
 * The file a run writes beside its own worktrees, holding its process id.
 *
 * The queue remembers nothing, and this is not a memory: nothing reads it as
 * status, it says nothing about any change, and it is removed with the
 * worktrees it stands among. It answers the one question a later run cannot
 * answer any other way — is the process that made these worktrees still
 * running — which git has no answer for, since a worktree registration
 * outlives the process that made it by design.
 */
export const RUN_PID = ".pid"

/** The pid file a run writes at its start, before it makes any worktree, so no later run can read its absence as death. */
export function claimWorktrees(directory: string, pid: number = process.pid): void {
  writeFileSync(join(directory, RUN_PID), `${String(pid)}\n`)
}

/** One worktree a reap took down, as the caller reports it. */
export type Reaped = Readonly<{
  /** The run that made it: the directory under the worktrees root, which is that run's log id. */
  of: string
  path: string
  /** Why that run is not alive, in plain words. */
  why: string
  /**
   * The commit this worktree stood at, from git's own registration, read
   * before the directory went. The one trace an interrupted merge leaves once
   * its change ref cannot yet say so (@i/10-yrd/24344): absent only when git's
   * own listing carried none, which a queue-made worktree never leaves unborn.
   */
  head?: string
}>

/**
 * The worktrees of runs that are no longer alive, removed
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § Owed after M5).
 *
 * A run makes its worktrees under `<root>/<run id>/` and removes them when it
 * ends. A run that is killed or crashes removes nothing, so its worktrees stay
 * registered in the repository and on disk, and every later `git worktree
 * list` carries them: R8's did. Nothing else ever cleans them up, because the
 * run that owned them is gone.
 *
 * A run is alive if it is this one, or if the pid file it wrote at its start
 * names a process that is running. Anything else is dead and its worktrees go.
 * The one error this can make is a process id reused by an unrelated process,
 * which reads as alive and leaves a stale worktree standing one run longer —
 * never a live run's worktree taken from under it, which is the direction that
 * would break a run mid-judgement.
 *
 * Removal is the one `Worktree.remove` already does — the directory first,
 * then `git worktree prune` to forget the registration — because `git worktree
 * remove` refuses a tree with untracked files it did not make, which is every
 * tree a dead run left a check to write in. `prune` runs once, and runs whether
 * or not a run died, because a registration whose directory is gone is stale
 * however it got that way. The dead run's own directory goes with its
 * worktrees, so whatever git never registered under it goes too.
 */
export async function reapWorktrees(git: Git, root: string, thisRun: string): Promise<readonly Reaped[]> {
  const dead = new Map<string, string>()
  for (const run of directoriesIn(root)) {
    if (run === thisRun) continue
    const why = notRunning(join(root, run))
    if (why !== undefined) dead.set(run, why)
  }
  const reaped: Reaped[] = []
  if (dead.size > 0) {
    for (const { path, head } of await registeredWorktrees(git)) {
      const of = runOwning(root, path)
      const why = of === undefined ? undefined : dead.get(of)
      if (of === undefined || why === undefined) continue
      rmSync(path, { force: true, recursive: true })
      reaped.push({ of, path, why, ...(head === undefined ? {} : { head }) })
    }
    for (const run of dead.keys()) rmSync(join(root, run), { force: true, recursive: true })
  }
  // Always, dead runs or none: a registration whose directory is gone is stale
  // however it got that way, and forgetting it is one cheap git call.
  await git(["worktree", "prune"])
  return reaped
}

/** Why the run that wrote `directory` is not running, or undefined when it is. */
function notRunning(directory: string): string | undefined {
  let written: string
  try {
    written = readFileSync(join(directory, RUN_PID), "utf8").trim()
  } catch {
    return `it left no ${RUN_PID}`
  }
  const pid = Number.parseInt(written, 10)
  if (!Number.isInteger(pid) || pid <= 0) return `its ${RUN_PID} does not hold a process id`
  return running(pid) ? undefined : `pid ${String(pid)} is not running`
}

/** Whether a process id names a process that is running now. */
function running(pid: number): boolean {
  try {
    // Signal 0 asks the kernel about the process and sends nothing.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM is a live process this user may not signal; only ESRCH is absence.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The run directory a worktree path sits under, or undefined when it is not under `root` at all. */
function runOwning(root: string, path: string): string | undefined {
  const within = relative(root, path)
  if (within === "" || within.startsWith("..") || within.startsWith(sep)) return undefined
  return within.split(sep)[0]
}

export type RegisteredWorktree = Readonly<{ path: string; head?: string; branch?: string; locked?: string }>

/** Git's own registry, shared by environment list/close and queue cleanup.
 * NUL-delimited fields preserve paths containing whitespace or newlines. */
export async function registeredWorktrees(git: Git): Promise<readonly RegisteredWorktree[]> {
  const rows: RegisteredWorktree[] = []
  let current: { path?: string; head?: string; branch?: string; locked?: string } = {}
  const take = (): void => {
    if (current.path !== undefined) rows.push({ ...current, path: current.path })
    current = {}
  }
  for (const field of (await git(["worktree", "list", "--porcelain", "-z"])).split("\0")) {
    if (field === "") take()
    else if (field.startsWith("worktree ")) {
      take()
      current.path = field.slice("worktree ".length)
    } else if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length)
    else if (field.startsWith("branch ")) current.branch = field.slice("branch ".length).replace(/^refs\/heads\//u, "")
    else if (field === "locked" || field.startsWith("locked ")) {
      current.locked = field.slice("locked".length).trimStart()
    }
  }
  take()
  return rows
}

/** The directories directly under `root`, or none when there is no root yet. */
function directoriesIn(root: string): readonly string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    // "There is no root yet" is the one honest absence. A root that exists and
    // cannot be read — a permission, a file where the directory should be —
    // used to read as "no dead runs", so every killed run's worktree stayed
    // standing and nothing ever said why.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return []
  }
}

/** The name the setup runs, logs and ends a change under. */
export const SETUP = "setup"

/** The target's `setup:`, with the two places its one run needs. */
export type SetupSpec = Readonly<{
  /** The declaration's `setup:`: one shell command, as a check's `run:` is. */
  run: string
  /** Where the setup's log goes, the check logs' own directory. */
  logDir: string
  /** The temp root the setup gets as `TMPDIR`, as a check does. */
  tmpdir: string
  /** The bound; the check default unless the caller says otherwise. */
  timeoutMs?: number
}>

/** How one setup went: the check driver's own result, and when it ran. */
export type SetupRan = Readonly<{ result: CheckResult; start: string; end: string }>

/** One invocation of the shared setup executor in an already-materialized tree. */
export type RunSetup = Readonly<{
  cwd: string
  tree: CheckedTree
  setup: SetupSpec
  /** Told how the setup went, pass or not, before a failure throws. */
  record?: (ran: SetupRan) => void
  /** Told the setup is about to run, with the log it will write. */
  starting?: (about: Readonly<{ start: string; log: string }>) => void
  process?: Process
  env?: NodeJS.ProcessEnv
}>

export type PrepareWorktree = Readonly<{
  /** The command's fixed selection and invocation evidence, also for tree facts. */
  selection?: GitSelection
  gitOptions?: GitInvocationOptions
  /** The target every base is measured against: `YRD_BASE_SHA` is the merge base of it and the worktree's HEAD. */
  targetSha: string
  /** Whether `repo` is the queue's own clone; see {@link FreshWorktree.populateReference}. */
  populateReference?: boolean
  /** Run once in the fresh worktree, after materialization and before any check. Absent, nothing runs. */
  setup?: SetupSpec
  /** Told how the setup went, pass or not, before a failure throws: the one place a caller records it. */
  record?: (ran: SetupRan) => void
  /**
   * Told the setup is ABOUT to run, with the log it will write. A setup is the
   * longest thing a fresh worktree does, so a caller that only hears how it
   * went has nothing to say for the whole length of it.
   */
  starting?: (about: Readonly<{ start: string; log: string }>) => void
  plumbing?: PlumbingLog
  process?: Process
  env?: NodeJS.ProcessEnv
}>

/** A worktree, plus what every program run in it is told about the tree it judges. */
export type PreparedWorktree = Worktree & Readonly<{ tree: CheckedTree }>

/**
 * What a program run in `worktree` is told about the tree it stands in: the
 * HEAD checked out there, and the merge base of that HEAD and the target.
 *
 * Read from the tree itself rather than carried in by the caller, so it is a
 * record about what is checked out; read once per worktree, because it costs two
 * git calls and every check in that worktree is judging the same thing. A HEAD
 * that shares no history with the target throws: a base that is not an
 * ancestor of the candidate is a lie a check would compute a diff from.
 */
export async function checkedTree(
  worktree: string,
  targetSha: string,
  process?: Process,
  selection?: GitSelection,
  options: GitInvocationOptions = {},
): Promise<CheckedTree> {
  const wt = gitIn(worktree, process, selection, options)
  const candidate = (await wt(["rev-parse", "HEAD"])).trim()
  const base = await mergeBase(wt, candidate, targetSha)
  if (base === undefined) {
    throw new Error(
      `${worktree} stands at ${candidate.slice(0, 12)}, which shares no history with the target ${targetSha.slice(0, 12)}: there is no base to tell a check`,
    )
  }
  return { base, candidate }
}

/**
 * A setup that did not pass. Worktree lifecycle belongs to the caller: the
 * queue removes its ephemeral tree, while an environment keeps its retained
 * tree for inspection. This says nothing about whose failure it is, because
 * one worktree cannot know: the queue decides that by running the same setup
 * on the settled base alone (run.ts, `attributedSetupFailure`) — a base that
 * passes makes the candidate's content the failure and its submitter the
 * owner, and a base that fails is the queue's own ground and nobody's bill.
 *
 * `diagnosis`, when the failing command named `--frozen-lockfile`, is
 * lockfile-diagnosis.ts's own forensics — appended onto this error's message
 * too, so any reader of `.message` alone (a log, a bare `String(error)`, this
 * class's existing callers) already carries it, not only a caller that reads
 * the field.
 */
export class SetupFailed extends Error {
  constructor(
    readonly ran: SetupRan,
    readonly commit: string,
    readonly diagnosis?: string,
  ) {
    const { result } = ran
    super(
      `setup ${result.result} for ${commit.slice(0, 12)}: exit ${String(result.exit)}${result.why === undefined ? "" : ` (${result.why})`}; log ${result.log}` +
        (diagnosis === undefined ? "" : `\n${diagnosis}`),
    )
    this.name = "SetupFailed"
  }
}

/**
 * Run the target's declared setup in one materialized worktree.
 *
 * This function owns execution and attribution, never lifecycle: an ephemeral
 * queue worktree removes itself when this throws, while a retained environment
 * deliberately stays in place for inspection. Keeping cleanup at the caller
 * is what lets both use one setup runner without making one pretend to be the
 * other.
 */
export async function runSetup(options: RunSetup): Promise<SetupRan> {
  const { cwd, tree, setup } = options
  const start = new Date().toISOString()
  options.starting?.({ log: checkLogPath(setup.logDir, SETUP), start })
  const result = await runCheck({
    cwd,
    env: options.env,
    logDir: setup.logDir,
    process: options.process,
    tmpdir: setup.tmpdir,
    spec: { name: SETUP, run: setup.run, timeoutMs: setup.timeoutMs ?? DEFAULT_CHECK_BOUND_MS },
    tree,
  })
  const ran: SetupRan = { end: new Date().toISOString(), result, start }
  options.record?.(ran)
  if (result.result !== "pass") {
    // Narrow trigger, one function (lockfile-diagnosis.ts): a no-op unless
    // the declared setup line itself names --frozen-lockfile, in which case
    // it re-resolves once, inside this same worktree, before it is torn down
    // below by the caller's catch, and names every entry that moved.
    const diagnosis = await frozenLockfileDiagnosis({
      cwd,
      env: options.env,
      process: options.process,
      setupRun: setup.run,
    })
    throw new SetupFailed(ran, tree.candidate, diagnosis)
  }
  return ran
}

/**
 * `freshWorktree`, what the tree holds read once, then the target's `setup:` in
 * it: one shell command, the built check environment (`PATH`, `HOME`, `SHELL`,
 * `LANG`, `USER`, `LOGNAME`, `LC_*`, the temp root as `TMPDIR`, and the
 * three the queue states about the tree), the check bound, and a log of its own
 * — the check driver runs it, so a setup and a check are provisioned, bounded
 * and recorded by one piece of code rather than two that drift.
 *
 * Only `pass` prepares a worktree. A setup that exits anything else, runs past
 * its bound or is not there throws `SetupFailed` with the worktree already
 * removed, and a half-prepared tree never judges anything: what no commit
 * describes cannot be checked. Whose failure it was is the caller's reading,
 * not this one's — see `SetupFailed`.
 */
export async function prepareWorktree(
  git: Git,
  repo: string,
  commit: string,
  path: string,
  options: PrepareWorktree,
): Promise<PreparedWorktree> {
  const worktree = await freshWorktree(git, repo, commit, path, {
    ...(options.populateReference === undefined ? {} : { populateReference: options.populateReference }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.gitOptions === undefined ? {} : { gitOptions: options.gitOptions }),
    ...(options.plumbing === undefined ? {} : { plumbing: options.plumbing }),
    ...(options.process === undefined ? {} : { process: options.process }),
    ...(options.selection === undefined ? {} : { selection: options.selection }),
  })
  try {
    const tree = await checkedTree(worktree.path, options.targetSha, options.process, options.selection, {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...options.gitOptions,
    })
    const prepared: PreparedWorktree = { ...worktree, tree }
    const setup = options.setup
    if (setup !== undefined) {
      await runSetup({
        cwd: worktree.path,
        env: options.env,
        process: options.process,
        record: options.record,
        setup,
        starting: options.starting,
        tree,
      })
    }
    return prepared
  } catch (error) {
    await worktree.remove()
    throw error
  }
}

async function removeWorktree(git: Git, path: string): Promise<void> {
  // `worktree remove --force` refuses a tree with untracked files it did not
  // make; a check may have written anything, so the directory goes first and
  // git is told to forget the entry afterwards.
  rmSync(path, { force: true, recursive: true })
  await git(["worktree", "prune"])
}

/**
 * What a successful materialization did NOT borrow, or undefined when it
 * borrowed everything.
 *
 * Read only after {@link materializedWorktree} has admitted the result, so the
 * four counts are known-good integers by then and only the path arrays are
 * checked here. They are optional on purpose: a git-super that predates them
 * reports counts alone, and a warning that names how many is still worth
 * writing — it is the version that names WHICH that costs nothing to use when
 * it is there.
 */
function degradedGitlinks(
  value: unknown,
):
  | Readonly<{ absent: number; borrowed: number; considered: number; fetched: number; paths: readonly string[] }>
  | undefined {
  const counts = (value as { gitlinks?: Record<string, unknown> }).gitlinks
  if (counts === undefined) return undefined
  const { absent, borrowed, considered, fetched } = counts as Record<string, number>
  if (absent === undefined || borrowed === undefined || considered === undefined || fetched === undefined) {
    return undefined
  }
  if (fetched === 0 && absent === 0) return undefined
  const named = [counts["fetchedPaths"], counts["absentPaths"]]
    .filter((list): list is readonly string[] => Array.isArray(list))
    .flat()
    .filter((entry): entry is string => typeof entry === "string")
  return { absent, borrowed, considered, fetched, paths: named }
}

/** Validate the external command's success claim before admitting its tree. */
function materializedWorktree(value: unknown, path: string, commit: string): boolean {
  if (typeof value !== "object" || value === null) return false
  const result = value as Record<string, unknown>
  if (
    result.state !== "updated" ||
    result.partial !== false ||
    result.path !== path ||
    result.requested !== commit ||
    result.commit !== commit ||
    result.gitmodules !== true
  ) {
    return false
  }
  if (
    !Array.isArray(result.repositories) ||
    result.repositories.length === 0 ||
    !result.repositories.every((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false
      const repository = entry as Record<string, unknown>
      return (
        typeof repository.repository === "string" &&
        (repository.state === "updated" || repository.state === "unchanged") &&
        Array.isArray(repository.refs) &&
        repository.refs.length === 0
      )
    })
  ) {
    return false
  }
  if (typeof result.gitlinks !== "object" || result.gitlinks === null) return false
  const counts = result.gitlinks as Record<string, unknown>
  const { considered, borrowed, fetched, absent } = counts
  if (
    ![considered, borrowed, fetched, absent].every(
      (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    )
  ) {
    return false
  }
  return considered === (borrowed as number) + (fetched as number) + (absent as number)
}
