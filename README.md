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

A Git superproject is built on plain Git submodules — which in theory lets you treat a set of repos as one big virtual monorepo. In practice the tooling was missing. Yrd ships it — [`git super`](https://github.com/beorn/git-super) takes all the pain out:

- **Super PRs** group one feature's branches across repos.
- **Super worktrees** check out the whole product, every submodule at its exact commit.
- **Super CI** tests the exact commit that would ship.
- **Super merges** run children first, the superproject pointer last. It never points at half a feature.

A submodule with `branch = <name>` in `.gitmodules` is **tracked**: as the upstream branch advances, Yrd refreshes the tracked super PR with the new pin — proposing, never merging. Merges only happen through the queue.

`git super` is the standalone face of the same core — plumbing without the resident queue; the guarantees come from the yard.

**Assemble → test → merge → roll** — the queue is the only merger.

### Vocabulary

The **shaset** is the set of submodule commits a superproject commit records; every merge writes a new one. In one paragraph:

> A change's gitlinks are **min commits** — _at least this commit_. Before queueing, the queue checks each min commit is **on that submodule's main**; if not, the change **parks** until the submodule lands it. At merge, the queue **fills in** each submodule's final commit from its main and writes the **shaset** — authored gitlinks never land as-is. Nothing to merge = **nothing new**.

Standard git words — **submodule · gitlink · superproject** — mean exactly what git means by them; **shaset** is the one coined term.

### Content commits and shaset commits

A change's history holds exactly two commit species:

|               | **Content commit**             | **Shaset commit**                                    |
| ------------- | ------------------------------ | ---------------------------------------------------- |
| Diff contains | superproject tree changes only | gitlink updates + regenerated lockfile, nothing else |
| Written by    | the author                     | the queue                                            |
| Gitlinks      | never                          | always                                               |

```text
change
├─ content commit   "add feature"                     (author)
├─ content commit   "fix tests"                       (author)
└─ shaset commit    gitlinks + lock — the version     (queue)
                    checks ran against

pure pin advance = a change with exactly one shaset commit
```

- Each time the queue moves the change's shaset up — a submodule's main advanced, the base moved — it writes a **new shaset commit**; no invisible rebase.
- Only versions **checks actually ran against** are kept; superseded ones are pruned.
- Payoffs: `git log` answers _which shaset did this run prove?_ with a commit ref · review reads content diffs with zero gitlink noise · the machine half is machine-checkable.

**Killed vocabulary** (operator-ratified 2026-08-18). These words still appear in older prose, refusal codes, and the `yrd intent` rail until the rename carrier lands; new writing must not use them:

| Killed                                                    | Say instead                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ~~admission~~                                             | the queue **checks before queueing** — no noun needed                                                              |
| ~~derivation / derived~~                                  | the queue **fills in** the values and **writes the shaset**                                                        |
| ~~demand~~                                                | **min commit**                                                                                                     |
| ~~component~~                                             | **submodule** — the git word, everywhere                                                                           |
| ~~intent / pin intent / `yrd intent submit` / `yrdpin#`~~ | a pure pin advance is an ordinary **change whose diff is one shaset commit**; deleting this rail is scheduled work |
| ~~merge request / pull request~~                          | **change** — `mr`/`pr` remain taught aliases; ids still print as `PRnnn`                                           |
| ~~correlation~~                                           | **props** — opaque `--prop key=value` labels on a change (km's noun); the legacy journal key stays readable        |

## The model — five objects, one pipeline

```text
issue -> workspace -> pr -> queue -> merged
          ^      ^
          +-- contest (competing implementations; winner promotes to a PR)
```

- **issue** — what you deliver. It lives in your tracker; yrd stores only the
  reference. The tracker holds the pen; yrd owns the lens.
- **workspace** — where you work: a Git worktree that something owns the
  lifecycle of. That last part is the whole difference from a worktree you make
  by hand. A workspace carries a **lease** (who holds it, when it was opened,
  and a heartbeat that says it is still alive), the **issue** it is working, and
  a **lifecycle** — opening, active, closing, closed, failed — so an abandoned
  one can be recognised as abandoned instead of accumulating forever. Reached
  through the `yrd bay` subtree; its lifecycle is not a standalone product
  surface.
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
delivery. It composes reusable [`git-super`](https://github.com/beorn/git-super) mechanics with the merge queue while
Hab owns workspace lifecycle. Two deliberate absences define the boundary: `yrd pr
merge` never merges because the queue is the only merger, and yrd never creates
or edits issues because the tracker remains authoritative.

The project is `beorn/yrd`, its distribution is `git-yrd`, the package scope is
`@yrd`, and its public domain is `yrd.dev`.

The implementation model and package boundaries are documented in
[ARCHITECTURE.md](ARCHITECTURE.md).

## The delivery model

Three rules generate everything else in this section:

1. **A branch is a change.** Push a branch, record it once, and it is in
   delivery. There is no second content artifact to author or keep in sync —
   the change record derives from the pushed branch.
2. **Changes are tracked by default.** The queue watches the live branch; a
   moved head becomes a new revision by itself. You never re-submit by hand.
3. **The tested object is the merged object.** The queue builds a merge of your
   branch onto the target, tests exactly that commit, and makes exactly that
   commit the new target tip. It never rebases, squashes, or otherwise mints
   commits your checks did not run on.

The words used below: a **change** is the queued unit — ids print as `PRnnn`
and the CLI says `pr` purely because those spellings are familiar; no
pull-request object exists. A **revision** is one immutable recorded head of
the change's branch. A **candidate** is the merged object built for testing.
A **run** is one queue execution against a candidate. **Re-merging** is the
queue rebuilding the candidate after the target moved — its own act, with no
operator verb. The
**shaset commit** (a "sha set") is the queue's own commit that fills in each
submodule gitlink and the workspace lockfile those pins imply (see
[Superprojects](#superprojects)). How runs are ordered, batched, and executed
is [Queue Operations](#queue-operations)' to teach; this chapter is the object
model.

### A branch is a change

```console
$ git push origin task/fix-release
$ yrd pr create task/fix-release        # draft change, not yet queued
$ yrd pr submit task/fix-release        # runs local checks, records revision 1
```

`pr create` records the pushed head as a draft — invisible to the queue and
not yet observed; tracking begins at submit. `pr submit` (or `pr ready` in a
review-gated repository) records the head as revision 1, runs the configured
checks locally for fast feedback, and hands the change to the queue. A push to
the managed receiver — the push namespace `refs/for/<base>/<issue>` on the yrd
remote, where base is the target branch and issue names the tracker item the
change belongs to — is the same submit act in one
step. From here on the change's identity is stable: new pushes become new
revisions of the same change, and every final outcome — merged, refused,
withdrawn — names the exact revision and head it is about. Review lives on the
change too: `pr review --approve` records a verdict pinned to the exact
revision and head. A review-gated repository blocks `pr ready` until one
exists (see [PR Eligibility and Checks](#pr-eligibility-and-checks)).

### Tracked by default

A submitted change is **tracked**: before every queue cycle, the queue's
long-running process observes the branch on `origin`. When the tip moved, the
new head is recorded as the next revision, re-merged onto the current target,
and queued — automatically, with no ceremony from the author. Tracking does not
touch reproducibility. A run never executes "whatever the branch is now" — it
executes one frozen recorded revision. Tracking only changes _which_ revision
gets prepared next, never a running candidate.

Opting out is explicit:

```console
$ yrd pr submit task/fix-release --no-track   # this change will not follow the branch
$ yrd pr edit PR7 --untrack                   # stop tracking a live change
$ yrd pr edit PR7 --track                     # adopt tracking again
```

An **untracked** change refuses to replay silently-stale work. If its branch
moved, the queue does not guess which head you meant. It stops and prints the
exact remedies:

```text
error: change 'PR7' recorded revision 3 head 'a1b2c3d…', but live branch
'task/fix-release' is 'e4f5a6b…'. This change is explicitly untracked, so the
queue will not silently act on stale work.
To adopt tracking (the default), so moved heads are recorded as revisions:
  yrd pr edit PR7 --track
To record the live head once while staying untracked:
  yrd pr submit task/fix-release
```

The tracking bit only governs future revisions, so editing it on a terminal
change (merged, withdrawn, canceled) is refused — nothing would ever read it.

### The tested object is the merged object

For each eligible revision the queue builds a **candidate**:

```text
candidate = merge(target tip, unchanged authored tip) [+ shaset commit]
```

The candidate is an ordinary merge commit. Its parents are the recorded
target tip and your branch tip exactly as you pushed it. One case skips the
merge: when the target is already an ancestor of your tip there is nothing to
combine, and the target fast-forwards to your tip — the tested object is then
your own commit. On a superproject the queue then adds its shaset commit on top,
filling in each submodule's final commit and the regenerated lockfile. A merge
conflict is a refusal back to the author with the remedies printed — merge or rebase locally and
push — never something the queue resolves by guessing.

The configured checks run against that candidate, in a clean worktree, at that
exact commit. Publication is a compare-and-swap ref update: the target branch
moves to the candidate only if the target is still the tip the candidate was
built on. Before that move the queue proves four facts: the recorded check
results name the candidate's own sha; the candidate is the merge commit
itself, or the shaset commit whose first parent is that merge; the merge's parents are the
recorded target and authored tips; and the change's submitted tip still
equals that authored parent. (A fast-forward candidate has no merge; it is
instead proven to be the authored tip standing directly on the target.) If
another change won the race, nothing is
half-published: the queue re-merges the same authored tip onto the new target
and tests again. What merges is, byte for byte, what passed.

A red run is the same discipline pointing the other way: a refusal recorded
on the change, naming the revision, the failing check, and the remedy, and
the change leaves the queue as blocked. Fixing it is the same act as any
update — push the branch; a tracked change re-enters by itself with the new
head as its next revision.

Two consequences fall out:

- **Traceability is structural.** The authored tip is a parent of the merge
  that landed, so `git log`, `git branch --contains`, and ancestry queries
  answer "did my exact commit ship?" with yes or no — not "a squashed copy of
  it shipped". A stable `Change-Id:` is minted with the change, and the queue
  stamps it into the landed merge commit — no commit-msg hook to install —
  linking main back to the change and every revision of it. It survives
  amends and rebases because it lives on the change, not in your commits.
- **History is merge-shaped.** The target's first-parent chain is one merge
  per landed change — plus its shaset commit on a superproject, and a
  fast-forwarded change rides the spine as its own commits. That is noisier
  to read linearly than a squashed log; the antidote is built into git:
  `git log --first-parent` reads main as a clean sequence of changes, and
  `git bisect --first-parent` bisects over the same spine. The tested states
  on that spine are the published candidates — on a superproject, the shaset
  commits; the merge beneath each still holds authored min commits and is
  scaffolding, not a tested state.

### Superproject merging

Yrd queues a Git **superproject**: a repository whose tree records submodule
commits as gitlinks. No surveyed delivery system does this. Zuul gates many
repositories per change and Gerrit can submit a topic across repositories
atomically, but none of them — GitHub's and GitLab's queues, Gerrit, Zuul,
bors — tests and merges a gitlink superproject as one object; submodule bumps
arrive after the fact where they exist at all. So the superproject mechanics
here are deliberately Yrd's own design. Everything inside a submodule stays
completely standard git.

- An authored gitlink is a **min commit** — "at least this commit". Two
  submodule histories cannot be merged from the superproject, so the floor is
  the mergeable contract. Before queueing, the queue checks each min commit
  is on that submodule's main; if not, the change waits — parked, visibly,
  with the missing commit named — until the submodule merges it.
- When building the candidate the queue fills in each submodule's final commit from its main
  and writes the **shaset commit** — authored gitlink values never merge as-is,
  and the shaset the checks ran against is the shaset that ships, addressed by
  its own commit sha.
- Each submodule keeps ordinary single-repository practice: branches, merges,
  `git log`, `git blame`, and `git bisect` inside a submodule work exactly as
  in any standalone clone, because Yrd never rewrites submodule history to
  coordinate the superproject.

### Compared with other systems

|                        | Object tested                                     | Object merged                                                     | Branch moved →                                               | History on main                                                             | Trace main → change                                              | Superproject                                                  |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| **Yrd**                | merge of target + authored tip (+ shaset)         | the same commit, CAS ref update                                   | tracked: auto new revision; untracked: refusal with remedies | merge-shaped; first-parent spine                                            | authored tip is a parent; `Change-Id` trailer                    | queued and tested as one object; submodules stay standard     |
| **GitHub merge queue** | speculative merge group, strategy already applied | the group result                                                  | leaves the queue; re-queue                                   | linear (squash/rebase) or merge                                             | PR number in message; squash/rebase drop authored shas from main | none                                                          |
| **Gerrit**             | the patch set (one amended commit)                | per submit strategy — rebase/cherry-pick mint a new sha at submit | new patch set: amend + `push refs/for/…` ceremony            | per-project strategy; the default mints merge commits when the target moved | `Change-Id` trailer (Yrd adopts this)                            | subscription can bump gitlinks after merge, outside the queue |
| **Zuul**               | speculative merge of the whole train ahead        | whatever the backing forge then merges                            | new patch set restarts the gate                              | backend-dependent                                                           | via the backend                                                  | many repos per change via `Depends-On`, not gitlinks          |
| **bors (bors-ng)**     | staging merge of the batch                        | the exact staging sha, fast-forwarded                             | approval invalidated; re-approve                             | merge-shaped                                                                | merge commit names the PR                                        | none                                                          |

Trade-offs, in both directions:

- **bors made the core invariant famous** — test the merge, fast-forward to
  the tested sha — and Yrd keeps it, adding what bors lacks: automatic revision
  tracking (bors invalidates approval on push and waits for a human `r+`) and
  superproject awareness. bors-ng splits a red batch to isolate the culprit.
- **GitHub's squash strategy buys a clean linear log**, and that is a real
  ergonomic win for casual reading. The price is that the commits developers
  authored never become main; "did my exact commit ship" has
  no ancestry answer. Yrd pays the opposite price — merge commits in the log —
  and buys the answer back with `--first-parent`.
- **Gerrit's patch-set discipline is the strongest identity model**, and Yrd
  adopts its conventions at the git layer (`Change-Id:` trailers, `refs/for/`
  submission, revision numbering). But Gerrit updates are an explicit
  amend-and-push ceremony per revision, and its rebase/cherry-pick submit
  strategies can merge a sha nobody tested. Yrd's tracked branches record
  revisions from ordinary pushes, and the sha it merges is always the sha it
  tested.
- **Zuul's speculative trains are the strongest throughput model** — gate
  against the projected future state, not live trunk — and Yrd's batching is
  the same idea at smaller scale. Zuul coordinates many repositories per
  change, but by checkout composition inside the CI system; the merged
  repositories record the dependency as a change reference, never as resolved
  shas, so the tested composition is not reconstructible from git alone. Yrd
  makes the coordination durable in git itself: the superproject commit is
  the record.

The common thread: every system above answers "what exactly did we test, and
is that what shipped?" with some mixture of _trust the tool_ and _content
equivalence_. Yrd's answer is a sha equality you can check from any clone with
nothing but git.

## Why Yrd

A busy local repository has the same integration hazards as a busy hosted
repository:

- two changes can pass separately and fail together
- a branch can be tested against stale `main` and land untested
- agent work can accumulate as unexplained branches and worktrees
- a long review or remote test can block unrelated integrations
- a selected contest result can drift before it is promoted

Yrd gives every unit of work an explicit place and state. Active work is in a
workspace. Work offered for integration is a PR. Checks, reviews, merges, deployments,
logs, and artifacts belong to a queue run. Competing implementations belong to
a contest whose winner is an immutable Git commit.

That replaces ambiguous `wip-preserved-*` branches with inspectable state:

| Unmanaged state           | Yrd state                                             |
| ------------------------- | ----------------------------------------------------- |
| dirty worktree            | active worktree, not submit-ready                     |
| ahead branch              | pushed, submitted, or ready PR                        |
| branch needing repair     | draft PR plus `bay open --pr <PR>`                    |
| external CI still running | waiting queue step with URL and token                 |
| author-owned failure      | needs-author PR with typed receipt                    |
| unattributed rejection    | rejected PR with evidence                             |
| completed work            | integrated or already-landed PR and closable worktree |

Yrd does not invent commits or silently discard work. It prevents ambiguous WIP
by making the normal workflow create named workspaces and durable PRs from the start.

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
Selecting a linked worktree preserves its current-workspace and current-branch
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
A failed or interrupted child preserves the workspace as an orphan for diagnosis.
Use `yrd in` for a guest process in an already-open workspace.

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
$ yrd pr create issue/another-fix --prop request=review-42
$ yrd pr review PR2 --approve --by @alice --ref verdict-42
$ yrd pr ready PR2
$ yrd pr checks PR2 --follow
```

`pr create` records the existing `pushed` state: no submission, check request,
or Queue work is started until `pr submit` or `pr ready` (ordinary reviewed
work). `pr create` does not push a Git
branch; callers push first, then create the draft from that exact resolvable
commit. `issue ensure` is the issue-first composition of those Git-side facts:
it creates or reuses one clean issue-owned workspace and one tracked draft PR.
`bay open` and `bay run` otherwise create or reuse `task/<issue-slug>`, but
never create or recut a PR implicitly. `bay run` and explicit `bay close` push
recoverable checkpoints. Review and comment facts pin the current revision and
head SHA; a new head makes old verdicts visibly stale. Reviewer assignment and
richer policy belong to the calling coordination system.

When an author intentionally has no Git credentials, `yrd pr publish <PR>
--queue` records one durable `pr.publish` Job instead of lending credentials to
the author process. The existing Queue runner publishes the immutable submodule
pins and root carrier, then performs the requested record-and-queue continuation.
`yrd queue run --once` performs this publication work before its ordinary queue
pass; resident follow mode uses the same path. If neither runner form is active,
the Job remains `publication-required` and `pr list` / `pr view` identify both
the waiting Job and the exact `queue run --once` remedy. A terminal push error
remains visible as `publication-failed`; repeating the identical `pr publish`
request retries that same Job and preserves its props. Publication pushes
originate in fresh staging repositories so hooks from the author's checkout do
not inherit runner authority.

During development in this repository:

```bash
bun yrd --help
bun yrd
bun yrd pr runs PR1

# Open a persistent workspace, enter it, then close it explicitly:
yrd bay open --bay example
cd "$(yrd bay path example)"
yrd bay close example

# One scoped foreground child with synchronous checkpoint and cleanup:
yrd bay run @tracker/fix-release -- vi README.md

# Continue an existing delivery branch without implicitly recutting its PR:
yrd bay run --pr task/fix-release -- vi README.md

# One guest in the owner's existing workspace; from inside that workspace, omit the selector:
yrd in fix-release -- make test
yrd in

# Ensure the durable Git-side workspace and tracked draft without launching a process:
yrd issue ensure @tracker/fix-release

# Run $SHELL in a scoped scratch workspace:
yrd sh --bay scratch
```

Installed binaries are `yrd` and `git-yrd`. Workspace commands live under `yrd bay`.

On a clean child exit, `bay run` commits root-worktree changes as
`wip: <issue-or-bay>`, pushes the same task branch, and removes the workspace before
returning. `bay open` instead leaves the workspace active until `bay close`. Neither
path creates a PR or Queue record; use `pr create` explicitly, or `--pr
<selector>` to continue an existing PR's branch without recutting it. A
non-zero or abnormal `bay run` child leaves the workspace open and records a
durable `orphan` fact visible through `yrd bay list --json`. Dirty submodules
are never guessed into a publication: checkpointing fails loudly and preserves
the workspace.

A provision failure that never records a workspace path ends immediately as
`closed-degenerate`: there is no workspace to deprovision, and the branch name
is reusable. `yrd admin bay prune` is dry-run by default. Save a reviewed census
with `--save-approval <path>` (and repeatable `--exclude <bay>` selections), then
apply exactly that fingerprinted set with `--apply --approval <path>`; any census
drift refuses before mutation. Its JSON conservation report puts every examined
workspace in exactly one of `outcomes.prunable`, `outcomes.kept`, or
`outcomes.paged`, counts the same population in `histogram`, and records apply
progress in `closed`, `failed`, and `notAttempted`. An apply that examines
workspaces but closes none exits non-zero, as does any report with
missing-evidence pages.

`bay in` (also spelled root `yrd in`) attaches a guest process without opening,
checkpointing, closing, or otherwise taking ownership of the workspace lifecycle.
`bay open` takes no command; `bay run` and `bay in` default to `$SHELL`.
Top-level `yrd run` acts on queue-run records, while `yrd sh` selects `$SHELL`.
`in` defaults to `$SHELL`; any child command is opaque argv and must follow
`--`. Guests receive no host or fleet identity from Yrd. Guests never close the
owner; the inverse remains strict too—owner close reaps every guest still
holding the workspace.

An open config is explicit and deterministic. A positional config is always an
issue reference; `--issue` is its named alias and the two cannot be combined.
Use `--bay` for an issue-less friendly workspace name and `--pr` only to continue an
existing PR branch. Resolution has three product nouns:

| Noun      | Resolution order                                          |
| --------- | --------------------------------------------------------- |
| issue     | `--issue`, then the positional config                     |
| PR        | `--pr`, then the issue's live PR, then a generated branch |
| workspace | `--bay`, then the positional config, then the PR          |

## Execution records

| Concept            | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| **Issue**          | Unit of intent from km, GitHub, another tracker, or a direct caller  |
| **Workspace**      | Named isolated Git worktree for one implementation attempt           |
| **Change**         | One immutable submitted revision; `mr`/`pr` are taught aliases       |
| **Queue**          | Ordered integration process attached to a base branch                |
| **Step**           | Typed queue transition such as check, review, merge, or deploy       |
| **Job**            | Durable executable work; retries are attempts on the same Job        |
| **Contest**        | Multiple worktrees implementing the same issue for real selection    |
| **Attempt**        | One competitor's worktree, Git pin, metrics, and evaluation evidence |
| **Evaluation run** | One evaluator Job against an immutable attempt pin                   |
| **Base branch**    | Branch a queue merges into, such as `main` or `release/2.0`          |

Issue is intent. A Command is serializable intent. A Step configures work
on a Queue; a Job durably executes that work. Issue is adapter vocabulary. PR is
the Git-facing work package; Yrd does not add a second public synonym for it.

A queue is more than a branch: it is the configured integration process that
sits on a base branch. Queues do not need a separate create command. A PR creates
or joins the queue named by its base branch, and queue commands accept that base
branch directly.

## Command Model

Commands that accept `[selector...]` accept zero, one, or many selectors.
Inside a workspace, zero selectors means the current workspace. Outside a workspace, zero
selectors means all eligible work for that operation.

Selectors resolve PR ids, workspace ids, workspace names, source branches, and—where the
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
yrd branch                  move branches into a delivery state:
                            draft, submit, archive, ignore
yrd draft                   shorthand for yrd branch draft
yrd submit                  shorthand for yrd branch submit
yrd archive                 shorthand for yrd branch archive
yrd ignore                  shorthand for yrd branch ignore
```

### Branch States

A branch IS a change. Four state-targeting verbs move one INTO a state, and
there are no un-verbs: `draft` is how a submitted branch is unsubmitted and how
an ignored one is unshelved.

```text
yrd branch draft   [selector...] [--dry-run]
yrd branch submit  [selector...] [--dry-run]
yrd branch archive [selector...] [--dry-run] [-m <text> | -F <path>]
yrd branch ignore  [selector...] [--dry-run]
```

Selectors are branch names, quoted globs, or both; zero selectors means the
current branch, and a bare invocation on one of Yrd's own `yrd/` branches is
refused rather than guessed at. Every run prints the branches it resolved and
the exact `git push` it will make, so a glob's expansion is never a surprise; a
glob that matches no branch is a refusal, never a silent success.

The push IS the API. `draft`, `submit` and `ignore` write the decision ref the
receiver reads — `refs/yrd/draft/<branch>`, `refs/yrd/submit/<branch>` (valued
at the branch tip, the commit its author approves to land), and
`refs/yrd/ignore/<branch>`. Draft is the default state, so a branch that has
never been moved needs no ref at all. `archive` pushes a branch DELETION: the
shelf under `refs/yrd/archive/` refuses every direct write, and the receiver
files the branch there itself, keyed by its full old sha.

Every RULE belongs to the receiver — which writes are legal, how a new branch
is auto-classified, and why an ignore is refused while a live submit stands.
These verbs select, print and push; a refusal comes back in the receiver's own
words, unaltered.

Each state also has a bare top-level spelling: `yrd draft`, `yrd submit`,
`yrd archive`, `yrd ignore`.

Root `yrd submit` IS `yrd branch submit`. It used to alias `yrd pr submit`,
which is untouched and still drives the PR path with all of its options. The
two are the same intent at two phases — the receiver already writes
`refs/yrd/submit/<branch>` itself when a carrier is pushed — so the everyday
spelling now names that act directly.

### Workspace Operations

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
  [--prop <key>=<value>] [--composition <path>] [--json]
yrd bay close [selector...] [--withdraw] [--json]
```

`yrd bay list` shows open and in-progress workspaces by default. Use `--closed` for
terminal history or `--all` for both. List status uses the shared lifecycle
projection: `open` (blue), `working`, `done`, or `fail`; JSON preserves the
persisted workspace value in `nativeStatus`.

Queue-run records remain a separate object:

```text
yrd run cancel <selector> [--reason <text>] [--json]
```

`bay submit` is permanent cross-product vocabulary and delegates to the same
submission core as `pr submit`; `bay submit` remains a handoff, while new
callers use the PR-native required-check surface below.

| Command   | Input                                              | Output and state                                                                                                                                                            |
| --------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`    | None                                               | Lists `BAY STATUS ISSUE BY BASE BRANCH`, including durable failure and orphan facts                                                                                         |
| `open`    | Issue, `--issue`, `--pr`, or `--bay`               | Provisions a persistent workspace and returns; never runs a command or creates a PR                                                                                         |
| `run`     | Opener configuration plus exact argv               | Owns the scoped bracket, checkpoints, and closes; `--keep` preserves a clean success                                                                                        |
| `in`      | Workspace selector; optional exact argv after `--` | Attaches a PID-addressed lifecycle guest; never owns configuration or closure                                                                                               |
| `path`    | One workspace ID, name, or branch selector         | Prints the exact absolute path of one active workspace; read-only and never refreshes it                                                                                    |
| `refresh` | Zero or more workspaces                            | Re-reads Git head, base, dirty, path, and workspace status                                                                                                                  |
| `submit`  | Workspaces, PRs, or source branches                | Creates or advances PRs to `submitted`; never executes Queue work                                                                                                           |
| `close`   | Zero or more workspaces                            | Reaps and verifies processes holding each workspace, then checkpoints and deprovisions it; survivor PIDs fail loudly. `--withdraw` explicitly cancels an associated live PR |

#### Process launch boundary

Yrd owns Git-side delivery: issue resolution, workspaces, draft PR identity, re-merges, and
serialized landing. Agent selection, launch, supervision, and retry belong to the
launcher. A launcher can compose `hab run` with `yrd issue ensure` and the
ordinary PR/Queue verbs without putting agent policy in Yrd or `.yrd.yml`.

Submodule repositories are ready when `bay open` returns and before a `bay run`
child starts. Yrd
recursively materializes the recorded gitlinks while keeping each workspace's refs,
config, and working tree isolated. For every initial clone whose exact commit
already exists in the source repository, Git borrows that matching local object
store with `--reference`; only a genuinely new pin falls back to the configured
remote. Yrd records that fallback boundary in repository-local Git config as
`submodule.alternateLocation=superproject` and
`submodule.alternateErrorStrategy=info`. There is no Yrd-specific cache knob.

The Queue uses the same materializer for warm candidates and landing scratch
worktrees. This makes workspace startup and repeated checks faster, avoids redundant
network transfer and private pack copies, and still checks out the exact
candidate gitlinks. Fresh standalone clones without a local source store fall
back normally. Exact-SHA reachability proofs intentionally remain backed by
fresh remote stores, so local borrowing cannot turn an unpushed pin into a
passing delivery proof.

`bay path` resolves through the same canonical ID/name/branch selector as the
other workspace operations. It refuses unknown, ambiguous, inactive, or pathless
workspaces. Plain output is the absolute path plus one newline; JSON is the stable
`{"bay":"B1","command":"bay.path","path":"/absolute/path"}` projection.

`--issue` resolves and stores an opaque tracker-neutral reference such as
`km:@yrd/core/42` or `github:beorn/yrd#42`. Yrd preserves that link but does not
import tracker lifecycle or fleet policy. The explicit child argv runs in the
workspace; Yrd does not assign, lease, or resume workers.

A submitted PR also carries a `--title` (its subject) and a `--description`
(its body). When either flag is omitted, `pr submit` seeds it from the head
commit — the subject becomes the title and the commit body becomes the
description, with a trailing `Issue: <ref>` reference appended when `--issue` is
present. Explicit flags always win, and `pr edit` re-sets any of them on a live
PR. Both are mutable delivery metadata (unlike the immutable issue join) and are
carried forward unchanged across queue-refreshed and `pr ready` revisions. The `pr
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
yrd pr create fix/release --base release/2.0 --prop request=req-42
yrd sh --pr fix/release
yrd pr ready fix/release
```

Both submission surfaces accept `--prop <key>=<value>`, repeatable. A prop is
an opaque key=value label bound to the exact PR revision and carried on its
terminal facts; each key is a fact, set once — resetting a key to a different
value is refused.

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
yrd pr create [selector] [--base <branch>] [--issue <ref>] [--track | --no-track]
  [--title <text>] [--description <text>]
  [--prop <key>=<value>] [--json]
yrd pr submit [selector...] [--base <branch>] [--track | --no-track] [--keep-on-failure]
  [--issue <ref>] [--title <text>] [--description <text>]
  [--prop <key>=<value>] [--json]
yrd pr checkout <selector> [--bay <name>] [--json]
yrd pr list [--base <branch>] [--state <state>] [--issue <ref>]
  [--needs-review [--reviewer <reviewer>]] [--json]
yrd pr edit <selector> [--issue <ref>] [--note <text>]
  [--title <text>] [--description <text>] [--track | --untrack] [--json]
yrd pr ready <selector> [--json]
yrd pr review <selector> (--approve | --reject)
  [--by <identity>] [--ref <id>] [--note <text>] [--json]
yrd pr comment <selector> --note <text> [--by <identity>] [--ref <id>] [--json]
yrd pr checks <selector...> [--follow] [--json]
yrd pr close [selector...] [--reason <text>] --burn-payload [--json]
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
workspace transaction records the pushed revision, submission, and check request.
Ordinary `refs/heads/*` pushes remain draft intake.

Submission has two deliberately different head questions. An active workspace asks
which commit is checked out in its managed workspace after refresh, because
that workspace is the authored source being submitted. A direct branch or a PR
without an active workspace first asks whether `origin` advertises that branch. If it
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

Every live PR is tracked by default — resident “merge into latest.” Before
every Queue cycle, the resident observes the branch from `origin`; when its
tip moved, Yrd records that exact SHA as a new immutable revision, preflights
it in-process, and applies every queue-safe typed verdict before the normal
ready path.
Decision-required withdrawal verdicts remain loud for an operator. A run
always pins one frozen revision—tracking changes which revision is prepared,
never a running Candidate. `--no-track` at `pr create` / `pr submit` opts a
change out; `pr edit <PR> --untrack` stops future observation immediately,
and `pr edit <PR> --track` adopts tracking again. An untracked PR whose
branch moved refuses the implicit re-merge and prints the exact
adopt / record-once / replay remedies. Records minted before tracking became
the default behave tracked. The bit governs future rebuilds only, so editing
it on a terminal PR is refused (`track-terminal`); the submit path instead
warns and skips, keeping idempotent resubmit scripts exit-0. See
[The delivery model](#the-delivery-model).

`pr checkout` is immutable inspection: it provisions the recorded revision
head in detached HEAD and asserts the resulting workspace head before reporting
success. The PR author's live branch may remain checked out elsewhere. Use
`bay open --pr <selector>` instead when continuing authored branch work that
needs refresh or checkpoint operations.

`bay open --pr` also starts from the PR's exact recorded revision. If another
worktree owns the authored branch, Yrd materializes that revision in detached
HEAD while retaining the workspace's declared target branch and source head. Refresh
and checkpoint operations accept only descendants of that source, and
checkpoint pushes still target the PR branch. The operator never needs an
internal `--from` flag.

If provisioning fails before a workspace path exists, the durable workspace record
remains explicitly reapable: `yrd bay close --force <bay>` has no path-owned
process tree to certify, and it atomically creates or verifies a preservation
ref for any recorded head before closing. This is the terminal recovery for a
pathless workspace; creating an extra anonymous workspace is not required.

The retired `pr recut` verb has no successor spelling, on purpose:
re-merging is the queue's own act. Resubmitting from the branch tip
(`yrd pr submit <branch>`) is the one author-facing recovery for every
delivery state, and a tracked change does not even need that — the resident
records its moved head automatically. Review carry-over across a recorded
moved head is plain patch equivalence: when the proposed tip's patch equals
the approved revision's patch, the approval carries; new content needs a new
review. There are no payload certificates left to re-verify — the candidate
is rebuilt by merge and the tested object is the merged object.

The resident Queue owns both tracked-source and base freshness. It first
records and preflights branch movement for opted-in PRs, then, before each run
snapshot, compares every requested revision's immutable base with the
authoritative base; when the base advanced, it rebuilds the candidate by merge
and records the refreshed revision on the same PR with the same patch-id
lineage. The append carries an expected-current revision/head guard, so an
authored revision that arrives while Git proof is running wins and the stale
automatic result is deferred.
If the rebuild proves that current main already contains the revision's whole
payload (`head == base` with the base tree), refresh does not mint an empty
successor. It terminalizes the selected revision as `already-landed` with a
`refresh-superseded / payload-already-contained` receipt naming the current-main
SHA, equal tree hashes, and the authored patch id. Replaying the same journal
therefore performs no Git work and appends nothing.
Patch drift stays a loud, typed refusal; an independent PR can still refresh
in the same cycle.
Likewise, a tracked revision whose preflight proves `SUBSUMED-WITHDRAW` records
one revision-bound machine comment and is not queued until an operator
decides; later resident cycles do not repeat the same warning, while a new
branch push creates a new revision and is evaluated normally.
Separately, selectorless composition ejects a PR whose exact submit/check
authority was already consumed, records `pr/needs-author` with the refusal code
and the resubmit remedy, and keeps draining its healthy peers. An explicitly
targeted run still fails loud after recording the same author receipt.

Required-check refusals are revision-scoped durable facts. A refusal the
resident's remedy classifier judges to have no mechanical remedy is settled
`needs-person` (the certificate-era structurally-permanent codes that once
auto-parked lost their producers with the rewrite machinery; the
park-on-first mechanism remains for the next such code).
The settlement names the exact revision and head. Selectorless one-shot and
resident drains share the same selector, so neither process restart nor
another cadence tick can select it again or grow the journal. A new authored
or refreshed revision clears the settlement and is eligible normally. This is
Queue state, not a resident retry cache or restart budget.

`yrd queue run --once` keeps that settled refusal visible instead of reporting
`Queue idle`: human output names the refusal and its printed remedy, while
JSON includes the same canonical eligibility fact in `blocked`. A targeted one-shot reports blockers only for its
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
```

Resubmitting a terminal PR's branch (integrated, already-landed, withdrawn,
canceled) reopens or mints the delivery. The printed `resolve:` steps follow
the PR's current delivery state, so they never name a command that state
refuses.

The Queue is the only scheduler. Its journaled passed Run is also the cache:
integration reuses matching carrier-classified pre-merge work only when
resolved base SHA, head SHA, installed-step revision/config, and toolchain
fingerprint all match. Base-classified required checks always rerun before
integration, so a later same-base red lock cannot reuse an earlier green fact.
There is no TTL, invalidation database, or second workflow engine.

### Composed Source Payloads

> **Retired.** The `--composition` source-manifest rail — per-source restack,
> payload/`range-diff` certificates, and the generated root wrapper — was
> deleted with the re-merge cutover; the journal's own retained window showed
> zero composed-revision traffic. A submodule advance is an ordinary root
> change carrying its authored gitlink as a **min commit**: push the submodule
> work to that submodule's own main first, submit the root branch, and the
> queue fills each pin in from the submodule's main in its shaset commit (see
> [Superprojects](#superprojects)). A historical member snapshot that still
> declares a composition refuses loudly (`composition-retired`) instead of
> merging as an empty no-op. Component-model additions and removals remain a
> ruled, receipt-bound exception on the ordinary path.

#### Resolving Divergent Gitlink Pins

> **Legacy record.** The direct rebase-path machinery that produced
> `recut-gitlink-conflict` was deleted with the re-merge cutover; the code
> still renders from persisted historical records, and the composition recipe
> below remains valid manual practice. New work parks on the min-commit gate
> instead — see [Superproject merging](#superproject-merging).

The stable `recut-gitlink-conflict` code (visible in JSON and persisted views)
names the authoritative root and pin plus the replayed authored root and pin.
When neither submodule pin contains the other, publish a real composition
commit in that submodule, update the carrier to pin it, and resubmit the branch:

```bash
git -C <submodule> fetch --all --prune
git -C <submodule> switch -c yrd/compose-<PR> <authored-pin>
git -C <submodule> merge <authoritative-pin>
# Resolve any content conflicts and commit before continuing.
git -C <submodule> push -u origin HEAD
git add <submodule> && git commit -m "fix(yrd): compose <submodule> pins"
yrd pr submit <branch>   # or `yrd pr create <branch>` while the PR is a draft
```

This recipe is deliberately NOT a machine remedy. Its merge composes two
divergent submodule pins and can conflict, and resolving that conflict is a
judgment call. A historical `recut-gitlink-conflict` record now projects the
generic correct-and-retry resolution (its certificate-era escalation
projection was deleted with the rewrite machinery); this recipe remains the
valid manual practice for that judgment.

The composition commit must be published before the root carrier is submitted;
otherwise the Queue cannot prove the gitlink object is remotely reachable.

#### Running an Ordinary Workspace

The caller owns assignment policy. A human or another application composes the
workflow explicitly from Yrd's delivery operations:

```bash
# Claim github:beorn/yrd#42 in the caller's issue system first.
yrd bay run --issue github:beorn/yrd#42 -- \
  task-runner --issue github:beorn/yrd#42
yrd pr create task/42 --issue github:beorn/yrd#42
yrd pr ready task/42
```

The optional Contest extension creates one workspace per competitor and delegates
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
yrd admin bay prune [--exclude <bay>...] [--save-approval <path>] [--json]
yrd admin bay prune --apply --approval <path> [--json]
yrd admin pr prune [--dry-run] [--json]
yrd admin journal bump <version> [--json]
```

| Command              | Input                                              | Output and state                                                                                                       |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `list` / `ls` / bare | Optional OR filters, base, status, window, latest  | One base's pending/running/completed timeline; sibling queues stay named in the header                                 |
| `list --check`       | Repository                                         | Typed resident lease/heartbeat health, the plan the base tip declares, and the checkout's Git distance from that tip   |
| `run`                | Zero or more eligible PRs                          | Sole drain imperative; resident follow-runner by default (was `--watch`), a single pass with `--once` or PR selectors  |
| `pause`              | Optional base, required reason, optional allowlist | Pauses new runs (including retries) while active work settles; the default queue read shows the pause                  |
| `resume`             | Optional base                                      | Removes the queue pause                                                                                                |
| `recover`            | Optional reason or known-dead runner id            | Reconciles abandoned work and releases queued runs whose installed step definition changed                             |
| `finish`             | One waiting PR/step plus job/runner/attempt/token  | Records external-runner evidence and resumes that exact durable run                                                    |
| `audit`              | Repository                                         | Journal, projection, queue-progress, and derived plan findings (git vs recorded runs vs this process); no state change |

`queue list` is the canonical read-only surface. `queue ls` is its spelling
alias, bare `queue` defaults to it, and top-level `watch` is the same command
with `--watch` implied. All four forms share filters and projection semantics;
positional filters are case-insensitive OR terms over PR, Run, branch, subject,
and failure code. `--latest` is the opt-in one-row-per-PR lens; the default
preserves every matching Run. `--json` carries the same rows and summary fields
losslessly.

`queue list --check` is the process-health affordance for supervisors. It
tries the resident's existing OS lease (it never creates a second authority),
checks heartbeat freshness, reads the plan the base tip declares, and emits
`hab-service-health/1`. Exit 0 means a healthy resident owns the lease; exit 1
means no resident owns it while the queue is empty; exit 2 means unhealthy and
carries a typed error with `cause` and `resolution` steps. In particular,
submitted work with no resident is `resident-runner-missing`, never a quiet
absence. `--json` also reports the checkout HEAD and its ahead/behind distance
from the base tip (`origin/<base>` when a remote is configured).

`queue audit` is the progress-health affordance. Submitted work that never
starts required checks emits `queue-never-started` after the configured
interval, measured from that carrier's own ready time. Work that did start
required checks emits `queue-progress-stalled` after the configured no-landing
interval. A repeated exact refusal emits the more specific
`admission-refusal-loop` and inhibits the generic finding for that same queue
head, so one wedge has one actionable specimen. Findings carry stable
`specimen`, `since`, `blockedMs`, and count fields; process or lease PIDs never
participate in their identity. `--json` exits `1` when findings exist.

`queue audit` is also the plan audit, and it is derived — there is no written
baseline. It reads the step plan `.yrd.yml` declares at the base tip and
compares it with the plan this process installed (`installed-plan-stale`: a
declared step with no Job here means every Run would refuse with
`declared-step-not-installed`, so the finding names the step and the restart)
and with each of the most recent recorded Runs' plans against git at their own
base shas (`run-plan-mismatch`: equal by construction, so a delta means the
journal and the repository disagree about what judged that Run). Every side is
printed with the sha it was read from, and the denominator is printed whether
or not anything was found — how many Runs were read and compared, which were
explicit `--steps` selections and so not comparable, and whether the config
changed since the latest Run (both blob shas). An empty journal prints
"0 runs compared against tip `<sha>` blob `<sha>`", never "no drift".

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

The resident re-reads the plan the base tip declares before every working
cycle (the installed leg of the plan audit, nothing from the journal). Each Run
already reads its own plan from git at its base sha and refuses a step this
process cannot execute, so correctness never depends on this gate; what the
gate buys is the remedy. An `installed-plan-stale` finding asks the resident
host to unwind its heartbeat and leases, close its runtime, and `execve` the
exact same argv and source in place. The OS PID stays stable while the
reconstructed host loads the current repository configuration and mints a new
driver epoch; before unwinding, the resident writes the finding into its
durable heartbeat so the cause survives the control transfer. If `execve`
itself fails, Yrd reports `runtime-reload-exec-failed`, exits with the
infrastructure code `3`, and Hab restarts the unchanged argv. A one-shot run
refuses instead of reloading itself. `yrd admin queue init` and `deinit`, which
used to write and remove the baseline file, are retired and refuse by name.

Consecutive reloads are bounded. The exec env carries `YRD_RUNTIME_RELOADS`,
a clean gate pass resets it, and a fourth stale gate in a row refuses with
`installed-plan-reload-exhausted` — naming the tip, the blob, the count and
the by-hand restart — instead of exec'ing forever against a plan this source
cannot build or a tip that keeps moving. The heartbeat also publishes the
resident's `installedPlan` (batch size and full step descriptors), which is
what `queue list --check` compares against the tip: the probe builds no
runtime of its own, so its plan-audit leg reads the published set, reports
`installed-plan-stale` when the tip declares a step the resident lacks, and
says "published no installed plan" for a resident older than the field
rather than comparing nothing.

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
host and, where a terminal multiplexer exposes it, pane provenance. Normal exit and graceful
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

Each competitor receives the same issue snapshot and base commit in its own workspace.
Yrd records wall time, token counts, reported USD cost, stdout/stderr,
artifacts, the write-once attempt ref, and evaluator results. Missing metrics
remain missing; Yrd does not guess cost.

The issue list/view lens is read-only and joins delivery facts to tracker
references; issue creation and editing remain in the tracker. `issue ensure`
is the sole mutating issue subcommand: it idempotently ensures one clean
issue-owned workspace and one `track: true` draft PR. It does not assign a worker,
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

A check may pin the scripts its command executes to the base ref:

```yaml
checks: [{ lint: { run: bash tools/lint.sh, scripts: [tools/lint.sh] } }]
```

Declared `scripts` paths (files or directories, repo-relative, local runner
only) execute at the BASE ref's version, exactly like this config file: before
the command starts, every declared path that differs is materialized from the
candidate's base sha into the execution checkout and restored afterwards, so a
change that edits its own gate script is judged by the pre-edit script — the
edit takes effect for the NEXT change. The paths' object shas at the base are
folded into the step's derived revision, so the run record names the script
version that judged it and `yrd queue audit` sees a landed script edit as a
plan change. A declared path the base does not hold refuses loudly, at startup
and again at execution.

Merge is not a configurable check. It is Yrd's built-in landing transition, and
post-landing effects belong to subscribers. The managed pre-submit hook and
`pr submit`/`pr ready` run the same configured list for fast local feedback.
The Queue runs it once more against the exact Candidate before the built-in
merge. Skipping the hook therefore costs feedback latency but cannot weaken the
landing gate. Run one configured check explicitly with `yrd check <name>`.

### Guards — the cheap half of the local gate

A check answers "would this land green?" and buys that answer with a
quarantined checkout, a submodule population and a workspace install. That is
the right price for a landing gate and the wrong one for an authoring rule: a
repository whose lint refuses a twelve-character title should not make the
author wait two minutes and spend a queue slot to hear it.

A `guard` is the other shape. It runs in the invoking working repository, in
one process spawn, **before the revision is registered** — so a refusal costs no
queue slot and arrives while the author is still at the terminal:

```yaml
guards:
  - doc-hygiene:
      run: bun tools/lint-doc-hygiene.ts --base "$YRD_BASE_SHA" --candidate "$YRD_CANDIDATE_SHA"
      paths: ["docs/**/*.md"]
```

Every guard is given `YRD_REPO`, `YRD_BASE_SHA`, `YRD_CANDIDATE_SHA` and
`YRD_GUARD` in its environment, and its exit code is the verdict. On a non-zero
exit the guard's own stderr is surfaced verbatim — Yrd cannot reconstruct which
file, which measurement or which repair, so it never summarizes them away.

`paths` scopes a guard to the files it is about, matched against
`git diff --name-only <base>...<candidate>` (three-dot, so commits base gained
after the fork are never the author's problem). A candidate matching no glob
**does not spawn the command at all**, which is what keeps a repository-wide
authoring rule from taxing every code-only carrier. A guard with no `paths`
always runs. A guard bounds itself with `timeoutMs`, defaulting to 60s.

Guards run ahead of checks in `pr submit`, `pr ready` and the managed
pre-submit hook, and short-circuit. They are deliberately **not** re-run by the
Queue: a guard is an authoring rule, not landing evidence. Skipping the hook
therefore skips guards entirely, which is a feedback loss and never a weakened
landing gate. Run them on demand with `yrd guard [name...]`.

The command belongs to the repository, so Yrd stays agnostic about what is
being guarded — it owns only when a guard runs, what it is told, and how a
refusal surfaces. When the tool lives outside the repository being guarded
(a monorepo might keep its lint tooling in the code repo while the tracked
work items it checks live in a separate state repo), point `run` at it by
absolute path or through a wrapper on `PATH`; the guard's cwd is always
`YRD_REPO`, so the candidate it must read and the tool that reads it need not
share a checkout.

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
fully retired base is not hidden merely because no live workspace or Queue names it.

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
under the configured worktrees root. Before a built-in or inline check runs, Yrd
provisions that worktree from the Candidate's committed Bun, pnpm, or npm
lockfile instead of borrowing mutable host packages. Frozen installs disable
all lifecycle scripts, including a Candidate's `postinstall`. Owner-controlled
workspaces may opt into the repository's `postinstall` for first-party code
generation. A missing lockfile or failed install is a
retryable `queue-environment-refused` with `candidate-provision-failed`
evidence, never a false failed-check verdict. Workspaces use the same
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
yrd pr create task/release-fix --base release/2.0 --prop request=release-2.0
yrd pr ready task/release-fix
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
into workspace, PR, Queue, Job, and Contest state. Snapshot publication moves covered
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
The `bay` receiver is a push default only inside provisioned workspaces. Host
startup removes the legacy shared `remote.pushDefault=bay` setting if present,
so plain `git push` in the primary worktree continues to use its normal remote.
Because Yrd enables the `worktreeConfig` extension to scope those workspace push
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
- **A fleet coordinator** may configure Yrd for many agents at once, but fleet
  policy stays outside Yrd.

The low-level packages remain usable by a single developer with no agent fleet.

## Packages

| Package            | Responsibility                                                   |
| ------------------ | ---------------------------------------------------------------- |
| `@yrd/core`        | Immutable definition, Commands, Events, projection, Journal      |
| `@yrd/persistence` | WAL SQLite Journal, snapshots, migration, and writer exclusion   |
| `@yrd/process`     | Scope-owned subprocess execution, bounds, cancellation, evidence |
| `@yrd/job`         | Durable executable lifecycle, leases, waiting work, recovery     |
| `@yrd/issue`       | Issue references, snapshots, and source adapters                 |
| `@yrd/bay`         | Worktrees, PR intake, Git workspace, and receive hooks           |
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
distribution and public docs; local workspaces, tests, and repository work state are
excluded from its tarball.
When Yrd is source-linked as a submodule inside a larger monorepo, use `bun check:hh`;
that explicit config supplies sibling source declarations without leaking them
into standalone package resolution.
The focused Vitest files under each package are executable contracts for the
same public flows. [TODO.md](TODO.md) contains only open acceptance work and
post-cutover fixes; background research stays outside the public repository.
