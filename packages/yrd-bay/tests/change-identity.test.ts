/**
 * @failure A derived submission's synthetic change identity drifts between
 * re-derivations of the same push (identity churn breaks branch+Change-Id as
 * THE identity), collides with the command-minted namespace, or is minted
 * from non-canonical facts a later canonical read would not reproduce.
 * @level l2
 * @consumer @yrd/bay
 */
import { describe, expect, it } from "vitest"
import { ChangeIdSchema, changeIdForCommand, changeIdForDerivedSubmit } from "../src/change-identity.ts"

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
