/**
 * The watch's LIST view — the table, its header, the top line and the filter
 * pills (watch-redesign items 3, 28, 30–33, 38):
 *
 *   YRD QUEUES   1 /hh ⎇ main                              ← the top line: title + queue pills, nothing else (30, 32b, 33)
 *   TIME      STATUS      RUN           CHANGES                        BY        AGE   RUNTIME
 *   17:04:06  ○ queued    —             task/foo  fix the parser        @ci      0:37
 *   17:02:11  ◉ queued    main#170206   task/bar  add a check (typecheck) @chief  3:12  1:02
 *   16:55:40  ✓ merged    main#165540   task/baz  drop a flag           @dev/2  14:20  4:01
 *                                                     open  running  done  failed  all   ← status pills, right-aligned (9/32)
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
import { Box, Text, TogglePill, TogglePillGroup } from "silvery"
import { clocks, type Row, type WatchRow } from "@yrd/queue-core"
import { useNow } from "./watch-clock.ts"
import { clock, friendlyPath, mediaDuration, runShortName, stateColor, stateGlyph } from "./watch-format.ts"

/** The status filter buckets, in the order the pills show them (items 9, 32). */
export const BUCKETS = ["open", "running", "done", "failed"] as const
export type StatusBucket = (typeof BUCKETS)[number]

/** Which bucket a row is in — read off the state and the live overlay, decided nowhere else. */
export function bucketOf(row: Pick<Row, "state" | "live">): StatusBucket {
  if (row.live !== undefined) return "running"
  switch (row.state) {
    case "merged":
    case "direct":
      return "done"
    case "failed":
      return "failed"
    case "queued":
    case "checked":
    case "stuck":
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
  ageWidth: number
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
  if (row.state === "stuck" && row.reason !== undefined) return { color: "$fg-warning", text: `stuck=${row.reason}` }
  return undefined
}

/** The widths every row and the header share, so they cannot drift (the retired `timelineCellLayout`). */
export function listLayout(rows: readonly WatchRow[], label: string, columns: number, now: Date): ListLayout {
  const cells = rows.map((item, index) => runCell(item, label, rows[index - 1]))
  const measured = rows.map((item) => clocks(item.row, now))
  return {
    timeWidth: 8,
    statusWidth: Math.max(6, ...rows.map((item) => item.row.state.length + 2)),
    runWidth: Math.max(3, ...cells.map((cell) => (cell.kind === "run" ? cell.text.length : 1))),
    byWidth: columns < 100 ? 0 : Math.max(2, ...rows.map((item) => (item.row.submitter ?? "-").length)),
    ageWidth: Math.max(
      3,
      ...measured.map((clock) => (clock.ageMs === undefined ? 0 : mediaDuration(clock.ageMs).length)),
    ),
    durationWidth: Math.max(
      "RUNTIME".length,
      ...measured.map((clock) => (clock.runtimeMs === undefined ? 0 : mediaDuration(clock.runtimeMs).length)),
    ),
  }
}

/** The local calendar day a row's instant falls on, for the separators between days. */
export function dayOf(at: Date | undefined): string | undefined {
  if (at === undefined) return undefined
  const two = (value: number): string => String(value).padStart(2, "0")
  return `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}`
}

/** A date separator appears strictly BETWEEN two adjacent rows whose local calendar day differs. */
export function separatorBefore(rows: readonly WatchRow[], index: number): string | undefined {
  if (index === 0) return undefined
  const day = dayOf(rows[index]?.row.at)
  const previous = dayOf(rows[index - 1]?.row.at)
  return day !== undefined && previous !== undefined && day !== previous ? day : undefined
}

/** The top line (items 30, 32, 33): `YRD QUEUES`, then one pill per queue; a selected pill fills its background. */
export function TopLine({
  queues,
  visible,
  onToggle,
}: {
  queues: readonly WatchQueue[]
  /** The labels of the queues shown; `undefined` means every one. */
  visible: ReadonlySet<string> | undefined
  onToggle: (label: string) => void
}) {
  return (
    <Box height={1} flexDirection="row" columnGap={2} flexShrink={0} minWidth={0} overflow="hidden" paddingLeft={1}>
      <Text bold flexShrink={0}>
        YRD QUEUES
      </Text>
      <TogglePillGroup flexShrink={1} minWidth={0} overflow="hidden">
        {queues.map((queue, index) => {
          const selected = visible === undefined || visible.has(queue.label)
          return (
            <Box
              key={`${queue.path}@${queue.branch}`}
              backgroundColor={selected ? "$bg-selected" : "$bg-surface-subtle"}
              paddingX={1}
              flexShrink={0}
            >
              <TogglePill
                label={pillLabel(queue, index + 1)}
                boldFirstLetter
                active={selected}
                onToggle={() => {
                  onToggle(queue.label)
                }}
              />
            </Box>
          )
        })}
      </TogglePillGroup>
    </Box>
  )
}

/** The column header: the same layout every row uses. */
export function ListHeader({ layout }: { layout: ListLayout }) {
  const label = (text: string): React.ReactNode => (
    <Text bold wrap="truncate">
      {text}
    </Text>
  )
  return (
    <Cells layout={layout}>
      {{
        age: label("AGE"),
        by: label("BY"),
        changes: label("CHANGES"),
        duration: label("RUNTIME"),
        run: label("RUN"),
        status: label("STATUS"),
        time: label("TIME"),
      }}
    </Cells>
  )
}

/**
 * The two cells that show a relative time, each its own leaf on the
 * one-second clock, memoized on the instants it is measured from: the tick
 * re-renders these and nothing else in the row.
 */
const AgeCell = memo(function AgeCell({ since, color }: { since: Date | undefined; color: string | undefined }) {
  const now = useNow()
  const measured = clocks({ since } as Row, now)
  return (
    <Text color={color ?? "$fg-muted"} wrap="truncate">
      {measured.ageMs === undefined ? "" : mediaDuration(measured.ageMs)}
    </Text>
  )
})

const RuntimeCell = memo(function RuntimeCell({
  startedAt,
  endedAt,
  color,
}: {
  startedAt: Date | undefined
  endedAt: Date | undefined
  color: string | undefined
}) {
  const now = useNow()
  const measured = clocks({ startedAt, endedAt } as Row, now)
  return (
    <Text color={color ?? "$fg-muted"} wrap="truncate">
      {measured.runtimeMs === undefined ? " " : mediaDuration(measured.runtimeMs)}
    </Text>
  )
})

/** Whether two rows would paint the same, so a round that changed nothing about a row repaints nothing. */
function sameRow(left: ListRowProps, right: ListRowProps): boolean {
  const a = left.item.row
  const b = right.item.row
  return (
    left.cursor === right.cursor &&
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
    a.submitter === b.submitter &&
    a.live?.check === b.live?.check &&
    a.at?.getTime() === b.at?.getTime() &&
    a.since?.getTime() === b.since?.getTime() &&
    a.startedAt?.getTime() === b.startedAt?.getTime() &&
    a.endedAt?.getTime() === b.endedAt?.getTime() &&
    Object.entries(left.layout).every(([key, value]) => right.layout[key as keyof ListLayout] === value)
  )
}

type ListRowProps = Readonly<{
  item: WatchRow
  previous: WatchRow | undefined
  label: string
  layout: ListLayout
  cursor: boolean
}>

/** One row of the table. Reads no clock itself: its two time cells do. */
export const ListRow = memo(function ListRow({ item, previous, label, layout, cursor }: ListRowProps) {
  const { row } = item
  const forced = cursor ? "$fg-on-selected" : undefined
  const color = stateColor(row)
  const cell = runCell(item, label, previous)
  const suffix = changesSuffix(row)
  return (
    <Box backgroundColor={cursor ? "$bg-selected" : undefined} minWidth={0} width="100%">
      <Cells layout={layout}>
        {{
          age: <AgeCell since={row.since} color={forced} />,
          by: (
            <Text color={forced ?? "$fg-muted"} wrap="truncate">
              {row.submitter ?? "-"}
            </Text>
          ),
          changes: (
            <Box flexDirection="row" minWidth={0} overflow="hidden">
              <Text color={forced} flexShrink={0}>
                {row.branch}
              </Text>
              <Box paddingLeft={1} minWidth={0} overflow="hidden" flexDirection="row">
                <Text color={forced} wrap="truncate" minWidth={0}>
                  {row.subject ??
                    (row.state === "direct" ? (row.reason ?? "") : `${row.head.slice(0, 12)} (subject not fetched)`)}
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
          duration: <RuntimeCell startedAt={row.startedAt} endedAt={row.endedAt} color={forced} />,
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
              <Text color={forced ?? color} flexShrink={0}>
                {stateGlyph(row)}
              </Text>
              <Text color={forced ?? (row.live === undefined ? undefined : color)} wrap="truncate">
                {" "}
                {row.state}
              </Text>
            </Box>
          ),
          time: (
            <Text color={forced ?? "$fg-muted"} wrap="truncate">
              {row.at === undefined ? "-" : clock(row.at, { seconds: true })}
            </Text>
          ),
        }}
      </Cells>
    </Box>
  )
}, sameRow)

/** The seven cells in their one geometry, consumed by header and rows alike. */
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
    age: React.ReactNode
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
      <Box width={layout.ageWidth} flexShrink={0} justifyContent="flex-end">
        {children.age}
      </Box>
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
