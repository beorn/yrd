import { prDeliveryState, type PR } from "@yrd/bay"

/** One-based row indices inside an already ordered queue timeline projection.
 * These are presentation indices, never the Queue's admission positions. */
export function queueTimelineIndices(prs: readonly PR[]): ReadonlyMap<string, number> {
  const visible = prs.filter((pr) => {
    const delivery = prDeliveryState(pr)
    return delivery === "submitted" || delivery === "ready"
  })
  return new Map(visible.map((pr, index) => [pr.id, index + 1]))
}
