/**
 * The watch's LIST view — the table, its header, the top line and the filter
 * pills (watch-redesign items 3, 28, 30–33, 38; 24196):
 *
 *   yrd watch  [1 main]                                ● YRD RUNNING  [open] [running] [done] [failed]
 *   ► STATS · current queue and 24h summary
 *   HH:MM  Q   RUN    TASK                          STATE      AGENT   AGE / RUN
 *   ────────────────────────────────────────────────────────────────────────
 *   12:00  1   —      Improve table expansion       draft      @dev/7  — / —
 *   12:01  1   —      Validate staffing roots       waiting    @dev/8  — / —
 *   12:05  1   2342   Correct staffing selection    checking   @dev/8  — / 00:42
 *             ▶ Step: focused checks · heartbeat 1s ago
 *   12:10  1   2341   Expose close-path option      merged     @dev/2  — / 04:55
 *
 * Every row has ONE clock, the instant its place in its band is ordered by.
 * AGE / RUN is that attempt's runtime, with AGE unknown when the beginning is
 * only the tip Opened trailer. The STATE word is the one word table's
 * (watch-words.ts), and the RUNNER's row reads its word from the same table
 * in the same column.
 *
 * Every cell reads the core's `Row` through `WatchRow`; nothing here derives a
 * state. TASK leads with the change's subject (ia.md); the branch remains in
 * details.
 *
 * The BAND ORDER is not here: it is in watch-frame.tsx, spelled once, so the
 * pane and the page cannot drift apart again.
 */

import React, { memo } from "react"
import { Box, Pulse, Text } from "silvery"
import { clocks, type Row, type WatchRow } from "@yrd/queue-core"
import { useNow } from "./watch-clock.ts"
import { TimeText } from "./watch-primitives.tsx"
import {
  RUNNER_GLYPH,
  STATE_WORDS,
  AGE_RUN_MIN_WIDTH,
  ageRunText,
  clock,
  friendlyPath,
  queueRunText,
  runIdentifier,
  stateColor,
  stateGlyph,
  stateWord,
} from "./watch-format.ts"
import type { RunnerLine } from "./watch-runner.ts"

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
    case "cancelled":
      return "done"
    case "failed":
    case "invalid":
      return "failed"
    case "queued":
    case "checked":
    case "stuck":
    case "draft":
    case "deferred":
      return "open"
    case "verifying":
    case "checking":
    case "merging":
      return "running"
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

/** The pill's text (items 32d, 36, 24196): bracket shortcuts `[1] /hh ⎇ main` or plain `1 /hh ⎇ main`. */
export function pillLabel(queue: WatchQueue, digit: number, brackets = false): string {
  const prefix = brackets ? `[${String(digit)}]` : String(digit)
  return `${prefix} ${friendlyPath(queue.path)} ⎇ ${queue.branch}`
}

export type ListLayout = Readonly<{
  columns?: number
  timeWidth?: number
  agentWidth: number
  qWidth?: number
  runWidth?: number
  queueRunWidth: number
  statusWidth: number
  ageRunWidth: number
  isSeparateColumns?: boolean
  isFullQueue?: boolean
  taskWidth?: number
}>

/** The CHANGES cell's parenthesized suffix: the running check, else a failure's code — status, never identity. */
export function changesSuffix(row: Row): Readonly<{ text: string; color: string }> | undefined {
  if (row.live !== undefined) return { color: "$fg-info", text: row.live.check }
  if (row.state === "failed" && row.reason !== undefined) return { color: "$fg-error", text: `err=${row.reason}` }
  // A checked row's reason is its stale verdict: judged under a check config the target no longer declares (25301).
  if (row.state === "checked" && row.reason !== undefined) return { color: "$fg-muted", text: row.reason }
  if (row.state === "stuck" && row.reason !== undefined) {
    return { color: "$fg-warning", text: `${STATE_WORDS.stuck.word}=${row.reason}` }
  }
  if (row.state === "withdrawn" && row.reason !== undefined) {
    return { color: "$fg-muted", text: `${STATE_WORDS.cancelled.word}=${row.reason}` }
  }
  if (row.state === "deferred") {
    const projected = row.projectedMs !== undefined ? `${Math.round(row.projectedMs / 60000)}m` : undefined
    const bound = row.boundMs !== undefined ? `${Math.round(row.boundMs / 60000)}m` : undefined
    const rel =
      row.projectedMs !== undefined && row.boundMs !== undefined
        ? row.projectedMs > row.boundMs
          ? ">"
          : row.projectedMs < row.boundMs
            ? "<"
            : "="
        : ">"
    const timing = projected && bound ? `projected ${projected} ${rel} ${bound}, ` : ""
    return {
      color: "$fg-accent",
      text: `${timing}waits for the long check`,
    }
  }
  return undefined
}

/**
 * Shortens a string with an ellipsis when it exceeds maxLen (25716).
 * Anything cut ends with an ellipsis.
 */
export function truncateWithEllipsis(str: string, maxLen: number): string {
  if (maxLen <= 0) return ""
  if (str.length <= maxLen) return str
  if (maxLen === 1) return "…"
  return `${str.slice(0, maxLen - 1)}…`
}

/**
 * Allocates display widths for the ISSUE / BRANCH column (25716):
 * - Branch name and error each take at most 50% of the column width.
 * - Title keeps the remainder and never less than a third.
 * - Anything cut ends with an ellipsis.
 */
export function taskExtrasLayout(
  taskWidth: number,
  branch: string,
  suffixText: string | undefined,
): Readonly<{
  minTitle: number
  displayBranch: string
  displaySuffix?: string
}> {
  const minTitle = Math.ceil(taskWidth / 3)
  const maxAllowedBranch = Math.max(1, Math.floor(taskWidth * 0.5) - 1)
  const maxAllowedSuffix = Math.max(1, Math.floor(taskWidth * 0.5) - 3)

  let displayBranch =
    branch.length > maxAllowedBranch ? truncateWithEllipsis(branch, maxAllowedBranch) : branch

  let displaySuffix =
    suffixText === undefined
      ? undefined
      : suffixText.length > maxAllowedSuffix
        ? truncateWithEllipsis(suffixText, maxAllowedSuffix)
        : suffixText

  const branchWidth = displayBranch.length > 0 ? 1 + displayBranch.length : 0
  const suffixWidth = displaySuffix !== undefined ? 3 + displaySuffix.length : 0
  const maxExtrasBudget = Math.max(0, taskWidth - minTitle)

  if (
    (branch.length > maxAllowedBranch || (suffixText !== undefined && suffixText.length > maxAllowedSuffix)) &&
    branchWidth + suffixWidth > maxExtrasBudget
  ) {
    const halfBudget = Math.floor(maxExtrasBudget / 2)
    const branchAlloc = Math.min(branchWidth, halfBudget)
    const suffixAlloc = Math.min(suffixWidth, maxExtrasBudget - branchAlloc)
    displayBranch = branchAlloc > 1 ? truncateWithEllipsis(branch, branchAlloc - 1) : ""
    displaySuffix =
      suffixText !== undefined && suffixAlloc > 3
        ? truncateWithEllipsis(suffixText, suffixAlloc - 3)
        : undefined
  }

  return {
    minTitle,
    displayBranch,
    displaySuffix,
  }
}

/**
 * The widths every row and the header share, so they cannot drift (the retired
 * `timelineCellLayout`). `runner` is the runner's own word, submitter and
 * duration, which sit in the same three columns as every change's and so are
 * measured with them: the runner is a row now, not a box with its own
 * geometry.
 */
/** The runner's status word with optional sub-phase / step (25716). */
export function runnerStatusWord(line: RunnerLine): string {
  const base = STATE_WORDS[line.state].word
  if (line.state === "checking" && line.subphase) return `${base} (${line.subphase})`
  if (line.state === "merging" && line.step) return `${base} (${line.step})`
  return base
}

export function listLayout(
  rows: readonly WatchRow[],
  columns: number,
  now: Date,
  runner?: Pick<RunnerLine, "state" | "duration" | "by" | "subphase" | "step">,
  queue: Readonly<{ digit: number; label: string }> = { digit: 1, label: "main" },
  options?: { singleQueue?: boolean; separateColumns?: boolean; fullQueueRefs?: boolean },
): ListLayout {
  const runnerWord = runner === undefined ? "" : runnerStatusWord(runner as RunnerLine)
  const runIdOf = (item: WatchRow): string | undefined => item.run?.id ?? item.row.run
  const separate = options?.separateColumns ?? false
  const single = options?.singleQueue ?? true
  const fullQueue = options?.fullQueueRefs ?? false
  const timeWidth = 5
  const statusWidth = Math.max(6, runnerWord.length + 2, ...rows.map((item) => stateWord(item.row).length + 2))
  const agentWidth =
    columns < 100
      ? 0
      : Math.max(5, (runner?.by ?? "—").length, ...rows.map((item) => (item.row.submitter ?? "—").length))
  const runWidth = separate ? Math.max(3, ...rows.map((item) => runIdentifier(runIdOf(item)).length)) : 0
  const ageRunWidth = Math.max(
    AGE_RUN_MIN_WIDTH,
    (runner?.duration ?? "").length,
    ...rows.map((item) => ageRunText(item.row, now).length),
  )
  const fixedExceptQ = timeWidth + statusWidth + agentWidth + (separate ? runWidth : 0) + ageRunWidth + 8
  const maxAvailableForQ = Math.max(16, columns - fixedExceptQ - 56)
  const qWidth = separate
    ? fullQueue
      ? Math.max(16, Math.min(queue.label.length, maxAvailableForQ))
      : single
        ? 0
        : 3
    : 0
  const queueRunWidth = separate
    ? 0
    : Math.max(
        11,
        queueRunText(queue.digit, queue.label, undefined).length,
        ...rows.map((item) => queueRunText(queue.digit, queue.label, runIdOf(item)).length),
      )
  const fixedNonTask =
    timeWidth +
    1 +
    (separate
      ? (qWidth > 0 ? qWidth + 1 : 0) + (runWidth > 0 ? runWidth + 1 : 0)
      : queueRunWidth + 1) +
    statusWidth +
    (agentWidth > 0 ? 1 + agentWidth : 0) +
    1 +
    ageRunWidth +
    1
  const taskWidth = Math.max(12, columns - fixedNonTask)
  return {
    columns,
    timeWidth,
    statusWidth,
    agentWidth,
    qWidth,
    runWidth,
    queueRunWidth,
    ageRunWidth,
    isSeparateColumns: separate,
    isFullQueue: fullQueue,
    taskWidth,
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

export type LineStatus = Readonly<{
  marker: string
  word: string
  color: string
  /** How long the queue has been in that status, or live status timer node (25556, 25630). */
  timer?: React.ReactNode
  /** Why the line is stopped, in the pause record's or the runner's own words; absent while it runs. */
  reason?: string
  /** The marker pulses while the line runs, or while it is stopped with a reason (25416). */
  pulse: boolean
}>

/**
 * Shortens a queue address with `..` when it does not fit (25630).
 */
export function shortenAddress(address: string, maxLen: number): string {
  if (address.length <= maxLen) return address
  if (maxLen <= 2) return "..".slice(0, maxLen)
  return `${address.slice(0, maxLen - 2)}..`
}

/**
 * The top line (ia.md, 24196; 25416; 25630): inverted chrome across the whole width.
 * Left: YRD QUEUE and the queue address (shortened with .. when it does not fit).
 * Right: the status word and its timer (RUNNING 0:17), nothing else.
 */
export function TopLine({
  queue,
  queues,
  status,
  columns,
  live = false,
  onStatusClick,
}: {
  queue?: string
  queues?: readonly WatchQueue[]
  /** @deprecated Preserved for compatibility */
  visible?: ReadonlySet<string> | undefined
  /** @deprecated Preserved for compatibility */
  onToggle?: (label: string) => void
  status: LineStatus
  /** @deprecated Preserved for compatibility */
  statusPills?: React.ReactNode
  columns?: number
  live?: boolean
  onStatusClick?: () => void
}) {
  const statusInk = `mix($fg-on-inverse, ${status.color}, ${status.color === "$fg-warning" ? "30%" : "50%"})`
  const queueAddress = queue ?? (queues && queues[0]?.label) ?? ""

  // Right side width: marker + YRD + word + timer + reason + gaps + paddingRight
  const timerLen = typeof status.timer === "string" ? status.timer.length : status.timer !== undefined ? 10 : 0
  const statusParts = [
    status.marker ? 1 : 0,
    3, // YRD
    status.word.length,
    timerLen,
    status.reason ? status.reason.length : 0,
  ].filter((n) => n > 0)
  const statusGaps = Math.max(0, statusParts.length - 1)
  const statusRightLen = statusParts.reduce((a, b) => a + b, 0) + statusGaps + 1
  const availableForAddress = columns !== undefined ? Math.max(0, columns - 1 - 10 - 1 - statusRightLen) : undefined
  const displayAddress =
    availableForAddress !== undefined ? shortenAddress(queueAddress, availableForAddress) : queueAddress

  return (
    <Box
      height={1}
      flexDirection="row"
      flexShrink={0}
      minWidth={0}
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
      justifyContent="space-between"
      backgroundColor="$bg-inverse"
    >
      <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
        <Text bold color="$fg-on-inverse" flexShrink={0}>
          YRD QUEUE{" "}
        </Text>
        <Text color="$fg-on-inverse" wrap="truncate">
          {displayAddress}
        </Text>
      </Box>
      <Box
        flexDirection="row"
        flexShrink={status.reason !== undefined ? 1 : 0}
        minWidth={0}
        overflow="hidden"
        gap={1}
        onClick={onStatusClick}
      >
        {live && status.pulse ? (
          <Pulse synchronized colors={["$fg-on-inverse", statusInk]} intervalMs={900} flexShrink={0}>
            {status.marker}
          </Pulse>
        ) : (
          <Text color={statusInk} flexShrink={0}>
            {status.marker}
          </Text>
        )}
        <Text bold color={statusInk} flexShrink={0}>
          YRD
        </Text>
        <Text bold color={statusInk} flexShrink={0}>
          {status.word}
        </Text>
        {status.timer === undefined ? null : (
          <Text color={statusInk} flexShrink={0}>
            {status.timer}
          </Text>
        )}
        {status.word === "STOPPED" && status.reason !== undefined ? (
          <Text color={statusInk} wrap="truncate">
            {status.reason}
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}

/**
 * Filter pills on the plain surface (25630). Active uses warning tint and bold,
 * unselected stays muted. First letter is bolded as the keyboard shortcut.
 */
function TopPill({
  label,
  active,
  onToggle,
  boldFirstLetter = false,
  activeTreatment: _activeTreatment = "warningText",
}: {
  label: string
  active: boolean
  onToggle: () => void
  boldFirstLetter?: boolean
  activeTreatment?: "accentText" | "warningText"
}) {
  const color = active ? "$fg-warning" : "$fg-muted"
  return (
    <Box flexShrink={0} onClick={onToggle}>
      {boldFirstLetter && label.length > 0 ? (
        <>
          <Text color={color} bold>
            {label.slice(0, 1)}
          </Text>
          <Text color={color} bold={active}>
            {label.slice(1)}
          </Text>
        </>
      ) : (
        <Text color={color} bold={active}>
          {label}
        </Text>
      )}
    </Box>
  )
}

/** Which drafts a reading lists: those committed in the last seven days, or every one. */
export type DraftWindow = "7d" | "all"

/**
 * The column header: the same layout every row uses. It no longer names the
 * order or the draft window — each band's own rule says both, for the rows
 * under it, which is the only scope either was ever true of.
 */
export function ListHeader({ layout }: { layout: ListLayout }) {
  const label = (text: string): React.ReactNode => (
    <Text bold wrap="truncate">
      {text}
    </Text>
  )
  return (
    <Cells layout={layout}>
      {{
        time: label("TIME"),
        q: (layout.qWidth ?? 0) === 0 ? null : label(layout.isFullQueue ? "QUEUE" : "Q"),
        run: label("RUN"),
        queueRun: label("QUEUE / RUN"),
        task: label("ISSUE / BRANCH"),
        status: label("STATUS"),
        agent: label("WHO"),
        ageRun: label("AGE / RUN"),
      }}
    </Cells>
  )
}

/**
 * The duration cell, its own leaf on the one-second clock, memoized on the
 * row: the tick re-renders this and nothing else in the row. An ended row's
 * duration stops at its ending, so it reads the same on every tick.
 */
const AgeRunCell = memo(function AgeRunCell({ row, color }: { row: Row; color: string | undefined }) {
  const now = useNow()
  return <TimeText text={ageRunText(row, now)} color={color} />
})

function diagnosticsEqual(a: Row["diagnostics"], b: Row["diagnostics"]): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  return a.every((diag, i) => diag.reason === b[i]?.reason && diag.text === b[i]?.text && diag.at === b[i]?.at)
}

/** Whether two rows would paint the same, so a round that changed nothing about a row repaints nothing. */
function sameRow(left: ListRowProps, right: ListRowProps): boolean {
  const a = left.item.row
  const b = right.item.row
  return (
    left.cursor === right.cursor &&
    left.hovered === right.hovered &&
    left.live === right.live &&
    left.queueDigit === right.queueDigit &&
    left.queueLabel === right.queueLabel &&
    left.item.run?.id === right.item.run?.id &&
    a.branch === b.branch &&
    a.head === b.head &&
    a.state === b.state &&
    a.run === b.run &&
    a.subject === b.subject &&
    a.reason === b.reason &&
    a.diagnostic === b.diagnostic &&
    diagnosticsEqual(a.diagnostics, b.diagnostics) &&
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
  layout: ListLayout
  cursor: boolean
  /** The pointer is over this row: a tint under it, and nothing else — the cursor and the detail stay where they are. */
  hovered?: boolean
  /** False on a one-shot print, which has no app-root scope for a synchronized clock to join. Default true (the watch). */
  live?: boolean
  /** Queue shortcut digit shown beside the run (ia.md). Pre-M8: 1. */
  queueDigit?: number
  /** Queue label `runShortName` prefixes (`main` in `1 · main#2342`). */
  queueLabel?: string
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
  layout,
  cursor,
  hovered = false,
  live = true,
  queueDigit = 1,
  queueLabel = "main",
}: ListRowProps) {
  const { row } = item
  const forced = cursor ? "$fg-on-selected" : undefined
  const held = row.live === undefined ? undefined : "$fg-info"
  const color = stateColor(row)
  const suffix = changesSuffix(row)
  const at = clockOf(row)
  const timeText = at !== undefined ? clock(at) : "—"
  const title =
    row.subject ??
    (row.state === "direct"
      ? (row.reason ?? "")
      : row.state === "draft"
        ? row.at === undefined
          ? "not yet read"
          : row.head.slice(0, 12)
        : `${row.head.slice(0, 12)} (subject not fetched)`)
  const shownTitle = row.diagnostic === undefined ? title : `${row.diagnostic} · ${title}`
  const separateLineSuffix = (layout.columns ?? 120) < 100 && row.state === "stuck" && suffix !== undefined
  const inlineSuffix = suffix === undefined || separateLineSuffix ? undefined : suffix.text
  const computedTaskWidth =
    layout.taskWidth ??
    Math.max(
      12,
      (layout.columns ?? 120) -
        ((layout.timeWidth ?? 5) +
          1 +
          (layout.isSeparateColumns
            ? ((layout.qWidth ?? 0) > 0 ? (layout.qWidth ?? 0) + 1 : 0) +
              ((layout.runWidth ?? 0) > 0 ? (layout.runWidth ?? 0) + 1 : 0)
            : layout.queueRunWidth + 1) +
          layout.statusWidth +
          (layout.agentWidth > 0 ? 1 + layout.agentWidth : 0) +
          1 +
          layout.ageRunWidth +
          1),
    )
  const { displayBranch, displaySuffix } = taskExtrasLayout(computedTaskWidth, row.branch, inlineSuffix)
  return (
    <Box
      flexDirection="column"
      backgroundColor={cursor ? "$bg-selected" : hovered ? "$bg-surface-hover" : undefined}
      minWidth={0}
      width="100%"
    >
      <Cells layout={layout}>
        {{
          time: <TimeText text={timeText} color={forced ?? held} />,
          q:
            (layout.qWidth ?? 0) === 0 ? null : (
              <Text color={forced ?? held ?? "$fg-muted"} wrap="truncate">
                {layout.isFullQueue ? queueLabel : String(queueDigit)}
              </Text>
            ),
          run: (
            <Text color={forced ?? held ?? "$fg-muted"} wrap="truncate">
              {runIdentifier(item.run?.id ?? row.run)}
            </Text>
          ),
          queueRun: (
            <Text color={forced ?? held ?? "$fg-muted"} wrap="truncate">
              {queueRunText(queueDigit, queueLabel, item.run?.id ?? row.run)}
            </Text>
          ),
          task: (
            <Box flexDirection="row" minWidth={0} overflow="hidden">
              <Text color={forced ?? held} wrap="truncate" minWidth={0}>
                {`${row.diagnostic !== undefined || (row.diagnostics?.length ?? 0) > 0 ? "\u26A0\uFE0E " : ""}${shownTitle}`}
              </Text>
              {displayBranch === "" ? null : (
                <Text color={forced ?? held ?? "$fg-muted"} flexShrink={0}>
                  {" "}
                  {displayBranch}
                </Text>
              )}
              {displaySuffix === undefined || suffix === undefined ? null : (
                <Text color={forced ?? suffix.color} flexShrink={0} wrap="truncate">
                  {" "}
                  ({displaySuffix})
                </Text>
              )}
            </Box>
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
          agent: (
            <Text color={forced ?? held ?? "$fg-muted"} wrap="truncate">
              {row.submitter ?? "—"}
            </Text>
          ),
          ageRun: <AgeRunCell row={row} color={forced ?? held} />,
        }}
      </Cells>
      {separateLineSuffix && suffix !== undefined ? (
        <Box height={1} flexDirection="row" minWidth={0} overflow="hidden">
          <Box
            width={
              (layout.timeWidth ?? 5) +
              1 +
              (layout.isSeparateColumns
                ? ((layout.qWidth ?? 0) > 0 ? (layout.qWidth ?? 0) + 1 : 0) +
                  ((layout.runWidth ?? 0) > 0 ? (layout.runWidth ?? 0) + 1 : 0)
                : (layout.queueRunWidth ?? 0) > 0
                  ? (layout.queueRunWidth ?? 0) + 1
                  : 0)
            }
            flexShrink={0}
          />
          <Text color={forced ?? suffix.color} wrap="truncate">
            {stateGlyph(row)} {suffix.text}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}, sameRow)

/**
 * The runner's own row, drawn in the table's columns when no change is under a
 * check to be it: TIME is the round's start, STATUS the runner's word from THE
 * ONE WORD TABLE, CHANGES what it holds or why it holds nothing, BY the held
 * change's submitter, and the last cell the word and how long.
 *
 * When the runner DOES hold a change, that change's own row is this row
 * (watch-frame.tsx `bandOf`): it already says checking, the branch, the
 * subject, the submitter and `checking 16m` in these same five cells, and
 * drawing a second line for it is the duplication the band replaced.
 */
/**
 * Splits a runner line's holds text into the status text and the cure command if present,
 * so narrow terminal layouts (under 100 columns) can render the cure on its own line without truncation.
 */
export function splitRunnerCure(holds: string): { text: string; cure?: string } {
  for (const pattern of [/^(.*?) · (resume: .*)$/u, /^(.*?) · (start: .*)$/u, /^(.*?) — (fix and .*)$/u]) {
    const [, text, cure] = holds.match(pattern) ?? []
    if (text !== undefined && cure !== undefined) return { text, cure }
  }
  return { text: holds }
}

export function RunnerRow({
  line,
  layout,
  cursor = false,
  queueDigit: _queueDigit = 1,
  queueLabel: _queueLabel = "main",
}: {
  line: RunnerLine
  layout: ListLayout
  cursor?: boolean
  queueDigit?: number
  queueLabel?: string
}) {
  const { color, word } = STATE_WORDS[line.state]
  const forced = cursor ? "$fg-on-selected" : undefined
  const timeText = line.at !== undefined ? clock(line.at) : "—"
  const parsed = splitRunnerCure(line.holds)
  const isStoppedOrPaused = line.state === "stopped" || line.state === "paused"
  const displayText =
    line.state === "stopped"
      ? `YRD STOPPED${parsed.text === "" ? "" : ` ${parsed.text}`}`
      : isStoppedOrPaused && !parsed.text.startsWith("STOPPED:")
        ? `STOPPED: ${parsed.text}`
        : parsed.text
  const cureText =
    parsed.cure === undefined
      ? undefined
      : parsed.cure.startsWith("resume:")
        ? `to resume: ${parsed.cure.slice(7).trim()}`
        : parsed.cure.startsWith("start:")
          ? `to start: ${parsed.cure.slice(6).trim()}`
          : parsed.cure.startsWith("to ")
            ? parsed.cure
            : `to ${parsed.cure}`
  return (
    <Box flexDirection="column" minWidth={0} width="100%" backgroundColor={cursor ? "$bg-selected" : undefined}>
      <Cells layout={layout}>
        {{
          time: <TimeText text={timeText} color={forced ?? color} />,
          q: null,
          run: null,
          queueRun: null,
          task: (
            <Box flexDirection="row" minWidth={0} overflow="hidden">
              <Text color={forced ?? color} wrap="truncate" minWidth={0}>
                {displayText}
              </Text>
            </Box>
          ),
          status: (
            <Box flexDirection="row" minWidth={0}>
              <Text color={forced ?? color} flexShrink={0}>
                {RUNNER_GLYPH}
              </Text>
              <Text color={forced ?? color} wrap="truncate">
                {" "}
                {runnerStatusWord(line)}
              </Text>
            </Box>
          ),
          agent: (
            <Text color={forced ?? color} wrap="truncate">
              {line.by ?? "—"}
            </Text>
          ),
          ageRun: (
            <Text color={forced ?? color} wrap="truncate">
              {line.duration ?? " "}
            </Text>
          ),
        }}
      </Cells>
      {cureText === undefined ? null : (
        <Cells layout={layout}>
          {{
            time: null,
            q: null,
            run: null,
            queueRun: null,
            task: (
              <Text color={forced ?? color} wrap="truncate" minWidth={0}>
                {cureText}
              </Text>
            ),
            status: null,
            agent: null,
            ageRun: null,
          }}
        </Cells>
      )}
    </Box>
  )
}

/** The seven cells in their one geometry, consumed by header, rows and the runner alike. */
function Cells({
  layout,
  children,
}: {
  layout: ListLayout
  children: Readonly<{
    time?: React.ReactNode
    task: React.ReactNode
    agent: React.ReactNode
    q?: React.ReactNode
    run?: React.ReactNode
    queueRun?: React.ReactNode
    status: React.ReactNode
    ageRun: React.ReactNode
  }>
}) {
  return (
    <Box height={1} width="100%" flexDirection="row" gap={1} minWidth={0} overflow="hidden" paddingRight={1}>
      <Box width={layout.timeWidth ?? 5} flexShrink={0}>
        {children.time}
      </Box>
      {layout.isSeparateColumns ? (
        <>
          {(layout.qWidth ?? 0) === 0 || children.q == null ? null : (
            <Box width={layout.qWidth ?? 0} flexShrink={0}>
              {children.q}
            </Box>
          )}
          {children.run == null ? null : (
            <Box width={layout.runWidth ?? 0} flexShrink={0}>
              {children.run}
            </Box>
          )}
        </>
      ) : children.queueRun == null ? null : (
        <Box width={layout.queueRunWidth} flexShrink={0}>
          {children.queueRun}
        </Box>
      )}
      <Box flexGrow={1} flexBasis={0} minWidth={12}>
        {children.task}
      </Box>
      <Box width={layout.statusWidth} flexShrink={0} flexDirection="row">
        {children.status}
      </Box>
      {layout.agentWidth === 0 ? null : (
        <Box width={layout.agentWidth} flexShrink={0}>
          {children.agent}
        </Box>
      )}
      <Box width={layout.ageRunWidth} flexShrink={0} justifyContent="flex-end">
        {children.ageRun}
      </Box>
    </Box>
  )
}

/** Status pills, right-aligned. Independent toggles; no All pill (ia.md). `a` still shows every status. */
export function StatusPills({
  buckets,
  onSelectOnly,
}: {
  buckets: ReadonlySet<StatusBucket>
  onSelectOnly: (bucket: StatusBucket) => void
}) {
  return (
    <Box height={1} flexDirection="row" justifyContent="flex-end" minWidth={0} overflow="hidden" gap={1}>
      {BUCKETS.map((bucket) => (
        <TopPill
          key={bucket}
          label={`[${bucket.slice(0, 1)}]${bucket.slice(1)}`}
          active={buckets.has(bucket)}
          activeTreatment="warningText"
          onToggle={() => {
            onSelectOnly(bucket)
          }}
        />
      ))}
    </Box>
  )
}
