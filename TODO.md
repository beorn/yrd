# Yrd TODO

Project-local notes for Yrd and git bay only. Public narrative belongs in
README.md and docs/yrd.md; exploratory/background research stays outside this
repo in hub/yrd/reference or in @yrd beads.

## Current State

- Repo identity is beorn/yrd; old beorn/gitbay URLs redirect.
- Package identity is @yrd/bay.
- yrd bay, git bay, git-bay, gitbay, and git yrd resolve to one bay
  implementation.
- yrd line status/audit/integrate/watch projects the current check/merge path.
- yrd task compete and yrd contest show/select/promote are installed as the
  first manual-selection contest projection over real bay attempts.
- Contest `--agents "ag codex/claude"` uses ag-style slash-separated provider
  lists; built-in `codex` and `claude` attempts execute through `ag`. The
  shorter provider-only form remains accepted for scripts.
- Contest lifecycle writes `contest/...` rows to events.jsonl for opened,
  attempt started/finished, selected, and promoted facts while the JSON contest
  record remains a rebuildable read-model cache/fallback. `yrd contest
  show/select/promote` fold from those events when present.
- Local line step runs record exit code, duration, and stdout/stderr artifact
  references on `line/step/finished`.
- `bay.check.runner=waiting` treats `bay.check` as an external check launcher:
  exit `0` records `line/step/waiting` with token/URL/detail/artifacts and
  parks the PR in `checking`; launcher failure rejects the PR.
- `yrd line finish <PR> --step check --ok|--fail` completes a parked external
  check, validates the waiting token when present, accepts external artifact
  refs with `--artifact name=path-or-url`, records `line/step/finished`, and
  moves the PR to `checked` or `rejected`.
- Failed line step runs include normalized `error { code, message, exitCode? }`
  metadata using the same rejection-code vocabulary as PR verdicts.
- Resume paths skip previously successful check and deploy steps when PR,
  target, base SHA, head SHA, and step config hash still match; skipped rows
  carry `skipped: true`. Merge remains non-skippable.
- Line status JSON includes a folded line summary with open items, last step
  results, base/head SHAs, and checked-PR staleness reasons.
- Human `yrd line status` renders that same folded line summary concisely:
  base, open PRs, step verdicts, artifact counts, and stale reasons.
- Stale checked PRs are rejected with `stale-check` before the merge command
  runs, so retry re-enters the line from check.
- Targeted `yrd line status <selector...>` keeps showing check/merge/deploy
  step evidence for requested PRs, including terminal merged PRs used for
  deployment audit.
- `yrd line integrate --steps deploy` runs the configured post-merge
  `bay.deploy` step, records `line/step` events and artifacts, exits nonzero
  on deploy failure, and never changes a merged PR back out of `merged`.
- `yrd line integrate --steps check,merge,deploy --watch` and
  `yrd line watch --steps check,merge,deploy` keep draining the line and deploy
  each PR they merge.
- `yrd line provision [base]` runs the configured `bay.provision` hook in a
  disposable scratch at the line base and releases it; `yrd line deprovision`
  currently reports that no persistent line resources exist yet.
- Fresh bay state uses events.jsonl, index.sqlite, and prs.git; one-generation
  compatibility reads legacy journal.jsonl, bay.db, and repo.git when present.
- `git bay submit <branch>` opens and submits an existing source branch without
  first provisioning a bay; `submit --wait` forces integration even when
  `bay.autoMerge` is false.
- `git bay open <name> --from <branch>` opens a bay worktree on an existing
  local source branch and keeps the bay name as the PR/work item name;
  `--head` is an alias for GitHub PR vocabulary.
- Public config vocabulary uses `bay.issue`, `bay.merge`, `bay.autoSubmit`,
  and `bay.autoMerge`; retired `bay.tracker`, `bay.mergeCommand`, and
  `bay.autoQueue` are not read.
- hh consumes this repo at vendor/yrd.

## Product Shape

```text
task -> bay attempt(s) -> submission(s) -> line -> integrated result
                 \-> contest evaluation -> winning submission -> line
```

- Task: unit of intent from km beads, GitHub issues, local todos, or another
  tracker. Issue is adapter vocabulary, not the Yrd domain noun.
- Bay: isolated workspace for one implementation attempt.
- Submission: work handed from a bay to intake; in GitHub contexts this can
  still project as a PR.
- Line: checks, review, merge, deploy, audit, and status for submissions.
- Contest: multiple bays attempt the same real task; a winner is selected and
  promoted.

## Command Target

```bash
yrd bay open <name>
yrd bay refresh
yrd bay submit [selector...] [--wait]
yrd bay close

yrd line status [selector...] [--json]
yrd line audit [--json]
yrd line provision [base] [--json]
yrd line deprovision [base] [--json]
yrd line integrate [PR|name] [--steps check,merge,deploy] [--retry] [--watch] [--interval <sec>]
yrd line finish <PR|name> [--step check] (--ok|--fail) [--token <token>] [--detail <text>] [--artifact <name=ref>]
yrd line watch [PR|name] [--steps check,merge,deploy] [--interval <sec>]

yrd task compete <task> --agents "ag codex/claude" --base main --bays 2
yrd contest show <contest>
yrd contest select <contest> --winner <attempt>
yrd contest promote <contest>
```

Rules:

- yrd bay and git bay must stay compatibility-equivalent.
- Use --steps to narrow step-running commands; omitted means the configured
  default sequence.
- --retry is an option on step-running commands, not a separate command tree.
- Keep git bay as the Git-native projection; do not add @yrd/git-bay unless
  there is a second non-Git bay implementation.
- yrd line provision is a disposable preflight today; remote runners may later
  attach persistent resources that make deprovision do real teardown.

## Next Work

1. Contest hardening
   - Move contest state into a proper with* plugin layer over the installed
     `contest/...` events; keep contest.json as a rebuildable/read-model cache.
   - Add runner-specific cost adapters where a provider does not emit dollar
     cost directly; keep missing cost explicit, never guessed.
   - Add richer evaluator plugins for tests, review, diff quality, performance,
     and human scorecards.
   - Keep winner selection manual-first; automatic ranking should be a plugin
     over recorded evidence, not hidden policy.
2. Line hardening
   - Finish core submission and line-step event/state contracts beyond local
     check/merge/deploy and externally finished checks.
   - Add remote/container/hosted runner adapters that produce the installed
     waiting/finish/artifact/provision contract.
   - Extend event-log-driven resume beyond check/deploy as more non-merge step
     kinds land; keep merge non-skippable unless the line can prove a landed
     result.
3. @ci cutover
   - Switch @ci to yrd bay + yrd line once artifact capture, folded status, and
     resume semantics are strong enough for the CI lane.
   - Keep the existing Git Bay command surface as compatibility while the line
     projection proves itself.
4. Storage and indexing
   - Add sqlite materialized views for PRs, bay leases, queue order, and
     verdicts, folded from events.jsonl; keep the event log as source of truth.
5. Model refinements
   - Add per-PR base storage and --base/--line aliases, while keeping the
     initial queue serial per base.
   - Keep `open --from`/`--head` as the source-branch spelling for bay repair
     work.
   - Thread base-aware provisioning through contests once `open --base` is
     installed; the first contest projection records the selected base and
     computes git metrics from it, but bay creation still follows the current
     bay default.
   - Add cwd-as-identifier and variadic targets.
   - Continue retiring old branch-intake vocabulary from public docs while
     keeping compatibility aliases callable.
6. Package split + config
   - Split toward @yrd/core, @yrd/bay, @yrd/line, @yrd/task, @yrd/contest, and
     @yrd/cli without changing behavior.
   - Promote current Git Bay internals into @yrd/bay and shared contracts into
     @yrd/core.
   - Move Yrd config toward tasks for tracker-agnostic intake; keep GitHub
     issues as an adapter.

## Acceptance

- Existing Git Bay workflows keep working.
- yrd bay and git bay are aliases/projections over one implementation.
- Public repo docs remain final/product-facing; tentative reference and
  research stay out of the repo.
- README.md and repo-local docs describe the Yrd structure, not only the legacy
  Git Bay surface.
- Yrd-generic docs use task for intake; issue appears only in adapter or
  tracker-specific contexts.
- Line steps record structured state and events that can project to config, CLI
  args, logs, and spans.
- Line runs capture artifacts/logs, expose folded status, and resume from the
  event log for the same submission and commit. Local command artifacts are
  installed, JSON folded status is installed, and normalized step errors are
  installed. Human folded status is installed. Parked external check launch and
  finish are installed, including external artifact refs from launcher metadata
  and `line finish --artifact`. Successful check and deploy reuse are installed
  for matching PR/base/head/config; stale checked PRs are rejected before merge.
  Disposable line provision preflight is installed. Broader non-merge step
  resume semantics remain.
- Contest mode records attempts, artifacts, costs, traces, line results, and the
  chosen winner for a real task.
