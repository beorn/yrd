/**
 * The habitant runner's exit taxonomy — the ONE contract between a runner that
 * stops on purpose and the supervisor that decides what to do about it.
 *
 * Until this module existed, three of the four conditions below returned the
 * SAME code (3), each defending the sharing in its own comment: the
 * distinguishing evidence was "the loud record, not the code". That reasoning
 * holds only for a reader that has the records. The supervisor is not such a
 * reader — `decideSupervisedRestart` in Hab is a pure function of
 * `(observation, desired, policy)` whose only channel from the process is the
 * exit code, so a policy that wants to pace one condition and not another has
 * nothing to key on. Measured on a live runner's Hab supervision log
 * (2026-08-30): 142 exits at `code=3`, all of them one of three different
 * events, none of them separable after the fact.
 *
 * So the code carries the condition, and the records stay as the detail. Two
 * rules keep this honest:
 *
 * 1. **Interrupted keeps 3.** Every non-habitant caller and the habitant
 *    breaker already count 3 as "stopped with work outstanding"; moving it
 *    would rewrite a contract that is not broken to fix one that is.
 * 2. **The new codes start at 10.** 0/1/2/3 are the generic verb alphabet
 *    (success / failure / unknown / interrupted) that every Yrd command speaks.
 *    A habitant lifecycle condition is not a verb result, and giving it 4 would
 *    put it one typo away from one.
 */

/**
 * Each condition's exit code. Distinct by construction — that is the entire
 * point of the table, and `habitant-exit.test.ts` asserts it, because the
 * defect this replaces was three constants quietly assigned to each other.
 */
export const HABITANT_EXIT = {
  /** A hard signal cut an unfinished drain short, leaving in-flight work (D3). */
  interrupted: 3,
  /** Self-restart out of presumptive poisoned-observer state (22474 specimen 3). */
  poisoned: 10,
  /** Recycle onto the code this process's own source checkout has moved to
   * (@yrd/core/stale-runner-never-recycles box 1). */
  "source-stale": 11,
  /** The process crossed its declared RSS cap and stood down before the kernel
   * did it for us. */
  "memory-cap": 12,
} as const

export type HabitantExitCondition = keyof typeof HABITANT_EXIT
export type HabitantExitCode = (typeof HABITANT_EXIT)[HabitantExitCondition]

/**
 * What a supervisor should DO about each condition — the distinction the shared
 * code made unrepresentable.
 *
 * `restart-immediately` is for a condition whose cure IS the restart: a fresh
 * process is by construction not poisoned, and a recycle onto moved source is
 * pointless if delayed. `restart-with-backoff` is for a condition the restart
 * does not cure: a runner that ballooned past its cap will balloon again, and
 * restarting it hot converts a memory problem into a spawn storm.
 */
export type HabitantRestartDisposition = "restart-immediately" | "restart-with-backoff"

export const HABITANT_EXIT_DISPOSITION: Readonly<Record<HabitantExitCondition, HabitantRestartDisposition>> =
  Object.freeze({
    interrupted: "restart-immediately",
    poisoned: "restart-immediately",
    "source-stale": "restart-immediately",
    "memory-cap": "restart-with-backoff",
  })

/**
 * Name the condition an observed exit code stands for, or `undefined` when the
 * code is not one this taxonomy issues.
 *
 * `undefined` is a real answer and must not be rendered as a condition: a
 * habitant that died of an ordinary verb failure (1), an unreadable state (2)
 * or a signal exited for a reason this table does not describe, and saying so
 * is the difference between "we do not know" and a wrong name.
 */
export function habitantExitCondition(code: number): HabitantExitCondition | undefined {
  for (const [condition, value] of Object.entries(HABITANT_EXIT)) {
    if (value === code) return condition as HabitantExitCondition
  }
  return undefined
}

/**
 * The codes a supervisor should pace rather than restart hot — the list a host
 * declares to Hab, derived from the table above rather than copied beside it.
 */
export const HABITANT_BACKOFF_EXIT_CODES: readonly HabitantExitCode[] = Object.freeze(
  (Object.keys(HABITANT_EXIT) as HabitantExitCondition[])
    .filter((condition) => HABITANT_EXIT_DISPOSITION[condition] === "restart-with-backoff")
    .map((condition) => HABITANT_EXIT[condition]),
)
