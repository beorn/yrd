/**
 * @failure A derived submission's synthetic change identity drifts between
 * re-derivations of the same push (identity churn breaks branch+Change-Id as
 * THE identity), collides with the command-minted namespace, or is minted
 * from non-canonical facts a later canonical read would not reproduce.
 * @level l2
 * @consumer @yrd/bay
 */
import { describe, expect, it } from "vitest"
import {
  ChangeIdSchema,
  changeIdForCommand,
  changeIdForDerivedSubmit,
  resolveChangeIdentity,
} from "../src/change-identity.ts"

const SHA = "7".repeat(40)
const SHA256 = "7".repeat(64)

describe("changeIdForDerivedSubmit — the synthetic derived-submit identity mint", () => {
  it("is a well-formed ChangeId and a pure function of (branch, sha): same facts, same identity, every derivation", () => {
    const first = changeIdForDerivedSubmit({ branch: "task/agent-branch", sha: SHA })
    const second = changeIdForDerivedSubmit({ branch: "task/agent-branch", sha: SHA })
    expect(ChangeIdSchema.safeParse(first).success).toBe(true)
    expect(second).toBe(first)
  })

  it("distinct facts mint distinct identities — branch and sha each key the hash", () => {
    const base = changeIdForDerivedSubmit({ branch: "task/a", sha: SHA })
    expect(changeIdForDerivedSubmit({ branch: "task/b", sha: SHA })).not.toBe(base)
    expect(changeIdForDerivedSubmit({ branch: "task/a", sha: "8".repeat(40) })).not.toBe(base)
  })

  it("canonicalizes its facts: sha case never forks the identity, and a sha256 object name mints", () => {
    const lower = changeIdForDerivedSubmit({ branch: "task/a", sha: SHA })
    expect(changeIdForDerivedSubmit({ branch: "task/a", sha: SHA.toUpperCase() })).toBe(lower)
    expect(ChangeIdSchema.safeParse(changeIdForDerivedSubmit({ branch: "task/a", sha: SHA256 })).success).toBe(true)
  })

  it("refuses to mint from non-canonical facts — a drifting identity is worse than none", () => {
    expect(() => changeIdForDerivedSubmit({ branch: "task/a", sha: "deadbeef" })).toThrow()
    expect(() => changeIdForDerivedSubmit({ branch: "task/a", sha: "not-a-sha" })).toThrow()
    expect(() => changeIdForDerivedSubmit({ branch: "", sha: SHA })).toThrow()
  })

  it("lives in a namespace disjoint from the command mint's — the two can never issue one identity", () => {
    // Domain-separated hash inputs: even a deliberately colliding preimage
    // (a branch spelled like a canonical command id) cannot cross namespaces.
    const commandId = "01890000-0000-7000-8000-000000000000"
    const command = changeIdForCommand(commandId)
    const derived = changeIdForDerivedSubmit({ branch: commandId, sha: SHA })
    expect(derived).not.toBe(command)
  })
})

/**
 * @failure The identity ladder ranks its evidence wrongly — a branch's settled
 * identity changes over its life (a force-push or rebase re-keys it), two
 * branches settle on one identity, or an anchored identity silently disagrees
 * with the Change-Id trailer the tip actually carries.
 * @level l2
 * @consumer @yrd/queue deriveRunMemberArgs
 */
describe("resolveChangeIdentity — the one ranked identity ladder", () => {
  const TRAILER = `I${"a".repeat(40)}`
  const ANCHOR = `I${"b".repeat(40)}`
  const RECORD = `I${"c".repeat(40)}`
  const BRANCH = "issue/ladder"

  it("ranks record > snapshot > trailer > synthetic", () => {
    const all = { record: RECORD, snapshot: ANCHOR, trailer: TRAILER, branch: BRANCH, sha: SHA }
    expect(resolveChangeIdentity(all)).toMatchObject({ changeId: RECORD, provenance: "record" })
    expect(resolveChangeIdentity({ ...all, record: undefined })).toMatchObject({
      changeId: ANCHOR,
      provenance: "snapshot",
    })
    expect(resolveChangeIdentity({ ...all, record: undefined, snapshot: undefined })).toMatchObject({
      changeId: TRAILER,
      provenance: "trailer",
    })
    expect(resolveChangeIdentity({ branch: BRANCH, sha: SHA })).toMatchObject({
      changeId: changeIdForDerivedSubmit({ branch: BRANCH, sha: SHA }),
      provenance: "synthetic",
    })
  })

  /**
   * The property the whole ladder exists for. The sha is a BIRTH SEED, not a
   * key: once anything has anchored the branch, no rewrite of its commits can
   * move its identity — which is exactly what a force-push and a rebase are.
   */
  it("is stable across a force-push and a rebase: once anchored, no sha re-keys it", () => {
    const anchored = { snapshot: ANCHOR, branch: BRANCH }
    for (const sha of [SHA, "0".repeat(40), "f".repeat(40), "9".repeat(40)]) {
      expect(resolveChangeIdentity({ ...anchored, sha })).toMatchObject({ changeId: ANCHOR })
    }
  })

  it("is a pure derivation: the same evidence always settles the same id", () => {
    const evidence = { branch: BRANCH, sha: SHA }
    expect(resolveChangeIdentity(evidence)).toEqual(resolveChangeIdentity(evidence))
  })

  it("never settles two distinct branches on one synthetic identity", () => {
    const seen = new Set<string>()
    for (const branch of ["issue/a", "issue/b", "task/a", "task/a-", "issue/a/b"]) {
      const settled = resolveChangeIdentity({ branch, sha: SHA })
      if (!settled.ok) throw new Error(`canonical branch '${branch}' failed to settle`)
      expect(seen.has(settled.changeId)).toBe(false)
      seen.add(settled.changeId)
    }
    expect(seen.size).toBe(5)
  })

  /**
   * The silent identity split, made visible. An author who follows the
   * receiver's own printed cure — amend to stamp a trailer, re-push — lands
   * here: the anchor still wins (correctly; a mid-flight identity change would
   * orphan every fact keyed on it), and the commit and the queue now disagree
   * forever. Nothing reported that before this field existed.
   */
  it("reports an anchored identity that disagrees with the tip's own trailer", () => {
    expect(resolveChangeIdentity({ snapshot: ANCHOR, trailer: TRAILER, branch: BRANCH, sha: SHA })).toEqual({
      ok: true,
      changeId: ANCHOR,
      provenance: "snapshot",
      supersededTrailer: TRAILER,
    })
    // Agreement is not a split, and must not be reported as one.
    expect(resolveChangeIdentity({ snapshot: ANCHOR, trailer: ANCHOR, branch: BRANCH, sha: SHA })).not.toHaveProperty(
      "supersededTrailer",
    )
  })

  it("refuses to mint from non-canonical facts rather than anchoring a drifting id", () => {
    for (const facts of [
      { branch: "", sha: SHA },
      { branch: "   ", sha: SHA },
      { branch: BRANCH, sha: "nothex" },
      { branch: BRANCH, sha: SHA.slice(1) },
    ]) {
      expect(resolveChangeIdentity(facts)).toEqual({ ok: false, reason: "non-canonical-submit-facts" })
    }
    // An anchored identity needs no mint, so non-canonical facts cannot refuse it.
    expect(resolveChangeIdentity({ snapshot: ANCHOR, branch: "", sha: "nothex" })).toMatchObject({
      ok: true,
      changeId: ANCHOR,
    })
  })

  /**
   * A guard-shape fact worth pinning, because it is the reason this refusal
   * effectively stopped firing: `GitRefSchema` is `z.string().trim().min(1)`,
   * so ANY non-empty branch string is "canonical" here — a space-bearing name
   * git itself would reject still mints. The refusal's live reach is therefore
   * an empty branch or a non-hex sha, neither of which a real push produces.
   * Widening the ref shape is a separate change with its own blast radius; the
   * test exists so the next reader does not mistake this arm for a real gate.
   */
  it("treats any non-empty branch string as canonical — the refusal's reach is narrow", () => {
    expect(resolveChangeIdentity({ branch: "not a valid git ref", sha: SHA })).toMatchObject({
      ok: true,
      provenance: "synthetic",
    })
    // Trimming is canonicalization, so padded spellings settle identically.
    const padded = resolveChangeIdentity({ branch: `  ${BRANCH}  `, sha: SHA })
    const bare = resolveChangeIdentity({ branch: BRANCH, sha: SHA })
    if (!padded.ok || !bare.ok) throw new Error("canonical facts failed to settle")
    expect(padded.changeId).toBe(bare.changeId)
  })

  it("rejects a malformed trailer rather than settling on it", () => {
    expect(() => resolveChangeIdentity({ trailer: "I-not-hex", branch: BRANCH, sha: SHA })).toThrow()
  })
})
