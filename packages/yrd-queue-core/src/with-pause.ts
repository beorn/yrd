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
 * `open` stops automatic rounds before any change record is written. An
 * explicit foreground round may process admitted work under the pause it saw.
 *
 * `push` is the expensive one, and the reason a pause is more than a flag. The
 * merge's atomic push carries the pause ref forward without clearing a pause under
 * its own lease, in the SAME transaction as the target and the change
 * (`pause.ts` § pauseFence). That is what makes the read and the push one
 * ordering point with a concurrent `queue pause`: whichever lease wins
 * happened first, and no merge can slip past a pause written a moment ago.
 */

import { ABSENT, mergedBy } from "./records.ts"
import { pauseLine, QueuePaused, readPause, pauseFence, type PauseRecord, type PauseFence } from "./pause.ts"
import { changeName, pauseRef } from "./refs.ts"
import { QueueAuthorityUnreadable, type Pushed, type Ring, type Run, type Stopped } from "./run.ts"

export type PauseOptions = Readonly<{
  /** Explicit queue run may work the admitted set under the pause it observed. */
  foreground?: boolean
}>

export const withPause: Ring = (steps) => {
  let admittedPause: PauseRecord | undefined
  return {
    ...steps,

    open: async (run) => {
      const paused = run.pause?.kind === "paused" ? run.pause : undefined
      if (paused === undefined) return steps.open(run)
      recordPause(run, paused)
      if (run.options.foreground === true) {
        admittedPause = paused
        return steps.open(run)
      }
      return stopped(paused)
    },

    push: async (run, entry, plan) => {
      // A newly active pause is a normal refusal, including in a foreground
      // round admitted under an older pause. Unreadable authority is loud:
      // a queue that cannot tell whether it is paused merges nothing.
      let fence: PauseFence
      const ref = pauseRef(run.options.target.branch)
      const remote = plan.updates.find((row) => row.repository === ".")?.remote
      if (remote === undefined) throw new Error("landing plan has no root remote for its pause fence")
      try {
        fence = await pauseFence(
          run.git,
          remote,
          run.options.target.branch,
          {
            by: mergedBy(run.name, run.log.id),
            reason: `merge ${changeName(entry.change)}`,
          },
          admittedPause,
        )
      } catch (error) {
        if (error instanceof QueuePaused) return stop(run, error.pause, error)
        throw new QueueAuthorityUnreadable(`${remote} ${ref}`, error)
      }
      const pushed = await steps.push(run, entry, {
        ...plan,
        updates: [
          ...plan.updates,
          {
            repository: ".",
            remote,
            source: fence.sha,
            destination: ref,
            expectedDestination:
              fence.expected === ABSENT ? { state: "missing" } : { state: "oid", oid: fence.expected },
          },
        ],
      })
      if (pushed.landed) return pushed
      // A pause writer can win after our reads too, and then the atomic leases
      // reject every update. The remote — never Git's prose — says whether that
      // is what happened: a pause now active stops the round however else the
      // push was rejected, and an authority that merely moved leaves the change
      // checked rather than raising.
      let now: PauseRecord | undefined
      try {
        now = await readPause(run.git, remote, run.options.target.branch)
      } catch (error) {
        throw new QueueAuthorityUnreadable(`${remote} ${ref}`, error)
      }
      if (now?.kind === "paused" && now.sha !== admittedPause?.sha) return stop(run, now, pushed.error)
      const saw = now?.sha ?? "absent"
      if (pushed.reason !== undefined) return pushed.saw === undefined ? { ...pushed, saw } : pushed
      if (now?.sha !== fence.previous?.sha) return { error: pushed.error, landed: false, reason: "pause-moved", saw }
      return pushed
    },
  }
}

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
