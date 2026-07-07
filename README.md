# git bay

**git bay** is a merge queue for your own machine. It gives each piece of work an isolated git workspace, accepts finished work through plain `git push`, and merges changes onto your main branch one at a time — each one checked before it lands.

## The problem

When several people — or, increasingly, several coding agents — work in one repository at the same time, the main branch becomes a hazard zone:

- Two changes that each pass tests on their own can break the build when merged together, and pushing straight to main means nobody checked the *combination*.
- Agents step on each other: one force-pushes over another's work, or merges a branch that was never tested against the main branch as it looks *now*.
- In repositories with submodules it gets worse: a merge can silently move a submodule pointer *backwards*, undoing someone's landed work without anyone noticing.
- When something does go wrong, there is often no record of what was merged, when, by whom, and what the checks said.

Hosted services solve this for pull requests — GitHub's merge queue, GitLab's merge trains. But those live in the cloud, attached to a PR workflow. A fleet of local coding agents working directly against a local repository has none of that discipline — and needs it more, because agents merge far more often than people do.

## The solution

git bay runs the merge-queue idea locally, next to your repository:

1. **Start work with one command.** `git bay co <name>` loans you a **bay** — a guarded git worktree tied to a named piece of work. You get a ready workspace; `cd` in and start.
2. **Work with ordinary git.** Edit, commit, pull, push — nothing new to learn in the middle.
3. **Pushing is submitting.** When you `git push`, the bay takes over: it runs your checks, and only if they pass does it merge your change — one **changeset** at a time — onto main. The verdict appears right in your push output. If something is wrong, the push is refused with a message that names the problem *and the exact command that fixes it*.

There is no separate submit/land/finish command to remember, and no way to skip the checks by accident.

```console
$ cd "$(git bay co fix-readme)"                   # loan a workspace for your work item
$ ...edit...
$ git commit -am "docs: fix readme"               # plain git from here on
$ git push                                        # push IS submit
remote: bay: changeset C-5a7a2f95 received — checks running
remote: bay: C-5a7a2f95 merged onto main (checks ✓)
$ git bay status C-5a7a2f95
C-5a7a2f95 merged d2eb46f5 onto main (checks: ✓)
```

That is real output from a live run, lightly edited for length: the SHA is shortened to 8 characters (`git bay status` prints all 40), and git's own push chatter (the `To <dest>` and ref-update lines) is left out.

## What you get

- **A real merge queue, locally** — changes are checked and merged one at a time, so main never receives an untested merge. Batching compatible changes together is on the roadmap below.
- **Ordinary git in the middle** — after `git bay co`, everything is `git pull` / `git commit` / `git push`. Refusals and verdicts arrive as `remote:` lines in the push output, where git users already look.
- **Safe with submodules** — a parent-repo commit and its submodule commits land together or not at all, and a submodule pointer that would move backwards is refused.
- **Guarded at commit time, too** — the workspace's git hooks refuse a stale submodule pointer or a branch with no work item at `git commit`, so broken states are caught before they are even pushed.
- **Errors that teach** — every refusal says what failed and the exact command to fix it. The error messages are part of the product.
- **Plug in your own tools by running commands** — the issue tracker, the checks, review, notifications: each is just an external command the bay calls. No SDK required.
- **A complete record** — every event is appended to one JSONL journal: what was merged, when, by whom, and what the checks said. Replayable, resumable, greppable.
- **No daemon required** — the plain CLI gives the same guarantees; a background service is optional (roadmap).

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

Every line above is a real command against the current build, run in a scratch repo. `git bay init` stores the bay's state inside `.git/bay/` — a queue database, the event journal, and a small bay-owned git repo whose hooks make push-is-submit work. Putting the state inside `.git/` means repository cleanup tools (like `git clean`) can never delete the merge history. Same small edit as before: git's own push chatter is left out between the two `remote:` lines.

## Status

**v0.1 — shipped.** Every verb below works today (`git bay help` for the live list):

- `init` — set up the bay (state in `.git/bay/`: store, journal, bay-owned `repo.git` + hooks)
- `co <workitem>` — loan a guarded workspace; prints its path (cd-able)
- `status [changeset]` — workspace table, or one changeset's verdict (`--json`)
- `enqueue <target>` — queue a branch/SHA for the merge worker
- `requeue <changeset>` — resume a stuck or rejected changeset after fixing the cause
- `drain [--watch]` — run the merge worker (`--interval <sec>`)
- `abandon <lease>` — end a lease; uncommitted work is preserved, never deleted
- `adopt <branch>` — bring a pre-existing branch in as a changeset
- `ping <lease>` — refresh a lease's idle clock
- `gc` — expire idle leases (work is snapshotted first, never deleted)
- `audit` — find strays, stale pins, and refs without work items (`--json`)

Also in v0.1: a merge command's exit code is never taken on faith — a change only counts as merged when it is provably an ancestor of the refreshed main branch — and the compatibility check that the batching roadmap below builds on.

**Roadmap:**

- **v0.2 — batching**: merge several compatible changes as one checked candidate instead of strictly one at a time (the compatibility check is already on main); tolerate honestly rebased branches by comparing patch content rather than commit ids.
- **v0.3 — native promotion**: the bay performs the merge in its own staging area instead of merging in your main worktree.
- **v0.4 — background service**: an optional daemon for watch-mode and async operation, with the same guarantees as the bare CLI.

Development is tracked in the hh workspace (bead `@hab/20926-gitbay`).

## The docs are tests

Two documents in [tests/](tests/) — [gitbay.spec.md](tests/gitbay.spec.md) (the normal workflow, the same console blocks shown above) and [refusals.spec.md](tests/refusals.spec.md) (every refusal and its fix) — are executable specifications: [mdspec](https://mdspec.org/) runs every console block in them and checks the output character for character (`bun run spec`). If the docs drift from the real behavior, the test suite fails.

## License

MIT
