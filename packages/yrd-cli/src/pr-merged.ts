import { createPruneGitFacts } from "./pr-withdraw.ts"
import type { PruneGitFacts, YrdCliIO } from "./types.ts"

export type ChangeMerge = Readonly<{
  /** answers: Which projected status did repository proof contradict? tense: historical. */
  recorded: string
  /** Base tip the head was proven to be reachable from. */
  baseSha: string
  headSha: string
  /** answers: Why did repository proof override nativeStatus? tense: current. */
  code: string
}>

export type ChangeMergeReconciliation = Readonly<{
  merges: ReadonlyMap<string, ChangeMerge>
  /** Bases whose tip or ancestry could not be read. Never swallowed: the caller
   * prints them beside the result so an unverified row is never mistaken for a
   * verified one. */
  warnings: readonly string[]
}>

const EMPTY: ChangeMergeReconciliation = { merges: new Map(), warnings: [] }

async function mergedHeads(git: PruneGitFacts, baseSha: string, heads: readonly string[]): Promise<Set<string>> {
  if (git.mergedOnBase !== undefined) return new Set(await git.mergedOnBase(baseSha, heads))
  const merged = new Set<string>()
  for (const head of heads) {
    if ((await git.resolveCommit(head)) === undefined) continue
    if (await git.isAncestor(head, baseSha)) merged.add(head)
  }
  return merged
}

function failureText(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message.trim() : String(error)
}

/** One delivery whose projected label asserts something about CONTENT: that its
 * head never reached the base branch. That is a checkable claim, so the surface
 * checks it before printing it. A label about PROCESS (queued, checking,
 * awaiting an author) needs no ancestry proof and is never passed here. */
export type DeliveryMergeClaim = Readonly<{ id: string; base: string; headSha: string; recorded: string }>

/** Prove, for every delivery whose projected label claims its content never
 * merged, whether that head is already reachable from its base tip.
 *
 * The live specimen (22376): an author withdrawal arrived on top of a completed
 * merge, and `pr list` printed only the later write. An author who trusts a
 * not-landed label re-cuts a branch already on main, and duplicate merges of
 * the same content are exactly what the ancestry model cannot clean up
 * afterwards. S7 moved the claim's SOURCE from a change record's delivery state
 * to a retained run member with no integrating run; the check is unchanged
 * because the question it answers never depended on the record.
 *
 * Git is consulted only when there is such a claim to check, and at most twice
 * per distinct base regardless of how many rows the projection carries. */
export async function reconcileDeliveryMerges(
  claims: readonly DeliveryMergeClaim[],
  io: YrdCliIO,
): Promise<ChangeMergeReconciliation> {
  if (claims.length === 0) return EMPTY

  const cwd = io.cwd ?? process.cwd()
  const git = io.pruneGit === undefined ? createPruneGitFacts(cwd) : io.pruneGit(cwd)
  const byBase = new Map<string, DeliveryMergeClaim[]>()
  for (const claim of claims) {
    const grouped = byBase.get(claim.base)
    if (grouped === undefined) byBase.set(claim.base, [claim])
    else grouped.push(claim)
  }

  const merges = new Map<string, ChangeMerge>()
  const warnings: string[] = []
  for (const [base, members] of byBase) {
    try {
      const baseSha = (await git.resolveCommit(`origin/${base}`)) ?? (await git.resolveCommit(base))
      if (baseSha === undefined) {
        warnings.push(
          `yrd: base '${base}' did not resolve here, so ${members.length} delivery` +
            `${members.length === 1 ? "" : "s"} labelled not-landed could not be checked against it — ` +
            `their label is a projection, not a proof`,
        )
        continue
      }
      const merged = await mergedHeads(
        git,
        baseSha,
        members.map((claim) => claim.headSha),
      )
      for (const claim of members) {
        if (!merged.has(claim.headSha)) continue
        merges.set(claim.id, {
          recorded: claim.recorded,
          baseSha,
          headSha: claim.headSha,
          code: `${claim.recorded}-after-landing`,
        })
      }
    } catch (error) {
      warnings.push(`yrd: could not check base '${base}' for already-merged content: ${failureText(error)}`)
    }
  }
  return { merges, warnings }
}
