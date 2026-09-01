import { raiseFailure } from "@yrd/core"

/**
 * The habitant runner's self-check on a REFUSAL THAT NEVER STOPS — the floor
 * under the 2026-09-01 kind-keyed cycle skip.
 *
 * That fix is right and this does not weaken it: a typed refusal is a verdict
 * about one change, the compose already skips them per candidate, and one
 * arriving at the cycle boundary means a seam missed it, so killing the runner
 * over it took the whole queue offline twice in 21 minutes under
 * `restart: "never"`. Skipping the cycle bounded what one refusal costs.
 *
 * What it did not bound is HOW MANY cycles it costs. A refusal about the world
 * the runner reads — a derived submit whose branch moved, a member the journal
 * still lists and the remote no longer has — is not spent by being skipped. It
 * is there again on the next cycle, and the next. The runner emits one warn per
 * interval and serves nothing, which every instrument reads as a healthy
 * process doing healthy work: the pid is up, the loop is ticking, the log has
 * lines in it. Trading a loud outage for a quiet one is only progress if
 * something counts the repeats. This counts them.
 *
 * NOT `foldRefusalStall` in `refusal-remedy.ts`, and the difference decides the
 * disposition. That window is about a cycle that RAN: the compose reached every
 * candidate and refused each one while nothing about them moved, which
 * indicts THIS PROCESS's observation — so its cure is a restart (`poisoned`,
 * exit 10), and a fresh process really does fix it. This window is about a
 * cycle that did NOT run: one refusal escaped to the boundary and cost the
 * whole interval. A successor reads the same journal, re-derives the same
 * member and is refused the same way, so a restart changes nothing and the only
 * honest disposition is `stand-down` (exit 15). Same word in both names, two
 * different questions, two different answers.
 *
 * The pure half — no process, no clock, no filesystem — mirroring
 * `habitant-queue-wedge.ts` and `habitant-memory.ts`: fold one settled cycle
 * into a window, then rule on the window. Like the queue wedge, nothing calls
 * it yet; the andon ruling wires a new stand-down only once Hab pages terminal
 * exits.
 */

/**
 * Overrides {@link HABITANT_REFUSAL_LOOP_DEFAULT_CYCLES}; `0` disables the
 * stand-down and leaves the loop visible-only.
 *
 * A runtime knob rather than `.yrd.yml` project config, the same split
 * `HABITANT_RSS_CAP_ENV` and `HABITANT_QUEUE_WEDGE_ENV` draw: how long THIS
 * host lets its runner burn cycles on one refusal is a property of the
 * supervision, not of the code being merged.
 */
export const HABITANT_REFUSAL_LOOP_CYCLES_ENV = "YRD_RESIDENT_REFUSAL_LOOP_CYCLES"

/**
 * Consecutive cycles one refusal may cost before the habitant stands down.
 *
 * Twenty, and the number is borrowed rather than picked: it is
 * `HABITANT_REFUSAL_STALL_CYCLES`, the bound the poisoned-observer window
 * already uses for "this runner has got nowhere for long enough to act". Both
 * count cycles of a runner serving nothing, so answering them with two
 * different numbers would need a reason neither has. At the default 15s
 * interval that is five minutes — long enough that a losable race, a peer's
 * in-flight settlement, or a seat re-pushing a branch resolves inside it, and
 * short enough that the 2026-09-01 specimens (which repeated for as long as a
 * fleet kept pushing) are cut off in minutes rather than discovered by a person.
 *
 * Deliberately a COUNT, not a duration. What is wrong is not that time passed;
 * it is that the runner reached the same verdict N times with nothing to show
 * for it, and the cycle is the unit in which that repeats.
 */
export const HABITANT_REFUSAL_LOOP_DEFAULT_CYCLES = 20

/**
 * One settled cycle, reduced to the three outcomes this window distinguishes.
 *
 * MECE on purpose, and the third case is the one that is easy to leave out.
 * `composed` falsifies the premise outright. `refusal` is a cycle spent. But a
 * cycle the runner spent WAITING — a peer holds the queue, the journal is
 * momentarily locked, a Job settled underneath the snapshot — is neither: the
 * runner correctly declined to act on a world that is mid-change. Folding it as
 * a lost cycle would stand the runner down for being polite; folding it as
 * progress would let one busy tick launder an unbounded refusal loop, and a
 * queue that is busy every other tick would never reach the bound.
 */
export type HabitantRefusalLoopObservation =
  /** The cycle produced work. Whatever refused before is not a loop. */
  | Readonly<{ kind: "composed" }>
  /** The cycle was lost to a typed refusal at the boundary. */
  | Readonly<{
      code: string
      kind: "refusal"
      /**
       * The member the refusal is attributable to, from `FailureFact.pr`.
       * `undefined` means "not attributable to a single member", which is a
       * different fact from "attributable to a member we did not name" and
       * must never continue a named member's streak.
       */
      pr: string | undefined
    }>
  /** Healthy waiting: busy queue, locked journal, settlement race. */
  | Readonly<{ kind: "waiting" }>

/** A run of consecutive cycles lost to ONE refusal. */
export type HabitantRefusalLoopWindow = Readonly<{
  code: string
  pr: string | undefined
  cycles: number
}>

export type HabitantRefusalLoopAction =
  /** Nothing to do: no loop, no bound, or the streak is short of it. */
  | Readonly<{ kind: "serve" }>
  /** Finish the cycle, then exit non-zero and stay down until a person acts. */
  | Readonly<{
      bound: number
      code: string
      cycles: number
      kind: "stand-down"
      pr: string | undefined
    }>

/**
 * Fold one settled cycle into the refusal-loop window, or `undefined` when the
 * runner is not in one.
 *
 * The window is keyed on the CODE and the MEMBER, and on neither the message
 * nor anything derived from it. The message is the field a reader reaches for
 * first and the one that must key nothing: a derived-lane refusal quotes the
 * branch head it was refused at, so it changes on every push while the refusal
 * stays the same refusal — keying on it would restart the count exactly as
 * often as the fleet pushes, which is to say it would never trip. The member
 * belongs in the key for the opposite reason: one code refusing five members in
 * turn is five verdicts about five changes, which is the queue working, and
 * counting them as one streak would stand the runner down on a busy day.
 */
export function foldRefusalLoop(
  previous: HabitantRefusalLoopWindow | undefined,
  observation: HabitantRefusalLoopObservation,
): HabitantRefusalLoopWindow | undefined {
  if (observation.kind === "composed") return undefined
  if (observation.kind === "waiting") return previous
  const continues = previous?.code === observation.code && previous.pr === observation.pr
  return Object.freeze({
    code: observation.code,
    pr: observation.pr,
    cycles: continues ? previous.cycles + 1 : 1,
  })
}

/**
 * Rule on a window.
 *
 * There is no backoff hint and no second-attempt guard here, and that absence
 * is the decision — the same one `decideQueueWedge` makes, for the same reason.
 * The outer bound on repetition is a person.
 */
export function decideRefusalLoop(
  window: HabitantRefusalLoopWindow | undefined,
  bound: number = HABITANT_REFUSAL_LOOP_DEFAULT_CYCLES,
): HabitantRefusalLoopAction {
  if (window === undefined || bound <= 0 || window.cycles < bound) return { kind: "serve" }
  return Object.freeze({
    kind: "stand-down",
    code: window.code,
    pr: window.pr,
    cycles: window.cycles,
    bound,
  })
}

/**
 * The ERROR a stand-down leaves behind, built here rather than at the eventual
 * call site.
 *
 * A stand-down is the last thing this process says, so the row is the whole
 * account of why a merge queue is stopped. Four facts make it actionable — the
 * code names what was refused, the member names what to look at, the count and
 * the bound together say "this was a loop, not a blip" — and a row built at the
 * call site can omit one silently. Built from the decision that justifies it,
 * omitting one is a type error.
 */
export function refusalLoopStandDownRow(
  action: Extract<HabitantRefusalLoopAction, { kind: "stand-down" }>,
): Readonly<{ message: string; props: Record<string, unknown> }> {
  const subject = action.pr === undefined ? "no single member" : `member '${action.pr}'`
  return Object.freeze({
    message:
      `yrd: habitant runner standing down — ${action.cycles} consecutive cycles lost to refusal ` +
      `'${action.code}' (${subject}), at or past the bound of ${action.bound}. A successor reads the same ` +
      `journal and is refused the same way; ${HABITANT_REFUSAL_LOOP_CYCLES_ENV}=0 disables this stand-down.`,
    props: Object.freeze({
      action: "resident-refusal-loop-stand-down",
      code: action.code,
      pr: action.pr,
      cycles: action.cycles,
      bound: action.bound,
    }),
  })
}

/**
 * Read the declared bound. An unparseable value is RAISED, never defaulted —
 * the same rule `habitantSourceStaleThreshold` and `habitantRssCapBytes`
 * follow: an operator who set the knob to disable a stand-down and silently got
 * the default instead would learn about it from an unexplained exit.
 */
export function habitantRefusalLoopCycles(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HABITANT_REFUSAL_LOOP_CYCLES_ENV]?.trim()
  if (raw === undefined || raw === "") return HABITANT_REFUSAL_LOOP_DEFAULT_CYCLES
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    raiseFailure(
      "configuration",
      "resident-refusal-loop-cycles-invalid",
      `yrd: ${HABITANT_REFUSAL_LOOP_CYCLES_ENV} must be a non-negative integer number of cycles (0 disables the stand-down), not '${raw}'`,
    )
  }
  return parsed
}
