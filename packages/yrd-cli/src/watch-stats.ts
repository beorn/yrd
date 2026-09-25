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
import { STATE_WORDS, runTime } from "./watch-format.ts"

/** One decision a run recorded about a change: the smallest fact STATS counts. */
export type RunDecision = Readonly<{
  run: string
  /** When the run wrote the decision. */
  at: Date
  decision: "merged" | "failed" | "stuck" | "checked"
  /** A merged decision the run made without merging: the change was already on the target. */
  duplicate: boolean
  /**
   * The three durations the box's TIME rows read, each present only when both
   * instants are on the row: opened → this run started (`queuedMs`), this run
   * started → ended (`runMs`), and for a merge that merged, opened → merged
   * (`totalMs`). Milliseconds.
   */
  queuedMs?: number
  runMs?: number
  totalMs?: number
  /** Old merged/failed ending whose Record lacked all phase instants. */
  adoptedPhaseMissing?: true
  /** For a merge that merged: the runs the change took beyond the first — its same-head retries. */
  retries?: number
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
 * A row that recorded a verdict the reader cannot name: a `result` sentence
 * that is neither a check verdict nor the row's own incident, or a journal
 * run whose `decision` is a word this reader does not know. Counted apart and
 * never folded into stuck (@cto 0686be28): a new result vocabulary must show
 * up as a number nobody expected, not as a stuck run nobody had.
 */
export const UNCLASSIFIED = "unclassified"
export type RowVerdict = RowDecision | typeof UNCLASSIFIED

/**
 * What the run behind a row decided, read from the row's own fields — the
 * one rule for a row split by a journal run and for a row that stands for
 * its whole change:
 * 1. a `result` with no `endedAt` is a run that ran checks and recorded no
 *    decision (a re-based or abandoned run): nothing;
 * 2. a `result` says the verdict — `fail …` failed, `stuck …` stuck, `pass …`
 *    merged when the row carries the run's merge commit, a duplicate merge
 *    when it carries the already-on-the-target reason and no commit, checked
 *    otherwise; the row's own incident — the sentence `runRow` writes as
 *    `<code>: …` with that code in `reason` — is a stuck run; any other
 *    sentence is {@link UNCLASSIFIED}, counted apart, never stuck;
 * 3. no `result`: the change's `state` when it is a decision (a replaced or
 *    deleted change reads withdrawn with no run of its own), else nothing.
 * `runRow` (queue core, table.ts) writes exactly these fields from a journal
 * run, so a split row answers as that run and an unsplit row as its change.
 */
export function rowDecision(row: Row): RowVerdict | undefined {
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
    if (row.reason !== undefined && result.startsWith(`${row.reason}:`)) return { decision: "stuck", duplicate: false }
    return UNCLASSIFIED
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
  // Rows per change, for the retries a merged change took: every run beyond its first.
  const runsOf = new Map<string, number>()
  for (const { row } of rows) {
    const change = `${row.branch}@${row.head}`
    runsOf.set(change, (runsOf.get(change) ?? 0) + 1)
  }
  const decisions: RunDecision[] = []
  for (const item of rows) {
    const verdict = verdictOfRow(item)
    if (verdict === undefined || verdict === UNCLASSIFIED) continue
    const at = item.run?.at ?? item.row.at
    if (at === undefined) continue
    const { since, startedAt, endedAt } = item.row
    const merged = verdict.decision === "merged" && !verdict.duplicate
    const spans = {
      ...(since !== undefined && startedAt !== undefined ? { queuedMs: startedAt.getTime() - since.getTime() } : {}),
      ...(startedAt !== undefined && endedAt !== undefined ? { runMs: endedAt.getTime() - startedAt.getTime() } : {}),
      ...(merged && since !== undefined ? { totalMs: at.getTime() - since.getTime() } : {}),
      ...(merged ? { retries: (runsOf.get(`${item.row.branch}@${item.row.head}`) ?? 1) - 1 } : {}),
    }
    decisions.push({
      at,
      ...verdict,
      run: item.run?.id ?? item.row.run ?? `${item.row.branch}@${item.row.head}`,
      ...(item.row.adoptedPhaseMissing === true ? { adoptedPhaseMissing: true as const } : {}),
      ...spans,
    })
  }
  return decisions
}

/** One row's verdict: the journal run's decision when the row was split by one, else the row's own fields. */
export function verdictOfRow(item: WatchRow): RowVerdict | undefined {
  const { row, run } = item
  if (run !== undefined) {
    const decision = run.decision
    // The records a run writes about a change: `opened` and `sent` are not
    // verdicts (the opening, and the notice delivered after an ending), and
    // neither is `withdrawn` (a submission taken out of the line judged no
    // content, @i/10-yrd/24492); the four verdicts count; any other word is
    // one this reader does not know.
    if (decision === undefined || decision === "opened" || decision === "sent" || decision === "withdrawn") {
      return undefined
    }
    if (decision !== "merged" && decision !== "failed" && decision !== "stuck" && decision !== "checked") {
      return UNCLASSIFIED
    }
    return { decision, duplicate: isDuplicateMerge(run) }
  }
  return rowDecision(row)
}

/** The rows whose verdict the reader could not name — see {@link UNCLASSIFIED}. */
export function unclassifiedRows(rows: readonly WatchRow[]): readonly WatchRow[] {
  return rows.filter((item) => verdictOfRow(item) === UNCLASSIFIED)
}

export type StatsBucket = Readonly<{
  key: string
  /** `TODAY`, `YSTRDAY` (item 18), `WEEK`, `MONTH`, or the two-digit hour of day. */
  label: string
  kind: "period" | "hour"
  startMs: number
  endMs: number
  /** A local calendar day starts at or before this bucket, right after the (newer) one to its left (item 20). */
  dayBoundary: boolean
  merges: number
  adoptedMissingPhases: number
  /** Runs that passed every check and merged nothing: a `checked` verdict — the retired box's PASS. */
  passes: number
  duplicates: number
  fails: number
  stuck: number
  /** Distinct runs that wrote a decision in the bucket. */
  runs: number
  /** Medians over the decisions in the bucket that carry the span; absent when none does. */
  totalMs?: number
  queuedMs?: number
  runMs?: number
  /** Mean same-head retries over the merges in the bucket; absent when nothing merged. */
  retries?: number
}>

/** The count rows the box shows, in order: PASS beside MERGES as before, DUP just above FAILS (items 21, 22). */
export const STATS_ROWS = [
  { key: "merges", label: "MERGES" },
  { key: "passes", label: "PASS" },
  { key: "duplicates", label: "DUP" },
  { key: "fails", label: "FAILS" },
  { key: "stuck", label: "STUCK" },
  { key: "runs", label: "RUNS" },
] as const satisfies readonly Readonly<{ key: keyof StatsBucket; label: string }>[]

/**
 * The time rows the box shows under the counts — the retired box's AVG TIME
 * section, as medians (a queue day has a few long outliers and the middle is
 * the number a reader wants): opened → merged, opened → the run started,
 * the run started → ended, and the same-head retries a merge took.
 */
export const STATS_TIME_ROWS = [
  { key: "totalMs", label: "TOTAL" },
  { key: "queuedMs", label: "QUEUING" },
  { key: "runMs", label: "RUNNING" },
  { key: "retries", label: "RETRIES" },
] as const satisfies readonly Readonly<{ key: keyof StatsBucket; label: string }>[]

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle]
  const lower = sorted[middle - 1]
  if (sorted.length % 2 === 1 || lower === undefined || upper === undefined) return upper
  return (lower + upper) / 2
}

const DAY_MS = 24 * 3_600_000

function startOfLocalDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate())
}

function startOfLocalHour(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours())
}

type StatsWindow = Pick<StatsBucket, "key" | "label" | "kind" | "startMs" | "endMs" | "dayBoundary">

/**
 * TODAY, YSTRDAY, 7DAY, 30DAY, then `hours` hour buckets ending at the current
 * hour, newest first, each with its counts and medians. The day boundary is a
 * fact about the bucket, never a character on its label. 7DAY and 30DAY are
 * the last 7 × 24 h and 30 × 24 h ending now; both end now.
 */
export function statsBuckets(decisions: readonly RunDecision[], now: Date, hours = 24): readonly StatsBucket[] {
  const today = startOfLocalDay(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const windows: StatsWindow[] = [
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
    {
      dayBoundary: false,
      endMs: now.getTime() + 1,
      key: "day7",
      kind: "period",
      label: "7DAY",
      startMs: now.getTime() - 7 * DAY_MS,
    },
    {
      dayBoundary: false,
      endMs: now.getTime() + 1,
      key: "day30",
      kind: "period",
      label: "30DAY",
      startMs: now.getTime() - 30 * DAY_MS,
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
  return windows.map((window) => bucketOf(window, decisions))
}

/** One window's counts and medians over the decisions inside it: the one derivation every STATS number reads. */
function bucketOf(window: StatsWindow, decisions: readonly RunDecision[]): StatsBucket {
  const inside = decisions.filter(
    (decision) => decision.at.getTime() >= window.startMs && decision.at.getTime() < window.endMs,
  )
  const spans = (key: "totalMs" | "queuedMs" | "runMs" | "retries"): readonly number[] =>
    inside.flatMap((decision) => (decision[key] === undefined ? [] : [decision[key]]))
  const retries = spans("retries")
  const medians = {
    ...(spans("totalMs").length === 0 ? {} : { totalMs: median(spans("totalMs")) }),
    ...(spans("queuedMs").length === 0 ? {} : { queuedMs: median(spans("queuedMs")) }),
    ...(spans("runMs").length === 0 ? {} : { runMs: median(spans("runMs")) }),
    ...(retries.length === 0 ? {} : { retries: retries.reduce((sum, value) => sum + value, 0) / retries.length }),
  }
  return {
    ...window,
    duplicates: inside.filter((decision) => decision.duplicate).length,
    fails: inside.filter((decision) => decision.decision === "failed").length,
    merges: inside.filter((decision) => decision.decision === "merged" && !decision.duplicate).length,
    adoptedMissingPhases: inside.filter((decision) => decision.adoptedPhaseMissing === true).length,
    passes: inside.filter((decision) => decision.decision === "checked").length,
    runs: new Set(inside.map((decision) => decision.run)).size,
    stuck: inside.filter((decision) => decision.decision === "stuck").length,
    ...medians,
  }
}

/** The last 24 hours back from `now`, as one period bucket: what the STATS line summarises (25416). */
export function lastDayBucket(decisions: readonly RunDecision[], now: Date): StatsBucket {
  const window: StatsWindow = {
    dayBoundary: false,
    endMs: now.getTime() + 1,
    key: "24h",
    kind: "period",
    label: "24H",
    startMs: now.getTime() - 86_400_000,
  }
  return bucketOf(window, decisions)
}

/**
 * The STATS line's summary (25416): what is in hand now, then the last 24
 * hours' median wait and run and its verdicts —
 * `current: 8 drafts (1d), 98 older, 7 waiting · 24h: 03:12 wait, 11:40 run, 7 merges, 3 failed, 2 stuck`.
 * `current.drafts` is the drafts phrase (`draftsSaid`), absent when there are none; the
 * changes in line are said in the watch's own word for them, never the core's `queued`.
 * `day` is absent when no run journal was read, and the line says so rather
 * than print zeros that were never measured.
 */
export function statsSummary(
  current: Readonly<{ drafts: string | undefined; waiting: number }>,
  day: StatsBucket | undefined,
  journalAbsent?: string,
): string {
  const now = `current: ${current.drafts ?? `0 ${STATE_WORDS.draft.word}s`}, ${String(current.waiting)} ${STATE_WORDS.waiting.word}`
  if (day === undefined) return `${now} · 24h: ${journalAbsent ?? "no run journal read on this machine"}`
  const span = (ms: number | undefined): string => (ms === undefined ? "—" : runTime(ms))
  return (
    `${now} · 24h: ${span(day.queuedMs)} wait, ${span(day.runMs)} run, ` +
    `${counted(day.merges, "merge")}, ${String(day.fails)} failed, ${String(day.stuck)} stuck` +
    (day.adoptedMissingPhases === 0 ? "" : `, ${String(day.adoptedMissingPhases)} adopted without phase times`)
  )
}

function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`
}

/** A count as the box prints it: right-aligned by the caller, and never `0` where a blank reads better in a strip of hours. */
export function countCell(bucket: StatsBucket, key: (typeof STATS_ROWS)[number]["key"]): string {
  const value = bucket[key]
  return bucket.kind === "hour" && value === 0 ? "·" : String(value)
}

/**
 * A duration in the fewest characters that still say the unit — an hour cell
 * is three wide: `45s`, `24m`, `2h`, `3d`. Rounded to the unit, so `59m` is
 * the last minute reading and `1h` the first hour one.
 */
export function shortDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)}h`
  return `${String(Math.round(hours / 24))}d`
}

/**
 * A TIME cell: the bucket's median as a short duration, the retries as a
 * mean with one decimal, and `·` (an hour) or `—` (a period) where nothing
 * in the bucket carried the span — no data, said apart from a zero.
 */
export function timeCell(bucket: StatsBucket, key: (typeof STATS_TIME_ROWS)[number]["key"]): string {
  const value = bucket[key]
  if (value === undefined) return bucket.kind === "hour" ? "·" : "—"
  if (key === "retries") return value.toFixed(1)
  return shortDuration(value)
}
