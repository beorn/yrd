import { randomUUID } from "node:crypto"

const OP_REF = Symbol("yrd.op")
const EFFECT_REF = Symbol("yrd.effect")

export type ArgsParser<Args> = {
  parse(input: unknown): Args
}

export type OperationHandler<State extends object, Args> = (
  state: DeepReadonly<State>,
  args: Args,
  context: { cause: YrdCause; operation: SerializedOperation<Args> },
) => ApplyResult

export type Command<Args = undefined, State extends object = object> = Readonly<{
  [OP_REF]: true
  fn: OperationHandler<State, Args>
  title?: string
  description?: string
  args?: ArgsParser<Args>
}>

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

export type CommandRegistryEntry = {
  path: readonly string[]
  command: AnyCommand
}

export type CommandRegistry = {
  commandAt(path: string | readonly string[]): AnyCommand | undefined
  pathOf(command: AnyCommand): readonly string[] | undefined
  entries(): readonly CommandRegistryEntry[]
}

export type EffectRegistry = {
  register(path: readonly string[], effect: AnyFx): void
  effectAt(path: string | readonly string[]): AnyFx | undefined
  pathOf(effect: AnyFx): readonly string[] | undefined
  entries(): readonly { path: readonly string[]; effect: AnyFx }[]
}

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
    args?: ArgsParser<Args>
  } = {},
): Command<Args, State> {
  return Object.freeze({ ...definition, fn, [OP_REF]: true as const })
}

export function fx<Input, Output>(
  fn: EffectFunction<Input, Output>,
  definition: {
    title?: string
    description?: string
  } = {},
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

type MutableCommandRegistry = CommandRegistry & {
  register(path: readonly string[], command: AnyCommand): void
}

function createCommandRegistry(): MutableCommandRegistry {
  const byPath = new Map<string, CommandRegistryEntry>()
  const byCommand = new WeakMap<object, readonly string[]>()

  return {
    register(pathInput, command) {
      const path = normalizePath(pathInput)
      const key = path.join(".")
      if (byPath.has(key)) throw new Error(`yrd: command '${key}' is already registered`)
      if (byCommand.has(command)) {
        throw new Error(`yrd: command '${byCommand.get(command)!.join(".")}' cannot also register as '${key}'`)
      }
      const frozenPath = Object.freeze(path)
      byPath.set(key, { path: frozenPath, command })
      byCommand.set(command, frozenPath)
    },
    commandAt(path) {
      return byPath.get(normalizePath(path).join("."))?.command
    },
    pathOf(command) {
      return byCommand.get(command)
    },
    entries() {
      return [...byPath.values()]
    },
  }
}

export function createEffectRegistry(): EffectRegistry {
  const byPath = new Map<string, { path: readonly string[]; effect: AnyFx }>()
  const byEffect = new WeakMap<object, readonly string[]>()
  return {
    register(pathInput, ref) {
      const path = normalizePath(pathInput)
      const key = path.join(".")
      if (byPath.has(key)) throw new Error(`yrd: effect '${key}' is already registered`)
      if (byEffect.has(ref)) {
        throw new Error(`yrd: effect '${byEffect.get(ref)!.join(".")}' cannot also register as '${key}'`)
      }
      const frozenPath = Object.freeze(path)
      byPath.set(key, { path: frozenPath, effect: ref })
      byEffect.set(ref, frozenPath)
    },
    effectAt(path) {
      return byPath.get(normalizePath(path).join("."))?.effect
    },
    pathOf(ref) {
      return byEffect.get(ref)
    },
    entries() {
      return [...byPath.values()]
    },
  }
}

function isCommand(value: unknown): value is AnyCommand {
  return typeof value === "object" && value !== null && OP_REF in value
}

function isNamespace(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function createCommandNamespace(registry: MutableCommandRegistry, path: readonly string[] = []): CommandTree {
  const target: CommandTree = Object.create(null) as CommandTree
  return new Proxy(target, {
    set(namespace, key, value) {
      if (typeof key !== "string" || !validCommandSegment(key)) {
        throw new Error(`yrd: invalid command segment '${String(key)}'`)
      }
      const commandPath = [...path, key]
      if (Object.hasOwn(namespace, key)) {
        const kind = isCommand(namespace[key]) ? "command" : "command namespace"
        throw new Error(`yrd: ${kind} '${commandPath.join(".")}' is already registered`)
      }
      if (isCommand(value)) {
        registry.register(commandPath, value)
        namespace[key] = value
        return true
      }
      if (!isNamespace(value)) {
        throw new Error(`yrd: command '${commandPath.join(".")}' must be created with op() or contain commands`)
      }
      const child = createCommandNamespace(registry, commandPath)
      for (const [childKey, childValue] of Object.entries(value)) {
        Reflect.set(child, childKey, childValue)
      }
      namespace[key] = child
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
      return value.map((item, index) => cloneJson(item, `${path}[${index}]`, seen)) as Value
    }
    if (!isNamespace(value)) throw new Error(`yrd: operation value '${path}' must be a plain object`)
    const copy: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) copy[key] = cloneJson(child, `${path}.${key}`, seen)
    return copy as Value
  } finally {
    seen.delete(value)
  }
}

function clone<State>(value: State): State {
  return structuredClone(value)
}

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value as DeepReadonly<Value>
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value) as DeepReadonly<Value>
}

function parseArgs<Args>(command: Command<Args, any>, input: unknown): Args {
  const parsed = command.args === undefined ? (input as Args) : command.args.parse(input)
  return parsed === undefined ? parsed : cloneJson(parsed)
}

export function createMemoryEventStore(initial: readonly YrdEvent[] = []): YrdEventStore {
  const events = initial.map(clone)
  let writer = Promise.resolve()
  let activeWriter = false
  return {
    async *replay() {
      for (const applied of events) yield clone(applied)
    },
    async append(next) {
      if (!activeWriter) throw new Error("yrd: append requires an active writer lease")
      events.push(...next.map(clone))
    },
    async read(run) {
      if (activeWriter) return await run()
      await writer
      return await run()
    },
    withWriter(run) {
      const execute = async () => {
        activeWriter = true
        try {
          return await run()
        } finally {
          activeWriter = false
        }
      }
      const result = writer.then(execute, execute)
      writer = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    close() {
      return Promise.resolve()
    },
  }
}

export function createYrd(options: {
  store: YrdEventStore
  clock?: () => string
  idGen?: () => string
}): YrdApp<{}, {}> {
  const clock = options.clock ?? (() => new Date().toISOString())
  const idGen = options.idGen ?? randomUUID
  const commandRegistry = createCommandRegistry()
  const effectRegistry = createEffectRegistry()
  const commands = createCommandNamespace(commandRegistry)

  const app: YrdApp<Record<string, unknown>, CommandTree> = {
    initialState: {},
    commands,
    commandRegistry,
    effectRegistry,
    apply(state, invocation) {
      return invocation.command.fn(state, invocation.args, {
        cause: invocation.cause,
        operation: invocation.operation,
      })
    },
    project(state) {
      return state
    },
    async state() {
      return await options.store.read(async () => {
        let state = clone(app.initialState)
        for await (const applied of options.store.replay()) state = app.project(state, applied)
        return state
      })
    },
    operation(command, args) {
      const path = commandRegistry.pathOf(command)
      if (path === undefined) {
        throw new Error(`yrd: command '${command.title ?? command.fn.name ?? "unnamed"}' is not installed`)
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
      const command = commandRegistry.commandAt(path)
      if (command === undefined) throw new Error(`yrd: unknown command '${operationPath}'`)
      const rawArgs = serialized.args === undefined ? undefined : cloneJson(serialized.args)
      const args = parseArgs(command, rawArgs)
      const operation = Object.freeze(args === undefined ? { op: operationPath } : { op: operationPath, args })
      const cause: YrdCause = {
        commandId: idGen(),
        op: operationPath,
        ...(traceOptions?.traceId === undefined ? {} : { traceId: traceOptions.traceId }),
        ...(traceOptions?.spanId === undefined ? {} : { spanId: traceOptions.spanId }),
      }
      return await options.store.withWriter(async () => {
        const state = deepFreeze(clone(await app.state()))
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
