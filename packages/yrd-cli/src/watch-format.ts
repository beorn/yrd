/**
 * The watch's pure formatters — no React, no silvery — shared by the pane, the
 * plain `queue list` print and every box. The one-shot commands import THIS
 * file and never the chrome beside it, so `yrd queue list` keeps loading no
 * reconciler.
 *
 * Two tables of the same glyphs had grown in `watch-rows.ts` and
 * `watch-notice.ts`; this is the one that remains.
 */

import { homedir } from "node:os"
import { clocks, runStartedAt, type ChangeStatus, type CheckView, type JournalRun, type Row } from "@yrd/queue-core"
import { STATE_WORDS, type DisplayState } from "./watch-words.ts"

export {
  LEGEND_STATES,
  RUNNER_STATES,
  STATE_WORDS,
  legendLines,
  type DisplayState,
  type RunnerState,
  type WordEntry,
} from "./watch-words.ts"

/**
 * The word a row's state reads as (watch-words.ts): a check running on it now
 * reads checking whatever its records say; otherwise the core's state, in the
 * operator's word (`queued` paints submitted, `checked` paints pending).
 */
type DisplayRow = Pick<Row<Row["state"] | ChangeStatus>, "state" | "live" | "format">

export function displayState(row: DisplayRow): DisplayState {
  if (row.live !== undefined) return "checking"
  if (row.format === "event") {
    switch (row.state) {
      case "verifying":
        return "event-verifying"
      case "draft":
      case "queued":
      case "checking":
      case "merging":
      case "merged":
      case "failed":
      case "stuck":
      case "cancelled":
      case "direct":
        return row.state
      default:
        throw new Error(`event row has a legacy status: ${row.state}`)
    }
  }
  switch (row.state) {
    case "queued":
      return "submitted"
    case "checked":
      return "pending"
    case "withdrawn":
      return "cancelled"
    case "draft":
    case "direct":
    case "deferred":
    case "merged":
    case "failed":
    case "stuck":
      return row.state
    default:
      throw new Error(`legacy row has an event status without its format: ${row.state}`)
  }
}

/** The word for a row, read from the one table when it draws. */
export function stateWord(row: DisplayRow): string {
  return STATE_WORDS[displayState(row)].word
}

/** Full recorded warnings, shared by plain output and the selected change detail. */
export function diagnosticLines(
  row: Pick<Row, "branch" | "head" | "diagnostics">,
  journal?: JournalRun,
): readonly string[] {
  return (row.diagnostics ?? []).flatMap((record) => {
    const usable = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""
    const text = usable(record.text) ? record.text : undefined
    const inspect = usable(record.inspect) ? record.inspect : undefined
    const next = usable(record.next) ? record.next : undefined
    const commands =
      inspect === next
        ? [["inspect", inspect]]
        : [
            ["inspect", inspect],
            ["next", next],
          ]
    const missing = [
      text === undefined ? "explanation" : undefined,
      inspect === undefined && next === undefined ? "inspection command" : undefined,
    ].filter((part) => part !== undefined)
    return [
      `${row.branch}@${row.head} run ${record.run}: ⚠ ref-write warning (${String(record.reason)})${usable(record.ref) ? ` — ${record.ref}` : ""}`,
      ...(journal !== undefined && journal.decision === undefined ? ["no run decision recorded"] : []),
      ...(text === undefined ? [] : [text]),
      ...commands.flatMap(([name, command]) =>
        command === undefined
          ? []
          : text?.includes(command) === true
            ? inspect !== undefined && next !== undefined && inspect !== next
              ? [`${name}: recorded in text above`]
              : []
            : [`${name}: ${command}`],
      ),
      ...(missing.length === 0
        ? []
        : [
            `The record has no ${missing.join(" or ")}${usable(record.remote) ? ` (remote: ${record.remote})` : ""}. Inspect the stored fields with \`yrd list --json\`.`,
          ]),
    ]
  })
}

/** The one glyph per state — the retired watch's, kept because the operator already reads them. */
export const STATE_GLYPH: Readonly<Record<DisplayRow["state"], string>> = {
  cancelled: "⊘",
  checked: "◉",
  checking: "◉",
  deferred: "☾",
  direct: "→",
  draft: "◇",
  failed: "×",
  merged: "✓",
  merging: "◉",
  queued: "○",
  stuck: "◌",
  verifying: "◉",
  withdrawn: "⊘",
}

/** The glyph a check running RIGHT NOW overlays on any state: the overlay reads live, the word still reads the state. */
export const RUNNING_GLYPH = "◉"

/**
 * The runner's own marker, on its own row: the one row in the table that is not
 * a change. U+25B8 and not the solid U+25B6, which is an emoji base: a terminal
 * with an emoji font draws that one two cells wide and every cell to its right
 * on that row lands one column off the column above it.
 */
export const RUNNER_GLYPH = "▸"

/** The glyph for a row: the running one while a check runs on it, else its state's. */
export function stateGlyph(row: DisplayRow): string {
  if (row.live !== undefined) return RUNNING_GLYPH
  const glyph = STATE_GLYPH[row.state]
  if (glyph === undefined) throw new Error(`no glyph for ${row.state}`)
  return glyph
}

/** The one glyph per check state, so the tab strip, the step lines and the one-shot print cannot disagree about a check. */
export const CHECK_GLYPH: Readonly<Record<CheckView["state"], string>> = {
  deferred: "☾",
  failed: "×",
  "not-run": "−",
  // Switched off by a `run: "true"` declaration (25422): it ran and tested nothing.
  off: "○",
  passed: "✓",
  running: "◉",
  // Held off at merge by an override (25296): it did not run, on purpose.
  skipped: "⊘",
  stuck: "◌",
  unmeasured: "?",
}

/** The one color per check state. */
export const CHECK_COLOR: Readonly<Record<CheckView["state"], string>> = {
  deferred: "$fg-accent",
  failed: "$fg-error",
  "not-run": "$fg-muted",
  off: "$fg-muted",
  passed: "$fg-success",
  running: "$fg-info",
  skipped: "$fg-warning",
  stuck: "$fg-warning",
  unmeasured: "$fg-warning",
}

/**
 * The colour for a row, read from the SAME entry its word came from
 * (watch-words.ts): the retired presentation's ladder, kept — open is accent,
 * working is info, done is success, fail is error, stuck is warning. A check
 * running now carries the working colour because it carries the word
 * `checking`, rather than through a second overlay nobody could see in the
 * table beside it.
 */
export function stateColor(row: DisplayRow): string {
  return STATE_WORDS[displayState(row)].color
}

/**
 * Bounded hanging wrap for one marker-led line (item 29, which settled the
 * item-13 deviation): wrapped text hangs off the marker and the line's HEIGHT
 * is capped, eliding with `…`, so a long command can never push the run list
 * off a narrow pane. Pure and width-driven so a guard test can pin exact rows.
 */
export function boundedHangingLines(text: string, width: number, maxRows = 3): readonly string[] {
  const safeWidth = Math.max(1, Math.floor(width))
  const words = text.split(/\s+/u).filter((word) => word !== "")
  const rows: string[] = []
  let current = ""
  const push = (row: string): void => {
    if (row !== "") rows.push(row)
  }
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`
    if (candidate.length <= safeWidth) {
      current = candidate
      continue
    }
    push(current)
    // A single word longer than the row hard-breaks; anything else wraps whole.
    let rest = word
    while (rest.length > safeWidth) {
      rows.push(rest.slice(0, safeWidth))
      rest = rest.slice(safeWidth)
    }
    current = rest
  }
  push(current)
  if (rows.length <= maxRows) return rows
  const kept = rows.slice(0, maxRows)
  const last = kept[maxRows - 1] ?? ""
  kept[maxRows - 1] = last.length >= safeWidth ? `${last.slice(0, Math.max(0, safeWidth - 1))}…` : `${last}…`
  return kept
}

/**
 * The ONE user-friendly path formatter (items 30a and 33): home-relative with
 * `~` the way a shell prompt prints it. `/hh` stays `/hh`; a repository under
 * `$HOME` reads `~/repo`, never the expanded absolute. Every surface that
 * prints a repository path goes through here.
 */
export function friendlyPath(path: string, home: string = homedir()): string {
  const root = home.endsWith("/") ? home.slice(0, -1) : home
  if (root === "" || root === "/") return path
  if (path === root) return "~"
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path
}

/**
 * A run's short name on screen: `<label>#<HHMMSS>`, the run's own start
 * instant in local time, read from the id itself (items 34/36/38 asked for
 * `label#N`; the queue core mints `q-<instant>-<random>` and stores no
 * counter, so the instant is the number a run has). The random tail is never
 * shown beside commit shas: two hex strings, one a run and one a commit, read
 * as the same kind of thing. The full id stays in the detail and in `--json`.
 * A name that is not one of ours is shown as it is.
 */
export function runShortName(label: string, id: string): string {
  const startedAt = runStartedAt(id)
  if (startedAt === undefined) return `${label}#${id}`
  return `${label}#${clock(startedAt, { seconds: true }).replace(/:/gu, "")}`
}

/**
 * A duration the way a media player counts it — `M:SS`, `H:MM:SS` — the form
 * the operator's item 1 sample uses (`Age 34:23 · Runtime 3:45 · Wait time
 * 00:10`) and the retired pane's `mediaDuration`, ported as it was. Past what
 * fits in six cells it steps to `Hh MMm`, then `Dd HHh`, then days.
 */
export function mediaDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = String(seconds % 60).padStart(2, "0")
  const compact =
    hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${remainder}` : `${String(minutes)}:${remainder}`
  if (compact.length <= 6) return compact
  const totalMinutes = Math.floor(milliseconds / 60_000)
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 100) return `${String(totalHours)}h${String(totalMinutes % 60).padStart(2, "0")}m`
  const totalDays = Math.floor(totalHours / 24)
  if (totalDays < 100) return `${String(totalDays)}d${String(totalHours % 24).padStart(2, "0")}h`
  return `${String(totalDays)}d`
}

/**
 * A row's one duration, its word naming its basis (queue-core `clocks`): how
 * long the check running now has run, how long a stuck change has been stuck,
 * how long a change in line has waited since it was submitted, or how long an
 * ended change took. A draft has none. The table cell draws it, and the
 * timing line under a change leads with it, so the two say one number.
 */
export function durationText(row: Row, now: Date): string {
  const measured = clocks(row, now)
  if (measured.checkingMs !== undefined) return `${STATE_WORDS.checking.word} ${mediaDuration(measured.checkingMs)}`
  if (measured.stuckMs !== undefined) return `${STATE_WORDS.stuck.word} ${mediaDuration(measured.stuckMs)}`
  // A stuck change keeps its place in line, and so a wait, but its cell is stuck's alone: with no instant for its
  // stuck record it says nothing rather than borrow the waiting word (A2-set-v4).
  if (row.state === "stuck") return ""
  if (measured.waitingMs !== undefined) return `${STATE_WORDS.waiting.word} ${mediaDuration(measured.waitingMs)}`
  if (measured.tookMs !== undefined) return `${STATE_WORDS.took.word} ${mediaDuration(measured.tookMs)}`
  return ""
}

/**
 * AGE / RUN for the table (item 5, 24196): every row has an AGE from its commit
 * or submission instant; rows in the runner or after it have a RUN time.
 */
export function ageRunText(row: Row, now: Date): string {
  const measured = clocks(row, now)
  const origin = row.since ?? row.at
  const age = origin === undefined ? "—" : mediaDuration(Math.max(0, now.getTime() - origin.getTime()))
  const isEnded =
    row.state === "merged" || row.state === "failed" || row.state === "cancelled" || row.state === "withdrawn"
  const runtime = measured.runtimeMs ?? measured.checkingMs ?? (isEnded ? measured.tookMs : undefined)
  const run = runtime === undefined ? "—" : runTime(runtime)
  return `${age} / ${run}`
}

/** A run time as the table and the detail both say it: every number zero-padded, so it reads 03:02 (25421). */
export function runTime(milliseconds: number): string {
  return mediaDuration(milliseconds).replace(/^\d(?=\D)/u, (digit) => `0${digit}`)
}

/** The AGE / RUN cell's least width: an mm:ss age and an mm:ss run time, so a run time appearing never widens the column (25421). */
export const AGE_RUN_MIN_WIDTH = "00:00 / 00:00".length

/** Bare numeric attempt / timestamp identifier without label prefix: `085315` or `—`. */
export function runIdentifier(id: string | undefined): string {
  if (id === undefined) return "—"
  const startedAt = runStartedAt(id)
  if (startedAt === undefined) return id
  return clock(startedAt, { seconds: true }).replace(/:/gu, "")
}

/** Queue digit beside the run: `1 · main#2342`, or `1 · —` with no attempt. */
export function queueRunText(digit: number, label: string, runId: string | undefined): string {
  if (runId === undefined) return `${String(digit)} · —`
  return `${String(digit)} · ${runShortName(label, runId)}`
}

/**
 * The timing line the detail and a one-row page print for a change
 * (@i/10-yrd/24196): its one duration, word and basis exactly as its table
 * cell says it, then the attempt's runtime under its own name, which counts
 * on only while a check holds the row. A clock nothing measured is left out,
 * never printed as zero.
 */
export function timingLine(row: Row, now: Date): string {
  const { runtimeMs } = clocks(row, now)
  return [durationText(row, now), runtimeMs === undefined ? "" : `runtime ${runTime(runtimeMs)}`]
    .filter((part) => part !== "")
    .join(" · ")
}

/** A local wall-clock time, `HH:MM` or `HH:MM:SS`, for the absolute half of every time on screen. */
/** git's default comment character, the one its conflicts block is written with. */
const GIT_COMMENT_CHAR = "#"

/**
 * A commit body without the conflicts block git appends to a conflicted
 * merge's message (sequencer `append_conflicts_hint`): the `# Conflicts:`
 * line, each `#<TAB><path>` line after it, and the blank line before it.
 * `git commit --no-edit` keeps the block (cleanup=whitespace), so a
 * hand-resolved merge's note read as the queue's verdict (25423). Only this
 * block is git's; every other line, `#123 keep me` included, is the author's.
 */
export function withoutGitConflictsBlock(body: string): string {
  const lines = body.split("\n")
  const kept: string[] = []
  for (let at = 0; at < lines.length; at++) {
    if (lines[at] !== `${GIT_COMMENT_CHAR} Conflicts:`) {
      kept.push(lines[at] ?? "")
      continue
    }
    if (kept.at(-1) === "") kept.pop()
    while (lines[at + 1]?.startsWith(`${GIT_COMMENT_CHAR}\t`) === true) at++
  }
  return kept.join("\n")
}

/** The first line of what went wrong, for a sentence on screen: an error's message, else the value as text. */
export function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split("\n")[0] ?? text
}

export function clock(at: Date, options: Readonly<{ seconds?: boolean }> = {}): string {
  const two = (value: number): string => String(value).padStart(2, "0")
  const base = `${two(at.getHours())}:${two(at.getMinutes())}`
  return options.seconds === true ? `${base}:${two(at.getSeconds())}` : base
}
