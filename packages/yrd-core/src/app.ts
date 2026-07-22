import { createHash } from "node:crypto"
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
import canonicalize from "canonicalize"
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
import type { Cursor, Journal, JournalCheckpoint, JournalHistory, JournalHistoryDiagnostics } from "./journal.ts"

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
const projectionVersions = Symbol("yrd.projectionVersions")
const PROJECTION_CHECKPOINT_VERSION = 1
const PROJECTION_CHECKPOINT_REFRESH_FRAMES = 256
const PROJECTION_CHECKPOINT_HIGH_WATER_FRAMES = 512
const RECEIPT_CACHE_FRAMES = 4_096
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const ProjectionCheckpointSchema = z
  .object({
    v: z.literal(PROJECTION_CHECKPOINT_VERSION),
    state: z.unknown(),
    at: z.string().optional(),
    receipts: z.array(z.unknown()),
    causeIds: z.array(z.string()),
    eventIds: z.array(z.string()),
  })
  .strict()

export type JournalAsOf = Readonly<{ cursor: Cursor; at?: string }>
export type JournalSnapshot<State extends object> = Readonly<{
  state: DeepReadonly<State>
  asOf: JournalAsOf
}>

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
  journalSnapshot(): Promise<JournalSnapshot<State>>
  historySnapshot(): Promise<JournalSnapshot<State>>
  history?: JournalHistory<unknown>
  retentionDiagnostics(): Readonly<{
    receiptFrames: number
    causeIds: number
    eventIds: number
    journal?: JournalHistoryDiagnostics
  }>
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
  replayEvents?: EventSchemas
  projectionVersion?: string
  project?(state: DeepReadonly<AddedState>, event: Event, cause: Cause): AddedState
  validate?(state: DeepReadonly<State & AddedState>): void
  compact?(state: DeepReadonly<AddedState>, complete: DeepReadonly<State & AddedState>): AddedState
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
  replayEvents: EventSchemas
  project: Project<State>
  validate(state: DeepReadonly<State>): void
  compact(state: DeepReadonly<State>): State
  readonly [projectionVersions]: readonly (string | undefined)[]
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
    replayEvents: {},
    project: (state) => state,
    validate: () => {},
    compact: (state) => state,
    [projectionVersions]: [],
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
  const history = journal.history
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
    revision: number
    at?: string
    state: DeepReadonly<State>
    receiptsById: ReadonlyMap<string, JournalFrame>
    receiptsByKey: ReadonlyMap<string, JournalFrame>
    causeIds: ReadonlySet<string>
    eventIds: ReadonlySet<string>
  }>

  const emptyProjection = (): Projection => ({
    cursor: 0,
    revision: 0,
    state: state(),
    receiptsById: new Map(),
    receiptsByKey: new Map(),
    causeIds: new Set(),
    eventIds: new Set(),
  })
  let projection = emptyProjection()
  let closing = false
  let closePromise: Promise<void> | undefined
  const active = new Set<Promise<unknown>>()
  const checkpointStore = journal.checkpoint
  let checkpointIdentity: string | undefined
  let checkpointCursor: Cursor | undefined
  let checkpointRevision = 0
  let checkpointWork: Promise<void> | undefined
  let checkpointWarning = false

  const warnCheckpoint = (message: string, error: unknown): void => {
    if (checkpointWarning) return
    checkpointWarning = true
    coreLog.warn?.(message, {
      action: "full-replay",
      reason: "projection-checkpoint-invalid",
      error: error instanceof Error ? error.message : String(error),
    })
  }

  if (checkpointStore !== undefined) {
    try {
      checkpointIdentity = projectionCheckpointIdentity(definition)
    } catch (error) {
      warnCheckpoint("projection checkpoint identity could not be derived; replaying journal authority", error)
    }
  }

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
        next = projectFrame(next, frame, "replay")
      }
      next = { ...next, cursor: batch.cursor }
    }
    definition.validate(next.state)
    if (history !== undefined && frames > 0) {
      next = { ...next, state: freeze(definition.compact(next.state)) as DeepReadonly<State> }
    }
    if (span) Object.assign(span.spanData, { frames, events, fromCursor: base.cursor, toCursor: next.cursor })
    return next
  }

  const projectFrame = (base: Projection, frame: JournalFrame, source: "append" | "replay"): Projection => {
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
      const currentSchema = definition.events[applied.name]
      if (currentSchema === undefined) throw new Error(`yrd: no event definition for '${applied.name}'`)
      const current = currentSchema.safeParse(applied.data)
      const data = current.success
        ? current.data
        : source === "append"
          ? currentSchema.parse(applied.data)
          : (definition.replayEvents[applied.name] ?? currentSchema).parse(applied.data)
      const validated = freeze(EventSchema.parse({ ...applied, data })) as Event
      const projected = definition.project(nextState, validated, frame.cause)
      nextState = freeze(projected) as DeepReadonly<State>
    }
    if (source === "append") definition.validate(nextState)
    if (history !== undefined && source === "append" && frame.events.length > 0) {
      nextState = freeze(definition.compact(nextState)) as DeepReadonly<State>
    }
    const receiptsById = new Map(base.receiptsById)
    receiptsById.set(frame.command.id, frame)
    const receiptsByKey = new Map(base.receiptsByKey)
    if (frame.cause.key !== undefined) receiptsByKey.set(frame.cause.key, frame)
    if (history !== undefined) trimReceiptCache(receiptsById, receiptsByKey, causeIds, eventIds)
    const at = frame.events.at(-1)?.ts ?? base.at
    return {
      ...base,
      revision: base.revision + 1,
      state: nextState,
      receiptsById,
      receiptsByKey,
      causeIds,
      eventIds,
      ...(at === undefined ? {} : { at }),
    }
  }

  const trimReceiptCache = (
    receiptsById: Map<string, JournalFrame>,
    receiptsByKey: Map<string, JournalFrame>,
    causeIds: Set<string>,
    eventIds: Set<string>,
  ): void => {
    while (receiptsById.size > RECEIPT_CACHE_FRAMES) {
      const oldest = receiptsById.entries().next().value as readonly [string, JournalFrame] | undefined
      if (oldest === undefined) break
      const [commandId, frame] = oldest
      receiptsById.delete(commandId)
      if (frame.cause.key !== undefined && receiptsByKey.get(frame.cause.key)?.command.id === commandId) {
        receiptsByKey.delete(frame.cause.key)
      }
      causeIds.delete(frame.cause.id)
      for (const applied of frame.events) eventIds.delete(applied.id)
    }
  }

  const restoreProjection = (checkpoint: JournalCheckpoint): Projection => {
    const restoreStarted = performance.now()
    if (checkpoint.identity !== checkpointIdentity) {
      throw new Error("checkpoint identity does not match this projection")
    }
    if (!Number.isSafeInteger(checkpoint.cursor) || checkpoint.cursor < 0) {
      throw new Error("checkpoint cursor must be a non-negative safe integer")
    }
    const parsed = ProjectionCheckpointSchema.parse(checkpoint.value)
    const envelopeParsedAt = performance.now()
    const state = projectionCheckpointState(parsed.state)
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new Error("checkpoint state must be a JSON object")
    }
    const stateValidatedAt = performance.now()

    const receiptsById = new Map<string, JournalFrame>()
    const receiptsByKey = new Map<string, JournalFrame>()
    const expectedCauseIds = new Set<string>()
    const expectedEventIds = new Set<string>()
    const commandHashes = new Map<string, string>()
    let expectedAt: string | undefined
    for (const value of parsed.receipts) {
      const frame = parseCheckpointFrame(value, commandHashes)
      if (receiptsById.has(frame.command.id)) throw new Error(`checkpoint repeats command id '${frame.command.id}'`)
      receiptsById.set(frame.command.id, frame)
      if (frame.cause.key !== undefined) {
        if (receiptsByKey.has(frame.cause.key)) throw new Error(`checkpoint repeats command key '${frame.cause.key}'`)
        receiptsByKey.set(frame.cause.key, frame)
      }
      if (expectedCauseIds.has(frame.cause.id)) throw new Error(`checkpoint repeats cause id '${frame.cause.id}'`)
      expectedCauseIds.add(frame.cause.id)
      for (const applied of frame.events) {
        if (expectedEventIds.has(applied.id)) throw new Error(`checkpoint repeats event id '${applied.id}'`)
        expectedEventIds.add(applied.id)
        expectedAt = applied.ts
      }
    }
    const receiptsValidatedAt = performance.now()
    const causeIds = new Set(parsed.causeIds)
    const eventIds = new Set(parsed.eventIds)
    if (!setsEqual(causeIds, expectedCauseIds)) throw new Error("checkpoint cause registry does not match receipts")
    if (!setsEqual(eventIds, expectedEventIds)) throw new Error("checkpoint event registry does not match receipts")
    if (parsed.at !== expectedAt) throw new Error("checkpoint event-order timestamp does not match receipts")
    if (history !== undefined) trimReceiptCache(receiptsById, receiptsByKey, causeIds, eventIds)
    const registriesValidatedAt = performance.now()
    coreLog.debug?.("projection checkpoint restored", {
      envelopeMs: envelopeParsedAt - restoreStarted,
      stateMs: stateValidatedAt - envelopeParsedAt,
      receiptsMs: receiptsValidatedAt - stateValidatedAt,
      registriesMs: registriesValidatedAt - receiptsValidatedAt,
      totalMs: registriesValidatedAt - restoreStarted,
      receipts: parsed.receipts.length,
      causeIds: parsed.causeIds.length,
      eventIds: parsed.eventIds.length,
    })

    return {
      cursor: checkpoint.cursor,
      revision: 0,
      ...(parsed.at === undefined ? {} : { at: parsed.at }),
      state: freeze(state as State) as DeepReadonly<State>,
      receiptsById,
      receiptsByKey,
      causeIds,
      eventIds,
    }
  }

  const loadProjection = async (): Promise<Projection | undefined> => {
    if (checkpointStore === undefined || checkpointIdentity === undefined) return undefined
    let checkpoint: JournalCheckpoint | undefined
    try {
      checkpoint = await checkpointStore.load(checkpointIdentity)
      if (checkpoint === undefined) return undefined
      const restored = restoreProjection(checkpoint)
      checkpointCursor = checkpoint.cursor
      return restored
    } catch (error) {
      warnCheckpoint("projection checkpoint is invalid; replaying journal authority", error)
      return undefined
    }
  }

  const saveProjection = async (next: Projection): Promise<boolean> => {
    const save = checkpointStore?.save
    if (save === undefined || checkpointIdentity === undefined || checkpointCursor === next.cursor) {
      return checkpointCursor === next.cursor
    }
    try {
      const stateValue = projectionCheckpointState(next.state)
      const saved = await save({
        identity: checkpointIdentity,
        cursor: next.cursor,
        value: {
          v: PROJECTION_CHECKPOINT_VERSION,
          state: stateValue,
          ...(next.at === undefined ? {} : { at: next.at }),
          receipts: [...next.receiptsById.values()],
          causeIds: [...next.causeIds],
          eventIds: [...next.eventIds],
        },
      })
      if (saved) checkpointCursor = next.cursor
      return saved
    } catch (error) {
      coreLog.error?.("projection checkpoint write failed; journal remains authoritative", {
        action: "skipped",
        reason: "projection-checkpoint-write-failed",
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  const checkpointDebt = (): number => projection.revision - checkpointRevision

  const startCheckpoint = (): Promise<void> => {
    if (checkpointWork !== undefined) return checkpointWork
    const operation = (async (): Promise<boolean> => {
      let progressed = false
      while (checkpointStore?.save !== undefined && checkpointIdentity !== undefined) {
        const target = projection
        const revision = target.revision
        if (!(await saveProjection(target))) return progressed
        progressed = true
        checkpointRevision = Math.max(checkpointRevision, revision)
        if (checkpointDebt() < PROJECTION_CHECKPOINT_REFRESH_FRAMES) return progressed
      }
      return progressed
    })()
    checkpointWork = operation.then(
      (progressed) => {
        checkpointWork = undefined
        // A false save is a normal stale-CAS/refusal outcome. Re-arm only after
        // a successful save when projection work arrived during completion.
        if (progressed && !closing && checkpointDebt() >= PROJECTION_CHECKPOINT_REFRESH_FRAMES) {
          void startCheckpoint()
        }
        return undefined
      },
      (error: unknown) => {
        checkpointWork = undefined
        throw error
      },
    )
    return checkpointWork
  }

  const scheduleCheckpoint = (): void => {
    if (
      closing ||
      checkpointStore?.save === undefined ||
      checkpointIdentity === undefined ||
      checkpointDebt() < PROJECTION_CHECKPOINT_REFRESH_FRAMES
    ) {
      return
    }
    void startCheckpoint()
  }

  const enforceCheckpointHighWater = async (): Promise<void> => {
    if (checkpointStore?.save === undefined || checkpointIdentity === undefined) {
      // A load-only consumer can never flush; checkpoint freshness belongs to
      // the writer. Enforcing here wedges every command behind a writer-side
      // gap (2026-07-20 outage: CI admissions froze on cold-fold debt).
      if (!checkpointWarning && checkpointDebt() >= PROJECTION_CHECKPOINT_HIGH_WATER_FRAMES) {
        checkpointWarning = true
        coreLog.warn?.("projection checkpoint debt exceeds high-water but this consumer cannot flush", {
          action: "deferred",
          reason: "checkpoint-flush-unavailable",
          debt: checkpointDebt(),
        })
      }
      return
    }
    while (checkpointDebt() >= PROJECTION_CHECKPOINT_HIGH_WATER_FRAMES) {
      const before = checkpointRevision
      await startCheckpoint()
      if (checkpointRevision === before && checkpointDebt() >= PROJECTION_CHECKPOINT_HIGH_WATER_FRAMES) {
        throw new Error(
          `yrd: projection checkpoint high-water ${PROJECTION_CHECKPOINT_HIGH_WATER_FRAMES} could not flush`,
        )
      }
    }
  }

  scope.defer(async () => {
    await checkpointWork
  })

  const publish = (next: Projection): void => {
    if (next.cursor <= projection.cursor) return
    projection = next
    state(next.state)
    scheduleCheckpoint()
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

  const journalSnapshot = async (): Promise<JournalSnapshot<State>> => {
    assertOpen()
    const next = await fold(projection)
    publish(next)
    return freeze({
      state: next.state,
      asOf: { cursor: next.cursor, ...(next.at === undefined ? {} : { at: next.at }) },
    }) as JournalSnapshot<State>
  }

  const historySnapshot = async (): Promise<JournalSnapshot<State>> => {
    assertOpen()
    if (history === undefined) return journalSnapshot()
    let historical = cloneFrozen(definition.initialState) as DeepReadonly<State>
    let cursor = 0
    let at: string | undefined
    for await (const batch of journal.read()) {
      for (const value of batch.values) {
        const frame = parseJournalFrame(value)
        for (const applied of frame.events) {
          const currentSchema = definition.events[applied.name]
          if (currentSchema === undefined) throw new Error(`yrd: no event definition for '${applied.name}'`)
          const current = currentSchema.safeParse(applied.data)
          const data = current.success
            ? current.data
            : (definition.replayEvents[applied.name] ?? currentSchema).parse(applied.data)
          const validated = freeze(EventSchema.parse({ ...applied, data })) as Event
          historical = freeze(definition.project(historical, validated, frame.cause)) as DeepReadonly<State>
          at = validated.ts
        }
      }
      cursor = batch.cursor
    }
    definition.validate(historical)
    return freeze({
      state: historical,
      asOf: { cursor, ...(at === undefined ? {} : { at }) },
    }) as JournalSnapshot<State>
  }

  const archivedCommand = (query: Readonly<{ id?: string; key?: string }>): JournalFrame | undefined => {
    const value = history?.command(query)
    return value === undefined ? undefined : parseJournalFrame(value)
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
      publish(current)
      const byId = current.receiptsById.get(canonical.id) ?? archivedCommand({ id: canonical.id })
      const byKey =
        trace?.key === undefined
          ? undefined
          : (current.receiptsByKey.get(trace.key) ?? archivedCommand({ key: trace.key }))
      if (byId !== undefined && byKey !== undefined && byId.cause.id !== byKey.cause.id) {
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

      await enforceCheckpointHighWater()

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
      if (history?.hasIdentity("cause", frame.cause.id) === true) {
        raiseFailure("refusal", "cause-id-conflict", `yrd: cause id '${frame.cause.id}' is already in use`)
      }
      for (const applied of frame.events) {
        if (history?.hasIdentity("event", applied.id) === true) {
          raiseFailure("refusal", "event-id-conflict", `yrd: event id '${applied.id}' is already in use`)
        }
      }
      const candidate = projectFrame(current, frame, "append")
      const appended = await journal.append(frame, current.cursor)
      if (!appended.appended) continue
      publish({ ...candidate, cursor: appended.cursor })
      return commandResult(frame)
    }
    throw new Error("yrd: runtime is closed")
  }

  const track = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    assertOpen()
    const pending = operation().finally(() => {
      active.delete(pending)
    })
    active.add(pending)
    return pending
  }

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise
    closing = true
    closePromise = (async () => {
      try {
        await scope[Symbol.asyncDispose]()
      } finally {
        await Promise.allSettled(active)
        await checkpointWork
        const target = projection
        if (await saveProjection(target)) checkpointRevision = Math.max(checkpointRevision, target.revision)
      }
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
    journalSnapshot: () => track(journalSnapshot),
    historySnapshot: () => track(historySnapshot),
    ...(history === undefined ? {} : { history }),
    retentionDiagnostics: () => ({
      receiptFrames: projection.receiptsById.size,
      causeIds: projection.causeIds.size,
      eventIds: projection.eventIds.size,
      ...(history === undefined ? {} : { journal: history.diagnostics() }),
    }),
    dispatch,
    async *events() {
      await refresh()
      for await (const batch of journal.read()) {
        for (const value of batch.values) yield* parseJournalFrame(value).events
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  })

  try {
    const restored = await loadProjection()
    if (restored === undefined) {
      projection = await fold(emptyProjection())
    } else {
      try {
        projection = await fold(restored)
      } catch (error) {
        checkpointCursor = undefined
        warnCheckpoint("projection checkpoint tail replay failed; replaying journal authority", error)
        projection = await fold(emptyProjection())
      }
    }
    state(projection.state)
    if (await saveProjection(projection)) checkpointRevision = projection.revision
    const features = definition.create(core)
    return mergeFields(core, features, "feature")
  } catch (error) {
    closing = true
    await scope[Symbol.asyncDispose]()
    throw error
  }
}

function buildDef<State extends object, Commands extends CommandTree, Features extends object>(values: {
  initialState: DeepReadonly<State>
  commands: Commands
  events: EventSchemas
  replayEvents: EventSchemas
  project: Project<State>
  validate(state: DeepReadonly<State>): void
  compact(state: DeepReadonly<State>, complete: DeepReadonly<State>): State
  readonly [projectionVersions]: readonly (string | undefined)[]
  create(yrd: Yrd<State, Commands>): Features
}): YrdDef<State, Commands, Features> {
  const definition: YrdDef<State, Commands, Features> = {
    ...values,
    validate: (state) => values.validate(state),
    compact: (state) => values.compact(state, state),
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
      const replayEvents = mergeFields(values.replayEvents, contribution.replayEvents ?? {}, "replay event")
      for (const name of Object.keys(replayEvents)) {
        if (events[name] === undefined) throw new Error(`yrd: replay event '${name}' has no append event definition`)
      }
      const previousFields = Object.keys(values.initialState)
      const owned = Object.keys(addedState)
      return buildDef<State & AddedState, Commands & AddedCommands, Features & AddedFeatures>({
        initialState,
        commands,
        events,
        replayEvents,
        [projectionVersions]:
          contribution.project === undefined
            ? values[projectionVersions]
            : [...values[projectionVersions], contribution.projectionVersion],
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
        validate(state) {
          values.validate(state as unknown as DeepReadonly<State>)
          contribution.validate?.(state)
        },
        compact(state, complete) {
          const previousState = selectFields(state, previousFields) as DeepReadonly<State>
          const previous = values.compact(previousState, complete as unknown as DeepReadonly<State>)
          const projected = { ...state, ...previous } as State & AddedState
          if (contribution.compact === undefined) return projected
          const ownedState = selectFields(projected, owned) as DeepReadonly<AddedState>
          const patch = contribution.compact(ownedState, complete)
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

function projectionCheckpointIdentity<State extends object, Commands extends CommandTree, Features extends object>(
  definition: YrdDef<State, Commands, Features>,
): string {
  const versions = definition[projectionVersions]
  if (versions.some((version) => version === undefined || version.trim() === "")) {
    throw new TypeError("yrd: every projector must declare a non-empty projectionVersion to enable checkpoints")
  }
  const schemaIdentity = (schemas: EventSchemas) =>
    Object.fromEntries(
      Object.keys(schemas)
        .sort()
        .map((name) => {
          const schema = schemas[name]
          if (schema === undefined) throw new TypeError(`yrd: event schema '${name}' is missing`)
          // Journal identity follows accepted input shape; transform semantics are owned by projectionVersion.
          return [name, z.toJSONSchema(schema, { io: "input" })]
        }),
    )
  const encoded = canonicalize({
    v: PROJECTION_CHECKPOINT_VERSION,
    initialState: definition.initialState,
    events: schemaIdentity(definition.events),
    replayEvents: schemaIdentity(definition.replayEvents),
    projectionVersions: versions,
  })
  if (encoded === undefined) throw new TypeError("yrd: projection checkpoint identity must be canonical JSON")
  return createHash("sha256").update(encoded).digest("hex")
}

function projectionCheckpointState(value: unknown, path = "$state"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`yrd: projection checkpoint state '${path}' must be a finite JSON number`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry === undefined) {
        throw new TypeError(`yrd: projection checkpoint state '${path}[${index}]' must not be undefined`)
      }
      return projectionCheckpointState(entry, `${path}[${index}]`)
    })
  }
  if (typeof value !== "object") {
    throw new TypeError(`yrd: projection checkpoint state '${path}' is not JSON-compatible`)
  }
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`yrd: projection checkpoint state '${path}' must be a plain object`)
  }
  if (Object.getOwnPropertySymbols(value).some((key) => Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new TypeError(`yrd: projection checkpoint state '${path}' must not contain enumerable symbol keys`)
  }
  const entries: [string, JsonValue][] = []
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue
    entries.push([key, projectionCheckpointState(entry, `${path}.${key}`)])
  }
  // Define dynamic keys as own data properties. Assignment into `{}` would
  // invoke the inherited __proto__ setter and silently drop valid JSON state.
  return Object.fromEntries(entries)
}

/**
 * Checkpoint bytes are independently checksummed and bound to the complete
 * projector identity. Validate the frame envelope and command/cause binding
 * here without repeating replay's full Zod clone for every already-validated
 * receipt. Semantic checks still share the canonical command-hash and event
 * timestamp validators used by the authoritative journal path.
 */
function parseCheckpointFrame(value: unknown, commandHashes: Map<string, string>): JournalFrame {
  if (!plainRecord(value) || !plainRecord(value.command) || !plainRecord(value.cause) || !Array.isArray(value.events)) {
    throw new Error("checkpoint contains an invalid journal frame")
  }
  const command = value.command
  const cause = value.cause
  const jsonPostorder: object[] = []
  if (
    !exactKeys(command, ["id", "op", "args"]) ||
    !exactKeys(cause, ["id", "commandId", "op", "commandHash", "key", "traceId", "spanId"]) ||
    typeof command.id !== "string" ||
    !UUID_V7_PATTERN.test(command.id) ||
    typeof command.op !== "string" ||
    command.op === "" ||
    (Object.hasOwn(command, "args") && !checkpointJson(command.args, jsonPostorder)) ||
    typeof cause.id !== "string" ||
    !UUID_V7_PATTERN.test(cause.id) ||
    typeof cause.commandId !== "string" ||
    typeof cause.op !== "string" ||
    cause.commandId !== command.id ||
    cause.op !== command.op ||
    typeof cause.commandHash !== "string" ||
    !SHA256_PATTERN.test(cause.commandHash) ||
    !optionalNonemptyString(cause.key) ||
    !optionalNonemptyString(cause.traceId) ||
    !optionalNonemptyString(cause.spanId) ||
    (Object.hasOwn(value, "value") && !checkpointJson(value.value, jsonPostorder)) ||
    !exactKeys(value, ["cause", "command", "events", "value"])
  ) {
    throw new Error("checkpoint contains an invalid journal frame")
  }
  for (const applied of value.events) {
    if (
      !plainRecord(applied) ||
      !exactKeys(applied, ["id", "name", "ts", "data"]) ||
      typeof applied.id !== "string" ||
      !UUID_V7_PATTERN.test(applied.id) ||
      typeof applied.name !== "string" ||
      applied.name === "" ||
      typeof applied.ts !== "string" ||
      !EventSchema.shape.ts.safeParse(applied.ts).success ||
      !checkpointJson(applied.data, jsonPostorder)
    ) {
      throw new Error("checkpoint contains an invalid journal event")
    }
  }
  assertCheckpointCause(command, cause, commandHashes)
  // checkpointJson already walked every dynamic JSON subtree. Freeze those
  // nodes in child-first order, then freeze the fixed frame envelope without
  // paying for a second recursive walk over the same receipt.
  for (const node of jsonPostorder) Object.freeze(node)
  Object.freeze(command)
  Object.freeze(cause)
  for (const applied of value.events) Object.freeze(applied)
  Object.freeze(value.events)
  return Object.freeze(value) as JournalFrame
}

function checkpointJson(value: unknown, postorder: object[]): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0)
  if (Array.isArray(value)) {
    if (!value.every((entry) => checkpointJson(entry, postorder))) return false
    postorder.push(value)
    return true
  }
  if (!plainRecord(value)) return false
  if (!Object.values(value).every((entry) => entry !== undefined && checkpointJson(entry, postorder))) return false
  postorder.push(value)
  return true
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertCheckpointCause(
  command: Record<string, unknown>,
  cause: Record<string, unknown>,
  hashes: Map<string, string>,
): void {
  const intent = Object.hasOwn(command, "args") ? { op: command.op, args: command.args } : { op: command.op }
  const encoded = canonicalize(intent)
  if (encoded === undefined) throw new Error("checkpoint command intent is not canonical JSON")
  // Command ids are outside the hashed intent, so retries and repeated
  // eventless operations often share the exact canonical bytes. Reuse only
  // that deterministic digest; distinct intents are still hashed separately.
  let actual = hashes.get(encoded)
  if (actual === undefined) {
    actual = createHash("sha256").update(encoded).digest("hex")
    hashes.set(encoded, actual)
  }
  if (cause.commandHash !== actual) {
    throw new Error("yrd: command hash does not match its command")
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function optionalNonemptyString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value !== "")
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
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
