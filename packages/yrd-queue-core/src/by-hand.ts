/**
 * The queue's branch's first-parent line, judged: every commit on it since the
 * queue's own history starts that the queue did not put there
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, ruling E5).
 *
 * Only the queue pushes that branch, by rule, and the queue proves it every
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
 * The cutover is the first-parent commit that INTRODUCED the `remote:` line in
 * `.yrd.yml`: the one line that switches this core on, and the day the queue's
 * own history starts (§ Cutover; A5). Everything at or before it is the old
 * queue's history and is never judged.
 *
 * It used to be the NEWEST first-parent commit that touched `.yrd.yml` at all,
 * and that was a hole the plan named at the cutover: a hand push that itself
 * edits the declaration became the boundary, so it hid itself and everything
 * under it (§ Owed after M5). The introduction cannot be hidden that way,
 * because a later edit is not an introduction — it is judged like any other
 * first-parent commit.
 *
 * The queue remembers nothing, so what it has already reported is read from
 * git too. A commit some change's merged fact names in `Merge:` is accounted
 * for: the queue merged it, or caught up on a hand merge of a submitted head
 * and reported it in the same queue run that wrote the fact. Everything below
 * an accounted commit was on the line when that fact was written, so it was
 * judged then; the walk from the tip stops at the first accounted commit, and
 * a queue run reports exactly the hand commits above it. A hand commit with
 * nothing of the queue's on top is reported again next run, with the commit
 * sha as its id, so the notifier sees one message however many runs say it:
 * at-least-once, the plan's shape for every message.
 */

import { endedKind, trailer, type Fact, type Git } from "./facts.ts"
import { gitlinkRows } from "./git.ts"
import { changeName } from "./refs.ts"
import type { QueueRead } from "./remote.ts"

export type ByHandCommit = Readonly<{
  /** The branch it moved: the queue's own. */
  branch: string
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
 * that line introduced the `remote:` line: a target that never named this core
 * has no queue.
 */
export async function byHandCommits(
  git: Git,
  branch: string,
  branchSha: string,
  entries: QueueRead,
): Promise<readonly ByHandCommit[]> {
  const cutover = await cutoverAt(git, branch, branchSha)
  const byName = new Map(entries.map((entry) => [changeName(entry.change), entry.change.facts.at(-1)]))
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
    `${cutover}..${branchSha}`,
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
    found.push({ at: new Date(at), branch, commit, gitlinks, parents, subject, why })
  }
  return found.reverse()
}

/**
 * The cutover boundary: the first-parent commit that introduced the `remote:`
 * line in `.yrd.yml`. Loud when no commit on that line ever did — a target
 * that never named this core has no queue, and no history of its own to start.
 *
 * One git invocation, the cheapest correct reading of the three that were on
 * the table. The pickaxe already answers "where did this string's count change
 * in this file", `--first-parent` already makes a merge's diff its first
 * parent's, and the OLDEST answer is the introduction; walking the blobs down
 * the line instead would be one `git show` per commit for the same answer, and
 * `--diff-filter=A` would name where the FILE came in, which is a different
 * and older commit — `.yrd.yml` predates the line by the whole life of the old
 * queue. Measured on 1,565 first-parent commits: 29 ms, the same as the
 * unfiltered path-limited log this replaces.
 *
 * The one thing it cannot tell apart is a `remote:` that is not the key — a
 * comment or a value that spells it — introduced in an older commit; that
 * commit would be the boundary instead. Nothing in the declaration's grammar
 * makes that likely, and the failure is loud rather than silent: the boundary
 * sits too far back and the queue reports MORE hand commits, never fewer.
 */
async function cutoverAt(git: Git, branch: string, branchSha: string): Promise<string> {
  const introduced = (await git(["log", "--first-parent", "-Sremote:", "--format=%H", branchSha, "--", ".yrd.yml"]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1)
  if (introduced === undefined) {
    throw new Error(
      `no commit on ${branch}'s first-parent line at ${branchSha.slice(0, 12)} introduced the remote: line in .yrd.yml; the queue cannot tell where its own history starts`,
    )
  }
  return introduced
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

/**
 * The one line a reader gets about a hand commit: the branch, the commit, its
 * subject, and the pins it moved. It takes only the four values it says, so the
 * `list` row, the queue run's message and the log's human rendering are all one
 * sentence written once — the rendering used to spell it out a second time from
 * the log record's own fields.
 */
export function handMovedLine(
  commit: Readonly<{ branch: string; commit: string; subject: string; gitlinks: readonly string[] }>,
): string {
  const pins = commit.gitlinks.length === 0 ? "" : `; it moved the pin at ${commit.gitlinks.join(", ")}`
  return `${commit.branch} moved by hand at ${commit.commit.slice(0, 12)} (${commit.subject})${pins}`
}
