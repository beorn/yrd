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
  /**
   * The queue repository's RECORDED pin of Yrd moved while this process was
   * serving, so the code this runner is executing is no longer the code the
   * queue's own main branch prescribes (24047).
   *
   * The third member of the "the code moved under me" family, and the one the
   * other two could not see. `source-stale` (11) compares this process against
   * the CHECKOUT it booted from, and `installed-plan-stale` (13) compares its
   * installed step set against the base tip's declaration — so a pin advance
   * that changed neither the local checkout nor the step plan was invisible to
   * both, and every one of them was landed by hand: an operator stopped the
   * resident, advanced the gitlink, and started it again. Measured 2026-09-02:
   * best case 2m43s, worst ~40 minutes, on the fleet's critical path.
   *
   * `restart-immediately` for the same reason as its two siblings: a fresh
   * process reads the pin as it now stands, so the restart IS the cure.
   */
  "root-pin-moved": 18,
  // 14 and 15 were `queue-wedged` and `refusal-loop`: declared stand-downs
  // (`habitant-queue-wedge.ts`, `habitant-refusal-loop.ts`) that no call site
  // ever reached. Deleted with @i/10-yrd/24030: the wedge the 2-hour bound was
  // meant to catch — a run whose holder died and that nothing settled — is now
  // settled at every pass start, so the observation the fold consumed no longer
  // arises from that class, and a declared-but-dead exit reads as coverage. The
  // numbers stay retired so a supervisor's table never re-reads them.
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
    // A fresh process reads the recorded pin as it now stands. Same cure, same
    // family: 11, 13 and 18 are the three RESTART codes, and a supervisor that
    // files any of them under "stays down" reintroduces the hand ritual each
    // one exists to remove.
    "root-pin-moved": "restart-immediately",
    // Restarting contradicts the instruction that produced it.
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
 * NOT ENFORCED TODAY, and that gap is worth knowing before trusting this list.
 * The Yrd runner is declared `restart: "on-failure"` (`hab.projects.ts`), which
 * restarts on every non-zero exit — these two included — because the policy
 * that would hold them, hab-core's `permanentExitCodes`, is unreachable from a
 * project's service declaration: it is absent from `SERVICE_KEYS` in
 * ag/packages/hab-config, and declaring it anyway is a FATAL unknown key that
 * takes down the whole composition rather than just this service. Inhab's
 * restart budget (three per 600s, then `stop-budget`) is what bounds them
 * meanwhile, so a stand-down condition still ends stopped and paged, three
 * attempts later than it should.
 *
 * The list stays derived and exported for the supervisor that CAN consume it:
 * once hab-config accepts the key, `hab.projects.ts` declares exactly this
 * list and the gap closes with no change here.
 *
 * THE RESTART CODES, named together because they are the ones a supervisor
 * must never file under "stays down": `source-stale` (11) — the checkout moved
 * under this process; `installed-plan-stale` (13) — the base tip declares a
 * different step plan than this process installed, which fired twice on
 * 2026-09-02 as gate-touching merges landed; and `root-pin-moved` (18) — the
 * queue repository advanced its recorded Yrd pin. All three mean "the code
 * moved under me", all three are taken at a pass boundary with nothing in
 * flight, and all three are cured by the relaunch and by nothing else. Under
 * the `restart: "never"` this replaced, every one of them was inert: the
 * runner left correctly and nothing brought it back.
 */
export const HABITANT_STAND_DOWN_EXIT_CODES: readonly HabitantExitCode[] = Object.freeze(
  (Object.keys(HABITANT_EXIT) as HabitantExitCondition[])
    .filter((condition) => HABITANT_EXIT_DISPOSITION[condition] === "stand-down")
    .map((condition) => HABITANT_EXIT[condition]),
)
