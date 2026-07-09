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
- Local line step runs record exit code, duration, and stdout/stderr artifact
  references on `line/step/finished`.
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
yrd bay submit [<submission-name>]
yrd bay close

yrd line status [PR|name] [--json]
yrd line audit [--json]
yrd line integrate [PR|name] [--steps check,merge] [--retry] [--watch] [--interval <sec>]
yrd line watch [PR|name] [--interval <sec>]

yrd task compete <task> --agents codex,claude --base main --bays 2
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
- yrd line provision, yrd line deprovision, and deploy steps are staged until
  line state, remote runners, and deployment records are real.

## Next Work

1. Contest hardening
   - Move contest records from the first JSON-file projection toward the
     event/state/plugin model used by the rest of Yrd.
   - Add runner-specific cost adapters where a provider does not emit dollar
     cost directly; keep missing cost explicit, never guessed.
   - Add richer evaluator plugins for tests, review, diff quality, performance,
     and human scorecards.
   - Keep winner selection manual-first; automatic ranking should be a plugin
     over recorded evidence, not hidden policy.
2. Line hardening
   - Finish core submission and line-step event/state contracts.
   - Extend line/step start/end events with base/head SHAs and normalized
     error metadata.
   - Broaden artifact/log capture beyond the local command runner as remote
     and hosted runners land.
   - Make --retry and process restart journal-driven by skipping successful
     step results for the same submission and commit.
   - Expose stronger folded line status/staleness.
   - Add the runner seam for remote, container, or hosted test execution.
3. @ci cutover
   - Switch @ci to yrd bay + yrd line once artifact capture, folded status, and
     resume semantics are strong enough for the CI lane.
   - Keep the existing Git Bay command surface as compatibility while the line
     projection proves itself.
4. Storage names and migration
   - Rename journal.jsonl -> events.jsonl, bay.db -> index.sqlite, and
     repo.git/ -> prs.git/ in one migration wave with one-generation compatible
     reads.
   - Add sqlite materialized views for PRs, bay leases, queue order, and
     verdicts, folded from events.jsonl; keep the event log as source of truth.
5. Model refinements
   - Add per-PR source/base storage and --from/--head plus --base/--line
     aliases, while keeping the initial queue serial per base.
   - Thread base-aware provisioning through contests once `open --base` is
     installed; the first contest projection records the selected base and
     computes git metrics from it, but bay creation still follows the current
     bay default.
   - Add cwd-as-identifier, variadic targets, and branch resolution for submit.
   - Hide/remove old branch-intake public vocabulary; branch-backed workspace
     provisioning is open --from, branch intake without a bay is submit
     <branch>.
   - Add submit --wait as the verb-side mirror of git push -o wait.
   - Clean config vocabulary: keep bay.issue and bay.merge as public keys, and
     remove retired queue/config spellings.
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
  journal for the same submission and commit. Local command artifacts are
  installed; folded status and resume semantics remain.
- Contest mode records attempts, artifacts, costs, traces, line results, and the
  chosen winner for a real task.
