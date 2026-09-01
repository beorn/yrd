/**
 * @failure Three distinct habitant lifecycle conditions — a signal-forced
 *          interruption, a poisoned-observer self-restart, and a recycle onto
 *          moved source — all exited with code 3, each constant assigned to the
 *          one above it. The supervisor's restart policy is a pure function of
 *          the exit code, so it could not pace one condition and not another;
 *          the live runner's supervision log carried 142 `code=3` exits, none of
 *          them separable after the fact.
 * @level   l1
 * @consumer @yrd/cli habitant runner · Hab `decideSupervisedRestart`
 *
 * The taxonomy's own regression. Every assertion here would have failed on the
 * constants this replaces — that is the point: the defect was three names for
 * one number, and nothing asserted they were three numbers.
 */
import { describe, expect, it } from "vitest"
import {
  HABITANT_BACKOFF_EXIT_CODES,
  HABITANT_EXIT,
  HABITANT_EXIT_DISPOSITION,
  HABITANT_STAND_DOWN_EXIT_CODES,
  habitantExitCondition,
  type HabitantExitCondition,
} from "../src/habitant-exit.ts"

const CONDITIONS = Object.keys(HABITANT_EXIT) as HabitantExitCondition[]

describe("habitant exit taxonomy — one code per condition", () => {
  it("gives every condition a DISTINCT code", () => {
    const codes = CONDITIONS.map((condition) => HABITANT_EXIT[condition])
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.length).toBe(6)
  })

  it("names the six conditions the supervisor has to tell apart", () => {
    expect(CONDITIONS.toSorted()).toEqual([
      "installed-plan-stale",
      "interrupted",
      "memory-cap",
      "poisoned",
      "queue-wedged",
      "source-stale",
    ])
  })

  it("leaves `interrupted` on 3 — the contract every non-habitant caller already speaks", () => {
    expect(HABITANT_EXIT.interrupted).toBe(3)
  })

  it("keeps the new codes clear of the generic verb alphabet (0/1/2/3)", () => {
    for (const condition of CONDITIONS) {
      if (condition === "interrupted") continue
      expect(HABITANT_EXIT[condition]).toBeGreaterThan(3)
    }
  })
})

describe("habitant exit taxonomy — what the supervisor does about each", () => {
  it("dispositions every condition, so none reaches a policy undeclared", () => {
    for (const condition of CONDITIONS) {
      expect(HABITANT_EXIT_DISPOSITION[condition]).toMatch(/^(restart-(immediately|with-backoff)|stand-down)$/u)
    }
  })

  it("paces ONLY the condition a fresh process does not itself cure", () => {
    // Poisoned observation, stale source, and a stale installed plan are all
    // cured by the restart — a new process is not poisoned, it boots the
    // source that moved, and it installs whatever the tip currently declares.
    // Outgrowing a memory cap is not: the successor will grow the same way, so
    // restarting it hot converts a memory problem into a spawn storm.
    expect(HABITANT_EXIT_DISPOSITION["memory-cap"]).toBe("restart-with-backoff")
    expect(HABITANT_EXIT_DISPOSITION.poisoned).toBe("restart-immediately")
    expect(HABITANT_EXIT_DISPOSITION["source-stale"]).toBe("restart-immediately")
    expect(HABITANT_EXIT_DISPOSITION["installed-plan-stale"]).toBe("restart-immediately")
    expect(HABITANT_EXIT_DISPOSITION.interrupted).toBe("restart-immediately")
  })

  it("refuses to restart the one condition a successor cannot change at all", () => {
    // Every other condition lives in THIS process: a successor is not
    // poisoned, boots moved source, installs the current plan, starts small.
    // A wedged queue lives outside the process, so the successor re-reads the
    // same wedge — pacing it only sets how often we rediscover that.
    expect(HABITANT_EXIT_DISPOSITION["queue-wedged"]).toBe("stand-down")
  })

  it("derives the backoff code list from the table rather than restating it", () => {
    expect(HABITANT_BACKOFF_EXIT_CODES).toEqual([HABITANT_EXIT["memory-cap"]])
  })

  it("derives the stand-down code list the same way, and keeps the two disjoint", () => {
    expect(HABITANT_STAND_DOWN_EXIT_CODES).toEqual([HABITANT_EXIT["queue-wedged"]])
    const overlap = HABITANT_STAND_DOWN_EXIT_CODES.filter((code) => HABITANT_BACKOFF_EXIT_CODES.includes(code))
    expect(overlap).toEqual([])
  })
})

describe("habitant exit taxonomy — reading a code back", () => {
  it("round-trips every condition", () => {
    for (const condition of CONDITIONS) {
      expect(habitantExitCondition(HABITANT_EXIT[condition])).toBe(condition)
    }
  })

  it("answers undefined for a code it did not issue — never a wrong name", () => {
    // 0/1/2 are ordinary verb results and a signal death has no code at all.
    // "We do not know why it stopped" is a real answer and must stay one.
    expect(habitantExitCondition(0)).toBeUndefined()
    expect(habitantExitCondition(1)).toBeUndefined()
    expect(habitantExitCondition(2)).toBeUndefined()
    expect(habitantExitCondition(137)).toBeUndefined()
  })
})
