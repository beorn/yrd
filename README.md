# Yrd

Yrd is a merge queue for a Git repository. You push a branch and submit it; the queue checks it, merges it into the target branch, and tells you what happened. There is no pull request and no review step: the queue is the only writer of the target branch, and every fact it knows is a commit in the repository, so there is no database. The queue runs as a service under Hab, the team's process supervisor, so it is already running; nobody starts it for their change.

## The words

- **change**: one branch at one commit, submitted to the queue; the nearest everyday thing is a pull request without a number or a review. Its name is `<branch>@<sha>`. Move the branch and submit again for a new change; push without submitting and the queue never sees it.
- **submitter**: whoever ran `yrd submit`, a person or an agent, named by the seat given with `--notify`. Every message about the change goes to them.
- **fact**: one commit on the change's own ref recording what happened to it: opened, checked, merged, failed, stuck, sent. Facts are written once and never rewritten.
- **check**: one test the queue runs, on submit or on merge, declared in `.yrd.yml` at the target.
- **result**: pass, fail or stuck. A fail is the submitter's fault only when the rule in step 4 below proves it. Stuck means the queue itself cannot go on (a crash, a missing script, a check past its time limit); it stops the queue, is nobody's fault, and goes to the owner.
- **queue run**: one pass over the queue. `yrd queue run` does one; `yrd queue up` does one every interval, and that loop is the service hab runs.
- **target**: the branch changes merge into, `main` unless the declaration says otherwise.
- **pin**: the commit of Yrd that the parent repository's `vendor/yrd` submodule points at. The queue runs that commit's code, and moves to a new one only through its own merge of the submodule pointer.

## Commands

```
yrd submit <branch> [--notify <seat>] [--issue <work item>]   push the branch and open its change; same head again is a retry
yrd queue run                                                 one queue run
yrd queue up [--interval <seconds>]                           the service: a queue run on a loop
yrd queue list                                                every change in line, its state, position, last result and log
yrd queue show <branch>                                       that branch's changes, newest first, each check's result and log
yrd check <name>                                              run one of the declared checks here, now
yrd env open|list                                             a checkout of one branch to work in
```

`yrd submit` refuses the target branch itself: the target is not a change.

## The declaration, `.yrd.yml`

The queue's configuration lives in `.yrd.yml` on the target branch. It is read from the target on every queue run, never from the change, so a branch cannot change the checks that judge it:

```yml
remote: origin          # the Git remote the queue reads and writes
target: main
setup: bun install --frozen-lockfile      # runs once in every fresh checkout the queue makes
notify: bun tools/yrd-notify.ts           # your command; it gets one message per ended change and delivers it to the submitter
owner: "@cto"                             # who a stuck queue is reported to
scratch: /home/hh/scratch/yrd            # temp root for checks and checkouts (on the root filesystem, never /tmp)
checks:
  - name: typecheck
    run: bun run typecheck
    on: [submit, merge]                   # default: merge
    timeoutMs: 1800000                    # default: 30 minutes
    scripts: [tools/typecheck.ts]         # restored from the target before the check runs
    environmentPassthrough: [GITHUB_TOKEN]
```

A key the queue does not read is refused, never ignored. A check's environment is built, not inherited: `PATH`, `HOME`, `SHELL`, `LANG`, `USER`, `LOGNAME`, `LC_*`, `TMPDIR` at the scratch root, plus `YRD_REPO`, `YRD_BASE_SHA` and `YRD_CANDIDATE_SHA`, plus the variables the check lists under `environmentPassthrough`.

## How a change moves

1. **Submit.** One atomic push of the branch and of the change's first fact. The branch is pushed with `--force-with-lease`, so a push that would overwrite another submitter's head is refused, loudly.
2. **Check.** The next queue run takes every queued change, oldest first, into a fresh checkout of its head. Three built-in checks run first: the change shares history with the target; every submodule pointer it moved points at a commit on that submodule's `main`; and the `.yrd.yml` that would result from the merge still parses. Then the `on: submit` checks run.
3. **Merge.** The first checked change in line is merged with the target in a fresh checkout and the `on: merge` checks run there. A pass moves the target to one merge commit (`--no-ff`, so the merge is visible in history) that names the change in its message (`Change: <branch>@<sha>`). Only one change merges per run; the rest are checked again at the new target on the next run.
4. **Decide whose fault a failure is.** A failing check is run again in the change's checkout, then once at the target without the change. It is the submitter's fail only if it failed both times in the change and did not fail at the target. Anything else is stuck: a crash, a missing script, a check past its time limit, a check that exits 2, a submodule's remote that cannot be asked.
5. **Send.** Every ended change sends one message through the `notify` command: fail to the submitter with what to do next, stuck to the owner, merged to the submitter. The message id is the sha of the fact that ended the change, so sending it again after a crash is the same message, not a second one.

## Facts

A change's history is its own ref, `refs/yrd/changes/<branch>@<sha>`, one commit per fact: opened, then checked, then merged or failed or stuck, then sent. Each fact is a one-line sentence plus trailers, the `Key: value` lines at the end of a commit message (`Fact:`, `Branch:`, `Head:`, `Target:`, and per kind `Submitter:`, `Work-Item:`, `Config:`, `Base:`, `Check:`, `Merge:`, `Merged-By:`, `Reason:`, `Fault:`, `Remedy:`, `Detail:`, `To:`, `Delivery:`). The last fact's trailers carry the whole state, so `yrd queue list` is one cheap read of the refs. A change's state is never stored; it is worked out from the facts and from history: a change whose head is already in the target's history is merged whatever its facts say, so a change merged by hand still shows merged and gets its merged fact on the next run, marked `Merged-By: hand`.

Every check writes one line in the queue run's log when it starts and one when it ends. The end line carries the exit code, the duration and the path of the check's own log:

```
<workdir>/checks/<branch>@<sha>/<run id>/<phase>/<name>.log      phases: submit, merge, again, target
```

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | the run ended with nothing failed or stuck |
| 1 | a change ended failed and was sent back |
| 2 | stuck: the queue cannot go on until the owner repairs it; Hab leaves the service down |
| 18 | the pin moved under the service; Hab relaunches it on the new pin within seconds |

There is one place in the code that exits. A signal, or an error nobody caught, is stuck.

## Packages

| Package | What it is |
|---|---|
| `packages/yrd-queue-core` | the queue: submit, the queue read, the queue run, checks, facts |
| `packages/yrd-cli` | the commands |
| `packages/yrd-process` | running commands and Git: checkouts, time limits, cleaning up what dead runs left behind |
| `packages/yrd-bay` | `yrd env`: a checkout of one branch for a person or an agent to work in |
| `packages/yrd-core` | failure, clock and duration types shared by the others |

`tests/boundary` proves the queue from the outside, as a user would see it: real repositories, real pushes, real checks in their own checkouts.

## Development

```
bun install --frozen-lockfile
bun run typecheck
bun fix                                   # oxlint + oxfmt
TMPDIR=<scratch> NODE_ENV=test bun --bun node_modules/.bin/vitest run
```

The design and its rulings live in the Hallohuman plan for Yrd; this file describes what is built.
