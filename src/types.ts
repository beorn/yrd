// bay domain types — the blueprint (principles: types show what exists).
// Core is era2-shaped: (command, state) → [events, effects]; state = fold(journal).

// ---------- identifiers ----------

export type PrId = string // sequential per repo (PR1, PR2, …); minted from folded state
export type LeaseId = string // the BAY's id (the loan) — "bay" is the vocabulary word; see docs/events.md
export type WorkitemId = string // the NAME given at `open` — a ticket id or any label

// ---------- domain data ----------

export type Lease = {
  id: LeaseId
  workitem: WorkitemId | null
  path: string // worktree absolute path
  branch: string
  changeId: PrId
  createdAt: string // ISO; injected clock — never Date.now() in core
  actor?: string // who holds the loan (from the bay/opened event's data)
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

/**
 * §6 addendum: creation and the ask-to-land are separate acts, like a real
 * GitHub PR. `open` is where every PR is born — a push creates one and stops
 * there by default. `submit`/`queue` (or a fused push: `-o submit`/`-o wait`/
 * `bay.autoQueue`) is what moves it to `queued`, which is what starts the
 * check/merge pipeline (queued → checking → merging → …, unchanged). `open`
 * and `queued` both accept `close --withdraw` (→ abandoned).
 */
export type PrState =
  | "open"
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

export type AuditFinding = {
  kind: "stray" | "unreachable-pin" | "unnamed-ref"
  subject: string
  detail: string
  remedy: string
}

// ---------- rejection/refusal codes (closed unions; docs/events.md § event families) ----------

/** Machine-readable reason a queued PR was rejected (`pr/changed {to: "rejected", code}`).
 *  Closed on purpose — `stats` (a later slice) counts by code, so a new failure
 *  mode must be named here before it can reject anything. Anchor set covers
 *  every `stateChangeEvent(..., "rejected", ...)` call site in receive.ts
 *  (the submitter's checking pipeline) and merge-worker.ts (the integrate
 *  pipeline); `pin-rewind`, `queue-full`, `poison-retry` are reserved for the
 *  submodule guard and the v0.4 WIP-limit / retry-storm slices. */
export type RejectionCode =
  | "check-failed" // bay.check exited nonzero (receive.ts)
  | "dirty-mainline" // mainline working tree was dirty at merge time (receive.ts)
  | "merge-conflict" // git merge --no-ff onto mainline failed (receive.ts)
  | "unresolvable-target" // integrate's target does not resolve to a commit (merge-worker.ts)
  | "lying-merge" // merge command exited 0 but target is not an ancestor (merge-worker.ts)
  | "merge-command-failed" // the configured merge command itself exited nonzero (merge-worker.ts)
  | "pin-rewind" // reserved: a gitlink pin move that is a genuine history rewind
  | "queue-full" // reserved: v0.4 WIP limit
  | "poison-retry" // reserved: a PR retried past a failure-count ceiling

/** Machine-readable reason a command was refused at the door (`gitbay/refused
 *  {code, detail}`) — never a PR state transition, just "no, and here is why".
 *  Closed on purpose, same rationale as RejectionCode. Only `pr-still-queued`
 *  is wired to an event this pass (`close` without `--withdraw`); the rest are
 *  named now so later slices (pooling, WIP limit, review gate) have a code to
 *  reach for instead of inventing one ad hoc. */
export type RefusalCode =
  | "pr-still-queued" // close refused: the bay's PR is still queued — use --withdraw
  | "doors-closed" // submit/push refused: the PR is already merged
  | "tracker-unknown" // reserved: open refused, the tracker doesn't know the name
  | "pool-exhausted" // reserved: v0.4 pooling, no worktree available
  | "unknown-bay" // reserved: refresh/close addressed a bay that doesn't exist
  | "bay-dirty" // reserved: close refused, uncommitted work in the worktree
  | "pin-rewind" // reserved: the submodule guard's pin-rewind refusal
  | "queue-full" // reserved: v0.4 WIP limit
  | "mergecommand-unset" // reserved: integrate refused, no merge command configured
  | "poison-retry" // reserved: retry refused past a failure-count ceiling
  | "not-in-review" // reserved: v0.5 review gate, approve/reject on a PR not in review

// ---------- events v2 (journal rows; additive-only, versioned) ----------

/** Every command's identity, threaded through every event it produces
 *  (docs/events.md § Cause and spans). Minted once per dispatch by core
 *  (`dispatch()`); `traceId`/`spanId` ride along when the CLI (or a future RPC
 *  caller) supplies them — the CLI reads `TRACEPARENT` when present. */
export type Cause = {
  commandId: string
  traceId?: string
  spanId?: string
}

/** The envelope — generic on purpose (docs/events.md § The data model has
 *  three layers): the journal file, transports, and exporters handle this
 *  shape with zero domain knowledge. `data` carries the typed, name-specific
 *  payload (see GitbayEvent below) but the envelope itself does not know that. */
export type BayEvent = {
  id: string
  name: string // layer-registered; consumers ignore unknown names
  ts: string
  cause: Cause
  data: Record<string, unknown>
}

/**
 * The typed event union (docs/events.md § The data model has three layers,
 * layer 1: "each name has an exact, closed payload"). Four slash-namespaced
 * families — gitbay/…, worktree/…, bay/…, pr/… — replace every pre-v0.3 dotted
 * event name. Layers narrow `BayEvent` to this union (by `name`) inside their
 * `apply()` folds so a forgotten case is a compile error, not a silent no-op.
 *
 * Two fields exist beyond the compact table in docs/events.md's family
 * overview (which is deliberately abbreviated): `worktree/provisioned` and
 * `worktree/deprovisioned` also carry `bay` (the loan that triggered the
 * (de)provision) because the fold needs it to update the right lease record;
 * `bay/opened` carries `actor` because the envelope no longer does (dropped in
 * favor of the leaner `cause`), and "who holds this loan" is real behavior
 * (the `ls` "← you" column).
 */
export type GitbayEvent =
  | { name: "gitbay/initialized"; data: { repo: string; journal: string; store: string } }
  | {
      name: "gitbay/refused"
      data: { code: RefusalCode; detail: string; pr?: PrId; bay?: LeaseId }
    }
  | { name: "gitbay/audited"; data: { findings: AuditFinding[]; clean: boolean } }
  | {
      name: "worktree/provisioned"
      data: {
        worktree: string // "wt1", "wt2", … — the persistent, numbered directory
        path: string
        bay: LeaseId
        baseSha?: string
        headSha?: string
        upstream?: string
      }
    }
  | {
      name: "worktree/deprovisioned"
      data: { worktree: string; via: DeprovisionVia; bay: LeaseId; abandonedRef?: string }
    }
  | {
      name: "bay/opened"
      data: {
        bay: LeaseId // the loan's id — internal, never advertised as an argument
        worktree: string
        workName: WorkitemId | null
        pr: PrId // pre-minted at open (spec § worktree/bay identity split)
        branch: string
        recycled: boolean // always false until v0.4 pooling
        actor: string
      }
    }
  | { name: "bay/refreshed"; data: { bay: LeaseId } }
  | { name: "bay/closed"; data: { bay: LeaseId; via: DeprovisionVia } }
  | {
      name: "pr/opened"
      // `queued` (§6 addendum): true iff this creation was FUSED with an
      // immediate ask-to-merge (`-o submit`/`-o wait` push, or `bay.autoQueue`)
      // — the fold plants the PR straight into `queued` instead of `open`
      // when true, so no separate pr/changed{open→queued} is needed for the
      // fused case (only the explicit `submit`/`queue` verb on an ALREADY-open
      // PR emits that transition as its own event).
      data: { pr: PrId; target: string; workName: WorkitemId | null; via: "push" | "submit"; queued: boolean }
    }
  | {
      name: "pr/changed"
      data: {
        pr: PrId
        from: PrState
        to: PrState
        revision?: number
        code?: RejectionCode
        detail?: string
      }
    }

/** Why a bay (and its worktree) closed — unifies the old `endReason` +
 *  `via` split into one field: "close" (voluntary, `close`/`close --withdraw`),
 *  "gc" (idle-timeout expiry), "merged" (automatic close on a successful
 *  integrate). */
export type DeprovisionVia = "close" | "withdraw" | "gc" | "merged"

/** Exhaustiveness helper for a layer's `apply()` switch over `GitbayEvent["name"]`
 *  — call it in the `default:` branch so an unhandled new name is a compile
 *  error (`x: never`) instead of a silently-ignored event. */
export function assertNeverEvent(x: never): never {
  throw new Error(`bay: unhandled event name '${(x as { name: string }).name}' — a fold is missing a case`)
}

// ---------- commands + effects (serializable data, per tea.md) ----------

export type BayCommand = {
  type: string // layer-registered verb or internal op
  args?: Record<string, unknown>
  /** Set by core at dispatch() — a reducer reads `command.cause` to stamp the
   *  events it returns; never set this by hand outside a host's TRACEPARENT
   *  propagation (docs/events.md § Cause and spans). */
  cause?: Cause
}

export type Effect = {
  type: string // handled by whichever layer registered the handler
  data?: Record<string, unknown>
  /** Stamped by core from the originating command's cause, right after reduce
   *  returns — an effect handler reads `effect.cause` to stamp its own events. */
  cause?: Cause
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
  /** Event id source (injected; replay-safe — never crypto.randomUUID() directly
   *  in a reducer or a determinism test would see a different id every run). */
  readonly idGen: () => string
  use: (layer: Layer) => BayRuntime
  /** Current folded state (replayed on open, maintained on dispatch). */
  state: () => Promise<BayState>
  /** Dispatch a command: reduce → journal events → run effects → fold. Mints
   *  `command.cause` (once per dispatch) when the caller didn't supply one. */
  dispatch: (command: BayCommand) => Promise<{ events: BayEvent[] }>
}

// ---------- config resolution (inline > BAY_* env > git config bay.* > default) ----------

export type ConfigSource = {
  get: (key: string) => Promise<string | undefined>
}
