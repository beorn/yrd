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
 * target. One noted exception: a never-deployed identity introduced and removed
 * between deployments may be delisted, with a dated comment.
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
  // 2026-08-25 c344e112 — forward checkpoint repair edge. THE LIVE /hh
  // JOURNAL STORES THIS ONE: journal_snapshot.checkpoint_identity at cursor
  // 92592, read read-only 2026-08-26, history_evicted_through 27609 — the
  // retained edge is the only thing carrying the deployment across.
  "701431d5952e57f998e77413fe6c79dfede32f203863a5ff163b07b704ab6c25",
  // 2026-08-26 — 22991 phase 2, first store-deletion door: initialState no
  // longer seeds queues.authority.statuses (the stored ChangeDeliveryState
  // copy); delivery state derives from the change record and the submit
  // facts at read time. SHARED MAIN'S VENDOR PIN COMPUTES THIS ONE: the
  // composition at 18d9b83dbb19 — what the running yrd-runner loads — hashes
  // to exactly this identity, so it is the value every deployment is asked to
  // store until the entry below lands. Retained across the bump in
  // RETAINED_PREDECESSOR_CHECKPOINT_IDENTITIES (packages/yrd-cli/src/host.ts).
  "381cdb9edee92b0988087ae0fab8bb365b59069224ef47dc6b881dbde735808c",
  // 2026-08-28 bd1c0b88 — `CandidateChange.containedInBase`: the queue records
  // whether the base already contained the member's authored head at the site
  // that measures it, instead of three tautologies re-asking it of the
  // collapsed candidate. The field is OPTIONAL, so no stored record needs
  // rewriting — but the identity hashes the ACCEPTED INPUT shape, and an
  // optional property is still a new key in it, so the identity moves all the
  // same. That is the trap this entry records: an additive, migration-free
  // schema change reads like it cannot move the identity, and it does.
  // bd1c0b88 shipped the move on upstream main without recording it here and
  // it arrived through the merge f901bb83; the gate below is what caught it,
  // exactly as designed. Every commit in 18d9b83dbb19..HEAD was probed
  // individually and only two identities exist across the whole range, so no
  // intermediate value exists for a deployment to be stranded on. Current.
  "74775b5709b3cf9ef1ef3cfaae63013e486aa09d6386e01bf17d4482557203f1",
  // 2026-08-30 — @i/10-yrd/absent-branch-is-terminal: the queue retires a
  // standing submit fact whose candidate cannot merge, so the derived lane
  // stops re-deriving it. THREE identity inputs move together and none of
  // them rewrites a stored record: `queues.retiredSubmits` joins
  // initialState, `queue/submit/retired` joins the registered events, and
  // `Candidate.conflicts` is a new optional key in an accepted input shape
  // — the same trap the entry above records. A checkpoint written before
  // this simply has no `retiredSubmits`; `fillMissingStateFromInitial`
  // supplies the empty record on the way in, exactly as it does for
  // `bays.submits` at 61773b43, and replay resumes after the stored cursor.
  // The predecessor retained below is this ledger's own superseded last
  // entry — what the project has ASKED every deployment to store since
  // 2026-08-28 — not a harness value (the PR1305 / R2732 lesson above).
  "1d285ebf24b688b75dbca2c5101a5f1e85cf70ab004a5ca400be89a57daf53d4",
  // 2026-08-31 — the no-parking ruling, TWO schema widenings landing together.
  // Lease recovery reclaims a WAITING job whose runner is dead, so the `lose`
  // Job transition gains an optional `token` (a waiting job's fence, the way
  // `leaseExpiresAt` fences a running one) with `leaseExpiresAt` optional
  // beside it; and the reject class needs the check's own judgment, so
  // `queue/admission/refused` gains an optional `judgedFailure`. All three are
  // new optional keys in accepted input shapes — the same identity input
  // `Candidate.conflicts` and `CandidateChange.containedInBase` moved before
  // them. Nothing rewrites a stored record: every `lose` ever journaled carries
  // `leaseExpiresAt` and no `token`, no refusal fact carries `judgedFailure`,
  // and both are exactly what the widened schemas still accept; replay resumes
  // after the stored cursor. The predecessor retained below is this ledger's
  // own superseded last entry — what the project has ASKED every deployment to
  // store since 2026-08-30. The interim identity a9b486dc existed only between
  // two same-garage-window fast-forwards (2026-08-31→09-01) while the queue
  // runner was off; no deployment ever stored it; delisted under a
  // never-deployed rationale — distinct from the five shipped-but-unlisted
  // identities (fe430448 et al.), whose exclusion has acknowledged startup
  // cost.
  // Retained predecessor.
  "fd6a78dfadab8397265aaa36309c18cb69794cead6b0577f0982f1c1c1ee1f5c",
  // 2026-09-01 — the selectorless compose journals one exact branch+sha to
  // derived-member identity binding before a Candidate or run exists. The
  // queue gains an empty `derivedIdentities` projection, one registered event,
  // and queues-v12; the retained predecessor above supplies the empty record
  // to stored checkpoints before replay. Retained predecessor.
  "3f8a2627fde94c410a98beaed80e2198298baea1fb8a5b533f3e71231e8faafa",
  // 2026-09-01 — journal-v4 reader PREP. Existing Job, Bay, and Queue facts
  // gain optional, field-gated semantic markers while every event keeps its
  // shipped reader version; Jobs advances to v9 so cancelled/skipped retry
  // facts can project only after carrying their exact marker. The host writer
  // remains explicitly v3, so this is reader capability, not activation. A
  // checkpoint at the predecessor above already has valid state: all added
  // fields are optional, Jobs advances to v9, Queue advances to v13, and the
  // shared migration preserves existing state verbatim.
  // Retained predecessor.
  "2498f5d42e338959e6b67e49b4b78c9939bb0f94ca3e9b506bcef39276b9c6a5",
  // 2026-09-01 — `yrd pr retire`: one verb retires one revision's two
  // receiver-store rows in one journaled act. The queue registers ONE new
  // event, `queue/revision/retired`, projected into the EXISTING
  // `queues.retiredSubmits` row shape — no new projection key, no stored
  // record rewritten. A registered event is an accepted input shape, so the
  // identity moves all the same (the bd1c0b88 trap above); a checkpoint at
  // the predecessor replays after its stored cursor unchanged. An interim
  // identity f800b079 existed on this branch only while the fact's who-field
  // was still spelled with the retired role noun; no deployment ever stored it,
  // so it is deliberately not retained. Retained predecessor.
  "7ea283b896818c5252981498fd85fa312a8dc58eec45101449b5212c5042c074",
  // 2026-09-01 — every queue outcome ends in exactly one ball
  // (@i/10-yrd/24028). The queue registers ONE new event,
  // `queue/attempt/notified`, projected into a NEW `queues.outcomes` record
  // keyed by attempt id (queues-v14), and the derived submit fact
  // (`branch/submitted`) gains an optional `notify` seat. A registered event
  // and a widened accepted shape both move the identity; a checkpoint at the
  // predecessor simply lacks the empty `queues.outcomes` record, which
  // `fillMissingStateFromInitial` supplies before replay resumes after its
  // stored cursor. Current.
  "ca7e3d9577514291a125a9b003182b400f8495f79c2187f9aefea318d457ba56",
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
