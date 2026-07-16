/**
 * @failure A resident runner reclaims a live prior runner's leases, or fails to reclaim a dead one.
 * @level l2
 * @consumer @yrd/cli resident runner reclaim
 */
import { describe, expect, it } from "vitest"
import { planResidentRunnerReclaim } from "../src/run.ts"

const priorAt = (pid: number) => ({
  pid,
  startedAt: "2026-01-01T00:00:00.000Z",
  lastTickAt: "2026-01-01T00:00:05.000Z",
})

describe("planResidentRunnerReclaim", () => {
  it("reclaims when the prior resident pid is a different, dead process", () => {
    const decision = planResidentRunnerReclaim(priorAt(111), 222, () => false)
    expect(decision).toEqual({ reclaim: true, runner: "yrd-cli:111" })
  })

  it("skips reclaim when the prior resident pid is still alive", () => {
    const decision = planResidentRunnerReclaim(priorAt(111), 222, () => true)
    expect(decision).toEqual({ reclaim: false })
  })

  it("skips reclaim when no prior status is recorded", () => {
    let probed = false
    const decision = planResidentRunnerReclaim(null, 222, () => {
      probed = true
      return false
    })
    expect(decision).toEqual({ reclaim: false })
    expect(probed).toBe(false)
  })

  it("skips reclaim when the recorded pid is our own", () => {
    let probed = false
    const decision = planResidentRunnerReclaim(priorAt(222), 222, () => {
      probed = true
      return false
    })
    expect(decision).toEqual({ reclaim: false })
    expect(probed).toBe(false)
  })
})
