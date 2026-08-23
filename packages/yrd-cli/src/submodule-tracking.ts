import { adaptProcessGit, createProcess, type GitSyncReadCommand } from "@yrd/process"
import { join } from "node:path"

/**
 * Submodule tracking: `.gitmodules` `submodule.<name>.branch` is the switch
 * between a TRACKED submodule (upstream changes refresh the superproject's PRs)
 * and a PINNED one (the gitlink only moves when a change moves it). This module
 * reads that state and helps `yrd admin submodule init` set a branch for every
 * submodule that has not opted in. Config chooses WHICH ref counts as latest;
 * it never chooses WHETHER latest applies.
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
 * the repository under inspection. A missing executable is an environment
 * fault; a missing/non-repository target remains Git's ordinary nonzero result. */
const gitReader = adaptProcessGit(undefined)

function readGit(cwd: string, command: GitSyncReadCommand): GitCapture {
  const result = gitReader.readSync({ repo: cwd, command })
  if (result.failure !== undefined) throw new Error(result.failure)
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitCapture> {
  await using process = createProcess()
  const result = await adaptProcessGit(process).run({ repo: cwd, args })
  if (result.failure !== undefined) throw new Error(result.failure)
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

const SUBMODULE_KEY = /^submodule\.(.+)\.(path|url|branch)$/u
const SYMREF_HEAD = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/mu

/** Reduce a multi-row Git diagnostic to its first row with inner whitespace
 * collapsed, so it cannot break a warning message or a table row. */
export function firstLine(detail: string): string {
  return (detail.split(/\r?\n/u)[0] ?? "").replaceAll(/\s+/gu, " ").trim()
}

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
    const entry = byName.get(name)
    if (entry === undefined) throw new Error(`yrd: parsed submodule '${name}' disappeared before projection`)
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
    `warn: ${unbranched.length} ${noun} not tracking a branch ` +
    `(pinned — upstream changes won't refresh PRs): ${paths.join(", ")} — run 'yrd admin submodule init' to set`
  )
}

/** The superproject worktree root for `cwd`, or `undefined` when `cwd` is not
 * inside a Git worktree (so a non-repo directory produces no warning). */
export function superprojectRoot(cwd: string): string | undefined {
  const result = readGit(cwd, { verb: "rev-parse", args: ["--show-toplevel"] })
  if (result.code !== 0) return undefined
  const root = result.stdout.trim()
  return root === "" ? undefined : root
}

type GitmodulesRead =
  | Readonly<{ ok: true; entries: readonly SubmoduleEntry[] }>
  | Readonly<{ ok: false; detail: string }>

/** Read `<root>/.gitmodules`, distinguishing the empty case (no submodules, or
 * no file — Git config exit 1) from a genuine read failure (a malformed file —
 * exit 128). The Git diagnostic is collapsed to one row for both consumers. */
function readGitmodules(root: string): GitmodulesRead {
  const result = readGit(root, {
    verb: "config-get-regexp",
    file: join(root, ".gitmodules"),
    pattern: "^submodule\\.",
    nul: true,
  })
  if (result.code === 1) return { ok: true, entries: [] }
  if (result.code !== 0) {
    return {
      ok: false,
      detail: firstLine(result.stderr.trim() || result.stdout.trim() || `git config exited ${result.code}`),
    }
  }
  return { ok: true, entries: parseGitmodules(result.stdout) }
}

/**
 * Read every submodule declared in `<root>/.gitmodules`. Returns an empty list
 * when the file declares no submodules; a malformed file fails loud with the
 * Git diagnostic rather than silently reading as empty.
 */
export function readSubmoduleEntries(root: string): readonly SubmoduleEntry[] {
  const read = readGitmodules(root)
  if (!read.ok) throw new Error(`yrd: could not read ${join(root, ".gitmodules")}: ${read.detail}`)
  return read.entries
}

/**
 * The advisory warning messages (zero or one) for the queue list/status
 * surfaces. Empty for a non-superproject directory or when every submodule
 * already tracks a branch — those surfaces then emit no extra output at all.
 *
 * A read failure degrades to a loud warning here rather than throwing: the
 * advisory must never take down `queue list`/`yrd` with a nonzero exit.
 * `readSubmoduleEntries` and `yrd admin submodule init` still throw, because
 * there the file IS the job.
 */
export function submoduleTrackingWarnings(cwd: string): readonly string[] {
  const root = superprojectRoot(cwd)
  if (root === undefined) return []
  const read = readGitmodules(root)
  if (!read.ok) return [`warn: could not read .gitmodules: ${read.detail}`]
  const warning = formatSubmoduleTrackingWarning(unbranchedSubmodules(read.entries))
  return warning === undefined ? [] : [warning]
}

/**
 * Set `submodule.<name>.branch` in `<root>/.gitmodules`, leaving the change
 * uncommitted for the operator to review and commit. Fails loud on a Git error
 * rather than reporting a false success.
 */
export async function setSubmoduleBranch(root: string, name: string, branch: string): Promise<void> {
  const file = join(root, ".gitmodules")
  const result = await runGit(root, ["config", "--file", file, `submodule.${name}.branch`, branch])
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git config exited ${result.code}`
    throw new Error(`yrd: could not set submodule.${name}.branch in ${file}: ${detail}`)
  }
}

/** Read the superproject's `origin` remote URL, used to resolve relative
 * submodule URLs. `undefined` when no such remote is configured. */
export function superprojectOrigin(root: string): string | undefined {
  const result = readGit(root, { verb: "remote-get-url", remote: "origin" })
  if (result.code !== 0) return undefined
  const url = result.stdout.trim()
  return url === "" ? undefined : url
}

/**
 * The default upstream-default-branch resolver: `git ls-remote --symref <url>
 * HEAD`. A reachable remote whose HEAD names a branch resolves to it; a
 * reachable remote with no branch HEAD takes the documented `main` fallback;
 * an unreachable remote is reported so `yrd admin submodule init` can list it
 * and leave the submodule unset. Tests inject a resolver instead of reaching
 * the network.
 */
export function createSubmoduleBranchResolver(cwd: string): SubmoduleBranchResolver {
  return async (url: string): Promise<SubmoduleBranchResolution> => {
    const result = await runGit(cwd, ["ls-remote", "--symref", url, "HEAD"])
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
