# Yrd

**Yrd** orchestrates software development: tasks become isolated work bays,
completed work becomes local PRs, integration lines verify and land those PRs,
and contests compare multiple implementations of the same real task.

It is local-first and Git-native. A repository needs no hosted service or
long-running daemon. The durable authority lives under the repository's Git
directory, so ordinary cleanup cannot erase active work.

```text
task -> work bay -> PR -> line -> integrated base branch
          \-> competing bays -> evaluation -> selected PR -> line
```

`yrd` is the complete command. `git bay` is its Git-native bay projection:

```text
git bay <verb> == yrd bay <verb>
```

There is one implementation and one state model. `git bay` does not have a
separate skin or a hidden line namespace.

The project is `beorn/yrd`, the CLI distribution is `git-yrd`, the package
scope is `@yrd`, and its owned public domain is `yrd.dev`.

## Why Yrd

A busy local repository has the same integration hazards as a busy hosted
repository:

- two changes can pass separately and fail together
- a branch can be tested against stale `main` and land untested
- agent work can accumulate as unexplained branches and worktrees
- a long review or remote test can block unrelated integrations
- a selected contest result can drift before it is promoted

Yrd gives every unit of work an explicit place and state. Active work is in a
bay. Work offered for integration is a PR. Checks, reviews, merges, deployments,
logs, and artifacts belong to a line run. Competing implementations belong to
a contest whose winner is an immutable Git commit.

That replaces ambiguous `wip-preserved-*` branches with inspectable state:

| Unmanaged state           | Yrd state                            |
| ------------------------- | ------------------------------------ |
| dirty worktree            | active bay, not submit-ready         |
| ahead branch              | pushed or submitted PR               |
| branch needing repair     | `bay open --from <branch>`           |
| external CI still running | waiting line step with URL and token |
| failed integration        | rejected PR with evidence            |
| completed work            | integrated PR and closable bay       |

Yrd does not invent commits or silently discard work. It prevents ambiguous WIP
by making the normal workflow create named bays and durable PRs from the start.

## Quick Start

The CLI initializes `.git/yrd/` on first use.

```console
$ cd my-repository
$ git bay open fix-release
/work/my-repository/.bays/B1

$ cd /work/my-repository/.bays/B1
$ ...edit and test...
$ git commit -am "fix: release ordering"

$ git bay submit --wait
PR1 submitted
R1 passed

$ yrd line status
LINE                            OPEN    ACTIVE    INTEGRATED    REJECTED
main@91803b2137d8                 0         0             1         0

$ git bay close
B1 closed
```

Without `--wait`, submit is a handoff and an integrator runs the line:

```console
$ git bay submit
PR2 submitted

$ yrd line integrate PR2
RUN     PRS             STATE       STEPS
R2      PR2              passed      check=passed merge=passed
```

During development in this repository:

```bash
bun yrd --help
bun yrd line status
bun git-bay open example
```

Installed binaries are `yrd`, `git-yrd`, and `git-bay`. Git resolves
`git bay ...` through `git-bay` automatically.

## Concepts

| Concept         | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| **Task**        | Unit of intent from km, GitHub, another tracker, or a direct caller |
| **Work Bay**    | Named isolated Git worktree for one implementation attempt          |
| **PR**          | Local pull request containing one immutable submitted revision      |
| **Line**        | Ordered integration process attached to a base branch               |
| **Step**        | Typed line transition such as check, review, merge, or deploy       |
| **Contest**     | Multiple bays implementing the same task for real selection         |
| **Attempt**     | One competitor's bay, Git pin, metrics, and evaluation evidence     |
| **Base branch** | Branch a line integrates into, such as `main` or `release/2.0`      |

Task is the Yrd noun. Issue is adapter vocabulary. PR is the Git-facing work
package; Yrd does not add a second public synonym for it.

A line is more than a branch: it is the configured integration process that
sits on a base branch. Lines do not need a separate create command. A PR creates
or joins the line named by its base branch, and line commands accept that base
branch directly.

## Command Model

Commands that accept `[selector...]` accept zero, one, or many selectors.
Inside a bay, zero selectors means the current bay. Outside a bay, zero
selectors means all eligible work for that operation.

Selectors resolve PR ids, bay ids, bay names, and source branches. Line status
also accepts a base branch.

All read and mutation commands support stable, machine-readable JSON where
documented. Human status uses Silvery tables, semantic status color, and OSC 8
links for bay paths, logs, and artifacts.

### Bay Operations

```text
git bay open <name> [--from <branch>] [--base <branch>] [--json]
git bay refresh [selector...] [--json]
git bay submit [selector...] [--wait] [--base <branch>] [--json]
git bay close [selector...] [--withdraw] [--json]
```

The same commands are available under `yrd bay`.

| Command   | Input                                  | Output and state                                                            |
| --------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `open`    | New bay name; optional source and base | Prints the worktree path; creates and provisions a named bay                |
| `refresh` | Zero or more bays                      | Refreshes Git head/base/dirty facts and lease state                         |
| `submit`  | Bays, PRs, or source branches          | Creates or advances PRs to `submitted`; `--wait` runs the line              |
| `close`   | Zero or more bays                      | Deprovisions clean terminal bays; `--withdraw` explicitly cancels a live PR |

`--head` is an alias for `--from`. `--line` is an alias for `--base`. The
canonical words are source branch (`--from`) and base branch (`--base`).

`open --from` uses an existing branch; there is no `adopt` command. Direct
branch submission does not provision a worktree:

```bash
git bay open release-fix --from fix/release --base release/2.0
git bay submit fix/release --base release/2.0
```

### Line Operations

```text
yrd line status [selector...] [--json]
yrd line audit [--json]
yrd line provision [base] [--json]
yrd line deprovision [base] [--json]
yrd line integrate [selector...] [--steps [step...]] [--retry] [--watch]
yrd line finish <selector> [--step <name>] (--ok | --fail) [evidence options]
yrd line watch [selector...] [--steps [step...]] [--retry]
```

| Command       | Input                                  | Output and state                                                                                             |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `status`      | PRs or base branches                   | Summary counts plus PR state, target, age, touched age, run time, step result, logs, artifacts, and bay path |
| `audit`       | Repository                             | Projection and installed-step findings; no state change                                                      |
| `provision`   | Optional base                          | Resolves and validates line environment resources                                                            |
| `deprovision` | Optional base                          | Releases resources owned by the installed line adapter                                                       |
| `integrate`   | Zero or more eligible PRs              | Runs the configured steps and prints durable run verdicts                                                    |
| `finish`      | One waiting PR/step plus token/verdict | Completes a remote step and resumes its exact run                                                            |
| `watch`       | Optional PR set                        | Repeatedly drains runnable work until cancelled                                                              |

`--steps` narrows a run. Omitted means the configured default sequence. An
explicit empty `--steps` runs no steps. `--retry` re-enters rejected work; it is
an option, not a separate command.

Line status defaults to open PRs. Naming a terminal PR shows its retained
evidence. `AGE` is time since submission, `TOUCHED` is time since the latest
state or step event, and `RUN` is execution duration. A linked state or result
opens its detailed runner URL when one exists.

### Tasks and Contests

```text
yrd task compete <task> -a <harness-and-models> [--prompt <text>]
yrd contest show <contest> [--json]
yrd contest select <contest> --winner <attempt> [--by <actor>] [--reason <text>]
yrd contest promote <contest> [--json]
```

`-a codex/claude` uses the `ag` harness by default. An explicit harness is
separated by a space: `-a "ag codex/claude"`. Slash or comma separates
competitors.

Each competitor receives the same task snapshot and base commit in its own bay.
Yrd records wall time, token counts, reported USD cost, stdout/stderr,
artifacts, the write-once attempt ref, and evaluator results. Missing provider
metrics remain missing; Yrd does not guess cost.

Selection is manual and explicit. Promotion resolves the selected write-once
ref again, verifies that it still names the evaluated commit, and submits that
exact commit as a PR. A moving branch cannot replace the winner.

## Exit Codes

| Code | Meaning                                                                                   |
| ---- | ----------------------------------------------------------------------------------------- |
| `0`  | Command completed; a recorded external fail is still a successful `line finish` operation |
| `1`  | Valid request refused or workflow ended unsuccessfully                                    |
| `2`  | Usage or configuration error                                                              |
| `3`  | Infrastructure, lock, Git, or durable-state failure                                       |

Diagnostics go to stderr. Human and JSON results go to stdout. Commands do not
read stdin except the hidden Git receive-hook entrypoint.

## Lines and Steps

Steps are plugins and typed state transitions, not a workflow-language DSL.
`withStep()` preserves the current shape. `withMerge()` changes it to an
integrated shape. A post-merge step therefore cannot be composed before merge
without a type error.

```ts
const app = pipe(
  createYrd({ store }),
  withEffects(),
  withTasks({ sources }),
  withBays({ workspace }),
  withLine(),
  withStep("check", checkRunner),
  withStep("coderabbit", reviewRunner),
  withMerge(gitMergeRunner),
  withStep("deploy", deployRunner, { needsIntegration: true }),
)
```

Every installed step becomes state, configuration, CLI selection, events, and
status evidence through the same registration. Merge is not hardcoded pipeline
policy; `withMerge()` is the typed transition that supplies integration proof.

The default `.yrd.yml` adapter turns arbitrary shell-backed names into the same
plugins:

```yaml
line:
  base: main
  batch: 8
  steps: [check, coderabbit, sec-check, merge, deploy]

steps:
  check: bun test
  coderabbit:
    run: launch-coderabbit
    runner: waiting
  sec-check: bun run security
  merge: {}
  deploy: bun run deploy

contest:
  concurrency: 2
  timeoutMs: 1800000
  evaluators: [check, sec-check]
```

Names before `merge` run against the checked candidate. Names after `merge` run
against the integrated commit. The TypeScript API enforces this statically; the
YAML adapter validates the same ordering while composing plugins.

### Remote Runners

A waiting command launches work elsewhere and prints one final JSON object:

```json
{ "token": "run-123", "url": "https://ci.example/runs/123", "artifacts": [] }
```

Yrd records the token and URL, releases the writer lock, and continues
integrating unrelated PRs. The remote system or an operator completes it with:

```bash
yrd line finish PR7 --step coderabbit --ok --token run-123 \
  --artifact report=https://ci.example/runs/123/report
```

Long jobs therefore use the same durable effect contract as local commands.
They do not require a second queue or a second line.

### Batching

`line.batch` is the maximum batch size and defaults to `1`. `false`, `0`, and
`1` disable batching. A value above one tests candidates together. A failing batch is recursively
bisected until Yrd identifies the failing PRs, while passing subsets continue.
Bisection is the line plugin's fixed isolation policy, not another config axis.

Different base branches have independent line state but share the repository's
event journal, receiver, artifacts, and configured plugins:

```bash
git bay open release-fix --base release/2.0
git bay submit --base release/2.0
yrd line status release/2.0
```

## State and Recovery

Yrd stores local authority under the primary worktree's common Git directory:

```text
.git/yrd/
  events.jsonl       append-only authority
  writer.lock        cross-process single-writer lease
  prs.git/           bare PR ref/object receiver
  receiver-inbox/    crash-safe receive-hook handoff
  artifacts/         command, evaluator, and contest evidence
```

`events.jsonl` is the source of truth. Startup folds it into Bay, PR, Line,
Effect, and Contest state. There is no second mutable database or read-model
cache to reconcile.

Effects are the single durable job lifecycle: requested, running, waiting,
passed, failed, or lost. Line steps and contest attempts retain effect ids and
derive operational status and evidence from those effects. This prevents three
competing retry/recovery implementations.

`prs.git` is a Git object/ref receiver, not the state store. Its pre-receive
hook validates updates; its post-receive hook leaves an atomic receipt that is
deduplicated with the PR intake event. The inbox exists only for crash recovery.

## Integration Boundaries

- **km** supplies tracker-neutral task snapshots through a task-source adapter.
- **ag** runs contest competitors and supplies provider/harness evidence.
- **Hab** may host Yrd as a service; Yrd does not import habitat policy.
- **GitHub** can adapt issues to tasks and checks/reviews/merge to line steps.
- **Tent** may configure Yrd for a fleet, but fleet policy stays outside Yrd.

The low-level packages remain usable by a single developer with no agent fleet.

## Packages

| Package        | Responsibility                                                          |
| -------------- | ----------------------------------------------------------------------- |
| `@yrd/core`    | Event authority, serialized operations, effect jobs, plugin composition |
| `@yrd/task`    | Task references, snapshots, and source adapters                         |
| `@yrd/bay`     | Work bays, PR intake, Git workspace, and receive hooks                  |
| `@yrd/line`    | Typed steps, merge proof, waiting jobs, batching, and status            |
| `@yrd/contest` | Competitors, evaluators, selection, metrics, and exact promotion        |
| `@yrd/cli`     | `yrd`, `git-yrd`, and `git-bay` command projections                     |

The app is composed from `with*` plugins. Consumers can replace task sources,
Git workspace adapters, step runners, evaluators, Git resolution, and line
administration without forking the core.

## Development

```bash
bun yrd --help
bun check
```

`bun yrd` always runs `./bin/yrd`, so it exercises the development version.
The focused Vitest files under each package are executable contracts for the
same public flows. [TODO.md](TODO.md) contains only open acceptance work and
post-cutover fixes; background research stays outside the public repository.
