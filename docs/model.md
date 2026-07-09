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
| `submit <PR|name>` | `pushed → submitted` | no (verb); system-composed | ask to merge. Resolves an existing PR or open bay, by id or name. The VERB never merges itself; a branch that hasn't been adopted yet redirects you to `adopt` first (folding that into `submit` is reserved, not yet shipped). By default (`bay.autoMerge` true) the system runs `integrate` right after, so a plain `submit` reaches `merged` — set `bay.autoMerge false` to keep it resting at `submitted` (see § The auto-flow). |
| `check <PR>` | `submitted → checking → checked \| rejected` | **no** | run the checks only; stops at the verdict |
| `merge <PR>` | `checked → merging → merged` | **no** | merge a *checked* PR only; refuses one that isn't checked |
| `integrate <PR>` | `submitted → … → merged` | **yes** | the umbrella: check then merge, walking the PR as far right as config allows. The queue-runner and daemon call this. |
| `retry <PR>` | `rejected → …` | — | re-run a failed PR |
| `close <bay>` | closes the bay; `--withdraw` → PR `closed` | — | refuses on a dirty worktree; work is never deleted |
| `ls`, `audit`, `gc`, `refresh`, `guide`, `init` | — | — | — |

`land` and `drain` are hidden aliases of `integrate`. `merge` is its own atomic verb, not an integrate alias.

**Only `integrate` auto-flows.** `check` and `merge` are inert building blocks — they do exactly their one step and stop. `integrate` is where the auto-* config takes effect — `submit`'s default "reaches `merged`" behavior (§ The auto-flow) is the SYSTEM composing `submit` with an `integrate` call, not a change to the `submit` verb itself.

## Landing evidence: the `Bay-Gate:` trailer

Every main-moving merge commit the **native** merge path authors (bay.mergeCommand unset) is self-evidencing — its message carries one `Bay-Gate:` trailer naming what an auditor needs, so the commit graph alone answers "what gated this land?":

```
Bay-Gate: pr=<id> target=<sha40> base=<sha40> [batch=<id> members=<n> ejected=<a,b|none>] check=<command|none>
```

- `base` is the mainline HEAD the merge landed on — by construction the merge commit's **first parent**; `target` is the verified tip — its **second parent**. Auditors verify both against the graph, so the trailer cannot lie about where it landed.
- `check` names the resolved gate command (same precedence as the check runner: inline > `BAY_CHECK` > `git config bay.check`). `check=none` means no gate was configured — an auditor that requires gate evidence must treat that as **non-evidence**, never as a pass.
- The `batch`/`members`/`ejected` triple appears only when the landed PR is a batch candidate: the batch id, how many members rode it, and which members were ejected on the way (`none` when the batch landed whole). `check` is deliberately last and greedy so the command may contain spaces.

A configured `bay.mergeCommand` authors its own commit, so evidence there is the **command's** responsibility — a delegate host stamps its own trailer convention (or refuses). Either way, a main-mover with neither is exactly what a spine audit should block.

## Addressing

Every verb that names a PR/bay accepts a PR id (`PR7`), a name (the label given at `open`, or `adopt`'s), or a worktree id (`wt3`) — gitbay resolves whichever you give it. `adopt <branch>` is the one verb that takes a raw branch (or SHA, or an existing worktree's name) directly, to mint it a PR; every other verb addresses the PR/bay that results, by id or name.

Reserved, not yet shipped: resolving a bare branch as an argument to every verb (folding `adopt` into `submit`); a **cwd** fallback (run a required-reference verb from inside a bay with no argument, and it operates on that bay — `open` would stay excepted, since it creates); and **variadic** addressing (`submit PR7 PR8`, `close wt1 wt2`, best-effort per argument, order = queue order for `submit`/`integrate`). Today, every verb takes exactly one argument.

Ambiguity (a name that collides with another handle gitbay resolves) refuses and teaches; a `--branch`/`--name` disambiguator is added only if a real collision appears, not before.

## The auto-flow: push creates, submit ships

Two independent toggles, both resolved fresh per push (or per `submit` call — pushOptions don't apply there):

- **`bay.autoSubmit`** (default **false**): whether a plain `git push` also submits (`pushed → submitted`), fused into the push itself. False (the default) leaves a bare push stopped at `pushed` — you submit explicitly.
- **`bay.autoMerge`** (default **true**): whether a PR that becomes `submitted` — by any path: an autoSubmit-fused push, an explicit `git bay submit`, or a `-o submit`/`-o wait` push — immediately runs `check` then `merge`, walking it to `merged`. True (the default) is what makes a plain `git bay submit <PR>` land the PR; set it false to rest at `submitted` for a manual `check`/`merge`/`integrate`.

The DEFAULT (autoSubmit false, autoMerge true) reads as "push creates, submit ships":

- `git push` — create the PR (`pushed`), nothing else runs.
- `git bay submit <PR>` — ask to merge, and by default land it too: `submitted → checking → checked → merging → merged`, one command.
- `bay.autoSubmit true` — a bare push also submits; with `autoMerge` still on (the default), `git push` alone ships all the way, no separate `submit` needed.
- `bay.autoMerge false` — fully manual: `push` → `pushed`, `submit` → `submitted` (rests there), then `check`/`merge` or `integrate` by hand.

Push options force `autoSubmit`/`autoMerge` for that one push, on top of whatever config says: `git push -o submit` forces `autoSubmit` for this push only; `git push -o wait` forces BOTH true for this push (create, submit, integrate, blocking for the verdict — in this synchronous-hook implementation `-o submit` and `-o wait` differ only in whether `autoMerge` is forced, since the post-receive hook always runs to completion before git returns to the client either way; `-o wait`'s stronger "blocks" phrasing will earn a real distinction once a daemon runs the queue in the background, see the roadmap).

Back-compat: the pre-v0.3 bundled toggle, **`bay.autoQueue`**, still works — if explicitly set, it wins over both new keys and pins `autoSubmit = autoMerge` = its value (`bay.autoQueue true` reproduces the old "every push ships" default; `bay.autoQueue false` is fully manual). New repos should set `bay.autoSubmit`/`bay.autoMerge` directly; `autoQueue` is read only for repos that already had it configured.

The `submit` VERB stays intrinsically lazy either way (`pushed → submitted` only, § Verbs above) — `autoMerge` is a SYSTEM behavior that composes `submit` with an `integrate` call, not a change to the verb. With `autoMerge` false, `submit` alone never merges; the manual equivalent is `git bay submit <PR>` then `git bay integrate <PR>` — two commands, same destination.

Reserved, not yet shipped: a `--wait` flag on the `submit` verb itself (the verb-side mirror of `-o wait`, forcing this one submit's own integrate to happen even with `bay.autoMerge false`); today the manual equivalent is the two commands above.

## Base — which branch a PR merges into

Every PR merges into the repository's single **base**: today, `origin/main` if it exists, else the mainline repo's current branch — resolved fresh each time, never chosen per PR. The queue is serial across it: submissions never race each other onto main. Note: `base` is the destination; the PR's own branch (the source) is `branch` — never call the source "target." Reserved, not yet shipped: a per-PR base override (`open <name> --into <branch>` / `submit --into <branch>`), so different PRs could target different branches and the queue could run serial *per base* instead of one queue for the whole repository.

## What the store holds

A PR record: id, name, phase, revision, and the worktree/lease it's loaned to (which carries its branch — the source). Whether that lives in sqlite, km (PRs as nodes, queue order = tree order), or GitHub (PRs *are* GitHub PRs) is the store seam — see [store.md](store.md). `open` is derived from phase in every store. A stored per-PR `base` column is reserved for when `--into` ships; today every PR shares the one repository-wide base above.
