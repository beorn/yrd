# Running the queue

How the queue behaves while it runs: rounds, stops, stalls, health, where it keeps things, and its history. The [README](../README.md) has the overview.

## One round at a time

Every round in a queue's work directory takes that directory's round lock first, whether it comes from the service, `yrd queue run` or `yrd merge`.

- A second round waits for the first to end and names the process it waits on. Past ten minutes, a foreground command says so once more.
- The service stays healthy while it waits; its health document names the holder and when the wait began.
- The lock is a kernel `flock` on `round.lock`. Nothing takes it over: it passes when its holder releases it or exits.

## How a failure is judged

- A check that exits non-zero fails the change. It is the submitter's to fix and submit again.
- If the queue moved a gitlink while preparing the merge, it also runs that phase's checks on the queue branch with the same gitlink moves but without the change's own content. If that base passes, the failure is the change's. If it fails or cannot be judged, the change is stuck.
- Crashes, missing scripts, timeouts, a check that exits 2, and unreachable submodule remotes also make a change stuck.
- A stuck caused by the remote (a setup that could not fetch, a submodule remote that did not answer) is retried once inside the round before it is recorded. Its record then carries `Retried: 1`.
- A merge commit carries `Change: <branch>@<sha>` and `Merged-By: yrd queue main [<run id>]`, and is committed as `yrd`.
- Merging several changes as one tested batch is planned, not built.

## A stopped line

A stopped queue does no automatic checking or merging, and `yrd queue up` stays up. A stop always has a cause, and no timer ever lifts one.

- **Operator stop.** `yrd queue pause --reason <text>`. Only `yrd queue resume` lifts it.
- **Stuck stop.** A stuck change stops the line by itself, naming that change. It lifts when the change leaves the line (withdrawn or merged), or when `yrd queue resume` follows a repair. While it stands, the health probe reports unhealthy, with the stuck record's cures.
- **Maintenance stop.** `yrd queue pause --maintenance <reason>` also closes submit intake. Submit and `--dry-run` refuse with who, why, when, and the instruction to submit after resume.
- Operator and stuck stops still accept submits; the submit says who stopped the line, and the change waits.
- `yrd queue list --json` carries `stopped: {cause, change, by, since}`, or `null` while the line runs.
- An explicit `yrd queue run` works on a stopped line and leaves the stop in place.
- `yrd merge <branch>` merges on a stopped line too. Once it has merged, the stuck change is judged once more on the new queue branch; if it passes, it merges and the stop lifts.
- A leftover pause ref from an older queue format is refused with its exact ID and the command that deletes it.

## A stalled line

While a round is open, its current step has a deadline: a check's own timeout (30 minutes by default), or 30 minutes for any other step, which is only reported, never cancelled.

- The service and health reader report `queue-line-stalled` only after the deadline plus three beats (the runner's heartbeat interval, below).
- A whole-round deadline also catches a round whose steps are each on time but whose total runs over.
- With no round open, waiting changes that nobody judged for `health.stallAfter` (default 45 minutes) count as stalled. After ten minutes, `slow` is set first. A paused line never pages from this clock.
- `service-health.json` carries the runner claim under `facts.runnerClaim`, the current step under `facts.runnerPhase`, and the deadline, waiting count, oldest waiting change, last judgement and `roundOpen` in `facts.flow`.
- A `stallAfter` that is not a duration, or is under ten minutes, is refused when the config loads.

## Runner health

Every `yrd list --json` document has a top-level `runner: { state, service }`, even when the filter matches no changes.

- `state` is one of `idle`, `provisioning`, `checking`, `merging`, `deprovisioning`, `stuck`, `paused`, `silent`, `stopped` or `unpublished` (status unavailable; the terminal page may draw `?`).
- `service.kind` is `beating`, `absent`, `stopped`, `unknown` or `unreadable`. Every kind except `beating` has a `why`. Use `service.kind` to decide whether a service is running; a hand run can leave `state: "idle"` with no service.
- Renaming one of these words changes the JSON contract.

**The published claim.** The runner also publishes its health as a commit on `refs/yrd/<queue>/runner` at the remote, so any machine can read it. `runner.published` reports it:

- `signal` is `fresh`, `silent`, `absent`, `not-fetched` or `unreadable`; every signal except `fresh` and `silent` has a `why`.
- A readable claim carries the trailers `Runner`, `Started`, `At`, `Beat`, `State`, optional `Holding`, and `Since`. A bounded state adds `Deadline`. A known round plan adds `Due`, `Round` and `Candidates`. Linux runners add `Boot`, `PidNamespace` and `StartTick`.
- Writers only append new trailers at the end. Readers keep unknown trailers they find at the end and list them under `unjudgedTrailers`; they never affect a verdict.
- `phase` and `round` are each `within`, `overdue`, `unavailable`, `unbounded` or `unreadable`. `overdue` means past the deadline (or `Due`) plus three beats.
- `Beat` is the heartbeat interval in milliseconds, at least 30000. A claim is silent after three beats. An `At` more than 30 seconds in the reader's future is unreadable (clock skew).
- The runner writes a new parentless commit at every transition and heartbeat, leasing the old tip. A stopped claim frees the ref. A different live runner stops a new one with `runner-conflict`.
- The published claim only reports; it never changes queue facts or admission.

**Replacing a runner.** On Linux, a new runner takes over at once when it proves the old process is dead: same boot and PID namespace, and the recorded PID is gone or has a different start time. Otherwise it waits until the old claim goes silent, says why, and runs no round until it holds the claim. It refuses to start while the old runner is proven live or has a recent heartbeat on another host. Other platforms always wait.

## Submodule notices

When the submodule tool supports it, every round and every list or watch asks it for the current state of the child repositories. Plain Git reports this as not configured. A changed reading or an unavailable tool defers candidate work; an invalid reading ends the command with exit 2. Notify entries can subscribe with `on: [observed]` ([config.md](config.md#notifications)).

## Direct pushes in detail

Every round walks the queue branch since the queue's first record and reports each commit it did not make as a `merged-direct` record, with every gitlink it moved. The change at the front is checked again on the new base, and a push the queue was about to make onto the old base is refused by its own `--force-with-lease`. A submitted change whose head reaches the queue branch by a direct push still reads as merged, with `Merged-By: direct`.

## Where things are

**In the repository** (on the remote, and in clones that fetch these refs):

- `refs/yrd/<queue>/changes/<branch>`: each branch's history of events.
- `refs/yrd-archive/<queue>/<branch>`: the same, after archiving.
- `refs/yrd/<queue>/queue`: the queue's own record. `refs/yrd/<queue>/pause`: its pause.
- `<queue>` is encoded, so `release/stable` becomes `release%2Fstable`.

The submitter and the queue share only the remote. The submitter pushes a branch and its first record; the queue fetches it into its own clone, works in fresh checkouts, and pushes merges back. They can be on different machines.

**On the queue's machine**, the root is `git config yrd.workdir`, otherwise `$XDG_STATE_HOME/yrd` (default `~/.local/state/yrd`). Each queue gets `<host>/<repository-path>~<encoded-queue>` under it; a repository on the local disk uses `local/<absolute-path-without-leading-slash>~<encoded-queue>`.

```
~/.local/state/yrd/github.com/example/app~main/
  repo/                                          the queue's own clone; .yrd.yml is read from the queue branch
  worktrees/<run id>/[compose/]<phase>/<sha>/    temporary checkouts for composing and checking
  checks/<change>/<run id>/<phase>/<name>.log    check logs (run id: the round's start time; phase: submit or merge)
  logs/<run id>.jsonl                            the round's journal: one line when each check starts and one when it ends
  round.lock                                     the round lock; its body names the holder
  tmp/                                           TMPDIR for checks
```

`yrd check` and `yrd env` use the current repository and `git config yrd.workdir`, otherwise `<git-common-dir>/yrd`. Environments live at `<workdir>/environments/<sha-prefix>-<run id>/`, with setup and teardown logs under `<workdir>/logs/environments/<name>/`. Branch environments opened with `--bay` live under `.bays`.

## History and archiving

Each branch's history is a chain of events, one commit each, with typed trailers. The queue works out every state from these events; it never stores a status row. List, show and history reads find both live and archived histories; the same history in both places is an error.

Old ended histories can be moved out of the live namespace by hand:

```console
$ yrd queue archive --queue main --min-age 30 --state merged --limit 200 --dry-run --json
$ yrd queue archive --queue main --min-age 30 --state merged --limit 200 --json
```

- Only merged or cancelled histories qualify, at least seven days after they ended. `--min-age` is in whole days, at least seven. `--state` picks merged or cancelled (default both). `--limit` caps the count; without it there is no cap.
- The preview and the real run select the same refs: filter by state and age, oldest ending first, then the limit.
- Each history gets an `archived` event, then one atomic remote update creates the archive ref and deletes the live one. A conflict stops the pass; a remote without atomic push support is refused.
- After each move, the remote is read back. A mismatch stops with `archive-custody-readback` and exit 2; tell the queue owner the error and the ref pair before continuing.
- Archiving keeps history and does not reduce the total number of refs. It never runs from the queue loop; `.yrd.yml` only accepts `archive-after: never`.
- Submitting a new head on an archived branch brings its history back to live. Resubmitting the same merged head is still refused.

## Exit codes in detail

- `yrd queue up` does not exit on a stuck change; it holds the stopped line. It exits 2 only when no round can run: the config is gone or unreadable, Yrd's own gitlink is missing, or a round could not read its queue at all.
- It exits 0 when the gitlink of Yrd itself moved in a superproject that vendors Yrd. A supervisor set to restart it then starts the new version. That is the only way the queue moves to a new Yrd.
- A command that cannot run (no queue here, a config it cannot read) exits 2. A signal, or an error nobody caught, counts as stuck.

## Repository hooks

The queue's own Git operations never run repository hooks; put checks in `.yrd.yml`. The reason is in [development.md](development.md#why-the-queue-skips-repository-hooks).
