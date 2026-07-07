import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  ChangeId,
  Changeset,
  ChangesetState,
  Layer,
  TransitionResult,
  WorkitemId,
} from "../types.ts"
import { makeEvent } from "../core.ts"

/**
 * withQueue — the changeset queue layer (spec § How it's built, the withReceive
 * row's queue slice; M1-a slice of @hab/20926-gitbay). It is pure bookkeeping
 * over the core journal: it owns the changeset state machine and the FIFO order,
 * and it emits NO effects — enqueue/requeue only append events. The merge worker
 * (a layer above) drives the merging transitions and the I/O.
 *
 * Interlock rule (spec): this layer consumes only core state (state.changesets)
 * and its own slice; it never reaches into a layer above. withMergeWorker builds
 * ON this layer — it reads queuedChangesets()/queueTarget() and emits transitions
 * this layer folds — but this layer knows nothing of it.
 *
 * Purity: the reducer is a pure (state, command) → [events, effects] function.
 * It NEVER touches git, the filesystem, config, Math.random, or Date.now. The
 * change-id (when not supplied) is a deterministic hash of (clock, actor, seq,
 * target), mirroring withWorkspaces' mintChangeId — see the duplication note.
 */

// ---------- the changeset state machine ----------

/** Legal transitions. Exhaustive over ChangesetState so a new state can't be
 *  added without deciding its edges. queued→merging is direct in M1 (no checks
 *  layer yet); checking/reviewing are the guarded rungs a later with*() adds.
 *  merging/rejected → queued is the requeue/resume edge (crash recovery). abandon
 *  (merging/... → abandoned) lands in M2 with withWorkspaces' abandon, so no M1-a
 *  path produces `abandoned` yet — it is a terminal state with no producer here. */
const TRANSITIONS: Record<ChangesetState, ChangesetState[]> = {
  queued: ["checking", "merging"],
  checking: ["merging", "rejected"],
  reviewing: ["merging", "rejected"],
  merging: ["merged", "rejected", "queued"],
  rejected: ["queued"],
  merged: [],
  abandoned: [],
}

/** Fail-loud transition guard. Called in the REDUCER path (before any event is
 *  journaled), never only in apply: the era2 core journals events BEFORE folding
 *  (core.ts dispatch), so a throw in apply would fire AFTER the bad event is
 *  already durable. Validating here refuses the illegal transition at the door,
 *  so nothing bad is ever written — it does not silently overwrite. */
export function assertTransition(from: ChangesetState, to: ChangesetState): void {
  const allowed = TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new Error(
      `bay: illegal changeset transition ${from} → ${to} ` +
        `(allowed from ${from}: ${allowed.join(", ") || "(none — terminal)"}). ` +
        `Refusing to overwrite state.`,
    )
  }
}

// ---------- slice ----------

const LAYER = "queue"
const EV_ENQUEUED = "changeset.enqueued"
const EV_STATE_CHANGED = "changeset.state-changed"

/** FIFO order (append on enqueue) + the merge target per changeset. The target
 *  (a branch name or SHA to merge) has no home on the core Changeset type, so
 *  this slice is its authoritative store. */
export type QueueSlice = {
  order: ChangeId[]
  targets: Record<ChangeId, string>
}

function emptySlice(): QueueSlice {
  return { order: [], targets: {} }
}

function sliceOf(state: BayState): QueueSlice {
  return (state.slices[LAYER] as QueueSlice | undefined) ?? emptySlice()
}

// ---------- pure query helpers (the layer's published read API) ----------

/** Changesets currently in `queued` state, FIFO by enqueue order. The merge
 *  worker drains queued[0] (the oldest). A requeued changeset keeps its original
 *  order position → resume-first fairness (finish the interrupted one first). */
export function queuedChangesets(state: BayState): Changeset[] {
  const slice = sliceOf(state)
  const out: Changeset[] = []
  for (const id of slice.order) {
    const cs = state.changesets[id]
    if (cs && cs.state === "queued") out.push(cs)
  }
  return out
}

/** The merge target (branch/SHA) recorded for a changeset at enqueue. Throws if
 *  unknown — a changeset with no target is a bug, not an empty default
 *  (principles § Fail Loud, Fail Now). */
export function queueTarget(state: BayState, changeset: ChangeId): string {
  const target = sliceOf(state).targets[changeset]
  if (target === undefined) {
    throw new Error(`bay: queue: no merge target recorded for changeset '${changeset}'`)
  }
  return target
}

// ---------- deterministic change-id mint (mirrors withWorkspaces) ----------

// NOTE: fnv1a/mintChangeId duplicate withWorkspaces' private helpers. They are a
// second consumer, so the house rule ("extract on the second consumer") applies —
// but this slice may only edit queue.ts (workspaces.ts is frozen for M1-a), so the
// shared `ids.ts` extraction is deferred to when workspaces can be touched.
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** Deterministic given (clock, actor, seq, target). `seq` (total changesets ever
 *  enqueued) keeps ids unique under a fixed clock; `target` disambiguates two
 *  enqueues at the same tick. */
function mintChangeId(ts: string, actor: string, seq: number, target: string): ChangeId {
  return `C-${fnv1a(`${ts}:${actor}:${seq}:${target}`)}`
}

// ---------- shared state-changed event builder (validated) ----------

/** Build a validated `changeset.state-changed` event. Both the queue's requeue
 *  reducer and the merge worker's effect handler go through this, so every
 *  transition — wherever it originates — passes assertTransition BEFORE the event
 *  exists (fail-loud before journaling). */
export function stateChangeEvent(
  bay: BayRuntime,
  changeset: ChangeId,
  from: ChangesetState,
  to: ChangesetState,
  detail?: string,
): BayEvent {
  assertTransition(from, to)
  const data: Record<string, unknown> = { changeset, from, to }
  if (detail !== undefined) data.detail = detail
  return makeEvent(bay, EV_STATE_CHANGED, data, { changeset })
}

// ---------- reducers (pure) ----------

function reduceEnqueue(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const rawTarget = command.args?.target
  if (typeof rawTarget !== "string" || rawTarget.trim() === "") {
    throw new Error("bay: enqueue: 'target' (a branch name or SHA to merge) is required")
  }
  const target = rawTarget

  const rawWorkitem = command.args?.workitem
  if (rawWorkitem !== undefined && (typeof rawWorkitem !== "string" || rawWorkitem.trim() === "")) {
    throw new Error("bay: enqueue: 'workitem' must be a non-empty string when provided")
  }
  const workitem: WorkitemId | null = typeof rawWorkitem === "string" ? rawWorkitem : null

  const rawChangeId = command.args?.changeId
  if (rawChangeId !== undefined && (typeof rawChangeId !== "string" || rawChangeId.trim() === "")) {
    throw new Error("bay: enqueue: 'changeId' must be a non-empty string when provided")
  }

  const ts = bay.clock()
  const seq = Object.keys(state.changesets).length + 1
  const changeId: ChangeId =
    typeof rawChangeId === "string" ? rawChangeId : mintChangeId(ts, bay.actor, seq, target)

  if (state.changesets[changeId]) {
    throw new Error(`bay: enqueue: changeset '${changeId}' already exists — change-ids are unique`)
  }

  // Build the event literal directly (not makeEvent) so the single `ts` used for
  // the mint is the same one stamped on the event — mirrors withWorkspaces.reduceCo.
  const enqueued: BayEvent = {
    v: 1,
    ts,
    actor: bay.actor,
    type: EV_ENQUEUED,
    changeset: changeId,
    data: { changeset: changeId, target, workitem },
  }
  return { state, events: [enqueued], effects: [] }
}

function reduceRequeue(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const changeset = command.args?.changeset
  if (typeof changeset !== "string" || changeset === "") {
    throw new Error("bay: requeue: 'changeset' (a change-id) is required")
  }
  const cs = state.changesets[changeset]
  if (!cs) {
    throw new Error(`bay: requeue: no changeset '${changeset}' — nothing to requeue`)
  }
  // stateChangeEvent validates cs.state → queued: legal only from merging (resume)
  // or rejected (retry); anything else (queued/checking/merged) throws.
  const event = stateChangeEvent(bay, changeset, cs.state, "queued")
  return { state, events: [event], effects: [] }
}

// ---------- apply (pure fold; runs on live dispatch AND replay) ----------

function apply(state: BayState, event: BayEvent): BayState {
  switch (event.type) {
    case EV_ENQUEUED: {
      const d = event.data as { changeset: ChangeId; target: string; workitem: WorkitemId | null }
      const slice = sliceOf(state)
      const changeset: Changeset = {
        id: d.changeset,
        workitem: d.workitem,
        lease: "", // M1-a: enqueued targets are not necessarily bound to a lease
        revision: 1,
        repos: [], // M1-a: cross-repo structure resolved later; `target` is the merge locator
        state: "queued",
      }
      return {
        ...state,
        changesets: { ...state.changesets, [d.changeset]: changeset },
        slices: {
          ...state.slices,
          [LAYER]: {
            order: [...slice.order, d.changeset],
            targets: { ...slice.targets, [d.changeset]: d.target },
          },
        },
      }
    }

    case EV_STATE_CHANGED: {
      // Transition legality was already enforced in the reducer (assertTransition,
      // before this event was journaled), so apply trusts a journaled event and
      // folds it — this is what makes replay of valid history never throw.
      const d = event.data as { changeset: ChangeId; from: ChangesetState; to: ChangesetState }
      const existing = state.changesets[d.changeset]
      if (!existing) return state // state-changed for an unknown changeset: ignore, don't fabricate
      return {
        ...state,
        changesets: { ...state.changesets, [d.changeset]: { ...existing, state: d.to } },
      }
    }

    default:
      return state
  }
}

// ---------- the plugin ----------

/**
 * Built inside the plugin closure (same reason as withWorkspaces): the reducer
 * needs the runtime's injected clock/actor to timestamp and mint
 * deterministically, but the `Reducer` contract `(state, command, next)` passes
 * no runtime. `bay.use(layer)` is exactly what `definePlugin(layer)(bay)` does;
 * we inline it because the layer must close over `bay`.
 */
export function withQueue(): BayPlugin {
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      apply,
      reduce(state, command, next) {
        if (command.type === "enqueue") return reduceEnqueue(bay, state, command)
        if (command.type === "requeue") return reduceRequeue(bay, state, command)
        return next(state, command)
      },
    }
    return bay.use(layer)
  }
}
