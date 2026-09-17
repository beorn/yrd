/**
 * THE ONE WORD TABLE (@i/10-yrd/24196): what every human surface calls a
 * state, the duration cell's lead words, and the colour each word wears. The
 * operator's nine change words (v3, 2026-09-16) in legend order, then `direct`
 * apart — a commit that went around the queue is not a change — then the
 * RUNNER's own, which share the change words' column and so must share their
 * table.
 *
 * The queue core's internal names are not words anyone reads: a change the
 * core calls `queued` reads submitted, `checked` reads pending, `withdrawn`
 * reads cancelled, and a change under a check RIGHT NOW reads checking.
 * `--json`, `CHANGE_STATES` and the record kinds keep the core's names; the
 * rename is its own change.
 *
 * The COLOUR is here for the same reason the word is: the flow page draws the
 * runner as a row in the table's own STATUS column, and a second colour table
 * beside a second vocabulary is how that column came to say `processing` in
 * one place and `checking` in another. One word, one colour, one table.
 *
 * Every surface reads a word from here when it draws, never a copy taken
 * earlier, so one edit here changes every surface. That is why the table is
 * not frozen, and why this module imports nothing: `yrd list --help` prints
 * the legend without loading the queue core.
 */

export type WordEntry = {
  word: string
  /** The severity colour the word wears wherever it is drawn: open is accent, working is info, done is success, fail is error, stuck is warning. */
  color: string
  means?: string
  next?: string
}

/** The nine change states in legend order. */
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

/**
 * The RUNNER's own states, in legend order. `checking` and `merging` are a
 * change's words too, and deliberately so: the flow page draws the runner as a
 * row in the same STATUS column as every change, so the column reads one
 * vocabulary. `processing` — the one word the retired RUNNER box showed for
 * both phases — retires here, because a phase earns a word when it takes time
 * and can fail, and writing the target is not running checks.
 *
 * `silent` and `stopped` are SIGNALS, derived where the page is drawn from the
 * absence or the age of a beat, never stored: writing either into a record
 * would make a derived fact durable and let it go stale (@i/10-yrd/24523).
 *
 * `stuck` and `paused` are the line's own stop, which is a git fact and so the
 * one thing this row can still say off the queue's machine. `stopped` is
 * derived where the page is drawn, from a journal that has gone quiet.
 *
 * `merging` and `silent` are in the legend and on no row yet (@cto, relayed by
 * @chief cf4677f8): nothing a reading can see locally says a merge is being
 * written, and `silent` is read from the runner's own published ref, which
 * does not exist until S2. Until then the row reads `?` rather than a guess.
 */
export const RUNNER_STATES = [
  "idle",
  "checking",
  "merging",
  "stuck",
  "paused",
  "stopped",
  "silent",
  "unstarted",
  "unpublished",
] as const

/** A word a change's row can show: one of the nine, or `direct`, which is no change. */
export type DisplayState = (typeof LEGEND_STATES)[number] | "direct"

/** A word the runner's row can show. */
export type RunnerState = (typeof RUNNER_STATES)[number]

export const STATE_WORDS: Record<DisplayState | RunnerState | "waiting" | "took" | "runner", WordEntry> = {
  draft: { color: "$fg-muted", means: "pushed to the remote, not submitted", next: "yrd submit", word: "draft" },
  submitted: {
    color: "$fg-accent",
    means: "in the queue, waiting for its first check",
    next: "the runner checks it",
    word: "submitted",
  },
  checking: {
    color: "$fg-info",
    means: "the runner is testing it now",
    next: "pending, stuck or failed",
    word: "checking",
  },
  pending: {
    color: "$fg-warning",
    means: "checks passed; waiting in line to merge",
    next: "it merges when the line reaches it",
    word: "pending",
  },
  merging: {
    color: "$fg-info",
    means: "the runner is writing main for it now",
    next: "merged or failed",
    word: "merging",
  },
  merged: {
    color: "$fg-success",
    means: "on the queue branch; ended",
    next: "nothing; a revert is a new change",
    word: "merged",
  },
  stuck: {
    color: "$fg-warning",
    means: "the queue could not judge it and stopped the line (ADR-0015)",
    next: "repair and resume, merge, or cancel",
    word: "stuck",
  },
  failed: { color: "$fg-error", means: "a check failed; ended", next: "a new head is a new change", word: "failed" },
  cancelled: {
    color: "$fg-muted",
    means: "taken back, or given up without a verdict; ended (yrd queue withdraw produces it)",
    next: "nothing",
    word: "cancelled",
  },
  direct: {
    color: "$fg-muted",
    means: "a commit on the target, around the queue",
    next: "nothing; said, never prevented",
    word: "direct",
  },
  // The runner's own, drawn on its row in the same column.
  idle: {
    color: "$fg-muted",
    means: "the runner holds nothing; the line is empty or it is between rounds",
    next: "it takes the front of the line",
    word: "idle",
  },
  stopped: {
    color: "$fg-error",
    means: "no run has written here for ten minutes: nothing is running on this machine",
    next: "yrd queue up",
    word: "stopped",
  },
  paused: {
    color: "$fg-warning",
    means: "an operator stopped the line",
    next: "yrd queue resume",
    word: "paused",
  },
  silent: {
    color: "$fg-error",
    means: "the runner's own published status has no recent beat",
    next: "read the service",
    word: "silent",
  },
  unstarted: {
    color: "$fg-error",
    means: "the newest run died in its Git preamble, before it read its queue",
    next: "its journal's last Git row names the call that failed",
    word: "unstarted",
  },
  unpublished: {
    color: "$fg-muted",
    means: "the runner's status is not published, and this reading is not on its machine",
    next: "read it on the queue's own machine",
    word: "?",
  },
  // The duration cell's lead words; `checking` and `stuck` lead theirs with the state's own word.
  waiting: { color: "$fg-muted", word: "waiting" },
  took: { color: "$fg-muted", word: "took" },
  // What the runner's row is called, in the cell that says what it holds.
  runner: { color: "$fg-muted", word: "RUNNER" },
}

/** The legend's word column: the longest word and its gap. */
const WORD_COLUMN = 13

/**
 * The legend: the change's words (`word  what it means → what happens next`),
 * then `direct` apart under "not a change", then the runner's own under "the
 * runner". An entry longer than `width` wraps at a space and hangs under its
 * meaning.
 */
export function legendLines(width: number = Number.POSITIVE_INFINITY): readonly string[] {
  const entry = (key: DisplayState | RunnerState): readonly string[] => {
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
  // `checking` and `merging` are listed once, with the changes: the runner's
  // row and a change's row mean the same thing by them.
  const runnerOnly = RUNNER_STATES.filter((key): key is RunnerState => key !== "checking" && key !== "merging")
  return [
    ...LEGEND_STATES.flatMap(entry),
    "",
    "not a change",
    ...entry("direct"),
    "",
    "the runner, which says checking and merging as a change does",
    ...runnerOnly.flatMap(entry),
  ]
}
