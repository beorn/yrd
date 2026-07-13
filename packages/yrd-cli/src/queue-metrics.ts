const QUEUE_METRICS_WINDOW_MS = 24 * 60 * 60 * 1_000

type QueueTerminalRow = Readonly<{
  finishedAt?: string
  outcome: string
  ageMs?: number
}>

export type QueueTerminalFact = Readonly<{
  terminalAtMs: number
  outcome: "integrated" | "rejected"
  ageMs: number | null
}>

export type QueueMetrics = Readonly<{
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

export type QueueMetricsProjection = Readonly<{ metrics: QueueMetrics }>

export function queueTerminalFact(row: QueueTerminalRow): QueueTerminalFact {
  if (row.outcome !== "integrated" && row.outcome !== "rejected") {
    throw new TypeError(`yrd: queue metrics row has non-terminal outcome '${row.outcome}'`)
  }
  if (row.finishedAt === undefined) throw new TypeError("yrd: queue metrics row has no terminal timestamp")
  const terminalAtMs = Date.parse(row.finishedAt)
  if (!Number.isFinite(terminalAtMs)) throw new TypeError("yrd: queue metrics row has an invalid terminal timestamp")
  const ageMs = row.ageMs ?? null
  if (ageMs !== null && !Number.isFinite(ageMs)) throw new TypeError("yrd: queue metrics row has an invalid queue age")
  if (ageMs !== null && ageMs < 0) throw new RangeError("yrd: queue metrics row has a negative queue age")
  return { terminalAtMs, outcome: row.outcome, ageMs }
}

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

export function queueTerminalFacts(rows: Iterable<QueueTerminalRow>): QueueTerminalFact[] {
  return Array.from(rows, queueTerminalFact)
}

export function queueMetrics(facts: Iterable<QueueTerminalFact>, now: number): QueueMetrics {
  const ages: number[] = []
  let landed = 0
  let rejected = 0
  for (const fact of facts) {
    if (fact.terminalAtMs < now - QUEUE_METRICS_WINDOW_MS || fact.terminalAtMs > now) continue
    if (fact.outcome === "integrated") landed += 1
    else rejected += 1
    if (fact.ageMs !== null) ages.push(fact.ageMs)
  }
  ages.sort((left, right) => left - right)
  const terminal = landed + rejected
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
      terminal,
      ratio: terminal === 0 ? 0 : rejected / terminal,
    },
  }
}

export function queueMetricsProjection(facts: Iterable<QueueTerminalFact>, now: number): QueueMetricsProjection {
  return { metrics: queueMetrics(facts, now) }
}
