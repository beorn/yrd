import { currentPRRev, prDeliveryState, type PR } from "@yrd/bay"

/** One-based positions for every submitted PR, before any renderer row budget. */
export function submittedPrPositions(prs: readonly PR[]): ReadonlyMap<string, number> {
  const ordered = prs
    .filter((pr) => prDeliveryState(pr) === "submitted")
    .toSorted((left, right) => {
      const leftSubmittedAt = currentPRRev(left).submittedAt ?? left.submittedAt
      const rightSubmittedAt = currentPRRev(right).submittedAt ?? right.submittedAt
      if (leftSubmittedAt === rightSubmittedAt) {
        return left.id.localeCompare(right.id, undefined, { numeric: true })
      }
      if (leftSubmittedAt === undefined) return 1
      if (rightSubmittedAt === undefined) return -1
      return leftSubmittedAt.localeCompare(rightSubmittedAt)
    })
  return new Map(ordered.map((pr, index) => [pr.id, index + 1]))
}
