# git bay

**git bay** is a small continuous-integration server that lives inside your git repository: you work in a disposable worktree, plain `git push` opens a local pull request, and git bay integrates it into main when the checks pass — one at a time, so main is never broken. No hosted service, no background daemon — it's a plain CLI.

Where this is going: [docs/vision.md](docs/vision.md) (the why and the vocabulary) and [docs/roadmap.md](docs/roadmap.md) (the target design, versioned).

## Why you'd want it

**You want git bay if…**

- you run a team of coding agents that produce more merges than a human can referee
- you want merge-queue safety (like GitHub's merge queue or GitLab's merge trains) with no hosted service and no daemon
- you have a superproject full of submodules and want changes across them to merge as one unit — like a monorepo
- you want worktrees and merging in one self-contained tool that lives entirely inside your repo
- you expect merge volume that needs batching — several changes checked as one candidate (shipping in v0.2)

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

That is real output from a live run, lightly edited for length: the SHA is shortened to 8 characters (`git bay ls` prints all 40), and git's own push chatter (the `To <dest>` and ref-update lines) is left out.

From a worktree there is no separate submit command to remember — the push is the PR — and no way to skip the checks by accident.

## What you get

- **Main is always checked** — PRs land one at a time, each verified against main *as it is now*, so an untested combination can never land.
- **Your workflow doesn't change** — after `git bay new`, it's ordinary `git pull` / `git commit` / `git push`. The verdicts appear as `remote:` lines in the push output, where git users already look.
- **Errors that teach** — a refused push names what failed *and the exact command that fixes it*. The error messages are part of the product.
- **Safe with submodules** — a parent-repo commit and its submodule commits land together or not at all, and a submodule pointer that would move backwards is refused.
- **Guarded at commit time, too** — the worktree's git hooks refuse a stale submodule pointer or an unnamed branch at `git commit`, before a push is even attempted.
- **Plug in your own tools by running commands** — checks, review, notifications: each is an external command the bay calls. No SDK.
- **Names connect to your issue tracker** — every worktree is opened for a named piece of work, and the tracker hookup is one config key (`git config bay.tracker '<command with {name}>'`), so "which ticket is this branch for?" always has an answer.
- **Worktrees are lightweight sandboxes** — each piece of work runs in its own isolated worktree with guarded hooks, so parallel work can't contaminate the main checkout or each other.
- **A complete record** — every event is appended to one JSONL journal: what was queued, what the checks said, what merged. Replayable, resumable, greppable.
- **No daemon** — the plain CLI gives all of the above; a background service is optional (roadmap).

## Try it

```console
$ git init -q myrepo && cd myrepo && git commit -qm init --allow-empty   # a normal repo — nothing bay-specific yet
$ git bay init
bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)
$ cd "$(git bay new fix-readme)"
$ git bay ls
WORKTREE  NAME        STATE  AGE  IDLE
wt1       fix-readme  open   0s   0s    ← you
$ echo "fix the readme" > README.md && git add README.md && git commit -qm "docs: fix readme"
$ git push
remote: bay: PR1 received — checks running
remote: bay: PR1 merged onto main (checks ✓)
$ git bay ls PR1
PR1 merged bb2b840617f44846b7a62e10ceb6c73b39ccbc9e onto main (checks: ✓)
$ git bay audit
bay: clean — no strays, no unreachable pins, no refs without a name
```

Every line above is a real command against the current build, run in a scratch repo. Same small edit as before: git's own push chatter is left out between the two `remote:` lines.

## What it adds to your repository

Everything git bay stores lives in two places — there is exactly **one merge queue per repository**, and this is all of it:

```text
.git/
├── config            a few bay.* keys (bay.check, bay.tracker, …)
└── bay/              all of git bay's state — inside .git/, where git clean can never delete it
    ├── bay.db        queue + worktree state (SQLite)
    ├── journal.jsonl append-only event journal — the merge history
    └── repo.git/     bay-owned bare repo; its receive hooks are what make push-opens-the-PR work
.bays/                your worktrees (ordinary git worktrees): wt1, wt2, …
```

Your repository's own hooks, branches, and remotes are untouched. Removing git bay is deleting `.git/bay/` and `.bays/` and unsetting the `bay.*` config keys.

## Common questions

**How do I onboard a coding agent (or a new teammate)?** `git bay guide` prints everything needed before the first action — the loop, the rules, the vocabulary — followed by a live "as of right now" snapshot of this repository's bay: is it initialized, which check, merge, and tracker commands are configured, how busy it is. It works anywhere, even outside a git repository. Put `git bay guide` in your agent's startup instructions and the tool onboards the agent itself.

**Is this a GitHub PR?** Same idea, local: a PR is your commits traveling to main as one unit, numbered per repository (PR1, PR2, …), and it lands itself when the checks pass — like auto-merge. Review is an optional command gate (roadmap). A bay PR is local — GitHub does not see it and `gh` commands do not apply.

**How do I tell it what checks to run?** `git config bay.check '<command>'`. The bay runs that command before merging; exit 0 means pass. Repositories with their own merge process can also route the merge itself through a command: `git config bay.mergeCommand '<command with {target}>'`, used by `git bay integrate`.

**What happens when a check fails?** The push is refused and the message says why. If the fix needs new commits, just `git push` again — the PR keeps its number. If the fix changed no commits (a config or environment fix), `git bay retry <PR>` re-runs the pipeline.

**What exactly is a worktree? A name?** A **worktree** is the directory you work in — ids look like `wt1`; it is disposable and yours alone. The **name** is what you called the work at `git bay new` — any label, or a ticket id your tracker knows. Worktree verbs (`close`, `refresh`, `gc`) act on worktrees; PR verbs (`ls`, `submit`, `integrate`, `retry`) act on PRs — and every argument accepts an id or a name.

**Can it lose my work?** Closing a worktree with uncommitted changes is refused (commit or clean first — the worktree stays yours). When `gc` retires an idle worktree, it snapshots the branch tip to a findability ref first. Nothing is ever deleted.

**What do the `ls` columns mean?** AGE is how long ago `new` opened the worktree; IDLE is how long since its last activity. STATE is `open` (active) or `stale` (idle past the timeout — `gc` will expire it, snapshotting the work first).

**What if two agents push at the same time?** Merges are strictly serial: submissions are ordered by the queue and recorded in the journal — they never race each other onto main.

**Does this replace GitHub or GitLab?** No. git bay manages your *local* main branch. Publishing that branch to a remote stays whatever it is today — many setups have the merge command itself push on success.

## Status

**Shipped.** Every verb below works today, grouped by what it operates on (`git bay help` for the live list):

*Start here*
- `guide` — onboarding for agents and newcomers: the workflow, the rules, the vocabulary, plus a live snapshot of this repository's bay config
- `init` — set up git bay for this repository (state in `.git/bay/`: store, journal, bay-owned `repo.git` + hooks)

*Your worktree*
- `new <name>` — open a worktree for a named piece of work; prints its path (cd-able)
- `close <wt|name>` — close the worktree; uncommitted work is always preserved (refuses if dirty)
- `gc` — expire idle worktrees (work is snapshotted first, never deleted)

*PRs*
- `ls [PR|name]` — worktree table + every unmerged PR, or one PR's verdict (`--json`)
- `submit <branch|name>` — open a PR for an existing branch (from inside a worktree, plain `git push` does this)
- `integrate [PR|name]` — integrate the next queued PR into main, or the named one (`--watch` keeps integrating)
- `retry <PR|name>` — put a rejected or stuck PR back in the queue and re-run its pipeline

*Repository health*
- `audit` — find strays, stale pins, and refs without a name (`--json`)

Addressing is uniform: worktree verbs take a wt-id or a name; PR verbs take a PR number or a name; `ls` takes either kind. Unambiguous prefixes work (`git bay au` is `audit`), and every pre-rename verb (`co`, `status`, `enqueue`, `requeue`, `land`, `drain`, `abandon`, `adopt`, `merge`, `refresh`, `prime`, …) still works as an unadvertised alias — nothing breaks. `git bay in` and `git bay int` are shorthand aliases for `integrate`.

Also shipped: a merge command's exit code is never taken on faith — a PR only counts as merged when it is provably an ancestor of the refreshed main branch — and the compatibility check that the batching roadmap below builds on.

**Roadmap:**

- **v0.2 — batching**: merge several compatible changes as one checked candidate instead of strictly one at a time — one check run covers the whole batch, which is where the real savings on slow test suites live (the compatibility check is already on main); tolerate honestly rebased branches by comparing patch content rather than commit ids.
- **v0.2 — review gate**: a `bay.review` command between checks and merge — an optional approval step (human or agent) before a PR lands.
- **v0.3 — native promotion**: the bay performs the merge in its own staging area instead of merging in your main worktree.
- **v0.4 — background service**: an optional daemon for watch-mode and async operation, with the same guarantees as the bare CLI.

## The docs are tests

Three documents in [tests/](tests/) — [gitbay.spec.md](tests/gitbay.spec.md) (the normal workflow, the same console blocks shown above), [refusals.spec.md](tests/refusals.spec.md) (every refusal and its fix), and [guide.spec.md](tests/guide.spec.md) (the agent-onboarding printout) — are executable specifications: [mdspec](https://mdspec.org/) runs every console block in them and checks the output character for character (`bun run spec`). If the docs drift from the real behavior, the test suite fails.

## License

MIT
