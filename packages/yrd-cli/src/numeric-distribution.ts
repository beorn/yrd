export type NumericDistribution = Readonly<{
  n: number
  min: number | null
  avg: number | null
  p50: number | null
  p90: number | null
  p95: number | null
  max: number | null
}>

export function finiteNonnegative(value: number, subject: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`yrd: ${subject} must be finite`)
  if (value < 0) throw new RangeError(`yrd: ${subject} must not be negative`)
  return value
}

function arithmeticMedian(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null
  const upperIndex = Math.floor(sorted.length / 2)
  const upper = sorted[upperIndex]
  if (upper === undefined) return null
  if (sorted.length % 2 === 1) return upper
  const lower = sorted[upperIndex - 1]
  return lower === undefined ? null : (lower + upper) / 2
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null
}

/** One unit-neutral, fail-loud distribution primitive for queue projections. */
export function numericDistribution(values: readonly number[], subject: string): NumericDistribution {
  const sorted = values.map((value) => finiteNonnegative(value, subject)).toSorted((left, right) => left - right)
  const n = sorted.length
  if (n === 0) return { n, min: null, avg: null, p50: null, p90: null, p95: null, max: null }
  return {
    n,
    min: sorted[0] ?? null,
    avg: sorted.reduce((sum, value) => sum + value, 0) / n,
    p50: arithmeticMedian(sorted),
    p90: nearestRank(sorted, 0.9),
    p95: nearestRank(sorted, 0.95),
    max: sorted[n - 1] ?? null,
  }
}
