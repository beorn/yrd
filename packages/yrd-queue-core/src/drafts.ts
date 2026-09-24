/**
 * Drafts: work pushed to the queue's remote that nobody submitted
 * (@i/10-yrd/24196).
 *
 * THE ONE DEFINITION. A draft is a branch head the remote advertises that
 *
 * - no change ref names AT THAT HEAD: a branch submitted once and pushed again
 *   is a draft again, because its new head is nobody's change;
 * - is off the target: neither the target commit nor one of its ancestors;
 * - is outside {@link DRAFT_EXCLUDED_PREFIXES}: the queue's own `yrd/*` refs,
 *   which nobody submits, and `preserve/*`, branches kept on purpose;
 * - was committed inside the window, when the window has an edge.
 *
 * A head this repository has not read is off the target by its absence (the
 * target's whole history is here) and has no date or author to read, so it is
 * counted apart as undated: never dropped, and never a blank row.
 *
 * Read from the queue read's own advertisement (`readQueue`'s `heads` and its
 * changes), never a second `ls-remote`, in at most three batched git calls and
 * never one per branch: presence, then the date and author of the present
 * heads, then the window, then ONE ancestry walk over the present heads inside
 * it. A negative revision makes the walk a range, so `rev-list` lists every
 * commit those heads have that the target lacks, not one line per head, and a
 * head is off the target exactly when it is among them (measured on the hh
 * remote, 2026-09-16: 7,746 heads, 12,396 commits listed, 0.04 s).
 *
 * Nothing here fetches. The watch's loader fetches the heads it has not read,
 * once, outside any render; `yrd queue stats` fetches nothing and counts them
 * undated.
 */

import { offTheTarget } from "./git.ts"
import type { Git } from "./records.ts"

type DraftSource = Readonly<{
  heads: ReadonlyMap<string, string>
  changes: readonly Readonly<{ change: Readonly<{ branch: string; head: string }> }>[]
}>

/** The branch namespaces that are never drafts: the queue's own refs, and branches kept on purpose. */
export const DRAFT_EXCLUDED_PREFIXES: readonly string[] = ["yrd/", "preserve/"]

/** The watch's draft window: a draft committed longer ago than this shows only when every draft is asked for. */
export const DRAFT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Inside the window, a draft committed longer ago than this folds into a count (25424): the home view is a board, not a log. */
export const DRAFT_ROW_MS = 24 * 60 * 60 * 1000

export type Draft = Readonly<{
  branch: string
  head: string
  /** The head commit's committer instant; absent while the commit is not in this repository. */
  committedAt?: Date
  /** The head commit's author; absent while the commit is not in this repository. */
  author?: string
  /** A change ref names this branch at another head: the head moved since its last submit. */
  movedSinceSubmit: boolean
}>

export type DraftReading = Readonly<{
  /** The drafts this repository has read, inside the window, newest first. */
  dated: readonly Draft[]
  /** The drafts whose head this repository has not read: undated, whatever the window. */
  undated: readonly Draft[]
}>

/**
 * The drafts of one queue reading. `since` is the window's edge; absent, every
 * draft this repository can date is inside it.
 */
export async function readDrafts(
  git: Git,
  read: DraftSource,
  options: Readonly<{ targetSha: string; since?: Date }>,
): Promise<DraftReading> {
  const submittedHeads = new Set(read.changes.map((entry) => `${entry.change.branch}@${entry.change.head}`))
  const submittedBranches = new Set(read.changes.map((entry) => entry.change.branch))
  const candidates = [...read.heads]
    .filter(
      ([branch, head]) =>
        !DRAFT_EXCLUDED_PREFIXES.some((prefix) => branch.startsWith(prefix)) &&
        !submittedHeads.has(`${branch}@${head}`),
    )
    .map(([branch, head]): Draft => ({ branch, head, movedSinceSubmit: submittedBranches.has(branch) }))
  if (candidates.length === 0) return { dated: [], undated: [] }

  const present = await presentCommits(git, [...new Set(candidates.map((draft) => draft.head))])
  const facts = await commitFacts(git, [...present])
  const since = options.since?.getTime()
  const inWindow = candidates.flatMap((draft) => {
    const fact = facts.get(draft.head)
    return fact === undefined || (since !== undefined && fact.committedAt.getTime() < since)
      ? []
      : [{ ...draft, ...fact }]
  })
  const offTarget = await offTheTarget(git, [...new Set(inWindow.map((draft) => draft.head))], options.targetSha)
  return {
    dated: inWindow
      .filter((draft) => offTarget.has(draft.head))
      .sort((left, right) => right.committedAt.getTime() - left.committedAt.getTime()),
    undated: candidates.filter((draft) => !present.has(draft.head)),
  }
}

/** The shas among these that name a commit in this repository, in one `cat-file` batch. */
async function presentCommits(git: Git, shas: readonly string[]): Promise<ReadonlySet<string>> {
  const answer = await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${shas.join("\n")}\n`)
  return new Set(
    answer
      .split("\n")
      .map((line) => line.trim().split(" "))
      .filter((parts) => parts[1] === "commit")
      .map((parts) => parts[0] ?? ""),
  )
}

/** Each present commit's committer instant and author, in one no-walk `log`; a commit git does not answer for is loud. */
async function commitFacts(
  git: Git,
  shas: readonly string[],
): Promise<ReadonlyMap<string, Readonly<{ committedAt: Date; author: string }>>> {
  const facts = new Map<string, Readonly<{ committedAt: Date; author: string }>>()
  if (shas.length === 0) return facts
  const out = await git(["log", "--no-walk=unsorted", "--stdin", "--format=%H %ct %an"], `${shas.join("\n")}\n`)
  for (const line of out.split("\n")) {
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\d+) (.*)$/u.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) continue
    facts.set(match[1], { author: match[3] ?? "", committedAt: new Date(Number(match[2]) * 1000) })
  }
  const unanswered = shas.filter((sha) => !facts.has(sha))
  if (unanswered.length > 0) {
    throw new Error(`git log gave no committer date for present commit(s) ${unanswered.join(", ")}`)
  }
  return facts
}

/** The window's drafts that are rows, in their order, and how many older ones fold into a count (25424). */
export function foldDrafts(dated: readonly Draft[], now: Date): Readonly<{ rows: readonly Draft[]; older: number }> {
  const rows = dated.filter(
    (draft) => draft.committedAt !== undefined && now.getTime() - draft.committedAt.getTime() <= DRAFT_ROW_MS,
  )
  return { rows, older: dated.length - rows.length }
}
