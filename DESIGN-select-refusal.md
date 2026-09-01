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

---

## 7. The no-parked-state ruling — how this vocabulary maps, and what does not terminate

Operator ruling, folded in after implementation: **no parked state exists.** Every
change reaches a terminal answer — recoverable anomaly → warn, auto-fix, continue;
user-level fault → the CHANGE is rejected loudly with reason/evidence/remedy back
to its author; non-auto-fixable infrastructure fault → error, runner exits
non-zero, andon. Nothing is logged-and-continued, and nothing waits indefinitely
on a human.

The rows in §3 do not contradict this — a named refusal is the *prerequisite* for
terminating one, and before this carrier these changes were not named at all. But
a row must not be mistaken for a terminal answer, so here is the mapping, and the
places where a refusal today still stands forever.

### The hold vocabulary against {auto-fix, reject, crash}

| Hold code | Class | Terminates today? |
|---|---|---|
| `queue-base-active` | neither — pure serialization | **only if the holding run settles** (see below) |
| `claimed` | neither — the change is in flight | **only if the consuming run settles** (see below) |
| `checks-pending` | auto-fix (wait for the check) | **only if the check job settles** (see below) |
| `queue-{kind}-authority-consumed` | reject | **yes** — ejects with a durable `pr/needs-author` |
| `queue-{kind}-authority-missing` | reject, slow | **yes** — accrues to the 3-refusal `needs-person` settlement |
| eligibility `terminal` / `rejected` / `review-rejected` / `needs-author` | reject | **yes** — already terminal |
| eligibility `queue-paused` | auto-fix | **yes** — holds carry a deadline fence (`queue.ts:1370`) |
| eligibility `review-required` / `draft` | wait on a human | **no, by design** |

### Flag 1 — a `waiting` step parks forever, and no reaper can reach it

The top three rows all reduce to one structural hole. A run whose cursor step
holds a `waiting` Job is excluded by **every** reclamation path:

- `packages/yrd-job/src/jobs.ts:1126` — `if (job.status !== "in_progress") continue`.
  Lease-expiry recovery skips `waiting` **even when the caller names the runner
  dead**, so this does not need a live runner to persist.
- `packages/yrd-queue/src/queue.ts:7562` — `orphanedJoblessRuns` requires
  `step.job === undefined`. A step that HAS a waiting job is not jobless, so the
  15-minute orphan reaper skips it too.
- No job-level timeout or deadline exists for `waiting` anywhere; the only
  deadline fence in the queue is on pauses.

So the run never settles, its base stays held, and `queue-base-active` /
`claimed` / `checks-pending` stand indefinitely. `queue-liveness-wedged` (30m)
and `resident-runner-stalled-no-merge` (3h) both *report* this and neither
terminates it. This is the parked state the ruling abolishes, in its purest form.

**Correctly quantified — this is NOT "any run can park".** The installed merge
step is already protected against exactly this, in two places:
`command.ts:7544` (`throw new Error("native merge cannot wait")`) and
`command.ts:7729` (`failed("merge-command-waited", "merge commands cannot leave a
waiting external effect")`). Enumerating every `status === "waiting"` site in
`command.ts` and `queue.ts` (20 in total), those two are the only ones that
convert a wait into a failure, and both are on the merge path. **No equivalent
guard exists for check steps**, which are the shape legitimately allowed to
return `waiting` + `token` (`yrd-job/src/job.ts:39`). Someone recognised this
hazard for merge and closed it there; the check side is open. That asymmetry is
the flag, and it is the `stale-check-with-no-re-drive` offender named in the
ruling, located.

### Flag 2 — `needs-person` is terminal for the QUEUE and indefinite for the CHANGE

`queue/admission/settled` with `disposition: "needs-person"` is a durable terminal
disposition, cleared only by a new push or re-merge. That satisfies "the queue
stops retrying", but the change then waits on a human by name — and when
`.yrd.yml` configures no owner the name is literally
`"unowned — no needsPerson.owner is configured in .yrd.yml"`
(`DEFAULT_NEEDS_PERSON_OWNER`). Under the ruling this is a dead-letter that names
no recipient. Known offender, confirmed.

### Flag 3 — the fast-reject seam exists and is deliberately empty

`STRUCTURALLY_PERMANENT_ADMISSION_REFUSALS` (`queue.ts:936`) is
`new Set<string>([])`, and `structurallyPermanentAdmissionRefusal` settles a
change `needs-person` on its FIRST refusal. This is **not** a regression: commit
`c146f903` emptied it when the rewrite machinery was deleted, stating "candidates
are rebuilt by merge, so no admission refusal is structurally permanent today.
The set and its park-after-1-refusal machinery stay for the next such code."

Recorded because it is the ruling's natural landing site: this set is where the
*reject* class gets declared, and `contentVerdictAdmissionRefusal` — live, and
populated with `check-failed` ∪ `COMPOSITION_FAILURE_BUCKETS["needs-author"]` —
is the ready-made candidate membership. Note the two are deliberately distinct
today: the content-verdict set changes only **when the audit speaks**, the
permanent set changes **what the queue does**.

### What this carrier does provide toward the ruling

Persistence is now legible, which it was not. `conditions.report` already folds
repeats and escalates with "still ongoing — N repeated occurrence(s) suppressed
since the last notice", so a hold that persists without progress across passes
emits a growing, attributable record keyed on (change, codes, holder). That
counter is the hook a future "persists without progress ⇒ terminate in rejection"
rule attaches to; it does not exist here, and no row in §3 should be read as
promising the holder will ever settle.
