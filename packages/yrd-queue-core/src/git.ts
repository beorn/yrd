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

/** A git runner rooted at one repository. Non-zero exits throw, loudly. */
export function gitIn(cwd: string, process?: Process): Git {
  const runner = process ?? createProcess({ cwd })
  return async (args: readonly string[], input?: string): Promise<string> => {
    const result = await runner.run({ argv: ["git", ...args], cwd, ...(input === undefined ? {} : { stdin: input }) })
    if (result.exitCode !== 0) {
      throw new GitExit(args, cwd, result.exitCode, result.stderr.trim() || result.stdout.trim())
    }
    return result.stdout
  }
}

export class GitExit extends Error {
  constructor(
    readonly args: readonly string[],
    readonly cwd: string,
    readonly exitCode: number,
    detail: string,
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
