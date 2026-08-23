/**
 * @yrd/core/22290-bay-reaper — bay status safety oracle (pure classification)
 * @level l2
 * @consumer @yrd/cli
 */
import { describe, expect, it } from "vitest"
import {
  classifyBayStatus,
  formatBayStatusHuman,
  freshOriginBranchMissing,
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
  tipMerged: true,
  aheadOfOrigin: 0,
  stashAttributed: 0,
  openChangeIds: [],
}

const completeProviders = [
  { provider: "hab-launch-claims", status: "complete", evidence: "read Hab launch claims" },
  { provider: "inhab-launch-records", status: "complete", evidence: "read Inhab launch records" },
  { provider: "live-process-cwds", status: "complete", evidence: "read live process CWDs" },
  { provider: "herdr-live-sessions", status: "complete", evidence: "read Herdr live sessions" },
]

describe("parseOwnerPid", () => {
  it("reads trailing :PID from name or BY", () => {
    expect(parseOwnerPid("bay:12345")).toBe(12345)
    expect(parseOwnerPid(undefined, "@agent/3:9988")).toBe(9988)
    expect(parseOwnerPid("plain", "@agent/3")).toBeUndefined()
  })
})

describe("freshOriginBranchMissing", () => {
  it("recognizes only Git's exact missing-ref exit and keeps every other failure unknown", () => {
    expect(freshOriginBranchMissing(0)).toBe(false)
    expect(freshOriginBranchMissing(1)).toBe(true)
    expect(freshOriginBranchMissing(2)).toBeUndefined()
    expect(freshOriginBranchMissing(null)).toBeUndefined()
  })
})

describe("host-owned Bay protections", () => {
  const encoded = JSON.stringify({
    schema: "yrd-bay-protections/2",
    providers: completeProviders,
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
        JSON.stringify({
          schema: "yrd-bay-protections/2",
          providers: completeProviders,
          protections: [{ bay: "B1", path: "/repo/.bays/B1", source: "host" }],
        }),
      ),
    ).toThrow(/protection.*evidence/i)
  })

  it("fails loud when the declared host provider census is incomplete", () => {
    expect(() =>
      parseYrdBayProtections(
        JSON.stringify({
          schema: "yrd-bay-protections/2",
          providers: [
            {
              provider: "hab-launch-claims",
              status: "complete",
              evidence: "read 0 current Hab launch claims",
            },
          ],
          protections: [],
        }),
      ),
    ).toThrow(/providers.*missing.*inhab-launch-records/u)
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
      tipMerged: false,
      aheadOfOrigin: 3,
    })
    expect(report.exit).toBe(1)
    expect(report.safe).toBe(false)
    const commits = report.lines.find((line) => line.class === "commits")
    expect(commits?.verdict).toBe("BLOCK")
    expect(commits?.evidence).toMatch(/3 unique commit/)
  })

  it("names the live worktree HEAD when it supplied the commit proof", () => {
    const report = classifyBayStatus({
      ...base,
      branchMissingFromOrigin: true,
      remoteTrackingFresh: true,
      tipProofSource: "live worktree HEAD",
      uniquePatches: 0,
    })
    expect(report.lines.find((line) => line.class === "commits")?.evidence).toBe(
      "branch is absent from origin after a fresh pruned fetch and the tip has no unique commits (proof used live worktree HEAD)",
    )
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

  it("accepts an old no-token Bay after the host census proves no live consumer", () => {
    const report = classifyBayStatus({
      ...base,
      ageMs: 48 * 60 * 60 * 1_000 + 1,
      protectedBy: [],
    })

    expect(report.exit).toBe(0)
    expect(report.lines.find((line) => line.class === "owner")).toMatchObject({
      verdict: "PASS",
      evidence: expect.stringMatching(/48h migration floor/u),
    })
  })

  it("treats a historical failed Bay with no workspace as closed-degenerate", () => {
    const report = classifyBayStatus({
      bayId: "B280",
      name: "pathless",
      branch: "task/pathless",
      closedDegenerate: true,
    })

    expect(report.exit).toBe(0)
    expect(report.lines.every((line) => line.verdict === "PASS")).toBe(true)
    expect(report.lines.find((line) => line.class === "worktree")?.evidence).toMatch(/closed-degenerate/u)
  })

  it("keeps a closed-degenerate Bay unknown when the host census is incomplete", () => {
    const report = classifyBayStatus({
      bayId: "B280",
      name: "pathless",
      branch: "task/pathless",
      closedDegenerate: true,
      protectionGaps: ["provider inhab-launch-records unavailable"],
    })

    expect(report).toMatchObject({ exit: 2, safe: null })
    expect(report.lines.find((line) => line.class === "consumer")).toMatchObject({ verdict: "UNKNOWN" })
  })

  it("accepts a missing workspace when a fresh origin census proves its branch is gone", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 9,
      ownerAlive: false,
      worktreeMissing: true,
      branchMissingFromOrigin: true,
      remoteTrackingFresh: true,
      tipMerged: undefined,
      aheadOfOrigin: undefined,
      uniquePatches: 0,
    })

    expect(report.exit).toBe(0)
    expect(report.lines.find((line) => line.class === "commits")).toMatchObject({
      verdict: "PASS",
      evidence: expect.stringMatching(/branch is absent from origin/u),
    })
  })

  it("blocks removal while a live PR still references the Bay", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 1,
      ownerAlive: false,
      openChangeIds: ["PR99"],
    })
    expect(report).toMatchObject({ exit: 1, safe: false })
    expect(report.lines.find((line) => line.class === "pr")).toMatchObject({
      verdict: "BLOCK",
      evidence: expect.stringMatching(/PR99.*references this Bay/u),
    })
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

  it("human format names the effective base SHA pr create will consume", () => {
    const text = formatBayStatusHuman(
      classifyBayStatus({
        ...base,
        ownerPid: 7,
        ownerAlive: false,
        effectiveBase: { base: "main", baseSha: "c".repeat(40) },
      }),
    )
    expect(text).toMatch(/base main@cccccccccccc/)
  })
})
