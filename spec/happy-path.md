# git bay — happy path (executable spec)

This document is the canonical showcase AND the M1 acceptance test: it runs under mdspec (`bun run spec`), so the docs cannot drift from the behavior. Status: authored ahead of implementation — gates M1.

## Setup: a repo, a mainline, a bay remote

```console
$ git init -q demo && cd demo && git commit -qm init --allow-empty
$ git bay init
bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)
$ git config bay.workitemProvider none
$ git config bay.check "true"
```

## Check out a bay for a workitem

```console
$ cd "$(git bay co fix-readme --no-workitem)"
$ git bay status
BAY   WORKITEM    STATE   AGE
bay1  fix-readme  leased  {{age:/\d+[smhd]\s*/}}← you
```

## Work with plain git, push to submit

```console
$ echo hello > README.md && git add README.md
$ git commit -qm "docs: add readme"
$ git push -o wait
! ...
! remote: bay: changeset {{cid:/C-[0-9a-f]{8}/}} received — checks running
! remote: bay: {{cid}} merged onto main (checks ✓)
! ...
$ export CID=$(git bay status --json | grep -oE 'C-[0-9a-f]{8}' | head -1)
```

## The loan is closed

```console
$ git bay status "$CID"
{{cid}} merged {{sha:/[0-9a-f]{40}/}} onto main (checks: ✓)
$ git bay audit
bay: clean — no strays, no unreachable pins, no refs without a workitem
```

## And a refusal teaches (unhappy path, one example)

```console
$ git commit -qm wip --allow-empty && git push
! ...
! remote: bay: doors closed — ...
! ...
[1]
```

Assertions above are mdspec pattern-matches, not literals: `{{name:/regex/}}` for
a captured value (age, sha, changeset id) reused with bare `{{name}}` in later
output, inline `...` for free-text remedy wording, and a leading/trailing
`! ...` around each push's remote output to absorb git's own `To <dest>` /
ref-update lines without pinning their exact wording. `{{name}}` only threads
through *expected output* — it can't parameterize a later `$` command — so the
changeset id also gets captured into a real shell variable (`$CID`) via
`git bay status --json` for use as a command argument in the next block.
