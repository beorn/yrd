/**
 * How long the service waits between rounds.
 *
 * @failure  the interval is spent between two READY merges as well as on an
 *           empty line, so a change queued behind another waits the whole idle
 *           cadence for nothing on top of the check that judged it
 * @level    l1 (the decision alone; the loop that calls it is queue-core-up)
 * @consumer hab, which declares `yrd queue up --interval 20`
 *
 * Measured on hh-dev 2026-09-10: the service ran at `--interval 120`, ends its
 * round on its first merge, and then slept two minutes before looking at the
 * change already checked and waiting behind it.
 */

import { describe, expect, it } from "vitest"
import type { QueueRunOutcome } from "@yrd/queue-core"
import { READY_SLEEP_MS, sleepAfter } from "../src/queue-core-commands.ts"

/** A round's outcome, with only the two fields this decision reads. */
const round = (merged: readonly string[], checkedWaiting: number): QueueRunOutcome =>
  ({ checkedWaiting, merged }) as unknown as QueueRunOutcome

describe("the sleep after one service round", () => {
  it("is the whole interval when the line is empty, which is what the interval is for", () => {
    expect(sleepAfter(round([], 0), 20_000)).toBe(20_000)
  })

  it("is short after a merge, because a round that merged may have more to merge", () => {
    expect(sleepAfter(round(["task/one"], 0), 20_000)).toBe(READY_SLEEP_MS)
  })

  it("is short while checked changes wait, because the next round is what acts on them", () => {
    expect(sleepAfter(round([], 3), 20_000)).toBe(READY_SLEEP_MS)
    expect(sleepAfter(round(["task/one"], 3), 20_000)).toBe(READY_SLEEP_MS)
  })

  it("never exceeds the interval, so a short interval stays a short interval", () => {
    expect(sleepAfter(round(["task/one"], 1), 100)).toBe(100)
    expect(sleepAfter(round([], 0), 100)).toBe(100)
    // Zero is what the tests of the loop itself pass: ready or idle, it waits.
    expect(sleepAfter(round(["task/one"], 1), 0)).toBe(0)
  })

  it("is not a hot loop: a round with work still waiting sleeps a real amount", () => {
    expect(READY_SLEEP_MS).toBeGreaterThan(0)
  })
})
