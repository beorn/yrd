import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  Effect,
  EffectHandler,
  Layer,
  Lease,
  TransitionResult,
} from "../types.ts"
import { makeEvent } from "../core.ts"
import { createGitConfigSource, resolveOption } from "../config.ts"
import { git, resolveBaseRef } from "./git.ts"

/**
 * withAudit — the `git bay audit` verb (spec § The verbs: "strays, pin
 * reachability, refs with no workitem — read-only, exit 1 if findings"; M1 slice
 * of @hab/20926-gitbay). It is a strictly READ-ONLY layer: the reducer emits an
 * `audit.run` effect and no events; the effect handler only reads (git rev-parse
 * / merge-base --is-ancestor / ls-tree / cat-file -e / for-each-ref) and reports
 * findings. It NEVER mutates a repo or the ledger — auditing must be safe to run
 * at any time, from any state, changing nothing.
 *
 * Interlock rule (spec): audit consumes only lower layers' STATE — leases from
 * withWorkspaces, and (optionally) the queue slice — never their internals. It
 * degrades gracefully: with no workspaces layer it sees no leases; with no queue
 * layer it sees no queued targets. Each check independently reports what it can.
 *
 * Exit-code contract: this layer surfaces `{ findings, clean }`; the CLI maps
 * clean → exit 0 and any finding → exit 1 (spec § verbs). `formatAudit` renders
 * the human text (law 7: every refusal names its remedy).
 */

const LAYER = "audit"
const EV_COMPLETED = "audit.completed"
const FX_RUN = "audit.run"

export type AuditFinding = {
  kind: "stray" | "unreachable-pin" | "no-workitem-ref"
  subject: string
  detail: string
  remedy: string
}

// ---------- human rendering (law 7) ----------

/** Exactly the happy-path doc's clean line when there is nothing to report;
 *  otherwise one `bay: <kind>: <subject> — <detail>. Fix: <remedy>` line per
 *  finding. Pure — the CLI prints this and sets its exit code from `clean`. */
export function formatAudit(findings: AuditFinding[]): string {
  if (findings.length === 0) {
    return "bay: clean — no strays, no unreachable pins, no refs without a workitem"
  }
  return findings.map((f) => `bay: ${f.kind}: ${f.subject} — ${f.detail}. Fix: ${f.remedy}`).join("\n")
}

// ---------- reducer (pure; read-only → one effect, no events) ----------

function reduceAudit(state: BayState, command: BayCommand): TransitionResult {
  const rawMainRepo = command.args?.mainRepo
  if (rawMainRepo !== undefined && (typeof rawMainRepo !== "string" || rawMainRepo.trim() === "")) {
    throw new Error("bay: audit: 'mainRepo' must be a non-empty string when provided")
  }
  const mainRepo: string | null = typeof rawMainRepo === "string" ? rawMainRepo : null
  const effect: Effect = { type: FX_RUN, data: { mainRepo } }
  return { state, events: [], effects: [effect] }
}

// ---------- the three checks (async; read-only git) ----------

/** Resolve the mainrepo: inline (effect data) > BAY_MAIN_REPO > git config
 *  bay.mainRepo > process.cwd(). Short-circuits on inline, so a caller that
 *  passes mainRepo (the CLI, and the tests) spawns no `git config`. */
async function resolveMainRepo(inline: string | null): Promise<string> {
  const source = createGitConfigSource(inline ?? process.cwd())
  const resolved = await resolveOption(inline ?? undefined, "mainRepo", source, process.cwd())
  return resolved! // the process.cwd() fallback guarantees a value
}

/** Ended leases (merged/abandoned) whose branch tip is neither on the mainline
 *  nor preserved under refs/bay/abandoned/<changeId> — orphaned work. */
async function findStrays(mainRepo: string, leases: Lease[]): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = []
  const mainlineRef = await resolveBaseRef(mainRepo)
  for (const lease of leases) {
    if (lease.endedAt === undefined) continue
    if (lease.endReason !== "merged" && lease.endReason !== "abandoned") continue

    const tipRes = await git(["-C", mainRepo, "rev-parse", "--verify", "--quiet", `${lease.branch}^{commit}`])
    if (tipRes.code !== 0) continue // branch already gone — nothing left to strand
    const tip = tipRes.stdout.trim()

    const onMainline = await git(["-C", mainRepo, "merge-base", "--is-ancestor", tip, mainlineRef])
    if (onMainline.code === 0) continue // reachable from the mainline — fine

    const preserved = await git([
      "-C", mainRepo, "rev-parse", "--verify", "--quiet", `refs/bay/abandoned/${lease.changeId}`,
    ])
    if (preserved.code === 0) continue // WIP archived — fine

    findings.push({
      kind: "stray",
      subject: lease.branch,
      detail: `${lease.endReason} lease ${lease.id} tip ${tip.slice(0, 12)} is not reachable from ${mainlineRef} and has no refs/bay/abandoned/${lease.changeId} backup`,
      remedy: `git bay adopt ${lease.branch} (or archive the tip to refs/bay/abandoned/${lease.changeId}) before it is GC'd, then review manually`,
    })
  }
  return findings
}

/** Every gitlink pinned in HEAD whose commit is not present in the submodule
 *  repo (the ephemeral-pin class from the 07-07 forensics). No .gitmodules in
 *  HEAD → no submodules → clean, skip entirely. */
async function findUnreachablePins(mainRepo: string): Promise<AuditFinding[]> {
  const hasModules = await git(["-C", mainRepo, "cat-file", "-e", "HEAD:.gitmodules"])
  if (hasModules.code !== 0) return [] // no submodules configured

  const ls = await git(["-C", mainRepo, "ls-tree", "-r", "HEAD"])
  if (ls.code !== 0) {
    throw new Error(`bay: audit: git ls-tree HEAD failed (exit ${ls.code}):\n${ls.stderr.trim()}`)
  }

  const findings: AuditFinding[] = []
  for (const line of ls.stdout.split("\n")) {
    if (line === "") continue
    // "<mode> <type> <sha>\t<path>" — gitlinks have mode 160000 / type commit.
    const tab = line.indexOf("\t")
    if (tab === -1) continue
    const meta = line.slice(0, tab).split(/\s+/)
    const path = line.slice(tab + 1)
    if (meta[0] !== "160000") continue
    const sha = meta[2]!

    const reachable = await git(["-C", `${mainRepo}/${path}`, "cat-file", "-e", `${sha}^{commit}`])
    if (reachable.code !== 0) {
      findings.push({
        kind: "unreachable-pin",
        subject: path,
        detail: `gitlink pins ${sha.slice(0, 12)} but that commit is not present in ${path}`,
        remedy: `git -C ${path} fetch the pinned commit, or move the pin to a reachable SHA, before merge`,
      })
    }
  }
  return findings
}

/** Local task/* or bay/* branches that no lease or queued changeset accounts
 *  for — the no-branch-without-workitem doctrine, checked after the fact. */
async function findNoWorkitemRefs(mainRepo: string, state: BayState): Promise<AuditFinding[]> {
  const known = new Set<string>()
  for (const lease of Object.values(state.leases)) known.add(lease.branch)
  // Queue targets may be branch names; read the slice loosely so audit does not
  // hard-depend on withQueue being registered (graceful degradation).
  const queue = state.slices.queue as { targets?: Record<string, string> } | undefined
  if (queue?.targets) for (const target of Object.values(queue.targets)) known.add(target)

  const refs = await git(["-C", mainRepo, "for-each-ref", "--format=%(refname:short)", "refs/heads/"])
  if (refs.code !== 0) {
    throw new Error(`bay: audit: git for-each-ref failed (exit ${refs.code}):\n${refs.stderr.trim()}`)
  }

  const findings: AuditFinding[] = []
  for (const branch of refs.stdout.split("\n")) {
    if (branch === "") continue
    if (!branch.startsWith("task/") && !branch.startsWith("bay/")) continue
    if (known.has(branch)) continue
    findings.push({
      kind: "no-workitem-ref",
      subject: branch,
      detail: `local branch matches task/*|bay/* but no lease or changeset references it`,
      remedy: `git bay co <workitem> to adopt it, or git branch -D ${branch} if it is abandoned`,
    })
  }
  return findings
}

// ---------- effect handler (async; the only I/O; strictly read-only) ----------

const auditRunHandler: EffectHandler = async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
  const mainRepo = await resolveMainRepo((effect.data as { mainRepo: string | null }).mainRepo)
  const state = await bay.state()

  const findings: AuditFinding[] = [
    ...(await findStrays(mainRepo, Object.values(state.leases))),
    ...(await findUnreachablePins(mainRepo)),
    ...(await findNoWorkitemRefs(mainRepo, state)),
  ]

  return [makeEvent(bay, EV_COMPLETED, { findings, clean: findings.length === 0 })]
}

// ---------- the plugin ----------

export function withAudit(): BayPlugin {
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      // No apply: audit records an audit.completed event as an audit-trail row but
      // owns no state slice — it derives everything from lower layers + git at run.
      reduce(state, command, next) {
        if (command.type === "audit") return reduceAudit(state, command)
        return next(state, command)
      },
      effects: { [FX_RUN]: auditRunHandler },
    }
    return bay.use(layer)
  }
}
