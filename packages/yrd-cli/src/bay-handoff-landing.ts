/**
 * Derived answers to the two questions the handoff-ready SLA alarm asserts but never asks:
 * did this branch's work LAND, and is the certification that named this head still true?
 *
 * Both are RE-DERIVED here rather than stored at certification time, deliberately. A
 * certification is a claim about a moving target — main moves, the claim does not — so
 * snapshotting the gitlinks at certification only relocates the staleness one level down and
 * buys a second expiry problem. The live merge base is also the only thing that separates
 * "this branch changed a pin" from "main moved on under a pin the branch never touched", and
 * that distinction does not exist yet at certification time.
 *
 * Nothing here reuses a stored base: `changeBaseSha` chases main while the author's head
 * stays put, which is exactly the misattribution `authoredSubmodulePinBase` was written to
 * replace.
 */
import { baseIdentity } from "@yrd/bay"
import { adaptProcessGit, type Process } from "@yrd/process"
import { resolveGitQueueTarget } from "@yrd/queue"
import { readCommitGitlinks } from "git-super/commit-graph"
import { isSubmitContentLanded } from "./host.ts"
import { authoredSubmodulePinBase, changedSubmodulePins } from "./pr-submodule-publication.ts"

const GIT_TIMEOUT_MS = 30_000

/** Whether the work on a handoff-ready head is already on the base branch, and how we know.
 * `ancestry` is the cheap wholesale case; `content` is the regenerated carrier, whose
 * authored sha is an ancestor of nothing even though its patch is on main. */
export type BranchLanding =
  | Readonly<{ state: "landed"; via: "ancestry" | "content" }>
  | Readonly<{ state: "unlanded"; uniqueCommits: number }>

/** A pin the branch changed that main has ALSO moved since the branch forked. */
export type AgedPin = Readonly<{ path: string; certified: string; main: string }>

/** Whether a certification still describes the world it was issued against. */
export type CertificationFreshness =
  | Readonly<{ state: "fresh" }>
  | Readonly<{ state: "stale"; pins: readonly AgedPin[] }>

type GitReadOptions = Readonly<{
  process: Pick<Process, "run">
  repo: string
  /** The certified head. */
  head: string
  /** The base branch the bay targets, in any of yrd's accepted ref spellings. */
  base: string
}>

async function resolveBaseSha(options: GitReadOptions): Promise<string> {
  const target = await resolveGitQueueTarget({
    inject: { process: options.process },
    repo: options.repo,
    branch: baseIdentity(options.base),
  })
  return target.sha
}

/**
 * Commits on `head` whose patch is not already on `baseSha`.
 *
 * `--cherry-pick --right-only` is the content question stated in git's own terms: it drops
 * every right-side commit that has an equivalent patch on the left, so an empty result means
 * the base already carries all of this branch's work under different shas.
 */
async function unlandedCommits(options: GitReadOptions, baseSha: string): Promise<readonly string[]> {
  const args = ["log", "--cherry-pick", "--right-only", "--format=%H", `${baseSha}...${options.head}`]
  const result = await adaptProcessGit(options.process, { timeoutMs: GIT_TIMEOUT_MS }).run({
    repo: options.repo,
    args,
  })
  if (result.timedOut === true) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  if (result.code !== 0) {
    // Loud, not "assume unlanded". Guessing here would either resurrect the false alarm
    // this function exists to kill, or silence a genuine one — and both look like success.
    throw new Error(
      `yrd: could not decide whether ${options.head.slice(0, 12)} has unlanded content against ` +
        `'${options.base}': ${result.stderr.trim() || `git log exited ${String(result.code)}`}`,
    )
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

/**
 * Did this head's work land?
 *
 * Ancestry first, because it is one exit code and settles the wholesale case. Content
 * second, because ancestry ALONE is not the fix: in the census behind
 * @i/10-yrd/bay-alarm-never-checks-landing, four of the seven landed branches were ancestors
 * of nothing — Yrd regenerates the carrier, so the authored sha never appears on main.
 */
export async function classifyBranchLanding(options: GitReadOptions): Promise<BranchLanding> {
  // The reusable ancestry answer, called rather than re-grown (bead: "do not grow a second
  // ancestry read"). It throws on any git exit code that is not a clean yes/no.
  if (await isSubmitContentLanded(options.process, options.repo, options.head, options.base)) {
    return { state: "landed", via: "ancestry" }
  }
  const baseSha = await resolveBaseSha(options)
  const unique = await unlandedCommits(options, baseSha)
  return unique.length === 0 ? { state: "landed", via: "content" } : { state: "unlanded", uniqueCommits: unique.length }
}

/**
 * Is the certification that named this head still true about submodule pins?
 *
 * Stale means BOTH halves are true at once: the branch changed a pin, and main has moved
 * that same pin since the branch forked. Either half alone is not a hazard, and treating it
 * as one is the documented failure mode:
 *
 *   - main moved a pin the branch never touched — the three-way merge takes main's newer
 *     value and reverts nothing. Calling this stale is the tip-versus-main error that
 *     rendered "already landed" and "about to revert four submodules" identically.
 *   - the branch changed a pin main has not touched — the branch is the only writer, so
 *     nothing aged and the certification still says what it said.
 *
 * The direction of a genuinely contested pin (behind vs diverged) is deliberately NOT
 * decided here: `requireQueueableSubmodulePins` already rules on that at admission, and a
 * second verdict would be a second implementation of the same judgement. This answers only
 * whether the alarm may still recommend the head it certified.
 */
export async function certificationFreshness(options: GitReadOptions): Promise<CertificationFreshness> {
  const baseSha = await authoredSubmodulePinBase({
    process: options.process,
    repo: options.repo,
    base: options.base,
    headSha: options.head,
  })
  if (baseSha === undefined) {
    throw new Error(
      `yrd: base '${options.base}' resolves to no ref in '${options.repo}', so the certification for ` +
        `${options.head.slice(0, 12)} cannot be checked for staleness; fetch the base branch, then retry`,
    )
  }
  const changed = await changedSubmodulePins({
    process: options.process,
    repo: options.repo,
    baseSha,
    headSha: options.head,
  })
  if (changed.length === 0) return { state: "fresh" }

  const git = adaptProcessGit(options.process, { timeoutMs: GIT_TIMEOUT_MS })
  const mainSha = await resolveBaseSha(options)
  const atBase = new Map((await readCommitGitlinks(git, options.repo, baseSha)).map((row) => [row.path, row.target]))
  const atMain = new Map((await readCommitGitlinks(git, options.repo, mainSha)).map((row) => [row.path, row.target]))

  const aged = changed
    .filter((pin) => {
      const base = atBase.get(pin.path)
      const main = atMain.get(pin.path)
      // An added gitlink has no base value to age against, and admission refuses it
      // outright — not this function's verdict to duplicate.
      return base !== undefined && main !== undefined && base !== main
    })
    .map((pin) => ({ path: pin.path, certified: pin.pin, main: atMain.get(pin.path) as string }))

  return aged.length === 0 ? { state: "fresh" } : { state: "stale", pins: Object.freeze(aged) }
}

/** A derivation that could not be completed for ONE bay, carrying why. */
export type UndecidedFact = Readonly<{ state: "unknown"; detail: string }>

export type HandoffReadyLandingProjection = Readonly<{
  landing: BranchLanding | UndecidedFact
  certification: CertificationFreshness | UndecidedFact
}>

async function decide<T>(derive: () => Promise<T>): Promise<T | UndecidedFact> {
  try {
    return await derive()
  } catch (cause) {
    // Attributable to ONE bay, so it degrades per bay instead of failing the whole
    // listing. It must still be VISIBLE: an absent landing fact reads as "not landed"
    // and re-arms the false alarm this projection exists to disarm, so the unknown is
    // carried in the output rather than dropped.
    return { state: "unknown", detail: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Both derived facts for one handoff-ready head, each degrading independently.
 *
 * The two are separable on purpose: a branch can be provably landed while its submodule
 * freshness is unreadable, and either fact alone is enough to stop the alarm from saying
 * "submit this exact branch revision".
 */
export async function projectHandoffReadyLanding(options: GitReadOptions): Promise<HandoffReadyLandingProjection> {
  const landing = await decide(() => classifyBranchLanding(options))
  const certification = await decide(() => certificationFreshness(options))
  return { landing, certification }
}
