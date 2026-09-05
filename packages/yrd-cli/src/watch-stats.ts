/**
 * The STATS box's numbers (watch-redesign items 18–22): what the queue's own
 * rows say it did — one row per run per change, the rows `queue list`, the
 * watch and `queue stats` all read — counted into TODAY, YSTRDAY and the
 * hour-of-day buckets of the last day, newest first, with the local midnight
 * as a boundary the renderer draws as its own one-character column.
 *
 * Pure. {@link decisionsOfRows} turns rows into one {@link RunDecision} per
 * decided row; nothing here opens a file, and nothing here derives a change's
 * state: a decision is what the row's run recorded. This is the ONE
 * classification the pane and `queue stats` share (@cto 6acce2e2: one source
 * as well as one classification; the journal-based flattening is gone), so
 * the STATS box counts the same everywhere the rows can be read, on and off
 * the queue's own machine.
 */

import type { JournalRun, Row, WatchRow } from "@yrd/queue-core"

/** One decision a run recorded about a change: the smallest fact STATS counts. */
export type RunDecision = Readonly<{
  run: string
  /** When the run wrote the decision. */
  at: Date
  decision: "merged" | "failed" | "stuck" | "checked"
  /** A merged decision the run made without merging: the change was already on the target. */
  duplicate: boolean
}>

/**
 * Whether a merged decision merged nothing: today the journal says so in a
 * sentence (`reason: "already on the target"`, run.ts) and records no merge
 * commit for it. ONE named predicate, tested, so no component sniffs the
 * sentence; a structured field on the record is the minimal core ask that
 * retires the string half of it.
 */
export function isDuplicateMerge(run: Pick<JournalRun, "decision" | "reason" | "merge">): boolean {
  return run.decision === "merged" && run.merge === undefined && run.reason === "already on the target"
}

/** One row's verdict, with whether it merged nothing: the reader's one answer per row. */
export type RowDecision = Readonly<{ decision: RunDecision["decision"]; duplicate: boolean }>

/**
 * What the run behind a row decided, read from the row's own fields — the
 * one rule for a row split by a journal run and for a row that stands for
 * its whole change:
 * 1. a `result` with no `endedAt` is a run that ran checks and recorded no
 *    decision (a re-based or abandoned run): nothing;
 * 2. a `result` says the verdict — `fail …` failed, `stuck …` stuck, `pass …`
 *    merged when the row carries the run's merge commit, a duplicate merge
 *    when it carries the already-on-the-target reason and no commit, checked
 *    otherwise; any other sentence with an `endedAt` is a stuck run's incident;
 * 3. no `result`: the change's `state` when it is a decision (a replaced or
 *    deleted change reads failed with no run of its own), else nothing.
 * `runRow` (queue core, table.ts) writes exactly these fields from a journal
 * run, so a split row answers as that run and an unsplit row as its change.
 */
export function rowDecision(row: Row): RowDecision | undefined {
  const result = row.result
  if (result !== undefined) {
    if (row.endedAt === undefined) return undefined
    if (result.startsWith("fail")) return { decision: "failed", duplicate: false }
    if (result.startsWith("stuck")) return { decision: "stuck", duplicate: false }
    if (result.startsWith("pass")) {
      if (row.merge !== undefined) return { decision: "merged", duplicate: false }
      const duplicate = isDuplicateMerge({ decision: "merged", merge: row.merge, reason: row.reason })
      return duplicate ? { decision: "merged", duplicate: true } : { decision: "checked", duplicate: false }
    }
    return { decision: "stuck", duplicate: false }
  }
  switch (row.state) {
    case "merged":
      return {
        decision: "merged",
        duplicate: isDuplicateMerge({ decision: "merged", merge: row.merge, reason: row.reason }),
      }
    case "failed":
    case "stuck":
    case "checked":
      return { decision: row.state, duplicate: false }
    default:
      return undefined
  }
}

/**
 * The smallest fact STATS counts, one per decided row. A row split by a
 * journal run answers with that run's own decision (the journal is the
 * record); an unsplit row answers through {@link rowDecision}. The run is
 * the journal's when one split the change, else the row's own, else the
 * change itself, so `runs` counts distinct deciders wherever it is read.
 */
export function decisionsOfRows(rows: readonly WatchRow[]): readonly RunDecision[] {
  const decisions: RunDecision[] = []
  for (const { row, run } of rows) {
    if (run !== undefined) {
      const decision = run.decision
      if (decision !== "merged" && decision !== "failed" && decision !== "stuck" && decision !== "checked") continue
      decisions.push({ at: run.at, decision, duplicate: isDuplicateMerge(run), run: run.id })
      continue
    }
    const decided = rowDecision(row)
    if (decided === undefined || row.at === undefined) continue
    decisions.push({ at: row.at, ...decided, run: row.run ?? `${row.branch}@${row.head}` })
  }
  return decisions
}

export type StatsBucket = Readonly<{
  key: string
  /** `TODAY`, `YSTRDAY` (item 18), or the two-digit hour of day. */
  label: string
  kind: "period" | "hour"
  startMs: number
  endMs: number
  /** A local calendar day starts at or before this bucket, right after the (newer) one to its left (item 20). */
  dayBoundary: boolean
  merges: number
  duplicates: number
  fails: number
  stuck: number
  /** Distinct runs that wrote a decision in the bucket. */
  runs: number
}>

/** The rows the box shows, in order: DUP sits just above FAILS (items 21, 22). */
export const STATS_ROWS = [
  { key: "merges", label: "MERGES" },
  { key: "duplicates", label: "DUP" },
  { key: "fails", label: "FAILS" },
  { key: "stuck", label: "STUCK" },
  { key: "runs", label: "RUNS" },
] as const satisfies readonly Readonly<{ key: keyof StatsBucket; label: string }>[]

function startOfLocalDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate())
}

function startOfLocalHour(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours())
}

/**
 * TODAY, YSTRDAY, then `hours` hour buckets ending at the current hour,
 * newest first, each with its counts. The day boundary is a fact about the
 * bucket, never a character on its label.
 */
export function statsBuckets(decisions: readonly RunDecision[], now: Date, hours = 24): readonly StatsBucket[] {
  const today = startOfLocalDay(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const windows: Omit<StatsBucket, "merges" | "duplicates" | "fails" | "stuck" | "runs">[] = [
    {
      dayBoundary: false,
      endMs: now.getTime() + 1,
      key: "today",
      kind: "period",
      label: "TODAY",
      startMs: today.getTime(),
    },
    {
      dayBoundary: false,
      endMs: today.getTime(),
      key: "yesterday",
      kind: "period",
      label: "YSTRDAY",
      startMs: yesterday.getTime(),
    },
  ]
  const hour = startOfLocalHour(now)
  let previousDay: string | undefined
  for (let back = 0; back < hours; back += 1) {
    const start = new Date(hour.getTime() - back * 3_600_000)
    // Local arithmetic, so a daylight-saving step lands on the wall-clock hour it names.
    const startLocal = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours())
    const day = `${String(startLocal.getFullYear())}-${String(startLocal.getMonth())}-${String(startLocal.getDate())}`
    windows.push({
      dayBoundary: previousDay !== undefined && previousDay !== day,
      endMs: startLocal.getTime() + 3_600_000,
      key: `h${String(back)}`,
      kind: "hour",
      label: String(startLocal.getHours()).padStart(2, "0"),
      startMs: startLocal.getTime(),
    })
    previousDay = day
  }
  return windows.map((window) => {
    const inside = decisions.filter(
      (decision) => decision.at.getTime() >= window.startMs && decision.at.getTime() < window.endMs,
    )
    return {
      ...window,
      duplicates: inside.filter((decision) => decision.duplicate).length,
      fails: inside.filter((decision) => decision.decision === "failed").length,
      merges: inside.filter((decision) => decision.decision === "merged" && !decision.duplicate).length,
      runs: new Set(inside.map((decision) => decision.run)).size,
      stuck: inside.filter((decision) => decision.decision === "stuck").length,
    }
  })
}

/** A count as the box prints it: right-aligned by the caller, and never `0` where a blank reads better in a strip of hours. */
export function countCell(bucket: StatsBucket, key: (typeof STATS_ROWS)[number]["key"]): string {
  const value = bucket[key]
  return bucket.kind === "hour" && value === 0 ? "·" : String(value)
}
