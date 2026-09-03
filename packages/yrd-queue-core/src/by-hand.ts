/**
 * The target's first-parent line, judged: every commit on it since the cutover
 * that the queue did not put there ([plan](../../../../pm/@i/10-yrd/plan.md)
 * § The final design, ruling E5).
 *
 * Only the queue pushes the target, by rule, and the queue proves it every
 * queue run instead of GitHub preventing it: detect and adapt, or fail loud.
 * A merge the queue made is a `--no-ff` merge commit with two parents and a
 * `Change:` trailer naming its change, whose merged fact names the commit
 * back in `Merge:` and says `Merged-By: queue`. Anything else on the line —
 * one parent, no trailer, a trailer naming a change the queue does not know,
 * or one whose facts do not say the queue merged it there — was pushed by
 * hand. Adapting is already built: the lease refuses the queue's next push
 * onto the old base and the queue run judges every change on the new one; a
 * rollback is a person's `git revert`, never the queue's.
 *
 * The cutover is the newest first-parent commit that touched `.yrd.yml`: the
 * declaration that switched the queue on (§ Cutover). Everything at or before
 * it is the old queue's history and is never judged.
 *
 * The queue remembers nothing, so what it has already reported is read from
 * git too. A commit some change's merged fact names in `Merge:` is accounted
 * for: the queue merged it, or caught up on a hand merge of a submitted head
 * and reported it in the same queue run that wrote the fact. Everything below
 * an accounted commit was on the line when that fact was written, so it was
 * judged then; the walk from the tip stops at the first accounted commit, and
 * a queue run reports exactly the hand commits above it. A hand commit with
 * nothing of the queue's on top is reported again next run, with the commit
 * sha as its id, so the owner's notifier sees one message however many runs
 * say it: at-least-once, the plan's shape for every message.
 */

import { endedKind, trailer, type Fact, type Git } from "./facts.ts"
import { gitlinkRows } from "./git.ts"
import { changeName } from "./refs.ts"
import type { QueueRead } from "./remote.ts"

export type ByHandCommit = Readonly<{
  /** The branch it moved: the queue's target. */
  target: string
  commit: string
  parents: readonly string[]
  subject: string
  /** When it was committed. */
  at: Date
  /** The gitlink paths it changed against its first parent: a hand-moved pin is the incident class the gitlink check never sees. */
  gitlinks: readonly string[]
  /** Why it is not the queue's, in plain words. */
  why: string
}>

/**
 * The hand commits on the target's first-parent line since the cutover that
 * the queue has not yet accounted for, oldest first. Loud when no commit on
 * that line touched `.yrd.yml`: a target with no declaration has no queue.
 */
export async function byHandCommits(
  git: Git,
  target: string,
  targetSha: string,
  entries: QueueRead,
): Promise<readonly ByHandCommit[]> {
  const cutover = (await git(["log", "--first-parent", "-1", "--format=%H", targetSha, "--", ".yrd.yml"])).trim()
  if (cutover === "") {
    throw new Error(
      `no commit on ${target}'s first-parent line at ${targetSha.slice(0, 12)} touched .yrd.yml; the queue cannot tell where its own history starts`,
    )
  }
  const byName = new Map(
    entries.map((entry) => [changeName(entry.branch, entry.change.head), entry.change.facts.at(-1)]),
  )
  const accounted = new Set<string>()
  for (const tip of byName.values()) {
    const merge = tip === undefined || endedKind(tip) !== "merged" ? undefined : trailer(tip, "Merge")
    if (merge !== undefined) accounted.add(merge)
  }
  // Newest first, each commit as one record: sha, parents, committer date,
  // subject, then every `Change:` trailer value on its own line. `%x01` ends
  // the record, because the trailer block holds newlines.
  const out = await git([
    "log",
    "--first-parent",
    "--format=%H%x00%P%x00%cI%x00%s%x00%(trailers:key=Change,valueonly)%x01",
    `${cutover}..${targetSha}`,
  ])
  const found: ByHandCommit[] = []
  for (const record of out.split("\x01")) {
    const [commit, parentList, at, subject, changes] = record.replace(/^\n/u, "").split("\x00")
    if (commit === undefined || commit === "" || parentList === undefined || at === undefined || subject === undefined)
      continue
    const parents = parentList.split(" ").filter((parent) => parent !== "")
    const names = (changes ?? "")
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name !== "")
    const why = notTheQueues(commit, parents, names, byName)
    if (why === undefined || accounted.has(commit)) break
    const first = parents[0]
    if (first === undefined)
      throw new Error(`${commit.slice(0, 12)} has no parent, yet it is after the cutover ${cutover.slice(0, 12)}`)
    const gitlinks = (await gitlinkRows(git, first, commit)).map((row) => row.path)
    found.push({ at: new Date(at), commit, gitlinks, parents, subject, target, why })
  }
  return found.reverse()
}

/** Why a commit is not a merge the queue made, or undefined when it is one. */
function notTheQueues(
  commit: string,
  parents: readonly string[],
  names: readonly string[],
  byName: ReadonlyMap<string, Fact | undefined>,
): string | undefined {
  if (parents.length !== 2)
    return parents.length === 1 ? "it is one commit, not a merge of a change" : `it has ${parents.length} parents`
  if (names.length === 0) return "it carries no Change: trailer"
  if (names.length > 1) return `it carries ${names.length} Change: trailers`
  const name = names[0] ?? ""
  if (!byName.has(name)) return `it names the change ${name}, which the queue does not know`
  const tip = byName.get(name)
  if (tip === undefined || endedKind(tip) !== "merged" || trailer(tip, "Merge") !== commit) {
    return `it names the change ${name}, whose facts do not say it merged there`
  }
  if (trailer(tip, "Merged-By") !== "queue") return `it names the change ${name}, which was merged by hand`
  return undefined
}

/** The one line a reader gets about a hand commit: the target, the commit, its subject, and the pins it moved. */
export function handMovedLine(commit: ByHandCommit): string {
  const pins = commit.gitlinks.length === 0 ? "" : `; it moved the pin at ${commit.gitlinks.join(", ")}`
  return `${commit.target} moved by hand at ${commit.commit.slice(0, 12)} (${commit.subject})${pins}`
}
