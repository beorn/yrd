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

const ready = await yrd.contests.run(contest.id, {
  executor: "local",
  leaseMs: 60_000,
  concurrency: 2,
})

await yrd.contests.select({ contest: ready.id, attempt: "A2" })
const promoted = await yrd.contests.promote(
  { contest: ready.id },
  { executor: "local", leaseMs: 60_000, concurrency: 2 },
)
```

`get()` and `list()` are synchronous signal-backed reads. Attempt runner,
evaluator, and promotion evidence is the actual shared `Job`; Contest does not
copy Job lifecycle state into a second record.

The public command tree exposes `task.compete`, `contest.select`, and
`contest.promote`. Internal request and finalize commands let the methodful
domain object drive restart-safe work without exposing orchestration plumbing.

## Evaluation And Promotion

An evaluator marked `held-out` is a promotion gate. An `advisory` evaluator is
retained as evidence but cannot make an attempt pass or select a winner. LLM
reviews normally belong in the advisory category.

Promotion requires a manually selected passing attempt. A durable verification
Job first resolves the attempt's write-once Git ref and proves that it still
names the selected commit. Contest then asks Bay to intake and submit that exact
commit as a PR and records finalization only after the PR exists. It never
substitutes the current branch tip.

Runner and evaluator definitions receive `JobContext.signal`. Local command
adapters inject the shared `@yrd/process` capability, which owns argv execution,
timeouts, cancellation, timing, and cleanup. External adapters may return a
`waiting` Job result and later finish that same durable Job.

Execution is at least once across a crash before settlement. Adapters must
deduplicate external effects by `JobContext.id` and fence stale
`JobContext.attempt` values.
