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
import { asFailure, failureFact, raiseFailure } from "./failure.ts"
import {
  assertJournalReaderCompatibility,
  JOURNAL_READER_VERSION,
  parseJournalFrame,
  type JournalCompatibility,
  type JournalFrame,
} from "./frame.ts"
import { systemClock } from "./clock.ts"
import { cloneFrozen, freeze, type DeepReadonly } from "./immutable.ts"
import { stage } from "./stage-clock.ts"
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

type EventSchema = z.ZodType<JsonValue>
type EventSchemas = Readonly<Record<string, EventSchema>>
export type JournalEventDef = Readonly<{
  reader: number
  schema: EventSchema
  /**
   * Minimum reader version per top-level payload field, which is what makes the
   * event's reader version survive a growing payload: an event keeps its own
   * `reader` while a field added later carries the higher version that can read
   * it. Empty when the payload shape is not introspectable as an object, and
   * then only the event-level `reader` applies — `journalEventVocabulary()`
   * reports that as an empty map rather than an implied guarantee.
   */
  fields: Readonly<Record<string, number>>
  /**
   * Fields that predate field-versioning, keyed by field name. A field this map
   * names sits at its event's own `reader` not because that version introduced
   * it, but because live journals already hold rows stamped that version and
   * carrying it — the declaration describes what was written, and raising it
   * would make those rows lie. Empty for everything else: an asterisk is only
   * an asterisk while it is rare, so only genuine grandfathers carry one.
   */
  grandfathered: Readonly<Record<string, GrandfatheredField>>
}>
export type GrandfatheredField = Readonly<{ introducedAt: string }>
type JournalEvents = Readonly<Record<string, JournalEventDef>>
type Project<State extends object> = (state: DeepReadonly<State>, event: Event, cause: Cause) => State
type Empty = Readonly<Record<never, never>>
const projectionVersions = Symbol("yrd.projectionVersions")
const checkpointMigrations = Symbol("yrd.checkpointMigrations")
const PROJECTION_CHECKPOINT_VERSION = 1
const PROJECTION_CHECKPOINT_REFRESH_FRAMES = 256
const PROJECTION_CHECKPOINT_HIGH_WATER_FRAMES = 512
const RESULT_CACHE_FRAMES = 4_096
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
/** One unregistered event NAME the replay quarantined, aggregated. The
 * journal can carry names this composed definition does not register —
 * written by newer code, or by older code whose events were since retired.
 * Crashing the whole replay over one frame is the PR1128 shape; instead the
 * fold skips the frame and keeps this report, because a skip nobody can see
 * is a silent error. `sampleId` is one event id for forensics. */
export type UnknownEventNameSummary = Readonly<{
  name: string
  count: number
  firstTs: string
  lastTs: string
  sampleId: string
}>
const UnknownEventNameSummarySchema = z
  .object({
    name: z.string().min(1),
    count: z.number().int().positive(),
    firstTs: z.string(),
    lastTs: z.string(),
    sampleId: z.string(),
  })
  .strict()
const ProjectionCheckpointSchema = z
  .object({
    v: z.literal(PROJECTION_CHECKPOINT_VERSION),
    state: z.unknown(),
    at: z.string().optional(),
    receipts: z.array(z.unknown()),
    causeIds: z.array(z.string()),
    eventIds: z.array(z.string()),
    // Optional and OMITTED while empty: a checkpoint written by this code
    // with nothing quarantined stays readable by predecessors whose strict
    // schema predates the field. Once a quarantine exists, an older reader
    // falls back to its documented rebuild-from-journal path.
    unknownEvents: z.array(UnknownEventNameSummarySchema).optional(),
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
    resultFrames: number
    causeIds: number
    eventIds: number
    journal?: JournalHistoryDiagnostics
    /** Checkpoint Core successfully restored or saved under the current projection definition. */
    checkpoint?: Readonly<{ identity: string; cursor: Cursor }>
  }>
  dispatch: Dispatch
  /** Replay's unknown-name quarantine report, aggregated by event name and
   * sorted; empty when every journal name is registered. See
   * {@link UnknownEventNameSummary}. */
  unknownEventNames(): readonly UnknownEventNameSummary[]
  /** `unknownNames: "skip"` (default) omits quarantined frames from the
   * stream; `"raw"` yields their stored envelopes for diagnostic surfaces. */
  events(after?: Cursor, before?: Cursor, options?: Readonly<{ unknownNames?: "skip" | "raw" }>): AsyncIterable<Event>
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
  events?: JournalEvents
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
  events: JournalEvents
  replayEvents: EventSchemas
  project: Project<State>
  validate(state: DeepReadonly<State>): void
  compact(state: DeepReadonly<State>): State
  readonly [projectionVersions]: readonly (string | undefined)[]
  readonly [checkpointMigrations]: readonly CheckpointMigration<State>[]
  create(yrd: Yrd<State, Commands>): Features
  extend<
    AddedState extends object = Empty,
    AddedCommands extends CommandTree = Empty,
    AddedFeatures extends object = Empty,
  >(
    contribution: Contribution<State, Commands, Features, AddedState, AddedCommands, AddedFeatures>,
  ): YrdDef<State & AddedState, Commands & AddedCommands, Features & AddedFeatures>
}>

export type CheckpointMigration<State extends object> = Readonly<{
  /** Exact predecessor projection identity this edge accepts. */
  from: string
  /** Exact successor identity. Omit only for the current definition. */
  to?: string
  /** Pure projection-state transform. Journal frames and result registries are preserved by Core. */
  migrate(state: DeepReadonly<State>): State
}>

export const CheckpointMigrationManifestSchema = z
  .object({
    version: z.literal(1),
    targetIdentity: z.string().regex(SHA256_PATTERN),
    edges: z
      .array(
        z
          .object({
            from: z.string().regex(SHA256_PATTERN),
            to: z.string().regex(SHA256_PATTERN),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict()
  .readonly()
export type CheckpointMigrationManifest = z.infer<typeof CheckpointMigrationManifestSchema>

/** Full, deterministic content identity used by Candidate certificates. */
export function checkpointMigrationManifestHash(manifest: CheckpointMigrationManifest): string {
  const parsed = CheckpointMigrationManifestSchema.parse(manifest)
  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex")
}

export function withCheckpointMigrations<State extends object, Commands extends CommandTree, Features extends object>(
  definition: YrdDef<State, Commands, Features>,
  migrations: readonly CheckpointMigration<State>[],
): YrdDef<State, Commands, Features> {
  for (const migration of migrations) {
    if (!SHA256_PATTERN.test(migration.from)) {
      throw new TypeError(`yrd: checkpoint migration predecessor '${migration.from}' is not a SHA-256 identity`)
    }
    if (migration.to !== undefined && !SHA256_PATTERN.test(migration.to)) {
      throw new TypeError(`yrd: checkpoint migration successor '${migration.to}' is not a SHA-256 identity`)
    }
  }
  return buildDef({
    initialState: definition.initialState,
    commands: definition.commands,
    events: definition.events,
    replayEvents: definition.replayEvents,
    project: definition.project,
    validate: definition.validate,
    compact: (state) => definition.compact(state),
    [projectionVersions]: definition[projectionVersions],
    [checkpointMigrations]: [...definition[checkpointMigrations], ...migrations],
    create: definition.create,
  })
}

export function checkpointMigrationManifest<
  State extends object,
  Commands extends CommandTree,
  Features extends object,
>(definition: YrdDef<State, Commands, Features>): CheckpointMigrationManifest {
  const targetIdentity = projectionCheckpointIdentity(definition)
  return CheckpointMigrationManifestSchema.parse({
    version: 1,
    targetIdentity,
    edges: definition[checkpointMigrations]
      .map(({ from, to }) => ({ from, to: to ?? targetIdentity }))
      .toSorted((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
  })
}

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
    [checkpointMigrations]: [],
    create: () => ({}),
  })
}

/** Top-level payload field names a schema can produce, across union branches. */
function schemaFieldNames(schema: EventSchema): readonly string[] {
  let json: unknown
  try {
    json = z.toJSONSchema(schema, { io: "input" })
  } catch {
    // silent-fallback-allow: JSON Schema cannot express this payload shape;
    // callers see an empty field map, never a silent guarantee.
    return []
  }
  const names = new Set<string>()
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return
    const record = node as Record<string, unknown>
    const properties = record.properties
    if (typeof properties === "object" && properties !== null) {
      for (const name of Object.keys(properties)) names.add(name)
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const branches = record[key]
      if (Array.isArray(branches)) for (const branch of branches) visit(branch)
    }
  }
  visit(json)
  return [...names].sort()
}

/**
 * One event's minimum reader version and payload schema, inseparably. Pass
 * `fieldReaders` for fields a later version introduced: a v1 event that grows a
 * `by` field readable only from v2 is `journalEvent(1, schema, { by: 2 })`, and
 * a writer pinned below v2 then refuses to emit `by` instead of writing a row
 * every v1 reader rejects.
 *
 * Pass `grandfathered` for a field that shipped before field-versioning existed.
 * It keeps the event's own version — journals already hold rows stamped that
 * version and carrying it — and records the commit that introduced it, so the
 * exception can be enumerated later instead of remembered.
 */
export function journalEvent(
  reader: number,
  schema: EventSchema,
  fieldReaders: Readonly<Record<string, number>> = {},
  grandfathered: Readonly<Record<string, GrandfatheredField>> = {},
): JournalEventDef {
  if (!Number.isSafeInteger(reader) || reader < 0) {
    raiseFailure(
      "configuration",
      "journal-event-version-invalid",
      `yrd: journal event has invalid minimum reader version '${reader}'`,
    )
  }
  const names = schemaFieldNames(schema)
  const fields: Record<string, number> = Object.fromEntries(names.map((name) => [name, reader]))
  for (const [name, version] of Object.entries(fieldReaders)) {
    if (!Number.isSafeInteger(version) || version < reader) {
      raiseFailure(
        "configuration",
        "journal-field-version-invalid",
        `yrd: journal event field '${name}' has minimum reader version '${version}', below its event's v${reader}`,
      )
    }
    if (!Object.hasOwn(fields, name)) {
      // A declaration that guards nothing is worse than none: it reads as
      // protection while the field it names is emitted unchecked.
      raiseFailure(
        "configuration",
        "journal-field-not-in-schema",
        `yrd: journal event declares a minimum reader for field '${name}', which its payload schema does not have`,
      )
    }
    fields[name] = version
  }
  const marks: Record<string, GrandfatheredField> = {}
  for (const [name, mark] of Object.entries(grandfathered)) {
    if (!Object.hasOwn(fields, name)) {
      raiseFailure(
        "configuration",
        "journal-grandfather-not-in-schema",
        `yrd: journal event grandfathers field '${name}', which its payload schema does not have`,
      )
    }
    if (fields[name] !== reader) {
      // Grandfathering says "v${reader} rows already carry this"; a raised
      // version says "no row below v${fields[name]} carries it". Both cannot be
      // true, and shipping the pair would leave readers no answer at all.
      raiseFailure(
        "configuration",
        "journal-grandfather-field-versioned",
        `yrd: journal event grandfathers field '${name}' at v${reader} while also declaring it needs v${fields[name]}`,
      )
    }
    if (!/^[0-9a-f]{7,40}$/u.test(mark.introducedAt)) {
      // The commit is the whole value of the record: an audit that cannot walk
      // back to the change has only been told an asterisk exists.
      raiseFailure(
        "configuration",
        "journal-grandfather-ref-invalid",
        `yrd: journal event grandfathers field '${name}' at '${mark.introducedAt}', which is not a commit id`,
      )
    }
    marks[name] = Object.freeze({ introducedAt: mark.introducedAt })
  }
  return Object.freeze({
    reader,
    schema,
    fields: Object.freeze(fields),
    grandfathered: Object.freeze(marks),
  })
}

export type JournalEventVocabulary = Readonly<
  Record<
    string,
    Readonly<{
      reader: number
      fields: Readonly<Record<string, number>>
      grandfathered?: Readonly<Record<string, GrandfatheredField>>
    }>
  >
>

/**
 * Every event's reader version and the minimum reader each of its fields needs.
 * Pin a snapshot of this per package: growing a shipped event's payload then
 * cannot merge without declaring which version can read the new field.
 *
 * `grandfathered` appears only where an event actually carries one, so the
 * unmarked default stays the shape it has always been and an audit can count
 * the exceptions by looking for the key.
 */
export function journalEventVocabulary(events: JournalEvents): JournalEventVocabulary {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(events)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, definition]) => [
          name,
          Object.keys(definition.grandfathered).length === 0
            ? { reader: definition.reader, fields: definition.fields }
            : {
                reader: definition.reader,
                fields: definition.fields,
                grandfathered: definition.grandfathered,
              },
        ]),
    ),
  )
}

/**
 * The write-side half of journal compatibility. A reader pinned below a field's
 * version cannot skip that field — every frame schema is `.strict()`, so one
 * unknown key refuses the whole row and strands that reader for good. The only
 * place the skew can still be stopped is where it is authored.
 */
function assertEmittedFieldVocabulary(
  name: string,
  definition: JournalEventDef,
  data: JsonValue,
  compatibility: JournalCompatibility | undefined,
): void {
  if (compatibility === undefined) return
  if (typeof data !== "object" || data === null || Array.isArray(data)) return
  for (const field of Object.keys(data)) {
    // Own keys only: a field named `constructor` must not read a function off
    // the prototype and compare as though it carried a version.
    const declared = Object.hasOwn(definition.fields, field) ? definition.fields[field] : undefined
    const required = declared ?? definition.reader
    if (required > compatibility.version) {
      raiseFailure(
        "configuration",
        "journal-field-version-skew",
        `yrd: event '${name}' field '${field}' requires journal reader v${required}; ` +
          `this writer supports v${compatibility.version}`,
      )
    }
  }
}

function validateJournalEvents(events: JournalEvents): void {
  for (const [name, definition] of Object.entries(events)) {
    if (!Number.isSafeInteger(definition.reader) || definition.reader < 0) {
      raiseFailure(
        "configuration",
        "journal-event-version-invalid",
        `yrd: event '${name}' has invalid minimum reader version '${definition.reader}'`,
      )
    }
    if (definition.reader > JOURNAL_READER_VERSION) {
      raiseFailure(
        "configuration",
        "journal-event-reader-unsupported",
        `yrd: event '${name}' requires journal reader v${definition.reader}; this reader supports through v${JOURNAL_READER_VERSION}`,
      )
    }
    for (const [field, version] of Object.entries(definition.fields)) {
      if (version > JOURNAL_READER_VERSION) {
        raiseFailure(
          "configuration",
          "journal-field-reader-unsupported",
          `yrd: event '${name}' field '${field}' requires journal reader v${version}; ` +
            `this reader supports through v${JOURNAL_READER_VERSION}`,
        )
      }
    }
  }
}

export async function createYrd<State extends object, Commands extends CommandTree, Features extends object>(
  definition: YrdDef<State, Commands, Features>,
  options: Readonly<{
    inject: Readonly<{
      journal: Journal<unknown>
      compatibility?: JournalCompatibility
      clock?: () => string
      id?: () => string
      log?: ConditionalLogger
      scope?: Scope
    }>
  }>,
): Promise<Yrd<State, Commands> & Features> {
  const journal = options.inject.journal
  const history = journal.history
  const clock = options.inject.clock ?? systemClock.iso
  const id = options.inject.id ?? uuidv7
  const log = options.inject.log ?? createLogger("yrd")
  const coreLog = log.child("core")
  const scope = options.inject.scope?.child("yrd") ?? createScope("yrd")
  const commands = definition.commands as Commands
  const registry = createCommandTreeRegistry(
    commands as SilveryCommandTree<unknown>,
  ) as SerializableCommandRegistry<AnyCommand>
  const state = signal<DeepReadonly<State>>(cloneFrozen(definition.initialState) as DeepReadonly<State>)
  validateJournalEvents(definition.events)

  type Projection = Readonly<{
    cursor: Cursor
    revision: number
    at?: string
    state: DeepReadonly<State>
    resultsById: ReadonlyMap<string, JournalFrame>
    resultsByKey: ReadonlyMap<string, JournalFrame>
    causeIds: ReadonlySet<string>
    eventIds: ReadonlySet<string>
    /** Replay's unknown-name quarantine report, keyed by event name. */
    unknownEvents: ReadonlyMap<string, UnknownEventNameSummary>
  }>

  const emptyProjection = (): Projection => ({
    cursor: 0,
    revision: 0,
    state: state(),
    resultsById: new Map(),
    resultsByKey: new Map(),
    causeIds: new Set(),
    eventIds: new Set(),
    unknownEvents: new Map(),
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

  const reportSavedStateRebuild = (message: string): void => {
    if (checkpointWarning) return
    checkpointWarning = true
    coreLog.info?.(message)
  }

  if (checkpointStore !== undefined) {
    try {
      checkpointIdentity = projectionCheckpointIdentity(definition)
    } catch {
      reportSavedStateRebuild("Saved state cannot be reused with this configuration; rebuilding it.")
    }
  }

  const canonicalEvent = (applied: Event, source: "append" | "replay"): Event | undefined => {
    const currentDefinition = definition.events[applied.name]
    if (currentDefinition === undefined) {
      // Replay-only quarantine: writers stay strict (append still throws),
      // readers skip the frame and record it in the projection's
      // unknown-name report — see UnknownEventNameSummary. Every replay
      // caller handles `undefined`; which surfaces skip and which render
      // the raw envelope is each caller's explicit choice.
      if (source === "append") throw new Error(`yrd: no event definition for '${applied.name}'`)
      return undefined
    }
    const currentSchema = currentDefinition.schema
    const current = currentSchema.safeParse(applied.data)
    const data = current.success
      ? current.data
      : source === "append"
        ? currentSchema.parse(applied.data)
        : (definition.replayEvents[applied.name] ?? currentSchema).parse(applied.data)
    return freeze(EventSchema.parse({ ...applied, data })) as Event
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

  /**
   * Replay from the beginning, for a session with no usable checkpoint.
   *
   * Retention only ever evicts frames a checkpoint already folded in, so an
   * evicted prefix and a rebuild from cursor 0 are mutually exclusive in
   * healthy operation. They meet in exactly one state: the checkpoint that
   * authorized the eviction is itself missing or unreadable, and then the
   * journal genuinely cannot be rebuilt from what survives. Name that, instead
   * of letting the journal's replay refusal open the app with a bare
   * RangeError.
   */
  const foldFromEmpty = async (): Promise<Projection> => {
    const evictedThrough = history?.diagnostics().evictedThrough ?? 0
    if (evictedThrough > 0) {
      raiseFailure(
        "infrastructure",
        "saved-state-unrebuildable",
        `yrd: Yrd's saved state must be rebuilt from the journal, but history below cursor ${evictedThrough + 1} ` +
          `was evicted by the retention window, so it cannot be replayed from the beginning`,
      )
    }
    return fold(emptyProjection())
  }

  const projectFrame = (base: Projection, frame: JournalFrame, source: "append" | "replay"): Projection => {
    if (base.resultsById.has(frame.command.id)) {
      throw new Error(`yrd: journal contains duplicate command id '${frame.cause.commandId}'`)
    }
    if (frame.cause.key !== undefined && base.resultsByKey.has(frame.cause.key)) {
      throw new Error(`yrd: journal contains duplicate command key '${frame.cause.key}'`)
    }
    const causeIds = new Set(base.causeIds)
    if (causeIds.has(frame.cause.id)) throw new Error(`yrd: journal contains duplicate cause id '${frame.cause.id}'`)
    causeIds.add(frame.cause.id)
    const eventIds = new Set(base.eventIds)
    let nextState = base.state
    let unknownEvents: Map<string, UnknownEventNameSummary> | undefined
    for (const applied of frame.events) {
      if (eventIds.has(applied.id)) throw new Error(`yrd: journal contains duplicate event id '${applied.id}'`)
      eventIds.add(applied.id)
      const validated = canonicalEvent(applied, source)
      if (validated === undefined) {
        unknownEvents ??= new Map(base.unknownEvents)
        const previous = unknownEvents.get(applied.name)
        unknownEvents.set(
          applied.name,
          previous === undefined
            ? { name: applied.name, count: 1, firstTs: applied.ts, lastTs: applied.ts, sampleId: applied.id }
            : { ...previous, count: previous.count + 1, lastTs: applied.ts },
        )
        continue
      }
      const projected = definition.project(nextState, validated, frame.cause)
      nextState = freeze(projected) as DeepReadonly<State>
    }
    if (source === "append") definition.validate(nextState)
    if (history !== undefined && source === "append" && frame.events.length > 0) {
      nextState = freeze(definition.compact(nextState)) as DeepReadonly<State>
    }
    const resultsById = new Map(base.resultsById)
    resultsById.set(frame.command.id, frame)
    const resultsByKey = new Map(base.resultsByKey)
    if (frame.cause.key !== undefined) resultsByKey.set(frame.cause.key, frame)
    if (history !== undefined) trimResultCache(resultsById, resultsByKey, causeIds, eventIds)
    const at = frame.events.at(-1)?.ts ?? base.at
    return {
      ...base,
      revision: base.revision + 1,
      state: nextState,
      resultsById,
      resultsByKey,
      causeIds,
      eventIds,
      ...(unknownEvents === undefined ? {} : { unknownEvents }),
      ...(at === undefined ? {} : { at }),
    }
  }

  const trimResultCache = (
    resultsById: Map<string, JournalFrame>,
    resultsByKey: Map<string, JournalFrame>,
    causeIds: Set<string>,
    eventIds: Set<string>,
  ): void => {
    while (resultsById.size > RESULT_CACHE_FRAMES) {
      const oldest = resultsById.entries().next().value as readonly [string, JournalFrame] | undefined
      if (oldest === undefined) break
      const [commandId, frame] = oldest
      resultsById.delete(commandId)
      if (frame.cause.key !== undefined && resultsByKey.get(frame.cause.key)?.command.id === commandId) {
        resultsByKey.delete(frame.cause.key)
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
    const state: unknown = parsed.state
    assertCheckpointState(state)
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new Error("checkpoint state must be a JSON object")
    }
    const stateValidatedAt = performance.now()

    const resultsById = new Map<string, JournalFrame>()
    const resultsByKey = new Map<string, JournalFrame>()
    const expectedCauseIds = new Set<string>()
    const expectedEventIds = new Set<string>()
    const commandHashes = new Map<string, string>()
    let expectedAt: string | undefined
    for (const value of parsed.receipts) {
      const frame = parseCheckpointFrame(value, commandHashes)
      if (resultsById.has(frame.command.id)) throw new Error(`checkpoint repeats command id '${frame.command.id}'`)
      resultsById.set(frame.command.id, frame)
      if (frame.cause.key !== undefined) {
        if (resultsByKey.has(frame.cause.key)) throw new Error(`checkpoint repeats command key '${frame.cause.key}'`)
        resultsByKey.set(frame.cause.key, frame)
      }
      if (expectedCauseIds.has(frame.cause.id)) throw new Error(`checkpoint repeats cause id '${frame.cause.id}'`)
      expectedCauseIds.add(frame.cause.id)
      for (const applied of frame.events) {
        if (expectedEventIds.has(applied.id)) throw new Error(`checkpoint repeats event id '${applied.id}'`)
        expectedEventIds.add(applied.id)
        expectedAt = applied.ts
      }
    }
    const resultsValidatedAt = performance.now()
    const causeIds = new Set(parsed.causeIds)
    const eventIds = new Set(parsed.eventIds)
    if (!setsEqual(causeIds, expectedCauseIds)) throw new Error("checkpoint cause registry does not match results")
    if (!setsEqual(eventIds, expectedEventIds)) throw new Error("checkpoint event registry does not match results")
    if (parsed.at !== expectedAt) throw new Error("checkpoint event-order timestamp does not match results")
    if (history !== undefined) trimResultCache(resultsById, resultsByKey, causeIds, eventIds)
    const registriesValidatedAt = performance.now()
    coreLog.debug?.("projection checkpoint restored", {
      envelopeMs: envelopeParsedAt - restoreStarted,
      stateMs: stateValidatedAt - envelopeParsedAt,
      resultsMs: resultsValidatedAt - stateValidatedAt,
      registriesMs: registriesValidatedAt - resultsValidatedAt,
      totalMs: registriesValidatedAt - restoreStarted,
      results: parsed.receipts.length,
      causeIds: parsed.causeIds.length,
      eventIds: parsed.eventIds.length,
    })

    return {
      cursor: checkpoint.cursor,
      revision: 0,
      ...(parsed.at === undefined ? {} : { at: parsed.at }),
      state: freeze(state as State) as DeepReadonly<State>,
      resultsById,
      resultsByKey,
      causeIds,
      eventIds,
      unknownEvents: new Map((parsed.unknownEvents ?? []).map((summary) => [summary.name, summary])),
    }
  }

  const loadProjection = async (): Promise<Projection | undefined> => {
    if (checkpointStore === undefined || checkpointIdentity === undefined) return undefined
    let checkpoint: JournalCheckpoint | undefined
    let migrationSource = false
    try {
      checkpoint = await checkpointStore.load(checkpointIdentity)
      if (checkpoint === undefined && checkpointStore.inspect !== undefined) {
        const predecessor = await checkpointStore.inspect()
        if (predecessor !== undefined && predecessor.identity !== checkpointIdentity) {
          if (definition[checkpointMigrations].length > 0) {
            migrationSource = true
            try {
              checkpoint = migrateProjectionCheckpoint(definition, predecessor, checkpointIdentity)
            } catch (error) {
              if (failureFact(error)?.code === "checkpoint-migration-missing") {
                const evictedThrough = history?.diagnostics().evictedThrough ?? 0
                if (evictedThrough === 0) {
                  reportSavedStateRebuild("Saved state has no migration path; rebuilding it from complete history.")
                  return undefined
                }
                raiseFailure(
                  "configuration",
                  "checkpoint-migration-missing",
                  `yrd: no checkpoint migration path exists from '${predecessor.identity}' to '${checkpointIdentity}'; ` +
                    `rebuild from history is unavailable because history through cursor ${evictedThrough} was evicted. ` +
                    checkpointMigrationRemedy(
                      definition[checkpointMigrations],
                      predecessor.identity,
                      checkpointIdentity,
                    ),
                )
              }
              throw error
            }
          } else {
            const evictedThrough = history?.diagnostics().evictedThrough ?? 0
            if (evictedThrough > 0) {
              raiseFailure(
                "configuration",
                "checkpoint-identity-mismatch",
                `yrd: stored checkpoint identity '${predecessor.identity}' does not match computed projection identity ` +
                  `'${checkpointIdentity}'; history through cursor ${evictedThrough} was evicted under the stored ` +
                  "checkpoint's authority",
              )
            }
          }
        }
      }
      if (checkpoint === undefined) return undefined
      // Wrapped at the CALL so the stage covers the whole restore including the
      // deep `freeze(state)` in its return — the existing `totalMs` inside
      // restoreProjection stops before that freeze and so under-reports itself.
      const restored = stage("checkpoint-restore", () => restoreProjection(checkpoint as JournalCheckpoint))
      checkpointCursor = migrationSource ? undefined : checkpoint.cursor
      return restored
    } catch (error) {
      if (failureFact(error)?.code === "checkpoint-identity-mismatch") throw error
      if (migrationSource) {
        if (failureFact(error) !== undefined) throw error
        raiseFailure(
          "configuration",
          "checkpoint-migration-invalid",
          `yrd: migrated checkpoint failed current validation: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      // silent-fallback-allow: the report below surfaces corruption before the documented rebuild path.
      reportSavedStateRebuild("Saved state is inconsistent; rebuilding it.")
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
          receipts: [...next.resultsById.values()],
          causeIds: [...next.causeIds],
          eventIds: [...next.eventIds],
          ...(next.unknownEvents.size === 0
            ? {}
            : { unknownEvents: [...next.unknownEvents.values()].toSorted((a, b) => a.name.localeCompare(b.name)) }),
        },
      })
      if (saved) checkpointCursor = next.cursor
      return saved
    } catch (error) {
      coreLog.warn?.(
        "Could not save Yrd's current state; the command succeeded, but the next command may start more slowly.",
        { error: error instanceof Error ? error.message : String(error) },
      )
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
        coreLog.info?.("Yrd's saved state will be updated by the next write-capable command.")
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

  /**
   * The state every event ever appended projects to, with nothing compacted
   * away — what `journalSnapshot` would have returned if `definition.compact`
   * had never run.
   *
   * This one genuinely reads from cursor 0, and cannot be pointed at the
   * checkpoint the way `fold` is. The checkpoint holds the COMPACTED
   * projection, so restoring from it would reproduce `journalSnapshot`'s answer
   * and collapse the two methods into one. Callers reach for this method
   * precisely to see the records compaction dropped — `queue.history()`, behind
   * `yrd log --all`. Reading every frame IS the contract here, so its cost
   * belongs to journal retention (`@yrd/core/21584-yrd-performance/22245`),
   * not to this call site.
   */
  const historySnapshot = async (): Promise<JournalSnapshot<State>> => {
    assertOpen()
    if (history === undefined) return journalSnapshot()
    // Reading every frame IS this method's contract, so an evicted prefix
    // cannot be papered over. The checkpoint is not a substitute: it holds the
    // COMPACTED projection, so seeding from it would return `journalSnapshot`'s
    // answer under this method's name — precisely the collapse the comment
    // above refuses. Say instead where coverage begins, in the product's own
    // failure vocabulary, rather than let the journal's replay refusal reach a
    // caller as an unclassified RangeError.
    const evictedThrough = history.diagnostics().evictedThrough
    if (evictedThrough > 0) {
      raiseFailure(
        "refusal",
        "history-evicted",
        `yrd: history coverage begins at cursor ${evictedThrough + 1} ` +
          `(${evictedThrough} frames evicted by the retention window), so the complete history is no longer replayable; ` +
          `run 'yrd log' for the live state, which the checkpoint still holds in full`,
      )
    }
    let historical = cloneFrozen(definition.initialState) as DeepReadonly<State>
    let cursor = 0
    let at: string | undefined
    for await (const batch of journal.read()) {
      for (const value of batch.values) {
        const frame = parseJournalFrame(value)
        for (const applied of frame.events) {
          const validated = canonicalEvent(applied, "replay")
          if (validated === undefined) continue
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
      const byId = current.resultsById.get(canonical.id) ?? archivedCommand({ id: canonical.id })
      const byKey =
        trace?.key === undefined
          ? undefined
          : (current.resultsByKey.get(trace.key) ?? archivedCommand({ key: trace.key }))
      if (byId !== undefined && byKey !== undefined && byId.cause.id !== byKey.cause.id) {
        raiseFailure(
          "refusal",
          "command-key-conflict",
          `yrd: command id '${canonical.id}' and key '${trace?.key}' disagree`,
        )
      }
      const recorded = byKey ?? byId
      if (recorded !== undefined) {
        if (recorded.cause.commandHash !== cause.commandHash) {
          raiseFailure(
            "refusal",
            "command-id-conflict",
            `yrd: command ${trace?.key === undefined ? `id '${canonical.id}'` : `key '${trace.key}'`} was already used for a different command`,
          )
        }
        publish(current)
        return commandResult(recorded)
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
        const installed = definition.events[draft.name]
        if (installed === undefined) {
          raiseFailure("configuration", "event-not-installed", `yrd: no event definition for '${draft.name}'`)
        }
        if (options.inject.compatibility !== undefined && installed.reader > options.inject.compatibility.version) {
          raiseFailure(
            "configuration",
            "journal-event-version-skew",
            `yrd: event '${draft.name}' requires journal reader v${installed.reader}; this writer supports v${options.inject.compatibility.version}`,
          )
        }
        const data = installed.schema.parse(draft.data)
        assertEmittedFieldVocabulary(draft.name, installed, data, options.inject.compatibility)
        return EventSchema.parse({ id: id(), name: draft.name, ts: clock(), data })
      })
      const value = result.value === undefined ? undefined : JsonSchema.parse(result.value)
      const frame = parseJournalFrame({
        cause,
        command: canonical,
        events,
        ...(value === undefined ? {} : { value }),
        ...(options.inject.compatibility === undefined ? {} : { compatibility: options.inject.compatibility }),
      })
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
      resultFrames: projection.resultsById.size,
      causeIds: projection.causeIds.size,
      eventIds: projection.eventIds.size,
      ...(history === undefined ? {} : { journal: history.diagnostics() }),
      ...(checkpointIdentity === undefined || checkpointCursor === undefined
        ? {}
        : { checkpoint: { identity: checkpointIdentity, cursor: checkpointCursor } }),
    }),
    unknownEventNames: () => [...projection.unknownEvents.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
    dispatch,
    /**
     * Yield the journal's events in cursor order, `after` through `before`.
     *
     * The range exists because `Journal.read` resolves its whole range before
     * it yields anything — the SQLite journal SELECTs and `decodeStoredEvent`s
     * every row in one transaction — so a caller that breaks out of this
     * generator after one event still pays for the entire journal. Bounding at
     * the read is the only thing that makes an early-stopping caller cheap.
     * Both arguments carry `Journal.read`'s own defaults: the whole journal.
     */
    async *events(after?: Cursor, before?: Cursor, options?: Readonly<{ unknownNames?: "skip" | "raw" }>) {
      await refresh()
      const unknownNames = options?.unknownNames ?? "skip"
      for await (const batch of journal.read(after, before)) {
        for (const value of batch.values) {
          assertJournalReaderCompatibility(value)
          for (const applied of journalFrameEvents(value)) {
            const validated = canonicalEvent(applied, "replay")
            if (validated !== undefined) {
              yield validated
              continue
            }
            // "skip" keeps the stream's shape for existing consumers; the
            // quarantine stays visible via unknownEventNames(). "raw" hands
            // diagnostic surfaces (`yrd log --all` and friends) the envelope
            // exactly as stored — the envelope schema is name-agnostic.
            if (unknownNames === "raw") yield freeze(EventSchema.parse(applied)) as Event
          }
        }
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  })

  try {
    const restored = await loadProjection()
    if (restored === undefined) {
      projection = await foldFromEmpty()
    } else {
      try {
        projection = await fold(restored)
      } catch {
        checkpointCursor = undefined
        reportSavedStateRebuild("Saved state is inconsistent; rebuilding it.")
        projection = await foldFromEmpty()
      }
    }
    state(projection.state)
    if (projection.unknownEvents.size > 0) {
      coreLog.info?.("Journal carries events with unregistered names; replay quarantined them (unknownEventNames()).", {
        names: [...projection.unknownEvents.keys()].toSorted(),
      })
    }
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
  events: JournalEvents
  replayEvents: EventSchemas
  project: Project<State>
  validate(state: DeepReadonly<State>): void
  compact(state: DeepReadonly<State>, complete: DeepReadonly<State>): State
  readonly [projectionVersions]: readonly (string | undefined)[]
  readonly [checkpointMigrations]: readonly CheckpointMigration<State>[]
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
      if (values[checkpointMigrations].length > 0) {
        throw new TypeError("yrd: declare checkpoint migrations only after the Yrd definition is fully composed")
      }
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
        [checkpointMigrations]: [],
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

/** Two unrelated "checkpoint" concepts exist in yrd; this is the JOURNAL one.
 * The projection checkpoint snapshots projected state, keyed by the identity
 * below (initialState + event schemas + replayEvents + projectionVersions) —
 * renaming any persisted key or version string moves it and orphans stored
 * checkpoints. `BayWorkspace.checkpoint` (yrd-bay/src/plugin.ts) is the other
 * one: it preserves a bay's working tree. They share nothing but the word. */
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
  const journalSchemaIdentity = (events: JournalEvents) =>
    schemaIdentity(Object.fromEntries(Object.entries(events).map(([name, definition]) => [name, definition.schema])))
  const encoded = canonicalize({
    v: PROJECTION_CHECKPOINT_VERSION,
    initialState: definition.initialState,
    events: journalSchemaIdentity(definition.events),
    replayEvents: schemaIdentity(definition.replayEvents),
    projectionVersions: versions,
  })
  if (encoded === undefined) throw new TypeError("yrd: projection checkpoint identity must be canonical JSON")
  return createHash("sha256").update(encoded).digest("hex")
}

type ResolvedCheckpointMigration<State extends object> = Readonly<{
  from: string
  to: string
  migrate(state: DeepReadonly<State>): State
}>

/** Name the remedy for the producing state, not the failure class. The two
 * states behind a missing path have opposite cures: a stored identity outside
 * the declared graph was written by another composition — in fleet history
 * always a newer or off-pin build — and the cheap cure is the checkout, never
 * an edge declared from an identity this source never shipped; a retained
 * identity whose chain stops short needs its missing hop named, which the
 * end-to-end pair alone does not reveal. */
function checkpointMigrationRemedy(
  migrations: readonly Readonly<{ from: string; to?: string | undefined }>[],
  from: string,
  target: string,
): string {
  const edges = migrations.map((migration) => ({ from: migration.from, to: migration.to ?? target }))
  if (!edges.some((edge) => edge.from === from)) {
    return (
      "This composition has no record of the stored identity, so the store was written by a different — " +
      "typically newer, or off-pin — composition. Sync or restore the checkout that wrote the store first; " +
      "declare an edge only for a contract this composition genuinely shipped, measured from the deployment's " +
      "stored identity, never from a harness"
    )
  }
  // A cycle raises checkpoint-migration-cyclic before a missing path is ever
  // reported, so the subgraph reachable here is a DAG and holds a dead end.
  const seen = new Set<string>([from])
  const frontier = [from]
  const stalls: string[] = []
  while (frontier.length > 0) {
    const identity = frontier.pop() as string
    const outgoing = edges.filter((edge) => edge.from === identity)
    if (outgoing.length === 0) {
      stalls.push(identity)
      continue
    }
    for (const edge of outgoing) {
      if (seen.has(edge.to)) continue
      seen.add(edge.to)
      frontier.push(edge.to)
    }
  }
  return (
    `The declared chain stalls at ${stalls.map((identity) => `'${identity}'`).join(", ")} without reaching ` +
    "the target; declare the missing edge from there"
  )
}

function checkpointMigrationPath<State extends object, Commands extends CommandTree, Features extends object>(
  definition: YrdDef<State, Commands, Features>,
  from: string,
  target: string,
): readonly ResolvedCheckpointMigration<State>[] {
  const edges = definition[checkpointMigrations].map((migration) => ({
    ...migration,
    to: migration.to ?? target,
  }))
  const paths: ResolvedCheckpointMigration<State>[][] = []
  let cycle = false
  const visit = (
    identity: string,
    path: readonly ResolvedCheckpointMigration<State>[],
    seen: ReadonlySet<string>,
  ): void => {
    if (identity === target) {
      paths.push([...path])
      return
    }
    for (const edge of edges.filter((candidate) => candidate.from === identity)) {
      if (seen.has(edge.to)) {
        cycle = true
        continue
      }
      visit(edge.to, [...path, edge], new Set([...seen, edge.to]))
    }
  }
  visit(from, [], new Set([from]))
  if (cycle) {
    raiseFailure(
      "configuration",
      "checkpoint-migration-cyclic",
      `yrd: checkpoint migration graph reachable from '${from}' contains a cycle`,
    )
  }
  if (paths.length === 0) {
    raiseFailure(
      "configuration",
      "checkpoint-migration-missing",
      `yrd: no checkpoint migration path exists from '${from}' to '${target}'`,
    )
  }
  if (paths.length > 1) {
    raiseFailure(
      "configuration",
      "checkpoint-migration-ambiguous",
      `yrd: ${paths.length} checkpoint migration paths exist from '${from}' to '${target}'`,
    )
  }
  return paths[0] ?? []
}

function migrateProjectionCheckpoint<State extends object, Commands extends CommandTree, Features extends object>(
  definition: YrdDef<State, Commands, Features>,
  checkpoint: JournalCheckpoint,
  target: string,
): JournalCheckpoint {
  const parsed = ProjectionCheckpointSchema.parse(checkpoint.value)
  let state = globalThis.structuredClone(parsed.state) as DeepReadonly<State>
  for (const migration of checkpointMigrationPath(definition, checkpoint.identity, target)) {
    try {
      state = migration.migrate(freeze(state as State)) as DeepReadonly<State>
      assertCheckpointState(state)
    } catch (error) {
      raiseFailure(
        "configuration",
        "checkpoint-migration-failed",
        `yrd: checkpoint migration '${migration.from}' -> '${migration.to}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  definition.validate(state)
  return {
    identity: target,
    cursor: checkpoint.cursor,
    value: { ...parsed, state },
  }
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

/** Diagnostic path for `assertCheckpointState`, built only on the failing node. */
function checkpointStatePath(trail: readonly (string | number)[]): string {
  let path = "$state"
  for (const segment of trail) path += typeof segment === "number" ? `[${segment}]` : `.${segment}`
  return path
}

/**
 * Restore's counterpart to `projectionCheckpointState`: the same JSON-shape
 * contract, asserted over the graph a checkpoint store already handed us
 * instead of rebuilt into a second one. Restored state always arrives freshly
 * materialized — `JSON.parse` in the SQLite store, `structuredClone` in an
 * in-memory one — so the rebuild produced a structurally identical graph and
 * only doubled restore's peak allocation. Results in the same envelope already
 * take this route through `parseCheckpointFrame`.
 *
 * Every allocation on the success path is load-bearing, because Bun's allocator
 * never returns freed pages to the OS: a walk's transient garbage raises the
 * process high-water mark exactly as durably as a retained graph does. Hence
 * the index loops over `Object.keys` rather than `Object.entries`/`.entries()`,
 * which materialize a pair array per node, and the `trail` of raw segments
 * rather than a per-node concatenated path string. Measured on a 26.73 MB
 * checkpoint (18.67 MB state graph): rebuild +101.8 MB, in-place walk building
 * per-node path strings +102.2 MB — no gain at all — in-place walk with this
 * deferred path +33.9 MB.
 *
 * Divergence from the rebuild, deliberate: an `undefined` object value is
 * refused here rather than dropped. The save path strips those before the
 * checkpoint is written, so a stored one cannot carry any; refusing routes the
 * unreachable case to `loadProjection`'s journal rebuild instead of silently
 * reshaping restored state, and matches `checkpointJson` on the result half.
 */
function assertCheckpointState(value: unknown, trail: (string | number)[] = []): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(
        `yrd: projection checkpoint state '${checkpointStatePath(trail)}' must be a finite JSON number`,
      )
    }
    return
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index]
      trail.push(index)
      if (entry === undefined) {
        throw new TypeError(`yrd: projection checkpoint state '${checkpointStatePath(trail)}' must not be undefined`)
      }
      assertCheckpointState(entry, trail)
      trail.pop()
    }
    return
  }
  if (typeof value !== "object") {
    throw new TypeError(`yrd: projection checkpoint state '${checkpointStatePath(trail)}' is not JSON-compatible`)
  }
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`yrd: projection checkpoint state '${checkpointStatePath(trail)}' must be a plain object`)
  }
  const symbols = Object.getOwnPropertySymbols(value)
  if (symbols.length > 0 && symbols.some((key) => Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new TypeError(
      `yrd: projection checkpoint state '${checkpointStatePath(trail)}' must not contain enumerable symbol keys`,
    )
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const entry: unknown = record[key]
    trail.push(key)
    if (entry === undefined) {
      throw new TypeError(`yrd: projection checkpoint state '${checkpointStatePath(trail)}' must not be undefined`)
    }
    assertCheckpointState(entry, trail)
    trail.pop()
  }
}

/**
 * Checkpoint bytes are independently checksummed and bound to the complete
 * projector identity. Validate the frame envelope and command/cause binding
 * here without repeating replay's full Zod clone for every already-validated
 * result. Semantic checks still share the canonical command-hash and event
 * timestamp validators used by the authoritative journal path.
 */
function parseCheckpointFrame(value: unknown, commandHashes: Map<string, string>): JournalFrame {
  if (!plainRecord(value) || !plainRecord(value.command) || !plainRecord(value.cause) || !Array.isArray(value.events)) {
    throw new Error("checkpoint contains an invalid journal frame")
  }
  const compatibility = assertJournalReaderCompatibility(value)
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
    !exactKeys(value, ["cause", "command", "events", "value", "compatibility"])
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
  // paying for a second recursive walk over the same result.
  for (const node of jsonPostorder) Object.freeze(node)
  Object.freeze(command)
  Object.freeze(cause)
  if (compatibility !== undefined && plainRecord(value.compatibility)) Object.freeze(value.compatibility)
  for (const applied of value.events) Object.freeze(applied)
  Object.freeze(value.events)
  return Object.freeze(value) as JournalFrame
}

/**
 * Read the applied events out of a journal frame without re-parsing the frame.
 *
 * `events()` yields events, not frames: it never surfaces `cause`, `command`,
 * `value`, or `compatibility`. Running the full `parseJournalFrame` Zod clone
 * over every frame therefore validates fields the caller cannot observe, and it
 * does so on top of validation that already happened — `Journal.read`
 * implementations parse each frame before yielding it (the SQLite journal in
 * `decodeStoredEvent`), and every frame this generator can reach has already
 * been folded through `parseJournalFrame` by `refresh()` or by the process that
 * wrote the checkpoint. Measured on a 45.6k-frame / 43.6k-event journal, the
 * duplicate parse was 785ms of the 2322ms `yrd queue list` spent inside
 * `events()`.
 *
 * What callers receive is still fully validated, and more strictly than the
 * frame parse validated it: `canonicalEvent` parses each `data` against that
 * event's own schema (or its replay schema) and then re-parses the whole event
 * through the strict `EventSchema`. The one frame-level gate with no per-event
 * equivalent is the journal reader-version refusal, so `events()` keeps calling
 * `assertJournalReaderCompatibility` — an O(1) field check, 9ms across the same
 * 45.6k frames. This mirrors `parseCheckpointFrame`, which already trades the
 * full Zod clone for targeted checks on already-validated results.
 *
 * A malformed value still fails loud here rather than yielding partial events.
 */
function journalFrameEvents(value: unknown): readonly Event[] {
  if (!plainRecord(value) || !Array.isArray(value.events)) {
    throw new Error("yrd: journal frame is missing its events array")
  }
  return value.events as readonly Event[]
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
