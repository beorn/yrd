/**
 * The STATS box under the table (watch-redesign items 18–22).
 *
 * RUNNER was a box here until the flow page (S1): four rails for the service
 * command, the round header, a file mtime printed twice and a silence verdict
 * derived from that mtime, in a frame of its own above a table it was not part
 * of. The one useful line is now a ROW, in the table's own columns, between
 * what waits and what is done — so the runner's word sits in the same STATUS
 * column as every change's and reads from the same table (watch-words.ts).
 * The rest — pid, command, code version, check list, round id — is repair
 * detail, and it belongs to `yrd queue show`, `--json` and the detail view.
 * The row is built by `runnerLine` (watch-runner.ts) and drawn by `RunnerRow`
 * (watch-list.tsx), placed by `bandPlan` (watch-frame.tsx).
 */

import { Box, Text } from "silvery"
import { useMinute } from "./watch-clock.ts"
import {
  countCell,
  statsBuckets,
  timeCell,
  STATS_ROWS,
  STATS_TIME_ROWS,
  type RunDecision,
  type StatsBucket,
} from "./watch-stats.ts"
import { TitledBox } from "./watch-primitives.tsx"

/** Gutter 2 + borders 2 + the box's paddingX 2: what a box's own content cannot have (the retired box's accounting). */
const BOX_CHROME = 6

/** The label column of the STATS box, wide enough for `QUEUING` and a space. */
const STATS_LABEL_WIDTH = 8
/** One hour cell: a count of up to three digits or a duration like `45m`, right-aligned with one cell of air. */
const STATS_HOUR_WIDTH = 4
/** The four calendar columns, by bucket key: `YSTRDAY` is the wide one. */
const STATS_PERIOD_WIDTHS: Readonly<Record<string, number>> = { month: 6, today: 6, week: 6, yesterday: 8 }
const STATS_PERIODS_WIDTH = Object.values(STATS_PERIOD_WIDTHS).reduce((sum, width) => sum + width, 0)

/** How many hour buckets fit beside the label and the four calendar columns, between 6 and 24. */
export function statsHoursFor(columns: number): number {
  const fixed = BOX_CHROME + STATS_LABEL_WIDTH + STATS_PERIODS_WIDTH + 2
  return Math.max(6, Math.min(24, Math.floor((columns - fixed) / STATS_HOUR_WIDTH)))
}

/**
 * The colour of a count row — the retired box's: merges and passes are
 * successes, a duplicate merged nothing and is muted, a fail is an error, a
 * stuck run is the warning it is, and the run count is plain.
 */
const STATS_ROW_COLOR: Readonly<Partial<Record<(typeof STATS_ROWS)[number]["key"], string>>> = {
  duplicates: "$fg-muted",
  fails: "$fg-error",
  merges: "$fg-success",
  passes: "$fg-success",
  stuck: "$fg-warning",
}

/**
 * The STATS box (items 18–22): `TODAY`, `YSTRDAY`, `WEEK`, `MONTH`, then the
 * hours of the last day newest first; every number right-aligned (item 19);
 * the local midnight as its own one-character column running through header
 * and rows alike (item 20); DUP muted and just above FAILS (items 21, 22);
 * under the counts, the TIME rows — median opened→merged, opened→started,
 * started→ended, and the mean same-head retries a merge took — the retired
 * box's AVG TIME section on the new core's rows.
 */
export function StatsBox({
  decisions,
  columns,
  timeRows = true,
}: {
  decisions: readonly RunDecision[]
  columns: number
  /** Draw the TIME rows under the counts; a short terminal keeps the counts and gives the list the rows instead. */
  timeRows?: boolean
}) {
  // Hour buckets move on the minute at most; nothing here needs the seconds.
  const minute = useMinute()
  const buckets = statsBuckets(decisions, minute, statsHoursFor(columns))
  const periods = buckets.filter((bucket) => bucket.kind === "period")
  const hours = buckets.filter((bucket) => bucket.kind === "hour")
  const cell = (bucket: StatsBucket, text: string, color: string | undefined, bold = false) => (
    <Box
      key={bucket.key}
      width={bucket.kind === "hour" ? STATS_HOUR_WIDTH : (STATS_PERIOD_WIDTHS[bucket.key] ?? 6)}
      flexShrink={0}
      justifyContent="flex-end"
    >
      <Text color={color} bold={bold}>
        {text}
      </Text>
    </Box>
  )
  // The midnight rule: one blank-or-bar cell BEFORE every hour bucket that
  // starts a new local day, on every row, so the column reads as one line.
  const boundary = (bucket: StatsBucket) =>
    bucket.dayBoundary ? (
      <Box key={`${bucket.key}-day`} width={1} flexShrink={0}>
        <Text color="$fg-muted">│</Text>
      </Box>
    ) : null
  const line = (
    key: string,
    label: string,
    text: (bucket: StatsBucket) => string,
    color: string | undefined,
    bold = false,
  ) => (
    <Box key={key} flexDirection="row" minWidth={0} overflow="hidden">
      <Box width={STATS_LABEL_WIDTH} flexShrink={0}>
        <Text color={color ?? undefined} bold={bold}>
          {label}
        </Text>
      </Box>
      {periods.map((bucket) => cell(bucket, text(bucket), color, bold))}
      <Box width={2} flexShrink={0}>
        <Text color="$fg-muted"> │</Text>
      </Box>
      {hours.flatMap((bucket) => [boundary(bucket), cell(bucket, text(bucket), color, bold)])}
    </Box>
  )
  return (
    <TitledBox title="STATS">
      {line("header", "", (bucket) => bucket.label, "$fg-muted", true)}
      {STATS_ROWS.map((row) =>
        line(row.key, row.label, (bucket) => countCell(bucket, row.key), STATS_ROW_COLOR[row.key]),
      )}
      {/* The heading names the statistic: these rows are medians, not means or sums,
          and a reader cannot tell which from the numbers alone. Fits STATS_LABEL_WIDTH. */}
      {timeRows ? line("time", "MEDIAN", () => "", "$fg-muted", true) : null}
      {timeRows
        ? STATS_TIME_ROWS.map((row) => line(row.key, row.label, (bucket) => timeCell(bucket, row.key), "$fg-muted"))
        : null}
    </TitledBox>
  )
}
