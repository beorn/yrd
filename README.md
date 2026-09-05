# Yrd

Yrd is a merge queue that lives inside a Git repository. A queue runs on a branch, `main` for most repositories. A change is another branch, submitted to that queue.

- **Submit a branch, get a result.** You push a branch and submit it. The queue checks it in a fresh checkout, merges it into the queue branch, and tells you what happened.
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
yrd submit [branch] [--notify <who>] [--issue <id>] [--dry-run]   push the branch (the current one when none is named) and open its change; same head again is a retry
yrd queue run                                                     one queue run
yrd queue up [--interval <seconds>]                               queue runs on a loop, every 15 seconds by default; run this under your supervisor
yrd queue pause --reason <text> [--notify <seat>]                  pause admission and automatic runs; keep the queue visible
yrd queue resume [--reason <text>] [--notify <seat>]               resume on the next service interval
yrd queue list                                                    every change in line, its state, position, last result and log
yrd queue show <branch>                                           that branch's changes, newest first, each check's result and log
yrd check <name...>                                               run the named checks here, now, in a fresh checkout of HEAD
yrd env open <commit>                                             retain an exact commit detached; print its path
yrd env list                                                      list this repository's retained environments
yrd env close <path>                                              run teardown and remove a clean, unlocked environment without force
```

Queue commands and `yrd submit` take `--queue <value>`, never a positional queue. Inside a clone, a branch selects that queue at `origin`; omission reads the remote's `HEAD`. An address such as `beorn/hh#main`, `https://github.com/beorn/hh.git#main`, or `/absolute/repo#main` selects a repository and queue together. `queue run`, `up`, `pause` and `resume` accept an address outside a clone and use a queue-owned clone. Submit, list, show and watch still require a clone; addressed submit keeps the author's checkout and sends to the selected repository.

Every command takes `--json`. `yrd submit` refuses the queue branch itself: it is not a change. While paused, submit and dry-run refuse with who paused the queue, when, why, and the resume command; already-submitted changes keep their place. `yrd queue up` stays visible but does no automatic checking or merging until resume. An explicit `yrd queue run` is permitted while paused and leaves the pause in place. `yrd check` checks out HEAD afresh, so uncommitted changes are not seen.

`yrd env open` requires a full commit object ID already present locally, not a branch or abbreviated SHA. It materializes that commit's submodules and runs its declared setup; setup failure preserves the environment for inspection. Close reads teardown from the environment's current commit and refuses dirty, locked, unregistered or out-of-root paths. Failed teardown also preserves the environment.

## The config, `.yrd.yml`

The queue's config is a file on the queue branch. It is read from that branch on every queue run, never from the change, so a branch cannot change the checks that judge it. The smallest config that does something:

```yml
checks:
  - test:
      run: bun run test
```

Everything the file can say:

```yml
setup: bun install --frozen-lockfile # runs once in every fresh checkout the queue makes, before any check
teardown: bun run teardown # optional project command, run before closing a retained environment
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

For addressed queue-owner and reader commands, the host root is `git config yrd.workdir`, otherwise `$XDG_STATE_HOME/yrd` (default `~/.local/state/yrd`). Under it, the queue directory is `<host>/<repository-path>#<encoded-queue>`; an absolute local repository uses `local/<absolute-path-without-leading-slash>#<encoded-queue>` instead. Each address gets its own clone and artifacts:

```
<host root>/github.com/beorn/hh#main/
  repo/                                             the queue-owned clone; .yrd.yml is read from the queue branch
  worktrees/<run id>/<phase>/<sha>/                 temporary checkouts
  checks/<change>/<run id>/<phase>/<name>.log        retained check logs
  logs/<run id>.jsonl                               the run journal
  tmp/                                              TMPDIR for checks
```

Unaddressed commands and all submissions use the current repository and `git config yrd.workdir`, otherwise `<git-common-dir>/yrd`. Retained environments live at `<workdir>/environments/<sha-prefix>-<run id>/`; their setup and teardown logs and temp files live under `<workdir>/logs/environments/<name>/`.

The submitter and the queue share only the selected remote. The submitter pushes a branch and the change's first record there; the queue fetches it into its own clone, works in fresh checkouts, and pushes merges back. It never reads a submitter's clone, so the two can be on different machines.

## How a change moves

1. **Submit.** One atomic push of the branch and of the change's first record. The branch is pushed with `--force-with-lease`, so a push that would overwrite another submitter's head is refused, loudly.
2. **Check.** The next queue run takes every queued change, oldest first, into a fresh checkout of its head. Two built-in checks run first: the change shares history with the queue branch, and every gitlink it moved points at a commit on that submodule's `main`. Then the `on: submit` checks run.
3. **Merge.** The first checked change in line is merged with the queue branch in a fresh checkout. A third built-in check runs there: the `.yrd.yml` of the merged tree still parses, so no change can merge a config the next run cannot read. Then the `on: merge` checks run. A pass moves the queue branch to one merge commit (`--no-ff`, so the merge is visible in history) that names the change and the queue run in its trailers (`Change: <branch>@<sha>`, `Merged-By: yrd queue main [<run id>]`), committed as `yrd-service`. One change merges per run; the rest are checked again at the new queue branch on the next run. Merging several checked changes as one tested batch, and splitting a failed batch to find the culprit, is planned and not built.
4. **Decide whose fault a failure is.** A command failure normally fails the change. If the queue raised a gitlink while preparing the candidate, it also runs that phase's checks on the queue branch with those exact raises but without the candidate's own content. A passing base attributes the failure to the change; a failing or unjudgeable base leaves the queue stuck. Crashes, missing scripts, timeouts, exit 2 and unreachable submodule remotes also make it stuck. Stuck stops the queue.
5. **Notify.** Every ending runs the `notify` entries whose `on:` lists it, each with the record as one JSON object on stdin: `record` is its discriminant (merged, failed, stuck or merged-direct), followed by `change`, `submitter`, `issue` when one was given, then `reason`, `log`, and the branch's `failures` count for failed, or `merge` for merged. The queue composes no prose and knows no addresses; the commands do. A change ends once, so the same object sent again after a crash is the same message, not a second one.

**Direct merges.** The queue is meant to be the only writer of the queue branch, but nothing stops a person from pushing `main` directly, and the queue does not pretend otherwise. Every queue run walks the queue branch's history since the queue's first record and reports each commit it did not make as a `merged-direct` record, naming the commit and every gitlink it moved. Then it goes on from the new base. The change at the front is checked again there. A push the queue was about to make onto the old base is refused by its own `--force-with-lease`. A rollback is a `git revert`, submitted through the queue like any other change. A submitted change whose head reaches the queue branch by a direct merge still reads as merged; its merged record says `Merged-By: direct`.

## Superprojects

A superproject is a Git repository whose tree records other repositories as submodules. Each submodule entry is a gitlink, the exact commit of that repository. In theory that makes a set of repositories one product. In practice ordinary Git commands stop at the gitlink: `git diff` names `vendor/tool` and never a file inside it. No merge queue we know of reads a gitlink when it decides whether to merge. They merge the superproject commit as a tree of text and leave the submodule pointers to chance; Gerrit can update gitlinks automatically after a merge, which is not the same as checking a gitlink before it lands. Yrd reads them before it merges:

- A change that moves a gitlink must point it at a commit on that submodule's `main`, or the change fails at the built-in check in step 2, before any declared check runs. A gitlink at a branch commit nobody merged would make the superproject depend on a commit that can vanish.
- Every checkout the queue makes has its submodules materialized at the exact gitlinks of the commit under test, so a check sees the whole product as it would ship.
- A direct merge that moves a gitlink is reported with the gitlink's path, because that is the one thing the built-in check above never sees.
- Fetches never recurse into submodules. Under `submodule.recurse=true`, a plain fetch visits every submodule's remote every time; on a superproject with sixteen submodules that was 16 seconds per fetch against 1.
- A superproject that vendors Yrd itself as a submodule runs the vendored commit. The queue moves to a new Yrd only through its own merge of that gitlink: the loop ends clean, and a supervisor set to restart it starts the new one.

The submodule plumbing is [git-super](https://github.com/beorn/git-super), Git commands that treat a superproject and its submodule interiors as one product. Yrd uses it to materialize checkouts and to read gitlinks; it is useful on its own wherever a script asks "what changed" across a submodule boundary.

## Records

A change's history is its own ref, `refs/yrd/<encoded-queue>/<branch>@<sha>`, one commit per record: opened, then checked, then merged or failed or stuck, then sent. Each record is a one-line sentence plus trailers, the `Key: value` lines at the end of a commit message: which change (`Change:`), then per kind who submitted it and for which issue, which config judged it, which check failed and why, which merge commit merged it and which queue run made it, and which notify entries ran and whether they delivered. The ref namespace identifies the queue; there is no `Target:` trailer. The last record's trailers carry the whole state, so `yrd queue list` is one cheap read of the refs. A change's state is never stored; it is worked out from the records and from history. A change whose head is already in the queue branch's history is merged whatever its records say, and gets its merged record on the next run.

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
- **Zuul tests a merge of the whole train ahead** before the forge merges anything, checking against that projected future rather than live trunk, which is the fastest way through a busy queue. Yrd merges one change per run and checks the rest again on the new queue branch, which is slower and needs no rollback of a broken train.

The common thread: every system above answers "what exactly did we test, and is that what merged" with some mixture of trusting the tool and comparing contents. Yrd's answer is a sha you can check from any clone with nothing but git.

## Packages

| Package                   | What it is                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/yrd-queue-core` | the queue: submit, the queue read, the queue run, checks, records                               |
| `packages/yrd-cli`        | the commands and retained environments                                                          |
| `packages/yrd-process`    | running commands and Git: checkouts, time limits, and reading which processes still hold a path |

`tests/boundary` proves the queue from the outside, as a user would see it: real repositories, real pushes, real checks in their own checkouts.

## Development

Yrd needs Bun and Git. The queue runs as one process on one machine, as the user who starts it, and a check is whatever command the config names, run as that user.

```console
$ bun install --frozen-lockfile
$ bun run typecheck
$ bun run test packages/yrd-cli/tests/env-open.test.ts   # focused Vitest coverage
$ bun run check                                        # typecheck and the default test suite
```

Yrd is developed inside a larger superproject that runs it on itself, and the plan kept there records the design and its rulings; this file describes what is built.
