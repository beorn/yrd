import { adaptProcessGit, gitFailure, type Process } from "@yrd/process"
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
  | Readonly<{ ok: false; phase: "fetch" | "resolve" | "absent"; detail: string; target: string }>

export type LiveBranchObservation =
  | FreshRemoteBranch
  | Readonly<{ ok: false; phase: "observer"; detail: string; target: string }>

export type BranchCommitResolver = (ref: string) => string | undefined | Promise<string | undefined>

async function runGit(process: Pick<Process, "run">, cwd: string, args: readonly string[]) {
  const git = adaptProcessGit(process, { timeoutMs: GIT_PLUMBING_TIMEOUT_MS })
  let result = await git.run({ repo: cwd, args })
  for (const delayMs of PROBE_TIMEOUT_RETRY_DELAYS_MS) {
    if (result.timedOut !== true) return result
    await Bun.sleep(delayMs)
    result = await git.run({ repo: cwd, args })
  }
  return result
}

/** Distinguish a deliberately local-only repository from an origin-backed
 * repository whose branch observation must be refreshed. Git config's exit 1
 * means the key is absent; every other failure is evidence, never absence. */
export async function observeOriginRemote(
  process: Pick<Process, "run">,
  cwd: string,
): Promise<OriginRemoteObservation> {
  const result = await runGit(process, cwd, ["config", "--get", "remote.origin.url"])
  if (result.timedOut !== true && result.code === 0) return { ok: true, configured: true }
  if (result.timedOut !== true && result.code === 1) return { ok: true, configured: false }
  return { ok: false, detail: gitFailure(result, GIT_PLUMBING_TIMEOUT_MS), timedOut: result.timedOut === true }
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
  if (result.timedOut !== true && result.code === 0) return { ok: true, advertised: true }
  if (result.timedOut !== true && result.code === 2) return { ok: true, advertised: false }
  return { ok: false, detail: gitFailure(result, GIT_PLUMBING_TIMEOUT_MS), timedOut: result.timedOut === true }
}

/** Fetch exactly one authored branch and resolve the remote-tracking commit.
 * Callers own the user-facing failure kind/code/remedy; this is the one Git
 * mechanism shared by submit and re-merge.
 *
 * A failed fetch is two different worlds wearing one exit code (128): the branch
 * is GONE from origin — structural, and nothing about retrying changes it — or
 * origin was unreachable this once, which a retry does fix. Collapsing them is
 * what let a deleted branch head sit in the queue forever (PR1189), so the
 * failure path asks origin the authoritative question before answering. Only
 * the failure path pays for it; a healthy observation is one fetch as before. */
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
  if (fetched.timedOut === true || fetched.code !== 0) {
    const detail = gitFailure(fetched, GIT_PLUMBING_TIMEOUT_MS)
    const advertised = await observeOriginBranchAdvertisement(process, cwd, branch)
    // Absence is claimed only on an authoritative answer (ls-remote exit 2). If
    // the probe itself failed, origin never told us anything and the fetch
    // failure stands as retryable — never absence inferred from a second silence.
    if (advertised.ok && !advertised.advertised) {
      return { ok: false, phase: "absent", detail: `origin no longer advertises '${source}' (${detail})`, target }
    }
    return { ok: false, phase: "fetch", detail, target }
  }
  const resolved = await runGit(process, cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${target}^{commit}`,
  ])
  const head = resolved.stdout.trim().toLowerCase()
  if (resolved.timedOut === true || resolved.code !== 0 || head === "") {
    return { ok: false, phase: "resolve", detail: gitFailure(resolved, GIT_PLUMBING_TIMEOUT_MS), target }
  }
  return { ok: true, head, target }
}

/** Observe one branch through the caller's deterministic Git facts in tests,
 * or the exact refreshed-origin mechanism in production. This keeps branch
 * freshness as one capability: re-merge and read surfaces may attach different
 * remedies, but they cannot quietly disagree about which commit is live. */
export async function observeLiveBranch(
  process: Pick<Process, "run"> | undefined,
  cwd: string,
  branch: string,
  resolveCommit?: BranchCommitResolver,
): Promise<LiveBranchObservation> {
  const target = `refs/remotes/origin/${branch}`
  if (resolveCommit !== undefined) {
    const head = (await resolveCommit(`origin/${branch}`)) ?? (await resolveCommit(branch))
    return head === undefined
      ? {
          ok: false,
          phase: "resolve",
          detail: `neither 'origin/${branch}' nor '${branch}' resolves to a commit`,
          target,
        }
      : { ok: true, head: head.toLowerCase(), target }
  }
  if (process === undefined) {
    return { ok: false, phase: "observer", detail: "no Git process is installed", target }
  }
  return observeFreshRemoteBranch(process, cwd, branch)
}
