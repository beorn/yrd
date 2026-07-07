import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  ChangeId,
  Layer,
  TransitionResult,
  WorkitemId,
} from "../types.ts"
import { enqueuedEvent } from "./queue.ts"
import { leaseForBranch } from "./receive.ts"

/**
 * withAdopt — the `git bay adopt <branch>` verb (bead M2: "mint a change-id for
 * an existing branch + force workitem reconciliation — the migration path for
 * the no-trace branch backlog"; @hab/20926-gitbay). It is pure bookkeeping over
 * the queue: no effects, no git. It correlates a legacy branch (created outside
 * a bay loan) to a fresh change-id and enqueues it as a first-class changeset.
 *
 * Design note — what adopt buys and its audit contract:
 *   Adopt makes a legacy branch a first-class changeset so the merge worker /
 *   receiver submit pipeline can process it, and so `git bay audit` stops
 *   flagging it as a no-workitem-ref — ONCE a workitem is provided. A
 *   `--no-workitem` adopt (workitem = null) still enters the queue but stays
 *   audit-warned until M3's hard refusal (spec/bead policy: no branch without a
 *   workitem at the front door; adopt is the reconciliation ramp, not a bypass).
 *   Enforcing the "no-workitem adopt stays warned" nuance is the audit layer's
 *   job (it can see the changeset's null workitem); adopt only records intent.
 *
 * Interlock rule (spec): adopt consumes only lower layers' STATE — leases from
 * withWorkspaces/receive (via leaseForBranch) and the queue slice — and emits
 * events the queue folds (enqueuedEvent). It never reaches into their internals.
 */

const LAYER = "adopt"
const EV_RECORDED = "adopt.recorded"

// ---------- deterministic adopt-id mint ----------

// NOTE: fnv1a duplicates queue.ts / workspaces.ts. Adopt is now the THIRD
// consumer, so the shared `ids.ts` extraction the earlier NOTEs deferred is due
// next wave (chief owns it — this slice may only create adopt.ts). Copied
// verbatim so behavior is identical across the three mints.
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** Deterministic given (clock, actor, branch): re-adopting the same branch at
 *  the same tick mints the same id (and is then refused by the guards below).
 *  The `C-adopt-` prefix marks provenance in the journal and the trailer — the
 *  same shape the receiver's submit path mints for lease-less pushes. */
function mintAdoptId(ts: string, actor: string, branch: string): ChangeId {
  return `C-adopt-${fnv1a(`${ts}:${actor}:${branch}`)}`
}

// ---------- pure lookups ----------

/** The change-id already tracking `branch`, if any — scans the queue slice's
 *  target map (target == branch for a bay-tracked changeset). Loose read so
 *  adopt does not hard-depend on withQueue's slice type. */
function changesetTrackingBranch(state: BayState, branch: string): ChangeId | undefined {
  const queue = state.slices.queue as { targets?: Record<ChangeId, string> } | undefined
  if (!queue?.targets) return undefined
  for (const [id, target] of Object.entries(queue.targets)) {
    if (target === branch) return id
  }
  return undefined
}

// ---------- reducer (pure; no effects) ----------

function reduceAdopt(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const rawBranch = command.args?.branch
  if (typeof rawBranch !== "string" || rawBranch.trim() === "") {
    throw new Error("bay: adopt: 'branch' (an existing branch name) is required")
  }
  const branch = rawBranch

  const rawWorkitem = command.args?.workitem
  if (rawWorkitem !== undefined && (typeof rawWorkitem !== "string" || rawWorkitem.trim() === "")) {
    throw new Error("bay: adopt: 'workitem' must be a non-empty string when provided")
  }
  const workitem: WorkitemId | null = typeof rawWorkitem === "string" ? rawWorkitem : null

  // An OPEN lease already owns this branch — it is loaned, not a stray to adopt.
  // (An ended lease is fine: adopting recovers an abandoned/legacy branch.)
  const lease = leaseForBranch(state, branch)
  if (lease && lease.endedAt === undefined) {
    throw new Error(
      `bay: adopt: '${branch}' is already loaned (lease ${lease.id}, changeset ${lease.changeId}) — ` +
        `nothing to adopt; push it, or git bay abandon ${lease.id} first`,
    )
  }

  // Already a first-class changeset — refuse the double-adopt, naming it.
  const tracked = changesetTrackingBranch(state, branch)
  if (tracked) {
    const cs = state.changesets[tracked]
    throw new Error(
      `bay: adopt: '${branch}' is already tracked by changeset ${tracked} (${cs?.state ?? "queued"}) — ` +
        `git bay status ${tracked}`,
    )
  }

  const ts = bay.clock()
  const changeId = mintAdoptId(ts, bay.actor, branch)
  // Belt-and-suspenders: enqueuedEvent (the builder) does not see state, so the
  // duplicate-id fail-loud lives here. changesetTrackingBranch already catches
  // same-branch re-adopts; this catches a bare id collision.
  if (state.changesets[changeId]) {
    throw new Error(`bay: adopt: changeset '${changeId}' already exists — '${branch}' was adopted before`)
  }

  const enqueued = enqueuedEvent(bay, changeId, branch, workitem)
  const recorded: BayEvent = {
    v: 1,
    ts,
    actor: bay.actor,
    type: EV_RECORDED,
    changeset: changeId,
    data: { branch, changeId, workitem },
  }
  return { state, events: [enqueued, recorded], effects: [] }
}

// ---------- the plugin ----------

/** Built inside the plugin closure (house style): the reducer needs the
 *  runtime's clock/actor to mint deterministically and stamp events, but the
 *  Reducer contract passes no runtime. No apply — the enqueued event is folded
 *  by the queue; `adopt.recorded` is a journal-only audit-trail row. */
export function withAdopt(): BayPlugin {
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      reduce(state, command, next) {
        if (command.type === "adopt") return reduceAdopt(bay, state, command)
        return next(state, command)
      },
    }
    return bay.use(layer)
  }
}
