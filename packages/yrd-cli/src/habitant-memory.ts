/**
 * The habitant runner's self-check on its OWN resident set — the backstop half
 * of "the runner exits and respawns; nothing reclaims in-process".
 *
 * A habitant boots once and serves for hours. Measured on the live runner
 * 2026-08-30 at 1h51m uptime: `VmRSS` 6.2 GB, `VmHWM` 26.3 GB, against a
 * supervision log carrying 49 `signal=SIGKILL` exits — the kernel's OOM killer
 * reaping the process, and every one of those recorded by Hab as `reason:
 * "crash"`, `declared: false`. A crash tells the supervisor nothing it can act
 * on differently, and it takes whatever run was in flight with it.
 *
 * This module does not fix the growth — root-causing that is explicitly out of
 * scope, and a cap is a backstop, not a cure. It changes WHO stops the process
 * and WHEN: the runner notices its own size, finishes the cycle it is on, and
 * exits with a code that names the reason, at a boundary where no run is in
 * flight. A declared exit the supervisor can pace beats a SIGKILL it can only
 * count.
 *
 * This is the pure half — no process, no clock, no filesystem. It mirrors
 * `source-staleness.ts` deliberately: the same "fold one settled cycle into a
 * window, then rule on the window" seam, so a reader who has understood one
 * self-check has understood both.
 */

/**
 * Overrides {@link HABITANT_RSS_CAP_DEFAULT_MB}; `0` disables the cap and
 * leaves the size visible-only. A runtime knob rather than project config, for
 * the same reason the staleness threshold is one: it describes how this HOST
 * supervises a habitant process, not anything about the repository being
 * merged.
 */
export const HABITANT_RSS_CAP_ENV = "YRD_HABITANT_RSS_CAP_MB"

/**
 * Off unless the host declares a number.
 *
 * The bead asks for a DECLARED cap, and this is the honest reading of that
 * word. The only measurement available when this shipped was a single live
 * sample of an already-ballooned process (6.2 GB resident, 26.3 GB peak); the
 * legitimate working set of a healthy habitant was never measured. A default
 * guessed under it would restart the runner every cycle, which is worse than
 * the OOM it replaces — and a default guessed over it would be a number that
 * looks declared while protecting nothing. The mechanism ships complete and
 * tested; the number belongs to the host that can measure its own machine.
 */
export const HABITANT_RSS_CAP_DEFAULT_MB = 0

/**
 * Consecutive observations over the cap before the habitant acts.
 *
 * `process.memoryUsage.rss()` is an instantaneous read, not a high-water mark:
 * a single sample can catch a transient peak that the next collection returns.
 * Two consecutive cycles over the cap bound the exposure to one poll interval
 * while making a spike harmless — the same trade, for the same reason, as
 * `HABITANT_SOURCE_STALE_OBSERVATIONS`.
 */
export const HABITANT_RSS_CAP_OBSERVATIONS = 2

/** One cycle's answer to "how big am I right now?". */
export type HabitantMemoryObservation = Readonly<{
  /** Resident bytes, or undefined when the runtime cannot report them —
   * unmeasurable, and never over cap. Undefined must never be read as zero:
   * "I could not tell" and "I am small" are opposite evidence. */
  rssBytes: number | undefined
  /** The declared cap in bytes; `undefined` when no cap is declared. */
  capBytes: number | undefined
}>

/** A run of consecutive observations that agree the process is over its cap. */
export type HabitantMemoryStall = Readonly<{
  rssBytes: number
  capBytes: number
  observations: number
}>

export type HabitantMemoryAction =
  /** Nothing to do: under cap, uncapped, unmeasurable, or the window is open. */
  | Readonly<{ kind: "serve" }>
  /** Finish the cycle, then exit so the supervisor respawns a fresh process. */
  | Readonly<{ kind: "stand-down"; rssBytes: number; capBytes: number; observations: number }>

/**
 * Fold one observation into the over-cap window, or `undefined` when this cycle
 * is not part of one.
 *
 * Unlike the staleness window, this one does NOT require the reading to hold
 * still between cycles — a growing process is exactly the case worth acting on,
 * and demanding two equal byte counts would mean never acting on the only
 * shape the growth has ever taken. What must hold still is the CAP: a cap that
 * changed under us describes a different question, and the count restarts.
 */
export function foldMemoryCap(
  previous: HabitantMemoryStall | undefined,
  observation: HabitantMemoryObservation,
): HabitantMemoryStall | undefined {
  const { rssBytes, capBytes } = observation
  if (rssBytes === undefined || capBytes === undefined || capBytes <= 0) return undefined
  if (rssBytes <= capBytes) return undefined
  const continues = previous?.capBytes === capBytes
  return Object.freeze({
    rssBytes,
    capBytes,
    observations: continues ? previous.observations + 1 : 1,
  })
}

/**
 * Rule on a closed window.
 *
 * There is deliberately no second-attempt guard of the `checkout-behind` kind
 * here, and the asymmetry is the point: a recycle onto source that did not move
 * cannot help and must stop itself, whereas a fresh process really is smaller
 * than the one that outgrew its cap. The outer bound on repetition is the
 * supervisor's paced restart — which is why `memory-cap` is the one condition
 * in the exit taxonomy dispositioned `restart-with-backoff`.
 */
export function decideHabitantMemory(
  stall: HabitantMemoryStall | undefined,
  observations: number = HABITANT_RSS_CAP_OBSERVATIONS,
): HabitantMemoryAction {
  if (stall === undefined || stall.observations < observations) return { kind: "serve" }
  return Object.freeze({
    kind: "stand-down",
    rssBytes: stall.rssBytes,
    capBytes: stall.capBytes,
    observations: stall.observations,
  })
}
