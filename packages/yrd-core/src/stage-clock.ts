/**
 * Per-stage SELF-time accounting for one command invocation.
 *
 * WHY NOT JUST SPANS AS EMITTED. Spans nest, so their durations overlap and
 * cannot be added up — a reader cannot tell from a pile of spans which stage
 * owns the wall clock. Worse, a partial set of spans reads as coverage: before
 * this existed, `queue ls` carried exactly one instrumented window (the
 * checkpoint restore, `totalMs` ~135ms) over a command that cost ~7400ms, so
 * the numbers on screen described 2% of the command and implied they described
 * all of it.
 *
 * WHERE THE ROWS COME FROM. Every loggily span on the host logger opens a stage
 * here, because `withStageAccounting` binds the two at the span's constructor —
 * see `stage-spans.ts`. So the table is derived from the spans rather than kept
 * beside them, and a span added tomorrow cannot fall out of the accounting.
 * `stage()`/`stageAsync()` remain for timed regions that are not spans.
 *
 * WHAT THIS DOES. Wall clock is charged to whichever stage is INNERMOST at the
 * time — the top of the stack — and the charge is taken at every open and every
 * close. Each millisecond therefore belongs to exactly one stage, or to nobody
 * when no stage is open. Self times are disjoint by construction, so the rows
 * plus an explicit `unaccountedMs` add up to the process wall clock and
 * `accountedMs` can never exceed `totalMs`. A stage table that does not sum is
 * worse than no table, and `unaccountedMs` is the row that keeps this one
 * honest: it is what nobody has measured yet.
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

type Frame = Readonly<{ name: string }>

const totals = new Map<string, number>()
const stack: Frame[] = []
let crossed = 0
/** Wall clock at the last charge boundary. Everything since belongs to whatever
 * sits on top of the stack right now. */
let mark = 0

/** Charge everything since the last boundary to the innermost open stage, then
 * move the boundary. An empty stack charges nobody, which is exactly how
 * uninstrumented time becomes `unaccountedMs` instead of landing on a
 * bystander. */
function chargeInnermost(now: number): void {
  const top = stack.at(-1)
  if (top !== undefined) totals.set(top.name, (totals.get(top.name) ?? 0) + (now - mark))
  mark = now
}

function push(name: string): Frame {
  chargeInnermost(performance.now())
  const frame: Frame = { name }
  stack.push(frame)
  return frame
}

/** Close a frame wherever it sits.
 *
 * Stages nest on the synchronous paths this measures, but async ones CAN cross:
 * `yrd watch` can have a deferred history scan in flight while a render starts,
 * and the queue runs Git subprocesses concurrently. When that happens the
 * elapsed windows overlap, and wall clock cannot be given to both — charging
 * the innermost stage is what keeps the rows disjoint. The split between two
 * crossing stages is then approximate rather than wrong-by-double-counting.
 *
 * This does NOT throw. An instrument that can take down `yrd watch` is worse
 * than an approximate number — the command is the product, the measurement is
 * not. Loud without being fatal: every crossing increments a counter that the
 * report carries, so a reader sees `crossedStages > 0` and knows the split is
 * approximate rather than trusting it silently. */
function close(frame: Frame): void {
  const now = performance.now()
  const index = stack.lastIndexOf(frame)
  if (index === -1) {
    crossed += 1
    return
  }
  // Charge BEFORE removing, so the time that just elapsed goes to whoever was
  // actually innermost — the closing frame when it nested cleanly, the frame
  // above it when the two crossed.
  chargeInnermost(now)
  if (index !== stack.length - 1) crossed += 1
  stack.splice(index, 1)
}

/** A stage opened by hand, closed by its owner. `close()` is idempotent so a
 * span that is both `end()`ed and disposed charges its time once. */
export type StageHandle = Readonly<{ close: () => void }>

/** Open a stage that a caller closes explicitly. Prefer {@link stage} or
 * {@link stageAsync} when the region is a function call; this exists for
 * lifetimes that are opened and closed by separate events, which is how a
 * loggily span is shaped. */
export function openStage(name: string): StageHandle {
  const frame = push(name)
  let closed = false
  return Object.freeze({
    close(): void {
      if (closed) return
      closed = true
      close(frame)
    },
  })
}

/** Account `run()` to `name`. Rethrows unchanged — a stage that throws still
 * owns the time it burned before throwing. */
export function stage<Value>(name: string, run: () => Value): Value {
  const frame = push(name)
  try {
    return run()
  } finally {
    close(frame)
  }
}

/** Async form. Overlapping another stage is tolerated but counted; see close(). */
export async function stageAsync<Value>(name: string, run: () => Promise<Value>): Promise<Value> {
  const frame = push(name)
  try {
    return await run()
  } finally {
    close(frame)
  }
}

export type StageReport = Readonly<{
  /** Self ms per stage, largest first. */
  stages: Readonly<Record<string, number>>
  /** Sum of the stage rows. Never exceeds `totalMs`: the rows are disjoint. */
  accountedMs: number
  /** Process wall clock, including runtime startup and module load. */
  totalMs: number
  /** totalMs - accountedMs: the part still nobody has instrumented. */
  unaccountedMs: number
  /** Stage lifetimes that crossed instead of nesting. Zero means the per-stage
   * split is exact; above zero it is approximate, and the reader is told so
   * rather than left to assume precision the numbers do not have. */
  crossedStages: number
}>

export function stageReport(): StageReport {
  const totalMs = performance.now()
  // Stages still open have burned time nobody has charged yet. Charge it now,
  // or a report taken mid-flight understates every enclosing stage and inflates
  // `unaccountedMs` with time that IS being measured.
  chargeInnermost(totalMs)
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
    crossedStages: crossed,
  })
}

/** Tests only: one process is otherwise one command. */
export function resetStageClock(): void {
  totals.clear()
  stack.length = 0
  crossed = 0
  mark = 0
}
