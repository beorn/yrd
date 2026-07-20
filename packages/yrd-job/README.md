# `@yrd/job`

`@yrd/job` adds durable executable work to a Yrd definition. It owns fixed Job
definitions, lifecycle projection, runner leases, heartbeats, waiting work,
recovery, and retries. It uses Core's Journal rather than a second store.

## Composition

Define executable work before creating the runtime:

```ts
const deliver = createJobDef({
  name: "message.deliver",
  title: "Deliver message",
  revision: "transport-v3",
  input: z.object({ text: z.string() }),
  output: z.object({ receipt: z.string() }),
  async execute(input, context) {
    const receipt = await transport.send(input.text, {
      idempotencyKey: context.id,
      attempt: context.attempt,
      signal: context.signal,
    })
    return { status: "passed", output: { receipt } }
  },
})

const definition = pipe(createYrdDef(), withJobs({ definitions: { [deliver.name]: deliver } }), withMessages(deliver))
```

`deliver.request(input, {key})` is a serializable `job/requested` event draft.
A domain command returns it beside its own events, so the request and domain
decision commit in one journal transaction. The request pins the definition revision;
execution refuses installed definition drift.

Definitions are immutable after composition. `Jobs` exposes:

```ts
yrd.jobs.definition(name)
yrd.jobs.requireDefinitions(definitions)
yrd.jobs.get(id)
yrd.jobs.run(id, options)
yrd.jobs.runMany(ids, { ...options, concurrency })
yrd.jobs.finish(id, completion)
yrd.jobs.retry(id)
yrd.jobs.recover(options)
yrd.jobs.requested(commandResult)
```

`requireDefinitions()` verifies that a composing domain sees the exact Job
revisions it supplied. `runMany()` executes requested Jobs with bounded
concurrency, refills each free worker slot, preserves input order, and returns
already-advanced Jobs without starting a second attempt.

## Lifecycle

```text
requested -> running -> passed
                    \-> failed -> requested (retry)
                    \-> waiting -> passed | failed
                    \-> lost ----> requested (retry)
```

`run()` starts the next attempt, heartbeats its lease, executes the pinned
definition, and settles only while the same runner still owns that attempt.
Losing ownership aborts the handler's `JobContext.signal` instead of allowing a
stale external operation to keep running.
Definitions may declare `observeResult(result)` to project their typed
`JobResult` into result-lifecycle attributes. Jobs validates the result against
the definition before invoking that hook and otherwise keeps output and error
evidence opaque. The same projection runs for local `run()` settlement
(including waiting work) and externally completed `finish()` work; projector
errors propagate rather than falling back to guessed payload traversal.
Handlers with observable work may call `context.observeProgress()` once and
`context.reportProgress()` whenever that work advances. Heartbeat ticks still
verify ownership, but renew the lease only after new progress; command-backed
Queue steps wire each child stdout/stderr chunk through this path. A stalled
child therefore expires and recovers as `lost`, while queue or scheduler delay
before the child's first output is governed by the Job lease and command's
wall-clock bound rather than misclassified as an inter-output stall.
`recover()` marks an expired running lease as lost only if a concurrent
heartbeat has not changed it. `retry()` returns a failed or lost Job to
`requested`; the same Job id is retained.

A definition parks externally owned work by returning:

```ts
return {
  status: "waiting",
  token: remote.id,
  url: remote.url,
  checkpoint: { candidate: input.sha },
}
```

Command-backed adapters use `parseJobLaunch(stdout)` for the shared launcher
contract. It reads the final JSON queue containing `token` and optional `url`,
`detail`, and `artifacts`; Queue and Contest therefore do not maintain separate
remote-job parsers.

Finish it with the exact runner, attempt, and token. Stale attempts, wrong
owners, and wrong tokens are refused without appending a transition. Revision
drift still blocks a not-yet-started Job, but it does not strand already waiting
work: completion is validated against the stable output contract registered
under the pinned definition name.

`JobError` carries a machine `code`, presentation `message`, and optional
JSON-safe `evidence`. The boundary that owns an evidence shape validates it
before returning the failure; Jobs preserves it verbatim through settlement
and replay. Consumers parse evidence by schema and never reconstruct it from
message prose. A failed Job's optional `output` remains definition-shaped
execution output such as command artifacts; `error.evidence` is the typed
terminal refusal fact. Do not duplicate the same fact across both channels.
Successful output contracts remain independent and unchanged.

## Delivery Semantics

Execution is at least once across a crash before settlement. Definitions that
perform external effects must deduplicate by stable `JobContext.id`, fence
stale `JobContext.attempt` values, honor `signal`, and treat a repeated call as
recovery. A heartbeat failure conservatively fails the attempt even when the
handler returned success, because ownership could not be proven through
settlement.

The projected events are `job/requested` and `job/transitioned`. Domain records
retain domain facts and stable Job keys or ids; status, attempts, ownership,
timing, waiting evidence, and execution results belong to `JobsState`.
