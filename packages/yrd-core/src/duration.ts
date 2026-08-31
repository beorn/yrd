/** Human duration formats, shared by the watch timeline, the habitant
 * narration and lifecycle log messages. These live in core rather than in the
 * CLI because `emitLifecycle` needs the lifecycle format and core cannot import
 * upward; before this they lived only in `yrd-cli/src/runner-timeline.ts`,
 * which still re-exports them so every existing caller is untouched. */

/** Coarse human duration (largest unit): the watch timeline's cell format. */
export function formatDuration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds)
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

/** Lifecycle durations preserve subordinate units because a named completion
 * row is durable operator evidence, not a compact watch-table cell. `339032`
 * reads `5m39s`, not `5m` — the seconds are what tell a reader the run died
 * nowhere near its two-hour ceiling. */
export function formatLifecycleDuration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds)
  if (ms < 60_000) return formatDuration(ms)
  const totalSeconds = Math.floor(ms / 1_000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return [
    days > 0 ? `${days}d` : "",
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    seconds > 0 ? `${seconds}s` : "",
  ].join("")
}
