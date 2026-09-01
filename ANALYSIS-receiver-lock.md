# The receiver-hook 102-second stall

Branch `task/yrd-receiver-lock-20260831`, cut from `e4be7989023b24e4f4733d4ab792cd6dd70b00cd` (the live `vendor/yrd` pin).

## Verdict, in one paragraph

The receiver's drain lock was never the thing that waited. Its own timeout is
`?? 0` on the receive path, so a **contender** fails instantly and loudly, with
the holder named. What had no bound at all was the **holder**: the drain's
critical section ran every result in the inbox — not just the one this push
created — and each result costs an unbounded number of git children (up to
90.4 s apiece after the retry wrapper) plus an unbounded number of journal-lock
acquisitions (30 s apiece). git's `receive-pack` applies the refs *before*
post-receive runs and then holds the client open for the hook's whole duration,
so all of that time is paid by the pusher, and when the pusher gives up the refs
stand while the change has reached nothing. No `queue audit` finding could name
what was left behind, because all 25 of them read the journal or git refs and
none reads the receiver inbox.

## The lock map

| # | Lock | Where | Timeout | Holder name |
|---|---|---|---|---|
| 1 | `<state>/receiver-inbox/drain-lock/writer.lock` | `packages/yrd-bay/src/receiver.ts:627` (was `:539`) | `options.lockTimeoutMs ?? 0` — **try-once on the hook path**, `30_000` from the CLI runtime (`packages/yrd-cli/src/host.ts:3935`) | `receiver-inbox-drain` (`receiver.ts:648`) |
| 2 | `<state>/writer.lock` — the SQLite journal | `packages/yrd-persistence/src/sqlite.ts:379`, taken at `:527` (`journal-read`), `:654` (`checkpoint-load`), `:666`, `:929` (`withMutableDatabase`, every append), `:1140` | `options.lock` is **never passed** by either `createJournal` call in `host.ts` (`:3864`, `:4095`) so git-super's default `30_000` applies | per call site |
| 3 | `<state>/receiver-init/writer.lock` | `packages/yrd-bay/src/receiver.ts:378` | `30_000` | `receiver-init` |
| 4 | `<state>/resident-runner/writer.lock` | `packages/yrd-cli/src/host.ts:3388` (`acquireHabitantRunner`), `packages/yrd-cli/src/run.ts:1124` | `0` | `queue=<id> epoch=<uuid>` / `resident-runner-probe` |
| 5 | The one primitive under all four | `vendor/git-super/src/exclusive.ts:39-62` (`acquireExclusive`, flock via `@bearly/flock`), wrapped by `packages/yrd-persistence/src/lock.ts:26-86` | `options.timeoutMs ?? 30_000` | `holder` required by the wrapper; busy becomes `createFailure({ code: "exclusive-busy" })` |

Locks 1 and 2 **nest**: the post-receive drain holds lock 1 while `intake` takes
lock 2 two or more times per result (the `bay.intake` dispatch, then
`branchSubmitted`). Lock ordering is consistent between the hook path and the
CLI runtime path, so this is not an ABBA deadlock — it is a convoy.

## Where the 102 seconds comes from

Not from any single timeout constant; nothing in the tree equals 102 s. Two
compositions both land there, and both are `3 x 30 s + hook boot`:

* **Git-retry composition.** Every git child in the receiver runs with
  `GIT_TIMEOUT_MS = 30_000` (`packages/yrd-bay/src/receiver.ts:735`). The
  receiver hook's process is wrapped in `withGitTimeoutRetry`
  (`packages/yrd-cli/src/host.ts:4080`), which retries *timed-out* git children
  with `DEFAULT_GIT_TIMEOUT_RETRY_DELAYS_MS = [200, 200]` and opens its breaker
  at `DEFAULT_CONSECUTIVE_TIMEOUT_LIMIT = 3`
  (`packages/yrd-process/src/git-timeout-retry.ts:9-10`). One stalled git call
  therefore costs `3 x 30_000 + 400 = 90_400 ms` before anything gives up.
* **Journal-lock composition.** The hook takes lock 2 for `checkpoint-load`, for
  the replay `journal-read`, and again for each append inside the drain. Three
  contended acquisitions is `90_000 ms`.

Either way, add the hook's own boot — `loadGitPushReceiver`,
`discoverYrdRepository`, `loadRepositoryConfig`, `createJournal` +
`createDefaultYrdRuntimeApp` — and the measured **102 232 ms** is accounted for
within about a second. The useful conclusion is the one both compositions
share: **the ceiling was a product of three independent per-operation bounds,
and nothing bounded their sum.**

## Why the leftover state was unclassifiable

`git receive-pack` updates refs, *then* runs post-receive. So at the moment the
pusher gives up:

* the pushed ref stands in the receiver store;
* `refs/heads/<carrier>` in the main repo may or may not have been materialized
  (`materializeCarrier`, `packages/yrd-cli/src/host.ts:2969`);
* `refs/yrd/submit/<branch>` may or may not have been written
  (`writeSubmitRefForCarrier`, `packages/yrd-bay/src/receiver.ts:1441`);
* the inbox result sits in `<state>/receiver-inbox/<id>.{prepared,pending}.json`.

The last of those is the durable, retry-safe record — and it was invisible.
Every one of the 25 codes in `YRD_QUEUE_AUDIT_FINDING_CODES`
(`packages/yrd-queue/src/model.ts:1250`) reads the journal or git refs.
`submit-interrupted` (`packages/yrd-queue/src/queue.ts:7628-7670`) comes
closest, and its discriminator is
`pr.revs.findLast((entry) => entry.submittedAt !== undefined) !== undefined` —
it requires a revision that *reached the journal*, which is exactly what a
stranded result never did. Nothing in `packages/yrd-queue/src` or
`packages/yrd-cli/src` reads `receiver-inbox`, `prepared`, or `pending` at all.

## What changed

**1. The critical section is bounded** — `packages/yrd-bay/src/receiver.ts`.
`ReceiverHookOptions.drainDeadlineMs` gives one drain pass a wall-clock budget.
The deadline is checked **between** results and never inside one, so a result is
always run to completion or not started at all: a deferral is a result still
fully `pending`, which is the state the next drain already retries, never a
half-consumed one. Omitting the option keeps today's unbounded pass, which is
what a foreground `yrd` command wants.

**2. Lock contention is a typed outcome, not a throw** — same file.
`ReceiverDrainResult` gains `deferred: string[]`, `lockBusy?: string` and
`deadlineExceeded?: boolean`. An `exclusive-busy` failure no longer escapes
`drain()`; it is recorded with the holder's own message (git-super's `busy()`
already names `holder=` and `owner=pid:`) and the waiting result ids, listed by
an unlocked `readdir`. Reporting these as `failed` would make an ordinary "some
other process is draining" read as wreckage; reporting them nowhere is the
silent fallback the field exists to refuse.

**3. The receive path names a bound and speaks** — `packages/yrd-cli/src/host.ts`.
`runReceiverHook` passes `drainDeadlineMs: 10_000` and `lockTimeoutMs: 2_000`,
and a new `drainDeferred` callback logs a warning through the hook's stderr —
which is git's `remote:` channel, so it reaches the person who pushed. The
message says the push was accepted, the refs stand, the results are durable, and
what to run if they do not clear.

**4. The leftover state has a name** — new
`packages/yrd-queue/src/receiver-inbox-audit.ts`, wired into `auditEnvironment`
in `packages/yrd-cli/src/host.ts`. `censusReceiverInbox` classifies inbox
results by the receiver's own `receivedAt` stamp against a 10-minute grace
window; `receiverInboxFindings` emits the new `receiver-intake-stranded` code.
A result inside the grace window is ordinary in-flight work and deliberately not
a finding. A result whose stamp is unreadable counts as **stranded**, because
"we cannot tell how old it is" must never resolve to "it is probably fine", and
an unparseable file is named in the message rather than dropped. The inbox path
comes from a new exported `receiverInboxDir(stateDir)` that
`createGitPushReceiver` now uses for its own default, so the census cannot drift
onto a directory the receiver stopped using and then report the empty result as
clean.

**5. A pre-existing broken guard repaired** —
`packages/yrd-queue/tests/audit-finding-codes.test.ts`. This test enumerates
every audit-finding producer and asserts the code list covers exactly what they
emit. Its end anchor for `queue.ts` was `"\nfunction latestQueueMergeMs("`, and
that function had since gained an `export` prefix, so the test threw
"re-anchor this test" **before** reaching the coverage assertion. It fails
identically on the unmodified pin, so this is not a regression I introduced —
but it meant no producer's codes were being checked, including the one I added.
The anchor now omits the prefix.

## What I deliberately did not change

* **The drain still runs on the post-receive path.** Moving it to a background
  handoff is the structurally better answer and is a much larger change: it
  needs a durable trigger, an owner, and a story for what happens when no runner
  is alive. Bounding the pass gets the pusher's latency under control today
  without inventing that machinery, and leaves the door open.
* **The journal lock's 30 s default, and the fact that a mutable journal takes
  it on every READ** (`sqlite.ts:522-529`). This is the settlement-tax surface
  the standing `settlement-drain-is-runner-owned` bead already owns. Narrowing
  it from here would be a second implementation of that decision.
* **`withGitTimeoutRetry`'s 3 x 30 s.** It is correct for what it was built for
  (N=90 drain calls at 20-40% per-call stall); the defect was that nothing above
  it capped the sum, which item 1 fixes.
* **The CLI runtime's own drain** (`host.ts:3928-3943`). It keeps its 30 s lock
  wait and its unbounded pass: it is a foreground command with no pusher behind
  it, and it is the path that clears whatever the hook deferred.
* **`materializeCarrier` and the classification git reads inside the lock.**
  Both are per-result work that the deadline now bounds in aggregate; hoisting
  them out of the lock individually would change the ordering guarantees the
  drain's comments spell out, for no additional latency win.

## Test evidence

Focused baselines were measured before any edit.

| Suite | Before | After |
|---|---|---|
| `yrd-bay/tests/receiver.test.ts` + `yrd-persistence/tests/lock.test.ts` | 61 passed, 17.09 s | superseded by the row below |
| `yrd-bay/tests/` + `yrd-persistence/tests/lock.test.ts` | not measured separately | 235 passed (14 files), 20.05 s |
| `yrd-queue/tests/receiver-inbox-audit.test.ts` (new) | did not exist | 3 passed |
| `yrd-queue/tests/audit-finding-codes.test.ts` | **1 failed** (pre-existing, reproduced on the unmodified pin) | 3 passed |
| `yrd-queue/` + `yrd-bay/` + `yrd-persistence/` (89 files) | **2 failed**, 1334 passed, 1 expected fail (1337 tests, 87 files) on the UNMODIFIED pin | **1 failed**, 1340 passed, 1 expected fail (1342 tests, 89 files) |

Net delta: six more passing tests (five new, one repaired) and zero new
failures. The two pre-existing failures on the unmodified pin are
`audit-finding-codes.test.ts > covers exactly what the producers emit` (fixed
here) and `command.test.ts > does not roll the submodule back for a
clean-headed carrier that moves the gitlink backward` (untouched: this change
goes nowhere near gitlink or submodule promotion).

The two new receiver tests were written first and both failed against the
unmodified code, characterizing today's behavior exactly:

* `expected [ 'issue/one', 'issue/three', ...(1) ] to have a length of 1 but got 3`
  — the pass ran every waiting result inside the lock, with no bound.
* `YrdFailure: yrd: writer lock is busy (holder=test-holds-the-drain-lock; owner=pid:...; contender=pid:...)`
  — contention escaped `drain()` as a throw. Note `owner` and `contender` are
  the same pid: flock across two open file descriptions blocks a process against
  itself, which is worth knowing before anyone adds a nested acquire.

`tsc --noEmit`: zero errors naming any file I changed (positive control: 33
`error TS` lines exist in that output, all in `vendor/silvery` and
`vendor/termless`, plus one pre-existing `toMatchSnapshot` typing error in
`packages/yrd-bay/tests/journal-vocabulary.test.ts` that I did not touch).

## Open risks

* **The 10 s budget is a judgement, not a measurement.** It is well above a
  healthy single-result drain (sub-second) and well under a pusher's patience,
  but it has not been tuned against a loaded fleet. It is a constant in one
  place (`RECEIVE_DRAIN_BUDGET_MS`) precisely so it can be.
* **A permanently failing result still retries every drain.** The deadline does
  not change that; it only stops one bad result from eating the whole budget of
  every subsequent push. The new audit finding is what makes such a result
  visible, and its resolution text points at the first failed result for a
  branch as the one carrying the real cause.
* **The census reads the receiver's default inbox path.** A deployment that
  passed an explicit `inboxDir` to `createGitPushReceiver` would be censused at
  the wrong directory — but the finding always prints the directory it looked
  at, so the answer is wrong loudly rather than clean quietly. Neither
  production call site passes one.
* **I could not reproduce the 102 s end to end.** The queue is in the garage and
  no runner may be started, so the timing above is derived from the constants
  and the code path, not measured on a live push. The two compositions are
  arithmetically indistinguishable at this resolution; distinguishing them needs
  a live capture of the hook's own `lock` and `append` lifecycle spans, which
  `observeYrdLifecycle` already emits.
