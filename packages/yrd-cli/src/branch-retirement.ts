import {
  createEventStore,
  isAncestor,
  listRefs,
  readRemoteCommit,
  retireLocalBranch,
  type Git,
  type GitSelection,
  type LocalBranchRetirement,
  type LocalBranchRetirementResult,
} from "@yrd/queue-core"

type LandingPin = Readonly<{ event: string; path: string; tip: string }>
type LandedCandidate = Omit<LocalBranchRetirement, "repo" | "git" | "disposition" | "reason"> &
  Readonly<{ path: string; landings: readonly LandingPin[]; reason?: string }>

/** One store's origin-custody judgment, shared by explicit landing candidates and manual issue selection.
 * Selection stays with the caller; this operation never enumerates or guesses author branches.
 */
export function createLandedBranchRetirement(
  store: Readonly<{
    repo: string
    git: Git
    selection: GitSelection
    remote: string
    target: string
  }>,
) {
  let remoteRefs: ReadonlyMap<string, string> | undefined
  return async (
    candidate: LandedCandidate,
  ): Promise<Omit<LocalBranchRetirementResult, "archiveRef"> & { archiveRef?: string }> => {
    const { repo, git, remote, selection, target } = store
    const { path, landings, reason, ...retirement } = candidate
    const pin = landings.find((pin) => pin.path === path && pin.tip === candidate.tip)
    let custody: string | undefined = (await isAncestor(git, candidate.tip, target)) ? target : undefined
    let proof: { kind: "ancestry" } | { kind: "landing"; event: string; path: string; tip: string } = {
      kind: "ancestry",
    }
    if (custody === undefined && pin !== undefined) {
      // A root gitlink retains no component object. Observe custody at component origin as well.
      remoteRefs ??= await listRefs("refs/", createEventStore(repo, remote, selection))
      for (const [ref] of remoteRefs) {
        const reached = await readRemoteCommit(git, remote, ref)
        if (reached !== undefined && (await isAncestor(git, candidate.tip, reached))) {
          custody = reached
          proof = { kind: "landing", ...pin }
          break
        }
      }
    }
    if (custody === undefined) {
      return {
        outcome: "kept",
        reason: "unreached",
        detail: `tip has no main ancestry or origin-retained exact landing pin in ${repo}`,
      }
    }
    return retireLocalBranch({
      ...retirement,
      repo,
      git,
      reason: reason ?? `landed by ${proof.kind}`,
      disposition: { kind: "landed", target: custody, proof },
    })
  }
}
