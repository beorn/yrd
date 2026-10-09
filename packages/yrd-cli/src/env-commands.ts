/**
 * `yrd env open|list` — an environment for one branch
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Commands;
 * `yrd bay` is the same command's alias and "bay" its internal name).
 *
 * An environment is a git worktree under the one worktree home
 * (`/hh/var/wt` via `worktreeHomeRoot`); that worktree is its whole
 * identity and lifecycle. Existing `.bays/` trees remain visible to list
 * and close until they move. Opening it runs the target's declared setup after
 * materialization, through the same bounded executor as the queue, but never
 * creates an app, journal or job: the durable `Bay` record, its lifecycle
 * states, the PR mint and the receiver remote went with the old core at M6,
 * and nothing that is left reads them.
 *
 * So `list` reads the worktrees git itself holds under the bays root rather
 * than a record of what was once opened. One source for each update: if git does not
 * have the worktree, the environment is not there.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { createGitWorkspace, worktreeHomeRoot, type ProvisionedBay } from "@yrd/bay"
import {
  checkedTree,
  declaredPrivateSubmodules,
  freshWorktree,
  registeredWorktrees,
  runCheck,
  gitIn,
  issueOf,
  readConfig,
  readRemoteCommit,
  refAt,
  resolveGitSelection,
  retirePreviewSubject,
  runId,
  runSetup,
  SetupFailed,
  worktreeWithoutSubmodules,
  type Git,
  type GitRunner,
} from "@yrd/queue-core"
import { createProcess } from "@yrd/process"
import { createLocalGitWorktreeStore } from "git-super/worktree"
import { repositoryHere as findRepository } from "./declaration.ts"
import { originHead } from "./queue-location.ts"
import { issueResolver } from "./issue-resolver.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"
import { workdirOf } from "./workdir.ts"
import { admitEnvironmentClose, type CloseAdmission, type CloseCensusReceipt } from "./env-close-holders.ts"
import {
  ENV_CLOSE_PREDICATE,
  requesterOf,
  writeCloseRequest,
  type EnvCloseRequest,
  type EnvCloseRequestOptions,
} from "./env-close-requests.ts"
import type { ProcessCensus } from "removely"
import { formatUnknownTopLevelKeyWarning } from "./version.ts"

export type EnvOpenOptions = Readonly<{ bay?: string; issue?: string; json?: boolean; commit?: string; hold?: string }>
export type EnvCloseOptions = Readonly<{ json?: boolean; retain?: string; noRehome?: boolean }>

/**
 * The close was ACCEPTED, not done: this caller's same-UID CWD census could not
 * certify it, so a context whose census reads every pid (the queue's own round,
 * ruling 27723) will run the same close lifecycle.
 *
 * Distinct from 0 on purpose. The caller asked for a close and the environment
 * still exists, so `yrd env close X && <assumes X gone>` must not proceed on a
 * lie — the exit-0-on-disagreement class. Precedent: hab run's accepted-not-done
 * `HAB_RUN_REPORT_EXIT = 4` (hab-subcommands/run.ts).
 */
export const ENV_CLOSE_QUEUED_EXIT = 4

/**
 * This invocation's same-UID CWD census could not certify the close. It carries
 * the census receipt, so a queue-round caller can bound its own retry without
 * parsing prose, and its message is the loud refusal this path threw before
 * 22894 (the environment is preserved).
 *
 * A QUEUE-ROUND caller refuses with this and never delegates: a request pass or
 * a sweep close that filed a request would be a close nobody asked for, run
 * under the asked-for rule.
 */
export class IncompleteCensusError extends Error {
  readonly refusal: string
  readonly census: CloseCensusReceipt
  constructor(refusal: string, census: CloseCensusReceipt, message: string) {
    super(message)
    this.name = "IncompleteCensusError"
    this.refusal = refusal
    this.census = census
  }
}

/** Who runs the close decides what an uncertifiable census means. */
export type CloseAdmissionMode = "delegate" | "refuse"
export type EnvListOptions = Readonly<{ json?: boolean }>

/** One environment as git holds it: a worktree under the bays root. */
export type EnvRow = Readonly<{ name: string; path: string; branch?: string; head?: string; hold: string | null }>

/**
 * The repository a command stands in, and the target its declaration names.
 * Absent declaration is loud: an environment is cut from the target, and
 * guessing `main` when the repository never said so is the silent default
 * this whole design refuses.
 */
function requireRepository(io: YrdCliIO): string {
  const cwd = io.cwd ?? process.cwd()
  const root = findRepository(cwd)
  if (root === undefined) {
    throw new Error(`yrd env needs a repository: no Git clone contains ${cwd}; run it inside a clone`)
  }
  return root
}

function baysRootOf(repo: string): string {
  return worktreeHomeRoot({ repo })
}

function legacyBaysRoot(repo: string): string {
  return join(repo, ".bays")
}

/** The base a fresh environment is cut from: the target as origin answers it
 * now, read with its objects in one fetch (28133). The tracking ref is only as
 * new as this checkout's last fetch: on 2026-10-08 an environment cut from it
 * sat 60 s behind main and missed the merge it needed. An origin with no such
 * branch leaves the tracking ref, else the local branch of that name. Named, so
 * a refusal says which ref was missing rather than "could not resolve HEAD". */
async function resolveBaseSha(git: Git, target: string): Promise<string> {
  const branchRef = `refs/heads/${target}`
  const tracking = `refs/remotes/origin/${target}`
  let head: string | undefined
  try {
    head = await readRemoteCommit(git, "origin", branchRef)
  } catch (error) {
    throw new Error(
      `yrd env open: origin did not answer for ${branchRef}, so its head is unknown and ${tracking} may be ` +
        `behind it; retry when origin answers: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (head !== undefined) return head
  const tracked = await refAt(git, tracking)
  if (tracked !== undefined) return tracked
  const local = await refAt(git, target)
  if (local !== undefined) return local
  throw new Error(`yrd: target '${target}' is absent at both ${tracking} and the local branch`)
}

/** A former full-path branch wins for this issue; otherwise every checkout chooses the same flat leaf. */
async function implicitIssueName(git: Git, issue: string): Promise<string> {
  const leaf = issue.split("/").at(-1) ?? issue
  if (leaf === issue) return issue
  const branchRef = `refs/heads/task/${issue}`
  if ((await refAt(git, branchRef)) !== undefined) return issue
  const remote = (await git(["ls-remote", "--refs", "origin", branchRef])).trim()
  if (remote === "") return leaf
  const rows = remote.split("\n")
  if (rows.every((row) => row.split("\t")[1] === branchRef)) return issue
  throw new Error(`yrd env open: origin returned unexpected refs while checking ${branchRef}: ${remote}`)
}

/**
 * The identity the harness declared for this caller, as `GIT_AUTHOR_NAME` /
 * `GIT_AUTHOR_EMAIL`. A seat exports both (hab re-declares them at launch), so
 * absent-both means "not a seat": the repository's global or common identity
 * stays in force untouched. Half-declared is refused rather than guessed —
 * completing it from the other half would misattribute in the exact way this
 * change exists to stop (#27299).
 */
function declaredSeatIdentity(): Readonly<{ email: string; name: string }> | undefined {
  const name = process.env.GIT_AUTHOR_NAME?.trim() ?? ""
  const email = process.env.GIT_AUTHOR_EMAIL?.trim() ?? ""
  if (name === "" && email === "") return undefined
  if (name === "" || email === "") {
    const declared = name === "" ? "GIT_AUTHOR_EMAIL" : "GIT_AUTHOR_NAME"
    const missing = name === "" ? "GIT_AUTHOR_NAME" : "GIT_AUTHOR_EMAIL"
    throw new Error(
      `yrd env open: the caller declares ${declared} without ${missing}; ` +
        `a seat identity needs both variables, or neither (leaving the repository's own identity in force)`,
    )
  }
  return { email, name }
}

/**
 * Every submodule the environment materialized, as paths relative to `root`,
 * read level by level from each present `.gitmodules` and kept only when the
 * checkout is really there (`<path>/.git` exists). Nested submodules are
 * included. A declared-but-unmaterialized submodule (a `private = true` one,
 * or one the base never carried) is left exactly as `yrd env open` left it.
 */
async function materializedSubmodulePaths(root: string, git: GitRunner): Promise<string[]> {
  const found: string[] = []
  const walk = async (rel: string): Promise<void> => {
    const dir = rel === "" ? root : join(root, rel)
    if (!existsSync(join(dir, ".gitmodules"))) return
    const at = rel === "" ? git : git.at(dir)
    const rows = (await at(["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"])).trim()
    if (rows === "") return
    for (const row of rows.split("\n")) {
      const sub = row.split(/\s+/u).slice(1).join(" ")
      const next = rel === "" ? sub : `${rel}/${sub}`
      if (!existsSync(join(root, next, ".git"))) continue
      found.push(next)
      await walk(next)
    }
  }
  await walk("")
  return found
}

/**
 * Pin the caller's declared identity into every submodule the environment
 * materialized. A submodule is its own repository, so the root's worktree
 * config never reaches it and a commit there fell through to the shared
 * `~/.gitconfig` identity — in this fleet the operator's, so a seat's commits
 * were attributed to the operator (#27403). The write is the submodule's OWN
 * local config; for a submodule of a linked worktree that file lives under the
 * worktree's git dir, so it cannot reach another worktree. A submodule that is
 * itself a linked worktree would store the write in the config every worktree
 * of that submodule inherits, so it is refused loudly.
 */
async function pinSubmoduleIdentities(
  root: string,
  git: GitRunner,
  identity: Readonly<{ email: string; name: string }>,
  io: YrdCliIO,
): Promise<void> {
  const pinned: string[] = []
  for (const rel of await materializedSubmodulePaths(root, git)) {
    const sub = git.at(join(root, rel))
    const gitDir = (await sub(["rev-parse", "--absolute-git-dir"])).trim()
    const commonDir = (await sub(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    if (gitDir !== commonDir) {
      throw new Error(
        `yrd env open: submodule ${rel} in ${root} is itself a linked worktree (git dir ${gitDir}, common dir ` +
          `${commonDir}); pinning an identity there would land in the config every worktree of that submodule ` +
          `inherits, so it is refused`,
      )
    }
    await sub(["config", "--local", "user.name", identity.name])
    await sub(["config", "--local", "user.email", identity.email])
    const pinnedName = (await sub(["config", "--get", "user.name"])).trim()
    if (pinnedName !== identity.name) {
      throw new Error(
        `yrd env open: pinning ${identity.name} in submodule ${rel} of ${root} did not take ` +
          `(user.name reads '${pinnedName}')`,
      )
    }
    pinned.push(rel)
  }
  if (pinned.length > 0) {
    io.stderr(
      `${root}: pinned seat identity ${identity.name} <${identity.email}> into ${pinned.length} materialized ` +
        `submodule(s) (${pinned.join(", ")}); a commit there names the seat\n`,
    )
  }
}

/**
 * Pin the caller's declared identity into the environment's OWN worktree
 * config, so a commit made there names the seat and not whichever seat last
 * wrote the shared config (#27299).
 *
 * `git config --worktree` writes the SHARED file unless the repository enables
 * `extensions.worktreeConfig` — that extension is exactly what gives a
 * worktree its own `config.worktree`, and enabling it is a repository
 * migration (paired with `core.bare`), so this never enables it. Without it the
 * pin is refused on stderr naming the migration the shared config's owner must
 * make first — with no by-hand substitute, because the manual form is the write
 * that would poison every co-resident worktree (@dev/review2, 2026-10-03) — and
 * the shared config is never written from here; the caller's exported
 * `GIT_AUTHOR_*` still names every commit. The write is verified against the
 * shared file and refused loudly if it ever landed there. Submodules the
 * environment materialized are pinned by {@link pinSubmoduleIdentities}, from
 * this same declared identity.
 */
async function pinDeclaredIdentity(path: string, git: GitRunner, io: YrdCliIO): Promise<void> {
  const identity = declaredSeatIdentity()
  if (identity === undefined) return
  const scoped = (
    await git(["config", "--local", "--type=bool", "--get", "--default=false", "extensions.worktreeConfig"])
  ).trim()
  if (scoped !== "true") {
    io.stderr(
      `${path}: not pinning ${identity.name} <${identity.email}> here: the repository does not enable ` +
        `extensions.worktreeConfig, so a per-worktree write is not available — git stores user.* in the shared ` +
        `config every co-resident worktree inherits. This is the shared config's own migration, made once by its ` +
        `owner (extensions.worktreeConfig together with its core.bare change); until it lands there is no by-hand ` +
        `substitute, and the caller's exported GIT_AUTHOR_*/GIT_COMMITTER_* still name every commit made here.\n`,
    )
    return
  }
  const sharedBefore = (await git(["config", "--local", "--get", "--default=", "user.name"])).trim()
  await git(["config", "--worktree", "user.name", identity.name])
  await git(["config", "--worktree", "user.email", identity.email])
  const sharedAfter = (await git(["config", "--local", "--get", "--default=", "user.name"])).trim()
  if (sharedAfter !== sharedBefore) {
    throw new Error(
      `yrd env open: pinning the seat identity in ${path} wrote the shared config ` +
        `(user.name '${sharedBefore}' became '${sharedAfter}'); extensions.worktreeConfig is enabled but git stored it ` +
        `outside this worktree`,
    )
  }
  io.stderr(
    `${path}: pinned seat identity ${identity.name} <${identity.email}> to worktree config; ` +
      `do not run bare git config user.* in linked worktrees\n`,
  )
  await pinSubmoduleIdentities(path, git, identity, io)
}

/**
 * A top-level declaration key this checkout's Yrd postdates reads as a warning
 * for `env open` and `env close`, never a refusal (27796). Both run only the
 * `setup:`/`teardown:` they know, so a mechanism newer than this parser is one
 * the QUEUE owns; refusing it stranded every environment on a week-old slot
 * (27187 fixed only `submit`, and the documented cure — open through main's
 * runtime — left the environment's own declaration unreadable to `env close`).
 * The queue's own round (up/run/merge/check) still reads strictly, because
 * running a declaration it cannot read in full is the silent error.
 */
function warnNewerDeclarationKeys(at: string, command: string, keys: readonly string[], io: YrdCliIO): void {
  io.stderr(formatUnknownTopLevelKeyWarning(at, command, keys))
}

/**
 * `yrd env open` — open an environment for one branch and keep it. Prints its
 * path on stdout, which is what a caller `cd`s into.
 */
export async function openEnvironment(options: EnvOpenOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const root = requireRepository(io)
  const selection = await resolveGitSelection(root)
  if (options.hold !== undefined && options.hold.trim() === "") {
    throw new Error("yrd env open --hold needs a non-empty reason")
  }
  const commit = options.commit
  if (commit !== undefined && options.issue !== undefined) {
    throw new Error(
      `yrd env open cannot bind --issue ${options.issue} to a detached commit; open a branch with --issue and no commit argument`,
    )
  }
  if (commit !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
    // The argument is an exact commit and nothing else; a BRANCH is opened
    // with --bay/--issue and no argument. Offering only `rev-parse HEAD`
    // answered a question the caller had not asked: it resolves to a commit
    // and detaches, discarding the branch identity they named.
    const resolved = await refAt(gitIn(root, undefined, selection), commit)
    throw new Error(
      `yrd env open takes an exact commit object ID as its argument, not '${commit}'.` +
        (resolved === undefined ? "" : ` '${commit}' is a ref here, and this argument never accepts one.`) +
        ` To open or adopt a branch, pass --bay <name> or --issue <ref> with no argument;` +
        ` the branch it opens or adopts is always task/<name>.` +
        ` To retain an exact commit detached, resolve one first with git rev-parse ${resolved === undefined ? "HEAD" : commit}.`,
    )
  }
  const target = commit === undefined ? await originHead(gitIn(root, undefined, selection)) : "HEAD"
  const name = (
    options.bay ??
    (options.issue === undefined
      ? undefined
      : await implicitIssueName(gitIn(root, undefined, selection), options.issue)) ??
    (commit === undefined ? `env-${Date.now().toString(36)}` : `${commit.slice(0, 12)}-${runId()}`)
  ).trim()
  if (name === "") throw new Error("yrd: --bay needs a name")
  const branch = commit === undefined ? `task/${name}` : undefined
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process, selection)
  const base = commit ?? (await resolveBaseSha(git, target))
  if (commit !== undefined && (await refAt(git, commit)) !== commit) {
    throw new Error(
      `yrd env open: commit ${commit} is not a commit object in ${root}; fetch that commit before opening it`,
    )
  }
  const config = await readConfig(
    git,
    base,
    { remote: "origin", branch: target },
    { newerKeys: (keys) => warnNewerDeclarationKeys(`${target} (${base.slice(0, 12)})`, "env open", keys, io) },
  )
  const resolveIssue = config === undefined ? undefined : issueResolver(config, root)
  // 27147: a submodule the base declares `private = true` is left empty and uninitialized; a detached
  // environment's freshWorktree reads the declaration itself.
  let provisioned: { path: string; headSha: string; baseSha: string; adoption: ProvisionedBay["adoption"] | "detached" }
  if (branch === undefined) {
    const environments = join(resolve(root, await workdirOf(git)), "environments")
    const path = resolve(environments, name)
    if (!path.startsWith(`${environments}/`)) throw new Error(`environment name '${name}' escapes ${environments}`)
    mkdirSync(environments, { recursive: true })
    await freshWorktree(git, root, base, path)
    provisioned = { path, headSha: base, baseSha: base, adoption: "detached" }
  } else {
    const shadow = await branchPathConflict(git, branch)
    if (shadow !== undefined) {
      throw new Error(
        `yrd env open: branch ${branch} cannot exist beside branch ${shadow}, because git stores a branch as a path; ` +
          `name the environment flat with --bay <name>${options.issue === undefined ? "" : ` --issue ${options.issue}`}`,
      )
    }
    const existing = (await registeredWorktrees(git)).find(
      (entry) => entry.branch === branch && resolve(entry.path) === resolve(baysRootOf(root), name),
    )
    if (existing !== undefined) {
      const treeGit = gitIn(existing.path, process, selection)
      await requireClean(treeGit, existing.path)
      const unmerged = (await treeGit(["log", "--oneline", `${base}..HEAD`])).trim()
      if (unmerged !== "") {
        throw new Error(
          `environment ${existing.path} has commits unmerged into requested base ${base}; continue in this environment:\n${unmerged}`,
        )
      }
      if (existing.locked !== undefined) {
        throw new Error(
          `environment ${existing.path} is locked${existing.locked === "" ? "" : `: ${existing.locked}`}; resolve the hold before reopening`,
        )
      }
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
      const reopen = [
        "yrd env open",
        ...(options.bay === undefined ? [] : [`--bay ${quote(options.bay)}`]),
        ...(options.issue === undefined ? [] : [`--issue ${quote(options.issue)}`]),
        ...(options.hold === undefined ? [] : [`--hold ${quote(options.hold)}`]),
        ...(options.json === true ? ["--json"] : []),
      ].join(" ")
      throw new Error(
        `environment ${existing.path} is clean and merged into requested base ${base}; to continue: yrd env close ${quote(existing.path)} && ${reopen}`,
      )
    }
    const workspace = await createGitWorkspace({ repo: root, baysRoot: baysRootOf(root), process })
    const excludedSubmodules = await declaredPrivateSubmodules(git, resolve(root), base)
    const result = await workspace.provision({ bay: name, name, branch, base, excludedSubmodules })
    if (result.conclusion !== "success") {
      throw new Error(`yrd: could not open environment '${name}': ${result.error.message}`)
    }
    provisioned = result.output
  }
  const { path, baseSha } = provisioned
  await pinDeclaredIdentity(path, gitIn(path, process, selection), io)
  if (options.hold !== undefined) {
    try {
      await createLocalGitWorktreeStore({ repo: root }).lock(path, options.hold)
    } catch (error) {
      throw new Error(
        `yrd env open created ${path} but could not hold it: ${error instanceof Error ? error.message : String(error)}; the environment remains open, so inspect git worktree list before retrying`,
        { cause: error },
      )
    }
  }
  let headSha = provisioned.headSha
  if (options.issue !== undefined && branch !== undefined) {
    try {
      const environmentGit = gitIn(path, process, selection)
      headSha = (await environmentGit(["rev-parse", "HEAD"])).trim()
      const binding = await issueOf(environmentGit, branch, headSha, base, options.issue, resolveIssue)
      if (binding === undefined) throw new Error(`no issue resolved for requested binding ${options.issue}`)
      if (binding.source !== "binding") {
        const tree = (await environmentGit(["rev-parse", `${headSha}^{tree}`])).trim()
        const bound = (
          await environmentGit([
            "commit-tree",
            tree,
            "-p",
            headSha,
            "-m",
            `Bind work to ${binding.issue}\n\nRefs: ${binding.issue}`,
          ])
        ).trim()
        // A self-describing reflog message: git writes it verbatim into HEAD's
        // reflog, so a reader can tell the binding commit from any other move.
        // The provenance classifier treats this prefix as creating (27723).
        await environmentGit([
          "update-ref",
          "-m",
          `yrd env open: bind ${binding.issue}`,
          `refs/heads/${branch}`,
          bound,
          headSha,
        ])
        headSha = bound
      }
      const currentHead = (await environmentGit(["rev-parse", "HEAD"])).trim()
      if (currentHead !== headSha) {
        throw new Error(`HEAD changed from verified binding ${headSha} to ${currentHead}`)
      }
      headSha = currentHead
    } catch (error) {
      const conflictHint =
        options.bay === undefined &&
        name !== options.issue &&
        error instanceof Error &&
        /^declared issue .* conflicts with .* bound at /u.test(error.message)
          ? `; choose another branch with --bay <name> --issue ${options.issue}`
          : ""
      throw new Error(
        `issue binding failed in preserved environment ${path}; setup has not run: ${error instanceof Error ? error.message : String(error)}${conflictHint}`,
        { cause: error },
      )
    }
  }
  // A base the environment shares no history with cannot be judged: no check could tell a diff from it
  // and no ancestry can be established for it. The guard runs on EVERY path, not only where the target
  // declares `setup:` — a repository without setup used to accept a foreign head silently (27165).
  const tree = await checkedTree(path, baseSha, process)
  const setup = config?.setup
  if (setup !== undefined) {
    const artifacts = join(resolve(root, await workdirOf(git)), "logs", "environments", name, runId())
    try {
      await runSetup({
        cwd: path,
        process,
        setup: { logDir: join(artifacts, "logs"), run: setup, tmpdir: join(artifacts, "tmp") },
        tree,
      })
    } catch (error) {
      if (!(error instanceof SetupFailed)) throw error
      const result = error.ran.result
      const output = readFileSync(result.log, "utf8").trim() || "(setup produced no output)"
      const why = result.why === undefined ? "" : ` (${result.why})`
      throw new Error(
        `environment setup ${result.result} in preserved bay ${path}: exit ${String(result.exit)}${why}\n` +
          `command: ${setup}\n${output}\nlog ${result.log}`,
        { cause: error },
      )
    }
  }
  const reused = provisioned.adoption !== "fresh" && provisioned.adoption !== "detached"
  if (reused) {
    io.stderr(
      `${name}: reused ${provisioned.adoption} branch ${branch} at ${provisioned.headSha}; requested target ${target} ${baseSha}\n`,
    )
  }
  // `base` is the base the caller REQUESTED, resolved in the owning root repository — never the head the
  // environment happens to stand at: a reused branch's head is reported as `head`, not as `base` (27165).
  if (options.json === true) {
    io.stdout(`${JSON.stringify({ base: baseSha, branch, head: headSha, name, path })}\n`)
  } else {
    if (!reused) {
      io.stderr(
        `${name} ${branch === undefined ? "detached" : `on ${branch}`} at ${headSha.slice(0, 12)}, cut from ${target} ${baseSha.slice(0, 12)}\n`,
      )
    }
    io.stdout(`${path}\n`)
  }
  return 0
}

/** The registered inventory shared by listing and automatic environment closure. */
export async function environmentInventory(
  root: string,
  git: Git,
  workdir: string,
): Promise<Readonly<{ roots: readonly string[]; rows: readonly EnvRow[] }>> {
  const roots = [baysRootOf(root), legacyBaysRoot(root), join(resolve(root, workdir), "environments")]
  const prefixes = roots.map((path) => `${existsSync(path) ? realpathSync(path) : resolve(path)}/`)
  const rows: EnvRow[] = (await registeredWorktrees(git))
    .filter(({ path }) => prefixes.some((prefix) => path.startsWith(prefix)))
    .map(({ path, head, branch, locked }) => ({
      name: basename(path),
      path,
      hold: locked ?? null,
      ...(head === undefined ? {} : { head }),
      ...(branch === undefined ? {} : { branch }),
    }))
  return { roots, rows }
}

/** `yrd env list` — the environments this repository holds, as git holds them. */
export async function listEnvironments(options: EnvListOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const root = requireRepository(io)
  const selection = await resolveGitSelection(root)
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process, selection)
  const { roots, rows } = await environmentInventory(root, git, await workdirOf(git))
  if (options.json === true) {
    io.stdout(`${JSON.stringify({ environments: rows })}\n`)
    return 0
  }
  if (rows.length === 0) {
    io.stdout(`no registered environments under ${roots.join(" or ")}; worktrees elsewhere excluded\n`)
    return 0
  }
  io.stdout(
    `${rows.map((row) => `${row.name}  ${row.branch ?? "(detached)"}  ${row.path}${row.hold === null ? "" : row.hold === "" ? "  held" : `  hold: ${row.hold}`}`).join("\n")}\n`,
  )
  return 0
}

/** Refuse before running user teardown; a dirty tree is work, not garbage. */
async function requireClean(git: Git, path: string): Promise<void> {
  const dirty = (await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])).trim()
  if (dirty !== "") {
    throw new Error(`environment ${path} is dirty; preserve or commit these changes before continuing:\n${dirty}`)
  }
}

/** Retained environments preserve user work; GitSuper owns populated-submodule removal. */
export async function closeEnvironment(
  operand: string,
  options: EnvCloseOptions,
  io: YrdCliIO,
  /** test-only seam (28120): production callers never pass it; the default is the real same-UID census. */
  censusSource?: () => Promise<ProcessCensus<"same-uid">>,
  /**
   * Internal, never a CLI option (22894). The `env close` verb delegates an
   * uncertifiable census to the queue's own round; a queue-round caller (the
   * request pass, the sweep) must refuse instead — it IS the capable context,
   * and filing a request from it would close a path nobody asked for.
   */
  onIncompleteCensus: CloseAdmissionMode = "delegate",
): Promise<YrdCliExitCode> {
  const root = requireRepository(io)
  const selection = await resolveGitSelection(root)
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process, selection)
  const workdir = resolve(root, await workdirOf(git))
  const roots = [baysRootOf(root), legacyBaysRoot(root), join(workdir, "environments")]
  const requested = resolve(io.cwd ?? globalThis.process.cwd(), operand)
  let path: string
  try {
    path = realpathSync(requested)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
      throw error
    }
    throw new Error(
      `environment ${requested} is not registered at an existing path; inspect git worktree list before retrying`,
      { cause: error },
    )
  }
  const registered = (await registeredWorktrees(git)).find((entry) => resolve(entry.path) === path)
  if (registered === undefined) {
    throw new Error(`environment ${requested} is not registered in ${root}; inspect git worktree list`)
  }
  const contained = roots.some((directory) => {
    if (!existsSync(directory)) return false
    const within = relative(realpathSync(directory), path)
    return within !== "" && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within)
  })
  if (!contained) {
    throw new Error(
      `environment ${path} is outside environment roots ${roots.join(" or ")}; nothing was removed. Retire a worktree outside these roots with your repository's own worktree cleanup (git worktree remove), not yrd env close`,
    )
  }
  if (registered.locked !== undefined) {
    throw new Error(
      `environment ${path} is locked${registered.locked === "" ? "" : `: ${registered.locked}`}; resolve its owner before closing it`,
    )
  }
  const treeGit = gitIn(path, process, selection)
  const commit = (await treeGit(["rev-parse", "HEAD"])).trim()
  for (const privatePath of await declaredPrivateSubmodules(treeGit, path, commit)) {
    const gitfile = join(path, privatePath, ".git")
    try {
      lstatSync(gitfile)
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") continue
      throw new Error(`Cannot inspect private submodule gitfile ${gitfile}; environment ${path} was preserved`, {
        cause,
      })
    }
    throw new Error(
      `environment ${path} cannot close with initialized private submodule ${privatePath}: ` +
        "custody unproven until 27058's merge exclusion; operator decision pending. Keep this environment until that decision.",
    )
  }
  await requireClean(treeGit, path)
  const admission = await admitEnvironmentClose(path, io, censusSource)
  if (admission.kind === "needs-delegation") {
    if (onIncompleteCensus === "refuse") throw uncertified(path, admission)
    return queueDelegatedClose(path, options, io, workdir, commit, admission)
  }
  const config = await readConfig(
    treeGit,
    commit,
    { branch: "HEAD", remote: "origin" },
    { newerKeys: (keys) => warnNewerDeclarationKeys(path, "env close", keys, io) },
  )
  if (config?.teardown !== undefined) {
    const artifacts = join(workdir, "logs", "environments", basename(path), runId())
    const result = await runCheck({
      cwd: path,
      process,
      tree: { base: commit, candidate: commit },
      spec: { name: "teardown", run: config.teardown },
      logDir: join(artifacts, "logs"),
      tmpdir: join(artifacts, "tmp"),
    })
    if (result.result !== "pass") {
      const output = readFileSync(result.log, "utf8").trim() || "(teardown produced no output)"
      throw new Error(
        `environment teardown ${result.result} in preserved environment ${path}: exit ${String(result.exit)}${result.why === undefined ? "" : ` (${result.why})`}\ncommand: ${config.teardown}\n${output}\nlog ${result.log}`,
      )
    }
    await requireClean(treeGit, path)
  }
  // 27510: closing an environment retires its own branch's preview custody, root first, before removal; a removal that
  // fails afterwards leaves the retirement standing. A detached environment never submitted, so has none.
  const subject = registered.branch?.replace(/^refs\/heads\//u, "")
  if (subject !== undefined && subject !== "") {
    await retirePreviewSubject({
      git,
      gitIn: (cwd) => gitIn(cwd, process, selection),
      leftover: (why) => io.stderr(`yrd: env close left a preview anchor; the next submit sweeps it: ${why}\n`),
      subject,
    })
  }
  const modules = await treeGit(["ls-tree", commit, "--", ".gitmodules"])
  const recheck = await admitEnvironmentClose(path, io, censusSource)
  if (recheck.kind === "needs-delegation") {
    // Teardown already ran, so delegating now would run it twice in a context
    // that cannot tell what this one did. Refuse loudly and preserve instead.
    throw uncertified(path, recheck, "after teardown")
  }
  if (modules.trim() !== "" || options.retain !== undefined || options.noRehome === true) {
    const retain =
      options.retain === undefined
        ? join(workdir, "retained-modules")
        : resolve(io.cwd ?? globalThis.process.cwd(), options.retain)
    let removed: unknown
    try {
      removed = JSON.parse(
        await git([
          "super",
          "--json",
          "worktree",
          "remove",
          path,
          "--retain",
          retain,
          ...(options.noRehome === true ? ["--no-rehome"] : []),
        ]),
      )
    } catch (error) {
      throw new Error(
        `environment ${path} could not close through git super worktree remove: ${error instanceof Error ? error.message : String(error)}; inspect its registration and retention directory ${retain} before retrying; no plain-git fallback was attempted`,
        { cause: error },
      )
    }
    if (
      options.noRehome === true &&
      typeof removed === "object" &&
      removed !== null &&
      "state" in removed &&
      removed.state === "unchanged" &&
      "path" in removed &&
      removed.path === path &&
      "reason" in removed &&
      removed.reason === "borrowed" &&
      "borrowers" in removed &&
      Array.isArray(removed.borrowers) &&
      removed.borrowers.length > 0 &&
      removed.borrowers.every((borrower): borrower is string => typeof borrower === "string" && borrower !== "")
    ) {
      const kept = { kept: path, reason: "borrowed", borrowers: removed.borrowers }
      io.stdout(
        options.json === true
          ? `${JSON.stringify(kept)}\n`
          : `kept environment ${path}: borrowed by ${removed.borrowers.join(", ")}\n`,
      )
      return 0
    }
    if (
      typeof removed !== "object" ||
      removed === null ||
      !("state" in removed) ||
      removed.state !== "updated" ||
      !("path" in removed) ||
      removed.path !== path ||
      !("proof" in removed) ||
      typeof removed.proof !== "object" ||
      removed.proof === null ||
      !("manifest" in removed.proof) ||
      typeof removed.proof.manifest !== "string"
    ) {
      throw new Error(
        `environment ${path} received malformed git-super removal proof; inspect git worktree list and retention directory ${retain} before retrying`,
      )
    }
    io.stderr(`retained environment removal proof ${removed.proof.manifest}\n`)
  } else {
    // No submodules recorded at this commit, so there is no gitlink for
    // git-super to materialize on the way out. The helper re-asks before it
    // issues the plain removal — the probe reads the TREE, the mutation belongs
    // to the repository that owns the worktree registry.
    await worktreeWithoutSubmodules(treeGit, git, commit, ["remove", path])
  }
  io.stdout(options.json === true ? `${JSON.stringify({ closed: path })}\n` : `closed environment ${path}\n`)
  return 0
}

/** The loud refusal a queue-round caller makes when its own census cannot certify. */
function uncertified(
  path: string,
  admission: Extract<CloseAdmission, { kind: "needs-delegation" }>,
  when = "",
): IncompleteCensusError {
  return new IncompleteCensusError(
    admission.refusal,
    admission.census,
    `${admission.refusal}${when === "" ? "" : ` ${when}`}; environment ${path} was preserved`,
  )
}

/**
 * File the durable close request for a context that can take a complete census
 * (22894). A write this process cannot make is a loud refusal naming the file
 * and the cure — never a silent `queued`, never a removal.
 */
function queueDelegatedClose(
  path: string,
  options: EnvCloseOptions,
  io: YrdCliIO,
  workdir: string,
  head: string,
  admission: Extract<CloseAdmission, { kind: "needs-delegation" }>,
): YrdCliExitCode {
  const chosen: EnvCloseRequestOptions = {
    ...(options.retain === undefined ? {} : { retain: options.retain }),
    ...(options.noRehome === true ? { noRehome: true } : {}),
  }
  const request: EnvCloseRequest = {
    name: basename(path),
    path,
    requester: requesterOf(globalThis.process.env),
    uid: typeof globalThis.process.getuid === "function" ? globalThis.process.getuid() : -1,
    at: new Date().toISOString(),
    predicate: ENV_CLOSE_PREDICATE,
    options: chosen,
    head,
  }
  const { file, alreadyStood } = writeCloseRequest(workdir, request)
  io.stderr(
    `yrd: env close ${path}: ${admission.refusal}; this caller cannot certify the close; ` +
      `queued request ${file} for the queue's own round, which reads every same-UID pid and journals the outcome\n`,
  )
  io.stdout(
    options.json === true
      ? `${JSON.stringify({
          queued: path,
          reason: "incomplete-census",
          request: file,
          census: admission.census,
          ...(alreadyStood ? { alreadyQueued: true } : {}),
        })}\n`
      : `queued environment close for ${path}: ${admission.refusal}; a context that can read every same-UID pid will close it; request ${file}\n`,
  )
  return ENV_CLOSE_QUEUED_EXIT
}

/** A local branch whose path contains `branch`, or sits inside it: git can store only one of the two (25850). */
async function branchPathConflict(git: Git, branch: string): Promise<string | undefined> {
  const branches = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).split("\n")
  return branches.find((name) => name !== "" && (branch.startsWith(`${name}/`) || name.startsWith(`${branch}/`)))
}
