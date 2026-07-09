# Yrd

**Yrd** is the software delivery yard: tasks, bays, integration lines, and
real-task evaluation of agents or harnesses. This repository currently ships
the Git-native **bay** component plus the first `line`, `task`, and `contest`
command projections. Git Bay is the Git-native command projection for the bay
component, not a separate product.

## Available today

- `yrd bay <verb>` runs the same implementation as `git bay <verb>`.
- `yrd line status|audit|integrate|watch` projects the current check/merge
  integration path over the same Git Bay state and event log.
- `yrd task compete <task>` opens one bay per competitor, runs agent/harness
  attempts, and records logs, git metrics, token/cost metrics when the runner
  exposes them, evaluator results, and commits.
- `yrd contest show|select|promote` inspects a contest, records a manual
  winner, and promotes the winning attempt into the bay/line path.
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

- **Task**: a unit of intent. Yrd is agnostic to the source: km bead, GitHub
  issue, Linear ticket, local todo, or direct API call.
- **Bay**: an isolated workspace for one implementation attempt on a task.
- **Submission**: completed work from a bay, handed to an integration line. In
  Git-native contexts this may be projected as a PR.
- **Line**: the integration path for submissions: checks, review, merge, deploy,
  audit, and status.
- **Contest**: multiple bays attempt the same real task; one winning submission
  is selected and promoted.

`task` is the Yrd intake noun. `issue` is reserved for tracker adapters and
external systems. `submission` is the Yrd integration noun. `PR` is reserved for
Git Bay, GitHub, and other Git-facing projections.

## Command projections

The installed projections are `bay`, `line`, `task`, and `contest`. The
Yrd-facing command shape is:

```bash
yrd bay open <name>
yrd bay refresh
yrd bay submit [selector...] [--wait]
yrd bay close

yrd line status [PR|name] [--json]
yrd line audit [--json]
yrd line integrate [PR|name] [--steps check,merge,deploy] [--retry] [--watch] [--interval <sec>]
yrd line watch [PR|name] [--interval <sec>]

yrd task compete <task> --agents "ag codex/claude" --base main --bays 2
yrd contest show <contest> [--json]
yrd contest select <contest> --winner <attempt>
yrd contest promote <contest>
```

The current Git Bay CLI exposes the shipped v0.3 verbs documented in the README
(`open`, `close`, `gc`, `submit`, `check`, `merge`, `integrate`, `retry`,
`audit`, etc.). The Yrd-facing shape above is the stable product projection over
that implementation; shipped compatibility verbs stay available while the CLI
converges.

Staged line lifecycle commands:

```bash
yrd line provision [<base>]
yrd line deprovision [<base>]
```

`yrd task compete <task>` creates a contest and launches bay attempts.
`yrd contest ...` commands manage an existing contest lifecycle. Built-in
competitors use ag-style provider-list vocabulary: `--agents "ag codex/claude"`
uses the same list syntax as `ag codex/claude`, but with contest semantics.
Plain `ag codex/claude` selects one healthy provider seat; yrd fans the list out
into one isolated bay attempt per provider. The shorter `--agents codex/claude`
and comma-separated lists remain accepted. Custom competitors can be supplied
with `--agent-cmd <name=command>`.

For commands that accept zero or more steps, an omitted step list means "run the
configured default sequence." `--steps` is the canonical narrowing flag.
`--retry` is an option on step-running commands, not a separate vocabulary
branch. The installed local line sequence is `check,merge,deploy`. Deploy runs
only after merge, records a step verdict, and cannot revoke `merged`.

## Implementation Order

The first Yrd cutover target is still the integration lane: make `@ci` run
through `yrd bay` + `yrd line` once the line has the artifact, status, and
resume guarantees the CI lane needs. Contest mode is above that path; its first
manual-selection projection is installed, and line hardening remains the gating
work for replacing the current `@ci` lane.

The first line projection slice is installed: `yrd line integrate --steps
check,merge,deploy` delegates to the current Git Bay integration logic, `yrd line
status`, `audit`, and `watch` expose the same queue and event-log-backed state,
local step runs record exit code, duration, base/head SHAs, normalized failure
metadata, and stdout/stderr artifacts, and `yrd line status --json` exposes
folded open-line items with last step results and checked-PR staleness. Human
`yrd line status` renders the same folded line summary concisely. That gives
`@ci` a real command surface to start targeting, but not yet the full line
package.

Remaining non-throwaway line work:

1. finish core submission and line-step event/state contracts beyond local
   check/merge/deploy;
2. add the runner seam for remote/container/hosted execution;
3. switch `@ci` to that line projection.

Repo-local docs and future `spec.md` files should be public-suitable product or
API docs. Tentative reference, background research, and prior-art notes stay
outside this repo under `hub/yrd/reference` or in `@yrd` beads.

## Package shape

The monorepo target is:

- `@yrd/core`: records, event contracts, plugin composition, typed state shapes.
- `@yrd/bay`: bay lifecycle and the Git-native implementation currently shipped
  by this repo.
- `@yrd/line`: integration lines, queues, steps, merge/deploy execution,
  artifacts, status, and resume.
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

The runner is a seam: the first runner is a local command runner, but the line
model must not require local child processes. Remote runners, container runners,
or hosted CI adapters should satisfy the same step result contract.

Step events map naturally to spans:

```text
line/step/started { step, pr?, batch?, target, role?, index? }
line/step/finished { step, pr?, batch?, target, ok, detail?, exitCode?, durationMs?, configHash?, skipped?, baseSha?, headSha?, error?, artifacts? }
error { code, message, exitCode? }
```

Artifacts include logs, coverage, reports, and build outputs. The default local
artifact store writes command stdout/stderr under `.git/bay/artifacts/`; the
event carries references, not inline blobs. A resumed line run folds the event log
first and skips a successful check result only when it matches the same PR,
target, base commit, head commit, and check config hash; the resumed event
records `skipped: true`. A checked PR is stale when its recorded `baseSha` or
`headSha` no longer matches the current line base or target commit.

Human intervention is also an event-log fact. A future `line/override` event
records who overrode what and why without pretending the line succeeded
automatically.

Batching belongs to the line plugin. `withBatch(false)`, `withBatch(0)`, and
`withBatch(1)` disable batching; a number above one enables that batch size. A
red batch isolates the faulting submission with bisection and keeps clean work
moving.

## Contest mode

Contest mode is above bay and before final line integration. It evaluates
multiple independent implementations of the same real task. Manual winner
selection is the installed first evaluator. Automatic selection is a later
plugin once manual decisions have produced enough evidence.

Attempts record agent identity, branch/ref, artifacts, logs, cost, duration,
and line-step results. Contest evaluators compare submissions using required
step results, tests, coverage, review verdicts, diff size, performance, cost,
wall time, and human selection.

The first implementation stores contest records under `.git/bay/contests/`.
Runner stdout/stderr are log artifacts. Token and cost metrics are extracted
best-effort from runner JSON output: Claude's `--output-format json` currently
reports dollar cost, while Codex JSONL reports tokens but may not report a cost
field. The record keeps missing cost as missing, not guessed.

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

- published package/release policy for the Yrd-scoped packages
- consuming-repo path and bead moves
- full monorepo package split
- line artifacts/status/resume hardening and `@ci` cutover
- contest hardening: event-sourced contest state, richer evaluator plugins,
  runner-specific cost adapters, and remote/hosted runner support

## Reference

- [README](../README.md)
- [TODO](../TODO.md)
