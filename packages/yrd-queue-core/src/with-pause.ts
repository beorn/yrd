/**
 * The pause ring: a queue that can be told to stop, and does.
 *
 * `pause.ts` is the record ref itself — the authority a person writes with
 * `yrd queue pause`. This is its use: the round that reads it and stops, and the
 * merge that linearizes against it. Take this file and its line out of rings.ts
 * and the queue merges whatever it is given, which is what it did before a
 * pause existed.
 *
 * The ring holds two of the run's steps.
 *
 * `open` is the cheap answer: an active pause at the top of a round stops it
 * there, before any change record is written, so a paused round leaves every
 * change exactly as it found it.
 *
 * `push` is the expensive one, and the reason a pause is more than a flag. The
 * merge's atomic push carries the pause ref forward as a resumed record under
 * its own lease, in the SAME transaction as the target and the change
 * (`pause.ts` § resumedFence). That is what makes the read and the push one
 * ordering point with a concurrent `queue pause`: whichever lease wins
 * happened first, and no merge can slip past a pause written a moment ago.
 */

import { mergedBy } from "./records.ts"
import {
  activePause,
  PAUSE_REF,
  pauseLine,
  QueuePaused,
  readPause,
  resumedFence,
  type PauseRecord,
  type ResumedFence,
} from "./pause.ts"
import { changeName } from "./refs.ts"
import { QueueAuthorityUnreadable, type Pushed, type Ring, type Run, type Stopped } from "./run.ts"

export const withPause: Ring = (steps) => ({
  ...steps,

  open: async (run) => {
    const paused = await activePause(run.git, run.options.target.remote)
    if (paused === undefined) return steps.open(run)
    recordPause(run, paused)
    return stopped(paused)
  },

  push: async (run, entry, plan) => {
    // Preparing the fence reads the pause; an active one is a normal refusal and
    // stops the round here, with nothing pushed. Unreadable authority is loud:
    // a queue that cannot tell whether it is paused merges nothing.
    let fence: ResumedFence
    try {
      fence = await resumedFence(run.git, run.options.target.remote, {
        by: mergedBy(run.name, run.log.id),
        reason: `merge ${changeName(entry.change)}`,
      })
    } catch (error) {
      if (error instanceof QueuePaused) return stop(run, error.pause, error)
      throw new QueueAuthorityUnreadable(`${run.options.target.remote} ${PAUSE_REF}`, error)
    }
    const pushed = await steps.push(run, entry, {
      leases: [...plan.leases, [PAUSE_REF, fence.expected]],
      updates: [...plan.updates, [fence.sha, PAUSE_REF]],
    })
    if (pushed.landed) return pushed
    // A pause writer can win after our reads too, and then the atomic leases
    // reject every update. The remote — never Git's prose — says whether that
    // is what happened: a pause now active stops the round however else the
    // push was rejected, and an authority that merely moved leaves the change
    // checked rather than raising.
    let now: PauseRecord | undefined
    try {
      now = await readPause(run.git, run.options.target.remote)
    } catch (error) {
      throw new QueueAuthorityUnreadable(`${run.options.target.remote} ${PAUSE_REF}`, error)
    }
    if (now?.kind === "paused") return stop(run, now, pushed.error)
    const saw = now?.sha ?? "absent"
    if (pushed.reason !== undefined) return pushed.saw === undefined ? { ...pushed, saw } : pushed
    if (now?.sha !== fence.previous?.sha) return { error: pushed.error, landed: false, reason: "pause-moved", saw }
    return pushed
  },
})

/** Say the round stopped for this pause, and answer the push with it. */
function stop(run: Run, pause: PauseRecord, error: unknown): Pushed {
  recordPause(run, pause)
  run.stop(stopped(pause))
  return { error, landed: false, reason: "paused" }
}

/** How the outcome carries a pause: the ring's name, its one line, and the record itself. */
function stopped(pause: PauseRecord): Stopped {
  return { ring: "pause", says: pauseLine(pause), what: pause }
}

/** Record one active pause in the run's structured log. */
function recordPause(run: Run, pause: PauseRecord): void {
  run.log.write({
    by: pause.by,
    kind: "pause",
    reason: pause.reason,
    since: pause.at.toISOString(),
    state: pause.kind,
  })
}
