import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  BayStore,
  Effect,
  Layer,
  TransitionResult,
} from "./types.ts"

/**
 * createBay — the era2 core (spec § How it's built).
 *
 * A zero-plugin bay is almost nothing: an empty journal, an empty state
 * projection, no verbs. Every capability is a with*() layer registering
 * commands (via reduce), event types (via apply), a state slice, and
 * effect handlers. Layers compose middleware-style: layer N's reduce wraps
 * layer N+1's via next(); the interlock rule (a layer consumes only events
 * and state of layers below, never internals) is enforced by shape — there
 * is nothing else to reach.
 */
export function createBay(opts: {
  store: BayStore
  actor?: string
  clock?: () => string
}): BayRuntime {
  const layers: Layer[] = []
  const clock = opts.clock ?? (() => new Date().toISOString())
  const actor = opts.actor ?? "bay"

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

  async function runEffects(effects: Effect[]): Promise<BayEvent[]> {
    const produced: BayEvent[] = []
    for (const effect of effects) {
      const handler = layers.map((l) => l.effects?.[effect.type]).find(Boolean)
      if (!handler) {
        throw new Error(
          `bay: no handler for effect '${effect.type}' — a layer emitted it but none executes it.`,
        )
      }
      produced.push(...(await handler(effect, runtime)))
    }
    return produced
  }

  const runtime: BayRuntime = {
    get layers() {
      return layers
    },
    store: opts.store,
    clock,
    actor,

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
      const state = await fold()
      const { state: nextState, events, effects } = reduceThroughLayers(state, command)
      // Journal-first: events are durable before effects run (crash-safe resume).
      for (const event of events) await runtime.store.journal.append(event)
      folded = events.reduce(applyEvent, nextState)
      const effectEvents = await runEffects(effects)
      for (const event of effectEvents) await runtime.store.journal.append(event)
      folded = effectEvents.reduce(applyEvent, folded)
      return { events: [...events, ...effectEvents] }
    },
  }

  return runtime
}

/** Helper for layers: build a timestamped event with the runtime's clock/actor. */
export function makeEvent(
  bay: BayRuntime,
  type: string,
  data?: BayEvent["data"],
  refs?: { pr?: string; lease?: string },
): BayEvent {
  return { v: 1, ts: bay.clock(), actor: bay.actor, type, data, ...refs }
}

/** Identity plugin shape — with*() factories return (bay) => bay. */
export function definePlugin(layer: Layer): BayPlugin {
  return (bay) => bay.use(layer)
}
