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
import { runStartedAt, type Row } from "@yrd/queue-core"

/** The one glyph per state — the retired watch's, kept because the operator already reads them. */
export const STATE_GLYPH: Readonly<Record<Row["state"], string>> = {
  checked: "◉",
  direct: "→",
  failed: "×",
  merged: "✓",
  queued: "○",
  stuck: "◌",
}

/** The glyph a check running RIGHT NOW overlays on any state: the overlay reads live, the word still reads the state. */
export const RUNNING_GLYPH = "◉"

/** The glyph for a row: the running one while a check runs on it, else its state's. */
export function stateGlyph(row: Pick<Row, "state" | "live">): string {
  return row.live === undefined ? STATE_GLYPH[row.state] : RUNNING_GLYPH
}

/** The one severity color per state: the retired presentation's ladder, kept — open is accent, working is info, done is success, fail is error, stuck is warning. */
export const STATE_COLOR: Readonly<Record<Row["state"], string>> = {
  checked: "$fg-warning",
  direct: "$fg-muted",
  failed: "$fg-error",
  merged: "$fg-success",
  queued: "$fg-accent",
  stuck: "$fg-warning",
}

/** The working color a live check overlays on any state. */
export const RUNNING_COLOR = "$fg-info"

/** The color for a row: the working one while a check runs on it, else its state's. */
export function stateColor(row: Pick<Row, "state" | "live">): string {
  return row.live === undefined ? STATE_COLOR[row.state] : RUNNING_COLOR
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

/** A local wall-clock time, `HH:MM` or `HH:MM:SS`, for the absolute half of every time on screen. */
export function clock(at: Date, options: Readonly<{ seconds?: boolean }> = {}): string {
  const two = (value: number): string => String(value).padStart(2, "0")
  const base = `${two(at.getHours())}:${two(at.getMinutes())}`
  return options.seconds === true ? `${base}:${two(at.getSeconds())}` : base
}
