/**
 * `yrd queue submit <branch>`: the one path in
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The change).
 *
 * One atomic push of the branch and of its change's opened fact. Either both
 * arrive at the remote or neither does, so a reader never sees a submitted
 * branch without its change or a change without its branch. A submit at an
 * unchanged head appends a new opened fact to the existing change: that is a
 * retry, and the change keeps its place in line from its first opened fact.
 * The branch is always pushed with a lease, because a rebased branch is the
 * ordinary case and a lease is what stops it clobbering a head the submitter
 * never saw.
 */

import { appendFact, type Git } from "./facts.ts"
import { refAt } from "./git.ts"
import { changeRef } from "./refs.ts"

export type SubmitRequest = Readonly<{
  branch: string
  target: string
  submitter: string
  workItem?: string
}>

export type Submitted = Readonly<{
  branch: string
  head: string
  /** The opened fact's sha. */
  opened: string
  /** True when the change already existed at this head, so this was a retry. */
  retry: boolean
}>

export async function submit(git: Git, remote: string, request: SubmitRequest): Promise<Submitted> {
  // The target is not a change: a change is a branch submitted to be MERGED
  // INTO the target, so submitting the target itself asks the queue to merge a
  // branch into itself. Nothing refused it before, and what it opened was a
  // change whose head the target already carried: it read merged at once, the
  // catch-up gave it a `Merged-By: hand` fact naming whatever merge landed
  // next, its submitter was told to close a bead for a merge that was not
  // theirs, and that merge stayed accounted for in the E5 walk, where an
  // accounted commit hides every hand push at or below it
  // (2026-09-03: `main@0a9db9daf7eb`, named for the queue's own merge 005a622156c7).
  if (request.branch === request.target) {
    throw new Error(
      `${request.target} is the target, not a change; a change is a branch submitted to be merged into ${request.target}`,
    )
  }
  const head = (await git(["rev-parse", "--verify", `refs/heads/${request.branch}^{commit}`])).trim()
  const ref = changeRef(request.branch, head)
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
  const workItem = await workItemOf(git, request.branch, head, request.workItem)
  const trailers: (readonly [string, string])[] = [["Submitter", request.submitter]]
  if (workItem !== undefined) trailers.push(["Work-Item", workItem])
  const opened = await appendFact(git, {
    branch: request.branch,
    head,
    kind: "opened",
    subject: `${request.submitter} submitted ${request.branch} to ${request.target}`,
    target: request.target,
    trailers,
  })
  // Two explicit leases make the push the same compare-and-swap the local
  // append is: each ref must still be where this submitter just read it (the
  // zero sha means "absent"), or the whole push refuses and nothing lands —
  // and then the local change ref goes back to what the remote holds, so a
  // refused submit leaves no opened fact for the next one to chain onto.
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
 * The work item a change is for (ruling C4): the one declared on submit, else
 * the head commit's `Resolves:` or `Refs:` trailer, else the leading
 * `<work item>-` segment of the branch name's last component, the convention
 * (§ The change). None of those, and the change has no work item.
 */
export async function workItemOf(git: Git, branch: string, head: string, declared?: string): Promise<string | undefined> {
  if (declared !== undefined) return declared
  const fromTrailer = (await git(["log", "-1", "--format=%(trailers:key=Resolves,key=Refs,valueonly,separator=%x00)", head]))
    .split("\0")
    .map((value) => value.trim())
    .find((value) => value !== "")
  if (fromTrailer !== undefined) return fromTrailer
  return /^(\d+)-/u.exec(branch.split("/").at(-1) ?? "")?.[1]
}

const ABSENT = "0".repeat(40)
