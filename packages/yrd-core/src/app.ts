import {
  commandNode as createCommandNode,
  createCommandRegistry as createCommandTreeRegistry,
  type Availability,
  type CommandNode,
  type CommandNodeTree as SilveryCommandTree,
  type ParamSchema,
  type CommandRegistry as SerializableCommandRegistry,
} from "@silvery/command"
import { createScope, type Scope } from "@silvery/scope"
import { signal, type ReadSignal } from "@silvery/signals"
import { createLogger, type ConditionalLogger } from "loggily"
import { v7 as uuidv7 } from "uuid"
import * as z from "zod"
import {
  CauseSchema,
  Command as CommandDomain,
  CommandInputSchema,
  EventSchema,
  JsonSchema,
  type Cause,
  type Command,
  type CommandInput,
  type CommandResult,
  type Event,
  type EventDraft,
  type JsonValue,
} from "./domain.ts"
import { asFailure, raiseFailure } from "./failure.ts"
import { parseJournalFrame, type JournalFrame } from "./frame.ts"
import { cloneFrozen, freeze, type DeepReadonly } from "./immutable.ts"
import type { Cursor, Journal } from "./journal.ts"

export type { DeepReadonly } from "./immutable.ts"

export type ApplyResult = Readonly<{ events: readonly EventDraft[]; value?: JsonValue }>

export type CommandContext<State extends object> = Readonly<{
  state: DeepReadonly<State>
  cause: Cause
  command: Command
}>

export type CommandHandler<Args extends JsonValue | undefined = undefined, State extends object = object> = CommandNode<
  CommandContext<State>,
  Args,
  ApplyResult
>

export type AnyCommand = Omit<CommandNode<never, never, ApplyResult>, "params"> &
  Readonly<{ params?: ParamSchema<unknown> }>
export type CommandTree = {
  readonly [segment: string]: AnyCommand | CommandTree
}

export type DispatchOptions = Readonly<{
  key?: string
  traceId?: string
  spanId?: string
}>

export type CommandDef<State extends object, Args extends JsonValue | undefined> = Readonly<{
  title: string
  description?: string
  visibility?: "public" | "internal"
  params?: ParamSchema<Args>
  isAvailable?: (context: CommandContext<State>) => Availability
  apply(state: DeepReadonly<State>, args: Args, context: Omit<CommandContext<State>, "state">): ApplyResult
}>

type EventSchemas = Readonly<Record<string, z.ZodType<JsonValue>>>
type Project<State extends object> = (state: DeepReadonly<State>, event: Event, cause: Cause) => State
type Empty = Readonly<Record<never, never>>

export type Dispatch = {
  <Args extends JsonValue | undefined, CommandState extends object>(
    command: CommandHandler<Args, CommandState>,
    args: Args,
    options?: DispatchOptions,
  ): Promise<CommandResult>
  (command: CommandInput, options?: DispatchOptions): Promise<CommandResult>
}

export type Yrd<State extends object, Commands extends CommandTree> = Readonly<{
  commands: Commands
  state: ReadSignal<DeepReadonly<State>>
  scope: Scope
  log: ConditionalLogger
  refresh(): Promise<DeepReadonly<State>>
  dispatch: Dispatch
  events(): AsyncIterable<Event>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}>

type Contribution<
  State extends object,
  Commands extends CommandTree,
  Features extends object,
  AddedState extends object,
  AddedCommands extends CommandTree,
  AddedFeatures extends object,
> = Readonly<{
  initialState?: AddedState
  commands?: AddedCommands
  events?: EventSchemas
  project?(state: DeepReadonly<AddedState>, event: Event, cause: Cause): AddedState
  create?(yrd: Yrd<State & AddedState, Commands & AddedCommands> & Features): AddedFeatures
}>

export type YrdDef<
  State extends object = Empty,
  Commands extends CommandTree = Empty,
  Features extends object = Empty,
> = Readonly<{
  initialState: DeepReadonly<State>
  commands: Commands
  events: EventSchemas
  project: Project<State>
  create(yrd: Yrd<State, Commands>): Features
  extend<
    AddedState extends object = Empty,
    AddedCommands extends CommandTree = Empty,
    AddedFeatures extends object = Empty,
  >(
    contribution: Contribution<State, Commands, Features, AddedState, AddedCommands, AddedFeatures>,
  ): YrdDef<State & AddedState, Commands & AddedCommands, Features & AddedFeatures>
}>

export type StateOf<Def> = Def extends YrdDef<infer State, infer _Commands, infer _Features> ? State : never
export type CommandsOf<Def> = Def extends YrdDef<infer _State, infer Commands, infer _Features> ? Commands : never
export type FeaturesOf<Def> = Def extends YrdDef<infer _State, infer _Commands, infer Features> ? Features : never
export type YrdOf<Def> =
  Def extends YrdDef<infer State, infer Commands, infer Features> ? Yrd<State, Commands> & Features : never

export function command<State extends object>(
  definition: CommandDef<State, undefined> & Readonly<{ params?: never }>,
): CommandHandler<undefined, State>
export function command<State extends object, Args extends JsonValue>(
  definition: CommandDef<State, Args> & Readonly<{ params: ParamSchema<Args> }>,
): CommandHandler<Args, State>
export function command<State extends object, Args extends JsonValue | undefined>(
  definition: CommandDef<State, Args>,
): CommandHandler<Args, State> {
  const node = createCommandNode({
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(definition.params === undefined ? {} : { params: definition.params }),
    ...(definition.isAvailable === undefined ? {} : { isAvailable: definition.isAvailable }),
    metadata: Object.freeze({ visibility: definition.visibility ?? "internal" }),
    run(context, args) {
      try {
        return definition.apply(context.state, args, {
          cause: context.cause,
          command: context.command,
        })
      } catch (error) {
        throw asFailure(error, { kind: "refusal", code: "command-refused" })
      }
    },
  })
  return Object.freeze(node)
}

export function createYrdDef(): YrdDef {
  return buildDef({
    initialState: {},
    commands: {},
    events: {},
    project: (state) => state,
    create: () => ({}),
  })
}

export async function createYrd<State extends object, Commands extends CommandTree, Features extends object>(
  definition: YrdDef<State, Commands, Features>,
  options: Readonly<{
    inject: Readonly<{
      journal: Journal<unknown>
      clock?: () => string
      id?: () => string
      log?: ConditionalLogger
      scope?: Scope
    }>
  }>,
): Promise<Yrd<State, Commands> & Features> {
  const journal = options.inject.journal
  const clock = options.inject.clock ?? (() => new Date().toISOString())
  const id = options.inject.id ?? uuidv7
  const log = options.inject.log ?? createLogger("yrd")
  const coreLog = log.child("core")
  const scope = options.inject.scope?.child("yrd") ?? createScope("yrd")
  const commands = definition.commands as Commands
  const registry = createCommandTreeRegistry(
    commands as SilveryCommandTree<unknown>,
  ) as SerializableCommandRegistry<AnyCommand>
  const state = signal<DeepReadonly<State>>(cloneFrozen(definition.initialState) as DeepReadonly<State>)

  type Projection = Readonly<{
    cursor: Cursor
    state: DeepReadonly<State>
    receiptsById: ReadonlyMap<string, JournalFrame>
    receiptsByKey: ReadonlyMap<string, JournalFrame>
    causeIds: ReadonlySet<string>
    eventIds: ReadonlySet<string>
  }>

  let projection: Projection = {
    cursor: 0,
    state: state(),
    receiptsById: new Map(),
    receiptsByKey: new Map(),
    causeIds: new Set(),
    eventIds: new Set(),
  }
  let closing = false
  let closePromise: Promise<void> | undefined
  const active = new Set<Promise<unknown>>()

  const fold = async (base: Projection): Promise<Projection> => {
    using span = coreLog.span?.("replay", { after: base.cursor })
    let next = base
    let frames = 0
    let events = 0
    for await (const batch of journal.read(base.cursor)) {
      if (batch.cursor <= next.cursor) throw new Error("yrd: journal cursor did not advance")
      for (const value of batch.values) {
        const frame = parseJournalFrame(value)
        frames += 1
        events += frame.events.length
        next = projectFrame(next, frame)
      }
      next = { ...next, cursor: batch.cursor }
    }
    if (span) Object.assign(span.spanData, { frames, events, fromCursor: base.cursor, toCursor: next.cursor })
    return next
  }

  const projectFrame = (base: Projection, frame: JournalFrame): Projection => {
    if (base.receiptsById.has(frame.command.id)) {
      throw new Error(`yrd: journal contains duplicate command id '${frame.cause.commandId}'`)
    }
    if (frame.cause.key !== undefined && base.receiptsByKey.has(frame.cause.key)) {
      throw new Error(`yrd: journal contains duplicate command key '${frame.cause.key}'`)
    }
    const causeIds = new Set(base.causeIds)
    if (causeIds.has(frame.cause.id)) throw new Error(`yrd: journal contains duplicate cause id '${frame.cause.id}'`)
    causeIds.add(frame.cause.id)
    const eventIds = new Set(base.eventIds)
    let nextState = base.state
    for (const applied of frame.events) {
      if (eventIds.has(applied.id)) throw new Error(`yrd: journal contains duplicate event id '${applied.id}'`)
      eventIds.add(applied.id)
      const schema = definition.events[applied.name]
      if (schema === undefined) throw new Error(`yrd: no event definition for '${applied.name}'`)
      const validated = freeze(EventSchema.parse({ ...applied, data: schema.parse(applied.data) })) as Event
      nextState = freeze(definition.project(nextState, validated, frame.cause)) as DeepReadonly<State>
    }
    const receiptsById = new Map(base.receiptsById)
    receiptsById.set(frame.command.id, frame)
    const receiptsByKey = new Map(base.receiptsByKey)
    if (frame.cause.key !== undefined) receiptsByKey.set(frame.cause.key, frame)
    return { ...base, state: nextState, receiptsById, receiptsByKey, causeIds, eventIds }
  }

  const publish = (next: Projection): void => {
    if (next.cursor <= projection.cursor) return
    projection = next
    state(next.state)
  }

  const assertOpen = (): void => {
    if (closing || scope.signal.aborted) throw new Error("yrd: runtime is closed")
  }

  const refresh = async (): Promise<DeepReadonly<State>> => {
    assertOpen()
    const next = await fold(projection)
    publish(next)
    return state()
  }

  const dispatchCommand = async (
    input: CommandInput,
    trace: DispatchOptions | undefined,
    visibility: "public" | "trusted",
  ): Promise<CommandResult> => {
    assertOpen()
    let parsed: CommandInput
    try {
      parsed = freeze(CommandInputSchema.parse(input)) as CommandInput
    } catch (error) {
      throw asFailure(error, { kind: "usage", code: "invalid-command" })
    }
    const registered = registry.commandAt(parsed.op)
    if (registered === undefined) {
      raiseFailure("usage", "unknown-command", `yrd: unknown command '${parsed.op}'`)
    }
    const selected = registered as unknown as RuntimeCommand
    if (visibility === "public" && selected.metadata?.visibility !== "public") {
      raiseFailure("usage", "internal-command", `yrd: internal command '${parsed.op}' is not publicly available`)
    }

    const canonical = canonicalCommand(selected, parsed.op, parsed.args, parsed.id ?? id())
    const cause = CauseSchema.parse({
      id: id(),
      commandId: canonical.id,
      op: canonical.op,
      commandHash: CommandDomain.hash(canonical),
      ...(trace?.key === undefined ? {} : { key: trace.key }),
      ...(trace?.traceId === undefined ? {} : { traceId: trace.traceId }),
      ...(trace?.spanId === undefined ? {} : { spanId: trace.spanId }),
    })

    while (!closing && !scope.signal.aborted) {
      const current = await fold(projection)
      const byId = current.receiptsById.get(canonical.id)
      const byKey = trace?.key === undefined ? undefined : current.receiptsByKey.get(trace.key)
      if (byId !== undefined && byKey !== undefined && byId !== byKey) {
        raiseFailure(
          "refusal",
          "command-key-conflict",
          `yrd: command id '${canonical.id}' and key '${trace?.key}' disagree`,
        )
      }
      const receipt = byKey ?? byId
      if (receipt !== undefined) {
        if (receipt.cause.commandHash !== cause.commandHash) {
          raiseFailure(
            "refusal",
            "command-id-conflict",
            `yrd: command ${trace?.key === undefined ? `id '${canonical.id}'` : `key '${trace.key}'`} was already used for a different command`,
          )
        }
        publish(current)
        return commandResult(receipt)
      }

      const context = { state: current.state, cause, command: canonical }
      const unavailable = unavailableReason(selected.isAvailable?.(context))
      if (unavailable !== null) {
        raiseFailure(
          "refusal",
          "command-unavailable",
          `yrd: command '${parsed.op}' is unavailable${unavailable ? `: ${unavailable}` : ""}`,
        )
      }
      const result = selected.run(context, canonical.args)
      if (isThenable(result)) {
        raiseFailure("configuration", "async-command", `yrd: command '${parsed.op}' must be synchronous`)
      }
      const events = result.events.map((draft) => {
        const schema = definition.events[draft.name]
        if (schema === undefined) {
          raiseFailure("configuration", "event-not-installed", `yrd: no event definition for '${draft.name}'`)
        }
        return EventSchema.parse({ id: id(), name: draft.name, ts: clock(), data: schema.parse(draft.data) })
      })
      const value = result.value === undefined ? undefined : JsonSchema.parse(result.value)
      const frame = parseJournalFrame({ cause, command: canonical, events, ...(value === undefined ? {} : { value }) })
      const candidate = projectFrame(current, frame)
      const appended = await journal.append(frame, current.cursor)
      if (!appended.appended) continue
      publish({ ...candidate, cursor: appended.cursor })
      return commandResult(frame)
    }
    throw new Error("yrd: runtime is closed")
  }

  const track = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    assertOpen()
    const task = operation().finally(() => {
      active.delete(task)
    })
    active.add(task)
    return task
  }

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise
    closing = true
    closePromise = (async () => {
      await Promise.allSettled(active)
      await scope.disposeAsync()
    })()
    return closePromise
  }

  const dispatch: Dispatch = ((
    input: CommandInput | AnyCommand,
    argsOrOptions?: JsonValue | DispatchOptions,
    commandOptions?: DispatchOptions,
  ) => {
    if (isCommand(input)) {
      return track(() =>
        dispatchCommand(serialize(registry, input, argsOrOptions as JsonValue | undefined), commandOptions, "trusted"),
      )
    }
    return track(() => dispatchCommand(input, argsOrOptions as DispatchOptions | undefined, "public"))
  }) as Dispatch

  const core: Yrd<State, Commands> = Object.freeze({
    commands,
    state,
    scope,
    log,
    refresh: () => track(refresh),
    dispatch,
    async *events() {
      await refresh()
      const before = projection.cursor
      for await (const batch of journal.read(0, before)) {
        for (const value of batch.values) yield* parseJournalFrame(value).events
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  })

  try {
    projection = await fold(projection)
    state(projection.state)
    const features = definition.create(core)
    return mergeFields(core, features, "feature")
  } catch (error) {
    closing = true
    await scope.disposeAsync()
    throw error
  }
}

function buildDef<State extends object, Commands extends CommandTree, Features extends object>(values: {
  initialState: DeepReadonly<State>
  commands: Commands
  events: EventSchemas
  project: Project<State>
  create(yrd: Yrd<State, Commands>): Features
}): YrdDef<State, Commands, Features> {
  const definition: YrdDef<State, Commands, Features> = {
    ...values,
    extend<
      AddedState extends object = Empty,
      AddedCommands extends CommandTree = Empty,
      AddedFeatures extends object = Empty,
    >(
      contribution: Contribution<State, Commands, Features, AddedState, AddedCommands, AddedFeatures>,
    ): YrdDef<State & AddedState, Commands & AddedCommands, Features & AddedFeatures> {
      const addedState = contribution.initialState ?? ({} as AddedState)
      const addedCommands = contribution.commands ?? ({} as AddedCommands)
      const initialState = mergeState(values.initialState, addedState)
      const commands = mergeCommands(values.commands, addedCommands)
      const events = mergeFields(values.events, contribution.events ?? {}, "event")
      const previousFields = Object.keys(values.initialState)
      const owned = Object.keys(addedState)
      return buildDef<State & AddedState, Commands & AddedCommands, Features & AddedFeatures>({
        initialState,
        commands,
        events,
        project(state, applied, cause) {
          const previousState = selectFields(state, previousFields) as DeepReadonly<State>
          const projected = {
            ...state,
            ...values.project(previousState, applied, cause),
          } as State & AddedState
          if (contribution.project === undefined) return projected as State & AddedState
          const ownedState = selectFields(projected, owned) as DeepReadonly<AddedState>
          const patch = contribution.project(ownedState, applied, cause)
          assertOwnedFields(patch, owned)
          return { ...projected, ...patch }
        },
        create(core) {
          const features = values.create(core as Yrd<State, Commands>)
          const available = mergeFields(core, features, "feature")
          const added: AddedFeatures =
            contribution.create?.(available as Yrd<State & AddedState, Commands & AddedCommands> & Features) ??
            ({} as AddedFeatures)
          mergeFields(available, added, "feature")
          return mergeFields(features, added, "feature")
        },
      })
    },
  }
  return Object.freeze(definition)
}

function mergeFields<Left extends object, Right extends object>(left: Left, right: Right, kind: string): Left & Right {
  for (const key of Object.keys(right)) {
    if (Object.hasOwn(left, key)) throw new Error(`yrd: duplicate ${kind} '${key}'`)
  }
  return Object.freeze({ ...left, ...right })
}

function mergeState<State extends object, AddedState extends object>(
  state: DeepReadonly<State>,
  added: AddedState,
): DeepReadonly<State & AddedState> {
  for (const key of Object.keys(added)) {
    if (Object.hasOwn(state, key)) throw new Error(`yrd: duplicate state '${key}'`)
  }
  return cloneFrozen({ ...state, ...added }) as DeepReadonly<State & AddedState>
}

function mergeCommands<Left extends CommandTree, Right extends CommandTree>(
  left: Left,
  right: Right,
  path: readonly string[] = [],
): Left & Right {
  const merged: Record<string, unknown> = { ...left }
  for (const [segment, value] of Object.entries(right)) {
    const previous = merged[segment]
    if (previous === undefined) {
      merged[segment] = value
      continue
    }
    if (isCommand(previous) || isCommand(value)) {
      throw new Error(`yrd: duplicate command '${[...path, segment].join(".")}'`)
    }
    merged[segment] = mergeCommands(previous as CommandTree, value as CommandTree, [...path, segment])
  }
  return Object.freeze(merged) as Left & Right
}

function assertOwnedFields(value: object, owned: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const expected = [...owned].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`yrd: projector must return exactly its owned state fields: ${expected.join(", ") || "(none)"}`)
  }
}

function selectFields(value: object, fields: readonly string[]): object {
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]))
}

function isCommand(value: unknown): value is AnyCommand {
  return typeof value === "object" && (value as { kind?: unknown })?.kind === "command"
}

function unavailableReason(value: Availability | undefined): string | null {
  if (value === undefined || value === true) return null
  if (value === false) return ""
  if (typeof value === "string") return value
  return value.available ? null : (value.reason ?? "")
}

type RuntimeCommand = Omit<AnyCommand, "isAvailable" | "run"> &
  Readonly<{
    isAvailable?: (context: CommandContext<object>) => Availability
    run(context: CommandContext<object>, args: JsonValue | undefined): ApplyResult | Promise<ApplyResult>
  }>

function canonicalCommand(command: RuntimeCommand, op: string, args: JsonValue | undefined, id: string): Command {
  if (command.params === undefined) return CommandDomain.parse({ id, op })
  const input = args ?? {}
  const missing = command.params.missing?.(input)
  if (missing !== undefined && missing.length > 0) {
    raiseFailure("usage", "missing-arguments", `yrd: command '${op}' requires ${missing.join(", ")}`)
  }
  try {
    return CommandDomain.parse({ id, op, args: parseParams(command.params, input) })
  } catch (error) {
    throw asFailure(error, { kind: "usage", code: "invalid-arguments" })
  }
}

function parseParams(schema: ParamSchema<unknown>, value: unknown): unknown {
  if ("parse" in schema) return schema.parse(value)
  const result = schema["~standard"].validate(value)
  if ("issues" in result) {
    throw new Error(result.issues.map((issue) => issue.message ?? "invalid value").join(", "))
  }
  return result.value
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function"
}

function serialize<Args extends JsonValue | undefined, State extends object>(
  registry: SerializableCommandRegistry<AnyCommand>,
  selected: CommandHandler<Args, State> | AnyCommand,
  args: Args,
): CommandInput<Args> {
  const path = registry.pathOf(selected as unknown as AnyCommand)
  if (path === undefined) {
    raiseFailure("configuration", "command-not-installed", "yrd: command is not installed")
  }
  const op = path.join(".")
  return (args === undefined ? { op } : { op, args }) as CommandInput<Args>
}

function commandResult(frame: JournalFrame): CommandResult {
  return freeze({
    command: frame.command,
    events: frame.events,
    ...(frame.value === undefined ? {} : { value: frame.value }),
  }) as CommandResult
}
