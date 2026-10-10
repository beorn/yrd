# Yrd

Yrd is a merge queue that lives inside a Git repository. A queue runs on a branch, `main` for most repositories. A change is another branch, submitted to that queue.

- **Submit a branch, get a result.** You commit your changes on a branch and submit it. The queue checks it in a fresh checkout, merges it into the queue branch, and tells you what happened.
- **No server, no database, no web page.** Queue events live under `refs/yrd/<encoded-queue>/`; archived histories live under `refs/yrd-archive/<encoded-queue>/`.
  Fetch both namespaces to read the complete retained history with plain `git log`.
- **One process, one machine.** By rule it is the only writer of the queue branch. A direct merge is detected and reported, not prevented.
- **Superprojects.** Yrd also queues a repository of repositories held together by submodules, which no other merge queue we know of does. See [Superprojects](#superprojects).

## What it was made for

- **Agents are fast.** Checks run on the machine that holds the queue, so the time per change is the time your checks take. No hosted runner queue stands ahead of you.
- **One repository, many writers.** Without a queue, branches race to the queue branch, and some are tested against a queue branch that has already moved.
- **A repository of repositories.** A product that vendors its parts as submodules needs a queue that reads submodule pointers, not one that merges them blind.
- **Nothing to run but git.** The queue's memory is the repository. Back up the repository and you have backed up the queue; clone it and you can read the queue.
- **Use it** when a team, human or not, merges many changes into one repository or one superproject on one machine, and a hosted forge is storage rather than process.
- **Do not use it** when you want a review web page, hosted runners, or many machines checking in parallel. Yrd runs one queue process, and a check is a command it runs locally.

## Terms

- **change**: one branch at one commit, submitted to the queue; the nearest everyday thing is a pull request without a number or a review. Its name is `<branch>@<sha>`. Move the branch and submit again for a new change. A branch pushed and not submitted at that head, and not already on the queue branch, is a **draft**: the list and the watch show it, and the queue does not check or merge it until it is submitted.
- **submitter**: whoever ran `yrd submit`, a person or an agent, named by `--submitter` or `YRD_DEFAULT_SUBMITTER`. The queue passes that string to the notify commands and reads nothing into it.
- **queue branch**: the branch the queue runs on and merges into, selected with `--queue <branch>` or defaulting to `origin/HEAD`. A change's own branch is the change's branch.
- **check**: one command the queue runs, on submit or on merge, named in `.yrd.yml` on the queue branch.
- **result**: pass, fail or stuck, of a check or of a queue run. A fail is the submitter's: the check ran and its command exited non-zero. Stuck means the queue itself cannot go on with that change (a crash, a missing script, a check past its time limit); the change waits in line for repair and is nobody's fault, and the line stops until the change leaves it, withdrawn with `yrd queue withdraw` or merged. `yrd merge` lands a repair ahead of it and judges the stuck change again.
- **change record**: one commit on the change's own ref recording one step and its result: opened, checked, merged, failed, stuck, withdrawn, sent. Records are written once and never rewritten.
- **queue run**: one round of the queue. `yrd queue run` does one; `yrd queue up` does one every interval, on a loop, which is how the queue runs under whatever supervisor you use.
- **gitlink**: a submodule pointer, the commit a superproject records for one of its submodules.
- **direct merge**: a commit on the queue branch that the queue did not make, what GitHub calls a direct push. Reported, never prevented.

## States and legend

The queue surface uses ten state names (ruled 2026-09-16, v3, with deferred), each stating what it means and what happens next. The same table feeds the live watch pane (`?` help overlay) and `yrd list --help`:

| State       | Meaning                                                      | What happens next                   |
| ----------- | ------------------------------------------------------------ | ----------------------------------- |
| `draft`     | pushed to the remote, not submitted                          | `yrd submit`                        |
| `submitted` | in the queue, waiting for its first check                    | the runner checks it                |
| `checking`  | the runner is testing it now                                 | `pending`, `stuck` or `failed`      |
| `pending`   | checks passed; waiting in line to merge                      | merges when the line reaches it     |
| `merging`   | the runner is writing main for it now                        | `merged` or `failed`                |
| `merged`    | on the queue branch; ended                                   | nothing; a revert is a new change   |
| `deferred`  | checks exceeded the normal bound; waits for the long check   | runs in the long tier               |
| `stuck`     | the queue could not judge it and stopped the line (ADR-0015) | repair and resume, merge, or cancel |
| `failed`    | check exited non-zero; ended                                 | author fixes and resubmits          |
| `cancelled` | withdrawn with `yrd cancel` (or `yrd queue withdraw`); ended | resubmitting re-opens it            |

A direct merge that reached the queue branch without going through the queue is reported as `direct` apart.

## Commands

```
yrd submit [branch] [--submitter <agent>] [--issue <id>] [--dry-run]   verify and push the unchanged branch head (the current one when none is named); same head again is a retry
yrd submit [branch] --prepare [--submitter <agent>] [--issue <id>]   retain moved child commits before lock regeneration; leave the root branch and change unopened
yrd submit --gitlink <path>=<full-sha> [--gitlink ...] --issue <id> [--submitter <agent>] [--dry-run]   build and submit an exact-parent root carrier for remote-held component commits
yrd merge <branch> [--submitter <agent>] [--issue <id>]      merge the branch now, ahead of the line and on a stopped line too: submit it unless its change is in line, then run its checks and its merge in this process
yrd queue run                                                     one queue run; a round already running in the queue's workdir finishes first
yrd queue up [--interval <seconds>]                               queue runs on a loop, every 15 seconds by default; run this under your supervisor
yrd queue pause --reason <text> [--notify <seat>]                        stop checking and merging; submits are still accepted and wait in line
yrd queue pause --maintenance <reason> [--notify <seat>]                stop checking, merging and submit intake for a fenced migration
yrd queue resume [--reason <text>] [--notify <seat>]                       lift a pause or a stuck stop; checking and merging resume on the next service interval
yrd queue withdraw <branch> [--reason <text>] [--notify <seat>]           end the branch's open change and take it out of the line; the branch stays, and resubmitting re-opens it
yrd queue list [filter...] [--latest] [--watch]                   the watch's page, once: the top line with status on the far left, queue pills, the RUNNER box aligned with ISSUE / BRANCH in status color, then rows with columns TIME, [Q], [RUN], ISSUE / BRANCH, STATUS, WHO, AGE / RUN; plain when piped; `yrd list` is the same command, and `yrd list --help` prints what each state word means
yrd watch [filter...]                                             `yrd queue list --watch`: on a terminal, the live pane — keyboard and mouse (click selects, wheel scrolls, drag copies), detail on Enter, `w` for every draft instead of the last seven days', `?` for the keys and the state words, STATS below (clickable fold, fills pane width)
yrd queue stats [--since 3h|<time>|<sha>] [--by submitter|branch] merged, failed, same-head retries, re-pushed branches, drafts (pushed, never submitted: heads off the queue branch, outside yrd/* and preserve/*, committed within the window; a head not fetched here is counted apart, and nothing is fetched), opened→merged latency; a malformed ref at the remote fails it loudly
yrd queue show <branch>                                           that branch's change segments, newest first, each with its events and ending
yrd queue show --all --json                                       every branch's change segments in one document, grouped by branch name
yrd check <name...>                                               run the named checks here, now, in a fresh checkout of HEAD
yrd env open ([commit] | --bay <name> | --issue <ref>) [--hold <reason>]  retain a commit detached, or open/adopt a task branch; print path
yrd env list                                                      list this repository's retained environments
yrd env close <path> [--retain <directory>]                       run teardown and remove a clean, unlocked environment; retain submodule stores
```

Queue commands and `yrd submit` take `--queue <value>`, never a positional queue. Inside a clone, a branch selects that queue at `origin`; omission reads the remote's `HEAD`. A portable address such as `beorn/hh@main` or `beorn/hh@release%232026` selects a repository and queue together; `%23` means a literal `#` in the branch. Encode a literal `@` as `%40` and `%` as `%25`. The legacy exactly-one-`#` address, such as `beorn/hh#main`, still reads for branches without `#`. `queue run`, `up`, `pause` and `resume` accept an address outside a clone and always use a queue-owned clone, including when invoked inside another clone. Submit, list, show and watch still require a clone; addressed ordinary submit keeps the author's checkout and sends to the selected repository. Pin-only submit uses the queue-owned clone. `yrd merge` runs its round in the queue-owned clone and submits from the clone it runs in; outside a clone it merges only a change already in line.

Pin-only submit requires existing root gitlink paths, full component commit SHAs fetchable from their declared remotes, and `--issue`. It captures the advertised target tip, builds one commit with that tip as its sole parent and only the requested gitlink hunks, and submits through the normal atomic branch/change publication. One pin gets `pin/<path-with-dashes>/<sha12>`; several get `pin/<sorted-paths-joined-by-+>/<digest12>`. Option order does not change that name. The commit carries `Refs: <issue>`. `--notify` remains an alias for `--submitter`. `--dry-run` reports the generated branch, commit, captured target and verification without writing a branch or remote ref. A branch operand, a malformed or redundant pin, an unheld SHA, an already-open matching pin set, and an occupied draft name all refuse with a reason. An ended carrier name is recut at the current target under `-r2`, then `-r3`. After a target advances, the existing queued carrier is composed by the queue; resubmission is unnecessary.

Every command takes `--json`. `yrd submit` refuses the queue branch itself: it is not a change. `yrd check` checks out HEAD afresh, so uncommitted changes are not seen.

**`yrd list --json` runner.** Every list document has a top-level `runner: { state, service }`, including a filtered document with zero `changes`. It describes the whole queue, independent of the filter. `state` is a word from the complete `RUNNER_STATES` ∪ `RUNNER_SIGNALS` contract: `idle`, `provisioning`, `checking`, `merging`, `deprovisioning`, `stuck`, `paused`, `silent`, `stopped`, or `unpublished`. `unpublished` is the machine word for status unavailable; the human page may draw `?` for it. `service.kind` is `beating`, `absent`, `stopped`, `unknown`, or `unreadable`. The service has a `why` string exactly when its kind is `absent`, `stopped`, `unknown`, or `unreadable`; `beating` has no `why`. A previous hand-run journal may leave `state: "idle"` without a resident poller, so readers use `service.kind` to decide whether the service is beating. Renaming a runner word changes this JSON contract.

The same document also carries `runner.published`, read from `refs/yrd/<encoded-queue>/runner` at the queue remote, even when the selected change list is empty. Its `signal` is `fresh`, `silent`, `absent`, `not-fetched`, or `unreadable`; `why` appears exactly for `absent`, `not-fetched`, or `unreadable`. When an advertised object is missing locally, the reader acquires the current ref once and reads the acquired commit, which may differ after a parentless heartbeat. `not-fetched` names a failed acquisition or an acquired object still missing locally; `absent` also covers a ref removed since advertisement. Indeterminate object queries and invalid or skewed claims remain `unreadable`. These observation failures do not change the local runner state or service facts. A readable claim carries the verbatim `Runner`, `Started`, `At`, `Beat`, `State`, optional `Holding`, and `Since` trailers. Bounded states add `Deadline` after `Since`; old claims without it remain readable and report `deadline unavailable: writer predates Deadline`. Trailer order is append-only: writers add a new trailer only after the current last one, never between existing trailers. Readers validate known trailers in order and retain unique future trailers only at the end of a complete claim. They expose these verbatim in `runner.published.claim` and name them under `unjudgedTrailers`; unknown values never affect the current reader's freshness or phase verdict. The separate `phase` judgment is `within`, `overdue`, `unavailable`, `unbounded`, or `unreadable`, with `overdue` strictly after Deadline plus three Beats. A known line plan adds `Due`, `Round`, and `Candidates` together after `Deadline`: `Round` is fixed at round open, `Candidates` is the positive count read from that round’s line observation, and `Due` is `Round` plus the declared whole-round bound. The separate `round` judgment uses the same five statuses and is overdue strictly after Due plus three Beats. Before the line is read, `round` is `unavailable`; an idle or stopped runner is `unbounded`. Older readers preserve these appended trailers as unjudged names. `Beat` is integer milliseconds (at least 30000); a claim is silent strictly after three Beats, and an `At` more than 30 seconds in the reader's future is unreadable as clock skew. The runner writes a parentless root commit at each transition and heartbeat, leasing the old ref tip. A stopped claim relinquishes the ref for a replacement runner; a different live fresh identity stops the new runner with `runner-conflict`. The published claim reports service activity across machines and does not change queue facts or admission. `runner.state` and `runner.service` retain their local reading for existing consumers.

The published-signal readers are the list builder in `queue-core-commands.ts` (passes the observation through), `watch-runner.ts` (only `fresh` and `silent` affect the published health word; other signals retain their reason), and the host integration `tools/agent-rig/skills/tent/scripts/dark-work-legacy.ts` (accepts only `fresh` or `silent` as parsed claims and rejects other values by name). The host integration fix travels with this component pin. Older pinned integrations import their own pinned runner reader rather than decoding a newer CLI JSON document; the claim trailers and publication format are unchanged.

On Linux, a replacement Yrd runner process can recover promptly when it proves the previous process is dead. Otherwise startup waits for the previous runner's heartbeat to time out, reports why, and starts no queue rounds until it acquires the remote health claim. Startup refuses a duplicate when the previous runner is proven live or has a recent heartbeat on another host. Other platforms use the heartbeat wait.

Linux runners append `Boot` (Linux boot ID), `PidNamespace` (PID namespace), and `StartTick` (process start time in kernel ticks) together after the existing claim trailers. A replacement with the same boot and namespace takes over immediately when the recorded PID is absent or its start tick differs. A present PID with the same tick is live; permission denial from the PID probe means present, but an unreadable start identity remains unproven. Legacy, partial, or different-domain identities also wait until the claim is silent. Unreadable fields name their path and errno in the wait message. Each takeover uses the same exact-tip leased ref update, so simultaneous replacements select one winner.

**A stopped line.** A paused queue does no automatic checking or merging, and `yrd queue up` stays up and visible. A pause has a cause. `yrd queue pause` is an operator's, and only `yrd queue resume` lifts it. A stuck change stops the line by itself: the queue pauses naming that change, and the stop lifts when the change leaves the line (withdrawn with `yrd queue withdraw`, or merged) or when `yrd queue resume` follows a repair of the queue. No timer ever lifts a stop. While a stuck stop stands, the service's health probe reports unhealthy with the stuck record's cures, and it clears when the stop lifts. Operator and stuck stops still accept work: submit and dry-run succeed, echo who stopped the line, and wait behind it. A maintenance stop closes submit intake for a fenced migration; submit and dry-run refuse with the actor, reason, time and instruction to submit after resume. `yrd queue list --json` carries `stopped: {cause, change, by, since}`, `null` while the line runs. An explicit `yrd queue run` is permitted while stopped and leaves the stop in place. `yrd merge <branch>` merges on a stopped line too: its round works that one change, so a stuck change ahead of it does not hold it back, and once it has merged, the stuck change the stop names is judged once more on the new target. If that passes, it merges and the stop lifts. A stop that still stands is said, with the command that merges what it waits on.

Queues use event authority exclusively. The completed Record-to-Event transition retired its maintenance pause ref and temporary release writer. A surviving legacy pause ref refuses with its exact OID and leased deletion command. Historical paired release events remain readable, including validation of matching resumes and incomplete pairs. Live pause, resume and stuck recovery use the queue's Ops snapshots.

**A stalled line.** While a round is open, its current check or step carries a declared Deadline. A check uses its declared timeout (30 minutes by default); a non-check step uses a 30-minute detection bound and is not cancelled when that bound passes. The service and health reader page with `queue-line-stalled` only after Deadline plus three Beats. Each step transition moves `Since` and Deadline. A fixed whole-round Due catches a round whose individual phases remain within bound but whose total exceeds its declared plan; phase and total pages share the runner claim and use the same cause locally and remotely. `service-health.json` carries the same claim under `facts.runnerClaim`, the current name under `facts.runnerPhase`, and Deadline in `facts.flow` when flow is known. A bounded legacy claim with no Deadline uses the labelled 45-minute fallback. With no round open, changes waiting with no judgement still use `health.stallAfter` (default 45 minutes), counted from the later of the last judgement and the oldest waiting change's opening. A paused line never pages from this clock, and a stuck stop keeps precedence. `facts.flow` also carries waiting count, oldest waiting change, last judgement, `unjudgedForMs`, and `roundOpen` with the current phase or why it was unreadable. Past ten minutes with no judgement, `slow` is true there before any page. A `stallAfter` that is not a duration, or is shorter than ten minutes, is refused when the config loads.

**One round at a time.** Every round in a queue workdir takes that workdir's round lock first: the service's, `yrd queue run`'s and `yrd merge`'s. A second round waits for the first to end and names the process it waits on. Past ten minutes a foreground command says so once more. The service stays healthy while it waits, and its health document names the holder and when the wait began: a long round is not a fault, whoever runs it. Nothing takes the lock over: it is a kernel flock on the workdir's `round.lock`, so it passes when its holder releases it or exits, whatever that holder leaves running.

With a commit operand, `yrd env open` requires a full commit object ID already present locally and refuses `--issue`.

Without a commit, `--bay <name>` opens or adopts exactly `task/<name>`. `--issue <ref>` defaults to `task/<final segment>` so a child issue's branch does not nest below its parent's branch. If `task/<full issue ref>` already exists locally or on origin, `--issue` adopts that older name and its work instead. The full issue ref remains in the `Refs:` binding. Two issues with the same final segment cannot share a bound branch: the refusal names both issues and offers `--bay <name> --issue <ref>`. An occupied branch refuses and names its holder.

**Holding a Yrd worktree.** Add `--hold <reason>` to either `env open` form. Yrd locks the Git worktree before issue binding or setup, so a later failure leaves it locked.

`env list --json` reports the reason as `hold`, or `null` when unlocked; the human list shows a nonempty reason. The reason is free text, not proof of ownership or expiry. `null` means only unlocked.

`env close` refuses a held worktree and names the reason. `git worktree unlock <path>` clears the hold. Close still requires a clean worktree and preserves submodule stores.

Close also refuses when a submodule declared `private = true` in the retained commit's `.gitmodules` has a `.git` entry in the environment. It names the path and reports `custody unproven until 27058's merge exclusion; operator decision pending`. The environment is preserved before cleanliness checks, teardown, or removal. An absent private submodule permits normal close.

With `--issue`, an initial `Refs:` commit records the binding before setup and preserves the current tree and history. A matching binding adds no commit.

Conflicting bindings refuse and name the preserved environment. Setup and output use the resulting head; setup failure preserves that environment.

Submission scans branch history back to its merge-base with the captured target, excluding target history. The first explicit `Refs:` or `Resolves:` binding wins.

Later commits and branch renames retain the binding. Conflicts name both issues and commits; `--issue` must match an existing binding.

The target's `.yrd.yml` may declare `issueResolver: [issue-lookup, --json]`. Yrd appends each raw binding or `--issue` value as one argument and expects JSON with a nonempty `id` string on stdout.

Yrd compares those IDs and writes the canonical ID in new environment and pin-only binding commits. The candidate's declaration cannot change this rule for its own submission.

A missing issue, failed command, timeout or invalid result refuses and names the raw reference and target command.

Only unbound legacy branches may fall back to their leading numeric issue segment. Live and dry-run submission report that fallback. Git publication starts after binding validation.

Close reads teardown from the environment's current commit and refuses dirty, locked, unregistered or out-of-root paths. Failed teardown preserves the environment.

**Using the queue.** Commit on your own branch, then do one of three things with it. The examples use `fix-login` and the default queue, `origin#main`.

1. **Submit** it to wait its turn: `yrd submit fix-login --submitter <agent>`. Submit verifies the branch's commit against the current queue branch with git-super, including gitlinks. It accepts an older head when the merge composes cleanly and never rewrites that head. A push alone leaves the branch outside the queue, a draft that the list and the watch show until it is submitted. Follow it with `yrd queue list` and `yrd queue show fix-login`; a failure's log is on the machine running the queue. After a fix, commit and submit again: the same head is a retry, a new head a new change.
2. **Merge** it now: `yrd merge fix-login` checks and merges that branch in this process, ahead of the line and even while the line is stopped, reusing its change if it is already in line. Every check still runs, and a fail goes back to its submitter. It exits with the change's state: 0 merged, 1 failed or withdrawn, 2 stuck or still in line. This is how a repair for a stuck line lands.
3. **Withdraw** it: `yrd queue withdraw fix-login --reason <text>` ends its open change and takes it out of the line. The branch stays, and submitting again re-opens it.

In a superproject, `git super status`, `git super diff` and `git super push` work across submodule boundaries.

**Before lock regeneration.** If your dependency installer needs an unpublished submodule commit, run `yrd submit fix-login --prepare --submitter <agent>` first. Then regenerate lockfiles with your project's existing synchronizer, commit the resulting files, and run ordinary `yrd submit fix-login --submitter <agent>`.

Preparation validates the branch, issue and admission, then retains each moved child commit at its declared remote under `refs/git-super/pins/<sha>`. It prints the branch, head, base and each permanent child ref; an unchanged retry reports `retained`. It leaves root refs, component main and unrelated refs untouched. It neither composes the change nor runs queue checks. Successful child refs remain available if a later child fails, and the error includes their receipts. `--prepare` refuses combinations with `--dry-run` or `--gitlink`.

**What submit does, in order:**

1. Refuses the queue branch, reads the local branch head, then reads and fetches the configured target's advertised commit. Fetch obtains the commit objects without pulling or integrating them into your branch. Operator and stuck stops accept the submit; a maintenance stop refuses it before publication. No queue check runs at submit.
2. Checks shared history and refuses a head already contained by the target.
3. Resolves the issue and runs the target's optional `admission` command before any push. A policy exit 1 refuses with its stdout cure. A timeout, signal or other failure cannot judge: ordinary submit proceeds with a visible warning event and target-declared notification. Issue-free changes skip admission and say so.
4. Retains moved child commits through Git-super's create-only ref executor, including nested pins and commits fetched from their remotes. A pin ref already naming that commit is a retry; one naming another commit refuses and never moves. `--prepare` returns here with its retention receipts.
5. Composes the submitted commit onto the observed target and settles gitlinks with git-super. A conflict refuses before a change opens, naming the conflict. The submitted commit remains unchanged.
6. Creates the opened record for that submitted commit, then publishes it as the branch head together with the record in one atomic push. The branch, change and stop authority use leases against the remote values just observed; a concurrent maintenance stop refuses the whole push.
7. Returns the submitted change. The queue runs checks and merges later, revalidating against the target at merge time. Successful submission means queued, not merged.

`--dry-run` performs the same git-only verification without pushing or opening a change and reports its result. Submission captures a target commit at one instant; it does not reserve the target. `--notify` remains a deprecated alias for `--submitter` for one release and prints a warning.

## The config, `.yrd.yml`

The queue's config is a file on the queue branch. Each round captures one commit from that branch for both its config and its base; later branch updates take effect next round. The config never comes from the change, so a branch cannot change the checks that judge it. The smallest config that does something:

```yml
checks:
  - test:
      run: bun run test
```

Everything the file can say:

```yml
setup: bun install --frozen-lockfile # runs once in every fresh checkout the queue makes, before any check
admission: # optional target-owned pre-submit command, run in a detached checkout of the captured target
  run: bun tools/admission.ts
  timeoutMs: 15000 # required positive integer; includes the policy process, not target checkout preparation
checks:
  - typecheck: # each check is one mapping of its name to its settings
      run: bun "$YRD_PROGRAM_ROOT/tools/typecheck.ts"
      on: [submit, merge] # when it runs: submit = on the change alone, merge = on its merge with the queue branch; default: merge
      timeoutMs: 1800000 # default: 30 minutes
      scripts: [tools/typecheck.ts] # validated in the target program root; the candidate copy stays intact
      environmentPassthrough: [GITHUB_TOKEN]
      programRoot: true # opt in to the queue-selected program root at $YRD_PROGRAM_ROOT
notify: # the same shape as checks: a name, when it runs, what runs
  - submitter:
      on: [merged, failed, cancelled] # default: merged, failed, stuck, merged-direct, cancelled
      run: bun tools/yrd-notify.ts # gets the record as one JSON object on stdin
  - supervisor:
      on: [stuck, merged-direct]
      run: bun tools/yrd-notify.ts --to @cto
  - admission-supervisor:
      on: admission-warning
      run: bun tools/yrd-notify.ts --to @cto
health:
  stallAfter: 45m # changes waiting with none judged for this long is a stalled line; default 45m, at least 10m
```

`admission` receives `YRD_ADMISSION_ISSUE` (the canonical issue path), `YRD_ADMISSION_BRANCH`, and `YRD_ADMISSION_HEAD`. Its target checkout uses the target's code even if the submitted branch edits the policy script. Exit 0 admits; exit 1 refuses and prints a cure on stdout; any other exit, signal, timeout, incomplete output or execution failure is _cannot judge_. A cannot-judge submission stays in the queue and records an `admission-warning` event with the head, reason and time. The same head and reason are recorded once per change, including retries; a new warning event dispatches the target's `notify: on: admission-warning` entry once. A missing notification entry or failed delivery is reported on stderr. `--dry-run` runs admission and reports its verdict without publishing. The target policy command must run without `setup:`; it executes in a clean target checkout before checks install dependencies.
If the target advances between reading `.yrd.yml` and admission, submit refuses with a retry instruction so a newer policy is never run with an older declaration.

A queue-authored cancellation after a confirmed missing remote branch sends `cancelled` through this ring. An explicit `yrd drop` or `yrd queue withdraw` sends no cancellation notice; `--notify <seat>` only records that seat as the cancellation's `Recipient:` — a recorded coordination target, never delivery proof.

A key the queue does not read is refused, never ignored. Queue identity is not configuration: `target:` and `remote:` are refused; the branch carrying this file is the queue selected by `--queue`. The machine's storage path is Git configuration, described below. A check's environment is built, not inherited. `YRD_CANDIDATE_SHA` names the queue candidate, the exact commit the check judges: the change's head on submit, its prospective merge commit on merge, or the queue branch for a target check. `YRD_BASE_SHA` names that candidate's merge base with the queue branch, and `YRD_REPO` names its fresh checkout C. The environment also carries `PATH`, `HOME`, `SHELL`, `LANG`, `USER`, `LOGNAME`, `LC_*`, a `TMPDIR` under the queue workdir, and the variables listed under `environmentPassthrough`.

`programRoot: true` is an explicit capability for a check whose shell command needs the queue-selected target program P as well as its fresh checkout C. Such a check names `$YRD_PROGRAM_ROOT` in its command; the queue sets that value to P's absolute path after every passed-through or check-requested environment value, so neither can replace it. A legacy check remains the default and receives no `YRD_PROGRAM_ROOT`; the queue reserves that name in both modes. This constrains the environment the queue supplies, not what an arbitrary shell command can deliberately read.

## Where things are

Each branch history lives at `refs/yrd/<encoded-queue>/changes/<branch>`, or at `refs/yrd-archive/<encoded-queue>/<branch>` after archiving.
The queue authority is `refs/yrd/<encoded-queue>/queue`; its operational pause ref is `refs/yrd/<encoded-queue>/pause`.
These refs live on the selected remote and in clones that fetch them. Queue encoding keeps `release/stable` in one component as `release%2Fstable`.

For queue-owner and reader commands, the host root is `git config yrd.workdir`, otherwise `$XDG_STATE_HOME/yrd` (default `~/.local/state/yrd`). Under it, the queue directory is `<host>/<repository-path>~<encoded-queue>`; an absolute local repository uses `local/<absolute-path-without-leading-slash>~<encoded-queue>` instead. Detached retained environments live under `<git-common-dir>/yrd/environments` or the configured `yrd.workdir`; standalone branch environments remain under `.bays`. Both are listed and closed through the same Git registry. Each queue address gets its own clone and artifacts:

```
<host root>/github.com/beorn/hh~main/
  repo/                                             the queue-owned clone; .yrd.yml is read from the queue branch
  worktrees/<run id>/[compose/]<phase>/<sha>/        temporary composition and check worktrees
  checks/<change>/<run id>/<phase>/<name>.log        retained check logs
  logs/<run id>.jsonl                               the run journal
  round.lock                                        the round lock: a kernel flock, one round at a time; its body names the holder
  tmp/                                              TMPDIR for checks
```

`yrd check` and retained-environment commands use the current repository and `git config yrd.workdir`, otherwise `<git-common-dir>/yrd`. Relative configured paths resolve from the repository root. Retained environments live at `<workdir>/environments/<sha-prefix>-<run id>/`; their setup and teardown logs and temp files live under `<workdir>/logs/environments/<name>/`.

The submitter and the queue share only the selected remote. The submitter pushes a branch and the change's first record there; the queue fetches it into its own clone, works in fresh checkouts, and pushes merges back. It never reads a submitter's clone, so the two can be on different machines.

## How a change moves

1. **Submit.** After the freshness check, one atomic push of the branch and of the change's first record. The branch is pushed with `--force-with-lease`, so a push that would overwrite another submitter's head is refused, loudly.
2. **Check.** The next queue run takes every queued change, oldest first, into a fresh checkout of its head. Two built-in checks run first: the change shares history with the queue branch, and every gitlink it moved points at a commit its submodule's `main` contains or is a descendant of (a pin ahead of `main` is kept, and the queue moves that `main` to it at merge). Then the `on: submit` checks run.
3. **Merge.** The first checked change in line is merged with the queue branch in a fresh checkout. A third built-in check runs there: the `.yrd.yml` of the merged tree still parses, so no change can merge a config the next run cannot read. Then the `on: merge` checks run. A pass moves the queue branch to one merge commit (`--no-ff`, so the merge is visible in history) that names the change and the queue run in its trailers (`Change: <branch>@<sha>`, `Merged-By: yrd queue main [<run id>]`), committed as `yrd`. One change merges per run. A checked submit result is reused while its recorded `Config` blob matches the declaration; the next merge is composed and checked against the new queue branch. Merging several checked changes as one tested batch, and splitting a failed batch to find the culprit, is planned and not built.
4. **Decide whose fault a failure is.** A command failure normally fails the change. If the queue raised a gitlink while preparing the candidate, it also runs that phase's checks on the queue branch with those exact raises but without the candidate's own content. A passing base attributes the failure to the change; a failing or unjudgeable base leaves the change stuck. Crashes, missing scripts, timeouts, exit 2 and unreachable submodule remotes also make it stuck. Stuck stops the line: the run ends at that change, judges and merges nothing behind it, exits 2, and pauses the queue naming the change, so the line stops until the change is withdrawn with `yrd queue withdraw` or merged. `yrd merge` lands a repair past it and then judges the stuck change once more. A stuck the remote caused, a setup that could not fetch or a submodule remote that did not answer, is taken once more inside the run before it is written, and its record then carries `Retried: 1`.
5. **Notify.** Every ending runs the `notify` entries whose `on:` lists it, with the record as one JSON object on stdin.

   `record` names the ending (merged, failed, stuck or merged-direct). `endingId` identifies this particular ending: its event ID in the event queue, or its ending record OID in the legacy queue. `endedAt` is that ending's ISO time with a zone, taken from the event's `Time` or the legacy ending record's millisecond `Ended-At` trailer. Legacy records written before that trailer retain their Git commit time. The object also carries `change`, `submitter`, and `issue` when given.

   A failed record adds `reason`, `log`, and the branch's `failures` count; a merged record adds `merge`. Notify commands choose recipients and compose delivery text.

   `retired-root-written` is the service's own occasion, not a change's: the per-tick sweep found a write under the retired percent-escaped queue root (`<host root>/<host>/<path>%23<queue>`, the spelling the pre-27065 builder used). That record carries no `change`; it is identified by `root`, `address` (the retired root's queue address), `path` (the newest file written under it), `writtenAt`, `cutover`, the `branches` named under it, and `active`. `active: false` is the clearing edge, sent once the newest post-cutover write is older than a day. It rides the wire's incident rail — emitter `yrd`, subject the retired root's address, condition `retired-root-written` — so a repeat upserts one incident rather than opening a ball every tick. The root is never drained; the sweep only reads and pages.

   For a change's current ending, later rounds read receipts between that ending and the captured tip. Any receipt settles a name for that ending. Exit 0 told it.

   Exit 4 means the transport answered and refused, with its reason on the command's last stdout line. The sent record says `Not-Told: <name> refused=<reason>`.

   That name is never sent for this ending again. Any other exit, timeout, or command that could not run is no receipt; the name gets one more attempt on the next round.

   If that fails too, its record says `Not-Told: <name> undelivered=<why>`. Later sent records repeat `Not-Told:` values, and `yrd list` names the queue operator as next.

   Removed names run nothing; a newly declared name is still told. A first telling with no matching entries writes `none` once.

   Delivery is at least once: a crash can hide a result and cause a retry. A direct-merge notice can also repeat if its command succeeds but writing the `notified` event exhausts retries.

   The next round finds no receipt and runs the command again. Every `notify:` command must accept a repeat for the same change and ending.

   The supplied `tools/yrd-notify.ts` uses a stable message ID from the change, ending, `endingId`, and message part, so Tribe returns the first delivery instead of opening a second ball. During migration, a record without `endingId` retains the legacy message ID; an upgraded retry reuses a previously delivered legacy ID only when its daemon timestamp is at or after `endedAt`.

**Child observations.** When the machine selects Git Super with the `root-v1` contract, every run and list/watch reading asks that same executable for a current child observation. Idle and paused queues still observe. Native Git reports that child observation is not configured, in `--json`; the list and the watch draw nothing for it, nor for a clean reading with no notice, and draw a failed reading loudly. A changed reading or unavailable transport clears the notices and defers candidate work; an invalid observation ends the command with exit 2.

Notification entries can opt in with `on: [observed]`. They receive `{ "record": "observed", "notice": { "id": "…", "text": "…" } }` on stdin. The notice is the selected executable's explanation. These notifications can repeat on later rounds; omitting `on:` still selects only the four change endings.

**Direct merges.** The queue is meant to be the only writer of the queue branch, but nothing stops a person from pushing `main` directly, and the queue does not pretend otherwise. Every queue run walks the queue branch's history since the queue's first record and reports each commit it did not make as a `merged-direct` record, naming the commit and every gitlink it moved. Then it goes on from the new base. The change at the front is checked again there. A push the queue was about to make onto the old base is refused by its own `--force-with-lease`. A rollback is a `git revert`, submitted through the queue like any other change. A submitted change whose head reaches the queue branch by a direct merge still reads as merged; its merged record says `Merged-By: direct`.

## Superprojects

A superproject is a Git repository whose tree records other repositories as submodules. Each submodule entry is a gitlink, the exact commit of that repository. In theory that makes a set of repositories one product. In practice ordinary Git commands stop at the gitlink: `git diff` names `vendor/tool` and never a file inside it. No merge queue we know of reads a gitlink when it decides whether to merge. They merge the superproject commit as a tree of text and leave the submodule pointers to chance; Gerrit can update gitlinks automatically after a merge, which is not the same as checking a gitlink before it merges. Yrd reads them before it merges:

- A change that moves a gitlink must point it at a commit on that submodule's `main` or ahead of it, or the change fails at the built-in check in step 2, before any declared check runs: a pin that diverged from `main` is the submitter's to rebase and submit again. (Until 2026-09-10 it waited for a person to move `main` under it; the queue now moves `main` itself, forward only, so nothing could clear that wait.) A pin AHEAD of `main` is how a submodule change lands: the author commits inside the submodule, bumps the gitlink, and submits the superproject once. `yrd submit` publishes the moved commit to the submodule's remote under `refs/git-super/pins/<oid>` so the queue can fetch it, the queue judges the whole tree, and at merge, after every check has passed, it moves the submodule's `main` to the pin (children first) and then pushes the superproject's `main`. No submodule `main` moves before the merged tree is green, and no one fast-forwards a submodule by hand. If the superproject push is then refused because its `main` moved, the change keeps its place and the next run composes on the new `main`, where the published pin reads as already on the submodule's `main`.
- Every checkout the queue makes has its submodules materialized at the exact gitlinks of the commit under test, so a check sees the whole product as it would ship.
- A direct merge that moves a gitlink is reported with the gitlink's path, because that is the one thing the built-in check above never sees.
- Fetches never recurse into submodules. Under `submodule.recurse=true`, a plain fetch visits every submodule's remote every time; on a superproject with sixteen submodules that was 16 seconds per fetch against 1.
- A superproject that vendors Yrd itself as a submodule runs the vendored commit. The queue moves to a new Yrd only through its own merge of that gitlink: the loop ends clean, and a supervisor set to restart it starts the new one.

The submodule plumbing is [git-super](https://github.com/beorn/git-super), Git commands that treat a superproject and its submodule interiors as one product. Yrd uses it to materialize checkouts and to read gitlinks; it is useful on its own wherever a script asks "what changed" across a submodule boundary.

## Records

A branch's event chain retains its successive submitted heads at the history ref described in [Where things are](#where-things-are).
Each event is a commit with typed trailers recording the change and its result. The queue derives state from these events rather than storing a mutable status row.
List, detail and full-history reads discover both hot and cold histories. Duplicate hot and cold custody is an error.

### Archive ended histories

Preview the exact eligible refs before moving them:

```console
$ yrd queue archive --queue main --min-age 30 --state merged --limit 200 --dry-run --json --notify alice
$ yrd queue archive --queue main --min-age 30 --state merged --limit 200 --json --notify alice
```

Only merged or cancelled histories qualify, at least seven days after their latest ending. Ignored histories and every other state remain hot.
`--min-age` sets a whole-day minimum of at least seven (default seven); `--state` selects merged or cancelled (default both).
`--limit` is a positive transfer count; omitting it leaves the pass unbounded.
Preview and execution share one selector: filter by state and age, sort by ending oldest first with a ref tie-break, then apply the limit.
JSON names the applied `bounds`, the `eligible` count before the cap, and every selected hot ref, tip and cold destination in `candidates` for both modes.
This is a manual operation. It does not run from the queue loop; `.yrd.yml` still accepts only `archive-after: never`.
An archive moves a ref outside the hot namespace. It preserves history and does not reduce the repository's total ref count.

For each history, the command stages an `archived` event whose first parent is the selected hot tip.
The event records that ref and tip, ending state and time, age, actor and archive time; it leaves the ending state and time unchanged.
One atomic remote update creates the absent cold ref and deletes the exact selected hot tip; the server checks those two leases.
Git checks the unchanged queue tip against the push's ref advertisement on the client; it is not checked inside the server's atomic transaction.
A conflict stops the pass without a mutating retry. A remote without atomic push support refuses the update.

After each update, one remote reading must find the exact new cold tip and no hot ref before the next transfer starts.
JSON output includes `readbacks` with both refs, previous and cold tips, and verification time.
An unreadable or mismatched reading stops with `archive-custody-readback` and exit 2; the error retains earlier verified readings and the published count.
The operator running the command must alert the queue owner with that error and ref pair before continuing.

A new submitted head continues the archived event chain and atomically returns it to hot custody.
Resubmitting the same merged head remains refused. Late notification records append to the selected cold history without creating another hot chain.

Every check writes one line in the queue run's log when it starts and one when it ends. The end line carries the exit code, the duration and the path of the check's own log:

```
<workdir>/checks/<branch>@<sha>/<run id>/<phase>/<name>.log      run id: the queue run's start time; phases: submit, merge
```

## Exit codes

| Exit | Meaning                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | the run ended with nothing failed or stuck; the `yrd queue up` loop also ends with 0 when the gitlink of Yrd itself moved, so a supervisor set to restart it starts the new version |
| 1    | at least one change ended failed in this run and was sent back                                                                                                                      |
| 2    | stuck: a change cannot go on until someone repairs it; the run stopped there, and the queue pauses on that change until it leaves the line or the queue is resumed                  |

`yrd merge` exits with the state of the change it merged instead: 0 merged, 1 failed or withdrawn, 2 stuck or still in line.

The command exits from one place in the code. It also exits 2 when the command itself cannot run: no queue here, or a config it cannot read. A signal, or an error nobody caught, is stuck. `yrd queue up` does not exit on a stuck change; it holds the stopped line. It exits 2 only when no round can hold a line: the declaration is gone or unreadable, its own runtime gitlink is absent, or a round could not read its queue at all.

## Compared with other systems

|                         | What is tested                                                    | What merges                                                             | Where the state lives                        | Superproject                                                            |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| **Yrd**                 | the merge of the queue branch and the change, in a fresh checkout | that same merge commit                                                  | commits on refs in the repository; no server | gitlinks checked and materialized                                       |
| **GitHub merge queue**  | several queued pull requests merged together and tested as one    | that group's result                                                     | GitHub                                       | none: the tree merges, gitlinks unread                                  |
| **GitLab merge trains** | a pipeline per position in the train                              | GitLab's merge                                                          | GitLab                                       | none                                                                    |
| **Gerrit**              | the patch set                                                     | per submit strategy; rebase or cherry-pick can mint a sha nobody tested | git refs on the Gerrit server                | gitlinks can be updated after a merge, not checked before it            |
| **Zuul**                | a test merge of the whole train ahead, before the forge merges    | whatever the forge then merges                                          | the forge plus ZooKeeper                     | many repositories per change, named in its project config, not gitlinks |
| **bors-ng**             | a staging merge of the batch                                      | the exact staging sha, fast-forwarded                                   | its own database                             | none                                                                    |

In both directions:

- **bors-ng made the rule famous**: test the merge, then ship exactly what you tested. Yrd keeps that rule, needs no forge to hold the queue, and checks gitlinks.
- **Squash and rebase merges buy a clean linear log**, which is a real win for casual reading, and GitHub's and GitLab's queues offer them. The price is that the commit you authored never becomes `main`, so "is my exact commit in" has no ancestry answer. Yrd pays the opposite price, merge commits in the log, and buys the answer back with `git log --first-parent`.
- **Gerrit's change identity survives any number of revisions.** Yrd's `Change:` trailer on the merge commit and its per-change ref are the same idea at the git layer, without the server, the amend-and-push ceremony, or a submit strategy that merges an untested sha.
- **Zuul tests a merge of the whole train ahead** before the forge merges anything, checking against that projected future rather than live trunk, which is the fastest way through a busy queue. Yrd merges one change per run and checks the next merge against the new queue branch, which is slower and needs no rollback of a broken train.

The common thread: every system above answers "what exactly did we test, and is that what merged" with some mixture of trusting the tool and comparing contents. Yrd's answer is a sha you can check from any clone with nothing but git.

## Packages

| Package                   | What it is                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/yrd-queue-core` | the queue: submit, the queue read, the queue run, checks, records                               |
| `packages/yrd-cli`        | the commands                                                                                    |
| `packages/yrd-process`    | running commands and Git: checkouts, time limits, and reading which processes still hold a path |
| `packages/yrd-bay`        | `yrd env`: a checkout of one branch for a person or an agent to work in                         |

`tests/boundary` proves the queue from the outside, as a user would see it: real repositories, real pushes, real checks in their own checkouts.

## Development

Yrd needs Bun and Git. The queue runs as one process on one machine, as the user who starts it, and a check is whatever command the config names, run as that user.

**Queue-owned Git operations never run repository hooks.** Base settlement, gitlink raises, and final merge settlement run under an asserted-empty `core.hooksPath`; this is a load-bearing isolation boundary, not an optional bypass. `--no-verify` is not a substitute: on Git 2.55 it does not suppress `prepare-commit-msg` or `post-commit`, and it does not configure child Git processes. Starting the `git super` command with `git -c core.hooksPath=<empty-dir>` propagates the override to its child Git commands through `GIT_CONFIG_PARAMETERS`. Repository hooks validate authored work; queue artifacts are derived, and checks on their output belong in `.yrd.yml`.

```console
$ bun install --frozen-lockfile
$ bun run typecheck
$ bun fix
$ bun run test packages/yrd-cli/tests/env-open.test.ts   # focused Vitest coverage
$ bun run check                                        # typecheck and the default test suite
```

Yrd is developed inside a larger superproject that runs it on itself, and the plan kept there records the design and its rulings; this file describes what is built.
