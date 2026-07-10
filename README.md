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

The implementation model and package boundaries are documented in
[ARCHITECTURE.md](ARCHITECTURE.md).

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

The CLI initializes `.git/yrd/` on the first repository-backed command. Help is
repository-independent and never creates Yrd state.

```console
$ cd my-repository
$ git bay open fix-release
BAY    STATUS    BRANCH                    BASE    PATH
B1     active    task/fix-release          main    /work/my-repository/.bays/B1

$ cd /work/my-repository/.bays/B1
$ ...edit and test...
$ git commit -am "fix: release ordering"

$ git bay submit --wait
PR     STATUS       BRANCH                 BASE    REV    HEAD
PR1    submitted    task/fix-release       main      1    a13f09b1c821

RUN    PRS    STATE     STEPS
R1     PR1    passed    check=passed merge=passed

$ yrd line status
LINE                            OPEN    ACTIVE    INTEGRATED    REJECTED
main@91803b2137d8                 0         0             1         0

$ git bay close
BAY    STATUS    BRANCH                    BASE    PATH
B1     closed    task/fix-release          main    /work/my-repository/.bays/B1
```

Without `--wait`, submit is a handoff and an integrator runs the line:

```console
$ git bay submit
PR     STATUS       BRANCH                 BASE    REV    HEAD
PR2    submitted    task/another-fix       main      1    b7144cc7d201

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

| Concept            | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| **Task**           | Unit of intent from km, GitHub, another tracker, or a direct caller |
| **Work Bay**       | Named isolated Git worktree for one implementation attempt          |
| **PR**             | Local pull request containing one immutable submitted revision      |
| **Line**           | Ordered integration process attached to a base branch               |
| **Step**           | Typed line transition such as check, review, merge, or deploy       |
| **Job**            | Durable executable work; retries are attempts on the same Job       |
| **Contest**        | Multiple bays implementing the same task for real selection         |
| **Attempt**        | One competitor's bay, Git pin, metrics, and evaluation evidence     |
| **Evaluation run** | One evaluator Job against an immutable attempt pin                  |
| **Base branch**    | Branch a line integrates into, such as `main` or `release/2.0`      |

Task is intent. An Operation is a serializable command. A Step configures work
on a Line; a Job durably executes that work. Issue is adapter vocabulary. PR is
the Git-facing work package; Yrd does not add a second public synonym for it.

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
git bay open <name> [--from <branch>] [--base <branch>]
  [--task <ref>] [--actor <id>] [--json]
git bay refresh [selector...] [--json]
git bay submit [selector...] [--wait] [--base <branch>] [--json]
git bay close [selector...] [--withdraw] [--json]
```

The same commands are available under `yrd bay`.

| Command   | Input                                                | Output and state                                                            |
| --------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `open`    | New bay name; optional source, base, task, and actor | Prints the worktree path; creates and provisions a named bay                |
| `refresh` | Zero or more bays                                    | Refreshes Git head, base, dirty, path, and workspace status                 |
| `submit`  | Bays, PRs, or source branches                        | Creates or advances PRs to `submitted`; `--wait` runs the line              |
| `close`   | Zero or more bays                                    | Deprovisions clean terminal bays; `--withdraw` explicitly cancels a live PR |

`--head` is an alias for `--from`. `--line` is an alias for `--base`. The
canonical words are source branch (`--from`) and base branch (`--base`).

`--task` stores an opaque tracker-neutral reference such as `km:@yrd/core/42`
or `github:beorn/yrd#42`. `--actor` records the worker or implementation
identity. Yrd preserves these links but does not import tracker lifecycle or
fleet policy. Actor attribution does not launch a process; an explicit composed
runner, such as Contest's `ag` runner, mans the Bay.

`open --from` uses an existing branch; there is no `adopt` command. Direct
branch submission does not provision a worktree:

```bash
git bay open release-fix --from fix/release --base release/2.0
git bay submit fix/release --base release/2.0
```

#### Manning an Ordinary Bay

Yrd attributes an ordinary Bay to an actor but does not assign, launch, lease,
or resume that actor. The caller owns those policies. A human, Tent, or another
Hab app composes the workflow explicitly:

```bash
# Claim github:beorn/yrd#42 in the caller's task system first.
yrd bay open fix-42 --task github:beorn/yrd#42 --actor @agent/3

cd /path/printed/by/yrd
ag code codex --new --name @agent/3 -- "Implement github:beorn/yrd#42 and commit the result."

cd -
yrd bay submit fix-42
yrd line integrate fix-42
```

Contest is different because launching comparable implementations is part of
its domain contract: `task compete` creates the Bays and its configured runner
launches each competitor. If two non-Contest callers later need the same
manning lifecycle, their shared behavior can be extracted above Yrd instead of
turning actor attribution into a hidden side effect of `bay open`.

### Line Operations

```text
yrd line status [selector...] [--json]
yrd line audit [--json]
yrd line provision [base] [--json]
yrd line deprovision [base] [--json]
yrd line integrate [selector...] [--steps [step...]] [--retry] [--watch]
yrd line finish <selector> [--step <name>] (--ok | --fail) [evidence options]
```

| Command       | Input                                  | Output and state                                                                                             |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `status`      | PRs or base branches                   | Summary counts plus PR state, target, age, touched age, run time, step result, logs, artifacts, and bay path |
| `audit`       | Repository                             | Journal, projection, pinned-plan, and installed-step findings; no state change                               |
| `provision`   | Optional base                          | Resolves and validates line environment resources                                                            |
| `deprovision` | Optional base                          | Releases resources owned by the installed line adapter                                                       |
| `integrate`   | Zero or more eligible PRs              | Runs configured steps; `--watch` keeps draining until cancelled                                              |
| `finish`      | One waiting PR/step plus token/verdict | Records external evidence and resumes that exact durable run                                                 |

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
yrd contest evaluate <contest> [--retry] [--json]
yrd contest finish <contest> [--attempt <attempt>] [--evaluator <id>]
  (--ok | --fail | --error <code>) --token <token> [evidence options]
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

`contest evaluate` resumes missing competitor and evaluator work. It never
reruns a competitor whose implementation is already pinned. `--retry` returns
failed or lost infrastructure Jobs to `requested` and retains their Job ids. A
completed evaluator Job with a failed candidate verdict gets a new Evaluation
run instead. Each Evaluation run has its own definition revision, timing,
verdict, and artifacts; earlier runs remain immutable and appear as separate
generation rows in human status.

`contest finish` records one token-fenced remote evaluator verdict. If the
attempt or evaluator is omitted, it must identify the only waiting evaluation;
otherwise Yrd asks for the missing selector. `--fail` records a failed candidate
verdict from a successful evaluator run. `--error <code>` records an evaluator
infrastructure failure instead, with `--detail` as its message; retry can then
return that same durable Job to `requested`. Verdict artifacts belong to
`--ok`/`--fail`; infrastructure launch evidence is retained from the waiting
Job. Recording either external outcome is itself a successful finish command.

Selection is manual and explicit, and is available only after every configured
evaluation is terminal. It freezes further evaluation. Promotion resolves the
selected write-once ref again, verifies that it still names the evaluated
commit, and submits that exact commit as a PR. A moving branch cannot replace
the winner.

## Exit Codes

| Code | Meaning                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------- |
| `0`  | Command completed; recording an external failed verdict is still a successful finish operation |
| `1`  | Valid request refused or workflow ended unsuccessfully                                         |
| `2`  | Usage or configuration error                                                                   |
| `3`  | Infrastructure, lock, Git, or durable-state failure                                            |

Diagnostics go to stderr. Human and JSON results go to stdout. Commands do not
read stdin except the hidden Git receive-hook entrypoint.

Expected failures carry one serializable `{ kind, code, message }` fact. The
CLI projects its exit code from `kind`; changing diagnostic wording cannot
silently change automation behavior. An untyped exception is treated as an
infrastructure failure and fails loud with exit `3`.

## Lines and Steps

Steps are immutable definitions and typed state transitions, not a
workflow-language DSL. `withStep()` preserves the current shape. `withMerge()`
changes it to an integrated shape. A post-merge step therefore cannot be
composed before merge without a type error.

```ts
const bayJobs = createBayJobDefs(workspace)
const check = withStep("check", checkRunner, { revision: "check-v1" })
const review = withStep("coderabbit", reviewRunner, {
  revision: "coderabbit-v1",
})
const merge = withMerge(gitMergeRunner, { revision: "git-merge-v1" })
const deploy = withStep("deploy", deployRunner, {
  revision: "deploy-v1",
  needsIntegration: true,
})
const line = withLine({ steps: [check, review, merge, deploy] as const })
const contests = withContests({ runners, evaluators, git })

const base = pipe(
  createYrdDef(),
  withJobs({ definitions: [bayJobs, line.jobDefs, contests.jobDefs] }),
  withTasks({ sources }),
  withBays({ jobs: bayJobs }),
)

await using yrd = await createYrd(contests(line(base)), {
  inject: { journal, scope, log },
})
```

`withLine()` installs the ordered descriptors and exposes the fixed Job
definitions that the root installs once through `withJobs()`. Every step then
becomes state, CLI selection, events, and status evidence through the same
definition. Merge is not hardcoded pipeline policy; `withMerge()` is the typed
transition that supplies integration proof.

The default `.yrd.yml` adapter turns arbitrary shell-backed names into the same
plugins:

```yaml
line:
  base: main
  batch: 8
  steps: [check, coderabbit, sec-check, merge, deploy]

steps:
  check: bun run test
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

Local pre-merge checks and held-out evaluators use detached scratch worktrees
under the configured bays root. The configured command owns dependency
provisioning, so it can verify the candidate's own lockfile instead of borrowing
mutable host packages. This repository uses `bun install --frozen-lockfile
--ignore-scripts` before invoking its installed Vitest. Local execution is not
a security sandbox: candidate code still runs with the operator-configured
process privileges; use a remote or isolated Process adapter for a stronger
trust boundary.

### Remote Runners

A waiting command launches work elsewhere and prints one final JSON object:

```json
{ "token": "run-123", "url": "https://ci.example/runs/123", "artifacts": [] }
```

Yrd records the token and URL, releases the writer lock, and continues
checking unrelated PRs or Contest attempts. Line steps and Contest evaluators
share this Job launcher contract. The remote system or an operator completes a
Line step with:

```bash
yrd line finish PR7 --step coderabbit --ok --token run-123 \
  --artifact report=https://ci.example/runs/123/report
```

The same runner contract completes a Contest evaluator without exposing the
generic Job transition surface:

```bash
yrd contest finish C2 --attempt A2 --evaluator sec-check --ok \
  --token run-456 --artifact report=https://ci.example/runs/456/report
```

If the evaluator service itself failed, record the infrastructure outcome
instead of turning it into a candidate verdict:

```bash
yrd contest finish C2 --attempt A2 --evaluator sec-check \
  --error runner-timeout --detail "runner timed out" --token run-456
```

Long jobs therefore use the same durable job contract as local commands.
They do not require a second queue or a second line.

Each check pins its candidate to the then-current base. Several PRs may wait on
remote work concurrently, but only one candidate can move a base branch first.
If another candidate then reaches merge, Yrd rejects its stale proof instead of
landing untested work; `line integrate PR7 --retry` rebuilds and rechecks it on
the new base.

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
  writer.lock        short cross-process append lock
  prs.git/           bare PR ref/object receiver
  receiver-inbox/    crash-safe receive-hook handoff
  artifacts/         command, evaluator, and contest evidence
```

`events.jsonl` is the source of truth. Each command appends one versioned,
checksummed transaction frame as one JSONL record, containing both its domain
events and Job requests. Startup folds committed frames into Bay, PR, Line,
Job, and Contest state. An unterminated final frame is uncommitted and is
truncated under the writer lock; malformed newline-committed frames are
reported as corruption. There is no second mutable database or read-model
cache to reconcile.

Callers may supply a stable command id. Yrd records that id plus a hash of the
serialized operation in each transaction Frame's cause. Repeating the same id
and operation returns the already committed result; reusing the id for
different arguments is refused. The Git receiver uses its receipt id this way,
so replay after a lost response cannot create a second PR revision.

Jobs are the single durable executable lifecycle: requested, running, waiting,
passed, failed, or lost. `withJobs()` installs that authority when the
application needs executable work. Line and Contest records retain domain
facts; their Job ids, status, attempts, timing, and evidence are derived from
typed Job inputs and results. This prevents three competing retry and recovery
implementations.

A Job retry is infrastructure recovery for the same failed or lost Job and
keeps its id. A Contest re-evaluation is different: an evaluator may complete
successfully while returning a failed candidate verdict. Yrd records a new
Evaluation Job generation for that case and derives the complete run history
from Jobs, without adding another lifecycle store.

Job requests pin the definition revision used to create them. Pending execution
is refused if current plugin code has a different revision. A waiting Job may
still finish after revision drift because its token, attempt, executor, and
stable definition output contract fence that already-launched work. Line runs
also pin their complete ordered step descriptors, so historical status remains
readable after config changes and `line audit` reports unavailable pending
plans.

Yrd owns the Job record and imports backend lifecycle events. Running work has
an expiring, heartbeated executor lease; crashed work becomes `lost` and can be
retried. A `waiting` Job has no launcher lease and remains durable until a
token-matched finish arrives.

Execution is **at least once** across crashes: an executor may perform an
external side effect before its settlement frame is committed. Yrd accepts only
one settlement for a Job attempt, but a backend must deduplicate effects by the
stable Job id and fence stale attempts. Configured commands receive `YRD_JOB`,
`YRD_ATTEMPT`, and `YRD_EXECUTOR` for that purpose. Yrd never guesses that a
side effect did or did not happen.

[`@yrd/core`](packages/yrd-core/README.md) documents Operations, transaction
frames, projection, and the Journal contract. [`@yrd/job`](packages/yrd-job/README.md)
documents Job states, leases, waiting work, retries, and backend idempotency.

`prs.git` is a Git object/ref receiver, not the state store. Its pre-receive
hook validates updates; its post-receive hook leaves an atomic receipt that is
deduplicated with the PR intake event. The inbox exists only for crash recovery.
The `bay` receiver is a push default only inside provisioned Work Bays. Host
startup removes the legacy shared `remote.pushDefault=bay` setting if present,
so plain `git push` in the primary worktree continues to use its normal remote.

## Integration Boundaries

- **km** supplies tracker-neutral task snapshots through a task-source adapter.
- **ag** runs contest competitors and supplies provider/harness evidence.
- **Hab** may host Yrd as a service; Yrd does not import habitat policy.
- **GitHub** can adapt issues to tasks and checks/reviews/merge to line steps.
- **Tent** may configure Yrd for a fleet, but fleet policy stays outside Yrd.

The low-level packages remain usable by a single developer with no agent fleet.

## Packages

| Package            | Responsibility                                                   |
| ------------------ | ---------------------------------------------------------------- |
| `@yrd/core`        | Immutable composition, Operations, Frames, projection, Journal   |
| `@yrd/persistence` | Checksummed JSONL Journal and cross-process append exclusion     |
| `@yrd/process`     | Scope-owned subprocess execution, bounds, cancellation, evidence |
| `@yrd/job`         | Durable executable lifecycle, leases, waiting work, recovery     |
| `@yrd/task`        | Task references, snapshots, and source adapters                  |
| `@yrd/bay`         | Work bays, PR intake, Git workspace, and receive hooks           |
| `@yrd/line`        | Typed steps, merge proof, waiting jobs, batching, and status     |
| `@yrd/contest`     | Competitors, evaluators, selection, metrics, exact promotion     |
| `@yrd/cli`         | `yrd`, `git-yrd`, and `git-bay` command projections              |

The app is composed from `with*` plugins. Consumers can replace task sources,
Git workspace adapters, step runners, evaluators, Git resolution, and line
administration without forking the core.

## Development

```bash
bun yrd --help
bun check
bun run build
```

`bun yrd` always runs `./bin/yrd`, so it exercises the development version.
`bun run build` emits one bundled CLI implementation plus the three tiny argv
projection bins under `dist/`. The `git-yrd` package includes only that built
distribution and public docs; local bays, tests, and repository work state are
excluded from its tarball.
When Yrd is source-linked under the hh vendor workspace, use `bun check:hh`;
that explicit config supplies sibling source declarations without leaking them
into standalone package resolution.
The focused Vitest files under each package are executable contracts for the
same public flows. [TODO.md](TODO.md) contains only open acceptance work and
post-cutover fixes; background research stays outside the public repository.
