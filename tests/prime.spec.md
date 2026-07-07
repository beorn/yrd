# git bay prime — agent onboarding (executable spec)

`git bay prime` is how a coding agent (or a new human) gets primed before its first action: the workflow, the rules, the vocabulary — then a live "as of right now" snapshot of THIS repository's bay configuration. It never refuses: outside a git repository it teaches the first step instead of erroring. This doc asserts the printout verbatim, so the primer can never drift from the shipped behavior.

## Anywhere — even outside a git repository

The static half must be complete with no repository present (an agent can read it before anything exists).

```console
$ git bay prime
git bay — a merge queue for this repository. You submit by pushing; the bay checks and merges each change onto main, one at a time.
THE LOOP
  1. cd "$(git bay co <workitem>)"    # your own workspace (a git worktree); <workitem> = ticket id or any label
  2. edit, git add, git commit        # plain git; commit hooks guard submodule pins + identity
  3. git push                         # push IS submit — checks run, then the merge; READ the remote: lines
  4. git bay status <changeset>       # re-read a verdict later (the C-xxxxxxxx id from the push output)
RULES
  - Work only inside your workspace, never in the repository's main worktree.
  - Read refusals fully: every refusal names the problem AND the exact fixing command. Run that command.
  - Checks failed? Fix it, then: new commits -> git push again; no new commits (config/env fix) -> git bay requeue <changeset>.
  - Abandoning a workspace? git bay abandon <lease> refuses while uncommitted work exists — commit or clean first; work is never deleted.
  - Doors close at merge: a merged changeset ends that loan — start the next piece of work with a fresh git bay co.
VOCABULARY
  bay        the system itself — this repository's merge queue (git bay init sets it up)
  workspace  the isolated git worktree loaned to you (ids look like bay1)
  workitem   the name you gave co — a ticket id or any label
  changeset  the unit being merged (your pushed commits), id like C-5a7a2f95
  lease      the loan of a workspace to a workitem; abandon/refresh/gc act on it
MACHINE-READABLE
  git bay status --json    full state as JSON
  .git/bay/journal.jsonl   append-only event journal (every verdict, replayable)
Primed. Start: cd "$(git bay co <workitem>)"   (all verbs: git bay help)

THIS DIRECTORY
  not a git repository — cd into your repo first, then: git bay init
```

## Inside an initialized repository — the live snapshot

The second half is dynamic: the repository, whether the bay is initialized, the check and merge commands as configured *right now*, and how busy the bay is. Unset config teaches the exact `git config` command that sets it.

```console
$ git init -q demo && cd demo && git commit -qm init --allow-empty
$ git bay init
bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)
$ git bay prime
...
THIS REPOSITORY — a snapshot as of right now; re-run git bay prime for current state
  repo          {{repo:/.+/}}
  state         .git/bay (initialized)
  check         (not set — pushes merge without a project check; set: git config bay.check '<command>')
  mergeCommand  (not set — the queue's drain refuses until: git config bay.mergeCommand '<command with {target}>')
  open leases   0
  queued        0
```

Configure a check and the snapshot reflects it on the next run:

```console
$ git config bay.check "bun test"
$ git bay prime
...
  check         bun test
  mergeCommand  (not set — the queue's drain refuses until: git config bay.mergeCommand '<command with {target}>')
...
```
