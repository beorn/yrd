/**
 * What a queue pass does when someone stops it.
 *
 * A pass is a WRITER: it holds the queue runner lease, it has a run in flight,
 * and the journal records that run as `in_progress` until something says
 * otherwise. Dying on the default signal disposition says nothing — the lease
 * comes off (it is a real flock, so the kernel does that), but the run stays
 * `in_progress` forever and the next pass finds a row it must recover before it
 * can do anything else.
 *
 * Three deaths on 2026-09-01, all of a one-shot `yrd queue run`, all leaving a
 * job unfinished: a peer's SIGTERM, an account rotation that took the parent
 * shell, and a stopped agent loop. `setsid` does not help with the third — a
 * kill that walks the process tree reaches a child whatever its session is —
 * which is the tell that the cure is not process placement but the pass
 * answering the signal itself.
 *
 * So a pass drains: it stops admitting, lets the job in flight end, settles
 * that job to a terminal state with a coded reason, releases the lease, and
 * exits with a code that says "stopped on purpose". A second signal is the
 * hard stop, unchanged.
 *
 * The seam is `YrdCliIO.drainSignal`, which the resident habitant has always
 * had; this module holds the parts a ONE-SHOT pass needs on top of it, so both
 * `host.ts` (which mints the controller) and `run.ts` (which reads the drained
 * exit) can reach them without an import cycle between those two files.
 */
import { HABITANT_EXIT } from "./habitant-exit.ts"

export type QueuePassSignal = "SIGINT" | "SIGTERM"

/**
 * The postures whose signals mean "drain", not "die".
 *
 * `one-shot-queue-run` is the addition, and its absence was the defect: a
 * one-shot pass holds the same lease and drives the same admissions as the
 * resident, so the two postures that used to be listed here described the
 * runner we supervise rather than the writers we can interrupt. Read as a
 * predicate rather than inlined at the mint site, because "does this posture
 * answer its own signals" is a fact a test has to be able to ask.
 */
const DRAINING_POSTURES = new Set(["habitant-queue-run", "one-shot-queue-run", "bracketed-bay-open"])

export function queuePostureDrains(posture: string): boolean {
  return DRAINING_POSTURES.has(posture)
}

/**
 * How long a drain may take before it stops being a drain.
 *
 * A drain waits for work it does not control — a merge, a check, a child
 * process — so it can wait forever, and a stop that never returns is the same
 * outcome as the death it replaces plus a hung terminal. At the bound the pass
 * settles anyway and says so loudly.
 */
export const QUEUE_DRAIN_BOUND_MS = 120_000

/**
 * The reason string a drained pass writes into the journal, and the code a
 * reader keys on.
 *
 * Coded, not prose: this is the one fact that tells a later reader the run
 * ended because a person stopped the pass, rather than because the content was
 * judged. Nothing about the change was decided here — the pass never got that
 * far — so the members keep their submit facts and re-queue on the next pass.
 */
export const QUEUE_DRAIN_REASON_CODE = "queue-pass-drained"

export function queueDrainReason(signal: QueuePassSignal): string {
  return `${QUEUE_DRAIN_REASON_CODE}: queue pass drained after ${signal}; no verdict was reached`
}

/**
 * The exit code a drained pass leaves.
 *
 * Distinct from a clean pass (0), an ordinary failure (1), an unreadable state
 * (2) and a hard interrupt (3) — see `habitant-exit.ts` for why those four are
 * the generic verb alphabet and why a lifecycle condition may not borrow one.
 */
export const QUEUE_DRAIN_EXIT = HABITANT_EXIT.drained

type DrainSettleQueue = Readonly<{
  recover(
    options: Readonly<{ recoveryTime: string; runner: string; reason: string }>,
  ): Promise<readonly Readonly<{ id: string }>[]>
}>

type DrainLog = Readonly<{
  info?: (message: string, props?: Record<string, unknown>) => void
  warn?: (message: string, props?: Record<string, unknown>) => void
  error?: (message: string, props?: Record<string, unknown>) => void
}>

/**
 * A runner-scoped recovery also sweeps every unrelated lease older than its
 * cutoff, so the cutoff is the epoch and the SCOPE is what keeps this exact:
 * only this pass's own runner id is declared stopped.
 */
const DRAIN_RECOVERY_CUTOFF = "1970-01-01T00:00:00.000Z"

export type QueueDrainSettlement = Readonly<{
  /** Ids of the runs this drain moved to a terminal state. */
  runs: readonly string[]
  /** True when the bound expired before the settle answered. */
  bounded: boolean
  /** True when the settle itself failed; the lease still came off. */
  failed: boolean
}>

/**
 * Settle whatever this pass left in flight, bounded, and never throwing.
 *
 * Not throwing is deliberate and is the difference between this and the
 * unbounded call it replaces. A drain runs while the process is already on its
 * way out; a throw here would replace a recorded terminal state AND a released
 * lease with neither. Every failure mode is reported instead — loudly, with
 * what was queried and what it was scoped to — and the caller still releases
 * the lease on the path out.
 */
export async function settleDrainedQueuePass(
  queue: DrainSettleQueue,
  runner: string,
  signal: QueuePassSignal,
  log: DrainLog,
  bound?: Readonly<{ ms?: number; sleep?: (ms: number) => Promise<void> }>,
): Promise<QueueDrainSettlement> {
  const reason = queueDrainReason(signal)
  const ms = bound?.ms ?? QUEUE_DRAIN_BOUND_MS
  const sleep =
    bound?.sleep ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay).unref?.()))
  const expired = Symbol("queue-drain-bound")
  let settled: readonly Readonly<{ id: string }>[] | undefined
  try {
    const outcome = await Promise.race([
      queue.recover({ recoveryTime: DRAIN_RECOVERY_CUTOFF, runner, reason }).then((runs) => {
        settled = runs
        return runs
      }),
      sleep(ms).then(() => expired),
    ])
    if (outcome === expired) {
      // Loud, and with the scope named: a drain that gave up is a queue row
      // someone else has to settle, and saying "timed out" without saying what
      // was being settled leaves the next reader guessing which runner to look
      // for.
      log.error?.(`Gave up settling the drained queue pass after ${String(ms)}ms; exiting anyway.`, {
        action: "queue-drain-bound-expired",
        runner,
        signal,
        boundMs: ms,
        reason,
      })
      return { runs: [], bounded: true, failed: false }
    }
  } catch (error) {
    log.error?.(`Could not settle the drained queue pass after ${signal}; the next runner start reclaims its leases.`, {
      action: "queue-drain-settle-failed",
      runner,
      signal,
      reason,
      error: error instanceof Error ? error.message : String(error),
    })
    return { runs: [], bounded: false, failed: true }
  }
  const runs = (settled ?? []).map((run) => run.id)
  if (runs.length > 0) {
    log.info?.(`Stopped queue run ${runs.join(", ")} safely after ${signal}.`, {
      action: "queue-drain-settled",
      runner,
      signal,
      runs,
      reason,
    })
  }
  return { runs, bounded: false, failed: false }
}

/**
 * Close a queue pass that something stopped: settle first, release second,
 * always release.
 *
 * The order is the invariant. Releasing the lease first would let the next pass
 * start against a queue this one is still writing to; settling without
 * releasing would leave the next pass unable to start at all. And `stopped`
 * covers BOTH stops — a hard signal, which arrives as an argument, and a drain,
 * which does not: a drained pass runs to its own end and reaches this from the
 * boundary's `finally` with nothing in hand. Reading only the argument is
 * exactly what left drained passes unsettled.
 */
export async function closeDrainedQueuePass(
  deps: Readonly<{
    stopped?: QueuePassSignal
    settle: (signal: QueuePassSignal) => Promise<void>
    close: () => Promise<void>
  }>,
): Promise<void> {
  try {
    if (deps.stopped !== undefined) await deps.settle(deps.stopped)
  } finally {
    await deps.close()
  }
}

/**
 * The exit code a queue pass leaves, given what stopped it.
 *
 * One function so the three answers cannot drift: a pass nobody stopped keeps
 * whatever its work decided; a pass a HARD signal cut short keeps `interrupted`
 * (3), which every non-habitant caller already reads as "stopped with work
 * outstanding"; a pass that drained on purpose gets its own code, because a
 * supervisor that cannot tell a deliberate stop from a failure restarts it.
 */
export function drainedQueuePassExit<T extends number>(
  passExit: T,
  stopped: Readonly<{ drained?: QueuePassSignal; hard?: QueuePassSignal }>,
): T | typeof QUEUE_DRAIN_EXIT | typeof HABITANT_EXIT.interrupted {
  if (stopped.hard !== undefined) return HABITANT_EXIT.interrupted
  if (stopped.drained !== undefined) return QUEUE_DRAIN_EXIT
  return passExit
}
