/**
 * Admission-time identity for a DERIVED queue member — a branch that runs from
 * its live submit fact with no `Change` record (@i/10-merge-queue/s6-door-design
 * §2 tail, R2). This is where the S6 door RELOCATES the PR-number mint from
 * intake-time (`intakePR`/`submitWork`) to admission-time: the door's derived
 * admission path calls it; until the door lands only tests do.
 *
 * Crash-safety contract, unchanged from intake: the durable high-water is
 * committed BEFORE the id escapes (`mintChangeId` → PrNumberMint.commit), so a
 * crash between commit and use skips a number but can never re-issue one. The
 * id first escapes into the `queue/run/started` snapshot.
 */
import {
  changeRevisionNumber,
  isLiveChange,
  mintChangeId,
  hasChangeRecord,
  type BaysState,
  type Change,
  type PrNumberMint,
  recordChanges,
} from "@yrd/bay"
import { latestChangeSnapshot, maxChangeSnapshotRevision, newestTruthRecord, type QueuesState } from "./model.ts"

export type DerivedMemberIdentity = Readonly<{
  id: string
  /** Present only when the identity was reused from a retained snapshot that
   * recorded one. A freshly minted member has no changeId yet — the derived
   * admission path sources it from the commit's Change-Id trailer or its
   * synthetic submit-fact mint (changeIdForDerivedSubmit), never here: this
   * function owns the NUMBER contract only. */
  changeId?: string
  revision: number
  /** True when a fresh number was committed to the mint; false when the latest
   * retained recordless snapshot for the branch supplied the identity. */
  minted: boolean
}>

/**
 * Mint — or reuse — the identity a derived member of `branch` runs under.
 *
 * - Reuse: the latest retained `ChangeSnapshot` for the branch whose id no
 *   record carries (a recordless id can only have been minted for a derived
 *   member) keeps its id and changeId across re-pushes; the revision continues
 *   as 1 + the highest revision any retained snapshot records for that id.
 * - Fresh: `mintChangeId` commits max(high-water, frozen-store max) + 1 before
 *   the id escapes — a derived member's number is always strictly above both
 *   (A9). The revision seeds from the branch's newest terminal record when the
 *   branch had one, so a post-door revision of a pre-door branch continues its
 *   count instead of restarting at 1. When queue retention has pruned a
 *   long-idle branch's runs it re-mints — number skip, never recycle.
 *
 * A LIVE record for the branch refuses loudly: that branch is the record
 * lane's (grandfathered intake), and admitting it as a derived member would be
 * the "both lanes for one push" A4 forbids. The door's receiver dispatch
 * decides the lane at write time; this guard keeps the invariant even for a
 * caller that skipped it.
 */
export function mintDerivedMemberIdentity(
  options: Readonly<{
    mint: PrNumberMint
    bays: BaysState
    queues: QueuesState
    branch: string
  }>,
): DerivedMemberIdentity {
  const { mint, bays, queues, branch } = options
  const records = recordChanges(bays).filter((pr) => pr.branch === branch)
  const live = records.find(isLiveChange)
  if (live !== undefined) {
    throw new Error(
      `yrd: branch '${branch}' has live change '${live.id}' — the record lane owns it; ` +
        `a derived member may only be admitted for a branch with no live record`,
    )
  }
  const reusable = latestChangeSnapshot(
    queues,
    (snapshot) => snapshot.branch === branch && !hasChangeRecord(bays, snapshot.id),
  )
  if (reusable !== undefined) {
    const number = changeIdNumber(reusable.id)
    if (number !== undefined && number > mint.highWater()) {
      throw new Error(
        `yrd: derived member '${reusable.id}' for branch '${branch}' exceeds the mint high-water ` +
          `${String(mint.highWater())} — an id escaped without its commit; refusing to reuse it`,
      )
    }
    return {
      id: reusable.id,
      ...(reusable.changeId === undefined ? {} : { changeId: reusable.changeId }),
      revision: maxChangeSnapshotRevision(queues, reusable.id) + 1,
      minted: false,
    }
  }
  const id = mintChangeId(mint, bays.prs)
  const seed = newestTruthRecord(records)
  return { id, revision: (seed === undefined ? 0 : changeRevisionNumber(seed)) + 1, minted: true }
}

function changeIdNumber(id: string): number | undefined {
  const match = /^PR(\d+)$/u.exec(id)
  return match === null ? undefined : Number(match[1])
}
