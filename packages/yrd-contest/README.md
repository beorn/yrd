# `@yrd/contest`

`@yrd/contest` compares multiple implementations of one real `@yrd/task`
Task. Every competitor gets an isolated `@yrd/bay` Work Bay. Yrd records the
immutable result commit, runtime, token and cost evidence, artifacts, and
held-out evaluations needed to choose work that can actually ship.

## Composition

Contest runners, evaluators, and Git verification are immutable definitions.
Create the Contest plugin first so its Jobs can be installed with the rest of
the runtime:

```ts
const bayJobs = createBayJobDefs(workspace)
const contests = withContests({ runners, evaluators, git })

const base = pipe(
  createYrdDef(),
  withJobs({ definitions: [bayJobs, contests.jobDefs] }),
  withTasks({ sources }),
  withBays({ jobs: bayJobs }),
)

const yrd = await createYrd(contests(base), { inject: { journal } })
```

Definitions cannot be added or replaced after Yrd starts. Queued Jobs pin the
definition revision they were created with and refuse to run after revision
drift.

Runner definitions and their launch arguments are trusted organizer
configuration. Task text and competitor output are untrusted inputs, but Yrd
does not sandbox flags deliberately installed by the operator. An adapter that
accepts competitor definitions from another trust domain must validate or
allowlist those flags before composition.

## Domain API

`yrd.contests` is the methodful Contest domain object:

```ts
const base = await yrd.contests.resolveBase()
const contest = await yrd.contests.compete({
  task,
  competitors,
  base: base.base,
  baseSha: base.sha,
})

const ready = await yrd.contests.evaluate(contest.id, {
  executor: "local",
  leaseMs: 60_000,
  concurrency: 2,
})

const reevaluated = await yrd.contests.evaluate(contest.id, {
  executor: "local",
  leaseMs: 60_000,
  concurrency: 2,
  retry: true,
})

const waiting = yrd.contests.waiting(contest.id, "A2", "security")
await yrd.contests.finish({
  contest: contest.id,
  attempt: waiting.attempt,
  evaluator: waiting.evaluator,
  token: waiting.job.token,
  result: { status: "passed", output: { verdict: "passed", artifacts: [] } },
})

await yrd.contests.select({ contest: ready.id, attempt: "A2" })
const promoted = await yrd.contests.promote(
  { contest: ready.id },
  { executor: "local", leaseMs: 60_000, concurrency: 2 },
)
```

`get()` and `list()` are synchronous signal-backed reads. Attempt runner,
evaluation-run, and promotion evidence is the actual shared `Job`; Contest
does not copy Job lifecycle state into a second record. `retry: true` retries a
failed or lost infrastructure Job under the same id. A completed evaluator Job
whose candidate verdict failed creates a new evaluator Job generation instead.
Earlier evidence remains immutable, appears as separate human-status rows, and
a pinned competitor is never rerun.

The public command tree exposes `task.compete`, `contest.select`, and
`contest.promote`. The CLI also projects the methodful `evaluate()` operation
as `yrd contest evaluate`; internal request and finalize commands keep
restart-safe reconciliation out of the public command tree.

## Evaluation And Promotion

An evaluator marked `held-out` is a promotion gate. An `advisory` evaluator is
retained as evidence but cannot make an attempt pass or select a winner. LLM
reviews normally belong in the advisory category.

Selection requires every configured evaluation to be terminal and one manually
chosen passing attempt. A durable verification Job first resolves the attempt's
write-once Git ref and proves that it still names the selected commit. Contest
then asks Bay to intake and submit that exact
commit as a PR and records finalization only after the PR exists. It never
substitutes the current branch tip.

Runner and evaluator definitions receive `JobContext.signal`. Local command
adapters inject the shared `@yrd/process` capability, which owns argv execution,
timeouts, cancellation, timing, and cleanup. External adapters may return a
`waiting` Job result and later finish that same durable Job.

A configured evaluator with `runner: waiting` uses the same launcher JSON as a
waiting Line step: the final stdout line contains `token` and optional `url`,
`detail`, and `artifacts`. Yrd records that launch evidence, cleans the local
detached checkout, and waits for token-fenced completion of the evaluator Job.
Complete it through `yrd contest finish`; the generic Job transition command is
not exposed. A launched waiting Job remains finishable after configuration
revision drift because its pinned identity and stable output contract still
fence completion.

The local command evaluator materializes the immutable pin as a detached
scratch worktree. Its checkout parent is injected by the host, and the
configured evaluator command provisions dependencies from the candidate's own
lockfile. Yrd does not graft mutable host packages into the checkout. This is
not sandboxing; use a remote or isolated Process adapter when candidate code
requires a stronger trust boundary.

Execution is at least once across a crash before settlement. Adapters must
deduplicate external effects by `JobContext.id` and fence stale
`JobContext.attempt` values.
