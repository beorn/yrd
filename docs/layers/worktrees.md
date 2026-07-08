# withWorktrees — core layer

Manages the directories work happens in. Core-tier: always in the default composition, but still a layer — without it, `adopt <branch>` + `submit` + `integrate` is a pure merge queue for people who bring their own workspaces.

## The identity model

**Worktrees are numbered and persistent** (`wt1`, `wt2`, …): plain git worktrees under `.bays/`, reused across tenants because provisioning is expensive. **Bays are named and ephemeral**: a bay is the loan of one worktree to one named piece of work — named, listed, journaled, expiring when idle, wired so `git push` opens a PR. `ls` shows both; `close`/`refresh` accept either.

## Shipped today

- `open <name>` opens a bay (prints a cd-able path; `new`/`co`/`checkout` are hidden aliases), `close` ends it (refuses if dirty, or if its PR is still live — see below), `refresh` resets the idle clock, `gc` expires idle bays after snapshotting the branch tip to a findability ref.
- `close --withdraw`: closing a bay whose PR hasn't reached a terminal state (pushed, submitted, checking, checked, merging, reviewing, or rejected) refuses and teaches the three ways out — integrate it, retry it, or withdraw it. `--withdraw` moves the PR to `closed` and then closes the bay — but only a resting PR (pushed, submitted, checked, rejected, or reviewing) can be withdrawn; one still actively checking or merging must finish first.
- The bay's remote points at the bay-owned repo, so plain `git push` opens the PR — creating a PR and asking to merge it are separate acts (see [docs/events.md](../events.md)).

## Planned (v0.4)

- **Pooling as an option of this layer** (not a separate plugin): closed worktrees return to a pool and the next `open` recycles one instead of re-running setup. Recycling is the default once shipped — reuse is what makes the system scale when provisioning (dependencies, submodules) takes minutes. Pool directories are gitbay-owned: work is snapshotted at close, then the directory is reset hard between tenants.

```yaml
worktrees:
  pool: { prewarm: 2 }   # provision ahead of demand; `pool: off` = fresh every time
```

## Events

`worktree/provisioned` and `worktree/deprovisioned {via}` bracket each directory's life; `bay/opened {worktree, recycled}`, `bay/refreshed`, `bay/closed {via}` bracket each loan. A journal fold can always answer "which directories exist" and "who was on wt3 when."
