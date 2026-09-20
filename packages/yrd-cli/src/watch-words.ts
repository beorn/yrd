/**
 * THE ONE WORD TABLE (@i/10-yrd/24196): what every human surface calls a
 * state, the duration cell's lead words, and the colour each word wears. The
 * operator's nine change words (v3, 2026-09-16) in legend order, then `direct`
 * apart — a commit that went around the queue is not a change — then the
 * RUNNER's own, which share the change words' column and so must share their
 * table.
 *
 * The queue core's internal names are not words anyone reads: a change the
 * core calls `queued` reads ready (S4; `submitted` is retired on the page),
 * `checked` reads pending, `withdrawn` reads cancelled, and a change under a
 * check RIGHT NOW reads checking. `--json`, `CHANGE_STATES` and the record
 * kinds keep the core's names; the full vocabulary cut is 24908.
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
  "deferred",
  "stuck",
  "failed",
  "cancelled",
] as const

/**
 * THE RUNNER'S EIGHT STATES, in legend order (@cto, relayed by @chief). Four of
 * them — `verifying`, `checking`, `merging`, `stuck` — are a change's words
 * too, and deliberately so: the flow page draws the runner as a row in the same
 * STATUS column as every change, so the column reads one vocabulary and no word
 * is minted twice for one fact. When the runner is checking, the change it
 * holds is checking; that overlap IS the design.
 *
 * `processing` retires here. It named the checking phase and the merging phase
 * with one word, and a phase earns a word when it takes time and can fail:
 * running the project's own checks and writing the target are two such phases,
 * and `verifying` (git machinery) is a third.
 */
export const RUNNER_STATES = [
  "idle",
  "verifying",
  "provisioning",
  "checking",
  "merging",
  "deprovisioning",
  "stuck",
  "paused",
] as const

/**
 * The two SIGNALS, plus the unpublished case. A signal is derived where the
 * page is drawn and stored NOWHERE — never a record kind, never a field:
 * writing one down would make a derived fact durable and let it go stale
 * (@i/10-yrd/24523).
 *
 * `silent` means the runner's own beat is overdue, read from the status it
 * publishes at `refs/yrd/<queue>/runner`. **S1 publishes no such ref, so S1
 * never prints `silent`** — and it is NOT derived from a run journal's mtime
 * instead, which is ruled out: that reading called a healthy queue between
 * rounds dead and a dead queue alive by turns. What S1 loses by not having it
 * is narrower than it looks and is named rather than hidden: a runner whose
 * event loop is held publishes nothing at either place, and `stopped` below
 * catches it from the health document; what waits for S2 is a beat published
 * where a clone can read it, so this page says the same word off the queue's
 * machine as on it. The incident that makes that matter is @i/10-yrd/24486 —
 * three rows sat queued with no live check while the service was down, and a
 * fourth seat submitted into it.
 *
 * `stopped` means no runner process, and S1 DOES say it: the service restates
 * its own health document on a heartbeat that keeps firing during a check, so
 * a document past the deadline its writer declared — or one naming a writer
 * that does not answer — is the loop reporting its own liveness. That is a
 * reading, not an inference from silence, which is why it is said here and
 * `silent` is not.
 */
export const RUNNER_SIGNALS = ["silent", "stopped", "unpublished"] as const

/**
 * The runner words a reading can actually produce today, on the queue's own
 * machine or off it. The rest are defined so that S2 FILLS this table rather
 * than editing it, and {@link legendLines} says which is which rather than
 * promising a word no reading can reach.
 */
export const RUNNER_STATES_SAID = ["idle", "checking", "stopped", "stuck", "paused", "unpublished"] as const

/** A word a change's row can show: one of the nine, or `direct`, which is no change. */
export type DisplayState = (typeof LEGEND_STATES)[number] | "direct"

/** A word the runner's row can show: one of the eight, a signal, or the unpublished `?`. */
export type RunnerState = (typeof RUNNER_STATES)[number] | (typeof RUNNER_SIGNALS)[number]

export const STATE_WORDS: Record<DisplayState | RunnerState | "waiting" | "took" | "runner", WordEntry> = {
  draft: { color: "$fg-muted", means: "pushed to the remote, not submitted", next: "yrd submit", word: "draft" },
  submitted: {
    color: "$fg-warning",
    means: "in the queue, waiting for its first check",
    next: "the runner checks it",
    word: "ready",
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
  deferred: {
    color: "$fg-accent",
    means: "checks exceeded the normal bound; waits for the long check",
    next: "runs in the long tier",
    word: "deferred",
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
  verifying: {
    color: "$fg-info",
    means: "the runner is settling the change's git state, before any check runs",
    next: "provisioning, or stuck",
    word: "verifying",
  },
  provisioning: {
    color: "$fg-info",
    means: "the runner is preparing the worktree the checks will run in",
    next: "checking",
    word: "provisioning",
  },
  deprovisioning: {
    color: "$fg-info",
    means: "the runner is clearing the worktree the checks ran in",
    next: "idle",
    word: "deprovisioning",
  },
  idle: {
    color: "$fg-muted",
    means: "the runner holds nothing; the line is empty or it is between rounds",
    next: "it takes the front of the line",
    word: "idle",
  },
  stopped: {
    color: "$fg-error",
    means: "no runner process: the service's own health document is overdue, or its writer is gone",
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
    means: "the runner's own published beat is overdue",
    next: "read the service",
    word: "silent",
  },
  unpublished: {
    color: "$fg-muted",
    means: "no runner status published at origin",
    next: "read it on the queue's own machine",
    word: "?",
  },
  // The duration cell's lead words; `checking` and `stuck` lead theirs with the state's own word.
  waiting: { color: "$fg-muted", word: "waiting" },
  took: { color: "$fg-muted", word: "took" },
  // What the runner's row is called, in the cell that says what it holds.
  runner: { color: "$fg-muted", word: "RUNNER" },
}

/** The legend's word column: the longest word and its gap (`deprovisioning`). */
const WORD_COLUMN = 16

/**
 * The legend: the change's words (`word  what it means → what happens next`),
 * then `direct` apart under "not a change", then the runner's own under "the
 * runner". An entry longer than `width` wraps at a space and hangs under its
 * meaning.
 *
 * The runner's section says which of its words a reading can reach today. A
 * legend that listed all of them flat would promise an operator a word they
 * will never see, and the cure for that is to say so — never to invent a source
 * that emits it.
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
  // A word the changes already listed is listed once: the runner's row and a
  // change's row mean the same thing by it.
  const listed = new Set<string>(LEGEND_STATES)
  const runnerOnly = [...RUNNER_STATES, ...RUNNER_SIGNALS].filter((key) => !listed.has(key as never))
  const said = new Set<string>(RUNNER_STATES_SAID)
  // Every runner word no reading can reach, INCLUDING the ones listed above
  // with the changes: `merging` is in the change legend and on no row either,
  // and a legend that quietly dropped it from this line would promise it.
  const waiting = [...RUNNER_STATES, ...RUNNER_SIGNALS].filter((key) => !said.has(key))
  return [
    ...LEGEND_STATES.flatMap(entry),
    "",
    "not a change",
    ...entry("direct"),
    "",
    "the runner, which says checking, merging and stuck as a change does",
    ...runnerOnly.flatMap(entry),
    "",
    `not said yet: ${waiting.map((key) => STATE_WORDS[key].word).join(", ")} — the runner publishes no status of its own here`,
  ]
}
