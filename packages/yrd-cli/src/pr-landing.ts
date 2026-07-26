import { currentPRRev, prDeliveryState, type PR } from "@yrd/bay"
import { createPruneGitFacts } from "./pr-withdraw.ts"
import type { PruneGitFacts, YrdCliIO } from "./types.ts"

/** Delivery states whose label asserts something about CONTENT: that this PR's
 * revision never reached the base branch. That is a checkable claim, so the
 * surface checks it before printing it. Every other state is a claim about
 * PROCESS (queued, checking, awaiting an author) and needs no ancestry proof. */
const NOT_LANDED_CLAIMS = new Set(["withdrawn", "canceled"])

export type PrLanding = Readonly<{
  /** The recorded delivery state the ancestry proof contradicts. */
  recorded: string
  /** Base tip the head was proven to be reachable from. */
  baseSha: string
  headSha: string
  /** Typed code for the WHY column and the JSON row. */
  code: string
}>

export type PrLandingReconciliation = Readonly<{
  landings: ReadonlyMap<string, PrLanding>
  /** Bases whose tip or ancestry could not be read. Never swallowed: the caller
   * prints them beside the result so an unverified row is never mistaken for a
   * verified one. */
  warnings: readonly string[]
}>

const EMPTY: PrLandingReconciliation = { landings: new Map(), warnings: [] }

async function landedHeads(git: PruneGitFacts, baseSha: string, heads: readonly string[]): Promise<Set<string>> {
  if (git.landedOnBase !== undefined) return new Set(await git.landedOnBase(baseSha, heads))
  const landed = new Set<string>()
  for (const head of heads) {
    if ((await git.resolveCommit(head)) === undefined) continue
    if (await git.isAncestor(head, baseSha)) landed.add(head)
  }
  return landed
}

function failureText(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message.trim() : String(error)
}

/** Prove, for every PR whose recorded state claims its content never landed,
 * whether that revision's head is already reachable from its base tip.
 *
 * The live specimen (22376): an author withdrawal arrived on top of a completed
 * merge, and `pr list` printed only the later write. An author who trusts
 * `withdrawn` re-cuts a branch already on main, and duplicate landings of the
 * same content are exactly what the ancestry model cannot clean up afterwards.
 *
 * Git is consulted only when there is such a claim to check, and at most twice
 * per distinct base regardless of how many rows the projection carries. */
export async function reconcilePrLandings(prs: readonly PR[], io: YrdCliIO): Promise<PrLandingReconciliation> {
  const candidates = prs.filter((pr) => NOT_LANDED_CLAIMS.has(prDeliveryState(pr)))
  if (candidates.length === 0) return EMPTY

  const cwd = io.cwd ?? process.cwd()
  const git = io.pruneGit === undefined ? createPruneGitFacts(cwd) : io.pruneGit(cwd)
  const byBase = new Map<string, PR[]>()
  for (const pr of candidates) {
    const grouped = byBase.get(pr.base)
    if (grouped === undefined) byBase.set(pr.base, [pr])
    else grouped.push(pr)
  }

  const landings = new Map<string, PrLanding>()
  const warnings: string[] = []
  for (const [base, members] of byBase) {
    try {
      const baseSha = (await git.resolveCommit(`origin/${base}`)) ?? (await git.resolveCommit(base))
      if (baseSha === undefined) {
        warnings.push(
          `yrd: base '${base}' did not resolve here, so ${members.length} withdrawn or canceled PR` +
            `${members.length === 1 ? "" : "s"} could not be checked against it — their state is the record, not a proof`,
        )
        continue
      }
      const heads = members.map((pr) => currentPRRev(pr).head)
      const landed = await landedHeads(git, baseSha, heads)
      for (const pr of members) {
        const headSha = currentPRRev(pr).head
        if (!landed.has(headSha)) continue
        const recorded = prDeliveryState(pr)
        landings.set(pr.id, { recorded, baseSha, headSha, code: `${recorded}-after-landing` })
      }
    } catch (error) {
      warnings.push(`yrd: could not check base '${base}' for already-landed content: ${failureText(error)}`)
    }
  }
  return { landings, warnings }
}
