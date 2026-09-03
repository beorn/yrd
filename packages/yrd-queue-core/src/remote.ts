/**
 * The lane: every change at the queue's remote, read
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Store and The change).
 *
 * A branch is its ref at the `yrd` remote. A change is the ref
 * `refs/yrd/changes/<branch>/<sha>` beside it. The remote is the one store;
 * a working repository is a reader that fetches those refs before it reads.
 * Nothing here stores a status: the lane is recomputed from the remote's refs
 * every time it is asked for, in a fixed number of git invocations however
 * many changes there are — one `ls-remote`, one fetch, one `for-each-ref` for
 * every change's tip fact, one for ancestry — because the tip fact's trailers
 * are the whole derived state and no history is walked.
 */

import { factFrom, type Fact, type Git } from "./facts.ts"
import { isAncestor } from "./git.ts"
import { CHANGES, changeRef, parseChangeRef } from "./refs.ts"
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

  // One fetch: every branch (for ancestry) and every change ref (for the tips).
  // Branch heads are read from ls-remote above, so a stale local tracking ref
  // can never speak for the remote.
  await git(["fetch", "--quiet", "--prune", remote, `+refs/heads/*:refs/remotes/${remote}/*`, `+${CHANGES}/*:${CHANGES}/*`])
  const tips = await tipFacts(git)
  // Every branch tip the target already carries, in one reading.
  const merged = new Set(
    (await git(["for-each-ref", "--format=%(objectname)", `--merged=${targetSha}`, `refs/remotes/${remote}/`]))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  )

  const entries: LaneEntry[] = []
  // Every branch at the remote, and every branch a change still names: a
  // branch that is gone still has its changes, which read failed (deleted).
  const branches = new Set([...heads.keys(), ...changeRefs.map((change) => change.branch)])
  for (const branch of branches) {
    const branchHead = heads.get(branch)
    const known = changeRefs.filter((change) => change.branch === branch)
    // The branch's current head is a change whether or not anyone opened it.
    const at = branchHead === undefined || known.some((change) => change.head === branchHead) ? known : [...known, { branch, head: branchHead }]
    for (const { head } of at) {
      const tip = tips.get(changeRef(branch, head))
      // A head that is a branch tip was answered by the one reading above; an
      // older head of a branch that moved on is asked for itself.
      const headOnTarget = merged.has(head) || (head !== branchHead && (await isAncestor(git, head, targetSha)))
      const change: ChangeFacts = {
        ...(branchHead === undefined ? {} : { branchHead }),
        facts: tip === undefined ? [] : [tip],
        head,
        headOnTarget,
      }
      entries.push({ branch, change, reading: readChange(change) })
    }
  }
  return entries
}

/** Every change ref's tip fact, by ref, in one reading. A change ref that does not end in a fact is loud. */
async function tipFacts(git: Git): Promise<ReadonlyMap<string, Fact>> {
  const out = await git(["for-each-ref", "--format=%(objectname)%00%(refname)%00%(committerdate:iso-strict)%00%(contents)%01", `${CHANGES}/`])
  const tips = new Map<string, Fact>()
  for (const record of out.split("\x01")) {
    const [sha, ref, at, body] = record.replace(/^\n/u, "").split("\x00")
    if (sha === undefined || ref === undefined || at === undefined || body === undefined || sha.trim() === "") continue
    const fact = factFrom(sha.trim(), at, body)
    if (fact === undefined) throw new Error(`${ref} does not end in a fact; a change's ref holds only facts`)
    tips.set(ref, fact)
  }
  return tips
}

/** The remotes this repository has, by name. */
export async function remoteNames(git: Git): Promise<readonly string[]> {
  return (await git(["remote"]))
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "")
}

const YRD = "yrd"

/**
 * The remote name for a declared `remote:`: the name itself when the
 * repository has it; else the declaration is a URL and the remote is `yrd`,
 * added at that URL when missing (§ The change: `yrd submit` adds the `yrd`
 * remote from `.yrd.yml` when missing). A name that is neither is loud.
 */
export async function resolveRemote(git: Git, declared: string): Promise<string> {
  const names = await remoteNames(git)
  if (names.includes(declared)) return declared
  if (!declared.includes(":") && !declared.includes("/")) {
    throw new Error(`.yrd.yml remote: ${declared} is neither a remote of this repository nor a URL`)
  }
  if (names.includes(YRD)) {
    const url = (await git(["remote", "get-url", YRD])).trim()
    if (url !== declared) throw new Error(`the remote ${YRD} is at ${url}, not at the declared ${declared}`)
    return YRD
  }
  await git(["remote", "add", YRD, declared])
  return YRD
}
