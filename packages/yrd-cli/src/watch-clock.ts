/**
 * The watch's ONE clock.
 *
 * Every relative age on screen — the change's, the run's, the check's — is
 * read from this single coarse tick, fed explicitly to whatever renders it,
 * rather than each component asking `Date.now()` on its own render path. Two
 * clocks on one screen drift, and the operator sees one row age while its
 * neighbour stalls.
 */

import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"

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

/**
 * The clock as TWO contexts, so a leaf subscribes to the resolution it can
 * show and nothing else re-renders on the tick:
 *
 * - {@link NowContext} moves every second: the AGE and RUNTIME cells, the
 *   status box's clocks line and the RUNNER timer read it.
 * - {@link MinuteContext} moves once a minute and is referentially stable in
 *   between, so a consumer does not re-render on the seconds: the table's
 *   column widths, the STATS buckets and the Changes tab's `ago` clocks read
 *   it. Measured 2026-09-05 01:4x PDT on the /hh queue: with every row and box
 *   on the one-second context the pane burned 22% of a core at a 60-second
 *   poll — the tick, not the rounds.
 *
 * The pane's root provides both; a component rendered outside a provider (a
 * test of one box) reads the instant it was first asked, which is a still
 * frame, not a lie.
 */
export const NowContext = createContext<Date | undefined>(undefined)
export const MinuteContext = createContext<Date | undefined>(undefined)

const MINUTE_MS = 60_000

/** The one coarse `now` on screen, to the second; a still instant outside a provider. */
export function useNow(): Date {
  const provided = useContext(NowContext)
  const [still] = useState(() => new Date())
  return provided ?? still
}

/** `now` to the minute, stable within it, so a consumer re-renders once a minute and not on the seconds. */
export function useMinute(): Date {
  const provided = useContext(MinuteContext)
  const [still] = useState(() => floorToMinute(new Date()))
  return provided ?? still
}

function floorToMinute(at: Date): Date {
  return new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS)
}

/** Provides both clocks to a subtree: `readAt` is the instant the snapshot on screen was read. */
export function NowProvider({ readAt, live, children }: { readAt: Date; live: boolean; children: ReactNode }) {
  const now = useCoarseNow(readAt, live)
  // The minute value is a new Date only when the minute changes, so
  // MinuteContext's consumers see one identity per minute.
  const minuteMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS
  const minute = useMemo(() => new Date(minuteMs), [minuteMs])
  return createElement(
    NowContext.Provider,
    { value: now },
    createElement(MinuteContext.Provider, { value: minute }, children),
  )
}
