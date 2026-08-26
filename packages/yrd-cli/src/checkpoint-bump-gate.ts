import type { CheckpointMigrationManifest } from "@yrd/core"

const SHA256_PATTERN = /^[0-9a-f]{64}$/u

/** Every projection checkpoint identity this composition has SHIPPED and still
 * supports migrating from, oldest first. The LAST entry is the identity the
 * current source computes.
 *
 * WHY THIS LIST EXISTS SEPARATELY FROM THE RETAINED PREDECESSORS. The retained
 * list in `host.ts` answers "what can we migrate FROM"; this one answers "what
 * have we ever ASKED a deployment to store". The gate below asserts the second
 * is a subset of the first, and that assertion is the whole point: a
 * `projectionVersion` bump moves the computed identity, and without it nothing
 * makes the author retain the value they just superseded. Every entry after the
 * first was appended by a bump that would otherwise have shipped green and
 * stopped the fleet days later, on a seat that did not write it (23217).
 *
 * HOW TO CHANGE IT. Append, never edit the last entry in place — the value you
 * would overwrite is exactly what a running deployment's journal stores, and
 * overwriting it is how the record of a breaking change disappears. Adding a
 * retained predecessor is free: `projectionCheckpointIdentity` hashes `v`,
 * `initialState`, `events`, `replayEvents` and `projectionVersions` only, so
 * migrations are NOT an identity input and retaining one cannot move the
 * target.
 *
 * WHAT THIS LIST DELIBERATELY DOES NOT COVER, recorded rather than dropped
 * silently. Five identities this composition shipped before the gate existed
 * have no migration path today and are not listed, so the gate stays a ratchet
 * rather than an immediate wall:
 *
 *     b45cdd9c…  2026-08-18  6947a5e7  vocabulary restore
 *     690704d6…  2026-08-19  ca0fa6db  props cut
 *     5d25a0aa…  2026-08-21  99f48a8e  bays-v14 — the bump that shipped with zero migrations
 *     2267a28e…  2026-08-22  bceb93ea  retain f41d7eff
 *     fe430448…  2026-08-25  44b2aa2f  terminal-associations cut, superseded the same day
 *
 * A deployment holding one of those still refuses at startup. Retaining them is
 * a real change with a real proof obligation (the shared migrate callback has
 * only ever been exercised from the entries `host.ts` lists) and belongs in its
 * own commit, not smuggled in beside a gate. Their absence is written here so
 * the next reader sees a decision, not an oversight.
 */
export const SHIPPED_CHECKPOINT_IDENTITIES: readonly string[] = Object.freeze([
  // 2026-08-23 ac7b56bb — plan from the declared step list.
  "288eb2031f0ae914db51e4fca58add50aa39397abd773be99e81d9a35c06e817",
  // 2026-08-23 9a8eee39 — read each Run's step plan from git at its own base
  // sha. THE LIVE /hh JOURNAL STORES THIS ONE: `journal_snapshot.
  // checkpoint_identity` at cursor 91511, read read-only 2026-08-26, with
  // `history_evicted_through` = 27609 so rebuild from complete history is
  // unavailable and this edge is the only thing carrying the deployment.
  "ae0d2084bdb1202cf8205a03b4d09ccf915bcccf197e90afbe62617e7c078839",
  // 2026-08-25 42ef9a27 — change-record fat cut. Every historical retained
  // predecessor converges here before taking one forward edge, which is what
  // `RETIRED_CHANGE_RECORD_CHECKPOINT_IDENTITY` names in `host.ts`.
  "36d85bbb8b59e8a3c6c327b8f14f643816d951cd003904ac0acbe0bbca150691",
  // 2026-08-25 c344e112 — forward checkpoint repair edge. Current.
  "701431d5952e57f998e77413fe6c79dfede32f203863a5ff163b07b704ab6c25",
])

/** Whether the migration graph connects `from` to `target`.
 *
 * Reachability only, over the manifest's already-resolved edges — deliberately
 * NOT `@yrd/core`'s `checkpointMigrationPath`, which needs a live definition,
 * enumerates every path to refuse ambiguity, and raises instead of returning.
 * The gate runs against manifest DATA so a fixture can express a bump without
 * building a composition, and it must report every violation rather than stop
 * at the first.
 */
function reaches(edges: CheckpointMigrationManifest["edges"], from: string, target: string): boolean {
  const seen = new Set<string>([from])
  const frontier = [from]
  while (frontier.length > 0) {
    const identity = frontier.pop()
    if (identity === target) return true
    for (const edge of edges) {
      if (edge.from !== identity || seen.has(edge.to)) continue
      seen.add(edge.to)
      frontier.push(edge.to)
    }
  }
  return false
}

/** Refuse a ledger that cannot be checked, rather than reading it as "clean".
 *
 * An empty or malformed list would make every assertion below vacuously true —
 * a gate that reports success because it examined nothing is the failure mode
 * it exists to prevent.
 */
function assertLedger(shipped: readonly string[]): void {
  if (shipped.length === 0) {
    throw new TypeError("yrd: the shipped checkpoint identity ledger must hold at least one identity")
  }
  const seen = new Set<string>()
  for (const identity of shipped) {
    if (!SHA256_PATTERN.test(identity)) {
      throw new TypeError(`yrd: shipped checkpoint identity '${identity}' is not a SHA-256 identity`)
    }
    if (seen.has(identity)) {
      throw new TypeError(`yrd: shipped checkpoint identity '${identity}' appears twice in the ledger`)
    }
    seen.add(identity)
  }
}

/** Gate a projection-version bump at the bump, not at the fleet's next startup.
 *
 * Two failures, both of which ship green today (23217):
 *
 *   1. The composition's identity moved and no ledger entry records it — a
 *      `projectionVersion` edit, a state-shape change, a new registered event.
 *   2. A previously shipped identity has no migration path to the current one,
 *      so any deployment whose journal stores it refuses at startup with
 *      `checkpoint-migration-missing`. Eviction makes that terminal: rebuild
 *      from complete history needs `evictedThrough === 0`, and /hh's live
 *      journal has evicted through cursor 27609 since 2026-08-22.
 *
 * Returns every violation. Empty means the bump is safe to ship.
 */
export function checkpointBumpGateViolations(
  manifest: CheckpointMigrationManifest,
  shipped: readonly string[] = SHIPPED_CHECKPOINT_IDENTITIES,
): readonly string[] {
  assertLedger(shipped)
  const current = shipped[shipped.length - 1] as string
  const target = manifest.targetIdentity
  if (current !== target) {
    return [
      `yrd: the projection checkpoint identity moved from '${current}' to '${target}', and nothing records it. ` +
        "A projectionVersion bump — or any change to initialState, a registered event schema or a replay event — " +
        "is a breaking change for every live deployment. Append " +
        `'${target}' to SHIPPED_CHECKPOINT_IDENTITIES (never edit the last entry in place: the value you would ` +
        `overwrite is what a running deployment's journal stores), and retain '${current}' in ` +
        "RETAINED_PREDECESSOR_CHECKPOINT_IDENTITIES (packages/yrd-cli/src/host.ts) so a deployment can cross the bump.",
    ]
  }
  const violations: string[] = []
  for (const [index, identity] of shipped.slice(0, -1).entries()) {
    if (reaches(manifest.edges, identity, target)) continue
    violations.push(
      `yrd: shipped checkpoint identity '${identity}' (ledger entry ${String(index + 1)} of ` +
        `${String(shipped.length)}) has no migration path to the current identity '${target}'. A deployment whose ` +
        "journal stores it refuses at startup with checkpoint-migration-missing and nothing drains. Add it to " +
        "RETAINED_PREDECESSOR_CHECKPOINT_IDENTITIES (packages/yrd-cli/src/host.ts), or declare an explicit edge " +
        "from it, then measure the result against the deployment's own stored identity rather than a harness value.",
    )
  }
  return violations
}
