/**
 * The frame the watch and the printed page share — spelled ONCE — and THE ONE
 * BAND ORDER of the flow page, which is the reason this file exists.
 *
 * Down the screen: **drafts · waiting · the runner · done**. Within each band
 * the rows are newest first, so TIME decreases going down on both sides of the
 * runner and DISTANCE FROM THE RUNNER IS DISTANCE IN TIME FROM NOW, in both
 * directions. The bottom waiting row is the oldest submission and the front of
 * the line — it goes next; the top done row is what just came out.
 *
 * The order lives here and both surfaces render it through {@link bandPlan},
 * because the last order they each spelled by hand drifted apart within
 * eighteen months: the pane got RUNNER back above the table while `yrd list`
 * still printed it last (2026-09-05). An edit that changes the bands in
 * `watch-print.tsx` alone has done half the change, and the half it skipped is
 * the half that regresses.
 *
 * Under the title, both draw the queue line (@i/10-yrd/24196): how many
 * changes wait and why the line is not moving, read from the whole reading
 * whatever a selector narrowed the table to, as the stop and STATS are.
 */

import type { ReactNode } from "react"
import { Box, Text } from "silvery"
import type { Row } from "@yrd/queue-core"
import { useNow } from "./watch-clock.ts"
import { RUNNER_GLYPH, STATE_WORDS, clock, displayState, mediaDuration } from "./watch-format.ts"
import type { RunnerState } from "./watch-words.ts"
import { RunnerRow, clockOf, type ListLayout } from "./watch-list.tsx"
import { TitledBox } from "./watch-primitives.tsx"
import { runnerLine } from "./watch-runner.ts"
import type { WatchSnapshot } from "./watch-pane.tsx"
import type { WatchRow } from "./watch-rows.ts"

/**
 * One loud line above the title. The retired box carried the pause on its own
 * rail and this line only spoke when there was no box; the runner's row is
 * always there now, and it says the WORD `paused` and what lifts the stop, not
 * the record's own sentence — so the sentence still appears exactly once, and
 * it appears where the loudest state on the page belongs.
 */
export function LoudPause({ snapshot }: { snapshot: Pick<WatchSnapshot, "pause"> }) {
  return snapshot.pause === undefined ? null : (
    <Text bold color="$fg-warning" wrap="truncate">
      {snapshot.pause}
    </Text>
  )
}

/**
 * The line as the rows say it: every change holding a place in it, ONCE
 * however many run rows it has. `held` is the change a check runs on right
 * now; `waiting` is every other one. The queue line and the RUNNER rail both
 * count from here, so they cannot disagree.
 */
export function lineOf(rows: readonly WatchRow[]): Readonly<{ held: Row | undefined; waiting: readonly Row[] }> {
  const changes = new Map<string, Row>()
  for (const { row } of rows) {
    if (row.position === undefined) continue
    const key = `${row.branch}@${row.head}`
    if (!changes.has(key) || row.live !== undefined) changes.set(key, row)
  }
  const inLine = [...changes.values()]
  return {
    held: inLine.find((row) => row.live !== undefined),
    waiting: inLine.filter((row) => row.live === undefined),
  }
}

/**
 * The queue line: `5 waiting: 2 pending, 2 submitted, 1 stuck · checking
 * task/x for 3:21 · line stopped at task/s since 11:54 · last merge 11:56
 * (task/y) · 2 drafts (7d), 1 not yet read`.
 *
 * It never wraps. Past its width it drops, in order: the drafts, the
 * breakdown, the last merge's branch, the last merge, the times, the branch
 * and actor names. The waiting count, the check and the stop never drop
 * entirely. The stop is the reading's own (`stopped`, queue-core `stopFact`):
 * a stuck stop names the change it waits on, and an operator's pause names
 * none and says who paused.
 */
export function queueLine(snapshot: WatchSnapshot, now: Date, width: number): string {
  const { held, waiting } = lineOf(snapshot.unfiltered)
  const breakdownCounts = new Map<string, number>()
  for (const key of ["pending", "submitted", "stuck"] as const) {
    const n = waiting.filter((row) => displayState(row) === key).length
    if (n === 0) continue
    const label = STATE_WORDS[key].word
    breakdownCounts.set(label, (breakdownCounts.get(label) ?? 0) + n)
  }
  const breakdown = [...breakdownCounts.entries()].map(([word, count]) => `${String(count)} ${word}`).join(", ")
  const stop = snapshot.stopped ?? undefined
  const merged = snapshot.unfiltered
    .flatMap(({ row }) => {
      const at = row.state === "merged" ? clockOf(row) : undefined
      return at === undefined ? [] : [{ at, branch: row.branch }]
    })
    .sort((left, right) => right.at.getTime() - left.at.getTime())[0]
  const drafted = new Set(
    snapshot.unfiltered
      .filter(({ row }) => row.state === "draft" && row.at !== undefined)
      .map(({ row }) => `${row.branch}@${row.head}`),
  ).size
  const unread = snapshot.drafts?.unread ?? 0
  const draftWord = STATE_WORDS.draft.word
  const drafts =
    drafted === 0 && unread === 0
      ? undefined
      : `${String(drafted)} ${draftWord}${drafted === 1 ? "" : "s"} (${snapshot.drafts?.window ?? "7d"})` +
        (unread === 0 ? "" : `, ${String(unread)} not yet read`)
  // Each level drops one more part: 1 the drafts, 2 the breakdown, 3 the last merge's branch, 4 the last
  // merge, 5 the times, 6 the names.
  const at = (level: number): string => {
    const times = level < 5
    const names = level < 6
    const parts = [
      `${String(waiting.length)} ${STATE_WORDS.waiting.word}${level < 2 && breakdown !== "" ? `: ${breakdown}` : ""}`,
    ]
    if (held?.live !== undefined) {
      const ran = mediaDuration(now.getTime() - held.live.since.getTime())
      parts.push(`${STATE_WORDS.checking.word}${names ? ` ${held.branch}` : ""}${times ? ` for ${ran}` : ""}`)
    }
    if (stop !== undefined) {
      const since = times ? ` since ${clock(new Date(stop.since))}` : ""
      if (stop.change === null) {
        parts.push(`paused${since}${names && stop.by !== "" ? ` by ${stop.by}` : ""}`)
      } else {
        const branch = stop.change.slice(0, stop.change.lastIndexOf("@"))
        parts.push(`line stopped${names ? ` at ${branch}` : ""}${since}`)
      }
    }
    if (merged !== undefined && level < 4) {
      parts.push(`last merge ${clock(merged.at)}${level < 3 ? ` (${merged.branch})` : ""}`)
    }
    if (drafts !== undefined && level < 1) parts.push(drafts)
    return parts.join(" · ")
  }
  for (let level = 0; level < 6; level += 1) {
    const line = at(level)
    if (line.length <= width) return line
  }
  return at(6)
}

/** The queue line on its own row, under the title: the same text on the pane and the page. */
export function QueueLine({ snapshot, columns }: { snapshot: WatchSnapshot; columns: number }) {
  const now = useNow()
  return (
    <Box height={1} flexShrink={0} minWidth={0} overflow="hidden" paddingX={1}>
      <Text wrap="truncate">{queueLine(snapshot, now, columns - 2)}</Text>
    </Box>
  )
}

/**
 * THE ONE BAND ORDER, top to bottom. `runner` is the only band that is always
 * drawn: an empty queue still has a runner, and a page that says nothing about
 * it reads as a page with nothing to say.
 */
export const BANDS = ["drafts", "waiting", "runner", "done"] as const
export type Band = (typeof BANDS)[number]

/**
 * Which band a row falls in. THE CHANGE A CHECK HOLDS RIGHT NOW *IS* THE
 * RUNNER'S ROW — it is not drawn again above it, and it is not dropped either:
 * dropping it would take the one row an operator most wants to open out of the
 * pane's reach, and drawing it twice is the duplication the band replaced.
 *
 * `holding` is FALSE when the runner's own word is not `checking` or `merging`,
 * and then a row still marked live goes back to what waits while the runner
 * draws its own row. A service that died mid-check leaves exactly that residue,
 * and letting the row stand in for the runner would print `checking` over a
 * dead queue — the 24486 lie, moved onto the band. The runner's word already
 * refuses to be `checking` in that case (watch-runner.ts); this is the same
 * ruling applied to the row.
 */
export function bandOf(row: Pick<Row, "state" | "position" | "live">, holding = true): Band {
  if (row.live !== undefined && holding) return "runner"
  if (row.state === "draft") return "drafts"
  if (row.position !== undefined || row.state === "queued" || row.state === "checked" || row.state === "stuck") return "waiting"
  return "done"
}

/** Is the runner actually holding the change a row claims is under a check. */
export function holdsChange(state: RunnerState): boolean {
  return state === "checking" || state === "merging"
}

/**
 * The rows in band order, each band newest first.
 *
 * Waiting is the one band whose order is not already the reading's: `list()`
 * puts the line in position order, front first, and the flow page puts the
 * front of the line at the BOTTOM, against the runner, because that is the row
 * that goes next. A stuck change stopped the line, so it stands at the front
 * and lands directly above the runner without a rule of its own.
 */
export function bandedRows(rows: readonly WatchRow[], holding = true): readonly WatchRow[] {
  const of = (band: Band): readonly WatchRow[] => rows.filter((item) => bandOf(item.row, holding) === band)
  const waiting = [...of("waiting")].sort((left, right) => (right.row.position ?? 0) - (left.row.position ?? 0))
  return [...of("drafts"), ...waiting, ...of("runner"), ...of("done")]
}

/** A band's rule: the divider that opens it, drawn to the table's width. */
export function bandRule(
  band: Band,
  count: number,
  width: number,
  draftWindow = "7d",
  unread = 0,
): string {
  if (band === "drafts") {
    const draftWord = STATE_WORDS.draft.word
    const plural = count === 1 ? "" : "s"
    const unreadPart = unread > 0 ? ` · ${String(unread)} not yet read` : ""
    const said = `${String(count)} ${draftWord}${plural} (${draftWindow})${unreadPart}`
    const rule = `── ${said} `
    return rule.padEnd(Math.max(rule.length, width), "─")
  }
  return "─".repeat(Math.max(1, width))
}

/** What is drawn at one point in the table that is not a change's row. */
export type BandBreak = Readonly<{
  /** The band rules opening here, top to bottom. */
  rules: readonly string[]
  /** The runner's own row is drawn here, because no row of this table is it. */
  runner: boolean
}>

/**
 * The plan both surfaces draw the bands from: what opens above each row, and
 * what follows the last one. Give it rows already in {@link bandedRows} order.
 *
 * The runner is placed whether or not it holds a change: when it holds one,
 * that row IS the runner's row ({@link BandPlan.holding}) and nothing extra is
 * drawn above it; when it holds none, a row of its own is drawn where the band
 * stands — before the first done row, or after them all when nothing is done.
 */
export type BandPlan = Readonly<{
  before: ReadonlyMap<number, BandBreak>
  after: BandBreak | undefined
  /** The index of the row the runner holds, when this table has it. */
  holding: number | undefined
}>

export function bandPlan(
  rows: readonly WatchRow[],
  width: number,
  draftWindow = "7d",
  holds = true,
  unread = 0,
  bareDrafts = false,
): BandPlan {
  const before = new Map<number, BandBreak>()
  const opening = new Map<number, string[]>()
  let after: BandBreak | undefined
  let holding: number | undefined
  let cursor = 0
  let runnerAt: number | undefined
  for (const band of BANDS) {
    const total = rows.filter((item) => bandOf(item.row, holds) === band).length
    if (band === "runner") {
      if (total === 0) runnerAt = cursor
      else holding = cursor
      cursor += total
      continue
    }
    if (band === "drafts") {
      if (total > 0 || unread > 0) {
        const datedCount = rows.filter((item) => bandOf(item.row, holds) === band && item.row.at !== undefined).length
        const rules = opening.get(cursor) ?? []
        rules.push(bareDrafts ? "─".repeat(Math.max(1, width)) : bandRule(band, datedCount, width, draftWindow, unread))
        opening.set(cursor, rules)
      }
      cursor += total
      continue
    }
    // Operator item 7: remove rule below drafts and rule below RUNNER box
    cursor += total
  }
  for (const [index, rules] of opening) {
    before.set(index, { rules, runner: index === runnerAt })
  }
  if (runnerAt !== undefined && !before.has(runnerAt)) {
    if (runnerAt < rows.length) before.set(runnerAt, { rules: [], runner: true })
    else after = { rules: [], runner: true }
  }
  return { after, before, holding }
}

/** How many terminal rows a break costs, so a virtualized list can budget for it. */
export function bandHeight(brk: BandBreak | undefined): number {
  if (brk === undefined) return 0
  // The runner is two rows: its own, and the indented line of host-only detail.
  return brk.rules.length + (brk.runner ? 2 : 0)
}

/** The runner's line, read from the WHOLE reading: the queue's runner, never the selector's. */
export function runnerOf(snapshot: WatchSnapshot, now: Date) {
  const { held, waiting } = lineOf(snapshot.unfiltered)
  return runnerLine(snapshot.runner, now, {
    ...(held?.live === undefined
      ? {}
      : {
          held: {
            branch: held.branch,
            since: held.live.since,
            ...(held.subject === undefined ? {} : { subject: held.subject }),
            ...(held.submitter === undefined ? {} : { submitter: held.submitter }),
          },
        }),
    ...(snapshot.stopped === undefined ? {} : { stopped: snapshot.stopped }),
    waiting: waiting.length,
  })
}

/**
 * The RUNNER box, drawn in rounded border chrome with its title and border
 * wearing the runner state's color (items 7, 27). The one component for the
 * RUNNER box across both the list view item (watch-pane.tsx) and the empty
 * pane/print break rows (BandBreakRows).
 */
export function RunnerTitledBox({
  line,
  snapshot,
  layout,
  cursor = false,
  queueDigit = 1,
  queueLabel = "main",
}: {
  line: ReturnType<typeof runnerOf>
  snapshot: WatchSnapshot
  layout: ListLayout
  cursor?: boolean
  queueDigit?: number
  queueLabel?: string
}) {
  const color = STATE_WORDS[line.state].color
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <TitledBox title={STATE_WORDS.runner.word} flushTop borderColor={color}>
        <RunnerRow
          line={line}
          layout={layout}
          cursor={cursor}
          queueDigit={queueDigit}
          queueLabel={queueLabel}
        />
      </TitledBox>
    </Box>
  )
}

/**
 * One break, drawn: the runner's own row when this is its place, THEN the band
 * rules that open here. The runner comes first because the only rule that can
 * share its index is `done`'s — drafts and waiting have already advanced past
 * it — and the runner stands between waiting and done, never under done.
 */
export function BandBreakRows({
  brk,
  snapshot,
  layout,
  includeRunner = true,
}: {
  brk: BandBreak | undefined
  snapshot: WatchSnapshot
  layout: ListLayout
  includeRunner?: boolean
}) {
  const now = useNow()
  if (brk === undefined) return null
  const runner = runnerOf(snapshot, now)
  return (
    <Box flexDirection="column" flexShrink={0} minWidth={0}>
      {brk.runner && includeRunner ? (
        <RunnerTitledBox line={runner} snapshot={snapshot} layout={layout} />
      ) : null}
      {brk.rules.map((rule, idx) => (
        <Text key={`${rule}-${idx}`} color="$fg-muted" wrap="truncate">
          {rule}
        </Text>
      ))}
    </Box>
  )
}

/**
 * The runner's second line: dropped per operator item 3 ("yes, perhaps don't even say anything?").
 */
export function RunnerDetail(_props: { snapshot: WatchSnapshot; named?: boolean }) {
  return null
}

/**
 * The bands, then the pills row, then STATS — the one order (the retired
 * pane's items 2–6). The bands are whatever the caller renders: the pane's
 * virtualised Table, the page's static list, both planned by {@link bandPlan}.
 * `pills` and `stats` are absent on the page, which prints the rows and
 * nothing interactive.
 */
export function ListStack({
  snapshot,
  children,
  pills,
  stats,
  paddingX = 0,
}: {
  snapshot: WatchSnapshot
  children: ReactNode
  pills?: ReactNode
  stats?: ReactNode
  paddingX?: number
}) {
  // Nothing to say is said by nothing: the native contract observes the root
  // queue only, every round, and a clean root-v1 round has no notice. A
  // reading that failed is loud.
  const observation = snapshot.observation
  const said =
    observation === undefined ||
    observation.contract === "native" ||
    (observation.outcome === "observed" && observation.notices.length === 0)
      ? undefined
      : observation
  const failed = said?.contract === "root-v1" && said.outcome !== "observed"
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0} paddingX={paddingX}>
      {said === undefined ? null : (
        <Box flexDirection="column" flexShrink={0}>
          <Text {...(failed ? { bold: true, color: "$fg-error" } : {})}>{said.message}</Text>
          {said.notices.map((notice) => (
            <Text key={notice.id}>{notice.text}</Text>
          ))}
        </Box>
      )}
      {stats}
      {pills}
      {children}
    </Box>
  )
}
