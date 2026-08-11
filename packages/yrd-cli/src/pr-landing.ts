import { currentPRRev, prDeliveryState, type PR } from "@yrd/bay"
import type { DeepReadonly } from "@yrd/core"
import type { YrdCliIO, YrdCliServices } from "./types.ts"

/** Delivery states whose label asserts something about CONTENT: that this PR's
 * revision never reached the base branch. That is a checkable claim, so the
 * surface checks it before printing it. Every other state is a claim about
 * PROCESS (queued, checking, awaiting an author) and needs no ancestry proof. */
const NOT_LANDED_CLAIMS = new Set(["withdrawn", "canceled"])

export type PrLanding =
  | Readonly<{
      verdict: "proven"
      /** The recorded delivery state the repository receipt confirms or contradicts. */
      recorded: string
      /** Queue landing commit proven by the managed repository receipt. */
      baseSha: string
      landingSha: string
      landedAt?: string
      receipt: Readonly<{ ref: string; target: string; note: string; checksum: string }>
      /** Typed code for the WHY column and the JSON row. */
      code: string
    }>
  | Readonly<{
      verdict: "index-corrupt" | "landing-unknown" | "legacy-tombstone"
      recorded: string
      code: string
      reason: string
    }>

export type PrLandingReconciliation = Readonly<{
  landings: ReadonlyMap<string, PrLanding>
  /** Bases whose tip or ancestry could not be read. Never swallowed: the caller
   * prints them beside the result so an unverified row is never mistaken for a
   * verified one. */
  warnings: readonly string[]
}>

const EMPTY: PrLandingReconciliation = { landings: new Map(), warnings: [] }

function failureText(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message.trim() : String(error)
}

/** Prove, for every PR whose recorded state claims its content never landed,
 * whether Queue's managed repository receipt proves a physical landing.
 *
 * The live specimen (22376): an author withdrawal arrived on top of a completed
 * merge, and `pr list` printed only the later write. An author who trusts
 * `withdrawn` re-cuts a branch already on main, and duplicate landings of the
 * same content are exactly what the ancestry model cannot clean up afterwards.
 *
 * A direct push, matching subject, branch name, authored-head ancestry, or
 * forged Change-Id trailer is deliberately insufficient. The repository
 * receipt reader validates the note, generated commit, Change-Id, and landing
 * ancestry as one proof before this projection can override recorded state. */
export async function reconcilePrLandings(
  prs: readonly DeepReadonly<PR>[],
  services: Pick<YrdCliServices, "landingReceipts">,
  _io: YrdCliIO,
): Promise<PrLandingReconciliation> {
  const candidates = prs.filter(
    (pr) => NOT_LANDED_CLAIMS.has(prDeliveryState(pr)) || prDeliveryState(pr) === "integrated",
  )
  if (candidates.length === 0) return EMPTY

  const landings = new Map<string, PrLanding>()
  const warnings: string[] = []
  if (services.landingReceipts === undefined) {
    for (const pr of candidates) {
      if (prDeliveryState(pr) !== "integrated") continue
      landings.set(pr.id, {
        verdict: "landing-unknown",
        recorded: "integrated",
        code: "landing-proof-unavailable",
        reason: "repository landing receipts are unavailable",
      })
    }
    return {
      landings,
      warnings: [
        `yrd: repository landing receipts are unavailable, so ${candidates.length} landed-state claim` +
          `${candidates.length === 1 ? "" : "s"} could not be checked`,
      ],
    }
  }
  for (const pr of candidates) {
    const revision = currentPRRev(pr)
    try {
      const proof = await services.landingReceipts.find({
        pr: pr.id,
        revision: revision.n,
        headSha: revision.head,
        ...(revision.changeId === undefined ? {} : { changeId: revision.changeId }),
      })
      const recorded = prDeliveryState(pr)
      if (proof.status === "not-proven") {
        if (recorded === "integrated") {
          landings.set(pr.id, {
            verdict: "index-corrupt",
            recorded,
            code: "landing-index-corrupt",
            reason: proof.reason,
          })
        }
        continue
      }
      if (proof.status === "legacy-proven" && proof.fact.coverage === "tombstone") {
        if (recorded === "integrated") {
          landings.set(pr.id, {
            verdict: "legacy-tombstone",
            recorded,
            code: "landing-legacy-tombstone",
            reason: "the legacy journal row has an explicit tombstone, not physical repository proof",
          })
        }
        continue
      }
      if (
        recorded === "integrated" &&
        (pr.integration === undefined ||
          pr.integration.commit !== proof.fact.commit ||
          pr.integration.receipt?.note !== proof.fact.receipt.note ||
          pr.integration.receipt.checksum !== proof.fact.receipt.checksum)
      ) {
        landings.set(pr.id, {
          verdict: "index-corrupt",
          recorded,
          code: "landing-index-disagrees",
          reason: "the journal landing row disagrees with the managed repository receipt",
        })
        continue
      }
      landings.set(pr.id, {
        verdict: "proven",
        recorded,
        baseSha: proof.fact.baseSha,
        landingSha: proof.fact.landingSha,
        ...(proof.status === "proven" ? { landedAt: proof.fact.landedAt } : {}),
        receipt: proof.fact.receipt,
        code: recorded === "integrated" ? "repository-landing-proven" : `${recorded}-after-landing`,
      })
    } catch (error) {
      const reason = failureText(error)
      if (prDeliveryState(pr) === "integrated") {
        landings.set(pr.id, {
          verdict: "landing-unknown",
          recorded: "integrated",
          code: "landing-proof-unknown",
          reason,
        })
      }
      warnings.push(`yrd: could not verify repository landing receipt for '${pr.id}': ${reason}`)
    }
  }
  return { landings, warnings }
}
