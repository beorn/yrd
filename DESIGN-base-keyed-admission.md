# Base-keyed admission: mechanism, why proof reuse is unsound, and the slice that is available

Branch `task/yrd-base-keyed-admission-20260831`, cut from `e4be7989`.
Line numbers are **as of this branch's tip** (my edit inserts ~80 lines, so they run
ahead of `e4be7989` in the two regions I touched). Every cite also names its symbol.

---

## 1. Mechanism map

The base sha is in the admission identity in four places, and one pass moves the pin.

| # | Where | What it does |
|---|---|---|
| 1 | `packages/yrd-queue/src/queue.ts:7186` `admissionExecutionId` | The admission execution id **is** `admission:<pr>:<revision>:<baseSha>`. `admissionJobKey` (`:7194`) derives every admission Job key from it, so admission evidence is filed under the base it was taken at. |
| 2 | `packages/yrd-bay/src/model.ts:475` `ChangeAdmissionRecord` | The durable per-revision verdict carries a required `baseSha`. This is the record `changeAdmission(pr)` returns. |
| 3 | `packages/yrd-queue/src/projection-index.ts:31` `queueLookupKey` | Every run lookup — exact-plan reuse, prefix reuse, released-failure tally — keys on `snapshot.baseSha ?? null`. |
| 4 | `queue.ts:2616` (`admitChangeRevision`, from `:2598`) | The reuse gate: `prior.baseSha === baseSha`. A different base re-proves, unconditionally. |
| 5 | `queue.ts:9268` `reusableRevisionAdmission`; `:9299` `derivedRevisionAdmissionReuse` | The merge run's prefix reuse: `admission.baseSha !== snapshot.baseSha` denies reuse; the derived half misses on the Job key from #1. So a merge run at a moved base re-executes the pre-merge steps too. |
| 6 | `queue.ts:8645` `admissionQueue`, and `:8898` | A passing admission retires a change from admission **only while** `admission.baseSha === requestedBase`. Otherwise it re-enters and re-proves. |
| 7 | `queue.ts:2363` `refreshCheckIdentities` | Re-points every carrier it is handed at the cycle base. **This is the pin-mover**: it is what makes `requestedBase` in #6 diverge from `admission.baseSha`. |
| 8 | `queue.ts:3562` (compose pass) | Handed `[...checked, ...admissible]` — **every ready carrier**, not just the ones that can land. |
| 9 | `queue.ts:1725` `createBaseResolutionCycle` | The base is resolved once per cycle from the injected `resolveBaseSha(base)`, i.e. the current tip of main. |
| 10 | `queue.ts:3695` (`activeBases` diagnostic) | The queue's own words: *"batchSize serializes one candidate per base"*. At most one candidate per base can merge per cycle. |
| 11 | `packages/yrd-cli/src/run.ts:11277`–`11325` | The freshness sweep: `if (candidateRevision.baseSha === target.headSha) skip; else executeRemergeChange(… transition admitted→refreshed)`. Re-merges every candidate whose base is not current main, minting a new revision — which has no admission at all. |

**The loop.** A merge advances main (#9 reads the new tip next cycle) → the compose pass
re-points every ready carrier (#7 over #8) → each re-pointed carrier's passing verdict
no longer matches its request (#6) → it re-enters admission and re-executes every
pre-merge step (#4), and if it reaches a merge run at a moved base it re-executes them
there too (#5). Only one of them can merge (#10). The other `n - 1` verdicts were
discarded to buy nothing.

Measured cost: PR2059 admitted at 14 distinct bases across 56 attempts, PR1073 at 13,
PR2145 at 8 over 25, against a 67–100 hour backlog while merges themselves take 1–3
minutes.

**One thing the map corrects.** `admit`-only passes do *not* invalidate: I probed a
selectorless `queue.admit` across a base move and the waiting change kept its verdict,
because `admissionQueue` (#6) had already retired it and `refreshCheckIdentities` is
only handed what is in that queue. The invalidation is specifically the **compose**
pass's broad refresh (#8). That matters for the fix: the seam is *who gets re-pointed*,
not the key.

---

## 2. Candidate shapes, against the real code

### (c) Content-keyed admission — already rejected, not re-proposed

Recorded unsound: a base delta that adds a dependency is invisible to a content key.
Note the codebase already has a sound content identity for a *different* job —
`packages/yrd-queue/src/binding-key.ts`, which binds **verdicts and reviews** to a
change's own contribution. Its header is explicit that it keys the change against a
given base and moves when that contribution moves. It is not, and cannot be, an
admission key.

### (b) Cheap structural revalidation of an existing proof — **unsound as posed**

The proposal: after a merge, a proof taken at `main_old` stays valid if `main_new` is
`main_old` plus exactly the predecessor's merged result.

It does not hold. The checks ran on `tree(merge(main_old, C))`. What must be green to
merge is `tree(merge(main_new, C))`. Those are different trees whenever the predecessor
changed any file, which is every real merge. The predecessor may add a dependency,
tighten a lint, change a shared fixture, or rename a symbol `C` calls. Accepting the old
proof is exactly the unsoundness (c) was rejected for, re-derived from ancestry instead
of content — and ancestry is the weaker evidence of the two.

The one sound version is tree identity: transfer the proof iff the newly composed
carrier's tree object id equals the tree already proved. That is correct and nearly
always false, since any base delta changes the merged tree. It would fire only for
empty-effect predecessors. Not worth building.

**Conclusion: no proof taken at `main_old` can soundly cover `main_new`.** The mission's
implementation acceptance — *"A merges → B's proof SURVIVES and B merges without
re-running checks"* — is not reachable without proving against the base B will actually
merge onto, i.e. without speculation. **That is the finding**, and it is the one thing
in this memo I would ask @cto to overturn explicitly if they disagree.

### (a) Key on (tip, projected base) — this **is** chaining, deferred by ruling

To key on the projected base you must first *have* it: the projected base for position N
is the carrier of position N−1, which means composing N on top of N−1's carrier. That is
the chaining machinery, plus its eviction discipline (a failure at position K
invalidates every carrier after K). It touches `prepareCandidate`, `resolveCandidateBaseSha`
(`queue.ts:2382`), the candidate pool, the freshness sweep (#11), and eviction. Correct
direction, correct convergence with Zuul/Bors/GitHub — and squarely the deferred
throughput feature (5.5 → 1.2 builds per merge). Not a slice.

### (d) What I implemented — spend the base move only on carriers that can use it

The asymmetry the map exposes: a cycle can land **one** candidate per base (#10) but
re-points **all** of them (#8). Every re-point past the first discards a passing verdict
that nothing this cycle could have spent, and the carrier pays for it again on the next
base move, and the one after that.

So: narrow **who** is re-pointed to the carriers inside the landing window — the first
partition per base, in the queue's own merge order — plus every carrier that holds no
passing verdict yet.

This changes scheduling only. It never widens what counts as a proof: a change still
merges only on a verdict taken against the base it merges onto. It is not speculation
and it does not chain, which is precisely why it is available while chaining is deferred.

**Why the PR943 invariant survives** (`@yrd/core/refresh-coverage-gap`, the rule stated
in caps at `queue.ts:2364`: the refreshed set must be the set the drain admits from). A
carrier left un-refreshed keeps a request and an admission that name the *same* base —
exactly the shape `admissionQueue` retires structurally (#6). So it is not admitted
either. The two sets stay identical, by the same structural mechanism the existing
comment at `queue.ts:3553` already relies on for carriers held by a live run.

**Why author feedback is not traded away.** A carrier with no passing verdict for its
current revision is *always* re-pointed (`spendableAdmission`, `queue.ts:8559`). A first
proof is not a re-proof. What the filter removes is the 2nd through 14th proof of an
unchanged tree — which is exactly the measured waste. It also keeps derived (recordless)
members refreshing: they are absent from `runnablePRs` by construction and so never in
the window, and the carve-out is what covers them.

**Starvation.** A head-of-line carrier that cannot merge drops out of `runnablePRs`
(needs-author, refused, paused), so the window advances past it. Carriers behind it are
not blocked by the filter — they are simply not churned; they keep verdicts and requests
that already agree.

**Expected effect.** For a queue of `n` on one base, the discarded-verdict count per
drain falls from `n − 1` to 0, and a carrier's total proofs fall from *one per base move
while it waits* to *two*: one for its author, one for the base it merges onto. PR2059's
56 attempts become 2.

---

## 3. What I implemented, and what I deliberately did not

**Implemented** — `packages/yrd-queue/src/queue.ts`, three edits, no new state, no new
event, no config:

- `spendableAdmission(pr, selected)` (`:8559`) — does this carrier hold a passing verdict
  for this plan, i.e. is there something a re-point would destroy?
- `landingWindow(state, steps, needsPersonOwner)` (`:8594`) — the first partition per
  base, built from the same `runnablePRs` + `partitionCandidates` pair that
  `freshnessCandidateBatches` (`queue.ts:4270`) already uses, so the window is the merge
  order, not a second opinion about it.
- The compose pass (`:3562`–`:3576`) filters `refreshable` through the two. **Selectorless
  only** — an explicit selection names its own targets and is untouched.

**Not implemented, deliberately:**

- Any change to the admission key, the Job key, the projection key, or the stored
  `baseSha`. The key is not the defect; what the key is *applied to* is.
- Any proof reuse across a base move (unsound — §2b).
- Chaining / projected bases (deferred by ruling — §2a).
- The freshness sweep (#11, `yrd-cli/src/run.ts`). It has the same shape — it re-merges
  every candidate whose base is not current main, not just the ones that can land — and
  the same narrowing applies. I left it alone because it is a second package and a
  second review surface, and because the queue-side filter is what the P0 names. **It is
  the obvious follow-on and should be beaded.**

---

## 4. Test evidence

New file `packages/yrd-queue/tests/base-keyed-admission.test.ts`, three tests.

**Characterization (pass at `e4be7989`, before any source edit)** — these pin today's
behavior and stay green either way:

1. *"re-executes the check of an untouched candidate after a sibling merge moves the
   base"* — A and B both prove at `BASE`; A merges; B's revisions are asserted unchanged;
   the next drain turn re-executes B's check at the new base and rewrites both its check
   request and its admission to it.
2. *"discards a passing proof for every change still waiting when a merge lands"* —
   three changes, five check executions to land three, each repeat at a distinct base.

**The fix's own test:**

3. *"leaves a passing verdict alone while its change cannot land, and spends it when it
   can"* — three changes drained by a runner that composes one candidate per turn.
   Per-change check executions are `[1, 2, 2]` (5 total) with the filter, and `[1, 2, 3]`
   (6 total) with it disabled — measured both ways by toggling the one expression. The
   third change's proof at the base the *first* merge produced is the one that
   disappears; it was destroyed unspent by the second merge.

The tests record the **base each check ran against**, not a count: a bare count cannot
tell a re-proof from a retry.

**Suite:** see §5 for the before/after numbers on the full `packages/yrd-queue/tests` run.

**Typecheck:** `bun run typecheck` reports zero errors in `packages/yrd-queue/src/queue.ts`.
Pre-existing errors elsewhere (`vendor/termless` missing `@types/upng-js` and `gifenc`,
`packages/yrd-bay/tests/journal-vocabulary.test.ts` `toMatchSnapshot`) are untouched by
this branch — the only file I changed is `queue.ts`.

---

## 5. The decision I need from @cto

**Is scheduling-only acceptable as the P0 fix, given that proof *survival* is
unreachable without speculation?**

The P0 as written asks for an admission that a merge does not invalidate. §2b argues no
such thing exists soundly: a verdict at `main_old` does not cover `main_new`, and every
scheme that pretends otherwise is the rejected content argument in a different costume.
What is reachable without chaining is *not minting verdicts that cannot be spent*, which
removes the same measured cost (PR2059: 56 attempts → 2) by a different route.

If that is the wrong trade — if the fleet would rather keep proving every waiting
carrier every cycle so authors see checks move — then the P0 has no fix short of the
deferred chaining work, and the honest answer is to un-defer it rather than to ship a
narrower proxy.

Secondary, lower stakes: **should the freshness sweep (`yrd-cli/src/run.ts:11277`) take
the same narrowing in the same change, or a follow-on bead?** I left it out; it is one
package away and would double the review surface.
