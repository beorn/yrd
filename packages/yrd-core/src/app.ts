import { randomUUID } from "node:crypto"
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
import * as z from "zod"
import {
  CauseSchema,
  EventSchema,
  Frame as FrameDomain,
  Operation as OperationDomain,
  type Cause,
  type Event,
  type EventDraft,
  type Frame,
  type JsonValue,
  type Operation,
} from "./domain.ts"
import { cloneFrozen, freeze, type DeepReadonly } from "./immutable.ts"
import type { Cursor, Journal } from "./journal.ts"

export type { DeepReadonly } from "./immutable.ts"

export type ApplyResult = Readonly<{ events: readonly EventDraft[] }>

export type CommandContext<State extends object> = Readonly<{
  state: DeepReadonly<State>
  cause: Cause
  operation: Operation
}>

export type Command<Args extends JsonValue | undefined = undefined, State extends object = object> = CommandNode<
  CommandContext<State>,
  Args,
  ApplyResult
>

export type AnyCommand = Omit<CommandNode<never, never, ApplyResult>, "params"> &
  Readonly<{ params?: ParamSchema<unknown> }>
export type CommandTree = {
  readonly [segment: string]: AnyCommand | CommandTree
}

export type CommandOptions = Readonly<{
  commandId?: string
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

export type Yrd<State extends object, Commands extends CommandTree> = Readonly<{
  commands: Commands
  state: ReadSignal<DeepReadonly<State>>
  scope: Scope
  log: ConditionalLogger
  refresh(): Promise<DeepReadonly<State>>
  operation<Args extends JsonValue | undefined, CommandState extends object>(
    command: Command<Args, CommandState>,
    args: Args,
  ): Operation<Args>
  command<Args extends JsonValue | undefined, CommandState extends object>(
    command: Command<Args, CommandState>,
    args: Args,
    options?: CommandOptions,
  ): Promise<Frame>
  invoke(operation: Operation, options?: CommandOptions): Promise<Frame>
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
): Command<undefined, State>
export function command<State extends object, Args extends JsonValue>(
  definition: CommandDef<State, Args> & Readonly<{ params: ParamSchema<Args> }>,
): Command<Args, State>
export function command<State extends object, Args extends JsonValue | undefined>(
  definition: CommandDef<State, Args>,
): Command<Args, State> {
  const node = createCommandNode({
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(definition.params === undefined ? {} : { params: definition.params }),
    ...(definition.isAvailable === undefined ? {} : { isAvailable: definition.isAvailable }),
    metadata: Object.freeze({ visibility: definition.visibility ?? "internal" }),
    run(context, args) {
      return definition.apply(context.state, args, {
        cause: context.cause,
        operation: context.operation,
      })
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
  const id = options.inject.id ?? randomUUID
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
    receipts: ReadonlyMap<string, Frame>
    eventIds: ReadonlySet<string>
  }>

  let projection: Projection = {
    cursor: 0,
    state: state(),
    receipts: new Map(),
    eventIds: new Set(),
  }
  let closing = false
  let closePromise: Promise<void> | undefined
  const active = new Set<Promise<unknown>>()

  const fold = async (base: Projection): Promise<Projection> => {
    using _span = coreLog.span?.("replay", { after: base.cursor })
    let next = base
    for await (const batch of journal.read(base.cursor)) {
      if (batch.cursor <= next.cursor) throw new Error("yrd: journal cursor did not advance")
      for (const value of batch.values) next = projectFrame(next, FrameDomain.parse(value))
      next = { ...next, cursor: batch.cursor }
    }
    return next
  }

  const projectFrame = (base: Projection, frame: Frame): Projection => {
    if (base.receipts.has(frame.cause.commandId)) {
      throw new Error(`yrd: journal contains duplicate command id '${frame.cause.commandId}'`)
    }
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
    const receipts = new Map(base.receipts)
    receipts.set(frame.cause.commandId, frame)
    return { ...base, state: nextState, receipts, eventIds }
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

  const dispatch = async (
    input: Operation,
    trace: CommandOptions | undefined,
    visibility: "public" | "trusted",
  ): Promise<Frame> => {
    assertOpen()
    const parsed = OperationDomain.parse(input)
    const registered = registry.commandAt(parsed.op)
    if (registered === undefined) throw new Error(`yrd: unknown command '${parsed.op}'`)
    const selected = registered as unknown as RuntimeCommand
    if (visibility === "public" && selected.metadata?.visibility !== "public") {
      throw new Error(`yrd: internal command '${parsed.op}' is not publicly available`)
    }

    const canonical = canonicalOperation(selected, parsed.op, parsed.args)
    const commandId = trace?.commandId ?? id()
    if (commandId.length === 0) throw new Error("yrd: command id must not be empty")
    const cause = CauseSchema.parse({
      commandId,
      op: canonical.op,
      operationHash: OperationDomain.hash(canonical),
      ...(trace?.traceId === undefined ? {} : { traceId: trace.traceId }),
      ...(trace?.spanId === undefined ? {} : { spanId: trace.spanId }),
    })

    while (!closing && !scope.signal.aborted) {
      const current = await fold(projection)
      const receipt = current.receipts.get(commandId)
      if (receipt !== undefined) {
        if (receipt.cause.operationHash !== cause.operationHash) {
          throw new Error(`yrd: command id '${commandId}' was already used for a different operation`)
        }
        publish(current)
        return receipt
      }

      const context = { state: current.state, cause, operation: canonical }
      const unavailable = unavailableReason(selected.isAvailable?.(context))
      if (unavailable !== null) {
        throw new Error(`yrd: command '${parsed.op}' is unavailable${unavailable ? `: ${unavailable}` : ""}`)
      }
      const result = selected.run(context, canonical.args)
      if (isThenable(result)) throw new TypeError(`yrd: command '${parsed.op}' must be synchronous`)
      const events = result.events.map((draft) => {
        const schema = definition.events[draft.name]
        if (schema === undefined) throw new Error(`yrd: no event definition for '${draft.name}'`)
        return EventSchema.parse({ id: id(), name: draft.name, ts: clock(), data: schema.parse(draft.data) })
      })
      const frame = FrameDomain.parse({ cause, events })
      const candidate = projectFrame(current, frame)
      const appended = await journal.append(frame, current.cursor)
      if (!appended.appended) continue
      publish({ ...candidate, cursor: appended.cursor })
      return frame
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

  const core: Yrd<State, Commands> = Object.freeze({
    commands,
    state,
    scope,
    log,
    refresh: () => track(refresh),
    operation(selected, args) {
      return serialize(registry, selected, args)
    },
    command(selected, args, commandOptions) {
      return track(() => dispatch(serialize(registry, selected, args), commandOptions, "trusted"))
    },
    invoke(operation, commandOptions) {
      return track(() => dispatch(operation, commandOptions, "public"))
    },
    async *events() {
      await refresh()
      const before = projection.cursor
      for await (const batch of journal.read(0, before)) {
        for (const value of batch.values) yield* FrameDomain.parse(value).events
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

function canonicalOperation(command: RuntimeCommand, op: string, args: JsonValue | undefined): Operation {
  if (command.params === undefined) return OperationDomain.parse({ op })
  const input = args ?? {}
  const missing = command.params.missing?.(input)
  if (missing !== undefined && missing.length > 0) {
    throw new Error(`yrd: command '${op}' requires ${missing.join(", ")}`)
  }
  return OperationDomain.parse({ op, args: parseParams(command.params, input) })
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
  selected: Command<Args, State>,
  args: Args,
): Operation<Args> {
  const path = registry.pathOf(selected as unknown as AnyCommand)
  if (path === undefined) throw new Error("yrd: command is not installed")
  return canonicalOperation(selected as unknown as RuntimeCommand, path.join("."), args) as Operation<Args>
}
