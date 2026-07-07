#!/usr/bin/env bun
// git bay — the CLI host over the era2 library (spec § The verbs; law 2: quiet
// on success, meaningful exit codes, --json everywhere it matters).
//
// Verbs: init | co | status | enqueue | requeue | drain | abandon | audit
// Hook modes (installed by init, not user-facing): receive-pre | receive-post

import { existsSync } from "node:fs"
import { readFile, rename } from "node:fs/promises"
import { join } from "node:path"
import type { BayRuntime, BayState, Changeset, Lease } from "../src/types.ts"
import { createBay } from "../src/core.ts"
import { pipe } from "../src/pipe.ts"
import { createGitConfigSource, resolveOption } from "../src/config.ts"
import { createSqliteStore } from "../src/store/sqlite.ts"
import { createReadStore } from "../src/store/read.ts"
import { withWorkspaces, staleLeases, DEFAULT_LEASE_TIMEOUT_MS } from "../src/layers/workspaces.ts"
import { withQueue } from "../src/layers/queue.ts"
import { withMergeWorker } from "../src/layers/merge-worker.ts"
import {
  withReceive,
  resolveReceive,
  parseReceiveStdin,
  preReceiveCheck,
  appendInboxReceipt,
} from "../src/layers/receive.ts"
import { withAdopt } from "../src/layers/adopt.ts"
import { git } from "../src/layers/git.ts"

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
  const bayDir = (await resolveOption(process.env.BAY_DIR, "dir", source, join(mainRepo, ".bay")))!
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
  return pipe(
    createBay({ store, actor: ctx.actor }),
    withWorkspaces({ mainRepo: ctx.mainRepo, bayRemote: ctx.repoGit, leaseTimeoutMs: ctx.leaseTimeoutMs }),
    withQueue(),
    withMergeWorker({ configCwd: ctx.mainRepo }),
    withReceive({ mainRepo: ctx.mainRepo, bayDir: ctx.bayDir }),
    withAdopt(),
  )
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

function bayTable(state: BayState, actor: string, now: number): string {
  const slice = (state.slices["workspaces"] ?? { byBay: {} }) as { byBay: Record<number, string> }
  const rows: string[][] = []
  for (const [n, leaseId] of Object.entries(slice.byBay).sort(([a], [b]) => Number(a) - Number(b))) {
    const lease = state.leases[leaseId]
    if (!lease) continue
    const you = lease.actor === actor ? "← you" : ""
    rows.push([`bay${n}`, lease.workitem ?? "—", "leased", age(lease.createdAt, now), you])
  }
  if (rows.length === 0) return "no open leases — git bay co <workitem> opens one"
  const header = ["BAY", "WORKITEM", "STATE", "AGE", ""]
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const fmt = (r: string[]) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : pad(cell, widths[i]! + 2)))
      .join("")
      .trimEnd()
  return [fmt(header), ...rows.map(fmt)].join("\n")
}

function changesetLine(cs: Changeset, detail: string | undefined): string {
  if (cs.state === "merged") {
    // detail shape: "merged <sha> onto <mainline>" (submit handler)
    const m = detail?.match(/^merged ([0-9a-f]+) onto (\S+)$/)
    if (m) return `${cs.id} merged ${m[1]} onto ${m[2]} (checks: ✓)`
    return `${cs.id} merged (checks: ✓)`
  }
  if (cs.state === "rejected") return `${cs.id} rejected — ${detail ?? "see journal"}`
  return `${cs.id} ${cs.state}`
}

/** Last recorded state-change detail for a changeset, from the journal. */
async function lastDetail(bay: BayRuntime, id: string): Promise<string | undefined> {
  let detail: string | undefined
  for await (const ev of bay.store.journal.replay()) {
    if (ev.type === "changeset.state-changed" && ev.changeset === id) {
      const d = (ev.data ?? {}) as { detail?: string }
      if (d.detail !== undefined) detail = d.detail
    }
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

async function verbCo(ctx: Ctx, workitem: string | undefined): Promise<void> {
  if (!workitem) throw new Error("bay: co: a workitem (or label with --no-workitem) is required")
  // Law 8: co self-heals the wiring — init is idempotent and cheap.
  const path = await withWriteBay(ctx, async (bay) => {
    if (!existsSync(ctx.repoGit)) await bay.dispatch({ type: "init" })
    const { events } = await bay.dispatch({ type: "co", args: { workitem } })
    const provisioned = events.find((e) => e.type === "workspace.provisioned")
    const p = (provisioned?.data as { path?: string } | undefined)?.path
    if (!p) throw new Error("bay: co: no workspace.provisioned event — provisioning failed silently (bug)")
    return p
  })
  console.log(path) // stdout is the cd-able path — nothing else
}

async function verbStatus(ctx: Ctx, target: string | undefined, json: boolean): Promise<void> {
  const bay = readBay(ctx)
  const state = await bay.state()
  if (target) {
    const cs = state.changesets[target]
    if (!cs) throw new Error(`bay: no changeset '${target}' — see git bay status --json for ids`)
    if (json) {
      console.log(JSON.stringify({ changeset: cs, detail: await lastDetail(bay, target) }))
      return
    }
    console.log(changesetLine(cs, await lastDetail(bay, target)))
    return
  }
  if (json) {
    console.log(JSON.stringify({ leases: state.leases, changesets: state.changesets }))
    return
  }
  console.log(bayTable(state, ctx.actor, Date.now()))
  // Stale-lease alerts (spec § lease lifecycle) — silent when none, so the
  // executable happy-path doc's expected output is unchanged.
  const ttl = ctx.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS
  for (const lease of staleLeases(state, new Date().toISOString(), ttl)) {
    console.log(
      `bay: stale lease ${lease.id} (${lease.workitem ?? lease.branch}) idle past ${Math.round(ttl / 60000)}m — git bay ping ${lease.id} to keep it, or git bay gc to expire`,
    )
  }
}

async function verbEnqueue(ctx: Ctx, target: string | undefined, workitem: string | undefined): Promise<void> {
  if (!target) throw new Error("bay: enqueue: a target (branch or SHA) is required")
  await withWriteBay(ctx, async (bay) => {
    const { events } = await bay.dispatch({ type: "enqueue", args: { target, workitem } })
    const id = events.find((e) => e.type === "changeset.enqueued")?.changeset
    console.log(id ?? "")
  })
}

/** Verdict lines shared by the post-receive hook and synchronous requeue. */
function printVerdict(events: { type: string; changeset?: string; data?: Record<string, unknown> }[]): void {
  const id = events.find((e) => e.changeset)?.changeset ?? "?"
  console.log(`bay: changeset ${id} received — checks running`)
  for (const e of events) {
    if (e.type !== "changeset.state-changed") continue
    const d = e.data as { changeset: string; to: string; detail?: string }
    if (d.to === "merged") {
      const m = d.detail?.match(/^merged [0-9a-f]+ onto (\S+)$/)
      console.log(`bay: ${d.changeset} merged onto ${m?.[1] ?? "main"} (checks ✓)`)
    }
    if (d.to === "rejected") console.log(`bay: ${d.changeset} rejected — ${d.detail ?? "see git bay status"}`)
  }
}

/** requeue re-runs the pipeline synchronously (law 1, CLI-first): a fix that
 *  changes no commit (config, environment) has nothing to push, so hooks never
 *  fire — the resume verb IS the trigger. With new commits, plain `git push`
 *  resubmits via the receiver instead. */
async function verbRequeue(ctx: Ctx, changeset: string | undefined): Promise<void> {
  if (!changeset) throw new Error("bay: requeue: a changeset id is required")
  await withWriteBay(ctx, async (bay) => {
    const state = await bay.state()
    const cs = state.changesets[changeset]
    if (!cs) throw new Error(`bay: no changeset '${changeset}' — see git bay status --json`)
    if (cs.state !== "queued") await bay.dispatch({ type: "requeue", args: { changeset } })
    const slice = (state.slices["queue"] ?? { targets: {} }) as { targets: Record<string, string> }
    const branch = slice.targets[changeset]
    if (!branch) throw new Error(`bay: no merge target recorded for '${changeset}' — cannot resubmit`)
    const sha = (await git(["-C", ctx.mainRepo, "rev-parse", branch])).stdout.trim()
    if (!sha) throw new Error(`bay: branch '${branch}' does not resolve in ${ctx.mainRepo}`)
    const { events } = await bay.dispatch({ type: "submit", args: { branch, sha } })
    printVerdict(events)
  })
}

async function verbAbandon(ctx: Ctx, lease: string | undefined): Promise<void> {
  if (!lease) throw new Error("bay: abandon: a lease id is required (git bay status --json lists them)")
  await withWriteBay(ctx, async (bay) => {
    await bay.dispatch({ type: "abandon", args: { lease } })
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

async function verbDrain(ctx: Ctx, watch: boolean, intervalSec: number): Promise<void> {
  await withWriteBay(ctx, async (bay) => {
    for (;;) {
      await ingestInbox(ctx, bay)
      const { events } = await bay.dispatch({ type: "drain" })
      for (const e of events) {
        if (e.type === "changeset.state-changed") {
          const d = e.data as { changeset: string; from: string; to: string; detail?: string }
          console.log(`bay: ${d.changeset} ${d.from} → ${d.to}${d.detail ? ` — ${d.detail}` : ""}`)
        }
      }
      if (!watch) break
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
    throw new Error("bay: audit is landing (src/layers/audit.ts not present yet) — see @hab/20926-gitbay M1-c")
  }
  const findings = await withWriteBay(ctx, async (bay) => {
    const audited = mod.withAudit()(bay)
    const { events } = await audited.dispatch({ type: "audit", args: { mainRepo: ctx.mainRepo } })
    const done = events.find((e) => e.type === "audit.completed")
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

async function hookPre(ctx: Ctx): Promise<void> {
  const updates = parseReceiveStdin(await readStdin())
  const bay = readBay(ctx)
  const state = await bay.state()
  const messages = await preReceiveCheck(state, updates, { repoGit: ctx.repoGit, mainRepo: ctx.mainRepo })
  for (const m of messages) console.log(m)
}

async function hookPost(ctx: Ctx): Promise<void> {
  const updates = parseReceiveStdin(await readStdin())
  for (const u of updates) {
    const branch = u.ref.replace(/^refs\/heads\//, "")
    try {
      await withWriteBay(ctx, async (bay) => {
        const { events } = await bay.dispatch({ type: "submit", args: { branch, sha: u.newSha } })
        printVerdict(events)
      })
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes("another bay writer is running")) {
        await appendInboxReceipt(ctx.bayDir, { branch, sha: u.newSha, ts: new Date().toISOString() })
        console.log(`bay: writer busy — ${branch} queued to inbox; the daemon will ingest it`)
      } else {
        console.log(msg.startsWith("bay:") ? msg : `bay: ${msg}`)
      }
    }
  }
}

// ---------- dispatch ----------

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  return value
}

const USAGE = `usage: git bay <verb>
  init                      set up .bay/ (store, bay-owned repo.git, hooks)
  co <workitem>             loan a guarded bay; prints its path (cd-able)
  status [changeset]        bay table, or one changeset's verdict  [--json]
  enqueue <target>          queue a branch/SHA for the merge worker
  requeue <changeset>       resume a merging/rejected changeset
  drain [--watch]           run the merge worker  [--interval <sec>]
  abandon <lease>           end a lease; WIP is preserved, never deleted
  adopt <branch>            make a legacy branch a changeset  [--workitem <id>]
  ping <lease>              refresh a lease's idle clock
  gc                        expire idle leases (WIP snapshotted, never deleted)
  audit                     strays, pins, refs without workitems  [--json]`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const verb = args.shift()
  const json = flag(args, "--json")
  flag(args, "--no-workitem") // accepted for forward-compat; no provider in M1
  const ctx = await resolveCtx()

  switch (verb) {
    case "init":
      return await verbInit(ctx)
    case "co":
    case "checkout":
      return await verbCo(ctx, args[0])
    case "status":
      return await verbStatus(ctx, args[0], json)
    case "enqueue":
      return await verbEnqueue(ctx, args[0], opt(args, "--workitem"))
    case "requeue":
      return await verbRequeue(ctx, args[0])
    case "drain":
      return await verbDrain(ctx, flag(args, "--watch"), Number(opt(args, "--interval") ?? "15"))
    case "abandon":
      return await verbAbandon(ctx, args[0])
    case "adopt": {
      const branch = args[0]
      if (!branch) throw new Error("bay: adopt: a branch name is required")
      const workitem = opt(args, "--workitem")
      await withWriteBay(ctx, async (bay) => {
        const { events } = await bay.dispatch({ type: "adopt", args: { branch, workitem } })
        console.log(events.find((e) => e.type === "changeset.enqueued")?.changeset ?? "")
      })
      return
    }
    case "ping": {
      const lease = args[0]
      if (!lease) throw new Error("bay: ping: a lease id is required (git bay status --json lists them)")
      await withWriteBay(ctx, async (bay) => {
        await bay.dispatch({ type: "ping", args: { lease } })
      })
      return
    }
    case "gc":
      await withWriteBay(ctx, async (bay) => {
        const { events } = await bay.dispatch({ type: "gc" })
        for (const e of events) {
          if (e.type === "lease.ended") {
            const d = e.data as { lease: string }
            console.log(`bay: lease ${d.lease} expired — WIP preserved; bay reclaimable`)
          }
          if (e.type === "gc.clean") console.log("bay: gc clean — no idle leases past TTL")
        }
      })
      return
    case "audit":
      return await verbAudit(ctx, json)
    case "receive-pre":
      return await hookPre(ctx)
    case "receive-post":
      return await hookPost(ctx)
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE)
      return
    default:
      throw new Error(`bay: unknown verb '${verb}'\n${USAGE}`)
  }
}

main().catch((err) => {
  const msg = (err as Error).message ?? String(err)
  console.error(msg.startsWith("bay:") ? msg : `bay: ${msg}`)
  process.exit(1)
})
