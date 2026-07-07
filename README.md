# git bay

**git bay** is a merge queue for your local repository. You work in an isolated workspace, submit by running plain `git push`, and the bay checks and merges each change onto `main` one at a time — so `main` never receives an untested merge. No server, no pull requests, no daemon.

It was built for machines that run fleets of coding agents against one repository, but the safety it adds — *nothing lands on main unchecked* — is just as useful for a single developer who has tests and would rather not break their own main branch.

## How it works, in 30 seconds

`git bay init` stores a small amount of state inside your repository's `.git/` directory: a queue database, an event journal, and a miniature bay-owned git repository whose *hooks* are the whole trick.

`git bay co <name>` loans you a **bay**: an isolated checkout — a git *worktree*, an extra working directory sharing the same repository — already wired so that its `git push` goes to that bay-owned repo. When you push, the hooks fire: your checks run, and only if they pass does the bay merge your change onto `main`. The verdict prints right in the push output. (git labels hook output `remote:`, even though everything here is on your machine.)

```console
$ cd "$(git bay co fix-readme)"                   # get a workspace for this piece of work
$ ...edit...
$ git commit -am "docs: fix readme"               # plain git from here on
$ git push                                        # push IS submit
remote: bay: changeset C-5a7a2f95 received — checks running
remote: bay: C-5a7a2f95 merged onto main (checks ✓)
$ git bay status C-5a7a2f95
C-5a7a2f95 merged d2eb46f5 onto main (checks: ✓)
```

That is real output from a live run, lightly edited for length: the SHA is shortened to 8 characters (`git bay status` prints all 40), and git's own push chatter (the `To <dest>` and ref-update lines) is left out.

There is no separate submit/land/finish command to remember, and no way to skip the checks by accident.

## The problem

In any busy repository, the main branch is a zone of contention:

- **Broken combinations.** Two changes each pass tests on their own, then break the build when merged — because nobody checked the *combination*. Pushing straight to main means nobody ever does.
- **Stale merges.** A branch was tested against last week's main. By the time it merges, main has moved, and the result is untested again.
- **Submodule regressions.** In repositories with submodules, a careless merge can move a submodule pointer *backwards* — silently undoing work that had already landed.
- **No record.** When something does go wrong, there is often no answer to "what was merged, when, by whom, and what did the checks say?"

All of this is familiar on human teams. It becomes acute when coding agents work the same repository: agents merge far more often than people, at all hours, with nobody watching. Hosted merge queues — GitHub's merge queue, GitLab's merge trains — solve this for cloud pull-request workflows. git bay gives the same discipline to a local-first workflow, with no server and no PRs.

## What you get

- **Main is always checked** — changes merge one at a time, each verified against main *as it is now*, so an untested combination can never land.
- **Your workflow doesn't change** — after `git bay co`, it's ordinary `git pull` / `git commit` / `git push`. The verdicts appear as `remote:` lines in the push output, where git users already look.
- **Errors that teach** — a refused push names what failed *and the exact command that fixes it*. The error messages are part of the product.
- **Safe with submodules** — a parent-repo commit and its submodule commits land together or not at all, and a submodule pointer that would move backwards is refused.
- **Guarded at commit time, too** — the workspace's git hooks refuse a stale submodule pointer or a branch with no work item at `git commit`, before a push is even attempted.
- **Plug in your own tools by running commands** — checks, review, notifications: each is an external command the bay calls. No SDK.
- **Work items connect to your issue tracker** — every workspace is tied to a named piece of work, and the tracker hookup is one config key (`bay.workitemProvider`), so "which ticket is this branch for?" always has an answer.
- **Workspaces are lightweight sandboxes** — each piece of work runs in its own isolated worktree with guarded hooks, so parallel work can't contaminate the main checkout or each other.
- **A complete record** — every event is appended to one JSONL journal: what was queued, what the checks said, what merged. Replayable, resumable, greppable.
- **No daemon** — the plain CLI gives all of the above; a background service is optional (roadmap).

## Try it

```console
$ git init -q myrepo && cd myrepo && git commit -qm init --allow-empty   # a normal repo — nothing bay-specific yet
$ git bay init
bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)
$ cd "$(git bay co fix-readme)"
$ git bay status
BAY   WORKITEM    STATE   AGE
bay1  fix-readme  leased  0s   ← you
$ echo "fix the readme" > README.md && git add README.md && git commit -qm "docs: fix readme"
$ git push
remote: bay: changeset C-5a7a2f95 received — checks running
remote: bay: C-5a7a2f95 merged onto main (checks ✓)
$ git bay status C-5a7a2f95
C-5a7a2f95 merged d2eb46f54e1ca5a139eec695ba3a42745b370f84 onto main (checks: ✓)
$ git bay audit
bay: clean — no strays, no unreachable pins, no refs without a workitem
```

Every line above is a real command against the current build, run in a scratch repo. Same small edit as before: git's own push chatter is left out between the two `remote:` lines.

## What it adds to your repository

Everything git bay stores lives in two places — there is exactly **one merge queue per repository**, and this is all of it:

```text
.git/
├── config            a few bay.* keys (bay.check, bay.mergeCommand, …)
└── bay/              all of git bay's state — inside .git/, where git clean can never delete it
    ├── bay.db        queue + lease state (SQLite)
    ├── journal.jsonl append-only event journal — the merge history
    └── repo.git/     bay-owned bare repo; its receive hooks are what make push-is-submit work
.bays/                your loaned workspaces (ordinary git worktrees), one directory per lease
```

Your repository's own hooks, branches, and remotes are untouched. Removing git bay is deleting `.git/bay/` and `.bays/` and unsetting the `bay.*` config keys.

## Common questions

**How do I onboard a coding agent (or a new teammate)?** `git bay prime` prints everything needed before the first action — the loop, the rules, the vocabulary — followed by a live "as of right now" snapshot of this repository's bay: is it initialized, which check and merge commands are configured, how busy it is. It works anywhere, even outside a git repository. Put `git bay prime` in your agent's startup instructions and the tool onboards the agent itself.

**How do I tell it what checks to run?** `git config bay.check '<command>'`. The bay runs that command before merging; exit 0 means pass. Repositories with their own landing process can also route the merge itself through a command: `git config bay.mergeCommand '<command with {target}>'`, used by the queue's merge worker.

**What happens when a check fails?** The push is refused and the message says why. If the fix needs new commits, just `git push` again. If the fix changed no commits (a config or environment fix), `git bay requeue <changeset>` re-runs the pipeline.

**What exactly is a changeset? A lease? A work item?** A **changeset** is the unit being merged — the commits you pushed, tracked under an id like `C-5a7a2f95`. A **lease** is the loan of a workspace to a piece of work; `abandon`, `ping`, and `gc` act on leases. The **work item** is just the name you gave `git bay co` — a ticket id or any label.

**Can it lose my work?** Abandoning a workspace with uncommitted changes is refused (commit or clean first — the workspace stays yours). When `gc` retires an idle workspace, it snapshots the branch tip to a findability ref first. Nothing is ever deleted.

**What do the `status` columns mean?** AGE is how long ago `co` created the lease; IDLE is how long since its last activity (`git bay refresh <lease>` resets it). STATE is `leased` (active) or `stale` (idle past the lease TTL — `gc` will expire it, snapshotting the work first).

**What if two agents push at the same time?** Merges are strictly serial: submissions are ordered by the queue and recorded in the journal — they never race each other onto main.

**Does this replace GitHub or GitLab?** No. git bay manages your *local* main branch. Publishing that branch to a remote stays whatever it is today — many setups have the merge command itself push on success.

## Status

**v0.1 — shipped.** Every verb below works today, grouped by what it operates on (`git bay help` for the live list; unambiguous prefixes work too, e.g. `git bay st`):

*Start here*
- `prime` — onboarding for agents and newcomers: the workflow, the rules, the vocabulary, plus a live snapshot of this repository's bay config
- `init` — set up git bay for this repository (state in `.git/bay/`: store, journal, bay-owned `repo.git` + hooks)

*Your workspace*
- `co <workitem>` — loan a guarded workspace; prints its path (cd-able)
- `abandon <lease>` — end a workspace lease; uncommitted work is preserved, never deleted
- `refresh <lease>` — refresh a lease's idle clock
- `gc` — expire idle leases (work is snapshotted first, never deleted)

*The merge queue*
- `status [changeset]` — workspace table, or one changeset's verdict (`--json`)
- `enqueue <target>` — queue a branch/SHA for the merge worker
- `requeue <changeset>` — resume a stuck or rejected changeset after fixing the cause
- `adopt <branch>` — bring a pre-existing branch in as a changeset
- `drain [--watch]` — run the merge worker (`--interval <sec>`)

*Repository health*
- `audit` — find strays, stale pins, and refs without work items (`--json`)

Also in v0.1: a merge command's exit code is never taken on faith — a change only counts as merged when it is provably an ancestor of the refreshed main branch — and the compatibility check that the batching roadmap below builds on.

**Roadmap:**

- **v0.2 — batching**: merge several compatible changes as one checked candidate instead of strictly one at a time — one check run covers the whole batch, which is where the real savings on slow test suites live (the compatibility check is already on main); tolerate honestly rebased branches by comparing patch content rather than commit ids.
- **v0.3 — native promotion**: the bay performs the merge in its own staging area instead of merging in your main worktree.
- **v0.4 — background service**: an optional daemon for watch-mode and async operation, with the same guarantees as the bare CLI.

## The docs are tests

Three documents in [tests/](tests/) — [gitbay.spec.md](tests/gitbay.spec.md) (the normal workflow, the same console blocks shown above), [refusals.spec.md](tests/refusals.spec.md) (every refusal and its fix), and [prime.spec.md](tests/prime.spec.md) (the agent-onboarding printout) — are executable specifications: [mdspec](https://mdspec.org/) runs every console block in them and checks the output character for character (`bun run spec`). If the docs drift from the real behavior, the test suite fails.

## License

MIT
