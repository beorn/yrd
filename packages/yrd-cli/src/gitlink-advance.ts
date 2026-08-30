import { basename, resolve } from "node:path"
import { changeIdForDerivedSubmit, type ChangeId } from "@yrd/bay"
import { raiseFailure } from "@yrd/core"
import { adaptProcessGit, type Process } from "@yrd/process"
import { resolveSubmoduleMain, SUBMODULE_MAIN_REF } from "@yrd/queue"
import { readCommitGitlinks } from "git-super/commit-graph"
import {
  gitlinkDirections,
  resolveBaseTip,
  backwardGitlinkRefusal,
  type BackwardGitlink,
} from "./gitlink-forward-only.ts"
import { GIT_TIMEOUT_MS, processGit } from "./pr-submodule-publication.ts"

/**
 * Advancing a submodule's gitlink, composed once instead of by hand every time.
 *
 * Every yrd change reaches hh's main as a gitlink advance, and on 2026-08-29/30 all
 * thirteen of them were hand-authored: a seat wrote its own subject, cut its own branch,
 * staged the gitlink, and drove `pr submit` — no two of the thirteen shared a template.
 * The pieces were all already here and proven; nothing composed them.
 *
 * This module is that composition, and it is deliberately split in two:
 *
 * - `planGitlinkAdvance` does every READ and raises every refusal, touching nothing. It
 *   is the whole decision, so `--dry-run` shows exactly what a real run would do and the
 *   refusals are reachable in a test without a queue.
 * - the verb then executes a settled plan.
 *
 * Refusals come BEFORE anything is created, which is the point of the split: a refusal
 * that has already cut a branch leaves litter behind for someone else to find.
 */

const SUBMODULE_ORIGIN = "origin"

/** The submodule's own main as this checkout tracks it — derived from the one ref constant. */
const SUBMODULE_MAIN_TRACKING_REF = SUBMODULE_MAIN_REF.replace("refs/heads/", `refs/remotes/${SUBMODULE_ORIGIN}/`)

/** Where the target sits relative to the submodule's own main, and what that costs. */
export type MinCommitPublication =
  /** Already merged on the submodule's main; nothing to push. */
  | Readonly<{ state: "on-main" }>
  /** A strict descendant of the submodule's main: publishing it is a fast-forward push. */
  | Readonly<{ state: "fast-forward"; mainSha: string; ahead: number }>

export type GitlinkAdvancePlan = Readonly<{
  /** The submodule path the superproject records, e.g. `vendor/yrd`. */
  path: string
  /** The conventional-commit scope — the submodule's name, e.g. `yrd`. */
  name: string
  /** Absolute path to the submodule's own repository. */
  repository: string
  /** Main's current gitlink for this path. */
  from: string
  /** The value this advance writes. */
  to: string
  /** Whether the submodule's own main already carries the target, or must be moved to it. */
  publication: MinCommitPublication
  /** First-parent subjects between the two values — the commit body. */
  subjects: readonly string[]
  /** The identity the generated commit carries as its `Change-Id` trailer. */
  changeId: ChangeId
  /** The generated commit message, subject through trailer. */
  message: string
}>

/**
 * The generated commit message: subject, the submodule's own first-parent subjects as the
 * body, and the `Change-Id` trailer.
 *
 * Pure, so the message a reader sees in `git log` is testable without a repository and
 * cannot drift from the plan that produced it. The subject names both ends in short form
 * because that is what thirteen hand-authored specimens all reached for, in thirteen
 * different phrasings.
 */
export function gitlinkAdvanceMessage(
  input: Readonly<{
    name: string
    path: string
    from: string
    to: string
    subjects: readonly string[]
    changeId: string
  }>,
): string {
  const body =
    input.subjects.length === 0
      ? [`No first-parent commits between ${input.from} and ${input.to}.`]
      : input.subjects.map((subject) => `- ${subject}`)
  return [
    `chore(${input.name}): advance gitlink ${input.from.slice(0, 7)}..${input.to.slice(0, 7)}`,
    "",
    `Advances ${input.path} by ${input.subjects.length} commit${input.subjects.length === 1 ? "" : "s"}:`,
    "",
    ...body,
    "",
    `Change-Id: ${input.changeId}`,
    "",
  ].join("\n")
}

/** The bay (and branch) name one advance works in — stable for a given target. */
export function gitlinkAdvanceName(name: string, to: string): string {
  return `advance-${name}-${to.slice(0, 7)}`
}

type SubmoduleEntry = Readonly<{ name: string; path: string }>

/**
 * Match the operand against the superproject's recorded submodules by path or by name, so
 * both `yrd` and `vendor/yrd` resolve. An unmatched operand names every candidate rather
 * than saying "not found" — the operand is usually a near-miss, and the list is the cure.
 */
export function resolveSubmoduleOperand(operand: string, entries: readonly SubmoduleEntry[]): SubmoduleEntry {
  const normalized = operand.replace(/\/+$/u, "")
  const matched = entries.filter(
    (entry) => entry.path === normalized || entry.name === normalized || basename(entry.path) === normalized,
  )
  if (matched.length === 1 && matched[0] !== undefined) return matched[0]
  if (matched.length > 1) {
    raiseFailure(
      "usage",
      "ambiguous-submodule",
      `yrd: '${operand}' matches more than one submodule (${matched.map((entry) => entry.path).join(", ")}); ` +
        "name the full path",
    )
  }
  raiseFailure(
    "usage",
    "unknown-submodule",
    `yrd: this repository records no submodule '${operand}'; it records ` +
      `${entries.length === 0 ? "none" : entries.map((entry) => entry.path).join(", ")}`,
  )
}

/**
 * Settle the whole advance without touching anything: resolve the target, prove it is a
 * legitimate min commit, prove it moves the gitlink forward, and generate the message.
 *
 * `target` is a sha or branch in the submodule, or `main` (the default) for the
 * submodule's own main tip.
 */
export async function planGitlinkAdvance(options: {
  process: Pick<Process, "run">
  /** Superproject root. */
  repo: string
  /** The superproject's base branch — the main this advance will merge into. */
  base: string
  submodule: SubmoduleEntry
  target: string
}): Promise<GitlinkAdvancePlan> {
  const repo = resolve(options.repo)
  const repository = resolve(repo, options.submodule.path)
  const git = processGit(options.process)

  const main = await resolveSubmoduleMain(git, repository, SUBMODULE_ORIGIN)
  if (main.status === "unavailable") {
    raiseFailure(
      "refusal",
      "component-main-inspection-failed",
      `yrd: submodule '${options.submodule.path}' main could not be inspected: ${main.message}; ` +
        `fetch it (git -C ${options.submodule.path} fetch origin), then retry`,
    )
  }

  const to =
    options.target === "main" ? main.sha : await resolveCommit(git, repository, options.target, options.submodule.path)

  // Legitimacy — the min commit rule, submodule-main-first. Already on main costs nothing;
  // a strict descendant is a fast-forward this verb may publish, because submodules are
  // `landing: none` and their owner pushes directly. Anything else is a commit the
  // submodule's own workflow has not accepted, and no gitlink may name it.
  const publication = await minCommitPublication(git, repository, main.sha, to, options.submodule.path)

  const baseTipSha = await resolveBaseTip({ process: options.process, repo, base: options.base })
  if (baseTipSha === undefined) {
    raiseFailure(
      "refusal",
      "pr-base-unresolved",
      `yrd: base '${options.base}' resolves to no ref in '${repo}'; fetch the base branch, then retry`,
    )
  }
  const onMain = new Map(
    (await readCommitGitlinks(adaptProcessGit(options.process, { timeoutMs: GIT_TIMEOUT_MS }), repo, baseTipSha)).map(
      (entry) => [entry.path, entry.target],
    ),
  )
  const from = onMain.get(options.submodule.path)
  if (from === undefined) {
    raiseFailure(
      "refusal",
      "gitlink-absent-on-main",
      `yrd: '${options.base}' records no gitlink at '${options.submodule.path}', so there is nothing to advance; ` +
        "adding a submodule is a separate, @cto-ruled change",
    )
  }

  // Monotonicity, the second independent question — same reader the admission gate uses,
  // asked here so the refusal lands before a branch exists rather than after a submit.
  const [direction] = await gitlinkDirections({
    process: options.process,
    repo,
    baseTipSha,
    gitlinks: [{ path: options.submodule.path, gitlink: to, repository }],
  })
  if (direction === undefined) {
    throw new Error(`yrd: gitlink comparison for '${options.submodule.path}' returned nothing`)
  }
  if (direction.state === "undetermined") {
    raiseFailure(
      "refusal",
      "gitlink-comparison-undetermined",
      `yrd: submodule '${options.submodule.path}' gitlink could not be compared with main's current value: ` +
        direction.reason,
    )
  }
  if (direction.state === "unchanged") {
    raiseFailure(
      "refusal",
      "gitlink-already-current",
      `yrd: '${options.base}' already records '${options.submodule.path}' at '${to}'; nothing to advance`,
    )
  }
  if (direction.state === "backward") {
    raiseFailure(
      "refusal",
      "gitlink-moves-backward",
      `yrd: this advance would move a submodule gitlink backwards:\n${backwardGitlinkRefusal([direction as BackwardGitlink])}`,
    )
  }

  const subjects = await firstParentSubjects(git, repository, from, to)
  const changeId = changeIdForDerivedSubmit({
    // Deterministic, from the advance's own facts, so re-running the same advance is the
    // same logical change rather than a second one. Deliberately the EXISTING mint —
    // "compose, never re-mint" (plan of record, 2026-08-23 principles): nothing here
    // becomes a third minter of change identity.
    branch: `refs/heads/${gitlinkAdvanceName(options.submodule.name, to)}`,
    sha: to,
  })

  return {
    path: options.submodule.path,
    name: options.submodule.name,
    repository,
    from,
    to,
    publication,
    subjects,
    changeId,
    message: gitlinkAdvanceMessage({
      name: options.submodule.name,
      path: options.submodule.path,
      from,
      to,
      subjects,
      changeId,
    }),
  }
}

async function resolveCommit(
  git: ReturnType<typeof processGit>,
  repository: string,
  target: string,
  path: string,
): Promise<string> {
  const resolved = await git.run(repository, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`], true)
  const sha = resolved.stdout.trim()
  if (resolved.code !== 0 || sha === "") {
    raiseFailure(
      "usage",
      "gitlink-target-unresolved",
      `yrd: '${target}' resolves to no commit in submodule '${path}'; ` +
        `fetch it (git -C ${path} fetch origin), then name a sha, a branch, or 'main'`,
    )
  }
  return sha
}

/**
 * Legitimacy for one target: on the submodule's main already, a fast-forward away from it,
 * or neither.
 *
 * "Neither" is the `min-commit-unpublished` refusal, and it is the one the ADR's split
 * cares about: a commit the submodule's own workflow never accepted cannot become a min
 * commit, however real and pushed it is.
 */
async function minCommitPublication(
  git: ReturnType<typeof processGit>,
  repository: string,
  mainSha: string,
  to: string,
  path: string,
): Promise<MinCommitPublication> {
  const onMain = await git.run(repository, ["merge-base", "--is-ancestor", to, mainSha], true)
  if (onMain.code === 0) return { state: "on-main" }
  if (onMain.code !== 1) {
    raiseFailure(
      "refusal",
      "component-main-inspection-failed",
      `yrd: could not compare '${to}' with submodule '${path}' main '${mainSha}': ` +
        `${onMain.stderr.trim() || onMain.stdout.trim() || "git merge-base failed"}`,
    )
  }
  const descends = await git.run(repository, ["merge-base", "--is-ancestor", mainSha, to], true)
  if (descends.code === 0) {
    const counted = await git.run(repository, ["rev-list", "--count", `${mainSha}..${to}`], true)
    const ahead = Number(counted.stdout.trim())
    return { state: "fast-forward", mainSha, ahead: Number.isSafeInteger(ahead) ? ahead : 0 }
  }
  raiseFailure(
    "refusal",
    "min-commit-unpublished",
    `yrd: '${to}' is not on submodule '${path}' main ('${mainSha}') and does not descend from it, so it cannot ` +
      "become a min commit; merge it on that submodule's own main first, then advance the gitlink to it " +
      `(inspect: git -C ${path} log --oneline ${mainSha}..${to})`,
  )
}

/** The submodule's own first-parent subjects across the advance — the generated body. */
async function firstParentSubjects(
  git: ReturnType<typeof processGit>,
  repository: string,
  from: string,
  to: string,
): Promise<readonly string[]> {
  const log = await git.run(repository, ["log", "--first-parent", "--format=%s", `${from}..${to}`], true)
  if (log.code !== 0) {
    raiseFailure(
      "refusal",
      "gitlink-subjects-unreadable",
      `yrd: could not read the commits between '${from}' and '${to}': ` + `${log.stderr.trim() || "git log failed"}`,
    )
  }
  return Object.freeze(
    log.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  )
}

/**
 * Publish the target on the submodule's own main when the plan says it must move.
 *
 * A fast-forward push and nothing else: no lease override, no force. Submodules are
 * `landing: none`, so this is their owner's ordinary delivery — but it is still a write to
 * a shared ref, so it happens only when the operand ASKED for a commit main does not
 * already carry, and it is reported.
 */
export async function publishMinCommit(
  process: Pick<Process, "run">,
  plan: GitlinkAdvancePlan,
): Promise<string | undefined> {
  if (plan.publication.state === "on-main") return undefined
  const git = processGit(process)
  const pushed = await git.run(
    plan.repository,
    ["push", "--quiet", SUBMODULE_ORIGIN, `${plan.to}:refs/heads/main`],
    true,
  )
  if (pushed.code !== 0) {
    raiseFailure(
      "refusal",
      "min-commit-publish-failed",
      `yrd: could not fast-forward submodule '${plan.path}' main to '${plan.to}': ` +
        `${pushed.stderr.trim() || pushed.stdout.trim() || "git push failed"}`,
    )
  }
  return `fast-forwarded ${plan.path} main ${plan.publication.mainSha.slice(0, 7)}..${plan.to.slice(0, 7)} (${plan.publication.ahead} commit${plan.publication.ahead === 1 ? "" : "s"})`
}

/**
 * Bring the bay's own submodule to the target before the gitlink is staged.
 *
 * The index write below can name a commit the bay has never heard of — `update-index
 * --cacheinfo` asks no questions — and that used to be sold as a feature: a fresh bay needed
 * no submodule sync. It is the opposite. A repository's own `pre-commit` hook reads the
 * staged gitlink and asks the bay's submodule whether the move is a fast-forward, and a
 * store that does not hold the target cannot answer. Measured 2026-08-30 on the verb's first
 * real use: `git merge-base --is-ancestor` replied "Not a valid commit name", the hook read
 * that as work being dropped, and refused a move that was in fact a clean fast-forward.
 *
 * The bay is also left honest by this. Staging a gitlink whose submodule stays parked on the
 * old commit leaves the work tree permanently disagreeing with the commit it just made —
 * `M <path>` in every `git status`, and the submit path warning about uncommitted work it
 * cannot include.
 *
 * The fetch is `resolveSubmoduleMain` rather than a fetch of the bare sha: the plan has
 * already proved the target is on the submodule's main (or `publishMinCommit` has just moved
 * main to it), so fetching main is guaranteed to carry the object, and asks nothing of the
 * server that a plain clone does not.
 */
export async function materializeGitlinkTarget(
  process: Pick<Process, "run">,
  worktree: string,
  plan: GitlinkAdvancePlan,
): Promise<void> {
  const git = processGit(process)
  const repository = resolve(worktree, plan.path)
  const main = await resolveSubmoduleMain(git, repository, SUBMODULE_ORIGIN)
  if (main.status === "unavailable") {
    raiseFailure(
      "refusal",
      "gitlink-target-unmaterialized",
      `yrd: could not fetch submodule '${plan.path}' into '${repository}', so the advance cannot bring it to ` +
        `'${plan.to}': ${main.message}`,
    )
  }
  const checkedOut = await git.run(repository, ["checkout", "--quiet", "--detach", plan.to], true)
  if (checkedOut.code !== 0) {
    raiseFailure(
      "refusal",
      "gitlink-target-unmaterialized",
      `yrd: fetched submodule '${plan.path}' into '${repository}' but could not check out '${plan.to}' there, so a ` +
        `pre-commit hook cannot prove the gitlink moves forward: ` +
        `${checkedOut.stderr.trim() || checkedOut.stdout.trim() || "git checkout failed"}`,
    )
  }
  // The tracking ref last, and it is not bookkeeping. `resolveSubmoduleMain` fetches into a
  // probe ref, so a bay left here would carry a submodule sitting on a commit its own
  // `origin/main` does not appear to contain — and readers ask exactly that question. The
  // guard this verb exists to satisfy asks it (`merge-base --is-ancestor <sha>
  // refs/remotes/origin/main`), and so does git itself: under `submodule.recurse`, pushing
  // the advance branch treats an apparently-unpublished submodule commit as one it must push
  // for you, from a detached HEAD, and fails with "HEAD does not match the named branch in
  // the superproject". Main carries the target by now — the plan proved it or
  // `publishMinCommit` just moved main to it — so this records what is already true.
  const tracked = await git.run(repository, ["update-ref", SUBMODULE_MAIN_TRACKING_REF, main.sha], true)
  if (tracked.code !== 0) {
    raiseFailure(
      "refusal",
      "gitlink-target-unmaterialized",
      `yrd: could not record submodule '${plan.path}' main '${main.sha}' as ${SUBMODULE_MAIN_TRACKING_REF} in ` +
        `'${repository}': ${tracked.stderr.trim() || tracked.stdout.trim() || "git update-ref failed"}`,
    )
  }
}

/**
 * Stage the gitlink and write the generated commit in a prepared work tree.
 *
 * `materializeGitlinkTarget` must have run first: the index entry written here names a
 * commit the repository's own `pre-commit` hook will interrogate the bay's submodule about.
 */
export async function writeGitlinkAdvanceCommit(
  process: Pick<Process, "run">,
  worktree: string,
  plan: GitlinkAdvancePlan,
  bay: string,
): Promise<string> {
  const git = processGit(process)
  const staged = await git.run(worktree, ["update-index", "--cacheinfo", `160000,${plan.to},${plan.path}`], true)
  if (staged.code !== 0) {
    raiseFailure(
      "refusal",
      "gitlink-stage-failed",
      `yrd: could not stage gitlink '${plan.path}' at '${plan.to}' in bay '${bay}' ('${worktree}'): ` +
        `${staged.stderr.trim() || "git update-index failed"}`,
    )
  }
  // No `--no-verify`: yrd's own managed hook is `pre-submit`, so nothing of ours runs here,
  // and a repository that installs its own `commit-msg` hook is entitled to see this commit.
  const committed = await git.run(worktree, ["commit", "--quiet", "-m", plan.message], true)
  if (committed.code !== 0) {
    // BOTH streams, always. A refusing hook writes its diagnosis to whichever it likes, and
    // the cure — the one line the reader actually needs — is usually the last of it. Picking
    // one stream and falling back to the other drops the half that was not chosen.
    raiseFailure(
      "refusal",
      "gitlink-commit-failed",
      refusedCommitMessage(plan, bay, worktree, commandOutput(committed)),
    )
  }
  const head = await git.run(worktree, ["rev-parse", "HEAD"], true)
  if (head.code !== 0) {
    raiseFailure(
      "refusal",
      "gitlink-commit-failed",
      refusedCommitMessage(plan, bay, worktree, commandOutput(head) || "git rev-parse HEAD failed"),
    )
  }
  return head.stdout.trim()
}

function commandOutput(result: Readonly<{ stdout: string; stderr: string }>): string {
  return [result.stderr.trim(), result.stdout.trim()].filter((stream) => stream !== "").join("\n")
}

/**
 * What a refused advance commit leaves the reader holding.
 *
 * The bay is still there with the gitlink staged, and until this said so it was invisible:
 * the verb reported a git failure and exited, and the half-written bay was found later by
 * whoever tripped over it. Three things, in the order they are needed — what refused, where
 * it refused, and how to get back to it — and all three ride the raised MESSAGE, because
 * that is the single artifact that reaches human stderr and the `--json` failure document
 * alike.
 *
 * `'yrd in <bay>'` is quoted deliberately: the failure envelope lifts a QUOTED yrd command
 * out of the message into its machine-readable `resolution`, and an unquoted one is left
 * behind — so the same sentence has to read well to a person and be liftable by that reader.
 */
function refusedCommitMessage(plan: GitlinkAdvancePlan, bay: string, worktree: string, output: string): string {
  return [
    `yrd: the gitlink advance commit was refused in bay '${bay}' at '${worktree}':`,
    output === "" ? "git commit failed without saying why" : output,
    `the bay is preserved with '${plan.path}' staged at '${plan.to}' and checked out there; apply the cure above, ` +
      `then finish or discard it with 'yrd in ${bay}'`,
  ].join("\n")
}

/**
 * Publish the advance branch on the superproject's origin, so `pr submit` has a ref to
 * record. Plain fast-forward push of a fresh branch — never a force, never a lease.
 *
 * `--no-recurse-submodules` because writing to a submodule's remote is `publishMinCommit`'s
 * job, done deliberately and reported. `submodule.recurse=true` in a reader's own git config
 * would otherwise turn this line into a second, silent publisher of submodule commits.
 */
export async function pushGitlinkAdvanceBranch(
  process: Pick<Process, "run">,
  worktree: string,
  branch: string,
): Promise<void> {
  const git = processGit(process)
  const pushed = await git.run(
    worktree,
    ["push", "--quiet", "--no-recurse-submodules", "origin", `HEAD:refs/heads/${branch}`],
    true,
  )
  if (pushed.code !== 0) {
    raiseFailure(
      "refusal",
      "advance-branch-push-failed",
      `yrd: could not push the advance branch '${branch}' from '${worktree}': ` +
        `${pushed.stderr.trim() || pushed.stdout.trim() || "git push failed"}`,
    )
  }
}

/** Render a settled plan for `--dry-run` — everything a real run would do, nothing done. */
export function formatGitlinkAdvancePlan(plan: GitlinkAdvancePlan): string {
  return [
    `submodule ${plan.path} (${plan.name})`,
    `gitlink    ${plan.from} -> ${plan.to}`,
    plan.publication.state === "on-main"
      ? `min commit already on ${plan.path} main`
      : `min commit publishes as a fast-forward of ${plan.path} main ${plan.publication.mainSha.slice(0, 7)} (+${plan.publication.ahead})`,
    `change id  ${plan.changeId}`,
    "",
    plan.message.trimEnd(),
  ].join("\n")
}
