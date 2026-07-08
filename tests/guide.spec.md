# git bay guide — agent onboarding (executable spec)

`git bay guide` is how a coding agent (or a new human) gets primed before its first action: the workflow, the rules, the vocabulary — then a live "as of right now" snapshot of THIS repository's bay configuration. It never refuses: outside a git repository it teaches the first step instead of erroring. This doc asserts the printout verbatim, so the guide can never drift from the shipped behavior. (`prime`, the pre-v0.2 name, remains a permanent hidden alias — fleet SOPs reference it.)

## Anywhere — even outside a git repository

The static half must be complete with no repository present (an agent can read it before anything exists).

```console
$ git bay guide
git bay is a small continuous-integration server for this repository: you work in a disposable worktree, plain git push opens a local pull request, and git bay integrates it into main when the checks pass — one at a time, so main is never broken.
THE LOOP
  1. cd "$(git bay open <name>)"       # your own worktree; <name> = what you call this piece of work
  2. edit, git add, git commit         # plain git; commit hooks guard submodule pins + identity
  3. git push                          # opens your PR (state: open) — nothing runs yet
  4. git bay submit <PR>               # ask to merge (open -> queued) — checks run, then the merge; READ the remote:/output lines
  5. git bay ls <PR>                   # re-read a verdict later (the PR number from the push output)
RULES
  - Work only inside your worktree, never in the repository's main checkout.
  - Read refusals fully: every refusal names the problem AND the exact fixing command. Run that command.
  - In a hurry? git push -o submit fuses steps 3+4 (git config bay.autoQueue true makes every push do this).
  - Checks failed? Fix it, then: new commits -> git push again; no new commits (config/env fix) -> git bay retry <PR>.
  - Done with a worktree? git bay close <bay|wt> refuses while its PR is still queued — integrate it, retry it, or git bay close --withdraw <bay|wt>. Uncommitted work always refuses too; commit or clean first, work is never deleted.
  - A merged PR is a closed door: its branch is finished — start the next piece of work with a fresh git bay open <name>.
  - A bay PR is local — GitHub does not see it and gh commands do not apply.
VOCABULARY
  bay        the named, ephemeral LOAN of a worktree to one piece of work — opened by git bay open <name>
  worktree   the numbered, persistent directory a bay holds (ids look like wt1) — bays come and go, worktrees are reused
  name       what you called the work at open — any label, or a ticket id your tracker knows
  PR         your commits traveling to main as one unit — numbered PR1, PR2, … per repository; a push creates one (open), git bay submit asks to merge it (queued)
  queue      queued PRs waiting to be integrated; they merge one at a time, in order
  checks     the command git bay runs before integrating a PR (git config bay.check '<command>'); exit 0 means pass
ADDRESSING
  Bay verbs (close, refresh) take a wt-id or a name; PR verbs (submit, integrate, retry) take a PR number or a name; ls takes either kind.
MACHINE-READABLE
  git bay ls --json        full state as JSON
  .git/bay/journal.jsonl   append-only event journal (every verdict, replayable)
Primed. Start: cd "$(git bay open <name>)"   (all verbs: git bay help)

THIS DIRECTORY
  not a git repository — cd into your repo first, then: git bay init
```

## Inside an initialized repository — the live snapshot

The second half is dynamic: the repository, whether the bay is initialized, the check, merge, and tracker commands as configured *right now*, and how busy the bay is. Unset config teaches the exact `git config` command that sets it.

```console
$ git init -q demo && cd demo && git commit -qm init --allow-empty
$ git bay init
bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)
$ git bay guide
...
THIS REPOSITORY — a snapshot as of right now; re-run git bay guide for current state
  repo            {{repo:/.+/}}
  state           .git/bay (initialized)
  check           (not set — pushes merge without a project check; set: git config bay.check '<command>')
  mergeCommand    (not set — git bay integrate refuses until: git config bay.mergeCommand '<command with {target}>')
  tracker         (not set — names are not checked against a tracker; set: git config bay.tracker '<command with {name}>')
  open worktrees  0
  queued PRs      0
```

Configure a check and the snapshot reflects it on the next run:

```console
$ git config bay.check "bun test"
$ git bay guide
...
  check           bun test
  mergeCommand    (not set — git bay integrate refuses until: git config bay.mergeCommand '<command with {target}>')
...
```
