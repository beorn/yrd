import { resolve } from "node:path"
import type { Process } from "@yrd/process"
import { readCommitGitlinks } from "git-super/commit-graph"
import { adaptProcessGit } from "@yrd/process"
import { GIT_TIMEOUT_MS, processGit } from "./pr-submodule-publication.ts"

/**
 * Monotonicity: a gitlink may only move FORWARD along its submodule's history.
 *
 * This is deliberately a separate question from legitimacy, and the separation is the
 * whole design (ADR `2026-08-27-pin-legitimacy-is-not-monotonicity`). Legitimacy —
 * `submodulePinPublications`, the min-commit rule — asks whether the value the change
 * writes is a real commit merged on that submodule's own main. Monotonicity asks
 * whether it is a step FORWARD from the value main records right now. Neither answers
 * the other, and the specimen that proves it is PR2118 (2026-08-27): every sha it
 * wrote was published and on its submodule's main, so legitimacy passed cleanly, while
 * the change would have reverted eight commits across three submodules — `ag` back by
 * 3, `km` back by 1, `vendor/yrd` DIVERGED (5 main-only, 1 change-only) — for zero
 * unique content. It would have passed every gate yrd owned.
 *
 * Three properties this module is built around, each paid for by that specimen:
 *
 * 1. **The comparison is against main's CURRENT gitlink**, read from the tip of the base
 *    ref at the moment the question is asked — not against the change's merge base. A
 *    change is measured against the main it would merge into, and that main keeps moving.
 *
 * 2. **The answer is a main-only COUNT, never a bare ancestry bit.** `merge-base
 *    --is-ancestor` returns "no" for a strictly-behind gitlink and "no" for a diverged
 *    one, and those are different findings with different sizes; the diverged case is
 *    the one PR2118 actually hit, and a bit cannot report "5 main-only, 1 change-only".
 *
 * 3. **"Could not tell" is its own state.** A commit the reader cannot find is not a
 *    commit moving backwards. Collapsing the two would send an author to re-merge over
 *    what is really an unfetched object.
 *
 * Which gitlinks a change WRITES is decided by the caller, from the change's own diff.
 * A branch that touches no gitlink is exempt here by construction — it never reaches
 * this module — however far behind its base has fallen.
 */

/** One gitlink a change writes: the path, the value written, and where that submodule lives. */
export type ChangedGitlink = Readonly<{
  /** The submodule path the superproject records, e.g. `vendor/yrd`. */
  path: string
  /** The value this change writes at that path. */
  gitlink: string
  /** Absolute path to the submodule's own repository, where the two values are compared. */
  repository: string
}>

/**
 * Where one written gitlink sits relative to main's current value for the same path.
 *
 * `behind` is the main-only count (commits main's value carries that the written value
 * does not — what would be REVERTED); `ahead` is the change-only count. `backward`
 * covers both the strictly-behind case (`ahead === 0`) and the diverged case
 * (`ahead > 0`): one state because they have one cure, two counts because they are not
 * the same finding.
 */
export type GitlinkDirection =
  | Readonly<{ state: "forward"; path: string; from: string; to: string; ahead: number }>
  | Readonly<{ state: "unchanged"; path: string; gitlink: string }>
  | Readonly<{ state: "backward"; path: string; from: string; to: string; behind: number; ahead: number }>
  /**
   * Main records no gitlink at this path, so there is no previous value and nothing this
   * change could revert. An ADDITION, not a regression and not an unreadable comparison —
   * whether an addition is allowed at all is the add-authorization gate's ruling, asked
   * upstream of here. Folding it into `undetermined` refused every @cto-authorized
   * submodule addition, which is what one question per check exists to prevent.
   */
  | Readonly<{ state: "absent-on-main"; path: string; gitlink: string }>
  | Readonly<{ state: "undetermined"; path: string; reason: string }>

export type BackwardGitlink = Extract<GitlinkDirection, { state: "backward" }>

/**
 * The tip of the base ref in a client checkout — main as it stands NOW.
 *
 * Resolved through the same `origin/<base>` then `<base>` order every other client-side
 * base lookup uses. Deliberately NOT the merge base: the merge base is what the change's
 * own diff is measured from, and measuring monotonicity there would compare main against
 * itself and admit every regression. Returns undefined when no ref resolves, which the
 * caller must refuse on rather than silently skipping the check.
 */
export async function resolveBaseTip(options: {
  process: Pick<Process, "run">
  repo: string
  base: string
}): Promise<string | undefined> {
  const repo = resolve(options.repo)
  const git = processGit(options.process)
  const refs = options.base.startsWith("refs/") ? [options.base] : [`refs/remotes/origin/${options.base}`, options.base]
  for (const ref of refs) {
    const resolved = await git.run(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], true)
    if (resolved.code === 0) {
      const sha = resolved.stdout.trim()
      if (sha !== "") return sha
    }
  }
  return undefined
}

/**
 * Compare each written gitlink with main's current value for the same path.
 *
 * Every read that can fail produces `undetermined` with the reason, never a verdict:
 * an object this checkout has not fetched, a path main no longer records, a git that
 * exited non-zero. The one thing this must never do is report "not present" as
 * "moving backwards".
 */
export async function gitlinkDirections(options: {
  process: Pick<Process, "run">
  repo: string
  baseTipSha: string
  gitlinks: readonly ChangedGitlink[]
}): Promise<readonly GitlinkDirection[]> {
  if (options.gitlinks.length === 0) return Object.freeze([])
  const repo = resolve(options.repo)
  const git = processGit(options.process)
  const superGit = adaptProcessGit(options.process, { timeoutMs: GIT_TIMEOUT_MS })
  const onMain = new Map(
    (await readCommitGitlinks(superGit, repo, options.baseTipSha)).map((entry) => [entry.path, entry.target]),
  )

  const directions: GitlinkDirection[] = []
  for (const { path, gitlink, repository } of options.gitlinks) {
    const from = onMain.get(path)
    if (from === undefined) {
      directions.push({ state: "absent-on-main", path, gitlink })
      continue
    }
    if (from === gitlink) {
      directions.push({ state: "unchanged", path, gitlink })
      continue
    }
    // Ask whether each side is even present before comparing, so an unfetched object is
    // named as unfetched instead of surfacing as an unreadable rev-list failure.
    const missing: string[] = []
    for (const sha of [from, gitlink]) {
      const present = await git.run(repository, ["cat-file", "-e", `${sha}^{commit}`], true)
      if (present.code !== 0) missing.push(sha)
    }
    if (missing.length > 0) {
      directions.push({
        state: "undetermined",
        path,
        reason:
          `commit${missing.length === 1 ? "" : "s"} ${missing.join(", ")} not present in '${repository}', so ` +
          `'${gitlink}' cannot be compared with main's current '${from}'`,
      })
      continue
    }
    // One call, both counts. `--left-right` over the three-dot range reports left =
    // reachable from `from` only (main-only, the revert size) and right = reachable from
    // `gitlink` only. A bare `--is-ancestor` bit cannot report either number, which is
    // exactly why the ADR ruled the count in.
    const counted = await git.run(repository, ["rev-list", "--count", "--left-right", `${from}...${gitlink}`], true)
    if (counted.code !== 0) {
      directions.push({
        state: "undetermined",
        path,
        reason:
          `could not count commits between main's current '${from}' and '${gitlink}': ` +
          `${counted.stderr.trim() || counted.stdout.trim() || "git rev-list failed"}`,
      })
      continue
    }
    const [left, right] = counted.stdout.trim().split(/\s+/u)
    const behind = Number(left)
    const ahead = Number(right)
    if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead)) {
      directions.push({
        state: "undetermined",
        path,
        reason: `git rev-list --count --left-right returned unreadable counts '${counted.stdout.trim()}'`,
      })
      continue
    }
    directions.push(
      behind > 0
        ? { state: "backward", path, from, to: gitlink, behind, ahead }
        : { state: "forward", path, from, to: gitlink, ahead },
    )
  }
  return Object.freeze(directions)
}

/**
 * The refusal body for gitlinks that would move backwards — both shas, both counts, and
 * the one command that clears it.
 *
 * Pure, so the message cannot drift from the condition that raises it, and so the
 * numbers a reader acts on are testable without a repository.
 */
export function backwardGitlinkRefusal(backward: readonly BackwardGitlink[]): string {
  return backward
    .map(({ path, from, to, behind, ahead }) => {
      const shape =
        ahead === 0
          ? `is behind by ${behind} commit${behind === 1 ? "" : "s"}`
          : `has DIVERGED from it (${behind} main-only, ${ahead} change-only)`
      return (
        `submodule '${path}' gitlink '${to}' ${shape} against main's current '${from}'; ` +
        `merging it would revert ${behind} commit${behind === 1 ? "" : "s"} on that submodule — ` +
        "re-merge this change onto current main, then advance the gitlink from there " +
        `(inspect: git -C ${path} log --oneline ${to}..${from})`
      )
    })
    .join("\n")
}
