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
  /** Recycle because the base tip's declared plan no longer matches the plan
   * this process installed at boot, and no in-place reload was available to
   * fix it live (23192 leg c, `plan-audit.ts` `installed-plan-stale`). Measured
   * 2026-08-30, 04:39–06:09 PDT: seven of these, one per gate-touching merge,
   * all by design — and all seven read as failures because this exit shared
   * `refusal`'s generic code 1 with every genuine one. */
  "installed-plan-stale": 13,
  /** The queue stayed liveness-wedged past its declared stand-down bound, so
   * the habitant stopped rather than keep logging an ERROR it cannot act on
   * (@i/10-yrd, andon ruling 2026-09-01). Unlike every condition above it, a
   * successor process does not change the answer: the wedge lives in the queue
   * this runner reads, not in the runner, so a fresh one re-reads the same
   * wedge and stands down again. That is why it is the first condition
   * dispositioned `stand-down`. */
  "queue-wedged": 14,
  /** One typed refusal cost every cycle in a window past its declared bound, so
   * the habitant stopped rather than keep skipping cycles it will keep losing
   * (`habitant-refusal-loop.ts`). The 2026-09-01 kind-keyed skip is what makes
   * this reachable, and rightly so: killing the runner on a single refusal took
   * the whole queue offline twice in 21 minutes. But a refusal about the WORLD
   * is not spent by being skipped — it arrives again next cycle, and the runner
   * serves nothing while every instrument reads it as healthy. Dispositioned
   * `stand-down` for the same reason as `queue-wedged`: the verdict lives in the
   * journal this runner reads, so a successor re-derives the same member and is
   * refused the same way. */
  "refusal-loop": 15,
  /** A signal asked this pass to stop and it drained: admissions closed, the
   * job in flight settled to a terminal state with a coded reason, the lease
   * released (`queue-drain.ts`). Distinct from `interrupted` because the two
   * differ in exactly the fact a supervisor needs: `interrupted` left work
   * outstanding and wants the successor to resume draining, while this pass
   * left nothing outstanding and was stopped ON PURPOSE. Measured 2026-09-01:
   * three one-shot passes died to signals in one day, and every instrument
   * read all three as "exited after SIGTERM" — the same string a crashed pass
   * produces. Dispositioned `stand-down` for the plainest reason in the table:
   * a person asked this pass to stop, so restarting it is undoing their
   * request, not curing a fault. */
  drained: 16,
  /** The pass reported an ERROR-level row and stopped for it: admissions
   * closed, the job in flight settled with the coded reason
   * `queue-pass-errored`, the lease released (`queue-drain.ts`), and the row
   * that killed it named in a terminal ERROR line. Operator ruling 2026-09-01:
   * "if the queue ERRORs without quitting we should fix that — any ERROR
   * should result in it dying." Before this code a pass that logged an ERROR
   * and carried on exited 0 or 1 like any other, so the log said one thing and
   * the exit status another. Distinct from `drained` (a person asked) and
   * `interrupted` (a signal took it): nobody asked for this stop, and the
   * successor faces the same condition until a person reads the row.
   * Dispositioned `stand-down` on the three-way failure model's own terms:
   * ERROR is the abnormal-NOT-auto-fixable class, so a restart is by
   * definition not the cure. */
  "fatal-error": 17,
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
 *
 * `stand-down` is for a condition no number of restarts can reach, because the
 * fault is not in this process at all. Pacing such a condition only sets how
 * often we rediscover it; the andon ruling (2026-09-01) says the runner stays
 * exited until a person corrects the cause and starts it deliberately. A
 * disposition that said "restart, but slowly" would describe a supervisor
 * still trying, which is exactly the posture the ruling removes.
 */
export type HabitantRestartDisposition = "restart-immediately" | "restart-with-backoff" | "stand-down"

export const HABITANT_EXIT_DISPOSITION: Readonly<Record<HabitantExitCondition, HabitantRestartDisposition>> =
  Object.freeze({
    interrupted: "restart-immediately",
    poisoned: "restart-immediately",
    "source-stale": "restart-immediately",
    "memory-cap": "restart-with-backoff",
    // A fresh process installs whatever the base tip declares at boot, which
    // is exactly the cure — same reasoning as `source-stale`.
    "installed-plan-stale": "restart-immediately",
    "queue-wedged": "stand-down",
    "refusal-loop": "stand-down",
    // Not "no number of restarts can reach it" like the two above, but the
    // stronger case: restarting contradicts the instruction that produced it.
    drained: "stand-down",
    // ERROR is the abnormal-not-auto-fixable class by definition; a successor
    // meets the same row until a person acts on it.
    "fatal-error": "stand-down",
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

/**
 * The codes that must never be restarted automatically, derived the same way.
 *
 * A service declared `restart: never` already stays down whatever it exits
 * with, so this list is not what keeps a wedged runner stopped. It exists so a
 * supervisor that DOES pace this process — a differently-declared host, or a
 * future policy keyed on the code rather than the service — cannot reach
 * "restart" for a condition whose whole meaning is that restarting is futile.
 * Derived rather than restated, for the same reason as the backoff list.
 */
export const HABITANT_STAND_DOWN_EXIT_CODES: readonly HabitantExitCode[] = Object.freeze(
  (Object.keys(HABITANT_EXIT) as HabitantExitCondition[])
    .filter((condition) => HABITANT_EXIT_DISPOSITION[condition] === "stand-down")
    .map((condition) => HABITANT_EXIT[condition]),
)
