/**
 * TimeStatsBox — the reusable bordered statistics box the queue watch renders in
 * place of the old single STATS box. The queue watch shows two side by side: a
 * FLOW throughput box and a TIME duration box whose INTEGRATED / FAILED / WAIT
 * sections stack vertically, all across the four rolling-window columns (HR / DAY
 * / WK / MON). They arrange side by side on a wide pane and stack into one column
 * as the pane narrows.
 *
 * Both boxes share one row model: the window-key header is just the first row
 * (blank label for FLOW, the INTEGRATED section label for TIME); section headers
 * are rows with blank value cells; metric rows are indented. Blank cells render a
 * space so every column keeps one cell per row and the grid stays aligned.
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
type BoxRow = Readonly<{ label: string; indent?: boolean; keys?: boolean; cells: readonly string[] }>

/** Readable floor for a single box (label column + four value cells + border and
 * padding). The two-across threshold derives from it so there is one number to tune. */
const BOX_MIN_WIDTH = 34
const GRID_GAP = 1
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

function flowRows(stats: readonly QueueTimeWindowStats[], windowKeys: readonly string[]): readonly BoxRow[] {
  return [
    { label: "", keys: true, cells: windowKeys },
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

/**
 * One TIME section: a header row (the INTEGRATED section also carries the window
 * keys; later sections leave the header cells blank so the keys render once) plus
 * the avg / p50 / p90 metric rows.
 */
function timeSection(
  label: string,
  stats: readonly QueueTimeWindowStats[],
  keys: readonly string[] | null,
  pick: (metrics: QueueTimeWindowStats["metrics"]) => WindowDistribution,
): readonly BoxRow[] {
  const header: BoxRow = keys === null ? { label, cells: stats.map(() => "") } : { label, keys: true, cells: keys }
  return [
    header,
    { label: "avg", indent: true, cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).avgMs)) },
    { label: "p50", indent: true, cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).p50Ms)) },
    { label: "p90", indent: true, cells: stats.map((s) => formatDuration(s.covered, pick(s.metrics).p90Ms)) },
  ]
}

function timeRows(stats: readonly QueueTimeWindowStats[], windowKeys: readonly string[]): readonly BoxRow[] {
  return [
    ...timeSection("INTEGRATED", stats, windowKeys, (m) => m.activeRun.integratedOnly),
    ...timeSection("FAILED", stats, null, (m) => m.activeRun.failedOnly),
    ...timeSection("WAIT", stats, null, (m) => m.queueWait),
  ]
}

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const groups: T[][] = []
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size))
  return groups
}

/** One bordered box: title, then the rows (window-key header, sections, metrics). */
export function TimeStatsBox({ title, rows }: Readonly<{ title: string; rows: readonly BoxRow[] }>) {
  const windowCount = rows.reduce((count, row) => Math.max(count, row.cells.length), 0)
  return (
    <TitledBox title={title}>
      <Box flexDirection="row" gap={GRID_GAP} minWidth={0}>
        <Box flexDirection="column" flexShrink={0}>
          {rows.map((row, index) => (
            <Text key={index} color={row.indent ? "$fg-muted" : undefined}>
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
    </TitledBox>
  )
}

/**
 * Bind the windowed projection to the FLOW + TIME boxes and arrange them for the
 * pane — side by side when wide, stacked into one column when narrow.
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
    { title: "FLOW", rows: flowRows(stats, windowKeys) },
    { title: "TIME", rows: timeRows(stats, windowKeys) },
  ]
  const perRow = width >= TWO_ACROSS_MIN ? 2 : 1
  return (
    <Box flexDirection="column" marginTop={1} minWidth={0}>
      {chunk(boxes, perRow).map((group, index) => (
        <Box key={index} flexDirection="row" gap={GRID_GAP} minWidth={0} alignItems="flex-start">
          {group.map((box) => (
            <Box key={box.title} flexGrow={1} flexBasis={0} minWidth={0}>
              <TimeStatsBox title={box.title} rows={box.rows} />
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}
