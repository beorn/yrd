# Yrd Architecture

Yrd is composed from a small set of plain objects created by factory
functions. Those objects have methods. Their state, commands, events, and
results remain ordinary serializable data.

The distinction is deliberate:

- a `Job` is data and can cross a process boundary;
- `Jobs` is the object returned by the Jobs factory and owns Job operations;
- a transition helper may be pure, but it stays behind `Jobs` unless another
  domain genuinely needs it.

Yrd does not use classes, service locators, hidden globals, or one exported
function per implementation detail.

## Domain Objects

| Object     | Created by                                   | Responsibility                                                                             | Main surface                                                                                                                      |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `YrdDef`   | `createYrdDef()`                             | Immutable composition of state, commands, event schemas, projectors, and feature factories | `extend()`                                                                                                                        |
| `Yrd`      | `createYrd()`                                | Command validation, idempotency, event projection, reactive state, and feature access      | `state`, `refresh()`, `dispatch()`, `events()`, `close()`                                                                         |
| `Journal`  | `createMemoryJournal()` or `createJournal()` | Ordered durable frames with optimistic cursor concurrency                                  | `read()`, `append()`                                                                                                              |
| `Process`  | `createProcess()`                            | Scope-owned argv execution with bounded evidence and termination escalation                | `run()`, `close()`                                                                                                                |
| `Jobs`     | `withJobs()`                                 | Durable execution, leases, waiting work, retries, and recovery                             | `state`, `definition()`, `requireDefinitions()`, `get()`, `run()`, `runMany()`, `finish()`, `retry()`, `recover()`, `requested()` |
| `Issues`   | `withIssues()`                               | Resolve issue references through configured sources                                        | `sources`, `ref()`, `resolve()`                                                                                                   |
| `Bays`     | `withBays()`                                 | Query isolated bays and own revision-bound PR facts                                        | `state`, bay/PR queries, `submitSelection()`, `ready()`, `review()`, `comment()`, check requests, lifecycle mutations              |
| `Queue`    | `withQueue()`                                | Admit checks and integrate eligible PRs through one configured scheduler                   | `state`, `steps()`, `admit()`, eligibility/check projections, `pause()`, `resume()`, `run()`, `finish()`, `recover()`, `audit()`   |
| `Contests` | `withContests()`                             | Run, evaluate, select, and promote competing implementations                               | `state`, `resolveBase()`, `get()`, `list()`, `compete()`, `evaluate()`, `waiting()`, `finish()`, `select()`, `promote()`          |

`Process`, `Git`, issue sources, workspaces, runners, evaluators, clocks, ids,
loggers, and scopes are injected capabilities. A capability may be one
function or a small plain object; it is not a global singleton.

## Domain Data

The objects above operate on plain records:

| Record                 | Meaning                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `Command`              | Serializable request naming one registered handler and its arguments      |
| `Event`                | Validated fact emitted by a command                                       |
| `CommandResult`        | Dispatched command, committed events, and optional JSON result value      |
| `Issue`                | Versioned unit of intent from a configured issue source                   |
| `Bay`                  | Isolated worktree and its current Git facts                               |
| `PR`                   | Revision history plus pushed/submitted readiness, reviews, comments, and check requests |
| `Job`                  | Durable executable lifecycle and evidence                                 |
| `QueueRun`             | Pinned PR set, base, installed-step plan, reusable results, and integration facts |
| `Step`                 | Configured typed transition in a Queue                                    |
| `Contest`              | Issue, competitors, attempts, selection, and promotion facts              |
| `ContestEvaluationRun` | One versioned evaluator Job and typed result for an immutable attempt pin |
| `Artifact`             | Named evidence with a path or URL and media type                          |

Persisted records contain JSON data only. Zod schemas validate every untyped
boundary: CLI/config input, commands, events, Job input/output, adapter output,
and journal frames. Internal code does not repeatedly re-validate values that
have already crossed a named boundary.

## Composition

Composition is synchronous and immutable. Async resources are created first
and injected when the final runtime is built.

```ts
const bayJobs = createBayJobDefs(workspace)
const check = withStep("check", checkRunner, { revision: "check-v1" })
const merge = withMerge(mergeRunner, { revision: "merge-v1" })
const deploy = withStep("deploy", deployRunner, {
  revision: "deploy-v1",
  needsIntegration: true,
})
const queue = withQueue({ steps: [check, merge, deploy] as const })
const contests = withContests({ runners, evaluators, git })

const base = pipe(
  createYrdDef(),
  withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
  withIssues({ sources }),
  withBays({ jobs: bayJobs }),
)

const journal = await createJournal({ dir: stateDir })
await using yrd = await createYrd(contests(queue(base)), {
  inject: { journal, scope, log, clock, id },
})
```

Each `with*` returns a new `YrdDef`. It may add one state slice, command tree,
event schemas, projector, and one methodful feature object. Prerequisites are
encoded in its input type, so composition order is checked by TypeScript.

Plugins do not mutate an existing runtime, patch methods, attach private
symbols, or discover dependencies through a registry after startup.

### Candidate preparation and landing authority

External hosts may validate and hand off immutable source declarations and
trusted base configuration. Yrd Queue alone restacks those source revisions,
builds the generated root wrapper, verifies the resulting Candidate and its
source receipts, and lands that Candidate. A host must not maintain a second
restack scheduler, Candidate builder, integration queue, receipt store, or
landing path. The generated root wrapper is the Queue Candidate; it has no
parallel identity or composition lifecycle.

## Command Flow

```text
Command
  -> Zod command params
  -> command against a state snapshot
  -> Event drafts
  -> Zod event schemas
  -> project candidate state
  -> Journal.append(private transaction, expectedCursor)
  -> publish snapshot signal
  -> CommandResult
```

Commands are synchronous state decisions. External work is requested as a Job
event and executed after the transaction commits. This keeps cursor-conflict retries
safe: Yrd can refresh state and run the decision again without repeating an
external side effect.

Silvery's command-tree contracts supply command metadata, lookup, and argument
schemas. Yrd adds durable command identity and event projection; it does not
maintain a parallel command registry.

## Journal Authority

`Journal` has two operations:

```ts
journal.read(afterCursor)
journal.append(frame, expectedCursor)
```

`append` is compare-and-append. A stale cursor returns the current cursor; Yrd
replays committed frames and reruns the pure command decision. The filesystem
adapter takes its OS lock only for repair, comparison, append, and data sync.
There is no writer-lease API and no hidden async execution context.

The filesystem format is checksummed JSONL. `Bun.JSONL.parseChunk` parses
complete byte batches; Zod decodes frames. A final unterminated record is
uncommitted and ignored by readers, then truncated under the next append lock.
A malformed newline-terminated record is committed corruption and fails loud.

`yrd.state` is the synchronous reactive signal for the latest state this
runtime has observed. `await yrd.refresh()` incrementally catches up with Frames
another process appended, then publishes the newer snapshot through that same
signal. Commands refresh before deciding and publish after append.

The Journal warns at 10 MiB or 10,000 replayed frames. Compaction is explicit
as-needed work; the warning tells operators to implement compaction and GC
before raising either guardrail.

## Layers

```text
CLI / Git command projection
  -> Contest / Queue / Bay / Issue objects
  -> Jobs
  -> Yrd Core
  -> Journal interface
  -> Filesystem persistence adapter
```

Dependencies point down. Core has no knowledge of Jobs, Git, bays, queues,
contests, the filesystem, or the CLI. Persistence implements Core's Journal
interface. Domain packages depend on Core and on the lower domain objects they
actually use.

## Lifecycle and Observability

Every runtime owns a child `Scope`. Timers, subprocesses, subscriptions, and
temporary resources belong to that scope or one of its children. Package code
does not create unmanaged timers.

Public `Yrd`, `Process`, and `YrdHost` objects implement `AsyncDisposable`, so
callers can own them with `await using`. Their async-dispose hooks share the
same idempotent lifecycle as `close()` and release owned scopes and resources
exactly once.

All diagnostic output and timing uses Loggily namespaces and spans. Domain
results remain return values and events; CLI formatting is a presentation
layer over those values, not a second logging path. Core replay spans report
their frame count, event count, and cursor range along with Loggily's duration.

Expected failures cross package boundaries as one serializable `FailureFact`
with `kind`, stable `code`, and `message`. The CLI has one pure projection from
that fact to its exit verdict. It never infers machine behavior from error
text; an untyped exception is an infrastructure failure.

## Design Tests

Review a change against these questions:

1. Is this operation discoverable as a method on one of the objects above?
2. Is a new abstraction replacing real duplication, or only renaming a helper?
3. Is untyped data validated once at a named Zod boundary?
4. Is every dependency explicit in a factory argument or `inject` object?
5. Is every long-lived resource owned by a Scope?
6. Can the top-level composition be read as the architecture?
7. Can a command retry after a Journal cursor conflict without repeating an
   external effect?

If a change needs many new exported functions, a manager/controller class, a
second state representation, or a second command/event system, the object
model is missing a method or the change is at the wrong layer.
