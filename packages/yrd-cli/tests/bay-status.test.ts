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
  protectionGapEvidenceForBay,
  protectionNotConsumedEvidenceForBay,
  UNRECEIPTED_CLAIM_NOT_CONSUMED_FLOOR_MS,
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

  it("exit 2 when a failed refresh leaves even merged-looking origin evidence stale", () => {
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

  it("blocks removal while a live change still references the Bay", () => {
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

  it("blocks removal while a derived-lane submission still references the Bay's branch with no Change record", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 1,
      ownerAlive: false,
      openChangeIds: [],
      derivedLaneSubmitLive: true,
    })
    expect(report).toMatchObject({ exit: 1, safe: false })
    expect(report.lines.find((line) => line.class === "pr")).toMatchObject({
      verdict: "BLOCK",
      evidence: expect.stringMatching(/derived-lane submission for task\/example is still live/u),
    })
  })

  it("passes the pr class when neither a Change record nor a derived-lane submit references the branch", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 1,
      ownerAlive: false,
      openChangeIds: [],
      derivedLaneSubmitLive: false,
    })
    expect(report).toMatchObject({ exit: 0, safe: true })
    expect(report.lines.find((line) => line.class === "pr")).toMatchObject({
      verdict: "PASS",
      evidence: "no live change references this Bay",
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

/**
 * @failure `yrd bay status B399` BLOCKed correctly on the root tip, but a
 *          second unique object sat in the km submodule's bay-private gitdir
 *          on no km branch anywhere — invisible, because the oracle was fed
 *          root facts only. `classifyBayStatus` now walks `facts.submodules`
 *          through the SAME commit-durability ladder as the root's own
 *          "commits" line.
 * @level l2
 * @consumer @yrd/cli bay status · bay close · admin bay prune · bay list --check
 * @bead @i/10-yrd/bay-prune-without-data-loss
 */
describe("the submodule commit-durability ladder (B399)", () => {
  const submoduleSha = "deadbeefcafedeadbeefcafedeadbeefcafedead"

  it("BLOCKs the whole Bay when the root is clean but a submodule holds an unpublished commit", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 9,
      ownerAlive: false,
      // The root stays exactly as clean as `base` already made it — the
      // defect this proves fixed is a clean root no longer hiding a dirty
      // submodule.
      submodules: [
        {
          path: "deps/widgets",
          sha: submoduleSha,
          remoteTrackingFresh: true,
          tipMerged: false,
          aheadOfOrigin: 1,
        },
      ],
    })

    expect(report.exit).toBe(1)
    expect(report.safe).toBe(false)
    expect(report.lines.find((line) => line.class === "commits")).toMatchObject({ verdict: "PASS" })
    const submodule = report.lines.find((line) => line.class === "submodule")
    expect(submodule?.verdict).toBe("BLOCK")
    expect(submodule?.evidence).toContain("deps/widgets@deadbeefcafe")
    expect(submodule?.evidence).toMatch(/1 unique commit/)
    // Never a local ref: the cure is a real push to the component's own
    // origin — an unqualified branch name, never a `refs/heads/`-qualified
    // one (that literal shape is what remedy-banned-actions-guard.test.ts
    // scans this whole tool surface for as a hand-push to a submodule).
    expect(submodule?.evidence).toContain("cure: git -C '/repo/.bays/B1/deps/widgets' push origin")
    expect(submodule?.evidence).toContain(`${submoduleSha}:wip/orphan-example-deps-widgets`)
    expect(submodule?.evidence).not.toContain("refs/heads/")
  })

  it("names every submodule that is not durable, not just the first", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 9,
      ownerAlive: false,
      submodules: [
        { path: "deps/widgets", sha: submoduleSha, remoteTrackingFresh: true, tipMerged: true, aheadOfOrigin: 0 },
        {
          path: "deps/tools",
          sha: "f".repeat(40),
          remoteTrackingFresh: true,
          tipMerged: false,
          aheadOfOrigin: 2,
        },
      ],
    })

    expect(report.exit).toBe(1)
    const rows = report.lines.filter((line) => line.class === "submodule")
    expect(rows).toHaveLength(2)
    expect(rows.find((line) => line.evidence.startsWith("deps/widgets@"))).toMatchObject({ verdict: "PASS" })
    expect(rows.find((line) => line.evidence.startsWith("deps/tools@"))).toMatchObject({ verdict: "BLOCK" })
  })

  it("stays SAFE when the root and every submodule are durable on their own origin", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 9,
      ownerAlive: false,
      submodules: [
        {
          path: "deps/widgets",
          sha: submoduleSha,
          remoteTrackingFresh: true,
          tipMerged: true,
          aheadOfOrigin: 0,
        },
      ],
    })

    expect(report.exit).toBe(0)
    expect(report.safe).toBe(true)
    expect(report.lines.find((line) => line.class === "submodule")).toMatchObject({
      verdict: "PASS",
      evidence: expect.stringContaining("deps/widgets@deadbeefcafe"),
    })
  })

  it("is unaffected when a Bay has no submodules at all", () => {
    const report = classifyBayStatus({ ...base, ownerPid: 9, ownerAlive: false })
    expect(report.lines.some((line) => line.class === "submodule")).toBe(false)
  })

  it("goes UNKNOWN, never silently safe, when the submodule walk itself could not be trusted", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 9,
      ownerAlive: false,
      submodulesUnknown: true,
    })

    expect(report.exit).toBe(2)
    expect(report.safe).toBeNull()
    expect(report.lines.find((line) => line.class === "submodule")).toMatchObject({
      verdict: "UNKNOWN",
      evidence: expect.stringMatching(/could not enumerate/u),
    })
  })

  it("never appends a cure it cannot run when the Bay has no live worktree path", () => {
    const report = classifyBayStatus({
      ...base,
      path: undefined,
      bayId: "B280",
      name: "pathless",
      ownerPid: 9,
      ownerAlive: false,
      worktreeMissing: true,
      tipMerged: false,
      aheadOfOrigin: 1,
      submodules: [
        { path: "deps/widgets", sha: submoduleSha, remoteTrackingFresh: true, tipMerged: false, aheadOfOrigin: 1 },
      ],
    })

    const submodule = report.lines.find((line) => line.class === "submodule")
    expect(submodule?.verdict).toBe("BLOCK")
    expect(submodule?.evidence).not.toContain("cure:")
  })
})

/**
 * @failure A Hab launch claim with no receipt read as `provider unavailable`, so 69 Bays were refused
 *          with no claim named, no cure named, and no age that could ever settle it.
 * @level l2
 * @consumer @yrd/cli bay status · admin bay prune
 * @bead @i/10-yrd/bay-prune-without-data-loss
 */
describe("the consumer verdict on an unreceipted host claim", () => {
  const NOW = Date.parse("2026-08-30T12:00:00.000Z")
  const CURE = "re-run the Hab launch for @dev/4, or clear its stale claim"

  const envelope = (
    extra: Record<string, unknown>,
    providers: readonly Record<string, unknown>[] = completeProviders,
  ) =>
    JSON.stringify({
      schema: "yrd-bay-protections/2",
      providers,
      protections: [],
      ...extra,
    })

  const bay = { id: "B369", path: "/repo/.bays/B369" }

  const factsFrom = (raw: string): BayStatusFacts => {
    const protections = parseYrdBayProtections(raw, { nowMs: NOW })
    return {
      ...base,
      bayId: bay.id,
      path: bay.path,
      ownerPid: 9,
      ownerAlive: false,
      protectedBy: protectionEvidenceForBay(protections, bay),
      protectionGaps: protectionGapEvidenceForBay(protections, bay),
      consumerNotConsumed: protectionNotConsumedEvidenceForBay(protections, bay),
    }
  }

  it("passes when every claim has a current receipt", () => {
    const report = classifyBayStatus(factsFrom(envelope({})))
    const consumer = report.lines.find((line) => line.class === "consumer")

    expect(consumer).toMatchObject({ verdict: "PASS" })
    expect(report.exit).toBe(0)
  })

  it("rules a claim NOT-CONSUMED past the floor instead of refusing the Bay forever", () => {
    // The B369 shape: worktree, commits, stash and pr all PASS, and the ONLY
    // thing refusing the Bay is a launch claim whose receipt never appeared. A
    // claim that went unreceipted past the floor did not survive to hold a
    // workspace, so its absence is the fact — the population can shrink again.
    const report = classifyBayStatus(
      factsFrom(
        envelope({
          claims: [
            {
              provider: "hab-launch-claims",
              claim: "hab-launch/@dev/4",
              claimedAt: new Date(NOW - UNRECEIPTED_CLAIM_NOT_CONSUMED_FLOOR_MS - 3_600_000).toISOString(),
              cure: CURE,
            },
          ],
        }),
      ),
    )
    const consumer = report.lines.find((line) => line.class === "consumer")

    expect(consumer).toMatchObject({ verdict: "PASS" })
    expect(consumer?.evidence).toContain("hab-launch/@dev/4")
    expect(consumer?.evidence).toContain("NOT-CONSUMED")
    expect(report.exit).toBe(0)
    expect(report.safe).toBe(true)
  })

  it("names the claim id and its cure while the claim is still inside the floor", () => {
    // Still undecided — but an UNKNOWN a reader cannot act on is the defect this
    // row exists to remove, so the claim identifies itself and says what settles it.
    const report = classifyBayStatus(
      factsFrom(
        envelope({
          claims: [
            {
              provider: "hab-launch-claims",
              claim: "hab-launch/@dev/4",
              claimedAt: new Date(NOW - 3_600_000).toISOString(),
              cure: CURE,
            },
          ],
        }),
      ),
    )
    const consumer = report.lines.find((line) => line.class === "consumer")

    expect(consumer).toMatchObject({ verdict: "UNKNOWN" })
    expect(consumer?.evidence).toContain("hab-launch/@dev/4")
    expect(consumer?.evidence).toContain(CURE)
    expect(report.exit).toBe(2)
  })

  it("accepts epoch milliseconds as well as an ISO instant, and refuses anything else", () => {
    const claim = (claimedAt: unknown) =>
      envelope({
        claims: [{ provider: "hab-launch-claims", claim: "hab-launch/@dev/4", claimedAt, cure: CURE }],
      })

    expect(
      classifyBayStatus(factsFrom(claim(NOW - UNRECEIPTED_CLAIM_NOT_CONSUMED_FLOOR_MS - 1_000))).lines.find(
        (line) => line.class === "consumer",
      ),
    ).toMatchObject({ verdict: "PASS" })
    expect(() => parseYrdBayProtections(claim("last tuesday"), { nowMs: NOW })).toThrow(/claimedAt/u)
    expect(() => parseYrdBayProtections(claim(undefined), { nowMs: NOW })).toThrow(/claimedAt/u)
  })

  it("refuses a claim from a provider the census never declared", () => {
    expect(() =>
      parseYrdBayProtections(
        envelope({
          claims: [{ provider: "made-up-provider", claim: "x", claimedAt: NOW, cure: CURE }],
        }),
        { nowMs: NOW },
      ),
    ).toThrow(/not a declared provider/u)
  })

  it("an unreachable provider stays UNKNOWN and names its cure", () => {
    // The other half of the row: a provider that genuinely could not be read is a
    // REFUSAL, never a claim verdict, and it must carry the action that clears it.
    const report = classifyBayStatus(
      factsFrom(
        envelope({}, [
          {
            provider: "hab-launch-claims",
            status: "unavailable",
            evidence: "could not read current Hab launch claims from /hh/dev: EACCES",
            cure: "restore read access to the Hab state root",
          },
          ...completeProviders.slice(1),
        ]),
      ),
    )
    const consumer = report.lines.find((line) => line.class === "consumer")

    expect(consumer).toMatchObject({ verdict: "UNKNOWN" })
    expect(consumer?.evidence).toContain("hab-launch-claims")
    expect(consumer?.evidence).toContain("restore read access to the Hab state root")
    expect(report.exit).toBe(2)
  })

  it("tells the host which field to set when an unavailable provider declares no cure", () => {
    const report = classifyBayStatus(
      factsFrom(
        envelope({}, [
          {
            provider: "hab-launch-claims",
            status: "unavailable",
            evidence: "could not read current Hab launch claims from /hh/dev: EACCES",
          },
          ...completeProviders.slice(1),
        ]),
      ),
    )
    const consumer = report.lines.find((line) => line.class === "consumer")

    expect(consumer).toMatchObject({ verdict: "UNKNOWN" })
    expect(consumer?.evidence).toContain("YRD_BAY_PROTECTIONS.providers[].cure")
  })

  it("keeps a live protection blocking, ahead of any claim verdict", () => {
    const protections = parseYrdBayProtections(
      JSON.stringify({
        schema: "yrd-bay-protections/2",
        providers: completeProviders,
        protections: [
          {
            bay: "B369",
            path: "/repo/.bays/B369",
            source: "hab-launch-claim",
            evidence: "current Hab launch claim @dev/4 records workspace /repo/.bays/B369",
          },
        ],
        claims: [
          {
            provider: "hab-launch-claims",
            claim: "hab-launch/@dev/9",
            claimedAt: new Date(NOW - UNRECEIPTED_CLAIM_NOT_CONSUMED_FLOOR_MS - 1_000).toISOString(),
            cure: CURE,
          },
        ],
      }),
      { nowMs: NOW },
    )
    const report = classifyBayStatus({
      ...base,
      bayId: bay.id,
      path: bay.path,
      ownerPid: 9,
      ownerAlive: false,
      protectedBy: protectionEvidenceForBay(protections, bay),
      protectionGaps: protectionGapEvidenceForBay(protections, bay),
      consumerNotConsumed: protectionNotConsumedEvidenceForBay(protections, bay),
    })

    expect(report.lines.find((line) => line.class === "consumer")).toMatchObject({ verdict: "BLOCK" })
    expect(report.exit).toBe(1)
  })

  it("applies the same one verdict to a closed-degenerate Bay", () => {
    // Two ladders, one consumer rule: a closed-degenerate Bay used to run its own
    // copy of this ranking, so the two could drift.
    const protections = parseYrdBayProtections(
      JSON.stringify({
        schema: "yrd-bay-protections/2",
        providers: completeProviders,
        protections: [],
        claims: [
          {
            provider: "hab-launch-claims",
            claim: "hab-launch/@dev/4",
            claimedAt: new Date(NOW - UNRECEIPTED_CLAIM_NOT_CONSUMED_FLOOR_MS - 1_000).toISOString(),
            cure: CURE,
          },
        ],
      }),
      { nowMs: NOW },
    )
    const report = classifyBayStatus({
      bayId: "B280",
      name: "pathless",
      branch: "task/pathless",
      closedDegenerate: true,
      consumerNotConsumed: protectionNotConsumedEvidenceForBay(protections, { id: "B280" }),
    })

    expect(report.exit).toBe(0)
    expect(report.lines.find((line) => line.class === "consumer")?.evidence).toContain("NOT-CONSUMED")
  })
})

/**
 * @failure A recycled pid answered `kill -0`, so B58's Bay reported a live owner for days.
 * @level l2
 * @consumer @yrd/cli bay status
 * @bead @i/10-yrd/bay-prune-without-data-loss
 */
describe("owner liveness evidence", () => {
  it("reports the liveness verdict's own words rather than a signal it never sent", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 4242,
      ownerAlive: false,
      ownerEvidence:
        "pid 4242 started 2026-08-30T09:00:00.000Z, after the record that names it; the recorded owner is gone and its pid was reused",
    })
    const owner = report.lines.find((line) => line.class === "owner")

    expect(owner).toMatchObject({ verdict: "PASS" })
    expect(owner?.evidence).toContain("pid was reused")
    expect(owner?.evidence).not.toContain("ESRCH")
  })

  it("keeps an unprovable owner UNKNOWN, never dead", () => {
    const report = classifyBayStatus({
      ...base,
      ownerPid: 4242,
      ownerEvidence: "pid 4242 exists but its identity could not be read: EACCES",
    })

    expect(report.lines.find((line) => line.class === "owner")).toMatchObject({
      verdict: "UNKNOWN",
      evidence: expect.stringContaining("EACCES"),
    })
    expect(report.exit).toBe(2)
  })
})
