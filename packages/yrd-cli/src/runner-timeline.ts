import type { Event } from "loggily"

/**
 * Pure (no silvery/React) watch-timeline grammar shared by the interactive
 * queue view and the resident follow-runner's human log lines. The runner's
 * stdout IS a log stream, so its INFO/ERROR lines read like the watch pane's
 * timeline rows — one scannable line each — while the full JSON payload goes
 * only to the structured/file sink. Keeping these helpers here (not in the
 * queue-status view .tsx) means the headless logger never imports silvery.
 */

/** Powerline branch glyph (U+E0A0), the same BRANCH_ICON the watch UI prefixes
 * onto every branch name (user directive 2026-07-16). */
export const TIMELINE_BRANCH_ICON = ""

/** The status → row glyph map (mirrors the watch timeline's statusGlyph). */
export function timelineStatusGlyph(status: string): string {
  if (["checking", "running", "waiting"].includes(status)) return "●"
  if (["integrated", "passed"].includes(status)) return "✓"
  if (["rejected", "failed", "lost", "environment-refused"].includes(status)) return "×"
  if (["withdrawn", "retired", "canceled"].includes(status)) return "-"
  return "○"
}

/** Coarse human duration (largest unit): the watch timeline's formatDuration. */
export function formatDuration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds)
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

const ANSI = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  grey: "\x1b[90m",
})

type Paint = (text: string) => string
const identity: Paint = (text) => text
const paint =
  (color: boolean, code: string): Paint =>
  (text) =>
    color ? `${code}${text}${ANSI.reset}` : text

// Same semantic mapping the watch timeline uses for status foregrounds.
function statusPaint(status: string, color: boolean): Paint {
  if (!color) return identity
  if (["integrated", "passed"].includes(status)) return paint(color, ANSI.green)
  if (["running", "waiting", "checking", "pending"].includes(status)) return paint(color, ANSI.blue)
  if (["canceled", "withdrawn", "retired"].includes(status)) return paint(color, ANSI.grey)
  if (status === "environment-refused") return paint(color, ANSI.yellow)
  return paint(color, ANSI.red)
}

// Scope-bound identity (bound once via residentRunnerLog) plus internals that a
// timeline row renders positionally — never repeated inline on the human line.
const SUPPRESSED_FIELDS = new Set([
  "runner",
  "host",
  "pane",
  "lifecycle",
  "outcome",
  "durationMs",
  "run",
  "prs",
  "runs",
  "steps",
  "base",
  "status",
  "step",
  "summary",
  "diagnostic",
  "startedAt",
  "finishedAt",
])

type LifecycleProps = Readonly<{
  run?: string
  status?: string
  step?: string
  steps?: readonly string[]
  durationMs?: number
  summary?: string
  outcome?: string
  prs?: readonly Readonly<{ pr?: string; revision?: number; branch?: string }>[]
}>

function durationCell(props: LifecycleProps, color: boolean): string {
  return props.durationMs === undefined ? "" : ` ${paint(color, ANSI.dim)(formatDuration(props.durationMs))}`
}

function prRow(namespace: string, props: LifecycleProps, color: boolean): string | undefined {
  const run = props.run
  const pr = props.prs?.[0]
  if (run === undefined || pr?.pr === undefined) return undefined
  const status = props.status ?? props.outcome ?? "unknown"
  // The step for a jobs:<step> row is its own step; a run row settles on its
  // last step (e.g. "merge"), falling back to the status word.
  const label = namespace.startsWith("yrd:jobs:") ? (props.step ?? status) : (props.steps?.at(-1) ?? status)
  const identityCell = `${run} ${paint(color, ANSI.bold)(`${pr.pr}.${pr.revision ?? 1}`)}`
  const extra = props.prs !== undefined && props.prs.length > 1 ? ` +${props.prs.length - 1}` : ""
  const branchCell = pr.branch === undefined ? "" : `  ${TIMELINE_BRANCH_ICON} ${pr.branch}`
  const stepCell = statusPaint(status, color)(`(${label} ${timelineStatusGlyph(status)})`)
  return `${identityCell}${extra}${branchCell} ${stepCell}${durationCell(props, color)}`
}

function composeRow(props: LifecycleProps, color: boolean): string {
  const label = props.summary ?? props.outcome ?? "settled"
  return `${paint(color, ANSI.bold)("compose")} ${label}${durationCell(props, color)}`
}

function compactFields(props: LifecycleProps & Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(props)) {
    if (SUPPRESSED_FIELDS.has(key)) continue
    if (value === undefined || value === null || typeof value === "object") continue
    parts.push(`${key}=${String(value)}`)
  }
  return parts.length === 0 ? "" : ` · ${parts.join(" ")}`
}

function noticeLine(event: Extract<Event, { kind: "log" }>, color: boolean): string {
  const levelPaint =
    event.level === "error" ? paint(color, ANSI.red) : event.level === "warn" ? paint(color, ANSI.yellow) : identity
  const props = (event.props ?? {}) as LifecycleProps & Record<string, unknown>
  return `${levelPaint(event.level.toUpperCase())} ${event.message}${compactFields(props)}${durationCell(props, color)}`
}

/**
 * Format one resident-runner log Event as a human line, or `undefined` to
 * suppress it from the human stream (it still reaches the JSONL file sink).
 * Lifecycle completions render as timeline rows; low-level journal chatter is
 * suppressed; warns/errors render as a compact level+message notice. Scope-bound
 * runner/host/pane never appear inline.
 */
export function formatResidentLogLine(event: Event, options: Readonly<{ color: boolean }>): string | undefined {
  if (event.kind !== "log") return undefined
  const { color } = options
  const namespace = event.namespace
  const props = (event.props ?? {}) as LifecycleProps

  // Low-level journal bookkeeping is noise on the human line — keep it in the
  // JSONL sink only. Its warn/error escalations still surface as notices.
  if (namespace.startsWith("yrd:journal:") && (event.level === "info" || event.level === "debug")) return undefined

  if (event.level === "warn" || event.level === "error") {
    // A failed lifecycle row still reads best as a timeline row (jobs:<step>
    // ERROR). Other warns/errors are compact notices.
    if (namespace.startsWith("yrd:jobs:") || namespace === "yrd:queue:run") {
      const row = prRow(namespace, props, color)
      if (row !== undefined) return row
    }
    return noticeLine(event, color)
  }

  if (namespace === "yrd:queue:compose") return composeRow(props, color)
  if (namespace === "yrd:queue:run" || namespace.startsWith("yrd:jobs:")) {
    const row = prRow(namespace, props, color)
    if (row !== undefined) return row
  }
  // Other info (lease acquired/released, etc.) — a compact notice keeps it
  // readable without a JSON dump.
  return noticeLine(event, color)
}
