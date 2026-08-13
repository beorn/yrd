<!-- README-as-spec: this document describes the intended shipped state as present fact. Open gaps are acceptance work in TODO.md. -->

# Yrd

**Sovereign software delivery for agent teams.**

**Agents are fast!** Unleash 100 on one machine. What could go wrong?

- **GitHub feels like the DMV.** Agents wait in a remote CI queue you don't control.
- **Your machine melts.** Unmanaged local test runs max every core.
- **Git throws up its hands.** Many agents, one repo: lock fights, racing merges, half-landed features.
- **So much software.** Repos grow big and plentiful, and you'll want to vendor more. You need a [**superproject**](#superprojects), a repo of repos.

Yrd runs the whole delivery loop on your machine, where the agents are: PRs, CI, merge queue, review. GitHub becomes optional: code storage (how we use it), human review, or gone. Extracted from a working superproject where an agent fleet ships daily, supervised by one human.

## The yard

The **yard** — hence the name — is the **queue runner** that builds and integrates every change: a [Bors-style](https://bors.tech) merge queue, running on your own machine.

- Work flows from tracker issues — issues in, proven merges out — so any agentic system can drive Yrd. Trackers, forges, and judges are pluggable — bring your own.
- **Contests** compare independently produced implementations of real issues,
  retain their evidence, and promote an explicitly selected result.
- Every merge is proven — tested in a clean worktree, on the exact commit that ships, with a permanent receipt — written as standard git trailers and refs, so plain `git log` can read it. Under load, merges batch optimistically and a red batch **bisects** to the culprit. Merges span repos, too — see [Superprojects](#superprojects).
- **Git-compatible at the git layer.** Change identity is a standard commit trailer, submission is a plain ref push, queue metadata lives in git refs, and the repo itself is the durable record — any tool that reads git finds nothing surprising, plain `git log` answers “did this land?”, and moving to hosted review someday is a mechanical import, not a rewrite. Compatibility ends at the git layer: Yrd speaks no forge’s API and imports no forge’s review process.
- Agents drive everything from a scriptable CLI; humans get a live TUI. Checks are your own commands, not a workflow DSL — Yrd encodes no process, so who reviews, and when, stays yours.

## Superprojects

A Git superproject is built on plain Git submodules — which in theory lets you treat a set of repos as one big virtual monorepo. In practice the tooling was missing. Yrd ships it — `git super` takes all the pain out:

- **Super PRs** group one feature's branches across repos.
- **Super worktrees** check out the whole product, every submodule at its exact commit.
- **Super CI** tests the exact commit that would ship.
- **Super merges** run children first, the superproject pointer last. It never points at half a feature.

A submodule with `branch = <name>` in `.gitmodules` is **tracked**: as the upstream branch advances, Yrd refreshes the tracked super PR with the new pin — proposing, never merging. Merges only happen through the queue.

`git super` is the standalone face of the same core — plumbing without the resident queue; the guarantees come from the yard.

**Assemble → test → merge → roll** — the queue is the only merger.

## The model — five objects, one pipeline

```text
issue -> bay -> pr -> queue -> merged
          ^      ^
          +-- contest (competing implementations; winner promotes to a PR)
```

- **issue** — what you deliver. It lives in your tracker; yrd stores only the
  reference. The tracker holds the pen; yrd owns the lens.
- **bay** — where you work: an isolated Git workspace reached through the
  `yrd bay` subtree. Bay lifecycle is not a standalone product surface.
- **pr** — the submitted change: a branch@head with numbered revisions. Review
  happens upstream; a yrd PR is the queue's unit.
- **queue** — one per base branch. It verifies and merges PRs serially and can
  pause new runs, including retries, without killing active work.
- **contest** — several implementations of one issue, evaluated against the
  same pin; the selected winner promotes to a PR.

Runs, steps, jobs, attempts, and the runners that execute them are evidence
inside PRs and the log, not top-level objects to manage.

yrd is gh-shaped, not gh-scoped: its noun and aspect-verb grammar makes `gh`
muscle memory transfer, while its scope is deliberately one slice of the forge:
delivery. It composes reusable `git-super` mechanics with the merge queue while
Hab owns bay lifecycle. Two deliberate absences define the boundary: `yrd pr
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

| Unmanaged state           | Yrd state                                        |
| ------------------------- | ------------------------------------------------ |
| dirty worktree            | active bay, not submit-ready                     |
| ahead branch              | pushed, submitted, or ready PR                   |
| branch needing repair     | draft PR plus `bay open --pr <PR>`               |
| external CI still running | waiting queue step with URL and token            |
| author-owned failure      | needs-author PR with typed receipt               |
| unattributed rejection    | rejected PR with evidence                        |
| completed work            | integrated or already-landed PR and closable bay |

Yrd does not invent commits or silently discard work. It prevents ambiguous WIP
by making the normal workflow create named bays and durable PRs from the start.

## Prior art

Yrd stands on conventions proven at scale, and adopts them at the git layer
rather than reimplementing the systems around them:

- **[Gerrit](https://www.gerritcodereview.com/)** — change identity as a
  commit trailer (`Change-Id:`), submission as a plain push to a
  `refs/for/`-style namespace, patch-set versioning so a moved branch never
  goes stale, and [NoteDb](https://gerrit-review.googlesource.com/Documentation/note-db.html)'s
  doctrine that review metadata lives in git refs — backup is repo backup, and
  every index is rebuildable. Yrd adopts these as wire conventions; it does not
  speak Gerrit's API or import its review process.
- **[Bors](https://bors.tech) / merge queues** — the queue is the only merger:
  candidates are tested on the exact commit that ships, batched optimistically,
  and bisected on failure. [Zuul](https://zuul-ci.org/) and GitLab merge trains
  prove the speculative form: gate against the projected post-merge state, not
  live trunk.
- **[git-appraise](https://github.com/google/git-appraise)** — Google's
  distributed review system with no server at all: reviews, robot comments, and
  CI results live as JSON in `refs/notes/devtools/*`. Independent proof that a
  delivery system's records can live entirely inside the repository — the same
  shape as Yrd's receipts.
- **Lockfile ecosystems** (Cargo, npm, Android's repo manifest) — the
  coordinating pointer is an _output_ synthesized from declared inputs, never
  hand-authored; conflicts resolve by regeneration. Yrd's superproject pins
  follow the same rule.

The test this buys: **a tool that only reads git — log, trailers, refs — finds
nothing surprising in a Yrd repo.**

## Quick Start

The CLI initializes `.git/yrd/` on the first repository-backed command. Help is
repository-independent and never creates Yrd state.

Every command accepts one global repository selector. `--repo <path>` (or
`YRD_REPO`) selects the Git repository, durable Yrd state, and operation root.
Selecting a linked worktree preserves its current-bay and current-branch
behavior while config and state still resolve through the shared repository
authority. The CLI value overrides the environment value, which overrides
discovery from the caller's directory. Relative values resolve against that one
original caller directory.

```console
$ yrd --repo /work/my-repository/.bays/B1 pr status --json
```

The selector is global and may also follow a subcommand. Repository config is
the base branch's `.yrd.yml`. `--config <path>` selects another base-relative
`.yml` or `.yaml` authority; candidate content can never override it. There is
no separate `--cwd` or `--root` surface.

```console
$ cd my-repository
$ yrd bay run --bay fix-release -- task-runner fix-release
bay fix-release → new task/fix-release, no issue linked
closed fix-release

$ yrd pr create task/fix-release
$ yrd pr ready PR1
$ yrd pr checks PR1 --follow
```

`bay open` creates a persistent Bay and returns. `bay run` owns the scoped
foreground lifecycle: provision, run the exact child argv (or `$SHELL` by
default), checkpoint, push, and close. `--keep` leaves a successful run open.
A failed or interrupted child preserves the Bay as an orphan for diagnosis.
Use `yrd in` for a guest process in an already-open Bay.

Plain PR submit first runs the configured checks in the submitting working tree,
then records the authoritative check request and returns. The resident Queue
runs the same checks again against the exact Candidate before it merges:

```console
$ yrd pr submit
PR     STATUS       BRANCH                 BASE    REV    HEAD
PR2    submitted    issue/another-fix      main      1    b7144cc7d201

$ yrd pr checks PR2 --follow
$ yrd queue run PR2
RUN     PRS             STATE       STEPS
R2      PR2              passed      check=passed merge=passed
```

For a review-gated repository, `pr ready` records the authoritative check
request after review approves the current revision:

```console
$ yrd pr create issue/another-fix --correlation tribe-request:review-42
$ yrd pr review PR2 --approve --by @cto --ref verdict-42
$ yrd pr ready PR2
$ yrd pr checks PR2 --follow
```

`pr create` records the existing `pushed` state: no submission, check request,
or Queue work is started until `pr ready` (ordinary reviewed work)
or `pr recut --queue` (authored-root carriers). `pr create` does not push a Git
branch; callers push first, then create the draft from that exact resolvable
commit. `issue ensure` is the issue-first composition of those Git-side facts:
it creates or reuses one clean issue-owned Bay and one tracked draft PR.
`bay open` and `bay run` otherwise create or reuse `task/<issue-slug>`, but
never create or recut a PR implicitly. `bay run` and explicit `bay close` push
recoverable checkpoints. Review and comment facts pin the current revision and
head SHA; a new head makes old verdicts visibly stale. Reviewer assignment and
richer policy belong to the calling coordination system.

When an author intentionally has no Git credentials, `yrd pr publish <PR>
--queue` records one durable `pr.publish` Job instead of lending credentials to
the author process. The existing Queue runner publishes the immutable component
pins and root carrier, then performs the requested recut-and-queue continuation.
`yrd queue run --once` performs this publication work before its ordinary queue
pass; resident follow mode uses the same path. If neither runner form is active,
the Job remains `publication-required` and `pr list` / `pr view` identify both
the waiting Job and the exact `queue run --once` remedy. A terminal push error
remains visible as `publication-failed`; repeating the identical `pr publish`
request retries that same Job and preserves its correlation. Publication pushes
originate in fresh staging repositories so hooks from the author's checkout do
not inherit runner authority.

During development in this repository:

```bash
bun yrd --help
bun yrd
bun yrd pr runs PR1

# Open a persistent Bay, enter it, then close it explicitly:
yrd bay open --bay example
cd "$(yrd bay path example)"
yrd bay close example

# One scoped foreground child with synchronous checkpoint and cleanup:
yrd bay run @tracker/fix-release -- vi README.md

# Continue an existing delivery branch without implicitly recutting its PR:
yrd bay run --pr task/fix-release -- vi README.md

# One guest in the owner's existing Bay; from inside that Bay, omit the selector:
yrd in fix-release -- make test
yrd in

# Ensure the durable Git-side workspace and tracked draft without launching a process:
yrd issue ensure @tracker/fix-release

# Run $SHELL in a scoped scratch Bay:
yrd sh --bay scratch
```

Installed binaries are `yrd` and `git-yrd`. Bay commands live under `yrd bay`.

On a clean child exit, `bay run` commits root-worktree changes as
`wip: <issue-or-bay>`, pushes the same task branch, and removes the Bay before
returning. `bay open` instead leaves the Bay active until `bay close`. Neither
path creates a PR or Queue record; use `pr create` explicitly, or `--pr
<selector>` to continue an existing PR's branch without recutting it. A
non-zero or abnormal `bay run` child leaves the workspace open and records a
durable `orphan` fact visible through `yrd bay list --json`. Dirty submodules
are never guessed into a publication: checkpointing fails loudly and preserves
the Bay.

A provision failure that never records a workspace path ends immediately as
`closed-degenerate`: there is no workspace to deprovision, and the branch name
is reusable. `yrd admin bay prune` is dry-run by default; `--apply` closes only
the `PRUNE` set. Its JSON conservation report puts every examined Bay in
exactly one of `outcomes.pruned`, `outcomes.kept`, or `outcomes.paged` and
counts the same population in `histogram`. An apply that examines Bays but
prunes none exits non-zero, as does any report with missing-evidence pages.

`bay in` (also spelled root `yrd in`) attaches a guest process without opening,
checkpointing, closing, or otherwise taking ownership of the Bay lifecycle.
`bay open` takes no command; `bay run` and `bay in` default to `$SHELL`.
Top-level `yrd run` acts on queue-run records, while `yrd sh` selects `$SHELL`.
`in` defaults to `$SHELL`; any child command is opaque argv and must follow
`--`. Guests receive no Hab or Tribe identity from Yrd. Guests never close the
owner; the inverse remains strict too—owner close reaps every guest still
holding the Bay.

An open config is explicit and deterministic. A positional config is always an
issue reference; `--issue` is its named alias and the two cannot be combined.
Use `--bay` for an issue-less friendly Bay name and `--pr` only to continue an
existing PR branch. Resolution has three product nouns:

| Noun  | Resolution order                                          |
| ----- | --------------------------------------------------------- |
| issue | `--issue`, then the positional config                     |
| PR    | `--pr`, then the issue's live PR, then a generated branch |
| Bay   | `--bay`, then the positional config, then the PR          |

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

State-oriented public verbs accept `--json` and return an invoked-command
discriminator such as `pr.submit`, `pr.status`, or `queue.run`. The foreground
`bay run`/`bay in` bracket is the deliberate exception: it streams the child's stdio
unchanged and returns success only when both the child and bracket complete
cleanly. Human output uses Silvery tables, semantic status color, and OSC 8
links for paths, logs, and artifacts.

Delivery objects expose one canonical `status` (or attempt `outcome`) in human
and JSON output. When a compatibility-era stored status cannot express that
state, JSON also names it as `nativeStatus`; consumers act on canonical
`status`. The additive cross-domain fields are `taskStatus` and `glyph`;
changing the domain vocabulary does not change this five-state contract:

- `state` — answers: is the PR record open or closed? tense: current.
- `status` — answers: what delivery result should a reader act on? tense: current.
- `nativeStatus` — answers: what delivery status did the rebuildable index record? tense: historical.
- `taskStatus` — answers: how does this delivery map to the shared work-state vocabulary? tense: current.
- `eligibility.reason.code` — answers: why can the current revision not run now? tense: current.
- `landedOnBase.code` — answers: why did repository proof override `nativeStatus`? tense: current.
- `--state needs-author` — answers: has this PR ever needed author action? tense: historical. It is a sticky
  fact, not a claim that a closed delivery currently awaits its author.

| `taskStatus` | Glyph | PR                        | Run                 | Job attempt            | Step    |
| ------------ | ----- | ------------------------- | ------------------- | ---------------------- | ------- |
| `todo`       | `[ ]` | pushed                    | queued              | requested              | pending |
| `wip`        | `[/]` | submitted                 | running or waiting  | started                | running |
| `blocked`    | `[!]` | needs-author/rejected     | failed              | failed or lost         | failed  |
| `done`       | `[x]` | integrated/already-landed | passed              | passed                 | passed  |
| `dropped`    | `[-]` | withdrawn or canceled     | retired or canceled | superseded or canceled | skipped |

The read-only issue lens derives the same projection from its joined PR and
Contest facts. A blocked child wins, then active work, then todo work; an issue
whose remaining children are terminal is done when any landed result remains,
otherwise dropped. Colors follow the projected state, while native labels stay
visible for diagnosis.

The top-level surface is deliberately small:

```text
yrd                         dashboard across queues, PRs, and recent outcomes
yrd in                     attach a PID-addressed guest to an existing Bay
yrd run                    act on individual queue runs
yrd sh                     run $SHELL in a scoped Bay
yrd pr                      list PRs; create, submit, view, runs, diff, checkout,
                            status, edit, checks, regression, close, and merge teaching
yrd bay                     list bays; open, run, in, path, refresh, submit, and close
yrd issue                   issue list/view plus Bay + tracked-draft ensure
yrd contest                 list; open, eval, view, finish, select, promote
yrd queue                   render the queue timeline by default; list/ls is canonical;
                            run, cancel, pause, resume, recover, finish, init, deinit, audit
yrd log                     terminal queue history; --all adds lossless records
yrd watch                   thin alias for yrd queue list --watch
yrd prime                   delivery briefing plus current context
```

### Bay Operations

```text
yrd bay list [--closed | --all] [--json]
yrd bay open [<issue>] [--issue <issue>] [--pr <selector>] [--bay <name>]
yrd bay run [<issue>] [--issue <issue>] [--pr <selector>] [--bay <name>]
  [--keep] [-- <command...>]
yrd bay in [<bay>] [-- <command...>]
yrd in [<bay>] [-- <command...>]
yrd sh [<issue>] [--issue <issue>] [--pr <selector>] [--bay <name>]
  [--keep]
yrd bay path <selector> [--json]
yrd bay refresh [selector...] [--json]
yrd bay submit [selector...] [--base <branch>]
  [--correlation <namespace:id>] [--composition <path>] [--json]
yrd bay close [selector...] [--withdraw] [--json]
```

`yrd bay list` shows open and in-progress Bays by default. Use `--closed` for
terminal history or `--all` for both. List status uses the shared lifecycle
projection: `open` (blue), `working`, `done`, or `fail`; JSON preserves the
persisted Bay value in `nativeStatus`.

Queue-run records remain a separate object:

```text
yrd run cancel <selector> [--reason <text>] [--json]
```

`bay submit` is permanent cross-product vocabulary and delegates to the same
submission core as `pr submit`; `bay submit` remains a handoff, while new
callers use the PR-native required-check surface below.

| Command   | Input                                        | Output and state                                                                                                                                                      |
| --------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`    | None                                         | Lists `BAY STATUS ISSUE BY BASE BRANCH`, including durable failure and orphan facts                                                                                   |
| `open`    | Issue, `--issue`, `--pr`, or `--bay`         | Provisions a persistent Bay and returns; never runs a command or creates a PR                                                                                         |
| `run`     | Opener configuration plus exact argv         | Owns the scoped bracket, checkpoints, and closes; `--keep` preserves a clean success                                                                                  |
| `in`      | Bay selector; optional exact argv after `--` | Attaches a PID-addressed lifecycle guest; never owns configuration or closure                                                                                         |
| `path`    | One Bay ID, name, or branch selector         | Prints the exact absolute path of one active Bay; read-only and never refreshes it                                                                                    |
| `refresh` | Zero or more bays                            | Re-reads Git head, base, dirty, path, and workspace status                                                                                                            |
| `submit`  | Bays, PRs, or source branches                | Creates or advances PRs to `submitted`; never executes Queue work                                                                                                     |
| `close`   | Zero or more bays                            | Reaps and verifies processes holding each Bay, then checkpoints and deprovisions it; survivor PIDs fail loudly. `--withdraw` explicitly cancels an associated live PR |

#### Process launch boundary

Yrd owns Git-side delivery: issue resolution, Bays, draft PR identity, recuts, and
serialized landing. Agent selection, launch, supervision, and retry belong to the
launcher. A launcher can compose `hab run` with `yrd issue ensure` and the
ordinary PR/Queue verbs without putting agent policy in Yrd or `.yrd.yml`.

Submodule repositories are ready when `bay open` returns and before a `bay run`
child starts. Yrd
recursively materializes the recorded gitlinks while keeping each Bay's refs,
config, and working tree isolated. For every initial clone whose exact commit
already exists in the source repository, Git borrows that matching local object
store with `--reference`; only a genuinely new pin falls back to the configured
remote. Yrd records that fallback boundary in repository-local Git config as
`submodule.alternateLocation=superproject` and
`submodule.alternateErrorStrategy=info`. There is no Yrd-specific cache knob.

The Queue uses the same materializer for warm candidates and landing scratch
worktrees. This makes Bay startup and repeated checks faster, avoids redundant
network transfer and private pack copies, and still checks out the exact
candidate gitlinks. Fresh standalone clones without a local source store fall
back normally. Exact-SHA reachability proofs intentionally remain backed by
fresh remote stores, so local borrowing cannot turn an unpushed pin into a
passing delivery proof.

`bay path` resolves through the same canonical ID/name/branch selector as the
other Bay operations. It refuses unknown, ambiguous, inactive, or pathless
Bays. Plain output is the absolute path plus one newline; JSON is the stable
`{"bay":"B1","command":"bay.path","path":"/absolute/path"}` projection.

`--issue` resolves and stores an opaque tracker-neutral reference such as
`km:@yrd/core/42` or `github:beorn/yrd#42`. Yrd preserves that link but does not
import tracker lifecycle or fleet policy. The explicit child argv runs in the
Bay; Yrd does not assign, lease, or resume workers.

A submitted PR also carries a `--title` (its subject) and a `--description`
(its body). When either flag is omitted, `pr submit` seeds it from the head
commit — the subject becomes the title and the commit body becomes the
description, with a trailing `Issue: <ref>` reference appended when `--issue` is
present. Explicit flags always win, and `pr edit` re-sets any of them on a live
PR. Both are mutable delivery metadata (unlike the immutable issue join) and are
carried forward unchanged across `pr recut` and `pr ready` revisions. The `pr
list` SUBJECT column shows the title over the branch name. `pr view` and the
watch detail pane render the title and description block; issue URLs, paths, and
path-form ids render as OSC 8 links (path-form ids use km's internal-link URI).
The watch detail keeps the PR identity in its title, then a persistent
`RUN` block with submitted/started/completed clocks and age/runtime/wait
durations above the workflow tabs. One outlined status notice owns the
observable state, cause, automation, and next owner; later unstarted steps after
a failed predecessor render canceled. The newest-output step is selected by
default. The PR tab presents one chronological, two-tone activity stream across
revisions and Runs, followed by scalar facts and the diff. Step tabs keep the
executed command immediately above its output and link the real artifact path
for the full log.

To continue an existing branch, first make its delivery identity explicit, then
target that existing PR. Direct branch submission does not provision a
worktree:

```bash
git push -u origin fix/release
yrd pr create fix/release --base release/2.0
yrd sh --pr fix/release
yrd pr ready fix/release --correlation tribe-request:req-42
```

Both submission surfaces accept `--correlation <namespace:id>`. The namespace
and opaque id bind to the exact PR revision and remain on its terminal facts;
rebinding a live PR to a different correlation is refused.

A branch name is a moving delivery selector, while a PR id is immutable
evidence. Submitting an integrated or `already-landed` PR by id is idempotent;
submitting its branch at the landed head is an informational no-op, and a newer
head on that same branch mints a fresh PR. `already-landed` records the base,
Candidate, and equal tree hashes without creating a merge commit. A withdrawn
or canceled branch reopens its existing PR at the next revision.
`needs-author` and legacy rejected revisions remain live: fix the branch and
push, and the same PR resumes automatically as its next revision.

### PR Eligibility and Checks

```text
yrd pr create [selector] [--base <branch>] [--issue <ref>] [--track]
  [--title <text>] [--description <text>]
  [--correlation <namespace:id>] [--json]
yrd submit [selector...] [--base <branch>] [--track] [--keep-on-failure]
  [--issue <ref>] [--title <text>] [--description <text>]
  [--correlation <namespace:id>] [--json]
yrd pr submit [selector...] [--base <branch>] [--track] [--keep-on-failure]
  [--issue <ref>] [--title <text>] [--description <text>]
  [--correlation <namespace:id>] [--json]
yrd pr checkout <selector> [--bay <name>] [--json]
yrd pr list [--base <branch>] [--state <state>] [--issue <ref>]
  [--needs-review [--reviewer <reviewer>]] [--json]
yrd pr edit <selector> [--issue <ref>] [--note <text>]
  [--title <text>] [--description <text>] [--track | --untrack] [--json]
yrd pr recut <selector> [--revision <number> | --ref <candidate>] [--preflight]
  [--apply] [--queue] [--force] [--json]
yrd pr ready <selector> [--json]
yrd pr review <selector> (--approve | --reject)
  [--by <identity>] [--ref <id>] [--note <text>] [--json]
yrd pr comment <selector> --note <text> [--by <identity>] [--ref <id>] [--json]
yrd pr checks <selector...> [--follow] [--json]
yrd pr close [selector...] [--json]
```

An unfiltered human `pr list` shows the 20 most recent PRs in numeric id order.
Any explicit list filter keeps the complete matching set, and JSON stays
lossless.

`pr create` registers only the pushed revision and returns without submitting
it, requesting checks, or starting Queue work. Plain `pr submit` and `pr ready`
run the repository's configured checks locally, record the authoritative check
request, and return without driving Queue execution. `pr checks --follow`
observes the later Queue-owned check result. It renders the typed evidence in
human or newline-delimited JSON output, including command argv, concise
diagnostics, base-versus-carrier classification, and artifact paths.

A push to the managed receiver at `refs/for/<base>/<issue>` is the submit act:
the receiver refuses an inadmissible change before accepting the ref, then one
Bay transaction records the pushed revision, submission, and check request.
Ordinary `refs/heads/*` pushes remain draft intake.

Submission has two deliberately different head questions. An active Bay asks
which commit is checked out in its managed workspace after refresh, because
that workspace is the authored source being submitted. A direct branch or a PR
without an active Bay first asks whether `origin` advertises that branch. If it
does, Yrd fetches that exact branch and records its live tip; if it does not,
the branch is still local authored work. Failure to establish either remote
fact is typed and never falls back to a possibly stale ref. A repository with
no `origin` remains explicitly local-only.

After submission, Queue asks neither question again. It verifies and merges the
recorded immutable PR revision; branch movement creates a new submission
revision and never changes an admitted Candidate. All branch-head protections
therefore run at submission time. Merge time is intentionally blind to the
moving branch name and operates only on the frozen revision and authoritative
base.

`pr submit --keep-on-failure` retains a failed local required-check workspace
and prints its path so the exact candidate and dependency state can be
inspected. Checkout, submodule population, dependency provisioning, and check
command failures are retained; successful checks keep the normal cleanup.
The flag changes evidence lifetime only—it does not skip or weaken a check.
The caller owns the retained evidence after inspection. For a printed worktree
path, run `git worktree remove --force <path>`, then remove its now-empty
container with `rmdir <parent-of-path>`. If checkout creation itself failed,
the printed path is that container; inspect it, then use `rmdir <path>` once it
is empty.

`--track` opts a live PR into resident “merge into latest.” Before every Queue
cycle, the resident observes the branch from `origin`; when its tip moved, Yrd
records that exact SHA as a new immutable revision, runs `pr recut --preflight
--queue`, and applies every queue-safe typed verdict before the normal ready
path.
Decision-required withdrawal verdicts remain loud for an operator. A run
always pins one frozen revision—tracking changes which revision is prepared,
never a running Candidate. `pr edit <PR> --untrack` stops future observation
immediately. Direct `pr create` / `pr submit` tracking is opt-in; the flag
introduces no project-wide default.

`pr checkout` is immutable inspection: it provisions the recorded revision
head in detached HEAD and asserts the resulting Bay head before reporting
success. The PR author's live branch may remain checked out elsewhere. Use
`bay open --pr <selector>` instead when continuing authored branch work that
needs refresh or checkpoint operations.

`bay open --pr` also starts from the PR's exact recorded revision. If another
worktree owns the authored branch, Yrd materializes that revision in detached
HEAD while retaining the Bay's declared target branch and source head. Refresh
and checkpoint operations accept only descendants of that source, and
checkpoint pushes still target the PR branch. The operator never needs an
internal `--from` flag.

If provisioning fails before a workspace path exists, the durable Bay record
remains explicitly reapable: `yrd bay close --force <bay>` has no path-owned
process tree to certify, and it atomically creates or verifies a preservation
ref for any recorded head before closing. This is the terminal recovery for a
pathless Bay; creating an extra anonymous Bay is not required.

`pr recut --ref <candidate>` is certification, not replay. The CLI resolves the
ref once, passes only that immutable SHA to Queue, and records it directly as
revision N+1 when its non-gitlink tree delta is identical to the approved
change-set. The exact current revision must still be approved. Missing commits,
dropped or extra paths, changed blob/mode/status identity, and added, modified,
or deleted gitlinks are typed per-candidate refusals before any journal or Git
mutation. A changed gitlink is an intent submission, never a code-carrier
recut. `--ref` cannot combine with `--revision`.

Without `--ref`, `pr recut` retains the ordinary mechanical base-refresh path:
it fetches the authoritative base and records an equivalent,
certificate-bearing successor on the same PR. `--revision` selects an older
immutable revision; its correlation and approved-review provenance follow that
selected payload. When submission recorded authority newer than the source
branch, recut derives exactly one source merge base and refuses ambiguous
lineage. `--queue` readies only the certified revision and requests fresh
checks. List, detail, and watch output retain the recut lineage and cumulative
source-ready age while reporting the successor revision's queue wait
separately.

An implicit PR-id recut is reproducible, not "whatever is on the branch now."
Before either preflight or mutation, Yrd refreshes that exact branch from
`origin` and compares its server-observed tip with the recorded authored source.
For an untracked PR, a difference refuses before composition, journal writes,
or a check request; the refusal names both heads, the intervening commits, and
both explicit paths:

```bash
# Current intent: register the new head, reopening revision-bound review.
yrd pr submit <branch>
yrd pr recut <PR> --preflight --queue --apply

# Historical intent: deliberately replay the recorded immutable revision.
yrd pr recut <PR> --revision <number> --preflight --queue
```

Every new recut revision also persists `recut.sources`: the root source head and
each rewritten component head mapped to the mechanically equivalent successor.
This is the durable identity bridge when recomposition intentionally breaks Git
ancestry. `yrd pr view <PR> --json` exposes it under
`.detail.pr.revs[].recut.sources`, while the human detail view prints the same
mapping as `RECOMPOSED`.

`pr recut --preflight` is the non-mutating decision surface. It pins the
authoritative target once and emits exactly one of `SUBSUMED-WITHDRAW`,
`RECUT`, `RECUT-FORCE`, or `FRESH-NOOP`, followed by the exact next command.
Its evidence names source/target pin distance, exact ancestry or merge-result
tree proof, and any stable patch-id landing match. Tree equality—not patch-id
alone—authorizes withdrawal because stable patch IDs intentionally ignore
whitespace. Missing objects, diverged bases, and composed source payloads fail
closed instead of producing a guessed verdict. Pass `--queue` to include the
authoritative check request in the recommended next command.

`pr recut --preflight --queue --apply` executes that same pinned decision
without a second command or a second read. `RECUT`, `RECUT-FORCE`, and
`FRESH-NOOP` apply their queue-safe action and return a receipt containing the
verdict, executed command, and resulting revision/head. `SUBSUMED-WITHDRAW`
still refuses with the exact withdrawal decision because retiring a delivery
requires operator judgment. `--apply` cannot combine with `--revision` or
caller-supplied `--force`; both authority choices come only from the preflight
computed for the current revision. Repeating the command after a successful
recut returns `FRESH-NOOP` without another recut.

The resident Queue owns both tracked-source and base freshness. It first
records and preflights branch movement for opted-in PRs, then, before each run
snapshot, compares every requested revision's immutable base with the
authoritative base; when the base advanced, it records a refreshed recut on the
same PR with the same patch-id lineage and a fresh certificate. The append carries
an expected-current revision/head guard, so an authored revision that arrives
while Git proof is running wins and the stale automatic result is deferred.
If the recutter proves that current main already contains the revision's whole
payload (`head == base` with the base tree), refresh does not mint an empty
successor. It terminalizes the selected revision as `already-landed` with a
`refresh-superseded / payload-already-contained` receipt naming the current-main
SHA, equal tree hashes, and the authored patch id. Replaying the same journal
therefore performs no Git work and appends nothing.
Patch drift and gitlink pins that require authored composition remain loud,
typed refusals; an independent PR can still refresh in the same cycle.
Likewise, a tracked revision whose preflight proves `SUBSUMED-WITHDRAW` records
one revision-bound machine comment and stays out of admission until an operator
decides; later resident cycles do not repeat the same warning, while a new
branch push creates a new revision and is evaluated normally.
Separately, selectorless composition ejects a PR whose exact submit/check
authority was already consumed, records `pr/needs-author` with the refusal code
and an executable `pr recut --preflight --queue --apply` remedy, and keeps draining its
healthy peers. An explicitly targeted run still fails loud after recording the
same author receipt.

Required-check refusals are revision-scoped durable facts. Queue immediately
records a `needs-person` settlement for a structurally permanent
`recut-gitlink-conflict`; recoverable refusals still wait for the resident's
remedy classifier to reach a judgment-required or failed/no-remedy outcome.
The settlement names the exact revision and head. Selectorless one-shot and
resident drains share the same selector, so neither process restart nor
another cadence tick can select it again or grow the journal. A new authored
or recut revision clears the settlement and is eligible normally. This is
Queue state, not a resident retry cache or restart budget.

`yrd queue run --once` keeps that settled refusal visible instead of reporting
`Queue idle`: human output names the refusal and
`yrd pr recut <PR> --preflight --queue --apply`, while JSON includes the same canonical
eligibility fact in `blocked`. A targeted one-shot reports blockers only for its
selected PRs; a selectorless pass reports them alongside any healthy Runs that
made progress.

For a human-authored root carrier, use the machine-owned path rather than
attaching a composition manifest:

```bash
# Re-record the corrected branch. `create` keeps a draft PR a draft and is
# accepted only while the PR is `pushed`; every other delivery state uses
# `submit`, which no state refuses.
yrd pr create <branch>   # draft (pushed) PR
yrd pr submit <branch>   # submitted, needs-author, rejected, reopened
yrd pr recut <PR> --preflight --queue --apply
```

A terminal PR (integrated, already-landed, withdrawn, canceled) cannot be
recut; resubmitting its branch reopens or mints the delivery instead. The
printed `resolve:` steps follow the PR's current delivery state, so they never
name a command that state refuses.

The preflight returns `RECUT-FORCE` when an authored-root rejection left a
passing check attached to the current revision, making the required override
explicit before recut replaces that revision with the machine-certified
successor.

The Queue is the only scheduler. Its journaled passed Run is also the cache:
integration reuses matching carrier-classified pre-merge work only when
resolved base SHA, head SHA, installed-step revision/config, and toolchain
fingerprint all match. Base-classified required checks always rerun before
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

Human-authored gitlink commits are refused. Submit each reviewed existing
component advance with `yrd intent submit --component <path> --target <sha> --issue <ref>`;
there is no intake bypass. Added and deleted gitlinks are not
advance intents and remain refused. Queue owns the generated root carrier and
writes it deterministically from the exact base and accepted intents.

#### Resolving Divergent Gitlink Pins

The stable `recut-gitlink-conflict` code (visible in JSON and persisted views)
names the authoritative root and pin plus the replayed authored root and pin.
When neither submodule pin contains the other, publish a real composition
commit in that submodule, update the carrier to pin it, and recut the same PR:

```bash
git -C <submodule> fetch --all --prune
git -C <submodule> switch -c yrd/compose-<PR> <authored-pin>
git -C <submodule> merge <authoritative-pin>
# Resolve any content conflicts and commit before continuing.
git -C <submodule> push -u origin HEAD
git add <submodule> && git commit -m "fix(yrd): compose <submodule> pins"
yrd pr submit <branch>   # or `yrd pr create <branch>` while the PR is a draft
yrd pr recut <PR> --preflight --queue --apply
```

This recipe is deliberately NOT a machine remedy. Its merge composes two
divergent submodule pins and can conflict, and resolving that conflict is a
judgment call, so `recut-gitlink-conflict` projects an escalation instead: its
`resolution` says escalate to a human, and the recipe rides `escalation.steps`
(`ESCALATE`/`MANUAL` rows in the views, `escalate:`/`manual:` lines on stderr)
as guidance for that human. Nothing should execute it unattended.

The composition commit must be published before the root carrier is submitted;
otherwise the Queue cannot prove the gitlink object is remotely reachable.

#### Running an Ordinary Bay

The caller owns assignment policy. A human or another application composes the
workflow explicitly from Yrd's delivery operations:

```bash
# Claim github:beorn/yrd#42 in the caller's issue system first.
yrd bay run --issue github:beorn/yrd#42 -- \
  task-runner --issue github:beorn/yrd#42
yrd pr create task/42 --issue github:beorn/yrd#42
yrd pr ready task/42
```

The optional Contest extension creates one bay per competitor and delegates
execution to a runner port installed by its embedding host. Yrd ships no
default competitor launcher and does not interpret a competitor's opaque
configuration. Assignment and process policy remain outside Yrd.

### Queue Operations

```text
yrd queue list [filter...] [--base <branch>]
  [--status <statuses>] [--since <duration>] [--latest] [--watch | --check] [--json]
yrd queue ls [filter...] [the same options]
yrd queue [filter...] [the same options]
yrd watch [filter...] [the same options except --watch is implied]
yrd queue run [selector...] [--steps [step...]] [--once] [--interval <seconds>] [--json]
yrd queue cancel <run> [--reason <text>] [--json]
yrd queue pause [base] --reason <text> --for <duration> [--allow [pr...]] [--json]
yrd queue resume [base] [--json]
yrd queue recover [--reason <text>] [--runner <id>] [--json]
yrd queue finish <selector> [--step <name>] --job <id> --runner <runner>
  --attempt <number> --token <token> (--ok | --fail) [evidence options]
yrd queue audit [--json]
yrd admin queue init [base] [--json]
yrd admin queue deinit [base] [--json]
yrd admin bay prune [--apply] [--json]
yrd admin pr prune [--dry-run] [--json]
yrd admin journal bump <version> [--json]
```

| Command              | Input                                              | Output and state                                                                                                      |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `list` / `ls` / bare | Optional OR filters, base, status, window, latest  | One base's pending/running/completed timeline; sibling queues stay named in the header                                |
| `list --check`       | Repository                                         | Typed resident lease/heartbeat/baseline health plus installed-base Git distance                                       |
| `run`                | Zero or more eligible PRs                          | Sole drain imperative; resident follow-runner by default (was `--watch`), a single pass with `--once` or PR selectors |
| `pause`              | Optional base, required reason, optional allowlist | Pauses new runs (including retries) while active work settles; the default queue read shows the pause                 |
| `resume`             | Optional base                                      | Removes the queue pause                                                                                               |
| `recover`            | Optional reason or known-dead runner id            | Reconciles abandoned work and releases queued runs whose installed step definition changed                            |
| `finish`             | One waiting PR/step plus job/runner/attempt/token  | Records external-runner evidence and resumes that exact durable run                                                   |
| `audit`              | Repository                                         | Journal, projection, pinned-plan, installed-step, and queue-progress findings; no state change                        |
| `admin queue init`   | Optional base                                      | Resolves queue resources and installs the managed pre-submit hook                                                     |
| `admin queue deinit` | Optional base                                      | Releases resources owned by the installed queue adapter                                                               |

`queue list` is the canonical read-only surface. `queue ls` is its spelling
alias, bare `queue` defaults to it, and top-level `watch` is the same command
with `--watch` implied. All four forms share filters and projection semantics;
positional filters are case-insensitive OR terms over PR, Run, branch, subject,
and failure code. `--latest` is the opt-in one-row-per-PR lens; the default
preserves every matching Run. `--json` carries the same rows and summary fields
losslessly.

`queue list --check` is the process-health affordance for supervisors. It
tries the resident's existing OS lease (it never creates a second authority),
checks heartbeat freshness and installed-baseline drift, and emits
`hab-service-health/1`. Exit 0 means a healthy resident owns the lease; exit 1
means no resident owns it while the queue is empty; exit 2 means unhealthy and
carries a typed error with `cause` and `resolution` steps. In particular,
submitted work with no resident is `resident-runner-missing`, never a quiet
absence. `--json` also reports the checkout HEAD and ahead/behind distance from
each installed base SHA.

`queue audit` is the progress-health affordance. Submitted work that never
starts required checks emits `queue-never-started` after the configured
interval, measured from that carrier's own ready time. Work that did start
required checks emits `queue-progress-stalled` after the configured no-landing
interval. A repeated exact refusal emits the more specific
`admission-refusal-loop` and inhibits the generic finding for that same queue
head, so one wedge has one actionable specimen. Findings carry stable
`specimen`, `since`, `blockedMs`, and count fields; process or lease PIDs never
participate in their identity. `--json` exits `1` when findings exist.

`--steps` narrows a run. Omitted means the configured default sequence. An
explicit empty `--steps` runs no steps. Re-entry is PR-owner-authorized: inspect
`needs-author` work with `yrd pr runs <PR>`, fix its source branch, and push.
The receiver appends a fresh revision on the same PR and records submit and
check authority for its exact head automatically—there is no second submit
ceremony. Required checks consume the check fact, and an integrating Queue run
consumes the submit fact. Queue commands cannot mint authored authority. The
resident freshness transition is the one mechanical carry-forward: its
certified successor atomically retains the prior revision's submit and check
authority on the same PR.

The resident re-proves the installed baseline before every cycle. A
`config-drift` finding first executes the same in-place `admin queue deinit` /
`admin queue init` migration printed by the health surface, then re-audits
before starting work. If either capability is absent or the post-migration audit remains red
on configuration drift, the cycle refuses loudly. True runtime drift asks the
resident host to unwind its heartbeat and leases, close its runtime, and
`execve` the exact same argv and source in place. The OS PID stays stable while
the reconstructed host loads the current repository configuration and mints a
new driver epoch; before unwinding, the resident writes the `runtime-drift`
finding into its durable heartbeat so the cause survives the control transfer.
If `execve` itself fails, Yrd reports `runtime-reload-exec-failed`, exits with
the infrastructure code `3`, and Hab restarts the unchanged argv. A one-shot
run still refuses instead of reloading itself.

To stop a resident `queue run` (its follow-by-default form), send `SIGINT` (Ctrl-C) or `SIGTERM`.
The first signal stops new Queue work, lets the active run finish, and exits with
that run's result; an idle runner exits cleanly. Send either signal again to
force the existing hard shutdown and job-tree reap.

A selector or `--once` run is a foreground one-shot, not a resident drain. On
`SIGINT` or `SIGTERM`, Yrd first settles that process's PID-scoped active Job as
`job-lost`, then reaps its process tree and preserves the native signal exit
status (`130` or `143`). No other one-shot runner is touched, and a subsequent
`yrd queue recover` is a no-op for the interrupted Run.

The resident exit code is a supervisor contract, so `hab restart=on-failure` is
meaningful. An operator-requested stop that DRAINS — the first signal, the active
run reaches a terminal state, the queue is drained — exits `0` (or `1` if that run
failed): the stop was intentional, do not restart. But when a hard signal cuts an
UNFINISHED drain short with a run still in flight, the resident exits non-zero so a
supervisor resumes draining instead of leaving live work stranded. (That non-zero
code is `3`, shared with a self-refused infrastructure exit — a supervisor treats
both the same under `restart=on-failure`.) A runner killed by an uncatchable signal
is covered separately: it leaves its heartbeat behind, and its successor reclaims
the leases (see below).

A resident acquires one OS-held lease in the repository's common Yrd state
before receiver intake or required-check execution. A second resident exits with the
typed `resident-runner-active` refusal and identifies the active
`yrd-cli:<pid>` runner. Job events retain that runner id; trace logs add
host and available Herdr/cmux pane provenance. Normal exit and graceful
shutdown release the lease, while the OS releases it if the owner dies.

A resident never deletes its heartbeat status on exit — it overwrites it with an
exit marker. The successor reads that marker and reclaims the departed pid's
leases (a no-op after a clean exit, since those leases are already released), so a
runner that dies with work in flight cannot strand it. Each tick the resident also
runs an unscoped lease-expiry recovery sweep, settling any orphaned running Job
whose lease has lapsed regardless of which runner left it, so ghosts do not
accumulate between restarts.

An explicit non-empty selection is durable Run authority, not a filter applied
after configured checks. Yrd neither starts nor reuses omitted configured
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
Pass `--runner <id>` when a runner is known dead to force-settle its leases now,
even ones that have not yet expired — clearing a fresh ghost without waiting the
lease out.

### Issues and Contests

```text
yrd issue [--json]
yrd issue view <issue> [--json]
yrd issue ensure <issue> [--json]
yrd migrate terminal-associations [--apply] [--json]
yrd pr regression <pr> --run <run> --detected-at <timestamp>
  --severity <level> --evidence <ref> --implementation-run <ref>
  --review <ref> --repair-pr <pr> --repair-run <run> [--json]
yrd contest open <issue> --competitors <json> [--json]
yrd contest eval <contest> [--retry] [--json]
yrd contest view <contest> [--json]
yrd contest finish <contest> [--attempt <attempt>] [--evaluator <id>]
  (--ok | --fail | --error <code>) --token <token> [evidence options]
yrd contest select <contest> --winner <attempt> [--by <identity>] [--reason <text>]
yrd contest promote <contest> [--json]
```

`--competitors` is a JSON array with at least two
`{"id": <opaque-id>, "runner": <installed-port-id>, "config": <json-object>}`
records. For example:

```bash
yrd contest open km:T1 --competitors \
  '[{"id":"fast","runner":"bench","config":{"profile":"fast"}},{"id":"thorough","runner":"bench","config":{"profile":"thorough"}}]'
```

The IDs are labels, runner IDs resolve only against immutable ports injected
by the embedding host, and `config` is passed through unchanged. Yrd assigns
no provider, model, process, or retry policy. The stock host installs no
Contest runner; a host that exposes `contest open` must inject its runner and
evaluator definitions explicitly.

Each competitor receives the same issue snapshot and base commit in its own bay.
Yrd records wall time, token counts, reported USD cost, stdout/stderr,
artifacts, the write-once attempt ref, and evaluator results. Missing metrics
remain missing; Yrd does not guess cost.

The issue list/view lens is read-only and joins delivery facts to tracker
references; issue creation and editing remain in the tracker. `issue ensure`
is the sole mutating issue subcommand: it idempotently ensures one clean
issue-owned Bay and one `track: true` draft PR. It does not assign a worker,
choose a seat, launch a process, submit the PR, or execute Queue work; launchers
compose those responsibilities outside this Git-side verb.

`yrd issue --json` and `yrd pr runs --json` include the same
compatibility-safe pair: the deprecated `trackerBridge` v1 envelope and the
canonical `trackerBridgeV2` envelope. Each delivery carries the exact opaque
`issueRef`, PR revision/head, projected status, Queue runs, and one journal
`asOf` cursor. Integrated deliveries carry `landingSha`; `already-landed`
deliveries instead carry the base, Candidate, and equal tree hashes that prove
no merge was needed. V2 projects an author-attributable red as `needs-author`
with its `attributedReceipt` and typed bounce. V1 explicitly degrades that
state to `rejected` plus the same bounce; consumers should migrate to
`trackerBridgeV2`. Canceled and withdrawn remain distinct terminal outcomes.
A revision with passing required checks remains externally `submitted` in both
bridge versions until it reaches a terminal outcome; a passing check is Queue
evidence, not a tracker delivery status.

The human `yrd issue view <issue>` surface projects those same typed facts: it
prints exact PR revision/head, Queue runs, canonical projected status, landing
or bounce, and the original/repair provenance of every recorded regression.
Bare `yrd issue` keeps the compact multi-issue table.

`yrd migrate terminal-associations` is the explicit compatibility cutover for
legacy rejected-PR events that predate the typed Queue run field. Its default
dry-run lists every unassociated terminal, either with one revision/head-bound
failed-run proof or with a typed refusal such as missing, chronology-invalid,
or ambiguous candidates. `--apply` appends one `pr/terminal-associated` event
for each uniquely proven row and leaves every refused row untouched. It never
rewrites committed journal facts, fabricates a run, or weakens new
`pr/rejected` events; repeating
`--apply` after the proven rows land appends nothing.

`pr regression` records a completed repair without rewriting either integration.
It accepts only the exact original and repair Queue runs named by their terminal
journal facts, and preserves detection time, severity, evidence, opaque
implementation/review provenance, both issue/PR/run identities, and both landing
SHAs. Consumers may derive flow metrics from this join; Yrd does not add a
telemetry store or interpret opaque provenance.

The bridge contract is the journal plus JSON data, not a tracker plugin
registry. Independent consumers checkpoint `trackerBridgeV2.asOf.cursor` (or
the identical v1 cursor during migration) and write projections into their own
tracker. References such as `@km/...`, `gh:1234`, and `JIRA-123` stay opaque to
Yrd.

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

Human diagnostics lead with one complete `error:` sentence. They add
`resolve:` lines only for concrete next commands; generic “fix and retry”
advice is omitted. With `--json`, a diagnostic is one JSON object on stderr:
its `failure` retains `{ kind, code, message }` and adds the actionable
`cause`, `resolution`, and optional `reference`.

## Required checks and landing

The base branch's `.yrd.yml` is the repository authority. It has one predicate
list:

```yaml
checks: [typecheck]
```

Landing authority is declared on the same base-selected config:

```yaml
landing: expected
```

`expected` is the backwards-compatible default when the key or config is
absent. A repository with no landing runner declares `landing: none`; `pr
submit` then refuses before required checks or queue mutation. `--config`
selects the same base-relative authority for this gate, so mutable worktree
bytes cannot override the base declaration.

Queue progress thresholds share this one strict declaration surface:

```yaml
progress: { noLandingMs: 1800000, refusalCount: 3 }
```

Both fields must be positive integers and default to the values above.
`noLandingMs` is evaluated only while required-check work is queued; a real
`integrated` or `already-landed` journal fact resets its clock.

`typecheck` is a built-in check that runs `bun run typecheck`. `check` is the
other built-in and runs `git diff --check` against the pinned base. A repository
may define a one-line command inline:

```yaml
checks: [{ lint: { run: bun run lint, mode: strict } }]
```

Merge is not a configurable check. It is Yrd's built-in landing transition, and
post-landing effects belong to subscribers. The managed pre-submit hook and
`pr submit`/`pr ready` run the same configured list for fast local feedback.
The Queue runs it once more against the exact Candidate before the built-in
merge. Skipping the hook therefore costs feedback latency but cannot weaken the
landing gate. Run one configured check explicitly with `yrd check <name>`.

`yrd admin init` writes that exact one-liner and the managed pre-submit hook. It
refuses to overwrite an existing repository config.
Deleted or unknown repository keys—including unknown keys nested under
`progress`—fail config load loudly.

The reader's supported journal versions are compiled into Yrd. The journal
records its own one-way version floor: a fresh journal is born at its creating
writer's version, while an existing lower-floor journal refuses newer writes
until `yrd admin journal bump <version>` proves all live residents are capable,
takes a snapshot, and passes a restore drill. Repository config carries no
journal version or reader SHA.

The synchronous status projection is intentionally bounded to all live
trees plus the latest 512 terminal roots. Failed required-check evidence remains
live while it still governs a current PR's retry budget. A root and every
isolation child otherwise co-retain and co-evict with their Queue-owned Jobs.
Exact selectors and `queue.history()` materialize older runs from journal-owned
entity slices; `yrd log --all` uses that lossless path, while default status
remains bounded. Bare `log --all` discovers bases from that history too, so a
fully retired base is not hidden merely because no live Bay or Queue names it.

Object-form checks may declare `classification: base` when their evidence is
about the resolved base rather than the submitted carrier; all other steps
default to `carrier`. The classification is part of the installed-step cache
identity and appears in typed check evidence.
Command failures are terminal by exit code by default. A diagnostics-shaped
lint or typecheck step may declare `comparison: diagnostics` to run against the
parent too and accept only failures with no net-new diagnostics. Test-shaped or
otherwise opaque output stays on the plain exit-code contract; absence of
parseable diagnostics never aliases a real command failure to an environment
refusal. The comparison declaration is part of the installed-step cache
identity.
Object-form checks also accept `mode: delta | strict` (default `delta`).
`strict` requires an absolutely green Candidate and never runs the parent
comparator. `delta` may accept inherited diagnostics only through an explicitly
declared `comparison: diagnostics`, or through structured child trailers of
the form `YRD-GATE-REPORT <json>`. Opaque output, truncated diagnostics, and a
nonzero structured-child exit remain terminal.

A compound command that runs structured children before a diagnostics-only
tool must emit a zero-residual `diagnostics-comparison-ready` report after every
structured child passes and declare
`comparisonReady: diagnostics-comparison-ready` in its check config. Only that
marker permits Yrd to compare a final nonzero diagnostics exit against the
parent; a missing marker is terminal even when the command emitted no report.

Every required check records a self-contained v1 gate certificate: mode, exact
base and Candidate SHAs, comparator id/version, and each residual set's content
hash plus count. The run/PR view projects this as `delta residual:N` or
`strict residual:0`, so carried red stays visible even when the check passes.
Mode is bound into installed-step identity; flipping a release step to `strict`
cannot reuse a delta installation.
`requires: [review]` is the only built-in review policy: the latest verdict for
the current revision must approve. Comments never gate, and omitting
`requires` leaves reviews informational.

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
under the configured bays root. Before a built-in or inline check runs, Yrd
provisions that worktree from the Candidate's committed Bun, pnpm, or npm
lockfile instead of borrowing mutable host packages. Frozen installs disable
all lifecycle scripts, including a Candidate's `postinstall`. Owner-controlled
Work Bays may opt into the repository's `postinstall` for first-party code
generation. A missing lockfile or failed install is a
retryable `queue-environment-refused` with `candidate-provision-failed`
evidence, never a false failed-check verdict. Work Bays use the same
provisioner. Local execution is not a security sandbox: candidate code still
runs with the operator-configured process privileges; use a remote or isolated
Process adapter for a stronger trust boundary.

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
If another candidate then reaches merge, Yrd refuses the stale proof instead of
landing untested work and refreshes that same PR onto the authoritative base.
The refreshed revision keeps the PR identity and gets fresh certified check
authority automatically. If the refresh exposes an author-attributable
conflict, the PR parks as `needs-author`; the owner inspects the receipt, fixes
the branch, and pushes.

### Batching

Top-level `batch` in `.yrd.yml` is the maximum batch size and defaults to `1`. `false`, `0`, and
`1` disable batching. A value above one tests candidates together. A failing batch is recursively
bisected until Yrd identifies the failing PRs, while passing subsets continue.
Bisection is the queue plugin's fixed isolation policy, not another config axis.

Different base branches have independent queue state but share the repository's
event journal, receiver, artifacts, and configured plugins:

```bash
yrd sh --bay release-fix --keep
yrd pr create task/release-fix --base release/2.0
yrd pr ready task/release-fix --correlation tribe-request:release-2.0
yrd queue --base release/2.0
```

## State and Recovery

Yrd stores local authority under the primary worktree's common Git directory:

```text
.git/yrd/
  journal.sqlite     immutable row history + bounded projection checkpoint (WAL)
  writer.lock        short cross-process transaction lock
  journal-v4-pre-sqlite-*/
                     preserved migration recovery evidence
  resident-runner/
    writer.lock      process-lifetime resident Queue lease
  prs.git/           bare PR ref/object receiver
  receiver-inbox/    crash-safe receive-hook handoff
  artifacts/         command, evaluator, and contest evidence
```

The Git repository is the durable truth for landing identity. Yrd stamps the
stable `Change-Id:` before checks and writes one checksummed merge record under
`refs/notes/yrd/merge-records` for every merged, failed, or canceled attempt.
`yrd why <selector>` verifies merged Change-Ids against base ancestry and reports
failed/canceled reasons, evidence, and fixes directly from Git. If the
corresponding `pr/integrated` index row is missing, `yrd why <selector> --repair`
appends it exactly once from that repository proof.

`journal.sqlite` is the source of truth for transactional command history, not
for whether code exists on the base. Each command appends one checksummed
transaction containing the Command, its cause, domain events, optional result
value, and Job requests. Landing and refusal rows are rebuildable query indexes.
`journal_events` is the bounded append tail;
`journal_history` keeps every covered frame as immutable, cursor-addressable
rows. Startup restores the validated Core checkpoint and folds only the tail
into Bay, PR, Queue, Job, and Contest state. Snapshot publication moves covered
rows into history and binds the bounded checkpoint in one transaction, keeping
older frames cursor-addressable without duplicating the full prefix inside the
checkpoint. Transactionally coupled, rebuildable query views may share this same
SQLite file; there is no second mutable database or read-model authority to
reconcile.

Command, cause, event, Job, Job-key, and Queue lookup facts are derived from
the same frames in the same transaction and are equality-checked when read.
Registered query views follow the same rule: their schema and projection stay
with the consuming package, their version/fingerprint/cursor live in
`journal_views`, a durable generation invalidates caches after rebuild, and a
view exception rolls the authoritative Frame back.
`yrd doctor --rebuild-views` recreates them from immutable history under the
writer lock without changing Journal authority.
Core keeps only the latest 4,096 receipt frames warm. Live projections retain
all nonterminal work, the latest 512 terminal Queue trees with every Job they
reference, any older failed required-check evidence still governing a live PR, and
the latest 512 standalone terminal Jobs. Exact old retries,
`Jobs.get()`/retry, Queue selectors, `events()`, and `yrd log --all` resolve from
immutable history without repopulating those live windows. A custom Journal
without the history capability keeps the unbounded compatibility projection;
it never silently evicts data it cannot recover.

Retrying a Queue-owned Job whose tree has already evicted records that detached
classification in `job/restored`. The promoted nonterminal remains live, and
its terminal result uses the standalone Job window rather than resurrecting or
displacing a retained Queue tree; cold replay reaches the same classification.

The Journal uses WAL with `synchronous=FULL`, incremental auto-vacuum, an
external POSIX writer lock, explicitly closed connections, and a runtime
`sqlite_version()` safety gate. Schema-v1 databases rowify their prefix and
build the immutable indexes transactionally, then resume an idempotent full
`VACUUM` before declaring migration complete. Later checkpoints reclaim at
most 256 freelist pages; a maintenance failure is reported as deferred after
the checkpoint remains committed. Read-only commands never initialize or
migrate authority. SQLite's volatile `-shm` coordination file is not logical
authority.

New terminal PR facts are revision/head-bound. Queue terminals also name their
exact Run; integration facts expose `landingSha`, which must equal the
`IntegrationProof.commit`. Historical payloads accepted by a replay-only schema
remain readable, but the current append schema is never widened for them.

Pre-cutover `.git/yrd/events.jsonl` and `.git/bay/journal.jsonl` files remain
opaque, read-only legacy data. Yrd never decodes, migrates, appends, or rewrites
them; `yrd log --all --json` reports their paths and frame counts only as a
coverage pointer while all new authority starts in `journal.sqlite`. The same lossless
view includes complete typed Queue runs and every historical Job attempt, including
failed output, artifacts, lost reasons, runner identity, and integration proof.

Serialized callers may retry a stable UUIDv7 Command id; trusted adapters may
instead supply a stable dispatch key. Yrd records the Command and a canonical
intent hash in the private journal transaction. Repeating the same id or key
with the same intent returns its committed `CommandResult`; reusing it for
different arguments is refused. The Git receiver uses its receipt as a dispatch
key, so replay after a lost response cannot create a second PR revision.

Jobs are the single durable executable lifecycle. Their native status is
`queued`, `in_progress`, `waiting`, or `completed`; completed Jobs carry a
`success`, `failure`, `cancelled`, `skipped`, or `timed_out` conclusion.
`withJobs()` installs that authority when the application needs executable
work. Queue and Contest records retain domain facts; their Job ids, status,
conclusion, attempts, timing, and evidence are derived from typed Job inputs
and results. This prevents three competing retry and recovery implementations.

A Job retry is infrastructure recovery for the same failed or lost Job and
keeps its id. A Contest re-evaluation is different: an evaluator may complete
successfully while returning a failed candidate verdict. Yrd records a new
Evaluation Job generation for that case and derives the complete run history
from Jobs, without adding another lifecycle store.

Job requests pin the definition revision used to create them. Pending execution
is refused if current plugin code has a different revision. Before execution,
Queue reconciles a queued current step against its pinned plan: revision drift
retires that Run as `stale-steps`, releases its authority, and leaves its PR
submitted for fresh checks under the installed plan. `queue recover` performs
the same reconciliation explicitly. A waiting Job may still finish after
revision drift because its token, attempt, runner, and stable definition output
contract fence that already-launched work. Queue runs also pin their complete
ordered step descriptors, so historical status remains readable after config
changes and `queue audit` reports unavailable pending plans. While such a
finding blocks an absent resident, the RUNNER frame names the stale Run instead
of collapsing the refusal into a generic `NO RUNNER` message.

Yrd owns the Job record and imports backend lifecycle events. Running work has
an expiring, heartbeated runner lease; crashed work becomes `lost` and can be
retried. A `waiting` Job has no launcher lease and remains durable until a
token-matched finish arrives.

`yrd queue recover` expires stale running leases, can force-settle a named
known-dead runner, reconciles already-terminal failure facts, releases queued
current steps whose definition revision drifted, and retires other proven
orphan/stale-plan states. Recovery never executes requested Jobs, creates
batch-isolation work, or merges a PR; normal queue execution remains the only
path that can advance those effects. If audit findings remain after recovery,
the human result names each blocking Run and reason instead of reporting
`Queue idle`; the JSON recovery result remains the stable list of settled Runs.

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
Because Yrd enables the `worktreeConfig` extension to scope those Bay push
defaults, host startup also relocates any stray `core.bare=true` (and
`core.worktree`) out of the shared config into the primary worktree's
`config.worktree`, per git-worktree(1): once `worktreeConfig` is enabled a shared
`core.bare=true` is inherited by every linked worktree, which would otherwise
report as bare and become unusable.

## Integration Boundaries

- **km** supplies tracker-neutral issue snapshots through a issue-source adapter.
- **Contest extensions** inject opaque runner and evaluator ports; Yrd records
  their results without owning how competitors are produced.
- **Hab** may host Yrd as a service; Yrd does not import habitat policy.
- **GitHub** can adapt issues to issues and checks/reviews/merge to queue steps.
- **Tent** may configure Yrd for a fleet, but fleet policy stays outside Yrd.

The low-level packages remain usable by a single developer with no agent fleet.

## Packages

| Package            | Responsibility                                                   |
| ------------------ | ---------------------------------------------------------------- |
| `@yrd/core`        | Immutable definition, Commands, Events, projection, Journal      |
| `@yrd/persistence` | WAL SQLite Journal, snapshots, migration, and writer exclusion   |
| `@yrd/process`     | Scope-owned subprocess execution, bounds, cancellation, evidence |
| `@yrd/job`         | Durable executable lifecycle, leases, waiting work, recovery     |
| `@yrd/issue`       | Issue references, snapshots, and source adapters                 |
| `@yrd/bay`         | Work bays, PR intake, Git workspace, and receive hooks           |
| `@yrd/queue`       | Typed steps, merge proof, waiting jobs, batching, and status     |
| `@yrd/contest`     | Competitors, evaluators, selection, metrics, exact promotion     |
| `@yrd/cli`         | `yrd` and `git-yrd` command projections                          |

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
