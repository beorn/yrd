/**
 * The runner's place in one queue reading, shared by the page and JSON. The
 * selector may hide changes, but it never changes what the runner is doing.
 * This module has no renderer dependency so a machine reader can use the same
 * derivation as the page.
 */

import type { Row, StopFact } from "@yrd/queue-core"
import { runnerLine, type RunnerFacts, type RunnerLine } from "./watch-runner.ts"
import type { WatchRow } from "./watch-rows.ts"

export type RunnerReading = Readonly<{
  unfiltered: readonly WatchRow[]
  runner?: RunnerFacts
  stopped?: StopFact | null
}>

/**
 * The line as the rows say it: every change holding a place in it, ONCE
 * however many run rows it has. `held` is the change a check runs on right
 * now; `waiting` is every other one. The queue line and the RUNNER rail both
 * count from here, so they cannot disagree.
 */
export function lineOf(rows: readonly WatchRow[]): Readonly<{ held: Row | undefined; waiting: readonly Row[] }> {
  const changes = new Map<string, Row>()
  for (const { row } of rows) {
    if (row.position === undefined) continue
    const key = `${row.branch}@${row.head}`
    if (!changes.has(key) || row.live !== undefined) changes.set(key, row)
  }
  const inLine = [...changes.values()]
  return {
    held: inLine.find((row) => row.live !== undefined),
    waiting: inLine.filter((row) => row.live === undefined),
  }
}

/** The runner's line is read from the whole queue, never the selected rows. */
export function runnerOf(snapshot: RunnerReading, now: Date): RunnerLine {
  const { held, waiting } = lineOf(snapshot.unfiltered)
  const activeBranch = snapshot.runner?.latest?.activeStep?.branch
  const activeRow =
    held?.live === undefined && activeBranch !== undefined
      ? snapshot.unfiltered.find((item) => item.row.branch === activeBranch)?.row
      : undefined

  const heldChange =
    held?.live !== undefined
      ? {
          branch: held.branch,
          since: held.live.since,
          ...(held.subject === undefined ? {} : { subject: held.subject }),
          ...(held.submitter === undefined ? {} : { submitter: held.submitter }),
        }
      : activeRow !== undefined
        ? {
            branch: activeRow.branch,
            since: snapshot.runner?.latest?.activeStep?.start ?? now,
            ...(activeRow.subject === undefined ? {} : { subject: activeRow.subject }),
            ...(activeRow.submitter === undefined ? {} : { submitter: activeRow.submitter }),
          }
        : undefined

  return runnerLine(snapshot.runner, now, {
    ...(heldChange === undefined ? {} : { held: heldChange }),
    ...(snapshot.stopped === undefined ? {} : { stopped: snapshot.stopped }),
    waiting: waiting.length,
  })
}
