/**
 * @failure  #38182: a reader that stays up and takes only the new journal lines must answer exactly what a fresh
 *           whole read answers, and it must expire records with no new lines at all — a delta's rows can never say
 *           that an owner has gone quiet, so a fold that only adds would leave every issue "in progress" forever.
 * @level    l1 (pure fold; no Git, no provider, no clock)
 * @testonly none
 * @consumer Hightea's km-source page reader · `yrd issues list-page --progress` · every activity-window answer
 */
import { describe, expect, test } from "vitest"
import {
  EMPTY_ACTIVITY,
  OWNER_ACTIVITY_WINDOW_MS,
  activeViews,
  applyActivity,
  type IssuesActivityEvent,
} from "../src/issues/in-progress.ts"

const NOW = Date.UTC(2026, 10, 25, 6, 0, 0)
const event = (path: string, actor: string, ageMs: number): IssuesActivityEvent => ({ path, actor, ts: NOW - ageMs })
const LINES: readonly IssuesActivityEvent[] = [
  event("@i/a/38001-one.md", "@dev/3", 3_000_000),
  event("@i/a/38002-two.md", "@dev/4", 60_000),
  event("@i/a/38001-one.md", "@dev/3", 1_000),
  event("@i/a/38002-two.md", "@dev/5", 900_000),
]

const asMap = (state: ReturnType<typeof applyActivity>) => new Map([...state.latest].sort(([a], [b]) => a.localeCompare(b)))

describe("applyActivity: the activity window as a fold over journal lines (#38182)", () => {
  test("splitting the same lines at any boundary answers the same state as one fold", () => {
    const whole = asMap(applyActivity(EMPTY_ACTIVITY, LINES, NOW))
    const half = asMap(applyActivity(applyActivity(EMPTY_ACTIVITY, LINES.slice(0, 2), NOW), LINES.slice(2), NOW))
    expect(half).toEqual(whole)
    let one = EMPTY_ACTIVITY
    for (const line of LINES) one = applyActivity(one, [line], NOW)
    expect(asMap(one)).toEqual(whole)
  })

  test("an empty batch still drops what the clock took out of the window", () => {
    const held = applyActivity(EMPTY_ACTIVITY, LINES, NOW)
    expect(activeViews(held, NOW).size).toBeGreaterThan(0)
    const later = applyActivity(held, [], NOW + OWNER_ACTIVITY_WINDOW_MS)
    expect(later.latest.size).toBe(0)
    expect(activeViews(later, NOW + OWNER_ACTIVITY_WINDOW_MS).size).toBe(0)
  })

  test("a record exactly at the window edge is out, and a stale line never lowers what is held", () => {
    const atEdge = applyActivity(EMPTY_ACTIVITY, [event("@i/a/38003-three.md", "@dev/6", OWNER_ACTIVITY_WINDOW_MS)], NOW)
    expect(atEdge.latest.size).toBe(0)
    const held = applyActivity(EMPTY_ACTIVITY, [event("@i/a/38003-three.md", "@dev/6", 1_000)], NOW)
    const stale = applyActivity(held, [event("@i/a/38003-three.md", "@dev/6", 5_000)], NOW)
    expect(asMap(stale)).toEqual(asMap(held))
  })

  test("the same bead under two paths folds to one identity, as the columns join it", () => {
    const moved = applyActivity(
      EMPTY_ACTIVITY,
      [event("@i/a/38003-three.md", "@dev/6", 9_000), event("@i/b/38003-three.md", "@dev/6", 1_000)],
      NOW,
    )
    expect(moved.latest.size).toBe(1)
    expect(activeViews(moved, NOW).size).toBe(1)
  })
})
