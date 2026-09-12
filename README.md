# Yrd

Yrd is a merge queue that lives inside a Git repository. A queue runs on a branch, `main` for most repositories. A change is another branch, submitted to that queue.

- **Submit a branch, get a result.** You commit your changes on a branch and submit it. The queue checks it in a fresh checkout, merges it into the queue branch, and tells you what happened.
- **No server, no database, no web page.** Everything the queue knows is a commit on a ref in the repository, under `refs/yrd/<encoded-queue>/`. Any clone that fetches those refs reads the whole state with plain `git log`.
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

- **change**: one branch at one commit, submitted to the queue; the nearest everyday thing is a pull request without a number or a review. Its name is `<branch>@<sha>`. Move the branch and submit again for a new change; push without submitting and the queue never sees it.
- **submitter**: whoever ran `yrd submit`, a person or an agent, named by the string given with `--notify`. The queue passes that string to the notify commands and reads nothing into it.
- **queue branch**: the branch the queue runs on and merges into, selected with `--queue <branch>` or defaulting to `origin/HEAD`. A change's own branch is the change's branch.
- **check**: one command the queue runs, on submit or on merge, named in `.yrd.yml` on the queue branch.
- **result**: pass, fail or stuck, of a check or of a queue run. A fail is the submitter's: the check ran and its command exited non-zero. Stuck means the queue itself cannot go on (a crash, a missing script, a check past its time limit); it stops the queue and is nobody's fault.
- **change record**: one commit on the change's own ref recording one step and its result: opened, checked, merged, failed, stuck, sent. Records are written once and never rewritten.
- **queue run**: one round of the queue. `yrd queue run` does one; `yrd queue up` does one every interval, on a loop, which is how the queue runs under whatever supervisor you use.
- **gitlink**: a submodule pointer, the commit a superproject records for one of its submodules.
- **direct merge**: a commit on the queue branch that the queue did not make, what GitHub calls a direct push. Reported, never prevented.

## Commands

```
yrd submit [branch] [--notify <who>] [--issue <id>] [--dry-run] [--rebase]   push the branch (the current one when none is named) and open its change; same head again is a retry
yrd queue run                                                     one queue run
yrd queue up [--interval <seconds>]                               queue runs on a loop, every 15 seconds by default; run this under your supervisor
yrd queue pause --reason <text> [--notify <seat>]                        stop checking and merging; the service keeps the queue visible
yrd queue resume [--reason <text>] [--notify <seat>]                       resume on the next service interval
yrd queue list [filter...] [--latest] [--watch]                   the watch's page, once: the queue pills, one row per run per change in the state's colour, the RUNNER box; plain when piped; `yrd list` is the same command
yrd watch [filter...]                                             `yrd queue list --watch`: on a terminal, the live pane — keyboard and mouse (click selects, wheel scrolls, drag copies), detail on Enter, STATS below
yrd queue stats [--since 3h|<time>|<sha>] [--by submitter|branch] merged, failed, same-head retries, re-pushed branches, refs pushed and never submitted, opened→merged latency
yrd queue show <branch>                                           that branch's changes, newest first, each check's result and log
yrd check <name...>                                               run the named checks here, now, in a fresh checkout of HEAD
yrd env open [commit] | --bay <name> | --issue <ref>              with [commit], retain that exact commit detached; with --bay/--issue instead, open or adopt its task/<name> branch; print the path
yrd env list                                                      list this repository's retained environments
yrd env close <path> [--retain <directory>]                       run teardown and remove a clean, unlocked environment; retain submodule stores
```

Queue commands and `yrd submit` take `--queue <value>`, never a positional queue. Inside a clone, a branch selects that queue at `origin`; omission reads the remote's `HEAD`. An address such as `beorn/hh#main`, `https://github.com/beorn/hh.git#main`, or `/absolute/repo#main` selects a repository and queue together. `queue run`, `up`, `pause` and `resume` accept an address outside a clone and always use a queue-owned clone, including when invoked inside another clone. Submit, list, show and watch still require a clone; addressed submit keeps the author's checkout and sends to the selected repository.

Every command takes `--json`. `yrd submit` refuses the queue branch itself: it is not a change. While paused, submit and dry-run refuse with who paused the queue, when, why, and the resume command; already-submitted changes keep their place. `yrd queue up` stays visible but does no automatic checking or merging until resume. An explicit `yrd queue run` is permitted while paused and leaves the pause in place. `yrd check` checks out HEAD afresh, so uncommitted changes are not seen.

With a commit operand, `yrd env open` requires a full commit object ID already present locally and refuses `--issue`.

Without a commit, `--bay <name>` or `--issue <ref>` opens or adopts `task/<name>` through Git worktree registration. An occupied branch requires `--issue` for verified reuse.

With `--issue`, an initial `Refs:` commit records the binding before setup and preserves the current tree and history. A matching binding adds no commit.

Reuse verifies the registered path, repository, branch, HEAD and explicit issue binding. It preserves staged, unstaged and untracked work and does not run setup or write another binding.

JSON reports `reused`, the verified `head`, issue binding and `setup`. Only a new environment reports its original `base`.

Setup is `not-required`, `passed`, `failed` or `unverified`. A reused environment with required setup reports `partial` and exits 2 because registration cannot prove prior setup completion.

Setup failures and changed identities retain the environment and name the recovery need.

With `--issue`, successful setup is followed by branch, HEAD and binding verification.

Submission scans branch history back to its merge-base with the captured target, excluding target history. The first explicit `Refs:` or `Resolves:` binding wins.

Later commits and branch renames retain the binding. Conflicts name both issues and commits; `--issue` must match an existing binding.

Only unbound legacy branches may fall back to their leading numeric issue segment. Live and dry-run submission report that fallback. Git publication starts after binding validation.

Close reads teardown from the environment's current commit and refuses dirty, locked, unregistered or out-of-root paths. Failed teardown preserves the environment.

**Your workflow.** Once your changes are committed, work from your own branch. These examples use `fix-login` and the default target, `origin#main`; substitute your branch and configured target.

1. **Update your branch.** From a clean checkout of `fix-login`, run `git fetch origin main`, then `git rebase FETCH_HEAD`. Resolve any conflicts with Git before continuing.
2. **Verify and commit.** Run your project's checks against the updated branch and commit any follow-up changes. Use `git super status` and `git super diff` to inspect changes across submodule boundaries in a superproject.
3. **Publish if useful.** `git push origin HEAD:refs/heads/fix-login` shares or preserves the branch. In a superproject, use `git super push` with the same explicit remote and refspec. Publishing is optional: a push alone leaves the branch outside the queue.
4. **Submit explicitly.** Run `yrd submit fix-login --notify <who>`. Submit publishes the branch itself and opens the change for that exact commit.
5. **Follow the result.** Use `yrd queue list` and `yrd queue show fix-login` to see checks, the merge, or a failure's log path. Read that file on the machine running the queue. After a fix, commit and submit again; the same head is a retry, and a new head is a new change.

**What submit does, in order:**

1. Refuses the queue branch and a paused queue, reads the local branch head, then reads and fetches the configured target's advertised commit. Fetch obtains the commit objects without pulling or integrating them into your branch.
2. Checks shared history and whether your branch contains that target commit. It refuses a head already contained by the target or, by default, a stale branch.
3. With explicit `--rebase`, rebases a stale branch onto that captured target. This requires the named branch checked out here, a clean worktree and index including untracked files, and no active Git operation. It never auto-stashes or updates other branch refs. A conflict stops submission before a change opens; resolve it with Git and submit again.
4. Creates the opened record for the exact resulting commit after any requested rebase, then publishes that commit as the branch head together with the record in one atomic push. Both refs use leases against the remote values just observed; a concurrent ref change refuses the whole push.
5. Returns the submitted change. The queue runs checks and merges later, revalidating against the target at merge time. Successful submission means queued, not merged.

`--dry-run` performs the admission checks without pushing or opening a change. Combined with `--rebase`, it describes the required rewrite without performing it or predicting the resulting commit. Submission captures a target commit at one instant; it does not reserve the target.

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
checks:
  - typecheck: # each check is one mapping of its name to its settings
      run: bun run typecheck
      on: [submit, merge] # when it runs: submit = on the change alone, merge = on its merge with the queue branch; default: merge
      timeoutMs: 1800000 # default: 30 minutes
      scripts: [tools/typecheck.ts] # restored from the queue branch before the check runs, so a change cannot edit its own judge
      environmentPassthrough: [GITHUB_TOKEN]
notify: # the same shape as checks: a name, when it runs, what runs
  - submitter:
      on: [merged, failed] # default: all four endings
      run: bun tools/yrd-notify.ts # gets the record as one JSON object on stdin
  - supervisor:
      on: [stuck, merged-direct]
      run: bun tools/yrd-notify.ts --to @cto
```

A key the queue does not read is refused, never ignored. Queue identity is not configuration: `target:` and `remote:` are refused; the branch carrying this file is the queue selected by `--queue`. The machine's storage path is Git configuration, described below. A check's environment is built, not inherited. `YRD_CANDIDATE_SHA` names the queue candidate, the exact commit the check judges: the change's head on submit, its prospective merge commit on merge, or the queue branch for a target check. `YRD_BASE_SHA` names that candidate's merge base with the queue branch, and `YRD_REPO` names its checkout. The environment also carries `PATH`, `HOME`, `SHELL`, `LANG`, `USER`, `LOGNAME`, `LC_*`, a `TMPDIR` under the queue workdir, and the variables listed under `environmentPassthrough`.

## Where things are

Each queue owns `refs/yrd/<encoded-queue>/<branch>@<sha>` and `refs/yrd/<encoded-queue>/pause`, on the remote and in clones that fetch them. Encoding keeps the queue branch in one component: `release/stable` becomes `release%2Fstable`.

For queue-owner and reader commands, the host root is `git config yrd.workdir`, otherwise `$XDG_STATE_HOME/yrd` (default `~/.local/state/yrd`). Under it, the queue directory is `<host>/<repository-path>%23<encoded-queue>`; an absolute local repository uses `local/<absolute-path-without-leading-slash>%23<encoded-queue>` instead. Detached retained environments live under `<git-common-dir>/yrd/environments` or the configured `yrd.workdir`; standalone branch environments remain under `.bays`. Both are listed and closed through the same Git registry. Each queue address gets its own clone and artifacts:

```
<host root>/github.com/beorn/hh%23main/
  repo/                                             the queue-owned clone; .yrd.yml is read from the queue branch
  worktrees/<run id>/[compose/]<phase>/<sha>/        temporary composition and check worktrees
  checks/<change>/<run id>/<phase>/<name>.log        retained check logs
  logs/<run id>.jsonl                               the run journal
  tmp/                                              TMPDIR for checks
```

`yrd check` and retained-environment commands use the current repository and `git config yrd.workdir`, otherwise `<git-common-dir>/yrd`. Relative configured paths resolve from the repository root. Retained environments live at `<workdir>/environments/<sha-prefix>-<run id>/`; their setup and teardown logs and temp files live under `<workdir>/logs/environments/<name>/`.

The submitter and the queue share only the selected remote. The submitter pushes a branch and the change's first record there; the queue fetches it into its own clone, works in fresh checkouts, and pushes merges back. It never reads a submitter's clone, so the two can be on different machines.

## How a change moves

1. **Submit.** After the freshness check, one atomic push of the branch and of the change's first record. The branch is pushed with `--force-with-lease`, so a push that would overwrite another submitter's head is refused, loudly.
2. **Check.** The next queue run takes every queued change, oldest first, into a fresh checkout of its head. Two built-in checks run first: the change shares history with the queue branch, and every gitlink it moved points at a commit its submodule's `main` contains or is a descendant of (a pin ahead of `main` is kept, and the queue moves that `main` to it at merge). Then the `on: submit` checks run.
3. **Merge.** The first checked change in line is merged with the queue branch in a fresh checkout. A third built-in check runs there: the `.yrd.yml` of the merged tree still parses, so no change can merge a config the next run cannot read. Then the `on: merge` checks run. A pass moves the queue branch to one merge commit (`--no-ff`, so the merge is visible in history) that names the change and the queue run in its trailers (`Change: <branch>@<sha>`, `Merged-By: yrd queue main [<run id>]`), committed as `yrd-service`. One change merges per run. A checked submit result is reused while its recorded `Config` blob matches the declaration; the next merge is composed and checked against the new queue branch. Merging several checked changes as one tested batch, and splitting a failed batch to find the culprit, is planned and not built.
4. **Decide whose fault a failure is.** A command failure normally fails the change. If the queue raised a gitlink while preparing the candidate, it also runs that phase's checks on the queue branch with those exact raises but without the candidate's own content. A passing base attributes the failure to the change; a failing or unjudgeable base leaves the queue stuck. Crashes, missing scripts, timeouts, exit 2 and unreachable submodule remotes also make it stuck. Stuck stops the queue.
5. **Notify.** Every ending runs the `notify` entries whose `on:` lists it, each with the record as one JSON object on stdin: `record` is its discriminant (merged, failed, stuck or merged-direct), followed by `change`, `submitter`, `issue` when one was given, then `reason`, `log`, and the branch's `failures` count for failed, or `merge` for merged. Notify commands choose recipients and compose delivery text. For a change's current ending, later rounds read receipts between that ending and the captured tip. Currently declared names without a successful receipt retry; successful names are not retold, and removed names run nothing. A first telling with no matching entries writes `none` once. Delivery is at-least-once: an unrecorded result can be retried after a crash.

**Child observations.** When the machine selects Git Super with the `root-v1` contract, every run and list/watch reading asks that same executable for a current child observation. Idle and paused queues still observe. Native Git reports that child observation is not configured. A changed reading or unavailable transport clears the notices and defers candidate work; an invalid observation ends the command with exit 2.

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

A change's history is its own ref, `refs/yrd/<encoded-queue>/<branch>@<sha>`, one commit per record: opened, then checked, then merged or failed or stuck, then sent. Each record is a one-line sentence plus trailers, the `Key: value` lines at the end of a commit message: which change (`Change:`), then per kind who submitted it and for which issue, which config judged it, which check failed and why, which merge commit merged it and which queue run made it, and which notify entries ran and whether they delivered. The ref namespace identifies the queue; there is no `Target:` trailer. The queue read uses each change's tip and its head's ancestry on the queue branch. Detail reads expand only selected changes' record histories to recover earlier check evidence; notification receipts come from the current ending's captured range. A change's state is never stored; it is worked out from the records and from history. A change whose head is already in the queue branch's history is merged whatever its records say, and gets its merged record on the next run.

Every check writes one line in the queue run's log when it starts and one when it ends. The end line carries the exit code, the duration and the path of the check's own log:

```
<workdir>/checks/<branch>@<sha>/<run id>/<phase>/<name>.log      run id: the queue run's start time; phases: submit, merge
```

## Exit codes

| Exit | Meaning                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | the run ended with nothing failed or stuck; the `yrd queue up` loop also ends with 0 when the gitlink of Yrd itself moved, so a supervisor set to restart it starts the new version |
| 1    | at least one change ended failed in this run and was sent back                                                                                                                      |
| 2    | stuck: the queue cannot go on until someone repairs it; a supervisor should leave it down                                                                                           |

The command exits from one place in the code. It also exits 2 when the command itself cannot run: no queue here, or a config it cannot read. A signal, or an error nobody caught, is stuck.

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
