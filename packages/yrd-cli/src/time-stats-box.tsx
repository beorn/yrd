/**
 * TimeStatsBox — the reusable bordered statistics box the queue watch renders
 * side by side in place of the old single STATS box. Each box carries a title,
 * a dim header row of the four rolling-window columns (HR / DAY / WK / MON), and
 * a set of labelled value rows. `TimeStatsBoxes` binds the windowed projection
 * to four boxes and arranges them responsively — four across on a wide pane,
 * wrapping to a 2x2 grid, then a single column as the pane narrows.
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

/** One labelled row of a box: a label plus one pre-formatted cell per window. */
type StatRow = Readonly<{ label: string; indent?: boolean; cells: readonly string[] }>

/** Readable floor for a single box (label column + four value cells + border and
 * padding). The grid thresholds derive from it so there is one number to tune. */
const BOX_MIN_WIDTH = 34
const GRID_GAP = 1
const FOUR_ACROSS_MIN = 4 * BOX_MIN_WIDTH + 3 * GRID_GAP
const TWO_ACROSS_MIN = 2 * BOX_MIN_WIDTH + GRID_GAP

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

/** A human duration; `-` when uncovered or when the sample set is empty. */
function formatDuration(covered: boolean, ms: number | null): string {
  return covered ? timelineMetric(ms) : "-"
}

/** Failed Runs in a window = rejected + env-refused + canceled. */
function failsOf(stats: QueueTimeWindowStats): number {
  const { rejected, environmentRefused, canceled } = stats.metrics.outcomes
  return rejected + environmentRefused + canceled
}

function flowRows(stats: readonly QueueTimeWindowStats[]): readonly StatRow[] {
  return [
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

function durationRows(
  stats: readonly QueueTimeWindowStats[],
  pick: (metrics: QueueTimeWindowStats["metrics"]) => WindowDistribution,
): readonly StatRow[] {
  return [
    { label: "AVG", cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).avgMs)) },
    { label: "p50", cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).p50Ms)) },
    { label: "p90", cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).p90Ms)) },
  ]
}

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const groups: T[][] = []
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size))
  return groups
}

/** One bordered box: title, dim window-key header, then the value rows. */
export function TimeStatsBox({
  title,
  windowKeys,
  rows,
}: Readonly<{ title: string; windowKeys: readonly string[]; rows: readonly StatRow[] }>) {
  return (
    <TitledBox title={title}>
      <Box flexDirection="row" gap={GRID_GAP} minWidth={0}>
        <Box flexDirection="column" flexShrink={0}>
          {/* Header spacer keeps the label column aligned with the value rows. */}
          <Text> </Text>
          {rows.map((row) => (
            <Text key={row.label} color={row.indent ? "$fg-muted" : undefined}>
              {row.indent ? "  " : ""}
              {row.label}
            </Text>
          ))}
        </Box>
        {windowKeys.map((key, column) => (
          <Box key={key} flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} alignItems="flex-end">
            <Text color="$fg-muted">{key}</Text>
            {rows.map((row) => (
              <Text key={row.label} wrap="truncate">
                {row.cells[column]}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    </TitledBox>
  )
}

/**
 * Bind the windowed projection to the four boxes and arrange them for the pane.
 *
 * @param facts  every retained terminal Run fact (the projection folds these once)
 * @param now    the snapshot clock as an ISO instant
 * @param earliestEventMs  the oldest journal record's time (drives the `-` gate)
 * @param width  the pane content width, in cells, chosen by the caller
 */
export function TimeStatsBoxes({
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
  const boxes = [
    { title: "FLOW", rows: flowRows(stats) },
    { title: "TIME INTEGRATED", rows: durationRows(stats, (metrics) => metrics.activeRun.integratedOnly) },
    { title: "TIME FAILED", rows: durationRows(stats, (metrics) => metrics.activeRun.failedOnly) },
    { title: "TIME WAIT", rows: durationRows(stats, (metrics) => metrics.queueWait) },
  ]
  const perRow = width >= FOUR_ACROSS_MIN ? 4 : width >= TWO_ACROSS_MIN ? 2 : 1
  return (
    <Box flexDirection="column" marginTop={1} minWidth={0}>
      {chunk(boxes, perRow).map((group, index) => (
        <Box key={windowKeys.length + index} flexDirection="row" gap={GRID_GAP} minWidth={0}>
          {group.map((box) => (
            <Box key={box.title} flexGrow={1} flexBasis={0} minWidth={0}>
              <TimeStatsBox title={box.title} windowKeys={windowKeys} rows={box.rows} />
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}
