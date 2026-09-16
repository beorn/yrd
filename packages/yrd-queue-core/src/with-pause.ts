/**
 * The pause ring: a queue that can be told to stop, and does — and that stops
 * itself on a change it could not judge.
 *
 * `pause.ts` is the record ref itself — the authority a person writes with
 * `yrd queue pause`, and the queue writes on a stuck. This is its use: the
 * round that reads it and stops, the merge that linearizes against it, and the
 * stuck that stops the line. Take this file and its line out of rings.ts and
 * the queue merges whatever it is given, which is what it did before a pause
 * existed; a stuck still ends its own round, but the next round runs.
 *
 * The ring holds four of the run's steps.
 *
 * `open` stops automatic rounds before any change record is written, on the
 * stop the round's own queue read DERIVED (pause.ts `lineStop`): a stuck stop
 * whose change has left the line no longer stands, and its record waits for
 * the next write to the pause ref. An explicit foreground round may process
 * admitted work under the stop it saw.
 *
 * `push` is the expensive one, and the reason a pause is more than a flag. The
 * merge's atomic push carries the pause ref forward without clearing a pause under
 * its own lease, in the SAME transaction as the target and the change
 * (`pause.ts` § pauseFence). That is what makes the read and the push one
 * ordering point with a concurrent `queue pause`: whichever lease wins
 * happened first, and no merge can slip past a pause written a moment ago. A
 * stop the round derived as lifted is replaced by a resumed record in that
 * same push, which is how a lifted stop's record is cleared.
 *
 * `end` and `stopLine` are the andon (operator 2026-09-16: "STUCK means fail
 * loud and fix - andon - stop the line - fix it"). `end` hears each stuck
 * ending as it is written; when the loop ends the round on it, `stopLine`
 * pauses the queue naming that change, with the stuck record's own subject as
 * the reason and its cures as `Next`, so the page and every refusal read them
 * from the stop itself.
 */

import { mergedBy } from "./records.ts"
import {
  pauseLine,
  QueuePaused,
  readPause,
  pauseFence,
  writePause,
  type PauseRecord,
  type PauseFence,
} from "./pause.ts"
import { changeName, pauseRef } from "./refs.ts"
import { QueueAuthorityUnreadable, type Pushed, type Ring, type Run, type Stopped } from "./run.ts"

export type PauseOptions = Readonly<{
  /** Explicit queue run may work the admitted set under the pause it observed. */
  foreground?: boolean
}>

/** Who a stop the queue put on itself says wrote it. */
export const STOPPED_BY = "yrd"

export const withPause: Ring = (steps) => {
  let admittedPause: PauseRecord | undefined
  /** This round's stuck endings, by change, as written: the stop that names one quotes it. */
  const stuckEndings = new Map<string, Readonly<{ reason: string; next?: string }>>()
  return {
    ...steps,

    open: async (run) => {
      const paused = run.lineStop
      const lifted = liftedPause(run)
      if (lifted !== undefined) recordLifted(run, lifted)
      if (paused === undefined) return steps.open(run)
      recordPause(run, paused)
      if (run.options.foreground === true) {
        admittedPause = paused
        return steps.open(run)
      }
      return stopped(paused)
    },

    end: async (run, entry, kind, ended) => {
      const outcome = await steps.end(run, entry, kind, ended)
      if (kind === "stuck" && outcome === "stuck") {
        stuckEndings.set(changeName(entry.change), {
          reason: ended.subject,
          ...(ended.incident === undefined ? {} : { next: ended.incident.next }),
        })
      }
      return outcome
    },

    stopLine: async (run, entry) => {
      await steps.stopLine(run, entry)
      const change = { branch: entry.change.branch, head: entry.change.head }
      const ending = stuckEndings.get(changeName(change))
      let record: PauseRecord
      try {
        record = await writePause(
          run.git,
          run.options.target.remote,
          run.options.target.branch,
          {
            by: STOPPED_BY,
            cause: "stuck",
            change,
            kind: "paused",
            reason: ending?.reason ?? `${changeName(change)} ended the round stuck`,
            ...(ending?.next === undefined ? {} : { next: ending.next }),
          },
          liftedPause(run),
        )
      } catch (error) {
        // A stop already stands — the pause that admitted this foreground
        // round, or one written since — and the line stays stopped on it as
        // it is. Unreadable authority is loud: a stuck that cannot stop the
        // line must not look like one that did.
        if (error instanceof QueuePaused) {
          recordPause(run, error.pause)
          return stopped(error.pause)
        }
        throw new QueueAuthorityUnreadable(`${run.options.target.remote} ${pauseRef(run.options.target.branch)}`, error)
      }
      recordPause(run, record)
      return stopped(record)
    },

    push: async (run, entry, plan) => {
      // A newly active pause is a normal refusal, including in a foreground
      // round admitted under an older pause. Unreadable authority is loud:
      // a queue that cannot tell whether it is paused merges nothing.
      let fence: PauseFence
      const ref = pauseRef(run.options.target.branch)
      const lifted = liftedPause(run)
      try {
        fence = await pauseFence(
          run.git,
          run.options.target.remote,
          run.options.target.branch,
          {
            by: mergedBy(run.name, run.log.id),
            reason: `merge ${changeName(entry.change)}`,
          },
          admittedPause,
          lifted,
        )
      } catch (error) {
        if (error instanceof QueuePaused) return stop(run, error.pause, error)
        throw new QueueAuthorityUnreadable(`${run.options.target.remote} ${ref}`, error)
      }
      const pushed = await steps.push(run, entry, {
        leases: [...plan.leases, [ref, fence.expected]],
        updates: [...plan.updates, [fence.sha, ref]],
      })
      if (pushed.merged) return pushed
      // A pause writer can win after our reads too, and then the atomic leases
      // reject every update. The remote — never Git's prose — says whether that
      // is what happened: a pause now active stops the round however else the
      // push was rejected, and an authority that merely moved leaves the change
      // checked rather than raising.
      let now: PauseRecord | undefined
      try {
        now = await readPause(run.git, run.options.target.remote, run.options.target.branch)
      } catch (error) {
        throw new QueueAuthorityUnreadable(`${run.options.target.remote} ${ref}`, error)
      }
      if (now?.kind === "paused" && now.sha !== admittedPause?.sha && now.sha !== lifted?.sha) {
        return stop(run, now, pushed.error)
      }
      const saw = now?.sha ?? "absent"
      if (pushed.reason !== undefined) return pushed.saw === undefined ? { ...pushed, saw } : pushed
      if (now?.sha !== fence.previous?.sha) return { error: pushed.error, merged: false, reason: "pause-moved", saw }
      return pushed
    },
  }
}

/** The paused record this round's reading derived as no longer standing, if its tip is one. */
function liftedPause(run: Run): PauseRecord | undefined {
  return run.pause?.kind === "paused" && run.lineStop === undefined ? run.pause : undefined
}

/** Say the round stopped for this pause, and answer the push with it. */
function stop(run: Run, pause: PauseRecord, error: unknown): Pushed {
  recordPause(run, pause)
  run.stop(stopped(pause))
  return { error, merged: false, reason: "paused" }
}

/** How the outcome carries a pause: the ring's name, its one line, and the record itself. */
function stopped(pause: PauseRecord): Stopped {
  return { ring: "pause", says: pauseLine(pause), what: pause }
}

/** Record one active pause in the run's structured log. */
function recordPause(run: Run, pause: PauseRecord): void {
  run.log.write({
    by: pause.by,
    cause: pause.cause,
    kind: "pause",
    reason: pause.reason,
    since: pause.at.toISOString(),
    state: pause.kind,
    ...(pause.change === undefined ? {} : { change: changeName(pause.change) }),
  })
}

/** Record a stop that no longer stands: its change left the line, and nothing was resumed by hand. */
function recordLifted(run: Run, pause: PauseRecord): void {
  run.log.write({
    by: pause.by,
    cause: pause.cause,
    kind: "pause",
    reason: pause.reason,
    since: pause.at.toISOString(),
    state: "lifted",
    ...(pause.change === undefined ? {} : { change: changeName(pause.change) }),
  })
}

/** The stop an outcome says the round stopped for, when the pause ring said it. */
export function pauseStop(stopped: Stopped | undefined): PauseRecord | undefined {
  return stopped?.ring === "pause" ? (stopped.what as PauseRecord) : undefined
}
