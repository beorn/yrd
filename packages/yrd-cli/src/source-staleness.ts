/**
 * The habitant runner's self-check on its OWN source freshness — box 1 of
 * @yrd/core/stale-runner-never-recycles.
 *
 * A habitant boots once and serves for hours. Its code is whatever the source
 * checkout held at startup; the checkout keeps moving underneath it. On
 * 2026-08-14 a habitant served three pins-old code for ~3h while the pin
 * advanced four times, silently applying yesterday's gates to today's merges.
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
 * Commits behind the source checkout before a habitant considers itself stale.
 *
 * **One, lowered from two 2026-08-30.** The value is not the interesting part;
 * the premise that defended it was, and that premise had stopped being true.
 *
 * It read: "a single commit is routinely the merge that the habitant itself
 * just produced, and recycling on it would restart the runner after every
 * merge." That describes a comparison against the QUEUE repository — the one
 * the habitant merges into. This check does not make that comparison and has
 * not for some time: `readSourceAdvance` is called with `yrdSourceCheckout()`,
 * the Yrd checkout `implementationSource` was captured from, after comparing
 * against the `/hh` checkout was found returning 37576 for a habitant that was
 * exactly current. A merge the habitant produces lands in the queue repository
 * and cannot advance the observed head by one, or at all. The threshold was
 * therefore paying a real cost against a risk it was no longer holding.
 *
 * That cost, measured over the last 60 gitlink advances to the Yrd submodule
 * in its host superproject (2026-08-30): **35 of them carried exactly one Yrd
 * commit.** At a threshold
 * of two, the majority of Yrd changes could not deploy to a running habitant on
 * their own — each waited for some later, unrelated advance to push the
 * cumulative count over the line. That is the 2026-08-15 specimen exactly: a
 * chief-ruled fail-safe merged and sat inert for hours, because "most urgent
 * fixes are exactly one commit."
 *
 * The flapping risk the old comment named is real and is still held — by three
 * mechanisms, none of which is this number:
 *
 * 1. {@link HABITANT_SOURCE_STALE_OBSERVATIONS} — two consecutive agreeing
 *    observations, so a checkout caught mid-write cannot trigger a recycle.
 * 2. The `checkout-behind` verdict in {@link decideHabitantSource} — one
 *    attempt per (booted, head) pair, so a habitant that recycles and comes
 *    back on the same sha stops and names the remedy instead of looping.
 * 3. The supervisor's restart budget — the outer bound when the newly-checked-
 *    out source cannot boot at all, a case this threshold never guarded, since
 *    a process that dies at startup never reaches this check no matter what
 *    number it holds.
 */
export const HABITANT_SOURCE_STALE_BEHIND = 1

/**
 * Consecutive observations that must agree before the habitant acts. One
 * observation can catch a checkout mid-write — a submodule pin bump is not
 * atomic with the working tree it names — and a recycle is far too expensive
 * to spend on a torn read. Two consecutive cycles at the same head bound the
 * exposure to one poll interval while making a transient disagree harmless.
 */
export const HABITANT_SOURCE_STALE_OBSERVATIONS = 2

/** One cycle's answer to "how far has my source checkout moved past me?". */
export type HabitantSourceObservation = Readonly<{
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
export type HabitantSourceStall = Readonly<{
  bootedSha: string
  headSha: string
  behind: number
  observations: number
}>

/**
 * The last recycle this habitant lineage attempted, read back after the
 * re-exec. It is the only evidence a fresh process has that it is the SECOND
 * try, and it is what separates a recycle that works from a restart loop.
 *
 * Shared by every habitant designed-exit that recycles onto a fresh process —
 * not source-staleness alone. `run.ts` writes the same file (and this same
 * shape) for `installed-plan-stale` (23192 leg c): a habitant whose installed
 * plan no longer matches the base tip's declared one and has no in-place
 * reload wired. `reason` names which; absent reads as `"source-stale"`, the
 * only reason that existed before 2026-08-30. Deliberately one shape — a
 * reader (the queue status projection, `queue audit`, `watch`) checks one
 * file for "why did this habitant last recycle" instead of several.
 */
export type HabitantSourceRecycle = Readonly<{
  /** Which designed exit wrote this record. Absent on records written before
   * this field existed, which were all `"source-stale"`. */
  reason?: "source-stale" | "installed-plan-stale"
  /** The sha the previous process was running when it gave up. For
   * `"installed-plan-stale"`, the sha this process booted from
   * (`habitantBootedSha`) — the analogous "what this process was running"
   * fact, read the same way the source-staleness check already reads it. */
  bootedSha: string
  /** The sha it expected to come back as. For `"installed-plan-stale"`, the
   * base tip sha whose declared plan disagreed with what this process
   * installed. */
  headSha: string
  attemptedAt: string
  /** Step names whose declaration differs between what this process installed
   * and what the tip now declares. Only present for `reason:
   * "installed-plan-stale"`. */
  staleSteps?: readonly string[]
}>

export type HabitantSourceAction =
  /** Nothing to do: current, unmeasurable, or the window has not closed yet. */
  | Readonly<{ kind: "serve" }>
  /** Finish the in-flight run, then exit unclean so the supervisor re-execs. */
  | Readonly<{ kind: "recycle"; bootedSha: string; headSha: string; behind: number; observations: number }>
  /**
   * We already recycled for exactly this gap and came back running exactly the
   * same code. Restarting again cannot help — whatever the habitant boots from
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
  previous: HabitantSourceStall | undefined,
  observation: HabitantSourceObservation,
  threshold: number = HABITANT_SOURCE_STALE_BEHIND,
): HabitantSourceStall | undefined {
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
 * recycle as an argument. A habitant boots from the live checkout, so a recycle
 * is only an actuator when that checkout is the thing that moved. When it is
 * not — a frozen checkout during a custody hold, a launcher whose source
 * identity is misrecorded, a shim resolving a different tree — the re-exec
 * comes back at the same sha with the same gap, and a mechanism that only knew
 * how to exit would exit forever. One attempt per (booted, head) pair is the
 * bound; the supervisor's restart budget is the outer guard behind it, not the
 * first line of defense.
 *
 * `lastRecycle` is read from a file `run.ts` now shares with the
 * `installed-plan-stale` designed exit (see {@link HabitantSourceRecycle}).
 * Only a record this SAME check wrote suppresses a retry here — a plan-stale
 * recycle's `(bootedSha, headSha)` pair can coincide with a source-staleness
 * one (both are read off the same booted process and can land on the same
 * repository tip), and treating that coincidence as "already tried" would
 * suppress a source recycle nothing has actually attempted yet.
 */
export function decideHabitantSource(
  stall: HabitantSourceStall | undefined,
  lastRecycle: HabitantSourceRecycle | undefined,
  observations: number = HABITANT_SOURCE_STALE_OBSERVATIONS,
): HabitantSourceAction {
  if (stall === undefined || stall.observations < observations) return { kind: "serve" }
  const { bootedSha, headSha, behind } = stall
  const ownRecycle = (lastRecycle?.reason ?? "source-stale") === "source-stale" ? lastRecycle : undefined
  if (ownRecycle?.bootedSha === bootedSha && ownRecycle.headSha === headSha) {
    return Object.freeze({ kind: "checkout-behind", bootedSha, headSha, behind, attemptedAt: ownRecycle.attemptedAt })
  }
  return Object.freeze({ kind: "recycle", bootedSha, headSha, behind, observations: stall.observations })
}
