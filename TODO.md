# Yrd TODO

Only executable acceptance work belongs here. Product narrative and contracts
live in [README.md](README.md); research and tentative ideas stay outside this
public repository.

## Permanent v1

### Core

- [x] Use Silvery's command tree as operation metadata while preserving Yrd's
      serialized `{ op, args }`, `apply()`, and signal-backed state contract.
- [x] Keep one durable Job transition machine for local, remote,
      waiting, lost, and retried work.
- [x] Prove replay equivalence, command-atomic checksummed frames, exact command
      retry deduplication, and cross-process single-writer authority.
- [x] Pin Job definition revisions and complete Queue step descriptors so
      pending work refuses config drift while historical runs remain readable.

### Bay and PR Intake

- [x] Verify open, refresh, direct-branch submit, pushed-revision intake,
      withdraw, and close against real Git repositories.
- [x] Verify `prs.git` receive hooks recover a crash between receive and event
      intake without duplicating a PR revision.
- [x] Keep `git bay` and `yrd bay` as argv projections of the same commands.

### Queue

- [x] Derive step lifecycle and evidence from the shared Job authority; Queue
      records retain only immutable run facts.
- [x] Verify arbitrary configured names before and after `withMerge()`.
- [x] Verify exact candidate landing, stale-base refusal, waiting/finish,
      multiple base branches, deploy evidence, and recursive batch bisection.
- [x] Order the implicit serial queue by PR revision submission time and support
      a delegated merge command with authoritative landing reconciliation.
- [ ] Dogfood the bare `yrd` dashboard against the live hh queues and verify links,
      `AGE`, `TOUCHED`, `RUN`, narrow-terminal layout, and `--json` parity.

### Contest

- [x] Derive attempt, evaluation, and promotion lifecycle from shared Jobs;
      Contest records retain only issue, competitor, Bay, selection, and pin facts.
- [ ] Run a real `ag` Codex versus Claude Opus contest on one issue.
- [ ] Verify wall time, tokens, reported USD cost, artifacts, held-out results,
      manual selection, immutable ref verification, and exact winner promotion.

### CLI and Packaging

- [ ] Finish Silvery output for bay, queue, and contest result views; keep JSON
      raw and deterministic.
- [ ] Make standalone `bun yrd`, `yrd`, `git-yrd`, and `git-bay` work from a
      clean clone with only declared dependencies.
- [ ] Run focused tests, typecheck, scoped formatting/lint, pack/install smoke,
      and the complete acceptance flows.
- [ ] Complete the hh sole-path pilot: at least ten consecutive real landings
      or 48 hours, whichever is longer; zero unexplained movers against Gate-E
      audit; and one preserved-root failure/resume.

### Superprojects and README parity

The README is written as spec; these boxes close the gap between it and the
shipped surface:

- [ ] `git super pr | worktree | ci | merge` argv projections of the same core
      (`git bay` is the shipped slice of the family).
- [ ] Tracked submodules (roll): `branch = <name>` in `.gitmodules` refreshes
      the tracked super PR as upstream advances; landing stays queue-gated.
- [ ] Grouped super-PR review: one feature's branches across repos as a single
      reviewable unit.
- [ ] Documented third-party adapter seam for trackers, forges, and judges.
- [ ] Contest end-to-end on a real issue with a pluggable (possibly agent)
      judge — extends the open Contest boxes above.
- [ ] Witness sweep: each README capability claim has one command that
      demonstrates it.
- [ ] One outcome word: consolidate landed/integrated into merged across CLI
      output and JSON (`landingSha` -> `mergeSha`; PR terminal status rename).

After these boxes are complete, this file should contain only observed bugs,
small usability adjustments, and release chores - no deferred second design.
