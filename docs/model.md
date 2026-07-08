# The model — states, verbs, and the auto-flow

This is the canonical lifecycle. Everything else (CLI, RPC, config, events) is a projection of it.

## A bay is a PR you're still working on

`git bay open <name>` gives you a **bay** — a git worktree gitbay manages, with a PR number reserved. You work in it with plain git. The bay *is* its PR, from the moment you open it until the PR merges or closes.

## Status: open · merged · closed

Every PR has one of three top-level statuses, borrowed from GitHub:

- **open** — in flight. Derived, not stored: a PR is open whenever it is neither merged nor closed.
- **merged** — landed on the base branch. Terminal, success.
- **closed** — finished without merging (you withdrew it). Terminal.

A PR is *open until it merges or closes.*

## Phases (where a PR sits while open)

```
pushed → submitted → checking → checked → merging → merged
                        │          │
                        └── rejected ──┘   (checks/review failed — still open; retry or close)
pushed/submitted/checked/rejected → closed (close --withdraw)
```

Each phase is the past tense of the act that produced it — one rule, no exceptions:

| Phase | Produced by | Means |
| --- | --- | --- |
| `pushed` | `git push` | commits are in; not yet asking to merge |
| `submitted` | `git bay submit` | asked to merge; waiting |
| `checking` | checks running | — |
| `checked` | checks passed | green, not merged — the resting state |
| `merging` | merge running | — |
| `merged` | merge landed + verified | terminal (status: merged) |
| `rejected` | checks or review failed | still open; `retry` re-runs, or `close` gives up |
| `closed` | `close --withdraw` | terminal (status: closed) |
| `reviewing` | the review gate (optional) | reserved: slots between `checked` and `merging` when review is required — approval moves straight to `merging` (a separate `reviewed` resting state isn't a type value yet) |

`open` PRs = phase in {pushed, submitted, checking, checked, merging, reviewing, rejected}. `ls` shows the phase; "my open PRs" means not merged, not closed. `close --withdraw` can resolve any of pushed/submitted/checked/rejected/reviewing straight to `closed`; one still actively `checking` or `merging` must finish first.

## Verbs

Three of these are atomic single-steps; `integrate` is the umbrella that ties them together and is the only one that follows the auto-flow.

| Verb | Moves | Auto? | Notes |
| --- | --- | --- | --- |
| `open <name>` | — → bay + `pushed`-to-be | — | get a bay; reserves the PR |
| *(plain `git push`)* | → `pushed` | — | fills the PR with commits |
| `submit <PR|name>` | `pushed → submitted` | no | ask to merge. Resolves an existing PR or open bay, by id or name. Never merges; a branch that hasn't been adopted yet redirects you to `adopt` first (folding that into `submit` is reserved, not yet shipped). |
| `check <PR>` | `submitted → checking → checked \| rejected` | **no** | run the checks only; stops at the verdict |
| `merge <PR>` | `checked → merging → merged` | **no** | merge a *checked* PR only; refuses one that isn't checked |
| `integrate <PR>` | `submitted → … → merged` | **yes** | the umbrella: check then merge, walking the PR as far right as config allows. The queue-runner and daemon call this. |
| `retry <PR>` | `rejected → …` | — | re-run a failed PR |
| `close <bay>` | closes the bay; `--withdraw` → PR `closed` | — | refuses on a dirty worktree; work is never deleted |
| `ls`, `audit`, `gc`, `refresh`, `guide`, `init` | — | — | — |

`land` and `drain` are hidden aliases of `integrate`. `merge` is its own atomic verb, not an integrate alias.

**Only `integrate` auto-flows.** `check` and `merge` are inert building blocks — they do exactly their one step and stop. `integrate` is where the auto-* config takes effect.

## Addressing

Every verb that names a PR/bay accepts a PR id (`PR7`), a name (the label given at `open`, or `adopt`'s), or a worktree id (`wt3`) — gitbay resolves whichever you give it. `adopt <branch>` is the one verb that takes a raw branch (or SHA, or an existing worktree's name) directly, to mint it a PR; every other verb addresses the PR/bay that results, by id or name.

Reserved, not yet shipped: resolving a bare branch as an argument to every verb (folding `adopt` into `submit`); a **cwd** fallback (run a required-reference verb from inside a bay with no argument, and it operates on that bay — `open` would stay excepted, since it creates); and **variadic** addressing (`submit PR7 PR8`, `close wt1 wt2`, best-effort per argument, order = queue order for `submit`/`integrate`). Today, every verb takes exactly one argument.

Ambiguity (a name that collides with another handle gitbay resolves) refuses and teaches; a `--branch`/`--name` disambiguator is added only if a real collision appears, not before.

## The auto-flow: submit, merge, or push

Shipped today, one bundled toggle — **`bay.autoQueue`**: a plain `git push` also submits and runs it all the way through (`pushed → submitted → checking → checked → merging → merged`) instead of stopping at `pushed`. The same choice is a push option, once per push: `git push -o submit` or `git push -o wait` (synonyms today — both create, submit, and integrate, blocking for the verdict; they'll diverge once a daemon runs the queue in the background, see the roadmap).

- `git push` — create the PR (`pushed`), nothing else runs.
- `git push -o submit` / `git push -o wait` — create, submit, integrate, block for the verdict (`git config bay.autoQueue true` makes every push do this).
- Manual equivalent: `git bay submit <PR>` then `git bay integrate <PR>` — two commands, same destination; `submit` alone never merges.

Reserved, not yet shipped: splitting the bundle into two independent toggles — **auto-submit** (a push submits but rests at `checked`, GitHub's "open a PR that still wants an explicit merge") and **auto-merge** (a `checked` PR merges itself once `integrate` reaches it) — so a repo could choose either half instead of both together. A `--wait` flag on the `submit` verb itself (the verb-side mirror of `-o wait`) is reserved too; today the manual equivalent is the two commands above.

## Base — which branch a PR merges into

Every PR merges into the repository's single **base**: today, `origin/main` if it exists, else the mainline repo's current branch — resolved fresh each time, never chosen per PR. The queue is serial across it: submissions never race each other onto main. Note: `base` is the destination; the PR's own branch (the source) is `branch` — never call the source "target." Reserved, not yet shipped: a per-PR base override (`open <name> --into <branch>` / `submit --into <branch>`), so different PRs could target different branches and the queue could run serial *per base* instead of one queue for the whole repository.

## What the store holds

A PR record: id, name, phase, revision, and the worktree/lease it's loaned to (which carries its branch — the source). Whether that lives in sqlite, km (PRs as nodes, queue order = tree order), or GitHub (PRs *are* GitHub PRs) is the store seam — see [store.md](store.md). `open` is derived from phase in every store. A stored per-PR `base` column is reserved for when `--into` ships; today every PR shares the one repository-wide base above.
