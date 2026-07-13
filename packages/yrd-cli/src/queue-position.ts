import type { PR } from "@yrd/bay"

/** One-based positions for every submitted PR, before any renderer row budget. */
export function submittedPrPositions(prs: readonly PR[]): ReadonlyMap<string, number> {
  const ordered = prs
    .filter((pr) => pr.status === "submitted")
    .toSorted((left, right) => {
      if (left.submittedAt === right.submittedAt) {
        return left.id.localeCompare(right.id, undefined, { numeric: true })
      }
      if (left.submittedAt === undefined) return 1
      if (right.submittedAt === undefined) return -1
      return left.submittedAt.localeCompare(right.submittedAt)
    })
  return new Map(ordered.map((pr, index) => [pr.id, index + 1]))
}
