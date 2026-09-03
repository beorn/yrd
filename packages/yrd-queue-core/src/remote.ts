/**
 * The queue read: one reading of the remote that yields the queue, the
 * changes and where each stands ([plan](../../../../pm/@i/10-yrd/plan.md)
 * § The final design, Store and The change; ruling E3, which amends D8).
 *
 * A branch is its ref at the `yrd` remote. A change is the ref
 * `refs/yrd/changes/<branch>@<sha>` beside it, and a branch with no change is
 * not a change (E2): the queue read lists what was submitted and nothing
 * else. The remote is the one store; a working repository is a reader that
 * fetches those refs before it reads. Nothing here stores a status: the queue
 * is read again from the remote's refs every time it is asked for, in a fixed
 * number of git invocations however many changes there are — one `ls-remote`,
 * one fetch of the change refs, one fetch of exactly the branches they name
 * (the target among them), one `for-each-ref` for every change's tip fact,
 * one for ancestry — because the tip fact's trailers are the whole derived
 * state and no history is walked. The change refs are read FIRST and the
 * branches follow from them, so a remote with thousands of branches the queue
 * has nothing to do with is never fetched (E3; measured 2026-09-02: the root's
 * origin holds 7,387 branches, and fetching them all cost 17 s a round).
 */

import { factFrom, type Fact, type Git } from "./facts.ts"
import { isAncestor } from "./git.ts"
import { CHANGES, changeRef, parseChangeRef } from "./refs.ts"
import { readChange, type ChangeFacts, type ChangeReading } from "./state.ts"

/** One change as the queue read sees it. */
export type QueueEntry = Readonly<{
  branch: string
  change: ChangeFacts
  reading: ChangeReading
}>

/** What one reading of the remote yields: every change, and where each stands. */
export type QueueRead = readonly QueueEntry[]

/**
 * Every change at the remote, read: one entry per change ref, and nothing for
 * a branch nobody submitted (E2; `submit` is the one writer of a change), plus
 * the commit the target stood at in that same reading.
 *
 * The target's commit is the queue read's own answer, not a second question:
 * the `ls-remote` below already carries it and the fetch below already brings
 * it, so every caller that used to ask again — the queue run with an
 * `ls-remote` and a fetch of its own, `queue list` with a local re-read that
 * only worked because this fetch had run first — reads it from here.
 *
 * Order is not decided here; `inLine` in state.ts is the one place that knows
 * the position in line.
 */
export async function readQueue(
  git: Git,
  remote: string,
  target: string,
): Promise<Readonly<{ target: string; changes: QueueRead }>> {
  // Where every branch and every change stands at the remote, in one reading.
  // Branch heads are read from here and never from a tracking ref, so a stale
  // local ref can never speak for the remote.
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
      // A ref named after the target is not a change, so the read yields none
      // for it: it is never judged, never given a fact and never messaged
      // about, and above all it never accounts for a commit on the target's
      // own first-parent line, where an accounted commit hides every hand push
      // at or below it (by-hand.ts; E5). `submit` refuses to open one, so this
      // is only about the ones a remote already holds.
      if (change !== undefined && change.branch !== target) changeRefs.push(change)
    }
  }
  if (targetSha === undefined) throw new Error(`the target ${target} is not at ${remote}`)

  // The change refs first (E3). An opened fact has its head as a parent, so
  // this one fetch brings every submitted head with it, whether or not the
  // branch still stands; `--prune` forgets a local change ref the remote no
  // longer holds. Nothing else is asked for: no branch, no tag.
  await git(["fetch", "--quiet", "--no-tags", "--prune", remote, `+${CHANGES}/*:${CHANGES}/*`])
  // Then exactly the branches those changes name, and the target, in one
  // fetch, so the ancestry reading below asks fresh tracking refs. A named
  // branch the remote no longer has cannot be fetched (git refuses an absent
  // ref) and reads deleted from the ls-remote above; a tracking ref of it that
  // lingers is forgotten in one `update-ref`, because `--prune` prunes only
  // what the refspecs it is given name (measured 2026-09-02 on git 2.55: two
  // explicit branch refspecs with `--prune` left a deleted branch's tracking
  // ref standing). Nothing else under `refs/remotes/<remote>/` is touched:
  // a working repository that is also somebody's clone keeps its own refs.
  const named = new Set(changeRefs.map((change) => change.branch))
  const standing = [...named].filter((branch) => branch !== target && heads.has(branch))
  await git([
    "fetch",
    "--quiet",
    "--no-tags",
    remote,
    ...[target, ...standing].map((branch) => `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`),
  ])
  const gone = [...named].filter((branch) => branch !== target && !heads.has(branch))
  if (gone.length > 0) {
    await git(["update-ref", "--stdin"], gone.map((branch) => `delete refs/remotes/${remote}/${branch}\n`).join(""))
  }

  const tips = await tipFacts(git)
  // Every branch tip the target already carries, in one reading.
  const merged = new Set(
    (await git(["for-each-ref", "--format=%(objectname)", `--merged=${targetSha}`, `refs/remotes/${remote}/`]))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  )

  const entries: QueueEntry[] = []
  for (const { branch, head } of changeRefs) {
    const branchHead = heads.get(branch)
    const tip = tips.get(changeRef(branch, head))
    // The ls-remote listed this change and the fetch was to bring it: a change
    // gone between the two readings is two moments, not one reading, and is loud.
    if (tip === undefined) {
      throw new Error(`${changeRef(branch, head)} was at ${remote} but not here after the fetch; read the queue again`)
    }
    // A head that is a branch tip was answered by the one reading above; an
    // older head of a branch that moved on, or whose branch is gone, is asked
    // for itself — its object came with the change ref.
    const headOnTarget = merged.has(head) || (head !== branchHead && (await isAncestor(git, head, targetSha)))
    const change: ChangeFacts = {
      ...(branchHead === undefined ? {} : { branchHead }),
      facts: [tip],
      head,
      headOnTarget,
    }
    entries.push({ branch, change, reading: readChange(change) })
  }
  return { changes: entries, target: targetSha }
}

/** Every change ref's tip fact, by ref, in one reading. A change ref that does not end in a fact is loud. */
async function tipFacts(git: Git): Promise<ReadonlyMap<string, Fact>> {
  const out = await git([
    "for-each-ref",
    "--format=%(objectname)%00%(refname)%00%(committerdate:iso-strict)%00%(trailers:only,unfold)%00%(contents)%01",
    `${CHANGES}/`,
  ])
  const tips = new Map<string, Fact>()
  for (const record of out.split("\x01")) {
    const [sha, ref, at, block, body] = record.replace(/^\n/u, "").split("\x00")
    if (sha === undefined || ref === undefined || at === undefined || block === undefined || body === undefined || sha.trim() === "")
      continue
    const fact = factFrom(sha.trim(), at, body, block)
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
