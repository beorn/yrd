/**
 * The STATS box's numbers (watch-redesign items 18–22): what the run
 * journals on this machine say the queue did, counted into TODAY, YSTRDAY
 * and the hour-of-day buckets of the last day, newest first, with the local
 * midnight as a boundary the renderer draws as its own one-character column.
 *
 * Pure. The loader flattens the journals it already read into one
 * {@link RunDecision} per (run, change) decision; nothing here opens a file,
 * and nothing here derives a change's state: a decision is what the run
 * wrote. Off the queue's own machine there are no journals and the box says
 * so through the caller.
 */

import type { JournalRun, Journals } from "@yrd/queue-core"

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

/** Every decision in the journals, in no particular order. */
export function decisionsOf(journals: Journals): readonly RunDecision[] {
  const decisions: RunDecision[] = []
  for (const runs of journals.runs.values()) {
    for (const run of runs) {
      const decision = run.decision
      if (decision !== "merged" && decision !== "failed" && decision !== "stuck" && decision !== "checked") continue
      decisions.push({ at: run.at, decision, duplicate: isDuplicateMerge(run), run: run.id })
    }
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
