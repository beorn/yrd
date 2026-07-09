import { randomUUID } from "node:crypto"
import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  BayStore,
  Cause,
  Effect,
  GitbayEvent,
  Layer,
  TransitionResult,
} from "./types.ts"

/** Production ids must remain unique across short-lived CLI processes.
 *  Deterministic tests inject their own source through createGitbay(). */
function makeDefaultIdGen(): () => string {
  return () => randomUUID()
}

/**
 * createGitbay — the era2 core (spec § How it's built; v0.3 rename — "bay" now
 * names the loan a with*() layer hands out, not the system itself, so
 * `createBay` read as "create a workspace" when it actually creates the whole
 * merge-queue system. The broader `Bay*` type names — BayState, BayEvent,
 * BayRuntime, etc. — are unchanged this pass; only the factory is renamed).
 *
 * A zero-plugin bay is almost nothing: an empty journal, an empty state
 * projection, no verbs. Every capability is a with*() layer registering
 * commands (via reduce), event types (via apply), a state slice, and
 * effect handlers. Layers compose middleware-style: layer N's reduce wraps
 * layer N+1's via next(); the interlock rule (a layer consumes only events
 * and state of layers below, never internals) is enforced by shape — there
 * is nothing else to reach.
 */
export function createGitbay(opts: {
  store: BayStore
  actor?: string
  clock?: () => string
  idGen?: () => string
}): BayRuntime {
  const layers: Layer[] = []
  const clock = opts.clock ?? (() => new Date().toISOString())
  const actor = opts.actor ?? "bay"
  const idGen = opts.idGen ?? makeDefaultIdGen()

  let folded: BayState | null = null // lazy replay cache; invalidated never (append-only)

  function emptyState(): BayState {
    return { leases: {}, prs: {}, slices: {} }
  }

  function applyEvent(state: BayState, event: BayEvent): BayState {
    let out = state
    for (const layer of layers) {
      if (layer.apply) out = layer.apply(out, event)
    }
    return out
  }

  async function fold(): Promise<BayState> {
    if (folded) return folded
    let state = emptyState()
    for await (const event of runtime.store.journal.replay()) {
      state = applyEvent(state, event)
    }
    folded = state
    return state
  }

  function reduceThroughLayers(state: BayState, command: BayCommand): TransitionResult {
    // Build the middleware chain bottom-up; innermost = "unknown verb" refusal.
    let chain = (s: BayState, c: BayCommand): TransitionResult => {
      throw new Error(
        `bay: unknown command '${c.type}' — no layer handles it. ` +
          `Registered layers: ${layers.map((l) => l.name).join(", ") || "(none)"}.`,
      )
    }
    for (const layer of [...layers].reverse()) {
      if (!layer.reduce) continue
      const next = chain
      const reduce = layer.reduce
      chain = (s, c) => reduce(s, c, next)
    }
    return chain(state, command)
  }

  function handlerFor(effect: Effect) {
    const handler = layers.map((l) => l.effects?.[effect.type]).find(Boolean)
    if (!handler) {
      throw new Error(`bay: no handler for effect '${effect.type}' — a layer emitted it but none executes it.`)
    }
    return handler
  }

  const runtime: BayRuntime = {
    get layers() {
      return layers
    },
    store: opts.store,
    clock,
    actor,
    idGen,

    use(layer: Layer): BayRuntime {
      if (layers.some((l) => l.name === layer.name)) {
        throw new Error(`bay: layer '${layer.name}' registered twice`)
      }
      layers.push(layer)
      folded = null // layer.apply changes the fold; re-replay on next read
      return runtime
    },

    state: fold,

    async dispatch(command: BayCommand): Promise<{ events: BayEvent[] }> {
      // Every command gets its cause at the door (docs/events.md § Cause and
      // spans) — minted here unless the caller (a host reading TRACEPARENT)
      // already supplied one. Every event this dispatch produces, from the
      // reducer AND from its effects, carries the SAME cause.
      const cause: Cause = {
        commandId: idGen(),
        ...(command.cause?.traceId === undefined ? {} : { traceId: command.cause.traceId }),
        ...(command.cause?.spanId === undefined ? {} : { spanId: command.cause.spanId }),
      }
      const stamped: BayCommand = { ...command, cause }

      const state = await fold()
      const { state: nextState, events, effects } = reduceThroughLayers(state, stamped)
      if (nextState !== state) {
        throw new Error("bay: reducer state changes must be represented by events and folded by apply()")
      }
      const causedEffects = effects.map((e) => ({ ...e, cause }))
      // Journal-first: events are durable before effects run (crash-safe resume).
      for (const event of events) await runtime.store.journal.append(event)
      folded = events.reduce(applyEvent, state)
      // Each effect's events are journaled AND folded before the next effect
      // runs, so a later effect observes an earlier effect's facts through
      // state() — e.g. batch settle reading the merge effect's landed verdict
      // in the same dispatch. Journal order is unchanged (production order),
      // and crash safety is unchanged: everything already produced is durable
      // before the next step executes.
      const effectEvents: BayEvent[] = []
      for (const effect of causedEffects) {
        const produced = await handlerFor(effect)(effect, runtime)
        for (const event of produced) await runtime.store.journal.append(event)
        folded = produced.reduce(applyEvent, folded)
        effectEvents.push(...produced)
      }
      return { events: [...events, ...effectEvents] }
    },
  }

  return runtime
}

/** Helper for layers: build a fully-formed v2 event — `{id, name, ts, cause,
 *  data}` — from the runtime's injected clock/idGen and the typed union
 *  (GitbayEvent), so a call site can't misspell a name or drop a required
 *  field. `cause` comes from the current command (a reducer reads it off
 *  `command.cause`) or the current effect (`effect.cause`) — never minted
 *  here, so every event a dispatch produces shares one cause. */
export function makeEvent<Name extends GitbayEvent["name"]>(
  bay: BayRuntime,
  name: Name,
  data: Extract<GitbayEvent, { name: Name }>["data"],
  cause: Cause,
): BayEvent {
  return { id: bay.idGen(), ts: bay.clock(), name, cause, data }
}

/** Identity plugin shape — with*() factories return (bay) => bay. */
export function definePlugin(layer: Layer): BayPlugin {
  return (bay) => bay.use(layer)
}
