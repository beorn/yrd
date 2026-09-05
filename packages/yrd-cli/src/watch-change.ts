/**
 * One change's HISTORY and METADATA as the Changes tab draws them
 * (watch-redesign items 4, 6, 31): pure projections over the change's own
 * records and the row the core derived. No React, no I/O, and no derivation
 * of state — a history row says what a record says, in the ruled words.
 *
 * HISTORY: one line per record, newest first, a human verb only where a
 * human acted (`submitted by @chief`); machine rows read as what the queue
 * did (`checked at 3c285a41`, `merged as b234234a`). The `sent` echo renders
 * only when delivery FAILED, the way item 31 keeps the `check requested` echo
 * only when it failed or drifted: a message that went where it should is not
 * news. No status is fused onto a history row; the current state lives in the
 * status box alone.
 *
 * METADATA: three blank-line-separated groups, no labels, keys muted
 * uppercase in one fixed-width column — identity, dates, code. LIVE facts
 * (position, age, wait) are NOT here; they moved to the status box.
 */

import { trailer, type ChangeRecord, type Row } from "@yrd/queue-core"
import { clock, mediaDuration } from "./watch-format.ts"

export type HistoryEntry = Readonly<{
  at: Date
  text: string
  /** Something more the record said, rendered after ` — `. */
  detail?: string
}>

/** The records of one change as history rows, newest first. */
export function historyEntries(records: readonly ChangeRecord[]): readonly HistoryEntry[] {
  const entries: HistoryEntry[] = []
  const oldestFirst = [...records].sort((left, right) => left.at.getTime() - right.at.getTime())
  let openings = 0
  for (const record of oldestFirst) {
    const entry = historyEntry(record, record.kind === "opened" ? openings++ : 0)
    if (entry !== undefined) entries.push(entry)
  }
  return entries.sort((left, right) => right.at.getTime() - left.at.getTime())
}

function historyEntry(record: ChangeRecord, earlierOpenings: number): HistoryEntry | undefined {
  const short = (sha: string | undefined): string => (sha === undefined ? "" : sha.slice(0, 12))
  switch (record.kind) {
    case "opened": {
      // The same head submitted again is a retry (a submit at an unchanged
      // head appends an opened record): the human acted twice, and says so.
      const verb = earlierOpenings === 0 ? "submitted" : "resubmitted"
      const by = trailer(record, "Submitter")
      return { at: record.at, text: by === undefined ? verb : `${verb} by ${by}` }
    }
    case "checked": {
      const base = trailer(record, "Base")
      return { at: record.at, text: base === undefined ? "checked" : `checked at ${short(base)}` }
    }
    case "merged": {
      const merge = trailer(record, "Merge")
      const by = trailer(record, "Merged-By")
      return {
        at: record.at,
        text: merge === undefined ? "merged" : `merged as ${short(merge)}`,
        ...(by === undefined || by === "queue" ? {} : { detail: `by ${by}` }),
      }
    }
    case "failed": {
      const reason = trailer(record, "Reason")
      const detail = trailer(record, "Detail") ?? trailer(record, "Remedy")
      return {
        at: record.at,
        text: reason === undefined ? "failed" : `failed ${reason}`,
        ...(detail === undefined ? {} : { detail }),
      }
    }
    case "stuck": {
      const reason = trailer(record, "Reason") ?? trailer(record, "Code")
      return { at: record.at, text: reason === undefined ? "stuck" : `stuck ${reason}` }
    }
    case "sent": {
      // A message that went where it should is not news (item 31's echo rule).
      const delivery = trailer(record, "Delivery")
      if (delivery !== "failed") return undefined
      const to = trailer(record, "To")
      return { at: record.at, text: `message to ${to ?? "the submitter"} failed` }
    }
    default:
      return undefined
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
  const when = (at: Date): string =>
    `${clock(at, { seconds: true })} · ${mediaDuration(now.getTime() - at.getTime())} ago`
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

/** The fold's summary line (item 4/31): `▶ Diff +A −B`, plain triangle (U+FE0E), unicode minus before the deletions. */
export function diffSummary(stat: Readonly<{ additions: number; deletions: number }>, expanded: boolean): string {
  return `${expanded ? "▼︎" : "▶︎"} Diff +${String(stat.additions)} −${String(stat.deletions)}`
}
