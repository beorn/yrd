import { COMPOSITION_FAILURE_BUCKETS } from "@yrd/queue"

export type StatusPresentationState =
  | "queued"
  | "running"
  | "done"
  | "integrated"
  | "failed"
  | "env"
  | "stale"
  | "timeout"
  | "canceled"
  | "needs-author"
  | "draft"
  | "rejected"

export type StatusPresentationColor = "$fg-info" | "$fg-success" | "$fg-warning" | "$fg-error" | "$fg-muted"

export type StatusPresentation = Readonly<{
  glyph: "○" | "◉" | "✓" | "×" | "−" | "◌"
  color: StatusPresentationColor
}>

export type FailureStatusClass = "failed" | "env" | "stale" | "timeout" | "canceled" | "needs-author"

const STATUS_PRESENTATIONS = {
  queued: { glyph: "○", color: "$fg-info" },
  running: { glyph: "◉", color: "$fg-info" },
  done: { glyph: "✓", color: "$fg-success" },
  integrated: { glyph: "✓", color: "$fg-success" },
  failed: { glyph: "×", color: "$fg-error" },
  env: { glyph: "×", color: "$fg-warning" },
  stale: { glyph: "×", color: "$fg-warning" },
  timeout: { glyph: "×", color: "$fg-error" },
  canceled: { glyph: "−", color: "$fg-muted" },
  "needs-author": { glyph: "×", color: "$fg-warning" },
  draft: { glyph: "◌", color: "$fg-muted" },
  rejected: { glyph: "×", color: "$fg-error" },
} as const satisfies Readonly<Record<StatusPresentationState, StatusPresentation>>

const STATUS_ALIASES: Readonly<Record<string, StatusPresentationState>> = {
  pending: "queued",
  ready: "queued",
  requested: "queued",
  todo: "queued",
  waiting: "running",
  checking: "running",
  passed: "done",
  success: "done",
  succeeded: "done",
  "environment-refused": "env",
  "queue-environment-refused": "env",
  lost: "timeout",
  "job-lost": "timeout",
  "lease-timeout": "timeout",
  cancelled: "canceled",
  withdrawn: "canceled",
  retired: "canceled",
  skipped: "canceled",
  superseded: "canceled",
  rev: "needs-author",
  refused: "rejected",
  legacy: "rejected",
}

export function statusPresentationState(status: string): StatusPresentationState {
  const normalized = status.trim().toLocaleLowerCase()
  if (Object.hasOwn(STATUS_PRESENTATIONS, normalized)) return normalized as StatusPresentationState
  return STATUS_ALIASES[normalized] ?? "rejected"
}

/** The one status → glyph/color vocabulary shared by queue rows, notices,
 * workflow tabs, and resident settlement narration. */
export function statusPresentation(status: string): StatusPresentation {
  return STATUS_PRESENTATIONS[statusPresentationState(status)]
}

const STALE_FAILURE_CODES = new Set(["stale-pr", "stale-check", "stale-base", "stale-steps", "stale-plan"])
const CANCELED_FAILURE_CODES = new Set([
  "canceled",
  "cancelled",
  "queue-canceled",
  "queue-cancelled",
  "run-canceled",
  "run-cancelled",
])
const NEEDS_AUTHOR_FAILURE_CODES: ReadonlySet<string> = COMPOSITION_FAILURE_BUCKETS["needs-author"]

/** Display classification for a durable queue failure. The observable is
 * named, never an uncorroborated cause: `job-lost` is a lease timeout. */
export function failureStatusClass(code: string): FailureStatusClass {
  if (STALE_FAILURE_CODES.has(code)) return "stale"
  if (code === "queue-environment-refused") return "env"
  if (code === "job-lost" || code === "lease-timeout") return "timeout"
  if (CANCELED_FAILURE_CODES.has(code)) return "canceled"
  if (NEEDS_AUTHOR_FAILURE_CODES.has(code)) return "needs-author"
  return "failed"
}

export type StatusAutomation = "auto-requeue" | "auto-recut" | "none"

/** Truthful automatic policy implemented by queue-authority release and the
 * resident pass. Ordinary decision and authoring failures never claim retry. */
export function failureAutomation(state: FailureStatusClass): StatusAutomation {
  if (state === "stale") return "auto-recut"
  if (state === "env" || state === "timeout") return "auto-requeue"
  return "none"
}
