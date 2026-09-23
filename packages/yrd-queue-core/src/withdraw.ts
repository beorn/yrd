/**
 * The operator's own ending: `yrd queue withdraw <branch>` takes one change
 * out of the line by appending a `withdrawn` record to its chain — an ending
 * like merged or failed (legacy-records.ts ENDING_KINDS), so every reader drops the
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
 * tip and re-checks the ending before appending again (legacy-records.ts).
 */

import type { Git } from "./git.ts"
import {
  endedKind,
  endingRecord,
  legacyStore,
  recordCommit,
  recordsFromHistory,
  type LegacyStore,
  type WriteRecord,
} from "./legacy-records.ts"
import { parseChangeRef, queueRefPrefix, type Change } from "./refs.ts"

export type WithdrawRequest = Readonly<{
  /** The branch whose change leaves the line. */
  branch: string
  target: Readonly<{ remote: string; branch: string }>
  /** Who withdrew it, written as the record's `By:`. */
  by: string
  /**
   * Why, in the operator's words: written into the subject and as a `Note:`
   * trailer. Never `Reason:` — that trailer is the vocabulary the reader and
   * the run branch on (replaced, deleted, a check's code), and free text is
   * content nobody branches on.
   */
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
  const branchRef = `refs/heads/${request.branch}`
  const store = await legacyStore(git)
  const [remoteQueue, remoteBranch] = await Promise.all([
    store.backend.fetchRefs(store.repo, prefix, remote),
    store.backend.listRefs(store.repo, branchRef, remote),
  ])
  // Where the branch points now. withdrawOne judges it after the records, so
  // a recorded ending is reported as what it is and only an open head the
  // branch still carries is ended.
  const branchHead = remoteBranch.get(branchRef)
  const changePrefix = `${prefix}/${request.branch}@`
  const listed = [...remoteQueue].filter(([ref]) => ref.startsWith(changePrefix))
  if (listed.length === 0) {
    throw new NothingToWithdraw(
      `no change for ${request.branch} on ${queue}: nothing to withdraw` +
        ` (looked for ${prefix}/${request.branch}@* at ${remote}; yrd list shows the line)`,
    )
  }
  const withdrawn: WithdrawnChange[] = []
  const alreadyEnded: string[] = []
  for (const [ref, tip] of listed) {
    const change = parseChangeRef(queue, ref)
    if (change === undefined) {
      throw new Error(`${ref} matched ${request.branch}'s changes on ${queue} but is not a change ref`)
    }
    const one = await withdrawOne(git, store, remote, queue, prefix, ref, tip, change, branchHead, request)
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
 * local mirror; the lease keeps the push honest about it. Records are read
 * FIRST and the branch second, in the reader's own order (state.ts): a
 * recorded ending is what the change is, and only a chain with no record is
 * judged by where its branch points.
 */
async function withdrawOne(
  git: Git,
  store: LegacyStore,
  remote: string,
  queue: string,
  prefix: string,
  ref: string,
  initialTip: string,
  change: Change,
  branchHead: string | undefined,
  request: WithdrawRequest,
): Promise<Readonly<{ record: string }> | Readonly<{ ended: string }>> {
  let onto: string | undefined = initialTip
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (onto === undefined) throw new Error(`${ref} vanished from ${remote} between the listing and the read`)
    const history = await store.backend.readHistory(store.repo, [onto])
    const stands = endingRecord(await recordsFromHistory(git, history, onto))
    if (stands !== undefined) {
      return {
        ended:
          `${change.head.slice(0, 12)} already ended ${endedKind(stands)}` +
          ` at ${stands.sha.slice(0, 12)} and only a new submit re-opens it`,
      }
    }
    // No record: the branch decides, in the reader's own order (state.ts) —
    // a head the branch no longer carries already reads withdrawn by
    // derivation, and the next run records that itself.
    if (branchHead === undefined) {
      return { ended: `${change.head.slice(0, 12)} already ended withdrawn (deleted): the branch is gone` }
    }
    if (branchHead !== change.head) {
      return {
        ended: `${change.head.slice(0, 12)} already ended withdrawn (replaced): the branch moved on to ${branchHead.slice(0, 12)}`,
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
      trailers: [["By", request.by], ...(request.reason === undefined ? [] : ([["Note", request.reason]] as const))],
    }
    const record = await recordCommit(git, write, onto)
    try {
      await store.backend.publish(store.repo, [{ ref, expect: onto, oid: record }], remote)
      return { record }
    } catch (error) {
      // The remote moved between the read and the push: take the winner's tip
      // and judge again — it may have ended the change itself.
      const moved = (await store.backend.fetchRefs(store.repo, prefix, remote)).get(ref)
      if (attempt === 1 || moved === undefined || moved === onto) throw error
      onto = moved
    }
  }
  throw new Error(`unreachable: withdraw retry loop for ${ref} exited without a verdict`)
}
