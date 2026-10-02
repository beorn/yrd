/**
 * A submodule the repository declares `private = true` in its own `.gitmodules`
 * section is never materialized by a Yrd environment (27147). Yrd holds no list
 * of its own: git-super's reader reports the flag at the commit, and Yrd hands
 * the paths back to git-super as `excludedSubmodules`.
 */

import { readPrivateSubmodulePaths } from "git-super/commit-graph"
import { seamProcess, type Git } from "./git.ts"

/** The paths `commit`'s `.gitmodules` declares private, sorted; empty when it declares none. */
export async function declaredPrivateSubmodules(git: Git, repo: string, commit: string): Promise<string[]> {
  return readPrivateSubmodulePaths(seamProcess(git, repo), repo, commit)
}

/**
 * Refuse, by name, a change that moves the gitlink of a private submodule.
 *
 * A Yrd environment does not hold the private path, so nothing Yrd runs can
 * verify a change to its pin. The comparison reads the parent's trees only, at
 * the base and the head, for every path either commit declares private, so
 * dropping the declaration in the same change does not admit the move.
 */
export async function refuseMovedPrivateGitlinks(
  git: Git,
  repo: string,
  branch: string,
  base: string,
  head: string,
): Promise<void> {
  const paths = [
    ...new Set([
      ...(await declaredPrivateSubmodules(git, repo, base)),
      ...(await declaredPrivateSubmodules(git, repo, head)),
    ]),
  ].sort()
  for (const path of paths) {
    const entry = async (commit: string) => (await git(["ls-tree", "--full-tree", commit, "--", path])).trim()
    if ((await entry(base)) !== (await entry(head))) {
      throw new Error(
        `yrd: ${branch} at ${head} changes the gitlink of private submodule ${path} (declared private = true in .gitmodules); ` +
          `a Yrd environment does not hold ${path}, so a change to its gitlink cannot be verified here`,
      )
    }
  }
}
