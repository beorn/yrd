/**
 * What a queue pass does when something stops it.
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
 * TWO THINGS STOP A PASS, and they share this one routine. A signal is one.
 * The pass's own ERROR row is the other (operator ruling 2026-09-01: "if the
 * queue ERRORs without quitting we should fix that — any ERROR should result
 * in it dying"): the host latches the first ERROR-level row the pass emits
 * and asks for the same drain, with a different coded reason and a different
 * exit code. One routine, because the invariant is the same either way —
 * settle first, release second, always release — and a second copy of it for
 * the error path would be the drift the first copy was written to end.
 *
 * The seam is `YrdCliIO.drainSignal`, which the resident habitant has always
 * had; this module holds the parts a ONE-SHOT pass needs on top of it, so both
 * `host.ts` (which mints the controller) and `run.ts` (which reads the drained
 * exit) can reach them without an import cycle between those two files.
 */
import { HABITANT_EXIT } from "./habitant-exit.ts"

export type QueuePassSignal = "SIGINT" | "SIGTERM"

/**
 * The pass's own ERROR row, as the cause of its stop. Carries exactly what a
 * reader needs to find the row again — the namespace that emitted it and its
 * message — and nothing a reader would have to trust: the row itself is still
 * on stderr, above the terminal line that quotes it.
 */
export type QueuePassFatal = Readonly<{ kind: "fatal-error"; namespace: string; message: string }>

/** Why a pass is stopping: a signal, or its own ERROR row. */
export type QueuePassStop = QueuePassSignal | QueuePassFatal

export function isQueuePassFatal(value: unknown): value is QueuePassFatal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "fatal-error" &&
    typeof (value as { namespace?: unknown }).namespace === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  )
}

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

/**
 * The reason code of a pass that stopped for its own ERROR row. A different
 * code from the drain's, for the reader who meets the settled run later: one
 * says a person stopped it, the other says something is wrong and the row
 * above names it. Same consequence for the members — no verdict, facts stand.
 */
export const QUEUE_FATAL_REASON_CODE = "queue-pass-errored"

/**
 * A bound on how much of the killing row rides in the journal reason. The row
 * is already on stderr in full; the reason is a pointer back to it, and a
 * multi-kilobyte message in a recovery reason is a journal row nobody reads.
 */
const FATAL_REASON_MESSAGE_LIMIT = 240

/** The ERROR row as a phrase: `an ERROR from yrd:queue:compose: <message>`. */
export function describeQueuePassFatal(fatal: QueuePassFatal): string {
  const message = fatal.message.replace(/\s+/gu, " ").trim()
  const quoted =
    message.length <= FATAL_REASON_MESSAGE_LIMIT ? message : `${message.slice(0, FATAL_REASON_MESSAGE_LIMIT - 1)}…`
  return `an ERROR from ${fatal.namespace}: ${quoted}`
}

/** The stop as a phrase: `SIGTERM`, or the ERROR row described above. */
export function describeQueuePassStop(stop: QueuePassStop): string {
  return isQueuePassFatal(stop) ? describeQueuePassFatal(stop) : stop
}

export function queueDrainReason(stop: QueuePassStop): string {
  return isQueuePassFatal(stop)
    ? `${QUEUE_FATAL_REASON_CODE}: queue pass stopped after ${describeQueuePassFatal(stop)}; no verdict was reached`
    : `${QUEUE_DRAIN_REASON_CODE}: queue pass drained after ${stop}; no verdict was reached`
}

/**
 * The exit code a drained pass leaves.
 *
 * Distinct from a clean pass (0), an ordinary failure (1), an unreadable state
 * (2) and a hard interrupt (3) — see `habitant-exit.ts` for why those four are
 * the generic verb alphabet and why a lifecycle condition may not borrow one.
 */
export const QUEUE_DRAIN_EXIT = HABITANT_EXIT.drained

/**
 * The exit code a pass leaves when its own ERROR row stopped it. Its own row
 * in the taxonomy (`habitant-exit.ts`), because the supervisor has the code
 * and not the log: `drained` means a person asked, this means nobody did.
 */
export const QUEUE_FATAL_EXIT = HABITANT_EXIT["fatal-error"]

/**
 * The fatal cause a drain signal was aborted with, when it was.
 *
 * The host aborts the pass's drain controller with the {@link QueuePassFatal}
 * as the abort reason, so the resident loop — which owns its own exit code —
 * can tell this stop from an operator's drain without a second channel: the
 * same `drainSignal` it already reads for "stop admitting" also says why.
 */
export function fatalQueueDrain(signal: AbortSignal | undefined): QueuePassFatal | undefined {
  if (signal?.aborted !== true) return undefined
  return isQueuePassFatal(signal.reason) ? signal.reason : undefined
}

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

/** The structured props every settle row carries about what stopped the pass:
 * `signal` for a signal (the field the existing readers key on), and the
 * fatal row's namespace and message when an ERROR did. */
function stopProps(stop: QueuePassStop): Readonly<Record<string, unknown>> {
  return isQueuePassFatal(stop)
    ? { stop: "fatal-error", namespace: stop.namespace, message: stop.message }
    : { stop: "signal", signal: stop }
}

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
  stop: QueuePassStop,
  log: DrainLog,
  bound?: Readonly<{ ms?: number; sleep?: (ms: number) => Promise<void> }>,
): Promise<QueueDrainSettlement> {
  const reason = queueDrainReason(stop)
  const stopped = describeQueuePassStop(stop)
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
      log.error?.(`Gave up settling the stopped queue pass after ${String(ms)}ms; exiting anyway.`, {
        action: "queue-drain-bound-expired",
        runner,
        ...stopProps(stop),
        boundMs: ms,
        reason,
      })
      return { runs: [], bounded: true, failed: false }
    }
  } catch (error) {
    log.error?.(
      `Could not settle the stopped queue pass after ${stopped}; the next runner start reclaims its leases.`,
      {
        action: "queue-drain-settle-failed",
        runner,
        ...stopProps(stop),
        reason,
        error: error instanceof Error ? error.message : String(error),
      },
    )
    return { runs: [], bounded: false, failed: true }
  }
  const runs = (settled ?? []).map((run) => run.id)
  if (runs.length > 0) {
    log.info?.(`Stopped queue run ${runs.join(", ")} safely after ${stopped}.`, {
      action: "queue-drain-settled",
      runner,
      ...stopProps(stop),
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
    stopped?: QueuePassStop
    settle: (stop: QueuePassStop) => Promise<void>
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
 * One function so the answers cannot drift: a pass nobody stopped keeps
 * whatever its work decided; a pass a HARD signal cut short keeps `interrupted`
 * (3), which every non-habitant caller already reads as "stopped with work
 * outstanding"; a pass that drained on purpose gets its own code, because a
 * supervisor that cannot tell a deliberate stop from a failure restarts it.
 *
 * A pass that stopped for its own ERROR row outranks all of those. The row is
 * the fact the operator has to act on, and it is the same fact whether a
 * signal also arrived while the pass was draining for it: what killed the
 * pass is the ERROR, and `fatal-error` (17) is the code that says so.
 */
export function drainedQueuePassExit<T extends number>(
  passExit: T,
  stopped: Readonly<{ drained?: QueuePassSignal; hard?: QueuePassSignal; fatal?: QueuePassFatal }>,
): T | typeof QUEUE_DRAIN_EXIT | typeof QUEUE_FATAL_EXIT | typeof HABITANT_EXIT.interrupted {
  if (stopped.fatal !== undefined) return QUEUE_FATAL_EXIT
  if (stopped.hard !== undefined) return HABITANT_EXIT.interrupted
  if (stopped.drained !== undefined) return QUEUE_DRAIN_EXIT
  return passExit
}
