# TODO

Project-local notes for gitbay only.

## Architecture / Correctness

- [ ] Rename storage files in one migration wave with a version bump and
  one-generation compatible reads: `journal.jsonl` -> `events.jsonl`,
  `bay.db` -> `index.sqlite`, and `repo.git/` -> `prs.git/`. Coordinate with
  @agent/8 migration tooling and any journal tail consumers before landing.
- [ ] Add sqlite materialized views for PRs, bay leases, queue order, and
  verdicts, folded from `events.jsonl`; keep the event log as source of truth.
- [ ] Refactor repository operations behind an injected SCM provider:
  `createGitbay({ state, scm })`. Keep the interface intent-level
  (`openWorkspace`, `receiveSubmission`, `changedPaths`, `integrate`,
  `isLanded`, `refresh`, optional authoring guards/components).
- [ ] Keep nameless branch-intake PRs audit-visible when `submit <branch>`
  opens a PR without provisioning a bay.

## Next Model Refinements

- [ ] Add per-PR source/base storage and `--from`/`--head` plus `--base`/`--line`
  aliases, while keeping the initial queue serial per base. The line sits on a
  base branch; there is no separate queue id/object.
- [ ] Add cwd-as-identifier, variadic targets, and branch resolution for
  `submit <branch>`.
- [ ] Hide/remove the old branch-intake public verb. Branch-backed workspace
  provisioning is `open --from`; branch intake without a bay is
  `submit <branch>`.
- [ ] Add `submit --wait` as the verb-side mirror of `git push -o wait`; it
  returns on terminal verdict or parked waiting state with distinct output.
- [ ] Migrate the public CLI/help to the README command groups: general
  (`guide`, `ls`, `status`, `init`, `audit`, `prune`), bay ops (`open`,
  `refresh`, `submit`, `close`), and line ops (`line status/integrate`). Keep
  cleanup under `prune`, keep worktree provision/deprovision as events only,
  keep `ls` canonical with `status` as an alias, and hide flat line verbs
  (`check`, `merge`, `integrate`, `retry`) behind grouped forms.
- [ ] Clean config vocabulary: keep `bay.issue` and `bay.merge` as the public
  keys, and remove retired queue/config spellings.
- [ ] Add `withStep(name, spec)` as the source of truth for line capabilities:
  registered sync and async steps add entries to folded state, and `.gitbay.yml`
  plus `--steps` are projections over those registered names. Async steps must
  support parking transitions and later resume events.
- [ ] Replace fixed `check.run` / `merge.run` / `integrate.run` internals with
  generic line step execution and `line/step/started`,
  `line/step/waiting`, and `line/step/finished` events; keep PR lifecycle
  states small and derive them from step verdicts.
- [ ] Bind check/review verdicts to the PR tip SHA; any new push returns the PR
  to `pushed` and invalidates stored check, review, and rejection verdicts.
- [ ] Make retry from `rejected` re-enter `submitted` and run the full pipeline;
  never reuse stale stored verdicts as a shortcut.
- [ ] Add lifecycle checks: `provision`, `open`, `push`, `submit`,
  `integrate`, `merged`.
- [ ] Make worktree pooling default-on.
- [ ] Add WIP limits.
- [ ] Add issue lifecycle hooks under `withIssues`.
- [ ] Add review as an async step registered by `withReviews`, including parked
  `reviewing` state, resume/approve/reject events, and provider correlation
  tokens.
- [ ] Add remote test runner adapters as async steps with stored waiting state,
  provider result sync, and final landing recheck.
- [ ] Add JSON-RPC and event streaming.
- [ ] Batch compatible runnable PRs into one candidate. Configure `batch` as
  `false`, `0`, or `1` to disable batching, or a number for max batch size.
  Keep isolation policy inside the plugin; start with serial fallback before
  split/bisect retry.
- [ ] Add an optional daemon for background integration.
- [ ] Add deploy as a registered step over landed state with environment-aware
  command output and exit-code handling; deploy verdicts must not revoke
  `merged`.
- [ ] Add GitHub Actions-inspired plugin config for checks, issues, reviews,
  deploy, batching, and line policy.
- [ ] Make command contracts match README: documented inputs, human/JSON output,
  state changes, and exit-code classes.

## Documentation / Specs

- [ ] Keep implementation-drift notes out of README; track concrete migration
  tasks here.
- [ ] Coordinate gitbay branch landing with @agent/8 before deleting refs:
  `task/20999-reconcile` at `e5b09d2`, `task/21002-one-merge-seam` at
  `804d6b6`, and `task/20957-train-cli` must remain through landing.
