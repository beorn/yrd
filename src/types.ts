// bay domain types — the blueprint (principles: types show what exists).
// Core is era2-shaped: (command, state) → [events, effects]; state = fold(journal).

// ---------- identifiers ----------

export type PrId = string // sequential per repo (PR1, PR2, …); minted from folded state
export type LeaseId = string
export type WorkitemId = string // the NAME given at `new` — a ticket id or any label

// ---------- domain data ----------

export type Lease = {
  id: LeaseId
  workitem: WorkitemId | null
  path: string // worktree absolute path
  branch: string
  changeId: PrId
  createdAt: string // ISO; injected clock — never Date.now() in core
  actor?: string // who holds the loan (from the lease.opened event envelope)
  baseSha?: string // recorded at provision from the resolved base ref (spec § lease lifecycle)
  endedAt?: string
  endReason?: "merged" | "abandoned" | "expired"
}

export type RepoEntry = {
  repo: string // "." for superproject, else submodule path
  baseSha: string
  tipSha: string
  gitlink?: { from: string; to: string }
}

export type PrState =
  | "queued"
  | "checking"
  | "reviewing"
  | "merging"
  | "merged"
  | "rejected"
  | "abandoned"

export type PullRequest = {
  id: PrId
  name: WorkitemId | null
  lease: LeaseId
  revision: number // re-push after rejection = same id, next revision
  repos: RepoEntry[]
  state: PrState
}

// ---------- events (journal rows; additive-only, versioned) ----------

export type BayEvent = {
  v: 1
  ts: string
  actor: string
  type: string // layer-registered; consumers ignore unknown types
  pr?: PrId
  lease?: LeaseId
  data?: Record<string, unknown>
}

// ---------- commands + effects (serializable data, per tea.md) ----------

export type BayCommand = {
  type: string // layer-registered verb or internal op
  args?: Record<string, unknown>
}

export type Effect = {
  type: string // handled by whichever layer registered the handler
  data?: Record<string, unknown>
}

// ---------- state = fold(journal) ----------

export type BayState = {
  leases: Record<LeaseId, Lease>
  prs: Record<PrId, PullRequest>
  // layers may hang additional slices here, namespaced by layer name
  slices: Record<string, unknown>
}

// ---------- layer contract (what each with*() registers) ----------

/** Middleware reducer: (state, command, next) → [state, effects]. */
export type Reducer = (
  state: BayState,
  command: BayCommand,
  next: (state: BayState, command: BayCommand) => TransitionResult,
) => TransitionResult

export type TransitionResult = {
  state: BayState
  events: BayEvent[]
  effects: Effect[]
}

export type EffectHandler = (effect: Effect, bay: BayRuntime) => Promise<BayEvent[]>

export type Layer = {
  name: string
  /** Fold one event into state — pure; called on replay AND live dispatch. */
  apply?: (state: BayState, event: BayEvent) => BayState
  /** Reducer middleware for commands (verbs). */
  reduce?: Reducer
  /** Async effect executors, keyed by effect type. */
  effects?: Record<string, EffectHandler>
}

/** A with*() plugin wraps the bay: (bay) => bay. Compose with pipe(). */
export type BayPlugin = (bay: BayRuntime) => BayRuntime

// ---------- journal + store provider contracts ----------

export type Journal = {
  append: (event: BayEvent) => Promise<void>
  replay: () => AsyncIterable<BayEvent>
}

export type BayStore = {
  journal: Journal
  /** Optional materialized views; sqlite/km adapters may accelerate reads. */
  close: () => Promise<void>
}

// ---------- runtime ----------

export type BayRuntime = {
  readonly layers: Layer[]
  readonly store: BayStore
  readonly clock: () => string // ISO timestamp source (injected; replay-safe)
  readonly actor: string
  use: (layer: Layer) => BayRuntime
  /** Current folded state (replayed on open, maintained on dispatch). */
  state: () => Promise<BayState>
  /** Dispatch a command: reduce → journal events → run effects → fold. */
  dispatch: (command: BayCommand) => Promise<{ events: BayEvent[] }>
}

// ---------- config resolution (inline > BAY_* env > git config bay.* > default) ----------

export type ConfigSource = {
  get: (key: string) => Promise<string | undefined>
}
