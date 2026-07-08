# git bay

**git bay** is a local PR intake and merge line for git repositories: you work
in an isolated bay, plain `git push` opens or updates a local PR, and git bay
checks and lands that PR onto a base branch one at a time.

No hosted service is required. The interface is plain git plus one small CLI.

The idea in one sentence more: anyone working in a local clone, human or agent,
should get the integration safety a good team gets from GitHub: workspaces, PRs,
checks, review, a merge queue, and a full record, with plain git as the
interface.

## Why You'd Want It

You want git bay when:

- agent fleets produce more merges than a human can referee
- you want merge-queue safety without a hosted service or daemon
- branches need to be tested against the base branch as it is now, not as it was
  when the branch forked
- a superproject and its submodules need to land as one unit
- you want worktrees, PR intake, checks, review, deployment, and cleanup in one
  self-contained local tool

Busy local repos have the same integration problem as busy remote repos. Two
changes can each pass alone and still break when combined. A branch can be
tested against stale main and then land untested. A submodule pointer can move
backward and orphan work that already landed. Those problems become acute when
agents produce changes faster than people can inspect, order, and merge them.

## How It Works

`git bay init` stores state under `.git/bay/`: an event log, a query index, and
a bay-owned bare Git repo whose receive hook is the intake door.

`git bay open <name>` opens a **bay**: a named loan of an isolated worktree,
already wired so its `git push` goes to the local PR intake. Pushing fills the
PR with commits. Submitting hands it to the line. The line runs configured
steps, proves the result against the refreshed base branch, and records the
verdict.

```console
$ git bay init
$ cd "$(git bay open fix-readme)"
$ ...edit...
$ git commit -am "docs: fix readme"
$ git push
remote: bay: PR1 opened — git bay submit PR1 when ready

$ git bay submit PR1
bay: PR1 submitted

$ git bay line integrate PR1
bay: PR1 checking → checked
bay: PR1 merging → merged — merged onto main

$ git bay ls PR1
PR1 merged onto main (checks: ✓)
```

That is the whole loop: **open** a bay, **push** commits, **submit** the PR,
**integrate** it through the line, then **close** the bay. Repositories that want
the shortest path can let `submit` run the default line steps; repositories that
want an explicit operator keep `submit` as handoff and run `git bay line
integrate`.

Branches created outside a bay still enter through the same model:
`git bay submit <branch>` opens a local PR without provisioning a worktree, and
`git bay open <name> --from <branch>` opens a bay when that branch needs repair.

## Concepts

- **Bay**: a named worktree assigned to one piece of work for its duration.
- **PR**: the local pull request created or updated from bay commits (`PR1`,
  `PR2`, ...). It lives inside this clone; it is not a GitHub/GitLab PR.
- **Line**: the serial integration process that sits on a base branch. It
  checks, reviews, merges, and optionally deploys PRs into that branch.
- **Base branch**: the destination branch a PR merges into. The default line
  sits on the repository default branch; additional lines sit on other base
  branches such as `release/2.0`.
- **Branch**: the source branch for the PR. By default it shares the bay name.
- **Selector**: a PR id, bay id, bay name, source branch, or base branch used to
  tell a command which work or line to operate on.

When `git bay open` creates a bay, it creates a worktree under `.bays/` and
wires its `bay` remote to `.git/bay/prs.git/`. Plain `git push` from inside a
bay targets that local PR intake, not `origin` or another hosted remote. Outside
a bay, git behaves normally; landed work appears on the local base branch and is
published upstream by pushing that branch when desired.

Closing a bay returns the worktree. Withdrawing a PR cancels it from the line;
that only happens by explicit request, or by closing a live bay with
`--withdraw`.

Separating `push` from `submit` lets workers push incremental progress without
asking the line to land it. `submit` is the explicit handoff from bay to line.

## PR Lifecycle

Top-level PR status is derived:

- `open`: any PR not merged or closed
- `merged`: landed and verified on the base branch
- `closed`: withdrawn without merging

Open PR phases:

```text
pushed -> submitted -> checking -> checked -> [reviewing] -> merging -> merged
                       \-> rejected --retry--> submitted
checked/reviewing/rejected --new push--> pushed
pushed/submitted/checked/reviewing/rejected -> closed
```

`reviewing` appears only when an async review step parks on external approval.
The line does not block on parked PRs: it skips waiting work, integrates the
next runnable PR, and rechecks parked work against the latest base before
landing. Check and review verdicts bind to the PR tip SHA; a new push
invalidates them and returns the PR to `pushed`. `closed` is a PR state, not
normal bay cleanup: `git bay close` changes PR state only when `--withdraw` is
used on a live PR. Deployment is a configured step over landed state; a failure
records a deploy verdict and may stop the line, but cannot revoke `merged`.

## Workflow

```text
open a bay -> work with git -> push -> submit -> line integrate -> close
```

- `git bay open <name> [--base <base-branch>]` creates an isolated worktree and
  wires its `bay` remote to git bay's local PR Git repo.
- `git push` from inside that bay creates or updates a local PR and leaves it at
  `pushed`.
- `git bay submit <branch>` can also submit a source branch directly to its base
  branch or `--base`.
- `git bay submit [selector...]` moves the PR to `submitted`. With `bay.autoMerge`
  enabled, submit also runs the default line steps.
- `git bay line integrate [selector...] --steps ...` runs selected line steps.
- `git bay close [bay...]` returns the worktree after work is clean and the PR is
  terminal; `--withdraw` cancels a live PR first.

Selector rules:

| Selector | Example | Resolves to |
| --- | --- | --- |
| PR id | `PR3` | that PR |
| bay id or name | `fix-readme` | that bay and its PR |
| source branch | `task/fix-readme` | the PR on that branch |
| base branch | `release/2.0` | the line on that branch |

With no selector inside a bay, the active bay's PR is used. With no selector
outside a bay, list/audit commands operate on all visible items and
`line integrate` operates on the next eligible line item.

## No Unmanaged WIP

Active work is normal. The target is that no surviving branch, ref, or worktree
is unexplained. Every piece of work should be an active bay, submitted PR,
waiting step, rejected PR, blocked exception, merged result, or prunable relic.

| Raw WIP | Git bay state |
| --- | --- |
| dirty worktree | active bay with owner/name |
| ahead branch | PR at `pushed` or `submitted` |
| branch needing repair | `open <name> --from <branch>` |
| failed tests | `rejected` with check verdict |
| merge conflict | blocked/rejected with conflict evidence |
| missing work item | audit exception, not queued |
| already ancestor of base | terminal/prunable |
| preserve/archive ref | closed/prunable or named exception |

git bay can safely auto-advance landed refs, clean inactive bays, hook/config
repairs, serial submission of clean branches, and whitelisted mechanical fixes.
It should not auto-fix semantic conflicts, unclear ownership, red tests with
product meaning, vendor gitlink ambiguity, or "which version wins" decisions.
Those become visible exceptions with evidence.

## Commands

Command docs are a contract: what the command accepts, what it prints, what state
it changes, and what exit codes mean.

General command rules:

- Commands read arguments, options, git config, environment, and repository
  state. They do not read stdin except hidden receive-hook modes.
- Human output goes to stdout. `--json` emits stable JSON to stdout.
  Diagnostics and underlying git/hook output go to stderr.
- Exit `0` means the requested action completed or a status command reported
  successfully.
- Exit `1` means a domain refusal or verdict the user can act on: dirty close,
  check failed, merge conflict, audit findings, closed-door push.
- Exit `2` means usage or configuration error.
- Exit `3` means infrastructure or state corruption: git unavailable, corrupt
  event log/index, lock failure, or any failure not covered by `1` or `2`.

### General

| Command | Input | Output | State / Exit |
| --- | --- | --- | --- |
| `git bay guide` | none | onboarding text plus resolved config | no state change; exits `0` |
| `git bay ls [selector...]` (alias: `status`) | zero or more PRs, bays, names, branches | table or JSON for bays, PRs, lines | exits `0`; exits `1` only for requested missing/invalid selectors |
| `git bay init` | repository path from cwd | initialized state paths and hook summary | creates `.git/bay/`; exits `0` or setup error |
| `git bay audit [selector...]` | optional repo/base/PR/ref scope | findings: orphaned branches, submodule rollbacks, dangling refs | exits `0` clean, `1` with findings |
| `git bay prune` | optional policy flags | reclaimed bays/worktrees | removes only inactive closed bays; snapshots refs first |

The `status` alias resolves to `ls`; line state uses `line status`.

### Bay Ops

| Command | Input | Output | State / Exit |
| --- | --- | --- | --- |
| `git bay open <name> [--from <branch>] [--base <branch>]` | work name, source branch defaulting to name, optional base branch | worktree path to stdout; PR/base/branch details to stderr | opens a bay and reserves a PR; refuses invalid names |
| `git bay refresh [bay...]` | zero or more bay ids/names | refreshed bay ids | resets idle clock so live work is not pruned; missing bay exits `1` |
| `git bay submit [selector...] [--wait] [--base <branch>]` | active bay, PR, name, or source branch | PR transition and line verdicts | moves to `submitted`; may run default line steps; `--wait` returns on terminal verdict or parked waiting state |
| `git bay close [bay...] [--withdraw]` | zero or more bays | closed bay summary | refuses dirty work; live PRs require `--withdraw`; merged/closed PRs are safe |

### Line Ops

| Command | Input | Output | State / Exit |
| --- | --- | --- | --- |
| `git bay line status [selector...]` | zero or more base branches/PRs | per-line state, queued/running/done items | no state change; exits `0` |
| `git bay line integrate [selector...] [--steps <step,...>] [--retry] [--watch]` | zero or more PRs/base branches | step-by-step verdicts; `--watch` streams output | runs registered steps; skips parked PRs; domain failures exit `1` |

### Plain Git

| Command | Input | Output | State / Exit |
| --- | --- | --- | --- |
| `git push` inside a bay | committed branch tip | `remote:` lines naming the accepted/refused PR | pushes to local PR intake, not `origin`; outside a bay, git is normal |

## Configuration

Small repos can use git config:

```bash
git config bay.check '<command>'          # line check step; exit 0 passes
git config bay.merge '<command>'          # merge override; {branch}, {base}, {pr}
git config bay.deploy '<command>'         # deploy step after merge; exit 0 passes
git config bay.issue '<command>'          # validate bay names; {name}
git config bay.review '<command>'         # review gate; {pr}, {branch}, {base}
git config bay.autoSubmit true|false      # default false
git config bay.autoMerge true|false       # default true
```

No `bay.merge` is required. If unset, git bay uses native `git merge --no-ff`.
A merge command's exit `0` is only a claim; the PR is recorded as merged only
when the submitted revision is an ancestor of the refreshed base.

For shared, version-controlled policy, committed config lives in `.gitbay.yml`
at the repository root. It uses a small GitHub Actions-inspired shape: line
policy, registered steps, hooks, filters, environment, and plugins. It is not a
full Actions dialect.

Step names come from registered state shapes first, not ad hoc strings. Built-ins
and plugins register steps with `withStep(name, transition)`: name, input state,
output state, effect handler, wait/resume behavior, and default config are added
to the folded state. Config and `--steps <step,...>` select registered steps; the
file supplies values for known steps, it does not create transitions by string.

Example:

```yaml
line:
  defaultBase: main
  defaultSteps: [check, review, merge, deploy]
  batch: 1 # false, 0, or 1 disables; N > 1 batches runnable PRs

steps:
  check:
    run: bun run check
  review:
    run: ./review-gate {pr}
  merge:
    run: git merge --no-ff {branch}
  deploy:
    environment: staging
    run: ./deploy.sh {base}

issues:
  validate: gh issue view {name}
  onMerged: gh issue close {name} --comment "merged as {pr}"

```

Hook commands can use `{name}` for bay name, `{branch}` for source branch,
`{base}` for base branch, and `{pr}` for PR id.

Hooks and plugins are optional. git bay core is fully local; plugins may call
hosted APIs when configured. Plugins can provide the same contracts for GitHub
Actions, issue trackers, code review tools, deployment providers, or
repository-specific policy.

## Integrations

- **Steps** are registered state transitions. A sync step runs to a verdict in
  one dispatch. An async step parks state, records a correlation token, releases
  the writer lock, and resumes from a later event. Config supplies values for
  registered steps; it does not invent transitions.
- **Merge** is the transition that can produce the landed state. Its command is
  configurable, but `merged` is recorded only after the landed state has proof
  that the submitted revision is an ancestor of the refreshed base.
- **Checks** are registered transitions that capture stdout/stderr in the verdict
  and reject on nonzero exit.
- **Reviews** are async steps between `checked` and `merging`. Approval moves the
  PR out of `reviewing`; rejection records the reason and keeps the PR out of the
  line. Verdicts are bound to the reviewed SHA, so a new push invalidates them.
- **Issues** validate bay names and receive lifecycle callbacks for opened,
  submitted, rejected, merged, deployed, and closed PRs.
- **Deployment** is a step over landed state. A deploy failure records a verdict,
  can make the command exit nonzero, and cannot revoke `merged`.

## Lines And Batching

A line sits on a base branch. The base branch is the PR's destination branch;
the PR source is `branch`, and its destination is `base`.

```bash
git bay open fix-release --base release/2.0
git bay open fix-release --from task/fix-release --base release/2.0
git bay submit PR7 --base release/2.0
git bay line status release/2.0
```

`--from` and `--base` are the canonical flags. `--head` aliases `--from` for
GitHub PR vocabulary; `--line` aliases `--base` for git bay's line vocabulary.

The default line sits on the repository default branch. There is no separate line
object to create: selecting another base branch uses the line sitting on that
branch. `main` can keep flowing while `release/2.0` integrates its own PRs.

Lines share one repo-wide `.git/bay/`: the event log, index, writer lock, PR Git
repo, worktree pool, config, and plugins. A line owns only the derived state for
one base branch: the PRs whose `base` is that branch, their queue order, the
active runner/lock, and any line-specific policy or step configuration.

Queue order is stable, but parked PRs are not head-of-line blockers. `line
integrate` filters for runnable PRs, skips waiting review/remote-runner work, and
rechecks each final landing against the latest base.

Batching is an optimization on top of serial line semantics. The line can group
compatible runnable PRs into one candidate, run checks once, and merge the batch
when the candidate is green. If a batch fails, git bay isolates the failure by
retesting smaller groups or individual PRs, rejects the failing PR with evidence,
and retries the remaining compatible PRs.

## Safety Rules

- Final landings are serial per base, and waiting PRs never bypass the final
  recheck.
- Checks run before merge; retry re-enters the full pipeline.
- Check and review verdicts are SHA-bound; a new push invalidates them.
- Native and configured merge paths both verify that PR commits are ancestors of
  the updated base branch before recording `merged`.
- `merged` is terminal; issue, notification, and deployment hooks cannot revoke
  it.
- Dirty bay close refuses: uncommitted changes are never destroyed.
- Closing a live PR refuses unless withdrawal is explicit.
- A merged or closed PR is a closed door; start new work in a new bay.
- Client-side hooks teach early, but receive-side refusal is the correctness
  floor.
- When submodules are present, pin rewinds are refused at the push door; audit
  also looks for stale pins and orphaned refs.
- Batch candidates include only runnable PRs, and failures are isolated before
  unrelated PRs are blamed.

## Troubleshooting

- **Check failed**: fix the bay, commit, `git push`, then `git bay line integrate
  --retry <PR>`.
- **Merge conflict**: refresh/rebase the bay branch against the base, push again,
  then retry.
- **Dirty close refused**: commit, discard, or move the work; close never destroys
  uncommitted changes.
- **Live PR close refused**: integrate, retry, or `git bay close --withdraw`.
- **Stale pins or stray refs**: run `git bay audit` for orphaned branches,
  submodule rollbacks, and dangling refs.

## Internals

git bay stores local state under `.git/`, so `git clean` cannot delete it:

```text
.git/
  config              bay.* keys
  bay/
    events.jsonl      append-only event authority
    index.sqlite      rebuildable query index for PRs, bays, queue, line, refs
    writer.lock       single-writer guard for event/index updates
    prs.git/          local bare repo for PR refs, objects, and hooks
.bays/                working directories: wt1, wt2, ...
```

The event log is the source of truth. PRs, bay leases, queue order, and verdicts
are events first and folded into state on read. `index.sqlite` is a rebuildable
query index derived from those events, used for fast status, audit, and lookup
commands. `prs.git/` is Git storage only: bay worktrees push PR refs and objects
there, and its receive hooks validate the push and append domain events.

Event log entries use slash names and typed payloads:

```text
gitbay/...     initialized, refused, audited
worktree/...   provisioned, deprovisioned
bay/...        opened, refreshed, closed
pr/...         opened, changed
line/step/...  started, waiting, finished
line/batch/... started, isolated, finished
```

External orchestrators can assign workers around git bay, but those actors live
above this tool. git bay owns only the git-backed bays, PR state, and line
mechanics.

## Development

```bash
bun bay -- help      # local dev CLI: bun ./bin/git-bay.ts
bun run spec         # executable markdown specs in tests/*.spec.md
bun run check        # tsc --noEmit + vitest
```

The executable specs are test fixtures, not extra docs:

- `tests/gitbay.spec.md`: happy path and manual-control path
- `tests/refusals.spec.md`: refusal contract
- `tests/guide.spec.md`: `git bay guide` output

## License

MIT
