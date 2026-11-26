/**
 * The holds the queue retries by itself — a standing stuck it wrote for a condition it expects to clear,
 * never a change waiting on a person.
 *
 * Each kind is recognised by ONE exported constant that its `Retry-Reason:` / `Reason:` carries, never by
 * prose (@cto 5d7283e9): rewording a message must not turn an automatic retry into a human stop, or the
 * reverse. A stuck event without the exact constant keeps a manual resume.
 */

/** Written on the requeue record for a check the bound killed before it named a verdict (#38739 (c)). */
export const BOUND_KILL_REQUEUE = "requeued once after a verdictless bound kill"

/** Written on a 5xx hold so a later round can probe after `Reason:` truncation (27995, 32276). */
export const TRANSIENT_PUSH_HOLD = "transient GitHub 5xx"

export type AutomaticRetryHold = "bound-kill-requeue" | "transient-push-hold"

/**
 * Which automatic retry hold a standing reason carries, or undefined for a change a person must move.
 * Both predicates below read this one decision, so the two holds can never drift apart.
 */
export function automaticRetryHold(reason: string | undefined): AutomaticRetryHold | undefined {
  if (reason === undefined || reason === "") return undefined
  if (reason.includes(BOUND_KILL_REQUEUE)) return "bound-kill-requeue"
  if (reason.includes(TRANSIENT_PUSH_HOLD)) return "transient-push-hold"
  return undefined
}

/** A requeue this queue wrote for the first verdictless bound kill at a head: the queue re-runs it once. */
export function isBoundKillRequeue(reason: string | undefined): boolean {
  return automaticRetryHold(reason) === "bound-kill-requeue"
}

/** A standing stuck this code wrote for a transient 5xx; other 5xx-quoting stucks keep a manual resume. */
export function isTransientPushHold(reason: string | undefined): boolean {
  return automaticRetryHold(reason) === "transient-push-hold"
}
