/**
 * One change's HISTORY and METADATA as the Changes tab draws them
 * (watch-redesign items 4, 6, 31): pure projections over the change's own
 * events and the row the core derived. No React, no I/O, and no derivation
 * of state — a history row says what an event says.
 *
 * HISTORY: one line per event, newest first. Current status lives in the
 * status box alone.
 *
 * METADATA: three blank-line-separated groups, no labels, keys muted
 * uppercase in one fixed-width column — identity, dates, code. LIVE facts
 * (position, age, wait) are NOT here; they moved to the status box.
 */

import type { Event, Row } from "@yrd/queue-core"
import { DISCLOSURE_MARKERS } from "silvery"
import { clock, mediaDuration } from "./watch-format.ts"

export type HistoryEntry = Readonly<{
  at: Date
  text: string
  /** Something more the record said, rendered after ` — `. */
  detail?: string
  /** This entry opened a cut: a submit, or a resubmit of the branch (25441's cut counter). */
  opens?: true
}>

/** Every selected event as a history line; the event fold has already validated Time:. */
export function eventHistoryEntries(events: readonly Event[]): readonly HistoryEntry[] {
  return [...events].reverse().map((event) => {
    const field = (key: string) => event.props.find(([name]) => name === key)?.[1]
    const time = field("Time")
    if (time === undefined) throw new Error(`event ${event.id} has no Time:`)
    const at = new Date(time)
    if (Number.isNaN(at.getTime())) throw new Error(`event ${event.id} has invalid Time: ${time}`)
    const reason = field("Reason")
    const commit = field("Commit")
    const detail = [reason, commit === undefined ? undefined : `commit ${commit.slice(0, 12)}`]
      .filter((part): part is string => part !== undefined)
      .join(" · ")
    return {
      at,
      text: `${event.type}${event.writer === null ? "" : ` by ${event.writer}`}`,
      ...(detail === "" ? {} : { detail }),
      ...(event.type === "opened" ? { opens: true as const } : {}),
    }
  })
}

/** One line of the timeline tab: a history entry, oldest first, with how long until the next. */
export type TimelineEntry = HistoryEntry & Readonly<{ toNextMs?: number }>

/**
 * The timeline tab (25441): the change's own history for the cut this detail
 * is about, oldest first, with each entry's time to the next, led by
 * `drafted` (the head commit's date) when it is known. `cut` is that cut's
 * place among the branch's cuts (every submit and resubmit), so an earlier
 * cut is its own timeline, never folded into this one. The ending (merged,
 * failed, stuck, cancelled) is last and has no time to a next.
 */
export function timelineOf(
  history: readonly HistoryEntry[],
  drafted: Date | undefined,
): Readonly<{ entries: readonly TimelineEntry[]; cut: number; cuts: number }> {
  const oldestFirst = [...history].sort((left, right) => left.at.getTime() - right.at.getTime())
  const cuts = oldestFirst.filter((entry) => entry.opens === true).length
  const lastOpening = oldestFirst.findLastIndex((entry) => entry.opens === true)
  const thisCut = lastOpening < 0 ? oldestFirst : oldestFirst.slice(lastOpening)
  const lead: HistoryEntry[] =
    drafted === undefined || (thisCut[0] !== undefined && drafted.getTime() > thisCut[0].at.getTime())
      ? []
      : [{ at: drafted, text: "drafted" }]
  const timeline = [...lead, ...thisCut]
  return {
    cut: Math.max(cuts, 1),
    cuts: Math.max(cuts, 1),
    entries: timeline.map((entry, index) => {
      const next = timeline[index + 1]
      return next === undefined ? entry : { ...entry, toNextMs: next.at.getTime() - entry.at.getTime() }
    }),
  }
}

/** One `KEY value` row of the metadata block. */
export type MetadataFact = Readonly<{ key: string; value: string }>

/** What git said about the commits a change carries past its base, read by the loader. */
export type ChangeCommits = Readonly<{
  /** The first commit past the base: the branch's age anchor (`firstCommitAt`). */
  first?: Date
  /** The head's own committer date (`lastCommitAt`). */
  last?: Date
  count: number
}>

/**
 * The three groups, in order, each with only the facts that exist. An empty
 * group is dropped rather than rendered as a blank.
 */
export function metadataGroups(
  row: Row,
  now: Date,
  about: Readonly<{ commits?: ChangeCommits; runId?: string }> = {},
): readonly (readonly MetadataFact[])[] {
  const when = (at: Date): string => `${clock(at)} · ${mediaDuration(now.getTime() - at.getTime())} ago`
  const identity: MetadataFact[] = [
    ...(row.issue === undefined ? [] : [{ key: "ISSUE", value: row.issue }]),
    ...(row.submitter === undefined ? [] : [{ key: "BY", value: row.submitter }]),
  ]
  const commits = about.commits
  const dates: MetadataFact[] = [
    ...(row.since === undefined ? [] : [{ key: "CREATED", value: when(row.since) }]),
    ...(row.at === undefined ? [] : [{ key: "UPDATED", value: when(row.at) }]),
    ...(commits === undefined
      ? []
      : [
          {
            key: "COMMITS",
            value: [
              commits.first === undefined ? undefined : `first ${clock(commits.first)}`,
              commits.last === undefined ? undefined : `last ${clock(commits.last)}`,
              `${String(commits.count)} ${commits.count === 1 ? "commit" : "commits"}`,
            ]
              .filter((part): part is string => part !== undefined)
              .join(" · "),
          },
        ]),
  ]
  const code: MetadataFact[] = [
    { key: "HEAD", value: row.head.slice(0, 12) },
    ...(row.base === undefined ? [] : [{ key: "BASE", value: row.base.slice(0, 12) }]),
    ...(row.merge === undefined ? [] : [{ key: "MERGE", value: row.merge.slice(0, 12) }]),
    // The full run id lives here and in --json; the short form is for the border and the RUN column.
    ...(about.runId === undefined ? [] : [{ key: "RUN", value: about.runId }]),
  ]
  return [identity, dates, code].filter((group) => group.length > 0)
}

/** The one column every key pads to: the longest key plus two. */
export function metadataKeyWidth(groups: readonly (readonly MetadataFact[])[]): number {
  return Math.max(0, ...groups.flat().map((fact) => fact.key.length)) + 2
}

/** The section disclosure and its diff counts, using Silvery's one-cell markers. */
export function diffSummary(stat: Readonly<{ additions: number; deletions: number }>, expanded: boolean): string {
  return `${expanded ? DISCLOSURE_MARKERS.expanded : DISCLOSURE_MARKERS.collapsed} Diff +${String(stat.additions)} −${String(stat.deletions)}`
}
