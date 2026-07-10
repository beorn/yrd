# `@yrd/job`

`@yrd/job` adds durable executable work to a Yrd definition. It owns fixed Job
definitions, lifecycle projection, executor leases, heartbeats, waiting work,
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

const definition = pipe(
  createYrdDef(),
  withJobs({ definitions: { [deliver.name]: deliver } }),
  withMessages(deliver),
)
```

`deliver.request(input, {key})` is a serializable `job/requested` event draft.
A domain command returns it beside its own events, so the request and domain
decision commit in one Frame. The request pins the definition revision;
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
yrd.jobs.requested(frame)
```

`requireDefinitions()` verifies that a composing domain sees the exact Job
revisions it supplied. `runMany()` executes requested Jobs with bounded
concurrency, preserves input order, and returns already-advanced Jobs without
starting a second attempt.

## Lifecycle

```text
requested -> running -> passed
                    \-> failed -> requested (retry)
                    \-> waiting -> passed | failed
                    \-> lost ----> requested (retry)
```

`run()` starts the next attempt, heartbeats its lease, executes the pinned
definition, and settles only while the same executor still owns that attempt.
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
contract. It reads the final JSON line containing `token` and optional `url`,
`detail`, and `artifacts`; Line and Contest therefore do not maintain separate
remote-job parsers.

Finish it with the exact executor, attempt, and token. Stale attempts, wrong
owners, and wrong tokens are refused without appending a transition.

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
