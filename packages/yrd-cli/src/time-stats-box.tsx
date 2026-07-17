/**
 * TimeStatsBox — the queue watch's single bordered STATS box. Inside it, the
 * FLOW throughput and TIME duration sections share the same four rolling-window
 * columns (HR / DAY / WK / MON). The sections arrange side by side on a wide pane
 * and stack into one column as the pane narrows, without becoming separate boxes.
 *
 * Both sections share one compact row model: their first row carries the section
 * name plus the window keys, and TIME prefixes each distribution row with its
 * sample (INTEGRATED / FAILED / WAIT). Blank cells render a space so every
 * column keeps one cell per row and the grid stays aligned.
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
 * two-across threshold also accounts for the shared STATS border and padding. */
const BOX_MIN_WIDTH = 34
const GRID_GAP = 1
const STATS_FRAME_CHROME = 4
const TWO_ACROSS_MIN = 2 * BOX_MIN_WIDTH + GRID_GAP + STATS_FRAME_CHROME

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

function flowRows(stats: readonly QueueTimeWindowStats[], windowKeys: readonly string[]): readonly BoxRow[] {
  return [
    { label: "FLOW", keys: true, heading: true, cells: windowKeys },
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
    { label: `${label} avg`, indent: true, cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).avgMs)) },
    { label: `${label} p50`, indent: true, cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).p50Ms)) },
    { label: `${label} p90`, indent: true, cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).p90Ms)) },
  ]
}

function timeRows(stats: readonly QueueTimeWindowStats[], windowKeys: readonly string[]): readonly BoxRow[] {
  return [
    { label: "TIME", keys: true, heading: true, cells: windowKeys },
    ...timeMetricRows("INTEGRATED", stats, (m) => m.activeRun.integratedOnly),
    ...timeMetricRows("FAILED", stats, (m) => m.activeRun.failedOnly),
    ...timeMetricRows("WAIT", stats, (m) => m.queueWait),
  ]
}

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const groups: T[][] = []
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size))
  return groups
}

/** One unframed section inside the shared STATS box. */
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
 * Bind the windowed projection to one full-width STATS box. Its FLOW + TIME
 * sections sit side by side when wide and stack inside the same frame when narrow.
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
  const sections = [
    { title: "FLOW", rows: flowRows(stats, windowKeys) },
    { title: "TIME", rows: timeRows(stats, windowKeys) },
  ]
  const perRow = width >= TWO_ACROSS_MIN ? 2 : 1
  return (
    <TitledBox title="STATS" marginTop={1}>
      {chunk(sections, perRow).map((group, index) => (
        <Box key={index} flexDirection="row" gap={GRID_GAP} minWidth={0} alignItems="flex-start">
          {group.map((section) => (
            <Box key={section.title} flexGrow={1} flexBasis={0} minWidth={0}>
              <TimeStatsSection rows={section.rows} />
            </Box>
          ))}
        </Box>
      ))}
    </TitledBox>
  )
}
