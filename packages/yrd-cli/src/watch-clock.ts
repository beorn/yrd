/**
 * The watch's ONE clock.
 *
 * Every relative age on screen — the change's, the run's, the check's — is
 * read from this single coarse tick, fed explicitly to whatever renders it,
 * rather than each component asking `Date.now()` on its own render path. Two
 * clocks on one screen drift, and the operator sees one row age while its
 * neighbour stalls.
 */

import { useEffect, useRef, useState } from "react"

/**
 * A clock that advances about once a second while the pane is live, and stands
 * still when it is not.
 *
 * `readAt` is the instant the snapshot on screen was read; between refreshes
 * this adds the real time that has passed since, so an age keeps counting
 * without the pane re-reading the queue to find out that a second went by.
 */
export function useCoarseNow(readAt: Date, live: boolean, tickMs = 1000): Date {
  const readMs = readAt.getTime()
  const capturedAt = useRef(Date.now())
  const seen = useRef(readMs)
  if (seen.current !== readMs) {
    seen.current = readMs
    capturedAt.current = Date.now()
  }
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!live) return undefined
    const id = setInterval(() => {
      forceTick((tick) => (tick + 1) % 1_000_000)
    }, tickMs)
    return () => {
      clearInterval(id)
    }
  }, [live, tickMs])
  if (!live) return readAt
  return new Date(readMs + Math.max(0, Date.now() - capturedAt.current))
}
