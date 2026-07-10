# `@yrd/job`

`@yrd/job` installs Yrd's durable executable-work capability over an
`@yrd/core` app. It owns Job definitions, lifecycle projection, executor
leases, heartbeats, waiting work, recovery, and retries. It does not own a
second store: every transition commits through Core's event journal.

```ts
const app = pipe(createYrd({ store }), withJobs())
```

## API

```ts
app.jobs.define(path, backend, options)
app.jobs.get(id)
app.jobs.run(id, options)
app.jobs.finish(id, completion)
app.jobs.retry(id)
app.jobs.recover(options)
```

Define typed executable work with an explicit semantic revision:

```ts
const deliver = app.jobs.define(
  ["message", "deliver"],
  async (input: { text: string }, context) => {
    const receipt = await transport.send(input.text, {
      idempotencyKey: context.id,
      attempt: context.attempt,
    })
    return { status: "passed", output: { receipt } }
  },
  { revision: "transport-v3", title: "Deliver message" },
)
```

`deliver.request(input)` is serializable data for an Operation's `jobs` array.
The enclosing command atomically records its domain events and generated Job
request. The request pins the definition revision; execution is refused if the
installed definition has drifted before it runs.

## Lifecycle

```text
requested -> running -> passed
                    \-> failed -> requested (retry)
                    \-> waiting -> passed | failed
                    \-> lost ----> requested (retry)
```

| State       | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `requested` | Durable input exists; no executor owns the next attempt                 |
| `running`   | One executor and attempt own a heartbeated, expiring lease               |
| `waiting`   | A launcher returned a token; no launcher lease expires the remote work   |
| `passed`    | Typed output and completion evidence were accepted                      |
| `failed`    | Typed error and optional output were accepted                           |
| `lost`      | A running executor's observed lease expired                             |

Run requested work through its pinned definition:

```ts
const job = await app.jobs.run(id, {
  executor: "worker-7",
  leaseMs: 60_000,
  heartbeatMs: 20_000,
})
```

The runtime starts the next attempt, heartbeats while the backend promise is
active, and settles only if that executor still owns the same running attempt.
`recover()` marks only expired running Jobs as lost and compares the observed
lease so a concurrent heartbeat wins. `retry()` preserves the Job id and
increments its attempt when it runs again.

## Waiting Work

A backend parks externally owned work by returning correlation evidence:

```ts
return {
  status: "waiting",
  token: remote.id,
  url: remote.url,
  checkpoint: { candidate: input.sha },
}
```

A waiting Job has no expiring launcher lease. Import its terminal result with
the exact owner, attempt, and token:

```ts
await app.jobs.finish(id, {
  attempt,
  executor,
  token,
  result: { status: "passed", output: evidence },
})
```

Stale attempts, wrong executors, and wrong tokens are refused without
appending an event. Domain packages should expose a narrow completion command;
the underlying `job.transition` command remains internal infrastructure.

## Delivery Semantics

Execution is **at least once** across process failure. A backend may perform an
external side effect and crash before its settlement frame commits. Yrd
guarantees one accepted transition for the current owner and attempt; it cannot
make an external transport transactional with the journal.

Backends must therefore:

1. deduplicate effects by stable `JobContext.id`;
2. fence or reject stale `JobContext.attempt` values;
3. return durable remote correlation as `waiting` when another system owns the
   long-running lifecycle;
4. treat repeated invocation as recovery, not permission to duplicate an
   irreversible effect.

Configured Line commands receive `YRD_JOB`, `YRD_ATTEMPT`, and `YRD_EXECUTOR`
for the same purpose.

## Events and State

The plugin projects one `JobsState` collection from:

```text
job/requested
job/started
job/heartbeat
job/waiting
job/finished
job/lost
job/retried
```

Domain records should retain domain facts and Job ids. Status, attempts,
timing, ownership, and execution evidence belong to this projection rather
than parallel lifecycle fields.
