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
import { git, resolveBaseRef } from "./git.ts"
import {
  prOpenedEvent,
  queuedPrs,
  queueOrder,
  queueReorderedEvent,
  queueTarget,
  stateChangeEvent,
} from "./queue.ts"

const LAYER = "batch-build"
const FX_BATCH_BUILD = "batch.build"
const EV_BATCH_EMPTY = "batch.empty"
const EV_BATCH_COMPOSED = "batch.composed"
const EV_BATCH_BUILT = "batch.built"
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
}

type BatchMember = {
  pr: PrId
  target: string
}

type BatchEjection = BatchMember & {
  detail: string
}

type BatchRecord = {
  batch: PrId
  target: string
  base: string
  members: BatchMember[]
  ejected: BatchEjection[]
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

function candidateBranch(opts: BatchBuildOptions, batch: PrId): string {
  return `${opts.candidatePrefix ?? DEFAULT_CANDIDATE_PREFIX}${batch}`
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

    const scratch = await mkdtemp(join(opts.scratchParent ?? tmpdir(), "gitbay-batch-build-"))
    const built: BatchMember[] = []
    const ejected: BatchEjection[] = []
    try {
      await addScratchWorktree(opts.mainRepo, scratch, base)
      for (const member of composed) {
        const ejection = await mergeMember(scratch, d.batch, member)
        if (ejection) ejected.push(ejection)
        else built.push(member)
      }
      if (built.length > 0) await publishCandidate(scratch, candidateBranch(opts, d.batch))
    } finally {
      await removeScratchWorktree(opts.mainRepo, scratch)
    }

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
          },
          { pr: d.batch },
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
  for (const member of record.members) {
    const existing = prs[member.pr]
    if (existing) prs[member.pr] = { ...existing, state: to }
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
              state: "built",
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
        return next(state, command)
      },
      effects: {
        [FX_BATCH_BUILD]: makeBatchBuildHandler(opts),
      },
    }
    return bay.use(layer)
  }
}
