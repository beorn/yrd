import { currentPRRev, prDeliveryState, type PR } from "@yrd/bay"
import { compareNatural } from "@yrd/core"

/** One-based positions for every live queue revision, before any renderer row budget. */
export function submittedPrPositions(prs: readonly PR[]): ReadonlyMap<string, number> {
  const ordered = prs
    .filter((pr) => {
      const delivery = prDeliveryState(pr)
      return delivery === "submitted" || delivery === "ready"
    })
    .toSorted((left, right) => {
      const leftSubmittedAt = currentPRRev(left).submittedAt ?? left.submittedAt
      const rightSubmittedAt = currentPRRev(right).submittedAt ?? right.submittedAt
      if (leftSubmittedAt === rightSubmittedAt) {
        return compareNatural(left.id, right.id)
      }
      if (leftSubmittedAt === undefined) return 1
      if (rightSubmittedAt === undefined) return -1
      return leftSubmittedAt.localeCompare(rightSubmittedAt)
    })
  return new Map(ordered.map((pr, index) => [pr.id, index + 1]))
}
