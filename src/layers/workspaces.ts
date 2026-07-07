import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  ChangeId,
  Effect,
  Layer,
  LeaseId,
  TransitionResult,
} from "../types.ts"
import { makeEvent } from "../core.ts"
import { createGitConfigSource, resolveOption } from "../config.ts"
import { headSha, porcelainStatus, resolveBaseRef, worktreeAdd, worktreeRemove } from "./git.ts"

/**
 * withWorkspaces — the "bays" layer (spec § How it's built, the withWorkspaces
 * row): loaning guarded worktrees. It is the first rung above the bare journal —
 * a lease ledger with no queue. It adds two verbs (`co`, `abandon`), four event
 * types (lease.opened / lease.ended / workspace.provisioned / workspace.retired),
 * a state slice tracking which bay number each open lease holds, and two effect
 * handlers that spawn real `git worktree` operations.
 *
 * Interlock rule (spec): this layer consumes only core state; it never reaches
 * into a layer above. Everything a later layer (`withReceive`) needs — the
 * lease and its bay — it reads from the events and state this layer folds.
 *
 * Purity: the reducer is a pure (state, command) → [events, effects] function.
 * It NEVER touches git, the filesystem, config, Math.random, or Date.now. The
 * bay number is allocated from folded state; the change-id is a deterministic
 * hash of (clock, actor, bay, sequence). All I/O lives in the async effect
 * handlers, which resolve config lazily and journal their outcome as events.
 */

export type WorkspacesOptions = {
  baysRoot?: string
  mainRepo?: string
}

/** Per-open-lease bay bookkeeping. Leases carry no bay number in the core type,
 *  so this slice is the authoritative bay↔lease index. Only OPEN leases appear
 *  in `byBay` — a lease frees its bay the moment it ends. */
export type WorkspacesSlice = {
  byBay: Record<number, LeaseId>
  heads: Record<LeaseId, string> // provisioned HEAD sha, keyed by lease
}

const LAYER = "workspaces"
const EV_OPENED = "lease.opened"
const EV_ENDED = "lease.ended"
const EV_PROVISIONED = "workspace.provisioned"
const EV_RETIRED = "workspace.retired"
const FX_PROVISION = "workspace.provision"
const FX_RETIRE = "workspace.retire"

// ---------- pure helpers ----------

function emptySlice(): WorkspacesSlice {
  return { byBay: {}, heads: {} }
}

function sliceOf(state: BayState): WorkspacesSlice {
  return (state.slices[LAYER] as WorkspacesSlice | undefined) ?? emptySlice()
}

/** Lowest bay number ≥ 1 not held by an open lease. */
function lowestFreeBay(slice: WorkspacesSlice): number {
  let n = 1
  while (slice.byBay[n] !== undefined) n++
  return n
}

/** Deterministic 32-bit FNV-1a → 8 hex chars. Pure and synchronous, so it is
 *  safe inside the reducer (crypto/Date/random are not). */
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** Change-id minted at `co` — deterministic given (clock, actor, bay, seq).
 *  `seq` (total leases ever opened) guarantees uniqueness even under a fixed
 *  clock when a bay number is reused after an abandon. */
function mintChangeId(ts: string, actor: string, bay: number, seq: number): ChangeId {
  return `C-${fnv1a(`${ts}:${actor}:${bay}:${seq}`)}`
}

// ---------- the reducer (pure) ----------

function reduceCo(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const rawWorkitem = command.args?.workitem
  if (rawWorkitem !== undefined && (typeof rawWorkitem !== "string" || rawWorkitem.trim() === "")) {
    throw new Error("bay: co: 'workitem' must be a non-empty string when provided")
  }
  const workitem: string | null = typeof rawWorkitem === "string" ? rawWorkitem : null

  const slice = sliceOf(state)
  const seq = Object.keys(state.leases).length + 1
  const n = lowestFreeBay(slice)
  const leaseId: LeaseId = `L${seq}`
  const ts = bay.clock()
  const changeId = mintChangeId(ts, bay.actor, n, seq)
  const branch = workitem ? `task/${workitem}` : `bay/${changeId}`

  const opened: BayEvent = {
    v: 1,
    ts,
    actor: bay.actor,
    type: EV_OPENED,
    lease: leaseId,
    changeset: changeId,
    data: { lease: leaseId, bay: n, workitem, changeId, branch },
  }
  const effect: Effect = {
    type: FX_PROVISION,
    data: { lease: leaseId, bay: n, branch, changeId, workitem },
  }
  return { state, events: [opened], effects: [effect] }
}

function reduceAbandon(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const leaseId = command.args?.lease
  if (typeof leaseId !== "string" || leaseId === "") {
    throw new Error("bay: abandon: 'lease' (a lease id) is required")
  }
  const lease = state.leases[leaseId]
  if (!lease) {
    throw new Error(`bay: abandon: no lease '${leaseId}' — nothing to abandon`)
  }
  if (lease.endedAt !== undefined) {
    throw new Error(
      `bay: abandon: lease '${leaseId}' already ended (${lease.endReason ?? "ended"}) — nothing to abandon`,
    )
  }

  const ended: BayEvent = {
    v: 1,
    ts: bay.clock(),
    actor: bay.actor,
    type: EV_ENDED,
    lease: leaseId,
    changeset: lease.changeId,
    data: { lease: leaseId, endReason: "abandoned" },
  }
  const effect: Effect = {
    type: FX_RETIRE,
    data: { lease: leaseId, path: lease.path, branch: lease.branch },
  }
  return { state, events: [ended], effects: [effect] }
}

// ---------- apply (pure fold; runs on live dispatch AND replay) ----------

function apply(state: BayState, event: BayEvent): BayState {
  switch (event.type) {
    case EV_OPENED: {
      const d = event.data as {
        lease: LeaseId
        bay: number
        workitem: string | null
        changeId: ChangeId
        branch: string
      }
      const slice = sliceOf(state)
      return {
        ...state,
        leases: {
          ...state.leases,
          [d.lease]: {
            id: d.lease,
            workitem: d.workitem,
            path: "", // pending until workspace.provisioned fills the real path
            branch: d.branch,
            changeId: d.changeId,
            createdAt: event.ts,
          },
        },
        slices: {
          ...state.slices,
          [LAYER]: { ...slice, byBay: { ...slice.byBay, [d.bay]: d.lease } },
        },
      }
    }

    case EV_PROVISIONED: {
      const d = event.data as { lease: LeaseId; path: string; headSha?: string }
      const existing = state.leases[d.lease]
      if (!existing) return state // provisioned for an unknown lease: ignore, don't fabricate
      const slice = sliceOf(state)
      return {
        ...state,
        leases: { ...state.leases, [d.lease]: { ...existing, path: d.path } },
        slices: {
          ...state.slices,
          [LAYER]: {
            ...slice,
            heads: d.headSha ? { ...slice.heads, [d.lease]: d.headSha } : slice.heads,
          },
        },
      }
    }

    case EV_ENDED: {
      const d = event.data as { lease: LeaseId; endReason: "merged" | "abandoned" | "expired" }
      const existing = state.leases[d.lease]
      if (!existing) return state
      return {
        ...state,
        leases: {
          ...state.leases,
          [d.lease]: { ...existing, endedAt: event.ts, endReason: d.endReason },
        },
        slices: { ...state.slices, [LAYER]: freeBay(sliceOf(state), d.lease) },
      }
    }

    case EV_RETIRED: {
      // Bay is already freed on lease.ended; retired is idempotent bookkeeping.
      const d = event.data as { lease: LeaseId }
      return { ...state, slices: { ...state.slices, [LAYER]: freeBay(sliceOf(state), d.lease) } }
    }

    default:
      return state
  }
}

/** Remove whichever bay entry points at `leaseId` (idempotent). */
function freeBay(slice: WorkspacesSlice, leaseId: LeaseId): WorkspacesSlice {
  const byBay: Record<number, LeaseId> = {}
  for (const [num, held] of Object.entries(slice.byBay)) {
    if (held !== leaseId) byBay[Number(num)] = held
  }
  return { ...slice, byBay }
}

// ---------- effect handlers (async; the only I/O) ----------

async function resolveConfig(opts: WorkspacesOptions): Promise<{ mainRepo: string; baysRoot: string }> {
  // Lazy, per spec § Plugin config: inline > BAY_* env > git config bay.* > default.
  // Resolved here (async) not at module load; the config source reads the repo.
  const rootSource = createGitConfigSource(opts.mainRepo ?? process.cwd())
  const mainRepo = (await resolveOption(opts.mainRepo, "mainRepo", rootSource, process.cwd()))!
  const repoSource = createGitConfigSource(mainRepo)
  const baysRoot = (await resolveOption(opts.baysRoot, "baysRoot", repoSource, `${mainRepo}/.bays`))!
  return { mainRepo, baysRoot }
}

function makeProvisionHandler(opts: WorkspacesOptions) {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as { lease: LeaseId; bay: number; branch: string; changeId: ChangeId }
    const { mainRepo, baysRoot } = await resolveConfig(opts)
    const path = `${baysRoot}/bay${d.bay}`
    const baseRef = await resolveBaseRef(mainRepo)
    await worktreeAdd(mainRepo, d.branch, path, baseRef) // throws literal git stderr on failure
    const sha = await headSha(path)
    return [
      makeEvent(bay, EV_PROVISIONED, { lease: d.lease, path, branch: d.branch, headSha: sha }, { lease: d.lease }),
    ]
  }
}

function makeRetireHandler(opts: WorkspacesOptions) {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as { lease: LeaseId; path: string }
    const { mainRepo } = await resolveConfig(opts)
    const dirty = await porcelainStatus(d.path)
    if (dirty !== "") {
      // Never destroy uncommitted work — the reason this project exists.
      throw new Error(
        `bay: refusing to retire bay at ${d.path} — working tree is dirty:\n${dirty}\n` +
          `Commit or push your work, then abandon; bay never deletes uncommitted work.`,
      )
    }
    await worktreeRemove(mainRepo, d.path) // throws literal git stderr on failure
    return [makeEvent(bay, EV_RETIRED, { lease: d.lease, path: d.path }, { lease: d.lease })]
  }
}

// ---------- the plugin ----------

/**
 * The layer's `reduce` needs the runtime's injected clock/actor to timestamp
 * and mint deterministically, but the `Reducer` contract `(state, command,
 * next)` passes no runtime (contract gap — see the final report). So the layer
 * is built INSIDE the plugin closure, where `bay` is in scope, rather than as a
 * static object handed to `definePlugin`. `definePlugin(layer)(bay)` is exactly
 * `bay.use(layer)`; we inline it because the layer must close over `bay`.
 */
export function withWorkspaces(opts: WorkspacesOptions = {}): BayPlugin {
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      apply,
      reduce(state, command, next) {
        if (command.type === "co") return reduceCo(bay, state, command)
        if (command.type === "abandon") return reduceAbandon(bay, state, command)
        return next(state, command)
      },
      effects: {
        [FX_PROVISION]: makeProvisionHandler(opts),
        [FX_RETIRE]: makeRetireHandler(opts),
      },
    }
    return bay.use(layer)
  }
}
