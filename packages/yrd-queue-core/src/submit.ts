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
  const head = (await git(["rev-parse", "--verify", `refs/heads/${request.branch}^{commit}`])).trim()
  const ref = changeRef(request.branch, head)
  // A retry appends to the remote's history of this change, so that history is
  // read first. ls-remote answers "absent" as an empty list, never as an error,
  // which is the one honest empty a submit is allowed to swallow.
  const remoteTip = (await git(["ls-remote", "--refs", remote, ref])).trim().split(/\s+/u)[0] ?? ""
  const retry = remoteTip !== ""
  if (retry) await git(["fetch", "--quiet", remote, `+${ref}:${ref}`])
  // What the submitter believes the remote holds for the branch: its tracking
  // ref when it has fetched, else nothing at all, so a name somebody else is
  // already using refuses loudly instead of being overwritten.
  const tracked = await refAt(git, `refs/remotes/${remote}/${request.branch}`)
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
  // append is: each ref must still be where this submitter last read it (the
  // zero sha means "absent"), or the whole push refuses and nothing lands.
  await git([
    "push",
    "--quiet",
    "--atomic",
    `--force-with-lease=refs/heads/${request.branch}:${tracked ?? ABSENT}`,
    `--force-with-lease=${ref}:${retry ? remoteTip : ABSENT}`,
    remote,
    `refs/heads/${request.branch}:refs/heads/${request.branch}`,
    `${ref}:${ref}`,
  ])
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
