# git bay

**git bay** is a local merge server for fleets of coding agents. It loans out guarded worktree workspaces — **bays** — and takes back **changesets**, merging them onto the mainline one at a time: checked, reviewed, tracked, submodule-safe.

```console
$ cd "$(git bay co fix-readme)"                   # loan a guarded bay for your work item
$ ...edit...
$ git commit -am "docs: fix readme"               # plain git; hooks guard pins + identity
$ git push                                        # push IS submit
remote: bay: changeset C-5a7a2f95 received — checks running
remote: bay: C-5a7a2f95 merged onto main (checks ✓)
$ git bay status C-5a7a2f95
C-5a7a2f95 merged d2eb46f5 onto main (checks: ✓)
```

Real output from a live run just above, with two trims for a short intro: the sha shown is the first 8 characters (`git bay status` actually prints the full 40-char sha), and git's own `To <dest>` / ref-update lines that `git push` prints alongside the `remote:` messages are omitted.

One bay verb in, plain git in the middle, zero verbs out.

- **One-verb workspaces** — `git bay co <item>` → a guarded bay leased to a tracked work item
- **Plain-git hot loop** — `git pull` / `git commit` / `git push`; refusals teach on git's own `remote:` channel
- **A real merge queue, locally** — candidates checked speculatively, merged serially; main never receives an untested merge
- **Cross-repo changesets** — superproject + submodule commits + gitlink bumps promote together or not at all (staged, verified, promoted); non-descendant pins refused, honest rewrites tolerated by patch-id
- **Hooks floor** — stale pins and itemless branches can't even be committed, daemon up or down
- **Pluggable = run a command** — item tracker, checks, review, notifications: all external executables
- **Event-sourced jsonl journal** — replayable, resumable, greppable
- **Daemon optional** — same guarantees from the bare CLI

## Try it

Every line below is a real command against the current build, run in a scratch repo — nothing invented.
`git bay init` sets up `.bay/` (a bay-owned bare repo plus its hooks) inside whatever repo you're in.

```console
$ git init -q myrepo && cd myrepo && git commit -qm init --allow-empty   # a normal repo — nothing bay-specific yet
$ git bay init
bay: initialized (store: sqlite, journal: .bay/journal.jsonl)
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

One trim here too: `git push`'s own `To <dest>` and ref-update lines (git's normal push chatter, nothing bay-specific) are omitted between the two `remote:` lines and the next prompt.

## Status

**M1 is complete.** These verbs are real today (`git bay help` for the live list):

- `init` — set up `.bay/` (store, bay-owned `repo.git`, hooks)
- `co <workitem>` — loan a guarded bay; prints its path (cd-able)
- `status [changeset]` — bay table, or one changeset's verdict (`--json`)
- `enqueue <target>` — queue a branch/SHA for the merge worker
- `requeue <changeset>` — resume a merging/rejected changeset
- `drain [--watch]` — run the merge worker (`--interval <sec>`)
- `abandon <lease>` — end a lease; WIP is preserved, never deleted
- `audit` — strays, pins, refs without workitems (`--json`)

**What's next:**

- **M2** — patch-id rewrite tolerance, TTL-based garbage collection, and adopting pre-existing branches into a lease.
- **M3** — staging-refs promotion so git bay owns the merge natively instead of merging onto the mainline working tree directly.
- **M4** — an optional daemon for async/watch-mode operation on top of the same bare-CLI guarantees.

The canonical spec and tracking bead live in the hh workspace: `@hab/20926-git-yard` (the bead keeps its original id; the product is git bay). FOSS extraction is gated on weeks of real merges.

## The spec is executable

[spec/happy-path.md](spec/happy-path.md) is both the canonical showcase and the M1 acceptance test — the same console blocks shown above, wired to real assertions and run with `bun run spec`.
Docs are tests here: if the doc drifts from the behavior, the spec fails.

## License

MIT
