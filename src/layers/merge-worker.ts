import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  Effect,
  EffectHandler,
  Layer,
  PrId,
  PullRequest,
  TransitionResult,
} from "../types.ts"
import { makeEvent } from "../core.ts"
import { integratablePrs, queueTarget, stateChangeEvent } from "./queue.ts"
import { resolveCheck, runMerge, runProjectCheck } from "./pipeline.ts"

/**
 * withMergeWorker — the pipeline layer (docs/model.md § Verbs): `check`,
 * `merge`, and `integrate`. It builds ON withQueue: it reads the queue's
 * published state (submittedPrs/integratablePrs/queueTarget) and drives the
 * checking/merging transitions the queue folds. Per the interlock rule it
 * never reaches into the queue's internals — only its state and the shared
 * event builder.
 *
 * `check` and `merge` are atomic single-steps — each does exactly its one
 * step and stops (submitted→checking→checked|rejected; checked→merging→
 * merged|rejected). `integrate` is the umbrella: from `submitted`, it runs
 * check then (if checked) merge, in ONE dispatch — the only verb that
 * auto-flows. All three share the SAME check/merge runners (pipeline.ts) a
 * fused push's continuation uses (receive.ts) — one implementation, every
 * path checks and merges identically.
 *
 * Resume-on-restart falls out of the journal-first core (core.ts dispatch
 * journals events BEFORE running effects): the checked→merging event is
 * durable before `merge.run` ever spawns, so a crash mid-merge leaves the PR
 * in `merging` in the replayed state — nothing is lost or double-counted.
 * `integrate` with no PR named deliberately picks ONLY a `submitted`/`checked`
 * PR (never a stray `checking`/`merging` one) so a crash can't cause a
 * double-run on the next integrate; the stuck PR is resumed by an explicit
 * `retry` (merging→submitted) once the operator/host has confirmed the
 * interrupted merge left nothing half-applied.
 */

const FX_CHECK_RUN = "check.run"
const FX_MERGE_RUN = "merge.run"
const FX_INTEGRATE_RUN = "integrate.run"
const LAYER = "merge-worker"

export type MergeWorkerOptions = {
  /** Inline override; else `BAY_MERGE_COMMAND`, else `git config bay.mergeCommand`.
   *  Unset (§4: zero-config native merge) means `merge`/`integrate` default to a
   *  native `git merge --no-ff` — bay.mergeCommand is an override, never a
   *  requirement. Run via `sh -c` with `{target}` and `{pr}` substituted
   *  (`{changeset}` still substitutes too, so existing configs keep working). */
  mergeCommand?: string
  /** ONE project check command for the standalone `check` verb and `integrate`'s
   *  check half (spec § Check provider). Inline > BAY_CHECK > git config
   *  bay.check > none (stage skipped with an explicit pass-through). */
  check?: string
  /** cwd for ambient (gitconfig) resolution of `bay.mergeCommand`/`bay.check`.
   *  Defaults to mainRepo, then process.cwd(). Not consulted at all when the
   *  matching option is inline. */
  configCwd?: string
  /** The mainline repo a PR lands onto: the native-merge target, the merge
   *  command's spawn cwd, and the post-merge ancestry verify's subject (the
   *  lying-merge guard, epic AC4 / fable24 G1.1). Unset = legacy
   *  trust-exit-0-with-no-native-fallback (library callers with a custom,
   *  non-git mergeCommand and no ancestry interest); the CLI host ALWAYS
   *  sets it. */
  mainRepo?: string
}

// ---------- shared lookups ----------

function requirePrArg(command: BayCommand, verb: string): PrId {
  const raw = command.args?.pr
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`bay: ${verb}: 'pr' (a PR number or name) is required`)
  }
  return raw
}

/** Where to run the check for `pr`'s target branch: its still-open bay, if it
 *  has one, else the mainline repo (mirrors the push-triggered check's cwd —
 *  the PR's own worktree when the push came from one). */
function checkCwd(state: BayState, branch: string, mainRepo: string): string {
  for (const lease of Object.values(state.leases)) {
    if (lease.branch === branch && lease.endedAt === undefined) return lease.path
  }
  return mainRepo
}

function resolveMainRepo(opts: MergeWorkerOptions): string {
  return opts.mainRepo ?? opts.configCwd ?? process.cwd()
}

// ---------- check <PR>: submitted → checking → checked | rejected ----------

function reduceCheck(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const pr = requirePrArg(command, "check")
  const existing = state.prs[pr]
  if (!existing) throw new Error(`bay: check: no PR '${pr}' — git bay ls lists them`)
  if (existing.state === "pushed") {
    throw new Error(`bay: check: ${pr} hasn't been submitted yet — git bay submit ${pr}`)
  }
  if (existing.state === "checked") {
    throw new Error(`bay: check: ${pr} is already checked — git bay merge ${pr} to land it`)
  }
  if (existing.state === "merged") {
    throw new Error(`bay: check: ${pr} is already merged — nothing to check`)
  }
  if (existing.state === "rejected") {
    throw new Error(`bay: check: ${pr} was rejected — put it back in the queue: git bay retry ${pr}`)
  }
  if (existing.state === "closed") {
    throw new Error(`bay: check: ${pr} was withdrawn — start the next piece of work: git bay open <name>`)
  }
  if (existing.state !== "submitted") {
    throw new Error(`bay: check: ${pr} is ${existing.state} — wait for the verdict (git bay ls ${pr})`)
  }
  const event = stateChangeEvent(bay, pr, "submitted", "checking", command.cause!)
  const effect: Effect = { type: FX_CHECK_RUN, data: { pr } }
  return { state, events: [event], effects: [effect] }
}

async function runCheckStep(state: BayState, pr: PrId, opts: MergeWorkerOptions): Promise<{ ok: true } | { ok: false; detail: string }> {
  const target = queueTarget(state, pr)
  const mainRepo = resolveMainRepo(opts)
  const cwd = checkCwd(state, target, mainRepo)
  const check = await resolveCheck(opts.check, opts.configCwd ?? mainRepo)
  return await runProjectCheck(check, cwd)
}

function makeCheckRunHandler(opts: MergeWorkerOptions): EffectHandler {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as { pr: PrId }
    const state = await bay.state()
    const outcome = await runCheckStep(state, d.pr, opts)
    if (!outcome.ok) {
      return [
        stateChangeEvent(bay, d.pr, "checking", "rejected", effect.cause!, { code: "check-failed", detail: outcome.detail }),
      ]
    }
    return [stateChangeEvent(bay, d.pr, "checking", "checked", effect.cause!)]
  }
}

// ---------- merge <PR>: checked → merging → merged | rejected ----------

function reduceMerge(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const pr = requirePrArg(command, "merge")
  const existing = state.prs[pr]
  if (!existing) throw new Error(`bay: merge: no PR '${pr}' — git bay ls lists them`)
  if (existing.state === "merged") throw new Error(`bay: merge: ${pr} is already merged — nothing to merge`)
  if (existing.state === "pushed" || existing.state === "submitted") {
    throw new Error(`bay: merge: ${pr} hasn't been checked yet — git bay check ${pr} (or git bay integrate ${pr})`)
  }
  if (existing.state === "rejected") {
    throw new Error(`bay: merge: ${pr} was rejected — put it back in the queue: git bay retry ${pr}`)
  }
  if (existing.state === "closed") {
    throw new Error(`bay: merge: ${pr} was withdrawn — start the next piece of work: git bay open <name>`)
  }
  if (existing.state !== "checked") {
    throw new Error(`bay: merge: ${pr} is ${existing.state} — wait for the verdict (git bay ls ${pr})`)
  }
  const event = stateChangeEvent(bay, pr, "checked", "merging", command.cause!)
  const effect: Effect = { type: FX_MERGE_RUN, data: { pr } }
  return { state, events: [event], effects: [effect] }
}

/** Close the PR's still-open bay (if it has one) on a successful merge — the
 *  same completion a fused push's merge has always triggered, now shared by
 *  the standalone `merge`/`integrate` verbs too (a PR landed via `integrate`
 *  is exactly as done as one a push merged directly). */
function closeMergedBay(bay: BayRuntime, state: BayState, target: string, cause: NonNullable<Effect["cause"]>): BayEvent[] {
  for (const lease of Object.values(state.leases)) {
    if (lease.branch === target && lease.endedAt === undefined) {
      return [makeEvent(bay, "bay/closed", { bay: lease.id, via: "merged" }, cause)]
    }
  }
  return []
}

async function runMergeStep(
  state: BayState,
  pr: PrId,
  opts: MergeWorkerOptions,
): Promise<{ target: string; outcome: Awaited<ReturnType<typeof runMerge>> }> {
  const target = queueTarget(state, pr)
  const outcome = await runMerge({
    mainRepo: opts.mainRepo,
    pr,
    target,
    mergeCommand: opts.mergeCommand,
    configCwd: opts.configCwd,
  })
  return { target, outcome }
}

function makeMergeRunHandler(opts: MergeWorkerOptions): EffectHandler {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as { pr: PrId }
    const state = await bay.state()
    const { target, outcome } = await runMergeStep(state, d.pr, opts)
    if (!outcome.ok) {
      return [stateChangeEvent(bay, d.pr, "merging", "rejected", effect.cause!, { code: outcome.code, detail: outcome.detail })]
    }
    const events = [stateChangeEvent(bay, d.pr, "merging", "merged", effect.cause!, { detail: outcome.detail })]
    events.push(...closeMergedBay(bay, state, target, effect.cause!))
    return events
  }
}

// ---------- integrate [PR]: the umbrella — walks submitted→…→merged ----------

function reduceIntegrate(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const rawPr = command.args?.pr
  if (rawPr !== undefined && (typeof rawPr !== "string" || rawPr.trim() === "")) {
    throw new Error("bay: integrate: 'pr' must be a non-empty string when provided")
  }

  let next: PullRequest
  if (typeof rawPr === "string") {
    const pr = state.prs[rawPr]
    if (!pr) throw new Error(`bay: integrate: no PR '${rawPr}' — git bay ls lists them`)
    if (pr.state === "merged") throw new Error(`bay: integrate: ${rawPr} is already merged — nothing to integrate`)
    if (pr.state === "pushed") {
      throw new Error(`bay: integrate: ${rawPr} hasn't been submitted yet — git bay submit ${rawPr}`)
    }
    if (pr.state === "rejected") {
      throw new Error(`bay: integrate: ${rawPr} was rejected — put it back in the queue first: git bay retry ${rawPr}`)
    }
    if (pr.state === "closed") {
      throw new Error(`bay: integrate: ${rawPr} was withdrawn — start the next piece of work: git bay open <name>`)
    }
    if (pr.state !== "submitted" && pr.state !== "checked") {
      throw new Error(`bay: integrate: ${rawPr} is ${pr.state} — wait for the verdict (git bay ls ${rawPr})`)
    }
    next = pr
  } else {
    const workable = integratablePrs(state)
    if (workable.length === 0) {
      // Non-event (docs/events.md § event families): an empty integrate run
      // journals nothing. The CLI reports "nothing to integrate" from an
      // empty events list instead of matching a marker event type.
      return { state, events: [], effects: [] }
    }
    next = workable[0]!
  }

  const effect: Effect = { type: FX_INTEGRATE_RUN, data: { pr: next.id } }
  if (next.state === "submitted") {
    const event = stateChangeEvent(bay, next.id, "submitted", "checking", command.cause!)
    return { state, events: [event], effects: [effect] }
  }
  // checked: skip straight to merging — check already ran (either earlier or
  // in a previous integrate that stopped there).
  const event = stateChangeEvent(bay, next.id, "checked", "merging", command.cause!)
  return { state, events: [event], effects: [effect] }
}

/** ONE effect for the whole walk: reads the PR's CURRENT state (set by the
 *  reducer just above, in the SAME dispatch) to decide whether it still owes
 *  a check. `checking` → run check; a pass continues straight into merge (no
 *  second dispatch — "in one dispatch — walking submitted→checking→checked→
 *  merging→merged"); `merging` → the PR arrived already `checked`, so this
 *  runs the merge only. Reads state.prs fresh rather than trusting effect
 *  data, same reason merge-worker's original single-step handler did: a
 *  broken caller trips assertTransition instead of silently mis-recording. */
function makeIntegrateRunHandler(opts: MergeWorkerOptions): EffectHandler {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as { pr: PrId }
    const events: BayEvent[] = []
    const pr = (await bay.state()).prs[d.pr]
    if (!pr) throw new Error(`bay: integrate: no PR '${d.pr}' in state`)

    if (pr.state === "checking") {
      const checkState = await bay.state()
      const outcome = await runCheckStep(checkState, d.pr, opts)
      if (!outcome.ok) {
        events.push(
          stateChangeEvent(bay, d.pr, "checking", "rejected", effect.cause!, {
            code: "check-failed",
            detail: outcome.detail,
          }),
        )
        return events
      }
      events.push(stateChangeEvent(bay, d.pr, "checking", "checked", effect.cause!))
      events.push(stateChangeEvent(bay, d.pr, "checked", "merging", effect.cause!))
    } else if (pr.state !== "merging") {
      throw new Error(`bay: integrate: ${d.pr} is ${pr.state}, not checking/merging — a reducer bug journaled a bad state`)
    }

    const mergeState = await bay.state()
    const { target, outcome } = await runMergeStep(mergeState, d.pr, opts)
    if (!outcome.ok) {
      events.push(stateChangeEvent(bay, d.pr, "merging", "rejected", effect.cause!, { code: outcome.code, detail: outcome.detail }))
      return events
    }
    events.push(stateChangeEvent(bay, d.pr, "merging", "merged", effect.cause!, { detail: outcome.detail }))
    events.push(...closeMergedBay(bay, mergeState, target, effect.cause!))
    return events
  }
}

// ---------- the plugin ----------

export function withMergeWorker(opts: MergeWorkerOptions = {}): BayPlugin {
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      // No apply: this layer emits pr/changed + bay/closed events other
      // layers fold (queue.ts, worktrees.ts); it owns no state slice of its own.
      reduce(state, command, next) {
        if (command.type === "check") return reduceCheck(bay, state, command)
        if (command.type === "merge") return reduceMerge(bay, state, command)
        if (command.type === "integrate") return reduceIntegrate(bay, state, command)
        return next(state, command)
      },
      effects: {
        [FX_CHECK_RUN]: makeCheckRunHandler(opts),
        [FX_MERGE_RUN]: makeMergeRunHandler(opts),
        [FX_INTEGRATE_RUN]: makeIntegrateRunHandler(opts),
      },
    }
    return bay.use(layer)
  }
}
