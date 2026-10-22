import { resolve } from "node:path"

import { findArchiveRefFor } from "git-super/archive-ref"
import { changedCommitGitlinks } from "git-super/commit-graph"
import { createGitWorktreeStore, worktreeOperationBranch } from "git-super/worktree"
import {
  ChainCustodyMismatch,
  drop,
  readKeptCustody,
  type AdvancedDrop,
  type Dropped,
  type QueueLocation,
} from "./events.ts"
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
    | Readonly<{ kind: "merged"; base: string; target: string }>
    | Readonly<{
        kind: "closed"
        target: string
        store: QueueLocation
        queue: string
        /** The owner's drop of a tip past `recorded`: the event keeps both and records what the target lacks (30683). */
        advanced?: Readonly<{ recorded: string } & Omit<AdvancedDrop, "tip">>
      }>
    | Readonly<{
        kind: "landed"
        /** Observed origin commit retaining this tip; a root gitlink alone is not custody. */
        target: string
        proof: { kind: "ancestry" }
      }>
}>

export type LocalBranchRetirementResult = Readonly<{
  outcome: "removed" | "kept" | "failed" | "eligible"
  archiveRef?: string
  archiveLocation?: "local" | "origin"
  /** The change chain at origin and the event on it (`tip`) that keeps the removed tip (30683). */
  event?: Readonly<{ ref: string; tip: string }>
  reason: string
  detail?: string
}>

type Kept = { code: "held" | "moved" | "unreached"; detail: string }

/** An observed protection is a kept result; unreadable authority still fails. */
class RetirementKept extends Error {
  constructor(readonly protection: Kept) {
    super(protection.detail)
  }
}

/** One policy for local retirement; git-super owns archive/ref mechanics.
 * Unmerged closed work first writes the event that keeps its exact tip to origin's chain (30683). A tip
 * proven merged into the target needs no custody of its own (ADR-0018 amendment,
 * line 69), so it is removed with no archive ref and no queue write (30683).
 * Remote branch deletion and worktree removal are deliberately outside this operation.
 */
export async function retireLocalBranch(input: LocalBranchRetirement): Promise<LocalBranchRetirementResult> {
  const { repo, git, branch, tip, actor, issue, reason, disposition } = input
  const store = createGitWorktreeStore({ repo, gitProcess: seamProcess(git, repo) })
  let firstProtectionRead = true
  let completedArchive: string | undefined
  // A tip proven in its target needs no custody of its own (30683): reachability() proves it for a merged or
  // landed disposition, and a closed one joins once alreadyMerged reads its ancestry. Nothing here writes an
  // archive; an archive an earlier version left is still read as a completed retirement.
  const provenOnTarget = disposition.kind === "merged" || disposition.kind === "landed"
  // A proven tip writes no archive, so a rerun after its removal finds only the target holding it.
  let completedOnTarget = false
  let writtenArchive: string | undefined
  let archiveLocation: "local" | "origin" | undefined
  let custody: Dropped | undefined
  let onTarget = provenOnTarget
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
        completedOnTarget = provenOnTarget
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
    return undefined
  }
  const formatKept = (kept: Kept): LocalBranchRetirementResult => {
    const detail = writtenArchive === undefined ? `${kept.detail}; not archived` : kept.detail
    return {
      outcome: "kept",
      ...(writtenArchive === undefined ? {} : { archiveRef: writtenArchive }),
      // The closed disposition now carries the callers that once used landed and archived, so it reports the code too.
      reason: disposition.kind === "merged" ? detail : kept.code,
      detail,
    }
  }
  let result: LocalBranchRetirementResult
  try {
    if (actor.trim() === "" || reason.trim() === "") throw new Error("retirement requires an actor and reason")
    await git(["check-ref-format", "--branch", branch])
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
    if (kept === undefined && !input.dryRun && disposition.kind === "closed" && !alreadyMerged) {
      // The event that keeps the exact tip is on origin's chain before the local name can go (30683).
      const advanced = disposition.advanced
      custody = await drop(disposition.store, {
        queue: disposition.queue,
        branch,
        by: actor,
        issue,
        note: reason,
        local: {
          tip,
          ...(advanced === undefined
            ? {}
            : { advanced: { uniqueCommits: advanced.uniqueCommits, target: advanced.target } }),
        },
      })
    }
    if (kept === undefined) kept = await protection()
    if (kept === undefined && (completedArchive !== undefined || completedOnTarget)) kept = await reachability()
    if (kept !== undefined) {
      result = formatKept(kept)
    } else if (input.dryRun) {
      result = {
        outcome: "eligible",
        ...(completedArchive === undefined ? {} : { archiveRef: completedArchive }),
        reason,
      }
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
        beforeRemove: async () => {
          const held = await protection()
          if (held !== undefined) throw new RetirementKept(held)
          if (custody === undefined || disposition.kind !== "closed") return
          // The shared chain readback: a chain that no longer keeps the tip keeps the branch (30683).
          await readKeptCustody(disposition.store, {
            queue: disposition.queue,
            branch,
            ref: custody.ref,
            event: custody.event,
            keeps: disposition.advanced === undefined ? [tip] : [disposition.advanced.recorded, tip],
          }).catch((cause: unknown) => {
            if (cause instanceof ChainCustodyMismatch)
              throw new RetirementKept({ code: "moved", detail: cause.message })
            throw cause
          })
        },
      })
      result = {
        outcome: "removed",
        ...(custody === undefined ? {} : { event: { ref: custody.ref, tip: custody.event } }),
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
