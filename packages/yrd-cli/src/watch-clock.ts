/**
 * The watch's ONE clock.
 *
 * Every relative age on screen — the change's, the run's, the check's — is
 * read from this single coarse tick, fed explicitly to whatever renders it,
 * rather than each component asking `Date.now()` on its own render path. Two
 * clocks on one screen drift, and the operator sees one row age while its
 * neighbour stalls.
 *
 * **The tick is also where the process's memory is kept bounded.** React's
 * dev build fires `performance.mark()`/`measure()` several hundred times a
 * second and never clears them, and a four-hour soak of the retired watch
 * measured RSS going from 1,775.8 MB to 14,918.0 MB — 59 MB/min, OLS r² 0.990
 * (`watch-rss-bounded`, closed 2026-08-30 at yrd f42e8022). One interval, one
 * clearing, both ends of the timeline: clearing only marks or only measures
 * leaves half the noise accumulating.
 */

import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from "react"

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
      // Bound the dev-build performance timeline BEFORE it grows again this
      // tick. Both ends, every tick — see the note above.
      performance.clearMeasures()
      performance.clearMarks()
      forceTick((tick) => (tick + 1) % 1_000_000)
    }, tickMs)
    return () => {
      clearInterval(id)
    }
  }, [live, tickMs])
  if (!live) return readAt
  return new Date(readMs + Math.max(0, Date.now() - capturedAt.current))
}

/**
 * The clock as a context, so the leaves that format a relative time (a
 * RUNTIME cell, the clocks line, the runner's border timer) subscribe to the
 * tick and nothing else re-renders on it. The pane's root provides it; a
 * component rendered outside a provider (a test of one box) reads the instant
 * it was first asked, which is a still frame, not a lie.
 */
export const NowContext = createContext<Date | undefined>(undefined)

/** The one coarse `now` on screen; a still instant outside a provider. */
export function useNow(): Date {
  const provided = useContext(NowContext)
  const [still] = useState(() => new Date())
  return provided ?? still
}

/** Provides the coarse clock to a subtree: `readAt` is the instant the snapshot on screen was read. */
export function NowProvider({ readAt, live, children }: { readAt: Date; live: boolean; children: ReactNode }) {
  const now = useCoarseNow(readAt, live)
  return createElement(NowContext.Provider, { value: now }, children)
}
