/**
 * TimeStatsBox — the queue watch's separately bordered FLOW and TIME boxes.
 * Both share the same four rolling-window columns (HR / DAY / WK / MON). The
 * frames arrange side by side on a wide pane and stack as the pane narrows.
 *
 * Both sections share one compact row model. Their first row names the metric
 * column plus the window keys; TIME then groups avg/p50/p90 beneath one heading
 * for each sample (INTEGRATED / FAILED / WAIT). Blank cells render a space so
 * every column keeps one cell per row and the grid stays aligned.
 *
 * Extraction note: TimeStatsBox lives in yrd-cli today because it is the only
 * consumer. If a second surface needs a windowed-metric box, promote it into
 * silvery as a general component — it depends on nothing yrd-specific beyond the
 * duration formatter reused from the queue timeline.
 */

import { Box, Text } from "silvery"
import { type QueueTerminalFact, TitledBox, timelineMetric } from "./queue-status-view.tsx"
import { type QueueTimeWindowStats, queueTimeStats } from "./time-stats.ts"

/** The AVG / p50 / p90 fields both DurationDistribution and QueueWaitDistribution share. */
type WindowDistribution = Readonly<{ avgMs: number | null; p50Ms: number | null; p90Ms: number | null }>

/**
 * One row of a box: a label plus one pre-formatted cell per window.
 * - `keys` marks the window-key header row (dim cells).
 * - `indent` marks an indented, muted metric row (avg/p50/p90, FLOW sub-shares).
 * - a section header carries the section name as `label` with blank `cells`.
 */
type BoxRow = Readonly<{
  label: string
  indent?: boolean
  keys?: boolean
  heading?: boolean
  cells: readonly string[]
}>

/** Readable floor for a section (label column + four value cells). The
 * two-across threshold also accounts for the shared FLOW border and padding. */
const BOX_MIN_WIDTH = 34
const GRID_GAP = 1
const FLOW_FRAME_CHROME = 4
export const TIME_STATS_TWO_ACROSS_MIN_WIDTH = 2 * BOX_MIN_WIDTH + GRID_GAP + FLOW_FRAME_CHROME

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

/** A count renders `-` only when the window is not fully spanned by history. */
function formatCount(covered: boolean, value: number): string {
  return covered ? String(value) : "-"
}

/** A share of the window's runs; `-` when uncovered or when there are no runs. */
function formatShareOfRuns(covered: boolean, part: number, runs: number): string {
  if (!covered || runs === 0) return "-"
  return percent(part / runs)
}

/** A share of the window's failures; `-` when uncovered or when nothing failed. */
function formatShareOfFails(covered: boolean, part: number, fails: number): string {
  if (!covered || fails === 0) return "-"
  return percent(part / fails)
}

/** A human duration; `-` when uncovered, `none` for a covered empty sample. */
function formatDuration(covered: boolean, ms: number | null): string {
  if (!covered) return "-"
  return ms === null ? "none" : timelineMetric(ms)
}

/** Failed Runs in a window = rejected + env-refused + canceled. */
function failsOf(stats: QueueTimeWindowStats): number {
  const { rejected, environmentRefused, canceled } = stats.metrics.outcomes
  return rejected + environmentRefused + canceled
}

function flowRows(stats: readonly QueueTimeWindowStats[], windowKeys: readonly string[]): readonly BoxRow[] {
  return [
    { label: "METRIC", keys: true, heading: true, cells: windowKeys },
    { label: "RUNS", cells: stats.map((s) => formatCount(s.covered, s.metrics.terminalAttempts)) },
    { label: "INTEGRATED", cells: stats.map((s) => formatCount(s.covered, s.metrics.outcomes.integrated)) },
    { label: "FAILS", cells: stats.map((s) => formatShareOfRuns(s.covered, failsOf(s), s.metrics.terminalAttempts)) },
    {
      label: "decision",
      indent: true,
      cells: stats.map((s) => formatShareOfFails(s.covered, s.metrics.outcomes.rejected, failsOf(s))),
    },
    {
      label: "env",
      indent: true,
      cells: stats.map((s) => formatShareOfFails(s.covered, s.metrics.outcomes.environmentRefused, failsOf(s))),
    },
    {
      label: "canceled",
      indent: true,
      cells: stats.map((s) => formatShareOfFails(s.covered, s.metrics.outcomes.canceled, failsOf(s))),
    },
  ]
}

function timeMetricRows(
  label: string,
  stats: readonly QueueTimeWindowStats[],
  pick: (metrics: QueueTimeWindowStats["metrics"]) => WindowDistribution,
): readonly BoxRow[] {
  return [
    { label, heading: true, cells: [] },
    { label: "avg", indent: true, cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).avgMs)) },
    { label: "p50", indent: true, cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).p50Ms)) },
    { label: "p90", indent: true, cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).p90Ms)) },
  ]
}

function timeRows(stats: readonly QueueTimeWindowStats[], windowKeys: readonly string[]): readonly BoxRow[] {
  return [
    { label: "METRIC", keys: true, heading: true, cells: windowKeys },
    ...timeMetricRows("INTEGRATED", stats, (m) => m.activeRun.integratedOnly),
    ...timeMetricRows("FAILED", stats, (m) => m.activeRun.failedOnly),
    ...timeMetricRows("WAIT", stats, (m) => m.queueWait),
    ...(stats.some((entry) => !entry.covered)
      ? [{ label: "- no full window", indent: true, cells: [] } satisfies BoxRow]
      : []),
  ]
}

/** One metric grid inside its titled frame. */
function TimeStatsSection({ rows }: Readonly<{ rows: readonly BoxRow[] }>) {
  const windowCount = rows.reduce((count, row) => Math.max(count, row.cells.length), 0)
  return (
    <Box width="100%" flexDirection="column" minWidth={0}>
      <Box flexDirection="row" gap={GRID_GAP} minWidth={0}>
        <Box flexDirection="column" flexShrink={0}>
          {rows.map((row, index) => (
            <Text key={index} color={row.indent ? "$fg-muted" : undefined} bold={row.heading}>
              {row.indent ? "  " : ""}
              {row.label === "" ? " " : row.label}
            </Text>
          ))}
        </Box>
        {Array.from({ length: windowCount }, (_, column) => (
          <Box key={column} flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} alignItems="flex-end">
            {rows.map((row, index) => (
              <Text key={index} color={row.keys ? "$fg-muted" : undefined} wrap="truncate">
                {row.cells[column] === undefined || row.cells[column] === "" ? " " : row.cells[column]}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/**
 * Bind the windowed projection to independently bordered FLOW + TIME frames.
 * They sit side by side when wide and stack when narrow.
 *
 * @param facts  every retained terminal Run fact (the projection folds these once)
 * @param now    the snapshot clock as an ISO instant
 * @param earliestEventMs  the oldest journal record's time (drives the `-` gate)
 * @param width  the pane content width, in cells, chosen by the caller
 */
export function TimeStatsBox({
  facts,
  now,
  earliestEventMs,
  width,
}: Readonly<{
  facts: readonly QueueTerminalFact[]
  now: string
  earliestEventMs: number | null
  width: number
}>) {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`yrd: invalid time-stats snapshot '${now}'`)
  const stats = queueTimeStats(facts, nowMs, earliestEventMs)
  const windowKeys = stats.map((entry) => entry.key)
  const perRow = width >= TIME_STATS_TWO_ACROSS_MIN_WIDTH ? 2 : 1
  const flow = flowRows(stats, windowKeys)
  const time = timeRows(stats, windowKeys)
  const alignedFlow =
    perRow === 2 && flow.length < time.length
      ? [...flow, ...Array.from({ length: time.length - flow.length }, () => ({ label: "", cells: [] }) as BoxRow)]
      : flow
  return (
    <Box
      flexDirection={perRow === 2 ? "row" : "column"}
      gap={GRID_GAP}
      minWidth={0}
      alignItems="flex-start"
      marginTop={1}
      flexShrink={0}
    >
      <Box
        width={perRow === 1 ? "100%" : undefined}
        flexGrow={perRow === 2 ? 1 : undefined}
        flexBasis={perRow === 2 ? 0 : undefined}
        minWidth={0}
      >
        <TitledBox title="FLOW">
          <TimeStatsSection rows={alignedFlow} />
        </TitledBox>
      </Box>
      <Box
        width={perRow === 1 ? "100%" : undefined}
        flexGrow={perRow === 2 ? 1 : undefined}
        flexBasis={perRow === 2 ? 0 : undefined}
        minWidth={0}
      >
        <TitledBox title="TIME">
          <TimeStatsSection rows={time} />
        </TitledBox>
      </Box>
    </Box>
  )
}
