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
import { mintChangeId, type BaysState, type PrNumberMint } from "@yrd/bay"
import { compareNatural } from "@yrd/core"
import { latestChangeSnapshot, maxChangeSnapshotRevision, type QueuesState } from "./model.ts"

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
 * - Reuse: the latest retained `ChangeSnapshot` for the branch keeps its id and
 *   changeId across re-pushes; the revision continues as 1 + the highest
 *   revision any retained snapshot records for that id. With no snapshot
 *   retained, the branch's refusal-ledger row anchors the same reuse (a member
 *   refused at its FIRST admission has no snapshot — without the row every
 *   refused compose burned a fresh number).
 * - Fresh: `mintChangeId` commits high-water + 1 before the id escapes, and the
 *   revision starts at 1. When queue retention has pruned a long-idle branch's
 *   runs it re-mints — number skip, never recycle.
 *
 * S7 (branch-is-change): there is no record store to consult, so every arm
 * reads run history alone. The old live-record guard ("that branch is the
 * record lane's") is gone with the lane it protected — one submit fact now has
 * exactly one possible consumer, so the "both lanes for one push" collision A4
 * forbade is not a representable state.
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
  const reusable = latestChangeSnapshot(queues, (snapshot) => snapshot.branch === branch)
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
  // A member refused at admission before ANY run retained a snapshot has one
  // other durable identity home: its refusal-ledger row (wave defect 1 made
  // the row exist; host-conv gap D is what happens without this reuse — every
  // refused compose burns a fresh number for the same branch). Same tree as
  // the refused one keeps the refused revision, so the standing admission
  // Jobs still key; a re-push continues the count above everything retained.
  const refused = Object.values(queues.admissionRefusals)
    .filter((row) => row.branch === branch)
    .toSorted((left, right) => compareNatural(left.pr, right.pr))
    .at(-1)
  if (refused !== undefined) {
    const number = changeIdNumber(refused.pr)
    if (number !== undefined && number > mint.highWater()) {
      throw new Error(
        `yrd: derived member '${refused.pr}' for branch '${branch}' exceeds the mint high-water ` +
          `${String(mint.highWater())} — an id escaped without its commit; refusing to reuse it`,
      )
    }
    const sameTree = bays.submits[branch]?.sha === refused.headSha ? refused.revision : undefined
    return {
      id: refused.pr,
      revision: sameTree ?? Math.max(refused.revision ?? 0, maxChangeSnapshotRevision(queues, refused.pr)) + 1,
      minted: false,
    }
  }
  // The durable high-water is now the mint's SOLE authority: its second
  // argument existed to let a surviving record set out-vote a lost mint file,
  // and there is no record set to out-vote with. `{}` is that absence stated,
  // not a placeholder — @yrd/bay owns the parameter and should drop it.
  const id = mintChangeId(mint, {})
  return { id, revision: 1, minted: true }
}

function changeIdNumber(id: string): number | undefined {
  const match = /^PR(\d+)$/u.exec(id)
  return match === null ? undefined : Number(match[1])
}
