/**
 * THE ONE WORD TABLE (@i/10-yrd/24196): what every human surface calls a
 * change's state, the duration cell's lead words, and the phrase that names
 * the table's order. The operator's nine words (v3, 2026-09-16) in legend
 * order, then `direct` apart: a commit that went around the queue is not a
 * change.
 *
 * The queue core's internal names are not words anyone reads: a change the
 * core calls `queued` reads submitted, `checked` reads pending, `withdrawn`
 * reads cancelled, and a change under a check RIGHT NOW reads checking.
 * `merging` is in the legend and on no row yet: nothing local can say a merge
 * is being written. `--json`, `CHANGE_STATES` and the record kinds keep the
 * core's names; the rename is its own change.
 *
 * Every surface reads a word from here when it draws, never a copy taken
 * earlier, so one edit here changes every surface. That is why the table is
 * not frozen, and why this module imports nothing: `yrd list --help` prints
 * the legend without loading the queue core.
 */

export type WordEntry = { word: string; means?: string; next?: string }

/** The nine states in legend order. */
export const LEGEND_STATES = [
  "draft",
  "submitted",
  "checking",
  "pending",
  "merging",
  "merged",
  "stuck",
  "failed",
  "cancelled",
] as const

/** A word a row can show: one of the nine, or `direct`, which is no change. */
export type DisplayState = (typeof LEGEND_STATES)[number] | "direct"

export const STATE_WORDS: Record<DisplayState | "waiting" | "took" | "order", WordEntry> = {
  draft: { means: "pushed to the remote, not submitted", next: "yrd submit", word: "draft" },
  submitted: { means: "in the queue, waiting for its first check", next: "the runner checks it", word: "submitted" },
  checking: { means: "the runner is testing it now", next: "pending, stuck or failed", word: "checking" },
  pending: {
    means: "checks passed; waiting in line to merge",
    next: "it merges when the line reaches it",
    word: "pending",
  },
  merging: { means: "the runner is writing main for it now", next: "merged or failed", word: "merging" },
  merged: { means: "on the queue branch; ended", next: "nothing; a revert is a new change", word: "merged" },
  stuck: {
    means: "the queue could not judge it and stopped the line (ADR-0015)",
    next: "repair and resume, merge, or cancel",
    word: "stuck",
  },
  failed: { means: "a check failed; ended", next: "a new head is a new change", word: "failed" },
  cancelled: {
    means: "taken back, or given up without a verdict; ended (yrd queue withdraw produces it)",
    next: "nothing",
    word: "cancelled",
  },
  direct: {
    means: "a commit on the target, around the queue",
    next: "nothing; said, never prevented",
    word: "direct",
  },
  // The duration cell's lead words; `checking` and `stuck` lead theirs with the state's own word.
  waiting: { word: "waiting" },
  took: { word: "took" },
  // The one order the rows are in (queue-core table.ts `list`), named on the table's header.
  order: { word: "in line order, then newest first" },
}

/** The legend's word column: the longest word and its gap. */
const WORD_COLUMN = 11

/**
 * The legend, one entry per state (`word  what it means → what happens next`),
 * then `direct` apart under "not a change". An entry longer than `width`
 * wraps at a space and hangs under its meaning.
 */
export function legendLines(width: number = Number.POSITIVE_INFINITY): readonly string[] {
  const entry = (key: DisplayState): readonly string[] => {
    const { word, means = "", next = "" } = STATE_WORDS[key]
    const rows: string[] = []
    let row = word.padEnd(WORD_COLUMN - 1)
    for (const piece of `${means} → ${next}`.split(" ")) {
      if (row.trim() !== "" && row.length + 1 + piece.length > width && row.length > WORD_COLUMN) {
        rows.push(row)
        row = " ".repeat(WORD_COLUMN - 1)
      }
      row = `${row} ${piece}`
    }
    return [...rows, row]
  }
  return [...LEGEND_STATES.flatMap(entry), "", "not a change", ...entry("direct")]
}
