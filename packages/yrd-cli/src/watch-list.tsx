/**
 * The watch's LIST view — the table, its header, the top line and the filter
 * pills (watch-redesign items 3, 28, 30–33, 38):
 *
 *   YRD QUEUES   1 /hh ⎇ main                              ← the top line: title + queue pills, nothing else (30, 32b, 33)
 *   TIME      STATUS      RUN          CHANGES · drafts 7d · in line order, then newest first    BY
 *   17:02:11  ◉ checking  main#170206  task/bar  add a check (typecheck)         @chief   checking 1:02
 *   17:04:06  ○ submitted —            task/foo  fix the parser                  @ci       waiting 0:37
 *   16:55:40  ✓ merged    main#165540  task/baz  drop a flag                     @dev/2     took 14:20
 *   16:40:12  ◇ draft     —            task/qux  0123456789ab                    ada
 *                                                     open  running  done  failed  all   ← status pills, right-aligned (9/32)
 *
 * Every row has ONE clock, the instant its place in the table is ordered by,
 * and one duration cell whose word names its basis (@i/10-yrd/24196; queue-core
 * `clocks`). The STATUS word is the one word table's (watch-words.ts).
 *
 * Every cell reads the core's `Row` through `WatchRow`; nothing here derives
 * a state. The RUN cell names the run and carries NO glyph (operator
 * 2026-08-25, superseding item 38's glyph clause: the STATUS cell already
 * says it); a pre-run row shows a muted em-dash; a batch member sharing the
 * previous row's run shows a muted `·`. The CHANGES cell is the change's id
 * then its subject, never the branch alone (28; `@cto` 2026-09-05: PR numbers
 * are retired and the branch is the readable half of `<branch>@<sha>`).
 */

import React, { memo } from "react"
import { Box, Pulse, Text, TogglePill, TogglePillGroup } from "silvery"
import { clocks, type Row, type WatchRow } from "@yrd/queue-core"
import { useNow } from "./watch-clock.ts"
import {
  STATE_WORDS,
  clock,
  friendlyPath,
  mediaDuration,
  runShortName,
  stateColor,
  stateGlyph,
  stateWord,
} from "./watch-format.ts"

/** The status filter buckets, in the order the pills show them (items 9, 32). */
export const BUCKETS = ["open", "running", "done", "failed"] as const
export type StatusBucket = (typeof BUCKETS)[number]

/** Which bucket a row is in — read off the state and the live overlay, decided nowhere else. */
export function bucketOf(row: Pick<Row, "state" | "live">): StatusBucket {
  if (row.live !== undefined) return "running"
  switch (row.state) {
    case "merged":
    case "direct":
    case "withdrawn":
      return "done"
    case "failed":
      return "failed"
    case "queued":
    case "checked":
    case "stuck":
    case "draft":
      return "open"
  }
}

/** One queue as the top line shows it (pre-M8 exactly one): the digit, the friendly path and the branch. */
export type WatchQueue = Readonly<{
  /** The queue's name: pre-M8 the target's branch. */
  label: string
  /** The repository the queue writes, as a path on this machine. */
  path: string
  branch: string
}>

/** The pill's text (items 32d, 36): `1 /hh ⎇ main` — digit, shortest friendly path, the branch glyph, the branch. */
export function pillLabel(queue: WatchQueue, digit: number): string {
  return `${String(digit)} ${friendlyPath(queue.path)} ⎇ ${queue.branch}`
}

export type ListLayout = Readonly<{
  timeWidth: number
  statusWidth: number
  runWidth: number
  byWidth: number
  durationWidth: number
}>

/** The RUN cell's three shapes (item 38). */
export type RunCell =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "continuation" }>
  | Readonly<{ kind: "run"; text: string }>

/** What the RUN cell says for a row, given the row above it. */
export function runCell(item: WatchRow, label: string, previous: WatchRow | undefined): RunCell {
  const run = item.run?.id ?? item.row.run
  if (run === undefined) return { kind: "none" }
  const previousRun = previous?.run?.id ?? previous?.row.run
  // A batch member sharing the previous row's run is a continuation (M10 will
  // make this common; today a run holds one change, so it never fires).
  if (previous !== undefined && previousRun === run && previous.row.head !== item.row.head) {
    return { kind: "continuation" }
  }
  return { kind: "run", text: runShortName(label, run) }
}

/** The CHANGES cell's parenthesized suffix: the running check, else a failure's code — status, never identity. */
export function changesSuffix(row: Row): Readonly<{ text: string; color: string }> | undefined {
  if (row.live !== undefined) return { color: "$fg-info", text: row.live.check }
  if (row.state === "failed" && row.reason !== undefined) return { color: "$fg-error", text: `err=${row.reason}` }
  if (row.state === "stuck" && row.reason !== undefined) {
    return { color: "$fg-warning", text: `${STATE_WORDS.stuck.word}=${row.reason}` }
  }
  if (row.state === "withdrawn" && row.reason !== undefined) {
    return { color: "$fg-muted", text: `${STATE_WORDS.cancelled.word}=${row.reason}` }
  }
  return undefined
}

/**
 * The one duration cell's text, its word naming its basis: how long the check
 * running now has run, how long a stuck change has been stuck, how long a
 * change in line has waited since it was submitted, or how long an ended
 * change took. A draft has none.
 */
export function durationText(row: Row, now: Date): string {
  const measured = clocks(row, now)
  if (measured.checkingMs !== undefined) return `${STATE_WORDS.checking.word} ${mediaDuration(measured.checkingMs)}`
  if (measured.stuckMs !== undefined) return `${STATE_WORDS.stuck.word} ${mediaDuration(measured.stuckMs)}`
  // A stuck change keeps its place in line, and so a wait, but its cell is stuck's alone: with no instant for its
  // stuck record it says nothing rather than borrow the waiting word (A2-set-v4).
  if (row.state === "stuck") return ""
  if (measured.waitingMs !== undefined) return `${STATE_WORDS.waiting.word} ${mediaDuration(measured.waitingMs)}`
  if (measured.tookMs !== undefined) return `${STATE_WORDS.took.word} ${mediaDuration(measured.tookMs)}`
  return ""
}

/** The widths every row and the header share, so they cannot drift (the retired `timelineCellLayout`). */
export function listLayout(rows: readonly WatchRow[], label: string, columns: number, now: Date): ListLayout {
  const cells = rows.map((item, index) => runCell(item, label, rows[index - 1]))
  return {
    // The one clock to the second from 100 columns, to the minute below.
    timeWidth: columns < 100 ? 5 : 8,
    statusWidth: Math.max(6, ...rows.map((item) => stateWord(item.row).length + 2)),
    runWidth: Math.max(3, ...cells.map((cell) => (cell.kind === "run" ? cell.text.length : 1))),
    byWidth:
      columns < 100 ? 0 : Math.max(2, ...rows.map((item) => (item.row.submitter ?? item.row.author ?? "-").length)),
    durationWidth: Math.max(4, ...rows.map((item) => durationText(item.row, now).length)),
  }
}

/** A row's one clock (queue-core `clocks`): the instant its place in the table is ordered by, which no `now` moves. */
export function clockOf(row: Row): Date | undefined {
  return clocks(row, new Date(0)).clockAt
}

/** The local calendar day a row's instant falls on, for the separators between days. */
export function dayOf(at: Date | undefined): string | undefined {
  if (at === undefined) return undefined
  const two = (value: number): string => String(value).padStart(2, "0")
  return `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}`
}

/** A date separator appears strictly BETWEEN two adjacent rows whose one clock falls on different local days. */
export function separatorBefore(rows: readonly WatchRow[], index: number): string | undefined {
  if (index === 0) return undefined
  const at = (item: WatchRow | undefined): Date | undefined => (item === undefined ? undefined : clockOf(item.row))
  const day = dayOf(at(rows[index]))
  const previous = dayOf(at(rows[index - 1]))
  return day !== undefined && previous !== undefined && day !== previous ? day : undefined
}

/**
 * The top line (items 30, 32, 32b, 33, 36): `YRD QUEUES`, then one pill per
 * queue — `digit path ⎇ branch` — and, on an interactive surface, the trailing
 * `all` pill that clears BOTH filter kinds, as the retired pane drew it. ON
 * pills are bright and OFF pills muted through the pill's own colour ladder:
 * a filled background behind a pill is not this line's idiom, and the theme
 * guarantees no contrast for the pill's text on one.
 */
export function TopLine({
  queues,
  visible,
  onToggle,
  allOn,
  onShowAll,
}: {
  queues: readonly WatchQueue[]
  /** The labels of the queues shown; `undefined` means every one. */
  visible: ReadonlySet<string> | undefined
  onToggle: (label: string) => void
  /** True when neither filter kind narrows anything. */
  allOn: boolean
  /** Clears both filter kinds; absent on a one-shot print, where there is nothing to clear. */
  onShowAll?: () => void
}) {
  return (
    <Box height={1} flexDirection="row" columnGap={2} flexShrink={0} minWidth={0} overflow="hidden" paddingLeft={1}>
      <Text bold flexShrink={0}>
        YRD QUEUES
      </Text>
      <TogglePillGroup flexShrink={1} minWidth={0} overflow="hidden">
        {queues.map((queue, index) => (
          <TogglePill
            key={`${queue.path}@${queue.branch}`}
            label={pillLabel(queue, index + 1)}
            boldFirstLetter
            active={visible === undefined || visible.has(queue.label)}
            onToggle={() => {
              onToggle(queue.label)
            }}
          />
        ))}
        {onShowAll === undefined ? null : (
          <TogglePill label="all" boldFirstLetter active={allOn} onToggle={onShowAll} />
        )}
      </TogglePillGroup>
    </Box>
  )
}

/** Which drafts a reading lists: those committed in the last seven days, or every one. */
export type DraftWindow = "7d" | "all"

/**
 * The column header: the same layout every row uses. Its rail names the one
 * order the rows are in and which drafts are listed.
 */
export function ListHeader({ layout, draftWindow = "7d" }: { layout: ListLayout; draftWindow?: DraftWindow }) {
  const label = (text: string): React.ReactNode => (
    <Text bold wrap="truncate">
      {text}
    </Text>
  )
  return (
    <Cells layout={layout}>
      {{
        by: label("BY"),
        // The draft window first: at 100 columns it is the order phrase that truncates.
        changes: label(`CHANGES · ${STATE_WORDS.draft.word}s ${draftWindow} · ${STATE_WORDS.order.word}`),
        duration: label(""),
        run: label("RUN"),
        status: label("STATUS"),
        time: label("TIME"),
      }}
    </Cells>
  )
}

/**
 * The duration cell, its own leaf on the one-second clock, memoized on the
 * row: the tick re-renders this and nothing else in the row. An ended row's
 * duration stops at its ending, so it reads the same on every tick.
 */
const DurationCell = memo(function DurationCell({ row, color }: { row: Row; color: string | undefined }) {
  const now = useNow()
  const text = durationText(row, now)
  return (
    <Text color={color ?? "$fg-muted"} wrap="truncate">
      {text === "" ? " " : text}
    </Text>
  )
})

/** Whether two rows would paint the same, so a round that changed nothing about a row repaints nothing. */
function sameRow(left: ListRowProps, right: ListRowProps): boolean {
  const a = left.item.row
  const b = right.item.row
  return (
    left.cursor === right.cursor &&
    left.hovered === right.hovered &&
    left.live === right.live &&
    left.label === right.label &&
    left.item.run?.id === right.item.run?.id &&
    left.previous?.run?.id === right.previous?.run?.id &&
    left.previous?.row.run === right.previous?.row.run &&
    left.previous?.row.head === right.previous?.row.head &&
    a.branch === b.branch &&
    a.head === b.head &&
    a.state === b.state &&
    a.run === b.run &&
    a.subject === b.subject &&
    a.reason === b.reason &&
    a.diagnostics === b.diagnostics &&
    a.submitter === b.submitter &&
    a.author === b.author &&
    a.movedSinceSubmit === b.movedSinceSubmit &&
    a.live?.check === b.live?.check &&
    a.live?.since.getTime() === b.live?.since.getTime() &&
    a.at?.getTime() === b.at?.getTime() &&
    a.since?.getTime() === b.since?.getTime() &&
    a.startedAt?.getTime() === b.startedAt?.getTime() &&
    a.endedAt?.getTime() === b.endedAt?.getTime() &&
    a.endingAt?.getTime() === b.endingAt?.getTime() &&
    Object.entries(left.layout).every(([key, value]) => right.layout[key as keyof ListLayout] === value)
  )
}

type ListRowProps = Readonly<{
  item: WatchRow
  previous: WatchRow | undefined
  label: string
  layout: ListLayout
  cursor: boolean
  /** The pointer is over this row: a tint under it, and nothing else — the cursor and the detail stay where they are. */
  hovered?: boolean
  /** False on a one-shot print, which has no app-root scope for a synchronized clock to join. Default true (the watch). */
  live?: boolean
}>

/**
 * One row of the table. Reads no clock itself: its duration cell does.
 *
 * Colour: the STATUS cell — glyph and word — wears the state's colour (the
 * retired pane's `timelineStatusColor`), a live check overlays the working
 * colour; the identity and time cells stay default or muted so the one
 * coloured word is what the eye lands on. The change a check holds right now
 * is the exception: its whole row reads in the working colour, and its marker
 * is the one thing on screen that pulses (@i/10-yrd/24196). The cursor row
 * forces the selected pair on every cell; a hovered row gets the hover surface
 * only, which is the affordance the pointer had before (item P: hover never
 * moves the selection).
 */
export const ListRow = memo(function ListRow({
  item,
  previous,
  label,
  layout,
  cursor,
  hovered = false,
  live = true,
}: ListRowProps) {
  const { row } = item
  const forced = cursor ? "$fg-on-selected" : undefined
  const held = row.live === undefined ? undefined : "$fg-info"
  const color = stateColor(row)
  const clockAt = clockOf(row)
  const cell = runCell(item, label, previous)
  const suffix = changesSuffix(row)
  return (
    <Box
      backgroundColor={cursor ? "$bg-selected" : hovered ? "$bg-surface-hover" : undefined}
      minWidth={0}
      width="100%"
    >
      <Cells layout={layout}>
        {{
          by: (
            <Text color={forced ?? held ?? "$fg-muted"} wrap="truncate">
              {row.submitter ?? row.author ?? "-"}
            </Text>
          ),
          changes: (
            <Box flexDirection="row" minWidth={0} overflow="hidden">
              {(row.diagnostics?.length ?? 0) === 0 ? null : (
                <Text color={forced ?? "$fg-warning"} flexShrink={0}>
                  ⚠{" "}
                </Text>
              )}
              <Text color={forced ?? held} flexShrink={0}>
                {row.branch}
              </Text>
              <Box paddingLeft={1} minWidth={0} overflow="hidden" flexDirection="row">
                <Text color={forced ?? held} wrap="truncate" minWidth={0}>
                  {row.subject ??
                    (row.state === "direct"
                      ? (row.reason ?? "")
                      : row.state === "draft"
                        ? // A draft has no record to carry a subject; one whose head is not here has no date either.
                          row.at === undefined
                          ? "not yet read"
                          : row.head.slice(0, 12)
                        : `${row.head.slice(0, 12)} (subject not fetched)`)}
                </Text>
                {suffix === undefined ? null : (
                  <Text color={forced ?? suffix.color} flexShrink={0} wrap="truncate">
                    {" "}
                    ({suffix.text})
                  </Text>
                )}
              </Box>
            </Box>
          ),
          duration: <DurationCell row={row} color={forced ?? held} />,
          run:
            cell.kind === "none" ? (
              <Text color={forced ?? "$fg-muted"} wrap="truncate">
                —
              </Text>
            ) : cell.kind === "continuation" ? (
              <Text color={forced ?? "$fg-muted"} wrap="truncate">
                ·
              </Text>
            ) : (
              <Text color={forced} wrap="truncate">
                {cell.text}
              </Text>
            ),
          status: (
            <Box flexDirection="row" minWidth={0}>
              {/* The held row's glyph is the one pulse on screen, cursor or
                  not (24196 P1): the held row sorts first, so the cursor
                  starts on it, and item 13's cursor exemption hid the only
                  live marker. On the cursor it pulses in the selection's own
                  pair, so the row still reads as selected; off it, against
                  the surface — foreground-vs-background either way, at the
                  900ms rate. `live` (never rendering `<Pulse>` at all when
                  false) is what keeps a one-shot print safe: silvery's
                  `usePulse` calls `useScopeEffect` UNCONDITIONALLY, so even an
                  inactive `<Pulse active={false}>` still throws with no
                  app-root scope — only `active`'s OWN `useSynchronizedPhase`
                  guard is scope-free when inactive, not the component around
                  it (measured 2026-09-09: `yrd queue list` crashed on any row
                  with a check running; swapping to `active=` still crashed,
                  one hook deeper). */}
              {live && row.live !== undefined ? (
                <Pulse
                  synchronized
                  colors={forced === undefined ? [color, "$bg-surface-default"] : [forced, "$bg-selected"]}
                  intervalMs={900}
                  flexShrink={0}
                >
                  {stateGlyph(row)}
                </Pulse>
              ) : (
                <Text color={forced ?? color} flexShrink={0}>
                  {stateGlyph(row)}
                </Text>
              )}
              <Text color={forced ?? color} wrap="truncate">
                {" "}
                {stateWord(row)}
              </Text>
            </Box>
          ),
          time: (
            <Text color={forced ?? held ?? "$fg-muted"} wrap="truncate">
              {clockAt === undefined ? "-" : clock(clockAt, { seconds: layout.timeWidth >= 8 })}
            </Text>
          ),
        }}
      </Cells>
    </Box>
  )
}, sameRow)

/** The six cells in their one geometry, consumed by header and rows alike. */
function Cells({
  layout,
  children,
}: {
  layout: ListLayout
  children: Readonly<{
    time: React.ReactNode
    status: React.ReactNode
    run: React.ReactNode
    changes: React.ReactNode
    by: React.ReactNode
    duration: React.ReactNode
  }>
}) {
  return (
    <Box height={1} width="100%" flexDirection="row" gap={1} minWidth={0} overflow="hidden">
      <Box width={layout.timeWidth} flexShrink={0}>
        {children.time}
      </Box>
      <Box width={layout.statusWidth} flexShrink={0} flexDirection="row">
        {children.status}
      </Box>
      <Box width={layout.runWidth} flexShrink={0}>
        {children.run}
      </Box>
      <Box flexGrow={1} flexBasis={0} minWidth={12}>
        {children.changes}
      </Box>
      {layout.byWidth === 0 ? null : (
        <Box width={layout.byWidth} flexShrink={0}>
          {children.by}
        </Box>
      )}
      <Box width={layout.durationWidth} flexShrink={0} justifyContent="flex-end">
        {children.duration}
      </Box>
    </Box>
  )
}

/** The bottom row's status pills, right-aligned (items 9, 32): bold first letter is the hotkey; `all` clears both filter kinds. */
export function StatusPills({
  buckets,
  allOn,
  onSelectOnly,
  onAll,
}: {
  buckets: ReadonlySet<StatusBucket>
  /** True when neither filter kind narrows anything. */
  allOn: boolean
  onSelectOnly: (bucket: StatusBucket) => void
  onAll: () => void
}) {
  return (
    <Box height={1} flexDirection="row" justifyContent="flex-end" minWidth={0} overflow="hidden">
      <TogglePillGroup>
        {BUCKETS.map((bucket) => (
          <TogglePill
            key={bucket}
            label={bucket}
            boldFirstLetter
            active={buckets.has(bucket)}
            onToggle={() => {
              onSelectOnly(bucket)
            }}
          />
        ))}
        <TogglePill label="all" boldFirstLetter active={allOn} onToggle={onAll} />
      </TogglePillGroup>
    </Box>
  )
}
