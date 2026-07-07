# git bay — refusals (executable spec)

Sibling to [spec/happy-path.md](happy-path.md) (spec § Testing: "Unhappy paths
get sibling mdspec docs as they land"). Same idiom, same gate — `bun run spec`
runs both. This doc is the acceptance artifact for epic AC7: every refusal
names the failed check AND the exact fixing command, asserted verbatim
including the remedy line — not paraphrased in prose above the fence.

## Setup: a repo, a mainline, a bay remote

```console
$ git init -q demo && cd demo && git commit -qm init --allow-empty && export DEMO="$PWD"
$ git bay init
bay: initialized (store: sqlite, journal: .bay/journal.jsonl)
$ git config bay.workitemProvider none
```

## A red check teaches

`bay.check` is the ONE project check (spec § Check provider). A failing check
never touches the mainline — it rejects the changeset and names the exact
command that failed, with its exit code and output.

```console
$ git config bay.check "false"
$ cd "$(git bay co red-check --no-workitem)"
$ echo hello > README.md && git add README.md
$ git commit -qm "docs: add readme"
$ git push -o wait
! ...
! remote: bay: changeset {{cid:/C-[0-9a-f]{8}/}} received — checks running
! remote: bay: {{cid}} rejected — check 'false' failed (exit 1):
! ...
$ export CID=$(git bay status --json | grep -oE 'C-[0-9a-f]{8}' | head -1)
$ git bay status "$CID"
{{cid:/C-[0-9a-f]{8}/}} rejected — check 'false' failed (exit 1):
```

The push itself succeeds (checks run post-receive, asynchronously to the ref
update) — the rejection is a domain verdict, not a transport failure. Nothing
merged; the branch and the changeset both survive for the next section.

## Resume without a new commit

No new commit, so there is nothing to push — `requeue` is the resume verb: it
resubmits the SAME sha through the SAME pipeline once the fix (here: the check
itself) is in place.

```console
$ git config bay.check "true"
$ git bay requeue "$CID"
bay: changeset {{cid}} received — checks running
bay: {{cid}} merged onto main (checks ✓)
$ git bay status "$CID"
{{cid}} merged {{sha:/[0-9a-f]{40}/}} onto main (checks: ✓)
```

## Dirty abandon refuses

`abandon` ends a lease, but it never destroys uncommitted work — the reason
this project exists (spec § Design laws #5, "the loan closes at submit").

```console
$ cd "$DEMO" && cd "$(git bay co dirty-abandon --no-workitem)"
$ echo "uncommitted change" > scratch.txt
$ export LEASE=$(git bay status --json | grep -oE '"L[0-9]+":' | tail -1 | tr -d '":')
$ git bay abandon "$LEASE"
! bay: refusing to retire bay at ... — working tree is dirty:
! ?? scratch.txt
! Commit or push your work, then abandon; bay never deletes uncommitted work.
[1]
```

The lease itself is marked ended (crash-safe bookkeeping: the event journals
before the retire effect runs and can refuse), but the worktree — and
`scratch.txt` inside it — is untouched on disk. Clean it up so the next
section's `co` can reclaim the bay slot; a real user would commit or push
instead.

```console
$ rm scratch.txt
```

## Doors closed

The signature refusal, from a fresh loan: once a changeset is merged, its
branch is a closed door — re-pushing it (even a new, unrelated commit) is
refused before it ever reaches a check.

```console
$ cd "$DEMO" && cd "$(git bay co doors-closed --no-workitem)"
$ echo hello > doors-closed.md && git add doors-closed.md
$ git commit -qm "docs: doors closed demo"
$ git push -o wait
! ...
! remote: bay: changeset {{cid2:/C-[0-9a-f]{8}/}} received — checks running
! remote: bay: {{cid2}} merged onto main (checks ✓)
! ...
$ git commit -qm wip --allow-empty && git push
! ...
! remote: bay: doors closed — changeset {{cid2}} for 'task/doors-closed' is already merged. Open a new loan: git bay co <workitem>
! ...
[1]
```

Assertions above follow the same mdspec idioms as happy-path.md (see its
closing note): `{{name:/regex/}}` captures a value on first use and every bare
`{{name}}` after it must match the same text; a leading/trailing `! ...`
absorbs git's own transport lines around each push's remote output; inline
`...` absorbs free-text remedy wording mid-line. stdout and stderr captures
live in separate namespaces, so `{{cid}}` (defined on stderr in the push
block, then again on stdout in the `status` block) is two independent
captures of the same value, not one shared variable — mdspec has no
cross-stream backreference. `{{cid2}}` is a distinct name because it is a
different changeset than `{{cid}}`, defined fresh so it is never checked for
equality against it.
