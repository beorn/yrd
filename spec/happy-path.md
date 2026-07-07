---
mdspec:
  plugin: ./pending-plugin.ts
---

# git bay — happy path (executable spec)

This document is the canonical showcase AND the M1 acceptance test: it runs under mdspec (`bun mdspec spec/happy-path.md`), so the docs cannot drift from the behavior. Status: authored ahead of implementation — gates M1.

## Setup: a repo, a mainline, a bay remote

```console
$ git init -q demo && cd demo && git commit -qm init --allow-empty
$ git bay init
bay: initialized (store: sqlite, journal: .bay/journal.jsonl)
$ git config bay.workitemProvider none
$ git config bay.check "true"
```

## Check out a bay for a workitem

```console
$ cd "$(git bay co fix-readme --no-workitem)"
$ git bay status
BAY   WORKITEM     STATE   AGE
bay1  fix-readme   leased  0s   ← you
```

## Work with plain git, push to submit

```console
$ echo hello > README.md && git add README.md
$ git commit -qm "docs: add readme"
$ git push -o wait
remote: bay: changeset C-1 received — checks running
remote: bay: C-1 merged onto main (checks ✓)
```

## The loan is closed

```console
$ git bay status C-1
C-1 merged <sha> onto main (checks: ✓)
$ git bay audit
bay: clean — no strays, no unreachable pins, no refs without a workitem
```

## And a refusal teaches (unhappy path, one example)

```console
$ git commit -qm wip --allow-empty && git push
remote: bay: doors closed — <refusal with named remedy>
```

Assertions marked `<sha>`/`<refusal…>` are mdspec pattern-matches, not literals.
