# Yrd

Yrd is a merge queue: it tests each change against the latest version of your main branch, and merges only what passed. It lives inside a Git repository. A queue runs on a branch, `main` for most repositories. A change is another branch, submitted to that queue.

- **Submit a branch, get a result.** You commit your changes on a branch and submit it. The queue checks it in a fresh checkout, merges it into the queue branch, and tells you what happened.
- **No server, no database, no web page.** The queue keeps its state as commits under `refs/yrd/` on the Git remote you already use. Any clone can fetch those refs and read the whole history with plain `git log`.
- **One process, one machine.** It checks and merges one change at a time, and by rule it is the only writer of the queue branch. Someone can still push to it directly; the queue records that commit and carries on from it.
- **Superprojects.** Yrd also queues a repository of repositories held together by submodules, which no other merge queue we know of does. See [Superprojects](#superprojects).

## What it was made for

- **AI agents are fast.** Checks run on the machine that holds the queue, so the time per change is the time your checks take. No hosted runner queue stands ahead of you.
- **One repository, many writers.** Without a queue, branches race to the queue branch, and some are tested against a queue branch that has already moved.
- **A repository of repositories.** A product that vendors its parts as submodules needs a queue that reads submodule pointers, not one that merges them blind.
- **Nothing to run but git.** The queue's memory is the repository. Back up the repository and you have backed up the queue; clone it and you can read the queue.
- **Use it** when a team, human or not, merges many changes into one repository or one superproject on one machine, and a hosted forge is storage rather than process.
- **Do not use it** when you want a review web page, hosted runners, or many machines checking in parallel. Yrd runs one queue process, and a check is a command it runs locally.

## Install

Yrd needs [Bun](https://bun.sh) (CI tests with 1.4.3) and Git. It is not on npm yet, so run it from a clone:

```console
$ git clone https://github.com/beorn/yrd
$ cd yrd
$ bun install --frozen-lockfile
$ bun bin/yrd.ts --help
```

To run it as `yrd`, add the clone's `bin/` directory to your `PATH`. The Git remote needs no hooks or plugins, but it must accept atomic pushes (GitHub does).

## Quick start

1. Commit a `.yrd.yml` to the queue branch, naming the checks a change must pass:

   ```yml
   checks:
     - test:
         run: bun run test
   ```

2. On the machine that will run the checks, start the queue from a clone of your repository: `yrd queue up`. That machine needs permission to push to the remote. Run the command under any process supervisor.
3. Commit your work on a branch and submit it: `yrd submit fix-login --submitter alice`. The submitter is just a name the queue passes on to notifications.
4. Follow it with `yrd watch` (live) or `yrd queue show fix-login`. If a check fails, the change goes back to you. `yrd queue show` names the check's log file, which stays on the queue's machine, not in Git.

## Terms

- **change**: one branch at one commit, submitted to the queue; think of a pull request without a number or a review. Its name is `<branch>@<sha>`. Move the branch and submit again for a new change. A branch that was pushed but not submitted, and is not already on the queue branch, is a **draft**: the list shows it, and the queue ignores it.
- **submitter**: whoever ran `yrd submit`, named by `--submitter` or `YRD_DEFAULT_SUBMITTER`. Yrd passes that string to your notify commands and reads nothing into it.
- **queue branch**: the branch the queue merges into, chosen with `--queue <branch>` or defaulting to the remote's `HEAD`.
- **check**: one command the queue runs on a change, named in `.yrd.yml` on the queue branch.
- **result**: pass, fail or stuck. A **fail** is the submitter's: a check exited non-zero. **Stuck** means the queue itself cannot judge the change (a crash, a missing script, a check past its time limit); the line stops until the change is withdrawn or merged.
- **record**: one commit on the change's own ref recording one step and its result. Records are written once and never rewritten.
- **round**: one pass of the queue. `yrd queue run` does one; `yrd queue up` does one every 15 seconds.
- **gitlink**: a submodule pointer, the commit a superproject records for one of its submodules.
- **direct merge**: a commit pushed straight to the queue branch, bypassing the queue. The queue reports it and builds on it; if it broke something, revert it through the queue.

## States

A change normally goes `draft` → `submitted` → `checking` → `pending` → `merging` → `merged`. It can also end `failed` or `cancelled`, or stop the line as `stuck`.

| State       | Meaning                                                    | What happens next                   |
| ----------- | ---------------------------------------------------------- | ----------------------------------- |
| `draft`     | pushed to the remote, not submitted                        | `yrd submit`                        |
| `submitted` | in the queue, waiting for its first check                  | the queue checks it                 |
| `checking`  | the queue is testing it now                                | `pending`, `stuck` or `failed`      |
| `pending`   | checks passed; waiting in line to merge                    | merges when the line reaches it     |
| `merging`   | the queue is writing the queue branch for it now           | `merged` or `failed`                |
| `merged`    | on the queue branch; ended                                 | nothing; a revert is a new change   |
| `deferred`  | checks exceeded the normal bound; waits for the long check | runs in the long tier               |
| `stuck`     | the queue could not judge it and stopped the line          | repair and resume, merge, or cancel |
| `failed`    | a check exited non-zero; ended                             | the author fixes it and resubmits   |
| `cancelled` | withdrawn with `yrd queue withdraw`; ended                 | resubmitting re-opens it            |

`yrd list --help` and the `?` key in `yrd watch` show the same table.

## Commands

```
yrd submit [branch]             verify the branch against the queue branch, push it, and put it in line
yrd merge <branch>              check and merge one branch now, ahead of the line, even on a stopped line
yrd queue withdraw <branch>     take a change out of the line; its ending event keeps the commit
yrd queue list                  the line, printed once (also `yrd list`)
yrd watch                       the line, live in the terminal; `?` shows the keys
yrd queue show <branch>         one branch's changes, newest first, each with its events and ending
yrd queue stats                 merged, failed and retried counts, and time from submit to merge
yrd queue run                   one round of the queue
yrd queue up                    a round every 15 seconds; run this under your supervisor
yrd queue pause | resume        stop or restart checking and merging; submits still wait in line
yrd check <name...>             run named checks here, now, in a fresh checkout of HEAD
yrd env open | list | close     a separate checkout of one branch to work in
yrd drop <branch>               retire a branch whose tip is kept by main or a queue event
```

Every command takes `--json` and `--help`, and `yrd <command> --help` lists every option. The details, including queue addresses, submitting submodule commits, and branch cleanup, are in [docs/commands.md](docs/commands.md).

## The config, `.yrd.yml`

The config is a file on the queue branch. Each round reads it from there, never from the change, so a branch cannot change the checks that judge it. A fuller example:

```yml
setup: bun install --frozen-lockfile # runs once in each fresh checkout, before any check
checks:
  - typecheck:
      run: bun run typecheck
      on: [submit, merge] # submit: the change alone; merge: its merge with the queue branch (the default)
      timeoutMs: 1800000 # the default: 30 minutes
notify:
  - submitter:
      on: [merged, failed]
      run: bun tools/notify.ts # your command; it gets the result as one JSON object on stdin
```

Running the queue refuses a key it does not know. A check gets a clean environment, not yours. The queue's own Git operations never run repository hooks, so put every check in `.yrd.yml`. Every key, the check environment, the pre-submit `admission` command and the notify protocol are in [docs/config.md](docs/config.md).

## How a change moves

1. **Submit.** `yrd submit` checks that the branch merges cleanly with the queue branch, then pushes the branch and the change's first record in one atomic push. No check runs yet.
2. **Check.** Each round takes the oldest change in line into a fresh checkout. Built-in checks run first: the change shares history with the queue branch, and every gitlink it moves points at a commit on that submodule's `main` or ahead of it. Then the `on: submit` checks run.
3. **Merge.** The first change that passes is merged with the queue branch in another fresh checkout. A built-in check confirms the merged `.yrd.yml` still parses, then the `on: merge` checks run. A pass moves the queue branch to that exact merge commit, made with `--no-ff` and marked `Change: <branch>@<sha>`. One change merges per round, and every check runs again on the new base.
4. **Fail or stuck.** A check that exits non-zero fails the change, and it goes back to its submitter. A change the queue cannot judge is stuck and stops the line until it is withdrawn or merged. `yrd merge` merges a repair past it.
5. **Notify.** Every ending runs the `notify` entries that list it, with the record on stdin. Delivery is at least once, so a notify command must accept a repeat.

A direct push to the queue branch is reported as a `merged-direct` record, with any gitlinks it moved, and the next round starts from it. A rollback is a `git revert`, submitted like any other change.

Running the queue (stops, stalls, health, logs, archived history) is covered in [docs/operations.md](docs/operations.md).

## Superprojects

A superproject is a Git repository whose tree records other repositories as submodules. Each submodule entry is a gitlink, the exact commit of that repository. Ordinary Git commands stop at the gitlink: `git diff` names `vendor/tool` and never a file inside it. No merge queue we know of reads gitlinks before it merges; they merge the superproject as a tree of text. Gerrit can update gitlinks after a merge, which is not the same as checking them before. Yrd reads them before it merges:

- A change that moves a gitlink must point it at a commit on that submodule's `main` or ahead of it. A pointer that diverged from `main` fails the change before any declared check runs.
- A pointer ahead of `main` is how a submodule change merges. Commit inside the submodule, move the gitlink, and submit the superproject once. After every check passes, the queue moves the submodule's `main` forward to the new commit, then pushes the superproject. No submodule `main` moves before the whole tree is green.
- Every checkout the queue makes has its submodules at the exact gitlinks under test, so a check sees the whole product as it would ship.
- A direct push that moves a gitlink is reported with the gitlink's path.
- The queue's fetches never recurse into submodules, even with `submodule.recurse=true`. On a superproject with sixteen submodules, a recursive fetch took 16 seconds against 1.

The submodule plumbing is [git-super](https://github.com/beorn/git-super), Git commands that treat a superproject and its submodules as one product.

## Exit codes

| Exit | Meaning                                                                                     |
| ---- | ------------------------------------------------------------------------------------------- |
| 0    | the round ended with nothing failed or stuck                                                |
| 1    | at least one change failed in this round and was sent back                                  |
| 2    | stuck: the queue stopped at a change that needs repair, or the command itself could not run |

`yrd merge` exits with the state of its change instead: 0 merged, 1 failed or withdrawn, 2 stuck or still in line. `yrd queue up` keeps running through a stuck change and exits 2 only when it cannot run at all. In a superproject that vendors Yrd, it exits 0 when a new Yrd version is merged, so a supervisor that restarts it picks up the new version.

## Compared with other systems

Like bors-ng, Yrd tests the merge and then ships exactly the commit it tested. It needs no forge or database to hold the queue, and it always merges with a merge commit, so the commit you wrote is the one in `main`. Of GitHub's and GitLab's queues, Gerrit, Zuul and bors-ng, none checks submodule pointers before merging. In exchange, Yrd merges one change at a time on one machine, where GitHub's queue and Zuul test several queued changes together. The full comparison with GitHub, GitLab, Gerrit, Zuul and bors-ng is in [docs/comparison.md](docs/comparison.md).

## Development

```console
$ bun install --frozen-lockfile
$ bun run check                                        # typecheck and the default test suite
$ bun fix                                              # lint and format
```

The packages, the test layout and more commands are in [docs/development.md](docs/development.md). Yrd is developed inside a larger superproject that runs Yrd on itself. Ideas and bug reports are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
