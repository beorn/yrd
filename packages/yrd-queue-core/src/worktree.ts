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
 * hand would run in a tree the queue never builds.
 *
 * The plumbing's own narration (which submodule, borrowed or fetched, how
 * long) is trace-level: a debug log reads as the queue's decisions, not as a
 * git transcript. The caller hands in a logger only when trace is on.
 */

import { rmSync } from "node:fs"
import { materializeSubmodulesFromLocalWorktreeParallel } from "git-super/submodules"
import type { Process } from "@yrd/process"
import { checkLogPath, DEFAULT_CHECK_BOUND_MS, runCheck, type CheckedTree, type CheckResult } from "./check.ts"
import type { Git } from "./facts.ts"
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

/** The name the setup runs, logs and ends a change under. */
export const SETUP = "setup"

/** The target's `setup:`, with the two places its one run needs. */
export type SetupSpec = Readonly<{
  /** The declaration's `setup:`: one shell command, as a check's `run:` is. */
  run: string
  /** Where the setup's log goes, the check logs' own directory. */
  logDir: string
  /** The scratch root the setup gets as `TMPDIR`, as a check does. */
  scratch: string
  /** The bound; the check default unless the caller says otherwise. */
  timeoutMs?: number
}>

/** How one setup went: the check driver's own result, and when it ran. */
export type SetupRan = Readonly<{ result: CheckResult; start: string; end: string }>

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
 * fact about what is checked out; read once per worktree, because it costs two
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
 * A setup that did not pass. The worktree is already gone, and nobody is
 * billed: the setup is the queue's own ground, so a change that cannot be
 * prepared is stuck, never failed.
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
 * `freshWorktree`, what the tree holds read once, then the target's `setup:` in
 * it: one shell command, the built check environment (`PATH`, `HOME`, `SHELL`,
 * `LANG`, `USER`, `LOGNAME`, `LC_*`, the scratch root as `TMPDIR`, and the
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
  let tree: CheckedTree
  try {
    tree = await checkedTree(worktree.path, options.targetSha, options.process)
  } catch (error) {
    await worktree.remove()
    throw error
  }
  const prepared: PreparedWorktree = { ...worktree, tree }
  const setup = options.setup
  if (setup === undefined) return prepared
  const start = new Date().toISOString()
  options.starting?.({ log: checkLogPath(setup.logDir, SETUP), start })
  let result: CheckResult
  try {
    result = await runCheck({
      cwd: worktree.path,
      env: options.env,
      logDir: setup.logDir,
      process: options.process,
      scratch: setup.scratch,
      spec: { name: SETUP, run: setup.run, timeoutMs: setup.timeoutMs ?? DEFAULT_CHECK_BOUND_MS },
      tree,
    })
  } catch (error) {
    await worktree.remove()
    throw error
  }
  const ran: SetupRan = { end: new Date().toISOString(), result, start }
  options.record?.(ran)
  if (result.result !== "pass") {
    await worktree.remove()
    throw new SetupFailed(ran, commit)
  }
  return prepared
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
