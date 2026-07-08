# gitbay vision

Status: settled 2026-07-07 (owner + maintainer discussion). This document is the *why* and the *vocabulary*; [roadmap.md](roadmap.md) is the *what's next*; the README is the *how to use it today*.

## The vision, one paragraph

Anyone working in a local clone — human or agent — should get the same integration safety a good team gets from GitHub: work happens in disposable workspaces, finished work becomes a pull request, a queue integrates changes one at a time behind checks, nothing counts as merged until it's verified, and everything that happens is recorded so recurring problems show up as numbers. All of it with plain git as the interface, nothing to host, and nothing new to learn beyond the words GitHub already taught everyone.

## Why now

Coding agents multiplied how many contributors one machine has. Five agents pushing at a shared main have exactly the problems a 2005-era team had — races, clobbered work, unverified merges, branches that die unintegrated — and the machinery that solved those problems (pull requests, CI, merge queues) all lives server-side. gitbay is that machinery, local.

## What gitbay is

A small continuous-integration server that lives inside your git repository. It doesn't replace your test CI — it does the part those systems leave to you: taking finished branches and merging them into main safely, one at a time, with your checks gating each merge. No hosted service, no background daemon required; it's a plain CLI plus git hooks.

## Principles

Each of these is enforced by real code, not aspiration:

1. **Plain git is the interface.** Push is submit. No daemon, no service; state lives in `.git/bay/`.
2. **Borrowed vocabulary, zero invention.** PR, open, close, submit, integrate, checks, approve, queue — every word means what GitHub taught it to mean. Where git already has a word (`init`, `prune`, `worktree`), we use git's word.
3. **Integration is serial and proven.** One change at a time. A merge command's exit 0 is a claim; ancestry against the refreshed mainline is the proof.
4. **Refusals teach.** Every "no" states what was checked, what failed, and the exact command that fixes it.
5. **History is data.** Every event appends to a journal; counts, stats, and traces are folds over it. Systemic issues show up as numbers, not anecdotes.

## The vocabulary

**A bay is a git worktree that gitbay manages for you** — named, listed, journaled, expiring when idle, and wired so `git push` opens a PR. Make a worktree yourself and it's just a directory; open a bay and gitbay takes care of it. The relationship is the same as branch-to-PR: a PR is a branch plus identity, process, and guarantees; a bay is a worktree plus the same.

**Worktrees are numbered and persistent; bays are named and ephemeral.** The pool holds worktrees (`wt1`, `wt2`, …), recycled across tenants because provisioning is expensive. A bay is the loan of one worktree to one named piece of work, for the duration of that work.

**A PR is work you've pushed that waits to be pulled into main.** The name is truer here than on GitHub: git has had `git request-pull` from the beginning, and in gitbay there is a real puller — the queue fetches your branch and merges it. PRs get sequential numbers (`PR1`, `PR2`, …); numbers burn like GitHub's; a re-push becomes a new revision of the same PR.

**Integrating is what happens to a PR**: run the checks, merge it onto main, prove the merge landed. The lifecycle reads as a sentence: *open a bay → work → push (the PR opens) → checks run → (review, if required) → integrate → close.*

## Feature set

- **Local pull requests** — sequential PR numbers, revisions on re-push, dual addressing by PR number or work name.
- **A serial merge queue** — one change at a time, so main is never broken and merge races are structurally impossible.
- **Checks on lifecycle events** — configured commands run at provision, open, push, submit, integrate, and after merge; exit codes are verdicts; refusals teach.
- **Verified merges** — the lying-merge guard: exit 0 is not believed until the target is an ancestor of the refreshed mainline.
- **Works with super-repos** — if your repo pins submodules, gitbay refuses pushes that would silently rewind a pin, and `git bay audit` finds stale pins and orphaned refs. Plug in a submodule-aware merge command and the whole landing is handled.
- **Pooled bays** — closing a bay returns its worktree to a pool, so the next open is instant instead of re-running setup. Pre-warm a few for burst; `pool: off` for fresh-every-time.
- **Review gate (optional)** — a PR can require approval before integrating; `approve`/`reject` are the whole integration surface for external review tools. Off by default.
- **Observability built in** — the journal is the telemetry: `stats` folds rejections and refusals by reason code; spans and traces are derived views of the same history.
- **Built for agent fleets, designed for anyone** — agents are why it exists now, but nothing in it knows what an agent is.

## Where it stops

gitbay draws a hard line at *integration*. No review UI, no comments, no PR browsing beyond `ls`, no test-farm, no agent orchestration. Reviews happen wherever they happen; orchestrators sit above; test CI runs wherever it runs. gitbay is the thing that gets finished work onto main safely — keeping it that small is what keeps it trustworthy.
