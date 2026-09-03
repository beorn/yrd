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
import { join, relative, sep } from "node:path"
import { materializeSubmodulesFromLocalWorktreeParallel } from "git-super/submodules"
import type { Process } from "@yrd/process"
import { checkLogPath, DEFAULT_CHECK_BOUND_MS, runCheck, type CheckedTree, type CheckResult } from "./check.ts"
import type { Git } from "./records.ts"
import { gitIn, mergeBase } from "./git.ts"

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
export async function freshWorktree(
  git: Git,
  repo: string,
  commit: string,
  path: string,
  plumbing?: PlumbingLog,
): Promise<Worktree> {
  await git(["worktree", "add", "--quiet", "--detach", path, commit])
  const materialized = await materializeSubmodulesFromLocalWorktreeParallel({
    ...(plumbing === undefined ? {} : { log: plumbing }),
    // A pin the reference checkout has never fetched is fetched from the
    // component's remote. git-super's default (0) refuses the network and the
    // queue stuck on a change whose km pin was on km's main but not yet in
    // the reference's store (2026-09-03 10:52 PDT, @dev/2's 24089); a pin
    // that is not on its component's main still fails at the gitlink check.
    maxRemoteFallbacks: Number.POSITIVE_INFINITY,
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
    for (const path of await registeredWorktrees(git)) {
      const of = runOwning(root, path)
      const why = of === undefined ? undefined : dead.get(of)
      if (of === undefined || why === undefined) continue
      rmSync(path, { force: true, recursive: true })
      reaped.push({ of, path, why })
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

/** Every worktree the repository has registered, by path. The main worktree is among them and never under the root, so it is never a candidate. */
async function registeredWorktrees(git: Git): Promise<readonly string[]> {
  return (await git(["worktree", "list", "--porcelain"]))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((path) => path !== "")
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
  /** The target every base is measured against: `YRD_BASE_SHA` is the merge base of it and the worktree's HEAD. */
  targetSha: string
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
export async function checkedTree(worktree: string, targetSha: string, process?: Process): Promise<CheckedTree> {
  const wt = gitIn(worktree, process)
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
 * tree for inspection. Nobody is billed for a setup failure: setup is the
 * queue's own ground, so a change that cannot be prepared is stuck, never
 * failed.
 */
export class SetupFailed extends Error {
  constructor(
    readonly ran: SetupRan,
    readonly commit: string,
  ) {
    const { result } = ran
    super(
      `setup ${result.result} for ${commit.slice(0, 12)}: exit ${String(result.exit)}${result.why === undefined ? "" : ` (${result.why})`}; log ${result.log}`,
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
  if (result.result !== "pass") throw new SetupFailed(ran, tree.candidate)
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
 * removed: the queue could not build its own ground, which is never the
 * submitter's fault, and a half-prepared tree would judge something no commit
 * describes.
 */
export async function prepareWorktree(
  git: Git,
  repo: string,
  commit: string,
  path: string,
  options: PrepareWorktree,
): Promise<PreparedWorktree> {
  const worktree = await freshWorktree(git, repo, commit, path, options.plumbing)
  try {
    const tree = await checkedTree(worktree.path, options.targetSha, options.process)
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

function describe(result: Readonly<{ stderr?: string; stdout?: string; message?: string }>): string {
  return (result.message ?? result.stderr ?? result.stdout ?? "no detail").trim().slice(0, 400)
}
