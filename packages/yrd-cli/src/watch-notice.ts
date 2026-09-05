/**
 * The notice: one line that owns what a change IS, why, and whose move it is
 * (S2.17, README 784).
 *
 * **It derives nothing.** The state is `Row.state`, which `readChange` alone
 * produces; the cause is the row's own `reason`/`result`; the next owner is
 * `Row.next`, derived once in state.ts beside the state it reads. There is no
 * comparison against a state word anywhere below, and there must never be
 * one: two parallel
 * derivations of a display band is the ready-vs-queued bug that shipped twice
 * in the retired view, once at `queue-status-view.tsx ~1902` and once at
 * `~1477`, and the cure was never a better comparison — it was having only one
 * place that decides.
 *
 * So every mapping here is a TABLE keyed by the state the core handed over. A
 * new state added to the core is a compile error here, which is the point.
 */

import { clocks, type Row } from "@yrd/queue-core"
import { mediaDuration, stateGlyph } from "./watch-format.ts"

export type Notice = Readonly<{
  glyph: string
  /** What the change IS, in the core's own word. */
  word: string
  /** Why it is that, when the row carries a why. */
  cause?: string
  /** Whose move it is, and why it is theirs. */
  next?: string
}>

/**
 * How each state reads in a notice. The core's five words plus `direct` stand
 * as they are — renaming a state at the edge is how two surfaces come to
 * disagree about one change — and only the parenthetical is ours.
 */
const WORD: Readonly<Record<Row["state"], string>> = {
  checked: "checked",
  direct: "went around the queue",
  failed: "failed",
  merged: "merged",
  queued: "queued",
  stuck: "stuck",
}

export function watchNotice(row: Row, joinedRun = false): Notice {
  const live = row.live
  const position = row.position === undefined ? "" : ` #${String(row.position)}`
  const cause = joinedRun && row.result !== undefined ? `run result: ${row.result}` : (row.reason ?? row.result)
  const state = joinedRun ? `change ${WORD[row.state]}` : WORD[row.state]
  return {
    glyph: stateGlyph(row),
    // The overlay says what is happening RIGHT NOW; the state still says what
    // the records say, and both are on the line, because a change under a
    // check reads `queued` until its checked record lands and that is an
    // answer, not a bug to paper over.
    word: live === undefined ? `${state}${position}` : `${state}${position}, checking ${live.check}`,
    ...(cause === undefined ? {} : { cause }),
    ...(row.next === undefined ? {} : { next: `${row.next.owner} — ${row.next.because}` }),
  }
}

/** The notice as one line: state, then cause, then whose move it is. */
export function noticeLine(row: Row, joinedRun = false): string {
  const notice = watchNotice(row, joinedRun)
  return [
    `${notice.glyph} ${notice.word}`,
    notice.cause === undefined ? undefined : notice.cause,
    notice.next === undefined ? undefined : `next: ${notice.next}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("  ·  ")
}

/**
 * The clocks line (watch-redesign item 1, S2.16): `Age · Runtime · Wait time`,
 * in the operator's own order, separator and duration form (`34:23`, not `34m`).
 *
 * A clock nothing measured is LEFT OUT, never printed as zero: off the queue's
 * own machine there is no run journal, so a queued change has no instant
 * checking began and therefore no wait and no runtime. An empty line is the
 * honest answer and the caller says why (the journal reading carries the
 * sentence).
 */
export function clocksLine(row: Row, now: Date = new Date()): string {
  const measured = clocks(row, now)
  return [
    measured.ageMs === undefined ? undefined : `Age ${mediaDuration(measured.ageMs)}`,
    measured.runtimeMs === undefined ? undefined : `Runtime ${mediaDuration(measured.runtimeMs)}`,
    measured.waitMs === undefined ? undefined : `Wait time ${mediaDuration(measured.waitMs)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ")
}
