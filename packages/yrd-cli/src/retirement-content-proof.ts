/**
 * @failure A rebuilt landing keeps its branch forever because reachability ignores equivalent patches, so
 * retirement judges a landed branch unreached (34265).
 * @level l2 (real Git; the fixture lives in tests/retirement-content-proof.test.ts)
 * @consumer Yrd post-merge local and root retirement
 * @testonly none
 */
import type { Git } from "@yrd/queue-core"

/**
 * Whether every commit the target lacks from `tip` already has a patch-equivalent commit in the target
 * (`git cherry`): the branch was rebuilt (re-landed as its own commits) before landing, so it carries no
 * content the target never received without sharing ancestry (34265). The claim is about patch-equivalent
 * commits in the target's history, never about the target's current tree and never about a multi-commit
 * squash. Deliberately narrower than a tree comparison: a merge, and a commit with no patch of its own, are
 * never proven this way, so they stay unique to the branch and the call answers false.
 */
export async function patchEquivalentOffTarget(git: Git, target: string, tip: string): Promise<boolean> {
  // `git cherry` never lists a merge, so anything a merge introduced — a conflict resolution, a submodule
  // bump — is invisible to its patch list. A tip whose off-target range holds a merge is not proven this
  // way and keeps, even when its linear commits all match (@cto review, 34265).
  if ((await git(["rev-list", "--merges", `${target}..${tip}`])).trim() !== "") return false
  const commits = (await git(["rev-list", "--no-merges", "--parents", `${target}..${tip}`]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.split(" "))
  // No off-target commits means the tip is reachable from the target; ancestry is the proof there.
  if (commits.length === 0) return false
  // `git cherry` compares patch-ids, and every commit with no patch shares git's empty patch-id, so a graph-only
  // branch commit is reported `- ` against an UNRELATED empty commit in the target and the branch would be
  // deleted with its own history (@dev/4, 34265). A range holding a commit whose tree equals its parent's is
  // not proven, whatever its paths are called.
  if (await holdsEmptyCommit(git, commits)) return false
  const listed = (await git(["cherry", target, tip]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  if (listed.length === 0) return false
  return listed.every((line) => line.startsWith("- "))
}

/**
 * Whether any of these commits changes nothing: its tree equals its first parent's tree. Reading trees rather
 * than a path listing keeps the answer out of reach of a file named like a commit id (@dev/4, 34265), and a
 * commit whose parent or tree cannot be read is kept rather than assumed empty or assumed non-empty.
 */
async function holdsEmptyCommit(git: Git, commits: readonly (readonly string[])[]): Promise<boolean> {
  if (commits.some(([, parent]) => parent === undefined)) return true
  const query = commits.flatMap(([commit, parent]) => [`${commit}^{tree}`, `${parent}^{tree}`])
  const trees = (await git(["cat-file", "--batch-check"], `${query.join("\n")}\n`))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  return commits.some((_, index) => {
    const own = trees[index * 2]?.split(" ")
    const parent = trees[index * 2 + 1]?.split(" ")
    // Missing replies are `<query> missing`; only a reported tree supplies an object id to compare.
    if (own?.[1] !== "tree" || parent?.[1] !== "tree") return true
    return own[0] === parent[0]
  })
}
