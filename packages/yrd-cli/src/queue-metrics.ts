const QUEUE_METRICS_WINDOW_MS = 24 * 60 * 60 * 1_000

type QueueMetricRow = Readonly<{
  finishedAt?: string
  outcome: string
  ageMs?: number
}>

export type LineQueueMetrics = Readonly<{
  windowMs: number
  queueAge: Readonly<{
    samples: number
    medianMs: number | null
    p90Ms: number | null
  }>
  throughput: Readonly<{ landed: number }>
  rejectRate: Readonly<{
    rejected: number
    terminal: number
    ratio: number
  }>
}>

export type QueueMetricsProjection = Readonly<{ metrics: LineQueueMetrics }>

function arithmeticMedian(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null
  const upper = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[upper] ?? null
  const lowerValue = sorted[upper - 1]
  const upperValue = sorted[upper]
  return lowerValue === undefined || upperValue === undefined ? null : (lowerValue + upperValue) / 2
}

function p90(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)] ?? null
}

export function lineQueueMetrics(rows: Iterable<QueueMetricRow>, now: number): LineQueueMetrics {
  const terminal: QueueMetricRow[] = []
  for (const row of rows) {
    if (row.outcome !== "integrated" && row.outcome !== "rejected") continue
    const finishedAt = Date.parse(row.finishedAt ?? "")
    if (!Number.isFinite(finishedAt)) continue
    if (finishedAt < now - QUEUE_METRICS_WINDOW_MS || finishedAt > now) continue
    terminal.push(row)
  }

  const ages = terminal
    .flatMap((row) => (row.ageMs === undefined ? [] : [row.ageMs]))
    .toSorted((left, right) => left - right)
  const landed = terminal.filter((row) => row.outcome === "integrated").length
  const rejected = terminal.length - landed
  return {
    windowMs: QUEUE_METRICS_WINDOW_MS,
    queueAge: {
      samples: ages.length,
      medianMs: arithmeticMedian(ages),
      p90Ms: p90(ages),
    },
    throughput: { landed },
    rejectRate: {
      rejected,
      terminal: terminal.length,
      ratio: terminal.length === 0 ? 0 : rejected / terminal.length,
    },
  }
}

export function queueMetricsProjection(rows: Iterable<QueueMetricRow>, now: number): QueueMetricsProjection {
  return { metrics: lineQueueMetrics(rows, now) }
}
