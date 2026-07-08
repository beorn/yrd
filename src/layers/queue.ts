import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  Cause,
  Layer,
  PrId,
  PrState,
  PullRequest,
  RejectionCode,
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
 * this layer — it reads submittedPrs()/integratablePrs()/queueTarget() and
 * emits transitions this layer folds — but this layer knows nothing of it.
 *
 * Purity: the reducer is a pure (state, command) → [events, effects] function.
 * It NEVER touches git, the filesystem, config, Math.random, or Date.now. The
 * PR id (when not supplied) is the sequential mint in ids.ts, derived from
 * folded state.
 */

// ---------- the PR state machine ----------

/** Legal transitions (docs/model.md § Phases). Exhaustive over PrState so a
 *  new state can't be added without deciding its edges. `pushed` is where
 *  every PR is born (a plain `git push`); `pushed → submitted` is `submit`
 *  (or a fused push). `submitted → checking → checked | rejected` is `check`;
 *  `checked → merging → merged | rejected` is `merge`; `integrate` walks both
 *  in one dispatch. `rejected → submitted` is `retry` (re-run from the top —
 *  a stale `checked` verdict is not trusted after a fix). `merging →
 *  submitted` is the crash-resume edge (`retry` after a restart finds a PR
 *  stuck `merging`; re-run the whole pipeline rather than trust a half-landed
 *  merge). `pushed|submitted|checked|rejected → closed` is `close --withdraw`
 *  (docs/model.md § Phases: "pushed/submitted/checked → closed", and
 *  `rejected` joins them — see the verbs table's `retry <PR>: rejected → …,
 *  or close gives up"). `checking`/`merging` are NOT withdrawable — an effect
 *  may already be in flight for them; wait for the verdict, then retry or
 *  withdraw. `reviewing` is reserved for the v0.5 review gate (unreachable
 *  today; shaped like `checking` so the gate slots in without a TRANSITIONS
 *  rework). */
const TRANSITIONS: Record<PrState, PrState[]> = {
  pushed: ["submitted", "closed"],
  submitted: ["checking", "closed"],
  checking: ["checked", "rejected"],
  checked: ["merging", "closed"],
  reviewing: ["merging", "rejected", "closed"],
  merging: ["merged", "rejected", "submitted"],
  rejected: ["submitted", "closed"],
  merged: [],
  closed: [],
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
const EV_OPENED = "pr/opened"
const EV_CHANGED = "pr/changed"

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

/** PRs currently in `submitted` state, FIFO by enqueue order — the ones
 *  waiting for `check` (or `integrate`) to pick them up. A retried PR keeps
 *  its original order position → resume-first fairness (finish the
 *  interrupted one first). */
export function submittedPrs(state: BayState): PullRequest[] {
  const slice = sliceOf(state)
  const out: PullRequest[] = []
  for (const id of slice.order) {
    const pr = state.prs[id]
    if (pr && pr.state === "submitted") out.push(pr)
  }
  return out
}

/** PRs `integrate` can act on with no explicit target — `submitted` (needs
 *  check then merge) or `checked` (needs merge only, e.g. resuming after a
 *  standalone `check` stopped there) — FIFO by enqueue order, the two states
 *  interleaved in original order. `integrate` (no PR named) auto-picks the
 *  oldest of these; anything else (checking, merging, rejected, merged,
 *  closed) needs `retry`, `merge`, or a named `integrate`/`check` first. */
export function integratablePrs(state: BayState): PullRequest[] {
  const slice = sliceOf(state)
  const out: PullRequest[] = []
  for (const id of slice.order) {
    const pr = state.prs[id]
    if (pr && (pr.state === "submitted" || pr.state === "checked")) out.push(pr)
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

export type StateChangeOpts = {
  detail?: string
  revision?: number
  /** Required whenever `to === "rejected"` — a rejection with no machine-
   *  readable reason can never be counted by a later `stats` fold (docs/events.md
   *  § event families: "building a rejection without a code throws"). */
  code?: RejectionCode
}

/** Build a validated `pr/changed` event. Every caller — the queue's requeue
 *  reducer, the receiver's submit pipeline, the merge worker's effect handler —
 *  goes through this, so every transition passes assertTransition BEFORE the
 *  event exists (fail-loud before journaling), and every rejection carries a
 *  code before it can be journaled at all. */
export function stateChangeEvent(
  bay: BayRuntime,
  pr: PrId,
  from: PrState,
  to: PrState,
  cause: Cause,
  opts: StateChangeOpts = {},
): BayEvent {
  assertTransition(from, to)
  if (to === "rejected" && opts.code === undefined) {
    throw new Error(`bay: refusing to build ${pr} rejected without a 'code' — every rejection must be countable`)
  }
  return makeEvent(
    bay,
    EV_CHANGED,
    { pr, from, to, ...(opts.revision !== undefined ? { revision: opts.revision } : {}), ...(opts.code !== undefined ? { code: opts.code } : {}), ...(opts.detail !== undefined ? { detail: opts.detail } : {}) },
    cause,
  )
}

/** Build a `pr/opened` event for layers ABOVE the queue (e.g. the receiver's
 *  submit pipeline) — events are the composition contract: a higher layer emits
 *  them, this layer folds them, exactly like stateChangeEvent. `via` records
 *  where the PR came from: "push" (a worktree's plain git push, correlated to
 *  a bay) or "submit" (the explicit `adopt <branch>` verb — this absorbs what
 *  v0.2 recorded as a separate `adopt.recorded` row). `queued`: true iff this
 *  creation is FUSED with an immediate ask-to-merge (`bay.autoSubmit`, a
 *  forcing `-o submit`/`-o wait` push, or legacy `bay.autoQueue`) — the fold
 *  plants the PR straight into `submitted` rather than `pushed` when true.
 *  Whether it then ALSO runs the check/merge pipeline immediately is a
 *  separate decision (`bay.autoMerge`) the receiver's submit path makes, not
 *  recorded on this event. Callers must have checked
 *  uniqueness against state.prs (fail-loud duplicate-id rule lives in
 *  reduceEnqueue; builders don't see state). */
export function prOpenedEvent(
  bay: BayRuntime,
  pr: PrId,
  target: string,
  name: WorkitemId | null,
  via: "push" | "submit",
  queued: boolean,
  cause: Cause,
): BayEvent {
  return makeEvent(bay, EV_OPENED, { pr, target, workName: name, via, queued }, cause)
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

  // `enqueue` is the raw low-level "put it directly in the queue" primitive
  // (distinct from the user-facing `adopt`, which lands in `pushed`) — always
  // queued:true, so it keeps creating PRs directly in `submitted`.
  return { state, events: [prOpenedEvent(bay, prId, target, name, "submit", true, command.cause!)], effects: [] }
}

/** The crash-resume primitive behind `retry` on a PR stuck `merging` (a
 *  restart found the merge effect never finished — see TRANSITIONS' comment
 *  on the `merging → submitted` edge): back to `submitted` so `integrate`
 *  re-runs the WHOLE pipeline rather than trust a half-landed merge.
 *  stateChangeEvent validates existing.state → submitted: legal only from
 *  merging (resume) or rejected (retry); anything else throws. */
function reduceRequeue(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const pr = command.args?.pr
  if (typeof pr !== "string" || pr === "") {
    throw new Error("bay: retry: 'pr' (a PR number) is required")
  }
  const existing = state.prs[pr]
  if (!existing) {
    throw new Error(`bay: retry: no PR '${pr}' — nothing to retry`)
  }
  const event = stateChangeEvent(bay, pr, existing.state, "submitted", command.cause!)
  return { state, events: [event], effects: [] }
}

/** `submit` (ask to merge): pushed → submitted on an ALREADY-existing PR.
 *  Refuses with a teaching message naming the right verb for every other
 *  state (merged/closed are terminal; submitted/checking/checked/merging are
 *  already in flight; rejected wants `retry`, not `submit`). The CLI follows
 *  this with an `integrate` targeted at the same PR — submitting is what
 *  starts the check/merge pipeline (docs/model.md § Verbs: "submit … Never
 *  merges"), so both this verb and a fused `-o submit` push converge on the
 *  identical downstream behavior. */
function reduceQueue(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const pr = command.args?.pr
  if (typeof pr !== "string" || pr === "") {
    throw new Error("bay: submit: 'pr' (a PR number or name) is required")
  }
  const existing = state.prs[pr]
  if (!existing) {
    throw new Error(`bay: submit: no PR '${pr}' — git bay ls lists them`)
  }
  if (
    existing.state === "submitted" ||
    existing.state === "checking" ||
    existing.state === "checked" ||
    existing.state === "merging"
  ) {
    throw new Error(`bay: submit: ${pr} is already ${existing.state} — git bay ls ${pr}`)
  }
  if (existing.state === "merged") {
    throw new Error(`bay: submit: ${pr} is already merged — nothing to submit`)
  }
  if (existing.state === "rejected") {
    throw new Error(`bay: submit: ${pr} was rejected — put it back in the queue with git bay retry ${pr}`)
  }
  if (existing.state === "closed") {
    throw new Error(`bay: submit: ${pr} was withdrawn — start the next piece of work: git bay open <name>`)
  }
  if (existing.state !== "pushed") {
    // "reviewing" — legal per the type, unreachable today (review-gate is v0.5).
    // stateChangeEvent's assertTransition throws the generic illegal-transition
    // error rather than a hand-written teaching message for a state nothing
    // can produce yet.
    const event = stateChangeEvent(bay, pr, existing.state, "submitted", command.cause!)
    return { state, events: [event], effects: [] }
  }
  const event = stateChangeEvent(bay, pr, "pushed", "submitted", command.cause!)
  return { state, events: [event], effects: [] }
}

// ---------- apply (pure fold; runs on live dispatch AND replay) ----------

function apply(state: BayState, event: BayEvent): BayState {
  switch (event.name) {
    case EV_OPENED: {
      const d = event.data as { pr: PrId; target: string; workName: WorkitemId | null; queued: boolean }
      const slice = sliceOf(state)
      const pr: PullRequest = {
        id: d.pr,
        name: d.workName,
        lease: "", // enqueued targets are not necessarily bound to a lease
        revision: 1,
        repos: [], // cross-repo structure resolved later; `target` is the merge locator
        state: d.queued ? "submitted" : "pushed", // born `pushed` unless fused with an immediate submit
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

    case EV_CHANGED: {
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
 * Built inside the plugin closure (same reason as withWorktrees): the reducer
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
        if (command.type === "queue") return reduceQueue(bay, state, command)
        return next(state, command)
      },
    }
    return bay.use(layer)
  }
}
