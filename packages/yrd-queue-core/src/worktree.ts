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

import { existsSync, lstatSync, readdirSync, readlinkSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Process } from "@yrd/process"
import { createGitWorktreeStore } from "git-super/worktree"
import { checkLogPath, DEFAULT_CHECK_BOUND_MS, runCheck, type CheckedTree, type CheckResult } from "./check.ts"
import { frozenLockfileDiagnosis } from "./lockfile-diagnosis.ts"
import type { LogWrite } from "./log.ts"
import {
  declaredSubmodules,
  GIT_SUPER_ABSENT_STORE,
  populateReferenceStores,
  ReferenceUnpopulated,
} from "./reference.ts"
import {
  GitExit,
  gitIn,
  mergeBase,
  refAt,
  runnerFor,
  resolveGitSelection,
  seamProcess,
  type Git,
  type GitInvocationOptions,
  type GitSelection,
} from "./git.ts"

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
  /**
   * The root-relative submodule paths this tree holds uninitialized and asks
   * every later git-super call in the same compose to exclude
   * (`--exclude-submodule`, 27147). The queue chooses none of its own, so a
   * tree it builds carries an empty list.
   */
  excludedSubmodules: readonly string[]
  /** Remove the worktree and everything under it. */
  remove(): Promise<void>
}>

/** What a fresh worktree needs beyond the repository and the commit: how to run Git elsewhere, and where to narrate. */
export type FreshWorktree = Readonly<{
  /**
   * Root gitlinks the tree leaves empty and uninitialized (`--exclude-submodule`). Absent means a full tree, which is
   * what the queue's checks, `yrd check` and `yrd env` need. Only submit passes it, for the gitlinks nobody moved
   * (29560); git-super's merge refuses an exclusion whose pin differs at HEAD, the target or their one merge base.
   */
  excludedSubmodules?: readonly string[]
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
  const objects = runnerFor(git).objects
  // Query the selected commit, not the reference checkout's working tree.
  // An invalid commit makes ls-tree fail; only empty output means absence.
  const modules = await git(["ls-tree", commit, "--", ".gitmodules"])
  const excluded: readonly string[] = [...new Set(options.excludedSubmodules ?? [])].sort()
  if (excluded.length > 0) {
    // Only a declared submodule can be left out; any other path is the caller's error, never dropped (@cto 7015ba5e).
    const declared = await declaredSubmodules(git, commit)
    const undeclared = excluded.filter((excludedPath) => !declared.has(excludedPath))
    if (undeclared.length > 0) {
      throw new Error(
        `fresh worktree ${path} at ${commit}: cannot leave out ${undeclared.join(", ")}, ` +
          (modules.trim() === ""
            ? "because that commit records no .gitmodules"
            : "because that commit's .gitmodules declares no submodule at that path") +
          "; only a declared submodule can be excluded",
      )
    }
  }
  if (modules.trim() === "") {
    // A commit that declares no submodules has no boundary for git-super to
    // cross. `worktreeWithoutSubmodules` re-asks that question rather than
    // trusting this branch, so a refactor that moves the call cannot silently
    // take the plain path with a submodule-bearing commit.
    await worktreeWithoutSubmodules(git, git, commit, ["add", "--quiet", "--detach", path, commit])
  } else {
    if (options.populateReference === true) {
      const selection =
        options.selection ?? (await resolveGitSelection(repo, { process: options.process, env: options.env }))
      const gitAt = (cwd: string): Git =>
        gitIn(cwd, options.process, selection, {
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(objects === undefined ? {} : { objects }),
          ...options.gitOptions,
        })
      await populateReferenceStores({
        acquired: (pin) => {
          plumbing?.journal?.({
            action: "acquired",
            head: commit,
            kind: "reference",
            path: pin.path,
            sha: pin.sha,
            source: pin.source,
            ...(pin.source === "local" ? { localSource: pin.localSource } : {}),
            ...(pin.source === "remote" && pin.localMiss !== undefined
              ? { localSource: pin.localMiss.localSource, localMissReason: pin.localMiss.reason }
              : {}),
          })
        },
        commit,
        excludedSubmodules: excluded,
        gitIn: gitAt,
        populated: (store) => {
          plumbing?.journal?.({ head: commit, kind: "reference", ms: store.ms, path: store.path, sha: store.sha })
        },
        repo,
      })
    }
    let output: string
    try {
      output = await git([
        "super",
        "--json",
        ...(objects === undefined
          ? []
          : [
              "--repo",
              resolve(repo),
              "--object-directory",
              objects.directory,
              ...(objects.alternates ?? []).flatMap((alternate) => ["--alternate-object-directory", alternate]),
            ]),
        "worktree",
        "add",
        path,
        commit,
        "--reference",
        repo,
        ...excluded.flatMap((excludedPath) => ["--exclude-submodule", excludedPath]),
      ])
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
      throw new Error(formatGitSuperWorktreeRefusal(error, path, commit, repo), { cause: error })
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
    excludedSubmodules: excluded,
    path,
    remove: async () => {
      await removeWorktree(git, path, repo, options)
      plumbing?.trace?.("released worktree", { commit, path })
    },
  }
}

/** The pid file a run writes beside its worktrees. Public until the run contract retires. */
export const RUN_PID = ".pid"

/** Claim a run's worktrees before it makes one, so an absent pid never means a live run is dead. */
export function claimWorktrees(directory: string, pid: number = process.pid): void {
  writeFileSync(join(directory, RUN_PID), `${String(pid)}\n`)
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
  queueRun?: boolean
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
  /** Set only by the event queue runner; setup otherwise uses seat admission. */
  queueRun?: boolean
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
  const resolved = selection ?? (await resolveGitSelection(worktree, { process, env: options.env }))
  const wt = gitIn(worktree, process, resolved, options)
  const candidate = (await wt(["rev-parse", "HEAD"])).trim()
  const base = await mergeBase(wt, candidate, targetSha)
  if (base === undefined) {
    throw new Error(
      `${worktree} stands at ${candidate.slice(0, 12)}, which shares no history with the target ${targetSha.slice(0, 12)}: there is no base to tell a check`,
    )
  }
  return { base, candidate }
}

/** One file the candidate changed, as the merge commit records it and as it lies on disk. */
export type JudgedFile = Readonly<{
  path: string
  /** The blob the merge commit records at `path`. */
  committed: string
  /** The bytes actually on disk in the judged root, hashed; `absent` if the file is not there. */
  ondisk: string
  same: boolean
}>

/**
 * WHAT THE CHECKS ARE ABOUT TO READ, HASHED — the answer to "was this the right
 * tree", asked before anything is judged rather than reconstructed afterwards.
 *
 * 24573: the queue judged a change on a merge root whose `tools/affected-tests.ts`
 * did not carry a symbol the candidate had added, on a file the other side had
 * not touched in the entire range. Three rounds of a good change were spent on
 * it, and nobody could say which step produced the wrong bytes, because the root
 * is torn down as the run ends and every diagnosis had to be an inference from
 * behaviour. Behaviour cannot separate `the module was stale` from `my logic is
 * wrong`; both read as `the answer is not what I expected`.
 *
 * THIS COMPARISON IS DELIBERATELY SELF-REFERENTIAL. It asks whether the root
 * contains the commit it CLAIMS to be — the blob oid the merge commit records
 * against the hash of the bytes on disk — and takes no candidate sha as input.
 * A check given the candidate sha can be fooled by being handed the wrong one;
 * this cannot. A disagreement names root construction outright. Agreement means
 * the bytes were right and whatever went wrong lives above the filesystem, in
 * resolution, which is the half no instrument could reach.
 *
 * ONLY THE PATHS THE CANDIDATE CHANGED, because those are the ones a stale tree
 * silently reverts and the only ones worth two hashes each. Gitlinks are skipped:
 * a submodule path is a directory here and its pin is already journalled by the
 * settle rows.
 *
 * A file the merge DELETED is reported with `ondisk: "absent"` and `same: true`
 * rather than omitted — the row says the deletion was carried out, which is a
 * different fact from the path never having been looked at.
 */
export async function judgedTreeDigest(
  worktree: string,
  tree: CheckedTree,
  process?: Process,
  selection?: GitSelection,
  options: GitInvocationOptions = {},
): Promise<readonly JudgedFile[]> {
  const resolved = selection ?? (await resolveGitSelection(worktree, { process, env: options.env }))
  const wt = gitIn(worktree, process, resolved, options)
  // --raw carries the mode, which is the only way to tell a gitlink from a file
  // without a second call per path; -z because a path may carry anything.
  const raw = await wt(["diff", "--raw", "--no-renames", "-z", tree.base, tree.candidate])
  const fields = raw.split("\0")
  const files: JudgedFile[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const meta = fields[index]
    if (meta === undefined || !meta.startsWith(":")) continue
    const path = fields[index + 1]
    if (path === undefined || path === "") continue
    index += 1
    // ":<srcmode> <dstmode> <srcsha> <dstsha> <status>"
    const destinationMode = meta.slice(1).split(" ")[1]
    if (destinationMode === "160000") continue
    // The merge commit does not carry this path only when the candidate
    // deleted it. `refAt` reserves undefined for that Git answer and leaves
    // every unreadable object or invocation fault loud.
    const committed = (await refAt(wt, `${tree.candidate}:${path}`, "blob")) ?? "deleted"
    let ondisk: string
    try {
      const onDiskPath = join(worktree, path)
      // Git hashes a symlink's stored link text. `hash-object -- path` follows
      // it, so feed readlink's bytes through the same Git object hasher.
      ondisk = lstatSync(onDiskPath).isSymbolicLink()
        ? (await wt(["hash-object", "--stdin"], readlinkSync(onDiskPath))).trim()
        : (await wt(["hash-object", "--", path])).trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // The deleted candidate path is absent on disk: a reported, matching
        // deletion, never a missing observation.
        ondisk = "absent"
      } else {
        throw new Error(
          `cannot hash judged path ${path} in ${worktree}: ${error instanceof Error ? error.message : String(error)}`,
          {
            cause: error,
          },
        )
      }
    }
    const same = committed === "deleted" ? ondisk === "absent" : committed === ondisk
    files.push({ committed, ondisk, path, same })
  }
  return files
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
    queueRun: options.queueRun,
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
  const objects = runnerFor(git).objects
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
      ...(objects === undefined ? {} : { objects }),
      ...options.gitOptions,
    })
    const prepared: PreparedWorktree = { ...worktree, tree }
    const setup = options.setup
    if (setup !== undefined) {
      await runSetup({
        cwd: worktree.path,
        env: options.env,
        queueRun: options.queueRun,
        process: options.process,
        record: options.record,
        setup,
        starting: options.starting,
        tree,
      })
    }
    return prepared
  } catch (error) {
    // 28661 C4: the cleanup runs through the ONE refusal handler, so a store-protection refusal cannot mask the
    // verdict this catch is carrying (a SetupFailed from runSetup stays a SetupFailed).
    await discardWorktree(worktree)
    throw error
  }
}

/** Discard a prepared worktree at the end of a round. */
export async function discardWorktree(tree: Worktree): Promise<void> {
  await tree.remove()
}

/** Paths already named, so an abandoned tree is announced once per process rather than once per round. */
const namedAbandonedTrees = new Set<string>()

/** One loud line: the tree stays, the queue continues, and the cure is the operator's. */
export function nameAbandonedTree(path: string, why: string): void {
  if (namedAbandonedTrees.has(path)) return
  namedAbandonedTrees.add(path)
  console.warn(`yrd: kept worktree ${path}: ${why}; the queue skips it and continues\n`)
}

/**
 * Remove one worktree and forget its registration, inside git-super's repository worktree mutation
 * lock (26240) and through its removal primitive.
 *
 * A check may have written anything, so the tree is not clean when it goes. `remove` handles that
 * itself: it renames the whole directory aside — untracked files ride along — leaves a `.git` stub,
 * and runs `git worktree remove --force` against the stub, which is why the entry is forgotten and
 * the staged copy deleted in that order. A hand-rolled `rmSync` could not see the admin-dir custody
 * or the private-store refusal the primitive checks first (28665).
 *
 * `repo` must be a CHECKOUT, never a git dir (27392): git-super's store reads `<repo>/.git` for its
 * own metadata pointer, so handing it `--git-common-dir` made a linked (commondir) worktree die
 * ENOENT. Every caller here already holds the reference checkout.
 *
 * The store asks Git about the TREE as well as the reference — its own `rev-parse --show-toplevel`
 * at `path` is what decides the path is a worktree root at all — so the seam answers for both roots,
 * each with a runner bound to its own cwd. That runner is built only when the store asks for it, so
 * a call whose store is stubbed still reaches no Git.
 *
 * This is NOT the cure for the 28661 prune hole: `store.remove` forgets one named registration, and
 * a bare `git worktree prune` can still destroy a store no preview named.
 */
async function removeWorktree(git: Git, path: string, repo: string, options: FreshWorktree): Promise<void> {
  const checkout = resolve(repo)
  const at = (cwd: string): Git => {
    const inherited = runnerFor(git)
    if (
      options.process === undefined &&
      options.env === undefined &&
      options.selection === undefined &&
      options.gitOptions === undefined
    ) {
      return inherited.at(cwd)
    }
    const selection = options.selection ?? inherited.selection
    return gitIn(cwd, options.process, selection, {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(inherited.objects === undefined ? {} : { objects: inherited.objects }),
      ...options.gitOptions,
    })
  }
  // No options, so no borrowers or compaction result to read.
  await createGitWorktreeStore({
    gitProcess: seamProcess(git, checkout, { also: [path], at }),
    repo: checkout,
  }).remove(path)
}

/** An ended run drops its parent only after every child worktree is gone. */
export function removeEmptyWorktreeRunDirectory(directory: string): void {
  try {
    rmdirSync(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      console.warn(
        `yrd: kept non-empty worktree run directory ${directory} (${code}); inspect its contents before cleanup`,
      )
      return
    }
    throw error
  }
}

/**
 * 28661 C4: clear a round's worktrees SCAFFOLD without deleting a checkout the round kept.
 *
 * The enclosing cleanup used to be `rmSync(directory, { recursive: true })`, and that walks straight past
 * a removal a round did not complete. So the sweep is structural: every FILE goes, and every directory
 * that is itself a checkout survives WHOLE, with everything under it.
 *
 * The tell is simple: a checkout is the directory carrying a `.git` entry. Keeping EVERY such directory is
 * a superset of keeping the ones a removal would preserve, so this cannot under-protect, and a tree that
 * survives without having been named is named here. It is the same tree whether it is a legacy check's, a
 * program root's `P`/`C`, or one left by a preparation that failed after its worktree existed: none of
 * them is scaffold.
 *
 * Never throws on a kept tree and never touches the caller's verdict — a cleanup that replaced a pass or a
 * SetupFailed with its own error would be the very defect this closes (C4).
 */
export function removeWorktreeRunScaffold(directory: string): void {
  if (!existsSync(directory)) return
  const root = resolve(directory)
  const kept: string[] = []
  const checkouts = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = join(current, entry.name)
      if (existsSync(join(child, ".git"))) {
        kept.push(resolve(child))
        // Loud, and once per path: this tree outlives the round and its custody is the operator's (27058).
        nameAbandonedTree(child, "left by a removal this round did not complete")
        continue
      }
      checkouts(child)
    }
  }
  checkouts(directory)
  // Every checkout, and every ancestor on the way to the sweep root, stays: a kept checkout needs its scaffold.
  const surviving = new Set<string>()
  for (const checkout of kept) {
    for (let at = checkout; ; at = dirname(at)) {
      surviving.add(at)
      if (at === root || at === dirname(at)) break
    }
  }
  const clear = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (surviving.has(resolve(child))) continue
      if (entry.isDirectory()) {
        clear(child)
        rmdirSync(child)
      } else {
        rmSync(child, { force: true })
      }
    }
  }
  clear(directory)
  try {
    rmdirSync(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // ENOENT: already gone. ENOTEMPTY/EEXIST: a named checkout holds it open, and the warn above is its record.
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error
  }
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

/**
 * The ONE place a raw `git worktree add|remove` is issued, and it proves its own
 * precondition before issuing one.
 *
 * THE INVARIANT IS A CONDITION, NOT A SHAPE (@chief ruling 2026-09-11,
 * @hh/tooling/24502). Every worktree mutation must cross the git-super adapter
 * when the commit declares submodules — and a commit that declares none has no
 * submodule boundary to cross, so there is nothing there for the invariant to
 * bind. That is the invariant's own SCOPE, not an exemption from it: an
 * exemption would assert the hazard is present and tolerated, and invite a
 * waiver review that should never come.
 *
 * ONE QUESTION ASKED IN THREE PLACES, two of which precede a mutation:
 * `freshWorktree` here, `closeEnvironment` in yrd-cli, and `declaredSubmodules`
 * in reference.ts, which only early-returns. Both mutating sites now route
 * through this function, so the identity a guard has to track is one symbol
 * rather than a neighbourhood.
 *
 * AND IT RE-ASKS RATHER THAN TRUSTING ITS CALLER. A scanner proves the code sits
 * in the right branch AS WRITTEN TODAY; this proves it EVERY TIME IT RUNS,
 * including after a refactor moves the call out from under the probe. That is
 * the condition a static matcher cannot see, which by our own rule is exactly
 * the condition worth failing loudly on.
 *
 * The probe and the mutation take separate Git handles on purpose: the question
 * is about a COMMIT, which is answered wherever that commit is readable, while
 * the mutation belongs to the repository that owns the worktree registry. In
 * `closeEnvironment` those are two different repositories.
 */
export async function worktreeWithoutSubmodules(
  read: Git,
  mutate: Git,
  commit: string,
  argv: readonly string[],
): Promise<string> {
  const declared = (await read(["ls-tree", commit, "--", ".gitmodules"])).trim()
  if (declared !== "") {
    throw new Error(
      `refusing a plain git worktree ${argv[0] ?? "(no verb)"} for ${commit}: that commit RECORDS .gitmodules, ` +
        `so its gitlinks must be materialized through git super worktree ${argv[0] ?? ""} instead. ` +
        "A plain worktree call stops at the gitlink and leaves every submodule unmaterialized. " +
        "Reached here because a caller took the no-submodule path for a commit that has them " +
        "(@hh/tooling/24502); fix the caller rather than this check.",
    )
  }
  return mutate(["worktree", ...argv])
}

function formatGitSuperWorktreeRefusal(error: unknown, path: string, commit: string, _repo: string): string {
  let command: string | undefined
  let exitCode: string
  let stderrDetail: string

  if (error instanceof GitExit && error.evidence?.result === undefined && error.evidence?.failure !== undefined) {
    command = undefined
    exitCode = "none (the runner returned no exit result)"
    stderrDetail = error.detail
  } else if (error instanceof GitExit) {
    command = `git ${error.args.join(" ")} in ${error.cwd}`
    exitCode = String(error.exitCode)
    stderrDetail = error.detail
  } else {
    const said = error instanceof Error ? error.message : String(error)
    const match = said.match(/^git (.*) in (.*) exited (\d+): (.*)$/s)
    if (
      match !== null &&
      match[1] !== undefined &&
      match[2] !== undefined &&
      match[3] !== undefined &&
      match[4] !== undefined
    ) {
      command = `git ${match[1]} in ${match[2]}`
      exitCode = match[3]
      stderrDetail = match[4]
    } else {
      command = undefined
      exitCode = "none (the command did not run)"
      stderrDetail = said
    }
  }

  let text = stderrDetail
  try {
    const parsed: unknown = JSON.parse(stderrDetail)
    const detailObj =
      typeof parsed === "object" && parsed !== null && "detail" in parsed
        ? (parsed as Record<string, unknown>).detail
        : undefined
    const detailMsg =
      typeof detailObj === "object" && detailObj !== null && "message" in detailObj
        ? (detailObj as Record<string, unknown>).message
        : undefined
    const detailRemedy =
      typeof detailObj === "object" && detailObj !== null && "remedy" in detailObj
        ? (detailObj as Record<string, unknown>).remedy
        : undefined
    const topMsg =
      typeof parsed === "object" && parsed !== null && "message" in parsed
        ? (parsed as Record<string, unknown>).message
        : undefined

    if (typeof detailMsg === "string") {
      text = detailMsg
      if (typeof detailRemedy === "string" && !detailMsg.includes(detailRemedy)) {
        text = `${text}\nremedy: ${detailRemedy}`
      }
    } else if (typeof topMsg === "string") {
      text = topMsg
    }
  } catch {
    // silent-fallback-allow: git-super output is plain text rather than JSON when it crashes before emitting structured output
  }

  const rawLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const fatalLines: string[] = []
  const otherLines: string[] = []
  for (const line of rawLines) {
    if (/^fatal:/i.test(line)) {
      fatalLines.push(line)
    } else {
      otherLines.push(line)
    }
  }
  const orderedStderrLines = [...fatalLines, ...otherLines]

  const lines = [
    `worktree ${path} at ${commit} requires git-super because that commit records .gitmodules; git super worktree add failed:`,
    ...(command !== undefined ? [`command: ${command}`] : []),
    `exit code: ${exitCode}`,
    ...orderedStderrLines,
    "Ensure git-super is available on PATH and resolve the reported condition before retrying; no plain-git fallback was attempted",
  ]
  return lines.join("\n")
}
