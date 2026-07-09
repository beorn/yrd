# Yrd TODO

Yrd is the software delivery yard: tasks, bays, integration lines, and
real-task evaluation of agents or harnesses. The current repository ships the
bay component; Git Bay is the Git-native command projection for that component.

Canonical product docs: [docs/yrd.md](docs/yrd.md). Private reference and
research stay outside this repo in `hub/yrd/reference`.

## Current State

- Repo identity is `beorn/yrd`; old `beorn/gitbay` URLs redirect.
- `yrd bay <verb>` and `git bay <verb>` resolve through the same implementation.
- `yrd line status|audit|integrate|watch` projects the current Git Bay
  integration state and check/merge machinery.
- Compatibility commands remain: `git-bay`, `gitbay`, and `bun bay`.
- Package metadata points at `github:beorn/yrd`, but the package name is still
  `git-bay`.
- hh consumes this repo at `vendor/yrd`.

## Product Shape

```text
task -> bay attempt(s) -> submission(s) -> line -> integrated result
                 \-> contest evaluation -> winning submission -> line
```

- **Task**: unit of intent from km beads, GitHub issues, local todos, or
  another tracker. `issue` is adapter vocabulary, not the Yrd domain noun.
- **Bay**: isolated workspace for one implementation attempt.
- **Submission**: work handed from a bay to intake; in GitHub contexts this can
  still be a PR.
- **Line**: checks, review, merge, deploy, audit, and status for submissions.
- **Contest**: multiple bays attempt the same real task; a winner is selected
  and promoted.

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

- `yrd bay` and `git bay` must stay compatibility-equivalent.
- Use `--steps` to narrow step-running commands; omitted means the configured
  default sequence.
- `--retry` is an option on step-running commands, not a separate command tree.
- Keep `git bay` as the Git-native projection; do not add `@yrd/git-bay` unless
  there is a second non-Git bay implementation.
- `yrd line provision`, `yrd line deprovision`, and `deploy` steps are staged,
  not installed, until line state/artifacts/runners are real.

## Package Split

Target packages:

- `@yrd/core`: records, event contracts, plugin composition, typed state shapes.
- `@yrd/bay`: bay lifecycle and the Git-native implementation currently shipped
  here.
- `@yrd/line`: integration lines, queues, steps, merge/deploy execution.
- `@yrd/task`: task intake from km beads, GitHub issues, and other trackers.
- `@yrd/contest`: multiple attempts for one task and winner selection.
- `@yrd/cli`: command projection from installed plugins.
- Edge adapters: `adapter-km`, `adapter-ag`, `adapter-hab`, `adapter-github`.

## Next Work

1. **Line hardening**
   - Finish core submission and line-step event/state contracts.
   - Extend `line/step/*` start/end events with base/head shas, duration, exit
     code, error, and artifact references.
   - Add local artifact/log capture for step output.
   - Make `--retry` and process restart journal-driven by skipping successful
     step results for the same submission and commit.
   - Expose stronger folded line status/staleness.
   - Add the runner seam for remote, container, or hosted test execution.
2. **`@ci` cutover**
   - Switch `@ci` to the new Yrd bay+line shape once artifact capture, folded
     status, and resume semantics are strong enough for the CI lane.
   - Keep the existing Git Bay command surface as compatibility while the line
     projection proves itself.
3. **Docs/spec boundary**
   - Make README.md and any repo-local `spec.md` files reflect the Yrd package
     structure.
   - Specs kept in this repo must be executable or final behavior-facing;
     exploratory/background specs belong in `hub/yrd/reference` or in `@yrd`
     beads.
4. **Package split + config**
   - Cut package naming from `git-bay` toward Yrd-scoped packages while
     preserving compatibility bins and Git subcommands.
   - Split the repo into `@yrd/core`, `@yrd/bay`, `@yrd/line`, `@yrd/task`,
     `@yrd/contest`, and `@yrd/cli` without changing behavior.
   - Promote current Git Bay internals into `@yrd/bay` and shared contracts
     into `@yrd/core`.
   - Move Yrd config toward `tasks` for tracker-agnostic intake; keep GitHub
     issues as an adapter.
5. **Task and contest projections**
   - Move or alias legacy planning beads from `@hab/20926-gitbay` into
     `@yrd/bay/...` when the review/history window is quiet enough.
   - Implement `yrd task compete` after the CI line cutover, with manual winner
     selection before automatic selection.

## Acceptance

- Existing Git Bay workflows keep working.
- `yrd bay` and `git bay` are aliases/projections over one implementation.
- Public repo docs remain final/product-facing; tentative reference and research
  stay in `hub/yrd/reference`.
- README.md and repo-local specs describe the Yrd structure, not only the legacy
  Git Bay surface.
- Yrd-generic docs use `task` for intake; `issue` appears only in adapter or
  tracker-specific contexts.
- Line steps record structured state and events that can project to config, CLI
  args, logs, and spans.
- Line runs capture artifacts/logs, expose folded status, and resume from the
  journal for the same submission and commit.
- Contest mode records attempts, artifacts, costs, traces, line results, and the
  chosen winner for a real task.
