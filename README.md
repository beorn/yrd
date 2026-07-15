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

Every command accepts one global repository selector. `--repo <path>` (or
`YRD_REPO`) selects the Git repository, its `.yrd.yml`, durable Yrd state, and
operation root. Selecting a linked worktree preserves its current-bay and
current-branch behavior while config and state still resolve through the shared
repository authority. The CLI value overrides the environment value, which
overrides discovery from the caller's directory. Relative values resolve
against that one original caller directory.

```console
$ yrd --repo /work/my-repository/.bays/B1 pr status --json
```

The selector is global and may also follow a subcommand. `.yrd.yml` remains the
only configuration path; there is no separate `--cwd`, `--config`, or `--root`
surface.

```console
$ cd my-repository
$ yrd bay open fix-release
BAY  STATUS  BRANCH             BASE  PATH
B1   active  issue/fix-release  main  /work/my-repository/.bays/B1

$ cd /work/my-repository/.bays/B1
$ ...edit and test...
$ git commit -am "fix: release ordering"

$ yrd pr submit --follow --correlation tribe-request:req-42
PR   STATUS     BRANCH             BASE  REV  HEAD
PR1  submitted  issue/fix-release  main  1    a13f09b1c821

$ yrd queue run PR1
RUN  PRS  STATE   STEPS
R2   PR1  passed  merge=passed

$ yrd
main@91803b2137d8 OPEN 0 ACTIVE 0 INTEGRATED 1 REJECTED 0

$ yrd bay close
BAY  STATUS  BRANCH             BASE  PATH
B1   closed  issue/fix-release  main  /work/my-repository/.bays/B1
```

Plain PR submit is a handoff: it schedules checks and returns, while an
integrator follows the same journaled Queue run and drains integration:

```console
$ yrd pr submit
PR     STATUS       BRANCH                 BASE    REV    HEAD
PR2    submitted    issue/another-fix      main      1    b7144cc7d201

$ yrd pr checks PR2 --follow
$ yrd queue run PR2
RUN     PRS             STATE       STEPS
R2      PR2              passed      check=passed merge=passed
```

For a review-gated repository, the PR-native flow admits checks before the
revision is queueable:

```console
$ yrd pr submit issue/another-fix --draft --correlation tribe-request:review-42
$ yrd pr review PR2 --approve --by @cto --ref verdict-42
$ yrd pr ready PR2
$ yrd pr checks PR2 --follow
```

`--draft` is the existing `pushed` state, not a second flag or status. It only
registers the immutable revision: no check request, admission, or Queue work is
started until `pr ready` (ordinary reviewed work) or `pr recut --queue`
(authored-root carriers). Review and comment facts pin the current revision and
head SHA; a new head makes old verdicts visibly stale. Reviewer assignment and
richer policy belong to the calling coordination system.

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
                            status, edit, checks, regression, close, and merge teaching
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
yrd bay submit [selector...] [--draft] [--base <branch>]
  [--correlation <namespace:id>] [--composition <path>] [--json]
yrd bay close [selector...] [--withdraw] [--json]
```

The same commands are available through the standalone `git bay` projection.
`bay submit` is permanent cross-product vocabulary and delegates to the same
submission core as `pr submit`; `bay submit` remains a handoff, while new
callers use the PR-native check-admission surface below.

| Command   | Input                                                 | Output and state                                                                                   |
| --------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `open`    | New bay name; optional source, base, issue, and actor | Prints the worktree path; creates and provisions a named bay                                       |
| `refresh` | Zero or more bays                                     | Refreshes Git head, base, dirty, path, and workspace status                                        |
| `submit`  | Bays, PRs, or source branches; optional `--draft`     | Creates or advances PRs to `submitted`, or only `pushed` with `--draft`; never executes Queue work |
| `close`   | Zero or more bays                                     | Deprovisions clean terminal bays; `--withdraw` explicitly cancels a live PR                        |

`--head` is an alias for `--from`. `--queue` is an alias for `--base`. The
canonical words are source branch (`--from`) and base branch (`--base`).

`--issue` stores an opaque tracker-neutral reference such as `km:@yrd/core/42`
or `github:beorn/yrd#42`. `--actor` records the worker or implementation
identity. Yrd preserves these links but does not import tracker lifecycle or
fleet policy. Actor attribution does not launch a process; an explicit composed
runner, such as Contest's `ag` runner, mans the Bay.

`open --from` uses an existing branch; there is no `adopt` command. Direct
branch submission does not provision a worktree:

```bash
yrd bay open release-fix --from fix/release --base release/2.0
yrd pr submit fix/release --base release/2.0 --correlation tribe-request:req-42
```

Both submission surfaces accept `--correlation <namespace:id>`. The namespace
and opaque id bind to the exact PR revision and remain on its terminal facts;
rebinding a live PR to a different correlation is refused.

### PR Eligibility and Checks

```text
yrd pr submit [selector...] [--draft] [--follow] [--base <branch>]
  [--correlation <namespace:id>] [--json]
yrd pr list [--needs-review] [--json]
yrd pr recut <selector> [--revision <number>] [--queue] [--json]
yrd pr ready <selector> [--json]
yrd pr review <selector> (--approve | --reject)
  [--by <actor>] [--ref <id>] [--note <text>] [--json]
yrd pr comment <selector> --note <text> [--by <actor>] [--ref <id>] [--json]
yrd pr checks <selector...> [--follow] [--json]
yrd pr close [selector...] [--json]
```

Plain `pr submit` appends the revision, records a check request, schedules the
configured pre-merge Queue steps, and returns. `--draft` instead registers only
the pushed revision and returns without requesting checks or admitting a Run.
`pr ready` requests and admits configured checks for an ordinary draft.
`--follow` stays attached to the same journaled Run. `pr checks` renders the
same typed evidence in human or newline-delimited JSON output, including
command argv, concise diagnostics, base-versus-carrier classification, and
artifact paths.

`pr recut` fetches the authoritative base internally and records a mechanically
equivalent, certificate-bearing successor on the same PR. `--revision` selects
an older immutable revision; its correlation and approved-review provenance
follow that selected payload. When submission recorded authority newer than
the source branch, recut derives exactly one source merge base and refuses
ambiguous lineage. A pin-only carrier that already has the authoritative parent
still receives a successor revision with the derived patch/tree certificate.
`--queue` readies and admits only that certified revision's fresh checks. List,
detail, and watch output retain the recut lineage and cumulative source-ready
age while reporting the successor revision's queue wait separately.

For a human-authored root carrier, use the machine-owned path rather than
attaching a composition manifest:

```bash
yrd pr submit <branch> --draft
yrd pr recut <PR> --queue
```

The Queue is the only scheduler. Its journaled passed Run is also the cache:
integration reuses matching carrier-classified pre-merge work only when
resolved base SHA, head SHA, installed-step revision/config, and toolchain
fingerprint all match. Base-classified admission steps always rerun before
integration, so a later same-base red lock cannot reuse an earlier green fact.
There is no TTL, invalidation database, or second workflow engine.

### Composed Source Payloads

`--composition` submits an immutable version-1 JSON source manifest for one
selector. It is the source-only path for submodule work: the selected root
branch contains no root changes, and Yrd Queue generates the root gitlink
wrapper as the checked Candidate.

```json
{
  "version": 1,
  "sources": [
    {
      "repo": "vendor/example",
      "branch": "issue/fix",
      "baseSha": "0123456789abcdef0123456789abcdef01234567",
      "tipSha": "89abcdef0123456789abcdef0123456789abcdef",
      "payload": ["src/fix.ts", "tests/fix.test.ts"]
    }
  ]
}
```

Repository and payload paths are normalized, repository-relative, sorted, and
unique. Candidate preparation proves the declared source diff exactly matches
`payload`, including blob, mode, status, and path identity. A generated
successor must also retain the source's stable `patch-id` and produce only `=`
rows from `git range-diff`; either proof failing rejects the Candidate before
publication. When current main pins a descendant of `baseSha`, Yrd restacks
only if the upstream and payload path sets are disjoint; overlaps and Git
conflicts fail with exact paths. Each rewritten tip is published at
`refs/heads/yrd/candidates/<new-tip-sha>` before the generated root wrapper can
land. The Queue receipt retains that immutable ref, patch ID, `rangeDiff: "="`,
and the old/new base and tip SHAs; ref loss during a remote landing fails closed
and rolls the root branch back.

Human-authored gitlink commits are refused by default. The normal path is the
draft-to-recut workflow above; `YRD_ALLOW_AUTHORED_GITLINKS=1` is break-glass
only for a legacy carrier and does not weaken Candidate pinning or exact
landing.

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
yrd pr submit fix-42 --follow
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
explicit empty `--steps` runs no steps. Re-entry is PR-owner-authorized: inspect
rejected work with `yrd pr runs <PR>`, fix its source branch, then run `yrd pr
submit <branch>` again. That appends a fresh revision and records submit and
check authority for its exact head; check admission consumes the check fact,
and an integrating Queue run consumes the submit fact. Queue commands cannot
mint or refresh either authority.

To stop a resident `queue run --watch`, send `SIGINT` (Ctrl-C) or `SIGTERM`.
The first signal stops new admission, lets the active run finish, and exits with
that run's result; an idle runner exits cleanly. Send either signal again to
force the existing hard shutdown and job-tree reap.

A resident acquires one OS-held lease in the repository's common Yrd state
before receiver intake or Queue admission. A second resident exits with the
typed `resident-runner-active` refusal and identifies the active
`yrd-cli:<pid>` executor. Job events retain that executor id; trace logs add
host and available Herdr/cmux pane provenance. Normal exit and graceful
shutdown release the lease, while the OS releases it if the owner dies.

An explicit non-empty selection is durable Run authority, not a filter applied
after configured admission. Yrd neither starts nor reuses omitted configured
checks. In particular, `--steps merge` prepares and pins a fresh candidate with
the built-in repository, ancestry, lease, and remote-update safeguards; human
and JSON output record every configured omission as `skipped` with reason
`not-selected`, distinct from an unconfigured or selected-but-not-yet-reached
step.

The bare dashboard shows active and recent work. `AGE` is immutable queue
lifetime—submission to terminal outcome—while `TOUCHED` is the latest state or
step event and `RUN` is execution duration. `yrd pr runs <PR>` is the canonical
drill into attempts, proofs, logs, and artifacts. `yrd queue recover` is the
public repair path for expired runner leases; it never retries or executes work.

### Issues and Contests

```text
yrd issue [--json]
yrd issue view <issue> [--json]
yrd migrate terminal-associations [--apply] [--json]
yrd pr regression <pr> --run <run> --detected-at <timestamp>
  --severity <level> --evidence <ref> --implementation-run <ref>
  --review <ref> --repair-pr <pr> --repair-run <run> [--json]
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
issue creation and editing remain in the tracker. `yrd issue --json` and `yrd
pr runs --json` include the same versioned `trackerBridge` projection. Each
delivery carries the exact opaque `issueRef`, PR revision/head, native status,
terminal Queue run, and one journal `asOf` cursor; integrated deliveries alone
carry `landingSha`. Rejected deliveries carry their typed bounce run. Canceled
and withdrawn are distinct terminal outcomes.

`yrd migrate terminal-associations` is the explicit compatibility cutover for
legacy rejected-PR events that predate the typed Queue run field. Its default
dry-run lists every unassociated terminal, either with one revision/head-bound
failed-run proof or with a typed refusal such as missing, chronology-invalid,
or ambiguous candidates. `--apply` appends one `pr/terminal-associated` event
for each uniquely proven row and leaves every refused row untouched. It never
rewrites JSONL, fabricates a run, or weakens new `pr/rejected` events; repeating
`--apply` after the proven rows land appends nothing.

`pr regression` records a completed repair without rewriting either integration.
It accepts only the exact original and repair Queue runs named by their terminal
journal facts, and preserves detection time, severity, evidence, opaque
implementation/review provenance, both issue/PR/run identities, and both landing
SHAs. Consumers may derive flow metrics from this join; Yrd does not add a
telemetry store or interpret opaque provenance.

The bridge contract is the journal plus JSON data, not a tracker plugin
registry. Independent consumers checkpoint `trackerBridge.asOf.cursor` and
write projections into their own tracker. References such as `@km/...`,
`gh:1234`, and `JIRA-123` stay opaque to Yrd.

`contest eval` resumes
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

requires: [review]

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

notify:
  pr/rejected: [submitter]
  pr/needs-review: ["@cto"]
  pr/integrated: [broadcast]
  run/failed: [submitter, "@ci"]
```

Names before `merge` run against the pinned Candidate. Names after `merge` run
against the integrated commit. The TypeScript API enforces this statically; the
YAML adapter validates the same ordering while composing plugins.
Object-form steps may declare `classification: base` when their evidence is
about the resolved base rather than the submitted carrier; all other steps
default to `carrier`. The classification is part of the installed-step cache
identity and appears in typed check evidence.
`requires: [review]` is the only built-in review policy: the latest verdict for
the current revision must approve. Comments never gate, and omitting
`requires` leaves reviews informational.

### PR Signals

`notify` routes an enumerated journal transition without turning delivery into
a Queue step. `pr/rejected`, `pr/needs-review`, and `run/failed` are tracked
requests: `submitter` resolves to the actor recorded on the exact PR revision,
while an explicit `@name` routes to that Tribe member. Rejection carries the PR,
revision, failed step, Run, and evidence path; needs-review is projected from a
committed submission only when `requires: [review]`; Run failure names every
affected PR. `pr/integrated: [broadcast]` aggregates all PRs sharing one landing
fact into one ambient `yrd:integrated` notification and wakes nobody. It also
closes the deterministic rejected/review request ids for those PR revisions.

Signal delivery starts only after the journal append commits and never blocks
the Run. A cursor under `.git/yrd/notifications/` records journal progress and
successful event-id/recipient sends and terminal unsubscribe actions. Startup
replays an append that preceded a crash and skips actions already recorded in
that cursor. Delivery remains
at-least-once across the unavoidable external-send/local-record crash window;
the event id is included in every request so recipients can identify a replay.
The cursor is recovery bookkeeping, not another event store or scheduler.

Configuration is closed-world: an unknown event name, malformed target, or
missing Tribe executable refuses startup instead of becoming an inert label.
Routing to `submitter` also requires `TRIBE_NAME` to identify the current
submitting `@` handle at startup. A needs-review route without
`requires: [review]` is rejected rather than stored as an inert label.
Historical rejections written before the routable fact shape remain replayable
but are not retroactively delivered. If a pre-actor revision is rejected after
upgrade, its unavailable submitter is logged and skipped without starving later
signals.

An empty `merge: {}` uses Yrd's native Git merge. With `origin` configured,
Yrd fast-forwards the remote base directly to the exact pinned Candidate; the
remote ref update is the atomic landing decision, and no checked-out local base
or operator WIP is touched. Repositories without a remote retain the local-ref
adapter for embedded/test use. The existing Queue and Job records retain the
attempt, timing, error, and landing proof for `yrd log` and `yrd pr runs`.

Native merge never amends the Candidate after preparation and any selected
checks or asks a later step to push the base again. Its durable audit proof is
the Run's integration record in the Yrd journal, including the exact landing
SHA. A direct `git push` in a post-merge step is therefore a configuration
error; ordinary publish and deploy steps remain valid.

A configured `merge.run` delegates the landing to a repository command while
Yrd keeps queue and Run authority. The command receives `$YRD_SHA`/`$YRD_SHAS`
for submitted heads and `$YRD_CANDIDATE_SHA`/`$YRD_CANDIDATE_REF` for the exact
pinned Candidate. After it returns, Yrd refreshes the base branch and records
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
landing untested work. The PR owner inspects the rejected run, fixes the source
branch if needed, and submits that branch again; the new revision gets fresh
submit and check authority and is rebuilt and rechecked against the new base.

### Batching

Top-level `batch` in `.yrd.yml` is the maximum batch size and defaults to `1`. `false`, `0`, and
`1` disable batching. A value above one tests candidates together. A failing batch is recursively
bisected until Yrd identifies the failing PRs, while passing subsets continue.
Bisection is the queue plugin's fixed isolation policy, not another config axis.

Different base branches have independent queue state but share the repository's
event journal, receiver, artifacts, and configured plugins:

```bash
yrd bay open release-fix --base release/2.0
yrd bay submit --base release/2.0 --correlation tribe-request:release-2.0
yrd queue --base release/2.0
```

## State and Recovery

Yrd stores local authority under the primary worktree's common Git directory:

```text
.git/yrd/
  events-v3.jsonl    append-only authority
  writer.lock        short cross-process append lock
  resident-runner/
    writer.lock      process-lifetime resident Queue lease
  prs.git/           bare PR ref/object receiver
  receiver-inbox/    crash-safe receive-hook handoff
  artifacts/         command, evaluator, and contest evidence
  notifications/
    cursor-v1.json    journal cursor plus successful event-recipient sends
```

`events-v3.jsonl` is the source of truth. Each command appends one versioned,
checksummed transaction as one JSONL record, containing the Command, its cause,
its domain events, optional result value, and Job requests. Startup folds
committed records into Bay, PR, Queue, Job, and Contest state. An unterminated
final record is uncommitted and is truncated under the writer lock; malformed
newline-committed records are
reported as corruption. There is no second mutable database or read-model
cache to reconcile.

New terminal PR facts are revision/head-bound. Queue terminals also name their
exact Run; integration facts expose `landingSha`, which must equal the
`IntegrationProof.commit`. Historical payloads accepted by a replay-only schema
remain readable, but the current append schema is never widened for them.

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
