# Yrd model design record

This records the domain-model decisions behind the Yrd upgrade. The current
repository configuration and CLI contracts are normative in
[`README.md`](../README.md) and [`ARCHITECTURE.md`](../ARCHITECTURE.md); the v4
configuration cutover deliberately supersedes this record's earlier
configuration proposals. Yrd is repository
scoped: each repository has one configured orchestration system. Section A
records the model rulings; section B specifies the model and its invariants;
section C makes supporting decisions explicit; section D maps the current code
to the target (a refit, not a rewrite); and section E records the costs and
tradeoffs.

## A. Decisions on the packet's ten asks

| #   | Ask                                                    | Ruling                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Core hierarchy                                         | **Validated** as proposed: Repository → Yrd → FlowDef[]/RunnerDef[] + projected PR/PRRev/Queue/Candidate/Run/Job. One amendment: Contest is a consumer of these primitives, not a core member (C1).                                                                                                                                               |
| 2   | PR keeps GitHub semantics; Candidate owns merge groups | **Confirmed.** Strengthened: PR adopts GitHub's exact state shape — `state: "open" \| "closed"` + `merged: boolean` — replacing today's `pushed/submitted/ready/needs-author/rejected/integrated/already-landed/withdrawn/canceled` enum (B3).                                                                                                    |
| 3   | Two config spellings                                   | **One plugin model, both spellings ship, one audience rule** (C7): config authors write `yrd.*` namespace aliases; extension/plugin authors write `with*`. Aliases are exact re-export bindings (`export const check = withCheckStep`) — zero drift surface. Docs show exactly one spelling per audience.                                         |
| 4   | `@yrd/config` provider-neutral                         | **Confirmed.** `@yrd/github` is a separate adapter package and is explicitly deferred until after the local cutover milestone (E, "deferred"). No convenience entry point until the adapter exists.                                                                                                                                               |
| 5   | Issue resolver placement                               | **Confirmed** as optional shared YrdDef capability via `withIssue(resolve)`. No `withSource` until a second source capability is real.                                                                                                                                                                                                            |
| 6   | Job status/conclusion spellings                        | **Settled, GitHub verbatim** (B6): `status: queued \| in_progress \| waiting \| completed`; `conclusion: success \| failure \| cancelled \| skipped \| timed_out` (`action_required`/`neutral` reserved for adapters that need them). `waiting` is a status, exactly as GitHub Actions uses it for deployment approvals. Run uses the same split. |
| 7   | Readiness projection + concurrency boundaries          | **Confirmed** derived readiness (no `PRReadiness` aggregate). Merge serialization is a per-`(repository, base branch)` lock shared across all Queues on that base — the lock is keyed by base, not by Queue (C4).                                                                                                                                 |
| 8   | `Command`/`Event` vs `Op`/`OpCall`                     | **Confirmed CQRS names.** The former `Operation {op, args}` is `Command`; `CommandResult {command, events, value?}` is the dispatch return; `Frame` is below the Journal interface and no longer exported from core. Runtime execution is one `dispatch()` surface rather than the former `command()`/`operation()`/`invoke()` triple.            |
| 9   | `init/deinit` vs `provision/deprovision`               | **Admin-only lifecycle.** Queues materialize lazily; installed adapters expose `yrd admin queue init/deinit`, while daily queue verbs remain outside `admin`.                                                                                                                                                                                        |
| 10  | `.yrd.yml` configures checks, not Runner identity      | **Confirmed.** Runner and Context identities are runtime evidence on the Job. Config authority is the base branch (C5), and repository config contains one `checks:` list.                                                                                                                                                                        |

## B. The model

### B1. Hierarchy

```text
Repository
└── Yrd                       one configured orchestration system per repository
    ├── FlowDef[]             integration procedures (name, rev, on, steps)
    ├── RunnerDef[]         configured local/remote execution adapters
    ├── capabilities          optional shared (IssueResolver, ...)
    └── YrdState              event-projected operational state
        ├── PR[] → PRRev[]    proposals and their immutable submitted revisions
        ├── Queue[]            landing lanes: one per (FlowDef, base branch), lazy
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
  composition?: SourceComposition // immutable nested-repository source packet
  bay?: string // originating bay, when any
  issue?: IssueRef // resolved issue reference, when any
}>

type SourceComposition = Readonly<{
  version: 1
  sources: readonly Readonly<{
    repo: string // root-relative gitlink path
    branch: string
    baseSha: string
    tipSha: string
    payload: readonly string[] // exact --no-renames path set
  }>[]
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
  every Run, so historical runs stay explainable after `.yrd.yml` edits.
- **Drift guard**: the runtime also fingerprints the flow's structural content
  (step names, kinds, order, runner bindings). If the fingerprint changes
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
  composition?: SourceComposition // canonicalized and immutable with this revision
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
  queueId: string
  baseSha: string
  revs: readonly { pr: string; n: number; head: string }[] // ordered
  sha?: string // synthetic merge commit, once constructed
  ref?: string // refs/yrd/candidates/<id>
  sourceRewrites?: readonly SourceRewrite[]
  mergeability: "unknown" | "mergeable" | "conflicting"
  createdAt: string
}>

type SourceRewrite = Readonly<{
  repo: string
  oldBaseSha: string
  oldTipSha: string
  newBaseSha: string
  newTipSha: string
  candidateRef: string // refs/heads/yrd/candidates/<newTipSha>
  patchId: string // stable patch-id shared by predecessor and successor
  rangeDiff: "=" // every commit in the two ranges is patch-equivalent
  payload: readonly string[]
}>
```

- Immutable. The _attempt_ is the Run; re-checking the same combination is a
  new Run against the same Candidate, never a mutated Candidate.
- **Derived artifact key.** It contains the exact base SHA followed by each
  revision's head and composition in order. It deduplicates reconstruction and
  makes check results reusable-iff-base-and-source-packets-are-unchanged. The
  key is an artifact index, not Candidate admission authority; it is computed,
  not stored.
- **Exact receipt key.** It adds Queue identity plus each PR's id and revision
  number to the artifact key. This key selects a Candidate for a Queue attempt.
  A new PR revision with content-equivalent heads still receives a new
  immutable Candidate receipt, even when that Candidate reuses the same
  artifact SHA.
- Mergeability is computed via `git merge-tree` — no checkout, no Context
  lease — before any expensive required check starts.
- The synthetic root commit is published at the **content-addressed**
  `refs/yrd/candidates/<syntheticSha>`, matching the source side, where each
  rewritten source tip is published under `refs/heads/yrd/candidates/<newTipSha>`
  in its own repository. The name is derived at publish time from the composed
  evidence, never from the Candidate's `C<n>` journal id: that id is allocated
  before the tree exists, so naming the ref after it made a compose retry that
  produced a different tree collide with its own earlier pin. Different evidence
  now takes a different ref by construction, and identical evidence is an
  idempotent republish. The Queue verifies those immutable refs immediately
  before and after the root compare-and-push; if one disappears during landing,
  it rolls the root branch back and reports `invalid-candidate`. Production
  remotes protect this namespace from deletion and non-fast-forward updates.
- Root Candidate refs carry the **same minimum seven-day retention window after
  the owning Run reaches a terminal journal state** as the source-candidate refs
  below — one number for "how long is Candidate evidence kept", not two. The
  namespace is bounded by a Yrd-owned collector (`yrd queue candidate-refs`,
  deleting only under `--prune`), never by generic branch cleanup, and deletion
  requires POSITIVE proof from one fresh complete inventory: a journaled
  Candidate owns the ref, no live PR or Run names it or its SHA, the window has
  passed, and the ref still resolves to the exact SHA that inventory read.
  Anything else is retained and reported. In particular, an unclaimed ref is
  never collected: `compactQueuesState` bounds terminal Run trees to a 512-root
  window, so a ref routinely outlives the Run that explains it, and age alone
  cannot prove that a Run the journal has forgotten ever reached a terminal
  state. `yrd doctor` reports the population as a warning, because ordinary
  accumulated history is not a defect.
- Content-addressed source-candidate refs have a **minimum seven-day retention
  window after the owning revision reaches a terminal journal state**. They are
  never delete-on-integration refs, and generic branch cleanup must treat them
  as retained evidence even when their patch is present on `main`. After the
  window, only a future Yrd-owned collector may make a ref eligible for
  deletion, and only from a fresh complete inventory proving all of the
  following: the ref is
  patch-equivalent to `main`, its exact SHA belongs to a terminal revision, no
  live PR or Run owns it, and the expected local/remote pair still byte-matches.
  Unknown, unmatched, unique-work, or unpaired refs remain retained. The
  run-scoped `refs/yrd/candidates/<run>/<step>/attempt-*` namespace is separate
  protected evidence and is outside this source-ref policy.
- A composed Candidate's root tree must pin every repository's final
  `SourceRewrite.newTipSha`. The receipt retains every sequential rewrite in a
  same-repository batch, while the final rewrite is the root gitlink binding.
- Every generated rewrite records its predecessor and successor SHAs, their
  shared stable patch ID, and an all-`=` range-diff result before the existing
  payload-manifest and root-tree certificates can pass.
- Bisection on a failing multi-rev Candidate creates **new child Candidates**
  (subset revs) with provenance recorded on the child Runs (`parent` run id).
  Candidates never mutate; today's `isolationPart` refits into this shape.

### B5. Run

```ts
type Run = Readonly<{
  id: string // R1, R2, ...
  queueId: string
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

Run status/conclusion uses the same split as Job. Today's QueueRun
`running/waiting/passed/failed` refits mechanically
(`passed → completed+success`, `failed → completed+failure`).

### B6. StepDef, Job, Runner, Context

```ts
type StepDef = Readonly<{
  name: string
  kind: "check" | "action" | "merge"
  job: JobDef // runner-bound executable description
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
- Runner is the configured control-plane adapter: `submit`, `observe`,
  `cancel`, plus `maxInFlight` as Yrd's execution limit. Runner and Context
  are runtime evidence recorded on the Job, never configured identities.
- `ContextReq` stays minimal: `scope: job | run | session | shared`,
  `candidate: none | ro | rw`, optional capability strings. One writable
  worktree materializes one Candidate at a time. Submodule-heavy repositories
  default to independently initialized contexts (per prior-art research);
  linked worktrees share objects but not mutable submodule working dirs.
- v1 ships **exactly one runner**: `localRunner({ contexts:
worktreeContexts({ size, submodules: "isolated" }) })` — a refit of the
  existing process/runner machinery behind the Runner seam. Remote runners
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
  core surface. Journal semantics remain compare-and-append, checksummed replay,
  and cross-process single-writer; SQLite changes the container, not the model.
- Event/cause/command ids are process-unique (UUIDv7). Domain object ids stay
  human counters (PR1/C1/R1/B1) — safe because journal CAS forces replay and
  re-decision on cursor conflict, so colliding counters cannot commit.
- `journal.sqlite` is the sole authority. Its Core checkpoint and Queue lookup
  indexes are replay-derived acceleration, never a second status store. Queue's
  exact/prefix/retry metadata, record history, and run-authority history share
  one JSON-compatible persistent SHA-256 radix lookup; an immutable update
  copies only its bounded digest path rather than the complete history map.
  New Queue starts explicitly declare settlement ownership. The startup
  migration refuses live-leased pre-settlement roots, auto-quiesces only
  unleased roots with a receipt, and retains terminal legacy roots in bounded
  retention. It never guesses whether a historical start still owns work. Git
  stores remain named by content (`prs.git`; candidate refs under
  `refs/yrd/candidates/`).
- Event names are namespaced by owning plugin (`pr/…`, `queue/…`, `job/…`).

### B9. Status vocabularies — which question each one answers

Several unions in this system are all called "status" and none of them is a
spelling variant of another. Each answers a different question, so a value from
one is never comparable to a value from another. Naming the question is the
whole point of this section: a vocabulary that cannot say what it answers is
how a count gets compared to a different count.

- **`PRDeliveryState`** (`yrd-bay/src/model.ts`) — *how far along the delivery
  path is this change, and whose move is it?* `pushed · submitted · ready ·
  needs-author · rejected · integrated · already-landed · withdrawn · canceled`.
- **`PR.state`** (`yrd-bay/src/model.ts`) — *is this PR record still an active
  object, or retired?* `open · closed`. Record lifetime, not delivery progress:
  a PR can be `closed` having reached any delivery state at all.
- **`Candidate.mergeability`** (`yrd-queue/src/model.ts`) — *can this composed
  candidate be built onto its base?* `unknown · mergeable · conflicting`. A
  property of the candidate, not of the PR, and `unknown` means not yet
  evaluated rather than evaluated-and-uncertain.
- **Job/Run `status` + `conclusion`** (§A6, GitHub verbatim) — *is this unit of
  work still going* (`queued · in_progress · waiting · completed`) and, once it
  is not, *how did it end* (`success · failure · cancelled · skipped ·
  timed_out`). Two questions deliberately kept in two fields; collapsing them
  is what makes "did it pass?" unanswerable for anything still running.
- **`StatusPresentationState` / `LifecycleStatus`** (`yrd-cli/src/status-presentation.ts`)
  — *what glyph and colour should a human see in this row?* Deliberately lossy
  and derived; never persisted, never an input to a decision.

Readiness is not in this list on purpose: per §B7 it is a projection over
mergeability, base currency, and Job conclusions, and nothing stores it.

**The collisions are the hazard, and they are real.** `PRDeliveryState` and
`StatusPresentationState` share four spellings — `needs-author`, `rejected`,
`integrated`, `canceled` — with different scopes, so a presentation word can be
read as a delivery fact. `LifecycleStatus` and `PR.state` both contain `open`,
meaning near-opposite things: not-yet-started versus not-yet-retired.
`mergeability` is the only union disjoint from every other, which is why it is
the only one that can be quoted without naming its vocabulary.

Rule: any surface printing or storing a status names which vocabulary it is
from. Any comparison between two statuses is a bug unless both come from the
same union.

## C. Decisions the packet left implicit (now explicit)

**C1. Contest placement.** Contest is an orchestration _above_ the landing
core: competitors produce Bays → PRs; evaluations are ordinary Jobs; promotion
submits the winner's PRRev to a Queue. Contest remains a first-class projected
collection in its own package, consuming PR/Job/Bay primitives — it is not in
the core hierarchy and adds no core concepts.

**C2. Queue concurrency model (v1): serial-head with batching, no stacked
speculation.** A Queue processes its queue FIFO; the head batch (up to
`batch: N`) forms one Candidate; its Run must reach the merge step before the
next Candidate is constructed. Concurrent check Runs for _other Queues_ and
other base branches proceed freely under Runner/Context execution.
GitHub-merge-queue-style stacked speculative candidates are explicitly out of
v1 — but the model already carries the seam (content-keyed Candidate artifacts
pinned to `baseSha` make speculative results reusable-iff-base-unchanged), so
speculation can arrive later as a scheduling plugin without model change.

**C3. Queue order.** FIFO by PRRev submission time. No priority DSL in v1;
reordering is an operator action, not config.

**C4. Merge lock scope.** The merge step acquires a per-`(repository, base
branch)` lock. Two Queues (two Flows) landing on the same base share that lock;
checks never take it.

**C5. Config authority is the base branch.** Flows and steps for evaluating a
Candidate come from the yard's own config (the base checkout / pinned flow
rev) — never from `.yrd.yml` content inside the submitted revisions. A PR that
edits `.yrd.yml` takes effect only after it lands. This is the same rule GitHub
enforces for `pull_request_target` workflows, and it is what makes contests
with agent-written (untrusted) candidate content safe to check.

**C6. Queue lifecycle verbs are deleted.** A Queue exists because a FlowDef
matched a submission on a base branch; it materializes lazily and needs no
provision/deprovision/init/deinit. Repo-level `yrd admin init` stays optional
(auto-init on first repository-backed command, exactly as today).

**C7. Config spelling audience rule.** Both spellings are the same bindings;
`yrd.*` for config authors, `with*` for extension authors; each doc surface
shows only its audience's spelling. No object-schema DSL, ever.

**C8. Post-merge failure invariant.** A failed post-merge `action` step never
reverts the merge: the base branch advance stands, the PR stays
`closed+merged`, the Run records `completed+failure`, and the failed Job is
retryable (`--retry`). Un-landing is a human/git decision outside Yrd.

**C9. Journal migration stance (pre-1.0).** No general event-upcaster or
history-rewrite machinery. The JSONL-to-SQLite container cutover preserves
every validated frame, identity, and committed opaque cursor exactly, then
makes the complete SQL file irrevocable authority. Domain-shape compatibility
still uses an explicit compensating event only when the owner can prove the
missing relation and expose typed refusals for everything it cannot prove;
container migration never invents domain facts.

**C10. Security invariants (absorbed from the standing P0).** Event/cause/
command ids unique across fresh CLI processes; all subprocess execution is
argv-array (no string interpolation into `sh -c`); Git ref/branch/issue names
are treated as hostile input at every boundary (they ride argv, never shell
text, and are schema-validated on intake).

**C11. The step plan is READ FROM GIT, per Run, at that Run's base sha.** There
is no durable step plan: `QueuesState.defaultSteps` is deleted. A Run's plan is
the `.yrd.yml` blob at the exact commit it is landing onto — checks plus the
built-in `merge`, the same derivation the process uses for its own config
(`declaredStepNames`, one definition, deliberately not spelled twice). The
effectful Queue facade reads it beside the base sha it already resolves and
hands it to the command, so `apply` stays a pure reducer over a plan it was
given. Four consequences, and each one paid for itself:

- **Durable state cannot change what runs.** While a plan was read back out of
  the projection, a checkpoint written before a check was declared kept that
  check from ever executing — and restarting could not activate it, because the
  restart replayed the same saved list.
- **A base that moves takes its config with it.** A Run re-prepared against a
  newer base sha resolves the plan at THAT sha, so a landed `.yrd.yml` edit is
  in force for the next Run without a restart and without `--steps`.
- **A config change is not a schema change.** The projection's checkpoint
  identity hashes the composition's initial state and registered event schemas.
  While the declared step list sat in that initial state, editing `.yrd.yml`'s
  `checks` moved the identity: it invalidated every stored checkpoint (a replay
  a retention-evicted journal cannot serve) and refused any Candidate carrying
  the edit with `checkpoint-migration-certificate-missing`. Steps register no
  per-step event schema, so which steps are installed is not a persisted
  contract and is deliberately outside the identity.
- **A plan this process cannot execute REFUSES.** A step def carries its
  runner-bound Job, registered when the process was built, so a name the base
  declares but this runner never installed has nothing to execute. Running the
  remainder is the original defect, so the Run refuses with
  `declared-step-not-installed`, naming the gap and the restart that closes it.
  That refusal is also what keeps the pure admission projections honest: they
  read the installed set, and no Run proceeds while the two disagree.

Every Run records what judged it and where it came from: `stepSelection.source`
is `declared-at-base` or `explicit`, `steps` is the list, and for a declared
plan `baseSha` and `configBlobSha` name the commit and the exact config bytes.
The per-step `revision` already digests the runner environment, so the record
carries that too without inventing a second digest.

**C12. The installed baseline is required INPUT to the audit, not optional
context.** `installed-baseline.json` under the state dir has exactly one writer,
`yrd admin queue init <base>` (`yrd admin init` is a different command — config
scaffold plus pre-submit hook — and never writes it). Reading it reports whether
the file was PRESENT, separately from how many baselines it held:

- **Absent ⇒ refuse.** `queue audit` and the run-start freshness gate both
  refuse with `installed-baseline-missing`, naming the resolved path and the
  creating command. Iterating an absent file as an empty one made "nothing
  drifted" and "nothing was read" the same sentence, and that clean answer was
  cited as evidence while the queue ran a plan its config did not declare.
- **Present ⇒ state the denominator.** The audit reports how many baselines it
  compared, which bases, and against what (the current config-derived
  descriptor, and this process's runtime when one is wired). A zero finding
  count without that population is not a result.
- **Between `deinit` and `init` there is no authority**, so the queue cannot
  certify freshness and does not start Runs until `init` restores it. The
  supervisor health probe is the one consumer that reads the same absence as
  `absent` — the service was never installed here — and it still carries the
  refusal's code and remedy in its payload.

## D. Current code → target (refit map, not a rewrite)

The implementation is close to the target; this is vocabulary + object
extraction, keeping the proven machinery (journal CAS, Job transitions,
receive-hook intake, bisection, waiting/finish/recover).

| Pre-refit                                                     | Target                                                                                      | Nature                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `Operation {op,args}`, `operation()`, `command()`, `invoke()` | `Command`, single `dispatch()`, `CommandResult`                                             | rename + surface collapse (yrd-core)                        |
| `Frame` exported from core domain                             | storage-internal to Journal                                                                 | demotion (yrd-core/yrd-persistence)                         |
| `PR` with 5-way `PRStatus` + embedded `revisions[]`           | `PR {state, merged}` + `PRRev` extracted; readiness derived                                 | shrink + extraction (yrd-bay → landing domain in yrd-queue) |
| `QueueRecord.prs: PRSnapshot[]` + `baseSha`                   | `Candidate` (id, exact receipt, artifact key, mergeability, ref)                            | extraction (yrd-queue)                                      |
| `QueueRun` status `running/waiting/passed/failed`             | `Run` with status+conclusion split                                                          | refit (yrd-queue)                                           |
| `InstalledStep {integrates, needsIntegration}`                | `StepDef {kind: check\|action\|merge}` + order                                              | refit (yrd-queue)                                           |
| Job results `passed/failed/waiting`                           | GitHub status+conclusion at the boundary; machine unchanged                                 | vocabulary (yrd-job)                                        |
| injected `checkRunner`/`mergeRunner` capabilities             | `Runner` seam + `localRunner` + `worktreeContexts` leases                                   | generalization (yrd-job/yrd-process)                        |
| programmatic composition only                                 | `@yrd/config`: `defineConfig` + `with*` + `yrd.*`; repository config remains YAML-only       | new package                                                 |
| standalone bay projection                                    | `yrd bay` subtree; no compatibility projection                                             | CLI surface deletion (yrd-cli)                              |
| `parent`/`isolationPart` bisection fields                     | child Candidates + `Run.parent` provenance                                                  | refit (yrd-queue)                                           |

Package set stays: core, bay, queue (landing domain: PR/PRRev/Candidate/Run/
Flow), job, issue, contest, cli, persistence, process (absorbed into the local
runner), plus new `@yrd/config`. `@yrd/github` deferred.

## E. What we lose / honest costs

- **Exactly-one flow matching** costs verbose mutually-exclusive predicates in
  multi-flow configs; bought: no silent shadowing (loud beats silent).
- **GitHub-verbatim spellings** import `in_progress`/`timed_out` underscores;
  bought: zero translation at every adapter boundary and familiar semantics.
- **Fresh-journal migration (C9)** drops historical run evidence from live v2
  projections (archive stays readable); bought: zero dual-decode machinery.
- **Four objects where today there is one** (PR/PRRev/Candidate/Run vs
  QueueRun) puts more ids in front of users; bought: each object answers
  exactly one question and the GitHub mapping becomes 1:1. CLI mitigates by
  showing the chain (`PR1 rev2 → C3 → R4`) in status output.
- **Serial-head Queues (C2)** cap throughput vs stacked speculation; bought:
  v1 scheduling stays trivially explainable, and the seam for speculation is
  already in the model.
- **Deferred `@yrd/github`** keeps Yrd local-only for now; bought: the first
  consumer (local queue cutover) arrives sooner, and the Runner/Context/
  candidate-ref seams are named so the adapter lands without model change.
- **Deleted lifecycle verbs (C6)** remove explicit pre-provisioning; bought:
  two fewer verbs and no state to desync. If a real operational need appears,
  `pause/resume` is additive.
