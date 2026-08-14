/**
 * The resident runner's self-check on its OWN source freshness — box 1 of
 * @yrd/core/stale-runner-never-recycles.
 *
 * A resident boots once and serves for hours. Its code is whatever the source
 * checkout held at startup; the checkout keeps moving underneath it. On
 * 2026-08-14 a resident served three pins-old code for ~3h while the pin
 * advanced four times, silently applying yesterday's gates to today's landings.
 * The `resident-runner-driver-stale` page fired and nothing acted on it, so the
 * runner is made to act on itself: notice the gap, finish the in-flight run,
 * exit unclean, and let the supervisor re-exec a process that reads the new
 * source.
 *
 * This module is the pure half — no git, no filesystem, no clock. It mirrors
 * `foldRefusalStall`'s shape deliberately: the same "fold one settled cycle
 * into a window, then rule on the window" seam the 22474 poisoned-observer
 * self-check already proved out.
 */

/**
 * Commits behind the source checkout before a resident considers itself stale.
 * Two, not one: a single commit is routinely the landing that the resident
 * itself just produced, and recycling on it would restart the runner after
 * every merge. Two means the world moved on without us.
 */
export const RESIDENT_SOURCE_STALE_BEHIND = 2

/**
 * Consecutive observations that must agree before the resident acts. One
 * observation can catch a checkout mid-write — a submodule pin bump is not
 * atomic with the working tree it names — and a recycle is far too expensive
 * to spend on a torn read. Two consecutive cycles at the same head bound the
 * exposure to one poll interval while making a transient disagree harmless.
 */
export const RESIDENT_SOURCE_STALE_OBSERVATIONS = 2

/** One cycle's answer to "how far has my source checkout moved past me?". */
export type ResidentSourceObservation = Readonly<{
  /** The sha this process booted from, or undefined when the source identity is
   * dirty/attested/unknown — unmeasurable, and never stale. */
  bootedSha: string | undefined
  /** The source checkout's HEAD right now, or undefined when unreadable. */
  headSha: string | undefined
  /**
   * Commits `headSha` has advanced past `bootedSha`, and undefined whenever
   * that is not a straight-line advance — unreadable, current, or a checkout
   * that diverged or rewound past us. Undefined must never be read as zero:
   * "I could not tell" and "I am current" are the same rendering but opposite
   * evidence, and only the second may authorize serving on.
   */
  behind: number | undefined
}>

/** A run of consecutive observations that agree the source has moved on. */
export type ResidentSourceStall = Readonly<{
  bootedSha: string
  headSha: string
  behind: number
  observations: number
}>

/**
 * The last recycle this resident lineage attempted, read back after the
 * re-exec. It is the only evidence a fresh process has that it is the SECOND
 * try, and it is what separates a recycle that works from a restart loop.
 */
export type ResidentSourceRecycle = Readonly<{
  /** The sha the previous process was running when it gave up. */
  bootedSha: string
  /** The sha it expected to come back as. */
  headSha: string
  attemptedAt: string
}>

export type ResidentSourceAction =
  /** Nothing to do: current, unmeasurable, or the window has not closed yet. */
  | Readonly<{ kind: "serve" }>
  /** Finish the in-flight run, then exit unclean so the supervisor re-execs. */
  | Readonly<{ kind: "recycle"; bootedSha: string; headSha: string; behind: number; observations: number }>
  /**
   * We already recycled for exactly this gap and came back running exactly the
   * same code. Restarting again cannot help — whatever the resident boots from
   * is not the checkout that moved — so it must NOT be tried again. Serving
   * stale beats a runner that spends its restart budget flapping and leaves the
   * queue with no runner at all.
   */
  | Readonly<{ kind: "checkout-behind"; bootedSha: string; headSha: string; behind: number; attemptedAt: string }>

/**
 * Fold one observation into the staleness window, or `undefined` when this
 * cycle is not part of one.
 *
 * The window continues only while BOTH ends hold still: the same booted sha
 * (trivially true within one process, and the check that makes a replayed fold
 * honest) and the same checkout head. A head that is still moving restarts the
 * count rather than extending it — mid-advance is exactly when a torn read is
 * most likely, and there is no hurry to recycle onto a sha that is about to be
 * superseded anyway.
 */
export function foldSourceStaleness(
  previous: ResidentSourceStall | undefined,
  observation: ResidentSourceObservation,
  threshold: number = RESIDENT_SOURCE_STALE_BEHIND,
): ResidentSourceStall | undefined {
  const { bootedSha, headSha, behind } = observation
  if (bootedSha === undefined || headSha === undefined || behind === undefined) return undefined
  if (behind < threshold) return undefined
  const continues = previous?.bootedSha === bootedSha && previous.headSha === headSha
  return Object.freeze({
    bootedSha,
    headSha,
    behind,
    observations: continues ? previous.observations + 1 : 1,
  })
}

/**
 * Rule on a closed window.
 *
 * The `checkout-behind` verdict is the whole reason this takes the prior
 * recycle as an argument. A resident boots from the live checkout, so a recycle
 * is only an actuator when that checkout is the thing that moved. When it is
 * not — a frozen checkout during a custody hold, a launcher whose source
 * identity is misrecorded, a shim resolving a different tree — the re-exec
 * comes back at the same sha with the same gap, and a mechanism that only knew
 * how to exit would exit forever. One attempt per (booted, head) pair is the
 * bound; the supervisor's restart budget is the outer guard behind it, not the
 * first line of defense.
 */
export function decideResidentSource(
  stall: ResidentSourceStall | undefined,
  lastRecycle: ResidentSourceRecycle | undefined,
  observations: number = RESIDENT_SOURCE_STALE_OBSERVATIONS,
): ResidentSourceAction {
  if (stall === undefined || stall.observations < observations) return { kind: "serve" }
  const { bootedSha, headSha, behind } = stall
  if (lastRecycle?.bootedSha === bootedSha && lastRecycle.headSha === headSha) {
    return Object.freeze({ kind: "checkout-behind", bootedSha, headSha, behind, attemptedAt: lastRecycle.attemptedAt })
  }
  return Object.freeze({ kind: "recycle", bootedSha, headSha, behind, observations: stall.observations })
}
