import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  Layer,
  PrId,
  PrState,
  PullRequest,
  TransitionResult,
  WorkitemId,
} from "../types.ts"
import { makeEvent } from "../core.ts"
import { nextPrId } from "../ids.ts"

/**
 * withQueue — the PR queue layer (spec § How it's built, the withReceive row's
 * queue slice; v0.1-a slice of @hab/20926-gitbay). It is pure bookkeeping over
 * the core journal: it owns the PR state machine and the FIFO order, and it
 * emits NO effects — enqueue/requeue only append events. The merge worker (a
 * layer above) drives the merging transitions and the I/O.
 *
 * Interlock rule (spec): this layer consumes only core state (state.prs) and
 * its own slice; it never reaches into a layer above. withMergeWorker builds ON
 * this layer — it reads queuedPrs()/queueTarget() and emits transitions this
 * layer folds — but this layer knows nothing of it.
 *
 * Purity: the reducer is a pure (state, command) → [events, effects] function.
 * It NEVER touches git, the filesystem, config, Math.random, or Date.now. The
 * PR id (when not supplied) is the sequential mint in ids.ts, derived from
 * folded state.
 */

// ---------- the PR state machine ----------

/** Legal transitions. Exhaustive over PrState so a new state can't be added
 *  without deciding its edges. queued→merging is direct in v0.1 (no checks
 *  layer yet); checking/reviewing are the guarded rungs a later with*() adds.
 *  merging/rejected → queued is the retry/resume edge (crash recovery). abandon
 *  (merging/... → abandoned) lands later with withWorkspaces' close, so no path
 *  produces `abandoned` yet — it is a terminal state with no producer here. */
const TRANSITIONS: Record<PrState, PrState[]> = {
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
export function assertTransition(from: PrState, to: PrState): void {
  const allowed = TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new Error(
      `bay: illegal PR transition ${from} → ${to} ` +
        `(allowed from ${from}: ${allowed.join(", ") || "(none — terminal)"}). ` +
        `Refusing to overwrite state.`,
    )
  }
}

// ---------- slice ----------

const LAYER = "queue"
const EV_OPENED = "pr.opened"
const EV_STATE_CHANGED = "pr.state-changed"

/** FIFO order (append on enqueue) + the merge target per PR. The target (a
 *  branch name or SHA to merge) has no home on the core PullRequest type, so
 *  this slice is its authoritative store. */
export type QueueSlice = {
  order: PrId[]
  targets: Record<PrId, string>
}

function emptySlice(): QueueSlice {
  return { order: [], targets: {} }
}

function sliceOf(state: BayState): QueueSlice {
  return (state.slices[LAYER] as QueueSlice | undefined) ?? emptySlice()
}

// ---------- pure query helpers (the layer's published read API) ----------

/** PRs currently in `queued` state, FIFO by enqueue order. The merge worker
 *  drains queued[0] (the oldest). A retried PR keeps its original order
 *  position → resume-first fairness (finish the interrupted one first). */
export function queuedPrs(state: BayState): PullRequest[] {
  const slice = sliceOf(state)
  const out: PullRequest[] = []
  for (const id of slice.order) {
    const pr = state.prs[id]
    if (pr && pr.state === "queued") out.push(pr)
  }
  return out
}

/** The PR already tracking `target` (a branch), if any — the reverse of
 *  queueTarget. The receiver's submit path uses this so a submitted branch's
 *  push becomes a revision of the tracking PR, never a duplicate. */
export function prForTarget(state: BayState, target: string): PrId | undefined {
  for (const [id, t] of Object.entries(sliceOf(state).targets)) {
    if (t === target) return id
  }
  return undefined
}

/** The merge target (branch/SHA) recorded for a PR at enqueue. Throws if
 *  unknown — a PR with no target is a bug, not an empty default
 *  (principles § Fail Loud, Fail Now). */
export function queueTarget(state: BayState, pr: PrId): string {
  const target = sliceOf(state).targets[pr]
  if (target === undefined) {
    throw new Error(`bay: queue: no merge target recorded for PR '${pr}'`)
  }
  return target
}

// ---------- shared state-changed event builder (validated) ----------

/** Build a validated `pr.state-changed` event. Both the queue's requeue reducer
 *  and the merge worker's effect handler go through this, so every transition —
 *  wherever it originates — passes assertTransition BEFORE the event exists
 *  (fail-loud before journaling). `revision` rides along when a re-push bumps
 *  it (same PR number, next revision). */
export function stateChangeEvent(
  bay: BayRuntime,
  pr: PrId,
  from: PrState,
  to: PrState,
  detail?: string,
  revision?: number,
): BayEvent {
  assertTransition(from, to)
  const data: Record<string, unknown> = { pr, from, to }
  if (detail !== undefined) data.detail = detail
  if (revision !== undefined) data.revision = revision
  return makeEvent(bay, EV_STATE_CHANGED, data, { pr })
}

/** Build a `pr.opened` event for layers ABOVE the queue (e.g. the receiver's
 *  submit pipeline) — events are the composition contract: a higher layer emits
 *  them, this layer folds them, exactly like stateChangeEvent. Callers must
 *  have checked uniqueness against state.prs (fail-loud duplicate-id rule lives
 *  in reduceEnqueue; builders don't see state). */
export function prOpenedEvent(
  bay: BayRuntime,
  pr: PrId,
  target: string,
  name: WorkitemId | null,
): BayEvent {
  return makeEvent(bay, EV_OPENED, { pr, target, name }, { pr })
}

// ---------- reducers (pure) ----------

function reduceEnqueue(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const rawTarget = command.args?.target
  if (typeof rawTarget !== "string" || rawTarget.trim() === "") {
    throw new Error("bay: submit: 'target' (a branch name or SHA to merge) is required")
  }
  const target = rawTarget

  const rawName = command.args?.name
  if (rawName !== undefined && (typeof rawName !== "string" || rawName.trim() === "")) {
    throw new Error("bay: submit: 'name' must be a non-empty string when provided")
  }
  const name: WorkitemId | null = typeof rawName === "string" ? rawName : null

  const rawPrId = command.args?.pr
  if (rawPrId !== undefined && (typeof rawPrId !== "string" || rawPrId.trim() === "")) {
    throw new Error("bay: submit: 'pr' must be a non-empty string when provided")
  }

  const prId: PrId = typeof rawPrId === "string" ? rawPrId : nextPrId(state)

  if (state.prs[prId]) {
    throw new Error(`bay: submit: PR '${prId}' already exists — PR numbers are unique`)
  }

  return { state, events: [prOpenedEvent(bay, prId, target, name)], effects: [] }
}

function reduceRequeue(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const pr = command.args?.pr
  if (typeof pr !== "string" || pr === "") {
    throw new Error("bay: retry: 'pr' (a PR number) is required")
  }
  const existing = state.prs[pr]
  if (!existing) {
    throw new Error(`bay: retry: no PR '${pr}' — nothing to retry`)
  }
  // stateChangeEvent validates existing.state → queued: legal only from merging
  // (resume) or rejected (retry); anything else (queued/checking/merged) throws.
  const event = stateChangeEvent(bay, pr, existing.state, "queued")
  return { state, events: [event], effects: [] }
}

// ---------- apply (pure fold; runs on live dispatch AND replay) ----------

function apply(state: BayState, event: BayEvent): BayState {
  switch (event.type) {
    case EV_OPENED: {
      const d = event.data as { pr: PrId; target: string; name: WorkitemId | null }
      const slice = sliceOf(state)
      const pr: PullRequest = {
        id: d.pr,
        name: d.name,
        lease: "", // enqueued targets are not necessarily bound to a lease
        revision: 1,
        repos: [], // cross-repo structure resolved later; `target` is the merge locator
        state: "queued",
      }
      return {
        ...state,
        prs: { ...state.prs, [d.pr]: pr },
        slices: {
          ...state.slices,
          [LAYER]: {
            order: [...slice.order, d.pr],
            targets: { ...slice.targets, [d.pr]: d.target },
          },
        },
      }
    }

    case EV_STATE_CHANGED: {
      // Transition legality was already enforced in the reducer (assertTransition,
      // before this event was journaled), so apply trusts a journaled event and
      // folds it — this is what makes replay of valid history never throw.
      const d = event.data as { pr: PrId; from: PrState; to: PrState; revision?: number }
      const existing = state.prs[d.pr]
      if (!existing) return state // state-changed for an unknown PR: ignore, don't fabricate
      return {
        ...state,
        prs: {
          ...state.prs,
          [d.pr]: {
            ...existing,
            state: d.to,
            ...(d.revision !== undefined ? { revision: d.revision } : {}),
          },
        },
      }
    }

    default:
      return state
  }
}

// ---------- the plugin ----------

/**
 * Built inside the plugin closure (same reason as withWorkspaces): the reducer
 * needs the runtime's injected clock/actor to timestamp events, but the
 * `Reducer` contract `(state, command, next)` passes no runtime. `bay.use(layer)`
 * is exactly what `definePlugin(layer)(bay)` does; we inline it because the
 * layer must close over `bay`.
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
