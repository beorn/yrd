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
 * squash. Deliberately narrower than a tree comparison: a commit with no patch — an empty or graph-only
 * commit, or a merge — has nothing to match, so it stays unique to the branch and the call answers false.
 */
export async function patchEquivalentOffTarget(git: Git, target: string, tip: string): Promise<boolean> {
  // `git cherry` never lists a merge, so anything a merge introduced — a conflict resolution, a submodule
  // bump — is invisible to its patch list. A tip whose off-target range holds a merge is not proven this
  // way and keeps, even when its linear commits all match (@cto review, 34265).
  if ((await git(["rev-list", "--merges", `${target}..${tip}`])).trim() !== "") return false
  const listed = (await git(["cherry", target, tip]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  // No off-target commits means the tip is reachable from the target; ancestry is the proof there.
  if (listed.length === 0) return false
  return listed.every((line) => line.startsWith("- "))
}
