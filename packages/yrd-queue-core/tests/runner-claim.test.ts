/**
 * @failure A malformed or stale runner ref could be believed as a live service.
 * @level l1 (the pure root-commit wire and freshness rule)
 * @consumer Yrd's resident publisher and off-machine readers
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { formatRunnerClaim, judgeRunnerClaim, judgeRunnerDeadline, parseRunnerClaim, runnerRef } from "../src/index.ts"

const claim = {
  host: "queue-host",
  pid: 4242,
  started: "2026-09-27T12:00:00.000Z",
  at: "2026-09-27T12:01:00.000Z",
  beatMs: 60_000,
  state: "checking" as const,
  holding: "task/a@" + "a".repeat(40),
  since: "2026-09-27T12:00:30.000Z",
  deadline: "2026-09-27T12:30:30.000Z",
}

describe("runner claim", () => {
  it("names the queue-owned runner ref and round trips all claim trailers", () => {
    expect(runnerRef("a/b")).toBe("refs/yrd/a%2Fb/runner")
    const message = formatRunnerClaim(claim)
    expect(message).toContain("Runner: queue-host/4242\n")
    expect(message).toContain("Beat: 60000ms\n")
    expect(parseRunnerClaim(message)).toEqual(claim)
    expect(parseRunnerClaim(`${message}\n\n`)).toEqual(claim) // `git show -s --format=%B` terminal blank lines
  })

  it("judges the three-beat boundary and future clock skew", () => {
    expect(judgeRunnerClaim(claim, new Date("2026-09-27T12:04:00.000Z")).status).toBe("fresh")
    expect(judgeRunnerClaim(claim, new Date("2026-09-27T12:04:00.001Z")).status).toBe("silent")
    expect(judgeRunnerClaim(claim, new Date("2026-09-27T12:00:29.999Z"))).toMatchObject({
      status: "unreadable",
      reason: expect.stringContaining("clock-skew"),
    })
  })

  it("round trips a declared phase deadline and rejects one before its phase start", () => {
    const message = formatRunnerClaim(claim)
    expect(message).toContain("Since: 2026-09-27T12:00:30.000Z\nDeadline: 2026-09-27T12:30:30.000Z\n")
    expect(parseRunnerClaim(message)).toEqual(claim)
    expect(() => formatRunnerClaim({ ...claim, deadline: "2026-09-27T12:00:29.999Z" })).toThrow(/Deadline/)
    expect(() => formatRunnerClaim({ ...claim, deadline: undefined })).toThrow(/Deadline/)
    expect(() =>
      parseRunnerClaim(message.replace("Deadline: 2026-09-27T12:30:30.000Z", "Deadline: yesterday")),
    ).toThrow(/Deadline/)
    // Readers must still parse an older writer so they can label its missing deadline explicitly.
    expect(parseRunnerClaim(message.replace("Deadline: 2026-09-27T12:30:30.000Z\n", ""))).toEqual({
      ...claim,
      deadline: undefined,
    })
  })

  it("judges a phase only after its declared deadline plus three beats", () => {
    expect(judgeRunnerDeadline(claim, new Date("2026-09-27T12:33:30.000Z")).status).toBe("within")
    expect(judgeRunnerDeadline(claim, new Date("2026-09-27T12:33:30.001Z")).status).toBe("overdue")
    expect(judgeRunnerDeadline({ ...claim, deadline: undefined }, new Date("2026-09-27T12:45:00.000Z"))).toMatchObject({
      status: "unavailable",
      reason: "deadline unavailable: writer predates Deadline",
    })
    expect(
      judgeRunnerDeadline({ ...claim, state: "idle", deadline: undefined }, new Date("2026-09-27T12:45:00.000Z"))
        .status,
    ).toBe("unbounded")
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
    expect(() => parseRunnerClaim(message.replace("Beat: 60000ms\n", "Beat: 60000ms\n\n"))).toThrow(/malformed trailer/)
    expect(() => parseRunnerClaim(message + "At: 2026-09-27T12:01:00.000Z\n")).toThrow(/duplicate At/)
    expect(() => parseRunnerClaim(message + "Step: check\n")).toThrow(/unknown.*Step/)
  })
})
