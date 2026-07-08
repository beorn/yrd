import type { RejectionCode } from "../types.ts"
import { createGitConfigSource, resolveOption } from "../config.ts"
import { git, porcelainStatus, repoScopedCleanEnv, resolveBaseRef } from "./git.ts"

/**
 * pipeline.ts — the check + merge runners shared by every path that can
 * check or merge a PR (docs/model.md § Verbs): the standalone `check` and
 * `merge` verbs, the `integrate` umbrella (all three in merge-worker.ts), and
 * a fused push's continuation (receive.ts). ONE implementation per step, so
 * every path checks — and merges — identically; this is what "push and
 * integrate merge identically" (§4) means in code, not just in prose.
 *
 * Pure I/O helpers, not a with*() layer: no state, no events, no commands.
 * Callers (the reducers/effect handlers in merge-worker.ts and receive.ts)
 * turn these outcomes into `pr/changed` events via `stateChangeEvent`.
 */

export function tail(text: string, max = 2000): string {
  const trimmed = text.replace(/\s+$/, "")
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}

// ---------- check ----------

export type CheckOutcome = { ok: true } | { ok: false; detail: string }

/** Resolve the ONE project check command: inline > BAY_CHECK > git config
 *  bay.check > none (unset — checks are opt-in). */
export async function resolveCheck(check: string | undefined, configCwd: string): Promise<string | undefined> {
  const source = createGitConfigSource(configCwd)
  return await resolveOption(check, "check", source)
}

/** Run the resolved check command in `cwd` — the PR's own bay when it still
 *  has one, else the mainline repo. No command configured is a pass-through
 *  (spec § Check provider: checks are opt-in, not a hard requirement). */
export async function runProjectCheck(check: string | undefined, cwd: string): Promise<CheckOutcome> {
  if (check === undefined || check.trim() === "") return { ok: true }
  const proc = Bun.spawn(["sh", "-c", check], { cwd, stdout: "pipe", stderr: "pipe", env: repoScopedCleanEnv() })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) return { ok: false, detail: `check '${check}' failed (exit ${code}): ${tail(err || out)}` }
  return { ok: true }
}

// ---------- merge ----------

export type MergeOutcome =
  /** `sha` is the verified landed tip (the target commit the lying-merge guard
   *  proved an ancestor of the mainline) — machine-truth for downstream
   *  consumers ({sha} in issue-tracker commands). Absent only on the
   *  no-mainRepo library path, which runs no guard and resolves no target. */
  | { ok: true; detail: string; sha?: string }
  | { ok: false; code: RejectionCode; detail: string }

export type MergeParams = {
  /** The mainline repo the PR lands onto; also the merge command's spawn cwd
   *  and the ancestry-verify's target. Omitted only by library callers that
   *  trust a configured mergeCommand's exit code outright (no lying-merge
   *  guard, no native-merge fallback — there is no repo to merge natively
   *  into). The CLI host always sets it. */
  mainRepo?: string
  pr: string
  /** A branch name or SHA — resolved to a commit here (never trusted as
   *  already-current), so the merge always lands the commit that existed the
   *  moment integration ran, not whatever the branch drifts to meanwhile. */
  target: string
  /** Inline override for bay.mergeCommand; undefined defers to BAY_MERGE_COMMAND
   *  then git config bay.mergeCommand, then (§4) the native default. */
  mergeCommand?: string
  /** cwd for resolving bay.mergeCommand/bay.check from git config — defaults
   *  to mainRepo, then process.cwd(). */
  configCwd?: string
}

/** Resolve the configured merge command: inline > BAY_MERGE_COMMAND > git
 *  config bay.mergeCommand > undefined. Undefined now means "use the native
 *  default" (§4: bay.mergeCommand is an override, never a requirement) —
 *  this no longer throws on a missing command. */
export async function resolveMergeCommand(mergeCommand: string | undefined, configCwd: string): Promise<string | undefined> {
  const source = createGitConfigSource(configCwd)
  return await resolveOption(mergeCommand, "mergeCommand", source)
}

/**
 * Land `target` onto `mainRepo`'s current branch and return the verdict —
 * never throws for a domain outcome (a failed check/merge/guard is data, not
 * a crash; only a broken host — no `sh`, no git, an unreadable mainRepo —
 * throws). Zero-config native merge (§4): when bay.mergeCommand is unset,
 * this runs `git merge --no-ff` directly — the exact merge a plain `git push`
 * has always done, now shared by `merge`/`integrate` too. Either way, the
 * lying-merge guard (ancestry proof) runs after: a merge command's exit 0 is
 * a CLAIM, not a landing, on every path (spec: "regardless of path").
 */
export async function runMerge(params: MergeParams): Promise<MergeOutcome> {
  const { pr, target, mainRepo } = params
  const configCwd = params.configCwd ?? mainRepo ?? process.cwd()

  let targetSha: string | undefined
  if (mainRepo) {
    const resolved = await git(["-C", mainRepo, "rev-parse", "--verify", "--quiet", `${target}^{commit}`], mainRepo)
    if (resolved.code !== 0) {
      return {
        ok: false,
        code: "unresolvable-target",
        detail:
          `target '${target}' does not resolve in ${mainRepo} — cannot verify a landing, refusing to run the merge. ` +
          `Fix the target (branch deleted? typo?) and retry: git bay retry ${pr}`,
      }
    }
    targetSha = resolved.stdout.trim()
  }

  const mergeCommand = await resolveMergeCommand(params.mergeCommand, configCwd)
  let mergeDetail: string

  if (mergeCommand === undefined || mergeCommand.trim() === "") {
    if (!mainRepo) {
      throw new Error(
        "bay: no merge command configured and no mainRepo to run a native merge in — set inline " +
          "(mergeCommand), via BAY_MERGE_COMMAND, `git config bay.mergeCommand`, or pass mainRepo for the native default.",
      )
    }
    const dirty = (await porcelainStatus(mainRepo))
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("??"))
      .join("\n")
    if (dirty !== "") {
      return {
        ok: false,
        code: "dirty-mainline",
        detail: `mainline working tree at ${mainRepo} is dirty — commit or clean it, then git bay retry ${pr}`,
      }
    }
    const headRes = await git(["-C", mainRepo, "symbolic-ref", "--short", "HEAD"], mainRepo)
    const mainline = headRes.code === 0 ? headRes.stdout.trim() : "main"
    const merge = await git(
      ["-C", mainRepo, "merge", "--no-ff", "-m", `bay: merge ${pr} (${target})`, targetSha!],
      mainRepo,
    )
    if (merge.code !== 0) {
      await git(["-C", mainRepo, "merge", "--abort"], mainRepo) // best-effort restore; a failed abort surfaces below
      return {
        ok: false,
        code: "merge-conflict",
        detail: `merge of ${target} onto ${mainline} failed (exit ${merge.code}): ${tail(merge.stderr || merge.stdout)}`,
      }
    }
    const mergeSha = (await git(["-C", mainRepo, "rev-parse", "HEAD"], mainRepo)).stdout.trim()
    mergeDetail = `merged ${mergeSha} onto ${mainline}`
  } else {
    const cmd = mergeCommand.replaceAll("{target}", target).replaceAll("{pr}", pr).replaceAll("{changeset}", pr)
    // repoScopedCleanEnv: this path now also runs from INSIDE the post-receive
    // hook (a fused push, unified with `merge`/`integrate` per §4) — the hook
    // process exports GIT_DIR=. (and friends), which would silently repoint
    // the spawned command's own git invocations at the wrong repo otherwise.
    const proc = Bun.spawn(["sh", "-c", cmd], { cwd: mainRepo, stdout: "pipe", stderr: "pipe", env: repoScopedCleanEnv() })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) {
      const errTail = tail(stderr)
      return {
        ok: false,
        code: "merge-command-failed",
        detail: errTail === "" ? `exit ${code}` : `exit ${code}: ${errTail}`,
      }
    }
    mergeDetail = tail(stdout)
  }

  // Lying-merge guard (G1.1/G1.2), every path: exit 0 is a CLAIM, not a
  // landing. Verify the pinned target is now an ancestor of the refreshed
  // mainline; otherwise reject — a false `merged` is the exact class this
  // guard makes structurally impossible.
  if (mainRepo && targetSha) {
    const baseRef = await resolveBaseRef(mainRepo)
    if (baseRef === "origin/main") {
      // LE-2 (the 20969 false-reject root cause): when the merge command lands
      // from a SEPARATE clean clone (the hh integrator shape), this repo's
      // tracking ref is stale — a REAL landing then reads as not-an-ancestor
      // and journals `rejected`. Refresh the mainline before judging. A fetch
      // failure is a broken host (no remote/network), not a domain verdict —
      // fail loud per this function's contract, never judge against a ref we
      // could not refresh.
      const fetched = await git(["-C", mainRepo, "fetch", "origin", "main"], mainRepo)
      if (fetched.code !== 0) {
        throw new Error(
          `bay: 'git fetch origin main' failed at ${mainRepo} (exit ${fetched.code}) — the lying-merge guard ` +
            `refuses to verify a landing against a possibly-stale origin/main:\n${tail(fetched.stderr)}`,
        )
      }
    }
    const anc = await git(["-C", mainRepo, "merge-base", "--is-ancestor", targetSha, baseRef], mainRepo)
    if (anc.code !== 0) {
      return {
        ok: false,
        code: "lying-merge",
        detail:
          `merge command exited 0 but ${target}@${targetSha.slice(0, 8)} is not an ancestor of ${baseRef} — ` +
          `refusing to record merged (lying-merge guard). If the landing is real but unpushed, push it and ` +
          `retry: git bay retry ${pr}. If the command lands by rebase/squash, use a merge-based ` +
          `landing — ancestry is the proof this guard accepts.`,
      }
    }
  }

  return { ok: true, detail: mergeDetail, ...(targetSha !== undefined ? { sha: targetSha } : {}) }
}
