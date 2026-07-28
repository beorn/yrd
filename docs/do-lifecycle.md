# The `yrd do` lifecycle, and what it says while it runs

`yrd do <issue-or-pr>` is the verb that carries one issue from a tracker to a
landed commit. It is a COMPOSITION over surfaces that already exist — it adds no
second Bay provisioner, no second carrier path, no second landing queue.

This document is the map: every phase boundary, what can go wrong there, and
which log events name it. It is also the contract — a new phase is not finished
until it appears here and in the story an operator reads.

## Two shapes, one verb

`do` picks its shape at the entry point:

| Shape | Chosen when | Driver |
| --- | --- | --- |
| **Interactive** | a person is at a terminal | `doWork` opens a Bay session and hands the terminal over |
| **Managed** | `--seat`, or a host that POSITIVELY reports no terminal | `doWorkManaged` → `runManagedDo`, which drives nine stages unattended |

An absent `interactive` flag is not evidence of a headless caller. The process
host always states it, so only an embedded caller leaves it undefined, and such
a caller is never flipped into an unattended composition by silence.

## The phases

Phases run top to bottom. "Both" means the phase is on the interactive and the
managed path alike.

| # | Phase | Shape | Failure modes | Events |
| --- | --- | --- | --- | --- |
| 0 | **Observability resolve** — `-v`/`-q`/`--log-level`/`LOG_LEVEL`/`DEBUG` become one policy | both | contradictory flags; unknown level | typed `usage`/`configuration` refusals; no log (the logger does not exist yet) |
| 1 | **Runtime bootstrap** — repo authority, config, journal, state dir | both | not a repo; `.yrd.yml` unreadable; journal reader-floor skew | span `yrd:setup`; `yrd:process:run` per Git probe |
| 2 | **Issue resolve** — selector → `IssueRef` → the configured source | both | no such source; source subprocess fails, times out, or answers non-JSON; JSON that is not an issue; wrong issue returned | `yrd:issues:resolve` INFO start/finish; `yrd:issues:source` DEBUG argv/cwd/exit/duration |
| 2b | **PR fallback** — an unresolvable selector that names a live PR continues as one | interactive | the dropped issue failure hiding a broken tracker command | WARN on the root logger, naming the selector, the PR, and the discarded reason |
| 3 | **Plan resolve** — `.yrd.yml` `do.*` keys plus `--lane` | managed | a missing `do.lane`/`assign`/`seat`/`launch` — Yrd never invents a command or a persona | typed `configuration` refusal naming the key and the file |
| 4 | **concurrency** — the single-run marker (managed concurrency is capped at 1) | managed | another run holds it; a stale marker from a dead pid (reclaimed, loudly) | `yrd:do:concurrency` |
| 5 | **assign** — the repository-configured assignment command | managed | non-zero exit; timeout | `yrd:do:assign`; `yrd:process:run` |
| 6 | **seat** — the repository-configured seat decision | managed | non-zero exit; timeout | `yrd:do:seat`; `yrd:process:run` |
| 7 | **bay** — provisioning through the same path `bay open` uses | managed | interrupted before use; opened without a workspace path; Git/worktree failure | `yrd:do:bay`; `yrd:bay:*`; `yrd:jobs:*` |
| 8 | **launch** — the repository-configured seat launch | managed | non-zero exit; timeout. A launch that cannot take ownership ROLLS BACK the Bay it just opened | `yrd:do:launch`; `yrd:process:run` |
| 9 | **carrier** — bounded poll for the first commit on the Bay branch | managed | timeout (`carrierTimeoutMs`) — the Bay and its branch are PRESERVED | `yrd:do:carrier` |
| 10 | **draft** — cut BEFORE any gitlink commit and before any recut | managed | draft creation refused; branch has no PR after create | `yrd:do:draft`; `yrd:queue:*` |
| 11 | **recut** — preflight, then `--queue` admission | managed | admission refusal; a remedy that leaves the managed verb set; a conflict needing human judgment (escalated, never executed) | `yrd:do:recut`; `yrd:queue:admit` |
| 12 | **observe** — watch the resident runner land it. NEVER `queue run`: one queue, one driver | managed | rejected/withdrawn/canceled carrier; `admission-refusal-loop` wedge; landing without a provable SHA; timeout (`landingTimeoutMs`) | `yrd:do:observe`; `yrd:queue:compose`; `yrd:queue:finish` |
| 13 | **scoreboard + report** — durations, trail, and the ancestry proof | managed | scoreboard append fails (refuses; the timing table still prints) | stdout carries `landed <sha>` and the ancestry command; stderr carries the trail |

Stages 4–12 report through ONE seam: `recordBoundary`. That stream feeds both
the durable JSONL journal under the host state directory and, since 22477, the
`yrd:do` logger. Adding a stage to the driver without a boundary is caught by
the phase-story regression, which derives its expectation from
`MANAGED_DO_STAGES` rather than listing stages by hand.

## The observability contract

### Levels

| Level | Means | Example |
| --- | --- | --- |
| **ERROR** | an actionable operator failure, with the evidence to act on | a duration that could not be measured |
| **WARN** | degraded but continuing — say what was dropped and why | `DEBUG` stripped from an issue-source subprocess; an issue failure discarded for a PR selector |
| **INFO** | phase transitions and milestones — the one-line story of a run | every `yrd:do` stage boundary; `yrd:issues:resolve` |
| **DEBUG** | inner mechanics | every subprocess that finished, with argv, cwd, exit code and duration |
| **TRACE** | the noisiest rail | every subprocess that STARTED — the only evidence naming a command that then hung |

Severity is not a per-package decision. `YRD_LIFECYCLE_LEVELS` maps a lifecycle
OUTCOME to a level, and every observed lifecycle uses it, including the `do`
boundaries. Two rules explain what would otherwise look inconsistent:

- **A failure is reported once.** The deepest failing job or step owns the single
  ERROR; enclosing lifecycles settle at INFO rather than re-raising the same
  failure at every level on the way up. One-shot commands print their final
  error at the CLI boundary, so a `refused` lifecycle stays INFO instead of
  printing twice.
- **Starts are DEBUG unless they are milestones.** A delivery step (a `run` plus
  a `step` identity) is a milestone by construction; anything else opts in with
  `milestone: true`. `do` stages and issue resolution do, which is what makes
  `-v` alone tell the story of a run.

### Namespaces

`yrd:<area>[:<phase>]`. One segment per owner, and a phase never invents a
sibling namespace for itself.

| Namespace | Owner |
| --- | --- |
| `yrd:do:<stage>` | the managed `do` composition, one child per stage |
| `yrd:issues:resolve` | issue resolution |
| `yrd:issues:source` | the command adapters behind every configured source |
| `yrd:bay:<lifecycle>` | Bay submit/intake |
| `yrd:queue:<lifecycle>` | admit, compose, finish, recover |
| `yrd:jobs:<lifecycle>` | job execution and lease recovery |
| `yrd:process:run` | every subprocess |
| `yrd:storage:<lifecycle>` | journal append and writer lock |
| `yrd:core:replay` | journal replay |
| `yrd:runner`, `yrd:receiver`, `yrd:signals`, `yrd:contests` | the resident runner, the receiver hook, notification delivery, contests |

### Spans

Every multi-step phase is wrapped: `yrd:do:<stage>` per stage,
`yrd:issues:resolve`, `yrd:bay:submit`, `yrd:queue:compose`, `yrd:jobs:<step>`,
`yrd:process:run`. Context propagation is on, so a subprocess span parents to
the delivery span that caused it and nesting is queryable, not guessed.

## Reading a run

```sh
yrd -v do <issue> --seat          # the story: phase transitions only
yrd -vv do <issue> --seat         # + inner mechanics and spans
yrd -vvv do <issue> --seat        # + every subprocess start
DEBUG='yrd:do:*' yrd -vv do <issue> --seat   # one phase, isolated
DEBUG='yrd:*' yrd -vv ...         # all of Yrd, and none of the UI framework's render noise
LOGGILY_FILE=/tmp/yrd.jsonl yrd ...          # the full structured stream, spans included
```

`DEBUG` is a NAMESPACE FILTER and never changes severity; the level comes from
`-v`/`-q`/`--log-level`/`LOG_LEVEL`.

### `--json` stdout stays pure

Machine output goes to stdout; logs go to stderr or a loggily sink. This runs
both ways: an issue source answers JSON on stdout and nowhere else, so a source
subprocess that inherited `DEBUG` would corrupt every response by writing its
debug stream onto the protocol channel. The adapter drops `DEBUG` from that
child and WARNs that it did, pointing at `DEBUG_LOG=<file>` as the rail that
still works. It is never dropped quietly.

## Adding a phase

1. Give it a boundary. On the managed path that means a `ManagedDoStage` entry
   in `MANAGED_DO_STAGES` and start/terminal `recordBoundary` calls; elsewhere it
   means `observeYrdLifecycle`.
2. Decide its level from the table above, not case by case. If it is a phase
   transition an operator should see at `-v`, it is a milestone; say so.
3. Name it under its owner's namespace. Do not mint a new top-level one.
4. Make every refusal state what was RUN, what came BACK, and what was EXPECTED.
   A verdict without its evidence costs an operator a repro run that Yrd already
   made.
5. Add it to the table in this document. The phase-story regression derives from
   `MANAGED_DO_STAGES`, so a managed stage cannot ship silent — but a phase
   outside that list can, and this document is what catches it.

## Observation is observation

Instrumentation never changes behavior: no new retries, no swallowed errors, no
altered control flow. Evidence may be ADDED to an error, and a failure may be
logged and rethrown — but a phase that failed before still fails, at the same
place, with the same verdict.
