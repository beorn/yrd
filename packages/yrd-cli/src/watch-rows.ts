/**
 * The watch's list rows: what a filter matches, what `--latest` collapses, and
 * the ONE renderer both the watch and plain `yrd queue list` draw a row with.
 *
 * Pure. Every input is a `Row` the core already derived and a journal reading
 * the core already made; nothing here opens a ref, a file or a process, and
 * nothing here derives a state — `readChange` owns that and this consumes it.
 *
 * Two rows exist per change where the journal is readable, and one where it is
 * not. That asymmetry is the honest one: the default lens preserves every run
 * that touched a change (S2.13, README 1096), and a machine that holds no run
 * journal cannot know a change had more than one run. `--latest` is the opt-in
 * collapse to one row per change, which is what a reader wants when they are
 * asking "where does this branch stand" rather than "what has the queue done".
 */

import type { Row, WatchRow } from "@yrd/queue-core"
import { stateGlyph } from "./watch-format.ts"
export { watchRows, watchRowKey, type WatchRow, type WatchRowOptions } from "@yrd/queue-core"

/**
 * Whether a row answers to a filter term: case-insensitive, and an OR across
 * the four fields a reader actually types — the branch, the change's own
 * subject, the queue run, and the failure (S2.12, README 1093).
 *
 * "Failure" is `result` and `reason` together, because the two spell one
 * thing between them: `fail test` on one side and the check's code on the
 * other, and a reader typing `conflict` means either.
 */
export function matchesTerm(row: WatchRow, term: string): boolean {
  const wanted = term.trim().toLocaleLowerCase()
  if (wanted === "") return true
  return [row.row.branch, row.row.subject, row.run?.id ?? row.row.run, row.row.result, row.row.reason].some(
    (field) => field?.toLocaleLowerCase().includes(wanted) === true,
  )
}

/** Every row matching ANY of the terms; no terms is no filter, not no rows. */
export function filterRows(rows: readonly WatchRow[], terms: readonly string[]): readonly WatchRow[] {
  const wanted = terms.map((term) => term.trim()).filter((term) => term !== "")
  if (wanted.length === 0) return rows
  return rows.filter((row) => wanted.some((term) => matchesTerm(row, term)))
}

/** The glyph for a row: the running one while a check runs on it, else its state's — the one table in watch-primitives. */
export function rowGlyph(row: Row): string {
  return stateGlyph(row)
}

/**
 * One row, rendered. The ONE renderer: plain `yrd queue list` and the watch's
 * list both draw a row here, so the two can never drift into different columns
 * for the same change. It replaces `table()`/`line()`, which lived in
 * queue-core-commands.ts and knew nothing of a subject or a run.
 *
 * Extra columns appear only when there is something to put in them, so the
 * plain list of a repository with no journal and no fetched subjects prints
 * exactly the line it printed before.
 */
export function rowLine(row: WatchRow): string {
  const position = row.row.position === undefined ? "  " : String(row.row.position).padStart(2)
  const result = row.row.result ?? row.row.reason ?? ""
  // The run this line is about: the one it was split by, else the one the
  // record or the journal named, else the one running a check on it right
  // now — which is the run, whatever else is known.
  const run = row.run?.id ?? row.row.run ?? row.row.live?.run
  return [
    `${position} ${row.row.state.padEnd(7)} ${row.row.branch} ${row.row.head.slice(0, 12)} ${result}`,
    row.row.issue === undefined ? "" : ` ${row.row.issue}`,
    // A direct merge's whole line IS its reason, subject and all, so adding
    // the subject beside it printed it twice. Anything the result already
    // says is not said again.
    row.row.subject === undefined || result.includes(row.row.subject) ? "" : ` ${row.row.subject}`,
    run === undefined ? "" : ` [${run}]`,
    row.row.live === undefined ? "" : ` (${row.row.live.check} running)`,
  ]
    .join("")
    .trimEnd()
}

/** Every row, one per line, or the one sentence that says there are none. */
export function rowTable(rows: readonly WatchRow[]): string {
  if (rows.length === 0) return "nothing in line"
  return rows.map(rowLine).join("\n")
}
