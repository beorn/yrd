import { execFileSync } from "node:child_process"
import { isAbsolute, join, resolve } from "node:path"
import { normalize as normalizePosix, join as joinPosix } from "node:path/posix"
import { cleanGitEnvironment } from "./git-environment.ts"

/**
 * Submodule tracking: `.gitmodules` `submodule.<name>.branch` is the switch
 * between a TRACKED submodule (upstream motion refreshes super PRs — a "roll")
 * and a PINNED one (the gitlink only moves when a PR moves it). This module
 * reads that state and helps `yrd init` set a branch for every submodule that
 * has not opted in. Config chooses WHICH ref counts as latest; it never chooses
 * WHETHER latest applies.
 */

/** One declared submodule as read from a superproject's `.gitmodules`. */
export type SubmoduleEntry = Readonly<{
  /** The `submodule.<name>` subsection key (usually equals the path). */
  name: string
  /** `submodule.<name>.path` — the on-disk location; falls back to name. */
  path: string
  /** `submodule.<name>.url`, if declared. */
  url?: string
  /** `submodule.<name>.branch` — present iff the submodule tracks a branch. */
  branch?: string
}>

/** Outcome of resolving a submodule's upstream default branch. */
export type SubmoduleBranchResolution =
  | Readonly<{ status: "resolved"; branch: string }>
  /** Reachable, but the remote HEAD named no branch; the documented `main` fallback applies. */
  | Readonly<{ status: "fallback"; branch: string; note: string }>
  /** The remote could not be reached or read; the branch is left unset. */
  | Readonly<{ status: "unreachable"; detail: string }>

/** Resolve a submodule's upstream default branch from its (resolved) URL. */
export type SubmoduleBranchResolver = (url: string) => SubmoduleBranchResolution | Promise<SubmoduleBranchResolution>

type GitCapture = Readonly<{ code: number; stdout: string; stderr: string }>

/** Run one Git command, capturing its output without throwing on a nonzero
 * exit. Git routing variables are scrubbed so ambient hook state cannot change
 * the repository under inspection. A spawn failure (no `git`, missing cwd) is a
 * real environment fault and is left to throw. */
function runGit(cwd: string, args: readonly string[]): GitCapture {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: cleanGitEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { code: 0, stdout, stderr: "" }
  } catch (error) {
    const failed = error as Readonly<{ status?: unknown; stdout?: unknown; stderr?: unknown }>
    if (typeof failed.status !== "number") throw error
    return {
      code: failed.status,
      stdout: typeof failed.stdout === "string" ? failed.stdout : "",
      stderr: typeof failed.stderr === "string" ? failed.stderr : "",
    }
  }
}

const SUBMODULE_KEY = /^submodule\.(.+)\.(path|url|branch)$/u
const REMOTE_SCHEME = /^[a-z][a-z\d+.-]*:/iu
const SCP_REMOTE = /^((?:[^/@:]+@)?[^/:]+:)(.+)$/u
const SYMREF_HEAD = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/mu

/**
 * Parse the NUL-delimited records emitted by
 * `git config --null -f .gitmodules --get-regexp '^submodule\.'`. Each record
 * is `key\nvalue`. This reuses Git's own config reader rather than hand-rolling
 * an INI parser, so quoting, comments, and subsection names are handled by Git.
 */
export function parseGitmodules(nulOutput: string): readonly SubmoduleEntry[] {
  const byName = new Map<string, { name: string; path?: string; url?: string; branch?: string }>()
  const order: string[] = []
  for (const record of nulOutput.split("\0")) {
    if (record === "") continue
    const separator = record.indexOf("\n")
    if (separator < 1) throw new Error("yrd: .gitmodules emitted an invalid NUL record")
    const key = record.slice(0, separator)
    const value = record.slice(separator + 1)
    const match = SUBMODULE_KEY.exec(key)
    if (match?.[1] === undefined) continue
    const name = match[1]
    const property = match[2] as "path" | "url" | "branch"
    let entry = byName.get(name)
    if (entry === undefined) {
      entry = { name }
      byName.set(name, entry)
      order.push(name)
    }
    entry[property] = value
  }
  return order.map((name) => {
    const entry = byName.get(name)!
    return {
      name: entry.name,
      path: entry.path ?? entry.name,
      ...(entry.url === undefined ? {} : { url: entry.url }),
      ...(entry.branch === undefined || entry.branch === "" ? {} : { branch: entry.branch }),
    }
  })
}

/** Submodules whose `.gitmodules` entry declares no branch (PINNED, not TRACKED). */
export function unbranchedSubmodules(entries: readonly SubmoduleEntry[]): readonly SubmoduleEntry[] {
  return entries.filter((entry) => entry.branch === undefined)
}

function comparePath(left: SubmoduleEntry, right: SubmoduleEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

/**
 * The single advisory message for a queue list/status surface, or `undefined`
 * when every submodule tracks a branch. One message per invocation, never per
 * submodule row.
 */
export function formatSubmoduleTrackingWarning(unbranched: readonly SubmoduleEntry[]): string | undefined {
  if (unbranched.length === 0) return undefined
  const paths = [...unbranched].sort(comparePath).map((entry) => entry.path)
  const noun = unbranched.length === 1 ? "submodule" : "submodules"
  return (
    `warn: ${unbranched.length} ${noun} not tracking a branch (rolls disabled): ` +
    `${paths.join(", ")} — run 'yrd init' to set`
  )
}

/** The superproject worktree root for `cwd`, or `undefined` when `cwd` is not
 * inside a Git worktree (so a non-repo directory produces no warning). */
export function superprojectRoot(cwd: string): string | undefined {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"])
  if (result.code !== 0) return undefined
  const root = result.stdout.trim()
  return root === "" ? undefined : root
}

/**
 * Read every submodule declared in `<root>/.gitmodules`. Returns an empty list
 * when the file declares no submodules; a malformed file fails loud with the
 * Git diagnostic rather than silently reading as empty.
 */
export function readSubmoduleEntries(root: string): readonly SubmoduleEntry[] {
  const result = runGit(root, ["config", "--null", "--file", join(root, ".gitmodules"), "--get-regexp", "^submodule\\."])
  // `git config --get-regexp` exits 1 when the file has no matching keys (no
  // submodules, or no .gitmodules at all): that is the expected empty case.
  if (result.code === 1) return []
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git config exited ${result.code}`
    throw new Error(`yrd: could not read ${join(root, ".gitmodules")}: ${detail}`)
  }
  return parseGitmodules(result.stdout)
}

/**
 * The advisory warning messages (zero or one) for the queue list/status
 * surfaces. Empty for a non-superproject directory or when every submodule
 * already tracks a branch — those surfaces then emit no extra output at all.
 */
export function submoduleTrackingWarnings(cwd: string): readonly string[] {
  const root = superprojectRoot(cwd)
  if (root === undefined) return []
  const warning = formatSubmoduleTrackingWarning(unbranchedSubmodules(readSubmoduleEntries(root)))
  return warning === undefined ? [] : [warning]
}

/**
 * Set `submodule.<name>.branch` in `<root>/.gitmodules`, leaving the change
 * uncommitted for the operator to review and commit. Fails loud on a Git error
 * rather than reporting a false success.
 */
export function setSubmoduleBranch(root: string, name: string, branch: string): void {
  const file = join(root, ".gitmodules")
  const result = runGit(root, ["config", "--file", file, `submodule.${name}.branch`, branch])
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git config exited ${result.code}`
    throw new Error(`yrd: could not set submodule.${name}.branch in ${file}: ${detail}`)
  }
}

/** Read the superproject's `origin` remote URL, used to resolve relative
 * submodule URLs. `undefined` when no such remote is configured. */
export function superprojectOrigin(root: string): string | undefined {
  const result = runGit(root, ["remote", "get-url", "origin"])
  if (result.code !== 0) return undefined
  const url = result.stdout.trim()
  return url === "" ? undefined : url
}

function canonicalRemote(root: string, value: string): string {
  if (isAbsolute(value) || REMOTE_SCHEME.test(value) || SCP_REMOTE.test(value)) return value
  return resolve(root, value)
}

/**
 * Resolve a submodule's declared URL to something `git ls-remote` can reach.
 * Relative URLs (`./x`, `../x`) resolve against the superproject origin exactly
 * as Git itself resolves them; everything else is returned canonicalized.
 */
export function resolveSubmoduleUrl(root: string, superOrigin: string | undefined, url: string): string {
  if (!url.startsWith("./") && !url.startsWith("../")) return canonicalRemote(root, url)
  if (superOrigin === undefined) {
    throw new Error(`yrd: relative submodule URL '${url}' has no superproject origin to resolve against`)
  }
  const base = canonicalRemote(root, superOrigin)
  if (REMOTE_SCHEME.test(base)) {
    const directory = new URL(base)
    if (!directory.pathname.endsWith("/")) directory.pathname += "/"
    return new URL(url, directory).toString()
  }
  const scp = SCP_REMOTE.exec(base)
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    return `${scp[1]}${normalizePosix(joinPosix(scp[2], url))}`
  }
  return resolve(base, url)
}

/**
 * The default upstream-default-branch resolver: `git ls-remote --symref <url>
 * HEAD`. A reachable remote whose HEAD names a branch resolves to it; a
 * reachable remote with no branch HEAD takes the documented `main` fallback;
 * an unreachable remote is reported so `yrd init` can list it and leave the
 * submodule unset. Tests inject a resolver instead of reaching the network.
 */
export function createSubmoduleBranchResolver(cwd: string): SubmoduleBranchResolver {
  return (url: string): SubmoduleBranchResolution => {
    const result = runGit(cwd, ["ls-remote", "--symref", url, "HEAD"])
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `git ls-remote exited ${result.code}`
      return { status: "unreachable", detail }
    }
    const match = SYMREF_HEAD.exec(result.stdout)
    if (match?.[1] !== undefined) return { status: "resolved", branch: match[1] }
    return {
      status: "fallback",
      branch: "main",
      note: `remote HEAD for '${url}' named no branch; defaulting to main`,
    }
  }
}
