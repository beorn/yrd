/** Direct merges on an event queue target. */
import { gitlinkRows, type Git } from "./git.ts"
import { parseChangeName } from "./refs.ts"
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
  /** A Change: trailer names the submitted branch when the direct landing has one. */
  branch?: string
}>

type FirstParentCommit = Readonly<{
  commit: string
  parents: readonly string[]
  at: Date
  subject: string
  changes: readonly string[]
}>

/** The first-parent reader for event direct-merge accounting. Newest first. */
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
 * The queue chain's observed events account for direct-only landings, so a
 * settled direct merge is returned only once across process restarts.
 */
export async function eventDirectMergeCommits(
  git: Git,
  target: string,
  targetSha: string,
  declaration: string,
  histories: Parameters<typeof mergedHistoryCommits>[0],
  observed: ReadonlySet<string> = new Set(),
  options: Readonly<{ allHistory?: boolean }> = {},
): Promise<readonly DirectMerge[]> {
  const accounted = mergedHistoryCommits(histories)
  const line = await firstParentLine(git, targetSha, `${declaration}..${targetSha}`)
  if (targetSha !== declaration && line.at(-1)?.parents[0] !== declaration) {
    throw new Error(`${target} at ${targetSha}: queue declaration ${declaration} is not on its first-parent line`)
  }
  const found: DirectMerge[] = []
  for (const row of line) {
    if (accounted.has(row.commit) || observed.has(row.commit)) {
      if (!options.allHistory) break
      continue
    }
    const first = row.parents[0]
    if (first === undefined) {
      throw new Error(`${target} at ${row.commit}: first-parent line ended after declaration ${declaration}`)
    }
    const named = row.changes.length === 1 ? parseChangeName(row.changes[0] ?? "") : undefined
    const fromTrailer =
      named !== undefined && (named.head === row.commit || row.parents.includes(named.head)) ? named.branch : undefined
    const matching = [...histories].filter(([, history]) => {
      const head = history.state.commit
      return head !== undefined && (head === row.commit || row.parents.includes(head))
    })
    const branch = fromTrailer ?? (matching.length === 1 ? matching[0]?.[0] : undefined)
    found.push({
      ...row,
      target,
      ...(branch === undefined ? {} : { branch }),
      gitlinks: (await gitlinkRows(git, first, row.commit)).map((link) => link.path),
      why: "its commit has no merged event in this queue",
    })
  }
  return found.reverse()
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
