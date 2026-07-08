#!/usr/bin/env bun
// git bay — the CLI host over the era2 library (spec § The verbs; law 2: quiet
// on success, meaningful exit codes, --json everywhere it matters).
//
// Advertised verbs: guide | init | open | close | gc | ls | submit | integrate |
// retry | audit. Every pre-v0.3 verb name still works as a hidden alias
// (new, co, checkout, install, setup, abandon, return, refresh, ping, status,
// enqueue, adopt, merge, drain, requeue, prime) — nothing breaks, nothing is
// advertised twice. Hook modes (installed by init, not user-facing):
// receive-pre | receive-post

import { existsSync } from "node:fs"
import { Command } from "@silvery/commander/plain"
import { colorizeHelp, shouldColorize } from "@silvery/commander"
import { readFile, rename } from "node:fs/promises"
import { join } from "node:path"
import type { BayRuntime, BayState, Lease, LeaseId, PrId, PullRequest } from "../src/types.ts"
import { createGitbay } from "../src/core.ts"
import { pipe } from "../src/pipe.ts"
import { createGitConfigSource, resolveOption } from "../src/config.ts"
import { createSqliteStore } from "../src/store/sqlite.ts"
import { createReadStore } from "../src/store/read.ts"
import { withWorktrees, staleLeases, DEFAULT_LEASE_TIMEOUT_MS } from "../src/layers/worktrees.ts"
import { withQueue, queuedPrs } from "../src/layers/queue.ts"
import { withMergeWorker } from "../src/layers/merge-worker.ts"
import {
  withReceive,
  resolveReceive,
  parseReceiveStdin,
  preReceiveCheck,
  appendInboxReceipt,
} from "../src/layers/receive.ts"
import { withAdopt } from "../src/layers/adopt.ts"
import { defaultBayDir, git, porcelainStatus, repoScopedCleanEnv } from "../src/layers/git.ts"
import { parseTraceparent, readTraceparentEnv } from "../src/trace.ts"

// ---------- context ----------

type Ctx = { mainRepo: string; bayDir: string; repoGit: string; actor: string; leaseTimeoutMs?: number }

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
  return { mainRepo, bayDir, repoGit: join(bayDir, "repo.git"), actor, leaseTimeoutMs }
}

function buildBay(ctx: Ctx, store: ReturnType<typeof createReadStore>): BayRuntime {
  const runtime = pipe(
    createGitbay({ store, actor: ctx.actor }),
    withWorktrees({ mainRepo: ctx.mainRepo, bayRemote: ctx.repoGit, leaseTimeoutMs: ctx.leaseTimeoutMs }),
    withQueue(),
    withMergeWorker({ configCwd: ctx.mainRepo, mainRepo: ctx.mainRepo }),
    withReceive({ mainRepo: ctx.mainRepo, bayDir: ctx.bayDir }),
    withAdopt(),
  )
  // TRACEPARENT propagation (docs/events.md § Cause and spans): the CLI is a
  // thin adapter, so this is the one place it reads the header and threads it
  // onto every command's cause. commandId comes from the SAME idGen core
  // itself uses (runtime.idGen), so this mints no separate id sequence.
  const trace = readTraceparentEnv()
  if (!trace) return runtime
  return {
    ...runtime,
    dispatch: (command) =>
      runtime.dispatch({ ...command, cause: command.cause ?? { commandId: runtime.idGen(), ...trace } }),
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
  const open = Object.values(state.prs).filter(
    (pr) => pr.name === token && pr.state !== "merged" && pr.state !== "abandoned",
  )
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
 *  "no PR yet" rather than "not open yet" on purpose: `open` is now a real PR
 *  state (§6 addendum), so "not open yet" would misleadingly suggest one
 *  exists in some OTHER state. */
function prOrTeach(state: BayState, prId: PrId, verb: string): PullRequest {
  const pr = state.prs[prId]
  if (pr) return pr
  const lease = Object.values(state.leases).find((l) => l.changeId === prId && l.endedAt === undefined)
  const where = lease ? `${wtLabelFor(state, lease.id) ?? "its worktree"} (${lease.workitem ?? lease.branch})` : "its worktree"
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
    // AGE = since `open` (createdAt); IDLE = since the newest activity (what
    // `refresh` resets and what gc measures); STATE flips to `stale` when
    // idle exceeds the timeout — the same predicate gc uses. "active", never
    // "open" — `open` is now a PR lifecycle state (§6 addendum) and this is a
    // worktree's activity, a different axis entirely; never interchange them.
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
  if (pr.state === "rejected") return `${pr.id} rejected — ${detail ?? "see journal"}`
  return `${pr.id} ${pr.state}`
}

/** Last recorded state-change detail for a PR, from the journal. */
async function lastDetail(bay: BayRuntime, id: PrId): Promise<string | undefined> {
  let detail: string | undefined
  for await (const ev of bay.store.journal.replay()) {
    if (ev.name !== "pr/changed") continue
    const d = ev.data as { pr: PrId; detail?: string }
    if (d.pr === id && d.detail !== undefined) detail = d.detail
  }
  return detail
}

// ---------- verbs ----------

async function verbInit(ctx: Ctx): Promise<void> {
  await withWriteBay(ctx, async (bay) => {
    await bay.dispatch({ type: "init" })
  })
  console.log(`bay: initialized (store: sqlite, journal: ${relToMain(ctx, join(ctx.bayDir, "journal.jsonl"))})`)
}

function relToMain(ctx: Ctx, path: string): string {
  return path.startsWith(ctx.mainRepo + "/") ? path.slice(ctx.mainRepo.length + 1) : path
}

/** The bay.tracker gate at `open`: when configured (and not "none"), the
 *  tracker command must accept the name (exit 0) before a worktree opens —
 *  one config key connects the issue tracker (spec § bay.tracker '<command
 *  with {name}>'). */
async function checkTracker(ctx: Ctx, name: string): Promise<void> {
  const source = createGitConfigSource(ctx.mainRepo)
  const tracker = await source.get("tracker")
  if (tracker === undefined || tracker.trim() === "" || tracker.trim() === "none") return
  const cmd = tracker.replaceAll("{name}", name)
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
      `bay: open: the tracker does not accept '${name}' — ${cmd} exited ${code}${said ? `:\n${said}` : ""}\n` +
        `Use a name your tracker knows, or disable the check: git config bay.tracker none`,
    )
  }
}

async function verbOpen(ctx: Ctx, name: string | undefined, skipTracker: boolean): Promise<void> {
  if (!name) throw new Error("bay: open: a name for the work is required — e.g. git bay open fix-readme")
  // Name-shadowing guard: PRn / wtN are minted ids; a name that looks like one
  // would make every later dual-addressed argument ambiguous on purpose.
  if (/^(PR\d+|wt\d+)$/i.test(name)) {
    throw new Error(
      `bay: open: '${name}' looks like an id, not a name — PR numbers and worktree ids are minted by the bay; ` +
        `pick a descriptive name (e.g. fix-readme)`,
    )
  }
  if (!skipTracker) await checkTracker(ctx, name)
  // Law 8: open self-heals the wiring — init is idempotent and cheap.
  const path = await withWriteBay(ctx, async (bay) => {
    if (!existsSync(ctx.repoGit)) await bay.dispatch({ type: "init" })
    const { events } = await bay.dispatch({ type: "open", args: { workitem: name } })
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
      console.log(JSON.stringify({ pr, detail: await lastDetail(bay, prId) }))
      return
    }
    console.log(prLine(pr, await lastDetail(bay, prId)))
    return
  }
  if (json) {
    console.log(JSON.stringify({ leases: state.leases, prs: state.prs }))
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
      const brief = firstLine.length > 100 ? firstLine.slice(0, 99) + "…" : firstLine
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

/** `adopt <branch>` (§6 addendum: took over submit's OLD meaning) — creates a
 *  PR for an existing branch, landing in `open` (never auto-queued; `submit`/
 *  `queue` is the separate ask-to-merge step). */
async function verbAdopt(ctx: Ctx, target: string | undefined, name: string | undefined): Promise<void> {
  if (!target) throw new Error("bay: adopt: a branch, SHA, or worktree name is required")
  // Refuse at the door, not at integrate time: an unresolvable target used to be
  // accepted here and rejected minutes later by the merge worker's guard
  // (dogfood find: a user adopted a NAME; the branch was task/<name>).
  // Dual addressing: a token that is no commit may be the name of an existing
  // worktree — resolve it to that worktree's branch and let the reducer's
  // guards teach (an OPEN worktree's branch opens its PR by plain git push).
  let branch = target
  const resolved = await git(["-C", ctx.mainRepo, "rev-parse", "--verify", "--quiet", `${target}^{commit}`], ctx.mainRepo)
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
  await withWriteBay(ctx, async (bay) => {
    const { events } = await bay.dispatch({ type: "adopt", args: { branch, name } })
    const opened = events.find((e) => e.name === "pr/opened")
    const id = (opened?.data as { pr?: string } | undefined)?.pr
    console.log(id ?? "")
  })
}

/** `submit <PR|name>` / alias `queue` (§6 addendum: submit's NEW meaning) —
 *  "ask to merge": moves an existing PR from `open` to `queued`. Lazy, like
 *  `adopt` always has been: this only queues it — `git bay integrate` (or a
 *  fused `-o submit`/`-o wait`/`bay.autoQueue` push) is what actually runs the
 *  check/merge pipeline. A token that resolves to no known PR/bay redirects
 *  to `adopt`, since that is what creates one. */
async function verbQueue(ctx: Ctx, target: string | undefined): Promise<void> {
  if (!target) throw new Error("bay: submit: a PR number or name is required — git bay ls lists them")
  await withWriteBay(ctx, async (bay) => {
    const state = await bay.state()
    let prId: PrId
    try {
      prId = resolvePr(state, target)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes("no PR or worktree named")) {
        throw new Error(
          `bay: submit: '${target}' is not a known PR or bay name — to create one from an existing branch: ` +
            `git bay adopt ${target}`,
        )
      }
      throw err
    }
    prOrTeach(state, prId, "submit") // "has no PR yet" teaches instead of a reducer miss
    await bay.dispatch({ type: "queue", args: { pr: prId } })
    console.log(`bay: ${prId} queued — git bay integrate ${prId} to land it`)
  })
}

/** Verdict lines shared by the post-receive hook, retry, and submit/queue.
 *  A bare push that only creates (no auto-queue) has no pr/changed event at
 *  all — that's the "opened, not queued" case, printed distinctly. An empty
 *  events array (a repeat push to an already-`open` PR, still not queuing) is
 *  a non-event: quiet on success, nothing to print. */
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
    if (pr.state === "open") {
      throw new Error(`bay: retry: ${prId} hasn't been submitted yet — git bay submit ${prId}`)
    }
    if (pr.state === "merged") {
      throw new Error(`bay: retry: ${prId} is already merged — start the next piece of work: git bay open <name>`)
    }
    if (pr.state === "abandoned") {
      throw new Error(`bay: retry: ${prId} was withdrawn — start the next piece of work: git bay open <name>`)
    }
    if (pr.state === "checking" || pr.state === "reviewing") {
      throw new Error(`bay: retry: ${prId} is ${pr.state} — wait for the verdict (git bay ls ${prId})`)
    }
    if (pr.state !== "queued") await bay.dispatch({ type: "requeue", args: { pr: prId } })
    const slice = (state.slices["queue"] ?? { targets: {} }) as { targets: Record<string, string> }
    const branch = slice.targets[prId]
    if (!branch) throw new Error(`bay: retry: no merge target recorded for ${prId} — cannot resubmit`)
    const sha = (await git(["-C", ctx.mainRepo, "rev-parse", branch])).stdout.trim()
    if (!sha) throw new Error(`bay: retry: branch '${branch}' does not resolve in ${ctx.mainRepo}`)
    // retry always re-runs the full pipeline, regardless of bay.autoQueue —
    // that IS the point of retrying.
    const { events } = await bay.dispatch({ type: "submit", args: { branch, sha, queued: true } })
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

async function ingestInbox(ctx: Ctx, bay: BayRuntime): Promise<void> {
  const inbox = join(ctx.bayDir, "inbox.jsonl")
  if (!existsSync(inbox)) return
  const processed = inbox + `.processing`
  await rename(inbox, processed) // claim the batch; a racing writer starts a fresh inbox
  const lines = (await readFile(processed, "utf8")).split("\n").filter((l) => l.trim())
  for (const line of lines) {
    const receipt = JSON.parse(line) as { branch: string; sha: string }
    try {
      await bay.dispatch({ type: "submit", args: { branch: receipt.branch, sha: receipt.sha } })
    } catch (err) {
      console.error(`bay: inbox receipt ${receipt.branch}@${receipt.sha.slice(0, 8)}: ${(err as Error).message}`)
    }
  }
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
      const { events } = await bay.dispatch({ type: "drain", args: prId ? { pr: prId } : undefined })
      let integrated = false
      for (const e of events) {
        if (e.name === "pr/changed") {
          const d = e.data as { pr: string; from: string; to: string; detail?: string }
          console.log(`bay: ${d.pr} ${d.from} → ${d.to}${d.detail ? ` — ${d.detail}` : ""}`)
          integrated = true
        }
      }
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

/** §6 addendum: a push queues immediately (create AND ask-to-merge, fused)
 *  iff `-o submit`/`-o wait` was passed, or `bay.autoQueue` is set. In this
 *  synchronous-hook implementation `-o submit` and `-o wait` are equivalent
 *  triggers — the post-receive hook always runs to completion before git
 *  returns to the client, so "blocks for the verdict" is already true either
 *  way; `-o wait`'s stronger phrasing will earn a real distinction once an
 *  async execution path exists. */
async function resolveAutoQueue(ctx: Ctx, pushOptions: string[]): Promise<boolean> {
  if (pushOptions.includes("submit") || pushOptions.includes("wait")) return true
  const raw = await createGitConfigSource(ctx.mainRepo).get("autoQueue")
  const v = raw?.trim().toLowerCase()
  return v !== undefined && v !== "" && v !== "false" && v !== "0"
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
  const queued = await resolveAutoQueue(ctx, readPushOptions())
  for (const u of updates) {
    const branch = u.ref.replace(/^refs\/heads\//, "")
    try {
      await withWriteBay(ctx, async (bay) => {
        const { events } = await bay.dispatch({ type: "submit", args: { branch, sha: u.newSha, queued } })
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
  3. git push                          # opens your PR (state: open) — nothing runs yet
  4. git bay submit <PR>               # ask to merge (open -> queued) — checks run, then the merge; READ the remote:/output lines
  5. git bay ls <PR>                   # re-read a verdict later (the PR number from the push output)
RULES
  - Work only inside your worktree, never in the repository's main checkout.
  - Read refusals fully: every refusal names the problem AND the exact fixing command. Run that command.
  - In a hurry? git push -o submit fuses steps 3+4 (git config bay.autoQueue true makes every push do this).
  - Checks failed? Fix it, then: new commits -> git push again; no new commits (config/env fix) -> git bay retry <PR>.
  - Done with a worktree? git bay close <bay|wt> refuses while its PR is still queued — integrate it, retry it, or git bay close --withdraw <bay|wt>. Uncommitted work always refuses too; commit or clean first, work is never deleted.
  - A merged PR is a closed door: its branch is finished — start the next piece of work with a fresh git bay open <name>.
  - A bay PR is local — GitHub does not see it and gh commands do not apply.
VOCABULARY
  bay        the named, ephemeral LOAN of a worktree to one piece of work — opened by git bay open <name>
  worktree   the numbered, persistent directory a bay holds (ids look like wt1) — bays come and go, worktrees are reused
  name       what you called the work at open — any label, or a ticket id your tracker knows
  PR         your commits traveling to main as one unit — numbered PR1, PR2, … per repository; a push creates one (open), git bay submit asks to merge it (queued)
  queue      queued PRs waiting to be integrated; they merge one at a time, in order
  checks     the command git bay runs before integrating a PR (git config bay.check '<command>'); exit 0 means pass
ADDRESSING
  Bay verbs (close, refresh) take a wt-id or a name; PR verbs (submit, integrate, retry) take a PR number or a name; ls takes either kind.
MACHINE-READABLE
  git bay ls --json        full state as JSON
  .git/bay/journal.jsonl   append-only event journal (every verdict, replayable)
Primed. Start: cd "$(git bay open <name>)"   (all verbs: git bay help)`

/** The live half of `git bay guide`: what THIS repository's bay looks like —
 *  initialized or not, which check/merge/tracker commands are configured, how
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
  const mergeCommand = process.env.BAY_MERGE_COMMAND ?? (await source.get("mergeCommand").catch(() => undefined))
  lines.push(
    mergeCommand !== undefined && mergeCommand.trim() !== ""
      ? `  mergeCommand    ${mergeCommand}`
      : "  mergeCommand    (not set — git bay integrate refuses until: git config bay.mergeCommand '<command with {target}>')",
  )
  const tracker = process.env.BAY_TRACKER ?? (await source.get("tracker").catch(() => undefined))
  lines.push(
    tracker !== undefined && tracker.trim() !== ""
      ? `  tracker         ${tracker}`
      : "  tracker         (not set — names are not checked against a tracker; set: git config bay.tracker '<command with {name}>')",
  )
  if (existsSync(bayDir)) {
    const ctx: Ctx = { mainRepo, bayDir, repoGit: join(bayDir, "repo.git"), actor: "guide" }
    const state = await readBay(ctx).state()
    const open = Object.values(state.leases).filter((l) => l.endedAt === undefined).length
    lines.push(`  open worktrees  ${open}`)
    lines.push(`  queued PRs      ${queuedPrs(state).length}`)
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
    .description("set up git bay for this repository (state in .git/bay/: store, journal, bay-owned repo.git + hooks)")
    .action(async () => {
      await verbInit(await resolveCtx())
    })

  const cmdOpen = program
    .command("open <name>")
    .aliases(["new", "co", "checkout"])
    .helpGroup("Your bay:")
    .description("open a bay for a named piece of work; prints its worktree path (cd-able)")
    .action(async (name: string, opts: { workitem?: boolean }) => {
      await verbOpen(await requireBay(), name, opts.workitem === false)
    })
  hiddenOption(cmdOpen, "--no-workitem", "legacy spelling: treat <name> as a plain label (skip the bay.tracker check)")

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
        "STATE values: active | stale (idle past the timeout — gc will expire it; git bay refresh <bay|wt> keeps it). This is the WORKTREE's activity, distinct from a PR's own state (open, queued, checking, …).\n" +
        "Addressing: bay verbs (close, refresh) take a wt-id or a name; PR verbs (submit, integrate, retry) take a PR number or a name; ls takes either kind.",
    )
    .option("--json", "machine-readable output")
    .action(async (target: string | undefined, opts: { json?: boolean }) => {
      await verbLs(await requireBay(), target, opts.json === true)
    })

  const cmdAdopt = program
    .command("adopt <branch>")
    .alias("enqueue")
    .helpGroup("PRs:")
    .description("create a PR for an existing branch (from inside a worktree, plain git push does this); lands in `open`")
    .action(async (target: string, opts: { workitem?: string }) => {
      await verbAdopt(await requireBay(), target, opts.workitem)
    })
  hiddenOption(cmdAdopt, "--workitem <name>", "legacy spelling: name the PR")

  program
    .command("submit <PR|name>")
    .alias("queue")
    .helpGroup("PRs:")
    .description("ask to merge — queues an open PR for integration (open → queued)")
    .action(async (target: string) => {
      await verbQueue(await requireBay(), target)
    })

  program
    .command("integrate [PR|name]")
    .aliases(["in", "int", "land", "merge", "drain"])
    .helpGroup("PRs:")
    .description("integrate the next queued PR into main (or the named one); --watch keeps integrating")
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
    .command("retry <PR|name>")
    .alias("requeue")
    .helpGroup("PRs:")
    .description("put a rejected or stuck PR back in the queue and re-run its pipeline")
    .action(async (target: string) => {
      await verbRetry(await requireBay(), target)
    })

  program
    .command("audit")
    .helpGroup("Repository health:")
    .description("find strays, stale pins, and refs without a name")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      await verbAudit(await requireBay(), opts.json === true)
    })

  // One-shot journal migration (spec § event schema v2) — hidden: an operator
  // runs this once, deliberately, when moving a pre-v0.3 bay forward. Not a
  // dual-read shim; there is nothing else that understands the v1 shape.
  program
    .command("migrate-journal", { hidden: true })
    .description("one-shot: migrate .git/bay/journal.jsonl from the pre-v0.3 event names to v2 (backs up as journal.v1.jsonl)")
    .action(async () => {
      const ctx = await requireBay()
      const { migrateJournal } = await import("../src/migrate.ts")
      const { migrated, dropped } = await migrateJournal(ctx.bayDir)
      console.log(
        `bay: migrated ${migrated} event(s) to v2 (${dropped} non-event row(s) dropped); ` +
          `original backed up as ${relToMain(ctx, join(ctx.bayDir, "journal.v1.jsonl"))}`,
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
      const args = cmd.registeredArguments
        .map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`))
        .join(" ")
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
