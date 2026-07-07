import type { BayState, PrId } from "./types.ts"

/**
 * The ONE PR-id mint (v0.2 rename: the three deterministic-hash mints in
 * queue.ts, workspaces.ts, and receive.ts consolidated here — the "extract on
 * the second consumer" note queue.ts carried since v0.1-a).
 *
 * PR ids are sequential per repo: PR1, PR2, … The next id is one more than the
 * highest PRn ever minted, counting both PRs in state AND the ids leases carry
 * from `new` (a worktree pre-mints its PR number so the push output, the branch
 * fallback, and the abandoned-work ref all agree). A worktree closed before its
 * first push burns its number — like a closed GitHub PR, a number is never
 * reused. Explicit ids that do not match PRn (tests, legacy C-… journals) never
 * collide with the sequence because the scan only reads PRn-shaped ids.
 *
 * Pure and synchronous over folded state — safe inside reducers (no clock, no
 * randomness), and deterministic: same journal, same next id.
 */
export function nextPrId(state: BayState): PrId {
  let max = 0
  const consider = (id: string): void => {
    const m = /^PR([1-9]\d*)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  for (const id of Object.keys(state.prs)) consider(id)
  for (const lease of Object.values(state.leases)) consider(lease.changeId)
  return `PR${max + 1}`
}
