# git bay

**git bay** is a small continuous-integration server that lives inside your git repository: you work in a disposable worktree, plain `git push` opens a local pull request, and git bay integrates it into main when the checks pass — one at a time, so main is never broken. No hosted service, no background daemon — it's a plain CLI.

The idea in one sentence more: anyone working in a local clone — human or agent — should get the integration safety a good team gets from GitHub (workspaces, PRs, checks, a merge queue, a full record), with plain git as the interface and nothing new to learn beyond the words GitHub already taught everyone.

## Why you'd want it

**You want git bay if…**

- you run a team of coding agents that produce more merges than a human can referee
- you want merge-queue safety (like GitHub's merge queue or GitLab's merge trains) with no hosted service and no daemon
- you have a superproject full of submodules and want changes across them to merge as one unit — like a monorepo
- you want worktrees and merging in one self-contained tool that lives entirely inside your repo

In any busy repository, the main branch is a zone of contention: two changes can each pass tests on their own and still break main when merged together, a branch can be tested against last week's main and land untested against today's, and a submodule pointer can silently move backwards, undoing work that already landed — with no record afterward of what merged, when, or why. It becomes acute with agent fleets, since agents merge far more often than people do.

## How it works, in 30 seconds

`git bay init` stores a small amount of state inside your repository's `.git/` directory: a queue database, an event journal, and a miniature bay-owned git repository whose *hooks* are the whole trick.

`git bay new <name>` opens a **worktree**: an isolated checkout — a git *worktree*, an extra working directory sharing the same repository — already wired so that its `git push` goes to that bay-owned repo. When you push, the hooks fire: your checks run, and only if they pass does your PR merge onto `main`. The verdict prints right in the push output. (git labels hook output `remote:`, even though everything here is on your machine.)

```console
$ cd "$(git bay new fix-readme)"                  # a worktree for this piece of work
$ ...edit...
$ git commit -am "docs: fix readme"               # plain git from here on
$ git push                                        # the push opens PR1
remote: bay: PR1 received — checks running
remote: bay: PR1 merged onto main (checks ✓)
$ git bay ls PR1
PR1 merged bb2b8406 onto main (checks: ✓)
```

That is real output from a live run, lightly edited for length. From a worktree there is no separate submit command to remember — the push is the PR — and no way to skip the checks by accident.

## Principles

1. **Plain git is the interface** — push is submit; state lives in `.git/bay/`.
2. **Borrowed vocabulary, zero invention** — PR, open, close, submit, integrate, checks: every word means what GitHub taught it to mean.
3. **Integration is serial and proven** — one change at a time; a merge command's exit 0 is a claim, ancestry against refreshed main is the proof.
4. **Refusals teach** — every "no" states what was checked, what failed, and the exact command that fixes it.
5. **History is data** — every event appends to one journal; counts, stats, and traces are folds over it, so recurring problems show up as numbers.

## What you get

- **Main is always checked** — PRs land one at a time, each verified against main *as it is now*, so an untested combination can never land.
- **Your workflow doesn't change** — after `git bay new`, it's ordinary `git pull` / `git commit` / `git push`; verdicts appear as `remote:` lines in the push output, where git users already look.
- **Errors that teach** — a refused push names what failed *and the exact command that fixes it*. The error messages are part of the product.
- **Safe with submodules** — a parent commit and its submodule commits land together or not at all; a pointer that would move backwards is refused, at commit time and again at the door.
- **Names connect to your issue tracker** — every worktree is opened for a named piece of work; validation and lifecycle callbacks are each one configured command.
- **Plug in your own tools by running commands** — checks, review, tracker, notifications: each is an external command the bay calls. No SDK.
- **A complete record** — every event appends to one JSONL journal: what was queued, what the checks said, what merged. Replayable, resumable, greppable.
- **No daemon** — the plain CLI gives all of the above; a background service is optional (roadmap).

## Layers

git bay is built as an event-sourced core plus `with*()` layers — each layer registers verbs, events, a state slice, and effect handlers, and the whole tool is one `pipe()` composition. Remove a layer and the system degrades to the rung below instead of breaking (without worktrees, `submit` + `integrate` is a pure merge queue). Each layer has its own page in [docs/](docs/):

| Layer | Tier | What it does |
| --- | --- | --- |
| core (`createBay`) | — | journal · fold · dispatch · typed events · the [store seam](docs/store.md) (sqlite default; adapters are ~a page) |
| [`withWorktrees`](docs/layers/worktrees.md) | core | bays: named loans of pooled, numbered worktrees; pooling is an option of this layer |
| `withQueue` / `withReceive` / `withIntegrate` | core | the PR queue, the push door, the serial verified merge |
| [`withSubmodules`](docs/layers/submodules.md) | core, auto-armed | pin-rewind refusal, atomic super-repo landings, pin audit |
| [`withIssueTracking`](docs/layers/issue-tracking.md) | optional | validate names at open; auto-close/comment issues on PR outcomes |
| [`withChecks`](docs/layers/checks.md) | optional | your commands at lifecycle points (provision, push, submit, integrate, merged) |
| [`withReviewGate`](docs/layers/review-gate.md) | optional | approval before integrate; `approve`/`reject` are the whole review-tool surface |
| `withStats` | optional | read-only folds: rejections and refusals by reason code ([events](docs/events.md)) |

Target composition (v0.3 shape — today's layer names differ slightly):

```ts
pipe(
  createBay({ store }),              // journal · fold · dispatch
  withWorktrees({ pool }),
  withQueue(), withReceive(), withIntegrate(),
  withSubmodules(),                  // auto-armed when .gitmodules exists
  withIssueTracking(config.issues),
  withChecks(config.checks),
  withReviewGate(config.review),
  withStats(),
)
```

Configuration is unifying into one committed file whose sections mirror the layer names (today it's a few `git config bay.*` keys — `bay.check`, `bay.mergeCommand`, `bay.tracker`; those retire when this lands):

```yaml
store: sqlite                        # or: km — PRs as nodes, queue order = tree order
worktrees: { pool: { prewarm: 2 } }
issues:
  validate: gh issue view {name}
  on-merged: gh issue close {name} --comment "merged as {sha} ({pr})"
checks:
  submit: bun run lint
  integrate: bun run test
review: { required: false }
queue: { limit: 10 }                 # WIP limit: refuse new PRs past N queued
```

Two name systems, deliberately: config sections are nouns matching layers (settings); slash names like `bay/open` → `bay/opened` are actions and facts (requests and events — see [docs/events.md](docs/events.md)).

## What it adds to your repository

Everything git bay stores lives in two places — there is exactly **one merge queue per repository**, and this is all of it:

```text
.git/
├── config            a few bay.* keys (until config unifies into .gitbay.yml)
└── bay/              all of git bay's state — inside .git/, where git clean can never delete it
    ├── bay.db        queue + worktree state (SQLite)
    ├── journal.jsonl append-only event journal — the merge history
    └── repo.git/     bay-owned bare repo; its receive hooks are what make push-opens-the-PR work
.bays/                your worktrees (ordinary git worktrees): wt1, wt2, …
```

Your repository's own hooks, branches, and remotes are untouched. Removing git bay is deleting `.git/bay/` and `.bays/` and unsetting the `bay.*` config keys.

## Common questions

**How do I onboard a coding agent (or a new teammate)?** `git bay guide` prints everything needed before the first action — the loop, the rules, the vocabulary — followed by a live "as of right now" snapshot of this repository's bay. Put `git bay guide` in your agent's startup instructions and the tool onboards the agent itself.

**Is this a GitHub PR?** Same idea, local: a PR is your commits traveling to main as one unit, numbered per repository (PR1, PR2, …), and it lands itself when the checks pass — like auto-merge. A bay PR is local — GitHub does not see it and `gh` commands do not apply.

**How do I tell it what checks to run?** `git config bay.check '<command>'` — the bay runs it before merging; exit 0 means pass. Repositories with their own merge process route the merge through `git config bay.mergeCommand '<command with {target}>'`, used by `git bay integrate`.

**What happens when a check fails?** The push is refused and the message says why. If the fix needs new commits, just `git push` again — the PR keeps its number. If the fix changed no commits, `git bay retry <PR>` re-runs the pipeline.

**What exactly is a worktree? A name?** A **worktree** is the directory you work in — ids look like `wt1`; it is disposable and yours alone. The **name** is what you called the work at `git bay new` — any label, or a ticket id your tracker knows. Worktree verbs (`close`, `refresh`, `gc`) act on worktrees; PR verbs (`ls`, `submit`, `integrate`, `retry`) act on PRs — and every argument accepts an id or a name.

**Can it lose my work?** Closing a worktree with uncommitted changes is refused. When `gc` retires an idle worktree, it snapshots the branch tip to a findability ref first. Nothing is ever deleted.

**What if two agents push at the same time?** Merges are strictly serial: submissions are ordered by the queue and recorded in the journal — they never race each other onto main.

**Does this replace GitHub or GitLab?** No. git bay manages your *local* main branch. Publishing that branch to a remote stays whatever it is today — many setups have the merge command itself push on success.

## Status

**Shipped.** Every verb below works today (`git bay help` for the live list):

*Start here*: `guide` (onboarding + live config snapshot) · `init` (set up: store, journal, bay-owned repo + hooks)

*Your worktree*: `new <name>` (open a worktree; prints a cd-able path) · `close <wt|name>` (uncommitted work always preserved) · `gc` (expire idle worktrees, snapshot first)

*PRs*: `ls [PR|name]` (worktree table + unmerged PRs, `--json`) · `submit <branch|name>` (PR for an existing branch) · `integrate [PR|name]` (integrate the next queued PR, `--watch`) · `retry <PR|name>` (re-queue a rejected PR)

*Repository health*: `audit` (strays, stale pins, refs without a name, `--json`)

Unambiguous prefixes work (`git bay au` is `audit`); every pre-rename verb (`co`, `status`, `land`, `merge`, `abandon`, …) still works as an unadvertised alias; `in`/`int` are shorthand for `integrate`. A merge command's exit code is never taken on faith — a PR only counts as merged when it is provably an ancestor of the refreshed main branch.

**Roadmap** (details in the layer pages):

- **v0.3 — vocabulary completion**: `open`/`close` as the advertised workspace verbs; worktree/bay split in `ls`; the event schema in [docs/events.md](docs/events.md) (typed union, envelope with cause/trace ids); `close --withdraw`.
- **v0.4 — checks + pooling + config**: checks on lifecycle events; worktree pooling on by default; WIP limits; `bay.*` git-config keys unify into `.gitbay.yml`.
- **v0.5 — review gate + RPC**: the approval state with `approve`/`reject`; a JSON-RPC adapter over the same core (ships when a real subscriber exists).
- **Horizon**: batching (several compatible changes checked as one candidate — the compatibility check is already on main), native promotion (merge in a staging area instead of your main worktree), optional background service.

## The docs are tests

Three documents in [tests/](tests/) — [gitbay.spec.md](tests/gitbay.spec.md) (the normal workflow), [refusals.spec.md](tests/refusals.spec.md) (every refusal and its fix), and [guide.spec.md](tests/guide.spec.md) (the agent-onboarding printout) — are executable specifications: [mdspec](https://mdspec.org/) runs every console block and checks the output character for character (`bun run spec`). If the docs drift from real behavior, the test suite fails.

## License

MIT
