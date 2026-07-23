/** Width-adaptive, journal-derived queue statistics with shared accessible detail. */

import { useCallback, useEffect, useState } from "react"
import { Box, Text, Tooltip, useFocusable } from "silvery"
import { type QueueTerminalFact, TitledBox, timelineMetric } from "./queue-status-view.tsx"
import { FAILURE_BREAKDOWN_CLASSES } from "./status-presentation.ts"
import { type QueueStatsBucket, type QueueStatsDistribution, queueStats } from "./time-stats.ts"

const STATS_ROW_LABEL_WIDTH = 10
const STATS_FIXED_MIN_WIDTH = 49
const STATS_HOUR_STRIDE = 4
const STATS_MAX_HOURS = 24

/**
 * The four calendar columns always remain present. Remaining horizontal space
 * becomes newest-first local hour columns, capped at one day so repeated clock
 * labels never become ambiguous.
 */
export function queueStatsHourCount(width: number): number {
  if (!Number.isFinite(width)) throw new TypeError("yrd: queue-stats width must be finite")
  return Math.min(
    STATS_MAX_HOURS,
    Math.max(0, Math.floor((Math.trunc(width) - STATS_FIXED_MIN_WIDTH) / STATS_HOUR_STRIDE)),
  )
}

type StatsDetailMetric = "fails" | "total" | "coding" | "queueWait" | "jobRun" | "retries"

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

function averageDurationCell(
  bucket: QueueStatsBucket,
  distribution: QueueStatsDistribution,
  approximate = false,
): string {
  return bucket.covered ? durationMetric(distribution.avgMs, approximate) : "—"
}

function averageRetryCell(bucket: QueueStatsBucket): string {
  return bucket.covered ? scalarMetric(bucket.retries.avgMs) : "—"
}

function distributionDetail(
  label: string,
  bucket: QueueStatsBucket,
  distribution: QueueStatsDistribution,
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

function codingDetail(bucket: QueueStatsBucket): string {
  if (!bucket.covered) return `CODING · ${bucket.label} · — · journal does not cover the full bucket`
  return `CODING · ${bucket.label} · — · unavailable until the draft/claim journal model (21707)`
}

function retryDetail(bucket: QueueStatsBucket): string {
  if (!bucket.covered) return `RETRIES · ${bucket.label} · — · journal does not cover the full bucket`
  if (bucket.retries.n === 0) return `RETRIES · ${bucket.label} · — · no settled PR samples`
  return `RETRIES · ${bucket.label} · avg ${scalarMetric(bucket.retries.avgMs)} · p50 ${scalarMetric(bucket.retries.p50Ms)} · p95 ${scalarMetric(bucket.retries.p95Ms)} · revisions−1 + failed attempts`
}

function detailFor(metric: StatsDetailMetric, bucket: QueueStatsBucket): StatsCellDetail {
  const key = statsCellKey(metric, bucket)
  if (metric === "fails") return { key, content: failureDetail(bucket) }
  if (metric === "coding") return { key, content: codingDetail(bucket) }
  if (metric === "retries") return { key, content: retryDetail(bucket) }
  if (metric === "total") {
    return { key, content: distributionDetail("TOTAL", bucket, bucket.total, bucket.total.approximate) }
  }
  if (metric === "queueWait") {
    return { key, content: distributionDetail("QUEUE WAIT", bucket, bucket.queueWait) }
  }
  return { key, content: distributionDetail("JOB RUN", bucket, bucket.jobRun) }
}

function bucketWidth(bucket: QueueStatsBucket): number {
  return bucket.kind === "hour" ? 3 : bucket.label.length
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
      alignItems="flex-end"
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
  { label: "RUNS", heading: true, value: () => "" },
  { label: "ALL", value: (bucket) => countCell(bucket, bucket.runs.all) },
  {
    label: "INTEGRATED",
    color: "$fg-success",
    value: (bucket) => countCell(bucket, bucket.runs.integrated),
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
  { label: "CODING", metric: "coding", value: () => "—" },
  {
    label: "QUEUE WAIT",
    metric: "queueWait",
    value: (bucket) => averageDurationCell(bucket, bucket.queueWait),
  },
  {
    label: "JOB RUN",
    metric: "jobRun",
    value: (bucket) => averageDurationCell(bucket, bucket.jobRun),
  },
  { label: "RETRIES", metric: "retries", value: averageRetryCell },
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
  earliestEventMs,
  width,
}: Readonly<{
  facts: readonly QueueTerminalFact[]
  now: string
  earliestEventMs: number | null
  width: number
}>) {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`yrd: invalid queue-stats snapshot '${now}'`)
  const buckets = queueStats(facts, nowMs, earliestEventMs, queueStatsHourCount(width))
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
        (["fails", "total", "coding", "queueWait", "jobRun", "retries"] as const).map((metric) =>
          detailFor(metric, bucket),
        ),
      )
      .map((detail) => [detail.key, detail.content]),
  )
  const detail = activeKey === null ? undefined : details.get(activeKey)

  return (
    <Tooltip content={detail ?? ""} show={detail !== undefined} width="100%">
      <Box marginTop={1} flexShrink={0} width="100%">
        <TitledBox title="STATS" padding={0}>
          <Box flexDirection="column" width="100%" minWidth={0}>
            <Box flexDirection="row" gap={1} minWidth={0}>
              <Box width={STATS_ROW_LABEL_WIDTH} flexShrink={0} />
              {buckets.map((bucket) => (
                <Box key={bucket.key} width={bucketWidth(bucket)} minWidth={0} flexShrink={0} alignItems="flex-end">
                  <Text color="$fg-muted" bold wrap="truncate">
                    {bucket.label}
                  </Text>
                </Box>
              ))}
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
                {buckets.map((bucket) => (
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
            ))}
          </Box>
        </TitledBox>
      </Box>
    </Tooltip>
  )
}
