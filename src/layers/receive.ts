import { chmod, mkdir, writeFile, appendFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  ChangeId,
  Effect,
  Layer,
  Lease,
  TransitionResult,
} from "../types.ts"
import { makeEvent } from "../core.ts"
import { createGitConfigSource, resolveOption } from "../config.ts"
import { enqueuedEvent, stateChangeEvent } from "./queue.ts"
import { git, porcelainStatus, repoScopedCleanEnv } from "./git.ts"

/**
 * withReceive — the receiver (spec § Using it: "the remote is the API"; M1-b of
 * @hab/20926-gitbay). It owns the bay-owned local repo (`<bayDir>/repo.git`),
 * its pre/post-receive hooks (written self-locating at `init`, law 8), and the
 * synchronous submit pipeline behind `git push -o wait`.
 *
 * M1 scope notes (documented cuts, each tied to the bead):
 * - Staging-refs promotion (spec § Changesets, /pro A1) arrives with M3 when
 *   the merge is owned natively; M1 merges a single-repo changeset directly
 *   onto the mainline working tree under clean-tree preconditions.
 * - Pin refusal handles the descendant + ADD cases; the patch-id rewrite
 *   tolerance (/pro A5) lands with the M2 receiver hardening.
 * - Crash mid-submit leaves the changeset in `checking` (reducer events are
 *   journaled before the effect runs); `requeue` resumes it. No duplicate
 *   merge is possible because the merge only runs inside the effect.
 */

const LAYER = "receive"
const EV_INITIALIZED = "bay.initialized"
const FX_INIT = "receive.init"
const FX_SUBMIT = "submit.run"

export type ReceiveOptions = {
  mainRepo?: string
  bayDir?: string
  /** ONE project check command (spec § Check provider). Inline > BAY_CHECK >
   *  git config bay.check > none (stage skipped with an explicit detail). */
  check?: string
}

export type ResolvedReceive = { mainRepo: string; bayDir: string; repoGit: string }

export async function resolveReceive(opts: ReceiveOptions): Promise<ResolvedReceive> {
  const cwd = opts.mainRepo ?? process.cwd()
  const source = createGitConfigSource(cwd)
  const mainRepo = (await resolveOption(opts.mainRepo, "mainRepo", source, cwd))!
  const bayDir = (await resolveOption(opts.bayDir, "dir", createGitConfigSource(mainRepo), join(mainRepo, ".bay")))!
  return { mainRepo, bayDir, repoGit: join(bayDir, "repo.git") }
}

// ---------- state lookup (published for hooks + CLI) ----------

/** Latest lease (open or ended) whose branch matches — push correlation by
 *  (branch → lease → change-id), spec § Changesets and identity. */
export function leaseForBranch(state: BayState, branch: string): Lease | undefined {
  let best: Lease | undefined
  for (const lease of Object.values(state.leases)) {
    if (lease.branch !== branch) continue
    if (!best || lease.createdAt > best.createdAt) best = lease
  }
  return best
}

// ---------- reducers (pure) ----------

function reduceInit(bay: BayRuntime, state: BayState, opts: ReceiveOptions): TransitionResult {
  const effect: Effect = { type: FX_INIT, data: { ...opts } }
  return { state, events: [], effects: [effect] }
}

/** submit {branch, sha}: correlate to a lease/changeset, enqueue (or requeue a
 *  rejected revision), transition queued→checking, and hand the pipeline to the
 *  submit.run effect. Doors-closed (already merged) is refused HERE too — the
 *  pre-receive hook refuses earlier for UX, but the reducer is the layer that
 *  must hold without the hook (law 4: the receiver refuses last). */
function reduceSubmit(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const branch = command.args?.branch
  const sha = command.args?.sha
  if (typeof branch !== "string" || branch === "") throw new Error("bay: submit: 'branch' is required")
  if (typeof sha !== "string" || sha === "") throw new Error("bay: submit: 'sha' is required")

  const lease = leaseForBranch(state, branch)
  const changeId: ChangeId = lease?.changeId ?? `C-adopt-${branch.replace(/[^A-Za-z0-9._-]/g, "_")}`
  const existing = state.changesets[changeId]

  const events: BayEvent[] = []
  if (existing) {
    if (existing.state === "merged") {
      throw new Error(
        `bay: doors closed — changeset ${changeId} for '${branch}' is already merged. ` +
          `Open a new loan: git bay co <workitem>`,
      )
    }
    if (existing.state === "rejected") {
      events.push(stateChangeEvent(bay, changeId, "rejected", "queued", `re-push of ${branch}`))
    } else if (existing.state !== "queued") {
      throw new Error(
        `bay: changeset ${changeId} is ${existing.state} — wait for the verdict (git bay status ${changeId})`,
      )
    }
  } else {
    events.push(enqueuedEvent(bay, changeId, branch, lease?.workitem ?? null))
  }
  events.push(stateChangeEvent(bay, changeId, "queued", "checking"))

  const effect: Effect = {
    type: FX_SUBMIT,
    data: { changeset: changeId, branch, sha, bayPath: lease?.path ?? null, lease: lease?.id ?? null },
  }
  return { state, events, effects: [effect] }
}

// ---------- effect handlers (async; the only I/O) ----------

function tail(text: string, max = 2000): string {
  const trimmed = text.replace(/\s+$/, "")
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}

/** The hook shim: dependency-free sh that execs this repo's bun + bin with the
 *  bay dir pinned. Version-stamped so law-8 preflights can detect staleness. */
export const HOOK_VERSION = "bay-hook-v1"

function hookScript(mode: "pre" | "post", bayDir: string, mainRepo: string): string {
  const bun = process.execPath
  const bin = new URL("../../bin/git-bay.ts", import.meta.url).pathname
  return [
    "#!/bin/sh",
    `# ${HOOK_VERSION} — written by 'git bay init'; refresh: git bay init`,
    `BAY_DIR="${bayDir}" BAY_MAIN_REPO="${mainRepo}" exec "${bun}" "${bin}" receive-${mode}`,
    "",
  ].join("\n")
}

function makeInitHandler(opts: ReceiveOptions) {
  return async (_effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const { mainRepo, bayDir, repoGit } = await resolveReceive(opts)
    await mkdir(bayDir, { recursive: true })
    // Self-excluding state dir (the .direnv pattern): `*` ignores everything
    // under .bay including this file, so bay never dirties the host repo.
    await writeFile(join(bayDir, ".gitignore"), "*\n", "utf8")

    if (!existsSync(repoGit)) {
      const res = await git(["init", "--bare", "--initial-branch=main", repoGit])
      if (res.code !== 0) throw new Error(`bay: git init --bare failed (exit ${res.code}):\n${res.stderr.trim()}`)
    }
    const cfg = await git(["-C", repoGit, "config", "receive.advertisePushOptions", "true"])
    if (cfg.code !== 0) throw new Error(`bay: config advertisePushOptions failed:\n${cfg.stderr.trim()}`)

    // Mirror the mainline branches in so merge-base/pin checks see history.
    const fetch = await git(["-C", repoGit, "fetch", "--quiet", mainRepo, "+refs/heads/*:refs/heads/*"])
    if (fetch.code !== 0) throw new Error(`bay: initial fetch into ${repoGit} failed:\n${fetch.stderr.trim()}`)

    const hooksDir = join(repoGit, "hooks")
    await mkdir(hooksDir, { recursive: true })
    for (const mode of ["pre", "post"] as const) {
      const path = join(hooksDir, `${mode}-receive`)
      await writeFile(path, hookScript(mode, bayDir, mainRepo), "utf8")
      await chmod(path, 0o755)
    }

    return [
      makeEvent(bay, EV_INITIALIZED, {
        repo: repoGit,
        journal: join(bayDir, "journal.jsonl"),
        store: "sqlite",
      }),
    ]
  }
}

async function resolveCheck(opts: ReceiveOptions, mainRepo: string): Promise<string | undefined> {
  const source = createGitConfigSource(mainRepo)
  return await resolveOption(opts.check, "check", source)
}

function makeSubmitHandler(opts: ReceiveOptions) {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as {
      changeset: ChangeId
      branch: string
      sha: string
      bayPath: string | null
      lease: string | null
    }
    const { mainRepo, repoGit } = await resolveReceive(opts)
    const events: BayEvent[] = []

    // 1. The ONE project check, on the submitter's own bay (M1 form of
    //    "speculative checks on the submitter's bay").
    const check = await resolveCheck(opts, mainRepo)
    if (check !== undefined && check.trim() !== "") {
      const cwd = d.bayPath ?? mainRepo
      const proc = Bun.spawn(["sh", "-c", check], { cwd, stdout: "pipe", stderr: "pipe", env: repoScopedCleanEnv() })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) {
        const detail = `check '${check}' failed (exit ${code}): ${tail(err || out)}`
        events.push(stateChangeEvent(bay, d.changeset, "checking", "rejected", detail))
        return events
      }
    }

    // 2. Merge onto the mainline — clean-tree precondition first (/pro A1's
    //    clean-checkout assertion; refuse rather than merge into someone's WIP).
    //    Untracked files don't block: git merge itself refuses to overwrite
    //    them, and blocking on them would make every stray note a merge outage.
    const dirty = (await porcelainStatus(mainRepo))
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("??"))
      .join("\n")
    if (dirty !== "") {
      events.push(
        stateChangeEvent(
          bay,
          d.changeset,
          "checking",
          "rejected",
          `mainline working tree at ${mainRepo} is dirty — commit or clean it, then git bay requeue ${d.changeset}`,
        ),
      )
      return events
    }
    events.push(stateChangeEvent(bay, d.changeset, "checking", "merging"))

    const headRes = await git(["-C", mainRepo, "symbolic-ref", "--short", "HEAD"])
    const mainline = headRes.code === 0 ? headRes.stdout.trim() : "main"
    const merge = await git([
      "-C",
      mainRepo,
      "merge",
      "--no-ff",
      "-m",
      `bay: merge ${d.changeset} (${d.branch})`,
      d.sha,
    ])
    if (merge.code !== 0) {
      await git(["-C", mainRepo, "merge", "--abort"]) // best-effort restore; a failed abort surfaces below
      const detail = `merge of ${d.branch} onto ${mainline} failed (exit ${merge.code}): ${tail(merge.stderr || merge.stdout)}`
      events.push(stateChangeEvent(bay, d.changeset, "merging", "rejected", detail))
      return events
    }
    const mergeSha = (await git(["-C", mainRepo, "rev-parse", "HEAD"])).stdout.trim()

    // 3. Keep the bay-owned repo's mainline current so the next push's
    //    merge-base sees reality.
    await git(["-C", repoGit, "fetch", "--quiet", mainRepo, `+refs/heads/${mainline}:refs/heads/${mainline}`])

    events.push(stateChangeEvent(bay, d.changeset, "merging", "merged", `merged ${mergeSha} onto ${mainline}`))
    if (d.lease) {
      events.push(makeEvent(bay, "lease.ended", { lease: d.lease, endReason: "merged" }, { lease: d.lease, changeset: d.changeset }))
    }
    return events
  }
}

// ---------- hook-side logic (exported so bin stays thin) ----------

export type RefUpdate = { oldSha: string; newSha: string; ref: string }

export function parseReceiveStdin(input: string): RefUpdate[] {
  return input
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [oldSha, newSha, ref] = line.split(/\s+/)
      if (!oldSha || !newSha || !ref) throw new Error(`bay: malformed receive line: '${line}'`)
      return { oldSha, newSha, ref }
    })
}

const ZERO_SHA = /^0+$/

/** Pre-receive verdict: doors-closed on merged changesets + gitlink pin rules.
 *  Read-only (fold via a read store); refusals throw with the remedy. */
export async function preReceiveCheck(
  state: BayState,
  updates: RefUpdate[],
  ctx: { repoGit: string; mainRepo: string },
): Promise<string[]> {
  const messages: string[] = []
  for (const u of updates) {
    const branch = u.ref.replace(/^refs\/heads\//, "")
    const lease = leaseForBranch(state, branch)
    const changeset = lease ? state.changesets[lease.changeId] : undefined
    if (changeset?.state === "merged") {
      throw new Error(
        `bay: doors closed — changeset ${changeset.id} for '${branch}' is already merged. ` +
          `Open a new loan: git bay co <workitem>`,
      )
    }

    // Gitlink pin rules over the pushed range (skip for branch deletes/creates
    // with no base — the ADD case is allowed by design).
    if (ZERO_SHA.test(u.oldSha) || ZERO_SHA.test(u.newSha)) continue
    const diff = await git(["-C", ctx.repoGit, "diff-tree", "-r", u.oldSha, u.newSha])
    if (diff.code !== 0) continue // objects may be thin pre-quarantine; the reducer re-checks
    for (const line of diff.stdout.split("\n")) {
      // :160000 160000 <old> <new> M\t<path> — diff-tree emits FULL shas (never --raw abbrev)
      const m = line.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) [A-Z]\t(.+)$/)
      if (!m) continue
      const [, oldMode, newMode, oldPin, newPin, path] = m
      if (newMode !== "160000") continue
      if (oldMode !== "160000") continue // gitlink ADD/typechange: allowed
      if (oldPin === newPin) continue
      const subRepo = join(ctx.mainRepo, path!)
      if (!existsSync(subRepo)) {
        messages.push(`bay: note — submodule '${path}' not present at ${ctx.mainRepo}; pin move accepted unverified`)
        continue
      }
      const anc = await git(["-C", subRepo, "merge-base", "--is-ancestor", oldPin!, newPin!])
      if (anc.code !== 0) {
        // Patch-id rewrite tolerance (/pro A5): a rebase/amend rewrite carries
        // the same patches under new SHAs — that is not a lineage jump. Allow
        // it (journaled via the accepted message); refuse genuine rewinds.
        const verdict = await patchIdRewriteVerdict(subRepo, oldPin!, newPin!)
        if (verdict.rewrite) {
          messages.push(
            `bay: note — gitlink '${path}' pin move is a history rewrite ` +
              `(${verdict.matched}/${verdict.oldCount} old patches present under new SHAs; base ${verdict.base.slice(0, 12)}) — allowed`,
          )
          continue
        }
        throw new Error(
          `bay: pin refusal — gitlink '${path}' moves ${oldPin!.slice(0, 12)} → ${newPin!.slice(0, 12)}: ` +
            `not a descendant and not a recognizable rewrite (${verdict.reason}). ` +
            `Rebase the submodule forward or merge it; a genuine history replacement needs an explicit override (M3 evidence token).`,
        )
      }
    }
    messages.push(`bay: ref ${branch} accepted for intake`)
  }
  return messages
}

/** Rewrite-vs-rewind verdict for a non-descendant pin move (/pro A5).
 *  Mechanism: patches, not SHAs. From the merge-base of the two pins, collect
 *  `git patch-id --stable` for each side's range; the move is a REWRITE when
 *  every old patch is present under the new history (subset — additions on top
 *  are fine, that is exactly what a rebase-plus-new-work looks like). A missing
 *  old patch means history was dropped or replaced → rewind → refuse upstream.
 *  Cost note: runs only on the already-exceptional refusal path. */
export async function patchIdRewriteVerdict(
  subRepo: string,
  oldPin: string,
  newPin: string,
): Promise<{ rewrite: boolean; matched: number; oldCount: number; base: string; reason: string }> {
  const baseRes = await git(["-C", subRepo, "merge-base", oldPin, newPin])
  if (baseRes.code !== 0) {
    return { rewrite: false, matched: 0, oldCount: 0, base: "", reason: "no common ancestor (unrelated histories)" }
  }
  const base = baseRes.stdout.trim()

  const ids = async (pin: string): Promise<string[]> => {
    const proc = Bun.spawn(
      ["sh", "-c", `git -C "${subRepo}" log -p --full-index ${base}..${pin} | git patch-id --stable`],
      { stdout: "pipe", stderr: "pipe", env: repoScopedCleanEnv() },
    )
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`bay: patch-id over ${base.slice(0, 12)}..${pin.slice(0, 12)} failed: ${err.trim()}`)
    return out
      .split("\n")
      .map((l) => l.split(/\s+/)[0])
      .filter((id): id is string => !!id)
  }

  const oldIds = await ids(oldPin)
  const newIds = new Set(await ids(newPin))
  const matched = oldIds.filter((id) => newIds.has(id)).length
  if (oldIds.length === 0) {
    return { rewrite: false, matched: 0, oldCount: 0, base, reason: "old pin contributes no patches over the base" }
  }
  if (matched === oldIds.length) {
    return { rewrite: true, matched, oldCount: oldIds.length, base, reason: "all old patches present" }
  }
  return {
    rewrite: false,
    matched,
    oldCount: oldIds.length,
    base,
    reason: `${oldIds.length - matched} of ${oldIds.length} old patches missing from the new history`,
  }
}

/** Inbox receipt for the daemon path: when the writer lock is held, the hook
 *  appends here instead of dispatching; drain --watch ingests it. */
export async function appendInboxReceipt(
  bayDir: string,
  receipt: { branch: string; sha: string; ts: string },
): Promise<void> {
  await appendFile(join(bayDir, "inbox.jsonl"), JSON.stringify(receipt) + "\n", "utf8")
}

// ---------- the plugin ----------

export function withReceive(opts: ReceiveOptions = {}): BayPlugin {
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      reduce(state, command, next) {
        if (command.type === "init") return reduceInit(bay, state, opts)
        if (command.type === "submit") return reduceSubmit(bay, state, command)
        return next(state, command)
      },
      effects: {
        [FX_INIT]: makeInitHandler(opts),
        [FX_SUBMIT]: makeSubmitHandler(opts),
      },
    }
    return bay.use(layer)
  }
}
