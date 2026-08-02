/**
 * Git child-process timeout policy.
 *
 * Two cost classes exist and must not share one number: PLUMBING (fast
 * metadata ops — rev-parse, config reads, ref updates) and MATERIALIZE
 * (operations that populate a working tree and run the repository's own hooks
 * inside the guarded call — `git worktree add`/`remove`). A host repository's
 * post-checkout hook can dominate the cost: hh's branch-guard materializes
 * submodules inside the add, measured at 34.15s under load against the old
 * 30s kill (@yrd/core/21679-integration-model-v2/22648-checkout-timeout).
 *
 * Consolidation candidates: the sibling `GIT_TIMEOUT_MS = 30_000` consts in
 * `repository.ts`, `pr-withdraw.ts`, and `implementation-source.ts` are
 * plumbing-class callers of the same idea; fold them onto this module rather
 * than minting a fifth local constant.
 */

/** Fast metadata git calls with no tree population and no hook execution. */
export const GIT_PLUMBING_TIMEOUT_MS = 30_000

/**
 * Tree-populating git calls that run repo hooks inside the guarded operation.
 * 3.5x the measured 34.15s worst case, so ordinary load spikes clear it.
 */
export const GIT_MATERIALIZE_TIMEOUT_DEFAULT_MS = 120_000

/** Operator override for the materializing-checkout limit, in milliseconds. */
export const CHECKOUT_TIMEOUT_ENV = "YRD_CHECKOUT_TIMEOUT_MS"

/**
 * Resolve the pre-submit checkout limit from the host environment. An unset or
 * blank override yields the default; a malformed one refuses loudly — a silent
 * fallback would revive the exact class this module exists to kill.
 */
export function resolveCheckoutTimeoutMs(environment: Readonly<Partial<Record<string, string>>>): number {
  const raw = environment[CHECKOUT_TIMEOUT_ENV]
  if (raw === undefined || raw.trim() === "") return GIT_MATERIALIZE_TIMEOUT_DEFAULT_MS
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`yrd: ${CHECKOUT_TIMEOUT_ENV} must be a positive integer of milliseconds, got '${raw}'`)
  }
  return parsed
}
