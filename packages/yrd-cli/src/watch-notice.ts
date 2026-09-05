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
 * So every mapping here is a TABLE keyed by the state the core handed over. A
 * new state added to the core is a compile error here, which is the point.
 */

import { clocks, incidentLine, type Row } from "@yrd/queue-core"

export type Notice = Readonly<{
  glyph: string
  /** What the change IS, in the core's own word. */
  word: string
  /** Why it is that, when the row carries a why. */
  cause?: string
  /** Incident advice, or whose move an ordinary change is and why. */
  next?: string
}>

/** The one glyph per state, and the working glyph a live check overlays on any of them. */
const GLYPH: Readonly<Record<Row["state"], string>> = {
  checked: "◉",
  direct: "→",
  failed: "×",
  merged: "✓",
  queued: "○",
  stuck: "◌",
}

const RUNNING = "◉"

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

export function watchNotice(row: Row): Notice {
  const live = row.live
  const position = row.position === undefined ? "" : ` #${String(row.position)}`
  const cause = row.incident === undefined ? (row.reason ?? row.result) : incidentLine(row.incident)
  const next =
    row.incident !== undefined
      ? row.incident.next
      : row.next === undefined
        ? undefined
        : `${row.next.owner} — ${row.next.because}`
  return {
    glyph: live === undefined ? GLYPH[row.state] : RUNNING,
    // The overlay says what is happening RIGHT NOW; the state still says what
    // the records say, and both are on the line, because a change under a
    // check reads `queued` until its checked record lands and that is an
    // answer, not a bug to paper over.
    word:
      live === undefined ? `${WORD[row.state]}${position}` : `${WORD[row.state]}${position}, checking ${live.check}`,
    ...(cause === undefined ? {} : { cause }),
    ...(next === undefined ? {} : { next }),
  }
}

/** The notice as one line: state, cause, and any next step. */
export function noticeLine(row: Row): string {
  const notice = watchNotice(row)
  return [
    `${notice.glyph} ${notice.word}`,
    notice.cause === undefined ? undefined : notice.cause,
    notice.next === undefined ? undefined : `next: ${notice.next}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("  ·  ")
}

/**
 * The clocks line (watch-redesign item 1, S2.16): `Age · Runtime · Wait`, in
 * the operator's own order and separator.
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
    measured.ageMs === undefined ? undefined : `Age ${duration(measured.ageMs)}`,
    measured.runtimeMs === undefined ? undefined : `Runtime ${duration(measured.runtimeMs)}`,
    measured.waitMs === undefined ? undefined : `Wait ${duration(measured.waitMs)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ")
}

/**
 * Coarse human duration, largest unit — the retired watch timeline's own cell
 * format, kept so a reader's eye does not have to relearn it.
 */
export function duration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds)
  if (ms < 1_000) return `${String(Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  if (ms < 3_600_000) return `${String(Math.floor(ms / 60_000))}m`
  if (ms < 86_400_000) return `${String(Math.floor(ms / 3_600_000))}h`
  return `${String(Math.floor(ms / 86_400_000))}d`
}
