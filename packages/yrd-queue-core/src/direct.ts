/**
 * The target's first-parent line, judged: every commit on it since the queue's
 * own history starts that the queue did not put there — a DIRECT MERGE
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, ruling E5).
 *
 * Only the queue pushes the target, by rule, and the queue proves it every
 * queue run instead of GitHub preventing it: detect and adapt, or fail loud.
 * A merge the queue made is a `--no-ff` merge commit with two parents and a
 * `Change:` trailer naming its change, whose merged record names the commit
 * back in `Merge:` and says which run of which queue made it (`Merged-By:`). Anything else on the line —
 * one parent, no trailer, a trailer naming a change the queue does not know,
 * or one whose records do not say the queue merged it there — went around the
 * queue. Adapting is already built: the lease refuses the queue's next push
 * onto the old base and the queue run judges every change on the new one; a
 * rollback is a person's `git revert`, never the queue's.
 *
 * The queue's history starts at its own first record: the oldest commit in
 * its captured change histories, the first `opened` record anyone wrote here.
 * Everything on the target older than that instant belongs to whatever moved
 * the branch before this queue existed, and is never judged.
 *
 * The boundary used to be a commit in `.yrd.yml` — first the newest one that
 * touched the file at all, then the one that INTRODUCED the `remote:` line —
 * and both readings made a line of configuration mean "the queue starts here".
 * `remote:` is an ordinary optional key now (`origin` unless declared), so it
 * cannot carry that meaning, and the records say it better anyway: they are the
 * queue's own records, nothing else writes them, and the first of them is the
 * first moment this branch was the queue's.
 *
 * The queue remembers nothing, so what it has already reported is read from
 * git too. A commit some change's merged record names in `Merge:` is accounted
 * for: the queue merged it, or caught up on a direct merge that merged a submitted head
 * and reported it in the same queue run that wrote the record. Everything below
 * an accounted commit was on the line when that record was written, so it was
 * judged then; the walk from the tip stops at the first accounted commit, and
 * a queue run reports exactly the direct merges above it. A direct merge with
 * nothing of the queue's on top is reported again next run, with the commit
 * sha as its id, so the notifier sees one message however many runs say it:
 * at-least-once, the plan's shape for every message.
 */

import {
  endedKind,
  endingRecordThrough,
  legacyStore,
  mergedByRun,
  trailer,
  type ChangeRecord,
} from "./legacy-records.ts"
import { gitlinkRows, type Git } from "./git.ts"
import { changeName } from "./refs.ts"
import type { QueueRead } from "./remote.ts"
import { tipOf } from "./state.ts"
import { mergedHistoryCommits } from "./events.ts"

export type DirectMerge = Readonly<{
  /** The branch it moved: the queue's target. */
  target: string
  commit: string
  parents: readonly string[]
  subject: string
  /** When it was committed. */
  at: Date
  /** The gitlink paths it changed against its first parent: a gitlink moved around the queue is the direct class candidate settling never sees. */
  gitlinks: readonly string[]
  /** Why it is not the queue's, in plain words. */
  why: string
}>

type FirstParentCommit = Readonly<{
  commit: string
  parents: readonly string[]
  at: Date
  subject: string
  changes: readonly string[]
}>

/** The shared first-parent reader for legacy and event direct-merge accounting. Newest first. */
async function firstParentLine(git: Git, targetSha: string, boundary: string): Promise<readonly FirstParentCommit[]> {
  const out = await git([
    "log",
    "--first-parent",
    boundary,
    "--format=%H%x00%P%x00%cI%x00%s%x00%(trailers:key=Change,valueonly)%x01",
    targetSha,
  ])
  const line: FirstParentCommit[] = []
  for (const record of out.split("\x01")) {
    const text = record.replace(/^\n/u, "")
    if (text.trim() === "") continue
    const fields = text.split("\x00")
    if (fields.length !== 5) throw new Error(`malformed first-parent git log record for ${targetSha}`)
    const [commit, parentList, at, subject, changes] = fields
    if (
      commit === undefined ||
      commit === "" ||
      parentList === undefined ||
      at === undefined ||
      subject === undefined
    ) {
      throw new Error(`incomplete first-parent git log record for ${targetSha}`)
    }
    const instant = new Date(at)
    if (Number.isNaN(instant.getTime())) throw new Error(`invalid first-parent commit time for ${commit}: ${at}`)
    line.push({
      commit,
      parents: parentList.split(" ").filter((parent) => parent !== ""),
      at: instant,
      subject,
      changes: (changes ?? "")
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    })
  }
  return line
}

/**
 * Event queue E5: declaration is the exact first-parent boundary; merged
 * events account for queue publications and target merges the runner observed.
 * A direct-only commit is deliberately returned again on every run until such
 * an event stands above it, always under the commit sha as its identity. This
 * keeps legacy `run.ts`'s `reportDirectMerges` at-least-once contract.
 */
export async function eventDirectMergeCommits(
  git: Git,
  target: string,
  targetSha: string,
  declaration: string,
  histories: Parameters<typeof mergedHistoryCommits>[0],
): Promise<readonly DirectMerge[]> {
  const accounted = mergedHistoryCommits(histories)
  const line = await firstParentLine(git, targetSha, `${declaration}..${targetSha}`)
  if (targetSha !== declaration && line.at(-1)?.parents[0] !== declaration) {
    throw new Error(`${target} at ${targetSha}: queue declaration ${declaration} is not on its first-parent line`)
  }
  const found: DirectMerge[] = []
  for (const row of line) {
    if (accounted.has(row.commit)) break
    const first = row.parents[0]
    if (first === undefined) {
      throw new Error(`${target} at ${row.commit}: first-parent line ended after declaration ${declaration}`)
    }
    found.push({
      ...row,
      target,
      gitlinks: (await gitlinkRows(git, first, row.commit)).map((link) => link.path),
      why: "its commit has no merged event in this queue",
    })
  }
  return found.reverse()
}

/**
 * The direct merges on the target's first-parent line since the moment that
 * the queue has not yet accounted for, oldest first. Loud when no commit on
 * that line introduced the `remote:` line: a target that never named this core
 * has no queue.
 */
export async function directMergeCommits(
  git: Git,
  target: string,
  targetSha: string,
  entries: QueueRead,
): Promise<readonly DirectMerge[]> {
  const started = await queueStarted(git, entries)
  // No records anywhere: this queue has judged nothing, so it has no history of
  // its own and nothing on the target is yet its business to report.
  if (started === undefined) return []
  // Each change's ENDING record, never its literal tip: a stray record
  // appended after a merged ending must not hide the merge, however shallow
  // the caller's capture was (@i/10-yrd/24635).
  const store = await legacyStore(git)
  const byName = new Map<string, ChangeRecord | undefined>()
  for (const entry of entries) {
    byName.set(changeName(entry.change), await endingRecordThrough(git, entry.change, store))
  }
  const accounted = new Set<string>()
  for (const ending of byName.values()) {
    const merge = ending === undefined || endedKind(ending) !== "merged" ? undefined : trailer(ending, "Merge")
    if (merge !== undefined) accounted.add(merge)
  }
  const line = await firstParentLine(git, targetSha, `--since=${started}`)
  const found: DirectMerge[] = []
  for (const { commit, parents, at, subject, changes } of line) {
    const why = notTheQueues(commit, parents, changes, byName)
    if (why === undefined || accounted.has(commit)) break
    // A commit with no parent is where this branch's history begins, not
    // something pushed onto it, and there is nothing older to walk to. It can
    // only be reached at all because a committer date is whole seconds: a
    // repository whose first commit and whose first record share one second has
    // both at the boundary.
    const first = parents[0]
    if (first === undefined) break
    const gitlinks = (await gitlinkRows(git, first, commit)).map((row) => row.path)
    found.push({ at, commit, gitlinks, parents, subject, target, why })
  }
  return found.reverse()
}

/**
 * When the queue's own history starts: the committer date of the oldest record
 * in its captured change histories. Undefined when there is no change at all — then the queue has
 * judged nothing and has no history to start.
 *
 * The walk is first-parent from every change tip, so it reads records and ends
 * at the genesis (legacy-records.ts). `--min-parents=1` drops the genesis itself, whose
 * committer date is the epoch by construction and would put the boundary in
 * 1970. No entries means no walk: `git log` without commits would fall back to
 * HEAD and invent a boundary from the project's own history. Pause records
 * are not changes and never supply that boundary.
 *
 * The date is handed to `git log --since`, which keeps commits at or after it:
 * a direct merge made in the same second as the first record is reported, never
 * hidden. The boundary errs towards reporting more, as the old one did.
 */
async function queueStarted(git: Git, entries: QueueRead): Promise<string | undefined> {
  if (entries.length === 0) return undefined
  const tips = [...new Set(entries.map((entry) => tipOf(entry.change).sha))]
  return (await git(["log", "--first-parent", "--min-parents=1", "--reverse", "--format=%cI", ...tips]))
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "")
}

/** Why a commit is not a merge the queue made, or undefined when it is one. */
function notTheQueues(
  commit: string,
  parents: readonly string[],
  names: readonly string[],
  byName: ReadonlyMap<string, ChangeRecord | undefined>,
): string | undefined {
  if (parents.length !== 2) {
    return parents.length === 1 ? "it is one commit, not a merge of a change" : `it has ${parents.length} parents`
  }
  if (names.length === 0) return "it carries no Change: trailer"
  if (names.length > 1) return `it carries ${names.length} Change: trailers`
  const name = names[0] ?? ""
  if (!byName.has(name)) return `it names the change ${name}, which the queue does not know`
  const ending = byName.get(name)
  if (ending === undefined || endedKind(ending) !== "merged" || trailer(ending, "Merge") !== commit) {
    return `it names the change ${name}, whose records do not say it merged there`
  }
  if (mergedByRun(trailer(ending, "Merged-By")) === undefined) {
    return `it names the change ${name}, which was merged around the queue`
  }
  return undefined
}

/**
 * The one line a reader gets about a direct merge: the target, the commit, its
 * subject, and the gitlinks it moved. It takes only the four values it says, so the
 * `list` row, the queue run's message and the log's human rendering are all one
 * sentence written once — the rendering used to spell it out a second time from
 * the log record's own fields.
 */
export function directMergeLine(
  commit: Readonly<{ target: string; commit: string; subject: string; gitlinks: readonly string[] }>,
): string {
  const gitlinks = commit.gitlinks.length === 0 ? "" : `; it moved the gitlink at ${commit.gitlinks.join(", ")}`
  return `${commit.target} moved around the queue at ${commit.commit.slice(0, 12)} (${commit.subject})${gitlinks}`
}
