import { describe, expect, it } from "vitest"
import { formatRunnerClaim, judgeRunnerClaim, parseRunnerClaim, runnerRef } from "../src/index.ts"

const claim = {
  host: "queue-host",
  pid: 4242,
  started: "2026-09-27T12:00:00.000Z",
  at: "2026-09-27T12:01:00.000Z",
  beatMs: 60_000,
  state: "checking" as const,
  holding: "task/a@" + "a".repeat(40),
  since: "2026-09-27T12:00:30.000Z",
}

describe("runner claim", () => {
  it("names the queue-owned runner ref and round trips all claim trailers", () => {
    expect(runnerRef("a/b")).toBe("refs/yrd/a%2Fb/runner")
    const message = formatRunnerClaim(claim)
    expect(message).toContain("Runner: queue-host/4242\n")
    expect(message).toContain("Beat: 60000ms\n")
    expect(parseRunnerClaim(message)).toEqual(claim)
  })

  it("judges the three-beat boundary and future clock skew", () => {
    expect(judgeRunnerClaim(claim, new Date("2026-09-27T12:04:00.000Z")).status).toBe("fresh")
    expect(judgeRunnerClaim(claim, new Date("2026-09-27T12:04:00.001Z")).status).toBe("silent")
    expect(judgeRunnerClaim(claim, new Date("2026-09-27T12:00:29.999Z"))).toMatchObject({
      status: "unreadable",
      reason: expect.stringContaining("clock-skew"),
    })
  })

  it("refuses malformed, missing, duplicated, and unknown trailers", () => {
    const message = formatRunnerClaim(claim)
    expect(() => parseRunnerClaim(message.replace("Beat: 60000ms", "Beat: 0ms"))).toThrow(/Beat/)
    expect(() => parseRunnerClaim(message.replace("Beat: 60000ms", "Beat: 29999ms"))).toThrow(/Beat/)
    expect(() => parseRunnerClaim(message.replace("State: checking", "State: sleeping"))).toThrow(/State/)
    expect(() => parseRunnerClaim(message.replace("At: 2026-09-27T12:01:00.000Z", "At: yesterday"))).toThrow(/At/)
    expect(() => parseRunnerClaim(message.replace("Holding: " + claim.holding + "\n", ""))).not.toThrow()
    expect(() => parseRunnerClaim(message.replace(claim.holding, "not-a-change"))).toThrow(/Holding/)
    expect(() => parseRunnerClaim(message.replace("Since: 2026-09-27T12:00:30.000Z\n", ""))).toThrow(/Since/)
    expect(() => parseRunnerClaim(message + "At: 2026-09-27T12:01:00.000Z\n")).toThrow(/duplicate At/)
    expect(() => parseRunnerClaim(message + "Step: check\n")).toThrow(/unknown.*Step/)
  })
})
