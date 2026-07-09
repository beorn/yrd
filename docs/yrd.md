# Yrd

**Yrd** is the software delivery yard: tasks, bays, integration lines, and
real-task evaluation of agents or harnesses. This repository currently ships
the **bay** component. Git Bay is the Git-native command projection for that
bay component, not a separate product.

## Available today

- `yrd bay <verb>` runs the same implementation as `git bay <verb>`.
- `git yrd <verb>` is a Git subcommand alias for the same bay projection.
- `git bay <verb>`, `git-bay`, and `gitbay` remain compatibility command
  surfaces over the same implementation.
- From this repository, `bun yrd ...`, `bun git-yrd ...`, `bun git-bay ...`,
  `bun gitbay ...`, and `bun bay ...` run the local development entrypoints.

`yrd bay` and `git bay` must stay the same implementation. If they diverge,
that is a bug in the transition.

## Product model

```text
task -> bay attempt(s) -> submission(s) -> line -> integrated result
                 \-> contest evaluation -> winning submission -> line
```

- **Task**: a unit of intent, usually sourced from a tracker such as km beads
  or GitHub issues.
- **Bay**: an isolated workspace for one implementation attempt.
- **Submission**: work handed from a bay to an intake target. In Git/GitHub
  contexts this can still be called a PR.
- **Line**: the integration path for submissions: checks, review, merge, deploy,
  audit, and status.
- **Contest**: multiple bays attempt the same real task; one winning submission
  is selected and promoted.

## Command projections

The installed projection is `bay`. The Yrd-facing command shape is:

```bash
yrd bay open <name>
yrd bay refresh
yrd bay submit [<submission-name>]
yrd bay close
```

The current Git Bay CLI exposes the shipped v0.3 verbs documented in the README
(`open`, `close`, `gc`, `submit`, `check`, `merge`, `integrate`, `retry`,
`audit`, etc.). The Yrd-facing shape above is the stable product projection over
that implementation; shipped compatibility verbs stay available while the CLI
converges.

Planned projections:

```bash
yrd line provision [<base>]
yrd line deprovision [<base>]
yrd line status [<base>]
yrd line audit [<base>]
yrd line integrate [<base>] --steps check,merge,deploy
yrd line watch [<base>]

yrd task compete <task> --agents codex,claude --base main --bays 2
yrd contest show <contest>
yrd contest select <contest> --winner <attempt>
yrd contest promote <contest>
```

For commands that accept zero or more steps, an omitted step list means "run the
configured default sequence." `--steps` is the canonical narrowing flag.
`--retry` is an option on step-running commands, not a separate vocabulary
branch.

## Package shape

The monorepo target is:

- `@yrd/core`: records, event contracts, plugin composition, typed state shapes.
- `@yrd/bay`: bay lifecycle and the Git-native implementation currently shipped
  by this repo.
- `@yrd/line`: integration lines, queues, steps, merge/deploy execution.
- `@yrd/task`: task intake from km beads, GitHub issues, or other trackers.
- `@yrd/contest`: multiple attempts for one task and winner selection.
- `@yrd/cli`: projections of installed plugins into commands and help.
- adapters at the edge: `adapter-km`, `adapter-ag`, `adapter-hab`,
  `adapter-github`.

Git-specific command surfaces (`git bay`, `git yrd`) are aliases/projections of
`@yrd/bay`. Do not introduce a separate Yrd work area named `@yrd/git-bay`
unless there is a real second bay implementation that needs that distinction.

## Line and steps

Steps are configured through plugins and typed state shapes, not a new workflow
language. A plugin registers a step name, input state, output state, event
shape, and runner. A post-merge step should only typecheck against state that
includes merge output; a pre-merge step should not accidentally require merged
state.

```ts
withStep("check", command("bun run test"))
withMerge(gitMerge())
withStep("deploy", command("bun run deploy"))
```

Step events map naturally to spans:

```text
line/step/check/start { line, submission, attempt? }
line/step/check/end { success, exitCode?, durationMs, error?, artifacts? }
line/step/deploy/start { line, submission }
line/step/deploy/end { success, url?, durationMs, error? }
```

Batching belongs to the line plugin. `withBatch(false)`, `withBatch(0)`, and
`withBatch(1)` disable batching; a number above one enables that batch size. A
red batch isolates the faulting submission with bisection and keeps clean work
moving.

## Contest mode

Contest mode is above bay and before final line integration. It evaluates
multiple independent implementations of the same real task. Manual winner
selection should ship first; automatic selection is a later plugin once manual
decisions have produced enough evidence.

Attempts record agent identity, branch/ref, artifacts, logs, cost, duration,
and line-step results. Contest evaluators compare submissions using required
step results, tests, coverage, review verdicts, diff size, performance, cost,
wall time, and human selection.

## Integration boundaries

- **km** provides durable task context through an adapter that translates km
  beads/tree data into Yrd task records and events.
- **ag** launches and records agent/harness attempts through a contest/task
  adapter; it does not own bay lifecycle or final integration.
- **hab** can host Yrd as a service and probe health/status; Yrd packages should
  not import hab service internals.
- **GitHub** is an adapter: issues can back tasks, PRs can back submissions,
  checks/reviews can be step providers, and GitHub Merge Queue can be one merge
  provider.
- **tent** is local fleet policy. It can configure Yrd for one repo, but Yrd
  packages must not import tent policy.

## Transition state

The GitHub repo identity is `beorn/yrd`; old `beorn/gitbay` URLs redirect.
Package repository metadata points at `github:beorn/yrd`. Compatibility
commands remain installed.

Still coordinated separately:

- package name changes from `git-bay` to Yrd-scoped package names
- consuming-repo path and bead moves
- full monorepo package split
- `line`, `task`, and `contest` projections beyond the advertised CLI shape

## Reference

- [Architecture](architecture.md)
- [Model](model.md)
- [Events](events.md)
- [Store](store.md)
- [Worktrees and bays](layers/worktrees.md)
- [Checks](layers/checks.md)
- [Issue tracking](layers/issue-tracking.md)
- [Review gate](layers/review-gate.md)
