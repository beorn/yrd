import { archiveRefFor, ensureArchiveRef } from "git-super/archive-ref"
import { createGitWorktreeStore } from "git-super/worktree"
import { drop, type QueueLocation } from "./events.ts"
import { isAncestor, refAt, seamProcess, type Git } from "./git.ts"
import type { QueueRunLog } from "./log.ts"

export type LocalBranchRetirement = Readonly<{
  repo: string
  git: Git
  branch: string
  tip: string
  actor: string
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
    | Readonly<{ kind: "merged"; target: string }>
    | Readonly<{ kind: "closed"; store: QueueLocation; queue: string }>
}>

export type LocalBranchRetirementResult = Readonly<{
  outcome: "removed" | "kept"
  archiveRef: string
  reason: string
}>

/** One policy for local retirement; git-super owns archive/ref mechanics.
 * Closed work first publishes its archive and ending to origin. Remote branch
 * deletion and worktree removal are deliberately outside this operation.
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
    const checkedOut = (await store.list()).find((row) => row.branch === `refs/heads/${branch}`)
    if (checkedOut !== undefined) return `branch is checked out at ${checkedOut.path}`
    return undefined
  }
  let result: LocalBranchRetirementResult
  try {
    if (actor.trim() === "" || reason.trim() === "") throw new Error("retirement requires an actor and reason")
    await git(["check-ref-format", "--branch", branch])
    await git(["check-ref-format", archiveRef])
    let kept = await protection()
    if (kept === undefined && disposition.kind === "merged" && !(await isAncestor(git, tip, disposition.target))) {
      kept = `tip ${tip} is not merged into ${disposition.target}`
    }
    if (kept === undefined) {
      const custody = ensureArchiveRef(repo, archiveRef, tip)
      if (!custody.ok) kept = custody.reason
    }
    if (kept === undefined && disposition.kind === "closed") {
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
    result = { outcome: "kept", archiveRef, reason: error instanceof Error ? error.message : String(error) }
  }
  // A failed journal write must propagate, never relabel an already removed ref as kept.
  input.log.write({
    kind: "local-branch-retirement",
    repo,
    branch,
    head: tip,
    actor,
    issue,
    archive: archiveRef,
    reason: result.reason,
    outcome: result.outcome,
  })
  return result
}
