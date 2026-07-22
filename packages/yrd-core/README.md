# `@yrd/core`

`@yrd/core` supplies Yrd's immutable definition, command, event, projection,
runtime, and Journal contracts. It knows nothing about Jobs, Git, bays, queues,
contests, files, or the CLI.

## Definition And Runtime

`createYrdDef()` creates an immutable definition. A domain plugin extends it
with an initial state slice, command tree, event schemas, projector, and
methodful runtime feature:

```ts
function withMessages() {
  const send = command({
    title: "Send message",
    visibility: "public",
    params: z.object({ text: z.string().min(1) }),
    apply: (_state: MessageState, args) => ({
      events: [event("message/sent", args)],
    }),
  })

  return <State extends object, Commands extends CommandTree, Features extends object>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { messages: [] as string[] },
      commands: { message: { send } },
      events: { "message/sent": z.object({ text: z.string() }) },
      project(state, applied) {
        if (applied.name !== "message/sent") return state
        const data = applied.data as { text: string }
        return { messages: [...state.messages, data.text] }
      },
      create: (yrd) => ({
        messages: Object.freeze({
          list: () => yrd.state().messages,
          send: (text: string) => yrd.dispatch(send, { text }),
        }),
      }),
    })
}

const definition = pipe(createYrdDef(), withMessages())
await using yrd = await createYrd(definition, { inject: { journal, scope, log } })
await yrd.messages.send("hello")
```

Composition is synchronous. `createYrd()` asynchronously replays the injected
Journal and returns one frozen runtime. Plugins never mutate a running app.

## Command Contract

A Command is serializable JSON. Callers may provide an id, or let Core create a
process-unique UUIDv7 id:

```json
{ "op": "message.send", "args": { "text": "hello" } }
```

Commands synchronously decide event drafts from one immutable state snapshot.
Core validates arguments and event payloads with Zod, adds UUIDv7 command,
cause, and event ids, projects the candidate state, and appends one atomic
private journal transaction. External work must be requested as data and
executed after commit.

`dispatch()` is the only execution surface. It accepts either a trusted handler
reference plus arguments or a public serialized Command. It returns
`{ command, events, value? }`; handlers may use `value` for JSON-safe decision
results without exposing the Journal envelope.

Supplying the same Command id makes public retries exact. Trusted adapters can
use `dispatch(handler, args, { key })` when their idempotency identity is not a
UUID. The same id or key plus the same intent returns the committed result;
different arguments are refused.

## Failure Contract

Expected cross-package failures carry one JSON-safe `FailureFact`:

```ts
{ kind: "refusal", code: "command-id-conflict", message: "..." }
```

Use `createFailure()`, `asFailure()`, or `raiseFailure()` at the boundary that
knows the failure kind. `usage`, `configuration`, `refusal`, and
`infrastructure` are stable machine categories; `code` identifies the specific
condition and `message` remains presentation text. Untyped exceptions are not
silently inferred from their wording by downstream callers.

Human adapters project that immutable fact as `err=<code>`, a one-line cause,
and resolution steps (plus a reference for deep cases). The projection stays
outside `FailureFact`, so historical journal rows gain better guidance without
a schema migration.

## Reactive State

`yrd.state` is a synchronous `ReadSignal<DeepReadonly<State>>`. Domain objects
derive narrower signals with `computed()`. `await yrd.refresh()` replays journal records
written by another process and publishes the newest snapshot. Commands refresh
before deciding and publish after a successful append.

`await yrd.journalSnapshot()` captures that projected state together with its
journal cursor and latest event timestamp as one deeply frozen value. External
consumers use the cursor as an explicit resume/staleness boundary instead of
mixing projections from two journal cuts.

All state is rebuildable from the Journal. There is no mutable projection
database.

Persistence-backed runtimes expose `historySnapshot()` for an intentionally
complete replay, `events()` over all committed frames, and
`retentionDiagnostics()` for warm receipt and journal page counts. Core keeps
the latest 4,096 receipt frames in its private projection cache; an exact retry
outside that window resolves the original checksummed frame through the
Journal, compares canonical intent, and returns the committed result without
appending. Cause and event identities remain global through the same history
index. Journals without that optional capability retain the compatibility
behavior and do not enable plugin compaction.

An extension may declare `replayEvents` alongside its current `events`. Core
uses those schemas only to read committed historical payloads that predate a
strengthened contract. Dispatch always validates against the current event
schema, so replay compatibility cannot reopen a weak append path.

## Journal Contract

```ts
type Journal<Value> = {
  read(
    after?: number,
    before?: number,
  ): AsyncIterable<{
    cursor: number
    values: readonly Value[]
  }>
  append(
    value: Value,
    expectedCursor: number,
  ): Promise<{ appended: true; cursor: number } | { appended: false; cursor: number }>
  history?: {
    command(query: { id?: string; key?: string }): Value | undefined
    hasIdentity(kind: "cause" | "event", id: string): boolean
    entity(kind: "job" | "job-key" | "queue", id: string): readonly { cursor: number; value: Value }[]
    diagnostics(): JournalHistoryDiagnostics
  }
}
```

Append is optimistic compare-and-append. On conflict, Core catches up and reruns
the pure command decision. `createMemoryJournal()` is the focused-test adapter;
filesystem durability belongs to `@yrd/persistence`.

History is still Journal authority, not a projection database. Its facts must
be derived transactionally from frames and fail loud if a lookup disagrees with
the checksummed frame. Plugins may register a pure private `compact` projection
only because absence of `history` disables compaction for that runtime.

After a cold replay from initial state, every registered `validate` hook sees
the complete, unpruned projection before Core runs compaction once. Tail replay
validates the current live state after the whole incoming batch, before that
batch is compacted. `historySnapshot()` separately replays and validates all
authority without compaction. A compactor may mutate only its plugin's owned
state slice; its second argument is the complete read-only projection for that
pass, allowing dependent aggregates to preserve cross-slice references. An
append validates and compacts once after all events in its atomic Frame, never
between sibling events.
