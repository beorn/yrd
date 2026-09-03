/**
 * The one git seam the core runs through, and the three readings that turn a
 * non-zero exit into an answer.
 *
 * It is the existing process wrapper, unchanged: the plan reuses it rather than
 * growing a second way to spawn a child. Everything the core knows about a
 * repository comes through this function, so a test drives a real repository
 * and never a mock — the store is git, and a fake git would be a fake store.
 *
 * Git answers some questions with exit 1: "that ref is absent", "that commit
 * is not an ancestor". Those are answers, not errors, and they are read here
 * and nowhere else. Any other failure — a missing object, a bad sha, a broken
 * repository — is rethrown, because a wrong answer to either question would
 * merge or skip the wrong change (NO SILENT ERRORS).
 */

import { createProcess, type Process } from "@yrd/process"
import type { Git } from "./facts.ts"

/**
 * A git runner rooted at one repository. Non-zero exits throw, loudly.
 *
 * Two settings travel in its environment (`gitEnvironment`), so no call site
 * can forget them: the caller's routing variables are scrubbed, and neither a
 * fetch nor a push recurses into submodules. The superproject sets
 * `submodule.recurse=true`, under which every fetch visits all sixteen
 * submodules (measured 2026-09-03: 16 s against 1 s for the change refs), and
 * a push of a change that moved a pin tries to push the submodule with the
 * superproject's refspec and dies there (`src refspec refs/yrd/changes/… must
 * name a ref`, @dev/2, 2026-09-03). Worktrees get their submodules from
 * materialization (worktree.ts), never from a fetch; a moved pin is judged
 * by the built-in check at queue time, never pushed by the submit.
 */
export function gitIn(cwd: string, process?: Process): Git {
  const runner = process ?? createProcess({ cwd, env: gitEnvironment(globalThis.process.env) })
  return async (args: readonly string[], input?: string): Promise<string> => {
    const result = await runner.run({ argv: ["git", ...args], cwd, ...(input === undefined ? {} : { stdin: input }) })
    if (result.exitCode !== 0) {
      throw new GitExit(args, cwd, result.exitCode, result.stderr.trim() || result.stdout.trim())
    }
    return result.stdout
  }
}

/**
 * The variables git honours ahead of `cwd` when choosing a repository. A
 * `git yrd` subcommand inherits them from git itself; a caller's shell may
 * carry them by accident. Everything else passes: a user's `GIT_SSH_COMMAND`,
 * a test's `GIT_CONFIG_*`.
 */
const ROUTING_VARIABLES = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
])

/** The caller's environment without its routing variables, plus the queue's own git configuration. */
export function gitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !ROUTING_VARIABLES.has(key)),
  )
  const declared = Number(env.GIT_CONFIG_COUNT ?? "0")
  const count = Number.isInteger(declared) && declared >= 0 ? declared : 0
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: "fetch.recurseSubmodules",
    [`GIT_CONFIG_VALUE_${count}`]: "no",
    [`GIT_CONFIG_KEY_${count + 1}`]: "push.recurseSubmodules",
    [`GIT_CONFIG_VALUE_${count + 1}`]: "no",
  }
}

export class GitExit extends Error {
  constructor(
    readonly args: readonly string[],
    readonly cwd: string,
    readonly exitCode: number,
    /** What git itself said: its stderr, or its stdout when stderr was empty. */
    readonly detail: string,
  ) {
    super(`git ${args.join(" ")} in ${cwd} exited ${exitCode}: ${detail}`)
    this.name = "GitExit"
  }
}

/**
 * The object a name resolves to, or undefined when absent. A ref is peeled to
 * its commit; a `rev:path` names a blob already and git refuses a peel on it,
 * so it is asked for as written.
 */
export async function refAt(git: Git, ref: string, kind: "commit" | "blob" | "tree" = "commit"): Promise<string | undefined> {
  try {
    const name = kind === "commit" ? `${ref}^{commit}` : ref
    const out = (await git(["rev-parse", "--verify", "--quiet", name])).trim()
    return out === "" ? undefined : out
  } catch (error) {
    if (isExit(error, 1)) return undefined
    throw error
  }
}

/** Whether `sha` is an ancestor of `of`. */
export async function isAncestor(git: Git, sha: string, of: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", sha, of])
    return true
  } catch (error) {
    if (isExit(error, 1)) return false
    throw error
  }
}

/** The merge base of two commits, or undefined when their histories are unrelated. */
export async function mergeBase(git: Git, left: string, right: string): Promise<string | undefined> {
  try {
    const out = (await git(["merge-base", left, right])).trim()
    return out === "" ? undefined : out
  } catch (error) {
    if (isExit(error, 1)) return undefined
    throw error
  }
}

function isExit(error: unknown, code: number): boolean {
  return error instanceof GitExit && error.exitCode === code
}

/**
 * The gitlink rows of one tree-to-tree diff, read as git prints it with `-z`
 * — `:<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0` per entry
 * — for every path a gitlink stands at on either side: added, moved, or taken
 * out. `sha` is the new side's, the zero sha for a gitlink taken out.
 */
export async function gitlinkRows(
  git: Git,
  from: string,
  to: string,
): Promise<readonly Readonly<{ path: string; oldMode: string; newMode: string; sha: string }>[]> {
  const fields = (await git(["diff-tree", "-r", "-z", "--no-renames", from, to])).split("\0")
  const rows: { path: string; oldMode: string; newMode: string; sha: string }[] = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [colonOldMode, newMode, , newSha] = (fields[at] ?? "").split(" ")
    const oldMode = colonOldMode?.replace(/^:/u, "")
    const path = fields[at + 1]
    if (oldMode === undefined || newMode === undefined || newSha === undefined || path === undefined || path === "")
      continue
    if (oldMode !== "160000" && newMode !== "160000") continue
    rows.push({ newMode, oldMode, path, sha: newSha })
  }
  return rows
}
