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
 * The model (docs/model.md): creation, the ask-to-land, checking, and merging
 * are four separate acts, like a real GitHub PR. `pushed` is where every PR is
 * born — a plain `git push` creates one and stops there by default
 * (`bay.autoSubmit` false, the default). `submit` (or a push that fuses
 * creation with the ask — `bay.autoSubmit true` or a forcing `-o submit`/`-o
 * wait`) moves it to `submitted`, which is what
 * starts the pipeline: `check` runs `submitted → checking → checked |
 * rejected`; `merge` runs `checked → merging → merged`; `integrate` is the
 * umbrella that walks a PR through both, one dispatch, start to finish
 * (docs/model.md § Verbs — only `integrate` auto-flows). A submitted PR
 * auto-integrates by default (`bay.autoMerge` true, the default) — set it
 * false to rest at `submitted` for a manual `check`/`merge`/`integrate`.
 * `open` is DERIVED, never stored: `isOpen(pr) = phase not in {merged,
 * closed}` — see `isOpen()` below. `pushed`/`submitted`/`checked`/`rejected`
 * all accept `close --withdraw` (→ closed).
 */
export type PrState =
  | "pushed"
  | "submitted"
  | "checking"
  | "checked"
  | "reviewing" // reserved: slots between `checked` and `merging` when the v0.5 review gate lands; unreachable today
  | "merging"
  | "merged"
  | "rejected"
  | "closed"

/** Status: open · merged · closed (docs/model.md § Status). `open` has no
 *  stored representation — a PR is open whenever it is neither merged nor
 *  closed, so this is the ONLY place "is this PR still in flight" is decided;
 *  every caller (`ls`, `close`'s withdrawable check, …) reads through here
 *  rather than re-deriving its own state list. */
export function isOpen(state: PrState): boolean {
  return state !== "merged" && state !== "closed"
}

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

/** Machine-readable reason a submitted PR was rejected (`pr/changed {to: "rejected", code}`).
 *  Closed on purpose — `stats` (a later slice) counts by code, so a new failure
 *  mode must be named here before it can reject anything. Anchor set covers
 *  every `stateChangeEvent(..., "rejected", ...)` call site in pipeline.ts
 *  (the shared check/merge runners behind the `check`/`merge`/`integrate`
 *  verbs AND a fused push's continuation — one implementation, every path
 *  rejects with the same codes); `pin-rewind`, `queue-full`, `poison-retry`
 *  are reserved for the submodule guard and the v0.4 WIP-limit / retry-storm
 *  slices. */
export type RejectionCode =
  | "check-failed" // bay.check exited nonzero (pipeline.ts's runProjectCheck)
  | "dirty-mainline" // mainline working tree was dirty at merge time (pipeline.ts's runMerge, native path)
  | "merge-conflict" // git merge --no-ff onto mainline failed (pipeline.ts's runMerge, native path)
  | "stale-check" // a checked PR's recorded gate no longer matches the current base/head refs
  | "unresolvable-target" // the merge target does not resolve to a commit (pipeline.ts's runMerge)
  | "lying-merge" // merge command exited 0 but target is not an ancestor (pipeline.ts's runMerge)
  | "merge-command-failed" // the configured merge command itself exited nonzero (pipeline.ts's runMerge)
  | "pin-rewind" // a gitlink pin move that is a genuine history rewind (checkSubmitPins — the authoritative post-quarantine judge, 21002)
  | "provision-failed" // the scratch workspace's provision command failed — an environment fault, not a verdict about the PR (scratch.ts, 21000)
  | "queue-full" // reserved: v0.4 WIP limit
  | "poison-retry" // reserved: a PR retried past a failure-count ceiling

export type StepErrorCode =
  | RejectionCode
  | "deploy-failed" // bay.deploy failed after merge; records a line-step failure but never changes the terminal merged PR state

/** Machine-readable reason a command was refused at the door (`gitbay/refused
 *  {code, detail}`) — never a PR state transition, just "no, and here is why".
 *  Closed on purpose, same rationale as RejectionCode. Only `pr-still-queued`
 *  is wired to an event this pass (`close` without `--withdraw`); the rest are
 *  named now so later slices (pooling, WIP limit, review gate, RPC) have a
 *  code to reach for instead of inventing one ad hoc. */
export type RefusalCode =
  | "pr-still-queued" // close refused: the bay's PR is still live — use --withdraw
  | "doors-closed" // submit/push refused: the PR is already merged or was withdrawn
  | "pr-not-pushed" // reserved: submit refused — the PR isn't in `pushed`
  | "tracker-unknown" // reserved: open refused, the tracker doesn't know the name
  | "pool-exhausted" // reserved: v0.4 pooling, no worktree available
  | "unknown-bay" // reserved: refresh/close addressed a bay that doesn't exist
  | "bay-dirty" // reserved: close refused, uncommitted work in the worktree
  | "pin-rewind" // reserved: the submodule guard's pin-rewind refusal
  | "queue-full" // reserved: v0.4 WIP limit
  | "poison-retry" // reserved: retry refused past a failure-count ceiling
  | "not-in-review" // reserved: v0.5 review gate, approve/reject on a PR not in review

// ---------- events v2 (event-log rows; additive-only, versioned) ----------

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
  | { name: "gitbay/initialized"; data: { repo: string; events?: string; journal?: string; store: string } }
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
      // `queued`: true iff this creation was FUSED with an immediate
      // ask-to-merge (`bay.autoSubmit` or a forcing `-o submit`/`-o wait`
      // push) — the fold plants the PR straight into
      // `submitted` instead of `pushed` when true, so no separate
      // pr/changed{pushed→submitted} is needed for the fused case (only the
      // explicit `submit` verb on an already-`pushed` PR emits that
      // transition as its own event). The field keeps its pre-model.md name —
      // it is the fused-submit signal, not a literal echo of the `submitted`
      // state name; whether the PR ALSO auto-integrates from there is the
      // separate `bay.autoMerge` decision, not recorded here.
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
        /** Verified landed tip when `to === "merged"` (lying-merge-guard
         *  proven ancestor of the mainline) — the machine-truth `{sha}` for
         *  issue-tracker notifications, never parsed from detail prose. */
        sha?: string
      }
    }
  | {
      name: "issues/notified"
      // Outbound issue-tracking outcome (docs/layers/issue-tracking.md): the
      // configured `bay.issue.on-<state>` command ran for a named PR's
      // terminal transition. `code` is the command's exit code — success and
      // failure are BOTH journaled, so a failed tracker close shows up in
      // stats instead of vanishing. No fold consumes this; it is audit data.
      data: {
        pr: PrId
        name: WorkitemId
        on: "merged" | "rejected" | "closed"
        command: string
        code: number
        detail?: string
      }
    }
  | {
      name: "queue/reordered"
      // Partial order on purpose: PRs omitted from `order` keep their relative
      // order AFTER the listed ids (the fold appends them). Emitted by layers
      // above the queue (batch-build's candidate-first placement), folded by
      // the queue — same composition contract as pr/opened.
      data: { order: PrId[]; detail?: string }
    }
  | {
      name: "line/step/started"
      // One step RUN is starting against one target tree: the serial check or
      // merge for a PR, a batch candidate's check/merge (pr = the candidate),
      // a bisect prefix gate (role "prefix", pr = the member under test), or
      // the bisect baseline gate (role "baseline", no pr — it tests the batch
      // base itself). The started/finished pair is a run-record, not a crash
      // marker: both journal when the running effect returns; a crash mid-step
      // still shows as the PR stuck checking/merging. `line/step/waiting`
      // records a step that handed off to an external runner and parked the PR
      // without a terminal verdict.
      data: StepRunData
    }
  | {
      name: "line/step/waiting"
      data: StepRunData & StepWaitingMetadata
    }
  | { name: "line/step/finished"; data: StepRunData & { ok: boolean; detail?: string } & StepFinishMetadata }
  | {
      name: "line/batch/started"
      // The batch candidate exists — the compose verdict and the scratch build
      // as ONE fact (both were always emitted by the same effect): who rode,
      // who the compatibility fold skipped, who was ejected on a scratch-merge
      // conflict, and the per-member prefix tips bisect walks on a red gate.
      // `target` is absent when every member was ejected (no candidate branch
      // was published). `tip` is the member target's commit at compose time —
      // settle stamps it as the member's merged `sha` (machine-truth for issue
      // trackers), since the candidate the lying-merge guard verified contains
      // precisely these tips. `sourceBatch` marks a rebuild after an isolation.
      // An empty compose (no submitted PRs at all) is a non-event and never
      // journaled (docs/events.md § event families).
      data: {
        batch: PrId
        target?: string
        base: string
        members: { pr: PrId; target: string; tip?: string }[]
        ejected: { pr: PrId; target: string; detail: string }[]
        prefixes: { pr: PrId; target: string; index: number; prefixTarget: string }[]
        skipped: { target: string; reason: "path-overlap" | "batch-full"; overlapWith: string; paths: string[] }[]
        sourceBatch?: PrId
      }
    }
  | {
      name: "line/batch/isolated"
      // The isolation attempt concluded. outcome "ejected": one member was
      // removed with evidence — a scratch-merge conflict at build
      // ("build-conflict") or the first red prefix gate at bisect ("gate-red").
      // outcome "refused": recovery stopped WITHOUT ejecting anyone and the
      // verdict says why — "baseline-red" (the gate fails on the untouched
      // batch base: an environment/mainline fault), "all-green" (the
      // per-member gate contradicts the red batch gate), "provision-failed"
      // (a gate scratch could not be provisioned). `detail` names the remedy.
      // Refusals used to be throws that discarded the walk evidence; now the
      // walk's line/step rows and the verdict survive in the journal.
      data:
        | { batch: PrId; outcome: "ejected"; reason: "build-conflict" | "gate-red"; pr: PrId; target: string; detail: string }
        | { batch: PrId; outcome: "refused"; reason: "baseline-red" | "all-green" | "provision-failed"; detail: string }
    }
  | {
      name: "line/batch/finished"
      // The candidate landed and each member's outcome is event-log truth
      // (LE-5): every member also gets its own `pr/changed` → merged carrying
      // its compose-time tip as `sha`. Emitted once per batch — the record's
      // settled flag makes re-settling (crash recovery via `batch-settle`) a
      // non-event.
      data: {
        batch: PrId
        landedSha?: string
        members: { pr: PrId; target: string; tip?: string }[]
      }
    }
  | {
      name: "contest/opened"
      // Contest lifecycle events are audit data for the task/contest projection.
      // The JSON contest file is the first read model; these rows are the
      // durable event-log facts that let the projection move toward normal Yrd
      // state folding without inventing a second history store.
      data: {
        contest: string
        task: string
        prompt: string
        repo: string
        base: string
        baseSha: string
        agents: string[]
      }
    }
  | {
      name: "contest/attempt/started"
      data: {
        contest: string
        attempt: string
        agent: string
        bay: string
        bayPath: string
        command: string[]
        startedAt: string
      }
    }
  | {
      name: "contest/attempt/finished"
      data: {
        contest: string
        attempt: string
        agent: string
        bay: string
        bayPath: string
        startedAt: string
        finishedAt: string
        exitCode: number
        durationMs: number
        logs: { stdout: string; stderr: string }
        metrics: {
          inputTokens?: number
          outputTokens?: number
          totalTokens?: number
          costUsd?: number
          source?: string
        }
        git: {
          baseSha: string
          headSha?: string
          committed: boolean
          changedFiles: string[]
          status: string
          diffStat: string
        }
        evals: {
          command: string
          startedAt: string
          finishedAt: string
          durationMs: number
          exitCode: number
          stdout: string
          stderr: string
        }[]
      }
    }
  | {
      name: "contest/selected"
      data: { contest: string; winner: string }
    }
  | {
      name: "contest/promoted"
      data: {
        contest: string
        attempt: string
        pr?: string
        push: { code: number; stdout: string; stderr: string }
        submit: { code: number; stdout: string; stderr: string }
      }
    }

/** One step run's identity — shared by line/step/started and line/step/finished.
 *  `step` stays a payload field (not a name segment) so the union stays closed
 *  and exhaustively foldable while steps become pluggable (withStep). */
export type StepRunData = {
  step: "check" | "merge" | "deploy"
  target: string
  pr?: PrId
  batch?: PrId
  role?: "baseline" | "prefix"
  index?: number
  memberTarget?: string
}

export type StepArtifact = {
  name: string
  path?: string
  url?: string
  bytes?: number
}

export type StepCommandOutput = {
  exitCode?: number
  durationMs?: number
  stdout?: string
  stderr?: string
  baseSha?: string
  headSha?: string
}

export type StepError = {
  code: StepErrorCode
  message: string
  exitCode?: number
}

export type StepFinishMetadata = {
  token?: string
  url?: string
  exitCode?: number
  durationMs?: number
  configHash?: string
  skipped?: boolean
  error?: StepError
  artifacts?: StepArtifact[]
  baseSha?: string
  headSha?: string
}

export type StepWaitingMetadata = {
  detail?: string
  token?: string
  url?: string
  exitCode?: number
  durationMs?: number
  configHash?: string
  artifacts?: StepArtifact[]
  baseSha?: string
  headSha?: string
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
