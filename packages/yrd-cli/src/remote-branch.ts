import { join, resolve } from "node:path"
import { raiseFailure } from "@yrd/core"
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

/** What one consumer calls each unobservable phase, built only for the phase
 * that fired. */
export type UnobservedBranchNaming = Readonly<
  Record<"observer" | "absent" | "fetch" | "resolve", () => Readonly<{ code: string; message: string }>>
>

/**
 * The ONE reading of an unobservable branch. Consumers bring their own codes
 * and remedies; they do not bring their own opinion about what a phase MEANS.
 *
 * `absent` is a REFUSAL and everything else is a retryable CONFIGURATION fault,
 * and that split is the whole point of this function existing rather than a
 * fourth hand-copied ladder. Origin answering authoritatively that the branch is
 * gone is a settled fact about the change; every other failure is weather — the
 * observer was never installed, the fetch did not land, the ref did not
 * resolve — and treating weather as a settled fact is how a healthy submission
 * gets withdrawn (`refsfor-withdrawn-carrier`), while treating a settled fact as
 * weather is how a burn gets ordered from a head nobody checked (PR2599,
 * @i/10-yrd/absent-branch-is-terminal).
 *
 * Returns the observed head, or raises. It never returns a substitute: a caller
 * that cannot see the branch gets no sha to guess with, which is the property
 * the recorded-`source.head` fallback did not have.
 */
export function requireObservedBranchHead(observed: LiveBranchObservation, naming: UnobservedBranchNaming): string {
  if (observed.ok) return observed.head
  const named = naming[observed.phase]()
  raiseFailure(observed.phase === "absent" ? "refusal" : "configuration", named.code, named.message)
}

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

export type ReceiverStoreBranchObservation =
  | Readonly<{ ok: true; owned: true; head: string; target: string }>
  | Readonly<{ ok: true; owned: false }>
  | GitFailure

/** The receiver store's refs for one branch, longest-lived spelling first: a
 * branch delivered straight to the receiver IS `refs/heads/<branch>` there,
 * while a `refs/for/<base>/<change>` push mints its carrier as the accepted
 * `refs/yrd/submit/<branch>` approval (@yrd/bay receiver model). */
const RECEIVER_STORE_REF_PREFIXES = Object.freeze(["refs/heads/", "refs/yrd/submit/"])

/**
 * Ask the repository's own Yrd push receiver whether IT owns this branch,
 * before any question goes to origin. A receiver-delivered branch — the
 * `issue/…` carrier a `refs/for` push mints, or a branch pushed straight to
 * the bay remote — lives in `<git-common-dir>/yrd/prs.git` (the layout
 * `discoverYrdRepository`'s stateDir and the receiver default agree on) and is
 * never advertised by the GitHub origin at all. Asking origin about one
 * returns an authoritative-sounding "absent" that is true of the wrong remote:
 * that answer is what auto-withdrew PR2081 seconds after its own intake
 * (@i/10-merge-queue/refsfor-withdrawn-carrier).
 *
 * Absence of the store itself (exit 128: most repositories have no receiver)
 * and absence of both refs (exit 1) both mean "not receiver-owned" — origin
 * keeps its full authority there. Only a probe that TIMED OUT refuses to
 * answer, because falling through to origin then could let a transport fault
 * mature into a withdraw.
 */
export async function observeReceiverStoreBranch(
  process: Pick<Process, "run">,
  cwd: string,
  branch: string,
): Promise<ReceiverStoreBranchObservation> {
  const common = await runGit(process, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (common.timedOut === true || common.code !== 0) {
    return { ok: false, detail: gitFailure(common, GIT_PLUMBING_TIMEOUT_MS), timedOut: common.timedOut === true }
  }
  const store = join(resolve(cwd, common.stdout.trim()), "yrd", "prs.git")
  for (const prefix of RECEIVER_STORE_REF_PREFIXES) {
    const result = await runGit(process, cwd, [
      `--git-dir=${store}`,
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${prefix}${branch}^{commit}`,
    ])
    if (result.timedOut === true) {
      return { ok: false, detail: gitFailure(result, GIT_PLUMBING_TIMEOUT_MS), timedOut: true }
    }
    if (result.code === 0) {
      const head = result.stdout.trim().toLowerCase()
      if (head !== "") return { ok: true, owned: true, head, target: `${prefix}${branch}` }
    }
    // Exit 1 is `--verify --quiet`'s "no such ref in this store" — the next
    // spelling may still own it. Anything else says the store itself did not
    // answer as a repository (128: no receiver store exists here), which ends
    // the probe: origin is the only authority left.
    if (result.code !== 0 && result.code !== 1) break
  }
  return { ok: true, owned: false }
}

/** Fetch exactly one authored branch and resolve the remote-tracking commit.
 * Callers own the user-facing failure kind/code/remedy; this is the one Git
 * mechanism shared by submit and re-merge.
 *
 * The receiver store is consulted FIRST: a branch the repository's own push
 * receiver owns resolves there, never against origin — origin has no opinion
 * about a carrier it never hosted (see {@link observeReceiverStoreBranch}).
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
  const stored = await observeReceiverStoreBranch(process, cwd, branch)
  if (!stored.ok) {
    // The store never answered, so branch ownership is unknown; treating that
    // as origin's to judge could turn a local fault into a withdraw. Retryable.
    return { ok: false, phase: "fetch", detail: `receiver store did not answer: ${stored.detail}`, target }
  }
  if (stored.owned) {
    return { ok: true, head: stored.head, target: stored.target }
  }
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
      return {
        ok: false,
        phase: "absent",
        detail: `origin no longer advertises '${source}' and the receiver store does not own '${branch}' (${detail})`,
        target,
      }
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
