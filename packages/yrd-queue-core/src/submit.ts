/**
 * `yrd queue submit <branch>`: the one path in
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The change).
 *
 * One atomic push of the branch and of its change's opened record. Either both
 * arrive at the remote or neither does, so a reader never sees a submitted
 * branch without its change or a change without its branch. A submit at an
 * unchanged head appends a new opened record to the existing change: that is a
 * retry, and the change keeps its place in line from its first opened record.
 * The branch is always pushed with a lease, because a rebased branch is the
 * ordinary case and a lease is what stops it clobbering a head the submitter
 * never saw.
 */

import { readdir } from "node:fs/promises"
import { targetName, type Target } from "./config.ts"
import { ABSENT, appendRecord, type Git } from "./records.ts"
import { isAncestor, mergeBase, readRemoteCommit, refAt } from "./git.ts"
import { changeRef } from "./refs.ts"
import { requireResumed } from "./pause.ts"

export type SubmitRequest = Readonly<{
  /** The branch being submitted: the change's own. */
  branch: string
  /** The queue's target: the branch it lands on, at the remote holding it. */
  target: Target
  submitter: string
  issue?: string
  /** Explicit permission to rebase this clean, checked-out branch onto the captured target. */
  rebase?: boolean
}>

export type Submitted = Readonly<{
  branch: string
  head: string
  /** The target commit observed during preflight; the queue checks again at merge. */
  targetHead: string
  /** The opened record's sha. */
  opened: string
  /** True when the change already existed at this head, so this was a retry. */
  retry: boolean
}>

/**
 * The target is not a change. Thrown at the one path in, and by the CLI's
 * dry run before it says what it would open: a preview that accepts what
 * the action refuses is the reverse of the flag's purpose (2026-09-03).
 */
export function refuseTarget(branch: string, target: string): void {
  if (branch === target) {
    throw new Error(`${target} is the target, not a change; a change is a branch submitted to be merged into ${target}`)
  }
}

export type SubmitInspection = Readonly<{ head: string; targetHead: string; base: string; rebaseRequired: boolean }>

/** The bound on a courtesy check: this observation cannot reserve the target. */
export function freshnessLine(targetHead: string): string {
  return `freshness checked at ${targetHead}; the queue revalidates at merge`
}

/** The same read-only admission checks serve the action and its preview. */
export async function inspectSubmit(git: Git, remote: string, request: SubmitRequest): Promise<SubmitInspection> {
  refuseTarget(request.branch, request.target.branch)
  // This is the early courtesy refusal. The run is the enforcement point: a
  // pause that races this read may let the change open, but it cannot let it
  // be checked or merged while the pause stands.
  await requireResumed(git, remote, request.target.branch)
  const head = (await git(["rev-parse", "--verify", `refs/heads/${request.branch}^{commit}`])).trim()
  const targetHead = await readRemoteCommit(git, request.target.remote, `refs/heads/${request.target.branch}`)
  if (targetHead === undefined) throw new Error(`${targetName(request.target)} has no advertised target branch`)
  const bound = freshnessLine(targetHead)
  if (await isAncestor(git, head, targetHead)) {
    throw new Error(
      `nothing new to submit: ${targetName(request.target)} at ${targetHead} already contains ${request.branch} at ${head}; ${bound}`,
    )
  }
  const base = await mergeBase(git, head, targetHead)
  if (base === undefined) {
    throw new Error(
      `${request.branch} at ${head} has no common base with ${targetName(request.target)}; found no merge base, expected ${targetHead}. Start a change from that target; ${bound}`,
    )
  }
  const rebaseRequired = !(await isAncestor(git, targetHead, head))
  if (rebaseRequired && request.rebase !== true) {
    throw new Error(
      `${request.branch} is stale: found merge base ${base}, expected ${targetName(request.target)} at ${targetHead}. Rebase onto that target and retry, or check out this branch and use yrd submit --rebase; ${bound}`,
    )
  }
  if (request.rebase === true) await requireRebaseWorktree(git, request.branch, bound)
  return { head, targetHead, base, rebaseRequired }
}

async function requireRebaseWorktree(git: Git, branch: string, bound: string): Promise<void> {
  const checkedOut = (await git(["branch", "--show-current"])).trim()
  if (checkedOut !== branch) {
    throw new Error(
      `--rebase needs ${branch} checked out here; found ${checkedOut === "" ? "detached HEAD" : checkedOut}. Check out ${branch} and retry; ${bound}`,
    )
  }
  const gitdir = (await git(["rev-parse", "--absolute-git-dir"])).trim()
  const entries = await readdir(gitdir)
  const operation = entries.find((name) =>
    [
      "rebase-merge",
      "rebase-apply",
      "sequencer",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
    ].includes(name),
  )
  if (operation !== undefined) {
    throw new Error(
      `--rebase refused: ${operation} in ${gitdir} marks an active Git operation; finish it before retrying; ${bound}`,
    )
  }
  const dirty = (await git(["status", "--porcelain=v1", "--untracked-files=all"])).trim()
  if (dirty !== "") {
    throw new Error(
      `--rebase needs a clean worktree and index, including untracked files; commit or move this work before retrying; ${bound}:\n${dirty}`,
    )
  }
}

export async function submit(git: Git, remote: string, request: SubmitRequest): Promise<Submitted> {
  const inspected = await inspectSubmit(git, remote, request)
  const { targetHead } = inspected
  let head = inspected.head
  if (inspected.rebaseRequired) {
    try {
      await git(["rebase", "--no-autostash", "--no-update-refs", targetHead])
    } catch (cause) {
      throw new Error(
        `rebase of ${request.branch} onto ${targetHead} stopped; no change was opened. Inspect Git's error and status; resolve conflicts and run git rebase --continue, then rerun yrd submit. ${String(cause)}`,
        { cause },
      )
    }
    head = (await git(["rev-parse", "--verify", `refs/heads/${request.branch}^{commit}`])).trim()
    if (!(await isAncestor(git, targetHead, head))) {
      throw new Error(
        `rebase left ${request.branch} at ${head} without captured target ${targetHead}; no change was opened`,
      )
    }
    if (head === targetHead) {
      throw new Error(
        `nothing new to submit after rebase: ${targetName(request.target)} at ${targetHead} already contains this change; ${freshnessLine(targetHead)}`,
      )
    }
  }
  const change = { branch: request.branch, head }
  const ref = changeRef(request.target.branch, change)
  // Where the remote holds the branch and this change right now, in one
  // reading: a retry appends to the remote's history of the change, so that
  // history is fetched first, and the branch's lease is the remote's own value,
  // never a tracking ref that may be stale or missing in a fresh clone.
  // ls-remote answers "absent" as an empty list, never as an error, which is
  // the one honest empty a submit is allowed to swallow.
  const at = new Map(
    (await git(["ls-remote", "--refs", remote, `refs/heads/${request.branch}`, ref]))
      .split("\n")
      .map((row) => row.trim().split(/\s+/u))
      .map(([sha, name]) => [name ?? "", sha ?? ""] as const),
  )
  const remoteTip = at.get(ref) ?? ""
  const remoteBranch = at.get(`refs/heads/${request.branch}`) ?? ""
  const retry = remoteTip !== ""
  if (retry) await git(["fetch", "--quiet", remote, `+${ref}:${ref}`])
  // A local change ref the remote does not hold is an orphan of a refused
  // push; submit is the only writer of these refs, so it goes.
  else if ((await refAt(git, ref)) !== undefined) await git(["update-ref", "-d", ref])
  const issue = await issueOf(git, request.branch, head, request.issue)
  const trailers: (readonly [string, string])[] = [["Submitter", request.submitter]]
  if (issue !== undefined) trailers.push(["Issue", issue])
  const opened = await appendRecord(git, request.target.branch, {
    change,
    kind: "opened",
    subject: `${request.submitter} submitted ${request.branch} to ${targetName(request.target)}`,
    trailers,
  })
  // Two explicit leases make the push the same compare-and-swap the local
  // append is: each ref must still be where this submitter just read it (the
  // zero sha means "absent"), or the whole push refuses and nothing lands —
  // and then the local change ref goes back to what the remote holds, so a
  // refused submit leaves no opened record for the next one to chain onto.
  try {
    await git([
      "push",
      "--quiet",
      "--atomic",
      `--force-with-lease=refs/heads/${request.branch}:${remoteBranch === "" ? ABSENT : remoteBranch}`,
      `--force-with-lease=${ref}:${retry ? remoteTip : ABSENT}`,
      remote,
      `${head}:refs/heads/${request.branch}`,
      `${ref}:${ref}`,
    ])
  } catch (error) {
    await git(retry ? ["update-ref", ref, remoteTip] : ["update-ref", "-d", ref])
    throw error
  }
  return { branch: request.branch, head, targetHead, opened, retry }
}

/**
 * The issue a change is for (ruling C4): the one declared on submit, else
 * the head commit's `Resolves:` or `Refs:` trailer, else the leading
 * `<issue>-` segment of the branch name's last component, the convention
 * (§ The change). None of those, and the change has no issue.
 */
export async function issueOf(git: Git, branch: string, head: string, declared?: string): Promise<string | undefined> {
  if (declared !== undefined) return declared
  const fromTrailer = (
    await git(["log", "-1", "--format=%(trailers:key=Resolves,key=Refs,valueonly,separator=%x00)", head])
  )
    .split("\0")
    .map((value) => value.trim())
    .find((value) => value !== "")
  if (fromTrailer !== undefined) return fromTrailer
  return /^(\d+)-/u.exec(branch.split("/").at(-1) ?? "")?.[1]
}
