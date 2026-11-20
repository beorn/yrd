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
import { superStatus } from "git-super/status"
import { rebuildRetainedCopyProof, verifyRetainedCopy } from "git-super"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { createGitWorkspace, worktreeHomeRoot, type ProvisionedBay } from "@yrd/bay"
import { processTerminate, type TerminatePort } from "./terminate.ts"
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
  reconstructibleFromMain,
  refAt,
  resolveGitSelection,
  retirePreviewSubject,
  runId,
  runStartedAt,
  runSetup,
  SetupFailed,
  worktreeWithoutSubmodules,
  type Git,
  type SameIssue,
  type GitRunner,
  type ReconstructedCommit,
  type Reconstruction,
} from "@yrd/queue-core"
import { adaptProcessGit, createProcess, type Process } from "@yrd/process"
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
  createGitWorktreeStore,
  PrivateStoreRefusalError,
  type PrivateStoreRefusal,
} from "git-super/worktree"
import { unaddressedRepository as findRepository } from "./declaration.ts"
import { ISSUE_DISPLAY_TIMEOUT_MS } from "./issue-resolver.ts"
import { issueComparer } from "./issue-sameness.ts"
import { ISSUES_CODES } from "./issues/declaration.ts"
import { runIssuesVerb } from "./issues/run.ts"
import { originHead } from "./queue-location.ts"
import type { YrdCliExitCode, YrdCliIO, CloseExecutionBudget } from "./types.ts"
export type { CloseExecutionBudget } from "./types.ts"
import { workdirOf } from "./workdir.ts"
import { censusRetainedStores, retainedCloseLine } from "./retained-census.ts"
import { discardRetainedEntry, type SuperRun } from "./retained-discard.ts"
import { formatYrdCommand } from "./command-format.ts"
import {
  envOpenRecordFromFlags,
  parseEnvExpires,
  readEnvOpenRecord,
  writeEnvOpenRecord,
  type EnvLifetime,
} from "./env-open-record.ts"
import { readEnvIssueState } from "./env-issue-state.ts"
import {
  admitEnvironmentClose,
  assertNoLiveEnvironmentUse,
  closeWorkRemaining,
  censusReaderLine,
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
  /** `<duration|instant>`; the only legitimate open with no `--issue`, because a detached commit cannot be bound. */
  expires?: string
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
 * The exit code a verb returns when its intent was FILED for the queue's own
 * round instead of being carried out here (today: checkout release delegation,
 * 29772).
 *
 * `yrd env close` used this code for its own queued outcome until 31807 and no
 * longer does: a close request this caller cannot certify is ACCEPTED, so it is
 * exit 0 with a `{ queued: true, closed: false }` receipt and the queue's round
 * is the certifying authority (@cto a12b2c1a). Only a true refusal (a holder
 * read inside the environment, or an uncertifiable request after teardown) and
 * a request this caller cannot write are non-zero. The value stays 4 because
 * the release paths and their callers read it.
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
export type EnvironmentRemovalTarget = Readonly<{ name: string; path: string; branch?: string; head?: string }>
export type CloseExecutionContext = Readonly<{
  onIncompleteCensus?: CloseAdmissionMode
  budget: CloseExecutionBudget
  beforeRemove?: (target: EnvironmentRemovalTarget, budget: CloseExecutionBudget) => Promise<void>
}>

export type EnvListOptions = Readonly<{ json?: boolean }>

/** Association from the existing opening record; absence and read failure are not an unbound record. */
export type EnvIssueBinding =
  | Readonly<{ state: "recorded"; issue?: string; lifetime: EnvLifetime; expiresAt?: string }>
  | Readonly<{ state: "unrecorded"; why: string }>
  | Readonly<{ state: "unreadable"; why: string }>

/** One environment as git holds it: a worktree under the bays root. */
export type EnvRow = Readonly<{
  name: string
  path: string
  branch?: string
  head?: string
  hold: string | null
  issueBinding: EnvIssueBinding
}>

function isIssueBinding(value: unknown): value is EnvIssueBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const binding = value as Record<string, unknown>
  if (binding.state === "unrecorded" || binding.state === "unreadable") return typeof binding.why === "string"
  return (
    binding.state === "recorded" &&
    (binding.lifetime === "job" || binding.lifetime === "standing") &&
    (binding.issue === undefined || typeof binding.issue === "string") &&
    (binding.expiresAt === undefined || typeof binding.expiresAt === "string")
  )
}

/** The producer's transport boundary. A missing opening fact never supplies an automatic binding. */
export function parseEnvironmentList(text: string): EnvRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`its JSON cannot be read (${error instanceof Error ? error.message : String(error)})`)
  }
  const environments = (parsed as { environments?: unknown } | null)?.environments
  if (!Array.isArray(environments)) throw new Error("it carries no environments array")
  return environments.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`environment ${index} is not an object`)
    }
    const row = entry as Record<string, unknown>
    if (typeof row.name !== "string" || row.name === "" || typeof row.path !== "string" || row.path === "") {
      throw new Error(`environment ${index} carries no name or path`)
    }
    for (const key of ["head", "branch", "hold"] as const) {
      if (row[key] !== undefined && row[key] !== null && typeof row[key] !== "string") {
        throw new Error(`environment ${index}.${key} is not a string or null`)
      }
    }
    return {
      name: row.name,
      path: row.path,
      hold: typeof row.hold === "string" ? row.hold : null,
      ...(typeof row.head === "string" ? { head: row.head } : {}),
      ...(typeof row.branch === "string" ? { branch: row.branch } : {}),
      issueBinding: isIssueBinding(row.issueBinding)
        ? row.issueBinding
        : {
            state: "unreadable" as const,
            why: `environment ${index} opening issue binding is missing or malformed`,
          },
    }
  })
}

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

const ENV_STORE_MAINTENANCE_SETTINGS = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
] as const

/** Invocation-only protection before provisioning establishes the owned module stores. */
export function environmentProvisioningProcess(process: Pick<Process, "run">): Pick<Process, "run"> {
  return {
    run(request) {
      const env = request.env ?? globalThis.process.env
      const settings = ENV_STORE_MAINTENANCE_SETTINGS.map(([key, value]) => `'${key}=${value}'`).join(" ")
      return process.run({
        ...request,
        env: {
          ...env,
          GIT_CONFIG_PARAMETERS: [env.GIT_CONFIG_PARAMETERS, settings].filter(Boolean).join(" "),
        },
      })
    },
  }
}

/**
 * Configure automatic maintenance and the caller's declared identity in every materialized
 * submodule. Alternate-backed split graphs written by automatic maintenance can make root
 * merges fatal (#35119); explicit maintenance and graph reads remain available.
 * Module-local settings do not depend on the separate root identity verification.
 * A submodule is its own repository, so the root's worktree
 * config never reaches it and a commit there fell through to the shared
 * `~/.gitconfig` identity — in this fleet the operator's, so a seat's commits
 * were attributed to the operator (#27403). The write is the submodule's OWN
 * local config; for a submodule of a linked worktree that file lives under the
 * worktree's git dir, so it cannot reach another worktree. A submodule that is
 * itself a linked worktree would store the write in the config every worktree
 * of that submodule inherits, so it is refused loudly.
 */
async function pinSubmoduleConfiguration(
  root: string,
  git: GitRunner,
  identity: Readonly<{ email: string; name: string }> | undefined,
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
          `${commonDir}); pinning environment settings there would land in the config every worktree of that submodule ` +
          `inherits, so it is refused`,
      )
    }
    const settings: readonly (readonly [string, string])[] = [
      ...ENV_STORE_MAINTENANCE_SETTINGS,
      ...(identity === undefined
        ? []
        : ([
            ["user.name", identity.name],
            ["user.email", identity.email],
          ] as const)),
    ]
    for (const [key, value] of settings) {
      await sub(["config", "--local", key, value])
      const actual = (await sub(["config", "--local", "--get", key])).trim()
      if (actual !== value) {
        throw new Error(
          `yrd env open: setting ${key}=${value} in submodule ${rel} of ${root} did not take (reads '${actual}')`,
        )
      }
    }
    pinned.push(rel)
  }
  if (pinned.length > 0 && identity !== undefined) {
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
 * environment materialized are pinned by {@link pinSubmoduleConfiguration}, from
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
  /** The parsed instant from `--expires`; recorded beside the flags it came from. */
  expiresAt?: string,
): Promise<void> {
  const gitDir = (await gitIn(path, process, selection)(["rev-parse", "--absolute-git-dir"])).trim()
  try {
    writeEnvOpenRecord(gitDir, {
      ...envOpenRecordFromFlags(options),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    })
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
/** How the shared issue resolution names its caller: open keeps its words, bind names its own path and verb. */
type IssueResolutionVerb = Readonly<{
  /** `env open` or `env bind`, as the diagnostics print it. */
  verb: "open" | "bind"
  /** The yrd argv a retry from the primary checkout runs; empty keeps env open's own. */
  retry: readonly string[]
  /** What a refusal leaves unwritten. */
  unwritten: string
}>

const OPEN_RESOLUTION: IssueResolutionVerb = {
  verb: "open",
  retry: [],
  unwritten: "no environment, branch or Refs commit was created",
}

async function requireResolvableIssue(
  root: string,
  issue: string,
  io: YrdCliIO,
  git: Git,
  caller: IssueResolutionVerb = OPEN_RESOLUTION,
): Promise<void> {
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
      `yrd env ${caller.verb}: --issue ${issue} was not checked against an issues store, because ${root} declares none for it: ${outcome.message}\n`,
    )
    return
  }
  let recovery = ""
  try {
    const primary = (await registeredWorktrees(git))[0]
    if (primary?.head !== undefined && resolve(primary.path) !== resolve(root)) {
      const retry = caller.retry.length === 0 ? ["env", "open", "--issue", issue] : caller.retry
      recovery =
        ` If this checkout's issues provider is stale, retry from the primary checkout: ` +
        `(${formatYrdCommand(io, retry, primary.path)})`
    }
  } catch (error) {
    recovery = ` Primary-checkout recovery could not be read from Git at ${root}: ${error instanceof Error ? error.message : String(error)}`
  }
  throw new Error(
    `yrd env ${caller.verb}: --issue ${issue} does not resolve to an issue through the issues interface declared by ${root}, ` +
      `so ${caller.unwritten}: ${outcome.message}${recovery}`,
  )
}

/** What the one binding writer did, or (dry run) would do. `head` is always the branch's CURRENT head. */
export type IssueBindOutcome = Readonly<{
  /** The issue key as the binding records it: the existing spelling when the branch was already bound. */
  issue: string
  /** The branch head after this call: the new bind commit, or the observed head when nothing was written. */
  head: string
  /** The head this call observed and validated before any write. */
  previousHead: string
  /** A bind commit was written and the branch moved to it. */
  wrote: boolean
  /** Dry run only: a real call would write a bind commit. */
  wouldWrite: boolean
  /** The commit carrying the binding: the existing one (possibly older than `head`) or the new one. */
  bindingCommit?: string
}>

/**
 * The ONE writer of an issue binding (#34855; `yrd env open` and `yrd env bind` both call it). It reads the
 * branch through `issueOf` with the declared key and the project's sameness judge, so a same-issue retry or
 * alias writes nothing and returns the CURRENT head (never the older commit that carries the binding), and a
 * different issue refuses with `issueOf`'s own words. A write is a commit of the observed head's own tree
 * (staged, unstaged and untracked bytes and the index stay exactly as they were) and an expected-old
 * update-ref of exactly `refs/heads/<branch>`. Each failure names the stage it happened in: before the
 * update-ref nothing moved; after a successful update-ref the branch HAS moved, and that is said, never
 * rewound.
 */
export async function bindBranchToIssue(
  input: Readonly<{
    git: Git
    branch: string
    /** The head the caller observed; the CAS expected-old. */
    head: string
    /** issueOf's target head: bindings are read in merge-base(head, target)..head. */
    target: string
    issue: string
    sameIssue: SameIssue
    verb: "open" | "bind"
    dryRun?: boolean
  }>,
): Promise<IssueBindOutcome> {
  const { git, branch, head, issue, verb } = input
  const ref = `refs/heads/${branch}`
  const tip = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim()
  if (tip !== head) {
    throw new Error(
      `${ref} is at ${tip === "" ? "no commit" : tip}, not the observed head ${head}; nothing was written`,
    )
  }
  const binding = await issueOf(git, branch, head, input.target, issue, input.sameIssue)
  if (binding === undefined) throw new Error(`no issue resolved for requested binding ${issue}`)
  if (binding.source === "binding") {
    const current = (await git(["rev-parse", "HEAD"])).trim()
    if (current !== head) {
      throw new Error(`HEAD is at ${current}, not the observed head ${head} of ${ref}; nothing was written`)
    }
    return {
      issue: binding.issue,
      head,
      previousHead: head,
      wrote: false,
      wouldWrite: false,
      ...(binding.commit === undefined ? {} : { bindingCommit: binding.commit }),
    }
  }
  if (input.dryRun === true) {
    return { issue: binding.issue, head, previousHead: head, wrote: false, wouldWrite: true }
  }
  let bound: string
  try {
    const tree = (await git(["rev-parse", `${head}^{tree}`])).trim()
    bound = (
      await git(["commit-tree", tree, "-p", head, "-m", `Bind work to ${binding.issue}\n\nRefs: ${binding.issue}`])
    ).trim()
  } catch (error) {
    throw new Error(
      `could not create the bind commit for ${binding.issue}; ${ref} was not moved: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  try {
    // A self-describing reflog message: git writes it verbatim into HEAD's
    // reflog, so a reader can tell the binding commit from any other move.
    // The provenance classifier treats this prefix as creating (27723).
    await git(["update-ref", "-m", `yrd env ${verb}: bind ${binding.issue}`, ref, bound, head])
  } catch (error) {
    throw new Error(
      `${ref} was not moved by this call: its expected head ${head} no longer holds or the update failed ` +
        `(${error instanceof Error ? error.message : String(error)}); the created commit ${bound} may remain as an unreferenced object`,
      { cause: error },
    )
  }
  let current: string
  try {
    current = (await git(["rev-parse", "HEAD"])).trim()
  } catch (error) {
    throw new Error(
      `binding already written: ${ref} moved ${head} -> ${bound} (Refs: ${binding.issue}); reading HEAD afterwards failed: ` +
        `${error instanceof Error ? error.message : String(error)}; the branch was not rewound`,
      { cause: error },
    )
  }
  if (current !== bound) {
    throw new Error(
      `binding already written: ${ref} moved ${head} -> ${bound} (Refs: ${binding.issue}); HEAD then read ${current}, ` +
        `not the bind commit; the branch was not rewound`,
    )
  }
  return { issue: binding.issue, head: bound, previousHead: head, wrote: true, wouldWrite: false, bindingCommit: bound }
}

/**
 * 29738: the bind commit carries the --issue value exactly as given, so a later Refs trailer that spells the
 * issue the other way refuses at submit - after a review GO. ANNOUNCE the key where the split is created, in
 * the 28113 shape: stderr only, never a refusal, naming yrd's OWN flag and key so yrd still learns nothing of
 * hh's bead model. `--json` stdout and the exit code are unchanged. @cto 08:31:50Z fixed this wording: the line
 * names the exact key it wrote and the rule that every later Refs trailer must spell it exactly that way.
 */
function announceBinding(io: YrdCliIO, branch: string, issue: string, verb: "open" | "bind"): void {
  io.stderr(
    `${branch} is bound to ${issue} by a yrd env ${verb} Refs commit, which carries the --issue value exactly as given; every later Refs trailer on this branch must spell it exactly that way, or submit refuses with conflicting issue bindings\n`,
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
  // 33758 keep-rule: an environment with neither an issue nor an expiry is unowned — no retirement path can
  // name it and the census only sees it by ancestry. Refused before a bay, branch or worktree exists, naming
  // both cures in one line.
  if (options.issue === undefined && options.expires === undefined) {
    throw new Error(
      "yrd env open refuses to open an environment with neither an issue nor an expiry: nothing would name it " +
        "for retirement or review later. Pass --issue <ref> to bind the branch with a Refs commit, or " +
        "--expires <duration|instant> (at most 7d) for a bay retained at an exact commit.",
    )
  }
  const expiresAt = options.expires === undefined ? undefined : parseEnvExpires(options.expires)
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
  const provisioningProcess = environmentProvisioningProcess(process)
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
    await freshWorktree(gitIn(root, provisioningProcess, selection), root, base, path)
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
          ...(options.expires === undefined ? [] : ["--expires", options.expires]),
          ...(options.json === true ? ["--json"] : []),
        ],
        root,
      )
      throw new Error(
        `environment ${existing.path} is clean and merged into requested base ${base}; close must finish before reopening. A close this caller cannot certify is queued, not closed: it exits 0 and says so, and the queue's round finishes it — wait for that before reopening. To continue: ${close} && ${reopen}`,
      )
    }
    const workspace = await createGitWorkspace({ repo: root, baysRoot: baysRootOf(root), process: provisioningProcess })
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
  await pinSubmoduleConfiguration(path, gitIn(path, process, selection), declaredIdentity, io)
  await pinDeclaredIdentity(path, gitIn(path, process, selection), declaredIdentity, io)
  await recordOpenedLifetime(path, process, selection, options, expiresAt)
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
      const bound = await bindBranchToIssue({
        git: environmentGit,
        branch,
        head: headSha,
        target: base,
        issue: options.issue,
        sameIssue: issueComparer({ projectRoot: root, cwd: root, stderr: (text) => io.stderr(text) }),
        verb: "open",
      })
      if (bound.wrote) announceBinding(io, branch, bound.issue, "open")
      headSha = bound.head
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
      `${branch} carries no bead id; open bead work with --issue <ref> — it names the branch task/<issue> and binds it with a Refs commit. ` +
        `This bay expires at ${expiresAt}\n`,
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
  const rows: EnvRow[] = []
  for (const { path, head, branch, locked } of await registeredWorktrees(git)) {
    if (!prefixes.some((prefix) => path.startsWith(prefix))) continue
    let issueBinding: EnvIssueBinding
    try {
      const gitDir = (await git(["-C", path, "rev-parse", "--absolute-git-dir"])).trim()
      if (gitDir === "") throw new Error("Git returned an empty opening record directory")
      const opening = readEnvOpenRecord(gitDir)
      if (opening.status === "recorded") {
        const { issue, lifetime, expiresAt } = opening.record
        issueBinding = {
          state: "recorded",
          lifetime,
          ...(issue === undefined ? {} : { issue }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        }
      } else {
        issueBinding = { state: opening.status, why: opening.why }
      }
    } catch (cause) {
      issueBinding = {
        state: "unreadable",
        why: `opening record unreadable for ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }
    }
    rows.push({
      name: basename(path),
      path,
      hold: locked ?? null,
      issueBinding,
      ...(head === undefined ? {} : { head }),
      ...(branch === undefined ? {} : { branch }),
    })
  }
  return { roots, rows }
}

export type EnvRetainedOptions = Readonly<{
  json?: boolean
  retain?: string
  retireExpired?: boolean
  apply?: boolean
  limit?: number
  namespace?: readonly string[]
  artifactDir?: string
  entry?: readonly string[]
  /** 34787: one direct child to discard explicitly; previews unless --apply. */
  discard?: string
  reason?: string
  /** #35047: the termination port a retirement batch answers; the process signals unless a test injects one. */
  terminate?: TerminatePort
}>

// The approved batch scan measured 469-665 s; this caller alone needs room beyond gitIn's normal 300 s ceiling.
const RETAINED_BATCH_TIMEOUT_MS = 1_200_000

/** 34787: `env retained --discard <entry>`; the batch selectors never mix with it. */
async function discardRetained(options: EnvRetainedOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  if (options.retireExpired === true || (options.entry?.length ?? 0) > 0 || options.limit !== undefined) {
    throw new Error(
      "--discard names one entry and never joins --retire-expired, --entry or --limit; nothing was discarded",
    )
  }
  const root = requireRepository(io)
  const selection = await resolveGitSelection(root)
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process, selection)
  const workdir = await workdirOf(git)
  const retentionRoot =
    options.retain === undefined ? join(workdir, "retained-modules") : resolve(io.cwd, options.retain)
  const superGit = gitIn(root, process, selection, {
    timeoutMs: RETAINED_BATCH_TIMEOUT_MS,
    rootInvocationTimeoutMs: RETAINED_BATCH_TIMEOUT_MS,
  })
  const runSuper: SuperRun = async (args) => {
    try {
      const stdout = await superGit(args)
      return { code: 0, stdout, stderr: superGit.lastInvocation?.result?.stderr ?? "" }
    } catch (error) {
      const result = superGit.lastInvocation?.result
      // Only an ordinary nonzero exit carries GitSuper's own answer; a timeout or spawn defect stays loud.
      if (result === undefined || result.signal !== null || result.exitCode === 0) throw error
      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    }
  }
  return await discardRetainedEntry(
    {
      entry: options.discard as string,
      reason: options.reason,
      apply: options.apply === true,
      json: options.json === true,
      retentionRoot,
      common: (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
      namespace: (options.namespace ?? []).map((path) => resolve(io.cwd, path)),
      artifactDir: options.artifactDir === undefined ? "" : resolve(io.cwd, options.artifactDir),
      logDirectory: join(resolve(root, workdir), "logs"),
      actor: requesterOf(globalThis.process.env),
    },
    io,
    runSuper,
    (args, input) => git(args, input),
  )
}

// The rank walk's soft deadline sits under the transport's hard kill, so an ordinary partial ranking can still
// serialize; a single stalled walk can outlast it and then fails through the hard timeout below (#34920).
const RETAINED_RANK_HEADROOM_MS = 120_000

interface RetainedRankingReply {
  ranked: { entry: string; bytes: number; sharedBytes: number; unreadable: number }[]
  unmeasured: { entry: string; reason: string }[]
  measuredBytes: number
  partial: boolean
  deadlineHit: boolean
  ms: number
}

function isRankingReply(value: unknown): value is RetainedRankingReply {
  const reply = value as Partial<RetainedRankingReply> | null
  return (
    typeof reply === "object" &&
    reply !== null &&
    Array.isArray(reply.ranked) &&
    Array.isArray(reply.unmeasured) &&
    typeof reply.measuredBytes === "number" &&
    typeof reply.deadlineHit === "boolean"
  )
}

/**
 * Size-ranked selection for `--retire-expired` without `--entry` (#34920, @cto 34920-ranking-and-bare-r2 §1): GitSuper
 * measures every expired store with its own byte walker (`retire-batch --rank-only`) and this keeps the `limit` stores
 * holding the most bytes alone. The names are frozen and printed so a later `--apply --entry ...` names exactly this
 * plan. A rank that fails, times out or returns nothing plans nothing: there is no lexical fallback.
 */
async function planLargestExpired(
  batch: ReturnType<typeof gitIn>,
  scope: readonly string[],
  retentionRoot: string,
  expired: readonly string[],
  limit: number,
  io: YrdCliIO,
): Promise<string[] | undefined> {
  const deadlineSeconds = (RETAINED_BATCH_TIMEOUT_MS - RETAINED_RANK_HEADROOM_MS) / 1000
  let reply: unknown
  try {
    const stdout = await batch([
      "super",
      "--json",
      "worktree",
      "retention",
      "retire-batch",
      "--rank-only",
      "--rank-deadline-seconds",
      String(deadlineSeconds),
      ...scope,
      ...[...expired].sort().map((name) => join(retentionRoot, name)),
    ])
    reply = JSON.parse(stdout)
  } catch (error) {
    const result = batch.lastInvocation?.result
    if (result?.stdout) io.stdout(result.stdout)
    if (result?.stderr) io.stderr(result.stderr)
    io.stderr(
      result?.timedOut === true
        ? `retained rank under ${retentionRoot}: ranking exceeded ${RETAINED_BATCH_TIMEOUT_MS / 1000} s; child killed; no batch planned\n`
        : `retained rank under ${retentionRoot}: ${error instanceof Error ? error.message : String(error)}; no batch planned\n`,
    )
    // silent-fallback-allow: the failure and the child's own output are named on stderr above, and the caller exits 2
    // with no batch planned; there is no lexical fallback.
    return undefined
  }
  if (!isRankingReply(reply)) {
    io.stderr(`retained rank under ${retentionRoot}: GitSuper returned an unreadable ranking; no batch planned\n`)
    return undefined
  }
  const reasons = new Map<string, number>()
  for (const row of reply.unmeasured) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1)
  const planned = reply.ranked.slice(0, limit)
  io.stderr(
    `ranked ${reply.ranked.length} of ${expired.length} expired store(s) by the bytes each holds alone in ${reply.ms} ms; ` +
      `summed rank scores ${reply.measuredBytes} B${reply.partial ? " (partial)" : ""}` +
      (reply.deadlineHit ? `; rank deadline ${deadlineSeconds} s reached before every store` : "") +
      (reply.unmeasured.length === 0
        ? ""
        : `; ${reply.unmeasured.length} unmeasured (${[...reasons].map(([reason, count]) => `${count} ${reason}`).join(", ")})`) +
      `\nplanned ${planned.length} (rank score per store, not what the set frees; the dry run below measures that):\n`,
  )
  for (const row of planned) {
    io.stderr(
      `  ${row.bytes} B\t${basename(row.entry)}` +
        (row.sharedBytes > 0 ? `\tshared ${row.sharedBytes} B` : "") +
        (row.unreadable > 0 ? `\tunreadable ${row.unreadable}` : "") +
        "\n",
    )
  }
  return planned.map((row) => basename(row.entry))
}

/**
 * `yrd env retained` — the census of the stores `env close` retained (#33010): live, past their own retainUntil,
 * legacy, malformed and manifest-less, read from manifests with no size walk. --retire-expired selects a batch;
 * it is a dry run unless --apply is explicit. The existing Git transport owns frozen-binary selection and killing.
 */
export async function retainedEnvironments(options: EnvRetainedOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  if (options.discard !== undefined) return discardRetained(options, io)
  if (options.reason !== undefined) {
    throw new Error("--reason belongs to --discard <entry>; no retained stores were touched")
  }
  if (options.apply === true && options.retireExpired !== true) {
    throw new Error("--apply requires --retire-expired; no retained stores were touched")
  }
  if (options.apply === true && !options.entry?.length) {
    throw new Error(
      "--apply requires explicit --entry names from the granted dry-run list; no retained stores were touched",
    )
  }
  const limit = options.limit ?? 20
  if (options.retireExpired === true) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive whole number")
    if (options.entry !== undefined && options.entry.length > limit) {
      throw new Error(
        `${options.entry.length} explicit --entry names exceed --limit ${limit}; the granted list cannot be shortened; no retained stores were touched`,
      )
    }
  }
  if (options.retireExpired === true && (!options.namespace?.length || !options.artifactDir)) {
    throw new Error(
      "--retire-expired requires the complete --namespace <managed-root> declaration and --artifact-dir <external-evidence-dir>; no retained stores were touched",
    )
  }
  const root = requireRepository(io)
  const selection = await resolveGitSelection(root)
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process, selection)
  const retentionRoot =
    options.retain === undefined ? join(await workdirOf(git), "retained-modules") : resolve(io.cwd, options.retain)
  const census = censusRetainedStores(retentionRoot, Date.now())
  if (options.retireExpired === true) {
    // #35047: a TERM, INT or HUP to this CLI closes its Process owner before the process dies of the signal, so the
    // GitSuper batch's detached process group gets the owner's TERM-then-KILL settlement instead of outliving the CLI
    // and writing evidence after the caller's deadline (observed 2026-11-19: twice). A SIGKILL runs no handler.
    const terminate = options.terminate ?? processTerminate
    const offTerminate = terminate.on((received) => {
      offTerminate()
      const signal = received ?? "SIGTERM"
      io.stderr(`retained batch under ${retentionRoot}: ${signal} received; settling the GitSuper child before exit\n`)
      void process.close().then(
        () => terminate.reraise(signal),
        (error) => {
          io.stderr(
            `retained batch under ${retentionRoot}: settling the child failed before ${signal}: ${String(error)}\n`,
          )
          terminate.reraise(signal)
        },
      )
    })
    try {
      return await retireExpiredBatch()
    } finally {
      offTerminate()
    }
  }
  async function retireExpiredBatch(): Promise<YrdCliExitCode> {
    const batch = gitIn(root, process, selection, {
      timeoutMs: RETAINED_BATCH_TIMEOUT_MS,
      rootInvocationTimeoutMs: RETAINED_BATCH_TIMEOUT_MS,
    })
    const scope = [
      "--root",
      retentionRoot,
      "--common",
      (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
      ...(options.namespace ?? []).flatMap((path) => ["--namespace", resolve(io.cwd, path)]),
      "--artifact-dir",
      resolve(io.cwd, options.artifactDir as string),
    ]
    let names: string[] = []
    if (options.entry?.length) {
      // An explicit list is the granted list: never reranked, truncated or measured.
      names = [...options.entry]
    } else if (census.state === "read" && census.expiredEntries.length > 0) {
      const planned = await planLargestExpired(batch, scope, retentionRoot, census.expiredEntries, limit, io)
      if (planned === undefined) return 2
      names = planned
    }
    for (const name of names) {
      if (basename(name) !== name || name === "." || name === "..") {
        throw new Error(`--entry ${name} must name one direct child of ${retentionRoot}`)
      }
    }
    const entries = names.map((name) => join(retentionRoot, name))
    if (entries.length === 0) {
      const reason = `no selected expired stores with writerLocks and notCompared under ${retentionRoot}; legacy, missing-field, malformed and manifest-less stores excluded`
      io.stdout(
        options.json === true
          ? `${JSON.stringify({ root: retentionRoot, apply: options.apply === true, rows: [], reason, census })}\n`
          : `${reason}\n`,
      )
      return 0
    }
    const args = [
      "super",
      ...(options.json === true ? ["--json"] : []),
      "worktree",
      "retention",
      "retire-batch",
      ...scope,
      ...(options.apply === true ? ["--apply"] : []),
      ...entries,
    ]
    try {
      io.stdout(await batch(args))
      const stderr = batch.lastInvocation?.result?.stderr
      if (stderr) io.stderr(stderr)
      return 0
    } catch (error) {
      const result = batch.lastInvocation?.result
      if (result?.stdout) io.stdout(result.stdout)
      if (result?.stderr) io.stderr(result.stderr)
      io.stderr(
        result?.timedOut === true
          ? `retained batch under ${retentionRoot}: batch exceeded 1200 s; child killed; inspect its evidence before retrying\n`
          : `retained batch under ${retentionRoot}: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      return 2
    }
  }
  if (options.json === true) {
    io.stdout(`${JSON.stringify(census)}\n`)
    return 0
  }
  if (census.state === "absent") {
    io.stdout(`no retained stores: ${retentionRoot} does not exist (no environment has closed into it)\n`)
    return 0
  }
  io.stdout(
    `${census.total} retained store(s) under ${retentionRoot}: ${census.live} live, ${census.expired} past retainUntil ` +
      `(${census.expiredLegacy} with a legacy manifest${census.oldestExpired === null ? "" : `, oldest ${census.oldestExpired}`}), ` +
      `${census.expiredMissingNotCompared.length} expired without notCompared, ` +
      `${census.malformed.length} malformed, ${census.noManifest.length} without a manifest\n`,
  )
  for (const name of census.expiredMissingNotCompared) io.stdout(`kept missing notCompared: ${name}\n`)
  const describeUnpublished = (name: string, fallback: string): string => {
    const preparation = census.unpublished?.find((entry) => entry.name === name)
    const problem = census.preparationProblems?.[name]
    return preparation === undefined
      ? problem === undefined
        ? fallback
        : `${fallback.trimEnd()}; ${problem}\n`
      : `unpublished preparation: ${name}: ${preparation.reason}; created ${preparation.createdAt}; source ${preparation.sourceGitDir}${preparation.reason === "interrupted publication" ? `; ${fallback.trim()}` : ""}\n`
  }
  for (const entry of census.malformed) {
    io.stdout(describeUnpublished(entry.name, `malformed: ${entry.name}: ${entry.reason}\n`))
  }
  for (const name of census.noManifest) io.stdout(describeUnpublished(name, `no manifest: ${name}\n`))
  return 0
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
    `${rows
      .map((row) => {
        const binding = row.issueBinding
        const issue =
          binding.state === "recorded"
            ? (binding.issue ?? "recorded-none")
            : binding.state === "unrecorded"
              ? "unrecorded"
              : `unreadable:${binding.why}`
        return `${row.name}  ${row.branch ?? "(detached)"}  ${row.path}${row.hold === null ? "" : row.hold === "" ? "  held" : `  hold: ${row.hold}`}  issue:${issue}`
      })
      .join("\n")}\n`,
  )
  return 0
}

interface DiscardedGitlink {
  readonly path: string
  readonly pin: string
}

interface DiscardedCommit {
  /** 34744: the component path that held this commit; absent for the environment's own root commits. */
  readonly repo?: string
  readonly sha: string
  readonly subject: string
  readonly gitlinks?: readonly DiscardedGitlink[]
}

interface AdmissibleGitlink {
  readonly path: string
  readonly root: string
  readonly headPin: string
  readonly previousHead: string
  readonly previousBranch?: string
}

interface EnvironmentCloseState {
  readonly dirty: readonly string[]
  readonly discarded: readonly DiscardedCommit[]
  readonly admissibleGitlinks: readonly AdmissibleGitlink[]
  /**
   * 33555 (@cto 5a8ec5a1, a5953bad): a detached HEAD whose commits ahead of origin/main are each reachable from some
   * branch, remote-tracking ref or tag loses nothing on close. `ref` names one ref that holds them, so the close says
   * where they are instead of closing with no record.
   */
  readonly heldOn?: Readonly<{ ref: string; commits: number }>
  /**
   * 34764 (@cto r3): how many `dirty` entries are root commits with content ahead of origin/main on a detached HEAD.
   * When they are all of it, a branch keeps that work and a plain close then succeeds, so the refusal says so;
   * any other entry (a component, an uncommitted byte) keeps the --preserve route.
   */
  readonly rootAheadContent: number
  /**
   * 34787 (@cto 34787-component-retention-ruling): on an owner's close, a clean component sitting at a gitlink the
   * root's commits ahead moved is retained by git-super's copy, never judged by remote ancestry here. The copy's own
   * custody check decides when it may later be retired. Each entry is named in the close receipt with the store the
   * removal proof retained.
   */
  readonly retainedComponents: readonly Readonly<{ path: string; pin: string; gitDir: string }>[]
}

/**
 * 32124 & 32137 (@cto rulings 3cb041cd, 62f8faa4): decide dirtiness from per-repo needsPreserve,
 * not raw `git status`, so plain `env close` and `env close --preserve` share one answer.
 * - B1: a gitlink-only difference whose submodule is clean and whose HEAD is an ancestor of the
 *   submodule's remote-tracking main is admissible.
 * - B2: for a detached root, "ahead" means content ahead: if `mergeBase..HEAD` carries no tree change
 *   or only advances mode-160000 submodule gitlinks whose pins are clean and ancestors of their
 *   submodule's remote-tracking main (reusing the B1 check), close may discard the commits and record
 *   each sha, subject, and discarded gitlink path/pin.
 * - B3: otherwise (detached HEAD with content ahead, dirty or unreachable submodule, or unbound store),
 *   close refuses and names `git switch -c task/<issue>, then --preserve` for a detached HEAD.
 * - 34744 (@cto fa2ab09a): "an ancestor of main" in B1 and B2 widens to "discardable": also a pin, or a root's
 *   commits ahead, whose every commit beyond one captured main oid is a two-parent merge that Git's standard merge
 *   of its parents rebuilds exactly (reconstructibleFromMain). Those commits are listed as discards, with their
 *   repo, so a close says what it threw away.
 */
/** 34787: the real path of an existing path, or the path resolved as given when it cannot be read. */
function canonicalPath(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return resolve(target)
  }
}

/** 34787: whether `target` is `parent` or lies under it. */
function pathWithin(parent: string, target: string): boolean {
  const part = relative(parent, target)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

async function inspectEnvironmentCloseState(
  path: string,
  treeGit: Git,
  process: Process,
  selection: Awaited<ReturnType<typeof resolveGitSelection>>,
  detached: boolean,
  /** 34787: an owner's close (no automatic component-custody proof requested) retains instead of refusing. */
  retainComponents: boolean,
): Promise<EnvironmentCloseState> {
  const status = superStatus({ repo: path })
  const dirty: string[] = []
  let rootAheadContent = 0
  for (const problem of status.submoduleProblems) {
    dirty.push(`${problem.path}: ${problem.reason}`)
  }
  const cleanByPath = new Map<string, boolean>()
  const repoByPath = new Map<string, (typeof status.consultedRepositories)[number]>()
  for (const repo of status.consultedRepositories) {
    repoByPath.set(repo.path, repo)
    const repoGit = repo.path === "." ? treeGit : gitIn(repo.root, process, selection)
    const ownStatus = (
      await repoGit(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"])
    ).trim()
    const ownLines = ownStatus === "" ? [] : ownStatus.split("\n")
    for (const line of ownLines) {
      dirty.push(repo.path === "." ? line : `${line.slice(0, 3)}${repo.path}/${line.slice(3)}`)
    }
    const staged = (
      await repoGit(["--no-optional-locks", "diff", "--cached", "--name-status", "--ignore-submodules=dirty"])
    ).trim()
    const stagedLines = staged === "" ? [] : staged.split("\n")
    for (const line of stagedLines) {
      const [code, ...rest] = line.split("\t")
      const relPath = rest.join("\t")
      if (code === undefined || relPath === "") continue
      const fullPath = repo.path === "." ? relPath : `${repo.path}/${relPath}`
      if (!dirty.some((entry) => entry.slice(3) === fullPath)) {
        dirty.push(`${code.padEnd(2, " ")} ${fullPath}`)
      }
    }
    cleanByPath.set(repo.path, ownLines.length === 0 && stagedLines.length === 0)
  }
  const isSubmoduleClean = (repoPath: string): boolean =>
    cleanByPath.get(repoPath) === true &&
    ![...cleanByPath.entries()].some(([childPath, isClean]) => childPath.startsWith(`${repoPath}/`) && !isClean) &&
    !dirty.some((entry) => entry.slice(3) === repoPath || entry.slice(3).startsWith(`${repoPath} `))

  // 34744 (@cto fa2ab09a): a clean component pin is discardable when it is an ancestor of the component's
  // remote-tracking main (B1's fast path) or, off main, when retained history rebuilds every commit it holds beyond
  // one captured main oid (reconstructibleFromMain). The second case is deliberately NOT "on main": its commits are
  // reported as discards, never treated as already there.
  const checkSubmodulePinDiscardable = async (
    repoPath: string,
    pinSha: string,
  ): Promise<
    | { clean: false }
    | { clean: true; discardable: true; reconstructed: readonly ReconstructedCommit[]; subGit: Git; root: string }
    | { clean: true; discardable: false; reason: string; subGit: Git; root: string }
  > => {
    const repo = repoByPath.get(repoPath)
    if (repo === undefined || repo.path === "." || !isSubmoduleClean(repoPath)) {
      return { clean: false }
    }
    const subGit = gitIn(repo.root, process, selection)
    const remoteMain = await refAt(subGit, "refs/remotes/origin/main")
    if (remoteMain === undefined) {
      return { clean: true, discardable: false, reason: "refs/remotes/origin/main is absent", subGit, root: repo.root }
    }
    if (await isAncestor(subGit, pinSha, remoteMain)) {
      return { clean: true, discardable: true, reconstructed: [], subGit, root: repo.root }
    }
    const replay = await reconstructibleFromMain(subGit, pinSha, remoteMain)
    return replay.kind === "reconstructible"
      ? { clean: true, discardable: true, reconstructed: replay.commits, subGit, root: repo.root }
      : { clean: true, discardable: false, reason: replay.reason, subGit, root: repo.root }
  }
  const offMainDirt = (repoPath: string, pin: string, reason: string) =>
    ` M ${repoPath} (submodule HEAD ${pin.slice(0, 12)} is not an ancestor of refs/remotes/origin/main, and retained history does not rebuild it: ${reason})`
  const discarded: DiscardedCommit[] = []
  const retainedComponents: { path: string; pin: string; gitDir: string }[] = []
  // 34787 (peer @dev/5 r2): retaining instead of judging is safe only for a store that outlives the checkout: one under
  // this environment's admin modules (git-super's retained copy holds it) or one outside both the checkout and the
  // admin dir (the removal never touches it). A store embedded in the checkout goes with it, so it keeps the old
  // judgment. Answers the component's absolute git dir, or undefined when its store does not survive.
  let envAdmin: string | undefined
  const survivingStore = async (componentGit: ReturnType<typeof gitIn>): Promise<string | undefined> => {
    envAdmin ??= canonicalPath((await treeGit(["rev-parse", "--absolute-git-dir"])).trim())
    const gitDir = (await componentGit(["rev-parse", "--absolute-git-dir"])).trim()
    const real = canonicalPath(gitDir)
    if (pathWithin(join(envAdmin, "modules"), real)) return gitDir
    return pathWithin(canonicalPath(path), real) || pathWithin(envAdmin, real) ? undefined : gitDir
  }
  // 34744 (@cto R5): a component's own off-main commits are named in the close receipt by repo, sha and subject,
  // with the component path and pin, once each.
  const discardComponentCommits = (repoPath: string, pin: string, commits: readonly ReconstructedCommit[]) => {
    for (const commit of commits) {
      if (discarded.some((entry) => entry.repo === repoPath && entry.sha === commit.sha)) continue
      discarded.push({ repo: repoPath, ...commit, gitlinks: [{ path: repoPath, pin }] })
    }
  }

  const admissibleGitlinks: AdmissibleGitlink[] = []
  for (const repo of status.consultedRepositories) {
    if (repo.path === ".") continue
    const parent =
      status.consultedRepositories.findLast(
        (candidate) =>
          candidate.path !== "." && candidate.path !== repo.path && repo.path.startsWith(`${candidate.path}/`),
      ) ?? status.consultedRepositories.find((candidate) => candidate.path === ".")
    const parentGit = parent === undefined || parent.path === "." ? treeGit : gitIn(parent.root, process, selection)
    const relInParent =
      parent === undefined || parent.path === "." ? repo.path : repo.path.slice(parent.path.length + 1)
    let headPin: string | undefined
    try {
      const parsed = (await parentGit(["rev-parse", "--verify", "--quiet", `HEAD:${relInParent}`])).trim()
      if (parsed !== "") headPin = parsed
    } catch {
      headPin = undefined
    }
    if (headPin === undefined) continue
    const subGit = gitIn(repo.root, process, selection)
    const subHead = (await subGit(["rev-parse", "--verify", "HEAD^{commit}"])).trim()
    if (subHead === headPin) continue
    // 34787 (@cto 34787-component-retention-ruling): on an owner's close a clean component moved past its gitlink is
    // neither judged by remote ancestry nor re-aligned. It stays at its own HEAD, and git-super's retention admits that
    // selection only as part of its verified retained copy, which keeps the HEAD and its history.
    const movedStore = retainComponents && isSubmoduleClean(repo.path) ? await survivingStore(subGit) : undefined
    if (movedStore !== undefined) {
      if (!retainedComponents.some((entry) => entry.path === repo.path)) {
        retainedComponents.push({ path: repo.path, pin: subHead, gitDir: movedStore })
      }
      continue
    }
    const check = await checkSubmodulePinDiscardable(repo.path, subHead)
    if (!check.clean) continue
    if (check.discardable) {
      discardComponentCommits(repo.path, subHead, check.reconstructed)
      const currentBranch = (await check.subGit(["branch", "--show-current"])).trim()
      admissibleGitlinks.push({
        path: repo.path,
        root: check.root,
        headPin,
        previousHead: subHead,
        ...(currentBranch === "" ? {} : { previousBranch: currentBranch }),
      })
    } else {
      dirty.push(offMainDirt(repo.path, subHead, check.reason))
    }
  }
  let heldOn: EnvironmentCloseState["heldOn"]
  if (detached) {
    const originMain = await refAt(treeGit, "refs/remotes/origin/main")
    if (originMain !== undefined) {
      // 34744: one HEAD read, so the ahead list, the diff and the replay judge the same commit.
      const head = (await treeGit(["rev-parse", "--verify", "HEAD^{commit}"])).trim()
      const aheadLog = (await treeGit(["log", "--format=%H\t%s", `${originMain}..${head}`])).trim()
      // 33555: content ahead is judged against every ref a person keeps work on: branches, remote-tracking refs and
      // tags. A remote-tracking ref means "on the remote as of the last fetch"; no fetch is done here. Yrd's and
      // gitomic's private namespaces never count: they are pruned on their own schedule, so a commit only they hold
      // is not kept. When every ahead commit is held elsewhere, nothing is lost: no dirt, no discard record.
      const unique =
        aheadLog === "" ? "" : (await treeGit(["rev-list", head, "--not", "--branches", "--remotes", "--tags"])).trim()
      if (aheadLog !== "" && unique === "") {
        const holder = (
          await treeGit([
            "for-each-ref",
            "--count=1",
            "--contains=HEAD",
            "--format=%(refname)",
            "refs/heads/",
            "refs/remotes/",
            "refs/tags/",
          ])
        ).trim()
        if (holder === "") {
          throw new Error(`${path}: rev-list found HEAD's ahead commits on a ref, for-each-ref names none`)
        }
        heldOn = { ref: holder, commits: aheadLog.split("\n").length }
      } else if (aheadLog !== "") {
        const aheadCommits = aheadLog.split("\n").map((line) => {
          const tab = line.indexOf("\t")
          return tab < 0
            ? { sha: line.trim(), subject: "" }
            : { sha: line.slice(0, tab).trim(), subject: line.slice(tab + 1) }
        })
        const mergeBase = (await treeGit(["merge-base", head, originMain])).trim()
        const rawDiff = (await treeGit(["diff", "--raw", "--no-abbrev", mergeBase, head])).trim()
        if (rawDiff === "") {
          discarded.push(...aheadCommits)
        } else {
          const rawLines = rawDiff.split("\n")
          const discardedGitlinks: DiscardedGitlink[] = []
          const componentDiscards: Array<{ path: string; pin: string; commits: readonly ReconstructedCommit[] }> = []
          let allAdmissibleGitlinks = true
          // 34744 (@cto fa2ab09a): a non-gitlink change ahead of main is admissible only when retained history rebuilds
          // every root commit ahead of the one captured originMain. That replay never vouches for a component's
          // contents: each moved gitlink below still needs its own clean, discardable pin.
          let rootReplay: Reconstruction | undefined
          for (const line of rawLines) {
            const tab = line.indexOf("\t")
            if (tab < 0) {
              allAdmissibleGitlinks = false
              continue
            }
            const meta = line.slice(0, tab).trim().split(" ")
            const gitlinkPath = line.slice(tab + 1).trim()
            const [oldMode, newMode, , newOid, statusCode] = meta
            if (oldMode !== ":160000" && newMode !== "160000") {
              rootReplay ??= await reconstructibleFromMain(treeGit, head, originMain)
              if (rootReplay.kind !== "reconstructible") allAdmissibleGitlinks = false
              continue
            }
            if (
              oldMode !== ":160000" ||
              newMode !== "160000" ||
              statusCode !== "M" ||
              newOid === undefined ||
              newOid === "" ||
              gitlinkPath === "" ||
              gitlinkPath.includes("\t")
            ) {
              allAdmissibleGitlinks = false
              continue
            }
            // 34787 (@cto 34787-component-retention-ruling): on an owner's close, a clean component that sits at exactly
            // this gitlink, with a store that outlives the checkout (survivingStore), is not judged here at all.
            // git-super's retained copy holds its HEAD and history, and that copy's own custody check decides when it
            // may be retired, so remote ancestry alone no longer blocks. Dirt and an embedded store keep the judgment
            // below; a component moved past its gitlink is handled by the moved-selection rule above.
            if (retainComponents) {
              const repo = repoByPath.get(gitlinkPath)
              if (repo === undefined || repo.path === "." || !isSubmoduleClean(gitlinkPath)) {
                allAdmissibleGitlinks = false
                continue
              }
              const componentGit = gitIn(repo.root, process, selection)
              const componentHead = (await componentGit(["rev-parse", "--verify", "HEAD^{commit}"])).trim()
              const gitDir = componentHead === newOid ? await survivingStore(componentGit) : undefined
              if (gitDir !== undefined) {
                if (!retainedComponents.some((entry) => entry.path === gitlinkPath)) {
                  retainedComponents.push({ path: gitlinkPath, pin: newOid, gitDir })
                }
                discardedGitlinks.push({ path: gitlinkPath, pin: newOid })
                continue
              }
            }
            const check = await checkSubmodulePinDiscardable(gitlinkPath, newOid)
            if (!check.clean) {
              allAdmissibleGitlinks = false
              continue
            }
            if (!check.discardable) {
              allAdmissibleGitlinks = false
              const offMainMsg = offMainDirt(gitlinkPath, newOid, check.reason)
              if (!dirty.includes(offMainMsg)) {
                dirty.push(offMainMsg)
              }
              continue
            }
            discardedGitlinks.push({ path: gitlinkPath, pin: newOid })
            componentDiscards.push({ path: gitlinkPath, pin: newOid, commits: check.reconstructed })
          }
          const rootRebuilt = rootReplay?.kind === "reconstructible"
          if (allAdmissibleGitlinks && (discardedGitlinks.length > 0 || rootRebuilt)) {
            for (const entry of aheadCommits) {
              discarded.push(discardedGitlinks.length === 0 ? entry : { ...entry, gitlinks: discardedGitlinks })
            }
            for (const component of componentDiscards) {
              discardComponentCommits(component.path, component.pin, component.commits)
            }
          } else {
            const notRebuilt =
              rootReplay?.kind === "refused" ? `; retained history does not rebuild it: ${rootReplay.reason}` : ""
            for (const entry of aheadCommits) {
              dirty.push(
                `detached HEAD is ahead of origin/main with content changes at ${entry.sha.slice(0, 12)} (${entry.subject})${notRebuilt}`,
              )
              rootAheadContent++
            }
          }
        }
      }
    }
  }
  return {
    dirty,
    discarded,
    admissibleGitlinks,
    rootAheadContent,
    retainedComponents,
    ...(heldOn === undefined ? {} : { heldOn }),
  }
}

/** One status read shared by `env open`'s existing-bay cleanliness check. */
async function environmentDirt(git: Git): Promise<readonly string[]> {
  const dirty = (await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])).trim()
  return dirty === "" ? [] : dirty.split("\n")
}

/** Refuse before reusing an existing bay in `env open`; a dirty tree is work, not garbage. */
async function requireClean(git: Git, path: string, hint = ""): Promise<void> {
  const dirty = await environmentDirt(git)
  if (dirty.length > 0) {
    throw new Error(
      `environment ${path} is dirty; preserve or commit these changes before continuing${hint}:\n${dirty.join("\n")}`,
    )
  }
}

/**
 * 33555 (@cto 5a8ec5a1, a5953bad, 71c8125b): the extra clause a detached refusal carries when the environment's
 * recorded issue was dropped, so the generic `git switch -c task/<issue>` route would re-create a branch the drop
 * removed. It names that route with the real branch, path and head, and the recorded discard that runs after it.
 * Drop state changes only this wording, never the refusal. A failed issue read adds one clause saying why and
 * changes nothing else. Read on the refusal path only.
 */
async function droppedIssueRoutes(path: string, treeGit: Git, head: string, root: string): Promise<string> {
  const opening = readEnvOpenRecord((await treeGit(["rev-parse", "--absolute-git-dir"])).trim())
  const issue = opening.status === "recorded" ? opening.record.issue : undefined
  if (opening.status !== "recorded" || issue === undefined || issue === "") return ""
  const state = await readEnvIssueState({ issue, projectRoot: root, cwd: root, timeoutMs: ISSUE_DISPLAY_TIMEOUT_MS })
  if (state.kind === "keep") return state.unreadable === true ? `; ${state.reason}` : ""
  if (state.kind !== "dropped") return ""
  const branch = `task/${opening.record.bay ?? issue}`
  return (
    `; issue ${issue} was dropped and its branch is gone. To keep this exact state: ` +
    `git -C ${shellQuote(path)} switch -c ${branch}, then yrd env close ${shellQuote(path)} --preserve ` +
    `(re-creates the dropped branch). To discard on purpose, recorded: do that, then ` +
    `yrd drop ${branch} --local --discard --tip ${head} --reason <why> ` +
    `(removes the local name only; the branch --preserve pushed stays on origin until deleted there)`
  )
}

/** Refuse before running user teardown; a dirty tree is work, not garbage. */
async function requireCleanState(
  state: EnvironmentCloseState,
  path: string,
  detached: boolean,
  dropped: () => Promise<string>,
): Promise<void> {
  if (state.dirty.length > 0) {
    // 34764: root content commits alone need only a branch; the close then keeps them on it (attached root commits are
    // not dirt). Never offered when a component or uncommitted entry is also dirty: a branch keeps neither.
    const rootOnly = detached && state.rootAheadContent > 0 && state.rootAheadContent === state.dirty.length
    const hint = rootOnly
      ? ` — the only dirt is root commits ahead of origin/main, so a branch keeps them: name one (git -C ${shellQuote(path)} switch -c task/<issue>), then run yrd env close ${shellQuote(path)} again, which keeps them on that branch${await dropped()}`
      : detached
        ? ` — or attach a branch first (git switch -c task/<issue>, then --preserve) to keep this exact state in a durable ref${await dropped()}`
        : " — or re-run with --preserve to keep this exact state in a durable ref first"
    throw new Error(
      `environment ${path} is dirty; preserve or commit these changes before continuing${hint}:\n${state.dirty.join("\n")}`,
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
  /** `preserve --check` passed and wrote nothing (33552); false on every real preserve receipt. */
  checked: boolean
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
  // 33552: only a check receipt carries `checked`; absence is a real preserve's receipt, or a CLI before --check.
  if (record.checked !== undefined && typeof record.checked !== "boolean") {
    throw receiptRefusal(cli, "checked", "expected a boolean when present")
  }
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
    checked: record.checked === true,
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
  if (receipt.checked) {
    throw new Error(
      `env close --preserve: the worktree preserve CLI ${cli} answered a real preserve with a check receipt (checked:true, nothing written); ${stderrContext}; the environment was NOT removed`,
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

/** bearly tools/worktree.ts `PRESERVE_REFUSED_EXIT`, mirrored like the nothing exit: `preserve --check` would refuse. */
const WORKTREE_PRESERVE_REFUSED_EXIT = 4

/** The planner's exact refusal when a worktree CLI predates `preserve --check` (bearly planCliInvocation). */
const WORKTREE_PRESERVE_CHECK_UNKNOWN = "Unknown flag for preserve: --check"

export type EnvironmentPreserveCheck =
  | { readonly kind: "would-preserve" | "nothing" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "old-tool"; readonly cli: string }

/**
 * 33552: ask the worktree CLI's `preserve --check`, which runs the real preserve's selection and validation and writes
 * nothing, whether a real preserve would refuse now. A check is not a promise: the real preserve still runs and decides.
 * An old CLI without the flag is named and reads as neither success nor refusal; any other ending fails the close.
 */
export async function checkEnvironmentPreserve(
  runner: Process,
  root: string,
  path: string,
): Promise<EnvironmentPreserveCheck> {
  const cli = worktreePreserveCliPath(root)
  if (!existsSync(cli)) {
    throw new Error(
      `env close --preserve needs the worktree preserve CLI at ${cli}; it is absent, so the preserve was NOT run and the environment was NOT removed`,
    )
  }
  let result: Awaited<ReturnType<Process["run"]>>
  try {
    result = await runner.run({ argv: ["bun", cli, "preserve", path, "--json", "--check"], cwd: root })
  } catch (error) {
    throw new Error(
      `env close --preserve could not run the worktree preserve check ${cli}: ${error instanceof Error ? error.message : String(error)}; the environment was NOT removed`,
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
      `env close --preserve: the worktree preserve check ${cli} did not settle cleanly: ${JSON.stringify(result)}; the environment was NOT removed`,
    )
  }
  const stderr = result.stderr.trimEnd()
  if (result.exitCode === 1 && stderr.includes(WORKTREE_PRESERVE_CHECK_UNKNOWN)) return { kind: "old-tool", cli }
  if (result.exitCode === WORKTREE_PRESERVE_REFUSED_EXIT) {
    return { kind: "refused", message: stderr.split(/\r?\n/u).slice(-20).join("\n").slice(-4096) || "(empty stderr)" }
  }
  const stderrContext = `stderr tail (last 20 lines, max 4096 characters): ${stderr.split(/\r?\n/u).slice(-20).join("\n").slice(-4096) || "(empty stderr)"}`
  if (result.exitCode !== 0 && result.exitCode !== WORKTREE_PRESERVE_NOTHING_EXIT) {
    throw new Error(
      `env close --preserve: the worktree preserve check ${cli} exited ${String(result.exitCode)} (expected 0, ${WORKTREE_PRESERVE_NOTHING_EXIT} or ${WORKTREE_PRESERVE_REFUSED_EXIT}); ${stderrContext}; the environment was NOT removed`,
    )
  }
  let receipt: WorktreePreserveReceipt
  try {
    receipt = parseWorktreePreserveReceipt(result.stdout, cli)
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; preserve check exited ${String(result.exitCode)}; ${stderrContext}`,
      {
        cause: error,
      },
    )
  }
  if (receipt.preserved || receipt.checked !== (result.exitCode === 0)) {
    throw new Error(
      `env close --preserve: the worktree preserve check ${cli} exited ${String(result.exitCode)} with preserved:${String(receipt.preserved)} checked:${String(receipt.checked)} (a check writes nothing: expected checked:true on 0, checked:false on ${WORKTREE_PRESERVE_NOTHING_EXIT}); ${stderrContext}; the environment was NOT removed`,
    )
  }
  return { kind: result.exitCode === 0 ? "would-preserve" : "nothing" }
}

/**
 * The registered environment an operand names (`env close` and `env bind` share it). 34404: every operand
 * refusal names the operand as the caller typed it, and shows the cwd resolution only when the two differ.
 * `env close 34056-peer` (2026-11-14) otherwise reported /hh/dev/34056-peer — a path nobody typed, in the
 * shared projection — because the bay name resolved against the caller's cwd. The accepted form is already
 * documented on the command as `<path>`, so the message states it instead of implying the caller asked for the
 * directory the resolution happened to produce. Only a worktree registered in this repository AND inside an
 * environment root qualifies: shared main and any other checkout are refused by name.
 */
async function resolveEnvironmentOperand(
  operand: string,
  io: YrdCliIO,
  git: Git,
  root: string,
  roots: readonly string[],
  verb: "close" | "bind",
): Promise<Readonly<{ path: string; registered: Awaited<ReturnType<typeof registeredWorktrees>>[number] }>> {
  const requested = resolve(io.cwd, operand)
  const atOperand = requested === operand ? operand : `${operand} (resolved ${requested})`
  let path: string
  try {
    path = realpathSync(requested)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
      throw error
    }
    throw new Error(
      `environment ${atOperand} is not registered at an existing path; env ${verb} takes the environment path, as \`yrd env open\` prints it — inspect git worktree list before retrying`,
      { cause: error },
    )
  }
  const registered = (await registeredWorktrees(git)).find((entry) => resolve(entry.path) === path)
  if (registered === undefined) {
    throw new Error(
      `environment ${atOperand} is not registered in ${root}; pass the environment path \`yrd env open\` printed, or inspect git worktree list`,
    )
  }
  const contained = roots.some((directory) => {
    if (!existsSync(directory)) return false
    const within = relative(realpathSync(directory), path)
    return within !== "" && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within)
  })
  if (!contained) {
    throw new Error(
      verb === "close"
        ? `environment ${path} is outside environment roots ${roots.join(" or ")}; nothing was removed. Retire a worktree outside these roots with your repository's own worktree cleanup (git worktree remove), not yrd env close`
        : `environment ${path} is outside environment roots ${roots.join(" or ")}; nothing was bound. yrd env bind binds only an environment yrd env open made`,
    )
  }
  return { path, registered }
}

export type EnvBindOptions = Readonly<{ issue?: string; dryRun?: boolean; json?: boolean }>

/**
 * `yrd env bind <path> --issue <ref>` (#34855): bind a registered environment's attached task branch to an
 * issue with the same Refs commit `yrd env open --issue` writes, through the one writer. It is the supported
 * route for a dirty environment that carries no binding: no clean-tree precondition and no close census (it
 * removes nothing), and a worktree lock that protects removal does not stop the owner binding its own work.
 * Only this repository's branch moves; a component's binding is its own. `--dry-run` makes the same decision
 * and writes nothing.
 */
export async function bindEnvironment(operand: string, options: EnvBindOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const issue = options.issue
  if (issue === undefined) {
    throw new Error(`yrd env bind ${operand} needs --issue <ref>: the issue whose Refs commit binds the branch`)
  }
  const root = requireRepository(io)
  await using process = createProcess({ cwd: root })
  const selection = await resolveGitSelection(root, { process })
  const git = gitIn(root, process, selection)
  const workdir = resolve(root, await workdirOf(git))
  const roots = [baysRootOf(root), legacyBaysRoot(root), join(workdir, "environments")]
  const { path } = await resolveEnvironmentOperand(operand, io, git, root, roots, "bind")
  const treeGit = gitIn(path, process, selection)
  // `--symbolic-full-name HEAD` answers `HEAD` when detached and exits 0, so any failure here is a real Git error.
  const ref = (await treeGit(["rev-parse", "--symbolic-full-name", "HEAD"])).trim()
  const target = await originHead(git)
  if (!ref.startsWith("refs/heads/") || ref === "refs/heads/") {
    throw new Error(
      `environment ${path} has a detached HEAD; yrd env bind binds an attached task branch, so nothing was bound`,
    )
  }
  const branch = ref.slice("refs/heads/".length)
  if (branch === target || branch === "main") {
    throw new Error(`environment ${path} is on ${branch}, the target branch, not a task branch; nothing was bound`)
  }
  const elsewhere = (await registeredWorktrees(git)).find(
    (entry) => entry.branch === branch && resolve(entry.path) !== path,
  )
  if (elsewhere !== undefined) {
    throw new Error(
      `${branch} is also checked out at ${elsewhere.path}; bind it where its owner works, so nothing was bound here`,
    )
  }
  const head = (await treeGit(["rev-parse", "HEAD"])).trim()
  const base = (await resolveBaseSha(git, target, io)).sha
  await requireResolvableIssue(root, issue, io, git, {
    verb: "bind",
    retry: ["env", "bind", path, "--issue", issue],
    unwritten: `no Refs commit was written and ${branch} did not move`,
  })
  const outcome = await bindBranchToIssue({
    git: treeGit,
    branch,
    head,
    target: base,
    issue,
    sameIssue: issueComparer({ projectRoot: root, cwd: root, stderr: (text) => io.stderr(text) }),
    verb: "bind",
    ...(options.dryRun === true ? { dryRun: true } : {}),
  })
  if (outcome.wrote) announceBinding(io, branch, outcome.issue, "bind")
  const said = outcome.wrote
    ? `bound ${branch} to ${outcome.issue}: ${outcome.previousHead} -> ${outcome.head}`
    : outcome.wouldWrite
      ? `would bind ${branch} to ${outcome.issue} with a Refs commit on ${outcome.head} (dry run; nothing was written)`
      : `${branch} is already bound to ${outcome.issue}${outcome.bindingCommit === undefined ? "" : ` at ${outcome.bindingCommit}`}; head ${outcome.head}; nothing was written`
  if (options.json === true) {
    io.stdout(
      `${JSON.stringify({
        path,
        branch,
        issue: outcome.issue,
        head: outcome.head,
        previousHead: outcome.previousHead,
        wrote: outcome.wrote,
        dryRun: options.dryRun === true,
        wouldWrite: outcome.wouldWrite,
        ...(outcome.bindingCommit === undefined ? {} : { bindingCommit: outcome.bindingCommit }),
      })}\n`,
    )
  } else io.stdout(`${path}: ${said}\n`)
  return 0
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
  /** Public execution context; internal census and proof transport remain private. */
  context?: CloseExecutionContext,
): Promise<YrdCliExitCode> {
  if (context !== undefined) closeWorkRemaining(context.budget)
  const root = requireRepository(io)
  await using owner = createProcess({ cwd: root })
  // One owner, with its existing run capability forwarding the shared lifetime to every child.
  const process: Process =
    context === undefined
      ? owner
      : {
          ...owner,
          run: (request) => {
            const remaining = closeWorkRemaining(context.budget)
            return owner.run({
              ...request,
              signal:
                request.signal === undefined
                  ? context.budget.signal
                  : AbortSignal.any([request.signal, context.budget.signal]),
              timeoutMs: Math.max(1, Math.floor(Math.min(request.timeoutMs ?? remaining, remaining))),
            })
          },
        }
  const selection = await resolveGitSelection(root, { process })
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
  const { path, registered } = await resolveEnvironmentOperand(operand, io, git, root, roots, "close")
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
    await assertNoPrivateStore(context === undefined ? createLocalGitProcess() : adaptProcessGit(process), {
      adminDir,
      repository: path,
      head: commit,
    })
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
  await assertNoLiveEnvironmentUse(path, io, context?.budget)
  const admission = await admitEnvironmentClose(path, io, censusSource, context?.budget)
  // 34777 (@cto 34777-preview-journal-go.md): a preview whose census is incomplete names that limit first, then keeps
  // running the read-only checks below, so an owner sees the next refusal without spending a queue round. It never
  // reads as admitted and still exits nonzero; it files no request and moves no ref. Any other refusal is unchanged.
  let uncertifiedPreview: Extract<CloseAdmission, { kind: "needs-delegation" }> | undefined
  if (admission.kind === "needs-delegation" && options.dryRun === true) {
    uncertifiedPreview = admission
    io.stderr(
      `yrd: env close --dry-run ${path}: not certified: ${admission.refusal} (${censusReaderLine(admission.census)}); ` +
        `this preview files no request, and a real close from here would file a queue close request instead; ` +
        `the read-only checks below still run\n`,
    )
  } else if (admission.kind === "needs-delegation") {
    if (onIncompleteCensus === "refuse") {
      throw uncertified(path, admission, "", context === undefined ? undefined : { json: options.json === true, io })
    }
    return queueDelegatedClose(path, options, io, workdir, commit, admission)
  }
  const detached = registered.branch === undefined
  // 34787: the automatic sweep and a queued delivery ending ask for component custody proof at removal (21122) and keep
  // the refusal; an owner's close retains a clean component instead.
  const retainComponents = options.componentCustody === undefined
  let closeState = await inspectEnvironmentCloseState(path, treeGit, process, selection, detached, retainComponents)
  // 34787 (@cto 34787-component-retention-ruling correction 3): what this retention is for, recorded opaquely in
  // git-super's manifest before git deletes the opening record with the worktree, read here while the
  // environment certainly exists (before any concurrent-removal checkpoint). The actor is the caller as yrd
  // knows it (the launched seat, else "unknown"); it is never the owner. No yrd ownership evidence exists yet, so
  // the owner stays null (unknown), never inferred from the path, the issue or the closer. The opening record
  // supplies the issue and the entry's own metadata only when present.
  const opening = readEnvOpenRecord((await treeGit(["rev-parse", "--absolute-git-dir"])).trim())
  const attribution: Record<string, string | null> = {
    actor: requesterOf(globalThis.process.env),
    owner: null,
    ...(opening.status === "recorded"
      ? {
          openedAt: opening.record.at,
          lifetime: opening.record.lifetime,
          ...(opening.record.issue === undefined ? {} : { issue: opening.record.issue }),
          ...(opening.record.bay === undefined ? {} : { bay: opening.record.bay }),
        }
      : { opening: opening.why }),
  }
  const dropped = (): Promise<string> => droppedIssueRoutes(path, treeGit, commit, root)
  if (closeState.heldOn !== undefined) {
    io.stderr(
      `yrd: env close: the detached HEAD ${commit}'s ${closeState.heldOn.commits} commit(s) ahead of origin/main are all on ${closeState.heldOn.ref} (remote-tracking refs as of the last fetch); nothing to keep, so no ref is written\n`,
    )
  }
  // Both saves use the same worktree preserve operation. Keep custody from the
  // first pass even if the second pass reports no changes.
  const preservedRefs: string[] = []
  const custody: Array<{ path: string; ref: string; sha: string; remote: string }> = []
  const custodyRemotes = new Map<string, string>()
  // 29406: the repositories the preserve consulted and skipped, named in the --json close receipt
  // below; undefined when no preserve ran, so the plain close receipt is unchanged.
  let skipped: WorktreePreserveReceipt["skipped"] | undefined
  // The preserve and its early check (33552) both skip on this one predicate: a detached root with no dirt whose only
  // ahead commits are empty (closeState.discarded: no content to keep) or admissible gitlink moves (each pin is
  // reachable in its own component). The close proceeds and records them as discards. The worktree tool answers these
  // differently on purpose: asked, its preserve --check would say "needs preserve" and refuse a detached root, so yrd
  // does not ask.
  const preserveSkipped = (): boolean =>
    detached &&
    closeState.dirty.length === 0 &&
    (closeState.discarded.length > 0 ||
      closeState.admissibleGitlinks.length > 0 ||
      closeState.retainedComponents.length > 0 ||
      closeState.heldOn !== undefined)
  const preserve = async (phase: "before teardown" | "after teardown"): Promise<void> => {
    if (preserveSkipped()) {
      io.stderr(`yrd: env close --preserve found nothing to preserve in ${path} ${phase}; the close proceeds\n`)
      return
    }
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
    // 33552: ask the real preserve, before any ref moves and in the preview and the call alike, whether it would
    // refuse now. Same cases refuse as before; earlier, and with the next step. The real preserve below still decides.
    if (!preserveSkipped()) {
      const check = await checkEnvironmentPreserve(process, root, path)
      if (check.kind === "old-tool") {
        io.stderr(
          `yrd: env close --preserve: the worktree CLI ${check.cli} predates preserve --check, so no early check ran; the preserve itself still decides\n`,
        )
      } else if (check.kind === "refused") {
        throw new Error(
          `environment ${path}: --preserve would fail; a real preserve refuses now: ${check.message}${detached ? `; to keep this exact state, attach a branch first (git switch -c task/<issue>, then --preserve)${await dropped()}` : ""}; nothing was written and the environment was kept`,
        )
      }
    }
    if (options.dryRun !== true) await preserve("before teardown")
  } else {
    await requireCleanState(closeState, path, detached, dropped)
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
    const certified = uncertifiedPreview === undefined
    // 34777 (@dev/review2 nit 2, @chief cb6a790f): with no host reader wired, assertNoLiveEnvironmentUse checks nothing,
    // so live-use is listed as not checked rather than passed.
    const liveUseChecked = io.liveEnvironmentUse !== undefined
    const preview = {
      dryRun: true,
      path,
      head: commit,
      admitted: certified,
      checked: [
        "registration",
        "roots",
        "lock",
        "private-content",
        ...(liveUseChecked ? ["live-use"] : []),
        ...(certified ? ["census"] : []),
        options.preserve === true ? "preserve" : "clean",
      ],
      notChecked: [
        ...(liveUseChecked ? [] : ["live-use"]),
        ...(certified ? [] : ["census"]),
        "component-custody",
        "retention",
        "remote-reread",
        "teardown",
      ],
      ...(uncertifiedPreview === undefined
        ? {}
        : {
            notCertified: {
              reason: uncertifiedPreview.refusal,
              reader: censusReaderLine(uncertifiedPreview.census),
            },
          }),
      preserve: {
        requested: options.preserve === true,
        dirty: options.preserve === true ? closeState.dirty : [],
      },
      teardown: config?.teardown ?? null,
      liveEnvironmentUseChecked: liveUseChecked,
    }
    if (options.json === true) io.stdout(`${JSON.stringify(preview)}\n`)
    else {
      io.stdout(
        uncertifiedPreview === undefined
          ? `dry-run: ${path} would be admitted; component custody, retention and teardown are proved only by the real close.\n`
          : `dry-run: ${path} is not certified (${uncertifiedPreview.refusal}); the other read-only checks passed ` +
              `(${preview.checked.join(", ")}); census, component custody, retention and teardown remain unproved.\n`,
      )
      io.stdout(
        `preserve: ${preview.preserve.requested ? JSON.stringify(preview.preserve.dirty) : "not requested"}\nteardown: ${preview.teardown ?? "(none)"}\n`,
      )
    }
    if (uncertifiedPreview !== undefined) {
      throw uncertified(path, uncertifiedPreview, "in preview; a real close would file a queue close request instead")
    }
    return 0
  }
  const admittedAt = Date.now()
  const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  const retentionRoot =
    options.retain === undefined ? join(workdir, "retained-modules") : resolve(io.cwd, options.retain)
  const concurrentClose = async (error: unknown): Promise<boolean> => {
    // Both queue routes use refuse mode; the request pass can omit the typed callback.
    // Only the direct manual route may recognize a competing removal from a narrowed lookup.
    if (onIncompleteCensus !== "delegate" || removedProof !== undefined || existsSync(path)) return false
    const inspected: string[] = []
    const details: string[] = []
    const keep = (): false => {
      const note = `concurrent retirement not proved for ${path}@${commit}; retention root ${retentionRoot}; inspected manifests ${JSON.stringify(inspected)}${details.length === 0 ? "" : `\n${details.join("\n")}`}`
      io.stderr(`yrd: ${note}\n`)
      if (error instanceof Error) error.message += `\n${note}`
      return false
    }
    try {
      if ((await registeredWorktrees(git)).some((entry) => resolve(entry.path) === path)) return keep()
      if (existsSync(retentionRoot)) {
        for (const child of readdirSync(retentionRoot, { withFileTypes: true })) {
          if (!child.isDirectory() || !child.name.startsWith(`${basename(path)}-`)) continue
          const entry = join(retentionRoot, child.name)
          const manifest = join(entry, "manifest.json")
          inspected.push(manifest)
          const rebuilt = rebuildRetainedCopyProof(entry, retentionRoot)
          if (typeof rebuilt === "string") {
            details.push(`${manifest}: ${rebuilt}`)
            continue
          }
          // Native writer: git-super/src/worktree-removal.ts writes WorktreeRemovalProof.head/createdAt
          // into this same manifest. The GitSuper contract test pins these stored field names (30783).
          const stored = rebuilt.stored
          if (
            rebuilt.path !== path ||
            rebuilt.modules !== join(adminDir, "modules") ||
            stored.head !== commit ||
            typeof stored.createdAt !== "string" ||
            !(Date.parse(stored.createdAt) > admittedAt) ||
            !Array.isArray(stored.notCompared) ||
            stored.notCompared.length !== 0
          ) {
            details.push(`${manifest}: identity, admission time or repository coverage does not match`)
            continue
          }
          const verified = await verifyRetainedCopy(rebuilt, common)
          if (verified.status !== "ok") {
            details.push(`${manifest}: ${JSON.stringify(verified)}`)
            continue
          }
          if (existsSync(path) || (await registeredWorktrees(git)).some((entry) => resolve(entry.path) === path)) {
            return keep()
          }
          if (details.length > 0) io.stderr(`yrd: concurrent close inspection\n${details.join("\n")}\n`)
          io.stderr(
            `yrd: concurrent close verified ${path}@${commit} through ${manifest}; branch retirement outcome was not observed\n`,
          )
          io.stdout(
            options.json === true
              ? `${JSON.stringify({ closed: path, retirement: "incomplete" })}\n`
              : `closed environment ${path}; concurrent removal verified; branch retirement outcome was not observed\n`,
          )
          return true
        }
      }
    } catch (inspectionError) {
      details.push(
        `proof inspection failed: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}`,
      )
    }
    return keep()
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
    closeState = await inspectEnvironmentCloseState(path, treeGit, process, selection, detached, retainComponents)
    if (options.preserve !== true) {
      await requireCleanState(closeState, path, detached, dropped)
    } else {
      await preserve("after teardown")
    }
  }
  // A captured retirement handle can delete an unchanged author tip after
  // removal. Any custody pass retains every author branch, so capture only for
  // the ordinary clean close with no preservation ref.
  const retirement =
    preservedRefs.length === 0
      ? await prepareAuthorRelease(path, io, { process, ...(context === undefined ? {} : { budget: context.budget }) })
      : undefined
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
  let modules: string
  try {
    modules = await treeGit(["ls-tree", commit, "--", ".gitmodules"])
  } catch (error) {
    if (await concurrentClose(error)) return 0
    throw error
  }
  const recheck = await admitEnvironmentClose(path, io, censusSource, context?.budget)
  if (recheck.kind === "needs-delegation") {
    // Teardown already ran, so delegating now would run it twice in a context
    // that cannot tell what this one did. Refuse loudly and preserve instead.
    throw uncertified(
      path,
      recheck,
      "after teardown",
      context === undefined ? undefined : { json: options.json === true, io },
    )
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
  const cleanupRemainder: string[] = []
  if (
    modules.trim() !== "" ||
    options.retain !== undefined ||
    options.noRehome === true ||
    options.preserve === true ||
    options.componentCustody !== undefined ||
    context !== undefined
  ) {
    const retain = options.retain === undefined ? join(workdir, "retained-modules") : resolve(io.cwd, options.retain)
    let removed: unknown
    await assertNoLiveEnvironmentUse(path, io, context?.budget)
    const alignedGitlinks: AdmissibleGitlink[] = []
    const restoreAlignedGitlinks = async (): Promise<void> => {
      for (const entry of [...alignedGitlinks].reverse()) {
        const subGit = gitIn(entry.root, process, selection)
        if (entry.previousBranch !== undefined) {
          await subGit(["checkout", "--quiet", entry.previousBranch])
        } else {
          await subGit(["checkout", "--quiet", "--detach", entry.previousHead])
        }
      }
      alignedGitlinks.length = 0
    }
    if (preservedRefs.length === 0) {
      for (const entry of closeState.admissibleGitlinks) {
        const subGit = gitIn(entry.root, process, selection)
        if ((await refAt(subGit, entry.headPin)) !== undefined) {
          await subGit(["checkout", "--quiet", "--detach", entry.headPin])
          alignedGitlinks.push(entry)
        }
      }
    }
    try {
      if (context !== undefined) {
        closeWorkRemaining(context.budget)
        let nativeProof: WorktreeRemovalProof | undefined
        const native = createGitWorktreeStore({
          repo: root,
          gitProcess: adaptProcessGit(process),
          signal: context.budget.signal,
          remainingMs: () => context.budget.remainingMs(),
          report: (line) => io.stderr(line),
        })
        const outcome = await native.remove(path, {
          retention: {
            root: retain,
            attribution,
            report: (proof) => {
              nativeProof = proof
            },
          },
          ...(options.noRehome === undefined ? {} : { noRehome: options.noRehome }),
          ...(options.componentCustody === undefined ? {} : { componentCustody: options.componentCustody }),
          preserved: preservedRefs,
          beforeRemove: async (target) => {
            closeWorkRemaining(context.budget)
            await context.beforeRemove?.(
              {
                name: basename(target.path),
                path: target.path,
                ...(target.head === undefined ? {} : { head: target.head }),
                ...(target.branch === undefined ? {} : { branch: target.branch.replace(/^refs\/heads\//u, "") }),
              },
              context.budget,
            )
            closeWorkRemaining(context.budget)
          },
        })
        removed =
          outcome !== undefined && "custodyRefusal" in outcome
            ? { state: "unchanged", path, reason: "component-custody", custody: outcome.custodyRefusal }
            : outcome !== undefined && "borrowers" in outcome
              ? { state: "unchanged", path, reason: "borrowed", borrowers: outcome.borrowers }
              : {
                  state: "updated",
                  path,
                  proof: nativeProof,
                  ...(outcome !== undefined && "compaction" in outcome ? { compaction: outcome.compaction } : {}),
                  ...(outcome !== undefined && "remainder" in outcome ? { remainder: outcome.remainder } : {}),
                }
      } else {
        const removalOutput = await git([
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
          "--attribution",
          JSON.stringify(attribution),
        ])
        // A successful git() records its result before resolving; failure throws before reaching here.
        // oxlint-disable-next-line typescript/no-non-null-assertion
        const removalStderr = git.lastInvocation!.result!.stderr
        if (removalStderr !== "") io.stderr(removalStderr)
        removed = JSON.parse(removalOutput)
      }
    } catch (error) {
      if (await concurrentClose(error)) return 0
      await restoreAlignedGitlinks()
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
      await restoreAlignedGitlinks()
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
      await restoreAlignedGitlinks()
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
      await restoreAlignedGitlinks()
      throw new Error(
        `environment ${path} received malformed git-super removal proof; inspect git worktree list and retention directory ${retain} before retrying`,
      )
    }
    if ("compaction" in removed) {
      const compaction = removed.compaction
      if (
        typeof compaction !== "object" ||
        compaction === null ||
        !("status" in compaction) ||
        typeof compaction.status !== "string" ||
        !["ok", "skipped", "failed"].includes(compaction.status)
      ) {
        throw new Error(`environment ${path} was removed but returned a malformed compaction result; inspect ${retain}`)
      }
      if (compaction.status === "failed") {
        if (
          !("child" in compaction) ||
          typeof compaction.child !== "string" ||
          compaction.child === "" ||
          !("step" in compaction) ||
          typeof compaction.step !== "string" ||
          compaction.step === ""
        ) {
          throw new Error(
            `environment ${path} was removed but its failed compaction names no child/step; inspect ${retain}`,
          )
        }
        cleanupRemainder.push(compaction.child)
        io.stderr(
          `yrd: removed-with-remainder; retained compaction remains at ${compaction.child}; failed step ${compaction.step}\n`,
        )
      }
    }
    if ("remainder" in removed) {
      if (!Array.isArray(removed.remainder)) {
        throw new Error(
          `environment ${path} was removed but returned malformed staging remainder paths; inspect ${retain}`,
        )
      }
      for (const entry of removed.remainder) {
        if (typeof entry !== "string" || entry === "") {
          throw new Error(
            `environment ${path} was removed but returned a malformed staging remainder path; inspect ${retain}`,
          )
        }
        cleanupRemainder.push(entry)
      }
    }
    removalProof = removed.proof as WorktreeRemovalProof
    io.stderr(`retained environment removal proof ${removalProof.manifest}\n`)
    io.stderr(`${retainedCloseLine(retain)}\n`)
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
  const discarded = closeState.discarded
  // 34787: where each retained component's commits now live: its store inside the removal proof's retained copy, or,
  // when its store was outside this environment's modules and still exists (never copied, never removed), that live
  // store. A store that was neither copied nor survived (embedded in the removed checkout) is never named: git-super
  // admits that one only on its own on-target proof, so its commits are on the component's remote (peer @dev/5 r1).
  const retainedCopy = removalProof?.retained ?? undefined
  const retainedReceipt = closeState.retainedComponents.flatMap((entry) => {
    const inside = relative(removalProof?.modules ?? "", entry.gitDir)
    const copied = retainedCopy !== undefined && inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)
    if (copied) return [{ path: entry.path, pin: entry.pin, store: join(retainedCopy, inside) }]
    if (existsSync(entry.gitDir)) return [{ path: entry.path, pin: entry.pin, store: entry.gitDir }]
    throw new Error(
      `environment ${path} was removed, but retained component ${entry.path}@${entry.pin.slice(0, 12)} is neither in the retained copy ${retainedCopy ?? "(none)"} nor at its store ${entry.gitDir}; inspect the retention directory before anything else`,
    )
  })
  io.stdout(
    options.json === true
      ? `${JSON.stringify({
          closed: path,
          ...(cleanupRemainder.length === 0 ? {} : { cleanup: "removed-with-remainder", remainder: cleanupRemainder }),
          ...(discarded.length === 0 ? {} : { discarded }),
          ...(retainedReceipt.length === 0 ? {} : { retained: retainedReceipt }),
          ...(skipped === undefined ? {} : { skipped }),
          ...(incomplete ? { retirement: "incomplete" } : {}),
          ...(failed.length > 0 ? { failed } : {}),
        })}\n`
      : `closed environment ${path}${cleanupRemainder.length === 0 ? "" : `; removed-with-remainder: ${cleanupRemainder.join(", ")}`}${discarded.length === 0 ? "" : `; discarded ${discarded.map((entry) => `${entry.sha.slice(0, 12)} (${entry.subject})${entry.gitlinks === undefined || entry.gitlinks.length === 0 ? "" : ` [${entry.gitlinks.map((g) => `${g.path}@${g.pin.slice(0, 12)}`).join(", ")}]`}`).join(", ")}`}${retainedReceipt.length === 0 ? "" : `; retained ${retainedReceipt.map((entry) => `${entry.path}@${entry.pin.slice(0, 12)} in ${entry.store}`).join(", ")}`}${failed.length > 0 ? `; branch retirement failed: ${failed.join("; ")}` : ""}\n`,
  )
  // The environment is gone either way; a failed retirement left a branch behind, so the close is not a success (30642).
  return failed.length > 0 || (incomplete && removalProof === undefined) ? 1 : 0
}

/** The loud refusal a queue-round caller makes when its own census cannot certify. */
function uncertified(
  path: string,
  admission: Extract<CloseAdmission, { kind: "needs-delegation" }>,
  when = "",
  output?: Readonly<{ json: boolean; io: YrdCliIO }>,
): IncompleteCensusError {
  if (output !== undefined) {
    output.io.stdout(
      output.json
        ? `${JSON.stringify({ kept: true, queued: false, path, reason: admission.refusal, ...(when === "" ? {} : { when }) })}\n`
        : `kept environment ${path}: ${admission.refusal}${when === "" ? "" : ` ${when}`}; not queued\n`,
    )
  }
  return new IncompleteCensusError(
    admission.refusal,
    admission.census,
    `${admission.refusal}${when === "" ? "" : ` ${when}`} (${censusReaderLine(admission.census)}); environment ${path} was preserved`,
  )
}

/**
 * File the durable close request for a context that can take a complete census
 * (22894). A write this process cannot make is a loud refusal naming the file
 * and the cure — never a silent `queued`, never a removal.
 *
 * 31807 (@cto a12b2c1a): a request that WAS written is a success — exit 0 with
 * `{ queued: true, closed: false }` and the words "queued, not closed", because
 * the queue's round, not this caller, is the certifying authority. The caller
 * still cannot claim the environment is gone, so the receipt says exactly what
 * stands.
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
        `${standing.options.noRehome === true ? "without" : "with"} rehome under ending ${
          standing.ending === undefined ? "(none)" : JSON.stringify(standing.ending)
        }; ` +
        `it stands unchanged\n`,
    )
  }
  io.stderr(
    `yrd: env close ${path}: queued, not closed: ${admission.refusal}; ` +
      `${admission.census.unreadable} same-UID pid(s) were unreadable here, so this caller cannot certify the close; ` +
      `queued request ${file} for the queue's own round, which reads every same-UID pid, runs the same close lifecycle, unlinks ${file} when consumed, and journals the outcome under ${journalDir}\n`,
  )
  io.stdout(
    options.json === true
      ? `${JSON.stringify({
          queued: true,
          closed: false,
          path,
          reason: "incomplete-census",
          request: file,
          unreadable: admission.census.unreadable,
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
      : `queued, not closed: environment ${path}: ${admission.refusal}; ${admission.census.unreadable} same-UID pid(s) unreadable here; a context that can read every same-UID pid will close it, unlink ${file} when consumed, and journal the outcome under ${journalDir}; request ${file}\n`,
  )
  return 0
}

/** A local branch whose path contains `branch`, or sits inside it: git can store only one of the two (25850). */
async function branchPathConflict(git: Git, branch: string): Promise<string | undefined> {
  const branches = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).split("\n")
  return branches.find((name) => name !== "" && (branch.startsWith(`${name}/`) || name.startsWith(`${branch}/`)))
}
