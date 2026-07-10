# `@yrd/core`

`@yrd/core` supplies Yrd's immutable definition, command, event, projection,
runtime, and Journal contracts. It knows nothing about Jobs, Git, bays, lines,
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
          send: (text: string) => yrd.command(send, { text }),
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

An Operation is serializable JSON:

```json
{ "op": "message.send", "args": { "text": "hello" } }
```

Commands synchronously decide event drafts from one immutable state snapshot.
Core validates arguments and event payloads with Zod, adds a command id and
canonical operation hash, projects the candidate state, and appends one atomic
Frame. External work must be requested as data and executed after commit.

`command()` accepts a command object reference for trusted in-process calls.
`invoke()` accepts a public serialized Operation. Supplying a stable
`commandId` makes retries exact: the same operation returns its committed Frame;
different arguments under that id are refused.

## Reactive State

`yrd.state` is a synchronous `ReadSignal<DeepReadonly<State>>`. Domain objects
derive narrower signals with `computed()`. `await yrd.refresh()` replays Frames
written by another process and publishes the newest snapshot. Commands refresh
before deciding and publish after a successful append.

All state is rebuildable from the Journal. There is no mutable projection
database.

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
}
```

Append is optimistic compare-and-append. On conflict, Core catches up and reruns
the pure command decision. `createMemoryJournal()` is the focused-test adapter;
filesystem durability belongs to `@yrd/persistence`.
