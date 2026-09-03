/**
 * The target's first-parent line, judged: every commit on it since the queue's
 * own history starts that the queue did not put there
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, ruling E5).
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
 * The queue's history starts at its own first fact: the oldest commit under
 * `refs/yrd/changes/`, which is the first `opened` fact anyone wrote here.
 * Everything on the target older than that instant belongs to whatever moved
 * the branch before this queue existed, and is never judged.
 *
 * The boundary used to be a commit in `.yrd.yml` — first the newest one that
 * touched the file at all, then the one that INTRODUCED the `remote:` line —
 * and both readings made a line of configuration mean "the queue starts here".
 * `remote:` is an ordinary optional key now (`origin` unless declared), so it
 * cannot carry that meaning, and the facts say it better anyway: they are the
 * queue's own record, nothing else writes them, and the first of them is the
 * first moment this branch was the queue's.
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
import { CHANGES, changeName } from "./refs.ts"
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
 * that line introduced the `remote:` line: a target that never named this core
 * has no queue.
 */
export async function byHandCommits(
  git: Git,
  target: string,
  targetSha: string,
  entries: QueueRead,
): Promise<readonly ByHandCommit[]> {
  const started = await queueStarted(git)
  // No facts anywhere: this queue has judged nothing, so it has no history of
  // its own and nothing on the target is yet its business to report.
  if (started === undefined) return []
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
    `--since=${started}`,
    "--format=%H%x00%P%x00%cI%x00%s%x00%(trailers:key=Change,valueonly)%x01",
    targetSha,
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
    // A commit with no parent is where this branch's history begins, not
    // something pushed onto it, and there is nothing older to walk to. It can
    // only be reached at all because a committer date is whole seconds: a
    // repository whose first commit and whose first fact share one second has
    // both at the boundary.
    const first = parents[0]
    if (first === undefined) break
    const gitlinks = (await gitlinkRows(git, first, commit)).map((row) => row.path)
    found.push({ at: new Date(at), commit, gitlinks, parents, subject, target, why })
  }
  return found.reverse()
}

/**
 * When the queue's own history starts: the committer date of the oldest fact
 * commit under `refs/yrd/changes/`, which is the first `opened` fact anyone
 * wrote here. Undefined when there is no change at all — then the queue has
 * judged nothing and has no history to start.
 *
 * The walk is first-parent from every change tip, so it reads facts and ends
 * at the genesis (facts.ts). `--min-parents=1` drops the genesis itself, whose
 * committer date is the epoch by construction and would put the boundary in
 * 1970. A change ref is asked for FIRST because `git log --glob` with no
 * matching ref falls back to HEAD, which would answer with the project's own
 * history — the silent wrong answer this reading exists to avoid.
 *
 * The date is handed to `git log --since`, which keeps commits at or after it:
 * a hand commit made in the same second as the first fact is reported, never
 * hidden. The boundary errs towards reporting more, as the old one did.
 */
async function queueStarted(git: Git): Promise<string | undefined> {
  const some = (await git(["for-each-ref", "--count=1", "--format=%(refname)", `${CHANGES}/`])).trim()
  if (some === "") return undefined
  return (await git(["log", "--first-parent", "--min-parents=1", "--reverse", "--format=%cI", `--glob=${CHANGES}/*`]))
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "")
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
 * The one line a reader gets about a hand commit: the target, the commit, its
 * subject, and the pins it moved. It takes only the four values it says, so the
 * `list` row, the queue run's message and the log's human rendering are all one
 * sentence written once — the rendering used to spell it out a second time from
 * the log record's own fields.
 */
export function handMovedLine(
  commit: Readonly<{ target: string; commit: string; subject: string; gitlinks: readonly string[] }>,
): string {
  const pins = commit.gitlinks.length === 0 ? "" : `; it moved the pin at ${commit.gitlinks.join(", ")}`
  return `${commit.target} moved by hand at ${commit.commit.slice(0, 12)} (${commit.subject})${pins}`
}
