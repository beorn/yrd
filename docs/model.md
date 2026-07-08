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
pushed/submitted/checked → closed          (close --withdraw)
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
| `reviewing`/`reviewed` | the review gate (optional) | slot between `checked` and `merging` when review is required |

`open` PRs = phase in {pushed, submitted, checking, checked, merging, rejected}. `ls` shows the phase; "my open PRs" means not merged, not closed.

## Verbs

Three of these are atomic single-steps; `integrate` is the umbrella that ties them together and is the only one that follows the auto-flow.

| Verb | Moves | Auto? | Notes |
| --- | --- | --- | --- |
| `open <name>` | — → bay + `pushed`-to-be | — | get a bay; reserves the PR |
| *(plain `git push`)* | → `pushed` | — | fills the PR with commits |
| `submit <target>` | `pushed → submitted` | no | ask to merge. Resolves a PR, a name, or a branch (a branch with no PR is created + submitted). Never merges. |
| `check <PR>` | `submitted → checking → checked \| rejected` | **no** | run the checks only; stops at the verdict |
| `merge <PR>` | `checked → merging → merged` | **no** | merge a *checked* PR only; refuses one that isn't checked |
| `integrate <PR>` | `submitted → … → merged` | **yes** | the umbrella: check then merge, walking the PR as far right as config allows. The queue-runner and daemon call this. |
| `retry <PR>` | `rejected → …` | — | re-run a failed PR |
| `close <bay>` | closes the bay; `--withdraw` → PR `closed` | — | refuses on a dirty worktree; work is never deleted |
| `ls`, `audit`, `gc`, `refresh`, `guide`, `init` | — | — | — |

`land` and `drain` are hidden aliases of `integrate`. `merge` is its own atomic verb, not an integrate alias.

**Only `integrate` auto-flows.** `check` and `merge` are inert building blocks — they do exactly their one step and stop. `integrate` is where the auto-* config takes effect.

## Addressing

Every verb that names a PR/bay accepts any handle, and gitbay resolves it:

- a PR id (`PR7`), a name (`fix-parser`), a branch (`task/fix-parser`), a worktree id (`wt3`)
- **cwd** — run a required-reference verb from inside a bay with no argument, and it operates on that bay. (`open` is excepted — it creates.)
- **one or more** — these verbs are variadic (`submit PR7 PR8`, `close wt1 wt2`). Best-effort per target: each is attempted, each reports, the command exits non-zero if any failed. For `submit`/`integrate`, argument order = queue order.

Ambiguity (a branch and a name that are the same string) refuses and teaches; a `--branch`/`--name` disambiguator is added only if a real collision appears, not before.

## The auto-flow: submit, merge, or push

Three points automate, each its own toggle — nothing is bundled:

- **auto-submit** (`bay.autoSubmit`) — a plain `git push` also submits (→ `submitted`) instead of stopping at `pushed`.
- **auto-merge** (`bay.autoMerge`) — a `checked` PR merges itself (integrate auto-flows `checked → merged`) instead of resting. GitHub's word, GitHub's meaning.
- Both on = **push ships**.

Per-push, the same choices are push options (git forwards these to the hook; `-o` is git's mechanism, `--` is gitbay's on its own verbs — same words either way):

- `git push` — create the PR (`pushed`).
- `git push -o submit` — create and submit.
- `git push -o wait` — create, submit, integrate, and block for the verdict.
- `git bay submit --wait <PR>` — submit and integrate now, blocking (the verb-side mirror of `-o wait`).

Without a daemon the hook is synchronous, so `-o wait` and a fused `-o submit` both block today; they diverge once the daemon runs the queue in the background (then `-o submit` returns when queued, `-o wait` blocks for the merge). See the daemon section in the roadmap.

## Base — which branch a PR merges into

A PR has a **base**: the branch it merges into, defaulting to the repository's default branch. The queue is serial *per base* — PRs into different bases don't block each other; the base branch names the queue (no separate queue id). `open <name> --into <branch>` / `submit --into <branch>` set it. Note: `base` is the destination; the PR's own branch (the source) is `branch` — never call the source "target."

## What the store holds

A PR record: id, base, branch (source), phase, revision, and the worktree it's loaned to. Whether that lives in sqlite, km (PRs as nodes, queue order = tree order), or GitHub (PRs *are* GitHub PRs) is the store seam — see [store.md](store.md). `open` is derived from phase in every store.
