/**
 * The override ring: a merge judged under one override table lands only while
 * that table still stands (@i/10-yrd/25296, @cto e2642976).
 *
 * `override.ts` is the record ref; this is its linearization. The round's
 * snapshot (read by the caller, after any expiry was written) says which merge
 * checks were held off. The merge's atomic push carries a FENCE: a commit that
 * advances the override ref to the same table, leased at the snapshot, in the
 * same transaction as the target. A no-op lease would not do: git sends no
 * update for an up-to-date ref, so the server never checks it and a write that
 * lands after the advertisement would slip past (measured,
 * /hh/var/@dev3/25296/probe-noop-lease-server.log). An advanced ref is checked
 * by the server inside the transaction, so a set, clear or replace written
 * during the round refuses the whole push: main does not move, the change stays
 * checked, and the next round judges it under the new table.
 *
 * Each fence commit names the merge it rode with, so the override chain is also
 * the audit of which table every merge was made against. A round with no
 * snapshot (a caller that read no override ref) fences nothing.
 */

import { overrideFence, readOverrides } from "./override.ts"
import { mergedBy } from "./records.ts"
import { changeName, overrideRef } from "./refs.ts"
import { QueueAuthorityUnreadable, type Ring } from "./run.ts"

export const withOverride: Ring = (steps) => ({
  ...steps,
  push: async (run, entry, plan) => {
    const snapshot = run.options.overrides
    if (snapshot === undefined) return steps.push(run, entry, plan)
    const { remote, branch } = run.options.target
    const ref = overrideRef(branch)
    const fence = await overrideFence(
      run.git,
      snapshot,
      mergedBy(run.name, run.log.id),
      `merge fence: ${changeName(entry.change)} in round ${run.log.id}`,
    )
    const pushed = await steps.push(run, entry, {
      leases: [...plan.leases, [ref, fence.expected]],
      updates: [...plan.updates, [fence.sha, ref]],
    })
    if (pushed.merged || pushed.reason !== undefined) return pushed
    // The remote, never Git's prose, says whether the table moved: a rival
    // write refused the transaction, and the change keeps its place.
    let now
    try {
      now = await readOverrides(run.git, remote, branch)
    } catch (error) {
      throw new QueueAuthorityUnreadable(`${remote} ${ref}`, error)
    }
    if (now.sha === snapshot.sha) return pushed
    return { error: pushed.error, merged: false, reason: "override-moved", saw: now.sha ?? "absent" }
  },
})
