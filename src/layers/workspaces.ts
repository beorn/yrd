import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  ChangeId,
  Effect,
  Layer,
  Lease,
  LeaseId,
  TransitionResult,
} from "../types.ts"
import { existsSync } from "node:fs"
import { makeEvent } from "../core.ts"
import { createGitConfigSource, resolveOption } from "../config.ts"
import {
  ensureRemote,
  headSha,
  porcelainStatus,
  resolveBaseRef,
  revParse,
  setConfig,
  updateRef,
  worktreeAdd,
  worktreeRemove,
} from "./git.ts"

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
  /** When set, each provisioned bay gets a `bay` remote pointing here, with
   *  push defaults wired so plain `git push` inside the bay submits (spec § the
   *  hot loop is plain git). Omitted → bays are provisioned without a remote. */
  bayRemote?: string
  /** Idle timeout for a lease before `gc` may expire it (spec § the lease
   *  lifecycle). Precedence: this inline value > BAY_LEASE_TIMEOUT_MS env >
   *  (host-resolved) git config bay.leaseTimeoutMs > 45m default. Resolved once
   *  at build (never per-reduce) so the gc reducer stays pure. */
  leaseTimeoutMs?: number
}

/** Per-open-lease bay bookkeeping. Leases carry no bay number in the core type,
 *  so this slice is the authoritative bay↔lease index. Only OPEN leases appear
 *  in `byBay` — a lease frees its bay the moment it ends. `lastActive` records
 *  the newest ping per lease so gc measures idleness against activity, not just
 *  the checkout time (spec § the lease lifecycle — TTL is policy-at-check-time,
 *  so it lives here, not on the lease). */
export type WorkspacesSlice = {
  byBay: Record<number, LeaseId>
  heads: Record<LeaseId, string> // provisioned HEAD sha, keyed by lease
  lastActive: Record<LeaseId, string> // newest ping ts, keyed by lease
}

/** Default lease idle timeout: 45 minutes (spec § the lease lifecycle). */
export const DEFAULT_LEASE_TIMEOUT_MS = 2_700_000

const LAYER = "workspaces"
const EV_OPENED = "lease.opened"
const EV_ENDED = "lease.ended"
const EV_PROVISIONED = "workspace.provisioned"
const EV_RETIRED = "workspace.retired"
const EV_PINGED = "lease.pinged"
const EV_GC_CLEAN = "gc.clean"
const FX_PROVISION = "workspace.provision"
const FX_RETIRE = "workspace.retire"

// ---------- pure helpers ----------

/** Read the layer slice, normalized so every field is always present — an old
 *  journal (pre-`lastActive`) or a partial write can never surface `undefined`. */
function sliceOf(state: BayState): WorkspacesSlice {
  const raw = state.slices[LAYER] as Partial<WorkspacesSlice> | undefined
  return { byBay: raw?.byBay ?? {}, heads: raw?.heads ?? {}, lastActive: raw?.lastActive ?? {} }
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

/** Validate a millisecond timeout — a set-but-garbage value fails loud, never
 *  silently defaults (principles § Fail Loud). Unset (undefined) returns undefined
 *  so the next precedence tier applies. */
function parseTimeoutMs(raw: number | string | undefined, source: string): number | undefined {
  if (raw === undefined || raw === "") return undefined
  const ms = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms <= 0) {
    throw new Error(`bay: ${source} must be a positive integer of milliseconds; got '${raw}'`)
  }
  return ms
}

/** Resolve the lease timeout at BUILD time (host/setup context, not the reducer):
 *  inline option > BAY_LEASE_TIMEOUT_MS env > default. The git config tier
 *  (bay.leaseTimeoutMs) is async, so a host resolves it via resolveOption and
 *  passes it inline — the same boundary every other bay config is resolved at.
 *  Keeping this synchronous is what lets the gc reducer stay pure. */
function resolveLeaseTimeoutMs(opts: WorkspacesOptions): number {
  return (
    parseTimeoutMs(opts.leaseTimeoutMs, "leaseTimeoutMs option") ??
    parseTimeoutMs(process.env.BAY_LEASE_TIMEOUT_MS, "BAY_LEASE_TIMEOUT_MS") ??
    DEFAULT_LEASE_TIMEOUT_MS
  )
}

/**
 * Open leases whose idle age exceeds `ttlMs` at `nowIso` — the pure predicate
 * behind both the `gc` reducer and the CLI's stale surfacing (spec § the lease
 * lifecycle). Idleness is measured from the newest ping (`lastActive`) or, if
 * never pinged, the checkout time (`createdAt`). Returned in lease-creation
 * order (Object.values insertion order over string keys) — deterministic.
 */
export function staleLeases(state: BayState, nowIso: string, ttlMs: number): Lease[] {
  const now = Date.parse(nowIso)
  const slice = sliceOf(state)
  const out: Lease[] = []
  for (const lease of Object.values(state.leases)) {
    if (lease.endedAt !== undefined) continue // only open leases can go stale
    const last = slice.lastActive[lease.id] ?? lease.createdAt
    if (now - Date.parse(last) > ttlMs) out.push(lease)
  }
  return out
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
    data: { lease: leaseId, path: lease.path, branch: lease.branch, changeId: lease.changeId },
  }
  return { state, events: [ended], effects: [effect] }
}

/** ping {lease}: refresh a lease's liveness so gc measures idleness from now.
 *  The explicit primitive; commit/push-driven refresh integrates later via the
 *  receiver. Fail-loud on an unknown or already-ended lease. */
function reducePing(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const leaseId = command.args?.lease
  if (typeof leaseId !== "string" || leaseId === "") {
    throw new Error("bay: ping: 'lease' (a lease id) is required")
  }
  const lease = state.leases[leaseId]
  if (!lease) {
    throw new Error(`bay: ping: no lease '${leaseId}' — nothing to refresh`)
  }
  if (lease.endedAt !== undefined) {
    throw new Error(
      `bay: ping: lease '${leaseId}' already ended (${lease.endReason ?? "ended"}) — cannot refresh`,
    )
  }

  const pinged: BayEvent = {
    v: 1,
    ts: bay.clock(),
    actor: bay.actor,
    type: EV_PINGED,
    lease: leaseId,
    changeset: lease.changeId,
    data: { lease: leaseId },
  }
  return { state, events: [pinged], effects: [] }
}

/** gc {}: expire every open lease idle longer than the TTL, ending it
 *  (endReason "expired") and retiring its bay through the SAME retire effect the
 *  abandon path uses — so the WIP-snapshot ref and dirty-refuse custodian logic
 *  run unchanged. A never-provisioned lease (empty path) is expired but has no
 *  worktree to retire. Zero expired → an observable `gc.clean` no-op event. */
function reduceGc(bay: BayRuntime, state: BayState, ttlMs: number): TransitionResult {
  const now = bay.clock()
  const stale = staleLeases(state, now, ttlMs)

  if (stale.length === 0) {
    const openCount = Object.values(state.leases).filter((l) => l.endedAt === undefined).length
    const clean: BayEvent = {
      v: 1,
      ts: now,
      actor: bay.actor,
      type: EV_GC_CLEAN,
      data: { checked: openCount, expired: 0, ttlMs },
    }
    return { state, events: [clean], effects: [] }
  }

  const events: BayEvent[] = []
  const effects: Effect[] = []
  for (const lease of stale) {
    events.push({
      v: 1,
      ts: now,
      actor: bay.actor,
      type: EV_ENDED,
      lease: lease.id,
      changeset: lease.changeId,
      data: { lease: lease.id, endReason: "expired" },
    })
    if (lease.path !== "") {
      effects.push({
        type: FX_RETIRE,
        data: { lease: lease.id, path: lease.path, branch: lease.branch, changeId: lease.changeId },
      })
    }
  }
  return { state, events, effects }
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
            actor: event.actor, // who holds the loan (event envelope)
          },
        },
        slices: {
          ...state.slices,
          [LAYER]: { ...slice, byBay: { ...slice.byBay, [d.bay]: d.lease } },
        },
      }
    }

    case EV_PROVISIONED: {
      const d = event.data as { lease: LeaseId; path: string; headSha?: string; baseSha?: string }
      const existing = state.leases[d.lease]
      if (!existing) return state // provisioned for an unknown lease: ignore, don't fabricate
      const slice = sliceOf(state)
      return {
        ...state,
        leases: {
          ...state.leases,
          [d.lease]: { ...existing, path: d.path, ...(d.baseSha ? { baseSha: d.baseSha } : {}) },
        },
        slices: {
          ...state.slices,
          [LAYER]: {
            ...slice,
            heads: d.headSha ? { ...slice.heads, [d.lease]: d.headSha } : slice.heads,
          },
        },
      }
    }

    case EV_PINGED: {
      const d = event.data as { lease: LeaseId }
      if (!state.leases[d.lease]) return state // ping for an unknown lease: ignore
      const slice = sliceOf(state)
      return {
        ...state,
        slices: {
          ...state.slices,
          [LAYER]: { ...slice, lastActive: { ...slice.lastActive, [d.lease]: event.ts } },
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

async function resolveConfig(
  opts: WorkspacesOptions,
): Promise<{ mainRepo: string; baysRoot: string; bayRemote: string | undefined }> {
  // Lazy, per spec § Plugin config: inline > BAY_* env > git config bay.* > default.
  // Resolved here (async) not at module load; the config source reads the repo.
  const rootSource = createGitConfigSource(opts.mainRepo ?? process.cwd())
  const mainRepo = (await resolveOption(opts.mainRepo, "mainRepo", rootSource, process.cwd()))!
  const repoSource = createGitConfigSource(mainRepo)
  const baysRoot = (await resolveOption(opts.baysRoot, "baysRoot", repoSource, `${mainRepo}/.bays`))!
  const bayRemote = await resolveOption(opts.bayRemote, "bayRemote", repoSource, undefined)
  return { mainRepo, baysRoot, bayRemote }
}

function makeProvisionHandler(opts: WorkspacesOptions) {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as { lease: LeaseId; bay: number; branch: string; changeId: ChangeId }
    const { mainRepo, baysRoot, bayRemote } = await resolveConfig(opts)
    const path = `${baysRoot}/bay${d.bay}`
    const baseRef = await resolveBaseRef(mainRepo)
    const baseSha = await revParse(mainRepo, baseRef) // pin the base commit before the worktree exists

    // Lazy custodian reclaim (spec § lease lifecycle): the bay NUMBER was freed
    // in state when its lease ended, but the worktree stays on disk until the
    // slot is needed again — the holder may still be cd'd inside post-merge.
    // Reclaim iff zero-change: no open lease at the path, porcelain-clean.
    // Anything else refuses loudly; work is preserved by branch/abandoned refs.
    if (existsSync(path)) {
      const state = await bay.state()
      const open = Object.values(state.leases).find((l) => l.path === path && l.endedAt === undefined)
      if (open) {
        throw new Error(
          `bay: cannot provision bay${d.bay} — ${path} is held by open lease ${open.id} (${open.workitem ?? open.branch}). ` +
            `Abandon it first: git bay abandon ${open.id}`,
        )
      }
      const leftover = await porcelainStatus(path)
      if (leftover !== "") {
        throw new Error(
          `bay: reclaim of ${path} refused — leftover working tree is dirty:\n${leftover}\n` +
            `Commit or preserve that work, then retry; bay never deletes uncommitted work.`,
        )
      }
      await worktreeRemove(mainRepo, path) // committed work stays on its branch
    }

    await worktreeAdd(mainRepo, d.branch, path, baseRef) // throws literal git stderr on failure
    const sha = await headSha(path)

    const data: BayEvent["data"] = { lease: d.lease, path, branch: d.branch, baseSha, headSha: sha }

    if (bayRemote) {
      // The remote IS the API: plain `git push` inside the bay submits (spec §
      // hot loop). Wire the `bay` remote + push defaults; fail-loud on git error.
      await ensureRemote(path, "bay", bayRemote)
      await setConfig(path, "remote.pushdefault", "bay")
      await setConfig(path, "push.default", "current")
      data.upstream = "bay"
    }

    return [makeEvent(bay, EV_PROVISIONED, data, { lease: d.lease })]
  }
}

function makeRetireHandler(opts: WorkspacesOptions) {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as { lease: LeaseId; path: string; branch: string; changeId: ChangeId }
    const { mainRepo } = await resolveConfig(opts)
    const dirty = await porcelainStatus(d.path)
    if (dirty !== "") {
      // Never destroy uncommitted work — the reason this project exists.
      throw new Error(
        `bay: refusing to retire bay at ${d.path} — working tree is dirty:\n${dirty}\n` +
          `Commit or push your work, then abandon; bay never deletes uncommitted work.`,
      )
    }

    // Snapshot the branch tip to a findability ref BEFORE removing the worktree,
    // so abandoned work stays discoverable even though the branch is untouched
    // (spec § the loan never deletes work). Records the tip even if it equals
    // base (no commits made) — the ref proves the bay existed.
    const branchTip = await revParse(mainRepo, d.branch)
    const abandonedRef = `refs/bay/abandoned/${d.changeId}`
    await updateRef(mainRepo, abandonedRef, branchTip)

    await worktreeRemove(mainRepo, d.path) // throws literal git stderr on failure
    return [makeEvent(bay, EV_RETIRED, { lease: d.lease, path: d.path, abandonedRef }, { lease: d.lease })]
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
  // Resolved ONCE here (build/setup context), never per-reduce, so the gc
  // reducer reads a closed-over constant and stays pure + deterministic.
  const leaseTimeoutMs = resolveLeaseTimeoutMs(opts)
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      apply,
      reduce(state, command, next) {
        if (command.type === "co") return reduceCo(bay, state, command)
        if (command.type === "abandon") return reduceAbandon(bay, state, command)
        if (command.type === "ping") return reducePing(bay, state, command)
        if (command.type === "gc") return reduceGc(bay, state, leaseTimeoutMs)
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
