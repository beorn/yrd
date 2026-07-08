# git bay — happy path (executable spec)

This document is the canonical showcase AND the acceptance test: it runs under mdspec (`bun run spec`), so the docs cannot drift from the behavior.

## Setup: a repo, a mainline, a bay

```console
$ git init -q demo && cd demo && git commit -qm init --allow-empty
$ git bay init
bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)
$ git config bay.check "true"
$ git config bay.mergeCommand "git merge --no-ff -q {target}"
```

## Open a bay for a named piece of work

PR numbers are sequential per repository, so the first bay's PR is PR1 — the doc can assert it literally.

```console
$ cd "$(git bay open fix-readme)"
$ git bay ls
WORKTREE  BAY         STATE   AGE  IDLE
wt1       fix-readme  active  {{age:/\d+[smhd]\s+/}}{{idle:/\d+[smhd]\s*/}}← you
```

## The push creates the PR — it doesn't land yet

Creation and the ask-to-land are separate acts, like a real GitHub PR: `git push` opens PR1 in state `open` and stops there. Nothing has been checked or merged.

```console
$ echo hello > README.md && git add README.md
$ git commit -qm "docs: add readme"
$ git push
! ...
! remote: bay: PR1 opened — git bay submit PR1 when ready
! ...
```

## Ask to merge — submit queues it, integrate lands it

```console
$ git bay submit PR1
bay: PR1 queued — git bay integrate PR1 to land it
$ git bay integrate
bay: PR1 queued → merging
bay: PR1 merging → merged
```

## The PR landed, the bay closed

```console
$ git bay ls PR1
PR1 merged (checks: ✓)
$ git bay audit
bay: clean — no strays, no unreachable pins, no refs without a name
```

## And a refusal teaches (unhappy path, one example)

```console
$ git commit -qm wip --allow-empty && git push
! ...
! remote: bay: doors closed — ...
! ...
[1]
```

In a hurry? `git push -o submit` fuses "push" and "submit" into one step (create AND ask to merge); `git push -o wait` additionally blocks for the verdict — and `git config bay.autoQueue true` makes every push behave that way by default, matching the pre-v0.3 behavior. [tests/refusals.spec.md](refusals.spec.md) shows both.

Assertions above are mdspec pattern-matches, not literals: `{{name:/regex/}}` for
a captured value (age) reused with bare `{{name}}` in later output, inline
`...` for free-text remedy wording, and a leading/trailing `! ...` around each
push's remote output to absorb git's own `To <dest>` / ref-update lines without
pinning their exact wording. The PR number itself needs no capture: the mint is
sequential per repository, so a fresh demo repo's first PR is always `PR1`.
(The configured merge command uses `-q` so its own output stays out of the
verdict line entirely, rather than needing to pattern-match it away.)
