/**
 * The run as the pane draws it (watch-redesign items 1, 37m, 38, 39): the
 * status box IS the run, the RUN column names it, and one step line per
 * check hangs under the headline.
 *
 * A LENS, never a copy. `WatchRun` holds the core's own `Row` and the
 * `checksOf()` array and restates nothing: state, position, clocks and the
 * merge commit are read through `row` at render time, so there is no second
 * place that could disagree with `readChange` (the ready-vs-queued bug the
 * spec opens with). The one thing added is the `kind` discriminant the
 * operator asked for (37m): a run's kind selects its affordances, and a mock
 * third kind renders through the same status box and step lines with no
 * display code touched.
 *
 * Pure: no React, no I/O.
 */

import type { CheckView, Row } from "@yrd/queue-core"
import { clock, mediaDuration, runShortName } from "./watch-format.ts"
import { watchNotice } from "./watch-notice.ts"

/** The kinds a run can be. `queue` is the only one built; the union exists so the next one is a data change. */
export type WatchRunKind = "queue" | "deployment" | "workflow"

/** One step of a run, whatever the run's kind: the shape `RunStepLines` and the RUN column read, and nothing more. */
export type WatchStep = Readonly<{
  name: string
  state: CheckView["state"]
  /** How long it took, or has taken so far when it is running. */
  ms?: number
  /** For a failed step, what to do about it — on the step's own line (item 39). */
  remedy?: string
  /** The real log path, when there is one. */
  log?: string
}>

export type WatchRun = Readonly<{
  kind: WatchRunKind
  /** The run's own id; absent for a change no run has touched yet (a pre-run row). */
  id?: string
  /** The queue's name as the RUN cell and the border title spell it (pre-M8: the target's branch). */
  label: string
  /** The core's row, read through — never restated. */
  row: Row
  steps: readonly WatchStep[]
}>

/** The steps a queue run has: the declared checks in declaration order, each as `checksOf` judged it. */
export function stepsOf(checks: readonly CheckView[], row: Pick<Row, "next">): readonly WatchStep[] {
  return checks.map((check) => ({
    name: check.name,
    state: check.state,
    ...(check.result?.ms === undefined ? {} : { ms: check.result.ms }),
    ...(check.log === undefined ? {} : { log: check.log }),
    // The remedy rides the step that decided the result, in the words the
    // core already chose for whose move it is.
    ...(check.state === "failed" && row.next !== undefined
      ? { remedy: `${row.next.owner} — ${row.next.because}` }
      : {}),
  }))
}

/** The run a row is about, as the pane draws it. */
export function runOf(
  row: Row,
  label: string,
  checks: readonly CheckView[],
  runId: string | undefined = row.run,
): WatchRun {
  return {
    kind: "queue",
    ...(runId === undefined ? {} : { id: runId }),
    label,
    row,
    steps: stepsOf(checks, row),
  }
}

/** The border title (item 1): `RUN main#000406`; a pre-run row has no run to name and gets no title. */
export function runTitle(run: Pick<WatchRun, "id" | "label">): string | undefined {
  return run.id === undefined ? undefined : `RUN ${runShortName(run.label, run.id)}`
}

/**
 * The headline (item 1's `✓ passed, merged`): the notice's own word for the
 * state, and the reason a failed or stuck run carries, in one line. A merged
 * change whose result was a pass reads `passed, merged`, the operator's own
 * sample; nothing here decides a state — `watchNotice` reads it off the row.
 */
export function headlineOf(row: Row, joinedRun = false): string {
  const notice = watchNotice(row, joinedRun)
  // A merged change whose run passed is the operator's own sample, joined or
  // not: the box IS the run, so the `change merged` qualifier is kept only
  // where the run's own result disagrees with the change's state.
  if (row.state === "merged" && row.result?.startsWith("pass") === true) return "passed, merged"
  if (joinedRun && notice.cause !== undefined) return `${notice.word}, ${notice.cause}`
  if (
    (row.state === "failed" || row.state === "stuck") &&
    row.reason !== undefined &&
    !notice.word.includes(row.reason)
  ) {
    return `${notice.word} ${row.reason}`
  }
  return notice.word
}

/**
 * The explanation line under the headline (item 1's `Integrated as b234234
 * at 14:15:31`, in the ruled word): what the run's ending means, or what
 * happens next while it is open. One sentence, from the core's own facts.
 */
export function explanationLine(row: Row): string | undefined {
  if (row.state === "merged") {
    if (row.merge === undefined) {
      // Read merged from ancestry alone: the head is on the queue branch and
      // no merged record names the merge commit, a merge the queue did not make.
      return "Merged: the head is on the queue branch, and no merged record names the merge commit."
    }
    const at = row.endedAt === undefined ? "" : ` at ${clock(row.endedAt, { seconds: true })}`
    return `Merged as ${row.merge.slice(0, 12)}${at}.`
  }
  if (row.state === "direct") return row.reason
  if (row.next === undefined) return undefined
  return `${capitalize(row.next.because)}; ${row.next.owner} acts next.`
}

/**
 * The timing rows (item 1, and the retired box's own second row): the clocks
 * as absolute times, then the three metrics in the operator's order and
 * separator. A clock nothing measured is left out, never printed as zero.
 */
export function timingRows(
  row: Row,
  measured: Readonly<{ ageMs?: number; runtimeMs?: number; waitMs?: number }>,
): readonly string[] {
  const clocks = [
    row.since === undefined ? undefined : `Submitted ${clock(row.since, { seconds: true })}`,
    row.startedAt === undefined ? undefined : `Started ${clock(row.startedAt, { seconds: true })}`,
    row.endedAt === undefined ? undefined : `Completed ${clock(row.endedAt, { seconds: true })}`,
  ].filter((part): part is string => part !== undefined)
  const metrics = [
    measured.ageMs === undefined ? undefined : `Age ${mediaDuration(measured.ageMs)}`,
    measured.runtimeMs === undefined ? undefined : `Runtime ${mediaDuration(measured.runtimeMs)}`,
    measured.waitMs === undefined ? undefined : `Wait time ${mediaDuration(measured.waitMs)}`,
  ].filter((part): part is string => part !== undefined)
  return [
    clocks.length === 0 ? undefined : clocks.join(", "),
    metrics.length === 0 ? undefined : metrics.join(" · "),
  ].filter((part): part is string => part !== undefined)
}

function capitalize(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}
