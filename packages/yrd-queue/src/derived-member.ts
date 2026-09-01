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
import {
  latestChangeSnapshot,
  maxChangeSnapshotRevision,
  newestTruthRecord,
  type CandidateRev,
  type QueuesState,
} from "./model.ts"

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
  // No run has ever started for this branch, so `latestChangeSnapshot` above
  // has nothing to find — but admission may already be IN FLIGHT for the
  // exact live submit fact: `admissionStep`'s first dispatch durably records
  // the Candidate it built (`queue/candidate/created`, queue.ts) before any
  // Queue run exists to retain a ChangeSnapshot. Reusing THAT identity here,
  // unchanged (same id, same revision — no bump), is what lets
  // `admissionJobKey` resolve to the SAME already-dispatched Job on the next
  // compose pass instead of abandoning it and minting a phantom sibling.
  // See {@link pendingDerivedCandidate}.
  const sha = bays.submits[branch]?.sha
  const pending = sha === undefined ? undefined : pendingDerivedCandidate(bays, queues, sha)
  if (pending !== undefined) {
    return { id: pending.id, revision: pending.revision, minted: false }
  }
  const id = mintChangeId(mint, bays.prs)
  const seed = newestTruthRecord(records)
  return { id, revision: (seed === undefined ? 0 : changeRevisionNumber(seed)) + 1, minted: true }
}

/**
 * The lowest-numbered recordless identity any retained admission Candidate
 * carries for the live submit fact at `sha` — the durable trace an admission
 * attempt leaves the MOMENT its first required-check Job is requested, well
 * before any Queue run starts (measured 2026-09-01 at yrd c576de2a: PR2919
 * minted 07:59:30, its checks still settling, then the NEXT compose pass
 * re-derived the same (branch, sha) from scratch and minted PR2920 — every
 * pass, forever, because nothing survived to tell {@link
 * mintDerivedMemberIdentity} an admission was already in flight, and
 * `admissionJobKey` (keyed on id + revision) could never resolve back to the
 * Job already dispatched under the burned number).
 *
 * Reads `queues.candidates`, which the admission path already writes
 * durably and unconditionally on its first dispatch — no new durable state,
 * no new journal event, no projection-checkpoint migration.
 *
 * Lowest id wins when more than one candidate matches (a branch whose checks
 * spanned several compose passes before this fix minted more than one
 * phantom for the same sha): the first identity issued is the one worth
 * converging on — every later mint for the same content is exactly the
 * livelock this closes, not a second legitimate attempt.
 */
function pendingDerivedCandidate(
  bays: BaysState,
  queues: QueuesState,
  sha: string,
): Readonly<{ id: string; revision: number }> | undefined {
  let best: CandidateRev | undefined
  let bestNumber = Number.POSITIVE_INFINITY
  for (const candidate of Object.values(queues.candidates)) {
    for (const rev of candidate.revs) {
      if (rev.head !== sha || hasChangeRecord(bays, rev.pr)) continue
      const number = changeIdNumber(rev.pr) ?? Number.POSITIVE_INFINITY
      if (number < bestNumber) {
        best = rev
        bestNumber = number
      }
    }
  }
  return best === undefined ? undefined : { id: best.pr, revision: best.n }
}

function changeIdNumber(id: string): number | undefined {
  const match = /^PR(\d+)$/u.exec(id)
  return match === null ? undefined : Number(match[1])
}
