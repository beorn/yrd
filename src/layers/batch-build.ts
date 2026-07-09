import { composeBatch, type SkippedTarget } from "../batch-compat.ts"
import { makeEvent } from "../core.ts"
import { nextPrId } from "../ids.ts"
import type { BatchLandEvidence } from "./pipeline.ts"
import { createScratchWorkspaces, ProvisionError, type ScratchWorkspaces } from "../scratch.ts"
import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  Cause,
  Effect,
  EffectHandler,
  Layer,
  PrId,
  TransitionResult,
} from "../types.ts"
import { git, repoScopedCleanEnv, resolveBaseRef } from "./git.ts"
import { prOpenedEvent, queueOrder, queueReorderedEvent, queueTarget, stateChangeEvent, submittedPrs } from "./queue.ts"
import { stepFinished, stepStarted } from "./steps.ts"

const LAYER = "batch-build"
// Effect types are internal wiring (never journaled) — only EV_* names are
// journal vocabulary and follow the slash grammar (docs/events.md).
const FX_BATCH_BUILD = "batch.build"
const FX_BATCH_BISECT = "batch.bisect"
const FX_BATCH_SETTLE = "batch.settle"
const EV_BATCH_STARTED = "line/batch/started"
const EV_BATCH_ISOLATED = "line/batch/isolated"
const EV_BATCH_FINISHED = "line/batch/finished"
const DEFAULT_CANDIDATE_PREFIX = "bay/batch/"

export type BatchBuildOptions = {
  /** Repository whose queued targets are composed into the scratch candidate. */
  mainRepo: string
  /** Generated paths may overlap inside a batch because the batch refreshes them once. */
  generatedGlobs?: readonly string[]
  /** Optional cap; defaults to all compatible queued PRs. */
  max?: number
  /** Mostly for tests; defaults to the OS temp dir. */
  scratchParent?: string
  /** Candidate branch prefix; default `bay/batch/`, yielding e.g. `bay/batch/PR4`. */
  candidatePrefix?: string
  /** Read-only prefix gate for `batch-bisect`; may be overridden by command args. */
  gateCommand?: string
  /** Command that makes a gate scratch runnable (submodules, installs, hooks) —
   *  `git config bay.provision` at the CLI host. Its failure is an environment
   *  fault (`line/batch/isolated` refused `provision-failed`), never an ejection. */
  provisionCommand?: string
  /** Injectable workspace seam (tests); default is built from mainRepo +
   *  scratchParent + provisionCommand. */
  scratch?: ScratchWorkspaces
}

type BatchMember = {
  pr: PrId
  target: string
  /** The target's commit at compose time — the exact content aboard the
   *  candidate; settle stamps it as the member's merged `sha`. */
  tip?: string
}

type BatchEjection = BatchMember & {
  detail: string
}

type BatchPrefix = BatchMember & {
  index: number
  prefixTarget: string
}

type BatchRecord = {
  batch: PrId
  target: string
  base: string
  members: BatchMember[]
  ejected: BatchEjection[]
  prefixes: BatchPrefix[]
  state: "built" | "merged" | "rejected"
  /** The candidate's verified landed tip (from its merged `pr/changed`). */
  landedSha?: string
  /** Set once `line/batch/finished` is journaled — makes re-settling a non-event. */
  settled?: boolean
}

type BatchSlice = {
  batches: Record<PrId, BatchRecord>
}

function emptySlice(): BatchSlice {
  return { batches: {} }
}

function sliceOf(state: BayState): BatchSlice {
  return (state.slices[LAYER] as BatchSlice | undefined) ?? emptySlice()
}

/** Published selector (interlock rule: other layers read this slice through
 *  exported selectors, never its shape): the landing evidence for a batch
 *  candidate PR — batch id, member count, ejected members — or undefined when
 *  `pr` is not a batch. The native merge path stamps this into the
 *  `Bay-Gate:` trailer so the main-moving commit itself names the batch. */
export function batchLandEvidence(state: BayState, pr: PrId): BatchLandEvidence | undefined {
  const record = sliceOf(state).batches[pr]
  if (!record) return undefined
  return { batch: record.batch, members: record.members.length, ejected: record.ejected.map((e) => e.pr) }
}

function memberSummary(member: BatchMember): { pr: PrId; target: string; tip?: string } {
  return { pr: member.pr, target: member.target, ...(member.tip !== undefined ? { tip: member.tip } : {}) }
}

function parsePositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`bay: batch-build: '${label}' must be a positive integer`)
  }
  return value
}

function parseCandidatePr(value: unknown): PrId | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("bay: batch-build: 'pr' must be a non-empty string when provided")
  }
  return value
}

function parseRequiredPr(value: unknown, command: string): PrId {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`bay: ${command}: 'pr' must be a non-empty string`)
  }
  return value
}

function parseGateCommand(value: unknown, fallback: string | undefined): string | undefined {
  if (value === undefined) return fallback
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("bay: batch recovery: 'gateCommand' must be a non-empty string when provided")
  }
  return value
}

function reduceBatchBuild(
  opts: BatchBuildOptions,
  bay: BayRuntime,
  state: BayState,
  command: BayCommand,
): TransitionResult {
  const queued = submittedPrs(state)
  if (queued.length === 0) {
    // An empty compose is a non-event and is never journaled (docs/events.md
    // § event families) — the CLI derives "nothing to batch" from the silent
    // dispatch, exactly like an empty integrate run.
    return { state, events: [], effects: [] }
  }

  const candidatePr = parseCandidatePr(command.args?.pr) ?? nextPrId(state)
  if (state.prs[candidatePr]) {
    throw new Error(`bay: batch-build: PR '${candidatePr}' already exists — batch candidate ids must be unique`)
  }

  const max = parsePositiveInt(command.args?.max, "max") ?? opts.max
  const members = queued.map((pr) => ({ pr: pr.id, target: queueTarget(state, pr.id) }))
  const effect: Effect = {
    type: FX_BATCH_BUILD,
    data: {
      batch: candidatePr,
      members,
      queueOrder: queueOrder(state),
      max,
      generatedGlobs: [...(opts.generatedGlobs ?? [])],
    },
  }
  return { state, events: [], effects: [effect] }
}

function reduceBatchBisect(opts: BatchBuildOptions, state: BayState, command: BayCommand): TransitionResult {
  const batch = parseRequiredPr(command.args?.pr, "batch-bisect")
  const record = sliceOf(state).batches[batch]
  if (!record) {
    throw new Error(`bay: batch recovery: no batch '${batch}' — build a batch first`)
  }
  if (record.state !== "rejected") {
    throw new Error(`bay: batch recovery: ${batch} is ${record.state} — recovery only runs after a red batch gate`)
  }
  if (record.prefixes.length === 0) {
    throw new Error(`bay: batch recovery: ${batch} has no prefix tips — rebuild the batch first`)
  }

  const gateCommand = parseGateCommand(command.args?.gateCommand, opts.gateCommand)
  if (gateCommand === undefined) {
    throw new Error(
      "bay: batch recovery: no gate command configured — set bay.check so git bay can find the faulting member",
    )
  }

  const rebuiltBatch = parseCandidatePr(command.args?.rebuildPr) ?? nextPrId(state)
  if (state.prs[rebuiltBatch]) {
    throw new Error(`bay: batch recovery: rebuild PR '${rebuiltBatch}' already exists — candidate ids must be unique`)
  }

  return {
    state,
    events: [],
    effects: [{ type: FX_BATCH_BISECT, data: { batch, rebuiltBatch, gateCommand } }],
  }
}

function candidateBranch(opts: BatchBuildOptions, batch: PrId): string {
  return `${opts.candidatePrefix ?? DEFAULT_CANDIDATE_PREFIX}${batch}`
}

function prefixBranch(opts: BatchBuildOptions, batch: PrId, index: number, member: BatchMember): string {
  const root = opts.candidatePrefix ?? DEFAULT_CANDIDATE_PREFIX
  return `${root.replace(/\/$/u, "")}-prefix/${batch}/${index}-${member.pr}`
}

function failGit(action: string, res: { code: number; stderr: string }): never {
  throw new Error(`bay: batch-build: ${action} failed (exit ${res.code}):\n${res.stderr.trim()}`)
}

function mergeConflictDetail(batch: PrId, member: BatchMember, stderr: string): string {
  const tail = stderr.replace(/\s+$/u, "").slice(-1200)
  const suffix = tail === "" ? "" : `\n${tail}`
  return (
    `bay: ${member.pr} ejected from batch ${batch} — scratch merge of ${member.target} failed. ` +
    `Rebuilding batch without it; remainder will land. Fix and retry: git bay retry ${member.pr}.${suffix}`
  )
}

async function mergeMember(scratch: string, batch: PrId, member: BatchMember): Promise<BatchEjection | null> {
  const res = await git(
    [
      "-C",
      scratch,
      "-c",
      "user.name=git bay",
      "-c",
      "user.email=git-bay@example.invalid",
      "merge",
      "--no-ff",
      "-m",
      `bay: batch ${batch} member ${member.pr}`,
      member.target,
    ],
    scratch,
  )
  if (res.code === 0) return null
  await git(["-C", scratch, "merge", "--abort"], scratch)
  return { ...member, detail: mergeConflictDetail(batch, member, res.stderr) }
}

async function publishCandidate(scratch: string, branch: string): Promise<void> {
  const res = await git(["-C", scratch, "branch", "-f", branch, "HEAD"], scratch)
  if (res.code !== 0) failGit(`publish candidate ${branch}`, res)
}

type CandidateBuild = {
  built: BatchMember[]
  ejected: BatchEjection[]
  prefixes: BatchPrefix[]
}

async function buildCandidate(
  scratch: ScratchWorkspaces,
  opts: BatchBuildOptions,
  batch: PrId,
  base: string,
  members: readonly BatchMember[],
): Promise<CandidateBuild> {
  // Compose runs git plumbing only (merge, branch, rev-parse) — a bare
  // checkout suffices, so this acquisition never provisions.
  const lease = await scratch.acquire(base)
  const built: BatchMember[] = []
  const ejected: BatchEjection[] = []
  const prefixes: BatchPrefix[] = []
  try {
    for (const member of members) {
      const ejection = await mergeMember(lease.path, batch, member)
      if (ejection) {
        ejected.push(ejection)
        continue
      }
      const resolved = await git(["-C", lease.path, "rev-parse", "--verify", `${member.target}^{commit}`], lease.path)
      const aboard: BatchMember = resolved.code === 0 ? { ...member, tip: resolved.stdout.trim() } : { ...member }
      built.push(aboard)
      const prefix = {
        ...aboard,
        index: built.length,
        prefixTarget: prefixBranch(opts, batch, built.length, aboard),
      }
      await publishCandidate(lease.path, prefix.prefixTarget)
      prefixes.push(prefix)
    }
    if (built.length > 0) await publishCandidate(lease.path, candidateBranch(opts, batch))
  } finally {
    await lease.dispose()
  }
  return { built, ejected, prefixes }
}

function byTarget(members: readonly BatchMember[]): Map<string, BatchMember> {
  return new Map(members.map((m) => [m.target, m]))
}

function skippedSummary(
  skipped: readonly SkippedTarget[],
): { target: string; reason: "path-overlap" | "batch-full"; overlapWith: string; paths: string[] }[] {
  return skipped.map((s) => ({
    target: s.target,
    reason: s.reason,
    overlapWith: s.overlapWith,
    paths: [...s.paths],
  }))
}

function candidateFirstOrder(order: readonly PrId[], batch: PrId, members: readonly BatchMember[]): PrId[] {
  const memberIds = new Set(members.map((m) => m.pr))
  const firstMemberIndex = order.findIndex((id) => memberIds.has(id))
  if (firstMemberIndex < 0) return [...order, batch]
  const withoutBatch = order.filter((id) => id !== batch)
  const insertAt = Math.min(firstMemberIndex, withoutBatch.length)
  return [...withoutBatch.slice(0, insertAt), batch, ...withoutBatch.slice(insertAt)]
}

function makeBatchBuildHandler(opts: BatchBuildOptions, scratch: ScratchWorkspaces): EffectHandler {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    if (opts.mainRepo.trim() === "") {
      throw new Error("bay: batch-build: mainRepo is required")
    }

    const d = effect.data as {
      batch: PrId
      members: BatchMember[]
      queueOrder: PrId[]
      max?: number
      generatedGlobs: string[]
    }
    const base = await resolveBaseRef(opts.mainRepo)
    const targetToMember = byTarget(d.members)
    const compat = await composeBatch(
      opts.mainRepo,
      base,
      d.members.map((m) => m.target),
      { generatedGlobs: d.generatedGlobs, max: d.max },
    )
    const composed = compat.members.map((target) => targetToMember.get(target)!).filter(Boolean)
    const cause = effect.cause!

    if (composed.length === 0) {
      // Everything was skipped by the compatibility fold — no scratch work
      // happened, but the skip verdict is still a journaled fact.
      return [
        makeEvent(
          bay,
          EV_BATCH_STARTED,
          { batch: d.batch, base, members: [], ejected: [], prefixes: [], skipped: skippedSummary(compat.skipped) },
          cause,
        ),
      ]
    }

    const { built, ejected, prefixes } = await buildCandidate(scratch, opts, d.batch, base, composed)
    const target = built.length > 0 ? candidateBranch(opts, d.batch) : undefined
    const events: BayEvent[] = [
      makeEvent(
        bay,
        EV_BATCH_STARTED,
        {
          batch: d.batch,
          ...(target !== undefined ? { target } : {}),
          base,
          members: built.map(memberSummary),
          ejected: ejected.map((member) => ({ pr: member.pr, target: member.target, detail: member.detail })),
          prefixes: prefixes.map((prefix) => ({
            ...memberSummary(prefix),
            index: prefix.index,
            prefixTarget: prefix.prefixTarget,
          })),
          skipped: skippedSummary(compat.skipped),
        },
        cause,
      ),
    ]

    // Members ride the candidate through ITS check/merge — their own state is
    // `checking` while aboard (only the candidate ever merges; settle journals
    // the members' own outcomes when the candidate lands).
    for (const member of built) {
      events.push(stateChangeEvent(bay, member.pr, "submitted", "checking", cause, { detail: `batched in ${d.batch}` }))
    }
    for (const member of ejected) {
      events.push(
        stateChangeEvent(bay, member.pr, "submitted", "checking", cause, { detail: `build attempted in ${d.batch}` }),
      )
      events.push(
        makeEvent(
          bay,
          EV_BATCH_ISOLATED,
          {
            batch: d.batch,
            outcome: "ejected",
            reason: "build-conflict",
            pr: member.pr,
            target: member.target,
            detail: member.detail,
          },
          cause,
        ),
      )
      events.push(
        stateChangeEvent(bay, member.pr, "checking", "rejected", cause, {
          code: "merge-conflict",
          detail: member.detail,
        }),
      )
    }

    if (built.length > 0 && target !== undefined) {
      events.push(prOpenedEvent(bay, d.batch, target, `batch:${d.batch}`, "submit", true, cause))
      events.push(queueReorderedEvent(bay, candidateFirstOrder(d.queueOrder, d.batch, built), cause, `batch ${d.batch}`))
    }

    return events
  }
}

function tail(text: string, max = 1200): string {
  const trimmed = text.replace(/\s+$/u, "")
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}

async function runGateCommand(
  gateCommand: string,
  cwd: string,
  batch: PrId,
  subst: { pr?: PrId; target: string; memberTarget?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  let cmd = gateCommand.replaceAll("{batch}", batch).replaceAll("{target}", subst.target)
  if (subst.pr !== undefined) {
    cmd = cmd.replaceAll("{pr}", subst.pr).replaceAll("{member}", subst.pr)
  }
  const env = {
    ...repoScopedCleanEnv(),
    BAY_BATCH: batch,
    BAY_BATCH_TARGET: subst.target,
    ...(subst.pr !== undefined ? { BAY_BATCH_PR: subst.pr, BAY_BATCH_MEMBER: subst.pr } : {}),
    ...(subst.memberTarget !== undefined ? { BAY_BATCH_MEMBER_TARGET: subst.memberTarget } : {}),
  }
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe", env })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

type GateVerdict = { ok: boolean; detail?: string }

function gateVerdict(res: { code: number; stdout: string; stderr: string }): GateVerdict {
  if (res.code === 0) return { ok: true }
  const out = tail([res.stderr, res.stdout].filter((s) => s.trim() !== "").join("\n"))
  return { ok: false, detail: out === "" ? `exit ${res.code}` : `exit ${res.code}: ${out}` }
}

async function checkPrefix(
  scratch: ScratchWorkspaces,
  gateCommand: string,
  batch: PrId,
  prefix: BatchPrefix,
): Promise<GateVerdict> {
  const lease = await scratch.acquire(prefix.prefixTarget, { provision: true })
  try {
    return gateVerdict(
      await runGateCommand(gateCommand, lease.path, batch, {
        pr: prefix.pr,
        target: prefix.prefixTarget,
        memberTarget: prefix.target,
      }),
    )
  } finally {
    await lease.dispose()
  }
}

/** The all-red-env guard's other half: gate the UNTOUCHED batch base first. A
 *  red baseline means the environment, the gate command, or the mainline
 *  itself is at fault — walking prefixes would eject the first member for a
 *  failure it did not cause. */
async function checkBaseline(
  scratch: ScratchWorkspaces,
  gateCommand: string,
  batch: PrId,
  base: string,
): Promise<GateVerdict> {
  const lease = await scratch.acquire(base, { provision: true })
  try {
    return gateVerdict(await runGateCommand(gateCommand, lease.path, batch, { target: base }))
  } finally {
    await lease.dispose()
  }
}

function redPrefixDetail(batch: PrId, gateCommand: string, prefix: BatchPrefix, detail: string | undefined): string {
  const suffix = detail === undefined || detail === "" ? "" : `\n${detail}`
  return (
    `bay: ${prefix.pr} ejected from batch ${batch} — first red batch prefix ${prefix.prefixTarget} ` +
    `failed gate '${gateCommand}'. Rebuilding batch without it; remainder will land. ` +
    `Fix and retry: git bay retry ${prefix.pr}.${suffix}`
  )
}

function rejectMemberEvents(
  bay: BayRuntime,
  state: BayState,
  member: BatchMember,
  detail: string,
  cause: Cause,
  code: "check-failed" | "merge-conflict",
): BayEvent[] {
  const pr = state.prs[member.pr]
  if (!pr || pr.state === "rejected") return []
  if (pr.state === "submitted") {
    return [
      stateChangeEvent(bay, member.pr, "submitted", "checking", cause, { detail: "build attempted before ejection" }),
      stateChangeEvent(bay, member.pr, "checking", "rejected", cause, { code, detail }),
    ]
  }
  if (pr.state === "checking") {
    return [stateChangeEvent(bay, member.pr, "checking", "rejected", cause, { code, detail })]
  }
  throw new Error(`bay: batch recovery: cannot reject ${member.pr} from state ${pr.state}`)
}

function makeBatchBisectHandler(opts: BatchBuildOptions, scratch: ScratchWorkspaces): EffectHandler {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    if (opts.mainRepo.trim() === "") {
      throw new Error("bay: batch recovery: mainRepo is required")
    }

    const d = effect.data as { batch: PrId; rebuiltBatch: PrId; gateCommand: string }
    const state = await bay.state()
    const record = sliceOf(state).batches[d.batch]
    if (!record) throw new Error(`bay: batch recovery: no batch '${d.batch}'`)
    if (record.state !== "rejected") {
      throw new Error(`bay: batch recovery: ${d.batch} is ${record.state} — recovery only runs after rejection`)
    }

    const cause = effect.cause!
    // Refusals are journaled domain verdicts, never throws — a throw here
    // would discard the walk evidence already collected (the old all-green
    // behavior) and leave stats blind to why recovery stopped.
    const refused = (reason: "baseline-red" | "all-green" | "provision-failed", detail: string): BayEvent =>
      makeEvent(bay, EV_BATCH_ISOLATED, { batch: d.batch, outcome: "refused", reason, detail }, cause)
    const provisionRefusal = (err: ProvisionError): string =>
      `${err.message}\nAn environment fault — no member was ejected. Fix the provision command ` +
      `(git config bay.provision), then: git bay retry ${d.batch}.`

    const events: BayEvent[] = []

    // The all-red-env guard's other half: gate the UNTOUCHED batch base first.
    const baselineRun = { step: "check" as const, batch: d.batch, target: record.base, role: "baseline" as const }
    events.push(stepStarted(bay, baselineRun, cause))
    let baseline: GateVerdict
    try {
      baseline = await checkBaseline(scratch, d.gateCommand, d.batch, record.base)
    } catch (err) {
      if (err instanceof ProvisionError) {
        events.push(stepFinished(bay, baselineRun, false, err.message, cause))
        return [...events, refused("provision-failed", provisionRefusal(err))]
      }
      throw err
    }
    events.push(stepFinished(bay, baselineRun, baseline.ok, baseline.detail, cause))
    if (!baseline.ok) {
      return [
        ...events,
        refused(
          "baseline-red",
          `gate '${d.gateCommand}' is red on the batch base itself (${record.base}) — an environment or ` +
            `mainline fault, not a member fault; no member was ejected. Fix the gate/environment (or the base), ` +
            `then: git bay retry ${d.batch}.${baseline.detail === undefined ? "" : `\n${baseline.detail}`}`,
        ),
      ]
    }

    let faulting: BatchPrefix | undefined
    let faultingDetail: string | undefined
    for (const prefix of record.prefixes) {
      const prefixRun = {
        step: "check" as const,
        batch: d.batch,
        pr: prefix.pr,
        target: prefix.prefixTarget,
        memberTarget: prefix.target,
        index: prefix.index,
        role: "prefix" as const,
      }
      events.push(stepStarted(bay, prefixRun, cause))
      let checked: GateVerdict
      try {
        checked = await checkPrefix(scratch, d.gateCommand, d.batch, prefix)
      } catch (err) {
        if (err instanceof ProvisionError) {
          events.push(stepFinished(bay, prefixRun, false, err.message, cause))
          return [...events, refused("provision-failed", provisionRefusal(err))]
        }
        throw err
      }
      events.push(stepFinished(bay, prefixRun, checked.ok, checked.detail, cause))
      if (!checked.ok) {
        faulting = prefix
        faultingDetail = checked.detail
        break
      }
    }

    if (!faulting) {
      return [
        ...events,
        refused(
          "all-green",
          `gate command passed every prefix for rejected batch ${d.batch} — the per-member gate is lying or ` +
            `does not match the red batch gate; no member was ejected. Fix the gate to reproduce the batch's ` +
            `red verdict, then: git bay retry ${d.batch}.`,
        ),
      ]
    }

    const detail = redPrefixDetail(d.batch, d.gateCommand, faulting, faultingDetail)
    events.push(
      makeEvent(
        bay,
        EV_BATCH_ISOLATED,
        {
          batch: d.batch,
          outcome: "ejected",
          reason: "gate-red",
          pr: faulting.pr,
          target: faulting.target,
          detail,
        },
        cause,
      ),
    )
    events.push(...rejectMemberEvents(bay, state, faulting, detail, cause, "check-failed"))

    const remainder = record.members.filter((member) => member.pr !== faulting.pr)
    if (remainder.length === 0) return events

    const rebuilt = await buildCandidate(scratch, opts, d.rebuiltBatch, record.base, remainder)
    const rebuiltTarget = rebuilt.built.length > 0 ? candidateBranch(opts, d.rebuiltBatch) : undefined
    events.push(
      makeEvent(
        bay,
        EV_BATCH_STARTED,
        {
          batch: d.rebuiltBatch,
          ...(rebuiltTarget !== undefined ? { target: rebuiltTarget } : {}),
          base: record.base,
          members: rebuilt.built.map(memberSummary),
          ejected: rebuilt.ejected.map((member) => ({ pr: member.pr, target: member.target, detail: member.detail })),
          prefixes: rebuilt.prefixes.map((prefix) => ({
            ...memberSummary(prefix),
            index: prefix.index,
            prefixTarget: prefix.prefixTarget,
          })),
          skipped: [],
          sourceBatch: d.batch,
        },
        cause,
      ),
    )
    for (const member of rebuilt.ejected) {
      events.push(
        makeEvent(
          bay,
          EV_BATCH_ISOLATED,
          {
            batch: d.rebuiltBatch,
            outcome: "ejected",
            reason: "build-conflict",
            pr: member.pr,
            target: member.target,
            detail: member.detail,
          },
          cause,
        ),
      )
      events.push(...rejectMemberEvents(bay, state, member, member.detail, cause, "merge-conflict"))
    }

    if (rebuilt.built.length > 0 && rebuiltTarget !== undefined) {
      events.push(prOpenedEvent(bay, d.rebuiltBatch, rebuiltTarget, `batch:${d.rebuiltBatch}`, "submit", true, cause))
      events.push(
        queueReorderedEvent(
          bay,
          candidateFirstOrder(queueOrder(state), d.rebuiltBatch, rebuilt.built),
          cause,
          `batch ${d.rebuiltBatch} after ejecting ${faulting.pr} from ${d.batch}`,
        ),
      )
    }

    return events
  }
}

/** Fold the CANDIDATE's terminal outcome onto its batch record. Member
 *  outcomes are deliberately NOT inferred here anymore (LE-5): settle journals
 *  a real `pr/changed` per member (plus `batch/settled`), so replay consumers
 *  read member truth from the journal, not from a fold-only flip. */
function applyCandidateOutcome(state: BayState, batch: PrId, to: unknown, sha: string | undefined): BayState {
  if (to !== "merged" && to !== "rejected") return state
  const slice = sliceOf(state)
  const record = slice.batches[batch]
  if (!record) return state
  return {
    ...state,
    slices: {
      ...state.slices,
      [LAYER]: {
        batches: {
          ...slice.batches,
          [batch]: { ...record, state: to, ...(to === "merged" && sha !== undefined ? { landedSha: sha } : {}) },
        },
      },
    },
  }
}

/** The settle events for a landed candidate: one `pr/changed` → merged per
 *  member still aboard (sha = the compose-time tip; the lying-merge guard
 *  proved the candidate — hence every tip — an ancestor of the mainline),
 *  plus one `batch/settled` summary. Idempotent: a settled record, a
 *  non-merged record, or an unknown batch derives nothing. Shared by the
 *  automatic post-integrate effect and the `batch-settle` recovery command
 *  (the crash window between the candidate's merged event and these events). */
function deriveSettleEvents(bay: BayRuntime, state: BayState, batch: PrId, cause: Cause): BayEvent[] {
  const record = sliceOf(state).batches[batch]
  if (!record || record.state !== "merged" || record.settled === true) return []
  const events: BayEvent[] = []
  for (const member of record.members) {
    const pr = state.prs[member.pr]
    if (!pr || pr.state !== "checking") continue
    events.push(
      stateChangeEvent(bay, member.pr, "checking", "merged", cause, {
        ...(member.tip !== undefined ? { sha: member.tip } : {}),
        detail: `merged via batch ${batch}${record.landedSha === undefined ? "" : ` (candidate ${record.landedSha.slice(0, 8)})`}`,
      }),
    )
  }
  events.push(
    makeEvent(
      bay,
      EV_BATCH_FINISHED,
      {
        batch,
        ...(record.landedSha !== undefined ? { landedSha: record.landedSha } : {}),
        members: record.members.map(memberSummary),
      },
      cause,
    ),
  )
  return events
}

/** `batch-settle <PR>` — the recovery spelling of the automatic settle effect,
 *  for a journal whose candidate landed but whose settle events never wrote
 *  (crash between the two). Re-running it after a successful settle is a
 *  non-event. */
function reduceBatchSettle(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const batch = parseRequiredPr(command.args?.pr, "batch-settle")
  const record = sliceOf(state).batches[batch]
  if (!record) {
    throw new Error(`bay: batch-settle: no batch '${batch}' — git bay ls lists PRs and batches`)
  }
  return { state, events: deriveSettleEvents(bay, state, batch, command.cause!), effects: [] }
}

function apply(state: BayState, event: BayEvent): BayState {
  if (event.name === EV_BATCH_STARTED) {
    const d = event.data as {
      batch: PrId
      target?: string
      base: string
      members: BatchMember[]
      ejected: BatchEjection[]
      prefixes?: BatchPrefix[]
    }
    // No published candidate (every member ejected at build) = no record: the
    // batch PR does not exist, so there is nothing for drain/settle to track.
    if (d.target === undefined) return state
    const slice = sliceOf(state)
    return {
      ...state,
      slices: {
        ...state.slices,
        [LAYER]: {
          batches: {
            ...slice.batches,
            [d.batch]: {
              batch: d.batch,
              target: d.target,
              base: d.base,
              members: d.members,
              ejected: d.ejected,
              prefixes: d.prefixes ?? [],
              state: "built",
            },
          },
        },
      },
    }
  }

  if (event.name === EV_BATCH_ISOLATED) {
    const d = event.data as { batch?: PrId; outcome?: string; pr?: PrId; target?: string; detail?: string }
    if (d.outcome !== "ejected" || !d.batch || !d.pr || !d.target || d.detail === undefined) return state
    const slice = sliceOf(state)
    const record = slice.batches[d.batch]
    if (!record) return state
    const already = record.ejected.some((member) => member.pr === d.pr)
    if (already) return state
    return {
      ...state,
      slices: {
        ...state.slices,
        [LAYER]: {
          batches: {
            ...slice.batches,
            [d.batch]: {
              ...record,
              ejected: [...record.ejected, { pr: d.pr, target: d.target, detail: d.detail }],
            },
          },
        },
      },
    }
  }

  if (event.name === EV_BATCH_FINISHED) {
    const d = event.data as { batch?: PrId }
    if (!d.batch) return state
    const slice = sliceOf(state)
    const record = slice.batches[d.batch]
    if (!record) return state
    return {
      ...state,
      slices: {
        ...state.slices,
        [LAYER]: {
          batches: {
            ...slice.batches,
            [d.batch]: { ...record, settled: true },
          },
        },
      },
    }
  }

  if (event.name === "pr/changed") {
    const d = event.data as { pr?: PrId; to?: unknown; sha?: string }
    if (d.pr) return applyCandidateOutcome(state, d.pr, d.to, d.sha)
  }

  return state
}

export function withBatchBuild(opts: BatchBuildOptions): BayPlugin {
  const scratch =
    opts.scratch ??
    createScratchWorkspaces({
      mainRepo: opts.mainRepo,
      scratchParent: opts.scratchParent,
      provisionCommand: opts.provisionCommand,
      prefix: "gitbay-batch-",
    })
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      apply,
      reduce(state, command, next) {
        if (command.type === "batch-build") return reduceBatchBuild(opts, bay, state, command)
        if (command.type === "batch-bisect") return reduceBatchBisect(opts, state, command)
        if (command.type === "batch-settle") return reduceBatchSettle(bay, state, command)
        const result = next(state, command)
        if (command.type !== "integrate" && command.type !== "merge") return result
        // A landing verb touched a batch CANDIDATE (the reducer's own
        // pr/changed names it) — append a settle effect so the members'
        // outcomes become journal truth in the SAME dispatch, right after the
        // merge effect journals the candidate's verdict (the core folds each
        // effect's events before the next effect runs).
        const batches = sliceOf(state).batches
        const touched = new Set<PrId>()
        for (const e of result.events) {
          if (e.name !== "pr/changed") continue
          const pr = (e.data as { pr?: PrId }).pr
          if (pr !== undefined && batches[pr] && batches[pr].settled !== true) touched.add(pr)
        }
        if (touched.size === 0) return result
        return {
          ...result,
          effects: [...result.effects, ...[...touched].map((batch) => ({ type: FX_BATCH_SETTLE, data: { batch } }))],
        }
      },
      effects: {
        [FX_BATCH_BUILD]: makeBatchBuildHandler(opts, scratch),
        [FX_BATCH_BISECT]: makeBatchBisectHandler(opts, scratch),
        [FX_BATCH_SETTLE]: async (effect: Effect, bayRt: BayRuntime): Promise<BayEvent[]> => {
          const d = effect.data as { batch: PrId }
          const state = await bayRt.state()
          return deriveSettleEvents(bayRt, state, d.batch, effect.cause!)
        },
      },
    }
    return bay.use(layer)
  }
}
