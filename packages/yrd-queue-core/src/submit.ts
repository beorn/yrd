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

import { targetName, type Target } from "./config.ts"
import { ABSENT, appendRecord, type Git } from "./records.ts"
import { refAt } from "./git.ts"
import { changeRef } from "./refs.ts"
import { requireUnfrozen } from "./freeze.ts"

export type SubmitRequest = Readonly<{
  /** The branch being submitted: the change's own. */
  branch: string
  /** The queue's target: the branch it lands on, at the remote holding it. */
  target: Target
  submitter: string
  issue?: string
}>

export type Submitted = Readonly<{
  branch: string
  head: string
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

export async function submit(git: Git, remote: string, request: SubmitRequest): Promise<Submitted> {
  // The target is not a change: a change is a branch submitted to be MERGED
  // INTO the target, so submitting the target itself asks the queue to merge a
  // branch into itself. Nothing refused it before, and what it opened was a
  // change whose head the target already carried: it read merged at once, the
  // catch-up gave it a `Merged-By: direct` record naming whatever merge landed
  // next, its submitter was told to close a bead for a merge that was not
  // theirs, and that merge stayed accounted for in the E5 walk, where an
  // accounted commit hides every direct at or below it
  // (2026-09-03: `main@0a9db9daf7eb`, named for the queue's own merge 005a622156c7).
  refuseTarget(request.branch, request.target.branch)
  // This is the early courtesy refusal. The run is the enforcement point: a
  // freeze that races this read may let the change open, but it cannot let it
  // be checked or merged while the freeze stands.
  await requireUnfrozen(git, remote)
  const head = (await git(["rev-parse", "--verify", `refs/heads/${request.branch}^{commit}`])).trim()
  const change = { branch: request.branch, head }
  const ref = changeRef(change)
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
  const opened = await appendRecord(git, {
    change,
    kind: "opened",
    subject: `${request.submitter} submitted ${request.branch} to ${targetName(request.target)}`,
    target: targetName(request.target),
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
      `refs/heads/${request.branch}:refs/heads/${request.branch}`,
      `${ref}:${ref}`,
    ])
  } catch (error) {
    await git(retry ? ["update-ref", ref, remoteTip] : ["update-ref", "-d", ref])
    throw error
  }
  return { branch: request.branch, head, opened, retry }
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
