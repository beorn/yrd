/**
 * The resident's own no-progress clock (@i/10-yrd/liveness-is-health).
 *
 * `queue-liveness-wedged` asks "is the queue draining". Measured from the
 * JOURNAL alone it answers a different question — "has this queue merged
 * lately" — and bills a fresh process for its predecessor's silence: on
 * 2026-09-02 a resident booted into a queue whose last merge was 1h25m old
 * emitted the finding as an ERROR row before attempting a single member, and
 * "any ERROR ends the pass" (operator ruling 2026-09-01) exited it 17. The
 * runner died of an observation about the hours before it started.
 *
 * Two corrections, both here, so no reader has to reconstruct them from the
 * arithmetic at the call site:
 *
 * 1. START AT THIS RUNNER'S FIRST TICK. Before its epoch there is nothing this
 *    process could have merged, so there is nothing it can be said to have
 *    stopped merging.
 *
 * 2. PAUSE INSIDE AN ATTEMPT. A queue running a 90-minute affected-tests turn
 *    is draining as hard as it can; counting that wall time as no-progress
 *    makes the alarm fire loudest exactly when the runner is working hardest.
 *    Attempt time is ADDED to the epoch rather than resetting it, which is the
 *    difference between "paused" and "cleared": a queue that attempts and
 *    fails every five minutes forever still accumulates blocked time between
 *    attempts and still pages. Resetting would have made an endlessly retrying
 *    wedge — the exact specimen the finding exists for — permanently silent.
 *
 * Process-scoped, like every other `followQueueRuns` observation window: it is
 * a claim about THIS process, and a fresh one starts its own clock.
 */
export type ResidentLivenessClock = Readonly<{
  /**
   * The instant the liveness finding may measure "no merge" from: this
   * runner's first tick, pushed forward by every millisecond it has spent
   * inside an attempt. Handed to the audit as `livenessEpoch`.
   */
  epoch(): string
  /**
   * True while an attempt is in flight. The clock is stopped, so no liveness
   * observation taken right now is meaningful — the caller reports nothing
   * rather than reporting a stale reading.
   */
  paused(): boolean
  /** An attempt is starting: stop the clock. */
  attemptStarted(nowMs: number): void
  /**
   * The attempt ended: add the time it took to the epoch and start again.
   * Idempotent against an end with no matching start, so an early return or a
   * throw on the attempt path cannot leave the clock stopped forever — a
   * permanently paused clock is a permanently silent alarm.
   */
  attemptEnded(nowMs: number): void
}>

/**
 * How many times each wedge condition has been announced, by reporter key.
 *
 * Process-scoped and caller-owned, the same shape as the resident loop's own
 * `remedied` and `observation` windows: it is a claim about what THIS process
 * has said out loud, and a fresh runner announces from one again. Kept beside
 * the reporter rather than inside it because the reporter deliberately knows
 * nothing about what a key means.
 */
export type WedgeGenerations = Map<string, number>

/** What one wedge page carries: the condition, and which notice this is. */
export type ResidentWedgePage = Readonly<{
  base: string
  message: string
  pr?: string
  blockedMs?: number
  generation: number
}>

/**
 * The resident's half of the liveness tick: its own clock, its announcement
 * counters, and where a page goes. Every field is optional and absent means
 * the pre-2026-09-02 behaviour — a `--once` pass, a programmatic caller and
 * every existing test read the queue's history and page nobody.
 */
export type ResidentLivenessOptions = Readonly<{
  clock?: ResidentLivenessClock
  generations?: WedgeGenerations
  /** Deliver one page. Awaited: a page nobody waited for is a rejection nobody
   * sees, and this rail exists because a health signal went missing. */
  page?: (page: ResidentWedgePage) => Promise<void>
}>

export function createResidentLivenessClock(firstTickMs: number): ResidentLivenessClock {
  const startedAtMs = firstTickMs
  let insideAttemptSinceMs: number | undefined
  let attemptedMs = 0
  return Object.freeze({
    epoch: () => new Date(startedAtMs + attemptedMs).toISOString(),
    paused: () => insideAttemptSinceMs !== undefined,
    attemptStarted: (nowMs) => {
      // Already inside one: keep the OUTER start, so nesting cannot lose time.
      insideAttemptSinceMs ??= nowMs
    },
    attemptEnded: (nowMs) => {
      if (insideAttemptSinceMs === undefined) return
      // A clock that ran backwards (an `io.now` fixture, an NTP step) must not
      // subtract from the pause total and make the epoch older than it was.
      attemptedMs += Math.max(0, nowMs - insideAttemptSinceMs)
      insideAttemptSinceMs = undefined
    },
  })
}
