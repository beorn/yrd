/**
 * Which bucket a row is in, decided once, in a module with no renderer in it.
 *
 * This lived in `watch-list.tsx`, which imports React and silvery. That was
 * fine while the only reader was the pane — but the `--json` payload has to
 * answer the same question ("is any change under a check right now") to say
 * whether anything is polling, and `--json` deliberately loads neither React
 * nor the reconciler (the cold-graph test pins it). Two derivations of one fact
 * is how a marker and a list come to disagree, so the derivation moved here
 * rather than being copied; `watch-list.tsx` re-exports it and every existing
 * caller is unchanged.
 */

import type { Row } from "@yrd/queue-core"

/** The status filter buckets, in the order the pills show them (items 9, 32). */
export const BUCKETS = ["open", "running", "done", "failed"] as const
export type StatusBucket = (typeof BUCKETS)[number]

/** Which bucket a row is in — read off the state and the live overlay, decided nowhere else. */
export function bucketOf(row: Pick<Row, "state" | "live">): StatusBucket {
  if (row.live !== undefined) return "running"
  switch (row.state) {
    case "merged":
    case "direct":
      return "done"
    case "failed":
      return "failed"
    case "queued":
    case "checked":
    case "stuck":
      return "open"
  }
}
