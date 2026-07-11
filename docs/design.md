# Yrd target model

This is the normative target model for the Yrd upgrade. Yrd is repository
scoped: each repository has one configured orchestration system. Section A
records the model rulings; section B specifies the model and its invariants;
section C makes supporting decisions explicit; section D maps the current code
to the target (a refit, not a rewrite); and section E records the costs and
tradeoffs.

## A. Decisions on the packet's ten asks

| #   | Ask                                                    | Ruling                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Core hierarchy                                         | **Validated** as proposed: Repository → Yrd → FlowDef[]/ExecutorDef[] + projected PR/PRRev/Line/Candidate/Run/Job. One amendment: Contest is a consumer of these primitives, not a core member (C1).                                                                                                                                                                                                                |
| 2   | PR keeps GitHub semantics; Candidate owns merge groups | **Confirmed.** Strengthened: PR adopts GitHub's exact state shape — `state: "open" \| "closed"` + `merged: boolean` — replacing today's five-way `pushed/submitted/rejected/integrated/withdrawn` enum (B3).                                                                                                                                                                                                        |
| 3   | Two config spellings                                   | **One plugin model, both spellings ship, one audience rule** (C7): config authors write `yrd.*` namespace aliases; extension/plugin authors write `with*`. Aliases are exact re-export bindings (`export const check = withCheckStep`) — zero drift surface. Docs show exactly one spelling per audience.                                                                                                           |
| 4   | `@yrd/config` provider-neutral                         | **Confirmed.** `@yrd/github` is a separate adapter package and is explicitly deferred until after the local cutover milestone (E, "deferred"). No convenience entry point until the adapter exists.                                                                                                                                                                                                                 |
| 5   | Task resolver placement                                | **Confirmed** as optional shared YrdDef capability via `withTask(resolve)`. No `withSource` until a second source capability is real.                                                                                                                                                                                                                                                                               |
| 6   | Job status/conclusion spellings                        | **Settled, GitHub verbatim** (B6): `status: queued \| in_progress \| waiting \| completed`; `conclusion: success \| failure \| cancelled \| skipped \| timed_out` (`action_required`/`neutral` reserved for adapters that need them). `waiting` is a status, exactly as GitHub Actions uses it for deployment approvals. Run uses the same split.                                                                   |
| 7   | Readiness projection + concurrency boundaries          | **Confirmed** derived readiness (no `PRReadiness` aggregate). Merge serialization is a per-`(repository, base branch)` lock shared across all Lines on that base — the lock is keyed by base, not by Line (C4).                                                                                                                                                                                                     |
| 8   | `Command`/`Event` vs `Op`/`OpCall`                     | **Confirmed CQRS names.** Today's `Operation {op, args}` becomes `Command`; `CommandResult {command, events, value?}` is the dispatch return; `Frame` demotes below the Journal interface (it is currently exported from core — that export dies). Runtime surface shrinks to `{ def, state, dispatch, refresh, events, close }` — today's `command()`/`operation()`/`invoke()` triple collapses into `dispatch()`. |
| 9   | `init/deinit` vs `provision/deprovision`               | **Neither — the question dissolves** (C6). Lines materialize lazily on first submit; the only lifecycle verb is repo-level `yrd init` (optional; first repository-backed command auto-inits, as today). If operational need arises later, `yrd line pause/resume` — but not in v1.                                                                                                                                  |
| 10  | `.yrd.ts` configures Executor/target, not Runner       | **Confirmed.** Runner and Context identities are runtime evidence on the Job. One security amendment: config authority is the base branch (C5).                                                                                                                                                                                                                                                                     |

## B. The model

### B1. Hierarchy

```text
Repository
└── Yrd                       one configured orchestration system per repository
    ├── FlowDef[]             integration procedures (name, rev, on, steps)
    ├── ExecutorDef[]         configured local/remote execution adapters
    ├── capabilities          optional shared (TaskResolver, ...)
    └── YrdState              event-projected operational state
        ├── PR[] → PRRev[]    proposals and their immutable submitted revisions
        ├── Line[]            landing lanes: one per (FlowDef, base branch), lazy
        ├── Candidate[]       immutable attempted integrations (merge groups)
        ├── Run[]             one Flow-rev execution against one Candidate
        └── Job[]             durable step executions with evidence
```

Config defines capabilities and procedures; events produce runtime state; the
two never mix. Event sourcing remains persistence, not the domain model.

### B2. FlowDef and flow selection

```ts
type Submission = Readonly<{
  base: string // destination branch
  branch: string // source ref
  head: string // submitted head SHA
  bay?: string // originating bay, when any
  task?: TaskRef // resolved task reference, when any
}>

type FlowDef = Readonly<{
  name: string
  rev: string // human-bumped semantic revision label
  on: (s: Submission) => boolean
  steps: readonly StepDef[]
}>
```

- `on` receives a `Submission`, **not a PR** — at first submit the PR does not
  exist yet; selection input is the submission facts.
- Selection must produce **exactly one** matching Flow. Zero and ambiguous
  matches are loud errors that list every matched flow name. First-match-wins
  is rejected: it makes shadowing silent, and loud-at-submit beats
  silent-wrong-lane. Exclusive predicates are cheap to write in TypeScript.
- The selected flow `name` + `rev` is pinned on the PR's enrollment and on
  every Run, so historical runs stay explainable after `.yrd.ts` edits.
- **Drift guard**: the runtime also fingerprints the flow's structural content
  (step names, kinds, order, executor bindings). If the fingerprint changes
  while `rev` does not, submit/doctor warn loudly. Pending/waiting work refuses
  to resume across a rev change, as today.

### B3. PR and PRRev

```ts
type PR = Readonly<{
  id: string // PR1, PR2, ... (counter; journal CAS makes counters safe)
  base: string
  branch: string
  state: "open" | "closed" // GitHub verbatim
  merged: boolean // GitHub verbatim; merged implies closed
  flow?: { name: string; rev: string } // pinned at enrollment
  revs: readonly PRRev[]
}>

type PRRev = Readonly<{
  n: number // 1, 2, ... monotonic per PR
  head: string // immutable submitted head SHA
  submittedAt: string
}>
```

- Today's five-way `PRStatus` dies. `pushed → open` (not yet enrolled),
  `submitted → open` (enrolled), `rejected → open` with failing latest
  readiness (derived, not stored), `integrated → closed + merged`,
  `withdrawn → closed + !merged`.
- A failed Run never terminally rejects a PR. Re-submit pins a new PRRev;
  the PR remains one proposal.

### B4. Candidate

```ts
type Candidate = Readonly<{
  id: string // C1, C2, ... (counter for UX)
  lineId: string
  baseSha: string
  revs: readonly { pr: string; n: number; head: string }[] // ordered
  sha?: string // synthetic merge commit, once constructed
  ref?: string // refs/yrd/candidates/<id>
  mergeability: "unknown" | "mergeable" | "conflicting"
  createdAt: string
}>
```

- Immutable. The _attempt_ is the Run; re-checking the same combination is a
  new Run against the same Candidate, never a mutated Candidate.
- **Derived content key** `(baseSha, revs[].head, in order)` deduplicates
  reconstruction and makes check results reusable-iff-base-unchanged. The key
  is an index, not a second identity; it is computed, not stored.
- Mergeability is computed via `git merge-tree` — no checkout, no Context
  lease — before any expensive check is admitted.
- The synthetic commit is published at `refs/yrd/candidates/<id>`. Local
  executors read it in place; a future remote executor's adapter is
  responsible for pushing that ref wherever its runners can fetch (the seam is
  named now; no remote push machinery ships in v1).
- Bisection on a failing multi-rev Candidate creates **new child Candidates**
  (subset revs) with provenance recorded on the child Runs (`parent` run id).
  Candidates never mutate; today's `isolationPart` refits into this shape.

### B5. Run

```ts
type Run = Readonly<{
  id: string // R1, R2, ...
  lineId: string
  candidateId: string
  flow: { name: string; rev: string }
  status: "queued" | "in_progress" | "waiting" | "completed"
  conclusion?: "success" | "failure" | "cancelled"
  parent?: string // bisection provenance
  startedAt?: string
  endedAt?: string
  jobs: readonly string[]
}>
```

Run status/conclusion uses the same split as Job. Today's LineRun
`running/waiting/passed/failed` refits mechanically
(`passed → completed+success`, `failed → completed+failure`).

### B6. StepDef, Job, Executor, Context

```ts
type StepDef = Readonly<{
  name: string
  kind: "check" | "action" | "merge"
  job: JobDef // executor-bound executable description
  required?: boolean // gating; orthogonal to kind
  timeoutMs?: number
  env?: Env
}>
```

- Literal step order is the workflow; the single `merge` step partitions
  pre-merge from post-merge. No phase DSL. `withMergeStep()` uses type-state so
  a missing or duplicate merge boundary is a compile error where practical.
- Today's `integrates: boolean` → `kind: "merge"`; `needsIntegration: boolean`
  → position after the merge step. The booleans die.
- Job `status`/`conclusion` spellings per A6. Today's
  `passed/failed/waiting` job results refit; the durable Job machine (leases,
  waiting, retry, recover) is kept as-is — only vocabulary and the
  status/conclusion split change at its boundary.
- Executor is the configured control-plane adapter: `submit`, `observe`,
  `cancel`, plus `maxInFlight` as Yrd's admission limit. Runner and Context
  are runtime evidence recorded on the Job, never configured identities.
- `ContextReq` stays minimal: `scope: job | run | session | shared`,
  `candidate: none | ro | rw`, optional capability strings. One writable
  worktree materializes one Candidate at a time. Submodule-heavy repositories
  default to independently initialized contexts (per prior-art research);
  linked worktrees share objects but not mutable submodule working dirs.
- v1 ships **exactly one executor**: `localExecutor({ contexts:
worktreeContexts({ size, submodules: "isolated" }) })` — a refit of the
  existing process/runner machinery behind the Executor seam. Remote executors
  (GitHub Actions, agent hosts) bind to the same seam later.

### B7. Readiness (derived)

`ready(pr) = candidate.mergeability === "mergeable" && candidate is current
(baseSha == base tip) && every required pre-merge Job of the latest Run
concluded success`. Reviews participate as asynchronous required checks
(`waiting` Jobs). Readiness is a projection; nothing stores it.

### B8. Events, storage, vocabulary

- `Command` (serializable intent) → handler `(Command, State) → Event[]` →
  pure `apply(Event, State) → State` → signals. `CommandResult` returns
  `{ command, events, value? }`.
- `Frame` is the Journal's atomic append envelope only. It leaves the public
  core surface. Journal semantics (compare-and-append, checksummed JSONL,
  replay, cross-process single-writer) are unchanged.
- Event/cause/command ids are process-unique (UUIDv7). Domain object ids stay
  human counters (PR1/C1/R1/B1) — safe because journal CAS forces replay and
  re-decision on cursor conflict, so colliding counters cannot commit.
- `events.jsonl` authoritative; `index.sqlite` rebuildable; Git stores named
  by content (`prs.git`; candidate refs under `refs/yrd/candidates/`).
- Event names are namespaced by owning plugin (`pr/…`, `line/…`, `job/…`).

## C. Decisions the packet left implicit (now explicit)

**C1. Contest placement.** Contest is an orchestration _above_ the landing
core: competitors produce Bays → PRs; evaluations are ordinary Jobs; promotion
submits the winner's PRRev to a Line. Contest remains a first-class projected
collection in its own package, consuming PR/Job/Bay primitives — it is not in
the core hierarchy and adds no core concepts.

**C2. Line concurrency model (v1): serial-head with batching, no stacked
speculation.** A Line processes its queue FIFO; the head batch (up to
`batch: N`) forms one Candidate; its Run must reach the merge step before the
next Candidate is constructed. Concurrent check Runs for _other Lines_ and
other base branches proceed freely under Executor/Context admission.
GitHub-merge-queue-style stacked speculative candidates are explicitly out of
v1 — but the model already carries the seam (content-keyed Candidates pinned
to `baseSha` make speculative results reusable-iff-base-unchanged), so
speculation can arrive later as a scheduling plugin without model change.

**C3. Queue order.** FIFO by PRRev submission time. No priority DSL in v1;
reordering is an operator action, not config.

**C4. Merge lock scope.** The merge step acquires a per-`(repository, base
branch)` lock. Two Lines (two Flows) landing on the same base share that lock;
checks never take it.

**C5. Config authority is the base branch.** Flows and steps for evaluating a
Candidate come from the yard's own config (the base checkout / pinned flow
rev) — never from `.yrd.ts` content inside the submitted revisions. A PR that
edits `.yrd.ts` takes effect only after it lands. This is the same rule GitHub
enforces for `pull_request_target` workflows, and it is what makes contests
with agent-written (untrusted) candidate content safe to check.

**C6. Line lifecycle verbs are deleted.** A Line exists because a FlowDef
matched a submission on a base branch; it materializes lazily and needs no
provision/deprovision/init/deinit. Repo-level `yrd init` stays optional
(auto-init on first repository-backed command, exactly as today).

**C7. Config spelling audience rule.** Both spellings are the same bindings;
`yrd.*` for config authors, `with*` for extension authors; each doc surface
shows only its audience's spelling. No object-schema DSL, ever.

**C8. Post-merge failure invariant.** A failed post-merge `action` step never
reverts the merge: the base branch advance stands, the PR stays
`closed+merged`, the Run records `completed+failure`, and the failed Job is
retryable (`--retry`). Un-landing is a human/git decision outside Yrd.

**C9. Journal migration stance (pre-1.0).** No event-migration machinery. The
model upgrade ships as journal schema v2: a repository re-inits Yrd state,
open PRs are re-submitted (a scripted `yrd migrate` walk of live PRs is
acceptable if cheap), and the old journal is archived read-only next to the
new one. Change-is-free applies to our own pre-1.0 surface; carrying
dual-decode paths for a single-digit number of live deployments is waste.

**C10. Security invariants (absorbed from the standing P0).** Event/cause/
command ids unique across fresh CLI processes; all subprocess execution is
argv-array (no string interpolation into `sh -c`); Git ref/branch/task names
are treated as hostile input at every boundary (they ride argv, never shell
text, and are schema-validated on intake).

## D. Current code → target (refit map, not a rewrite)

The implementation is close to the target; this is vocabulary + object
extraction, keeping the proven machinery (journal CAS, Job transitions,
receive-hook intake, bisection, waiting/finish/recover).

| Current                                                       | Target                                                                                      | Nature                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `Operation {op,args}`, `operation()`, `command()`, `invoke()` | `Command`, single `dispatch()`, `CommandResult`                                             | rename + surface collapse (yrd-core)                       |
| `Frame` exported from core domain                             | storage-internal to Journal                                                                 | demotion (yrd-core/yrd-persistence)                        |
| `PR` with 5-way `PRStatus` + embedded `revisions[]`           | `PR {state, merged}` + `PRRev` extracted; readiness derived                                 | shrink + extraction (yrd-bay → landing domain in yrd-line) |
| `LineRecord.prs: PRSnapshot[]` + `baseSha`                    | `Candidate` first-class (id, content key, merge-tree mergeability, ref)                     | extraction (yrd-line)                                      |
| `LineRun` status `running/waiting/passed/failed`              | `Run` with status+conclusion split                                                          | refit (yrd-line)                                           |
| `InstalledStep {integrates, needsIntegration}`                | `StepDef {kind: check\|action\|merge}` + order                                              | refit (yrd-line)                                           |
| Job results `passed/failed/waiting`                           | GitHub status+conclusion at the boundary; machine unchanged                                 | vocabulary (yrd-job)                                       |
| injected `checkRunner`/`mergeRunner` capabilities             | `Executor` seam + `localExecutor` + `worktreeContexts` leases                               | generalization (yrd-job/yrd-process)                       |
| programmatic composition only                                 | `@yrd/config`: `defineConfig` + `with*` + `yrd.*` + `.yrd.ts` discovery + doctor            | new package                                                |
| `git bay submit`                                              | `yrd pr submit` (bay keeps workspace verbs only; deprecation alias window for `bay submit`) | CLI move (yrd-cli)                                         |
| `parent`/`isolationPart` bisection fields                     | child Candidates + `Run.parent` provenance                                                  | refit (yrd-line)                                           |

Package set stays: core, bay, line (landing domain: PR/PRRev/Candidate/Run/
Flow), job, task, contest, cli, persistence, process (absorbed into the local
executor), plus new `@yrd/config`. `@yrd/github` deferred.

## E. What we lose / honest costs

- **Exactly-one flow matching** costs verbose mutually-exclusive predicates in
  multi-flow configs; bought: no silent shadowing (loud beats silent).
- **GitHub-verbatim spellings** import `in_progress`/`timed_out` underscores;
  bought: zero translation at every adapter boundary and familiar semantics.
- **Fresh-journal migration (C9)** drops historical run evidence from live v2
  projections (archive stays readable); bought: zero dual-decode machinery.
- **Four objects where today there is one** (PR/PRRev/Candidate/Run vs
  LineRun) puts more ids in front of users; bought: each object answers
  exactly one question and the GitHub mapping becomes 1:1. CLI mitigates by
  showing the chain (`PR1 rev2 → C3 → R4`) in status output.
- **Serial-head Lines (C2)** cap throughput vs stacked speculation; bought:
  v1 scheduling stays trivially explainable, and the seam for speculation is
  already in the model.
- **Deferred `@yrd/github`** keeps Yrd local-only for now; bought: the first
  consumer (local queue cutover) arrives sooner, and the Executor/Context/
  candidate-ref seams are named so the adapter lands without model change.
- **Deleted lifecycle verbs (C6)** remove explicit pre-provisioning; bought:
  two fewer verbs and no state to desync. If a real operational need appears,
  `pause/resume` is additive.
