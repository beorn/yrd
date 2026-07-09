import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  DeprovisionVia,
  Effect,
  Layer,
  Lease,
  LeaseId,
  PrId,
  TransitionResult,
} from "../types.ts"
import { isOpen } from "../types.ts"
import { existsSync } from "node:fs"
import { makeEvent } from "../core.ts"
import { nextPrId } from "../ids.ts"
import { createGitConfigSource, resolveOption } from "../config.ts"
import { stateChangeEvent } from "./queue.ts"
import {
  ensureRemote,
  headSha,
  porcelainStatus,
  resolveBaseRef,
  revParse,
  setWorktreeConfig,
  updateRef,
  worktreeAdd,
  worktreeAddExistingBranch,
  worktreeRemove,
} from "./git.ts"

/**
 * withWorktrees — the "bays" layer (spec § How it's built, the withWorktrees
 * row; v0.3 rename of withWorkspaces — docs/layers/worktrees.md is the target
 * name this file now matches). It is the first rung above the bare journal —
 * a lease ledger with no queue. It adds three verbs (`open`, `close`,
 * `refresh`; `gc` sweeps idle ones), the `bay/…` and `worktree/…` event
 * families, a state slice tracking which worktree number each open lease
 * holds, and two effect handlers that spawn real `git worktree` operations.
 *
 * Vocabulary (spec § worktree/bay identity split): a WORKTREE is the numbered,
 * persistent directory (`wt1`, `wt2`, …); a BAY is the named, ephemeral LOAN of
 * one worktree to one piece of work. Internally this file still calls the loan
 * a "lease" (LeaseId/Lease — unrenamed this pass, see the report's scope note)
 * but every event and every user-facing string says "bay" for the loan and
 * "worktree" for the directory, never interchanged.
 *
 * Interlock rule (spec): this layer consumes only core state; it never reaches
 * into a layer above. Everything a later layer (`withReceive`) needs — the
 * lease and its worktree — it reads from the events and state this layer folds.
 *
 * Purity: the reducer is a pure (state, command) → [events, effects] function.
 * It NEVER touches git, the filesystem, config, Math.random, or Date.now. The
 * worktree number is allocated from folded state; the PR id is the sequential
 * mint in ids.ts, derived from folded state. All I/O lives in the async effect
 * handlers, which resolve config lazily and journal their outcome as events.
 */

export type WorktreesOptions = {
  baysRoot?: string
  mainRepo?: string
  /** When set, each provisioned worktree gets a `bay` remote pointing here,
   *  with push defaults wired so plain `git push` inside it submits (spec §
   *  the hot loop is plain git). Omitted → worktrees are provisioned without
   *  a remote. */
  bayRemote?: string
  /** Idle timeout for a lease before `gc` may expire it (spec § the lease
   *  lifecycle). Precedence: this inline value > BAY_LEASE_TIMEOUT_MS env >
   *  (host-resolved) git config bay.leaseTimeoutMs > 45m default. Resolved once
   *  at build (never per-reduce) so the gc reducer stays pure. */
  leaseTimeoutMs?: number
}

/** Per-open-lease worktree bookkeeping. Leases carry no worktree number in the
 *  core type, so this slice is the authoritative worktree↔lease index. Only
 *  OPEN leases appear in `byWorktree` — a lease frees its worktree the moment
 *  it ends. `lastActive` records the newest ping per lease so gc measures
 *  idleness against activity, not just the checkout time (spec § the lease
 *  lifecycle — TTL is policy-at-check-time, so it lives here, not on the
 *  lease). */
export type WorktreesSlice = {
  byWorktree: Record<number, LeaseId>
  heads: Record<LeaseId, string> // provisioned HEAD sha, keyed by lease
  lastActive: Record<LeaseId, string> // newest ping ts, keyed by lease
}

/** Default lease idle timeout: 45 minutes (spec § the lease lifecycle). */
export const DEFAULT_LEASE_TIMEOUT_MS = 2_700_000

const LAYER = "worktrees"
const EV_BAY_OPENED = "bay/opened"
const EV_BAY_CLOSED = "bay/closed"
const EV_BAY_REFRESHED = "bay/refreshed"
const EV_PROVISIONED = "worktree/provisioned"
const EV_DEPROVISIONED = "worktree/deprovisioned"
const FX_PROVISION = "worktree.provision"
const FX_DEPROVISION = "worktree.deprovision"

// ---------- pure helpers ----------

/** Read the layer slice, normalized so every field is always present — an old
 *  journal (pre-`lastActive`) or a partial write can never surface `undefined`. */
function sliceOf(state: BayState): WorktreesSlice {
  const raw = state.slices[LAYER] as Partial<WorktreesSlice> | undefined
  return { byWorktree: raw?.byWorktree ?? {}, heads: raw?.heads ?? {}, lastActive: raw?.lastActive ?? {} }
}

/** Lowest worktree number ≥ 1 not held by an open lease. */
function lowestFreeWorktree(slice: WorktreesSlice): number {
  let n = 1
  while (slice.byWorktree[n] !== undefined) n++
  return n
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
function resolveLeaseTimeoutMs(opts: WorktreesOptions): number {
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

function reduceOpen(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const rawWorkitem = command.args?.workitem
  if (rawWorkitem !== undefined && (typeof rawWorkitem !== "string" || rawWorkitem.trim() === "")) {
    throw new Error("bay: open: 'workitem' must be a non-empty string when provided")
  }
  const workitem: string | null = typeof rawWorkitem === "string" ? rawWorkitem : null

  const slice = sliceOf(state)
  const seq = Object.keys(state.leases).length + 1
  const n = lowestFreeWorktree(slice)
  const leaseId: LeaseId = `L${seq}`
  const worktree = `wt${n}`
  // The worktree pre-mints its PR number at `open`, so the push output, the
  // branch fallback, and the abandoned-work ref all agree on one id. A worktree
  // closed before its first push burns its number (numbers are never reused).
  const changeId = nextPrId(state)
  const rawSourceBranch = command.args?.sourceBranch
  if (rawSourceBranch !== undefined && (typeof rawSourceBranch !== "string" || rawSourceBranch.trim() === "")) {
    throw new Error("bay: open: 'sourceBranch' must be a non-empty string when provided")
  }
  const sourceBranch = typeof rawSourceBranch === "string" ? rawSourceBranch : undefined
  const branch = sourceBranch ?? (workitem ? `task/${workitem}` : `bay/${changeId}`)
  const alreadyOpen = Object.values(state.leases).find(
    (lease) => lease.endedAt === undefined && lease.branch === branch,
  )
  if (alreadyOpen) {
    throw new Error(`bay: open: '${branch}' is already open in another bay`)
  }

  const opened = makeEvent(
    bay,
    EV_BAY_OPENED,
    { bay: leaseId, worktree, workName: workitem, pr: changeId, branch, recycled: false, actor: bay.actor },
    command.cause!,
  )
  const effect: Effect = {
    type: FX_PROVISION,
    data: {
      lease: leaseId,
      worktree,
      branch,
      changeId,
      workitem,
      ...(sourceBranch !== undefined ? { sourceBranch } : {}),
    },
  }
  return { state, events: [opened], effects: [effect] }
}

function reduceClose(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const leaseId = command.args?.lease
  if (typeof leaseId !== "string" || leaseId === "") {
    throw new Error("bay: close: 'lease' (a bay id) is required")
  }
  const withdraw = command.args?.withdraw === true
  const lease = state.leases[leaseId]
  if (!lease) {
    throw new Error(`bay: close: no bay '${leaseId}' — nothing to close`)
  }
  if (lease.endedAt !== undefined) {
    throw new Error(`bay: close: bay '${leaseId}' already ended (${lease.endReason ?? "ended"}) — nothing to close`)
  }

  const pr = state.prs[lease.changeId]
  const events: BayEvent[] = []
  const via: DeprovisionVia = withdraw ? "withdraw" : "close"
  // The CLI already resolved the user's token to a friendly wt-label (spec §
  // dual addressing); teach with THAT, never the internal lease id, which is
  // never advertised as something to type.
  const addressedAs = typeof command.args?.wt === "string" ? command.args.wt : leaseId

  if (pr && isOpen(pr.state)) {
    // docs/model.md § Phases: pushed/submitted/checked/rejected → closed —
    // a PR born by a bare push (never submitted) is exactly as "still live"
    // as a submitted one.
    const withdrawable =
      pr.state === "pushed" ||
      pr.state === "submitted" ||
      pr.state === "checked" ||
      pr.state === "rejected" ||
      pr.state === "reviewing"
    if (!withdraw) {
      const detail =
        `${pr.id} is ${pr.state} — integrate it (git bay integrate ${pr.id}), ` +
        `retry it (git bay retry ${pr.id}), or withdraw it (git bay close --withdraw ${addressedAs})`
      return {
        state,
        events: [
          makeEvent(
            bay,
            "gitbay/refused",
            { code: "pr-still-queued", detail, pr: pr.id, bay: leaseId },
            command.cause!,
          ),
        ],
        effects: [],
      }
    }
    if (!withdrawable) {
      throw new Error(
        `bay: close: ${pr.id} is ${pr.state} — wait for the verdict (git bay ls ${pr.id}) before withdrawing`,
      )
    }
    events.push(
      stateChangeEvent(bay, pr.id, pr.state, "closed", command.cause!, { detail: "withdrawn by close --withdraw" }),
    )
  }

  events.push(makeEvent(bay, EV_BAY_CLOSED, { bay: leaseId, via }, command.cause!))
  const effect: Effect = {
    type: FX_DEPROVISION,
    data: { lease: leaseId, path: lease.path, branch: lease.branch, changeId: lease.changeId, via },
  }
  return { state, events, effects: [effect] }
}

/** refresh {lease}: reset a bay's liveness so gc measures idleness from now.
 *  The explicit primitive; commit/push-driven refresh integrates later via the
 *  receiver. Fail-loud on an unknown or already-ended bay. */
function reduceRefresh(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const leaseId = command.args?.lease
  if (typeof leaseId !== "string" || leaseId === "") {
    throw new Error("bay: refresh: 'lease' (a bay id) is required")
  }
  const lease = state.leases[leaseId]
  if (!lease) {
    throw new Error(`bay: refresh: no bay '${leaseId}' — nothing to refresh`)
  }
  if (lease.endedAt !== undefined) {
    throw new Error(`bay: refresh: bay '${leaseId}' already ended (${lease.endReason ?? "ended"}) — cannot refresh`)
  }

  const refreshed = makeEvent(bay, EV_BAY_REFRESHED, { bay: leaseId }, command.cause!)
  return { state, events: [refreshed], effects: [] }
}

/** gc {}: expire every open lease idle longer than the TTL, closing it
 *  (via "gc") and deprovisioning its worktree through the SAME effect the
 *  close path uses — so the WIP-snapshot ref and dirty-refuse custodian logic
 *  run unchanged. A never-provisioned lease (empty path) is closed but has no
 *  worktree to deprovision. Zero expired is a non-event (docs/events.md § "an
 *  empty integrate run, a prune that removed nothing" are deliberately not
 *  journaled) — the CLI reports "nothing to expire" from an empty events list. */
function reduceGc(bay: BayRuntime, state: BayState, command: BayCommand, ttlMs: number): TransitionResult {
  const now = bay.clock()
  const stale = staleLeases(state, now, ttlMs)
  if (stale.length === 0) return { state, events: [], effects: [] }

  const events: BayEvent[] = []
  const effects: Effect[] = []
  for (const lease of stale) {
    events.push(makeEvent(bay, EV_BAY_CLOSED, { bay: lease.id, via: "gc" }, command.cause!))
    if (lease.path !== "") {
      effects.push({
        type: FX_DEPROVISION,
        data: { lease: lease.id, path: lease.path, branch: lease.branch, changeId: lease.changeId, via: "gc" },
      })
    }
  }
  return { state, events, effects }
}

// ---------- apply (pure fold; runs on live dispatch AND replay) ----------

function apply(state: BayState, event: BayEvent): BayState {
  switch (event.name) {
    case EV_BAY_OPENED: {
      const d = event.data as {
        bay: LeaseId
        worktree: string
        workName: string | null
        pr: PrId
        branch: string
        actor: string
      }
      const n = Number(d.worktree.replace(/^wt/, ""))
      const slice = sliceOf(state)
      return {
        ...state,
        leases: {
          ...state.leases,
          [d.bay]: {
            id: d.bay,
            workitem: d.workName,
            path: "", // pending until worktree/provisioned fills the real path
            branch: d.branch,
            changeId: d.pr,
            createdAt: event.ts,
            actor: d.actor,
          },
        },
        slices: {
          ...state.slices,
          [LAYER]: { ...slice, byWorktree: { ...slice.byWorktree, [n]: d.bay } },
        },
      }
    }

    case EV_PROVISIONED: {
      const d = event.data as { bay: LeaseId; path: string; headSha?: string; baseSha?: string }
      const existing = state.leases[d.bay]
      if (!existing) return state // provisioned for an unknown lease: ignore, don't fabricate
      const slice = sliceOf(state)
      return {
        ...state,
        leases: {
          ...state.leases,
          [d.bay]: { ...existing, path: d.path, ...(d.baseSha ? { baseSha: d.baseSha } : {}) },
        },
        slices: {
          ...state.slices,
          [LAYER]: {
            ...slice,
            heads: d.headSha ? { ...slice.heads, [d.bay]: d.headSha } : slice.heads,
          },
        },
      }
    }

    case EV_BAY_REFRESHED: {
      const d = event.data as { bay: LeaseId }
      if (!state.leases[d.bay]) return state // refresh for an unknown lease: ignore
      const slice = sliceOf(state)
      return {
        ...state,
        slices: {
          ...state.slices,
          [LAYER]: { ...slice, lastActive: { ...slice.lastActive, [d.bay]: event.ts } },
        },
      }
    }

    case EV_BAY_CLOSED: {
      const d = event.data as { bay: LeaseId; via: DeprovisionVia }
      const existing = state.leases[d.bay]
      if (!existing) return state
      const endReason = d.via === "gc" ? "expired" : d.via === "merged" ? "merged" : "abandoned"
      return {
        ...state,
        leases: {
          ...state.leases,
          [d.bay]: { ...existing, endedAt: event.ts, endReason },
        },
        slices: { ...state.slices, [LAYER]: freeWorktree(sliceOf(state), d.bay) },
      }
    }

    case EV_DEPROVISIONED: {
      // The worktree number is already freed on bay/closed; deprovisioned is
      // idempotent bookkeeping (it records the abandoned-work ref, if any).
      const d = event.data as { bay: LeaseId }
      return { ...state, slices: { ...state.slices, [LAYER]: freeWorktree(sliceOf(state), d.bay) } }
    }

    default:
      return state
  }
}

/** Remove whichever worktree entry points at `leaseId` (idempotent). */
function freeWorktree(slice: WorktreesSlice, leaseId: LeaseId): WorktreesSlice {
  const byWorktree: Record<number, LeaseId> = {}
  for (const [num, held] of Object.entries(slice.byWorktree)) {
    if (held !== leaseId) byWorktree[Number(num)] = held
  }
  return { ...slice, byWorktree }
}

// ---------- effect handlers (async; the only I/O) ----------

async function resolveConfig(
  opts: WorktreesOptions,
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

function makeProvisionHandler(opts: WorktreesOptions) {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as { lease: LeaseId; worktree: string; branch: string; changeId: PrId; sourceBranch?: string }
    const { mainRepo, baysRoot, bayRemote } = await resolveConfig(opts)
    const path = `${baysRoot}/${d.worktree}`
    const baseRef = await resolveBaseRef(mainRepo)
    const baseSha = await revParse(mainRepo, baseRef) // pin the base commit before the worktree exists

    // Lazy custodian reclaim (spec § lease lifecycle): the worktree NUMBER was
    // freed in state when its lease ended, but the directory stays on disk until
    // the slot is needed again — the holder may still be cd'd inside post-merge.
    // Reclaim iff zero-change: no open lease at the path, porcelain-clean.
    // Anything else refuses loudly; work is preserved by branch/abandoned refs.
    if (existsSync(path)) {
      const state = await bay.state()
      const open = Object.values(state.leases).find((l) => l.path === path && l.endedAt === undefined)
      if (open) {
        throw new Error(
          `bay: cannot provision ${d.worktree} — ${path} is held by '${open.workitem ?? open.branch}'. ` +
            `Close it first: git bay close ${d.worktree}`,
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

    if (d.sourceBranch !== undefined) {
      await worktreeAddExistingBranch(mainRepo, d.sourceBranch, path)
    } else {
      await worktreeAdd(mainRepo, d.branch, path, baseRef) // throws literal git stderr on failure
    }
    const sha = await headSha(path)

    const data: { bay: LeaseId; worktree: string; path: string; baseSha: string; headSha: string; upstream?: string } =
      {
        bay: d.lease,
        worktree: d.worktree,
        path,
        baseSha,
        headSha: sha,
      }

    if (bayRemote) {
      // The remote IS the API: plain `git push` inside the bay submits (spec §
      // hot loop). Wire the `bay` remote + push defaults; fail-loud on git error.
      await ensureRemote(path, "bay", bayRemote)
      await setWorktreeConfig(path, "remote.pushDefault", "bay")
      await setWorktreeConfig(path, "push.default", "current")
      data.upstream = "bay"
    }

    return [makeEvent(bay, EV_PROVISIONED, data, effect.cause!)]
  }
}

function makeDeprovisionHandler(opts: WorktreesOptions) {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as { lease: LeaseId; path: string; branch: string; changeId: PrId; via: DeprovisionVia }
    const { mainRepo } = await resolveConfig(opts)
    if (d.path === "") {
      // Never provisioned (closed before its first effect ran) — nothing to remove.
      return [makeEvent(bay, EV_DEPROVISIONED, { worktree: "", via: d.via, bay: d.lease }, effect.cause!)]
    }
    const dirty = await porcelainStatus(d.path)
    if (dirty !== "") {
      // Never destroy uncommitted work — the reason this project exists.
      throw new Error(
        `bay: refusing to close the worktree at ${d.path} — it has uncommitted work:\n${dirty}\n` +
          `Commit or push your work, then close it; bay never deletes uncommitted work.`,
      )
    }

    // Snapshot the branch tip to a findability ref BEFORE removing the worktree,
    // so closed-out work stays discoverable even though the branch is untouched
    // (spec § the loan never deletes work). Records the tip even if it equals
    // base (no commits made) — the ref proves the worktree existed.
    const branchTip = await revParse(mainRepo, d.branch)
    const abandonedRef = `refs/bay/abandoned/${d.changeId}`
    await updateRef(mainRepo, abandonedRef, branchTip)

    await worktreeRemove(mainRepo, d.path) // throws literal git stderr on failure
    const worktree = d.path.split("/").at(-1) ?? ""
    return [makeEvent(bay, EV_DEPROVISIONED, { worktree, via: d.via, bay: d.lease, abandonedRef }, effect.cause!)]
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
export function withWorktrees(opts: WorktreesOptions = {}): BayPlugin {
  // Resolved ONCE here (build/setup context), never per-reduce, so the gc
  // reducer reads a closed-over constant and stays pure + deterministic.
  const leaseTimeoutMs = resolveLeaseTimeoutMs(opts)
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      apply,
      reduce(state, command, next) {
        if (command.type === "open") return reduceOpen(bay, state, command)
        if (command.type === "close") return reduceClose(bay, state, command)
        if (command.type === "refresh") return reduceRefresh(bay, state, command)
        if (command.type === "gc") return reduceGc(bay, state, command, leaseTimeoutMs)
        return next(state, command)
      },
      effects: {
        [FX_PROVISION]: makeProvisionHandler(opts),
        [FX_DEPROVISION]: makeDeprovisionHandler(opts),
      },
    }
    return bay.use(layer)
  }
}
