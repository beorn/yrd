/**
 * The lane: every change at the queue's remote, read
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Store and The change).
 *
 * A branch is its ref at the `yrd` remote. A change is the ref
 * `refs/yrd/changes/<branch>/<sha>` beside it. The remote is the one store;
 * a working repository is a reader that fetches those refs before it reads.
 * Nothing here stores a status: the lane is recomputed from the remote's refs
 * every time it is asked for, and one fetch is the only network round trip.
 */

import { readFacts, type Git } from "./facts.ts"
import { CHANGES, parseChangeRef } from "./refs.ts"
import { readChange, type ChangeFacts, type ChangeReading } from "./state.ts"

/** One change as the lane sees it. */
export type LaneEntry = Readonly<{
  branch: string
  change: ChangeFacts
  reading: ChangeReading
}>

/**
 * Every change at the remote, read. A branch with no change yet is a change in
 * state queued: a bare push is tolerated and becomes visible here, at the next
 * queue run, rather than sitting invisible at the remote. Measured 2026-09-02:
 * two such refs stood at the old receiver all day. Order is not decided here;
 * `inLine` in state.ts is the one place that knows the position in line.
 */
export async function lane(git: Git, remote: string, target: string): Promise<readonly LaneEntry[]> {
  const rows = (await git(["ls-remote", "--refs", remote])).split("\n")
  const heads = new Map<string, string>()
  const changeRefs: { branch: string; head: string }[] = []
  let targetSha: string | undefined
  for (const row of rows) {
    const [sha, ref] = row.trim().split(/\s+/u)
    if (sha === undefined || ref === undefined) continue
    if (ref === `refs/heads/${target}`) {
      targetSha = sha
    } else if (ref.startsWith("refs/heads/")) {
      heads.set(ref.slice("refs/heads/".length), sha)
    } else {
      const change = parseChangeRef(ref)
      if (change !== undefined) changeRefs.push(change)
    }
  }
  if (targetSha === undefined) throw new Error(`the target ${target} is not at ${remote}`)

  // One fetch: the target (for ancestry) and every change ref (for the facts).
  // Branch heads are read from ls-remote above, so a stale local tracking ref
  // can never speak for the remote.
  await git(["fetch", "--quiet", "--prune", remote, `+refs/heads/${target}`, `+${CHANGES}/*:${CHANGES}/*`])

  const entries: LaneEntry[] = []
  for (const [branch, branchHead] of heads) {
    const known = changeRefs.filter((change) => change.branch === branch)
    // The branch's current head is a change whether or not anyone opened it.
    const at = known.some((change) => change.head === branchHead) ? known : [...known, { branch, head: branchHead }]
    for (const { head } of at) {
      const change: ChangeFacts = {
        branchHead,
        facts: await readFacts(git, branch, head),
        head,
        headOnTarget: await isAncestor(git, head, targetSha),
      }
      entries.push({ branch, change, reading: readChange(change) })
    }
  }
  return entries
}

async function isAncestor(git: Git, sha: string, of: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", sha, of])
    return true
  } catch (error) {
    // Exit 1 is git's "no", the one answer this reader is asking for. Anything
    // else — a missing object, a bad sha — is rethrown, because a wrong answer
    // here would merge or skip the wrong change.
    if (error instanceof Error && / exited 1:/u.test(error.message)) return false
    throw error
  }
}
