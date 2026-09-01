/**
 * The habitant runner's self-check on the QUEUE it serves — the andon half of
 * "a non-fixable condition must terminate the runner non-zero".
 *
 * `logQueueLivenessWedge` already notices a wedge and logs one ERROR per
 * episode, then serves another cycle. That pairing is the exact shape the
 * 2026-09-01 andon ruling removes: an ERROR the process emits and then
 * continues past is a level assignment arguing with its own control flow.
 * Measured on the live queue that day: wedged from 12:43 PDT, still wedged at
 * 20:00 PDT — 7h12m, 24 eligible changes, one ERROR per tick, and nothing that
 * stopped or escalated on its own.
 *
 * This module does not diagnose the wedge, and deliberately cannot. It answers
 * one question: has the wedge outlived the window in which the queue's own
 * repair robots could still clear it? Past that bound the runner stops being a
 * participant and becomes an alarm.
 *
 * This is the pure half — no process, no clock, no filesystem. It mirrors
 * `habitant-memory.ts` deliberately: the same "fold one settled cycle into a
 * window, then rule on the window" seam, so a reader who has understood one
 * self-check has understood all three.
 *
 * WHY A SEPARATE BOUND FROM DETECTION. `queue-liveness-wedged` fires at
 * `progress.noLandingMs` (default 30 minutes). That threshold answers "is
 * something wrong?" and is tuned to be sensitive. Standing the runner down
 * answers "is this beyond self-repair?" and must be tuned to be certain — a
 * false positive here stops the merge queue for everyone. Two questions, two
 * numbers; collapsing them would force one threshold to be both sensitive and
 * certain, which is the trade that makes an alarm somebody mutes.
 */

/**
 * Overrides {@link HABITANT_QUEUE_WEDGE_STAND_DOWN_DEFAULT_MS}; `0` disables
 * the stand-down and leaves the wedge visible-only.
 *
 * A runtime knob rather than `.yrd.yml` project config, and the split is the
 * same one `HABITANT_RSS_CAP_ENV` draws: `progress.noLandingMs` describes the
 * REPOSITORY's merge expectations and belongs in its config, whereas how long
 * THIS host lets its runner sit on a wedge before stopping it is a property of
 * the supervision, not of the code being merged. Two hosts serving one
 * repository may legitimately answer this differently; neither may disagree
 * about when the queue is wedged.
 */
export const HABITANT_QUEUE_WEDGE_ENV = "YRD_HABITANT_QUEUE_WEDGE_MS"

/**
 * How long a queue may stay continuously wedged before the habitant stands
 * down, in milliseconds.
 *
 * Two hours, and the number is derived rather than picked. Detection fires at
 * `DEFAULT_QUEUE_PROGRESS_POLICY.noLandingMs` (30 minutes), so this is four
 * full detection windows — four chances for the in-loop repair robots (recut,
 * refusal remedy, admission retry, tracked-revision refresh) to clear the wedge
 * on their own before the runner concludes they cannot. Below roughly an hour
 * an ordinary slow drain behind a large batch's check suite would trip it, and
 * a stand-down that fires on healthy slowness is worse than the wedge. Above
 * a few hours it stops being an alarm: the 2026-09-01 specimen had already run
 * 7h12m with no self-recovery and no human action, which is the failure this
 * bound exists to cut short.
 *
 * `0` disables the stand-down and leaves the wedge visible-only — the existing
 * ERROR-per-episode behaviour, unchanged.
 */
export const HABITANT_QUEUE_WEDGE_STAND_DOWN_DEFAULT_MS = 2 * 60 * 60_000

/**
 * Consecutive wedged observations required before the habitant acts.
 *
 * The blocked duration is computed from journal facts rather than sampled, so
 * unlike the RSS read it does not flicker. What this guards is a queue that
 * crosses the bound and then immediately merges: one tick of confirmation
 * costs at most a cycle interval and removes the race between the deciding
 * read and a merge already in flight. Same trade, same reason, as
 * `HABITANT_RSS_CAP_OBSERVATIONS`.
 */
export const HABITANT_QUEUE_WEDGE_OBSERVATIONS = 2

/** One cycle's answer to "how long has this queue been wedged?". */
export type HabitantQueueWedgeObservation = Readonly<{
  /**
   * The wedge's stable identity — the finding's specimen, e.g.
   * `queue:main:liveness-wedged`. `undefined` means this cycle saw no wedge at
   * all, which is not the same as a wedge of zero length and must never be
   * folded as one.
   */
  specimen: string | undefined
  /** How long the queue has been blocked, from the finding's own `blockedMs`. */
  blockedMs: number | undefined
  /** The declared bound in milliseconds; `0` or `undefined` disables it. */
  standDownMs: number | undefined
}>

/** A run of consecutive observations that agree the wedge has outlived its bound. */
export type HabitantQueueWedgeStall = Readonly<{
  specimen: string
  blockedMs: number
  standDownMs: number
  observations: number
}>

export type HabitantQueueWedgeAction =
  /** Nothing to do: no wedge, no bound, inside the bound, or the window is open. */
  | Readonly<{ kind: "serve" }>
  /** Finish the cycle, then exit non-zero and stay down until a person acts. */
  | Readonly<{
      kind: "stand-down"
      specimen: string
      blockedMs: number
      standDownMs: number
      observations: number
    }>

/**
 * Fold one observation into the over-bound window, or `undefined` when this
 * cycle is not part of one.
 *
 * The window is keyed on the SPECIMEN, not merely on being over the bound. Two
 * different wedges separated by a merge are two episodes, and counting them as
 * one consecutive run would let a queue that recovered and re-wedged stand the
 * runner down on a window it never actually held. A changed bound restarts the
 * count for the same reason the memory window restarts on a changed cap: it
 * describes a different question.
 *
 * Unlike the memory window, `blockedMs` is not required to hold still — it
 * grows monotonically while the wedge persists, and demanding two equal
 * readings would mean never acting on the only shape a wedge has.
 */
export function foldQueueWedge(
  previous: HabitantQueueWedgeStall | undefined,
  observation: HabitantQueueWedgeObservation,
): HabitantQueueWedgeStall | undefined {
  const { specimen, blockedMs, standDownMs } = observation
  if (specimen === undefined || blockedMs === undefined || standDownMs === undefined || standDownMs <= 0) {
    return undefined
  }
  if (blockedMs < standDownMs) return undefined
  const continues = previous?.specimen === specimen && previous.standDownMs === standDownMs
  return Object.freeze({
    specimen,
    blockedMs,
    standDownMs,
    observations: continues ? previous.observations + 1 : 1,
  })
}

/**
 * Rule on a closed window.
 *
 * There is no second-attempt guard and no backoff hint here, and that absence
 * is the decision: the successor process reads the same queue and reaches the
 * same verdict, so the only honest disposition is `stand-down` (see
 * `habitant-exit.ts`). The outer bound on repetition is a person.
 */
export function decideQueueWedge(
  stall: HabitantQueueWedgeStall | undefined,
  observations: number = HABITANT_QUEUE_WEDGE_OBSERVATIONS,
): HabitantQueueWedgeAction {
  if (stall === undefined || stall.observations < observations) return { kind: "serve" }
  return Object.freeze({
    kind: "stand-down",
    specimen: stall.specimen,
    blockedMs: stall.blockedMs,
    standDownMs: stall.standDownMs,
    observations: stall.observations,
  })
}
