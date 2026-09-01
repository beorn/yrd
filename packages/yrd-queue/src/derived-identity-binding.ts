import type { BaysState } from "@yrd/bay"
import type { DeepReadonly } from "@yrd/core"
import type { QueuesState } from "./model.ts"

/** Whether a canonical recordless id belongs to the submit fact that still
 * stands. Bindings are append-only, so the submit's current sha is the fence
 * that distinguishes live identity authority from historical allocation. */
export function hasStandingDerivedIdentity(
  bays: DeepReadonly<BaysState>,
  queues: DeepReadonly<QueuesState>,
  id: string,
): boolean {
  return Object.entries(bays.submits).some(
    ([branch, submit]) => queues.derivedIdentities[branch]?.[submit.sha]?.id === id,
  )
}
