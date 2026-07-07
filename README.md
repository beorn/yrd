# git bay

**git bay** is a local merge server for fleets of coding agents. It loans out guarded worktree workspaces — **bays** — and takes back **changesets**, merging them onto the mainline one at a time: checked, reviewed, tracked, submodule-safe.

```console
$ cd "$(git bay co @km/cli/20123-list-flag)"     # check out bay 3, leased to your work item
$ ...edit...
$ git commit -am "fix: honor --list flag"         # plain git; hooks guard pins + identity
$ git push                                        # push IS submit
remote: bay: changeset C-517 received — checks running
$ git bay status C-517
C-517 merged 3f2ac91d onto main (checks: format ✓ types ✓ tests ✓ pins ✓)
```

One bay verb in, plain git in the middle, zero verbs out.

- **One-verb workspaces** — `git bay co <item>` → a guarded bay leased to a tracked work item
- **Plain-git hot loop** — `git pull` / `git commit` / `git push`; refusals teach on git's own `remote:` channel
- **A real merge queue, locally** — candidates checked speculatively, merged serially; main never receives an untested merge
- **Cross-repo changesets** — superproject + submodule commits + gitlink bumps merge atomically; non-descendant pins refused
- **Hooks floor** — stale pins and itemless branches can't even be committed, daemon up or down
- **Pluggable = run a command** — item tracker, checks, review, notifications: all external executables
- **Event-sourced jsonl journal** — replayable, resumable, greppable
- **Daemon optional** — same guarantees from the bare CLI

## Status

Design phase (private). The canonical spec and tracking bead live in the hh workspace: `@hab/20926-git-yard` (the bead keeps its original id; the product is git bay). Build plan milestones M1–M4 target daily use by the hh agent fleet; FOSS extraction is gated on weeks of real merges.

## License

MIT
