import { chmod, mkdir, writeFile, appendFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  Effect,
  Layer,
  Lease,
  PrId,
  TransitionResult,
} from "../types.ts"
import { makeEvent } from "../core.ts"
import { nextPrId } from "../ids.ts"
import { createGitConfigSource, resolveOption } from "../config.ts"
import { collectStepRefs, stepError, stepMetadata, writeStepArtifacts } from "./artifacts.ts"
import { prForTarget, prOpenedEvent, stateChangeEvent } from "./queue.ts"
import { defaultBayDir, git, repoScopedCleanEnv, resolveBaseRef } from "./git.ts"
import { resolveCheck, runMerge, runProjectCheck } from "./pipeline.ts"
import { hasReusableSuccessfulStep, skippedStepEvents, stepConfigHash, stepFinished, stepStarted } from "./steps.ts"

/**
 * withReceive — the receiver (spec § Using it: "the remote is the API"; v0.1-b of
 * @hab/20926-gitbay). It owns the bay-owned local repo (`<bayDir>/repo.git`),
 * its pre/post-receive hooks (written self-locating at `init`, law 8), and the
 * synchronous submit pipeline behind `git push -o wait`.
 *
 * v0.1 scope notes (documented cuts, each tied to the bead):
 * - Staging-refs promotion (spec § Changesets, /pro A1) arrives with v0.3 when
 *   the merge is owned natively; v0.1 merges a single-repo PR directly onto
 *   the mainline working tree under clean-tree preconditions.
 * - Pin refusal handles the descendant + ADD cases; the patch-id rewrite
 *   tolerance (/pro A5) lands with the v0.2 receiver hardening.
 * - Crash mid-submit leaves the PR in `checking` (reducer events are
 *   journaled before the effect runs); `retry` resumes it. No duplicate
 *   merge is possible because the merge only runs inside the effect.
 */

const LAYER = "receive"
const EV_INITIALIZED = "gitbay/initialized"
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
  const bayDir = (await resolveOption(opts.bayDir, "dir", createGitConfigSource(mainRepo), (await defaultBayDir(mainRepo)).dir))!
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

/** submit {branch, sha, queued?, autoMerge?}: correlate to a lease/PR, create
 *  the PR (or resume a rejected one as its next revision), and drive it
 *  through the two independent auto-flow toggles the CLI host resolves before
 *  dispatch (docs/model.md § The auto-flow): `queued` is `bay.autoSubmit` (or
 *  a forcing push option, `-o submit`/`-o wait`, or legacy `bay.autoQueue`) —
 *  true fuses this push's creation/transition straight into `submitted`;
 *  false stops at `pushed`. `autoMerge` is `bay.autoMerge` (or legacy
 *  `bay.autoQueue`) — true additionally hands a submitted PR straight to the
 *  submit.run effect (check then merge, inline); false rests it at
 *  `submitted` for a manual `check`/`merge`/`integrate`. A bare push that
 *  neither flag turns on (queued: false/undefined) creates the PR in `pushed`
 *  and stops there: nothing runs until `git bay submit <PR>` (or a later
 *  fused push) asks to land it. Doors-closed (already merged/closed) is
 *  refused HERE too — the pre-receive hook refuses earlier for UX, but the
 *  reducer is the layer that must hold without the hook (law 4: the receiver
 *  refuses last). `sha` is validated but not threaded into the effect — the
 *  merge step re-resolves `branch` to a commit itself (pipeline.ts's
 *  runMerge), the same way every other merge path does, so a push and a
 *  standalone `merge`/`integrate` pin identically. */
function reduceSubmit(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const branch = command.args?.branch
  const sha = command.args?.sha
  if (typeof branch !== "string" || branch === "") throw new Error("bay: submit: 'branch' is required")
  if (typeof sha !== "string" || sha === "") throw new Error("bay: submit: 'sha' is required")
  const queued = command.args?.queued === true
  const autoMerge = command.args?.autoMerge === true

  // Correlation order: the worktree wins (lease → PR number), then a PR already
  // tracking this branch (push = a revision of it, never a duplicate), then a
  // fresh sequential mint for orphan pushes.
  const lease = leaseForBranch(state, branch)
  const tracked = prForTarget(state, branch)
  const prId: PrId = lease?.changeId ?? tracked ?? nextPrId(state)
  const existing = state.prs[prId]

  const events: BayEvent[] = []
  const runPipeline = (): TransitionResult => {
    events.push(stateChangeEvent(bay, prId, "submitted", "checking", command.cause!))
    const effect: Effect = {
      type: FX_SUBMIT,
      data: { pr: prId, branch, bayPath: lease?.path ?? null, lease: lease?.id ?? null },
    }
    return { state, events, effects: [effect] }
  }

  if (existing) {
    if (existing.state === "merged") {
      throw new Error(
        `bay: doors closed — ${prId} for '${branch}' is already merged. ` +
          `Start the next piece of work in a fresh bay: git bay open <name>`,
      )
    }
    if (existing.state === "closed") {
      throw new Error(
        `bay: doors closed — ${prId} for '${branch}' was withdrawn. ` +
          `Start the next piece of work in a fresh bay: git bay open <name>`,
      )
    }
    if (existing.state === "rejected") {
      // Re-push after rejection: same PR number, next revision — always
      // resubmitted regardless of the autoSubmit flag (the PR already asked
      // to merge once; a bare fix-up push is a retry, not a fresh ask), but
      // the pipeline only runs again if autoMerge says so — same rule as
      // every other submitted PR.
      events.push(
        stateChangeEvent(bay, prId, "rejected", "submitted", command.cause!, {
          detail: `re-push of ${branch}`,
          revision: existing.revision + 1,
        }),
      )
      return autoMerge ? runPipeline() : { state, events, effects: [] }
    }
    if (existing.state === "pushed") {
      if (!queued) {
        // Still just iterating before asking to land — nothing changed PR-wise
        // (git already reports the new commits); non-event, nothing to journal.
        return { state, events: [], effects: [] }
      }
      events.push(stateChangeEvent(bay, prId, "pushed", "submitted", command.cause!))
      return autoMerge ? runPipeline() : { state, events, effects: [] }
    }
    if (existing.state === "submitted") {
      // Already submitted (e.g. `retry`'s own requeue-then-resubmit dance
      // already moved it here in an earlier dispatch this same command
      // sequence, always passing autoMerge: true — retry always resumes
      // regardless of config) — run the pipeline only if autoMerge says so;
      // otherwise this is just new commits landing on a PR that is
      // deliberately resting at `submitted` (bay.autoMerge false) — a
      // non-event, nothing new to transition into.
      return autoMerge ? runPipeline() : { state, events: [], effects: [] }
    }
    throw new Error(`bay: ${prId} is ${existing.state} — wait for the verdict (git bay ls ${prId})`)
  }

  // Brand new PR from this push.
  events.push(prOpenedEvent(bay, prId, branch, lease?.workitem ?? null, "push", queued, command.cause!))
  if (!queued) {
    return { state, events, effects: [] } // created, stops at `pushed` — no pipeline yet
  }
  if (!autoMerge) {
    return { state, events, effects: [] } // fused into `submitted` — rests there for a manual check/merge/integrate
  }
  return runPipeline()
}

// ---------- effect handlers (async; the only I/O) ----------

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
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
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
      makeEvent(
        bay,
        EV_INITIALIZED,
        { repo: repoGit, journal: join(bayDir, "journal.jsonl"), store: "sqlite" },
        effect.cause!,
      ),
    ]
  }
}

/** A fused push's continuation: check then merge, in one effect call — the
 *  SAME two runners (pipeline.ts) the standalone `check`/`merge`/`integrate`
 *  verbs use, so a push and those verbs check and merge identically (§4).
 *  Crash mid-effect leaves the PR durably `checking` or `merging` (the
 *  reducer's transition into each was journaled before this ran); `retry`
 *  resumes it exactly as `integrate` would. */
function makeSubmitHandler(opts: ReceiveOptions) {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as { pr: PrId; branch: string; bayPath: string | null; lease: string | null }
    const { mainRepo, bayDir, repoGit } = await resolveReceive(opts)
    const events: BayEvent[] = []

    // 0. Pin rules, authoritatively (LE-4/SG-2, 21002): post-quarantine,
    //    against the mainline merge-base — covers thin-pack diff-tree skips
    //    and new-branch pushes the pre-receive hook could not judge. Same
    //    provider (judgePinMoves) as the hook: one verdict, every door.
    const pins = await checkSubmitPins(mainRepo, d.branch)
    if (pins.refusal) {
      events.push(
        stateChangeEvent(bay, d.pr, "checking", "rejected", effect.cause!, {
          code: "pin-rewind",
          detail: pins.refusal,
        }),
      )
      return events
    }

    // 1. The ONE project check, on the submitter's own bay (spec § Check
    //    provider: "speculative checks on the submitter's bay"). A fused push
    //    always comes from a bay; the mainRepo fallback is the no-bay library
    //    edge, kept as-is.
    const check = await resolveCheck(opts.check, mainRepo)
    const cwd = d.bayPath ?? mainRepo
    if (check !== undefined && check.trim() !== "") {
      const run = { step: "check" as const, pr: d.pr, target: d.branch }
      const refs = { ...(await collectStepRefs(mainRepo, run.target)), configHash: stepConfigHash("check", check) }
      if (await hasReusableSuccessfulStep(bay, run, refs)) {
        events.push(...skippedStepEvents(bay, run, effect.cause!, refs))
      } else {
        events.push(stepStarted(bay, run, effect.cause!))
        const checked = await runProjectCheck(check, cwd)
        const checkedOutput = await collectStepRefs(mainRepo, run.target, checked)
        const error = checked.ok ? undefined : stepError("check-failed", checked.detail, checkedOutput)
        events.push(
          stepFinished(
            bay,
            run,
            checked.ok,
            checked.ok ? undefined : checked.detail,
            effect.cause!,
            stepMetadata(checkedOutput, await writeStepArtifacts({ bayDir, cause: effect.cause!, run, output: checkedOutput }), error, {
              configHash: refs.configHash,
            }),
          ),
        )
        if (!checked.ok) {
          events.push(
            stateChangeEvent(bay, d.pr, "checking", "rejected", effect.cause!, { code: "check-failed", detail: checked.detail }),
          )
          return events
        }
      }
    }
    events.push(stateChangeEvent(bay, d.pr, "checking", "checked", effect.cause!))

    // 2. Merge onto the mainline — the SAME runner integrate/merge use (§4:
    //    zero-config native default; bay.mergeCommand remains the override,
    //    resolved identically for every path).
    events.push(stateChangeEvent(bay, d.pr, "checked", "merging", effect.cause!))
    const mergeRun = { step: "merge" as const, pr: d.pr, target: d.branch }
    events.push(stepStarted(bay, mergeRun, effect.cause!))
    const merged = await runMerge({ mainRepo, pr: d.pr, target: d.branch, configCwd: mainRepo, check: opts.check })
    const mergedOutput = await collectStepRefs(mainRepo, mergeRun.target, merged)
    const error = merged.ok ? undefined : stepError(merged.code, merged.detail, mergedOutput)
    events.push(
      stepFinished(
        bay,
        mergeRun,
        merged.ok,
        merged.detail,
        effect.cause!,
        stepMetadata(mergedOutput, await writeStepArtifacts({ bayDir, cause: effect.cause!, run: mergeRun, output: mergedOutput }), error),
      ),
    )
    if (!merged.ok) {
      events.push(stateChangeEvent(bay, d.pr, "merging", "rejected", effect.cause!, { code: merged.code, detail: merged.detail }))
      return events
    }
    events.push(stateChangeEvent(bay, d.pr, "merging", "merged", effect.cause!, { detail: merged.detail, sha: merged.sha }))

    // 3. Keep the bay-owned repo's mainline current so the next push's
    //    merge-base sees reality.
    const headRes = await git(["-C", mainRepo, "symbolic-ref", "--short", "HEAD"])
    const mainline = headRes.code === 0 ? headRes.stdout.trim() : "main"
    await git(["-C", repoGit, "fetch", "--quiet", mainRepo, `+refs/heads/${mainline}:refs/heads/${mainline}`])

    if (d.lease) {
      events.push(makeEvent(bay, "bay/closed", { bay: d.lease, via: "merged" }, effect.cause!))
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

/** Pre-receive verdict: doors-closed on merged PRs + gitlink pin rules.
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
    const pr = lease ? state.prs[lease.changeId] : undefined
    if (pr?.state === "merged") {
      throw new Error(
        `bay: doors closed — ${pr.id} for '${branch}' is already merged. ` +
          `Start the next piece of work in a fresh bay: git bay open <name>`,
      )
    }
    if (pr?.state === "closed") {
      throw new Error(
        `bay: doors closed — ${pr.id} for '${branch}' was withdrawn. ` +
          `Start the next piece of work in a fresh bay: git bay open <name>`,
      )
    }

    // Gitlink pin rules over the pushed range — best-effort at this hook:
    // a create/delete has no base range and thin pre-quarantine objects can
    // fail diff-tree; BOTH cases are covered authoritatively by the submit
    // continuation's checkSubmitPins (mainline merge-base → target), so a
    // skip here is a deferral, never an acceptance (LE-4/SG-2, 21002).
    if (ZERO_SHA.test(u.oldSha) || ZERO_SHA.test(u.newSha)) continue
    const diff = await git(["-C", ctx.repoGit, "diff-tree", "-r", u.oldSha, u.newSha])
    if (diff.code !== 0) continue
    const scan = await judgePinMoves(diff.stdout, ctx.mainRepo)
    messages.push(...scan.notes)
    if (scan.refusal) throw new Error(scan.refusal)
    messages.push(`bay: ref ${branch} accepted for intake`)
  }
  return messages
}

export type PinScanResult = { notes: string[]; refusal: string | null }

/**
 * THE gitlink pin-verdict scan (SG-3, /pro A5): judge every gitlink move in a
 * diff-tree output — a descendant move passes, a patch-id rewrite passes with
 * a note, a genuine rewind refuses. ONE provider for every door: the
 * pre-receive hook (best-effort over the pushed range) and the submit
 * continuation (authoritative, post-quarantine, against the mainline
 * merge-base) both judge with exactly this function.
 */
export async function judgePinMoves(diffText: string, mainRepo: string): Promise<PinScanResult> {
  const notes: string[] = []
  for (const line of diffText.split("\n")) {
    // :160000 160000 <old> <new> M\t<path> — diff-tree emits FULL shas (never --raw abbrev)
    const m = line.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) [A-Z]\t(.+)$/)
    if (!m) continue
    const [, oldMode, newMode, oldPin, newPin, path] = m
    if (newMode !== "160000") continue
    if (oldMode !== "160000") continue // gitlink ADD/typechange: allowed
    if (oldPin === newPin) continue
    const subRepo = join(mainRepo, path!)
    if (!existsSync(subRepo)) {
      notes.push(`bay: note — submodule '${path}' not present at ${mainRepo}; pin move accepted unverified`)
      continue
    }
    const anc = await git(["-C", subRepo, "merge-base", "--is-ancestor", oldPin!, newPin!])
    if (anc.code !== 0) {
      // Patch-id rewrite tolerance (/pro A5): a rebase/amend rewrite carries
      // the same patches under new SHAs — that is not a lineage jump. Allow
      // it (journaled via the accepted message); refuse genuine rewinds.
      const verdict = await patchIdRewriteVerdict(subRepo, oldPin!, newPin!)
      if (verdict.rewrite) {
        notes.push(
          `bay: note — gitlink '${path}' pin move is a history rewrite ` +
            `(${verdict.matched}/${verdict.oldCount} old patches present under new SHAs; base ${verdict.base.slice(0, 12)}) — allowed`,
        )
        continue
      }
      return {
        notes,
        refusal:
          `bay: pin refusal — gitlink '${path}' moves ${oldPin!.slice(0, 12)} → ${newPin!.slice(0, 12)}: ` +
          `not a descendant and not a recognizable rewrite (${verdict.reason}). ` +
          `Rebase the submodule forward or merge it; a genuine history replacement needs an explicit override (v0.3 evidence token).`,
      }
    }
  }
  return { notes, refusal: null }
}

/**
 * Authoritative post-quarantine pin check for a submit continuation: judge
 * every gitlink move from the mainline merge-base to the target. This is the
 * re-check the pre-receive hook defers to — it covers thin-pack diff-tree
 * failures AND new-branch pushes whose pushed range has no base (SG-2). An
 * unresolvable target or disjoint history returns clean here on purpose:
 * runMerge refuses those moments later with its own teaching code, so the
 * refusal is loud either way.
 */
export async function checkSubmitPins(mainRepo: string, target: string): Promise<PinScanResult> {
  const sha = await git(["-C", mainRepo, "rev-parse", "--verify", "--quiet", `${target}^{commit}`], mainRepo)
  if (sha.code !== 0) return { notes: [], refusal: null }
  const targetSha = sha.stdout.trim()
  const baseRef = await resolveBaseRef(mainRepo)
  const base = await git(["-C", mainRepo, "merge-base", baseRef, targetSha], mainRepo)
  if (base.code !== 0) return { notes: [], refusal: null }
  const diff = await git(["-C", mainRepo, "diff-tree", "-r", base.stdout.trim(), targetSha], mainRepo)
  if (diff.code !== 0) {
    throw new Error(
      `bay: diff-tree ${base.stdout.trim().slice(0, 12)}..${targetSha.slice(0, 12)} failed in ${mainRepo} ` +
        `during the pin re-check (exit ${diff.code}) — refusing to merge unjudged gitlink moves:\n${diff.stderr.trim()}`,
    )
  }
  return judgePinMoves(diff.stdout, mainRepo)
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
