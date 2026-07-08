import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeBatch, type SkippedTarget } from "../batch-compat.ts"
import { makeEvent } from "../core.ts"
import { nextPrId } from "../ids.ts"
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
  TransitionResult,
} from "../types.ts"
import { git, repoScopedCleanEnv, resolveBaseRef } from "./git.ts"
import { prOpenedEvent, queuedPrs, queueOrder, queueReorderedEvent, queueTarget, stateChangeEvent } from "./queue.ts"

const LAYER = "batch-build"
const FX_BATCH_BUILD = "batch.build"
const FX_BATCH_BISECT = "batch.bisect"
const EV_BATCH_EMPTY = "batch.empty"
const EV_BATCH_COMPOSED = "batch.composed"
const EV_BATCH_BUILT = "batch.built"
const EV_BATCH_BISECT_CHECKED = "batch.bisect.checked"
const EV_MEMBER_EJECTED = "batch.member.ejected"
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
}

type BatchMember = {
  pr: PrId
  target: string
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

function memberSummary(member: BatchMember): Record<string, string> {
  return { pr: member.pr, target: member.target }
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
    throw new Error("bay: batch-bisect: 'gateCommand' must be a non-empty string when provided")
  }
  return value
}

function reduceBatchBuild(
  opts: BatchBuildOptions,
  bay: BayRuntime,
  state: BayState,
  command: BayCommand,
): TransitionResult {
  const queued = queuedPrs(state)
  if (queued.length === 0) {
    return { state, events: [makeEvent(bay, EV_BATCH_EMPTY)], effects: [] }
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
    throw new Error(`bay: batch-bisect: no batch '${batch}' — run batch-build first`)
  }
  if (record.state !== "rejected") {
    throw new Error(`bay: batch-bisect: ${batch} is ${record.state} — bisect only runs after a red train gate`)
  }
  if (record.prefixes.length === 0) {
    throw new Error(`bay: batch-bisect: ${batch} has no prefix tips — rebuild the batch before bisecting`)
  }

  const gateCommand = parseGateCommand(command.args?.gateCommand, opts.gateCommand)
  if (gateCommand === undefined) {
    throw new Error(
      "bay: batch-bisect: no gate command configured — pass gateCommand or set withBatchBuild({ gateCommand })",
    )
  }

  const rebuiltBatch = parseCandidatePr(command.args?.rebuildPr) ?? nextPrId(state)
  if (state.prs[rebuiltBatch]) {
    throw new Error(`bay: batch-bisect: rebuild PR '${rebuiltBatch}' already exists — candidate ids must be unique`)
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

async function addScratchWorktree(repo: string, scratch: string, base: string): Promise<void> {
  const res = await git(["-C", repo, "worktree", "add", "--detach", scratch, base], repo)
  if (res.code !== 0) failGit("scratch worktree add", res)
}

async function removeScratchWorktree(repo: string, scratch: string): Promise<void> {
  const removed = await git(["-C", repo, "worktree", "remove", "--force", scratch], repo)
  if (removed.code !== 0) await rm(scratch, { recursive: true, force: true })
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
  opts: BatchBuildOptions,
  batch: PrId,
  base: string,
  members: readonly BatchMember[],
): Promise<CandidateBuild> {
  const scratch = await mkdtemp(join(opts.scratchParent ?? tmpdir(), "gitbay-batch-build-"))
  const built: BatchMember[] = []
  const ejected: BatchEjection[] = []
  const prefixes: BatchPrefix[] = []
  try {
    await addScratchWorktree(opts.mainRepo, scratch, base)
    for (const member of members) {
      const ejection = await mergeMember(scratch, batch, member)
      if (ejection) {
        ejected.push(ejection)
        continue
      }
      built.push(member)
      const prefix = {
        ...member,
        index: built.length,
        prefixTarget: prefixBranch(opts, batch, built.length, member),
      }
      await publishCandidate(scratch, prefix.prefixTarget)
      prefixes.push(prefix)
    }
    if (built.length > 0) await publishCandidate(scratch, candidateBranch(opts, batch))
  } finally {
    await removeScratchWorktree(opts.mainRepo, scratch)
  }
  return { built, ejected, prefixes }
}

function byTarget(members: readonly BatchMember[]): Map<string, BatchMember> {
  return new Map(members.map((m) => [m.target, m]))
}

function skippedSummary(skipped: readonly SkippedTarget[]): Record<string, unknown>[] {
  return skipped.map((s) => ({
    target: s.target,
    reason: s.reason,
    overlapWith: s.overlapWith,
    paths: s.paths,
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

function makeBatchBuildHandler(opts: BatchBuildOptions): EffectHandler {
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
    const events: BayEvent[] = [
      makeEvent(
        bay,
        EV_BATCH_COMPOSED,
        {
          batch: d.batch,
          base,
          members: composed.map(memberSummary),
          skipped: skippedSummary(compat.skipped),
        },
        { pr: d.batch },
      ),
    ]

    if (composed.length === 0) return events

    const { built, ejected, prefixes } = await buildCandidate(opts, d.batch, base, composed)

    for (const member of built) {
      events.push(stateChangeEvent(bay, member.pr, "queued", "merging", `batched in ${d.batch}`))
    }
    for (const member of ejected) {
      events.push(stateChangeEvent(bay, member.pr, "queued", "merging", `build attempted in ${d.batch}`))
      events.push(
        makeEvent(
          bay,
          EV_MEMBER_EJECTED,
          {
            batch: d.batch,
            ...memberSummary(member),
            detail: member.detail,
          },
          { pr: member.pr },
        ),
      )
      events.push(stateChangeEvent(bay, member.pr, "merging", "rejected", member.detail))
    }

    if (built.length > 0) {
      const target = candidateBranch(opts, d.batch)
      events.push(prOpenedEvent(bay, d.batch, target, `batch:${d.batch}`))
      events.push(queueReorderedEvent(bay, candidateFirstOrder(d.queueOrder, d.batch, built), `batch ${d.batch}`))
      events.push(
        makeEvent(
          bay,
          EV_BATCH_BUILT,
          {
            batch: d.batch,
            target,
            base,
            members: built.map(memberSummary),
            ejected: ejected.map((member) => ({ ...memberSummary(member), detail: member.detail })),
            prefixes: prefixes.map((prefix) => ({
              ...memberSummary(prefix),
              index: prefix.index,
              prefixTarget: prefix.prefixTarget,
            })),
          },
          { pr: d.batch },
        ),
      )
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
  scratch: string,
  batch: PrId,
  prefix: BatchPrefix,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = gateCommand
    .replaceAll("{batch}", batch)
    .replaceAll("{pr}", prefix.pr)
    .replaceAll("{member}", prefix.pr)
    .replaceAll("{target}", prefix.prefixTarget)
  const env = {
    ...repoScopedCleanEnv(),
    BAY_BATCH: batch,
    BAY_BATCH_PR: prefix.pr,
    BAY_BATCH_MEMBER: prefix.pr,
    BAY_BATCH_TARGET: prefix.prefixTarget,
    BAY_BATCH_MEMBER_TARGET: prefix.target,
  }
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd: scratch, stdout: "pipe", stderr: "pipe", env })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

async function checkPrefix(
  opts: BatchBuildOptions,
  gateCommand: string,
  batch: PrId,
  prefix: BatchPrefix,
): Promise<{ ok: boolean; detail?: string }> {
  const scratch = await mkdtemp(join(opts.scratchParent ?? tmpdir(), "gitbay-batch-bisect-"))
  try {
    await addScratchWorktree(opts.mainRepo, scratch, prefix.prefixTarget)
    const res = await runGateCommand(gateCommand, scratch, batch, prefix)
    if (res.code === 0) return { ok: true }
    const out = tail([res.stderr, res.stdout].filter((s) => s.trim() !== "").join("\n"))
    return { ok: false, detail: out === "" ? `exit ${res.code}` : `exit ${res.code}: ${out}` }
  } finally {
    await removeScratchWorktree(opts.mainRepo, scratch)
  }
}

function redPrefixDetail(batch: PrId, gateCommand: string, prefix: BatchPrefix, detail: string | undefined): string {
  const suffix = detail === undefined || detail === "" ? "" : `\n${detail}`
  return (
    `bay: ${prefix.pr} ejected from batch ${batch} — first red train prefix ${prefix.prefixTarget} ` +
    `failed gate '${gateCommand}'. Rebuilding batch without it; remainder will land. ` +
    `Fix and retry: git bay retry ${prefix.pr}.${suffix}`
  )
}

function rejectMemberEvents(bay: BayRuntime, state: BayState, member: BatchMember, detail: string): BayEvent[] {
  const pr = state.prs[member.pr]
  if (!pr || pr.state === "rejected") return []
  if (pr.state === "queued") {
    return [
      stateChangeEvent(bay, member.pr, "queued", "merging", "build attempted before ejection"),
      stateChangeEvent(bay, member.pr, "merging", "rejected", detail),
    ]
  }
  if (pr.state === "merging") return [stateChangeEvent(bay, member.pr, "merging", "rejected", detail)]
  throw new Error(`bay: batch-bisect: cannot reject ${member.pr} from state ${pr.state}`)
}

function makeBatchBisectHandler(opts: BatchBuildOptions): EffectHandler {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    if (opts.mainRepo.trim() === "") {
      throw new Error("bay: batch-bisect: mainRepo is required")
    }

    const d = effect.data as { batch: PrId; rebuiltBatch: PrId; gateCommand: string }
    const state = await bay.state()
    const record = sliceOf(state).batches[d.batch]
    if (!record) throw new Error(`bay: batch-bisect: no batch '${d.batch}'`)
    if (record.state !== "rejected") {
      throw new Error(`bay: batch-bisect: ${d.batch} is ${record.state} — bisect only runs after rejection`)
    }

    const events: BayEvent[] = []
    let culprit: BatchPrefix | undefined
    let culpritDetail: string | undefined
    for (const prefix of record.prefixes) {
      const checked = await checkPrefix(opts, d.gateCommand, d.batch, prefix)
      events.push(
        makeEvent(
          bay,
          EV_BATCH_BISECT_CHECKED,
          {
            batch: d.batch,
            pr: prefix.pr,
            target: prefix.prefixTarget,
            memberTarget: prefix.target,
            index: prefix.index,
            ok: checked.ok,
            ...(checked.detail !== undefined ? { detail: checked.detail } : {}),
          },
          { pr: d.batch },
        ),
      )
      if (!checked.ok) {
        culprit = prefix
        culpritDetail = checked.detail
        break
      }
    }

    if (!culprit) {
      throw new Error(
        `bay: batch-bisect: gate command passed every prefix for rejected batch ${d.batch}; ` +
          `refusing to rebuild because the per-member gate is lying or does not match the red train gate`,
      )
    }

    const detail = redPrefixDetail(d.batch, d.gateCommand, culprit, culpritDetail)
    events.push(
      makeEvent(
        bay,
        EV_MEMBER_EJECTED,
        {
          batch: d.batch,
          ...memberSummary(culprit),
          detail,
        },
        { pr: culprit.pr },
      ),
    )
    events.push(...rejectMemberEvents(bay, state, culprit, detail))

    const remainder = record.members.filter((member) => member.pr !== culprit!.pr)
    if (remainder.length === 0) return events

    const rebuilt = await buildCandidate(opts, d.rebuiltBatch, record.base, remainder)
    for (const member of rebuilt.ejected) {
      events.push(
        makeEvent(
          bay,
          EV_MEMBER_EJECTED,
          {
            batch: d.rebuiltBatch,
            ...memberSummary(member),
            detail: member.detail,
          },
          { pr: member.pr },
        ),
      )
      events.push(...rejectMemberEvents(bay, state, member, member.detail))
    }

    if (rebuilt.built.length > 0) {
      const target = candidateBranch(opts, d.rebuiltBatch)
      events.push(prOpenedEvent(bay, d.rebuiltBatch, target, `batch:${d.rebuiltBatch}`))
      events.push(
        queueReorderedEvent(
          bay,
          candidateFirstOrder(queueOrder(state), d.rebuiltBatch, rebuilt.built),
          `batch ${d.rebuiltBatch} after ejecting ${culprit.pr} from ${d.batch}`,
        ),
      )
      events.push(
        makeEvent(
          bay,
          EV_BATCH_BUILT,
          {
            batch: d.rebuiltBatch,
            target,
            base: record.base,
            members: rebuilt.built.map(memberSummary),
            ejected: rebuilt.ejected.map((member) => ({ ...memberSummary(member), detail: member.detail })),
            prefixes: rebuilt.prefixes.map((prefix) => ({
              ...memberSummary(prefix),
              index: prefix.index,
              prefixTarget: prefix.prefixTarget,
            })),
            sourceBatch: d.batch,
          },
          { pr: d.rebuiltBatch },
        ),
      )
    }

    return events
  }
}

function applyCandidateResultToMembers(state: BayState, batch: PrId, to: unknown): BayState {
  if (to !== "merged" && to !== "rejected") return state
  const record = sliceOf(state).batches[batch]
  if (!record) return state
  const prs = { ...state.prs }
  if (to === "merged") {
    for (const member of record.members) {
      const existing = prs[member.pr]
      if (existing) prs[member.pr] = { ...existing, state: to }
    }
  }
  const slice = sliceOf(state)
  return {
    ...state,
    prs,
    slices: {
      ...state.slices,
      [LAYER]: {
        batches: {
          ...slice.batches,
          [batch]: { ...record, state: to },
        },
      },
    },
  }
}

function apply(state: BayState, event: BayEvent): BayState {
  if (event.type === EV_BATCH_BUILT) {
    const d = event.data as {
      batch: PrId
      target: string
      base: string
      members: BatchMember[]
      ejected: BatchEjection[]
      prefixes?: BatchPrefix[]
    }
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

  if (event.type === EV_MEMBER_EJECTED) {
    const d = event.data as { batch?: PrId; pr?: PrId; target?: string; detail?: string }
    if (!d.batch || !d.pr || !d.target || d.detail === undefined) return state
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

  if (event.type === "pr.state-changed") {
    const d = event.data as { to?: unknown }
    if (event.pr) return applyCandidateResultToMembers(state, event.pr, d.to)
  }

  return state
}

export function withBatchBuild(opts: BatchBuildOptions): BayPlugin {
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      apply,
      reduce(state, command, next) {
        if (command.type === "batch-build") return reduceBatchBuild(opts, bay, state, command)
        if (command.type === "batch-bisect") return reduceBatchBisect(opts, state, command)
        return next(state, command)
      },
      effects: {
        [FX_BATCH_BUILD]: makeBatchBuildHandler(opts),
        [FX_BATCH_BISECT]: makeBatchBisectHandler(opts),
      },
    }
    return bay.use(layer)
  }
}
