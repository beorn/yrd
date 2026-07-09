# `@yrd/contest`

`@yrd/contest` compares multiple implementations of one recorded `@yrd/task`
task. Each competitor is identified by its complete model, harness, and
canonical JSON configuration. Each attempt gets an isolated `@yrd/bay` Bay and
records the immutable Git revision, runtime, token/cache/reasoning usage, USD
cost evidence, artifacts, and held-out evaluator results needed to choose work
that can actually ship.

Install it after core effects, tasks, and Bays:

```ts
const app = pipe(
  createYrd({ store }),
  withEffects(),
  withTasks(),
  withBays({ workspace }),
  withContests({ runners, evaluators, git }),
)
```

The only public mutations installed by the package are:

- `task.compete`: record a contest over an existing task.
- `contest.select`: manually select an attempt. Evaluators never select.
- `contest.promote`: verify and submit the selected pinned revision through
  Bay.

`app.contests.show(id)` and `app.contests.list()` are reads, not operations.
They append no events. `app.contestEffects.reconcile(id)` is the effect
orchestration boundary: it idempotently creates missing Bays and runner or
evaluator requests, then returns their durable statuses for a worker to run or
resume.

Runner and evaluator adapters are wrapped with core `fx()`. Requested,
running, waiting, heartbeat, failure, loss, retry, and completion evidence is
therefore recoverable from the shared event journal. Attempt artifacts remain
URIs or Git objects; this package creates no object store or sidecar.

An evaluator marked `held-out` is a promotion gate. An evaluator marked
`advisory` is retained as evidence but cannot make an attempt pass or choose a
winner. LLM reviews belong in the advisory category; they are not correctness
authorities.

Promotion requires all of the following:

- a manually selected attempt;
- a passing runner result and all held-out evaluators passing;
- a full immutable commit SHA paired with a Git ref, branch, and Bay;
- the ref still resolving to that exact SHA at promotion time.

The promotion effect is restart-safe. It reuses an exact existing Bay
submission or records and submits the selected SHA through internal Bay
operations. It never substitutes the Bay's current tip or another attempt.
