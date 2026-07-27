/**
 * @yrd/core/22290-bay-reaper — bay status safety oracle (pure classification)
 * @level l2
 * @consumer @yrd/cli
 */
import { describe, expect, it } from "vitest"
import {
  classifyBayStatus,
  formatBayStatusHuman,
  parseOwnerPid,
  parseYrdBayProtections,
  protectionEvidenceForBay,
  type BayStatusFacts,
} from "../src/bay-status.ts"

const base: BayStatusFacts = {
  bayId: "B1",
  name: "example",
  branch: "task/example",
  path: "/repo/.bays/B1",
  worktreeDirty: false,
  tipLanded: true,
  aheadOfOrigin: 0,
  stashAttributed: 0,
  openPrIds: [],
}

describe("parseOwnerPid", () => {
  it("reads trailing :PID from name or BY", () => {
    expect(parseOwnerPid("bay:12345")).toBe(12345)
    expect(parseOwnerPid(undefined, "@agent/3:9988")).toBe(9988)
    expect(parseOwnerPid("plain", "@agent/3")).toBeUndefined()
  })
})

describe("host-owned Bay protections", () => {
  const encoded = JSON.stringify({
    schema: "yrd-bay-protections/1",
    protections: [
      {
        bay: "B198",
        path: "/repo/.bays/B198",
        source: "inhab-status-home",
        evidence: "Inhab status home @dev.1 last state is ready",
      },
    ],
  })

  it("parses the versioned envelope and matches by Bay id or exact path", () => {
    const protections = parseYrdBayProtections(encoded)

    expect(protectionEvidenceForBay(protections, { id: "B198", path: "/other/.bays/B198" })).toEqual([
      "Inhab status home @dev.1 last state is ready",
    ])
    expect(protectionEvidenceForBay(protections, { id: "B9", path: "/repo/.bays/B198" })).toEqual([
      "Inhab status home @dev.1 last state is ready",
    ])
  })

  it("fails loud on a malformed protection envelope", () => {
    expect(() =>
      parseYrdBayProtections(
        '{"schema":"yrd-bay-protections/1","protections":[{"bay":"B1","path":"/repo/.bays/B1","source":"host"}]}',
      ),
    ).toThrow(/protection.*evidence/i)
  })
})

describe("classifyBayStatus", () => {
  it("exit 0 only when every material class PASSes", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 9,
      ownerAlive: false,
    })
    expect(report.exit).toBe(0)
    expect(report.safe).toBe(true)
    expect(report.wrapper).toBe("git")
    expect(report.lines.every((line) => line.verdict === "PASS" || line.class === "pr")).toBe(true)
  })

  it("exit 1 when clean tree but ahead of origin (the 22/25 trap)", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 9,
      ownerAlive: false,
      tipLanded: false,
      aheadOfOrigin: 3,
    })
    expect(report.exit).toBe(1)
    expect(report.safe).toBe(false)
    const commits = report.lines.find((line) => line.class === "commits")
    expect(commits?.verdict).toBe("BLOCK")
    expect(commits?.evidence).toMatch(/3 unique commit/)
  })

  it("exit 2 when a failed refresh leaves even landed-looking origin evidence stale", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 9,
      ownerAlive: false,
      tipDurableAt: "origin/main",
      remoteTrackingFresh: false,
    })
    expect(report.exit).toBe(2)
    expect(report.safe).toBeNull()
    expect(report.lines.find((line) => line.class === "commits")).toMatchObject({
      verdict: "UNKNOWN",
      evidence: expect.stringMatching(/could not refresh and prune origin refs/u),
    })
  })

  it("exit 1 when owner is live", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 42,
      ownerAlive: true,
    })
    expect(report.exit).toBe(1)
    expect(report.lines.find((line) => line.class === "owner")?.verdict).toBe("BLOCK")
  })

  it("exit 1 when a live external consumer protects an otherwise removable bay", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 42,
      ownerAlive: false,
      protectedBy: ["inhab status home @dev.1 is ready"],
    })

    expect(report.exit).toBe(1)
    expect(report.safe).toBe(false)
    expect(report.lines.find((line) => line.class === "consumer")).toMatchObject({
      verdict: "BLOCK",
      evidence: expect.stringContaining("@dev.1"),
    })
  })

  it("exit 2 when owner PID is missing (unprovable must not look safe)", () => {
    const report = classifyBayStatus({
      ...base,
      // no ownerPid
    })
    expect(report.exit).toBe(2)
    expect(report.safe).toBeNull()
    expect(report.lines.find((line) => line.class === "owner")?.verdict).toBe("UNKNOWN")
  })

  it("open PR does not block (informational PASS)", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 1,
      ownerAlive: false,
      openPrIds: ["PR99"],
    })
    expect(report.exit).toBe(0)
    expect(report.lines.find((line) => line.class === "pr")?.evidence).toMatch(/PR99/)
  })

  it("human format names every class with evidence", () => {
    const text = formatBayStatusHuman(
      classifyBayStatus({
        ...base,
        ownerPid: 7,
        ownerAlive: false,
      }),
    )
    expect(text).toMatch(/exit=0/)
    expect(text).toMatch(/owner\s+PASS/)
    expect(text).toMatch(/worktree\s+PASS/)
    expect(text).toMatch(/commits\s+PASS/)
    expect(text).toMatch(/wrapper=git/)
  })
})
