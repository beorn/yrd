#!/usr/bin/env bun
// git bay — the CLI host over the era2 library (spec § The verbs; law 2: quiet
// on success, meaningful exit codes, --json everywhere it matters).
//
// Advertised verbs: guide | init | open | close | gc | ls | submit |
// check | merge | integrate | retry | audit. Every pre-v0.3 verb name still
// works as a hidden alias (new, co, checkout, install, setup, abandon, return,
// refresh, ping, status, enqueue, queue, in, int, land, drain, requeue, prime)
// — nothing breaks, nothing is advertised twice. Hook modes (installed by
// init, not user-facing): receive-pre | receive-post

import { existsSync } from "node:fs"
import { Command } from "@silvery/commander/plain"
import { colorizeHelp, shouldColorize } from "@silvery/commander"
import { readFile, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import type { BayCommand, BayEvent, BayRuntime, BayState, Lease, LeaseId, PrId, PullRequest, StepError } from "../src/types.ts"
import { isOpen } from "../src/types.ts"
import { createGitbay } from "../src/core.ts"
import { pipe } from "../src/pipe.ts"
import { createGitConfigSource, resolveOption } from "../src/config.ts"
import { createSqliteStore } from "../src/store/sqlite.ts"
import { createReadStore } from "../src/store/read.ts"
import { withWorktrees, staleLeases, DEFAULT_LEASE_TIMEOUT_MS } from "../src/layers/worktrees.ts"
import { prForTarget, queueTarget, withQueue, submittedPrs } from "../src/layers/queue.ts"
import { withBatchBuild } from "../src/layers/batch-build.ts"
import { withMergeWorker } from "../src/layers/merge-worker.ts"
import { parseStepArtifactRefs } from "../src/layers/artifacts.ts"
import {
  withReceive,
  resolveReceive,
  leaseForBranch,
  parseReceiveStdin,
  preReceiveCheck,
  appendInboxReceipt,
} from "../src/layers/receive.ts"
import { withAdopt } from "../src/layers/adopt.ts"
import { notifyKeyFor, resolveValidateCommand, withIssueTracking } from "../src/layers/issue-tracking.ts"
import { defaultBayDir, git, porcelainStatus, repoScopedCleanEnv, resolveBaseRef } from "../src/layers/git.ts"
import { staleCheckReasons } from "../src/layers/steps.ts"
import { parseTraceparent, readTraceparentEnv } from "../src/trace.ts"
import { bayEventsPath, bayPrsGitPath } from "../src/paths.ts"

// ---------- context ----------

type Ctx = {
  mainRepo: string
  bayDir: string
  repoGit: string
  actor: string
  leaseTimeoutMs?: number
  batchSize: number
  batchGeneratedGlobs: string[]
  batchGateCommand?: string
  /** bay.provision — makes a gate/check scratch runnable (submodules, installs). */
  provisionCommand?: string
}

function parsePositiveConfigInt(raw: string | undefined, key: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`bay: bay.${key} is set to '${raw}' — expected a positive integer`)
  }
  return value
}

function parseConfigList(raw: string | undefined): string[] {
  if (raw === undefined) return []
  return raw
    .split(/[\n,]/u)
    .map((part) => part.trim())
    .filter((part) => part !== "")
}

async function resolveCtx(): Promise<Ctx> {
  // Hooks run inside the bare repo with BAY_MAIN_REPO pinned; interactive runs
  // resolve the main repo via the common dir (a bay worktree shares it).
  let mainRepo = process.env.BAY_MAIN_REPO
  if (!mainRepo) {
    const res = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
    if (res.code !== 0) {
      throw new Error(`bay: not inside a git repository (${res.stderr.trim() || "rev-parse failed"})`)
    }
    const commonDir = res.stdout.trim()
    mainRepo = commonDir.endsWith("/.git") ? commonDir.slice(0, -5) : commonDir
  }
  const source = createGitConfigSource(mainRepo)
  const fallback = await defaultBayDir(mainRepo)
  const bayDir = (await resolveOption(process.env.BAY_DIR, "dir", source, fallback.dir))!
  if (bayDir === fallback.dir && fallback.legacy) {
    console.error(
      `bay: using legacy .bay/ state at ${bayDir} — a working-tree dir does not survive git clean -x sweeps. ` +
        `Migrate: mv .bay .git/bay && git bay init (init refreshes hook paths).`,
    )
  }
  const actor =
    (await resolveOption(process.env.BAY_ACTOR, "actor", source)) ??
    (await source.get("user.name").catch(() => undefined)) ??
    process.env.USER ??
    "bay"
  // TTL git-config tier resolved here at the host boundary (the layer itself
  // only reads inline > env > default, keeping its reducers spawn-free).
  const ttlRaw = await source.get("leaseTimeoutMs")
  let leaseTimeoutMs: number | undefined
  if (ttlRaw !== undefined) {
    leaseTimeoutMs = Number(ttlRaw)
    if (!Number.isFinite(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
      throw new Error(`bay: bay.leaseTimeoutMs is set to '${ttlRaw}' — not a positive number of milliseconds`)
    }
  }
  const batchSize = parsePositiveConfigInt(await source.get("queue.batch-size"), "queue.batch-size", 1)
  const batchGeneratedGlobs = parseConfigList(await source.get("queue.regen-paths"))
  const rawGate = await source.get("check")
  const batchGateCommand = rawGate !== undefined && rawGate.trim() !== "" ? rawGate : undefined
  const rawProvision = await source.get("provision")
  const provisionCommand = rawProvision !== undefined && rawProvision.trim() !== "" ? rawProvision : undefined
  return {
    mainRepo,
    bayDir,
    repoGit: bayPrsGitPath(bayDir),
    actor,
    leaseTimeoutMs,
    batchSize,
    batchGeneratedGlobs,
    batchGateCommand,
    provisionCommand,
  }
}

function buildBay(ctx: Ctx, store: ReturnType<typeof createReadStore>): BayRuntime {
  const runtime = pipe(
    createGitbay({ store, actor: ctx.actor }),
    withWorktrees({ mainRepo: ctx.mainRepo, bayRemote: ctx.repoGit, leaseTimeoutMs: ctx.leaseTimeoutMs }),
    withQueue(),
    withBatchBuild({
      mainRepo: ctx.mainRepo,
      generatedGlobs: ctx.batchGeneratedGlobs,
      max: ctx.batchSize > 1 ? ctx.batchSize : undefined,
      gateCommand: ctx.batchGateCommand,
      provisionCommand: ctx.provisionCommand,
    }),
    withMergeWorker({ configCwd: ctx.mainRepo, mainRepo: ctx.mainRepo, provisionCommand: ctx.provisionCommand }),
    withReceive({ mainRepo: ctx.mainRepo, bayDir: ctx.bayDir }),
    withAdopt(),
    withIssueTracking({ mainRepo: ctx.mainRepo }),
  )
  // TRACEPARENT propagation (docs/events.md § Cause and spans): the CLI is a
  // thin adapter, so this is the one place it reads the header and threads it
  // onto every command's cause. commandId comes from the SAME idGen core
  // itself uses (runtime.idGen), so this mints no separate id sequence.
  const trace = readTraceparentEnv()
  const traced = !trace
    ? runtime
    : {
        ...runtime,
        dispatch: (command: BayCommand) =>
          runtime.dispatch({ ...command, cause: command.cause ?? { commandId: runtime.idGen(), ...trace } }),
      }
  return withIssueNotifyHost(ctx, traced)
}

/**
 * Outbound issue tracking at the ONE dispatch chokepoint (docs/layers/
 * issue-tracking.md § Outbound): after ANY dispatch whose events contain a
 * terminal `pr/changed` (merged/rejected/closed) for a NAMED PR — drain,
 * integrate, retry, close, a fused push's continuation, inbox ingestion —
 * dispatch `issues-notify` so the configured command runs and its outcome is
 * journaled. Wrapping dispatch here (exactly like the TRACEPARENT wrapper)
 * is what makes "some paths notify, some don't" structurally impossible —
 * the same one-seam lesson as 21002's runMerge.
 *
 * A failed notify command NEVER fails the verb that triggered it (the merge
 * already happened) — it prints loud to stderr and is journaled as
 * `issues/notified` with the nonzero exit code.
 */
function withIssueNotifyHost(ctx: Ctx, runtime: BayRuntime): BayRuntime {
  const source = createGitConfigSource(ctx.mainRepo)
  const configured = new Map<string, boolean>()
  async function hasCommand(key: string): Promise<boolean> {
    if (!configured.has(key)) {
      const v = await source.get(key)
      configured.set(key, v !== undefined && v.trim() !== "" && v.trim() !== "none")
    }
    return configured.get(key)!
  }
  return {
    ...runtime,
    dispatch: async (command: BayCommand) => {
      const result = await runtime.dispatch(command)
      if (command.type === "issues-notify") return result
      for (const e of result.events) {
        if (e.name !== "pr/changed") continue
        const d = e.data as { pr: PrId; to: string; code?: string; detail?: string; sha?: string }
        const key = notifyKeyFor(d.to)
        if (key === undefined || !(await hasCommand(key))) continue
        const name = (await runtime.state()).prs[d.pr]?.name
        if (!name) continue // unnamed PR — no issue to notify (adopt's audit-warned ramp)
        // Synthetic batch-candidate name — not a real workitem. Members carry
        // the real names and notify individually via their settle-journaled
        // pr/changed events in this same dispatch.
        if (name.startsWith("batch:")) continue
        const { events: notified } = await runtime.dispatch({
          type: "issues-notify",
          args: { pr: d.pr, to: d.to, name, sha: d.sha, code: d.code, detail: d.detail },
        })
        for (const n of notified) {
          if (n.name !== "issues/notified") continue
          const nd = n.data as { name: string; on: string; code: number; detail?: string }
          if (nd.code === 0) {
            console.log(`bay: issue '${nd.name}' notified (${nd.on})`)
          } else {
            console.error(
              `bay: issue notify FAILED for '${nd.name}' (${nd.on}) — exit ${nd.code}${nd.detail ? `: ${nd.detail}` : ""} — journaled`,
            )
          }
        }
      }
      return result
    },
  }
}

async function withWriteBay<T>(ctx: Ctx, fn: (bay: BayRuntime) => Promise<T>): Promise<T> {
  const store = await createSqliteStore({ dir: ctx.bayDir })
  try {
    return await fn(buildBay(ctx, store))
  } finally {
    await store.close()
  }
}

function readBay(ctx: Ctx): BayRuntime {
  return buildBay(ctx, createReadStore(ctx.bayDir))
}

// ---------- dual addressing (PR number | wt-id | name) ----------

/** The worktrees slice's worktree index, read loosely (empty when absent). */
function byWorktreeOf(state: BayState): Record<number, LeaseId> {
  const slice = state.slices.worktrees as { byWorktree?: Record<number, LeaseId> } | undefined
  return slice?.byWorktree ?? {}
}

/** wt-label (wt1, wt2, …) for an open lease, from the worktrees slice. */
function wtLabelFor(state: BayState, leaseId: LeaseId): string | undefined {
  for (const [num, held] of Object.entries(byWorktreeOf(state))) {
    if (held === leaseId) return `wt${num}`
  }
  return undefined
}

/** Resolve a PR-verb argument: exact PR number → open worktree's pre-minted
 *  number (wt-id) → unique open PR by name → teaching refusal. The returned id
 *  may not exist in state.prs yet (a worktree that has not pushed) — callers
 *  teach that case with prOrTeach(). */
function resolvePr(state: BayState, token: string): PrId {
  if (state.prs[token]) return token
  const prShaped = /^pr(\d+)$/i.exec(token)
  if (prShaped) {
    const canonical = `PR${prShaped[1]}`
    if (state.prs[canonical]) return canonical
  }
  const wtShaped = /^wt(\d+)$/i.exec(token)
  if (wtShaped) {
    const leaseId = byWorktreeOf(state)[Number(wtShaped[1])]
    const lease = leaseId ? state.leases[leaseId] : undefined
    if (!lease || lease.endedAt !== undefined) {
      throw new Error(`bay: no open worktree wt${wtShaped[1]} — git bay ls shows the open ones`)
    }
    return lease.changeId
  }
  const open = Object.values(state.prs).filter((pr) => pr.name === token && isOpen(pr.state))
  if (open.length === 1) return open[0]!.id
  if (open.length > 1) {
    throw new Error(
      `bay: '${token}' is ambiguous — ${open.length} open PRs carry that name: ` +
        `${open.map((p) => `${p.id} (${p.state})`).join(", ")}. ` +
        `Address one by number, e.g. git bay ls ${open[0]!.id}`,
    )
  }
  // An open worktree with that name whose PR has not opened yet (no push).
  const leases = Object.values(state.leases).filter((l) => l.endedAt === undefined && l.workitem === token)
  if (leases.length === 1) return leases[0]!.changeId
  if (leases.length > 1) {
    throw new Error(
      `bay: '${token}' is ambiguous — ${leases.length} open worktrees carry that name: ` +
        `${leases.map((l) => wtLabelFor(state, l.id) ?? l.id).join(", ")}. Address one by wt-id.`,
    )
  }
  const closed = Object.values(state.prs).filter((pr) => pr.name === token)
  if (closed.length > 0) {
    throw new Error(
      `bay: no open PR named '${token}' — matches: ` +
        `${closed.map((p) => `${p.id} (${p.state})`).join(", ")}. ` +
        `Address it by number, e.g. git bay ls ${closed[0]!.id}`,
    )
  }
  throw new Error(`bay: no PR or worktree named '${token}' — git bay ls lists them`)
}

/** The PR record for a resolved id, or the "no push yet" teaching refusal —
 *  the id can come from a worktree's pre-minted number before any push. Says
 *  "no PR yet" rather than "not open yet" on purpose: `open` is DERIVED
 *  (isOpen), not a state name, so "not open yet" would misleadingly suggest a
 *  stored state that doesn't exist. */
function prOrTeach(state: BayState, prId: PrId, verb: string): PullRequest {
  const pr = state.prs[prId]
  if (pr) return pr
  const lease = Object.values(state.leases).find((l) => l.changeId === prId && l.endedAt === undefined)
  const where = lease
    ? `${wtLabelFor(state, lease.id) ?? "its worktree"} (${lease.workitem ?? lease.branch})`
    : "its worktree"
  throw new Error(
    `bay: ${verb}: ${prId} has no PR yet — nothing has been pushed from ${where}; plain git push opens it`,
  )
}

/** Resolve a worktree-verb argument: wt-id → unique open worktree by name →
 *  teaching refusal. Raw lease ids (L1) still resolve for old scripts, but are
 *  never advertised. */
function resolveWorktree(state: BayState, token: string, verb: string): { lease: Lease; wt: string } {
  const wtShaped = /^wt(\d+)$/i.exec(token)
  if (wtShaped) {
    const leaseId = byWorktreeOf(state)[Number(wtShaped[1])]
    const lease = leaseId ? state.leases[leaseId] : undefined
    if (!lease || lease.endedAt !== undefined) {
      throw new Error(`bay: no open worktree wt${wtShaped[1]} — git bay ls shows the open ones`)
    }
    return { lease, wt: `wt${wtShaped[1]}` }
  }
  if (/^L\d+$/.test(token)) {
    const lease = state.leases[token]
    if (lease && lease.endedAt === undefined) {
      return { lease, wt: wtLabelFor(state, lease.id) ?? token }
    }
  }
  const open = Object.values(state.leases).filter((l) => l.endedAt === undefined && l.workitem === token)
  if (open.length === 1) {
    return { lease: open[0]!, wt: wtLabelFor(state, open[0]!.id) ?? open[0]!.id }
  }
  if (open.length > 1) {
    throw new Error(
      `bay: '${token}' is ambiguous — ${open.length} open worktrees carry that name: ` +
        `${open.map((l) => wtLabelFor(state, l.id) ?? l.id).join(", ")}. ` +
        `Address one by id, e.g. git bay ${verb} ${wtLabelFor(state, open[0]!.id) ?? open[0]!.id}`,
    )
  }
  throw new Error(`bay: no PR or worktree named '${token}' — git bay ls lists them`)
}

// ---------- formatting ----------

function age(fromIso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length)
}

/** BAY/WORKTREE identity split (spec § worktree/bay identity split): BAY is
 *  the named, ephemeral loan (the work); WORKTREE is the numbered, persistent
 *  directory it's holding. Both columns stay in `ls` — only the header label
 *  changes (v0.2 called the loan's column NAME). */
function worktreeTable(state: BayState, actor: string, now: number, ttlMs: number): string {
  const slice = (state.slices["worktrees"] ?? { byWorktree: {} }) as {
    byWorktree: Record<number, string>
    lastActive?: Record<string, string>
  }
  const rows: string[][] = []
  for (const [n, leaseId] of Object.entries(slice.byWorktree).sort(([a], [b]) => Number(a) - Number(b))) {
    const lease = state.leases[leaseId]
    if (!lease) continue
    const you = lease.actor === actor ? "← you" : ""
    // AGE = since the worktree opened (createdAt); IDLE = since the newest
    // activity (what `refresh` resets and what gc measures); STATE flips to
    // `stale` when idle exceeds the timeout — the same predicate gc uses.
    // "active", never "open" — `open` is a derived PR status (isOpen) and
    // this is a worktree's activity, a different axis entirely; never
    // interchange them.
    const last = slice.lastActive?.[leaseId] ?? lease.createdAt
    const st = now - Date.parse(last) > ttlMs ? "stale" : "active"
    rows.push([`wt${n}`, lease.workitem ?? "—", st, age(lease.createdAt, now), age(last, now), you])
  }
  if (rows.length === 0) return "no open worktrees — git bay open <name> opens one"
  const header = ["WORKTREE", "BAY", "STATE", "AGE", "IDLE", ""]
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const fmt = (r: string[]) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : pad(cell, widths[i]! + 2)))
      .join("")
      .trimEnd()
  return [fmt(header), ...rows.map(fmt)].join("\n")
}

function prLine(pr: PullRequest, detail: string | undefined): string {
  if (pr.state === "merged") {
    // detail shape: "merged <sha> onto <mainline>" (submit handler)
    const m = detail?.match(/^merged ([0-9a-f]+) onto (\S+)$/)
    if (m) return `${pr.id} merged ${m[1]} onto ${m[2]} (checks: ✓)`
    return `${pr.id} merged (checks: ✓)`
  }
  if (pr.state === "rejected") return `${pr.id} rejected — ${firstDetailLine(detail) ?? "see journal"}`
  return `${pr.id} ${pr.state}`
}

/** Last recorded state-change detail for a PR, from the event log. */
async function lastDetail(bay: BayRuntime, id: PrId): Promise<string | undefined> {
  let detail: string | undefined
  for await (const ev of bay.store.journal.replay()) {
    if (ev.name !== "pr/changed") continue
    const d = ev.data as { pr: PrId; detail?: string }
    if (d.pr === id && d.detail !== undefined) detail = d.detail
  }
  return detail
}

type StepStatus = {
  ok?: boolean
  waiting?: boolean
  ts: string
  target: string
  detail?: string
  token?: string
  url?: string
  exitCode?: number
  durationMs?: number
  configHash?: string
  skipped?: boolean
  baseSha?: string
  headSha?: string
  error?: StepError
  artifacts?: unknown[]
}

type LineItemStatus = {
  pr: PrId
  state: PullRequest["state"]
  target: string
  targetSha?: string
  stale: boolean
  staleReasons: string[]
  steps: Partial<Record<"check" | "merge" | "deploy", StepStatus>>
}

async function resolveCommit(repo: string, ref: string): Promise<string | undefined> {
  const res = await git(["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo)
  return res.code === 0 ? res.stdout.trim() : undefined
}

async function stepStatusByPr(bay: BayRuntime): Promise<Map<PrId, Partial<Record<"check" | "merge" | "deploy", StepStatus>>>> {
  const stepsByPr = new Map<PrId, Partial<Record<"check" | "merge" | "deploy", StepStatus>>>()
  for await (const ev of bay.store.journal.replay()) {
    if (ev.name !== "line/step/finished" && ev.name !== "line/step/waiting") continue
    const d = ev.data as {
      pr?: PrId
      step?: "check" | "merge" | "deploy"
      target?: string
      ok?: boolean
      detail?: string
      token?: string
      url?: string
      exitCode?: number
      durationMs?: number
      configHash?: string
      skipped?: boolean
      baseSha?: string
      headSha?: string
      error?: StepError
      artifacts?: unknown[]
    }
    if (d.pr === undefined || (d.step !== "check" && d.step !== "merge" && d.step !== "deploy") || d.target === undefined) continue
    if (ev.name === "line/step/finished" && d.ok === undefined) continue
    const current = stepsByPr.get(d.pr) ?? {}
    current[d.step] = {
      ...(ev.name === "line/step/waiting" ? { waiting: true } : { ok: d.ok }),
      ts: ev.ts,
      target: d.target,
      ...(d.detail !== undefined ? { detail: d.detail } : {}),
      ...(d.token !== undefined ? { token: d.token } : {}),
      ...(d.url !== undefined ? { url: d.url } : {}),
      ...(d.exitCode !== undefined ? { exitCode: d.exitCode } : {}),
      ...(d.durationMs !== undefined ? { durationMs: d.durationMs } : {}),
      ...(d.configHash !== undefined ? { configHash: d.configHash } : {}),
      ...(d.skipped !== undefined ? { skipped: d.skipped } : {}),
      ...(d.baseSha !== undefined ? { baseSha: d.baseSha } : {}),
      ...(d.headSha !== undefined ? { headSha: d.headSha } : {}),
      ...(d.error !== undefined ? { error: d.error } : {}),
      ...(d.artifacts !== undefined ? { artifacts: d.artifacts } : {}),
    }
    stepsByPr.set(d.pr, current)
  }
  return stepsByPr
}

async function lineItemStatus(
  ctx: Ctx,
  state: BayState,
  pr: PullRequest,
  baseSha: string | undefined,
  stepsByPr: Map<PrId, Partial<Record<"check" | "merge" | "deploy", StepStatus>>>,
): Promise<LineItemStatus> {
  const target = queueTarget(state, pr.id)
  const targetSha = await resolveCommit(ctx.mainRepo, target)
  const steps = stepsByPr.get(pr.id) ?? {}
  const staleReasons =
    pr.state === "checked" ? staleCheckReasons(steps.check, { ...(baseSha !== undefined ? { baseSha } : {}), ...(targetSha !== undefined ? { headSha: targetSha } : {}) }) : []
  return {
    pr: pr.id,
    state: pr.state,
    target,
    ...(targetSha !== undefined ? { targetSha } : {}),
    stale: staleReasons.length > 0,
    staleReasons,
    steps,
  }
}

async function lineStatus(ctx: Ctx, bay: BayRuntime, state: BayState): Promise<{
  base: string
  baseSha?: string
  counts: Record<string, number>
  items: LineItemStatus[]
}> {
  const base = await resolveBaseRef(ctx.mainRepo)
  const baseSha = await resolveCommit(ctx.mainRepo, base)
  const stepsByPr = await stepStatusByPr(bay)

  const counts: Record<string, number> = {}
  const items: LineItemStatus[] = []
  for (const pr of Object.values(state.prs).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
    counts[pr.state] = (counts[pr.state] ?? 0) + 1
    if (!isOpen(pr.state)) continue
    items.push(await lineItemStatus(ctx, state, pr, baseSha, stepsByPr))
  }
  return { base, ...(baseSha !== undefined ? { baseSha } : {}), counts, items }
}

async function lineStatusForPr(ctx: Ctx, bay: BayRuntime, state: BayState, pr: PullRequest): Promise<LineItemStatus> {
  const base = await resolveBaseRef(ctx.mainRepo)
  const baseSha = await resolveCommit(ctx.mainRepo, base)
  return await lineItemStatus(ctx, state, pr, baseSha, await stepStatusByPr(bay))
}

type BatchSummaryMember = {
  pr: PrId
  target: string
  detail?: string
}

type BatchSummaryRecord = {
  batch: PrId
  target: string
  members: BatchSummaryMember[]
  ejected: BatchSummaryMember[]
  state: string
}

function batchSlice(state: BayState): Record<PrId, BatchSummaryRecord> {
  const slice = state.slices["batch-build"] as { batches?: Record<PrId, BatchSummaryRecord> } | undefined
  return slice?.batches ?? {}
}

function batchRecord(state: BayState, pr: PrId): BatchSummaryRecord | undefined {
  return batchSlice(state)[pr]
}

function memberList(members: readonly BatchSummaryMember[]): string {
  return members.map((member) => member.pr).join(", ")
}

function batchStatusLine(batch: BatchSummaryRecord): string {
  const ejected = batch.ejected.length > 0 ? `; ejected: ${memberList(batch.ejected)}` : ""
  const members = batch.members.length > 0 ? memberList(batch.members) : "(none)"
  return `batch ${batch.batch} ${batch.state} — members: ${members}${ejected}`
}

function firstDetailLine(detail: unknown): string | undefined {
  if (typeof detail !== "string" || detail.trim() === "") return undefined
  return detail.split("\n")[0]
}

function printBatchAwareEvents(events: readonly BayEvent[]): void {
  for (const e of events) {
    if (e.name === "line/batch/started") {
      const d = e.data as { batch?: PrId; members?: BatchSummaryMember[]; ejected?: BatchSummaryMember[]; skipped?: unknown[] }
      if (!d.batch) continue
      const ejected = d.ejected && d.ejected.length > 0 ? `; ejected: ${memberList(d.ejected)}` : ""
      const skipped = Array.isArray(d.skipped) && d.skipped.length > 0 ? `; skipped: ${d.skipped.length}` : ""
      console.log(`bay: batch ${d.batch} built — members: ${memberList(d.members ?? [])}${ejected}${skipped}`)
      continue
    }
    if (e.name === "line/batch/isolated") {
      const d = e.data as { batch?: PrId; outcome?: string; reason?: string; detail?: string }
      if (d.outcome === "refused") {
        // A refusal that ejects nobody must be LOUD — full detail, every line
        // (it names the fault class and the exact remedy).
        console.log(`bay: batch ${d.batch ?? "?"} bisect refused (${d.reason ?? "unknown"}) — ${d.detail ?? ""}`)
        continue
      }
      const line = firstDetailLine(d.detail)
      if (line) console.log(line)
      continue
    }
    if (e.name === "line/step/waiting") {
      const d = e.data as { pr?: string; step?: string; detail?: string; url?: string }
      if (d.pr !== undefined && d.step !== undefined) {
        const url = d.url === undefined ? "" : ` (${d.url})`
        console.log(`bay: ${d.pr} ${d.step} → waiting${d.detail ? ` — ${d.detail}` : ""}${url}`)
      }
      continue
    }
    if (e.name !== "pr/changed") continue
    const d = e.data as { pr: string; from: string; to: string; detail?: string }
    if (
      d.detail?.startsWith("batched in ") ||
      d.detail?.startsWith("build attempted") ||
      d.detail?.includes(" ejected from batch ")
    ) {
      continue
    }
    console.log(`bay: ${d.pr} ${d.from} → ${d.to}${d.detail ? ` — ${d.detail}` : ""}`)
  }
}

// ---------- verbs ----------

async function verbInit(ctx: Ctx): Promise<void> {
  await withWriteBay(ctx, async (bay) => {
    await bay.dispatch({ type: "init" })
  })
  console.log(`bay: initialized (store: sqlite, events: ${relToMain(ctx, bayEventsPath(ctx.bayDir))})`)
}

function relToMain(ctx: Ctx, path: string): string {
  return path.startsWith(ctx.mainRepo + "/") ? path.slice(ctx.mainRepo.length + 1) : path
}

/** The inbound issue-tracking gate (docs/layers/issue-tracking.md § Inbound):
 *  when `bay.issue` is configured, the command must accept the workitem name
 *  (exit 0) before a
 *  worktree opens OR an existing branch is adopted under that name — the
 *  no-branch-without-a-live-workitem doctrine enforced at the front door,
 *  on every door. */
async function validateWorkitem(ctx: Ctx, verb: string, name: string): Promise<void> {
  const validate = await resolveValidateCommand(ctx.mainRepo)
  if (validate === undefined) return
  const cmd = validate.replaceAll("{name}", name)
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd: ctx.mainRepo,
    stdout: "pipe",
    stderr: "pipe",
    env: repoScopedCleanEnv(),
  })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) {
    const said = err.trim()
    throw new Error(
      `bay: ${verb}: the tracker does not accept '${name}' — ${cmd} exited ${code}${said ? `:\n${said}` : ""}\n` +
        `Use a name your tracker knows, or disable the check: git config bay.issue none`,
    )
  }
}

async function verbOpen(ctx: Ctx, name: string | undefined, skipTracker: boolean, sourceBranch: string | undefined): Promise<void> {
  if (!name) throw new Error("bay: open: a name for the work is required — e.g. git bay open fix-readme")
  // Name-shadowing guard: PRn / wtN are minted ids; a name that looks like one
  // would make every later dual-addressed argument ambiguous on purpose.
  if (/^(PR\d+|wt\d+)$/i.test(name)) {
    throw new Error(
      `bay: open: '${name}' looks like an id, not a name — PR numbers and worktree ids are minted by the bay; ` +
        `pick a descriptive name (e.g. fix-readme)`,
    )
  }
  if (!skipTracker) await validateWorkitem(ctx, "open", name)
  const from = sourceBranch === undefined ? undefined : await resolveLocalBranchOrTeach(ctx, "open", sourceBranch)
  // Law 8: open self-heals the wiring — init is idempotent and cheap.
  const path = await withWriteBay(ctx, async (bay) => {
    if (!existsSync(ctx.repoGit)) await bay.dispatch({ type: "init" })
    if (from !== undefined) {
      const state = await bay.state()
      const tracked = prForTarget(state, from)
      if (tracked !== undefined) {
        throw new Error(`bay: open: '${from}' is already tracked by ${tracked} — git bay ls ${tracked}`)
      }
      const openLease = leaseForBranch(state, from)
      if (openLease !== undefined && openLease.endedAt === undefined) {
        const wt = wtLabelFor(state, openLease.id) ?? openLease.id
        throw new Error(`bay: open: '${from}' is already open in ${wt} — git bay ls`)
      }
    }
    const { events } = await bay.dispatch({ type: "open", args: { workitem: name, ...(from !== undefined ? { sourceBranch: from } : {}) } })
    const provisioned = events.find((e) => e.name === "worktree/provisioned")
    const p = (provisioned?.data as { path?: string } | undefined)?.path
    if (!p) throw new Error("bay: open: no worktree/provisioned event — provisioning failed silently (bug)")
    return p
  })
  console.log(path) // stdout is the cd-able path — nothing else
}

async function verbLs(ctx: Ctx, target: string | undefined, json: boolean): Promise<void> {
  const bay = readBay(ctx)
  const state = await bay.state()
  if (target) {
    const prId = resolvePr(state, target)
    const pr = prOrTeach(state, prId, "ls")
    if (json) {
      const line = await lineStatus(ctx, bay, state)
      const lineItem = line.items.find((item) => item.pr === prId) ?? (await lineStatusForPr(ctx, bay, state, pr))
      console.log(
        JSON.stringify({
          pr,
          detail: await lastDetail(bay, prId),
          batch: batchRecord(state, prId),
          line: lineItem,
        }),
      )
      return
    }
    console.log(prLine(pr, await lastDetail(bay, prId)))
    const batch = batchRecord(state, prId)
    if (batch) console.log(batchStatusLine(batch))
    return
  }
  if (json) {
    console.log(JSON.stringify({ leases: state.leases, prs: state.prs, batches: batchSlice(state), line: await lineStatus(ctx, bay, state) }))
    return
  }
  console.log(worktreeTable(state, ctx.actor, Date.now(), ctx.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS))
  // The queue is part of bare ls: anything not yet merged is live state the
  // operator must see (dogfood find: a rejected PR was invisible unless you
  // already knew its number). Merged history stays in the journal and
  // `ls <PR>`; silent when the queue is empty, so the executable happy-path
  // doc's expected output is unchanged.
  const active = Object.values(state.prs).filter((pr) => pr.state !== "merged")
  if (active.length > 0) {
    console.log("")
    for (const pr of active) {
      const detail = await lastDetail(bay, pr.id)
      const firstLine = detail?.split("\n")[0] ?? ""
      const batch = batchRecord(state, pr.id)
      const briefSource = batch ? batchStatusLine(batch) : firstLine
      const brief = briefSource.length > 100 ? briefSource.slice(0, 99) + "…" : briefSource
      console.log(`${pr.id}  ${pr.state}${brief ? ` — ${brief}` : ""}`)
    }
  }
  // Stale-worktree alerts (spec § lease lifecycle) — silent when none, so the
  // executable happy-path doc's expected output is unchanged. This hint is the
  // discovery path for the unadvertised refresh verb.
  const ttl = ctx.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS
  for (const lease of staleLeases(state, new Date().toISOString(), ttl)) {
    const wt = wtLabelFor(state, lease.id) ?? lease.id
    console.log(
      `bay: ${wt} (${lease.workitem ?? lease.branch}) idle past ${Math.round(ttl / 60000)}m — git bay refresh ${wt} to keep it, or git bay gc to expire it`,
    )
  }
}

/** `adopt <branch>` — creates a PR for an existing branch, landing in
 *  `pushed` (never auto-submitted; `submit` is the separate ask-to-merge
 *  step). */
async function verbAdopt(ctx: Ctx, target: string | undefined, name: string | undefined): Promise<void> {
  if (!target) throw new Error("bay: adopt: a branch, SHA, or worktree name is required")
  // Refuse at the door, not at integrate time: an unresolvable target used to be
  // accepted here and rejected minutes later by the merge worker's guard
  // (dogfood find: a user adopted a NAME; the branch was task/<name>).
  // Dual addressing: a token that is no commit may be the name of an existing
  // worktree — resolve it to that worktree's branch and let the reducer's
  // guards teach (an OPEN worktree's branch opens its PR by plain git push).
  let branch = target
  const resolved = await git(
    ["-C", ctx.mainRepo, "rev-parse", "--verify", "--quiet", `${target}^{commit}`],
    ctx.mainRepo,
  )
  if (resolved.code !== 0) {
    const state = await readBay(ctx).state()
    const named = Object.values(state.leases)
      .filter((l) => l.workitem === target)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .at(-1)
    if (named) {
      branch = named.branch
    } else {
      const refs = await git(
        ["-C", ctx.mainRepo, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
        ctx.mainRepo,
      )
      const near = refs.stdout
        .split("\n")
        .filter((r) => r !== "" && r.toLowerCase().includes(target.toLowerCase()))
        .slice(0, 3)
      const hint = near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : ""
      throw new Error(
        `bay: adopt: '${target}' does not resolve to a commit and no worktree carries that name — ` +
          `adopt takes a branch, a SHA, or the name of an existing worktree.${hint}`,
      )
    }
  }
  // Same front door as `open` (acceptance: co/enqueue both validate): a
  // NAMED adopt must name a workitem the tracker accepts. A nameless adopt
  // stays the audit-warned reconciliation ramp — nothing to validate.
  if (name !== undefined) await validateWorkitem(ctx, "adopt", name)
  await withWriteBay(ctx, async (bay) => {
    const { events } = await bay.dispatch({ type: "adopt", args: { branch, name } })
    const opened = events.find((e) => e.name === "pr/opened")
    const id = (opened?.data as { pr?: string } | undefined)?.pr
    console.log(id ?? "")
  })
}

async function resolveGitTargetOrTeach(ctx: Ctx, verb: "submit" | "adopt", target: string): Promise<string> {
  const resolved = await git(
    ["-C", ctx.mainRepo, "rev-parse", "--verify", "--quiet", `${target}^{commit}`],
    ctx.mainRepo,
  )
  if (resolved.code === 0) return target
  const refs = await git(
    ["-C", ctx.mainRepo, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
    ctx.mainRepo,
  )
  const near = refs.stdout
    .split("\n")
    .filter((r) => r !== "" && r.toLowerCase().includes(target.toLowerCase()))
    .slice(0, 3)
  const hint = near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : ""
  throw new Error(
    `bay: ${verb}: '${target}' is not a known PR, bay, or branch — ` +
      `git bay ls lists PRs and bays; git branch lists branches.${hint}`,
  )
}

async function resolveLocalBranchOrTeach(ctx: Ctx, verb: "open", target: string): Promise<string> {
  const branch = target.replace(/^refs\/heads\//, "")
  const resolved = await git(
    ["-C", ctx.mainRepo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
    ctx.mainRepo,
  )
  if (resolved.code === 0) return branch
  const refs = await git(["-C", ctx.mainRepo, "for-each-ref", "--format=%(refname:short)", "refs/heads"], ctx.mainRepo)
  const near = refs.stdout
    .split("\n")
    .filter((r) => r !== "" && r.toLowerCase().includes(branch.toLowerCase()))
    .slice(0, 3)
  const hint = near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : ""
  throw new Error(`bay: ${verb}: --from '${target}' is not a local branch — git branch lists branches.${hint}`)
}

function resolveSourceBranchOption(opts: { from?: string; head?: string }): string | undefined {
  if (opts.from !== undefined && opts.head !== undefined && opts.from !== opts.head) {
    throw new Error(`bay: open: --from and --head name different branches (${opts.from} vs ${opts.head})`)
  }
  return opts.from ?? opts.head
}

/** `submit <PR|name|branch>` — "ask to merge": moves an existing PR from
 *  `pushed` to `submitted`, or creates a submitted PR directly for an existing
 *  branch/SHA. Whether the PR keeps going from there is a SYSTEM behavior:
 *  `bay.autoMerge` (default true) auto-runs `integrate` right after, so a
 *  plain `git bay submit <target>` reaches `merged` by default. `--wait` is
 *  the verb-side mirror of `git push -o wait`: it forces that integrate step
 *  even when `bay.autoMerge` is false. */
async function verbQueue(ctx: Ctx, target: string | undefined, wait: boolean): Promise<void> {
  if (!target) throw new Error("bay: submit: a PR number, bay name, or branch is required — git bay ls lists PRs and bays")
  await withWriteBay(ctx, async (bay) => {
    const state = await bay.state()
    let prId: PrId
    let createdSubmitted = false
    try {
      prId = resolvePr(state, target)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes("no PR or worktree named")) {
        const branch = await resolveGitTargetOrTeach(ctx, "submit", target)
        const existing = prForTarget(state, branch)
        if (existing !== undefined) {
          prId = existing
        } else {
          const { events } = await bay.dispatch({ type: "enqueue", args: { target: branch } })
          const opened = events.find((e) => e.name === "pr/opened")
          const id = (opened?.data as { pr?: string } | undefined)?.pr
          if (!id) throw new Error("bay: submit: no pr/opened event — branch submission failed silently (bug)")
          prId = id
          createdSubmitted = true
        }
      } else {
        throw err
      }
    }
    const beforeQueue = await bay.state()
    const pr = prOrTeach(beforeQueue, prId, "submit") // "has no PR yet" teaches instead of a reducer miss
    if (pr.state === "pushed") {
      await bay.dispatch({ type: "queue", args: { pr: prId } })
    } else if (!createdSubmitted && !(wait && (pr.state === "submitted" || pr.state === "checked"))) {
      await bay.dispatch({ type: "queue", args: { pr: prId } })
    }
    const { autoMerge } = wait ? { autoMerge: true } : await resolveAutoFlow(ctx)
    if (!autoMerge) {
      console.log(`bay: ${prId} submitted — git bay integrate ${prId} to land it`)
      return
    }
    const { events } = await bay.dispatch({ type: "integrate", args: { pr: prId } })
    printTransitions(events)
  })
}

/** Verdict lines shared by the post-receive hook and retry. A bare push that
 *  only creates (no auto-submit) has no pr/changed event at all — that's the
 *  "opened, not submitted" case, printed distinctly. An empty events array (a
 *  repeat push to an already-`pushed` PR, still not submitting) is a
 *  non-event: quiet on success, nothing to print. */
function printVerdict(events: { name: string; data: Record<string, unknown> }[], opts: { label?: string } = {}): void {
  if (events.length === 0) return
  const opened = events.find((e) => e.name === "pr/opened")
  const changes = events.filter((e) => e.name === "pr/changed")
  if (opened && changes.length === 0) {
    const id = (opened.data as { pr: string }).pr
    console.log(`bay: ${id} opened — git bay submit ${id} when ready`)
    return
  }
  const id = (events.find((e) => "pr" in e.data)?.data as { pr?: string } | undefined)?.pr ?? "?"
  console.log(`bay: ${id} ${opts.label ?? "received — checks running"}`)
  for (const e of changes) {
    const d = e.data as { pr: string; to: string; detail?: string }
    if (d.to === "merged") {
      const m = d.detail?.match(/^merged [0-9a-f]+ onto (\S+)$/)
      console.log(`bay: ${d.pr} merged onto ${m?.[1] ?? "main"} (checks ✓)`)
    }
    if (d.to === "rejected") console.log(`bay: ${d.pr} rejected — ${d.detail ?? "see git bay ls"}`)
  }
}

/** batch-settle <PR>: journal a landed candidate's member outcomes. The drain
 *  does this automatically in the landing dispatch; this verb exists for the
 *  crash window between the candidate's merged event and the settle events. */
async function verbBatchSettle(ctx: Ctx, target: string): Promise<void> {
  await withWriteBay(ctx, async (bay) => {
    const state = await bay.state()
    const prId = resolvePr(state, target)
    const { events } = await bay.dispatch({ type: "batch-settle", args: { pr: prId } })
    if (events.length === 0) {
      console.log(`bay: nothing to settle for ${prId} — already settled, or not a landed batch candidate`)
      return
    }
    printBatchAwareEvents(events)
  })
}

/** retry re-runs the pipeline synchronously (law 1, CLI-first): a fix that
 *  changes no commit (config, environment) has nothing to push, so hooks never
 *  fire — the resume verb IS the trigger. With new commits, plain `git push`
 *  resubmits via the receiver instead. */
async function verbRetry(ctx: Ctx, target: string | undefined): Promise<void> {
  if (!target) throw new Error("bay: retry: a PR number or name is required — git bay ls lists them")
  await withWriteBay(ctx, async (bay) => {
    const state = await bay.state()
    const prId = resolvePr(state, target)
    const pr = prOrTeach(state, prId, "retry")
    if (pr.state === "pushed") {
      throw new Error(`bay: retry: ${prId} hasn't been submitted yet — git bay submit ${prId}`)
    }
    if (pr.state === "merged") {
      throw new Error(`bay: retry: ${prId} is already merged — start the next piece of work: git bay open <name>`)
    }
    if (pr.state === "closed") {
      throw new Error(`bay: retry: ${prId} was withdrawn — start the next piece of work: git bay open <name>`)
    }
    if (pr.state === "checking" || pr.state === "reviewing") {
      throw new Error(`bay: retry: ${prId} is ${pr.state} — wait for the verdict (git bay ls ${prId})`)
    }
    if (pr.state === "checked") {
      throw new Error(`bay: retry: ${prId} is already checked, not rejected — git bay merge ${prId} to land it`)
    }
    if (pr.state !== "submitted") await bay.dispatch({ type: "requeue", args: { pr: prId } })
    const slice = (state.slices["queue"] ?? { targets: {} }) as { targets: Record<string, string> }
    const branch = slice.targets[prId]
    if (!branch) throw new Error(`bay: retry: no merge target recorded for ${prId} — cannot resubmit`)
    const sha = (await git(["-C", ctx.mainRepo, "rev-parse", branch])).stdout.trim()
    if (!sha) throw new Error(`bay: retry: branch '${branch}' does not resolve in ${ctx.mainRepo}`)
    // retry always re-runs the full pipeline, regardless of bay.autoSubmit/
    // bay.autoMerge — that IS the point of retrying, so both flags are forced
    // true at the call site rather than left to config.
    const { events } = await bay.dispatch({ type: "submit", args: { branch, sha, queued: true, autoMerge: true } })
    printVerdict(events)
  })
}

async function verbClose(ctx: Ctx, target: string | undefined, withdraw: boolean): Promise<void> {
  if (!target) throw new Error("bay: close: a wt-id or name is required — git bay ls shows the open ones")
  await withWriteBay(ctx, async (bay) => {
    // Host-boundary dirty preflight, BEFORE dispatch: the reducer is pure and
    // the core is journal-first, so once it emits bay/closed the state says
    // "ended" even if the deprovision effect then refuses on dirt — state and
    // disk diverge and the worktree table stops showing a worktree that is
    // still occupied. Refusing here keeps it open, so the fix path is simply
    // "commit or clean, then close again". The deprovision handler keeps its
    // own dirty check as the race floor. gc expiry deliberately skips this
    // preflight — a timeout sweep must end idle worktrees regardless; the
    // custodian reclaim in provision covers any dirty worktree it leaves.
    const state = await bay.state()
    const { lease, wt } = resolveWorktree(state, target, "close")
    if (lease.path !== "" && existsSync(lease.path)) {
      const dirty = await porcelainStatus(lease.path)
      if (dirty !== "") {
        throw new Error(
          `bay: refusing to close ${wt} — the worktree at ${lease.path} has uncommitted work:\n${dirty}\n` +
            `Commit or push it first; bay never deletes uncommitted work. The worktree is still yours.`,
        )
      }
    }
    const { events } = await bay.dispatch({ type: "close", args: { lease: lease.id, withdraw, wt } })
    // A refusal is a normal returned+journaled event (spec § rejection/refusal
    // codes), not a throw — but the CLI still surfaces it as one (teaching
    // stderr + exit 1), so this is the one place that bridges the two.
    const refused = events.find((e) => e.name === "gitbay/refused")
    if (refused) {
      const d = refused.data as { detail: string }
      throw new Error(`bay: close: ${d.detail}`)
    }
  })
}

async function verbRefresh(ctx: Ctx, target: string | undefined): Promise<void> {
  if (!target) throw new Error("bay: refresh: a wt-id or name is required — git bay ls shows the open ones")
  await withWriteBay(ctx, async (bay) => {
    const state = await bay.state()
    const { lease } = resolveWorktree(state, target, "refresh")
    await bay.dispatch({ type: "refresh", args: { lease: lease.id } })
  })
}

/** Dispatch every receipt in a claimed inbox file, then delete it. A receipt
 *  whose submit throws is taught loudly and does not block the rest. */
async function drainReceiptFile(bay: BayRuntime, path: string): Promise<void> {
  const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim())
  for (const line of lines) {
    const receipt = JSON.parse(line) as { branch: string; sha: string }
    try {
      await bay.dispatch({ type: "submit", args: { branch: receipt.branch, sha: receipt.sha } })
    } catch (err) {
      console.error(`bay: inbox receipt ${receipt.branch}@${receipt.sha.slice(0, 8)}: ${(err as Error).message}`)
    }
  }
  await rm(path, { force: true })
}

/** Claim `source` by renaming it to a unique name; null when a racing ingest
 *  won (source gone), rethrow when the source still exists (a real FS error
 *  must not read as a lost race — NO SILENT ERRORS). */
async function claimReceiptFile(source: string, claimTag: string): Promise<string | null> {
  const claimed = `${source}.${claimTag}-${process.pid}-${Date.now()}`
  try {
    await rename(source, claimed)
    return claimed
  } catch (err) {
    if (existsSync(source)) throw err
    return null
  }
}

async function ingestInbox(ctx: Ctx, bay: BayRuntime): Promise<void> {
  // LE-3 (21002): the old fixed `.processing` claim name meant a SECOND
  // ingest's rename silently overwrote a crashed ingest's still-unprocessed
  // batch, and an orphaned claim was never re-read — a submitter told
  // "queued to inbox" could be silently dropped. Claims are unique-named and
  // orphans are recovered first, re-claimed so racing ingests process a file
  // at most once.
  const inbox = join(ctx.bayDir, "inbox.jsonl")
  const orphans = (await readdir(ctx.bayDir)).filter((f) => f.startsWith("inbox.jsonl.processing")).sort()
  for (const f of orphans) {
    const claimed = await claimReceiptFile(join(ctx.bayDir, f), "recovered")
    if (claimed) await drainReceiptFile(bay, claimed)
  }
  if (!existsSync(inbox)) return
  const claimed = await claimReceiptFile(inbox, "processing")
  if (claimed) await drainReceiptFile(bay, claimed)
}

/** One line per `pr/changed` event ("bay: PR1 submitted → checking"), shared
 *  by `check`, `merge`, and `integrate` — the three verbs that report their
 *  OWN transitions directly rather than through printVerdict's push-flavored
 *  wording. Returns whether anything printed, so callers can report "nothing
 *  to do" on a silent (non-event) dispatch. */
function printTransitions(events: { name: string; data: Record<string, unknown> }[]): boolean {
  let any = false
  for (const e of events) {
    if (e.name === "pr/changed") {
      const d = e.data as { pr: string; from: string; to: string; detail?: string }
      console.log(`bay: ${d.pr} ${d.from} → ${d.to}${d.detail ? ` — ${d.detail}` : ""}`)
      any = true
      continue
    }
    if (e.name === "line/step/waiting") {
      const d = e.data as { pr?: string; step?: string; detail?: string; url?: string }
      if (d.pr !== undefined && d.step !== undefined) {
        const url = d.url === undefined ? "" : ` (${d.url})`
        console.log(`bay: ${d.pr} ${d.step} → waiting${d.detail ? ` — ${d.detail}` : ""}${url}`)
        any = true
      }
    }
  }
  return any
}

function printCheckFinishEvents(events: { name: string; data: Record<string, unknown> }[]): void {
  for (const e of events) {
    if (e.name !== "line/step/finished") continue
    const d = e.data as { step?: string; pr?: string; ok?: boolean; detail?: string }
    if (d.step !== "check" || d.pr === undefined || d.ok === undefined) continue
    console.log(`bay: ${d.pr} check → ${d.ok ? "passed" : "failed"}${d.detail ? ` — ${d.detail}` : ""}`)
  }
}

/** `check <PR>`: submitted → checking → checked | rejected. Atomic — stops at
 *  the verdict, never merges (docs/model.md § Verbs). */
async function verbCheck(ctx: Ctx, target: string | undefined): Promise<void> {
  if (!target) throw new Error("bay: check: a PR number or name is required — git bay ls lists them")
  await withWriteBay(ctx, async (bay) => {
    const state = await bay.state()
    const prId = resolvePr(state, target)
    prOrTeach(state, prId, "check")
    const { events } = await bay.dispatch({ type: "check", args: { pr: prId } })
    printTransitions(events)
  })
}

function parseOptionalNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`bay: check-finish: ${flag} must be a finite number, got '${raw}'`)
  return value
}

async function verbCheckFinish(
  ctx: Ctx,
  target: string | undefined,
  opts: {
    artifact?: string | string[]
    ok?: boolean
    fail?: boolean
    token?: string
    detail?: string
    url?: string
    exitCode?: string
    durationMs?: string
  },
): Promise<void> {
  if (!target) throw new Error("bay: check-finish: a PR number or name is required — git bay ls lists them")
  const ok = opts.ok === true
  const fail = opts.fail === true
  if (ok === fail) throw new Error("bay: check-finish: choose exactly one of --ok or --fail")
  const artifacts = parseStepArtifactRefs(opts.artifact)
  await withWriteBay(ctx, async (bay) => {
    const state = await bay.state()
    const prId = resolvePr(state, target)
    prOrTeach(state, prId, "check-finish")
    const { events } = await bay.dispatch({
      type: "check-finish",
      args: {
        pr: prId,
        ok,
        ...(opts.token !== undefined ? { token: opts.token } : {}),
        ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
        ...(opts.url !== undefined ? { url: opts.url } : {}),
        ...(opts.exitCode !== undefined ? { exitCode: parseOptionalNumber(opts.exitCode, "--exit-code") } : {}),
        ...(opts.durationMs !== undefined ? { durationMs: parseOptionalNumber(opts.durationMs, "--duration-ms") } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      },
    })
    printCheckFinishEvents(events)
    printTransitions(events)
  })
}

/** `merge <PR>`: checked → merging → merged | rejected. Atomic — refuses a PR
 *  that isn't `checked`, never runs the check itself (docs/model.md § Verbs). */
async function verbMerge(ctx: Ctx, target: string | undefined): Promise<void> {
  if (!target) throw new Error("bay: merge: a PR number or name is required — git bay ls lists them")
  await withWriteBay(ctx, async (bay) => {
    const state = await bay.state()
    const prId = resolvePr(state, target)
    prOrTeach(state, prId, "merge")
    const { events } = await bay.dispatch({ type: "merge", args: { pr: prId } })
    printTransitions(events)
  })
}

function printDeployEvents(events: { name: string; data: Record<string, unknown> }[]): boolean {
  let ok = true
  for (const e of events) {
    if (e.name !== "line/step/finished") continue
    const d = e.data as { step?: string; pr?: string; ok?: boolean; detail?: string; skipped?: boolean }
    if (d.step !== "deploy" || d.pr === undefined || d.ok === undefined) continue
    if (d.skipped === true) {
      console.log(`bay: ${d.pr} deploy → skipped${d.detail ? ` — ${d.detail}` : ""}`)
      continue
    }
    if (d.ok) {
      console.log(`bay: ${d.pr} deploy → deployed${d.detail ? ` — ${d.detail}` : ""}`)
      continue
    }
    ok = false
    console.log(`bay: ${d.pr} deploy → failed${d.detail ? ` — ${d.detail}` : ""}`)
  }
  return ok
}

async function verbDeploy(ctx: Ctx, target: string | undefined): Promise<void> {
  if (!target) throw new Error("bay: deploy: a PR number or name is required — git bay ls lists them")
  let ok = true
  await withWriteBay(ctx, async (bay) => {
    const state = await bay.state()
    const prId = resolvePr(state, target)
    prOrTeach(state, prId, "deploy")
    const { events } = await bay.dispatch({ type: "deploy", args: { pr: prId } })
    ok = printDeployEvents(events)
  })
  if (!ok) process.exit(1)
}

function queuedBatchAlreadyBuilt(state: BayState): boolean {
  const queued = submittedPrs(state)
  if (queued.length === 0) return false
  return batchRecord(state, queued[0]!.id) !== undefined
}

async function maybeBuildBatch(ctx: Ctx, bay: BayRuntime, target: PrId | undefined): Promise<boolean> {
  if (target !== undefined || ctx.batchSize <= 1) return false
  const state = await bay.state()
  if (queuedBatchAlreadyBuilt(state)) return false
  if (submittedPrs(state).length < 2) return false
  const { events } = await bay.dispatch({ type: "batch-build", args: { max: ctx.batchSize } })
  printBatchAwareEvents(events)
  return events.some((e) => e.name === "line/batch/started")
}

function rejectedBatchFrom(events: readonly BayEvent[], state: BayState): PrId | undefined {
  for (const e of events) {
    if (e.name !== "pr/changed") continue
    const d = e.data as { pr?: string; to?: string }
    if (d.to === "rejected" && d.pr && batchRecord(state, d.pr)) return d.pr
  }
  return undefined
}

async function bisectAndDrainRebuiltBatch(bay: BayRuntime, batch: PrId): Promise<boolean> {
  const { events } = await bay.dispatch({ type: "batch-bisect", args: { pr: batch } })
  printBatchAwareEvents(events)
  const rebuilt = events.find((e) => e.name === "line/batch/started")?.data as { batch?: PrId } | undefined
  if (!rebuilt?.batch) return events.length > 0

  const drained = await bay.dispatch({ type: "integrate", args: { pr: rebuilt.batch } })
  printBatchAwareEvents(drained.events)
  const state = await bay.state()
  const rejected = rejectedBatchFrom(drained.events, state)
  if (rejected) await bisectAndDrainRebuiltBatch(bay, rejected)
  return true
}

async function verbIntegrate(ctx: Ctx, target: string | undefined, watch: boolean, intervalSec: number): Promise<void> {
  await withWriteBay(ctx, async (bay) => {
    let prId: PrId | undefined
    if (target) {
      const state = await bay.state()
      prId = resolvePr(state, target)
      prOrTeach(state, prId, "integrate") // "no push yet" teaches instead of a reducer miss
    }
    for (;;) {
      await ingestInbox(ctx, bay)
      let integrated = await maybeBuildBatch(ctx, bay, prId)
      const { events } = await bay.dispatch({ type: "integrate", args: prId ? { pr: prId } : undefined })
      printBatchAwareEvents(events)
      integrated = integrated || events.some((e) => e.name === "pr/changed")
      const state = await bay.state()
      const rejected = prId === undefined ? rejectedBatchFrom(events, state) : undefined
      if (rejected) integrated = (await bisectAndDrainRebuiltBatch(bay, rejected)) || integrated
      if (!watch) {
        if (!integrated) console.log("bay: queue empty — nothing to integrate")
        break
      }
      prId = undefined // a targeted integrate is one step; --watch keeps integrating the queue
      await new Promise((r) => setTimeout(r, intervalSec * 1000))
    }
  })
}

async function verbAudit(ctx: Ctx, json: boolean): Promise<void> {
  // audit lands as its own layer; dynamic import keeps the rest of the CLI
  // shippable while it bakes — a missing module is a loud, named error.
  let mod: typeof import("../src/layers/audit.ts")
  try {
    mod = await import("../src/layers/audit.ts")
  } catch {
    throw new Error("bay: audit is landing (src/layers/audit.ts not present yet) — see @hab/20926-gitbay v0.1-c")
  }
  const findings = await withWriteBay(ctx, async (bay) => {
    const audited = mod.withAudit()(bay)
    const { events } = await audited.dispatch({ type: "audit", args: { mainRepo: ctx.mainRepo } })
    const done = events.find((e) => e.name === "gitbay/audited")
    return ((done?.data ?? {}) as { findings?: unknown[] }).findings ?? []
  })
  if (json) console.log(JSON.stringify({ findings }))
  else console.log(mod.formatAudit(findings as Parameters<typeof mod.formatAudit>[0]))
  if ((findings as unknown[]).length > 0) process.exit(1)
}

// ---------- hook modes ----------

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text()
}

/** Push options the client passed via `git push -o <value>` — git exports
 *  these to both hooks as `GIT_PUSH_OPTION_COUNT` + `GIT_PUSH_OPTION_<i>` when
 *  the server has `receive.advertisePushOptions` set (init always sets it). */
function readPushOptions(): string[] {
  const count = Number(process.env.GIT_PUSH_OPTION_COUNT ?? "0")
  const opts: string[] = []
  for (let i = 0; i < count; i++) {
    const v = process.env[`GIT_PUSH_OPTION_${i}`]
    if (v !== undefined) opts.push(v)
  }
  return opts
}

/** docs/model.md § The auto-flow — two independent toggles, resolved once per
 *  push (or once per `submit` verb call, via the `pushOptions: []` default):
 *  `bay.autoSubmit` (default false) decides whether a push fuses creation
 *  with the ask-to-merge; `bay.autoMerge` (default true) decides whether a
 *  submitted PR immediately runs check-then-merge. Push options force
 *  autoSubmit/autoMerge for THIS push only, on top of whatever config says:
 *  `-o submit` forces autoSubmit true; `-o wait` forces BOTH true (create,
 *  submit, and integrate, blocking for the verdict — in this synchronous-hook
 *  implementation `-o submit` and `-o wait` differ only in autoMerge, since
 *  the post-receive hook always runs to completion before git returns to the
 *  client either way; `-o wait`'s stronger "blocks" phrasing will earn a real
 *  distinction once an async execution path exists). */
async function resolveAutoFlow(ctx: Ctx, pushOptions: string[] = []): Promise<{ autoSubmit: boolean; autoMerge: boolean }> {
  if (pushOptions.includes("wait")) return { autoSubmit: true, autoMerge: true }

  const source = createGitConfigSource(ctx.mainRepo)
  const parseBool = (raw: string | undefined): boolean | undefined => {
    if (raw === undefined) return undefined
    const v = raw.trim().toLowerCase()
    if (v === "") return undefined
    return v !== "false" && v !== "0"
  }

  let autoSubmit = parseBool(await source.get("autoSubmit")) ?? false
  const autoMerge = parseBool(await source.get("autoMerge")) ?? true
  if (pushOptions.includes("submit")) autoSubmit = true
  return { autoSubmit, autoMerge }
}

async function hookPre(ctx: Ctx): Promise<void> {
  const updates = parseReceiveStdin(await readStdin())
  const bay = readBay(ctx)
  const state = await bay.state()
  const messages = await preReceiveCheck(state, updates, { repoGit: ctx.repoGit, mainRepo: ctx.mainRepo })
  for (const m of messages) console.log(m)
}

async function hookPost(ctx: Ctx): Promise<void> {
  const updates = parseReceiveStdin(await readStdin())
  const { autoSubmit, autoMerge } = await resolveAutoFlow(ctx, readPushOptions())
  for (const u of updates) {
    const branch = u.ref.replace(/^refs\/heads\//, "")
    try {
      await withWriteBay(ctx, async (bay) => {
        const { events } = await bay.dispatch({
          type: "submit",
          args: { branch, sha: u.newSha, queued: autoSubmit, autoMerge },
        })
        printVerdict(events)
      })
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes("another bay writer is running")) {
        await appendInboxReceipt(ctx.bayDir, { branch, sha: u.newSha, ts: new Date().toISOString() })
        console.log(`bay: writer busy — ${branch} queued to inbox; git bay integrate will ingest it`)
      } else {
        console.log(msg.startsWith("bay:") ? msg : `bay: ${msg}`)
      }
    }
  }
}

// ---------- dispatch ----------

/** Agent/newcomer onboarding: everything needed BEFORE the first action, in one
 *  deterministic printout. Errors-are-Teachers covers the moment of mistake;
 *  guide covers the moment before. Stateless on purpose (works pre-init), and
 *  asserted verbatim by tests/guide.spec.md so it can never drift from the
 *  shipped behavior. */
const GUIDE = `git bay is a small continuous-integration server for this repository: you work in a disposable worktree, plain git push opens a local pull request, and git bay integrates it into main when the checks pass — one at a time, so main is never broken.
THE LOOP
  1. cd "$(git bay open <name>)"       # your own worktree; <name> = what you call this piece of work
  2. edit, git add, git commit         # plain git; commit hooks guard submodule pins + identity
  3. git push                          # opens your PR (state: pushed) — nothing runs yet
  4. git bay submit <PR|branch>        # ask to merge — auto-integrates to merged by default; READ the remote:/output lines
  5. git bay ls <PR>                   # re-read a verdict later (the PR number from the push output)
RULES
  - Work only inside your worktree, never in the repository's main checkout.
  - Read refusals fully: every refusal names the problem AND the exact fixing command. Run that command.
  - Manual control? git config bay.autoMerge false rests submit at submitted — then git bay check/merge or integrate <PR> yourself; git config bay.autoSubmit true makes a bare push submit too (and, with autoMerge still on, ship all the way).
  - No git config bay.merge needed — git bay merge/integrate land with a native git merge --no-ff by default; set bay.merge only to override it.
  - Checks failed? Fix it, then: new commits -> git push again; no new commits (config/env fix) -> git bay retry <PR>.
  - Done with a worktree? git bay close <bay|wt> refuses while its PR is still open — integrate it, retry it, or git bay close --withdraw <bay|wt>. Uncommitted work always refuses too; commit or clean first, work is never deleted.
  - A merged PR is a closed door: its branch is finished — start the next piece of work with a fresh git bay open <name>.
  - A bay PR is local — GitHub does not see it and gh commands do not apply.
VOCABULARY
  bay        the named, ephemeral LOAN of a worktree to one piece of work — opened by git bay open <name>
  worktree   the numbered, persistent directory a bay holds (ids look like wt1) — bays come and go, worktrees are reused
  name       what you called the work at open — any label, or a ticket id your tracker knows
  PR         your commits traveling to main as one unit — numbered PR1, PR2, … per repository; a push creates one (pushed), git bay submit asks to merge it and, by default, lands it (submitted -> ... -> merged); git bay submit <branch> opens and submits an existing branch directly
  check      git bay check <PR> runs the ONE project check alone (submitted -> checked); git config bay.check '<command>'; exit 0 means pass
  merge      git bay merge <PR> lands a CHECKED PR onto main alone (checked -> merged); git bay integrate <PR> runs check then merge together
ADDRESSING
  Bay verbs (close, refresh) take a wt-id or a name; PR verbs (check, merge, integrate, retry) take a PR number or a name; submit also accepts a source branch; ls takes either kind.
MACHINE-READABLE
  git bay ls --json        full state as JSON
  .git/bay/events.jsonl    append-only event log (every verdict, replayable)
Primed. Start: cd "$(git bay open <name>)"   (all verbs: git bay help)`

/** The live half of `git bay guide`: what THIS repository's bay looks like —
 *  initialized or not, which check/merge/issue commands are configured, how
 *  busy it is. Best-effort and read-only; outside a git repo it says so and
 *  teaches the first step instead of erroring (guide must never refuse). */
async function guideContext(): Promise<string> {
  const res = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (res.code !== 0) {
    return "THIS DIRECTORY\n  not a git repository — cd into your repo first, then: git bay init"
  }
  const commonDir = res.stdout.trim()
  const mainRepo = commonDir.endsWith("/.git") ? commonDir.slice(0, -5) : commonDir
  const source = createGitConfigSource(mainRepo)
  const fallback = await defaultBayDir(mainRepo)
  const bayDir = (await resolveOption(process.env.BAY_DIR, "dir", source, fallback.dir))!
  const rel = bayDir.startsWith(mainRepo + "/") ? bayDir.slice(mainRepo.length + 1) : bayDir
  const lines = [
    "THIS REPOSITORY — a snapshot as of right now; re-run git bay guide for current state",
    `  repo            ${mainRepo}`,
  ]
  if (!existsSync(bayDir)) {
    lines.push("  state           not initialized — run: git bay init")
  } else {
    lines.push(`  state           ${rel} (initialized)`)
  }
  const check = process.env.BAY_CHECK ?? (await source.get("check").catch(() => undefined))
  lines.push(
    check !== undefined && check.trim() !== ""
      ? `  check           ${check}`
      : "  check           (not set — pushes merge without a project check; set: git config bay.check '<command>')",
  )
  const mergeCommand = process.env.BAY_MERGE ?? (await source.get("merge").catch(() => undefined))
  lines.push(
    mergeCommand !== undefined && mergeCommand.trim() !== ""
      ? `  merge           ${mergeCommand}`
      : "  merge           (not set — merge/integrate land with a native git merge --no-ff; override: git config bay.merge '<command with {target}>')",
  )
  const tracker = process.env.BAY_ISSUE ?? (await source.get("issue").catch(() => undefined))
  lines.push(
    tracker !== undefined && tracker.trim() !== ""
      ? `  issue           ${tracker}`
      : "  issue           (not set — names are not checked against a tracker; set: git config bay.issue '<command with {name}>')",
  )
  if (existsSync(bayDir)) {
    const ctx: Ctx = {
      mainRepo,
      bayDir,
      repoGit: bayPrsGitPath(bayDir),
      actor: "guide",
      batchSize: 1,
      batchGeneratedGlobs: [],
    }
    const state = await readBay(ctx).state()
    const open = Object.values(state.leases).filter((l) => l.endedAt === undefined).length
    lines.push(`  open worktrees  ${open}`)
    lines.push(`  submitted PRs   ${submittedPrs(state).length}`)
  }
  return lines.join("\n")
}

/** resolveCtx + the wiped-bay guard: a missing state dir must teach, not let
 *  `ls` impersonate a healthy empty bay (the silent-fallback failure mode
 *  behind the 2026-07-07 .bay wipe). Every state-touching verb goes through
 *  this; `init` uses bare resolveCtx and `guide` resolves no context at all. */
async function requireBay(): Promise<Ctx> {
  const ctx = await resolveCtx()
  if (!existsSync(ctx.bayDir)) {
    throw new Error(
      `bay: no bay state at ${ctx.bayDir} (never initialized, or wiped by a hygiene sweep) — run: git bay init`,
    )
  }
  return ctx
}

/** Unadvertised git-style prefix resolution: any unambiguous prefix of a verb
 *  (or alias) works — `git bay au` is `git bay audit`. Ambiguity refuses and
 *  lists the candidates; no match falls through to commander's own
 *  unknown-command error (which suggests the closest verb). Exact names are
 *  never rewritten, so hook modes and scripts stay stable. */
function resolveVerbPrefix(program: Command, argv: string[]): void {
  const token = argv[2]
  if (token === undefined || token.startsWith("-")) return
  const names = new Map<string, string>() // name-or-alias -> canonical
  for (const cmd of program.commands) {
    names.set(cmd.name(), cmd.name())
    for (const a of cmd.aliases()) names.set(a, cmd.name())
  }
  if (names.has(token)) return // exact — never rewritten
  const canonical = new Set<string>()
  for (const [name, target] of names) if (name.startsWith(token)) canonical.add(target)
  if (canonical.size === 1) argv[2] = [...canonical][0]!
  if (canonical.size > 1) {
    throw new Error(`bay: '${token}' is ambiguous — matches: ${[...canonical].sort().join(", ")}`)
  }
}

/** Add a flag that keeps working but never shows in help (legacy spellings). */
function hiddenOption(cmd: Command, flags: string, description: string): void {
  cmd.option(flags, description)
  cmd.options.at(-1)!.hideHelp()
}

async function main(): Promise<void> {
  const program = new Command()
  program
    .name("git bay")
    .description("local pull requests for your repository — plain git push opens the PR (first time? run: git bay guide)")
    .showHelpAfterError()
    .showSuggestionAfterError()
  // Every advertised verb sets its own group; the default group exists so the
  // built-in `help` command joins "Start here:" instead of a stray "Commands:".
  program.commandsGroup("Start here:")
  program.helpCommand("help [command]", "display help for command")

  program
    .command("guide")
    .alias("prime")
    .helpGroup("Start here:")
    .description("onboarding for agents and newcomers — the workflow, the rules, and this repository's live config")
    .action(async () => {
      // Pre-first-action onboarding: never refuses, resolves no context, works
      // even outside a git repository.
      console.log(GUIDE)
      console.log("")
      console.log(await guideContext())
    })

  program
    .command("init")
    .aliases(["install", "setup"])
    .helpGroup("Start here:")
    .description("set up git bay for this repository (state in .git/bay/: events, index, bay-owned prs.git + hooks)")
    .action(async () => {
      await verbInit(await resolveCtx())
    })

  const cmdOpen = program
    .command("open <name>")
    .aliases(["new", "co", "checkout"])
    .helpGroup("Your bay:")
    .description("open a bay for a named piece of work; prints its worktree path (cd-able)")
    .option("--from <branch>", "open the bay on an existing local source branch")
    .option("--head <branch>", "alias for --from")
    .action(async (name: string, opts: { workitem?: boolean; from?: string; head?: string }) => {
      await verbOpen(await requireBay(), name, opts.workitem === false, resolveSourceBranchOption(opts))
    })
  hiddenOption(cmdOpen, "--no-workitem", "legacy spelling: treat <name> as a plain label (skip the bay.issue check)")

  program
    .command("close <wt|name>")
    .aliases(["abandon", "return"])
    .helpGroup("Your bay:")
    .description("close the bay; refuses if its PR is still queued (use --withdraw) or its worktree is dirty")
    .option("--withdraw", "also withdraw the bay's queued/rejected/in-review PR (moves it to abandoned)")
    .action(async (target: string, opts: { withdraw?: boolean }) => {
      await verbClose(await requireBay(), target, opts.withdraw === true)
    })

  program
    .command("gc")
    .helpGroup("Your bay:")
    .description("expire idle bays (work is snapshotted first, never deleted)")
    .action(async () => {
      const ctx = await requireBay()
      await withWriteBay(ctx, async (bay) => {
        const before = await bay.state()
        const { events } = await bay.dispatch({ type: "gc" })
        if (events.length === 0) {
          console.log("bay: gc clean — no idle worktrees past the timeout")
          return
        }
        for (const e of events) {
          if (e.name !== "bay/closed") continue
          const d = e.data as { bay: string; via: string }
          const lease = before.leases[d.bay]
          const wt = wtLabelFor(before, d.bay) ?? d.bay
          console.log(`bay: ${wt}${lease?.workitem ? ` (${lease.workitem})` : ""} expired — work preserved; worktree reclaimable`)
        }
      })
    })

  // Unadvertised keepalive (the stale hint in `ls` output is its discovery
  // path); `ping` is the legacy alias.
  program
    .command("refresh <wt|name>", { hidden: true })
    .alias("ping")
    .description("refresh a worktree's idle clock")
    .action(async (target: string) => {
      await verbRefresh(await requireBay(), target)
    })

  program
    .command("ls [PR|name]")
    .alias("status")
    .helpGroup("PRs:")
    .description("BAY + WORKTREE table, every unmerged PR, or one PR's verdict")
    .addHelpText(
      "after",
      "\nColumns: BAY = the name given at open; WORKTREE = its wt-id. AGE = time since open; IDLE = time since last activity.\n" +
        "STATE values: active | stale (idle past the timeout — gc will expire it; git bay refresh <bay|wt> keeps it). This is the WORKTREE's activity, distinct from a PR's own phase (pushed, submitted, checking, …).\n" +
        "Addressing: bay verbs (close, refresh) take a wt-id or a name; PR verbs (check, merge, integrate, retry) take a PR number or a name; submit also accepts a source branch; ls takes either kind.",
    )
    .option("--json", "machine-readable output")
    .action(async (target: string | undefined, opts: { json?: boolean }) => {
      await verbLs(await requireBay(), target, opts.json === true)
    })

  const cmdAdopt = program
    .command("adopt <branch>", { hidden: true })
    .alias("enqueue")
    .helpGroup("PRs:")
    .description("legacy: create a PR for an existing branch without submitting it")
    .action(async (target: string, opts: { workitem?: string }) => {
      await verbAdopt(await requireBay(), target, opts.workitem)
    })
  hiddenOption(cmdAdopt, "--workitem <name>", "legacy spelling: name the PR")

  program
    .command("submit <PR|name|branch>")
    .alias("queue")
    .helpGroup("PRs:")
    .description("ask to merge an existing PR/bay or create one from a branch; auto-integrates by default")
    .option("--wait", "force line integration even when bay.autoMerge is false")
    .action(async (target: string, opts: { wait?: boolean }) => {
      await verbQueue(await requireBay(), target, opts.wait === true)
    })

  program
    .command("check <PR|name>")
    .helpGroup("PRs:")
    .description("run the project check alone (submitted → checking → checked); stops there, never merges")
    .action(async (target: string) => {
      await verbCheck(await requireBay(), target)
    })

  program
    .command("check-finish <PR|name>", { hidden: true })
    .description("finish a parked external check result")
    .option("--ok", "record the parked check as passed")
    .option("--fail", "record the parked check as failed")
    .option("--token <token>", "correlation token from line/step/waiting")
    .option("--detail <text>", "human-readable result detail")
    .option("--url <url>", "external runner URL")
    .option("--artifact <name=path-or-url>", "external artifact reference (comma-separated or repeatable)")
    .option("--exit-code <n>", "external runner exit code")
    .option("--duration-ms <n>", "external runner duration in milliseconds")
    .action(
      async (
        target: string,
        opts: {
          artifact?: string | string[]
          ok?: boolean
          fail?: boolean
          token?: string
          detail?: string
          url?: string
          exitCode?: string
          durationMs?: string
        },
      ) => {
        await verbCheckFinish(await requireBay(), target, opts)
      },
    )

  program
    .command("merge <PR|name>")
    .helpGroup("PRs:")
    .description("land a checked PR onto main (checked → merging → merged); refuses a PR that isn't checked")
    .action(async (target: string) => {
      await verbMerge(await requireBay(), target)
    })

  program
    .command("integrate [PR|name]")
    .aliases(["in", "int", "land", "drain"])
    .helpGroup("PRs:")
    .description("run check then merge on the next submitted PR into main (or the named one); --watch keeps integrating")
    .option("--watch", "keep integrating on an interval")
    .option("--interval <sec>", "watch poll interval in seconds", "15")
    .action(async (target: string | undefined, opts: { watch?: boolean; interval?: string }) => {
      const interval = Number(opts.interval ?? "15")
      if (!Number.isFinite(interval) || interval <= 0) {
        throw new Error(`bay: integrate: --interval must be a positive number of seconds, got '${opts.interval ?? ""}'`)
      }
      await verbIntegrate(await requireBay(), target, opts.watch === true, interval)
    })

  program
    .command("deploy <PR|name>", { hidden: true })
    .description("run the configured post-merge deploy step for a merged PR")
    .action(async (target: string) => {
      await verbDeploy(await requireBay(), target)
    })

  program
    .command("retry <PR|name>")
    .alias("requeue")
    .helpGroup("PRs:")
    .description("retry a rejected or stuck PR through the line")
    .action(async (target: string) => {
      await verbRetry(await requireBay(), target)
    })

  // Crash-recovery spelling of the automatic settle: a candidate landed but
  // the per-member events never wrote (crash between the two). Hidden — the
  // drain settles in the same dispatch; nobody runs this on a healthy bay.
  program
    .command("batch-settle <PR>", { hidden: true })
    .description("journal a landed batch candidate's member outcomes (normally automatic; re-running is a no-op)")
    .action(async (target: string) => {
      await verbBatchSettle(await requireBay(), target)
    })

  program
    .command("audit")
    .helpGroup("Repository health:")
    .description("find strays, stale pins, and refs without a name")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      await verbAudit(await requireBay(), opts.json === true)
    })

  // One-shot event-log migration (spec § event schema v2) — hidden: an operator
  // runs this once, deliberately, when moving a pre-v0.3 bay forward. Not a
  // dual-read shim; there is nothing else that understands the v1 shape.
  program
    .command("migrate-journal", { hidden: true })
    .description("one-shot: migrate the bay event log from pre-v0.3 event names to v2 (backs up the original)")
    .action(async () => {
      const ctx = await requireBay()
      const { migrateJournal } = await import("../src/migrate.ts")
      const { migrated, dropped, backupPath } = await migrateJournal(ctx.bayDir)
      console.log(
        `bay: migrated ${migrated} event(s) to v2 (${dropped} non-event row(s) dropped); ` +
          `original backed up as ${relToMain(ctx, backupPath)}`,
      )
    })

  // Hook modes — installed by init inside the bay-owned repo, not user-facing.
  program
    .command("receive-pre", { hidden: true })
    .description("pre-receive hook mode (reads git's ref updates on stdin)")
    .action(async () => {
      await hookPre(await requireBay())
    })
  program
    .command("receive-post", { hidden: true })
    .description("post-receive hook mode (reads git's ref updates on stdin)")
    .action(async () => {
      await hookPost(await requireBay())
    })

  if (shouldColorize()) colorizeHelp(program)
  // Old verb names are aliases so nothing breaks, but they stay OUT of help —
  // one advertised spelling per verb, in the listing AND in each command's
  // usage line. configureHelp REPLACES the config (and subcommands captured it
  // at creation), so merge over whatever colorizeHelp installed, everywhere.
  const oneSpelling = {
    subcommandTerm: (cmd: Command) => {
      const args = cmd.registeredArguments.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(" ")
      const options = cmd.options.some((o) => !o.hidden) ? " [options]" : ""
      return cmd.name() + options + (args ? " " + args : "")
    },
    commandUsage: (cmd: Command) => {
      let ancestors = ""
      for (let p = cmd.parent; p; p = p.parent) ancestors = `${p.name()} ${ancestors}`
      return `${ancestors}${cmd.name()} ${cmd.usage()}`
    },
  }
  program.configureHelp({ ...program.configureHelp(), ...oneSpelling })
  for (const sub of program.commands) sub.configureHelp({ ...sub.configureHelp(), ...oneSpelling })
  if (process.argv.length <= 2) {
    program.outputHelp()
    return
  }
  resolveVerbPrefix(program, process.argv)
  await program.parseAsync(process.argv)
}

main().catch((err) => {
  const msg = (err as Error).message ?? String(err)
  console.error(msg.startsWith("bay:") ? msg : `bay: ${msg}`)
  process.exit(1)
})
