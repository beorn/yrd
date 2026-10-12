import { archiveRefFor, ensureArchiveRef } from "git-super/archive-ref"
import { changedCommitGitlinks } from "git-super/commit-graph"
import { createGitWorktreeStore, worktreeOperationBranch } from "git-super/worktree"
import { drop, type QueueLocation } from "./events.ts"
import { isAncestor, refAt, seamProcess, type Git } from "./git.ts"
import type { QueueRunLog } from "./log.ts"

export type LocalBranchRetirement = Readonly<{
  repo: string
  git: Git
  branch: string
  tip: string
  actor: string
  owner?: string
  issue?: string
  reason: string
  date: string
  log: Pick<QueueRunLog, "write">
  /** Caller-owned holds, leases and live use, including detached rebase/bisect use.
   * Required: missing or unreadable authority must never mean unprotected.
   * Called again immediately before the conditional ref removal.
   */
  protections(): Promise<readonly string[]>
  disposition:
    | Readonly<{ kind: "merged"; base: string; target: string }>
    | Readonly<{ kind: "closed"; target: string; store: QueueLocation; queue: string }>
}>

export type LocalBranchRetirementResult = Readonly<{
  outcome: "removed" | "kept" | "failed"
  archiveRef: string
  reason: string
}>

/** One policy for local retirement; git-super owns archive/ref mechanics.
 * Unmerged closed work first publishes its archive and ending to origin; a
 * closed tip already in the target is archived locally without a queue write.
 * Remote branch deletion and worktree removal are deliberately outside this operation.
 */
export async function retireLocalBranch(input: LocalBranchRetirement): Promise<LocalBranchRetirementResult> {
  const { repo, git, branch, tip, actor, issue, reason, date, disposition } = input
  const archiveRef = archiveRefFor(branch, actor, date)
  const store = createGitWorktreeStore({ repo, gitProcess: seamProcess(git, repo) })
  const protection = async (): Promise<string | undefined> => {
    const reasons = await input.protections()
    if (reasons.length > 0) return reasons.join("; ")
    const saw = await refAt(git, `refs/heads/${branch}`)
    if (saw !== tip) return `branch moved: expected ${tip}, found ${saw ?? "absent"}`
    for (const row of await store.list()) {
      if (row.branch === `refs/heads/${branch}`) return `branch is checked out at ${row.path}`
      if (row.branch === undefined) {
        const operation = worktreeOperationBranch(row.path)
        if (operation?.branch === branch) return `branch is held by ${operation.operation} at ${row.path}`
      }
    }
    return undefined
  }
  let result: LocalBranchRetirementResult
  try {
    if (actor.trim() === "" || reason.trim() === "") throw new Error("retirement requires an actor and reason")
    await git(["check-ref-format", "--branch", branch])
    await git(["check-ref-format", archiveRef])
    if (disposition.kind === "merged") {
      const mergeBase = (await git(["merge-base", disposition.base, tip])).trim()
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(mergeBase)) {
        throw new Error(`cannot resolve merge base between ${disposition.base} and ${tip}`)
      }
      const components = await changedCommitGitlinks(seamProcess(git, repo), repo, mergeBase, tip)
      if (components.length > 0) {
        input.log.write({
          kind: "warning",
          branch,
          scope: "local-branch-retirement",
          reason:
            `Component branches left unchanged for ${components.map((entry) => entry.path).join(", ")}: ` +
            `submission records no author branch names (repository ${repo}, commit ${tip}); component refs were not inspected.`,
        })
      }
    }
    let kept = await protection()
    if (kept === undefined && disposition.kind === "merged" && !(await isAncestor(git, tip, disposition.target))) {
      kept = `tip ${tip} is not merged into ${disposition.target}`
    }
    if (kept === undefined) {
      const custody = ensureArchiveRef(repo, archiveRef, tip)
      if (!custody.ok) throw new Error(custody.reason)
    }
    const alreadyMerged =
      kept === undefined && disposition.kind === "closed" && (await isAncestor(git, tip, disposition.target))
    if (kept === undefined && disposition.kind === "closed" && !alreadyMerged) {
      await drop(disposition.store, {
        queue: disposition.queue,
        branch,
        by: actor,
        issue,
        note: reason,
        localArchive: { ref: archiveRef, tip },
      })
    }
    if (kept === undefined) kept = await protection()
    if (kept !== undefined) {
      result = { outcome: "kept", archiveRef, reason: kept }
    } else {
      await store.removeArchivedBranch({ branch, tip, archiveRef })
      result = { outcome: "removed", archiveRef, reason }
    }
  } catch (error) {
    result = { outcome: "failed", archiveRef, reason: error instanceof Error ? error.message : String(error) }
  }
  // A failed journal write must propagate, never relabel an already removed ref as kept.
  input.log.write({
    kind: "local-branch-retirement",
    repo,
    branch,
    head: tip,
    actor,
    owner: input.owner,
    issue,
    archive: archiveRef,
    reason: result.reason,
    outcome: result.outcome,
  })
  return result
}
