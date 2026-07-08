import type { BayCommand, BayPlugin, BayRuntime, BayState, Layer, PrId, TransitionResult, WorkitemId } from "../types.ts"
import { nextPrId } from "../ids.ts"
import { prOpenedEvent } from "./queue.ts"
import { leaseForBranch } from "./receive.ts"

/**
 * withAdopt — the reducer behind `git bay submit <branch|name>` (v0.2: the old
 * `adopt` verb's code, folded into the one advertised submit verb; the CLI
 * aliases `enqueue` and `adopt` land here too). It is pure bookkeeping over the
 * queue: no effects, no git. It correlates a branch created outside a worktree
 * to a fresh PR number and enqueues it as a first-class PR.
 *
 * Design note — what submit-of-a-branch buys and its audit contract:
 *   Submitting a legacy branch makes it a first-class PR so the merge worker /
 *   receiver submit pipeline can process it, and so `git bay audit` stops
 *   flagging it as an unnamed ref — ONCE a name is provided. A nameless submit
 *   (name = null) still enters the queue but stays audit-warned until v0.3's
 *   hard refusal (spec/bead policy: no branch without a name at the front door;
 *   submit is the reconciliation ramp, not a bypass). Enforcing the "nameless
 *   submit stays warned" nuance is the audit layer's job (it can see the PR's
 *   null name); this reducer only records intent.
 *
 * v0.3: the old separate `adopt.recorded` audit-trail event is gone — this
 * reducer's ONLY event is `pr/opened {..., via: "submit"}`; `via` already says
 * "this PR came from an explicit submit, not a worktree's push", which is all
 * `adopt.recorded` ever added (docs/events.md § event families: DELETE adopt.*
 * from the write path — absorbed via the `via` field).
 *
 * Interlock rule (spec): this layer consumes only lower layers' STATE — leases
 * from withWorktrees/receive (via leaseForBranch) and the queue slice — and
 * emits events the queue folds (prOpenedEvent). It never reaches into their
 * internals.
 */

const LAYER = "adopt"

// ---------- pure lookups ----------

/** The PR already tracking `branch`, if any — scans the queue slice's target
 *  map (target == branch for a bay-tracked PR). Loose read so this layer does
 *  not hard-depend on withQueue's slice type. */
function prTrackingBranch(state: BayState, branch: string): PrId | undefined {
  const queue = state.slices.queue as { targets?: Record<PrId, string> } | undefined
  if (!queue?.targets) return undefined
  for (const [id, target] of Object.entries(queue.targets)) {
    if (target === branch) return id
  }
  return undefined
}

/** The wt-label for an open lease, read loosely from the worktrees slice so
 *  this layer does not hard-depend on withWorktrees being registered. Falls
 *  back to the lease's name/branch when the slice is absent. */
function worktreeLabel(state: BayState, leaseId: string): string | undefined {
  const wt = state.slices.worktrees as { byWorktree?: Record<number, string> } | undefined
  if (!wt?.byWorktree) return undefined
  for (const [num, held] of Object.entries(wt.byWorktree)) {
    if (held === leaseId) return `wt${num}`
  }
  return undefined
}

// ---------- reducer (pure; no effects) ----------

function reduceAdopt(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const rawBranch = command.args?.branch
  if (typeof rawBranch !== "string" || rawBranch.trim() === "") {
    throw new Error("bay: submit: 'branch' (an existing branch name) is required")
  }
  const branch = rawBranch

  const rawName = command.args?.name
  if (rawName !== undefined && (typeof rawName !== "string" || rawName.trim() === "")) {
    throw new Error("bay: submit: 'name' must be a non-empty string when provided")
  }
  const name: WorkitemId | null = typeof rawName === "string" ? rawName : null

  // An OPEN worktree already owns this branch — plain `git push` from inside it
  // is the submit path (there is no `git bay push`). An ended lease is fine:
  // submitting recovers closed-out or legacy work.
  const lease = leaseForBranch(state, branch)
  if (lease && lease.endedAt === undefined) {
    const wt = worktreeLabel(state, lease.id) ?? `'${lease.workitem ?? lease.branch}'`
    throw new Error(
      `bay: submit: '${branch}' is already open in worktree ${wt} — ` +
        `plain git push from that worktree submits it, or close it first: git bay close ${wt}`,
    )
  }

  // Already a first-class PR — refuse the double-submit, naming it.
  const tracked = prTrackingBranch(state, branch)
  if (tracked) {
    const pr = state.prs[tracked]
    throw new Error(
      `bay: submit: '${branch}' is already tracked by ${tracked} (${pr?.state ?? "queued"}) — ` +
        `git bay ls ${tracked}`,
    )
  }

  const prId = nextPrId(state)
  // Belt-and-suspenders: prOpenedEvent (the builder) does not see state, so the
  // duplicate-id fail-loud lives here. prTrackingBranch already catches
  // same-branch re-submits; this catches a bare id collision.
  if (state.prs[prId]) {
    throw new Error(`bay: submit: PR '${prId}' already exists — '${branch}' was submitted before`)
  }

  const opened = prOpenedEvent(bay, prId, branch, name, "submit", command.cause!)
  return { state, events: [opened], effects: [] }
}

// ---------- the plugin ----------

/** Built inside the plugin closure (house style): the reducer needs the
 *  runtime's clock/actor to stamp events, but the Reducer contract passes no
 *  runtime. No apply — the pr/opened event is folded by the queue. */
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
