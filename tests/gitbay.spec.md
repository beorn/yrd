# git bay — happy path (executable spec)

This document is the canonical showcase AND the acceptance test: it runs under mdspec (`bun run spec`), so the docs cannot drift from the behavior.

## Setup: a repo, a mainline, a bay

```console
$ git init -q demo && cd demo && git commit -qm init --allow-empty && export DEMO="$PWD"
$ git bay init
bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)
$ git config bay.check "true"
```

## Open a bay for a named piece of work

PR numbers are sequential per repository, so the first bay's PR is PR1 — the doc can assert it literally.

```console
$ cd "$(git bay open fix-readme)"
$ git bay ls
WORKTREE  BAY         STATE   AGE  IDLE
wt1       fix-readme  active  {{age:/\d+[smhd]\s+/}}{{idle:/\d+[smhd]\s*/}}← you
```

## Work with plain git — the push opens the PR, `-o wait` also asks it to merge

A plain `git push` only opens the PR (state: `pushed`) and stops there —
nothing runs yet. `-o wait` fuses the separate ask-to-merge step (check, then
a zero-config native merge) into the same push (so does `-o submit`, without
blocking for the verdict; `git config bay.autoQueue true` makes every push
behave this way by default).

```console
$ echo hello > README.md && git add README.md
$ git commit -qm "docs: add readme"
$ git push -o wait
! ...
! remote: bay: PR1 received — checks running
! remote: bay: PR1 merged onto main (checks ✓)
! ...
```

## The PR landed, the bay closed

```console
$ git bay ls PR1
PR1 merged {{sha:/[0-9a-f]{40}/}} onto main (checks: ✓)
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

## The pieces, one step at a time: submit, check, merge

`-o wait` above fused every step into one push. Each piece is also its own
verb — `submit` only asks to merge (never merges), `check` only runs the
project check (submitted → checked, never merges), and `merge` only lands a
checked PR (checked → merged, never checks). `integrate` is the umbrella that
ties check + merge together in one dispatch; these atomic verbs are how you
run — or resume — one step alone.

```console
$ cd "$DEMO"
$ cd "$(git bay open second-feature)"
$ echo world > NOTES.md && git add NOTES.md
$ git commit -qm "docs: notes"
$ git push
! ...
! remote: bay: PR2 opened — git bay submit PR2 when ready
! ...
$ git bay submit PR2
bay: PR2 submitted — git bay integrate PR2 to land it
$ git bay check PR2
bay: PR2 submitted → checking
bay: PR2 checking → checked
$ git bay merge PR2
bay: PR2 checked → merging
bay: PR2 merging → merged — merged {{sha2:/[0-9a-f]{40}/}} onto main
$ git bay ls PR2
PR2 merged {{sha2}} onto main (checks: ✓)
```

No `git config bay.mergeCommand` was ever set above — `merge`/`integrate` land
with a native `git merge --no-ff` by default (§4: zero-config native merge);
`bay.mergeCommand` remains available as an override for a project that needs
one.

Assertions above are mdspec pattern-matches, not literals: `{{name:/regex/}}` for
a captured value (age, sha) reused with bare `{{name}}` in later output, inline
`...` for free-text remedy wording, and a leading/trailing `! ...` around each
push's remote output to absorb git's own `To <dest>` / ref-update lines without
pinning their exact wording. The PR number itself needs no capture: the mint is
sequential per repository, so a fresh demo repo's first PR is always `PR1`
(and, after `second-feature` opens the next worktree, `PR2`). `$DEMO` (the repo
root, exported in the setup section) is how the doc returns there to open a
second bay — mdspec runs the whole document in one persistent shell.
