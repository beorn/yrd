# Yrd

Yrd is a merge queue that lives inside a Git repository.

- **Submit a branch, get a verdict.** You push a branch and submit it. The queue checks it in a fresh checkout, merges it into the target branch, and tells you what happened.
- **No server, no database, no web page.** Every fact the queue knows is a commit on a ref in the repository. Any clone reads the whole state with plain `git log`.
- **One process, one machine.** By rule it is the only writer of the target branch. A hand push is detected and reported, not prevented.
- **Superprojects.** Yrd also queues a repository of repositories held together by submodules, which no other merge queue we know of does. See [Superprojects](#superprojects).

## What it was made for

- **Agents are fast.** Twenty of them on one machine push more branches in an hour than a hosted CI queue you do not control will test in a day.
- **One repository, many writers.** Without a queue, branches race to the target, half of them tested against a target that has already moved.
- **A repository of repositories.** A product that vendors its parts as submodules needs a queue that reads submodule pointers, not one that merges them blind.
- **Nothing to run but git.** The queue's memory is the repository. Back up the repository and you have backed up the queue; clone it and you can read the queue.
- **Use it** when a team, human or not, lands many changes into one repository or one superproject on one machine, and a hosted forge is storage rather than process.
- **Do not use it** when you want a review web page, hosted runners, or many machines checking in parallel. Yrd runs one queue process, and a check is a command it runs locally.

## Terms

- **change**: one branch at one commit, submitted to the queue; the nearest everyday thing is a pull request without a number or a review. Its name is `<branch>@<sha>`. Move the branch and submit again for a new change; push without submitting and the queue never sees it.
- **submitter**: whoever ran `yrd submit`, a person or an agent, named by the string given with `--notify`. Every message about the change goes to them.
- **fact**: one commit on the change's own ref recording what happened to it: opened, checked, merged, failed, stuck, sent. Facts are written once and never rewritten.
- **check**: one command the queue runs, on submit or on merge, declared in `.yrd.yml` at the target.
- **result**: pass, fail or stuck. A fail is the submitter's: the check ran and its command exited non-zero. Stuck means the queue itself cannot go on (a crash, a missing script, a check past its time limit); it stops the queue, is nobody's fault, and goes to the owner.
- **queue run**: one pass over the queue. `yrd queue run` does one; `yrd queue up` does one every interval, which is how the queue runs as a service under whatever supervisor you use.
- **target**: the branch changes merge into, `main` unless the declaration says otherwise.
- **owner**: whoever repairs a stuck queue; a string the declaration names and the notify command delivers to.
- **pin**: a submodule pointer, the commit a superproject records for one of its submodules.

## Commands

```
yrd submit [branch] [--notify <who>] [--issue <work item>]    push the branch (the current one when none is named) and open its change; same head again is a retry
yrd queue run                                                 one queue run
yrd queue up [--interval <seconds>]                           the service: a queue run on a loop
yrd queue list                                                every change in line, its state, position, last result and log
yrd queue show <branch>                                       that branch's changes, newest first, each check's result and log
yrd check <name>                                              run one of the declared checks here, now
yrd env open|list                                             a checkout of one branch to work in
```

`yrd submit` refuses the target branch itself: the target is not a change.

## The declaration, `.yrd.yml`

The queue's configuration is a file on the target branch. It is read from the target on every queue run, never from the change, so a branch cannot change the checks that judge it. The smallest declaration that does something:

```yml
remote: origin
checks:
  - test:
      run: bun test
```

`remote:` is the line that switches the queue on: the commit that added it is where the queue's own history of the target starts. Everything the file can say:

```yml
remote: origin          # the Git remote the queue reads and writes; a name or a URL
target: main            # the branch changes merge into
setup: bun install --frozen-lockfile      # runs once in every fresh checkout the queue makes
notify: bun tools/yrd-notify.ts           # your command; it gets one message per ended change on stdin and delivers it
owner: "@cto"                             # who a stuck queue is reported to; a string the notify command understands
scratch: /home/hh/scratch/yrd             # the queue's working directory: checkouts, check logs, and TMPDIR for checks
checks:
  - typecheck:                            # each check is one mapping of its name to its declaration
      run: bun run typecheck
      on: [submit, merge]                 # when it runs: submit = on the change alone, merge = on its merge with the target; default: merge
      timeoutMs: 1800000                  # default: 30 minutes
      scripts: [tools/typecheck.ts]       # restored from the target before the check runs, so a change cannot edit its own judge
      environmentPassthrough: [GITHUB_TOKEN]
```

A key the queue does not read is refused, never ignored. A check's environment is built, not inherited: `PATH`, `HOME`, `SHELL`, `LANG`, `USER`, `LOGNAME`, `LC_*`, `TMPDIR` under the working directory, plus `YRD_REPO`, `YRD_BASE_SHA` and `YRD_CANDIDATE_SHA`, plus the variables the check lists under `environmentPassthrough`.

## How a change moves

1. **Submit.** One atomic push of the branch and of the change's first fact. The branch is pushed with `--force-with-lease`, so a push that would overwrite another submitter's head is refused, loudly.
2. **Check.** The next queue run takes every queued change, oldest first, into a fresh checkout of its head. Three built-in checks run first: the change shares history with the target; every pin it moved points at a commit on that submodule's `main`; and the `.yrd.yml` that would result from the merge still parses. Then the `on: submit` checks run.
3. **Merge.** The first checked change in line is merged with the target in a fresh checkout and the `on: merge` checks run there. A pass moves the target to one merge commit (`--no-ff`, so the merge is visible in history) that names the change in its message (`Change: <branch>@<sha>`). Only one change merges per run; the rest are checked again at the new target on the next run.
4. **Decide whose fault a failure is.** A check runs once. If its command exits non-zero, the change failed and it is the submitter's: they read the log, and if the failure was the queue's environment rather than their change, they submit the same head again. The queue never reruns a check to decide. Stuck is different: a crash, a missing script, a check past its time limit, a check that exits 2, a submodule's remote that cannot be asked. Stuck stops the queue and goes to the owner.
5. **Send.** Every ended change sends one message through the `notify` command: fail to the submitter with what to do next, stuck to the owner, merged to the submitter. The message id is the sha of the fact that ended the change, so sending it again after a crash is the same message, not a second one.

**Others may push the target.** The queue is meant to be the only writer, but nothing stops a person from pushing `main` by hand, and the queue does not pretend otherwise. Every queue run walks the target's history since the queue started and reports each commit it did not make to the owner, naming the commit and every pin it moved. Then it goes on from the new base. The change at the front is checked again there. A push the queue was about to make onto the old base is refused by its own `--force-with-lease`. A rollback is a `git revert`, submitted through the queue like any other change.

## Superprojects

A superproject is a Git repository whose tree records other repositories as submodules. Each submodule entry is a pin, the exact commit of that repository. In theory that makes a set of repositories one product. In practice ordinary Git commands stop at the pin: `git diff` names `vendor/tool` and never a file inside it. No merge queue we know of reads a pin when it decides whether to merge. They merge the superproject commit as a tree of text and leave the submodule pointers to chance; Gerrit can move pins after a merge, outside its gate. Yrd reads them before it merges:

- A change that moves a pin must point it at a commit on that submodule's `main`, or the change fails at the built-in check in step 2, before any declared check runs. A pin at a branch commit nobody merged would make the superproject depend on a commit that can vanish.
- Every checkout the queue makes has its submodules materialized at the exact pins of the commit under test, so a check sees the whole product as it would ship.
- A hand push that moves a pin is reported with the pin's path, because that is the one thing the built-in check above never sees.
- Fetches never recurse into submodules. Under `submodule.recurse=true`, a plain fetch visits every submodule's remote every time; on a superproject with sixteen submodules that was 16 seconds per fetch against 1.
- A superproject that vendors Yrd itself as a submodule runs the vendored commit. The queue moves to a new Yrd only through its own merge of that pin: the loop ends clean, and a supervisor set to restart it starts the new one.

The submodule plumbing is [git-super](https://github.com/beorn/git-super), Git commands that treat a superproject and its submodule interiors as one product. Yrd uses it to materialize checkouts and to read pins; it is useful on its own wherever a script asks "what changed" across a submodule boundary.

## Facts

A change's history is its own ref, `refs/yrd/changes/<branch>@<sha>`, one commit per fact: opened, then checked, then merged or failed or stuck, then sent. Each fact is a one-line sentence plus trailers, the `Key: value` lines at the end of a commit message (`Fact:`, `Branch:`, `Head:`, `Target:`, and per kind `Submitter:`, `Work-Item:`, `Config:`, `Base:`, `Check:`, `Merge:`, `Merged-By:`, `Reason:`, `Fault:`, `Remedy:`, `Detail:`, `To:`, `Delivery:`). The last fact's trailers carry the whole state, so `yrd queue list` is one cheap read of the refs. A change's state is never stored; it is worked out from the facts and from history. A change whose head is already in the target's history is merged whatever its facts say. So a change merged by hand still shows merged, and gets its merged fact on the next run, marked `Merged-By: hand`.

Every check writes one line in the queue run's log when it starts and one when it ends. The end line carries the exit code, the duration and the path of the check's own log:

```
<workdir>/checks/<branch>@<sha>/<run id>/<phase>/<name>.log      run id: the queue run's start time; phases: submit, merge
```

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | the run ended with nothing failed or stuck; the service loop also ends with 0 when the pin of Yrd itself moved, so a supervisor set to restart it starts the new version |
| 1 | a change ended failed and was sent back |
| 2 | stuck: the queue cannot go on until the owner repairs it; a supervisor should leave it down |

There is one place in the code that exits. A signal, or an error nobody caught, is stuck.

## Compared with other systems

| | What is tested | What merges | Where the state lives | Superproject |
|---|---|---|---|---|
| **Yrd** | the merge of target and change, in a fresh checkout | that same merge commit | commits on refs in the repository; no server | pins checked and materialized |
| **GitHub merge queue** | several queued pull requests merged together and tested as one | that group's result | GitHub | none: the tree merges, pins unread |
| **GitLab merge trains** | a pipeline per position in the train | GitLab's merge | GitLab | none |
| **Gerrit** | the patch set | per submit strategy; rebase or cherry-pick can mint a sha nobody tested | git refs on the Gerrit server | pins can move after a merge, outside the gate |
| **Zuul** | the whole train ahead, merged ahead of time | whatever the forge then merges | the forge plus ZooKeeper | many repositories per change, named by a footer, not pins |
| **bors-ng** | a staging merge of the batch | the exact staging sha, fast-forwarded | its own database | none |

In both directions:

- **bors-ng made the rule famous**: test the merge, then ship exactly what you tested. Yrd keeps that rule and adds what bors-ng lacks: a change that follows its branch without a human re-approving every push, and pins.
- **Squash and rebase merges buy a clean linear log**, which is a real win for casual reading, and GitHub's and GitLab's queues offer them. The price is that the commit you authored never becomes `main`, so "is my exact commit in" has no ancestry answer. Yrd pays the opposite price, merge commits in the log, and buys the answer back with `git log --first-parent`.
- **Gerrit's change identity survives any number of revisions.** Yrd's `Change:` trailer on the merge commit and its per-change ref are the same idea at the git layer, without the server, the amend-and-push ceremony, or a submit strategy that merges an untested sha.
- **Zuul merges the whole train ahead of time** and gates against that projected future, not live trunk, which is the fastest way through a busy queue. Yrd merges one change per run and checks the rest again on the new target, which is slower and needs no rollback of a broken train.

The common thread: every system above answers "what exactly did we test, and is that what merged" with some mixture of trusting the tool and comparing contents. Yrd's answer is a sha you can check from any clone with nothing but git.

## Packages

| Package | What it is |
|---|---|
| `packages/yrd-queue-core` | the queue: submit, the queue read, the queue run, checks, facts |
| `packages/yrd-cli` | the commands |
| `packages/yrd-process` | running commands and Git: checkouts, time limits, and reading which processes still hold a path |
| `packages/yrd-bay` | `yrd env`: a checkout of one branch for a person or an agent to work in |

`tests/boundary` proves the queue from the outside, as a user would see it: real repositories, real pushes, real checks in their own checkouts.

## Development

```
bun install --frozen-lockfile
bun run typecheck
bun fix                                   # oxlint + oxfmt
TMPDIR=<scratch> NODE_ENV=test bun --bun node_modules/.bin/vitest run
```

Yrd is developed inside a larger superproject that runs it on itself, and the plan kept there records the design and its rulings; this file describes what is built.
