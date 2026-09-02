import { describe, expect, it } from "vitest"
import { deriveRunLiveness, describeOrphanedRun, runnerPid } from "../src/run-liveness.ts"

const NOW = Date.parse("2026-09-02T05:13:00.000Z")
const HELD = "2026-09-02T05:20:00.000Z"
const LAPSED = "2026-09-02T05:08:00.000Z"

describe("run liveness is derived from the lease holder at read time (24030)", () => {
  it("a held lease with a live holder is running", () => {
    const liveness = deriveRunLiveness(
      { runner: "yrd-cli:3411471", leaseExpiresAt: HELD },
      { now: NOW, runnerAlive: () => true },
    )
    expect(liveness).toEqual({ state: "running", runner: "yrd-cli:3411471", leaseExpiresAt: HELD })
  })

  it("an expired lease is orphaned even when nobody can probe the holder (R3742 shape)", () => {
    const liveness = deriveRunLiveness(
      { runner: "yrd-cli:3411471", leaseExpiresAt: LAPSED },
      { now: NOW, runnerAlive: () => undefined },
    )
    expect(liveness).toEqual({
      state: "orphaned",
      runner: "yrd-cli:3411471",
      leaseExpiresAt: LAPSED,
      cause: "lease-expired",
      pid: 3411471,
    })
    expect(describeOrphanedRun(liveness as Extract<typeof liveness, { state: "orphaned" }>)).toBe(
      `orphaned: lease expired ${LAPSED}, holder yrd-cli:3411471 (pid 3411471)`,
    )
  })

  it("a held lease whose holder is dead is orphaned, never checking (R3747 shape)", () => {
    const liveness = deriveRunLiveness(
      { runner: "yrd-cli:3411471", leaseExpiresAt: HELD },
      { now: NOW, runnerAlive: () => false },
    )
    expect(liveness).toMatchObject({ state: "orphaned", cause: "holder-dead", pid: 3411471 })
  })

  it("a pid-less holder is judged by its lease alone, and an unparseable lease reads as expired", () => {
    expect(runnerPid("yrd-cli")).toBeUndefined()
    expect(runnerPid("yrd-cli:0")).toBeUndefined()
    expect(
      deriveRunLiveness({ runner: "yrd-cli", leaseExpiresAt: HELD }, { now: NOW, runnerAlive: () => undefined }),
    ).toMatchObject({
      state: "running",
    })
    expect(
      deriveRunLiveness({ runner: "yrd-cli", leaseExpiresAt: "not-a-date" }, { now: NOW, runnerAlive: () => true }),
    ).toMatchObject({
      state: "orphaned",
      cause: "lease-expired",
    })
  })
})
