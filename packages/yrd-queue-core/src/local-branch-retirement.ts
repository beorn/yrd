import { resolve } from "node:path"

import { archiveRefFor, ensureArchiveRef, findArchiveRefFor } from "git-super/archive-ref"
import { changedCommitGitlinks } from "git-super/commit-graph"
import { createGitWorktreeStore, worktreeOperationBranch } from "git-super/worktree"
import { drop, type QueueLocation } from "./events.ts"
import { publishRetirementArchive } from "./origin-branch-retirement.ts"
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
  /** Read the same eligibility and protections without writing custody or deleting a ref. */
  dryRun?: boolean
  /** A proven worktree-less retained store: its own attached HEAD is not a live checkout (30094). */
  worktreeLess?: boolean
  log: Pick<QueueRunLog, "write">
  /** Caller-owned holds, leases and live use, including detached rebase/bisect use.
   * Required: missing or unreadable authority must never mean unprotected.
   * Called again immediately before the conditional ref removal.
   */
  protections(): Promise<readonly string[]>
  disposition:
    | Readonly<{ kind: "archived"; target: string; ref: string }>
    | Readonly<{ kind: "merged"; base: string; target: string }>
    | Readonly<{ kind: "closed"; target: string; store: QueueLocation; queue: string }>
    | Readonly<{
        kind: "landed"
        /** Observed origin commit retaining this tip; a root gitlink alone is not custody. */
        target: string
        proof: { kind: "ancestry" } | { kind: "landing"; event: string; path: string; tip: string }
      }>
}>

export type LocalBranchRetirementResult = Readonly<{
  outcome: "removed" | "kept" | "failed" | "eligible"
  archiveRef?: string
  archiveLocation?: "local" | "origin"
  reason: string
  detail?: string
}>

type Kept = { code: "held" | "moved" | "unreached" | "advanced"; detail: string }

/** An observed protection is a kept result; unreadable authority still fails. */
class RetirementKept extends Error {
  constructor(readonly protection: Kept) {
    super(protection.detail)
  }
}

/** One policy for local retirement; git-super owns archive/ref mechanics.
 * Unmerged closed work first publishes its archive and ending to origin. A tip
 * proven merged into the target needs no custody of its own (ADR-0018 amendment,
 * line 69), so it is removed with no archive ref and no queue write (30683).
 * Remote branch deletion and worktree removal are deliberately outside this operation.
 */
export async function retireLocalBranch(input: LocalBranchRetirement): Promise<LocalBranchRetirementResult> {
  const { repo, git, branch, tip, actor, issue, reason, date, disposition } = input
  let archiveRef = disposition.kind === "archived" ? disposition.ref : archiveRefFor(branch, actor, date)
  let existingArchive: string | undefined
  const store = createGitWorktreeStore({ repo, gitProcess: seamProcess(git, repo) })
  let firstProtectionRead = true
  let completedArchive: string | undefined
  // A merged or landed tip writes no archive (30683), so a rerun after its removal finds only the target holding it.
  let completedOnTarget = false
  let writtenArchive: string | undefined
  let archiveLocation: "local" | "origin" | undefined
  // A tip in its target writes no archive (30683): reachability() proves it for merged and
  // landed dispositions, and a closed one joins once alreadyMerged reads its ancestry.
  let onTarget = disposition.kind === "merged" || disposition.kind === "landed"
  const protection = async (): Promise<Kept | undefined> => {
    const firstRead = firstProtectionRead
    firstProtectionRead = false
    if (
      firstRead &&
      (disposition.kind === "merged" || disposition.kind === "landed") &&
      (await refAt(git, `refs/heads/${branch}`)) === undefined
    ) {
      completedArchive = findArchiveRefFor(repo, branch, tip)
      if (completedArchive === undefined) {
        completedOnTarget = true
      } else if ((await refAt(git, completedArchive)) === tip) {
        writtenArchive = completedArchive
        archiveLocation = "local"
      }
    }
    const reasons = await input.protections()
    if (reasons.length > 0) return { code: "held", detail: reasons.join("; ") }
    const saw = await refAt(git, `refs/heads/${branch}`)
    if (completedOnTarget) {
      if (saw !== undefined) return { code: "moved", detail: `branch reappeared at ${saw} after completed retirement` }
    } else if (completedArchive === undefined) {
      if (saw !== tip) return { code: "moved", detail: `branch moved: expected ${tip}, found ${saw ?? "absent"}` }
    } else {
      if (saw !== undefined) return { code: "moved", detail: `branch reappeared at ${saw} after completed retirement` }
      if ((await refAt(git, completedArchive)) !== tip) {
        writtenArchive = undefined
        archiveLocation = undefined
        return {
          code: "moved",
          detail: `completed retirement custody changed: ${completedArchive} no longer holds ${tip}`,
        }
      }
      writtenArchive = completedArchive
      archiveLocation = "local"
    }
    const self = resolve(repo)
    for (const row of await store.list()) {
      if (input.worktreeLess === true && resolve(row.path) === self) continue
      if (row.branch === `refs/heads/${branch}`) return { code: "held", detail: `branch is checked out at ${row.path}` }
      if (row.branch === undefined) {
        const operation = worktreeOperationBranch(row.path)
        if (operation?.branch === branch) {
          return { code: "held", detail: `branch is held by ${operation.operation} at ${row.path}` }
        }
      }
    }
    return undefined
  }
  const reachability = async (): Promise<Kept | undefined> => {
    if (disposition.kind !== "closed" && !(await isAncestor(git, tip, disposition.target))) {
      return { code: "unreached", detail: `tip ${tip} is not merged into ${disposition.target}` }
    }
    if (disposition.kind === "landed" && disposition.proof.kind === "landing" && disposition.proof.tip !== tip) {
      return {
        code: "advanced",
        detail: `tip ${tip} differs from landing event ${disposition.proof.event}'s gitlink ${disposition.proof.tip}`,
      }
    }
    return undefined
  }
  const formatKept = (kept: Kept): LocalBranchRetirementResult => {
    const detail = writtenArchive === undefined ? `${kept.detail}; not archived` : kept.detail
    return {
      outcome: "kept",
      ...(writtenArchive === undefined ? {} : { archiveRef: writtenArchive }),
      reason: disposition.kind === "landed" || disposition.kind === "archived" ? kept.code : detail,
      detail,
    }
  }
  let result: LocalBranchRetirementResult
  try {
    if (actor.trim() === "" || reason.trim() === "") throw new Error("retirement requires an actor and reason")
    await git(["check-ref-format", "--branch", branch])
    if (disposition.kind === "closed") {
      existingArchive = findArchiveRefFor(repo, branch, tip)
      archiveRef = existingArchive ?? archiveRef
    }
    await git(["check-ref-format", archiveRef])
    if (disposition.kind === "archived" && (await refAt(git, disposition.ref)) === tip) {
      writtenArchive = disposition.ref
      archiveLocation = "origin"
    }
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
    if (kept === undefined) kept = await reachability()
    const alreadyMerged =
      kept === undefined && disposition.kind === "closed" && (await isAncestor(git, tip, disposition.target))
    if (alreadyMerged) onTarget = true
    if (kept === undefined && !input.dryRun && completedArchive === undefined && !completedOnTarget && !onTarget) {
      const custody = ensureArchiveRef(repo, archiveRef, tip)
      if (!custody.ok) throw new Error(custody.reason)
      writtenArchive = archiveRef
      // The ref written by ensureArchiveRef is LOCAL. Origin custody is claimed only
      // after a push reads back at the remote (30247).
      archiveLocation = "local"
      if (disposition.kind === "closed") {
        // prepareRetirementArchive.publish verifies the exact head at the remote.
        await publishRetirementArchive(disposition.store, { branch, archive: archiveRef, head: tip })
        archiveLocation = "origin"
      } else if (disposition.kind === "archived") {
        // The archived disposition carries no store; its caller published and read it
        // back at that origin before calling here (retireComponentBranch).
        archiveLocation = "origin"
      }
    }
    if (kept === undefined && !input.dryRun && disposition.kind === "closed" && !alreadyMerged) {
      await drop(disposition.store, {
        queue: disposition.queue,
        branch,
        by: actor,
        issue,
        note: reason,
        localArchive: { ref: archiveRef, tip },
      })
      archiveLocation = "origin"
    }
    if (kept === undefined) kept = await protection()
    if (kept === undefined && (completedArchive !== undefined || completedOnTarget)) kept = await reachability()
    if (kept !== undefined) {
      result = formatKept(kept)
    } else if (input.dryRun) {
      const wouldArchive = completedArchive ?? (onTarget ? undefined : archiveRef)
      result = { outcome: "eligible", ...(wouldArchive === undefined ? {} : { archiveRef: wouldArchive }), reason }
    } else if (completedOnTarget) {
      result = {
        outcome: "removed",
        reason,
        detail: `already retired: ${disposition.target} holds ${tip} and the branch is absent; this run deleted no ref`,
      }
    } else if (completedArchive !== undefined) {
      result = {
        outcome: "removed",
        archiveRef: completedArchive,
        ...(archiveLocation === undefined ? {} : { archiveLocation }),
        reason,
        detail: `already retired: ${completedArchive} holds ${tip}; this run deleted no ref`,
      }
    } else {
      await store.removeBranch({
        branch,
        tip,
        ...(onTarget ? {} : { verify: { ref: archiveRef, oid: tip } }),
        beforeRemove: async () => {
          const held = await protection()
          if (held !== undefined) throw new RetirementKept(held)
        },
      })
      result = {
        outcome: "removed",
        ...(onTarget ? {} : { archiveRef }),
        ...(archiveLocation === undefined ? {} : { archiveLocation }),
        reason,
      }
    }
  } catch (error) {
    if (error instanceof RetirementKept) {
      result = formatKept(error.protection)
    } else {
      result = {
        outcome: "failed",
        ...(writtenArchive === undefined ? {} : { archiveRef: writtenArchive }),
        ...(archiveLocation === undefined ? {} : { archiveLocation }),
        reason: error instanceof Error ? error.message : String(error),
      }
    }
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
    ...(result.archiveRef === undefined ? {} : { archive: result.archiveRef }),
    reason: result.reason,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    outcome: result.outcome,
  })
  return result
}
