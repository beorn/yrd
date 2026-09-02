import { canonicalRefusalCode, COMPOSITION_FAILURE_BUCKETS, ENVIRONMENT_OWNED_FAILURE_CODES } from "@yrd/queue"

export type StatusPresentationState =
  | "queued"
  | "running"
  | "done"
  | "integrated"
  /** Step success without a merge/merge proof (admission-only phantom). */
  | "passed"
  | "failed"
  | "env"
  | "stale"
  | "timeout"
  | "canceled"
  | "needs-author"
  | "draft"
  | "rejected"
  /** A running row whose lease lapsed or whose holder is dead — derived at
   * read (@i/10-yrd/24030); the presentation of the `orphaned-run` code. */
  | "orphaned"

export type LifecycleStatus = "open" | "working" | "done" | "fail"

export type StatusPresentationColor =
  | "$fg-accent"
  | "$fg-info"
  | "$fg-success"
  | "$fg-warning"
  | "$fg-error"
  | "$fg-muted"

export type StatusPresentation = Readonly<{
  glyph: "○" | "◉" | "✓" | "×" | "−" | "◌"
  color: StatusPresentationColor
}>

export type FailureStatusClass = "failed" | "env" | "stale" | "timeout" | "canceled" | "needs-author"
export type FailureBreakdownClass = "check-failed" | "env" | "stale" | "timeout" | "canceled" | "other"

export const FAILURE_BREAKDOWN_CLASSES: readonly FailureBreakdownClass[] = [
  "check-failed",
  "env",
  "stale",
  "timeout",
  "canceled",
  "other",
]

export type StatusAutomation = "auto-requeue" | "auto-re-merge" | "none"
export type FailureDisposition = Readonly<{
  state: FailureStatusClass
  automation: StatusAutomation
  owner: "author" | "queue"
}>

const LIFECYCLE_PRESENTATIONS = {
  open: { glyph: "○", color: "$fg-accent" },
  working: { glyph: "◉", color: "$fg-info" },
  done: { glyph: "✓", color: "$fg-success" },
  fail: { glyph: "×", color: "$fg-error" },
} as const satisfies Readonly<Record<LifecycleStatus, StatusPresentation>>

// Every word the CLI has ever PRINTED must still parse here: the converged
// display labels (queued/checking/merged/failed) and the words they replaced.
const LIFECYCLE_ALIASES: Readonly<Record<string, LifecycleStatus>> = {
  active: "open",
  queued: "open",
  pending: "open",
  opening: "working",
  closing: "working",
  running: "working",
  checking: "working",
  closed: "done",
  integrated: "done",
  merged: "done",
  failed: "fail",
  rejected: "fail",
  orphaned: "fail",
}

function knownLifecycleStatus(normalized: string): LifecycleStatus | null {
  if (Object.hasOwn(LIFECYCLE_PRESENTATIONS, normalized)) return normalized as LifecycleStatus
  return LIFECYCLE_ALIASES[normalized] ?? null
}

export function lifecycleStatus(status: string): LifecycleStatus {
  const normalized = status.trim().toLocaleLowerCase()
  const projected = knownLifecycleStatus(normalized)
  if (projected !== null) return projected
  throw new TypeError(`yrd: unknown lifecycle status '${status}'`)
}

export function lifecyclePresentation(status: string): StatusPresentation {
  return LIFECYCLE_PRESENTATIONS[lifecycleStatus(status)]
}

const STATUS_PRESENTATIONS = {
  queued: LIFECYCLE_PRESENTATIONS.open,
  running: LIFECYCLE_PRESENTATIONS.working,
  done: LIFECYCLE_PRESENTATIONS.done,
  integrated: LIFECYCLE_PRESENTATIONS.done,
  // Non-merge success must NOT share the green check with real merges
  // (@yrd/core/21096-cli-ux/21801; audit 22323: outcome=passed admission-only).
  passed: { glyph: "◌", color: "$fg-warning" },
  failed: LIFECYCLE_PRESENTATIONS.fail,
  env: { glyph: "×", color: "$fg-warning" },
  stale: { glyph: "×", color: "$fg-warning" },
  timeout: { glyph: "×", color: "$fg-error" },
  canceled: { glyph: "−", color: "$fg-muted" },
  "needs-author": { glyph: "×", color: "$fg-warning" },
  draft: { glyph: "◌", color: "$fg-muted" },
  rejected: LIFECYCLE_PRESENTATIONS.fail,
  // The holder is dead or its lease lapsed: environment-owned, like the
  // `orphaned-run` failure the next pass start writes for it — never the
  // pulsing working glyph a stored `in_progress` used to earn (24030).
  orphaned: { glyph: "×", color: "$fg-warning" },
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
  // "passed" is a first-class presentation state (non-landing), not an alias of done.
  success: "done",
  succeeded: "done",
  merged: "integrated",
  "already-landed": "integrated",
  "already merged": "integrated",
  "environment-refused": "env",
  "queue-environment-refused": "env",
  "orphaned-run": "orphaned",
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
  // Admission-only / incomplete success aliases
  "non-landing": "passed",
  "admission-only": "passed",
}

const LIFECYCLE_PRESENTATION_STATES: Readonly<Record<LifecycleStatus, StatusPresentationState>> = {
  open: "queued",
  working: "running",
  done: "done",
  fail: "failed",
}

function knownStatusPresentationState(normalized: string): StatusPresentationState | null {
  if (Object.hasOwn(STATUS_PRESENTATIONS, normalized)) return normalized as StatusPresentationState
  const direct = STATUS_ALIASES[normalized]
  if (direct !== undefined) return direct
  const lifecycle = knownLifecycleStatus(normalized)
  return lifecycle === null ? null : LIFECYCLE_PRESENTATION_STATES[lifecycle]
}

export function hasStatusPresentation(status: string): boolean {
  return knownStatusPresentationState(status.trim().toLocaleLowerCase()) !== null
}

export function statusPresentationState(status: string): StatusPresentationState {
  const normalized = status.trim().toLocaleLowerCase()
  const state = knownStatusPresentationState(normalized)
  if (state !== null) return state
  throw new TypeError(`yrd: unknown presentation status '${status}'`)
}

/** The one status → glyph/color vocabulary shared by queue rows, notices,
 * workflow tabs, and habitant settlement narration. */
export function statusPresentation(status: string): StatusPresentation {
  return STATUS_PRESENTATIONS[statusPresentationState(status)]
}

const AUTO_REQUEUE_STALE_FAILURE_CODES = new Set(["stale-check", "stale-steps", "stale-plan"])
// Both spellings ("cancelled"/"queue-cancelled"/"run-cancelled") resolve to
// these canonical forms through YRD_REFUSAL_CODE_ALIASES before this Set is
// ever consulted — see canonicalRefusalCode below.
const CANCELED_FAILURE_CODES = new Set(["canceled", "queue-canceled", "run-canceled"])
const NEEDS_AUTHOR_FAILURE_CODES: ReadonlySet<string> = COMPOSITION_FAILURE_BUCKETS["needs-author"]
/** The bucket whose whole contract is "no author-blame routing and no
 * auto-retry; the operator re-evaluates" — and which `failureDisposition` did
 * not read, so every member silently took the author default it exists to
 * forbid. Read here so bucket membership IS the routing, rather than a
 * declaration a second table may disagree with. */
const PLAIN_REJECTED_FAILURE_CODES: ReadonlySet<string> = COMPOSITION_FAILURE_BUCKETS["plain-rejected"]
const INFRA_RETRY_FAILURE_CODES: ReadonlySet<string> = new Set([
  ...COMPOSITION_FAILURE_BUCKETS["infra-retry"],
  // Historical-only: the retired composed path's source publisher. Nothing
  // produces it since the re-merge refactor, but recorded runs and release
  // reasons still carry it, and their presentation stays honest.
  "source-publish",
  // The outcome-notifier seam's own codes (@i/10-yrd/24028): a notifier that
  // failed or was never configured is the queue owner's fault, never the
  // author's. Neither is ever a persisted Run/Job failure; they classify here
  // so the census resolves them without the author default.
  "notify-failed",
  "notify-unconfigured",
])

/**
 * One code-aware decision for every status consumer. Classification alone is
 * insufficient: stale-base is mechanically re-merge, stale-check/config drift is
 * requeued unchanged, and stale-pr is an obsolete historical run with no retry
 * of its own. Keep those journal-observable distinctions intact.
 *
 * Every code is resolved against the closed `YRD_REFUSAL_CODES` vocabulary
 * (`@yrd/queue`) first: a registered alias normalizes to its canonical
 * spelling (so the checks below see ONE spelling per concept, never both), and
 * a code that is neither canonical nor a registered alias throws rather than
 * falling through to a silent `{ state: "failed", owner: "author" }` guess —
 * mirroring lifecycleStatus/statusPresentationState above. Extend the
 * vocabulary at its source (YRD_REFUSAL_CODES or YRD_REFUSAL_CODE_ALIASES in
 * packages/yrd-queue/src/queue.ts), never by special-casing here.
 */
export function failureDisposition(code: string): FailureDisposition {
  const canonical = canonicalRefusalCode(code)
  if (canonical === undefined) {
    throw new TypeError(
      `yrd: unknown failure code '${code}' — register it in YRD_REFUSAL_CODES or YRD_REFUSAL_CODE_ALIASES (packages/yrd-queue/src/queue.ts) before it can classify`,
    )
  }
  if (canonical === "stale-base") return { state: "stale", automation: "auto-re-merge", owner: "queue" }
  if (AUTO_REQUEUE_STALE_FAILURE_CODES.has(canonical)) {
    return { state: "stale", automation: "auto-requeue", owner: "queue" }
  }
  if (canonical === "stale-pr") return { state: "stale", automation: "none", owner: "queue" }
  // Ahead of the environment branch, which this code is also a member of: the
  // membership is what stops the author being billed, and this branch is what
  // keeps a bound that fired NAMED as a bound. `env` would be true and useless
  // — the operator reads the status column to know what to go and look at, and
  // `routeOutcome` keys its "a check TIMEOUT routes here: yrd is broken until
  // the owner proves otherwise" body on this state (@i/10-yrd, 2026-09-02).
  if (canonical === "check-timeout") return { state: "timeout", automation: "auto-requeue", owner: "queue" }
  if (ENVIRONMENT_OWNED_FAILURE_CODES.has(canonical) || INFRA_RETRY_FAILURE_CODES.has(canonical)) {
    return { state: "env", automation: "auto-requeue", owner: "queue" }
  }
  if (canonical === "job-lost" || canonical === "job-lease-expired") {
    return { state: "timeout", automation: "auto-requeue", owner: "queue" }
  }
  if (CANCELED_FAILURE_CODES.has(canonical)) return { state: "canceled", automation: "none", owner: "queue" }
  if (NEEDS_AUTHOR_FAILURE_CODES.has(canonical)) {
    return { state: "needs-author", automation: "none", owner: "author" }
  }
  if (PLAIN_REJECTED_FAILURE_CODES.has(canonical)) {
    return { state: "failed", automation: "none", owner: "queue" }
  }
  return { state: "failed", automation: "none", owner: "author" }
}

/** Display classification for a durable queue failure. The observable is
 * named, never an uncorroborated cause: `job-lost` is a lease timeout. */
export function failureStatusClass(code: string): FailureStatusClass {
  return failureDisposition(code).state
}

/** The statistics breakdown is a projection of the same durable failure
 * classifier and presentation aliases used by StatusNotice. Only the one
 * operator-requested class is intentionally more specific. (`config-drift`
 * was a second one; no Run has ever failed with it — the gate that raised it
 * ran before any Run started — and the gate is gone with the installed
 * baseline, 23192/23193.)
 *
 * The one caller with no `failure.code` to report (`foldTerminalFacts` in
 * queue-status-view.tsx) falls back to the row's plain STATUS string
 * (`"failed"`, `"canceled"`, …) — a different vocabulary from the closed
 * refusal-code registry, and never itself a registered code — so
 * failureStatusClass runs only once `code` is confirmed to be one; anything
 * else goes straight to the status-presentation fallback below exactly as
 * before, rather than throwing on a shape this function is meant to accept. */
export function failureBreakdownClass(code: string): FailureBreakdownClass {
  const normalized = code.trim().toLocaleLowerCase()
  if (normalized === "check-failed") return "check-failed"
  if (canonicalRefusalCode(normalized) !== undefined) {
    const status = failureStatusClass(normalized)
    if (status === "env" || status === "stale" || status === "timeout" || status === "canceled") return status
  }
  const terminalStatus = knownStatusPresentationState(normalized)
  if (
    terminalStatus === "env" ||
    terminalStatus === "stale" ||
    terminalStatus === "timeout" ||
    terminalStatus === "canceled"
  ) {
    return terminalStatus
  }
  return "other"
}
