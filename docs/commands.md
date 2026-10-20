# Commands in detail

The [README](../README.md) lists the commands. This page has the options and the rules behind them. `yrd <command> --help` prints the options of any command.

## Every command and its options

```
yrd submit [branch] [--submitter <name>] [--issue <id>] [--dry-run]
    verify and push the unchanged branch head (the current branch when none is named); the same head again is a retry
yrd submit [branch] --prepare [--submitter <name>] [--issue <id>]
    publish moved submodule commits before lockfile regeneration; opens no change
yrd submit --gitlink <path>=<full-sha> [--gitlink ...] --issue <id> [--submitter <name>] [--dry-run]
    build and submit a commit that only moves gitlinks to submodule commits already on their remotes
yrd merge <branch> [--submitter <name>] [--issue <id>]
    merge the branch now, ahead of the line and on a stopped line too
yrd queue run                                       one round; a round already running finishes first
yrd queue up [--interval <seconds>]                 a round every 15 seconds by default
yrd queue pause --reason <text> [--notify <name>]   stop checking and merging; submits are still accepted
yrd queue pause --maintenance <reason> [--notify <name>]
    stop checking, merging and submit intake, for a migration
yrd queue resume [--reason <text>] [--notify <name>]
    lift a pause or a stuck stop; work resumes on the next round
yrd queue withdraw <branch> [--reason <text>] [--notify <name>]
    end the open change, archive unmerged work, then delete the unchanged remote branch
yrd queue list [filter...] [--latest] [--watch]     the line, once; plain text when piped; also `yrd list`
yrd watch [filter...]                               the live view: click selects, wheel scrolls, Enter opens detail, `w` shows every draft, `?` shows the keys
yrd queue stats [--since 3h|<time>|<sha>] [--by submitter|branch]
    merged, failed, same-head retries, re-pushed branches, drafts, submit-to-merge latency
yrd queue show <branch>                             that branch's changes, newest first, each with its events and ending
yrd queue show --all --json                         every branch's changes in one document
yrd queue archive ...                               move old ended histories to cold storage; see operations.md
yrd check <name...>                                 run the named checks here, now, in a fresh checkout of HEAD
yrd env open ([commit] | --bay <name> | --issue <ref>) [--hold [reason]]
    keep a commit checked out, or open a task branch; prints the path
yrd env list                                        this repository's environments
yrd env close <path> [--retain <directory>]         run teardown and remove a clean, unlocked environment
yrd drop ...                                        retire branches whose work is merged or archived; see below
```

Every command takes `--json`. `yrd submit` refuses the queue branch itself, since it is not a change. `yrd check` checks out HEAD afresh, so it does not see uncommitted changes. `--notify` on `submit` is a deprecated alias for `--submitter` and prints a warning.

## Choosing a queue

Queue commands and `yrd submit` take `--queue <value>`, never a positional queue.

- Inside a clone, a branch name selects that queue at `origin`. Leaving it out reads the remote's `HEAD`.
- A portable address such as `example/app@main` selects a repository and a queue together.
- Escape special characters in the branch part: `%23` for `#`, `%40` for `@`, `%25` for `%`. So `example/app@release%232026` is the branch `release#2026`. The older form `example/app#main` still works for branches without `#`.
- `queue run`, `up`, `pause` and `resume` accept an address outside a clone and always work in a clone the queue owns.
- `submit`, `list`, `show` and `watch` need a clone. An addressed submit keeps your checkout and sends to the selected repository.
- `yrd merge` runs its round in the queue's own clone. Outside a clone it can only merge a change already in line.

## Submit

**Using the queue.** Commit on your own branch, then do one of three things with it:

1. **Submit** it to wait its turn: `yrd submit fix-login --submitter alice`. Submit accepts an older head when the merge composes cleanly, and never rewrites your head. A push alone leaves the branch outside the queue, as a draft. After a fix, commit and submit again: the same head is a retry, a new head is a new change.
2. **Merge** it now: `yrd merge fix-login` checks and merges that branch in this process, ahead of the line and even while the line is stopped. It reuses the branch's change if one is already in line, and submits it first if not. Every check still runs, and a fail goes back to its submitter. It exits 0 merged, 1 failed or withdrawn, 2 stuck or still in line. This is how a repair for a stuck line merges.
3. **Withdraw** it: see [Withdraw](#withdraw).

A failed check's log is on the machine running the queue.

**What submit does, in order:**

1. Refuses the queue branch, reads your branch head, then fetches the queue branch's current commit (without merging it into your branch). Operator and stuck stops accept the submit; a maintenance stop refuses it.
2. Checks shared history, and refuses a head the queue branch already contains.
3. Resolves the issue, if any, and runs the queue branch's optional `admission` command ([config.md](config.md#admission)). Changes without an issue skip admission and say so.
4. Publishes each moved submodule commit to its remote under `refs/git-super/pins/<sha>`. A pin ref already at that commit is a retry; one at another commit refuses and never moves. `--prepare` stops here.
5. Composes your commit onto the queue branch and settles gitlinks. A conflict refuses before any change opens. Your commit is never changed.
6. Pushes the branch head and the change's first record in one atomic push, with leases against the values just read. A concurrent maintenance stop refuses the whole push.
7. Returns the change. The queue checks and merges it later, against the queue branch as it is then. A successful submit means queued, not merged.

`--dry-run` does the same verification without pushing or opening a change. Submit reads the queue branch at one instant; it does not reserve it.

**Before lockfile regeneration.** If your dependency installer needs an unpublished submodule commit, run `yrd submit fix-login --prepare` first, then regenerate lockfiles, commit them, and run a normal `yrd submit`. `--prepare` validates the branch, issue and admission, publishes each moved submodule commit, and prints the permanent refs. It does not open a change or run checks, and it cannot be combined with `--dry-run` or `--gitlink`.

**Submitting submodule commits only (`--gitlink`).** This builds one commit on top of the current queue branch that only moves the named gitlinks, and submits it. It needs existing gitlink paths, full commit SHAs that the submodule remotes hold, and `--issue`.

- One pin is named `pin/<path-with-dashes>/<sha12>`; several are `pin/<paths-joined-by-+>/<digest12>`, whatever the option order.
- The commit carries `Refs: <issue>`.
- A branch operand, a malformed or duplicate pin, an unknown SHA, an already-open identical pin set, or a taken name refuses with a reason.
- A name whose change already ended is recut as `-r2`, then `-r3`. If the queue branch moves, the queue composes the queued commit itself; you do not resubmit.

## Issue bindings

A change can name an issue, from `--issue` or from a trailer in the branch's commits.

- Submit scans the branch's own history back to its merge base with the queue branch. The first `Closes:`, `Fixes:`, `Resolves:` or `Refs:` trailer wins.
- The binding survives later commits and branch renames. Two different bindings refuse and name both. `--issue` must match an existing binding.
- `yrd queue show <branch> --project-root <root>` shows up to four of the newest issues through the project's `issues.yml` `view` command, after the queue result. Each read has a 10-second limit, and a failed read names its issue without hiding the others. Issue keys are opaque, and these reads never decide anything. `show --all` makes no issue reads.

## Withdraw

`yrd queue withdraw fix-login --reason <text>` ends the open change and takes it out of the line.

- Work not already on the published queue branch is first archived at the remote, in a new ref that is read back before the remote branch is deleted.
- The command prints the archive and a one-line command that restores the branch. Submitting it again re-opens the change.
- If archiving or deleting fails, the withdrawal still stands and the error is named.
- A withdrawal sends no cancellation notice. `--notify <name>` only records a recipient on the cancellation.

## Cleaning up branches: `yrd drop`

Cleanup deletes a branch name only when its work is provably kept: on the published queue branch, in a merged queue history, or in an archive ref. Active changes, moved tips and protected branches stay.

- `yrd drop --issue <id> --dry-run --json` previews cleanup for one issue, in the root repository and in each submodule checkout the issue names. Leave out `--dry-run` to apply.
- Selection uses only recorded issue bindings, or a branch-to-issue mapping supplied by a program that embeds Yrd. It never asks an issue tracker and never scans commit messages.
- A submodule branch qualifies when its exact head is already contained in the submodule's freshly fetched default branch. Child branches go first; a child that is held or fails keeps the root branch for a retry. Submodules with their own queue keep their branches.
- Reports name the repositories inspected, what was excluded, what was selected, and any store that could not be read. An unreadable store stops retirement.
- For an already-ended change: `yrd drop fix-login --retire --tip <full-sha> --reason <why>`. It keeps the ending and the exact remote head, then deletes the name. It also accepts a never-submitted draft whose tip is already on the remote's `main`, or whose merge into `main` would change nothing.
- From a submodule checkout with no queue of its own, `yrd drop fix-login --retire --tip <full-sha> --reason <why>` uses the superproject's history and the submodule's default branch. An ancestor needs no extra event or origin archive. A nonancestor also qualifies when its conflict-free merge into fresh origin main leaves main's tree unchanged. Yrd archives and reads back that exact commit at origin before removing the branch name; the receipt reports archive custody separately from the main content proof. Content equality does not retain the original commit. Changed tips, conflicts, unintegrated content and current protections keep the branch; custody failures report observed refs and the available recovery source. Retrying an absent ancestor name reports its existing main custody. Issue-selected and automatic cleanup retain their ancestry requirement.
- To abandon unmerged local work: `yrd drop fix-login --local --tip <full-sha> --reason <why>`. It archives the tip before deleting the local name. Plain `--local` has no preview. Archiving a root commit does not archive its submodule refs. Restore with `git branch fix-login <full-sha>`.
- `--apply` and `--submodules` are still accepted and change nothing.

## Environments: `yrd env`

An environment is a separate Git worktree for one branch or commit.

- `yrd env open <commit>` needs a full commit ID already present locally, and refuses `--issue`.
- `--bay <name>` opens or adopts exactly `task/<name>`. `--issue <ref>` uses `task/<last segment of the ref>`, or an existing `task/<full ref>` if there is one. Two issues with the same last segment cannot share a branch; the refusal suggests `--bay <name> --issue <ref>`.
- With `--issue`, a first commit with a `Refs:` trailer records the binding before setup. A matching binding adds nothing; a conflicting one refuses.
- `--hold [reason]` locks the worktree before setup, so a later failure leaves it locked. The reason defaults to `manual`. `env list --json` reports it as `hold` (`null` when unlocked). It is free text, not proof of ownership. `git worktree unlock <path>` clears it.
- `yrd env close` runs teardown from the environment's current commit, then removes it. It refuses a held, dirty, locked, unregistered or out-of-root path, and keeps the environment if teardown fails. Submodule stores are kept.
- `close` also refuses while a submodule marked `private = true` in `.gitmodules` is checked out in the environment.
- In a superproject, `git super status`, `git super diff` and `git super push` work across submodule boundaries.
