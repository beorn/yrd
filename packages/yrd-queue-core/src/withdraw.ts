/**
 * The operator's own ending: `yrd queue withdraw <branch>` takes one change
 * out of the line by appending a `withdrawn` record to its chain — an ending
 * like merged or failed (records.ts ENDING_KINDS), so every reader drops the
 * change from its working sets while the history stays whole. The branch
 * itself is untouched: withdrawing is not deleting, and a later `yrd submit`
 * of the same branch re-opens the chain through the ordinary retry path — a
 * later opened record re-opens an ended chain (@i/10-yrd/24635).
 *
 * This verb exists because a stuck head of line had no way out except a
 * replacement only its own submitter could push (@i/10-yrd/24492): the
 * operator who owns the queue had no verb at all. The other escape stands,
 * and the stuck record names both — replace the branch with a head that
 * clears the reason; the same content sticks on the same ground.
 *
 * The write mirrors `submit` and `writeRecord`: read the remote fresh, write
 * the record object onto the tip that read saw, push under a lease for that
 * same tip. A racing queue run loses loudly; one retry re-reads the winner's
 * tip and re-checks the ending before appending again (records.ts).
 */

import { refAt } from "./git.ts"
import { endedKind, endingRecord, readRecords, recordCommit, type Git, type WriteRecord } from "./records.ts"
import { parseChangeRef, queueRefPrefix, type Change } from "./refs.ts"

export type WithdrawRequest = Readonly<{
  /** The branch whose change leaves the line. */
  branch: string
  target: Readonly<{ remote: string; branch: string }>
  /** Who withdrew it, written as the record's `By:`. */
  by: string
  /** Why, written as the record's `Reason:` and into its subject. */
  reason?: string
}>

export type WithdrawnChange = Readonly<{
  branch: string
  head: string
  /** The withdrawn record's sha — the id of the ending this call wrote. */
  record: string
}>

export type Withdrawn = Readonly<{
  branch: string
  queue: string
  /** Every change of the branch this call ended, in the order the remote listed them. */
  withdrawn: readonly WithdrawnChange[]
}>

/** A withdraw that found nothing to end: no change at all, or every chain already ended. */
export class NothingToWithdraw extends Error {}

export async function withdraw(git: Git, remote: string, request: WithdrawRequest): Promise<Withdrawn> {
  const queue = request.target.branch
  const prefix = queueRefPrefix(queue)
  const listed = (await git(["ls-remote", "--refs", remote, `${prefix}/${request.branch}@*`]))
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row !== "")
    .map((row) => row.split(/\s+/u))
  if (listed.length === 0) {
    throw new NothingToWithdraw(
      `no change for ${request.branch} on ${queue}: nothing to withdraw` +
        ` (looked for ${prefix}/${request.branch}@* at ${remote}; yrd list shows the line)`,
    )
  }
  const withdrawn: WithdrawnChange[] = []
  const alreadyEnded: string[] = []
  for (const [tip, ref] of listed) {
    if (tip === undefined || ref === undefined) continue
    const change = parseChangeRef(queue, ref)
    if (change === undefined) {
      throw new Error(`${ref} matched ${request.branch}'s changes on ${queue} but is not a change ref`)
    }
    const one = await withdrawOne(git, remote, queue, ref, change, request)
    if ("record" in one) withdrawn.push({ branch: change.branch, head: change.head, record: one.record })
    else alreadyEnded.push(one.ended)
  }
  if (withdrawn.length === 0) {
    throw new NothingToWithdraw(`${request.branch} on ${queue}: ${alreadyEnded.join("; ")}; nothing to withdraw`)
  }
  return { branch: request.branch, queue, withdrawn }
}

/**
 * End one change ref, or report the ending it already stands on. The fetch
 * before every read keeps the judgement on the remote's truth, never a stale
 * local mirror; the lease keeps the push honest about it.
 */
async function withdrawOne(
  git: Git,
  remote: string,
  queue: string,
  ref: string,
  change: Change,
  request: WithdrawRequest,
): Promise<Readonly<{ record: string }> | Readonly<{ ended: string }>> {
  await git(["fetch", "--quiet", remote, `+${ref}:${ref}`])
  let onto = await refAt(git, ref)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (onto === undefined) throw new Error(`${ref} vanished from ${remote} between the listing and the read`)
    const stands = endingRecord(await readRecords(git, onto))
    if (stands !== undefined) {
      return {
        ended:
          `${change.head.slice(0, 12)} already ended ${endedKind(stands)}` +
          ` at ${stands.sha.slice(0, 12)} and only a new submit re-opens it`,
      }
    }
    const subject = `${request.by} withdrew ${change.branch} from ${queue}${
      request.reason === undefined ? "" : `: ${request.reason}`
    }`
      .replace(/\s+/gu, " ")
      .trim()
    const write: WriteRecord = {
      change,
      kind: "withdrawn",
      subject,
      trailers: [["By", request.by], ...(request.reason === undefined ? [] : ([["Reason", request.reason]] as const))],
    }
    const record = await recordCommit(git, write, onto)
    try {
      await git(["push", "--quiet", `--force-with-lease=${ref}:${onto}`, remote, `${record}:${ref}`])
      await git(["update-ref", ref, record])
      return { record }
    } catch (error) {
      // The remote moved between the read and the push: take the winner's tip
      // and judge again — it may have ended the change itself.
      await git(["fetch", "--quiet", remote, `+${ref}:${ref}`])
      const moved = await refAt(git, ref)
      if (attempt === 1 || moved === undefined || moved === onto) throw error
      onto = moved
    }
  }
  throw new Error(`unreachable: withdraw retry loop for ${ref} exited without a verdict`)
}
