# git bay

**git bay** is a small continuous-integration server that lives inside your git repository: you work in a disposable worktree, plain `git push` opens a local pull request, and asking it to merge (`git bay submit`, or a fused push) gets it checked and landed onto main — one PR at a time, so main is never broken. No hosted service, no background daemon — it's a plain CLI.

The idea in one sentence more: anyone working in a local clone — human or agent — should get the integration safety a good team gets from GitHub (workspaces, PRs, checks, a merge queue, a full record), with plain git as the interface and nothing new to learn beyond the words GitHub already taught everyone.

> **Yrd:** this repo is becoming the bay component of **Yrd**, the software delivery yard — `yrd bay …` and `git yrd …` work today as aliases of `git bay …`, and `yrd line status|audit|integrate|watch` now projects the current integration path; see [docs/yrd.md](docs/yrd.md). Existing workflows are unchanged. The next Yrd milestone is hardening the line for the `@ci` cutover; contest mode comes later and does not block that cutover.

## Why you'd want it

**You want git bay if…**

- you run a team of coding agents that produce more merges than a human can referee
- you want merge-queue safety with no hosted service and no daemon
- you have a superproject full of submodules and want changes across them to merge as one unit — like a monorepo
- you want worktrees and merging in one self-contained tool that lives entirely inside your repo

In any busy repository, the main branch is a zone of contention: two changes can each pass tests on their own and still break main when merged together, a branch can be tested against last week's main and land untested against today's, and a submodule pointer can silently move backwards, undoing work that already landed — with no record afterward of what merged, when, or why. It becomes acute with agent fleets, since agents merge far more often than people do.

## How it works, in 30 seconds

`git bay init` stores a small amount of state inside your repository's `.git/` directory: a queue database, an event journal, and a miniature bay-owned git repository whose *hooks* are the whole trick.

`git bay open <name>` opens a **bay**: a named loan of a **worktree** — an isolated checkout, an extra working directory sharing the same repository — already wired so that its `git push` goes to that bay-owned repo. When you push, the hooks fire: your checks run, and only if they pass does your PR merge onto `main`. The verdict prints right in the push output. (git labels hook output `remote:`, even though everything here is on your machine.)

```console
$ cd "$(git bay open fix-readme)"                 # a bay for this piece of work
$ ...edit...
$ git commit -am "docs: fix readme"               # plain git from here on
$ git push                                        # opens PR1 — nothing runs yet
remote: bay: PR1 opened — git bay submit PR1 when ready
$ git bay submit PR1                              # ask to merge — lands it too, by default
bay: PR1 submitted → checking
bay: PR1 checking → checked
bay: PR1 checked → merging
bay: PR1 merging → merged — merged 7739dd05897d5f7729ec64b6293576f1bf37177e onto main
$ git bay ls PR1
PR1 merged 7739dd05897d5f7729ec64b6293576f1bf37177e onto main (checks: ✓)
```

That is real output from a live run, with no `bay.autoSubmit`/`bay.autoMerge` config set at all. Opening a PR and asking to merge it are two separate acts, like a real GitHub PR — but by default `submit` doesn't stop at "asked", it lands the PR too (`bay.autoMerge`, on by default): checks, then a zero-config native merge. Set `git config bay.autoMerge false` to make `submit` lazy again — it rests at `submitted`, and `git bay integrate PR1` (or `git bay check`/`git bay merge` for either half alone) is the separate step that lands it. Set `git config bay.autoSubmit true` to go the other way — a bare `git push` submits too, so (with `autoMerge` still on) push alone ships the PR, no `submit` needed. `git push -o submit`/`-o wait` do the equivalent for one push at a time, without a config change. Whichever knobs are set, there's no way to skip the checks by accident.

The lifecycle, end to end: **open** a bay → **push** (fills the PR with commits) → **submit** (ask to merge — and, by default, land it) → **close**. See [docs/model.md](docs/model.md) for the full states-and-verbs picture this is a projection of.

Two things worth knowing that don't show up in the demo above:

- **A branch made by hand, outside any bay, still gets in.** `git bay adopt <branch>` mints it a PR (lands in `pushed`) without ever opening a worktree; `git bay submit <PR>` then asks to merge it, same as any other PR.
- **Push doesn't have to go through a bay at all.** Only a push from *inside* a bay — whose git remote points at the bay-owned repo — trips gitbay's hooks. An ordinary `git push` to your real remote (GitHub, a teammate's fork, CI) is completely unrelated; publishing to that remote after a local merge is its own separate step (many setups have the merge command itself push on success).

## Principles

1. **Plain git is the interface** — push opens a PR, submit asks to merge it; state lives in `.git/bay/`.
2. **Borrowed vocabulary, zero invention** — PR, open, close, submit, integrate, checks: every word means what GitHub taught it to mean.
3. **Integration is serial and proven** — one change at a time; a merge command's exit 0 is a claim, ancestry against refreshed main is the proof.
4. **Refusals teach** — every "no" states what was checked, what failed, and the exact command that fixes it.
5. **History is data** — every event appends to one journal; counts, stats, and traces are folds over it, so recurring problems show up as numbers.

## What you get

- **Main is always checked** — PRs land one at a time, each verified against main *as it is now*, so an untested combination can never land.
- **Your workflow doesn't change** — after `git bay open`, it's ordinary `git pull` / `git commit` / `git push`; verdicts appear as `remote:` lines in the push output, where git users already look.
- **Errors that teach** — a refused push names what failed *and the exact command that fixes it*. The error messages are part of the product.
- **Safe with submodules** — a parent commit and its submodule commits land together or not at all; a pointer that would move backwards is refused, at commit time and again at the door.
- **Batches when it is safe** — set `bay.queue.batch-size` above `1` and `integrate` composes compatible queued PRs into one checked candidate; conflicting or red members are ejected and the clean remainder lands.
- **Names connect to your issue tracker** — every bay is opened for a named piece of work; validation and lifecycle callbacks are each one configured command.
- **Plug in your own tools by running commands** — checks, review, tracker, notifications: each is an external command the bay calls. No SDK.
- **A complete record** — every event appends to one JSONL journal: what was submitted, what the checks said, what merged. Replayable, resumable, greppable.
- **No daemon** — the plain CLI gives all of the above; a background service is optional (roadmap).

## Layers

git bay is built as an event-sourced core plus `with*()` layers — each layer registers verbs, events, a state slice, and effect handlers, and the whole tool is one `pipe()` composition. Remove a layer and the system degrades to the rung below instead of breaking (without worktrees, `adopt` + `submit` + `integrate` is a pure merge queue for people who bring their own branches). In Yrd terms, these layers are being split into packages: `@yrd/core`, `@yrd/bay`, `@yrd/line`, `@yrd/task`, `@yrd/contest`, and `@yrd/cli`. The shipped code is mostly `@yrd/bay` plus the first line/integration machinery. Each layer has its own page in [docs/](docs/):

| Layer | Tier | What it does |
| --- | --- | --- |
| core (`createGitbay`) | — | journal · fold · dispatch · typed events · the [store seam](docs/store.md) (sqlite default; adapters are ~a page) |
| [`withWorktrees`](docs/layers/worktrees.md) | core | bays: named loans of pooled, numbered worktrees; pooling is an option of this layer |
| `withQueue` / `withReceive` / `withIntegrate` | core | the PR queue, the push door, the serial verified merge |
| `withBatchBuild` | core | optional batching: compatible queued PRs become one candidate; conflict/red members are ejected and the remainder is rebuilt |
| [`withSubmodules`](docs/layers/submodules.md) | core, auto-armed | pin-rewind refusal, atomic super-repo landings, pin audit |
| [`withIssueTracking`](docs/layers/issue-tracking.md) | optional | validate names at open; auto-close/comment issues on PR outcomes |
| [`withChecks`](docs/layers/checks.md) | optional | your commands at lifecycle points (provision, open, push, submit, integrate, merged) |
| [`withReviewGate`](docs/layers/review-gate.md) | optional | approval before integrate; `approve`/`reject` are the whole review-tool surface |
| `withStats` | optional | read-only folds: rejections and refusals by reason code ([events](docs/events.md)) |

Target composition (v0.3 shape — today's layer names differ slightly):

```ts
pipe(
  createGitbay({ store }),           // journal · fold · dispatch
  withWorktrees({ pool }),
  withQueue(), withReceive(), withIntegrate(),
  withSubmodules(),                  // auto-armed when .gitmodules exists
  withTaskIntake(config.tasks),
  withChecks(config.checks),
  withReviewGate(config.review),
  withStats(),
)
```

Yrd target package shape:

| Package | Owns |
| --- | --- |
| `@yrd/core` | records, event contracts, plugin composition, typed state shapes |
| `@yrd/bay` | bay lifecycle and the Git-native implementation shipped here |
| `@yrd/line` | integration queues, steps, merge/deploy execution, artifacts, status, resume, CI cutover path |
| `@yrd/task` | task intake from km beads, GitHub issues, and other trackers |
| `@yrd/contest` | multiple attempts for one task and winner selection |
| `@yrd/cli` | command projection from installed plugins |

The immediate implementation target is `@yrd/line` well enough that `@ci` can
switch from bespoke tent integration to Yrd bay+line operations. The contest
package is later: useful, but not required for CI.

Configuration is unifying into one committed file whose sections mirror the layer names (today it's a few `git config bay.*` keys — `bay.check`, `bay.mergeCommand`, `bay.issues.validate` + `bay.issues.on-merged`/`on-rejected`/`on-closed` (`bay.tracker` = deprecated spelling of validate), `bay.queue.batch-size`, `bay.queue.regen-paths`; those retire when this lands). In the Yrd config, `tasks` is the tracker-agnostic intake layer; GitHub issues are one adapter behind it:

```yaml
store: sqlite                        # or: km — PRs as nodes, queue order = tree order
worktrees: { pool: { prewarm: 2 } }
tasks:
  validate: gh issue view {name}
  on-integrated: gh issue close {name} --comment "integrated as {sha} ({submission})"
line:
  steps:
    check: bun run lint && bun run test
    merge: git merge --ff-only {target}
    deploy: bun run deploy
  batch: 4
  artifacts: .git/yrd/artifacts
review: { required: false }
queue: { limit: 10 }
```

Two name systems, deliberately: config sections are nouns matching layers (settings); slash names like `bay/open` → `bay/opened` are actions and facts (requests and events — see [docs/events.md](docs/events.md)).

## What it adds to your repository

Everything git bay stores lives in two places — there is exactly **one merge queue per repository**, and this is all of it:

```text
.git/
├── config            a few bay.* keys (until config unifies into .gitbay.yml)
└── bay/              all of git bay's state — inside .git/, where git clean can never delete it
    ├── bay.db        queue + worktree state (SQLite)
    ├── journal.jsonl append-only event journal — the merge history
    └── repo.git/     bay-owned bare repo; its receive hooks are what make push-opens-the-PR work
.bays/                your worktrees (ordinary git worktrees): wt1, wt2, …
```

Your repository's own hooks, branches, and remotes are untouched. Removing git bay is deleting `.git/bay/` and `.bays/` and unsetting the `bay.*` config keys.

## Common questions

**How do I onboard a coding agent (or a new teammate)?** `git bay guide` prints everything needed before the first action — the loop, the rules, the vocabulary — followed by a live "as of right now" snapshot of this repository's bay. Put `git bay guide` in your agent's startup instructions and the tool onboards the agent itself.

**Is this a GitHub PR?** Same idea, local: a PR is your commits traveling to main as one unit, numbered per repository (PR1, PR2, …). A push opens it (phase: `pushed`); `git bay submit` is the "ask to merge" step (`pushed → submitted`), and by default it doesn't stop there — it auto-integrates, running the checks and landing it too (`bay.autoMerge`; set it `false` for a `submit` that only asks, with `git bay integrate` as the separate landing step). A bay PR is local — GitHub does not see it and `gh` commands do not apply.

**How do I tell it what checks to run?** `git config bay.check '<command>'` — the bay runs it before merging; exit 0 means pass. Repositories with their own merge process route the merge through `git config bay.mergeCommand '<command with {target}>'`, used by `git bay merge`/`integrate`.

**How do batches work?** `git config bay.queue.batch-size 4` lets `git bay integrate` compose up to four compatible queued PRs into one `bay/batch/<PR>` candidate. Build conflicts eject the faulting PR immediately. If the candidate fails the configured `bay.check`, git bay checks the saved prefix refs, ejects the first red member, rebuilds the remainder, and lands it.

**What happens when a check fails?** `check`/`integrate` rejects the PR and the message says why (`git bay ls <PR>` shows it too). If the fix needs new commits, just `git push` again (or `git push -o submit`/`-o wait` if you'd fused the steps) — the PR keeps its number, next revision. If the fix changed no commits, `git bay retry <PR>` re-runs the pipeline.

**What exactly is a bay? A worktree? A name?** A **worktree** is the numbered, persistent directory (ids look like `wt1`) — reused across pieces of work. A **bay** is the named, ephemeral *loan* of one worktree to one piece of work — opened by `git bay open <name>`, disposable and yours alone. The **name** is what you called the work at `open` — any label, or a ticket id your tracker knows. Bay verbs (`close`, `refresh`, `gc`) act on bays; PR verbs (`ls`, `adopt`, `submit`, `check`, `merge`, `integrate`, `retry`) act on PRs — and every argument accepts a wt-id or a name.

**Can it lose my work?** Closing a bay with uncommitted changes is refused. Closing a bay whose PR hasn't reached a terminal state (pushed, submitted, checking, checked, merging, reviewing, or rejected) is also refused — the message names your options (integrate it, retry it, or `close --withdraw` it). `--withdraw` itself only resolves a PR that's resting (pushed, submitted, checked, rejected, or reviewing); one still actively checking or merging must finish first. When `gc` retires an idle bay, it snapshots the branch tip to a findability ref first. Nothing is ever deleted.

**What if two agents push at the same time?** Merges are strictly serial: submissions are ordered by the queue and recorded in the journal — they never race each other onto main.

**Does this replace GitHub or GitLab?** No. git bay manages your *local* main branch. Publishing that branch to a remote stays whatever it is today — many setups have the merge command itself push on success.

## Status

**Shipped.** Every verb below works today (`git bay help` for the live list):

*Start here*: `guide` (onboarding + live config snapshot) · `init` (set up: store, journal, bay-owned repo + hooks)

*Your bay*: `open <name>` (open a bay; prints a cd-able worktree path) · `close <wt|name>` (refuses if the bay's PR hasn't reached a terminal phase or the worktree is dirty; `--withdraw` closes the PR too) · `gc` (expire idle bays, snapshot first)

*PRs*: `ls [PR|name]` (BAY + WORKTREE table, plus every unmerged PR and batch summaries, `--json`) · `adopt <branch>` (create a PR for an existing branch — no bay needed; lands in `pushed`) · `submit <PR|name>` (ask to merge — `pushed → submitted`; auto-integrates to `merged` by default, `bay.autoMerge false` rests it at `submitted`) · `check <PR|name>` (run the project check alone — `submitted → checked`; never merges) · `merge <PR|name>` (land a checked PR — `checked → merged`; refuses one that isn't checked) · `integrate [PR|name]` (the umbrella — check then merge, or the configured batch; `--watch` keeps draining) · `retry <PR|name>` (put a rejected PR back through the pipeline)

*Repository health*: `audit` (strays, stale pins, refs without a name, `--json`)

Unambiguous prefixes work (`git bay au` is `audit`; `o` is `open`); every pre-v0.3 verb (`new`, `co`, `status`, `land`, `queue`, `abandon`, …) still works as an unadvertised alias, and `install`/`setup` are hidden aliases of `init`; `in`/`int` are shorthand for `integrate`. A merge command's exit code is never taken on faith — a PR only counts as merged when it is provably an ancestor of the refreshed main branch. Every event a command produces — the journal row AND everything its effects emit — carries that command's `cause` (a `commandId`, plus `traceId`/`spanId` when the CLI sees a `TRACEPARENT`); see [docs/events.md](docs/events.md).

**Roadmap** (details in the layer pages):

- **Next — Yrd line hardening + `@ci` cutover**: `yrd line status|audit|integrate|watch` projects the current integration path today, with installed `check` and `merge` steps. Next, capture step artifacts/logs, strengthen folded status/staleness, support journal-driven resume for same submission+commit, add the remote-runner seam, and move the CI integration lane onto it.
- **Then — package split + config**: split toward `@yrd/core`, `@yrd/bay`, `@yrd/line`, `@yrd/task`, `@yrd/cli`; unify `bay.*` git-config keys into the Yrd config shape with `tasks` as the tracker-agnostic intake layer.
- **Then — review/RPC/adapters**: review gate, JSON-RPC, km/ag/hab/GitHub adapters as real subscribers appear.
- **Later — contest mode**: multiple agent/harness attempts for one real task with manual winner selection first.

Repository docs are the product contract. `README.md`, `docs/`, and
`tests/*.spec.md` should be public-suitable product/API/behavior docs. Any
future repo-local `spec.md` should be an executable or final behavior-facing
spec, not exploratory design. Tentative reference, background research, and
prior-art notes belong outside this repo in `hub/yrd/reference` or in `@yrd`
beads.

## The docs are tests

Four documents in [tests/](tests/) — [gitbay.spec.md](tests/gitbay.spec.md) (the normal workflow), [batch.spec.md](tests/batch.spec.md) (batch happy/eject paths), [refusals.spec.md](tests/refusals.spec.md) (every refusal and its fix), and [guide.spec.md](tests/guide.spec.md) (the agent-onboarding printout) — are executable specifications: [mdspec](https://mdspec.org/) runs every console block and checks the output character for character (`bun run spec`). If the docs drift from real behavior, the test suite fails.

## License

MIT
