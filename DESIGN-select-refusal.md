# C5(1) — merge-select refusal, and the liveness deadlock

Branch `task/yrd-select-refusal-20260831`, cut from `e4be798` (the live pin).

The one-sentence spec, ruled: **a record-backed ready change must be either
SELECTED or REFUSED BY NAME on every implicit pass.** A queue that can only say
"no merge for 56 minutes" while holding two green head changes has no observable
difference between patience and paralysis.

---

## 1. The selection-predicate map, before

Everything below is in `packages/yrd-queue/src/queue.ts`, inside the selectorless
compose (`Queue.run`'s `selectorless` path).

### The population

`requestedPRs` (was :8336, now :8419) builds the implicit population once:

```
[ every record whose delivery is "submitted" | "ready", ...derived members ]
  .toSorted(bySubmitClock)
  .filter(pr => !excluded.has(pr.id))          <- the exclusion argument
  .filter(implicitBefore …)                    <- always undefined; the intent lane is retired
```

Two properties matter, and both are what made the unification safe:

- `excluded` is a **pure post-filter over an already-ordered list**. It changes
  membership, never order.
- `ChangeEligibility` never reads `excluded`. A change's runnable verdict is the
  same whatever the caller excluded.

So evaluating the population with NO exclusion set yields a strict superset, in
the same relative order, with identical per-change verdicts.

### Set A — what SELECTION excluded (four parts, in two places)

| # | Source | Where (pre-change) | Members |
|---|---|---|---|
| 1 | `consumed` | `queue.ts:3444` | changes a still-settling queue run holds |
| 2 | `pendingIds` | `queue.ts:3620` | changes whose admission checks this pass left unsettled and non-failed |
| 3 | `authorityGaps` | `queue.ts:3451` | changes ejected this pass for a missing/consumed queue authority |
| — | joined into `unavailable` | **`queue.ts:3641`** | `new Set([...consumed, ...pendingIds, ...authorityGaps.map(g => g.pr)])`, passed to `runnableChangeSelection` |
| 4 | `activeBases` | **`queue.ts:3651`** | `runnable.prs.filter(pr => !activeBases.has(baseIdentity(pr.base)))` — a **post-filter**, applied AFTER the predicate, so the predicate never learns of it |

### Set B — what the DIAGNOSTIC excluded

**`queue.ts:3699`**

```ts
const diagnostic = runnableChangeSelection(snapshot, cycleArgs, steps, needsPersonOwner, consumed, {…})
```

`consumed` **only**.

### The skew, stated

```
selection exclusions  =  consumed ∪ pendingIds ∪ authorityGapIds ∪ activeBases
diagnostic exclusions =  consumed
skew                  =            pendingIds ∪ authorityGapIds ∪ activeBases
```

### Why an hour produced zero rows

The diagnostic ran only when `prs.length === 0`, and then chose between exactly
two report branches (`queue.ts:3711` / `:3717`):

```ts
if (rejected.length > 0 || (diagnostic.decisions.length === 0 && unrecorded.length > 0)) → no-runnable-prs
else if (diagnostic.decisions.length === 0)                                             → no-submitted-prs
// (nothing else)
```

With the smaller exclusion set the diagnostic re-derived the very changes
selection had just dropped and found them **runnable** — so `rejected` was empty
while `decisions` was not, and **both branches skipped**. There is no `else`.
A change silently skipped and a change loudly refused were the same bytes.

`consumed` is worse still: it is in BOTH sets, so a change a settling run holds
was invisible to the selector *and* to the diagnostic. It could never be named
by anything.

### The half that had already shipped, and why it did not fire either

`e4be798` already carries a C5(1) partial fix: a per-pass
`compose-implicit-skip-active-base` row (old `queue.ts:3679`). It iterates
`runnable.prs` — the list produced with `unavailable` already applied. So a
change that was BOTH base-blocked and (say) checks-pending never reached that
loop at all. The acceptance test in this branch reproduces exactly that hole on
the pristine pin: two ready head changes, **zero rows**.

---

## 2. What was unified

One evaluator, `implicitSelectionAccounting` (`queue.ts`, beside
`runnableChangeSelection`). It calls `runnableChangeSelection` **once, with no
exclusion set** — the widest honest population — and re-applies each exclusion as
an attributed `hold` rather than as a filter that erases its own evidence:

```ts
type ImplicitSelectionHold = { code; reason; remedy; base?; run? }
type ImplicitSelectionRow  = { pr; eligibility; holds: readonly ImplicitSelectionHold[] }
```

`prs` is then `rows.filter(row => row.holds.length === 0)`, which is provably the
old `runnable.prs.filter(…activeBases)` given the two properties above. The set
that decides what runs and the set that explains what did not are now the same
set **by construction**; there is no second call to keep in step.

The hold ladder, in order, all four exclusions plus eligibility itself:

| Hold | Code (all pre-registered in `YRD_REFUSAL_CODES` — no new codes) | Names |
|---|---|---|
| base held by an unsettled run | `queue-base-active` | the base and the holding run id |
| consumed by a settling run | `claimed` | the consuming run id |
| checks left unsettled this pass | `checks-pending` | — |
| authority gap ejected it | `queue-{submit,checks}-authority-{missing,consumed}` | passed through from the gap |
| not runnable on its own merits | `eligibility.reason.code` | the eligibility message |

Deliberately **no new refusal codes**: this surface names states that already
exist. A `!runnable` decision with no reason now throws rather than defaulting —
same bar `queueRunNoRunnablePRs` already held.

### One behaviour deliberately left alone

The **explicit** (`--pr X`) path keeps the old pre-filtered
`runnableChangeSelection(…, unavailable, …)` call. Widening its population would
turn a named target that a settling run holds from a quiet empty result into a
`raiseFailure` — arguably better, but a different change, and the explicit
selector is the operator's cure path for exactly this incident.

---

## 3. The named-refusal row shape

Emitted per held change on **every** implicit pass, not only when the pass ends
at zero. `conditions.report` folds repeats on the key, so an hour-long hold
announces once, not once per ~66s pass.

```
key    compose-implicit-not-selected:<pr>:<code>[+<code>…]:<holder|->
level  warn
action compose-implicit-not-selected
props  { action, pr, code, codes[], remedy, base?, run? }
text   queue compose did not select change '<pr>' on this implicit pass:
       <reason> (<code>) — <remedy>[; also: …]
```

`codes[]` carries every hold, so a change held for two reasons cannot look like
it was held for one. This subsumes `compose-implicit-skip-active-base`, which is
gone; nothing consumed it.

### The third zero-event shape

`no-selected-prs` (`QueueRunNoSelectedPRsSchema`), the branch that did not exist:
changes **were** considered, every one was eligible on its own merits, and the
pass still selected none. `no-runnable-prs` cannot say this (it asserts every
considered PR was ineligible) and `no-submitted-prs` cannot either (plenty was
submitted). Logged at **warn**, unlike the empty-FIFO `info`: eligible work
exists and this pass ran it nowhere, which must never look routine.

---

## 4. The level trigger

The compose-invocation level trigger **already exists** at `e4be798`
(`packages/yrd-cli/src/run.ts`, `runRequired = true` under
`if (habitant && maintenanceDue)`): the maintenance tick always runs the queue,
and whether actionable work exists is answered by `runQueues`' own selection —
never by a second cli-side derivation of readiness. The derive lane
(`deriveRefOnlyMembers`) is level-based too: it walks every standing submit fact
each pass.

**What was missing was its proof.** `packages/yrd-cli/tests/habitant-level-run.test.ts`
was RED at the pin — and so were `habitant-plan-gate`, `habitant-memory` and
`habitant-source-recycle`, all four for one reason: the shared
`tests/support/habitant-harness.ts` stub omitted `queues.records` / `queues.index`,
the projection lookups the runner's heartbeat walks through
`habitantDriverLastMerged → queueChanges`. The heartbeat threw, the follow loop
died in its first cycle, and the level-trigger test timed out **reading exactly
like the edge-only regression it exists to catch**.

`completeState` now fills those slices centrally — the file already promised "one
structurally complete habitant-loop test app"; that promise is now kept in one
place instead of re-derived per fixture. All four suites are green.

One consequence, recorded rather than hidden: `habitant-source-recycle`'s
`expect(h.runCalls()).toBe(1)` was **measuring the crash**. With the loop alive,
a supervised habitant runs the queue once per maintenance cycle — which is the
level trigger working. The assertion now states the invariant that survives (the
queue ran on the maintenance cadence, never more often than the loop cycled)
instead of a count that only held while the loop was dead.

Production was never at risk from this: `Queues.empty()` always provides
`records`, so only hand-rolled stubs could omit it.

---

## 5. Carrier 2 — the liveness deadlock

**The refusal is already gone in vendor/yrd at `e4be798`.** `queueContentHealthError`
(`packages/yrd-cli/src/run.ts:1483`) returns `running: false` for both
queue-content findings — `resident-runner-no-progress` (:1962) and
`resident-runner-stalled-no-merge` (:2000) — and hab-core only refuses a start on
an unhealthy **admission** finding (`running: true`). The rule the mission cites
is written into that function's own doc comment: a finding admitted as service
health "must be a property the SERVICE can fix by starting, restarting, or
continuing to run — which means it can never be grounds to REFUSE that same
start."

**What was still broken is the text**, and this branch fixes it. Both findings
still carried the circular resolve line the incident reported —
`"Inspect queue audit and the habitant log before restarting the runner."` — which
in the one state it is written for tells the operator to withhold the very action
that is prescribed, and names no override because there is no gate to override.
Both now carry **reason · evidence · remedy**, say plainly that the finding gates
nothing and needs no override, and point at `yrd queue audit` and the new
`compose-implicit-not-selected` rows — the breadcrumb left where a reader got
lost.

Both new remedies survive hab-core's own circular-remedy detector
(`remedyRepeatsCommand`), which drops any step whose every clause opens with the
verb that just refused.

### Hab side, for @cto — located, not edited

All in `ag/packages/hab-core/src/service-admission.ts` (outside `vendor/yrd`):

- `:238` `habServiceHealthQuestion` — `running: true` ⇒ admission, `false` ⇒ liveness.
- `:254` `habServiceHealthBlocksStart` — the gate. Only an unhealthy **admission**
  finding refuses a start. Correct as written; the yrd-side `running: false` is
  what makes the queue-content findings pass through it.
- `:306` `remedyRepeatsCommand` — drops a remedy step that only re-invokes the
  refusing verb.
- `:338` `habServiceRefusalRemedy`, `:357` `habServiceRefusalFallback`.
- `:179` `formatHabRestartSuppression` — the OTHER refusal path: restarts paused
  because a failure budget was exhausted. This one is a real gate and names its
  override (`hab unsuppress <session>`).

**Not reproduced, and worth @cto's eye:** the report that "the restart was then
reported FAILED while supervision had actually brought the service up". Nothing
in `vendor/yrd` decides that; it is the hab-side start/readiness boundary.
`formatHabServiceStartFailure` (`service-admission.ts:203`) already carries a
comment about not "claiming a timeout proved failure", which is the same class of
error — a readiness timeout rendered as a failed start. That is the place to look.

---

## 6. Files touched

| File | What |
|---|---|
| `packages/yrd-queue/src/queue.ts` | `implicitSelectionAccounting`; `consumedBy` map; unified compose selection + per-pass rows; `no-selected-prs` schema, constructor and `reportZeroEventRun` arm; registry comment |
| `packages/yrd-queue/tests/implicit-selection-accounting.test.ts` | **new** — the acceptance test, written from the incident |
| `packages/yrd-cli/src/run.ts` | carrier 2: both queue-content resolutions rewritten to reason · evidence · remedy |
| `packages/yrd-cli/tests/support/habitant-harness.ts` | `completeState` fills the state slices the heartbeat walks |
| `packages/yrd-cli/tests/habitant-source-recycle.test.ts` | assertion that was measuring the dead loop |
