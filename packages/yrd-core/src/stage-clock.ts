/**
 * Per-stage SELF-time accounting for one command invocation.
 *
 * WHY NOT JUST SPANS. Spans nest, so their durations overlap and cannot be
 * added up — a reader cannot tell from a pile of spans which stage owns the
 * wall clock. Worse, a partial set of spans reads as coverage: before this
 * existed, `queue ls` carried exactly one instrumented window (the checkpoint
 * restore, `totalMs` ~135ms) over a command that cost ~7400ms, so the numbers
 * on screen described 2% of the command and implied they described all of it.
 *
 * WHAT THIS DOES. Each stage records its SELF time: elapsed minus the time its
 * nested stages consumed. Self times are disjoint by construction, so the rows
 * plus an explicit `unaccountedMs` add up to the process wall clock. A stage
 * table that does not sum is worse than no table, and `unaccountedMs` is the
 * row that keeps this one honest: it is what nobody has measured yet.
 *
 * TIME BASE. `performance.now()` is milliseconds since process start, so the
 * report's `totalMs` includes runtime startup and module loading without any
 * extra bookkeeping.
 *
 * SCOPE. One process, one command. This is deliberately a module-level
 * accumulator rather than plumbing a context through every call site — the CLI
 * runs one command per process, and threading an accounting object through
 * core, queue, and view code would be a far larger change for the same numbers.
 */

type Frame = Readonly<{ name: string; started: number }> & { nestedMs: number }

const totals = new Map<string, number>()
const stack: Frame[] = []

/** Elapsed for a finished frame, folded into its own bucket as self time and
 * into its parent's nested total so the parent does not also claim it. */
function settle(frame: Frame): void {
  const elapsed = performance.now() - frame.started
  const self = elapsed - frame.nestedMs
  totals.set(frame.name, (totals.get(frame.name) ?? 0) + self)
  const parent = stack.at(-1)
  if (parent !== undefined) parent.nestedMs += elapsed
}

/** NO SILENT ERRORS: if the frame we pop is not the frame we pushed, the stack
 * discipline is broken — concurrently running stages, or a missing finally —
 * and every number after it would be quietly wrong. Fail loud instead. */
function pop(expected: Frame): void {
  const actual = stack.pop()
  if (actual !== expected) {
    throw new Error(
      `stage clock: expected to close '${expected.name}' but found '${actual?.name ?? "nothing"}'. ` +
        "Stages must nest; two stages running concurrently cannot be attributed.",
    )
  }
  settle(expected)
}

function push(name: string): Frame {
  const frame: Frame = { name, started: performance.now(), nestedMs: 0 }
  stack.push(frame)
  return frame
}

/** Account `run()` to `name`. Rethrows unchanged — a stage that throws still
 * owns the time it burned before throwing. */
export function stage<Value>(name: string, run: () => Value): Value {
  const frame = push(name)
  try {
    return run()
  } finally {
    pop(frame)
  }
}

/** Async form. The awaited work must not overlap another stage; see pop(). */
export async function stageAsync<Value>(name: string, run: () => Promise<Value>): Promise<Value> {
  const frame = push(name)
  try {
    return await run()
  } finally {
    pop(frame)
  }
}

export type StageReport = Readonly<{
  /** Self ms per stage, largest first. */
  stages: Readonly<Record<string, number>>
  /** Sum of the stage rows. */
  accountedMs: number
  /** Process wall clock, including runtime startup and module load. */
  totalMs: number
  /** totalMs - accountedMs: the part still nobody has instrumented. */
  unaccountedMs: number
}>

export function stageReport(): StageReport {
  const totalMs = performance.now()
  const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1])
  let accountedMs = 0
  const stages: Record<string, number> = {}
  for (const [name, ms] of ordered) {
    stages[name] = Math.round(ms * 100) / 100
    accountedMs += ms
  }
  return Object.freeze({
    stages: Object.freeze(stages),
    accountedMs: Math.round(accountedMs * 100) / 100,
    totalMs: Math.round(totalMs * 100) / 100,
    unaccountedMs: Math.round((totalMs - accountedMs) * 100) / 100,
  })
}

/** Tests only: one process is otherwise one command. */
export function resetStageClock(): void {
  totals.clear()
  stack.length = 0
}
