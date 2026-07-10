# Yrd TODO

Only executable acceptance work belongs here. Product narrative and contracts
live in [README.md](README.md); research and tentative ideas stay outside this
public repository.

## Permanent v1

### Core

- [ ] Use the public `@silvery/command` tree as operation metadata while
  preserving Yrd's serialized `{ op, args }`, `apply()`, and `state()` contract.
- [ ] Keep one durable effect/job transition machine for local, remote,
  waiting, lost, and retried work.
- [ ] Prove replay equivalence and cross-process single-writer authority.

### Bay and PR Intake

- [ ] Verify open, refresh, direct-branch submit, pushed-revision intake,
  withdraw, and close against real Git repositories.
- [ ] Verify `prs.git` receive hooks recover a crash between receive and event
  intake without duplicating a PR revision.
- [ ] Keep `git bay` and `yrd bay` as argv projections of the same commands.

### Line

- [ ] Derive step lifecycle and evidence from the shared effect authority; line
  state retains only integration facts and effect ids.
- [ ] Verify arbitrary configured names before and after `withMerge()`.
- [ ] Verify exact candidate landing, stale-base refusal, waiting/finish,
  multiple base branches, deploy evidence, and recursive batch bisection.
- [ ] Dogfood `yrd line status` against the live hh queue and verify links,
  `AGE`, `TOUCHED`, `RUN`, narrow-terminal layout, and `--json` parity.

### Contest

- [ ] Derive attempt, evaluation, and promotion lifecycle from shared effects;
  contest state retains task, competitors, pins, selection, and effect ids.
- [ ] Run a real `ag` Codex versus Claude contest on one task.
- [ ] Verify wall time, tokens, reported USD cost, artifacts, held-out results,
  manual selection, immutable ref verification, and exact winner promotion.

### CLI and Packaging

- [ ] Finish Silvery output for bay, line, and contest result views; keep JSON
  raw and deterministic.
- [ ] Make standalone `bun yrd`, `yrd`, `git-yrd`, and `git-bay` work from a
  clean clone with only declared dependencies.
- [ ] Run focused tests, typecheck, scoped formatting/lint, pack/install smoke,
  and the complete acceptance flows.
- [ ] Cut `@ci` over to Yrd once the non-contest bay and line flow is green.

After these boxes are complete, this file should contain only observed bugs,
small usability adjustments, and release chores - no deferred second design.
