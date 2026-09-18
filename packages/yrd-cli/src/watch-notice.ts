/**
 * The notice: one line that owns what a change IS, why, and whose move it is
 * (S2.17, README 784).
 *
 * **It derives nothing.** The state is `Row.state`, which `readChange` alone
 * produces; the cause is the row's own incident/`reason`/`result`; routing is
 * `Row.next`, derived once in state.ts. Incidents carry advice, not actors. There is no
 * comparison against a state word anywhere below, and there must never be
 * one: two parallel
 * derivations of a display band is the ready-vs-queued bug that shipped twice
 * in the retired view, once at `queue-status-view.tsx ~1902` and once at
 * `~1477`, and the cure was never a better comparison — it was having only one
 * place that decides.
 *
 * So nothing here maps a state to a word. The word is the one word table's
 * (`stateWord`, watch-format.ts), read when the notice is made, so the notice
 * and the table cannot disagree about which word a state reads
 * (@i/10-yrd/24196).
 */

import { incidentLine, type Row } from "@yrd/queue-core"
import { STATE_WORDS, stateGlyph, stateWord } from "./watch-format.ts"

export type Notice = Readonly<{
  glyph: string
  /** What the change IS, in the core's own word. */
  word: string
  /** Why it is that, when the row carries a why. */
  cause?: string
  /** Incident advice, or whose move an ordinary change is and why. */
  next?: string
}>

export function watchNotice(row: Row, joinedRun = false): Notice {
  const live = row.live
  const position = row.position === undefined ? "" : ` #${String(row.position)}`
  const cause =
    row.incident !== undefined
      ? incidentLine(row.incident)
      : joinedRun && row.result !== undefined
        ? `run result: ${row.result}`
        : (row.reason ?? row.result)
  // The state's own word, the check overlay apart below; `direct` is no change and says what happened instead.
  const word = row.state === "direct" ? "went around the queue" : stateWord({ state: row.state })
  const state = joinedRun ? `change ${word}` : word
  const next =
    row.incident !== undefined
      ? row.incident.next
      : row.next === undefined
        ? undefined
        : `${row.next.owner} — ${row.next.because}`
  return {
    glyph: stateGlyph(row),
    // The overlay says what is happening RIGHT NOW; the state still says what
    // the records say, and both are on the line, because a change under a
    // check reads submitted until its checked record merges and that is an
    // answer, not a bug to paper over.
    word:
      live === undefined ? `${state}${position}` : `${state}${position}, ${STATE_WORDS.checking.word} ${live.check}`,
    ...(cause === undefined ? {} : { cause }),
    ...(next === undefined ? {} : { next }),
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
