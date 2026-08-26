import { describe, expect, it } from "vitest"
import type { CheckpointMigrationManifest } from "@yrd/core"
import { checkpointBumpGateViolations, SHIPPED_CHECKPOINT_IDENTITIES } from "../src/checkpoint-bump-gate.ts"

/** Distinct, well-formed identities. Their VALUES carry no meaning — only
 * whether the graph connects them — so they are spelled as obvious fixtures
 * rather than as plausible-looking hashes nobody could tell from a real one. */
const OLD = "a".repeat(64)
const HOP = "b".repeat(64)
const NEW = "c".repeat(64)
const OTHER = "d".repeat(64)

const manifest = (
  targetIdentity: string,
  edges: readonly { from: string; to: string }[],
): CheckpointMigrationManifest => ({ version: 1, targetIdentity, edges })

describe("checkpoint bump gate", () => {
  it("passes when the identity has not moved", () => {
    expect(checkpointBumpGateViolations(manifest(NEW, []), [NEW])).toEqual([])
  })

  it("fails when the identity moved and no shipped entry records it", () => {
    // The bump author changed a projectionVersion and ran nothing else. This
    // is the cheapest possible mistake and today it ships green.
    const violations = checkpointBumpGateViolations(manifest(NEW, [{ from: OLD, to: NEW }]), [OLD])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain(`moved from '${OLD}' to '${NEW}'`)
    expect(violations[0]).toContain("SHIPPED_CHECKPOINT_IDENTITIES")
  })

  it("fails when a bump is recorded but its predecessor has no migration edge", () => {
    // The defect this gate exists for: the version moved, the ledger was
    // appended to, and nothing retained the identity the last release shipped.
    const violations = checkpointBumpGateViolations(manifest(NEW, []), [OLD, NEW])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain(`shipped checkpoint identity '${OLD}'`)
    expect(violations[0]).toContain("has no migration path")
    expect(violations[0]).toContain("RETAINED_PREDECESSOR_CHECKPOINT_IDENTITIES")
  })

  it("passes when a recorded bump declares the edge its predecessor needs", () => {
    expect(checkpointBumpGateViolations(manifest(NEW, [{ from: OLD, to: NEW }]), [OLD, NEW])).toEqual([])
  })

  it("follows multi-hop paths, which is how retained predecessors converge", () => {
    // Production's real shape since 2026-08-25: every historical predecessor
    // merges on one released identity, which then takes a single forward edge.
    const edges = [
      { from: OLD, to: HOP },
      { from: HOP, to: NEW },
    ]
    expect(checkpointBumpGateViolations(manifest(NEW, edges), [OLD, HOP, NEW])).toEqual([])
  })

  it("does not treat an edge that leads somewhere else as a path", () => {
    const violations = checkpointBumpGateViolations(manifest(NEW, [{ from: OLD, to: OTHER }]), [OLD, NEW])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain(`shipped checkpoint identity '${OLD}'`)
  })

  it("terminates on a cyclic graph instead of hanging", () => {
    const edges = [
      { from: OLD, to: HOP },
      { from: HOP, to: OLD },
    ]
    const violations = checkpointBumpGateViolations(manifest(NEW, edges), [OLD, NEW])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain("no migration path")
  })

  it("names every unreachable predecessor rather than only the first", () => {
    const violations = checkpointBumpGateViolations(manifest(NEW, []), [OLD, HOP, NEW])
    expect(violations).toHaveLength(2)
    expect(violations.join("\n")).toContain(OLD)
    expect(violations.join("\n")).toContain(HOP)
  })

  it("holds a well-formed shipped ledger, checked against the ledger itself", () => {
    // The fixtures above prove the RULES; this proves they are applied to real
    // data. Without it every assertion here could pass while the constant that
    // actually ships is malformed — and a malformed ledger makes the gate in
    // host.test.ts throw rather than report, which reads as an unrelated break.
    expect(SHIPPED_CHECKPOINT_IDENTITIES.length).toBeGreaterThan(1)
    expect(new Set(SHIPPED_CHECKPOINT_IDENTITIES).size).toBe(SHIPPED_CHECKPOINT_IDENTITIES.length)
    for (const identity of SHIPPED_CHECKPOINT_IDENTITIES) expect(identity).toMatch(/^[0-9a-f]{64}$/u)
    // The ledger's last entry is the current identity, so a manifest naming it
    // with every earlier entry reachable is by definition clean. Real edges are
    // asserted against the real composition in host.test.ts.
    const current = SHIPPED_CHECKPOINT_IDENTITIES.at(-1) as string
    const edges = SHIPPED_CHECKPOINT_IDENTITIES.slice(0, -1).map((from) => ({ from, to: current }))
    expect(checkpointBumpGateViolations(manifest(current, edges), SHIPPED_CHECKPOINT_IDENTITIES)).toEqual([])
  })

  it("refuses a malformed ledger loudly rather than passing vacuously", () => {
    // An empty or malformed ledger must never read as "nothing to check".
    expect(() => checkpointBumpGateViolations(manifest(NEW, []), [])).toThrow(/at least one/u)
    expect(() => checkpointBumpGateViolations(manifest(NEW, []), ["not-a-sha256"])).toThrow(/not a SHA-256/u)
    expect(() => checkpointBumpGateViolations(manifest(NEW, []), [OLD, OLD, NEW])).toThrow(/appears twice/u)
  })
})
