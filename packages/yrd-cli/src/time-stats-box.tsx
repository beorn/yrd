/** Width-adaptive, journal-derived queue statistics with shared accessible detail. */

import { useCallback, useEffect, useState } from "react"
import { Box, Text, Tooltip, useFocusable } from "silvery"
import { type QueueTerminalFact } from "./queue-terminal-facts.ts"
import { TitledBox, timelineMetric } from "./queue-view-primitives.tsx"
import { FAILURE_BREAKDOWN_CLASSES } from "./status-presentation.ts"
import { type QueueStatsBucket, type QueueStatsDurationDistribution, queueStats } from "./time-stats.ts"

const STATS_ROW_LABEL_WIDTH = 12
const STATS_FIXED_MIN_WIDTH = 48
const STATS_HOUR_BASE_WIDTH = 50
const STATS_HOUR_STRIDE = 5

/**
 * The four calendar columns always remain present. Remaining horizontal space
 * becomes newest-first local hour columns. Repeated local clock labels are
 * disambiguated by the calendar projection rather than silently capped.
 */
export function queueStatsHourCount(width: number): number {
  if (!Number.isFinite(width)) throw new TypeError("yrd: queue-stats width must be finite")
  return Math.max(0, Math.floor((Math.trunc(width) - STATS_HOUR_BASE_WIDTH) / STATS_HOUR_STRIDE))
}

type StatsDetailMetric = "fails" | "total" | "queueWait" | "jobRun" | "retries"

type StatsCellDetail = Readonly<{
  key: string
  content: string
}>

function statsCellKey(metric: StatsDetailMetric, bucket: QueueStatsBucket): string {
  return `${metric}\0${bucket.key}`
}

function countCell(bucket: QueueStatsBucket, value: number): string {
  return bucket.covered ? String(value) : "—"
}

function scalarMetric(value: number | null): string {
  if (value === null) return "—"
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "")
}

function durationMetric(value: number | null, approximate = false): string {
  if (value === null) return "—"
  return `${approximate ? "~" : ""}${timelineMetric(value)}`
}

function hourDurationMetric(value: number, approximate: boolean): string {
  const prefix = approximate ? "~" : ""
  const exact = `${prefix}${timelineMetric(value)}`
  if (exact.length <= 4) return exact
  if (value < 60_000) return `${prefix}${Math.max(1, Math.round(value / 1_000))}s`
  const minutes = Math.max(1, Math.round(value / 60_000))
  if (minutes < 100) return `${prefix}${minutes}m`
  const hours = Math.max(1, Math.round(value / (60 * 60_000)))
  if (hours < 100) return `${prefix}${hours}h`
  return `${prefix}${Math.max(1, Math.round(value / (24 * 60 * 60_000)))}d`
}

function averageDurationCell(
  bucket: QueueStatsBucket,
  distribution: QueueStatsDurationDistribution,
  approximate = false,
): string {
  if (!bucket.covered || distribution.avgMs === null) return "—"
  return bucket.kind === "hour"
    ? hourDurationMetric(distribution.avgMs, approximate)
    : durationMetric(distribution.avgMs, approximate)
}

function averageRetryCell(bucket: QueueStatsBucket): string {
  return bucket.covered ? scalarMetric(bucket.retries.avg) : "—"
}

function distributionDetail(
  label: string,
  bucket: QueueStatsBucket,
  distribution: QueueStatsDurationDistribution,
  approximate = false,
): string {
  if (!bucket.covered) return `${label} · ${bucket.label} · — · journal does not cover the full bucket`
  if (distribution.n === 0) return `${label} · ${bucket.label} · — · no settled samples`
  const note = approximate ? " · approximate: first submit→merge where draft registration is absent" : ""
  return `${label} · ${bucket.label} · avg ${durationMetric(distribution.avgMs, approximate)} · p50 ${durationMetric(distribution.p50Ms, approximate)} · p95 ${durationMetric(distribution.p95Ms, approximate)}${note}`
}

function failureDetail(bucket: QueueStatsBucket): string {
  if (!bucket.covered) return `FAILS · ${bucket.label} · — · journal does not cover the full bucket`
  const breakdown = FAILURE_BREAKDOWN_CLASSES.map(
    (failureClass) => `${failureClass} ${bucket.runs.failureBreakdown[failureClass]}`,
  ).join(" · ")
  return `FAILS · ${bucket.label} · ${breakdown}`
}

function retryDetail(bucket: QueueStatsBucket): string {
  if (!bucket.covered) return `RETRIES/RUN · ${bucket.label} · — · journal does not cover the full bucket`
  if (bucket.retries.n === 0) return `RETRIES/RUN · ${bucket.label} · — · no settled PR samples`
  return `RETRIES/RUN · ${bucket.label} · avg ${scalarMetric(bucket.retries.avg)} · p50 ${scalarMetric(bucket.retries.p50)} · p95 ${scalarMetric(bucket.retries.p95)} · revisions−1 + failed attempts`
}

function detailFor(metric: StatsDetailMetric, bucket: QueueStatsBucket): StatsCellDetail {
  const key = statsCellKey(metric, bucket)
  if (metric === "fails") return { key, content: failureDetail(bucket) }
  if (metric === "retries") return { key, content: retryDetail(bucket) }
  if (metric === "total") {
    return { key, content: distributionDetail("TOTAL", bucket, bucket.total, bucket.total.approximate) }
  }
  if (metric === "queueWait") {
    return { key, content: distributionDetail("QUEUING", bucket, bucket.queueWait) }
  }
  return { key, content: distributionDetail("RUNNING", bucket, bucket.jobRun) }
}

function bucketWidth(bucket: QueueStatsBucket): number {
  return bucket.kind === "hour" ? 4 : Math.max(7, bucket.label.length)
}

/**
 * One hour bucket's day-boundary marker, its own one-character column
 * (operator ruling 2026-08-18) rather than a glyph fused onto the hour label.
 * Rendered by every hour-bearing row — the header and each STATS_ROWS row —
 * keyed identically off `bucket.dayBoundary`, so the `│` lands at the same
 * screen column on every row and reads as one vertical rule through the box.
 * Present only where a boundary actually falls: an always-present empty
 * column would cost two characters (width + gap) per hour, every hour, for a
 * marker that fires at most once or twice across the visible window.
 */
function DayBoundaryMarker({ bucket }: Readonly<{ bucket: QueueStatsBucket }>) {
  if (!bucket.dayBoundary) return null
  return (
    <Box width={1} flexShrink={0}>
      <Text color="$fg-muted">│</Text>
    </Box>
  )
}

function StatsValueCell({
  bucket,
  value,
  color,
  detail,
  hoveredKey,
  activeKey,
  onHover,
  onSelect,
}: Readonly<{
  bucket: QueueStatsBucket
  value: string
  color?: string
  detail?: StatsCellDetail
  hoveredKey: string | null
  activeKey: string | null
  onHover: (key: string | null) => void
  onSelect: (key: string) => void
}>) {
  const interactive = detail !== undefined
  return (
    <Box
      width={bucketWidth(bucket)}
      minWidth={0}
      flexShrink={0}
      // A Box defaults to row layout, whose cross axis is vertical — so
      // `alignItems` (the property this cell used until 2026-08-18) never
      // touched horizontal position and every number rendered flush LEFT.
      // `justifyContent` is the row's main-axis property; `flex-end` is what
      // actually right-aligns the value against the cell's right edge.
      justifyContent="flex-end"
      {...(interactive
        ? {
            mouseCursor: "pointer" as const,
            onMouseEnter: () => onHover(detail.key),
            onMouseLeave: () => onHover(null),
            onClick: () => onSelect(detail.key),
          }
        : {})}
    >
      <Text
        color={color}
        inverse={interactive && (hoveredKey === detail.key || activeKey === detail.key)}
        wrap="truncate"
      >
        {value}
      </Text>
    </Box>
  )
}

function StatsRowFocusBridge({
  metric,
  onFocused,
}: Readonly<{
  metric: StatsDetailMetric
  onFocused: (metric: StatsDetailMetric, focused: boolean) => void
}>) {
  const { focused } = useFocusable()
  useEffect(() => {
    onFocused(metric, focused)
  }, [focused, metric, onFocused])
  return null
}

type StatsRow = Readonly<{
  label: string
  heading?: boolean
  color?: string
  metric?: StatsDetailMetric
  value: (bucket: QueueStatsBucket) => string
}>

const STATS_ROWS: readonly StatsRow[] = [
  { label: "ALL", value: (bucket) => countCell(bucket, bucket.runs.all) },
  {
    label: "MERGED",
    color: "$fg-success",
    value: (bucket) => countCell(bucket, bucket.runs.integrated),
  },
  {
    // Non-landing success (admission-only). Not a fail, not integrated (21801).
    label: "PASS",
    color: "$fg-success",
    value: (bucket) => countCell(bucket, bucket.runs.passed),
  },
  {
    // Muted, not green (operator ruling 2026-08-18): a duplicate merge is not
    // a fresh success the way MERGED/PASS are, so it does not earn the same
    // success color. Ordered directly above FAILS — the two rows a landing
    // could have gone to instead of a clean MERGED.
    label: "DUP",
    color: "$fg-muted",
    value: (bucket) => countCell(bucket, bucket.runs.alreadyLanded),
  },
  {
    label: "FAILS",
    color: "$fg-error",
    metric: "fails",
    value: (bucket) => countCell(bucket, bucket.runs.fails),
  },
  { label: "AVG TIME", heading: true, value: () => "" },
  {
    label: "TOTAL",
    metric: "total",
    value: (bucket) => averageDurationCell(bucket, bucket.total, bucket.total.approximate),
  },
  {
    label: "QUEUING",
    metric: "queueWait",
    value: (bucket) => averageDurationCell(bucket, bucket.queueWait),
  },
  {
    label: "RUNNING",
    metric: "jobRun",
    value: (bucket) => averageDurationCell(bucket, bucket.jobRun),
  },
  { label: "RETRIES/RUN", metric: "retries", value: averageRetryCell },
]

/**
 * Journal-derived queue statistics. Local-hour density responds to width; the
 * four durable calendar periods and every metric row remain fixed. One shared
 * Tooltip carries hover and keyboard-focus detail for failure partitions,
 * distributions, and retry semantics.
 */
export function QueueStatsPanel({
  facts,
  now,
  earliestFactMs,
  width,
}: Readonly<{
  facts: readonly QueueTerminalFact[]
  now: string
  earliestFactMs: number | null
  width: number
}>) {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`yrd: invalid queue-stats snapshot '${now}'`)
  const buckets = queueStats(facts, nowMs, earliestFactMs, queueStatsHourCount(width))
  const hourBuckets = buckets.filter((bucket) => bucket.kind === "hour")
  const periodBuckets = buckets.filter((bucket) => bucket.kind === "period")
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [focusedMetric, setFocusedMetric] = useState<StatsDetailMetric | null>(null)
  const today = buckets.find((bucket) => bucket.key === "today") ?? buckets[0]
  const [keyboardBucketKey, setKeyboardBucketKey] = useState(today?.key ?? "")
  const updateFocusedMetric = useCallback((metric: StatsDetailMetric, focused: boolean) => {
    setFocusedMetric((current) => (focused ? metric : current === metric ? null : current))
  }, [])
  const selectedBucket = buckets.find((bucket) => bucket.key === keyboardBucketKey) ?? today
  const focusedKey =
    focusedMetric === null || selectedBucket === undefined ? null : statsCellKey(focusedMetric, selectedBucket)
  const activeKey = hoveredKey ?? focusedKey
  const details = new Map(
    buckets
      .flatMap((bucket) =>
        STATS_ROWS.flatMap((row) => (row.metric === undefined ? [] : [detailFor(row.metric, bucket)])),
      )
      .map((detail) => [detail.key, detail.content]),
  )
  const detail = activeKey === null ? undefined : details.get(activeKey)
  if (width < STATS_FIXED_MIN_WIDTH) return null

  return (
    <Tooltip content={detail ?? ""} show={detail !== undefined} width="100%">
      <Box marginTop={1} flexShrink={0} width="100%">
        <TitledBox title="STATS" padding={0}>
          <Box flexDirection="column" width="100%" minWidth={0} overflow="hidden">
            <Box flexDirection="row" gap={1} minWidth={0}>
              <Box width={STATS_ROW_LABEL_WIDTH} flexShrink={0}>
                <Text bold>RUNS</Text>
              </Box>
              {hourBuckets.length === 0 ? null : (
                <Box flexDirection="row" gap={1} minWidth={0} flexGrow={1} flexShrink={1} overflow="hidden">
                  {hourBuckets.flatMap((bucket) => [
                    <DayBoundaryMarker key={`${bucket.key}:boundary`} bucket={bucket} />,
                    <Box
                      key={bucket.key}
                      width={bucketWidth(bucket)}
                      minWidth={0}
                      flexShrink={0}
                      justifyContent="flex-end"
                    >
                      <Text color="$fg-muted" bold wrap="truncate">
                        {bucket.label}
                      </Text>
                    </Box>,
                  ])}
                  <Text color="$fg-muted" bold flexShrink={0}>
                    …
                  </Text>
                </Box>
              )}
              <Box flexDirection="row" gap={1} flexShrink={0}>
                {periodBuckets.map((bucket) => (
                  <Box key={bucket.key} width={bucketWidth(bucket)} minWidth={0} flexShrink={0} justifyContent="flex-end">
                    <Text color="$fg-muted" bold wrap="truncate">
                      {bucket.label}
                    </Text>
                  </Box>
                ))}
              </Box>
            </Box>
            {STATS_ROWS.map((row) => (
              <Box
                key={row.label}
                flexDirection="row"
                gap={1}
                minWidth={0}
                {...(row.metric === undefined
                  ? {}
                  : {
                      focusable: true,
                      testID: `queue-stats-row-${row.metric}`,
                      onKeyDown: (event: {
                        nativeEvent: { key: { leftArrow: boolean; rightArrow: boolean } }
                        preventDefault: () => void
                        stopPropagation: () => void
                      }) => {
                        const direction = event.nativeEvent.key.leftArrow
                          ? -1
                          : event.nativeEvent.key.rightArrow
                            ? 1
                            : 0
                        if (direction === 0 || selectedBucket === undefined) return
                        const index = buckets.findIndex((bucket) => bucket.key === selectedBucket.key)
                        const next = buckets[Math.max(0, Math.min(buckets.length - 1, index + direction))]
                        if (next === undefined) return
                        setKeyboardBucketKey(next.key)
                        event.preventDefault()
                        event.stopPropagation()
                      },
                    })}
              >
                {row.metric === undefined ? null : (
                  <StatsRowFocusBridge metric={row.metric} onFocused={updateFocusedMetric} />
                )}
                <Box width={STATS_ROW_LABEL_WIDTH} flexShrink={0} minWidth={0}>
                  <Text bold={row.heading} color={row.heading ? undefined : "$fg-muted"} wrap="truncate">
                    {row.heading || row.label.length > STATS_ROW_LABEL_WIDTH - 2 ? row.label : `  ${row.label}`}
                  </Text>
                </Box>
                {hourBuckets.length === 0 ? null : (
                  <Box flexDirection="row" gap={1} minWidth={0} flexGrow={1} flexShrink={1} overflow="hidden">
                    {hourBuckets.flatMap((bucket) => [
                      <DayBoundaryMarker key={`${bucket.key}:boundary`} bucket={bucket} />,
                      <StatsValueCell
                        key={bucket.key}
                        bucket={bucket}
                        value={row.value(bucket)}
                        color={row.color}
                        {...(row.metric === undefined ? {} : { detail: detailFor(row.metric, bucket) })}
                        hoveredKey={hoveredKey}
                        activeKey={activeKey}
                        onHover={setHoveredKey}
                        onSelect={(key) => {
                          const selected = buckets.find((candidate) => key.endsWith(`\0${candidate.key}`))
                          if (selected !== undefined) setKeyboardBucketKey(selected.key)
                        }}
                      />,
                    ])}
                    <Text color="$fg-muted" flexShrink={0}>
                      ·
                    </Text>
                  </Box>
                )}
                <Box flexDirection="row" gap={1} flexShrink={0}>
                  {periodBuckets.map((bucket) => (
                    <StatsValueCell
                      key={bucket.key}
                      bucket={bucket}
                      value={row.value(bucket)}
                      color={row.color}
                      {...(row.metric === undefined ? {} : { detail: detailFor(row.metric, bucket) })}
                      hoveredKey={hoveredKey}
                      activeKey={activeKey}
                      onHover={setHoveredKey}
                      onSelect={(key) => {
                        const selected = buckets.find((candidate) => key.endsWith(`\0${candidate.key}`))
                        if (selected !== undefined) setKeyboardBucketKey(selected.key)
                      }}
                    />
                  ))}
                </Box>
              </Box>
            ))}
          </Box>
        </TitledBox>
      </Box>
    </Tooltip>
  )
}
