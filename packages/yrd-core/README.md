# `@yrd/core`

`@yrd/core` supplies Yrd's command, event, projection, and Journal contracts.
It knows nothing about Jobs, Git, bays, lines, contests, files, or the CLI.

## Objects

`createYrdDef()` returns an immutable definition object. Domain plugins call
`definition.extend()` to add state, commands, event schemas, a projector, and
one runtime feature object.

`createYrd()` validates and replays the injected Journal before returning a
plain runtime object:

```ts
const definition = pipe(createYrdDef(), withMessages())
const yrd = await createYrd(definition, {
  inject: { journal, scope, log, clock, id },
})

await yrd.command(yrd.commands.message.send, { text: "hello" })
const state = await yrd.state()
await yrd.close()
```

Use `await using` when the caller owns the runtime:

```ts
await using yrd = await createYrd(definition, { inject: { journal } })
```

## Plugin Shape

```ts
function withMessages() {
  const send = command(
    (_state: MessageState, args: { text: string }) => ({
      events: [event("message/sent", args)],
    }),
    {
      title: "Send message",
      visibility: "public",
      params: z.object({ text: z.string().min(1) }),
    },
  )

  return <Def extends AnyYrdDef>(definition: Def) =>
    definition.extend({
      initialState: { messages: [] as string[] },
      commands: { message: { send } },
      events: { "message/sent": z.object({ text: z.string() }) },
      project(state, applied) {
        if (applied.name !== "message/sent") return state
        return { ...state, messages: [...state.messages, applied.data.text] }
      },
      create(yrd) {
        return {
          messages: {
            async list() {
              return (await yrd.state()).messages
            },
          },
        }
      },
    })
}
```

The returned `yrd.messages` is a methodful plain object. Pure projection and
validation helpers stay inside the plugin rather than becoming a flat public
utility API.

## Command Contract

An Operation is JSON data:

```json
{ "op": "message.send", "args": { "text": "hello" } }
```

`@silvery/commands` owns the command tree and parameter-schema shape. Core
adds:

- public versus internal visibility;
- stable caller-supplied command ids;
- a canonical operation hash;
- one atomic Frame per accepted command;
- exact retry deduplication;
- projection before append.

Command handlers are synchronous state decisions. They return only event
drafts. External work is represented by domain events, such as
`job/requested`, and runs after commit.

## State

`await yrd.state()` incrementally replays new frames before returning. It is
the ordinary read API and is safe for another process's recent writes.

`yrd.snapshot` is a synchronous read signal containing the newest state this
runtime has observed. Commands and `state()` publish it after successful
replay or append.

All state is rebuildable from the Journal. There is no mutable projection
database.

## Journal Contract

Core depends on one small object:

```ts
type Journal<Value> = {
  read(after?: number, before?: number): AsyncIterable<{
    cursor: number
    values: readonly Value[]
  }>
  append(value: Value, expectedCursor: number): Promise<
    | { appended: true; cursor: number }
    | { appended: false; cursor: number }
  >
}
```

Append is optimistic compare-and-append. On conflict, Core catches up and runs
the pure command decision again. This removes writer leases, hidden async
context, and duplicated memory/filesystem queues from Core.

`createMemoryJournal()` is the focused-test implementation. Filesystem
durability belongs to `@yrd/persistence`.
