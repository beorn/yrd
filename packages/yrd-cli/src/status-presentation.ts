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
export type StatusAutomation = "auto-requeue" | "auto-recut" | "none"
export type FailureDisposition = Readonly<{
  state: FailureStatusClass
  automation: StatusAutomation
  actor: "author" | "queue"
}>

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
  submitted: "queued",
  todo: "queued",
  waiting: "running",
  checking: "running",
  wip: "running",
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
  pushed: "draft",
  rev: "needs-author",
  refused: "rejected",
  legacy: "rejected",
}

export function statusPresentationState(status: string): StatusPresentationState {
  const normalized = status.trim().toLocaleLowerCase()
  if (Object.hasOwn(STATUS_PRESENTATIONS, normalized)) return normalized as StatusPresentationState
  const alias = STATUS_ALIASES[normalized]
  if (alias !== undefined) return alias
  throw new TypeError(`yrd: unknown presentation status '${status}'`)
}

/** The one status → glyph/color vocabulary shared by queue rows, notices,
 * workflow tabs, and resident settlement narration. */
export function statusPresentation(status: string): StatusPresentation {
  return STATUS_PRESENTATIONS[statusPresentationState(status)]
}

const AUTO_REQUEUE_STALE_FAILURE_CODES = new Set(["stale-check", "stale-steps", "stale-plan"])
const CANCELED_FAILURE_CODES = new Set([
  "canceled",
  "cancelled",
  "queue-canceled",
  "queue-cancelled",
  "run-canceled",
  "run-cancelled",
])
const NEEDS_AUTHOR_FAILURE_CODES: ReadonlySet<string> = COMPOSITION_FAILURE_BUCKETS["needs-author"]
const INFRA_RETRY_FAILURE_CODES: ReadonlySet<string> = COMPOSITION_FAILURE_BUCKETS["infra-retry"]

/**
 * One code-aware decision for every status consumer. Classification alone is
 * insufficient: stale-base is mechanically recut, stale-check/config drift is
 * requeued unchanged, and stale-pr is an obsolete historical run with no retry
 * of its own. Keep those journal-observable distinctions intact.
 */
export function failureDisposition(code: string): FailureDisposition {
  if (code === "stale-base") return { state: "stale", automation: "auto-recut", actor: "queue" }
  if (AUTO_REQUEUE_STALE_FAILURE_CODES.has(code)) {
    return { state: "stale", automation: "auto-requeue", actor: "queue" }
  }
  if (code === "stale-pr") return { state: "stale", automation: "none", actor: "queue" }
  if (
    code === "queue-environment-refused" ||
    code === "environment-refused" ||
    code === "orphaned-run" ||
    INFRA_RETRY_FAILURE_CODES.has(code)
  ) {
    return { state: "env", automation: "auto-requeue", actor: "queue" }
  }
  if (code === "job-lost" || code === "lease-timeout" || code === "job-lease-expired") {
    return { state: "timeout", automation: "auto-requeue", actor: "queue" }
  }
  if (CANCELED_FAILURE_CODES.has(code)) return { state: "canceled", automation: "none", actor: "queue" }
  if (NEEDS_AUTHOR_FAILURE_CODES.has(code)) {
    return { state: "needs-author", automation: "none", actor: "author" }
  }
  return { state: "failed", automation: "none", actor: "author" }
}

/** Display classification for a durable queue failure. The observable is
 * named, never an uncorroborated cause: `job-lost` is a lease timeout. */
export function failureStatusClass(code: string): FailureStatusClass {
  return failureDisposition(code).state
}
