import type { Process, ProcessResult } from "@yrd/process"
import { cleanGitEnvironment } from "./git-environment.ts"
import { GIT_PLUMBING_TIMEOUT_MS } from "./git-timeouts.ts"

/** Two backoffs → three attempts. A 30s cap that is 1.8s in a clear window and
 * 45s+ under origin load fails closed on workers; retrying the probe is the
 * worker-side fix, independent of queue-side drain retry. Timeouts only. */
const PROBE_TIMEOUT_RETRY_DELAYS_MS = Object.freeze([200, 200])

type GitFailure = Readonly<{ ok: false; detail: string; timedOut: boolean }>

export type OriginRemoteObservation = Readonly<{ ok: true; configured: boolean }> | GitFailure
export type OriginBranchAdvertisement = Readonly<{ ok: true; advertised: boolean }> | GitFailure

export type FreshRemoteBranch =
  | Readonly<{ ok: true; head: string; target: string }>
  | Readonly<{ ok: false; phase: "fetch" | "resolve"; detail: string; target: string }>

async function runGit(process: Pick<Process, "run">, cwd: string, args: readonly string[]): Promise<ProcessResult> {
  const request = {
    argv: ["git", "-C", cwd, ...args],
    cwd,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_PLUMBING_TIMEOUT_MS,
  }
  let result = await process.run(request)
  for (const delayMs of PROBE_TIMEOUT_RETRY_DELAYS_MS) {
    if (!result.timedOut) return result
    await Bun.sleep(delayMs)
    result = await process.run(request)
  }
  return result
}

function gitFailure(result: ProcessResult): string {
  if (result.timedOut) return `timed out after ${GIT_PLUMBING_TIMEOUT_MS}ms`
  return result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
}

/** Distinguish a deliberately local-only repository from an origin-backed
 * repository whose branch observation must be refreshed. Git config's exit 1
 * means the key is absent; every other failure is evidence, never absence. */
export async function observeOriginRemote(
  process: Pick<Process, "run">,
  cwd: string,
): Promise<OriginRemoteObservation> {
  const result = await runGit(process, cwd, ["config", "--get", "remote.origin.url"])
  if (!result.timedOut && result.exitCode === 0) return { ok: true, configured: true }
  if (!result.timedOut && result.exitCode === 1) return { ok: true, configured: false }
  return { ok: false, detail: gitFailure(result), timedOut: result.timedOut }
}

/** Ask origin whether it owns a branch name before submit chooses between the
 * remote delivery and an unpublished local branch. Exit 2 is authoritative
 * absence; transport and timeout failures remain explicit evidence. */
export async function observeOriginBranchAdvertisement(
  process: Pick<Process, "run">,
  cwd: string,
  branch: string,
): Promise<OriginBranchAdvertisement> {
  const result = await runGit(process, cwd, ["ls-remote", "--heads", "--exit-code", "origin", `refs/heads/${branch}`])
  if (!result.timedOut && result.exitCode === 0) return { ok: true, advertised: true }
  if (!result.timedOut && result.exitCode === 2) return { ok: true, advertised: false }
  return { ok: false, detail: gitFailure(result), timedOut: result.timedOut }
}

/** Fetch exactly one authored branch and resolve the remote-tracking commit.
 * Callers own the user-facing failure kind/code/remedy; this is the one Git
 * mechanism shared by submit and recut. */
export async function observeFreshRemoteBranch(
  process: Pick<Process, "run">,
  cwd: string,
  branch: string,
): Promise<FreshRemoteBranch> {
  const source = `refs/heads/${branch}`
  const target = `refs/remotes/origin/${branch}`
  const fetched = await runGit(process, cwd, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-recurse-submodules",
    "origin",
    `+${source}:${target}`,
  ])
  if (fetched.timedOut || fetched.exitCode !== 0) {
    return { ok: false, phase: "fetch", detail: gitFailure(fetched), target }
  }
  const resolved = await runGit(process, cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${target}^{commit}`,
  ])
  const head = resolved.stdout.trim().toLowerCase()
  if (resolved.timedOut || resolved.exitCode !== 0 || head === "") {
    return { ok: false, phase: "resolve", detail: gitFailure(resolved), target }
  }
  return { ok: true, head, target }
}
