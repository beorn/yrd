export type QueueTerminalOutcome = "integrated" | "rejected" | "environment-refused" | "canceled"

export type QueueTerminalFact = Readonly<{
  run: string
  terminalAtMs: number
  outcome: QueueTerminalOutcome
  activeMs: number | null
  queueWaitMs: readonly number[]
}>

export type DurationDistribution = Readonly<{
  n: number
  minMs: number | null
  avgMs: number | null
  p50Ms: number | null
  p90Ms: number | null
  maxMs: number | null
}>

export type QueueWaitDistribution = Readonly<{
  n: number
  avgMs: number | null
  p50Ms: number | null
  p90Ms: number | null
  maxMs: number | null
}>

export type QueueFlowMetrics = Readonly<{
  windowMs: number
  terminalAttempts: number
  outcomes: Readonly<{
    integrated: number
    rejected: number
    environmentRefused: number
    canceled: number
  }>
  decisionRejection: Readonly<{
    rejected: number
    decisions: number
    rate: number | null
  }>
  activeRun: Readonly<{
    allTerminal: DurationDistribution
    integratedOnly: DurationDistribution
  }>
  queueWait: QueueWaitDistribution
}>

function finiteNonnegative(value: number, subject: string): number {
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

function durationDistribution(values: readonly number[]): DurationDistribution {
  const sorted = values.toSorted((left, right) => left - right)
  const n = sorted.length
  if (n === 0) return { n, minMs: null, avgMs: null, p50Ms: null, p90Ms: null, maxMs: null }
  return {
    n,
    minMs: sorted[0] ?? null,
    avgMs: sorted.reduce((sum, value) => sum + value, 0) / n,
    p50Ms: arithmeticMedian(sorted),
    p90Ms: nearestRank(sorted, 0.9),
    maxMs: sorted[n - 1] ?? null,
  }
}

function waitDistribution(values: readonly number[]): QueueWaitDistribution {
  const { n, avgMs, p50Ms, p90Ms, maxMs } = durationDistribution(values)
  return { n, avgMs, p50Ms, p90Ms, maxMs }
}

export function queueFlowMetrics(
  facts: Iterable<QueueTerminalFact>,
  options: Readonly<{ now: number; windowMs: number }>,
): QueueFlowMetrics {
  const now = finiteNonnegative(options.now, "FLOW snapshot time")
  const windowMs = finiteNonnegative(options.windowMs, "FLOW window")
  const earliest = now - windowMs
  const seenRuns = new Set<string>()
  const activeAll: number[] = []
  const activeIntegrated: number[] = []
  const waits: number[] = []
  let integrated = 0
  let rejected = 0
  let environmentRefused = 0
  let canceled = 0

  for (const fact of facts) {
    const terminalAtMs = finiteNonnegative(fact.terminalAtMs, `Run '${fact.run}' terminal time`)
    if (terminalAtMs < earliest || terminalAtMs > now) continue
    if (seenRuns.has(fact.run)) throw new Error(`yrd: duplicate terminal FLOW fact for Run '${fact.run}'`)
    seenRuns.add(fact.run)

    if (fact.outcome === "integrated") integrated += 1
    else if (fact.outcome === "rejected") rejected += 1
    else if (fact.outcome === "environment-refused") environmentRefused += 1
    else canceled += 1

    if (fact.activeMs !== null) {
      const activeMs = finiteNonnegative(fact.activeMs, `Run '${fact.run}' active duration`)
      activeAll.push(activeMs)
      if (fact.outcome === "integrated") activeIntegrated.push(activeMs)
    }
    for (const wait of fact.queueWaitMs) {
      waits.push(finiteNonnegative(wait, `Run '${fact.run}' queue wait`))
    }
  }

  const decisions = integrated + rejected
  return {
    windowMs,
    terminalAttempts: seenRuns.size,
    outcomes: { integrated, rejected, environmentRefused, canceled },
    decisionRejection: {
      rejected,
      decisions,
      rate: decisions === 0 ? null : rejected / decisions,
    },
    activeRun: {
      allTerminal: durationDistribution(activeAll),
      integratedOnly: durationDistribution(activeIntegrated),
    },
    queueWait: waitDistribution(waits),
  }
}
