/**
 * @failure A habitant runner reclaims a live prior runner's leases, or fails to reclaim a dead one.
 * @level l2
 * @consumer @yrd/cli habitant runner reclaim
 */
import { describe, expect, it } from "vitest"
import { planHabitantRunnerReclaim } from "../src/run.ts"

const priorAt = (pid: number) => ({
  pid,
  startedAt: "2026-01-01T00:00:00.000Z",
  lastTickAt: "2026-01-01T00:00:05.000Z",
})

/** A prior habitant that wrote an exit marker on close. The status file is never
 * deleted, so the successor sees this (not null) and must still reclaim a dead pid
 * — clean or not — because queue.recover is idempotent. */
const exitedAt = (pid: number, clean: boolean) => ({ ...priorAt(pid), exitedAt: "2026-01-01T00:00:06.000Z", clean })

describe("planHabitantRunnerReclaim", () => {
  it("reclaims when the prior habitant pid is a different, dead process", () => {
    const decision = planHabitantRunnerReclaim(priorAt(111), 222, () => false)
    expect(decision).toEqual({ reclaim: true, runner: "yrd-cli:111" })
  })

  it("skips reclaim when the prior habitant pid is still alive", () => {
    const decision = planHabitantRunnerReclaim(priorAt(111), 222, () => true)
    expect(decision).toEqual({ reclaim: false })
  })

  it("skips reclaim when no prior status is recorded", () => {
    let probed = false
    const decision = planHabitantRunnerReclaim(null, 222, () => {
      probed = true
      return false
    })
    expect(decision).toEqual({ reclaim: false })
    expect(probed).toBe(false)
  })

  it("skips reclaim when the recorded pid is our own", () => {
    let probed = false
    const decision = planHabitantRunnerReclaim(priorAt(222), 222, () => {
      probed = true
      return false
    })
    expect(decision).toEqual({ reclaim: false })
    expect(probed).toBe(false)
  })

  it("reclaims a dead prior pid that recorded a CLEAN exit marker (never-deleted status file)", () => {
    const decision = planHabitantRunnerReclaim(exitedAt(111, true), 222, () => false)
    expect(decision).toEqual({ reclaim: true, runner: "yrd-cli:111" })
  })

  it("reclaims a dead prior pid that recorded an UNCLEAN exit marker", () => {
    const decision = planHabitantRunnerReclaim(exitedAt(111, false), 222, () => false)
    expect(decision).toEqual({ reclaim: true, runner: "yrd-cli:111" })
  })

  it("skips reclaim when an exit marker's pid is still alive", () => {
    expect(planHabitantRunnerReclaim(exitedAt(111, true), 222, () => true)).toEqual({ reclaim: false })
  })

  it("skips reclaim when an exit marker's pid is our own reused pid", () => {
    let probed = false
    const decision = planHabitantRunnerReclaim(exitedAt(222, true), 222, () => {
      probed = true
      return false
    })
    expect(decision).toEqual({ reclaim: false })
    expect(probed).toBe(false)
  })
})
