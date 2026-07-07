# git bay — refusals (executable spec)

Sibling to [tests/gitbay.spec.md](gitbay.spec.md) (spec § Testing: "Unhappy paths
get sibling mdspec docs as they land"). Same idiom, same gate — `bun run spec`
runs both. This doc is the acceptance artifact for epic AC7: every refusal
names the failed check AND the exact fixing command, asserted verbatim
including the remedy line — not paraphrased in prose above the fence.

## Setup: a repo, a mainline, a bay

```console
$ git init -q demo && cd demo && git commit -qm init --allow-empty && export DEMO="$PWD"
$ git bay init
bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)
```

## A red check teaches

`bay.check` is the ONE project check (spec § Check provider). A failing check
never touches the mainline — it rejects the PR and names the exact command
that failed, with its exit code and output.

```console
$ git config bay.check "false"
$ cd "$(git bay new red-check)"
$ echo hello > README.md && git add README.md
$ git commit -qm "docs: add readme"
$ git push -o wait
! ...
! remote: bay: PR1 received — checks running
! remote: bay: PR1 rejected — check 'false' failed (exit 1):
! ...
$ git bay ls PR1
PR1 rejected — check 'false' failed (exit 1):
```

The push itself succeeds (checks run post-receive, asynchronously to the ref
update) — the rejection is a domain verdict, not a transport failure. Nothing
merged; the branch and the PR both survive for the next section.

## Resume without a new commit

No new commit, so there is nothing to push — `retry` is the resume verb: it
resubmits the SAME sha through the SAME pipeline once the fix (here: the check
itself) is in place. The PR keeps its number across the retry.

```console
$ git config bay.check "true"
$ git bay retry PR1
bay: PR1 received — checks running
bay: PR1 merged onto main (checks ✓)
$ git bay ls PR1
PR1 merged {{sha:/[0-9a-f]{40}/}} onto main (checks: ✓)
```

## Dirty close refuses

`close` ends a worktree, but it never destroys uncommitted work — the reason
this project exists (spec § Design laws #5, "the loan closes at submit"). The
refusal happens at the door, BEFORE anything journals: the worktree stays
yours. Note the dual addressing: the argument is the NAME given at `new`; the
refusal answers with the worktree id (`wt1`), and either form works.

```console
$ cd "$DEMO" && cd "$(git bay new dirty-close)"
$ echo "uncommitted change" > scratch.txt
$ git bay close dirty-close
! bay: refusing to close wt1 — the worktree at ... has uncommitted work:
! ?? scratch.txt
! Commit or push it first; bay never deletes uncommitted work. The worktree is still yours.
[1]
$ git bay ls
WORKTREE  NAME         STATE  AGE  IDLE
wt1       dirty-close  open   ...
```

State and disk never diverge: the table still lists the worktree because
nothing was journaled. Clean up (a real user would commit or push instead) and
the SAME close retires it — worktree removed, branch tip preserved under
`refs/bay/abandoned/<PR>`.

```console
$ rm scratch.txt
$ cd "$DEMO"
$ git bay close dirty-close
$ git bay ls
no open worktrees — git bay new <name> opens one
```

(The `cd` out first matters: a successful close removes the worktree directory,
and a shell left standing in a removed directory can't run anything git after.)

## Doors closed

The signature refusal, from a fresh worktree: once a PR is merged, its branch
is a closed door — re-pushing it (even a new, unrelated commit) is refused
before it ever reaches a check. Note the PR number: `dirty-close` above burned
PR2 (a worktree pre-mints its number at `new`, and a number is never reused),
so this worktree's PR is PR3.

```console
$ cd "$DEMO" && cd "$(git bay new doors-closed)"
$ echo hello > doors-closed.md && git add doors-closed.md
$ git commit -qm "docs: doors closed demo"
$ git push -o wait
! ...
! remote: bay: PR3 received — checks running
! remote: bay: PR3 merged onto main (checks ✓)
! ...
$ git commit -qm wip --allow-empty && git push
! ...
! remote: bay: doors closed — PR3 for 'task/doors-closed' is already merged. Start the next piece of work in a fresh worktree: git bay new <name>
! ...
[1]
```

Assertions above follow the same mdspec idioms as gitbay.spec.md (see its
closing note): a leading/trailing `! ...` absorbs git's own transport lines
around each push's remote output; inline `...` absorbs free-text (the absolute
worktree path in the dirty-close refusal, the AGE/IDLE cells in the table).
PR numbers are asserted literally — the sequential mint makes them
deterministic in a fresh demo repo, burned numbers included.
