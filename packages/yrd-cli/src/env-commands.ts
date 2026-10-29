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

import { shellQuote } from "git-super/shell-command"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
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
  readRemoteCommits,
  isAncestor,
  refAt,
  resolveGitSelection,
  retirePreviewSubject,
  runId,
  runStartedAt,
  runSetup,
  SetupFailed,
  worktreeWithoutSubmodules,
  type Git,
  type GitRunner,
} from "@yrd/queue-core"
import { createProcess, type Process } from "@yrd/process"
// 29073: `env close --preserve` reaches the ONE worktree preserve (bearly's preserveSlotState, the
// choke point remove/reset flow through) across the CLI boundary — a subprocess, exactly as yrd
// reaches git super — never a workspace dependency on bearly. A workspace dependency here stopped
// the whole queue (the derive's `bun install --lockfile-only` cannot resolve bearly@workspace:* in
// yrd's own workspace); @chief withdrew that change (c6939f8255f0). Shape @cto, 2026-10-13.
import { createLocalGitProcess } from "git-super/process"
import type { WorktreeRemovalProof } from "./branch-retirement.ts"
import {
  assertNoPrivateStore,
  createLocalGitWorktreeStore,
  PrivateStoreRefusalError,
  type PrivateStoreRefusal,
} from "git-super/worktree"
import { unaddressedRepository as findRepository } from "./declaration.ts"
import { ISSUE_DISPLAY_TIMEOUT_MS } from "./issue-resolver.ts"
import { issueComparer } from "./issue-sameness.ts"
import { ISSUES_CODES } from "./issues/declaration.ts"
import { runIssuesVerb } from "./issues/run.ts"
import { originHead } from "./queue-location.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"
import { workdirOf } from "./workdir.ts"
import { formatYrdCommand } from "./command-format.ts"
import { envOpenRecordFromFlags, writeEnvOpenRecord } from "./env-open-record.ts"
import {
  admitEnvironmentClose,
  assertNoLiveEnvironmentUse,
  type CloseAdmission,
  type CloseCensusReceipt,
} from "./env-close-holders.ts"
import {
  ENV_CLOSE_PREDICATE,
  requesterOf,
  writeCloseRequest,
  type EnvCloseRequest,
  type EnvCloseRequestOptions,
} from "./env-close-requests.ts"
import type { ProcessCensus } from "removely"
import { formatUnknownNotifyEventWarning, formatUnknownTopLevelKeyWarning } from "./version.ts"
import { prepareAuthorRelease } from "./branch-retirement.ts"

export type EnvOpenOptions = Readonly<{
  bay?: string
  issue?: string
  json?: boolean
  commit?: string
  hold?: string
  keep?: boolean
}>
export type EnvCloseOptions = Readonly<{
  json?: boolean
  /** Read admission only; no lifecycle writes or removal-side proofs. */
  dryRun?: boolean
  retain?: string
  noRehome?: boolean
  /** Internal automatic-cleanup policy; never inferred from manual close flags. */
  componentCustody?: Readonly<{ primaryRoot: string; targetBranch: string }>
  /**
   * 29073: an abandoned environment whose dirt cannot be committed is snapshotted to the worktree
   * tool's durable custody before the clean gate, and the close then proceeds. A preserve failure
   * throws, so a removal is blocked rather than partially discarding bytes. Off by default, so the
   * existing "a dirty tree is work, not garbage" refusal is unchanged for every current caller.
   */
  preserve?: boolean
}>

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
  const cwd = io.cwd
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
type BaseSource = "origin" | "tracking" | "local" | "commit"

async function resolveBaseSha(
  git: Git,
  target: string,
  io: YrdCliIO,
): Promise<Readonly<{ sha: string; baseSource: BaseSource; originUnreachable: boolean }>> {
  const branchRef = `refs/heads/${target}`
  const tracking = `refs/remotes/origin/${target}`
  let head: string | undefined
  let originFailure: string | undefined
  try {
    head = await readRemoteCommit(git, "origin", branchRef)
  } catch (error) {
    originFailure = error instanceof Error ? error.message : String(error)
  }
  if (head !== undefined) return { sha: head, baseSource: "origin", originUnreachable: false }
  if (originFailure !== undefined) {
    // Ruled 2026-10-19 (28385 area 11): an unreachable origin must not block a new environment.
    // Cut from the local ref and say so ONCE, naming the ref and the stale risk that motivated
    // the strict form: it is only as new as this checkout's last fetch.
    const fallback = await refAt(git, tracking)
    if (fallback !== undefined) {
      io.stderr(
        `yrd env open: origin did not answer for ${branchRef} (${originFailure}); cutting from ${tracking} instead — ` +
          `it is only as new as this checkout's last fetch, so a merge that already landed on origin may be missing\n`,
      )
      return { sha: fallback, baseSource: "tracking", originUnreachable: true }
    }
    const local = await refAt(git, target)
    if (local !== undefined) {
      io.stderr(
        `yrd env open: origin did not answer for ${branchRef} (${originFailure}); cutting from the local branch ${target} instead — ` +
          `it is only as new as this checkout's last fetch, so a merge that already landed on origin may be missing\n`,
      )
      return { sha: local, baseSource: "local", originUnreachable: true }
    }
    throw new Error(
      `yrd env open: origin did not answer for ${branchRef} (${originFailure}), and neither ${tracking} nor the local branch ${target} exists`,
    )
  }
  const tracked = await refAt(git, tracking)
  if (tracked !== undefined) return { sha: tracked, baseSource: "tracking", originUnreachable: false }
  const local = await refAt(git, target)
  if (local !== undefined) return { sha: local, baseSource: "local", originUnreachable: false }
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
 * Whether pinning the per-worktree identity leaked into the SHARED config the
 * co-resident worktrees inherit. Both halves are compared: the check read only
 * `user.name`, so a write that moved only `user.email` slipped past it (#28285).
 */
export function sharedIdentityMoved(
  before: Readonly<{ email: string; name: string }>,
  after: Readonly<{ email: string; name: string }>,
): boolean {
  return before.name !== after.name || before.email !== after.email
}

/** The shared config's whole identity, read as one value so a write cannot hide in the half nobody read. */
async function sharedIdentity(git: GitRunner): Promise<Readonly<{ email: string; name: string }>> {
  const read = async (key: string): Promise<string> =>
    (await git(["config", "--local", "--get", "--default=", key])).trim()
  return { email: await read("user.email"), name: await read("user.name") }
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
async function pinDeclaredIdentity(
  path: string,
  git: GitRunner,
  identity: Readonly<{ email: string; name: string }> | undefined,
  io: YrdCliIO,
): Promise<void> {
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
  const sharedBefore = await sharedIdentity(git)
  await git(["config", "--worktree", "user.name", identity.name])
  await git(["config", "--worktree", "user.email", identity.email])
  const sharedAfter = await sharedIdentity(git)
  if (sharedIdentityMoved(sharedBefore, sharedAfter)) {
    throw new Error(
      `yrd env open: pinning the seat identity in ${path} wrote the shared config ` +
        `(user.name '${sharedBefore.name}' became '${sharedAfter.name}', user.email '${sharedBefore.email}' became ` +
        `'${sharedAfter.email}'); extensions.worktreeConfig is enabled but git stored it outside this worktree`,
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

function warnUnknownNotifyEvents(
  at: string,
  command: string,
  unknown: readonly Readonly<{ entry: string; event: string }>[],
  io: YrdCliIO,
): void {
  io.stderr(formatUnknownNotifyEventWarning(at, command, unknown))
}

async function recordOpenedLifetime(
  path: string,
  process: Parameters<typeof gitIn>[1],
  selection: Awaited<ReturnType<typeof resolveGitSelection>>,
  options: EnvOpenOptions,
): Promise<void> {
  const gitDir = (await gitIn(path, process, selection)(["rev-parse", "--absolute-git-dir"])).trim()
  try {
    writeEnvOpenRecord(gitDir, envOpenRecordFromFlags(options))
  } catch (error) {
    throw new Error(
      `yrd env open created ${path} but could not record opening lifetime in ${gitDir}: ${error instanceof Error ? error.message : String(error)}; the environment remains open, so inspect git worktree list before retrying`,
      { cause: error },
    )
  }
}

/**
 * A detached environment's log directory, minted below as `<commit12>-<runId>`.
 * The parser is the same shape: 12 hex, a hyphen, then a run id. `runStartedAt`
 * stays the run-id parser; this only peels the commit prefix off.
 */
export function detachedEnvironmentDirectoryName(commit: string, run: string): string {
  return `${commit.slice(0, 12)}-${run}`
}

const DETACHED_ENVIRONMENT_DIRECTORY = /^[0-9a-f]{12}-(q-.*)$/u

/** When a detached environment directory was minted, or undefined when `name` is not that shape. */
export function environmentDirectoryStartedAt(name: string): Date | undefined {
  const run = DETACHED_ENVIRONMENT_DIRECTORY.exec(name)?.[1]
  if (run === undefined) return undefined
  return runStartedAt(run)
}

/** `<12 hex>-q-…` whose run id does not parse. A bay that merely contains `q-` does not claim this shape. */
export function environmentStampUnreadable(name: string): boolean {
  return /^[0-9a-f]{12}-q-/u.test(name) && environmentDirectoryStartedAt(name) === undefined
}

/**
 * 30516: the key `--issue` names is resolved through the project's issues interface BEFORE any bay, branch,
 * worktree or Refs commit exists, as #28285 reads the identity first. `resolve` is the read post-merge runs on
 * every Refs trailer, so a key that fails it here would also close nothing at merge (a mis-slugged key bound an
 * environment and its Refs commit, 2026-10-21). Refusing names the key, the verb, the argv it ran and the
 * project root, and the provider's own reason passes through on stderr. A project with no `issues.yml`, or
 * none declaring `resolve`, has no store to ask: that is said on stderr and the open proceeds as before. Yrd
 * still learns nothing of hh's bead model; it runs the verb the project declared, within the display read's bound.
 */
async function requireResolvableIssue(root: string, issue: string, io: YrdCliIO, git: Git): Promise<void> {
  const outcome = await runIssuesVerb({
    verb: "resolve",
    args: [issue],
    projectRoot: root,
    cwd: root,
    timeoutMs: ISSUE_DISPLAY_TIMEOUT_MS,
    stderr: (text) => io.stderr(text),
  })
  if (outcome.ok) return
  if (outcome.code === ISSUES_CODES.declarationMissing || outcome.code === ISSUES_CODES.unsupported) {
    io.stderr(
      `yrd env open: --issue ${issue} was not checked against an issues store, because ${root} declares none for it: ${outcome.message}\n`,
    )
    return
  }
  let recovery = ""
  try {
    const primary = (await registeredWorktrees(git))[0]
    if (primary?.head !== undefined && resolve(primary.path) !== resolve(root)) {
      recovery =
        ` If this checkout's issues provider is stale, retry from the primary checkout: ` +
        `(${formatYrdCommand(io, ["env", "open", "--issue", issue], primary.path)})`
    }
  } catch (error) {
    recovery = ` Primary-checkout recovery could not be read from Git at ${root}: ${error instanceof Error ? error.message : String(error)}`
  }
  throw new Error(
    `yrd env open: --issue ${issue} does not resolve to an issue through the issues interface declared by ${root}, ` +
      `so no environment, branch or Refs commit was created: ${outcome.message}${recovery}`,
  )
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
  // The caller's declared identity is read BEFORE any environment exists
  // (#28285): a half-declared identity is refused here, leaving no bay, branch
  // or worktree registration behind. Reading it only at the pin — after
  // provisioning — stranded an unlocked environment on every refusal.
  const declaredIdentity = declaredSeatIdentity()
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
    // A decimal issue id is all hex, and git reads a short all-hex string as an object prefix too: the ref probe
    // rethrew its blob/tree error in place of this message (31210, @cto f847cdae), so an all-hex argument is not probed.
    const issueId = /^\d+$/u.test(commit)
    const resolved = /^[0-9a-f]+$/u.test(commit) ? undefined : await refAt(gitIn(root, undefined, selection), commit)
    throw new Error(
      `yrd env open takes an exact commit object ID as its argument, not '${commit}'.` +
        (issueId ? ` To open an environment for issue ${commit}: yrd env open --issue ${commit}.` : "") +
        (resolved === undefined ? "" : ` '${commit}' is a ref here, and this argument never accepts one.`) +
        ` To open or adopt a branch, pass --bay <name> or --issue <ref> with no argument;` +
        ` the branch it opens or adopts is always task/<name>.` +
        (issueId
          ? ""
          : ` To retain an exact commit detached, resolve one first with git rev-parse ${resolved === undefined ? "HEAD" : commit}.`),
    )
  }
  const target = commit === undefined ? await originHead(gitIn(root, undefined, selection)) : "HEAD"
  const name = (
    options.bay ??
    (options.issue === undefined
      ? undefined
      : await implicitIssueName(gitIn(root, undefined, selection), options.issue)) ??
    (commit === undefined ? `env-${Date.now().toString(36)}` : detachedEnvironmentDirectoryName(commit, runId()))
  ).trim()
  if (name === "") throw new Error("yrd: --bay needs a name")
  const branch = commit === undefined ? `task/${name}` : undefined
  if (options.issue !== undefined) {
    await requireResolvableIssue(root, options.issue, io, gitIn(root, undefined, selection))
  }
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process, selection)
  const resolvedBase =
    commit === undefined
      ? await resolveBaseSha(git, target, io)
      : { sha: commit, baseSource: "commit" as const, originUnreachable: false }
  const base = resolvedBase.sha
  if (commit !== undefined) {
    // A ^{commit} peel of a blob or tree rethrew git's own error in place of this refusal (31210, @cto 21ebb13f):
    // read presence with no peel ("blob" kind), then the object's type.
    if ((await refAt(git, `${commit}^{object}`, "blob")) === undefined) {
      throw new Error(
        `yrd env open: commit ${commit} is not a commit object in ${root}; fetch that commit before opening it`,
      )
    }
    const type = (await git(["cat-file", "-t", commit])).trim()
    if (type !== "commit") {
      throw new Error(`yrd env open: commit ${commit} is a ${type} object, not a commit, in ${root}`)
    }
  }
  const config = await readConfig(
    git,
    base,
    { remote: "origin", branch: target },
    {
      newerKeys: (keys) => warnNewerDeclarationKeys(`${target} (${base.slice(0, 12)})`, "env open", keys, io),
      unknownNotifyEvents: (unknown) =>
        warnUnknownNotifyEvents(`${target} (${base.slice(0, 12)})`, "env open", unknown, io),
    },
  )
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
      const close = formatYrdCommand(io, ["env", "close", existing.path], root)
      const reopen = formatYrdCommand(
        io,
        [
          "env",
          "open",
          ...(options.bay === undefined ? [] : ["--bay", options.bay]),
          ...(options.issue === undefined ? [] : ["--issue", options.issue]),
          ...(options.hold === undefined ? [] : ["--hold", options.hold]),
          ...(options.keep === true ? ["--keep"] : []),
          ...(options.json === true ? ["--json"] : []),
        ],
        root,
      )
      throw new Error(
        `environment ${existing.path} is clean and merged into requested base ${base}; close must finish before reopening; exit 4 means accepted, not closed. If close is queued, wait for completion before reopening. To continue: ${close} && ${reopen}`,
      )
    }
    const workspace = await createGitWorkspace({ repo: root, baysRoot: baysRootOf(root), process })
    const result = await workspace.provision({
      bay: name,
      name,
      branch,
      base,
      originUnreachable: resolvedBase.originUnreachable,
    })
    if (result.conclusion !== "success") {
      throw new Error(`yrd: could not open environment '${name}': ${result.error.message}`)
    }
    provisioned = result.output
    // @cto verdict 93993997 (30256): skipping the origin probe also skips the answer to
    // "does task/<name> already exist there?". Say so when the branch was created fresh, or a
    // same-named branch on origin would be passed over without a word.
    if (resolvedBase.originUnreachable && provisioned.adoption === "fresh") {
      io.stderr(
        `yrd env open: origin was not asked whether ${branch} already exists there, so an existing remote copy of ${branch} was not adopted; ` +
          `this environment starts fresh at ${provisioned.baseSha.slice(0, 12)}\n`,
      )
    }
  }
  const { path, baseSha } = provisioned
  await pinDeclaredIdentity(path, gitIn(path, process, selection), declaredIdentity, io)
  await recordOpenedLifetime(path, process, selection, options)
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
      const binding = await issueOf(
        environmentGit,
        branch,
        headSha,
        base,
        options.issue,
        issueComparer({ projectRoot: root, cwd: root, stderr: (text) => io.stderr(text) }),
      )
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
        // 29738: the bind commit carries the --issue value exactly as given, so a later Refs trailer that
        // spells the issue the other way refuses at submit - after a review GO. ANNOUNCE the key here,
        // where the split is created, in the 28113 shape: stderr only, never a refusal, naming yrd's OWN
        // flag and key so yrd still learns nothing of hh's bead model. `--json` stdout and the exit code
        // are unchanged. @cto 08:31:50Z fixed this wording: the line names the exact key it wrote and the
        // rule that every later Refs trailer must spell it exactly that way.
        io.stderr(
          `${branch} is bound to ${binding.issue} by a yrd env open Refs commit, which carries the --issue value exactly as given; every later Refs trailer on this branch must spell it exactly that way, or submit refuses with conflicting issue bindings\n`,
        )
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
      handleOpenSetupFailure(error, { artifacts, io, name, path, setup })
    }
  }
  const reused = provisioned.adoption !== "fresh" && provisioned.adoption !== "detached"
  if (reused) {
    io.stderr(
      `${name}: reused ${provisioned.adoption} branch ${branch} at ${provisioned.headSha}; requested target ${target} ${baseSha}\n`,
    )
  }
  // 28113: a branch opened without --issue carries no bead id, so every retirement path that keys on the
  // owning issue refuses it by name — it is unnameable to `drop-decided` and to the dark-work census, and
  // the creator is never told. ANNOUNCE, never refuse: a spike or a probe legitimately has no bead. The
  // line names yrd's OWN flag, so yrd still learns nothing of hh's bead model — no second resolver here.
  // stderr, so `--json` stdout and every scripted caller stay byte-identical; the exit code is unchanged.
  if (branch !== undefined && options.issue === undefined) {
    io.stderr(
      `${branch} carries no bead id; open bead work with --issue <ref> — it names the branch task/<issue> and binds it with a Refs commit\n`,
    )
  }
  // `base` is the base the caller REQUESTED, resolved in the owning root repository — never the head the
  // environment happens to stand at: a reused branch's head is reported as `head`, not as `base` (27165).
  if (options.json === true) {
    io.stdout(
      `${JSON.stringify({ base: baseSha, baseSource: resolvedBase.baseSource, branch, head: headSha, name, path })}\n`,
    )
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
function handleOpenSetupFailure(
  error: unknown,
  context: Readonly<{ artifacts: string; io: YrdCliIO; name: string; path: string; setup: string }>,
): void {
  if (!(error instanceof SetupFailed)) throw error
  const transitiveMatch =
    error.diagnosis === undefined
      ? null
      : /^transitive-only lockfile drift: (\d+) package locator\(s\) moved with unchanged workspace manifests$/mu.exec(
          error.diagnosis,
        )
  if (transitiveMatch !== null && error.diagnosis !== undefined) {
    // 31669: historical commits whose lockfile was written under an older Bun resolver fail
    // `--frozen-lockfile` when transitive package deduplication shifts while workspace manifests
    // and local dependencies stay identical. `frozenLockfileDiagnosis` already completed the
    // unfrozen setup (`exit 0`) and restored `bun.lock` to HEAD's bytes; record the drift log
    // and announce it on stderr without failing `env open`.
    const driftLog = join(context.artifacts, "logs", "frozen-lockfile-drift.log")
    writeFileSync(driftLog, `${error.diagnosis}\n`)
    context.io.stderr(
      `${context.name}: setup accepted transitive lockfile resolver drift (${transitiveMatch[1]} package locator(s) moved with unchanged workspace manifests; unfrozen setup exited 0 and bun.lock was restored to HEAD; diagnosis ${driftLog})\n`,
    )
    return
  }
  const result = error.ran.result
  const output = readFileSync(result.log, "utf8").trim() || "(setup produced no output)"
  const why = result.why === undefined ? "" : ` (${result.why})`
  // 26906: SetupFailed carries lockfile-diagnosis.ts's forensics (which dependency moved, and the
  // rollback that keeps the retained bay byte-identical), but THIS report rebuilds the failure text
  // from the ran result and the log alone -- so without this line the one thing that names the
  // frozen refusal's cause is dropped exactly where a seat needs it.
  const diagnosis = error.diagnosis === undefined ? "" : `\n${error.diagnosis}`
  throw new Error(
    `environment setup ${result.result} in preserved bay ${context.path}: exit ${String(result.exit)}${why}\n` +
      `command: ${context.setup}\n${output}\nlog ${result.log}${diagnosis}`,
    { cause: error },
  )
}

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

/** One status read shared by the cleanliness check and the read-only preserve preview. */
async function environmentDirt(git: Git): Promise<readonly string[]> {
  const dirty = (await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])).trim()
  return dirty === "" ? [] : dirty.split("\n")
}

/** Refuse before running user teardown; a dirty tree is work, not garbage. */
async function requireClean(git: Git, path: string, hint = ""): Promise<void> {
  const dirty = await environmentDirt(git)
  if (dirty.length > 0) {
    throw new Error(
      `environment ${path} is dirty; preserve or commit these changes before continuing${hint}:\n${dirty.join("\n")}`,
    )
  }
}

/** Retained environments preserve user work; GitSuper owns populated-submodule removal. */
/** The one route a private store is retired by, built here so the refusal and every reporter name the same command. */
export function privateStoreVerifyCommand(store: string, checkout: string): string {
  return `git super worktree private-store verify ${shellQuote(store)} --checkout ${shellQuote(checkout)}`
}

/**
 * #27120 AC2: a private checkout `env close` will not retire, as a CLASS a caller reads without parsing this
 * message or re-deriving `modules/<name>`. The store and the verify route come from the same reader that
 * refused, so the queue sweep can report the tree by class (`kept: private checkout; store …; retire with …`)
 * instead of quoting a per-seat note. `store` is absent when the checkout is initialized but its store is
 * already gone, where there is no store route to name.
 */
export class PrivateCheckoutRefusalError extends Error {
  constructor(
    message: string,
    readonly refusal: Readonly<{ submodule: string; checkout: string; store?: string; command?: string }>,
  ) {
    super(message)
    this.name = "PrivateCheckoutRefusalError"
  }
}

/**
 * Whether an entry is present, WITHOUT following it: absent when there is nothing at that name, a real fault
 * otherwise. `existsSync` would collapse an unreadable parent into "absent" and let the close proceed past a
 * private store it could not judge, so the error is named here instead (#27120 AC1, chief ruling c8a3b06d).
 */
function entryPresent(target: string, what: string): boolean {
  try {
    lstatSync(target)
    return true
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw new Error(`cannot inspect ${what} ${target}; the environment was preserved`, { cause })
  }
}

/**
 * The worktree CLI, resolved through the superproject root yrd already holds.
 * ONE stated path. env close --preserve refuses BY NAME with it when the file is
 * absent and never falls through to a plain removal: a preserve that silently
 * did not run is exactly the data loss the flag exists to prevent (29073, @cto
 * condition 3).
 */
export function worktreePreserveCliPath(root: string): string {
  return join(root, "tools", "worktree.ts")
}

export interface WorktreePreserveReceipt {
  slot: string
  path: string
  preserved: boolean
  reason: string | null
  ref: string | null
  sha: string | null
  submodules: ReadonlyArray<{ path: string; ref: string | null; sha: string }>
  /** Repositories bearly consulted and skipped: no primary store under shared main, clean on the recorded pin (29392). */
  skipped: ReadonlyArray<{ path: string; head: string; reason: string }>
}

/** The receipt schema the worktree preserve CLI promises (bearly tools/worktree.ts). */
export const WORKTREE_PRESERVE_SCHEMA = "bearly-worktree-preserve/1"

/**
 * bearly tools/worktree.ts `PRESERVE_NOTHING_EXIT`, mirrored here: the preserve
 * verb prints a receipt for exactly two endings — exit 0 with `preserved:true`,
 * and this exit with `preserved:false`. yrd accepts only those combinations and
 * refuses every other exit as a failure, so a half-finished preserve is never
 * read as a verdict (29073).
 */
const WORKTREE_PRESERVE_NOTHING_EXIT = 3

function receiptRefusal(cli: string, field: string, expected: string): Error {
  return new Error(
    `env close --preserve: the worktree preserve CLI ${cli} printed a receipt with an invalid ${field} (${expected}); the environment was NOT removed`,
  )
}

/**
 * Read the preserve receipt by its SCHEMA, not by a cast (29073, @cto must
 * 2026-10-13). A receipt from another tool or version must fail at this
 * boundary, by name, with the offending field and the CLI path — never as an
 * undefined ref handed to `--preserved` or a `submodules` TypeError downstream.
 */
export function parseWorktreePreserveReceipt(stdout: string, cli: string): WorktreePreserveReceipt {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new Error(
      `env close --preserve: the worktree preserve CLI ${cli} printed no JSON receipt: ${stdout || "(empty stdout)"}; the environment was NOT removed`,
      { cause: error },
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw receiptRefusal(cli, "receipt", "expected a JSON object")
  }
  const record = parsed as Record<string, unknown>
  if (record.schema !== WORKTREE_PRESERVE_SCHEMA) {
    throw receiptRefusal(
      cli,
      "schema",
      `expected ${JSON.stringify(WORKTREE_PRESERVE_SCHEMA)}, got ${JSON.stringify(record.schema)}`,
    )
  }
  if (typeof record.slot !== "string") throw receiptRefusal(cli, "slot", "expected a string")
  if (typeof record.path !== "string") throw receiptRefusal(cli, "path", "expected a string")
  if (typeof record.preserved !== "boolean") throw receiptRefusal(cli, "preserved", "expected a boolean")
  if (record.reason !== null && typeof record.reason !== "string") {
    throw receiptRefusal(cli, "reason", "expected a string or null")
  }
  if (record.ref !== null && typeof record.ref !== "string") {
    throw receiptRefusal(cli, "ref", "expected a string or null")
  }
  if (record.sha !== null && typeof record.sha !== "string") {
    throw receiptRefusal(cli, "sha", "expected a string or null")
  }
  if (!Array.isArray(record.submodules)) throw receiptRefusal(cli, "submodules", "expected an array")
  const submodules = record.submodules.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw receiptRefusal(cli, `submodules[${index}]`, "expected an object")
    }
    const component = entry as Record<string, unknown>
    if (typeof component.path !== "string") throw receiptRefusal(cli, `submodules[${index}].path`, "expected a string")
    if (component.ref !== null && typeof component.ref !== "string") {
      throw receiptRefusal(cli, `submodules[${index}].ref`, "expected a string or null")
    }
    if (typeof component.sha !== "string") throw receiptRefusal(cli, `submodules[${index}].sha`, "expected a string")
    return { path: component.path, ref: component.ref, sha: component.sha }
  })
  // 29406: bearly names the repositories it consulted and skipped — a child shared main has no
  // primary store for that was clean on its recorded pin (29392). A receipt without the key comes
  // from a bearly before 29392, which preserved or threw and never skipped, so absence means
  // nothing was skipped; a present key is read by shape and refused by name like the fields above.
  let skipped: WorktreePreserveReceipt["skipped"] = []
  if (record.skipped !== undefined) {
    if (!Array.isArray(record.skipped)) throw receiptRefusal(cli, "skipped", "expected an array")
    skipped = record.skipped.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw receiptRefusal(cli, `skipped[${index}]`, "expected an object")
      }
      const repository = entry as Record<string, unknown>
      if (typeof repository.path !== "string") throw receiptRefusal(cli, `skipped[${index}].path`, "expected a string")
      if (typeof repository.head !== "string") throw receiptRefusal(cli, `skipped[${index}].head`, "expected a string")
      if (typeof repository.reason !== "string") {
        throw receiptRefusal(cli, `skipped[${index}].reason`, "expected a string")
      }
      return { path: repository.path, head: repository.head, reason: repository.reason }
    })
  }
  return {
    slot: record.slot,
    path: record.path,
    preserved: record.preserved,
    reason: record.reason,
    ref: record.ref,
    sha: record.sha,
    submodules,
    skipped,
  }
}

/**
 * Run the ONE worktree preserve across the CLI boundary — a subprocess, never a
 * workspace dependency on bearly (29073, @cto shape A) — and return its JSON
 * receipt. The verb prints a receipt for exactly two endings (0/`preserved:true`
 * and `PRESERVE_NOTHING_EXIT`/`preserved:false`); the receipt is the content
 * verdict, so yrd reads it and never parses prose, but a receipt that disagrees
 * with a valid exit — or any other exit — is a failure and refuses the close.
 */
async function preserveEnvironmentWorktree(
  runner: Process,
  root: string,
  path: string,
): Promise<WorktreePreserveReceipt> {
  const cli = worktreePreserveCliPath(root)
  if (!existsSync(cli)) {
    throw new Error(
      `env close --preserve needs the worktree preserve CLI at ${cli}; it is absent, so the preserve was NOT run and the environment was NOT removed`,
    )
  }
  let result: Awaited<ReturnType<Process["run"]>>
  try {
    result = await runner.run({ argv: ["bun", cli, "preserve", path, "--json"], cwd: root })
  } catch (error) {
    throw new Error(
      `env close --preserve could not run the worktree preserve CLI ${cli}: ${error instanceof Error ? error.message : String(error)}; the environment was NOT removed`,
      { cause: error },
    )
  }
  if (
    result.signal !== null ||
    result.timedOut ||
    result.stalled ||
    result.sweepFailure !== undefined ||
    result.escapedDescendant ||
    (result.outputTruncation?.length ?? 0) > 0
  ) {
    throw new Error(
      `env close --preserve: the worktree preserve CLI ${cli} did not settle cleanly: ${JSON.stringify(result)}; the environment was NOT removed`,
    )
  }
  const stderrTail = result.stderr.trimEnd().split(/\r?\n/u).slice(-20).join("\n").slice(-4096) || "(empty stderr)"
  const stderrContext = `stderr tail (last 20 lines, max 4096 characters): ${stderrTail}`
  let receipt: WorktreePreserveReceipt
  try {
    receipt = parseWorktreePreserveReceipt(result.stdout, cli)
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; preserve CLI exited ${String(result.exitCode)}; ${stderrContext}`,
      { cause: error },
    )
  }
  // The receipt is the content verdict, but only two exit/receipt combinations are
  // honest: exit 0 with preserved:true, and PRESERVE_NOTHING_EXIT with
  // preserved:false. Any other exit — or a receipt that disagrees with its exit
  // code — means the preserve did not finish, so refuse by name and remove nothing
  // rather than hand a half-preserved ref to `--preserved` (29073, @cto must).
  if (result.exitCode !== 0 && result.exitCode !== WORKTREE_PRESERVE_NOTHING_EXIT) {
    throw new Error(
      `env close --preserve: the worktree preserve CLI ${cli} exited ${String(result.exitCode)} (expected 0 with preserved:true, or ${WORKTREE_PRESERVE_NOTHING_EXIT} with preserved:false); ${stderrContext}; the environment was NOT removed`,
    )
  }
  if (result.exitCode === 0 && !receipt.preserved) {
    throw new Error(
      `env close --preserve: the worktree preserve CLI ${cli} exited 0 but reported preserved:false; ${stderrContext}; the environment was NOT removed`,
    )
  }
  if (result.exitCode === WORKTREE_PRESERVE_NOTHING_EXIT && receipt.preserved) {
    throw new Error(
      `env close --preserve: the worktree preserve CLI ${cli} exited ${WORKTREE_PRESERVE_NOTHING_EXIT} but reported preserved:true; ${stderrContext}; the environment was NOT removed`,
    )
  }
  return receipt
}

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
  /** Internal conditional-intent check; the package entry never forwards it. */
  beforeRemove?: () => Promise<void>,
  /** Internal typed proof transport to the queue cleanup caller. */
  removedProof?: (proof: WorktreeRemovalProof) => void,
): Promise<YrdCliExitCode> {
  const root = requireRepository(io)
  const selection = await resolveGitSelection(root)
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process, selection)
  const workdir = resolve(root, await workdirOf(git))
  const roots = [baysRootOf(root), legacyBaysRoot(root), join(workdir, "environments")]
  // 28991: a relative `--retain` — a mistyped flag like `--retain --json` is the
  // observed shape — resolved against the caller's cwd and made git-super write a
  // whole retention tree, submodule stores included, into `<cwd>/--json`; on Oct 13
  // 00:39 that cwd was the shared CODE projection /hh/dev. Refuse before any
  // removal: only an absolute retention directory is ever what the caller meant.
  if (options.retain !== undefined && !isAbsolute(options.retain)) {
    throw new Error(
      `--retain ${options.retain} is not an absolute directory, so it would resolve against the caller's cwd and write a retention tree there; pass an absolute path (e.g. ${join(workdir, "retained-modules")})`,
    )
  }
  const requested = resolve(io.cwd, operand)
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
  const treeGit = gitIn(path, process, selection)
  if (registered.locked !== undefined) {
    const lockPath = join((await treeGit(["rev-parse", "--absolute-git-dir"])).trim(), "locked")
    throw new Error(
      `environment ${path} is locked${registered.locked === "" ? "" : `: ${registered.locked}`}; lock file ${lockPath}; release the hold with git worktree unlock ${shellQuote(path)} before closing it`,
    )
  }
  const commit = (await treeGit(["rev-parse", "HEAD"])).trim()
  // #27120 AC1/AC3 (ruling ii): R1 refuses while ANY private byte the close could destroy is still
  // there — the checkout is initialized, OR it was emptied and the private store still sits in this
  // environment's own admin dir. R1 is therefore the guard at EVERY stage, and the close never reaches
  // a removal it has not proved, whatever the worktree-removal side does with an exclusion list it is
  // never handed. The step that touches the store stays the operator's: this tool reads, copies, hashes
  // and renames nothing inside it (27058; chief ruling c8a3b06d).
  const privateSubmodules = await declaredPrivateSubmodules(treeGit, path, commit)
  // The STORE is git-super's question, keyed by the `.gitmodules` section NAME and read at HEAD plus main
  // (28661's ONE reader). This tool no longer derives `modules/<path>`: Git stores a submodule at
  // `modules/<name>`, and a supported `git submodule add --name secret … vendor/dependency` makes the two
  // differ, so a path-keyed probe missed the real store and let the close reach a removal that COPIED the
  // private store into retention. The guard hands back the refused stores structured, so the route below
  // names the exact bytes without parsing its message (27120, @cto).
  const adminDir = (await treeGit(["rev-parse", "--absolute-git-dir"])).trim()
  let storeRefusals: readonly PrivateStoreRefusal[] = []
  try {
    await assertNoPrivateStore(createLocalGitProcess(), { adminDir, repository: path, head: commit })
  } catch (reason) {
    if (!(reason instanceof PrivateStoreRefusalError)) throw reason
    // 27120 / @cto 0516210a: a typed refusal whose store list is EMPTY is still a REFUSAL, not the answer "this
    // checkout holds no private store". Reading its empty payload as no-private-store would let the close destroy
    // exactly the bytes git-super declined to judge, so the refusal is RETHROWN unchanged: the caller's class
    // walk (the sweep's request disposition) then keeps the tree and the operator's request standing.
    if (reason.refusals.length === 0) throw reason
    storeRefusals = reason.refusals
  }
  // Both answers come from the same reader, but a store can be private per main while this checkout's own
  // HEAD declares nothing, so R1 answers for the union.
  const privatePaths = [...new Set([...privateSubmodules, ...storeRefusals.map((entry) => entry.path)])]
  for (const privatePath of privatePaths) {
    const checkout = join(path, privatePath)
    const initialized = entryPresent(join(checkout, ".git"), "the private submodule gitfile of")
    const store = storeRefusals.find((entry) => entry.path === privatePath)?.store
    if (!initialized && store === undefined) continue
    // Route A is ruled, so this is no longer a pending decision: it stays a REFUSAL (loud stderr,
    // exit 2) and it NAMES THE ROUTE at whichever stage the operator is standing in. In --json it
    // also carries one structured class, so a sweep can report the tree by class instead of quoting
    // a per-seat note.
    const verify = store === undefined ? undefined : privateStoreVerifyCommand(store, checkout)
    const stage = initialized
      ? `its checkout ${checkout} is initialized and still holds private content`
      : `its checkout is empty but the private store ${store} is still present, so a removal would destroy it`
    const steps = [
      ...(initialized ? [`look at and empty ${checkout}`] : []),
      ...(verify === undefined || store === undefined
        ? []
        : [`run ${verify}`, `then remove the private store ${store}`]),
    ]
    if (options.json === true) {
      io.stdout(
        `${JSON.stringify({ kept: path, class: "private checkout", owner: "@chief", submodule: privatePath, checkout, store, command: verify })}\n`,
      )
    }
    throw new PrivateCheckoutRefusalError(
      `environment ${path} cannot close with private submodule ${privatePath}: private checkout, custody not proven — ${stage}. ` +
        `Retire it by operator steps: ${steps.join("; ")}. @chief owns this custody call. This tool reads, copies, hashes and renames nothing in the store.`,
      { submodule: privatePath, checkout, store, command: verify },
    )
  }
  // Admit the close before preserve can mutate any ref. The later admission still
  // checks again after teardown; this census does not exclude concurrent writers.
  if (io.liveEnvironmentUse === undefined) {
    io.stderr("yrd: owner leases were not checked because no host reader is wired.\n")
  }
  await assertNoLiveEnvironmentUse(path, io)
  const admission = await admitEnvironmentClose(path, io, censusSource)
  if (admission.kind === "needs-delegation") {
    if (options.dryRun === true) {
      throw uncertified(path, admission, "in preview; a real close would file a queue close request instead")
    }
    if (onIncompleteCensus === "refuse") throw uncertified(path, admission)
    return queueDelegatedClose(path, options, io, workdir, commit, admission)
  }
  // Both saves use the same worktree preserve operation. Keep custody from the
  // first pass even if the second pass reports no changes.
  const preservedRefs: string[] = []
  const custody: Array<{ path: string; ref: string; sha: string; remote: string }> = []
  const custodyRemotes = new Map<string, string>()
  // 29406: the repositories the preserve consulted and skipped, named in the --json close receipt
  // below; undefined when no preserve ran, so the plain close receipt is unchanged.
  let skipped: WorktreePreserveReceipt["skipped"] | undefined
  const preserve = async (phase: "before teardown" | "after teardown"): Promise<void> => {
    let receipt: WorktreePreserveReceipt
    try {
      receipt = await preserveEnvironmentWorktree(process, root, path)
    } catch (error) {
      throw new Error(
        `environment ${path} preservation ${phase} failed; completed custody refs: ${preservedRefs.length === 0 ? "none" : preservedRefs.join(", ")}; environment kept: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    for (const ref of [receipt.ref, ...receipt.submodules.map((entry) => entry.ref)]) {
      if (ref !== null && ref !== "" && !preservedRefs.includes(ref)) preservedRefs.push(ref)
    }
    const passCustody = [
      ...(receipt.ref === null || receipt.sha === null ? [] : [{ path: "", ref: receipt.ref, sha: receipt.sha }]),
      ...receipt.submodules.flatMap((entry) =>
        entry.ref === null ? [] : [{ path: entry.path, ref: entry.ref, sha: entry.sha }],
      ),
    ]
    for (const entry of passCustody) {
      const owner = entry.path === "" ? root : join(path, entry.path)
      let remote: string
      try {
        remote = (await gitIn(owner, process, selection)(["remote", "get-url", "--push", "origin"])).trim()
      } catch (error) {
        throw new Error(
          `environment ${path} preservation ${phase} wrote ${entry.ref} but cannot capture ${owner} origin push URL; completed custody refs: ${preservedRefs.join(", ")}; environment kept: ${String(error)}`,
          { cause: error },
        )
      }
      if (remote === "" || remote.includes("\n")) {
        throw new Error(
          `environment ${path} preservation ${phase} wrote ${entry.ref} but ${owner} origin push URL is empty or ambiguous; environment kept`,
        )
      }
      const previous = custodyRemotes.get(entry.path)
      if (previous !== undefined && previous !== remote) {
        throw new Error(
          `environment ${path} preservation ${phase} wrote ${entry.ref} but ${owner} origin push URL changed from ${previous} to ${remote} across custody passes; environment kept`,
        )
      }
      custodyRemotes.set(entry.path, remote)
      custody.push({ ...entry, remote })
    }
    skipped = [
      ...(skipped ?? []),
      ...receipt.skipped.filter(
        (entry) =>
          !skipped?.some(
            (earlier) => earlier.path === entry.path && earlier.head === entry.head && earlier.reason === entry.reason,
          ),
      ),
    ]
    const skippedNote =
      receipt.skipped.length === 0
        ? ""
        : `; skipped: ${receipt.skipped.map((entry) => `${entry.path}@${entry.head.slice(0, 12)} (${entry.reason})`).join(", ")}`
    io.stderr(
      receipt.preserved
        ? `yrd: env close preserved ${receipt.reason ?? "dirty"} state of ${path} ${phase}: ${receipt.ref ?? "(no ref)"} (${(receipt.sha ?? "").slice(0, 12)})${receipt.submodules.length === 0 ? "" : `; submodules: ${receipt.submodules.map((entry) => `${entry.path}@${entry.sha.slice(0, 12)}`).join(", ")}`}${skippedNote}\n`
        : `yrd: env close --preserve found nothing to preserve in ${path} ${phase}; the close proceeds${skippedNote}\n`,
    )
  }
  if (options.preserve === true) {
    if (options.dryRun !== true) await preserve("before teardown")
  } else {
    await requireClean(treeGit, path, " — or re-run with --preserve to keep this exact state in a durable ref first")
  }
  const config = await readConfig(
    treeGit,
    commit,
    { branch: "HEAD", remote: "origin" },
    {
      newerKeys: (keys) => warnNewerDeclarationKeys(path, "env close", keys, io),
      unknownNotifyEvents: (unknown) => warnUnknownNotifyEvents(path, "env close", unknown, io),
    },
  )
  if (options.dryRun === true) {
    const preview = {
      dryRun: true,
      path,
      head: commit,
      admitted: true,
      checked: [
        "registration",
        "roots",
        "lock",
        "private-content",
        "live-use",
        "census",
        options.preserve === true ? "preserve" : "clean",
      ],
      notChecked: ["component-custody", "retention", "remote-reread", "teardown"],
      preserve: {
        requested: options.preserve === true,
        dirty: options.preserve === true ? await environmentDirt(treeGit) : [],
      },
      teardown: config?.teardown ?? null,
      liveEnvironmentUseChecked: io.liveEnvironmentUse !== undefined,
    }
    if (options.json === true) io.stdout(`${JSON.stringify(preview)}\n`)
    else {
      io.stdout(
        `dry-run: ${path} would be admitted; component custody, retention and teardown are proved only by the real close.\n`,
      )
      io.stdout(
        `preserve: ${preview.preserve.requested ? JSON.stringify(preview.preserve.dirty) : "not requested"}\nteardown: ${preview.teardown ?? "(none)"}\n`,
      )
    }
    return 0
  }
  await beforeRemove?.()
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
        `environment teardown ${result.result} in preserved environment ${path}; completed custody refs: ${preservedRefs.length === 0 ? "none" : preservedRefs.join(", ")}: exit ${String(result.exit)}${result.why === undefined ? "" : ` (${result.why})`}\ncommand: ${config.teardown}\n${output}\nlog ${result.log}`,
      )
    }
    if (options.preserve !== true) {
      await requireClean(treeGit, path, " — or re-run with --preserve to keep this exact state in a durable ref first")
    } else {
      await preserve("after teardown")
    }
  }
  // A captured retirement handle can delete an unchanged author tip after
  // removal. Any custody pass retains every author branch, so capture only for
  // the ordinary clean close with no preservation ref.
  const retirement = preservedRefs.length === 0 ? await prepareAuthorRelease(path, io) : undefined
  if (retirement?.kind === "unreadable") {
    io.stderr(`yrd: ${retirement.reason}; read ${retirement.reads.join("; ")}; close continues\n`)
  }
  using retirementHandle = retirement?.kind === "eligible" ? retirement.handle : undefined
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
  await beforeRemove?.()
  // The root composition binds every selected owning destination to its
  // authorized `origin`. Re-read that remote after teardown and final
  // admission, with objects fetched into the owning store. Every pass's saved
  // commit must remain reachable, even when a later pass was a no-op.
  for (const entry of custody) {
    // A child may have no primary checkout; its environment store still owns
    // the fetched objects until git-super transfers or retains that store.
    const owner = entry.path === "" ? root : join(path, entry.path)
    const ownerGit = gitIn(owner, process, selection)
    const ref = entry.ref.startsWith("refs/heads/") ? entry.ref : `refs/heads/${entry.ref}`
    const local = await refAt(ownerGit, ref)
    if (local === undefined || !(await isAncestor(ownerGit, entry.sha, local))) {
      throw new Error(`environment ${path} kept: ${owner} ${ref} no longer contains preserved ${entry.sha} locally`)
    }
    const remote = (await readRemoteCommits(ownerGit, entry.remote, [ref])).get(ref)
    if (remote === undefined || !(await isAncestor(ownerGit, entry.sha, remote))) {
      throw new Error(
        `environment ${path} kept: ${owner} origin push URL ${entry.remote} ${ref} no longer contains preserved ${entry.sha}; completed custody refs: ${preservedRefs.join(", ")}`,
      )
    }
  }
  // 29073 (@cto ruling): with --preserve the no-submodule path takes the SAME git-super worktree
  // remove as the submodule path, so the verified-ref dirt gate has ONE implementation in ONE
  // process and yrd never re-derives it. The cost is an empty or absent modules retention and one
  // proof line for a tree that declares no .gitmodules. Explicit automatic custody also needs this
  // selected route even with no submodules; an ordinary manual close keeps the plain path.
  let removalProof: WorktreeRemovalProof | undefined
  if (
    modules.trim() !== "" ||
    options.retain !== undefined ||
    options.noRehome === true ||
    options.preserve === true ||
    options.componentCustody !== undefined
  ) {
    const retain = options.retain === undefined ? join(workdir, "retained-modules") : resolve(io.cwd, options.retain)
    let removed: unknown
    await assertNoLiveEnvironmentUse(path, io)
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
          ...(options.componentCustody === undefined
            ? []
            : ["--component-custody", JSON.stringify(options.componentCustody)]),
          ...preservedRefs.flatMap((ref) => ["--preserved", ref]),
        ]),
      )
    } catch (error) {
      throw new Error(
        `environment ${path} could not close through git super worktree remove: ${error instanceof Error ? error.message : String(error)}; inspect its registration and retention directory ${retain} before retrying; no plain-git fallback was attempted`,
        { cause: error },
      )
    }
    if (
      typeof removed === "object" &&
      removed !== null &&
      "state" in removed &&
      removed.state === "unchanged" &&
      "path" in removed &&
      removed.path === path &&
      "reason" in removed &&
      removed.reason === "component-custody" &&
      "custody" in removed &&
      typeof removed.custody === "object" &&
      removed.custody !== null &&
      "status" in removed.custody &&
      (removed.custody.status === "blocked" || removed.custody.status === "unknown") &&
      "component" in removed.custody &&
      typeof removed.custody.component === "string" &&
      removed.custody.component.trim() !== "" &&
      "source" in removed.custody &&
      typeof removed.custody.source === "string" &&
      removed.custody.source.trim() !== "" &&
      "detail" in removed.custody &&
      typeof removed.custody.detail === "string" &&
      removed.custody.detail.trim() !== "" &&
      (!("oid" in removed.custody) || (typeof removed.custody.oid === "string" && removed.custody.oid.trim() !== "")) &&
      (!("fingerprint" in removed.custody) ||
        (removed.custody.status === "blocked" &&
          typeof removed.custody.fingerprint === "string" &&
          /^[0-9a-f]{64}$/u.test(removed.custody.fingerprint)))
    ) {
      const custody = removed.custody
      const status = removed.custody.status
      const component = removed.custody.component
      const source = removed.custody.source
      const detail = removed.custody.detail
      const oid = "oid" in removed.custody && typeof removed.custody.oid === "string" ? removed.custody.oid : undefined
      const kept = { kept: path, reason: "component-custody", custody }
      io.stdout(
        options.json === true
          ? `${JSON.stringify(kept)}\n`
          : `kept environment ${path}: component custody ${status}: ${component}; source ${source}; ${detail}${oid === undefined ? "" : `; commit ${oid}`}\n`,
      )
      return 0
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
    removalProof = removed.proof as WorktreeRemovalProof
    io.stderr(`retained environment removal proof ${removalProof.manifest}\n`)
  } else {
    // No submodules recorded at this commit, so there is no gitlink for
    // git-super to materialize on the way out. The helper re-asks before it
    // issues the plain removal — the probe reads the TREE, the mutation belongs
    // to the repository that owns the worktree registry.
    await assertNoLiveEnvironmentUse(path, io)
    await worktreeWithoutSubmodules(treeGit, git, commit, ["remove", path])
  }
  const retirementOutcome =
    retirementHandle !== undefined ? await retirementHandle.retireAfterRelease(removalProof) : undefined
  if (removalProof !== undefined) removedProof?.(removalProof)
  const incomplete = retirementOutcome?.retirement === "incomplete"
  const failed = retirementOutcome?.failed ?? []
  io.stdout(
    options.json === true
      ? `${JSON.stringify({
          closed: path,
          ...(skipped === undefined ? {} : { skipped }),
          ...(incomplete ? { retirement: "incomplete" } : {}),
          ...(failed.length > 0 ? { failed } : {}),
        })}\n`
      : `closed environment ${path}${failed.length > 0 ? `; branch retirement failed: ${failed.join("; ")}` : ""}\n`,
  )
  // The environment is gone either way; a failed retirement left a branch behind, so the close is not a success (30642).
  return failed.length > 0 || (incomplete && removalProof === undefined) ? 1 : 0
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
    ...(options.preserve === true ? { preserve: true } : {}),
  }
  const request: EnvCloseRequest = {
    name: basename(path),
    path,
    requester: requesterOf(globalThis.process.env),
    uid: typeof globalThis.process.getuid === "function" ? globalThis.process.getuid() : -1,
    at: new Date().toISOString(),
    intent: "close",
    predicate: ENV_CLOSE_PREDICATE,
    options: chosen,
    head,
  }
  const queued = writeCloseRequest(workdir, request)
  const { file } = queued
  const journalDir = join(workdir, "logs", "post-merge")
  if (queued.alreadyStood) {
    const { standing } = queued
    io.stderr(
      `yrd: env close ${path}: ` +
        (standing.options.noRehome === true && chosen.noRehome !== true
          ? "your default close asked for rehome; "
          : "") +
        `standing request from ${standing.requester} at ${standing.at} closes ` +
        `${standing.options.noRehome === true ? "without" : "with"} rehome under ending ${JSON.stringify(standing.ending)}; ` +
        `it stands unchanged\n`,
    )
  }
  io.stderr(
    `yrd: env close ${path}: ${admission.refusal}; this caller cannot certify the close; ` +
      `queued request ${file} (exit 4 means queued, not closed yet) for the queue's own round, which reads every same-UID pid, unlinks ${file} when consumed, and journals the outcome under ${journalDir}\n`,
  )
  io.stdout(
    options.json === true
      ? `${JSON.stringify({
          queued: path,
          reason: "incomplete-census",
          request: file,
          census: admission.census,
          ...(queued.alreadyStood
            ? {
                alreadyQueued: true,
                standing: {
                  requester: queued.standing.requester,
                  at: queued.standing.at,
                  options: queued.standing.options,
                  ending: queued.standing.ending,
                },
              }
            : {}),
        })}\n`
      : `queued environment close for ${path} (exit 4 means queued, not closed yet): ${admission.refusal}; a context that can read every same-UID pid will close it, unlink ${file} when consumed, and journal the outcome under ${journalDir}; request ${file}\n`,
  )
  return ENV_CLOSE_QUEUED_EXIT
}

/** A local branch whose path contains `branch`, or sits inside it: git can store only one of the two (25850). */
async function branchPathConflict(git: Git, branch: string): Promise<string | undefined> {
  const branches = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).split("\n")
  return branches.find((name) => name !== "" && (branch.startsWith(`${name}/`) || name.startsWith(`${branch}/`)))
}
