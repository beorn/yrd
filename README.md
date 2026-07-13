# yrd (shipyard) — agentic software delivery

**yrd** takes work from issue to merged, built for agent fleets and the humans
steering them: work happens in **bays** (isolated Git workspaces), becomes a
**PR** (branch@head with numbered revisions), and enters a per-base **queue**
that verifies and merges serially—one run at a time, every decision journaled.
It is sovereign by construction: the queue, journal, evidence, and decisions
live in your repository on your machine, with no forge or network dependency.

## The model — five objects, one pipeline

```text
issue -> bay -> pr -> queue -> merged
          ^      ^
          +-- contest (competing implementations; winner promotes to a PR)
```

- **issue** — what you deliver. It lives in your tracker; yrd stores only the
  reference. The tracker holds the pen; yrd owns the lens.
- **bay** — where you work: an isolated Git workspace. It also ships standalone
  as `git-bay`; that surface works verbatim under `yrd bay`.
- **pr** — the submitted change: a branch@head with numbered revisions. Review
  happens upstream; a yrd PR is the queue's unit.
- **queue** — one per base branch. It verifies and merges PRs serially and can
  pause intake without killing active work.
- **contest** — several implementations of one issue, evaluated against the
  same pin; the selected winner promotes to a PR.

Runs, steps, jobs, attempts, and the runners that execute them are evidence
inside PRs and the log, not top-level objects to manage.

yrd is gh-shaped, not gh-scoped: its noun and aspect-verb grammar makes `gh`
muscle memory transfer, while its scope is deliberately one slice of the forge:
delivery. It composes two independently useful products—`git-bay` workspaces
and the merge queue. Two deliberate absences define the boundary: `yrd pr
merge` never merges because the queue is the only merger, and yrd never creates
or edits issues because the tracker remains authoritative.

The project is `beorn/yrd`, its distribution is `git-yrd`, the package scope is
`@yrd`, and its public domain is `yrd.dev`.

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
logs, and artifacts belong to a queue run. Competing implementations belong to
a contest whose winner is an immutable Git commit.

That replaces ambiguous `wip-preserved-*` branches with inspectable state:

| Unmanaged state           | Yrd state                             |
| ------------------------- | ------------------------------------- |
| dirty worktree            | active bay, not submit-ready          |
| ahead branch              | pushed or submitted PR                |
| branch needing repair     | `bay open --from <branch>`            |
| external CI still running | waiting queue step with URL and token |
| failed integration        | rejected PR with evidence             |
| completed work            | integrated PR and closable bay        |

Yrd does not invent commits or silently discard work. It prevents ambiguous WIP
by making the normal workflow create named bays and durable PRs from the start.

## Quick Start

The CLI initializes `.git/yrd/` on the first repository-backed command. Help is
repository-independent and never creates Yrd state.

```console
$ cd my-repository
$ yrd bay open fix-release
BAY  STATUS  BRANCH             BASE  PATH
B1   active  issue/fix-release  main  /work/my-repository/.bays/B1

$ cd /work/my-repository/.bays/B1
$ ...edit and test...
$ git commit -am "fix: release ordering"

$ yrd pr submit
PR   STATUS     BRANCH             BASE  REV  HEAD
PR1  submitted  issue/fix-release  main  1    a13f09b1c821

$ yrd pr status
PR1 submitted position=1

$ yrd queue run PR1
RUN  PRS  STATE   STEPS
R1   PR1  passed  check=passed merge=passed

$ yrd
main@91803b2137d8 OPEN 0 ACTIVE 0 INTEGRATED 1 REJECTED 0

$ yrd bay close
BAY  STATUS  BRANCH             BASE  PATH
B1   closed  issue/fix-release  main  /work/my-repository/.bays/B1
```

Submission is always a handoff. It never executes checks or merges. `queue run`
is the only drain imperative; one invocation makes one pass, while `--watch`
keeps the foreground drain supervised:

```console
$ yrd queue run --watch
```

During development in this repository:

```bash
bun yrd --help
bun yrd
bun yrd pr runs PR1

# Installed alias for `yrd bay open example`:
git bay open example
```

Installed binaries are `yrd`, `git-yrd`, and `git-bay`. Git resolves
`git bay ...` through `git-bay` automatically.

## Execution records

| Concept            | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| **Issue**          | Unit of intent from km, GitHub, another tracker, or a direct caller |
| **Work Bay**       | Named isolated Git worktree for one implementation attempt          |
| **PR**             | Local pull request containing one immutable submitted revision      |
| **Queue**          | Ordered integration process attached to a base branch               |
| **Step**           | Typed queue transition such as check, review, merge, or deploy      |
| **Job**            | Durable executable work; retries are attempts on the same Job       |
| **Contest**        | Multiple bays implementing the same issue for real selection        |
| **Attempt**        | One competitor's bay, Git pin, metrics, and evaluation evidence     |
| **Evaluation run** | One evaluator Job against an immutable attempt pin                  |
| **Base branch**    | Branch a queue merges into, such as `main` or `release/2.0`         |

Issue is intent. A Command is serializable intent. A Step configures work
on a Queue; a Job durably executes that work. Issue is adapter vocabulary. PR is
the Git-facing work package; Yrd does not add a second public synonym for it.

A queue is more than a branch: it is the configured integration process that
sits on a base branch. Queues do not need a separate create command. A PR creates
or joins the queue named by its base branch, and queue commands accept that base
branch directly.

## Command Model

Commands that accept `[selector...]` accept zero, one, or many selectors.
Inside a bay, zero selectors means the current bay. Outside a bay, zero
selectors means all eligible work for that operation.

Selectors resolve PR ids, bay ids, bay names, source branches, and—where the
command acts on a queue—base branches.

Every public verb accepts `--json` and returns an invoked-command discriminator
such as `pr.submit`, `pr.status`, or `queue.run`. Human output uses Silvery
tables, semantic status color, and OSC 8 links for paths, logs, and artifacts.

The top-level surface is deliberately small:

```text
yrd                         dashboard across queues, PRs, and recent outcomes
yrd pr                      list PRs; submit, view, runs, diff, checkout,
                            status, edit, retry, close, and merge teaching
yrd bay                     list bays; open, refresh, submit, and close
yrd issue                   read-only issue list and joined delivery view
yrd contest                 list; open, eval, view, finish, select, promote
yrd queue                   list queues; run, pause, resume, recover, finish,
                            init, deinit, audit
yrd log                     terminal queue history; --all adds lossless records
yrd watch                   live read-only dashboard
yrd prime                   agent briefing plus current delivery context
```

### Bay Operations

```text
yrd bay open <name> [--from <branch>] [--base <branch>]
  [--issue <ref>] [--actor <id>] [--json]
yrd bay refresh [selector...] [--json]
yrd bay submit [selector...] [--base <branch>]
  [--correlation <namespace:id>] [--json]
yrd bay close [selector...] [--withdraw] [--json]
```

The same commands are available through the standalone `git bay` projection.
`bay submit` is permanent cross-product vocabulary and delegates to the same
submission core as `pr submit`; submission never runs the queue.

| Command   | Input                                                 | Output and state                                                            |
| --------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `open`    | New bay name; optional source, base, issue, and actor | Prints the worktree path; creates and provisions a named bay                |
| `refresh` | Zero or more bays                                     | Refreshes Git head, base, dirty, path, and workspace status                 |
| `submit`  | Bays, PRs, or source branches                         | Creates or advances PRs to `submitted`; never executes queue work           |
| `close`   | Zero or more bays                                     | Deprovisions clean terminal bays; `--withdraw` explicitly cancels a live PR |

`--head` is an alias for `--from`. `--queue` is an alias for `--base`. The
canonical words are source branch (`--from`) and base branch (`--base`).

`--issue` stores an opaque tracker-neutral reference such as `km:@yrd/core/42`
or `github:beorn/yrd#42`. `--actor` records the worker or implementation
identity. Yrd preserves these links but does not import tracker lifecycle or
fleet policy. Actor attribution does not launch a process; an explicit composed
runner, such as Contest's `ag` runner, mans the Bay.

`--correlation <namespace:id>` binds an opaque, transport-neutral correlation
to the submitted PR revision. Yrd carries it through PR, Queue Run, journal,
and JSON projections. A composed host may inject a versioned settlement Job for
terminal outcomes; Yrd itself does not interpret the namespace or import the
external transport.

`open --from` uses an existing branch; there is no `adopt` command. Direct
branch submission does not provision a worktree:

```bash
yrd bay open release-fix --from fix/release --base release/2.0
yrd pr submit fix/release --base release/2.0
```

#### Manning an Ordinary Bay

Yrd attributes an ordinary Bay to an actor but does not assign, launch, lease,
or resume that actor. The caller owns those policies. A human, Tent, or another
Hab app composes the workflow explicitly:

```bash
# Claim github:beorn/yrd#42 in the caller's issue system first.
yrd bay open fix-42 --issue github:beorn/yrd#42 --actor @agent/3

cd /path/printed/by/yrd
ag code codex --new --name @agent/3 -- "Implement github:beorn/yrd#42 and commit the result."

cd -
yrd pr submit fix-42
yrd queue run fix-42
```

Contest is different because launching comparable implementations is part of
its domain contract: `contest open` creates the bays and its configured runner
launches each competitor. If two non-Contest callers later need the same
manning lifecycle, their shared behavior can be extracted above Yrd instead of
turning actor attribution into a hidden side effect of `bay open`.

### Queue Operations

```text
yrd queue [--base <branch>] [--json]
yrd queue run [selector...] [--steps [step...]] [--watch] [--json]
yrd queue pause [base] [--json]
yrd queue pause [base] --reason <text> [--allow [pr...]] [--json]
yrd queue resume [base] [--json]
yrd queue recover [--reason <text>] [--json]
yrd queue finish <selector> [--step <name>] --job <id> --runner <runner>
  --attempt <number> --token <token> (--ok | --fail) [evidence options]
yrd queue audit [--json]
yrd queue init [base] [--json]
yrd queue deinit [base] [--json]
```

| Command   | Input                                             | Output and state                                                                        |
| --------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| bare      | Optional base                                     | One queue row per base: counts, pause, target, and oldest-open age                      |
| `run`     | Zero or more eligible PRs                         | Sole drain imperative; one pass by default, foreground supervised drain under `--watch` |
| `pause`   | Optional base; reason and allowlist to mutate     | Bare reads current pauses; with a reason, pauses new intake while active work settles   |
| `resume`  | Optional base                                     | Removes the queue pause                                                                 |
| `recover` | Optional reason                                   | Marks only work with expired runner leases lost; a no-op appends nothing                |
| `finish`  | One waiting PR/step plus job/runner/attempt/token | Records external-runner evidence and resumes that exact durable run                     |
| `audit`   | Repository                                        | Journal, projection, pinned-plan, and installed-step findings; no state change          |
| `init`    | Optional base                                     | Resolves and validates queue environment resources                                      |
| `deinit`  | Optional base                                     | Releases resources owned by the installed queue adapter                                 |

`--steps` narrows a run. Omitted means the configured default sequence. An
explicit empty `--steps` runs no steps. Re-entry is PR-owned: use `yrd pr
retry <PR-or-run>` for rejected work.

The bare dashboard shows active and recent work. `AGE` is immutable queue
lifetime—submission to terminal outcome—while `TOUCHED` is the latest state or
step event and `RUN` is execution duration. `yrd pr runs <PR>` is the canonical
drill into attempts, proofs, logs, and artifacts. `yrd queue recover` is the
public repair path for expired runner leases; it never retries or executes work.

### Issues and Contests

```text
yrd issue [--json]
yrd issue view <issue> [--json]
yrd contest open <issue> -a <harness-and-models> [--prompt <text>] [--json]
yrd contest eval <contest> [--retry] [--json]
yrd contest view <contest> [--json]
yrd contest finish <contest> [--attempt <attempt>] [--evaluator <id>]
  (--ok | --fail | --error <code>) --token <token> [evidence options]
yrd contest select <contest> --winner <attempt> [--by <actor>] [--reason <text>]
yrd contest promote <contest> [--json]
```

`-a codex/claude` uses the `ag` harness by default. An explicit harness is
separated by a space: `-a "ag codex/claude"`. Slash or comma separates
competitors.

Each competitor receives the same issue snapshot and base commit in its own bay.
Yrd records wall time, token counts, reported USD cost, stdout/stderr,
artifacts, the write-once attempt ref, and evaluator results. Missing provider
metrics remain missing; Yrd does not guess cost.

The issue surface is read-only and joins delivery facts to tracker references;
issue creation and editing remain in the tracker. `contest eval` resumes
missing competitor and evaluator work. It never
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

## Queues and Steps

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
const queue = withQueue({ steps: [check, review, merge, deploy] as const })
const contests = withContests({ runners, evaluators, git })

const base = pipe(
  createYrdDef(),
  withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
  withIssues({ sources }),
  withBays({ jobs: bayJobs }),
)

await using yrd = await createYrd(contests(queue(base)), {
  inject: { journal, scope, log },
})
```

`withQueue()` installs the ordered descriptors and exposes the fixed Job
definitions that the root installs once through `withJobs()`. Every step then
becomes state, CLI selection, events, and status evidence through the same
definition. Merge is not hardcoded pipeline policy; `withMerge()` is the typed
transition that supplies integration proof.

The default `.yrd.yml` adapter turns arbitrary shell-backed names into the same
plugins:

```yaml
base: main
batch: 8
steps: [check, coderabbit, sec-check, merge, deploy]

check: bun run test
coderabbit:
  run: launch-coderabbit
  runner: waiting
sec-check: bun run security
merge:
  run: land-candidate "$YRD_CANDIDATE_SHA"
deploy: bun run deploy

contest:
  concurrency: 2
  timeoutMs: 1800000
  evaluators: [check, sec-check]
```

Names before `merge` run against the checked candidate. Names after `merge` run
against the integrated commit. The TypeScript API enforces this statically; the
YAML adapter validates the same ordering while composing plugins.

An empty `merge: {}` uses Yrd's native Git merge. With `origin` configured,
Yrd fast-forwards the remote base directly to the exact checked Candidate; the
remote ref update is the atomic landing decision, and no checked-out local base
or operator WIP is touched. Repositories without a remote retain the local-ref
adapter for embedded/test use. The existing Queue and Job records retain the
attempt, timing, error, and landing proof for `yrd log` and `yrd pr runs`.

Native merge never amends the Candidate after checks or asks a later step to
push the base again. Its durable audit proof is the Run's integration record in
the Yrd journal, including the exact landing SHA. A direct `git push` in a
post-merge step is therefore a configuration error; ordinary publish and deploy
steps remain valid.

A configured `merge.run` delegates the landing to a repository command while
Yrd keeps queue and Run authority. The command receives `$YRD_SHA`/`$YRD_SHAS`
for submitted heads and `$YRD_CANDIDATE_SHA`/`$YRD_CANDIDATE_REF` for the exact
checked candidate. After it returns, Yrd refreshes the base branch and records
the actual landing SHA; success without a landing fails closed. The base
branch's tracked config is the single command authority; submitted revisions
cannot replace it.

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
checking unrelated PRs or Contest attempts. Queue steps and Contest evaluators
share this Job launcher contract. The remote system or an operator completes a
Queue step with:

```bash
yrd queue finish PR7 --step coderabbit --ok \
  --job "$YRD_JOB" --runner "$YRD_RUNNER" --attempt "$YRD_ATTEMPT" --token run-123 \
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
They do not require a second queue or a second queue.

Each check pins its candidate to the then-current base. Several PRs may wait on
remote work concurrently, but only one candidate can move a base branch first.
If another candidate then reaches merge, Yrd rejects its stale proof instead of
landing untested work; `yrd pr retry PR7` rebuilds and rechecks it on the new
base.

### Batching

Top-level `batch` in `.yrd.yml` is the maximum batch size and defaults to `1`. `false`, `0`, and
`1` disable batching. A value above one tests candidates together. A failing batch is recursively
bisected until Yrd identifies the failing PRs, while passing subsets continue.
Bisection is the queue plugin's fixed isolation policy, not another config axis.

Different base branches have independent queue state but share the repository's
event journal, receiver, artifacts, and configured plugins:

```bash
yrd bay open release-fix --base release/2.0
yrd bay submit --base release/2.0
yrd queue --base release/2.0
```

## State and Recovery

Yrd stores local authority under the primary worktree's common Git directory:

```text
.git/yrd/
  events-v3.jsonl    append-only authority
  writer.lock        short cross-process append lock
  prs.git/           bare PR ref/object receiver
  receiver-inbox/    crash-safe receive-hook handoff
  artifacts/         command, evaluator, and contest evidence
```

`events-v3.jsonl` is the source of truth. Each command appends one versioned,
checksummed transaction as one JSONL record, containing the Command, its cause,
its domain events, optional result value, and Job requests. Startup folds
committed records into Bay, PR, Queue, Job, and Contest state. An unterminated
final record is uncommitted and is truncated under the writer lock; malformed
newline-committed records are
reported as corruption. There is no second mutable database or read-model
cache to reconcile.

Pre-cutover `.git/yrd/events.jsonl` and `.git/bay/journal.jsonl` files remain
opaque, read-only legacy data. Yrd never decodes, migrates, appends, or rewrites
them; `yrd log --all --json` reports their paths and frame counts only as a coverage
pointer while all new authority starts in `events-v3.jsonl`. The same lossless
view includes complete typed Queue runs and every historical Job attempt, including
failed output, artifacts, lost reasons, runner identity, and integration proof.

Serialized callers may retry a stable UUIDv7 Command id; trusted adapters may
instead supply a stable dispatch key. Yrd records the Command and a canonical
intent hash in the private journal transaction. Repeating the same id or key
with the same intent returns its committed `CommandResult`; reusing it for
different arguments is refused. The Git receiver uses its receipt as a dispatch
key, so replay after a lost response cannot create a second PR revision.

Jobs are the single durable executable lifecycle: requested, running, waiting,
passed, failed, or lost. `withJobs()` installs that authority when the
application needs executable work. Queue and Contest records retain domain
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
still finish after revision drift because its token, attempt, runner, and
stable definition output contract fence that already-launched work. Queue runs
also pin their complete ordered step descriptors, so historical status remains
readable after config changes and `queue audit` reports unavailable pending
plans.

Yrd owns the Job record and imports backend lifecycle events. Running work has
an expiring, heartbeated runner lease; crashed work becomes `lost` and can be
retried. A `waiting` Job has no launcher lease and remains durable until a
token-matched finish arrives.

`yrd queue recover` expires stale running leases and reconciles already-terminal
failure facts. Recovery has no runner options and never executes requested Jobs,
creates batch-isolation work, or merges a PR; normal queue execution remains the
only path that can advance those effects.

Execution is **at least once** across crashes: a runner may perform an
external side effect before its settlement frame is committed. Yrd accepts only
one settlement for a Job attempt, but a backend must deduplicate effects by the
stable Job id and fence stale attempts. Configured commands receive `YRD_JOB`,
`YRD_ATTEMPT`, and `YRD_RUNNER` for that purpose. Yrd never guesses that a
side effect did or did not happen.

[`@yrd/core`](packages/yrd-core/README.md) documents Commands, Events,
projection, and the private Journal transaction contract. [`@yrd/job`](packages/yrd-job/README.md)
documents Job states, leases, waiting work, retries, and backend idempotency.

`prs.git` is a Git object/ref receiver, not the state store. Its pre-receive
hook validates updates; its post-receive hook leaves an atomic receipt that is
deduplicated with the PR intake event. The inbox exists only for crash recovery.
The `bay` receiver is a push default only inside provisioned Work Bays. Host
startup removes the legacy shared `remote.pushDefault=bay` setting if present,
so plain `git push` in the primary worktree continues to use its normal remote.

## Integration Boundaries

- **km** supplies tracker-neutral issue snapshots through a issue-source adapter.
- **ag** runs contest competitors and supplies provider/harness evidence.
- **Hab** may host Yrd as a service; Yrd does not import habitat policy.
- **GitHub** can adapt issues to issues and checks/reviews/merge to queue steps.
- **Tent** may configure Yrd for a fleet, but fleet policy stays outside Yrd.

The low-level packages remain usable by a single developer with no agent fleet.

## Packages

| Package            | Responsibility                                                   |
| ------------------ | ---------------------------------------------------------------- |
| `@yrd/core`        | Immutable definition, Commands, Events, projection, Journal      |
| `@yrd/persistence` | Checksummed JSONL Journal and cross-process append exclusion     |
| `@yrd/process`     | Scope-owned subprocess execution, bounds, cancellation, evidence |
| `@yrd/job`         | Durable executable lifecycle, leases, waiting work, recovery     |
| `@yrd/issue`       | Issue references, snapshots, and source adapters                 |
| `@yrd/bay`         | Work bays, PR intake, Git workspace, and receive hooks           |
| `@yrd/queue`       | Typed steps, merge proof, waiting jobs, batching, and status     |
| `@yrd/contest`     | Competitors, evaluators, selection, metrics, exact promotion     |
| `@yrd/cli`         | `yrd`, `git-yrd`, and `git-bay` command projections              |

The app is composed from `with*` plugins. Consumers can replace issue sources,
Git workspace adapters, step runners, evaluators, Git resolution, and queue
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
