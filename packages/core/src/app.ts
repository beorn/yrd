import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import {
  command as defineCommand,
  createCommandRegistry as buildCommandRegistry,
  isCommand,
  type Command as SerializableCommand,
  type CommandRegistry as SerializableCommandRegistry,
  type CommandTree as SerializableCommandTree,
} from "@silvery/command"

const COMMAND_RUNTIME = Symbol("yrd.command.runtime")
const EFFECT_REF = Symbol("yrd.effect")

export type ArgsParser<Args> = {
  parse(input: unknown): Args
}

export type OperationHandler<State extends object, Args> = (
  state: DeepReadonly<State>,
  args: Args,
  context: { cause: YrdCause; operation: SerializedOperation<Args> },
) => ApplyResult

type CommandRuntime<State extends object, Args> = Readonly<{
  fn: OperationHandler<State, Args>
  args?: ArgsParser<Args>
}>

export type Command<Args = undefined, State extends object = object> = Readonly<
  Omit<SerializableCommand<any>, "metadata"> & {
    metadata: Readonly<{ visibility: "public" | "internal" }>
    [COMMAND_RUNTIME]: CommandRuntime<State, Args>
  }
>

export type AnyCommand = Command<any, any>
export type CommandTree = Record<string, unknown>

export type EffectFunction<Input, Output> = (
  input: Input,
  context: { id: string; attempt: number; executor: string },
) => Output | Promise<Output>

export type Fx<Input = unknown, Output = unknown> = Readonly<{
  [EFFECT_REF]: true
  fn: EffectFunction<Input, Output>
  title?: string
  description?: string
}>

export type AnyFx = Fx<any, any>

export type EventDraft<Name extends string = string, Data = unknown> = {
  name: Name
  data: Data
}

export type YrdCause = {
  commandId: string
  op: string
  traceId?: string
  spanId?: string
}

export type YrdEvent<Name extends string = string, Data = unknown> = EventDraft<Name, Data> & {
  id: string
  ts: string
  cause: YrdCause
}

export type EffectRequest<Input = unknown, Output = unknown> = {
  effect: Fx<Input, Output>
  input: Input
  idempotencyKey?: string
}

export type ApplyResult = {
  events: EventDraft[]
  effects: EffectRequest<any, any>[]
}

export type SerializedOperation<Args = unknown> = Readonly<{
  op: string
  args?: Args
}>

export type CommandInvocation<Args = unknown, State extends object = object> = {
  operation: SerializedOperation<Args>
  command: Command<Args, State>
  args: Args
  cause: YrdCause
}

export type DeepReadonly<T> = T extends (...args: any[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

export type YrdEventStore = {
  replay(): AsyncIterable<YrdEvent>
  append(events: readonly YrdEvent[]): Promise<void>
  read<Result>(run: () => Promise<Result>): Promise<Result>
  withWriter<Result>(run: () => Promise<Result>): Promise<Result>
  close(): Promise<void>
}

type RegistryKind = "effect"
type RegistryEntry<Kind extends RegistryKind, Value> = { path: readonly string[] } & {
  [Key in Kind]: Value
}
type Registry<Kind extends RegistryKind, Value extends object> = {
  register(path: readonly string[], value: Value): void
  pathOf(value: Value): readonly string[] | undefined
  entries(): readonly RegistryEntry<Kind, Value>[]
} & {
  [Key in `${Kind}At`]: (path: string | readonly string[]) => Value | undefined
}

export type CommandRegistry = SerializableCommandRegistry<AnyCommand>
export type EffectRegistry = Registry<"effect", AnyFx>

export type CommandRun = {
  events: YrdEvent[]
  effects: EffectRequest<any, any>[]
  effectIds: string[]
}

export type YrdApp<State extends object = {}, Commands extends CommandTree = {}> = {
  initialState: State
  commands: Commands
  commandRegistry: CommandRegistry
  effectRegistry: EffectRegistry
  apply(state: DeepReadonly<State>, invocation: CommandInvocation): ApplyResult
  project(state: State, event: YrdEvent): State
  state(): Promise<State>
  operation<Args>(command: Command<Args, any>, args: Args): SerializedOperation<Args>
  command<Args>(
    command: Command<Args, any>,
    args: Args,
    options?: { traceId?: string; spanId?: string },
  ): Promise<CommandRun>
  invoke(operation: SerializedOperation, options?: { traceId?: string; spanId?: string }): Promise<CommandRun>
  events(): AsyncIterable<YrdEvent>
  close(): Promise<void>
}

export type AnyYrdApp = YrdApp<any, any>
export type StateOf<App extends AnyYrdApp> = App extends YrdApp<infer State, any> ? State : never
export type CommandsOf<App extends AnyYrdApp> = App extends YrdApp<any, infer Commands> ? Commands : never

/** The runtime object is mutated in place; this type only replaces the core
 * facets with their accumulated intersection so inference follows pipe order. */
export type ExtendYrdApp<App extends AnyYrdApp, State extends object, Commands extends CommandTree> = Omit<
  App,
  keyof YrdApp<any, any>
> &
  YrdApp<StateOf<App> & State, CommandsOf<App> & Commands>

export function event<Name extends string, Data>(name: Name, data: Data): EventDraft<Name, Data> {
  return { name, data }
}

export function op<State extends object, Args>(
  fn: OperationHandler<State, Args>,
  definition: {
    title?: string
    description?: string
    visibility?: "public" | "internal"
    args?: ArgsParser<Args>
  } = {},
): Command<Args, State> {
  const declared = defineCommand({
    title: definition.title ?? (fn.name || "Internal command"),
    ...(definition.description === undefined ? {} : { description: definition.description }),
    metadata: { visibility: definition.visibility ?? "internal" },
  })
  return Object.freeze(
    Object.defineProperty({ ...declared }, COMMAND_RUNTIME, {
      value: Object.freeze({ fn, ...(definition.args === undefined ? {} : { args: definition.args }) }),
      enumerable: false,
    }),
  ) as Command<Args, State>
}

export function fx<Input, Output>(
  fn: EffectFunction<Input, Output>,
  definition: { title?: string; description?: string } = {},
): Fx<Input, Output> {
  return Object.freeze({ ...definition, fn, [EFFECT_REF]: true as const })
}

export function effect<Input, Output>(
  ref: Fx<Input, Output>,
  input: Input,
  idempotencyKey?: string,
): EffectRequest<Input, Output> {
  return { effect: ref, input, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }
}

const COMMAND_SEGMENT = /^[a-z][a-z0-9_-]*$/i

function validCommandSegment(part: string): boolean {
  return COMMAND_SEGMENT.test(part) && part !== "__proto__" && part !== "prototype" && part !== "constructor"
}

function normalizePath(path: string | readonly string[]): string[] {
  const parts = typeof path === "string" ? path.split(".") : [...path]
  if (parts.length === 0 || parts.some((part) => !validCommandSegment(part))) {
    throw new Error(`yrd: invalid command path '${typeof path === "string" ? path : path.join(".")}'`)
  }
  return parts
}

function createRegistry<Kind extends RegistryKind, Value extends object>(kind: Kind): Registry<Kind, Value> {
  const byPath = new Map<string, RegistryEntry<Kind, Value>>()
  const byValue = new WeakMap<Value, readonly string[]>()
  const at = `${kind}At` as `${Kind}At`

  return {
    register(pathInput: readonly string[], value: Value) {
      const path = normalizePath(pathInput)
      const key = path.join(".")
      if (byPath.has(key)) throw new Error(`yrd: ${kind} '${key}' is already registered`)
      const previous = byValue.get(value)
      if (previous !== undefined) {
        throw new Error(`yrd: ${kind} '${previous.join(".")}' cannot also register as '${key}'`)
      }
      const frozenPath = Object.freeze(path)
      byPath.set(key, { path: frozenPath, [kind]: value } as RegistryEntry<Kind, Value>)
      byValue.set(value, frozenPath)
    },
    [at](pathInput: string | readonly string[]) {
      return byPath.get(normalizePath(pathInput).join("."))?.[kind]
    },
    pathOf(value: Value) {
      return byValue.get(value)
    },
    entries() {
      return [...byPath.values()]
    },
  } as unknown as Registry<Kind, Value>
}

export function createEffectRegistry(): EffectRegistry {
  return createRegistry<"effect", AnyFx>("effect")
}

function isYrdCommand(value: unknown): value is AnyCommand {
  return isCommand(value) && COMMAND_RUNTIME in value
}

function runtimeOf<Args, State extends object>(command: Command<Args, State>): CommandRuntime<State, Args> {
  return command[COMMAND_RUNTIME]
}

function isNamespace(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function createCommandNamespace(path: readonly string[] = []): CommandTree {
  const target: CommandTree = Object.create(null) as CommandTree
  return new Proxy(target, {
    set(namespace, key, value) {
      if (typeof key !== "string" || !validCommandSegment(key)) {
        throw new Error(`yrd: invalid command segment '${String(key)}'`)
      }
      const commandPath = [...path, key]
      if (Object.hasOwn(namespace, key)) {
        const kind = isYrdCommand(namespace[key]) ? "command" : "command namespace"
        throw new Error(`yrd: ${kind} '${commandPath.join(".")}' is already registered`)
      }
      if (!isYrdCommand(value) && !isNamespace(value)) {
        throw new Error(`yrd: command '${commandPath.join(".")}' must be created with op() or contain commands`)
      }
      if (!isYrdCommand(value)) {
        const child = createCommandNamespace(commandPath)
        Object.assign(child, value)
        value = child
      }
      namespace[key] = value
      return true
    },
    deleteProperty(_namespace, key) {
      throw new Error(`yrd: command '${[...path, String(key)].join(".")}' cannot be removed after composition`)
    },
    defineProperty() {
      throw new Error("yrd: command definitions must use property assignment")
    },
  })
}

function cloneJson<Value>(value: Value, path = "$", seen = new Set<object>()): Value {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`yrd: operation value '${path}' must be a finite number`)
    return value
  }
  if (typeof value !== "object") {
    throw new Error(`yrd: operation value '${path}' is not JSON data`)
  }
  if (seen.has(value)) throw new Error(`yrd: operation value '${path}' is cyclic`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (item, index) => cloneJson(item, `${path}[${index}]`, seen)) as Value
    }
    if (!isNamespace(value)) throw new Error(`yrd: operation value '${path}' must be a plain object`)
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJson(child, `${path}.${key}`, seen)]),
    ) as Value
  } finally {
    seen.delete(value)
  }
}

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value as DeepReadonly<Value>
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value) as DeepReadonly<Value>
}

export function createMemoryEventStore(initial: readonly YrdEvent[] = []): YrdEventStore {
  const events = [...structuredClone(initial)]
  let writer = Promise.resolve()
  const writerScope = new AsyncLocalStorage<boolean>()
  return {
    async *replay() {
      for (const applied of events) yield structuredClone(applied)
    },
    async append(next) {
      if (writerScope.getStore() !== true) throw new Error("yrd: append requires an active writer lease")
      events.push(...structuredClone(next))
    },
    async read(run) {
      if (writerScope.getStore() === true) return run()
      await writer
      return run()
    },
    withWriter(run) {
      if (writerScope.getStore() === true) return Promise.reject(new Error("yrd: nested writer lease is not allowed"))
      const result = writer.then(() => writerScope.run(true, run))
      writer = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    async close() {},
  }
}

export function createYrd(options: {
  store: YrdEventStore
  clock?: () => string
  idGen?: () => string
}): YrdApp<{}, {}> {
  const clock = options.clock ?? (() => new Date().toISOString())
  const idGen = options.idGen ?? randomUUID
  const commands = createCommandNamespace()
  const commandRegistry = () => buildCommandRegistry(commands as SerializableCommandTree) as CommandRegistry
  const effectRegistry = createEffectRegistry()

  const app: YrdApp<Record<string, unknown>, CommandTree> = {
    initialState: {},
    commands,
    get commandRegistry() {
      return commandRegistry()
    },
    effectRegistry,
    apply(state, invocation) {
      return runtimeOf(invocation.command).fn(state, invocation.args, {
        cause: invocation.cause,
        operation: invocation.operation,
      })
    },
    project(state) {
      return state
    },
    state() {
      return options.store.read(async () => {
        let state = structuredClone(app.initialState)
        for await (const applied of options.store.replay()) state = app.project(state, applied)
        return state
      })
    },
    operation(command, args) {
      const path = commandRegistry().pathOf(command)
      if (path === undefined) {
        throw new Error(`yrd: command '${command.title}' is not installed`)
      }
      return Object.freeze(args === undefined ? { op: path.join(".") } : { op: path.join("."), args: cloneJson(args) })
    },
    command(command, args, traceOptions) {
      return app.invoke(app.operation(command, args), traceOptions)
    },
    async invoke(serialized, traceOptions) {
      if (!isNamespace(serialized) || typeof serialized.op !== "string") {
        throw new Error("yrd: operation must be a JSON object with an 'op'")
      }
      const path = normalizePath(serialized.op)
      const operationPath = path.join(".")
      const command = commandRegistry().commandAt(path)
      if (command === undefined) throw new Error(`yrd: unknown command '${operationPath}'`)
      const runtime = runtimeOf(command)
      const rawArgs = serialized.args === undefined ? undefined : cloneJson(serialized.args)
      let args = rawArgs
      if (runtime.args !== undefined) {
        args = runtime.args.parse(rawArgs)
        if (args !== undefined) args = cloneJson(args)
      }
      const operation = Object.freeze(args === undefined ? { op: operationPath } : { op: operationPath, args })
      const cause: YrdCause = {
        commandId: idGen(),
        op: operationPath,
        ...(traceOptions?.traceId === undefined ? {} : { traceId: traceOptions.traceId }),
        ...(traceOptions?.spanId === undefined ? {} : { spanId: traceOptions.spanId }),
      }
      return options.store.withWriter(async () => {
        const state = deepFreeze(structuredClone(await app.state()))
        const result = app.apply(state, { operation, command, args, cause })
        const effectIds: string[] = []
        const effectEvents = result.effects.map((request) => {
          const path = effectRegistry.pathOf(request.effect)
          if (path === undefined) {
            throw new Error(
              `yrd: effect '${request.effect.title ?? request.effect.fn.name ?? "unnamed"}' is not registered`,
            )
          }
          const id = idGen()
          effectIds.push(id)
          return event("effect/requested", {
            id,
            effect: path.join("."),
            input: cloneJson(request.input),
            ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
          })
        })
        const applied = [...result.events, ...effectEvents].map((draft) => {
          if (typeof draft.name !== "string" || draft.name === "") throw new Error("yrd: event name must not be empty")
          return {
            name: draft.name,
            data: cloneJson(draft.data),
            id: idGen(),
            ts: clock(),
            cause,
          }
        })
        if (applied.length > 0) await options.store.append(applied)
        return { events: applied, effects: [...result.effects], effectIds }
      })
    },
    events() {
      return options.store.replay()
    },
    close() {
      return options.store.close()
    },
  }

  return app as YrdApp<{}, {}>
}
